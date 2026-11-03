import type { DecimalString } from '@cadenza/contracts'
import { InventoryRuleViolation } from './errors'
import { isPositiveQty, isValidQuantityString } from './quantity'

/**
 * 作业预留纯规则 —— 对应冻结合同 inventory-trace-core.md §5：IT-23（含 CA-5 边界冻结）。
 */

/** IT-23：预留所有者四类（job 工单 / task 任务 / order 订单 / manual 人工）。 */
export const RESERVATION_HOLDER_TYPES = ['job', 'task', 'order', 'manual'] as const
export type ReservationHolderType = (typeof RESERVATION_HOLDER_TYPES)[number]

export type ReservationStatus = 'active' | 'released' | 'expired' | 'consumed'

/** 预留行最小形状。 */
export interface ReservationState {
  id: string
  unitId: string
  holderType: ReservationHolderType
  holderRef: string
  quantity: DecimalString
  status: ReservationStatus
  validUntil: string
}

/**
 * IT-23：作业预留四要素——所有者（holder_type/holder_ref）、占用对象（unit/location）、
 * 有效期（valid_until 必填；原文"锁定无有效期"冲突 CA-5 待裁，内核冻结"预留必须含有效期"机制）、
 * 释放记录（释放时必填 released_by/reason，见 assertReleaseRecorded）。
 */
export function assertReservationAcquirable(input: {
  unitId: string
  holderType: string
  holderRef: string
  quantity: DecimalString
  validUntil: string | null | undefined
  now: string
}): void {
  if (!RESERVATION_HOLDER_TYPES.includes(input.holderType as ReservationHolderType)) {
    throw new InventoryRuleViolation('IT-23', `预留所有者类型非法：${input.holderType}`)
  }
  if (!(input.holderRef ?? '').trim()) {
    throw new InventoryRuleViolation('IT-23', '预留必须登记占用者标识（holder_ref）')
  }
  if (!input.unitId) {
    throw new InventoryRuleViolation('IT-23', '预留必须指明占用对象（库存单元）')
  }
  if (!isValidQuantityString(input.quantity) || !isPositiveQty(input.quantity)) {
    throw new InventoryRuleViolation('IT-23', `预留数量必须为正的十进制定点字符串：${String(input.quantity)}`)
  }
  const validUntilMs = Date.parse(input.validUntil ?? '')
  if (input.validUntil === null || input.validUntil === undefined || Number.isNaN(validUntilMs)) {
    throw new InventoryRuleViolation('IT-23', '预留必须含有效期（valid_until，ISO-8601）')
  }
  if (validUntilMs <= Date.parse(input.now)) {
    throw new InventoryRuleViolation('IT-23', '预留有效期必须晚于当前时间（不得签发即时过期预留）')
  }
}

/** IT-23：预留当前是否仍有效（active 且未过 valid_until）。 */
export function isReservationEffective(reservation: Pick<ReservationState, 'status' | 'validUntil'>, now: string): boolean {
  if (reservation.status !== 'active') return false
  const until = Date.parse(reservation.validUntil)
  const nowMs = Date.parse(now)
  if (Number.isNaN(until) || Number.isNaN(nowMs)) return false
  return until >= nowMs
}

/**
 * IT-23（后半，冻结语义）：**过期后旧终端提交必须重新校验**——不得凭过期预留直接入账。
 * 发料/消费命令携带预留引用时，本断言在主事务内复核其有效性；过期 → 业务拒绝，
 * 终端须重新获取可用量与预留后再提交。
 */
export function assertReservationUsableForCommit(
  reservation: Pick<ReservationState, 'id' | 'status' | 'validUntil'>,
  now: string,
): void {
  if (!isReservationEffective(reservation, now)) {
    throw new InventoryRuleViolation(
      'IT-23',
      `预留 ${reservation.id} 已${reservation.status === 'active' ? '过有效期' : `处于 ${reservation.status} 状态`}；` +
        '过期后旧终端提交必须重新校验，不得凭过期预留直接入账',
    )
  }
}

/** IT-23：释放记录——释放必须留痕（released_by 必填、原因可空但建议填写；行不删除）。 */
export function assertReleaseRecorded(input: { reservationId: string; releasedBy: string | null | undefined }): void {
  if (!(input.releasedBy ?? '').trim()) {
    throw new InventoryRuleViolation('IT-23', `释放预留 ${input.reservationId} 必须记录释放人（released_by）`)
  }
}
