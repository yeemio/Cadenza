import type { InventoryCommandTools } from './inventory-repositories'
import type { ExecutionEventPort } from './quality-repositories'

/**
 * warehousing 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0009 warehousing 表列一一对应；时间字段一律 ISO-8601 字符串；
 * 数量字段一律 DecimalString（IT-07）。
 *
 * WarehousingCommandTools = InventoryCommandTools 超集（确认入库/移库/调拨复用 inv 仓储束
 * 与 inventory 记账服务——通过端口注入、同 UoW，IT-18 口径）+ 事件端口 + 主数据只读查询。
 */

// ---------------- 记录类型 ----------------

export interface PutawayTaskRecord {
  id: string
  sourceType: 'work_report' | 'finished_inspection'
  sourceRef: string
  unitNo: string | null
  palletCode: string | null
  materialId: string
  materialCode: string
  quantity: string
  uomId: string
  uomCode: string
  targetWarehouseId: string | null
  status: 'pending' | 'done' | 'cancelled'
  inventoryUnitId: string | null
  locationId: string | null
  locationCode: string | null
  putawayBy: string | null
  putawayAt: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
  updatedAt: string
}

export interface NewPutawayTask {
  sourceType: PutawayTaskRecord['sourceType']
  sourceRef: string
  unitNo?: string | null
  palletCode?: string | null
  materialId: string
  materialCode: string
  quantity: string
  uomId: string
  uomCode: string
  targetWarehouseId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface WarehouseMoveRecord {
  id: string
  inventoryUnitId: string
  unitNo: string
  fromLocationId: string | null
  fromLocationCode: string | null
  toLocationId: string | null
  toLocationCode: string | null
  quantity: string
  uomId: string
  uomCode: string
  movedBy: string
  movedAt: string
  reason: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
}

export interface NewWarehouseMove {
  inventoryUnitId: string
  unitNo: string
  fromLocationId?: string | null
  fromLocationCode?: string | null
  toLocationId?: string | null
  toLocationCode?: string | null
  quantity: string
  uomId: string
  uomCode: string
  movedBy: string
  movedAt: string
  reason?: string | null
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdBy?: string | null
}

export type TransferStatusValue =
  | 'draft'
  | 'ready'
  | 'shipping'
  | 'shipped_in_transit'
  | 'receiving'
  | 'completed'
  | 'cancelled'

export interface TransferOrderRecord {
  id: string
  orderNo: string
  transferKind: 'production' | 'warehouse' | 'auto'
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseCode: string | null
  toWarehouseCode: string | null
  fromWarehouseType: string | null
  toWarehouseType: string | null
  status: TransferStatusValue
  transitLocationId: string | null
  transitLocationCode: string | null
  lockedValidUntil: string | null
  note: string | null
  submittedBy: string | null
  submittedAt: string | null
  shippedBy: string | null
  shippedAt: string | null
  completedBy: string | null
  completedAt: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  updatedAt: string
}

export interface NewTransferOrder {
  orderNo: string
  transferKind: TransferOrderRecord['transferKind']
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseCode?: string | null
  toWarehouseCode?: string | null
  fromWarehouseType?: string | null
  toWarehouseType?: string | null
  transitLocationId: string
  transitLocationCode: string
  note?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface TransferLineRecord {
  id: string
  transferOrderId: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  materialId: string | null
  materialCode: string | null
  materialType: number | null
  quantity: string
  outQty: string
  inQty: string
  reservationId: string | null
  outDone: boolean
  outAt: string | null
  inDone: boolean
  inAt: string | null
  createdAt: string
  updatedAt: string
}

export interface NewTransferLine {
  transferOrderId: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  materialId?: string | null
  materialCode?: string | null
  materialType?: number | null
  quantity: string
  createdBy?: string | null
}

// ---------------- 仓储端口 ----------------

export interface PutawayTaskRepository {
  insert(task: NewPutawayTask): Promise<PutawayTaskRecord>
  findById(id: string): Promise<PutawayTaskRecord | null>
  /** 来源幂等查重（A-T13-1：(source_type, source_ref) 唯一；refresh 重跑不重复生成）。 */
  findBySource(sourceType: PutawayTaskRecord['sourceType'], sourceRef: string): Promise<PutawayTaskRecord | null>
  findByIds(ids: readonly string[], forUpdate?: boolean): Promise<PutawayTaskRecord[]>
  resolveSourceOwner(task: PutawayTaskRecord): Promise<{ ownerId: string; ownerName: string; unitId: string | null } | null>
  listPendingByUnitNos(plantId: string, unitNos: readonly string[]): Promise<PutawayTaskRecord[]>
  /** 同托未入库任务全集（A-T13-2：托码确认=整托）。 */
  listPendingByPallet(palletCode: string): Promise<PutawayTaskRecord[]>
  listPendingByPlant(plantId: string): Promise<PutawayTaskRecord[]>
  /** 确认入库回填（unit/location/status=done）。 */
  markDone(
    id: string,
    patch: { inventoryUnitId: string; locationId: string; locationCode: string; putawayBy: string; putawayAt: string },
    actor: string | null,
  ): Promise<PutawayTaskRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    sourceTypes?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: PutawayTaskRecord[]; total: number }>
}

export interface WarehouseMoveRepository {
  insert(move: NewWarehouseMove): Promise<WarehouseMoveRecord>
  listByUnit(inventoryUnitId: string): Promise<WarehouseMoveRecord[]>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    unitNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: WarehouseMoveRecord[]; total: number }>
}

