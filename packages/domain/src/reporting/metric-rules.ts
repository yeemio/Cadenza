// 包内上级目录相对导入（domain/src/reporting → domain/src/inventory）：未逃逸出 domain 包，
// 边界规则对包内子目录场景过宽（同 trace/genealogy.ts、execution/quantities.ts 先例）；单行豁免留痕。
// eslint-disable-next-line no-restricted-imports
import { computeShiftDate } from '../inventory/time'
import { ReportingRuleViolation } from './errors'
import { fromScaledInt, toScaledInt, truncDiv4, truncPercent4 } from './decimal-math'

/**
 * 班次快照与核心指标纯规则（RP-18~RP-22，**[合同新造]**——S12 显式新增、无独立规格；
 * 指标清单与分母定义待 Owner 圈定 → GAP-F24/F25，本模块只冻框架与最小示例集）。
 */

// ---------------- 指标族（RP-20 首期四族） ----------------

export const METRIC_FAMILIES = ['wip', 'delivery', 'yield', 'loss'] as const
export type MetricFamily = (typeof METRIC_FAMILIES)[number]

export const METRIC_FAMILY_LABELS: Readonly<Record<MetricFamily, string>> = {
  wip: '在制',
  delivery: '交期',
  yield: '良率',
  loss: '损耗',
}

// ---------------- 事实集键（引擎内置识别的声明性引用，定义行 jsonb 只存键，不存 SQL） ----------------

/**
 * 分子/分母事实集键（[合同新造]最小集；新增事实集=引擎扩枚举+新版本定义行，GAP-F25 待裁）：
 * - production.wip-balance：在制库存余额（inventory_unit.status=in_production 的活动余额，按声明单位）
 * - execution.report-output-qty：报工产出数量（审核通过单，report_output.quantity）
 * - execution.report-qualified-qty：报工合格数量（审核通过单，report_output.qualified_qty）
 * - execution.material-consumption-qty：投料数量（material_consumption.quantity）
 * - execution.consumption-minus-output-qty：投料−产出（班次损耗量，可为负=超产）
 * - process.order-ontime-finish：准时完成订单数（actual_finish_at ≤ planned_finish_at）
 * - process.order-finish：完成订单数（actual_finish_at 非空）
 */
export const FACT_SET_KEYS = [
  'production.wip-balance',
  'execution.report-output-qty',
  'execution.report-qualified-qty',
  'execution.material-consumption-qty',
  'execution.consumption-minus-output-qty',
  'process.order-ontime-finish',
  'process.order-finish',
] as const
export type FactSetKey = (typeof FACT_SET_KEYS)[number]

export interface FactSetSpec {
  kind: FactSetKey
}

/** 定义载荷形状校验（RP-19：分子/分母事实集必须是引擎可识别的声明性引用）。 */
export function parseFactSetSpec(raw: unknown): FactSetSpec {
  if (typeof raw !== 'object' || raw === null) {
    throw new ReportingRuleViolation('RP-19', '事实集定义必须是对象（{kind}）')
  }
  const kind = (raw as Record<string, unknown>)['kind']
  if (typeof kind !== 'string' || !(FACT_SET_KEYS as readonly string[]).includes(kind)) {
    throw new ReportingRuleViolation('RP-19', `未知事实集键：${String(kind)}（合法值：${FACT_SET_KEYS.join(' / ')}）`)
  }
  return { kind: kind as FactSetKey }
}

// ---------------- 快照解析（RP-21 失败与缺失分母保留） ----------------

export type SnapshotStatus = 'ok' | 'denominator_missing' | 'projection_failed'

export interface SnapshotResolution {
  status: SnapshotStatus
  /** 数值；denominator_missing/projection_failed 时为 null（不以 0 或默认值冒充） */
  value: string | null
  missingReason: string | null
}

export interface SnapshotFactResult {
  /** 分子事实集聚合值（DecimalString）；事实集无行 = 真实 0 */
  numeratorValue: string
  /** 分母事实集聚合值；无分母事实集（单边量指标）为 null */
  denominatorValue: string | null
}

export type MetricUomMode = 'plain' | 'percent'

/**
 * RP-21：分母缺失（无行或为 0）时保留缺失标记与原因，不以 0 或默认值冒充成功数值
 * （"接口返回 200 ≠ 数值正确"）；单边量指标（无分母事实集）直接输出分子。
 */
export function resolveSnapshotValue(
  fact: SnapshotFactResult,
  uomMode: MetricUomMode,
  metricKey: string,
): SnapshotResolution {
  if (fact.denominatorValue === null) {
    return { status: 'ok', value: fact.numeratorValue, missingReason: null }
  }
  const denom = toScaledInt(fact.denominatorValue, 'RP-21')
  if (denom === 0n) {
    return {
      status: 'denominator_missing',
      value: null,
      missingReason: `[RP-21] 指标 ${metricKey} 分母事实集聚合为 0 或无行，保留缺失标记（不以 0 冒充数值）`,
    }
  }
  const num = toScaledInt(fact.numeratorValue, 'RP-21')
  const ratio = truncDiv4(num, denom)
  return { status: 'ok', value: fromScaledInt(uomMode === 'percent' ? truncPercent4(ratio) : ratio), missingReason: null }
}

