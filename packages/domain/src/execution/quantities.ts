// 域内上级目录规则误伤豁免（同 trace/genealogy.ts 先例）：execution 与 inventory 同属
// domain 包内授权子目录，仅复用定点算术原语。
import type { DecimalString } from '@cadenza/contracts'
// eslint-disable-next-line no-restricted-imports -- 包内跨子目录相对导入（见上）
import { addQty, assertSameUomForAggregation } from '../inventory/quantity'
// eslint-disable-next-line no-restricted-imports -- 包内跨子目录相对导入（见上）
import { sumQty } from '../inventory/posting'
import { ExecutionRuleViolation } from './errors'

/**
 * 五量分立计数 —— [底稿 A5-3 + S02 裁定/DM §5]。
 *
 * PRD 隐患口径：01/04「工序完成数量」在提交时重算且不看提交/审核状态（把未提交产出也计入）；
 * 扫设备码「累计生产」同样混口径。目标口径（S02 裁定）＝草稿数/提交数/审核数/合格数/入库数
 * 分别展示，不做混口径：本模块是唯一计数口径，查询端点直接消费，禁止任何单一「完成数量」
 * 覆盖五量。
 */

export type ReportQuantityKind = 'draft' | 'submitted' | 'approved' | 'qualified' | 'stocked'

export interface QuantityReportInput {
  /** submitted 且审核轴待审（含撤审回待审）→ submitted 口径；draft → draft 口径。 */
  status: 'draft' | 'submitted' | 'deleted'
  reviewStatus: 'pending_review' | 'auto_approved' | 'manual_approved' | 'cancelled'
  outputs: ReadonlyArray<{ quantity: DecimalString; qualifiedQty: DecimalString; stockUnitId: string | null }>
  uomId: string
}

export interface FiveQuantities {
  draft: DecimalString
  submitted: DecimalString
  approved: DecimalString
  qualified: DecimalString
  stocked: DecimalString
}

/**
 * [底稿 A5-3] 五量分立：按报工单事实分别累计，互不覆盖。
 * - draft：status=draft 的产出合计；
 * - submitted：status=submitted 且 review_status=pending_review（待审）的产出合计；
 * - approved：审核通过（auto/manual，未撤审）的产出合计；
 * - qualified：审核通过单的合格数量合计；
 * - stocked：审核通过且产出已转线边库（stockUnitId 非空）的产出合计。
 */
export function computeFiveQuantities(reports: readonly QuantityReportInput[]): FiveQuantities {
  if (reports.length > 0) {
    assertSameUomForAggregation(reports.map((r) => ({ uomId: r.uomId }))) // 同单位才可汇总
  }
  const sum = (list: readonly DecimalString[]): DecimalString => (list.length === 0 ? '0.0000' : sumQty(list))
  const pick = (r: QuantityReportInput): DecimalString =>
    r.outputs.length === 0 ? '0.0000' : sumQty(r.outputs.map((o) => o.quantity))
  const qualified = (r: QuantityReportInput): DecimalString =>
    r.outputs.length === 0 ? '0.0000' : sumQty(r.outputs.map((o) => o.qualifiedQty))

  const draft: DecimalString[] = []
  const submitted: DecimalString[] = []
  const approved: DecimalString[] = []
  const qualifiedList: DecimalString[] = []
  const stocked: DecimalString[] = []
  for (const r of reports) {
    if (r.status === 'deleted') continue
    if (r.status === 'draft') {
      draft.push(pick(r))
      continue
    }
    const approvedNow = r.reviewStatus === 'auto_approved' || r.reviewStatus === 'manual_approved'
    if (approvedNow) {
      approved.push(pick(r))
      qualifiedList.push(qualified(r))
      if (r.outputs.some((o) => o.stockUnitId !== null)) {
        stocked.push(sumQty(r.outputs.filter((o) => o.stockUnitId !== null).map((o) => o.quantity)))
      }
    } else {
      submitted.push(pick(r)) // 待审（含撤审回待审）计入 submitted 口径
    }
  }
  return {
    draft: sum(draft),
    submitted: sum(submitted),
    approved: sum(approved),
    qualified: sum(qualifiedList),
    stocked: sum(stocked),
  }
}

/** [底稿 A5-3] 展示口径守卫：禁止以任一单一数量冒充「完成数量」混口径展示。 */
export function assertNoMixedQuantityPresentation(input: {
  presentedAs: string
  actualKind: ReportQuantityKind
}): void {
  if (input.presentedAs !== input.actualKind) {
    throw new ExecutionRuleViolation(
      'A5-3',
      `五量分立（草稿/提交/审核/合格/入库）分别展示：不得把 ${input.actualKind} 口径冒充 ${input.presentedAs}`,
    )
  }
}

/** 五量聚合辅助：跨单相加（同单位）。 */
export function addFive(a: FiveQuantities, b: FiveQuantities): FiveQuantities {
  return {
    draft: addQty(a.draft, b.draft),
    submitted: addQty(a.submitted, b.submitted),
    approved: addQty(a.approved, b.approved),
    qualified: addQty(a.qualified, b.qualified),
    stocked: addQty(a.stocked, b.stocked),
  }
}
