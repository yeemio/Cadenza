import type { DecimalString } from '@cadenza/contracts'
import { SpcRuleViolation } from './errors'
import { addSpcQty, cmpSpcQty, toSpcScaled } from './quantity'

/**
 * 工具寿命纯规则（冻结合同 §5：PE-20/PE-21，表级 PE-S5）。
 * 工具/模具寿命为 T22 工装约束（CS-05 扩展项）的数据来源：到期处置由排产域
 * 消费（本域暴露等价服务判定，收编请求见交付记录；GAP-E19 清单随现场工具台账）。
 */

// ---------------- PE-20：寿命配置 ----------------

/** 寿命计量单位（按工具类型配置：次数/米数/小时）。 */
export const SPC_TOOL_LIFE_UOMS = ['count', 'meters', 'hours'] as const
export type SpcToolLifeUom = (typeof SPC_TOOL_LIFE_UOMS)[number]

export const SPC_TOOL_LIFE_UOM_LABELS: Readonly<Record<SpcToolLifeUom, string>> = {
  count: '次数',
  meters: '米数',
  hours: '小时',
}

/** 到期处置（版本化配置）：block 禁用 / degrade 降级用。 */
export const SPC_TOOL_EXPIRE_POLICIES = ['block', 'degrade'] as const
export type SpcToolExpirePolicy = (typeof SPC_TOOL_EXPIRE_POLICIES)[number]

export const SPC_TOOL_EXPIRE_POLICY_LABELS: Readonly<Record<SpcToolExpirePolicy, string>> = {
  block: '禁用',
  degrade: '降级用',
}

/** 累计消耗来源（OT-26 显式映射）：报工产出 / 采集样本。 */
export const SPC_TOOL_USAGE_SOURCES = ['work_report_output', 'collected_sample'] as const
export type SpcToolUsageSource = (typeof SPC_TOOL_USAGE_SOURCES)[number]

/** 工具状态：normal 正常 / warning 预警 / expired 到期。 */
export const SPC_TOOL_STATUSES = ['normal', 'warning', 'expired'] as const
export type SpcToolStatus = (typeof SPC_TOOL_STATUSES)[number]

/** PE-20 寿命配置形状（预警阈值与到期处置为版本化配置）。 */
export function assertToolConfigShape(input: {
  lifeUom: string
  ratedLife: DecimalString
  warningThreshold: DecimalString
  expirePolicy: string
  version: number
}): void {
  if (!SPC_TOOL_LIFE_UOMS.includes(input.lifeUom as SpcToolLifeUom)) {
    throw new SpcRuleViolation('PE-20', `寿命计量单位非法：${input.lifeUom}（按工具类型配置：次数/米数/小时）`)
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new SpcRuleViolation('PE-20', `寿命配置版本必须为正整数：${String(input.version)}`)
  }
  const rated = toSpcScaled(input.ratedLife, '额定寿命')
  if (rated <= 0n) throw new SpcRuleViolation('PE-20', '额定寿命必须大于 0')
  const warning = toSpcScaled(input.warningThreshold, '预警阈值')
  if (warning < 0n) throw new SpcRuleViolation('PE-20', '预警阈值不得为负')
  if (warning > rated) throw new SpcRuleViolation('PE-20', '预警阈值不得高于额定寿命')
  if (!SPC_TOOL_EXPIRE_POLICIES.includes(input.expirePolicy as SpcToolExpirePolicy)) {
    throw new SpcRuleViolation('PE-20', `到期处置非法：${input.expirePolicy}（须为 禁用/降级用）`)
  }
}

/** PE-20 配置修订：版本必须递增（v+1 起走新版本行，历史版本 append-only 留痕）。 */
export function nextToolConfigVersion(existingVersions: readonly number[]): number {
  return existingVersions.reduce((m, v) => Math.max(m, v), 0) + 1
}

// ---------------- PE-20：寿命累计 ----------------

