/**
 * P4 问数入口 API 层类型（AI 问数·DSH 路数，P4-UI 线新增）。
 *
 * 对齐基准（只读引用，未改动）：
 * - `packages/contracts/src/aiquery.ts`（P4-A 线已落盘的 wire DTO——六段结果信封、
 *   三能力结果 DTO、会话登记 DTO；本文件按其对齐**复制到前端本地**，不直接 import，
 *   防 A 线在途改动与 contracts 桶导出未并〔L0 整合步〕前的解析问题——P2-UI 先例同型）；
 * - `architecture/contracts/frozen/p4/architecture.md`（AR-04：UI 只消费接入层 HTTP 合同、
 *   不直连 apps/ai；AR-11：降级态含原因类别）；
 * - `architecture/contracts/frozen/p4/capability-contract.md` §0/§5（AQ-REG-07 信封六段、
 *   AQ-AMB-01/02/03 澄清）；
 * - `architecture/contracts/frozen/p4/dsh-edge.md` §5（DS-23：outcome 四态
 *   answer|clarify|unavailable|cancelled 经接入层透传；DS-24：unreachable/over_limit/
 *   starting 三类不可用原因透传给 UI 降级态）。
 *
 * 接缝说明（真实接线归 L0）：接入层用户面 `POST /aiquery/sessions` 为 A 线已实现端点
 * （apps/api/src/aiquery/aiquery.controller.ts）；`/aiquery/turns`、`/aiquery/turns/:id/cancel`、
 * `/aiquery/health` 为 UI 按冻结合同形状定义的本地客户端面（接入层转发 apps/ai 的
 * DS-23 四端点），L0 整合时以本文件形状对齐（字段漂移视为合同违约，DS-21 同则）。
 */

/** 十进制数量字符串（AQ-REG-09：≤4 位小数，禁 number；前端一律原样呈现，不做算术） */
export type AiDecimalString = string

/** 分页请求（与 contracts pagination.PageRequest 同形）。 */
export interface AiPageRequest {
  page: number
  pageSize: number
}

// ---------------------------------------------------------------------------
// 结果状态（AQ-REG-07：七值机器态；AI_QUERY_RESULT_STATUS_LABELS 为可理解文案承载）
// ---------------------------------------------------------------------------

export type AiQueryResultStatusDtoValue =
  | 'ok_with_data'
  | 'ok_no_records'
  | 'no_permission'
  | 'not_supported'
  | 'source_not_ready'
  | 'timeout'
  | 'failed'

export const AI_QUERY_RESULT_STATUS_VALUES: readonly AiQueryResultStatusDtoValue[] = [
  'ok_with_data',
  'ok_no_records',
  'no_permission',
  'not_supported',
  'source_not_ready',
  'timeout',
  'failed',
]

/** 状态中文标签（AQ-REG-01：两态/not_supported 等都必须以可理解文案回用户）。 */
export const AI_QUERY_RESULT_STATUS_LABELS: Readonly<Record<AiQueryResultStatusDtoValue, string>> = {
  ok_with_data: '查询成功（有数据）',
  ok_no_records: '查询成功（无匹配记录）',
  no_permission: '无权限执行该问数',
  not_supported: '该问数能力未注册或已停用',
  source_not_ready: '数据源未就绪',
  timeout: '查询超时',
  failed: '查询失败',
}

// ---------------------------------------------------------------------------
// 信封段④ 完整性与时效（AQ-REG-07；未取全不得总结为完整总量）
// ---------------------------------------------------------------------------

export interface AiQueryCompletenessDto {
  /** 结果是否被最大查询范围截断 */
  truncated: boolean
  /** 本次实际取回的行数 */
  fetchedRows: number
  /** 总量是否可知（true=total 为精确计数；false=未取全，不得总结为完整总量） */
  totalKnown: boolean
  /** 满足条件的总行数（totalKnown=false 时为 null） */
  total: number | null
  /** 生效分页（无分页语义的能力为 null） */
  page: AiPageRequest | null
}

export interface AiQueryFreshnessSourceDto {
  /** 来源表名（来源记录引用=真实表名，六段合同③） */
  source: string
  /** 该数据源本次查询涉及行的最新 updated_at（ISO-8601）或 'unknown' */
  updatedAt: string
}

