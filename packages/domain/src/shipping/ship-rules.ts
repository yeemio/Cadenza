import { ShippingRuleViolation } from './errors'
import type { ActualAxisSyncStatus, PlStatus, ShippingStatusSyncStatus } from './pl-rules'

/**
 * 确认出库与两条独立回传纯规则 —— 规则底稿 04 §A-T14-7/8
 * （原件 成品出库.md §2.1/§1.2；冻结合同 interfaces.md IF-06/IF-07/IF-00.4/IF-00.5/IF-00.6）。
 *
 * 两条回传独立：实发轴同步（客户轴号与实发轴号无差异→无需同步，不是失败）与
 * 发货状态同步（仅已出库、按出库完成时点快照重推）互不改变对方状态。
 */

/** 确认出库行事实（A-T14-7：任一行已扫<应扫拒并指名料品/段长）。 */
export interface ConfirmShipmentLineFacts {
  lineId: string
  lineNo: number
  materialCode: string
  /** 行快照段长显示值（有轴=标准段长、无轴=段长、托盘=逐轴段长缺省 null）。 */
  segmentLabel: string | null
  requiredCount: number
  scannedCount: number
}

/** A-T14-7：确认出库前置——仅待出库；每行已扫≥应扫（不足拒并指名料品/段长）。 */
export function assertConfirmShippable(input: {
  orderStatus: PlStatus
  lines: readonly ConfirmShipmentLineFacts[]
}): void {
  if (input.orderStatus !== 'ready_to_ship') {
    throw new ShippingRuleViolation('A-T14-7', `确认出库仅可自 待出库 执行（当前 ${input.orderStatus}）`)
  }
  const short = input.lines.filter((l) => l.scannedCount < l.requiredCount)
  if (short.length > 0) {
    const detail = short
      .map((l) => `料品 ${l.materialCode}（段长 ${l.segmentLabel ?? '无'}，行 ${l.lineNo}）：已扫 ${l.scannedCount}/应扫 ${l.requiredCount}`)
      .join('；')
    throw new ShippingRuleViolation('A-T14-7', `存在已扫<应扫的备货行，拒绝确认出库——${detail}`)
  }
}

/** IF-06：实发轴差异判定输入/输出。 */
export interface ActualAxisDiffInput {
  /** 计划客户轴号集（有轴单品行快照 customer_axis_no；订单下达时点固化）。 */
  plannedCustomerAxes: readonly string[]
  /** 实发轴号集（扫码装入记录的码/产品轴号，出库时点快照）。 */
  actualAxes: readonly string[]
}

export interface ActualAxisSyncDecision {
  /** 无差异→noop_needed（无需同步不是失败）；有差异→pending（差异判定按出库时点快照）。 */
  status: Extract<ActualAxisSyncStatus, 'noop_needed' | 'pending'>
  hasDiff: boolean
  missingOnActual: string[]
  extraOnActual: string[]
}

/** IF-06：实发轴同步差异判定——客户轴号与实发轴号无差异→无需同步。 */
export function resolveActualAxisSyncDecision(input: ActualAxisDiffInput): ActualAxisSyncDecision {
  const planned = new Set(input.plannedCustomerAxes)
  const actual = new Set(input.actualAxes)
  const missingOnActual = [...planned].filter((a) => !actual.has(a))
  const extraOnActual = [...actual].filter((a) => !planned.has(a))
  const hasDiff = missingOnActual.length > 0 || extraOnActual.length > 0
  return {
    status: hasDiff ? 'pending' : 'noop_needed',
    hasDiff,
    missingOnActual,
    extraOnActual,
  }
}

/** IF-06：实发轴回传重试前置——已成功侧（synced/noop_needed 终态）不重做。 */
export function assertActualAxisRetryable(input: {
  orderStatus: PlStatus
  currentStatus: ActualAxisSyncStatus | null
}): { skipped: boolean } {
  if (input.orderStatus !== 'shipped') {
    throw new ShippingRuleViolation('IF-06', `实发轴同步仅已出库发货单参与（当前 ${input.orderStatus}）`)
  }
  if (input.currentStatus === 'synced' || input.currentStatus === 'noop_needed') {
    return { skipped: true } // 重试不重做已成功侧
  }
  return { skipped: false }
}

/** IF-07/IF-00.6：发货状态回传重试前置——仅已出库；已成功侧不重做；载荷固化时点快照不可改推当前值。 */
export function assertStatusSyncRetryable(input: {
  orderStatus: PlStatus
  currentStatus: ShippingStatusSyncStatus | null
  snapshotCompletedAt: string | null
  orderCompletedAt: string | null
}): { skipped: boolean } {
  if (input.orderStatus !== 'shipped') {
    throw new ShippingRuleViolation('IF-07', `发货状态同步仅已出库发货单参与（当前 ${input.orderStatus}）`)
  }
  if (input.currentStatus === 'synced') {
    return { skipped: true } // 重试不重做已成功侧
  }
  if (input.snapshotCompletedAt === null) {
    throw new ShippingRuleViolation('IF-00.6', '回传任务载荷缺失出库完成时点快照，拒绝改推当前值（无快照不重推）')
  }
  if (input.orderCompletedAt !== null && input.snapshotCompletedAt !== input.orderCompletedAt) {
    throw new ShippingRuleViolation(
      'IF-00.6',
      `载荷固化时点快照（${input.snapshotCompletedAt}）与出库完成时间（${input.orderCompletedAt}）不一致：重试按快照重推，不得改推当前值`,
    )
  }
  return { skipped: false }
}
