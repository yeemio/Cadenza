import { WarehousingRuleViolation } from './errors'
import type { WarehouseKind } from './putaway-rules'

/**
 * 调拨规则纯规则 —— 规则底稿 04 §A-T13-5/6/8/9/10/11（原件 调拨出库/调拨入库；
 * DM §5 跨厂收货需接收方事实、DM §6 每步原子化两段事务）。
 */

/** 调拨种类（A-T13-5：Web 有任务（生产调拨/仓库调拨）、其它模块自动生成）。 */
export const TRANSFER_KINDS = ['production', 'warehouse', 'auto'] as const
export type TransferKind = (typeof TRANSFER_KINDS)[number]

/**
 * A-T13-10：调拨状态机——草稿→待执行→出库中→已出库在途→收货中→完成
 * （DM §5：跨厂收货需接收方事实；作废独立分支）。
 */
export const TRANSFER_STATUS_FLOW = [
  'draft',
  'ready',
  'shipping',
  'shipped_in_transit',
  'receiving',
  'completed',
] as const
export type TransferStatus = (typeof TRANSFER_STATUS_FLOW)[number] | 'cancelled'

/** A-T13-10：状态机步进合法性（状态机只能按序步进；cancelled 由草稿/待执行进入）。 */
export function assertTransferStep(from: TransferStatus, to: TransferStatus): void {
  if (from === to) return // 幂等重放场景由命令总线承担，此处不重复断言
  const allowed: Readonly<Record<TransferStatus, readonly TransferStatus[]>> = {
    draft: ['ready', 'cancelled'],
    ready: ['shipping', 'cancelled'],
    shipping: ['shipped_in_transit'],
    shipped_in_transit: ['receiving'],
    receiving: ['completed'],
    completed: [],
    cancelled: [],
  }
  if (!allowed[from].includes(to)) {
    throw new WarehousingRuleViolation(
      'A-T13-10',
      `调拨状态机步进非法：${from} → ${to}（草稿→待执行→出库中→已出库在途→收货中→完成）`,
    )
  }
}

/** 调拨行两段事实状态（A-T13-10：每步原子化=来源减+在途增 / 在途减+目的增 两段独立）。 */
export interface TransferLineFacts {
  lineNo: number
  plannedQty: string
  outQty: string
  inQty: string
  outDone: boolean
  inDone: boolean
}

/** A-T13-8：完成出库后行推进——部分数量调出的原码回写剩余并解锁（outQty<planned 时剩余留原码）。 */
export function assertShipQtyWithinLine(input: { plannedQty: string; outQty: string; numericCompare: number }): void {
  if (input.numericCompare > 0) {
    throw new WarehousingRuleViolation(
      'A-T13-8',
      `调拨出库量超过行计划量（行 ${input.plannedQty}、本次累计 ${input.outQty}），拒绝`,
    )
  }
}

/** A-T13-9：调拨入库完成条件——每料品已入库 ≥ 待入库且至少一码（行级口径：全部行 in_done）。 */
export function assertReceiveCompletable(lines: readonly TransferLineFacts[]): boolean {
  return lines.length > 0 && lines.every((l) => l.inDone)
}

/**
 * A-T13-6：调拨仓库规则——
 * ①调入 ≠ 调出；②调出=线边仓时调入只能线边仓；③生产调拨调入只能线边仓且料限原材料/半成品。
 */
export function assertTransferWarehouses(input: {
  transferKind: string
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseKind: string
  toWarehouseKind: string
  lineMaterialTypes: readonly (number | null)[]
}): void {
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw new WarehousingRuleViolation('A-T13-6', '调入仓库不得等于调出仓库')
  }
  if (input.fromWarehouseKind === 'LINE_SIDE' && input.toWarehouseKind !== 'LINE_SIDE') {
    throw new WarehousingRuleViolation(
      'A-T13-6',
      `调出仓库为线边仓时，调入仓库只能为线边仓（当前调入 ${input.toWarehouseKind}）`,
    )
  }
  if (input.transferKind === 'production') {
    if (input.toWarehouseKind !== 'LINE_SIDE') {
      throw new WarehousingRuleViolation(
        'A-T13-6',
        `生产调拨的调入仓库只能为线边仓（当前 ${input.toWarehouseKind}）`,
      )
    }
    const illegal = input.lineMaterialTypes.filter((t) => t !== null && t !== 1 && t !== 2)
    if (illegal.length > 0) {
      throw new WarehousingRuleViolation(
        'A-T13-6',
        `生产调拨的料品仅限原材料/半成品（料品类型 ${[...new Set(illegal)].join('/')} 不在允许范围）`,
      )
    }
  }
}

/**
 * A-T13-7：出库扫码校验（命令层事实收集后调用）——在库、质检参数闸门（quality 域承担）、
 * 未被其它业务锁定、剩余数量>0、仓库匹配、仓库未锁定/禁用。
 */
