import { ShippingRuleViolation } from './errors'

/**
 * PL（发货单）与备货三类行纯规则 —— 规则底稿 04 §A-T14-1/2/3
 * （原件 成品出库/成品出库.md §1.1/§3.4；冻结合同 interfaces.md IF-05/IF-04）。
 *
 * PL 外部下发禁手工新增：本域不存在任何"手工创建 PL"命令面（shipping.pl.inbound 为
 * 模拟入站通道，语义=外部下发落库，非 MES 手工新增）；库层无手工 INSERT 通道以外入口。
 */

/** A-T14-1：PL 状态机——待装箱→待出库→已出库（下发即待装箱；单向不可逆）。 */
export const PL_STATUS_FLOW = ['pending_packing', 'ready_to_ship', 'shipped'] as const
export type PlStatus = (typeof PL_STATUS_FLOW)[number]

/** A-T14-10：状态机步进合法性（待装箱→待出库→已出库；无回退分支——删码退回由行进度重推）。 */
export function assertPlStep(from: PlStatus, to: PlStatus): void {
  if (from === to) return // 幂等重放场景由命令总线承担
  const allowed: Readonly<Record<PlStatus, readonly PlStatus[]>> = {
    pending_packing: ['ready_to_ship'],
    ready_to_ship: ['shipped'],
    shipped: [],
  }
  if (!allowed[from].includes(to)) {
    throw new ShippingRuleViolation('A-T14-1', `PL 状态机步进非法：${from} → ${to}（待装箱→待出库→已出库）`)
  }
}

/** A-T14-1：PL 行状态（行扫满→已装箱；删码不满足退回待装箱）。 */
export const PL_LINE_STATUSES = ['pending_packing', 'packed'] as const
export type PlLineStatus = (typeof PL_LINE_STATUSES)[number]

/** A-T14-3：备货三类行——托盘行 / 有轴单品 / 无轴单品。 */
export const SHIPMENT_LINE_KINDS = ['pallet', 'axis_item', 'plain_item'] as const
export type ShipmentLineKind = (typeof SHIPMENT_LINE_KINDS)[number]

/** IF-06：实发轴同步四态（待同步/已同步/同步失败/无需同步——"无需同步"不是失败态）。 */
export const ACTUAL_AXIS_SYNC_STATUSES = ['pending', 'synced', 'sync_failed', 'noop_needed'] as const
export type ActualAxisSyncStatus = (typeof ACTUAL_AXIS_SYNC_STATUSES)[number]

/** IF-07：发货状态同步独立三态（与实发轴同步互不改变对方状态）。 */
export const SHIPPING_STATUS_SYNC_STATUSES = ['pending', 'synced', 'sync_failed'] as const
export type ShippingStatusSyncStatus = (typeof SHIPPING_STATUS_SYNC_STATUSES)[number]

/** 十进制定点（≤4 位小数；IT-07 口径随行的本域内联校验）。 */
const DECIMAL_RE = /^\d+(\.\d{1,4})?$/
export function isSegmentLengthString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_RE.test(value)
}

function isPositiveDecimal(value: string): boolean {
  return isSegmentLengthString(value) && Number(value) > 0
}

const SHIPMENT_LINE_MATERIAL_RE = /^.+$/

/** 备货行规格输入（A-T14-3：三类行各自必填字段族）。 */
export interface ShipmentLineSpec {
  lineNo: number
  lineKind: ShipmentLineKind
  materialCode: string
  salesOrderLineNo: string
  /** 托盘行：总轴数（=应扫数）；有轴单品：1；无轴单品：件数（=应扫数）。 */
  requiredCount: number
  /** 有轴单品：客户轴号。 */
  customerAxisNo?: string | null
  /** 有轴单品：标准段长（订单下达快照，非实时 DC）。 */
  standardSegmentLength?: string | null
  /** 无轴单品：段长。 */
  segmentLength?: string | null
}

/**
 * A-T14-3：备货三类行规格断言——
 * 托盘行：打包状态+已扫/总轴数（总轴数≥1）；
 * 有轴单品：客户轴号+标准段长必填（实际段长扫码时补记）；
 * 无轴单品：段长+件数必填、无客户轴号。
 */
