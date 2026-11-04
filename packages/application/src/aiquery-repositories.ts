import type { BomLine } from './process-repositories'
import type {
  OrgNodeRepository,
  RoleRepository,
  ScopeGrantRepository,
  UserAccountRepository,
} from './repositories'

/**
 * aiquery 域仓储端口（P4-A 受控问数查询层；应用层定义，persistence 层实现，
 * 依赖方向 persistence → application）。
 *
 * 记录类型与 0021 迁移三表 + 既有读面表（0004/0005/0006/0007/0008/0009）一一对应；
 * 时间字段一律 ISO-8601 字符串；数量字段一律 DecimalString（AQ-REG-09）。
 *
 * 读面白名单在 persistence SELECT 列清单物理落地（AQ-C2/AQ-C3 价格类字段不进列清单，
 * GAP-P5）；AQ-C3 的 timeRange 条件（business_time/confirm_time/raised_at）在本端口
 * 新增（不改既有 quality-queries.ts，capability-contract.md §4）。
 *
 * 注意：本文件未加入 application/src/index.ts 导出（S2 共享文件不可改，L0 整合步统一导出）；
 * persistence 实现以 dist 相对导入消费本端口（先例：shipping-repositories）。
 */

// ---------------- 0021 表记录类型 ----------------

/** AQ-S3：会话身份绑定与审计锚点（只存身份/渠道/状态，不存消息正文）。 */
export interface AiSessionRecord {
  id: string
  enterpriseId: string
  userId: string
  channel: 'web' | 'pda' | 'wecom' | 'feishu' | 'mock'
  conversationRef: string | null
  status: 'open' | 'closed' | 'expired'
  createdAt: string
  lastActiveAt: string
  closedAt: string | null
}

export interface NewAiSession {
  enterpriseId: string
  userId: string
  channel: AiSessionRecord['channel']
  conversationRef?: string | null
}

/** AQ-S1：能力注册行 definition 载荷（§0 字段）。 */
export interface AiCapabilityDefinition {
  displayName: string
  description: string
  inputSchema: Record<string, unknown>
  requiredPermissions: string[]
  allowedObjects: Array<{ table: string; fields: string[] }>
  maxQueryRange: Record<string, unknown>
  /** 口径参数（AQ-C2 requirementBase：'per_unit'/'total'/null=口径未定） */
  caliberParams: Record<string, unknown>
}

export interface AiCapabilityRegistryRecord {
  id: string
  enterpriseId: string
  capabilityId: string
  version: number
  status: 'enabled' | 'disabled'
  definition: AiCapabilityDefinition
  remark: string | null
  createdAt: string
  updatedAt: string
}

export interface NewAiCapabilityRegistryRow {
  enterpriseId: string
  capabilityId: string
  version: number
  status: 'enabled' | 'disabled'
  definition: AiCapabilityDefinition
  remark?: string | null
  createdBy?: string | null
}

/** AQ-S2：执行审计行（脱敏载荷：只存过滤参数与对象引用，不存聊天正文）。 */
export interface AiQueryAuditRecord {
  id: string
  requestId: string
  toolCallSeq: number
  sessionId: string
  capabilityId: string | null
  capabilityVersion: number | null
  userId: string
  enterpriseId: string
  channel: AiSessionRecord['channel']
  params: Record<string, unknown>
  resultStatus: 'ok_with_data' | 'ok_no_records' | 'no_permission' | 'not_supported' | 'source_not_ready' | 'timeout' | 'failed'
  rowCount: number
  truncated: boolean
  durationMs: number
  modelInfo: Record<string, unknown>
  sentResultStatus: 'sent' | 'send_unknown' | 'failed' | 'not_sent' | null
  createdAt: string
}

export interface NewAiQueryAudit {
  requestId: string
  toolCallSeq: number
  sessionId: string
  capabilityId?: string | null
  capabilityVersion?: number | null
  userId: string
  enterpriseId: string
  channel: AiSessionRecord['channel']
  params?: Record<string, unknown>
  resultStatus: AiQueryAuditRecord['resultStatus']
  rowCount?: number
  truncated?: boolean
  durationMs?: number
  modelInfo?: Record<string, unknown>
  sentResultStatus?: AiQueryAuditRecord['sentResultStatus']
}

// ---------------- 0030 表记录类型（P4 五内部接缝补齐，2026-10-30） ----------------

/** apps/ai 运行事件留档行（接缝 4：events.jsonl 经 api 端点持久化）。 */
export interface AiRuntimeEventRecord {
  id: string
  /** 插入序（IDENTITY 单调递增；重启后读回顺序稳定）。 */
  seq: number
  sessionId: string
  enterpriseId: string | null
  userId: string | null
  requestId: string | null
  kind: 'user_message' | 'model_turn' | 'tool_call' | 'clarify' | 'turn_outcome' | 'cancel' | 'session_lifecycle'
  eventAt: string
  event: Record<string, unknown>
  receivedAt: string
}

