// 跨包类型导入（type-only，编译期擦除）：指向 application 已构建的 dist（构建顺序由 workspace
// 拓扑保证：persistence 依赖 application）。shipping 端口尚未并入 @cadenza/application
// 包名入口（application/src/index.ts 为共享文件不改动），故走 dist 相对；L0 整合步把端口
// 导出并入 application index、本文件导出并入 persistence index 后改包名导入（同 quality/warehousing 先例）。
import type {
  DcCompositionRecord,
  DcCompositionRepository,
  NewDcComposition,
  NewPackingOrder,
  NewPackingScan,
  NewShipmentLine,
  NewShipmentOrder,
  NewShipmentPhoto,
  OutboxTaskAccess,
  PackingOrderRecord,
  PackingOrderRepository,
  PackingScanRepository,
  PackingScanRecord,
  QuarantinedInboxWriter,
  ShipmentLineRecord,
  ShipmentLineRepository,
  ShipmentOrderRecord,
  ShipmentOrderRepository,
  ShipmentPhotoRecord,
  ShipmentPhotoRepository,
  ShippingRepositories,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'
import { PgReportOutputRepository } from './execution-repositories'

/**
 * shipping 域仓储的 PostgreSQL 实现（implements application 端口；0010 shipping 表
 * 列一一对应）。行锁方法（lockById）在命令事务内 SELECT ... FOR UPDATE；
 * packing_scan 为 append-only + 删码标记（触发器守卫事实列）；outbox/inbox 直用 0001 表。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

// ---------------- shipment_order ----------------

const ORDER_COLUMNS = `id, pl_no, sales_order_no, customer_name, source_system, external_revision, status,
  composition_missing, outbound_by, outbound_at, actual_axis_sync_status, shipping_status_sync_status,
  actual_axis_snapshot, status_sync_snapshot, command_receipt_id, plant_id, enterprise_id,
  business_time, created_at, created_by, updated_at, updated_by`

interface OrderRow {
  id: string
  pl_no: string
  sales_order_no: string
  customer_name: string | null
  source_system: string
  external_revision: number | null
  status: ShipmentOrderRecord['status']
  composition_missing: boolean
  outbound_by: string | null
  outbound_at: Date | string | null
  actual_axis_sync_status: ShipmentOrderRecord['actualAxisSyncStatus']
  shipping_status_sync_status: ShipmentOrderRecord['shippingStatusSyncStatus']
  actual_axis_snapshot: Record<string, unknown> | null
  status_sync_snapshot: Record<string, unknown> | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapOrder(r: OrderRow): ShipmentOrderRecord {
  return {
    id: r.id,
    plNo: r.pl_no,
    salesOrderNo: r.sales_order_no,
    customerName: r.customer_name,
    sourceSystem: r.source_system,
    externalRevision: r.external_revision,
    status: r.status,
    compositionMissing: r.composition_missing,
    outboundBy: r.outbound_by,
    outboundAt: isoOrNull(r.outbound_at),
    actualAxisSyncStatus: r.actual_axis_sync_status,
    shippingStatusSyncStatus: r.shipping_status_sync_status,
    actualAxisSnapshot: r.actual_axis_snapshot ?? null,
    statusSyncSnapshot: r.status_sync_snapshot ?? null,
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

export class PgShipmentOrderRepository implements ShipmentOrderRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(order: NewShipmentOrder): Promise<ShipmentOrderRecord> {
    const r = await this.client.query(
      `INSERT INTO shipment_order
         (pl_no, sales_order_no, customer_name, source_system, external_revision, composition_missing,
          command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${ORDER_COLUMNS}`,
      [
        order.plNo,
        order.salesOrderNo,
        order.customerName ?? null,
        order.sourceSystem ?? 'PL',
        order.externalRevision ?? null,
        order.compositionMissing ?? false,
        order.commandReceiptId ?? null,
        order.plantId,
        order.enterpriseId,
        order.businessTime ?? new Date().toISOString(),
        order.createdBy ?? null,
      ],
    )
    return mapOrder(r.rows[0] as OrderRow)
  }

  async findById(id: string): Promise<ShipmentOrderRecord | null> {
    const r = await this.client.query(`SELECT ${ORDER_COLUMNS} FROM shipment_order WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async findByPlNo(plNo: string): Promise<ShipmentOrderRecord | null> {
    const r = await this.client.query(`SELECT ${ORDER_COLUMNS} FROM shipment_order WHERE pl_no = $1`, [plNo])
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async lockById(id: string): Promise<ShipmentOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM shipment_order WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async updateStatus(
    id: string,
    patch: { status: ShipmentOrderRecord['status'] },
    actor: string | null,
  ): Promise<ShipmentOrderRecord | null> {
    const r = await this.client.query(
      `UPDATE shipment_order SET status = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${ORDER_COLUMNS}`,
      [id, patch.status, actor],
    )
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async markShipped(
    id: string,
    patch: {
      outboundBy: string
      outboundAt: string
      actualAxisSyncStatus: ShipmentOrderRecord['actualAxisSyncStatus']
      shippingStatusSyncStatus: ShipmentOrderRecord['shippingStatusSyncStatus']
      actualAxisSnapshot: Record<string, unknown>
      statusSyncSnapshot: Record<string, unknown>
    },
    actor: string | null,
  ): Promise<ShipmentOrderRecord | null> {
    const r = await this.client.query(
      `UPDATE shipment_order SET status = 'shipped', outbound_by = $2, outbound_at = $3,
         actual_axis_sync_status = $4, shipping_status_sync_status = $5,
         actual_axis_snapshot = $6::jsonb, status_sync_snapshot = $7::jsonb,
         updated_at = now(), updated_by = $8
       WHERE id = $1 RETURNING ${ORDER_COLUMNS}`,
      [
        id,
        patch.outboundBy,
        patch.outboundAt,
        patch.actualAxisSyncStatus,
        patch.shippingStatusSyncStatus,
        JSON.stringify(patch.actualAxisSnapshot),
        JSON.stringify(patch.statusSyncSnapshot),
        actor,
      ],
    )
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async updateSyncStatus(
    id: string,
    patch: {
      actualAxisSyncStatus?: ShipmentOrderRecord['actualAxisSyncStatus']
      shippingStatusSyncStatus?: ShipmentOrderRecord['shippingStatusSyncStatus']
    },
    actor: string | null,
  ): Promise<ShipmentOrderRecord | null> {
    const r = await this.client.query(
      `UPDATE shipment_order SET
         actual_axis_sync_status = COALESCE($2, actual_axis_sync_status),
         shipping_status_sync_status = COALESCE($3, shipping_status_sync_status),
         updated_at = now(), updated_by = $4
       WHERE id = $1 RETURNING ${ORDER_COLUMNS}`,
      [id, patch.actualAxisSyncStatus ?? null, patch.shippingStatusSyncStatus ?? null, actor],
    )
    return r.rows[0] === undefined ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    plNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: ShipmentOrderRecord[]; total: number }> {
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
    if (filter.plNoLike !== undefined) {
      params.push(`%${filter.plNoLike}%`)
      conds.push(`pl_no LIKE $${params.length}`)
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const limitIdx = params.length - 1
    const offsetIdx = params.length
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM shipment_order ${where}
       ORDER BY created_at DESC, id LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    )
    const count = await this.client.query(
      `SELECT count(*)::text AS total FROM shipment_order ${where}`,
      params.slice(0, limitIdx - 1),
    )
    return { items: r.rows.map((row) => mapOrder(row as OrderRow)), total: Number(count.rows[0]!.total) }
  }
}

// ---------------- shipment_line ----------------

const LINE_COLUMNS = `id, shipment_order_id, line_no, line_kind, material_id, material_code,
  sales_order_line_no, customer_axis_no, standard_segment_length::text AS standard_segment_length,
  actual_segment_length::text AS actual_segment_length, segment_length::text AS segment_length,
  required_count, scanned_count, line_status, packing_status, packing_order_id,
  created_at, created_by, updated_at, updated_by`

interface LineRow {
  id: string
  shipment_order_id: string
  line_no: number
  line_kind: ShipmentLineRecord['lineKind']
  material_id: string | null
  material_code: string
  sales_order_line_no: string
  customer_axis_no: string | null
  standard_segment_length: string | null
  actual_segment_length: string | null
  segment_length: string | null
  required_count: number
  scanned_count: number
  line_status: ShipmentLineRecord['lineStatus']
  packing_status: 'pending' | 'bound' | null
  packing_order_id: string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapLine(r: LineRow): ShipmentLineRecord {
  return {
    id: r.id,
    shipmentOrderId: r.shipment_order_id,
    lineNo: r.line_no,
    lineKind: r.line_kind,
    materialId: r.material_id,
    materialCode: r.material_code,
    salesOrderLineNo: r.sales_order_line_no,
    customerAxisNo: r.customer_axis_no,
    standardSegmentLength: r.standard_segment_length,
    actualSegmentLength: r.actual_segment_length,
    segmentLength: r.segment_length,
    requiredCount: r.required_count,
    scannedCount: r.scanned_count,
    lineStatus: r.line_status,
    packingStatus: r.packing_status,
    packingOrderId: r.packing_order_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgShipmentLineRepository implements ShipmentLineRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(line: NewShipmentLine): Promise<ShipmentLineRecord> {
    const r = await this.client.query(
      `INSERT INTO shipment_line
         (shipment_order_id, line_no, line_kind, material_id, material_code, sales_order_line_no,
          customer_axis_no, standard_segment_length, segment_length, required_count, packing_status,
          packing_order_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${LINE_COLUMNS}`,
      [
        line.shipmentOrderId,
        line.lineNo,
        line.lineKind,
        line.materialId ?? null,
        line.materialCode,
        line.salesOrderLineNo,
        line.customerAxisNo ?? null,
        line.standardSegmentLength ?? null,
        line.segmentLength ?? null,
        line.requiredCount,
        line.packingStatus ?? null,
        line.packingOrderId ?? null,
        line.createdBy ?? null,
      ],
    )
    return mapLine(r.rows[0] as LineRow)
  }

  async findById(id: string): Promise<ShipmentLineRecord | null> {
    const r = await this.client.query(`SELECT ${LINE_COLUMNS} FROM shipment_line WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapLine(r.rows[0] as LineRow)
  }

  async lockById(id: string): Promise<ShipmentLineRecord | null> {
    const r = await this.client.query(`SELECT ${LINE_COLUMNS} FROM shipment_line WHERE id = $1 FOR UPDATE`, [id])
    return r.rows[0] === undefined ? null : mapLine(r.rows[0] as LineRow)
  }

  async listByOrder(shipmentOrderId: string): Promise<ShipmentLineRecord[]> {
    const r = await this.client.query(
      `SELECT ${LINE_COLUMNS} FROM shipment_line WHERE shipment_order_id = $1 ORDER BY line_no`,
      [shipmentOrderId],
    )
    return r.rows.map((row) => mapLine(row as LineRow))
  }

  async updateProgress(
    id: string,
    patch: {
      scannedCount: number
      lineStatus: ShipmentLineRecord['lineStatus']
      actualSegmentLength?: string | null
      packingOrderId?: string | null
      packingStatus?: 'pending' | 'bound'
    },
    actor: string | null,
  ): Promise<ShipmentLineRecord | null> {
    const r = await this.client.query(
      `UPDATE shipment_line SET scanned_count = $2, line_status = $3,
         actual_segment_length = COALESCE($4, actual_segment_length),
         packing_order_id = COALESCE($5, packing_order_id),
         packing_status = COALESCE($6, packing_status),
         updated_at = now(), updated_by = $7
       WHERE id = $1 RETURNING ${LINE_COLUMNS}`,
      [
        id,
        patch.scannedCount,
        patch.lineStatus,
        patch.actualSegmentLength ?? null,
        patch.packingOrderId ?? null,
        patch.packingStatus ?? null,
        actor,
      ],
    )
    return r.rows[0] === undefined ? null : mapLine(r.rows[0] as LineRow)
  }
}

// ---------------- packing_order ----------------

const PACKING_COLUMNS = `id, packing_no, shipment_order_id, pallet_code, to_location_id, to_location_code,
  status, bound_by, bound_at, command_receipt_id, plant_id, enterprise_id, business_time,
  created_at, created_by, updated_at, updated_by`

interface PackingRow {
  id: string
  packing_no: string
  shipment_order_id: string
  pallet_code: string
  to_location_id: string
  to_location_code: string
  status: PackingOrderRecord['status']
  bound_by: string | null
  bound_at: Date | string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapPacking(r: PackingRow): PackingOrderRecord {
  return {
    id: r.id,
    packingNo: r.packing_no,
    shipmentOrderId: r.shipment_order_id,
    palletCode: r.pallet_code,
    toLocationId: r.to_location_id,
    toLocationCode: r.to_location_code,
    status: r.status,
    boundBy: r.bound_by,
    boundAt: isoOrNull(r.bound_at),
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

export class PgPackingOrderRepository implements PackingOrderRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(order: NewPackingOrder): Promise<PackingOrderRecord> {
    const r = await this.client.query(
      `INSERT INTO packing_order
         (packing_no, shipment_order_id, pallet_code, to_location_id, to_location_code,
          command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${PACKING_COLUMNS}`,
      [
        order.packingNo,
        order.shipmentOrderId,
        order.palletCode,
        order.toLocationId,
        order.toLocationCode,
        order.commandReceiptId ?? null,
        order.plantId,
        order.enterpriseId,
        order.businessTime ?? new Date().toISOString(),
        order.createdBy ?? null,
      ],
    )
    return mapPacking(r.rows[0] as PackingRow)
  }

  async findById(id: string): Promise<PackingOrderRecord | null> {
    const r = await this.client.query(`SELECT ${PACKING_COLUMNS} FROM packing_order WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapPacking(r.rows[0] as PackingRow)
  }

  async lockById(id: string): Promise<PackingOrderRecord | null> {
    const r = await this.client.query(`SELECT ${PACKING_COLUMNS} FROM packing_order WHERE id = $1 FOR UPDATE`, [id])
    return r.rows[0] === undefined ? null : mapPacking(r.rows[0] as PackingRow)
  }

  async listByShipment(shipmentOrderId: string): Promise<PackingOrderRecord[]> {
    const r = await this.client.query(
      `SELECT ${PACKING_COLUMNS} FROM packing_order WHERE shipment_order_id = $1 ORDER BY created_at, id`,
      [shipmentOrderId],
    )
    return r.rows.map((row) => mapPacking(row as PackingRow))
  }

  async findBoundByPallet(palletCode: string): Promise<PackingOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${PACKING_COLUMNS} FROM packing_order WHERE pallet_code = $1 AND status = 'bound' LIMIT 1`,
      [palletCode],
    )
    return r.rows[0] === undefined ? null : mapPacking(r.rows[0] as PackingRow)
  }

  async bind(
    id: string,
    patch: { boundBy: string; boundAt: string },
    actor: string | null,
  ): Promise<PackingOrderRecord | null> {
    const r = await this.client.query(
      `UPDATE packing_order SET status = 'bound', bound_by = $2, bound_at = $3,
         updated_at = now(), updated_by = $4
       WHERE id = $1 AND status = 'pending' RETURNING ${PACKING_COLUMNS}`,
      [id, patch.boundBy, patch.boundAt, actor],
    )
    return r.rows[0] === undefined ? null : mapPacking(r.rows[0] as PackingRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    palletCodeLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: PackingOrderRecord[]; total: number }> {
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
    if (filter.palletCodeLike !== undefined) {
      params.push(`%${filter.palletCodeLike}%`)
      conds.push(`pallet_code LIKE $${params.length}`)
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const limitIdx = params.length - 1
    const offsetIdx = params.length
    const r = await this.client.query(
      `SELECT ${PACKING_COLUMNS} FROM packing_order ${where}
       ORDER BY created_at DESC, id LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    )
    const count = await this.client.query(
      `SELECT count(*)::text AS total FROM packing_order ${where}`,
      params.slice(0, limitIdx - 1),
    )
    return { items: r.rows.map((row) => mapPacking(row as PackingRow)), total: Number(count.rows[0]!.total) }
  }
}

// ---------------- packing_scan（append-only + 删码标记） ----------------

const SCAN_COLUMNS = `id, shipment_order_id, shipment_line_id, scan_kind, inventory_unit_id, unit_no,
  customer_axis_no, actual_segment_length::text AS actual_segment_length, scanned_by, scanned_at,
  deleted, deleted_by, deleted_at, command_receipt_id, plant_id, enterprise_id, business_time,
  created_at, created_by`

interface ScanRow {
  id: string
  shipment_order_id: string
  shipment_line_id: string
  scan_kind: PackingScanRecord['scanKind']
  inventory_unit_id: string | null
  unit_no: string
  customer_axis_no: string | null
  actual_segment_length: string | null
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

function mapScan(r: ScanRow): PackingScanRecord {
  return {
    id: r.id,
    shipmentOrderId: r.shipment_order_id,
    shipmentLineId: r.shipment_line_id,
    scanKind: r.scan_kind,
    inventoryUnitId: r.inventory_unit_id,
    unitNo: r.unit_no,
    customerAxisNo: r.customer_axis_no,
    actualSegmentLength: r.actual_segment_length,
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

export class PgPackingScanRepository implements PackingScanRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(scan: NewPackingScan): Promise<PackingScanRecord> {
    const r = await this.client.query(
      `INSERT INTO packing_scan
         (shipment_order_id, shipment_line_id, scan_kind, inventory_unit_id, unit_no, customer_axis_no,
          actual_segment_length, scanned_by, scanned_at, command_receipt_id, plant_id, enterprise_id,
          business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${SCAN_COLUMNS}`,
      [
        scan.shipmentOrderId,
        scan.shipmentLineId,
        scan.scanKind,
        scan.inventoryUnitId ?? null,
        scan.unitNo,
        scan.customerAxisNo ?? null,
        scan.actualSegmentLength ?? null,
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

  async findById(id: string): Promise<PackingScanRecord | null> {
    const r = await this.client.query(`SELECT ${SCAN_COLUMNS} FROM packing_scan WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapScan(r.rows[0] as ScanRow)
  }

  async listByOrder(shipmentOrderId: string): Promise<PackingScanRecord[]> {
    const r = await this.client.query(
      `SELECT ${SCAN_COLUMNS} FROM packing_scan WHERE shipment_order_id = $1 ORDER BY scanned_at, id`,
      [shipmentOrderId],
    )
    return r.rows.map((row) => mapScan(row as ScanRow))
  }

  async listByLine(shipmentLineId: string): Promise<PackingScanRecord[]> {
    const r = await this.client.query(
      `SELECT ${SCAN_COLUMNS} FROM packing_scan WHERE shipment_line_id = $1 ORDER BY scanned_at, id`,
      [shipmentLineId],
    )
    return r.rows.map((row) => mapScan(row as ScanRow))
  }

  async findActiveByOrderAndUnitNo(shipmentOrderId: string, unitNo: string): Promise<PackingScanRecord | null> {
    const r = await this.client.query(
      `SELECT ${SCAN_COLUMNS} FROM packing_scan WHERE shipment_order_id = $1 AND unit_no = $2 AND NOT deleted LIMIT 1`,
      [shipmentOrderId, unitNo],
    )
    return r.rows[0] === undefined ? null : mapScan(r.rows[0] as ScanRow)
  }

  async markDeleted(
    id: string,
    patch: { deletedBy: string; deletedAt: string },
    _actor: string | null,
  ): Promise<PackingScanRecord | null> {
    void _actor // 删码标记列即审计留痕（deleted_by/deleted_at），行无独立 updated_by 列
    const r = await this.client.query(
      `UPDATE packing_scan SET deleted = true, deleted_by = $2, deleted_at = $3
       WHERE id = $1 AND NOT deleted RETURNING ${SCAN_COLUMNS}`,
      [id, patch.deletedBy, patch.deletedAt],
    )
    return r.rows[0] === undefined ? null : mapScan(r.rows[0] as ScanRow)
  }
}

// ---------------- shipment_photo（append-only） ----------------

const PHOTO_COLUMNS = `id, shipment_order_id, file_name, storage_key, content_type, size_bytes,
  uploaded_by, uploaded_at, command_receipt_id, plant_id, enterprise_id, business_time, created_at, created_by`

interface PhotoRow {
  id: string
  shipment_order_id: string
  file_name: string
  storage_key: string
  content_type: string | null
  size_bytes: number | null
  uploaded_by: string
  uploaded_at: Date | string
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapPhoto(r: PhotoRow): ShipmentPhotoRecord {
  return {
    id: r.id,
    shipmentOrderId: r.shipment_order_id,
    fileName: r.file_name,
    storageKey: r.storage_key,
    contentType: r.content_type,
    sizeBytes: r.size_bytes,
    uploadedBy: r.uploaded_by,
    uploadedAt: iso(r.uploaded_at),
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgShipmentPhotoRepository implements ShipmentPhotoRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(photo: NewShipmentPhoto): Promise<ShipmentPhotoRecord> {
    const r = await this.client.query(
      `INSERT INTO shipment_photo
         (shipment_order_id, file_name, storage_key, content_type, size_bytes, uploaded_by, uploaded_at,
          command_receipt_id, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${PHOTO_COLUMNS}`,
      [
        photo.shipmentOrderId,
        photo.fileName,
        photo.storageKey,
        photo.contentType ?? null,
        photo.sizeBytes ?? null,
        photo.uploadedBy,
        photo.uploadedAt,
        photo.commandReceiptId ?? null,
        photo.plantId,
        photo.enterpriseId,
        photo.createdBy ?? null,
      ],
    )
    return mapPhoto(r.rows[0] as PhotoRow)
  }

  async listByOrder(shipmentOrderId: string): Promise<ShipmentPhotoRecord[]> {
    const r = await this.client.query(
      `SELECT ${PHOTO_COLUMNS} FROM shipment_photo WHERE shipment_order_id = $1 ORDER BY uploaded_at, id`,
      [shipmentOrderId],
    )
    return r.rows.map((row) => mapPhoto(row as PhotoRow))
  }
}

// ---------------- dc_segment_composition ----------------

const DC_COLUMNS = `id, dc_id, sales_order_no, line_no, source_system, external_revision, sync_status,
  composition, missing_marked_at, plant_id, enterprise_id, business_time, created_at, created_by,
  updated_at, updated_by`

interface DcRow {
  id: string
  dc_id: string
  sales_order_no: string
  line_no: number
  source_system: string
  external_revision: number | null
  sync_status: DcCompositionRecord['syncStatus']
  composition: Record<string, unknown> | null
  missing_marked_at: Date | string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapDc(r: DcRow): DcCompositionRecord {
  return {
    id: r.id,
    dcId: r.dc_id,
    salesOrderNo: r.sales_order_no,
    lineNo: r.line_no,
    sourceSystem: r.source_system,
    externalRevision: r.external_revision,
    syncStatus: r.sync_status,
    composition: r.composition ?? null,
    missingMarkedAt: isoOrNull(r.missing_marked_at),
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgDcCompositionRepository implements DcCompositionRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(record: NewDcComposition): Promise<DcCompositionRecord> {
    const r = await this.client.query(
      `INSERT INTO dc_segment_composition
         (dc_id, sales_order_no, line_no, source_system, external_revision, sync_status,
          composition, missing_marked_at, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) RETURNING ${DC_COLUMNS}`,
      [
        record.dcId,
        record.salesOrderNo,
        record.lineNo,
        record.sourceSystem ?? 'DC',
        record.externalRevision ?? null,
        record.syncStatus ?? 'received',
        record.composition === null || record.composition === undefined ? null : JSON.stringify(record.composition),
        record.missingMarkedAt ?? null,
        record.plantId,
        record.enterpriseId,
        record.createdBy ?? null,
      ],
    )
    return mapDc(r.rows[0] as DcRow)
  }

  async findByKey(dcId: string, salesOrderNo: string, lineNo: number): Promise<DcCompositionRecord | null> {
    const r = await this.client.query(
      `SELECT ${DC_COLUMNS} FROM dc_segment_composition WHERE dc_id = $1 AND sales_order_no = $2 AND line_no = $3`,
      [dcId, salesOrderNo, lineNo],
    )
    return r.rows[0] === undefined ? null : mapDc(r.rows[0] as DcRow)
  }

  async applyComposition(
    id: string,
    patch: { composition: Record<string, unknown> | null; syncStatus: DcCompositionRecord['syncStatus'] },
    actor: string | null,
  ): Promise<DcCompositionRecord | null> {
    const r = await this.client.query(
      `UPDATE dc_segment_composition SET composition = $2::jsonb, sync_status = $3,
         missing_marked_at = CASE WHEN $3 = 'missing' THEN now() ELSE missing_marked_at END,
         updated_at = now(), updated_by = $4
       WHERE id = $1 RETURNING ${DC_COLUMNS}`,
      [id, patch.composition === null ? null : JSON.stringify(patch.composition), patch.syncStatus, actor],
    )
    return r.rows[0] === undefined ? null : mapDc(r.rows[0] as DcRow)
  }

  async listBySalesOrder(salesOrderNo: string): Promise<DcCompositionRecord[]> {
    const r = await this.client.query(
      `SELECT ${DC_COLUMNS} FROM dc_segment_composition WHERE sales_order_no = $1 ORDER BY line_no`,
      [salesOrderNo],
    )
    return r.rows.map((row) => mapDc(row as DcRow))
  }
}

// ---------------- 0001 outbox / inbox 窄读写 ----------------

export class PgOutboxTaskAccess implements OutboxTaskAccess {
  constructor(private readonly client: SqlClient) {}

  async findLatestByTask(aggregateType: string, aggregateId: string, taskKind: string) {
    const r = await this.client.query(
      `SELECT event_id, status, payload, attempt_count FROM outbox
       WHERE aggregate_type = $1 AND aggregate_id = $2 AND task_kind = $3
       ORDER BY created_at DESC, event_id LIMIT 1`,
      [aggregateType, aggregateId, taskKind],
    )
    const row = r.rows[0] as
      | { event_id: string; status: string; payload: Record<string, unknown> | null; attempt_count: number }
      | undefined
    if (row === undefined) return null
    return { eventId: row.event_id, status: row.status, payload: row.payload ?? {}, attemptCount: row.attempt_count }
  }

  async markStatus(
    eventId: string,
    patch: { status: 'DISPATCHED' | 'SYNC_FAILED' | 'NOOP_NEEDED'; lastError?: string | null },
  ): Promise<void> {
    await this.client.query(
      `UPDATE outbox SET status = $2, attempt_count = attempt_count + 1,
         last_error = COALESCE($3, last_error), updated_at = now()
       WHERE event_id = $1`,
      [eventId, patch.status, patch.lastError ?? null],
    )
  }
}

export class PgQuarantinedInboxWriter implements QuarantinedInboxWriter {
  constructor(private readonly client: SqlClient) {}

  async insertQuarantinedInbox(input: {
    sourceSystem: string
    organizationCode: string
    externalKey: string
    entityType: string
    quarantineReason: string
    payload: Record<string, unknown>
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO inbox (source_system, organization_code, external_key, entity_type, status,
         quarantine_reason, payload)
       VALUES ($1,$2,$3,$4,'QUARANTINED',$5,$6::jsonb)
       ON CONFLICT (source_system, organization_code, external_key, entity_type) DO NOTHING`,
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

/** shipping 仓储束（命令事务客户端绑定）。 */
type ShipmentFulfilmentRepository = ShippingRepositories['fulfilment']
class PgShipmentFulfilmentRepository implements ShipmentFulfilmentRepository {
  constructor(private readonly client: SqlClient) {}

  async originForUnit(unitId: string): ReturnType<ShippingRepositories['fulfilment']['originForUnit']> {
    // Reuse the existing approved-output/split-edge verifier, including cycle,
    // boundary and missing-source rejection. Do not invent sales ownership from
    // axis labels, a request field or the shipment itself.
    const roots = await new PgReportOutputRepository(this.client).originReportsForUnit(unitId)
    if (roots.length === 0 || roots.some((r) => r.reportId === null)) return null
    const ids = [...new Set(roots.map((r) => r.reportId!))]
    const r = await this.client.query(`SELECT pr.id AS report_id,po.id AS order_id,po.enterprise_id,po.plant_id,po.material_id,
      po.sales_order_no,po.line_no,po.uom,ax.unit_no AS axis_unit_no,ax.sales_order_no AS axis_sales_order_no,
      ax.order_line_no AS axis_order_line_no,ax.segment_length,ax.customer_axis_no,u.unit_no
      FROM production_report pr JOIN production_order po ON po.id=pr.order_id
      JOIN inventory_unit u ON u.id=$1 AND po.enterprise_id=u.enterprise_id AND po.plant_id=u.plant_id AND po.material_id=u.material_id
      LEFT JOIN axis_no_state ax ON ax.unit_id=u.id
      WHERE pr.id=ANY($2::uuid[]) AND pr.status='submitted' AND pr.review_status IN ('auto_approved','manual_approved')
        AND pr.review_cancelled_at IS NULL AND po.order_status<>'voided'
        AND pr.enterprise_id=po.enterprise_id AND pr.plant_id=po.plant_id
      FOR SHARE OF pr,po`, [unitId, ids])
    type Row = { report_id: string; order_id: string; enterprise_id: string; plant_id: string; material_id: string;
      sales_order_no: string | null; line_no: string | null; uom: string; axis_unit_no: string | null;
      axis_sales_order_no: string | null; axis_order_line_no: string | null; segment_length: string | null;
      customer_axis_no: string | null; unit_no: string }
    const rows = r.rows as unknown as Row[]
    if (rows.length !== ids.length || rows.some((row) => !row.sales_order_no?.trim() || !row.line_no?.trim())) return null
    const keys = new Set(rows.map((row) => JSON.stringify([row.enterprise_id,row.plant_id,row.material_id,row.sales_order_no,row.line_no,row.uom])))
    if (keys.size !== 1) return null
    const row = rows[0]!
    if (row.axis_unit_no !== null && (row.axis_unit_no !== row.unit_no || row.axis_sales_order_no !== row.sales_order_no || row.axis_order_line_no !== row.line_no)) return null
    return { enterpriseId: row.enterprise_id, plantId: row.plant_id, materialId: row.material_id,
      salesOrderNo: row.sales_order_no!, salesOrderLineNo: row.line_no!, uomCode: row.uom,
      segmentLength: row.segment_length, customerAxisNo: row.customer_axis_no, sourceOrderIds: [...new Set(rows.map((item) => item.order_id))] }
  }
}

export function createPgShippingRepositories(client: SqlClient): ShippingRepositories {
  return {
    fulfilment: new PgShipmentFulfilmentRepository(client),
    orders: new PgShipmentOrderRepository(client),
    lines: new PgShipmentLineRepository(client),
    packings: new PgPackingOrderRepository(client),
    scans: new PgPackingScanRepository(client),
    photos: new PgShipmentPhotoRepository(client),
    compositions: new PgDcCompositionRepository(client),
    outboxTasks: new PgOutboxTaskAccess(client),
    quarantinedInbox: new PgQuarantinedInboxWriter(client),
  }
}
