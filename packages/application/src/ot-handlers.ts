import { ERROR_CODES, type CommandEnvelope } from '@cadenza/contracts'
import { computeShiftDate } from '@cadenza/domain'
// [L0-整合标记] domain ot 面未并入包名入口（domain/src/index.ts 为共享文件不改动）：
// 暂以 dist 相对导入消费已构建产物（构建顺序由 workspace 拓扑保证：domain 先于 application）；
// L0 整合步在 domain index 追加 `export * from './ot'` 后改包名导入（同 shipping 先例）。
 
import {
  OtRuleViolation,
  assertEventIdMatchesDevice,
  assertGatewaySpec,
  assertMappingSpec,
  assertPointSpec,
  assertQualityCodeMapEntries,
  assertSampleShape,
  classifyBadPoint,
  classifyClockSkew,
  deriveGatewayStatus,
  evaluateMeterToQuantity,
  evaluateStopToDowntime,
  isCalibrationSuspect,
  isLateSample,
  linkSession,
  mapQualityLevel,
  mergeAggregate,
  minuteWindowStart,
  normalizeSample,
  shiftWindowStartIso,
  type AggregateValues,
  type QualityLevel,
  type SessionWindowView,
  type UnitConversionRule,
} from '@cadenza/domain'
import type { CommandContext, CommandHandler, HandlerOutcome } from './command-bus'
import type {
  NewOtSample,
  OtAggregateRecord,
  OtBusinessFactRecord,
  OtCommandTools,
  OtDeviceRecord,
  OtMappingRecord,
  OtPointRecord,
  OtSampleRecord,
  OtSampleReprocessPatch,
} from './ot-repositories'

/**
 * ot 域命令处理器（T21 设备与仪器采集；全部在命令总线事务内运行，命令事务即 UoW）。
 *
 * 命令面（13）：
 * - ot.gateway.register / heartbeat / monitor：网关注册、心跳（OT-06/OT-29）、
 *   巡检（离线/恢复事件留痕并告警）；
 * - ot.device.bind：设备序列号 → equipment 主档映射（OT-07；未映射数据进隔离态，
 *   补绑后自动再处理隔离样本）；
 * - ot.point.upsert：点位字典（OT-08 版本化；补登记后自动再处理隔离样本）；
 * - ot.quality-map.upsert / ot.conversion.upsert：质量码映射（OT-11）与换算版本（OT-10）；
 * - ot.samples.ingest：遥测批量入池（OT-09～OT-24 三段式管线：解析校验 → 上下文预取
 *   〔设备/点位/质量码/换算/设备状态/会话窗口/设备时序基准〕→ 逐样本分类入库〔隔离判定/
 *   质量映射/归一/校准/时钟偏差/迟到/坏点/会话三态/去重/分钟汇总〕；**遥测通道只读
 *   OT-03——入池不写 Outbox、不生成业务事实 OT-24**）；
 * - ot.session.link：样本-工序会话人工绑定/纠错（OT-13 留痕，不自动静默改绑）；
 * - ot.aggregate.rebuild：汇总显式重建（OT-S4/OT-19：班次汇总仅由此生成；
 *   重建不触发外部调用与二次扣账）；
 * - ot.mapping.upsert / evaluate / confirm：业务事实映射（OT-26：版本化显式映射 +
 *   确认规则；事实走正常命令链路——幂等、审计、Outbox）。
 *
 * 幂等/回执由 PgCommandBus 承担；规则违例以 [OT-xx] 前缀返回（BUSINESS_REJECTION）。
 * 跨域读（工序会话/设备主档）走只读投影端口（ot-repositories：OtSessionLookup/
 * OtEquipmentLookup）——归属域文件不自改，L0 收编清单见交付记录。
 */

type Payload = Record<string, unknown>

function otViolationOutcome(error: OtRuleViolation): HandlerOutcome {
  let errorCode: string = ERROR_CODES.BUSINESS_RULE
  if (error.rule === 'A-S1') errorCode = ERROR_CODES.FORBIDDEN_SCOPE
  else if (error.rule === 'NOT_FOUND') errorCode = ERROR_CODES.NOT_FOUND
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<Record<string, unknown>>): Promise<HandlerOutcome> {
  try {
    const data = await body()
    return { status: 'COMMITTED', data }
  } catch (error) {
    if (error instanceof OtRuleViolation) return otViolationOutcome(error)
    throw error
  }
}

// ---------------- 载荷解析 ----------------

