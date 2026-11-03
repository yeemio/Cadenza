import type { PageResult } from '@cadenza/contracts'
import type { SqlClient } from './sql-client'
// L0 整合步（Wave5）：application index 已导出 scheduling 面；改包名导入（原 dist 相对导入删除）。
import type {
  CapacityCalendarRecord,
  EquipmentLookup,
  NewCapacityCalendar,
  NewScheduleSlot,
  NewShiftParameter,
  ScheduleSlotRecord,
  SchedulingLookups,
  SchedulingOrderLookup,
  SchedulingOrderOperationLookup,
  SchedulingRepositories,
  SchedulingSlotViewRow,
  SchedulingWorkCenterLookup,
  ShiftParameterRecord,
  SlotIdentityKey,
} from '@cadenza/application'

/**
 * scheduling 域仓储的 PostgreSQL 实现（对应 0007 迁移三表；端口接口见
 * application/src/scheduling-repositories.ts）。
 * 全部参数化查询；numeric 出参规范化为十进制字符串（去尾零）；
 * date 出参以 ::text 直取 YYYY-MM-DD（不做时区换算）；time 出参取 HH:MM。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** numeric 列出参规范化："3060.0000" → "3060"；"1.0200" → "1.02"。 */
function dec(value: string | number | null): string | null {
  if (value === null) return null
  const text = String(value)
  if (!text.includes('.')) return text
  return text.replace(/0+$/, '').replace(/\.$/, '')
}

// ---------------- 排产槽位 ----------------

interface SlotRow {
  id: string
  enterprise_id: string
  plant_id: string
  order_id: string
  order_operation_id: string
  operation_definition_id: string
  equipment_id: string
  production_date: string
  planned_qty: string | number
  uom: string
  remark: string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

const SLOT_COLUMNS = `id, enterprise_id, plant_id, order_id, order_operation_id, operation_definition_id,
  equipment_id, production_date::text AS production_date, planned_qty, uom, remark,
  created_at, created_by, updated_at, updated_by`

function mapSlot(r: SlotRow): ScheduleSlotRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    orderId: r.order_id,
    orderOperationId: r.order_operation_id,
    operationDefinitionId: r.operation_definition_id,
    equipmentId: r.equipment_id,
    productionDate: r.production_date,
    plannedQty: dec(r.planned_qty)!,
    uom: r.uom,
    remark: r.remark,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

/** 槽位唯一键条件（[底稿 A3-1] 五元组）；startIndex 为第一个键参数的占位符位置。 */
function identityWhere(startIndex: number, alias = ''): string {
  const p = alias === '' ? '' : `${alias}.`
  return `${p}order_id = $${startIndex} AND ${p}order_operation_id = $${startIndex + 1}
    AND ${p}operation_definition_id = $${startIndex + 2}
    AND ${p}equipment_id = $${startIndex + 3} AND ${p}production_date = $${startIndex + 4}`
}

function identityValues(identity: SlotIdentityKey): unknown[] {
  return [
    identity.orderId,
    identity.orderOperationId,
    identity.operationDefinitionId,
    identity.equipmentId,
    identity.productionDate,
  ]
}

export class PgScheduleSlotRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<ScheduleSlotRecord | null> {
    const r = await this.client.query(
      `SELECT ${SLOT_COLUMNS} FROM schedule_slot WHERE id = $1`,
      [id],
    )
    return r.rows[0] ? mapSlot(r.rows[0] as SlotRow) : null
  }

  async findSlot(identity: SlotIdentityKey): Promise<ScheduleSlotRecord | null> {
    const r = await this.client.query(
      `SELECT ${SLOT_COLUMNS} FROM schedule_slot WHERE ${identityWhere(1)}`,
      identityValues(identity),
    )
    return r.rows[0] ? mapSlot(r.rows[0] as SlotRow) : null
  }

  /** 同键替换 upsert（[底稿 A3-1]；命令层 planSlotSave 决策后才到达此处）。 */
  async upsert(slot: NewScheduleSlot): Promise<ScheduleSlotRecord> {
    const r = await this.client.query(
      `INSERT INTO schedule_slot (id, enterprise_id, plant_id, order_id, order_operation_id,
         operation_definition_id, equipment_id, production_date, planned_qty, uom, remark, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (order_id, order_operation_id, operation_definition_id, equipment_id, production_date)
       DO UPDATE SET planned_qty = EXCLUDED.planned_qty, uom = EXCLUDED.uom, remark = EXCLUDED.remark,
         updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING ${SLOT_COLUMNS}`,
      [
        slot.id ?? null,
        slot.enterpriseId,
        slot.plantId,
        slot.orderId,
        slot.orderOperationId,
        slot.operationDefinitionId,
        slot.equipmentId,
        slot.productionDate,
        slot.plannedQty,
        slot.uom,
        slot.remark ?? null,
        slot.createdBy ?? null,
      ],
    )
    return mapSlot(r.rows[0] as SlotRow)
  }

