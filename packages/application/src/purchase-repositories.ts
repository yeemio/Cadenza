import type { InventoryCommandTools } from './inventory-repositories'
import type { OutboxIntent } from './unit-of-work'

/**
 * purchase 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0006 表列一一对应；时间字段一律 ISO-8601 字符串；数量字段一律 DecimalString。
 *
 * PurchaseCommandTools = InventoryCommandTools 超集（采购收货/退货复用 inventory 记账服务
 * receiveGoods 与 inv 仓储束——通过端口注入、同 UoW，派发合同口径）。
 */

// ---------------- 记录类型 ----------------

export interface PurchaseOrderRecord {
  id: string
  orderNo: string
  orgCode: string
  sourceSystem: string
  plantId: string
  enterpriseId: string
  supplierName: string | null
  contractNo: string | null
  externalRevision: number | null
  createdAt: string
  updatedAt: string
}

export interface PurchaseOrderLineRecord {
  id: string
  purchaseOrderId: string
  lineNo: number
  orderNo: string
  orgCode: string
  sourceSystem: string
  materialId: string
  materialCode: string
  materialName: string | null
  materialType: number | null
  spec: string | null
  model: string | null
  color: string | null
  requisitionSpec: string | null
  salesOrderNo: string | null
  salesLineNo: string | null
  uomCode: string
  plannedQty: string
  receivedQty: string
  overReceiptLimit: string
  status: number
  erpClosed: boolean
  plannedReceiptDate: string | null
  firstArrivalDate: string | null
  lastArrivalDate: string | null
  externalRevision: number | null
  plantId: string
  enterpriseId: string
  createdAt: string
  updatedAt: string
}

