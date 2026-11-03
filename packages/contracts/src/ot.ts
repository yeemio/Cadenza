import type { DecimalString } from './decimal'
import type { PageResult } from './pagination'

/**
 * ot 域公开线合同（P3-A / T21 设备与仪器采集）。
 *
 * 依据：冻结合同 architecture/contracts/frozen/p3/ot-collection.md（OT-01～OT-31 +
 * OT-S1～S5）。要点：遥测通道只读（OT-03）；时间双轨分列（OT-09）；量纲原始值与
 * 归一值并存（OT-10）；重传去重三元组 (device_serial, event_id)（OT-16）；容量分层
 * 不写业务事件表（OT-24）；真实设备协议接入一律 SITE_PENDING（OT-31：模拟环境证据
 * 须标明）。数量类结果字段（业务事实 value）一律 DecimalString（IT-07 口径随行）；
 * 遥测原始值为设备侧数值（number），与业务数量分列。
 * - 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）。
 */

// ---------------- 状态字典值 ----------------

/** 网关运行状态（OT-06：按最后心跳与超时阈值推导）。 */
export type GatewayRunStatusValue = 'online' | 'offline'

/** 网关事件种类（OT-06：离线/恢复事件留痕并告警）。 */
export type GatewayEventKindValue = 'registered' | 'heartbeat_restored' | 'offline' | 'overflow'

/** 质量码三档（OT-11：good/uncertain/bad 起步；未配置映射缺省 uncertain）。 */
export type QualityLevelValue = 'good' | 'uncertain' | 'bad'

/** 时钟偏差种类（OT-20：偏差超阈值/倒跳/超前）。 */
export type ClockSkewKindValue = 'offset' | 'backward' | 'ahead'

/** 工序会话关联状态（OT-13 三态 + 人工绑定留痕态）。 */
export type SessionLinkStatusValue = 'auto_bound' | 'pending_confirm' | 'unlinked' | 'manual_bound'

/** 点位语义（OT-08）。 */
export type PointSemanticValue =
  | 'meter_length'
  | 'speed'
  | 'temperature'
  | 'weight'
  | 'stop_signal'
  | 'inspection_result'
  | 'other'

/** 汇总粒度（OT-24：分钟/班次分层）。 */
export type AggregateGranularityValue = 'minute' | 'shift'

/** 业务事实种类（OT-26）。 */
export type BusinessFactKindValue = 'meter_to_quantity' | 'stop_to_downtime'

/** 确认规则（OT-26：自动入账/须人工确认）。 */
export type ConfirmModeValue = 'auto' | 'manual'

/** 业务事实状态（OT-26：待确认 → 已派发（走正常命令链路 Outbox））。 */
export type BusinessFactStatusValue = 'pending_confirm' | 'dispatched'

// ---------------- 查询侧 DTO ----------------

/** 网关注册表视图（OT-06/OT-S3）。 */
export interface OtGatewayDto {
  gatewayId: string
  gatewayCode: string
  plantId: string
  protocolConfig: Record<string, unknown>
  sampleRateHz: number
  bufferCapacity: number
  heartbeatTimeoutSeconds: number
  status: GatewayRunStatusValue
  statusLabel: string
  lastHeartbeatAt: string | null
  /** 检查点序号（OT-15：网关重装后从持久检查点续发） */
  checkpointSeq: number
  /** 最近一次上报的缓冲积压（OT-29 监控项） */
  lastBacklogCount: number
  deviceCount: number
}

export type OtGatewayPage = PageResult<OtGatewayDto>

/** 网关事件视图（OT-06：留痕并告警）。 */
export interface OtGatewayEventDto {
  eventId: string
  gatewayCode: string
  eventKind: GatewayEventKindValue
  eventKindLabel: string
  detail: Record<string, unknown>
  occurredAt: string
  createdBy: string | null
}

/** 设备映射视图（OT-07：持久设备序列号 → equipment 主档）。 */
export interface OtDeviceDto {
  deviceSerial: string
  plantId: string
  gatewayCode: string | null
  equipmentId: string | null
  equipmentCode: string | null
  boundBy: string | null
  boundAt: string | null
  clockSkewThresholdSeconds: number
  /** 采集延迟（OT-29：该设备最后样本距今秒数；null=无样本——缺项不冒充，OT-28） */
  lastSampleAgeSeconds: number | null
  lastSampleAt: string | null
  quarantinedSampleCount: number
}

/** 点位字典视图（OT-08/OT-S2）。 */
export interface OtPointDto {
  pointId: string
  plantId: string
  deviceSerial: string
  pointCode: string
  semantic: PointSemanticValue
  semanticLabel: string
  uomId: string | null
  uomCode: string
  sampleRateSeconds: number
  rangeMin: string | null
  rangeMax: string | null
  participatesInBusiness: boolean
  calibrationRecordNo: string | null
  calibrationValidUntil: string | null
  version: number
}

