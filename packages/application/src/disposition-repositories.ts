import type { CommandTools } from './command-bus'
import type { InventoryCommandTools, OutboxCollector } from './inventory-repositories'

/**
 * disposition 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与表列一一对应（本域 0014 新表 + 0006 既有质检版本链表）；时间字段一律 ISO-8601
 * 字符串；数量字段一律 DecimalString（IT-07 口径随行）。
 *
 * 裁定说明（QD-11~18）：采购质检结论版本化的存储模型已由 0006 落地——
 * inspection_record（首检 first / 复检 re 双链，追加历史＋(detail_id, inspection_type)
 * 生效指针，S14）与 batch_judgement（批次判定版本链，同批次仅一条生效）。
 * 本域命令直接消费 0006 既有表（先例：0013 消费 purchase_receipt_batch），不建平行事实表。
 *
 * DispositionCommandTools = InventoryCommandTools 超集（存疑/放行/让步/报废复用 inv 仓储束
 * 维护库存质量投影与扣减记账——端口注入、同 UoW，IT-18 库存域唯一维护方口径）+ 本域仓储束 qd。
 * 范围裁定：certificate/customer_complaint/recall 三对象随 GAP-F16 裁定，裁定前不建（QD-S5）。
 */

// ---------------- 存疑记录（QD-S1：append-only；0014 表） ----------------

export interface SuspectRecordRecord {
  id: string
  unitId: string
  unitNo: string
  /** QD-02：料品编号/名称/规格/颜色去重拼接 */
  materialKeyJoined: string
  currentStatus: 'suspect'
  /** 存疑前码质量状态（QD-03 恢复回落目标；存疑记录本身 append-only 不改） */
  previousQualityStatus: 'qualified' | 'pending_inspection' | 'unqualified' | null
  productionDeptId: string | null
  productionDeptName: string | null
  raisedBy: string
  raisedAt: string
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
}

