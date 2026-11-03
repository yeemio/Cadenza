// [L0-整合标记] application index（共享文件）未导出 disposition 面：type-only 跨包导入暂以
// dist 相对桥接；L0 整合步在 packages/application/src/index.ts 追加导出 disposition-repositories
// 后改包名导入（与 reverse-repositories 同一整合口径）。
import type { SqlClient } from './sql-client'
import type {
  BatchInspectionStatusValue,
  BatchJudgementPort,
  BatchJudgementRow,
  DispositionFactRecord,
  DispositionFactRepository,
  FinishedGoodsDefectRecord,
  FinishedGoodsDefectRepository,
  InspectionChainRepository,
  DispositionInspectionRecordRow,
  NewBatchJudgement,
  NewDispositionFact,
  NewFinishedGoodsDefect,
  NewDispositionInspectionRecord,
  NewReworkTask,
  NewSuspectRecord,
  PurchaseBatchQcPort,
  PurchaseBatchQcProjection,
  QdDispositionKind,
  ReceiptDetailQcView,
  ReworkTaskRecord,
  ReworkTaskRepository,
  SuspectRecordRecord,
  SuspectRecordRepository,
  TraceabilityPort,
} from '@cadenza/application'

/**
 * disposition 域 PostgreSQL 仓储实现（0014 新表 + 0006 既有质检版本链表）。
 * 依赖方向 persistence → application（端口在应用层定义）；绑定命令事务客户端（写）或池（读）。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : String(value)
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

// ---------------- 存疑记录（0014 qd_suspect_record） ----------------

const SUSPECT_COLUMNS = `id, inventory_unit_id, unit_no, material_key_joined, current_status, previous_quality_status,
  production_dept_id, production_dept_name, raised_by, raised_at, command_receipt_id, plant_id, enterprise_id,
  business_time, created_at`

interface SuspectRow {
  id: string
  inventory_unit_id: string
  unit_no: string
  material_key_joined: string
  current_status: string
  previous_quality_status: string | null
  production_dept_id: string | null
  production_dept_name: string | null
  raised_by: string
  raised_at: Date | string
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
}

function mapSuspect(r: SuspectRow): SuspectRecordRecord {
  return {
    id: r.id,
    unitId: r.inventory_unit_id,
    unitNo: r.unit_no,
    materialKeyJoined: r.material_key_joined,
    currentStatus: 'suspect',
    previousQualityStatus:
      r.previous_quality_status === 'qualified' || r.previous_quality_status === 'pending_inspection' || r.previous_quality_status === 'unqualified'
        ? r.previous_quality_status
        : null,
    productionDeptId: r.production_dept_id,
    productionDeptName: r.production_dept_name,
    raisedBy: r.raised_by,
    raisedAt: iso(r.raised_at),
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
  }
}

export class PgSuspectRecordRepository implements SuspectRecordRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(record: NewSuspectRecord): Promise<SuspectRecordRecord> {
    const r = await this.client.query(
      `INSERT INTO qd_suspect_record (inventory_unit_id, unit_no, material_key_joined, current_status,
         previous_quality_status, production_dept_id, production_dept_name, raised_by, raised_at,
         command_receipt_id, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, $3, 'suspect', $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${SUSPECT_COLUMNS}`,
      [
        record.unitId,
        record.unitNo,
        record.materialKeyJoined,
        record.previousQualityStatus ?? null,
        record.productionDeptId ?? null,
        record.productionDeptName ?? null,
        record.raisedBy,
        record.raisedAt,
        record.commandReceiptId ?? null,
        record.plantId,
        record.enterpriseId,
        record.createdBy ?? null,
      ],
    )
    return mapSuspect(r.rows[0]!)
  }

  async findById(id: string): Promise<SuspectRecordRecord | null> {
    const r = await this.client.query(`SELECT ${SUSPECT_COLUMNS} FROM qd_suspect_record WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapSuspect(r.rows[0])
  }

  async listByUnit(unitId: string): Promise<SuspectRecordRecord[]> {
    const r = await this.client.query(
      `SELECT ${SUSPECT_COLUMNS} FROM qd_suspect_record WHERE inventory_unit_id = $1 ORDER BY raised_at, id`,
      [unitId],
    )
    return r.rows.map(mapSuspect)
  }

  async listByUnitNo(plantId: string, unitNo: string): Promise<SuspectRecordRecord[]> {
    const r = await this.client.query(
      `SELECT ${SUSPECT_COLUMNS} FROM qd_suspect_record WHERE plant_id = $1 AND unit_no = $2 ORDER BY raised_at, id`,
      [plantId, unitNo],
    )
    return r.rows.map(mapSuspect)
  }
}

// ---------------- 处置记录（0014 qd_disposition_record） ----------------

const DISPOSITION_COLUMNS = `id, disposition_no, disposition_kind, target_type, target_id, decided_by, decided_at,
  basis, reason, destination_kind, destination_note, quantity, uom_code, transaction_id, rework_task_id,
  concession_scope, approver, command_receipt_id, plant_id, enterprise_id, business_time, created_at`

interface DispositionRow {
  id: string
  disposition_no: string
  disposition_kind: string
  target_type: string
  target_id: string
  decided_by: string
  decided_at: Date | string
  basis: string | null
  reason: string | null
  destination_kind: string | null
  destination_note: string | null
  quantity: string | null
  uom_code: string | null
  transaction_id: string | null
  rework_task_id: string | null
  concession_scope: unknown
  approver: string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
}

function mapDisposition(r: DispositionRow): DispositionFactRecord {
  return {
    id: r.id,
    dispositionNo: r.disposition_no,
    dispositionKind: r.disposition_kind as QdDispositionKind,
    targetType: r.target_type,
    targetId: r.target_id,
    decidedBy: r.decided_by,
    decidedAt: iso(r.decided_at),
    basis: r.basis,
    reason: r.reason,
    destinationKind: (r.destination_kind as 'scrap' | 'rework' | 'other' | null) ?? null,
    destinationNote: r.destination_note,
    quantity: r.quantity === null ? null : String(r.quantity),
    uomCode: r.uom_code,
    transactionId: r.transaction_id,
    reworkTaskId: r.rework_task_id,
    concessionScope: r.concession_scope,
    approver: r.approver,
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
  }
}

export class PgDispositionFactRepository implements DispositionFactRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(fact: NewDispositionFact): Promise<DispositionFactRecord> {
    const r = await this.client.query(
      `INSERT INTO qd_disposition_record (id, disposition_no, disposition_kind, target_type, target_id,
         decided_by, decided_at, basis, reason, destination_kind, destination_note, quantity, uom_code,
         transaction_id, rework_task_id, concession_scope, approver, command_receipt_id, plant_id, enterprise_id, created_by)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20, $21)
       RETURNING ${DISPOSITION_COLUMNS}`,
      [
        fact.id ?? null,
        fact.dispositionNo,
        fact.dispositionKind,
        fact.targetType,
        fact.targetId,
        fact.decidedBy,
        fact.decidedAt,
        fact.basis ?? null,
        fact.reason ?? null,
        fact.destinationKind ?? null,
        fact.destinationNote ?? null,
        fact.quantity ?? null,
        fact.uomCode ?? null,
        fact.transactionId ?? null,
        fact.reworkTaskId ?? null,
        JSON.stringify(fact.concessionScope ?? null),
        fact.approver ?? null,
        fact.commandReceiptId ?? null,
        fact.plantId,
        fact.enterpriseId,
        fact.createdBy ?? null,
      ],
    )
    return mapDisposition(r.rows[0]!)
  }

  async findById(id: string): Promise<DispositionFactRecord | null> {
    const r = await this.client.query(`SELECT ${DISPOSITION_COLUMNS} FROM qd_disposition_record WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapDisposition(r.rows[0])
  }

  async findByNo(dispositionNo: string): Promise<DispositionFactRecord | null> {
    const r = await this.client.query(`SELECT ${DISPOSITION_COLUMNS} FROM qd_disposition_record WHERE disposition_no = $1`, [dispositionNo])
    return r.rows[0] === undefined ? null : mapDisposition(r.rows[0])
  }

  async listByTarget(targetType: string, targetId: string): Promise<DispositionFactRecord[]> {
    const r = await this.client.query(
      `SELECT ${DISPOSITION_COLUMNS} FROM qd_disposition_record WHERE target_type = $1 AND target_id = $2 ORDER BY decided_at, id`,
      [targetType, targetId],
    )
    return r.rows.map(mapDisposition)
  }

  async listByUnitNo(plantId: string, unitNo: string, limit: number): Promise<DispositionFactRecord[]> {
    const r = await this.client.query(
      `SELECT ${DISPOSITION_COLUMNS} FROM qd_disposition_record
       WHERE plant_id = $1 AND (
         (target_type = 'inventory_unit' AND target_id IN (SELECT id FROM inventory_unit WHERE plant_id = $1 AND unit_no = $2))
         OR (target_type = 'qd_suspect_record' AND target_id IN (
              SELECT qsr.id FROM qd_suspect_record qsr
              JOIN inventory_unit iu ON iu.id = qsr.inventory_unit_id
              WHERE qsr.plant_id = $1 AND iu.unit_no = $2))
       )
       ORDER BY decided_at DESC, id LIMIT $3`,
      [plantId, unitNo, limit],
    )
    return r.rows.map(mapDisposition)
  }
}

// ---------------- 成品异常（0014 finished_goods_defect） ----------------

const DEFECT_COLUMNS = `id, defect_no, inventory_unit_id, unit_no, material_id, material_code, defect_type,
  defect_qty, uom_code, review_status, submitted_by, submitted_at, reviewed_by, reviewed_at,
  destination_kind, destination_note, adjust_reason, deduction_transaction_ids, command_receipt_id,
  production_dept_id, production_dept_name, plant_id, enterprise_id, business_time, created_at, updated_at`

interface DefectRow {
  id: string
  defect_no: string
  inventory_unit_id: string
  unit_no: string
  material_id: string
  material_code: string
  defect_type: string
  defect_qty: string
  uom_code: string
  review_status: string
  submitted_by: string
  submitted_at: Date | string
  reviewed_by: string | null
  reviewed_at: Date | string | null
  destination_kind: string | null
  destination_note: string | null
  adjust_reason: string | null
  deduction_transaction_ids: unknown
  command_receipt_id: string | null
  production_dept_id: string | null
  production_dept_name: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  updated_at: Date | string
}

function mapDefect(r: DefectRow): FinishedGoodsDefectRecord {
  return {
    id: r.id,
    defectNo: r.defect_no,
    unitId: r.inventory_unit_id,
    unitNo: r.unit_no,
    materialId: r.material_id,
    materialCode: r.material_code,
    defectType: r.defect_type as 'rework' | 'scrap',
    defectQty: String(r.defect_qty),
    uomCode: r.uom_code,
    reviewStatus: r.review_status as 'unreviewed' | 'approved' | 'rejected',
    submittedBy: r.submitted_by,
    submittedAt: iso(r.submitted_at),
    reviewedBy: r.reviewed_by,
    reviewedAt: isoOrNull(r.reviewed_at),
    destinationKind: (r.destination_kind as 'scrap' | 'rework' | 'other' | null) ?? null,
    destinationNote: r.destination_note,
    adjustReason: r.adjust_reason,
    deductionTransactionIds: r.deduction_transaction_ids,
    commandReceiptId: r.command_receipt_id,
    productionDeptId: r.production_dept_id,
    productionDeptName: r.production_dept_name,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

export class PgFinishedGoodsDefectRepository implements FinishedGoodsDefectRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(defect: NewFinishedGoodsDefect): Promise<FinishedGoodsDefectRecord> {
    const r = await this.client.query(
      `INSERT INTO finished_goods_defect (defect_no, inventory_unit_id, unit_no, material_id, material_code,
         defect_type, defect_qty, uom_code, review_status, submitted_by, submitted_at, production_dept_id,
         production_dept_name, command_receipt_id, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'unreviewed', $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING ${DEFECT_COLUMNS}`,
      [
        defect.defectNo,
        defect.unitId,
        defect.unitNo,
        defect.materialId,
        defect.materialCode,
        defect.defectType,
        defect.defectQty,
        defect.uomCode,
        defect.submittedBy,
        defect.submittedAt,
        defect.productionDeptId ?? null,
        defect.productionDeptName ?? null,
        defect.commandReceiptId ?? null,
        defect.plantId,
        defect.enterpriseId,
        defect.createdBy ?? null,
      ],
    )
    return mapDefect(r.rows[0]!)
  }

  async findByNo(defectNo: string): Promise<FinishedGoodsDefectRecord | null> {
    const r = await this.client.query(`SELECT ${DEFECT_COLUMNS} FROM finished_goods_defect WHERE defect_no = $1`, [defectNo])
    return r.rows[0] === undefined ? null : mapDefect(r.rows[0])
  }

  async findById(id: string): Promise<FinishedGoodsDefectRecord | null> {
    const r = await this.client.query(`SELECT ${DEFECT_COLUMNS} FROM finished_goods_defect WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapDefect(r.rows[0])
  }

  async findOpenByUnitMaterial(unitId: string, materialId: string): Promise<FinishedGoodsDefectRecord | null> {
    const r = await this.client.query(
      `SELECT ${DEFECT_COLUMNS} FROM finished_goods_defect
       WHERE inventory_unit_id = $1 AND material_id = $2 AND review_status = 'unreviewed'
       ORDER BY submitted_at DESC LIMIT 1`,
      [unitId, materialId],
    )
    return r.rows[0] === undefined ? null : mapDefect(r.rows[0])
  }

  async applyReview(
    id: string,
    patch: {
      reviewStatus: 'approved' | 'rejected'
      reviewedBy: string
      reviewedAt: string
      destinationKind?: 'scrap' | 'rework' | 'other' | null
      destinationNote?: string | null
      adjustReason?: string | null
      deductionTransactionIds?: unknown
    },
    actor: string | null,
  ): Promise<FinishedGoodsDefectRecord | null> {
    const r = await this.client.query(
      `UPDATE finished_goods_defect SET
         review_status = $2, reviewed_by = $3, reviewed_at = $4,
         destination_kind = COALESCE($5, destination_kind), destination_note = COALESCE($6, destination_note),
         adjust_reason = COALESCE($7, adjust_reason),
         deduction_transaction_ids = COALESCE($8::jsonb, deduction_transaction_ids),
         updated_at = now(), updated_by = $9
       WHERE id = $1
       RETURNING ${DEFECT_COLUMNS}`,
      [
        id,
        patch.reviewStatus,
        patch.reviewedBy,
        patch.reviewedAt,
        patch.destinationKind ?? null,
        patch.destinationNote ?? null,
        patch.adjustReason ?? null,
        patch.deductionTransactionIds === undefined ? null : JSON.stringify(patch.deductionTransactionIds),
        actor,
      ],
    )
    return r.rows[0] === undefined ? null : mapDefect(r.rows[0])
  }

  async listPaged(filter: {
    enterpriseId: string
    plantIds: string[] | null
    plantId?: string
    unitNoLike?: string
    reviewStatus?: string
    page: number
    pageSize: number
  }): Promise<{ items: FinishedGoodsDefectRecord[]; total: number }> {
    const conditions = ['enterprise_id = $1']
    const values: unknown[] = [filter.enterpriseId]
    if (filter.plantIds !== null && filter.plantIds.length > 0) {
      values.push(filter.plantIds)
      conditions.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.plantId !== undefined) {
      values.push(filter.plantId)
      conditions.push(`plant_id = $${values.length}`)
    }
    if (filter.unitNoLike !== undefined) {
      values.push(`%${filter.unitNoLike}%`)
      conditions.push(`unit_no LIKE $${values.length}`)
    }
    if (filter.reviewStatus !== undefined) {
      values.push(filter.reviewStatus)
      conditions.push(`review_status = $${values.length}`)
    }
    const where = conditions.join(' AND ')
    const count = await this.client.query(`SELECT count(*)::text AS total FROM finished_goods_defect WHERE ${where}`, values)
    const total = Number(count.rows[0]?.total ?? '0')
    const offset = Math.max(0, (filter.page - 1) * filter.pageSize)
    values.push(filter.pageSize, offset)
    const r = await this.client.query(
      `SELECT ${DEFECT_COLUMNS} FROM finished_goods_defect WHERE ${where} ORDER BY submitted_at DESC, id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return { items: r.rows.map(mapDefect), total }
  }
}

// ---------------- 采购批次/明细端口（0006 既有表） ----------------

interface BatchRow {
  id: string
  batch_no: string
  purchase_line_id: string
  material_id: string
  material_code: string
  inspection_status: string
  storage_status: string
  plant_id: string
  enterprise_id: string
}

export class PgPurchaseBatchQcPort implements PurchaseBatchQcPort {
  constructor(private readonly client: SqlClient) {}

  private async find(where: string, value: string): Promise<PurchaseBatchQcProjection | null> {
    const r = await this.client.query(
      `SELECT id, batch_no, purchase_line_id, material_id, material_code, inspection_status, storage_status,
         plant_id, enterprise_id FROM purchase_receipt_batch WHERE ${where} = $1`,
      [value],
    )
    const row = r.rows[0] as BatchRow
    if (row === undefined) return null
    return {
      id: row.id,
      batchNo: row.batch_no,
      purchaseLineId: row.purchase_line_id,
      materialId: row.material_id,
      materialCode: row.material_code,
      inspectionStatus: row.inspection_status as PurchaseBatchQcProjection['inspectionStatus'],
      storageStatus: row.storage_status as 'stored' | 'returned',
      plantId: row.plant_id,
      enterpriseId: row.enterprise_id,
    }
  }

  async findByNo(batchNo: string): Promise<PurchaseBatchQcProjection | null> {
    return this.find('batch_no', batchNo)
  }

  async findById(id: string): Promise<PurchaseBatchQcProjection | null> {
    return this.find('id', id)
  }

  async updateInspectionStatus(batchId: string, status: BatchInspectionStatusValue, actor: string | null): Promise<void> {
    await this.client.query(
      `UPDATE purchase_receipt_batch SET inspection_status = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
      [batchId, status, actor],
    )
  }

  async listDetails(batchId: string): Promise<ReceiptDetailQcView[]> {
    const r = await this.client.query(
      `SELECT rd.id AS detail_id, rd.batch_id, rd.inventory_unit_id, iu.unit_no, rd.barcode_value,
         rd.quality_status, rd.quantity::text AS quantity, rd.uom_code
       FROM receipt_detail rd
       LEFT JOIN inventory_unit iu ON iu.id = rd.inventory_unit_id
       WHERE rd.batch_id = $1
       ORDER BY rd.created_at, rd.id`,
      [batchId],
    )
    return r.rows.map((row) => ({
      detailId: row.detail_id,
      batchId: row.batch_id,
      unitId: row.inventory_unit_id,
      unitNo: row.unit_no,
      barcodeValue: row.barcode_value,
      qualityStatus: row.quality_status,
      quantity: String(row.quantity),
      uomCode: row.uom_code,
    }))
  }

  async findWarehouseKindsByUnitNo(plantId: string, unitNo: string): Promise<string[]> {
    const r = await this.client.query(
      `SELECT DISTINCT w.warehouse_type
       FROM stock_balance sb
       JOIN inventory_unit iu ON iu.id = sb.unit_id
       JOIN storage_location sl ON sl.id = sb.location_id
       JOIN warehouse w ON w.id = sl.warehouse_id
       WHERE sb.status = 'active' AND sb.plant_id = $1 AND iu.unit_no = $2`,
      [plantId, unitNo],
    )
    return r.rows.map((row) => row.warehouse_type)
  }
}

// ---------------- 检验记录版本链（0006 inspection_record） ----------------

const INSPECTION_COLUMNS = `id, batch_id, detail_id, barcode_value, inspection_type, version, conclusion,
  is_effective, source, inspector, inspected_at, attachments, command_receipt_id, created_at`

interface InspectionRow {
  id: string
  batch_id: string
  detail_id: string
  barcode_value: string
  inspection_type: string
  version: number
  conclusion: string
  is_effective: boolean
  source: string
  inspector: string | null
  inspected_at: Date | string | null
  attachments: unknown
  command_receipt_id: string | null
  created_at: Date | string
}

function mapInspection(r: InspectionRow): DispositionInspectionRecordRow {
  return {
    id: r.id,
    batchId: r.batch_id,
    detailId: r.detail_id,
    barcodeValue: r.barcode_value,
    inspectionType: r.inspection_type as 'first' | 're',
    version: r.version,
    conclusion: r.conclusion as DispositionInspectionRecordRow['conclusion'],
    isEffective: r.is_effective,
    source: r.source as DispositionInspectionRecordRow['source'],
    inspector: r.inspector,
    inspectedAt: isoOrNull(r.inspected_at),
    attachments: r.attachments,
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
  }
}

export class PgInspectionChainRepository implements InspectionChainRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(record: NewDispositionInspectionRecord): Promise<DispositionInspectionRecordRow> {
    const r = await this.client.query(
      `INSERT INTO inspection_record (batch_id, detail_id, barcode_value, inspection_type, version,
         conclusion, is_effective, source, inspector, inspected_at, attachments, command_receipt_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       RETURNING ${INSPECTION_COLUMNS}`,
      [
        record.batchId,
        record.detailId,
        record.barcodeValue,
        record.inspectionType,
        record.version,
        record.conclusion,
        true,
        record.source,
        record.inspector ?? null,
        record.inspectedAt ?? null,
        JSON.stringify(record.attachments ?? []),
        record.commandReceiptId ?? null,
        record.createdBy ?? null,
      ],
    )
    return mapInspection(r.rows[0]!)
  }

  async markIneffective(recordId: string, actor: string | null): Promise<void> {
    // 0006 cadenza_purchase_history_guard：仅允许 is_effective 指针翻转（事实列锁定）
    await this.client.query(
      `UPDATE inspection_record SET is_effective = false, updated_at = now(), updated_by = $2 WHERE id = $1`,
      [recordId, actor],
    )
  }

  async findEffectiveForDetail(detailId: string): Promise<DispositionInspectionRecordRow | null> {
    // QD-11 口径：有复检则复检行，否则首检行
    const re = await this.client.query(
      `SELECT ${INSPECTION_COLUMNS} FROM inspection_record
       WHERE detail_id = $1 AND inspection_type = 're' AND is_effective
       ORDER BY version DESC LIMIT 1`,
      [detailId],
    )
    if (re.rows[0] !== undefined) return mapInspection(re.rows[0])
    const first = await this.client.query(
      `SELECT ${INSPECTION_COLUMNS} FROM inspection_record
       WHERE detail_id = $1 AND inspection_type = 'first' AND is_effective
       ORDER BY version DESC LIMIT 1`,
      [detailId],
    )
    return first.rows[0] === undefined ? null : mapInspection(first.rows[0])
  }

  async listChainForDetail(detailId: string): Promise<DispositionInspectionRecordRow[]> {
    const r = await this.client.query(
      `SELECT ${INSPECTION_COLUMNS} FROM inspection_record WHERE detail_id = $1 ORDER BY version, id`,
      [detailId],
    )
    return r.rows.map(mapInspection)
  }

  async countReInspection(detailId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::text AS total FROM inspection_record WHERE detail_id = $1 AND inspection_type = 're'`,
      [detailId],
    )
    return Number(r.rows[0]?.total ?? '0')
  }

  async maxVersion(detailId: string, inspectionType: 'first' | 're'): Promise<number> {
    const r = await this.client.query(
      `SELECT max(version)::text AS max FROM inspection_record WHERE detail_id = $1 AND inspection_type = $2`,
      [detailId, inspectionType],
    )
    return r.rows[0]?.max === null || r.rows[0]?.max === undefined ? 0 : Number(r.rows[0].max)
  }

  async listEffectiveByBatch(batchId: string): Promise<DispositionInspectionRecordRow[]> {
    // 各明细当前生效行（复检链优先）；每明细至多一行
    const r = await this.client.query(
      `SELECT ${INSPECTION_COLUMNS} FROM inspection_record ir
       WHERE ir.batch_id = $1 AND ir.is_effective AND (
         ir.inspection_type = 're'
         OR NOT EXISTS (
           SELECT 1 FROM inspection_record ir2
           WHERE ir2.detail_id = ir.detail_id AND ir2.inspection_type = 're' AND ir2.is_effective
         )
       )
       ORDER BY ir.detail_id, ir.inspection_type`,
      [batchId],
    )
    return r.rows.map(mapInspection)
  }

  async updateDetailQualityStatus(detailId: string, qualityStatus: string, actor: string | null): Promise<void> {
    await this.client.query(
      `UPDATE receipt_detail SET quality_status = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
      [detailId, qualityStatus, actor],
    )
  }
}

// ---------------- 批次判定版本链（0006 batch_judgement） ----------------

const JUDGEMENT_COLUMNS = `id, batch_id, version, conclusion, judge_by, judged_at, note, attachments,
  is_effective, command_receipt_id, created_at`

interface JudgementRow {
  id: string
  batch_id: string
  version: number
  conclusion: string
  judge_by: string
  judged_at: Date | string
  note: string | null
  attachments: unknown
  is_effective: boolean
  command_receipt_id: string | null
  created_at: Date | string
}

function mapJudgement(r: JudgementRow): BatchJudgementRow {
  return {
    id: r.id,
    batchId: r.batch_id,
    version: r.version,
    conclusion: r.conclusion as 'qualified' | 'unqualified',
    judgeBy: r.judge_by,
    judgedAt: iso(r.judged_at),
    note: r.note,
    attachments: r.attachments,
    isEffective: r.is_effective,
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
  }
}

export class PgBatchJudgementPort implements BatchJudgementPort {
  constructor(private readonly client: SqlClient) {}

  async insert(judgement: NewBatchJudgement): Promise<BatchJudgementRow> {
    const r = await this.client.query(
      `INSERT INTO batch_judgement (batch_id, version, conclusion, judge_by, judged_at, note, attachments,
         is_effective, command_receipt_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       RETURNING ${JUDGEMENT_COLUMNS}`,
      [
        judgement.batchId,
        judgement.version,
        judgement.conclusion,
        judgement.judgeBy,
        judgement.judgedAt,
        judgement.note,
        JSON.stringify(judgement.attachments ?? []),
        judgement.isEffective,
        judgement.commandReceiptId ?? null,
        judgement.createdBy ?? null,
      ],
    )
    return mapJudgement(r.rows[0]!)
  }

  async markIneffective(judgementId: string, actor: string | null): Promise<void> {
    await this.client.query(
      `UPDATE batch_judgement SET is_effective = false, updated_at = now(), updated_by = $2 WHERE id = $1`,
      [judgementId, actor],
    )
  }

  async listChainByBatch(batchId: string): Promise<BatchJudgementRow[]> {
    const r = await this.client.query(
      `SELECT ${JUDGEMENT_COLUMNS} FROM batch_judgement WHERE batch_id = $1 ORDER BY version, id`,
      [batchId],
    )
    return r.rows.map(mapJudgement)
  }

  async findEffective(batchId: string): Promise<BatchJudgementRow | null> {
    const r = await this.client.query(
      `SELECT ${JUDGEMENT_COLUMNS} FROM batch_judgement WHERE batch_id = $1 AND is_effective ORDER BY version DESC LIMIT 1`,
      [batchId],
    )
    return r.rows[0] === undefined ? null : mapJudgement(r.rows[0])
  }

  async maxVersion(batchId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT max(version)::text AS max FROM batch_judgement WHERE batch_id = $1`,
      [batchId],
    )
    return r.rows[0]?.max === null || r.rows[0]?.max === undefined ? 0 : Number(r.rows[0].max)
  }
}

// ---------------- 追溯/下游使用（QD-16；0004 genealogy_edge + stock_transaction） ----------------

export class PgTraceabilityPort implements TraceabilityPort {
  constructor(private readonly client: SqlClient) {}

  async downstreamConsumedByBatch(batchId: string): Promise<boolean> {
    const r = await this.client.query(
      `SELECT (
         EXISTS (
           SELECT 1 FROM receipt_detail rd
           JOIN inventory_unit iu ON iu.id = rd.inventory_unit_id
           JOIN genealogy_edge ge ON ge.from_type = 'material_lot' AND ge.from_id = iu.lot_id
             AND ge.edge_kind = 'consumption'
           WHERE rd.batch_id = $1
         )
         OR EXISTS (
           SELECT 1 FROM receipt_detail rd
           JOIN stock_transaction st ON st.unit_id = rd.inventory_unit_id
             AND st.movement_kind IN ('issue', 'transfer_out')
           WHERE rd.batch_id = $1
         )
       ) AS consumed`,
      [batchId],
    )
    return r.rows[0]?.consumed === true
  }

  async forwardImpactByBatch(batchId: string): Promise<Array<{ toType: string; toId: string; edgeKind: string; quantity: string }>> {
    const r = await this.client.query(
      `SELECT ge.to_type, ge.to_id, ge.edge_kind, ge.quantity::text AS quantity
       FROM receipt_detail rd
       JOIN inventory_unit iu ON iu.id = rd.inventory_unit_id
       JOIN genealogy_edge ge ON ge.from_type = 'material_lot' AND ge.from_id = iu.lot_id
       WHERE rd.batch_id = $1
       ORDER BY ge.created_at, ge.id`,
      [batchId],
    )
    return r.rows.map((row) => ({ toType: row.to_type, toId: row.to_id, edgeKind: row.edge_kind, quantity: String(row.quantity) }))
  }
}

// ---------------- 返工任务（0014 qd_rework_task） ----------------

const REWORK_COLUMNS = `id, task_no, disposition_id, origin_unit_id, origin_unit_no, origin_process_order_no,
  origin_operation, status, note, plant_id, enterprise_id, created_at, created_by`

interface ReworkRow {
  id: string
  task_no: string
  disposition_id: string
  origin_unit_id: string
  origin_unit_no: string
  origin_process_order_no: string
  origin_operation: string | null
  status: string
  note: string | null
  plant_id: string
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
}

function mapRework(r: ReworkRow): ReworkTaskRecord {
  return {
    id: r.id,
    taskNo: r.task_no,
    dispositionId: r.disposition_id,
    originUnitId: r.origin_unit_id,
    originUnitNo: r.origin_unit_no,
    originProcessOrderNo: r.origin_process_order_no,
    originOperation: r.origin_operation,
    status: r.status as 'created' | 'in_progress' | 'done',
    note: r.note,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgReworkTaskRepository implements ReworkTaskRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(task: NewReworkTask): Promise<ReworkTaskRecord> {
    const r = await this.client.query(
      `INSERT INTO qd_rework_task (task_no, disposition_id, origin_unit_id, origin_unit_no,
         origin_process_order_no, origin_operation, status, note, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'created', $7, $8, $9, $10)
       RETURNING ${REWORK_COLUMNS}`,
      [
        task.taskNo,
        task.dispositionId,
        task.originUnitId,
        task.originUnitNo,
        task.originProcessOrderNo,
        task.originOperation ?? null,
        task.note ?? null,
        task.plantId,
        task.enterpriseId,
        task.createdBy ?? null,
      ],
    )
    return mapRework(r.rows[0]!)
  }

  async findByNo(taskNo: string): Promise<ReworkTaskRecord | null> {
    const r = await this.client.query(`SELECT ${REWORK_COLUMNS} FROM qd_rework_task WHERE task_no = $1`, [taskNo])
    return r.rows[0] === undefined ? null : mapRework(r.rows[0])
  }

  async findById(id: string): Promise<ReworkTaskRecord | null> {
    const r = await this.client.query(`SELECT ${REWORK_COLUMNS} FROM qd_rework_task WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapRework(r.rows[0])
  }
}

// ---------------- 组装 ----------------

export function createPgDispositionRepositories(client: SqlClient) {
  return {
    suspectRecords: new PgSuspectRecordRepository(client),
    dispositions: new PgDispositionFactRepository(client),
    defects: new PgFinishedGoodsDefectRepository(client),
    batchQc: new PgPurchaseBatchQcPort(client),
    inspectionChain: new PgInspectionChainRepository(client),
    judgements: new PgBatchJudgementPort(client),
    reworkTasks: new PgReworkTaskRepository(client),
    trace: new PgTraceabilityPort(client),
  }
}
