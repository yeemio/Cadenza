// [L0-整合标记] 跨包类型导入（type-only，编译期擦除）：application 包名入口（src/index.ts，
// 共享文件不改动）未导出 maintenance 面，暂走 dist 相对（构建顺序由 workspace 拓扑保证）；
// L0 整合步把端口并入各包 index 后改包名导入（同 reporting-repositories 先例）。
import type {
  DowntimeEventFilter,
  DowntimeEventRepository,
  EquipmentStartRecordRepository,
  InspectionRoundFilter,
  InspectionRoundRepository,
  MaintenanceOrderFilter,
  MaintenanceOrderPatch,
  MaintenanceOrderRepository,
  MaintenancePlanFilter,
  MaintenancePlanRepository,
  CapacityOutboxPort,
  SparePartUsageRepository,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

/**
 * maintenance 域仓储的 PostgreSQL 实现（implements application 端口；0015 六表 +
 * 0003 设备档案/状态流水经既有 PgEquipmentRepository 组合、0001 outbox 窄端口）。
 *
 * - maintenance_order 状态推进为条件 UPDATE（WHERE status = 旧值）：并发竞态下
 *   迁移守卫（MT-07）与库层条件更新双保险；
 * - downtime_event 区间不重叠由 0015 exclusion 约束兜底（应用层 MT-09 守卫先行）；
 * - 备件库存扣减（MT-11 修复 2026-10）不再在本包实现等价服务——application 层
 *   maintenance-handlers 直用 inventory-posting 内核 writeLine/closeUnitIfZero 走
 *   inventory-repositories 的 inv 仓储束（IT-18 唯一记账方：流水＋分录＋余额＋
 *   零余额关闭同一记账序；IT-14 质量∧预留可用量）。
 */

interface OrderRow {
  id: string
  enterprise_id: string
  plant_id: string
  equipment_id: string
  order_no: string
  source: 'web_manual' | 'anomaly_report'
  status: 'reported' | 'dispatched' | 'in_progress' | 'pending_restart' | 'closed' | 'cancelled'
  description: string | null
  reporter: string
  dispatcher: string | null
  assignee: string | null
  result: string | null
  responsible: string | null
  cancel_reason: string | null
  closed_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

/** pg date 列按本地时区零点解析：取本地日期分量（东八区 toISOString 会回退一天）。 */
function dateStr(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(value).slice(0, 10)
}

function mapOrder(row: OrderRow) {
  return {
    id: row.id,
    enterpriseId: row.enterprise_id,
    plantId: row.plant_id,
    equipmentId: row.equipment_id,
    orderNo: row.order_no,
    source: row.source,
    status: row.status,
    description: row.description,
    reporter: row.reporter,
    dispatcher: row.dispatcher,
    assignee: row.assignee,
    result: row.result,
    responsible: row.responsible,
    cancelReason: row.cancel_reason,
    closedAt: isoOrNull(row.closed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

// ---------------- 维修工单 ----------------

export class PgMaintenanceOrderRepository implements MaintenanceOrderRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(order: {
    enterpriseId: string
    plantId: string
    equipmentId: string
    orderNo: string
    source: 'web_manual' | 'anomaly_report'
    description: string | null
    reporter: string
  }) {
    const r = await this.client.query(
      `INSERT INTO maintenance_order (enterprise_id, plant_id, equipment_id, order_no, source, status,
         description, reporter, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'reported', $6, $7, $7, $7)
       RETURNING id, enterprise_id, plant_id, equipment_id, order_no, source, status, description,
         reporter, dispatcher, assignee, result, responsible, cancel_reason, closed_at, created_at, updated_at`,
      [
        order.enterpriseId,
        order.plantId,
        order.equipmentId,
        order.orderNo,
        order.source,
        order.description,
        order.reporter,
      ],
    )
    return mapOrder(r.rows[0] as OrderRow)
  }

  async findById(id: string) {
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, equipment_id, order_no, source, status, description,
         reporter, dispatcher, assignee, result, responsible, cancel_reason, closed_at, created_at, updated_at
       FROM maintenance_order WHERE id = $1`,
      [id],
    )
    return r.rows.length === 0 ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async update(id: string, patch: MaintenanceOrderPatch, actor: string | null) {
    const sets: string[] = ['updated_at = now()']
    const values: unknown[] = [id]
    const add = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch.status !== undefined) add('status', patch.status)
    if (patch.dispatcher !== undefined) add('dispatcher', patch.dispatcher)
    if (patch.assignee !== undefined) add('assignee', patch.assignee)
    if (patch.result !== undefined) add('result', patch.result)
    if (patch.responsible !== undefined) add('responsible', patch.responsible)
    if (patch.cancelReason !== undefined) add('cancel_reason', patch.cancelReason)
    if (patch.closedAt !== undefined) add('closed_at', patch.closedAt)
    if (actor !== null) add('updated_by', actor)
    const r = await this.client.query(
      `UPDATE maintenance_order SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, enterprise_id, plant_id, equipment_id, order_no, source, status, description,
         reporter, dispatcher, assignee, result, responsible, cancel_reason, closed_at, created_at, updated_at`,
      values,
    )
    return r.rows.length === 0 ? null : mapOrder(r.rows[0] as OrderRow)
  }

  async list(filter: MaintenanceOrderFilter) {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return []
      values.push(filter.plantIds)
      where.push(`plant_id = ANY($${values.length}::uuid[])`)
    }
    if (filter.equipmentId !== undefined) {
      values.push(filter.equipmentId)
      where.push(`equipment_id = $${values.length}`)
    }
    if (filter.status !== undefined) {
      values.push(filter.status)
      where.push(`status = $${values.length}`)
    }
    values.push(filter.limit ?? 20, filter.offset ?? 0)
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, equipment_id, order_no, source, status, description,
         reporter, dispatcher, assignee, result, responsible, cancel_reason, closed_at, created_at, updated_at
       FROM maintenance_order ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return r.rows.map((row) => mapOrder(row as OrderRow))
  }
}

// ---------------- 停机事件 ----------------

interface DowntimeRow {
  id: string
  enterprise_id: string
  plant_id: string
  equipment_id: string
  order_id: string | null
  start_at: Date | string
  end_at: Date | string | null
  reason: string
  created_at: Date | string
}

export class PgDowntimeEventRepository implements DowntimeEventRepository {
  constructor(private readonly client: SqlClient) {}

  private mapRow(row: DowntimeRow) {
    return {
      id: row.id,
      enterpriseId: row.enterprise_id,
      plantId: row.plant_id,
      equipmentId: row.equipment_id,
      orderId: row.order_id,
      startAt: iso(row.start_at),
      endAt: isoOrNull(row.end_at),
      reason: row.reason,
      createdAt: iso(row.created_at),
    }
  }

  private readonly columns = `id, enterprise_id, plant_id, equipment_id, order_id, start_at, end_at, reason, created_at`

  async open(event: {
    enterpriseId: string
    plantId: string
    equipmentId: string
    orderId: string | null
    startAt: Date
    reason: string
  }) {
    const r = await this.client.query(
      `INSERT INTO downtime_event (enterprise_id, plant_id, equipment_id, order_id, start_at, end_at, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7) RETURNING ${this.columns}`,
      [event.enterpriseId, event.plantId, event.equipmentId, event.orderId, event.startAt, event.reason, 'maintenance'],
    )
    return this.mapRow(r.rows[0] as DowntimeRow)
  }

  async close(id: string, endAt: Date) {
    const r = await this.client.query(
      `UPDATE downtime_event SET end_at = $2, updated_at = now(), updated_by = 'maintenance'
       WHERE id = $1 AND end_at IS NULL RETURNING ${this.columns}`,
      [id, endAt],
    )
    if (r.rows.length === 0) throw new Error(`[MT-09] 停机事件不存在或已闭口（id=${id}）`)
    return this.mapRow(r.rows[0] as DowntimeRow)
  }

  async findById(id: string) {
    const r = await this.client.query(`SELECT ${this.columns} FROM downtime_event WHERE id = $1`, [id])
    return r.rows.length === 0 ? null : this.mapRow(r.rows[0] as DowntimeRow)
  }

  async findOpenByEquipment(equipmentId: string) {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM downtime_event WHERE equipment_id = $1 AND end_at IS NULL ORDER BY start_at`,
      [equipmentId],
    )
    return r.rows.map((row) => this.mapRow(row as DowntimeRow))
  }

  async findOpenByOrder(orderId: string) {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM downtime_event WHERE order_id = $1 AND end_at IS NULL ORDER BY start_at`,
      [orderId],
    )
    return r.rows.map((row) => this.mapRow(row as DowntimeRow))
  }

  async list(filter: DowntimeEventFilter) {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return []
      values.push(filter.plantIds)
      where.push(`plant_id = ANY($${values.length}::uuid[])`)
    }
    if (filter.equipmentId !== undefined) {
      values.push(filter.equipmentId)
      where.push(`equipment_id = $${values.length}`)
    }
    if (filter.orderId !== undefined) {
      values.push(filter.orderId)
      where.push(`order_id = $${values.length}`)
    }
    if (filter.openOnly === true) where.push('end_at IS NULL')
    values.push(filter.limit ?? 20, filter.offset ?? 0)
    const r = await this.client.query(
      `SELECT ${this.columns} FROM downtime_event ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY start_at DESC, id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return r.rows.map((row) => this.mapRow(row as DowntimeRow))
  }
}

// ---------------- 备件消耗 + 库存扣减等价服务（MT-11；收编请求列交付记录 §7） ----------------

export class PgSparePartUsageRepository implements SparePartUsageRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(usage: {
    enterpriseId: string
    plantId: string
    orderId: string
    unitId: string
    balanceId: string | null
    stockTransactionId: string
    quantity: string
    beforeQuantity: string
    afterQuantity: string
    uomId: string
    uomCode: string
  }) {
    const r = await this.client.query(
      `INSERT INTO spare_part_usage (enterprise_id, plant_id, order_id, unit_id, unit_no, material_code,
         balance_id, stock_transaction_id, quantity, before_quantity, after_quantity, uom_id, uom_code, created_by)
       VALUES ($1, $2, $3, $4,
         (SELECT unit_no FROM inventory_unit WHERE id = $4),
         (SELECT material_code FROM inventory_unit WHERE id = $4),
         $5, $6, $7::numeric, $8::numeric, $9::numeric, $10, $11, 'maintenance')
       RETURNING id, enterprise_id, plant_id, order_id, unit_id, unit_no, material_code, balance_id,
         stock_transaction_id, quantity::text AS quantity, before_quantity::text AS before_quantity,
         after_quantity::text AS after_quantity, uom_id, uom_code, created_at`,
      [
        usage.enterpriseId,
        usage.plantId,
        usage.orderId,
        usage.unitId,
        usage.balanceId,
        usage.stockTransactionId,
        usage.quantity,
        usage.beforeQuantity,
        usage.afterQuantity,
        usage.uomId,
        usage.uomCode,
      ],
    )
    const row = r.rows[0] as {
      id: string
      enterprise_id: string
      plant_id: string
      order_id: string
      unit_id: string
      unit_no: string | null
      material_code: string | null
      balance_id: string | null
      stock_transaction_id: string
      quantity: string
      before_quantity: string
      after_quantity: string
      uom_id: string
      uom_code: string
      created_at: Date | string
    }
    return {
      id: row.id,
      enterpriseId: row.enterprise_id,
      plantId: row.plant_id,
      orderId: row.order_id,
      unitId: row.unit_id,
      unitNo: row.unit_no,
      materialCode: row.material_code,
      balanceId: row.balance_id,
      stockTransactionId: row.stock_transaction_id,
      quantity: row.quantity,
      beforeQuantity: row.before_quantity,
      afterQuantity: row.after_quantity,
      uomId: row.uom_id,
      uomCode: row.uom_code,
      createdAt: iso(row.created_at),
    }
  }

  async listByOrder(orderId: string) {
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, order_id, unit_id, unit_no, material_code, balance_id,
         stock_transaction_id, quantity::text AS quantity, before_quantity::text AS before_quantity,
         after_quantity::text AS after_quantity, uom_id, uom_code, created_at
       FROM spare_part_usage WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId],
    )
    return r.rows.map(
      (row: {
        id: string
        enterprise_id: string
        plant_id: string
        order_id: string
        unit_id: string
        unit_no: string | null
        material_code: string | null
        balance_id: string | null
        stock_transaction_id: string
        quantity: string
        before_quantity: string
        after_quantity: string
        uom_id: string
        uom_code: string
        created_at: Date | string
      }) => ({
        id: row.id,
        enterpriseId: row.enterprise_id,
        plantId: row.plant_id,
        orderId: row.order_id,
        unitId: row.unit_id,
        unitNo: row.unit_no,
        materialCode: row.material_code,
        balanceId: row.balance_id,
        stockTransactionId: row.stock_transaction_id,
        quantity: row.quantity,
        beforeQuantity: row.before_quantity,
        afterQuantity: row.after_quantity,
        uomId: row.uom_id,
        uomCode: row.uom_code,
        createdAt: iso(row.created_at),
      }),
    )
  }
}

