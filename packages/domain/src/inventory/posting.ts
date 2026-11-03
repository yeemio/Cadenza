import type { DecimalString } from '@cadenza/contracts'
import { InventoryRuleViolation } from './errors'
import { addQty, cmpQty, isZeroQty, isValidQuantityString, subQty } from './quantity'

/**
 * 记账纯规则（流水/余额/幂等/并发）—— 对应冻结合同 inventory-trace-core.md §5/§6：
 * IT-18/19/20/22/25/27、IT-29、IT-30-①。
 */

/** 记账变动种类（迁移 0004 stock_transaction.movement_kind 同口径）。 */
export const MOVEMENT_KINDS = [
  'receive',
  'issue',
  'move',
  'transfer_out',
  'transfer_in',
  'split',
  'merge',
  'adjust',
  'reverse',
] as const
export type MovementKind = (typeof MOVEMENT_KINDS)[number]

/** IT-19：流水行形状（每条流水必含扣前余额与扣后余额）。 */
export interface PostingLineInput {
  lineNo: number
  movementKind: MovementKind
  /** 扣前余额（主事务内实时读取，锁后取值） */
  beforeQty: DecimalString
  /** 有符号变动量（收+/发-/移库两行各记一边） */
  deltaQty: DecimalString
  uomId: string
}

export interface PostingLineComputed {
  lineNo: number
  movementKind: MovementKind
  beforeQty: DecimalString
  deltaQty: DecimalString
  afterQty: DecimalString
  /** IT-29：本次变动后余额是否归零（归零 → 关闭活动余额，身份与谱系保留） */
  closesBalance: boolean
}

/**
 * IT-19/IT-30-①：构造流水行并校验账面不变量：
 * - 扣前/扣后必含且非负（账上不得出现负库存）；
 * - 变动量不得为 0（空流水无意义，拒绝）；
 * - 数量格式十进制定点。
 */
export function buildPostingLine(input: PostingLineInput): PostingLineComputed {
  if (!isValidQuantityString(input.beforeQty) || !isValidQuantityString(input.deltaQty)) {
    throw new InventoryRuleViolation('IT-19', '流水数量必须为十进制定点字符串')
  }
  if (cmpQty(input.beforeQty, '0.0000') < 0) {
    throw new InventoryRuleViolation('IT-30', `扣前余额不得为负：${input.beforeQty}`)
  }
  if (isZeroQty(input.deltaQty)) {
    throw new InventoryRuleViolation('IT-19', `流水第 ${input.lineNo} 行变动量为 0，拒绝入账`)
  }
  const afterQty = addQty(input.beforeQty, input.deltaQty)
  if (cmpQty(afterQty, '0.0000') < 0) {
    throw new InventoryRuleViolation(
      'IT-30',
      `并发余量不足导致负库存：扣前 ${input.beforeQty}、变动 ${input.deltaQty}、扣后 ${afterQty}` +
        '（须以 ERR_INSUFFICIENT_STOCK 可解释拒绝，不得入负账）',
    )
  }
  return {
    lineNo: input.lineNo,
    movementKind: input.movementKind,
    beforeQty: input.beforeQty,
    deltaQty: input.deltaQty,
    afterQty,
    closesBalance: isZeroQty(afterQty), // IT-29
  }
}

/** IT-25/IT-27：稳定次序锁库存单元（排序去重），避免交叉加锁死锁；配合行锁拦截 IT-15 同码并发消费。 */
export function ensureStableLockOrder(unitIds: readonly string[]): string[] {
  return [...new Set(unitIds)].sort()
}

/** IT-20：余额唯一键 (unit, location, owner) 三元组形状。 */
export interface BalanceKey {
  unitId: string
  locationId: string
  ownerId: string
}

export function sameBalanceKey(a: BalanceKey, b: BalanceKey): boolean {
  return a.unitId === b.unitId && a.locationId === b.locationId && a.ownerId === b.ownerId
}

/**
 * IT-18：库存域是数量/库位/所有权/预留的唯一维护方。
 * 其它域经库存命令进入同一 Unit of Work；本断言用于命令入口校验载荷不含越域直写意图
 * （如调用方试图携带 balance_override 等直改余额的字段）。
 */
export function assertNoDirectBalanceOverride(payloadKeys: readonly string[]): void {
  const forbidden = ['balance_override', 'force_balance', 'skip_availability_check']
  const hit = payloadKeys.filter((k) => forbidden.includes(k))
  if (hit.length > 0) {
    throw new InventoryRuleViolation(
      'IT-18',
      `库存余额只经库存命令维护，载荷不得携带直写/跳检字段：${hit.join(',')}`,
    )
  }
}

/** IT-22：命令响应五态（成功已入账/保存草稿/业务校验失败/版本冲突/结果未知待查询）。 */
export type InventoryOutcomeStatus =
  | 'COMMITTED'
  | 'DRAFT_SAVED'
  | 'BUSINESS_REJECTION'
  | 'VERSION_CONFLICT'
  | 'UNKNOWN_PENDING_QUERY'

/**
 * IT-21/IT-22：断响应后终端查询原 operationId 的结果分类辅助（批量操作全成全败口径由
 * 命令事务保证——一个命令一个事务，任何一行拒绝整体回滚）。
 */
export function classifyReplayOutcome(originalStatus: InventoryOutcomeStatus): InventoryOutcomeStatus {
  return originalStatus
}

/** IT-27：跨行约束失败的有界重试参数（默认上限；不无条件全库串行）。 */
export const CONCURRENCY_RETRY = { maxAttempts: 3, backoffMs: 40 } as const

/** 守恒校验辅助：合计（供 conservation.ts 复用）。 */
export function sumQty(values: readonly DecimalString[]): DecimalString {
  let acc: DecimalString = '0.0000'
  for (const v of values) acc = addQty(acc, v)
  return acc
}

export function negateQty(a: DecimalString): DecimalString {
  return subQty('0.0000', a)
}
