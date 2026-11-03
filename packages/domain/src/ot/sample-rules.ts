import { OtRuleViolation } from './errors'

/**
 * 采集样本合同规则（OT-09～OT-13）：点位身份、量纲归一、质量码映射、
 * 校准关联、工序会话关联。时间双轨分列（事件时间=设备侧、接收时间=服务端侧，
 * OT-09；同 IT-37 精神）。
 */

// ---------------- OT-09 样本形状 ----------------

export interface SampleShapeInput {
  deviceSerial: string
  pointCode: string
  eventTime: string
  rawValue: number
  rawUnit: string
  /** OT-09 必含质量码（设备侧原始质量码；三档映射见 OT-11） */
  deviceQualityCode: string
}

/** OT-09：每条样本必含字段校验（设备序列号/点位代码/事件时间/数值/原始单位/质量码）。 */
export function assertSampleShape(sample: SampleShapeInput): void {
  if (sample.deviceSerial.length === 0 || sample.deviceSerial.length > 64) {
    throw new OtRuleViolation('OT-09', '设备序列号必须为 1–64 个字符')
  }
  if (sample.pointCode.length === 0 || sample.pointCode.length > 64) {
    throw new OtRuleViolation('OT-09', '点位代码必须为 1–64 个字符')
  }
  if (Number.isNaN(Date.parse(sample.eventTime))) {
    throw new OtRuleViolation('OT-09', `事件时间（设备侧）非法：${sample.eventTime}`)
  }
  if (sample.rawUnit.length === 0 || sample.rawUnit.length > 16) {
    throw new OtRuleViolation('OT-09', '原始单位必须为 1–16 个字符')
  }
  if (!Number.isFinite(sample.rawValue)) {
    throw new OtRuleViolation('OT-09', '样本数值必须为有限数')
  }
  if (sample.deviceQualityCode.length === 0 || sample.deviceQualityCode.length > 32) {
    throw new OtRuleViolation('OT-09', '样本质量码（设备侧）必填（1–32 个字符；映射见 OT-11）')
  }
}

// ---------------- OT-10 量纲归一 ----------------

export interface UnitConversionRule {
  fromUomCode: string
  toUomCode: string
  factor: number
  revision: number
}

export interface NormalizationResult {
  /** 归一值（单位=点位工程单位；找不到换算时为 null，样本保留可查、不参与汇总） */
  normalizedValue: number | null
  /** 使用的换算版本（同单位恒等归一时为 null） */
  conversionRevision: number | null
  /** 原始单位≠点位单位且无换算规则 */
  conversionMissing: boolean
}

/**
 * OT-10：样本传输携带原始值＋原始单位；服务端按换算版本归一后入库，
 * 原始值与归一值并存；禁止边缘侧丢弃原始值只传换算值（边缘合同由 edge 网关承载）。
 */
export function normalizeSample(
  rawValue: number,
  rawUnit: string,
  pointUomCode: string,
  conversions: readonly UnitConversionRule[],
): NormalizationResult {
  if (rawUnit === pointUomCode) {
    return { normalizedValue: rawValue, conversionRevision: null, conversionMissing: false }
  }
  const rule = conversions.find((c) => c.fromUomCode === rawUnit && c.toUomCode === pointUomCode)
  if (rule === undefined || !(rule.factor > 0)) {
    return { normalizedValue: null, conversionRevision: null, conversionMissing: true }
  }
  return { normalizedValue: rawValue * rule.factor, conversionRevision: rule.revision, conversionMissing: false }
}

// ---------------- OT-11 质量码 ----------------

export const QUALITY_LEVELS = ['good', 'uncertain', 'bad'] as const
export type QualityLevel = (typeof QUALITY_LEVELS)[number]

export const QUALITY_LEVEL_LABELS: Readonly<Record<QualityLevel, string>> = {
  good: '良好',
  uncertain: '不确定',
  bad: '坏',
}

/**
 * OT-11：设备质量码 → 三档质量码（good/uncertain/bad）；
 * 映射表未配置的设备质量码一律按 uncertain 处理（缺省 fail-safe）。
 */
