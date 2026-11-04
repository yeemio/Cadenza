import type { MovementKind } from '@cadenza/domain'
import type { CommandTools } from './command-bus'
import type { OutboxIntent } from './unit-of-work'

/**
 * inventory 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0004 表列一一对应；时间字段一律 ISO-8601 字符串；
 * 数量字段一律 DecimalString（IT-07），映射自 numeric(18,4) 列（pg 以字符串返回，保真）。
 */

// ---------------- 记录类型 ----------------

export interface MaterialLotRecord {
  id: string
  lotNo: string
  kind: 'purchase' | 'production'
  materialId: string
  materialCode: string
  supplierLotNo: string | null
  supplierId: string | null
  externalDocNo: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  note: string | null
  createdAt: string
  createdBy: string | null
}

export interface NewMaterialLot {
  id?: string
  lotNo: string
  kind: 'purchase' | 'production'
  materialId: string
  materialCode: string
  supplierLotNo?: string | null
  supplierId?: string | null
  externalDocNo?: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  note?: string | null
  createdBy?: string | null
}

export interface InventoryUnitRecord {
  id: string
  unitNo: string
  materialId: string
  materialCode: string
  lotId: string
  uomId: string
  uomCode: string
  traceMode: 'segment' | 'quantity'
  status: 'in_stock' | 'in_production' | 'in_transit' | 'shipped' | 'exhausted'
  balanceOpen: boolean
  balanceClosedAt: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
}

export interface NewInventoryUnit {
  id?: string
  unitNo: string
  materialId: string
  materialCode: string
  lotId: string
  uomId: string
  uomCode: string
  traceMode?: 'segment' | 'quantity'
  status?: 'in_stock' | 'in_production' | 'in_transit' | 'shipped' | 'exhausted'
  plantId: string
  enterpriseId: string
  businessTime: string
  createdBy?: string | null
}

export interface InventoryUnitStatusPatch {
  status?: InventoryUnitRecord['status']
  balanceOpen?: boolean
  balanceClosedAt?: string | null
}

export interface MaterialSegmentRecord {
  id: string
  unitId: string
  seqNo: number
  kind: 'continuous' | 'independent'
  lengthStart: string | null
  lengthEnd: string | null
  quantity: string
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
}

export interface NewMaterialSegment {
  id?: string
  unitId: string
  seqNo: number
  kind?: 'continuous' | 'independent'
  lengthStart?: string | null
  lengthEnd?: string | null
  quantity: string
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId?: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdBy?: string | null
}

export interface StockBalanceRecord {
  id: string
  unitId: string
  locationId: string
  locationCode: string
  ownerId: string
  ownerName: string
  quantity: string
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId: string | null
  qualityStatus: 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect'
  legacyStatus: string | null
  status: 'active' | 'closed'
  closedAt: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
}

export interface NewStockBalance {
  id?: string
  unitId: string
  locationId: string
  locationCode: string
  ownerId: string
  ownerName: string
  quantity: string
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId?: string | null
  qualityStatus?: StockBalanceRecord['qualityStatus']
  legacyStatus?: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdBy?: string | null
}

export interface StockBalancePatch {
  quantity?: string
  qualityStatus?: StockBalanceRecord['qualityStatus']
  status?: 'active' | 'closed'
  closedAt?: string | null
}

export interface StockTransactionRecord {
  id: string
  commandReceiptId: string
  lineNo: number
  movementKind:
    | 'receive'
    | 'issue'
    | 'move'
    | 'transfer_out'
    | 'transfer_in'
    | 'split'
    | 'merge'
    | 'adjust'
    | 'reverse'
  unitId: string
  lotId: string | null
  balanceId: string | null
  fromLocationId: string | null
  fromLocationCode: string | null
  toLocationId: string | null
  toLocationCode: string | null
  fromOwnerId: string | null
  fromOwnerName: string | null
  toOwnerId: string | null
  toOwnerName: string | null
  quantity: string
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId: string | null
  beforeQty: string
  afterQty: string
  refType: string | null
  refId: string | null
  reason: string | null
  businessTime: string
  shiftDate: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
}

