// [L0-整合标记] application index（共享文件）未导出 reverse 面：type-only 跨包导入暂以
// dist 相对桥接；L0 整合步在 packages/application/src/index.ts 追加导出 reverse-repositories
// 后改包名导入（与 shipping-repositories 同一整合口径）。
import type {
  CarrierFacts,
  CarrierFactsLookup,
  CarrierLoanRecord,
  NewCarrierLoan,
  CarrierLoanRepository,
  NewReceiptCorrection,
  NewStockAdjustment,
  NewStocktakeCountLine,
  NewStocktakeOrder,
  NewTransferInboundLine,
  NewTransferInboundOrder,
  NewTransferOutboundOrder,
  NewTransferOutboundPlanLine,
  NewTransferOutboundScan,
  PurchaseBatchFacts,
  PurchaseBatchLookup,
  ReceiptCorrectionRecord,
  ReceiptCorrectionRepository,
  ReceiptDetailFacts,
  ReverseLocationLookup,
  ReverseMaterialLookup,
  ReverseRepositories,
  ReverseWarehouseLookup,
  StockAdjustmentLineRecord,
  StockAdjustmentRecord,
  StockAdjustmentRepository,
  StockMoveRecordHeader,
  StockMoveRecordLineRecord,
  StockMoveRecordRepository,
  StocktakeCountLineRecord,
  StocktakeCountLineRepository,
  StocktakeOrderRecord,
  StocktakeOrderRepository,
  TransferInboundLineRecord,
  TransferInboundLineRepository,
  TransferInboundOrderRecord,
  TransferInboundOrderRepository,
  TransferOutboundOrderRecord,
  TransferOutboundOrderRepository,
  TransferOutboundPlanLineRecord,
  TransferOutboundPlanLineRepository,
  TransferOutboundScanRecord,
  TransferOutboundScanRepository,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

/**
 * reverse 域仓储的 PostgreSQL 实现（implements application 端口；0013 warehouse-reverse 表
 * 列一一对应 + 0006 采购批次只读事实）。行锁方法在命令事务内 SELECT ... FOR UPDATE；
 * stock_move_record(_line)/carrier_loan/receipt_correction 为 append-only（触发器守卫，
 * 无 UPDATE/DELETE 方法）。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

// ---------------- stock_move_record / line ----------------

const MOVE_HEADER_COLUMNS = `id, move_no, warehouse_id, warehouse_code, to_location_id, to_location_code,
  location_kind, material_codes_joined, total_qty::text AS total_qty, moved_by, moved_at, reason,
  command_receipt_id, plant_id, enterprise_id, business_time, created_at`

interface MoveHeaderRow {
  id: string
  move_no: string
  warehouse_id: string
  warehouse_code: string | null
  to_location_id: string
  to_location_code: string
  location_kind: string | null
  material_codes_joined: string
  total_qty: string
  moved_by: string
  moved_at: Date | string
  reason: string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
}

function mapMoveHeader(r: MoveHeaderRow): StockMoveRecordHeader {
  return {
    id: r.id,
    moveNo: r.move_no,
    warehouseId: r.warehouse_id,
    warehouseCode: r.warehouse_code,
    toLocationId: r.to_location_id,
    toLocationCode: r.to_location_code,
    locationKind: r.location_kind,
    materialCodesJoined: r.material_codes_joined,
    totalQty: r.total_qty,
    movedBy: r.moved_by,
    movedAt: iso(r.moved_at),
    reason: r.reason,
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
  }
}

const MOVE_LINE_COLUMNS = `id, record_id, line_no, inventory_unit_id, unit_no, material_id, material_code,
  from_location_id, from_location_code, to_location_id, to_location_code, quantity::text AS quantity, uom_id, uom_code`

interface MoveLineRow {
  id: string
  record_id: string
  line_no: number
  inventory_unit_id: string
  unit_no: string
  material_id: string
  material_code: string
  from_location_id: string | null
  from_location_code: string | null
  to_location_id: string
  to_location_code: string
  quantity: string
  uom_id: string
  uom_code: string
}

function mapMoveLine(r: MoveLineRow): StockMoveRecordLineRecord {
  return {
    id: r.id,
    recordId: r.record_id,
    lineNo: r.line_no,
    inventoryUnitId: r.inventory_unit_id,
    unitNo: r.unit_no,
    materialId: r.material_id,
    materialCode: r.material_code,
    fromLocationId: r.from_location_id,
    fromLocationCode: r.from_location_code,
    toLocationId: r.to_location_id,
    toLocationCode: r.to_location_code,
    quantity: r.quantity,
    uomId: r.uom_id,
    uomCode: r.uom_code,
  }
}

export class PgStockMoveRecordRepository implements StockMoveRecordRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(
    header: Omit<StockMoveRecordHeader, 'id' | 'createdAt'> & { createdBy?: string | null },
    lines: ReadonlyArray<Omit<StockMoveRecordLineRecord, 'id' | 'recordId'>>,
  ): Promise<{ header: StockMoveRecordHeader; lines: StockMoveRecordLineRecord[] }> {
    const h = await this.client.query(
      `INSERT INTO stock_move_record
         (move_no, warehouse_id, warehouse_code, to_location_id, to_location_code, location_kind,
          material_codes_joined, total_qty, moved_by, moved_at, reason, command_receipt_id,
          plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${MOVE_HEADER_COLUMNS}`,
      [
        header.moveNo,
        header.warehouseId,
        header.warehouseCode ?? null,
        header.toLocationId,
        header.toLocationCode,
        header.locationKind ?? null,
        header.materialCodesJoined,
        header.totalQty,
        header.movedBy,
        header.movedAt,
        header.reason ?? null,
        header.commandReceiptId ?? null,
        header.plantId,
        header.enterpriseId,
        header.businessTime,
        header.createdBy ?? null,
      ],
    )
    const headerRecord = mapMoveHeader(h.rows[0] as MoveHeaderRow)
    const inserted: StockMoveRecordLineRecord[] = []
    for (const line of lines) {
      const r = await this.client.query(
        `INSERT INTO stock_move_record_line
           (record_id, line_no, inventory_unit_id, unit_no, material_id, material_code,
            from_location_id, from_location_code, to_location_id, to_location_code, quantity, uom_id, uom_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${MOVE_LINE_COLUMNS}`,
        [
          headerRecord.id,
          line.lineNo,
          line.inventoryUnitId,
          line.unitNo,
          line.materialId,
          line.materialCode,
          line.fromLocationId ?? null,
          line.fromLocationCode ?? null,
          line.toLocationId,
          line.toLocationCode,
          line.quantity,
          line.uomId,
          line.uomCode,
        ],
      )
      inserted.push(mapMoveLine(r.rows[0] as MoveLineRow))
    }
    return { header: headerRecord, lines: inserted }
  }

  async findById(id: string): Promise<{ header: StockMoveRecordHeader; lines: StockMoveRecordLineRecord[] } | null> {
    const h = await this.client.query(`SELECT ${MOVE_HEADER_COLUMNS} FROM stock_move_record WHERE id = $1`, [id])
    if (h.rowCount === 0) return null
    const l = await this.client.query(`SELECT ${MOVE_LINE_COLUMNS} FROM stock_move_record_line WHERE record_id = $1 ORDER BY line_no`, [id])
    return { header: mapMoveHeader(h.rows[0] as MoveHeaderRow), lines: (l.rows as MoveLineRow[]).map(mapMoveLine) }
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    unitNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: StockMoveRecordHeader[]; total: number }> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null) {
      conditions.push(`plant_id = ANY($${params.length + 1})`)
      params.push(filter.plantIds)
    }
    if (filter.plantId !== undefined) {
      conditions.push(`plant_id = $${params.length + 1}`)
      params.push(filter.plantId)
    }
    if (filter.unitNoLike !== undefined) {
      conditions.push(
        `id IN (SELECT record_id FROM stock_move_record_line WHERE unit_no ILIKE $${params.length + 1})`,
      )
      params.push(`%${filter.unitNoLike}%`)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = await this.client.query(
      `SELECT count(*)::int AS total FROM stock_move_record ${where}`,
      params,
    )
    const offset = (filter.page - 1) * filter.pageSize
    const page = await this.client.query(
      `SELECT ${MOVE_HEADER_COLUMNS} FROM stock_move_record ${where} ORDER BY moved_at DESC, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.pageSize, offset],
    )
    return { items: (page.rows as MoveHeaderRow[]).map(mapMoveHeader), total: total.rows[0]!.total }
  }
}

// ---------------- transfer_outbound_order / plan_line / scan ----------------

const OUT_ORDER_COLUMNS = `id, order_no, source_kind, transfer_kind, related_order_no, from_warehouse_id,
  to_warehouse_id, from_warehouse_code, to_warehouse_code, from_warehouse_type, to_warehouse_type,
  status, to_location_id, to_location_code, to_location_kind, transit_location_id, transit_location_code,
  shipped_by, shipped_at, note, plant_id, enterprise_id, business_time, created_at, created_by, updated_at`

interface OutOrderRow {
  id: string
  order_no: string
  source_kind: TransferOutboundOrderRecord['sourceKind']
  transfer_kind: TransferOutboundOrderRecord['transferKind']
  related_order_no: string | null
  from_warehouse_id: string
  to_warehouse_id: string
  from_warehouse_code: string | null
  to_warehouse_code: string | null
  from_warehouse_type: string | null
  to_warehouse_type: string | null
  status: TransferOutboundOrderRecord['status']
  to_location_id: string | null
  to_location_code: string | null
  to_location_kind: string | null
  transit_location_id: string | null
  transit_location_code: string | null
  shipped_by: string | null
  shipped_at: Date | string | null
  note: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
}

function mapOutOrder(r: OutOrderRow): TransferOutboundOrderRecord {
  return {
    id: r.id,
    orderNo: r.order_no,
    sourceKind: r.source_kind,
    transferKind: r.transfer_kind,
    relatedOrderNo: r.related_order_no,
    fromWarehouseId: r.from_warehouse_id,
    toWarehouseId: r.to_warehouse_id,
    fromWarehouseCode: r.from_warehouse_code,
    toWarehouseCode: r.to_warehouse_code,
    fromWarehouseType: r.from_warehouse_type,
    toWarehouseType: r.to_warehouse_type,
    status: r.status,
    toLocationId: r.to_location_id,
    toLocationCode: r.to_location_code,
    toLocationKind: r.to_location_kind,
    transitLocationId: r.transit_location_id,
    transitLocationCode: r.transit_location_code,
    shippedBy: r.shipped_by,
    shippedAt: r.shipped_at === null ? null : iso(r.shipped_at),
    note: r.note,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
  }
}

export class PgTransferOutboundOrderRepository implements TransferOutboundOrderRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(order: NewTransferOutboundOrder): Promise<TransferOutboundOrderRecord> {
    const r = await this.client.query(
      `INSERT INTO transfer_outbound_order
         (order_no, source_kind, transfer_kind, related_order_no, from_warehouse_id, to_warehouse_id,
          from_warehouse_code, to_warehouse_code, from_warehouse_type, to_warehouse_type, status,
          to_location_id, to_location_code, to_location_kind, transit_location_id, transit_location_code,
          shipped_by, shipped_at, note, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING ${OUT_ORDER_COLUMNS}`,
      [
        order.orderNo,
        order.sourceKind,
        order.transferKind,
        order.relatedOrderNo ?? null,
        order.fromWarehouseId,
        order.toWarehouseId,
        order.fromWarehouseCode ?? null,
        order.toWarehouseCode ?? null,
        order.fromWarehouseType ?? null,
        order.toWarehouseType ?? null,
        order.status ?? 'pending_out',
        order.toLocationId ?? null,
        order.toLocationCode ?? null,
        order.toLocationKind ?? null,
        order.transitLocationId ?? null,
        order.transitLocationCode ?? null,
        order.shippedBy ?? null,
        order.shippedAt ?? null,
        order.note ?? null,
        order.plantId,
        order.enterpriseId,
        new Date().toISOString(),
        order.createdBy ?? null,
      ],
    )
    return mapOutOrder(r.rows[0] as OutOrderRow)
  }

  async findById(id: string): Promise<TransferOutboundOrderRecord | null> {
    const r = await this.client.query(`SELECT ${OUT_ORDER_COLUMNS} FROM transfer_outbound_order WHERE id = $1`, [id])
    return r.rowCount === 0 ? null : mapOutOrder(r.rows[0] as OutOrderRow)
  }

  async lockById(id: string): Promise<TransferOutboundOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${OUT_ORDER_COLUMNS} FROM transfer_outbound_order WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rowCount === 0 ? null : mapOutOrder(r.rows[0] as OutOrderRow)
  }

  async updateStatus(
    id: string,
    patch: {
      status?: TransferOutboundOrderRecord['status']
      toLocationId?: string | null
      toLocationCode?: string | null
      toLocationKind?: string | null
      transitLocationId?: string | null
      shippedBy?: string | null
      shippedAt?: string | null
      cancelledBy?: string | null
    },
    actor: string | null,
  ): Promise<TransferOutboundOrderRecord | null> {
    const sets: string[] = ['updated_at = now()', 'updated_by = $2']
    const params: unknown[] = [id, actor]
    const add = (column: string, value: unknown): void => {
      params.push(value)
      sets.push(`${column} = $${params.length}`)
    }
    if (patch.status !== undefined) add('status', patch.status)
    if (patch.toLocationId !== undefined) add('to_location_id', patch.toLocationId)
    if (patch.toLocationCode !== undefined) add('to_location_code', patch.toLocationCode)
    if (patch.toLocationKind !== undefined) add('to_location_kind', patch.toLocationKind)
    if (patch.transitLocationId !== undefined) add('transit_location_id', patch.transitLocationId)
    if (patch.shippedBy !== undefined) add('shipped_by', patch.shippedBy)
    if (patch.shippedAt !== undefined) add('shipped_at', patch.shippedAt)
    const r = await this.client.query(
      `UPDATE transfer_outbound_order SET ${sets.join(', ')} WHERE id = $1 RETURNING ${OUT_ORDER_COLUMNS}`,
      params,
    )
    return r.rowCount === 0 ? null : mapOutOrder(r.rows[0] as OutOrderRow)
  }

  async findTasklessInProgressByOperator(operator: string): Promise<TransferOutboundOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${OUT_ORDER_COLUMNS} FROM transfer_outbound_order
       WHERE created_by = $1 AND source_kind = 'pda_taskless' AND status IN ('pending_out', 'outbounding')
       ORDER BY created_at DESC LIMIT 1`,
      [operator],
    )
    return r.rowCount === 0 ? null : mapOutOrder(r.rows[0] as OutOrderRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    includeTasklessInProgress?: boolean
    page: number
    pageSize: number
  }): Promise<{ items: TransferOutboundOrderRecord[]; total: number }> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null) {
      conditions.push(`plant_id = ANY($${params.length + 1})`)
      params.push(filter.plantIds)
    }
    if (filter.plantId !== undefined) {
      conditions.push(`plant_id = $${params.length + 1}`)
      params.push(filter.plantId)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      conditions.push(`status = ANY($${params.length + 1})`)
      params.push(filter.statuses)
    }
    // WR-07②：无任务单完成出库前 Web 不显示
    if (filter.includeTasklessInProgress !== true) {
      conditions.push(`(source_kind <> 'pda_taskless' OR status = 'outbounded')`)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS total FROM transfer_outbound_order ${where}`, params)
    const offset = (filter.page - 1) * filter.pageSize
    const page = await this.client.query(
      `SELECT ${OUT_ORDER_COLUMNS} FROM transfer_outbound_order ${where} ORDER BY created_at DESC, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.pageSize, offset],
    )
    return { items: (page.rows as OutOrderRow[]).map(mapOutOrder), total: total.rows[0]!.total }
  }
}

export class PgTransferOutboundPlanLineRepository implements TransferOutboundPlanLineRepository {
  constructor(private readonly client: SqlClient) {}

  private readonly columns = `id, order_id, line_no, material_id, material_code, material_type,
    planned_qty::text AS planned_qty, out_qty::text AS out_qty`

  async insert(lines: readonly NewTransferOutboundPlanLine[]): Promise<TransferOutboundPlanLineRecord[]> {
    const inserted: TransferOutboundPlanLineRecord[] = []
    for (const line of lines) {
      const r = await this.client.query(
        `INSERT INTO transfer_outbound_plan_line
           (order_id, line_no, material_id, material_code, material_type, planned_qty, out_qty, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7) RETURNING ${this.columns}`,
        [
          line.orderId,
          line.lineNo,
          line.materialId,
          line.materialCode,
          line.materialType ?? null,
          line.plannedQty,
          line.createdBy ?? null,
        ],
      )
      const row = r.rows[0] as {
        id: string
        order_id: string
        line_no: number
        material_id: string
        material_code: string
        material_type: number | null
        planned_qty: string
        out_qty: string
      }
      inserted.push({
        id: row.id,
        orderId: row.order_id,
        lineNo: row.line_no,
        materialId: row.material_id,
        materialCode: row.material_code,
        materialType: row.material_type,
        plannedQty: row.planned_qty,
        outQty: row.out_qty,
      })
    }
    return inserted
  }

  async listByOrder(orderId: string): Promise<TransferOutboundPlanLineRecord[]> {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM transfer_outbound_plan_line WHERE order_id = $1 ORDER BY line_no`,
      [orderId],
    )
    return (r.rows as Array<{
      id: string
      order_id: string
      line_no: number
      material_id: string
      material_code: string
      material_type: number | null
      planned_qty: string
      out_qty: string
    }>).map((row) => ({
      id: row.id,
      orderId: row.order_id,
      lineNo: row.line_no,
      materialId: row.material_id,
      materialCode: row.material_code,
      materialType: row.material_type,
      plannedQty: row.planned_qty,
      outQty: row.out_qty,
    }))
  }

  /** WR-08：编辑=按料品比对明细增删改（未扫码才可编辑——整组替换）。 */
  async replaceOrderLines(
    orderId: string,
    lines: readonly NewTransferOutboundPlanLine[],
    actor: string | null,
  ): Promise<TransferOutboundPlanLineRecord[]> {
    await this.client.query(`DELETE FROM transfer_outbound_plan_line WHERE order_id = $1`, [orderId])
    void actor
    return this.insert(
      lines.map((l, index) => ({ ...l, orderId, lineNo: index + 1 })),
    )
  }

  async addOutQty(
    orderId: string,
    materialId: string,
    delta: string,
    actor: string | null,
  ): Promise<TransferOutboundPlanLineRecord | null> {
    const r = await this.client.query(
      `UPDATE transfer_outbound_plan_line
       SET out_qty = out_qty + $3::numeric, updated_at = now(), updated_by = $4
       WHERE order_id = $1 AND material_id = $2 RETURNING ${this.columns}`,
      [orderId, materialId, delta, actor],
    )
    if (r.rowCount === 0) return null
    const row = r.rows[0] as {
      id: string
      order_id: string
      line_no: number
      material_id: string
      material_code: string
      material_type: number | null
      planned_qty: string
      out_qty: string
    }
    return {
      id: row.id,
      orderId: row.order_id,
      lineNo: row.line_no,
      materialId: row.material_id,
      materialCode: row.material_code,
      materialType: row.material_type,
      plannedQty: row.planned_qty,
      outQty: row.out_qty,
    }
  }
}

