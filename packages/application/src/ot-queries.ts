import type { PageResult } from '@cadenza/contracts'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  OtAggregateRecord,
  OtBusinessFactRecord,
  OtMappingRepository,
  OtBusinessFactRepository,
  OtDeviceRecord,
  OtDeviceRepository,
  OtGatewayEventRepository,
  OtGatewayRepository,
  OtMappingRecord,
  OtPointRecord,
  OtPointRepository,
  OtQualityCodeMapEntryRecord,
  OtQualityCodeMapRepository,
  OtSampleListFilter,
  OtSampleRecord,
  OtSampleRepository,
  OtStatsRecord,
  OtStatsRepository,
  OtAggregateRepository,
  OtEquipmentLookup,
} from './ot-repositories'
 
import {
  BAD_POINT_REASON_LABELS,
  CLOCK_SKEW_KIND_LABELS,
  POINT_SEMANTIC_LABELS,
  QUALITY_LEVEL_LABELS,
  SESSION_LINK_STATUS_LABELS,
  type BadPointReason,
  type ClockSkewKind,
  type PointSemantic,
} from '@cadenza/domain'

/**
 * ot 域查询服务（读侧，池连接只读；许可由 HTTP 守卫首检，数据范围在本服务内
 * 按授权上下文服务端过滤——网关/设备/点位/样本/汇总/映射/事实/统计按 plant 收敛）。
 *
 * OT-25：业务页面不扫高频原始点位——样本明细查询必须按设备收敛（deviceSerial 必填），
 * 报表与页面消费汇总投影与显式生成的业务事实；汇总投影带更新时间与数据截至
 * （延迟标注）。OT-22：坏点与偏差样本保留可查（带原因）；坏点率按设备/点位自汇总
 * 投影统计。OT-28：缺采集不产生假值——无样本设备的采集延迟为缺项（null+noData）。
 */

export interface OtQueryDeps {
  gateways: OtGatewayRepository
  gatewayEvents: OtGatewayEventRepository
  devices: OtDeviceRepository
  points: OtPointRepository
  qualityMaps: OtQualityCodeMapRepository
  samples: OtSampleRepository
  aggregates: OtAggregateRepository
  stats: OtStatsRepository
  mappings: OtMappingRepository
  facts: OtBusinessFactRepository
  equipment: OtEquipmentLookup
}

const GATEWAY_STATUS_LABELS: Readonly<Record<string, string>> = {
  online: '在线',
  offline: '离线',
}

const GATEWAY_EVENT_KIND_LABELS: Readonly<Record<string, string>> = {
  registered: '注册',
  heartbeat_restored: '恢复在线',
  offline: '离线告警',
  overflow: '缓冲溢出',
}

const FACT_KIND_LABELS: Readonly<Record<string, string>> = {
  meter_to_quantity: '计长→报工数量',
  stop_to_downtime: '停机信号→停机事件',
}

const CONFIRM_MODE_LABELS: Readonly<Record<string, string>> = {
  auto: '自动入账',
  manual: '须人工确认',
}

const FACT_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending_confirm: '待确认',
  dispatched: '已派发',
}

function toPageRequest(query: { page?: unknown; pageSize?: unknown }): { page: number; pageSize: number } {
  const page = typeof query.page === 'number' && Number.isInteger(query.page) && query.page >= 1 ? query.page : 1
  const pageSize =
    typeof query.pageSize === 'number' && Number.isInteger(query.pageSize) && query.pageSize >= 1
      ? Math.min(query.pageSize, 100)
      : 20
  return { page, pageSize }
}

