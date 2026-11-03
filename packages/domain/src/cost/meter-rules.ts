import { CostRuleViolation } from './errors'
import { add4, cmp4, div4, isValidCostDecimal, parseScaled, sub4 } from './decimals'

/**
 * 能源表计与读数规则（CE-S3 表计配置、CE-09 计量口径与覆盖率、CE-03 实测不冒充、
 * CE-05 唯一来源映射之能源＝计量表读数）。
 */

/** 能源类型（CE-S3：电/水/气）。 */
export const ENERGY_TYPES = ['electric', 'water', 'gas'] as const
export type EnergyType = (typeof ENERGY_TYPES)[number]

/** 覆盖范围（CE-S3：设备级/车间级）。 */
export const COVERAGE_KINDS = ['equipment', 'workshop'] as const
export type CoverageKind = (typeof COVERAGE_KINDS)[number]

/** 采样来源（CE-S3/CE-09：OT 表计样本 或 人工抄表）。 */
export const SAMPLE_SOURCES = ['ot', 'manual'] as const
export type SampleSource = (typeof SAMPLE_SOURCES)[number]

export interface MeterShapeInput {
  meterCode: string
  meterName?: string | null
  energyType: string
  coverageKind: string
  equipmentId?: string | null
  workCenterId?: string | null
  sampleSource: string
  otPointId?: string | null
  uomCode: string
}

/** CE-S3：表计配置形状（类型枚举、覆盖范围与目标成对、采样来源与 OT 点位成对、单位非空）。 */
export function assertMeterShape(input: MeterShapeInput): void {
  if (typeof input.meterCode !== 'string' || input.meterCode.trim() === '') {
    throw new CostRuleViolation('CE-S3', '表计编码必填（meterCode）')
  }
  if (!ENERGY_TYPES.includes(input.energyType as EnergyType)) {
    throw new CostRuleViolation('CE-S3', `能源类型必须为 electric/water/gas：${input.energyType}`)
  }
  if (!COVERAGE_KINDS.includes(input.coverageKind as CoverageKind)) {
    throw new CostRuleViolation('CE-S3', `覆盖范围必须为 equipment/workshop：${input.coverageKind}`)
  }
  if (!SAMPLE_SOURCES.includes(input.sampleSource as SampleSource)) {
    throw new CostRuleViolation('CE-S3', `采样来源必须为 ot/manual：${input.sampleSource}`)
  }
  if (input.coverageKind === 'equipment' && (input.equipmentId ?? null) === null) {
    throw new CostRuleViolation('CE-S3', '设备级覆盖必须绑定设备（equipmentId）')
  }
  if (input.coverageKind === 'workshop' && (input.workCenterId ?? null) === null) {
    throw new CostRuleViolation('CE-S3', '车间级覆盖必须绑定工作中心（workCenterId）')
  }
  if (input.coverageKind === 'equipment' && (input.workCenterId ?? null) !== null) {
    throw new CostRuleViolation('CE-S3', '设备级覆盖不得同时绑定工作中心（覆盖目标须唯一）')
  }
  // CE-09：先明确采样来源——OT 来源必须指向已登记点位；人工抄表不得绑定点位（防双源混读）
  if (input.sampleSource === 'ot' && (input.otPointId ?? null) === null) {
    throw new CostRuleViolation('CE-09', 'OT 采样来源的表计必须绑定采集点位（otPointId）')
  }
  if (input.sampleSource === 'manual' && (input.otPointId ?? null) !== null) {
    throw new CostRuleViolation('CE-09', '人工抄表表计不得绑定 OT 点位（采样来源须唯一，防双源混读）')
  }
  if (typeof input.uomCode !== 'string' || input.uomCode === '') {
    throw new CostRuleViolation('CE-S3', '计量单位必填（uomCode）')
  }
}

export interface ReadingShapeInput {
  readingType: 'manual' | 'ot'
  /** 累计读数（表计字轮值；用量=相邻读数差） */
  reading?: string | null
  readAt?: string | null
  readBy?: string | null
  otSampleId?: string | null
}

