import { PurchaseRuleViolation } from './errors'

/**
 * 采购质检规则 [底稿 A-6 / A-7 / A-8]，S14 目标口径（结论版本化）。
 *
 * [A-6] 批次质检状态 6 态（免检/待质检/质检中/全部合格/全部不合格/部分合格）= 各码当前生效结论汇总；
 *       单码首检+复检各一条、复检至多一次（PRD 采购质检 §1.2/§3.1）。
 * [A-7] 结论写入：PDA 单码可反复提交（后次覆盖=追加版本行）；Web 质检/批量质检只补仍待检码不改已有结论；
 *       Web 判定合格/不合格整批覆盖各码生效结论 + 判定记录（同批次仅一条生效，新覆盖旧=版本追加）。
 * [A-8] 撤销质检：码结论为合格/不合格且批次未退货 → 生效指针切回首检初始行（保留历史，
 *       PRD 采购明细 §2.1 撤销质检的 S14 目标口径：不物理清结论，清质检人/时间语义由初始行承载）。
 * [S14] 追加历史+生效结论版本化（PI S14 裁定，B-1）：判定/撤销不清历史，结论变更=新版本行+指针切换。
 */

// ---------------- 状态轴 ----------------

/** 批次质检状态 6 态（PRD 采购批次 §1.2 字典；DM §5 质量行目标口径）。 */
export type BatchInspectionStatus =
  | 'exempt' // 免检
  | 'pending' // 待质检
  | 'in_progress' // 质检中
  | 'all_qualified' // 全部合格
  | 'all_unqualified' // 全部不合格
  | 'partially_qualified' // 部分合格

export const BATCH_INSPECTION_STATUS_LABELS: Readonly<Record<BatchInspectionStatus, string>> = {
  exempt: '免检',
  pending: '待质检',
  in_progress: '质检中',
  all_qualified: '全部合格',
  all_unqualified: '全部不合格',
  partially_qualified: '部分合格',
}

/** 明细（单码）质量状态 5 态（T12 底稿：免检/待检/合格/不合格/待复检）。 */
export type DetailQualityStatus =
  | 'exempt'
  | 'pending_inspection'
  | 'qualified'
  | 'unqualified'
  | 're_inspection'

export const DETAIL_QUALITY_STATUS_LABELS: Readonly<Record<DetailQualityStatus, string>> = {
  exempt: '免检',
  pending_inspection: '待检',
  qualified: '合格',
  unqualified: '不合格',
  re_inspection: '待复检',
}

/** 库存余额质量状态（0004 stock_balance.quality_status 四值）。 */
export type BalanceQualityStatus = 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect'

/**
 * 明细质量状态 → 库存余额质量状态（T12 质量闸门消费口径）：
 * 免检=直接可用（qualified）；待检/待复检=不可用（pending_inspection）；
 * 合格=qualified；不合格=unqualified。
 */
export function mapDetailStatusToBalanceQuality(status: DetailQualityStatus): BalanceQualityStatus {
  switch (status) {
    case 'exempt':
    case 'qualified':
      return 'qualified'
    case 're_inspection':
    case 'pending_inspection':
      return 'pending_inspection'
    case 'unqualified':
      return 'unqualified'
  }
}

/**
 * [A-4] 免检判定（依据 material.qc_flag，PRD 采购批次 §3.1 确认收货）：
 * qc_flag=0（无需质检）→ 明细免检（exempt，库存直接可用）；qc_flag=1（需要质检）→ 待检。
 */
export function initialDetailQualityStatus(materialQcFlag: number): DetailQualityStatus {
  return materialQcFlag === 0 ? 'exempt' : 'pending_inspection'
}

/**
 * [A-6] 批次质检状态 = 各明细当前质量状态（生效结论）汇总（6 态）：
 * - 全部免检 → 免检；全部待检 → 待质检；
 * - 全部合格 → 全部合格；全部不合格 → 全部不合格；合格+不合格混合 → 部分合格；
 * - 其余（存在待检/待复检且有结论）→ 质检中。
 */
