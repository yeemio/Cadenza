import type { DecimalString } from '@cadenza/contracts'
import { InventoryRuleViolation } from './errors'
import { addQty, assertSameUomForAggregation, cmpQty, isZeroQty } from './quantity'
import { sumQty } from './posting'

/**
 * 守恒、不可逆与冲销纯规则 —— 对应冻结合同 inventory-trace-core.md §7：IT-28～IT-32、IT-30 样例。
 */

/**
 * IT-28：分盘/倒轴守恒式 `原量 = 子段量合计 + 留存量 + 已记录损耗量`。
 * 任一分录不满足即拒绝提交（同单位口径，IT-11）。
 */
export function assertSplitConservation(input: {
  originalQty: DecimalString
  childQtyList: readonly DecimalString[]
  retainedQty: DecimalString
  lossQty: DecimalString
  uomId: string
}): void {
  assertSameUomForAggregation([{ uomId: input.uomId }])
  const childTotal = sumQty(input.childQtyList)
  const reconstructed = addQty(addQty(childTotal, input.retainedQty), input.lossQty)
  if (cmpQty(reconstructed, input.originalQty) !== 0) {
    throw new InventoryRuleViolation(
      'IT-28',
      `分盘守恒不满足：原量 ${input.originalQty} ≠ 子段合计 ${childTotal} + 留存 ${input.retainedQty} + 损耗 ${input.lossQty}（重构值 ${reconstructed}）`,
    )
  }
}

/**
 * IT-29：数量为零的库存单元——关闭活动余额，身份与谱系节点保留，不删除档案。
 * （原文"扣完移除/扣到 0 删码档案"与目标口径冲突登记 CA-1 待裁；内核侧冻结零余额关闭语义。）
 */
export function zeroBalanceDisposition(afterQty: DecimalString): { closeBalance: boolean; deleteArchive: false } {
  return { closeBalance: isZeroQty(afterQty), deleteArchive: false }
}

/**
 * IT-30-②：分盘与修正样例——600 m 子轴已发运时，回撤原倒轴必须受阻。
 * 冲销/回撤前置：任一子段/子单元已发运（或已入库/被消耗/已转换/形成生效质量结果，IT-31）即拒绝。
 */
export function assertNoShippedChildrenForSplitReversal(input: {
  childStatuses: readonly { unitNo: string; status: string }[]
}): void {
  const blocked = input.childStatuses.filter((c) => c.status === 'shipped')
  if (blocked.length > 0) {
    throw new InventoryRuleViolation(
      'IT-30',
      `回撤倒轴受阻：子轴 ${blocked.map((c) => c.unitNo).join(',')} 已发运；纠正须走逆序冲销或质量处置（IT-31）`,
    )
  }
}

/**
 * IT-31：不可逆事实——任一产出已入库/被消耗/被转换/已发运/已形成生效质量结果的，
 * 不可直接取消原审核；纠正走逆序冲销或质量处置；盘点/截取/成品异常扣数必须记录原因与去向。
 */
export function assertNotCancellable(input: {
  subject: string
  facts: Readonly<Record<'received' | 'consumed' | 'converted' | 'shipped' | 'qualifiedResult', boolean>>
}): void {
  const hits = Object.entries(input.facts)
    .filter(([, v]) => v)
    .map(([k]) => k)
  if (hits.length > 0) {
    throw new InventoryRuleViolation(
      'IT-31',
      `${input.subject} 已形成不可逆事实（${hits.join('/')}），不可直接取消原审核；纠正走逆序冲销或质量处置`,
    )
  }
}

/** 盘点/截取/成品异常扣数的原因与去向必填（IT-31 后半）。 */
export function assertAdjustmentReasonRecorded(input: {
  kind: 'stocktake' | 'cut_off' | 'finished_defect'
  reason: string | null | undefined
  dispositionTo: string | null | undefined
}): void {
  if (!(input.reason ?? '').trim()) {
    throw new InventoryRuleViolation('IT-31', `${input.kind} 扣数必须记录原因`)
  }
  if (!(input.dispositionTo ?? '').trim()) {
    throw new InventoryRuleViolation('IT-31', `${input.kind} 扣数必须记录去向`)
  }
}

/**
 * IT-32：冲销命令语义——校验下游引用与对象版本 → 写反向流水 → 新建纠正事实 → 更新影响结果 → 审计；
 * 对外冲销事件异步（Outbox），不阻塞本地冲销入账。本纯规则负责第一步前置断言。
 */
export function assertReversalPreconditions(input: {
  subject: string
  downstreamReferenceCount: number
  expectedRevision: number
  actualRevision: number
}): void {
  if (input.downstreamReferenceCount > 0) {
    throw new InventoryRuleViolation(
      'IT-32',
      `${input.subject} 存在 ${input.downstreamReferenceCount} 条下游引用，冲销前须先处置下游`,
    )
  }
  if (input.expectedRevision !== input.actualRevision) {
    throw new InventoryRuleViolation(
      'IT-32',
      `${input.subject} 对象版本冲突（期望 ${input.expectedRevision}、实际 ${input.actualRevision}），须刷新后重试`,
    )
  }
}
