import { MasterDataRuleViolation } from './errors'

/**
 * 主数据通用规则 —— 对应冻结合同 master-data.md §5：MD-34～MD-37。
 */

/**
 * MD-34：每个主数据字段明确唯一主系统（字段主权清单）；
 * 无主权字段不得双端可写。本表为主权清单的落库声明（sync=U9/ERP，local=本系统）。
 */
export const FIELD_SOVEREIGNTY: Readonly<Record<string, Readonly<Record<string, 'U9' | 'LOCAL'>>>> = {
  material: {
    // MD-01/02：料品主表全部业务字段（含是否质检）主权在 U9；本系统仅读
    master: 'U9',
    // MD-01：换算行为本系统唯一可编辑部分（主权 LOCAL）
    conversion: 'LOCAL',
  },
  uom: {
    // MD-08 GAP-A6 未裁定：主计量单位主权暂记 U9（不冒充已裁定）
    base: 'U9',
    // MD-06：自定义包装单位由 PDA 收货创建（主权 LOCAL）
    custom: 'LOCAL',
  },
  equipment: { master: 'LOCAL' },
  work_center: { master: 'LOCAL' },
  warehouse: { master: 'LOCAL' },
  storage_location: { master: 'LOCAL' },
  rack: { master: 'LOCAL' },
}

/**
 * MD-35：被引用的主数据资料失效或被新版本替代时，不级联删除业务历史；
 * 历史对象引用快照。实现口径：retire 仅改状态列，业务表引用的 id 保持可解析
 * （行仍在，历史对象不重指、不清理）。
 */
export const RETIRE_KEEPS_HISTORY = true as const

/** MD-36：主数据删除一律为逻辑删除——状态列 active/retired＋partial unique（where active）＋deleted_at。 */
export const MASTERDATA_STATUS = { ACTIVE: 'active', RETIRED: 'retired' } as const

export type MasterDataStatusValue = (typeof MASTERDATA_STATUS)[keyof typeof MASTERDATA_STATUS]

/** MD-36：retire 落库口径——同时写状态列与 deleted_at（不删行）。 */
export function retirePatch(now: Date): { status: 'retired'; deletedAt: Date } {
  return { status: MASTERDATA_STATUS.RETIRED as 'retired', deletedAt: now }
}

/**
 * MD-37：主数据引用保护——被库存余额或库存流水引用的主数据拒绝退役（retire 也拒绝）。
 * FK ON DELETE RESTRICT 由迁移落库（MD-S7）；此处为命令层退役前置。
 */
export interface StockReferenceFacts {
  stockBalanceRefs: number
  stockTransactionRefs: number
}

export function assertNotStockReferenced(facts: StockReferenceFacts): void {
  if (facts.stockBalanceRefs > 0 || facts.stockTransactionRefs > 0) {
    throw new MasterDataRuleViolation(
      'MD-37',
      '主数据已被库存余额或库存流水引用，拒绝退役',
    )
  }
}
