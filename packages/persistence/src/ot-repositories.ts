// [L0-整合标记] 跨包类型导入（type-only，编译期擦除）：指向 application 已构建的 dist
// （构建顺序由 workspace 拓扑保证：persistence 依赖 application）。ot 端口尚未并入
// @cadenza/application 包名入口（application/src/index.ts 为共享文件不改动），故走 dist
// 相对；L0 整合步把端口导出并入 application index、本文件导出并入 persistence index
// 后改包名导入（同 shipping 先例）。
import type {
  NewOtConversion,
  NewOtDevice,
  NewOtGateway,
  NewOtGatewayEvent,
  NewOtMapping,
  NewOtOverflowStat,
  NewOtPoint,
  NewOtSample,
  OtAggregateRecord,
  OtAggregateRepository,
  OtAggregateUpsert,
  OtBusinessFactRecord,
  OtBusinessFactRepository,
  OtCommandTools,
  OtConversionRecord,
  OtConversionRepository,
  OtDeviceRecord,
  OtDeviceRepository,
  OtEquipmentLookup,
  OtGatewayEventRecord,
  OtGatewayEventRepository,
  OtGatewayRecord,
  OtGatewayRepository,
  OtMappingRecord,
  OtMappingRepository,
  OtOutboxWriter,
  OtPointRecord,
  OtPointRepository,
  OtQualityCodeMapEntryRecord,
  OtQualityCodeMapRepository,
  OtQuarantineInboxStore,
  OtRepositories,
  OtSampleListFilter,
  OtSampleReprocessPatch,
  OtSampleRecord,
  OtSampleRepository,
  OtSessionLookup,
  OtStatsRecord,
  OtStatsRepository,
  QualityLevelValue,
} from '@cadenza/application'
import type { OutboxIntent } from '@cadenza/application'
import type { SqlClient } from './sql-client'

