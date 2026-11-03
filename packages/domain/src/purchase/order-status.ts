import type { DecimalString } from '@cadenza/contracts'
// 包内子目录引用（purchase → inventory 数量算术）被过宽的包逃逸 eslint 规则误伤
// （同 trace/genealogy.ts 先例：两目录均属本 WorkItem 授权路径，不逃逸出 domain 包）。
// eslint-disable-next-line no-restricted-imports
import { addQty, cmpQty } from '../inventory/quantity'
import { PurchaseRuleViolation } from './errors'

/**
 * 采购订单行状态规则 [底稿 A-1]（IF-08：采购订单行入站，MES 零增删改）。
 *
 * - 状态 0–5：0 已开立 / 1 待收货 / 2 部分收货 / 3 完全收货 / 4 超额收货 / 5 已完成（PRD 采购订单 §1.2）；
 * - 已开立(0)与已完成(5)行冻结，不受 MES 收货/退货/重算影响（IF-08 状态语义）；确认收货前置拒绝冻结行；
 * - 未完结行（1–4）由 MES 按「计划数量 / 已收数量 / 采购上限」重算；
 * - 已收数量 = 有效批次汇总（退货批次剔除，A-1 尾句）。
 */

export type OrderLineStatusValue = 0 | 1 | 2 | 3 | 4 | 5

export const ORDER_LINE_STATUS_LABELS: Readonly<Record<OrderLineStatusValue, string>> = {
  0: '已开立',
  1: '待收货',
  2: '部分收货',
  3: '完全收货',
  4: '超额收货',
  5: '已完成',
}

/** 冻结态：已开立(0)/已完成(5)不受收退货与重算影响（IF-08）。 */
export function isOrderLineFrozen(status: number): boolean {
  return status === 0 || status === 5
}

/** 确认收货可执行前置 [A-1]：订单行未冻结（ERP 已完成/已开立不可收货，PRD 采购批次 §3.1 确认收货）。 */
export function assertOrderLineReceivable(status: number): void {
  if (isOrderLineFrozen(status)) {
    throw new PurchaseRuleViolation(
      'A-1',
      `订单行状态为 ${ORDER_LINE_STATUS_LABELS[status as OrderLineStatusValue] ?? status}（已冻结），不允许收货`,
    )
  }
}

/**
 * 未完结行状态重算 [A-1]：MES 按计划数量/已收数量/采购上限重算（PRD 采购订单 §2.1 逻辑）。
 * 已收=0 → 待收货；0<已收<计划 → 部分收货；已收=计划 → 完全收货；已收>计划（≤上限）→ 超额收货。
 * 冻结行（0/5）原样返回（不因收退货重算变更）。
 */
export function recalcOrderLineStatus(input: {
  status: number
  plannedQty: DecimalString
  receivedQty: DecimalString
}): number {
  if (isOrderLineFrozen(input.status)) return input.status
  if (cmpQty(input.receivedQty, '0') <= 0) return 1
  const vsPlanned = cmpQty(input.receivedQty, input.plannedQty)
  if (vsPlanned < 0) return 2
  if (vsPlanned === 0) return 3
  return 4
}

/**
 * 收货上限校验 [A-3]：订单行已收数量 + 本次入库数量 > 采购上限 → 整单拒绝
 * （PRD 采购批次 §3.1 确认收货校验「超过采购上限」）。
 */
export function assertWithinOverReceiptLimit(input: {
  receivedQty: DecimalString
  incomingQty: DecimalString
  overReceiptLimit: DecimalString
}): void {
  const total = addQty(input.receivedQty, input.incomingQty)
  if (cmpQty(total, input.overReceiptLimit) > 0) {
    throw new PurchaseRuleViolation(
      'A-3',
      `超过采购上限：已收 ${input.receivedQty} + 本次 ${input.incomingQty} > 上限 ${input.overReceiptLimit}，整单拒绝`,
    )
  }
}
