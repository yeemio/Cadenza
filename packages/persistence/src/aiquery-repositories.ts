// 跨包类型导入（type-only，编译期擦除）：指向 application 已构建的 dist（构建顺序由 workspace
// 拓扑保证：persistence 依赖 application，pnpm -r 先构建后者）。不得相对引用 application/src/**
// （TS6059：各包 tsconfig.build.json 置空 paths 且限 rootDir=src）。aiquery 端口尚未并入
// @cadenza/application 包名入口（application/src/index.ts 为共享文件不改动），故走 dist 相对；
// L0 整合步把端口导出并入 application index、本文件导出并入 persistence index 后改包名导入
// （同 purchase/quality/warehousing/shipping 先例）。
import type {
  AiCapabilityDefinition,
  AiCapabilityRegistryRecord,
  AiCapabilityRegistryRepository,
  AiImBindingCodeRecord,
  AiImBindingCodeRepository,
  NewAiImBindingCode,
  AiOrderRow,
  AiQualityBatchDetailSummaryRow,
  AiQualityBatchRow,
  AiQualityDispositionRow,
  AiQualityEffectiveResultRow,
  AiQualityHoldRow,
  AiQualityInspectionOrderRow,
  AiQualityMergedItem,
  AiQueryAuditRecord,
  AiQueryAuditRepository,
  AiQueryAuthSources,
  AiQueryReadRepository,
  AiQueryRepositories,
  AiRuntimeEventRecord,
  AiRuntimeEventRepository,
  NewAiRuntimeEvent,
  AiSessionRecord,
  AiSessionRepository,
  NewAiCapabilityRegistryRow,
  NewAiQueryAudit,
  NewAiSession,
} from '@cadenza/application'
import {
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
} from './repositories'
import type { SqlClient } from './sql-client'