export class PgTransferOutboundScanRepository implements TransferOutboundScanRepository {
  constructor(private readonly client: SqlClient) {}

  private readonly columns = `id, order_id, line_no, inventory_unit_id, unit_no, material_id, material_code,
    material_type, from_location_id, from_location_code, quantity::text AS quantity, out_qty::text AS out_qty,
    reservation_id, status, scanned_by, scanned_at, removed_by, removed_at, command_receipt_id`

  private map(r: {
    id: string
    order_id: string
    line_no: number
    inventory_unit_id: string
    unit_no: string
    material_id: string | null
    material_code: string | null
    material_type: number | null
    from_location_id: string | null
    from_location_code: string | null
    quantity: string
    out_qty: string
    reservation_id: string | null
    status: 'loaded' | 'removed'
    scanned_by: string
    scanned_at: Date | string
    removed_by: string | null
    removed_at: Date | string | null
    command_receipt_id: string | null
  }): TransferOutboundScanRecord {
    return {
      id: r.id,
      orderId: r.order_id,
      lineNo: r.line_no,
      inventoryUnitId: r.inventory_unit_id,
      unitNo: r.unit_no,
      materialId: r.material_id,
      materialCode: r.material_code,
      materialType: r.material_type,
      fromLocationId: r.from_location_id,
      fromLocationCode: r.from_location_code,
      quantity: r.quantity,
      outQty: r.out_qty,
      reservationId: r.reservation_id,
      status: r.status,
      scannedBy: r.scanned_by,
      scannedAt: iso(r.scanned_at),
      removedBy: r.removed_by,
      removedAt: r.removed_at === null ? null : iso(r.removed_at),
      commandReceiptId: r.command_receipt_id,
    }
  }

