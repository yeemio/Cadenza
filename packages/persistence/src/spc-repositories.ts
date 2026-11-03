// 跨包类型导入（type-only，编译期擦除）：指向 application 已构建的 dist（构建顺序由 workspace
// 拓扑保证：persistence 依赖 application）。spc 端口尚未并入 @cadenza/application 包名入口
// （application/src/index.ts 为共享文件不改动），故走 dist 相对；L0 整合步把端口导出并入
// application index、本文件导出并入 persistence index 后改包名导入（同 shipping 整合前先例）。
// [L0-整合标记]
import type {
  InspectionOrderFact,
  InventoryUnitFact,
  MaterialLotFact,
  NewSpcCalibrationRecord,
  NewSpcChangeAdjustment,
  NewSpcChangeImpact,
  NewSpcControlItem,
  NewSpcControlLimit,
  NewSpcGauge,
  NewSpcMiscalibrationAction,
  NewSpcOocTask,
  NewSpcPointJudgement,
  NewSpcProcessChange,
  NewSpcRuleSet,
  NewSpcSample,
  NewSpcToolAdjustment,
  NewSpcToolConfig,
  NewSpcToolLedger,
  NewSpcToolUsage,
  OrderOperationFact,
  ProcessSpecRevisionFact,
  ProductionOrderFact,
  QualityDispositionFact,
  SpcCalibrationRecord,
  SpcCalibrationRepository,
  SpcChangeAdjustmentRecord,
  SpcChangeAdjustmentRepository,
  SpcChangeImpactRecord,
  SpcChangeImpactRepository,
  SpcControlItemRecord,
  SpcControlItemRepository,
  SpcControlLimitRecord,
  SpcControlLimitRepository,
  SpcCrossDomainReader,
  SpcGaugeRecord,
  SpcGaugeRepository,
  SpcMiscalibrationActionRecord,
  SpcMiscalibrationActionRepository,
  SpcOocTaskRecord,
  SpcOocTaskRepository,
  SpcPointJudgementRecord,
  SpcPointJudgementRepository,
  SpcProcessChangeRecord,
  SpcProcessChangeRepository,
  SpcReceiptLookup,
  SpcRepositories,
  SpcRuleSetRecord,
  SpcRuleSetRepository,
  SpcSampleRecord,
  SpcSampleRepository,
  SpcToolAdjustmentRecord,
  SpcToolAdjustmentRepository,
  SpcToolConfigRecord,
  SpcToolConfigRepository,
  SpcToolLedgerRecord,
  SpcToolLedgerRepository,
  SpcToolUsageRecord,
  SpcToolUsageRepository,
  TestResultFact,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

/**
 * spc 域仓储的 PostgreSQL 实现（implements application 端口；0019 spc 表列一一对应）。
 * 行锁方法（lockById）在命令事务内 SELECT ... FOR UPDATE；
 * 校准记录/判定/调整指令/消耗行/配置版本/失准处置为 append-only（触发器守卫拒改拒删）。
 * 跨域读取（parameter_spec_revision、production_order、order_operation、production_report、
 * schedule_slot、quality 检验三表、inventory 两表）为只读投影，不写任何共享域表（PE-13）。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

/** 数值列统一以字符串读出（pg numeric → string；DecimalString 口径）。 */
function num(value: unknown): string {
  return value === null || value === undefined ? '0' : String(value)
}

// ---------------- 命令回执查询 ----------------

class PgSpcReceiptLookup implements SpcReceiptLookup {
  constructor(private readonly client: SqlClient) {}

  async findIdByKey(enterpriseId: string, commandType: string, operationId: string): Promise<string | null> {
    const r = await this.client.query(
      `SELECT id FROM command_receipt
       WHERE enterprise_id = $1 AND command_type = $2 AND operation_id = $3`,
      [enterpriseId, commandType, operationId],
    )
    return r.rows[0]?.id ?? null
  }
}

// ---------------- spc_process_change ----------------

const CHANGE_COLUMNS = `id, change_no, status, old_spec_revision_id, new_spec_revision_id, approver,
  effective_at, operation_mutations, published_at, published_by, command_receipt_id, plant_id,
  enterprise_id, business_time, created_at, created_by, updated_at, updated_by`

interface ChangeRow {
  id: string
  change_no: string
  status: SpcProcessChangeRecord['status']
  old_spec_revision_id: string
  new_spec_revision_id: string
  approver: string
  effective_at: Date | string
  operation_mutations: unknown
  published_at: Date | string | null
  published_by: string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapChange(r: ChangeRow): SpcProcessChangeRecord {
  return {
    id: r.id,
    changeNo: r.change_no,
    status: r.status,
    oldSpecRevisionId: r.old_spec_revision_id,
    newSpecRevisionId: r.new_spec_revision_id,
    approver: r.approver,
    effectiveAt: iso(r.effective_at),
    operationMutations: r.operation_mutations,
    publishedAt: isoOrNull(r.published_at),
    publishedBy: r.published_by,
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

class PgSpcProcessChangeRepository implements SpcProcessChangeRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(change: NewSpcProcessChange): Promise<SpcProcessChangeRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_process_change
         (change_no, old_spec_revision_id, new_spec_revision_id, approver, effective_at,
          operation_mutations, command_receipt_id, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) RETURNING ${CHANGE_COLUMNS}`,
      [
        change.changeNo,
        change.oldSpecRevisionId,
        change.newSpecRevisionId,
        change.approver,
        change.effectiveAt,
        JSON.stringify(change.operationMutations ?? []),
        change.commandReceiptId ?? null,
        change.plantId,
        change.enterpriseId,
        change.createdBy ?? null,
      ],
    )
    return mapChange(r.rows[0] as ChangeRow)
  }

  async findById(id: string): Promise<SpcProcessChangeRecord | null> {
    const r = await this.client.query(`SELECT ${CHANGE_COLUMNS} FROM spc_process_change WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapChange(r.rows[0] as ChangeRow)
  }

  async lockById(id: string): Promise<SpcProcessChangeRecord | null> {
    const r = await this.client.query(
      `SELECT ${CHANGE_COLUMNS} FROM spc_process_change WHERE id = $1 FOR UPDATE`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapChange(r.rows[0] as ChangeRow)
  }

  async findByNo(changeNo: string): Promise<SpcProcessChangeRecord | null> {
    const r = await this.client.query(`SELECT ${CHANGE_COLUMNS} FROM spc_process_change WHERE change_no = $1`, [changeNo])
    return r.rows[0] === undefined ? null : mapChange(r.rows[0] as ChangeRow)
  }

  async markPublished(
    id: string,
    patch: { publishedAt: string; publishedBy: string },
    actor: string | null,
  ): Promise<SpcProcessChangeRecord | null> {
    const r = await this.client.query(
      `UPDATE spc_process_change
       SET status = 'published', published_at = $2, published_by = $3, updated_at = now(), updated_by = $4
       WHERE id = $1 RETURNING ${CHANGE_COLUMNS}`,
      [id, patch.publishedAt, patch.publishedBy, actor],
    )
    return r.rows[0] === undefined ? null : mapChange(r.rows[0] as ChangeRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: SpcProcessChangeRecord[]; total: number }> {
    const params: unknown[] = [filter.plantIds]
    let where = `WHERE ($1::uuid[] IS NULL OR plant_id = ANY($1))`
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where += ` AND plant_id = $${params.length}`
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      params.push(filter.statuses)
      where += ` AND status = ANY($${params.length}::text[])`
    }
    const total = await this.client.query(
      `SELECT count(*) AS count FROM spc_process_change ${where}`,
      params,
    )
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${CHANGE_COLUMNS} FROM spc_process_change ${where}
       ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapChange(row as ChangeRow)), total: Number(total.rows[0]!.count) }
  }
}

// ---------------- spc_change_impact ----------------

const IMPACT_COLUMNS = `id, change_id, category, production_order_id, order_no, order_status,
  order_operation_id, operation_seq, operation_name, scheduled, disposition, follows_version,
  planned_qty, recomputed_planned_qty, disposition_by, disposition_at, enterprise_id,
  created_at, created_by, updated_at, updated_by`

interface ImpactRow {
  id: string
  change_id: string
  category: SpcChangeImpactRecord['category']
  production_order_id: string
  order_no: string
  order_status: string
  order_operation_id: string
  operation_seq: number
  operation_name: string
  scheduled: boolean
  disposition: SpcChangeImpactRecord['disposition']
  follows_version: 'old' | 'new' | null
  planned_qty: string | number
  recomputed_planned_qty: string | number | null
  disposition_by: string | null
  disposition_at: Date | string | null
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapImpact(r: ImpactRow): SpcChangeImpactRecord {
  return {
    id: r.id,
    changeId: r.change_id,
    category: r.category,
    productionOrderId: r.production_order_id,
    orderNo: r.order_no,
    orderStatus: r.order_status,
    orderOperationId: r.order_operation_id,
    operationSeq: r.operation_seq,
    operationName: r.operation_name,
    scheduled: r.scheduled,
    disposition: r.disposition,
    followsVersion: r.follows_version,
    plannedQty: num(r.planned_qty),
    recomputedPlannedQty: r.recomputed_planned_qty === null ? null : num(r.recomputed_planned_qty),
    dispositionBy: r.disposition_by,
    dispositionAt: isoOrNull(r.disposition_at),
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

class PgSpcChangeImpactRepository implements SpcChangeImpactRepository {
  constructor(private readonly client: SqlClient) {}

  async insertMany(impacts: NewSpcChangeImpact[]): Promise<SpcChangeImpactRecord[]> {
    const records: SpcChangeImpactRecord[] = []
    for (const i of impacts) {
      const r = await this.client.query(
        `INSERT INTO spc_change_impact
           (change_id, category, production_order_id, order_no, order_status, order_operation_id,
            operation_seq, operation_name, scheduled, follows_version, planned_qty,
            recomputed_planned_qty, enterprise_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${IMPACT_COLUMNS}`,
        [
          i.changeId,
          i.category,
          i.productionOrderId,
          i.orderNo,
          i.orderStatus,
          i.orderOperationId,
          i.operationSeq,
          i.operationName,
          i.scheduled,
          i.followsVersion,
          i.plannedQty,
          i.recomputedPlannedQty ?? null,
          i.enterpriseId,
          i.createdBy ?? null,
        ],
      )
      records.push(mapImpact(r.rows[0] as ImpactRow))
    }
    return records
  }

  async listByChange(changeId: string): Promise<SpcChangeImpactRecord[]> {
    const r = await this.client.query(
      `SELECT ${IMPACT_COLUMNS} FROM spc_change_impact WHERE change_id = $1 ORDER BY order_no, operation_seq`,
      [changeId],
    )
    return r.rows.map((row) => mapImpact(row as ImpactRow))
  }

  async findById(id: string): Promise<SpcChangeImpactRecord | null> {
    const r = await this.client.query(`SELECT ${IMPACT_COLUMNS} FROM spc_change_impact WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapImpact(r.rows[0] as ImpactRow)
  }

  async setDisposition(
    id: string,
    patch: {
      disposition: 'continue_old' | 'switch_new' | 'isolation_review'
      followsVersion: 'old' | 'new'
      dispositionBy: string
      dispositionAt: string
    },
    actor: string | null,
  ): Promise<SpcChangeImpactRecord | null> {
    const r = await this.client.query(
      `UPDATE spc_change_impact
       SET disposition = $2, follows_version = $3, disposition_by = $4, disposition_at = $5,
           updated_at = now(), updated_by = $6
       WHERE id = $1 RETURNING ${IMPACT_COLUMNS}`,
      [id, patch.disposition, patch.followsVersion, patch.dispositionBy, patch.dispositionAt, actor],
    )
    return r.rows[0] === undefined ? null : mapImpact(r.rows[0] as ImpactRow)
  }

  async setRecomputed(id: string, recomputedPlannedQty: string, actor: string | null): Promise<SpcChangeImpactRecord | null> {
    const r = await this.client.query(
      `UPDATE spc_change_impact
       SET recomputed_planned_qty = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${IMPACT_COLUMNS}`,
      [id, recomputedPlannedQty, actor],
    )
    return r.rows[0] === undefined ? null : mapImpact(r.rows[0] as ImpactRow)
  }
}

// ---------------- spc_change_adjustment ----------------

const ADJUSTMENT_COLUMNS = `id, change_id, order_operation_id, order_no, operation_seq,
  old_planned_qty, new_planned_qty, basis, created_at, created_by`

interface AdjustmentRow {
  id: string
  change_id: string
  order_operation_id: string
  order_no: string
  operation_seq: number
  old_planned_qty: string | number
  new_planned_qty: string | number
  basis: unknown
  created_at: Date | string
  created_by: string | null
}

function mapAdjustment(r: AdjustmentRow): SpcChangeAdjustmentRecord {
  return {
    id: r.id,
    changeId: r.change_id,
    orderOperationId: r.order_operation_id,
    orderNo: r.order_no,
    operationSeq: r.operation_seq,
    oldPlannedQty: num(r.old_planned_qty),
    newPlannedQty: num(r.new_planned_qty),
    basis: r.basis,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

class PgSpcChangeAdjustmentRepository implements SpcChangeAdjustmentRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(adjustment: NewSpcChangeAdjustment): Promise<SpcChangeAdjustmentRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_change_adjustment
         (change_id, order_operation_id, order_no, operation_seq, old_planned_qty, new_planned_qty,
          basis, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING ${ADJUSTMENT_COLUMNS}`,
      [
        adjustment.changeId,
        adjustment.orderOperationId,
        adjustment.orderNo,
        adjustment.operationSeq,
        adjustment.oldPlannedQty,
        adjustment.newPlannedQty,
        JSON.stringify(adjustment.basis ?? {}),
        adjustment.enterpriseId,
        adjustment.createdBy ?? null,
      ],
    )
    return mapAdjustment(r.rows[0] as AdjustmentRow)
  }

  async listByChange(changeId: string): Promise<SpcChangeAdjustmentRecord[]> {
    const r = await this.client.query(
      `SELECT ${ADJUSTMENT_COLUMNS} FROM spc_change_adjustment WHERE change_id = $1 ORDER BY order_no, operation_seq`,
      [changeId],
    )
    return r.rows.map((row) => mapAdjustment(row as AdjustmentRow))
  }
}

// ---------------- spc_rule_set ----------------

const RULE_SET_COLUMNS = `id, name, version, chart_type, criteria, status, is_default,
  published_at, published_by, plant_id, enterprise_id, created_at, created_by, updated_at, updated_by`

interface RuleSetRow {
  id: string
  name: string
  version: number
  chart_type: SpcRuleSetRecord['chartType']
  criteria: unknown
  status: SpcRuleSetRecord['status']
  is_default: boolean
  published_at: Date | string | null
  published_by: string | null
  plant_id: string
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapRuleSet(r: RuleSetRow): SpcRuleSetRecord {
  const criteria = Array.isArray(r.criteria) ? (r.criteria as unknown[]).filter((v): v is string => typeof v === 'string') : []
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    chartType: r.chart_type,
    criteria,
    status: r.status,
    isDefault: r.is_default,
    publishedAt: isoOrNull(r.published_at),
    publishedBy: r.published_by,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

class PgSpcRuleSetRepository implements SpcRuleSetRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(ruleSet: NewSpcRuleSet): Promise<SpcRuleSetRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_rule_set
         (name, version, chart_type, criteria, is_default, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING ${RULE_SET_COLUMNS}`,
      [
        ruleSet.name,
        ruleSet.version,
        ruleSet.chartType,
        JSON.stringify(ruleSet.criteria),
        ruleSet.isDefault ?? false,
        ruleSet.plantId,
        ruleSet.enterpriseId,
        ruleSet.createdBy ?? null,
      ],
    )
    return mapRuleSet(r.rows[0] as RuleSetRow)
  }

  private async byId(id: string, lock: boolean): Promise<SpcRuleSetRecord | null> {
    const r = await this.client.query(
      `SELECT ${RULE_SET_COLUMNS} FROM spc_rule_set WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapRuleSet(r.rows[0] as RuleSetRow)
  }

  async findById(id: string): Promise<SpcRuleSetRecord> {
    return (await this.findByIdOrNull(id))!
  }

  async findByIdOrNull(id: string): Promise<SpcRuleSetRecord | null> {
    return this.byId(id, false)
  }

  async findByPlantNameVersion(plantId: string, name: string, version: number): Promise<SpcRuleSetRecord | null> {
    const r = await this.client.query(
      `SELECT ${RULE_SET_COLUMNS} FROM spc_rule_set WHERE plant_id = $1 AND name = $2 AND version = $3`,
      [plantId, name, version],
    )
    return r.rows[0] === undefined ? null : mapRuleSet(r.rows[0] as RuleSetRow)
  }

  async findLatestPublished(plantId: string, name?: string): Promise<SpcRuleSetRecord | null> {
    const r = await this.client.query(
      `SELECT ${RULE_SET_COLUMNS} FROM spc_rule_set
       WHERE plant_id = $1 AND status = 'published'${name === undefined ? '' : ' AND name = $2'}
       ORDER BY version DESC LIMIT 1`,
      name === undefined ? [plantId] : [plantId, name],
    )
    return r.rows[0] === undefined ? null : mapRuleSet(r.rows[0] as RuleSetRow)
  }

  async publish(
    id: string,
    patch: { publishedAt: string; publishedBy: string },
    actor: string | null,
  ): Promise<SpcRuleSetRecord | null> {
    const r = await this.client.query(
      `UPDATE spc_rule_set
       SET status = 'published', published_at = $2, published_by = $3, updated_at = now(), updated_by = $4
       WHERE id = $1 RETURNING ${RULE_SET_COLUMNS}`,
      [id, patch.publishedAt, patch.publishedBy, actor],
    )
    return r.rows[0] === undefined ? null : mapRuleSet(r.rows[0] as RuleSetRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: SpcRuleSetRecord[]; total: number }> {
    const params: unknown[] = [filter.plantIds]
    let where = `WHERE ($1::uuid[] IS NULL OR plant_id = ANY($1))`
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where += ` AND plant_id = $${params.length}`
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      params.push(filter.statuses)
      where += ` AND status = ANY($${params.length}::text[])`
    }
    const total = await this.client.query(`SELECT count(*) AS count FROM spc_rule_set ${where}`, params)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${RULE_SET_COLUMNS} FROM spc_rule_set ${where}
       ORDER BY name, version DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapRuleSet(row as RuleSetRow)), total: Number(total.rows[0]!.count) }
  }
}

// ---------------- spc_control_item ----------------

const CONTROL_ITEM_COLUMNS = `id, spec_code, spec_version, item_no, item_name, point_ref,
  rule_set_id, status, plant_id, enterprise_id, created_at, created_by, updated_at, updated_by`

interface ControlItemRow {
  id: string
  spec_code: string
  spec_version: number
  item_no: string
  item_name: string | null
  point_ref: string | null
  rule_set_id: string | null
  status: SpcControlItemRecord['status']
  plant_id: string
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapControlItem(r: ControlItemRow): SpcControlItemRecord {
  return {
    id: r.id,
    specCode: r.spec_code,
    specVersion: r.spec_version,
    itemNo: r.item_no,
    itemName: r.item_name,
    pointRef: r.point_ref,
    ruleSetId: r.rule_set_id,
    status: r.status,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

class PgSpcControlItemRepository implements SpcControlItemRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(item: NewSpcControlItem): Promise<SpcControlItemRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_control_item
         (spec_code, spec_version, item_no, item_name, point_ref, rule_set_id, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${CONTROL_ITEM_COLUMNS}`,
      [
        item.specCode,
        item.specVersion,
        item.itemNo,
        item.itemName ?? null,
        item.pointRef ?? null,
        item.ruleSetId ?? null,
        item.plantId,
        item.enterpriseId,
        item.createdBy ?? null,
      ],
    )
    return mapControlItem(r.rows[0] as ControlItemRow)
  }

  async findById(id: string): Promise<SpcControlItemRecord | null> {
    const r = await this.client.query(`SELECT ${CONTROL_ITEM_COLUMNS} FROM spc_control_item WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapControlItem(r.rows[0] as ControlItemRow)
  }

  async findBySpecItem(specCode: string, specVersion: number, itemNo: string): Promise<SpcControlItemRecord | null> {
    const r = await this.client.query(
      `SELECT ${CONTROL_ITEM_COLUMNS} FROM spc_control_item
       WHERE spec_code = $1 AND spec_version = $2 AND item_no = $3`,
      [specCode, specVersion, itemNo],
    )
    return r.rows[0] === undefined ? null : mapControlItem(r.rows[0] as ControlItemRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    page: number
    pageSize: number
  }): Promise<{ items: SpcControlItemRecord[]; total: number }> {
    const params: unknown[] = [filter.plantIds]
    let where = `WHERE ($1::uuid[] IS NULL OR plant_id = ANY($1))`
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where += ` AND plant_id = $${params.length}`
    }
    const total = await this.client.query(`SELECT count(*) AS count FROM spc_control_item ${where}`, params)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${CONTROL_ITEM_COLUMNS} FROM spc_control_item ${where}
       ORDER BY spec_code, spec_version, item_no LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapControlItem(row as ControlItemRow)), total: Number(total.rows[0]!.count) }
  }
}

// ---------------- spc_control_limit_version ----------------

const LIMIT_COLUMNS = `id, control_item_id, version, method, baseline_group_count, cl, ucl, lcl,
  status, trigger_kind, trigger_ref, rule_set_id, created_at, created_by`

interface LimitRow {
  id: string
  control_item_id: string
  version: number
  method: SpcControlLimitRecord['method']
  baseline_group_count: number
  cl: string | null
  ucl: string | null
  lcl: string | null
  status: SpcControlLimitRecord['status']
  trigger_kind: SpcControlLimitRecord['triggerKind']
  trigger_ref: string | null
  rule_set_id: string | null
  created_at: Date | string
  created_by: string | null
}

function mapLimit(r: LimitRow): SpcControlLimitRecord {
  return {
    id: r.id,
    controlItemId: r.control_item_id,
    version: r.version,
    method: r.method,
    baselineGroupCount: r.baseline_group_count,
    cl: r.cl,
    ucl: r.ucl,
    lcl: r.lcl,
    status: r.status,
    triggerKind: r.trigger_kind,
    triggerRef: r.trigger_ref,
    ruleSetId: r.rule_set_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

class PgSpcControlLimitRepository implements SpcControlLimitRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(limit: NewSpcControlLimit): Promise<SpcControlLimitRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_control_limit_version
         (control_item_id, version, method, baseline_group_count, cl, ucl, lcl, status,
          trigger_kind, trigger_ref, rule_set_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${LIMIT_COLUMNS}`,
      [
        limit.controlItemId,
        limit.version,
        limit.method,
        limit.baselineGroupCount,
        limit.cl ?? null,
        limit.ucl ?? null,
        limit.lcl ?? null,
        limit.status,
        limit.triggerKind,
        limit.triggerRef ?? null,
        limit.ruleSetId ?? null,
        limit.enterpriseId,
        limit.createdBy ?? null,
      ],
    )
    return mapLimit(r.rows[0] as LimitRow)
  }

  async listByItem(controlItemId: string): Promise<SpcControlLimitRecord[]> {
    const r = await this.client.query(
      `SELECT ${LIMIT_COLUMNS} FROM spc_control_limit_version WHERE control_item_id = $1 ORDER BY version`,
      [controlItemId],
    )
    return r.rows.map((row) => mapLimit(row as LimitRow))
  }

  async findLatest(controlItemId: string): Promise<SpcControlLimitRecord | null> {
    const r = await this.client.query(
      `SELECT ${LIMIT_COLUMNS} FROM spc_control_limit_version
       WHERE control_item_id = $1 ORDER BY version DESC LIMIT 1`,
      [controlItemId],
    )
    return r.rows[0] === undefined ? null : mapLimit(r.rows[0] as LimitRow)
  }

  async findLatestActive(controlItemId: string): Promise<SpcControlLimitRecord | null> {
    const r = await this.client.query(
      `SELECT ${LIMIT_COLUMNS} FROM spc_control_limit_version
       WHERE control_item_id = $1 AND status = 'active' ORDER BY version DESC LIMIT 1`,
      [controlItemId],
    )
    return r.rows[0] === undefined ? null : mapLimit(r.rows[0] as LimitRow)
  }

  async nextVersion(controlItemId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT max(version) AS max FROM spc_control_limit_version WHERE control_item_id = $1`,
      [controlItemId],
    )
    return (r.rows[0]?.max ?? 0) + 1
  }
}

// ---------------- spc_sample ----------------

const SAMPLE_COLUMNS = `id, control_item_id, source, test_result_id, measured_value, sampled_at,
  production_order_id, order_operation_id, operation_seq, equipment_id, equipment_code, shift_date,
  gauge_id, calibration_status, admission, reject_reason, command_receipt_id, plant_id,
  enterprise_id, business_time, created_at, created_by`

interface SampleRow {
  id: string
  control_item_id: string
  source: SpcSampleRecord['source']
  test_result_id: string | null
  measured_value: string | number
  sampled_at: Date | string
  production_order_id: string | null
  order_operation_id: string | null
  operation_seq: number | null
  equipment_id: string | null
  equipment_code: string | null
  shift_date: Date | string | null
  gauge_id: string | null
  calibration_status: SpcSampleRecord['calibrationStatus']
  admission: SpcSampleRecord['admission']
  reject_reason: string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapSample(r: SampleRow): SpcSampleRecord {
  return {
    id: r.id,
    controlItemId: r.control_item_id,
    source: r.source,
    testResultId: r.test_result_id,
    measuredValue: num(r.measured_value),
    sampledAt: iso(r.sampled_at),
    productionOrderId: r.production_order_id,
    orderOperationId: r.order_operation_id,
    operationSeq: r.operation_seq,
    equipmentId: r.equipment_id,
    equipmentCode: r.equipment_code,
    shiftDate: r.shift_date === null ? null : iso(r.shift_date).slice(0, 10),
    gaugeId: r.gauge_id,
    calibrationStatus: r.calibration_status,
    admission: r.admission,
    rejectReason: r.reject_reason,
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

class PgSpcSampleRepository implements SpcSampleRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(sample: NewSpcSample): Promise<SpcSampleRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_sample
         (control_item_id, source, test_result_id, measured_value, sampled_at, production_order_id,
          order_operation_id, operation_seq, equipment_id, equipment_code, shift_date, gauge_id,
          calibration_status, admission, reject_reason, command_receipt_id, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING ${SAMPLE_COLUMNS}`,
      [
        sample.controlItemId,
        sample.source,
        sample.testResultId ?? null,
        sample.measuredValue,
        sample.sampledAt,
        sample.productionOrderId ?? null,
        sample.orderOperationId ?? null,
        sample.operationSeq ?? null,
        sample.equipmentId ?? null,
        sample.equipmentCode ?? null,
        sample.shiftDate ?? null,
        sample.gaugeId ?? null,
        sample.calibrationStatus ?? null,
        sample.admission,
        sample.rejectReason ?? null,
        sample.commandReceiptId ?? null,
        sample.plantId,
        sample.enterpriseId,
        sample.createdBy ?? null,
      ],
    )
    return mapSample(r.rows[0] as SampleRow)
  }

  async findById(id: string): Promise<SpcSampleRecord | null> {
    const r = await this.client.query(`SELECT ${SAMPLE_COLUMNS} FROM spc_sample WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapSample(r.rows[0] as SampleRow)
  }

  async listAdmittedByItem(controlItemId: string): Promise<SpcSampleRecord[]> {
    const r = await this.client.query(
      `SELECT ${SAMPLE_COLUMNS} FROM spc_sample
       WHERE control_item_id = $1 AND admission = 'admitted' ORDER BY sampled_at, created_at`,
      [controlItemId],
    )
    return r.rows.map((row) => mapSample(row as SampleRow))
  }

  async listByGauge(gaugeId: string): Promise<SpcSampleRecord[]> {
    const r = await this.client.query(
      `SELECT ${SAMPLE_COLUMNS} FROM spc_sample WHERE gauge_id = $1 ORDER BY sampled_at, created_at`,
      [gaugeId],
    )
    return r.rows.map((row) => mapSample(row as SampleRow))
  }
}

// ---------------- spc_point_judgement ----------------

const JUDGEMENT_COLUMNS = `id, sample_id, control_item_id, point_no, verdict, violated_codes,
  rule_set_id, rule_set_version, control_limit_id, control_limit_version, judged_at, enterprise_id,
  created_at, created_by`

interface JudgementRow {
  id: string
  sample_id: string
  control_item_id: string
  point_no: number
  verdict: SpcPointJudgementRecord['verdict']
  violated_codes: unknown
  rule_set_id: string | null
  rule_set_version: number | null
  control_limit_id: string | null
  control_limit_version: number | null
  judged_at: Date | string
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
}

function mapJudgement(r: JudgementRow): SpcPointJudgementRecord {
  const codes = Array.isArray(r.violated_codes)
    ? (r.violated_codes as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  return {
    id: r.id,
    sampleId: r.sample_id,
    controlItemId: r.control_item_id,
    pointNo: r.point_no,
    verdict: r.verdict,
    violatedCodes: codes,
    ruleSetId: r.rule_set_id,
    ruleSetVersion: r.rule_set_version,
    controlLimitId: r.control_limit_id,
    controlLimitVersion: r.control_limit_version,
    judgedAt: iso(r.judged_at),
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

class PgSpcPointJudgementRepository implements SpcPointJudgementRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(judgement: NewSpcPointJudgement): Promise<SpcPointJudgementRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_point_judgement
         (sample_id, control_item_id, point_no, verdict, violated_codes, rule_set_id,
          rule_set_version, control_limit_id, control_limit_version, judged_at, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12) RETURNING ${JUDGEMENT_COLUMNS}`,
      [
        judgement.sampleId,
        judgement.controlItemId,
        judgement.pointNo,
        judgement.verdict,
        JSON.stringify(judgement.violatedCodes),
        judgement.ruleSetId ?? null,
        judgement.ruleSetVersion ?? null,
        judgement.controlLimitId ?? null,
        judgement.controlLimitVersion ?? null,
        judgement.judgedAt,
        judgement.enterpriseId,
        judgement.createdBy ?? null,
      ],
    )
    return mapJudgement(r.rows[0] as JudgementRow)
  }

  async findBySample(sampleId: string): Promise<SpcPointJudgementRecord | null> {
    const r = await this.client.query(`SELECT ${JUDGEMENT_COLUMNS} FROM spc_point_judgement WHERE sample_id = $1`, [sampleId])
    return r.rows[0] === undefined ? null : mapJudgement(r.rows[0] as JudgementRow)
  }

  async listByItem(controlItemId: string): Promise<SpcPointJudgementRecord[]> {
    const r = await this.client.query(
      `SELECT ${JUDGEMENT_COLUMNS} FROM spc_point_judgement WHERE control_item_id = $1 ORDER BY point_no`,
      [controlItemId],
    )
    return r.rows.map((row) => mapJudgement(row as JudgementRow))
  }

  async countInControlAfter(controlItemId: string, afterIso: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*) AS count FROM spc_point_judgement
       WHERE control_item_id = $1 AND verdict = 'in_control' AND judged_at > $2`,
      [controlItemId, afterIso],
    )
    return Number(r.rows[0]!.count)
  }
}

// ---------------- spc_ooc_task ----------------

const OOC_COLUMNS = `id, task_no, status, control_item_id, sample_id, notify_roles,
  quality_doubt_hint, cause_category, corrective_action, isolation_suggestion, raised_at, raised_by,
  disposed_by, disposed_at, recontrol_confirmed_by, recontrol_confirmed_at, command_receipt_id,
  plant_id, enterprise_id, business_time, created_at, created_by`

interface OocRow {
  id: string
  task_no: string
  status: SpcOocTaskRecord['status']
  control_item_id: string
  sample_id: string
  notify_roles: unknown
  quality_doubt_hint: boolean
  cause_category: string | null
  corrective_action: string | null
  isolation_suggestion: string | null
  raised_at: Date | string
  raised_by: string
  disposed_by: string | null
  disposed_at: Date | string | null
  recontrol_confirmed_by: string | null
  recontrol_confirmed_at: Date | string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapOoc(r: OocRow): SpcOocTaskRecord {
  const roles = Array.isArray(r.notify_roles)
    ? (r.notify_roles as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  return {
    id: r.id,
    taskNo: r.task_no,
    status: r.status,
    controlItemId: r.control_item_id,
    sampleId: r.sample_id,
    notifyRoles: roles,
    qualityDoubtHint: r.quality_doubt_hint,
    causeCategory: r.cause_category,
    correctiveAction: r.corrective_action,
    isolationSuggestion: r.isolation_suggestion,
    raisedAt: iso(r.raised_at),
    raisedBy: r.raised_by,
    disposedBy: r.disposed_by,
    disposedAt: isoOrNull(r.disposed_at),
    recontrolConfirmedBy: r.recontrol_confirmed_by,
    recontrolConfirmedAt: isoOrNull(r.recontrol_confirmed_at),
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

class PgSpcOocTaskRepository implements SpcOocTaskRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(task: NewSpcOocTask): Promise<SpcOocTaskRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_ooc_task
         (task_no, control_item_id, sample_id, notify_roles, quality_doubt_hint, raised_at, raised_by,
          command_receipt_id, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11) RETURNING ${OOC_COLUMNS}`,
      [
        task.taskNo,
        task.controlItemId,
        task.sampleId,
        JSON.stringify(task.notifyRoles),
        task.qualityDoubtHint,
        task.raisedAt,
        task.raisedBy,
        task.commandReceiptId ?? null,
        task.plantId,
        task.enterpriseId,
        task.createdBy ?? null,
      ],
    )
    return mapOoc(r.rows[0] as OocRow)
  }

  async findById(id: string): Promise<SpcOocTaskRecord | null> {
    const r = await this.client.query(`SELECT ${OOC_COLUMNS} FROM spc_ooc_task WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapOoc(r.rows[0] as OocRow)
  }

  async findBySample(sampleId: string): Promise<SpcOocTaskRecord | null> {
    const r = await this.client.query(`SELECT ${OOC_COLUMNS} FROM spc_ooc_task WHERE sample_id = $1`, [sampleId])
    return r.rows[0] === undefined ? null : mapOoc(r.rows[0] as OocRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: SpcOocTaskRecord[]; total: number }> {
    const params: unknown[] = [filter.plantIds]
    let where = `WHERE ($1::uuid[] IS NULL OR plant_id = ANY($1))`
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where += ` AND plant_id = $${params.length}`
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      params.push(filter.statuses)
      where += ` AND status = ANY($${params.length}::text[])`
    }
    const total = await this.client.query(`SELECT count(*) AS count FROM spc_ooc_task ${where}`, params)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${OOC_COLUMNS} FROM spc_ooc_task ${where}
       ORDER BY raised_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapOoc(row as OocRow)), total: Number(total.rows[0]!.count) }
  }

  async dispose(
    id: string,
    patch: {
      causeCategory: string
      correctiveAction: string
      isolationSuggestion: string | null
      disposedBy: string
      disposedAt: string
    },
  ): Promise<SpcOocTaskRecord | null> {
    const r = await this.client.query(
      `UPDATE spc_ooc_task
       SET status = 'disposed', cause_category = $2, corrective_action = $3, isolation_suggestion = $4,
           disposed_by = $5, disposed_at = $6
       WHERE id = $1 RETURNING ${OOC_COLUMNS}`,
      [id, patch.causeCategory, patch.correctiveAction, patch.isolationSuggestion, patch.disposedBy, patch.disposedAt],
    )
    return r.rows[0] === undefined ? null : mapOoc(r.rows[0] as OocRow)
  }

  async confirmRecontrol(
    id: string,
    patch: { recontrolConfirmedBy: string; recontrolConfirmedAt: string },
  ): Promise<SpcOocTaskRecord | null> {
    const r = await this.client.query(
      `UPDATE spc_ooc_task
       SET status = 're_control_confirmed', recontrol_confirmed_by = $2, recontrol_confirmed_at = $3
       WHERE id = $1 RETURNING ${OOC_COLUMNS}`,
      [id, patch.recontrolConfirmedBy, patch.recontrolConfirmedAt],
    )
    return r.rows[0] === undefined ? null : mapOoc(r.rows[0] as OocRow)
  }
}

// ---------------- spc_gauge / spc_calibration_record ----------------

const GAUGE_COLUMNS = `id, gauge_no, name, gauge_kind, plant_id, enterprise_id, created_at, created_by`

interface GaugeRow {
  id: string
  gauge_no: string
  name: string
  gauge_kind: string | null
  plant_id: string
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
}

function mapGauge(r: GaugeRow): SpcGaugeRecord {
  return {
    id: r.id,
    gaugeNo: r.gauge_no,
    name: r.name,
    gaugeKind: r.gauge_kind,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

class PgSpcGaugeRepository implements SpcGaugeRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(gauge: NewSpcGauge): Promise<SpcGaugeRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_gauge (gauge_no, name, gauge_kind, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${GAUGE_COLUMNS}`,
      [
        gauge.gaugeNo,
        gauge.name,
        gauge.gaugeKind ?? null,
        gauge.plantId,
        gauge.enterpriseId,
        gauge.createdBy ?? null,
      ],
    )
    return mapGauge(r.rows[0] as GaugeRow)
  }

  async findById(id: string): Promise<SpcGaugeRecord | null> {
    const r = await this.client.query(`SELECT ${GAUGE_COLUMNS} FROM spc_gauge WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapGauge(r.rows[0] as GaugeRow)
  }

  async findByNo(plantId: string, gaugeNo: string): Promise<SpcGaugeRecord | null> {
    const r = await this.client.query(
      `SELECT ${GAUGE_COLUMNS} FROM spc_gauge WHERE plant_id = $1 AND gauge_no = $2`,
      [plantId, gaugeNo],
    )
    return r.rows[0] === undefined ? null : mapGauge(r.rows[0] as GaugeRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    page: number
    pageSize: number
  }): Promise<{ items: SpcGaugeRecord[]; total: number }> {
    const params: unknown[] = [filter.plantIds]
    let where = `WHERE ($1::uuid[] IS NULL OR plant_id = ANY($1))`
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where += ` AND plant_id = $${params.length}`
    }
    const total = await this.client.query(`SELECT count(*) AS count FROM spc_gauge ${where}`, params)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${GAUGE_COLUMNS} FROM spc_gauge ${where}
       ORDER BY gauge_no LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapGauge(row as GaugeRow)), total: Number(total.rows[0]!.count) }
  }
}

const CALIBRATION_COLUMNS = `id, gauge_id, calibrated_at, result, certificate_no, valid_until, basis,
  recorded_by, command_receipt_id, plant_id, enterprise_id, business_time, created_at, created_by`

interface CalibrationRow {
  id: string
  gauge_id: string
  calibrated_at: Date | string
  result: SpcCalibrationRecord['result']
  certificate_no: string
  valid_until: Date | string
  basis: string
  recorded_by: string | null
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapCalibration(r: CalibrationRow): SpcCalibrationRecord {
  return {
    id: r.id,
    gaugeId: r.gauge_id,
    calibratedAt: iso(r.calibrated_at),
    result: r.result,
    certificateNo: r.certificate_no,
    validUntil: iso(r.valid_until),
    basis: r.basis,
    recordedBy: r.recorded_by,
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

class PgSpcCalibrationRepository implements SpcCalibrationRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(record: NewSpcCalibrationRecord): Promise<SpcCalibrationRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_calibration_record
         (gauge_id, calibrated_at, result, certificate_no, valid_until, basis, recorded_by,
          command_receipt_id, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${CALIBRATION_COLUMNS}`,
      [
        record.gaugeId,
        record.calibratedAt,
        record.result,
        record.certificateNo,
        record.validUntil,
        record.basis,
        record.recordedBy ?? null,
        record.commandReceiptId ?? null,
        record.plantId,
        record.enterpriseId,
        record.createdBy ?? null,
      ],
    )
    return mapCalibration(r.rows[0] as CalibrationRow)
  }

  async listByGauge(gaugeId: string): Promise<SpcCalibrationRecord[]> {
    const r = await this.client.query(
      `SELECT ${CALIBRATION_COLUMNS} FROM spc_calibration_record
       WHERE gauge_id = $1 ORDER BY calibrated_at DESC, created_at DESC`,
      [gaugeId],
    )
    return r.rows.map((row) => mapCalibration(row as CalibrationRow))
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    gaugeId?: string
    page: number
    pageSize: number
  }): Promise<{ items: SpcCalibrationRecord[]; total: number }> {
    const params: unknown[] = [filter.plantIds]
    let where = `WHERE ($1::uuid[] IS NULL OR plant_id = ANY($1))`
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where += ` AND plant_id = $${params.length}`
    }
    if (filter.gaugeId !== undefined) {
      params.push(filter.gaugeId)
      where += ` AND gauge_id = $${params.length}`
    }
    const total = await this.client.query(`SELECT count(*) AS count FROM spc_calibration_record ${where}`, params)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${CALIBRATION_COLUMNS} FROM spc_calibration_record ${where}
       ORDER BY calibrated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapCalibration(row as CalibrationRow)), total: Number(total.rows[0]!.count) }
  }
}

// ---------------- spc_miscalibration_action ----------------

const MISCAL_ACTION_COLUMNS = `id, gauge_id, window_from, window_to, item_kind, item_ref, item_label,
  action_kind, external_ref, customer_complaint_hint, acted_by, acted_at, command_receipt_id,
  plant_id, enterprise_id, created_at, created_by`

interface MiscalActionRow {
  id: string
  gauge_id: string
  window_from: Date | string
  window_to: Date | string
  item_kind: string
  item_ref: string
  item_label: string | null
  action_kind: SpcMiscalibrationActionRecord['actionKind']
  external_ref: string | null
  customer_complaint_hint: boolean
  acted_by: string
  acted_at: Date | string
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
}

function mapMiscalAction(r: MiscalActionRow): SpcMiscalibrationActionRecord {
  return {
    id: r.id,
    gaugeId: r.gauge_id,
    windowFrom: iso(r.window_from),
    windowTo: iso(r.window_to),
    itemKind: r.item_kind,
    itemRef: r.item_ref,
    itemLabel: r.item_label,
    actionKind: r.action_kind,
    externalRef: r.external_ref,
    customerComplaintHint: r.customer_complaint_hint,
    actedBy: r.acted_by,
    actedAt: iso(r.acted_at),
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

class PgSpcMiscalibrationActionRepository implements SpcMiscalibrationActionRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(action: NewSpcMiscalibrationAction): Promise<SpcMiscalibrationActionRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_miscalibration_action
         (gauge_id, window_from, window_to, item_kind, item_ref, item_label, action_kind, external_ref,
          customer_complaint_hint, acted_by, acted_at, command_receipt_id, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ${MISCAL_ACTION_COLUMNS}`,
      [
        action.gaugeId,
        action.windowFrom,
        action.windowTo,
        action.itemKind,
        action.itemRef,
        action.itemLabel ?? null,
        action.actionKind,
        action.externalRef ?? null,
        action.customerComplaintHint,
        action.actedBy,
        action.actedAt,
        action.commandReceiptId ?? null,
        action.plantId,
        action.enterpriseId,
        action.createdBy ?? null,
      ],
    )
    return mapMiscalAction(r.rows[0] as MiscalActionRow)
  }

  async listByGaugeWindow(gaugeId: string, windowFrom: string, windowTo: string): Promise<SpcMiscalibrationActionRecord[]> {
    const r = await this.client.query(
      `SELECT ${MISCAL_ACTION_COLUMNS} FROM spc_miscalibration_action
       WHERE gauge_id = $1 AND window_from = $2 AND window_to = $3 ORDER BY acted_at`,
      [gaugeId, windowFrom, windowTo],
    )
    return r.rows.map((row) => mapMiscalAction(row as MiscalActionRow))
  }
}

// ---------------- spc_tool_ledger / config / usage / adjustment ----------------

const TOOL_COLUMNS = `id, tool_no, name, tool_kind, config_version, life_uom, rated_life,
  warning_threshold, expire_policy, accumulated_life, plant_id, enterprise_id, created_at,
  created_by, updated_at, updated_by`

interface ToolRow {
  id: string
  tool_no: string
  name: string
  tool_kind: string | null
  config_version: number
  life_uom: SpcToolLedgerRecord['lifeUom']
  rated_life: string | number
  warning_threshold: string | number
  expire_policy: SpcToolLedgerRecord['expirePolicy']
  accumulated_life: string | number
  plant_id: string
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapTool(r: ToolRow): SpcToolLedgerRecord {
  return {
    id: r.id,
    toolNo: r.tool_no,
    name: r.name,
    toolKind: r.tool_kind,
    configVersion: r.config_version,
    lifeUom: r.life_uom,
    ratedLife: num(r.rated_life),
    warningThreshold: num(r.warning_threshold),
    expirePolicy: r.expire_policy,
    accumulatedLife: num(r.accumulated_life),
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

class PgSpcToolLedgerRepository implements SpcToolLedgerRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(tool: NewSpcToolLedger): Promise<SpcToolLedgerRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_tool_ledger
         (tool_no, name, tool_kind, config_version, life_uom, rated_life, warning_threshold,
          expire_policy, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${TOOL_COLUMNS}`,
      [
        tool.toolNo,
        tool.name,
        tool.toolKind ?? null,
        tool.configVersion,
        tool.lifeUom,
        tool.ratedLife,
        tool.warningThreshold,
        tool.expirePolicy,
        tool.plantId,
        tool.enterpriseId,
        tool.createdBy ?? null,
      ],
    )
    return mapTool(r.rows[0] as ToolRow)
  }

  private async byId(id: string, lock: boolean): Promise<SpcToolLedgerRecord | null> {
    const r = await this.client.query(
      `SELECT ${TOOL_COLUMNS} FROM spc_tool_ledger WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
    return r.rows[0] === undefined ? null : mapTool(r.rows[0] as ToolRow)
  }

  async findById(id: string): Promise<SpcToolLedgerRecord | null> {
    return this.byId(id, false)
  }

  async lockById(id: string): Promise<SpcToolLedgerRecord | null> {
    return this.byId(id, true)
  }

  async findByNo(plantId: string, toolNo: string): Promise<SpcToolLedgerRecord | null> {
    const r = await this.client.query(
      `SELECT ${TOOL_COLUMNS} FROM spc_tool_ledger WHERE plant_id = $1 AND tool_no = $2`,
      [plantId, toolNo],
    )
    return r.rows[0] === undefined ? null : mapTool(r.rows[0] as ToolRow)
  }

  /** PE-21/PE-S5：累计列只增（触发器双保险拒回退）。 */
  async addConsumption(id: string, quantity: string, actor: string | null): Promise<SpcToolLedgerRecord | null> {
    const r = await this.client.query(
      `UPDATE spc_tool_ledger
       SET accumulated_life = accumulated_life + $2, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING ${TOOL_COLUMNS}`,
      [id, quantity, actor],
    )
    return r.rows[0] === undefined ? null : mapTool(r.rows[0] as ToolRow)
  }

  async applyConfig(
    id: string,
    patch: {
      configVersion: number
      lifeUom: SpcToolLedgerRecord['lifeUom']
      ratedLife: string
      warningThreshold: string
      expirePolicy: SpcToolLedgerRecord['expirePolicy']
    },
    actor: string | null,
  ): Promise<SpcToolLedgerRecord | null> {
    const r = await this.client.query(
      `UPDATE spc_tool_ledger
       SET config_version = $2, life_uom = $3, rated_life = $4, warning_threshold = $5,
           expire_policy = $6, updated_at = now(), updated_by = $7
       WHERE id = $1 RETURNING ${TOOL_COLUMNS}`,
      [id, patch.configVersion, patch.lifeUom, patch.ratedLife, patch.warningThreshold, patch.expirePolicy, actor],
    )
    return r.rows[0] === undefined ? null : mapTool(r.rows[0] as ToolRow)
  }

  async listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: SpcToolLedgerRecord[]; total: number }> {
    const params: unknown[] = [filter.plantIds]
    let where = `WHERE ($1::uuid[] IS NULL OR plant_id = ANY($1))`
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      where += ` AND plant_id = $${params.length}`
    }
    const total = await this.client.query(`SELECT count(*) AS count FROM spc_tool_ledger ${where}`, params)
    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${TOOL_COLUMNS} FROM spc_tool_ledger ${where}
       ORDER BY tool_no LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map((row) => mapTool(row as ToolRow)), total: Number(total.rows[0]!.count) }
  }
}

const TOOL_CONFIG_COLUMNS = `id, tool_id, version, life_uom, rated_life, warning_threshold,
  expire_policy, effective_at, enterprise_id, created_at, created_by`

interface ToolConfigRow {
  id: string
  tool_id: string
  version: number
  life_uom: SpcToolConfigRecord['lifeUom']
  rated_life: string | number
  warning_threshold: string | number
  expire_policy: SpcToolConfigRecord['expirePolicy']
  effective_at: Date | string
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
}

function mapToolConfig(r: ToolConfigRow): SpcToolConfigRecord {
  return {
    id: r.id,
    toolId: r.tool_id,
    version: r.version,
    lifeUom: r.life_uom,
    ratedLife: num(r.rated_life),
    warningThreshold: num(r.warning_threshold),
    expirePolicy: r.expire_policy,
    effectiveAt: iso(r.effective_at),
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

class PgSpcToolConfigRepository implements SpcToolConfigRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(config: NewSpcToolConfig): Promise<SpcToolConfigRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_tool_config
         (tool_id, version, life_uom, rated_life, warning_threshold, expire_policy, effective_at,
          enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${TOOL_CONFIG_COLUMNS}`,
      [
        config.toolId,
        config.version,
        config.lifeUom,
        config.ratedLife,
        config.warningThreshold,
        config.expirePolicy,
        config.effectiveAt,
        config.enterpriseId,
        config.createdBy ?? null,
      ],
    )
    return mapToolConfig(r.rows[0] as ToolConfigRow)
  }

  async listByTool(toolId: string): Promise<SpcToolConfigRecord[]> {
    const r = await this.client.query(
      `SELECT ${TOOL_CONFIG_COLUMNS} FROM spc_tool_config WHERE tool_id = $1 ORDER BY version`,
      [toolId],
    )
    return r.rows.map((row) => mapToolConfig(row as ToolConfigRow))
  }
}

const TOOL_USAGE_COLUMNS = `id, tool_id, source, quantity, ref_type, ref_id, command_receipt_id,
  plant_id, enterprise_id, business_time, created_at, created_by`

interface ToolUsageRow {
  id: string
  tool_id: string
  source: SpcToolUsageRecord['source']
  quantity: string | number
  ref_type: string
  ref_id: string
  command_receipt_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapToolUsage(r: ToolUsageRow): SpcToolUsageRecord {
  return {
    id: r.id,
    toolId: r.tool_id,
    source: r.source,
    quantity: num(r.quantity),
    refType: r.ref_type,
    refId: r.ref_id,
    commandReceiptId: r.command_receipt_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

class PgSpcToolUsageRepository implements SpcToolUsageRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(usage: NewSpcToolUsage): Promise<SpcToolUsageRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_tool_usage
         (tool_id, source, quantity, ref_type, ref_id, command_receipt_id, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${TOOL_USAGE_COLUMNS}`,
      [
        usage.toolId,
        usage.source,
        usage.quantity,
        usage.refType,
        usage.refId,
        usage.commandReceiptId ?? null,
        usage.plantId,
        usage.enterpriseId,
        usage.createdBy ?? null,
      ],
    )
    return mapToolUsage(r.rows[0] as ToolUsageRow)
  }

  async listByTool(toolId: string): Promise<SpcToolUsageRecord[]> {
    const r = await this.client.query(
      `SELECT ${TOOL_USAGE_COLUMNS} FROM spc_tool_usage WHERE tool_id = $1 ORDER BY created_at`,
      [toolId],
    )
    return r.rows.map((row) => mapToolUsage(row as ToolUsageRow))
  }
}

const TOOL_ADJUSTMENT_COLUMNS = `id, tool_id, delta, reason, command_receipt_id, enterprise_id, created_at, created_by`

interface ToolAdjustmentRow {
  id: string
  tool_id: string
  delta: string | number
  reason: string
  command_receipt_id: string | null
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
}

function mapToolAdjustment(r: ToolAdjustmentRow): SpcToolAdjustmentRecord {
  return {
    id: r.id,
    toolId: r.tool_id,
    delta: num(r.delta),
    reason: r.reason,
    commandReceiptId: r.command_receipt_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

class PgSpcToolAdjustmentRepository implements SpcToolAdjustmentRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(adjustment: NewSpcToolAdjustment): Promise<SpcToolAdjustmentRecord> {
    const r = await this.client.query(
      `INSERT INTO spc_tool_adjustment (tool_id, delta, reason, command_receipt_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${TOOL_ADJUSTMENT_COLUMNS}`,
      [
        adjustment.toolId,
        adjustment.delta,
        adjustment.reason,
        adjustment.commandReceiptId ?? null,
        adjustment.enterpriseId,
        adjustment.createdBy ?? null,
      ],
    )
    return mapToolAdjustment(r.rows[0] as ToolAdjustmentRow)
  }

  async listByTool(toolId: string): Promise<SpcToolAdjustmentRecord[]> {
    const r = await this.client.query(
      `SELECT ${TOOL_ADJUSTMENT_COLUMNS} FROM spc_tool_adjustment WHERE tool_id = $1 ORDER BY created_at`,
      [toolId],
    )
    return r.rows.map((row) => mapToolAdjustment(row as ToolAdjustmentRow))
  }

  async sumByTool(toolId: string): Promise<string> {
    const r = await this.client.query(
      `SELECT COALESCE(sum(delta), 0) AS sum FROM spc_tool_adjustment WHERE tool_id = $1`,
      [toolId],
    )
    return num(r.rows[0]?.sum ?? 0)
  }
}

// ---------------- 跨域只读投影（PE-03/11/18 收集事实；不写共享域表 PE-13） ----------------

export class PgSpcCrossDomainReader implements SpcCrossDomainReader {
  constructor(private readonly client: SqlClient) {}

  async getProcessSpecRevision(id: string): Promise<ProcessSpecRevisionFact | null> {
    const r = await this.client.query(
      `SELECT id, plant_id, product_family_id, name, version, status, parameters
       FROM parameter_spec_revision WHERE id = $1`,
      [id],
    )
    const row = r.rows[0] as
      | { id: string; plant_id: string; product_family_id: string; name: string; version: number; status: string; parameters: unknown }
      | undefined
    return row === undefined
      ? null
      : {
          id: row.id,
          plantId: row.plant_id,
          productFamilyId: row.product_family_id,
          name: row.name,
          version: row.version,
          status: row.status,
          parameters: row.parameters,
        }
  }

  async listProcessSpecRevisions(plantId: string, name?: string): Promise<ProcessSpecRevisionFact[]> {
    const r = await this.client.query(
      `SELECT id, plant_id, product_family_id, name, version, status, parameters
       FROM parameter_spec_revision
       WHERE plant_id = $1${name === undefined ? '' : ' AND name = $2'}
       ORDER BY name, version`,
      name === undefined ? [plantId] : [plantId, name],
    )
    return r.rows.map(
      (row: {
        id: string
        plant_id: string
        product_family_id: string
        name: string
        version: number
        status: string
        parameters: unknown
      }) => ({
        id: row.id,
        plantId: row.plant_id,
        productFamilyId: row.product_family_id,
        name: row.name,
        version: row.version,
        status: row.status,
        parameters: row.parameters,
      }),
    )
  }

  async listOrdersByProductFamily(plantId: string, productFamilyId: string): Promise<ProductionOrderFact[]> {
    const r = await this.client.query(
      `SELECT id, order_no, order_status, product_family_id, plant_id
       FROM production_order WHERE plant_id = $1 AND product_family_id = $2`,
      [plantId, productFamilyId],
    )
    return r.rows.map(
      (row: { id: string; order_no: string; order_status: string; product_family_id: string | null; plant_id: string }) => ({
        id: row.id,
        orderNo: row.order_no,
        orderStatus: row.order_status,
        productFamilyId: row.product_family_id,
        plantId: row.plant_id,
      }),
    )
  }

  async listOrderOperations(orderId: string): Promise<OrderOperationFact[]> {
    // 同 seq 多 settings_version 行时取最新版本行（当前设置口径）
    const r = await this.client.query(
      `SELECT DISTINCT ON (seq) id, order_id, seq, operation_name, settings_version, execution_status,
         core_multiple, strand_factor, offline_qty, uom
       FROM order_operation WHERE order_id = $1 ORDER BY seq, settings_version DESC`,
      [orderId],
    )
    return r.rows.map(
      (row: {
        id: string
        order_id: string
        seq: number
        operation_name: string
        settings_version: number
        execution_status: string
        core_multiple: number
        strand_factor: string | null
        offline_qty: string | number
        uom: string
      }) => ({
        id: row.id,
        orderId: row.order_id,
        seq: row.seq,
        operationName: row.operation_name,
        settingsVersion: row.settings_version,
        executionStatus: row.execution_status,
        coreMultiple: row.core_multiple,
        strandFactor: row.strand_factor === null ? null : String(row.strand_factor),
        offlineQty: num(row.offline_qty),
        uom: row.uom,
      }),
    )
  }

  async hasSubmittedReport(orderOperationId: string): Promise<boolean> {
    const r = await this.client.query(
      `SELECT EXISTS (SELECT 1 FROM production_report WHERE order_operation_id = $1 AND status = 'submitted') AS exists`,
      [orderOperationId],
    )
    return r.rows[0]!.exists
  }

  async listReportedOperationSeqs(orderId: string): Promise<number[]> {
    const r = await this.client.query(
      `SELECT DISTINCT operation_seq FROM production_report WHERE order_id = $1 AND status = 'submitted'`,
      [orderId],
    )
    return r.rows.map((row) => row.operation_seq)
  }

  async listScheduledOperationIds(orderId: string): Promise<string[]> {
    const r = await this.client.query(
      `SELECT DISTINCT order_operation_id FROM schedule_slot WHERE order_id = $1`,
      [orderId],
    )
    return r.rows.map((row) => row.order_operation_id)
  }

  async getTestResult(id: string): Promise<TestResultFact | null> {
    const r = await this.client.query(
      `SELECT id, inspection_order_id, conclusion, items, inspected_at, inspector
       FROM quality_test_result WHERE id = $1`,
      [id],
    )
    const row = r.rows[0] as
      | { id: string; inspection_order_id: string; conclusion: string; items: unknown; inspected_at: Date | string | null; inspector: string | null }
      | undefined
    return row === undefined
      ? null
      : {
          id: row.id,
          inspectionOrderId: row.inspection_order_id,
          conclusion: row.conclusion,
          items: row.items,
          inspectedAt: isoOrNull(row.inspected_at),
          inspector: row.inspector,
        }
  }

  async getInspectionOrder(id: string): Promise<InspectionOrderFact | null> {
    const r = await this.client.query(
      `SELECT id, order_no, status, production_order_no, inventory_unit_id, unit_no, lot_id, material_code
       FROM quality_inspection_order WHERE id = $1`,
      [id],
    )
    const row = r.rows[0] as
      | {
          id: string
          order_no: string
          status: string
          production_order_no: string | null
          inventory_unit_id: string | null
          unit_no: string | null
          lot_id: string | null
          material_code: string | null
        }
      | undefined
    return row === undefined
      ? null
      : {
          id: row.id,
          orderNo: row.order_no,
          status: row.status,
          productionOrderNo: row.production_order_no,
          inventoryUnitId: row.inventory_unit_id,
          unitNo: row.unit_no,
          lotId: row.lot_id,
          materialCode: row.material_code,
        }
  }

  async listDispositionsByInspectionOrder(inspectionOrderId: string): Promise<QualityDispositionFact[]> {
    const r = await this.client.query(
      `SELECT id, inspection_order_id, disposition_kind, released_by, released_at
       FROM quality_disposition WHERE inspection_order_id = $1 ORDER BY released_at`,
      [inspectionOrderId],
    )
    return r.rows.map(
      (row: { id: string; inspection_order_id: string; disposition_kind: string; released_by: string; released_at: Date | string }) => ({
        id: row.id,
        inspectionOrderId: row.inspection_order_id,
        dispositionKind: row.disposition_kind,
        releasedBy: row.released_by,
        releasedAt: iso(row.released_at),
      }),
    )
  }

  async getInventoryUnit(id: string): Promise<InventoryUnitFact | null> {
    const r = await this.client.query(`SELECT id, unit_no, status, lot_id FROM inventory_unit WHERE id = $1`, [id])
    const row = r.rows[0] as { id: string; unit_no: string; status: string; lot_id: string | null } | undefined
    return row === undefined ? null : { id: row.id, unitNo: row.unit_no, status: row.status, lotId: row.lot_id }
  }

  async getMaterialLot(id: string): Promise<MaterialLotFact | null> {
    const r = await this.client.query(`SELECT id, lot_no FROM material_lot WHERE id = $1`, [id])
    const row = r.rows[0] as { id: string; lot_no: string } | undefined
    return row === undefined ? null : { id: row.id, lotNo: row.lot_no }
  }

  async getProductionOrderById(id: string): Promise<ProductionOrderFact | null> {
    const r = await this.client.query(
      `SELECT id, order_no, order_status, product_family_id, plant_id FROM production_order WHERE id = $1`,
      [id],
    )
    const row = r.rows[0] as
      | { id: string; order_no: string; order_status: string; product_family_id: string | null; plant_id: string }
      | undefined
    return row === undefined
      ? null
      : {
          id: row.id,
          orderNo: row.order_no,
          orderStatus: row.order_status,
          productFamilyId: row.product_family_id,
          plantId: row.plant_id,
        }
  }

  async getProductionOrderStatus(orderNo: string): Promise<string | null> {
    const r = await this.client.query(
      `SELECT order_status FROM production_order WHERE order_no = $1 LIMIT 1`,
      [orderNo],
    )
    return r.rows[0]?.order_status ?? null
  }
}

// ---------------- 装配 ----------------

/** spc 仓储束装配（事务客户端绑定；命令事务与查询池共用行形状）。 */
export function createPgSpcRepositories(client: SqlClient): SpcRepositories {
  return {
    receipts: new PgSpcReceiptLookup(client),
    changes: new PgSpcProcessChangeRepository(client),
    impacts: new PgSpcChangeImpactRepository(client),
    adjustments: new PgSpcChangeAdjustmentRepository(client),
    ruleSets: new PgSpcRuleSetRepository(client),
    controlItems: new PgSpcControlItemRepository(client),
    controlLimits: new PgSpcControlLimitRepository(client),
    samples: new PgSpcSampleRepository(client),
    judgements: new PgSpcPointJudgementRepository(client),
    oocTasks: new PgSpcOocTaskRepository(client),
    gauges: new PgSpcGaugeRepository(client),
    calibrations: new PgSpcCalibrationRepository(client),
    miscalibrationActions: new PgSpcMiscalibrationActionRepository(client),
    tools: new PgSpcToolLedgerRepository(client),
    toolConfigs: new PgSpcToolConfigRepository(client),
    toolUsages: new PgSpcToolUsageRepository(client),
    toolAdjustments: new PgSpcToolAdjustmentRepository(client),
  }
}

/** 跨域只读投影装配。 */
export function createPgSpcCrossDomainReader(client: SqlClient): SpcCrossDomainReader {
  return new PgSpcCrossDomainReader(client)
}