function str(p: Payload, key: string): string | undefined {
  const v = p[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function int(p: Payload, key: string): number | undefined {
  const v = p[key]
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined
}

function num(p: Payload, key: string): number | undefined {
  const v = p[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function bool(p: Payload, key: string): boolean | undefined {
  const v = p[key]
  return typeof v === 'boolean' ? v : undefined
}

function iso(p: Payload, key: string): string | undefined {
  const v = str(p, key)
  return v !== undefined && !Number.isNaN(Date.parse(v)) ? v : undefined
}

function requireStr(p: Payload, key: string, command: string): string {
  const v = str(p, key)
  if (v === undefined) throw new OtRuleViolation('OT-09', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

function requireIso(p: Payload, key: string, command: string): string {
  const v = iso(p, key)
  if (v === undefined) throw new OtRuleViolation('OT-09', `${command}：载荷字段 ${key} 必须为合法 ISO-8601 时间`)
  return v
}

/** 组织范围二道防线（OA-24/26）。 */
async function assertPlantScope(tools: OtCommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new OtRuleViolation('A-S1', `目标工厂不在授权数据范围内（plant=${plantId}）`)
  }
}

function utcDate(isoTime: string): string {
  return isoTime.slice(0, 10)
}

// ---------------- 共享分类管线（入池与补绑再处理同一套判定） ----------------

export interface ClassifySampleInput {
  deviceSerial: string
  pointCode: string
  eventTime: string
  rawValue: number
  rawUnit: string
  deviceQualityCode: string
  gatewaySeq: number
}

/** 分类上下文：全部经批次/设备级异步预取后同步读取（换算与会话为预取结果）。 */
export interface ClassifyContext {
  device: OtDeviceRecord | null
  point: OtPointRecord | null
  qualityMap: ReadonlyMap<string, QualityLevel>
  conversions: ReadonlyMap<string, UnitConversionRule | null>
  equipmentStatus: 1 | 2 | null
  equipmentCode: string | null
  /** 设备编码对应的会话窗口（批次时间范围预取，OT-13） */
  sessions: readonly SessionWindowView[]
  deviceState: { latestSeq: number; latestEventTime: string | null; maxEventTime: string | null }
  receivedAt: string
  now: string
}

/** 分类结果：NewOtSample / OtSampleReprocessPatch 的分类列（同构）。 */
export type SampleClassification = OtSampleReprocessPatch

/**
 * 样本分类管线（OT-07/09/10/11/12/13/19/20/21）：隔离判定 → 质量映射 → 归一 →
 * 校准 → 时钟偏差 → 迟到 → 坏点 → 会话三态。隔离态样本（设备未登记/未映射/
 * 点位未登记/点位不属该设备）保留原始值与已判定的数据质量标记（OT-07 不悬空丢弃）。
 */
export function classifySample(sample: ClassifySampleInput, ctx: ClassifyContext): SampleClassification {
  const qualityLevel = mapQualityLevel(sample.deviceQualityCode, ctx.qualityMap)

  // ---- 隔离判定（OT-07：未注册/映射失效 → 隔离态，供人工补绑） ----
  let quarantineReason: string | null = null
  if (ctx.device === null) quarantineReason = 'device_not_registered'
  else if (ctx.device.equipmentId === null) quarantineReason = 'device_unbound'
  else if (ctx.point === null) quarantineReason = 'point_not_registered'
  else if (ctx.point.deviceSerial !== sample.deviceSerial) quarantineReason = 'point_not_belong_to_device'

  // ---- 量纲归一（OT-10：原始值与归一值并存；点位上下文完整即可归一） ----
  let normalizedValue: number | null = null
  let conversionRevision: number | null = null
  let conversionMissing = false
  if (ctx.point !== null && ctx.point.deviceSerial === sample.deviceSerial) {
    const rule = ctx.conversions.get(`${sample.rawUnit}->${ctx.point.uomCode}`) ?? null
    const n = normalizeSample(sample.rawValue, sample.rawUnit, ctx.point.uomCode, rule === null ? [] : [rule])
    normalizedValue = n.normalizedValue
    conversionRevision = n.conversionRevision
    conversionMissing = n.conversionMissing
  }

  // ---- 校准关联（OT-12：过期期间采集 → 校准状态可疑） ----
  const calibrationSuspect =
    ctx.point !== null && isCalibrationSuspect(ctx.point.calibrationValidUntil, sample.eventTime)

  // ---- 时钟偏差（OT-20：阈值按设备可配置，缺省 120 秒） ----
  const thresholdSeconds = ctx.device?.clockSkewThresholdSeconds ?? 120
  const skew = classifyClockSkew({
    eventTime: sample.eventTime,
    receivedAt: ctx.receivedAt,
    now: ctx.now,
    thresholdSeconds,
    deviceLatest:
      ctx.deviceState.latestEventTime === null
        ? null
        : { gatewaySeq: ctx.deviceState.latestSeq, eventTime: ctx.deviceState.latestEventTime },
    gatewaySeq: sample.gatewaySeq,
  })

  // ---- 迟到（OT-19：事件时间早于该设备已入池最大事件时间） ----
  const isLate = isLateSample(sample.eventTime, ctx.deviceState.maxEventTime)

  // ---- 坏点（OT-21：质量 bad/量程越界/维修期间采集） ----
  const bad = classifyBadPoint({
    qualityLevel,
    rawValue: sample.rawValue,
    rangeMin: ctx.point !== null && ctx.point.rangeMin !== null ? Number(ctx.point.rangeMin) : null,
    rangeMax: ctx.point !== null && ctx.point.rangeMax !== null ? Number(ctx.point.rangeMax) : null,
    equipmentStatus: quarantineReason !== null ? null : ctx.equipmentStatus,
  })

  // ---- 工序会话三态（OT-13；时钟偏差样本不参与班次归属自动统计 → 不自动绑定） ----
  let sessionId: string | null = null
  let sessionLinkStatus: SampleClassification['sessionLinkStatus'] = 'unlinked'
  if (quarantineReason === null && !skew.isClockSkew && ctx.equipmentCode !== null) {
    const link = linkSession(sample.eventTime, ctx.sessions)
    sessionId = link.sessionId
    sessionLinkStatus = link.status
  }

  return {
    normalizedValue,
    conversionRevision,
    conversionMissing,
    qualityLevel,
    isBad: bad.isBad,
    badReasons: bad.reasons as string[],
    isClockSkew: skew.isClockSkew,
    clockSkewKind: skew.kind,
    isLate,
    calibrationSuspect,
    sessionId,
    sessionLinkStatus,
    isQuarantined: quarantineReason !== null,
    quarantineReason,
  }
}

// ---------------- 批次上下文预取（设备/点位/质量码/换算/设备状态/会话/时序基准） ----------------

interface BatchContext {
  deviceBySerial: Map<string, OtDeviceRecord | null>
  /** 设备 → (点位代码 → 点位)，批内二级缓存 */
  pointBySerialCode: Map<string, Map<string, OtPointRecord | null>>
  qualityMapBySerial: Map<string, ReadonlyMap<string, QualityLevel>>
  conversions: Map<string, UnitConversionRule | null>
  equipmentBySerial: Map<string, { code: string; equipmentStatus: 1 | 2 } | null>
  sessionsBySerial: Map<string, SessionWindowView[]>
  latestBySerial: Map<string, { gatewaySeq: number; eventTime: string } | null>
  maxEventBySerial: Map<string, string | null>
}

/**
 * 批次上下文预取：换算规则按 (rawUnit → 点位单位) 全对预查（OT-10），
 * 会话窗口按 设备+批次时间范围 预取（OT-13：设备＋时间窗匹配）。
 */
async function preloadBatchContext(
  tools: OtCommandTools,
  plantId: string,
  samples: ReadonlyArray<{ deviceSerial: string; pointCode: string; rawUnit: string; eventTime: string }>,
): Promise<BatchContext> {
  const ctx: BatchContext = {
    deviceBySerial: new Map(),
    pointBySerialCode: new Map(),
    qualityMapBySerial: new Map(),
    conversions: new Map(),
    equipmentBySerial: new Map(),
    sessionsBySerial: new Map(),
    latestBySerial: new Map(),
    maxEventBySerial: new Map(),
  }
  const serials = [...new Set(samples.map((s) => s.deviceSerial))]
  let minEvent: string | null = null
  let maxEvent: string | null = null
  for (const s of samples) {
    if (minEvent === null || Date.parse(s.eventTime) < Date.parse(minEvent)) minEvent = s.eventTime
    if (maxEvent === null || Date.parse(s.eventTime) > Date.parse(maxEvent)) maxEvent = s.eventTime
  }
  for (const serial of serials) {
    ctx.deviceBySerial.set(serial, await tools.ot.devices.findBySerial(serial))
    ctx.pointBySerialCode.set(serial, new Map())
    const device = ctx.deviceBySerial.get(serial) ?? null
    const equipment =
      device?.equipmentId == null ? null : await tools.otEquipment.findEquipmentById(device.equipmentId)
    ctx.equipmentBySerial.set(serial, equipment)
    ctx.qualityMapBySerial.set(
      serial,
      new Map((await tools.ot.qualityMaps.listByDevice(serial)).map((e) => [e.deviceQualityCode, e.qualityLevel])),
    )
    ctx.latestBySerial.set(serial, await tools.ot.samples.findLatestByDevice(serial))
    ctx.maxEventBySerial.set(serial, await tools.ot.samples.findMaxEventTimeByDevice(serial))
    if (equipment !== null && minEvent !== null && maxEvent !== null) {
      ctx.sessionsBySerial.set(
        serial,
        await tools.otSessions.findSessionWindows(equipment.code, { from: minEvent, to: maxEvent }),
      )
    } else {
      ctx.sessionsBySerial.set(serial, [])
    }
  }
  // 换算全对预查（OT-10）：点位已知且单位不同才查
  const pairs = new Set<string>()
  for (const s of samples) {
    const point = await pointFor(ctx, s.deviceSerial, s.pointCode, tools)
    if (point !== null && point.deviceSerial === s.deviceSerial && s.rawUnit !== point.uomCode) {
      pairs.add(`${s.rawUnit}->${point.uomCode}`)
    }
  }
  for (const pair of pairs) {
    const [from, to] = pair.split('->')
    const rule = await tools.ot.conversions.find(plantId, from ?? '', to ?? '')
    ctx.conversions.set(pair, rule === null ? null : { fromUomCode: rule.fromUomCode, toUomCode: rule.toUomCode, factor: rule.factor, revision: rule.revision })
  }
  return ctx
}

async function pointFor(
  ctx: BatchContext,
  deviceSerial: string,
  pointCode: string,
  tools: OtCommandTools,
): Promise<OtPointRecord | null> {
  let byCode = ctx.pointBySerialCode.get(deviceSerial)
  if (byCode === undefined) {
    byCode = new Map()
    ctx.pointBySerialCode.set(deviceSerial, byCode)
  }
  if (!byCode.has(pointCode)) {
    byCode.set(pointCode, await tools.ot.points.findByDeviceAndCode(deviceSerial, pointCode))
  }
  return byCode.get(pointCode) ?? null
}

// ---------------- 命令：网关注册（OT-06） ----------------

async function gatewayRegister(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'ot.gateway.register')
  const gatewayCode = requireStr(p, 'gatewayCode', 'ot.gateway.register')
  await assertPlantScope(tools, plantId)
  const spec = {
    gatewayCode,
    sampleRateHz: num(p, 'sampleRateHz') ?? 1,
    bufferCapacity: int(p, 'bufferCapacity') ?? 10_000,
    heartbeatTimeoutSeconds: int(p, 'heartbeatTimeoutSeconds') ?? 60,
  }
  assertGatewaySpec(spec)
  const protocolConfigRaw = p['protocolConfig']
  const protocolConfig =
    protocolConfigRaw !== undefined && protocolConfigRaw !== null &&
    typeof protocolConfigRaw === 'object' && !Array.isArray(protocolConfigRaw)
      ? (protocolConfigRaw as Record<string, unknown>)
      : {}
  const existing = await tools.ot.gateways.findByCode(gatewayCode)
  const record = await tools.ot.gateways.upsert({
    gatewayCode,
    protocolConfig,
    sampleRateHz: spec.sampleRateHz,
    bufferCapacity: spec.bufferCapacity,
    heartbeatTimeoutSeconds: spec.heartbeatTimeoutSeconds,
    plantId,
    enterpriseId: ctx.enterpriseId,
    createdBy: ctx.actorLoginName,
  })
  const deviceSerialsRaw = p['deviceSerials']
  const deviceSerials = Array.isArray(deviceSerialsRaw)
    ? deviceSerialsRaw.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : []
  for (const serial of deviceSerials) {
    await tools.ot.devices.upsert({
      deviceSerial: serial,
      gatewayCode,
      plantId,
      enterpriseId: ctx.enterpriseId,
      createdBy: ctx.actorLoginName,
    })
  }
  await tools.ot.gatewayEvents.insert({
    gatewayCode,
    eventKind: 'registered',
    detail: {
      sampleRateHz: spec.sampleRateHz,
      bufferCapacity: spec.bufferCapacity,
      heartbeatTimeoutSeconds: spec.heartbeatTimeoutSeconds,
      updated: existing !== null,
      deviceSerials,
    },
    occurredAt: tools.now().toISOString(),
    createdBy: ctx.actorLoginName,
    plantId,
    enterpriseId: ctx.enterpriseId,
  })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.gateway.register',
    subjectType: 'ot_gateway',
    subjectId: record.id,
    before: existing === null ? null : { sampleRateHz: existing.sampleRateHz, bufferCapacity: existing.bufferCapacity },
    after: { gatewayCode, sampleRateHz: spec.sampleRateHz, bufferCapacity: spec.bufferCapacity, deviceSerials },
    reason: str(p, 'reason') ?? null,
  })
  return { gatewayId: record.id, gatewayCode, updated: existing !== null, devices: deviceSerials.length }
}

// ---------------- 命令：网关心跳（OT-06/OT-29） ----------------

async function gatewayHeartbeat(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const gatewayCode = requireStr(p, 'gatewayCode', 'ot.gateway.heartbeat')
  const gateway = await tools.ot.gateways.findByCode(gatewayCode)
  if (gateway === null) {
    throw new OtRuleViolation('OT-06', `网关未注册，拒绝心跳（gatewayCode=${gatewayCode}）`)
  }
  await assertPlantScope(tools, gateway.plantId)
  const backlogCount = int(p, 'backlogCount') ?? 0
  const heartbeatAt = tools.now().toISOString()
  const restored = gateway.status === 'offline'
  await tools.ot.gateways.updateHeartbeat(gatewayCode, {
    backlogCount,
    heartbeatAt,
    actor: ctx.actorLoginName,
  })
  if (restored) {
    await tools.ot.gateways.updateStatus(gatewayCode, {
      status: 'online',
      changedAt: heartbeatAt,
      actor: ctx.actorLoginName,
    })
    await tools.ot.gatewayEvents.insert({
      gatewayCode,
      eventKind: 'heartbeat_restored',
      detail: { heartbeatAt, backlogCount, offlineSince: gateway.lastStatusChangedAt },
      occurredAt: heartbeatAt,
      createdBy: ctx.actorLoginName,
      plantId: gateway.plantId,
      enterpriseId: ctx.enterpriseId,
    })
  }
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.gateway.heartbeat',
    subjectType: 'ot_gateway',
    subjectId: gateway.id,
    after: { gatewayCode, heartbeatAt, backlogCount, restored },
    reason: str(p, 'reason') ?? null,
  })
  return { gatewayCode, heartbeatAt, status: 'online', restored }
}