  async insert(scan: NewTransferOutboundScan): Promise<TransferOutboundScanRecord> {
    const r = await this.client.query(
      `INSERT INTO transfer_outbound_scan
         (order_id, line_no, inventory_unit_id, unit_no, material_id, material_code, material_type,
          from_location_id, from_location_code, quantity, out_qty, reservation_id, status, scanned_by,
          scanned_at, command_receipt_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'loaded',$13,$14,$15,$16)
       RETURNING ${this.columns}`,
      [
        scan.orderId,
        scan.lineNo,
        scan.inventoryUnitId,
        scan.unitNo,
        scan.materialId ?? null,
        scan.materialCode ?? null,
        scan.materialType ?? null,
        scan.fromLocationId ?? null,
        scan.fromLocationCode ?? null,
        scan.quantity,
        scan.outQty,
        scan.reservationId ?? null,
        scan.scannedBy,
        scan.scannedAt,
        scan.commandReceiptId ?? null,
        scan.scannedBy,
      ],
    )
    return this.map(r.rows[0] as Parameters<PgTransferOutboundScanRepository['map']>[0])
  }

  /** 自动生成调拨（WR-07③）多码一次落扫码事实（同事务多行）。 */
  async insertMany(scans: readonly NewTransferOutboundScan[]): Promise<TransferOutboundScanRecord[]> {
    if (scans.length === 0) return []
    const values: unknown[] = []
    const tuples = scans.map((scan, i) => {
      const base = i * 16
      values.push(
        scan.orderId,
        scan.lineNo,
        scan.inventoryUnitId,
        scan.unitNo,
        scan.materialId ?? null,
        scan.materialCode ?? null,
        scan.materialType ?? null,
        scan.fromLocationId ?? null,
        scan.fromLocationCode ?? null,
        scan.quantity,
        scan.outQty,
        scan.reservationId ?? null,
        scan.scannedBy,
        scan.scannedAt,
        scan.commandReceiptId ?? null,
        scan.scannedBy,
      )
      const p = (n: number): string => `$${base + n}`
      return `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)},'loaded',${p(13)},${p(14)},${p(15)},${p(16)})`
    })
    const r = await this.client.query(
      `INSERT INTO transfer_outbound_scan
         (order_id, line_no, inventory_unit_id, unit_no, material_id, material_code, material_type,
          from_location_id, from_location_code, quantity, out_qty, reservation_id, status, scanned_by,
          scanned_at, command_receipt_id, created_by)
       VALUES ${tuples.join(', ')}
       RETURNING ${this.columns}`,
      values,
    )
    return (r.rows as Parameters<PgTransferOutboundScanRepository['map']>[0][]).map((row) => this.map(row))
  }

  async listByOrder(orderId: string): Promise<TransferOutboundScanRecord[]> {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM transfer_outbound_scan WHERE order_id = $1 ORDER BY line_no`,
      [orderId],
    )
    return (r.rows as Parameters<PgTransferOutboundScanRepository['map']>[0][]).map((row) => this.map(row))
  }

  async findLoadedByUnit(orderId: string, inventoryUnitId: string): Promise<TransferOutboundScanRecord | null> {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM transfer_outbound_scan
       WHERE order_id = $1 AND inventory_unit_id = $2 AND status = 'loaded' LIMIT 1`,
      [orderId, inventoryUnitId],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgTransferOutboundScanRepository['map']>[0])
  }

  async markRemoved(id: string, removedBy: string, removedAt: string): Promise<TransferOutboundScanRecord | null> {
    const r = await this.client.query(
      `UPDATE transfer_outbound_scan
       SET status = 'removed', removed_by = $2, removed_at = $3, updated_at = now(), updated_by = $2
       WHERE id = $1 RETURNING ${this.columns}`,
      [id, removedBy, removedAt],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgTransferOutboundScanRepository['map']>[0])
  }

  async setReservation(id: string, reservationId: string | null): Promise<TransferOutboundScanRecord | null> {
    const r = await this.client.query(
      `UPDATE transfer_outbound_scan SET reservation_id = $2, updated_at = now() WHERE id = $1 RETURNING ${this.columns}`,
      [id, reservationId],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgTransferOutboundScanRepository['map']>[0])
  }
}

// ---------------- transfer_inbound_order / line ----------------

const IN_ORDER_COLUMNS = `id, order_no, outbound_order_id, inbound_mode, status, from_warehouse_id,
  to_warehouse_id, from_warehouse_code, to_warehouse_code, suggested_location_id, suggested_location_code,
  shipper_snapshot_by, shipper_snapshot_at, received_by, received_at, completed_at, command_receipt_id,
  plant_id, enterprise_id, business_time, created_at`

interface InOrderRow {
  id: string
  order_no: string
  outbound_order_id: string
  inbound_mode: TransferInboundOrderRecord['inboundMode']
  status: TransferInboundOrderRecord['status']
  from_warehouse_id: string
  to_warehouse_id: string
  from_warehouse_code: string | null
  to_warehouse_code: string | null
  suggested_location_id: string | null
  suggested_location_code: string | null
  shipper_snapshot_by: string | null
  shipper_snapshot_at: Date | string | null
  received_by: string | null
  received_at: Date | string | null
  completed_at: Date | string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
}

function mapInOrder(r: InOrderRow): TransferInboundOrderRecord {
  return {
    id: r.id,
    orderNo: r.order_no,
    outboundOrderId: r.outbound_order_id,
    inboundMode: r.inbound_mode,
    status: r.status,
    fromWarehouseId: r.from_warehouse_id,
    toWarehouseId: r.to_warehouse_id,
    fromWarehouseCode: r.from_warehouse_code,
    toWarehouseCode: r.to_warehouse_code,
    suggestedLocationId: r.suggested_location_id,
    suggestedLocationCode: r.suggested_location_code,
    shipperSnapshotBy: r.shipper_snapshot_by,
    shipperSnapshotAt: r.shipper_snapshot_at === null ? null : iso(r.shipper_snapshot_at),
    receivedBy: r.received_by,
    receivedAt: r.received_at === null ? null : iso(r.received_at),
    completedAt: r.completed_at === null ? null : iso(r.completed_at),
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
  }
}

