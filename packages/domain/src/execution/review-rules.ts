import { ExecutionRuleViolation } from './errors'
import type { ReadinessOperation } from './readiness'

/**
 * 审核轴判定 —— [底稿 A6-4]。
 *
 * 以订单末道非质检工序为准（末道为质检时往前取最近非质检；全质检不自动审核）：
 * - 报非末道（非质检）→ 自动审核通过；
 * - 报末道非质检且该工序生产部门在「末道自动审核车间」配置 → 自动，否则待审核。
 *
 * [合同新造 + GAP C2]「末道自动审核车间」配置：PRD 无定义（任何文档均无维护界面/权限/口径），
 * 以注入配置承载（车间=生产部门 id 清单），缺省空清单=末道一律待审核（保守默认，不编造现场值）。
 *
 * 物流入口（保存产出即审核通过、提交生成入库单、不走审核后回写）不在本块三入口范围（01 §1.1），
 * 到达时另接（DM §5 物流入口连入库任务，不制造第二份产出、自动审核不绕过校验）。
 */

export type ReviewOutcome = 'auto_approved' | 'pending_review'

/** [底稿 A6-4] 末道非质检工序（末道为质检时往前取最近非质检；全质检返回 null）。 */
export function resolveLastNonQcOperation(
  operations: readonly ReadinessOperation[],
): ReadinessOperation | null {
  const ordered = [...operations].sort((a, b) => b.seq - a.seq)
  return ordered.find((op) => !op.isQc) ?? null
}

/**
 * [底稿 A6-4 + 合同新造 GAP C2] 审核轴判定：
 * - 全质检订单不自动审核（无末道非质检工序）；
 * - 非末道（相对末道非质检工序）→ 自动审核通过；
 * - 末道非质检且生产部门 ∈ autoReviewDeptIds → 自动，否则待审核。
 */
export function decideReviewOutcome(input: {
  operations: readonly ReadinessOperation[]
  reportedSeq: number
  /** 「末道自动审核车间」配置（生产部门 id 清单；缺省空=末道一律待审核）。 */
  autoReviewDeptIds: readonly string[]
}): ReviewOutcome {
  const last = resolveLastNonQcOperation(input.operations)
  if (last === null) {
    return 'pending_review' // 全质检不自动审核
  }
  if (input.reportedSeq !== last.seq) {
    return 'auto_approved' // 报非末道 → 自动审核通过
  }
  if (last.productionDeptId !== null && input.autoReviewDeptIds.includes(last.productionDeptId)) {
    return 'auto_approved'
  }
  return 'pending_review'
}

/**
 * [底稿 A6-5] 审核统一动作的前置：草稿不能审核（提交后才有审核轴）；已审核单不可重复审核；
 * 已取消审核（撤审）后的单可重新审核（04 §2.2）。
 */
export function assertReviewTransitionAllowed(input: {
  status: string
  reviewStatus: string
}): void {
  if (input.status === 'draft') {
    throw new ExecutionRuleViolation('A6-5', '草稿不能审核（须先提交）')
  }
  if (input.reviewStatus === 'auto_approved' || input.reviewStatus === 'manual_approved') {
    throw new ExecutionRuleViolation('A6-5', '报工单已审核通过，不可重复审核（更正走编辑/冲销）')
  }
  if (input.reviewStatus !== 'pending_review' && input.reviewStatus !== 'cancelled') {
    throw new ExecutionRuleViolation('A6-5', `报工单审核轴状态 ${input.reviewStatus} 不可审核`)
  }
}

/**
 * [底稿 A6-5] 末道产出外传判定（04 §2.2）：末道非质检 → 推 ERP + 上架任务；
 * 样品订单不推 ERP（0005 无样品标志列，[合同新造] 以 orderType 判定，默认非样品）。
 */
export function shouldPushLastOperationOutput(input: {
  isLastNonQc: boolean
  orderType: string | null
}): boolean {
  if (!input.isLastNonQc) return false
  return input.orderType !== 'SAMPLE' // 样品订单不推（类型值 [合同新造]，GAP：现场订单类型清单未提供）
}

/** 线边库选择（01 §3.3）：末道用成品线边库、其余半成品线边库（目标库位由载荷显式给定，此处仅口径断言）。 */
export function lineSideLocationKind(input: { isLastNonQc: boolean }): 'finished' | 'semi_finished' {
  return input.isLastNonQc ? 'finished' : 'semi_finished'
}
