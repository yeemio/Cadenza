import { DECIMAL_STRING_REGEX, type DecimalString } from '@cadenza/contracts'
import { ProcessRuleViolation } from './errors'

/**
 * process 域数量口径纯规则（自包含实现；包内不得以 '../..' 逃逸引用 inventory 的数量工具，
 * 根 eslint 边界规则限定本目录只允许 './' 与 '@cadenza/contracts'）。
 *
 * 口径沿用全仓约定（SYSTEM_ARCHITECTURE §4.2 / 底稿 A2）：
 * - 接口一律十进制定点字符串（DecimalString），禁 number；
 * - 业务保留 4 位小数；定点算术用 BigInt，不做浮点；
 * - 芯倍数为正整数；绞合系数选填（未填该行跳过重算）；下线数量必填最多 4 位小数；
 * - 损耗/余量不得并入绞合系数（公式输入只有 订单产量 × 芯倍数 × 绞合，结构上无处可塞）。
 */

/** 账面固定小数位。 */
export const PROCESS_QTY_SCALE = 4
const SCALE_FACTOR = 10n ** BigInt(PROCESS_QTY_SCALE)
/** numeric(16,4) 上限（绝对值），出界即拒绝。 */
const MAX_SCALED = 10n ** 16n - 1n

/** 解析为 scale=4 定点 BigInt；非法输入抛 A2-1 违例。 */
export function toProcessScaled(value: DecimalString | string, field: string): bigint {
  if (typeof value !== 'string' || !DECIMAL_STRING_REGEX.test(value)) {
    throw new ProcessRuleViolation(
      'A2-1',
      `${field} 必须是十进制定点字符串（≤4 位小数，禁 number/科学计数法）：${String(value)}`,
    )
  }
  const negative = value.startsWith('-')
  const body = negative ? value.slice(1) : value
  const [intPart, fracPart = ''] = body.split('.')
  const fracPadded = (fracPart + '0'.repeat(PROCESS_QTY_SCALE)).slice(0, PROCESS_QTY_SCALE)
  const scaled = BigInt(intPart + fracPadded)
  if (scaled > MAX_SCALED) {
    throw new ProcessRuleViolation('A2-1', `${field} 超出 numeric(16,4) 范围：${value}`)
  }
  return negative ? -scaled : scaled
}

/** 定点 BigInt → 十进制字符串（scale=4）。 */
export function formatProcessScaled(scaled: bigint): DecimalString {
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const intPart = abs / SCALE_FACTOR
  const fracPart = (abs % SCALE_FACTOR).toString().padStart(PROCESS_QTY_SCALE, '0')
  return `${negative ? '-' : ''}${intPart}.${fracPart}`
}

/** 两数相乘后四舍五入到 4 位小数（半入；本域数量非负，等价于 (x+5000)/10000 向下取整）。 */
export function mulProcessQty(a: DecimalString, b: DecimalString, field: string): DecimalString {
  const sa = toProcessScaled(a, field)
  const sb = toProcessScaled(b, field)
  if (sa < 0n || sb < 0n) {
    throw new ProcessRuleViolation('A2-1', `${field} 参与乘法的数量不得为负`)
  }
  const product = sa * sb // scale=8
  const rounded = (product + 5n * 10n ** BigInt(PROCESS_QTY_SCALE - 1)) / SCALE_FACTOR
  return formatProcessScaled(rounded)
}

/** 数量 × 正整数倍数（同量纲，精确，无舍入）。 */
export function mulProcessQtyByInt(a: DecimalString, factor: number, field: string): DecimalString {
  if (!Number.isInteger(factor) || factor < 0) {
    throw new ProcessRuleViolation('A2-1', `${field} 的倍数必须为非负整数：${String(factor)}`)
  }
  return formatProcessScaled(toProcessScaled(a, field) * BigInt(factor))
}

/** [底稿 A2-1] 芯倍数：正整数必填（≥1）。 */
export function assertCoreMultiple(coreMultiple: number, field: string): void {
  if (!Number.isInteger(coreMultiple) || coreMultiple < 1) {
    throw new ProcessRuleViolation('A2-1', `${field} 芯倍数必须为正整数（≥1）：${String(coreMultiple)}`)
  }
}

/** [底稿 A2-1] 绞合系数：选填；填则须为正的十进制定点字符串（≤4 位小数）。损耗不得并入（无参数位）。 */
export function assertStrandFactor(strandFactor: string | null | undefined, field: string): void {
  if (strandFactor === null || strandFactor === undefined || strandFactor === '') return
  if (!DECIMAL_STRING_REGEX.test(strandFactor)) {
    throw new ProcessRuleViolation(
      'A2-1',
      `${field} 绞合系数必须为十进制定点字符串（≤4 位小数）或留空：${String(strandFactor)}`,
    )
  }
  if (toProcessScaled(strandFactor, field) <= 0n) {
    throw new ProcessRuleViolation('A2-1', `${field} 绞合系数必须大于 0（损耗/余量不得并入绞合系数）`)
  }
}

/** [底稿 A2-1] 下线数量：必填、非负、≤4 位小数（正则即口径）。 */
export function assertOfflineQty(offlineQty: string, field: string): void {
  const scaled = toProcessScaled(offlineQty, field)
  if (scaled < 0n) {
    throw new ProcessRuleViolation('A2-1', `${field} 下线数量不得为负：${offlineQty}`)
  }
}

/** [底稿 A2-1] 订单产量：必填、> 0、≤4 位小数。 */
export function assertOrderQty(orderQty: string, field: string): void {
  if (toProcessScaled(orderQty, field) <= 0n) {
    throw new ProcessRuleViolation('A2-1', `${field} 订单产量必须大于 0：${orderQty}`)
  }
}
