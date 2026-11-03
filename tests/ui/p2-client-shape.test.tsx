// @vitest-environment jsdom
/**
 * P2 六域 client 端点形状测试（stub fetch，不依赖真实网络；先例 domain4-client-shape）：
 * - conversion / reverse / reporting：与已落地控制器路由逐一对齐
 *   （apps/api/src/{conversion,reverse,reporting}/*.controller.ts，P2-B/C/F 线交付件）；
 * - rework / disposition / maintenance：按冻结合同形状先行定义（后端未落地，
 *   L0 整合对账清单见 delivery/P2/ui/DELIVERY.md）；
 * - UI 便捷布尔（FC-06/08/09/15、WR-08/17 门条件）由 client 映射层统一计算，
 *   mock 与 live 同路（页面不重复实现门条件）；
 * - mock 分发：未定义路由 → ERR_NOT_FOUND；命令端点 {operationId,status,data}。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createP2ApiClient,
  mockP2Routes,
  resetMockP2State,
  type P2ApiClient,
} from '../../packages/ui/src/api/p2'

interface Recorded {
  url: URL
  method: string
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
  resetMockP2State()
})

const BASE = 'http://127.0.0.1:3001'

function liveClient(): P2ApiClient {
  return createP2ApiClient({ mode: 'live', baseURL: BASE, getToken: () => 'shape-token-p2' })
}

function mockClient(): P2ApiClient {
  return createP2ApiClient({ mode: 'mock', mockLatencyMs: 0 })
}

describe('T16 conversion：与落地控制器路由对齐（P2-B 线）', () => {
  it('GET /conversion/orders：statuses 逗号拼接；响应映射 FC-06/09 便捷布尔', async () => {
    const recorded = stubFetch([
      {
        status: 200,
        body: {
          items: [
            { conversionId: 'cv-1', conversionNo: 'CV-1', status: 'pending', syncStatus: 'pending', lineCount: 2, plantId: 'p', createdAt: '2026-10-28T00:00:00.000Z' },
            { conversionId: 'cv-2', conversionNo: 'CV-2', status: 'completed', syncStatus: 'sync_failed', lineCount: 1, plantId: 'p', createdAt: '2026-10-28T00:00:00.000Z' },
          ],
          total: 2,
          page: 1,
          pageSize: 10,
        },
      },
    ])
    const client = liveClient()
    const result = await client.listOrderConversions({ page: 1, pageSize: 10, statuses: ['pending', 'completed'] })
    expect(recorded[0]!.url.pathname).toBe('/conversion/orders')
    expect(recorded[0]!.url.searchParams.get('statuses')).toBe('pending,completed')
    expect(recorded[0]!.method).toBe('GET')
    // FC-06/09：列表级布尔（editable=待转换近似；retryable=已完成且同步失败）
    expect(result.items[0]!.editable).toBe(true)
    expect(result.items[0]!.retryable).toBe(false)
    expect(result.items[1]!.retryable).toBe(true)
    expect(result.items[1]!.editable).toBe(false)
  })

  it('POST /conversion/order/scan：载荷原样（conversionId/lineId/code）；命令面 2xx 响应直取', async () => {
    const recorded = stubFetch([{ status: 201, body: { operationId: 'op-1', status: 'COMMITTED', data: { scanId: 's-1' } } }])
    const client = liveClient()
    const scan = await client.orderConversionScan({ conversionId: 'cv-1', lineId: 'cvl-1', code: 'U-1' })
    expect(recorded[0]!.url.pathname).toBe('/conversion/order/scan')
    expect(recorded[0]!.method).toBe('POST')
    expect(recorded[0]!.body).toEqual({ conversionId: 'cv-1', lineId: 'cvl-1', code: 'U-1' })
    expect(scan.scanId).toBe('s-1')
  })

  it('详情级 FC-06/08：有扫码（含删码留痕）→ editable=false；每明细已扫>0 → completable=true', async () => {
    stubFetch([
      {
        status: 200,
        body: {
          conversionId: 'cv-1',
          conversionNo: 'CV-1',
          status: 'pending',
          syncStatus: 'pending',
          lineCount: 1,
          plantId: 'p',
          createdAt: '2026-10-28T00:00:00.000Z',
          lines: [{ lineId: 'l1', lineNo: 1, scannedAxes: 1 }],
          scans: [{ scanId: 's1', deleted: true }],
        },
      },
    ])
    const client = liveClient()
    const detail = await client.getOrderConversion('cv-1')
    expect(detail.editable).toBe(false) // 删码留痕仍阻断编辑（FC-06）
    expect(detail.completable).toBe(true) // 每明细已扫轴数>0（FC-08）
  })

  it('FC-15：reconvertable=转换失败且 U9 未成功；resyncable=同步失败且 U9 已成功', async () => {
    stubFetch([
      {
        status: 200,
        body: {
          items: [
            { conversionId: 's1', conversionNo: 'CVS-1', displayStatus: 'convert_failed', internalStatus: 'pending_execute', externalPushStatus: 'failed', localApplyStatus: 'not_applied', u9Success: false, materialId: 'm', materialCode: 'C', targetSalesOrderNo: 'SO', targetLineNo: '10', targetBatchNo: 'B', totalQty: '1.0000', axisCount: 1, plantId: 'p', createdAt: '2026-10-28T00:00:00.000Z' },
            { conversionId: 's2', conversionNo: 'CVS-2', displayStatus: 'sync_failed', internalStatus: 'pending_recovery', externalPushStatus: 'succeeded', localApplyStatus: 'failed', u9Success: true, materialId: 'm', materialCode: 'C', targetSalesOrderNo: 'SO', targetLineNo: '10', targetBatchNo: 'B', totalQty: '1.0000', axisCount: 1, plantId: 'p', createdAt: '2026-10-28T00:00:00.000Z' },
          ],
          total: 2,
          page: 1,
          pageSize: 10,
        },
      },
    ])
    const client = liveClient()
    const result = await client.listStockConversions({ page: 1, pageSize: 10 })
    expect(result.items[0]!.reconvertable).toBe(true)
    expect(result.items[0]!.resyncable).toBe(false)
    expect(result.items[1]!.resyncable).toBe(true)
    expect(result.items[1]!.reconvertable).toBe(false)
  })
})

describe('T17 reverse：与落地控制器路由对齐（P2-C 线）', () => {
  it('GET /reverse/transfer-outbound → WR-08 editable=待出库且未扫过码', async () => {
    stubFetch([
      {
        status: 200,
        body: {
          items: [
            { orderId: 't1', orderNo: 'TO-1', sourceKind: 'web_task', transferKind: 'warehouse', fromWarehouseId: 'w1', toWarehouseId: 'w2', status: 'pending_out', scannedCount: 0, totalOutQty: '1.0000', plantId: 'p', createdAt: '2026-10-28T00:00:00.000Z' },
            { orderId: 't2', orderNo: 'TO-2', sourceKind: 'web_task', transferKind: 'warehouse', fromWarehouseId: 'w1', toWarehouseId: 'w2', status: 'pending_out', scannedCount: 2, totalOutQty: '2.0000', plantId: 'p', createdAt: '2026-10-28T00:00:00.000Z' },
          ],
          total: 2,
          page: 1,
          pageSize: 10,
        },
      },
    ])
    const client = liveClient()
    const result = await client.listTransferOutbound({ page: 1, pageSize: 10 })
    expect(result.items[0]!.editable).toBe(true)
    expect(result.items[1]!.editable).toBe(false)
  })

  it('WR-17 completable：每料品已入库≥待入库且至少一码已入库', async () => {
    stubFetch([
      {
        status: 200,
        body: {
          items: [
            {
              orderId: 'i1', orderNo: 'TI-1', inboundMode: 'scan_putaway', status: 'inbounding', toWarehouseId: 'w2', plantId: 'p',
              inboundLines: [
                { unitNo: 'u1', materialCode: 'M', quantity: '1.0000', lineStatus: 'inbound', locationCode: 'L1' },
                { unitNo: 'u2', materialCode: 'M', quantity: '1.0000', lineStatus: 'inbound', locationCode: 'L2' },
              ],
            },
            {
              orderId: 'i2', orderNo: 'TI-2', inboundMode: 'scan_putaway', status: 'inbounding', toWarehouseId: 'w2', plantId: 'p',
              inboundLines: [
                { unitNo: 'u3', materialCode: 'M', quantity: '1.0000', lineStatus: 'inbound', locationCode: 'L1' },
                { unitNo: 'u4', materialCode: 'M', quantity: '1.0000', lineStatus: 'pending', locationCode: null },
              ],
            },
          ],
          total: 2,
          page: 1,
          pageSize: 10,
        },
      },
    ])
    const client = liveClient()
    const result = await client.listTransferInbound({ page: 1, pageSize: 10 })
    expect(result.items[0]!.completable).toBe(true)
    expect(result.items[0]!.inboundCount).toBe(2)
    expect(result.items[1]!.completable).toBe(false)
  })

  it('POST /reverse/move/submit：载荷含 stagedUnitNos（WR-01 暂存提交）', async () => {
    const recorded = stubFetch([{ status: 201, body: { operationId: 'op-2', status: 'COMMITTED', data: null } }])
    const client = liveClient()
    await client.submitMove({ plantId: 'p', warehouseId: 'w1', toLocationId: 'L1', stagedUnitNos: ['U-1', 'U-2'] })
    expect(recorded[0]!.url.pathname).toBe('/reverse/move/submit')
    expect(recorded[0]!.body).toEqual({ plantId: 'p', warehouseId: 'w1', toLocationId: 'L1', stagedUnitNos: ['U-1', 'U-2'] })
  })
})

describe('T20 reporting：与落地控制器路由对齐（P2-F 线）', () => {
  it('POST /reporting/stock-stats/summary：勾选 id 集合走 body（RP-05）', async () => {
    const recorded = stubFetch([{ status: 200, body: { groups: [{ uomCode: 'KG', uomLabel: 'KG', totalQuantity: '3.0000' }], totalRows: 2 } }])
    const client = liveClient()
    const summary = await client.stockStatSelectionSummary(['ss-1', 'ss-2'])
    expect(recorded[0]!.url.pathname).toBe('/reporting/stock-stats/summary')
    expect(recorded[0]!.body).toEqual({ ids: ['ss-1', 'ss-2'] })
    expect(summary.totalRows).toBe(2)
  })

  it('GET /reporting/axis-query：reportStatus/not_applicable 由服务端拒绝 → ApiError 422', async () => {
    stubFetch([{ status: 422, body: { code: 'ERR_BUSINESS_RULE', message: '[RP-09] 报工状态筛选不含采购来源轴（`-` 不可作为筛选值）', details: {} } }])
    const client = liveClient()
    await expect(client.listAxisQuery({ page: 1, pageSize: 10, reportStatus: 'not_applicable' })).rejects.toMatchObject({
      code: 'ERR_BUSINESS_RULE',
      httpStatus: 422,
    })
  })

  it('GET /reporting/trace/:unitNo?direction=backward：路径参数编码', async () => {
    const recorded = stubFetch([{ status: 200, body: { direction: 'backward', root: { nodeId: 'n', nodeType: 'inventory_unit', unitNo: 'U/1' }, nodes: [], edges: [] } }])
    const client = liveClient()
    await client.trace('U/1', 'backward')
    expect(recorded[0]!.url.pathname).toBe('/reporting/trace/U%2F1')
    expect(recorded[0]!.url.searchParams.get('direction')).toBe('backward')
  })
})

describe('T15/T18/T19：冻结合同形状先行路由（后端未落地，对账清单登记）', () => {
  it('mock 分发：rework 倒轴执行守恒式拒绝 [RS-01] 与损耗原因拒绝 [RS-11]', async () => {
    const client = mockClient()
    await expect(
      client.executeReelSplit({ sourceUnitNo: 'RS-OK-01', lines: [{ targetUnitNo: 'T-1', quantity: '900' }, { targetUnitNo: 'T-2', quantity: '200' }], lossQuantity: '10' }),
    ).resolves.toMatchObject({ status: 'completed' })
    await expect(
      client.executeReelSplit({ sourceUnitNo: 'RS-OK-01', lines: [{ targetUnitNo: 'T-1', quantity: '1100' }] }),
    ).rejects.toMatchObject({ code: 'ERR_BUSINESS_RULE', message: expect.stringContaining('[RS-01]') })
    await expect(
      client.executeReelSplit({ sourceUnitNo: 'RS-OK-01', lines: [{ targetUnitNo: 'T-1', quantity: '10' }], lossQuantity: '5' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('[RS-11]') })
  })

  it('mock 分发：disposition 成品异常审核通过无去向 [QD-08]；免检码结论 [QD-12]', async () => {
    const client = mockClient()
    await expect(client.reviewFinishedDefect('fd-1', { approved: true })).rejects.toMatchObject({
      message: expect.stringContaining('[QD-08]'),
    })
    await expect(
      client.iqcCodeConclusion({ batchNo: 'LOT-20261027-05', code: 'QD-IQC-04', conclusion: 'qualified', scope: 'first' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('[QD-12]') })
  })

  it('mock 分发：maintenance 状态同值不产生流水 [MT-03]；复机门 [MT-10]', async () => {
    const client = mockClient()
    await expect(client.changeEquipmentStatus({ equipmentId: 'eq-extrude-01', status: 2 })).rejects.toMatchObject({
      message: expect.stringContaining('[MT-03]'),
    })
    await expect(client.recoverMaintenanceOrder('mo-2', { result: '修好', responsibleName: '维修甲' })).rejects.toMatchObject({
      message: expect.stringContaining('[MT-10]'),
    })
  })

  it('mock 分发：未定义路由 → mockP2Routes 返回 null（client 显式 ERR_NOT_FOUND）', async () => {
    expect(mockP2Routes('GET', '/rework/unknown-path')).toBeNull()
    expect(mockP2Routes('POST', '/conversion/order/unknown', {})).toBeNull()
    const client = mockClient()
    await expect(client.getReelSplit('not-exist-id')).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' })
  })
})
