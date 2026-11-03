import type { DecimalString } from './decimal'
import type { PageResult } from './pagination'

/**
 * inventory 域公开线合同（L1-P1-SERVER / T06）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p1/inventory-trace-core.md：
 * - 数量字段一律 DecimalString（IT-07 十进制定点、≤4 位小数，禁 number）；
 * - 命令响应五态见 command.ts CommandResultStatus（IT-22）；
 * - 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）。
 */

// ---------------- 查询侧 DTO ----------------

/** 库存余额视图（IT-02 三分存储；IT-14 可用量三段展示）。 */
export interface InventoryBalanceDto {
  balanceId: string
  unitId: string
  unitNo: string
  materialCode: string
  lotNo: string
  locationId: string
  locationCode: string
  ownerId: string
  ownerName: string
  quantity: DecimalString
  availableQuantity: DecimalString
  reservedQuantity: DecimalString
  uomCode: string
  measurementBasis: string
  conversionRevisionId: string | null
  qualityStatus: 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect'
  legacyStatus: string | null
  status: 'active' | 'closed'
  plantId: string
  /** IT-10：英尺展示列（仅展示、不入账，basis=feet-per-0.3048-exact-display） */
  feetDisplay: DecimalString | null
}

export type InventoryBalancePage = PageResult<InventoryBalanceDto>

/** IT-04：条码解析候选对象。 */
export interface BarcodeCandidateDto {
  objectType: 'inventory_unit' | 'carrier' | 'material_lot' | 'location'
  objectId: string
  label: string
  via: 'direct_binding' | 'carrier_load'
}

/** IT-05：码类型判定结果（配置命中/已知散点/未知；不作主键）。 */
export interface BarcodeKindGuessDto {
  kind: 'carrier' | 'raw_material' | 'finished_goods' | 'shelf' | 'transfer_spool' | 'unknown'
  confidence: 'known' | 'config' | 'unknown'
  matchedPattern: string | null
}

/** 条码解析响应（解析链 barcode → binding → 候选对象集合，由任务显式选择）。 */
export interface BarcodeResolveResponse {
  barcodeValue: string
  kind: BarcodeKindGuessDto
  hasActiveBinding: boolean
  boundType: string | null
  boundId: string | null
  candidates: BarcodeCandidateDto[]
}

/** 库存单元详情（身份 + 余额 + 预留 + 谱系边，IT-01/35）。 */
export interface InventoryUnitDetailDto {
  unitId: string
  unitNo: string
  materialCode: string
  lotId: string
  lotNo: string
  traceMode: 'segment' | 'quantity'
  status: 'in_stock' | 'in_production' | 'in_transit' | 'shipped' | 'exhausted'
  balanceOpen: boolean
  balances: Array<{
    balanceId: string
    locationCode: string
    ownerName: string
    quantity: DecimalString
    qualityStatus: string
    status: string
  }>
  activeReservations: Array<{
    reservationId: string
    holderType: string
    holderRef: string
    quantity: DecimalString
    validUntil: string
  }>
  recentTransactions: Array<{
    transactionId: string
    lineNo: number
    movementKind: string
    quantity: DecimalString
    beforeQty: DecimalString
    afterQty: DecimalString
    businessTime: string
  }>
  genealogy: Array<{
    edgeId: string
    edgeKind: string
    fromType: string
    fromId: string
    toType: string
    toId: string
    quantity: DecimalString
  }>
}

// ---------------- 命令载荷（数量一律 DecimalString，IT-07） ----------------

/** 收货入账载荷（IT-25 确认采购收货一次事务内完成）。 */
export interface ReceiveGoodsPayload {
  lotNo: string
  unitNo: string
  materialId: string
  materialCode: string
  uomId: string
  uomCode: string
  quantity: DecimalString
  measurementBasis: string
  conversionRevisionId?: string | null
  locationId: string
  locationCode: string
  ownerId: string
  ownerName: string
  /** 客供料沿用实际所有者（IT-02） */
  isCustomerSupplied?: boolean
  qualityStatus?: 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect'
  supplierLotNo?: string
  barcodeValue?: string
  businessTime?: string
  reason?: string
}

/** 发料扣减载荷（IT-25 单独投料；预留引用可选，过期必须重校验 IT-23）。 */
export interface IssueMaterialPayload {
  unitId: string
  quantity: DecimalString
  locationId?: string
  ownerId?: string
  reservationId?: string
  refType?: string
  refId?: string
  reason?: string
  businessTime?: string
}

/** 移位载荷（同厂内库位/所有者变动，一命令两行流水：出与入）。 */
export interface MoveStockPayload {
  unitId: string
  quantity: DecimalString
  fromLocationId: string
  fromLocationCode: string
  toLocationId: string
  toLocationCode: string
  fromOwnerId?: string
  toOwnerId?: string
  reason?: string
  businessTime?: string
}

/** 调拨两段步（IT-25：来源减+在途增 / 在途减+目的增，两段各自原子）。 */
export interface TransferOutPayload {
  unitId: string
  quantity: DecimalString
  fromLocationId: string
  fromLocationCode: string
  transitLocationId: string
  transitLocationCode: string
  ownerId?: string
  reason?: string
  businessTime?: string
}

export interface TransferInPayload {
  unitId: string
  quantity: DecimalString
  transitLocationId: string
  transitLocationCode: string
  toLocationId: string
  toLocationCode: string
  ownerId?: string
  reason?: string
  businessTime?: string
}

/** 分盘载荷（IT-28 守恒校验）。 */
export interface SplitStockPayload {
  sourceUnitId: string
  retainedQty: DecimalString
  lossQty: DecimalString
  children: Array<{
    unitNo: string
    quantity: DecimalString
    locationId: string
    locationCode: string
    ownerId?: string
  }>
  reason?: string
  businessTime?: string
}

/** 预留载荷（IT-23 四要素）。 */
export interface ReservationAcquirePayload {
  unitId: string
  quantity: DecimalString
  holderType: 'job' | 'task' | 'order' | 'manual'
  holderRef: string
  validUntil: string
  locationId?: string
  reason?: string
}

export interface ReservationReleasePayload {
  reservationId: string
  releaseReason?: string
}
