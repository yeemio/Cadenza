import type { InventoryCommandTools } from './inventory-repositories'

/**
 * reverse 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0013 表列一一对应；时间字段一律 ISO-8601 字符串；数量一律 DecimalString（IT-07）。
 *
 * ReverseCommandTools = InventoryCommandTools 超集（移库/调拨/调整/所有权/退货冲销复用
 * inv 仓储束与 inventory 记账服务——通过端口注入、同 UoW，IT-18 口径）+ 采购批次只读事实
 * （WR-18～23 等价服务消费 0006 表，收编请求见交付记录 §7）+ 主数据只读查询。
 */

// ---------------- 记录类型（0013 表） ----------------

export interface StockMoveRecordLineRecord {
  id: string
  recordId: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  materialId: string
  materialCode: string
  fromLocationId: string | null
  fromLocationCode: string | null
  toLocationId: string
  toLocationCode: string
  quantity: string
  uomId: string
  uomCode: string
}

export interface StockMoveRecordHeader {
  id: string
  moveNo: string
  warehouseId: string
  warehouseCode: string | null
  toLocationId: string
  toLocationCode: string
  locationKind: string | null
  materialCodesJoined: string
  totalQty: string
  movedBy: string
  movedAt: string
  reason: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
}

export type TransferOutStatusValue = 'pending_out' | 'outbounding' | 'outbounded' | 'cancelled'

export interface TransferOutboundOrderRecord {
  id: string
  orderNo: string
  sourceKind: 'web_task' | 'pda_taskless' | 'auto'
  transferKind: 'production' | 'warehouse'
  relatedOrderNo: string | null
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseCode: string | null
  toWarehouseCode: string | null
  fromWarehouseType: string | null
  toWarehouseType: string | null
  status: TransferOutStatusValue
  toLocationId: string | null
  toLocationCode: string | null
  toLocationKind: string | null
  transitLocationId: string | null
  transitLocationCode: string | null
  shippedBy: string | null
  shippedAt: string | null
  note: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
}