// ---------------- 点检/保养计划 ----------------

interface PlanRow {
  id: string
  enterprise_id: string
  plant_id: string
  equipment_id: string
  plan_key: string
  version: number
  kind: 'inspection' | 'maintenance'
  cycle: { everyDays?: unknown }
  check_items: unknown
  effective_from: Date | string
  effective_to: Date | string | null
  status: 'active' | 'retired'
  description: string | null
  created_at: Date | string
}

export class PgMaintenancePlanRepository implements MaintenancePlanRepository {
  constructor(private readonly client: SqlClient) {}

  private mapRow(row: PlanRow) {
    const items = Array.isArray(row.check_items) ? (row.check_items as unknown[]) : []
    return {
      id: row.id,
      enterpriseId: row.enterprise_id,
      plantId: row.plant_id,
      equipmentId: row.equipment_id,
      planKey: row.plan_key,
      version: row.version,
      kind: row.kind,
      cycle: { everyDays: Number(row.cycle?.everyDays ?? 1) },
      checkItems: items.filter((item): item is string => typeof item === 'string'),
      effectiveFrom: dateStr(row.effective_from) ?? '',
      effectiveTo: dateStr(row.effective_to),
      status: row.status,
      description: row.description,
      createdAt: iso(row.created_at),
    }
  }