export interface NewAiRuntimeEvent {
  sessionId: string
  enterpriseId?: string | null
  userId?: string | null
  requestId?: string | null
  kind: AiRuntimeEventRecord['kind']
  eventAt: string
  event: Record<string, unknown>
}

/** 一次性 IM 绑定码行（接缝 5：只存 sha-256 摘要，明文码不落库）。 */
export interface AiImBindingCodeRecord {
  id: string
  enterpriseId: string
  userId: string
  codeHash: string
  status: 'issued' | 'used' | 'revoked' | 'expired'
  issuedAt: string
  expiresAt: string
  usedAt: string | null
  usedChannel: string | null
  usedPlatformUserId: string | null
  revokedAt: string | null
}

export interface NewAiImBindingCode {
  enterpriseId: string
  userId: string
  codeHash: string
  expiresAt: string
}

// ---------------- AQ-C1/C2 读面行类型（白名单列） ----------------

export interface AiOrderRow {
  orderId: string
  enterpriseId: string
  plantId: string
  orderNo: string
  orderType: string | null
  salesContractNo: string | null
  salesOrderNo: string | null
  lineNo: string | null
  materialSnapshot: Record<string, unknown>
  productionQty: string
  uom: string
  orderStatus: string
  processConfigStatus: string
  suspended: boolean
  suspendedReason: string | null
  actualStartAt: string | null
  plannedStartAt: string | null
  plannedFinishAt: string | null
  businessClosedAt: string | null
  erpClosedAt: string | null
  bomRevisionId: string | null
  routeRevisionId: string | null
  currentSettingsVersion: number
  createdAt: string
  updatedAt: string
}

export interface AiOperationRow {
  orderOperationId: string
  seq: number
  operationName: string
  offlineQty: string
  uom: string
  productionDeptId: string
  updatedAt: string
}

export interface AiSlotRow {
  orderOperationId: string
  plannedQty: string
  updatedAt: string
}

export interface AiReportRow {
  id: string
  orderOperationId: string
  operationSeq: number
  status: 'draft' | 'submitted' | 'deleted'
  reviewStatus: 'pending_review' | 'auto_approved' | 'manual_approved'
  reviewCancelledAt: string | null
  updatedAt: string
}

export interface AiOutputRow {
  reportId: string
  quantity: string
  qualifiedQty: string
  stockUnitId: string | null
  updatedAt: string
}

export interface AiBomRevisionRow {
  id: string
  version: number
  lines: BomLine[]
  updatedAt: string
}

export interface AiStockBalanceRow {
  unitId: string
  locationId: string
  qualityHeld: boolean
  businessHeld: boolean
  materialCode: string
  quantity: string
  uomCode: string
  qualityStatus: string
  status: string
  plantId: string
  updatedAt: string
}

export interface AiReservationRow {
  unitId: string
  locationId: string | null
  status: string
  quantity: string
  validUntil: string
}

export interface AiPurchaseLineRow {
  lineId: string
  orderNo: string
  lineNo: number
  materialCode: string
  materialName: string | null
  spec: string | null
  model: string | null
  color: string | null
  uomCode: string
  plannedQty: string
  receivedQty: string
  status: number
  erpClosed: boolean
  plannedReceiptDate: string | null
  firstArrivalDate: string | null
  lastArrivalDate: string | null
  plantId: string
  updatedAt: string
  /** 该行最近收货批次质检状态（六值；无批次为 null，关联展示） */
  latestBatchInspectionStatus: string | null
  latestBatchConfirmTime: string | null
}

// ---------------- AQ-C3 读面行类型（白名单列；价格复核列物理排除） ----------------

export interface AiQualityInspectionOrderRow {
  id: string
  orderNo: string
  sourceType: 'work_report' | 'putaway_receipt'
  inspectionStage: 'process' | 'finished'
  specCode: string
  specVersion: number
  inventoryUnitId: string | null
  unitNo: string | null
  materialCode: string
  quantity: string
  uomCode: string
  productionOrderNo: string | null
  productionDeptName: string | null
  plantId: string
  status: 'pending' | 'in_progress' | 'concluded' | 'cancelled'
  /** 时间过滤列（IT-37 业务侧） */
  businessTime: string
  updatedAt: string
}