export interface NewTransferOutboundOrder {
  orderNo: string
  sourceKind: TransferOutboundOrderRecord['sourceKind']
  transferKind: TransferOutboundOrderRecord['transferKind']
  relatedOrderNo?: string | null
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseCode?: string | null
  toWarehouseCode?: string | null
  fromWarehouseType?: string | null
  toWarehouseType?: string | null
  status?: TransferOutStatusValue
  toLocationId?: string | null
  toLocationCode?: string | null
  toLocationKind?: string | null
  transitLocationId?: string | null
  transitLocationCode?: string | null
  /** WR-07③ 自动生成单：生成即已出库（出库人/时间随建单写入）。 */
  shippedBy?: string | null
  shippedAt?: string | null
  note?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface TransferOutboundPlanLineRecord {
  id: string
  orderId: string
  lineNo: number
  materialId: string
  materialCode: string
  materialType: number | null
  plannedQty: string
  outQty: string
}

export interface NewTransferOutboundPlanLine {
  orderId: string
  lineNo: number
  materialId: string
  materialCode: string
  materialType?: number | null
  plannedQty: string
  createdBy?: string | null
}

export interface TransferOutboundScanRecord {
  id: string
  orderId: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  materialId: string | null
  materialCode: string | null
  materialType: number | null
  fromLocationId: string | null
  fromLocationCode: string | null
  quantity: string
  outQty: string
  reservationId: string | null
  status: 'loaded' | 'removed'
  scannedBy: string
  scannedAt: string
  removedBy: string | null
  removedAt: string | null
  commandReceiptId: string | null
}

export interface NewTransferOutboundScan {
  orderId: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  materialId?: string | null
  materialCode?: string | null
  materialType?: number | null
  fromLocationId?: string | null
  fromLocationCode?: string | null
  quantity: string
  outQty: string
  reservationId?: string | null
  scannedBy: string
  scannedAt: string
  commandReceiptId?: string | null
}

export interface TransferInboundOrderRecord {
  id: string
  orderNo: string
  outboundOrderId: string
  inboundMode: 'fixed_location' | 'scan_putaway'
  status: 'pending_in' | 'inbounding' | 'completed'
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseCode: string | null
  toWarehouseCode: string | null
  suggestedLocationId: string | null
  suggestedLocationCode: string | null
  shipperSnapshotBy: string | null
  shipperSnapshotAt: string | null
  receivedBy: string | null
  receivedAt: string | null
  completedAt: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
}

export interface NewTransferInboundOrder {
  orderNo: string
  outboundOrderId: string
  inboundMode: TransferInboundOrderRecord['inboundMode']
  status?: TransferInboundOrderRecord['status']
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseCode?: string | null
  toWarehouseCode?: string | null
  suggestedLocationId?: string | null
  suggestedLocationCode?: string | null
  shipperSnapshotBy?: string | null
  shipperSnapshotAt?: string | null
  completedAt?: string | null
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface TransferInboundLineRecord {
  id: string
  orderId: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  materialId: string | null
  materialCode: string | null
  quantity: string
  lineStatus: 'pending' | 'inbound'
  isPalletChild: boolean
  locationId: string | null
  locationCode: string | null
  reservationId: string | null
  inboundAt: string | null
  removedAt: string | null
}

export interface NewTransferInboundLine {
  orderId: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  materialId?: string | null
  materialCode?: string | null
  quantity: string
  isPalletChild?: boolean
  locationId?: string | null
  locationCode?: string | null
  lineStatus?: 'pending' | 'inbound'
  reservationId?: string | null
  inboundAt?: string | null
  createdBy?: string | null
}

export interface StocktakeOrderRecord {
  id: string
  orderNo: string
  warehouseId: string
  warehouseCode: string | null
  locked: boolean
  status: 'counting' | 'completed' | 'cancelled'
  note: string | null
  startedBy: string
  startedAt: string
  closedBy: string | null
  closedAt: string | null
  plantId: string
  enterpriseId: string
}

export interface NewStocktakeOrder {
  orderNo: string
  warehouseId: string
  warehouseCode?: string | null
  note?: string | null
  startedBy: string
  startedAt: string
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface StocktakeCountLineRecord {
  id: string
  orderId: string
  inventoryUnitId: string
  unitNo: string
  materialCode: string | null
  locationId: string | null
  locationCode: string | null
  bookQty: string
  countedQty: string
  diffQty: string
  countedBy: string
  countedAt: string
}

export interface NewStocktakeCountLine {
  orderId: string
  inventoryUnitId: string
  unitNo: string
  materialCode?: string | null
  locationId?: string | null
  locationCode?: string | null
  bookQty: string
  countedQty: string
  diffQty: string
  countedBy: string
  countedAt: string
  commandReceiptId?: string | null
}

export interface StockAdjustmentRecord {
  id: string
  adjustmentNo: string
  stocktakeOrderId: string | null
  reason: string
  destination: string
  totalQty: string
  adjustedBy: string
  adjustedAt: string
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
}

export interface NewStockAdjustment {
  adjustmentNo: string
  stocktakeOrderId?: string | null
  reason: string
  destination: string
  totalQty: string
  adjustedBy: string
  adjustedAt: string
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface StockAdjustmentLineRecord {
  id: string
  adjustmentId: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  locationId: string
  locationCode: string
  ownerId: string
  ownerName: string
  adjustQty: string
  beforeQty: string
  afterQty: string
  transactionId: string | null
  balanceId: string
}

export interface NewStockAdjustmentLine {
  adjustmentId: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  locationId: string
  locationCode: string
  ownerId: string
  ownerName: string
  adjustQty: string
  beforeQty: string
  afterQty: string
  transactionId?: string | null
  balanceId: string
}

export interface CarrierLoanRecord {
  id: string
  carrierId: string
  carrierCode: string
  carrierKind: 'spool' | 'drum' | 'tray' | 'box'
  eventKind: 'lend' | 'take_back' | 'damage' | 'scrap'
  counterparty: string | null
  note: string | null
  occurredBy: string
  occurredAt: string
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
}

export interface NewCarrierLoan {
  carrierId: string
  carrierCode: string
  carrierKind: CarrierLoanRecord['carrierKind']
  eventKind: CarrierLoanRecord['eventKind']
  counterparty?: string | null
  note?: string | null
  occurredBy: string
  occurredAt: string
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface ReceiptCorrectionRecord {
  id: string
  correctionNo: string
  batchId: string
  batchNo: string
  correctionKind: 'void' | 'reverse' | 'return'
  quantity: string
  deductedOrderLineQty: string
  reason: string
  remark: string | null
  attachments: readonly string[]
  returnSyncStatus: 'none' | 'pending' | 'failed' | 'synced'
  snapshot: Record<string, unknown>
  operatedBy: string
  operatedAt: string
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
}

export interface NewReceiptCorrection {
  correctionNo: string
  batchId: string
  batchNo: string
  correctionKind: ReceiptCorrectionRecord['correctionKind']
  quantity: string
  deductedOrderLineQty?: string
  reason: string
  remark?: string | null
  attachments?: readonly string[]
  returnSyncStatus?: ReceiptCorrectionRecord['returnSyncStatus']
  snapshot?: Record<string, unknown>
  operatedBy: string
  operatedAt: string
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

// ---------------- 仓储端口 ----------------

export interface StockMoveRecordRepository {
  insert(
    header: Omit<StockMoveRecordHeader, 'id' | 'createdAt'> & { createdBy?: string | null },
    lines: ReadonlyArray<Omit<StockMoveRecordLineRecord, 'id' | 'recordId'>>,
  ): Promise<{ header: StockMoveRecordHeader; lines: StockMoveRecordLineRecord[] }>
  findById(id: string): Promise<{ header: StockMoveRecordHeader; lines: StockMoveRecordLineRecord[] } | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    unitNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: StockMoveRecordHeader[]; total: number }>
}

export interface TransferOutboundOrderRepository {
  insert(order: NewTransferOutboundOrder): Promise<TransferOutboundOrderRecord>
  findById(id: string): Promise<TransferOutboundOrderRecord | null>
  lockById(id: string): Promise<TransferOutboundOrderRecord | null>
  updateStatus(
    id: string,
    patch: {
      status?: TransferOutStatusValue
      toLocationId?: string | null
      toLocationCode?: string | null
      toLocationKind?: string | null
      /** 在途路径（未选调入库位/跨厂）：完成出库时回写在途库位（WR-12 入库段对账事实）。 */
      transitLocationId?: string | null
      shippedBy?: string | null
      shippedAt?: string | null
      cancelledBy?: string | null
    },
    actor: string | null,
  ): Promise<TransferOutboundOrderRecord | null>
  /** WR-07②：操作人进行中的无任务单（每人同时只能一条）。 */
  findTasklessInProgressByOperator(operator: string): Promise<TransferOutboundOrderRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    includeTasklessInProgress?: boolean
    page: number
    pageSize: number
  }): Promise<{ items: TransferOutboundOrderRecord[]; total: number }>
}

export interface TransferOutboundPlanLineRepository {
  insert(lines: readonly NewTransferOutboundPlanLine[]): Promise<TransferOutboundPlanLineRecord[]>
  listByOrder(orderId: string): Promise<TransferOutboundPlanLineRecord[]>
  replaceOrderLines(
    orderId: string,
    lines: readonly NewTransferOutboundPlanLine[],
    actor: string | null,
  ): Promise<TransferOutboundPlanLineRecord[]>
  addOutQty(orderId: string, materialId: string, delta: string, actor: string | null): Promise<TransferOutboundPlanLineRecord | null>
}

export interface TransferOutboundScanRepository {
  insert(scan: NewTransferOutboundScan): Promise<TransferOutboundScanRecord>
  /** 自动生成调拨（WR-07③）多码一次落扫码事实（同事务多行）。 */
  insertMany(scans: readonly NewTransferOutboundScan[]): Promise<TransferOutboundScanRecord[]>
  listByOrder(orderId: string): Promise<TransferOutboundScanRecord[]>
  findLoadedByUnit(orderId: string, inventoryUnitId: string): Promise<TransferOutboundScanRecord | null>
  markRemoved(id: string, removedBy: string, removedAt: string): Promise<TransferOutboundScanRecord | null>
  setReservation(id: string, reservationId: string | null): Promise<TransferOutboundScanRecord | null>
}

export interface TransferInboundOrderRepository {
  insert(order: NewTransferInboundOrder): Promise<TransferInboundOrderRecord>
  findById(id: string): Promise<TransferInboundOrderRecord | null>
  lockById(id: string): Promise<TransferInboundOrderRecord | null>
  findByOutboundOrder(outboundOrderId: string): Promise<TransferInboundOrderRecord | null>
  updateStatus(
    id: string,
    patch: {
      status?: TransferInboundOrderRecord['status']
      receivedBy?: string | null
      receivedAt?: string | null
      completedAt?: string | null
    },
    actor: string | null,
  ): Promise<TransferInboundOrderRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: TransferInboundOrderRecord[]; total: number }>
}

export interface TransferInboundLineRepository {
  insert(lines: readonly NewTransferInboundLine[]): Promise<TransferInboundLineRecord[]>
  listByOrder(orderId: string): Promise<TransferInboundLineRecord[]>
  findByUnitNo(orderId: string, unitNo: string): Promise<TransferInboundLineRecord | null>
  lockById(id: string): Promise<TransferInboundLineRecord | null>
  markPutaway(
    id: string,
    patch: { lineStatus: 'inbound'; locationId: string; locationCode: string; reservationId?: string | null; inboundAt: string },
    actor: string | null,
  ): Promise<TransferInboundLineRecord | null>
  markReverted(id: string, revertedAt: string, actor: string | null): Promise<TransferInboundLineRecord | null>
}

export interface StocktakeOrderRepository {
  insert(order: NewStocktakeOrder): Promise<StocktakeOrderRecord>
  findById(id: string): Promise<StocktakeOrderRecord | null>
  lockById(id: string): Promise<StocktakeOrderRecord | null>
  /** WR-24①：仓库的活动盘点锁（status='counting' 行 → 盘点锁定中）。 */
  findCountingByWarehouse(warehouseId: string): Promise<StocktakeOrderRecord | null>
  close(
    id: string,
    patch: { status: 'completed' | 'cancelled'; locked: boolean; closedBy: string; closedAt: string },
    actor: string | null,
  ): Promise<StocktakeOrderRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: StocktakeOrderRecord[]; total: number }>
}

export interface StocktakeCountLineRepository {
  insert(lines: readonly NewStocktakeCountLine[]): Promise<StocktakeCountLineRecord[]>
  listByOrder(orderId: string): Promise<StocktakeCountLineRecord[]>
}

export interface StockAdjustmentRepository {
  insert(
    adjustment: NewStockAdjustment,
    lines: ReadonlyArray<Omit<StockAdjustmentLineRecord, 'id' | 'adjustmentId'>>,
  ): Promise<{ adjustment: StockAdjustmentRecord; lines: StockAdjustmentLineRecord[] }>
  findById(id: string): Promise<{ adjustment: StockAdjustmentRecord; lines: StockAdjustmentLineRecord[] } | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    page: number
    pageSize: number
  }): Promise<{ items: StockAdjustmentRecord[]; total: number }>
}