export interface NewStockTransaction {
  id?: string
  commandReceiptId: string
  lineNo: number
  movementKind: StockTransactionRecord['movementKind']
  unitId: string
  lotId?: string | null
  balanceId?: string | null
  fromLocationId?: string | null
  fromLocationCode?: string | null
  toLocationId?: string | null
  toLocationCode?: string | null
  fromOwnerId?: string | null
  fromOwnerName?: string | null
  toOwnerId?: string | null
  toOwnerName?: string | null
  quantity: string
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId?: string | null
  beforeQty: string
  afterQty: string
  refType?: string | null
  refId?: string | null
  reason?: string | null
  businessTime: string
  shiftDate?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface StockEntryRecord {
  id: string
  transactionId: string
  entryNo: number
  balanceId: string
  unitId: string
  locationId: string
  locationCode: string
  ownerId: string
  ownerName: string
  lotId: string | null
  segmentId: string | null
  quantityDelta: string
  beforeQty: string
  afterQty: string
  purpose: string | null
  createdAt: string
}

export interface NewStockEntry {
  transactionId: string
  entryNo: number
  balanceId: string
  unitId: string
  locationId: string
  locationCode: string
  ownerId: string
  ownerName: string
  lotId?: string | null
  segmentId?: string | null
  quantityDelta: string
  beforeQty: string
  afterQty: string
  purpose?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface ReservationRecord {
  id: string
  unitId: string
  locationId: string | null
  holderType: 'job' | 'task' | 'order' | 'manual'
  holderRef: string
  quantity: string
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId: string | null
  status: 'active' | 'released' | 'expired' | 'consumed'
  validUntil: string
  acquiredAt: string
  commandReceiptId: string | null
  releasedAt: string | null
  releasedBy: string | null
  releaseReason: string | null
  plantId: string
  enterpriseId: string
  /** Persisted issuer; a known reservation UUID alone conveys no consumption authority. */
  createdBy: string | null
}

export interface NewReservation {
  id?: string
  unitId: string
  locationId?: string | null
  holderType: 'job' | 'task' | 'order' | 'manual'
  holderRef: string
  quantity: string
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId?: string | null
  validUntil: string
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface BarcodeLabelRecord {
  id: string
  barcodeValue: string
  labelKind: string
  formatVersion: number | null
  status: 'active' | 'voided'
  reprintOf: string | null
  reprintReason: string | null
  voidedAt: string | null
  voidedReason: string | null
  printedAt: string | null
  printedBy: string | null
  printChannel: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
}

export interface NewBarcodeLabel {
  id?: string
  barcodeValue: string
  labelKind: string
  formatVersion?: number | null
  status?: 'active' | 'voided'
  reprintOf?: string | null
  reprintReason?: string | null
  printedBy?: string | null
  printChannel?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface BarcodeBindingRecord {
  id: string
  barcodeValue: string
  boundType: 'inventory_unit' | 'carrier' | 'material_lot' | 'location'
  boundId: string
  active: boolean
  boundAt: string
  boundBy: string | null
  unboundAt: string | null
  unboundBy: string | null
  unbindReason: string | null
  plantId: string
  enterpriseId: string
}

export interface NewBarcodeBinding {
  barcodeValue: string
  boundType: BarcodeBindingRecord['boundType']
  boundId: string
  boundBy?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface GenealogyEdgeRecord {
  id: string
  fromType: 'material_lot' | 'inventory_unit' | 'material_segment'
  fromId: string
  toType: 'inventory_unit' | 'material_segment' | 'customer_segment'
  toId: string
  edgeKind: 'receipt_origin' | 'consumption' | 'production_output' | 'customer_binding'
  quantity: string
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId: string | null
  commandReceiptId: string | null
  businessTime: string
  plantId: string
  enterpriseId: string
  createdAt: string
}

export interface NewGenealogyEdge {
  fromType: GenealogyEdgeRecord['fromType']
  fromId: string
  toType: GenealogyEdgeRecord['toType']
  toId: string
  edgeKind: GenealogyEdgeRecord['edgeKind']
  quantity: string
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId?: string | null
  commandReceiptId?: string | null
  businessTime: string
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface CarrierRecord {
  id: string
  carrierCode: string
  carrierKind: 'spool' | 'drum' | 'tray' | 'box'
  status: 'in_service' | 'lent_out' | 'returned' | 'damaged' | 'scrapped'
  capacity: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
}

export interface CarrierBindingRecord {
  id: string
  carrierId: string
  unitId: string
  effectiveFrom: string
  effectiveTo: string | null
  loadedBy: string | null
  unloadedBy: string | null
  unloadReason: string | null
  plantId: string
  enterpriseId: string
}

// ---------------- 仓储端口 ----------------

export interface MaterialLotRepository {
  findById(id: string): Promise<MaterialLotRecord | null>
  findByNo(plantId: string, lotNo: string): Promise<MaterialLotRecord | null>
  insert(lot: NewMaterialLot): Promise<MaterialLotRecord>
}

export interface InventoryBusinessHoldRecord {
  id: string
  unitId: string
  enterpriseId: string
  plantId: string
  reason: string
  businessRef: string
  commandReceiptId: string
  actorUserId: string
  actorLoginName: string
  createdAt: string
}

export interface InventoryUnitRepository {
  hasActiveQualityHold(unitId: string): Promise<boolean>
  businessHolds(unitId: string): Promise<InventoryBusinessHoldRecord[]>
  insertBusinessHold(input: Omit<InventoryBusinessHoldRecord, 'id' | 'createdAt'> & { createdAt: string }): Promise<InventoryBusinessHoldRecord>

