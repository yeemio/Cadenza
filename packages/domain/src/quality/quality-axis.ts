import { QualityRuleViolation } from './errors'

/**
 * 质量状态轴纯规则 —— 规则底稿 04 §A-T12-1/2 + 冻结合同 inventory-trace-core.md IT-14。
 */

/**
 * A-T12-1：质量状态轴六值——待检/免检/合格/不合格/待复检/存疑。
 * 隔离（quality_hold）与处置（quality_disposition）独立于状态轴另记；
 * 「审核通过」≠「质检合格」（放行人/判定人分离，见 disposition 记录列）。
 */
export const QUALITY_AXIS = [
  'pending_inspection', // 待检
  'exempt', // 免检
  'qualified', // 合格
  'unqualified', // 不合格
  're_inspection', // 待复检
  'suspect', // 存疑
] as const
export type QualityAxisValue = (typeof QUALITY_AXIS)[number]

export const QUALITY_AXIS_LABELS: Readonly<Record<QualityAxisValue, string>> = {
  pending_inspection: '待检',
  exempt: '免检',
  qualified: '合格',
  unqualified: '不合格',
  re_inspection: '待复检',
  suspect: '存疑',
}

/** 库存余额质量四值（0004 stock_balance.quality_status，IT-14 口径）。 */
export type BalanceQualityStatus = 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect'

/**
 * A-T12-1/IT-14：质量轴六值 → 库存余额四值投影。
 * 待复检投影为待检（不可用）；其余一一对应。隔离与处置不并入轴（另记 quality_hold/disposition）。
 */
export function projectQualityAxisToBalance(status: QualityAxisValue): BalanceQualityStatus {
  if (status === 're_inspection') return 'pending_inspection' // 待复检投影待检（不可用）
  if (status === 'exempt') return 'qualified' // 免检视同合格（无需检验即可用）
  return status
}

/**
 * A-T12-2/IT-14：质量条件是否放行进入可用量与发运。
 * 待检/不合格/存疑不得进入可用量、不得发运；免检视同合格（无需检验即可用）；
 * 待复检在复检结论生效前不可用。
 */
export function isQualityUsable(status: QualityAxisValue): boolean {
  return status === 'qualified' || status === 'exempt'
}

/** A-T12-2：不可用质量状态（待检/不合格/存疑/待复检）不得进入可用量与发运。 */
export function assertQualityNotBlockedForUse(status: QualityAxisValue, unitNo?: string): void {
  if (!isQualityUsable(status)) {
    throw new QualityRuleViolation(
      'A-T12-2',
      `单元 ${unitNo ?? ''}质量状态为${QUALITY_AXIS_LABELS[status]}，不得进入可用量与发运（可用量只由满足质量和预留条件的余额形成）`,
    )
  }
}

/**
 * A-T12-1：让步放行保留原不合格事实——让步记录必须显式引用原结论版本（based_on_version），
 * 且原结论链（生效行）不被清除或改写；本断言校验让步依据版本与生效结论一致。
 */
export function assertConcessionBasedOnEffectiveVersion(input: {
  effectiveConclusion: 'pending' | 'qualified' | 'unqualified'
  effectiveVersion: number
  basedOnVersion: number
}): void {
  if (input.effectiveConclusion !== 'unqualified') {
    throw new QualityRuleViolation(
      'A-T12-1',
      `让步放行仅针对生效结论为不合格的检验单（当前生效结论 ${input.effectiveConclusion}）；让步保留原不合格事实`,
    )
  }
  if (input.basedOnVersion !== input.effectiveVersion) {
    throw new QualityRuleViolation(
      'A-T12-1',
      `让步放行必须引用当前生效结论版本（生效 v${input.effectiveVersion}、载荷 v${input.basedOnVersion}）；保留原不合格事实不得错位`,
    )
  }
}

/** A-T12-1：受权放行——仅生效结论为合格时可常规放行（不合格走让步，待检不可放行）。 */
export function assertReleaseExecutable(input: {
  effectiveConclusion: 'pending' | 'qualified' | 'unqualified'
  alreadyReleased: boolean
}): void {
  if (input.alreadyReleased) {
    throw new QualityRuleViolation('A-T12-1', '该检验单已有生效处置（放行/让步），不得重复处置')
  }
  if (input.effectiveConclusion === 'pending') {
    throw new QualityRuleViolation('A-T12-1', '检验尚未出结论（生效结论为待检），不可放行')
  }
  if (input.effectiveConclusion === 'unqualified') {
    throw new QualityRuleViolation(
      'A-T12-1',
      '生效结论为不合格：常规放行不可用（受权让步放行走 concession，且保留原不合格事实）',
    )
  }
}
