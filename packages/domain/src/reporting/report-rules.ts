import type { DecimalString } from '@cadenza/contracts'
import { addScaled, fromScaledInt, toScaledInt } from './decimal-math'

/**
 * 报工记录汇总口径纯规则（RP-12~RP-17；主链归 T10，本域只冻汇总口径）。
 */

// ---------------- 口径分层（RP-16） ----------------

/**
 * 报工五量口径分层（S02）：草稿/提交/审核/合格/入库各自有口径，逐口径展示，不混成一个完成量。
 */
export const REPORT_CALIBERS = ['draft', 'submitted', 'approved', 'qualified', 'stocked'] as const
export type ReportCaliber = (typeof REPORT_CALIBERS)[number]

export interface ReportCaliberRow {
  /** 报工单状态轴：draft | submitted | deleted（K17 删除留痕不入任何完成口径） */
  status: 'draft' | 'submitted' | 'deleted'
  /** 审核轴：pending_review | auto_approved | manual_approved */
  reviewStatus: 'pending_review' | 'auto_approved' | 'manual_approved'
  /** 产出行是否已转库存单元（stocked 口径五量之一，A5-3） */
  stockUnitBound: boolean
}

/** RP-16/RP-13：报工单在某口径下是否计入。deleted 单不入任何口径（留痕不计数）。 */
export function matchesCaliber(row: ReportCaliberRow, caliber: ReportCaliber): boolean {
  if (row.status === 'deleted') return false
  switch (caliber) {
    case 'draft':
      return row.status === 'draft'
    case 'submitted':
      return row.status === 'submitted'
    case 'approved':
      return row.status === 'submitted' && (row.reviewStatus === 'auto_approved' || row.reviewStatus === 'manual_approved')
    case 'qualified':
      // 合格口径：审核通过单的产出行（数量取 qualified_qty，见 pickCaliberQuantity）
      return row.status === 'submitted' && (row.reviewStatus === 'auto_approved' || row.reviewStatus === 'manual_approved')
    case 'stocked':
      return (
        row.status === 'submitted' &&
        (row.reviewStatus === 'auto_approved' || row.reviewStatus === 'manual_approved') &&
        row.stockUnitBound
      )
  }
}

/** RP-16：口径 → 产出行取数列（qualified 口径取合格数量，其余口径取产出数量）。 */
export function pickCaliberQuantity(caliber: ReportCaliber): 'quantity' | 'qualified_qty' {
  return caliber === 'qualified' ? 'qualified_qty' : 'quantity'
}

/** RP-13：PDA 累计报工的独立口径轴（草稿/提交/审核分开统计，不混）。 */
export const PDA_CALIBERS = ['draft', 'submitted', 'approved'] as const
export type PdaCaliber = (typeof PDA_CALIBERS)[number]

/**
 * RP-13 历史导入排除：P1 报工模型无历史导入通道（execution_session.source 仅
 * order/workbench/scan，0008），结构性排除恒成立；本谓词保留显式过滤位，
 * 历史导入通道引入后在此挂判定（届时以来源字段为入参；目标口径：排除历史导入，K16）。
 */
export function isHistoricalImport(): boolean {
  return false
}

// ---------------- Web 汇总行（RP-12） ----------------

export interface ReportOutputQtyRow {
  quantity: DecimalString
  qualifiedQty: DecimalString | null
  uomCode: string
  /** 产品轴号（库存单元号；stock_unit_id 为空的产出行无轴号） */
  unitNo: string | null
}

export interface ReportTotalsGroup {
  uomCode: string
  /** 按生产单位分别求和，4 位小数（RP-12；不同单位不得直接汇总，K08/RP-14） */
  totalQuantity: DecimalString
}

export interface ReportTotals {
  groups: ReportTotalsGroup[]
  /** 报工总轴数 = 勾选行报工轴数之和（RP-12） */
  totalAxisCount: number
}

/**
 * RP-12 Web 汇总行：报工总量按生产单位分别求和（4 位小数，未选显示 0）；
 * 报工轴数 = 每张报工单中不重复产品轴号数，总轴数 = 勾选行之和（服务端全量聚合，RP-17）。
 */
export function summarizeReportTotals(rowsByReport: readonly ReportOutputQtyRow[][]): ReportTotals {
  const buckets = new Map<string, bigint>()
  let totalAxisCount = 0
  for (const outputsOfOneReport of rowsByReport) {
    for (const out of outputsOfOneReport) {
      buckets.set(out.uomCode, addScaled(buckets.get(out.uomCode) ?? 0n, toScaledInt(out.quantity)))
    }
    totalAxisCount += distinctAxisCount(outputsOfOneReport)
  }
  if (buckets.size === 0) {
    return { groups: [], totalAxisCount: 0 } // 未选显示 0（RP-12）
  }
  const groups = [...buckets.entries()]
    .map(([uomCode, scaled]) => ({ uomCode, totalQuantity: fromScaledInt(scaled) }))
    .sort((a, b) => a.uomCode.localeCompare(b.uomCode))
  return { groups, totalAxisCount }
}

/** RP-12：报工轴数 = 报工单中不重复产品轴号数（stock_unit_id 为空的产出行不计轴）。 */
export function distinctAxisCount(outputs: readonly ReportOutputQtyRow[]): number {
  return new Set(outputs.filter((o) => o.unitNo !== null).map((o) => o.unitNo)).size
}