  private readonly columns = `id, enterprise_id, plant_id, equipment_id, plan_key, version, kind, cycle,
    check_items, effective_from, effective_to, status, description, created_at`

  async insertVersion(plan: {
    enterpriseId: string
    plantId: string
    equipmentId: string
    planKey: string
    version: number
    kind: 'inspection' | 'maintenance'
    cycle: { everyDays: number }
    checkItems: string[]
    effectiveFrom: string
    effectiveTo: string | null
    description: string | null
  }) {
    const r = await this.client.query(
      `INSERT INTO maintenance_plan (enterprise_id, plant_id, equipment_id, plan_key, version, kind,
         cycle, check_items, effective_from, effective_to, description, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::date, $10::date, $11, 'maintenance', 'maintenance')
       RETURNING ${this.columns}`,
      [
        plan.enterpriseId,
        plan.plantId,
        plan.equipmentId,
        plan.planKey,
        plan.version,
        plan.kind,
        JSON.stringify(plan.cycle),
        JSON.stringify(plan.checkItems),
        plan.effectiveFrom,
        plan.effectiveTo,
        plan.description,
      ],
    )
    return this.mapRow(r.rows[0] as PlanRow)
  }

  async findByKeyAndVersion(planKey: string, version: number) {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM maintenance_plan WHERE plan_key = $1 AND version = $2`,
      [planKey, version],
    )
    return r.rows.length === 0 ? null : this.mapRow(r.rows[0] as PlanRow)
  }

  async listVersionsByKey(planKey: string) {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM maintenance_plan WHERE plan_key = $1 ORDER BY version`,
      [planKey],
    )
    return r.rows.map((row) => this.mapRow(row as PlanRow))
  }

  async maxVersionByKey(planKey: string) {
    const r = await this.client.query(
      `SELECT max(version) AS max FROM maintenance_plan WHERE plan_key = $1`,
      [planKey],
    )
    return ((r.rows[0] as { max: number | null } | undefined)?.max ?? 0) as number
  }

  async list(filter: MaintenancePlanFilter) {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return []
      values.push(filter.plantIds)
      where.push(`plant_id = ANY($${values.length}::uuid[])`)
    }
    if (filter.equipmentId !== undefined) {
      values.push(filter.equipmentId)
      where.push(`equipment_id = $${values.length}`)
    }
    if (filter.kind !== undefined) {
      values.push(filter.kind)
      where.push(`kind = $${values.length}`)
    }
    const r = await this.client.query(
      `SELECT ${this.columns} FROM maintenance_plan ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY plan_key, version`,
      values,
    )
    return r.rows.map((row) => this.mapRow(row as PlanRow))
  }
}

