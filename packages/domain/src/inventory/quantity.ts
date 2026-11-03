import { DECIMAL_STRING_REGEX, type DecimalString } from '@cadenza/contracts'
import { InventoryRuleViolation } from './errors'

/**
 * 数量口径纯规则 —— 对应冻结合同 inventory-trace-core.md §3：IT-07～IT-12。
 *
 * - IT-07：十进制定点；接口传输十进制字符串；业务保留 4 位小数；显示舍入不改账；
 * - IT-08：数量四元组同存（quantity + uom + measurement_basis + conversion_revision）；
 * - IT-09：同量纲精确换算允许；米↔千克按物料规格换算，禁止全局固定换算；
 * - IT-10：英尺数列 = 基本数量 ÷ 0.3048 截断 4 位，仅展示列、不入账、必须标注 basis；
 * - IT-11：件数/盘数/托数离散计数，不与长度/重量互相覆盖；不同单位不得直接汇总；
 * - IT-12：超产/超额校验在服务端按同单位执行。
 *
 * 实现说明：定点算术用 BigInt、scale=4（账面口径）；不做浮点。
 */

/** 账面固定小数位（IT-07：业务保留 4 位小数）。 */
export const QTY_SCALE = 4
const SCALE_FACTOR = 10n ** BigInt(QTY_SCALE)
/** numeric(18,4) 上限（绝对值），出界即拒绝（防御列精度溢出）。 */
const MAX_SCALED = 10n ** 18n - 1n

/** 校验十进制数量字符串（IT-07 格式：可选负号、整数位、1–4 位小数）。 */
export function isValidQuantityString(value: unknown): value is DecimalString {
  return typeof value === 'string' && DECIMAL_STRING_REGEX.test(value)
}

/** 解析为 scale=4 的定点 BigInt；非法输入抛 IT-07 违例。 */
export function toScaled(value: DecimalString | string, rule = 'IT-07'): bigint {
  if (typeof value !== 'string' || !DECIMAL_STRING_REGEX.test(value)) {
    throw new InventoryRuleViolation(
      rule,
      `数量必须是十进制定点字符串（≤4 位小数，禁 number/科学计数法）：${String(value)}`,
    )
  }
  const negative = value.startsWith('-')
  const body = negative ? value.slice(1) : value
  const [intPart, fracPart = ''] = body.split('.')
  const fracPadded = (fracPart + '0'.repeat(QTY_SCALE)).slice(0, QTY_SCALE)
  const scaled = BigInt(intPart + fracPadded)
  if (scaled > MAX_SCALED) {
    throw new InventoryRuleViolation(rule, `数量超出 numeric(18,4) 范围：${value}`)
  }
  return negative ? -scaled : scaled
}

/** 定点 BigInt → 十进制字符串（scale=4，带符号）。 */
export function formatScaled(scaled: bigint): DecimalString {
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const intPart = abs / SCALE_FACTOR
  const fracPart = (abs % SCALE_FACTOR).toString().padStart(QTY_SCALE, '0')
  return `${negative ? '-' : ''}${intPart}.${fracPart}`
}

/** 加（IT-07 定点精确）。 */
export function addQty(a: DecimalString, b: DecimalString): DecimalString {
  return formatScaled(toScaled(a) + toScaled(b))
}

/** 减（IT-07 定点精确）。 */
export function subQty(a: DecimalString, b: DecimalString): DecimalString {
  return formatScaled(toScaled(a) - toScaled(b))
}

/** 比较：a<b 返回 -1，相等 0，a>b 返回 1。 */
export function cmpQty(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  const x = toScaled(a)
  const y = toScaled(b)
  return x < y ? -1 : x > y ? 1 : 0
}

export function isZeroQty(a: DecimalString): boolean {
  return toScaled(a) === 0n
}

export function isPositiveQty(a: DecimalString): boolean {
  return toScaled(a) > 0n
}

/** 数量 × 非负整数（同量纲倍数，不引入换算）。 */
export function mulQtyByUint(a: DecimalString, factor: number): DecimalString {
  if (!Number.isInteger(factor) || factor < 0) {
    throw new InventoryRuleViolation('IT-07', `倍数必须为非负整数：${String(factor)}`)
  }
  return formatScaled(toScaled(a) * BigInt(factor))
}

