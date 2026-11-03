import { CostRuleViolation } from './errors'

/**
 * cost 域定点小数工具（CE 域内自持，不复用 inventory/quantity——跨子域深导入非既有风格；
 * 数量/能源量 scale=4、价格 scale=6，与 0020 迁移列精度一致；全程 BigInt 定点，无浮点）。
 */

const QTY_SCALE = 4
const PRICE_SCALE = 6
const QTY_FACTOR = 10n ** BigInt(QTY_SCALE)
const PRICE_FACTOR = 10n ** BigInt(PRICE_SCALE)
/** numeric(18,4) 上限（绝对值），出界即拒（防列精度溢出）。 */
const MAX_QTY_SCALED = 10n ** 18n - 1n

const DECIMAL_REGEX = /^-?\d+(\.\d{1,6})?$/

/** 校验十进制定点字符串（≤6 位小数输入面；数量/价格共用）。 */
export function isValidCostDecimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_REGEX.test(value)
}

/** 解析为定点 BigInt；digits=4（数量/能源量）或 6（价格）；非法输入（含 number/科学计数法）抛 CE 域违例。 */
export function parseScaled(value: unknown, rule: string, digits: 4 | 6 = 4): bigint {
  if (typeof value !== 'string' || !DECIMAL_REGEX.test(value)) {
    throw new CostRuleViolation(rule, `数值必须是十进制定点字符串（禁 number/科学计数法）：${String(value)}`)
  }
  const negative = value.startsWith('-')
  const body = negative ? value.slice(1) : value
  const [intPart, fracPart = ''] = body.split('.')
  const scale = digits === 6 ? PRICE_SCALE : QTY_SCALE
  const fracPadded = (fracPart + '0'.repeat(scale)).slice(0, scale)
  const scaled = BigInt(intPart + fracPadded)
  if (scaled > MAX_QTY_SCALED) {
    throw new CostRuleViolation(rule, `数值超出 numeric(18,4) 范围：${value}`)
  }
  return negative ? -scaled : scaled
}

/** 定点 BigInt → 字符串（scale=4，带符号）。 */
export function format4(scaled: bigint): string {
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const intPart = abs / QTY_FACTOR
  const fracPart = (abs % QTY_FACTOR).toString().padStart(QTY_SCALE, '0')
  return `${negative ? '-' : ''}${intPart}.${fracPart}`
}

/** 定点 BigInt → 字符串（scale=6）。 */
export function format6(scaled: bigint): string {
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const intPart = abs / PRICE_FACTOR
  const fracPart = (abs % PRICE_FACTOR).toString().padStart(PRICE_SCALE, '0')
  return `${negative ? '-' : ''}${intPart}.${fracPart}`
}

/** 数量级（scale=4）四则：add4/sub4/cmp4。 */
export function add4(a: string, b: string, rule = 'CE-03'): string {
  return format4(parseScaled(a, rule) + parseScaled(b, rule))
}

export function sub4(a: string, b: string, rule = 'CE-03'): string {
  return format4(parseScaled(a, rule) - parseScaled(b, rule))
}

export function cmp4(a: string, b: string, rule = 'CE-03'): -1 | 0 | 1 {
  const x = parseScaled(a, rule)
  const y = parseScaled(b, rule)
  return x < y ? -1 : x > y ? 1 : 0
}

export function isZero4(a: string, rule = 'CE-03'): boolean {
  return parseScaled(a, rule) === 0n
}

/** 数量（scale=4）× 数量/系数（scale=4）→ 数量（scale=4，四舍五入 half-up）。 */
export function mul4(a: string, b: string, rule = 'CE-03'): string {
  const scaled = parseScaled(a, rule) * parseScaled(b, rule)
  const half = QTY_FACTOR / 2n
  const rounded = scaled >= 0n ? (scaled + half) / QTY_FACTOR : -((-scaled + half) / QTY_FACTOR)
  return format4(rounded)
}

/** 数量（scale=4）÷ 数量（scale=4）→ 数量（scale=4，half-up；分母为零抛违例）。 */
export function div4(a: string, b: string, rule = 'CE-03'): string {
  const divisor = parseScaled(b, rule)
  if (divisor === 0n) throw new CostRuleViolation(rule, `除数为零：${a} / ${b}`)
  const scaled = (parseScaled(a, rule) * QTY_FACTOR * 2n + divisor) / (divisor * 2n)
  return format4(scaled)
}

/** 数量（scale=4）× 单价（scale=6）→ 金额（scale=4，half-up）。 */
export function amountOf(quantity: string, unitPrice: string, rule = 'CE-14'): string {
  const qty = parseScaled(quantity, rule)
  const price = parseScaled(unitPrice, rule, 6)
  const scaled = qty * price // scale=10
  // half-up 落到 4 位小数：除以 10^6（价格 scale），half=10^6/2
  const half = PRICE_FACTOR / 2n
  const rounded = scaled >= 0n ? (scaled + half) / PRICE_FACTOR : -((-scaled + half) / PRICE_FACTOR)
  return format4(rounded)
}