export interface CarrierLoanRepository {
  insert(loan: NewCarrierLoan): Promise<CarrierLoanRecord>
  listByCarrier(carrierId: string): Promise<CarrierLoanRecord[]>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    eventKinds?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: CarrierLoanRecord[]; total: number }>
  /** WR-27/IT-01：清空仅解除当前装载——结束载具当前全部活动装载绑定（历史区间保留）。 */
  endActiveLoads(carrierId: string, unloadedBy: string, reason: string | null, now: string): Promise<number>
}

export interface ReceiptCorrectionRepository {
  insert(correction: NewReceiptCorrection): Promise<ReceiptCorrectionRecord>
  findById(id: string): Promise<ReceiptCorrectionRecord | null>
  /** 同批次同类已存在纠正（防重复退货/作废；作废+冲销可并存）。 */
  findByBatch(batchId: string, kinds: readonly string[]): Promise<ReceiptCorrectionRecord[]>
  latestByBatch(batchId: string): Promise<ReceiptCorrectionRecord | null>
  // WR-S6：receipt_correction 为 append-only 事实（触发器禁止 UPDATE）——回传状态投影在
  // purchase_receipt_batch.return_sync_status 上更新（setBatchReturnSyncStatus），纠正行保留创建时快照。
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    correctionKinds?: string[]
    batchNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: ReceiptCorrectionRecord[]; total: number }>
}

