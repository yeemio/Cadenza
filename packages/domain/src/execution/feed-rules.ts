// 域内上级目录规则误伤豁免（同 trace/genealogy.ts 先例）：execution 与 inventory 同属
// domain 包内授权子目录，仅复用定点算术与比较原语。
import type { DecimalString } from '@cadenza/contracts'
// eslint-disable-next-line no-restricted-imports -- 包内跨子目录相对导入（见上）
import { cmpQty } from '../inventory/quantity'
import { ExecutionRuleViolation } from './errors'

/**
 * 领投料规则 —— [底稿 A7]。
 *
 * - A7-1 单独投料定位：不依附报工单，扫码后直接提交即扣减（05 §1.1）；投料工序栏单选、
 *   质检工序不可选、已有投料行不能换工序；服务端为准（05 §3.1 本机暂存不区分用户不过期 → DM §6 服务端权威）。
 * - A7-2 码准入链（05 §3.1 扫码投料）：只接受产品轴码（10 位载具码第 2 位 E/F/M），
 *   托码/原料码拒绝；链序=码存在于二维码档案→有销售单号+行号→已审批或质检完成→在库→
 *   所在仓库存→必须在线边库→成品/原料不可消耗→非本工序产出→本订单半成品必须是投料工序
 *   之前任一道（不限于紧邻前道）产出→可投数量>0。
 * - A7-3 跨订单（05 §3.1 + S11 裁定）：非本订单半成品弹确认后可投并标记；目标=核对物料
 *   规格、质量、客户限制和授权，形成谱系与成本归属，不把一次确认当充分授权（偏离记录）。
 * - A7-4 扣减与记录：提交事务内实时校验余量并扣减，记扣前/扣后余额；按销售行汇总本次
 *   投料≤剩余；任一销售行可投为 0 整码拒绝；记录投料类型（报工投料/单独投料）。
 */

/** [底稿 A7-2] 产品轴码准入：10 位载具码第 2 位 E/F/M；托码/原料码拒绝。 */
export const PRODUCT_AXIS_CODE_LENGTH = 10
export const PRODUCT_AXIS_SECOND_CHARS = ['E', 'F', 'M'] as const

export function isProductAxisCode(barcodeValue: string): boolean {
  return (
    barcodeValue.length === PRODUCT_AXIS_CODE_LENGTH &&
    PRODUCT_AXIS_SECOND_CHARS.includes(barcodeValue[1]! as (typeof PRODUCT_AXIS_SECOND_CHARS)[number])
  )
}

export function assertProductAxisCode(barcodeValue: string): void {
  if (!isProductAxisCode(barcodeValue)) {
    throw new ExecutionRuleViolation(
      'A7-2',
      `投料只接受产品轴码（10 位载具码第 2 位 E/F/M）：${barcodeValue} 不是产品轴码（托码/原料码拒绝）`,
    )
  }
}

/** [底稿 A7-2] 码准入链事实（每步由服务端查询填入；链序固定，第一步失败即拒绝）。 */
export interface FeedCodeAdmissionFacts {
  /** 扫码值；null=服务端 unitId 直投（无码值，产品轴码格式/档案步骤按已满足，绑定事实由服务端保证）。 */
  barcodeValue: string | null
  /** 码存在于二维码档案。 */
  barcodeArchived: boolean
  /** 有销售单号+行号（拆行归属）。 */
  salesOrderNo: string | null
  salesLineNo: string | null
  /** 已审批或质检完成（质量准入）。 */
  qualityAdmitted: boolean
  /** 单元在库。 */
  inStock: boolean
  /** 所在仓库存（有活动余额）。 */
  balanceExists: boolean
  /** 所在库位为线边库（必须在线边库）。 */
  atLineSideLocation: boolean
  /** 成品/原料不可消耗。 */
  consumableMaterial: boolean
  /** 非本工序产出（报本工序产出码不可再投本工序）。 */
  notCurrentOperationOutput: boolean
  /** 本订单半成品必须是投料工序之前任一道产出（true=满足：本订单前道产出或非本订单半成品）。 */
  acceptableOrigin: boolean
  /** 可投数量（活动余额余量）。 */
  availableQty: DecimalString
}

/**
 * [底稿 A7-2] 投料码准入链（链序固定，逐条校验，第一步失败即拒绝并给出链步说明）。
 */
export function assertFeedCodeAdmission(facts: FeedCodeAdmissionFacts): void {
  if (facts.barcodeValue !== null) {
    assertProductAxisCode(facts.barcodeValue)
    if (!facts.barcodeArchived) {
      throw new ExecutionRuleViolation('A7-2', `码 ${facts.barcodeValue} 不存在于二维码档案，拒绝投料`)
    }
  }
  if (facts.salesOrderNo === null || facts.salesOrderNo === '' || facts.salesLineNo === null || facts.salesLineNo === '') {
    throw new ExecutionRuleViolation('A7-2', `码 ${facts.barcodeValue} 无销售单号+行号归属，拒绝投料`)
  }
  if (!facts.qualityAdmitted) {
    throw new ExecutionRuleViolation('A7-2', `码 ${facts.barcodeValue} 未审批且质检未完成，拒绝投料`)
  }
  if (!facts.inStock) {
    throw new ExecutionRuleViolation('A7-2', `码 ${facts.barcodeValue} 对应库存单元不在库，拒绝投料`)
  }
  if (!facts.balanceExists) {
    throw new ExecutionRuleViolation('A7-2', `码 ${facts.barcodeValue} 所在仓库无库存余额，拒绝投料`)
  }
  if (!facts.atLineSideLocation) {
    throw new ExecutionRuleViolation('A7-2', `码 ${facts.barcodeValue} 所在库位必须在线边库，拒绝投料`)
  }
  if (!facts.consumableMaterial) {
    throw new ExecutionRuleViolation('A7-2', `码 ${facts.barcodeValue} 为成品/原料，不可消耗，拒绝投料`)
  }
  if (!facts.notCurrentOperationOutput) {
    throw new ExecutionRuleViolation('A7-2', `码 ${facts.barcodeValue} 是本工序产出，不可再投本工序，拒绝投料`)
  }
  if (!facts.acceptableOrigin) {
    throw new ExecutionRuleViolation(
      'A7-2',
      `码 ${facts.barcodeValue} 的本订单半成品必须是投料工序之前任一道产出（不限于紧邻前道），拒绝投料`,
    )
  }
  if (!(cmpQty(facts.availableQty, '0.0000') > 0)) {
    throw new ExecutionRuleViolation('A7-2', `码 ${facts.barcodeValue} 可投数量为 0，拒绝投料`)
  }
}