// ---------------- 命令：网关巡检（OT-29：离线/恢复事件留痕并告警） ----------------

async function gatewayMonitor(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const scope = await tools.actorDataScope()
  const plantId = str(p, 'plantId')
  if (plantId !== undefined) await assertPlantScope(tools, plantId)
  const gateways = await tools.ot.gateways.listAll({
    plantIds: scope.enterpriseWide ? null : scope.plantIds,
    plantId,
  })
  const now = tools.now().toISOString()
  const nowMs = Date.parse(now)
  let offlineMarked = 0
  let restored = 0
  for (const g of gateways) {
    const derived = deriveGatewayStatus(g.lastHeartbeatAt, g.heartbeatTimeoutSeconds, now)
    if (derived === 'offline' && g.status === 'online') {
      const staleSeconds =
        g.lastHeartbeatAt === null ? null : Math.round((nowMs - Date.parse(g.lastHeartbeatAt)) / 1000)
      await tools.ot.gateways.updateStatus(g.gatewayCode, {
        status: 'offline',
        changedAt: now,
        actor: ctx.actorLoginName,
      })
      await tools.ot.gatewayEvents.insert({
        gatewayCode: g.gatewayCode,
        eventKind: 'offline',
        detail: {
          staleSeconds,
          lastHeartbeatAt: g.lastHeartbeatAt,
          heartbeatTimeoutSeconds: g.heartbeatTimeoutSeconds,
        },
        occurredAt: now,
        createdBy: ctx.actorLoginName,
        plantId: g.plantId,
        enterpriseId: g.enterpriseId,
      })
      offlineMarked += 1
    } else if (derived === 'online' && g.status === 'offline') {
      await tools.ot.gateways.updateStatus(g.gatewayCode, {
        status: 'online',
        changedAt: now,
        actor: ctx.actorLoginName,
      })
      await tools.ot.gatewayEvents.insert({
        gatewayCode: g.gatewayCode,
        eventKind: 'heartbeat_restored',
        detail: { restoredAt: now, lastHeartbeatAt: g.lastHeartbeatAt },
        occurredAt: now,
        createdBy: ctx.actorLoginName,
        plantId: g.plantId,
        enterpriseId: g.enterpriseId,
      })
      restored += 1
    }
  }
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.gateway.monitor',
    subjectType: 'ot_gateway',
    subjectId: 'monitor-sweep',
    after: { checked: gateways.length, offlineMarked, restored },
    reason: str(p, 'reason') ?? null,
  })
  return { checked: gateways.length, offlineMarked, restored }
}