// ---------------- 点检/保养执行轮次 ----------------

export class PgInspectionRoundRepository implements InspectionRoundRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(round: {
    enterpriseId: string
    plantId: string
    planId: string
    planKey: string
    planVersion: number
    equipmentId: string
    executedAt: Date
    shiftDate: string
    result: 'pass' | 'fail'
    anomalyNote: string | null
    performedBy: string
    orderId: string | null
  }) {
    const r = await this.client.query(
      `INSERT INTO inspection_round (enterprise_id, plant_id, plan_id, plan_key, plan_version, equipment_id,
         executed_at, shift_date, result, anomaly_note, performed_by, order_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, 'maintenance')
       RETURNING id, enterprise_id, plant_id, plan_id, plan_key, plan_version, equipment_id,
         executed_at, shift_date, result, anomaly_note, performed_by, order_id, created_at`,
      [
        round.enterpriseId,
        round.plantId,
        round.planId,
        round.planKey,
        round.planVersion,
        round.equipmentId,
        round.executedAt,
        round.shiftDate,
        round.result,
        round.anomalyNote,
        round.performedBy,
        round.orderId,
      ],
    )
    return this.mapRound(r.rows[0])
  }

  private mapRound(row: Record<string, unknown>) {
    return {
      id: row['id'] as string,
      enterpriseId: row['enterprise_id'] as string,
      plantId: row['plant_id'] as string,
      planId: row['plan_id'] as string,
      planKey: row['plan_key'] as string,
      planVersion: row['plan_version'] as number,
      equipmentId: row['equipment_id'] as string,
      executedAt: iso(row['executed_at'] as Date | string),
      shiftDate: dateStr(row['shift_date'] as Date | string) ?? '',
      result: row['result'] as 'pass' | 'fail',
      anomalyNote: (row['anomaly_note'] as string | null) ?? null,
      performedBy: row['performed_by'] as string,
      orderId: (row['order_id'] as string | null) ?? null,
      createdAt: iso(row['created_at'] as Date | string),
    }
  }

  async list(filter: InspectionRoundFilter) {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return []
      values.push(filter.plantIds)
      where.push(`plant_id = ANY($${values.length}::uuid[])`)
    }
    if (filter.planKey !== undefined) {
      values.push(filter.planKey)
      where.push(`plan_key = $${values.length}`)
    }
    if (filter.equipmentId !== undefined) {
      values.push(filter.equipmentId)
      where.push(`equipment_id = $${values.length}`)
    }
    if (filter.result !== undefined) {
      values.push(filter.result)
      where.push(`result = $${values.length}`)
    }
    values.push(filter.limit ?? 20, filter.offset ?? 0)
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, plan_id, plan_key, plan_version, equipment_id,
         executed_at, shift_date, result, anomaly_note, performed_by, order_id, created_at
       FROM inspection_round ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY executed_at DESC, id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return r.rows.map((row) => this.mapRound(row as Record<string, unknown>))
  }

  async lastShiftDateByPlan(planKey: string) {
    const r = await this.client.query(
      `SELECT shift_date FROM inspection_round WHERE plan_key = $1 ORDER BY executed_at DESC, id LIMIT 1`,
      [planKey],
    )
    const row = r.rows[0] as { shift_date: Date | string } | undefined
    return row === undefined ? null : dateStr(row.shift_date)
  }
}

