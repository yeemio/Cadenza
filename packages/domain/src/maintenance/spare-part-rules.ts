import { MaintenanceRuleViolation } from './errors'

/**
 * 备件消耗规则（MT-11/MT-S3——[合同新造]）。
 *
 * 备件作为物料走同一库存域（IT-18 唯一记账方）；备件动用与工单关闭同事务写
 * 消耗记录＋库存流水（扣减走 stock_transaction，含扣前/扣后余额）；
 * 消耗数量 > 0 且 ≤ 实时可用量。备件物料清单来源/存放仓库/安全库存/单价 → GAP-F21 待裁。
 */

/** 数量十进制字符串（最多 4 位小数，对齐 numeric(18,4)）。 */
const DECIMAL_QUANTITY_PATTERN = /^\d+(\.\d{1,4})?$/

/** MT-11：数量口径解析（十进制字符串，禁负数/禁科学计数/禁超 4 位小数）。 */
export function parseSpareQuantity(raw: unknown): string {
  if (typeof raw !== 'string' || !DECIMAL_QUANTITY_PATTERN.test(raw)) {
    throw new MaintenanceRuleViolation(
      'MT-11',
      `备件消耗数量必须为非负十进制字符串（最多 4 位小数），非法输入：${String(raw)}`,
    )
  }
  return raw
}

/** 十进制比较（a<b → -1；a=b → 0；a>b → 1），按 4 位小数定标整数比较。 */
export function compareDecimalQuantity(a: string, b: string): number {
  const scale = (value: string): bigint => {
    const [intPart, fracPart = ''] = value.split('.')
    return BigInt(intPart) * 10_000n + BigInt((fracPart + '0000').slice(0, 4))
  }
  const x = scale(a)
  const y = scale(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * MT-11：消耗守卫——数量 > 0 且 ≤ 实时可用量（不足拒绝，整单事务回滚，
 * 工单状态不受影响路径见 MT-10"复机失败不改变工单状态"）。
 */
export function assertSpareUsageQuantity(quantity: string, availableQuantity: string): void {
  if (compareDecimalQuantity(quantity, '0') === 0) {
    throw new MaintenanceRuleViolation('MT-11', '备件消耗数量必须大于 0')
  }
  if (compareDecimalQuantity(quantity, availableQuantity) > 0) {
    throw new SparePartInsufficientError(quantity, availableQuantity)
  }
}

/** MT-11：可用量不足专用违例（应用层映射 ERR_INSUFFICIENT_STOCK，同库存域口径）。 */
export class SparePartInsufficientError extends MaintenanceRuleViolation {
  constructor(quantity: string, availableQuantity: string) {
    super('MT-11', `备件消耗数量大于实时可用量（消耗=${quantity}，可用=${availableQuantity}），拒绝`)
    this.name = 'SparePartInsufficientError'
  }
}

/** MT-11：扣后余额计算（扣前 − 消耗，4 位定标整数回写为十进制字符串）。 */
export function deductAvailableQuantity(before: string, quantity: string): string {
  const scale = (value: string): bigint => {
    const [intPart, fracPart = ''] = value.split('.')
    return BigInt(intPart) * 10_000n + BigInt((fracPart + '0000').slice(0, 4))
  }
  const after = scale(before) - scale(quantity)
  const intPart = after / 10_000n
  const fracPart = (after % 10_000n).toString().padStart(4, '0')
  return `${intPart}.${fracPart}`
}
