import type { DecimalString } from '@cadenza/contracts'
import { SpcRuleViolation } from './errors'
import { mulDivSpcQty, toSpcScaled, formatSpcScaled } from './quantity'

/**
 * 工艺变更影响控制纯规则（冻结合同 §1–§2：PE-01～PE-07）。
 *
 * PE-01/02 承接 T05 已冻结部分：工艺版本模型（草稿→审核→发布→失效、发布冻结、
 * 订单下达快照引用）不在本域重定义；本域只做 G4 变更影响控制增量——变更单、
 * 影响圈定、在制处置、审批与执行版本对应、PE-07 行为边界守卫。
 */

// ---------------- 字典值 ----------------

/** 变更单状态：draft 草稿（扫描/处置中）→ published 已生效。 */
export const SPC_CHANGE_STATUSES = ['draft', 'published'] as const
export type SpcChangeStatus = (typeof SPC_CHANGE_STATUSES)[number]

/** 影响任务分类（PE-03/PE-06）：unexecuted=受影响未执行；in_process=在制；completed=已完成/已发运（提示范围）。 */
export const SPC_IMPACT_CATEGORIES = ['unexecuted', 'in_process', 'completed'] as const
export type SpcImpactCategory = (typeof SPC_IMPACT_CATEGORIES)[number]

/** 在制处置选项集（PE-04）：①继续旧版完成 ②转新版 ③隔离评审。 */
export const SPC_IN_PROCESS_DISPOSITIONS = ['continue_old', 'switch_new', 'isolation_review'] as const
export type SpcInProcessDisposition = (typeof SPC_IN_PROCESS_DISPOSITIONS)[number]

/** 工序变动种类（PE-07 命令守卫输入：原文约束保留）。 */
export const SPC_OPERATION_MUTATION_KINDS = ['add', 'rename', 'reorder', 'remove'] as const
export type SpcOperationMutationKind = (typeof SPC_OPERATION_MUTATION_KINDS)[number]

export interface SpcOperationMutation {
  kind: SpcOperationMutationKind
  /** rename/reorder/remove 的目标工序 seq（add 无目标）。 */
  targetSeq?: number
}

/** 变更单内嵌的工序变动清单元素（载荷形状校验）。 */
export function assertOperationMutationShape(mutation: SpcOperationMutation, index: number): void {
  if (!SPC_OPERATION_MUTATION_KINDS.includes(mutation.kind)) {
    throw new SpcRuleViolation(
      'PE-07',
      `第 ${index + 1} 条工序变动 kind 非法：${String(mutation.kind)}（须为 add/rename/reorder/remove）`,
    )
  }
  if (mutation.kind !== 'add') {
    if (!Number.isInteger(mutation.targetSeq) || (mutation.targetSeq ?? 0) < 1) {
      throw new SpcRuleViolation('PE-07', `第 ${index + 1} 条工序变动缺少目标工序 seq（targetSeq ≥ 1）`)
    }
  }
}

// ---------------- PE-S1/PE-05：变更单形状 ----------------

/**
 * PE-05 变更单形状：版本对（旧→新）、审批人、生效时间非空（PE-S1）；
 * 旧新版本不同且同属一个规范对象（同 plant + 规范名）。
 */
export function assertChangeOrderShape(input: {
  oldSpecRevisionId: string
  newSpecRevisionId: string
  sameSpecObject: boolean
  approver: string
  effectiveAt: string
}): void {
  if (!input.oldSpecRevisionId || !input.newSpecRevisionId) {
    throw new SpcRuleViolation('PE-S1', '变更单必须携带版本对（旧版本→新版本），两者不可为空')
  }
  if (input.oldSpecRevisionId === input.newSpecRevisionId) {
    throw new SpcRuleViolation('PE-S1', '变更单版本对的旧版本与新版本相同（须为不同的两个版本）')
  }
  if (!input.sameSpecObject) {
    throw new SpcRuleViolation('PE-S1', '变更单版本对必须指向同一规范对象（同工厂同规范名，仅版本不同）')
  }
  if (!(input.approver ?? '').trim()) {
    throw new SpcRuleViolation('PE-S1', '变更单审批人不可为空（审批与执行版本对应 PE-05）')
  }
  if (!input.effectiveAt || Number.isNaN(Date.parse(input.effectiveAt))) {
    throw new SpcRuleViolation('PE-S1', '变更单生效时间不可为空且必须为可解析时间')
  }
}

// ---------------- PE-03：未执行任务判定 ----------------

/**
 * PE-03 影响分类（可判定口径）：
 * - 订单已结束（closed）→ completed（已完成/已发运，不可变更，仅提示范围）；
 * - 工序存在已提交报工（草稿不计）→ in_process（已开工未完成，逐单显式处置 PE-04）；
 * - 其余 → unexecuted（未执行；已排产未开工属"可调整未执行"）。
 * 作废单（voided）不在影响范围。
 */
export function classifyOrderImpact(input: {
  orderStatus: string
  hasSubmittedReport: boolean
}): SpcImpactCategory | null {
  if (input.orderStatus === 'voided') return null
  if (input.orderStatus === 'closed') return 'completed'
  if (input.hasSubmittedReport) return 'in_process'
  return 'unexecuted'
}

// ---------------- PE-04：在制处置选项集 ----------------