export interface AiQueryFreshnessDto {
  /** 服务端执行时刻（ISO-8601 UTC） */
  queriedAt: string
  sources: AiQueryFreshnessSourceDto[]
}

// ---------------------------------------------------------------------------
// 信封段② 执行上下文回显（AQ-REG-06/AQ-AUTH-03/AQ-AMB-02）
// ---------------------------------------------------------------------------

export interface AiQueryContextEchoDto {
  requestId: string
  toolCallSeq: number
  sessionId: string
  /** 会话绑定的用户/企业（由会话绑定派生，AQ-AUTH-04） */
  userId: string
  enterpriseId: string
  channel: string
  /** 服务端实时重算的数据范围（AQ-AUTH-01/03） */
  dataScope: { enterpriseWide: boolean; plantIds: string[] }
  capabilityId: string
  capabilityVersion: number
  /** 实际生效的过滤条件（含时间范围实际起止回显，AQ-AMB-02） */
  effectiveFilters: Record<string, unknown>
  /** 请求体携带的执行上下文同名字段（被忽略并记审计，AQ-REG-06） */
  ignoredRequestFields: string[]
  /** 事实列提示（AQ-C3：哪些列是判定事实；解释性文字由 AI 生成并标注为推测） */
  factColumns: string[]
  /** 附注（时间默认回显提示、范围截回标注、口径未定等） */
  notes: string[]
}

export interface AiQueryAuditRefDto {
  requestId: string
  toolCallSeq: number
}

// ---------------------------------------------------------------------------
// 信封段③ 数据结果：三能力结果 DTO + 歧义候选（与 contracts/src/aiquery.ts 逐字段对齐）
// ---------------------------------------------------------------------------

/** 生产订单候选（AQ-AMB-01：模糊/销售单号命中多订单时的澄清选项；不自行择一作答）。 */
export interface AiOrderCandidateDto {
  orderId: string
  orderNo: string
  plantId: string
  orderStatus: string
  /** 料品描述（订单 material_snapshot 的 名称/规格/颜色 拼接口径） */
  materialDesc: string
  /** 候选「最近者」锚：production_order 无 business_time 列，以 created_at（ISO-8601）承载 */
  createdAt: string
}

/** 五量（S02/A5-3：分立展示，禁混口径；DecimalString 原样呈现）。 */
export interface AiFiveQuantitiesDto {
  draftQty: AiDecimalString
  submittedQty: AiDecimalString
  approvedQty: AiDecimalString
  qualifiedQty: AiDecimalString
  stockedQty: AiDecimalString
}

/** AQ-C1 结果 DTO（能力：aq.order-progress）。 */
export interface AiOrderProgressResultDto {
  capabilityId: 'aq.order-progress'
  /** 唯一命中时的单订单视图；多候选/无命中为 null */
  order: {
    orderId: string
    plantId: string
    orderNo: string
    orderType: string | null
    salesContractNo: string | null
    salesOrderNo: string | null
    lineNo: string | null
    materialDesc: string
    productionQty: AiDecimalString
    uom: string
    orderStatus: string
    suspended: boolean
    suspendedReason: string | null
    processConfigStatus: string
    bomRevisionId: string | null
    routeRevisionId: string | null
    actualStartAt: string | null
    plannedStartAt: string | null
    plannedFinishAt: string | null
    businessClosedAt: string | null
    erpClosedAt: string | null
    /** 订单级五量合计 */
    totalQuantities: AiFiveQuantitiesDto
    /** 排程完成度（unplanned/partially_scheduled/fully_scheduled，A3-4 投影） */
    schedulingStatus: 'unplanned' | 'partially_scheduled' | 'fully_scheduled'
    /** 当前设置版本工序行（未完成判定=五量与排程事实，不依赖 execution_status，GAP-P9） */
    operations: Array<{
      orderOperationId: string
      seq: number
      operationName: string
      offlineQty: AiDecimalString
      uom: string
      quantities: AiFiveQuantitiesDto
      scheduledQty: AiDecimalString
      fullyScheduled: boolean
      ready: boolean
      readyReason: string
      /** 未完成任务=排程未排完 或 审核通过量为零 的当前版本工序行 */
      incomplete: boolean
    }>
  } | null
  /** 多候选澄清清单（AQ-AMB-01；唯一命中/无命中为空数组） */
  candidates: AiOrderCandidateDto[]
}