/**
 * ot 域仓储的 PostgreSQL 实现（implements application 端口；0017 ot 表列一一对应）。
 * ot_sample 为原始事实层：UPDATE 仅开放分类列（库级触发器保护事实列），DELETE 拒；
 * 跨域只读投影（execution_session / equipment）为等价读，不改归属域文件。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

// ---------------- ot_gateway ----------------

const GATEWAY_COLUMNS = `id, gateway_code, protocol_config, sample_rate_hz, buffer_capacity,
  heartbeat_timeout_seconds, last_heartbeat_at, status, last_status_changed_at, checkpoint_seq,
  last_backlog_count, plant_id, enterprise_id, created_at, created_by, updated_at, updated_by`

interface GatewayRow {
  id: string
  gateway_code: string
  protocol_config: Record<string, unknown> | null
  sample_rate_hz: number
  buffer_capacity: number
  heartbeat_timeout_seconds: number
  last_heartbeat_at: Date | string | null
  status: 'online' | 'offline'
  last_status_changed_at: Date | string | null
  checkpoint_seq: string | number
  last_backlog_count: number
  plant_id: string
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapGateway(r: GatewayRow): OtGatewayRecord {
  return {
    id: r.id,
    gatewayCode: r.gateway_code,
    protocolConfig: r.protocol_config ?? {},
    sampleRateHz: r.sample_rate_hz,
    bufferCapacity: r.buffer_capacity,
    heartbeatTimeoutSeconds: r.heartbeat_timeout_seconds,
    lastHeartbeatAt: isoOrNull(r.last_heartbeat_at),
    status: r.status,
    lastStatusChangedAt: isoOrNull(r.last_status_changed_at),
    checkpointSeq: Number(r.checkpoint_seq),
    lastBacklogCount: r.last_backlog_count,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgOtGatewayRepository implements OtGatewayRepository {
  constructor(private readonly client: SqlClient) {}

  async upsert(gateway: NewOtGateway): Promise<OtGatewayRecord> {
    const r = await this.client.query(
      `INSERT INTO ot_gateway (gateway_code, protocol_config, sample_rate_hz, buffer_capacity,
         heartbeat_timeout_seconds, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (gateway_code) DO UPDATE SET
         protocol_config = EXCLUDED.protocol_config,
         sample_rate_hz = EXCLUDED.sample_rate_hz,
         buffer_capacity = EXCLUDED.buffer_capacity,
         heartbeat_timeout_seconds = EXCLUDED.heartbeat_timeout_seconds,
         plant_id = EXCLUDED.plant_id,
         updated_at = now(), updated_by = EXCLUDED.created_by
       RETURNING ${GATEWAY_COLUMNS}`,
      [
        gateway.gatewayCode,
        JSON.stringify(gateway.protocolConfig ?? {}),
        gateway.sampleRateHz ?? 1,
        gateway.bufferCapacity ?? 10_000,
        gateway.heartbeatTimeoutSeconds ?? 60,
        gateway.plantId,
        gateway.enterpriseId,
        gateway.createdBy ?? null,
      ],
    )
    return mapGateway(r.rows[0] as GatewayRow)
  }

  async findByCode(gatewayCode: string): Promise<OtGatewayRecord | null> {
    const r = await this.client.query(
      `SELECT ${GATEWAY_COLUMNS} FROM ot_gateway WHERE gateway_code = $1`,
      [gatewayCode],
    )
    return r.rowCount === 0 ? null : mapGateway(r.rows[0] as GatewayRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    status?: string
    page: number
    pageSize: number
  }): Promise<{ items: OtGatewayRecord[]; total: number }> {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null && filter.plantIds.length > 0) {
      params.push(filter.plantIds)
      where.push(`plant_id = ANY($${params.length}::uuid[])`)
    }
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where.push(`plant_id = $${params.length}::uuid`)
    }
    if (filter.status !== undefined) {
      params.push(filter.status)
      where.push(`status = $${params.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(
      `SELECT count(*)::int AS c FROM ot_gateway ${clause}`,
      params,
    )
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${GATEWAY_COLUMNS} FROM ot_gateway ${clause}
       ORDER BY gateway_code LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapGateway(row as GatewayRow)), total: total.rows[0]!.c }
  }

  async listAll(filter: { plantIds: string[] | null; plantId?: string }): Promise<OtGatewayRecord[]> {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null && filter.plantIds.length > 0) {
      params.push(filter.plantIds)
      where.push(`plant_id = ANY($${params.length}::uuid[])`)
    }
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where.push(`plant_id = $${params.length}::uuid`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const r = await this.client.query(`SELECT ${GATEWAY_COLUMNS} FROM ot_gateway ${clause} ORDER BY gateway_code`, params)
    return r.rows.map((row) => mapGateway(row as GatewayRow))
  }

  async updateHeartbeat(
    gatewayCode: string,
    patch: { backlogCount: number; heartbeatAt: string; actor: string | null },
  ): Promise<OtGatewayRecord | null> {
    const r = await this.client.query(
      `UPDATE ot_gateway SET last_heartbeat_at = $2, last_backlog_count = $3,
         updated_at = now(), updated_by = $4
       WHERE gateway_code = $1 RETURNING ${GATEWAY_COLUMNS}`,
      [gatewayCode, patch.heartbeatAt, patch.backlogCount, patch.actor],
    )
    return r.rowCount === 0 ? null : mapGateway(r.rows[0] as GatewayRow)
  }

  async updateStatus(
    gatewayCode: string,
    patch: { status: 'online' | 'offline'; changedAt: string; actor: string | null },
  ): Promise<OtGatewayRecord | null> {
    const r = await this.client.query(
      `UPDATE ot_gateway SET status = $2, last_status_changed_at = $3,
         updated_at = now(), updated_by = $4
       WHERE gateway_code = $1 RETURNING ${GATEWAY_COLUMNS}`,
      [gatewayCode, patch.status, patch.changedAt, patch.actor],
    )
    return r.rowCount === 0 ? null : mapGateway(r.rows[0] as GatewayRow)
  }

  async setCheckpoint(gatewayCode: string, checkpointSeq: number): Promise<void> {
    await this.client.query(
      `UPDATE ot_gateway SET checkpoint_seq = GREATEST(checkpoint_seq, $2), updated_at = now()
       WHERE gateway_code = $1`,
      [gatewayCode, checkpointSeq],
    )
  }

  async updateBacklog(gatewayCode: string, backlogCount: number): Promise<void> {
    await this.client.query(
      `UPDATE ot_gateway SET last_backlog_count = $2, updated_at = now() WHERE gateway_code = $1`,
      [gatewayCode, backlogCount],
    )
  }

  async countDevices(gatewayCode: string): Promise<number> {
    const r = await this.client.query(`SELECT count(*)::int AS c FROM ot_device WHERE gateway_code = $1`, [
      gatewayCode,
    ])
    return r.rows[0]!.c
  }
}

// ---------------- ot_gateway_event ----------------

export class PgOtGatewayEventRepository implements OtGatewayEventRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(event: NewOtGatewayEvent): Promise<OtGatewayEventRecord> {
    const r = await this.client.query(
      `INSERT INTO ot_gateway_event (gateway_code, plant_id, enterprise_id, event_kind, detail, occurred_at, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       RETURNING id, gateway_code, event_kind, detail, occurred_at, created_by`,
      [
        event.gatewayCode,
        event.plantId,
        event.enterpriseId,
        event.eventKind,
        JSON.stringify(event.detail ?? {}),
        event.occurredAt,
        event.createdBy ?? null,
      ],
    )
    const row = r.rows[0] as {
      id: string
      gateway_code: string
      event_kind: OtGatewayEventRecord['eventKind']
      detail: Record<string, unknown> | null
      occurred_at: Date | string
      created_by: string | null
    }
    return {
      id: row.id,
      gatewayCode: row.gateway_code,
      eventKind: row.event_kind,
      detail: row.detail ?? {},
      occurredAt: iso(row.occurred_at),
      createdBy: row.created_by,
    }
  }

  async listByGateway(gatewayCode: string, limit: number): Promise<OtGatewayEventRecord[]> {
    const r = await this.client.query(
      `SELECT id, gateway_code, event_kind, detail, occurred_at, created_by
       FROM ot_gateway_event WHERE gateway_code = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2`,
      [gatewayCode, limit],
    )
    return r.rows.map(
      (row) =>
        ({
          id: row.id,
          gatewayCode: row.gateway_code,
          eventKind: row.event_kind,
          detail: row.detail ?? {},
          occurredAt: iso(row.occurred_at),
          createdBy: row.created_by,
        }) satisfies OtGatewayEventRecord,
    )
  }
}

// ---------------- ot_device ----------------

const DEVICE_COLUMNS = `device_serial, gateway_code, equipment_id, bound_by, bound_at,
  clock_skew_threshold_seconds, plant_id, enterprise_id, created_at, created_by, updated_at, updated_by`

interface DeviceRow {
  device_serial: string
  gateway_code: string | null
  equipment_id: string | null
  bound_by: string | null
  bound_at: Date | string | null
  clock_skew_threshold_seconds: number
  plant_id: string
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapDevice(r: DeviceRow): OtDeviceRecord {
  return {
    deviceSerial: r.device_serial,
    gatewayCode: r.gateway_code,
    equipmentId: r.equipment_id,
    boundBy: r.bound_by,
    boundAt: isoOrNull(r.bound_at),
    clockSkewThresholdSeconds: r.clock_skew_threshold_seconds,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgOtDeviceRepository implements OtDeviceRepository {
  constructor(private readonly client: SqlClient) {}

  async upsert(device: NewOtDevice): Promise<OtDeviceRecord> {
    const r = await this.client.query(
      `INSERT INTO ot_device (device_serial, gateway_code, equipment_id, bound_by, bound_at,
         clock_skew_threshold_seconds, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (device_serial) DO UPDATE SET
         gateway_code = COALESCE(EXCLUDED.gateway_code, ot_device.gateway_code),
         equipment_id = EXCLUDED.equipment_id,
         bound_by = EXCLUDED.bound_by,
         bound_at = EXCLUDED.bound_at,
         clock_skew_threshold_seconds = EXCLUDED.clock_skew_threshold_seconds,
         updated_at = now(), updated_by = EXCLUDED.created_by
       RETURNING ${DEVICE_COLUMNS}`,
      [
        device.deviceSerial,
        device.gatewayCode ?? null,
        device.equipmentId ?? null,
        device.boundBy ?? null,
        device.boundAt ?? null,
        device.clockSkewThresholdSeconds ?? 120,
        device.plantId,
        device.enterpriseId,
        device.createdBy ?? null,
      ],
    )
    return mapDevice(r.rows[0] as DeviceRow)
  }

  async findBySerial(deviceSerial: string): Promise<OtDeviceRecord | null> {
    const r = await this.client.query(`SELECT ${DEVICE_COLUMNS} FROM ot_device WHERE device_serial = $1`, [
      deviceSerial,
    ])
    return r.rowCount === 0 ? null : mapDevice(r.rows[0] as DeviceRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    gatewayCode?: string
    page: number
    pageSize: number
  }): Promise<{ items: OtDeviceRecord[]; total: number }> {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null && filter.plantIds.length > 0) {
      params.push(filter.plantIds)
      where.push(`plant_id = ANY($${params.length}::uuid[])`)
    }
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where.push(`plant_id = $${params.length}::uuid`)
    }
    if (filter.gatewayCode !== undefined) {
      params.push(filter.gatewayCode)
      where.push(`gateway_code = $${params.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS c FROM ot_device ${clause}`, params)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${DEVICE_COLUMNS} FROM ot_device ${clause}
       ORDER BY device_serial LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapDevice(row as DeviceRow)), total: total.rows[0]!.c }
  }
}

// ---------------- ot_point ----------------

const POINT_COLUMNS = `id, device_serial, point_code, semantic, uom_id, uom_code, sample_rate_seconds,
  range_min, range_max, participates_in_business, calibration_record_no, calibration_valid_until,
  version, plant_id, enterprise_id, updated_at, updated_by`

interface PointRow {
  id: string
  device_serial: string
  point_code: string
  semantic: string
  uom_id: string | null
  uom_code: string
  sample_rate_seconds: number
  range_min: string | null
  range_max: string | null
  participates_in_business: boolean
  calibration_record_no: string | null
  calibration_valid_until: Date | string | null
  version: number
  plant_id: string
  enterprise_id: string
  updated_at: Date | string
  updated_by: string | null
}

function mapPoint(r: PointRow): OtPointRecord {
  return {
    id: r.id,
    deviceSerial: r.device_serial,
    pointCode: r.point_code,
    semantic: r.semantic,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    sampleRateSeconds: r.sample_rate_seconds,
    rangeMin: r.range_min,
    rangeMax: r.range_max,
    participatesInBusiness: r.participates_in_business,
    calibrationRecordNo: r.calibration_record_no,
    calibrationValidUntil: isoOrNull(r.calibration_valid_until),
    version: r.version,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgOtPointRepository implements OtPointRepository {
  constructor(private readonly client: SqlClient) {}

  async upsert(point: NewOtPoint): Promise<OtPointRecord> {
    const r = await this.client.query(
      `INSERT INTO ot_point (enterprise_id, plant_id, device_serial, point_code, semantic, uom_id,
         uom_code, sample_rate_seconds, range_min, range_max, participates_in_business,
         calibration_record_no, calibration_valid_until, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (plant_id, point_code) WHERE status = 'active' DO UPDATE SET
         device_serial = EXCLUDED.device_serial,
         semantic = EXCLUDED.semantic,
         uom_id = EXCLUDED.uom_id,
         uom_code = EXCLUDED.uom_code,
         sample_rate_seconds = EXCLUDED.sample_rate_seconds,
         range_min = EXCLUDED.range_min,
         range_max = EXCLUDED.range_max,
         participates_in_business = EXCLUDED.participates_in_business,
         calibration_record_no = EXCLUDED.calibration_record_no,
         calibration_valid_until = EXCLUDED.calibration_valid_until,
         version = ot_point.version + 1,
         updated_at = now(), updated_by = EXCLUDED.created_by
       RETURNING ${POINT_COLUMNS}`,
      [
        point.enterpriseId,
        point.plantId,
        point.deviceSerial,
        point.pointCode,
        point.semantic,
        point.uomId ?? null,
        point.uomCode,
        point.sampleRateSeconds,
        point.rangeMin ?? null,
        point.rangeMax ?? null,
        point.participatesInBusiness ?? false,
        point.calibrationRecordNo ?? null,
        point.calibrationValidUntil ?? null,
        point.createdBy ?? null,
      ],
    )
    return mapPoint(r.rows[0] as PointRow)
  }

  async findByPlantAndCode(plantId: string, pointCode: string): Promise<OtPointRecord | null> {
    const r = await this.client.query(
      `SELECT ${POINT_COLUMNS} FROM ot_point WHERE plant_id = $1 AND point_code = $2 AND status = 'active'`,
      [plantId, pointCode],
    )
    return r.rowCount === 0 ? null : mapPoint(r.rows[0] as PointRow)
  }

  async findByDeviceAndCode(deviceSerial: string, pointCode: string): Promise<OtPointRecord | null> {
    const r = await this.client.query(
      `SELECT ${POINT_COLUMNS} FROM ot_point WHERE device_serial = $1 AND point_code = $2 AND status = 'active'`,
      [deviceSerial, pointCode],
    )
    return r.rowCount === 0 ? null : mapPoint(r.rows[0] as PointRow)
  }

  async listByDevice(deviceSerial: string): Promise<OtPointRecord[]> {
    const r = await this.client.query(
      `SELECT ${POINT_COLUMNS} FROM ot_point WHERE device_serial = $1 AND status = 'active' ORDER BY point_code`,
      [deviceSerial],
    )
    return r.rows.map((row) => mapPoint(row as PointRow))
  }
}

// ---------------- ot_quality_code_map ----------------

export class PgOtQualityCodeMapRepository implements OtQualityCodeMapRepository {
  constructor(private readonly client: SqlClient) {}

  async replaceForDevice(
    deviceSerial: string,
    entries: ReadonlyArray<{ code: string; level: QualityLevelValue }>,
    context: { plantId: string; enterpriseId: string; actor: string | null },
  ): Promise<OtQualityCodeMapEntryRecord[]> {
    // 版本化：同设备全部行统一推进到 新版本（先查当前最大版本）
    const current = await this.client.query(
      `SELECT COALESCE(MAX(map_version), 0) AS v FROM ot_quality_code_map WHERE device_serial = $1`,
      [deviceSerial],
    )
    const nextVersion = (current.rows[0]!.v as number) + 1
    await this.client.query(`DELETE FROM ot_quality_code_map WHERE device_serial = $1`, [deviceSerial])
    for (const entry of entries) {
      await this.client.query(
        `INSERT INTO ot_quality_code_map (device_serial, device_quality_code, quality_level, map_version, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [deviceSerial, entry.code, entry.level, nextVersion, context.actor],
      )
    }
    return entries.map((e) => ({
      deviceSerial,
      deviceQualityCode: e.code,
      qualityLevel: e.level,
      mapVersion: nextVersion,
    }))
  }

  async listByDevice(deviceSerial: string): Promise<OtQualityCodeMapEntryRecord[]> {
    const r = await this.client.query(
      `SELECT device_serial, device_quality_code, quality_level, map_version
       FROM ot_quality_code_map WHERE device_serial = $1 ORDER BY device_quality_code`,
      [deviceSerial],
    )
    return r.rows.map(
      (row) =>
        ({
          deviceSerial: row.device_serial,
          deviceQualityCode: row.device_quality_code,
          qualityLevel: row.quality_level,
          mapVersion: row.map_version,
        }) satisfies OtQualityCodeMapEntryRecord,
    )
  }
}

// ---------------- ot_conversion ----------------

export class PgOtConversionRepository implements OtConversionRepository {
  constructor(private readonly client: SqlClient) {}

  async upsert(conversion: NewOtConversion): Promise<OtConversionRecord> {
    const r = await this.client.query(
      `INSERT INTO ot_conversion (enterprise_id, plant_id, from_uom_code, to_uom_code, factor, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (plant_id, from_uom_code, to_uom_code) DO UPDATE SET
         factor = EXCLUDED.factor,
         revision = ot_conversion.revision + 1,
         updated_at = now(), updated_by = EXCLUDED.created_by
       RETURNING from_uom_code, to_uom_code, factor, revision, plant_id`,
      [
        conversion.enterpriseId,
        conversion.plantId,
        conversion.fromUomCode,
        conversion.toUomCode,
        conversion.factor,
        conversion.createdBy ?? null,
      ],
    )
    const row = r.rows[0] as { from_uom_code: string; to_uom_code: string; factor: string; revision: number; plant_id: string }
    return {
      fromUomCode: row.from_uom_code,
      toUomCode: row.to_uom_code,
      factor: Number(row.factor),
      revision: row.revision,
      plantId: row.plant_id,
    }
  }

  async find(plantId: string, fromUomCode: string, toUomCode: string): Promise<OtConversionRecord | null> {
    const r = await this.client.query(
      `SELECT from_uom_code, to_uom_code, factor, revision, plant_id
       FROM ot_conversion WHERE plant_id = $1 AND from_uom_code = $2 AND to_uom_code = $3`,
      [plantId, fromUomCode, toUomCode],
    )
    if (r.rowCount === 0) return null
    const row = r.rows[0] as { from_uom_code: string; to_uom_code: string; factor: string; revision: number; plant_id: string }
    return {
      fromUomCode: row.from_uom_code,
      toUomCode: row.to_uom_code,
      factor: Number(row.factor),
      revision: row.revision,
      plantId: row.plant_id,
    }
  }
}

// ---------------- ot_sample ----------------

const SAMPLE_COLUMNS = `id, device_serial, point_code, event_id, gateway_seq, event_time, received_at,
  gateway_code, raw_value, raw_unit, normalized_value, conversion_revision, conversion_missing,
  quality_level, device_quality_code, is_bad, bad_reasons, is_clock_skew, clock_skew_kind, is_late,
  calibration_suspect, session_id, session_link_status, is_quarantined, quarantine_reason,
  plant_id, enterprise_id, created_at, created_by`

interface SampleRow {
  id: string
  device_serial: string
  point_code: string
  event_id: string
  gateway_seq: string | number
  event_time: Date | string
  received_at: Date | string
  gateway_code: string
  raw_value: string
  raw_unit: string
  normalized_value: string | null
  conversion_revision: number | null
  conversion_missing: boolean
  quality_level: QualityLevelValue
  device_quality_code: string | null
  is_bad: boolean
  bad_reasons: string[] | null
  is_clock_skew: boolean
  clock_skew_kind: 'offset' | 'backward' | 'ahead' | null
  is_late: boolean
  calibration_suspect: boolean
  session_id: string | null
  session_link_status: 'auto_bound' | 'pending_confirm' | 'unlinked' | 'manual_bound'
  is_quarantined: boolean
  quarantine_reason: string | null
  plant_id: string
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
}

function mapSample(r: SampleRow): OtSampleRecord {
  return {
    id: r.id,
    deviceSerial: r.device_serial,
    pointCode: r.point_code,
    eventId: r.event_id,
    gatewaySeq: Number(r.gateway_seq),
    eventTime: iso(r.event_time),
    receivedAt: iso(r.received_at),
    gatewayCode: r.gateway_code,
    rawValue: String(r.raw_value),
    rawUnit: r.raw_unit,
    normalizedValue: r.normalized_value === null ? null : String(r.normalized_value),
    conversionRevision: r.conversion_revision,
    conversionMissing: r.conversion_missing,
    qualityLevel: r.quality_level,
    deviceQualityCode: r.device_quality_code,
    isBad: r.is_bad,
    badReasons: r.bad_reasons ?? [],
    isClockSkew: r.is_clock_skew,
    clockSkewKind: r.clock_skew_kind,
    isLate: r.is_late,
    calibrationSuspect: r.calibration_suspect,
    sessionId: r.session_id,
    sessionLinkStatus: r.session_link_status,
    isQuarantined: r.is_quarantined,
    quarantineReason: r.quarantine_reason,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgOtSampleRepository implements OtSampleRepository {
  constructor(private readonly client: SqlClient) {}

  async insertOnConflictSkip(sample: NewOtSample): Promise<OtSampleRecord | null> {
    const r = await this.client.query(
      `INSERT INTO ot_sample (device_serial, point_code, event_id, gateway_seq, event_time,
         received_at, gateway_code, raw_value, raw_unit, normalized_value, conversion_revision,
         conversion_missing, quality_level, device_quality_code, is_bad, bad_reasons, is_clock_skew,
         clock_skew_kind, is_late, calibration_suspect, session_id, session_link_status,
         is_quarantined, quarantine_reason, command_receipt_id, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT (device_serial, event_id) DO NOTHING
       RETURNING ${SAMPLE_COLUMNS}`,
      [
        sample.deviceSerial,
        sample.pointCode,
        sample.eventId,
        sample.gatewaySeq,
        sample.eventTime,
        sample.receivedAt,
        sample.gatewayCode,
        sample.rawValue,
        sample.rawUnit,
        sample.normalizedValue,
        sample.conversionRevision,
        sample.conversionMissing,
        sample.qualityLevel,
        sample.deviceQualityCode,
        sample.isBad,
        sample.badReasons,
        sample.isClockSkew,
        sample.clockSkewKind,
        sample.isLate,
        sample.calibrationSuspect,
        sample.sessionId,
        sample.sessionLinkStatus,
        sample.isQuarantined,
        sample.quarantineReason,
        sample.commandReceiptId ?? null,
        sample.plantId,
        sample.enterpriseId,
        sample.createdBy ?? null,
      ],
    )
    if (r.rowCount === 0) return null
    return mapSample(r.rows[0] as SampleRow)
  }

  async findById(id: string): Promise<OtSampleRecord | null> {
    const r = await this.client.query(`SELECT ${SAMPLE_COLUMNS} FROM ot_sample WHERE id = $1`, [id])
    return r.rowCount === 0 ? null : mapSample(r.rows[0] as SampleRow)
  }

  async findLatestByDevice(deviceSerial: string): Promise<{ gatewaySeq: number; eventTime: string } | null> {
    const r = await this.client.query(
      `SELECT gateway_seq, event_time FROM ot_sample WHERE device_serial = $1
       ORDER BY gateway_seq DESC LIMIT 1`,
      [deviceSerial],
    )
    if (r.rowCount === 0) return null
    return { gatewaySeq: Number(r.rows[0]!.gateway_seq), eventTime: iso(r.rows[0]!.event_time) }
  }

  async findMaxEventTimeByDevice(deviceSerial: string): Promise<string | null> {
    const r = await this.client.query(
      `SELECT max(event_time) AS m FROM ot_sample WHERE device_serial = $1`,
      [deviceSerial],
    )
    return r.rows[0]!.m === null ? null : iso(r.rows[0]!.m)
  }

  async listQuarantinedByDevice(deviceSerial: string): Promise<OtSampleRecord[]> {
    const r = await this.client.query(
      `SELECT ${SAMPLE_COLUMNS} FROM ot_sample WHERE device_serial = $1 AND is_quarantined
       ORDER BY gateway_seq`,
      [deviceSerial],
    )
    return r.rows.map((row) => mapSample(row as SampleRow))
  }

  async listByDeviceWindow(deviceSerial: string, from: string, to: string): Promise<OtSampleRecord[]> {
    const r = await this.client.query(
      `SELECT ${SAMPLE_COLUMNS} FROM ot_sample
       WHERE device_serial = $1 AND event_time >= $2 AND event_time <= $3
       ORDER BY event_time, gateway_seq`,
      [deviceSerial, from, to],
    )
    return r.rows.map((row) => mapSample(row as SampleRow))
  }

  async listPaged(filter: OtSampleListFilter): Promise<{ items: OtSampleRecord[]; total: number }> {
    const where: string[] = ['device_serial = $1']
    const params: unknown[] = [filter.deviceSerial]
    if (filter.plantIds !== null && filter.plantIds.length > 0) {
      params.push(filter.plantIds)
      where.push(`plant_id = ANY($${params.length}::uuid[])`)
    }
    if (filter.pointCode !== undefined) {
      params.push(filter.pointCode)
      where.push(`point_code = $${params.length}`)
    }
    if (filter.qualityLevel !== undefined) {
      params.push(filter.qualityLevel)
      where.push(`quality_level = $${params.length}`)
    }
    if (filter.isBad !== undefined) {
      params.push(filter.isBad)
      where.push(`is_bad = $${params.length}`)
    }
    if (filter.isClockSkew !== undefined) {
      params.push(filter.isClockSkew)
      where.push(`is_clock_skew = $${params.length}`)
    }
    if (filter.isLate !== undefined) {
      params.push(filter.isLate)
      where.push(`is_late = $${params.length}`)
    }
    if (filter.isQuarantined !== undefined) {
      params.push(filter.isQuarantined)
      where.push(`is_quarantined = $${params.length}`)
    }
    if (filter.from !== undefined) {
      params.push(filter.from)
      where.push(`event_time >= $${params.length}`)
    }
    if (filter.to !== undefined) {
      params.push(filter.to)
      where.push(`event_time <= $${params.length}`)
    }
    const clause = `WHERE ${where.join(' AND ')}`
    const total = await this.client.query(`SELECT count(*)::int AS c FROM ot_sample ${clause}`, params)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${SAMPLE_COLUMNS} FROM ot_sample ${clause}
       ORDER BY event_time DESC, gateway_seq DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapSample(row as SampleRow)), total: total.rows[0]!.c }
  }

  async listDevicesWithSamples(filter: { plantId?: string; from: string; to: string }): Promise<string[]> {
    const params: unknown[] = [filter.from, filter.to]
    let clause = ''
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      clause = ` AND plant_id = $${params.length}::uuid`
    }
    const r = await this.client.query(
      `SELECT DISTINCT device_serial FROM ot_sample
       WHERE event_time >= $1 AND event_time <= $2${clause} ORDER BY device_serial`,
      params,
    )
    return r.rows.map((row) => row.device_serial as string)
  }

  async updateSessionLink(
    id: string,
    patch: { sessionId: string | null; sessionLinkStatus: OtSampleRecord['sessionLinkStatus'] },
    actor: string | null,
  ): Promise<OtSampleRecord | null> {
    const r = await this.client.query(
      `UPDATE ot_sample SET session_id = $2, session_link_status = $3, created_by = created_by
       WHERE id = $1 RETURNING ${SAMPLE_COLUMNS}`,
      [id, patch.sessionId, patch.sessionLinkStatus],
    )
    void actor
    return r.rowCount === 0 ? null : mapSample(r.rows[0] as SampleRow)
  }

  async applyReprocess(id: string, patch: OtSampleReprocessPatch, actor: string | null): Promise<OtSampleRecord | null> {
    const r = await this.client.query(
      `UPDATE ot_sample SET
         normalized_value = $2, conversion_revision = $3, conversion_missing = $4,
         quality_level = $5, is_bad = $6, bad_reasons = $7, is_clock_skew = $8, clock_skew_kind = $9,
         is_late = $10, calibration_suspect = $11, session_id = $12, session_link_status = $13,
         is_quarantined = $14, quarantine_reason = $15
       WHERE id = $1 RETURNING ${SAMPLE_COLUMNS}`,
      [
        id,
        patch.normalizedValue,
        patch.conversionRevision,
        patch.conversionMissing,
        patch.qualityLevel,
        patch.isBad,
        patch.badReasons,
        patch.isClockSkew,
        patch.clockSkewKind,
        patch.isLate,
        patch.calibrationSuspect,
        patch.sessionId,
        patch.sessionLinkStatus,
        patch.isQuarantined,
        patch.quarantineReason,
      ],
    )
    void actor
    return r.rowCount === 0 ? null : mapSample(r.rows[0] as SampleRow)
  }
}

// ---------------- ot_aggregate ----------------

const AGGREGATE_COLUMNS = `id, device_serial, point_code, granularity, window_start, sample_count,
  good_count, bad_count, skew_count, sum_value, min_value, max_value, first_event_time,
  last_event_time, updated_at`

interface AggregateRow {
  id: string
  device_serial: string
  point_code: string
  granularity: 'minute' | 'shift'
  window_start: Date | string
  sample_count: number
  good_count: number
  bad_count: number
  skew_count: number
  sum_value: string
  min_value: string | null
  max_value: string | null
  first_event_time: Date | string
  last_event_time: Date | string
  updated_at: Date | string
}

function mapAggregate(r: AggregateRow): OtAggregateRecord {
  return {
    id: r.id,
    deviceSerial: r.device_serial,
    pointCode: r.point_code,
    granularity: r.granularity,
    windowStart: iso(r.window_start),
    sampleCount: r.sample_count,
    goodCount: r.good_count,
    badCount: r.bad_count,
    skewCount: r.skew_count,
    sumValue: String(r.sum_value),
    minValue: r.min_value === null ? null : String(r.min_value),
    maxValue: r.max_value === null ? null : String(r.max_value),
    firstEventTime: iso(r.first_event_time),
    lastEventTime: iso(r.last_event_time),
    updatedAt: iso(r.updated_at),
  }
}

export class PgOtAggregateRepository implements OtAggregateRepository {
  constructor(private readonly client: SqlClient) {}

  async findByWindow(
    deviceSerial: string,
    pointCode: string,
    granularity: 'minute' | 'shift',
    windowStart: string,
  ): Promise<OtAggregateRecord | null> {
    const r = await this.client.query(
      `SELECT ${AGGREGATE_COLUMNS} FROM ot_aggregate
       WHERE device_serial = $1 AND point_code = $2 AND granularity = $3 AND window_start = $4`,
      [deviceSerial, pointCode, granularity, windowStart],
    )
    return r.rowCount === 0 ? null : mapAggregate(r.rows[0] as AggregateRow)
  }

  async upsert(aggregate: OtAggregateUpsert): Promise<OtAggregateRecord> {
    const r = await this.client.query(
      `INSERT INTO ot_aggregate (device_serial, point_code, granularity, window_start, sample_count,
         good_count, bad_count, skew_count, sum_value, min_value, max_value, first_event_time,
         last_event_time, enterprise_id, plant_id, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (device_serial, point_code, granularity, window_start) DO UPDATE SET
         sample_count = EXCLUDED.sample_count,
         good_count = EXCLUDED.good_count,
         bad_count = EXCLUDED.bad_count,
         skew_count = EXCLUDED.skew_count,
         sum_value = EXCLUDED.sum_value,
         min_value = EXCLUDED.min_value,
         max_value = EXCLUDED.max_value,
         first_event_time = EXCLUDED.first_event_time,
         last_event_time = EXCLUDED.last_event_time,
         updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING ${AGGREGATE_COLUMNS}`,
      [
        aggregate.deviceSerial,
        aggregate.pointCode,
        aggregate.granularity,
        aggregate.windowStart,
        aggregate.sampleCount,
        aggregate.goodCount,
        aggregate.badCount,
        aggregate.skewCount,
        aggregate.sumValue,
        aggregate.minValue,
        aggregate.maxValue,
        aggregate.firstEventTime,
        aggregate.lastEventTime,
        aggregate.enterpriseId,
        aggregate.plantId,
        aggregate.updatedBy ?? null,
      ],
    )
    return mapAggregate(r.rows[0] as AggregateRow)
  }

  async deleteRange(filter: {
    plantId?: string
    deviceSerial?: string
    granularity: 'minute' | 'shift'
    from: string
    to: string
  }): Promise<number> {
    const where: string[] = ['granularity = $1', 'window_start >= $2', 'window_start <= $3']
    const params: unknown[] = [filter.granularity, filter.from, filter.to]
    if (filter.deviceSerial !== undefined) {
      params.push(filter.deviceSerial)
      where.push(`device_serial = $${params.length}`)
    }
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where.push(`plant_id = $${params.length}::uuid`)
    }
    const r = await this.client.query(
      `DELETE FROM ot_aggregate WHERE ${where.join(' AND ')}`,
      params,
    )
    return r.rowCount ?? 0
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    deviceSerial?: string
    pointCode?: string
    granularity?: string
    from?: string
    to?: string
    page: number
    pageSize: number
  }): Promise<{ items: OtAggregateRecord[]; total: number }> {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null && filter.plantIds.length > 0) {
      params.push(filter.plantIds)
      where.push(`plant_id = ANY($${params.length}::uuid[])`)
    }
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where.push(`plant_id = $${params.length}::uuid`)
    }
    if (filter.deviceSerial !== undefined) {
      params.push(filter.deviceSerial)
      where.push(`device_serial = $${params.length}`)
    }
    if (filter.pointCode !== undefined) {
      params.push(filter.pointCode)
      where.push(`point_code = $${params.length}`)
    }
    if (filter.granularity !== undefined) {
      params.push(filter.granularity)
      where.push(`granularity = $${params.length}`)
    }
    if (filter.from !== undefined) {
      params.push(filter.from)
      where.push(`window_start >= $${params.length}`)
    }
    if (filter.to !== undefined) {
      params.push(filter.to)
      where.push(`window_start <= $${params.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS c FROM ot_aggregate ${clause}`, params)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${AGGREGATE_COLUMNS} FROM ot_aggregate ${clause}
       ORDER BY window_start DESC, device_serial, point_code
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapAggregate(row as AggregateRow)), total: total.rows[0]!.c }
  }
}

// ---------------- ot_stats ----------------

export class PgOtStatsRepository implements OtStatsRepository {
  constructor(private readonly client: SqlClient) {}

  async bumpDedup(stat: { statDate: string; gatewayCode: string; deviceSerial: string; delta: number; plantId: string; enterpriseId: string }): Promise<void> {
    await this.client.query(
      `INSERT INTO ot_stats (stat_date, gateway_code, device_serial, dedup_count, enterprise_id, plant_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (stat_date, gateway_code, device_serial) DO UPDATE SET
         dedup_count = ot_stats.dedup_count + EXCLUDED.dedup_count,
         updated_at = now()`,
      [stat.statDate, stat.gatewayCode, stat.deviceSerial, stat.delta, stat.enterpriseId, stat.plantId],
    )
  }

  async upsertOverflow(stat: NewOtOverflowStat): Promise<void> {
    await this.client.query(
      `INSERT INTO ot_stats (stat_date, gateway_code, device_serial, overflow_count,
         overflow_first_at, overflow_last_at, enterprise_id, plant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (stat_date, gateway_code, device_serial) DO UPDATE SET
         overflow_count = ot_stats.overflow_count + EXCLUDED.overflow_count,
         overflow_first_at = LEAST(ot_stats.overflow_first_at, EXCLUDED.overflow_first_at),
         overflow_last_at = GREATEST(ot_stats.overflow_last_at, EXCLUDED.overflow_last_at),
         updated_at = now()`,
      [
        stat.statDate,
        stat.gatewayCode,
        stat.deviceSerial,
        stat.count,
        stat.firstAt,
        stat.lastAt,
        stat.enterpriseId,
        stat.plantId,
      ],
    )
  }

  async listPaged(filter: {
    plantIds: string[] | null
    statDate?: string
    gatewayCode?: string
    page: number
    pageSize: number
  }): Promise<{ items: OtStatsRecord[]; total: number }> {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null && filter.plantIds.length > 0) {
      params.push(filter.plantIds)
      where.push(`plant_id = ANY($${params.length}::uuid[])`)
    }
    if (filter.statDate !== undefined) {
      params.push(filter.statDate)
      where.push(`stat_date = $${params.length}::date`)
    }
    if (filter.gatewayCode !== undefined) {
      params.push(filter.gatewayCode)
      where.push(`gateway_code = $${params.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS c FROM ot_stats ${clause}`, params)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT stat_date, gateway_code, device_serial, dedup_count, overflow_count,
         overflow_first_at, overflow_last_at, plant_id
       FROM ot_stats ${clause} ORDER BY stat_date DESC, gateway_code, device_serial
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return {
      items: r.rows.map(
        (row) =>
          ({
            statDate: row.stat_date instanceof Date ? row.stat_date.toISOString().slice(0, 10) : String(row.stat_date),
            gatewayCode: row.gateway_code,
            deviceSerial: row.device_serial,
            dedupCount: row.dedup_count,
            overflowCount: row.overflow_count,
            overflowFirstAt: isoOrNull(row.overflow_first_at),
            overflowLastAt: isoOrNull(row.overflow_last_at),
            plantId: row.plant_id,
          }) satisfies OtStatsRecord,
      ),
      total: total.rows[0]!.c,
    }
  }

  async listByDeviceSerials(
    deviceSerials: string[],
    filter: { dedupAbove?: number },
  ): Promise<OtStatsRecord[]> {
    if (deviceSerials.length === 0) return []
    const params: unknown[] = [deviceSerials]
    let clause = `WHERE device_serial = ANY($1)`
    if (filter.dedupAbove !== undefined) {
      params.push(filter.dedupAbove)
      clause += ` AND dedup_count > $${params.length}`
    }
    const r = await this.client.query(
      `SELECT stat_date, gateway_code, device_serial, dedup_count, overflow_count,
         overflow_first_at, overflow_last_at, plant_id
       FROM ot_stats ${clause} ORDER BY stat_date DESC`,
      params,
    )
    return r.rows.map(
      (row) =>
        ({
          statDate: row.stat_date instanceof Date ? row.stat_date.toISOString().slice(0, 10) : String(row.stat_date),
          gatewayCode: row.gateway_code,
          deviceSerial: row.device_serial,
          dedupCount: row.dedup_count,
          overflowCount: row.overflow_count,
          overflowFirstAt: isoOrNull(row.overflow_first_at),
          overflowLastAt: isoOrNull(row.overflow_last_at),
          plantId: row.plant_id,
        }) satisfies OtStatsRecord,
    )
  }
}

// ---------------- ot_business_mapping / ot_business_fact ----------------

const MAPPING_COLUMNS = `id, device_serial, point_code, fact_kind, confirm_mode, params, version,
  plant_id, enterprise_id, updated_at`

interface MappingRow {
  id: string
  device_serial: string
  point_code: string
  fact_kind: 'meter_to_quantity' | 'stop_to_downtime'
  confirm_mode: 'auto' | 'manual'
  params: Record<string, unknown> | null
  version: number
  plant_id: string
  enterprise_id: string
  updated_at: Date | string
}

function mapMapping(r: MappingRow): OtMappingRecord {
  return {
    id: r.id,
    deviceSerial: r.device_serial,
    pointCode: r.point_code,
    factKind: r.fact_kind,
    confirmMode: r.confirm_mode,
    params: r.params ?? {},
    version: r.version,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    updatedAt: iso(r.updated_at),
  }
}

export class PgOtMappingRepository implements OtMappingRepository {
  constructor(private readonly client: SqlClient) {}

  async upsert(mapping: NewOtMapping): Promise<OtMappingRecord> {
    const r = await this.client.query(
      `INSERT INTO ot_business_mapping (enterprise_id, plant_id, device_serial, point_code,
         fact_kind, confirm_mode, params, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (plant_id, device_serial, point_code) WHERE status = 'active' DO UPDATE SET
         fact_kind = EXCLUDED.fact_kind,
         confirm_mode = EXCLUDED.confirm_mode,
         params = EXCLUDED.params,
         version = ot_business_mapping.version + 1,
         updated_at = now(), updated_by = EXCLUDED.created_by
       RETURNING ${MAPPING_COLUMNS}`,
      [
        mapping.enterpriseId,
        mapping.plantId,
        mapping.deviceSerial,
        mapping.pointCode,
        mapping.factKind,
        mapping.confirmMode,
        JSON.stringify(mapping.params ?? {}),
        mapping.createdBy ?? null,
      ],
    )
    return mapMapping(r.rows[0] as MappingRow)
  }

  async findById(id: string): Promise<OtMappingRecord | null> {
    const r = await this.client.query(
      `SELECT ${MAPPING_COLUMNS} FROM ot_business_mapping WHERE id = $1 AND status = 'active'`,
      [id],
    )
    return r.rowCount === 0 ? null : mapMapping(r.rows[0] as MappingRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    deviceSerial?: string
    page: number
    pageSize: number
  }): Promise<{ items: OtMappingRecord[]; total: number }> {
    const where: string[] = [`status = 'active'`]
    const params: unknown[] = []
    if (filter.plantIds !== null && filter.plantIds.length > 0) {
      params.push(filter.plantIds)
      where.push(`plant_id = ANY($${params.length}::uuid[])`)
    }
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where.push(`plant_id = $${params.length}::uuid`)
    }
    if (filter.deviceSerial !== undefined) {
      params.push(filter.deviceSerial)
      where.push(`device_serial = $${params.length}`)
    }
    const clause = `WHERE ${where.join(' AND ')}`
    const total = await this.client.query(`SELECT count(*)::int AS c FROM ot_business_mapping ${clause}`, params)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${MAPPING_COLUMNS} FROM ot_business_mapping ${clause}
       ORDER BY device_serial, point_code LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapMapping(row as MappingRow)), total: total.rows[0]!.c }
  }
}

const FACT_COLUMNS = `id, mapping_id, mapping_version, fact_kind, device_serial, point_code,
  window_start, window_end, value, payload, status, confirmed_by, confirmed_at, outbox_event_id,
  plant_id, enterprise_id, created_at`

interface FactRow {
  id: string
  mapping_id: string
  mapping_version: number
  fact_kind: 'meter_to_quantity' | 'stop_to_downtime'
  device_serial: string
  point_code: string
  window_start: Date | string
  window_end: Date | string
  value: string | null
  payload: Record<string, unknown> | null
  status: 'pending_confirm' | 'dispatched'
  confirmed_by: string | null
  confirmed_at: Date | string | null
  outbox_event_id: string | null
  plant_id: string
  enterprise_id: string
  created_at: Date | string
}

function mapFact(r: FactRow): OtBusinessFactRecord {
  return {
    id: r.id,
    mappingId: r.mapping_id,
    mappingVersion: r.mapping_version,
    factKind: r.fact_kind,
    deviceSerial: r.device_serial,
    pointCode: r.point_code,
    windowStart: iso(r.window_start),
    windowEnd: iso(r.window_end),
    value: r.value,
    payload: r.payload ?? {},
    status: r.status,
    confirmedBy: r.confirmed_by,
    confirmedAt: isoOrNull(r.confirmed_at),
    outboxEventId: r.outbox_event_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
  }
}

export class PgOtBusinessFactRepository implements OtBusinessFactRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(fact: {
    mappingId: string
    mappingVersion: number
    factKind: 'meter_to_quantity' | 'stop_to_downtime'
    deviceSerial: string
    pointCode: string
    windowStart: string
    windowEnd: string
    value: string | null
    payload: Record<string, unknown>
    status: 'pending_confirm' | 'dispatched'
    plantId: string
    enterpriseId: string
    createdBy?: string | null
    commandReceiptId?: string | null
  }): Promise<OtBusinessFactRecord> {
    const r = await this.client.query(
      `INSERT INTO ot_business_fact (mapping_id, mapping_version, fact_kind, device_serial, point_code,
         window_start, window_end, value, payload, status, command_receipt_id, enterprise_id,
         plant_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
       RETURNING ${FACT_COLUMNS}`,
      [
        fact.mappingId,
        fact.mappingVersion,
        fact.factKind,
        fact.deviceSerial,
        fact.pointCode,
        fact.windowStart,
        fact.windowEnd,
        fact.value,
        JSON.stringify(fact.payload),
        fact.status,
        fact.commandReceiptId ?? null,
        fact.enterpriseId,
        fact.plantId,
        fact.createdBy ?? null,
      ],
    )
    return mapFact(r.rows[0] as FactRow)
  }

  async findByKey(mappingId: string, windowStart: string, windowEnd: string): Promise<OtBusinessFactRecord | null> {
    const r = await this.client.query(
      `SELECT ${FACT_COLUMNS} FROM ot_business_fact
       WHERE mapping_id = $1 AND window_start = $2 AND window_end = $3`,
      [mappingId, windowStart, windowEnd],
    )
    return r.rowCount === 0 ? null : mapFact(r.rows[0] as FactRow)
  }

  async findById(id: string): Promise<OtBusinessFactRecord | null> {
    const r = await this.client.query(`SELECT ${FACT_COLUMNS} FROM ot_business_fact WHERE id = $1`, [id])
    return r.rowCount === 0 ? null : mapFact(r.rows[0] as FactRow)
  }

  async markDispatched(
    id: string,
    patch: { outboxEventId: string; confirmedBy?: string | null; confirmedAt?: string | null },
    actor: string | null,
  ): Promise<OtBusinessFactRecord | null> {
    const r = await this.client.query(
      `UPDATE ot_business_fact SET status = 'dispatched', outbox_event_id = $2,
         confirmed_by = COALESCE($3, confirmed_by), confirmed_at = COALESCE($4, confirmed_at),
         updated_at = now(), updated_by = $5
       WHERE id = $1 RETURNING ${FACT_COLUMNS}`,
      [id, patch.outboxEventId, patch.confirmedBy ?? null, patch.confirmedAt ?? null, actor],
    )
    return r.rowCount === 0 ? null : mapFact(r.rows[0] as FactRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    mappingId?: string
    status?: string
    page: number
    pageSize: number
  }): Promise<{ items: OtBusinessFactRecord[]; total: number }> {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.plantIds !== null && filter.plantIds.length > 0) {
      params.push(filter.plantIds)
      where.push(`plant_id = ANY($${params.length}::uuid[])`)
    }
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where.push(`plant_id = $${params.length}::uuid`)
    }
    if (filter.mappingId !== undefined) {
      params.push(filter.mappingId)
      where.push(`mapping_id = $${params.length}::uuid`)
    }
    if (filter.status !== undefined) {
      params.push(filter.status)
      where.push(`status = $${params.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS c FROM ot_business_fact ${clause}`, params)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${FACT_COLUMNS} FROM ot_business_fact ${clause}
       ORDER BY created_at DESC, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapFact(row as FactRow)), total: total.rows[0]!.c }
  }
}

// ---------------- 跨域只读投影（OT-13 工序会话 / OT-07/21 设备主档） ----------------

/** OT-13：execution_session 等价只读投影（设备编码 + 时间窗匹配；不改 execution 域文件）。 */
export class PgOtSessionLookup implements OtSessionLookup {
  constructor(private readonly client: SqlClient) {}