// ---------------- 命令：设备映射（OT-07：补绑后再处理隔离样本） ----------------

/** 补绑/补登记后重跑隔离样本分类（OT-07：不悬空丢弃；仍未可分类则保留隔离并更新原因）。 */
async function reprocessQuarantined(
  tools: OtCommandTools,
  ctx: CommandContext,
  deviceSerials: readonly string[],
): Promise<{ reprocessed: number; stillQuarantined: number }> {
  let reprocessed = 0
  let stillQuarantined = 0
  const now = tools.now().toISOString()
  for (const serial of deviceSerials) {
    const quarantined = await tools.ot.samples.listQuarantinedByDevice(serial)
    if (quarantined.length === 0) continue
    const batch = await preloadBatchContext(
      tools,
      quarantined[0]!.plantId,
      quarantined.map((s) => ({
        deviceSerial: s.deviceSerial,
        pointCode: s.pointCode,
        rawUnit: s.rawUnit,
        eventTime: s.eventTime,
      })),
    )
    for (const s of quarantined) {
      const device = batch.deviceBySerial.get(s.deviceSerial) ?? null
      const point = await pointFor(batch, s.deviceSerial, s.pointCode, tools)
      const equipment = batch.equipmentBySerial.get(s.deviceSerial) ?? null
      const classification = classifySample(
        {
          deviceSerial: s.deviceSerial,
          pointCode: s.pointCode,
          eventTime: s.eventTime,
          rawValue: Number(s.rawValue),
          rawUnit: s.rawUnit,
          deviceQualityCode: s.deviceQualityCode ?? '',
          gatewaySeq: s.gatewaySeq,
        },
        {
          device,
          point,
          qualityMap: batch.qualityMapBySerial.get(s.deviceSerial) ?? new Map(),
          conversions: batch.conversions,
          equipmentStatus: equipment?.equipmentStatus ?? null,
          equipmentCode: equipment?.code ?? null,
          sessions: batch.sessionsBySerial.get(s.deviceSerial) ?? [],
          deviceState: {
            latestSeq: batch.latestBySerial.get(s.deviceSerial)?.gatewaySeq ?? 0,
            latestEventTime: batch.latestBySerial.get(s.deviceSerial)?.eventTime ?? null,
            maxEventTime: batch.maxEventBySerial.get(s.deviceSerial) ?? null,
          },
          receivedAt: s.receivedAt,
          now,
        },
      )
      // 原因细化（仍隔离但原因更新）与解除隔离都经 applyReprocess 落库；补绑留痕走审计
      await tools.ot.samples.applyReprocess(s.id, classification, ctx.actorLoginName)
      if (!classification.isQuarantined) {
        await tools.otInbox.markProcessed(`${s.deviceSerial}:${s.eventId}`, s.gatewayCode, 'ot_sample')
        reprocessed += 1
      } else {
        stillQuarantined += 1
      }
    }
  }
  return { reprocessed, stillQuarantined }
}

async function deviceBind(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'ot.device.bind')
  const deviceSerial = requireStr(p, 'deviceSerial', 'ot.device.bind')
  await assertPlantScope(tools, plantId)
  const equipmentId = str(p, 'equipmentId') ?? null
  if (equipmentId !== null) {
    const equipment = await tools.otEquipment.findEquipmentById(equipmentId)
    if (equipment === null) {
      throw new OtRuleViolation('NOT_FOUND', `equipment 主档不存在（equipmentId=${equipmentId}）`)
    }
  }
  const existing = await tools.ot.devices.findBySerial(deviceSerial)
  const clockSkewThresholdSeconds =
    int(p, 'clockSkewThresholdSeconds') ?? existing?.clockSkewThresholdSeconds ?? 120
  const now = tools.now().toISOString()
  const record = await tools.ot.devices.upsert({
    deviceSerial,
    gatewayCode: str(p, 'gatewayCode') ?? existing?.gatewayCode ?? null,
    equipmentId,
    boundBy: equipmentId !== null ? ctx.actorLoginName : existing?.boundBy ?? null,
    boundAt: equipmentId !== null ? now : existing?.boundAt ?? null,
    clockSkewThresholdSeconds,
    plantId,
    enterpriseId: ctx.enterpriseId,
    createdBy: ctx.actorLoginName,
  })
  const reprocess = await reprocessQuarantined(tools, ctx, [deviceSerial])
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.device.bind',
    subjectType: 'ot_device',
    subjectId: deviceSerial,
    before:
      existing === null
        ? null
        : { equipmentId: existing.equipmentId, clockSkewThresholdSeconds: existing.clockSkewThresholdSeconds },
    after: { deviceSerial, equipmentId, clockSkewThresholdSeconds, ...reprocess },
    reason: str(p, 'reason') ?? null,
  })
  return { deviceSerial, equipmentId: record.equipmentId, ...reprocess }
}

// ---------------- 命令：点位字典（OT-08） ----------------

async function pointUpsert(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'ot.point.upsert')
  const deviceSerial = requireStr(p, 'deviceSerial', 'ot.point.upsert')
  await assertPlantScope(tools, plantId)
  const device = await tools.ot.devices.findBySerial(deviceSerial)
  if (device === null) {
    throw new OtRuleViolation(
      'NOT_FOUND',
      `设备序列号未登记，先经网关注册或设备映射登记（deviceSerial=${deviceSerial}）`,
    )
  }
  const pointsRaw = p['points']
  if (!Array.isArray(pointsRaw) || pointsRaw.length === 0) {
    throw new OtRuleViolation('OT-08', 'points 必须为非空数组')
  }
  const results: Array<Record<string, unknown>> = []
  for (const raw of pointsRaw) {
    const l = (raw ?? {}) as Payload
    const rangeMinRaw = l['rangeMin']
    const rangeMaxRaw = l['rangeMax']
    const spec = {
      pointCode: str(l, 'pointCode') ?? '',
      semantic: str(l, 'semantic') ?? '',
      uomCode: str(l, 'uomCode') ?? '',
      sampleRateSeconds: num(l, 'sampleRateSeconds') ?? 0,
      rangeMin:
        rangeMinRaw === null || rangeMinRaw === undefined ? null : typeof rangeMinRaw === 'number' ? rangeMinRaw : NaN,
      rangeMax:
        rangeMaxRaw === null || rangeMaxRaw === undefined ? null : typeof rangeMaxRaw === 'number' ? rangeMaxRaw : NaN,
      participatesInBusiness: bool(l, 'participatesInBusiness') ?? false,
      calibrationRecordNo: str(l, 'calibrationRecordNo') ?? null,
      calibrationValidUntil: iso(l, 'calibrationValidUntil') ?? null,
    }
    assertPointSpec(spec)
    const record = await tools.ot.points.upsert({
      deviceSerial,
      pointCode: spec.pointCode,
      semantic: spec.semantic,
      uomId: str(l, 'uomId') ?? null,
      uomCode: spec.uomCode,
      sampleRateSeconds: spec.sampleRateSeconds,
      rangeMin: spec.rangeMin,
      rangeMax: spec.rangeMax,
      participatesInBusiness: spec.participatesInBusiness,
      calibrationRecordNo: spec.calibrationRecordNo,
      calibrationValidUntil: spec.calibrationValidUntil,
      plantId,
      enterpriseId: ctx.enterpriseId,
      createdBy: ctx.actorLoginName,
    })
    results.push({ pointCode: record.pointCode, version: record.version })
  }
  const reprocess = await reprocessQuarantined(tools, ctx, [deviceSerial])
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.point.upsert',
    subjectType: 'ot_point',
    subjectId: deviceSerial,
    after: { deviceSerial, points: results },
    reason: str(p, 'reason') ?? null,
  })
  return { deviceSerial, points: results, ...reprocess }
}

