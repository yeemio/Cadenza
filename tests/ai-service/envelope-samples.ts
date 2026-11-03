/**
 * DS-21 冻结信封样例（dsh-edge.md §4 + AQ-REG-07）。
 *
 * 这是 B↔A 两线的共同冻结面：B 线受控查询客户端与 A 线 /internal/aiquery/execute
 * 双方 supertest 断言同一组样例（字段漂移视为合同违约）。本文件为 B 侧断言源；
 * 同一 JSON 会整体誊入 delivery/P4/ai-service/DELIVERY.md 对照表，供 A 线对齐。
 *
 * wire 权威面 = packages/contracts/src/aiquery.ts（AiQueryEnvelopeDto 及各能力结果 DTO），
 * 本文件与其逐字段一致（DS-21 返工 2026-10-28 对齐三处）：
 * - freshness.sources[].source（非 name）；
 * - contextEcho 为 AiQueryContextEchoDto 13 字段富形状原形（无顶层 timeRange，
 *   时间范围实际起止在 effectiveFilters 内回显）；
 * - 澄清候选承载位 = 各能力结果 DTO 的 data.candidates（AiOrderCandidateDto，
 *   AQ-AMB-01），顶层无 clarificationOptions——该字段是 B 侧受控查询客户端
 *   自 data.candidates 映射的内部消费投影（见 controlled-query-client.ts）。
 *
 * 样例语境（虚构、可复现；真实运行时抓取样例见 delivery/P4/query/ENVELOPE-SAMPLE.md）：
 * capabilityId=aq.order-progress，模糊单号 SC-2026-1024 命中两订单（AQ-AMB-01 多候选），
 * requestId=3f8d2b1e-…-01，toolCallSeq=1。
 */
import type { AiQueryResultStatus, EnvelopeContextEcho, EnvelopeFreshness, ToolResult } from '../../packages/integrations/dsh'
import type { CapabilitiesResponse, ExecuteRequest } from '../../apps/ai/src/controlled-query-client'

export const SAMPLE_REQUEST_ID = '3f8d2b1e-0000-4000-8000-000000000001'
export const SAMPLE_SESSION_ID = '3f8d2b1e-0000-4000-8000-0000000000aa'
export const SAMPLE_TOOL_CALL_SEQ = 1

/**
 * AQ-AMB-01 多候选场景的两个候选订单（wire AiOrderCandidateDto 原形）。
 * B 侧投影后的澄清选项 id = candidateOptionId(orderId)（见 controlled-query-client.ts）。
 */
export const SAMPLE_ORDER_CANDIDATES = [
  {
    orderId: '3f8d2b1e-0000-4000-8000-000000000101',
    orderNo: 'SC-2026-1024',
    plantId: 'PLNT-SZ',
    orderStatus: 'in_progress',
    materialDesc: '中压电缆 / 3×95 / 红',
    createdAt: '2026-10-20T08:00:00.000Z',
  },
  {
    orderId: '3f8d2b1e-0000-4000-8000-000000000102',
    orderNo: 'SC-2026-1024',
    plantId: 'PLNT-HF',
    orderStatus: 'released',
    materialDesc: '中压电缆 / 3×95 / 蓝',
    createdAt: '2026-10-22T08:00:00.000Z',
  },
] as const

/** DS-19 execute 请求体样例（注意：不含任何 tenant/user/scope 字段——执行上下文以服务端绑定为准，AQ-REG-06）。 */
export const SAMPLE_EXECUTE_REQUEST: ExecuteRequest = {
  requestId: SAMPLE_REQUEST_ID,
  toolCallSeq: SAMPLE_TOOL_CALL_SEQ,
  sessionId: SAMPLE_SESSION_ID,
  capabilityId: 'aq.order-progress',
  capabilityVersion: 1,
  params: { orderRef: { kind: 'orderNoLike', value: 'SC-2026-1024' } },
}

const baseFreshness: EnvelopeFreshness = {
  queriedAt: '2026-10-28T02:00:00.000Z',
  sources: [
    { source: 'production_order', updatedAt: '2026-10-27T09:30:00.000Z' },
    { source: 'order_operation', updatedAt: 'unknown' },
  ],
}

/** contextEcho=wire AiQueryContextEchoDto 13 字段原形（无顶层 timeRange）。 */
const baseContextEcho: EnvelopeContextEcho = {
  requestId: SAMPLE_REQUEST_ID,
  toolCallSeq: SAMPLE_TOOL_CALL_SEQ,
  sessionId: SAMPLE_SESSION_ID,
  userId: '3f8d2b1e-0000-4000-8000-0000000000bb',
  enterpriseId: '3f8d2b1e-0000-4000-8000-0000000000cc',
  channel: 'web',
  dataScope: { enterpriseWide: false, plantIds: ['PLNT-SZ', 'PLNT-HF'] },
  capabilityId: 'aq.order-progress',
  capabilityVersion: 1,
  effectiveFilters: { orderRef: { kind: 'orderNoLike', value: 'SC-2026-1024' } },
  ignoredRequestFields: [],
  factColumns: [],
  notes: [],
}

