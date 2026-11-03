import { OtRuleViolation } from './errors'

/**
 * 采集值→业务事实映射规则（OT-26）：须经版本化的显式映射配置＋确认规则
 * （哪些点位可自动入账、哪些须人工确认）；由样本生成的业务事实走正常命令链路
 * （幂等、审计、Outbox——应用层 ot.mapping.evaluate/confirm 命令承载）。
 * 遥测补传只补数据，不自动生成/重放业务命令（OT-18/OT-03：评估是显式命令，
 * 不挂在入池链路上）。
 */

export const BUSINESS_FACT_KINDS = ['meter_to_quantity', 'stop_to_downtime'] as const
export type BusinessFactKind = (typeof BUSINESS_FACT_KINDS)[number]

export const BUSINESS_FACT_KIND_LABELS: Readonly<Record<BusinessFactKind, string>> = {
  meter_to_quantity: '计长→报工数量',
  stop_to_downtime: '停机信号→停机事件',
}

export const CONFIRM_MODES = ['auto', 'manual'] as const
export type ConfirmMode = (typeof CONFIRM_MODES)[number]

export interface MappingSpecInput {
  factKind: string
  confirmMode: string
  /** 映射点位是否参与业务判定（OT-08：不参与业务判定的点位不得映射） */
  participatesInBusiness: boolean
}

/** OT-26/OT-08：映射配置校验。 */
export function assertMappingSpec(spec: MappingSpecInput): void {
  if (!BUSINESS_FACT_KINDS.includes(spec.factKind as BusinessFactKind)) {
    throw new OtRuleViolation('OT-26', `业务事实种类必须为 ${BUSINESS_FACT_KINDS.join('/')}（收到：${spec.factKind}）`)
  }
  if (!CONFIRM_MODES.includes(spec.confirmMode as ConfirmMode)) {
    throw new OtRuleViolation('OT-26', `确认规则必须为 ${CONFIRM_MODES.join('/')}（收到：${spec.confirmMode}）`)
  }
  if (!spec.participatesInBusiness) {
    throw new OtRuleViolation('OT-08', '只有参与业务判定的点位可配置业务事实映射（participatesInBusiness=false）')
  }
}

/** 映射评估的输入样本（原始层投影：仅合格可用样本参与，OT-21/OT-20 排除语义随行）。 */
export interface MappingSampleInput {
  eventTime: string
  normalizedValue: number | null
  qualityLevel: 'good' | 'uncertain' | 'bad'
  isBad: boolean
  isClockSkew: boolean
  isQuarantined: boolean
}

/** 按事件时间排序后传入（乱序由调用方先行排序，OT-19 口径）。 */
export function usableSamplesForMapping(samples: readonly MappingSampleInput[]): MappingSampleInput[] {
  return samples.filter((s) => !s.isQuarantined && !s.isBad && !s.isClockSkew)
}

/**
 * OT-26 计长→报工数量：窗口内合格样本归一值求和；
 * OT-28 缺采集不产生假值——无合格样本返回 null（不以 0 冒充实测）。
 */
export function evaluateMeterToQuantity(
  samples: readonly MappingSampleInput[],
): { quantity: string | null } {
  const usable = usableSamplesForMapping(samples)
  if (usable.length === 0) return { quantity: null }
  let sum = 0
  let counted = 0
  for (const s of usable) {
    if (s.normalizedValue !== null) {
      sum += s.normalizedValue
      counted += 1
    }
  }
  if (counted === 0) return { quantity: null }
  return { quantity: sum.toFixed(4) }
}

export interface StopRunInterval {
  startedAt: string
  endedAt: string
  /** 信号仍处于停机状态（窗口末端未见恢复样本） */
  stillRunning: boolean
  durationSeconds: number
}

export interface StopToDowntimeParams {
  /** 停机电平（样本值 >= stopLevel 视为停机；缺省 1） */
  stopLevel?: number
}

/**
 * OT-26 停机信号→停机事件：极大连续停机段各生成一个候选事实；
 * 段终点=段后首个非停机样本事件时间（信号恢复时点），窗口末端未恢复时
 * 以段内最后样本事件时间收口并标 stillRunning（不虚构恢复时点——OT-28）。
 */
export function evaluateStopToDowntime(
  samples: readonly MappingSampleInput[],
  params: StopToDowntimeParams = {},
): StopRunInterval[] {
  const level = params.stopLevel ?? 1
  const usable = usableSamplesForMapping(samples)
  const intervals: StopRunInterval[] = []
  let runStart: string | null = null
  let runLast: string | null = null
  const closeRun = (endedAt: string, stillRunning: boolean): void => {
    if (runStart === null || runLast === null) return
    intervals.push({
      startedAt: runStart,
      endedAt,
      stillRunning,
      durationSeconds: Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(runStart)) / 1000)),
    })
    runStart = null
    runLast = null
  }
  for (const s of usable) {
    const stopped = s.normalizedValue !== null && s.normalizedValue >= level
    if (stopped) {
      if (runStart === null) runStart = s.eventTime
      runLast = s.eventTime
    } else if (runStart !== null && runLast !== null) {
      closeRun(s.eventTime, false)
    }
  }
  if (runStart !== null && runLast !== null) closeRun(runLast, true)
  return intervals
}
