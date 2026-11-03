// L0 整合步（Wave5）：application index 已导出 warehousing 面；type-only 跨包导入改包名
// （原 dist 相对导入删除；同 purchase 先例）。
import type {
  NewPutawayTask,
  NewTransferLine,
  NewTransferOrder,
  NewWarehouseMove,
  PutawayTaskRecord,
  PutawayTaskRepository,
  StorageLocationLookup,
  TransferLineRecord,
  TransferLineRepository,
  TransferOrderRecord,
  TransferOrderRepository,
  TransferStatusValue,
  WarehouseLookup,
  WarehouseMoveRecord,
  WarehouseMoveRepository,
  WarehousingMaterialLookup,
  WarehousingRepositories,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

/**
 * warehousing 域仓储的 PostgreSQL 实现（implements application 端口；0009 warehousing 表
 * 列一一对应）。行锁方法（lockById）在命令事务内 SELECT ... FOR UPDATE；
 * warehouse_move 为 append-only（触发器守卫，无 UPDATE/DELETE 方法）。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

// ---------------- putaway_task ----------------

const TASK_COLUMNS = `id, source_type, source_ref, unit_no, pallet_code, material_id, material_code,
  quantity::text AS quantity, uom_id, uom_code, target_warehouse_id, status, inventory_unit_id,
  location_id, location_code, putaway_by, putaway_at, plant_id, enterprise_id, created_at, updated_at`

interface TaskRow {
  id: string
  source_type: PutawayTaskRecord['sourceType']
  source_ref: string
  unit_no: string | null
  pallet_code: string | null
  material_id: string
  material_code: string
  quantity: string
  uom_id: string
  uom_code: string
  target_warehouse_id: string | null
  status: PutawayTaskRecord['status']
  inventory_unit_id: string | null
  location_id: string | null
  location_code: string | null
  putaway_by: string | null
  putaway_at: Date | string | null
  plant_id: string
  enterprise_id: string
  created_at: Date | string
  updated_at: Date | string
}

function mapTask(r: TaskRow): PutawayTaskRecord {
  return {
    id: r.id,
    sourceType: r.source_type,
    sourceRef: r.source_ref,
    unitNo: r.unit_no,
    palletCode: r.pallet_code,
    materialId: r.material_id,
    materialCode: r.material_code,
    quantity: r.quantity,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    targetWarehouseId: r.target_warehouse_id,
    status: r.status,
    inventoryUnitId: r.inventory_unit_id,
    locationId: r.location_id,
    locationCode: r.location_code,
    putawayBy: r.putaway_by,
    putawayAt: r.putaway_at === null ? null : iso(r.putaway_at),
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

export class PgPutawayTaskRepository implements PutawayTaskRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(task: NewPutawayTask): Promise<PutawayTaskRecord> {
    const r = await this.client.query(
      `INSERT INTO putaway_task
         (source_type, source_ref, unit_no, pallet_code, material_id, material_code, quantity,
          uom_id, uom_code, target_warehouse_id, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${TASK_COLUMNS}`,
      [
        task.sourceType,
        task.sourceRef,
        task.unitNo ?? null,
        task.palletCode ?? null,
        task.materialId,
        task.materialCode,
        task.quantity,
        task.uomId,
        task.uomCode,
        task.targetWarehouseId ?? null,
        task.plantId,
        task.enterpriseId,
        task.createdBy ?? null,
      ],
    )
    return mapTask(r.rows[0] as TaskRow)
  }

  async findById(id: string): Promise<PutawayTaskRecord | null> {
    const r = await this.client.query(`SELECT ${TASK_COLUMNS} FROM putaway_task WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapTask(r.rows[0] as TaskRow)
  }

  async findBySource(
    sourceType: PutawayTaskRecord['sourceType'],
    sourceRef: string,
  ): Promise<PutawayTaskRecord | null> {
    const r = await this.client.query(
      `SELECT ${TASK_COLUMNS} FROM putaway_task WHERE source_type = $1 AND source_ref = $2`,
      [sourceType, sourceRef],
    )
    return r.rows[0] === undefined ? null : mapTask(r.rows[0] as TaskRow)
  }

  async findByIds(ids: readonly string[]): Promise<PutawayTaskRecord[]> {
    if (ids.length === 0) return []
    const r = await this.client.query(
      `SELECT ${TASK_COLUMNS} FROM putaway_task WHERE id = ANY($1::uuid[])`,
      [[...ids]],
    )
    return r.rows.map((row) => mapTask(row as TaskRow))
  }

  async listPendingByUnitNos(plantId: string, unitNos: readonly string[]): Promise<PutawayTaskRecord[]> {
    if (unitNos.length === 0) return []
    const r = await this.client.query(
      `SELECT ${TASK_COLUMNS} FROM putaway_task
       WHERE plant_id = $1::uuid AND status = 'pending' AND unit_no = ANY($2::text[])`,
      [plantId, [...unitNos]],
    )
    return r.rows.map((row) => mapTask(row as TaskRow))
  }

  async listPendingByPallet(palletCode: string): Promise<PutawayTaskRecord[]> {
    const r = await this.client.query(
      `SELECT ${TASK_COLUMNS} FROM putaway_task WHERE pallet_code = $1 AND status = 'pending' ORDER BY id`,
      [palletCode],
    )
    return r.rows.map((row) => mapTask(row as TaskRow))
  }

  async listPendingByPlant(plantId: string): Promise<PutawayTaskRecord[]> {
    const r = await this.client.query(
      `SELECT ${TASK_COLUMNS} FROM putaway_task WHERE plant_id = $1::uuid AND status = 'pending' ORDER BY id`,
      [plantId],
    )
    return r.rows.map((row) => mapTask(row as TaskRow))
  }

  async markDone(
    id: string,
    patch: { inventoryUnitId: string; locationId: string; locationCode: string; putawayBy: string; putawayAt: string },
    actor: string | null,
  ): Promise<PutawayTaskRecord | null> {
    const r = await this.client.query(
      `UPDATE putaway_task SET status = 'done', inventory_unit_id = $2, location_id = $3,
         location_code = $4, putaway_by = $5, putaway_at = $6, updated_at = now(), updated_by = $7
       WHERE id = $1 AND status = 'pending' RETURNING ${TASK_COLUMNS}`,
      [id, patch.inventoryUnitId, patch.locationId, patch.locationCode, patch.putawayBy, patch.putawayAt, actor],
    )
    return r.rows[0] === undefined ? null : mapTask(r.rows[0] as TaskRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    sourceTypes?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: PutawayTaskRecord[]; total: number }> {
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
    if (filter.sourceTypes !== undefined && filter.sourceTypes.length > 0) {
      params.push(filter.sourceTypes)
      conds.push(`source_type = ANY($${params.length}::text[])`)
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const limitIdx = params.length - 1
    const offsetIdx = params.length
    const r = await this.client.query(
      `SELECT ${TASK_COLUMNS} FROM putaway_task ${where}
       ORDER BY created_at DESC, id LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    )
    const count = await this.client.query(
      `SELECT count(*)::text AS total FROM putaway_task ${where}`,
      params.slice(0, limitIdx - 1),
    )
    return { items: r.rows.map((row) => mapTask(row as TaskRow)), total: Number(count.rows[0]!.total) }
  }
}

// ---------------- warehouse_move（append-only：仅 insert/查询） ----------------

const MOVE_COLUMNS = `id, inventory_unit_id, unit_no, from_location_id, from_location_code, to_location_id,
  to_location_code, quantity::text AS quantity, uom_id, uom_code, moved_by, moved_at, reason,
  command_receipt_id, plant_id, enterprise_id, business_time, created_at`

interface MoveRow {
  id: string
  inventory_unit_id: string
  unit_no: string
  from_location_id: string | null
  from_location_code: string | null
  to_location_id: string | null
  to_location_code: string | null
  quantity: string
  uom_id: string
  uom_code: string
  moved_by: string
  moved_at: Date | string
  reason: string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
}

function mapMove(r: MoveRow): WarehouseMoveRecord {
  return {
    id: r.id,
    inventoryUnitId: r.inventory_unit_id,
    unitNo: r.unit_no,
    fromLocationId: r.from_location_id,
    fromLocationCode: r.from_location_code,
    toLocationId: r.to_location_id,
    toLocationCode: r.to_location_code,
    quantity: r.quantity,
    uomId: r.uom_id,
    uomCode: r.uom_code,
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

export class PgWarehouseMoveRepository implements WarehouseMoveRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(move: NewWarehouseMove): Promise<WarehouseMoveRecord> {
    const r = await this.client.query(
      `INSERT INTO warehouse_move
         (inventory_unit_id, unit_no, from_location_id, from_location_code, to_location_id,
          to_location_code, quantity, uom_id, uom_code, moved_by, moved_at, reason,
          command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${MOVE_COLUMNS}`,
      [
        move.inventoryUnitId,
        move.unitNo,
        move.fromLocationId ?? null,
        move.fromLocationCode ?? null,
        move.toLocationId ?? null,
        move.toLocationCode ?? null,
        move.quantity,
        move.uomId,
        move.uomCode,
        move.movedBy,
        move.movedAt,
        move.reason ?? null,
        move.commandReceiptId ?? null,
        move.plantId,
        move.enterpriseId,
        move.businessTime,
        move.createdBy ?? null,
      ],
    )
    return mapMove(r.rows[0] as MoveRow)
  }

  async listByUnit(inventoryUnitId: string): Promise<WarehouseMoveRecord[]> {
    const r = await this.client.query(
      `SELECT ${MOVE_COLUMNS} FROM warehouse_move WHERE inventory_unit_id = $1 ORDER BY moved_at, id`,
      [inventoryUnitId],
    )
    return r.rows.map((row) => mapMove(row as MoveRow))
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    unitNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: WarehouseMoveRecord[]; total: number }> {
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
    if (filter.unitNoLike !== undefined) {
      params.push(`%${filter.unitNoLike}%`)
      conds.push(`unit_no LIKE $${params.length}`)
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const limitIdx = params.length - 1
    const offsetIdx = params.length
    const r = await this.client.query(
      `SELECT ${MOVE_COLUMNS} FROM warehouse_move ${where}
       ORDER BY moved_at DESC, id LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    )
    const count = await this.client.query(
      `SELECT count(*)::text AS total FROM warehouse_move ${where}`,
      params.slice(0, limitIdx - 1),
    )
    return { items: r.rows.map((row) => mapMove(row as MoveRow)), total: Number(count.rows[0]!.total) }
  }
}

// ---------------- transfer_order ----------------

const ORDER_T_COLUMNS = `id, order_no, transfer_kind, from_warehouse_id, to_warehouse_id, from_warehouse_code,
  to_warehouse_code, from_warehouse_type, to_warehouse_type, status, transit_location_id,
  transit_location_code, locked_valid_until, note, submitted_by, submitted_at, shipped_by,
  shipped_at, completed_by, completed_at, plant_id, enterprise_id, business_time, created_at, updated_at`

interface TransferOrderRow {
  id: string
  order_no: string
  transfer_kind: TransferOrderRecord['transferKind']
  from_warehouse_id: string
  to_warehouse_id: string
  from_warehouse_code: string | null
  to_warehouse_code: string | null
  from_warehouse_type: string | null
  to_warehouse_type: string | null
  status: TransferStatusValue
  transit_location_id: string | null
  transit_location_code: string | null
  locked_valid_until: Date | string | null
  note: string | null
  submitted_by: string | null
  submitted_at: Date | string | null
  shipped_by: string | null
  shipped_at: Date | string | null
  completed_by: string | null
  completed_at: Date | string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  updated_at: Date | string
}

function mapTransferOrder(r: TransferOrderRow): TransferOrderRecord {
  return {
    id: r.id,
    orderNo: r.order_no,
    transferKind: r.transfer_kind,
    fromWarehouseId: r.from_warehouse_id,
    toWarehouseId: r.to_warehouse_id,
    fromWarehouseCode: r.from_warehouse_code,
    toWarehouseCode: r.to_warehouse_code,
    fromWarehouseType: r.from_warehouse_type,
    toWarehouseType: r.to_warehouse_type,
    status: r.status,
    transitLocationId: r.transit_location_id,
    transitLocationCode: r.transit_location_code,
    lockedValidUntil: isoOrNull(r.locked_valid_until),
    note: r.note,
    submittedBy: r.submitted_by,
    submittedAt: isoOrNull(r.submitted_at),
    shippedBy: r.shipped_by,
    shippedAt: isoOrNull(r.shipped_at),
    completedBy: r.completed_by,
    completedAt: isoOrNull(r.completed_at),
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

export class PgTransferOrderRepository implements TransferOrderRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(order: NewTransferOrder): Promise<TransferOrderRecord> {
    const r = await this.client.query(
      `INSERT INTO transfer_order
         (order_no, transfer_kind, from_warehouse_id, to_warehouse_id, from_warehouse_code,
          to_warehouse_code, from_warehouse_type, to_warehouse_type, transit_location_id,
          transit_location_code, note, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${ORDER_T_COLUMNS}`,
      [
        order.orderNo,
        order.transferKind,
        order.fromWarehouseId,
        order.toWarehouseId,
        order.fromWarehouseCode ?? null,
        order.toWarehouseCode ?? null,
        order.fromWarehouseType ?? null,
        order.toWarehouseType ?? null,
        order.transitLocationId,
        order.transitLocationCode,
        order.note ?? null,
        order.plantId,
        order.enterpriseId,
        order.createdBy ?? null,
      ],
    )
    return mapTransferOrder(r.rows[0] as TransferOrderRow)
  }

  async findById(id: string): Promise<TransferOrderRecord | null> {
    const r = await this.client.query(`SELECT ${ORDER_T_COLUMNS} FROM transfer_order WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapTransferOrder(r.rows[0] as TransferOrderRow)
  }

  async lockById(id: string): Promise<TransferOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${ORDER_T_COLUMNS} FROM transfer_order WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapTransferOrder(r.rows[0] as TransferOrderRow)
  }

  async updateStatus(
    id: string,
    patch: {
      status: TransferStatusValue
      lockedValidUntil?: string | null
      submittedBy?: string | null
      submittedAt?: string | null
      shippedBy?: string | null
      shippedAt?: string | null
      completedBy?: string | null
      completedAt?: string | null
    },
    actor: string | null,
  ): Promise<TransferOrderRecord | null> {
    const r = await this.client.query(
      `UPDATE transfer_order SET
         status = $2,
         locked_valid_until = COALESCE($3, locked_valid_until),
         submitted_by = COALESCE($4, submitted_by),
         submitted_at = COALESCE($5, submitted_at),
         shipped_by = COALESCE($6, shipped_by),
         shipped_at = COALESCE($7, shipped_at),
         completed_by = COALESCE($8, completed_by),
         completed_at = COALESCE($9, completed_at),
         updated_at = now(), updated_by = $10
       WHERE id = $1 RETURNING ${ORDER_T_COLUMNS}`,
      [
        id,
        patch.status,
        patch.lockedValidUntil ?? null,
        patch.submittedBy ?? null,
        patch.submittedAt ?? null,
        patch.shippedBy ?? null,
        patch.shippedAt ?? null,
        patch.completedBy ?? null,
        patch.completedAt ?? null,
        actor,
      ],
    )
    return r.rows[0] === undefined ? null : mapTransferOrder(r.rows[0] as TransferOrderRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    orderNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: TransferOrderRecord[]; total: number }> {
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
    if (filter.orderNoLike !== undefined) {
      params.push(`%${filter.orderNoLike}%`)
      conds.push(`order_no LIKE $${params.length}`)
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const limitIdx = params.length - 1
    const offsetIdx = params.length
    const r = await this.client.query(
      `SELECT ${ORDER_T_COLUMNS} FROM transfer_order ${where}
       ORDER BY created_at DESC, id LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    )
    const count = await this.client.query(
      `SELECT count(*)::text AS total FROM transfer_order ${where}`,
      params.slice(0, limitIdx - 1),
    )
    return {
      items: r.rows.map((row) => mapTransferOrder(row as TransferOrderRow)),
      total: Number(count.rows[0]!.total),
    }
  }
}

// ---------------- transfer_order_line ----------------

const LINE_T_COLUMNS = `id, transfer_order_id, line_no, inventory_unit_id, unit_no, material_id,
  material_code, material_type, quantity::text AS quantity, out_qty::text AS out_qty,
  in_qty::text AS in_qty, reservation_id, out_done, out_at, in_done, in_at, created_at, updated_at`

interface TransferLineRow {
  id: string
  transfer_order_id: string
  line_no: number
  inventory_unit_id: string
  unit_no: string
  material_id: string | null
  material_code: string | null
  material_type: number | null
  quantity: string
  out_qty: string
  in_qty: string
  reservation_id: string | null
  out_done: boolean
  out_at: Date | string | null
  in_done: boolean
  in_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

function mapTransferLine(r: TransferLineRow): TransferLineRecord {
  return {
    id: r.id,
    transferOrderId: r.transfer_order_id,
    lineNo: r.line_no,
    inventoryUnitId: r.inventory_unit_id,
    unitNo: r.unit_no,
    materialId: r.material_id,
    materialCode: r.material_code,
    materialType: r.material_type,
    quantity: r.quantity,
    outQty: r.out_qty,
    inQty: r.in_qty,
    reservationId: r.reservation_id,
    outDone: r.out_done,
    outAt: isoOrNull(r.out_at),
    inDone: r.in_done,
    inAt: isoOrNull(r.in_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

export class PgTransferLineRepository implements TransferLineRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(line: NewTransferLine): Promise<TransferLineRecord> {
    const r = await this.client.query(
      `INSERT INTO transfer_order_line
         (transfer_order_id, line_no, inventory_unit_id, unit_no, material_id, material_code,
          material_type, quantity, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${LINE_T_COLUMNS}`,
      [
        line.transferOrderId,
        line.lineNo,
        line.inventoryUnitId,
        line.unitNo,
        line.materialId ?? null,
        line.materialCode ?? null,
        line.materialType ?? null,
        line.quantity,
        line.createdBy ?? null,
      ],
    )
    return mapTransferLine(r.rows[0] as TransferLineRow)
  }

  async findById(id: string): Promise<TransferLineRecord | null> {
    const r = await this.client.query(`SELECT ${LINE_T_COLUMNS} FROM transfer_order_line WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapTransferLine(r.rows[0] as TransferLineRow)
  }

  async lockById(id: string): Promise<TransferLineRecord | null> {
    const r = await this.client.query(
      `SELECT ${LINE_T_COLUMNS} FROM transfer_order_line WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapTransferLine(r.rows[0] as TransferLineRow)
  }

  async listByOrder(transferOrderId: string): Promise<TransferLineRecord[]> {
    const r = await this.client.query(
      `SELECT ${LINE_T_COLUMNS} FROM transfer_order_line WHERE transfer_order_id = $1 ORDER BY line_no`,
      [transferOrderId],
    )
    return r.rows.map((row) => mapTransferLine(row as TransferLineRow))
  }

  async markOut(
    id: string,
    patch: { outQty: string; outDone: boolean; outAt: string; reservationId?: string | null },
    actor: string | null,
  ): Promise<TransferLineRecord | null> {
    const r = await this.client.query(
      `UPDATE transfer_order_line SET out_qty = $2, out_done = $3, out_at = $4,
         updated_at = now(), updated_by = $5
       WHERE id = $1 RETURNING ${LINE_T_COLUMNS}`,
      [id, patch.outQty, patch.outDone, patch.outAt, actor],
    )
    return r.rows[0] === undefined ? null : mapTransferLine(r.rows[0] as TransferLineRow)
  }

  async markIn(
    id: string,
    patch: { inQty: string; inDone: boolean; inAt: string },
    actor: string | null,
  ): Promise<TransferLineRecord | null> {
    const r = await this.client.query(
      `UPDATE transfer_order_line SET in_qty = $2, in_done = $3, in_at = $4,
         updated_at = now(), updated_by = $5
       WHERE id = $1 RETURNING ${LINE_T_COLUMNS}`,
      [id, patch.inQty, patch.inDone, patch.inAt, actor],
    )
    return r.rows[0] === undefined ? null : mapTransferLine(r.rows[0] as TransferLineRow)
  }

  async setReservation(id: string, reservationId: string, actor: string | null): Promise<TransferLineRecord | null> {
    const r = await this.client.query(
      `UPDATE transfer_order_line SET reservation_id = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${LINE_T_COLUMNS}`,
      [id, reservationId, actor],
    )
    return r.rows[0] === undefined ? null : mapTransferLine(r.rows[0] as TransferLineRow)
  }
}

// ---------------- 主数据只读查询（0003 表） ----------------

export class PgStorageLocationLookup implements StorageLocationLookup {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string) {
    const r = await this.client.query(
      `SELECT id, warehouse_id, code, location_kind, status, plant_id FROM storage_location WHERE id = $1`,
      [id],
    )
    const row = r.rows[0] as
      | { id: string; warehouse_id: string; code: string; location_kind: 'NORMAL' | 'RACK'; status: string; plant_id: string }
      | undefined
    if (row === undefined) return null
    return {
      id: row.id,
      warehouseId: row.warehouse_id,
      code: row.code,
      locationKind: row.location_kind,
      status: row.status,
      plantId: row.plant_id,
    }
  }

  async listWarehouseLocationIds(warehouseIds: readonly string[]): Promise<string[]> {
    if (warehouseIds.length === 0) return []
    const r = await this.client.query(
      `SELECT id FROM storage_location WHERE warehouse_id = ANY($1::uuid[]) AND status = 'active'`,
      [[...warehouseIds]],
    )
    return r.rows.map((row) => (row as { id: string }).id)
  }
}

export class PgWarehouseLookup implements WarehouseLookup {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string) {
    const r = await this.client.query(`SELECT id, code, warehouse_type, status, plant_id FROM warehouse WHERE id = $1`, [id])
    const row = r.rows[0] as { id: string; code: string; warehouse_type: string; status: string; plant_id: string } | undefined
    if (row === undefined) return null
    return {
      id: row.id,
      code: row.code,
      warehouseType: row.warehouse_type,
      status: row.status,
      plantId: row.plant_id,
    }
  }
}

export class PgWarehousingMaterialLookup implements WarehousingMaterialLookup {
  constructor(private readonly client: SqlClient) {}

  async findTypeById(materialId: string): Promise<number | null> {
    const r = await this.client.query(`SELECT material_type FROM material WHERE id = $1`, [materialId])
    return (r.rows[0] as { material_type: number | null } | undefined)?.material_type ?? null
  }
}

/** warehousing 仓储束（命令事务客户端绑定）。 */
export function createPgWarehousingRepositories(client: SqlClient): WarehousingRepositories {
  return {
    putawayTasks: new PgPutawayTaskRepository(client),
    moves: new PgWarehouseMoveRepository(client),
    transferOrders: new PgTransferOrderRepository(client),
    transferLines: new PgTransferLineRepository(client),
    locations: new PgStorageLocationLookup(client),
    warehouses: new PgWarehouseLookup(client),
    materials: new PgWarehousingMaterialLookup(client),
  }
}