/**
 * aiquery 域仓储的 PostgreSQL 实现（P4-A 受控问数查询层；implements application 端口）。
 *
 * - 全部参数化查询；numeric(18,4) 以字符串往返（定点保真，AQ-REG-09）；
 * - timestamptz 出参 ISO-8601 字符串；date 出参 YYYY-MM-DD；jsonb 由 pg 驱动解析；
 * - 读面 SELECT 列清单即白名单（AQ-C2/AQ-C3 价格类字段物理排除，GAP-P5）；
 * - AQ-C3 timeRange 条件在本文件新增（检验单 business_time / 批次 confirm_time /
 *   隔离 raised_at），不改既有 quality-queries.ts（capability-contract.md §4）；
 * - 只读红线（AR-R1）：除 0021 三表（注册/审计/会话）外无任何写方法。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

function dayOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(value).slice(0, 10)
}

// ---------------- ai_session（AQ-S3） ----------------

const SESSION_COLUMNS = `id, enterprise_id, user_id, channel, conversation_ref, status, created_at, last_active_at, closed_at`

interface SessionRow {
  id: string
  enterprise_id: string
  user_id: string
  channel: AiSessionRecord['channel']
  conversation_ref: string | null
  status: AiSessionRecord['status']
  created_at: Date | string
  last_active_at: Date | string
  closed_at: Date | string | null
}

function mapSession(r: SessionRow): AiSessionRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    userId: r.user_id,
    channel: r.channel,
    conversationRef: r.conversation_ref,
    status: r.status,
    createdAt: iso(r.created_at),
    lastActiveAt: iso(r.last_active_at),
    closedAt: isoOrNull(r.closed_at),
  }
}

export class PgAiSessionRepository implements AiSessionRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<AiSessionRecord | null> {
    const r = await this.client.query(`SELECT ${SESSION_COLUMNS} FROM ai_session WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapSession(r.rows[0] as SessionRow)
  }

  async findOpenByTriple(userId: string, channel: AiSessionRecord['channel'], conversationRef: string | null): Promise<AiSessionRecord | null> {
    // IM-12 四元划分键（租户由 user 隐含）：open 会话最近者优先复用
    const r = await this.client.query(
      `SELECT ${SESSION_COLUMNS} FROM ai_session
       WHERE user_id = $1 AND channel = $2 AND conversation_ref IS NOT DISTINCT FROM $3 AND status = 'open'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId, channel, conversationRef],
    )
    return r.rows[0] === undefined ? null : mapSession(r.rows[0] as SessionRow)
  }

  async insert(session: NewAiSession): Promise<AiSessionRecord> {
    const r = await this.client.query(
      `INSERT INTO ai_session (enterprise_id, user_id, channel, conversation_ref)
       VALUES ($1, $2, $3, $4) RETURNING ${SESSION_COLUMNS}`,
      [session.enterpriseId, session.userId, session.channel, session.conversationRef ?? null],
    )
    return mapSession(r.rows[0] as SessionRow)
  }

  async touch(id: string): Promise<void> {
    await this.client.query(`UPDATE ai_session SET last_active_at = now() WHERE id = $1`, [id])
  }

  async close(id: string): Promise<AiSessionRecord | null> {
    const r = await this.client.query(
      `UPDATE ai_session SET status = 'closed', closed_at = now(), last_active_at = now()
       WHERE id = $1 AND status = 'open' RETURNING ${SESSION_COLUMNS}`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapSession(r.rows[0] as SessionRow)
  }
}

// ---------------- ai_capability_registry（AQ-S1） ----------------

const REGISTRY_COLUMNS = `id, enterprise_id, capability_id, version, status, definition, remark, created_at, updated_at`

interface RegistryRow {
  id: string
  enterprise_id: string
  capability_id: string
  version: number
  status: 'enabled' | 'disabled'
  definition: unknown
  remark: string | null
  created_at: Date | string
  updated_at: Date | string
}

function mapRegistry(r: RegistryRow): AiCapabilityRegistryRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    capabilityId: r.capability_id,
    version: r.version,
    status: r.status,
    definition: r.definition as AiCapabilityDefinition,
    remark: r.remark,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

export class PgAiCapabilityRegistryRepository implements AiCapabilityRegistryRepository {
  constructor(private readonly client: SqlClient) {}

  async find(enterpriseId: string, capabilityId: string, version: number): Promise<AiCapabilityRegistryRecord | null> {
    const r = await this.client.query(
      `SELECT ${REGISTRY_COLUMNS} FROM ai_capability_registry
       WHERE enterprise_id = $1 AND capability_id = $2 AND version = $3`,
      [enterpriseId, capabilityId, version],
    )
    return r.rows[0] === undefined ? null : mapRegistry(r.rows[0] as RegistryRow)
  }

  async listEnabled(enterpriseId: string): Promise<AiCapabilityRegistryRecord[]> {
    const r = await this.client.query(
      `SELECT ${REGISTRY_COLUMNS} FROM ai_capability_registry
       WHERE enterprise_id = $1 AND status = 'enabled' ORDER BY capability_id, version`,
      [enterpriseId],
    )
    return (r.rows as unknown as RegistryRow[]).map(mapRegistry)
  }

  async insert(row: NewAiCapabilityRegistryRow): Promise<AiCapabilityRegistryRecord> {
    const r = await this.client.query(
      `INSERT INTO ai_capability_registry (enterprise_id, capability_id, version, status, definition, remark, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING ${REGISTRY_COLUMNS}`,
      [
        row.enterpriseId,
        row.capabilityId,
        row.version,
        row.status,
        JSON.stringify(row.definition),
        row.remark ?? null,
        row.createdBy ?? null,
      ],
    )
    return mapRegistry(r.rows[0] as RegistryRow)
  }
}

// ---------------- ai_query_audit（AQ-S2） ----------------

const AUDIT_COLUMNS = `id, request_id, tool_call_seq, session_id, capability_id, capability_version,
  user_id, enterprise_id, channel, params, result_status, row_count, truncated, duration_ms,
  model_info, sent_result_status, created_at`

interface AuditRow {
  id: string
  request_id: string
  tool_call_seq: number
  session_id: string
  capability_id: string | null
  capability_version: number | null
  user_id: string
  enterprise_id: string
  channel: AiSessionRecord['channel']
  params: unknown
  result_status: AiQueryAuditRecord['resultStatus']
  row_count: number
  truncated: boolean
  duration_ms: number
  model_info: unknown
  sent_result_status: AiQueryAuditRecord['sentResultStatus']
  created_at: Date | string
}

function mapAudit(r: AuditRow): AiQueryAuditRecord {
  return {
    id: r.id,
    requestId: r.request_id,
    toolCallSeq: r.tool_call_seq,
    sessionId: r.session_id,
    capabilityId: r.capability_id,
    capabilityVersion: r.capability_version,
    userId: r.user_id,
    enterpriseId: r.enterprise_id,
    channel: r.channel,
    params: (r.params ?? {}) as Record<string, unknown>,
    resultStatus: r.result_status,
    rowCount: r.row_count,
    truncated: r.truncated,
    durationMs: r.duration_ms,
    modelInfo: (r.model_info ?? {}) as Record<string, unknown>,
    sentResultStatus: r.sent_result_status,
    createdAt: iso(r.created_at),
  }
}

export class PgAiQueryAuditRepository implements AiQueryAuditRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(audit: NewAiQueryAudit): Promise<AiQueryAuditRecord> {
    const r = await this.client.query(
      `INSERT INTO ai_query_audit (request_id, tool_call_seq, session_id, capability_id, capability_version,
         user_id, enterprise_id, channel, params, result_status, row_count, truncated, duration_ms,
         model_info, sent_result_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb,$15)
       RETURNING ${AUDIT_COLUMNS}`,
      [
        audit.requestId,
        audit.toolCallSeq,
        audit.sessionId,
        audit.capabilityId ?? null,
        audit.capabilityVersion ?? null,
        audit.userId,
        audit.enterpriseId,
        audit.channel,
        JSON.stringify(audit.params ?? {}),
        audit.resultStatus,
        audit.rowCount ?? 0,
        audit.truncated ?? false,
        audit.durationMs ?? 0,
        // AR-16：用量未知如实标记 'unknown' 字面（jsonb），不估数
        audit.modelInfo === undefined ? '"unknown"' : JSON.stringify(audit.modelInfo),
        audit.sentResultStatus ?? null,
      ],
    )
    return mapAudit(r.rows[0] as AuditRow)
  }

  async findByRequestAndSeq(requestId: string, toolCallSeq: number): Promise<AiQueryAuditRecord | null> {
    const r = await this.client.query(
      `SELECT ${AUDIT_COLUMNS} FROM ai_query_audit WHERE request_id = $1 AND tool_call_seq = $2`,
      [requestId, toolCallSeq],
    )
    return r.rows[0] === undefined ? null : mapAudit(r.rows[0] as AuditRow)
  }

  async listBySession(sessionId: string): Promise<AiQueryAuditRecord[]> {
    const r = await this.client.query(
      `SELECT ${AUDIT_COLUMNS} FROM ai_query_audit WHERE session_id = $1 ORDER BY created_at, tool_call_seq`,
      [sessionId],
    )
    return (r.rows as unknown as AuditRow[]).map(mapAudit)
  }

  async listByRequestId(requestId: string): Promise<AiQueryAuditRecord[]> {
    const r = await this.client.query(
      `SELECT ${AUDIT_COLUMNS} FROM ai_query_audit WHERE request_id = $1 ORDER BY tool_call_seq`,
      [requestId],
    )
    return (r.rows as unknown as AuditRow[]).map(mapAudit)
  }

  async recordSendResult(requestId: string, sentResultStatus: AiQueryAuditRecord['sentResultStatus']): Promise<number> {
    const r = await this.client.query(
      `UPDATE ai_query_audit SET sent_result_status = $1 WHERE request_id = $2`,
      [sentResultStatus, requestId],
    )
    return r.rowCount ?? 0
  }
}

// ---------------- ai_runtime_event（0030；接缝 4：apps/ai 运行事件留档） ----------------

const RUNTIME_EVENT_COLUMNS = `id, seq, session_id, enterprise_id, user_id, request_id, kind, event_at, event, received_at`

interface RuntimeEventRow {
  id: string
  seq: string | number
  session_id: string
  enterprise_id: string | null
  user_id: string | null
  request_id: string | null
  kind: AiRuntimeEventRecord['kind']
  event_at: Date | string
  event: unknown
  received_at: Date | string
}

function mapRuntimeEvent(r: RuntimeEventRow): AiRuntimeEventRecord {
  return {
    id: r.id,
    seq: typeof r.seq === 'string' ? Number(r.seq) : r.seq,
    sessionId: r.session_id,
    enterpriseId: r.enterprise_id,
    userId: r.user_id,
    requestId: r.request_id,
    kind: r.kind,
    eventAt: iso(r.event_at),
    event: (r.event ?? {}) as Record<string, unknown>,
    receivedAt: iso(r.received_at),
  }
}

export class PgAiRuntimeEventRepository implements AiRuntimeEventRepository {
  constructor(private readonly client: SqlClient) {}

  async append(event: NewAiRuntimeEvent): Promise<AiRuntimeEventRecord> {
    const r = await this.client.query(
      `INSERT INTO ai_runtime_event (session_id, enterprise_id, user_id, request_id, kind, event_at, event)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)
       RETURNING ${RUNTIME_EVENT_COLUMNS}`,
      [
        event.sessionId,
        event.enterpriseId ?? null,
        event.userId ?? null,
        event.requestId ?? null,
        event.kind,
        event.eventAt,
        JSON.stringify(runtimeEventState(event)),
      ],
    )
    return mapRuntimeEvent(r.rows[0] as RuntimeEventRow)
  }

  async listBySession(sessionId: string): Promise<AiRuntimeEventRecord[]> {
    const r = await this.client.query(
      `SELECT ${RUNTIME_EVENT_COLUMNS} FROM ai_runtime_event WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    )
    return (r.rows as unknown as RuntimeEventRow[]).map(mapRuntimeEvent)
  }
}

// ---------------- ai_im_binding_code（0030；接缝 5：一次性绑定码） ----------------

const BINDING_CODE_COLUMNS = `id, enterprise_id, user_id, code_hash, status, issued_at, expires_at, used_at,
  used_channel, used_platform_user_id, revoked_at`

interface BindingCodeRow {
  id: string
  enterprise_id: string
  user_id: string
  code_hash: string
  status: 'issued' | 'used' | 'revoked' | 'expired'
  issued_at: Date | string
  expires_at: Date | string
  used_at: Date | string | null
  used_channel: string | null
  used_platform_user_id: string | null
  revoked_at: Date | string | null
}

function mapBindingCode(r: BindingCodeRow): AiImBindingCodeRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    userId: r.user_id,
    codeHash: r.code_hash,
    status: r.status,
    issuedAt: iso(r.issued_at),
    expiresAt: iso(r.expires_at),
    usedAt: isoOrNull(r.used_at),
    usedChannel: r.used_channel,
    usedPlatformUserId: r.used_platform_user_id,
    revokedAt: isoOrNull(r.revoked_at),
  }
}

export class PgAiImBindingCodeRepository implements AiImBindingCodeRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(row: NewAiImBindingCode): Promise<AiImBindingCodeRecord> {
    const r = await this.client.query(
      `INSERT INTO ai_im_binding_code (enterprise_id, user_id, code_hash, expires_at)
       VALUES ($1, $2, $3, $4::timestamptz) RETURNING ${BINDING_CODE_COLUMNS}`,
      [row.enterpriseId, row.userId, row.codeHash, row.expiresAt],
    )
    return mapBindingCode(r.rows[0] as BindingCodeRow)
  }

  async claimByCodeHash(codeHash: string, usedChannel?: string | null, usedPlatformUserId?: string | null): Promise<AiImBindingCodeRecord | null> {
    // 原子一次性核销：issued 且未过期才翻转 used；并发同码只有一个成功
    const r = await this.client.query(
      `UPDATE ai_im_binding_code SET status = 'used', used_at = now(),
         used_channel = $2, used_platform_user_id = $3
       WHERE code_hash = $1 AND status = 'issued' AND expires_at > now()
       RETURNING ${BINDING_CODE_COLUMNS}`,
      [codeHash, usedChannel ?? null, usedPlatformUserId ?? null],
    )
    return r.rows[0] === undefined ? null : mapBindingCode(r.rows[0] as BindingCodeRow)
  }

  async revokeIssuedByUser(userId: string): Promise<number> {
    const r = await this.client.query(
      `UPDATE ai_im_binding_code SET status = 'revoked', revoked_at = now()
       WHERE user_id = $1 AND status = 'issued'`,
      [userId],
    )
    return r.rowCount ?? 0
  }

  async revokeById(id: string, userId: string): Promise<boolean> {
    const r = await this.client.query(
      `UPDATE ai_im_binding_code SET status = 'revoked', revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'issued'`,
      [id, userId],
    )
    return (r.rowCount ?? 0) > 0
  }

  async listByUser(userId: string): Promise<AiImBindingCodeRecord[]> {
    const r = await this.client.query(
      `SELECT ${BINDING_CODE_COLUMNS} FROM ai_im_binding_code WHERE user_id = $1 ORDER BY issued_at DESC`,
      [userId],
    )
    return (r.rows as unknown as BindingCodeRow[]).map(mapBindingCode)
  }
}

// ---------------- 三能力只读查询（AQ-C1/C2/C3 白名单读面） ----------------

/** 生产订单白名单列（§2；不含操作工个人维度报工明细）。 */
const ORDER_COLUMNS = `id AS order_id, enterprise_id, plant_id, order_no, order_type, sales_contract_no,
  sales_order_no, line_no, material_snapshot, production_qty::text AS production_qty, uom,
  order_status, process_config_status, suspended, suspended_reason, actual_start_at, planned_start_at,
  planned_finish_at, business_closed_at, erp_closed_at, bom_revision_id, route_revision_id,
  current_settings_version, created_at, updated_at`

