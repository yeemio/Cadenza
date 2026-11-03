import { ShippingRuleViolation } from './errors'
import type { PlLineStatus, PlStatus, ShipmentLineKind } from './pl-rules'

/**
 * 扫码装入/删码/补码纯规则 —— 规则底稿 04 §A-T14-3/5
 * （原件 成品出库.md §3.3/§3.4 扫码逻辑：五拒一成 + 行扫满状态流转 + 删码退回 + 补码）。
 *
 * 五拒（A-T14-3）：未审核 / 质量存疑 / 被锁定 / 未关联销售订单行 / 无段长；
 * 一成：行扫满→已装箱（line packed），全部行扫满→待出库（order ready_to_ship）；
 * 删码不满足退回待装箱（行与单同步回退）。
 */

/** 装入校验事实（命令层事实收集后调用）。 */
export interface ScanLoadFacts {
  unitNo: string
  /** 库存单元状态（IT-13 轴：仅在库可装入）。 */
  unitStatus: string
  /** 库存余额质量状态（待检=未审核、存疑恒拒）。 */
  qualityStatus: string
  /** 存疑隔离活动行存在（quality_hold active=待检/不合格/存疑族——存疑任何模式恒拒）。 */
  suspectHoldActive: boolean
  /** 存在其它业务的活动作业预留（IT-23 口径）。 */
  lockedByOtherTask: boolean
  /** 匹配到的备货行（null=未关联销售订单行）。 */
  matchedLine: {
    lineId: string
    lineKind: ShipmentLineKind
    /** 行快照段长（有轴=standard_segment_length、无轴=segment_length；null=无段长）。 */
    segmentLength: string | null
    requiredCount: number
    scannedCount: number
  } | null
  /** 同码在本单已有未删除装入记录。 */
  alreadyLoadedInOrder: boolean
}

/** A-T14-3：扫码装入校验——五拒一成（域断言；库存扣减在确认出库时执行）。 */
export function assertScanLoadable(facts: ScanLoadFacts): void {
  if (facts.alreadyLoadedInOrder) {
    throw new ShippingRuleViolation('A-T14-3', `码 ${facts.unitNo} 已装入本单且未删除，拒绝重复装入`)
  }
  if (facts.unitStatus !== 'in_stock') {
    throw new ShippingRuleViolation('A-T14-3', `码 ${facts.unitNo} 不在库（当前 ${facts.unitStatus}），仅库存内码可装入`)
  }
  if (facts.qualityStatus === 'suspect' || facts.suspectHoldActive) {
    throw new ShippingRuleViolation('A-T14-3', `码 ${facts.unitNo} 质量存疑，拒绝装入（存疑不受参数控制恒拒）`)
  }
  if (facts.qualityStatus !== 'qualified') {
    throw new ShippingRuleViolation(
      'A-T14-3',
      `码 ${facts.unitNo} 未审核（质量状态 ${facts.qualityStatus}，仅合格可用码可装入）`,
    )
  }
  if (facts.lockedByOtherTask) {
    throw new ShippingRuleViolation('A-T14-3', `码 ${facts.unitNo} 被其它业务锁定（活动作业预留），拒绝装入`)
  }
  if (facts.matchedLine === null) {
    throw new ShippingRuleViolation('A-T14-3', `码 ${facts.unitNo} 未关联销售订单行（本单无匹配备货行），拒收`)
  }
  const line = facts.matchedLine
  // 无段长拒收：有轴单品（标准段长）/无轴单品（段长）快照缺失即拒；托盘行以逐轴轴明细承载，
  // 不以单值段长断言（总轴数缺失由行规格断言兜底）。
  if (line.lineKind !== 'pallet' && line.segmentLength === null) {
    throw new ShippingRuleViolation('A-T14-3', `备货行 ${line.lineId} 无段长（快照缺失），拒收`)
  }
  if (line.scannedCount >= line.requiredCount) {
    throw new ShippingRuleViolation(
      'A-T14-3',
      `备货行 ${line.lineId} 已扫满（已扫 ${line.scannedCount}/应扫 ${line.requiredCount}），拒绝多扫`,
    )
  }
}

/** 行进度推进：装入/补码后已扫数与行状态（A-T14-3：行扫满→已装箱）。 */
export function advanceLineProgress(input: {
  scannedCount: number
  requiredCount: number
}): { scannedCount: number; lineStatus: PlLineStatus } {
  const scannedCount = input.scannedCount + 1
  return {
    scannedCount,
    lineStatus: scannedCount >= input.requiredCount ? 'packed' : 'pending_packing',
  }
}

/** 单状态重推：全部行已装箱→待出库；否则待装箱（A-T14-3）。 */
export function deriveOrderStatus(lineStatuses: readonly PlLineStatus[]): PlStatus {
  if (lineStatuses.length === 0) return 'pending_packing'
  return lineStatuses.every((s) => s === 'packed') ? 'ready_to_ship' : 'pending_packing'
}

/** 删码事实（A-T14-3：删码不满足退回待装箱）。 */
export interface ScanRemoveFacts {
  orderStatus: PlStatus
  lineStatus: PlLineStatus
  scannedCount: number
  requiredCount: number
}

/** A-T14-3：删码回退——已出库不可删；行扫满被破坏→行退待装箱；单状态随全部行重推退回待装箱。 */
export function applyScanRemoval(facts: ScanRemoveFacts): {
  scannedCount: number
  lineStatus: PlLineStatus
  orderStatus: PlStatus
} {
  if (facts.orderStatus === 'shipped') {
    throw new ShippingRuleViolation('A-T14-3', 'PL 已出库，扫码记录不可删除')
  }
  const scannedCount = facts.scannedCount - 1
  if (scannedCount < 0) {
    throw new ShippingRuleViolation('A-T14-3', '该行无未删除扫码记录，无可删码')
  }
  const lineStatus: PlLineStatus = scannedCount >= facts.requiredCount ? 'packed' : 'pending_packing'
  // 单状态：任一行退回待装箱 → 整单退回待装箱（删码不满足退回待装箱）
  const orderStatus: PlStatus = lineStatus === 'packed' ? facts.orderStatus : 'pending_packing'
  return { scannedCount, lineStatus, orderStatus }
}

/**
 * A-T14-5：补码——无轴行缺产品轴号时打包页扫码补轴号（无数量输入，计入已扫件数）。
 * 底稿 C-7 缺口（补码数量是否受应扫上限约束未裁定）：按 fail-closed 以上限约束。
 */
export function assertSupplementaryAxisLoadable(input: {
  lineKind: ShipmentLineKind
  scannedCount: number
  requiredCount: number
  unitNo: string
}): void {
  if (input.lineKind !== 'plain_item') {
    throw new ShippingRuleViolation('A-T14-5', `补码仅适用于无轴单品行（当前行类型 ${input.lineKind}；有轴单品经扫码装入、托盘行逐轴扫满）`)
  }
  if (input.scannedCount >= input.requiredCount) {
    throw new ShippingRuleViolation(
      'A-T14-5',
      `无轴行已扫满（已扫 ${input.scannedCount}/应扫 ${input.requiredCount}），补码 ${input.unitNo} 拒绝（C-7 缺口按应扫上限 fail-closed）`,
    )
  }
}
