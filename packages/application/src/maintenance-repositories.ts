import type { InventoryCommandTools } from './inventory-repositories'
import type { EquipmentRecord, EquipmentRepository } from './masterdata-repositories'

/**
 * maintenance 域端口与命令工具集（T19 设备维护——点检/保养/维修工单/复机/备件）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p2/maintenance.md（MT-01~MT-15、MT-S1~S5）：
 * - 维修工单闭环：maintenance_order（MT-07/08/13/14）＋downtime_event（MT-09）；
 * - 备件消耗（MT-11）：spare_part_usage 关联 stock_transaction（IT-18 唯一记账方；
 *   MT-11 修复 2026-10：扣减直走 inventory-posting 内核 writeLine/closeUnitIfZero——
 *   含 stock_entry 分录、预留感知可用量（IT-14）与零余额关闭（IT-29），本域不再
 *   持有直写 stock_balance 的等价服务端口）；
 * - 点检/保养（MT-12）：maintenance_plan 版本化＋inspection_round 双存；
 * - 开工幂等（MT-05/06）：equipment_start_record (equipment, 业务日) 唯一；
 * - 能力变化事件（MT-10/15）：0001 outbox 窄端口（不直接改排程结果）。
 *
 * 设备档案与状态流水沿用 T04 端口（EquipmentRepository，MD-09~16 已冻结），本域不重建。
 */

// ---------------- 维修工单（MT-07/08/13/14/MT-S1） ----------------

export type MaintenanceOrderStatusValue =
  | 'reported'
  | 'dispatched'
  | 'in_progress'
  | 'pending_restart'
  | 'closed'
  | 'cancelled'

