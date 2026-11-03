import { CostRuleViolation } from './errors'
import { add4, amountOf, cmp4, mul4, sub4 } from './decimals'
// 包内上级目录相对导入（domain/src/cost → domain/src/inventory）：未逃逸出 domain 包，
// 边界规则对包内子目录场景过宽（同 reporting/metric-rules.ts、trace/genealogy.ts 先例）；单行豁免留痕。
// eslint-disable-next-line no-restricted-imports
import { DEFAULT_SHIFT_CALENDAR, type ShiftCalendarConfig } from '../inventory/time'

/**
 * 成本归集规则（CE-02 只读业务事实、CE-03 实测/估算分开、CE-05 唯一来源映射、
 * CE-07 理论与实测分列+损耗去向、CE-08 倒冲 fail-closed、CE-10 OEE 分母齐备、
 * CE-17 估算/实测两列、CE-18 在制口径、CE-19 班次快照锚；
 * CA-12 工时主从 / CA-13 折旧口径——**PROPOSED 依赖，按冻结合同默认口径实现**）。
 */

/** 归集来源类型（CE-05 唯一来源映射）。 */
export const SOURCE_KINDS = ['material', 'labor', 'scrap', 'equipment_runtime', 'spare_part', 'energy'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/** 源事实表名（CE-15 回算路径：归集明细 → 源事实 ID → 原始单据）。 */
export const SOURCE_TABLES: Readonly<Record<SourceKind, string>> = {
  material: 'material_consumption',
  labor: 'labor_record',
  scrap: 'report_output',
  /** 设备运行＝OT 采集（CE-05；execution_session 仅作订单-设备占用关系，不作运行量来源） */
  equipment_runtime: 'ot_sample',
  spare_part: 'spare_part_usage',
  energy: 'cost_meter_reading',
}

/** 归集明细值标志（CE-03/S1：实测/估算分开，不以估算冒充实测）。 */
export const VALUE_FLAGS = ['measured', 'estimated'] as const
export type ValueFlag = (typeof VALUE_FLAGS)[number]

/**
 * CA-12（PROPOSED 默认口径）：报工 labor_record 为工时**唯一入账主源**；
 * 设备采集运行时间仅作校验参考源（差异分析），**永不进入成本归集工时行**。
 */
export const LABOR_PRIMARY_SOURCE = 'labor_record' as const
export const LABOR_REFERENCE_SOURCE = 'ot_runtime' as const
/** CA-12 建议阈值：班次级 ±10%（可配置；PROPOSED 待裁）。 */
export const DEFAULT_LABOR_CHECK_THRESHOLD = '0.1000'

/**
 * CA-13（PROPOSED 默认口径）：设备成本首期口径＝运行占用（机时）＋维护备件消耗，
 * **不含折旧**；ERP 折旧值只作外部引用列展示（来源+版本标注），不并入归集公式。
 */
export const EQUIPMENT_COST_CALIBER = 'runtime_hours_plus_spare_parts_excluding_depreciation' as const

export interface AcquisitionInputShape {
  orderId: string
  shiftDate: string
  cutoffAt: string
  allocationVersionId: string
  priceVersionId: string
}

/**
 * 班次日窗口（CE-S4/CE-19 班次锚 · IT-37 口径）：班次日期按工厂日历＋时区＋白班起点计算，
 * 与 labor_record.shift_date 同源同口径（inventory/time.ts computeShiftDate，默认 UTC+8 / 白班 00:00）。
 * 窗口 = [D 白班起点, D+1 白班起点)，以 UTC 瞬时返回（默认日历下 D 的窗口 = [(D-1)T16:00Z, DT16:00Z)）。
 * O-3 修复（2026-10-29）：归集/核对窗口原以 `shiftDate T00:00Z`（UTC 零点）为锚，与北京班次日
 * 跨零点错位一日（UTC 16:00–24:00 时段 labor 行被过滤）——改为按工厂班次日历对齐。
 */
export function shiftDayWindow(
  shiftDate: string,
  config: ShiftCalendarConfig = DEFAULT_SHIFT_CALENDAR,
): { from: string; to: string } {
  if (typeof shiftDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
    throw new CostRuleViolation('CE-S1', `班次日期必须为 YYYY-MM-DD：${shiftDate}`)
  }
  const baseMs = Date.parse(`${shiftDate}T00:00:00Z`) // 纯日期基线（UTC 零点仅作算术基准）
  if (Number.isNaN(baseMs)) {
    throw new CostRuleViolation('CE-S1', `班次日期非法：${shiftDate}`)
  }
  const startMs = baseMs - config.utcOffsetHours * 3_600_000 + config.dayShiftStartHour * 3_600_000
  return {
    from: new Date(startMs).toISOString(),
    to: new Date(startMs + 86_400_000).toISOString(),
  }
}

/** 归集输入形状（CE-S1：绑定分摊版本+价格版本+数据截止时点+班次锚）。 */
export function assertAcquisitionInput(input: AcquisitionInputShape): void {
  if (typeof input.orderId !== 'string' || input.orderId === '') {
    throw new CostRuleViolation('CE-S1', '归集必须绑定生产订单（orderId）')
  }
  if (typeof input.shiftDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.shiftDate)) {
    throw new CostRuleViolation('CE-S1', '归集必须带班次日期（shiftDate，YYYY-MM-DD）')
  }
  if (typeof input.cutoffAt !== 'string' || Number.isNaN(Date.parse(input.cutoffAt))) {
    throw new CostRuleViolation('CE-S1', '归集必须带数据截止时点（cutoffAt，ISO-8601）')
  }
  if (typeof input.allocationVersionId !== 'string' || input.allocationVersionId === '') {
    throw new CostRuleViolation('CE-S1', '归集必须绑定分摊版本（allocationVersionId）')
  }
  if (typeof input.priceVersionId !== 'string' || input.priceVersionId === '') {
    throw new CostRuleViolation('CE-S1', '归集必须绑定价格版本（priceVersionId）')
  }
}

