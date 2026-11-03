import type { QualityLevel } from './sample-rules'

/**
 * 容量分层与保留的汇总规则（OT-23/OT-24/OT-25/OT-S4/OT-19）：
 * - OT-23 容量基线 100 台×20 点×1 Hz=2,000 点/秒（规划负载，未现场实测）；
 * - OT-24 高频原始点写入独立采集层，不写业务事件表（business_event/Outbox）；
 *   分层 原始层 → 分钟/班次汇总层 → 业务事件层（仅显式映射生成的业务事实，OT-26）；
 * - OT-19 迟到样本补插分钟汇总、不重算已生成的班次汇总（班次汇总仅由显式
 *   重建命令生成/刷新——应用层 ot.aggregate.rebuild 承载）；
 * - OT-S4 汇总可从原始层重建，带更新时间与延迟标注（数据截至事件时间）。
 */

export type AggregateGranularity = 'minute' | 'shift'

/** 分钟窗口起点（事件时间截断到分钟，UTC）。 */
export function minuteWindowStart(eventTime: string): string {
  const ms = Date.parse(eventTime)
  if (Number.isNaN(ms)) throw new Error(`aggregate: 非法事件时间 ${eventTime}`)
  const minuteMs = Math.floor(ms / 60_000) * 60_000
  return new Date(minuteMs).toISOString()
}

/** 班次窗口起点（班次日历口径的班次日期零点标签；班次日期由应用层 computeShiftDate 计算，IT-37 口径）。 */
export function shiftWindowStartIso(shiftDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
    throw new Error(`aggregate: 非法班次日期 ${shiftDate}`)
  }
  return `${shiftDate}T00:00:00.000Z`
}

/** 参与汇总的样本形状（原始层行投影）。 */
export interface AggregateSampleInput {
  eventTime: string
  normalizedValue: number | null
  qualityLevel: QualityLevel
  isBad: boolean
  isClockSkew: boolean
  isQuarantined: boolean
}

/** 汇总行值（分钟/班次同构，OT-S4）。 */
export interface AggregateValues {
  sampleCount: number
  goodCount: number
  badCount: number
  skewCount: number
  sumValue: number
  minValue: number | null
  maxValue: number | null
  firstEventTime: string
  lastEventTime: string
}

/** OT-24：汇总层只收合格可用样本（隔离态不收；坏点/时钟偏差不计入 sampleCount）。 */
export function isAggregateEligible(sample: AggregateSampleInput): boolean {
  return !sample.isQuarantined && !sample.isBad && !sample.isClockSkew
}

/**
 * OT-19/OT-24：样本并入汇总窗口（迟到样本对分钟窗口同样并入——允许补插；
 * sum/min/max 只计 good 且已归一的样本；坏点/偏差样本只进 bad/skew 计数列）。
 */
export function mergeAggregate(
  existing: AggregateValues | null,
  sample: AggregateSampleInput,
): AggregateValues {
  const next: AggregateValues = existing ?? {
    sampleCount: 0,
    goodCount: 0,
    badCount: 0,
    skewCount: 0,
    sumValue: 0,
    minValue: null,
    maxValue: null,
    firstEventTime: sample.eventTime,
    lastEventTime: sample.eventTime,
  }
  next.sampleCount = (existing?.sampleCount ?? 0)
  next.goodCount = (existing?.goodCount ?? 0)
  next.badCount = (existing?.badCount ?? 0)
  next.skewCount = (existing?.skewCount ?? 0)
  next.sumValue = existing?.sumValue ?? 0
  next.minValue = existing?.minValue ?? null
  next.maxValue = existing?.maxValue ?? null
  next.firstEventTime = existing?.firstEventTime ?? sample.eventTime
  next.lastEventTime = existing?.lastEventTime ?? sample.eventTime

  if (sample.isQuarantined) return next
  if (sample.isBad) next.badCount += 1
  if (sample.isClockSkew) next.skewCount += 1
  if (!isAggregateEligible(sample)) return next

  next.sampleCount += 1
  if (sample.qualityLevel === 'good' && sample.normalizedValue !== null) {
    next.goodCount += 1
    next.sumValue += sample.normalizedValue
    next.minValue = next.minValue === null ? sample.normalizedValue : Math.min(next.minValue, sample.normalizedValue)
    next.maxValue = next.maxValue === null ? sample.normalizedValue : Math.max(next.maxValue, sample.normalizedValue)
  }
  if (Date.parse(sample.eventTime) < Date.parse(next.firstEventTime)) {
    next.firstEventTime = sample.eventTime
  }
  if (Date.parse(sample.eventTime) > Date.parse(next.lastEventTime)) {
    next.lastEventTime = sample.eventTime
  }
  return next
}