// ---------------- 采购批次只读事实（WR-18～23 等价服务消费 0006 表） ----------------

/** 采购批次事实（0006 purchase_receipt_batch 只读投影）。 */
export interface PurchaseBatchFacts {
  id: string
  batchNo: string
  purchaseLineId: string
  orderNo: string
  lineNo: number
  materialId: string
  materialCode: string
  warehouseId: string
  uomId: string
  uomCode: string
  inspectionStatus: string
  storageStatus: string
  receivedQty: string
  qualifiedSyncStatus: string
  returnSyncStatus: string
  plantId: string
  enterpriseId: string
}

export interface ReceiptDetailFacts {
  id: string
  batchId: string
  barcodeValue: string
  supplierLotNo: string
  grade: string
  quantity: string
  qualityStatus: string
  inventoryUnitId: string | null
  locationId: string | null
  locationCode: string | null
}

export interface PurchaseBatchLookup {
  findById(id: string): Promise<PurchaseBatchFacts | null>
  /** WR-18：码已收货分组事实（系统已记数量——再扫确认弹窗数据源）。 */
  listReceivedGroupsByBarcode(plantId: string, barcodeValue: string): Promise<
    Array<{ batchId: string; batchNo: string; supplierLotNo: string; grade: string; quantity: string }>
  >
  listDetailsByBatch(batchId: string): Promise<ReceiptDetailFacts[]>
  /** WR-20/21：订单行已收扣减/回补（带符号）与状态重算回写（等价服务直写 0006 表，收编请求见交付记录）。 */
  adjustOrderLineReceivedQty(
    purchaseLineId: string,
    delta: string,
    newStatus: number | null,
    actor: string | null,
  ): Promise<{ receivedQty: string; status: number } | null>
  lockOrderLine(purchaseLineId: string): Promise<{ id: string; receivedQty: string; plannedQty: string; status: number } | null>
  /** WR-18/19：批次已收数量累计/回补（带符号）。 */
  adjustBatchReceivedQty(batchId: string, delta: string, actor: string | null): Promise<PurchaseBatchFacts | null>
  /** WR-19：批次到货/入库确认时间与明细仓位/数量更新。 */
  updateBatchTimes(batchId: string, patch: { arrivalTime?: string; confirmTime?: string }, actor: string | null): Promise<PurchaseBatchFacts | null>
  updateDetailStorage(detailId: string, patch: { locationId?: string | null; locationCode?: string | null; quantity?: string }, actor: string | null): Promise<ReceiptDetailFacts | null>
  setBatchReturnState(batchId: string, patch: { storageStatus: 'returned'; returnedAt: string; returnReason: string; returnSyncStatus: 'pending' }, actor: string | null): Promise<PurchaseBatchFacts | null>
  setBatchReturnSyncStatus(batchId: string, status: 'none' | 'pending' | 'failed' | 'synced', actor: string | null): Promise<PurchaseBatchFacts | null>
  insertBatch(input: {
    batchNo: string
    purchaseLineId: string
    orderNo: string
    lineNo: number
    materialId: string
    materialCode: string
    materialType: number | null
    plantId: string
    enterpriseId: string
    warehouseId: string
    uomId: string
    uomCode: string
    inspectionStatus: string
    receivedQty: string
    arrivalTime: string
    confirmTime: string
    receivedBy: string
    createdBy?: string | null
  }): Promise<PurchaseBatchFacts>
  insertDetail(input: {
    batchId: string
    barcodeValue: string
    supplierLotNo: string
    grade: string
    quantity: string
    uomId: string
    uomCode: string
    qualityStatus: string
    inventoryUnitId?: string | null
    locationId?: string | null
    locationCode?: string | null
    createdBy?: string | null
  }): Promise<ReceiptDetailFacts>
  /** WR-18：同组多次保存合并数量（数量相加 UPDATE receipt_detail.quantity）。 */
  mergeDetailQuantity(detailId: string, addQty: string, actor: string | null): Promise<ReceiptDetailFacts | null>
  findDetailByTriple(batchId: string, barcodeValue: string, supplierLotNo: string, grade: string): Promise<ReceiptDetailFacts | null>
  /** WR-22：生效质量结果（inspection_record 生效结论=qualified 的明细）。 */
  listEffectiveQualifiedDetailNos(batchId: string): Promise<string[]>
}

