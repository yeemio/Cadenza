// [L0-整合标记] application index（共享文件）未导出 rework 面：type-only 跨包导入暂以
// dist 相对桥接；L0 整合步在 packages/application/src/index.ts 追加导出 rework-repositories
// 后改包名导入（与 reverse-repositories 同一整合口径）。
import type {
  AxisCodeRetireRecord,
  AxisNoCorrectionRecord,
  AxisNoRepository,
  AxisNoStateRecord,
  AxisRetireCandidateRow,
  AxisRetireRecordEntry,
  AxisRetireRepository,
  CorrectionScanRow,
  CorrectionWithdrawDownstreamRow,
  PalletExportQueryRow,
  PalletScanRow,
  PalletTaskLineRecord,
  PalletTaskRecord,
  PalletTaskRepository,
  ReelSplitLineRecord,
  ReelSplitOrderRecord,
  ReelSplitRepository,
  ReelSplitReversalDownstreamRow,
  ReelSplitReversalRecord,
  ReelSplitSourceRow,
  ReelSplitTargetRow,
  ReworkFactsLookup,
  ReworkOperatorOrgFacts,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

/**
 * rework 域仓储的 PostgreSQL 实现（implements application 端口；0011 rework-split 表
 * 列一一对应 + P1 跨域只读事实装配）。
 *
 * - reel_split_order(_line)/reel_split_reversal/axis_retire_record/axis_code_retire：
 *   append-only（0011 触发器守卫，无 UPDATE/DELETE 方法；reversed 状态由冲销事实行
 *   JOIN 派生投影——RS-S1）；
 * - pallet_task(_line)：进行中单据可 UPDATE（RS-S3 状态流转；(操作人, 类型) 进行中唯一
 *   partial unique 库级双保险）；明细 markRemoved 仅写 removed_at（RS-17 删码语义）；
 * - axis_no_correction：UPDATE 仅状态切换（0011 触发器限定列，RS-S5）；
 * - 事实装配（PgReworkFactsLookup）：跨域只读查询 0002/0003/0004/0005/0008/0009/0010 表；
 *   引用并行线迁移表（0012 conversion_order_scan / 0013 stocktake_order）的装配以
 *   to_regclass 运行时守卫——本线测试库只应用 0001–0010+0011，L0 整合后自动启用。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** 并行线表存在性检查（0012/0013 未应用于本线测试库时装配降级为 false）。 */
async function tableExistsStatic(client: SqlClient, name: string): Promise<boolean> {
  const r = await typedQuery<{ t: string | null }>(client, `SELECT to_regclass($1) AS t`, [name])
  return r.rows[0]?.t != null
}

/** 带行类型的查询辅助（SqlClient.query 非泛型，同 inventory-repositories 行断言模式）。 */
async function typedQuery<T>(
  client: SqlClient,
  text: string,
  values?: readonly unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const r = await client.query(text, values)
  return { rows: r.rows as T[], rowCount: r.rowCount }
}

function dateOnly(now: Date): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

// ---------------- reel_split_order / line / reversal ----------------

const REEL_SPLIT_ORDER_COLUMNS = `o.id, o.order_no, o.source_unit_id, o.source_unit_no,
  o.original_qty::text AS original_qty, o.retained_qty::text AS retained_qty,
  o.loss_qty::text AS loss_qty, o.loss_reason, o.material_id, o.material_code, o.lot_id,
  o.order_ref, o.split_by, o.split_at, o.status, o.uom_id, o.uom_code, o.measurement_basis,
  o.conversion_revision_id, o.command_receipt_id, o.plant_id, o.enterprise_id, o.business_time,
  o.created_at, o.created_by,
  CASE WHEN rv.id IS NULL THEN o.status ELSE 'reversed' END AS effective_status`

const REEL_SPLIT_ORDER_JOIN = `FROM reel_split_order o
  LEFT JOIN reel_split_reversal rv ON rv.source_order_id = o.id`

interface ReelSplitOrderRow {
  id: string
  order_no: string
  source_unit_id: string
  source_unit_no: string
  original_qty: string
  retained_qty: string
  loss_qty: string
  loss_reason: string | null
  material_id: string
  material_code: string
  lot_id: string
  order_ref: string | null
  split_by: string
  split_at: Date | string
  status: string
  effective_status: string
  uom_id: string
  uom_code: string
  measurement_basis: string
  conversion_revision_id: string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapReelSplitOrder(r: ReelSplitOrderRow): ReelSplitOrderRecord {
  return {
    id: r.id,
    orderNo: r.order_no,
    sourceUnitId: r.source_unit_id,
    sourceUnitNo: r.source_unit_no,
    originalQty: r.original_qty,
    retainedQty: r.retained_qty,
    lossQty: r.loss_qty,
    lossReason: r.loss_reason,
    materialId: r.material_id,
    materialCode: r.material_code,
    lotId: r.lot_id,
    orderRef: r.order_ref,
    splitBy: r.split_by,
    splitAt: iso(r.split_at),
    status: r.effective_status === 'reversed' ? 'reversed' : 'executed',
    uomId: r.uom_id,
    uomCode: r.uom_code,
    measurementBasis: r.measurement_basis,
    conversionRevisionId: r.conversion_revision_id,
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgReelSplitRepository implements ReelSplitRepository {
  constructor(private readonly client: SqlClient) {}

  async insertOrder(order: Omit<ReelSplitOrderRecord, 'id' | 'createdAt' | 'status'>): Promise<ReelSplitOrderRecord> {
    const r = await typedQuery<ReelSplitOrderRow>(this.client, `INSERT INTO reel_split_order (order_no, source_unit_id, source_unit_no, original_qty, retained_qty,
         loss_qty, loss_reason, material_id, material_code, lot_id, order_ref, split_by, split_at,
         uom_id, uom_code, measurement_basis, conversion_revision_id, command_receipt_id,
         plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING id, order_no, source_unit_id, source_unit_no, original_qty::text AS original_qty,
         retained_qty::text AS retained_qty, loss_qty::text AS loss_qty, loss_reason, material_id,
         material_code, lot_id, order_ref, split_by, split_at, status, status AS effective_status,
         uom_id, uom_code, measurement_basis, conversion_revision_id, command_receipt_id,
         plant_id, enterprise_id, business_time, created_at, created_by`,
      [
        order.orderNo,
        order.sourceUnitId,
        order.sourceUnitNo,
        order.originalQty,
        order.retainedQty,
        order.lossQty,
        order.lossReason,
        order.materialId,
        order.materialCode,
        order.lotId,
        order.orderRef,
        order.splitBy,
        order.splitAt,
        order.uomId,
        order.uomCode,
        order.measurementBasis,
        order.conversionRevisionId,
        order.commandReceiptId,
        order.plantId,
        order.enterpriseId,
        order.businessTime,
        order.createdBy,
      ],
    )
    return mapReelSplitOrder(r.rows[0]!)
  }

  async insertLines(
    orderId: string,
    lines: Array<Omit<ReelSplitLineRecord, 'id' | 'orderId' | 'createdAt'>>,
  ): Promise<ReelSplitLineRecord[]> {
    const inserted: ReelSplitLineRecord[] = []
    for (const line of lines) {
      const r = await typedQuery<{
        id: string
        order_id: string
        line_no: number
        target_unit_id: string
        target_unit_no: string
        quantity: string
        created_new_unit: boolean
        created_at: Date | string
      }>(this.client, `INSERT INTO reel_split_line (order_id, line_no, target_unit_id, target_unit_no, quantity, created_new_unit)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, order_id, line_no, target_unit_id, target_unit_no, quantity::text AS quantity,
           created_new_unit, created_at`,
        [orderId, line.lineNo, line.targetUnitId, line.targetUnitNo, line.quantity, line.createdNewUnit],
      )
      const row = r.rows[0]!
      inserted.push({
        id: row.id,
        orderId: row.order_id,
        lineNo: row.line_no,
        targetUnitId: row.target_unit_id,
        targetUnitNo: row.target_unit_no,
        quantity: row.quantity,
        createdNewUnit: row.created_new_unit,
        createdAt: iso(row.created_at),
      })
    }
    return inserted
  }

  async findById(id: string): Promise<ReelSplitOrderRecord | null> {
    const r = await typedQuery<ReelSplitOrderRow>(this.client, `SELECT ${REEL_SPLIT_ORDER_COLUMNS} ${REEL_SPLIT_ORDER_JOIN} WHERE o.id = $1`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapReelSplitOrder(r.rows[0])
  }

  async findByNo(orderNo: string): Promise<ReelSplitOrderRecord | null> {
    const r = await typedQuery<ReelSplitOrderRow>(this.client, `SELECT ${REEL_SPLIT_ORDER_COLUMNS} ${REEL_SPLIT_ORDER_JOIN} WHERE o.order_no = $1`,
      [orderNo],
    )
    return r.rows[0] === undefined ? null : mapReelSplitOrder(r.rows[0])
  }

  async listLines(orderId: string): Promise<ReelSplitLineRecord[]> {
    const r = await typedQuery<{
      id: string
      order_id: string
      line_no: number
      target_unit_id: string
      target_unit_no: string
      quantity: string
      created_new_unit: boolean
      created_at: Date | string
    }>(this.client, `SELECT id, order_id, line_no, target_unit_id, target_unit_no, quantity::text AS quantity,
         created_new_unit, created_at
       FROM reel_split_line WHERE order_id = $1 ORDER BY line_no`,
      [orderId],
    )
    return r.rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      lineNo: row.line_no,
      targetUnitId: row.target_unit_id,
      targetUnitNo: row.target_unit_no,
      quantity: row.quantity,
      createdNewUnit: row.created_new_unit,
      createdAt: iso(row.created_at),
    }))
  }

  async insertReversal(reversal: Omit<ReelSplitReversalRecord, 'id' | 'createdAt'>): Promise<ReelSplitReversalRecord> {
    const r = await typedQuery<{
      id: string
      reversal_no: string
      source_order_id: string
      source_order_no: string
      reason: string
      reversed_by: string
      reversed_at: Date | string
      command_receipt_id: string | null
      plant_id: string
      enterprise_id: string
      created_at: Date | string
    }>(this.client, `INSERT INTO reel_split_reversal (reversal_no, source_order_id, source_order_no, reason,
         reversed_by, reversed_at, command_receipt_id, plant_id, enterprise_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, reversal_no, source_order_id, source_order_no, reason, reversed_by, reversed_at,
         command_receipt_id, plant_id, enterprise_id, created_at`,
      [
        reversal.reversalNo,
        reversal.sourceOrderId,
        reversal.sourceOrderNo,
        reversal.reason,
        reversal.reversedBy,
        reversal.reversedAt,
        reversal.commandReceiptId,
        reversal.plantId,
        reversal.enterpriseId,
      ],
    )
    const row = r.rows[0]!
    return {
      id: row.id,
      reversalNo: row.reversal_no,
      sourceOrderId: row.source_order_id,
      sourceOrderNo: row.source_order_no,
      reason: row.reason,
      reversedBy: row.reversed_by,
      reversedAt: iso(row.reversed_at),
      commandReceiptId: row.command_receipt_id,
      plantId: row.plant_id,
      enterpriseId: row.enterprise_id,
      createdAt: iso(row.created_at),
    }
  }

  async findReversalBySourceOrder(orderId: string): Promise<ReelSplitReversalRecord | null> {
    const r = await typedQuery<{
      id: string
      reversal_no: string
      source_order_id: string
      source_order_no: string
      reason: string
      reversed_by: string
      reversed_at: Date | string
      command_receipt_id: string | null
      plant_id: string
      enterprise_id: string
      created_at: Date | string
    }>(this.client, `SELECT id, reversal_no, source_order_id, source_order_no, reason, reversed_by, reversed_at,
         command_receipt_id, plant_id, enterprise_id, created_at
       FROM reel_split_reversal WHERE source_order_id = $1`,
      [orderId],
    )
    if (r.rows[0] === undefined) return null
    const row = r.rows[0]
    return {
      id: row.id,
      reversalNo: row.reversal_no,
      sourceOrderId: row.source_order_id,
      sourceOrderNo: row.source_order_no,
      reason: row.reason,
      reversedBy: row.reversed_by,
      reversedAt: iso(row.reversed_at),
      commandReceiptId: row.command_receipt_id,
      plantId: row.plant_id,
      enterpriseId: row.enterprise_id,
      createdAt: iso(row.created_at),
    }
  }

  async listPaged(filter: {
    enterpriseId: string
    plantIds: string[] | null
    page: number
    pageSize: number
  }): Promise<{ items: ReelSplitOrderRecord[]; total: number }> {
    const where = filter.plantIds === null
      ? typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM reel_split_order WHERE enterprise_id = $1`, [filter.enterpriseId])
      : typedQuery<{ c: string }>(
          this.client,
          `SELECT COUNT(*)::text AS c FROM reel_split_order WHERE enterprise_id = $1 AND plant_id = ANY($2)`,
          [filter.enterpriseId, filter.plantIds],
        )
    const countRow = await where
    const total = Number(countRow.rows[0]!.c)
    const offset = (filter.page - 1) * filter.pageSize
    const list = filter.plantIds === null
      ? await typedQuery<ReelSplitOrderRow>(this.client, `SELECT ${REEL_SPLIT_ORDER_COLUMNS} ${REEL_SPLIT_ORDER_JOIN}
           WHERE o.enterprise_id = $1 ORDER BY o.split_at DESC, o.order_no LIMIT $2 OFFSET $3`,
          [filter.enterpriseId, filter.pageSize, offset],
        )
      : await typedQuery<ReelSplitOrderRow>(this.client, `SELECT ${REEL_SPLIT_ORDER_COLUMNS} ${REEL_SPLIT_ORDER_JOIN}
           WHERE o.enterprise_id = $1 AND o.plant_id = ANY($2) ORDER BY o.split_at DESC, o.order_no LIMIT $3 OFFSET $4`,
          [filter.enterpriseId, filter.plantIds, filter.pageSize, offset],
        )
    return { items: list.rows.map(mapReelSplitOrder), total }
  }

  async nextOrderNo(now: Date): Promise<string> {
    const day = dateOnly(now)
    const r = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM reel_split_order WHERE order_no LIKE $1`,
      [`RSP-${day}-%`],
    )
    return `RSP-${day}-${String(Number(r.rows[0]!.c) + 1).padStart(4, '0')}`
  }
}

// ---------------- pallet_task / line ----------------

const PALLET_TASK_COLUMNS = `id, task_no, task_type, status, operator, operator_dept_category,
  target_carrier_id, target_carrier_code, warehouse_id, warehouse_code, rack_id, rack_code,
  location_id, location_code, warehouse_of_record, completed_at, first_scan_at, plant_id,
  enterprise_id, business_time, created_at, created_by, updated_at, updated_by`

interface PalletTaskRow {
  id: string
  task_no: string
  task_type: 'split_pallet' | 'unbind_pallet'
  status: 'in_progress' | 'completed' | 'abandoned'
  operator: string
  operator_dept_category: number | null
  target_carrier_id: string | null
  target_carrier_code: string | null
  warehouse_id: string | null
  warehouse_code: string | null
  rack_id: string | null
  rack_code: string | null
  location_id: string | null
  location_code: string | null
  warehouse_of_record: string | null
  completed_at: Date | string | null
  first_scan_at: Date | string
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapPalletTask(r: PalletTaskRow): PalletTaskRecord {
  return {
    id: r.id,
    taskNo: r.task_no,
    taskType: r.task_type,
    status: r.status,
    operator: r.operator,
    operatorDeptCategory: r.operator_dept_category,
    targetCarrierId: r.target_carrier_id,
    targetCarrierCode: r.target_carrier_code,
    warehouseId: r.warehouse_id,
    warehouseCode: r.warehouse_code,
    rackId: r.rack_id,
    rackCode: r.rack_code,
    locationId: r.location_id,
    locationCode: r.location_code,
    warehouseOfRecord: r.warehouse_of_record,
    completedAt: r.completed_at === null ? null : iso(r.completed_at),
    firstScanAt: iso(r.first_scan_at),
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

const PALLET_TASK_LINE_COLUMNS = `id, task_id, unit_id, unit_no, original_carrier_id, original_carrier_code,
  original_warehouse_id, original_warehouse_code, original_rack_id, original_rack_code,
  original_location_id, original_location_code, reservation_id, scanned_at, removed_at, created_at`

interface PalletTaskLineRow {
  id: string
  task_id: string
  unit_id: string
  unit_no: string
  original_carrier_id: string | null
  original_carrier_code: string | null
  original_warehouse_id: string | null
  original_warehouse_code: string | null
  original_rack_id: string | null
  original_rack_code: string | null
  original_location_id: string | null
  original_location_code: string | null
  reservation_id: string | null
  scanned_at: Date | string
  removed_at: Date | string | null
  created_at: Date | string
}

function mapPalletTaskLine(r: PalletTaskLineRow): PalletTaskLineRecord {
  return {
    id: r.id,
    taskId: r.task_id,
    unitId: r.unit_id,
    unitNo: r.unit_no,
    originalCarrierId: r.original_carrier_id,
    originalCarrierCode: r.original_carrier_code,
    originalWarehouseId: r.original_warehouse_id,
    originalWarehouseCode: r.original_warehouse_code,
    originalRackId: r.original_rack_id,
    originalRackCode: r.original_rack_code,
    originalLocationId: r.original_location_id,
    originalLocationCode: r.original_location_code,
    reservationId: r.reservation_id,
    scannedAt: iso(r.scanned_at),
    removedAt: r.removed_at === null ? null : iso(r.removed_at),
    createdAt: iso(r.created_at),
  }
}

export class PgPalletTaskRepository implements PalletTaskRepository {
  constructor(private readonly client: SqlClient) {}

  async findInProgress(
    operator: string,
    taskType: 'split_pallet' | 'unbind_pallet',
  ): Promise<PalletTaskRecord | null> {
    const r = await typedQuery<PalletTaskRow>(this.client, `SELECT ${PALLET_TASK_COLUMNS} FROM pallet_task
       WHERE operator = $1 AND task_type = $2 AND status = 'in_progress'
       ORDER BY created_at DESC LIMIT 1`,
      [operator, taskType],
    )
    return r.rows[0] === undefined ? null : mapPalletTask(r.rows[0])
  }

  async findById(id: string): Promise<PalletTaskRecord | null> {
    const r = await typedQuery<PalletTaskRow>(this.client, `SELECT ${PALLET_TASK_COLUMNS} FROM pallet_task WHERE id = $1`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapPalletTask(r.rows[0])
  }

  async insert(task: Omit<PalletTaskRecord, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>): Promise<PalletTaskRecord> {
    const r = await typedQuery<PalletTaskRow>(this.client, `INSERT INTO pallet_task (task_no, task_type, status, operator, operator_dept_category,
         target_carrier_id, target_carrier_code, warehouse_id, warehouse_code, rack_id, rack_code,
         location_id, location_code, warehouse_of_record, completed_at, first_scan_at,
         plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING ${PALLET_TASK_COLUMNS}`,
      [
        task.taskNo,
        task.taskType,
        task.status,
        task.operator,
        task.operatorDeptCategory,
        task.targetCarrierId,
        task.targetCarrierCode,
        task.warehouseId,
        task.warehouseCode,
        task.rackId,
        task.rackCode,
        task.locationId,
        task.locationCode,
        task.warehouseOfRecord,
        task.completedAt,
        task.firstScanAt,
        task.plantId,
        task.enterpriseId,
        task.createdBy,
      ],
    )
    return mapPalletTask(r.rows[0]!)
  }

  async update(
    id: string,
    patch: Partial<Omit<PalletTaskRecord, 'id' | 'createdAt'>>,
    actor: string,
    now: string,
  ): Promise<PalletTaskRecord | null> {
    const current = await this.findById(id)
    if (current === null) return null
    const next = { ...current, ...patch }
    const r = await typedQuery<PalletTaskRow>(this.client, `UPDATE pallet_task SET
         task_type = $2, status = $3, target_carrier_id = $4, target_carrier_code = $5,
         warehouse_id = $6, warehouse_code = $7, rack_id = $8, rack_code = $9,
         location_id = $10, location_code = $11, warehouse_of_record = $12, completed_at = $13,
         updated_at = $14, updated_by = $15
       WHERE id = $1
       RETURNING ${PALLET_TASK_COLUMNS}`,
      [
        id,
        next.taskType,
        next.status,
        next.targetCarrierId,
        next.targetCarrierCode,
        next.warehouseId,
        next.warehouseCode,
        next.rackId,
        next.rackCode,
        next.locationId,
        next.locationCode,
        next.warehouseOfRecord,
        next.completedAt,
        now,
        actor,
      ],
    )
    return r.rows[0] === undefined ? null : mapPalletTask(r.rows[0])
  }

  async insertLine(line: Omit<PalletTaskLineRecord, 'id' | 'createdAt'>): Promise<PalletTaskLineRecord> {
    const r = await typedQuery<PalletTaskLineRow>(this.client, `INSERT INTO pallet_task_line (task_id, unit_id, unit_no, original_carrier_id, original_carrier_code,
         original_warehouse_id, original_warehouse_code, original_rack_id, original_rack_code,
         original_location_id, original_location_code, reservation_id, scanned_at, removed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${PALLET_TASK_LINE_COLUMNS}`,
      [
        line.taskId,
        line.unitId,
        line.unitNo,
        line.originalCarrierId,
        line.originalCarrierCode,
        line.originalWarehouseId,
        line.originalWarehouseCode,
        line.originalRackId,
        line.originalRackCode,
        line.originalLocationId,
        line.originalLocationCode,
        line.reservationId,
        line.scannedAt,
        line.removedAt,
      ],
    )
    return mapPalletTaskLine(r.rows[0]!)
  }

  async listLines(taskId: string, includeRemoved: boolean): Promise<PalletTaskLineRecord[]> {
    const r = await typedQuery<PalletTaskLineRow>(this.client, `SELECT ${PALLET_TASK_LINE_COLUMNS} FROM pallet_task_line
       WHERE task_id = $1 ${includeRemoved ? '' : 'AND removed_at IS NULL'} ORDER BY scanned_at, id`,
      [taskId],
    )
    return r.rows.map(mapPalletTaskLine)
  }

  async markLineRemoved(lineId: string, now: string): Promise<PalletTaskLineRecord | null> {
    const r = await typedQuery<PalletTaskLineRow>(this.client, `UPDATE pallet_task_line SET removed_at = $2 WHERE id = $1 AND removed_at IS NULL
       RETURNING ${PALLET_TASK_LINE_COLUMNS}`,
      [lineId, now],
    )
    return r.rows[0] === undefined ? null : mapPalletTaskLine(r.rows[0])
  }

  async listCompletedPaged(filter: {
    enterpriseId: string
    plantIds: string[] | null
    taskType?: 'split_pallet' | 'unbind_pallet'
    operator?: string
    page: number
    pageSize: number
  }): Promise<{ items: PalletTaskRecord[]; total: number }> {
    const params: unknown[] = [filter.enterpriseId]
    let where = `enterprise_id = $1 AND status = 'completed'`
    if (filter.plantIds !== null) {
      params.push(filter.plantIds)
      where += ` AND plant_id = ANY($${params.length})`
    }
    if (filter.taskType !== undefined) {
      params.push(filter.taskType)
      where += ` AND task_type = $${params.length}`
    }
    if (filter.operator !== undefined && filter.operator !== '') {
      params.push(filter.operator)
      where += ` AND operator = $${params.length}`
    }
    const countR = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM pallet_task WHERE ${where}`,
      params,
    )
    const total = Number(countR.rows[0]!.c)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await typedQuery<PalletTaskRow>(this.client, `SELECT ${PALLET_TASK_COLUMNS} FROM pallet_task WHERE ${where}
       ORDER BY completed_at DESC NULLS LAST, task_no LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map(mapPalletTask), total }
  }

  async nextTaskNo(now: Date): Promise<string> {
    const day = dateOnly(now)
    const r = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM pallet_task WHERE task_no LIKE $1`,
      [`PT-${day}-%`],
    )
    return `PT-${day}-${String(Number(r.rows[0]!.c) + 1).padStart(4, '0')}`
  }
}

// ---------------- axis_no_state / axis_no_correction ----------------

const AXIS_NO_STATE_COLUMNS = `unit_id, unit_no, sales_order_no, order_line_no, customer_axis_no,
  segment_length, virtual_axis_no, updated_at, updated_by`

interface AxisNoStateRow {
  unit_id: string
  unit_no: string
  sales_order_no: string
  order_line_no: string | null
  customer_axis_no: string | null
  segment_length: string | null
  virtual_axis_no: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapAxisNoState(r: AxisNoStateRow): AxisNoStateRecord {
  return {
    unitId: r.unit_id,
    unitNo: r.unit_no,
    salesOrderNo: r.sales_order_no,
    orderLineNo: r.order_line_no,
    customerAxisNo: r.customer_axis_no,
    segmentLength: r.segment_length,
    virtualAxisNo: r.virtual_axis_no,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

const AXIS_CORRECTION_COLUMNS = `id, correction_no, target_unit_id, target_unit_no, target_object_version,
  before_customer_axis_no, after_customer_axis_no, before_segment_length, after_segment_length,
  before_virtual_axis_no, after_virtual_axis_no, original_qty::text AS original_qty,
  cut_qty::text AS cut_qty, new_qty::text AS new_qty, uom_id, uom_code, status,
  took_over_unit_id, took_over_unit_no, reassign_reason, corrected_by, corrected_at,
  withdrawn_by, withdrawn_at, command_receipt_id, plant_id, enterprise_id, business_time,
  created_at, created_by`

interface AxisCorrectionRow {
  id: string
  correction_no: string
  target_unit_id: string
  target_unit_no: string
  target_object_version: string | number
  before_customer_axis_no: string | null
  after_customer_axis_no: string | null
  before_segment_length: string | null
  after_segment_length: string | null
  before_virtual_axis_no: string | null
  after_virtual_axis_no: string | null
  original_qty: string
  cut_qty: string
  new_qty: string
  uom_id: string
  uom_code: string
  status: 'completed' | 'withdrawn'
  took_over_unit_id: string | null
  took_over_unit_no: string | null
  reassign_reason: string | null
  corrected_by: string
  corrected_at: Date | string
  withdrawn_by: string | null
  withdrawn_at: Date | string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapAxisCorrection(r: AxisCorrectionRow): AxisNoCorrectionRecord {
  return {
    id: r.id,
    correctionNo: r.correction_no,
    targetUnitId: r.target_unit_id,
    targetUnitNo: r.target_unit_no,
    targetObjectVersion: Number(r.target_object_version),
    beforeCustomerAxisNo: r.before_customer_axis_no,
    afterCustomerAxisNo: r.after_customer_axis_no,
    beforeSegmentLength: r.before_segment_length,
    afterSegmentLength: r.after_segment_length,
    beforeVirtualAxisNo: r.before_virtual_axis_no,
    afterVirtualAxisNo: r.after_virtual_axis_no,
    originalQty: r.original_qty,
    cutQty: r.cut_qty,
    newQty: r.new_qty,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    status: r.status,
    tookOverUnitId: r.took_over_unit_id,
    tookOverUnitNo: r.took_over_unit_no,
    reassignReason: r.reassign_reason,
    correctedBy: r.corrected_by,
    correctedAt: iso(r.corrected_at),
    withdrawnBy: r.withdrawn_by,
    withdrawnAt: r.withdrawn_at === null ? null : iso(r.withdrawn_at),
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgAxisNoRepository implements AxisNoRepository {
  constructor(private readonly client: SqlClient) {}

  async getState(unitId: string): Promise<AxisNoStateRecord | null> {
    const r = await typedQuery<AxisNoStateRow>(this.client, `SELECT ${AXIS_NO_STATE_COLUMNS} FROM axis_no_state WHERE unit_id = $1`,
      [unitId],
    )
    return r.rows[0] === undefined ? null : mapAxisNoState(r.rows[0])
  }

  async listByOrder(salesOrderNo: string, plantId?: string): Promise<AxisNoStateRecord[]> {
    const r = await typedQuery<AxisNoStateRow>(this.client, `SELECT ${AXIS_NO_STATE_COLUMNS} FROM axis_no_state WHERE sales_order_no = $1 AND ($2::uuid IS NULL OR unit_id IN (SELECT id FROM inventory_unit WHERE plant_id = $2)) ORDER BY unit_no`,
      [salesOrderNo, plantId ?? null],
    )
    return r.rows.map(mapAxisNoState)
  }

  async upsertState(
    state: Omit<AxisNoStateRecord, 'updatedAt' | 'updatedBy'>,
    actor: string,
    now: string,
  ): Promise<AxisNoStateRecord> {
    const r = await typedQuery<AxisNoStateRow>(this.client, `INSERT INTO axis_no_state (unit_id, unit_no, sales_order_no, order_line_no, customer_axis_no,
         segment_length, virtual_axis_no, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (unit_id) DO UPDATE SET
         unit_no = EXCLUDED.unit_no,
         sales_order_no = EXCLUDED.sales_order_no,
         order_line_no = EXCLUDED.order_line_no,
         customer_axis_no = EXCLUDED.customer_axis_no,
         segment_length = EXCLUDED.segment_length,
         virtual_axis_no = EXCLUDED.virtual_axis_no,
         updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by
       RETURNING ${AXIS_NO_STATE_COLUMNS}`,
      [
        state.unitId,
        state.unitNo,
        state.salesOrderNo,
        state.orderLineNo,
        state.customerAxisNo,
        state.segmentLength,
        state.virtualAxisNo,
        now,
        actor,
      ],
    )
    return mapAxisNoState(r.rows[0]!)
  }

  async insertCorrection(c: Omit<AxisNoCorrectionRecord, 'id' | 'createdAt'>): Promise<AxisNoCorrectionRecord> {
    const r = await typedQuery<AxisCorrectionRow>(this.client, `INSERT INTO axis_no_correction (correction_no, target_unit_id, target_unit_no, target_object_version,
         before_customer_axis_no, after_customer_axis_no, before_segment_length, after_segment_length,
         before_virtual_axis_no, after_virtual_axis_no, original_qty, cut_qty, new_qty, uom_id, uom_code,
         status, took_over_unit_id, took_over_unit_no, reassign_reason, corrected_by, corrected_at,
         withdrawn_by, withdrawn_at, command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       RETURNING ${AXIS_CORRECTION_COLUMNS}`,
      [
        c.correctionNo,
        c.targetUnitId,
        c.targetUnitNo,
        c.targetObjectVersion,
        c.beforeCustomerAxisNo,
        c.afterCustomerAxisNo,
        c.beforeSegmentLength,
        c.afterSegmentLength,
        c.beforeVirtualAxisNo,
        c.afterVirtualAxisNo,
        c.originalQty,
        c.cutQty,
        c.newQty,
        c.uomId,
        c.uomCode,
        c.status,
        c.tookOverUnitId,
        c.tookOverUnitNo,
        c.reassignReason,
        c.correctedBy,
        c.correctedAt,
        c.withdrawnBy,
        c.withdrawnAt,
        c.commandReceiptId,
        c.plantId,
        c.enterpriseId,
        c.businessTime,
        c.createdBy,
      ],
    )
    return mapAxisCorrection(r.rows[0]!)
  }

  async findCorrectionById(id: string): Promise<AxisNoCorrectionRecord | null> {
    const r = await typedQuery<AxisCorrectionRow>(this.client, `SELECT ${AXIS_CORRECTION_COLUMNS} FROM axis_no_correction WHERE id = $1`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapAxisCorrection(r.rows[0])
  }

  async listCorrectionsPaged(filter: {
    enterpriseId: string
    plantIds: string[] | null
    status?: 'completed' | 'withdrawn'
    page: number
    pageSize: number
  }): Promise<{ items: AxisNoCorrectionRecord[]; total: number }> {
    const params: unknown[] = [filter.enterpriseId]
    let where = `enterprise_id = $1`
    if (filter.plantIds !== null) {
      params.push(filter.plantIds)
      where += ` AND plant_id = ANY($${params.length})`
    }
    if (filter.status !== undefined) {
      params.push(filter.status)
      where += ` AND status = $${params.length}`
    }
    const countR = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM axis_no_correction WHERE ${where}`,
      params,
    )
    const total = Number(countR.rows[0]!.c)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await typedQuery<AxisCorrectionRow>(this.client, `SELECT ${AXIS_CORRECTION_COLUMNS} FROM axis_no_correction WHERE ${where}
       ORDER BY corrected_at DESC, correction_no LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map(mapAxisCorrection), total }
  }

  async markWithdrawn(id: string, withdrawnBy: string, now: string): Promise<AxisNoCorrectionRecord | null> {
    const r = await typedQuery<AxisCorrectionRow>(this.client, `UPDATE axis_no_correction SET status = 'withdrawn', withdrawn_by = $2, withdrawn_at = $3
       WHERE id = $1 AND status = 'completed'
       RETURNING ${AXIS_CORRECTION_COLUMNS}`,
      [id, withdrawnBy, now],
    )
    return r.rows[0] === undefined ? null : mapAxisCorrection(r.rows[0])
  }

  async nextCorrectionNo(now: Date): Promise<string> {
    const day = dateOnly(now)
    const r = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM axis_no_correction WHERE correction_no LIKE $1`,
      [`AXC-${day}-%`],
    )
    return `AXC-${day}-${String(Number(r.rows[0]!.c) + 1).padStart(4, '0')}`
  }
}

// ---------------- axis_code_retire / axis_retire_record ----------------

const AXIS_RETIRE_STATE_COLUMNS = `unit_id, unit_no, retired_by, retired_at, command_receipt_id,
  plant_id, enterprise_id`

interface AxisRetireStateRow {
  unit_id: string
  unit_no: string
  retired_by: string
  retired_at: Date | string
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
}

function mapAxisRetireState(r: AxisRetireStateRow): AxisCodeRetireRecord {
  return {
    unitId: r.unit_id,
    unitNo: r.unit_no,
    retiredBy: r.retired_by,
    retiredAt: iso(r.retired_at),
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
  }
}

const AXIS_RETIRE_RECORD_COLUMNS = `id, retire_no, unit_id, unit_no, qty_before::text AS qty_before,
  production_dept, production_order_no, sales_order_no, line_no, material_id, material_code,
  process_name, report_by, report_at, retired_by, retired_at, uom_id, uom_code, measurement_basis,
  conversion_revision_id, command_receipt_id, plant_id, enterprise_id, business_time, created_at, created_by`

interface AxisRetireRecordRow {
  id: string
  retire_no: string
  unit_id: string
  unit_no: string
  qty_before: string
  production_dept: string | null
  production_order_no: string | null
  sales_order_no: string | null
  line_no: string | null
  material_id: string
  material_code: string
  process_name: string | null
  report_by: string | null
  report_at: Date | string | null
  retired_by: string
  retired_at: Date | string
  uom_id: string
  uom_code: string
  measurement_basis: string
  conversion_revision_id: string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapAxisRetireRecord(r: AxisRetireRecordRow): AxisRetireRecordEntry {
  return {
    id: r.id,
    retireNo: r.retire_no,
    unitId: r.unit_id,
    unitNo: r.unit_no,
    qtyBefore: r.qty_before,
    productionDept: r.production_dept,
    productionOrderNo: r.production_order_no,
    salesOrderNo: r.sales_order_no,
    lineNo: r.line_no,
    materialId: r.material_id,
    materialCode: r.material_code,
    processName: r.process_name,
    reportBy: r.report_by,
    reportAt: r.report_at === null ? null : iso(r.report_at),
    retiredBy: r.retired_by,
    retiredAt: iso(r.retired_at),
    uomId: r.uom_id,
    uomCode: r.uom_code,
    measurementBasis: r.measurement_basis,
    conversionRevisionId: r.conversion_revision_id,
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
  }
}

export class PgAxisRetireRepository implements AxisRetireRepository {
  constructor(private readonly client: SqlClient) {}

  async insertRetireState(row: AxisCodeRetireRecord): Promise<AxisCodeRetireRecord> {
    const r = await typedQuery<AxisRetireStateRow>(this.client, `INSERT INTO axis_code_retire (unit_id, unit_no, retired_by, retired_at, command_receipt_id,
         plant_id, enterprise_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING ${AXIS_RETIRE_STATE_COLUMNS}`,
      [row.unitId, row.unitNo, row.retiredBy, row.retiredAt, row.commandReceiptId, row.plantId, row.enterpriseId],
    )
    return mapAxisRetireState(r.rows[0]!)
  }

  async findRetireState(unitId: string): Promise<AxisCodeRetireRecord | null> {
    const r = await typedQuery<AxisRetireStateRow>(this.client, `SELECT ${AXIS_RETIRE_STATE_COLUMNS} FROM axis_code_retire WHERE unit_id = $1`,
      [unitId],
    )
    return r.rows[0] === undefined ? null : mapAxisRetireState(r.rows[0])
  }

  async listRetiredUnitIds(unitIds: readonly string[]): Promise<string[]> {
    if (unitIds.length === 0) return []
    const r = await typedQuery<{ unit_id: string }>(this.client, `SELECT unit_id FROM axis_code_retire WHERE unit_id = ANY($1)`,
      [[...unitIds]],
    )
    return r.rows.map((row) => row.unit_id)
  }

  async insertRecord(row: Omit<AxisRetireRecordEntry, 'id' | 'createdAt'>): Promise<AxisRetireRecordEntry> {
    const r = await typedQuery<AxisRetireRecordRow>(this.client, `INSERT INTO axis_retire_record (retire_no, unit_id, unit_no, qty_before, production_dept,
         production_order_no, sales_order_no, line_no, material_id, material_code, process_name,
         report_by, report_at, retired_by, retired_at, uom_id, uom_code, measurement_basis,
         conversion_revision_id, command_receipt_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING ${AXIS_RETIRE_RECORD_COLUMNS}`,
      [
        row.retireNo,
        row.unitId,
        row.unitNo,
        row.qtyBefore,
        row.productionDept,
        row.productionOrderNo,
        row.salesOrderNo,
        row.lineNo,
        row.materialId,
        row.materialCode,
        row.processName,
        row.reportBy,
        row.reportAt,
        row.retiredBy,
        row.retiredAt,
        row.uomId,
        row.uomCode,
        row.measurementBasis,
        row.conversionRevisionId,
        row.commandReceiptId,
        row.plantId,
        row.enterpriseId,
        row.retiredAt,
        row.retiredBy,
      ],
    )
    return mapAxisRetireRecord(r.rows[0]!)
  }

  async listRecordsPaged(filter: {
    enterpriseId: string
    plantIds: string[] | null
    page: number
    pageSize: number
  }): Promise<{ items: AxisRetireRecordEntry[]; total: number }> {
    const params: unknown[] = [filter.enterpriseId]
    let where = `enterprise_id = $1`
    if (filter.plantIds !== null) {
      params.push(filter.plantIds)
      where += ` AND plant_id = ANY($${params.length})`
    }
    const countR = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM axis_retire_record WHERE ${where}`,
      params,
    )
    const total = Number(countR.rows[0]!.c)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await typedQuery<AxisRetireRecordRow>(this.client, `SELECT ${AXIS_RETIRE_RECORD_COLUMNS} FROM axis_retire_record WHERE ${where}
       ORDER BY retired_at DESC, retire_no LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map(mapAxisRetireRecord), total }
  }

  async nextRetireNo(now: Date): Promise<string> {
    const day = dateOnly(now)
    const r = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM axis_retire_record WHERE retire_no LIKE $1`,
      [`AXR-${day}-%`],
    )
    return `AXR-${day}-${String(Number(r.rows[0]!.c) + 1).padStart(4, '0')}`
  }
}

// ---------------- 跨域只读事实装配 ----------------

/** 共用：单元状态装配 SQL 片段（RS-03/RS-25/RS-34 拒绝链数据源）。 */
interface UnitStateAggRow {
  unit_id: string | null
  material_id: string | null
  material_code: string | null
  lot_id: string | null
  uom_id: string | null
  uom_code: string | null
  balance_qty: string | null
  balance_id: string | null
  location_id: string | null
  location_code: string | null
  owner_id: string | null
  owner_name: string | null
  quality_pending: boolean
  report_unreviewed: boolean
  anomaly_open: boolean
  locked: boolean
  warehouse_type: string | null
  warehouse_dept_category: number | null
  in_stock: boolean
  bound_carrier_id: string | null
  bound_carrier_code: string | null
  warehouse_id: string | null
  warehouse_code: string | null
  rack_id: string | null
  rack_code: string | null
  customer_axis_no: string | null
  segment_length: string | null
  virtual_axis_no: string | null
  sales_order_no: string | null
  retired: boolean
  is_pallet_code: boolean
}

const UNIT_STATE_AGG_SQL = `
  SELECT u.id AS unit_id, u.material_id, u.material_code, u.lot_id, u.uom_id, u.uom_code,
    COALESCE(b.qty_total, 0)::text AS balance_qty,
    b.first_balance_id AS balance_id,
    loc.id AS location_id, loc.code AS location_code,
    b.owner_id, b.owner_name,
    COALESCE(b.quality_pending, false) AS quality_pending,
    COALESCE(r.unreviewed, false) AS report_unreviewed,
    COALESCE(h.open_hold, false) AS anomaly_open,
    COALESCE(res.active_cnt, 0) > 0 AS locked,
    w.warehouse_type, wd.dept_category AS warehouse_dept_category,
    COALESCE(b.active_cnt, 0) > 0 AS in_stock,
    cb.carrier_id AS bound_carrier_id, cb.carrier_code AS bound_carrier_code,
    w.id AS warehouse_id, w.code AS warehouse_code,
    rk.id AS rack_id, rk.code AS rack_code,
    ax.customer_axis_no, ax.segment_length, ax.virtual_axis_no,
    so.sales_order_no,
    (acr.unit_id IS NOT NULL) AS retired,
    (c.id IS NOT NULL) AS is_pallet_code
  FROM inventory_unit u
  LEFT JOIN LATERAL (
    SELECT SUM(quantity) AS qty_total,
      COUNT(*) FILTER (WHERE status = 'active') AS active_cnt,
      COUNT(*) FILTER (WHERE status = 'active' AND quality_status = 'pending_inspection') > 0 AS quality_pending,
      (array_agg(id ORDER BY id) FILTER (WHERE status = 'active'))[1] AS first_balance_id,
      (array_agg(location_id ORDER BY id) FILTER (WHERE status = 'active'))[1] AS first_location_id,
      (array_agg(owner_id ORDER BY id) FILTER (WHERE status = 'active'))[1] AS owner_id,
      (array_agg(owner_name ORDER BY id) FILTER (WHERE status = 'active'))[1] AS owner_name
    FROM stock_balance WHERE unit_id = u.id
  ) b ON true
  LEFT JOIN storage_location loc ON loc.id = b.first_location_id
  LEFT JOIN warehouse w ON w.id = loc.warehouse_id
  LEFT JOIN rack rk ON rk.id = loc.rack_id
  LEFT JOIN org_node wd ON wd.id = w.dept_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*) > 0 AS unreviewed
    FROM report_output ro JOIN production_report pr ON pr.id = ro.report_id
    WHERE ro.stock_unit_id = u.id AND pr.status = 'submitted' AND pr.review_status = 'pending_review'
  ) r ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) > 0 AS open_hold FROM quality_hold
    WHERE inventory_unit_id = u.id AND status = 'active'
  ) h ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS active_cnt FROM reservation
    WHERE unit_id = u.id AND status = 'active'
  ) res ON true
  LEFT JOIN LATERAL (
    SELECT cb2.carrier_id, c2.carrier_code
    FROM carrier_binding cb2 JOIN carrier c2 ON c2.id = cb2.carrier_id
    WHERE cb2.unit_id = u.id AND cb2.effective_to IS NULL
    ORDER BY cb2.effective_from DESC LIMIT 1
  ) cb ON true
  LEFT JOIN axis_no_state ax ON ax.unit_id = u.id
  LEFT JOIN LATERAL (
    SELECT po.sales_order_no
    FROM report_output ro
      JOIN production_report pr ON pr.id = ro.report_id
      JOIN production_order po ON po.id = pr.order_id
    WHERE ro.stock_unit_id = u.id AND po.sales_order_no IS NOT NULL AND po.sales_order_no <> ''
    ORDER BY pr.business_time DESC LIMIT 1
  ) rep ON true
  -- 订单归属（RS-25 hasOrder）：报工事实优先，本域轴号事实（axis_no_state）兜底
  LEFT JOIN LATERAL (
    SELECT COALESCE(rep.sales_order_no, ax.sales_order_no) AS sales_order_no
  ) so ON true
  LEFT JOIN axis_code_retire acr ON acr.unit_id = u.id
  LEFT JOIN carrier c ON c.carrier_code = u.unit_no AND c.plant_id = u.plant_id`

export class PgReworkFactsLookup implements ReworkFactsLookup {
  constructor(private readonly client: SqlClient) {}

  async operatorOrgFacts(userId: string): Promise<ReworkOperatorOrgFacts> {
    const r = await typedQuery<{ login_name: string; dept_category: number | null; plant_id: string | null }>(this.client, `SELECT u.login_name, d.dept_category, u.plant_id
       FROM user_account u LEFT JOIN org_node d ON d.id = u.dept_id
       WHERE u.id = $1`,
      [userId],
    )
    if (r.rows[0] === undefined) {
      return { loginName: '', deptCategory: null, plantId: null }
    }
    return {
      loginName: r.rows[0].login_name,
      deptCategory: r.rows[0].dept_category,
      plantId: r.rows[0].plant_id,
    }
  }

  private async unitStateByNo(plantId: string, unitNo: string): Promise<UnitStateAggRow | null> {
    const r = await typedQuery<UnitStateAggRow>(this.client, `${UNIT_STATE_AGG_SQL} WHERE u.plant_id = $1 AND u.unit_no = $2`,
      [plantId, unitNo],
    )
    return r.rows[0] ?? null
  }

  async reelSplitSourceRow(plantId: string, unitNo: string): Promise<ReelSplitSourceRow> {
    const row = await this.unitStateByNo(plantId, unitNo)
    // RS-04 一码多物：同码跨厂多行且料品不一致
    let multiMaterial = false
    if (row !== null) {
      const mm = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(DISTINCT material_id)::text AS c FROM inventory_unit WHERE unit_no = $1`,
        [unitNo],
      )
      multiMaterial = Number(mm.rows[0]!.c) > 1
    }
    const carrierLike = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM carrier WHERE carrier_code = $1 AND plant_id = $2`,
      [unitNo, plantId],
    )
    if (row === null) {
      return {
        unitId: '',
        unitNo,
        exists: false,
        isPalletCode: Number(carrierLike.rows[0]!.c) > 0,
        locked: false,
        qualityPending: false,
        reportUnreviewed: false,
        anomalyOpen: false,
        inLogisticsWarehouse: false,
        multiMaterial,
        balanceQty: '0.0000',
        materialId: '',
        materialCode: '',
        lotId: '',
        customerAxisNo: null,
        segmentLength: null,
        uomId: '',
        uomCode: '',
        retired: false,
      }
    }
    return {
      unitId: row.unit_id!,
      unitNo,
      exists: true,
      isPalletCode: row.is_pallet_code || Number(carrierLike.rows[0]!.c) > 0,
      locked: row.locked,
      qualityPending: row.quality_pending,
      reportUnreviewed: row.report_unreviewed,
      anomalyOpen: row.anomaly_open,
      inLogisticsWarehouse: row.warehouse_dept_category === 3,
      multiMaterial,
      balanceQty: row.balance_qty ?? '0.0000',
      materialId: row.material_id!,
      materialCode: row.material_code!,
      lotId: row.lot_id!,
      customerAxisNo: row.customer_axis_no,
      segmentLength: row.segment_length,
      uomId: row.uom_id!,
      uomCode: row.uom_code!,
      retired: row.retired,
    }
  }

  async reelSplitTargetRows(plantId: string, unitNos: readonly string[]): Promise<ReelSplitTargetRow[]> {
    const rows: ReelSplitTargetRow[] = []
    for (const unitNo of unitNos) {
      const row = await this.unitStateByNo(plantId, unitNo)
      const taken = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM inventory_unit WHERE unit_no = $1 AND plant_id <> $2`,
        [unitNo, plantId],
      )
      if (row === null) {
        rows.push({
          unitId: null,
          unitNo,
          exists: false,
          materialId: null,
          materialCode: null,
          locationId: null,
          locationCode: null,
          ownerId: null,
          ownerName: null,
          unitNoTakenByOtherPlant: Number(taken.rows[0]!.c) > 0,
        })
        continue
      }
      rows.push({
        unitId: row.unit_id,
        unitNo,
        exists: true,
        materialId: row.material_id,
        materialCode: row.material_code,
        locationId: row.location_id,
        locationCode: row.location_code,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        unitNoTakenByOtherPlant: Number(taken.rows[0]!.c) > 0,
      })
    }
    return rows
  }

  async reelSplitReversalDownstream(
    childUnitIds: readonly string[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 端口签名保留（源单元键当前由下游事实行内联）
    _sourceUnitId: string,
  ): Promise<ReelSplitReversalDownstreamRow> {
    if (childUnitIds.length === 0) {
      return { anyChildStocked: false, anyChildConsumed: false, anyChildConverted: false, anyChildShipped: false, anyChildQualityEffective: false }
    }
    const ids = [...childUnitIds]
    // 已入库：子轴活动余额位于 WAREHOUSE 类型仓库（非线边）
    const stocked = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM stock_balance sb
        JOIN storage_location l ON l.id = sb.location_id
        JOIN warehouse w ON w.id = l.warehouse_id
       WHERE sb.unit_id = ANY($1) AND sb.status = 'active' AND sb.quantity > 0 AND w.warehouse_type = 'WAREHOUSE'`,
      [ids],
    )
    // 已被消耗：存在 issue 流水
    const consumed = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM stock_transaction WHERE unit_id = ANY($1) AND movement_kind = 'issue'`,
      [ids],
    )
    // 已被转换：0012 conversion_order_scan（并行线表——L0 注册 0012 后真实生效；
    // 列名以 0012 实际 DDL 为准：inventory_unit_id（原假设 unit_id 注册后报列不存在，已修））
    let convertedCount = 0
    if (await tableExistsStatic(this.client, 'conversion_order_scan')) {
      const converted = await typedQuery<{ c: string }>(
        this.client,
        `SELECT COUNT(*)::text AS c FROM conversion_order_scan WHERE inventory_unit_id = ANY($1) AND deleted = false`,
        [ids],
      )
      convertedCount = Number(converted.rows[0]!.c)
    }
    // 已发运：0010 packing_scan 装载 + unit 状态 shipped
    const shipped = await typedQuery<{ c: string }>(this.client, `SELECT (
         (SELECT COUNT(*) FROM packing_scan WHERE inventory_unit_id = ANY($1) AND deleted = false)
         + (SELECT COUNT(*) FROM inventory_unit WHERE id = ANY($1) AND status = 'shipped')
       )::text AS c`,
      [ids],
    )
    // 已形成生效质量结果：0009 生效结论行（qualified/unqualified 均为已形成）
    const qualityEffective = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM quality_test_result qtr
        JOIN quality_inspection_order qio ON qio.id = qtr.inspection_order_id
       WHERE qio.inventory_unit_id = ANY($1) AND qtr.is_effective = true AND qtr.conclusion <> 'pending'`,
      [ids],
    )
    return {
      anyChildStocked: Number(stocked.rows[0]!.c) > 0,
      anyChildConsumed: Number(consumed.rows[0]!.c) > 0,
      anyChildConverted: convertedCount > 0,
      anyChildShipped: Number(shipped.rows[0]!.c) > 0,
      anyChildQualityEffective: Number(qualityEffective.rows[0]!.c) > 0,
    }
  }

  async unitBalancesIncludingClosed(unitId: string): Promise<Array<{
    id: string
    locationId: string
    locationCode: string
    ownerId: string
    ownerName: string
    quantity: string
    status: 'active' | 'closed'
    uomId: string
    uomCode: string
    measurementBasis: string
    conversionRevisionId: string | null
  }>> {
    const r = await typedQuery<{
      id: string
      location_id: string
      location_code: string
      owner_id: string
      owner_name: string
      quantity: string
      status: 'active' | 'closed'
      uom_id: string
      uom_code: string
      measurement_basis: string
      conversion_revision_id: string | null
    }>(this.client, `SELECT sb.id, sb.location_id, l.code AS location_code, sb.owner_id, sb.owner_name,
         sb.quantity::text AS quantity, sb.status, sb.uom_id, sb.uom_code, sb.measurement_basis,
         sb.conversion_revision_id
       FROM stock_balance sb JOIN storage_location l ON l.id = sb.location_id
       WHERE sb.unit_id = $1 ORDER BY sb.id`,
      [unitId],
    )
    return r.rows.map((row) => ({
      id: row.id,
      locationId: row.location_id,
      locationCode: row.location_code,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      quantity: row.quantity,
      status: row.status,
      uomId: row.uom_id,
      uomCode: row.uom_code,
      measurementBasis: row.measurement_basis,
      conversionRevisionId: row.conversion_revision_id,
    }))
  }

  async palletScanRow(
    plantId: string,
    unitNo: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 端口签名保留（任务级过滤在应用层按行装配）
    _taskId: string | null,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 端口签名保留（分托/解绑拒绝链分叉在应用层）
    _taskType: 'split_pallet' | 'unbind_pallet',
  ): Promise<PalletScanRow> {
    const row = await this.unitStateByNo(plantId, unitNo)
    const carrierLike = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM carrier WHERE carrier_code = $1 AND plant_id = $2`,
      [unitNo, plantId],
    )
    const isPallet = Number(carrierLike.rows[0]!.c) > 0
    // 盘点锁定（RS-16）：0013 stocktake_order（并行线表——本线测试库未应用 0013 时恒 false）
    let warehouseLockedCount = 0
    if (row !== null && row.warehouse_id !== null && await tableExistsStatic(this.client, 'stocktake_order')) {
      const lockedR = await typedQuery<{ c: string }>(
        this.client,
        `SELECT COUNT(*)::text AS c FROM stocktake_order WHERE warehouse_id = $1 AND status IN ('pending', 'counting')`,
        [row.warehouse_id],
      )
      warehouseLockedCount = Number(lockedR.rows[0]!.c)
    }
    if (row === null) {
      return {
        unitId: '',
        unitNo,
        exists: false,
        isPalletCode: isPallet,
        multiMaterial: false,
        inStock: false,
        inWarehouse: false,
        boundCarrierId: null,
        boundCarrierCode: null,
        warehouseId: null,
        warehouseCode: null,
        rackId: null,
        rackCode: null,
        locationId: null,
        locationCode: null,
        lockedByOther: false,
        warehouseLocked: false,
        retired: false,
      }
    }
    return {
      unitId: row.unit_id!,
      unitNo,
      exists: true,
      isPalletCode: row.is_pallet_code || isPallet,
      multiMaterial: false,
      inStock: row.in_stock,
      inWarehouse: row.warehouse_type === 'WAREHOUSE',
      boundCarrierId: row.bound_carrier_id,
      boundCarrierCode: row.bound_carrier_code,
      warehouseId: row.warehouse_id,
      warehouseCode: row.warehouse_code,
      rackId: row.rack_id,
      rackCode: row.rack_code,
      locationId: row.location_id,
      locationCode: row.location_code,
      lockedByOther: row.locked,
      warehouseLocked: warehouseLockedCount > 0,
      retired: row.retired,
    }
  }

  async carrierEverBound(carrierCode: string, plantId: string): Promise<{
    carrierId: string
    everBound: boolean
    warehouseId: string | null
    warehouseCode: string | null
    rackId: string | null
    rackCode: string | null
    locationId: string | null
    locationCode: string | null
  } | null> {
    // 档案 + 绑定史（RS-15 新托/老托判定：everBound = 存在任何绑定行）
    const r = await typedQuery<{ id: string; ever_bound: boolean }>(this.client, `SELECT c.id,
         EXISTS (SELECT 1 FROM carrier_binding cb WHERE cb.carrier_id = c.id) AS ever_bound
       FROM carrier c WHERE c.carrier_code = $1 AND c.plant_id = $2`,
      [carrierCode, plantId],
    )
    if (r.rows[0] === undefined) return null
    // 原托位置（RS-15 老托自动带出）：最新一条绑定对应单元的活动余额位置
    const simple = await typedQuery<{
      warehouse_id: string | null
      warehouse_code: string | null
      rack_id: string | null
      rack_code: string | null
      location_id: string | null
      location_code: string | null
    }>(this.client, `SELECT w.id AS warehouse_id, w.code AS warehouse_code,
         rk.id AS rack_id, rk.code AS rack_code,
         loc.id AS location_id, loc.code AS location_code
       FROM carrier c
       JOIN LATERAL (
         SELECT cb.unit_id FROM carrier_binding cb
         WHERE cb.carrier_id = c.id ORDER BY cb.effective_from DESC, cb.id DESC LIMIT 1
       ) last_bind ON true
       JOIN LATERAL (
         SELECT sb.location_id FROM stock_balance sb
         WHERE sb.unit_id = last_bind.unit_id AND sb.status = 'active' ORDER BY sb.id LIMIT 1
       ) bal ON true
       JOIN storage_location loc ON loc.id = bal.location_id
       JOIN warehouse w ON w.id = loc.warehouse_id
       LEFT JOIN rack rk ON rk.id = loc.rack_id
       WHERE c.carrier_code = $1 AND c.plant_id = $2`,
      [carrierCode, plantId],
    )
    const s = simple.rows[0]
    return {
      carrierId: r.rows[0].id,
      everBound: r.rows[0].ever_bound,
      warehouseId: s?.warehouse_id ?? null,
      warehouseCode: s?.warehouse_code ?? null,
      rackId: s?.rack_id ?? null,
      rackCode: s?.rack_code ?? null,
      locationId: s?.location_id ?? null,
      locationCode: s?.location_code ?? null,
    }
  }

  async carrierWarehouseId(carrierId: string): Promise<string | null> {
    const r = await typedQuery<{ warehouse_id: string | null }>(this.client, `SELECT w.id AS warehouse_id
       FROM carrier c
       JOIN LATERAL (
         SELECT cb.unit_id FROM carrier_binding cb
         WHERE cb.carrier_id = c.id AND cb.effective_to IS NULL
         ORDER BY cb.effective_from DESC LIMIT 1
       ) cur ON true
       JOIN LATERAL (
         SELECT sb.location_id FROM stock_balance sb
         WHERE sb.unit_id = cur.unit_id AND sb.status = 'active' ORDER BY sb.id LIMIT 1
       ) bal ON true
       JOIN storage_location loc ON loc.id = bal.location_id
       JOIN warehouse w ON w.id = loc.warehouse_id
       WHERE c.id = $1`,
      [carrierId],
    )
    return r.rows[0]?.warehouse_id ?? null
  }

  async warehouseLocked(warehouseId: string | null): Promise<boolean> {
    if (warehouseId === null) return false
    // 0013 stocktake_order（并行线表——本线测试库未应用 0013 时恒 false）
    if (!(await tableExistsStatic(this.client, 'stocktake_order'))) return false
    const r = await typedQuery<{ c: string }>(
      this.client,
      `SELECT COUNT(*)::text AS c FROM stocktake_order WHERE warehouse_id = $1 AND status IN ('pending', 'counting')`,
      [warehouseId],
    )
    return Number(r.rows[0]!.c) > 0
  }

  async axisRegistrationOrigin(unitId: string) {
    const r = await this.client.query(`SELECT po.id AS "orderId", po.sales_order_no AS "salesOrderNo",
      po.line_no AS "lineNo", po.plant_id AS "plantId", po.enterprise_id AS "enterpriseId", ro.quantity::text AS "outputQty"
      FROM report_output ro JOIN production_report pr ON pr.id = ro.report_id
      JOIN production_order po ON po.id = pr.order_id
      WHERE ro.stock_unit_id = $1 AND pr.review_status IN ('auto_approved','manual_approved')`, [unitId])
    if (r.rows.length !== 1 || !r.rows[0].salesOrderNo) return null
    return r.rows[0] as { orderId: string; salesOrderNo: string; lineNo: string | null; plantId: string; enterpriseId: string; outputQty: string }
  }

  async correctionScanRow(plantId: string, unitNo: string): Promise<CorrectionScanRow> {
    const row = await this.unitStateByNo(plantId, unitNo)
    const carrierLike = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM carrier WHERE carrier_code = $1 AND plant_id = $2`,
      [unitNo, plantId],
    )
    const base = {
      unitNo,
      exists: row !== null,
      isPalletCode: (row?.is_pallet_code ?? false) || Number(carrierLike.rows[0]!.c) > 0,
      multiMaterial: false,
      inLogisticsWarehouse: row?.warehouse_dept_category === 3,
      qualityPending: row?.quality_pending ?? false,
      reportUnreviewed: row?.report_unreviewed ?? false,
      anomalyOpen: row?.anomaly_open ?? false,
      locked: row?.locked ?? false,
      hasOrder: (row?.sales_order_no ?? '') !== '',
      transitAxisPending: false,
      retired: row?.retired ?? false,
      unitId: row?.unit_id ?? null,
      materialId: row?.material_id ?? null,
      salesOrderNo: row?.sales_order_no ?? null,
    }
    if (row === null) {
      return {
        ...base,
        sold: false,
        currentQty: null,
        maxSingleReportQty: '0.0000',
        materialPrimaryUomCode: null,
      }
    }
    // 已销售（RS-25）：0010 装载扫码
    const sold = await typedQuery<{ c: string }>(this.client, `SELECT (
         (SELECT COUNT(*) FROM packing_scan WHERE inventory_unit_id = $1 AND deleted = false)
         + (SELECT COUNT(*) FROM inventory_unit WHERE id = $1 AND status = 'shipped')
       )::text AS c`,
      [row.unit_id],
    )
    // 最大单次报工数量（RS-27）：该码所属订单工序的全部报工产出行最大数量
    const maxReport = await typedQuery<{ m: string | null }>(this.client, `SELECT MAX(ro.quantity)::text AS m
       FROM report_output ro JOIN production_report pr ON pr.id = ro.report_id
       WHERE pr.order_operation_id IN (
         SELECT pr2.order_operation_id FROM report_output ro2
           JOIN production_report pr2 ON pr2.id = ro2.report_id
         WHERE ro2.stock_unit_id = $1
       )`,
      [row.unit_id],
    )
    const uom = await typedQuery<{ base_uom: string | null }>(this.client, `SELECT base_uom FROM material WHERE id = $1`,
      [row.material_id],
    )
    return {
      ...base,
      sold: Number(sold.rows[0]!.c) > 0,
      currentQty: row.balance_qty,
      maxSingleReportQty: maxReport.rows[0]?.m ?? row.balance_qty ?? '0.0000',
      materialPrimaryUomCode: uom.rows[0]?.base_uom ?? null,
    }
  }

  async correctionOccupiedUnitRow(unitId: string): Promise<{ inWarehouse: boolean; sold: boolean; locked: boolean } | null> {
    const r = await typedQuery<{
      warehouse_type: string | null
      sold: string
      locked: string
    }>(this.client, `SELECT
         (SELECT w.warehouse_type FROM stock_balance sb
           JOIN storage_location l ON l.id = sb.location_id
           JOIN warehouse w ON w.id = l.warehouse_id
          WHERE sb.unit_id = $1 AND sb.status = 'active' AND sb.quantity > 0 LIMIT 1) AS warehouse_type,
         (SELECT (SELECT COUNT(*) FROM packing_scan WHERE inventory_unit_id = $1 AND deleted = false)
            + (SELECT COUNT(*) FROM inventory_unit WHERE id = $1 AND status = 'shipped'))::text AS sold,
         (SELECT COUNT(*) FROM reservation WHERE unit_id = $1 AND status = 'active')::text AS locked`,
      [unitId],
    )
    const row = r.rows[0]
    if (row === undefined) return null
    return {
      inWarehouse: row.warehouse_type === 'WAREHOUSE',
      sold: Number(row.sold) > 0,
      locked: Number(row.locked) > 0,
    }
  }

  async correctionWithdrawDownstream(unitId: string): Promise<CorrectionWithdrawDownstreamRow> {
    const split = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM stock_transaction WHERE unit_id = $1 AND movement_kind = 'split'`,
      [unitId],
    )
    const shipped = await typedQuery<{ c: string }>(this.client, `SELECT (
         (SELECT COUNT(*) FROM packing_scan WHERE inventory_unit_id = $1 AND deleted = false)
         + (SELECT COUNT(*) FROM inventory_unit WHERE id = $1 AND status = 'shipped')
       )::text AS c`,
      [unitId],
    )
    let convertedCount = 0
    if (await tableExistsStatic(this.client, 'conversion_order_scan')) {
      const converted = await typedQuery<{ c: string }>(
        this.client,
        `SELECT COUNT(*)::text AS c FROM conversion_order_scan WHERE inventory_unit_id = $1 AND deleted = false`,
        [unitId],
      )
      convertedCount = Number(converted.rows[0]!.c)
    }
    const quality = await typedQuery<{ c: string }>(this.client, `SELECT COUNT(*)::text AS c FROM quality_test_result qtr
        JOIN quality_inspection_order qio ON qio.id = qtr.inspection_order_id
       WHERE qio.inventory_unit_id = $1 AND qtr.is_effective = true AND qtr.conclusion <> 'pending'`,
      [unitId],
    )
    return {
      splitAfterCorrection: Number(split.rows[0]!.c) > 0,
      shipped: Number(shipped.rows[0]!.c) > 0,
      converted: convertedCount > 0,
      qualityEffective: Number(quality.rows[0]!.c) > 0,
    }
  }

  async axisRetireCandidateRows(plantId: string, unitNos: readonly string[]): Promise<AxisRetireCandidateRow[]> {
    const rows: AxisRetireCandidateRow[] = []
    for (const unitNo of unitNos) {
      const state = await this.unitStateByNo(plantId, unitNo)
      if (state === null) continue
      const report = await typedQuery<{
        production_dept: string | null
        production_order_no: string | null
        sales_order_no: string | null
        line_no: string | null
        process_name: string | null
        report_by: string | null
        report_at: Date | string | null
      }>(this.client, `SELECT qio.production_dept_name AS production_dept,
           po.order_no AS production_order_no,
           po.sales_order_no AS sales_order_no,
           NULL AS line_no,
           oo.operation_name AS process_name,
           pr.operator_login AS report_by,
           pr.business_time AS report_at
         FROM report_output ro
           JOIN production_report pr ON pr.id = ro.report_id
           JOIN production_order po ON po.id = pr.order_id
           LEFT JOIN order_operation oo ON oo.id = pr.order_operation_id
           LEFT JOIN quality_inspection_order qio ON qio.inventory_unit_id = ro.stock_unit_id
         WHERE ro.stock_unit_id = $1
         ORDER BY pr.business_time DESC LIMIT 1`,
        [state.unit_id],
      )
      const rep = report.rows[0]
      // RS-34：质检已完成 + 报工已审核（按 0008/0009 事实装配）
      const qualityCompleted = !state.quality_pending
      const reportReviewed = !state.report_unreviewed
      // 码类型为产品轴码：库存单元且非托码（载具）即产品码；成品仓在库判定 = WAREHOUSE 仓库在库
      rows.push({
        unitId: state.unit_id!,
        unitNo,
        isProductAxisCode: state.material_id !== null,
        qualityCompleted,
        reportReviewed,
        transitAxisPending: false,
        inFinishedGoodsStock: state.warehouse_type === 'WAREHOUSE' && state.in_stock,
        retired: state.retired,
        qtyBefore: state.balance_qty ?? '0.0000',
        productionDept: rep?.production_dept ?? null,
        productionOrderNo: rep?.production_order_no ?? null,
        salesOrderNo: rep?.sales_order_no ?? state.sales_order_no ?? null,
        lineNo: rep?.line_no ?? null,
        materialId: state.material_id!,
        materialCode: state.material_code!,
        processName: rep?.process_name ?? null,
        reportBy: rep?.report_by ?? null,
        reportAt: rep?.report_at === null || rep?.report_at === undefined ? null : iso(rep.report_at),
        uomId: state.uom_id!,
        uomCode: state.uom_code!,
        measurementBasis: 'nominal',
        conversionRevisionId: null,
        balanceId: state.balance_id,
        locationId: state.location_id,
        ownerId: state.owner_id,
      })
    }
    return rows
  }

  async palletExportRows(plantId: string, carrierCodes: readonly string[]): Promise<PalletExportQueryRow[]> {
    if (carrierCodes.length === 0) return []
    const r = await typedQuery<{
      carrier_code: string
      unit_no: string
      customer_axis_no: string | null
      material_code: string
      quantity: string
    }>(this.client, `SELECT c.carrier_code, u.unit_no, ax.customer_axis_no, u.material_code,
         COALESCE((SELECT SUM(sb.quantity) FROM stock_balance sb
           WHERE sb.unit_id = u.id AND sb.status = 'active'), 0)::text AS quantity
       FROM carrier c
       JOIN carrier_binding cb ON cb.carrier_id = c.id AND cb.effective_to IS NULL
       JOIN inventory_unit u ON u.id = cb.unit_id
       LEFT JOIN axis_no_state ax ON ax.unit_id = u.id
       WHERE c.carrier_code = ANY($1) AND c.plant_id = $2
       ORDER BY c.carrier_code, u.unit_no`,
      [[...carrierCodes], plantId],
    )
    return r.rows.map((row) => ({
      carrierCode: row.carrier_code,
      unitNo: row.unit_no,
      productAxisNo: row.customer_axis_no,
      materialCode: row.material_code,
      quantity: row.quantity,
    }))
  }
}

// ---------------- 组装 ----------------

export interface PgReworkRepositories {
  reelSplits: PgReelSplitRepository
  palletTasks: PgPalletTaskRepository
  axisNo: PgAxisNoRepository
  retires: PgAxisRetireRepository
  facts: PgReworkFactsLookup
}

export function createPgReworkRepositories(client: SqlClient): PgReworkRepositories {
  return {
    reelSplits: new PgReelSplitRepository(client),
    palletTasks: new PgPalletTaskRepository(client),
    axisNo: new PgAxisNoRepository(client),
    retires: new PgAxisRetireRepository(client),
    facts: new PgReworkFactsLookup(client),
  }
}
