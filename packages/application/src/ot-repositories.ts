import type { OutboxIntent } from './unit-of-work'
import type { CommandTools } from './command-bus'

/**
 * 线合同字典值（与 contracts/src/ot.ts 同源同值；contracts 面未并入包名入口——
 * index.ts 为共享文件不改动，故本文件本地声明同值联合，L0 整合后可改包名导入）。
 */
export type GatewayRunStatusValue = 'online' | 'offline'
export type GatewayEventKindValue = 'registered' | 'heartbeat_restored' | 'offline' | 'overflow'
export type QualityLevelValue = 'good' | 'uncertain' | 'bad'
export type ClockSkewKindValue = 'offset' | 'backward' | 'ahead'
export type SessionLinkStatusValue = 'auto_bound' | 'pending_confirm' | 'unlinked' | 'manual_bound'
export type AggregateGranularityValue = 'minute' | 'shift'
export type BusinessFactKindValue = 'meter_to_quantity' | 'stop_to_downtime'
export type ConfirmModeValue = 'auto' | 'manual'
export type BusinessFactStatusValue = 'pending_confirm' | 'dispatched'

/**
 * ot 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0017 ot 表列一一对应；时间字段一律 ISO-8601 字符串；
 * 业务数量（业务事实 value）DecimalString；遥测原始值为字符串化十进制（numeric 列读出）。
 *
 * OtCommandTools = CommandTools（org 基础）+ ot 仓储束 + Outbox 写入器（OT-26 业务事实
 * 走正常命令链路）+ 隔离队列写入（OT-07/IF-00.8）+ 跨域只读投影（工序会话/设备主档——
 * 各归属域文件不自改，等价只读端口模式，L0 整合时可收编）。
 */

// ---------------- 记录类型 ----------------