  async findSessionWindows(
    equipmentCode: string,
    window: { from: string; to: string },
  ): Promise<Array<{ sessionId: string; equipmentCode: string; startAt: string; endAt: string | null }>> {
    const r = await this.client.query(
      `SELECT id, equipment_code, business_time,
         CASE WHEN status = 'open' THEN NULL ELSE updated_at END AS end_at
       FROM execution_session
       WHERE equipment_code = $1
         AND business_time <= $2
         AND (status = 'open' OR updated_at >= $3)`,
      [equipmentCode, window.to, window.from],
    )
    return r.rows.map(
      (row) => ({
        sessionId: row.id,
        equipmentCode: row.equipment_code,
        startAt: iso(row.business_time),
        endAt: row.end_at === null ? null : iso(row.end_at),
      }),
    )
  }

  async findSessionById(sessionId: string): Promise<{ sessionId: string; equipmentCode: string | null } | null> {
    const r = await this.client.query(
      `SELECT id, equipment_code FROM execution_session WHERE id = $1::uuid`,
      [sessionId],
    )
    if (r.rowCount === 0) return null
    return { sessionId: r.rows[0]!.id, equipmentCode: r.rows[0]!.equipment_code ?? null }
  }
}

/** OT-07/OT-21：equipment 主档等价只读投影（MD-09 编码全局唯一 + MD-13 状态字典）。 */
export class PgOtEquipmentLookup implements OtEquipmentLookup {
  constructor(private readonly client: SqlClient) {}

