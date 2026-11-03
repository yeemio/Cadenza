/**
 * 数量表示约定（SYSTEM_ARCHITECTURE §4.2 / DOMAIN_MODEL §4.2）：
 *
 * - 接口与边界层一律使用十进制字符串（DecimalString），禁止用 IEEE-754 number 表示数量；
 * - 账面保留 scale=4（如 "12.5000"），本包只约定格式，不做算术（算术属于 persistence 的 numeric 列与 SQL）；
 * - 显示舍入不改账：展示层自行舍入，不回传舍入后的数量。
 */

/** 十进制数量字符串，如 "123.4500"、"-0.0012"。禁止 number。 */
export type DecimalString = string

/** 允许可选前导负号、整数位数字、可选 1–4 位小数（不接受科学计数法、千分位、空串）。 */
export const DECIMAL_STRING_REGEX = /^-?\d+(\.\d{1,4})?$/

/** 运行时类型守卫：仅 string 且匹配十进制定点格式（scale ≤ 4）时为 true。 */
export function isDecimalString(value: unknown): value is DecimalString {
  return typeof value === 'string' && DECIMAL_STRING_REGEX.test(value)
}