export interface MaintenanceOrderRecord {
  id: string
  enterpriseId: string
  plantId: string
  equipmentId: string
  orderNo: string
  source: 'web_manual' | 'anomaly_report'
  status: MaintenanceOrderStatusValue
  description: string | null
  reporter: string
  dispatcher: string | null
  assignee: string | null
  result: string | null
  responsible: string | null
  cancelReason: string | null
  closedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface NewMaintenanceOrder {
  id?: string
  enterpriseId: string
  plantId: string
  equipmentId: string
  orderNo: string
  source: 'web_manual' | 'anomaly_report'
  description: string | null
  reporter: string
}

export interface MaintenanceOrderPatch {
  status?: MaintenanceOrderStatusValue
  dispatcher?: string
  assignee?: string
  result?: string
  responsible?: string
  cancelReason?: string
  closedAt?: Date | null
}

export interface MaintenanceOrderFilter {
  plantIds: string[] | null
  equipmentId?: string
  status?: MaintenanceOrderStatusValue
  limit?: number
  offset?: number
}

export interface MaintenanceOrderRepository {
  insert(order: NewMaintenanceOrder): Promise<MaintenanceOrderRecord>
  findById(id: string): Promise<MaintenanceOrderRecord | null>
  update(id: string, patch: MaintenanceOrderPatch, actor: string | null): Promise<MaintenanceOrderRecord | null>
  list(filter: MaintenanceOrderFilter): Promise<MaintenanceOrderRecord[]>
}

// ---------------- 停机事件（MT-09/MT-S2） ----------------

export interface DowntimeEventRecord {
  id: string
  enterpriseId: string
  plantId: string
  equipmentId: string
  orderId: string | null
  startAt: string
  endAt: string | null
  reason: string
  createdAt: string
}

export interface NewDowntimeEvent {
  enterpriseId: string
  plantId: string
  equipmentId: string
  orderId: string | null
  startAt: Date
  reason: string
}

export interface DowntimeEventFilter {
  plantIds: string[] | null
  equipmentId?: string
  orderId?: string
  openOnly?: boolean
  limit?: number
  offset?: number
}

export interface DowntimeEventRepository {
  open(event: NewDowntimeEvent): Promise<DowntimeEventRecord>
  close(id: string, endAt: Date): Promise<DowntimeEventRecord>
  findById(id: string): Promise<DowntimeEventRecord | null>
  /** 该设备在停机中的区间（end_at IS NULL，MT-09 重叠守卫输入）。 */
  findOpenByEquipment(equipmentId: string): Promise<DowntimeEventRecord[]>
  findOpenByOrder(orderId: string): Promise<DowntimeEventRecord[]>
  list(filter: DowntimeEventFilter): Promise<DowntimeEventRecord[]>
}

// ---------------- 备件消耗（MT-11/MT-S3） ----------------
export interface SparePartUsageRecord {
  id: string
  enterpriseId: string
  plantId: string
  orderId: string
  unitId: string
  unitNo: string | null
  materialCode: string | null
  balanceId: string | null
  stockTransactionId: string
  quantity: string
  beforeQuantity: string
  afterQuantity: string
  uomId: string
  uomCode: string
  createdAt: string
}

export interface SparePartUsageRepository {
  insert(usage: {
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
  }): Promise<SparePartUsageRecord>
  listByOrder(orderId: string): Promise<SparePartUsageRecord[]>
}

/**
 * MT-11/IT-18（2026-10 修复后口径）：备件库存扣减不再持有域内等价服务端口——
 * maintenance-handlers 直用 inventory-posting 内核 writeLine/closeUnitIfZero，走同一
 * 记账序（IT-25 锁单元稳定次序 → IT-14 质量∧预留实时可用量校验 → IT-19 流水含扣前/
 * 扣后＋stock_entry 分录 → IT-29 零余额关闭），command_receipt 关联与 spare_part_usage
 * 行引用不变（MT-S3 不允许无流水消耗行）。
 */

// ---------------- 点检/保养计划与执行（MT-12/MT-S4） ----------------

export type MaintenancePlanKindValue = 'inspection' | 'maintenance'

export interface MaintenancePlanRecord {
  id: string
  enterpriseId: string
  plantId: string
  equipmentId: string
  planKey: string
  version: number
  kind: MaintenancePlanKindValue
  /** 最小周期机制（GAP-F19 待裁）：{"everyDays":n} */
  cycle: { everyDays: number }
  checkItems: string[]
  effectiveFrom: string
  effectiveTo: string | null
  status: 'active' | 'retired'
  description: string | null
  createdAt: string
}

export interface NewMaintenancePlanVersion {
  enterpriseId: string
  plantId: string
  equipmentId: string
  planKey: string
  version: number
  kind: MaintenancePlanKindValue
  cycle: { everyDays: number }
  checkItems: string[]
  effectiveFrom: string
  effectiveTo: string | null
  description: string | null
}

export interface MaintenancePlanFilter {
  plantIds: string[] | null
  equipmentId?: string
  kind?: MaintenancePlanKindValue
}

export interface MaintenancePlanRepository {
  insertVersion(plan: NewMaintenancePlanVersion): Promise<MaintenancePlanRecord>
  findByKeyAndVersion(planKey: string, version: number): Promise<MaintenancePlanRecord | null>
  listVersionsByKey(planKey: string): Promise<MaintenancePlanRecord[]>
  maxVersionByKey(planKey: string): Promise<number>
  list(filter: MaintenancePlanFilter): Promise<MaintenancePlanRecord[]>
}

export interface InspectionRoundRecord {
  id: string
  enterpriseId: string
  plantId: string
  planId: string
  planKey: string
  planVersion: number
  equipmentId: string
  executedAt: string
  shiftDate: string
  result: 'pass' | 'fail'
  anomalyNote: string | null
  performedBy: string
  orderId: string | null
  createdAt: string
}

export interface NewInspectionRound {
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
}

export interface InspectionRoundFilter {
  plantIds: string[] | null
  planKey?: string
  equipmentId?: string
  result?: 'pass' | 'fail'
  limit?: number
  offset?: number
}

export interface InspectionRoundRepository {
  insert(round: NewInspectionRound): Promise<InspectionRoundRecord>
  list(filter: InspectionRoundFilter): Promise<InspectionRoundRecord[]>
  /** 该计划（任意版本，按 planKey）最近一次执行的班次日（超期提示锚点，无执行 → null）。 */
  lastShiftDateByPlan(planKey: string): Promise<string | null>
}

// ---------------- 设备开工记录（MT-05/06/MT-S5） ----------------

export interface EquipmentStartRecord {
  id: string
  enterpriseId: string
  plantId: string
  equipmentId: string
  businessDate: string
  startedAt: string
  source: 'WEB' | 'PDA'
  actor: string
  createdAt: string
  updatedAt: string
}

export interface EquipmentStartRecordRepository {
  /** (equipment, 业务日) 幂等 upsert：重复开工更新 started_at（MT-05/06/MT-S5）。 */
  upsertStart(input: {
    enterpriseId: string
    plantId: string
    equipmentId: string
    businessDate: string
    startedAt: Date
    source: 'WEB' | 'PDA'
    actor: string
  }): Promise<{ record: EquipmentStartRecord; updated: boolean }>
  list(filter: {
    plantIds: string[] | null
    equipmentId?: string
    businessDate?: string
    limit?: number
    offset?: number
  }): Promise<EquipmentStartRecord[]>
}

// ---------------- Outbox 能力变化事件（MT-10/15；0001 outbox 窄端口） ----------------

export interface CapacityOutboxIntent {
  aggregateType: string
  aggregateId: string
  taskKind: string
  payload: object
}

export interface CapacityOutboxPort {
  insert(intent: CapacityOutboxIntent): Promise<string>
  /** 能力变化事件读回（A10：工单→停机→能力事件链可追溯；T09 消费前的排程可见证据）。 */
  listCapacityEvents(filter: {
    plantId?: string
    orderId?: string
    equipmentId?: string
    limit?: number
  }): Promise<
    Array<{
      eventId: string
      aggregateId: string
      status: string
      payload: Record<string, unknown>
      createdAt: string
    }>
  >
}

// ---------------- 命令回执读取（IT-21 同型：流水/消耗行 FK 锚点） ----------------

export interface MaintenanceReceiptReader {
  findIdByKey(enterpriseId: string, commandType: string, operationId: string): Promise<string | null>
}

// ---------------- 命令工具集 ----------------

/**
 * maintenance 命令工具集：InventoryCommandTools 超集（MT-11 修复 2026-10——备件扣减
 * 走 inventory-posting 内核，需 inv 仓储束与 Outbox 收集器，同 rework 先例）
 * ＋T04 设备档案端口＋maintenance 仓储束。
 */
export interface MaintenanceCommandTools extends InventoryCommandTools {
  /** T04 设备档案与状态流水端口（MD-09~16 已冻结，本域只读写不复建）。 */
  equipment: EquipmentRepository
  maintenance: {
    orders: MaintenanceOrderRepository
    downtime: DowntimeEventRepository
    usages: SparePartUsageRepository
    plans: MaintenancePlanRepository
    rounds: InspectionRoundRepository
    starts: EquipmentStartRecordRepository
    outbox: CapacityOutboxPort
    receipts: MaintenanceReceiptReader
  }
}

/** 设备档案只读视图（供查询服务对齐展示；T04 EquipmentRecord 的窄投影）。 */
export type MaintenanceEquipmentView = Pick<
  EquipmentRecord,
  'id' | 'code' | 'name' | 'equipmentStatus' | 'plantId' | 'status'
>

export interface MaintenanceEquipmentReader {
  findById(id: string): Promise<EquipmentRecord | null>
  findActiveByCode(code: string): Promise<EquipmentRecord | null>
  listStatusLogs(equipmentId: string): Promise<
    Array<{
      id: string
      equipmentId: string
      oldStatus: number
      newStatus: number
      source: string
      actor: string
      createdAt: string
    }>
  >
}