/** AQ-C2 采购在途行（价格类字段物理排除在白名单外，GAP-P5）。 */
export interface AiPurchaseInTransitLineDto {
  lineId: string
  orderNo: string
  lineNo: number
  status: number
  statusLabel: string
  plannedQty: AiDecimalString
  receivedQty: AiDecimalString
  /** 在途量 = planned_qty − received_qty（仅 status ∈ {0,1,2} 且 erp_closed=false） */
  inTransitQty: AiDecimalString
  erpClosed: boolean
  plannedReceiptDate: string | null
  firstArrivalDate: string | null
  lastArrivalDate: string | null
  uomCode: string
  /** 该行最近收货批次的质检状态（六值；关联展示） */
  latestBatchInspectionStatus: string | null
  latestBatchInspectionStatusLabel: string | null
}

/** AQ-C2 单料品并排行（BOM 需求 vs 可用量 vs 采购在途）。 */
export interface AiMaterialShortageLineDto {
  materialId: string
  materialCode: string
  /** 料品名称/规格/型号/颜色（purchase_order_line 快照列；无采购行时为 null） */
  materialName: string | null
  spec: string | null
  model: string | null
  color: string | null
  /** BOM 行数量原文（基数语义未冻结，GAP-P4） */
  bomQuantity: AiDecimalString
  uom: string
  /** 口径参数 requirementBase：'per_unit'（×production_qty）/'total'/null（未配置=口径未定） */
  requirementBase: 'per_unit' | 'total' | null
  /** 折算后需求量（requirementBase 已配置且单位一致时给出；否则 null） */
  requiredQty: AiDecimalString | null
  /** 可用量三段（IT-14：合格 ∧ 减有效预留；同料品跨余额行汇总） */
  availability: { grossQty: AiDecimalString; reservedQty: AiDecimalString; availableQty: AiDecimalString }
  /** 采购在途合计（匹配键=plant 内 material_code） */
  inTransitQty: AiDecimalString
  /** 缺口数值（requirementBase 已配置且单位一致时给出；否则 null——首版固定「口径未定」） */
  shortageQty: AiDecimalString | null
  /** 缺口列标注：口径未定（GAP-P4）/ 单位不一致未折算 / null（已给出数值） */
  shortageNote: string | null
  /** 三源 uom 不一致（BOM/库存/采购）时不折算、不汇总结论，逐行标注 */
  uomMismatch: boolean
  uomSources: { bom: string; stock: string | null; purchase: string | null }
  purchaseLines: AiPurchaseInTransitLineDto[]
}

/** AQ-C2 结果 DTO（能力：aq.material-shortage）。 */
export interface AiMaterialShortageResultDto {
  capabilityId: 'aq.material-shortage'
  orderId: string | null
  orderNo: string | null
  /** 订单未冻结 BOM（bom_revision_id 为 null）时为 null（ok_no_records + 附注，不视为缺料为零） */
  bomRevisionId: string | null
  bomRevisionVersion: number | null
  /** 口径参数回显（requirementBase 未配置=口径未定，AQ-AMB-03） */
  requirementBase: 'per_unit' | 'total' | null
  lines: AiMaterialShortageLineDto[]
  /** 多候选澄清清单（AQ-AMB-01；唯一命中/无命中为空数组） */
  candidates: AiOrderCandidateDto[]
}

