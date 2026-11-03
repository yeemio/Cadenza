// @vitest-environment jsdom
/**
 * P3 域 client live 形状测试（stub fetch，不依赖真实网络）+ mock 规则行为测试：
 * - live：GET 查询参数拼装与 Bearer 头；POST 命令 x-operation-id 头与 body 形状
 *   （reason 统一走 body，与真实控制器 payload.reason||header 读取一致；中文留痕不进
 *   头——浏览器 fetch 头仅收 ISO-8859-1，2026-10-28 起不再发 x-reason 头）；
 * - mock：服务端口径拒绝——[OT-25] 设备收敛、[OT-26] 重复确认、[PE-04] 发布守卫、
 *   [CS-19] 状态机、[CE-11] 重算理由必填；错误体 → ApiError（规则码映射 formatP3Error）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createP3Client, formatP3Error } from '../../packages/ui/src/api/p3'
import { ApiError } from '@cadenza/ui'

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

describe('live 形状（stub fetch）', () => {
  it('GET /ot/samples：deviceSerial 必填参数、布尔参数小写字符串、Bearer 头', async () => {
    const recorded = stubFetch([{ status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } }])
    const client = createP3Client({ mode: 'live', getToken: () => 'tok-p3' })
    await client.otListSamples({ deviceSerial: 'SN-DRAW-001', isBad: true, isClockSkew: false, page: 1, pageSize: 20 })
    const req = recorded[0]!
    expect(req.url.pathname).toBe('/ot/samples')
    expect(req.url.searchParams.get('deviceSerial')).toBe('SN-DRAW-001')
    expect(req.url.searchParams.get('isBad')).toBe('true')
    expect(req.url.searchParams.get('isClockSkew')).toBe('false')
    expect(req.url.searchParams.has('isLate')).toBe(false)
    expect(req.headers['Authorization']).toBe('Bearer tok-p3')
  })

  it('POST /spc/sample/record：body 含测量值与 reason，头含 x-operation-id（reason 不再走头）', async () => {
    const recorded = stubFetch([{ status: 200, body: { operationId: 'op-1', status: 'COMMITTED', data: null } }])
    const client = createP3Client({ mode: 'live', getToken: () => 'tok-p3' })
    await client.spcSampleRecord({
      plantId: 'n-plant', controlItemId: 'ci-001', source: 'manual_inspection',
      measuredValue: '0.5271', gaugeId: 'g-001', reason: '页面样本登记',
    })
    const req = recorded[0]!
    expect(req.method).toBe('POST')
    expect(req.url.pathname).toBe('/spc/sample/record')
    expect(req.body).toMatchObject({ controlItemId: 'ci-001', measuredValue: '0.5271', reason: '页面样本登记' })
    expect(typeof req.headers['x-operation-id']).toBe('string')
    // reason 统一并入 body；不再发 x-reason 头（浏览器 fetch 头仅收 ISO-8859-1）
    expect(req.headers['x-reason']).toBeUndefined()
  })

  it('POST /csw/outsourcing/receive：lines 单元行载荷形状（CS-21）', async () => {
    const recorded = stubFetch([{ status: 200, body: { operationId: 'op-2', status: 'COMMITTED', data: null } }])
    const client = createP3Client({ mode: 'live', getToken: () => 'tok-p3' })
    await client.cswOutsourcingReceive({
      taskId: 'owt-003',
      lines: [{ unitId: 'unit-1005-0001', quantity: '48.0000', returnLotNo: 'LOT-0540' }],
      reason: 'PDA 回厂接收',
    })
    const req = recorded[0]!
    expect(req.url.pathname).toBe('/csw/outsourcing/receive')
    expect(req.body).toMatchObject({
      taskId: 'owt-003',
      lines: [{ unitId: 'unit-1005-0001', quantity: '48.0000', returnLotNo: 'LOT-0540' }],
    })
  })

  it('GET /cost/runs 与 /spc/control-items/:id/chart 路径编码；401 触发 onUnauthorized', async () => {
    const client = createP3Client({ mode: 'live', getToken: () => 'tok-p3' })
    const recorded = stubFetch([
      { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } },
      { status: 200, body: { controlItem: {}, ruleSet: null, limitVersions: [], samples: [] } },
    ])
    await client.costListRuns({ orderId: 'po-1027-001', shiftDate: '2026-10-27' })
    await client.spcControlChart('ci 001')
    expect(recorded[0]!.url.pathname).toBe('/cost/runs')
    expect(recorded[0]!.url.searchParams.get('orderId')).toBe('po-1027-001')
    expect(recorded[0]!.url.searchParams.get('shiftDate')).toBe('2026-10-27')
    expect(recorded[1]!.url.pathname).toBe('/spc/control-items/ci%20001/chart')
    // 401 → onUnauthorized（除探测类）
    let fired = false
    const gated = createP3Client({ mode: 'live', getToken: () => 'tok-p3', onUnauthorized: () => (fired = true) })
    stubFetch([{ status: 401, body: { code: 'ERR_AUTH_REQUIRED', message: '请先登录', details: {} } }])
    const err = await gated.otListGateways().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(fired).toBe(true)
  })
})

describe('mock 服务端口径拒绝（规则码 → ApiError → 中文映射）', () => {
  it('[OT-25] 样本明细缺 deviceSerial → 422 + 规则码主文案', async () => {
    const client = createP3Client({ mode: 'mock', mockLatencyMs: 0 })
    const err = await client.otListSamples({ deviceSerial: '', page: 1, pageSize: 20 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toContain('[OT-25]')
    const formatted = formatP3Error(err as { code?: string; message?: string })
    expect(formatted.title).toContain('样本明细查询必须按设备收敛')
  })

  it('[OT-26] 重复确认已派发事实 → 422', async () => {
    const client = createP3Client({ mode: 'mock', mockLatencyMs: 0 })
    await client.otMappingConfirm({ plantId: 'n-plant', factId: 'fact-001' })
    const err = await client.otMappingConfirm({ plantId: 'n-plant', factId: 'fact-001' }).catch((e: unknown) => e)
    expect((err as ApiError).message).toContain('[OT-26]')
  })

  it('[PE-04] 在制未处置发布被拒；处置后发布成功（状态机闭环）', async () => {
    const client = createP3Client({ mode: 'mock', mockLatencyMs: 0 })
    const err = await client.spcChangePublish({ plantId: 'n-plant', changeId: 'chg-001' }).catch((e: unknown) => e)
    expect((err as ApiError).message).toContain('[PE-04]')
    await client.spcChangeDisposition({
      plantId: 'n-plant', changeId: 'chg-001', impactId: 'imp-002', disposition: 'continue_old',
    })
    const ok = await client.spcChangePublish({ plantId: 'n-plant', changeId: 'chg-001' })
    expect(ok.status).toBe('COMMITTED')
  })

  it('[CS-19] 已发送后取消走收回；草稿直接发送被拒', async () => {
    const client = createP3Client({ mode: 'mock', mockLatencyMs: 0 })
    const err = await client
      .cswOutsourcingSend({ taskId: 'owt-001', lines: [{ unitId: 'unit-x', quantity: '1' }] })
      .catch((e: unknown) => e)
    expect((err as ApiError).message).toContain('[CS-19]')
    await client.cswOutsourcingRecall({ taskId: 'owt-003', reason: '计划员收回' })
    const detail = await client.cswOutsourcingDetail('owt-003')
    expect(detail.task.status).toBe('recalled')
  })

  it('[CE-11] 显式重算理由必填；[PE-12] 失控未处置不得复控确认', async () => {
    const client = createP3Client({ mode: 'mock', mockLatencyMs: 0 })
    const errCost = await client
      .costAcquisitionRecalc({
        plantId: 'n-plant',
        orderId: 'po-1027-001',
        shiftDate: '2026-10-27',
        dataCutoffAt: '2026-10-28T20:00:00+08:00',
        allocationVersionId: 'av-001',
        priceVersionId: 'pv-001',
        reason: '',
      })
      .catch((e: unknown) => e)
    expect((errCost as ApiError).message).toContain('[CE-11]')
    const errOoc = await client.spcOocConfirmRecontrol({ plantId: 'n-plant', oocTaskId: 'ooc-001' }).catch((e: unknown) => e)
    expect((errOoc as ApiError).message).toContain('[PE-12]')
  })
})
