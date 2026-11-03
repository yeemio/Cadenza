/**
 * 生产排程公开合同（L1-P1-SERVER T09 排程块）。
 *
 * 规则来源：architecture/contracts/prep/p1/03-production-chain-rules-T05T09T10T11.md
 * 的 A3/A4 节与 B11/S10 裁定（本域尚无冻结合同；字典值本地声明，contracts 零依赖，
 * 不反向 import domain，沿用 process.ts 模式）。
 *
 * 注意：本文件在 L0 整合步加入 packages/contracts/src/index.ts 导出前，
 * 由 tests/** 以相对路径直接引用做响应形状（DTO）冻结断言；集成后由 UI/PDA 线消费。
 * 数量字段一律 DecimalString（十进制字符串，见 decimal.ts 约定）；日期字段一律 YYYY-MM-DD。
 */

/** 订单排产状态（[底稿 A3-4 / OS §1.2 字典]：未排产/部分排产/已排产）。 */
export type OrderSchedulingStatusDtoValue = 'unplanned' | 'partially_scheduled' | 'fully_scheduled'

/** 设备状态字典（镜像 masterdata MD-13：1=正常、2=维修；[底稿 A3-3]）。 */
export type EquipmentStatusDtoValue = 1 | 2

/** 排产槽位 DTO（[底稿 A3-1] 唯一键五元组的行投影；计划量恒 >0，改 0 = 删槽不落行）。 */
export interface ScheduleSlotDto {
  id: string
  plantId: string
  orderId: string
  orderOperationId: string
  operationDefinitionId: string
  equipmentId: string
  /** 生产日期（YYYY-MM-DD） */
  productionDate: string
  /** 计划产量（DecimalString，>0） */
  plannedQty: string
  uom: string
  remark: string | null
  createdAt: string
  updatedAt: string
}

/** 设备日产能 DTO（[底稿 A3-2w]：capacity_calendar 行；null 产能=未配置不比较，此 DTO 恒为已配置行）。 */
export interface CapacityCalendarDto {
  id: string
  plantId: string
  equipmentId: string
  /** 生产日期（YYYY-MM-DD） */
  productionDate: string
  /** 设备日产能（DecimalString，≥0；0 = 已配置零产能，仍参与超产能比较） */
  capacity: string
  uom: string | null
  createdAt: string
  updatedAt: string
}

/** 班次参数 DTO（[底稿 A4-1]：白班起点，工厂级唯一）。 */
export interface ShiftParameterDto {
  id: string
  plantId: string
  /** 白班开始时间（HH:MM 24 小时制） */
  dayShiftStart: string
  createdAt: string
  updatedAt: string
}

/** 矩阵格（订单视图工序行下的设备×日期槽位投影）。 */
export interface OrderViewSlotCellDto {
  slotId: string
  equipmentId: string
  equipmentCode: string
  equipmentName: string
  /** 1=正常 2=维修（[底稿 A3-3] 设备状态标签） */
  equipmentStatus: EquipmentStatusDtoValue
  productionDate: string
  plannedQty: string
  remark: string | null
}

/** 订单视图工序行（[底稿 A3-4] 回写链投影：工序已排数量/是否排完）。 */
export interface OrderViewOperationDto {
  orderOperationId: string
  seq: number
  operationDefinitionId: string
  operationName: string
  operationRemark: string | null
  /** 下线数量（DecimalString，订单工序快照冻结值） */
  offlineQty: string
  /** 已排数量 = 该工序各槽位计划合计（DecimalString） */
  scheduledQty: string
  /** 是否排完 = 计划合计 ≥ 下线数量 */
  fullyScheduled: boolean
  uom: string
  workCenterId: string
  slots: OrderViewSlotCellDto[]
}

/**
 * 订单视图投影（订单排程详情：工序 Tab × 设备行 × 日期列；[底稿 A3-6] 详情前置
 * 以 enterable/entryBlocker 表达，未通过不阻断查询由 UI 拦截留在列表页）。
 */
export interface OrderSchedulingViewDto {
  orderId: string
  plantId: string
  orderNo: string
  uom: string
  orderStatus: string
  /** [底稿 A3-6] 详情前置是否通过（工序已配置且各工序均已配置工作中心） */
  enterable: boolean
  entryBlocker: string | null
  /** [底稿 A3-4] 订单排产状态（未排产/部分排产/已排产） */
  schedulingStatus: OrderSchedulingStatusDtoValue
  operations: OrderViewOperationDto[]
}

/** 设备看板格明细（悬停明细行：当日该设备某订单的计划量）。 */
export interface DeviceBoardCellDetailDto {
  orderId: string
  orderNo: string
  salesOrderNo: string | null
  plannedQty: string
  uom: string
}

/** 设备看板格（缩略：订单数量 + 计划量合计；[底稿 A3-5] 排除已结束/已作废订单）。 */
export interface DeviceBoardCellDto {
  productionDate: string
  /** 当日该设备排产订单个数 */
  orderCount: number
  /** 当日该设备计划量合计（DecimalString） */
  plannedTotal: string
  details: DeviceBoardCellDetailDto[]
}

/** 设备看板行（设备 + 状态标签 + 日期列格序列）。 */
export interface DeviceBoardEquipmentRowDto {
  equipmentId: string
  code: string
  name: string
  /** 1=正常 2=维修（[底稿 A3-3]） */
  equipmentStatus: EquipmentStatusDtoValue
  workCenterId: string
  cells: DeviceBoardCellDto[]
}

/** 工作中心 Tab（设备看板按工作中心分组；未选部门时为全部工作中心）。 */
export interface DeviceBoardWorkCenterDto {
  id: string
  code: string
  name: string
}

/**
 * 设备视图投影（设备排程看板：工作中心 Tab × 设备行 × 日期列；
 * [底稿 A3-5] 日期列 = 今日起连续 30 天 ∪ 已有排产日，升序）。
 */
export interface DeviceBoardViewDto {
  plantId: string
  workCenterId: string | null
  /** 今日（YYYY-MM-DD，服务端口径） */
  today: string
  /** 日期列全集（升序去重） */
  dates: string[]
  workCenters: DeviceBoardWorkCenterDto[]
  equipments: DeviceBoardEquipmentRowDto[]
}

/** PDA 排产计划卡片行（[底稿 A3-7 / PP §3.2] 只读）。 */
export interface PdaPlanItemDto {
  slotId: string
  orderNo: string
  salesOrderNo: string | null
  equipmentId: string
  equipmentName: string
  /** 物料描述（料品名称/规格/颜色以 " / " 拼接） */
  materialDesc: string
  plannedQty: string
  uom: string
  remark: string | null
}

/** PDA 排产计划分组（按排产日期升序）。 */
export interface PdaPlanGroupDto {
  productionDate: string
  items: PdaPlanItemDto[]
}

/** PDA 排产计划只读投影（按工作中心）。 */
export interface PdaPlanViewDto {
  workCenterId: string
  workCenterName: string
  groups: PdaPlanGroupDto[]
}

/** 班次信息与双轨时间（[底稿 A4-2]：实际时间与业务班次日期并存）。 */
export interface ShiftInfoDto {
  plantId: string
  /** 白班开始时间（HH:MM；null = 未配置） */
  dayShiftStart: string | null
  /** 实际时间（ISO-8601，请求时刻或服务端当前时间） */
  actualTime: string
  /** 业务班次日期（YYYY-MM-DD；未配置白班起点时为 null） */
  shiftDate: string | null
}
