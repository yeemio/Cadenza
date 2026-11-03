/**
 * P4 问数 mock 路由（P4-UI 线新增；演示数据与真实 DTO 同形——先例：api/mock.ts 模式）。
 *
 * 承载合同行为（LP 红线：mock 适配器承载全部合同行为，不接真实模型）：
 * - 会话登记（A 线已实现端点形状：channel 值域校验 / 令牌必带）；
 * - 问数轮 DS-23 四态 outcome：answer（六段信封）/ clarify（结构化选项，AQ-AMB-01/02）/
 *   unavailable（unreachable/over_limit/starting 三类原因 + 超时部分数据）/ cancelled；
 * - 信封七状态样例（ok_with_data/ok_no_records/source_not_ready/not_supported…，AQ-REG-07）；
 * - AQ-C2 口径未定与单位不一致标注（GAP-P4）、truncated/totalKnown=false、freshness unknown；
 * - 健康探测（AR-11 降级判定源；测试可注入不可达态）。
 *
 * 场景脚本（按提问文本关键字路由，测试与演示共用）：
 * 「SC-2026-1024」→ 澄清（重名订单双候选）；「缺料/缺口」→ AQ-C2；
 * 「质量/检验/质检」→ AQ-C3（默认时间窗回显）；「超限」→ over_limit；「启动中」→ starting；
 * 「不可达」→ unreachable；「超时」→ timeout + 部分数据信封；「慢速」→ 900ms 延迟（取消测试）；
 * 「无权限」→ 403 [AQ-AUTH-02]；「未就绪」→ source_not_ready；「未注册」→ not_supported；
 * 「无匹配」→ ok_no_records；默认 → AQ-C1（ORDER-AQ-1001，数字与 P4-A 黄金订单同源）。
 */

import { MockError } from '../mock'
import type {
  AiAskTurnRequestDto,
  AiAskTurnResponseDto,
  AiClarifyOptionDto,
  AiQueryEnvelopeDto,
  AiQueryHealthResponseDto,
  AiSessionOpenRequestDto,
  AiSessionOpenResponseDto,
} from './types'

export interface MockAiQueryContext {
  token: string | null
  body?: unknown
}

type MockAiQueryHandler = (ctx: MockAiQueryContext) => unknown | Promise<unknown>

// ---------------------------------------------------------------------------
// 模块级 mock 状态（演示定位：刷新即重置；测试用 resetMockAiQueryState 清场——先例 resetMockLoginState）
// ---------------------------------------------------------------------------

const mockSessions = new Map<string, AiSessionOpenResponseDto>()
const mockPendingClarify = new Map<string, AiClarifyOptionDto[]>()
interface MockInFlightTurn {
  resolve: (resp: AiAskTurnResponseDto) => void
  settled: boolean
}
const mockInFlight = new Map<string, MockInFlightTurn>()

let mockHealth: AiQueryHealthResponseDto = {
  status: 'ok',
  runtime: { kind: 'mock', version: 'mock-1', profileRef: null },
}

/** 测试注入健康探测结果（AR-11 降级复现）；用后请 resetMockAiQueryState。 */
export function setMockAiQueryHealth(resp: AiQueryHealthResponseDto): void {
  mockHealth = resp
}

export function resetMockAiQueryState(): void {
  mockSessions.clear()
  mockPendingClarify.clear()
  mockInFlight.clear()
  mockHealth = { status: 'ok', runtime: { kind: 'mock', version: 'mock-1', profileRef: null } }
}

// ---------------------------------------------------------------------------
// 夹具（数字与 P4-A 黄金订单 ORDER-AQ-1001 同源；DecimalString 原样，前端不做算术）
// ---------------------------------------------------------------------------

const ECHO_BASE = {
  userId: 'user-s-1',
  enterpriseId: 'n-ent',
  channel: 'web',
  dataScope: { enterpriseWide: false, plantIds: ['n-plant'] },
  capabilityVersion: 1,
  ignoredRequestFields: [],
}