/** AQ-C3 检验单族行（过程/成品检验单：判定/状态/处置事实，无原因推测列）。 */
export interface AiQualityInspectionRowDto {
  family: 'inspection_order'
  id: string
  orderNo: string
  sourceType: 'work_report' | 'putaway_receipt'
  inspectionStage: 'process' | 'finished'
  specCode: string
  specVersion: number
  unitNo: string | null
  materialCode: string
  quantity: AiDecimalString
  uomCode: string
  productionOrderNo: string | null
  productionDeptName: string | null
  plantId: string
  status: 'pending' | 'in_progress' | 'concluded' | 'cancelled'
  statusLabel: string
  /** 业务时间（IT-37 业务侧；时间过滤列） */
  businessTime: string
  /** 生效结论（当前 is_effective 行；历史版本行不混作当前判定，S14） */
  effectiveConclusion: {
    version: number
    conclusion: 'pending' | 'qualified' | 'unqualified'
    resultKind: 'initial' | 'test' | 're_inspection'
    inspector: string | null
    inspectedAt: string | null
  } | null
  /** 最新处置记录（放行/让步；让步保留原不合格事实） */
  latestDisposition: {
    dispositionKind: 'release' | 'concession'
    basedOnVersion: number
    releasedBy: string
    releasedAt: string
    reason: string | null
  } | null
  /** 活动隔离（同码至多一条；处置/判定/隔离三者并排不互相覆盖） */
  activeHold: { holdKind: string; holdKindLabel: string; raisedAt: string } | null
}

/** AQ-C3 来料批次族行（价格复核列与外发同步状态列不入结果，GAP-P5）。 */
export interface AiQualityBatchRowDto {
  family: 'purchase_batch'
  id: string
  batchNo: string
  orderNo: string
  lineNo: number
  materialCode: string
  materialName: string | null
  receivedQty: AiDecimalString
  uomCode: string
  inspectionStatus: string
  inspectionStatusLabel: string
  storageStatus: 'stored' | 'returned'
  plantId: string
  arrivalTime: string
  /** 收货确认业务时间（时间过滤列） */
  confirmTime: string
  /** 收货明细质量状态汇总（receipt_detail.quality_status 五值计数） */
  detailQualitySummary: Array<{ qualityStatus: string; qualityStatusLabel: string; count: number }>
}

/** AQ-C3 结果 DTO（能力：aq.quality）。 */
export interface AiQualityResultDto {
  capabilityId: 'aq.quality'
  /** 实际生效时间范围与过滤列（AQ-AMB-02 默认最近 7 个自然日 Asia/Shanghai 时回显） */
  timeRange: { from: string; to: string; defaultApplied: boolean }
  objectScope: 'inspection_order' | 'purchase_batch' | 'all'
  inspectionOrders: AiQualityInspectionRowDto[]
  purchaseBatches: AiQualityBatchRowDto[]
}

/** 三能力结果 DTO 联合（信封 data 承载位）。 */
export type AiQueryCapabilityResultDto =
  | AiOrderProgressResultDto
  | AiMaterialShortageResultDto
  | AiQualityResultDto

// ---------------------------------------------------------------------------
// 六段结果信封（AQ-REG-07）
// ---------------------------------------------------------------------------

/** 受控查询结果信封（wire 固定六段 + 可理解文案）。 */
export interface AiQueryEnvelopeDto {
  status: AiQueryResultStatusDtoValue
  /** 状态中文标签 */
  statusLabel: string
  /** 可理解文案（规则码 [AQ-xx-x] 承载位；不得以空数据冒充两态，AQ-REG-01） */
  message: string
  /** 能力结果 DTO（非数据态为 null） */
  data: AiQueryCapabilityResultDto | null
  completeness: AiQueryCompletenessDto
  freshness: AiQueryFreshnessDto
  contextEcho: AiQueryContextEchoDto
  auditRef: AiQueryAuditRefDto
}

// ---------------------------------------------------------------------------
// 会话登记（A 线已实现：POST /aiquery/sessions，用户令牌 + aiquery.use）
// ---------------------------------------------------------------------------

export interface AiSessionOpenRequestDto {
  channel: 'web' | 'pda' | 'wecom' | 'feishu' | 'mock'
  /** IM 会话目标标识或 web 会话标识（可空） */
  conversationRef?: string | null
}

export interface AiSessionOpenResponseDto {
  sessionId: string
  enterpriseId: string
  userId: string
  channel: string
  status: string
}

// ---------------------------------------------------------------------------
// 问数轮（DS-23 outcome 四态经接入层透传；UI 本地客户端面，L0 接线对齐点）
// ---------------------------------------------------------------------------

