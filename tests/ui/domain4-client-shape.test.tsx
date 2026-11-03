// @vitest-environment jsdom
/**
 * 四域 client 端点 live 形状测试（stub fetch，不依赖真实网络）：
 * 与 apps/api 四域控制器路由逐一对齐——
 * - GET /process/orders（statuses/suspended）、GET /scheduling/device-view（workCenterId）；
 * - POST /execution/workbench/reports（载荷原样；source 由服务端注入）；
 * - POST /scheduling/slots（confirm 载荷级弱提醒二次提交）；
 * - GET /quality/inspections（statuses/stages）、POST /warehousing/transfers/ship（行级）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '@cadenza/ui'

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
const TOKEN = 'shape-token-4d'

function liveClient() {
  return createApiClient({ mode: 'live', baseURL: BASE, getToken: () => TOKEN })
}

describe('四域 client 形状（live 模式，端点对齐控制器）', () => {
  it('生产订单与设备看板查询：statuses/suspended/workCenterId 参数 + Bearer', async () => {
    const recorded = stubFetch([
      { status: 200, body: { items: [], total: 0, page: 1, pageSize: 10 } },
      { status: 200, body: { plantId: 'p1', workCenterId: null, today: '2026-10-27', dates: [], workCenters: [], equipments: [] } },
    ])
    const client = liveClient()
    await client.listProductionOrders({ page: 1, pageSize: 10, statuses: 'in_progress,voided', suspended: true })
    await client.schedulingDeviceView({ workCenterId: 'wc-1' })
    expect(recorded[0]?.url.pathname).toBe('/process/orders')
    expect(recorded[0]?.url.searchParams.get('statuses')).toBe('in_progress,voided')
    expect(recorded[0]?.url.searchParams.get('suspended')).toBe('true')
    expect(recorded[0]?.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    expect(recorded[1]?.url.pathname).toBe('/scheduling/device-view')
    expect(recorded[1]?.url.searchParams.get('workCenterId')).toBe('wc-1')
  })

  it('槽位保存：confirm 载荷级二次提交（[A3-2w] 弱提醒语义）+ x-operation-id 头', async () => {
    const recorded = stubFetch([
      { status: 200, body: { operationId: 'op-1', status: 'COMMITTED', data: { warnings: ['超产能'] } } },
    ])
    const client = liveClient()
    const result = await client.saveScheduleSlot({
      orderOperationId: 'op-101',
      equipmentId: 'eq-0001',
      productionDate: '2026-10-27',
      plannedQty: '4.0000',
      confirm: true,
    })
    expect(result.status).toBe('COMMITTED')
    expect(recorded[0]?.method).toBe('POST')
    expect(recorded[0]?.url.pathname).toBe('/scheduling/slots')
    expect(recorded[0]?.headers['x-operation-id']).toBeTruthy()
    expect(recorded[0]?.body).toEqual({
      orderOperationId: 'op-101',
      equipmentId: 'eq-0001',
      productionDate: '2026-10-27',
      plannedQty: '4.0000',
      confirm: true,
    })
  })

  it('工作台报工与调拨出库：路径/载荷/命令头（source 由服务端注入，客户端不自带）', async () => {
    const recorded = stubFetch([
      { status: 200, body: { operationId: 'op-2', status: 'COMMITTED', data: { reportId: 'rp-9' } } },
      { status: 200, body: { operationId: 'op-3', status: 'COMMITTED', data: { outQty: '8.0000' } } },
    ])
    const client = liveClient()
    await client.reportViaWorkbench({
      orderId: 'po-001',
      orderOperationId: 'op-101',
      outputs: [{ quantity: '2.0000', uomId: 'uom-km', uomCode: 'KM', targetLocationId: 'loc-1', targetLocationCode: '02010001' }],
    })
    await client.shipTransfer({ transferOrderId: 'tf-001', lineId: 'tl-001' }, { reason: '出库段' })
    expect(recorded[0]?.url.pathname).toBe('/execution/workbench/reports')
    expect((recorded[0]?.body as Record<string, unknown>)['outputs']).toBeInstanceOf(Array)
    expect(recorded[0]?.body).not.toHaveProperty('source')
    expect(recorded[1]?.url.pathname).toBe('/warehousing/transfers/ship')
    // reason 统一并入 body（控制器 run() 优先读 payload.reason）；不再发 x-reason 头
    expect(recorded[1]?.headers['x-reason']).toBeUndefined()
    expect(recorded[1]?.body).toEqual({ transferOrderId: 'tf-001', lineId: 'tl-001', reason: '出库段' })
  })

  it('检验任务查询与调拨详情：statuses/stages 过滤 + :id 路径', async () => {
    const recorded = stubFetch([
      { status: 200, body: { items: [], total: 0, page: 1, pageSize: 10 } },
      { status: 200, body: { id: 'tf-1', lines: [] } },
    ])
    const client = liveClient()
    await client.listInspections({ page: 1, pageSize: 10, statuses: 'pending', stages: 'process,finished' })
    await client.transferDetail('tf-1')
    expect(recorded[0]?.url.pathname).toBe('/quality/inspections')
    expect(recorded[0]?.url.searchParams.get('stages')).toBe('process,finished')
    expect(recorded[1]?.url.pathname).toBe('/warehousing/transfers/tf-1')
  })
})