export interface MaterialVarianceResult {
  /** 损耗 = 理论 − 实耗 − 在制变化（CE-07；负值=超耗，如实列示不截断） */
  varianceQty: string
  /** 已知去向：报废（报工不合格量） */
  scrapQty: string
  /** 未解释去向余量（>0 时 destination_breakdown_missing=true，不以去向冒充 CE-03/CE-07） */
  unexplainedQty: string
  destinationBreakdownMissing: boolean
}

/** CE-07：损耗=理论−实耗−在制变化；各项有去向（废料/返料/回收），未解释部分显著标注。 */
export function computeMaterialVariance(input: {
  theoreticalQty: string
  actualQty: string
  wipChangeQty: string
  scrapQty: string
}): MaterialVarianceResult {
  const varianceQty = sub4(sub4(input.theoreticalQty, input.actualQty, 'CE-07'), input.wipChangeQty, 'CE-07')
  const unexplainedQty = sub4(varianceQty, input.scrapQty, 'CE-07')
  return {
    varianceQty,
    scrapQty: input.scrapQty,
    unexplainedQty,
    destinationBreakdownMissing: cmp4(unexplainedQty, '0.0000', 'CE-07') > 0,
  }
}

export interface EstimateLineResult {
  materialCode: string
  theoreticalQty: string
  unitPrice: string | null
  uomCode: string
  amount: string | null
  priceMissing: boolean
}

/**
 * CE-17 估算列：BOM 理论量（bomQty×计划数量）× 价格版本。
 * 无已发布 BOM → 返回 null（估算缺项，CE-03 不冒充）；缺价行 amount=null+priceMissing。
 */
