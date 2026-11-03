// L0 整合步（Wave5）：application index 已导出 execution 面；type-only 跨包导入改包名
// （原 dist 相对导入删除；不得相对引用 application/src/**：各包 tsconfig.build.json 置空
// paths 且限 rootDir=src）。
import type {
  ExecutionMasterDataLookups,
  ExecutionRepositories,
  ExecutionSessionPatch,
  ExecutionSessionRecord,
  ExecutionSessionRepository,
  ExecutionSessionStatus,
  LaborRecordRecord,
  LaborRecordRepository,
  MaterialConsumptionRecord,
  MaterialConsumptionRepository,
  NewExecutionSession,
  NewLaborRecord,
  NewMaterialConsumption,
  NewReportOutput,
  OrderProgressWriteBack,
  ProductionReportPatch,
  ProductionReportRecord,
  ProductionReportRepository,
  ReportOutputRecord,
  ReportOutputRepository,
  ReportStatusValue,
  ReviewStatusValue,
} from '@cadenza/application'
import type { PageRequest, PageResult } from '@cadenza/contracts'
import type { SqlClient } from './sql-client'

/**
 * execution 域仓储的 PostgreSQL 实现（implements application 端口；依赖方向 persistence → application）。
 *
 * - 全部参数化查询；数量列 numeric(18,4) 以字符串往返（定点保真）；
 * - 时间戳出参统一 ISO-8601 字符串（business_time 与 created_at 分列口径）；
 * - [底稿 A6-2] 草稿隔离键的库层双保险由 0008 partial unique 承担（并发插入兜底），
 *   本层 listOpenByOperatorAndOrder 供应用层规则判定。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

function dateStr(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

async function typedQuery<T>(
  client: SqlClient,
  text: string,
  values?: readonly unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const r = await client.query(text, values)
  return { rows: r.rows as T[], rowCount: r.rowCount }
}

// ---------------- 会话 ----------------

interface SessionRow {
  id: string
  enterprise_id: string
  plant_id: string
  order_id: string
  source: 'order' | 'workbench' | 'scan'
  order_operation_id: string | null
  operation_seq: number | null
  equipment_id: string | null
  equipment_code: string | null
  operator_user_id: string
  operator_login: string
  shift_date: Date | string
  status: ExecutionSessionStatus
  business_time: Date | string
  draft_feeds: unknown[]
  remark: string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapSession(r: SessionRow): ExecutionSessionRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    orderId: r.order_id,
    source: r.source,
    orderOperationId: r.order_operation_id,
    operationSeq: r.operation_seq,
    equipmentId: r.equipment_id,
    equipmentCode: r.equipment_code,
    operatorUserId: r.operator_user_id,
    operatorLogin: r.operator_login,
    shiftDate: dateStr(r.shift_date),
    status: r.status,
    businessTime: iso(r.business_time),
    draftFeeds: Array.isArray(r.draft_feeds) ? r.draft_feeds : [],
    remark: r.remark,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgExecutionSessionRepository implements ExecutionSessionRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<ExecutionSessionRecord | null> {
    const r = await typedQuery<SessionRow>(this.client, `SELECT * FROM execution_session WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapSession(r.rows[0])
  }

  async findBySessionReportId(reportId: string): Promise<ExecutionSessionRecord | null> {
    const r = await typedQuery<SessionRow>(
      this.client,
      `SELECT s.* FROM execution_session s JOIN production_report r ON r.session_id = s.id WHERE r.id = $1`,
      [reportId],
    )
    return r.rows[0] === undefined ? null : mapSession(r.rows[0])
  }

  async listOpenByOperatorAndOrder(operatorUserId: string, orderId: string): Promise<ExecutionSessionRecord[]> {
    const r = await typedQuery<SessionRow>(
      this.client,
      `SELECT * FROM execution_session
       WHERE operator_user_id = $1 AND order_id = $2 AND status = 'open'
       ORDER BY created_at ASC`,
      [operatorUserId, orderId],
    )
    return r.rows.map(mapSession)
  }

  async insert(session: NewExecutionSession): Promise<ExecutionSessionRecord> {
    const r = await typedQuery<SessionRow>(
      this.client,
      `INSERT INTO execution_session
         (enterprise_id, plant_id, order_id, source, order_operation_id, operation_seq,
          equipment_id, equipment_code, operator_user_id, operator_login, shift_date,
          business_time, draft_feeds, remark, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15) RETURNING *`,
      [
        session.enterpriseId,
        session.plantId,
        session.orderId,
        session.source,
        session.orderOperationId ?? null,
        session.operationSeq ?? null,
        session.equipmentId ?? null,
        session.equipmentCode ?? null,
        session.operatorUserId,
        session.operatorLogin,
        session.shiftDate,
        session.businessTime,
        JSON.stringify(session.draftFeeds ?? []),
        session.remark ?? null,
        session.createdBy ?? null,
      ],
    )
    return mapSession(r.rows[0]!)
  }

  async update(id: string, patch: ExecutionSessionPatch, actor: string | null): Promise<ExecutionSessionRecord | null> {
    const r = await typedQuery<SessionRow>(
      this.client,
      `UPDATE execution_session SET
         order_operation_id = COALESCE($2, order_operation_id),
         operation_seq = COALESCE($3, operation_seq),
         equipment_id = COALESCE($4, equipment_id),
         equipment_code = COALESCE($5, equipment_code),
         shift_date = COALESCE($6, shift_date),
         business_time = COALESCE($7, business_time),
         status = COALESCE($8, status),
         draft_feeds = COALESCE($9::jsonb, draft_feeds),
         remark = COALESCE($10, remark),
         updated_at = now(), updated_by = $11
       WHERE id = $1 RETURNING *`,
      [
        id,
        patch.orderOperationId !== undefined ? patch.orderOperationId : null,
        patch.operationSeq !== undefined ? patch.operationSeq : null,
        patch.equipmentId !== undefined ? patch.equipmentId : null,
        patch.equipmentCode !== undefined ? patch.equipmentCode : null,
        patch.shiftDate !== undefined ? patch.shiftDate : null,
        patch.businessTime !== undefined ? patch.businessTime : null,
        patch.status !== undefined ? patch.status : null,
        patch.draftFeeds !== undefined ? JSON.stringify(patch.draftFeeds) : null,
        patch.remark !== undefined ? patch.remark : null,
        actor,
      ],
    )
    return r.rows[0] === undefined ? null : mapSession(r.rows[0])
  }

  async list(
    filter: {
      enterpriseId: string
      plantIds: string[] | null
      orderId?: string
      operatorUserId?: string
      source?: ExecutionSessionRecord['source']
      status?: ExecutionSessionStatus
    } & PageRequest,
  ): Promise<PageResult<ExecutionSessionRecord>> {
    const conditions = ['s.enterprise_id = $1']
    const values: unknown[] = [filter.enterpriseId]
    if (filter.plantIds !== null && filter.plantIds.length > 0) {
      values.push(filter.plantIds)
      conditions.push(`s.plant_id = ANY($${values.length}::uuid[])`)
    }
    if (filter.orderId !== undefined) {
      values.push(filter.orderId)
      conditions.push(`s.order_id = $${values.length}`)
    }
    if (filter.operatorUserId !== undefined) {
      values.push(filter.operatorUserId)
      conditions.push(`s.operator_user_id = $${values.length}`)
    }
    if (filter.source !== undefined) {
      values.push(filter.source)
      conditions.push(`s.source = $${values.length}`)
    }
    if (filter.status !== undefined) {
      values.push(filter.status)
      conditions.push(`s.status = $${values.length}`)
    }
    const where = conditions.join(' AND ')
    const total = await typedQuery<{ n: string }>(
      this.client,
      `SELECT count(*)::text AS n FROM execution_session s WHERE ${where}`,
      values,
    )
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const page = await typedQuery<SessionRow>(
      this.client,
      `SELECT s.* FROM execution_session s WHERE ${where}
       ORDER BY s.created_at ASC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return {
      items: page.rows.map(mapSession),
      total: Number(total.rows[0]?.n ?? '0'),
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

// ---------------- 报工单 ----------------

interface ReportRow {
  id: string
  enterprise_id: string
  plant_id: string
  session_id: string
  order_id: string
  order_operation_id: string
  operation_seq: number
  source: 'order' | 'workbench' | 'scan'
  status: ReportStatusValue
  review_status: ReviewStatusValue
  operator_user_id: string
  operator_login: string
  business_time: Date | string
  shift_date: Date | string
  equipment_id: string | null
  equipment_code: string | null
  reviewed_at: Date | string | null
  reviewed_by: string | null
  review_cancelled_at: Date | string | null
  review_cancelled_by: string | null
  review_cancel_reason: string | null
  qc_completed_at: Date | string | null
  correction_of: string | null
  deleted_at: Date | string | null
  deleted_by: string | null
  remark: string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapReport(r: ReportRow): ProductionReportRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    sessionId: r.session_id,
    orderId: r.order_id,
    orderOperationId: r.order_operation_id,
    operationSeq: r.operation_seq,
    source: r.source,
    status: r.status,
    reviewStatus: r.review_status,
    operatorUserId: r.operator_user_id,
    operatorLogin: r.operator_login,
    businessTime: iso(r.business_time),
    shiftDate: dateStr(r.shift_date),
    equipmentId: r.equipment_id,
    equipmentCode: r.equipment_code,
    reviewedAt: isoOrNull(r.reviewed_at),
    reviewedBy: r.reviewed_by,
    reviewCancelledAt: isoOrNull(r.review_cancelled_at),
    reviewCancelledBy: r.review_cancelled_by,
    reviewCancelReason: r.review_cancel_reason,
    qcCompletedAt: isoOrNull(r.qc_completed_at),
    correctionOf: r.correction_of,
    deletedAt: isoOrNull(r.deleted_at),
    deletedBy: r.deleted_by,
    remark: r.remark,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgProductionReportRepository implements ProductionReportRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<ProductionReportRecord | null> {
    const r = await typedQuery<ReportRow>(this.client, `SELECT * FROM production_report WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapReport(r.rows[0])
  }

  async findBySessionId(sessionId: string): Promise<ProductionReportRecord | null> {
    const r = await typedQuery<ReportRow>(
      this.client,
      `SELECT * FROM production_report WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    )
    return r.rows[0] === undefined ? null : mapReport(r.rows[0])
  }

  async insert(report: NewReportInput): Promise<ProductionReportRecord> {
    const r = await typedQuery<ReportRow>(
      this.client,
      `INSERT INTO production_report
         (enterprise_id, plant_id, session_id, order_id, order_operation_id, operation_seq, source,
          status, review_status, operator_user_id, operator_login, business_time, shift_date,
          equipment_id, equipment_code, correction_of, remark, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        report.enterpriseId,
        report.plantId,
        report.sessionId,
        report.orderId,
        report.orderOperationId,
        report.operationSeq,
        report.source,
        report.status ?? 'draft',
        report.reviewStatus ?? 'pending_review',
        report.operatorUserId,
        report.operatorLogin,
        report.businessTime,
        report.shiftDate,
        report.equipmentId ?? null,
        report.equipmentCode ?? null,
        report.correctionOf ?? null,
        report.remark ?? null,
        report.createdBy ?? null,
      ],
    )
    return mapReport(r.rows[0]!)
  }

  async update(id: string, patch: ProductionReportPatch, actor: string | null): Promise<ProductionReportRecord | null> {
    const r = await typedQuery<ReportRow>(
      this.client,
      `UPDATE production_report SET
         status = COALESCE($2, status),
         review_status = COALESCE($3, review_status),
         reviewed_at = COALESCE($4, reviewed_at),
         reviewed_by = COALESCE($5, reviewed_by),
         review_cancelled_at = COALESCE($6, review_cancelled_at),
         review_cancelled_by = COALESCE($7, review_cancelled_by),
         review_cancel_reason = COALESCE($8, review_cancel_reason),
         qc_completed_at = COALESCE($9, qc_completed_at),
         deleted_at = COALESCE($10, deleted_at),
         deleted_by = COALESCE($11, deleted_by),
         remark = COALESCE($12, remark),
         operator_user_id = COALESCE($13, operator_user_id),
         operator_login = COALESCE($14, operator_login),
         business_time = COALESCE($15, business_time),
         shift_date = COALESCE($16, shift_date),
         updated_at = now(), updated_by = $17
       WHERE id = $1 RETURNING *`,
      [
        id,
        patch.status ?? null,
        patch.reviewStatus ?? null,
        patch.reviewedAt ?? null,
        patch.reviewedBy ?? null,
        patch.reviewCancelledAt ?? null,
        patch.reviewCancelledBy ?? null,
        patch.reviewCancelReason ?? null,
        patch.qcCompletedAt ?? null,
        patch.deletedAt ?? null,
        patch.deletedBy ?? null,
        patch.remark !== undefined ? patch.remark : null,
        patch.operatorUserId ?? null,
        patch.operatorLogin ?? null,
        patch.businessTime ?? null,
        patch.shiftDate ?? null,
        actor,
      ],
    )
    return r.rows[0] === undefined ? null : mapReport(r.rows[0])
  }

  async listByOrder(orderId: string): Promise<ProductionReportRecord[]> {
    const r = await typedQuery<ReportRow>(
      this.client,
      `SELECT * FROM production_report WHERE order_id = $1 ORDER BY operation_seq, created_at`,
      [orderId],
    )
    return r.rows.map(mapReport)
  }

  async listByOrderOperation(orderId: string, orderOperationId: string): Promise<ProductionReportRecord[]> {
    const r = await typedQuery<ReportRow>(
      this.client,
      `SELECT * FROM production_report WHERE order_id = $1 AND order_operation_id = $2 ORDER BY created_at`,
      [orderId, orderOperationId],
    )
    return r.rows.map(mapReport)
  }

  async list(
    filter: {
      enterpriseId: string
      plantIds: string[] | null
      orderId?: string
      operatorUserId?: string
      statuses?: ReportStatusValue[]
      reviewStatuses?: ReviewStatusValue[]
    } & PageRequest,
  ): Promise<PageResult<ProductionReportRecord>> {
    const conditions = ['enterprise_id = $1']
    const values: unknown[] = [filter.enterpriseId]
    if (filter.plantIds !== null && filter.plantIds.length > 0) {
      values.push(filter.plantIds)
      conditions.push(`plant_id = ANY($${values.length}::uuid[])`)
    }
    if (filter.orderId !== undefined) {
      values.push(filter.orderId)
      conditions.push(`order_id = $${values.length}`)
    }
    if (filter.operatorUserId !== undefined) {
      values.push(filter.operatorUserId)
      conditions.push(`operator_user_id = $${values.length}`)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      values.push(filter.statuses)
      conditions.push(`status = ANY($${values.length}::text[])`)
    }
    if (filter.reviewStatuses !== undefined && filter.reviewStatuses.length > 0) {
      values.push(filter.reviewStatuses)
      conditions.push(`review_status = ANY($${values.length}::text[])`)
    }
    const where = conditions.join(' AND ')
    const total = await typedQuery<{ n: string }>(
      this.client,
      `SELECT count(*)::text AS n FROM production_report WHERE ${where}`,
      values,
    )
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const page = await typedQuery<ReportRow>(
      this.client,
      `SELECT * FROM production_report WHERE ${where}
       ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return {
      items: page.rows.map(mapReport),
      total: Number(total.rows[0]?.n ?? '0'),
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

// ---------------- 产出行 ----------------

interface OutputRow {
  id: string
  enterprise_id: string
  plant_id: string
  report_id: string
  line_no: number
  quantity: string
  qualified_qty: string
  uom_id: string
  uom_code: string
  carrier_code: string | null
  target_location_id: string
  target_location_code: string
  owner_id: string
  owner_name: string
  measurement_basis: string
  stock_unit_id: string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapOutput(r: OutputRow): ReportOutputRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    reportId: r.report_id,
    lineNo: r.line_no,
    quantity: r.quantity,
    qualifiedQty: r.qualified_qty,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    carrierCode: r.carrier_code,
    targetLocationId: r.target_location_id,
    targetLocationCode: r.target_location_code,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    measurementBasis: r.measurement_basis,
    stockUnitId: r.stock_unit_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

const OUTPUT_COLUMNS = `id, enterprise_id, plant_id, report_id, line_no, quantity, qualified_qty,
  uom_id, uom_code, carrier_code, target_location_id, target_location_code, owner_id, owner_name,
  measurement_basis, stock_unit_id, created_at, created_by, updated_at, updated_by`

export class PgReportOutputRepository implements ReportOutputRepository {
  constructor(private readonly client: SqlClient) {}

  async insertBatch(outputs: NewReportOutput[]): Promise<ReportOutputRecord[]> {
    if (outputs.length === 0) return []
    const rows: ReportOutputRecord[] = []
    for (const o of outputs) {
      const r = await typedQuery<OutputRow>(
        this.client,
        `INSERT INTO report_output
           (report_id, line_no, quantity, qualified_qty, uom_id, uom_code, carrier_code,
            target_location_id, target_location_code, owner_id, owner_name, measurement_basis,
            enterprise_id, plant_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (report_id, line_no) DO UPDATE SET
           quantity = EXCLUDED.quantity, qualified_qty = EXCLUDED.qualified_qty,
           carrier_code = EXCLUDED.carrier_code,
           target_location_id = EXCLUDED.target_location_id,
           target_location_code = EXCLUDED.target_location_code,
           owner_id = EXCLUDED.owner_id, owner_name = EXCLUDED.owner_name,
           updated_at = now(), updated_by = EXCLUDED.created_by
         RETURNING ${OUTPUT_COLUMNS}`,
        [
          o.reportId,
          o.lineNo,
          o.quantity,
          o.qualifiedQty,
          o.uomId,
          o.uomCode,
          o.carrierCode ?? null,
          o.targetLocationId,
          o.targetLocationCode,
          o.ownerId,
          o.ownerName,
          o.measurementBasis ?? 'nominal',
          o.enterpriseId,
          o.plantId,
          o.createdBy ?? null,
        ],
      )
      rows.push(mapOutput(r.rows[0]!))
    }
    return rows
  }

  async listByReport(reportId: string): Promise<ReportOutputRecord[]> {
    const r = await typedQuery<OutputRow>(
      this.client,
      `SELECT ${OUTPUT_COLUMNS} FROM report_output WHERE report_id = $1 ORDER BY line_no`,
      [reportId],
    )
    return r.rows.map(mapOutput)
  }

  async listByOrder(orderId: string): Promise<ReportOutputRecord[]> {
    const r = await typedQuery<OutputRow>(
      this.client,
      `SELECT o.* FROM report_output o
       JOIN production_report r ON r.id = o.report_id
       WHERE r.order_id = $1 ORDER BY r.operation_seq, o.line_no`,
      [orderId],
    )
    return (r.rows as OutputRow[]).map(mapOutput)
  }

  async listByStockUnit(stockUnitId: string): Promise<ReportOutputRecord[]> {
    const r = await typedQuery<OutputRow>(
      this.client,
      `SELECT ${OUTPUT_COLUMNS} FROM report_output WHERE stock_unit_id = $1`,
      [stockUnitId],
    )
    return r.rows.map(mapOutput)
  }

  async originReportsForUnit(stockUnitId: string): Promise<Array<{ reportId: string | null }>> {
    const r=await this.client.query(`WITH RECURSIVE valid_edges AS (
      SELECT g.id,g.from_id,g.to_id FROM genealogy_edge g
      JOIN command_receipt cr ON cr.id=g.command_receipt_id
      JOIN inventory_unit src ON src.id=g.from_id JOIN inventory_unit dst ON dst.id=g.to_id
      WHERE g.from_type='inventory_unit' AND g.to_type='inventory_unit' AND g.edge_kind='consumption'
      AND cr.command_type IN ('inventory.split','rework.reel-split.execute') AND cr.status='COMMITTED'
      AND src.enterprise_id=dst.enterprise_id AND src.plant_id=dst.plant_id AND src.material_id=dst.material_id
      AND g.enterprise_id=dst.enterprise_id AND g.plant_id=dst.plant_id
      AND EXISTS(SELECT 1 FROM stock_transaction st JOIN stock_transaction dt ON dt.command_receipt_id=st.command_receipt_id
        JOIN stock_entry se ON se.transaction_id=st.id JOIN stock_entry de ON de.transaction_id=dt.id
        WHERE st.command_receipt_id=g.command_receipt_id AND st.unit_id=src.id AND dt.unit_id=dst.id
        AND st.quantity<0 AND dt.quantity>0 AND se.owner_id=de.owner_id
        AND st.measurement_basis=dt.measurement_basis AND st.uom_code=dt.uom_code)
    ), walk AS (
      SELECT id,ARRAY[id] AS path,0 AS depth FROM inventory_unit WHERE id=$1
      UNION ALL SELECT e.from_id,w.path||e.from_id,w.depth+1 FROM walk w JOIN valid_edges e ON e.to_id=w.id
      WHERE NOT e.from_id=ANY(w.path) AND w.depth<32
    )
    SELECT DISTINCT CASE WHEN pr.id IS NOT NULL THEN ro.report_id ELSE NULL END AS "reportId" FROM walk w
    LEFT JOIN report_output ro ON ro.stock_unit_id=w.id
    LEFT JOIN production_report pr ON pr.id=ro.report_id AND pr.review_status IN ('auto_approved','manual_approved') AND pr.status='submitted' AND pr.review_cancelled_at IS NULL
    WHERE pr.id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM valid_edges e WHERE e.to_id=w.id)
    UNION ALL SELECT NULL WHERE EXISTS(SELECT 1 FROM walk w WHERE
      EXISTS(SELECT 1 FROM valid_edges e WHERE e.to_id=w.id AND (w.depth>=32 OR e.from_id=ANY(w.path)))
      OR EXISTS(SELECT 1 FROM genealogy_edge g WHERE g.to_type='inventory_unit' AND g.to_id=w.id AND g.from_type='inventory_unit'
        AND g.edge_kind='consumption' AND NOT EXISTS(SELECT 1 FROM valid_edges e WHERE e.id=g.id)))`,[stockUnitId])
    return r.rows as Array<{reportId:string|null}>
  }

  async listStageReadiness(parentOrderId: string) {
    const r=await this.client.query(`SELECT DISTINCT op.seq FROM production_order child
      JOIN production_order parent ON parent.id::text=child.material_snapshot->'_cadenzaStageParent'->>'parentOrderId'
      JOIN order_operation op ON op.id::text=child.material_snapshot->'_cadenzaStageParent'->>'parentOperationId' AND op.order_id=parent.id
      JOIN production_report pr ON pr.order_id=child.id JOIN report_output ro ON ro.report_id=pr.id
      WHERE parent.id=$1 AND child.enterprise_id=parent.enterprise_id AND child.plant_id=parent.plant_id
      AND child.material_snapshot->'_cadenzaStageParent'->>'source'='PROCESS_RECEIVE_VERIFIED_STAGE'
      AND child.material_snapshot->'_cadenzaStageParent'->>'parentSettingsVersion'=parent.current_settings_version::text
      AND pr.status='submitted' AND pr.review_status IN ('auto_approved','manual_approved') AND pr.review_cancelled_at IS NULL AND ro.stock_unit_id IS NOT NULL`,[parentOrderId])
    return r.rows.map(row=>({seq:Number(row.seq),submitted:true,hasOutput:true}))
  }

  async updateStockUnit(id: string, stockUnitId: string | null, actor: string | null): Promise<ReportOutputRecord | null> {
    const r = await typedQuery<OutputRow>(
      this.client,
      `UPDATE report_output SET stock_unit_id = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${OUTPUT_COLUMNS}`,
      [id, stockUnitId, actor],
    )
    return r.rows[0] === undefined ? null : mapOutput(r.rows[0])
  }

  async replaceDraftOutputs(
    reportId: string,
    outputs: NewReportOutput[],
    actor: string | null,
  ): Promise<ReportOutputRecord[]> {
    await typedQuery(this.client, `DELETE FROM report_output WHERE report_id = $1`, [reportId])
    return this.insertBatch(outputs.map((o) => ({ ...o, createdBy: o.createdBy ?? actor })))
  }

  async updateQuantities(
    id: string,
    quantity: string,
    qualifiedQty: string,
    actor: string | null,
  ): Promise<ReportOutputRecord | null> {
    const r = await typedQuery<OutputRow>(
      this.client,
      `UPDATE report_output SET quantity = $2, qualified_qty = $3, updated_at = now(), updated_by = $4
       WHERE id = $1 RETURNING ${OUTPUT_COLUMNS}`,
      [id, quantity, qualifiedQty, actor],
    )
    return r.rows[0] === undefined ? null : mapOutput(r.rows[0])
  }
}

// ---------------- 投料记录 ----------------

interface FeedRow {
  id: string
  enterprise_id: string
  plant_id: string
  order_id: string
  order_operation_id: string
  operation_seq: number
  report_id: string | null
  feed_type: 'report' | 'standalone'
  inventory_unit_id: string
  unit_no: string
  barcode_value: string | null
  quantity: string
  before_qty: string
  after_qty: string
  uom_id: string
  uom_code: string
  sales_order_no: string | null
  sales_line_no: string | null
  cross_order: boolean
  deviation_reason: string | null
  issued_location_id: string | null
  issued_location_code: string | null
  genealogy_target_unit_id: string | null
  operator_user_id: string
  operator_login: string
  business_time: Date | string
  shift_date: Date | string | null
  command_receipt_id: string
  created_at: Date | string
  created_by: string | null
}

function mapFeed(r: FeedRow): MaterialConsumptionRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    orderId: r.order_id,
    orderOperationId: r.order_operation_id,
    operationSeq: r.operation_seq,
    reportId: r.report_id,
    feedType: r.feed_type,
    inventoryUnitId: r.inventory_unit_id,
    unitNo: r.unit_no,
    barcodeValue: r.barcode_value,
    quantity: r.quantity,
    beforeQty: r.before_qty,
    afterQty: r.after_qty,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    salesOrderNo: r.sales_order_no,
    salesLineNo: r.sales_line_no,
    crossOrder: r.cross_order,
    deviationReason: r.deviation_reason,
    issuedLocationId: r.issued_location_id,
    issuedLocationCode: r.issued_location_code,
    genealogyTargetUnitId: r.genealogy_target_unit_id,
    operatorUserId: r.operator_user_id,
    operatorLogin: r.operator_login,
    businessTime: iso(r.business_time),
    shiftDate: r.shift_date === null ? null : dateStr(r.shift_date),
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgMaterialConsumptionRepository implements MaterialConsumptionRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(record: NewMaterialConsumption): Promise<MaterialConsumptionRecord> {
    const r = await typedQuery<FeedRow>(
      this.client,
      `INSERT INTO material_consumption
         (enterprise_id, plant_id, order_id, order_operation_id, operation_seq, report_id, feed_type,
          inventory_unit_id, unit_no, barcode_value, quantity, before_qty, after_qty, uom_id, uom_code,
          sales_order_no, sales_line_no, cross_order, deviation_reason, issued_location_id,
          issued_location_code, genealogy_target_unit_id, operator_user_id, operator_login,
          business_time, shift_date, command_receipt_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       RETURNING *`,
      [
        record.enterpriseId,
        record.plantId,
        record.orderId,
        record.orderOperationId,
        record.operationSeq,
        record.reportId ?? null,
        record.feedType,
        record.inventoryUnitId,
        record.unitNo,
        record.barcodeValue ?? null,
        record.quantity,
        record.beforeQty,
        record.afterQty,
        record.uomId,
        record.uomCode,
        record.salesOrderNo ?? null,
        record.salesLineNo ?? null,
        record.crossOrder ?? false,
        record.deviationReason ?? null,
        record.issuedLocationId ?? null,
        record.issuedLocationCode ?? null,
        record.genealogyTargetUnitId ?? null,
        record.operatorUserId,
        record.operatorLogin,
        record.businessTime,
        record.shiftDate ?? null,
        record.commandReceiptId,
        record.createdBy ?? null,
      ],
    )
    return mapFeed(r.rows[0]!)
  }

  async findById(id: string): Promise<MaterialConsumptionRecord | null> {
    const r = await typedQuery<FeedRow>(this.client, `SELECT * FROM material_consumption WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapFeed(r.rows[0])
  }

  async listByReport(reportId: string): Promise<MaterialConsumptionRecord[]> {
    const r = await typedQuery<FeedRow>(
      this.client,
      `SELECT * FROM material_consumption WHERE report_id = $1 ORDER BY created_at`,
      [reportId],
    )
    return r.rows.map(mapFeed)
  }

  async listByOrder(orderId: string): Promise<MaterialConsumptionRecord[]> {
    const r = await typedQuery<FeedRow>(
      this.client,
      `SELECT * FROM material_consumption WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
    )
    return r.rows.map(mapFeed)
  }

  async listByUnit(inventoryUnitId: string): Promise<MaterialConsumptionRecord[]> {
    const r = await typedQuery<FeedRow>(
      this.client,
      `SELECT * FROM material_consumption WHERE inventory_unit_id = $1 ORDER BY created_at`,
      [inventoryUnitId],
    )
    return r.rows.map(mapFeed)
  }

  async listUnlinkedByOrderOperation(orderId: string, orderOperationId: string): Promise<MaterialConsumptionRecord[]> {
    const r = await typedQuery<FeedRow>(
      this.client,
      `SELECT * FROM material_consumption
       WHERE order_id = $1 AND order_operation_id = $2 AND genealogy_target_unit_id IS NULL
       ORDER BY created_at`,
      [orderId, orderOperationId],
    )
    return r.rows.map(mapFeed)
  }

  async markGenealogyTarget(id: string, targetUnitId: string, actor: string | null): Promise<MaterialConsumptionRecord | null> {
    const r = await typedQuery<FeedRow>(
      this.client,
      `UPDATE material_consumption SET genealogy_target_unit_id = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING *`,
      [id, targetUnitId, actor],
    )
    return r.rows[0] === undefined ? null : mapFeed(r.rows[0])
  }
}

// ---------------- 工时 ----------------

interface LaborRow {
  id: string
  enterprise_id: string
  plant_id: string
  order_id: string
  order_operation_id: string | null
  report_id: string | null
  operator_user_id: string
  operator_login: string
  hours: string
  business_time: Date | string
  shift_date: Date | string
  note: string | null
  created_at: Date | string
  created_by: string | null
}

function mapLabor(r: LaborRow): LaborRecordRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    orderId: r.order_id,
    orderOperationId: r.order_operation_id,
    reportId: r.report_id,
    operatorUserId: r.operator_user_id,
    operatorLogin: r.operator_login,
    hours: r.hours,
    businessTime: iso(r.business_time),
    shiftDate: dateStr(r.shift_date),
    note: r.note,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgLaborRecordRepository implements LaborRecordRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(record: NewLaborRecord): Promise<LaborRecordRecord> {
    const r = await typedQuery<LaborRow>(
      this.client,
      `INSERT INTO labor_record
         (enterprise_id, plant_id, order_id, order_operation_id, report_id, operator_user_id,
          operator_login, hours, business_time, shift_date, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        record.enterpriseId,
        record.plantId,
        record.orderId,
        record.orderOperationId ?? null,
        record.reportId ?? null,
        record.operatorUserId,
        record.operatorLogin,
        record.hours,
        record.businessTime,
        record.shiftDate,
        record.note ?? null,
        record.createdBy ?? null,
      ],
    )
    return mapLabor(r.rows[0]!)
  }

  async listByOrder(orderId: string): Promise<LaborRecordRecord[]> {
    const r = await typedQuery<LaborRow>(
      this.client,
      `SELECT * FROM labor_record WHERE order_id = $1 ORDER BY business_time`,
      [orderId],
    )
    return r.rows.map(mapLabor)
  }
}

// ---------------- 订单完成数量回写 ----------------

/** [底稿 A6-5] production_order.completed_qty 窄写端口（0008 追加列；非负钳制）。 */
export class PgOrderProgressWriteBack implements OrderProgressWriteBack {
  constructor(private readonly client: SqlClient) {}

