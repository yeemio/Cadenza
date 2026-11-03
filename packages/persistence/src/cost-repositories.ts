// [L0-整合标记] 跨包类型导入（type-only，编译期擦除）：application 包名入口（src/index.ts，
// 共享文件不改动）未导出 cost 面，暂走 dist 相对（构建顺序由 workspace 拓扑保证）；
// L0 整合步把端口并入各包 index 后改包名导入（同 maintenance-repositories 先例）。
import type {
  ConsumptionFact,
  CostAcquisitionLineRecord,
  CostAcquisitionLineRepository,
  CostAcquisitionRunRecord,
  CostAcquisitionRunRepository,
  CostAllocationVersionRecord,
  CostAllocationVersionRepository,
  CostFactReaders,
  CostLaborCheckRecord,
  CostLaborCheckRepository,
  CostMeterReadingRecord,
  CostMeterReadingRepository,
  CostMeterRecord,
  CostMeterRepository,
  CostPriceVersionRecord,
  CostPriceVersionRepository,
  CostReconItemRecord,
  CostReconItemRepository,
  CostRepositories,
  LaborFact,
  NewCostAcquisitionLine,
  NewCostAcquisitionRun,
  NewCostAllocationVersion,
  NewCostLaborCheck,
  NewCostMeter,
  NewCostMeterReading,
  NewCostPriceVersion,
  NewCostReconItem,
  OtSampleFact,
  OutputFact,
  SparePartFact,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

/**
 * cost 域仓储的 PostgreSQL 实现（implements application 端口；0020 cost 表列一一对应）。
 * 归集/读数/明细为 append-only（触发器守卫）；版本表被引用后 immutable（守卫）；
 * 对账/工时核对仅处置/确认列可 UPDATE（守卫）。事实读取端口（CE-05 唯一来源映射）
 * 跨消费 0002/0003/0005/0008/0015/0016/0017 已落地表——全部只读（CE-02）。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

function num2(value: unknown): string {
  // numeric 列 pg 驱动返回字符串；工时等 numeric(8,2) 归一 4 位
  const n = typeof value === 'string' ? value : String(value ?? '0')
  const [i, f = ''] = n.split('.')
  return `${i}.${(f + '0000').slice(0, 4)}`
}

function num6(value: unknown): string {
  const n = typeof value === 'string' ? value : String(value ?? '0')
  const [i, f = ''] = n.split('.')
  return `${i}.${(f + '000000').slice(0, 6)}`
}

// ---------------- cost_meter ----------------

interface MeterRow {
  id: string
  meter_code: string
  meter_name: string | null
  energy_type: CostMeterRecord['energyType']
  coverage_kind: CostMeterRecord['coverageKind']
  equipment_id: string | null
  work_center_id: string | null
  sample_source: CostMeterRecord['sampleSource']
  ot_point_id: string | null
  uom_code: string
  status: 'active' | 'retired'
  remark: string | null
  enterprise_id: string
  plant_id: string
  business_time: Date | string
  command_receipt_id: string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapMeter(r: MeterRow): CostMeterRecord {
  return {
    id: r.id,
    meterCode: r.meter_code,
    meterName: r.meter_name,
    energyType: r.energy_type,
    coverageKind: r.coverage_kind,
    equipmentId: r.equipment_id,
    workCenterId: r.work_center_id,
    sampleSource: r.sample_source,
    otPointId: r.ot_point_id,
    uomCode: r.uom_code,
    status: r.status,
    remark: r.remark,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    businessTime: iso(r.business_time),
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

const METER_COLUMNS = `id, meter_code, meter_name, energy_type, coverage_kind, equipment_id, work_center_id,
  sample_source, ot_point_id, uom_code, status, remark, enterprise_id, plant_id, business_time,
  command_receipt_id, created_at, created_by, updated_at, updated_by`

class PgCostMeterRepository implements CostMeterRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(meter: NewCostMeter): Promise<CostMeterRecord> {
    const r = await this.client.query(
      `INSERT INTO cost_meter (meter_code, meter_name, energy_type, coverage_kind, equipment_id, work_center_id,
         sample_source, ot_point_id, uom_code, remark, enterprise_id, plant_id, business_time,
         command_receipt_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13, now()),$14,$15)
       RETURNING ${METER_COLUMNS}`,
      [
        meter.meterCode, meter.meterName ?? null, meter.energyType, meter.coverageKind,
        meter.equipmentId ?? null, meter.workCenterId ?? null, meter.sampleSource, meter.otPointId ?? null,
        meter.uomCode, meter.remark ?? null, meter.enterpriseId, meter.plantId,
        meter.businessTime ?? null, meter.commandReceiptId ?? null, meter.createdBy ?? null,
      ],
    )
    return mapMeter(r.rows[0]!)
  }

  async findById(id: string): Promise<CostMeterRecord | null> {
    const r = await this.client.query(`SELECT ${METER_COLUMNS} FROM cost_meter WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapMeter(r.rows[0])
  }

  async findActiveByPlantAndCode(plantId: string, meterCode: string): Promise<CostMeterRecord | null> {
    const r = await this.client.query(
      `SELECT ${METER_COLUMNS} FROM cost_meter WHERE plant_id = $1 AND meter_code = $2 AND status = 'active'`,
      [plantId, meterCode],
    )
    return r.rows[0] === undefined ? null : mapMeter(r.rows[0])
  }

  async findActiveByOtPoint(otPointId: string): Promise<CostMeterRecord | null> {
    const r = await this.client.query(
      `SELECT ${METER_COLUMNS} FROM cost_meter WHERE ot_point_id = $1 AND status = 'active'`,
      [otPointId],
    )
    return r.rows[0] === undefined ? null : mapMeter(r.rows[0])
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    energyTypes?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: CostMeterRecord[]; total: number }> {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.plantId !== undefined) {
      values.push(filter.plantId)
      where.push(`plant_id = $${values.length}`)
    } else if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { items: [], total: 0 }
      values.push(filter.plantIds)
      where.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      values.push(filter.statuses)
      where.push(`status = ANY($${values.length})`)
    }
    if (filter.energyTypes !== undefined && filter.energyTypes.length > 0) {
      values.push(filter.energyTypes)
      where.push(`energy_type = ANY($${values.length})`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*) AS count FROM cost_meter ${clause}`, values)
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${METER_COLUMNS} FROM cost_meter ${clause} ORDER BY created_at DESC, id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return { items: r.rows.map(mapMeter), total: Number(total.rows[0]!.count) }
  }

  async listActiveByPlant(plantId: string): Promise<CostMeterRecord[]> {
    const r = await this.client.query(
      `SELECT ${METER_COLUMNS} FROM cost_meter WHERE plant_id = $1 AND status = 'active' ORDER BY meter_code`,
      [plantId],
    )
    return r.rows.map(mapMeter)
  }
}

// ---------------- cost_meter_reading ----------------

interface ReadingRow {
  id: string
  meter_id: string
  reading_type: 'manual' | 'ot'
  reading: string
  read_at: Date | string
  read_by: string | null
  ot_sample_id: string | null
  captured_event_time: Date | string | null
  enterprise_id: string
  plant_id: string
  business_time: Date | string
  command_receipt_id: string | null
  created_at: Date | string
  created_by: string | null
}

function mapReading(r: ReadingRow): CostMeterReadingRecord {
  return {
    id: r.id,
    meterId: r.meter_id,
    readingType: r.reading_type,
    reading: num2(r.reading),
    readAt: iso(r.read_at),
    readBy: r.read_by,
    otSampleId: r.ot_sample_id,
    capturedEventTime: isoOrNull(r.captured_event_time),
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    businessTime: iso(r.business_time),
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

const READING_COLUMNS = `id, meter_id, reading_type, reading, read_at, read_by, ot_sample_id,
  captured_event_time, enterprise_id, plant_id, business_time, command_receipt_id, created_at, created_by`

class PgCostMeterReadingRepository implements CostMeterReadingRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(reading: NewCostMeterReading): Promise<CostMeterReadingRecord> {
    const r = await this.client.query(
      `INSERT INTO cost_meter_reading (meter_id, reading_type, reading, read_at, read_by, ot_sample_id,
         captured_event_time, enterprise_id, plant_id, business_time, command_receipt_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, now()),$11,$12)
       RETURNING ${READING_COLUMNS}`,
      [
        reading.meterId, reading.readingType, reading.reading, reading.readAt, reading.readBy ?? null,
        reading.otSampleId ?? null, reading.capturedEventTime ?? null, reading.enterpriseId, reading.plantId,
        reading.businessTime ?? null, reading.commandReceiptId ?? null, reading.createdBy ?? null,
      ],
    )
    return mapReading(r.rows[0]!)
  }

  async insertOtIfAbsent(reading: NewCostMeterReading): Promise<{ reading: CostMeterReadingRecord; inserted: boolean }> {
    // ON CONFLICT DO NOTHING（不可 DO UPDATE：读数表 append-only 守卫拒一切 UPDATE，
    // 幂等重放改以插入 0 行后补查已存在行承载）
    const r = await this.client.query(
      `INSERT INTO cost_meter_reading (meter_id, reading_type, reading, read_at, read_by, ot_sample_id,
         captured_event_time, enterprise_id, plant_id, business_time, command_receipt_id, created_by)
       VALUES ($1,'ot',$2,$3,NULL,$4,$5,$6,$7,COALESCE($8, now()),$9,$10)
       ON CONFLICT (meter_id, ot_sample_id) WHERE reading_type = 'ot' DO NOTHING
       RETURNING ${READING_COLUMNS}`,
      [
        reading.meterId, reading.reading, reading.readAt, reading.otSampleId ?? null,
        reading.capturedEventTime ?? null, reading.enterpriseId, reading.plantId,
        reading.businessTime ?? null, reading.commandReceiptId ?? null, reading.createdBy ?? null,
      ],
    )
    if (r.rows[0] !== undefined) return { reading: mapReading(r.rows[0] as ReadingRow), inserted: true }
    const existing = await this.client.query(
      `SELECT ${READING_COLUMNS} FROM cost_meter_reading
       WHERE meter_id = $1 AND ot_sample_id = $2 AND reading_type = 'ot'`,
      [reading.meterId, reading.otSampleId ?? null],
    )
    if (existing.rows[0] === undefined) throw new Error('cost_meter_reading 幂等补查失败：冲突行不存在')
    return { reading: mapReading(existing.rows[0] as ReadingRow), inserted: false }
  }

  async findById(id: string): Promise<CostMeterReadingRecord | null> {
    const r = await this.client.query(`SELECT ${READING_COLUMNS} FROM cost_meter_reading WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapReading(r.rows[0])
  }

  async listByMeterWindow(meterId: string, fromIso: string, toIso: string): Promise<CostMeterReadingRecord[]> {
    const r = await this.client.query(
      `SELECT ${READING_COLUMNS} FROM cost_meter_reading
       WHERE meter_id = $1 AND read_at >= $2 AND read_at <= $3 ORDER BY read_at`,
      [meterId, fromIso, toIso],
    )
    return r.rows.map(mapReading)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    meterId?: string
    page: number
    pageSize: number
  }): Promise<{ items: CostMeterReadingRecord[]; total: number }> {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.plantId !== undefined) {
      values.push(filter.plantId)
      where.push(`plant_id = $${values.length}`)
    } else if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { items: [], total: 0 }
      values.push(filter.plantIds)
      where.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.meterId !== undefined) {
      values.push(filter.meterId)
      where.push(`meter_id = $${values.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*) AS count FROM cost_meter_reading ${clause}`, values)
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${READING_COLUMNS} FROM cost_meter_reading ${clause} ORDER BY read_at DESC, id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return { items: r.rows.map(mapReading), total: Number(total.rows[0]!.count) }
  }
}

// ---------------- cost_allocation_version ----------------

interface AllocRow {
  id: string
  version_no: number
  formula: CostAllocationVersionRecord['formula']
  params: Record<string, unknown>
  overhead_caliber: string | null
  status: 'active' | 'retired'
  remark: string | null
  enterprise_id: string
  plant_id: string
  business_time: Date | string
  command_receipt_id: string | null
  created_at: Date | string
  created_by: string | null
}

function mapAlloc(r: AllocRow): CostAllocationVersionRecord {
  return {
    id: r.id,
    versionNo: r.version_no,
    formula: r.formula,
    params: r.params ?? {},
    overheadCaliber: r.overhead_caliber,
    status: r.status,
    remark: r.remark,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    businessTime: iso(r.business_time),
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

class PgCostAllocationVersionRepository implements CostAllocationVersionRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(version: NewCostAllocationVersion): Promise<CostAllocationVersionRecord> {
    const r = await this.client.query(
      `INSERT INTO cost_allocation_version (version_no, formula, params, overhead_caliber, status, remark,
         enterprise_id, plant_id, business_time, command_receipt_id, created_by)
       VALUES ($1,$2,$3::jsonb,$4,'active',$5,$6,$7,COALESCE($8, now()),$9,$10)
       RETURNING id, version_no, formula, params, overhead_caliber, status, remark, enterprise_id, plant_id,
         business_time, command_receipt_id, created_at, created_by`,
      [
        version.versionNo, version.formula, JSON.stringify(version.params ?? {}), version.overheadCaliber ?? null,
        version.remark ?? null, version.enterpriseId, version.plantId, version.businessTime ?? null,
        version.commandReceiptId ?? null, version.createdBy ?? null,
      ],
    )
    return mapAlloc(r.rows[0]!)
  }

  async findById(id: string): Promise<CostAllocationVersionRecord | null> {
    const r = await this.client.query(
      `SELECT id, version_no, formula, params, overhead_caliber, status, remark, enterprise_id, plant_id,
         business_time, command_receipt_id, created_at, created_by FROM cost_allocation_version WHERE id = $1`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapAlloc(r.rows[0])
  }

  async findByPlantAndVersionNo(plantId: string, versionNo: number): Promise<CostAllocationVersionRecord | null> {
    const r = await this.client.query(
      `SELECT id, version_no, formula, params, overhead_caliber, status, remark, enterprise_id, plant_id,
         business_time, command_receipt_id, created_at, created_by FROM cost_allocation_version
       WHERE plant_id = $1 AND version_no = $2`,
      [plantId, versionNo],
    )
    return r.rows[0] === undefined ? null : mapAlloc(r.rows[0])
  }

  async countRunsReferencing(id: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*) AS count FROM cost_acquisition_run WHERE allocation_version_id = $1`,
      [id],
    )
    return Number(r.rows[0]!.count)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: CostAllocationVersionRecord[]; total: number }> {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.plantId !== undefined) {
      values.push(filter.plantId)
      where.push(`plant_id = $${values.length}`)
    } else if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { items: [], total: 0 }
      values.push(filter.plantIds)
      where.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      values.push(filter.statuses)
      where.push(`status = ANY($${values.length})`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*) AS count FROM cost_allocation_version ${clause}`, values)
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT id, version_no, formula, params, overhead_caliber, status, remark, enterprise_id, plant_id,
         business_time, command_receipt_id, created_at, created_by
       FROM cost_allocation_version ${clause} ORDER BY version_no DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return { items: r.rows.map(mapAlloc), total: Number(total.rows[0]!.count) }
  }
}

// ---------------- cost_price_version / cost_price_item ----------------

interface PriceRow {
  id: string
  version_no: number
  price_source: CostPriceVersionRecord['priceSource']
  status: 'active' | 'retired'
  remark: string | null
  enterprise_id: string
  plant_id: string
  business_time: Date | string
  command_receipt_id: string | null
  created_at: Date | string
  created_by: string | null
}

class PgCostPriceVersionRepository implements CostPriceVersionRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(version: NewCostPriceVersion): Promise<CostPriceVersionRecord> {
    const r = await this.client.query(
      `INSERT INTO cost_price_version (version_no, price_source, status, remark, enterprise_id, plant_id,
         business_time, command_receipt_id, created_by)
       VALUES ($1,$2,'active',$3,$4,$5,COALESCE($6, now()),$7,$8)
       RETURNING id, version_no, price_source, status, remark, enterprise_id, plant_id, business_time,
         command_receipt_id, created_at, created_by`,
      [
        version.versionNo, version.priceSource, version.remark ?? null, version.enterpriseId, version.plantId,
        version.businessTime ?? null, version.commandReceiptId ?? null, version.createdBy ?? null,
      ],
    )
    const head = r.rows[0]!
    for (const item of version.items) {
      await this.client.query(
        `INSERT INTO cost_price_item (price_version_id, material_id, material_code, unit_price, uom_code, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [head.id, item.materialId ?? null, item.materialCode, item.unitPrice, item.uomCode, version.createdBy ?? null],
      )
    }
    return { ...mapPriceHead(head), items: version.items }
  }

  async findById(id: string): Promise<CostPriceVersionRecord | null> {
    const r = await this.client.query(
      `SELECT id, version_no, price_source, status, remark, enterprise_id, plant_id, business_time,
         command_receipt_id, created_at, created_by FROM cost_price_version WHERE id = $1`,
      [id],
    )
    if (r.rows[0] === undefined) return null
    const items = await this.findItems(id)
    return { ...mapPriceHead(r.rows[0]), items }
  }

  async findByPlantAndVersionNo(plantId: string, versionNo: number): Promise<CostPriceVersionRecord | null> {
    const r = await this.client.query(
      `SELECT id, version_no, price_source, status, remark, enterprise_id, plant_id, business_time,
         command_receipt_id, created_at, created_by FROM cost_price_version WHERE plant_id = $1 AND version_no = $2`,
      [plantId, versionNo],
    )
    if (r.rows[0] === undefined) return null
    const items = await this.findItems(r.rows[0]!.id)
    return { ...mapPriceHead(r.rows[0]), items }
  }

  async findItems(versionId: string): Promise<Array<{ materialCode: string; materialId: string | null; unitPrice: string; uomCode: string }>> {
    const r = await this.client.query(
      `SELECT material_code, material_id, unit_price, uom_code FROM cost_price_item WHERE price_version_id = $1 ORDER BY material_code`,
      [versionId],
    )
    return r.rows.map((row) => ({
      materialCode: row.material_code,
      materialId: row.material_id,
      unitPrice: num6(row.unit_price),
      uomCode: row.uom_code,
    }))
  }

  async countRunsReferencing(id: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*) AS count FROM cost_acquisition_run WHERE price_version_id = $1`,
      [id],
    )
    return Number(r.rows[0]!.count)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: Array<Omit<CostPriceVersionRecord, 'items'>>; total: number }> {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.plantId !== undefined) {
      values.push(filter.plantId)
      where.push(`plant_id = $${values.length}`)
    } else if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { items: [], total: 0 }
      values.push(filter.plantIds)
      where.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      values.push(filter.statuses)
      where.push(`status = ANY($${values.length})`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*) AS count FROM cost_price_version ${clause}`, values)
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT id, version_no, price_source, status, remark, enterprise_id, plant_id, business_time,
         command_receipt_id, created_at, created_by FROM cost_price_version ${clause}
       ORDER BY version_no DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return { items: r.rows.map(mapPriceHead), total: Number(total.rows[0]!.count) }
  }
}

function mapPriceHead(r: PriceRow): Omit<CostPriceVersionRecord, 'items'> {
  return {
    id: r.id,
    versionNo: r.version_no,
    priceSource: r.price_source,
    status: r.status,
    remark: r.remark,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    businessTime: iso(r.business_time),
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

// ---------------- cost_acquisition_run / line ----------------

interface RunRow {
  id: string
  run_no: string
  order_id: string
  allocation_version_id: string
  price_version_id: string
  shift_date: string
  shift_calendar_id: string
  data_cutoff_at: Date | string
  shift_snapshot_anchor: Record<string, unknown> | null
  estimate_amount: string | null
  actual_amount: string | null
  estimate_possible: boolean
  estimate_missing_reason: string | null
  energy_metered_usage: string
  energy_estimated_usage: string
  energy_coverage_ratio: string | null
  energy_uom_code: string | null
  machine_hours: string
  labor_source: string
  equipment_cost_caliber: string
  recalc_of: string | null
  old_new_comparison: Record<string, unknown> | null
  enterprise_id: string
  plant_id: string
  business_time: Date | string
  command_receipt_id: string
  created_at: Date | string
  created_by: string | null
}

function mapRun(r: RunRow): CostAcquisitionRunRecord {
  return {
    id: r.id,
    runNo: r.run_no,
    orderId: r.order_id,
    allocationVersionId: r.allocation_version_id,
    priceVersionId: r.price_version_id,
    shiftDate: typeof r.shift_date === 'string' ? r.shift_date : iso(r.shift_date).slice(0, 10),
    shiftCalendarId: r.shift_calendar_id,
    dataCutoffAt: iso(r.data_cutoff_at),
    shiftSnapshotAnchor: r.shift_snapshot_anchor,
    estimateAmount: r.estimate_amount === null ? null : num2(r.estimate_amount),
    actualAmount: r.actual_amount === null ? null : num2(r.actual_amount),
    estimatePossible: r.estimate_possible,
    estimateMissingReason: r.estimate_missing_reason,
    energyMeteredUsage: num2(r.energy_metered_usage),
    energyEstimatedUsage: num2(r.energy_estimated_usage),
    energyCoverageRatio: r.energy_coverage_ratio === null ? null : num2(r.energy_coverage_ratio),
    energyUomCode: r.energy_uom_code,
    machineHours: num2(r.machine_hours),
    laborSource: r.labor_source,
    equipmentCostCaliber: r.equipment_cost_caliber,
    recalcOf: r.recalc_of,
    oldNewComparison: r.old_new_comparison,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    businessTime: iso(r.business_time),
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

const RUN_COLUMNS = `id, run_no, order_id, allocation_version_id, price_version_id, shift_date::text AS shift_date,
  shift_calendar_id, data_cutoff_at, shift_snapshot_anchor, estimate_amount, actual_amount, estimate_possible,
  estimate_missing_reason, energy_metered_usage, energy_estimated_usage, energy_coverage_ratio, energy_uom_code,
  machine_hours, labor_source, equipment_cost_caliber, recalc_of, old_new_comparison, enterprise_id, plant_id,
  business_time, command_receipt_id, created_at, created_by`

class PgCostAcquisitionRunRepository implements CostAcquisitionRunRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(run: NewCostAcquisitionRun): Promise<CostAcquisitionRunRecord> {
    const r = await this.client.query(
      `INSERT INTO cost_acquisition_run (run_no, order_id, allocation_version_id, price_version_id, shift_date,
         shift_calendar_id, data_cutoff_at, shift_snapshot_anchor, estimate_amount, actual_amount,
         estimate_possible, estimate_missing_reason, energy_metered_usage, energy_estimated_usage,
         energy_coverage_ratio, energy_uom_code, machine_hours, labor_source, equipment_cost_caliber,
         recalc_of, old_new_comparison, enterprise_id, plant_id, business_time, command_receipt_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,
         $22,$23,COALESCE($24, now()),$25,$26)
       RETURNING ${RUN_COLUMNS}`,
      [
        run.runNo, run.orderId, run.allocationVersionId, run.priceVersionId, run.shiftDate,
        run.shiftCalendarId, run.dataCutoffAt, JSON.stringify(run.shiftSnapshotAnchor ?? null),
        run.estimateAmount ?? null, run.actualAmount ?? null, run.estimatePossible ?? true,
        run.estimateMissingReason ?? null, run.energyMeteredUsage ?? '0', run.energyEstimatedUsage ?? '0',
        run.energyCoverageRatio ?? null, run.energyUomCode ?? null, run.machineHours ?? '0',
        run.laborSource ?? 'labor_record', run.equipmentCostCaliber ?? 'runtime_hours_plus_spare_parts_excluding_depreciation',
        run.recalcOf ?? null, JSON.stringify(run.oldNewComparison ?? null),
        run.enterpriseId, run.plantId, run.businessTime ?? null, run.commandReceiptId, run.createdBy ?? null,
      ],
    )
    return mapRun(r.rows[0]!)
  }

  async findById(id: string): Promise<CostAcquisitionRunRecord | null> {
    const r = await this.client.query(`SELECT ${RUN_COLUMNS} FROM cost_acquisition_run WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapRun(r.rows[0])
  }

  async findLatestByOrderAndShift(orderId: string, shiftDate: string): Promise<CostAcquisitionRunRecord | null> {
    const r = await this.client.query(
      `SELECT ${RUN_COLUMNS} FROM cost_acquisition_run WHERE order_id = $1 AND shift_date = $2
       ORDER BY created_at DESC LIMIT 1`,
      [orderId, shiftDate],
    )
    return r.rows[0] === undefined ? null : mapRun(r.rows[0])
  }

  async countByOrderAndShift(orderId: string, shiftDate: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*) AS count FROM cost_acquisition_run WHERE order_id = $1 AND shift_date = $2`,
      [orderId, shiftDate],
    )
    return Number(r.rows[0]!.count)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    orderId?: string
    shiftDate?: string
    page: number
    pageSize: number
  }): Promise<{ items: CostAcquisitionRunRecord[]; total: number }> {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.plantId !== undefined) {
      values.push(filter.plantId)
      where.push(`plant_id = $${values.length}`)
    } else if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { items: [], total: 0 }
      values.push(filter.plantIds)
      where.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.orderId !== undefined) {
      values.push(filter.orderId)
      where.push(`order_id = $${values.length}`)
    }
    if (filter.shiftDate !== undefined) {
      values.push(filter.shiftDate)
      where.push(`shift_date = $${values.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*) AS count FROM cost_acquisition_run ${clause}`, values)
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${RUN_COLUMNS} FROM cost_acquisition_run ${clause}
       ORDER BY created_at DESC, id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return { items: r.rows.map(mapRun), total: Number(total.rows[0]!.count) }
  }
}

interface LineRow {
  id: string
  run_id: string
  line_no: number
  source_kind: CostAcquisitionLineRecord['sourceKind']
  source_table: string
  source_fact_id: string
  value_flag: CostAcquisitionLineRecord['valueFlag']
  order_id: string
  order_operation_id: string | null
  product_family_id: string | null
  quantity: string
  uom_code: string
  theoretical_quantity: string | null
  variance_quantity: string | null
  destination_breakdown_missing: boolean
  unit_price: string | null
  price_missing: boolean
  amount: string | null
  facts: Record<string, unknown>
  created_at: Date | string
  created_by: string | null
}

function mapLine(r: LineRow): CostAcquisitionLineRecord {
  return {
    id: r.id,
    runId: r.run_id,
    lineNo: r.line_no,
    sourceKind: r.source_kind,
    sourceTable: r.source_table,
    sourceFactId: r.source_fact_id,
    valueFlag: r.value_flag,
    orderId: r.order_id,
    orderOperationId: r.order_operation_id,
    productFamilyId: r.product_family_id,
    quantity: num2(r.quantity),
    uomCode: r.uom_code,
    theoreticalQuantity: r.theoretical_quantity === null ? null : num2(r.theoretical_quantity),
    varianceQuantity: r.variance_quantity === null ? null : num2(r.variance_quantity),
    destinationBreakdownMissing: r.destination_breakdown_missing,
    unitPrice: r.unit_price === null ? null : num6(r.unit_price),
    priceMissing: r.price_missing,
    amount: r.amount === null ? null : num2(r.amount),
    facts: r.facts ?? {},
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

const LINE_COLUMNS = `id, run_id, line_no, source_kind, source_table, source_fact_id, value_flag, order_id,
  order_operation_id, product_family_id, quantity, uom_code, theoretical_quantity, variance_quantity,
  destination_breakdown_missing, unit_price, price_missing, amount, facts, created_at, created_by`

class PgCostAcquisitionLineRepository implements CostAcquisitionLineRepository {
  constructor(private readonly client: SqlClient) {}

  async insertMany(lines: NewCostAcquisitionLine[]): Promise<CostAcquisitionLineRecord[]> {
    const records: CostAcquisitionLineRecord[] = []
    for (const line of lines) {
      const r = await this.client.query(
        `INSERT INTO cost_acquisition_line (run_id, line_no, source_kind, source_table, source_fact_id,
           value_flag, order_id, order_operation_id, product_family_id, quantity, uom_code,
           theoretical_quantity, variance_quantity, destination_breakdown_missing, unit_price, price_missing,
           amount, facts, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)
         RETURNING ${LINE_COLUMNS}`,
        [
          line.runId, line.lineNo, line.sourceKind, line.sourceTable, line.sourceFactId, line.valueFlag,
          line.orderId, line.orderOperationId ?? null, line.productFamilyId ?? null, line.quantity, line.uomCode,
          line.theoreticalQuantity ?? null, line.varianceQuantity ?? null, line.destinationBreakdownMissing ?? false,
          line.unitPrice ?? null, line.priceMissing ?? false, line.amount ?? null,
          JSON.stringify(line.facts ?? {}), line.createdBy ?? null,
        ],
      )
      records.push(mapLine(r.rows[0]!))
    }
    return records
  }

  async listByRun(runId: string): Promise<CostAcquisitionLineRecord[]> {
    const r = await this.client.query(
      `SELECT ${LINE_COLUMNS} FROM cost_acquisition_line WHERE run_id = $1 ORDER BY line_no`,
      [runId],
    )
    return r.rows.map(mapLine)
  }

  async listByOrder(orderId: string): Promise<CostAcquisitionLineRecord[]> {
    const r = await this.client.query(
      `SELECT ${LINE_COLUMNS} FROM cost_acquisition_line WHERE order_id = $1 ORDER BY created_at DESC, line_no`,
      [orderId],
    )
    return r.rows.map(mapLine)
  }
}

// ---------------- cost_recon_item ----------------

interface ReconRow {
  id: string
  recon_key: string
  run_id: string
  kind: CostReconItemRecord['kind']
  local_quantity: string
  erp_quantity: string
  diff_quantity: string
  uom_code: string
  material_code: string | null
  order_no: string | null
  erp_document_ref: string | null
  disposition_status: CostReconItemRecord['dispositionStatus']
  disposed_by: string | null
  disposed_at: Date | string | null
  disposition_reason: string | null
  enterprise_id: string
  plant_id: string
  business_time: Date | string
  command_receipt_id: string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapRecon(r: ReconRow): CostReconItemRecord {
  return {
    id: r.id,
    reconKey: r.recon_key,
    runId: r.run_id,
    kind: r.kind,
    localQuantity: num2(r.local_quantity),
    erpQuantity: num2(r.erp_quantity),
    diffQuantity: num2(r.diff_quantity),
    uomCode: r.uom_code,
    materialCode: r.material_code,
    orderNo: r.order_no,
    erpDocumentRef: r.erp_document_ref,
    dispositionStatus: r.disposition_status,
    disposedBy: r.disposed_by,
    disposedAt: isoOrNull(r.disposed_at),
    dispositionReason: r.disposition_reason,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    businessTime: iso(r.business_time),
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

const RECON_COLUMNS = `id, recon_key, run_id, kind, local_quantity, erp_quantity, diff_quantity, uom_code,
  material_code, order_no, erp_document_ref, disposition_status, disposed_by, disposed_at, disposition_reason,
  enterprise_id, plant_id, business_time, command_receipt_id, created_at, created_by, updated_at, updated_by`

class PgCostReconItemRepository implements CostReconItemRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(item: NewCostReconItem): Promise<CostReconItemRecord> {
    const r = await this.client.query(
      `INSERT INTO cost_recon_item (recon_key, run_id, kind, local_quantity, erp_quantity, diff_quantity,
         uom_code, material_code, order_no, erp_document_ref, disposition_status, enterprise_id, plant_id,
         business_time, command_receipt_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11,$12, now(),$13,$14)
       RETURNING ${RECON_COLUMNS}`,
      [
        item.reconKey, item.runId, item.kind, item.localQuantity, item.erpQuantity, item.diffQuantity,
        item.uomCode, item.materialCode ?? null, item.orderNo ?? null, item.erpDocumentRef ?? null,
        item.enterpriseId, item.plantId, item.commandReceiptId, item.createdBy ?? null,
      ],
    )
    return mapRecon(r.rows[0]!)
  }

  async findById(id: string): Promise<CostReconItemRecord | null> {
    const r = await this.client.query(`SELECT ${RECON_COLUMNS} FROM cost_recon_item WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapRecon(r.rows[0])
  }

  async findByKey(reconKey: string): Promise<CostReconItemRecord | null> {
    const r = await this.client.query(`SELECT ${RECON_COLUMNS} FROM cost_recon_item WHERE recon_key = $1`, [reconKey])
    return r.rows[0] === undefined ? null : mapRecon(r.rows[0])
  }

  async updateDisposition(
    id: string,
    patch: {
      dispositionStatus: CostReconItemRecord['dispositionStatus']
      disposedBy: string
      disposedAt: string
      dispositionReason: string
      erpDocumentRef?: string | null
    },
    actor: string | null,
  ): Promise<CostReconItemRecord | null> {
    const r = await this.client.query(
      `UPDATE cost_recon_item SET disposition_status = $2, disposed_by = $3, disposed_at = $4,
         disposition_reason = $5, erp_document_ref = COALESCE($6, erp_document_ref), updated_at = now(), updated_by = $7
       WHERE id = $1 RETURNING ${RECON_COLUMNS}`,
      [id, patch.dispositionStatus, patch.disposedBy, patch.disposedAt, patch.dispositionReason, patch.erpDocumentRef ?? null, actor],
    )
    return r.rows[0] === undefined ? null : mapRecon(r.rows[0])
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    runId?: string
    kinds?: string[]
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: CostReconItemRecord[]; total: number }> {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.plantId !== undefined) {
      values.push(filter.plantId)
      where.push(`plant_id = $${values.length}`)
    } else if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { items: [], total: 0 }
      values.push(filter.plantIds)
      where.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.runId !== undefined) {
      values.push(filter.runId)
      where.push(`run_id = $${values.length}`)
    }
    if (filter.kinds !== undefined && filter.kinds.length > 0) {
      values.push(filter.kinds)
      where.push(`kind = ANY($${values.length})`)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      values.push(filter.statuses)
      where.push(`disposition_status = ANY($${values.length})`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*) AS count FROM cost_recon_item ${clause}`, values)
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${RECON_COLUMNS} FROM cost_recon_item ${clause}
       ORDER BY created_at DESC, id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return { items: r.rows.map(mapRecon), total: Number(total.rows[0]!.count) }
  }
}

// ---------------- cost_labor_check ----------------

interface CheckRow {
  id: string
  order_id: string
  operation_key: string
  order_operation_id: string | null
  shift_date: string
  labor_hours: string
  ot_runtime_hours: string | null
  deviation_ratio: string | null
  threshold_ratio: string
  status: 'open' | 'acknowledged'
  missing_side: 'labor' | 'ot' | null
  acknowledged_by: string | null
  acknowledged_at: Date | string | null
  reason: string | null
  enterprise_id: string
  plant_id: string
  business_time: Date | string
  command_receipt_id: string
  created_at: Date | string
  created_by: string | null
}

function mapCheck(r: CheckRow): CostLaborCheckRecord {
  return {
    id: r.id,
    orderId: r.order_id,
    operationKey: r.operation_key,
    orderOperationId: r.order_operation_id,
    shiftDate: typeof r.shift_date === 'string' ? r.shift_date : iso(r.shift_date).slice(0, 10),
    laborHours: num2(r.labor_hours),
    otRuntimeHours: r.ot_runtime_hours === null ? null : num2(r.ot_runtime_hours),
    deviationRatio: r.deviation_ratio === null ? null : num2(r.deviation_ratio),
    thresholdRatio: num2(r.threshold_ratio),
    status: r.status,
    missingSide: r.missing_side,
    acknowledgedBy: r.acknowledged_by,
    acknowledgedAt: isoOrNull(r.acknowledged_at),
    reason: r.reason,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    businessTime: iso(r.business_time),
    commandReceiptId: r.command_receipt_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

const CHECK_COLUMNS = `id, order_id, operation_key, order_operation_id, shift_date::text AS shift_date, labor_hours,
  ot_runtime_hours, deviation_ratio, threshold_ratio, status, missing_side, acknowledged_by,
  acknowledged_at, reason, enterprise_id, plant_id, business_time, command_receipt_id, created_at, created_by`

class PgCostLaborCheckRepository implements CostLaborCheckRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(check: NewCostLaborCheck): Promise<CostLaborCheckRecord> {
    const r = await this.client.query(
      `INSERT INTO cost_labor_check (order_id, operation_key, order_operation_id, shift_date, labor_hours,
         ot_runtime_hours, deviation_ratio, threshold_ratio, status, missing_side, reason, enterprise_id,
         plant_id, business_time, command_receipt_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14, now()),$15,$16)
       RETURNING ${CHECK_COLUMNS}`,
      [
        check.orderId, check.operationKey, check.orderOperationId ?? null, check.shiftDate, check.laborHours,
        check.otRuntimeHours ?? null, check.deviationRatio ?? null, check.thresholdRatio,
        check.status ?? 'open', check.missingSide ?? null, check.reason ?? null,
        check.enterpriseId, check.plantId, check.businessTime ?? null, check.commandReceiptId, check.createdBy ?? null,
      ],
    )
    return mapCheck(r.rows[0]!)
  }

  async findById(id: string): Promise<CostLaborCheckRecord | null> {
    const r = await this.client.query(`SELECT ${CHECK_COLUMNS} FROM cost_labor_check WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapCheck(r.rows[0])
  }

  async findByKey(orderId: string, operationKey: string, shiftDate: string): Promise<CostLaborCheckRecord | null> {
    const r = await this.client.query(
      `SELECT ${CHECK_COLUMNS} FROM cost_labor_check WHERE order_id = $1 AND operation_key = $2 AND shift_date = $3`,
      [orderId, operationKey, shiftDate],
    )
    return r.rows[0] === undefined ? null : mapCheck(r.rows[0])
  }

  async updateAcknowledged(
    id: string,
    patch: { acknowledgedBy: string; acknowledgedAt: string; reason: string },
    actor: string | null,
  ): Promise<CostLaborCheckRecord | null> {
    const r = await this.client.query(
      `UPDATE cost_labor_check SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = $3,
         reason = $4, updated_at = now(), updated_by = $5
       WHERE id = $1 RETURNING ${CHECK_COLUMNS}`,
      [id, patch.acknowledgedBy, patch.acknowledgedAt, patch.reason, actor],
    )
    return r.rows[0] === undefined ? null : mapCheck(r.rows[0])
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    orderId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: CostLaborCheckRecord[]; total: number }> {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.plantId !== undefined) {
      values.push(filter.plantId)
      where.push(`plant_id = $${values.length}`)
    } else if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { items: [], total: 0 }
      values.push(filter.plantIds)
      where.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.orderId !== undefined) {
      values.push(filter.orderId)
      where.push(`order_id = $${values.length}`)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      values.push(filter.statuses)
      where.push(`status = ANY($${values.length})`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*) AS count FROM cost_labor_check ${clause}`, values)
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${CHECK_COLUMNS} FROM cost_labor_check ${clause}
       ORDER BY created_at DESC, id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    return { items: r.rows.map(mapCheck), total: Number(total.rows[0]!.count) }
  }
}

// ---------------- 事实读取端口（CE-05 唯一来源映射；只读 CE-02） ----------------

class PgCostFactReaders implements CostFactReaders {
  constructor(private readonly client: SqlClient) {}

  async findProductionOrder(orderId: string) {
    const r = await this.client.query(
      `SELECT po.id, po.order_no, po.plant_id, po.enterprise_id, po.material_id, m.code AS material_code,
         po.production_qty AS planned_qty, po.uom, po.bom_revision_id, po.product_family_id, po.order_status
       FROM production_order po JOIN material m ON m.id = po.material_id WHERE po.id = $1`,
      [orderId],
    )
    const row = r.rows[0]
    if (row === undefined) return null
    return {
      id: row.id,
      orderNo: row.order_no,
      plantId: row.plant_id,
      enterpriseId: row.enterprise_id,
      materialId: row.material_id,
      materialCode: row.material_code,
      plannedQty: num2(row.planned_qty),
      uom: row.uom,
      bomRevisionId: row.bom_revision_id,
      productFamilyId: row.product_family_id,
      orderStatus: row.order_status,
    }
  }

  async listOrderOperations(orderId: string) {
    const r = await this.client.query(
      `SELECT DISTINCT ON (seq) id, seq, operation_code, operation_name FROM order_operation
       WHERE order_id = $1 ORDER BY seq, settings_version DESC`,
      [orderId],
    )
    return r.rows.map((row) => ({ id: row.id, seq: row.seq, operationCode: row.operation_code, operationName: row.operation_name }))
  }

  async findPublishedBomLines(orderId: string) {
    const r = await this.client.query(
      `SELECT b.lines FROM manufacturing_bom_revision b
       JOIN production_order po ON po.bom_revision_id = b.id
       WHERE po.id = $1 AND b.status = 'published'`,
      [orderId],
    )
    const raw = r.rows[0]?.lines
    if (r.rows[0] === undefined || !Array.isArray(raw)) return null
    const lines: Array<{ materialCode: string; qtyPerUnit: string; uomCode: string }> = []
    for (const item of raw) {
      const it = (item ?? {}) as Record<string, unknown>
      if (typeof it['materialCode'] !== 'string' || typeof it['quantity'] !== 'string') continue
      lines.push({ materialCode: it['materialCode'], qtyPerUnit: it['quantity'], uomCode: typeof it['uom'] === 'string' ? it['uom'] : '' })
    }
    return lines
  }

  async listConsumptionByOrder(orderId: string, cutoffIso: string): Promise<ConsumptionFact[]> {
    const r = await this.client.query(
      `SELECT mc.id, mc.order_id, mc.order_operation_id, mc.operation_seq, mc.quantity, mc.uom_code,
         mc.unit_no, iu.material_code, mc.business_time
       FROM material_consumption mc
       JOIN inventory_unit iu ON iu.id = mc.inventory_unit_id
       WHERE mc.order_id = $1 AND mc.business_time <= $2
       ORDER BY mc.business_time, mc.id`,
      [orderId, cutoffIso],
    )
    return r.rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      orderOperationId: row.order_operation_id,
      operationSeq: row.operation_seq,
      quantity: num2(row.quantity),
      uomCode: row.uom_code,
      unitNo: row.unit_no,
      materialCode: row.material_code,
      businessTime: iso(row.business_time),
    }))
  }

  async listLaborByOrder(orderId: string, cutoffIso: string): Promise<LaborFact[]> {
    // shift_date 以 ::text 读出（pg date→本地零点 Date 在东八区会前移一天，禁用）
    const r = await this.client.query(
      `SELECT l.id, l.order_id, l.order_operation_id, o.seq AS operation_seq, l.hours, l.shift_date::text AS shift_date, l.business_time
       FROM labor_record l LEFT JOIN order_operation o ON o.id = l.order_operation_id
       WHERE l.order_id = $1 AND l.business_time <= $2
       ORDER BY l.business_time, l.id`,
      [orderId, cutoffIso],
    )
    return r.rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      orderOperationId: row.order_operation_id,
      operationSeq: row.operation_seq,
      hours: num2(row.hours),
      shiftDate: String(row.shift_date).slice(0, 10),
      businessTime: iso(row.business_time),
    }))
  }

  async listOutputsByOrder(orderId: string, cutoffIso: string): Promise<OutputFact[]> {
    const r = await this.client.query(
      `SELECT ro.id, pr.order_id, pr.order_operation_id, pr.operation_seq, ro.quantity, ro.qualified_qty,
         ro.stock_unit_id, ro.uom_code, pr.business_time
       FROM report_output ro JOIN production_report pr ON pr.id = ro.report_id
       WHERE pr.order_id = $1 AND pr.status = 'submitted' AND pr.business_time <= $2
       ORDER BY pr.business_time, ro.id`,
      [orderId, cutoffIso],
    )
    return r.rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      orderOperationId: row.order_operation_id,
      operationSeq: row.operation_seq,
      quantity: num2(row.quantity),
      qualifiedQty: num2(row.qualified_qty),
      stockUnitId: row.stock_unit_id,
      uomCode: row.uom_code,
      businessTime: iso(row.business_time),
    }))
  }

  async listSessionEquipmentCountsByOrder(orderId: string, cutoffIso: string) {
    const r = await this.client.query(
      `SELECT equipment_code, order_operation_id, count(*) AS session_count FROM execution_session
       WHERE order_id = $1 AND status <> 'cancelled' AND equipment_code IS NOT NULL AND equipment_code <> ''
         AND business_time <= $2
       GROUP BY equipment_code, order_operation_id`,
      [orderId, cutoffIso],
    )
    return r.rows.map((row) => ({
      equipmentCode: row.equipment_code,
      orderOperationId: row.order_operation_id,
      sessionCount: Number(row.session_count),
    }))
  }

  async listSessionEquipmentCounts(plantId: string, fromIso: string, toIso: string, orderId?: string) {
    const values: unknown[] = [plantId, fromIso, toIso]
    let orderClause = ''
    if (orderId !== undefined) {
      values.push(orderId)
      orderClause = ` AND order_id = $${values.length}`
    }
    const r = await this.client.query(
      `SELECT equipment_code, count(*) AS session_count FROM execution_session
       WHERE plant_id = $1 AND business_time >= $2 AND business_time <= $3
         AND status <> 'cancelled' AND equipment_code IS NOT NULL AND equipment_code <> ''${orderClause}
       GROUP BY equipment_code`,
      values,
    )
    return r.rows.map((row) => ({ equipmentCode: row.equipment_code, sessionCount: Number(row.session_count) }))
  }

  async listPlantOutputByOrder(plantId: string, fromIso: string, toIso: string) {
    const r = await this.client.query(
      `SELECT pr.order_id, sum(ro.quantity) AS quantity
       FROM report_output ro JOIN production_report pr ON pr.id = ro.report_id
       WHERE pr.plant_id = $1 AND pr.status = 'submitted' AND pr.business_time >= $2 AND pr.business_time <= $3
       GROUP BY pr.order_id`,
      [plantId, fromIso, toIso],
    )
    return r.rows.map((row) => ({ orderId: row.order_id, quantity: num2(row.quantity) }))
  }

  async plantOutputTotals(plantId: string, fromIso: string, toIso: string) {
    const r = await this.client.query(
      `SELECT sum(ro.quantity) AS total_qty, sum(ro.qualified_qty) AS qualified_qty, count(*) AS row_count
       FROM report_output ro JOIN production_report pr ON pr.id = ro.report_id
       WHERE pr.plant_id = $1 AND pr.status = 'submitted' AND pr.business_time >= $2 AND pr.business_time <= $3`,
      [plantId, fromIso, toIso],
    )
    const row = r.rows[0]
    if (row === undefined || Number(row.row_count) === 0) return { totalQty: null, qualifiedQty: null }
    return { totalQty: num2(row.total_qty ?? '0'), qualifiedQty: num2(row.qualified_qty ?? '0') }
  }

  async findEquipmentByCode(plantId: string, code: string) {
    const r = await this.client.query(
      `SELECT id, code, name, std_rate_text FROM equipment WHERE plant_id = $1 AND code = $2 AND status = 'active'`,
      [plantId, code],
    )
    const row = r.rows[0]
    return row === undefined ? null : { id: row.id, code: row.code, name: row.name, stdRateText: row.std_rate_text }
  }

  async findShiftCalendar(plantId: string) {
    const r = await this.client.query(
      `SELECT id, code, name FROM shift_calendar WHERE plant_id = $1 AND status = 'active' ORDER BY code LIMIT 1`,
      [plantId],
    )
    const row = r.rows[0]
    return row === undefined ? null : { id: row.id, code: row.code, name: row.name }
  }

  async shiftSnapshotStats(plantId: string, shiftDate: string) {
    const r = await this.client.query(
      `SELECT count(*) AS count, max(computed_at) AS last_computed FROM shift_snapshot
       WHERE plant_id = $1 AND shift_date = $2`,
      [plantId, shiftDate],
    )
    const row = r.rows[0]
    if (row === undefined || Number(row.count) === 0) return null
    return { snapshotCount: Number(row.count), lastComputedAt: iso(row.last_computed) }
  }

  async downtimeMinutesByEquipment(equipmentId: string, fromIso: string, toIso: string) {
    const r = await this.client.query(
      `SELECT sum(EXTRACT(EPOCH FROM (COALESCE(end_at, $3::timestamptz) - start_at)) / 60) AS total_minutes, count(*) AS row_count
       FROM downtime_event WHERE equipment_id = $1 AND start_at >= $2 AND start_at <= $3`,
      [equipmentId, fromIso, toIso],
    )
    const row = r.rows[0]
    if (row === undefined || Number(row.row_count) === 0) return null
    return num2(row.total_minutes ?? '0')
  }

  async listSparePartUsageByEquipment(equipmentId: string, fromIso: string, toIso: string): Promise<SparePartFact[]> {
    const r = await this.client.query(
      `SELECT sp.id, sp.quantity, sp.uom_code, sp.material_code, mo.equipment_id, sp.created_at
       FROM spare_part_usage sp JOIN maintenance_order mo ON mo.id = sp.order_id
       WHERE mo.equipment_id = $1 AND sp.created_at >= $2 AND sp.created_at <= $3
       ORDER BY sp.created_at, sp.id`,
      [equipmentId, fromIso, toIso],
    )
    return r.rows.map((row) => ({
      id: row.id,
      quantity: num2(row.quantity),
      uomCode: row.uom_code,
      materialCode: row.material_code,
      equipmentId: row.equipment_id,
      businessTime: iso(row.created_at),
    }))
  }

  async otRuntimeHoursByEquipment(equipmentId: string, fromIso: string, toIso: string) {
    // CA-12 参考源等价计算：speed 语义点位、优良质量、值>0 的去重事件数×采样率秒数÷3600
    // （每个采样代表 sample_rate_seconds 的运行区间；收编请求见交付记录）
    const r = await this.client.query(
      `SELECT (count(DISTINCT s.event_time) * max(p.sample_rate_seconds))::text AS seconds
       FROM ot_sample s
       JOIN ot_device d ON d.device_serial = s.device_serial AND d.equipment_id = $1
       JOIN ot_point p ON p.device_serial = s.device_serial AND p.point_code = s.point_code
         AND p.semantic = 'speed' AND p.status = 'active'
       WHERE s.event_time >= $2 AND s.event_time <= $3
         AND s.quality_level = 'good' AND s.is_quarantined = false AND s.is_bad = false
         AND COALESCE(s.normalized_value, s.raw_value) > 0`,
      [equipmentId, fromIso, toIso],
    )
    const seconds = Number(r.rows[0]?.seconds ?? '0')
    if (seconds === 0) return null
    const first = await this.client.query(
      `SELECT s.id FROM ot_sample s
       JOIN ot_device d ON d.device_serial = s.device_serial AND d.equipment_id = $1
       JOIN ot_point p ON p.device_serial = s.device_serial AND p.point_code = s.point_code
         AND p.semantic = 'speed' AND p.status = 'active'
       WHERE s.event_time >= $2 AND s.event_time <= $3
         AND s.quality_level = 'good' AND s.is_quarantined = false AND s.is_bad = false
         AND COALESCE(s.normalized_value, s.raw_value) > 0
       ORDER BY s.event_time LIMIT 1`,
      [equipmentId, fromIso, toIso],
    )
    const hours = seconds / 3600
    return {
      hours: `${hours.toFixed(2)}`,
      firstSampleId: first.rows[0]?.id ?? null,
      sampleCount: seconds,
    }
  }

  async listOtSamplesByPoint(otPointId: string, fromIso: string, toIso: string): Promise<OtSampleFact[]> {
    const r = await this.client.query(
      `SELECT s.id, s.device_serial, s.point_code, s.event_time,
         COALESCE(s.normalized_value, s.raw_value) AS value, s.quality_level
       FROM ot_sample s
       WHERE s.device_serial = (SELECT device_serial FROM ot_point WHERE id = $1)
         AND s.point_code = (SELECT point_code FROM ot_point WHERE id = $1)
         AND s.event_time >= $2 AND s.event_time <= $3
         AND s.is_quarantined = false AND s.is_bad = false
       ORDER BY s.event_time`,
      [otPointId, fromIso, toIso],
    )
    return r.rows.map((row) => ({
      id: row.id,
      deviceSerial: row.device_serial,
      pointCode: row.point_code,
      eventTime: iso(row.event_time),
      value: num2(row.value),
      qualityLevel: row.quality_level,
    }))
  }
}

// ---------------- 组装 ----------------

/** 0001 command_receipt 窄读（幂等回执定位，同各域先例）。 */
class PgCostReceiptReader {
  constructor(private readonly client: SqlClient) {}

  async findIdByKey(enterpriseId: string, commandType: string, operationId: string): Promise<string | null> {
    const r = await this.client.query(
      `SELECT id FROM command_receipt WHERE enterprise_id = $1 AND command_type = $2 AND operation_id = $3`,
      [enterpriseId, commandType, operationId],
    )
    return r.rows[0]?.id ?? null
  }
}

/** cost 域仓储束（命令事务客户端或查询池绑定）。 */
export function createPgCostRepositories(client: SqlClient): CostRepositories {
  return {
    meters: new PgCostMeterRepository(client),
    readings: new PgCostMeterReadingRepository(client),
    allocationVersions: new PgCostAllocationVersionRepository(client),
    priceVersions: new PgCostPriceVersionRepository(client),
    runs: new PgCostAcquisitionRunRepository(client),
    lines: new PgCostAcquisitionLineRepository(client),
    reconItems: new PgCostReconItemRepository(client),
    laborChecks: new PgCostLaborCheckRepository(client),
    facts: new PgCostFactReaders(client),
    receipts: new PgCostReceiptReader(client),
  }
}
