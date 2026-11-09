import type { OutboxIntent } from './unit-of-work'
import type { InventoryCommandTools } from './inventory-repositories'

/**
 * shipping 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0010 shipping 表列一一对应；时间字段一律 ISO-8601 字符串；
 * 数量/段长字段一律 DecimalString（IT-07）。
 *
 * ShippingCommandTools = InventoryCommandTools 超集（确认出库复用 inv 仓储束与
 * inventory 记账序——通过端口注入、同 UoW，IT-18 库存域唯一维护方口径）+
 * shipping 仓储束 + 状态感知 Outbox 收集器（IF-00.4：noop_needed 初态）。
 */

// ---------------- 记录类型 ----------------

export interface ShipmentOrderRecord {
  id: string
  plNo: string
  salesOrderNo: string
  customerName: string | null
  sourceSystem: string
  externalRevision: number | null
  status: 'pending_packing' | 'ready_to_ship' | 'shipped'
  compositionMissing: boolean
  outboundBy: string | null
  outboundAt: string | null
  actualAxisSyncStatus: 'pending' | 'synced' | 'sync_failed' | 'noop_needed'
  shippingStatusSyncStatus: 'pending' | 'synced' | 'sync_failed'
  actualAxisSnapshot: Record<string, unknown> | null
  statusSyncSnapshot: Record<string, unknown> | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewShipmentOrder {
  plNo: string
  salesOrderNo: string
  customerName?: string | null
  sourceSystem?: string
  externalRevision?: number | null
  compositionMissing?: boolean
  plantId: string
  enterpriseId: string
  businessTime?: string
  createdBy?: string | null
  commandReceiptId?: string | null
}

export type ShipmentLineKindValue = 'pallet' | 'axis_item' | 'plain_item'

export interface ShipmentLineRecord {
  id: string
  shipmentOrderId: string
  lineNo: number
  lineKind: ShipmentLineKindValue
  materialId: string | null
  materialCode: string
  salesOrderLineNo: string
  customerAxisNo: string | null
  standardSegmentLength: string | null
  actualSegmentLength: string | null
  segmentLength: string | null
  requiredCount: number
  scannedCount: number
  lineStatus: 'pending_packing' | 'packed'
  packingStatus: 'pending' | 'bound' | null
  packingOrderId: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewShipmentLine {
  shipmentOrderId: string
  lineNo: number
  lineKind: ShipmentLineKindValue
  materialId?: string | null
  materialCode: string
  salesOrderLineNo: string
  customerAxisNo?: string | null
  standardSegmentLength?: string | null
  segmentLength?: string | null
  requiredCount: number
  packingStatus?: 'pending' | 'bound' | null
  packingOrderId?: string | null
  createdBy?: string | null
}

export interface PackingOrderRecord {
  id: string
  packingNo: string
  shipmentOrderId: string
  palletCode: string
  toLocationId: string
  toLocationCode: string
  status: 'pending' | 'bound' | 'cancelled'
  boundBy: string | null
  boundAt: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewPackingOrder {
  packingNo: string
  shipmentOrderId: string
  palletCode: string
  toLocationId: string
  toLocationCode: string
  plantId: string
  enterpriseId: string
  businessTime?: string
  createdBy?: string | null
  commandReceiptId?: string | null
}

export interface PackingScanRecord {
  id: string
  shipmentOrderId: string
  shipmentLineId: string
  scanKind: 'load' | 'supplement'
  inventoryUnitId: string | null
  unitNo: string
  customerAxisNo: string | null
  actualSegmentLength: string | null
  scannedBy: string
  scannedAt: string
  deleted: boolean
  deletedBy: string | null
  deletedAt: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
}

export interface NewPackingScan {
  shipmentOrderId: string
  shipmentLineId: string
  scanKind: PackingScanRecord['scanKind']
  inventoryUnitId?: string | null
  unitNo: string
  customerAxisNo?: string | null
  actualSegmentLength?: string | null
  scannedBy: string
  scannedAt: string
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  businessTime?: string
  createdBy?: string | null
}

export interface ShipmentPhotoRecord {
  id: string
  shipmentOrderId: string
  fileName: string
  storageKey: string
  contentType: string | null
  sizeBytes: number | null
  uploadedBy: string
  uploadedAt: string
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
}

export interface NewShipmentPhoto {
  shipmentOrderId: string
  fileName: string
  storageKey: string
  contentType?: string | null
  sizeBytes?: number | null
  uploadedBy: string
  uploadedAt: string
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface DcCompositionRecord {
  id: string
  dcId: string
  salesOrderNo: string
  lineNo: number
  sourceSystem: string
  externalRevision: number | null
  syncStatus: 'received' | 'missing' | 'failed'
  composition: Record<string, unknown> | null
  missingMarkedAt: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewDcComposition {
  dcId: string
  salesOrderNo: string
  lineNo: number
  sourceSystem?: string
  externalRevision?: number | null
  syncStatus?: DcCompositionRecord['syncStatus']
  composition?: Record<string, unknown> | null
  missingMarkedAt?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

// ---------------- 仓储端口 ----------------

export interface ShipmentOrderRepository {
  insert(order: NewShipmentOrder): Promise<ShipmentOrderRecord>
  findById(id: string): Promise<ShipmentOrderRecord | null>
  /** IF-00.2/IF-05：发货单号幂等查重（重复下发幂等返回）。 */
  findByPlNo(plNo: string): Promise<ShipmentOrderRecord | null>
  /** 行锁（扫码/确认出库/回传重试前锁定，防状态机并发步进）。 */
  lockById(id: string): Promise<ShipmentOrderRecord | null>
  /** 状态机推进（含扫码重推待出库/退回待装箱）。 */
  updateStatus(
    id: string,
    patch: { status: ShipmentOrderRecord['status'] },
    actor: string | null,
  ): Promise<ShipmentOrderRecord | null>
  /** A-T14-7/8：确认出库落库（出库人/完成时间/双回传状态列/双时点快照）。 */
  markShipped(
    id: string,
    patch: {
      outboundBy: string
      outboundAt: string
      actualAxisSyncStatus: ShipmentOrderRecord['actualAxisSyncStatus']
      shippingStatusSyncStatus: ShipmentOrderRecord['shippingStatusSyncStatus']
      actualAxisSnapshot: Record<string, unknown>
      statusSyncSnapshot: Record<string, unknown>
    },
    actor: string | null,
  ): Promise<ShipmentOrderRecord | null>
  /** 回传重试状态推进（两列各自独立）。 */
  updateSyncStatus(
    id: string,
    patch: {
      actualAxisSyncStatus?: ShipmentOrderRecord['actualAxisSyncStatus']
      shippingStatusSyncStatus?: ShipmentOrderRecord['shippingStatusSyncStatus']
    },
    actor: string | null,
  ): Promise<ShipmentOrderRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    plNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: ShipmentOrderRecord[]; total: number }>
}

export interface ShipmentLineRepository {
  insert(line: NewShipmentLine): Promise<ShipmentLineRecord>
  findById(id: string): Promise<ShipmentLineRecord | null>
  lockById(id: string): Promise<ShipmentLineRecord | null>
  listByOrder(shipmentOrderId: string): Promise<ShipmentLineRecord[]>
  /** 扫码进度回写（已扫数/行状态；补码同用；确认出库前实际段长回填）。 */
  updateProgress(
    id: string,
    patch: {
      scannedCount: number
      lineStatus: ShipmentLineRecord['lineStatus']
      actualSegmentLength?: string | null
      packingOrderId?: string | null
      packingStatus?: 'pending' | 'bound'
    },
    actor: string | null,
  ): Promise<ShipmentLineRecord | null>
}

export interface PackingOrderRepository {
  insert(order: NewPackingOrder): Promise<PackingOrderRecord>
  findById(id: string): Promise<PackingOrderRecord | null>
  lockById(id: string): Promise<PackingOrderRecord | null>
  listByShipment(shipmentOrderId: string): Promise<PackingOrderRecord[]>
  /** A-T14-4：已打包托码查询（库位只读断言事实）。 */
  findBoundByPallet(palletCode: string): Promise<PackingOrderRecord | null>
  bind(id: string, patch: { boundBy: string; boundAt: string }, actor: string | null): Promise<PackingOrderRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    palletCodeLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: PackingOrderRecord[]; total: number }>
}

export interface PackingScanRepository {
  insert(scan: NewPackingScan): Promise<PackingScanRecord>
  findById(id: string): Promise<PackingScanRecord | null>
  listByOrder(shipmentOrderId: string): Promise<PackingScanRecord[]>
  listByLine(shipmentLineId: string): Promise<PackingScanRecord[]>
  /** 同码同单活动装入查重（partial unique 口径）。 */
  findActiveByOrderAndUnitNo(shipmentOrderId: string, unitNo: string): Promise<PackingScanRecord | null>
  /** 删码标记（A-T14-3：标记留痕非物理删；库级触发器保护事实列）。 */
  markDeleted(id: string, patch: { deletedBy: string; deletedAt: string }, actor: string | null): Promise<PackingScanRecord | null>
}

export interface ShipmentPhotoRepository {
  insert(photo: NewShipmentPhoto): Promise<ShipmentPhotoRecord>
  listByOrder(shipmentOrderId: string): Promise<ShipmentPhotoRecord[]>
}

export interface DcCompositionRepository {
  insert(record: NewDcComposition): Promise<DcCompositionRecord>
  /** IF-04 业务键幂等查重：dcId+销售订单号+行号。 */
  findByKey(dcId: string, salesOrderNo: string, lineNo: number): Promise<DcCompositionRecord | null>
  /** 组成数据补齐（missing→received；同步失败可重试）。 */
  applyComposition(
    id: string,
    patch: { composition: Record<string, unknown> | null; syncStatus: DcCompositionRecord['syncStatus'] },
    actor: string | null,
  ): Promise<DcCompositionRecord | null>
  listBySalesOrder(salesOrderNo: string): Promise<DcCompositionRecord[]>
}

// ---------------- Outbox 扩展（IF-00.4 noop_needed 初态 + 0001 表任务行读写） ----------------

/**
 * 状态感知 Outbox 收集器：结构兼容 OutboxCollector（collect(intent) 单参调用合法），
 * 追加可选初态——实发轴无差异时任务行直接以 NOOP_NEEDED 落库（无需同步不是失败态）。
 */
export interface ShippingOutboxCollector {
  collect(intent: OutboxIntent, opts?: { status?: 'PENDING' | 'NOOP_NEEDED' }): void
}

/** 0001 outbox 表的窄读写端口（回传重试命令定位/推进任务行；复合身份 聚合+任务种类 IF-00.5）。 */
export interface OutboxTaskAccess {
  findLatestByTask(aggregateType: string, aggregateId: string, taskKind: string): Promise<{
    eventId: string
    status: string
    payload: Record<string, unknown>
    attemptCount: number
  } | null>
  /** 模拟适配器推进（P1 全部路由指向模拟适配器，GAP-B7）：成功→DISPATCHED、失败→SYNC_FAILED。 */
  markStatus(
    eventId: string,
    patch: { status: 'DISPATCHED' | 'SYNC_FAILED' | 'NOOP_NEEDED'; lastError?: string | null },
  ): Promise<void>
}

/** 隔离队列写入（IF-00.8：缺组织映射的入站数据进隔离态，非普通失败重试；0001 inbox 表）。 */
export interface QuarantinedInboxWriter {
  insertQuarantinedInbox(input: {
    sourceSystem: string
    organizationCode: string
    externalKey: string
    entityType: string
    quarantineReason: string
    payload: Record<string, unknown>
  }): Promise<void>
}

// ---------------- 命令工具集扩展 ----------------

/** shipping 域仓储集合。 */
export interface ShippingRepositories {
  fulfilment: {
    /** Current approved output provenance; null means unknown/ambiguous, never inferred from a shipment line. */
    originForUnit(unitId: string): Promise<{
      enterpriseId: string; plantId: string; materialId: string; salesOrderNo: string; salesOrderLineNo: string
      uomCode: string; segmentLength: string | null; customerAxisNo: string | null; sourceOrderIds: string[]
    } | null>
  }
  orders: ShipmentOrderRepository
  lines: ShipmentLineRepository
  packings: PackingOrderRepository
  scans: PackingScanRepository
  photos: ShipmentPhotoRepository
  compositions: DcCompositionRepository
  outboxTasks: OutboxTaskAccess
  quarantinedInbox: QuarantinedInboxWriter
}

/**
 * shipping 命令工具集：InventoryCommandTools 超集（outbox 收集器窄化为状态感知版——
 * 结构兼容），追加 shipping 仓储束。
 */
export interface ShippingCommandTools extends InventoryCommandTools {
  sp: ShippingRepositories
  outbox: ShippingOutboxCollector
}