/** 问数轮请求（UI → 接入层）。 */
export interface AiAskTurnRequestDto {
  /** 接入层生成的全局唯一轮次标识（AR-15 requestId 审计链锚点）。
   * UI 预生成 UUID 仅为在途取消关联（DS-11）；服务端以回执 requestId 为准
   * （AQ-REG-06：执行上下文一律以服务端绑定为准）。 */
  requestId: string
  sessionId: string
  /** 用户提问文本（澄清答复轮可为空——由 clarifyOptionId 承载选择） */
  userMessage: string
  /** 澄清选项答复（AQ-AMB-01：用户选择后带精确参数重发；只传选项 id，参数由服务端绑定） */
  clarifyOptionId?: string | null
}

/** 澄清选项（DS-08：选项来自能力结果结构化 options[]，不由模型/前端编造。
 * 形状对齐 P4-B 交付记录 §5 clarificationOptions 样例：{id,label,detail,confirm}，
 * kind 为 UI 呈现分类增补字段）。 */
export interface AiClarifyOptionDto {
  id: string
  /** 呈现分类（UI 增补：重名订单候选 / 时间范围确认 / 口径选择） */
  kind?: 'order_candidate' | 'time_range' | 'caliber' | string
  label: string
  /** 结构化补充信息（订单号/工厂/状态/料品/时间起止等） */
  detail?: Record<string, string> | null
  /** 选择后的精确重发参数（服务端绑定承载；UI 不改写） */
  confirm?: { capabilityId: string; params: Record<string, unknown> } | null
}

/** 问数轮 outcome 四态（DS-23：answer | clarify | unavailable | cancelled）。 */
export type AiAskTurnOutcomeDtoValue = 'answer' | 'clarify' | 'unavailable' | 'cancelled'

export const AI_ASK_TURN_OUTCOME_LABELS: Readonly<Record<AiAskTurnOutcomeDtoValue, string>> = {
  answer: '已回答',
  clarify: '需要澄清',
  unavailable: '暂不可用',
  cancelled: '已取消',
}

/** AI 服务不可用原因类别（AR-11/DS-24：unreachable/over_limit/starting 三类透传）。 */
export type AiUnavailableReasonDtoValue = 'unreachable' | 'over_limit' | 'starting'

export const AI_UNAVAILABLE_REASON_LABELS: Readonly<Record<AiUnavailableReasonDtoValue, string>> = {
  unreachable: 'AI 服务不可达',
  over_limit: '已超出 AI 问数使用限额',
  starting: 'AI 服务正在启动，请稍候',
}

/** 问数轮响应（接入层 → UI；DS-23 形状 + 信封/选项/不可用原因承载）。 */
export interface AiAskTurnResponseDto {
  requestId: string
  outcome: AiAskTurnOutcomeDtoValue
  /** 可理解文案（answer=AI 解释文字〔标注「解释非事实」由 UI 呈现层区分〕；cancelled=阶段摘要） */
  message: string
  /** outcome=answer / unavailable(部分数据) 时携带六段信封；clarify/cancelled 为 null */
  envelope: AiQueryEnvelopeDto | null
  /** outcome=clarify 时的结构化选项（AQ-AMB-01/02/03） */
  options: AiClarifyOptionDto[] | null
  /** outcome=unavailable 时的原因类别（AR-11）；无类别为 null（如接入层自身故障 AR-14） */
  unavailableReason: AiUnavailableReasonDtoValue | null
  /** 阶段细节（超时 scope/已用工具次数等；呈现为附注，不作主文案） */
  statusDetail: Record<string, unknown> | null
}

/** 取消轮次响应（DS-11：终态 cancelled）。 */
export interface AiAskCancelResponseDto {
  status: 'cancelled'
  decision?: 'cancelled_in_flight' | 'already_finished' | 'unknown_request' | string
}

// ---------------------------------------------------------------------------
// 健康探测（AR-03：经接入层代理面，不直连 apps/ai 端口；AR-11 降级判定源）
// ---------------------------------------------------------------------------

export type AiQueryHealthResponseDto =
  | { status: 'ok'; runtime?: Record<string, unknown> | null }
  | { status: 'unavailable'; reason: AiUnavailableReasonDtoValue; message: string }