/** PE-20 累计消耗：数量必须为正、来源经 OT-26 显式映射（报工产出/采集样本）。 */
export function assertToolConsumption(input: {
  quantity: DecimalString
  source: string
  refType: string
  refId: string
}): void {
  if (!SPC_TOOL_USAGE_SOURCES.includes(input.source as SpcToolUsageSource)) {
    throw new SpcRuleViolation('PE-20', `寿命累计来源非法：${input.source}（须经显式映射：报工产出/采集样本）`)
  }
  if (!(input.refType ?? '').trim() || !(input.refId ?? '').trim()) {
    throw new SpcRuleViolation('PE-20', '寿命累计必须携带来源引用（ref_type/ref_id，显式映射可追溯）')
  }
  if (toSpcScaled(input.quantity, '寿命累计量') <= 0n) {
    throw new SpcRuleViolation('PE-20', '寿命累计量必须大于 0')
  }
}

/**
 * PE-21/PE-S5 寿命累计只增不改：列级只增（库级触发器双保险），
 * 修正不得静默重置——走具名调整（理由＋审计，调整审计行独立）。
 */
export function assertAccumulationNonDecreasing(input: {
  current: DecimalString
  next: DecimalString
  toolNo: string
}): void {
  if (cmpSpcQty(input.next, input.current) < 0) {
    throw new SpcRuleViolation(
      'PE-21',
      `工具 ${input.toolNo} 寿命累计只增不改（当前 ${input.current}，试图改为 ${input.next}）：修正须走具名调整（理由＋审计），不得静默重置`,
    )
  }
}

/** PE-21 具名调整：理由必填、调整量非零；调整审计行独立于累计列。 */
export function assertNamedAdjustment(input: { delta: DecimalString; reason: string }): void {
  if (!(input.reason ?? '').trim()) {
    throw new SpcRuleViolation('PE-21', '寿命修正必须填写具名调整理由（不得静默重置累计）')
  }
  if (toSpcScaled(input.delta, '调整量') === 0n) {
    throw new SpcRuleViolation('PE-21', '具名调整量不得为零（零调整无审计意义）')
  }
}

/** 有效寿命 = 累计列（只增）＋具名调整合计（带符号；审计行独立承载修正）。 */
export function effectiveToolLife(input: {
  accumulated: DecimalString
  adjustmentSum: DecimalString
}): DecimalString {
  return addSpcQty(input.accumulated, input.adjustmentSum)
}

/**
 * PE-20/21 工具寿命状态：有效寿命 ≥ 额定 → expired（到期）；
 * ≥ 预警阈值 → warning；否则 normal。
 */
export function computeToolLifeStatus(input: {
  ratedLife: DecimalString
  warningThreshold: DecimalString
  effectiveLife: DecimalString
}): SpcToolStatus {
  if (cmpSpcQty(input.effectiveLife, input.ratedLife) >= 0) return 'expired'
  if (cmpSpcQty(input.effectiveLife, input.warningThreshold) >= 0) return 'warning'
  return 'normal'
}

/**
 * PE-21 排产侧等价服务（T22 工装约束 / CS-05 扩展项）：到期且处置=禁用的工具
 * 阻止继续排产。排产域属共享域不自改，本规则由 spc 查询面暴露
 * （toolDetail.schedulableForScheduling），L0 整合时收编进排产前置。
 */
export function assertToolSchedulable(input: {
  status: SpcToolStatus
  expirePolicy: SpcToolExpirePolicy
  toolNo: string
}): void {
  if (input.status === 'expired' && input.expirePolicy === 'block') {
    throw new SpcRuleViolation(
      'PE-21',
      `工具 ${input.toolNo} 寿命已到期且到期处置为禁用：阻止继续排产（T22 工装约束，CS-05 扩展项）`,
    )
  }
}

/** PE-21 查询口径：可排产判定（到期+禁用 → false）。 */
export function isToolSchedulable(input: {
  status: SpcToolStatus
  expirePolicy: SpcToolExpirePolicy
}): boolean {
  return !(input.status === 'expired' && input.expirePolicy === 'block')
}