  async findEquipmentById(equipmentId: string): Promise<{ id: string; code: string; equipmentStatus: 1 | 2 } | null> {
    const r = await this.client.query(
      `SELECT id, code, equipment_status FROM equipment WHERE id = $1::uuid AND status = 'active'`,
      [equipmentId],
    )
    if (r.rowCount === 0) return null
    return { id: r.rows[0]!.id, code: r.rows[0]!.code, equipmentStatus: r.rows[0]!.equipment_status }
  }

  async findEquipmentByCode(code: string): Promise<{ id: string; code: string; equipmentStatus: 1 | 2 } | null> {
    const r = await this.client.query(
      `SELECT id, code, equipment_status FROM equipment WHERE code = $1 AND status = 'active'`,
      [code],
    )
    if (r.rowCount === 0) return null
    return { id: r.rows[0]!.id, code: r.rows[0]!.code, equipmentStatus: r.rows[0]!.equipment_status }
  }
}

// ---------------- Outbox / 隔离队列窄端口（0001 表） ----------------

/** OT-26：出站任务写入（同事务；返回 event_id 供事实行关联）。 */
export class PgOtOutboxWriter implements OtOutboxWriter {
  constructor(private readonly client: SqlClient) {}

  async insert(intent: OutboxIntent): Promise<string> {
    const r = await this.client.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload)
       VALUES ($1,$2,$3,'PENDING',$4::jsonb) RETURNING event_id`,
      [intent.aggregateType, intent.aggregateId, intent.taskKind, JSON.stringify(intent.payload)],
    )
    return r.rows[0]!.event_id
  }
}

/** OT-07/IF-00.8：隔离队列写入与补绑后回执（0001 inbox 表窄端口）。 */
export class PgOtQuarantineInboxStore implements OtQuarantineInboxStore {
  constructor(private readonly client: SqlClient) {}

  async insertQuarantinedInbox(input: {
    sourceSystem: string
    organizationCode: string
    externalKey: string
    entityType: string
    quarantineReason: string
    payload: Record<string, unknown>
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO inbox (source_system, organization_code, external_key, entity_type,
         status, quarantine_reason, payload)
       VALUES ($1,$2,$3,$4,'QUARANTINED',$5,$6::jsonb)
       ON CONFLICT (source_system, organization_code, external_key, entity_type) DO NOTHING`,
      [
        input.sourceSystem,
        input.organizationCode,
        input.externalKey,
        input.entityType,
        input.quarantineReason,
        JSON.stringify(input.payload),
      ],
    )
  }

  async markProcessed(externalKey: string, sourceSystem: string, entityType: string): Promise<void> {
    await this.client.query(
      `UPDATE inbox SET status = 'PROCESSED', processed_at = now(), updated_at = now()
       WHERE external_key = $1 AND source_system = $2 AND entity_type = $3 AND status = 'QUARANTINED'`,
      [externalKey, sourceSystem, entityType],
    )
  }
}