export interface AiQualityBatchRow {
  id: string
  batchNo: string
  orderNo: string
  lineNo: number
  materialCode: string
  materialName: string | null
  receivedQty: string
  uomCode: string
  inspectionStatus: string
  storageStatus: 'stored' | 'returned'
  plantId: string
  arrivalTime: string
  /** 时间过滤列（收货确认业务时间） */
  confirmTime: string
}

export interface AiQualityEffectiveResultRow {
  inspectionOrderId: string
  version: number
  conclusion: 'pending' | 'qualified' | 'unqualified'
  resultKind: 'initial' | 'test' | 're_inspection'
  inspector: string | null
  inspectedAt: string | null
}

export interface AiQualityDispositionRow {
  inspectionOrderId: string
  dispositionKind: 'release' | 'concession'
  basedOnVersion: number
  releasedBy: string
  releasedAt: string
  reason: string | null
}

export interface AiQualityHoldRow {
  inventoryUnitId: string
  holdKind: 'pending_inspection' | 'unqualified' | 'suspect'
  status: 'active' | 'released'
  raisedAt: string
  releasedAt: string | null
}

export interface AiQualityBatchDetailSummaryRow {
  batchId: string
  qualityStatus: string
  count: number
}

/** AQ-C3 合并分页项（两族对象按业务时间倒序统一分页）。 */
export interface AiQualityMergedItem {
  family: 'inspection_order' | 'purchase_batch'
  id: string
  basisTime: string
}

// ---------------- 仓储端口 ----------------

export interface AiSessionRepository {
  findById(id: string): Promise<AiSessionRecord | null>
  /**
   * IM 会话四元划分键定位（接缝 1/IM-12）：同一 (user_id, channel, conversation_ref)
   * 的 open 会话复用同一行（最近者优先）；无则由 insert 新建。
   */
  findOpenByTriple(userId: string, channel: AiSessionRecord['channel'], conversationRef: string | null): Promise<AiSessionRecord | null>
  insert(session: NewAiSession): Promise<AiSessionRecord>
  /** 触发活跃时间（每轮 execute 后）。 */
  touch(id: string): Promise<void>
  close(id: string): Promise<AiSessionRecord | null>
}

export interface AiCapabilityRegistryRepository {
  /** 精确版本定位（含 disabled 行——启停判定在服务层，AQ-REG-04）。 */
  find(enterpriseId: string, capabilityId: string, version: number): Promise<AiCapabilityRegistryRecord | null>
  listEnabled(enterpriseId: string): Promise<AiCapabilityRegistryRecord[]>
  insert(row: NewAiCapabilityRegistryRow): Promise<AiCapabilityRegistryRecord>
}

export interface AiQueryAuditRepository {
  insert(audit: NewAiQueryAudit): Promise<AiQueryAuditRecord>
  /** AQ-S2/DS-22 幂等：按 (request_id, tool_call_seq) 找既有审计行。 */
  findByRequestAndSeq(requestId: string, toolCallSeq: number): Promise<AiQueryAuditRecord | null>
  listBySession(sessionId: string): Promise<AiQueryAuditRecord[]>
  /** 同一 requestId 全部审计行（澄清确认轮的下一 toolCallSeq 推导，AR-15 审计链延续）。 */
  listByRequestId(requestId: string): Promise<AiQueryAuditRecord[]>
  /**
   * 发送结果回写（接缝 2/IM-08/AQ-S2）：问数回答发送前/后把 sent_result_status 落到
   * 该 requestId 的全部审计行（not_sent/send_unknown/failed/sent 四值）。返回更新行数。
   */
  recordSendResult(requestId: string, sentResultStatus: AiQueryAuditRecord['sentResultStatus']): Promise<number>
}

/** apps/ai 运行事件留档仓储（接缝 4：apps/ai 经 api 端点转发持久化，重启可查）。 */
export interface AiRuntimeEventRepository {
  append(event: NewAiRuntimeEvent): Promise<AiRuntimeEventRecord>
  listBySession(sessionId: string): Promise<AiRuntimeEventRecord[]>
}

/** 一次性 IM 绑定码仓储（接缝 5/IM-03：网页签发 → IM 端凭码绑定；一次性/有效期/撤销）。 */
export interface AiImBindingCodeRepository {
  insert(row: NewAiImBindingCode): Promise<AiImBindingCodeRecord>
  /**
   * 原子一次性核销：code_hash 命中且 status='issued' 且未过期 → 翻转 used（记录渠道与
   * 平台身份）；否则返回 null（无效/已用/已撤销/已过期）。并发同码只有一个核销成功。
   */
  claimByCodeHash(codeHash: string, usedChannel?: string | null, usedPlatformUserId?: string | null): Promise<AiImBindingCodeRecord | null>
  /** 撤销该用户全部 issued 码（新签发时旧码作废——单活动码语义）。返回撤销行数。 */
  revokeIssuedByUser(userId: string): Promise<number>
  /** 按行撤销（须属该用户且仍 issued）。 */
  revokeById(id: string, userId: string): Promise<boolean>
  listByUser(userId: string): Promise<AiImBindingCodeRecord[]>
}