/** 非数据态 contextEcho：同 13 字段原形（B 侧不增删字段），仅附注承载状态说明。 */
function emptyContextEcho(notes: string[]): EnvelopeContextEcho {
  return { ...baseContextEcho, effectiveFilters: {}, notes }
}

const auditRef = { requestId: SAMPLE_REQUEST_ID, toolCallSeq: SAMPLE_TOOL_CALL_SEQ }

/**
 * 七状态各一条冻结样例（ok_with_data 携带 data.candidates=DS-08 澄清选项来源，
 * wire 形如 AiOrderProgressResultDto.candidates）。
 */
export const ENVELOPE_SAMPLES: Record<AiQueryResultStatus, ToolResult> = {
  ok_with_data: {
    status: 'ok_with_data',
    data: {
      capabilityId: 'aq.order-progress',
      order: null,
      candidates: [...SAMPLE_ORDER_CANDIDATES],
    },
    completeness: { truncated: false, fetchedRows: 2, totalKnown: true, total: 2, page: null },
    freshness: baseFreshness,
    contextEcho: baseContextEcho,
    auditRef,
  },
  ok_no_records: {
    status: 'ok_no_records',
    data: null,
    completeness: { truncated: false, fetchedRows: 0, totalKnown: true, total: 0, page: null },
    freshness: baseFreshness,
    contextEcho: emptyContextEcho(['过滤条件有效但无匹配对象']),
    auditRef,
  },
  no_permission: {
    status: 'no_permission',
    data: null,
    completeness: { truncated: false, fetchedRows: 0, totalKnown: false, total: null, page: null },
    freshness: { queriedAt: '2026-10-28T02:00:00.000Z', sources: [] },
    contextEcho: emptyContextEcho(['会话绑定用户实时重验未通过（AQ-AUTH-01）']),
    auditRef,
  },
  not_supported: {
    status: 'not_supported',
    data: null,
    completeness: { truncated: false, fetchedRows: 0, totalKnown: false, total: null, page: null },
    freshness: { queriedAt: '2026-10-28T02:00:00.000Z', sources: [] },
    contextEcho: emptyContextEcho(['能力未注册（AQ-REG-01）']),
    auditRef,
  },
  source_not_ready: {
    status: 'source_not_ready',
    data: null,
    completeness: { truncated: false, fetchedRows: 0, totalKnown: false, total: null, page: null },
    freshness: { queriedAt: '2026-10-28T02:00:00.000Z', sources: [] },
    contextEcho: emptyContextEcho(['未就绪问法族（§8 清单）: reporting-metrics']),
    auditRef,
  },
  timeout: {
    status: 'timeout',
    data: null,
    completeness: { truncated: true, fetchedRows: 0, totalKnown: false, total: null, page: null },
    freshness: { queriedAt: '2026-10-28T02:00:00.000Z', sources: [] },
    contextEcho: emptyContextEcho(['A 侧查询超时（stage=query）']),
    auditRef,
    failure: { stage: 'query', code: 'ERR_AI_QUERY_TIMEOUT', message: '查询超时' },
  },
  failed: {
    status: 'failed',
    data: null,
    completeness: { truncated: false, fetchedRows: 0, totalKnown: false, total: null, page: null },
    freshness: { queriedAt: '2026-10-28T02:00:00.000Z', sources: [] },
    contextEcho: emptyContextEcho([]),
    auditRef,
    failure: { stage: 'query', code: 'ERR_AI_QUERY_FAILED', message: '查询执行异常' },
  },
}

/** DS-18 capabilities 响应样例（首版三能力 + 未就绪问法族）。 */
export const SAMPLE_CAPABILITIES_RESPONSE: CapabilitiesResponse = {
  capabilities: [
    {
      capabilityId: 'aq.order-progress',
      version: 1,
      displayName: '订单进度',
      description: '单订单只读视图：状态、五量、排程完成度、未完成任务',
      inputSchema: { type: 'object', properties: { orderRef: { type: 'object' } }, required: ['orderRef'] },
    },
    {
      capabilityId: 'aq.material-shortage',
      version: 1,
      displayName: '物料缺口',
      description: 'BOM 需求 vs 可用量 vs 采购在途',
      inputSchema: { type: 'object', properties: { orderRef: { type: 'object' } }, required: ['orderRef'] },
    },
    {
      capabilityId: 'aq.quality',
      version: 1,
      displayName: '质量查询',
      description: '时间段内未通过检验与后续处置',
      inputSchema: {
        type: 'object',
        properties: { objectScope: { type: 'string' }, timeRange: { type: 'object' }, conclusions: { type: 'array' } },
        required: ['timeRange'],
      },
    },
  ],
  unreadyTopics: [
    { topic: 'purchase-overdue-impact', message: '采购逾期对工作令的影响：数据源未就绪' },
    { topic: 'labor-hours', message: '工时与经营统计：数据源未就绪' },
    { topic: 'reporting-metrics', message: '报表口径类指标：数据源未就绪' },
    { topic: 'bom-consumption', message: 'BOM 消耗推导：口径未冻结' },
  ],
}