export interface NewSuspectRecord {
  unitId: string
  unitNo: string
  materialKeyJoined: string
  productionDeptId?: string | null
  productionDeptName?: string | null
  raisedBy: string
  raisedAt: string
  previousQualityStatus?: 'qualified' | 'pending_inspection' | 'unqualified' | null
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface SuspectRecordRepository {
  insert(record: NewSuspectRecord): Promise<SuspectRecordRecord>
  findById(id: string): Promise<SuspectRecordRecord | null>
  listByUnit(unitId: string): Promise<SuspectRecordRecord[]>
  listByUnitNo(plantId: string, unitNo: string): Promise<SuspectRecordRecord[]>
}

// ---------------- 处置记录（QD-S3：append-only；放行/报废 reason 非空；0014 表） ----------------

export type QdDispositionKind = 'rework' | 'scrap' | 'concession' | 'release' | 'hold_release'

export interface DispositionFactRecord {
  id: string
  dispositionNo: string
  dispositionKind: QdDispositionKind
  targetType: string
  targetId: string
  decidedBy: string
  decidedAt: string
  basis: string | null
  reason: string | null
  /** QD-08/QD-22：去向（报废/返工/其它＋说明） */
  destinationKind: 'scrap' | 'rework' | 'other' | null
  destinationNote: string | null
  quantity: string | null
  uomCode: string | null
  /** QD-22：报废扣减流水指针（去向指针=stock_transaction） */
  transactionId: string | null
  /** QD-21：返工任务指针 */
  reworkTaskId: string | null
  /** QD-23：让步范围（批次/数量/期限）与审批人 */
  concessionScope: unknown
  approver: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
}

export interface NewDispositionFact {
  /** 应用层预生成（报废扣减流水 ref 需在插入前回指处置记录）；缺省由仓储生成 */
  id?: string
  dispositionNo: string
  dispositionKind: QdDispositionKind
  targetType: string
  targetId: string
  decidedBy: string
  decidedAt: string
  basis?: string | null
  reason?: string | null
  destinationKind?: 'scrap' | 'rework' | 'other' | null
  destinationNote?: string | null
  quantity?: string | null
  uomCode?: string | null
  transactionId?: string | null
  reworkTaskId?: string | null
  concessionScope?: unknown
  approver?: string | null
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface DispositionFactRepository {
  insert(fact: NewDispositionFact): Promise<DispositionFactRecord>
  findById(id: string): Promise<DispositionFactRecord | null>
  findByNo(dispositionNo: string): Promise<DispositionFactRecord | null>
  listByTarget(targetType: string, targetId: string): Promise<DispositionFactRecord[]>
  listByUnitNo(plantId: string, unitNo: string, limit: number): Promise<DispositionFactRecord[]>
}

// ---------------- 成品异常（QD-S4：含扣数去向列，审核通过时必填；0014 表） ----------------

export interface FinishedGoodsDefectRecord {
  id: string
  defectNo: string
  unitId: string
  unitNo: string
  materialId: string
  materialCode: string
  defectType: 'rework' | 'scrap'
  defectQty: string
  uomCode: string
  reviewStatus: 'unreviewed' | 'approved' | 'rejected'
  submittedBy: string
  submittedAt: string
  reviewedBy: string | null
  reviewedAt: string | null
  /** QD-08：扣数去向（审核通过必填） */
  destinationKind: 'scrap' | 'rework' | 'other' | null
  destinationNote: string | null
  adjustReason: string | null
  deductionTransactionIds: unknown
  commandReceiptId: string | null
  productionDeptId: string | null
  productionDeptName: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  updatedAt: string
}

export interface NewFinishedGoodsDefect {
  defectNo: string
  unitId: string
  unitNo: string
  materialId: string
  materialCode: string
  defectType: 'rework' | 'scrap'
  defectQty: string
  uomCode: string
  submittedBy: string
  submittedAt: string
  productionDeptId?: string | null
  productionDeptName?: string | null
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface FinishedGoodsDefectRepository {
  insert(defect: NewFinishedGoodsDefect): Promise<FinishedGoodsDefectRecord>
  findByNo(defectNo: string): Promise<FinishedGoodsDefectRecord | null>
  findById(id: string): Promise<FinishedGoodsDefectRecord | null>
  /** QD-06：该码该料品已有异常未处理 */
  findOpenByUnitMaterial(unitId: string, materialId: string): Promise<FinishedGoodsDefectRecord | null>
  /** QD-07：审核落库（审核结论＋QD-08 去向＋扣减流水指针） */
  applyReview(
    id: string,
    patch: {
      reviewStatus: 'approved' | 'rejected'
      reviewedBy: string
      reviewedAt: string
      destinationKind?: 'scrap' | 'rework' | 'other' | null
      destinationNote?: string | null
      adjustReason?: string | null
      deductionTransactionIds?: unknown
    },
    actor: string | null,
  ): Promise<FinishedGoodsDefectRecord | null>
  listPaged(filter: {
    enterpriseId: string
    plantIds: string[] | null
    plantId?: string
    unitNoLike?: string
    reviewStatus?: string
    page: number
    pageSize: number
  }): Promise<{ items: FinishedGoodsDefectRecord[]; total: number }>
}

// ---------------- 采购批次/明细/检验版本链端口（QD-11~15；0006 既有表） ----------------

/** 批次质检状态 6 值（QD-15；= 0006 purchase_receipt_batch.inspection_status 枚举）。 */
export type BatchInspectionStatusValue =
  | 'exempt'
  | 'pending'
  | 'in_progress'
  | 'all_qualified'
  | 'all_unqualified'
  | 'partially_qualified'

/** 批次内码明细视图（0006 receipt_detail + inventory_unit）。 */
export interface ReceiptDetailQcView {
  detailId: string
  batchId: string
  unitId: string | null
  unitNo: string | null
  barcodeValue: string
  /** 码质量投影（exempt/pending_inspection/qualified/unqualified/re_inspection） */
  qualityStatus: string
  quantity: string
  uomCode: string
}

export interface PurchaseBatchQcProjection {
  id: string
  batchNo: string
  purchaseLineId: string
  materialId: string
  materialCode: string
  inspectionStatus: BatchInspectionStatusValue
  storageStatus: 'stored' | 'returned'
  plantId: string
  enterpriseId: string
}

export interface PurchaseBatchQcPort {
  findByNo(batchNo: string): Promise<PurchaseBatchQcProjection | null>
  findById(id: string): Promise<PurchaseBatchQcProjection | null>
  /** QD-15：批次质检状态投影重算写回（0006 既有投影列；按各码当前生效结论汇总） */
  updateInspectionStatus(batchId: string, status: BatchInspectionStatusValue, actor: string | null): Promise<void>
  /** 批次内码明细集合（QD-11/14 遍历输入；join inventory_unit 得 unit_no） */
  listDetails(batchId: string): Promise<ReceiptDetailQcView[]>
  /** QD-05：码当前活动余额所在仓库类型集合（已入库且非线边仓拒绝——事实装载） */
  findWarehouseKindsByUnitNo(plantId: string, unitNo: string): Promise<string[]>
}

/** 0006 inspection_record 行（首检 first / 复检 re 双链，追加历史＋生效指针）。 */
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
  conclusion: 'exempt' | 'pending' | 'qualified' | 'unqualified'
  source: NewInspectionRecordSource
  inspector?: string | null
  inspectedAt?: string | null
  attachments?: unknown
  commandReceiptId?: string | null
  createdBy?: string | null
}

export type NewInspectionRecordSource = InspectionRecordRow['source']

/**
 * 检验记录版本链端口（0006 inspection_record；QD-12/S14 追加历史＋生效指针切换）。
 * "当前生效质检行"= 有复检记录则复检链生效行，否则首检链生效行（QD-11 口径）。
 */
export interface InspectionChainRepository {
  insert(record: NewInspectionRecord): Promise<InspectionRecordRow>
  /** 翻转链内生效指针（仅 is_effective 列——0006 cadenza_purchase_history_guard 锁定事实列） */
  markIneffective(recordId: string, actor: string | null): Promise<void>
  /** 当前生效行（复检链优先，其次首检链；两链皆无生效行返回 null） */
  findEffectiveForDetail(detailId: string): Promise<InspectionRecordRow | null>
  /** 明细全链历史（新旧记录均可查，QD-12） */
  listChainForDetail(detailId: string): Promise<InspectionRecordRow[]>
  /** QD-14：明细是否已有复检记录（inspection_type='re' 行存在即发起过） */
  countReInspection(detailId: string): Promise<number>
  /** 链内最大版本号（按 inspection_type 分链） */
  maxVersion(detailId: string, inspectionType: 'first' | 're'): Promise<number>
  /** 批内各明细当前生效结论集合（QD-15 汇总输入） */
  listEffectiveByBatch(batchId: string): Promise<InspectionRecordRow[]>
  /** 码质量投影同步（0006 receipt_detail.quality_status） */
  updateDetailQualityStatus(detailId: string, qualityStatus: string, actor: string | null): Promise<void>
}

/** 0006 batch_judgement 行（QD-13：判定记录版本链——同批次仅一条生效，新覆盖旧=追加版本行）。 */
export interface BatchJudgementRow {
  id: string
  batchId: string
  version: number
  conclusion: 'qualified' | 'unqualified'
  judgeBy: string
  judgedAt: string
  note: string | null
  attachments: unknown
  isEffective: boolean
  commandReceiptId: string | null
  createdAt: string
}

export interface NewBatchJudgement {
  batchId: string
  version: number
  conclusion: 'qualified' | 'unqualified'
  judgeBy: string
  judgedAt: string
  note: string
  attachments?: unknown
  isEffective: boolean
  commandReceiptId?: string | null
  createdBy?: string | null
}

export interface BatchJudgementPort {
  insert(judgement: NewBatchJudgement): Promise<BatchJudgementRow>
  /** 旧生效行翻转（仅 is_effective） */
  markIneffective(judgementId: string, actor: string | null): Promise<void>
  listChainByBatch(batchId: string): Promise<BatchJudgementRow[]>
  findEffective(batchId: string): Promise<BatchJudgementRow | null>
  maxVersion(batchId: string): Promise<number>
}

// ---------------- 追溯/下游使用检测端口（QD-16） ----------------

export interface TraceabilityPort {
  /** 批次（经其码/批号）是否存在下游使用：谱系消耗边（consumption）或 发料/调拨出库流水 */
  downstreamConsumedByBatch(batchId: string): Promise<boolean>
  /** QD-16 影响圈定：批次→已流转产品（正向追溯 IT-35 引用；只读查询） */
  forwardImpactByBatch(batchId: string): Promise<Array<{ toType: string; toId: string; edgeKind: string; quantity: string }>>
}

// ---------------- 返工任务（QD-21：[合同新造] 最小；单据形态随 GAP-F16；0014 表） ----------------

export interface ReworkTaskRecord {
  id: string
  taskNo: string
  dispositionId: string
  originUnitId: string
  originUnitNo: string
  originProcessOrderNo: string
  originOperation: string | null
  status: 'created' | 'in_progress' | 'done'
  note: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
}

export interface NewReworkTask {
  taskNo: string
  dispositionId: string
  originUnitId: string
  originUnitNo: string
  originProcessOrderNo: string
  originOperation?: string | null
  note?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface ReworkTaskRepository {
  insert(task: NewReworkTask): Promise<ReworkTaskRecord>
  findByNo(taskNo: string): Promise<ReworkTaskRecord | null>
  findById(id: string): Promise<ReworkTaskRecord | null>
}

// ---------------- 工具集 ----------------

export interface QdRepositories {
  suspectRecords: SuspectRecordRepository
  dispositions: DispositionFactRepository
  defects: FinishedGoodsDefectRepository
  batchQc: PurchaseBatchQcPort
  inspectionChain: InspectionChainRepository
  judgements: BatchJudgementPort
  reworkTasks: ReworkTaskRepository
  trace: TraceabilityPort
}

export interface DispositionCommandTools extends CommandTools {
  inv: InventoryCommandTools['inv']
  outbox: OutboxCollector
  qd: QdRepositories
}