export interface TransferOrderRepository {
  insert(order: NewTransferOrder): Promise<TransferOrderRecord>
  findById(id: string): Promise<TransferOrderRecord | null>
  /** 行锁（submit/ship/receive 前锁定，防状态机并发步进）。 */
  lockById(id: string): Promise<TransferOrderRecord | null>
  updateStatus(
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
  ): Promise<TransferOrderRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    orderNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: TransferOrderRecord[]; total: number }>
}

export interface TransferLineRepository {
  insert(line: NewTransferLine): Promise<TransferLineRecord>
  findById(id: string): Promise<TransferLineRecord | null>
  /** 行锁（ship/receive 前锁定）。 */
  lockById(id: string): Promise<TransferLineRecord | null>
  listByOrder(transferOrderId: string): Promise<TransferLineRecord[]>
  /** 出库段回写（A-T13-10 两段事实之一：out_qty/out_done + 预留引用）。 */
  markOut(
    id: string,
    patch: { outQty: string; outDone: boolean; outAt: string; reservationId?: string | null },
    actor: string | null,
  ): Promise<TransferLineRecord | null>
  /** 接收段回写（A-T13-10 两段事实之二：in_qty/in_done）。 */
  markIn(
    id: string,
    patch: { inQty: string; inDone: boolean; inAt: string },
    actor: string | null,
  ): Promise<TransferLineRecord | null>
  /** 锁定预留引用回填（submit 时）。 */
  setReservation(id: string, reservationId: string, actor: string | null): Promise<TransferLineRecord | null>
}

// ---------------- 主数据只读查询（0003 表；类型事实供域断言） ----------------

/** 库位事实查询（移库/调拨的仓库归属与库位类型校验）。 */
export interface StorageLocationLookup {
  findById(id: string): Promise<{
    id: string
    warehouseId: string
    code: string
    locationKind: 'NORMAL' | 'RACK'
    status: string
    plantId: string
  } | null>
  /** 仓库下全部活动库位（NORMAL+RACK）的 id 集合（在途对账：两仓不重复统计断言）。 */
  listWarehouseLocationIds(warehouseIds: readonly string[]): Promise<string[]>
}

/** 仓库事实查询（调拨仓库规则）。 */
export interface WarehouseLookup {
  findById(id: string): Promise<{
    enterpriseId: string
    id: string
    code: string
    warehouseType: string
    status: string
    plantId: string
  } | null>
}

/** 料品类型查询（生产调拨料限原料/半成品）。 */
export interface WarehousingMaterialLookup {
  findTypeById(materialId: string): Promise<number | null>
}

// ---------------- 命令工具集扩展 ----------------

/** warehousing 域仓储集合。 */
export interface WarehousingRepositories {
  putawayTasks: PutawayTaskRepository
  moves: WarehouseMoveRepository
  transferOrders: TransferOrderRepository
  transferLines: TransferLineRepository
  locations: StorageLocationLookup
  warehouses: WarehouseLookup
  materials: WarehousingMaterialLookup
}

/**
 * warehousing 命令工具集：InventoryCommandTools 超集 + warehousing 仓储束 +
 * 执行块事件端口（入库任务刷新从端口重跑）。
 */
export interface WarehousingCommandTools extends InventoryCommandTools {
  wh: WarehousingRepositories
  events: ExecutionEventPort
}
