import type { DecimalString } from './decimal'
import type { PageResult } from './pagination'

/**
 * purchase 域公开线合同（L1-P1-SERVER / T08 采购收货、来料检验、价格复核）。
 *
 * 依据：规则底稿 architecture/contracts/prep/p1/04-supply-chain-rules-T08T12T13T14.md §A-T08；
 * 冻结合同 architecture/contracts/frozen/p1/interfaces.md IF-08/09/10。
 * - 数量字段一律 DecimalString（IT-07 口径随行：十进制定点、≤4 位小数，禁 number）；
 * - 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）。
 */

// ---------------- 状态字典值 ----------------

/** 订单行状态 0–5（IF-08；0 已开立/1 待收货/2 部分收货/3 完全收货/4 超额收货/5 已完成）。 */
export type PurchaseOrderLineStatusValue = 0 | 1 | 2 | 3 | 4 | 5

/** 批次质检状态 6 态（A-6）。 */
export type BatchInspectionStatusValue =
  | 'exempt'
  | 'pending'
  | 'in_progress'
  | 'all_qualified'
  | 'all_unqualified'
  | 'partially_qualified'

/** 明细（单码）质量状态 5 态（A-6/T12）。 */
export type DetailQualityStatusValue =
  | 'exempt'
  | 'pending_inspection'
  | 'qualified'
  | 'unqualified'
  | 're_inspection'

/** 入库业务状态（A-9）。 */
export type BatchStorageStatusValue = 'stored' | 'returned'

/** 复核状态（A-10）。 */
export type BatchReviewStatusValue = 'pending' | 'reviewed'

/** 外部同步状态（A-11/IF-09/10：none=未达回传条件，无任务）。 */
export type BatchSyncStatusValue = 'none' | 'pending' | 'failed' | 'synced'

// ---------------- 查询侧 DTO ----------------

/** 采购订单行视图（IF-08：MES 零增删改，行维度查询与状态汇总）。 */
export interface PurchaseOrderLineDto {
  lineId: string
  orderNo: string
  lineNo: number
  sourceSystem: string
  orgCode: string
  plantId: string
  contractNo: string | null
  salesOrderNo: string | null
  salesLineNo: string | null
  materialId: string
  materialCode: string
  materialName: string | null
  spec: string | null
  model: string | null
  color: string | null
  requisitionSpec: string | null
  supplierName: string | null
  uomCode: string
  plannedQty: DecimalString
  receivedQty: DecimalString
  overReceiptLimit: DecimalString
  status: PurchaseOrderLineStatusValue
  statusLabel: string
  erpClosed: boolean
  plannedReceiptDate: string | null
  firstArrivalDate: string | null
  lastArrivalDate: string | null
  externalRevision: number | null
}

export type PurchaseOrderLinePage = PageResult<PurchaseOrderLineDto>

/** 采购收货批次视图（A-4/A-6/A-9/A-10 投影列）。 */
export interface PurchaseBatchDto {
  batchId: string
  batchNo: string
  orderNo: string
  lineNo: number
  materialCode: string
  materialName: string | null
  plantId: string
  warehouseId: string
  warehouseCode: string | null
  locationId: string | null
  locationCode: string | null
  uomCode: string
  receivedQty: DecimalString
  inspectionStatus: BatchInspectionStatusValue
  inspectionStatusLabel: string
  storageStatus: BatchStorageStatusValue
  reviewStatus: BatchReviewStatusValue
  reviewedBy: string | null
  reviewedAt: string | null
  unitPrice: DecimalString | null
  avgPrice: DecimalString | null
  deviationPpm: number | null
  /** 浮动展示标记：'up' 浅红 / 'down' 浅绿 / null（A-10） */
  priceFlag: 'up' | 'down' | null
  qualifiedSyncStatus: BatchSyncStatusValue
  returnSyncStatus: BatchSyncStatusValue
  arrivalTime: string
  confirmTime: string
  receivedBy: string
  returnedAt: string | null
}

export type PurchaseBatchPage = PageResult<PurchaseBatchDto>

/** 收货明细视图（含当前生效质检结论与库存单元引用）。 */
export interface ReceiptDetailDto {
  detailId: string
  batchId: string
  barcodeValue: string
  supplierLotNo: string
  grade: string
  productionDate: string | null
  quantity: DecimalString
  uomCode: string
  qualityStatus: DetailQualityStatusValue
  qualityStatusLabel: string
  inventoryUnitId: string | null
  locationId: string | null
  locationCode: string | null
  note: string | null
}