export interface NewPurchaseOrderLine {
  purchaseOrderId: string
  lineNo: number
  orderNo: string
  orgCode: string
  sourceSystem: string
  materialId: string
  materialCode: string
  materialName?: string | null
  materialType?: number | null
  spec?: string | null
  model?: string | null
  color?: string | null
  requisitionSpec?: string | null
  salesOrderNo?: string | null
  salesLineNo?: string | null
  uomCode: string
  plannedQty: string
  overReceiptLimit: string
  status?: number
  erpClosed?: boolean
  plannedReceiptDate?: string | null
  externalRevision?: number | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface PurchaseReceiptBatchRecord {
  id: string
  batchNo: string
  purchaseLineId: string
  orderNo: string
  lineNo: number
  materialId: string
  materialCode: string
  materialName: string | null
  materialType: number | null
  plantId: string
  enterpriseId: string
  warehouseId: string
  warehouseCode: string | null
  locationId: string | null
  locationCode: string | null
  uomId: string
  uomCode: string
  measurementBasis?: string
  inspectionStatus: 'exempt' | 'pending' | 'in_progress' | 'all_qualified' | 'all_unqualified' | 'partially_qualified'
  storageStatus: 'stored' | 'returned'
  receivedQty: string
  unitPrice: string | null
  priceHistory: Array<{ batchNo: string; price: string; confirmTime: string }> | null
  avgPrice: string | null
  deviationPpm: number | null
  priceFlag: 'up' | 'down' | null
  reviewStatus: 'pending' | 'reviewed'
  reviewedBy: string | null
  reviewedAt: string | null
  qualifiedSyncStatus: 'none' | 'pending' | 'failed' | 'synced'
  returnSyncStatus: 'none' | 'pending' | 'failed' | 'synced'
  arrivalTime: string
  confirmTime: string
  receivedBy: string
  returnedAt: string | null
  returnReason: string | null
  createdAt: string
}

export interface NewPurchaseReceiptBatch {
  batchNo: string
  purchaseLineId: string
  orderNo: string
  lineNo: number
  materialId: string
  materialCode: string
  materialName?: string | null
  materialType?: number | null
  plantId: string
  enterpriseId: string
  warehouseId: string
  warehouseCode?: string | null
  locationId?: string | null
  locationCode?: string | null
  uomId: string
  uomCode: string
  measurementBasis?: string
  inspectionStatus: PurchaseReceiptBatchRecord['inspectionStatus']
  storageStatus?: 'stored'
  receivedQty: string
  unitPrice?: string | null
  priceHistory?: Array<{ batchNo: string; price: string; confirmTime: string }> | null
  avgPrice?: string | null
  deviationPpm?: number | null
  priceFlag?: 'up' | 'down' | null
  arrivalTime: string
  confirmTime: string
  receivedBy: string
  createdBy?: string | null
}

export interface ReceiptDetailRecord {
  id: string
  batchId: string
  barcodeValue: string
  supplierLotNo: string
  grade: string
  productionDate: string | null
  quantity: string
  packageQty: string | null
  codeCount: number | null
  conversionRevisionId: string | null
  uomId: string
  uomCode: string
  qualityStatus: 'exempt' | 'pending_inspection' | 'qualified' | 'unqualified' | 're_inspection'
  inventoryUnitId: string | null
  locationId: string | null
  locationCode: string | null
  note: string | null
  createdAt: string
}

export interface NewReceiptDetail {
  batchId: string
  barcodeValue: string
  supplierLotNo?: string | null
  grade?: string | null
  productionDate?: string | null
  quantity: string
  packageQty?: string | null
  codeCount?: number | null
  conversionRevisionId?: string | null
  uomId: string
  uomCode: string
  qualityStatus: ReceiptDetailRecord['qualityStatus']
  inventoryUnitId?: string | null
  locationId?: string | null
  locationCode?: string | null
  note?: string | null
  createdBy?: string | null
}

export interface InspectionRecordRow {
  id: string
  batchId: string
  detailId: string
  barcodeValue: string
  inspectionType: 'first' | 're'
  version: number
  conclusion: 'exempt' | 'pending' | 'qualified' | 'unqualified'
  isEffective: boolean
  source: 'receive' | 'pda' | 'web' | 'judge' | 'reinspection_start'
  inspector: string | null
  inspectedAt: string | null
  attachments: unknown
  commandReceiptId: string | null
  createdAt: string
}

export interface NewInspectionRecord {
  batchId: string
  detailId: string
  barcodeValue: string
  inspectionType: 'first' | 're'
  version: number
  conclusion: InspectionRecordRow['conclusion']
  isEffective?: boolean
  source: InspectionRecordRow['source']
  inspector?: string | null
  inspectedAt?: string | null
  attachments?: unknown
  commandReceiptId?: string | null
  createdBy?: string | null
}

export interface BatchJudgementRecord {
  id: string
  batchId: string
  version: number
  conclusion: 'qualified' | 'unqualified'
  judgeBy: string
  judgedAt: string
  note: string | null
  isEffective: boolean
}

export interface MaterialQcLookup {
  id: string
  code: string
  name: string | null
  materialType: number | null
  baseUom: string | null
  /** 1=需要质检（待检）；0=无需质检（免检）[A-4] */
  qcFlag: number
}

// ---------------- 仓储端口 ----------------

export interface PurchaseOrderRepository {
  findByKey(sourceSystem: string, orgCode: string, orderNo: string): Promise<PurchaseOrderRecord | null>
  insert(input: {
    orderNo: string
    orgCode: string
    sourceSystem: string
    plantId: string
    enterpriseId: string
    supplierName?: string | null
    contractNo?: string | null
    externalRevision?: number | null
    createdBy?: string | null
  }): Promise<PurchaseOrderRecord>
}

export interface PurchaseOrderLineRepository {
  findById(id: string): Promise<PurchaseOrderLineRecord | null>
  /** 行锁（确认收货/退货前锁定，防并发超上限与已收回写竞争；IT-15 口径随行）。 */
  lockById(id: string): Promise<PurchaseOrderLineRecord | null>
  /** 按采购单号+行号+工厂定位（确认收货载荷回退路径）。 */
  findByOrderNoAndLine(orderNo: string, lineNo: number, plantId: string): Promise<PurchaseOrderLineRecord | null>
  insert(line: NewPurchaseOrderLine): Promise<PurchaseOrderLineRecord>
  /** 收货回写 [A-1]：已收数量 + 重算状态 + 首/末到货日期。 */
  updateReceiptState(
    id: string,
    patch: {
      receivedQty: string
      status: number
      firstArrivalDate?: string | null
      lastArrivalDate?: string | null
    },
    actor: string | null,
  ): Promise<PurchaseOrderLineRecord | null>
  /** 同步修订应用（IF-00.3：高修订应用更新上游快照字段；本地已收数量不覆盖）。 */
  applySyncRevision(
    id: string,
    patch: {
      materialId?: string
      materialCode?: string
      materialName?: string | null
      plannedQty?: string
      overReceiptLimit?: string
      status?: number
      erpClosed?: boolean
      externalRevision?: number
    },
    actor: string | null,
  ): Promise<PurchaseOrderLineRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    orderNoLike?: string
    materialCode?: string
    statuses?: number[]
    page: number
    pageSize: number
  }): Promise<{ items: PurchaseOrderLineRecord[]; total: number }>
}