  async addCompletedQty(orderId: string, delta: string, actor: string | null): Promise<string> {
    const r = await typedQuery<{ completed_qty: string }>(
      this.client,
      `UPDATE production_order
       SET completed_qty = GREATEST(completed_qty + $2::numeric, 0),
           updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING completed_qty::text`,
      [orderId, delta, actor],
    )
    if (r.rows[0] === undefined) {
      throw new Error(`production_order ${orderId} 不存在，完成数量回写失败`)
    }
    return r.rows[0].completed_qty
  }
}

/** [合同 A7-2/底稿 A7] 线边判定事实查询（D-1 修复）：库位 → 隶属仓库类型（0003 主数据只读）。 */
export class PgExecutionMasterDataLookups implements ExecutionMasterDataLookups {
  constructor(private readonly client: SqlClient) {}

  async findWarehouseTypeByLocation(locationId: string): Promise<string | null> {
    const r = await typedQuery<{ warehouse_type: string }>(
      this.client,
      `SELECT w.warehouse_type
       FROM storage_location l
       JOIN warehouse w ON w.id = l.warehouse_id
       WHERE l.id = $1`,
      [locationId],
    )
    return r.rows[0]?.warehouse_type ?? null
  }
}

/** execution 仓储束工厂（组合根注入命令事务客户端或查询池）。 */
export function createPgExecutionRepositories(client: SqlClient): ExecutionRepositories {
  return {
    sessions: new PgExecutionSessionRepository(client),
    reports: new PgProductionReportRepository(client),
    outputs: new PgReportOutputRepository(client),
    feeds: new PgMaterialConsumptionRepository(client),
    labor: new PgLaborRecordRepository(client),
    orderProgress: new PgOrderProgressWriteBack(client),
    masterdata: new PgExecutionMasterDataLookups(client),
  }
}

/** insert 输入类型别名（端口 NewProductionReport + 可选缺省列）。 */
type NewReportInput = Parameters<ExecutionRepositories['reports']['insert']>[0]