/** PE-04：在制任务必须显式选择处置（三选项之一）；未执行/已完成任务无需选择。 */
export function assertDispositionChoice(input: {
  category: SpcImpactCategory
  disposition: SpcInProcessDisposition | null
}): void {
  if (input.category === 'in_process') {
    if (input.disposition === null || !SPC_IN_PROCESS_DISPOSITIONS.includes(input.disposition)) {
      throw new SpcRuleViolation(
        'PE-04',
        `在制任务必须显式选择处置（continue_old 继续旧版 / switch_new 转新版 / isolation_review 隔离评审）：收到 ${String(input.disposition)}`,
      )
    }
    return
  }
  if (input.disposition !== null) {
    throw new SpcRuleViolation(
      'PE-04',
      `${input.category === 'unexecuted' ? '未执行任务随变更自动重算（无需选择处置）' : '已完成/已发运任务不可变更（无需选择处置）'}：收到 ${String(input.disposition)}`,
    )
  }
}

/** PE-05 执行版本对应：任务遵循的版本引用（可回查"审批的是哪版、执行的是哪版"）。 */
export function followsVersionAfterChange(input: {
  category: SpcImpactCategory
  disposition: SpcInProcessDisposition | null
}): 'old' | 'new' {
  if (input.category === 'unexecuted') return 'new' // PE-03：未执行任务随变更按新版重算
  if (input.category === 'completed') return 'old' // PE-02：历史实绩保留旧参数
  switch (input.disposition) {
    case 'continue_old':
      return 'old'
    case 'switch_new':
      return 'new'
    case 'isolation_review':
      // 隔离评审=暂停并挂质量评审；处置未定前保守按旧版（评审后另行决策）
      return 'old'
    default:
      throw new SpcRuleViolation('PE-04', '在制任务未选择处置，无法确定执行版本')
  }
}

// ---------------- PE-S1/PE-04：生效前置 ----------------

/**
 * PE-S1/PE-04 生效前置：draft 才可发布；影响清单中全部在制任务均已逐单处置
 * （无未处置在制任务方可生效）；不允许不选择即发布。
 */
export function assertChangePublishable(input: {
  status: SpcChangeStatus
  impacts: ReadonlyArray<{ category: SpcImpactCategory; disposition: SpcInProcessDisposition | null }>
}): void {
  if (input.status !== 'draft') {
    throw new SpcRuleViolation('PE-S1', `变更单已生效（${input.status}），不可重复发布`)
  }
  const undisposed = input.impacts.filter((i) => i.category === 'in_process' && i.disposition === null)
  if (undisposed.length > 0) {
    throw new SpcRuleViolation(
      'PE-04',
      `存在 ${undisposed.length} 条未处置的在制任务：不允许不选择处置即发布（continue_old/switch_new/isolation_review 逐单显式选择）`,
    )
  }
}

// ---------------- PE-03：计划量自动重算 ----------------

/** 合成因子 = 芯倍数 × 绞合系数（绞合缺省 1；口径同 process 域，PE-03 重算输入）。 */
export function compositeFactor(input: {
  coreMultiple: number
  strandFactor: DecimalString | null
}): DecimalString {
  if (!Number.isInteger(input.coreMultiple) || input.coreMultiple < 1) {
    throw new SpcRuleViolation('PE-03', `芯倍数必须为正整数：${String(input.coreMultiple)}`)
  }
  const strand = input.strandFactor ?? '1.0000'
  const scaled = toSpcScaled(strand, '绞合系数')
  if (scaled <= 0n) throw new SpcRuleViolation('PE-03', '绞合系数必须大于 0')
  return formatSpcScaled(scaled * BigInt(input.coreMultiple))
}

/**
 * PE-03 计划量重算（已排产未开工=可调整未执行，随变更自动重算并留调整记录）：
 * 新计划量 = 旧计划量 × 新合成因子 / 旧合成因子（4 位定点半入）。
 * 历史实绩不重算（PE-02）：completed/in_process 任务不走本函数。
 */
export function recomputePlannedQty(input: {
  plannedQty: DecimalString
  oldFactor: DecimalString
  newFactor: DecimalString
}): DecimalString {
  const planned = toSpcScaled(input.plannedQty, '计划量')
  if (planned < 0n) throw new SpcRuleViolation('PE-03', '计划量不得为负')
  return mulDivSpcQty(input.plannedQty, input.newFactor, input.oldFactor, '计划量重算')
}

// ---------------- PE-07：已有报工的工序行为边界 ----------------

/**
 * PE-07 命令守卫（原文约束保留，原件 生产订单.md §2.1 工序设置）：
 * 已有报工的订单工序——不可新增工序、不可改工序名称、不可调序、不可删行。
 * reportedSeqs = 存在已提交报工的工序 seq 集合。
 */
export function assertOperationMutationsAllowed(input: {
  mutations: ReadonlyArray<SpcOperationMutation>
  reportedSeqs: ReadonlyArray<number>
}): void {
  const reported = new Set(input.reportedSeqs)
  for (const [index, mutation] of input.mutations.entries()) {
    assertOperationMutationShape(mutation, index)
    if (reported.size === 0) continue // 该订单无任何已提交报工：原文约束不触发
    if (mutation.kind === 'add') {
      throw new SpcRuleViolation(
        'PE-07',
        '已有报工的工序不可新增工序（原文约束保留：报工后工序行只读）',
      )
    }
    if (mutation.targetSeq !== undefined && reported.has(mutation.targetSeq)) {
      const label = mutation.kind === 'rename' ? '改工序名称' : mutation.kind === 'reorder' ? '调序' : '删行'
      throw new SpcRuleViolation(
        'PE-07',
        `已有报工的工序不可${label}（工序 seq=${mutation.targetSeq} 存在已提交报工）`,
      )
    }
  }
}