// ---------------- 定义版本选择（RP-19 生效区间；定义变更不回写历史快照） ----------------

export interface MetricDefinitionLike {
  metricKey: string
  version: number
  status: 'draft' | 'active' | 'retired'
  effectiveFrom: string
  effectiveTo: string | null
}

/**
 * 班次日快照引用的指标版本：status=active 且班次日落在生效区间；多个满足时取最高版本。
 * 定义变更（新版本行）不回写已产出的历史快照（RP-19：历史快照引用具体版本）。
 */
export function pickEffectiveDefinition<T extends MetricDefinitionLike>(
  definitions: readonly T[],
  shiftDate: string,
): T | null {
  const day = Date.parse(`${shiftDate}T00:00:00Z`)
  if (Number.isNaN(day)) {
    throw new ReportingRuleViolation('RP-18', `班次日期非法：${shiftDate}`)
  }
  let best: T | null = null
  for (const def of definitions) {
    if (def.status !== 'active') continue
    const from = Date.parse(`${def.effectiveFrom}T00:00:00Z`)
    const to = def.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(`${def.effectiveTo}T23:59:59Z`)
    if (day < from || day > to) continue
    if (best === null || def.version > best.version) best = def
  }
  return best
}

// ---------------- 班次日期口径（RP-18/IT-37） ----------------

/**
 * 班次日期：优先业务事实行自带的 shift_date 列（0004/0008 已分列存储）；
 * 为空时按工厂日历＋时区＋白班起点折算（IT-37 computeShiftDate；细则 GAP-A3 未裁，
 * 默认零点白班起点/UTC+8，参数可配）。重算不重新执行报工或扣库存（RP-18）。
 */
export function shiftDateOf(businessTime: string, shiftDateColumn: string | null): string {
  if (shiftDateColumn !== null && /^\d{4}-\d{2}-\d{2}$/.test(shiftDateColumn)) return shiftDateColumn
  return computeShiftDate(businessTime)
}

// ---------------- 首期框架默认指标定义（[合同新造]最小示例集，GAP-F24/F25 待裁） ----------------

export interface MetricDefinitionSeed {
  metricKey: string
  family: MetricFamily
  version: number
  caliberVersion: string
  numeratorFactSet: FactSetKey
  denominatorFactSet: FactSetKey | null
  uomCode: string
  uomMode: MetricUomMode
  description: string
}

/**
 * 四族各一条基础指标（RP-20 框架；每指标数值可与原单据逐笔对账，RP-22）：
 * - wip.quantity：在制量（单边量；对账源=stock_balance 活动余额）
 * - yield.qualified-rate：合格率 = 合格产出 ÷ 产出（审核通过口径；对账源=report_output）
 * - loss.consumption-gap-rate：损耗率 =（投料−产出）÷ 投料（对账源=material_consumption/report_output）
 * - delivery.ontime-rate：准时完成率 = 准时完成订单 ÷ 完成订单（对账源=production_order）
 */
export const DEFAULT_METRIC_DEFINITIONS: readonly MetricDefinitionSeed[] = [
  {
    metricKey: 'wip.quantity',
    family: 'wip',
    version: 1,
    caliberVersion: 'v1',
    numeratorFactSet: 'production.wip-balance',
    denominatorFactSet: null,
    uomCode: 'KG',
    uomMode: 'plain',
    description: '在制量：in_production 状态库存单元活动余额合计（按声明单位）',
  },
  {
    metricKey: 'yield.qualified-rate',
    family: 'yield',
    version: 1,
    caliberVersion: 'v1',
    numeratorFactSet: 'execution.report-qualified-qty',
    denominatorFactSet: 'execution.report-output-qty',
    uomCode: '%',
    uomMode: 'percent',
    description: '良率：审核通过报工单合格产出 ÷ 产出数量',
  },
  {
    metricKey: 'loss.consumption-gap-rate',
    family: 'loss',
    version: 1,
    caliberVersion: 'v1',
    numeratorFactSet: 'execution.consumption-minus-output-qty',
    denominatorFactSet: 'execution.material-consumption-qty',
    uomCode: '%',
    uomMode: 'percent',
    description: '损耗率：（班次投料 − 班次产出）÷ 班次投料（可为负=超产）',
  },
  {
    metricKey: 'delivery.ontime-rate',
    family: 'delivery',
    version: 1,
    caliberVersion: 'v1',
    numeratorFactSet: 'process.order-ontime-finish',
    denominatorFactSet: 'process.order-finish',
    uomCode: '%',
    uomMode: 'percent',
    description: '准时完成率：actual_finish_at ≤ planned_finish_at 的完成订单 ÷ 完成订单',
  },
]