export class PgTransferInboundOrderRepository implements TransferInboundOrderRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(order: NewTransferInboundOrder): Promise<TransferInboundOrderRecord> {
    const r = await this.client.query(
      `INSERT INTO transfer_inbound_order
         (order_no, outbound_order_id, inbound_mode, status, from_warehouse_id, to_warehouse_id,
          from_warehouse_code, to_warehouse_code, suggested_location_id, suggested_location_code,
          shipper_snapshot_by, shipper_snapshot_at, received_by, received_at, completed_at,
          command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING ${IN_ORDER_COLUMNS}`,
      [
        order.orderNo,
        order.outboundOrderId,
        order.inboundMode,
        order.status ?? 'pending_in',
        order.fromWarehouseId,
        order.toWarehouseId,
        order.fromWarehouseCode ?? null,
        order.toWarehouseCode ?? null,
        order.suggestedLocationId ?? null,
        order.suggestedLocationCode ?? null,
        order.shipperSnapshotBy ?? null,
        order.shipperSnapshotAt ?? null,
        null,
        null,
        order.completedAt ?? null,
        order.commandReceiptId ?? null,
        order.plantId,
        order.enterpriseId,
        new Date().toISOString(),
        order.createdBy ?? null,
      ],
    )
    return mapInOrder(r.rows[0] as InOrderRow)
  }

  async findById(id: string): Promise<TransferInboundOrderRecord | null> {
    const r = await this.client.query(`SELECT ${IN_ORDER_COLUMNS} FROM transfer_inbound_order WHERE id = $1`, [id])
    return r.rowCount === 0 ? null : mapInOrder(r.rows[0] as InOrderRow)
  }

  async lockById(id: string): Promise<TransferInboundOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${IN_ORDER_COLUMNS} FROM transfer_inbound_order WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rowCount === 0 ? null : mapInOrder(r.rows[0] as InOrderRow)
  }

  async findByOutboundOrder(outboundOrderId: string): Promise<TransferInboundOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${IN_ORDER_COLUMNS} FROM transfer_inbound_order WHERE outbound_order_id = $1 LIMIT 1`,
      [outboundOrderId],
    )
    return r.rowCount === 0 ? null : mapInOrder(r.rows[0] as InOrderRow)
  }

  async updateStatus(
    id: string,
    patch: {
      status?: TransferInboundOrderRecord['status']
      receivedBy?: string | null
      receivedAt?: string | null
      completedAt?: string | null
    },
    actor: string | null,
  ): Promise<TransferInboundOrderRecord | null> {
    const sets: string[] = ['updated_at = now()', 'updated_by = $2']
    const params: unknown[] = [id, actor]
    const add = (column: string, value: unknown): void => {
      params.push(value)
      sets.push(`${column} = $${params.length}`)
    }
    if (patch.status !== undefined) add('status', patch.status)
    if (patch.receivedBy !== undefined) add('received_by', patch.receivedBy)
    if (patch.receivedAt !== undefined) add('received_at', patch.receivedAt)
    if (patch.completedAt !== undefined) add('completed_at', patch.completedAt)
    const r = await this.client.query(
      `UPDATE transfer_inbound_order SET ${sets.join(', ')} WHERE id = $1 RETURNING ${IN_ORDER_COLUMNS}`,
      params,
    )
    return r.rowCount === 0 ? null : mapInOrder(r.rows[0] as InOrderRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: TransferInboundOrderRecord[]; total: number }> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null) {
      conditions.push(`plant_id = ANY($${params.length + 1})`)
      params.push(filter.plantIds)
    }
    if (filter.plantId !== undefined) {
      conditions.push(`plant_id = $${params.length + 1}`)
      params.push(filter.plantId)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      conditions.push(`status = ANY($${params.length + 1})`)
      params.push(filter.statuses)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS total FROM transfer_inbound_order ${where}`, params)
    const offset = (filter.page - 1) * filter.pageSize
    const page = await this.client.query(
      `SELECT ${IN_ORDER_COLUMNS} FROM transfer_inbound_order ${where} ORDER BY created_at DESC, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.pageSize, offset],
    )
    return { items: (page.rows as InOrderRow[]).map(mapInOrder), total: total.rows[0]!.total }
  }
}

export class PgTransferInboundLineRepository implements TransferInboundLineRepository {
  constructor(private readonly client: SqlClient) {}

  private readonly columns = `id, order_id, line_no, inventory_unit_id, unit_no, material_id, material_code,
    quantity::text AS quantity, line_status, is_pallet_child, location_id, location_code, reservation_id,
    inbound_at, removed_at`

  private map(r: {
    id: string
    order_id: string
    line_no: number
    inventory_unit_id: string
    unit_no: string
    material_id: string | null
    material_code: string | null
    quantity: string
    line_status: 'pending' | 'inbound'
    is_pallet_child: boolean
    location_id: string | null
    location_code: string | null
    reservation_id: string | null
    inbound_at: Date | string | null
    removed_at: Date | string | null
  }): TransferInboundLineRecord {
    return {
      id: r.id,
      orderId: r.order_id,
      lineNo: r.line_no,
      inventoryUnitId: r.inventory_unit_id,
      unitNo: r.unit_no,
      materialId: r.material_id,
      materialCode: r.material_code,
      quantity: r.quantity,
      lineStatus: r.line_status,
      isPalletChild: r.is_pallet_child,
      locationId: r.location_id,
      locationCode: r.location_code,
      reservationId: r.reservation_id,
      inboundAt: r.inbound_at === null ? null : iso(r.inbound_at),
      removedAt: r.removed_at === null ? null : iso(r.removed_at),
    }
  }

  async insert(lines: readonly NewTransferInboundLine[]): Promise<TransferInboundLineRecord[]> {
    const inserted: TransferInboundLineRecord[] = []
    for (const line of lines) {
      const r = await this.client.query(
        `INSERT INTO transfer_inbound_line
           (order_id, line_no, inventory_unit_id, unit_no, material_id, material_code, quantity,
            line_status, is_pallet_child, location_id, location_code, reservation_id, inbound_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${this.columns}`,
        [
          line.orderId,
          line.lineNo,
          line.inventoryUnitId,
          line.unitNo,
          line.materialId ?? null,
          line.materialCode ?? null,
          line.quantity,
          line.lineStatus ?? 'pending',
          line.isPalletChild ?? false,
          line.locationId ?? null,
          line.locationCode ?? null,
          line.reservationId ?? null,
          line.inboundAt ?? null,
          line.createdBy ?? null,
        ],
      )
      inserted.push(this.map(r.rows[0] as Parameters<PgTransferInboundLineRepository['map']>[0]))
    }
    return inserted
  }

  async listByOrder(orderId: string): Promise<TransferInboundLineRecord[]> {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM transfer_inbound_line WHERE order_id = $1 ORDER BY line_no`,
      [orderId],
    )
    return (r.rows as Parameters<PgTransferInboundLineRepository['map']>[0][]).map((row) => this.map(row))
  }

  async findByUnitNo(orderId: string, unitNo: string): Promise<TransferInboundLineRecord | null> {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM transfer_inbound_line WHERE order_id = $1 AND unit_no = $2 LIMIT 1`,
      [orderId, unitNo],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgTransferInboundLineRepository['map']>[0])
  }

  async lockById(id: string): Promise<TransferInboundLineRecord | null> {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM transfer_inbound_line WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgTransferInboundLineRepository['map']>[0])
  }

  async markPutaway(
    id: string,
    patch: { lineStatus: 'inbound'; locationId: string; locationCode: string; reservationId?: string | null; inboundAt: string },
    actor: string | null,
  ): Promise<TransferInboundLineRecord | null> {
    const r = await this.client.query(
      `UPDATE transfer_inbound_line
       SET line_status = $2, location_id = $3, location_code = $4,
           reservation_id = COALESCE($5, reservation_id), inbound_at = $6, updated_at = now(), updated_by = $7
       WHERE id = $1 RETURNING ${this.columns}`,
      [id, patch.lineStatus, patch.locationId, patch.locationCode, patch.reservationId ?? null, patch.inboundAt, actor],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgTransferInboundLineRepository['map']>[0])
  }

  async markReverted(id: string, revertedAt: string, actor: string | null): Promise<TransferInboundLineRecord | null> {
    const r = await this.client.query(
      `UPDATE transfer_inbound_line
       SET line_status = 'pending', location_id = NULL, location_code = NULL, reservation_id = NULL,
           removed_at = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${this.columns}`,
      [id, revertedAt, actor],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgTransferInboundLineRepository['map']>[0])
  }
}

// ---------------- stocktake_order / count_line / adjustment ----------------

export class PgStocktakeOrderRepository implements StocktakeOrderRepository {
  constructor(private readonly client: SqlClient) {}

  private readonly columns = `id, order_no, warehouse_id, warehouse_code, locked, status, note,
    started_by, started_at, closed_by, closed_at, plant_id, enterprise_id`

  private map(r: {
    id: string
    order_no: string
    warehouse_id: string
    warehouse_code: string | null
    locked: boolean
    status: StocktakeOrderRecord['status']
    note: string | null
    started_by: string
    started_at: Date | string
    closed_by: string | null
    closed_at: Date | string | null
    plant_id: string
    enterprise_id: string
  }): StocktakeOrderRecord {
    return {
      id: r.id,
      orderNo: r.order_no,
      warehouseId: r.warehouse_id,
      warehouseCode: r.warehouse_code,
      locked: r.locked,
      status: r.status,
      note: r.note,
      startedBy: r.started_by,
      startedAt: iso(r.started_at),
      closedBy: r.closed_by,
      closedAt: r.closed_at === null ? null : iso(r.closed_at),
      plantId: r.plant_id,
      enterpriseId: r.enterprise_id,
    }
  }

  async insert(order: NewStocktakeOrder): Promise<StocktakeOrderRecord> {
    const r = await this.client.query(
      `INSERT INTO stocktake_order
         (order_no, warehouse_id, warehouse_code, locked, status, note, started_by, started_at,
          plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,true,'counting',$4,$5,$6,$7,$8,$9,$10) RETURNING ${this.columns}`,
      [
        order.orderNo,
        order.warehouseId,
        order.warehouseCode ?? null,
        order.note ?? null,
        order.startedBy,
        order.startedAt,
        order.plantId,
        order.enterpriseId,
        new Date().toISOString(),
        order.createdBy ?? null,
      ],
    )
    return this.map(r.rows[0] as Parameters<PgStocktakeOrderRepository['map']>[0])
  }

  async findById(id: string): Promise<StocktakeOrderRecord | null> {
    const r = await this.client.query(`SELECT ${this.columns} FROM stocktake_order WHERE id = $1`, [id])
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgStocktakeOrderRepository['map']>[0])
  }

  async lockById(id: string): Promise<StocktakeOrderRecord | null> {
    const r = await this.client.query(`SELECT ${this.columns} FROM stocktake_order WHERE id = $1 FOR UPDATE`, [id])
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgStocktakeOrderRepository['map']>[0])
  }

  async findCountingByWarehouse(warehouseId: string): Promise<StocktakeOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM stocktake_order WHERE warehouse_id = $1 AND status = 'counting' LIMIT 1`,
      [warehouseId],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgStocktakeOrderRepository['map']>[0])
  }

  async close(
    id: string,
    patch: { status: 'completed' | 'cancelled'; locked: boolean; closedBy: string; closedAt: string },
    actor: string | null,
  ): Promise<StocktakeOrderRecord | null> {
    const r = await this.client.query(
      `UPDATE stocktake_order
       SET status = $2, locked = $3, closed_by = $4, closed_at = $5, updated_at = now(), updated_by = $6
       WHERE id = $1 RETURNING ${this.columns}`,
      [id, patch.status, patch.locked, patch.closedBy, patch.closedAt, actor],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgStocktakeOrderRepository['map']>[0])
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: StocktakeOrderRecord[]; total: number }> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null) {
      conditions.push(`plant_id = ANY($${params.length + 1})`)
      params.push(filter.plantIds)
    }
    if (filter.plantId !== undefined) {
      conditions.push(`plant_id = $${params.length + 1}`)
      params.push(filter.plantId)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      conditions.push(`status = ANY($${params.length + 1})`)
      params.push(filter.statuses)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS total FROM stocktake_order ${where}`, params)
    const offset = (filter.page - 1) * filter.pageSize
    const page = await this.client.query(
      `SELECT ${this.columns} FROM stocktake_order ${where} ORDER BY created_at DESC, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.pageSize, offset],
    )
    return { items: (page.rows as Parameters<PgStocktakeOrderRepository['map']>[0][]).map((row) => this.map(row)), total: total.rows[0]!.total }
  }
}