function envelopeOf(partial: {
  status: AiQueryEnvelopeDto['status']
  message: string
  data: AiQueryEnvelopeDto['data']
  completeness: AiQueryEnvelopeDto['completeness']
  freshness: AiQueryEnvelopeDto['freshness']
  contextEcho: Partial<AiQueryEnvelopeDto['contextEcho']>
  requestId: string
  toolCallSeq: number
  sessionId: string
}): AiQueryEnvelopeDto {
  return {
    status: partial.status,
    statusLabel: labelOfStatus(partial.status),
    message: partial.message,
    data: partial.data,
    completeness: partial.completeness,
    freshness: partial.freshness,
    contextEcho: { ...ECHO_BASE, ...partial.contextEcho } as AiQueryEnvelopeDto['contextEcho'],
    auditRef: { requestId: partial.requestId, toolCallSeq: partial.toolCallSeq },
  }
}

function labelOfStatus(status: AiQueryEnvelopeDto['status']): string {
  const labels: Record<AiQueryEnvelopeDto['status'], string> = {
    ok_with_data: '查询成功（有数据）',
    ok_no_records: '查询成功（无匹配记录）',
    no_permission: '无权限执行该问数',
    not_supported: '该问数能力未注册或已停用',
    source_not_ready: '数据源未就绪',
    timeout: '查询超时',
    failed: '查询失败',
  }
  return labels[status]
}

/** AQ-C1（默认场景）：订单进度——五量分立、排程完成度、未完成任务。（导出供测试自组装取证） */
export function mockOrderProgressEnvelope(requestId: string, sessionId: string, orderNo = 'ORDER-AQ-1001', orderId = 'po-1001'): AiQueryEnvelopeDto {
  const ops = [
    {
      orderOperationId: 'opo-1001-1',
      seq: 1,
      operationName: '拉丝',
      offlineQty: '100.0000',
      uom: 'KM',
      quantities: { draftQty: '30.0000', submittedQty: '0.0000', approvedQty: '80.0000', qualifiedQty: '78.0000', stockedQty: '80.0000' },
      scheduledQty: '100.0000',
      fullyScheduled: true,
      ready: false,
      readyReason: '排程已排完，审核通过量 80.0000 KM 已入库',
      incomplete: false,
    },
    {
      orderOperationId: 'opo-1001-2',
      seq: 2,
      operationName: '绞制',
      offlineQty: '20.0000',
      uom: 'KM',
      quantities: { draftQty: '0.0000', submittedQty: '0.0000', approvedQty: '0.0000', qualifiedQty: '0.0000', stockedQty: '0.0000' },
      scheduledQty: '0.0000',
      fullyScheduled: false,
      ready: false,
      readyReason: '排程未排完且审核通过量为零（未完成判定=五量与排程事实，不依赖 execution_status，GAP-P9）',
      incomplete: true,
    },
  ]
  return envelopeOf({
    status: 'ok_with_data',
    message: '该订单 2 道工序中 1 道未完成；订单级五量与排程完成度见事实表（本段为 AI 解释、非事实，请以事实列为准）。',
    data: {
      capabilityId: 'aq.order-progress',
      order: {
        orderId,
        plantId: 'n-plant',
        orderNo,
        orderType: 'standard',
        salesContractNo: 'SC-2026-1024',
        salesOrderNo: 'SO-2026-1101',
        lineNo: '10',
        materialDesc: '铜芯绝缘电缆 ZC-BV 2.5mm² 红色',
        productionQty: '100.0000',
        uom: 'KM',
        orderStatus: 'in_progress',
        suspended: false,
        suspendedReason: null,
        processConfigStatus: 'frozen',
        bomRevisionId: 'bom-r-1001',
        routeRevisionId: 'rt-r-1001',
        actualStartAt: '2026-10-20T01:00:00.000Z',
        plannedStartAt: '2026-10-19T16:00:00.000Z',
        plannedFinishAt: '2026-11-05T16:00:00.000Z',
        businessClosedAt: null,
        erpClosedAt: null,
        totalQuantities: { draftQty: '30.0000', submittedQty: '0.0000', approvedQty: '80.0000', qualifiedQty: '78.0000', stockedQty: '80.0000' },
        schedulingStatus: 'partially_scheduled',
        operations: ops,
      },
      candidates: [],
    },
    completeness: { truncated: false, fetchedRows: 2, totalKnown: true, total: 2, page: null },
    freshness: {
      queriedAt: '2026-10-28T03:00:00.000Z',
      sources: [
        { source: 'production_order', updatedAt: '2026-10-27T09:30:00.000Z' },
        { source: 'order_operation', updatedAt: '2026-10-27T09:30:00.000Z' },
        { source: 'schedule_slot', updatedAt: 'unknown' },
        { source: 'production_report', updatedAt: '2026-10-27T08:11:00.000Z' },
      ],
    },
    contextEcho: {
      requestId,
      toolCallSeq: 1,
      sessionId,
      capabilityId: 'aq.order-progress',
      effectiveFilters: { orderRef: { kind: 'orderNo', value: orderNo }, plantIds: ['n-plant'] },
      factColumns: ['order_status', 'draft_qty', 'submitted_qty', 'approved_qty', 'qualified_qty', 'stocked_qty', 'scheduling_status'],
      notes: [],
    },
    requestId,
    toolCallSeq: 1,
    sessionId,
  })
}