/** 采集样本视图（OT-09/OT-22：坏点与偏差样本保留可查、带原因）。 */
export interface OtSampleDto {
  sampleId: string
  deviceSerial: string
  pointCode: string
  eventId: string
  gatewaySeq: number
  eventTime: string
  receivedAt: string
  gatewayCode: string
  rawValue: string
  rawUnit: string
  normalizedValue: string | null
  conversionRevision: number | null
  qualityLevel: QualityLevelValue
  qualityLabel: string
  deviceQualityCode: string | null
  isBad: boolean
  badReasons: string[]
  isClockSkew: boolean
  clockSkewKind: ClockSkewKindValue | null
  isLate: boolean
  calibrationSuspect: boolean
  sessionId: string | null
  sessionLinkStatus: SessionLinkStatusValue
  sessionLinkStatusLabel: string
  isQuarantined: boolean
  quarantineReason: string | null
}

export type OtSamplePage = PageResult<OtSampleDto>

/** 汇总投影视图（OT-25：带更新时间与延迟标注）。 */
export interface OtAggregateDto {
  aggregateId: string
  deviceSerial: string
  pointCode: string
  granularity: AggregateGranularityValue
  windowStart: string
  sampleCount: number
  goodCount: number
  badCount: number
  skewCount: number
  sumValue: string
  minValue: string | null
  maxValue: string | null
  firstEventTime: string
  lastEventTime: string
  updatedAt: string
}

export type OtAggregatePage = PageResult<OtAggregateDto>

/** 业务映射配置视图（OT-26：版本化显式映射 + 确认规则）。 */
export interface OtMappingDto {
  mappingId: string
  plantId: string
  deviceSerial: string
  pointCode: string
  factKind: BusinessFactKindValue
  factKindLabel: string
  confirmMode: ConfirmModeValue
  confirmModeLabel: string
  params: Record<string, unknown>
  version: number
}

/** 业务事实候选视图（OT-26）。 */
export interface OtBusinessFactDto {
  factId: string
  mappingId: string
  mappingVersion: number
  factKind: BusinessFactKindValue
  factKindLabel: string
  deviceSerial: string
  pointCode: string
  windowStart: string
  windowEnd: string
  value: DecimalString | null
  payload: Record<string, unknown>
  status: BusinessFactStatusValue
  statusLabel: string
  confirmedBy: string | null
  confirmedAt: string | null
  outboxEventId: string | null
}

export type OtBusinessFactPage = PageResult<OtBusinessFactDto>

/** 溢出/去重统计视图（OT-S5：按网关/设备/日累计，可对账）。 */
export interface OtStatsDto {
  statDate: string
  gatewayCode: string
  deviceSerial: string
  dedupCount: number
  overflowCount: number
  overflowFirstAt: string | null
  overflowLastAt: string | null
}

export type OtStatsPage = PageResult<OtStatsDto>

/** 监控总览（OT-29 必监项 + OT-28 缺项语义）。 */
export interface OtMonitorOverviewDto {
  gateways: Array<{
    gatewayCode: string
    plantId: string
    status: GatewayRunStatusValue
    statusLabel: string
    lastHeartbeatAt: string | null
    staleSeconds: number | null
    backlogCount: number
  }>
  deviceLatency: Array<{
    deviceSerial: string
    equipmentCode: string | null
    lastSampleAt: string | null
    latencySeconds: number | null
    /** OT-28：无样本 → true，相关指标展示缺项、不以估算冒充实测 */
    noData: boolean
  }>
  dedup: Array<{
    statDate: string
    gatewayCode: string
    deviceSerial: string
    dedupCount: number
    dedupAnomaly: boolean
  }>
  overflow: Array<{
    statDate: string
    gatewayCode: string
    deviceSerial: string
    overflowCount: number
  }>
}

// ---------------- 命令载荷 ----------------

/** ot.gateway.register：网关注册（OT-06：工厂/标识/设备清单/协议配置/采样率/缓冲容量）。 */
export interface OtGatewayRegisterPayload {
  operationId?: string
  plantId: string
  gatewayCode: string
  /** 协议配置（OT-05：统一数据合同，不因协议差异产生第二套点词语义） */
  protocolConfig?: Record<string, unknown>
  sampleRateHz?: number
  bufferCapacity?: number
  heartbeatTimeoutSeconds?: number
  /** 所辖设备清单（登记设备序列号；设备映射另经 ot.device.bind） */
  deviceSerials?: string[]
  reason?: string
}