interface OrderRowRaw {
  order_id: string
  enterprise_id: string
  plant_id: string
  order_no: string
  order_type: string | null
  sales_contract_no: string | null
  sales_order_no: string | null
  line_no: string | null
  material_snapshot: Record<string, unknown>
  production_qty: string
  uom: string
  order_status: string
  process_config_status: string
  suspended: boolean
  suspended_reason: string | null
  actual_start_at: Date | string | null
  planned_start_at: Date | string | null
  planned_finish_at: Date | string | null
  business_closed_at: Date | string | null
  erp_closed_at: Date | string | null
  bom_revision_id: string | null
  route_revision_id: string | null
  current_settings_version: number
  created_at: Date | string
  updated_at: Date | string
}

function mapOrder(r: OrderRowRaw): AiOrderRow {
  return {
    orderId: r.order_id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    orderNo: r.order_no,
    orderType: r.order_type,
    salesContractNo: r.sales_contract_no,
    salesOrderNo: r.sales_order_no,
    lineNo: r.line_no,
    materialSnapshot: r.material_snapshot ?? {},
    productionQty: r.production_qty,
    uom: r.uom,
    orderStatus: r.order_status,
    processConfigStatus: r.process_config_status,
    suspended: r.suspended,
    suspendedReason: r.suspended_reason,
    actualStartAt: isoOrNull(r.actual_start_at),
    plannedStartAt: isoOrNull(r.planned_start_at),
    plannedFinishAt: isoOrNull(r.planned_finish_at),
    businessClosedAt: isoOrNull(r.business_closed_at),
    erpClosedAt: isoOrNull(r.erp_closed_at),
    bomRevisionId: r.bom_revision_id,
    routeRevisionId: r.route_revision_id,
    currentSettingsVersion: r.current_settings_version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

interface BomLineRaw {
  materialId: string
  materialCode: string
  quantity: string
  uom: string
}

export class PgAiQueryReadRepository implements AiQueryReadRepository {
  constructor(private readonly client: SqlClient) {}

  // ---- 订单定位（AQ-AMB-01） ----

  async findOrderById(orderId: string, enterpriseId: string) {
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM production_order WHERE id = $1 AND enterprise_id = $2`,
      [orderId, enterpriseId],
    )
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRowRaw)
  }

  async findOrderByOrderNo(enterpriseId: string, orderNo: string) {
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM production_order WHERE enterprise_id = $1 AND order_no = $2`,
      [enterpriseId, orderNo],
    )
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRowRaw)
  }

  async listOrdersByOrderNoLike(filter: {
    enterpriseId: string
    pattern: string
    plantIds: string[] | null
    limit: number
  }) {
    const conds = ['enterprise_id = $1', 'order_no LIKE $2']
    const params: unknown[] = [filter.enterpriseId, `%${filter.pattern}%`]
    if (filter.plantIds !== null) {
      params.push(filter.plantIds)
      conds.push(`plant_id = ANY($${params.length}::uuid[])`)
    }
    params.push(filter.limit)
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM production_order WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC, order_no DESC LIMIT $${params.length}`,
      params,
    )
    return (r.rows as unknown as OrderRowRaw[]).map(mapOrder)
  }

  async listOrdersBySalesOrderNo(filter: {
    enterpriseId: string
    salesOrderNo: string
    plantIds: string[] | null
    limit: number
  }) {
    const conds = ['enterprise_id = $1', 'sales_order_no = $2']
    const params: unknown[] = [filter.enterpriseId, filter.salesOrderNo]
    if (filter.plantIds !== null) {
      params.push(filter.plantIds)
      conds.push(`plant_id = ANY($${params.length}::uuid[])`)
    }
    params.push(filter.limit)
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM production_order WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC, order_no DESC LIMIT $${params.length}`,
      params,
    )
    return (r.rows as unknown as OrderRowRaw[]).map(mapOrder)
  }

  // ---- AQ-C1：五量/排程/未完成任务读面 ----

  async listCurrentOperations(orderId: string, settingsVersion: number) {
    const r = await this.client.query(
      `SELECT id AS order_operation_id, seq, operation_name, offline_qty::text AS offline_qty, uom,
         production_dept_id, updated_at
       FROM order_operation WHERE order_id = $1 AND settings_version = $2 ORDER BY seq`,
      [orderId, settingsVersion],
    )
    return (
      r.rows as unknown as Array<{
        order_operation_id: string
        seq: number
        operation_name: string
        offline_qty: string
        uom: string
        production_dept_id: string
        updated_at: Date | string
      }>
    ).map((row) => ({
      orderOperationId: row.order_operation_id,
      seq: row.seq,
      operationName: row.operation_name,
      offlineQty: row.offline_qty,
      uom: row.uom,
      productionDeptId: row.production_dept_id,
      updatedAt: iso(row.updated_at),
    }))
  }

  async listSlotsByOrder(orderId: string) {
    const r = await this.client.query(
      `SELECT order_operation_id, planned_qty::text AS planned_qty, updated_at
       FROM schedule_slot WHERE order_id = $1`,
      [orderId],
    )
    return (
      r.rows as unknown as Array<{ order_operation_id: string; planned_qty: string; updated_at: Date | string }>
    ).map((row) => ({
      orderOperationId: row.order_operation_id,
      plannedQty: row.planned_qty,
      updatedAt: iso(row.updated_at),
    }))
  }

  async listReportsByOrder(orderId: string) {
    const r = await this.client.query(
      `SELECT id, order_operation_id, operation_seq, status, review_status, review_cancelled_at, updated_at
       FROM production_report WHERE order_id = $1`,
      [orderId],
    )
    return (
      r.rows as unknown as Array<{
        id: string
        order_operation_id: string
        operation_seq: number
        status: 'draft' | 'submitted' | 'deleted'
        review_status: 'pending_review' | 'auto_approved' | 'manual_approved'
        review_cancelled_at: Date | string | null
        updated_at: Date | string
      }>
    ).map((row) => ({
      id: row.id,
      orderOperationId: row.order_operation_id,
      operationSeq: row.operation_seq,
      status: row.status,
      reviewStatus: row.review_status,
      reviewCancelledAt: isoOrNull(row.review_cancelled_at),
      updatedAt: iso(row.updated_at),
    }))
  }

  async listOutputsByOrder(orderId: string) {
    const r = await this.client.query(
      `SELECT ro.report_id, ro.quantity::text AS quantity, ro.qualified_qty::text AS qualified_qty,
         ro.stock_unit_id, ro.updated_at
       FROM report_output ro JOIN production_report pr ON pr.id = ro.report_id
       WHERE pr.order_id = $1`,
      [orderId],
    )
    return (
      r.rows as unknown as Array<{
        report_id: string
        quantity: string
        qualified_qty: string
        stock_unit_id: string | null
        updated_at: Date | string
      }>
    ).map((row) => ({
      reportId: row.report_id,
      quantity: row.quantity,
      qualifiedQty: row.qualified_qty,
      stockUnitId: row.stock_unit_id,
      updatedAt: iso(row.updated_at),
    }))
  }

  // ---- AQ-C2：BOM/库存/采购在途读面 ----

  async findBomRevision(id: string) {
    const r = await this.client.query(
      `SELECT id, version, lines, updated_at FROM manufacturing_bom_revision WHERE id = $1`,
      [id],
    )
    const row = r.rows[0] as { id: string; version: number; lines: BomLineRaw[]; updated_at: Date | string } | undefined
    if (row === undefined) return null
    return {
      id: row.id,
      version: row.version,
      lines: (row.lines ?? []).map((l) => ({
        materialId: l.materialId,
        materialCode: l.materialCode,
        quantity: String(l.quantity),
        uom: l.uom,
      })),
      updatedAt: iso(row.updated_at),
    }
  }

  async listBalancesByMaterialCodes(filter: {
    enterpriseId: string
    plantIds: string[] | null
    materialCodes: string[]
  }) {
    const conds = ['sb.enterprise_id = $1', 'sb.status = \'active\'', `iu.material_code = ANY($2::text[])`]
    const params: unknown[] = [filter.enterpriseId, filter.materialCodes]
    if (filter.plantIds !== null) {
      params.push(filter.plantIds)
      conds.push(`sb.plant_id = ANY($${params.length}::uuid[])`)
    }
    const r = await this.client.query(
      `SELECT sb.unit_id, sb.location_id, iu.material_code, sb.quantity::text AS quantity, sb.uom_code,
         sb.quality_status, sb.status, sb.plant_id, sb.updated_at,
         EXISTS (SELECT 1 FROM quality_hold qh WHERE qh.inventory_unit_id=sb.unit_id AND qh.status='active') AS quality_held,
         EXISTS (SELECT 1 FROM inventory_business_hold bh WHERE bh.unit_id=sb.unit_id) AS business_held
       FROM stock_balance sb JOIN inventory_unit iu ON iu.id = sb.unit_id
         AND iu.enterprise_id=sb.enterprise_id AND iu.plant_id=sb.plant_id
       WHERE ${conds.join(' AND ')}`,
      params,
    )
    return (
      r.rows as unknown as Array<{
        unit_id: string
        location_id: string
        quality_held: boolean
        business_held: boolean
        material_code: string
        quantity: string
        uom_code: string
        quality_status: string
        status: string
        plant_id: string
        updated_at: Date | string
      }>
    ).map((row) => ({
      unitId: row.unit_id,
      locationId: row.location_id,
      qualityHeld: row.quality_held,
      businessHeld: row.business_held,
      materialCode: row.material_code,
      quantity: row.quantity,
      uomCode: row.uom_code,
      qualityStatus: row.quality_status,
      status: row.status,
      plantId: row.plant_id,
      updatedAt: iso(row.updated_at),
    }))
  }

  async listActiveReservationsByUnitIds(unitIds: string[]) {
    const r = await this.client.query(
      `SELECT unit_id, location_id, status, quantity::text AS quantity, valid_until
       FROM reservation WHERE unit_id = ANY($1::uuid[]) AND status = 'active'`,
      [unitIds],
    )
    return (
      r.rows as unknown as Array<{ unit_id: string; location_id: string | null; status: string; quantity: string; valid_until: Date | string }>
    ).map((row) => ({
      unitId: row.unit_id,
      locationId: row.location_id,
      status: row.status,
      quantity: row.quantity,
      validUntil: iso(row.valid_until),
    }))
  }

  async listPurchaseLinesByMaterialCodes(filter: {
    enterpriseId: string
    plantIds: string[] | null
    materialCodes: string[]
  }) {
    const conds = ['pol.enterprise_id = $1', `pol.material_code = ANY($2::text[])`]
    const params: unknown[] = [filter.enterpriseId, filter.materialCodes]
    if (filter.plantIds !== null) {
      params.push(filter.plantIds)
      conds.push(`pol.plant_id = ANY($${params.length}::uuid[])`)
    }
    const r = await this.client.query(
      // 价格类列（unit_price 等在 purchase_receipt_batch，本查询不触碰）；白名单列逐列点名
      `SELECT pol.id AS line_id, pol.order_no, pol.line_no, pol.material_code, pol.material_name, pol.spec,
         pol.model, pol.color, pol.uom_code, pol.planned_qty::text AS planned_qty,
         pol.received_qty::text AS received_qty, pol.status, pol.erp_closed, pol.planned_receipt_date,
         pol.first_arrival_date, pol.last_arrival_date, pol.plant_id, pol.updated_at,
         latest.inspection_status AS latest_batch_inspection_status,
         latest.confirm_time AS latest_batch_confirm_time
       FROM purchase_order_line pol
       LEFT JOIN LATERAL (
         SELECT prb.inspection_status, prb.confirm_time FROM purchase_receipt_batch prb
         WHERE prb.purchase_line_id = pol.id ORDER BY prb.confirm_time DESC LIMIT 1
       ) latest ON true
       WHERE ${conds.join(' AND ')}
       ORDER BY pol.material_code, pol.order_no, pol.line_no`,
      params,
    )
    return (
      r.rows as unknown as Array<{
        line_id: string
        order_no: string
        line_no: number
        material_code: string
        material_name: string | null
        spec: string | null
        model: string | null
        color: string | null
        uom_code: string
        planned_qty: string
        received_qty: string
        status: number
        erp_closed: boolean
        planned_receipt_date: Date | string | null
        first_arrival_date: Date | string | null
        last_arrival_date: Date | string | null
        plant_id: string
        updated_at: Date | string
        latest_batch_inspection_status: string | null
        latest_batch_confirm_time: Date | string | null
      }>
    ).map((row) => ({
      lineId: row.line_id,
      orderNo: row.order_no,
      lineNo: row.line_no,
      materialCode: row.material_code,
      materialName: row.material_name,
      spec: row.spec,
      model: row.model,
      color: row.color,
      uomCode: row.uom_code,
      plannedQty: row.planned_qty,
      receivedQty: row.received_qty,
      status: row.status,
      erpClosed: row.erp_closed,
      plannedReceiptDate: dayOrNull(row.planned_receipt_date),
      firstArrivalDate: dayOrNull(row.first_arrival_date),
      lastArrivalDate: dayOrNull(row.last_arrival_date),
      plantId: row.plant_id,
      updatedAt: iso(row.updated_at),
      latestBatchInspectionStatus: row.latest_batch_inspection_status,
      latestBatchConfirmTime: isoOrNull(row.latest_batch_confirm_time),
    }))
  }

  // ---- AQ-C3：质量两族读面（timeRange 新增条件） ----

  async listQualityMergedPage(filter: Parameters<AiQueryReadRepository['listQualityMergedPage']>[0]): Promise<{
    items: AiQualityMergedItem[]
    total: number
  }> {
    // 参数布局（两族共用同一数组）：$1 enterpriseId、$2 plantIds（null=不过滤）、$3/$4 时间起止，
    // $5+ stages/conclusions/like。
    const p: unknown[] = [filter.enterpriseId, filter.plantIds, filter.timeRange.from, filter.timeRange.to]
    // 检验单族条件（时间列=business_time；生效结论过滤=当前 is_effective 行，S14）
    const ioWhere: string[] = [
      'qio.enterprise_id = $1',
      '($2::uuid[] IS NULL OR qio.plant_id = ANY($2::uuid[]))',
      'qio.business_time >= $3::timestamptz AND qio.business_time <= $4::timestamptz',
    ]
    // 来料批次族条件（时间列=confirm_time；结论口径映射：all_qualified=合格，
    // all_unqualified/partially_qualified=不合格；exempt/pending/in_progress 不入结论过滤命中）
    const pbWhere: string[] = [
      'prb.enterprise_id = $1',
      '($2::uuid[] IS NULL OR prb.plant_id = ANY($2::uuid[]))',
      'prb.confirm_time >= $3::timestamptz AND prb.confirm_time <= $4::timestamptz',
    ]
    if (filter.inspectionStages.length > 0) {
      p.push(filter.inspectionStages)
      ioWhere.push(`qio.inspection_stage = ANY($${p.length}::text[])`)
    }
    if (filter.conclusions.length > 0) {
      p.push(filter.conclusions)
      ioWhere.push(
        `EXISTS (SELECT 1 FROM quality_test_result tr WHERE tr.inspection_order_id = qio.id AND tr.is_effective
           AND tr.conclusion = ANY($${p.length}::text[]))`,
      )
      const mapped: string[] = []
      if (filter.conclusions.includes('qualified')) mapped.push('all_qualified')
      if (filter.conclusions.includes('unqualified')) mapped.push('all_unqualified', 'partially_qualified')
      p.push(mapped)
      pbWhere.push(`prb.inspection_status = ANY($${p.length}::text[])`)
    }
    if (filter.orderNoLike !== null) {
      p.push(`%${filter.orderNoLike}%`)
      ioWhere.push(`(qio.order_no LIKE $${p.length} OR qio.production_order_no LIKE $${p.length})`)
      pbWhere.push(`prb.order_no LIKE $${p.length}`)
    }

    // objectScope 收敛：非本族以恒假条件剔除（保持两族 SQL 形状与参数序一致）
    const ioSelect =
      `SELECT 'inspection_order' AS family, qio.id, qio.business_time AS basis_time
       FROM quality_inspection_order qio
       WHERE ${filter.objectScope === 'purchase_batch' ? 'false AND ' : ''}${ioWhere.join(' AND ')}`
    const pbSelect =
      `SELECT 'purchase_batch' AS family, prb.id, prb.confirm_time AS basis_time
       FROM purchase_receipt_batch prb
       WHERE ${filter.objectScope === 'inspection_order' ? 'false AND ' : ''}${pbWhere.join(' AND ')}`
    const unionSql = `(${ioSelect} UNION ALL ${pbSelect}) merged`

    const countR = await this.client.query(`SELECT count(*)::int AS total FROM ${unionSql}`, p)
    const total = (countR.rows[0] as { total: number }).total
    p.push(filter.page.pageSize, (filter.page.page - 1) * filter.page.pageSize)
    const pageR = await this.client.query(
      `SELECT family, id, basis_time FROM ${unionSql} ORDER BY basis_time DESC, family, id::text
       LIMIT $${p.length - 1} OFFSET $${p.length}`,
      p,
    )
    const items = (
      pageR.rows as unknown as Array<{ family: 'inspection_order' | 'purchase_batch'; id: string; basis_time: Date | string }>
    ).map((row) => ({
      family: row.family,
      id: row.id,
      basisTime: iso(row.basis_time),
    }))
    return { items, total }
  }

  async listInspectionOrdersByIds(ids: string[]): Promise<AiQualityInspectionOrderRow[]> {
    if (ids.length === 0) return []
    const r = await this.client.query(
      `SELECT id, order_no, source_type, inspection_stage, spec_code, spec_version, inventory_unit_id,
         unit_no, material_code, quantity::text AS quantity, uom_code, production_order_no,
         production_dept_name, plant_id, status, business_time, updated_at
       FROM quality_inspection_order WHERE id = ANY($1::uuid[])`,
      [ids],
    )
    return (
      r.rows as unknown as Array<{
        id: string
        order_no: string
        source_type: AiQualityInspectionOrderRow['sourceType']
        inspection_stage: AiQualityInspectionOrderRow['inspectionStage']
        spec_code: string
        spec_version: number
        inventory_unit_id: string | null
        unit_no: string | null
        material_code: string
        quantity: string
        uom_code: string
        production_order_no: string | null
        production_dept_name: string | null
        plant_id: string
        status: AiQualityInspectionOrderRow['status']
        business_time: Date | string
        updated_at: Date | string
      }>
    ).map((row) => ({
      id: row.id,
      orderNo: row.order_no,
      sourceType: row.source_type,
      inspectionStage: row.inspection_stage,
      specCode: row.spec_code,
      specVersion: row.spec_version,
      inventoryUnitId: row.inventory_unit_id,
      unitNo: row.unit_no,
      materialCode: row.material_code,
      quantity: row.quantity,
      uomCode: row.uom_code,
      productionOrderNo: row.production_order_no,
      productionDeptName: row.production_dept_name,
      plantId: row.plant_id,
      status: row.status,
      businessTime: iso(row.business_time),
      updatedAt: iso(row.updated_at),
    }))
  }

  async listBatchesByIds(ids: string[]): Promise<AiQualityBatchRow[]> {
    if (ids.length === 0) return []
    const r = await this.client.query(
      // 白名单列逐列点名：价格复核列（unit_price/avg_price/price_history/deviation_ppm/price_flag/
      // review_status/reviewed_by 等）与外发同步状态列物理排除（GAP-P5）
      `SELECT id, batch_no, order_no, line_no, material_code, material_name, received_qty::text AS received_qty,
         uom_code, inspection_status, storage_status, plant_id, arrival_time, confirm_time
       FROM purchase_receipt_batch WHERE id = ANY($1::uuid[])`,
      [ids],
    )
    return (
      r.rows as unknown as Array<{
        id: string
        batch_no: string
        order_no: string
        line_no: number
        material_code: string
        material_name: string | null
        received_qty: string
        uom_code: string
        inspection_status: string
        storage_status: 'stored' | 'returned'
        plant_id: string
        arrival_time: Date | string
        confirm_time: Date | string
      }>
    ).map((row) => ({
      id: row.id,
      batchNo: row.batch_no,
      orderNo: row.order_no,
      lineNo: row.line_no,
      materialCode: row.material_code,
      materialName: row.material_name,
      receivedQty: row.received_qty,
      uomCode: row.uom_code,
      inspectionStatus: row.inspection_status,
      storageStatus: row.storage_status,
      plantId: row.plant_id,
      arrivalTime: iso(row.arrival_time),
      confirmTime: iso(row.confirm_time),
    }))
  }

  async listEffectiveResultsByOrderIds(inspectionOrderIds: string[]): Promise<AiQualityEffectiveResultRow[]> {
    if (inspectionOrderIds.length === 0) return []
    const r = await this.client.query(
      `SELECT inspection_order_id, version, conclusion, result_kind, inspector, inspected_at
       FROM quality_test_result WHERE inspection_order_id = ANY($1::uuid[]) AND is_effective`,
      [inspectionOrderIds],
    )
    return (
      r.rows as unknown as Array<{
        inspection_order_id: string
        version: number
        conclusion: AiQualityEffectiveResultRow['conclusion']
        result_kind: AiQualityEffectiveResultRow['resultKind']
        inspector: string | null
        inspected_at: Date | string | null
      }>
    ).map((row) => ({
      inspectionOrderId: row.inspection_order_id,
      version: row.version,
      conclusion: row.conclusion,
      resultKind: row.result_kind,
      inspector: row.inspector,
      inspectedAt: isoOrNull(row.inspected_at),
    }))
  }

  async listLatestDispositionsByOrderIds(inspectionOrderIds: string[]): Promise<AiQualityDispositionRow[]> {
    if (inspectionOrderIds.length === 0) return []
    const r = await this.client.query(
      `SELECT DISTINCT ON (inspection_order_id) inspection_order_id, disposition_kind, based_on_version,
         released_by, released_at, reason
       FROM quality_disposition WHERE inspection_order_id = ANY($1::uuid[])
       ORDER BY inspection_order_id, released_at DESC`,
      [inspectionOrderIds],
    )
    return (
      r.rows as unknown as Array<{
        inspection_order_id: string
        disposition_kind: AiQualityDispositionRow['dispositionKind']
        based_on_version: number
        released_by: string
        released_at: Date | string
        reason: string | null
      }>
    ).map((row) => ({
      inspectionOrderId: row.inspection_order_id,
      dispositionKind: row.disposition_kind,
      basedOnVersion: row.based_on_version,
      releasedBy: row.released_by,
      releasedAt: iso(row.released_at),
      reason: row.reason,
    }))
  }

  async listActiveHoldsByUnitIds(unitIds: string[]): Promise<AiQualityHoldRow[]> {
    if (unitIds.length === 0) return []
    const r = await this.client.query(
      `SELECT inventory_unit_id, hold_kind, status, raised_at, released_at
       FROM quality_hold WHERE inventory_unit_id = ANY($1::uuid[]) AND status = 'active'`,
      [unitIds],
    )
    return (
      r.rows as unknown as Array<{
        inventory_unit_id: string
        hold_kind: AiQualityHoldRow['holdKind']
        status: 'active' | 'released'
        raised_at: Date | string
        released_at: Date | string | null
      }>
    ).map((row) => ({
      inventoryUnitId: row.inventory_unit_id,
      holdKind: row.hold_kind,
      status: row.status,
      raisedAt: iso(row.raised_at),
      releasedAt: isoOrNull(row.released_at),
    }))
  }

  async listBatchDetailSummary(batchIds: string[]): Promise<AiQualityBatchDetailSummaryRow[]> {
    if (batchIds.length === 0) return []
    const r = await this.client.query(
      `SELECT batch_id, quality_status, count(*)::int AS count FROM receipt_detail
       WHERE batch_id = ANY($1::uuid[]) GROUP BY batch_id, quality_status`,
      [batchIds],
    )
    return (r.rows as unknown as Array<{ batch_id: string; quality_status: string; count: number }>).map((row) => ({
      batchId: row.batch_id,
      qualityStatus: row.quality_status,
      count: row.count,
    }))
  }
}