/** AQ-C2：物料缺口——口径未定标注 + 单位不一致未折算 + 截断（totalKnown=false）。（导出供测试） */
export function mockMaterialShortageEnvelope(requestId: string, sessionId: string): AiQueryEnvelopeDto {
  return envelopeOf({
    status: 'ok_with_data',
    message: '该订单 3 个料品中 2 个存在缺口风险提示；缺口数值列口径未定，未给猜测数值（本段为 AI 解释、非事实）。',
    data: {
      capabilityId: 'aq.material-shortage',
      orderId: 'po-1001',
      orderNo: 'ORDER-AQ-1001',
      bomRevisionId: 'bom-r-1001',
      bomRevisionVersion: 1,
      requirementBase: null,
      lines: [
        {
          materialId: 'mat-001',
          materialCode: 'MAT-CU-001',
          materialName: '电工圆铜线',
          spec: 'TR-2.5',
          model: null,
          color: null,
          bomQuantity: '12.5000',
          uom: 'KG',
          requirementBase: null,
          requiredQty: null,
          availability: { grossQty: '0.3000', reservedQty: '0.1000', availableQty: '0.2000' },
          inTransitQty: '6.0000',
          shortageQty: null,
          shortageNote: '口径未定',
          uomMismatch: false,
          uomSources: { bom: 'KG', stock: 'KG', purchase: 'KG' },
          purchaseLines: [
            {
              lineId: 'pol-001',
              orderNo: 'PO-2026-0301',
              lineNo: 1,
              status: 2,
              statusLabel: '部分收货',
              plannedQty: '10.0000',
              receivedQty: '4.0000',
              inTransitQty: '6.0000',
              erpClosed: false,
              plannedReceiptDate: '2026-11-01',
              firstArrivalDate: '2026-10-25',
              lastArrivalDate: '2026-10-26',
              uomCode: 'KG',
              latestBatchInspectionStatus: 'partially_qualified',
              latestBatchInspectionStatusLabel: '部分合格',
            },
          ],
        },
        {
          materialId: 'mat-002',
          materialCode: 'MAT-XL-002',
          materialName: '交联聚乙烯绝缘料',
          spec: 'XLPE-10KV',
          model: null,
          color: '自然色',
          bomQuantity: '8.0000',
          uom: 'KG',
          requirementBase: null,
          requiredQty: null,
          availability: { grossQty: '50.0000', reservedQty: '12.0000', availableQty: '38.0000' },
          inTransitQty: '0.0000',
          shortageQty: null,
          shortageNote: '单位不一致未折算',
          uomMismatch: true,
          uomSources: { bom: 'KG', stock: 'KG', purchase: 'PC' },
          purchaseLines: [],
        },
        {
          materialId: 'mat-003',
          materialCode: 'MAT-PVC-003',
          materialName: '聚氯乙烯护套料',
          spec: 'H-70',
          model: null,
          color: '黑色',
          bomQuantity: '5.0000',
          uom: 'KG',
          requirementBase: null,
          requiredQty: null,
          availability: { grossQty: '120.0000', reservedQty: '20.0000', availableQty: '100.0000' },
          inTransitQty: '0.0000',
          shortageQty: null,
          shortageNote: '口径未定',
          uomMismatch: false,
          uomSources: { bom: 'KG', stock: 'KG', purchase: null },
          purchaseLines: [],
        },
      ],
      candidates: [],
    },
    completeness: { truncated: true, fetchedRows: 3, totalKnown: false, total: null, page: null },
    freshness: {
      queriedAt: '2026-10-28T03:00:00.000Z',
      sources: [
        { source: 'manufacturing_bom_revision', updatedAt: '2026-10-10T02:00:00.000Z' },
        { source: 'stock_balance', updatedAt: '2026-10-27T07:40:00.000Z' },
        { source: 'purchase_order_line', updatedAt: 'unknown' },
      ],
    },
    contextEcho: {
      requestId,
      toolCallSeq: 1,
      sessionId,
      capabilityId: 'aq.material-shortage',
      effectiveFilters: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' }, plantIds: ['n-plant'] },
      factColumns: ['bom_quantity', 'gross_qty', 'reserved_qty', 'available_qty', 'in_transit_qty', 'uom'],
      notes: ['BOM 基数口径未配置（requirementBase=null）：缺口数值列固定标注「口径未定」，不给猜测数值（GAP-P4，AQ-AMB-03）'],
    },
    requestId,
    toolCallSeq: 1,
    sessionId,
  })
}

