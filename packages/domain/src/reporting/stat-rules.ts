import type { DecimalString } from '@cadenza/contracts'
import { ReportingRuleViolation } from './errors'
import { addScaled, fromScaledInt, toScaledInt } from './decimal-math'

/**
 * 库存统计纯规则（RP-01~RP-05；原件 库存统计/库存统计.md 汇总口径与展示交互）。
 */

// ---------------- 状态字典（RP-02：两套口径并存标注、不混写，映射 GAP-A7 待裁） ----------------

/** 原库存状态字典 6 值（IT-16 legacy 口径；业务侧写入 stock_balance.legacy_status）。 */
export const LEGACY_STOCK_STATUS_LABELS: Readonly<Record<string, string>> = {
  normal: '正常',
  scrap: '报废',
  frozen: '冻结',
  pending_inspection: '待检',
  external: '外发',
  unqualified: '不合格',
}

/** 五状态轴（IT-13 权威口径；与 legacy 并存展示，不互相混写）。 */
export const AXIS_STATUS_LABELS: Readonly<Record<string, string>> = {
  in_stock: '在库',
  in_production: '在制',
  in_transit: '在途',
  shipped: '已发运',
  exhausted: '已耗尽',
}

// ---------------- 成品入库状态推导（RP-04） ----------------

export type FinishedEntryStatus = 'entered_warehouse' | 'not_entered' | null

/**
 * RP-04：库存状态=正常 且 报工仓库类型=仓库 → 成品已入库；
 * 库存状态=正常 且 报工仓库类型=线边仓 → 成品未入库；其余为空。
 */
export function deriveFinishedEntryStatus(
  stockStatus: string | null | undefined,
  reportWarehouseKind: 'WAREHOUSE' | 'LINE_SIDE' | null | undefined,
): FinishedEntryStatus {
  if (stockStatus !== 'normal') return null
  if (reportWarehouseKind === 'WAREHOUSE') return 'entered_warehouse'
  if (reportWarehouseKind === 'LINE_SIDE') return 'not_entered'
  return null
}

export const FINISHED_ENTRY_LABELS: Readonly<Record<string, string>> = {
  entered_warehouse: '成品已入库',
  not_entered: '成品未入库',
}

/**
 * RP-04 后半（按成品入库状态筛选的语义）：筛选值=成品已入库 → 行须 库存状态=正常 且 报工仓库类型=仓库；
 * 筛选值=成品未入库 → 行须 库存状态=正常 且 报工仓库类型=线边仓；其余行不入选。
 */
export function matchesFinishedEntryFilter(
  filter: 'entered_warehouse' | 'not_entered',
  stockStatus: string | null | undefined,
  reportWarehouseKind: 'WAREHOUSE' | 'LINE_SIDE' | null | undefined,
): boolean {
  return deriveFinishedEntryStatus(stockStatus, reportWarehouseKind) === filter
}

// ---------------- 汇总口径（RP-01） ----------------

export type StockStatKind = 'purchase_receive' | 'production'

export interface PurchaseGroupKey {
  kind: 'purchase_receive'
  /** 华通轴号 */
  unitNo: string
  /** 入库批次号 */
  lotNo: string
  /** 厂家批次 */
  supplierLotNo: string | null
  /** 牌号/线径（料品编码） */
  materialCode: string
}

export interface ProductionGroupKey {
  kind: 'production'
  /** 华通轴号 */
  unitNo: string
  /** 订单（生产单号） */
  orderNo: string
  /** 订单工序（有则） */
  operationSeq: number | null
}

/** RP-01 汇总键形状断言：两类键字段齐全（缺失抛 [RP-01]），列表不做二次聚合。 */
export function assertGroupKeyShape(key: PurchaseGroupKey | ProductionGroupKey): void {
  if (key.kind === 'purchase_receive') {
    if (key.unitNo === '' || key.lotNo === '' || key.materialCode === '') {
      throw new ReportingRuleViolation(
        'RP-01',
        '采购收货码汇总键不完整（华通轴号+入库批次号+厂家批次+牌号/线径）',
      )
    }
    return
  }
  if (key.unitNo === '' || key.orderNo === '') {
    throw new ReportingRuleViolation('RP-01', '生产码汇总键不完整（华通轴号+订单+（有则）订单工序）')
  }
}

// ---------------- 勾选汇总（RP-05；服务端全量聚合，不依赖已加载分页） ----------------

export interface SelectableQtyRow {
  quantity: DecimalString | null
  uomCode: string | null | undefined
}

export interface SelectionSummaryGroup {
  /** 基本单位；null=未知单位（RP-05：无单位记"未知单位"） */
  uomCode: string | null
  uomLabel: string
  /** 分组累加，保留 4 位小数 */
  totalQuantity: DecimalString
}

export interface SelectionSummary {
  groups: SelectionSummaryGroup[]
  /** 总件数 = 勾选行数（RP-05）；未勾选时总量为 0 */
  totalRows: number
}

const UNKNOWN_UOM_LABEL = '未知单位'

/**
 * RP-05 勾选汇总纯函数：总量按勾选行基本单位分组累加（4 位小数）、无单位记"未知单位"；
 * 总件数 = 勾选行数；未勾选（空集）时总量为 0。
 * 服务端对全量行执行（PC-16/K16：不依赖已加载分页）。
 */
export function summarizeSelection(rows: readonly SelectableQtyRow[]): SelectionSummary {
  const buckets = new Map<string | null, bigint>()
  for (const row of rows) {
    const uom = row.uomCode === null || row.uomCode === undefined || row.uomCode === '' ? null : row.uomCode
    const scaled = row.quantity === null ? 0n : toScaledInt(row.quantity)
    buckets.set(uom, addScaled(buckets.get(uom) ?? 0n, scaled))
  }
  if (buckets.size === 0) {
    return { groups: [], totalRows: 0 }
  }
  const groups = [...buckets.entries()].map(([uom, scaled]) => ({
    uomCode: uom,
    uomLabel: uom ?? UNKNOWN_UOM_LABEL,
    totalQuantity: fromScaledInt(scaled),
  }))
  // 展示稳定序：有单位按编码排序，未知单位排末尾
  groups.sort((a, b) => {
    if (a.uomCode === null && b.uomCode === null) return 0
    if (a.uomCode === null) return 1
    if (b.uomCode === null) return -1
    return a.uomCode.localeCompare(b.uomCode)
  })
  return { groups, totalRows: rows.length }
}
