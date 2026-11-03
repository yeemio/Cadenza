import { ShippingRuleViolation } from './errors'
import type { PlStatus } from './pl-rules'

/**
 * 打包任务纯规则 —— 规则底稿 04 §A-T14-4
 * （原件 成品出库.md §3.3 打包任务：先扫托码+选调入库位（货架码+层数）→逐行扫满→绑定托码；
 * 已打包托码库位只读）。
 */

/** 打包任务状态（A-T14-4：待打包（扫满中）→已绑定（绑定托码完成））。 */
export const PACKING_STATUSES = ['pending', 'bound', 'cancelled'] as const
export type PackingStatus = (typeof PACKING_STATUSES)[number]

/** 打包任务内的行进度事实。 */
export interface PackingLineFacts {
  lineId: string
  lineKind: string
  requiredCount: number
  scannedCount: number
  lineStatus: string
}

/** A-T14-4：打包任务创建前置——先扫托码+选调入库位（缺一不可创建）。 */
export function assertPackingStartable(input: {
  orderStatus: PlStatus
  palletCode: string | null | undefined
  toLocationId: string | null | undefined
  toLocationCode: string | null | undefined
  palletLineCount: number
}): void {
  if (input.orderStatus === 'shipped') {
    throw new ShippingRuleViolation('A-T14-4', 'PL 已出库，不可再创建打包任务')
  }
  if (input.palletCode === undefined || input.palletCode === null || input.palletCode.trim() === '') {
    throw new ShippingRuleViolation('A-T14-4', '打包任务创建须先扫托码（palletCode 必填）')
  }
  if (input.toLocationId === undefined || input.toLocationId === null || input.toLocationId.trim() === '') {
    throw new ShippingRuleViolation('A-T14-4', '打包任务创建须先选调入库位（货架码+层数拼位，toLocationId/toLocationCode 必填）')
  }
  if (input.toLocationCode === undefined || input.toLocationCode === null || input.toLocationCode.trim() === '') {
    throw new ShippingRuleViolation('A-T14-4', '调入库位编码缺失（货架码+层数拼位）')
  }
  if (input.palletLineCount === 0) {
    throw new ShippingRuleViolation('A-T14-4', '打包任务至少关联一条托盘行（本单无托盘行无须打包任务）')
  }
}

/**
 * A-T14-4：绑定托码前置——每行已扫完 + 托码 + 库位三者齐备方可绑定；
 * 已打包（bound）托码的库位只读（不得再次绑定/换位）。
 */
export function assertBindPalletReady(input: {
  status: PackingStatus
  palletCode: string | null
  toLocationId: string | null
  lines: readonly PackingLineFacts[]
  scannedOutsidePallet: number
}): void {
  if (input.status !== 'pending') {
    throw new ShippingRuleViolation('A-T14-4', `打包任务状态为 ${input.status}，仅待打包（pending）可绑定托码（已打包托码库位只读）`)
  }
  if (input.palletCode === null || input.palletCode.trim() === '') {
    throw new ShippingRuleViolation('A-T14-4', '绑定托码须携带托码')
  }
  if (input.toLocationId === null) {
    throw new ShippingRuleViolation('A-T14-4', '绑定托码须携带调入库位（已打包托码库位只读）')
  }
  if (input.scannedOutsidePallet > 0) {
    throw new ShippingRuleViolation(
      'A-T14-4',
      `存在 ${input.scannedOutsidePallet} 条未挂本打包任务的已扫托盘行（逐行扫满后绑定）`,
    )
  }
  const unfinished = input.lines.filter((l) => l.scannedCount < l.requiredCount)
  if (unfinished.length > 0) {
    throw new ShippingRuleViolation(
      'A-T14-4',
      `绑定托码要求每行已扫完：行 ${unfinished.map((l) => l.lineId).join('、')} 已扫/应扫未满（${unfinished
        .map((l) => `${l.scannedCount}/${l.requiredCount}`)
        .join('、')}）`,
    )
  }
}

/** A-T14-4：已打包托码库位只读——同托码存在已绑定任务时，不得再建任务或改库位。 */
export function assertPackedPalletReadonly(input: {
  palletCode: string
  boundPackingExists: boolean
  existingPackingLocationId: string | null
  requestedLocationId: string | null
}): void {
  if (input.boundPackingExists) {
    if (input.requestedLocationId !== null && input.requestedLocationId !== input.existingPackingLocationId) {
      throw new ShippingRuleViolation(
        'A-T14-4',
        `托码 ${input.palletCode} 已打包，库位只读（既有 ${input.existingPackingLocationId}，请求 ${input.requestedLocationId}）`,
      )
    }
    throw new ShippingRuleViolation('A-T14-4', `托码 ${input.palletCode} 已打包（bound），托码与库位只读，不得重复打包`)
  }
}