export class PgStocktakeCountLineRepository implements StocktakeCountLineRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(lines: readonly NewStocktakeCountLine[]): Promise<StocktakeCountLineRecord[]> {
    const inserted: StocktakeCountLineRecord[] = []
    for (const line of lines) {
      const r = await this.client.query(
        `INSERT INTO stocktake_count_line
           (order_id, inventory_unit_id, unit_no, material_code, location_id, location_code,
            book_qty, counted_qty, diff_qty, counted_by, counted_at, command_receipt_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, order_id, inventory_unit_id, unit_no, material_code, location_id, location_code,
           book_qty::text AS book_qty, counted_qty::text AS counted_qty, diff_qty::text AS diff_qty,
           counted_by, counted_at`,
        [
          line.orderId,
          line.inventoryUnitId,
          line.unitNo,
          line.materialCode ?? null,
          line.locationId ?? null,
          line.locationCode ?? null,
          line.bookQty,
          line.countedQty,
          line.diffQty,
          line.countedBy,
          line.countedAt,
          line.commandReceiptId ?? null,
          line.countedBy,
        ],
      )
      const row = r.rows[0] as {
        id: string
        order_id: string
        inventory_unit_id: string
        unit_no: string
        material_code: string | null
        location_id: string | null
        location_code: string | null
        book_qty: string
        counted_qty: string
        diff_qty: string
        counted_by: string
        counted_at: Date | string
      }
      inserted.push({
        id: row.id,
        orderId: row.order_id,
        inventoryUnitId: row.inventory_unit_id,
        unitNo: row.unit_no,
        materialCode: row.material_code,
        locationId: row.location_id,
        locationCode: row.location_code,
        bookQty: row.book_qty,
        countedQty: row.counted_qty,
        diffQty: row.diff_qty,
        countedBy: row.counted_by,
        countedAt: iso(row.counted_at),
      })
    }
    return inserted
  }

  async listByOrder(orderId: string): Promise<StocktakeCountLineRecord[]> {
    const r = await this.client.query(
      `SELECT id, order_id, inventory_unit_id, unit_no, material_code, location_id, location_code,
         book_qty::text AS book_qty, counted_qty::text AS counted_qty, diff_qty::text AS diff_qty,
         counted_by, counted_at
       FROM stocktake_count_line WHERE order_id = $1 ORDER BY counted_at, id`,
      [orderId],
    )
    return (r.rows as Array<{
      id: string
      order_id: string
      inventory_unit_id: string
      unit_no: string
      material_code: string | null
      location_id: string | null
      location_code: string | null
      book_qty: string
      counted_qty: string
      diff_qty: string
      counted_by: string
      counted_at: Date | string
    }>).map((row) => ({
      id: row.id,
      orderId: row.order_id,
      inventoryUnitId: row.inventory_unit_id,
      unitNo: row.unit_no,
      materialCode: row.material_code,
      locationId: row.location_id,
      locationCode: row.location_code,
      bookQty: row.book_qty,
      countedQty: row.counted_qty,
      diffQty: row.diff_qty,
      countedBy: row.counted_by,
      countedAt: iso(row.counted_at),
    }))
  }
}

export class PgStockAdjustmentRepository implements StockAdjustmentRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(
    adjustment: NewStockAdjustment,
    lines: ReadonlyArray<Omit<StockAdjustmentLineRecord, 'id' | 'adjustmentId'>>,
  ): Promise<{ adjustment: StockAdjustmentRecord; lines: StockAdjustmentLineRecord[] }> {
    const a = await this.client.query(
      `INSERT INTO stock_adjustment
         (adjustment_no, stocktake_order_id, reason, destination, total_qty, adjusted_by, adjusted_at,
          command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, adjustment_no, stocktake_order_id, reason, destination, total_qty::text AS total_qty,
         adjusted_by, adjusted_at, command_receipt_id, plant_id, enterprise_id`,
      [
        adjustment.adjustmentNo,
        adjustment.stocktakeOrderId ?? null,
        adjustment.reason,
        adjustment.destination,
        adjustment.totalQty,
        adjustment.adjustedBy,
        adjustment.adjustedAt,
        adjustment.commandReceiptId ?? null,
        adjustment.plantId,
        adjustment.enterpriseId,
        new Date().toISOString(),
        adjustment.createdBy ?? null,
      ],
    )
    const arow = a.rows[0] as {
      id: string
      adjustment_no: string
      stocktake_order_id: string | null
      reason: string
      destination: string
      total_qty: string
      adjusted_by: string
      adjusted_at: Date | string
      command_receipt_id: string | null
      plant_id: string
      enterprise_id: string
    }
    const adjustmentRecord: StockAdjustmentRecord = {
      id: arow.id,
      adjustmentNo: arow.adjustment_no,
      stocktakeOrderId: arow.stocktake_order_id,
      reason: arow.reason,
      destination: arow.destination,
      totalQty: arow.total_qty,
      adjustedBy: arow.adjusted_by,
      adjustedAt: iso(arow.adjusted_at),
      commandReceiptId: arow.command_receipt_id,
      plantId: arow.plant_id,
      enterpriseId: arow.enterprise_id,
    }
    const inserted: StockAdjustmentLineRecord[] = []
    for (const [index, line] of lines.entries()) {
      const r = await this.client.query(
        `INSERT INTO stock_adjustment_line
           (adjustment_id, line_no, inventory_unit_id, unit_no, location_id, location_code, owner_id,
            owner_name, adjust_qty, before_qty, after_qty, transaction_id, balance_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, adjustment_id, line_no, inventory_unit_id, unit_no, location_id, location_code,
           owner_id, owner_name, adjust_qty::text AS adjust_qty, before_qty::text AS before_qty,
           after_qty::text AS after_qty, transaction_id, balance_id`,
        [
          adjustmentRecord.id,
          index + 1,
          line.inventoryUnitId,
          line.unitNo,
          line.locationId,
          line.locationCode,
          line.ownerId,
          line.ownerName,
          line.adjustQty,
          line.beforeQty,
          line.afterQty,
          line.transactionId ?? null,
          line.balanceId,
        ],
      )
      const row = r.rows[0] as {
        id: string
        adjustment_id: string
        line_no: number
        inventory_unit_id: string
        unit_no: string
        location_id: string
        location_code: string
        owner_id: string
        owner_name: string
        adjust_qty: string
        before_qty: string
        after_qty: string
        transaction_id: string | null
        balance_id: string
      }
      inserted.push({
        id: row.id,
        adjustmentId: row.adjustment_id,
        lineNo: row.line_no,
        inventoryUnitId: row.inventory_unit_id,
        unitNo: row.unit_no,
        locationId: row.location_id,
        locationCode: row.location_code,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        adjustQty: row.adjust_qty,
        beforeQty: row.before_qty,
        afterQty: row.after_qty,
        transactionId: row.transaction_id,
        balanceId: row.balance_id,
      })
    }
    return { adjustment: adjustmentRecord, lines: inserted }
  }

  async findById(id: string): Promise<{ adjustment: StockAdjustmentRecord; lines: StockAdjustmentLineRecord[] } | null> {
    const a = await this.client.query(
      `SELECT id, adjustment_no, stocktake_order_id, reason, destination, total_qty::text AS total_qty,
         adjusted_by, adjusted_at, command_receipt_id, plant_id, enterprise_id
       FROM stock_adjustment WHERE id = $1`,
      [id],
    )
    if (a.rowCount === 0) return null
    const l = await this.client.query(
      `SELECT id, adjustment_id, line_no, inventory_unit_id, unit_no, location_id, location_code,
         owner_id, owner_name, adjust_qty::text AS adjust_qty, before_qty::text AS before_qty,
         after_qty::text AS after_qty, transaction_id, balance_id
       FROM stock_adjustment_line WHERE adjustment_id = $1 ORDER BY line_no`,
      [id],
    )
    const arow = a.rows[0] as {
      id: string
      adjustment_no: string
      stocktake_order_id: string | null
      reason: string
      destination: string
      total_qty: string
      adjusted_by: string
      adjusted_at: Date | string
      command_receipt_id: string | null
      plant_id: string
      enterprise_id: string
    }
    return {
      adjustment: {
        id: arow.id,
        adjustmentNo: arow.adjustment_no,
        stocktakeOrderId: arow.stocktake_order_id,
        reason: arow.reason,
        destination: arow.destination,
        totalQty: arow.total_qty,
        adjustedBy: arow.adjusted_by,
        adjustedAt: iso(arow.adjusted_at),
        commandReceiptId: arow.command_receipt_id,
        plantId: arow.plant_id,
        enterpriseId: arow.enterprise_id,
      },
      lines: (l.rows as Array<{
        id: string
        adjustment_id: string
        line_no: number
        inventory_unit_id: string
        unit_no: string
        location_id: string
        location_code: string
        owner_id: string
        owner_name: string
        adjust_qty: string
        before_qty: string
        after_qty: string
        transaction_id: string | null
        balance_id: string
      }>).map((row) => ({
        id: row.id,
        adjustmentId: row.adjustment_id,
        lineNo: row.line_no,
        inventoryUnitId: row.inventory_unit_id,
        unitNo: row.unit_no,
        locationId: row.location_id,
        locationCode: row.location_code,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        adjustQty: row.adjust_qty,
        beforeQty: row.before_qty,
        afterQty: row.after_qty,
        transactionId: row.transaction_id,
        balanceId: row.balance_id,
      })),
    }
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    page: number
    pageSize: number
  }): Promise<{ items: StockAdjustmentRecord[]; total: number }> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null) {
      conditions.push(`plant_id = ANY($${params.length + 1})`)
      params.push(filter.plantIds)
    }
    if (filter.plantId !== undefined) {
      conditions.push(`plant_id = $${params.length + 1}`)
      params.push(filter.plantId)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS total FROM stock_adjustment ${where}`, params)
    const offset = (filter.page - 1) * filter.pageSize
    const page = await this.client.query(
      `SELECT id, adjustment_no, stocktake_order_id, reason, destination, total_qty::text AS total_qty,
         adjusted_by, adjusted_at, command_receipt_id, plant_id, enterprise_id
       FROM stock_adjustment ${where} ORDER BY adjusted_at DESC, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.pageSize, offset],
    )
    return {
      items: (page.rows as Array<{
        id: string
        adjustment_no: string
        stocktake_order_id: string | null
        reason: string
        destination: string
        total_qty: string
        adjusted_by: string
        adjusted_at: Date | string
        command_receipt_id: string | null
        plant_id: string
        enterprise_id: string
      }>).map((row) => ({
        id: row.id,
        adjustmentNo: row.adjustment_no,
        stocktakeOrderId: row.stocktake_order_id,
        reason: row.reason,
        destination: row.destination,
        totalQty: row.total_qty,
        adjustedBy: row.adjusted_by,
        adjustedAt: iso(row.adjusted_at),
        commandReceiptId: row.command_receipt_id,
        plantId: row.plant_id,
        enterpriseId: row.enterprise_id,
      })),
      total: total.rows[0]!.total,
    }
  }
}

// ---------------- carrier_loan + carrier 事实 ----------------