  findById(id: string): Promise<InventoryUnitRecord | null>
  findByUnitNo(plantId: string, unitNo: string): Promise<InventoryUnitRecord | null>
  /** 企业范围反查（unit_no 按 plant 唯一；企业范围授权的查询端点使用）。 */
  findByUnitNoEnterprise(enterpriseId: string, unitNo: string): Promise<InventoryUnitRecord | null>
  insert(unit: NewInventoryUnit): Promise<InventoryUnitRecord>
  /**
   * IT-25/IT-27/IT-15：按稳定次序（id 升序）行锁库存单元（SELECT ... FOR UPDATE）。
   * 主事务内、校验实时可用量之前调用；同码并发消费在此串行化。
   */
  lockForUpdate(unitIds: readonly string[]): Promise<InventoryUnitRecord[]>
  findTransferDestination(plantId: string, ownerId: string, locationId: string): Promise<{ plantId: string; enterpriseId: string; ownerId: string; ownerName: string; locationCode: string } | null>
  isTransferOutBalance(unitId: string, balanceId: string, plantId: string): Promise<boolean>
  receiveAtPlant(id: string, plantId: string, actor: string): Promise<void>
  updateStatus(id: string, patch: InventoryUnitStatusPatch, actor: string | null): Promise<InventoryUnitRecord | null>
}

export interface MaterialSegmentRepository {
  insert(segment: NewMaterialSegment): Promise<MaterialSegmentRecord>
  listByUnit(unitId: string): Promise<MaterialSegmentRecord[]>
}

export interface StockBalanceRepository {
  findByKey(unitId: string, locationId: string, ownerId: string): Promise<StockBalanceRecord | null>
  /** 行锁余额行（IT-20：交易决策用的余额在主事务内实时更新）。 */
  lockByKey(unitId: string, locationId: string, ownerId: string): Promise<StockBalanceRecord | null>
  listActiveByUnit(unitId: string): Promise<StockBalanceRecord[]>
  /** 最近一条余额（含 closed——退料/谱系回溯用；无任何余额历史返回 null）。 */
  findLatestByUnit(unitId: string): Promise<StockBalanceRecord | null>
  insert(balance: NewStockBalance): Promise<StockBalanceRecord>
  adjust(balanceId: string, patch: StockBalancePatch, actor: string | null): Promise<StockBalanceRecord | null>
  listPaged(filter: {
    enterpriseId: string
    plantIds: string[] | null
    plantId?: string
    unitNoLike?: string
    materialCode?: string
    includeClosed: boolean
    page: number
    pageSize: number
  }): Promise<{ items: StockBalanceRecord[]; total: number }>
}

export interface StockTransactionRepository {
  insertLine(line: NewStockTransaction): Promise<StockTransactionRecord>
  insertEntry(entry: NewStockEntry): Promise<StockEntryRecord>
  listByUnit(unitId: string, limit: number): Promise<StockTransactionRecord[]>
  countLinesByReceipt(commandReceiptId: string): Promise<number>
  /** 按 movement_kind（可选 ref_type）聚合该单元流水量的十进制字符串（退料防超退守恒校验用）。 */
  sumQuantityByUnit(unitId: string, filter: { movementKind: MovementKind; refType?: string }): Promise<string>
}

export interface ReservationRepository {
  insert(reservation: NewReservation): Promise<ReservationRecord>
  findById(id: string): Promise<ReservationRecord | null>
  /** 状态 active 的行（含已过 valid_until 的——由域规则 isReservationEffective 判定有效性，IT-23）。 */
  listActiveByUnit(unitId: string): Promise<ReservationRecord[]>
  /** 释放（IT-23 释放记录：released_by/reason 必留痕；行不删除）。 */
  release(id: string, releasedBy: string, releaseReason: string | null, now: string): Promise<ReservationRecord | null>
  /** 消费（发料核销预留；部分消费按剩余量缩减数量）。 */
  consume(id: string, consumedQty: string, now: string, actor: string | null): Promise<ReservationRecord | null>
}

export interface BarcodeRepository {
  insertLabel(label: NewBarcodeLabel): Promise<BarcodeLabelRecord>
  listLabelsByValue(barcodeValue: string): Promise<BarcodeLabelRecord[]>
  /** IT-06：同码值至多一条活动绑定。 */
  findActiveBindingByValue(barcodeValue: string): Promise<BarcodeBindingRecord | null>
  insertBinding(binding: NewBarcodeBinding): Promise<BarcodeBindingRecord>
  unbind(bindingId: string, unboundBy: string, reason: string | null, now: string): Promise<BarcodeBindingRecord | null>
  listFormatRules(): Promise<Array<{ formatVersion: number; labelKind: string; pattern: string; active: boolean }>>
}

export interface CarrierRepository {
  insertCarrier(input: {
    carrierCode: string
    carrierKind: CarrierRecord['carrierKind']
    plantId: string
    enterpriseId: string
    createdBy?: string | null
  }): Promise<CarrierRecord>
  findById(id: string): Promise<CarrierRecord | null>
  /** 当前装载（effective_to IS NULL）绑定。 */
  findActiveLoadBindingByUnit(unitId: string): Promise<CarrierBindingRecord | null>
  loadCarrier(input: {
    carrierId: string
    unitId: string
    loadedBy: string | null
    plantId: string
    enterpriseId: string
  }): Promise<CarrierBindingRecord>
  unloadCurrentLoad(unitId: string, unloadedBy: string, reason: string | null, now: string): Promise<CarrierBindingRecord | null>
  /** 载具当前装载的单元（IT-04 候选展开）。 */
  listLoadedUnits(carrierId: string): Promise<Array<{ unitId: string; unitNo: string }>>
}

export interface GenealogyRepository {
  insertEdge(edge: NewGenealogyEdge): Promise<GenealogyEdgeRecord>
  listForward(fromType: string, fromId: string): Promise<GenealogyEdgeRecord[]>
  listBackward(toType: string, toId: string): Promise<GenealogyEdgeRecord[]>
}

/** 命令回执引用（PgCommandBus 在同事务插入 command_receipt 后，处理器按幂等键回查其 id）。 */
export interface CommandReceiptRefRepository {
  findIdByKey(enterpriseId: string, commandType: string, operationId: string): Promise<string | null>
}

// ---------------- 命令工具集扩展 ----------------

/** 出站事件收集端口（与业务变更同事务写入 0001 outbox 表；实现由组合根提供）。 */
export interface OutboxCollector {
  collect(intent: OutboxIntent): void
}

/** inventory 域仓储集合。 */
export interface InventoryRepositories {
  receipts: CommandReceiptRefRepository
  lots: MaterialLotRepository
  units: InventoryUnitRepository
  segments: MaterialSegmentRepository
  balances: StockBalanceRepository
  transactions: StockTransactionRepository
  reservations: ReservationRepository
  barcodes: BarcodeRepository
  carriers: CarrierRepository
  genealogy: GenealogyRepository
}

/**
 * inventory 命令工具集：在 org 域 CommandTools 基础上追加库存仓储与 Outbox 收集。
 * 组合根构造（仓储绑定命令总线事务客户端）；处理器以本接口窄化接收。
 */
export interface InventoryCommandTools extends CommandTools {
  inv: InventoryRepositories
  outbox: OutboxCollector
}
