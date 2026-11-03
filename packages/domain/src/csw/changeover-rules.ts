import { CswRuleViolation } from './errors'
import { assertProductionDateValid, shiftDateDays } from './shared'

/**
 * csw 换型矩阵 / 交期权重 / 求解窗口规则（T22 冻结合同 §3：CS-16/CS-17/CS-18）。
 *
 * [CS-16] 换型矩阵（工序/产品属性维度 → 换型时长）为版本化配置，换型时间计入设备日历占用；
 * 矩阵数据来源须现场工艺提供（原件无换型概念 → GAP-E8）。[CS-S3] 版本化、被引用版本 immutable。
 * [CS-17] 交期权重默认取计划完成时间紧迫度；建议排序默认 交期优先 → 换型最少 → 负荷均衡，
 * 权重可配置并随排程版本留存；权重取值 → GAP-E11。[CS-18] 有限能力计算窗口为当日起至多 N 个
 * 生产日（默认 7，可配置）；窗口外任务不参与优化、仅列示。
 */

/** 换型矩阵维度：工序 / 产品属性。 */
export type ChangeoverDimensionKind = 'operation' | 'product_attribute'

export const CHANGEOVER_DIMENSION_VALUES: readonly ChangeoverDimensionKind[] = [
  'operation',
  'product_attribute',
]

/** [CS-16] 换型矩阵条目：维度键对（前值 → 后值）→ 换型时长（分钟）。 */
export interface ChangeoverEntry {
  fromValue: string
  toValue: string
  minutes: number
}

/** 换型矩阵版本视图（append-only 版本行；活动版本＝同厂最大 versionNo）。 */
export interface ChangeoverMatrixView {
  id: string
  plantId: string
  versionNo: number
  dimensionKind: ChangeoverDimensionKind
  /** 无命中条目时的缺省换型时长（分钟；0＝不计换型）。 */
  defaultMinutes: number
  entries: readonly ChangeoverEntry[]
}

/** [CS-16/CS-S3] 矩阵版本发布形状：条目非空、时长 0..1440 整数、(from,to) 键不重复。 */
export function assertMatrixPublishable(input: {
  dimensionKind: ChangeoverDimensionKind
  defaultMinutes: number
  entries: readonly ChangeoverEntry[]
}): void {
  if (!CHANGEOVER_DIMENSION_VALUES.includes(input.dimensionKind)) {
    throw new CswRuleViolation('CS-16', `换型矩阵维度必须是 ${CHANGEOVER_DIMENSION_VALUES.join('/')}：${input.dimensionKind}`)
  }
  const assertMinutes = (v: number, field: string): void => {
    if (!Number.isInteger(v) || v < 0 || v > 1440) {
      throw new CswRuleViolation('CS-16', `${field} 必须为 0..1440 的整数分钟：${v}`)
    }
  }
  assertMinutes(input.defaultMinutes, '缺省换型时长')
  if (input.entries.length === 0) {
    throw new CswRuleViolation('CS-16', '换型矩阵版本至少一条维度键条目（矩阵数据来源须现场工艺提供，GAP-E8）')
  }
  const seen = new Set<string>()
  for (const e of input.entries) {
    if (e.fromValue.trim() === '' || e.toValue.trim() === '') {
      throw new CswRuleViolation('CS-16', '换型矩阵条目的维度键不得为空（fromValue/toValue）')
    }
    assertMinutes(e.minutes, `条目 ${e.fromValue}→${e.toValue} 的换型时长`)
    const key = `${e.fromValue}|${e.toValue}`
    if (seen.has(key)) {
      throw new CswRuleViolation('CS-S3', `换型矩阵条目重复：${e.fromValue}→${e.toValue}（同版本内维度键唯一）`)
    }
    seen.add(key)
  }
}

/** 下一版本号（严格递增；被引用版本 immutable——修改须发新版本）。 */
export function nextMatrixVersionNo(currentMax: number): number {
  if (!Number.isInteger(currentMax) || currentMax < 0) {
    throw new CswRuleViolation('CS-S3', `当前换型矩阵版本号非法：${currentMax}`)
  }
  return currentMax + 1
}

/** [CS-16] 换型时长查表：命中条目取条目分钟，未命中取缺省（计入设备日历占用）。 */
export function lookupChangeoverMinutes(
  matrix: ChangeoverMatrixView | null,
  fromValue: string | null,
  toValue: string,
): number {
  if (matrix === null) return 0 // 未发布矩阵＝不计换型（GAP-E8 数据未到位前的空转口径）
  if (fromValue === null) return 0 // 该设备当日首个任务：无前序无换型
  const hit = matrix.entries.find((e) => e.fromValue === fromValue && e.toValue === toValue)
  return hit === undefined ? matrix.defaultMinutes : hit.minutes
}