// ---------------- 装配 ----------------

export function createPgOtRepositories(client: SqlClient): OtRepositories {
  return {
    gateways: new PgOtGatewayRepository(client),
    gatewayEvents: new PgOtGatewayEventRepository(client),
    devices: new PgOtDeviceRepository(client),
    points: new PgOtPointRepository(client),
    qualityMaps: new PgOtQualityCodeMapRepository(client),
    conversions: new PgOtConversionRepository(client),
    samples: new PgOtSampleRepository(client),
    aggregates: new PgOtAggregateRepository(client),
    stats: new PgOtStatsRepository(client),
    mappings: new PgOtMappingRepository(client),
    facts: new PgOtBusinessFactRepository(client),
  }
}

/** ot 命令工具集扩展（组合根用：OtCommandTools = org 基础 + ot 面 + outbox/inbox/投影）。 */
export function extendOtCommandTools(
  base: Omit<OtCommandTools, 'ot' | 'otOutbox' | 'otInbox' | 'otSessions' | 'otEquipment'>,
  client: SqlClient,
): OtCommandTools {
  return {
    ...base,
    ot: createPgOtRepositories(client),
    otOutbox: new PgOtOutboxWriter(client),
    otInbox: new PgOtQuarantineInboxStore(client),
    otSessions: new PgOtSessionLookup(client),
    otEquipment: new PgOtEquipmentLookup(client),
  }
}
