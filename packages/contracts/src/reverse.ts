import type { DecimalString } from './decimal'
import type { PageResult } from './pagination'

/**
 * reverse 域公开线合同（P2-C / T17 仓储异常与逆向：移库/调拨出入库/盘点/采购批次纠正/
 * 客户所有物三分/载具借还）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p2/warehouse-reverse.md（WR-01～WR-28）；
 * 数量字段一律 DecimalString（IT-07 口径随行：十进制定点、≤4 位小数，禁 number）。
 * 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）。
 */

// ---------------- 状态字典值 ----------------

/** 调出侧状态三值（WR-13：调出侧投影，映射 DM 状态机前四段）。 */
export type TransferOutStatusValue = 'pending_out' | 'outbounding' | 'outbounded' | 'cancelled'

/** 调拨三来源（WR-07）：Web 有任务 / PDA 无任务首扫建单 / 其它模块自动生成。 */
export type TransferOutSourceKindValue = 'web_task' | 'pda_taskless' | 'auto'

/** 调拨入库方式（WR-14：固定库位=厂内即时转仓生成即已完成；扫码上架=需交接/跨厂）。 */
export type TransferInModeValue = 'fixed_location' | 'scan_putaway'

/** 调拨入库单状态（WR-16/17）。 */
export type TransferInStatusValue = 'pending_in' | 'inbounding' | 'completed'

/** 码入库状态列（WR-S3）。 */
export type TransferInLineStatusValue = 'pending' | 'inbound'

/** 盘点单状态（WR-24，[合同新造·最小语义]；全流程 GAP-F10 待裁）。 */
export type StocktakeStatusValue = 'counting' | 'completed' | 'cancelled'

/** 采购批次纠正种类（WR-S6：作废/冲销/退货三类）。 */
export type ReceiptCorrectionKindValue = 'void' | 'reverse' | 'return'

/** 载具借还事件（WR-27：借出/回收/损坏/报废，append-only）。 */
export type CarrierLoanEventKindValue = 'lend' | 'take_back' | 'damage' | 'scrap'

// ---------------- 查询侧 DTO ----------------

/** 移库台账行（WR-05：查询＋详情只读；详情为提交时快照）。 */
export interface StockMoveRecordDto {
  recordId: string
  moveNo: string
  warehouseId: string
  warehouseCode: string | null
  toLocationId: string
  toLocationCode: string
  locationKind: string | null
  materialCodesJoined: string
  totalQty: DecimalString
  movedBy: string
  movedAt: string
  plantId: string
}

/** 移库明细行（WR-S1：原/现库位快照列）。 */
export interface StockMoveRecordLineDto {
  lineNo: number
  unitNo: string
  materialCode: string
  fromLocationCode: string | null
  toLocationCode: string
  quantity: DecimalString
}

/** 调拨出库单视图（WR-06～13；无任务单完成出库前 Web 不显示，WR-07②）。 */
export interface TransferOutboundOrderDto {
  orderId: string
  orderNo: string
  sourceKind: TransferOutSourceKindValue
  transferKind: 'production' | 'warehouse'
  relatedOrderNo: string | null
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseCode: string | null
  toWarehouseCode: string | null
  status: TransferOutStatusValue
  statusLabel: string
  toLocationId: string | null
  toLocationCode: string | null
  visibleOnWeb: boolean
  shippedBy: string | null
  shippedAt: string | null
  scannedCount: number
  totalOutQty: DecimalString
  plantId: string
  createdAt: string
}

/** 调拨出库明细（WR-S2：码、原库位、数量、调出数量）。 */
export interface TransferOutboundScanDto {
  scanId: string
  lineNo: number
  unitNo: string
  materialCode: string | null
  fromLocationCode: string | null
  quantity: DecimalString
  outQty: DecimalString
  status: 'loaded' | 'removed'
  scannedBy: string
  scannedAt: string
}

/** 调拨入库单视图（WR-14～17：入库方式列＋码入库状态列）。 */
export interface TransferInboundOrderDto {
  orderId: string
  orderNo: string
  outboundOrderNo: string | null
  inboundMode: TransferInModeValue
  inboundModeLabel: string
  status: TransferInStatusValue
  statusLabel: string
  fromWarehouseCode: string | null
  toWarehouseId: string
  toWarehouseCode: string | null
  /** 固定库位完成单：出库方身份快照（生成即已完成、入库人/时间=出库方，WR-14/WR-S3）。 */
  completedBy: string | null
  completedAt: string | null
  /** 跨厂签收：独立接收事实（接收方身份≠出库方时即跨厂签收证据，WR-14）。 */
  inboundLines: ReadonlyArray<{
    unitNo: string
    materialCode: string | null
    quantity: DecimalString
    lineStatus: TransferInLineStatusValue
    locationCode: string | null
  }>
  plantId: string
}