/**
 * 三能力只读查询端口（AQ-C1/C2/C3 白名单读面；AI 只读红线 AR-R1——本端口无任何写方法）。
 */
export interface AiQueryReadRepository {
  // ---- 订单定位（AQ-AMB-01） ----
  findOrderById(orderId: string, enterpriseId: string): Promise<AiOrderRow | null>
  findOrderByOrderNo(enterpriseId: string, orderNo: string): Promise<AiOrderRow | null>
  /** 模糊单号候选（按 created_at 倒序——production_order 无 business_time 列，最近者锚=created_at）。 */
  listOrdersByOrderNoLike(filter: {
    enterpriseId: string
    pattern: string
    plantIds: string[] | null
    limit: number
  }): Promise<AiOrderRow[]>
  /** 销售单号候选（企业内可多命中）。 */
  listOrdersBySalesOrderNo(filter: {
    enterpriseId: string
    salesOrderNo: string
    plantIds: string[] | null
    limit: number
  }): Promise<AiOrderRow[]>

  // ---- AQ-C1：五量/排程/未完成任务读面 ----
  listCurrentOperations(orderId: string, settingsVersion: number): Promise<AiOperationRow[]>
  listSlotsByOrder(orderId: string): Promise<AiSlotRow[]>
  listReportsByOrder(orderId: string): Promise<AiReportRow[]>
  listOutputsByOrder(orderId: string): Promise<AiOutputRow[]>

  // ---- AQ-C2：BOM/库存/采购在途读面 ----
  findBomRevision(id: string): Promise<AiBomRevisionRow | null>
  listBalancesByMaterialCodes(filter: {
    enterpriseId: string
    plantIds: string[] | null
    materialCodes: string[]
  }): Promise<AiStockBalanceRow[]>
  listActiveReservationsByUnitIds(unitIds: string[]): Promise<AiReservationRow[]>
  listPurchaseLinesByMaterialCodes(filter: {
    enterpriseId: string
    plantIds: string[] | null
    materialCodes: string[]
  }): Promise<AiPurchaseLineRow[]>

  // ---- AQ-C3：质量两族读面（timeRange 条件在本端口新增，不改既有 quality-queries） ----
  /** 两族合并分页（业务时间倒序；conclusions 过滤=检验单生效结论/批次 inspection_status 口径映射）。 */
  listQualityMergedPage(filter: {
    enterpriseId: string
    plantIds: string[] | null
    objectScope: 'inspection_order' | 'purchase_batch' | 'all'
    timeRange: { from: string; to: string }
    conclusions: Array<'qualified' | 'unqualified'>
    inspectionStages: Array<'process' | 'finished'>
    orderNoLike: string | null
    page: { page: number; pageSize: number }
  }): Promise<{ items: AiQualityMergedItem[]; total: number }>
  listInspectionOrdersByIds(ids: string[]): Promise<AiQualityInspectionOrderRow[]>
  listBatchesByIds(ids: string[]): Promise<AiQualityBatchRow[]>
  listEffectiveResultsByOrderIds(inspectionOrderIds: string[]): Promise<AiQualityEffectiveResultRow[]>
  listLatestDispositionsByOrderIds(inspectionOrderIds: string[]): Promise<AiQualityDispositionRow[]>
  /** 活动隔离（quality_hold_active_uidx 同码至多一条活动行；时间列=raised_at）。 */
  listActiveHoldsByUnitIds(unitIds: string[]): Promise<AiQualityHoldRow[]>
  listBatchDetailSummary(batchIds: string[]): Promise<AiQualityBatchDetailSummaryRow[]>
}

/** AQ-AUTH-01 实时重算授权上下文的同源端口（SessionVerifier 同口径：user/org/role/grant）。 */
export interface AiQueryAuthSources {
  users: UserAccountRepository
  org: OrgNodeRepository
  roles: RoleRepository
  grants: ScopeGrantRepository
}

/** aiquery 域仓储集合。 */
export interface AiQueryRepositories {
  sessions: AiSessionRepository
  registry: AiCapabilityRegistryRepository
  audit: AiQueryAuditRepository
  reads: AiQueryReadRepository
  auth: AiQueryAuthSources
  /** 0030：apps/ai 运行事件留档（接缝 4）。 */
  runtimeEvents: AiRuntimeEventRepository
  /** 0030：一次性 IM 绑定码（接缝 5）。 */
  bindingCodes: AiImBindingCodeRepository
}