export class PgCarrierLoanRepository implements CarrierLoanRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(loan: NewCarrierLoan): Promise<CarrierLoanRecord> {
    const r = await this.client.query(
      `INSERT INTO carrier_loan
         (carrier_id, carrier_code, carrier_kind, event_kind, counterparty, note, occurred_by,
          occurred_at, command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, carrier_id, carrier_code, carrier_kind, event_kind, counterparty, note,
         occurred_by, occurred_at, command_receipt_id, plant_id, enterprise_id`,
      [
        loan.carrierId,
        loan.carrierCode,
        loan.carrierKind,
        loan.eventKind,
        loan.counterparty ?? null,
        loan.note ?? null,
        loan.occurredBy,
        loan.occurredAt,
        loan.commandReceiptId ?? null,
        loan.plantId,
        loan.enterpriseId,
        new Date().toISOString(),
        loan.createdBy ?? null,
      ],
    )
    const row = r.rows[0] as {
      id: string
      carrier_id: string
      carrier_code: string
      carrier_kind: CarrierLoanRecord['carrierKind']
      event_kind: CarrierLoanRecord['eventKind']
      counterparty: string | null
      note: string | null
      occurred_by: string
      occurred_at: Date | string
      command_receipt_id: string | null
      plant_id: string
      enterprise_id: string
    }
    return {
      id: row.id,
      carrierId: row.carrier_id,
      carrierCode: row.carrier_code,
      carrierKind: row.carrier_kind,
      eventKind: row.event_kind,
      counterparty: row.counterparty,
      note: row.note,
      occurredBy: row.occurred_by,
      occurredAt: iso(row.occurred_at),
      commandReceiptId: row.command_receipt_id,
      plantId: row.plant_id,
      enterpriseId: row.enterprise_id,
    }
  }

  async listByCarrier(carrierId: string): Promise<CarrierLoanRecord[]> {
    const r = await this.client.query(
      `SELECT id, carrier_id, carrier_code, carrier_kind, event_kind, counterparty, note,
         occurred_by, occurred_at, command_receipt_id, plant_id, enterprise_id
       FROM carrier_loan WHERE carrier_id = $1 ORDER BY occurred_at, id`,
      [carrierId],
    )
    return (r.rows as Array<{
      id: string
      carrier_id: string
      carrier_code: string
      carrier_kind: CarrierLoanRecord['carrierKind']
      event_kind: CarrierLoanRecord['eventKind']
      counterparty: string | null
      note: string | null
      occurred_by: string
      occurred_at: Date | string
      command_receipt_id: string | null
      plant_id: string
      enterprise_id: string
    }>).map((row) => ({
      id: row.id,
      carrierId: row.carrier_id,
      carrierCode: row.carrier_code,
      carrierKind: row.carrier_kind,
      eventKind: row.event_kind,
      counterparty: row.counterparty,
      note: row.note,
      occurredBy: row.occurred_by,
      occurredAt: iso(row.occurred_at),
      commandReceiptId: row.command_receipt_id,
      plantId: row.plant_id,
      enterpriseId: row.enterprise_id,
    }))
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    eventKinds?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: CarrierLoanRecord[]; total: number }> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null) {
      conditions.push(`plant_id = ANY($${params.length + 1})`)
      params.push(filter.plantIds)
    }
    if (filter.plantId !== undefined) {
      conditions.push(`plant_id = $${params.length + 1}`)
      params.push(filter.plantId)
    }
    if (filter.eventKinds !== undefined && filter.eventKinds.length > 0) {
      conditions.push(`event_kind = ANY($${params.length + 1})`)
      params.push(filter.eventKinds)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS total FROM carrier_loan ${where}`, params)
    const offset = (filter.page - 1) * filter.pageSize
    const page = await this.client.query(
      `SELECT id, carrier_id, carrier_code, carrier_kind, event_kind, counterparty, note,
         occurred_by, occurred_at, command_receipt_id, plant_id, enterprise_id
       FROM carrier_loan ${where} ORDER BY occurred_at DESC, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.pageSize, offset],
    )
    return {
      items: (page.rows as Array<{
        id: string
        carrier_id: string
        carrier_code: string
        carrier_kind: CarrierLoanRecord['carrierKind']
        event_kind: CarrierLoanRecord['eventKind']
        counterparty: string | null
        note: string | null
        occurred_by: string
        occurred_at: Date | string
        command_receipt_id: string | null
        plant_id: string
        enterprise_id: string
      }>).map((row) => ({
        id: row.id,
        carrierId: row.carrier_id,
        carrierCode: row.carrier_code,
        carrierKind: row.carrier_kind,
        eventKind: row.event_kind,
        counterparty: row.counterparty,
        note: row.note,
        occurredBy: row.occurred_by,
        occurredAt: iso(row.occurred_at),
        commandReceiptId: row.command_receipt_id,
        plantId: row.plant_id,
        enterpriseId: row.enterprise_id,
      })),
      total: total.rows[0]!.total,
    }
  }

  /** WR-27/IT-01：清空仅解除当前装载——结束载具当前全部活动绑定（历史区间保留）。 */
  async endActiveLoads(carrierId: string, unloadedBy: string, reason: string | null, now: string): Promise<number> {
    const r = await this.client.query(
      `UPDATE carrier_binding
       SET effective_to = $3, unloaded_by = $2, unload_reason = $4, updated_at = now(), updated_by = $2
       WHERE carrier_id = $1 AND effective_to IS NULL`,
      [carrierId, unloadedBy, now, reason],
    )
    return r.rowCount ?? 0
  }
}

export class PgCarrierFactsLookup implements CarrierFactsLookup {
  constructor(private readonly client: SqlClient) {}

  private readonly columns = `id, carrier_code, carrier_kind, status, plant_id`

  private map(r: {
    id: string
    carrier_code: string
    carrier_kind: CarrierFacts['carrierKind']
    status: CarrierFacts['status']
    plant_id: string
  }): CarrierFacts {
    return { id: r.id, carrierCode: r.carrier_code, carrierKind: r.carrier_kind, status: r.status, plantId: r.plant_id }
  }

  async findById(id: string): Promise<CarrierFacts | null> {
    const r = await this.client.query(`SELECT ${this.columns} FROM carrier WHERE id = $1`, [id])
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgCarrierFactsLookup['map']>[0])
  }

  async findByCode(plantId: string, carrierCode: string): Promise<CarrierFacts | null> {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM carrier WHERE plant_id = $1 AND carrier_code = $2 LIMIT 1`,
      [plantId, carrierCode],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgCarrierFactsLookup['map']>[0])
  }

  async updateStatus(carrierId: string, status: CarrierFacts['status'], actor: string | null): Promise<CarrierFacts | null> {
    const r = await this.client.query(
      `UPDATE carrier SET status = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING ${this.columns}`,
      [carrierId, status, actor],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgCarrierFactsLookup['map']>[0])
  }

  async listAvailable(plantId: string): Promise<CarrierFacts[]> {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM carrier WHERE plant_id = $1 AND status NOT IN ('damaged', 'scrapped') ORDER BY carrier_code`,
      [plantId],
    )
    return (r.rows as Parameters<PgCarrierFactsLookup['map']>[0][]).map((row) => this.map(row))
  }
}

// ---------------- receipt_correction + 采购批次事实 ----------------

export class PgReceiptCorrectionRepository implements ReceiptCorrectionRepository {
  constructor(private readonly client: SqlClient) {}

  private readonly columns = `id, correction_no, batch_id, batch_no, correction_kind, quantity::text AS quantity,
    deducted_order_line_qty::text AS deducted_order_line_qty, reason, remark, attachments,
    return_sync_status, snapshot, operated_by, operated_at, command_receipt_id, plant_id, enterprise_id`

  private map(r: {
    id: string
    correction_no: string
    batch_id: string
    batch_no: string
    correction_kind: ReceiptCorrectionRecord['correctionKind']
    quantity: string
    deducted_order_line_qty: string
    reason: string
    remark: string | null
    attachments: string[]
    return_sync_status: ReceiptCorrectionRecord['returnSyncStatus']
    snapshot: Record<string, unknown>
    operated_by: string
    operated_at: Date | string
    command_receipt_id: string | null
    plant_id: string
    enterprise_id: string
  }): ReceiptCorrectionRecord {
    return {
      id: r.id,
      correctionNo: r.correction_no,
      batchId: r.batch_id,
      batchNo: r.batch_no,
      correctionKind: r.correction_kind,
      quantity: r.quantity,
      deductedOrderLineQty: r.deducted_order_line_qty,
      reason: r.reason,
      remark: r.remark,
      attachments: r.attachments,
      returnSyncStatus: r.return_sync_status,
      snapshot: r.snapshot,
      operatedBy: r.operated_by,
      operatedAt: iso(r.operated_at),
      commandReceiptId: r.command_receipt_id,
      plantId: r.plant_id,
      enterpriseId: r.enterprise_id,
    }
  }

  async insert(correction: NewReceiptCorrection): Promise<ReceiptCorrectionRecord> {
    const r = await this.client.query(
      `INSERT INTO receipt_correction
         (correction_no, batch_id, batch_no, correction_kind, quantity, deducted_order_line_qty,
          reason, remark, attachments, return_sync_status, snapshot, operated_by, operated_at,
          command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18)
       RETURNING ${this.columns}`,
      [
        correction.correctionNo,
        correction.batchId,
        correction.batchNo,
        correction.correctionKind,
        correction.quantity,
        correction.deductedOrderLineQty ?? '0.0000',
        correction.reason,
        correction.remark ?? null,
        JSON.stringify(correction.attachments ?? []),
        correction.returnSyncStatus ?? 'none',
        JSON.stringify(correction.snapshot ?? {}),
        correction.operatedBy,
        correction.operatedAt,
        correction.commandReceiptId ?? null,
        correction.plantId,
        correction.enterpriseId,
        new Date().toISOString(),
        correction.createdBy ?? null,
      ],
    )
    return this.map(r.rows[0] as Parameters<PgReceiptCorrectionRepository['map']>[0])
  }

