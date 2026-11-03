import type { PageRequest, PageResult } from '@cadenza/contracts'
import type { WarehouseTypeValue } from '@cadenza/domain'
import type { CommandTools } from './command-bus'

/**
 * masterdata 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与 0003 迁移列一一对应；时间字段一律 ISO-8601 字符串（OA-31 系统时间口径）。
 * 数量字段（factor/capacity）为十进制字符串（DecimalString）。
 */

export type MasterDataStatus = 'active' | 'retired'

export interface MaterialRecord {
  id: string
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
  materialType: number
  spec: string | null
  color: string | null
  baseUom: string
  qcFlag: number
  remark: string | null
  sourceSystem: string
  /** IF-01/IF-00.3：已应用上游修订号；未同步过可为 null */
  externalRevision: number | null
  status: MasterDataStatus
  deletedAt: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface ConversionLineRecord {
  id: string
  materialId: string
  version: number
  unitName: string
  factor: string
  referenced: boolean
  status: MasterDataStatus
  deletedAt: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface EquipmentRecord {
  id: string
  enterpriseId: string
  plantId: string
  deptId: string
  workCenterId: string
  code: string
  name: string
  actualNo: string | null
  model: string | null
  stdRateText: string | null
  /** MD-13 字典：1=正常 2=维修 */
  equipmentStatus: number
  /** DecimalString 或 null（MD-16：10 位整数＋4 位小数） */
  capacity: string | null
  status: MasterDataStatus
  deletedAt: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface EquipmentStatusLogRecord {
  id: string
  equipmentId: string
  oldStatus: number
  newStatus: number
  source: string
  actor: string
  createdAt: string
}

export interface WarehouseRecord {
  id: string
  enterpriseId: string
  plantId: string
  deptId: string
  code: string
  name: string
  warehouseType: WarehouseTypeValue
  materialTypes: number[]
  managerUserId: string | null
  phone: string | null
  address: string | null
  qrBound: boolean
  status: MasterDataStatus
  deletedAt: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface StorageLocationRecord {
  id: string
  enterpriseId: string
  plantId: string
  warehouseId: string
  rackId: string | null
  locationKind: 'NORMAL' | 'RACK'
  code: string
  zoneCode: string | null
  remark: string | null
  qrBound: boolean
  status: MasterDataStatus
  deletedAt: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface RackRecord {
  id: string
  enterpriseId: string
  plantId: string
  warehouseId: string
  code: string
  zones: number
  layers: number
  remark: string | null
  status: MasterDataStatus
  deletedAt: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface WorkCenterRecord {
  id: string
  enterpriseId: string
  plantId: string
  deptId: string
  code: string
  name: string
  status: MasterDataStatus
  deletedAt: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

// ---------------- 端口 ----------------

/** MD-01/02：本系统对料品主表只读（写入仅同步/集成块）；此处仅提供读。 */
export interface MaterialRepository {
  findById(id: string): Promise<MaterialRecord | null>
  findActiveByCode(orgScopeId: string, code: string): Promise<MaterialRecord | null>
  list(
    filter: { orgScopeId: string; nameLike?: string; codeLike?: string } & PageRequest,
  ): Promise<PageResult<MaterialRecord>>
}

export interface NewConversionLine {
  id?: string
  materialId: string
  version: number
  unitName: string
  factor: string
  createdBy?: string | null
}

export interface ConversionLinePatch {
  unitName?: string
  factor?: string
  referenced?: boolean
  status?: MasterDataStatus
}

export interface ConversionRepository {
  findById(id: string): Promise<ConversionLineRecord | null>
  /** 指定料品的全部活动换算行（按版本序）。 */
  listActiveByMaterial(materialId: string): Promise<ConversionLineRecord[]>
  /** 料品下一个版本号（现有最大版本 +1；无行则 1）。 */
  nextVersion(materialId: string): Promise<number>
  insert(line: NewConversionLine): Promise<ConversionLineRecord>
  update(id: string, patch: ConversionLinePatch, actor: string | null): Promise<ConversionLineRecord | null>
  /** MD-36 逻辑删除（状态列 + deleted_at）。 */
  retire(id: string, actor: string | null): Promise<ConversionLineRecord | null>
  /**
   * MD-05：置 referenced 标志（供采购收货/库存域引用换算行时调用；
   * false→true 放行，referenced 行的内容列更新由库层触发器拒绝）。
   */
  markReferenced(id: string, actor: string | null): Promise<ConversionLineRecord | null>
}

export interface NewEquipment {
  id?: string
  enterpriseId: string
  plantId: string
  deptId: string
  workCenterId: string
  code: string
  name: string
  actualNo?: string | null
  model?: string | null
  stdRateText?: string | null
  equipmentStatus: number
  capacity?: string | null
  createdBy?: string | null
}

export interface EquipmentPatch {
  name?: string
  deptId?: string
  workCenterId?: string
  actualNo?: string | null
  model?: string | null
  stdRateText?: string | null
  equipmentStatus?: number
  capacity?: string | null
  status?: MasterDataStatus
}

export interface EquipmentRepository {
  findById(id: string): Promise<EquipmentRecord | null>
  findActiveByCode(code: string): Promise<EquipmentRecord | null>
  findActiveByName(name: string): Promise<EquipmentRecord | null>
  insert(equipment: NewEquipment): Promise<EquipmentRecord>
  update(id: string, patch: EquipmentPatch, actor: string | null): Promise<EquipmentRecord | null>
  retire(id: string, actor: string | null): Promise<EquipmentRecord | null>
  /** MD-14：状态变更流水（append-only，库层触发器禁改删）。 */
  appendStatusLog(entry: {
    equipmentId: string
    oldStatus: number
    newStatus: number
    source: string
    actor: string
    occurredAt: Date
  }): Promise<EquipmentStatusLogRecord>
  listStatusLogs(equipmentId: string): Promise<EquipmentStatusLogRecord[]>
  /** MD-11：被排产/报工引用计数（排产/报工表未建阶段由调用方以 0 预留）。 */
  countSchedulingRefs(equipmentId: string): Promise<number>
  countWorkReportRefs(equipmentId: string): Promise<number>
  list(
    filter: { plantIds: string[] | null; nameLike?: string; codeLike?: string } & PageRequest,
  ): Promise<PageResult<EquipmentRecord>>
}

export interface NewWarehouse {
  id?: string
  enterpriseId: string
  plantId: string
  deptId: string
  code: string
  name: string
  warehouseType: WarehouseTypeValue
  materialTypes: number[]
  managerUserId?: string | null
  phone?: string | null
  address?: string | null
  createdBy?: string | null
}

export interface WarehousePatch {
  name?: string
  code?: string
  deptId?: string
  warehouseType?: WarehouseTypeValue
  materialTypes?: number[]
  managerUserId?: string | null
  phone?: string | null
  address?: string | null
  status?: MasterDataStatus
}

export interface WarehouseRepository {
  findById(id: string): Promise<WarehouseRecord | null>
  findActiveByName(name: string): Promise<WarehouseRecord | null>
  findActiveByPlantAndCode(plantId: string, code: string): Promise<WarehouseRecord | null>
  insert(warehouse: NewWarehouse): Promise<WarehouseRecord>
  update(id: string, patch: WarehousePatch, actor: string | null): Promise<WarehouseRecord | null>
  /** MD-36 逻辑删除。 */
  retire(id: string, actor: string | null): Promise<WarehouseRecord | null>
  /** MD-25：仓库下活动普通库位数。 */
  countActiveNormalLocations(warehouseId: string): Promise<number>
  /** MD-27：无引用时下级普通库位随之级联失效（不物理删行）。 */
  retireNormalLocations(warehouseId: string, actor: string | null): Promise<number>
  /** 活动库位 id 集合（库存引用检查输入）。 */
  listActiveLocationIds(warehouseId: string): Promise<string[]>
  list(
    filter: { plantIds: string[] | null; nameLike?: string } & PageRequest,
  ): Promise<PageResult<WarehouseRecord>>
}

export interface NewStorageLocation {
  id?: string
  enterpriseId: string
  plantId: string
  warehouseId: string
  rackId?: string | null
  locationKind: 'NORMAL' | 'RACK'
  code: string
  zoneCode?: string | null
  remark?: string | null
  createdBy?: string | null
}

export interface StorageLocationPatch {
  code?: string
  remark?: string | null
  status?: MasterDataStatus
}

export interface StorageLocationRepository {
  findById(id: string): Promise<StorageLocationRecord | null>
  findActiveByPlantAndCode(plantId: string, code: string): Promise<StorageLocationRecord | null>
  insert(location: NewStorageLocation): Promise<StorageLocationRecord>
  update(id: string, patch: StorageLocationPatch, actor: string | null): Promise<StorageLocationRecord | null>
  retire(id: string, actor: string | null): Promise<StorageLocationRecord | null>
  listActiveByRack(rackId: string): Promise<StorageLocationRecord[]>
  countActiveByRack(rackId: string): Promise<number>
  /** MD-33：货架下被二维码占用的活动库位数。 */
  countQrBoundActiveByRack(rackId: string): Promise<number>
  /** 活动库位 id 集合（库存引用检查输入）。 */
  listActiveIdsByRack(rackId: string): Promise<string[]>
  /** MD-31：货架换仓时同步更新其下全部库位的所属仓库。 */
  updateWarehouseOfRackLocations(rackId: string, warehouseId: string, actor: string | null): Promise<number>
  list(
    filter: { plantIds: string[] | null; warehouseId?: string; codeLike?: string } & PageRequest,
  ): Promise<PageResult<StorageLocationRecord>>
}

export interface NewRack {
  id?: string
  enterpriseId: string
  plantId: string
  warehouseId: string
  code: string
  zones: number
  layers: number
  remark?: string | null
  createdBy?: string | null
}

export interface RackPatch {
  warehouseId?: string
  remark?: string | null
  status?: MasterDataStatus
}

export interface RackRepository {
  findById(id: string): Promise<RackRecord | null>
  findActiveByPlantAndCode(plantId: string, code: string): Promise<RackRecord | null>
  insert(rack: NewRack): Promise<RackRecord>
  update(id: string, patch: RackPatch, actor: string | null): Promise<RackRecord | null>
  retire(id: string, actor: string | null): Promise<RackRecord | null>
  list(
    filter: { plantIds: string[] | null; warehouseId?: string; codeLike?: string } & PageRequest,
  ): Promise<PageResult<RackRecord>>
}

export interface NewWorkCenter {
  id?: string
  enterpriseId: string
  plantId: string
  deptId: string
  code: string
  name: string
  createdBy?: string | null
}

export interface WorkCenterPatch {
  name?: string
  deptId?: string
  status?: MasterDataStatus
}

export interface WorkCenterRepository {
  findById(id: string): Promise<WorkCenterRecord | null>
  findActiveByCode(code: string): Promise<WorkCenterRecord | null>
  findActiveByDeptAndName(deptId: string, name: string): Promise<WorkCenterRecord | null>
  insert(workCenter: NewWorkCenter): Promise<WorkCenterRecord>
  update(id: string, patch: WorkCenterPatch, actor: string | null): Promise<WorkCenterRecord | null>
  retire(id: string, actor: string | null): Promise<WorkCenterRecord | null>
  /** MD-18①：活动设备引用数。 */
  countActiveEquipment(workCenterId: string): Promise<number>
  /** MD-18②③：工序/订单工序引用数（表未建阶段由实现按 0 预留）。 */
  countProcessRefs(workCenterId: string): Promise<number>
  countOrderProcessRefs(workCenterId: string): Promise<number>
  list(
    filter: { plantIds: string[] | null; codeLike?: string } & PageRequest,
  ): Promise<PageResult<WorkCenterRecord>>
}

/**
 * MD-37：库存引用计数端口——被库存余额（stock_balance）或库存流水（stock_transaction）
 * 引用的主数据拒绝退役。库存表由 inventory 块（0004+）落地；实现方在表/列缺失时按 0 返回
 * 并注明预留（不猜测未落地 schema）。
 */
export interface StockReferenceCounter {
  countByLocationIds(locationIds: string[]): Promise<{ balanceRefs: number; transactionRefs: number }>
  countByConversionLineIds(lineIds: string[]): Promise<{ transactionRefs: number }>
}

/** masterdata 命令工具集：S2 CommandTools 超集（组合根装配时注入 masterdata 仓储束）。 */
export interface MasterDataRepositories {
  materials: MaterialRepository
  conversions: ConversionRepository
  equipment: EquipmentRepository
  warehouses: WarehouseRepository
  locations: StorageLocationRepository
  racks: RackRepository
  workCenters: WorkCenterRepository
  stockRefs: StockReferenceCounter
}

export interface MasterDataCommandTools extends CommandTools {
  masterdata: MasterDataRepositories
}
