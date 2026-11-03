import { DECIMAL_STRING_REGEX, type DecimalString } from '@cadenza/contracts'
import { SpcRuleViolation } from './errors'

/**
 * spc 域定点算术（自包含实现；同 process/quantity.ts 先例——根 eslint 边界限定本目录
 * 只允许 './' 与 '@cadenza/contracts'，不得引用其它子域的数量工具）。
 *
 * 口径沿用全仓约定：接口一律十进制定点字符串（DecimalString，≤4 位小数），
 * 定点算术用 BigInt 不做浮点。控制限（CL/UCL/LCL）为计算产物，保留 6 位小数
 * （numeric(18,6) 列承载），其字符串格式由本文件的 6 位格式化函数产出。
 */

/** 数量账面小数位（与全仓 scale=4 一致）。 */
export const SPC_QTY_SCALE = 4
/** 控制限小数位（计算产物精度）。 */
export const SPC_LIMIT_SCALE = 6

const QTY_FACTOR = 10n ** BigInt(SPC_QTY_SCALE)

/** 解析为 scale=4 定点 BigInt；非法输入抛 PE-01 违例（数量口径沿用 IT-07 精神）。 */
export function toSpcScaled(value: string, field: string): bigint {
  if (typeof value !== 'string' || !DECIMAL_STRING_REGEX.test(value)) {
    throw new SpcRuleViolation(
      'PE-01',
      `${field} 必须是十进制定点字符串（≤4 位小数，禁 number/科学计数法）：${String(value)}`,
    )
  }
  const negative = value.startsWith('-')
  const body = negative ? value.slice(1) : value
  const [intPart, fracPart = ''] = body.split('.')
  const fracPadded = (fracPart + '0'.repeat(SPC_QTY_SCALE)).slice(0, SPC_QTY_SCALE)
  return negative ? -BigInt(intPart + fracPadded) : BigInt(intPart + fracPadded)
}

/** 定点 BigInt → 4 位小数字符串。 */
export function formatSpcScaled(scaled: bigint): DecimalString {
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const intPart = abs / QTY_FACTOR
  const fracPart = (abs % QTY_FACTOR).toString().padStart(SPC_QTY_SCALE, '0')
  return `${negative ? '-' : ''}${intPart}.${fracPart}`
}

/** 数值比较（4 位定点口径）：a<b → -1，a=b → 0，a>b → 1。 */
export function cmpSpcQty(a: string, b: string): number {
  const sa = toSpcScaled(a, '左值')
  const sb = toSpcScaled(b, '右值')
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/** 两数相加（scale=4，精确）。 */
export function addSpcQty(a: string, b: string): DecimalString {
  return formatSpcScaled(toSpcScaled(a, '左值') + toSpcScaled(b, '右值'))
}

/**
 * 比例换算：round4(a × b / c)（c>0）。用于 PE-03 计划量重算——
 * 新计划量 = 旧计划量 × 新系数 / 旧系数（芯倍数 × 绞合系数的合成因子比）。
 */
export function mulDivSpcQty(a: string, b: string, c: string, field: string): DecimalString {
  const sa = toSpcScaled(a, field)
  const sb = toSpcScaled(b, field)
  const sc = toSpcScaled(c, field)
  if (sa < 0n || sb < 0n) throw new SpcRuleViolation('PE-03', `${field} 参与换算的数量不得为负`)
  if (sc <= 0n) {
    throw new SpcRuleViolation('PE-03', `${field} 换算除数必须大于 0（旧系数为零无法重算）`)
  }
  // numerator scale=8；除以 scale-4 的 c 再收回 scale=4（半入；本域换算值非负）
  const numerator = sa * sb
  return formatSpcScaled((numerator + sc / 2n) / sc)
}

/** 数值 → 6 位小数字符串（控制限计算产物格式）。 */
export function formatLimitValue(value: number): string {
  if (!Number.isFinite(value)) {
    throw new SpcRuleViolation('PE-10', '控制限计算结果不是有限数值')
  }
  return value.toFixed(SPC_LIMIT_SCALE)
}

/** 6 位小数字符串 → 数值（判定比较用；格式已在落库前校验）。 */
export function parseLimitValue(value: string, field: string): number {
  const n = Number(value)
  if (value === '' || !Number.isFinite(n)) {
    throw new SpcRuleViolation('PE-10', `${field} 必须为十进制字符串：${String(value)}`)
  }
  return n
}