/** AQ-C3：质量查询——两族并查、默认时间窗回显（AQ-AMB-02）、事实列与解释分开。（导出供测试） */
export function mockQualityEnvelope(
  requestId: string,
  sessionId: string,
  range: { from: string; to: string; defaultApplied: boolean },
): AiQueryEnvelopeDto {
  return envelopeOf({
    status: 'ok_with_data',
    message: '该时间范围内 2 张检验单未通过、其中 1 张已让步放行；1 个来料批次部分合格（本段为 AI 解释、非事实，请以事实列为准）。',
    data: {
      capabilityId: 'aq.quality',
      timeRange: range,
      objectScope: 'all',
      inspectionOrders: [
        {
          family: 'inspection_order',
          id: 'qio-020',
          orderNo: 'QI-2026-0031',
          sourceType: 'work_report',
          inspectionStage: 'process',
          specCode: 'SPEC-BV-2.5',
          specVersion: 2,
          unitNo: null,
          materialCode: 'MAT-CU-001',
          quantity: '12.0000',
          uomCode: 'KM',
          productionOrderNo: 'ORDER-AQ-1001',
          productionDeptName: '拉丝车间',
          plantId: 'n-plant',
          status: 'concluded',
          statusLabel: '已出结论',
          businessTime: '2026-10-26T01:20:00.000Z',
          effectiveConclusion: { version: 1, conclusion: 'unqualified', resultKind: 'initial', inspector: 'qc01', inspectedAt: '2026-10-26T05:00:00.000Z' },
          latestDisposition: { dispositionKind: 'concession', basedOnVersion: 1, releasedBy: 'qcadmin', releasedAt: '2026-10-27T02:00:00.000Z', reason: '客户同意让步接收' },
          activeHold: null,
        },
        {
          family: 'inspection_order',
          id: 'qio-021',
          orderNo: 'QI-2026-0032',
          sourceType: 'putaway_receipt',
          inspectionStage: 'finished',
          specCode: 'SPEC-BV-2.5',
          specVersion: 2,
          unitNo: 'UNIT-2026-0801',
          materialCode: 'MAT-CU-001',
          quantity: '8.0000',
          uomCode: 'KM',
          productionOrderNo: 'ORDER-AQ-0999',
          productionDeptName: '挤塑车间',
          plantId: 'n-plant',
          status: 'concluded',
          statusLabel: '已出结论',
          businessTime: '2026-10-27T06:00:00.000Z',
          effectiveConclusion: { version: 1, conclusion: 'qualified', resultKind: 'initial', inspector: 'qc02', inspectedAt: '2026-10-27T07:30:00.000Z' },
          latestDisposition: { dispositionKind: 'release', basedOnVersion: 1, releasedBy: 'qcadmin', releasedAt: '2026-10-27T08:00:00.000Z', reason: null },
          activeHold: null,
        },
      ],
      purchaseBatches: [
        {
          family: 'purchase_batch',
          id: 'prb-090',
          batchNo: 'B-2026-0501',
          orderNo: 'PO-2026-0301',
          lineNo: 1,
          materialCode: 'MAT-CU-001',
          materialName: '电工圆铜线',
          receivedQty: '4.0000',
          uomCode: 'KG',
          inspectionStatus: 'partially_qualified',
          inspectionStatusLabel: '部分合格',
          storageStatus: 'stored',
          plantId: 'n-plant',
          arrivalTime: '2026-10-25T09:00:00.000Z',
          confirmTime: '2026-10-25T10:00:00.000Z',
          detailQualitySummary: [
            { qualityStatus: 'qualified', qualityStatusLabel: '合格', count: 2 },
            { qualityStatus: 'unqualified', qualityStatusLabel: '不合格', count: 1 },
          ],
        },
      ],
    },
    completeness: { truncated: false, fetchedRows: 3, totalKnown: true, total: 3, page: { page: 1, pageSize: 20 } },
    freshness: {
      queriedAt: '2026-10-28T03:00:00.000Z',
      sources: [
        { source: 'quality_inspection_order', updatedAt: '2026-10-27T09:30:00.000Z' },
        { source: 'purchase_receipt_batch', updatedAt: 'unknown' },
      ],
    },
    contextEcho: {
      requestId,
      toolCallSeq: 1,
      sessionId,
      capabilityId: 'aq.quality',
      effectiveFilters: { objectScope: 'all', timeRange: { from: range.from, to: range.to }, plantIds: ['n-plant'] },
      factColumns: ['生效结论', '检验状态', '处置', '隔离状态', '业务时间'],
      notes: range.defaultApplied ? ['未指定时间范围，按默认「最近 7 个自然日（Asia/Shanghai）」执行；实际起止已回显，可修改后重问（AQ-AMB-02）'] : [],
    },
    requestId,
    toolCallSeq: 1,
    sessionId,
  })
}

