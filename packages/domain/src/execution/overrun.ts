// 域内上级目录规则误伤豁免（同 trace/genealogy.ts 先例）：execution 与 inventory 同属
// domain 包内授权子目录，仅复用定点算术原语。
import type { DecimalString } from '@cadenza/contracts'
// eslint-disable-next-line no-restricted-imports -- 包内跨子目录相对导入（见上）
import { addQty, cmpQty } from '../inventory/quantity'
import { ExecutionRuleViolation } from './errors'

/**
 * 计划数量硬限与超产 —— [底稿 A5-1 / A5-2 + DM §4.2]。
 *
 * - A5-1 报工硬限：末道非质检工序全部报工（含未提交草稿）合计 ≤ 订单计划数 × 超额系数
 *   （01 §3.3 提交报工、03 §3.2）。含未提交是 PRD 明文（提交时重算且不看提交/审核状态），
 *   本函数按同口径把调用方传入的「已存在报工合计（含草稿）」与本次提交量合并校验。
 * - A5-2/DM §4.2：超产比例在服务端按同单位检查，不仅界面提示；件数/盘数与长度/重量
 *   不可互相覆盖（同单位断言由调用方对 uom 做前置，见 assertSameUomForAggregation）。
 *
 * [合同新造 + GAP C1] 超额系数：配置位置/默认值/来源 PRD 仅有报错文案与订单列；
 * 取值序=订单列 overrun_ratio > 注入配置默认 > '1.0000'（不允许超产，保守默认不编造现场值）。
 */

/** [合同新造 GAP C1] 超额系数保守默认：1.0000（即不允许超产）。 */
export const DEFAULT_OVERRUN_RATIO: DecimalString = '1.0000'

/** DecimalString × DecimalString（scale=4 定点，向下截断；两因子均须为合法定点串）。 */
export function mulQtyDecimal(a: DecimalString, b: DecimalString): DecimalString {
  // scaled(a) * scaled(b) / 10^4，BigInt 截断（保守：限制值向下取整不放大额度）
  const S = 10n ** 4n
  const parse = (v: DecimalString): bigint => {
    const negative = v.startsWith('-')
    const body = negative ? v.slice(1) : v
    const [intPart, fracPart = ''] = body.split('.')
    const padded = (fracPart + '0'.repeat(4)).slice(0, 4)
    const scaled = BigInt(intPart + padded)
    return negative ? -scaled : scaled
  }
  const product = parse(a) * parse(b)
  const truncated = product >= 0n ? product / S : -((-product) / S)
  const negative = truncated < 0n
  const abs = negative ? -truncated : truncated
  const frac = (abs % S).toString().padStart(4, '0')
  return `${negative ? '-' : ''}${abs / S}.${frac}`
}

/** 生效超额系数：订单列 > 配置默认 > 保守默认 1.0000（[合同新造 GAP C1]）。 */
export function effectiveOverrunRatio(orderRatio: DecimalString | null, configDefault: DecimalString | null): DecimalString {
  if (orderRatio !== null && orderRatio !== undefined && orderRatio !== '') return orderRatio
  if (configDefault !== null && configDefault !== undefined && configDefault !== '') return configDefault
  return DEFAULT_OVERRUN_RATIO
}

/**
 * [底稿 A5-1/A5-2] 报工硬限：末道非质检工序累计（已存在报工含未提交 + 本次提交量）
 * ≤ 订单计划数 × 超额系数。仅对末道非质检工序调用（非末道不校验，01 §3.3）。
 * 服务端同单位：plannedQty/existingTotal/incomingQty 必须同单位（调用方保证并断言）。
 */
export function assertReportOverrunLimit(input: {
  plannedQty: DecimalString
  overrunRatio: DecimalString | null
  /** 已存在报工合计（含未提交草稿、待审与已审核；已删除/已撤审作废由调用方过滤）。 */
  existingReportedTotal: DecimalString
  incomingQty: DecimalString
  uom: string
  existingUom?: string
  plannedUom?: string
}): void {
  if (input.existingUom !== undefined && input.existingUom !== input.uom) {
    throw new ExecutionRuleViolation('A5-2', `超产校验须同单位（既有 ${input.existingUom}、本次 ${input.uom}），拒绝`)
  }
  if (input.plannedUom !== undefined && input.plannedUom !== input.uom) {
    throw new ExecutionRuleViolation('A5-2', `超产校验须同单位（计划 ${input.plannedUom}、本次 ${input.uom}），拒绝`)
  }
  const ratio = effectiveOverrunRatio(input.overrunRatio, null)
  const limit = ratio === '1.0000' ? input.plannedQty : mulQtyDecimal(input.plannedQty, ratio)
  const nextTotal = addQty(input.existingReportedTotal, input.incomingQty)
  if (cmpQty(nextTotal, limit) > 0) {
    throw new ExecutionRuleViolation(
      'A5-1',
      `超产硬限：末道非质检工序累计报工（含未提交）${nextTotal} ${input.uom} 超过 计划 ${input.plannedQty} × 超额系数 ${ratio} = ${limit}（服务端同单位拒绝）`,
    )
  }
}

/** [底稿 A5-1] 限额计算（展示/测试口径）：计划数 × 生效超额系数。 */
export function plannedOverrunLimit(input: {
  plannedQty: DecimalString
  overrunRatio: DecimalString | null
}): DecimalString {
  const ratio = effectiveOverrunRatio(input.overrunRatio, null)
  return ratio === '1.0000' ? input.plannedQty : mulQtyDecimal(input.plannedQty, ratio)
}