/**
 * [底稿 A7-3 + S11] 跨订单投料授权偏离记录：非本订单半成品弹确认后可投并标记，
 * 但一次确认不是充分授权——必须显式确认 + 偏离原因（形成谱系与成本归属的偏离记录字段）。
 */
export interface CrossOrderDeviationInput {
  isCrossOrder: boolean
  /** 显式确认（弹窗确认事实）。 */
  confirmed: boolean
  /** 偏离原因/授权说明（质量/规格/客户限制核对记录）。 */
  reason: string | null | undefined
}

export function assertCrossOrderFeedAuthorized(input: CrossOrderDeviationInput): { deviationReason: string | null } {
  if (!input.isCrossOrder) return { deviationReason: null }
  if (!input.confirmed) {
    throw new ExecutionRuleViolation(
      'A7-3',
      '跨订单投料（非本订单半成品）必须显式确认后方可投料并形成偏离记录',
    )
  }
  if (!(input.reason ?? '').trim()) {
    throw new ExecutionRuleViolation(
      'A7-3',
      '跨订单投料偏离记录必须填写原因（S11：核对物料规格/质量/客户限制与授权，不把一次确认当充分授权）',
    )
  }
  return { deviationReason: input.reason ?? null }
}

/**
 * [底稿 A7-4] 同一码按销售单号+行号拆多行；任一销售行可投为 0 → 整码拒绝；
 * 按销售行汇总本次投料 ≤ 剩余可投。
 */
export interface SalesLineFeedLine {
  salesOrderNo: string
  salesLineNo: string
  quantity: DecimalString
}

export function assertSalesLineFeedWithinRemainder(input: {
  lines: readonly SalesLineFeedLine[]
  /** 各销售行剩余可投（键=`${salesOrderNo}|${salesLineNo}`）。 */
  remainders: Readonly<Record<string, DecimalString>>
  barcodeValue: string
}): void {
  const totals = new Map<string, DecimalString>()
  for (const line of input.lines) {
    const key = `${line.salesOrderNo}|${line.salesLineNo}`
    const remain = input.remainders[key]
    if (remain === undefined) {
      throw new ExecutionRuleViolation(
        'A7-4',
        `码 ${input.barcodeValue} 的销售行 ${key} 无剩余可投记录，拒绝（任一销售行可投为 0 整码拒绝）`,
      )
    }
    if (cmpQty(remain, '0.0000') <= 0) {
      throw new ExecutionRuleViolation(
        'A7-4',
        `码 ${input.barcodeValue} 的销售行 ${key} 可投为 0，整码拒绝`,
      )
    }
    totals.set(key, (totals.get(key) ?? '0.0000') === '0.0000' ? line.quantity : addLine(totals.get(key)!, line.quantity))
  }
  for (const [key, total] of totals) {
    if (cmpQty(total, input.remainders[key]!) > 0) {
      throw new ExecutionRuleViolation(
        'A7-4',
        `码 ${input.barcodeValue} 销售行 ${key} 本次投料合计 ${total} 超过剩余可投 ${input.remainders[key]!}`,
      )
    }
  }
}

// Map 内合计辅助（避免引入上上级依赖，DecimalString 相加按定点语义）
function addLine(a: DecimalString, b: DecimalString): DecimalString {
  const S = 10n ** 4n
  const parse = (v: DecimalString): bigint => {
    const negative = v.startsWith('-')
    const body = negative ? v.slice(1) : v
    const [intPart, fracPart = ''] = body.split('.')
    const scaled = BigInt(intPart + (fracPart + '0'.repeat(4)).slice(0, 4))
    return negative ? -scaled : scaled
  }
  const total = parse(a) + parse(b)
  const negative = total < 0n
  const abs = negative ? -total : total
  return `${negative ? '-' : ''}${abs / S}.${(abs % S).toString().padStart(4, '0')}`
}

/**
 * [底稿 A7-1] 投料工序准入：单选、质检工序不可选、已有投料行不能换工序。
 */
export function assertFeedOperationSelectable(input: {
  isQc: boolean
  productionDeptId: string | null
  existingFeedOperationId: string | null
  requestedOperationId: string
}): void {
  if (input.isQc) {
    throw new ExecutionRuleViolation('A7-1', '投料工序不可选质检工序（K03：统一归属、部门、可开工、非质检四检）')
  }
  if (input.productionDeptId === null || input.productionDeptId === '') {
    throw new ExecutionRuleViolation('A7-1', '投料工序未设生产部门，不可选')
  }
  if (input.existingFeedOperationId !== null && input.existingFeedOperationId !== input.requestedOperationId) {
    throw new ExecutionRuleViolation('A7-1', '已有投料行不能换工序')
  }
}