/** 重名订单澄清（AQ-AMB-01）：结构化候选选项，选择后带精确参数重发。 */
function orderClarifyOptions(): AiClarifyOptionDto[] {
  return [
    {
      id: 'opt-order-1001',
      kind: 'order_candidate',
      label: 'ORDER-AQ-1001（杭州制造工厂）',
      detail: {
        orderNo: 'ORDER-AQ-1001',
        plantName: '杭州制造工厂',
        orderStatus: 'in_progress',
        materialDesc: '铜芯绝缘电缆 ZC-BV 2.5mm² 红色',
        createdAt: '2026-10-18T02:00:00.000Z',
      },
      confirm: { capabilityId: 'aq.order-progress', params: { orderRef: { kind: 'orderId', value: 'po-1001' } } },
    },
    {
      id: 'opt-order-1002',
      kind: 'order_candidate',
      label: 'ORDER-AQ-1002（合肥线缆厂）',
      detail: {
        orderNo: 'ORDER-AQ-1002',
        plantName: '合肥线缆厂',
        orderStatus: 'released',
        materialDesc: '铜芯绝缘电缆 ZC-BV 4mm² 蓝色',
        createdAt: '2026-10-15T02:00:00.000Z',
      },
      confirm: { capabilityId: 'aq.order-progress', params: { orderRef: { kind: 'orderId', value: 'po-1002' } } },
    },
  ]
}

function timeRangeClarifyOptions(): AiClarifyOptionDto[] {
  return [
    {
      id: 'opt-range-7d',
      kind: 'time_range',
      label: '最近 7 个自然日（2026-10-21 ～ 2026-10-28）',
      detail: { from: '2026-10-21T16:00:00.000Z', to: '2026-10-28T16:00:00.000Z' },
      confirm: {
        capabilityId: 'aq.quality',
        params: { objectScope: 'all', timeRange: { from: '2026-10-21T16:00:00.000Z', to: '2026-10-28T16:00:00.000Z' } },
      },
    },
    {
      id: 'opt-range-30d',
      kind: 'time_range',
      label: '最近 30 个自然日（2026-09-28 ～ 2026-10-28）',
      detail: { from: '2026-09-27T16:00:00.000Z', to: '2026-10-28T16:00:00.000Z' },
      confirm: {
        capabilityId: 'aq.quality',
        params: { objectScope: 'all', timeRange: { from: '2026-09-27T16:00:00.000Z', to: '2026-10-28T16:00:00.000Z' } },
      },
    },
  ]
}

function turnResponse(base: Partial<AiAskTurnResponseDto> & Pick<AiAskTurnResponseDto, 'requestId' | 'outcome' | 'message'>): AiAskTurnResponseDto {
  return {
    envelope: null,
    options: null,
    unavailableReason: null,
    statusDetail: null,
    ...base,
  }
}

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------