// ---------------- 载具事实（0004 carrier 只读+状态投影；WR-27） ----------------

export interface CarrierFacts {
  id: string
  carrierCode: string
  carrierKind: 'spool' | 'drum' | 'tray' | 'box'
  status: 'in_service' | 'lent_out' | 'returned' | 'damaged' | 'scrapped'
  plantId: string
}

export interface CarrierFactsLookup {
  findById(id: string): Promise<CarrierFacts | null>
  findByCode(plantId: string, carrierCode: string): Promise<CarrierFacts | null>
  /** WR-27：借还事件驱动的载具状态投影更新（carrier.status 列，事件本体 append-only 于 carrier_loan）。 */
  updateStatus(carrierId: string, status: CarrierFacts['status'], actor: string | null): Promise<CarrierFacts | null>
  listAvailable(plantId: string): Promise<CarrierFacts[]>
}

// ---------------- 主数据只读查询（0003 表） ----------------

export interface ReverseWarehouseLookup {
  findById(id: string): Promise<{
    id: string
    code: string
    warehouseType: string
    status: string
    deptId: string | null
    plantId: string
    enterpriseId: string
  } | null>
  /** WR-03：移入库位范围——登录人部门下、已启用、仓库类型（不含线边仓）。deptId=null → 空范围。 */
  listMoveTargetWarehouses(deptId: string | null, plantId: string): Promise<
    Array<{ id: string; code: string; name: string; warehouseType: string }>
  >
  /** WR-11：调入仓库是否存在货架库位（有货架层数未选拒绝）。 */
  hasRackLocations(warehouseId: string): Promise<boolean>
}

