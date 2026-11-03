import { ExecutionRuleViolation } from './errors'

/**
 * 报工修正/撤销守卫 —— [底稿 A6-6 + K15/K17/K18]。
 *
 * PRD 04 §2 原文：编辑只改工序/人员/产出数量、不改审核状态，有产出时工序不可改；
 * 人工审核通过后不可编辑；删除须报工单待审核且产出码未被改动/未入库；取消审核撤回
 * 入库/完成数量/排产完成/质检，产出已入库、被消耗、质检完成任一命中即拦截。
 *
 * 目标口径：
 * - K18：取消审核拦截=检查对象关系（任一产出存在下游使用即拦截）而非全入库标记；
 * - K17：生效事实走冲销不做数量改 0 隐式删除（已审核单不走删除，走取消审核）。
 */

export type ReportStatus = 'draft' | 'submitted' | 'deleted'
/** 审核轴三值；取消审核=回到 pending_review 并以留痕列承载（见 reviewCancelTransition）。 */
export type ReviewStatus = 'pending_review' | 'auto_approved' | 'manual_approved'

/** [底稿 A6-6] 编辑守卫：只改工序/人员/产出数量/备注，不改审核状态；有产出时工序不可改；人工审核通过后不可编辑。 */
export function assertReportEditable(input: {
  status: ReportStatus
  reviewStatus: ReviewStatus
  hasOutputs: boolean
  currentOperationId: string
  requestedOperationId: string | null
  /** 载荷是否携带审核轴字段（携带即拒绝：编辑不改审核状态）。 */
  attemptsReviewStateChange: boolean
}): void {
  if (input.status === 'deleted') {
    throw new ExecutionRuleViolation('A6-6', '已删除报工单不可编辑')
  }
  if (input.reviewStatus === 'manual_approved') {
    throw new ExecutionRuleViolation('A6-6', '人工审核通过后不可编辑（更正走冲销/新单）')
  }
  if (input.attemptsReviewStateChange) {
    throw new ExecutionRuleViolation('A6-6', '编辑只改工序/人员/产出数量/备注，不改审核状态')
  }
  if (
    input.requestedOperationId !== null &&
    input.requestedOperationId !== input.currentOperationId &&
    input.hasOutputs
  ) {
    throw new ExecutionRuleViolation('A6-6', '有产出时工序不可改')
  }
}

/**
 * [底稿 A6-6 + K17] 删除守卫：仅 待审（submitted + pending_review，且产出码未被改动/未入库）
 * 或草稿可删；已审核单（自动/人工通过）不走删除——生效事实走冲销（取消审核），不做隐式删除。
 */
export function assertReportDeletable(input: {
  status: ReportStatus
  reviewStatus: ReviewStatus
  outputsStocked: boolean
  outputsModified: boolean
}): void {
  if (input.status === 'deleted') {
    throw new ExecutionRuleViolation('A6-6', '报工单已删除，无须重复删除')
  }
  if (input.status === 'draft') return // 草稿可弃置（未发生记账）
  if (input.reviewStatus === 'auto_approved' || input.reviewStatus === 'manual_approved') {
    throw new ExecutionRuleViolation(
      'A6-6',
      '已审核通过的报工单不可删除（K17：生效事实走冲销——请走取消审核后处置）',
    )
  }
  if (input.outputsStocked) {
    throw new ExecutionRuleViolation('A6-6', '删除须产出未入库（产出码已转线边库的待审单不可删除）')
  }
  if (input.outputsModified) {
    throw new ExecutionRuleViolation('A6-6', '删除须产出码未被改动（产出载体码有改动痕迹的待审单不可删除）')
  }
}

/**
 * [底稿 A6-6 + K18] 取消审核守卫：撤回入库/完成数量/排产完成/质检；
 * 任一产出 已入库（移出线边库/上架）、被消耗、质检完成 命中即拦截——
 * 检查对象关系而非全入库标记（K18 目标口径；PRD 部分入库可过的行为按 K18 收紧）。
 */