/** 维度取值：工序维度取工序编码，产品属性维度取订单料品快照属性键。 */
export function dimensionValueOf(
  dimensionKind: ChangeoverDimensionKind,
  input: { operationCode: string | null; productAttribute: string | null },
): string {
  return dimensionKind === 'operation' ? (input.operationCode ?? '') : (input.productAttribute ?? '')
}

// ---------------------------------------------------------------------------
// CS-17 交期权重（默认排序 交期优先 → 换型最少 → 负荷均衡；权重可配置并随排程版本留存）
// ---------------------------------------------------------------------------

/** [CS-17] 建议排序权重（GAP-E11 取值未裁：默认权重为本合同建议值，PROPOSED 待裁定）。 */
export interface PriorityWeights {
  dueDate: string
  changeover: string
  loadBalance: string
}

/** 建议默认权重（交期优先 → 换型最少 → 负荷均衡；随排程版本留存，GAP-E11）。 */
export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  dueDate: '0.5000',
  changeover: '0.3000',
  loadBalance: '0.2000',
}

/** [CS-17] 权重形状：各分量 ≥0 且合计≈1（scale=4 容差）。 */
export function assertPriorityWeightsValid(w: PriorityWeights): void {
  const parseW = (v: string, field: string): number => {
    if (typeof v !== 'string' || !/^\d+(\.\d{1,4})?$/.test(v)) {
      throw new CswRuleViolation('CS-17', `${field} 权重必须为 0..1 十进制串（≤4 位小数）：${v}`)
    }
    return Number(v)
  }
  const d = parseW(w.dueDate, '交期')
  const c = parseW(w.changeover, '换型')
  const l = parseW(w.loadBalance, '负荷均衡')
  if (d < 0 || c < 0 || l < 0) {
    throw new CswRuleViolation('CS-17', '排序权重不得为负')
  }
  if (Math.abs(d + c + l - 1) > 0.0001) {
    throw new CswRuleViolation('CS-17', `排序权重合计须为 1（交期 ${d}＋换型 ${c}＋负荷 ${l}）`)
  }
}

/** 权重是否偏离默认（[CS-26] 权重修改须记录操作者/理由/影响清单）。 */
export function weightsDifferFromDefault(w: PriorityWeights): boolean {
  return (
    w.dueDate !== DEFAULT_PRIORITY_WEIGHTS.dueDate ||
    w.changeover !== DEFAULT_PRIORITY_WEIGHTS.changeover ||
    w.loadBalance !== DEFAULT_PRIORITY_WEIGHTS.loadBalance
  )
}

/**
 * [CS-17] 交期紧迫度：计划完成时间距今日天数（负＝已逾期，越负越紧迫）；
 * 无计划完成时间（null）的订单紧迫度排最后（+∞ 语义以极大值承载）。
 */
export function dueDateUrgency(dueDate: string | null, today: string): number {
  assertProductionDateValid(today, '今日', 'CS-17')
  if (dueDate === null) return Number.MAX_SAFE_INTEGER
  assertProductionDateValid(dueDate, '计划完成日期', 'CS-17')
  const diff = Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)
  return Math.round(diff / 86_400_000)
}

// ---------------------------------------------------------------------------
// CS-18 求解范围（当日起至多 N 个生产日；窗口外任务不参与优化、仅列示）
// ---------------------------------------------------------------------------

/** [CS-18] 默认求解窗口：7 个生产日（可配置）。 */
export const DEFAULT_HORIZON_DAYS = 7

export function assertHorizonDaysValid(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new CswRuleViolation('CS-18', `求解窗口必须为 1..90 的整数生产日：${days}`)
  }
}

/** [CS-18] 求解窗口日期序列：今日（含）起 N 个生产日。 */
export function horizonDates(today: string, days: number): string[] {
  assertProductionDateValid(today, '今日', 'CS-18')
  assertHorizonDaysValid(days)
  const dates: string[] = []
  for (let i = 0; i < days; i += 1) dates.push(shiftDateDays(today, i))
  return dates
}

/** [CS-18] 日期是否在求解窗口内。 */
export function isWithinHorizon(date: string, today: string, days: number): boolean {
  assertProductionDateValid(date, '生产日期', 'CS-18')
  const dates = horizonDates(today, days)
  return dates.includes(date)
}