// ---------------- 组合工厂 ----------------

/** aiquery 仓储束装配（auth 四端口复用既有 Pg 实现——SessionVerifier 同源，AQ-AUTH-01）。 */
export function createPgAiQueryRepositories(client: SqlClient): AiQueryRepositories {
  return {
    sessions: new PgAiSessionRepository(client),
    registry: new PgAiCapabilityRegistryRepository(client),
    audit: new PgAiQueryAuditRepository(client),
    reads: new PgAiQueryReadRepository(client),
    runtimeEvents: new PgAiRuntimeEventRepository(client),
    bindingCodes: new PgAiImBindingCodeRepository(client),
    auth: {
      users: new PgUserAccountRepository(client),
      org: new PgOrgNodeRepository(client),
      roles: new PgRoleRepository(client),
      grants: new PgScopeGrantRepository(client),
    } satisfies AiQueryAuthSources,
  }
}

// ---------------- 部署初始化 seed（AQ-REG-03：首版三能力注册行） ----------------

/** seed 输入（与 domain/src/aiquery/capabilities.ts AiCapabilitySeed 结构同形；避免 persistence→domain-aiquery 耦合）。 */
export interface AiCapabilitySeedInput {
  capabilityId: string
  version: number
  status: 'enabled' | 'disabled'
  definition: AiCapabilityDefinition
  remark?: string | null
}

