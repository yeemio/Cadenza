import { QualityRuleViolation } from './errors'
import { isQualityUsable, type QualityAxisValue } from './quality-axis'

/**
 * 参数化出库闸门纯规则 —— 规则底稿 04 §A-T12-2/4（RM T12 验收标准；
 * 原件 调拨出库 §3.2「质检未通过且系统参数不允许质检未完成出库」→ 拒绝）。
 */

/** 出库闸门参数（C-9 缺口：参数默认值与配置归属待 Owner 裁定，此处参数化不定死）。 */
export interface OutboundGatePolicy {
  /**
   * A-T12-4：质检未完成（待检/待复检/不合格）时是否允许出库。
   * false=不允许（严格模式，RM T12 验收基线）；true=允许（放行模式，参数化）。
   * 存疑（suspect）不受该参数控制——任何模式下均拒绝（A-T12-3 存疑不得出库）。
   */
  allowUnfinishedOutbound: boolean
}

/** 默认严格模式：质检未完成禁出库（RM T12 验收标准基线；C-9 待裁后可配置化）。 */
export const DEFAULT_OUTBOUND_GATE_POLICY: OutboundGatePolicy = { allowUnfinishedOutbound: false }

/**
 * A-T12-2/A-T12-4：出库前质量闸门（参数化）。
 * 存疑恒拒（A-T12-3）；待检/待复检/不合格在 allowUnfinishedOutbound=false 时拒；
 * 合格/免检恒放行。可用量 = 质量 ∧ 预留（质量维度在本断言，预留维度由库存域 IT-14/IT-23 承担）。
 */
export function assertOutboundQualityGate(input: {
  qualityStatus: QualityAxisValue
  policy?: OutboundGatePolicy
  unitNo?: string
  action?: string
}): void {
  const policy = input.policy ?? DEFAULT_OUTBOUND_GATE_POLICY
  if (isQualityUsable(input.qualityStatus)) return
  const action = input.action ?? '出库'
  if (input.qualityStatus === 'suspect') {
    // A-T12-3：存疑不受参数控制，任何模式拒绝出库
    throw new QualityRuleViolation(
      'A-T12-3',
      `单元 ${input.unitNo ?? ''}处于质量存疑，禁止${action}（存疑不得进入可用量与发运）`,
    )
  }
  if (!policy.allowUnfinishedOutbound) {
    throw new QualityRuleViolation(
      'A-T12-4',
      `单元 ${input.unitNo ?? ''}质检未完成（${input.qualityStatus}），系统参数不允许质检未完成${action}（待检/待复检/不合格不可用）`,
    )
  }
}