/**
 * IT-10：英尺数列 = 基本数量（米）÷ 0.3048，**截断** 4 位。
 * 属同量纲精确换算豁免 IT-09 禁令；仅作展示列、不入账，且必须标注 measurement_basis。
 */
export const FEET_PER_METER_BASIS = 'feet-per-0.3048-exact-display'

export function feetDisplayFromMeters(meters: DecimalString): DecimalString {
  const scaled = toScaled(meters)
  // 结果同为 scale=4 定点：feet_scaled = meters_scaled × 10^4 / 3048（0.3048 → 3048 个基点），截断
  const truncated = scaled >= 0n ? (scaled * SCALE_FACTOR) / 3048n : -((-scaled * SCALE_FACTOR) / 3048n)
  return formatScaled(truncated)
}

/**
 * IT-09：同量纲精确换算表（米/千米、千克/吨）。跨量纲（米↔千克）不在表内，
 * 必须按物料规格/理论米重/实际测量在物料维度换算，禁止全局固定换算。
 */
export const KNOWN_EXACT_CONVERSIONS: Readonly<Record<string, DecimalString>> = {
  'm->km': '0.0010',
  'km->m': '1000.0000',
  'kg->t': '0.0010',
  't->kg': '1000.0000',
  'm->ft-display': '0.3048', // 仅 IT-10 展示列（除数），不入账
}

/** 同量纲精确换算因子；无已知精确因子返回 null（须走物料维度换算，IT-09）。 */
export function exactConversionFactor(fromUomCode: string, toUomCode: string): DecimalString | null {
  return KNOWN_EXACT_CONVERSIONS[`${fromUomCode}->${toUomCode}`] ?? null
}

/** IT-08：数量四元组完整性（quantity + uom + measurement_basis + conversion_revision）。 */
export interface QuantityTuple {
  quantity: DecimalString
  uomId: string
  measurementBasis: string
  conversionRevisionId?: string | null
}

/** IT-08：落库/入账前校验数量四元组齐全且数量格式合法。 */
export function assertQuantityTuple(tuple: QuantityTuple): void {
  if (!isValidQuantityString(tuple.quantity)) {
    throw new InventoryRuleViolation('IT-08', `数量四元组的数量非法：${tuple.quantity}`)
  }
  if (!tuple.uomId) {
    throw new InventoryRuleViolation('IT-08', '数量四元组缺少 uom_id')
  }
  if (!tuple.measurementBasis) {
    throw new InventoryRuleViolation('IT-08', '数量四元组缺少 measurement_basis')
  }
}

/** IT-11：不同单位不得直接汇总（加减/守恒校验前调用）。 */
export function assertSameUomForAggregation(items: readonly { uomId: string }[]): void {
  if (items.length === 0) return
  const first = items[0]!.uomId
  for (const item of items) {
    if (item.uomId !== first) {
      throw new InventoryRuleViolation(
        'IT-11',
        `不同单位不得直接汇总/守恒比较（${first} vs ${item.uomId}）；件数/盘数/托数为离散计数`,
      )
    }
  }
}

/**
 * IT-12：超产/超额比例校验（服务端、按同单位执行）。
 * receivedTotal（含本次）不得超过 ordered × (1 + limitPercent/100)。
 */
export function assertWithinOverrunLimit(input: {
  orderedQty: DecimalString
  receivedTotalQty: DecimalString
  limitPercent: DecimalString
  uomId: string
}): void {
  assertSameUomForAggregation([
    { uomId: input.uomId },
    { uomId: input.uomId },
  ])
  const ordered = toScaled(input.orderedQty)
  const received = toScaled(input.receivedTotalQty)
  const limitPercent = toScaled(input.limitPercent) // limitPercent 本身 scale=4（'5' → 50000）
  // 上限 = ordered × (1 + limit%/100)：ceiling_scaled = ordered × (10^6 + limitScaled) / 10^6
  // （定点：limit% = limitScaled / 10^4，百分比再除 100 → 分母 10^6；向上取整防误拒）
  const denominator = 1_000_000n
  const numerator = ordered * (denominator + limitPercent)
  const ceiling = (numerator + denominator - 1n) / denominator
  if (received > ceiling) {
    throw new InventoryRuleViolation(
      'IT-12',
      `超产/超额上限校验失败（同单位 ${input.uomId}）：累计 ${input.receivedTotalQty} 超过上限 ${formatScaled(ceiling)}`,
    )
  }
}