// ---------------- 命令：质量码映射（OT-11） ----------------

async function qualityMapUpsert(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'ot.quality-map.upsert')
  const deviceSerial = requireStr(p, 'deviceSerial', 'ot.quality-map.upsert')
  await assertPlantScope(tools, plantId)
  const device = await tools.ot.devices.findBySerial(deviceSerial)
  if (device === null) {
    throw new OtRuleViolation('NOT_FOUND', `设备序列号未登记（deviceSerial=${deviceSerial}）`)
  }
  const entriesRaw = p['entries']
  if (!Array.isArray(entriesRaw)) {
    throw new OtRuleViolation('OT-11', 'entries 必须为数组')
  }
  const entries = entriesRaw.map((raw) => {
    const e = (raw ?? {}) as Payload
    return { code: str(e, 'code') ?? '', level: str(e, 'level') ?? '' }
  })
  assertQualityCodeMapEntries(entries)
  const replaced = await tools.ot.qualityMaps.replaceForDevice(
    deviceSerial,
    entries.map((e) => ({ code: e.code, level: e.level as QualityLevel })),
    { plantId, enterpriseId: ctx.enterpriseId, actor: ctx.actorLoginName },
  )
  const mapVersion = replaced.length > 0 ? replaced[0]!.mapVersion : 1
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.quality-map.upsert',
    subjectType: 'ot_quality_code_map',
    subjectId: deviceSerial,
    after: { deviceSerial, entries: entries.length, mapVersion },
    reason: str(p, 'reason') ?? null,
  })
  return { deviceSerial, entries: entries.length, mapVersion }
}

// ---------------- 命令：单位换算（OT-10） ----------------

async function conversionUpsert(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'ot.conversion.upsert')
  await assertPlantScope(tools, plantId)
  const fromUomCode = requireStr(p, 'fromUomCode', 'ot.conversion.upsert')
  const toUomCode = requireStr(p, 'toUomCode', 'ot.conversion.upsert')
  const factor = num(p, 'factor')
  if (factor === undefined || !(factor > 0)) {
    throw new OtRuleViolation('OT-10', '换算系数必须为正数')
  }
  if (fromUomCode === toUomCode) {
    throw new OtRuleViolation('OT-10', '换算方向不得为同单位（同单位恒等归一无须换算）')
  }
  const record = await tools.ot.conversions.upsert({
    fromUomCode,
    toUomCode,
    factor,
    plantId,
    enterpriseId: ctx.enterpriseId,
    createdBy: ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.conversion.upsert',
    subjectType: 'ot_conversion',
    subjectId: `${plantId}:${fromUomCode}->${toUomCode}`,
    after: { fromUomCode, toUomCode, factor, revision: record.revision },
    reason: str(p, 'reason') ?? null,
  })
  return { fromUomCode, toUomCode, factor, revision: record.revision }
}

// ---------------- 命令：遥测批量入池（OT-09～OT-24，三段式） ----------------