const like = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export class OtQueryService {
  constructor(private readonly deps: OtQueryDeps) {}

  /** 数据范围折算：企业范围 → null（不过滤）；否则限定授权工厂集合。 */
  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  // ---------------- 网关 ----------------

  async listGateways(
    auth: VerifiedAuthContext,
    query: { plantId?: string; status?: string; page?: number; pageSize?: number },
  ): Promise<
    PageResult<{
      gatewayId: string
      gatewayCode: string
      plantId: string
      protocolConfig: Record<string, unknown>
      sampleRateHz: number
      bufferCapacity: number
      heartbeatTimeoutSeconds: number
      status: string
      statusLabel: string
      lastHeartbeatAt: string | null
      checkpointSeq: number
      lastBacklogCount: number
      deviceCount: number
    }>
  > {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.gateways.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      status: query.status,
      ...pageRequest,
    })
    const deviceCounts = new Map<string, number>()
    for (const g of page.items) {
      deviceCounts.set(g.gatewayCode, await this.deps.gateways.countDevices(g.gatewayCode))
    }
    return {
      items: page.items.map((g) => ({
        gatewayId: g.id,
        gatewayCode: g.gatewayCode,
        plantId: g.plantId,
        protocolConfig: g.protocolConfig,
        sampleRateHz: g.sampleRateHz,
        bufferCapacity: g.bufferCapacity,
        heartbeatTimeoutSeconds: g.heartbeatTimeoutSeconds,
        status: g.status,
        statusLabel: GATEWAY_STATUS_LABELS[g.status] ?? g.status,
        lastHeartbeatAt: g.lastHeartbeatAt,
        checkpointSeq: g.checkpointSeq,
        lastBacklogCount: g.lastBacklogCount,
        deviceCount: deviceCounts.get(g.gatewayCode) ?? 0,
      })),
      total: page.total,
      ...pageRequest,
    }
  }

  async gatewayEvents(
    auth: VerifiedAuthContext,
    gatewayCode: string,
    limit = 50,
  ): Promise<
    Array<{
      eventId: string
      gatewayCode: string
      eventKind: string
      eventKindLabel: string
      detail: Record<string, unknown>
      occurredAt: string
      createdBy: string | null
    }>
  > {
    // 网关事件按网关维度收敛：网关不在授权范围内 → 空列表（不留越权入口）
    const gateway = await this.deps.gateways.findByCode(gatewayCode)
    const scope = this.plantScope(auth)
    if (gateway === null || (scope !== null && !scope.includes(gateway.plantId))) return []
    const events = await this.deps.gatewayEvents.listByGateway(gatewayCode, Math.min(limit, 200))
    return events.map((e) => ({
      eventId: e.id,
      gatewayCode: e.gatewayCode,
      eventKind: e.eventKind,
      eventKindLabel: GATEWAY_EVENT_KIND_LABELS[e.eventKind] ?? e.eventKind,
      detail: e.detail,
      occurredAt: e.occurredAt,
      createdBy: e.createdBy,
    }))
  }

  // ---------------- 设备 ----------------

  async listDevices(
    auth: VerifiedAuthContext,
    query: { plantId?: string; gatewayCode?: string; page?: number; pageSize?: number },
  ): Promise<
    PageResult<{
      deviceSerial: string
      plantId: string
      gatewayCode: string | null
      equipmentId: string | null
      equipmentCode: string | null
      boundBy: string | null
      boundAt: string | null
      clockSkewThresholdSeconds: number
      lastSampleAt: string | null
      lastSampleAgeSeconds: number | null
      quarantinedSampleCount: number
    }>
  > {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.devices.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      gatewayCode: like(query.gatewayCode),
      ...pageRequest,
    })
    const now = Date.now()
    const items = await Promise.all(
      page.items.map(async (d: OtDeviceRecord) => {
        const latest = await this.deps.samples.findLatestByDevice(d.deviceSerial)
        const quarantined = await this.deps.samples.listQuarantinedByDevice(d.deviceSerial)
        const equipment = d.equipmentId === null ? null : await this.deps.equipment.findEquipmentById(d.equipmentId)
        const lastSampleAt = latest?.eventTime ?? null
        const ageMs = lastSampleAt === null ? null : now - Date.parse(lastSampleAt)
        return {
          deviceSerial: d.deviceSerial,
          plantId: d.plantId,
          gatewayCode: d.gatewayCode,
          equipmentId: d.equipmentId,
          equipmentCode: equipment?.code ?? null,
          boundBy: d.boundBy,
          boundAt: d.boundAt,
          clockSkewThresholdSeconds: d.clockSkewThresholdSeconds,
          lastSampleAt,
          lastSampleAgeSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
          quarantinedSampleCount: quarantined.length,
        }
      }),
    )
    return { items, total: page.total, ...pageRequest }
  }

  // ---------------- 点位 ----------------

  async listPoints(
    auth: VerifiedAuthContext,
    deviceSerial: string,
  ): Promise<
    Array<{
      pointId: string
      plantId: string
      deviceSerial: string
      pointCode: string
      semantic: string
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
    }>
  > {
    const points = await this.deps.points.listByDevice(deviceSerial)
    const scope = this.plantScope(auth)
    const scoped = scope === null ? points : points.filter((p) => scope.includes(p.plantId))
    return scoped.map((p: OtPointRecord) => ({
      pointId: p.id,
      plantId: p.plantId,
      deviceSerial: p.deviceSerial,
      pointCode: p.pointCode,
      semantic: p.semantic,
      semanticLabel: POINT_SEMANTIC_LABELS[p.semantic as PointSemantic] ?? p.semantic,
      uomId: p.uomId,
      uomCode: p.uomCode,
      sampleRateSeconds: p.sampleRateSeconds,
      rangeMin: p.rangeMin,
      rangeMax: p.rangeMax,
      participatesInBusiness: p.participatesInBusiness,
      calibrationRecordNo: p.calibrationRecordNo,
      calibrationValidUntil: p.calibrationValidUntil,
      version: p.version,
    }))
  }

  async qualityMap(deviceSerial: string): Promise<OtQualityCodeMapEntryRecord[]> {
    return this.deps.qualityMaps.listByDevice(deviceSerial)
  }

  // ---------------- 样本（OT-25：按设备收敛；OT-22：坏点/偏差可查带原因） ----------------

  async listSamples(
    auth: VerifiedAuthContext,
    query: {
      deviceSerial?: string
      pointCode?: string
      qualityLevel?: string
      isBad?: boolean
      isClockSkew?: boolean
      isLate?: boolean
      isQuarantined?: boolean
      from?: string
      to?: string
      page?: number
      pageSize?: number
    },
  ): Promise<PageResult<ReturnType<OtQueryService['sampleView']>>> {
    if (query.deviceSerial === undefined || query.deviceSerial === '') {
      throw new Error('[OT-25] 样本明细查询必须按设备收敛（deviceSerial 必填）——页面不扫高频原始点位')
    }
    const pageRequest = toPageRequest(query)
    const filter: OtSampleListFilter = {
      plantIds: this.plantScope(auth),
      deviceSerial: query.deviceSerial,
      pointCode: like(query.pointCode),
      qualityLevel: like(query.qualityLevel),
      isBad: query.isBad,
      isClockSkew: query.isClockSkew,
      isLate: query.isLate,
      isQuarantined: query.isQuarantined,
      from: like(query.from),
      to: like(query.to),
      ...pageRequest,
    }
    const page = await this.deps.samples.listPaged(filter)
    return { items: page.items.map((s) => this.sampleView(s)), total: page.total, ...pageRequest }
  }

  private sampleView(s: OtSampleRecord) {
    return {
      sampleId: s.id,
      deviceSerial: s.deviceSerial,
      pointCode: s.pointCode,
      eventId: s.eventId,
      gatewaySeq: s.gatewaySeq,
      eventTime: s.eventTime,
      receivedAt: s.receivedAt,
      gatewayCode: s.gatewayCode,
      rawValue: s.rawValue,
      rawUnit: s.rawUnit,
      normalizedValue: s.normalizedValue,
      conversionRevision: s.conversionRevision,
      conversionMissing: s.conversionMissing,
      qualityLevel: s.qualityLevel,
      qualityLabel: QUALITY_LEVEL_LABELS[s.qualityLevel] ?? s.qualityLevel,
      deviceQualityCode: s.deviceQualityCode,
      isBad: s.isBad,
      badReasons: s.badReasons.map((r) => ({
        code: r,
        label: BAD_POINT_REASON_LABELS[r as BadPointReason] ?? r,
      })),
      isClockSkew: s.isClockSkew,
      clockSkewKind: s.clockSkewKind,
      clockSkewLabel:
        s.clockSkewKind === null ? null : CLOCK_SKEW_KIND_LABELS[s.clockSkewKind as ClockSkewKind] ?? null,
      isLate: s.isLate,
      calibrationSuspect: s.calibrationSuspect,
      sessionId: s.sessionId,
      sessionLinkStatus: s.sessionLinkStatus,
      sessionLinkStatusLabel: SESSION_LINK_STATUS_LABELS[s.sessionLinkStatus] ?? s.sessionLinkStatus,
      isQuarantined: s.isQuarantined,
      quarantineReason: s.quarantineReason,
    }
  }

  // ---------------- 汇总投影（OT-25：带更新时间与延迟标注） ----------------

  async listAggregates(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      deviceSerial?: string
      pointCode?: string
      granularity?: string
      from?: string
      to?: string
      page?: number
      pageSize?: number
    },
  ): Promise<PageResult<ReturnType<OtQueryService['aggregateView']>>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.aggregates.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      deviceSerial: like(query.deviceSerial),
      pointCode: like(query.pointCode),
      granularity: like(query.granularity),
      from: like(query.from),
      to: like(query.to),
      ...pageRequest,
    })
    const now = Date.now()
    return {
      items: page.items.map((a) => ({
        ...this.aggregateView(a),
        /** 延迟标注（OT-25）：投影数据截至事件时间距今 */
        dataLagSeconds: Math.round((now - Date.parse(a.lastEventTime)) / 1000),
      })),
      total: page.total,
      ...pageRequest,
    }
  }

  private aggregateView(a: OtAggregateRecord) {
    return {
      aggregateId: a.id,
      deviceSerial: a.deviceSerial,
      pointCode: a.pointCode,
      granularity: a.granularity,
      windowStart: a.windowStart,
      sampleCount: a.sampleCount,
      goodCount: a.goodCount,
      badCount: a.badCount,
      skewCount: a.skewCount,
      sumValue: a.sumValue,
      minValue: a.minValue,
      maxValue: a.maxValue,
      firstEventTime: a.firstEventTime,
      lastEventTime: a.lastEventTime,
      updatedAt: a.updatedAt,
      /** 坏点率（OT-22：按设备/点位统计展示；分母=合格+坏+偏差以外的可用样本与坏点） */
      badRate: a.sampleCount + a.badCount === 0 ? null : a.badCount / (a.sampleCount + a.badCount),
    }
  }

  // ---------------- 映射与事实（OT-26） ----------------

  async listMappings(
    auth: VerifiedAuthContext,
    query: { plantId?: string; deviceSerial?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<ReturnType<OtQueryService['mappingView']>>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.mappings.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      deviceSerial: like(query.deviceSerial),
      ...pageRequest,
    })
    return { items: page.items.map((m) => this.mappingView(m)), total: page.total, ...pageRequest }
  }

  private mappingView(m: OtMappingRecord) {
    return {
      mappingId: m.id,
      plantId: m.plantId,
      deviceSerial: m.deviceSerial,
      pointCode: m.pointCode,
      factKind: m.factKind,
      factKindLabel: FACT_KIND_LABELS[m.factKind] ?? m.factKind,
      confirmMode: m.confirmMode,
      confirmModeLabel: CONFIRM_MODE_LABELS[m.confirmMode] ?? m.confirmMode,
      params: m.params,
      version: m.version,
    }
  }

  async listFacts(
    auth: VerifiedAuthContext,
    query: { plantId?: string; mappingId?: string; status?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<ReturnType<OtQueryService['factView']>>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.facts.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      mappingId: like(query.mappingId),
      status: like(query.status),
      ...pageRequest,
    })
    return { items: page.items.map((f) => this.factView(f)), total: page.total, ...pageRequest }
  }

  private factView(f: OtBusinessFactRecord) {
    return {
      factId: f.id,
      mappingId: f.mappingId,
      mappingVersion: f.mappingVersion,
      factKind: f.factKind,
      factKindLabel: FACT_KIND_LABELS[f.factKind] ?? f.factKind,
      deviceSerial: f.deviceSerial,
      pointCode: f.pointCode,
      windowStart: f.windowStart,
      windowEnd: f.windowEnd,
      value: f.value,
      payload: f.payload,
      status: f.status,
      statusLabel: FACT_STATUS_LABELS[f.status] ?? f.status,
      confirmedBy: f.confirmedBy,
      confirmedAt: f.confirmedAt,
      outboxEventId: f.outboxEventId,
    }
  }

  // ---------------- 统计与监控（OT-S5/OT-29/OT-28） ----------------

  async listStats(
    auth: VerifiedAuthContext,
    query: { statDate?: string; gatewayCode?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<OtStatsRecord>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.stats.listPaged({
      plantIds: this.plantScope(auth),
      statDate: like(query.statDate),
      gatewayCode: like(query.gatewayCode),
      ...pageRequest,
    })
    return { items: page.items, total: page.total, ...pageRequest }
  }

  /** OT-29 必监项总览：边缘离线、采集延迟（含缺项 OT-28）、缓冲积压/溢出、去重计数异常。 */
  async monitorOverview(
    auth: VerifiedAuthContext,
    query: { plantId?: string; dedupAlertThreshold?: number },
  ): Promise<{
    gateways: Array<{
      gatewayCode: string
      plantId: string
      status: string
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
      noData: boolean
    }>
    dedup: Array<{ statDate: string; gatewayCode: string; deviceSerial: string; dedupCount: number; dedupAnomaly: boolean }>
    overflow: Array<{ statDate: string; gatewayCode: string; deviceSerial: string; overflowCount: number }>
  }> {
    const scope = this.plantScope(auth)
    const now = Date.now()
    const gateways = await this.deps.gateways.listAll({ plantIds: scope, plantId: query.plantId })
    const threshold = query.dedupAlertThreshold ?? 100
    const devicePage = await this.deps.devices.listPaged({
      plantIds: scope,
      plantId: query.plantId,
      page: 1,
      pageSize: 100,
    })
    const deviceLatency = await Promise.all(
      devicePage.items.map(async (d) => {
        const latest = await this.deps.samples.findLatestByDevice(d.deviceSerial)
        const equipment = d.equipmentId === null ? null : await this.deps.equipment.findEquipmentById(d.equipmentId)
        const lastSampleAt = latest?.eventTime ?? null
        return {
          deviceSerial: d.deviceSerial,
          equipmentCode: equipment?.code ?? null,
          lastSampleAt,
          latencySeconds:
            lastSampleAt === null ? null : Math.round((now - Date.parse(lastSampleAt)) / 1000),
          // OT-28：缺采集不产生假值——无样本 → 缺项标记，不以估算冒充实测
          noData: lastSampleAt === null,
        }
      }),
    )
    const dedupRows = await this.deps.stats.listByDeviceSerials(
      devicePage.items.map((d) => d.deviceSerial),
      { dedupAbove: 0 },
    )
    const overflowRows = dedupRows.filter((r) => r.overflowCount > 0)
    return {
      gateways: gateways.map((g) => ({
        gatewayCode: g.gatewayCode,
        plantId: g.plantId,
        status: g.status,
        statusLabel: GATEWAY_STATUS_LABELS[g.status] ?? g.status,
        lastHeartbeatAt: g.lastHeartbeatAt,
        staleSeconds:
          g.lastHeartbeatAt === null ? null : Math.round((now - Date.parse(g.lastHeartbeatAt)) / 1000),
        backlogCount: g.lastBacklogCount,
      })),
      deviceLatency,
      dedup: dedupRows.map((r) => ({
        statDate: r.statDate,
        gatewayCode: r.gatewayCode,
        deviceSerial: r.deviceSerial,
        dedupCount: r.dedupCount,
        dedupAnomaly: r.dedupCount > threshold,
      })),
      overflow: overflowRows.map((r) => ({
        statDate: r.statDate,
        gatewayCode: r.gatewayCode,
        deviceSerial: r.deviceSerial,
        overflowCount: r.overflowCount,
      })),
    }
  }
}
