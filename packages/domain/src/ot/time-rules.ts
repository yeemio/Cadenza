/**
 * 时钟偏差规则（OT-20）：|事件时间−接收时间| 超过阈值，或设备事件时间
 * 倒跳/超前于当前时间 → 样本标"时钟偏差"。偏差样本不参与班次归属自动统计
 * 与 SPC，需规则或人工确认归属。阈值默认 120 秒、按设备可配置（取值 → GAP-E3）。
 */

export const DEFAULT_CLOCK_SKEW_THRESHOLD_SECONDS = 120

export type ClockSkewKind = 'offset' | 'backward' | 'ahead'

export const CLOCK_SKEW_KIND_LABELS: Readonly<Record<ClockSkewKind, string>> = {
  offset: '事件时间与接收时间偏差超阈值',
  backward: '设备事件时间倒跳',
  ahead: '设备事件时间超前于当前时间',
}

/** 设备侧已入池最新样本（按网关单调序号取最新，用于倒跳判定）。 */
export interface DeviceLatestSampleView {
  gatewaySeq: number
  eventTime: string
}

export interface ClockSkewInput {
  eventTime: string
  /** 接收时间（服务端侧，OT-09 双轨分列） */
  receivedAt: string
  /** 服务端当前时间 */
  now: string
  /** 时钟偏差阈值（秒，按设备可配置，OT-20） */
  thresholdSeconds: number
  /** 同设备已入池最新样本（倒跳判定；无则 null） */
  deviceLatest: DeviceLatestSampleView | null
  /** 本样本网关单调序号（OT-15） */
  gatewaySeq: number
}

export interface ClockSkewResult {
  isClockSkew: boolean
  kind: ClockSkewKind | null
}

/**
 * OT-20：时钟偏差三源判定（优先级 超前 > 倒跳 > 偏差超阈值）：
 * - ahead：事件时间超前于当前时间超过阈值（设备时钟跑快）；
 * - backward：更高网关序号的事件时间早于已入池最新事件时间（设备时钟回拨；
 *   重放/补传的更低序号事件不属于倒跳，属迟到/补传语义，OT-19）；
 * - offset：|事件时间−接收时间| 超过阈值。
 */
export function classifyClockSkew(input: ClockSkewInput): ClockSkewResult {
  const eventMs = Date.parse(input.eventTime)
  const receivedMs = Date.parse(input.receivedAt)
  const nowMs = Date.parse(input.now)
  if (Number.isNaN(eventMs) || Number.isNaN(receivedMs) || Number.isNaN(nowMs)) {
    return { isClockSkew: false, kind: null }
  }
  const thresholdMs = input.thresholdSeconds * 1000
  if (eventMs - nowMs > thresholdMs) return { isClockSkew: true, kind: 'ahead' }
  if (
    input.deviceLatest !== null &&
    input.gatewaySeq > input.deviceLatest.gatewaySeq &&
    eventMs < Date.parse(input.deviceLatest.eventTime)
  ) {
    return { isClockSkew: true, kind: 'backward' }
  }
  if (Math.abs(eventMs - receivedMs) > thresholdMs) return { isClockSkew: true, kind: 'offset' }
  return { isClockSkew: false, kind: null }
}
