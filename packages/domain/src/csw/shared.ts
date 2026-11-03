import { DECIMAL_STRING_REGEX } from '@cadenza/contracts'
import { CswRuleViolation } from './errors'

/**
 * csw 域自包含定点算术与日期口径（同 scheduling/slot-rules 的域内自实现先例：
 * domain 包内文件不得以相对路径逃逸出本目录〔根 eslint 边界规则〕，
 * 数量 scale=4 BigInt、半入格式与全仓 numeric 出参口径一致）。
 *
 * 违例码为显式入参：就近携带触发的冻结合同规则编号（缺省 'CS-04'＝约束硬拒总则；
 * 外协数量口径用 'CS-S4'、日期/求解窗口用 'CS-18'、换型时长用 'CS-16'——由调用方指定）。
 */

const QTY_SCALE = 4
const SCALE_FACTOR = 10n ** BigInt(QTY_SCALE)

/** 解析为 scale=4 定点 BigInt；非法输入抛违例（非负数域由调用方校验）。 */
export function parseQty(value: string, field: string, rule = 'CS-04'): bigint {
  if (typeof value !== 'string' || !DECIMAL_STRING_REGEX.test(value)) {
    throw new CswRuleViolation(
      rule,
      `${field} 必须是十进制定点字符串（≤${QTY_SCALE} 位小数，禁 number/科学计数法）：${String(value)}`,
    )
  }
  const negative = value.startsWith('-')
  const body = negative ? value.slice(1) : value
  const [intPart, fracPart = ''] = body.split('.')
  if (intPart.length > 14) {
    throw new CswRuleViolation(rule, `${field} 整数部分不得超过 14 位：${value}`)
  }
  const fracPadded = (fracPart + '0'.repeat(QTY_SCALE)).slice(0, QTY_SCALE)
  return negative ? -(BigInt(intPart + fracPadded)) : BigInt(intPart + fracPadded)
}

/** 定点 BigInt → 十进制字符串（scale=4 去尾零，与全仓 dec() 出参口径一致）。 */
export function formatQty(scaled: bigint): string {
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const intPart = abs / SCALE_FACTOR
  const fracPart = (abs % SCALE_FACTOR).toString().padStart(QTY_SCALE, '0')
  const text = `${negative ? '-' : ''}${intPart}.${fracPart}`
  return text.replace(/0+$/, '').replace(/\.$/, '')
}

/** 数量比较（<0 / 0 / >0）。 */
export function cmpQty(a: string, b: string): number {
  const x = parseQty(a, '数量a')
  const y = parseQty(b, '数量b')
  return x < y ? -1 : x > y ? 1 : 0
}

/** 数量加法（scale=4 精确）。 */
export function addQty(a: string, b: string): string {
  return formatQty(parseQty(a, '数量a') + parseQty(b, '数量b'))
}

/** 数量减法（结果为负时抛违例——csw 侧不承载负数量语义）。 */
export function subQty(a: string, b: string, rule = 'CS-04'): string {
  const r = parseQty(a, '数量a') - parseQty(b, '数量b')
  if (r < 0n) {
    throw new CswRuleViolation(rule, `数量减法结果为负（${a} - ${b}），拒绝`)
  }
  return formatQty(r)
}

/** 断言数量非负且合法（入口通用）。 */
export function assertQtyNonNegative(value: string, field: string, rule = 'CS-04'): void {
  if (parseQty(value, field, rule) < 0n) {
    throw new CswRuleViolation(rule, `${field} 不得为负：${value}`)
  }
}

/** 断言正数量（外协发送/接收量等）。 */
export function assertQtyPositive(value: string, field: string, rule = 'CS-S4'): void {
  if (parseQty(value, field, rule) <= 0n) {
    throw new CswRuleViolation(rule, `${field} 必须大于 0：${value}`)
  }
}

// ---------------- 日期口径（YYYY-MM-DD 纯字符串，UTC 日期算术） ----------------

export function isValidProductionDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const [y, m, d] = date.split('-').map((p) => Number(p))
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const utc = new Date(Date.UTC(y, m - 1, d))
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d
}

export function assertProductionDateValid(date: string, field = '生产日期', rule = 'CS-18'): void {
  if (!isValidProductionDate(date)) {
    throw new CswRuleViolation(rule, `${field} 必须为 YYYY-MM-DD 且为真实日历日：${date}`)
  }
}

/** 日期差（to - from，天）。 */
export function diffDays(from: string, to: string): number {
  assertProductionDateValid(from, '起始日期')
  assertProductionDateValid(to, '结束日期')
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

/** 日期 + N 天（N 可负）。 */
export function shiftDateDays(date: string, days: number): string {
  assertProductionDateValid(date)
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
  return next.toISOString().slice(0, 10)
}

/** 日期闭区间重叠判定（CS-S2 冻结区间 / CS-09 停机区间共用）。 */
export function dateRangesOverlap(
  a: { from: string; to: string },
  b: { from: string; to: string },
): boolean {
  return a.from <= b.to && b.from <= a.to
}