async function samplesIngest(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const gatewayCode = requireStr(p, 'gatewayCode', 'ot.samples.ingest')
  const gateway = await tools.ot.gateways.findByCode(gatewayCode)
  if (gateway === null) {
    throw new OtRuleViolation('OT-06', `网关未注册，拒绝入池（gatewayCode=${gatewayCode}）`)
  }
  await assertPlantScope(tools, gateway.plantId)
  const samplesRaw = p['samples']
  if (!Array.isArray(samplesRaw) || samplesRaw.length === 0) {
    throw new OtRuleViolation('OT-09', 'samples 必须为非空数组')
  }
  // OT-23：容量基线 2,000 点/秒——单批次上限 5,000（秒级批次量级），防超大事务
  if (samplesRaw.length > 5_000) {
    throw new OtRuleViolation(
      'OT-23',
      `单批次样本数超上限（${samplesRaw.length} > 5000，按 2,000 点/秒基线分批上报）`,
    )
  }
  const now = tools.now().toISOString()
  const receivedAt = now
  const plantNode = await tools.org.findById(gateway.plantId)
  const plantCode = plantNode?.code ?? gateway.plantId

  // ---- 第一段：解析与形状校验（OT-09/OT-15） ----
  interface ParsedSample {
    deviceSerial: string
    pointCode: string
    eventId: string
    eventTime: string
    rawValue: number
    rawUnit: string
    deviceQualityCode: string
    gatewaySeq: number
  }
  const parsed: ParsedSample[] = []
  let maxGatewaySeq = 0
  for (const raw of samplesRaw) {
    const s = (raw ?? {}) as Payload
    const sample = {
      deviceSerial: str(s, 'deviceSerial') ?? '',
      pointCode: str(s, 'pointCode') ?? '',
      eventId: str(s, 'eventId') ?? '',
      eventTime: iso(s, 'eventTime') ?? '',
      rawValue: num(s, 'rawValue') ?? NaN,
      rawUnit: str(s, 'rawUnit') ?? '',
      deviceQualityCode: str(s, 'deviceQualityCode') ?? '',
    }
    assertSampleShape(sample)
    const gatewaySeq = assertEventIdMatchesDevice(sample.eventId, sample.deviceSerial)
    maxGatewaySeq = Math.max(maxGatewaySeq, gatewaySeq)
    parsed.push({ ...sample, gatewaySeq })
  }

  // ---- 第二段：上下文预取（设备/点位/质量码/换算/设备状态/会话窗口/时序基准） ----
  const batch = await preloadBatchContext(tools, gateway.plantId, parsed)

  // ---- 第三段：逐样本分类入库（OT-16 去重 → OT-19/24 分钟汇总 → OT-07 隔离留痕） ----
  const counters = { received: parsed.length, inserted: 0, duplicates: 0, quarantined: 0, bad: 0, skew: 0, late: 0 }
  const minuteAggCache = new Map<string, AggregateValues | null>()
  for (const sample of parsed) {
    const device = batch.deviceBySerial.get(sample.deviceSerial) ?? null
    const point = await pointFor(batch, sample.deviceSerial, sample.pointCode, tools)
    const equipment = batch.equipmentBySerial.get(sample.deviceSerial) ?? null
    const classification = classifySample(sample, {
      device,
      point,
      qualityMap: batch.qualityMapBySerial.get(sample.deviceSerial) ?? new Map(),
      conversions: batch.conversions,
      equipmentStatus: equipment?.equipmentStatus ?? null,
      equipmentCode: equipment?.code ?? null,
      sessions: batch.sessionsBySerial.get(sample.deviceSerial) ?? [],
      deviceState: {
        latestSeq: batch.latestBySerial.get(sample.deviceSerial)?.gatewaySeq ?? 0,
        latestEventTime: batch.latestBySerial.get(sample.deviceSerial)?.eventTime ?? null,
        maxEventTime: batch.maxEventBySerial.get(sample.deviceSerial) ?? null,
      },
      receivedAt,
      now,
    })

    const insertPayload: NewOtSample = {
      deviceSerial: sample.deviceSerial,
      pointCode: sample.pointCode,
      eventId: sample.eventId,
      gatewaySeq: sample.gatewaySeq,
      eventTime: sample.eventTime,
      receivedAt,
      gatewayCode,
      rawValue: sample.rawValue,
      rawUnit: sample.rawUnit,
      normalizedValue: classification.normalizedValue,
      conversionRevision: classification.conversionRevision,
      conversionMissing: classification.conversionMissing,
      qualityLevel: classification.qualityLevel,
      deviceQualityCode: sample.deviceQualityCode,
      isBad: classification.isBad,
      badReasons: classification.badReasons,
      isClockSkew: classification.isClockSkew,
      clockSkewKind: classification.clockSkewKind,
      isLate: classification.isLate,
      calibrationSuspect: classification.calibrationSuspect,
      sessionId: classification.sessionId,
      sessionLinkStatus: classification.sessionLinkStatus,
      isQuarantined: classification.isQuarantined,
      quarantineReason: classification.quarantineReason,
      plantId: gateway.plantId,
      enterpriseId: ctx.enterpriseId,
      createdBy: ctx.actorLoginName,
    }
    const record = await tools.ot.samples.insertOnConflictSkip(insertPayload)
    if (record === null) {
      // OT-16：重传去重——幂等丢弃并累计去重计数（可观测）
      counters.duplicates += 1
      await tools.ot.stats.bumpDedup({
        statDate: utcDate(receivedAt),
        gatewayCode,
        deviceSerial: sample.deviceSerial,
        delta: 1,
        plantId: gateway.plantId,
        enterpriseId: ctx.enterpriseId,
      })
      continue
    }
    counters.inserted += 1
    if (classification.isQuarantined) {
      counters.quarantined += 1
      // OT-07/IF-00.8：隔离队列留痕（供人工补绑工作流）
      await tools.otInbox.insertQuarantinedInbox({
        sourceSystem: gatewayCode,
        organizationCode: plantCode,
        externalKey: `${sample.deviceSerial}:${sample.eventId}`,
        entityType: 'ot_sample',
        quarantineReason: classification.quarantineReason ?? 'unknown',
        payload: { ...sample, receivedAt },
      })
    } else {
      if (classification.isBad) counters.bad += 1
      if (classification.isClockSkew) counters.skew += 1
      if (classification.isLate) counters.late += 1
      // OT-19/OT-24：分钟汇总并入（迟到补插同窗；班次汇总不在此生成，OT-19）
      await mergeMinuteAggregate(
        tools,
        minuteAggCache,
        record,
        gateway.plantId,
        ctx.enterpriseId,
        ctx.actorLoginName,
      )
    }

    // 批内设备时序基准推进（后续样本的倒跳/迟到判定基准）
    const maxEvent = batch.maxEventBySerial.get(sample.deviceSerial) ?? null
    if (maxEvent === null || Date.parse(sample.eventTime) > Date.parse(maxEvent)) {
      batch.maxEventBySerial.set(sample.deviceSerial, sample.eventTime)
    }
    const latest = batch.latestBySerial.get(sample.deviceSerial) ?? null
    if (latest === null || sample.gatewaySeq > latest.gatewaySeq) {
      batch.latestBySerial.set(sample.deviceSerial, { gatewaySeq: sample.gatewaySeq, eventTime: sample.eventTime })
    }
  }

  // ---- 溢出统计（OT-17：不静默丢弃；溢出入统计与事件留痕） ----
  const overflowRaw = p['overflow']
  if (
    overflowRaw !== null &&
    overflowRaw !== undefined &&
    typeof overflowRaw === 'object' &&
    !Array.isArray(overflowRaw)
  ) {
    const o = overflowRaw as Payload
    const count = int(o, 'count') ?? 0
    const firstAt = iso(o, 'firstAt')
    const lastAt = iso(o, 'lastAt')
    if (count < 1 || firstAt === undefined || lastAt === undefined) {
      throw new OtRuleViolation('OT-17', '溢出上报必须包含 count(>=1)/firstAt/lastAt')
    }
    const devicesRaw = o['deviceSerials']
    const deviceSerials = Array.isArray(devicesRaw)
      ? devicesRaw.filter((d): d is string => typeof d === 'string' && d.length > 0)
      : []
    const targets = deviceSerials.length > 0 ? deviceSerials : ['*']
    for (const serial of targets) {
      await tools.ot.stats.upsertOverflow({
        statDate: utcDate(firstAt),
        gatewayCode,
        deviceSerial: serial,
        count,
        firstAt,
        lastAt,
        plantId: gateway.plantId,
        enterpriseId: ctx.enterpriseId,
      })
    }
    await tools.ot.gatewayEvents.insert({
      gatewayCode,
      eventKind: 'overflow',
      detail: { count, firstAt, lastAt, deviceSerials: targets },
      occurredAt: receivedAt,
      createdBy: ctx.actorLoginName,
      plantId: gateway.plantId,
      enterpriseId: ctx.enterpriseId,
    })
  }

  // ---- 检查点与积压（OT-15/OT-29） ----
  const backlogCount = int(p, 'backlogCount') ?? 0
  await tools.ot.gateways.updateBacklog(gatewayCode, backlogCount)
  const checkpointSeq = int(p, 'checkpointSeq') ?? maxGatewaySeq
  if (checkpointSeq > gateway.checkpointSeq) {
    await tools.ot.gateways.setCheckpoint(gatewayCode, checkpointSeq)
  }

  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.samples.ingest',
    subjectType: 'ot_gateway',
    subjectId: gateway.id,
    after: { gatewayCode, ...counters, checkpointSeq },
    reason: str(p, 'reason') ?? null,
  })
  return { gatewayCode, ...counters, checkpointSeq, backlogCount }
}

/** 分钟汇总并入（OT-19/OT-24：批内窗口缓存，迟到样本补插同窗）。 */
async function mergeMinuteAggregate(
  tools: OtCommandTools,
  cache: Map<string, AggregateValues | null>,
  record: OtSampleRecord,
  plantId: string,
  enterpriseId: string,
  actor: string | null,
): Promise<void> {
  const windowStart = minuteWindowStart(record.eventTime)
  const key = `${record.deviceSerial}::${record.pointCode}::${windowStart}`
  let values: AggregateValues | null | undefined = cache.get(key)
  if (values === undefined) {
    const existing: OtAggregateRecord | null = await tools.ot.aggregates.findByWindow(
      record.deviceSerial,
      record.pointCode,
      'minute',
      windowStart,
    )
    values =
      existing === null
        ? null
        : {
            sampleCount: existing.sampleCount,
            goodCount: existing.goodCount,
            badCount: existing.badCount,
            skewCount: existing.skewCount,
            sumValue: Number(existing.sumValue),
            minValue: existing.minValue === null ? null : Number(existing.minValue),
            maxValue: existing.maxValue === null ? null : Number(existing.maxValue),
            firstEventTime: existing.firstEventTime,
            lastEventTime: existing.lastEventTime,
          }
    cache.set(key, values)
  }
  const merged = mergeAggregate(values, {
    eventTime: record.eventTime,
    normalizedValue: record.normalizedValue === null ? null : Number(record.normalizedValue),
    qualityLevel: record.qualityLevel,
    isBad: record.isBad,
    isClockSkew: record.isClockSkew,
    isQuarantined: false,
  })
  cache.set(key, merged)
  await tools.ot.aggregates.upsert({
    deviceSerial: record.deviceSerial,
    pointCode: record.pointCode,
    granularity: 'minute',
    windowStart,
    sampleCount: merged.sampleCount,
    goodCount: merged.goodCount,
    badCount: merged.badCount,
    skewCount: merged.skewCount,
    sumValue: merged.sumValue,
    minValue: merged.minValue,
    maxValue: merged.maxValue,
    firstEventTime: merged.firstEventTime,
    lastEventTime: merged.lastEventTime,
    plantId,
    enterpriseId,
    updatedBy: actor,
  })
}