export function mockAiQueryRoutes(method: string, path: string): MockAiQueryHandler | null {
  if (method === 'POST' && path === '/aiquery/sessions') {
    return (ctx) => {
      requireToken(ctx)
      const body = (ctx.body ?? {}) as Partial<AiSessionOpenRequestDto>
      const allowed = ['web', 'pda', 'wecom', 'feishu', 'mock'] as const
      if (typeof body.channel !== 'string' || !allowed.includes(body.channel as (typeof allowed)[number])) {
        throw new MockError({ httpStatus: 422, code: 'ERR_VALIDATION', message: `channel 非法：${String(body.channel)}（须为 ${allowed.join('/')} 之一）` })
      }
      const sessionId = `ai-sess-${Math.random().toString(36).slice(2, 10)}`
      const session: AiSessionOpenResponseDto = {
        sessionId,
        enterpriseId: 'n-ent',
        userId: 'user-s-1',
        channel: body.channel,
        status: 'open',
      }
      mockSessions.set(sessionId, session)
      return session
    }
  }
  if (method === 'POST' && path === '/aiquery/turns') {
    return (ctx) => askTurn(ctx)
  }
  const cancelMatch = /^\/aiquery\/turns\/([^/]+)\/cancel$/.exec(path)
  if (method === 'POST' && cancelMatch) {
    return (ctx) => {
      requireToken(ctx)
      const requestId = decodeURIComponent(cancelMatch[1] ?? '')
      const inFlight = mockInFlight.get(requestId)
      if (inFlight && !inFlight.settled) {
        inFlight.settled = true
        inFlight.resolve(
          turnResponse({
            requestId,
            outcome: 'cancelled',
            message: '本轮已取消：未再发起新的工具调用；已完成阶段的摘要见本消息（阶段：模型已解析提问，工具调用 0 次完成后取消）。',
            statusDetail: { stageSummary: '模型已解析提问；取消后停止继续调工具' },
          }),
        )
      }
      return { status: 'cancelled', decision: inFlight ? 'cancelled_in_flight' : 'unknown_request' }
    }
  }
  if (method === 'GET' && path === '/aiquery/health') {
    // 探测端点不要求令牌（只作可用性判定，不返回业务数据；AR-11 降级判定源）
    return () => mockHealth
  }
  return null
}

function requireToken(ctx: MockAiQueryContext): void {
  if (!ctx.token) {
    throw new MockError({ httpStatus: 401, code: 'ERR_AUTH_REQUIRED', message: '请先登录：会话缺失或已过期，请重新登录' })
  }
}

