import type { DecimalString } from './decimal'

/**
 * maintenance 域公开线合同（P2-E / T19 点检、保养、维修、备件与复机——大部 [合同新造]）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p2/maintenance.md（MT-01~MT-15、MT-S1~S5）：
 * - 数量字段一律 DecimalString（禁 number）；
 * - 设备状态字典仅 2 值（MT-01/MD-13）：1=正常、2=维修；
 * - 工单状态机封闭（MT-07）：reported→dispatched→in_progress→pending_restart→closed，
 *   cancelled 另记；
 * - 停机原因分类字典（GAP-F22）/计划周期细则（GAP-F19）/状态字典扩展（GAP-F23）待裁：
 *   当前以文本/最小周期承载，裁定后升级不破坏线形状。
 * - 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）。
 */

// ---------------- 设备状态（MT-01/02） ----------------

export type EquipmentStatusDictValue = 1 | 2

export const EQUIPMENT_STATUS_DICT: Readonly<Record<EquipmentStatusDictValue, string>> = {
  1: '正常',
  2: '维修',
}

export type EquipmentStatusSourceValue = 'WEB' | 'PDA'

/** 设备状态流水行（MT-02：前值/后值/操作人/时间/来源；append-only MD-S3）。 */
export interface EquipmentStatusLogDto {
  id: string
  equipmentId: string
  oldStatus: EquipmentStatusDictValue
  newStatus: EquipmentStatusDictValue
  source: EquipmentStatusSourceValue
  actor: string
  createdAt: string
}

// ---------------- 维修工单（MT-07/08/13/14） ----------------

export type MaintenanceOrderStatusValue =
  | 'reported'
  | 'dispatched'
  | 'in_progress'
  | 'pending_restart'
  | 'closed'
  | 'cancelled'

export const MAINTENANCE_ORDER_STATUS_DICT: Readonly<Record<MaintenanceOrderStatusValue, string>> = {
  reported: '已报修',
  dispatched: '已分派',
  in_progress: '处理中',
  pending_restart: '待复机',
  closed: '已关闭',
  cancelled: '已取消',
}

export interface MaintenanceOrderDto {
  orderId: string
  orderNo: string
  equipmentId: string
  plantId: string
  source: 'web_manual' | 'anomaly_report'
  sourceLabel: string
  status: MaintenanceOrderStatusValue
  statusLabel: string
  description: string | null
  reporter: string
  dispatcher: string | null
  assignee: string | null
  result: string | null
  responsible: string | null
  cancelReason: string | null
  closedAt: string | null
  createdAt: string
}

/** 停机事件（MT-09：起止原子记录；endAt 可空=在停机中；order→downtime 链可追溯）。 */
export interface DowntimeEventDto {
  id: string
  equipmentId: string
  orderId: string | null
  startAt: string
  endAt: string | null
  reason: string
}

/** 备件消耗行（MT-11：关联工单＋库存流水；不允许无流水消耗行）。 */
export interface SparePartUsageDto {
  id: string
  orderId: string
  unitId: string
  unitNo: string | null
  materialCode: string | null
  stockTransactionId: string
  quantity: DecimalString
  beforeQuantity: DecimalString
  afterQuantity: DecimalString
  uomCode: string
}

/** 能力变化事件（MT-10/15：含停机起止与原因；T09 消费触发计划评估）。 */
export interface CapacityEventDto {
  eventId: string
  orderId: string
  changeKind: 'down' | 'restored'
  equipmentId: string
  plantId: string
  downtimeStartAt: string
  downtimeEndAt: string | null
  downtimeReason: string
  occurredAt: string
  status: string
  createdAt: string
}

/** 工单详情对齐视图（A10：工单＋停机＋备件＋状态流水＋能力事件链）。 */
export interface MaintenanceOrderDetailDto {
  order: MaintenanceOrderDto
  downtimeEvents: DowntimeEventDto[]
  spareUsages: SparePartUsageDto[]
  equipmentStatusLogs: EquipmentStatusLogDto[]
  capacityEvents: CapacityEventDto[]
}

// ---------------- 点检/保养（MT-12） ----------------

export type MaintenancePlanKindValue = 'inspection' | 'maintenance'

export const MAINTENANCE_PLAN_KIND_DICT: Readonly<Record<MaintenancePlanKindValue, string>> = {
  inspection: '点检',
  maintenance: '保养',
}

export interface MaintenancePlanDto {
  planId: string
  planKey: string
  version: number
  kind: MaintenancePlanKindValue
  kindLabel: string
  equipmentId: string
  cycle: { everyDays: number }
  checkItems: string[]
  effectiveFrom: string
  effectiveTo: string | null
  status: 'active' | 'retired'
  description: string | null
}

/** 点检/保养执行轮次（实际时间＋业务班次双存，IT-37；fail 必填异常说明）。 */
export interface InspectionRoundDto {
  roundId: string
  planKey: string
  planVersion: number
  equipmentId: string
  executedAt: string
  shiftDate: string
  result: 'pass' | 'fail'
  anomalyNote: string | null
  performedBy: string
  orderId: string | null
}

/** 超期未执行提示行（MT-12：提示口径，不自动阻断生产）。 */
export interface OverduePlanDto {
  planId: string
  planKey: string
  version: number
  kind: MaintenancePlanKindValue
  equipmentId: string
  anchorDate: string
  nextDueDate: string
  overdueDays: number
  note: string
}

// ---------------- 设备开工（MT-05/06） ----------------

export interface EquipmentStartRecordDto {
  id: string
  equipmentId: string
  businessDate: string
  startedAt: string
  source: EquipmentStatusSourceValue
  actor: string
}