  async deleteSlot(identity: SlotIdentityKey): Promise<boolean> {
    const r = await this.client.query(
      `DELETE FROM schedule_slot WHERE ${identityWhere(1)}`,
      identityValues(identity),
    )
    return (r.rowCount ?? 0) > 0
  }

  async listByOrder(orderId: string): Promise<ScheduleSlotRecord[]> {
    const r = await this.client.query(
      `SELECT ${SLOT_COLUMNS} FROM schedule_slot WHERE order_id = $1
       ORDER BY production_date, equipment_id`,
      [orderId],
    )
    return r.rows.map((row) => mapSlot(row as SlotRow))
  }

  async listByOrderOperation(orderOperationId: string): Promise<ScheduleSlotRecord[]> {
    const r = await this.client.query(
      `SELECT ${SLOT_COLUMNS} FROM schedule_slot WHERE order_operation_id = $1
       ORDER BY production_date, equipment_id`,
      [orderOperationId],
    )
    return r.rows.map((row) => mapSlot(row as SlotRow))
  }

  async sumPlannedByEquipmentAndDate(
    equipmentId: string,
    productionDate: string,
    excludeIdentity?: SlotIdentityKey,
  ): Promise<string> {
    if (excludeIdentity === undefined) {
      const r = await this.client.query(
        `SELECT sum(planned_qty)::text AS total FROM schedule_slot
         WHERE equipment_id = $1 AND production_date = $2`,
        [equipmentId, productionDate],
      )
      const total = (r.rows[0] as { total: string | null } | undefined)?.total
      return total ? dec(total)! : '0'
    }
    // 排除本槽旧值（[底稿 A3-2w] 本槽位按替换旧值计）
    const r = await this.client.query(
      `SELECT sum(planned_qty)::text AS total FROM schedule_slot
       WHERE equipment_id = $1 AND production_date = $2
         AND NOT (${identityWhere(3)})`,
      [equipmentId, productionDate, ...identityValues(excludeIdentity)],
    )
    const total = (r.rows[0] as { total: string | null } | undefined)?.total
    return total ? dec(total)! : '0'
  }

