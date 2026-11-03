import { DispositionRuleViolation } from './errors'
import { checkAttachments, checkRemark } from './decimal-util'

/**
 * 采购质检结论版本化规则（QD-11～QD-18，frozen/p2/quality-disposition.md §3；
 * T18 域语义——批次/码级检验记录版本链 QD-S2）。
 * 版本链模型：每码每批次一条 append-only 检验记录链（initial 首检 / re_inspection 复检），
 * 追加历史 + is_effective 当前生效指针切换；判定记录为批次级独立版本链（QD-13）。
 */

/** 码级检验结论（QD-11/12：待质检/合格/不合格/免检——免检为首检事实行，CA-4 保留可查）。 */
export type PurchaseInspectionConclusion = 'pending' | 'qualified' | 'unqualified' | 'exempt'

/** 检验记录链行种类。 */
export type InspectionResultKind = 'initial' | 're_inspection'

/** 批次质检状态 6 值（QD-15；投影，按各码当前生效结论汇总、可重算，不作为事实存储 QD-S2）。 */
export type BatchInspectionStatus =
  | 'exempt'
  | 'pending'
  | 'in_progress'
  | 'all_qualified'
  | 'all_unqualified'
  | 'partially_qualified'

/** 批次入库状态（QD-17 硬拦截依据）。 */
export type BatchStorageStatus = 'stored' | 'returned'

/** QD-15：批次状态汇总（纯函数；exempt 视作合格类参与混合汇总；无任何结论行=待质检）。
 * 输入为批次内各码当前生效结论集合（无生效行的码不参与——首检补录后即参与）。 */
export function summarizeBatchInspectionStatus(effectiveConclusions: PurchaseInspectionConclusion[]): BatchInspectionStatus {
  if (effectiveConclusions.length === 0) return 'pending'
  let exempt = 0
  let pending = 0
  let qualified = 0
  let unqualified = 0
  for (const c of effectiveConclusions) {
    if (c === 'exempt') exempt += 1
    else if (c === 'pending') pending += 1
    else if (c === 'qualified') qualified += 1
    else unqualified += 1
  }
  const total = effectiveConclusions.length
  if (pending === total) return 'pending'
  if (pending > 0) return 'in_progress'
  if (exempt === total) return 'exempt' // 全免检
  // 无待检：免检视作合格类
  if (unqualified === 0) return 'all_qualified'
  if (qualified + exempt === 0) return 'all_unqualified'
  return 'partially_qualified'
}

/** QD-11：Web 质检写入范围校验（批次未退货且批次质检状态为待质检/质检中）。 */
export function assertWebWriteBatchState(storageStatus: BatchStorageStatus, inspectionStatus: BatchInspectionStatus): void {
  if (storageStatus === 'returned') {
    throw new DispositionRuleViolation('QD-17', '批次已退货，不可再质检（入库状态=已退货硬拦截）')
  }
  if (inspectionStatus !== 'pending' && inspectionStatus !== 'in_progress') {
    throw new DispositionRuleViolation('QD-11', `批次质检状态为 ${inspectionStatus}，仅待质检/质检中批次可 Web 写入`)
  }
}

/** QD-11：Web 只对待质检码写入；已有结论的码不改。 */
export function assertWebWriteTargetPending(effectiveConclusion: PurchaseInspectionConclusion | null, unitNo: string): void {
  if (effectiveConclusion !== null && effectiveConclusion !== 'pending') {
    throw new DispositionRuleViolation(
      'QD-11',
      `码 ${unitNo} 当前生效结论已为 ${effectiveConclusion}（已有结论的码不改），仅待质检码可写入`,
    )
  }
}

/** QD-11：Web 写入结论取值（合格/不合格；不写免检——免检是批次收货事实）。 */
export function assertWebWriteConclusion(conclusion: string): 'qualified' | 'unqualified' {
  if (conclusion !== 'qualified' && conclusion !== 'unqualified') {
    throw new DispositionRuleViolation('QD-11', 'Web 质检写入结论仅允许 合格/不合格')
  }
  return conclusion
}

/** QD-12：PDA 结论版本化提交校验（可执行 = 批次未退货、免检码不可提交、首检已有复检记录则须操作复检记录）。 */
export function assertPdaSubmitAllowed(input: {
  storageStatus: BatchStorageStatus
  /** 该码是否免检（当前生效结论=exempt 且为批次免检事实） */
  isExempt: boolean
  /** 该码检验链上是否已存在复检记录（存在则操作目标必须落在复检链上——由调用方传 targetKind） */
  hasReInspection: boolean
  /** 本次操作目标链（首检或复检） */
  targetKind: InspectionResultKind
  unitNo: string
}): InspectionResultKind {
  if (input.storageStatus === 'returned') {
    throw new DispositionRuleViolation('QD-17', '批次已退货，不可再质检（入库状态=已退货硬拦截）')
  }
  if (input.isExempt) {
    throw new DispositionRuleViolation('QD-12', `码 ${input.unitNo} 为免检码，不可提交质检结论`)
  }
  if (input.hasReInspection && input.targetKind === 'initial') {
    throw new DispositionRuleViolation('QD-12', `码 ${input.unitNo} 首检已有复检记录，不可再操作首检行（须操作复检记录）`)
  }
  return input.targetKind
}