// ---------------- 命令：会话人工绑定/纠错（OT-13） ----------------

async function sessionLink(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const sampleId = requireStr(p, 'sampleId', 'ot.session.link')
  const sessionId = str(p, 'sessionId') ?? null
  const sample = await tools.ot.samples.findById(sampleId)
  if (sample === null) {
    throw new OtRuleViolation('NOT_FOUND', `样本不存在（sampleId=${sampleId}）`)
  }
  await assertPlantScope(tools, sample.plantId)
  if (sessionId !== null) {
    const session = await tools.otSessions.findSessionById(sessionId)
    if (session === null) {
      throw new OtRuleViolation('NOT_FOUND', `工序执行实例不存在（sessionId=${sessionId}）`)
    }
  }
  const nextStatus = sessionId === null ? 'unlinked' : 'manual_bound'
  const before = { sessionId: sample.sessionId, sessionLinkStatus: sample.sessionLinkStatus }
  const updated = await tools.ot.samples.updateSessionLink(
    sampleId,
    { sessionId, sessionLinkStatus: nextStatus },
    ctx.actorLoginName,
  )
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.session.link',
    subjectType: 'ot_sample',
    subjectId: sampleId,
    before,
    after: { sessionId, sessionLinkStatus: nextStatus },
    reason: str(p, 'reason') ?? null,
  })
  return { sampleId, sessionId, sessionLinkStatus: nextStatus, updated: updated !== null }
}

// ---------------- 命令：汇总显式重建（OT-S4/OT-19） ----------------

async function aggregateRebuild(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const granularityRaw = str(p, 'granularity')
  if (granularityRaw !== 'minute' && granularityRaw !== 'shift') {
    throw new OtRuleViolation('OT-S4', 'granularity 必须为 minute/shift')
  }
  const from = requireIso(p, 'from', 'ot.aggregate.rebuild')
  const to = requireIso(p, 'to', 'ot.aggregate.rebuild')
  if (Date.parse(from) >= Date.parse(to)) {
    throw new OtRuleViolation('OT-S4', '重建窗口必须 from < to')
  }
  const plantId = str(p, 'plantId')
  if (plantId !== undefined) await assertPlantScope(tools, plantId)
  const scope = await tools.actorDataScope()
  const deviceSerialParam = str(p, 'deviceSerial')
  const deviceSerials =
    deviceSerialParam !== undefined
      ? [deviceSerialParam]
      : await tools.ot.samples.listDevicesWithSamples({ plantId, from, to })
  let windowsDeleted = 0
  let windowsWritten = 0
  for (const serial of deviceSerials) {
    const rows = await tools.ot.samples.listByDeviceWindow(serial, from, to)
    if (rows.length === 0) continue
    const plantOfRows = rows[0]!.plantId
    if (!scope.enterpriseWide && !scope.plantIds.includes(plantOfRows)) {
      // 数据范围二道防线：非授权工厂的原始行不进本 actor 的重建
      continue
    }
    const enterpriseOfRows = rows[0]!.enterpriseId
    const windows = new Map<string, AggregateValues>()
    for (const row of rows) {
      const windowStart =
        granularityRaw === 'minute'
          ? minuteWindowStart(row.eventTime)
          : shiftWindowStartIso(computeShiftDate(row.eventTime))
      const key = `${row.pointCode}::${windowStart}`
      const merged = mergeAggregate(windows.get(key) ?? null, {
        eventTime: row.eventTime,
        normalizedValue: row.normalizedValue === null ? null : Number(row.normalizedValue),
        qualityLevel: row.qualityLevel,
        isBad: row.isBad,
        isClockSkew: row.isClockSkew,
        isQuarantined: row.isQuarantined,
      })
      windows.set(key, merged)
    }
    windowsDeleted += await tools.ot.aggregates.deleteRange({
      deviceSerial: serial,
      granularity: granularityRaw,
      from,
      to,
    })
    for (const [key, values] of windows) {
      if (values.sampleCount + values.badCount + values.skewCount === 0) continue
      const sep = key.indexOf('::')
      const pointCode = key.slice(0, sep)
      const windowStart = key.slice(sep + 2)
      await tools.ot.aggregates.upsert({
        deviceSerial: serial,
        pointCode,
        granularity: granularityRaw,
        windowStart,
        sampleCount: values.sampleCount,
        goodCount: values.goodCount,
        badCount: values.badCount,
        skewCount: values.skewCount,
        sumValue: values.sumValue,
        minValue: values.minValue,
        maxValue: values.maxValue,
        firstEventTime: values.firstEventTime,
        lastEventTime: values.lastEventTime,
        plantId: plantOfRows,
        enterpriseId: enterpriseOfRows,
        updatedBy: ctx.actorLoginName,
      })
      windowsWritten += 1
    }
  }
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.aggregate.rebuild',
    subjectType: 'ot_aggregate',
    subjectId: `${granularityRaw}:${from}~${to}`,
    after: {
      granularity: granularityRaw,
      from,
      to,
      devices: deviceSerials.length,
      windowsWritten,
      windowsDeleted,
    },
    reason: str(p, 'reason') ?? null,
  })
  return {
    granularity: granularityRaw,
    from,
    to,
    devices: deviceSerials.length,
    windowsWritten,
    windowsDeleted,
  }
}

// ---------------- 命令：业务映射（OT-26） ----------------

async function mappingUpsert(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'ot.mapping.upsert')
  const deviceSerial = requireStr(p, 'deviceSerial', 'ot.mapping.upsert')
  const pointCode = requireStr(p, 'pointCode', 'ot.mapping.upsert')
  const factKind = str(p, 'factKind') ?? ''
  const confirmMode = str(p, 'confirmMode') ?? ''
  await assertPlantScope(tools, plantId)
  const point = await tools.ot.points.findByDeviceAndCode(deviceSerial, pointCode)
  if (point === null) {
    throw new OtRuleViolation('NOT_FOUND', `点位未登记（deviceSerial=${deviceSerial} pointCode=${pointCode}）`)
  }
  assertMappingSpec({ factKind, confirmMode, participatesInBusiness: point.participatesInBusiness })
  const paramsRaw = p['params']
  const params =
    paramsRaw !== undefined && paramsRaw !== null && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw)
      ? (paramsRaw as Record<string, unknown>)
      : {}
  const record = await tools.ot.mappings.upsert({
    deviceSerial,
    pointCode,
    factKind: factKind as 'meter_to_quantity' | 'stop_to_downtime',
    confirmMode: confirmMode as 'auto' | 'manual',
    params,
    plantId,
    enterpriseId: ctx.enterpriseId,
    createdBy: ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.mapping.upsert',
    subjectType: 'ot_business_mapping',
    subjectId: record.id,
    after: { deviceSerial, pointCode, factKind, confirmMode, version: record.version },
    reason: str(p, 'reason') ?? null,
  })
  return { mappingId: record.id, version: record.version, factKind, confirmMode }
}

/** 事实快照载荷（Outbox 任务载荷=业务时点快照，重试不改推当前值）。 */
function factOutboxPayload(
  fact: OtBusinessFactRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    factId: fact.id,
    mappingId: fact.mappingId,
    mappingVersion: fact.mappingVersion,
    factKind: fact.factKind,
    deviceSerial: fact.deviceSerial,
    pointCode: fact.pointCode,
    windowStart: fact.windowStart,
    windowEnd: fact.windowEnd,
    value: fact.value,
    ...extra,
  }
}

