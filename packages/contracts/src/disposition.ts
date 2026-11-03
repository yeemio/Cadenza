import type { DecimalString } from './decimal'
import type { PageResult } from './pagination'

/**
 * disposition 域公开线合同（P2 / T18 质量处置：存疑/成品异常/采购质检结论版本化/处置返工报废让步放行）。
 *
 * 依据：冻结合同 architecture/contracts/frozen/p2/quality-disposition.md（QD-01～QD-25 + QD-S1～S5）；
 * 采购质检存储消费 0006 既有版本链表（inspection_record/batch_judgement）。
 * - 数量字段一律 DecimalString（IT-07 口径随行：十进制定点、≤4 位小数，禁 number）；
 * - 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）；
 * - certificate/customer_complaint/recall 随 GAP-F16 裁定，裁定前无合同面（QD-S5）。
 */

// ---------------- 状态字典值 ----------------

/** 码级检验结论（0006 inspection_record.conclusion；免检为首检事实行，CA-4 保留可查）。 */
export type PurchaseQcConclusionValue = 'exempt' | 'pending' | 'qualified' | 'unqualified'

/** 检验链类型（0006：首检 first / 复检 re）。 */
export type InspectionChainTypeValue = 'first' | 're'

/** 批次质检状态 6 值（QD-15；投影，按各码当前生效结论汇总、可重算）。 */
export type BatchInspectionStatusValue =
  | 'exempt'
  | 'pending'
  | 'in_progress'
  | 'all_qualified'
  | 'all_unqualified'
  | 'partially_qualified'

/** 批次判定结论（QD-13）。 */
export type BatchJudgementValue = 'qualified' | 'unqualified'

/** 不合格类型 2 值（QD-10）。 */
export type DefectTypeValue = 'rework' | 'scrap'

/** 成品异常审核状态 3 值（QD-10）。 */
export type DefectReviewStatusValue = 'unreviewed' | 'approved' | 'rejected'

/** 码异常状态 2 值（QD-10；投影）。 */
export type UnitDefectStateValue = 'normal' | 'defect_open'

/** 扣数去向枚举（QD-08）。 */
export type DeductionDestinationKind = 'scrap' | 'rework' | 'other'

/** 处置种类（QD-20 首期四类＋QD-03 存疑恢复处置）。 */
export type QdDispositionKindValue = 'rework' | 'scrap' | 'concession' | 'release' | 'hold_release'

// ---------------- 命令载荷 ----------------

/** disposition.suspect.mark（QD-01/02）。 */
export interface SuspectMarkCommand {
  plantId: string
  unitNo: string
  /** 码种类（托码拒绝）；缺省 unit */
  barcodeKind?: 'unit' | 'pallet'
  productionDeptId?: string | null
  productionDeptName?: string | null
  reason?: string
}

/** disposition.suspect.release（QD-03）。 */
export interface SuspectReleaseCommand {
  plantId: string
  unitNo: string
  /** 处置依据（高影响场景必填：码已进入备货/待发运） */
  basis?: string
}

/** disposition.defect.submit（QD-05/06）。 */
export interface DefectSubmitCommand {
  plantId: string
  unitNo: string
  materialId: string
  defectType: DefectTypeValue
  defectQty: DecimalString
  barcodeKind?: 'unit' | 'pallet'
  productionDeptId?: string | null
  productionDeptName?: string | null
  reason?: string
}

/** disposition.defect.review（QD-07/08/09）。 */
export interface DefectReviewCommand {
  defectNo: string
  result: 'approved' | 'rejected'
  /** 审核通过必填（QD-08：禁止无去向扣数） */
  destinationKind?: DeductionDestinationKind
  destinationNote?: string
  adjustReason?: string
  reason?: string
}

/** disposition.qc.write-web（QD-11）单码结论。 */
export interface QcWebWriteItem {
  unitNo: string
  conclusion: 'qualified' | 'unqualified'
}

/** disposition.qc.write-web（QD-11）。 */
export interface QcWriteWebCommand {
  batchNo: string
  items: QcWebWriteItem[]
  reason?: string
}

/** disposition.qc.submit-pda（QD-12）。 */
export interface QcSubmitPdaCommand {
  batchNo: string
  unitNo: string
  conclusion: 'qualified' | 'unqualified'
  /** 附件≤3 */
  attachments?: unknown[]
  note?: string
  reason?: string
}

/** disposition.qc.judge（QD-13）。 */
export interface QcJudgeCommand {
  batchNo: string
  judgement: BatchJudgementValue
  /** 备注必填（≤200 非纯空白） */
  remark: string
  attachments?: unknown[]
  reason?: string
}