export function summarizeBatchInspection(statuses: readonly DetailQualityStatus[]): BatchInspectionStatus {
  if (statuses.length === 0) {
    throw new PurchaseRuleViolation('A-6', '批次无明细，无法汇总质检状态')
  }
  const all = (pred: (s: DetailQualityStatus) => boolean): boolean => statuses.every(pred)
  if (all((s) => s === 'exempt')) return 'exempt'
  if (all((s) => s === 'pending_inspection')) return 'pending'
  if (all((s) => s === 'qualified')) return 'all_qualified'
  if (all((s) => s === 'unqualified')) return 'all_unqualified'
  const onlyVerdicts = all((s) => s === 'qualified' || s === 'unqualified')
  if (onlyVerdicts) return 'partially_qualified'
  return 'in_progress'
}

// ---------------- 结论写入（S14 版本化） ----------------

/** 质检结论值（质检记录行 conclusion 列；首检初始行可携带 exempt/pending）。 */
export type InspectionConclusion = 'exempt' | 'pending' | 'qualified' | 'unqualified'

/** 结论来源（inspection_record.source 列）：receive 收货首记录 / pda 单码 / web 批量补录 / judge 整批判定 / reinspection_start 发起复检。 */
export type InspectionSource = 'receive' | 'pda' | 'web' | 'judge' | 'reinspection_start'

/**
 * [S14] 下一版本号：同链（detail + type）版本递增；首条为 1。
 */
export function nextInspectionVersion(existingVersions: readonly number[]): number {
  return existingVersions.reduce((max, v) => (v > max ? v : max), 0) + 1
}

/**
 * [A-7] PDA 单码结论可提交前置（PRD 采购质检 §3.1 合格/不合格/修改）：
 * - 批次未退货；免检的码不可提交（判定路径走 judge）；
 * - 首检链已有复检记录 → 不可再提交首检，须操作复检记录（复检优先）。
 * 返回应写入的链（'re' 当复检链存在，否则 'first'）。
 */
export function resolveInspectionChainForCode(input: {
  detailStatus: DetailQualityStatus
  storageStatus: 'stored' | 'returned'
  hasReinspection: boolean
}): 'first' | 're' {
  if (input.storageStatus === 'returned') {
    throw new PurchaseRuleViolation('A-7', '已退货批次不可再质检、判定（PRD 采购质检 §1.2 入库状态）')
  }
  if (input.detailStatus === 'exempt') {
    throw new PurchaseRuleViolation('A-7', '免检的码不可提交单码质检结论（整批判定路径另行执行）')
  }
  return input.hasReinspection ? 're' : 'first'
}

/**
 * [A-7] Web 质检/批量质检写入判定：只补仍待检码，不改已有结论
 * （PRD 采购质检 §2.1 质检逻辑「仅当当前生效质检行仍为待质检时写入」；待复检码同样可补）。
 */
export function shouldWebInspectionWriteCode(currentStatus: DetailQualityStatus): boolean {
  return currentStatus === 'pending_inspection' || currentStatus === 're_inspection'
}

/**
 * [A-7] Web 质检/批量质检可执行前置：批次未退货且状态为待质检或质检中。
 */
export function assertWebInspectionExecutable(input: {
  batchStatus: BatchInspectionStatus
  storageStatus: 'stored' | 'returned'
}): void {
  if (input.storageStatus === 'returned') {
    throw new PurchaseRuleViolation('A-7', '已退货批次不可再质检、判定')
  }
  if (input.batchStatus !== 'pending' && input.batchStatus !== 'in_progress') {
    throw new PurchaseRuleViolation(
      'A-7',
      `批量质检仅对待质检或质检中批次可执行，当前为 ${BATCH_INSPECTION_STATUS_LABELS[input.batchStatus]}`,
    )
  }
}

/**
 * [A-7] 整批判定可执行前置（PRD 采购质检 §2.1 判定合格/判定不合格按钮显隐）：
 * - 判定合格：批次未退货且状态为部分合格或全部不合格；
 * - 判定不合格：批次未退货且状态为免检、全部合格或部分合格（B-7：免检原事实经版本行保留）。
 */