function askTurn(ctx: MockAiQueryContext): Promise<AiAskTurnResponseDto> | AiAskTurnResponseDto {
  requireToken(ctx)
  const body = (ctx.body ?? {}) as Partial<AiAskTurnRequestDto>
  const requestId = typeof body.requestId === 'string' && body.requestId ? body.requestId : `req-${Math.random().toString(36).slice(2)}`
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const message = typeof body.userMessage === 'string' ? body.userMessage : ''
  if (!mockSessions.has(sessionId)) {
    throw new MockError({ httpStatus: 404, code: 'ERR_AI_SESSION_NOT_FOUND', message: '问数会话不存在或已失效，请重新进入问数页' })
  }

  // 澄清答复轮：按选项 id 精确重发（AQ-AMB-01/02；选项不来自系统查询结果 → 拒绝）
  if (body.clarifyOptionId) {
    const options = mockPendingClarify.get(requestId) ?? []
    const option = options.find((o) => o.id === body.clarifyOptionId)
    if (!option) {
      throw new MockError({ httpStatus: 422, code: 'ERR_CLARIFY_OPTIONS_NOT_FROM_CAPABILITY', message: '澄清选项不来自系统查询结果，请从候选清单中选择 [AQ-AMB-01]' })
    }
    mockPendingClarify.delete(requestId)
    if (option.kind === 'order_candidate') {
      const orderNo = option.detail?.orderNo ?? 'ORDER-AQ-1001'
      return turnResponse({
        requestId,
        outcome: 'answer',
        message: `已按您选择的订单 ${orderNo} 重新执行（精确参数重发）；结果如下（本段为 AI 解释、非事实）。`,
        envelope: mockOrderProgressEnvelope(requestId, sessionId, orderNo),
      })
    }
    if (option.kind === 'time_range') {
      const params = option.confirm?.params as { timeRange?: { from: string; to: string } } | undefined
      const range = { from: params?.timeRange?.from ?? '2026-09-27T16:00:00.000Z', to: params?.timeRange?.to ?? '2026-10-28T16:00:00.000Z', defaultApplied: false }
      return turnResponse({
        requestId,
        outcome: 'answer',
        message: '已按您确认的时间范围重新执行（实际起止见回显）；结果如下（本段为 AI 解释、非事实）。',
        envelope: mockQualityEnvelope(requestId, sessionId, range),
      })
    }
    return turnResponse({
      requestId,
      outcome: 'answer',
      message: '已按您选择的口径重新执行；结果如下（本段为 AI 解释、非事实）。',
      envelope: mockMaterialShortageEnvelope(requestId, sessionId),
    })
  }

  const unavailable = (reason: AiAskTurnResponseDto['unavailableReason'], msg: string, statusDetail?: Record<string, unknown>): AiAskTurnResponseDto =>
    turnResponse({ requestId, outcome: 'unavailable', message: msg, unavailableReason: reason, statusDetail: statusDetail ?? null })

  if (message.includes('无权限')) {
    throw new MockError({ httpStatus: 403, code: 'ERR_FORBIDDEN', message: '无 AI 问数权限（aiquery.use）或缺少对应业务域读权限，请联系管理员授权 [AQ-AUTH-02]' })
  }
  if (message.includes('SC-2026-1024')) {
    const options = orderClarifyOptions()
    mockPendingClarify.set(requestId, options)
    return turnResponse({
      requestId,
      outcome: 'clarify',
      message: '命中的订单不止一张（销售单号 SC-2026-1024 对应 2 张生产订单），请选择一张后继续；不会自行替您择一作答 [AQ-AMB-01]。',
      options,
    })
  }
  if (message.includes('时间范围确认')) {
    const options = timeRangeClarifyOptions()
    mockPendingClarify.set(requestId, options)
    return turnResponse({
      requestId,
      outcome: 'clarify',
      message: '请确认查询时间范围 [AQ-AMB-02]。',
      options,
    })
  }
  if (message.includes('缺料') || message.includes('缺口')) {
    return turnResponse({ requestId, outcome: 'answer', message: '该订单物料并排结果如下：缺口数值列口径未定，不给猜测数值（本段为 AI 解释、非事实）。', envelope: mockMaterialShortageEnvelope(requestId, sessionId) })
  }
  if (message.includes('质量') || message.includes('检验') || message.includes('质检')) {
    return turnResponse({
      requestId,
      outcome: 'answer',
      message: '最近 7 个自然日的质量结果如下（默认时间窗，可修改后重问；本段为 AI 解释、非事实）。',
      envelope: mockQualityEnvelope(requestId, sessionId, { from: '2026-10-21T16:00:00.000Z', to: '2026-10-28T16:00:00.000Z', defaultApplied: true }),
    })
  }
  if (message.includes('超限')) {
    return unavailable('over_limit', 'AI 问数暂不可用：已超出 AI 问数使用限额（并发/日次数/单轮预算），请稍后再试 [AR-11]。', { which: 'daily', limit: 50 })
  }
  if (message.includes('启动中')) {
    return unavailable('starting', 'AI 问数暂不可用：AI 服务正在启动，请稍候重试 [AR-11]。')
  }
  if (message.includes('不可达')) {
    return unavailable('unreachable', 'AI 问数暂不可用：AI 服务不可达，请稍后重试 [AR-11]。')
  }
  if (message.includes('超时')) {
    return turnResponse({
      requestId,
      outcome: 'unavailable',
      message: 'AI 问数暂不可用：本轮查询超时，已停止继续调用工具；已取部分数据随附（完整性标注：未取全，不构成完整总量） [AQ-REG-10]。',
      unavailableReason: null,
      statusDetail: { status: 'timeout', scope: 'single_query', capabilityId: 'aq.quality', toolCallSeqReached: 1 },
      envelope: envelopeOf({
        status: 'timeout',
        message: '查询超时（阶段：query）[AQ-REG-10]',
        data: null,
        completeness: { truncated: true, fetchedRows: 1, totalKnown: false, total: null, page: null },
        freshness: { queriedAt: '2026-10-28T03:00:00.000Z', sources: [{ source: 'quality_inspection_order', updatedAt: 'unknown' }] },
        contextEcho: {
          requestId,
          toolCallSeq: 1,
          sessionId,
          capabilityId: 'aq.quality',
          effectiveFilters: {},
          factColumns: [],
          notes: ['超时前已取 1 行，未取全，不得总结为完整总量'],
        },
        requestId,
        toolCallSeq: 1,
        sessionId,
      }),
    })
  }
  if (message.includes('慢速')) {
    return new Promise<AiAskTurnResponseDto>((resolve) => {
      const entry: MockInFlightTurn = {
        settled: false,
        resolve: (resp) => {
          entry.settled = true
          resolve(resp)
        },
      }
      mockInFlight.set(requestId, entry)
      setTimeout(() => {
        if (!entry.settled) entry.resolve(turnResponse({ requestId, outcome: 'answer', message: '慢速场景回答（用于取消测试）：结果如下。', envelope: mockOrderProgressEnvelope(requestId, sessionId) }))
      }, 900)
    })
  }
  if (message.includes('未就绪')) {
    return turnResponse({
      requestId,
      outcome: 'answer',
      message: '该问法属未就绪问法族（数据源未接读面），不作空数据冒充 [AQ-REG-01]。',
      envelope: envelopeOf({
        status: 'source_not_ready',
        message: '数据源未就绪：工时与经营统计无版本化口径读面，属未就绪问法族 [AQ-REG-01]',
        data: null,
        completeness: { truncated: false, fetchedRows: 0, totalKnown: false, total: null, page: null },
        freshness: { queriedAt: '2026-10-28T03:00:00.000Z', sources: [] },
        contextEcho: { requestId, toolCallSeq: 1, sessionId, capabilityId: 'topic.labor-stats', effectiveFilters: {}, factColumns: [], notes: ['未就绪问法族固定清单第 2 项（capability-contract.md §8）'] },
        requestId,
        toolCallSeq: 1,
        sessionId,
      }),
    })
  }
  if (message.includes('未注册')) {
    return turnResponse({
      requestId,
      outcome: 'answer',
      message: '该问数能力未注册或已停用 [AQ-REG-01]。',
      envelope: envelopeOf({
        status: 'not_supported',
        message: '能力未注册：capabilityId=aq.demo-unknown [AQ-REG-01]',
        data: null,
        completeness: { truncated: false, fetchedRows: 0, totalKnown: false, total: null, page: null },
        freshness: { queriedAt: '2026-10-28T03:00:00.000Z', sources: [] },
        contextEcho: { requestId, toolCallSeq: 1, sessionId, capabilityId: 'aq.demo-unknown', effectiveFilters: {}, factColumns: [], notes: [] },
        requestId,
        toolCallSeq: 1,
        sessionId,
      }),
    })
  }
  if (message.includes('无匹配')) {
    return turnResponse({
      requestId,
      outcome: 'answer',
      message: '过滤条件有效但无匹配对象（ok_no_records；零值≠无记录）。',
      envelope: envelopeOf({
        status: 'ok_no_records',
        message: '无匹配记录：orderRef=ORDER-AQ-9999 [AQ-REG-08]',
        data: { capabilityId: 'aq.order-progress', order: null, candidates: [] },
        completeness: { truncated: false, fetchedRows: 0, totalKnown: true, total: 0, page: null },
        freshness: { queriedAt: '2026-10-28T03:00:00.000Z', sources: [{ source: 'production_order', updatedAt: '2026-10-27T09:30:00.000Z' }] },
        contextEcho: { requestId, toolCallSeq: 1, sessionId, capabilityId: 'aq.order-progress', effectiveFilters: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-9999' } }, factColumns: [], notes: [] },
        requestId,
        toolCallSeq: 1,
        sessionId,
      }),
    })
  }
  return turnResponse({
    requestId,
    outcome: 'answer',
    message: '已查询订单 ORDER-AQ-1001 当前进度（本段为 AI 解释、非事实，请以事实列为准）。',
    envelope: mockOrderProgressEnvelope(requestId, sessionId),
  })
}