/** 质检记录行（S14 版本化历史，含生效指针）。 */
export interface InspectionRecordDto {
  recordId: string
  detailId: string
  barcodeValue: string
  inspectionType: 'first' | 're'
  version: number
  conclusion: 'exempt' | 'pending' | 'qualified' | 'unqualified'
  isEffective: boolean
  source: 'receive' | 'pda' | 'web' | 'judge' | 'reinspection_start'
  inspector: string | null
  inspectedAt: string | null
}

/** 批次详情（明细 + 质检历史 + 价格复核投影）。 */
export interface PurchaseBatchDetailDto extends PurchaseBatchDto {
  details: ReceiptDetailDto[]
  inspectionHistory: InspectionRecordDto[]
  /** 价格复核只读投影（A-10）：近 5 次历史单价明细（时点快照） */
  priceHistory: Array<{ batchNo: string; price: DecimalString; confirmTime: string }>
}

// ---------------- 命令载荷（数量一律 DecimalString） ----------------

/** 模拟入站：采购订单同步（IF-08 五元组幂等 + external_revision 乱序保护）。 */
export interface PurchaseOrderSyncPayload {
  sourceSystem?: string
  orgCode: string
  orderNo: string
  plantId?: string
  supplierName?: string
  contractNo?: string
  externalRevision?: number
  lines: Array<{
    lineNo: number
    materialId?: string
    materialCode: string
    materialName?: string
    materialType?: number
    spec?: string
    model?: string
    color?: string
    requisitionSpec?: string
    salesOrderNo?: string
    salesLineNo?: string
    uomCode?: string
    plannedQty: DecimalString
    overReceiptLimit?: DecimalString
    status?: PurchaseOrderLineStatusValue
    erpClosed?: boolean
    plannedReceiptDate?: string
    externalRevision?: number
  }>
  reason?: string
}

/** 确认收货载荷（A-2/A-3/A-4/A-5：一次事务四账一致）。 */
export interface PurchaseReceiveConfirmPayload {
  plantId: string
  orderLineId?: string
  orderNo?: string
  lineNo?: number
  arrivalTime: string
  confirmTime?: string
  warehouseId: string
  warehouseCode?: string
  locationId?: string
  locationCode?: string
  ownerId: string
  ownerName: string
  uomId: string
  uomCode: string
  /** 本批单价（来源 U9/ERP 接口未定义，C-1 缺口；模拟入站可携带） */
  unitPrice?: DecimalString
  reason?: string
  details: Array<{
    barcodeValue: string
    supplierLotNo?: string
    grade?: string
    productionDate?: string
    /** 每行数量（=包装单位总量）；或以 packageUnitQty × codeCount 推导（A-5） */
    quantity?: DecimalString
    packageUnitQty?: DecimalString
    codeCount?: number
    conversionRevisionId?: string
    locationId?: string
    locationCode?: string
    note?: string
  }>
}

/** 质检结论载荷（A-7：mode=pda 单码可反复 / web 只补待检 / judge 整批覆盖）。 */
export interface PurchaseInspectionConcludePayload {
  batchId: string
  mode: 'code' | 'batch' | 'judge'
  conclusion: 'qualified' | 'unqualified'
  detailId?: string
  barcodeValue?: string
  note?: string
}

/** 撤销质检载荷（A-8：保留历史，仅切生效指针）。 */
export interface PurchaseInspectionRevokePayload {
  detailId?: string
  batchId?: string
  barcodeValue?: string
  inspectionType?: 'first' | 're'
}

/** 发起复检载荷（A-6：复检至多一次）。 */
export interface PurchaseReinspectionStartPayload {
  items: Array<{ batchId: string; barcodeValue: string }>
}

/** 退货载荷（A-9：全部不合格且未退货）。 */
export interface PurchaseReturnPayload {
  batchId: string
  /** 退货备注必填（≤200 字） */
  reason: string
}

/** 价格复核标记载荷（A-10：仅待复核且非退货；已复核不可撤销）。 */
export interface PurchasePriceReviewPayload {
  batchId: string
}
