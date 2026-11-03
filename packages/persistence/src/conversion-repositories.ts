// 跨包类型导入（type-only，编译期擦除）：指向 application 已构建的 dist（构建顺序由 workspace
// 拓扑保证：persistence 依赖 application）。conversionform 端口尚未并入 @cadenza/application
// 包名入口（application/src/index.ts 为共享文件不改动），故走 dist 相对；[L0-整合标记]
// L0 整合步把端口导出并入 application index、本文件导出并入 persistence index 后改包名导入
// （同 shipping/quality/warehousing 先例）。
import type {
  CodeAssignmentRecord,
  CodeAssignmentRepository,
  CodeRewriteRecord,
  CodeRewriteRepository,
  ConversionMaterialView,
  ConversionOrderLineRecord,
  ConversionOrderLineRepository,
  ConversionOrderRecord,
  ConversionOrderRepository,
  ConversionOrderScanRecord,
  ConversionOrderScanRepository,
  ConversionOutboxTaskAccess,
  ConversionProcessLookups,
  ConversionRepositories,
  ConversionStockLineRecord,
  ConversionStockLineRepository,
  ConversionStockOrderRecord,
  ConversionStockOrderRepository,
  ConversionStockLookups,
  NewCodeAssignment,
  NewCodeRewrite,
  NewConversionOrder,
  NewConversionOrderLine,
  NewConversionOrderScan,
  NewConversionStockLine,
  NewConversionStockOrder,
  ConversionProductionOrderView,
  UnitStockFacts,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

/**
 * conversionform 域仓储的 PostgreSQL 实现（implements application 端口；0012 conversion 表
 * 列一一对应）。行锁方法在命令事务内 SELECT ... FOR UPDATE；扫码/归属/改码为 append-only
 * （触发器守卫）；outbox/inbox 直用 0001 表；跨域读（0005 生产订单/0008 产出行/0003 主数据/
 * 0004 库存）为只读查询，不写他域表。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

// ---------------- conversion_order（协议A 头） ----------------

const ORDER_COLUMNS = `id, conversion_no, status, sync_status, completed_by, completed_at,
  completion_snapshot, command_receipt_id, plant_id, enterprise_id, business_time,
  created_at, created_by, updated_at, updated_by`

interface OrderRow {
  id: string
  conversion_no: string
  status: ConversionOrderRecord['status']
  sync_status: ConversionOrderRecord['syncStatus']
  completed_by: string | null
  completed_at: Date | string | null
  completion_snapshot: Record<string, unknown> | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapOrder(r: OrderRow): ConversionOrderRecord {
  return {
    id: r.id,
    conversionNo: r.conversion_no,
    status: r.status,
    syncStatus: r.sync_status,
    completedBy: r.completed_by,
    completedAt: isoOrNull(r.completed_at),
    completionSnapshot: r.completion_snapshot ?? null,
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgConversionOrderRepository implements ConversionOrderRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(order: NewConversionOrder): Promise<ConversionOrderRecord> {
    const r = await this.client.query(
      `INSERT INTO conversion_order
         (conversion_no, command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${ORDER_COLUMNS}`,
      [
        order.conversionNo,
        order.commandReceiptId ?? null,
        order.plantId,
        order.enterpriseId,
        order.businessTime ?? new Date().toISOString(),
        order.createdBy ?? null,
      ],
    )
    return mapOrder(r.rows[0] as OrderRow)
  }

  async findById(id: string): Promise<ConversionOrderRecord | null> {
    const r = await this.client.query(`SELECT ${ORDER_COLUMNS} FROM conversion_order WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async lockById(id: string): Promise<ConversionOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM conversion_order WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async markCompleted(
    id: string,
    patch: { completedBy: string; completedAt: string; completionSnapshot: Record<string, unknown> },
    actor: string | null,
  ): Promise<ConversionOrderRecord | null> {
    const r = await this.client.query(
      `UPDATE conversion_order SET status = 'completed', completed_by = $2, completed_at = $3,
         completion_snapshot = $4::jsonb, updated_at = now(), updated_by = $5
       WHERE id = $1 RETURNING ${ORDER_COLUMNS}`,
      [id, patch.completedBy, patch.completedAt, JSON.stringify(patch.completionSnapshot), actor],
    )
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async updateSyncStatus(
    id: string,
    patch: { syncStatus: ConversionOrderRecord['syncStatus'] },
    actor: string | null,
  ): Promise<ConversionOrderRecord | null> {
    const r = await this.client.query(
      `UPDATE conversion_order SET sync_status = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${ORDER_COLUMNS}`,
      [id, patch.syncStatus, actor],
    )
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async deleteById(id: string): Promise<void> {
    await this.client.query(`DELETE FROM conversion_order WHERE id = $1`, [id])
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    syncStatuses?: string[]
    conversionNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: ConversionOrderRecord[]; total: number }> {
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
    if (filter.syncStatuses !== undefined && filter.syncStatuses.length > 0) {
      params.push(filter.syncStatuses)
      conds.push(`sync_status = ANY($${params.length}::text[])`)
    }
    if (filter.conversionNoLike !== undefined) {
      params.push(`%${filter.conversionNoLike}%`)
      conds.push(`conversion_no LIKE $${params.length}`)
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const limitIdx = params.length - 1
    const offsetIdx = params.length
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM conversion_order ${where}
       ORDER BY created_at DESC, id LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    )
    const count = await this.client.query(
      `SELECT count(*)::text AS total FROM conversion_order ${where}`,
      params.slice(0, limitIdx - 1),
    )
    return { items: r.rows.map((row) => mapOrder(row as OrderRow)), total: Number(count.rows[0]!.total) }
  }
}

// ---------------- conversion_order_line（协议A 明细） ----------------

const ORDER_LINE_COLUMNS = `id, conversion_order_id, line_no, source_order_id, source_sales_order_no,
  source_line_no, source_project_no, target_order_id, target_sales_order_no, target_project_no,
  material_id, material_code, planned_qty::text AS planned_qty, uom,
  scanned_qty::text AS scanned_qty, scanned_axes, created_at, created_by, updated_at, updated_by`

interface OrderLineRow {
  id: string
  conversion_order_id: string
  line_no: number
  source_order_id: string
  source_sales_order_no: string
  source_line_no: string
  source_project_no: string | null
  target_order_id: string
  target_sales_order_no: string
  target_project_no: string
  material_id: string
  material_code: string
  planned_qty: string
  uom: string
  scanned_qty: string
  scanned_axes: number
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapOrderLine(r: OrderLineRow): ConversionOrderLineRecord {
  return {
    id: r.id,
    conversionOrderId: r.conversion_order_id,
    lineNo: r.line_no,
    sourceOrderId: r.source_order_id,
    sourceSalesOrderNo: r.source_sales_order_no,
    sourceLineNo: r.source_line_no,
    sourceProjectNo: r.source_project_no,
    targetOrderId: r.target_order_id,
    targetSalesOrderNo: r.target_sales_order_no,
    targetProjectNo: r.target_project_no,
    materialId: r.material_id,
    materialCode: r.material_code,
    plannedQty: r.planned_qty,
    uom: r.uom,
    scannedQty: r.scanned_qty,
    scannedAxes: r.scanned_axes,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgConversionOrderLineRepository implements ConversionOrderLineRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(line: NewConversionOrderLine): Promise<ConversionOrderLineRecord> {
    const r = await this.client.query(
      `INSERT INTO conversion_order_line
         (conversion_order_id, line_no, source_order_id, source_sales_order_no, source_line_no,
          source_project_no, target_order_id, target_sales_order_no, target_project_no,
          material_id, material_code, planned_qty, uom, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${ORDER_LINE_COLUMNS}`,
      [
        line.conversionOrderId,
        line.lineNo,
        line.sourceOrderId,
        line.sourceSalesOrderNo,
        line.sourceLineNo,
        line.sourceProjectNo ?? null,
        line.targetOrderId,
        line.targetSalesOrderNo,
        line.targetProjectNo,
        line.materialId,
        line.materialCode,
        line.plannedQty,
        line.uom,
        line.createdBy ?? null,
      ],
    )
    return mapOrderLine(r.rows[0] as OrderLineRow)
  }

  async findById(id: string): Promise<ConversionOrderLineRecord | null> {
    const r = await this.client.query(`SELECT ${ORDER_LINE_COLUMNS} FROM conversion_order_line WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapOrderLine(r.rows[0] as OrderLineRow)
  }

  async lockById(id: string): Promise<ConversionOrderLineRecord | null> {
    const r = await this.client.query(
      `SELECT ${ORDER_LINE_COLUMNS} FROM conversion_order_line WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapOrderLine(r.rows[0] as OrderLineRow)
  }

  async listByOrder(conversionOrderId: string): Promise<ConversionOrderLineRecord[]> {
    const r = await this.client.query(
      `SELECT ${ORDER_LINE_COLUMNS} FROM conversion_order_line WHERE conversion_order_id = $1 ORDER BY line_no`,
      [conversionOrderId],
    )
    return r.rows.map((row) => mapOrderLine(row as OrderLineRow))
  }

  async updatePlannedQty(id: string, plannedQty: string, actor: string | null): Promise<ConversionOrderLineRecord | null> {
    const r = await this.client.query(
      `UPDATE conversion_order_line SET planned_qty = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${ORDER_LINE_COLUMNS}`,
      [id, plannedQty, actor],
    )
    return r.rows[0] === undefined ? null : mapOrderLine(r.rows[0] as OrderLineRow)
  }

  async deleteById(id: string): Promise<void> {
    await this.client.query(`DELETE FROM conversion_order_line WHERE id = $1`, [id])
  }

  async deleteByOrder(conversionOrderId: string): Promise<void> {
    await this.client.query(`DELETE FROM conversion_order_line WHERE conversion_order_id = $1`, [conversionOrderId])
  }

  async updateProgress(
    id: string,
    patch: { scannedQty: string; scannedAxes: number },
    actor: string | null,
  ): Promise<ConversionOrderLineRecord | null> {
    const r = await this.client.query(
      `UPDATE conversion_order_line SET scanned_qty = $2, scanned_axes = $3, updated_at = now(), updated_by = $4
       WHERE id = $1 RETURNING ${ORDER_LINE_COLUMNS}`,
      [id, patch.scannedQty, patch.scannedAxes, actor],
    )
    return r.rows[0] === undefined ? null : mapOrderLine(r.rows[0] as OrderLineRow)
  }
}

// ---------------- conversion_order_scan（协议A 扫码） ----------------

const SCAN_COLUMNS = `id, conversion_order_id, conversion_line_id, inventory_unit_id, unit_no,
  segment_length::text AS segment_length, customer_axis_no, quantity::text AS quantity,
  reservation_id, scanned_by, scanned_at, deleted, deleted_by, deleted_at,
  command_receipt_id, plant_id, enterprise_id, business_time, created_at, created_by`

interface ScanRow {
  id: string
  conversion_order_id: string
  conversion_line_id: string
  inventory_unit_id: string
  unit_no: string
  segment_length: string | null
  customer_axis_no: string | null
  quantity: string
  reservation_id: string
  scanned_by: string
  scanned_at: Date | string
  deleted: boolean
  deleted_by: string | null
  deleted_at: Date | string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapScan(r: ScanRow): ConversionOrderScanRecord {
  return {
    id: r.id,
    conversionOrderId: r.conversion_order_id,
    conversionLineId: r.conversion_line_id,
    inventoryUnitId: r.inventory_unit_id,
    unitNo: r.unit_no,
    segmentLength: r.segment_length,
    customerAxisNo: r.customer_axis_no,
    quantity: r.quantity,
    reservationId: r.reservation_id,
    scannedBy: r.scanned_by,
    scannedAt: iso(r.scanned_at),
    deleted: r.deleted,
    deletedBy: r.deleted_by,
    deletedAt: isoOrNull(r.deleted_at),
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgConversionOrderScanRepository implements ConversionOrderScanRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(scan: NewConversionOrderScan): Promise<ConversionOrderScanRecord> {
    const r = await this.client.query(
      `INSERT INTO conversion_order_scan
         (conversion_order_id, conversion_line_id, inventory_unit_id, unit_no, segment_length,
          customer_axis_no, quantity, reservation_id, scanned_by, scanned_at,
          command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ${SCAN_COLUMNS}`,
      [
        scan.conversionOrderId,
        scan.conversionLineId,
        scan.inventoryUnitId,
        scan.unitNo,
        scan.segmentLength ?? null,
        scan.customerAxisNo ?? null,
        scan.quantity,
        scan.reservationId,
        scan.scannedBy,
        scan.scannedAt,
        scan.commandReceiptId ?? null,
        scan.plantId,
        scan.enterpriseId,
        scan.businessTime ?? new Date().toISOString(),
        scan.createdBy ?? null,
      ],
    )
    return mapScan(r.rows[0] as ScanRow)
  }

  async findById(id: string): Promise<ConversionOrderScanRecord | null> {
    const r = await this.client.query(`SELECT ${SCAN_COLUMNS} FROM conversion_order_scan WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapScan(r.rows[0] as ScanRow)
  }

  async listByOrder(conversionOrderId: string): Promise<ConversionOrderScanRecord[]> {
    const r = await this.client.query(
      `SELECT ${SCAN_COLUMNS} FROM conversion_order_scan WHERE conversion_order_id = $1 ORDER BY created_at, id`,
      [conversionOrderId],
    )
    return r.rows.map((row) => mapScan(row as ScanRow))
  }

  async listActiveByOrder(conversionOrderId: string): Promise<ConversionOrderScanRecord[]> {
    const r = await this.client.query(
      `SELECT ${SCAN_COLUMNS} FROM conversion_order_scan WHERE conversion_order_id = $1 AND NOT deleted ORDER BY created_at, id`,
      [conversionOrderId],
    )
    return r.rows.map((row) => mapScan(row as ScanRow))
  }

  async findActiveByOrderAndUnitNo(conversionOrderId: string, unitNo: string): Promise<ConversionOrderScanRecord | null> {
    const r = await this.client.query(
      `SELECT ${SCAN_COLUMNS} FROM conversion_order_scan WHERE conversion_order_id = $1 AND unit_no = $2 AND NOT deleted`,
      [conversionOrderId, unitNo],
    )
    return r.rows[0] === undefined ? null : mapScan(r.rows[0] as ScanRow)
  }

  async markDeleted(
    id: string,
    patch: { deletedBy: string; deletedAt: string },
    actor: string | null,
  ): Promise<ConversionOrderScanRecord | null> {
    const r = await this.client.query(
      `UPDATE conversion_order_scan SET deleted = true, deleted_by = $2, deleted_at = $3
       WHERE id = $1 RETURNING ${SCAN_COLUMNS}`,
      [id, patch.deletedBy, patch.deletedAt],
    )
    void actor
    return r.rows[0] === undefined ? null : mapScan(r.rows[0] as ScanRow)
  }
}

// ---------------- conversion_code_assignment（协议A 归属变更） ----------------

const ASSIGNMENT_COLUMNS = `id, conversion_order_id, conversion_line_id, scan_id, inventory_unit_id,
  unit_no, from_order_id, to_order_id, assigned_by, assigned_at, command_receipt_id,
  plant_id, enterprise_id, business_time, created_at, created_by`

interface AssignmentRow {
  id: string
  conversion_order_id: string
  conversion_line_id: string
  scan_id: string
  inventory_unit_id: string
  unit_no: string
  from_order_id: string
  to_order_id: string
  assigned_by: string
  assigned_at: Date | string
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapAssignment(r: AssignmentRow): CodeAssignmentRecord {
  return {
    id: r.id,
    conversionOrderId: r.conversion_order_id,
    conversionLineId: r.conversion_line_id,
    scanId: r.scan_id,
    inventoryUnitId: r.inventory_unit_id,
    unitNo: r.unit_no,
    fromOrderId: r.from_order_id,
    toOrderId: r.to_order_id,
    assignedBy: r.assigned_by,
    assignedAt: iso(r.assigned_at),
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgCodeAssignmentRepository implements CodeAssignmentRepository {
  constructor(private readonly client: SqlClient) {}

  async insertBatch(assignments: NewCodeAssignment[]): Promise<CodeAssignmentRecord[]> {
    if (assignments.length === 0) return []
    const values: unknown[] = []
    const tuples = assignments.map((a, i) => {
      const base = i * 14
      values.push(
        a.conversionOrderId,
        a.conversionLineId,
        a.scanId,
        a.inventoryUnitId,
        a.unitNo,
        a.fromOrderId,
        a.toOrderId,
        a.assignedBy,
        a.assignedAt,
        a.commandReceiptId ?? null,
        a.plantId,
        a.enterpriseId,
        a.businessTime ?? new Date().toISOString(),
        a.createdBy ?? null,
      )
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14})`
    })
    const r = await this.client.query(
      `INSERT INTO conversion_code_assignment
         (conversion_order_id, conversion_line_id, scan_id, inventory_unit_id, unit_no,
          from_order_id, to_order_id, assigned_by, assigned_at, command_receipt_id,
          plant_id, enterprise_id, business_time, created_by)
       VALUES ${tuples.join(',')} RETURNING ${ASSIGNMENT_COLUMNS}`,
      values,
    )
    return r.rows.map((row) => mapAssignment(row as AssignmentRow))
  }

  async listByOrder(conversionOrderId: string): Promise<CodeAssignmentRecord[]> {
    const r = await this.client.query(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM conversion_code_assignment WHERE conversion_order_id = $1 ORDER BY created_at, id`,
      [conversionOrderId],
    )
    return r.rows.map((row) => mapAssignment(row as AssignmentRow))
  }
}

// ---------------- conversion_stock_order（协议B 头） ----------------

const STOCK_ORDER_COLUMNS = `id, conversion_no, internal_status, display_status, external_push_status,
  local_apply_status, u9_success, material_id, material_code, material_name, spec, color, uom,
  target_project_no, target_sales_order_no, target_line_no, target_batch_no,
  external_doc_no, external_failure_reason, submit_snapshot, completed_at, command_receipt_id,
  plant_id, enterprise_id, business_time, created_at, created_by, updated_at, updated_by`

interface StockOrderRow {
  id: string
  conversion_no: string
  internal_status: ConversionStockOrderRecord['internalStatus']
  display_status: ConversionStockOrderRecord['displayStatus']
  external_push_status: ConversionStockOrderRecord['externalPushStatus']
  local_apply_status: ConversionStockOrderRecord['localApplyStatus']
  u9_success: boolean
  material_id: string
  material_code: string
  material_name: string | null
  spec: string | null
  color: string | null
  uom: string | null
  target_project_no: string | null
  target_sales_order_no: string
  target_line_no: string
  target_batch_no: string
  external_doc_no: string | null
  external_failure_reason: string | null
  submit_snapshot: Record<string, unknown> | null
  completed_at: Date | string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapStockOrder(r: StockOrderRow): ConversionStockOrderRecord {
  return {
    id: r.id,
    conversionNo: r.conversion_no,
    internalStatus: r.internal_status,
    displayStatus: r.display_status,
    externalPushStatus: r.external_push_status,
    localApplyStatus: r.local_apply_status,
    u9Success: r.u9_success,
    materialId: r.material_id,
    materialCode: r.material_code,
    materialName: r.material_name,
    spec: r.spec,
    color: r.color,
    uom: r.uom,
    targetProjectNo: r.target_project_no,
    targetSalesOrderNo: r.target_sales_order_no,
    targetLineNo: r.target_line_no,
    targetBatchNo: r.target_batch_no,
    externalDocNo: r.external_doc_no,
    externalFailureReason: r.external_failure_reason,
    submitSnapshot: r.submit_snapshot ?? null,
    completedAt: isoOrNull(r.completed_at),
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgConversionStockOrderRepository implements ConversionStockOrderRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(order: NewConversionStockOrder): Promise<ConversionStockOrderRecord> {
    const r = await this.client.query(
      `INSERT INTO conversion_stock_order
         (conversion_no, material_id, material_code, material_name, spec, color, uom,
          target_project_no, target_sales_order_no, target_line_no, target_batch_no,
          submit_snapshot, command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17)
       RETURNING ${STOCK_ORDER_COLUMNS}`,
      [
        order.conversionNo,
        order.materialId,
        order.materialCode,
        order.materialName ?? null,
        order.spec ?? null,
        order.color ?? null,
        order.uom ?? null,
        order.targetProjectNo,
        order.targetSalesOrderNo,
        order.targetLineNo,
        order.targetBatchNo,
        JSON.stringify(order.submitSnapshot),
        order.commandReceiptId ?? null,
        order.plantId,
        order.enterpriseId,
        order.businessTime ?? new Date().toISOString(),
        order.createdBy ?? null,
      ],
    )
    return mapStockOrder(r.rows[0] as StockOrderRow)
  }

  async findById(id: string): Promise<ConversionStockOrderRecord | null> {
    const r = await this.client.query(`SELECT ${STOCK_ORDER_COLUMNS} FROM conversion_stock_order WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapStockOrder(r.rows[0] as StockOrderRow)
  }

  async lockById(id: string): Promise<ConversionStockOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${STOCK_ORDER_COLUMNS} FROM conversion_stock_order WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapStockOrder(r.rows[0] as StockOrderRow)
  }

  async updateState(
    id: string,
    patch: {
      internalStatus?: ConversionStockOrderRecord['internalStatus']
      displayStatus?: ConversionStockOrderRecord['displayStatus']
      externalPushStatus?: ConversionStockOrderRecord['externalPushStatus']
      localApplyStatus?: ConversionStockOrderRecord['localApplyStatus']
      u9Success?: boolean
      externalDocNo?: string | null
      externalFailureReason?: string | null
      completedAt?: string | null
      submitSnapshot?: Record<string, unknown>
    },
    actor: string | null,
  ): Promise<ConversionStockOrderRecord | null> {
    const r = await this.client.query(
      `UPDATE conversion_stock_order SET
         internal_status = COALESCE($2, internal_status),
         display_status = COALESCE($3, display_status),
         external_push_status = COALESCE($4, external_push_status),
         local_apply_status = COALESCE($5, local_apply_status),
         u9_success = COALESCE($6, u9_success),
         external_doc_no = COALESCE($7, external_doc_no),
         external_failure_reason = COALESCE($8, external_failure_reason),
         completed_at = COALESCE($9, completed_at),
         submit_snapshot = COALESCE($10::jsonb, submit_snapshot),
         updated_at = now(), updated_by = $11
       WHERE id = $1 RETURNING ${STOCK_ORDER_COLUMNS}`,
      [
        id,
        patch.internalStatus ?? null,
        patch.displayStatus ?? null,
        patch.externalPushStatus ?? null,
        patch.localApplyStatus ?? null,
        patch.u9Success ?? null,
        patch.externalDocNo ?? null,
        patch.externalFailureReason ?? null,
        patch.completedAt ?? null,
        patch.submitSnapshot !== undefined ? JSON.stringify(patch.submitSnapshot) : null,
        actor,
      ],
    )
    return r.rows[0] === undefined ? null : mapStockOrder(r.rows[0] as StockOrderRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    displayStatuses?: string[]
    internalStatuses?: string[]
    materialCodeLike?: string
    targetSalesOrderNoLike?: string
    targetProjectNoLike?: string
    conversionNoLike?: string
    page: number
    pageSize: number
    withAggregates?: boolean
  }): Promise<{
    items: Array<ConversionStockOrderRecord & { totalQty: string; axisCount: number }>
    total: number
  }> {
    const conds: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null) {
      params.push(filter.plantIds)
      conds.push(`o.plant_id = ANY($${params.length}::uuid[])`)
    }
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      conds.push(`o.plant_id = $${params.length}::uuid`)
    }
    if (filter.displayStatuses !== undefined && filter.displayStatuses.length > 0) {
      params.push(filter.displayStatuses)
      conds.push(`o.display_status = ANY($${params.length}::text[])`)
    }
    if (filter.internalStatuses !== undefined && filter.internalStatuses.length > 0) {
      params.push(filter.internalStatuses)
      conds.push(`o.internal_status = ANY($${params.length}::text[])`)
    }
    if (filter.materialCodeLike !== undefined) {
      params.push(`%${filter.materialCodeLike}%`)
      conds.push(`o.material_code LIKE $${params.length}`)
    }
    if (filter.targetSalesOrderNoLike !== undefined) {
      params.push(`%${filter.targetSalesOrderNoLike}%`)
      conds.push(`o.target_sales_order_no LIKE $${params.length}`)
    }
    if (filter.targetProjectNoLike !== undefined) {
      params.push(`%${filter.targetProjectNoLike}%`)
      conds.push(`o.target_project_no LIKE $${params.length}`)
    }
    if (filter.conversionNoLike !== undefined) {
      params.push(`%${filter.conversionNoLike}%`)
      conds.push(`o.conversion_no LIKE $${params.length}`)
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const limitIdx = params.length - 1
    const offsetIdx = params.length
    // FC-21：转换数量=全部明细数量之和、转换轴数=明细行数
    const r = await this.client.query(
      `SELECT o.*, COALESCE(s.total_qty, '0.0000') AS total_qty, COALESCE(s.axis_count, 0) AS axis_count
       FROM conversion_stock_order o
       LEFT JOIN (
         SELECT conversion_stock_order_id, sum(quantity)::numeric(18,4) AS total_qty, count(*)::int AS axis_count
         FROM conversion_stock_line GROUP BY conversion_stock_order_id
       ) s ON s.conversion_stock_order_id = o.id
       ${where}
       ORDER BY o.created_at DESC, o.id LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    )
    const count = await this.client.query(
      `SELECT count(*)::text AS total FROM conversion_stock_order o ${where}`,
      params.slice(0, limitIdx - 1),
    )
    const items = r.rows.map((row) => {
      const raw = row as StockOrderRow & { total_qty: string; axis_count: number }
      return { ...mapStockOrder(raw), totalQty: String(raw.total_qty), axisCount: Number(raw.axis_count) }
    })
    return { items, total: Number(count.rows[0]!.total) }
  }
}

// ---------------- conversion_stock_line（协议B 明细） ----------------

const STOCK_LINE_COLUMNS = `id, conversion_stock_order_id, unit_no, inventory_unit_id, pallet_code,
  quantity::text AS quantity, uom, segment_length::text AS segment_length, customer_axis_no,
  material_id, material_code, source_project_no, source_sales_order_no, source_line_no,
  source_batch_no, source_virtual_axis_no, warehouse_id, warehouse_code, location_id, location_code,
  released, command_receipt_id, plant_id, enterprise_id, business_time, created_at, created_by`

interface StockLineRow {
  id: string
  conversion_stock_order_id: string
  unit_no: string
  inventory_unit_id: string
  pallet_code: string | null
  quantity: string
  uom: string
  segment_length: string
  customer_axis_no: string | null
  material_id: string
  material_code: string
  source_project_no: string | null
  source_sales_order_no: string | null
  source_line_no: string | null
  source_batch_no: string | null
  source_virtual_axis_no: string | null
  warehouse_id: string | null
  warehouse_code: string | null
  location_id: string | null
  location_code: string | null
  released: boolean
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapStockLine(r: StockLineRow): ConversionStockLineRecord {
  return {
    id: r.id,
    conversionStockOrderId: r.conversion_stock_order_id,
    unitNo: r.unit_no,
    inventoryUnitId: r.inventory_unit_id,
    palletCode: r.pallet_code,
    quantity: r.quantity,
    uom: r.uom,
    segmentLength: r.segment_length,
    customerAxisNo: r.customer_axis_no,
    materialId: r.material_id,
    materialCode: r.material_code,
    sourceProjectNo: r.source_project_no,
    sourceSalesOrderNo: r.source_sales_order_no,
    sourceLineNo: r.source_line_no,
    sourceBatchNo: r.source_batch_no,
    sourceVirtualAxisNo: r.source_virtual_axis_no,
    warehouseId: r.warehouse_id,
    warehouseCode: r.warehouse_code,
    locationId: r.location_id,
    locationCode: r.location_code,
    released: r.released,
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgConversionStockLineRepository implements ConversionStockLineRepository {
  constructor(private readonly client: SqlClient) {}

  async insertBatch(lines: NewConversionStockLine[]): Promise<ConversionStockLineRecord[]> {
    if (lines.length === 0) return []
    const per = 24
    const values: unknown[] = []
    const tuples = lines.map((l, i) => {
      const base = i * per
      values.push(
        l.conversionStockOrderId,
        l.unitNo,
        l.inventoryUnitId,
        l.palletCode ?? null,
        l.quantity,
        l.uom,
        l.segmentLength,
        l.customerAxisNo ?? null,
        l.materialId,
        l.materialCode,
        l.sourceProjectNo ?? null,
        l.sourceSalesOrderNo ?? null,
        l.sourceLineNo ?? null,
        l.sourceBatchNo ?? null,
        l.sourceVirtualAxisNo ?? null,
        l.warehouseId ?? null,
        l.warehouseCode ?? null,
        l.locationId ?? null,
        l.locationCode ?? null,
        l.commandReceiptId ?? null,
        l.plantId,
        l.enterpriseId,
        l.businessTime ?? new Date().toISOString(),
        l.createdBy ?? null,
      )
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15},$${base + 16},$${base + 17},$${base + 18},$${base + 19},$${base + 20},$${base + 21},$${base + 22},$${base + 23},$${base + 24})`
    })
    const r = await this.client.query(
      `INSERT INTO conversion_stock_line
         (conversion_stock_order_id, unit_no, inventory_unit_id, pallet_code, quantity, uom,
          segment_length, customer_axis_no, material_id, material_code, source_project_no,
          source_sales_order_no, source_line_no, source_batch_no, source_virtual_axis_no,
          warehouse_id, warehouse_code, location_id, location_code, command_receipt_id,
          plant_id, enterprise_id, business_time, created_by)
       VALUES ${tuples.join(',')} RETURNING ${STOCK_LINE_COLUMNS}`,
      values,
    )
    return r.rows.map((row) => mapStockLine(row as StockLineRow))
  }

  async listByOrder(conversionStockOrderId: string): Promise<ConversionStockLineRecord[]> {
    const r = await this.client.query(
      `SELECT ${STOCK_LINE_COLUMNS} FROM conversion_stock_line WHERE conversion_stock_order_id = $1 ORDER BY created_at, id`,
      [conversionStockOrderId],
    )
    return r.rows.map((row) => mapStockLine(row as StockLineRow))
  }

  async findUnfinishedByUnitAndMaterial(
    unitNo: string,
    materialId: string,
    excludeOrderId?: string,
  ): Promise<{ orderId: string; conversionNo: string } | null> {
    const r = await this.client.query(
      `SELECT l.conversion_stock_order_id AS order_id, o.conversion_no
       FROM conversion_stock_line l
       JOIN conversion_stock_order o ON o.id = l.conversion_stock_order_id
       WHERE l.unit_no = $1 AND l.material_id = $2 AND NOT l.released
         AND ($3::uuid IS NULL OR l.conversion_stock_order_id <> $3::uuid)
       LIMIT 1`,
      [unitNo, materialId, excludeOrderId ?? null],
    )
    const row = r.rows[0] as { order_id: string; conversion_no: string } | undefined
    return row === undefined ? null : { orderId: row.order_id, conversionNo: row.conversion_no }
  }

  async markReleasedByOrder(conversionStockOrderId: string): Promise<void> {
    await this.client.query(
      `UPDATE conversion_stock_line SET released = true WHERE conversion_stock_order_id = $1 AND NOT released`,
      [conversionStockOrderId],
    )
  }

  async deleteByOrder(conversionStockOrderId: string): Promise<void> {
    await this.client.query(`DELETE FROM conversion_stock_line WHERE conversion_stock_order_id = $1`, [
      conversionStockOrderId,
    ])
  }
}

// ---------------- conversion_code_rewrite（协议B 改码） ----------------

const REWRITE_COLUMNS = `id, conversion_stock_order_id, conversion_line_id, inventory_unit_id, unit_no,
  old_sales_order_no, old_line_no, old_batch_no, old_virtual_axis_no, new_sales_order_no,
  new_line_no, new_batch_no, new_segment_length::text AS new_segment_length, new_customer_axis_no,
  virtual_axis_cleared, applied_by, applied_at, command_receipt_id, plant_id, enterprise_id,
  business_time, created_at, created_by`

interface RewriteRow {
  id: string
  conversion_stock_order_id: string
  conversion_line_id: string
  inventory_unit_id: string
  unit_no: string
  old_sales_order_no: string | null
  old_line_no: string | null
  old_batch_no: string | null
  old_virtual_axis_no: string | null
  new_sales_order_no: string
  new_line_no: string
  new_batch_no: string
  new_segment_length: string
  new_customer_axis_no: string | null
  virtual_axis_cleared: boolean
  applied_by: string
  applied_at: Date | string
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapRewrite(r: RewriteRow): CodeRewriteRecord {
  return {
    id: r.id,
    conversionStockOrderId: r.conversion_stock_order_id,
    conversionLineId: r.conversion_line_id,
    inventoryUnitId: r.inventory_unit_id,
    unitNo: r.unit_no,
    oldSalesOrderNo: r.old_sales_order_no,
    oldLineNo: r.old_line_no,
    oldBatchNo: r.old_batch_no,
    oldVirtualAxisNo: r.old_virtual_axis_no,
    newSalesOrderNo: r.new_sales_order_no,
    newLineNo: r.new_line_no,
    newBatchNo: r.new_batch_no,
    newSegmentLength: r.new_segment_length,
    newCustomerAxisNo: r.new_customer_axis_no,
    virtualAxisCleared: r.virtual_axis_cleared,
    appliedBy: r.applied_by,
    appliedAt: iso(r.applied_at),
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgCodeRewriteRepository implements CodeRewriteRepository {
  constructor(private readonly client: SqlClient) {}

  async insertBatch(rewrites: NewCodeRewrite[]): Promise<CodeRewriteRecord[]> {
    if (rewrites.length === 0) return []
    const per = 21
    const values: unknown[] = []
    const tuples = rewrites.map((w, i) => {
      const base = i * per
      values.push(
        w.conversionStockOrderId,
        w.conversionLineId,
        w.inventoryUnitId,
        w.unitNo,
        w.oldSalesOrderNo ?? null,
        w.oldLineNo ?? null,
        w.oldBatchNo ?? null,
        w.oldVirtualAxisNo ?? null,
        w.newSalesOrderNo,
        w.newLineNo,
        w.newBatchNo,
        w.newSegmentLength,
        w.newCustomerAxisNo ?? null,
        w.virtualAxisCleared,
        w.appliedBy,
        w.appliedAt,
        w.commandReceiptId ?? null,
        w.plantId,
        w.enterpriseId,
        w.businessTime ?? new Date().toISOString(),
        w.createdBy ?? null,
      )
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15},$${base + 16},$${base + 17},$${base + 18},$${base + 19},$${base + 20},$${base + 21})`
    })
    const r = await this.client.query(
      `INSERT INTO conversion_code_rewrite
         (conversion_stock_order_id, conversion_line_id, inventory_unit_id, unit_no,
          old_sales_order_no, old_line_no, old_batch_no, old_virtual_axis_no, new_sales_order_no,
          new_line_no, new_batch_no, new_segment_length, new_customer_axis_no, virtual_axis_cleared,
          applied_by, applied_at, command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ${tuples.join(',')} RETURNING ${REWRITE_COLUMNS}`,
      values,
    )
    return r.rows.map((row) => mapRewrite(row as RewriteRow))
  }

  async listByOrder(conversionStockOrderId: string): Promise<CodeRewriteRecord[]> {
    const r = await this.client.query(
      `SELECT ${REWRITE_COLUMNS} FROM conversion_code_rewrite WHERE conversion_stock_order_id = $1 ORDER BY created_at, id`,
      [conversionStockOrderId],
    )
    return r.rows.map((row) => mapRewrite(row as RewriteRow))
  }
}

// ---------------- 0001 outbox 窄读写 ----------------

export class PgConversionOutboxTaskAccess implements ConversionOutboxTaskAccess {
  constructor(private readonly client: SqlClient) {}

  async findLatestByTask(aggregateType: string, aggregateId: string, taskKind: string) {
    const r = await this.client.query(
      `SELECT event_id, status, payload, attempt_count
       FROM outbox WHERE aggregate_type = $1 AND aggregate_id = $2 AND task_kind = $3
       ORDER BY created_at DESC, event_id LIMIT 1`,
      [aggregateType, aggregateId, taskKind],
    )
    const row = r.rows[0] as
      | { event_id: string; status: string; payload: Record<string, unknown>; attempt_count: number }
      | undefined
    if (row === undefined) return null
    return { eventId: row.event_id, status: row.status, payload: row.payload ?? {}, attemptCount: Number(row.attempt_count) }
  }

  async countByTask(aggregateType: string, aggregateId: string, taskKind: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS c FROM outbox WHERE aggregate_type = $1 AND aggregate_id = $2 AND task_kind = $3`,
      [aggregateType, aggregateId, taskKind],
    )
    return Number((r.rows[0] as { c: number }).c)
  }

  async markStatus(
    eventId: string,
    patch: { status: 'DISPATCHED' | 'SYNC_FAILED' | 'NOOP_NEEDED'; lastError?: string | null },
  ): Promise<void> {
    await this.client.query(
      `UPDATE outbox SET status = $2, last_error = COALESCE($3, last_error), updated_at = now() WHERE event_id = $1`,
      [eventId, patch.status, patch.lastError ?? null],
    )
  }
}

// ---------------- 跨域只读端口 ----------------

export class PgConversionProcessLookups implements ConversionProcessLookups {
  constructor(private readonly client: SqlClient) {}

  async findProductionOrder(id: string): Promise<ConversionProductionOrderView | null> {
    const r = await this.client.query(
      `SELECT po.id, po.order_no, po.material_id, po.sales_order_no, po.line_no, po.order_status, po.plant_id,
              m.code AS material_code
       FROM production_order po LEFT JOIN material m ON m.id = po.material_id
       WHERE po.id = $1`,
      [id],
    )
    const row = r.rows[0] as
      | {
          id: string
          order_no: string
          material_id: string
          material_code: string | null
          sales_order_no: string | null
          line_no: string | null
          order_status: string
          plant_id: string
        }
      | undefined
    if (row === undefined) return null
    return {
      id: row.id,
      orderNo: row.order_no,
      materialId: row.material_id,
      materialCode: row.material_code,
      salesOrderNo: row.sales_order_no,
      lineNo: row.line_no,
      orderStatus: row.order_status,
      plantId: row.plant_id,
    }
  }

  async findOrderForUnit(inventoryUnitId: string): Promise<{ orderId: string } | null> {
    const r = await this.client.query(
      `SELECT pr.order_id
       FROM report_output ro JOIN production_report pr ON pr.id = ro.report_id
       WHERE ro.stock_unit_id = $1
       ORDER BY ro.created_at DESC LIMIT 1`,
      [inventoryUnitId],
    )
    const row = r.rows[0] as { order_id: string } | undefined
    return row === undefined ? null : { orderId: row.order_id }
  }
}

export class PgConversionStockLookups implements ConversionStockLookups {
  constructor(private readonly client: SqlClient) {}

  async findMaterial(id: string): Promise<ConversionMaterialView | null> {
    const r = await this.client.query(
      `SELECT id, code, name, material_type, base_uom FROM material WHERE id = $1`,
      [id],
    )
    const row = r.rows[0] as
      | { id: string; code: string; name: string; material_type: number; base_uom: string }
      | undefined
    if (row === undefined) return null
    return { id: row.id, code: row.code, name: row.name, materialType: Number(row.material_type), baseUom: row.base_uom }
  }

  async sumMaterialStock(plantId: string, materialId: string): Promise<string> {
    const r = await this.client.query(
      `SELECT COALESCE(sum(sb.quantity), 0)::numeric(18,4)::text AS total
       FROM stock_balance sb JOIN inventory_unit iu ON iu.id = sb.unit_id
       WHERE iu.plant_id = $1 AND iu.material_id = $2 AND sb.status = 'active'`,
      [plantId, materialId],
    )
    return String((r.rows[0] as { total: string }).total)
  }

  async findUnitStockFacts(plantId: string, unitNo: string): Promise<UnitStockFacts | null> {
    const r = await this.client.query(
      `SELECT iu.id AS unit_id, iu.unit_no, iu.material_id, iu.material_code,
              iu.status AS unit_status,
              sb.quantity::text AS quantity, sb.uom_id, sb.uom_code,
              sl.id AS location_id, sl.code AS location_code,
              w.id AS warehouse_id, w.code AS warehouse_code, w.warehouse_type,
              (SELECT c.carrier_code FROM carrier_binding cb JOIN carrier c ON c.id = cb.carrier_id
                WHERE cb.unit_id = iu.id AND cb.effective_to IS NULL LIMIT 1) AS pallet_code,
              (SELECT cs.order_no FROM customer_segment cs
                WHERE cs.unit_id = iu.id ORDER BY cs.created_at DESC LIMIT 1) AS sales_order_no,
              (SELECT cs.customer_ref FROM customer_segment cs
                WHERE cs.unit_id = iu.id ORDER BY cs.created_at DESC LIMIT 1) AS customer_axis_no,
              (SELECT ml.lot_no FROM material_lot ml WHERE ml.id = iu.lot_id) AS batch_no
       FROM inventory_unit iu
       LEFT JOIN LATERAL (
         SELECT sb.* FROM stock_balance sb
         WHERE sb.unit_id = iu.id AND sb.status = 'active' LIMIT 1
       ) sb ON true
       LEFT JOIN storage_location sl ON sl.id = sb.location_id
       LEFT JOIN warehouse w ON w.id = sl.warehouse_id
       WHERE iu.plant_id = $1 AND iu.unit_no = $2`,
      [plantId, unitNo],
    )
    const row = r.rows[0] as
      | {
          unit_id: string
          unit_no: string
          material_id: string
          material_code: string
          unit_status: string
          quantity: string | null
          uom_id: string | null
          uom_code: string | null
          location_id: string | null
          location_code: string | null
          warehouse_id: string | null
          warehouse_code: string | null
          warehouse_type: string | null
          pallet_code: string | null
          sales_order_no: string | null
          customer_axis_no: string | null
          batch_no: string | null
        }
      | undefined
    if (row === undefined) return null
    return {
      unitId: row.unit_id,
      unitNo: row.unit_no,
      materialId: row.material_id,
      materialCode: row.material_code,
      unitStatus: row.unit_status,
      quantity: row.quantity ?? '0.0000',
      uomId: row.uom_id ?? '',
      uomCode: row.uom_code ?? '',
      warehouseId: row.warehouse_id,
      warehouseCode: row.warehouse_code,
      warehouseType: row.warehouse_type,
      locationId: row.location_id,
      locationCode: row.location_code,
      palletCode: row.pallet_code,
      customerAxisNo: row.customer_axis_no,
      salesOrderNo: row.sales_order_no,
      salesLineNo: null,
      batchNo: row.batch_no,
    }
  }

  async listStockCandidates(filter: {
    plantId: string
    materialId: string
    warehouseId?: string
    unitNoLike?: string
    palletCodeLike?: string
    salesOrderNoLike?: string
    batchNoLike?: string
    customerAxisNoLike?: string
  }) {
    const conds: string[] = [
      `iu.plant_id = $1`,
      `iu.material_id = $2`,
      `iu.status = 'in_stock'`,
      `w.warehouse_type = 'WAREHOUSE'`,
    ]
    const params: unknown[] = [filter.plantId, filter.materialId]
    if (filter.warehouseId !== undefined) {
      params.push(filter.warehouseId)
      conds.push(`w.id = $${params.length}::uuid`)
    }
    if (filter.unitNoLike !== undefined) {
      params.push(`%${filter.unitNoLike}%`)
      conds.push(`iu.unit_no LIKE $${params.length}`)
    }
    if (filter.salesOrderNoLike !== undefined) {
      params.push(`%${filter.salesOrderNoLike}%`)
      conds.push(`EXISTS (SELECT 1 FROM customer_segment cs WHERE cs.unit_id = iu.id AND cs.order_no LIKE $${params.length})`)
    }
    const r = await this.client.query(
      `SELECT iu.id AS unit_id, iu.unit_no, iu.material_id, m.code AS material_code,
              sb.quantity::text AS quantity, sb.uom_code,
              w.code AS warehouse_code, sl.code AS location_code,
              (SELECT c.carrier_code FROM carrier_binding cb JOIN carrier c ON c.id = cb.carrier_id
                WHERE cb.unit_id = iu.id AND cb.effective_to IS NULL LIMIT 1) AS pallet_code,
              (SELECT count(*)::int FROM material_segment ms WHERE ms.unit_id = iu.id) AS segment_count,
              (SELECT cs.order_no FROM customer_segment cs
                WHERE cs.unit_id = iu.id ORDER BY cs.created_at DESC LIMIT 1) AS sales_order_no,
              (SELECT cs.customer_ref FROM customer_segment cs
                WHERE cs.unit_id = iu.id ORDER BY cs.created_at DESC LIMIT 1) AS customer_axis_no,
              (SELECT ml.lot_no FROM material_lot ml WHERE ml.id = iu.lot_id) AS batch_no
       FROM inventory_unit iu
       JOIN material m ON m.id = iu.material_id
       JOIN LATERAL (
         SELECT sb.* FROM stock_balance sb
         WHERE sb.unit_id = iu.id AND sb.status = 'active' LIMIT 1
       ) sb ON true
       JOIN storage_location sl ON sl.id = sb.location_id
       JOIN warehouse w ON w.id = sl.warehouse_id
       WHERE ${conds.join(' AND ')}
       ORDER BY iu.unit_no`,
      params,
    )
    interface CandRow {
      unit_id: string
      unit_no: string
      material_id: string
      material_code: string
      quantity: string
      uom_code: string
      warehouse_code: string | null
      location_code: string | null
      pallet_code: string | null
      segment_count: number
      sales_order_no: string | null
      customer_axis_no: string | null
      batch_no: string | null
    }
    const rows = r.rows as CandRow[]
    // FC-17：料品/在库/仓库类型=仓库过滤已由 SQL 承担（平行轴/多物料托只保留本料品相关轴
    // = material_id 过滤）。无托（无活动载具绑定）按单轴一行（产品轴号=码）；有托按托汇总
    // 一行（产品轴号显示 `-`，axisCount=该载具轴数——分段计数的平行轴；IT-03 单载具单单元，
    // 托内容即该单元，quantity=单元余额汇总）。添加到右侧时由前端拆成子轴多行（本查询不改）。
    const out: Array<{
      groupKind: 'axis' | 'pallet'
      productAxisNo: string | null
      palletCode: string | null
      quantity: string
      uom: string
      axisCount: number
      materialId: string
      materialCode: string
      customerAxisNo: string | null
      salesOrderNo: string | null
      lineNo: string | null
      batchNo: string | null
      warehouseCode: string | null
      locationCode: string | null
    }> = []
    for (const row of rows) {
      const hasPallet = row.pallet_code !== null && row.pallet_code !== ''
      if (filter.palletCodeLike !== undefined && !(row.pallet_code ?? '').includes(filter.palletCodeLike)) continue
      if (!hasPallet && filter.palletCodeLike !== undefined) continue
      if (filter.customerAxisNoLike !== undefined && !(row.customer_axis_no ?? '').includes(filter.customerAxisNoLike)) continue
      if (filter.batchNoLike !== undefined && !(row.batch_no ?? '').includes(filter.batchNoLike)) continue
      out.push({
        groupKind: hasPallet ? 'pallet' : 'axis',
        productAxisNo: hasPallet ? null : row.unit_no,
        palletCode: hasPallet ? row.pallet_code : null,
        quantity: row.quantity,
        uom: row.uom_code,
        axisCount: hasPallet ? Math.max(row.segment_count, 1) : 1,
        materialId: row.material_id,
        materialCode: row.material_code,
        customerAxisNo: row.customer_axis_no,
        salesOrderNo: row.sales_order_no,
        lineNo: null,
        batchNo: row.batch_no,
        warehouseCode: row.warehouse_code,
        locationCode: row.location_code,
      })
    }
    return out
  }
}

// ---------------- 装配 ----------------

export function createPgConversionRepositories(client: SqlClient): ConversionRepositories {
  return {
    orders: new PgConversionOrderRepository(client),
    orderLines: new PgConversionOrderLineRepository(client),
    orderScans: new PgConversionOrderScanRepository(client),
    assignments: new PgCodeAssignmentRepository(client),
    stockOrders: new PgConversionStockOrderRepository(client),
    stockLines: new PgConversionStockLineRepository(client),
    rewrites: new PgCodeRewriteRepository(client),
    outboxTasks: new PgConversionOutboxTaskAccess(client),
    process: new PgConversionProcessLookups(client),
    stock: new PgConversionStockLookups(client),
  }
}
