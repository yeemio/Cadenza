/**
 * 工厂主数据公开合同（L1-P1-SERVER T04 主数据块）。
 *
 * 对应冻结合同 architecture/contracts/frozen/p1/master-data.md。
 * 字典值类型在本地声明（contracts 零依赖，不反向 import domain，沿用 auth.ts 模式）。
 *
 * 注意：本文件在 L0 整合步加入 packages/contracts/src/index.ts 导出前，
 * 由 tests/** 以相对路径直接引用做响应形状（DTO）冻结断言；集成后由 UI/PDA 线消费。
 * 数量字段一律 DecimalString（十进制字符串，见 decimal.ts 约定）。
 */

/** 仓库类型字典（MD-23）。 */
export type WarehouseTypeDtoValue = 'WAREHOUSE' | 'LINE_SIDE'

/** 库位种类：NORMAL=普通库位（8 位码）；RACK=货架库位（6 位码，MD-28/31）。 */
export type LocationKindDtoValue = 'NORMAL' | 'RACK'

/** 主数据逻辑删除状态（MD-36）。 */
export type MasterDataStatusDtoValue = 'active' | 'retired'

/** 设备状态字典（MD-13：1=正常 2=维修）。 */
export type EquipmentStatusDtoValue = 1 | 2

/** 料品 DTO（MD-01/02：只读视图，本系统无新增/删除/主表编辑入口）。 */
export interface MaterialDto {
  id: string
  /** 组织范围节点 id（enterprise 层，MD-03 唯一键 (org_scope, code) 的 org_scope 部分） */
  orgScopeId: string
  code: string
  name: string
  companyOrgCode: string | null
  materialGroupCode: string | null
  materialGroupName: string | null
  descriptionZh: string | null
  descriptionEn: string | null
  voltage: string | null
  standard: string | null
  customer: string | null
  /** 料品类型（1=原材料 2=半成品 3=成品） */
  materialType: number
  spec: string | null
  color: string | null
  /** 主计量单位（简称；主权 GAP-A6 未裁定，MD-08） */
  baseUom: string
  /** 是否质检（1=是 0=否，同步后不可本系统改，MD-02） */
  qcFlag: number
  remark: string | null
  sourceSystem: string
  status: MasterDataStatusDtoValue
}

/** 换算行 DTO（MD-04/05：referenced 行 immutable，变更须生成新版本）。 */
export interface ConversionLineDto {
  id: string
  materialId: string
  version: number
  unitName: string
  /** 数量（十进制字符串，MD-04：非负、整数 ≤9 位、小数 ≤4 位） */
  factor: string
  referenced: boolean
  status: MasterDataStatusDtoValue
}

/** 设备 DTO（MD-09～16）。 */
export interface EquipmentDto {
  id: string
  plantId: string
  deptId: string
  workCenterId: string
  code: string
  name: string
  actualNo: string | null
  model: string | null
  /** 标准速率原文自由文本（GAP-S1 未裁定，排程不得用于计算，MD-16） */
  stdRateText: string | null
  equipmentStatus: EquipmentStatusDtoValue
  /** 设备产能（十进制字符串，10 位整数＋4 位小数，MD-16） */
  capacity: string | null
  /** 设备码 = 'EQU-' + code（仅大写前缀，MD-15） */
  equipmentQrCode: string
  status: MasterDataStatusDtoValue
}

/** 设备状态流水 DTO（MD-14：append-only）。 */
export interface EquipmentStatusLogDto {
  id: string
  equipmentId: string
  oldStatus: EquipmentStatusDtoValue
  newStatus: EquipmentStatusDtoValue
  /** 变更来源（WEB/PDA） */
  source: string
  actor: string
  occurredAt: string
}

/** 仓库 DTO（MD-22～27）。 */
export interface WarehouseDto {
  id: string
  plantId: string
  deptId: string
  /** 4 位数字（MD-22） */
  code: string
  name: string
  warehouseType: WarehouseTypeDtoValue
  /** 可收料品类型集合（1=原料 2=半成品 3=成品，MD-23） */
  materialTypes: number[]
  managerUserId: string | null
  phone: string | null
  address: string | null
  /** 被库位二维码占用（MD-26：类型/料品类型不可改、不可删） */
  qrBound: boolean
  status: MasterDataStatusDtoValue
}

/** 库位 DTO（MD-28/29；NORMAL 8 位码、RACK 6 位码）。 */
export interface StorageLocationDto {
  id: string
  plantId: string
  warehouseId: string
  rackId: string | null
  locationKind: LocationKindDtoValue
  code: string
  /** 货架库位所属区域码（货架号 2+区域号 2，MD-31；普通库位为 null） */
  zoneCode: string | null
  remark: string | null
  qrBound: boolean
  status: MasterDataStatusDtoValue
}

/** 货架 DTO（MD-30/31/33）。 */
export interface RackDto {
  id: string
  plantId: string
  warehouseId: string
  /** 2 位数字（MD-30） */
  code: string
  zones: number
  /** 编辑时不可改（MD-31） */
  layers: number
  remark: string | null
  status: MasterDataStatusDtoValue
}

/** 工作中心 DTO（MD-17/18；对照表规则 MD-19~21 见映射域）。 */
export interface WorkCenterDto {
  id: string
  plantId: string
  deptId: string
  code: string
  name: string
  status: MasterDataStatusDtoValue
}
