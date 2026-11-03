import { DECIMAL_STRING_REGEX, type DecimalString } from '@cadenza/contracts'
import { ReportingRuleViolation } from './errors'

/**
 * 十进制定点算术（展示/汇总层专用，RP-03/RP-05/RP-12：截取 4 位、分组累加保留 4 位——
 * 不做浮点运算，账面算术仍属 persistence 的 numeric 列与 SQL）。
 *
 * 全部以 bigint ×10^4 定点整数承载；输入必须是 DECIMAL_STRING_REGEX 合法的十进制字符串。
 */

const SCALE = 4n
const SCALE_FACTOR = 10_000n

/** 十进制字符串 → 定点整数（×10^4）。非法输入抛 [RP-05]。 */
export function toScaledInt(value: DecimalString | string, rule = 'RP-05'): bigint {
  if (!DECIMAL_STRING_REGEX.test(value)) {
    throw new ReportingRuleViolation(rule, `数量不是合法的十进制字符串（≤4 位小数）：${value}`)
  }
  const negative = value.startsWith('-')
  const [intPart, fracPart = ''] = (negative ? value.slice(1) : value).split('.')
  const frac = (fracPart + '0000').slice(0, Number(SCALE))
  const scaled = BigInt(`${intPart}${frac}`)
  return negative ? -scaled : scaled
}

/** 定点整数（×10^4）→ 4 位小数十进制字符串。 */
export function fromScaledInt(scaled: bigint): DecimalString {
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const intPart = abs / SCALE_FACTOR
  const fracPart = (abs % SCALE_FACTOR).toString().padStart(Number(SCALE), '0')
  return `${negative ? '-' : ''}${intPart}.${fracPart}`
}

/** 定点加法（分组累加，RP-05/RP-12）。 */
export function addScaled(a: bigint, b: bigint): bigint {
  return a + b
}

/** 定点截取除法：floor/trunc(a / b, 4 位)——正数向下截取（RP-03 不四舍五入）。 */
export function truncDiv4(a: bigint, b: bigint): bigint {
  if (b === 0n) {
    throw new ReportingRuleViolation('RP-03', '除数为零（截取除法不可用）')
  }
  const negative = a < 0n !== b < 0n
  const absA = a < 0n ? -a : a
  const absB = b < 0n ? -b : b
  const quotient = (absA * SCALE_FACTOR) / absB
  return negative ? -quotient : quotient
}

/** 定点乘百分比（×100，定点 scale 不变；结果仍为 4 位定点，指标百分比口径）。 */
export function truncPercent4(ratioScaled: bigint): bigint {
  return ratioScaled * 100n
}