export function assertShipmentLineSpec(line: ShipmentLineSpec): void {
  if (!SHIPMENT_LINE_MATERIAL_RE.test(line.materialCode)) {
    throw new ShippingRuleViolation('A-T14-3', `第 ${line.lineNo} 行缺少料品编码`)
  }
  if (line.salesOrderLineNo.trim() === '') {
    throw new ShippingRuleViolation('A-T14-3', `第 ${line.lineNo} 行缺少关联销售订单行号（未关联销售订单行的行不可备货）`)
  }
  if (!Number.isInteger(line.requiredCount) || line.requiredCount < 1) {
    throw new ShippingRuleViolation('A-T14-3', `第 ${line.lineNo} 行应扫数必须为正整数`)
  }
  switch (line.lineKind) {
    case 'pallet':
      if (line.customerAxisNo !== undefined && line.customerAxisNo !== null) {
        throw new ShippingRuleViolation('A-T14-3', `第 ${line.lineNo} 行为托盘行（打包状态+已扫/总轴数），不携带客户轴号`)
      }
      break
    case 'axis_item': {
      if (line.requiredCount !== 1) {
        throw new ShippingRuleViolation('A-T14-3', `第 ${line.lineNo} 行为有轴单品（客户轴号+标准/实际段长），应扫数固定为 1`)
      }
      if (line.customerAxisNo === undefined || line.customerAxisNo === null || line.customerAxisNo.trim() === '') {
        throw new ShippingRuleViolation('A-T14-3', `第 ${line.lineNo} 行为有轴单品，缺少客户轴号`)
      }
      if (!isPositiveDecimal(line.standardSegmentLength ?? '')) {
        throw new ShippingRuleViolation(
          'A-T14-3',
          `第 ${line.lineNo} 行为有轴单品，缺少标准段长（正十进制定点、≤4 位小数）`,
        )
      }
      if (line.segmentLength !== undefined && line.segmentLength !== null) {
        throw new ShippingRuleViolation('A-T14-3', `第 ${line.lineNo} 行为有轴单品，段长记于 standard/actual 两列，不落无轴段长列`)
      }
      break
    }
    case 'plain_item': {
      if (line.customerAxisNo !== undefined && line.customerAxisNo !== null) {
        throw new ShippingRuleViolation('A-T14-3', `第 ${line.lineNo} 行为无轴单品（段长×件数、无客户轴号）`)
      }
      // 段长快照可缺（缺组成数据入站标黄 compositionMissing；扫码装入时"无段长拒收"兜底）
      if (line.segmentLength !== undefined && line.segmentLength !== null && !isPositiveDecimal(line.segmentLength)) {
        throw new ShippingRuleViolation('A-T14-3', `第 ${line.lineNo} 行为无轴单品，段长须为正十进制定点（≤4 位小数）`)
      }
      break
    }
    default:
      throw new ShippingRuleViolation('A-T14-3', `第 ${line.lineNo} 行类型非法（pallet/axis_item/plain_item）`)
  }
}

/** A-T14-3/IF-05：PL 至少一行；行号唯一递增。 */
export function assertPlLinesShape(lines: readonly ShipmentLineSpec[]): void {
  if (lines.length === 0) {
    throw new ShippingRuleViolation('A-T14-1', 'PL 载荷至少包含一行备货行（三类行之一）')
  }
  const seen = new Set<number>()
  for (const line of lines) {
    if (seen.has(line.lineNo)) {
      throw new ShippingRuleViolation('A-T14-1', `行号 ${line.lineNo} 重复`)
    }
    seen.add(line.lineNo)
    assertShipmentLineSpec(line)
  }
}

/**
 * A-T14 依赖 T05（底稿 D 节）：客户轴号/段长匹配按订单下达时的分段快照——shipment_line
 * 的 customer_axis_no/standard_segment_length/segment_length 快照列在 PL 入站时固化，
 * DC 后续重推不改变既有行快照；实发轴号与快照客户轴号的差异不拒绝装入（该差异恰是
 * IF-06 实发轴同步的存在理由），仅进入差异判定（ship-rules.resolveActualAxisSyncDecision）。
 */
export function readLineSnapshotSegment(input: {
  lineKind: ShipmentLineKind
  standardSegmentLength: string | null
  segmentLength: string | null
}): string | null {
  if (input.lineKind === 'axis_item') return input.standardSegmentLength
  if (input.lineKind === 'plain_item') return input.segmentLength
  return null // 托盘行：无单值段长（逐轴轴明细属 DC 组成数据）
}