/** OT-26：由样本生成的业务事实走正常命令链路（幂等由命令总线承担、审计已记、Outbox 同事务）。 */
async function dispatchFact(
  tools: OtCommandTools,
  ctx: CommandContext,
  fact: OtBusinessFactRecord,
  extra: Record<string, unknown>,
): Promise<string> {
  const outboxEventId = await tools.otOutbox.insert({
    aggregateType: 'ot_business_fact',
    aggregateId: fact.id,
    taskKind: 'ot.business-fact',
    payload: factOutboxPayload(fact, extra),
  })
  await tools.ot.facts.markDispatched(
    fact.id,
    { outboxEventId, confirmedBy: ctx.actorLoginName, confirmedAt: tools.now().toISOString() },
    ctx.actorLoginName,
  )
  return outboxEventId
}

async function mappingEvaluate(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const mappingId = requireStr(p, 'mappingId', 'ot.mapping.evaluate')
  const from = requireIso(p, 'from', 'ot.mapping.evaluate')
  const to = requireIso(p, 'to', 'ot.mapping.evaluate')
  if (Date.parse(from) >= Date.parse(to)) {
    throw new OtRuleViolation('OT-26', '评估窗口必须 from < to')
  }
  const mapping: OtMappingRecord | null = await tools.ot.mappings.findById(mappingId)
  if (mapping === null) {
    throw new OtRuleViolation('NOT_FOUND', `映射配置不存在（mappingId=${mappingId}）`)
  }
  await assertPlantScope(tools, mapping.plantId)
  const rows = (await tools.ot.samples.listByDeviceWindow(mapping.deviceSerial, from, to)).sort(
    (a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime),
  )
  const mappingSamples = rows.map((r) => ({
    eventTime: r.eventTime,
    normalizedValue: r.normalizedValue === null ? null : Number(r.normalizedValue),
    qualityLevel: r.qualityLevel,
    isBad: r.isBad,
    isClockSkew: r.isClockSkew,
    isQuarantined: r.isQuarantined,
  }))
  const usableCount = mappingSamples.filter((s) => !s.isQuarantined && !s.isBad && !s.isClockSkew).length

  const candidates: Array<{
    windowStart: string
    windowEnd: string
    value: string | null
    payload: Record<string, unknown>
  }> = []
  if (mapping.factKind === 'meter_to_quantity') {
    const { quantity } = evaluateMeterToQuantity(mappingSamples)
    if (quantity === null) {
      // OT-28：缺采集不产生假值——无合格样本不生成事实（指标展示缺项）
      return { mappingId, created: 0, skipped: 0, dispatched: 0, reason: 'no_usable_samples' }
    }
    candidates.push({
      windowStart: from,
      windowEnd: to,
      value: quantity,
      payload: { usableSampleCount: usableCount },
    })
  } else {
    const stopLevelRaw = (mapping.params as { stopLevel?: unknown })['stopLevel']
    const stopLevel = typeof stopLevelRaw === 'number' && Number.isFinite(stopLevelRaw) ? stopLevelRaw : 1
    const intervals = evaluateStopToDowntime(mappingSamples, { stopLevel })
    for (const it of intervals) {
      candidates.push({
        windowStart: it.startedAt,
        windowEnd: it.endedAt,
        value: null,
        payload: { stillRunning: it.stillRunning, durationSeconds: it.durationSeconds, stopLevel },
      })
    }
    if (candidates.length === 0) {
      return { mappingId, created: 0, skipped: 0, dispatched: 0, reason: 'no_stop_runs' }
    }
  }

  let created = 0
  let skipped = 0
  let dispatched = 0
  for (const c of candidates) {
    const existing = await tools.ot.facts.findByKey(mappingId, c.windowStart, c.windowEnd)
    if (existing !== null) {
      skipped += 1
      continue
    }
    const fact = await tools.ot.facts.insert({
      mappingId,
      mappingVersion: mapping.version,
      factKind: mapping.factKind,
      deviceSerial: mapping.deviceSerial,
      pointCode: mapping.pointCode,
      windowStart: c.windowStart,
      windowEnd: c.windowEnd,
      value: c.value,
      payload: c.payload,
      status: mapping.confirmMode === 'auto' ? 'dispatched' : 'pending_confirm',
      plantId: mapping.plantId,
      enterpriseId: mapping.enterpriseId,
      createdBy: ctx.actorLoginName,
    })
    created += 1
    if (mapping.confirmMode === 'auto') {
      await dispatchFact(tools, ctx, fact, { confirmedBy: null })
      dispatched += 1
    }
  }
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.mapping.evaluate',
    subjectType: 'ot_business_mapping',
    subjectId: mappingId,
    after: { mappingId, from, to, created, skipped, dispatched, confirmMode: mapping.confirmMode },
    reason: str(p, 'reason') ?? null,
  })
  return { mappingId, from, to, created, skipped, dispatched, pendingConfirm: created - dispatched }
}

async function mappingConfirm(
  tools: OtCommandTools,
  ctx: CommandContext,
  p: Payload,
): Promise<Record<string, unknown>> {
  const factId = requireStr(p, 'factId', 'ot.mapping.confirm')
  const fact = await tools.ot.facts.findById(factId)
  if (fact === null) {
    throw new OtRuleViolation('NOT_FOUND', `业务事实候选不存在（factId=${factId}）`)
  }
  await assertPlantScope(tools, fact.plantId)
  if (fact.status === 'dispatched') {
    // 幂等：已派发不重复派发（不重复写 Outbox）
    return { factId, dispatched: false, skipped: true }
  }
  const outboxEventId = await dispatchFact(tools, ctx, fact, { confirmedBy: ctx.actorLoginName })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'ot.mapping.confirm',
    subjectType: 'ot_business_fact',
    subjectId: factId,
    before: { status: fact.status },
    after: { status: 'dispatched', outboxEventId },
    reason: str(p, 'reason') ?? null,
  })
  return { factId, dispatched: true, outboxEventId }
}

// ---------------- 处理器装配 ----------------

type OtHandlerFn = (
  tools: OtCommandTools,
  ctx: CommandContext,
  payload: Payload,
) => Promise<Record<string, unknown>>

export function createOtCommandHandlers(): CommandHandler[] {
  const make = (commandType: string, fn: OtHandlerFn): CommandHandler => ({
    commandType,
    handle: (envelope: CommandEnvelope<unknown>, ctx: CommandContext, tools): Promise<HandlerOutcome> =>
      run(async () => {
        const otTools = tools as OtCommandTools // 组合根构造的工具集窄化（见 ot.composition）
        const payload = (envelope.payload ?? {}) as Payload
        return fn(otTools, ctx, payload)
      }),
  })

  return [
    make('ot.gateway.register', gatewayRegister),
    make('ot.gateway.heartbeat', gatewayHeartbeat),
    make('ot.gateway.monitor', gatewayMonitor),
    make('ot.device.bind', deviceBind),
    make('ot.point.upsert', pointUpsert),
    make('ot.quality-map.upsert', qualityMapUpsert),
    make('ot.conversion.upsert', conversionUpsert),
    make('ot.samples.ingest', samplesIngest),
    make('ot.session.link', sessionLink),
    make('ot.aggregate.rebuild', aggregateRebuild),
    make('ot.mapping.upsert', mappingUpsert),
    make('ot.mapping.evaluate', mappingEvaluate),
    make('ot.mapping.confirm', mappingConfirm),
  ]
}