export function assertJudgeExecutable(input: {
  conclusion: 'qualified' | 'unqualified'
  batchStatus: BatchInspectionStatus
  storageStatus: 'stored' | 'returned'
}): void {
  if (input.storageStatus === 'returned') {
    throw new PurchaseRuleViolation('A-7', '已退货批次不可再质检、判定')
  }
  if (input.conclusion === 'qualified') {
    if (input.batchStatus !== 'partially_qualified' && input.batchStatus !== 'all_unqualified') {
      throw new PurchaseRuleViolation(
        'A-7',
        `判定合格仅对部分合格或全部不合格批次可执行，当前为 ${BATCH_INSPECTION_STATUS_LABELS[input.batchStatus]}`,
      )
    }
    return
  }
  if (
    input.batchStatus !== 'exempt' &&
    input.batchStatus !== 'all_qualified' &&
    input.batchStatus !== 'partially_qualified'
  ) {
    throw new PurchaseRuleViolation(
      'A-7',
      `判定不合格仅对免检、全部合格或部分合格批次可执行，当前为 ${BATCH_INSPECTION_STATUS_LABELS[input.batchStatus]}`,
    )
  }
}

/**
 * [A-6] 发起复检前置（PRD 采购质检 §3.2 提交质检）：当前生效结论须为不合格且尚无复检
 * （复检至多一次）；批次未退货。无质检记录的码补首检（由调用方分支处理）。
 */
export function assertReinspectionStartable(input: {
  detailStatus: DetailQualityStatus
  hasReinspection: boolean
  storageStatus: 'stored' | 'returned'
}): void {
  if (input.storageStatus === 'returned') {
    throw new PurchaseRuleViolation('A-6', '已退货批次不可发起复检')
  }
  if (input.hasReinspection) {
    throw new PurchaseRuleViolation('A-6', '该码该批次复检至多一次，已存在复检记录')
  }
  if (input.detailStatus !== 'unqualified') {
    throw new PurchaseRuleViolation(
      'A-6',
      `复检仅可对当前生效结论为不合格的码发起，当前为 ${DETAIL_QUALITY_STATUS_LABELS[input.detailStatus]}`,
    )
  }
}

// ---------------- 撤销质检（A-8，S14：保留历史、切生效指针） ----------------

/**
 * [A-8] 撤销质检前置（PRD 采购明细 §2.1 撤销质检）：码当前生效结论为合格或不合格
 * 且所属批次未退货；生效行即首检初始行（v1，无结论）→ 无可撤销结论。
 */
export function assertRevocationAllowed(input: {
  effectiveConclusion: InspectionConclusion
  effectiveVersion: number
  storageStatus: 'stored' | 'returned'
}): void {
  if (input.storageStatus === 'returned') {
    throw new PurchaseRuleViolation('A-8', '已退货批次不可撤销质检')
  }
  if (input.effectiveConclusion !== 'qualified' && input.effectiveConclusion !== 'unqualified') {
    throw new PurchaseRuleViolation(
      'A-8',
      `仅合格或不合格结论可撤销，当前生效结论为 ${input.effectiveConclusion}`,
    )
  }
  if (input.effectiveVersion <= 1) {
    throw new PurchaseRuleViolation('A-8', '首检初始记录无可撤销的结论')
  }
}

/**
 * [A-8] 撤销后的明细回退状态：撤销链的首检初始行（v1）结论即回退目标——
 * 首检链 v1=pending → 待检；v1=exempt（免检被判定后撤销）→ 免检（B-7 保留免检原事实）；
 * 复检链撤销 → 待复检（复检链 v1 为复检中）。
 */
export function revokedDetailStatus(input: {
  chain: 'first' | 're'
  initialConclusion: InspectionConclusion
}): DetailQualityStatus {
  if (input.chain === 're') return 're_inspection'
  return input.initialConclusion === 'exempt' ? 'exempt' : 'pending_inspection'
}
