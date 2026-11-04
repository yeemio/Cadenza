import type { DecimalString } from '@cadenza/contracts'
import { InventoryRuleViolation } from './errors'
import { addQty, cmpQty, subQty } from './quantity'
import { isQualityAvailable, type QualityStatus } from './stock-state'

/**
 * 可用量与并发消费纯规则 —— 对应冻结合同 inventory-trace-core.md §4/§5：IT-14/15、§7 IT-30-①。
 */

/** 预留行最小形状（IT-23：预留另记，不并入状态轴，IT-13）。 */
export interface ReservationLike {
  status: string
  quantity: DecimalString
  validUntil: string
}

export type UnavailableReason = 'QUALITY_HOLD' | 'QUALITY_NOT_RELEASED' | 'BUSINESS_HOLD' | 'RESERVED' | 'NO_STOCK'

export interface AvailabilityInput {
  grossQty: DecimalString
  qualityStatus: QualityStatus
  activeReservations: readonly ReservationLike[]
  now: string
  qualityHeld?: boolean
  businessHeld?: boolean
}

/** Independent quality/custody gates precede allocation; reservations never grant quality release. */
export function evaluateAvailability(input: AvailabilityInput): {
  gross: DecimalString; reserved: DecimalString; available: DecimalString
  eligible: boolean; reasons: UnavailableReason[]
} {
  const nowMs = Date.parse(input.now)
  let reserved: DecimalString = '0.0000'
  for (const r of input.activeReservations) {
    if (r.status === 'active' && Date.parse(r.validUntil) >= nowMs) reserved = addQty(reserved, r.quantity)
  }
  const reasons: UnavailableReason[] = []
  if (input.qualityHeld) reasons.push('QUALITY_HOLD')
  if (!isQualityAvailable(input.qualityStatus)) reasons.push('QUALITY_NOT_RELEASED')
  if (input.businessHeld) reasons.push('BUSINESS_HOLD')
  const eligible = reasons.length === 0
  if (cmpQty(reserved, '0') > 0) reasons.push('RESERVED')
  if (cmpQty(input.grossQty, '0') <= 0) reasons.push('NO_STOCK')
  const available = eligible && cmpQty(input.grossQty, reserved) >= 0 ? subQty(input.grossQty, reserved) : '0.0000'
  return { gross: input.grossQty, reserved, available, eligible, reasons }
}

/**
 * IT-14：可用量 = 质量条件 ∧ 预留条件。
 * 只有质量合格（qualified）的余额形成毛可用；再减去**有效期内**（valid_until ≥ now）的
 * 活动预留合计。待检/不合格/存疑余额不得进入可用量、不得发运。
 */
export function computeAvailability(input: AvailabilityInput): { gross: DecimalString; reserved: DecimalString; available: DecimalString } {
  const { gross, reserved, available } = evaluateAvailability(input)
  return { gross, reserved, available }
}

/**
 * IT-14/IT-30-①：发料/消费前校验实时可用量。
 * 主事务内（锁库存单元后）执行；可用不足 → 业务拒绝（应用层映射 ERR_INSUFFICIENT_STOCK），
 * 账上不得出现负库存。
 */
export function assertAvailableForIssue(input: {
  grossQty: DecimalString
  qualityStatus: QualityStatus
  activeReservations: readonly ReservationLike[]
  requestedQty: DecimalString
  now: string
  unitNo?: string
}): { gross: DecimalString; reserved: DecimalString; available: DecimalString } {
  const availability = computeAvailability(input)
  if (cmpQty(availability.available, input.requestedQty) < 0) {
    throw new InventoryRuleViolation(
      'IT-14',
      `可用量不足（单元 ${input.unitNo ?? ''}毛量 ${availability.gross}、预留 ${availability.reserved}、` +
        `可用 ${availability.available}、本次申请 ${input.requestedQty}）；待检/不合格/存疑余额不得发运`,
    )
  }
  return availability
}

/**
 * IT-15：同一码不能被多任务同时消费。
 * 以唯一约束＋行锁拦截（实现层：按稳定次序 SELECT ... FOR UPDATE 锁库存单元，见 posting.ts
 * ensureStableLockOrder）；本纯规则校验"同码活动占用互斥"语义的显式断言位（供命令层复核）。
 */
export function assertUnitNotLockedByOtherTask(input: {
  unitNo: string
  activeHolderRefs: readonly string[]
  currentHolderRef: string | null
}): void {
  if (input.currentHolderRef === null) return
  const occupied = input.activeHolderRefs.filter((h) => h !== input.currentHolderRef)
  if (occupied.length > 0) {
    throw new InventoryRuleViolation(
      'IT-15',
      `单元 ${input.unitNo} 已被其它任务占用（${occupied.join(',')}）；同一码不能被多任务同时消费`,
    )
  }
}