export interface ReverseLocationLookup {
  findById(id: string): Promise<{
    id: string
    warehouseId: string
    code: string
    locationKind: 'NORMAL' | 'RACK'
    status: string
    plantId: string
  } | null>
  findByCode(plantId: string, code: string): Promise<{
    id: string
    warehouseId: string
    code: string
    locationKind: 'NORMAL' | 'RACK'
    status: string
    plantId: string
  } | null>
  /** 线边仓直接上架不选库位：解析仓库唯一活动库位（多个须显式）。 */
  listActiveByWarehouse(warehouseId: string): Promise<
    Array<{ id: string; code: string; locationKind: 'NORMAL' | 'RACK' }>
  >
}

export interface ReverseMaterialLookup {
  findTypeById(materialId: string): Promise<number | null>
  findById(id: string): Promise<{ id: string; code: string; materialType: number | null } | null>
}

// ---------------- 命令工具集扩展 ----------------

/** reverse 域仓储集合。 */
export interface ReverseRepositories {
  moveRecords: StockMoveRecordRepository
  outOrders: TransferOutboundOrderRepository
  outPlanLines: TransferOutboundPlanLineRepository
  outScans: TransferOutboundScanRepository
  inOrders: TransferInboundOrderRepository
  inLines: TransferInboundLineRepository
  stocktakes: StocktakeOrderRepository
  countLines: StocktakeCountLineRepository
  adjustments: StockAdjustmentRepository
  carrierLoans: CarrierLoanRepository
  corrections: ReceiptCorrectionRepository
  pur: PurchaseBatchLookup
  carrierFacts: CarrierFactsLookup
  warehouses: ReverseWarehouseLookup
  locations: ReverseLocationLookup
  materials: ReverseMaterialLookup
}

/** reverse 命令工具集：InventoryCommandTools 超集 + reverse 仓储束。 */
export interface ReverseCommandTools extends InventoryCommandTools {
  rv: ReverseRepositories
}