/**
 * 首版能力注册行 seed（部署初始化调用；幂等——(enterprise_id, capability_id, version)
 * 冲突 DO NOTHING，不覆盖服务端管理动作的启停状态）。
 */
export async function seedAiQueryCapabilities(
  client: SqlClient,
  enterpriseId: string,
  seeds: readonly AiCapabilitySeedInput[],
  createdBy = 'deploy-seed',
): Promise<number> {
  let inserted = 0
  for (const seed of seeds) {
    const r = await client.query(
      `INSERT INTO ai_capability_registry (enterprise_id, capability_id, version, status, definition, remark, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (enterprise_id, capability_id, version) DO NOTHING
       RETURNING id`,
      [
        enterpriseId,
        seed.capabilityId,
        seed.version,
        seed.status,
        JSON.stringify(seed.definition),
        seed.remark ?? null,
        createdBy,
      ],
    )
    if (r.rowCount !== null && r.rowCount > 0) inserted += 1
  }
  return inserted
}

/** Do not persist arbitrary runtime event JSON in the business database (AR-17/IM-14). */
function runtimeEventState(event: NewAiRuntimeEvent): Record<string, unknown> {
  const value = event.event ?? {}
  if (event.kind === 'turn_outcome' && typeof value['outcome'] === 'string' && ['answer', 'clarify', 'unavailable', 'cancelled'].includes(value['outcome'])) return { outcome: value['outcome'] }
  if (event.kind === 'tool_call' && typeof value['status'] === 'string' && ['ok_with_data', 'ok_no_records', 'no_permission', 'not_supported', 'source_not_ready', 'timeout', 'failed'].includes(value['status'])) return { status: value['status'] }
  return {}
}
