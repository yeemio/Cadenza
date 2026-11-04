// L0 整合步（Wave5）：application index 已导出 quality 面；type-only 跨包导入改包名
// （原 dist 相对导入删除；不得相对引用 application/src/**：各包 tsconfig.build.json 置空
// paths 且限 rootDir=src）。
import type {
  DispositionRecord,
  DispositionRepository,
  InspectionOrderRecord,
  InspectionOrderRepository,
  NewInspectionOrder,
  NewQualityHold,
  NewTestResult,
  QualityHoldRecord,
  QualityHoldRepository,
  QualityRepositories,
  TestResultRecord,
  TestResultRepository,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

/**
 * quality 域仓储的 PostgreSQL 实现（implements application 端口；0009 quality 表列一一对应）。
 * - 全部参数化查询；numeric(18,4) 以字符串往返（定点保真）；
 * - timestamptz 出参 ISO-8601 字符串；jsonb 由 pg 驱动解析；
 * - quality_test_result / quality_disposition 的 setEffective / release 仅更新允许列
 *   （S14 守卫触发器锁定事实列，UPDATE 事实列/DELETE 由库层拒绝）。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

// ---------------- quality_inspection_order ----------------

const ORDER_COLUMNS = `id, order_no, source_type, source_ref, inspection_stage, spec_code, spec_version,
  inventory_unit_id, unit_no, material_id, material_code, lot_id, quantity::text AS quantity,
  uom_id, uom_code, status, production_order_no, production_dept_id, production_dept_name,
  plant_id, enterprise_id, business_time, created_at, updated_at`

interface OrderRow {
  id: string
  order_no: string
  source_type: InspectionOrderRecord['sourceType']
  source_ref: string
  inspection_stage: InspectionOrderRecord['inspectionStage']
  spec_code: string
  spec_version: number
  inventory_unit_id: string | null
  unit_no: string | null
  material_id: string
  material_code: string
  lot_id: string | null
  quantity: string
  uom_id: string
  uom_code: string
  status: InspectionOrderRecord['status']
  production_order_no: string | null
  production_dept_id: string | null
  production_dept_name: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  updated_at: Date | string
}

function mapOrder(r: OrderRow): InspectionOrderRecord {
  return {
    id: r.id,
    orderNo: r.order_no,
    sourceType: r.source_type,
    sourceRef: r.source_ref,
    inspectionStage: r.inspection_stage,
    specCode: r.spec_code,
    specVersion: r.spec_version,
    inventoryUnitId: r.inventory_unit_id,
    unitNo: r.unit_no,
    materialId: r.material_id,
    materialCode: r.material_code,
    lotId: r.lot_id,
    quantity: r.quantity,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    status: r.status,
    productionOrderNo: r.production_order_no,
    productionDeptId: r.production_dept_id,
    productionDeptName: r.production_dept_name,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

export class PgInspectionOrderRepository implements InspectionOrderRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string, forUpdate = false): Promise<InspectionOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM quality_inspection_order WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async findBySource(
    sourceType: InspectionOrderRecord['sourceType'],
    sourceRef: string,
    inspectionStage: InspectionOrderRecord['inspectionStage'],
  ): Promise<InspectionOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM quality_inspection_order
       WHERE source_type = $1 AND source_ref = $2 AND inspection_stage = $3`,
      [sourceType, sourceRef, inspectionStage],
    )
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async insert(order: NewInspectionOrder): Promise<InspectionOrderRecord> {
    const r = await this.client.query(
      `INSERT INTO quality_inspection_order
         (order_no, source_type, source_ref, inspection_stage, spec_code, spec_version, unit_no,
          material_id, material_code, lot_id, quantity, uom_id, uom_code, production_order_no,
          production_dept_id, production_dept_name, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING ${ORDER_COLUMNS}`,
      [
        order.orderNo,
        order.sourceType,
        order.sourceRef,
        order.inspectionStage,
        order.specCode,
        order.specVersion,
        order.unitNo ?? null,
        order.materialId,
        order.materialCode,
        order.lotId ?? null,
        order.quantity,
        order.uomId,
        order.uomCode,
        order.productionOrderNo ?? null,
        order.productionDeptId ?? null,
        order.productionDeptName ?? null,
        order.plantId,
        order.enterpriseId,
        order.createdBy ?? null,
      ],
    )
    return mapOrder(r.rows[0] as OrderRow)
  }

  async updateStatus(
    id: string,
    status: InspectionOrderRecord['status'],
    actor: string | null,
  ): Promise<InspectionOrderRecord | null> {
    const r = await this.client.query(
      `UPDATE quality_inspection_order SET status = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${ORDER_COLUMNS}`,
      [id, status, actor],
    )
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    stages?: string[]
    orderNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: InspectionOrderRecord[]; total: number }> {
    const conds: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null) {
      params.push(filter.plantIds)
      conds.push(`plant_id = ANY($${params.length}::uuid[])`)
    }
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      conds.push(`plant_id = $${params.length}::uuid`)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      params.push(filter.statuses)
      conds.push(`status = ANY($${params.length}::text[])`)
    }
    if (filter.stages !== undefined && filter.stages.length > 0) {
      params.push(filter.stages)
      conds.push(`inspection_stage = ANY($${params.length}::text[])`)
    }
    if (filter.orderNoLike !== undefined) {
      params.push(`%${filter.orderNoLike}%`)
      conds.push(`order_no LIKE $${params.length}`)
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const limitIdx = params.length - 1
    const offsetIdx = params.length
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM quality_inspection_order ${where}
       ORDER BY created_at DESC, id LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    )
    const count = await this.client.query(
      `SELECT count(*)::text AS total FROM quality_inspection_order ${where}`,
      params.slice(0, limitIdx - 1),
    )
    return { items: r.rows.map((row) => mapOrder(row as OrderRow)), total: Number(count.rows[0]!.total) }
  }
}

// ---------------- quality_test_result ----------------

interface TestResultRow {
  id: string
  inspection_order_id: string
  version: number
  conclusion: TestResultRecord['conclusion']
  items: unknown
  result_kind: TestResultRecord['resultKind']
  is_effective: boolean
  inspector: string | null
  inspected_at: Date | string | null
  command_receipt_id: string | null
  created_at: Date | string
}

function mapTestResult(r: TestResultRow): TestResultRecord {
  return {
    id: r.id,
    inspectionOrderId: r.inspection_order_id,
    version: r.version,
    conclusion: r.conclusion,
    items: r.items,
    resultKind: r.result_kind,
    isEffective: r.is_effective,
    inspector: r.inspector,
    inspectedAt: r.inspected_at === null ? null : iso(r.inspected_at),
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
  }
}

export class PgTestResultRepository implements TestResultRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(record: NewTestResult): Promise<TestResultRecord> {
    const r = await this.client.query(
      `INSERT INTO quality_test_result
         (inspection_order_id, version, conclusion, items, result_kind, is_effective, inspector,
          inspected_at, command_receipt_id, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        record.inspectionOrderId,
        record.version,
        record.conclusion,
        JSON.stringify(record.items ?? []),
        record.resultKind ?? 'test',
        record.isEffective ?? false,
        record.inspector ?? null,
        record.inspectedAt ?? null,
        record.commandReceiptId ?? null,
        record.createdBy ?? null,
      ],
    )
    return mapTestResult(r.rows[0] as TestResultRow)
  }

  async listByOrder(inspectionOrderId: string): Promise<TestResultRecord[]> {
    const r = await this.client.query(
      `SELECT * FROM quality_test_result WHERE inspection_order_id = $1 ORDER BY version`,
      [inspectionOrderId],
    )
    return r.rows.map((row) => mapTestResult(row as TestResultRow))
  }

  async findEffective(inspectionOrderId: string): Promise<TestResultRecord | null> {
    const r = await this.client.query(
      `SELECT * FROM quality_test_result WHERE inspection_order_id = $1 AND is_effective`,
      [inspectionOrderId],
    )
    return r.rows[0] === undefined ? null : mapTestResult(r.rows[0] as TestResultRow)
  }

  async setEffective(id: string, isEffective: boolean, actor: string | null): Promise<void> {
    // S14 指针翻转：仅更新 is_effective（守卫触发器锁定事实列）
    await this.client.query(
      `UPDATE quality_test_result SET is_effective = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
      [id, isEffective, actor],
    )
  }
}

// ---------------- quality_disposition ----------------

interface DispositionRow {
  id: string
  inspection_order_id: string
  disposition_kind: DispositionRecord['dispositionKind']
  based_on_version: number
  released_by: string
  released_at: Date | string
  reason: string | null
  command_receipt_id: string | null
  created_at: Date | string
}

function mapDisposition(r: DispositionRow): DispositionRecord {
  return {
    id: r.id,
    inspectionOrderId: r.inspection_order_id,
    dispositionKind: r.disposition_kind,
    basedOnVersion: r.based_on_version,
    releasedBy: r.released_by,
    releasedAt: iso(r.released_at),
    reason: r.reason,
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
  }
}

export class PgDispositionRepository implements DispositionRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(input: {
    inspectionOrderId: string
    dispositionKind: 'release' | 'concession'
    basedOnVersion: number
    releasedBy: string
    releasedAt: string
    reason?: string | null
    commandReceiptId?: string | null
  }): Promise<DispositionRecord> {
    const r = await this.client.query(
      `INSERT INTO quality_disposition
         (inspection_order_id, disposition_kind, based_on_version, released_by, released_at, reason, command_receipt_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        input.inspectionOrderId,
        input.dispositionKind,
        input.basedOnVersion,
        input.releasedBy,
        input.releasedAt,
        input.reason ?? null,
        input.commandReceiptId ?? null,
        input.releasedBy,
      ],
    )
    return mapDisposition(r.rows[0] as DispositionRow)
  }

  async listByOrder(inspectionOrderId: string): Promise<DispositionRecord[]> {
    const r = await this.client.query(
      `SELECT * FROM quality_disposition WHERE inspection_order_id = $1 ORDER BY created_at, id`,
      [inspectionOrderId],
    )
    return r.rows.map((row) => mapDisposition(row as DispositionRow))
  }
}

// ---------------- quality_hold ----------------

const HOLD_COLUMNS = `id, inventory_unit_id, unit_no, hold_kind, status, previous_quality_status,
  raised_by, raised_at, production_dept_id, production_dept_name, released_by, released_at,
  disposition_note, command_receipt_id, plant_id, enterprise_id, business_time, created_at, updated_at`

interface HoldRow {
  id: string
  inventory_unit_id: string
  unit_no: string
  hold_kind: QualityHoldRecord['holdKind']
  status: 'active' | 'released'
  previous_quality_status: string | null
  raised_by: string
  raised_at: Date | string
  production_dept_id: string | null
  production_dept_name: string | null
  released_by: string | null
  released_at: Date | string | null
  disposition_note: string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  updated_at: Date | string
}

function mapHold(r: HoldRow): QualityHoldRecord {
  return {
    id: r.id,
    inventoryUnitId: r.inventory_unit_id,
    unitNo: r.unit_no,
    holdKind: r.hold_kind,
    status: r.status,
    previousQualityStatus: r.previous_quality_status,
    raisedBy: r.raised_by,
    raisedAt: iso(r.raised_at),
    productionDeptId: r.production_dept_id,
    productionDeptName: r.production_dept_name,
    releasedBy: r.released_by,
    releasedAt: r.released_at === null ? null : iso(r.released_at),
    dispositionNote: r.disposition_note,
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
  }
}

export class PgQualityHoldRepository implements QualityHoldRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(hold: NewQualityHold): Promise<QualityHoldRecord> {
    const r = await this.client.query(
      `INSERT INTO quality_hold
         (inventory_unit_id, unit_no, hold_kind, previous_quality_status, raised_by, raised_at,
          production_dept_id, production_dept_name, command_receipt_id, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${HOLD_COLUMNS}`,
      [
        hold.inventoryUnitId,
        hold.unitNo,
        hold.holdKind,
        hold.previousQualityStatus ?? null,
        hold.raisedBy,
        hold.raisedAt,
        hold.productionDeptId ?? null,
        hold.productionDeptName ?? null,
        hold.commandReceiptId ?? null,
        hold.plantId,
        hold.enterpriseId,
        hold.createdBy ?? null,
      ],
    )
    return mapHold(r.rows[0] as HoldRow)
  }

  async findById(id: string, forUpdate = false): Promise<QualityHoldRecord | null> {
    const r = await this.client.query(`SELECT ${HOLD_COLUMNS} FROM quality_hold WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id])
    return r.rows[0] === undefined ? null : mapHold(r.rows[0] as HoldRow)
  }

  async findActiveByUnit(inventoryUnitId: string): Promise<QualityHoldRecord | null> {
    const r = await this.client.query(
      `SELECT ${HOLD_COLUMNS} FROM quality_hold WHERE inventory_unit_id = $1 AND status = 'active'`,
      [inventoryUnitId],
    )
    return r.rows[0] === undefined ? null : mapHold(r.rows[0] as HoldRow)
  }

  async listByUnit(inventoryUnitId: string): Promise<QualityHoldRecord[]> {
    const r = await this.client.query(
      `SELECT ${HOLD_COLUMNS} FROM quality_hold WHERE inventory_unit_id = $1 ORDER BY raised_at, id`,
      [inventoryUnitId],
    )
    return r.rows.map((row) => mapHold(row as HoldRow))
  }

  async release(
    id: string,
    patch: { releasedBy: string; releasedAt: string; dispositionNote: string },
    actor: string | null,
  ): Promise<QualityHoldRecord | null> {
    const r = await this.client.query(
      `UPDATE quality_hold SET status = 'released', released_by = $2, released_at = $3,
         disposition_note = $4, updated_at = now(), updated_by = $5
       WHERE id = $1 AND status = 'active' RETURNING ${HOLD_COLUMNS}`,
      [id, patch.releasedBy, patch.releasedAt, patch.dispositionNote, actor],
    )
    return r.rows[0] === undefined ? null : mapHold(r.rows[0] as HoldRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    holdKinds?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: QualityHoldRecord[]; total: number }> {
    const conds: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null) {
      params.push(filter.plantIds)
      conds.push(`plant_id = ANY($${params.length}::uuid[])`)
    }
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      conds.push(`plant_id = $${params.length}::uuid`)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      params.push(filter.statuses)
      conds.push(`status = ANY($${params.length}::text[])`)
    }
    if (filter.holdKinds !== undefined && filter.holdKinds.length > 0) {
      params.push(filter.holdKinds)
      conds.push(`hold_kind = ANY($${params.length}::text[])`)
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const limitIdx = params.length - 1
    const offsetIdx = params.length
    const r = await this.client.query(
      `SELECT ${HOLD_COLUMNS} FROM quality_hold ${where}
       ORDER BY raised_at DESC, id LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    )
    const count = await this.client.query(
      `SELECT count(*)::text AS total FROM quality_hold ${where}`,
      params.slice(0, limitIdx - 1),
    )
    return { items: r.rows.map((row) => mapHold(row as HoldRow)), total: Number(count.rows[0]!.total) }
  }
}

/** quality 仓储束（命令事务客户端绑定）。 */
export function createPgQualityRepositories(client: SqlClient): QualityRepositories {
  return {
    inspectionOrders: new PgInspectionOrderRepository(client),
    testResults: new PgTestResultRepository(client),
    dispositions: new PgDispositionRepository(client),
    holds: new PgQualityHoldRepository(client),
  }
}