export interface OtGatewayRecord {
  id: string
  gatewayCode: string
  protocolConfig: Record<string, unknown>
  sampleRateHz: number
  bufferCapacity: number
  heartbeatTimeoutSeconds: number
  lastHeartbeatAt: string | null
  status: GatewayRunStatusValue
  lastStatusChangedAt: string | null
  checkpointSeq: number
  lastBacklogCount: number
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewOtGateway {
  gatewayCode: string
  protocolConfig?: Record<string, unknown>
  sampleRateHz?: number
  bufferCapacity?: number
  heartbeatTimeoutSeconds?: number
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface OtGatewayEventRecord {
  id: string
  gatewayCode: string
  eventKind: GatewayEventKindValue
  detail: Record<string, unknown>
  occurredAt: string
  createdBy: string | null
}

export interface NewOtGatewayEvent {
  gatewayCode: string
  eventKind: GatewayEventKindValue
  detail?: Record<string, unknown>
  occurredAt: string
  createdBy?: string | null
  plantId: string
  enterpriseId: string
}

export interface OtDeviceRecord {
  deviceSerial: string
  gatewayCode: string | null
  equipmentId: string | null
  boundBy: string | null
  boundAt: string | null
  clockSkewThresholdSeconds: number
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewOtDevice {
  deviceSerial: string
  gatewayCode?: string | null
  equipmentId?: string | null
  boundBy?: string | null
  boundAt?: string | null
  clockSkewThresholdSeconds?: number
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface OtPointRecord {
  id: string
  deviceSerial: string
  pointCode: string
  semantic: string
  uomId: string | null
  uomCode: string
  sampleRateSeconds: number
  rangeMin: string | null
  rangeMax: string | null
  participatesInBusiness: boolean
  calibrationRecordNo: string | null
  calibrationValidUntil: string | null
  version: number
  plantId: string
  enterpriseId: string
  updatedAt: string
  updatedBy: string | null
}

export interface NewOtPoint {
  deviceSerial: string
  pointCode: string
  semantic: string
  uomId?: string | null
  uomCode: string
  sampleRateSeconds: number
  rangeMin?: number | null
  rangeMax?: number | null
  participatesInBusiness?: boolean
  calibrationRecordNo?: string | null
  calibrationValidUntil?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface OtQualityCodeMapEntryRecord {
  deviceSerial: string
  deviceQualityCode: string
  qualityLevel: QualityLevelValue
  mapVersion: number
}

export interface NewOtQualityCodeMapEntry {
  deviceSerial: string
  deviceQualityCode: string
  qualityLevel: QualityLevelValue
  mapVersion: number
}

export interface OtConversionRecord {
  fromUomCode: string
  toUomCode: string
  factor: number
  revision: number
  plantId: string
}

export interface NewOtConversion {
  fromUomCode: string
  toUomCode: string
  factor: number
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface OtSampleRecord {
  id: string
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
  conversionMissing: boolean
  qualityLevel: QualityLevelValue
  deviceQualityCode: string | null
  isBad: boolean
  badReasons: string[]
  isClockSkew: boolean
  clockSkewKind: ClockSkewKindValue | null
  isLate: boolean
  calibrationSuspect: boolean
  sessionId: string | null
  sessionLinkStatus: SessionLinkStatusValue
  isQuarantined: boolean
  quarantineReason: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
}

/** 入池插入载荷（分类列由管线计算后写入；OT-16 唯一键 (device_serial, event_id)）。 */
export interface NewOtSample {
  deviceSerial: string
  pointCode: string
  eventId: string
  gatewaySeq: number
  eventTime: string
  receivedAt: string
  gatewayCode: string
  rawValue: number
  rawUnit: string
  normalizedValue: number | null
  conversionRevision: number | null
  conversionMissing: boolean
  qualityLevel: QualityLevelValue
  deviceQualityCode: string | null
  isBad: boolean
  badReasons: string[]
  isClockSkew: boolean
  clockSkewKind: ClockSkewKindValue | null
  isLate: boolean
  calibrationSuspect: boolean
  sessionId: string | null
  sessionLinkStatus: SessionLinkStatusValue
  isQuarantined: boolean
  quarantineReason: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
  commandReceiptId?: string | null
}

/** 再处理补丁（OT-07 人工补绑后重跑分类管线；原始事实列由库级触发器保护）。 */
export interface OtSampleReprocessPatch {
  normalizedValue: number | null
  conversionRevision: number | null
  conversionMissing: boolean
  qualityLevel: QualityLevelValue
  isBad: boolean
  badReasons: string[]
  isClockSkew: boolean
  clockSkewKind: ClockSkewKindValue | null
  isLate: boolean
  calibrationSuspect: boolean
  sessionId: string | null
  sessionLinkStatus: SessionLinkStatusValue
  isQuarantined: boolean
  quarantineReason: string | null
}

export interface OtAggregateRecord {
  id: string
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

export interface OtAggregateUpsert {
  deviceSerial: string
  pointCode: string
  granularity: AggregateGranularityValue
  windowStart: string
  sampleCount: number
  goodCount: number
  badCount: number
  skewCount: number
  sumValue: number
  minValue: number | null
  maxValue: number | null
  firstEventTime: string
  lastEventTime: string
  plantId: string
  enterpriseId: string
  updatedBy?: string | null
}

export interface OtStatsRecord {
  statDate: string
  gatewayCode: string
  deviceSerial: string
  dedupCount: number
  overflowCount: number
  overflowFirstAt: string | null
  overflowLastAt: string | null
  plantId: string
}

export interface NewOtOverflowStat {
  statDate: string
  gatewayCode: string
  deviceSerial: string
  count: number
  firstAt: string
  lastAt: string
  plantId: string
  enterpriseId: string
}

export interface OtMappingRecord {
  id: string
  deviceSerial: string
  pointCode: string
  factKind: BusinessFactKindValue
  confirmMode: ConfirmModeValue
  params: Record<string, unknown>
  version: number
  plantId: string
  enterpriseId: string
  updatedAt: string
}

export interface NewOtMapping {
  deviceSerial: string
  pointCode: string
  factKind: BusinessFactKindValue
  confirmMode: ConfirmModeValue
  params?: Record<string, unknown>
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface OtBusinessFactRecord {
  id: string
  mappingId: string
  mappingVersion: number
  factKind: BusinessFactKindValue
  deviceSerial: string
  pointCode: string
  windowStart: string
  windowEnd: string
  value: string | null
  payload: Record<string, unknown>
  status: BusinessFactStatusValue
  confirmedBy: string | null
  confirmedAt: string | null
  outboxEventId: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
}

export interface NewOtBusinessFact {
  mappingId: string
  mappingVersion: number
  factKind: BusinessFactKindValue
  deviceSerial: string
  pointCode: string
  windowStart: string
  windowEnd: string
  value: string | null
  payload: Record<string, unknown>
  status: BusinessFactStatusValue
  plantId: string
  enterpriseId: string
  createdBy?: string | null
  commandReceiptId?: string | null
}

// ---------------- 仓储端口 ----------------

export interface OtGatewayRepository {
  /** OT-06：注册/更新（网关标识唯一；重复注册幂等更新配置并留 registered 事件）。 */
  upsert(gateway: NewOtGateway): Promise<OtGatewayRecord>
  findByCode(gatewayCode: string): Promise<OtGatewayRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    status?: string
    page: number
    pageSize: number
  }): Promise<{ items: OtGatewayRecord[]; total: number }>
  /** OT-06/OT-29：心跳更新最后心跳与积压上报；返回更新后行（状态推进由调用方判定）。 */
  updateHeartbeat(
    gatewayCode: string,
    patch: { backlogCount: number; heartbeatAt: string; actor: string | null },
  ): Promise<OtGatewayRecord | null>
  /** OT-06：状态推进（离线/恢复事件由调用方留痕）。 */
  updateStatus(
    gatewayCode: string,
    patch: { status: GatewayRunStatusValue; changedAt: string; actor: string | null },
  ): Promise<OtGatewayRecord | null>
  /** OT-15/S3：检查点序号推进（随上报批次落库）。 */
  setCheckpoint(gatewayCode: string, checkpointSeq: number): Promise<void>
  /** OT-29：边缘侧缓冲积压上报（随入池批次更新，不入池时也可上报）。 */
  updateBacklog(gatewayCode: string, backlogCount: number): Promise<void>
  countDevices(gatewayCode: string): Promise<number>
  /** OT-29：巡检全量（监控命令按范围收敛，不分页）。 */
  listAll(filter: { plantIds: string[] | null; plantId?: string }): Promise<OtGatewayRecord[]>
}

export interface OtGatewayEventRepository {
  insert(event: NewOtGatewayEvent): Promise<OtGatewayEventRecord>
  listByGateway(gatewayCode: string, limit: number): Promise<OtGatewayEventRecord[]>
}

export interface OtDeviceRepository {
  /** OT-07：设备序列号登记/映射（equipment 可空=未映射；重复 upsert 幂等更新）。 */
  upsert(device: NewOtDevice): Promise<OtDeviceRecord>
  findBySerial(deviceSerial: string): Promise<OtDeviceRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    gatewayCode?: string
    page: number
    pageSize: number
  }): Promise<{ items: OtDeviceRecord[]; total: number }>
}

export interface OtPointRepository {
  /** OT-08：点位登记/更新（同 (plant, code) 更新时版本 +1；字典版本化）。 */
  upsert(point: NewOtPoint): Promise<OtPointRecord>
  findByPlantAndCode(plantId: string, pointCode: string): Promise<OtPointRecord | null>
  findByDeviceAndCode(deviceSerial: string, pointCode: string): Promise<OtPointRecord | null>
  listByDevice(deviceSerial: string): Promise<OtPointRecord[]>
}

export interface OtQualityCodeMapRepository {
  /** OT-11：整表替换设备质量码映射（同设备共享新 map_version；版本化）。 */
  replaceForDevice(
    deviceSerial: string,
    entries: ReadonlyArray<{ code: string; level: QualityLevelValue }>,
    context: { plantId: string; enterpriseId: string; actor: string | null },
  ): Promise<OtQualityCodeMapEntryRecord[]>
  listByDevice(deviceSerial: string): Promise<OtQualityCodeMapEntryRecord[]>
}

export interface OtConversionRepository {
  /** OT-10：换算版本登记（同 (plant, from, to) 更新时 revision +1）。 */
  upsert(conversion: NewOtConversion): Promise<OtConversionRecord>
  find(plantId: string, fromUomCode: string, toUomCode: string): Promise<OtConversionRecord | null>
}

export interface OtSampleListFilter {
  plantIds: string[] | null
  /** OT-25：页面不扫高频原始点位——样本查询必须按设备收敛（必填）。 */
  deviceSerial: string
  pointCode?: string
  qualityLevel?: string
  isBad?: boolean
  isClockSkew?: boolean
  isLate?: boolean
  isQuarantined?: boolean
  from?: string
  to?: string
  page: number
  pageSize: number
}

export interface OtSampleRepository {
  /** OT-16：唯一键 (device_serial, event_id) 插入；冲突（重传）返回 null，由调用方累计去重。 */
  insertOnConflictSkip(sample: NewOtSample): Promise<OtSampleRecord | null>
  findById(id: string): Promise<OtSampleRecord | null>
  /** OT-15/OT-20：设备已入池最新样本（按网关单调序号；倒跳判定基准）。 */
  findLatestByDevice(deviceSerial: string): Promise<{ gatewaySeq: number; eventTime: string } | null>
  /** OT-19：设备已入池最大事件时间（迟到判定基准）。 */
  findMaxEventTimeByDevice(deviceSerial: string): Promise<string | null>
  /** OT-07：设备隔离态样本（人工补绑后再处理）。 */
  listQuarantinedByDevice(deviceSerial: string): Promise<OtSampleRecord[]>
  /** OT-S4：重建窗口内原始样本（含隔离态行——重建只统计合格样本，隔离态行不计数）。 */
  listByDeviceWindow(deviceSerial: string, from: string, to: string): Promise<OtSampleRecord[]>
  listPaged(filter: OtSampleListFilter): Promise<{ items: OtSampleRecord[]; total: number }>
  /** OT-S4：重建窗口内出现过样本的设备清单（无 deviceSerial 的全厂重建按此收敛）。 */
  listDevicesWithSamples(filter: { plantId?: string; from: string; to: string }): Promise<string[]>
  /** OT-13：人工绑定/纠错（留痕由审计承担；库级触发器保护原始事实列）。 */
  updateSessionLink(
    id: string,
    patch: { sessionId: string | null; sessionLinkStatus: SessionLinkStatusValue },
    actor: string | null,
  ): Promise<OtSampleRecord | null>
  /** OT-07：补绑后再处理（重跑分类管线；清隔离态或更新隔离原因）。 */
  applyReprocess(id: string, patch: OtSampleReprocessPatch, actor: string | null): Promise<OtSampleRecord | null>
}

export interface OtAggregateRepository {
  findByWindow(
    deviceSerial: string,
    pointCode: string,
    granularity: AggregateGranularityValue,
    windowStart: string,
  ): Promise<OtAggregateRecord | null>
  /** OT-24：分钟窗口增量并入（迟到补插同窗，OT-19）。 */
  upsert(aggregate: OtAggregateUpsert): Promise<OtAggregateRecord>
  /** OT-S4：重建——窗口范围内删除后重写（不触发外部调用与二次扣账）。 */
  deleteRange(filter: {
    plantId?: string
    deviceSerial?: string
    granularity: AggregateGranularityValue
    from: string
    to: string
  }): Promise<number>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    deviceSerial?: string
    pointCode?: string
    granularity?: string
    from?: string
    to?: string
    page: number
    pageSize: number
  }): Promise<{ items: OtAggregateRecord[]; total: number }>
}

export interface OtStatsRepository {
  /** OT-16：去重计数累计（可观测）。 */
  bumpDedup(stat: {
    statDate: string
    gatewayCode: string
    deviceSerial: string
    delta: number
    plantId: string
    enterpriseId: string
  }): Promise<void>
  /** OT-17：溢出统计累计（条数/时段/设备）。 */
  upsertOverflow(stat: NewOtOverflowStat): Promise<void>
  listPaged(filter: {
    plantIds: string[] | null
    statDate?: string
    gatewayCode?: string
    page: number
    pageSize: number
  }): Promise<{ items: OtStatsRecord[]; total: number }>
  listByDeviceSerials(
    deviceSerials: string[],
    filter: { dedupAbove?: number },
  ): Promise<OtStatsRecord[]>
}

export interface OtMappingRepository {
  /** OT-26：映射配置登记/更新（同点位 active 至多一条；更新版本 +1）。 */
  upsert(mapping: NewOtMapping): Promise<OtMappingRecord>
  findById(id: string): Promise<OtMappingRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    deviceSerial?: string
    page: number
    pageSize: number
  }): Promise<{ items: OtMappingRecord[]; total: number }>
}