  /** 富行查询（三投影共用行源；[底稿 A3-5] includeFinishedOrders=false 排除已结束/已作废订单）。 */
  async listViewRows(filter: {
    plantIds: string[] | null
    workCenterId?: string
    equipmentId?: string
    orderId?: string
    dates?: string[]
    dateFrom?: string
    dateTo?: string
    includeFinishedOrders?: boolean
  }): Promise<SchedulingSlotViewRow[]> {
    const conditions: string[] = []
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return []
      values.push(filter.plantIds)
      conditions.push(`s.plant_id = ANY($${values.length})`)
    }
    if (filter.workCenterId !== undefined) {
      values.push(filter.workCenterId)
      conditions.push(`e.work_center_id = $${values.length}`)
    }
    if (filter.equipmentId !== undefined) {
      values.push(filter.equipmentId)
      conditions.push(`s.equipment_id = $${values.length}`)
    }
    if (filter.orderId !== undefined) {
      values.push(filter.orderId)
      conditions.push(`s.order_id = $${values.length}`)
    }
    if (filter.dates !== undefined) {
      values.push(filter.dates)
      conditions.push(`s.production_date = ANY($${values.length}::date[])`)
    }
    if (filter.dateFrom !== undefined) {
      values.push(filter.dateFrom)
      conditions.push(`s.production_date >= $${values.length}`)
    }
    if (filter.dateTo !== undefined) {
      values.push(filter.dateTo)
      conditions.push(`s.production_date <= $${values.length}`)
    }
    if (filter.includeFinishedOrders !== true) {
      conditions.push(`o.order_status NOT IN ('closed','voided')`)
    }
    const r = await this.client.query(
      `SELECT s.id AS slot_id, s.plant_id, s.order_id, o.order_no, o.sales_order_no, o.order_status,
         oo.id AS order_operation_id, oo.seq, oo.operation_definition_id, oo.operation_name,
         oo.offline_qty, e.id AS equipment_id, e.code AS equipment_code, e.name AS equipment_name,
         e.equipment_status, e.work_center_id,
         s.production_date::text AS production_date, s.planned_qty, s.uom, s.remark,
         o.material_snapshot
       FROM schedule_slot s
       JOIN production_order o ON o.id = s.order_id
       JOIN order_operation oo ON oo.id = s.order_operation_id
       JOIN equipment e ON e.id = s.equipment_id
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY s.production_date, e.code, o.order_no`,
      values,
    )
    return r.rows.map((row) => {
      const r2 = row as {
        slot_id: string
        plant_id: string
        order_id: string
        order_no: string
        sales_order_no: string | null
        order_status: SchedulingSlotViewRow['orderStatus']
        order_operation_id: string
        seq: number
        operation_definition_id: string
        operation_name: string
        offline_qty: string | number
        equipment_id: string
        equipment_code: string
        equipment_name: string
        equipment_status: number
        work_center_id: string
        production_date: string
        planned_qty: string | number
        uom: string
        remark: string | null
        material_snapshot: Record<string, unknown> | null
      }
      return {
        slotId: r2.slot_id,
        plantId: r2.plant_id,
        orderId: r2.order_id,
        orderNo: r2.order_no,
        salesOrderNo: r2.sales_order_no,
        orderStatus: r2.order_status,
        orderOperationId: r2.order_operation_id,
        seq: r2.seq,
        operationDefinitionId: r2.operation_definition_id,
        operationName: r2.operation_name,
        offlineQty: dec(r2.offline_qty)!,
        equipmentId: r2.equipment_id,
        equipmentCode: r2.equipment_code,
        equipmentName: r2.equipment_name,
        equipmentStatus: r2.equipment_status,
        workCenterId: r2.work_center_id,
        productionDate: r2.production_date,
        plannedQty: dec(r2.planned_qty)!,
        uom: r2.uom,
        remark: r2.remark,
        materialSnapshot: r2.material_snapshot ?? {},
      }
    })
  }

  /** [底稿 A3-1/A1-3②] 标准工序被排产引用计数（排产真值接入位）。 */
  async countByOperationDefinition(operationDefinitionId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM schedule_slot WHERE operation_definition_id = $1`,
      [operationDefinitionId],
    )
    return (r.rows[0] as { n: number }).n
  }

  async countByEquipment(equipmentId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM schedule_slot WHERE equipment_id = $1`,
      [equipmentId],
    )
    return (r.rows[0] as { n: number }).n
  }

  async list(filter: {
    plantIds: string[] | null
    orderId?: string
    equipmentId?: string
    page: number
    pageSize: number
  }): Promise<PageResult<ScheduleSlotRecord>> {
    const conditions: string[] = []
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) {
        return { items: [], total: 0, page: filter.page, pageSize: filter.pageSize }
      }
      values.push(filter.plantIds)
      conditions.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.orderId !== undefined) {
      values.push(filter.orderId)
      conditions.push(`order_id = $${values.length}`)
    }
    if (filter.equipmentId !== undefined) {
      values.push(filter.equipmentId)
      conditions.push(`equipment_id = $${values.length}`)
    }
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${SLOT_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM schedule_slot ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY production_date, created_at
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapSlot(row as SlotRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

// ---------------- 设备日产能 ----------------

interface CapacityRow {
  id: string
  enterprise_id: string
  plant_id: string
  equipment_id: string
  production_date: string
  capacity: string | number
  uom: string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

const CAPACITY_COLUMNS = `id, enterprise_id, plant_id, equipment_id, production_date::text AS production_date,
  capacity, uom, created_at, created_by, updated_at, updated_by`

function mapCapacity(r: CapacityRow): CapacityCalendarRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    equipmentId: r.equipment_id,
    productionDate: r.production_date,
    capacity: dec(r.capacity)!,
    uom: r.uom,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgCapacityCalendarRepository {
  constructor(private readonly client: SqlClient) {}

  async findByEquipmentAndDate(
    equipmentId: string,
    productionDate: string,
  ): Promise<CapacityCalendarRecord | null> {
    const r = await this.client.query(
      `SELECT ${CAPACITY_COLUMNS} FROM capacity_calendar
       WHERE equipment_id = $1 AND production_date = $2`,
      [equipmentId, productionDate],
    )
    return r.rows[0] ? mapCapacity(r.rows[0] as CapacityRow) : null
  }

  async upsert(entry: NewCapacityCalendar): Promise<CapacityCalendarRecord> {
    const r = await this.client.query(
      `INSERT INTO capacity_calendar (id, enterprise_id, plant_id, equipment_id, production_date, capacity, uom, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (equipment_id, production_date)
       DO UPDATE SET capacity = EXCLUDED.capacity, uom = EXCLUDED.uom,
         updated_at = now(), updated_by = EXCLUDED.created_by
       RETURNING ${CAPACITY_COLUMNS}`,
      [
        entry.id ?? null,
        entry.enterpriseId,
        entry.plantId,
        entry.equipmentId,
        entry.productionDate,
        entry.capacity,
        entry.uom ?? null,
        entry.createdBy ?? null,
      ],
    )
    return mapCapacity(r.rows[0] as CapacityRow)
  }

  async deleteByEquipmentAndDate(equipmentId: string, productionDate: string): Promise<boolean> {
    const r = await this.client.query(
      `DELETE FROM capacity_calendar WHERE equipment_id = $1 AND production_date = $2`,
      [equipmentId, productionDate],
    )
    return (r.rowCount ?? 0) > 0
  }

  async list(filter: {
    plantIds: string[] | null
    equipmentId?: string
    page: number
    pageSize: number
  }): Promise<PageResult<CapacityCalendarRecord>> {
    const conditions: string[] = []
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) {
        return { items: [], total: 0, page: filter.page, pageSize: filter.pageSize }
      }
      values.push(filter.plantIds)
      conditions.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.equipmentId !== undefined) {
      values.push(filter.equipmentId)
      conditions.push(`equipment_id = $${values.length}`)
    }
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${CAPACITY_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM capacity_calendar ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY production_date, equipment_id
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapCapacity(row as CapacityRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

// ---------------- 班次参数 ----------------

interface ShiftRow {
  id: string
  enterprise_id: string
  plant_id: string
  day_shift_start: string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapShift(r: ShiftRow): ShiftParameterRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    // time 列以 HH:MM 口径出参（'08:00:00' → '08:00'）
    dayShiftStart: r.day_shift_start.slice(0, 5),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgShiftParameterRepository {
  constructor(private readonly client: SqlClient) {}

  async findByPlant(plantId: string): Promise<ShiftParameterRecord | null> {
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, day_shift_start::text AS day_shift_start,
         created_at, created_by, updated_at, updated_by
       FROM shift_parameter WHERE plant_id = $1`,
      [plantId],
    )
    return r.rows[0] ? mapShift(r.rows[0] as ShiftRow) : null
  }

  async upsert(entry: NewShiftParameter): Promise<ShiftParameterRecord> {
    const r = await this.client.query(
      `INSERT INTO shift_parameter (id, enterprise_id, plant_id, day_shift_start, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4::time, $5)
       ON CONFLICT (plant_id)
       DO UPDATE SET day_shift_start = EXCLUDED.day_shift_start,
         updated_at = now(), updated_by = EXCLUDED.created_by
       RETURNING id, enterprise_id, plant_id, day_shift_start::text AS day_shift_start,
         created_at, created_by, updated_at, updated_by`,
      [
        entry.id ?? null,
        entry.enterpriseId,
        entry.plantId,
        entry.dayShiftStart,
        entry.createdBy ?? null,
      ],
    )
    return mapShift(r.rows[0] as ShiftRow)
  }

  async list(filter: { plantIds: string[] | null }): Promise<ShiftParameterRecord[]> {
    const values: unknown[] = []
    const where = filter.plantIds !== null ? `WHERE plant_id = ANY($1)` : ''
    if (filter.plantIds !== null) values.push(filter.plantIds)
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, day_shift_start::text AS day_shift_start,
         created_at, created_by, updated_at, updated_by
       FROM shift_parameter ${where} ORDER BY plant_id`,
      values,
    )
    return r.rows.map((row) => mapShift(row as ShiftRow))
  }
}

// ---------------- 只读窄端口（0003 主数据 / 0005 工艺订单表） ----------------

export class PgSchedulingLookups implements SchedulingLookups {
  constructor(private readonly client: SqlClient) {}

  private equipmentColumns = `id, enterprise_id, plant_id, dept_id, work_center_id, code, name,
    equipment_status, status`

  private mapEquipment(row: {
    id: string
    enterprise_id: string
    plant_id: string
    dept_id: string
    work_center_id: string
    code: string
    name: string
    equipment_status: number
    status: 'active' | 'retired'
  }): EquipmentLookup {
    return {
      id: row.id,
      enterpriseId: row.enterprise_id,
      plantId: row.plant_id,
      deptId: row.dept_id,
      workCenterId: row.work_center_id,
      code: row.code,
      name: row.name,
      equipmentStatus: row.equipment_status,
      status: row.status,
    }
  }

  async findEquipment(id: string): Promise<EquipmentLookup | null> {
    const r = await this.client.query(
      `SELECT ${this.equipmentColumns} FROM equipment WHERE id = $1`,
      [id],
    )
    return r.rows[0] ? this.mapEquipment(r.rows[0]) : null
  }

  async listActiveEquipmentsByWorkCenter(workCenterId: string): Promise<EquipmentLookup[]> {
    const r = await this.client.query(
      `SELECT ${this.equipmentColumns} FROM equipment
       WHERE work_center_id = $1 AND status = 'active'
       ORDER BY code`,
      [workCenterId],
    )
    return r.rows.map((row) => this.mapEquipment(row))
  }

  async findWorkCenter(id: string): Promise<SchedulingWorkCenterLookup | null> {
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, dept_id, code, name, status
       FROM work_center WHERE id = $1`,
      [id],
    )
    const row = r.rows[0] as
      | {
          id: string
          enterprise_id: string
          plant_id: string
          dept_id: string
          code: string
          name: string
          status: 'active' | 'retired'
        }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      enterpriseId: row.enterprise_id,
      plantId: row.plant_id,
      deptId: row.dept_id,
      code: row.code,
      name: row.name,
      status: row.status,
    }
  }

  async listActiveWorkCentersByPlant(plantId: string): Promise<SchedulingWorkCenterLookup[]> {
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, dept_id, code, name, status
       FROM work_center WHERE plant_id = $1 AND status = 'active'
       ORDER BY code`,
      [plantId],
    )
    return r.rows.map(
      (row) =>
        ({
          id: row.id,
          enterpriseId: row.enterprise_id,
          plantId: row.plant_id,
          deptId: row.dept_id,
          code: row.code,
          name: row.name,
          status: row.status,
        }) as SchedulingWorkCenterLookup,
    )
  }

  async findOrder(id: string): Promise<SchedulingOrderLookup | null> {
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, order_no, order_status, process_config_status,
         production_qty, uom, current_settings_version, material_snapshot
       FROM production_order WHERE id = $1`,
      [id],
    )
    const row = r.rows[0] as
      | {
          id: string
          enterprise_id: string
          plant_id: string
          order_no: string
          order_status: SchedulingOrderLookup['orderStatus']
          process_config_status: SchedulingOrderLookup['processConfigStatus']
          production_qty: string | number
          uom: string
          current_settings_version: number
          material_snapshot: Record<string, unknown> | null
        }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      enterpriseId: row.enterprise_id,
      plantId: row.plant_id,
      orderNo: row.order_no,
      orderStatus: row.order_status,
      processConfigStatus: row.process_config_status,
      productionQty: dec(row.production_qty)!,
      uom: row.uom,
      currentSettingsVersion: row.current_settings_version,
      materialSnapshot: row.material_snapshot ?? {},
    }
  }

  async findOrderOperation(id: string): Promise<SchedulingOrderOperationLookup | null> {
    const r = await this.client.query(
      `SELECT id, order_id, plant_id, seq, settings_version, operation_definition_id,
         operation_name, operation_remark, offline_qty, work_center_id, uom
       FROM order_operation WHERE id = $1`,
      [id],
    )
    return this.mapOperation(r.rows[0])
  }

  async listOrderOperations(orderId: string): Promise<SchedulingOrderOperationLookup[]> {
    const r = await this.client.query(
      `SELECT id, order_id, plant_id, seq, settings_version, operation_definition_id,
         operation_name, operation_remark, offline_qty, work_center_id, uom
       FROM order_operation WHERE order_id = $1 ORDER BY seq`,
      [orderId],
    )
    return r.rows.map((row) => this.mapOperation(row)!).filter((op) => op !== null)
  }

  private mapOperation(
    row:
      | {
          id: string
          order_id: string
          plant_id: string
          seq: number
          settings_version: number
          operation_definition_id: string
          operation_name: string
          operation_remark: string | null
          offline_qty: string | number
          work_center_id: string
          uom: string
        }
      | undefined,
  ): SchedulingOrderOperationLookup | null {
    if (!row) return null
    return {
      id: row.id,
      orderId: row.order_id,
      plantId: row.plant_id,
      seq: row.seq,
      settingsVersion: row.settings_version,
      operationDefinitionId: row.operation_definition_id,
      operationName: row.operation_name,
      operationRemark: row.operation_remark,
      offlineQty: dec(row.offline_qty)!,
      workCenterId: row.work_center_id,
      uom: row.uom,
    }
  }
}

/** scheduling 仓储束（组合根装配用）。 */
export function createPgSchedulingRepositories(client: SqlClient): SchedulingRepositories {
  return {
    slots: new PgScheduleSlotRepository(client),
    capacities: new PgCapacityCalendarRepository(client),
    shifts: new PgShiftParameterRepository(client),
    lookups: new PgSchedulingLookups(client),
  }
}
