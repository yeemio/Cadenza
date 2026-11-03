// @vitest-environment jsdom
/**
 * masterdata/inventory client 端点 live 形状测试（stub fetch，不依赖真实网络）：
 * 与 apps/api 实际路由逐一对齐——
 * - GET /masterdata/materials（分页+codeLike）、GET /inventory/balances（includeClosed 布尔参数）；
 * - 命令端点：POST /masterdata/warehouses、POST /masterdata/equipment/:id/change-status、
 *   POST /inventory/issue 携带 x-operation-id 头与 body.reason（中文留痕不进头——浏览器
 *   fetch 头仅收 ISO-8859-1，2026-10-28 起全 client 统一并入请求体）；成功 {operationId,status,data}；
 * - GET /inventory/barcode/:value/resolve 与 GET /inventory/units?unitNo=… 查询形状；
 * - 409 ERR_INSUFFICIENT_STOCK（IT-30 余量竞争）→ ApiError 映射 + [IT-30] 规则文案。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient, ApiError, formatErrorTitleAndDetail } from '@cadenza/ui'

interface Recorded {
  url: URL
  method: string
  headers: Record<string, string>
  body: unknown
}

function stubFetch(responses: Array<{ status: number; body: unknown }>): Recorded[] {
  const recorded: Recorded[] = []
  let index = 0
  const impl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input : new URL(String(input))
    recorded.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body !== undefined ? (JSON.parse(String(init.body)) as unknown) : undefined,
    })
    const next = responses[index]
    index += 1
    if (!next) throw new Error(`未预期的第 ${index} 次请求：${url.pathname}`)
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json', 'x-request-id': `req-${index}` },
    })
  }
  vi.stubGlobal('fetch', vi.fn(impl))
  return recorded
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const BASE = 'http://127.0.0.1:3001'
const TOKEN = 'shape-token'

function liveClient() {
  return createApiClient({ mode: 'live', baseURL: BASE, getToken: () => TOKEN })
}

describe('masterdata/inventory client 形状（live 模式）', () => {
  it('料品与余额分页查询：路径/分页参数/过滤参数/Bearer 头对齐控制器', async () => {
    const materialsPage = { items: [], total: 0, page: 1, pageSize: 10 }
    const balancesPage = { items: [], total: 0, page: 1, pageSize: 10 }
    const recorded = stubFetch([
      { status: 200, body: materialsPage },
      { status: 200, body: balancesPage },
    ])
    const client = liveClient()
    await client.listMaterials({ page: 1, pageSize: 10, codeLike: 'CU-' })
    await client.listBalances({ page: 1, pageSize: 10, includeClosed: true, unitNoLike: 'U-2026' })
    expect(recorded[0]?.url.pathname).toBe('/masterdata/materials')
    expect(recorded[0]?.url.searchParams.get('codeLike')).toBe('CU-')
    expect(recorded[0]?.url.searchParams.get('page')).toBe('1')
    expect(recorded[0]?.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    expect(recorded[1]?.url.pathname).toBe('/inventory/balances')
    expect(recorded[1]?.url.searchParams.get('includeClosed')).toBe('true')
    expect(recorded[1]?.url.searchParams.get('unitNoLike')).toBe('U-2026')
  })

  it('仓库创建与设备状态变更命令：x-operation-id 头 + 载荷字段（reason 并入 body，不发 x-reason 头）+ {operationId,status,data}', async () => {
    const recorded = stubFetch([
      { status: 201, body: { operationId: 'op-1', status: 'COMMITTED', data: { warehouseId: 'wh-9' } } },
      { status: 200, body: { operationId: 'op-2', status: 'COMMITTED', data: { equipmentId: 'eq-1', journaled: true } } },
    ])
    const client = liveClient()
    const r1 = await client.createWarehouse(
      { code: '0104', name: '新建演示库', deptId: 'n-log', warehouseType: 'WAREHOUSE', materialTypes: [1, 3] },
      { reason: '测试建仓' },
    )
    expect(r1.status).toBe('COMMITTED')
    expect((r1.data as { warehouseId: string }).warehouseId).toBe('wh-9')
    expect(recorded[0]?.method).toBe('POST')
    expect(recorded[0]?.url.pathname).toBe('/masterdata/warehouses')
    expect(recorded[0]?.headers['x-operation-id']).toBeTruthy()
    // reason 统一并入 body（控制器 run() 优先读 payload.reason）；不再发 x-reason 头
    expect(recorded[0]?.headers['x-reason']).toBeUndefined()
    expect(recorded[0]?.body).toEqual({
      code: '0104',
      name: '新建演示库',
      deptId: 'n-log',
      warehouseType: 'WAREHOUSE',
      materialTypes: [1, 3],
      reason: '测试建仓',
    })
    await client.changeEquipmentStatus('eq-1', { equipmentStatus: 2, source: 'WEB' }, { reason: '停机维修' })
    expect(recorded[1]?.method).toBe('POST')
    expect(recorded[1]?.url.pathname).toBe('/masterdata/equipment/eq-1/change-status')
    expect(recorded[1]?.body).toEqual({ equipmentStatus: 2, source: 'WEB', reason: '停机维修' })
  })

  it('条码解析与单元详情：路径参数编码与 unitNo 查询', async () => {
    const resolveView = {
      barcodeValue: 'BC-CR-01',
      kind: { kind: 'carrier_label', confidence: 'exact', matchedPattern: null },
      hasActiveBinding: true,
      boundType: 'carrier',
      boundId: 'cr-01',
      candidates: [
        { objectType: 'inventory_unit', objectId: 'u-1', label: '库存单元 A', via: 'carrier_load' },
        { objectType: 'inventory_unit', objectId: 'u-2', label: '库存单元 B', via: 'carrier_load' },
      ],
    }
    const detailView = {
      unitId: 'u-1',
      unitNo: 'U-1',
      materialCode: 'CU',
      lotNo: 'L1',
      traceMode: 'quantity',
      status: 'in_stock',
      balanceOpen: true,
      balances: [],
      activeReservations: [],
      recentTransactions: [],
      genealogy: [],
    }
    const recorded = stubFetch([
      { status: 200, body: resolveView },
      { status: 200, body: detailView },
    ])
    const client = liveClient()
    const resolved = await client.resolveBarcode('BC-CR-01')
    expect(resolved.candidates.length).toBe(2)
    expect(recorded[0]?.url.pathname).toBe('/inventory/barcode/BC-CR-01/resolve')
    const detail = await client.unitDetail({ unitNo: 'U-2026-1001-0001' })
    expect(detail.unitNo).toBe('U-1')
    expect(recorded[1]?.url.pathname).toBe('/inventory/units')
    expect(recorded[1]?.url.searchParams.get('unitNo')).toBe('U-2026-1001-0001')
  })

  it('发料命令 409 ERR_INSUFFICIENT_STOCK（IT-30 余量竞争拒绝）→ ApiError + 规则文案主指引', async () => {
    const recorded = stubFetch([
      {
        status: 409,
        body: {
          code: 'ERR_INSUFFICIENT_STOCK',
          message: '[IT-30] 并发余量不足导致负库存（扣前 1.0000、本次 2.0000），拒绝',
          details: { operationId: 'op-x' },
        },
      },
    ])
    const client = liveClient()
    const err = await client
      .inventoryIssue({ unitId: 'u-1', quantity: '2.0000' }, { reason: '生产发料' })
      .then(() => null)
      .catch((e: unknown) => (e instanceof ApiError ? e : null))
    expect(recorded[0]?.url.pathname).toBe('/inventory/issue')
    expect((recorded[0]?.body as Record<string, unknown>)['reason']).toBe('生产发料')
    expect(recorded[0]?.headers['x-reason']).toBeUndefined()
    expect(err).not.toBeNull()
    expect(err?.code).toBe('ERR_INSUFFICIENT_STOCK')
    expect(err?.httpStatus).toBe(409)
    const { title, detail } = formatErrorTitleAndDetail({ code: err?.code, message: err?.message })
    expect(title).toContain('负库存')
    expect(detail).toContain('扣前 1.0000')
  })
})