export interface OtBusinessFactRepository {
  insert(fact: NewOtBusinessFact): Promise<OtBusinessFactRecord>
  findByKey(mappingId: string, windowStart: string, windowEnd: string): Promise<OtBusinessFactRecord | null>
  findById(id: string): Promise<OtBusinessFactRecord | null>
  /** OT-26：派发推进（auto 评估/人工确认后写 outbox_event_id）。 */
  markDispatched(
    id: string,
    patch: { outboxEventId: string; confirmedBy?: string | null; confirmedAt?: string | null },
    actor: string | null,
  ): Promise<OtBusinessFactRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    mappingId?: string
    status?: string
    page: number
    pageSize: number
  }): Promise<{ items: OtBusinessFactRecord[]; total: number }>
}

// ---------------- 跨域只读投影（归属域文件不自改：等价端口 + L0 收编清单） ----------------

/** OT-13：工序执行实例只读投影（execution_session 等价读，时间窗匹配）。 */
export interface OtSessionLookup {
  findSessionWindows(equipmentCode: string, window: { from: string; to: string }): Promise<
    Array<{ sessionId: string; equipmentCode: string; startAt: string; endAt: string | null }>
  >
  /** OT-13：人工绑定目标会话校验（存在性 + 设备归属）。 */
  findSessionById(sessionId: string): Promise<{ sessionId: string; equipmentCode: string | null } | null>
}

