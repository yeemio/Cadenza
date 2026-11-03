import type { PageRequest, PageResult } from '@cadenza/contracts'
import type { CommandTools } from './command-bus'

/**
 * scheduling 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与 0007 迁移列一一对应；时间字段一律 ISO-8601 字符串（OA-31 系统时间口径）；
 * 数量字段为十进制字符串（DecimalString）；日期字段一律 YYYY-MM-DD 字符串（不做时区换算）。
 *
 * 注意：本文件未加入 application/src/index.ts 导出（S2 共享文件不可改，L0 整合步统一导出）；
 * persistence 实现以 dist 相对导入消费本端口（见 packages/persistence/src/scheduling-repositories.ts）。
 */

export type OrderSchedulingStatus = 'unplanned' | 'partially_scheduled' | 'fully_scheduled'
export type ProductionOrderStatusValue =
  | 'approved'
  | 'released'
  | 'in_progress'
  | 'pending_completion'
  | 'closed'
  | 'voided'

// ---------------- 记录类型 ----------------

export interface ScheduleSlotRecord {
  id: string
  enterpriseId: string
  plantId: string
  orderId: string
  orderOperationId: string
  operationDefinitionId: string
  equipmentId: string
  /** 生产日期（YYYY-MM-DD） */
  productionDate: string
  /** 计划产量（DecimalString，恒 >0；改 0 = 删槽不落行） */
  plannedQty: string
  uom: string
  remark: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface CapacityCalendarRecord {
  id: string
  enterpriseId: string
  plantId: string
  equipmentId: string
  /** 生产日期（YYYY-MM-DD） */
  productionDate: string
  /** 设备日产能（DecimalString，≥0；行存在即已配置，null 由行不存在表达） */
  capacity: string
  uom: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface ShiftParameterRecord {
  id: string
  enterpriseId: string
  plantId: string
  /** 白班开始时间（HH:MM） */
  dayShiftStart: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

// ---------------- 槽位唯一键 ----------------

/** [底稿 A3-1] 槽位唯一键（同订单+同订单工序+同标准工序+同设备+同生产日期）。 */
export interface SlotIdentityKey {
  orderId: string
  orderOperationId: string
  operationDefinitionId: string
  equipmentId: string
  productionDate: string
}

// ---------------- 写入载荷 ----------------

export interface NewScheduleSlot {
  id?: string
  enterpriseId: string
  plantId: string
  orderId: string
  orderOperationId: string
  operationDefinitionId: string
  equipmentId: string
  productionDate: string
  plannedQty: string
  uom: string
  remark?: string | null
  createdBy?: string | null
}

export interface NewCapacityCalendar {
  id?: string
  enterpriseId: string
  plantId: string
  equipmentId: string
  productionDate: string
  capacity: string
  uom?: string | null
  createdBy?: string | null
}

export interface NewShiftParameter {
  id?: string
  enterpriseId: string
  plantId: string
  dayShiftStart: string
  createdBy?: string | null
}

// ---------------- 看板/投影富行（订单视图与设备视图/PDA 读同一 slot 表的行源） ----------------

/**
 * 槽位富行（slot join production_order/order_operation/equipment）：
 * 订单视图、设备看板、PDA 计划三个投影共用同一行源（[底稿 A3] 同一排产事实双投影）。
 */
export interface SchedulingSlotViewRow {
  slotId: string
  plantId: string
  orderId: string
  orderNo: string
  salesOrderNo: string | null
  orderStatus: ProductionOrderStatusValue
  orderOperationId: string
  seq: number
  operationDefinitionId: string
  operationName: string
  offlineQty: string
  equipmentId: string
  equipmentCode: string
  equipmentName: string
  equipmentStatus: number
  workCenterId: string
  productionDate: string
  plannedQty: string
  uom: string
  remark: string | null
  /** 料品快照（material_snapshot jsonb：name/spec/color） */
  materialSnapshot: Record<string, unknown>
}

// ---------------- 只读窄端口（0003 主数据 / 0005 工艺订单表的只读视图） ----------------

export interface EquipmentLookup {
  id: string
  enterpriseId: string
  plantId: string
  deptId: string
  workCenterId: string
  code: string
  name: string
  /** 1=正常 2=维修（masterdata MD-13） */
  equipmentStatus: number
  status: 'active' | 'retired'
}

export interface SchedulingWorkCenterLookup {
  id: string
  enterpriseId: string
  plantId: string
  deptId: string
  code: string
  name: string
  status: 'active' | 'retired'
}

export interface SchedulingOrderLookup {
  id: string
  enterpriseId: string
  plantId: string
  orderNo: string
  orderStatus: ProductionOrderStatusValue
  processConfigStatus: 'unconfigured' | 'configured'
  productionQty: string
  uom: string
  currentSettingsVersion: number
  materialSnapshot: Record<string, unknown>
}

export interface SchedulingOrderOperationLookup {
  id: string
  orderId: string
  plantId: string
  seq: number
  settingsVersion: number
  operationDefinitionId: string
  operationName: string
  operationRemark: string | null
  offlineQty: string
  workCenterId: string
  uom: string
}

/** masterdata/process 只读查询端口（本域消费既有 0003/0005 表，不写其它域）。 */
export interface SchedulingLookups {
  findEquipment(id: string): Promise<EquipmentLookup | null>
  /** 工作中心下活动设备（看板行/PDA 设备选项；维修设备照常返回——状态约束在规则层判定）。 */
  listActiveEquipmentsByWorkCenter(workCenterId: string): Promise<EquipmentLookup[]>
  findWorkCenter(id: string): Promise<SchedulingWorkCenterLookup | null>
  /** 厂内活动工作中心（看板 Tab；可按部门过滤——部门树收敛由查询层处理）。 */
  listActiveWorkCentersByPlant(plantId: string): Promise<SchedulingWorkCenterLookup[]>
  findOrder(id: string): Promise<SchedulingOrderLookup | null>
  findOrderOperation(id: string): Promise<SchedulingOrderOperationLookup | null>
  /** 订单当前设置版本的全部工序行（订单视图/详情前置）。 */
  listOrderOperations(orderId: string): Promise<SchedulingOrderOperationLookup[]>
}

// ---------------- 端口 ----------------

export interface ScheduleSlotRepository {
  findById(id: string): Promise<ScheduleSlotRecord | null>
  /** 唯一键查询（[底稿 A3-1]；替换/删槽/设备状态约束的事实输入）。 */
  findSlot(identity: SlotIdentityKey): Promise<ScheduleSlotRecord | null>
  /** 同键替换 upsert（ON CONFLICT 五元组 DO UPDATE；命令层先经 planSlotSave 决策）。 */
  upsert(slot: NewScheduleSlot): Promise<ScheduleSlotRecord>
  /** 同键删槽（改 0 保存；返回是否删除了行）。 */
  deleteSlot(identity: SlotIdentityKey): Promise<boolean>
  /** 订单全部有效槽位（订单视图投影）。 */
  listByOrder(orderId: string): Promise<ScheduleSlotRecord[]>
  /** 订单工序全部有效槽位（硬校验输入）。 */
  listByOrderOperation(orderOperationId: string): Promise<ScheduleSlotRecord[]>
  /**
   * 当日该设备累计排产合计（跨订单；[底稿 A3-2w] 弱提醒输入）。
   * excludeIdentity 用于把「本槽旧值」从合计中剔除（本槽按替换旧值计）。
   */
  sumPlannedByEquipmentAndDate(
    equipmentId: string,
    productionDate: string,
    excludeIdentity?: SlotIdentityKey,
  ): Promise<string>
  /**
   * 富行查询（三投影共用的行源）：按厂/工作中心/设备/订单收敛；
   * includeFinishedOrders=false 时排除已结束/已作废订单（[底稿 A3-5] 看板口径），
   * dates 给定时按日期集合过滤（含 30 天窗外的已有排产日）。
   */
  listViewRows(filter: {
    plantIds: string[] | null
    workCenterId?: string
    equipmentId?: string
    orderId?: string
    dates?: string[]
    dateFrom?: string
    dateTo?: string
    includeFinishedOrders?: boolean
  }): Promise<SchedulingSlotViewRow[]>
  /** [底稿 A3-1] 引用计数（process 域 A1-3 删除拦截②的排产真值接入位）。 */
  countByOperationDefinition(operationDefinitionId: string): Promise<number>
  countByEquipment(equipmentId: string): Promise<number>
  list(
    filter: { plantIds: string[] | null; orderId?: string; equipmentId?: string } & PageRequest,
  ): Promise<PageResult<ScheduleSlotRecord>>
}

export interface CapacityCalendarRepository {
  findByEquipmentAndDate(equipmentId: string, productionDate: string): Promise<CapacityCalendarRecord | null>
  /** 同设备同日替换 upsert（含配置为 0 = 已配置零产能）。 */
  upsert(entry: NewCapacityCalendar): Promise<CapacityCalendarRecord>
  /** 删除配置行（回到「未配置不比较」）。 */
  deleteByEquipmentAndDate(equipmentId: string, productionDate: string): Promise<boolean>
  list(filter: { plantIds: string[] | null; equipmentId?: string } & PageRequest): Promise<PageResult<CapacityCalendarRecord>>
}

export interface ShiftParameterRepository {
  findByPlant(plantId: string): Promise<ShiftParameterRecord | null>
  /** 工厂级唯一 upsert（白班起点）。 */
  upsert(entry: NewShiftParameter): Promise<ShiftParameterRecord>
  list(filter: { plantIds: string[] | null }): Promise<ShiftParameterRecord[]>
}

/** scheduling 仓储束（组合根装配时注入）。 */
export interface SchedulingRepositories {
  slots: ScheduleSlotRepository
  capacities: CapacityCalendarRepository
  shifts: ShiftParameterRepository
  lookups: SchedulingLookups
}

/** scheduling 命令工具集：S2 CommandTools 超集（组合根装配时注入 scheduling 仓储束）。 */
export interface SchedulingCommandTools extends CommandTools {
  scheduling: SchedulingRepositories
}