export function assertTransferOutboundExecutable(input: {
  unitNo: string
  unitStatus: string
  lockedByOtherTask: boolean
  remainingQtyPositive: boolean
  warehouseMatch: boolean
  warehouseLocked: boolean
}): void {
  if (input.unitStatus !== 'in_stock') {
    throw new WarehousingRuleViolation('A-T13-7', `单元 ${input.unitNo}库存状态为 ${input.unitStatus}，仅在库码可调拨出库`)
  }
  if (input.lockedByOtherTask) {
    throw new WarehousingRuleViolation('A-T13-7', `单元 ${input.unitNo}已被其它业务锁定，禁止调拨出库`)
  }
  if (!input.remainingQtyPositive) {
    throw new WarehousingRuleViolation('A-T13-7', `单元 ${input.unitNo}剩余数量不足（剩余数量须 > 0）`)
  }
  if (!input.warehouseMatch) {
    throw new WarehousingRuleViolation('A-T13-7', `单元 ${input.unitNo}不在调出仓库（仓库匹配校验失败）`)
  }
  if (input.warehouseLocked) {
    throw new WarehousingRuleViolation('A-T13-7', '调出仓库处于锁定/禁用状态，禁止调拨出库')
  }
}

/**
 * A-T13-11 + IT-23：锁定=作业预留——调拨锁定必须含有效期（valid_until）；
 * 过期后旧终端提交必须重新校验（不得凭过期锁定直接出库/接收）。
 * （与 inventory 域 reservation-rules 同构；本域独立断言避免跨目录引用。）
 */
export function assertTransferLockEffective(input: {
  reservationId: string
  status: string
  validUntil: string
  now: string
  action?: string
}): void {
  if (input.status !== 'active') {
    throw new WarehousingRuleViolation(
      'A-T13-11',
      `调拨锁定 ${input.reservationId}已处于 ${input.status} 状态：锁定=作业预留，失效后须重新锁定`,
    )
  }
  const until = Date.parse(input.validUntil)
  const nowMs = Date.parse(input.now)
  if (Number.isNaN(until) || until < nowMs) {
    throw new WarehousingRuleViolation(
      'A-T13-11',
      `调拨锁定 ${input.reservationId}已过有效期（${input.validUntil}）：${input.action ?? '提交'}须重新校验/重新锁定，不得凭过期锁定直接入账`,
    )
  }
}

/** A-T13-11：锁定有效期必须晚于当前时间（不得签发即时过期锁定）。 */
export function assertTransferLockIssuable(input: { validUntil: string | null | undefined; now: string }): void {
  const until = Date.parse(input.validUntil ?? '')
  if (input.validUntil === null || input.validUntil === undefined || Number.isNaN(until)) {
    throw new WarehousingRuleViolation('A-T13-11', '调拨锁定（作业预留）必须含有效期（valid_until，ISO-8601）')
  }
  if (until <= Date.parse(input.now)) {
    throw new WarehousingRuleViolation('A-T13-11', '调拨锁定有效期必须晚于当前时间（不得签发即时过期锁定）')
  }
}

/**
 * A-T13-10：在途两仓不重复统计——调拨在途量只挂专用在途库位（transit location）；
 * 调出仓普通库位只保留「部分调出回写剩余」，调入仓普通库位在接收前不得出现该调拨量。
 * 对账事实由命令层查询后传入（测试证据⑤：三仓位合计对账）。
 */
export function assertTransitNotDoubleCounted(input: {
  transitQty: string
  expectedTransitQty: string
  fromWarehouseNormalQty: string
  expectedFromRemainQty: string
  toWarehouseNormalQty: string
}): void {
  if (input.transitQty !== input.expectedTransitQty) {
    throw new WarehousingRuleViolation(
      'A-T13-10',
      `在途对账不平：在途库位挂账 ${input.transitQty} ≠ 应挂 ${input.expectedTransitQty}（在途量必须只挂专用在途库位）`,
    )
  }
  if (input.fromWarehouseNormalQty !== input.expectedFromRemainQty) {
    throw new WarehousingRuleViolation(
      'A-T13-10',
      `调出仓重复统计：调出仓普通库位挂账 ${input.fromWarehouseNormalQty} ≠ 应留剩余 ${input.expectedFromRemainQty}（部分调出回写剩余、其余在途）`,
    )
  }
  if (input.toWarehouseNormalQty !== '0.0000') {
    throw new WarehousingRuleViolation(
      'A-T13-10',
      `调入仓重复统计：调入仓普通库位在接收前不得出现该调拨量（当前 ${input.toWarehouseNormalQty}）`,
    )
  }
}

/** 线边仓判定辅助（A-T13-6 域内字典对齐 putaway-rules WAREHOUSE_KINDS）。 */
export function isLineSideWarehouse(kind: string): kind is WarehouseKind {
  return kind === 'LINE_SIDE'
}