/** ot.gateway.heartbeat：网关心跳（OT-06：更新最后心跳；恢复事件留痕）。 */
export interface OtGatewayHeartbeatPayload {
  operationId?: string
  gatewayCode: string
  /** 边缘侧随心跳上报的缓冲积压（OT-29 监控项；缺省 0） */
  backlogCount?: number
  reason?: string
}

/** ot.gateway.monitor：网关巡检（OT-29：心跳超时 → 离线事件留痕并告警）。 */
export interface OtGatewayMonitorPayload {
  operationId?: string
  plantId?: string
  reason?: string
}

/** ot.device.bind：设备映射（OT-07：序列号 → equipment 主档；解除映射传 null）。 */
export interface OtDeviceBindPayload {
  operationId?: string
  plantId: string
  deviceSerial: string
  gatewayCode?: string
  equipmentId?: string | null
  /** OT-20：时钟偏差阈值（秒，按设备可配置；缺省 120） */
  clockSkewThresholdSeconds?: number
  reason?: string
}

/** ot.point.upsert：点位字典登记/更新（OT-08：版本化）。 */
export interface OtPointUpsertPayload {
  operationId?: string
  plantId: string
  deviceSerial: string
  points: Array<{
    pointCode: string
    semantic: PointSemanticValue
    uomId?: string
    uomCode: string
    sampleRateSeconds: number
    rangeMin?: number | null
    rangeMax?: number | null
    participatesInBusiness?: boolean
    calibrationRecordNo?: string | null
    calibrationValidUntil?: string | null
  }>
  reason?: string
}

/** ot.quality-map.upsert：设备质量码映射表（OT-11：版本化；未配置缺省 uncertain）。 */
export interface OtQualityMapUpsertPayload {
  operationId?: string
  plantId: string
  deviceSerial: string
  entries: Array<{ code: string; level: QualityLevelValue }>
  reason?: string
}

/** ot.conversion.upsert：单位换算版本（OT-10：归一按换算版本）。 */
export interface OtConversionUpsertPayload {
  operationId?: string
  plantId: string
  fromUomCode: string
  toUomCode: string
  factor: number
  reason?: string
}

/** ot.samples.ingest：遥测批量入池（OT-09～OT-24；遥测通道只读，不承载业务命令 OT-03）。 */
export interface OtSamplesIngestPayload {
  operationId?: string
  gatewayCode: string
  /** OT-14：缓冲条目必带 持久设备序列号＋事件时间＋唯一事件 ID（边缘构造，OT-15） */
  samples: Array<{
    deviceSerial: string
    pointCode: string
    eventId: string
    eventTime: string
    rawValue: number
    rawUnit: string
    /** OT-09 必含质量码（设备侧原始码；映射见 OT-11，未配置缺省 uncertain） */
    deviceQualityCode: string
  }>
  /** OT-17：边缘上报溢出统计（条数/时段/设备）；缺省无溢出 */
  overflow?: {
    count: number
    firstAt: string
    lastAt: string
    deviceSerials?: string[]
  } | null
  /** 边缘侧缓冲积压（OT-29 监控项；缺省 0） */
  backlogCount?: number
  /** OT-15：网关持久检查点序号（随批次上报；重装后从检查点续发） */
  checkpointSeq?: number
  reason?: string
}

/** ot.session.link：样本-工序会话人工绑定/纠错（OT-13：留痕，不自动静默改绑）。 */
export interface OtSessionLinkPayload {
  operationId?: string
  plantId: string
  sampleId: string
  /** 目标会话（null=解除绑定） */
  sessionId: string | null
  reason?: string
}

/** ot.aggregate.rebuild：汇总显式重建（OT-S4/OT-19：从原始层重建，班次汇总仅由此生成）。 */
export interface OtAggregateRebuildPayload {
  operationId?: string
  plantId?: string
  deviceSerial?: string
  granularity: AggregateGranularityValue
  from: string
  to: string
  reason?: string
}

/** ot.mapping.upsert：业务事实映射配置（OT-26：版本化 + 确认规则）。 */
export interface OtMappingUpsertPayload {
  operationId?: string
  plantId: string
  deviceSerial: string
  pointCode: string
  factKind: BusinessFactKindValue
  confirmMode: ConfirmModeValue
  params?: Record<string, unknown>
  reason?: string
}

/** ot.mapping.evaluate：映射评估（OT-26：显式命令生成业务事实候选并走命令链路）。 */
export interface OtMappingEvaluatePayload {
  operationId?: string
  plantId: string
  mappingId: string
  from: string
  to: string
  reason?: string
}

/** ot.mapping.confirm：人工确认（OT-26：manual 模式候选经确认后派发）。 */
export interface OtMappingConfirmPayload {
  operationId?: string
  plantId: string
  factId: string
  reason?: string
}
