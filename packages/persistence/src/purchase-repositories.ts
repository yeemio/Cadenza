// 跨包类型导入（type-only，编译期擦除）：指向 application 已构建的 dist（构建顺序由 workspace
// 拓扑保证：persistence 依赖 application，pnpm -r 先构建后者）。不得相对引用 application/src/**
// （TS6059：各包 tsconfig.build.json 置空 paths 且限 rootDir=src）。purchase 端口尚未并入
// @cadenza/application 包名入口（application/src/index.ts 为共享文件不改动），故走 dist 相对；
// L0 整合步把端口导出并入 application index、本文件导出并入 persistence index 后改包名导入。
import type {
  BatchJudgementRecord,
  InspectionRecordRow,
  MaterialQcLookup,
  NewInspectionRecord,
  NewPurchaseOrderLine,
  NewPurchaseReceiptBatch,
  NewReceiptDetail,
  PurchaseBatchRepository,
  PurchaseExternalMappingRepository,
  PurchaseMaterialLookup,
  PurchaseOrderLineRecord,
  PurchaseOrderLineRepository,
  PurchaseOrderRecord,
  PurchaseOrderRepository,
  PurchaseReceiptBatchRecord,
  ReceiptDetailRecord,
  ReceiptDetailRepository,
} from '@cadenza/application'
import type {
  BatchJudgementRepository,
  InspectionRecordRepository,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

/**
 * purchase 域仓储的 PostgreSQL 实现（implements application 端口；0006 表列一一对应）。
 * - 全部参数化查询；numeric(18,4) 以字符串往返（定点保真）；
 * - timestamptz 出参 ISO-8601 字符串；date 出参 YYYY-MM-DD；jsonb 由 pg 驱动解析；
 * - 行锁方法（lockById）在命令事务内 SELECT ... FOR UPDATE；
 * - inspection_record / batch_judgement 的 setEffective 仅更新 is_effective 指针列
 *   （S14 守卫触发器锁定事实列，UPDATE 事实列/DELETE 由库层拒绝）。
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
    // pg 对 date 列按会话/本地时区午夜构造 Date（非 UTC）——用本地日期分量还原 YYYY-MM-DD，
    // 不得用 toISOString（会因时区偏移回退一天）。
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(value).slice(0, 10)
}

// ---------------- purchase_order ----------------

interface OrderRow {
  id: string
  order_no: string
  org_code: string
  source_system: string
  plant_id: string
  enterprise_id: string
  supplier_name: string | null
  contract_no: string | null
  external_revision: number | null
  created_at: Date | string
  updated_at: Date | string
}

function mapOrder(r: OrderRow): PurchaseOrderRecord {
  return {
    id: r.id,
    orderNo: r.order_no,
    orgCode: r.org_code,
    sourceSystem: r.source_system,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    supplierName: r.supplier_name,
    contractNo: r.contract_no,
    externalRevision: r.external_revision,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

export class PgPurchaseOrderRepository implements PurchaseOrderRepository {
  constructor(private readonly client: SqlClient) {}

  async findByKey(sourceSystem: string, orgCode: string, orderNo: string): Promise<PurchaseOrderRecord | null> {
    const r = await this.client.query(
      `SELECT * FROM purchase_order WHERE source_system = $1 AND org_code = $2 AND order_no = $3`,
      [sourceSystem, orgCode, orderNo],
    )
    return r.rows[0] ? mapOrder(r.rows[0] as OrderRow) : null
  }

  async insert(input: {
    orderNo: string
    orgCode: string
    sourceSystem: string
    plantId: string
    enterpriseId: string
    supplierName?: string | null
    contractNo?: string | null
    externalRevision?: number | null
    createdBy?: string | null
  }): Promise<PurchaseOrderRecord> {
    const r = await this.client.query(
      `INSERT INTO purchase_order (order_no, org_code, source_system, plant_id, enterprise_id,
         supplier_name, contract_no, external_revision, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        input.orderNo,
        input.orgCode,
        input.sourceSystem,
        input.plantId,
        input.enterpriseId,
        input.supplierName ?? null,
        input.contractNo ?? null,
        input.externalRevision ?? null,
        input.createdBy ?? null,
      ],
    )
    return mapOrder(r.rows[0] as OrderRow)
  }
}

// ---------------- purchase_order_line ----------------

const LINE_COLUMNS = `id, purchase_order_id, line_no, order_no, org_code, source_system, material_id,
  material_code, material_name, material_type, spec, model, color, requisition_spec, sales_order_no,
  sales_line_no, uom_code, planned_qty::text AS planned_qty, received_qty::text AS received_qty,
  over_receipt_limit::text AS over_receipt_limit, status, erp_closed, planned_receipt_date,
  first_arrival_date, last_arrival_date, external_revision, plant_id, enterprise_id,
  created_at, updated_at`

interface LineRow {
  id: string
  purchase_order_id: string
  line_no: number
  order_no: string
  org_code: string
  source_system: string
  material_id: string
  material_code: string
  material_name: string | null
  material_type: number | null
  spec: string | null
  model: string | null
  color: string | null
  requisition_spec: string | null
  sales_order_no: string | null
  sales_line_no: string | null
  uom_code: string
  planned_qty: string
  received_qty: string
  over_receipt_limit: string
  status: number
  erp_closed: boolean
  planned_receipt_date: Date | string | null
  first_arrival_date: Date | string | null
  last_arrival_date: Date | string | null
  external_revision: number | null
  plant_id: string
  enterprise_id: string
  created_at: Date | string
  updated_at: Date | string
}

function mapLine(r: LineRow): PurchaseOrderLineRecord {
  return {
    id: r.id,
    purchaseOrderId: r.purchase_order_id,
    lineNo: r.line_no,
    orderNo: r.order_no,
    orgCode: r.org_code,
    sourceSystem: r.source_system,
    materialId: r.material_id,
    materialCode: r.material_code,
    materialName: r.material_name,
    materialType: r.material_type,
    spec: r.spec,
    model: r.model,
    color: r.color,
    requisitionSpec: r.requisition_spec,
    salesOrderNo: r.sales_order_no,
    salesLineNo: r.sales_line_no,
    uomCode: r.uom_code,
    plannedQty: r.planned_qty,
    receivedQty: r.received_qty,
    overReceiptLimit: r.over_receipt_limit,
    status: r.status,
    erpClosed: r.erp_closed,
    plannedReceiptDate: dayOrNull(r.planned_receipt_date),
    firstArrivalDate: dayOrNull(r.first_arrival_date),
    lastArrivalDate: dayOrNull(r.last_arrival_date),
    externalRevision: r.external_revision,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

export class PgPurchaseOrderLineRepository implements PurchaseOrderLineRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<PurchaseOrderLineRecord | null> {
    const r = await this.client.query(`SELECT ${LINE_COLUMNS} FROM purchase_order_line WHERE id = $1`, [id])
    return r.rows[0] ? mapLine(r.rows[0] as LineRow) : null
  }

  async lockById(id: string): Promise<PurchaseOrderLineRecord | null> {
    const r = await this.client.query(
      `SELECT ${LINE_COLUMNS} FROM purchase_order_line WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rows[0] ? mapLine(r.rows[0] as LineRow) : null
  }

  async findByOrderNoAndLine(orderNo: string, lineNo: number, plantId: string): Promise<PurchaseOrderLineRecord | null> {
    const r = await this.client.query(
      `SELECT ${LINE_COLUMNS} FROM purchase_order_line
       WHERE order_no = $1 AND line_no = $2 AND plant_id = $3`,
      [orderNo, lineNo, plantId],
    )
    return r.rows[0] ? mapLine(r.rows[0] as LineRow) : null
  }

  async insert(line: NewPurchaseOrderLine): Promise<PurchaseOrderLineRecord> {
    const r = await this.client.query(
      `INSERT INTO purchase_order_line (purchase_order_id, line_no, order_no, org_code, source_system,
         material_id, material_code, material_name, material_type, spec, model, color, requisition_spec,
         sales_order_no, sales_line_no, uom_code, planned_qty, over_receipt_limit, status, erp_closed,
         planned_receipt_date, external_revision, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21, $22, $23, $24, $25)
       RETURNING ${LINE_COLUMNS}`,
      [
        line.purchaseOrderId,
        line.lineNo,
        line.orderNo,
        line.orgCode,
        line.sourceSystem,
        line.materialId,
        line.materialCode,
        line.materialName ?? null,
        line.materialType ?? null,
        line.spec ?? null,
        line.model ?? null,
        line.color ?? null,
        line.requisitionSpec ?? null,
        line.salesOrderNo ?? null,
        line.salesLineNo ?? null,
        line.uomCode,
        line.plannedQty,
        line.overReceiptLimit,
        line.status ?? 0,
        line.erpClosed ?? false,
        line.plannedReceiptDate ?? null,
        line.externalRevision ?? null,
        line.plantId,
        line.enterpriseId,
        line.createdBy ?? null,
      ],
    )
    return mapLine(r.rows[0] as LineRow)
  }

  async updateReceiptState(
    id: string,
    patch: { receivedQty: string; status: number; firstArrivalDate?: string | null; lastArrivalDate?: string | null },
    actor: string | null,
  ): Promise<PurchaseOrderLineRecord | null> {
    const r = await this.client.query(
      `UPDATE purchase_order_line SET
         received_qty = $2, status = $3,
         first_arrival_date = COALESCE($4, first_arrival_date),
         last_arrival_date = COALESCE($5, last_arrival_date),
         updated_at = now(), updated_by = $6
       WHERE id = $1 RETURNING ${LINE_COLUMNS}`,
      [id, patch.receivedQty, patch.status, patch.firstArrivalDate ?? null, patch.lastArrivalDate ?? null, actor],
    )
    return r.rows[0] ? mapLine(r.rows[0] as LineRow) : null
  }

  async applySyncRevision(
    id: string,
    patch: {
      materialId?: string
      materialCode?: string
      materialName?: string | null
      plannedQty?: string
      overReceiptLimit?: string
      status?: number
      erpClosed?: boolean
      externalRevision?: number
    },
    actor: string | null,
  ): Promise<PurchaseOrderLineRecord | null> {
    const sets: string[] = [`updated_at = now()`, `updated_by = $2`]
    const values: unknown[] = [id, actor]
    const add = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch.materialId !== undefined) add('material_id', patch.materialId)
    if (patch.materialCode !== undefined) add('material_code', patch.materialCode)
    if (patch.materialName !== undefined) add('material_name', patch.materialName)
    if (patch.plannedQty !== undefined) add('planned_qty', patch.plannedQty)
    if (patch.overReceiptLimit !== undefined) add('over_receipt_limit', patch.overReceiptLimit)
    if (patch.status !== undefined) add('status', patch.status)
    if (patch.erpClosed !== undefined) add('erp_closed', patch.erpClosed)
    if (patch.externalRevision !== undefined) add('external_revision', patch.externalRevision)
    const r = await this.client.query(
      `UPDATE purchase_order_line SET ${sets.join(', ')} WHERE id = $1 RETURNING ${LINE_COLUMNS}`,
      values,
    )
    return r.rows[0] ? mapLine(r.rows[0] as LineRow) : null
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    orderNoLike?: string
    materialCode?: string
    statuses?: number[]
    page: number
    pageSize: number
  }): Promise<{ items: PurchaseOrderLineRecord[]; total: number }> {
    const conditions: string[] = []
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      conditions.push(`plant_id = ANY($${values.length + 1}::uuid[])`)
      values.push(filter.plantIds)
    }
    if (filter.plantId !== undefined) {
      values.push(filter.plantId)
      conditions.push(`plant_id = $${values.length}`)
    }
    if (filter.orderNoLike !== undefined) {
      values.push(`%${filter.orderNoLike}%`)
      conditions.push(`order_no LIKE $${values.length}`)
    }
    if (filter.materialCode !== undefined) {
      values.push(`%${filter.materialCode}%`)
      conditions.push(`material_code LIKE $${values.length}`)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      values.push(filter.statuses)
      conditions.push(`status = ANY($${values.length}::smallint[])`)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${LINE_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM purchase_order_line ${where}
       ORDER BY (status = 5), planned_receipt_date NULLS LAST, id
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return { items: r.rows.map((row) => mapLine(row as LineRow)), total }
  }
}

// ---------------- purchase_receipt_batch ----------------

const BATCH_COLUMNS = `id, batch_no, purchase_line_id, order_no, line_no, material_id, material_code,
  material_name, material_type, plant_id, enterprise_id, warehouse_id, warehouse_code, location_id,
  location_code, uom_id, uom_code, inspection_status, storage_status, received_qty::text AS received_qty,
  unit_price::text AS unit_price, price_history, avg_price::text AS avg_price, deviation_ppm, price_flag,
  review_status, reviewed_by, reviewed_at, qualified_sync_status, return_sync_status, arrival_time,
  confirm_time, received_by, returned_at, return_reason, created_at, measurement_basis`

interface BatchRow {
  id: string
  batch_no: string
  purchase_line_id: string
  order_no: string
  line_no: number
  material_id: string
  material_code: string
  material_name: string | null
  material_type: number | null
  plant_id: string
  enterprise_id: string
  warehouse_id: string
  warehouse_code: string | null
  location_id: string | null
  location_code: string | null
  uom_id: string
  uom_code: string
  measurement_basis: string
  inspection_status: PurchaseReceiptBatchRecord['inspectionStatus']
  storage_status: 'stored' | 'returned'
  received_qty: string
  unit_price: string | null
  price_history: Array<{ batchNo: string; price: string; confirmTime: string }> | null
  avg_price: string | null
  deviation_ppm: number | null
  price_flag: 'up' | 'down' | null
  review_status: 'pending' | 'reviewed'
  reviewed_by: string | null
  reviewed_at: Date | string | null
  qualified_sync_status: 'none' | 'pending' | 'failed' | 'synced'
  return_sync_status: 'none' | 'pending' | 'failed' | 'synced'
  arrival_time: Date | string
  confirm_time: Date | string
  received_by: string
  returned_at: Date | string | null
  return_reason: string | null
  created_at: Date | string
}

function mapBatch(r: BatchRow): PurchaseReceiptBatchRecord {
  return {
    id: r.id,
    batchNo: r.batch_no,
    purchaseLineId: r.purchase_line_id,
    orderNo: r.order_no,
    lineNo: r.line_no,
    materialId: r.material_id,
    materialCode: r.material_code,
    materialName: r.material_name,
    materialType: r.material_type,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    warehouseId: r.warehouse_id,
    warehouseCode: r.warehouse_code,
    locationId: r.location_id,
    locationCode: r.location_code,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    measurementBasis: r.measurement_basis,
    inspectionStatus: r.inspection_status,
    storageStatus: r.storage_status,
    receivedQty: r.received_qty,
    unitPrice: r.unit_price,
    priceHistory: r.price_history ?? null,
    avgPrice: r.avg_price,
    deviationPpm: r.deviation_ppm,
    priceFlag: r.price_flag,
    reviewStatus: r.review_status,
    reviewedBy: r.reviewed_by,
    reviewedAt: isoOrNull(r.reviewed_at),
    qualifiedSyncStatus: r.qualified_sync_status,
    returnSyncStatus: r.return_sync_status,
    arrivalTime: iso(r.arrival_time),
    confirmTime: iso(r.confirm_time),
    receivedBy: r.received_by,
    returnedAt: isoOrNull(r.returned_at),
    returnReason: r.return_reason,
    createdAt: iso(r.created_at),
  }
}

export class PgPurchaseBatchRepository implements PurchaseBatchRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<PurchaseReceiptBatchRecord | null> {
    const r = await this.client.query(`SELECT ${BATCH_COLUMNS} FROM purchase_receipt_batch WHERE id = $1`, [id])
    return r.rows[0] ? mapBatch(r.rows[0] as BatchRow) : null
  }

  async findByNo(batchNo: string): Promise<PurchaseReceiptBatchRecord | null> {
    const r = await this.client.query(`SELECT ${BATCH_COLUMNS} FROM purchase_receipt_batch WHERE batch_no = $1`, [batchNo])
    return r.rows[0] ? mapBatch(r.rows[0] as BatchRow) : null
  }

  async insert(batch: NewPurchaseReceiptBatch): Promise<PurchaseReceiptBatchRecord> {
    const r = await this.client.query(
      `INSERT INTO purchase_receipt_batch (batch_no, purchase_line_id, order_no, line_no, material_id,
         material_code, material_name, material_type, plant_id, enterprise_id, warehouse_id, warehouse_code,
         location_id, location_code, uom_id, uom_code, inspection_status, storage_status, received_qty,
         unit_price, price_history, avg_price, deviation_ppm, price_flag, arrival_time, confirm_time,
         received_by, created_by, measurement_basis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'stored', $18,
         $19, $20::jsonb, $21, $22, $23, $24, $25, $26, $27, $28)
       RETURNING ${BATCH_COLUMNS}`,
      [
        batch.batchNo,
        batch.purchaseLineId,
        batch.orderNo,
        batch.lineNo,
        batch.materialId,
        batch.materialCode,
        batch.materialName ?? null,
        batch.materialType ?? null,
        batch.plantId,
        batch.enterpriseId,
        batch.warehouseId,
        batch.warehouseCode ?? null,
        batch.locationId ?? null,
        batch.locationCode ?? null,
        batch.uomId,
        batch.uomCode,
        batch.inspectionStatus,
        batch.receivedQty,
        batch.unitPrice ?? null,
        batch.priceHistory ? JSON.stringify(batch.priceHistory) : null,
        batch.avgPrice ?? null,
        batch.deviationPpm ?? null,
        batch.priceFlag ?? null,
        batch.arrivalTime,
        batch.confirmTime,
        batch.receivedBy,
        batch.createdBy ?? null,
        batch.measurementBasis ?? 'nominal',
      ],
    )
    return mapBatch(r.rows[0] as BatchRow)
  }

  async updateInspectionStatus(
    id: string,
    inspectionStatus: PurchaseReceiptBatchRecord['inspectionStatus'],
    actor: string | null,
  ): Promise<PurchaseReceiptBatchRecord | null> {
    const r = await this.client.query(
      `UPDATE purchase_receipt_batch SET inspection_status = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${BATCH_COLUMNS}`,
      [id, inspectionStatus, actor],
    )
    return r.rows[0] ? mapBatch(r.rows[0] as BatchRow) : null
  }

  async updateReturnState(
    id: string,
    patch: { storageStatus: 'returned'; receivedQty: string; returnedAt: string; returnReason: string },
    actor: string | null,
  ): Promise<PurchaseReceiptBatchRecord | null> {
    const r = await this.client.query(
      `UPDATE purchase_receipt_batch SET storage_status = $2, received_qty = $3, returned_at = $4,
         return_reason = $5, updated_at = now(), updated_by = $6
       WHERE id = $1 RETURNING ${BATCH_COLUMNS}`,
      [id, patch.storageStatus, patch.receivedQty, patch.returnedAt, patch.returnReason, actor],
    )
    return r.rows[0] ? mapBatch(r.rows[0] as BatchRow) : null
  }

  async updateReview(
    id: string,
    patch: { reviewStatus: 'reviewed'; reviewedBy: string; reviewedAt: string },
    actor: string | null,
  ): Promise<PurchaseReceiptBatchRecord | null> {
    const r = await this.client.query(
      `UPDATE purchase_receipt_batch SET review_status = $2, reviewed_by = $3, reviewed_at = $4,
         updated_at = now(), updated_by = $5
       WHERE id = $1 RETURNING ${BATCH_COLUMNS}`,
      [id, patch.reviewStatus, patch.reviewedBy, patch.reviewedAt, actor],
    )
    return r.rows[0] ? mapBatch(r.rows[0] as BatchRow) : null
  }

  async markQualifiedSyncPending(id: string, actor: string | null): Promise<PurchaseReceiptBatchRecord | null> {
    const r = await this.client.query(
      `UPDATE purchase_receipt_batch SET qualified_sync_status = 'pending', updated_at = now(), updated_by = $2
       WHERE id = $1 AND qualified_sync_status = 'none' RETURNING ${BATCH_COLUMNS}`,
      [id, actor],
    )
    return r.rows[0] ? mapBatch(r.rows[0] as BatchRow) : null
  }

  async markReturnSyncPending(id: string, actor: string | null): Promise<PurchaseReceiptBatchRecord | null> {
    const r = await this.client.query(
      `UPDATE purchase_receipt_batch SET return_sync_status = 'pending', updated_at = now(), updated_by = $2
       WHERE id = $1 AND return_sync_status = 'none' RETURNING ${BATCH_COLUMNS}`,
      [id, actor],
    )
    return r.rows[0] ? mapBatch(r.rows[0] as BatchRow) : null
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    batchNoLike?: string
    orderNoLike?: string
    inspectionStatuses?: string[]
    storageStatuses?: string[]
    reviewStatuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: PurchaseReceiptBatchRecord[]; total: number }> {
    const conditions: string[] = []
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      conditions.push(`plant_id = ANY($${values.length + 1}::uuid[])`)
      values.push(filter.plantIds)
    }
    if (filter.plantId !== undefined) {
      values.push(filter.plantId)
      conditions.push(`plant_id = $${values.length}`)
    }
    if (filter.batchNoLike !== undefined) {
      values.push(`%${filter.batchNoLike}%`)
      conditions.push(`batch_no LIKE $${values.length}`)
    }
    if (filter.orderNoLike !== undefined) {
      values.push(`%${filter.orderNoLike}%`)
      conditions.push(`order_no LIKE $${values.length}`)
    }
    if (filter.inspectionStatuses !== undefined && filter.inspectionStatuses.length > 0) {
      values.push(filter.inspectionStatuses)
      conditions.push(`inspection_status = ANY($${values.length}::text[])`)
    }
    if (filter.storageStatuses !== undefined && filter.storageStatuses.length > 0) {
      values.push(filter.storageStatuses)
      conditions.push(`storage_status = ANY($${values.length}::text[])`)
    }
    if (filter.reviewStatuses !== undefined && filter.reviewStatuses.length > 0) {
      values.push(filter.reviewStatuses)
      conditions.push(`review_status = ANY($${values.length}::text[])`)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${BATCH_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM purchase_receipt_batch ${where}
       ORDER BY confirm_time DESC, id
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return { items: r.rows.map((row) => mapBatch(row as BatchRow)), total }
  }

  async listRecentPricedByMaterialOrg(
    materialId: string,
    enterpriseId: string,
    limit: number,
  ): Promise<Array<{ batchNo: string; price: string; confirmTime: string }>> {
    const r = await this.client.query(
      `SELECT batch_no, unit_price::text AS price, confirm_time
       FROM purchase_receipt_batch
       WHERE material_id = $1 AND enterprise_id = $2 AND storage_status = 'stored'
         AND unit_price IS NOT NULL
       ORDER BY confirm_time DESC
       LIMIT $3`,
      [materialId, enterpriseId, limit],
    )
    return r.rows.map((row: { batch_no: string; price: string; confirm_time: Date | string }) => ({
      batchNo: row.batch_no,
      price: row.price,
      confirmTime: iso(row.confirm_time),
    }))
  }
}

// ---------------- receipt_detail ----------------

const DETAIL_COLUMNS = `id, batch_id, barcode_value, supplier_lot_no, grade, production_date,
  quantity::text AS quantity, package_qty::text AS package_qty, code_count, conversion_revision_id,
  uom_id, uom_code, quality_status, inventory_unit_id, location_id, location_code, note, created_at`

interface DetailRow {
  id: string
  batch_id: string
  barcode_value: string
  supplier_lot_no: string
  grade: string
  production_date: Date | string | null
  quantity: string
  package_qty: string | null
  code_count: number | null
  conversion_revision_id: string | null
  uom_id: string
  uom_code: string
  quality_status: ReceiptDetailRecord['qualityStatus']
  inventory_unit_id: string | null
  location_id: string | null
  location_code: string | null
  note: string | null
  created_at: Date | string
}

function mapDetail(r: DetailRow): ReceiptDetailRecord {
  return {
    id: r.id,
    batchId: r.batch_id,
    barcodeValue: r.barcode_value,
    supplierLotNo: r.supplier_lot_no,
    grade: r.grade,
    productionDate: dayOrNull(r.production_date),
    quantity: r.quantity,
    packageQty: r.package_qty,
    codeCount: r.code_count,
    conversionRevisionId: r.conversion_revision_id,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    qualityStatus: r.quality_status,
    inventoryUnitId: r.inventory_unit_id,
    locationId: r.location_id,
    locationCode: r.location_code,
    note: r.note,
    createdAt: iso(r.created_at),
  }
}

export class PgReceiptDetailRepository implements ReceiptDetailRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(detail: NewReceiptDetail): Promise<ReceiptDetailRecord> {
    const r = await this.client.query(
      `INSERT INTO receipt_detail (batch_id, barcode_value, supplier_lot_no, grade, production_date,
         quantity, package_qty, code_count, conversion_revision_id, uom_id, uom_code, quality_status,
         inventory_unit_id, location_id, location_code, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING ${DETAIL_COLUMNS}`,
      [
        detail.batchId,
        detail.barcodeValue,
        detail.supplierLotNo ?? '',
        detail.grade ?? '',
        detail.productionDate ?? null,
        detail.quantity,
        detail.packageQty ?? null,
        detail.codeCount ?? null,
        detail.conversionRevisionId ?? null,
        detail.uomId,
        detail.uomCode,
        detail.qualityStatus,
        detail.inventoryUnitId ?? null,
        detail.locationId ?? null,
        detail.locationCode ?? null,
        detail.note ?? null,
        detail.createdBy ?? null,
      ],
    )
    return mapDetail(r.rows[0] as DetailRow)
  }

  async findById(id: string): Promise<ReceiptDetailRecord | null> {
    const r = await this.client.query(`SELECT ${DETAIL_COLUMNS} FROM receipt_detail WHERE id = $1`, [id])
    return r.rows[0] ? mapDetail(r.rows[0] as DetailRow) : null
  }

  async listByBatch(batchId: string): Promise<ReceiptDetailRecord[]> {
    const r = await this.client.query(
      `SELECT ${DETAIL_COLUMNS} FROM receipt_detail WHERE batch_id = $1 ORDER BY created_at, id`,
      [batchId],
    )
    return r.rows.map((row) => mapDetail(row as DetailRow))
  }

  async findByBarcode(batchId: string, barcodeValue: string): Promise<ReceiptDetailRecord | null> {
    const r = await this.client.query(
      `SELECT ${DETAIL_COLUMNS} FROM receipt_detail WHERE batch_id = $1 AND barcode_value = $2
       ORDER BY created_at, id LIMIT 1`,
      [batchId, barcodeValue],
    )
    return r.rows[0] ? mapDetail(r.rows[0] as DetailRow) : null
  }

  async updateQualityStatus(
    id: string,
    qualityStatus: ReceiptDetailRecord['qualityStatus'],
    actor: string | null,
  ): Promise<ReceiptDetailRecord | null> {
    const r = await this.client.query(
      `UPDATE receipt_detail SET quality_status = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${DETAIL_COLUMNS}`,
      [id, qualityStatus, actor],
    )
    return r.rows[0] ? mapDetail(r.rows[0] as DetailRow) : null
  }
}

// ---------------- inspection_record（S14 版本化） ----------------

const INSPECTION_COLUMNS = `id, batch_id, detail_id, barcode_value, inspection_type, version, conclusion,
  is_effective, source, inspector, inspected_at, attachments, command_receipt_id, created_at`

interface InspectionRow {
  id: string
  batch_id: string
  detail_id: string
  barcode_value: string
  inspection_type: 'first' | 're'
  version: number
  conclusion: InspectionRecordRow['conclusion']
  is_effective: boolean
  source: InspectionRecordRow['source']
  inspector: string | null
  inspected_at: Date | string | null
  attachments: unknown
  command_receipt_id: string | null
  created_at: Date | string
}

function mapInspection(r: InspectionRow): InspectionRecordRow {
  return {
    id: r.id,
    batchId: r.batch_id,
    detailId: r.detail_id,
    barcodeValue: r.barcode_value,
    inspectionType: r.inspection_type,
    version: r.version,
    conclusion: r.conclusion,
    isEffective: r.is_effective,
    source: r.source,
    inspector: r.inspector,
    inspectedAt: isoOrNull(r.inspected_at),
    attachments: r.attachments,
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
  }
}

export class PgInspectionRecordRepository implements InspectionRecordRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(record: NewInspectionRecord): Promise<InspectionRecordRow> {
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
        record.isEffective ?? false,
        record.source,
        record.inspector ?? null,
        record.inspectedAt ?? null,
        record.attachments === undefined || record.attachments === null ? null : JSON.stringify(record.attachments),
        record.commandReceiptId ?? null,
        record.createdBy ?? null,
      ],
    )
    return mapInspection(r.rows[0] as InspectionRow)
  }

  async listByDetail(detailId: string): Promise<InspectionRecordRow[]> {
    const r = await this.client.query(
      `SELECT ${INSPECTION_COLUMNS} FROM inspection_record WHERE detail_id = $1 ORDER BY inspection_type, version`,
      [detailId],
    )
    return r.rows.map((row) => mapInspection(row as InspectionRow))
  }

  async listByDetailAndType(detailId: string, inspectionType: 'first' | 're'): Promise<InspectionRecordRow[]> {
    const r = await this.client.query(
      `SELECT ${INSPECTION_COLUMNS} FROM inspection_record
       WHERE detail_id = $1 AND inspection_type = $2 ORDER BY version`,
      [detailId, inspectionType],
    )
    return r.rows.map((row) => mapInspection(row as InspectionRow))
  }

  async listByBatch(batchId: string): Promise<InspectionRecordRow[]> {
    const r = await this.client.query(
      `SELECT ${INSPECTION_COLUMNS} FROM inspection_record WHERE batch_id = $1
       ORDER BY detail_id, inspection_type, version`,
      [batchId],
    )
    return r.rows.map((row) => mapInspection(row as InspectionRow))
  }

  async findEffective(detailId: string, inspectionType: 'first' | 're'): Promise<InspectionRecordRow | null> {
    const r = await this.client.query(
      `SELECT ${INSPECTION_COLUMNS} FROM inspection_record
       WHERE detail_id = $1 AND inspection_type = $2 AND is_effective LIMIT 1`,
      [detailId, inspectionType],
    )
    return r.rows[0] ? mapInspection(r.rows[0] as InspectionRow) : null
  }

  async setEffective(id: string, isEffective: boolean, actor: string | null): Promise<void> {
    await this.client.query(
      `UPDATE inspection_record SET is_effective = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
      [id, isEffective, actor],
    )
  }
}

// ---------------- batch_judgement（A-7 版本化） ----------------

export class PgBatchJudgementRepository implements BatchJudgementRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(input: {
    batchId: string
    version: number
    conclusion: 'qualified' | 'unqualified'
    judgeBy: string
    judgedAt: string
    note?: string | null
    commandReceiptId?: string | null
  }): Promise<BatchJudgementRecord> {
    const r = await this.client.query(
      `INSERT INTO batch_judgement (batch_id, version, conclusion, judge_by, judged_at, note, command_receipt_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [input.batchId, input.version, input.conclusion, input.judgeBy, input.judgedAt, input.note ?? null, input.commandReceiptId ?? null],
    )
    const row = r.rows[0] as {
      id: string
      batch_id: string
      version: number
      conclusion: 'qualified' | 'unqualified'
      judge_by: string
      judged_at: Date | string
      note: string | null
      is_effective: boolean
    }
    return {
      id: row.id,
      batchId: row.batch_id,
      version: row.version,
      conclusion: row.conclusion,
      judgeBy: row.judge_by,
      judgedAt: iso(row.judged_at),
      note: row.note,
      isEffective: row.is_effective,
    }
  }

  async listByBatch(batchId: string): Promise<BatchJudgementRecord[]> {
    const r = await this.client.query(
      `SELECT * FROM batch_judgement WHERE batch_id = $1 ORDER BY version`,
      [batchId],
    )
    return r.rows.map(
      (row: {
        id: string
        batch_id: string
        version: number
        conclusion: 'qualified' | 'unqualified'
        judge_by: string
        judged_at: Date | string
        note: string | null
        is_effective: boolean
      }) => ({
        id: row.id,
        batchId: row.batch_id,
        version: row.version,
        conclusion: row.conclusion,
        judgeBy: row.judge_by,
        judgedAt: iso(row.judged_at),
        note: row.note,
        isEffective: row.is_effective,
      }),
    )
  }

  async setEffective(id: string, isEffective: boolean, actor: string | null): Promise<void> {
    await this.client.query(
      `UPDATE batch_judgement SET is_effective = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
      [id, isEffective, actor],
    )
  }
}

// ---------------- external_mapping / inbox（IF-00.2/IF-00.8） ----------------

const PURCHASE_LINE_OBJECT_TYPE = 'purchase_order_line'

export class PgPurchaseExternalMappingRepository implements PurchaseExternalMappingRepository {
  constructor(private readonly client: SqlClient) {}

  async findLineMapping(input: {
    sourceSystem: string
    organizationCode: string
    externalId: string
    lineNo: number
  }): Promise<{ localObjectId: string } | null> {
    const r = await this.client.query(
      `SELECT local_object_id FROM external_mapping
       WHERE source_system = $1 AND organization_code = $2 AND object_type = $3
         AND external_id = $4 AND line_no = $5`,
      [input.sourceSystem, input.organizationCode, PURCHASE_LINE_OBJECT_TYPE, input.externalId, input.lineNo],
    )
    return r.rows[0] ? { localObjectId: (r.rows[0] as { local_object_id: string }).local_object_id } : null
  }

  async insertLineMapping(input: {
    sourceSystem: string
    organizationCode: string
    externalId: string
    lineNo: number
    localObjectId: string
    createdBy?: string | null
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO external_mapping (source_system, organization_code, object_type, external_id, line_no,
         local_object_type, local_object_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $3, $6, $7)`,
      [
        input.sourceSystem,
        input.organizationCode,
        PURCHASE_LINE_OBJECT_TYPE,
        input.externalId,
        input.lineNo,
        input.localObjectId,
        input.createdBy ?? null,
      ],
    )
  }

  async insertQuarantinedInbox(input: {
    sourceSystem: string
    organizationCode: string
    externalKey: string
    entityType: string
    quarantineReason: string
    payload: unknown
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO inbox (source_system, organization_code, external_key, entity_type, status,
         quarantine_reason, payload)
       VALUES ($1, $2, $3, $4, 'QUARANTINED', $5, $6::jsonb)`,
      [
        input.sourceSystem,
        input.organizationCode,
        input.externalKey,
        input.entityType,
        input.quarantineReason,
        JSON.stringify(input.payload ?? {}),
      ],
    )
  }
}

// ---------------- material 免检/分类查询（0003） ----------------

export class PgPurchaseMaterialLookup implements PurchaseMaterialLookup {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<MaterialQcLookup | null> {
    const r = await this.client.query(
      `SELECT id, code, name, material_type, base_uom, qc_flag FROM material WHERE id = $1`,
      [id],
    )
    return r.rows[0] ? this.mapRow(r.rows[0]) : null
  }

  async findByCode(code: string, orgScopeId: string): Promise<MaterialQcLookup | null> {
    const r = await this.client.query(
      `SELECT id, code, name, material_type, base_uom, qc_flag FROM material
       WHERE org_scope_id = $1 AND code = $2 AND status = 'active'`,
      [orgScopeId, code],
    )
    return r.rows[0] ? this.mapRow(r.rows[0]) : null
  }

  private mapRow(row: {
    id: string
    code: string
    name: string | null
    material_type: number | null
    base_uom: string | null
    qc_flag: number
  }): MaterialQcLookup {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      materialType: row.material_type,
      baseUom: row.base_uom,
      qcFlag: row.qc_flag,
    }
  }
}

/** purchase 仓储束（组合根与测试共用）。 */
export function createPgPurchaseRepositories(client: SqlClient) {
  return {
    orders: new PgPurchaseOrderRepository(client),
    lines: new PgPurchaseOrderLineRepository(client),
    batches: new PgPurchaseBatchRepository(client),
    details: new PgReceiptDetailRepository(client),
    inspections: new PgInspectionRecordRepository(client),
    judgements: new PgBatchJudgementRepository(client),
    mappings: new PgPurchaseExternalMappingRepository(client),
    materials: new PgPurchaseMaterialLookup(client),
  }
}