  async findById(id: string): Promise<ReceiptCorrectionRecord | null> {
    const r = await this.client.query(`SELECT ${this.columns} FROM receipt_correction WHERE id = $1`, [id])
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgReceiptCorrectionRepository['map']>[0])
  }

  async findByBatch(batchId: string, kinds: readonly string[]): Promise<ReceiptCorrectionRecord[]> {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM receipt_correction
       WHERE batch_id = $1 AND correction_kind = ANY($2) ORDER BY operated_at, id`,
      [batchId, [...kinds]],
    )
    return (r.rows as Parameters<PgReceiptCorrectionRepository['map']>[0][]).map((row) => this.map(row))
  }

  async latestByBatch(batchId: string): Promise<ReceiptCorrectionRecord | null> {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM receipt_correction WHERE batch_id = $1 ORDER BY operated_at DESC, id DESC LIMIT 1`,
      [batchId],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgReceiptCorrectionRepository['map']>[0])
  }

  // WR-S6：receipt_correction append-only（触发器禁止 UPDATE）——回传状态投影走
  // purchase_receipt_batch.return_sync_status（PgReversePurchaseFacts.setBatchReturnSyncStatus）。

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    correctionKinds?: string[]
    batchNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: ReceiptCorrectionRecord[]; total: number }> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null) {
      conditions.push(`plant_id = ANY($${params.length + 1})`)
      params.push(filter.plantIds)
    }
    if (filter.plantId !== undefined) {
      conditions.push(`plant_id = $${params.length + 1}`)
      params.push(filter.plantId)
    }
    if (filter.correctionKinds !== undefined && filter.correctionKinds.length > 0) {
      conditions.push(`correction_kind = ANY($${params.length + 1})`)
      params.push(filter.correctionKinds)
    }
    if (filter.batchNoLike !== undefined) {
      conditions.push(`batch_no ILIKE $${params.length + 1}`)
      params.push(`%${filter.batchNoLike}%`)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS total FROM receipt_correction ${where}`, params)
    const offset = (filter.page - 1) * filter.pageSize
    const page = await this.client.query(
      `SELECT ${this.columns} FROM receipt_correction ${where} ORDER BY operated_at DESC, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.pageSize, offset],
    )
    return {
      items: (page.rows as Parameters<PgReceiptCorrectionRepository['map']>[0][]).map((row) => this.map(row)),
      total: total.rows[0]!.total,
    }
  }
}

const PURCHASE_BATCH_COLUMNS = `id, batch_no, purchase_line_id, order_no, line_no, material_id, material_code,
  warehouse_id, uom_id, uom_code, inspection_status, storage_status, received_qty::text AS received_qty,
  qualified_sync_status, return_sync_status, plant_id, enterprise_id`

interface PurchaseBatchRow {
  id: string
  batch_no: string
  purchase_line_id: string
  order_no: string
  line_no: number
  material_id: string
  material_code: string
  warehouse_id: string
  uom_id: string
  uom_code: string
  inspection_status: string
  storage_status: string
  received_qty: string
  qualified_sync_status: string
  return_sync_status: string
  plant_id: string
  enterprise_id: string
}

function mapPurchaseBatch(r: PurchaseBatchRow): PurchaseBatchFacts {
  return {
    id: r.id,
    batchNo: r.batch_no,
    purchaseLineId: r.purchase_line_id,
    orderNo: r.order_no,
    lineNo: r.line_no,
    materialId: r.material_id,
    materialCode: r.material_code,
    warehouseId: r.warehouse_id,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    inspectionStatus: r.inspection_status,
    storageStatus: r.storage_status,
    receivedQty: r.received_qty,
    qualifiedSyncStatus: r.qualified_sync_status,
    returnSyncStatus: r.return_sync_status,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
  }
}

interface ReceiptDetailRow {
  id: string
  batch_id: string
  barcode_value: string
  supplier_lot_no: string
  grade: string
  quantity: string
  quality_status: string
  inventory_unit_id: string | null
  location_id: string | null
  location_code: string | null
}

function mapReceiptDetail(r: ReceiptDetailRow): ReceiptDetailFacts {
  return {
    id: r.id,
    batchId: r.batch_id,
    barcodeValue: r.barcode_value,
    supplierLotNo: r.supplier_lot_no,
    grade: r.grade,
    quantity: r.quantity,
    qualityStatus: r.quality_status,
    inventoryUnitId: r.inventory_unit_id,
    locationId: r.location_id,
    locationCode: r.location_code,
  }
}

/**
 * 采购批次只读/等价写事实（0006 表；WR-18～23 等价服务消费——P1 purchase 域不自改，
 * 收编请求见交付记录 §7）。
 */
export class PgPurchaseBatchLookup implements PurchaseBatchLookup {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<PurchaseBatchFacts | null> {
    const r = await this.client.query(`SELECT ${PURCHASE_BATCH_COLUMNS} FROM purchase_receipt_batch WHERE id = $1`, [id])
    return r.rowCount === 0 ? null : mapPurchaseBatch(r.rows[0] as PurchaseBatchRow)
  }

  async listReceivedGroupsByBarcode(
    plantId: string,
    barcodeValue: string,
  ): Promise<Array<{ batchId: string; batchNo: string; supplierLotNo: string; grade: string; quantity: string }>> {
    const r = await this.client.query(
      `SELECT d.batch_id, b.batch_no, d.supplier_lot_no, d.grade, d.quantity::text AS quantity
       FROM receipt_detail d JOIN purchase_receipt_batch b ON b.id = d.batch_id
       WHERE b.plant_id = $1 AND d.barcode_value = $2
       ORDER BY b.created_at, d.created_at`,
      [plantId, barcodeValue],
    )
    return (r.rows as Array<{
      batch_id: string
      batch_no: string
      supplier_lot_no: string
      grade: string
      quantity: string
    }>).map((row) => ({
      batchId: row.batch_id,
      batchNo: row.batch_no,
      supplierLotNo: row.supplier_lot_no,
      grade: row.grade,
      quantity: row.quantity,
    }))
  }

  async listDetailsByBatch(batchId: string): Promise<ReceiptDetailFacts[]> {
    const r = await this.client.query(
      `SELECT id, batch_id, barcode_value, supplier_lot_no, grade, quantity::text AS quantity,
         quality_status, inventory_unit_id, location_id, location_code
       FROM receipt_detail WHERE batch_id = $1 ORDER BY created_at, id`,
      [batchId],
    )
    return (r.rows as ReceiptDetailRow[]).map(mapReceiptDetail)
  }

  async adjustOrderLineReceivedQty(
    purchaseLineId: string,
    delta: string,
    newStatus: number | null,
    actor: string | null,
  ): Promise<{ receivedQty: string; status: number } | null> {
    const r = await this.client.query(
      `UPDATE purchase_order_line
       SET received_qty = received_qty + $2::numeric,
           status = COALESCE($3, status),
           updated_at = now(), updated_by = $4
       WHERE id = $1
       RETURNING received_qty::text AS received_qty, status`,
      [purchaseLineId, delta, newStatus, actor],
    )
    if (r.rowCount === 0) return null
    return { receivedQty: (r.rows[0] as { received_qty: string }).received_qty, status: (r.rows[0] as { status: number }).status }
  }

  async lockOrderLine(purchaseLineId: string): Promise<{ id: string; receivedQty: string; plannedQty: string; status: number } | null> {
    const r = await this.client.query(
      `SELECT id, received_qty::text AS received_qty, planned_qty::text AS planned_qty, status
       FROM purchase_order_line WHERE id = $1 FOR UPDATE`,
      [purchaseLineId],
    )
    if (r.rowCount === 0) return null
    const row = r.rows[0] as { id: string; received_qty: string; planned_qty: string; status: number }
    return { id: row.id, receivedQty: row.received_qty, plannedQty: row.planned_qty, status: row.status }
  }

  async adjustBatchReceivedQty(batchId: string, delta: string, actor: string | null): Promise<PurchaseBatchFacts | null> {
    const r = await this.client.query(
      `UPDATE purchase_receipt_batch
       SET received_qty = received_qty + $2::numeric, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${PURCHASE_BATCH_COLUMNS}`,
      [batchId, delta, actor],
    )
    return r.rowCount === 0 ? null : mapPurchaseBatch(r.rows[0] as PurchaseBatchRow)
  }

  async updateBatchTimes(
    batchId: string,
    patch: { arrivalTime?: string; confirmTime?: string },
    actor: string | null,
  ): Promise<PurchaseBatchFacts | null> {
    const r = await this.client.query(
      `UPDATE purchase_receipt_batch
       SET arrival_time = COALESCE($2, arrival_time),
           confirm_time = COALESCE($3, confirm_time),
           updated_at = now(), updated_by = $4
       WHERE id = $1 RETURNING ${PURCHASE_BATCH_COLUMNS}`,
      [batchId, patch.arrivalTime ?? null, patch.confirmTime ?? null, actor],
    )
    return r.rowCount === 0 ? null : mapPurchaseBatch(r.rows[0] as PurchaseBatchRow)
  }

  async updateDetailStorage(
    detailId: string,
    patch: { locationId?: string | null; locationCode?: string | null; quantity?: string },
    actor: string | null,
  ): Promise<ReceiptDetailFacts | null> {
    const r = await this.client.query(
      `UPDATE receipt_detail
       SET location_id = COALESCE($2, location_id),
           location_code = COALESCE($3, location_code),
           quantity = COALESCE($4::numeric, quantity),
           updated_at = now(), updated_by = $5
       WHERE id = $1
       RETURNING id, batch_id, barcode_value, supplier_lot_no, grade, quantity::text AS quantity,
         quality_status, inventory_unit_id, location_id, location_code`,
      [detailId, patch.locationId ?? null, patch.locationCode ?? null, patch.quantity ?? null, actor],
    )
    return r.rowCount === 0 ? null : mapReceiptDetail(r.rows[0] as ReceiptDetailRow)
  }

  async setBatchReturnState(
    batchId: string,
    patch: { storageStatus: 'returned'; returnedAt: string; returnReason: string; returnSyncStatus: 'pending' },
    actor: string | null,
  ): Promise<PurchaseBatchFacts | null> {
    const r = await this.client.query(
      `UPDATE purchase_receipt_batch
       SET storage_status = $2, returned_at = $3, return_reason = $4, return_sync_status = $5,
           updated_at = now(), updated_by = $6
       WHERE id = $1 RETURNING ${PURCHASE_BATCH_COLUMNS}`,
      [batchId, patch.storageStatus, patch.returnedAt, patch.returnReason, patch.returnSyncStatus, actor],
    )
    return r.rowCount === 0 ? null : mapPurchaseBatch(r.rows[0] as PurchaseBatchRow)
  }

  async setBatchReturnSyncStatus(
    batchId: string,
    status: 'none' | 'pending' | 'failed' | 'synced',
    actor: string | null,
  ): Promise<PurchaseBatchFacts | null> {
    const r = await this.client.query(
      `UPDATE purchase_receipt_batch SET return_sync_status = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${PURCHASE_BATCH_COLUMNS}`,
      [batchId, status, actor],
    )
    return r.rowCount === 0 ? null : mapPurchaseBatch(r.rows[0] as PurchaseBatchRow)
  }