export function estimateMaterialFromBom(input: {
  bomLines: ReadonlyArray<{ materialCode: string; qtyPerUnit: string; uomCode: string }>
  plannedQty: string
  priceItems: ReadonlyArray<{ materialCode: string; unitPrice: string; uomCode: string }>
}): EstimateLineResult[] | null {
  return input.bomLines.map((line) => {
    const theoreticalQty = mul4(line.qtyPerUnit, input.plannedQty, 'CE-07')
    const price = input.priceItems.find((p) => p.materialCode === line.materialCode)
    if (price === undefined) {
      return { materialCode: line.materialCode, theoreticalQty, unitPrice: null, uomCode: line.uomCode, amount: null, priceMissing: true }
    }
    // 单价 scale=6：以 amountOf（数量×单价 half-up 到 4 位）计价，不用 mul4（会截断价格到 4 位）
    const amount = amountOf(theoreticalQty, price.unitPrice, 'CE-14')
    return { materialCode: line.materialCode, theoreticalQty, unitPrice: price.unitPrice, uomCode: line.uomCode, amount, priceMissing: false }
  })
}

/**
 * CE-08（fail-closed 首期）：工艺路线无"允许自动倒冲"标志（0005 无该字段——登记 GAP/收编请求），
 * 材料行**永不**以倒冲估算入账：缺采集=缺项标注（estimated 仅限能源覆盖不足外推 CE-09），
 * 本函数即该口径的显式判定（存在标志前恒 false）。
 */
export function isAutoBackflushAllowed(routeAllowsBackflush: boolean | null | undefined): boolean {
  return routeAllowsBackflush === true
}

export type OeeMissingReason =
  | 'planned_time_missing'
  | 'downtime_missing'
  | 'standard_speed_not_numeric'
  | 'output_missing'
  | 'qualified_missing'

export interface OeeResult {
  /** 可用率 =（计划时间−停机时间）/计划时间；任一分母缺项 → null（CE-10 不出假百分比） */
  availability: string | null
  /** 性能率 =（实际产出速度/标准速度）；标准速度未数值化（GAP-S1）→ null */
  performance: string | null
  /** 质量率 = 合格量/总产量 */
  qualityRate: string | null
  /** OEE = 三率乘积；任一缺项 → null */
  oee: string | null
  missing: OeeMissingReason[]
}

/** CE-10：时间窗与分母（含标准速度）齐备后才计算 OEE；分母缺项展示缺项而非假百分比。 */
export function computeOee(input: {
  plannedMinutes: string | null
  downtimeMinutes: string | null
  /** 标准速度（数值/小时）；equipment.std_rate_text 为文本（GAP-S1 未数值化）→ null */
  standardSpeedPerHour: string | null
  actualOutputQty: string | null
  qualifiedQty: string | null
}): OeeResult {
  const missing: OeeMissingReason[] = []
  if (input.plannedMinutes === null || cmp4(input.plannedMinutes, '0.0000', 'CE-10') <= 0) missing.push('planned_time_missing')
  if (input.downtimeMinutes === null) missing.push('downtime_missing')
  if (input.standardSpeedPerHour === null || cmp4(input.standardSpeedPerHour, '0.0000', 'CE-10') <= 0) {
    missing.push('standard_speed_not_numeric')
  }
  if (input.actualOutputQty === null) missing.push('output_missing')
  if (input.qualifiedQty === null) missing.push('qualified_missing')

  if (missing.length > 0) {
    return { availability: null, performance: null, qualityRate: null, oee: null, missing }
  }
  const runtime = sub4(input.plannedMinutes!, input.downtimeMinutes!, 'CE-10')
  if (cmp4(runtime, '0.0000', 'CE-10') < 0) {
    throw new CostRuleViolation('CE-10', '停机时间超过计划时间（运行时间为负），拒绝计算')
  }
  const availability = div4Safe(runtime, input.plannedMinutes!)
  // 性能率：实际产出速度=产出量/运行小时；与标准速度（每小时）对比
  const runtimeHours = div4Safe(runtime, '60.0000')
  const actualRate = cmp4(runtimeHours, '0.0000', 'CE-10') > 0 ? div4Safe(input.actualOutputQty!, runtimeHours) : '0.0000'
  const performance = div4Safe(actualRate, input.standardSpeedPerHour!)
  const qualityRate = cmp4(input.actualOutputQty!, '0.0000', 'CE-10') > 0 ? div4Safe(input.qualifiedQty!, input.actualOutputQty!) : '0.0000'
  const oee = mul4(mul4(availability, performance, 'CE-10'), qualityRate, 'CE-10')
  return { availability, performance, qualityRate, oee, missing: [] }
}