/** 盘点单视图（WR-24；锁仓标志投影）。 */
export interface StocktakeOrderDto {
  orderId: string
  orderNo: string
  warehouseId: string
  warehouseCode: string | null
  locked: boolean
  status: StocktakeStatusValue
  statusLabel: string
  startedBy: string
  startedAt: string
  closedAt: string | null
  closedBy: string | null
  plantId: string
}

/** 差异调整单视图（WR-24②/③：原因必填＋去向＋关联流水）。 */
export interface StockAdjustmentDto {
  adjustmentId: string
  adjustmentNo: string
  stocktakeOrderNo: string | null
  reason: string
  destination: string
  lineCount: number
  totalAdjustQty: DecimalString
  adjustedBy: string
  adjustedAt: string
  plantId: string
}

/** 采购批次纠正视图（WR-S6：作废/冲销/退货三类，关联原批次与流水，含快照）。 */
export interface ReceiptCorrectionDto {
  correctionId: string
  correctionNo: string
  batchId: string
  batchNo: string
  correctionKind: ReceiptCorrectionKindValue
  correctionKindLabel: string
  quantity: DecimalString
  reason: string
  remark: string | null
  attachments: readonly string[]
  returnSyncStatus: 'none' | 'pending' | 'failed' | 'synced'
  operatedBy: string
  operatedAt: string
  plantId: string
}

/** 载具借还事件视图（WR-S5：append-only，引用 carrier，不与产品退货表关联）。 */
export interface CarrierLoanDto {
  loanId: string
  carrierId: string
  carrierCode: string
  carrierKind: 'spool' | 'drum' | 'tray' | 'box'
  eventKind: CarrierLoanEventKindValue
  eventKindLabel: string
  counterparty: string | null
  note: string | null
  occurredBy: string
  occurredAt: string
  plantId: string
}

/** 所有权三分视图（WR-26/A07：数量、位置、所有权三者分别可核对）。 */
export interface OwnershipBalanceDto {
  unitId: string
  unitNo: string
  locationId: string
  locationCode: string
  ownerId: string
  ownerName: string
  custodianPlantId: string
  quantity: DecimalString
  uomCode: string
  qualityStatus: string
}

export type StockMoveRecordPage = PageResult<StockMoveRecordDto>
export type TransferOutboundOrderPage = PageResult<TransferOutboundOrderDto>
export type TransferInboundOrderPage = PageResult<TransferInboundOrderDto>
export type StocktakeOrderPage = PageResult<StocktakeOrderDto>
export type ReceiptCorrectionPage = PageResult<ReceiptCorrectionDto>
export type CarrierLoanPage = PageResult<CarrierLoanDto>

// ---------------- 命令载荷（摘要；处理器按 WR-xx 逐项校验） ----------------

export interface ReverseMoveSubmitPayload {
  operationId?: string
  plantId: string
  warehouseId: string
  toLocationId: string
  stagedUnitNos: readonly string[]
  reason?: string
  businessTime?: string
}

export interface ReverseTransferOutCreatePayload {
  operationId?: string
  plantId: string
  transferKind: 'production' | 'warehouse'
  fromWarehouseId: string
  toWarehouseId: string
  relatedOrderNo?: string
  lines: ReadonlyArray<{ materialId: string; plannedQty: DecimalString }>
  reason?: string
}

export interface ReverseTransferOutScanPayload {
  operationId?: string
  plantId: string
  orderId?: string
  unitNo: string
  toWarehouseId?: string
  validUntil?: string
  reason?: string
}

export interface ReverseTransferOutCompletePayload {
  operationId?: string
  plantId: string
  orderId: string
  toLocationId?: string
  transitLocationId?: string
  transitLocationCode?: string
  reason?: string
}

export interface ReverseTransferInScanPayload {
  operationId?: string
  plantId: string
  orderId: string
  unitNo: string
  palletCode?: string
  locationCode?: string
  validUntil?: string
  reason?: string
}

export interface ReverseStockAdjustmentPayload {
  operationId?: string
  plantId: string
  stocktakeOrderId?: string
  reason: string
  destination: string
  lines: ReadonlyArray<{
    unitId: string
    locationId?: string
    ownerId?: string
    adjustQty: DecimalString
  }>
  businessTime?: string
}