/** QD-12：PDA 结论取值与附件约束（附件≤3；结论合格/不合格可反复提交、后次为追加版本行并切换生效指针）。 */
export function assertPdaConclusion(conclusion: string, attachments: unknown[]): 'qualified' | 'unqualified' {
  if (conclusion !== 'qualified' && conclusion !== 'unqualified') {
    throw new DispositionRuleViolation('QD-12', 'PDA 质检结论仅允许 合格/不合格（版本化追加，后一次覆盖前次生效）')
  }
  checkAttachments(attachments, 'QD-12')
  return conclusion
}

/** QD-13：判定结论取值。 */
export type BatchJudgementConclusion = 'qualified' | 'unqualified'

/** QD-13：判定可执行条件（目标口径）。
 * - 判定合格：条件 = 部分合格 / 全部不合格
 * - 判定不合格：条件 = 免检 / 全部合格 / 部分不合格（免检可判不合格＝CA-4：追加检验记录＋版本化切换，不删除免检事实） */
export function assertJudgementCondition(
  judgement: BatchJudgementConclusion,
  batchStatus: BatchInspectionStatus,
): BatchJudgementConclusion {
  if (judgement === 'qualified') {
    if (batchStatus !== 'partially_qualified' && batchStatus !== 'all_unqualified') {
      throw new DispositionRuleViolation(
        'QD-13',
        `判定合格的条件为 部分合格/全部不合格，当前批次状态为 ${batchStatus}`,
      )
    }
    return judgement
  }
  if (batchStatus !== 'exempt' && batchStatus !== 'all_qualified' && batchStatus !== 'partially_qualified') {
    throw new DispositionRuleViolation(
      'QD-13',
      `判定不合格的条件为 免检/全部合格/部分不合格，当前批次状态为 ${batchStatus}`,
    )
  }
  return judgement
}

/** QD-13：判定备注必填（≤200 非纯空白）+ 附件≤3 + 批次未退货。 */
export function assertJudgementWritable(input: {
  storageStatus: BatchStorageStatus
  remark: string | null
  attachments: unknown[]
}): string {
  if (input.storageStatus === 'returned') {
    throw new DispositionRuleViolation('QD-17', '批次已退货，不可判定（入库状态=已退货硬拦截）')
  }
  checkAttachments(input.attachments, 'QD-13')
  return checkRemark(input.remark, 'QD-13', '判定备注')
}

/** QD-13：判定执行后整批统一值映射（免检码也统一；原免检首检记录保留可查=append-only）。 */
export function judgementUnifiedConclusion(judgement: BatchJudgementConclusion): PurchaseInspectionConclusion {
  return judgement === 'qualified' ? 'qualified' : 'unqualified'
}

/** QD-14：复检发起校验（任一条不满足整单失败、不部分提交）。 */
export function assertReInspectionInitiable(input: {
  storageStatus: BatchStorageStatus
  /** 同批次发起复检是否已有码存在复检记录（同码同批次至多一次；本函数按批内每码单判） */
  alreadyHasReInspection: boolean
  /** 当前生效结论是否不合格 */
  effectiveConclusion: PurchaseInspectionConclusion
  unitNo: string
}): void {
  if (input.storageStatus === 'returned') {
    throw new DispositionRuleViolation('QD-17', '批次已退货，不可复检（入库状态=已退货硬拦截）')
  }
  if (input.alreadyHasReInspection) {
    throw new DispositionRuleViolation('QD-14', `码 ${input.unitNo} 同批次已有复检记录（同一码同一批次至多一次）`)
  }
  if (input.effectiveConclusion !== 'unqualified') {
    throw new DispositionRuleViolation(
      'QD-14',
      `码 ${input.unitNo} 当前生效结论为 ${input.effectiveConclusion}，复检发起条件=当前生效结论不合格且尚无复检`,
    )
  }
}

/** QD-16：撤检/切换有效结论的下游使用拦截（[合同新造·目标口径]）。
 * 该批次已被投料、发运、转换下游使用时：拦截并转隔离/追溯处置，不仅清空结论；原结论与处置版本并存可查。 */
export function assertNotDownstreamConsumed(input: {
  batchNo: string
  /** 已下游使用事实：批次（或其码/批号）存在投料/发运/转换类下游流水或谱系消耗边 */
  downstreamConsumed: boolean
}): void {
  if (input.downstreamConsumed) {
    throw new DispositionRuleViolation(
      'QD-16',
      `批次 ${input.batchNo} 已被下游使用（投料/发运/转换），撤检或切换有效结论被拦截：转隔离/追溯处置（影响圈定走正向追溯，原结论与处置版本并存可查）`,
    )
  }
}

/** QD-18：复检终态守卫（[合同新造]）——复检仍不合格时保持不合格＋隔离；
 * 终态处置（报废/让步/降级）随 GAP-F17 裁定；裁定前不得自动转合格或静默清结论。 */
export function assertReInspectionTerminal(input: {
  unitNo: string
  newConclusion: PurchaseInspectionConclusion
}): void {
  if (input.newConclusion !== 'unqualified') return
  // 复检不合格：合法且保持不合格（终态处置走 QD-20 处置决定；GAP-F17 待裁项不在此自动处置）
}