/** 安全除法（b=0 → '0.0000'；域内查询/OEE 复用，half-up）。 */
export function div4Safe(a: string, b: string): string {
  if (b === '0.0000') return '0.0000'
  const [ai, af = ''] = a.split('.')
  const [bi, bf = ''] = b.split('.')
  const aScaled = BigInt(ai + af.padEnd(4, '0'))
  const bScaled = BigInt(bi + bf.padEnd(4, '0'))
  const neg = aScaled < 0n !== bScaled < 0n
  const absA = aScaled < 0n ? -aScaled : aScaled
  const absB = bScaled < 0n ? -bScaled : bScaled
  const scaled = (absA * 10000n * 2n + absB) / (absB * 2n)
  return `${neg ? '-' : ''}${scaled / 10000n}.${(scaled % 10000n).toString().padStart(4, '0')}`
}

export interface LaborCheckResult {
  status: 'open' | 'skipped'
  laborHours: string | null
  otRuntimeHours: string | null
  /** 偏差比 = |OT−报工|/报工；主源恒为 labor_record（CA-12 不自动改写） */
  deviationRatio: string | null
  thresholdRatio: string
  missingSide: 'labor' | 'ot' | null
}

/**
 * CA-12（PROPOSED 默认）：报工工时 vs OT 采集运行时间偏差核对。
 * 偏差超阈值（默认 ±10%）生成核对提示；缺任一侧 → skipped+缺侧标注（不冒充）；
 * 任何情况下不改写 labor_record（主从——归集工时行只来自 labor_record，见 LABOR_PRIMARY_SOURCE）。
 */
export function buildLaborCheck(input: {
  laborHours: string | null
  otRuntimeHours: string | null
  thresholdRatio?: string
}): LaborCheckResult {
  const thresholdRatio = input.thresholdRatio ?? DEFAULT_LABOR_CHECK_THRESHOLD
  if (input.laborHours === null) {
    return { status: 'skipped', laborHours: null, otRuntimeHours: input.otRuntimeHours, deviationRatio: null, thresholdRatio, missingSide: 'labor' }
  }
  if (input.otRuntimeHours === null) {
    return { status: 'skipped', laborHours: input.laborHours, otRuntimeHours: null, deviationRatio: null, thresholdRatio, missingSide: 'ot' }
  }
  const diffAbs = sub4(input.otRuntimeHours, input.laborHours, 'CA-12')
  const raw = diffAbs.startsWith('-') ? diffAbs.slice(1) : diffAbs
  const deviationRatio = cmp4(input.laborHours, '0.0000', 'CA-12') > 0 ? div4Safe(raw, input.laborHours) : '0.0000'
  const overThreshold = cmp4(deviationRatio, thresholdRatio, 'CA-12') > 0
  return {
    status: overThreshold ? 'open' : 'skipped',
    laborHours: input.laborHours,
    otRuntimeHours: input.otRuntimeHours,
    deviationRatio,
    thresholdRatio,
    missingSide: null,
  }
}

/** CE-18：在制变化（窗口内产出未转库存部分=在制已投入增量口径的首期承载）。 */
export function wipChangeFromOutputs(outputs: ReadonlyArray<{ quantity: string; stockUnitId: string | null }>): string {
  return outputs
    .filter((o) => o.stockUnitId === null)
    .reduce((acc, o) => add4(acc, o.quantity, 'CE-18'), '0.0000')
}