/** CE-05/CE-09：读数形状（人工=读数+时间+人；OT=样本引用，读数自样本固化）。 */
export function assertMeterReadingShape(input: ReadingShapeInput): void {
  if (input.readingType === 'manual') {
    if (input.reading === undefined || input.reading === null || !isValidCostDecimal(input.reading)) {
      throw new CostRuleViolation('CE-09', '人工抄表必须提交十进制累计读数（reading）')
    }
    if (parseScaled(input.reading, 'CE-09') < 0n) {
      throw new CostRuleViolation('CE-09', '累计读数不得为负')
    }
    if (input.readAt === undefined || input.readAt === null) throw new CostRuleViolation('CE-09', '人工抄表必须带抄表时间（readAt）')
    if (input.otSampleId !== undefined && input.otSampleId !== null) {
      throw new CostRuleViolation('CE-09', '人工抄表读数不得携带 OT 样本引用（readingType 与来源须一致）')
    }
  } else if (input.readingType === 'ot') {
    if (input.otSampleId === undefined || input.otSampleId === null) {
      throw new CostRuleViolation('CE-05', 'OT 来源读数必须携带样本事实 ID（otSampleId）')
    }
  } else {
    throw new CostRuleViolation('CE-S3', `读数来源必须为 manual/ot：${String(input.readingType)}`)
  }
}

export interface ReadingPoint {
  readAt: string
  reading: string
}

export interface MeteredUsageResult {
  /** 用量 = 末次 − 首次累计读数（窗口内） */
  usage: string
  fromAt: string | null
  toAt: string | null
  readingCount: number
}

/**
 * CE-09：窗口内累计读数差 = 实测用量。读数序列按时间升序；
 * 读数回退（换表/字轮回卷未建模）→ 违例拒绝，不以回退差冒充用量（CE-03 不产生假值）。
 */
export function computeMeteredUsage(readings: ReadingPoint[]): MeteredUsageResult {
  if (readings.length === 0) return { usage: '0.0000', fromAt: null, toAt: null, readingCount: 0 }
  if (readings.length === 1) {
    return { usage: '0.0000', fromAt: readings[0]!.readAt, toAt: readings[0]!.readAt, readingCount: 1 }
  }
  const sorted = [...readings].sort((a, b) => Date.parse(a.readAt) - Date.parse(b.readAt))
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!
  const diff = sub4(last.reading, first.reading, 'CE-09')
  if (parseScaled(diff, 'CE-09') < 0n) {
    throw new CostRuleViolation('CE-03', `表计累计读数回退（${first.reading}→${last.reading}）：换表/回卷场景未建模，拒绝以回退差冒充用量`)
  }
  return { usage: diff, fromAt: first.readAt, toAt: last.readAt, readingCount: sorted.length }
}

export interface EnergyCoverageResult {
  /** 实测覆盖用量（表计实测部分） */
  meteredUsage: string
  /** 估算用量（覆盖不足部分，按估算外推并显著标注） */
  estimatedUsage: string
  /** 覆盖率 = 实测 /（实测+估算）；总用量为零时为 null（不可除，不以 0 冒充 CE-03） */
  coverageRatio: string | null
}

/** CE-09：覆盖率（实测覆盖用量/总用量）可查；覆盖不足部分按估算并显著标注。 */
export function computeEnergyCoverage(meteredUsage: string, estimatedUsage: string): EnergyCoverageResult {
  const sum = add4(meteredUsage, estimatedUsage, 'CE-09')
  const coverageRatio = sum === '0.0000' ? null : div4(meteredUsage, sum, 'CE-09')
  return { meteredUsage, estimatedUsage, coverageRatio }
}

/** CE-09：估算外推强度 = 覆盖机时单耗（实测用量/覆盖机时）；覆盖机时为零 → null（不外推不冒充）。 */
export function energyIntensityPerHour(meteredUsage: string, coveredMachineHours: string): string | null {
  if (cmp4(coveredMachineHours, '0.0000', 'CE-09') <= 0) return null
  return div4(meteredUsage, coveredMachineHours, 'CE-09')
}