// ---------------- 设备开工记录 ----------------

export class PgEquipmentStartRecordRepository implements EquipmentStartRecordRepository {
  constructor(private readonly client: SqlClient) {}

  async upsertStart(input: {
    enterpriseId: string
    plantId: string
    equipmentId: string
    businessDate: string
    startedAt: Date
    source: 'WEB' | 'PDA'
    actor: string
  }) {
    // (equipment, 业务日) 唯一：重复开工更新 started_at（MT-05/06/MT-S5）
    const existing = await this.client.query(`SELECT id FROM equipment_start_record
      WHERE equipment_id = $1 AND business_date = $2::date FOR UPDATE`,
      [input.equipmentId, input.businessDate])
    if (existing.rows.length > 0) {
      const r = await this.client.query(
        `UPDATE equipment_start_record SET started_at = $3, source = $4, actor = $5,
           updated_at = now(), updated_by = $5
         WHERE id = $1 AND equipment_id = $2
         RETURNING id, enterprise_id, plant_id, equipment_id, business_date, started_at, source, actor, created_at, updated_at`,
        [(existing.rows[0] as { id: string }).id, input.equipmentId, input.startedAt, input.source, input.actor],
      )
      return { record: this.mapRow(r.rows[0]), updated: true }
    }
    const r = await this.client.query(
      `INSERT INTO equipment_start_record (enterprise_id, plant_id, equipment_id, business_date, started_at,
         source, actor, created_by, updated_by)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $7, $7)
       RETURNING id, enterprise_id, plant_id, equipment_id, business_date, started_at, source, actor, created_at, updated_at`,
      [input.enterpriseId, input.plantId, input.equipmentId, input.businessDate, input.startedAt, input.source, input.actor],
    )
    return { record: this.mapRow(r.rows[0]), updated: false }
  }

