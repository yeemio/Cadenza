import { MaintenanceRuleViolation } from './errors'

/**
 * 点检/保养计划规则（MT-12/MT-S4——[合同新造·框架]）。
 *
 * maintenance_plan 版本化（周期＋检查项模板）；inspection_round 记执行结果
 * （实际时间＋业务班次双存，IT-37）；超期未执行提示、不自动阻断生产（默认口径，
 * 现场流程 → GAP-F19 待裁）；计划配置变更不回写已执行记录（引用计划版本快照）；
 * 点检不合格产生异常记录并建议关联报修（是否自动建单 → GAP-F19，当前不自动）。
 */

// ---------------- 计划种类与周期 ----------------

/** 计划种类（MT-12）：inspection=点检、maintenance=保养。 */
export const MAINTENANCE_PLAN_KINDS = ['inspection', 'maintenance'] as const

export type MaintenancePlanKind = (typeof MAINTENANCE_PLAN_KINDS)[number]

export const MAINTENANCE_PLAN_KIND_LABELS: Readonly<Record<MaintenancePlanKind, string>> = {
  inspection: '点检',
  maintenance: '保养',
}

/**
 * 最小周期机制（MT-12 框架）：每 N 天执行一次（everyDays 整数 ≥ 1）。
 * 班次/日历型周期扩展随 GAP-F19 现场流程裁定后升级（当前不自行扩展）。
 */
export interface PlanCycle {
  everyDays: number
}

/** MT-12：周期形状守卫（最小机制 {everyDays:>=1}）。 */
export function assertPlanCycle(cycle: unknown): PlanCycle {
  if (typeof cycle !== 'object' || cycle === null || Array.isArray(cycle)) {
    throw new MaintenanceRuleViolation('MT-12', '计划周期必须为对象（最小机制 {everyDays:>=1}）')
  }
  const everyDays = (cycle as { everyDays?: unknown })['everyDays']
  if (typeof everyDays !== 'number' || !Number.isInteger(everyDays) || everyDays < 1) {
    throw new MaintenanceRuleViolation(
      'MT-12',
      `计划周期 everyDays 必须为 ≥1 的整数（当前=${String(everyDays)}）`,
    )
  }
  return { everyDays }
}

/** MT-12：检查项模板守卫（非空字符串数组——round 执行结果引用此模板快照）。 */
export function assertCheckItemTemplate(items: unknown): string[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new MaintenanceRuleViolation('MT-12', '计划必须包含至少一项检查项模板（非空数组）')
  }
  for (const item of items) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new MaintenanceRuleViolation('MT-12', '检查项模板必须为非空字符串数组')
    }
  }
  return items as string[]
}

// ---------------- 版本化与生效区间 ----------------

/** 计划版本只读视图（版本择优输入）。 */
export interface PlanVersionView {
  planKey: string
  version: number
  effectiveFrom: string
  effectiveTo: string | null
  status: string
}

/** 日期比较（yyyy-MM-dd 字典序即时间序）。 */
function isDateWithin(onDate: string, from: string, to: string | null): boolean {
  if (onDate < from) return false
  return to === null || onDate <= to
}

/** MT-12：版本化守卫——同 planKey 版本号 ≥1 且不重复（库层 UNIQUE 双保险）。 */
export function assertPlanVersionNumber(version: unknown): number {
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new MaintenanceRuleViolation('MT-12', `计划版本号必须为 ≥1 的整数（当前=${String(version)}）`)
  }
  return version
}

/** MT-12：生效区间守卫（to 非空时须晚于 from）。 */
export function assertPlanEffectiveRange(effectiveFrom: string, effectiveTo: string | null): void {
  if (effectiveTo !== null && effectiveTo <= effectiveFrom) {
    throw new MaintenanceRuleViolation(
      'MT-12',
      `计划生效区间非法（effective_to=${effectiveTo} 须晚于 effective_from=${effectiveFrom}）`,
    )
  }
}

/** MT-12：按生效区间取当日生效的最高 active 版本（无生效版本 → null）。 */
export function pickEffectivePlanVersion(
  versions: readonly PlanVersionView[],
  onDate: string,
): PlanVersionView | null {
  let best: PlanVersionView | null = null
  for (const version of versions) {
    if (version.status !== 'active') continue
    if (!isDateWithin(onDate, version.effectiveFrom, version.effectiveTo)) continue
    if (best === null || version.version > best.version) best = version
  }
  return best
}

// ---------------- 超期提示（不自动阻断生产） ----------------

/** 日期加天数（yyyy-MM-dd，UTC 日历运算防时区漂移）。 */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * MT-12：下次应执行日——自锚点日（最近一次执行班次日，无执行则计划生效日）起每 everyDays 天。
 */
export function computeNextDueDate(anchorDate: string, cycle: PlanCycle): string {
  return addDays(anchorDate, cycle.everyDays)
}

/** MT-12：超期判定（today > 应执行日；提示口径，不自动阻断生产——默认口径，GAP-F19 待裁）。 */
export function isPlanOverdue(nextDueDate: string, today: string): boolean {
  return today > nextDueDate
}

// ---------------- 执行结果（inspection_round） ----------------

export const INSPECTION_RESULTS = ['pass', 'fail'] as const

export type InspectionResultValue = (typeof INSPECTION_RESULTS)[number]

/** MT-12：执行结果守卫（pass/fail 两值）。 */
export function assertInspectionResult(result: unknown): InspectionResultValue {
  if (result !== 'pass' && result !== 'fail') {
    throw new MaintenanceRuleViolation('MT-12', `点检/保养执行结果仅 pass/fail，非法输入：${String(result)}`)
  }
  return result
}

/**
 * MT-12：点检不合格 → 产生异常记录（异常说明必填）。
 * 建议关联报修但不自动建单（是否自动建单 → GAP-F19 待裁，默认建议口径）。
 */
export function assertFailedRoundAnomalyNote(result: InspectionResultValue, anomalyNote: unknown): void {
  if (result === 'fail' && (typeof anomalyNote !== 'string' || anomalyNote.trim() === '')) {
    throw new MaintenanceRuleViolation('MT-12', '点检不合格必须记录异常说明（异常记录必填）')
  }
}

/** MT-12：不合格建议关联报修的回执建议（不自动建单；GAP-F19 裁定后可升级）。 */
export interface RepairReportSuggestion {
  suggested: true
  reason: string
  equipmentId: string
  anomalyNote: string
}

export function buildRepairReportSuggestion(input: {
  result: InspectionResultValue
  equipmentId: string
  anomalyNote: string | null
}): RepairReportSuggestion | null {
  if (input.result !== 'fail') return null
  return {
    suggested: true,
    reason: '点检不合格：建议关联报修（不自动建单，GAP-F19 待裁）',
    equipmentId: input.equipmentId,
    anomalyNote: input.anomalyNote ?? '',
  }
}