export function mapQualityLevel(
  deviceQualityCode: string,
  map: ReadonlyMap<string, QualityLevel>,
): QualityLevel {
  const level = map.get(deviceQualityCode)
  if (level === undefined || !QUALITY_LEVELS.includes(level)) return 'uncertain'
  return level
}

/** OT-11：质量码映射表载荷校验（档位闭合；重复码即冲突拒绝）。 */
export function assertQualityCodeMapEntries(
  entries: ReadonlyArray<{ code: string; level: string }>,
): void {
  if (entries.length > 10_000) {
    throw new OtRuleViolation('OT-11', '单设备质量码映射条目过多（上限 10000）')
  }
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.code.length === 0 || entry.code.length > 32) {
      throw new OtRuleViolation('OT-11', '设备质量码必须为 1–32 个字符')
    }
    if (!QUALITY_LEVELS.includes(entry.level as QualityLevel)) {
      throw new OtRuleViolation('OT-11', `质量码档位必须为 ${QUALITY_LEVELS.join('/')}（收到：${entry.level}）`)
    }
    if (seen.has(entry.code)) {
      throw new OtRuleViolation('OT-11', `质量码映射重复：${entry.code}`)
    }
    seen.add(entry.code)
  }
}

// ---------------- OT-12 校准关联 ----------------

/** OT-12：校准过期期间采集的样本标"校准状态可疑"（失准登记属 T23 校准域，此处承载过期判定）。 */
export function isCalibrationSuspect(
  calibrationValidUntil: string | null,
  eventTime: string,
): boolean {
  if (calibrationValidUntil === null) return false
  const untilMs = Date.parse(calibrationValidUntil)
  const eventMs = Date.parse(eventTime)
  if (Number.isNaN(untilMs) || Number.isNaN(eventMs)) return false
  return eventMs > untilMs
}

// ---------------- OT-13 工序会话关联 ----------------

export type SessionLinkStatus = 'auto_bound' | 'pending_confirm' | 'unlinked' | 'manual_bound'

export const SESSION_LINK_STATUS_LABELS: Readonly<Record<SessionLinkStatus, string>> = {
  auto_bound: '自动绑定',
  pending_confirm: '待确认',
  unlinked: '未关联',
  manual_bound: '人工绑定',
}

/** 工序执行实例投影视图（execution_session 只读等价投影，OT-13：按 设备＋时间窗 匹配）。 */
export interface SessionWindowView {
  sessionId: string
  equipmentCode: string
  /** 会话开始（业务时间口径） */
  startAt: string
  /** 会话结束（开放中会话为 null=开放端） */
  endAt: string | null
}

export interface SessionLinkResult {
  sessionId: string | null
  status: 'auto_bound' | 'pending_confirm' | 'unlinked'
}

/**
 * OT-13：样本与工序执行实例按 设备＋时间窗 匹配，关联结果三态：
 * 恰一个覆盖 → 自动绑定；多个覆盖 → 待确认；零个 → 未关联。
 * 待确认/未关联样本可人工绑定/纠错并留痕（manual_bound，应用层命令承载）；
 * 不自动静默改绑。设备维度过滤由应用侧投影承担（本函数只做时间窗判定）。
 */
export function linkSession(eventTime: string, sessions: readonly SessionWindowView[]): SessionLinkResult {
  const eventMs = Date.parse(eventTime)
  const covering = sessions.filter((s) => {
    const startMs = Date.parse(s.startAt)
    if (Number.isNaN(startMs) || eventMs < startMs) return false
    if (s.endAt === null) return true
    const endMs = Date.parse(s.endAt)
    return !Number.isNaN(endMs) && eventMs <= endMs
  })
  if (covering.length === 0) return { sessionId: null, status: 'unlinked' }
  if (covering.length === 1) return { sessionId: covering[0]!.sessionId, status: 'auto_bound' }
  return { sessionId: null, status: 'pending_confirm' }
}