export interface PurchaseBatchRepository {
  findById(id: string): Promise<PurchaseReceiptBatchRecord | null>
  findByNo(batchNo: string): Promise<PurchaseReceiptBatchRecord | null>
  insert(batch: NewPurchaseReceiptBatch): Promise<PurchaseReceiptBatchRecord>
  updateInspectionStatus(id: string, inspectionStatus: PurchaseReceiptBatchRecord['inspectionStatus'], actor: string | null): Promise<PurchaseReceiptBatchRecord | null>
  updateReturnState(
    id: string,
    patch: { storageStatus: 'returned'; receivedQty: string; returnedAt: string; returnReason: string },
    actor: string | null,
  ): Promise<PurchaseReceiptBatchRecord | null>
  updateReview(id: string, patch: { reviewStatus: 'reviewed'; reviewedBy: string; reviewedAt: string }, actor: string | null): Promise<PurchaseReceiptBatchRecord | null>
  markQualifiedSyncPending(id: string, actor: string | null): Promise<PurchaseReceiptBatchRecord | null>
  markReturnSyncPending(id: string, actor: string | null): Promise<PurchaseReceiptBatchRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    batchNoLike?: string
    orderNoLike?: string
    inspectionStatuses?: string[]
    storageStatuses?: string[]
    reviewStatuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: PurchaseReceiptBatchRecord[]; total: number }>
  /** A-10 价格历史口径：物料+企业下已入库有单价批次，确认时间倒序取近 5 次。 */
  listRecentPricedByMaterialOrg(
    materialId: string,
    enterpriseId: string,
    limit: number,
  ): Promise<Array<{ batchNo: string; price: string; confirmTime: string }>>
}

export interface ReceiptDetailRepository {
  insert(detail: NewReceiptDetail): Promise<ReceiptDetailRecord>
  findById(id: string): Promise<ReceiptDetailRecord | null>
  listByBatch(batchId: string): Promise<ReceiptDetailRecord[]>
  findByBarcode(batchId: string, barcodeValue: string): Promise<ReceiptDetailRecord | null>
  updateQualityStatus(id: string, qualityStatus: ReceiptDetailRecord['qualityStatus'], actor: string | null): Promise<ReceiptDetailRecord | null>
}

export interface InspectionRecordRepository {
  insert(record: NewInspectionRecord): Promise<InspectionRecordRow>
  listByDetail(detailId: string): Promise<InspectionRecordRow[]>
  listByDetailAndType(detailId: string, inspectionType: 'first' | 're'): Promise<InspectionRecordRow[]>
  listByBatch(batchId: string): Promise<InspectionRecordRow[]>
  findEffective(detailId: string, inspectionType: 'first' | 're'): Promise<InspectionRecordRow | null>
  /** S14 指针翻转：仅更新 is_effective（触发器守卫事实列）。 */
  setEffective(id: string, isEffective: boolean, actor: string | null): Promise<void>
}

export interface BatchJudgementRepository {
  insert(input: {
    batchId: string
    version: number
    conclusion: 'qualified' | 'unqualified'
    judgeBy: string
    judgedAt: string
    note?: string | null
    commandReceiptId?: string | null
  }): Promise<BatchJudgementRecord>
  listByBatch(batchId: string): Promise<BatchJudgementRecord[]>
  setEffective(id: string, isEffective: boolean, actor: string | null): Promise<void>
}

export interface PurchaseExternalMappingRepository {
  /** IF-00.2/IF-08：查五元组既有映射（source_system, organization_code, object_type, external_id, line_no）。 */
  findLineMapping(input: {
    sourceSystem: string
    organizationCode: string
    externalId: string
    lineNo: number
  }): Promise<{ localObjectId: string } | null>
  /** 写五元组映射（object_type 常量 'purchase_order_line'；命中唯一约束由调用侧幂等处理）。 */
  insertLineMapping(input: {
    sourceSystem: string
    organizationCode: string
    externalId: string
    lineNo: number
    localObjectId: string
    createdBy?: string | null
  }): Promise<void>
  /** IF-00.8：缺组织映射的入站数据写隔离队列（inbox QUARANTINED）。 */
  insertQuarantinedInbox(input: {
    sourceSystem: string
    organizationCode: string
    externalKey: string
    entityType: string
    quarantineReason: string
    payload: unknown
  }): Promise<void>
}

export interface PurchaseMaterialLookup {
  findById(id: string): Promise<MaterialQcLookup | null>
  /** 按编码 + 组织范围查（同步入站按 materialCode 落行）。 */
  findByCode(code: string, orgScopeId: string): Promise<MaterialQcLookup | null>
}

// ---------------- 命令工具集扩展 ----------------

/** purchase 域仓储集合。 */
export interface PurchaseRepositories {
  orders: PurchaseOrderRepository
  lines: PurchaseOrderLineRepository
  batches: PurchaseBatchRepository
  details: ReceiptDetailRepository
  inspections: InspectionRecordRepository
  judgements: BatchJudgementRepository
  mappings: PurchaseExternalMappingRepository
  materials: PurchaseMaterialLookup
}

/**
 * purchase 命令工具集：InventoryCommandTools（org 基础 + inv 仓储 + Outbox 收集）超集，
 * 追加 purchase 仓储束。确认收货经 buildPostingContext 构造 PostingContext 后直调
 * inventory receiveGoods（同事务，A-4/DM §6 首行事务表口径）。
 */
export interface PurchaseCommandTools extends InventoryCommandTools {
  pur: PurchaseRepositories
}

/** 出站任务意图别名（供组合根与处理器共用；与 unit-of-work OutboxIntent 同型）。 */
export type PurchaseOutboxIntent = OutboxIntent