export function assertReviewCancellable(input: {
  status: ReportStatus
  reviewStatus: ReviewStatus
  /** 撤审留痕存在（review_cancelled_at 非空）时视为已取消过，当前应为待审态。 */
  reviewCancelledAt?: string | null
  /** 任一产出已入库（移出线边库/上架）。 */
  anyOutputPutAway: boolean
  /** 任一产出已被消耗（下游谱系消费边/投料引用）。 */
  anyOutputConsumed: boolean
  /** 质检已完成（报工单质量结果已生效）。 */
  qcCompleted: boolean
}): void {
  if (input.status !== 'submitted') {
    throw new ExecutionRuleViolation('A6-6', `仅已提交报工单可取消审核（当前 ${input.status}）`)
  }
  if (input.reviewStatus === 'pending_review') {
    throw new ExecutionRuleViolation('A6-6', '报工单尚在待审核状态，无须取消审核（可直接删除/编辑）')
  }
  if (input.anyOutputPutAway) {
    throw new ExecutionRuleViolation('A6-6', '取消审核拦截：产出已入库（移出线边库/上架），不可直接取消原审核')
  }
  if (input.anyOutputConsumed) {
    throw new ExecutionRuleViolation('A6-6', '取消审核拦截：产出已被消耗，不可直接取消原审核（K18 对象关系检查）')
  }
  if (input.qcCompleted) {
    throw new ExecutionRuleViolation('A6-6', '取消审核拦截：质检已完成，不可直接取消原审核')
  }
}

/**
 * [底稿 A6-6 + DM §8] 撤销后回退形态：取消审核成功后报工单回到待审核（可重新审核/编辑/删除），
 * 库存逆回（反向流水）+ 完成数量回退 + 质检撤回由应用层在同一事务执行。
 */
export function reviewCancelTransition(input: { reviewStatus: ReviewStatus }): ReviewStatus {
  if (input.reviewStatus !== 'auto_approved' && input.reviewStatus !== 'manual_approved') {
    throw new ExecutionRuleViolation('A6-6', '仅已审核通过状态可取消审核')
  }
  return 'pending_review'
}

/** [底稿 A6-6] 更正引用：更正单必须引用同订单同工序的原单（生效事实走冲销/更正，不做隐式删除）。 */
export function assertCorrectionReference(input: {
  correctionOf: string | null | undefined
  original: { id: string; orderId: string; orderOperationId: string } | null
  newOrderId: string
  newOrderOperationId: string
}): void {
  if (input.correctionOf === null || input.correctionOf === undefined) return // 非更正单
  if (input.original === null) {
    throw new ExecutionRuleViolation('A6-6', `更正引用的原报工单不存在：${input.correctionOf}`)
  }
  if (input.original.orderId !== input.newOrderId || input.original.orderOperationId !== input.newOrderOperationId) {
    throw new ExecutionRuleViolation('A6-6', '更正单必须与原单同订单同工序（跨工序差异走新报工单）')
  }
}

/** [底稿 A6-6 + K01] 数量口径：编辑不重置事实、越界时间拒绝（时间合法性由调用方解析后传入）。 */
export function assertReportBusinessTimeEditable(input: {
  requestedBusinessTime: string | null
  currentActualStartAt: string | null
}): void {
  if (input.requestedBusinessTime === null) return // 未携带=不修改
  if (Number.isNaN(Date.parse(input.requestedBusinessTime))) {
    throw new ExecutionRuleViolation('A6-6', `报工实际时间必须为合法 ISO-8601 时间：${input.requestedBusinessTime}`)
  }
  // 编辑不重置事实：若原单已绑定开工事实，编辑时间不得早于订单实际开工时间（调用方传入已核对值时直接放行）
  if (input.currentActualStartAt !== null && input.requestedBusinessTime < input.currentActualStartAt) {
    throw new ExecutionRuleViolation(
      'A6-6',
      `报工实际时间不得早于订单实际开工时间（${input.currentActualStartAt}），越界时间拒绝（K01）`,
    )
  }
}

/** [底稿 A6-6 + K07] 空码不能提交：投料行携带码值时必须非空。 */
export function assertNoEmptyBarcodeForSubmit(input: { barcodeValues: readonly (string | null | undefined)[] }): void {
  for (const value of input.barcodeValues) {
    if (value !== null && value !== undefined && value !== '' && value.trim() === '') {
      throw new ExecutionRuleViolation('A6-6', '空码不能提交（K07）')
    }
  }
}