  private mapRow(row: Record<string, unknown>) {
    return {
      id: row['id'] as string,
      enterpriseId: row['enterprise_id'] as string,
      plantId: row['plant_id'] as string,
      equipmentId: row['equipment_id'] as string,
      businessDate: dateStr(row['business_date'] as Date | string) ?? '',
      startedAt: iso(row['started_at'] as Date | string),
      source: row['source'] as 'WEB' | 'PDA',
      actor: row['actor'] as string,
      createdAt: iso(row['created_at'] as Date | string),
      updatedAt: iso(row['updated_at'] as Date | string),
    }
  }

  async list(filter: {
    plantIds: string[] | null
    equipmentId?: string
    businessDate?: string
    limit?: number
    offset?: number
  }) {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return []
      values.push(filter.plantIds)
      where.push(`plant_id = ANY($${values.length}::uuid[])`)
    }
    if (filter.equipmentId !== undefined) {
      values.push(filter.equipmentId)
      where.push(`equipment_id = $${values.length}`)
    }
    if (filter.businessDate !== undefined) {
      values.push(filter.businessDate)
      where.push(`business_date = $${values.length}::date`)
    }
    values.push(filter.limit ?? 20, filter.offset ?? 0)
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, equipment_id, business_date, started_at, source, actor, created_at, updated_at
       FROM equipment_start_record ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY business_date DESC, started_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return r.rows.map((row) => this.mapRow(row as Record<string, unknown>))
  }
}

// ---------------- Outbox 能力变化事件（0001 窄端口） ----------------

export class PgCapacityOutbox implements CapacityOutboxPort {
  constructor(private readonly client: SqlClient) {}

  async insert(intent: { aggregateType: string; aggregateId: string; taskKind: string; payload: object }) {
    const r = await this.client.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload)
       VALUES ($1, $2, $3, 'PENDING', $4::jsonb) RETURNING event_id`,
      [intent.aggregateType, intent.aggregateId, intent.taskKind, JSON.stringify(intent.payload)],
    )
    return (r.rows[0] as { event_id: string }).event_id
  }

  async listCapacityEvents(filter: { plantId?: string; orderId?: string; equipmentId?: string; limit?: number }) {
    const r = await this.client.query(
      `SELECT event_id, aggregate_id, status, payload, created_at
       FROM outbox
       WHERE task_kind = 'maintenance.capacity-change'
         AND ($1::uuid IS NULL OR (payload->>'plantId')::uuid = $1::uuid)
         AND ($2::text IS NULL OR aggregate_id = $2)
         AND ($3::uuid IS NULL OR (payload->>'equipmentId')::uuid = $3::uuid)
       ORDER BY created_at DESC
       LIMIT $4`,
      [filter.plantId ?? null, filter.orderId ?? null, filter.equipmentId ?? null, Math.min(filter.limit ?? 50, 200)],
    )
    return r.rows.map(
      (row: { event_id: string; aggregate_id: string; status: string; payload: Record<string, unknown>; created_at: Date | string }) => ({
        eventId: row.event_id,
        aggregateId: row.aggregate_id,
        status: row.status,
        payload: row.payload,
        createdAt: iso(row.created_at),
      }),
    )
  }
}

// ---------------- 装配 ----------------

/** 命令事务内仓储束（implements application maintenance 端口；备件扣减走 inventory 内核，无 stock 端口）。 */
export function createMaintenanceCommandRepositories(client: SqlClient) {
  return {
    orders: new PgMaintenanceOrderRepository(client),
    downtime: new PgDowntimeEventRepository(client),
    usages: new PgSparePartUsageRepository(client),
    plans: new PgMaintenancePlanRepository(client),
    rounds: new PgInspectionRoundRepository(client),
    starts: new PgEquipmentStartRecordRepository(client),
    outbox: new PgCapacityOutbox(client),
  }
}
