/**
 * 工具族接口：对 §4 内部受控查询的抽象（dsh-edge.md DS-15）。
 *
 * ToolDescriptor 描述「可调用的只读能力」；ToolResult 字段与 §4 结果信封
 * （capability-contract AQ-REG-07 六段）逐段对齐：
 * status / data / completeness / freshness / contextEcho / auditRef。
 * 信封段逐字段镜像 wire 权威面 `packages/contracts/src/aiquery.ts`
 * （AiQueryEnvelopeDto；DS-21 共同冻结面——字段漂移视为合同违约）。
 *
 * 另携带 clarificationOptions：B 侧内部消费投影（非 A 线 wire 字段）——由
 * apps/ai 受控查询客户端自 wire 各能力结果 DTO 的 data.candidates
 * （AiOrderProgressResultDto.candidates 等，AQ-AMB-01 候选清单冻结位）映射生成，
 * 供 DS-08 澄清流消费（选项来自能力结果，不由模型编造）。
 *
 * 本包零业务依赖（DS-17）：本文件不 import 任何业务面，仅纯类型；
 * wire 镜像采取结构逐字段同形声明（contracts 禁止被本包 import）。
 */

/** 受控查询结果状态（AQ-REG-07 七值，与 A 线信封冻结一致）。 */
export type AiQueryResultStatus =
  | 'ok_with_data'
  | 'ok_no_records'
  | 'no_permission'
  | 'not_supported'
  | 'source_not_ready'
  | 'timeout'
  | 'failed'

/** 完整性标注（AQ-REG-07 completeness：truncated/fetchedRows/totalKnown/total/page）。 */
export interface EnvelopeCompleteness {
  truncated: boolean
  fetchedRows: number
  /** 总量可知性：读面能给出总量为 true；不可知为 false（此时 total=null）。 */
  totalKnown: boolean
  total: number | null
  page: { page: number; pageSize: number } | null
}

/** 时效标注（AQ-REG-07 freshness；镜像 contracts AiQueryFreshnessDto——键名 source，与 wire 逐字段一致）。 */
export interface EnvelopeFreshness {
  /** 服务端执行时刻（ISO-8601 UTC）。 */
  queriedAt: string
  /** 各数据源更新时间（来源记录引用=真实表名，contracts AiQueryFreshnessSourceDto.source）。 */
  sources: Array<{ source: string; updatedAt: string | 'unknown' }>
}

/**
 * 服务端实际生效的执行上下文与有效过滤条件（AQ-REG-06/AQ-AUTH-03/AQ-AMB-02）。
 * 镜像 contracts AiQueryContextEchoDto 13 字段原形（结构同形、不 import，DS-17）：
 * 无顶层 timeRange——时间范围实际起止在 effectiveFilters 内回显（AQ-AMB-02）。
 */
export interface EnvelopeContextEcho {
  requestId: string
  toolCallSeq: number
  sessionId: string
  /** 会话绑定的用户/企业（由会话绑定派生，AQ-AUTH-04）。 */
  userId: string
  enterpriseId: string
  channel: string
  /** 服务端实时重算的数据范围（AQ-AUTH-01/03）。 */
  dataScope: { enterpriseWide: boolean; plantIds: string[] }
  capabilityId: string
  capabilityVersion: number
  /** 实际生效的过滤条件（含时间范围实际起止回显，AQ-AMB-02）。 */
  effectiveFilters: Record<string, unknown>
  /** 请求体携带的执行上下文同名字段（被忽略并记审计，AQ-REG-06）。 */
  ignoredRequestFields: string[]
  /** 事实列提示（AQ-C3：哪些列是判定事实，解释文字由 AI 生成并标注为推测）。 */
  factColumns: string[]
  /** 附注（时间默认回显提示、范围截回标注、口径未定等）。 */
  notes: string[]
}

/** 审计关联（AQ-REG-07 auditRef：requestId/toolCallSeq，贯穿 AR-15 审计链）。 */
export interface ToolResultAuditRef {
  requestId: string
  toolCallSeq: number
}

/** 澄清选项：来自能力结果（AQ-AMB-01 候选清单 / AQ-AMB-03 口径选项）。 */
export interface ClarificationOption {
  id: string
  label: string
  detail?: Record<string, unknown>
  /** 用户确认后带精确参数重新执行的载荷（AQ-AMB-01：带精确 orderId/orderNo 重执行）。 */
  confirm?: { capabilityId: string; params: Record<string, unknown> }
}

/** 失败阶段与错误码（AQ-REG-10：timeout/failed 须带阶段标识 query/model/orchestration）。 */
export interface EnvelopeFailure {
  stage: 'query' | 'model' | 'orchestration'
  code: string
  message: string
}

/** 工具结果＝§4 结果信封（DS-15：字段与信封对齐）。 */
export interface ToolResult {
  status: AiQueryResultStatus
  data: unknown
  completeness: EnvelopeCompleteness
  freshness: EnvelopeFreshness
  contextEcho: EnvelopeContextEcho
  auditRef: ToolResultAuditRef
  /**
   * B 侧内部消费投影（非 A 线 wire 字段、不对 A 线构成形状要求）：
   * 由受控查询客户端自 wire 各能力结果 DTO 的 data.candidates（AQ-AMB-01 候选清单）
   * 映射生成，承载 DS-08 澄清选项的唯一机器来源。
   */
  clarificationOptions?: ClarificationOption[]
  failure?: EnvelopeFailure
}

/**
 * 工具描述符：由 §4 capabilities 接口（DS-18）映射而来，
 * 只登记只读查询能力（红线 AR-R1：注册表无写语义能力）。
 */
export interface ToolDescriptor {
  capabilityId: string
  version: number
  displayName: string
  description: string
  inputSchema: Record<string, unknown>
}