/** OT-07/OT-21：设备主档只读投影（equipment 等价读：编码全局唯一 MD-09 + 状态字典 MD-13）。 */
export interface OtEquipmentLookup {
  findEquipmentById(equipmentId: string): Promise<{ id: string; code: string; equipmentStatus: 1 | 2 } | null>
  findEquipmentByCode(code: string): Promise<{ id: string; code: string; equipmentStatus: 1 | 2 } | null>
}

// ---------------- Outbox / 隔离队列 ----------------

/** OT-26：出站任务写入（同事务；返回 event_id 供事实行关联）。 */
export interface OtOutboxWriter {
  insert(intent: OutboxIntent): Promise<string>
}

/** OT-07/IF-00.8：隔离队列写入与补绑后回执（0001 inbox 表窄端口）。 */
export interface OtQuarantineInboxStore {
  insertQuarantinedInbox(input: {
    sourceSystem: string
    organizationCode: string
    externalKey: string
    entityType: string
    quarantineReason: string
    payload: Record<string, unknown>
  }): Promise<void>
  /** 补绑后再处理完成后回执（QUARANTINED → PROCESSED）。 */
  markProcessed(externalKey: string, sourceSystem: string, entityType: string): Promise<void>
}

// ---------------- 命令工具集 ----------------

/** ot 域仓储集合。 */
export interface OtRepositories {
  gateways: OtGatewayRepository
  gatewayEvents: OtGatewayEventRepository
  devices: OtDeviceRepository
  points: OtPointRepository
  qualityMaps: OtQualityCodeMapRepository
  conversions: OtConversionRepository
  samples: OtSampleRepository
  aggregates: OtAggregateRepository
  stats: OtStatsRepository
  mappings: OtMappingRepository
  facts: OtBusinessFactRepository
}

/** ot 命令工具集：CommandTools + ot 仓储束 + 跨域只读投影 + Outbox/隔离队列。 */
export interface OtCommandTools extends CommandTools {
  ot: OtRepositories
  otOutbox: OtOutboxWriter
  otInbox: OtQuarantineInboxStore
  otSessions: OtSessionLookup
  otEquipment: OtEquipmentLookup
}
