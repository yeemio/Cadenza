// 包内上级目录相对导入（domain/src/reverse → domain/src/inventory）：未逃逸出 domain 包，
// 边界规则对包内子目录场景过宽（同 reporting/metric-rules.ts、trace/genealogy.ts 先例）；单行豁免留痕。
// eslint-disable-next-line no-restricted-imports
import { cmpQty } from '../inventory/quantity'
import { ReverseRuleViolation } from './errors'

/**
 * 客户所有物三分与载具借还纯规则 —— 冻结合同 frozen/p2/warehouse-reverse.md §6
 * （WR-26～WR-28，**[合同新造]**，DM 显式补充、无原件；IT-01/02/20）。
 */

// ---------------- WR-26 所有权三分 ----------------

/**
 * WR-26：所有权三分——法律/业务所有者、保管工厂、所在库位分开存储（余额唯一键含 owner，IT-20）；
 * 客供料、寄存物、客户轴盘沿用实际所有者；保管位置变更不改变所有权。
 */
export function assertOwnershipTransferExecutable(input: {
  unitNo: string
  fromOwnerId: string
  toOwnerId: string
  fromLocationId: string
  toLocationId: string
  quantity: string
}): void {
  if (input.fromOwnerId === input.toOwnerId) {
    throw new ReverseRuleViolation('WR-26', `单元 ${input.unitNo}所有权变更前后所有者相同（${input.fromOwnerId}），拒绝空变更`)
  }
  if (input.fromLocationId !== input.toLocationId) {
    throw new ReverseRuleViolation(
      'WR-26',
      `单元 ${input.unitNo}所有权变更不得同时变更保管库位（所有者与库位分开变更；位置变更走移库且不移所有权）`,
    )
  }
  if (cmpQty(input.quantity, '0.0000') <= 0) {
    throw new ReverseRuleViolation('WR-26', `单元 ${input.unitNo}所有权变更数量必须为正`)
  }
}

/**
 * WR-26：保管位置变更不改变所有权——移库/上架等位置变更命令的所有者不变式
 * （from_owner = to_owner；违反即合同违例）。
 */
export function assertOwnershipPreservedOnLocationChange(input: {
  unitNo: string
  fromOwnerId: string
  toOwnerId: string
}): void {
  if (input.fromOwnerId !== input.toOwnerId) {
    throw new ReverseRuleViolation(
      'WR-26',
      `单元 ${input.unitNo}位置变更不得改变所有权（from=${input.fromOwnerId}、to=${input.toOwnerId}）：所有权变更走独立命令并留痕`,
    )
  }
}

// ---------------- WR-27 载具借还 ----------------

/** 载具借还事件（append-only：借出/回收/损坏/报废独立记录，不作产品退货处理）。 */
export const CARRIER_LOAN_EVENTS = ['lend', 'take_back', 'damage', 'scrap'] as const
export type CarrierLoanEventKind = (typeof CARRIER_LOAN_EVENTS)[number]

export const CARRIER_LOAN_EVENT_LABELS: Readonly<Record<CarrierLoanEventKind, string>> = {
  lend: '借出',
  take_back: '回收',
  damage: '损坏',
  scrap: '报废',
}

/** WR-27：载具事件前置（状态轴 0004 carrier.status：in_service/lent_out/returned/damaged/scrapped）。 */
export function assertCarrierLoanEventExecutable(input: {
  carrierCode: string
  eventKind: CarrierLoanEventKind
  currentStatus: string
  counterparty: string | undefined
}): void {
  const required: Readonly<Record<CarrierLoanEventKind, readonly string[]>> = {
    lend: ['in_service', 'returned'],
    take_back: ['lent_out'],
    damage: ['in_service', 'lent_out', 'returned'],
    scrap: ['in_service', 'lent_out', 'returned', 'damaged'],
  }
  if (!required[input.eventKind].includes(input.currentStatus)) {
    throw new ReverseRuleViolation(
      'WR-27',
      `载具 ${input.carrierCode}当前状态 ${input.currentStatus} 不可执行「${CARRIER_LOAN_EVENT_LABELS[input.eventKind]}」（允许自 ${required[input.eventKind].join('/')}）`,
    )
  }
  if (input.eventKind === 'lend' && (input.counterparty ?? '').trim() === '') {
    throw new ReverseRuleViolation('WR-27', `载具 ${input.carrierCode}借出必须登记借予对象（counterparty）`)
  }
}

/** WR-27：借出期间载具不计入本厂可用载具（损坏/报废同理不计入）。 */
export function isCarrierAvailableForPlant(status: string): boolean {
  return status === 'in_service' || status === 'returned'
}

/** WR-27：借还事件 append-only——纠正走新事件行（结构约束：无 UPDATE/DELETE 通道）。 */
export const CARRIER_LOAN_APPEND_ONLY = true

// ---------------- WR-28 客户退货边界 ----------------

/**
 * WR-28：客户退货边界——发运后回退（客户退货）是否入 P2 范围 → GAP-F12 待裁；
 * 裁定前**不建客户退货命令**，本域「退货」仅指采购批次退货（WR-20）。
 * （守卫：任何试图以本域命令面承载客户退货的载荷键在此显式拒绝。）
 */
export const CUSTOMER_RETURN_FORBIDDEN_KEYS: readonly string[] = [
  'customerReturn',
  'customer_return',
  'salesReturnOrderNo',
]

export function assertNotCustomerReturnPayload(payload: Record<string, unknown>): void {
  for (const key of CUSTOMER_RETURN_FORBIDDEN_KEYS) {
    if (payload[key] !== undefined) {
      throw new ReverseRuleViolation(
        'WR-28',
        `客户退货（发运后回退）范围未裁定（GAP-F12）：本域「退货」仅指采购批次退货（WR-20），不承载客户退货命令`,
      )
    }
  }
}