  async insertBatch(input: {
    batchNo: string
    purchaseLineId: string
    orderNo: string
    lineNo: number
    materialId: string
    materialCode: string
    materialType: number | null
    plantId: string
    enterpriseId: string
    warehouseId: string
    uomId: string
    uomCode: string
    inspectionStatus: string
    receivedQty: string
    arrivalTime: string
    confirmTime: string
    receivedBy: string
    createdBy?: string | null
  }): Promise<PurchaseBatchFacts> {
    const r = await this.client.query(
      `INSERT INTO purchase_receipt_batch
         (batch_no, purchase_line_id, order_no, line_no, material_id, material_code, material_type,
          plant_id, enterprise_id, warehouse_id, uom_id, uom_code, inspection_status, storage_status,
          received_qty, arrival_time, confirm_time, received_by, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'stored',$14,$15,$16,$17,$18,$19)
       ON CONFLICT (batch_no) DO UPDATE SET updated_at = now() RETURNING ${PURCHASE_BATCH_COLUMNS}`,
      [
        input.batchNo,
        input.purchaseLineId,
        input.orderNo,
        input.lineNo,
        input.materialId,
        input.materialCode,
        input.materialType,
        input.plantId,
        input.enterpriseId,
        input.warehouseId,
        input.uomId,
        input.uomCode,
        input.inspectionStatus,
        input.receivedQty,
        input.arrivalTime,
        input.confirmTime,
        input.receivedBy,
        new Date().toISOString(),
        input.createdBy ?? null,
      ],
    )
    return mapPurchaseBatch(r.rows[0] as PurchaseBatchRow)
  }

  async insertDetail(input: {
    batchId: string
    barcodeValue: string
    supplierLotNo: string
    grade: string
    quantity: string
    uomId: string
    uomCode: string
    qualityStatus: string
    inventoryUnitId?: string | null
    locationId?: string | null
    locationCode?: string | null
    createdBy?: string | null
  }): Promise<ReceiptDetailFacts> {
    const r = await this.client.query(
      `INSERT INTO receipt_detail
         (batch_id, barcode_value, supplier_lot_no, grade, quantity, uom_id, uom_code,
          quality_status, inventory_unit_id, location_id, location_code, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (batch_id, barcode_value, supplier_lot_no, grade)
       DO UPDATE SET quantity = receipt_detail.quantity + EXCLUDED.quantity, updated_at = now()
       RETURNING id, batch_id, barcode_value, supplier_lot_no, grade, quantity::text AS quantity,
         quality_status, inventory_unit_id, location_id, location_code`,
      [
        input.batchId,
        input.barcodeValue,
        input.supplierLotNo,
        input.grade,
        input.quantity,
        input.uomId,
        input.uomCode,
        input.qualityStatus,
        input.inventoryUnitId ?? null,
        input.locationId ?? null,
        input.locationCode ?? null,
        new Date().toISOString(),
        input.createdBy ?? null,
      ],
    )
    return mapReceiptDetail(r.rows[0] as ReceiptDetailRow)
  }

  async mergeDetailQuantity(detailId: string, addQty: string, actor: string | null): Promise<ReceiptDetailFacts | null> {
    const r = await this.client.query(
      `UPDATE receipt_detail SET quantity = quantity + $2::numeric, updated_at = now(), updated_by = $3
       WHERE id = $1
       RETURNING id, batch_id, barcode_value, supplier_lot_no, grade, quantity::text AS quantity,
         quality_status, inventory_unit_id, location_id, location_code`,
      [detailId, addQty, actor],
    )
    return r.rowCount === 0 ? null : mapReceiptDetail(r.rows[0] as ReceiptDetailRow)
  }

  async findDetailByTriple(batchId: string, barcodeValue: string, supplierLotNo: string, grade: string): Promise<ReceiptDetailFacts | null> {
    const r = await this.client.query(
      `SELECT id, batch_id, barcode_value, supplier_lot_no, grade, quantity::text AS quantity,
         quality_status, inventory_unit_id, location_id, location_code
       FROM receipt_detail
       WHERE batch_id = $1 AND barcode_value = $2 AND supplier_lot_no = $3 AND grade = $4
       LIMIT 1`,
      [batchId, barcodeValue, supplierLotNo, grade],
    )
    return r.rowCount === 0 ? null : mapReceiptDetail(r.rows[0] as ReceiptDetailRow)
  }

  /** WR-22：生效质量结果（inspection_record 生效结论=qualified 的明细编号）。 */
  async listEffectiveQualifiedDetailNos(batchId: string): Promise<string[]> {
    const r = await this.client.query(
      `SELECT DISTINCT i.detail_id::text AS detail_no
       FROM inspection_record i
       WHERE i.batch_id = $1 AND i.is_effective AND i.conclusion = 'qualified'`,
      [batchId],
    )
    return (r.rows as Array<{ detail_no: string }>).map((row) => row.detail_no)
  }
}

// ---------------- 主数据只读（0003 表） ----------------

export class PgReverseWarehouseLookup implements ReverseWarehouseLookup {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<{
    id: string
    code: string
    warehouseType: string
    status: string
    deptId: string | null
    plantId: string
    enterpriseId: string
  } | null> {
    const r = await this.client.query(
      `SELECT id, code, warehouse_type, status, dept_id, plant_id, enterprise_id
       FROM warehouse WHERE id = $1 AND status <> 'retired'`,
      [id],
    )
    if (r.rowCount === 0) return null
    const row = r.rows[0] as {
      id: string
      code: string
      warehouse_type: string
      status: string
      dept_id: string | null
      plant_id: string
      enterprise_id: string
    }
    return {
      id: row.id,
      code: row.code,
      warehouseType: row.warehouse_type,
      status: row.status,
      deptId: row.dept_id,
      plantId: row.plant_id,
      enterpriseId: row.enterprise_id,
    }
  }

  /** WR-03：登录人部门下、已启用、仓库类型（不含线边仓）。 */
  async listMoveTargetWarehouses(
    deptId: string | null,
    plantId: string,
  ): Promise<Array<{ id: string; code: string; name: string; warehouseType: string }>> {
    // deptId=null：登录人无部门（WR-03"登录人部门下"无命中 → 空范围，不下沉为全厂）
    const r = await this.client.query(
      `SELECT id, code, name, warehouse_type FROM warehouse
       WHERE plant_id = $1 AND dept_id = $2 AND status = 'active' AND warehouse_type <> 'LINE_SIDE'
       ORDER BY code`,
      [plantId, deptId],
    )
    return (r.rows as Array<{ id: string; code: string; name: string; warehouse_type: string }>).map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      warehouseType: row.warehouse_type,
    }))
  }

  async hasRackLocations(warehouseId: string): Promise<boolean> {
    const r = await this.client.query(
      `SELECT count(*)::int AS total FROM storage_location
       WHERE warehouse_id = $1 AND location_kind = 'RACK' AND status <> 'retired'`,
      [warehouseId],
    )
    return (r.rows[0] as { total: number }).total > 0
  }
}

export class PgReverseLocationLookup implements ReverseLocationLookup {
  constructor(private readonly client: SqlClient) {}

  private readonly columns = `id, warehouse_id, code, location_kind, status, plant_id`

  private map(r: {
    id: string
    warehouse_id: string
    code: string
    location_kind: 'NORMAL' | 'RACK'
    status: string
    plant_id: string
  }) {
    return {
      id: r.id,
      warehouseId: r.warehouse_id,
      code: r.code,
      locationKind: r.location_kind,
      status: r.status,
      plantId: r.plant_id,
    }
  }

  async findById(id: string) {
    const r = await this.client.query(`SELECT ${this.columns} FROM storage_location WHERE id = $1 AND status <> 'retired'`, [id])
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgReverseLocationLookup['map']>[0])
  }

  async findByCode(plantId: string, code: string) {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM storage_location WHERE plant_id = $1 AND code = $2 AND status <> 'retired' LIMIT 1`,
      [plantId, code],
    )
    return r.rowCount === 0 ? null : this.map(r.rows[0] as Parameters<PgReverseLocationLookup['map']>[0])
  }

  async listActiveByWarehouse(warehouseId: string) {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM storage_location WHERE warehouse_id = $1 AND status <> 'retired' ORDER BY code`,
      [warehouseId],
    )
    return (r.rows as Parameters<PgReverseLocationLookup['map']>[0][]).map((row) => this.map(row))
  }
}

export class PgReverseMaterialLookup implements ReverseMaterialLookup {
  constructor(private readonly client: SqlClient) {}

  async findTypeById(materialId: string): Promise<number | null> {
    const r = await this.client.query(`SELECT material_type FROM material WHERE id = $1 AND status = 'active'`, [materialId])
    if (r.rowCount === 0) return null
    return (r.rows[0] as { material_type: number | null }).material_type
  }

  async findById(id: string): Promise<{ id: string; code: string; materialType: number | null } | null> {
    const r = await this.client.query(`SELECT id, code, material_type FROM material WHERE id = $1 AND status = 'active'`, [id])
    if (r.rowCount === 0) return null
    const row = r.rows[0] as { id: string; code: string; material_type: number | null }
    return { id: row.id, code: row.code, materialType: row.material_type }
  }
}

/** reverse 域仓储束（绑定命令事务客户端或查询池）。 */
export function createPgReverseRepositories(client: SqlClient): ReverseRepositories {
  return {
    moveRecords: new PgStockMoveRecordRepository(client),
    outOrders: new PgTransferOutboundOrderRepository(client),
    outPlanLines: new PgTransferOutboundPlanLineRepository(client),
    outScans: new PgTransferOutboundScanRepository(client),
    inOrders: new PgTransferInboundOrderRepository(client),
    inLines: new PgTransferInboundLineRepository(client),
    stocktakes: new PgStocktakeOrderRepository(client),
    countLines: new PgStocktakeCountLineRepository(client),
    adjustments: new PgStockAdjustmentRepository(client),
    carrierLoans: new PgCarrierLoanRepository(client),
    corrections: new PgReceiptCorrectionRepository(client),
    pur: new PgPurchaseBatchLookup(client),
    carrierFacts: new PgCarrierFactsLookup(client),
    warehouses: new PgReverseWarehouseLookup(client),
    locations: new PgReverseLocationLookup(client),
    materials: new PgReverseMaterialLookup(client),
  }
}
