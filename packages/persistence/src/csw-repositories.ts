// 跨包类型导入（type-only，编译期擦除）：指向 application 已构建的 dist（构建顺序由 workspace
// 拓扑保证：persistence 依赖 application）。csw 端口尚未并入 @cadenza/application 包名入口
// （application/src/index.ts 为共享文件不改动），故走 dist 相对；L0 整合步把端口导出并入
// application index、本文件导出并入 persistence index 后改包名导入（同 shipping/spc 先例）。
import type {
  CswCalibrationStateRecord,
  CswCalibrationStateRepository,
  CswChangeoverMatrixRecord,
  CswChangeoverMatrixRepository,
  CswDowntimeRecord,
  CswDowntimeRepository,
  CswFreezeRecord,
  CswFreezeRepository,
  CswLookups,
  CswMaterialAvailabilityRow,
  CswOutsourcingTaskRecord,
  CswOutsourcingTaskRepository,
  CswOutsourcingUnitRecord,
  CswOutsourcingUnitRepository,
  CswOverrideAuditRecord,
  CswOverrideAuditRepository,
  CswRepositories,
  CswScheduleVersionItemRecord,
  CswScheduleVersionItemRepository,
  CswScheduleVersionRecord,
  CswScheduleVersionRepository,
  CswSchedulableOrderRow,
  CswSlotBrief,
  CswStorageLocationBrief,
  NewCswChangeoverMatrix,
  NewCswDowntimeRecord,
  NewCswFreezeRecord,
  NewCswOutsourcingTask,
  NewCswOutsourcingUnit,
  NewCswOverrideAudit,
  NewCswScheduleVersion,
  NewCswScheduleVersionItem,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

/**
 * csw 域仓储的 PostgreSQL 实现（implements application 端口；0018 csw 表列一一对应）。
 * 行锁方法（lockById）在命令事务内 SELECT ... FOR UPDATE；版本条目/矩阵/审计为
 * append-only（库级触发器守卫）；排程版本头仅状态列可更新（cadenza_csw_version_guard）。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

function dateStr(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

function pageNum(page?: number, pageSize?: number): { page: number; pageSize: number; offset: number } {
  const p = typeof page === 'number' && page >= 1 ? Math.floor(page) : 1
  const s = typeof pageSize === 'number' && pageSize >= 1 ? Math.min(Math.floor(pageSize), 1000) : 20
  return { page: p, pageSize: s, offset: (p - 1) * s }
}

// ---------------- csw_freeze_record ----------------

const FREEZE_COLUMNS = `id, enterprise_id, plant_id, scope, equipment_id,
  production_date_from::text AS production_date_from, production_date_to::text AS production_date_to,
  slot_id, status, reason, frozen_by, frozen_at, unfrozen_by, unfrozen_at,
  unfreeze_reason, created_at, created_by, updated_at, updated_by`

interface FreezeRow {
  id: string
  enterprise_id: string
  plant_id: string
  scope: CswFreezeRecord['scope']
  equipment_id: string
  production_date_from: Date | string
  production_date_to: Date | string
  slot_id: string | null
  status: CswFreezeRecord['status']
  reason: string | null
  frozen_by: string | null
  frozen_at: Date | string
  unfrozen_by: string | null
  unfrozen_at: Date | string | null
  unfreeze_reason: string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapFreeze(r: FreezeRow): CswFreezeRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    scope: r.scope,
    equipmentId: r.equipment_id,
    productionDateFrom: dateStr(r.production_date_from),
    productionDateTo: dateStr(r.production_date_to),
    slotId: r.slot_id,
    status: r.status,
    reason: r.reason,
    frozenBy: r.frozen_by,
    frozenAt: iso(r.frozen_at),
    unfrozenBy: r.unfrozen_by,
    unfrozenAt: isoOrNull(r.unfrozen_at),
    unfreezeReason: r.unfreeze_reason,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgCswFreezeRepository implements CswFreezeRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(record: NewCswFreezeRecord): Promise<CswFreezeRecord> {
    const r = await this.client.query(
      `INSERT INTO csw_freeze_record
         (enterprise_id, plant_id, scope, equipment_id, production_date_from, production_date_to,
          slot_id, reason, frozen_by, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${FREEZE_COLUMNS}`,
      [
        record.enterpriseId,
        record.plantId,
        record.scope,
        record.equipmentId,
        record.productionDateFrom,
        record.productionDateTo,
        record.slotId ?? null,
        record.reason ?? null,
        record.frozenBy ?? null,
        record.frozenBy ?? null,
      ],
    )
    return mapFreeze(r.rows[0] as FreezeRow)
  }

  async findById(id: string): Promise<CswFreezeRecord | null> {
    const r = await this.client.query(`SELECT ${FREEZE_COLUMNS} FROM csw_freeze_record WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapFreeze(r.rows[0] as FreezeRow)
  }

  async lockById(id: string): Promise<CswFreezeRecord | null> {
    const r = await this.client.query(
      `SELECT ${FREEZE_COLUMNS} FROM csw_freeze_record WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapFreeze(r.rows[0] as FreezeRow)
  }

  async listActiveByEquipment(equipmentId: string): Promise<CswFreezeRecord[]> {
    const r = await this.client.query(
      `SELECT ${FREEZE_COLUMNS} FROM csw_freeze_record WHERE equipment_id = $1 AND status = 'active'
       ORDER BY production_date_from`,
      [equipmentId],
    )
    return r.rows.map((row) => mapFreeze(row as FreezeRow))
  }

  async list(
    filter: { plantIds: string[] | null; equipmentId?: string; status?: 'active' | 'ended' } & { page?: number; pageSize?: number },
  ): Promise<{ items: CswFreezeRecord[]; total: number; page: number; pageSize: number }> {
    const { page, pageSize, offset } = pageNum(filter.page, filter.pageSize)
    const where: string[] = []
    const args: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { items: [], total: 0, page, pageSize }
      args.push(filter.plantIds)
      where.push(`plant_id = ANY($${args.length})`)
    }
    if (filter.equipmentId !== undefined) {
      args.push(filter.equipmentId)
      where.push(`equipment_id = $${args.length}`)
    }
    if (filter.status !== undefined) {
      args.push(filter.status)
      where.push(`status = $${args.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(
      `SELECT count(*)::int AS n FROM csw_freeze_record ${clause}`,
      args,
    )
    const r = await this.client.query(
      `SELECT ${FREEZE_COLUMNS} FROM csw_freeze_record ${clause}
       ORDER BY frozen_at DESC, id LIMIT ${pageSize} OFFSET ${offset}`,
      args,
    )
    return { items: r.rows.map((row) => mapFreeze(row as FreezeRow)), total: total.rows[0]?.n ?? 0, page, pageSize }
  }

  async release(
    id: string,
    patch: { unfrozenBy: string; unfreezeReason: string; unfrozenAt: string },
  ): Promise<CswFreezeRecord> {
    const r = await this.client.query(
      `UPDATE csw_freeze_record
       SET status = 'ended', unfrozen_by = $2, unfrozen_at = $3, unfreeze_reason = $4,
           updated_at = now(), updated_by = $2
       WHERE id = $1 RETURNING ${FREEZE_COLUMNS}`,
      [id, patch.unfrozenBy, patch.unfrozenAt, patch.unfreezeReason],
    )
    return mapFreeze(r.rows[0] as FreezeRow)
  }
}

// ---------------- csw_changeover_matrix ----------------

interface MatrixRow {
  id: string
  enterprise_id: string
  plant_id: string
  version_no: number
  dimension_kind: CswChangeoverMatrixRecord['dimensionKind']
  default_minutes: number
  entries: Array<{ fromValue: string; toValue: string; minutes: number }>
  note: string | null
  created_at: Date | string
  created_by: string | null
}

function mapMatrix(r: MatrixRow): CswChangeoverMatrixRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    versionNo: r.version_no,
    dimensionKind: r.dimension_kind,
    defaultMinutes: r.default_minutes,
    entries: Array.isArray(r.entries) ? r.entries : [],
    note: r.note,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
  }
}

export class PgCswChangeoverMatrixRepository implements CswChangeoverMatrixRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(matrix: NewCswChangeoverMatrix): Promise<CswChangeoverMatrixRecord> {
    const r = await this.client.query(
      `INSERT INTO csw_changeover_matrix
         (enterprise_id, plant_id, version_no, dimension_kind, default_minutes, entries, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       RETURNING id, enterprise_id, plant_id, version_no, dimension_kind, default_minutes, entries, note, created_at, created_by`,
      [
        matrix.enterpriseId,
        matrix.plantId,
        matrix.versionNo,
        matrix.dimensionKind,
        matrix.defaultMinutes,
        JSON.stringify(matrix.entries),
        matrix.note ?? null,
        matrix.createdBy ?? null,
      ],
    )
    return mapMatrix(r.rows[0] as MatrixRow)
  }

  async findById(id: string): Promise<CswChangeoverMatrixRecord | null> {
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, version_no, dimension_kind, default_minutes, entries, note, created_at, created_by
       FROM csw_changeover_matrix WHERE id = $1`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapMatrix(r.rows[0] as MatrixRow)
  }

  async findLatestByPlant(plantId: string): Promise<CswChangeoverMatrixRecord | null> {
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, version_no, dimension_kind, default_minutes, entries, note, created_at, created_by
       FROM csw_changeover_matrix WHERE plant_id = $1 ORDER BY version_no DESC LIMIT 1`,
      [plantId],
    )
    return r.rows[0] === undefined ? null : mapMatrix(r.rows[0] as MatrixRow)
  }

  async list(filter: { plantIds: string[] | null }): Promise<CswChangeoverMatrixRecord[]> {
    const clause =
      filter.plantIds === null
        ? ''
        : filter.plantIds.length === 0
          ? 'WHERE false'
          : `WHERE plant_id = ANY($1)`
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, version_no, dimension_kind, default_minutes, entries, note, created_at, created_by
       FROM csw_changeover_matrix ${clause} ORDER BY plant_id, version_no DESC`,
      filter.plantIds === null || filter.plantIds.length === 0 ? [] : [filter.plantIds],
    )
    return r.rows.map((row) => mapMatrix(row as MatrixRow))
  }
}

// ---------------- csw_schedule_version / items ----------------

const VERSION_COLUMNS = `id, enterprise_id, plant_id, version_no, source, parent_version_id,
  matrix_version_id, weights_json, horizon_days, horizon_from::text AS horizon_from, status, proposed_by,
  committed_by, committed_at, superseded_at, created_at, created_by, updated_at, updated_by`

interface VersionRow {
  id: string
  enterprise_id: string
  plant_id: string
  version_no: number
  source: CswScheduleVersionRecord['source']
  parent_version_id: string | null
  matrix_version_id: string | null
  weights_json: { dueDate: string; changeover: string; loadBalance: string }
  horizon_days: number
  horizon_from: Date | string
  status: CswScheduleVersionRecord['status']
  proposed_by: string | null
  committed_by: string | null
  committed_at: Date | string | null
  superseded_at: Date | string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapVersion(r: VersionRow): CswScheduleVersionRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    versionNo: r.version_no,
    source: r.source,
    parentVersionId: r.parent_version_id,
    matrixVersionId: r.matrix_version_id,
    weights: r.weights_json,
    horizonDays: r.horizon_days,
    horizonFrom: dateStr(r.horizon_from),
    status: r.status,
    proposedBy: r.proposed_by,
    committedBy: r.committed_by,
    committedAt: isoOrNull(r.committed_at),
    supersededAt: isoOrNull(r.superseded_at),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgCswScheduleVersionRepository implements CswScheduleVersionRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(version: NewCswScheduleVersion): Promise<CswScheduleVersionRecord> {
    const r = await this.client.query(
      `INSERT INTO csw_schedule_version
         (enterprise_id, plant_id, version_no, source, parent_version_id, matrix_version_id,
          weights_json, horizon_days, horizon_from, proposed_by, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) RETURNING ${VERSION_COLUMNS}`,
      [
        version.enterpriseId,
        version.plantId,
        version.versionNo,
        version.source,
        version.parentVersionId ?? null,
        version.matrixVersionId ?? null,
        JSON.stringify(version.weights),
        version.horizonDays,
        version.horizonFrom,
        version.proposedBy ?? null,
        version.proposedBy ?? null,
      ],
    )
    return mapVersion(r.rows[0] as VersionRow)
  }

  async findById(id: string): Promise<CswScheduleVersionRecord | null> {
    const r = await this.client.query(`SELECT ${VERSION_COLUMNS} FROM csw_schedule_version WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapVersion(r.rows[0] as VersionRow)
  }

  async lockById(id: string): Promise<CswScheduleVersionRecord | null> {
    const r = await this.client.query(
      `SELECT ${VERSION_COLUMNS} FROM csw_schedule_version WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapVersion(r.rows[0] as VersionRow)
  }

  async findLatestCommitted(plantId: string): Promise<CswScheduleVersionRecord | null> {
    const r = await this.client.query(
      `SELECT ${VERSION_COLUMNS} FROM csw_schedule_version
       WHERE plant_id = $1 AND status = 'committed' ORDER BY version_no DESC LIMIT 1`,
      [plantId],
    )
    return r.rows[0] === undefined ? null : mapVersion(r.rows[0] as VersionRow)
  }

  async nextVersionNo(plantId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT coalesce(max(version_no), 0)::int AS n FROM csw_schedule_version WHERE plant_id = $1`,
      [plantId],
    )
    return (r.rows[0]?.n ?? 0) + 1
  }

  async markCommitted(id: string, patch: { committedBy: string; committedAt: string }): Promise<CswScheduleVersionRecord> {
    const r = await this.client.query(
      `UPDATE csw_schedule_version SET status = 'committed', committed_by = $2, committed_at = $3,
         updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING ${VERSION_COLUMNS}`,
      [id, patch.committedBy, patch.committedAt],
    )
    return mapVersion(r.rows[0] as VersionRow)
  }

  async markSuperseded(id: string, at: string): Promise<CswScheduleVersionRecord> {
    const r = await this.client.query(
      `UPDATE csw_schedule_version SET status = 'superseded', superseded_at = $2,
         updated_at = now() WHERE id = $1 RETURNING ${VERSION_COLUMNS}`,
      [id, at],
    )
    return mapVersion(r.rows[0] as VersionRow)
  }

  async list(
    filter: { plantIds: string[] | null; status?: CswScheduleVersionRecord['status'] } & { page?: number; pageSize?: number },
  ): Promise<{ items: CswScheduleVersionRecord[]; total: number; page: number; pageSize: number }> {
    const { page, pageSize, offset } = pageNum(filter.page, filter.pageSize)
    const where: string[] = []
    const args: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { items: [], total: 0, page, pageSize }
      args.push(filter.plantIds)
      where.push(`plant_id = ANY($${args.length})`)
    }
    if (filter.status !== undefined) {
      args.push(filter.status)
      where.push(`status = $${args.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS n FROM csw_schedule_version ${clause}`, args)
    const r = await this.client.query(
      `SELECT ${VERSION_COLUMNS} FROM csw_schedule_version ${clause}
       ORDER BY version_no DESC LIMIT ${pageSize} OFFSET ${offset}`,
      args,
    )
    return { items: r.rows.map((row) => mapVersion(row as VersionRow)), total: total.rows[0]?.n ?? 0, page, pageSize }
  }
}

interface ItemRow {
  id: string
  version_id: string
  item_no: number
  action: CswScheduleVersionItemRecord['action']
  order_operation_id: string
  order_id: string
  order_no: string
  operation_name: string
  operation_definition_id: string
  equipment_id: string | null
  production_date: Date | string | null
  planned_qty: string | null
  slot_id: string | null
  frozen: boolean
  started: boolean
  need_manual: boolean
  soft_violations: Array<{ code: string; detail: string }>
  explanation: Record<string, unknown>
  suggestions: Array<{ option: string; detail: string }>
  created_at: Date | string
}

function mapItem(r: ItemRow): CswScheduleVersionItemRecord {
  return {
    id: r.id,
    versionId: r.version_id,
    itemNo: r.item_no,
    action: r.action,
    orderOperationId: r.order_operation_id,
    orderId: r.order_id,
    orderNo: r.order_no,
    operationName: r.operation_name,
    operationDefinitionId: r.operation_definition_id,
    equipmentId: r.equipment_id,
    productionDate: r.production_date === null ? null : dateStr(r.production_date),
    plannedQty: r.planned_qty === null ? null : String(r.planned_qty),
    slotId: r.slot_id,
    frozen: r.frozen,
    started: r.started,
    needManual: r.need_manual,
    softViolations: Array.isArray(r.soft_violations) ? r.soft_violations : [],
    explanation: r.explanation ?? {},
    suggestions: Array.isArray(r.suggestions) ? r.suggestions : [],
    createdAt: iso(r.created_at),
  }
}

export class PgCswScheduleVersionItemRepository implements CswScheduleVersionItemRepository {
  constructor(private readonly client: SqlClient) {}

  async insertMany(versionId: string, items: readonly NewCswScheduleVersionItem[]): Promise<number> {
    if (items.length === 0) return 0
    const values: unknown[][] = []
    const placeholders: string[] = []
    let argIndex = 1
    for (const item of items) {
      const row = [
        versionId,
        item.itemNo,
        item.action,
        item.orderOperationId,
        item.orderId,
        item.orderNo,
        item.operationName,
        item.operationDefinitionId,
        item.equipmentId ?? null,
        item.productionDate ?? null,
        item.plannedQty ?? null,
        item.slotId ?? null,
        item.frozen ?? false,
        item.started ?? false,
        item.needManual ?? false,
        JSON.stringify(item.softViolations ?? []),
        JSON.stringify(item.explanation ?? {}),
        JSON.stringify(item.suggestions ?? []),
      ]
      const ph = row.map(() => `$${argIndex++}`)
      placeholders.push(`(${ph.join(',')})`)
      values.push(row)
    }
    const flat = values.flat()
    const r = await this.client.query(
      `INSERT INTO csw_schedule_version_item
         (version_id, item_no, action, order_operation_id, order_id, order_no, operation_name,
          operation_definition_id, equipment_id, production_date, planned_qty, slot_id, frozen,
          started, need_manual, soft_violations, explanation, suggestions)
       VALUES ${placeholders.join(',')} RETURNING id`,
      flat,
    )
    return r.rowCount ?? 0
  }

  async listByVersion(versionId: string): Promise<CswScheduleVersionItemRecord[]> {
    const r = await this.client.query(
      `SELECT id, version_id, item_no, action, order_operation_id, order_id, order_no, operation_name,
         operation_definition_id, equipment_id, production_date::text AS production_date, planned_qty,
         slot_id, frozen, started, need_manual, soft_violations, explanation, suggestions, created_at
       FROM csw_schedule_version_item WHERE version_id = $1 ORDER BY item_no`,
      [versionId],
    )
    return r.rows.map((row) => mapItem(row as ItemRow))
  }
}

// ---------------- csw_override_audit ----------------

interface OverrideRow {
  id: string
  enterprise_id: string
  plant_id: string
  override_type: CswOverrideAuditRecord['overrideType']
  operator: string
  reason: string
  affected_tasks: string[]
  schedule_version_id: string | null
  created_at: Date | string
}

function mapOverride(r: OverrideRow): CswOverrideAuditRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    overrideType: r.override_type,
    operator: r.operator,
    reason: r.reason,
    affectedTasks: Array.isArray(r.affected_tasks) ? r.affected_tasks : [],
    scheduleVersionId: r.schedule_version_id,
    createdAt: iso(r.created_at),
  }
}

export class PgCswOverrideAuditRepository implements CswOverrideAuditRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(entry: NewCswOverrideAudit): Promise<CswOverrideAuditRecord> {
    const r = await this.client.query(
      `INSERT INTO csw_override_audit
         (enterprise_id, plant_id, override_type, operator, reason, affected_tasks, schedule_version_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$4)
       RETURNING id, enterprise_id, plant_id, override_type, operator, reason, affected_tasks, schedule_version_id, created_at`,
      [
        entry.enterpriseId,
        entry.plantId,
        entry.overrideType,
        entry.operator,
        entry.reason,
        JSON.stringify(entry.affectedTasks),
        entry.scheduleVersionId ?? null,
      ],
    )
    return mapOverride(r.rows[0] as OverrideRow)
  }

  async list(
    filter: { plantIds: string[] | null; overrideType?: CswOverrideAuditRecord['overrideType'] } & { page?: number; pageSize?: number },
  ): Promise<{ items: CswOverrideAuditRecord[]; total: number; page: number; pageSize: number }> {
    const { page, pageSize, offset } = pageNum(filter.page, filter.pageSize)
    const where: string[] = []
    const args: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { items: [], total: 0, page, pageSize }
      args.push(filter.plantIds)
      where.push(`plant_id = ANY($${args.length})`)
    }
    if (filter.overrideType !== undefined) {
      args.push(filter.overrideType)
      where.push(`override_type = $${args.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS n FROM csw_override_audit ${clause}`, args)
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, override_type, operator, reason, affected_tasks, schedule_version_id, created_at
       FROM csw_override_audit ${clause} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
      args,
    )
    return { items: r.rows.map((row) => mapOverride(row as OverrideRow)), total: total.rows[0]?.n ?? 0, page, pageSize }
  }
}

// ---------------- csw_equipment_calibration_state ----------------

interface CalibrationRow {
  id: string
  enterprise_id: string
  plant_id: string
  equipment_id: string
  calibration_result: CswCalibrationStateRecord['calibrationResult']
  valid_until: Date | string | null
  certificate_no: string | null
  affected_slot_ids: string[]
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapCalibration(r: CalibrationRow): CswCalibrationStateRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    equipmentId: r.equipment_id,
    calibrationResult: r.calibration_result,
    validUntil: r.valid_until === null ? null : dateStr(r.valid_until),
    certificateNo: r.certificate_no,
    affectedSlotIds: Array.isArray(r.affected_slot_ids) ? r.affected_slot_ids : [],
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgCswCalibrationStateRepository implements CswCalibrationStateRepository {
  constructor(private readonly client: SqlClient) {}

  async upsert(state: {
    enterpriseId: string
    plantId: string
    equipmentId: string
    calibrationResult: 'qualified' | 'limited' | 'invalid'
    validUntil: string | null
    certificateNo?: string | null
    affectedSlotIds: string[]
    updatedBy: string | null
  }): Promise<CswCalibrationStateRecord> {
    const r = await this.client.query(
      `INSERT INTO csw_equipment_calibration_state
         (enterprise_id, plant_id, equipment_id, calibration_result, valid_until, certificate_no,
          affected_slot_ids, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)
       ON CONFLICT (equipment_id) DO UPDATE SET
         calibration_result = EXCLUDED.calibration_result,
         valid_until = EXCLUDED.valid_until,
         certificate_no = EXCLUDED.certificate_no,
         affected_slot_ids = EXCLUDED.affected_slot_ids,
         updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING id, enterprise_id, plant_id, equipment_id, calibration_result, valid_until,
         certificate_no, affected_slot_ids, created_at, created_by, updated_at, updated_by`,
      [
        state.enterpriseId,
        state.plantId,
        state.equipmentId,
        state.calibrationResult,
        state.validUntil,
        state.certificateNo ?? null,
        JSON.stringify(state.affectedSlotIds),
        state.updatedBy ?? null,
      ],
    )
    return mapCalibration(r.rows[0] as CalibrationRow)
  }

  async findByEquipment(equipmentId: string): Promise<CswCalibrationStateRecord | null> {
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, equipment_id, calibration_result,
         valid_until::text AS valid_until, certificate_no, affected_slot_ids, created_at, created_by,
         updated_at, updated_by
       FROM csw_equipment_calibration_state WHERE equipment_id = $1`,
      [equipmentId],
    )
    return r.rows[0] === undefined ? null : mapCalibration(r.rows[0] as CalibrationRow)
  }

  async list(filter: { plantIds: string[] | null }): Promise<CswCalibrationStateRecord[]> {
    const clause =
      filter.plantIds === null
        ? ''
        : filter.plantIds.length === 0
          ? 'WHERE false'
          : 'WHERE plant_id = ANY($1)'
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, equipment_id, calibration_result,
         valid_until::text AS valid_until, certificate_no, affected_slot_ids, created_at, created_by,
         updated_at, updated_by
       FROM csw_equipment_calibration_state ${clause} ORDER BY equipment_id`,
      filter.plantIds === null || filter.plantIds.length === 0 ? [] : [filter.plantIds],
    )
    return r.rows.map((row) => mapCalibration(row as CalibrationRow))
  }
}

// ---------------- csw_equipment_downtime ----------------

const DOWNTIME_COLUMNS = `id, enterprise_id, plant_id, equipment_id, kind, from_at, to_at, status,
  note, impact_slot_ids, closed_by, closed_at, created_at, created_by, updated_at, updated_by`

interface DowntimeRow {
  id: string
  enterprise_id: string
  plant_id: string
  equipment_id: string
  kind: CswDowntimeRecord['kind']
  from_at: string
  to_at: string
  status: CswDowntimeRecord['status']
  note: string | null
  impact_slot_ids: string[]
  closed_by: string | null
  closed_at: Date | string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapDowntime(r: DowntimeRow): CswDowntimeRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    equipmentId: r.equipment_id,
    kind: r.kind,
    fromAt: r.from_at,
    toAt: r.to_at,
    status: r.status,
    note: r.note,
    impactSlotIds: Array.isArray(r.impact_slot_ids) ? r.impact_slot_ids : [],
    closedBy: r.closed_by,
    closedAt: isoOrNull(r.closed_at),
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
  }
}

export class PgCswDowntimeRepository implements CswDowntimeRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(downtime: NewCswDowntimeRecord): Promise<CswDowntimeRecord> {
    const r = await this.client.query(
      `INSERT INTO csw_equipment_downtime
         (enterprise_id, plant_id, equipment_id, kind, from_at, to_at, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${DOWNTIME_COLUMNS}`,
      [
        downtime.enterpriseId,
        downtime.plantId,
        downtime.equipmentId,
        downtime.kind,
        downtime.fromAt,
        downtime.toAt,
        downtime.note ?? null,
        downtime.createdBy ?? null,
      ],
    )
    return mapDowntime(r.rows[0] as DowntimeRow)
  }

  async findById(id: string): Promise<CswDowntimeRecord | null> {
    const r = await this.client.query(`SELECT ${DOWNTIME_COLUMNS} FROM csw_equipment_downtime WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapDowntime(r.rows[0] as DowntimeRow)
  }

  async lockById(id: string): Promise<CswDowntimeRecord | null> {
    const r = await this.client.query(
      `SELECT ${DOWNTIME_COLUMNS} FROM csw_equipment_downtime WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapDowntime(r.rows[0] as DowntimeRow)
  }

  async close(id: string, patch: { closedBy: string; closedAt: string; impactSlotIds: string[] }): Promise<CswDowntimeRecord> {
    const r = await this.client.query(
      `UPDATE csw_equipment_downtime SET status = 'closed', closed_by = $2, closed_at = $3,
         impact_slot_ids = $4::jsonb, updated_at = now(), updated_by = $2
       WHERE id = $1 RETURNING ${DOWNTIME_COLUMNS}`,
      [id, patch.closedBy, patch.closedAt, JSON.stringify(patch.impactSlotIds)],
    )
    return mapDowntime(r.rows[0] as DowntimeRow)
  }

  async listActiveByEquipment(equipmentId: string): Promise<CswDowntimeRecord[]> {
    const r = await this.client.query(
      `SELECT ${DOWNTIME_COLUMNS} FROM csw_equipment_downtime WHERE equipment_id = $1 AND status = 'active'`,
      [equipmentId],
    )
    return r.rows.map((row) => mapDowntime(row as DowntimeRow))
  }

  async list(
    filter: { plantIds: string[] | null; equipmentId?: string; status?: 'active' | 'closed' } & { page?: number; pageSize?: number },
  ): Promise<{ items: CswDowntimeRecord[]; total: number; page: number; pageSize: number }> {
    const { page, pageSize, offset } = pageNum(filter.page, filter.pageSize)
    const where: string[] = []
    const args: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { items: [], total: 0, page, pageSize }
      args.push(filter.plantIds)
      where.push(`plant_id = ANY($${args.length})`)
    }
    if (filter.equipmentId !== undefined) {
      args.push(filter.equipmentId)
      where.push(`equipment_id = $${args.length}`)
    }
    if (filter.status !== undefined) {
      args.push(filter.status)
      where.push(`status = $${args.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS n FROM csw_equipment_downtime ${clause}`, args)
    const r = await this.client.query(
      `SELECT ${DOWNTIME_COLUMNS} FROM csw_equipment_downtime ${clause}
       ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
      args,
    )
    return { items: r.rows.map((row) => mapDowntime(row as DowntimeRow)), total: total.rows[0]?.n ?? 0, page, pageSize }
  }
}

// ---------------- csw_outsourcing_task / unit ----------------

const TASK_COLUMNS = `id, task_no, enterprise_id, plant_id, order_id, order_operation_id, order_no,
  operation_name, supplier_code, supplier_name, qty, uom, transit_location_id, transit_location_code,
  return_location_id, return_location_code, status, inspection_result, sent_qty, returned_qty,
  sent_by, sent_at, received_by, received_at, inspected_by, inspected_at, closed_by, closed_at,
  recall_reason, recalled_by, recalled_at, dispose_reason, disposed_by, disposed_at,
  created_at, created_by, updated_at, updated_by`

interface TaskRow {
  id: string
  task_no: string
  enterprise_id: string
  plant_id: string
  order_id: string
  order_operation_id: string
  order_no: string
  operation_name: string
  supplier_code: string | null
  supplier_name: string
  qty: string
  uom: string
  transit_location_id: string
  transit_location_code: string
  return_location_id: string | null
  return_location_code: string | null
  status: CswOutsourcingTaskRecord['status']
  inspection_result: CswOutsourcingTaskRecord['inspectionResult']
  sent_qty: string
  returned_qty: string
  sent_by: string | null
  sent_at: Date | string | null
  received_by: string | null
  received_at: Date | string | null
  inspected_by: string | null
  inspected_at: Date | string | null
  closed_by: string | null
  closed_at: Date | string | null
  recall_reason: string | null
  recalled_by: string | null
  recalled_at: Date | string | null
  dispose_reason: string | null
  disposed_by: string | null
  disposed_at: Date | string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapTask(r: TaskRow): CswOutsourcingTaskRecord {
  return {
    id: r.id,
    taskNo: r.task_no,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    orderId: r.order_id,
    orderOperationId: r.order_operation_id,
    orderNo: r.order_no,
    operationName: r.operation_name,
    supplierCode: r.supplier_code,
    supplierName: r.supplier_name,
    qty: String(r.qty),
    uom: r.uom,
    transitLocationId: r.transit_location_id,
    transitLocationCode: r.transit_location_code,
    returnLocationId: r.return_location_id,
    returnLocationCode: r.return_location_code,
    status: r.status,
    inspectionResult: r.inspection_result,
    sentQty: String(r.sent_qty),
    returnedQty: String(r.returned_qty),
    sentBy: r.sent_by,
    sentAt: isoOrNull(r.sent_at),
    receivedBy: r.received_by,
    receivedAt: isoOrNull(r.received_at),
    inspectedBy: r.inspected_by,
    inspectedAt: isoOrNull(r.inspected_at),
    closedBy: r.closed_by,
    closedAt: isoOrNull(r.closed_at),
    recallReason: r.recall_reason,
    recalledBy: r.recalled_by,
    recalledAt: isoOrNull(r.recalled_at),
    disposeReason: r.dispose_reason,
    disposedBy: r.disposed_by,
    disposedAt: isoOrNull(r.disposed_at),
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgCswOutsourcingTaskRepository implements CswOutsourcingTaskRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(task: NewCswOutsourcingTask): Promise<CswOutsourcingTaskRecord> {
    const r = await this.client.query(
      `INSERT INTO csw_outsourcing_task
         (task_no, enterprise_id, plant_id, order_id, order_operation_id, order_no, operation_name,
          supplier_code, supplier_name, qty, uom, transit_location_id, transit_location_code,
          return_location_id, return_location_code, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${TASK_COLUMNS}`,
      [
        task.taskNo,
        task.enterpriseId,
        task.plantId,
        task.orderId,
        task.orderOperationId,
        task.orderNo,
        task.operationName,
        task.supplierCode ?? null,
        task.supplierName,
        task.qty,
        task.uom,
        task.transitLocationId,
        task.transitLocationCode,
        task.returnLocationId ?? null,
        task.returnLocationCode ?? null,
        task.createdBy ?? null,
      ],
    )
    return mapTask(r.rows[0] as TaskRow)
  }

  async findById(id: string): Promise<CswOutsourcingTaskRecord | null> {
    const r = await this.client.query(`SELECT ${TASK_COLUMNS} FROM csw_outsourcing_task WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapTask(r.rows[0] as TaskRow)
  }

  async findByTaskNo(taskNo: string): Promise<CswOutsourcingTaskRecord | null> {
    const r = await this.client.query(`SELECT ${TASK_COLUMNS} FROM csw_outsourcing_task WHERE task_no = $1`, [taskNo])
    return r.rows[0] === undefined ? null : mapTask(r.rows[0] as TaskRow)
  }

  async lockById(id: string): Promise<CswOutsourcingTaskRecord | null> {
    const r = await this.client.query(
      `SELECT ${TASK_COLUMNS} FROM csw_outsourcing_task WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapTask(r.rows[0] as TaskRow)
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        CswOutsourcingTaskRecord,
        | 'status'
        | 'inspectionResult'
        | 'sentQty'
        | 'returnedQty'
        | 'sentBy'
        | 'sentAt'
        | 'receivedBy'
        | 'receivedAt'
        | 'inspectedBy'
        | 'inspectedAt'
        | 'closedBy'
        | 'closedAt'
        | 'recallReason'
        | 'recalledBy'
        | 'recalledAt'
        | 'disposeReason'
        | 'disposedBy'
        | 'disposedAt'
        | 'returnLocationId'
        | 'returnLocationCode'
        | 'updatedBy'
      >
    >,
  ): Promise<CswOutsourcingTaskRecord> {
    const sets: string[] = []
    const args: unknown[] = [id]
    const columnMap: Array<[keyof typeof patch, string]> = [
      ['status', 'status'],
      ['inspectionResult', 'inspection_result'],
      ['sentQty', 'sent_qty'],
      ['returnedQty', 'returned_qty'],
      ['sentBy', 'sent_by'],
      ['sentAt', 'sent_at'],
      ['receivedBy', 'received_by'],
      ['receivedAt', 'received_at'],
      ['inspectedBy', 'inspected_by'],
      ['inspectedAt', 'inspected_at'],
      ['closedBy', 'closed_by'],
      ['closedAt', 'closed_at'],
      ['recallReason', 'recall_reason'],
      ['recalledBy', 'recalled_by'],
      ['recalledAt', 'recalled_at'],
      ['disposeReason', 'dispose_reason'],
      ['disposedBy', 'disposed_by'],
      ['disposedAt', 'disposed_at'],
      ['returnLocationId', 'return_location_id'],
      ['returnLocationCode', 'return_location_code'],
      ['updatedBy', 'updated_by'],
    ]
    for (const [key, column] of columnMap) {
      const value = patch[key]
      if (value === undefined) continue
      args.push(value)
      sets.push(`${column} = $${args.length}`)
    }
    sets.push(`updated_at = now()`)
    const r = await this.client.query(
      `UPDATE csw_outsourcing_task SET ${sets.join(', ')} WHERE id = $1 RETURNING ${TASK_COLUMNS}`,
      args,
    )
    return mapTask(r.rows[0] as TaskRow)
  }

  async listOccupyingByOrderOperation(orderOperationId: string): Promise<CswOutsourcingTaskRecord[]> {
    const r = await this.client.query(
      `SELECT ${TASK_COLUMNS} FROM csw_outsourcing_task
       WHERE order_operation_id = $1 AND status IN ('pending_send','sent','return_received','inspecting')`,
      [orderOperationId],
    )
    return r.rows.map((row) => mapTask(row as TaskRow))
  }

  async list(
    filter: { plantIds: string[] | null; status?: CswOutsourcingTaskRecord['status']; orderOperationId?: string; taskNoLike?: string } & { page?: number; pageSize?: number },
  ): Promise<{ items: CswOutsourcingTaskRecord[]; total: number; page: number; pageSize: number }> {
    const { page, pageSize, offset } = pageNum(filter.page, filter.pageSize)
    const where: string[] = []
    const args: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { items: [], total: 0, page, pageSize }
      args.push(filter.plantIds)
      where.push(`plant_id = ANY($${args.length})`)
    }
    if (filter.status !== undefined) {
      args.push(filter.status)
      where.push(`status = $${args.length}`)
    }
    if (filter.orderOperationId !== undefined) {
      args.push(filter.orderOperationId)
      where.push(`order_operation_id = $${args.length}`)
    }
    if (filter.taskNoLike !== undefined) {
      args.push(`%${filter.taskNoLike}%`)
      where.push(`task_no LIKE $${args.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.client.query(`SELECT count(*)::int AS n FROM csw_outsourcing_task ${clause}`, args)
    const r = await this.client.query(
      `SELECT ${TASK_COLUMNS} FROM csw_outsourcing_task ${clause}
       ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
      args,
    )
    return { items: r.rows.map((row) => mapTask(row as TaskRow)), total: total.rows[0]?.n ?? 0, page, pageSize }
  }
}

interface UnitLinkRow {
  id: string
  task_id: string
  unit_id: string
  unit_no: string
  send_lot_id: string | null
  sent_qty: string
  returned_qty: string
  return_lot_id: string | null
  status: CswOutsourcingUnitRecord['status']
  created_at: Date | string
  updated_at: Date | string
}

function mapUnitLink(r: UnitLinkRow): CswOutsourcingUnitRecord {
  return {
    id: r.id,
    taskId: r.task_id,
    unitId: r.unit_id,
    unitNo: r.unit_no,
    sendLotId: r.send_lot_id,
    sentQty: String(r.sent_qty),
    returnedQty: String(r.returned_qty),
    returnLotId: r.return_lot_id,
    status: r.status,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

export class PgCswOutsourcingUnitRepository implements CswOutsourcingUnitRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(link: NewCswOutsourcingUnit): Promise<CswOutsourcingUnitRecord> {
    const r = await this.client.query(
      `INSERT INTO csw_outsourcing_unit
         (task_id, unit_id, unit_no, send_lot_id, sent_qty, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, task_id, unit_id, unit_no, send_lot_id, sent_qty, returned_qty, return_lot_id, status, created_at, updated_at`,
      [link.taskId, link.unitId, link.unitNo, link.sendLotId ?? null, link.sentQty, link.createdBy ?? null],
    )
    return mapUnitLink(r.rows[0] as UnitLinkRow)
  }

  async listByTask(taskId: string): Promise<CswOutsourcingUnitRecord[]> {
    const r = await this.client.query(
      `SELECT id, task_id, unit_id, unit_no, send_lot_id, sent_qty, returned_qty, return_lot_id, status, created_at, updated_at
       FROM csw_outsourcing_unit WHERE task_id = $1 ORDER BY created_at`,
      [taskId],
    )
    return r.rows.map((row) => mapUnitLink(row as UnitLinkRow))
  }

  async findByTaskAndUnit(taskId: string, unitId: string): Promise<CswOutsourcingUnitRecord | null> {
    const r = await this.client.query(
      `SELECT id, task_id, unit_id, unit_no, send_lot_id, sent_qty, returned_qty, return_lot_id, status, created_at, updated_at
       FROM csw_outsourcing_unit WHERE task_id = $1 AND unit_id = $2`,
      [taskId, unitId],
    )
    return r.rows[0] === undefined ? null : mapUnitLink(r.rows[0] as UnitLinkRow)
  }

  async updateReturned(
    id: string,
    patch: { returnedQty: string; returnLotId?: string | null; status?: 'sent' | 'returned' },
  ): Promise<CswOutsourcingUnitRecord> {
    const sets = ['returned_qty = $2', 'updated_at = now()']
    const args: unknown[] = [id, patch.returnedQty]
    if (patch.returnLotId !== undefined) {
      args.push(patch.returnLotId)
      sets.push(`return_lot_id = $${args.length}`)
    }
    if (patch.status !== undefined) {
      args.push(patch.status)
      sets.push(`status = $${args.length}`)
    }
    const r = await this.client.query(
      `UPDATE csw_outsourcing_unit SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, task_id, unit_id, unit_no, send_lot_id, sent_qty, returned_qty, return_lot_id, status, created_at, updated_at`,
      args,
    )
    return mapUnitLink(r.rows[0] as UnitLinkRow)
  }
}

// ---------------- csw 只读扩展查询 ----------------

export class PgCswLookups implements CswLookups {
  constructor(private readonly client: SqlClient) {}

  async listSchedulableOrders(plantId: string): Promise<CswSchedulableOrderRow[]> {
    const r = await this.client.query(
      `SELECT o.id AS order_id, o.order_no, o.plant_id, o.order_status, o.material_id,
         o.material_snapshot->>'code' AS material_code,
         o.material_snapshot->>'spec' AS product_attribute,
         to_char(o.planned_finish_at, 'YYYY-MM-DD') AS planned_finish_date,
         op.id AS order_operation_id, op.seq, op.operation_definition_id,
         od.code AS operation_code, op.operation_name, op.offline_qty, op.work_center_id,
         op.execution_status, op.uom
       FROM order_operation op
       JOIN production_order o ON o.id = op.order_id
       LEFT JOIN operation_definition od ON od.id = op.operation_definition_id
       WHERE op.plant_id = $1 AND o.order_status NOT IN ('closed', 'voided')
       ORDER BY o.order_no, op.seq`,
      [plantId],
    )
    return r.rows.map((row) => {
      const rr = row as {
        order_id: string
        order_no: string
        plant_id: string
        order_status: string
        material_id: string
        material_code: string | null
        product_attribute: string | null
        planned_finish_date: string | null
        order_operation_id: string
        seq: number
        operation_definition_id: string
        operation_code: string | null
        operation_name: string
        offline_qty: string
        work_center_id: string
        execution_status: 'pending' | 'executed'
        uom: string
      }
      return {
        orderId: rr.order_id,
        orderNo: rr.order_no,
        plantId: rr.plant_id,
        orderStatus: rr.order_status,
        materialId: rr.material_id,
        materialCode: rr.material_code ?? '',
        productAttribute: rr.product_attribute,
        plannedFinishDate: rr.planned_finish_date,
        orderOperationId: rr.order_operation_id,
        seq: rr.seq,
        operationDefinitionId: rr.operation_definition_id,
        operationCode: rr.operation_code,
        operationName: rr.operation_name,
        offlineQty: String(rr.offline_qty),
        workCenterId: rr.work_center_id,
        executionStatus: rr.execution_status,
        uom: rr.uom,
      }
    })
  }

  private slotBriefSelect(where: string, args: unknown[]): Promise<CswSlotBrief[]> {
    return this.client
      .query(
        `SELECT id, order_id, order_operation_id, operation_definition_id, equipment_id,
           to_char(production_date, 'YYYY-MM-DD') AS production_date, planned_qty
         FROM schedule_slot ${where}`,
        args,
      )
      .then((r) =>
        r.rows.map((row) => {
          const rr = row as {
            id: string
            order_id: string
            order_operation_id: string
            operation_definition_id: string
            equipment_id: string
            production_date: string
            planned_qty: string
          }
          return {
            id: rr.id,
            orderId: rr.order_id,
            orderOperationId: rr.order_operation_id,
            operationDefinitionId: rr.operation_definition_id,
            equipmentId: rr.equipment_id,
            productionDate: rr.production_date,
            plannedQty: String(rr.planned_qty),
          }
        }),
      )
  }

  async listSlotsByOrderOperation(orderOperationId: string): Promise<CswSlotBrief[]> {
    return this.slotBriefSelect('WHERE order_operation_id = $1', [orderOperationId])
  }

  async listSlotsByEquipmentAndDateRange(
    equipmentId: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<CswSlotBrief[]> {
    return this.slotBriefSelect(
      'WHERE equipment_id = $1 AND production_date >= $2::date AND production_date <= $3::date',
      [equipmentId, dateFrom, dateTo],
    )
  }

  async computeMaterialAvailability(plantId: string, materialId: string): Promise<CswMaterialAvailabilityRow> {
    // [CS-08 默认口径] 可用量＝质量（qualified）∧ 预留过滤后的余额；预留行取有效（active 未过期）。
    const r = await this.client.query(
      `SELECT
         coalesce(SUM(b.quantity), 0)::numeric(18,4) AS gross_qty,
         coalesce(SUM(b.quantity - coalesce(res.active_reserved, 0)), 0)::numeric(18,4) AS available_qty,
         coalesce(SUM(coalesce(res.active_reserved, 0)), 0)::numeric(18,4) AS reserved_qty
       FROM stock_balance b
       JOIN inventory_unit u ON u.id = b.unit_id
       LEFT JOIN LATERAL (
         SELECT coalesce(SUM(r.quantity), 0) AS active_reserved
         FROM reservation r
         WHERE r.unit_id = u.id AND r.status = 'active' AND r.valid_until > now()
       ) res ON true
       WHERE u.plant_id = $1 AND u.material_id = $2 AND b.status = 'active' AND b.quality_status = 'qualified'`,
      [plantId, materialId],
    )
    const row = r.rows[0] as { gross_qty: string; available_qty: string; reserved_qty: string }
    return {
      materialId,
      availableQty: String(row?.available_qty ?? '0'),
      reservedQty: String(row?.reserved_qty ?? '0'),
    }
  }

  async findStorageLocation(locationId: string): Promise<CswStorageLocationBrief | null> {
    const r = await this.client.query(
      `SELECT id, code, plant_id FROM storage_location WHERE id = $1 AND status = 'active'`,
      [locationId],
    )
    const row = r.rows[0] as { id: string; code: string; plant_id: string } | undefined
    return row === undefined ? null : { id: row.id, code: row.code, plantId: row.plant_id }
  }
}

/** csw 仓储束（组合根与测试自组装共用）。 */
export function createPgCswRepositories(client: SqlClient): CswRepositories {
  return {
    freezes: new PgCswFreezeRepository(client),
    matrices: new PgCswChangeoverMatrixRepository(client),
    versions: new PgCswScheduleVersionRepository(client),
    versionItems: new PgCswScheduleVersionItemRepository(client),
    overrides: new PgCswOverrideAuditRepository(client),
    calibration: new PgCswCalibrationStateRepository(client),
    downtimes: new PgCswDowntimeRepository(client),
    outsourcingTasks: new PgCswOutsourcingTaskRepository(client),
    outsourcingUnits: new PgCswOutsourcingUnitRepository(client),
    lookups: new PgCswLookups(client),
  }
}
