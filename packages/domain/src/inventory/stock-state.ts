import { InventoryRuleViolation } from './errors'

/**
 * 库存状态轴与存储三分纯规则 —— 对应冻结合同 inventory-trace-core.md §4：IT-02/13/14/16。
 */

/**
 * IT-13：库存状态轴五值（在库/在制/在途/已发运/已耗尽）。
 * 预留、隔离、任务占用**不并入**状态轴、另记（预留见 reservation 表；隔离/任务占用后续域合同）。
 */
export const STOCK_STATUS_AXIS = [
  'in_stock',
  'in_production',
  'in_transit',
  'shipped',
  'exhausted',
] as const
export type StockStatusAxis = (typeof STOCK_STATUS_AXIS)[number]

/** IT-14：余额质量条件四值（可用量只由合格余额形成；待检/不合格/存疑不得进入可用量、不得发运）。 */
export const QUALITY_STATUSES = [
  'qualified',
  'pending_inspection',
  'unqualified',
  'suspect',
] as const
export type QualityStatus = (typeof QUALITY_STATUSES)[number]

/** IT-14：质量条件是否放行进入可用量。 */
export function isQualityAvailable(status: QualityStatus): boolean {
  return status === 'qualified'
}

/**
 * IT-16：原库存状态字典 6 值（正常/报废/冻结/待检/外发/不合格）与五状态轴＋预留/隔离的映射表
 * 未定义（GAP-A7）。裁定前两套口径**并存标注、不混写**：legacy 值只存快照列，不参与可用量计算；
 * 下方仅为已知无争议的子集映射（供展示提示），完整映射待裁定。
 */
export const LEGACY_STOCK_STATUS_DICTIONARY = [
  '正常',
  '报废',
  '冻结',
  '待检',
  '外发',
  '不合格',
] as const
export type LegacyStockStatus = (typeof LEGACY_STOCK_STATUS_DICTIONARY)[number]

/** GAP-A7：已知无争议的子集映射（待检/不合格 → 质量条件）；其余不映射。 */
export const KNOWN_LEGACY_TO_QUALITY_MAP: Readonly<Partial<Record<LegacyStockStatus, QualityStatus>>> = {
  待检: 'pending_inspection',
  不合格: 'unqualified',
}

/** IT-02：三分存储（法律/业务所有者、保管工厂、所在库位）缺一不可。 */
export interface StorageTriplet {
  ownerId: string
  ownerName: string
  custodianPlantId: string
  locationId: string
  locationCode: string
  /** 客供料沿用实际所有者（不因保管方变更所有权） */
  isCustomerSupplied?: boolean
}

/** IT-02：余额/流水写路径的三分存储完整性校验。 */
export function assertStorageTriplet(triplet: StorageTriplet): void {
  if (!triplet.ownerId || !triplet.ownerName) {
    throw new InventoryRuleViolation('IT-02', '库存的法律/业务所有者不得为空（客供料沿用实际所有者）')
  }
  if (!triplet.custodianPlantId) {
    throw new InventoryRuleViolation('IT-02', '库存的保管工厂不得为空')
  }
  if (!triplet.locationId || !triplet.locationCode) {
    throw new InventoryRuleViolation('IT-02', '库存的所在库位不得为空')
  }
}

/** IT-02：载具借出/回收/损坏/报废独立记录（状态流转 + 审计），不作产品退货处理。 */
export const CARRIER_LIFECYCLE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  in_service: ['lent_out', 'damaged', 'scrapped'],
  lent_out: ['returned', 'damaged', 'scrapped'],
  returned: ['in_service', 'damaged', 'scrapped'],
  damaged: ['scrapped'],
  scrapped: [],
}

/** IT-02：载具状态流转合法性（借出/回收/损坏/报废走载具记录，不产生库存退货流水）。 */
export function assertCarrierTransition(from: string, to: string): void {
  const allowed = CARRIER_LIFECYCLE_TRANSITIONS[from]
  if (!allowed || !allowed.includes(to)) {
    throw new InventoryRuleViolation(
      'IT-02',
      `载具状态流转不合法：${from} → ${to}（借出/回收/损坏/报废独立记录，不作产品退货处理）`,
    )
  }
}