/** disposition.qc.re-inspect（QD-14）单码。 */
export interface QcReInspectionItem {
  unitNo: string
}

/** disposition.qc.re-inspect（QD-14；整单原子）。 */
export interface QcReInspectCommand {
  batchNo: string
  items: QcReInspectionItem[]
  reason?: string
}

/** disposition.disposition.rework（QD-21）。 */
export interface DispositionReworkCommand {
  plantId: string
  unitNo: string
  originProcessOrderNo: string
  originOperation?: string | null
  basis?: string
  note?: string
}

/** disposition.disposition.scrap（QD-22）。 */
export interface DispositionScrapCommand {
  plantId: string
  unitNo: string
  scrapQty: DecimalString
  /** 高影响：强制理由（QD-20） */
  basis: string
  destinationNote: string
}

/** disposition.disposition.concession（QD-23）。 */
export interface DispositionConcessionCommand {
  plantId: string
  unitNo: string
  approver: string
  scopeBatchNo: string
  scopeQty: DecimalString
  expiresAt?: string | null
  requestedQty?: DecimalString | null
  basis?: string
}

/** disposition.disposition.release（QD-19/20）。 */
export interface DispositionReleaseCommand {
  plantId: string
  unitNo: string
  /** 高影响：强制理由（QD-20） */
  basis: string
  /** 关联检验或异常记录指针（QD-20） */
  targetType: string
  targetId: string
}

// ---------------- 查询侧 DTO ----------------

/** 存疑扫码预检视图（QD-01：只查询）。 */
export interface SuspectScanCheckDto {
  unitNo: string
  ok: boolean
  reason: string | null
  reasonLabel: string | null
  hasSuspect: boolean
  qualityStatus: string | null
}

/** 存疑记录（QD-S1：append-only）。 */
export interface SuspectRecordDto {
  suspectRecordId: string
  unitNo: string
  materialKeyJoined: string
  productionDeptName: string | null
  raisedBy: string
  raisedAt: string
  previousQualityStatus: string | null
}

/** 处置记录（QD-S3）。 */
export interface DispositionFactDto {
  dispositionId: string
  dispositionNo: string
  dispositionKind: QdDispositionKindValue
  targetType: string
  targetId: string
  decidedBy: string
  decidedAt: string
  basis: string | null
  reason: string | null
  destinationKind: DeductionDestinationKind | null
  destinationNote: string | null
  quantity: DecimalString | null
  approver: string | null
}

/** 成品异常记录（QD-S4）。 */
export interface FinishedGoodsDefectDto {
  defectId: string
  defectNo: string
  unitNo: string
  materialCode: string
  defectType: DefectTypeValue
  defectQty: DecimalString
  uomCode: string
  reviewStatus: DefectReviewStatusValue
  submittedBy: string
  submittedAt: string
  reviewedBy: string | null
  reviewedAt: string | null
  destinationKind: DeductionDestinationKind | null
  destinationNote: string | null
  adjustReason: string | null
  productionDeptName: string | null
}

export type FinishedGoodsDefectPage = PageResult<FinishedGoodsDefectDto>

/** 检验记录版本行（0006 inspection_record；新旧记录均可查）。 */
export interface InspectionVersionDto {
  version: number
  inspectionType: InspectionChainTypeValue
  conclusion: PurchaseQcConclusionValue
  isEffective: boolean
  source: string
  inspector: string | null
  inspectedAt: string | null
}

/** 批内码质检视图（当前生效=复检行优先）。 */
export interface InspectionCodeDto {
  unitNo: string | null
  barcodeValue: string
  effectiveConclusion: PurchaseQcConclusionValue | null
  effectiveVersion: number | null
  effectiveInspectionType: InspectionChainTypeValue | null
  hasReInspection: boolean
  chainLength: number
  history: InspectionVersionDto[]
}

/** 批次判定版本行（QD-13 版本链）。 */
export interface BatchJudgementVersionDto {
  version: number
  conclusion: BatchJudgementValue
  note: string | null
  judgeBy: string
  judgedAt: string
  isEffective: boolean
}

/** 批次质检视图（QD-12/13/15）。 */
export interface BatchInspectionDto {
  batchNo: string
  storageStatus: 'stored' | 'returned'
  storedInspectionStatus: BatchInspectionStatusValue
  recomputedStatus: BatchInspectionStatusValue
  codes: InspectionCodeDto[]
  judgementChain: BatchJudgementVersionDto[]
}

/** 返工任务（QD-21；最小——单据形态随 GAP-F16）。 */
export interface ReworkTaskDto {
  taskId: string
  taskNo: string
  dispositionNo: string
  originUnitNo: string
  originProcessOrderNo: string
  originOperation: string | null
  status: 'created' | 'in_progress' | 'done'
}
