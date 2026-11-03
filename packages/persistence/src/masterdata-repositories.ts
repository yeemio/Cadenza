import type { PageResult } from '@cadenza/contracts'
import type { SqlClient } from './sql-client'

/**
 * masterdata 域仓储的 PostgreSQL 实现（对应 0003 迁移表；端口接口见
 * application/src/masterdata-repositories.ts——该包 index 未导出前以结构化实现落库，
 * 装配一致性由 tests/**（typecheck:tests）在组合点校验）。
 * 全部参数化查询；numeric 出参规范化为十进制字符串（去尾零）。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** numeric 列出参规范化："2.5000" → "2.5"；"2.0000" → "2"。 */
function dec(value: string | number | null): string | null {
  if (value === null) return null
  const text = String(value)
  if (!text.includes('.')) return text
  return text.replace(/0+$/, '').replace(/\.$/, '')
}

interface MaterialRow {
  id: string
  org_scope_id: string
  code: string
  name: string
  company_org_code: string | null
  material_group_code: string | null
  material_group_name: string | null
  description_zh: string | null
  description_en: string | null
  voltage: string | null
  standard: string | null
  customer: string | null
  material_type: number
  spec: string | null
  color: string | null
  base_uom: string
  qc_flag: number
  remark: string | null
  source_system: string
  external_revision: number | null
  status: 'active' | 'retired'
  deleted_at: Date | string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

export class PgMaterialRepository {
  constructor(private readonly client: SqlClient) {}

  private readonly columns = `id, org_scope_id, code, name, company_org_code, material_group_code,
    material_group_name, description_zh, description_en, voltage, standard, customer, material_type,
    spec, color, base_uom, qc_flag, remark, source_system, external_revision, status, deleted_at,
    created_at, created_by, updated_at, updated_by`

  async findById(id: string) {
    const r = await this.client.query(`SELECT ${this.columns} FROM material WHERE id = $1`, [id])
    return r.rows[0] ? mapMaterial(r.rows[0] as MaterialRow) : null
  }

  async findActiveByCode(orgScopeId: string, code: string) {
    const r = await this.client.query(
      `SELECT ${this.columns} FROM material WHERE org_scope_id = $1 AND code = $2 AND status = 'active'`,
      [orgScopeId, code],
    )
    return r.rows[0] ? mapMaterial(r.rows[0] as MaterialRow) : null
  }

  async list(filter: {
    orgScopeId: string
    nameLike?: string
    codeLike?: string
    page: number
    pageSize: number
  }): Promise<PageResult<ReturnType<typeof mapMaterial>>> {
    const conditions = [`org_scope_id = $1`, `status = 'active'`]
    const values: unknown[] = [filter.orgScopeId]
    if (filter.nameLike !== undefined) {
      values.push(`%${filter.nameLike}%`)
      conditions.push(`name LIKE $${values.length}`)
    }
    if (filter.codeLike !== undefined) {
      values.push(`%${filter.codeLike}%`)
      conditions.push(`code LIKE $${values.length}`)
    }
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${this.columns}, count(*) OVER () ::int AS total_count
       FROM material WHERE ${conditions.join(' AND ')}
       ORDER BY code
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapMaterial(row as MaterialRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

function mapMaterial(r: MaterialRow) {
  return {
    id: r.id,
    orgScopeId: r.org_scope_id,
    code: r.code,
    name: r.name,
    companyOrgCode: r.company_org_code,
    materialGroupCode: r.material_group_code,
    materialGroupName: r.material_group_name,
    descriptionZh: r.description_zh,
    descriptionEn: r.description_en,
    voltage: r.voltage,
    standard: r.standard,
    customer: r.customer,
    materialType: r.material_type,
    spec: r.spec,
    color: r.color,
    baseUom: r.base_uom,
    qcFlag: r.qc_flag,
    remark: r.remark,
    sourceSystem: r.source_system,
    externalRevision: r.external_revision ?? null,
    status: r.status,
    deletedAt: r.deleted_at ? iso(r.deleted_at) : null,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

interface ConversionRow {
  id: string
  material_id: string
  version: number
  unit_name: string
  factor: string
  referenced: boolean
  status: 'active' | 'retired'
  deleted_at: Date | string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

const CONVERSION_COLUMNS = `id, material_id, version, unit_name, factor, referenced, status,
  deleted_at, created_at, created_by, updated_at, updated_by`

function mapConversion(r: ConversionRow) {
  return {
    id: r.id,
    materialId: r.material_id,
    version: r.version,
    unitName: r.unit_name,
    factor: dec(r.factor) ?? '0',
    referenced: r.referenced,
    status: r.status,
    deletedAt: r.deleted_at ? iso(r.deleted_at) : null,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgConversionRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string) {
    const r = await this.client.query(
      `SELECT ${CONVERSION_COLUMNS} FROM conversion_revision WHERE id = $1`,
      [id],
    )
    return r.rows[0] ? mapConversion(r.rows[0] as ConversionRow) : null
  }

  async listActiveByMaterial(materialId: string) {
    const r = await this.client.query(
      `SELECT ${CONVERSION_COLUMNS} FROM conversion_revision
       WHERE material_id = $1 AND status = 'active' ORDER BY version`,
      [materialId],
    )
    return r.rows.map((row) => mapConversion(row as ConversionRow))
  }

  async nextVersion(materialId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT COALESCE(max(version), 0) + 1 AS next FROM conversion_revision WHERE material_id = $1`,
      [materialId],
    )
    return (r.rows[0] as { next: number }).next
  }

  async insert(line: {
    id?: string
    materialId: string
    version: number
    unitName: string
    factor: string
    createdBy?: string | null
  }) {
    const r = await this.client.query(
      `INSERT INTO conversion_revision (id, material_id, version, unit_name, factor, referenced, status, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5::numeric, false, 'active', $6)
       RETURNING ${CONVERSION_COLUMNS}`,
      [line.id ?? null, line.materialId, line.version, line.unitName, line.factor, line.createdBy ?? null],
    )
    return mapConversion(r.rows[0] as ConversionRow)
  }

  async update(
    id: string,
    patch: { unitName?: string; factor?: string; referenced?: boolean; status?: 'active' | 'retired' },
    actor: string | null,
  ) {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch.unitName !== undefined) add('unit_name', patch.unitName)
    if (patch.factor !== undefined) add('factor', patch.factor)
    if (patch.referenced !== undefined) add('referenced', patch.referenced)
    if (patch.status !== undefined) add('status', patch.status)
    if (sets.length === 0) return this.findById(id)
    add('updated_at', new Date())
    add('updated_by', actor)
    values.push(id)
    const r = await this.client.query(
      `UPDATE conversion_revision SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${CONVERSION_COLUMNS}`,
      values,
    )
    return r.rows[0] ? mapConversion(r.rows[0] as ConversionRow) : null
  }

  /** MD-36 逻辑删除：状态列 + deleted_at（不删行）。 */
  async retire(id: string, actor: string | null) {
    const r = await this.client.query(
      `UPDATE conversion_revision SET status = 'retired', deleted_at = now(), updated_at = now(), updated_by = $2
       WHERE id = $1 RETURNING ${CONVERSION_COLUMNS}`,
      [id, actor],
    )
    return r.rows[0] ? mapConversion(r.rows[0] as ConversionRow) : null
  }

  /** MD-05：置 referenced 标志（false→true 放行；referenced 行内容更新被库层触发器拒绝）。 */
  async markReferenced(id: string, actor: string | null) {
    return this.update(id, { referenced: true }, actor)
  }
}

interface EquipmentRow {
  id: string
  enterprise_id: string
  plant_id: string
  dept_id: string
  work_center_id: string
  code: string
  name: string
  actual_no: string | null
  model: string | null
  std_rate_text: string | null
  equipment_status: number
  capacity: string | null
  status: 'active' | 'retired'
  deleted_at: Date | string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

const EQUIPMENT_COLUMNS = `id, enterprise_id, plant_id, dept_id, work_center_id, code, name, actual_no,
  model, std_rate_text, equipment_status, capacity, status, deleted_at, created_at, created_by,
  updated_at, updated_by`

function mapEquipment(r: EquipmentRow) {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    deptId: r.dept_id,
    workCenterId: r.work_center_id,
    code: r.code,
    name: r.name,
    actualNo: r.actual_no,
    model: r.model,
    stdRateText: r.std_rate_text,
    equipmentStatus: r.equipment_status,
    capacity: dec(r.capacity),
    status: r.status,
    deletedAt: r.deleted_at ? iso(r.deleted_at) : null,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

interface StatusLogRow {
  id: string
  equipment_id: string
  old_status: number
  new_status: number
  source: string
  actor: string
  created_at: Date | string
}

export class PgEquipmentRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string) {
    const r = await this.client.query(`SELECT ${EQUIPMENT_COLUMNS} FROM equipment WHERE id = $1`, [id])
    return r.rows[0] ? mapEquipment(r.rows[0] as EquipmentRow) : null
  }

  async findActiveByCode(code: string) {
    const r = await this.client.query(
      `SELECT ${EQUIPMENT_COLUMNS} FROM equipment WHERE code = $1 AND status = 'active'`,
      [code],
    )
    return r.rows[0] ? mapEquipment(r.rows[0] as EquipmentRow) : null
  }

  async findActiveByName(name: string) {
    const r = await this.client.query(
      `SELECT ${EQUIPMENT_COLUMNS} FROM equipment WHERE name = $1 AND status = 'active'`,
      [name],
    )
    return r.rows[0] ? mapEquipment(r.rows[0] as EquipmentRow) : null
  }

  async insert(equipment: {
    id?: string
    enterpriseId: string
    plantId: string
    deptId: string
    workCenterId: string
    code: string
    name: string
    actualNo?: string | null
    model?: string | null
    stdRateText?: string | null
    equipmentStatus: number
    capacity?: string | null
    createdBy?: string | null
  }) {
    const r = await this.client.query(
      `INSERT INTO equipment (id, enterprise_id, plant_id, dept_id, work_center_id, code, name,
         actual_no, model, std_rate_text, equipment_status, capacity, status, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12::numeric, 'active', $13)
       RETURNING ${EQUIPMENT_COLUMNS}`,
      [
        equipment.id ?? null,
        equipment.enterpriseId,
        equipment.plantId,
        equipment.deptId,
        equipment.workCenterId,
        equipment.code,
        equipment.name,
        equipment.actualNo ?? null,
        equipment.model ?? null,
        equipment.stdRateText ?? null,
        equipment.equipmentStatus,
        equipment.capacity ?? null,
        equipment.createdBy ?? null,
      ],
    )
    return mapEquipment(r.rows[0] as EquipmentRow)
  }

  async update(
    id: string,
    patch: Record<string, unknown>,
    actor: string | null,
  ): Promise<ReturnType<typeof mapEquipment> | null> {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch['name'] !== undefined) add('name', patch['name'])
    if (patch['deptId'] !== undefined) add('dept_id', patch['deptId'])
    if (patch['workCenterId'] !== undefined) add('work_center_id', patch['workCenterId'])
    if (patch['actualNo'] !== undefined) add('actual_no', patch['actualNo'])
    if (patch['model'] !== undefined) add('model', patch['model'])
    if (patch['stdRateText'] !== undefined) add('std_rate_text', patch['stdRateText'])
    if (patch['equipmentStatus'] !== undefined) add('equipment_status', patch['equipmentStatus'])
    if (patch['capacity'] !== undefined) add('capacity', patch['capacity'])
    if (patch['status'] !== undefined) {
      add('status', patch['status'])
      add('deleted_at', patch['status'] === 'retired' ? new Date() : null)
    }
    if (sets.length === 0) return this.findById(id)
    add('updated_at', new Date())
    add('updated_by', actor)
    values.push(id)
    const r = await this.client.query(
      `UPDATE equipment SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${EQUIPMENT_COLUMNS}`,
      values,
    )
    return r.rows[0] ? mapEquipment(r.rows[0] as EquipmentRow) : null
  }

  async retire(id: string, actor: string | null) {
    return this.update(id, { status: 'retired' }, actor)
  }

  async appendStatusLog(entry: {
    equipmentId: string
    oldStatus: number
    newStatus: number
    source: string
    actor: string
    occurredAt: Date
  }) {
    const r = await this.client.query(
      `INSERT INTO equipment_status_log (equipment_id, old_status, new_status, source, actor, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, equipment_id, old_status, new_status, source, actor, created_at`,
      [
        entry.equipmentId,
        entry.oldStatus,
        entry.newStatus,
        entry.source,
        entry.actor,
        entry.occurredAt,
      ],
    )
    const row = r.rows[0] as StatusLogRow
    return {
      id: row.id,
      equipmentId: row.equipment_id,
      oldStatus: row.old_status,
      newStatus: row.new_status,
      source: row.source,
      actor: row.actor,
      createdAt: iso(row.created_at),
    }
  }

  async listStatusLogs(equipmentId: string) {
    const r = await this.client.query(
      `SELECT id, equipment_id, old_status, new_status, source, actor, created_at
       FROM equipment_status_log WHERE equipment_id = $1 ORDER BY created_at DESC, id`,
      [equipmentId],
    )
    return r.rows.map((row) => {
      const log = row as StatusLogRow
      return {
        id: log.id,
        equipmentId: log.equipment_id,
        oldStatus: log.old_status,
        newStatus: log.new_status,
        source: log.source,
        actor: log.actor,
        createdAt: iso(log.created_at),
      }
    })
  }

  /** MD-11：排产引用计数——排产表属生产域未建，按 0 预留（建表后接入）。 */
  async countSchedulingRefs(equipmentId: string): Promise<number> {
    void equipmentId
    return 0
  }

  /** MD-11：报工引用计数——报工表属生产域未建，按 0 预留（建表后接入）。 */
  async countWorkReportRefs(equipmentId: string): Promise<number> {
    void equipmentId
    return 0
  }

  async list(filter: {
    plantIds: string[] | null
    nameLike?: string
    codeLike?: string
    page: number
    pageSize: number
  }): Promise<PageResult<ReturnType<typeof mapEquipment>>> {
    const conditions = [`status = 'active'`]
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) {
        return { items: [], total: 0, page: filter.page, pageSize: filter.pageSize }
      }
      values.push(filter.plantIds)
      conditions.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.nameLike !== undefined) {
      values.push(`%${filter.nameLike}%`)
      conditions.push(`name LIKE $${values.length}`)
    }
    if (filter.codeLike !== undefined) {
      values.push(`%${filter.codeLike}%`)
      conditions.push(`code LIKE $${values.length}`)
    }
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${EQUIPMENT_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM equipment WHERE ${conditions.join(' AND ')}
       ORDER BY code
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapEquipment(row as EquipmentRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

interface WarehouseRow {
  id: string
  enterprise_id: string
  plant_id: string
  dept_id: string
  code: string
  name: string
  warehouse_type: 'WAREHOUSE' | 'LINE_SIDE'
  material_types: number[]
  manager_user_id: string | null
  phone: string | null
  address: string | null
  qr_bound: boolean
  status: 'active' | 'retired'
  deleted_at: Date | string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

const WAREHOUSE_COLUMNS = `id, enterprise_id, plant_id, dept_id, code, name, warehouse_type,
  material_types, manager_user_id, phone, address, qr_bound, status, deleted_at, created_at,
  created_by, updated_at, updated_by`

function mapWarehouse(r: WarehouseRow) {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    deptId: r.dept_id,
    code: r.code,
    name: r.name,
    warehouseType: r.warehouse_type,
    materialTypes: r.material_types ?? [],
    managerUserId: r.manager_user_id,
    phone: r.phone,
    address: r.address,
    qrBound: r.qr_bound,
    status: r.status,
    deletedAt: r.deleted_at ? iso(r.deleted_at) : null,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgWarehouseRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string) {
    const r = await this.client.query(`SELECT ${WAREHOUSE_COLUMNS} FROM warehouse WHERE id = $1`, [id])
    return r.rows[0] ? mapWarehouse(r.rows[0] as WarehouseRow) : null
  }

  async findActiveByName(name: string) {
    const r = await this.client.query(
      `SELECT ${WAREHOUSE_COLUMNS} FROM warehouse WHERE name = $1 AND status = 'active'`,
      [name],
    )
    return r.rows[0] ? mapWarehouse(r.rows[0] as WarehouseRow) : null
  }

  async findActiveByPlantAndCode(plantId: string, code: string) {
    const r = await this.client.query(
      `SELECT ${WAREHOUSE_COLUMNS} FROM warehouse WHERE plant_id = $1 AND code = $2 AND status = 'active'`,
      [plantId, code],
    )
    return r.rows[0] ? mapWarehouse(r.rows[0] as WarehouseRow) : null
  }

  async insert(warehouse: {
    id?: string
    enterpriseId: string
    plantId: string
    deptId: string
    code: string
    name: string
    warehouseType: 'WAREHOUSE' | 'LINE_SIDE'
    materialTypes: number[]
    managerUserId?: string | null
    phone?: string | null
    address?: string | null
    createdBy?: string | null
  }) {
    const r = await this.client.query(
      `INSERT INTO warehouse (id, enterprise_id, plant_id, dept_id, code, name, warehouse_type,
         material_types, manager_user_id, phone, address, status, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12)
       RETURNING ${WAREHOUSE_COLUMNS}`,
      [
        warehouse.id ?? null,
        warehouse.enterpriseId,
        warehouse.plantId,
        warehouse.deptId,
        warehouse.code,
        warehouse.name,
        warehouse.warehouseType,
        warehouse.materialTypes,
        warehouse.managerUserId ?? null,
        warehouse.phone ?? null,
        warehouse.address ?? null,
        warehouse.createdBy ?? null,
      ],
    )
    return mapWarehouse(r.rows[0] as WarehouseRow)
  }

  async update(id: string, patch: Record<string, unknown>, actor: string | null) {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch['code'] !== undefined) add('code', patch['code'])
    if (patch['name'] !== undefined) add('name', patch['name'])
    if (patch['deptId'] !== undefined) add('dept_id', patch['deptId'])
    if (patch['warehouseType'] !== undefined) add('warehouse_type', patch['warehouseType'])
    if (patch['materialTypes'] !== undefined) add('material_types', patch['materialTypes'])
    if (patch['managerUserId'] !== undefined) add('manager_user_id', patch['managerUserId'])
    if (patch['phone'] !== undefined) add('phone', patch['phone'])
    if (patch['address'] !== undefined) add('address', patch['address'])
    if (patch['status'] !== undefined) {
      add('status', patch['status'])
      add('deleted_at', patch['status'] === 'retired' ? new Date() : null)
    }
    if (sets.length === 0) return this.findById(id)
    add('updated_at', new Date())
    add('updated_by', actor)
    values.push(id)
    const r = await this.client.query(
      `UPDATE warehouse SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${WAREHOUSE_COLUMNS}`,
      values,
    )
    return r.rows[0] ? mapWarehouse(r.rows[0] as WarehouseRow) : null
  }

  async retire(id: string, actor: string | null) {
    return this.update(id, { status: 'retired' }, actor)
  }

  async countActiveNormalLocations(warehouseId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM storage_location
       WHERE warehouse_id = $1 AND location_kind = 'NORMAL' AND status = 'active'`,
      [warehouseId],
    )
    return (r.rows[0] as { n: number }).n
  }

  /** MD-27：无引用时下级普通库位级联失效（不物理删行）。 */
  async retireNormalLocations(warehouseId: string, actor: string | null): Promise<number> {
    const r = await this.client.query(
      `UPDATE storage_location SET status = 'retired', deleted_at = now(), updated_at = now(), updated_by = $2
       WHERE warehouse_id = $1 AND location_kind = 'NORMAL' AND status = 'active'`,
      [warehouseId, actor],
    )
    return r.rowCount ?? 0
  }

  async listActiveLocationIds(warehouseId: string): Promise<string[]> {
    const r = await this.client.query(
      `SELECT id FROM storage_location WHERE warehouse_id = $1 AND status = 'active'`,
      [warehouseId],
    )
    return r.rows.map((row) => (row as { id: string }).id)
  }

  async list(filter: {
    plantIds: string[] | null
    nameLike?: string
    page: number
    pageSize: number
  }): Promise<PageResult<ReturnType<typeof mapWarehouse>>> {
    const conditions = [`status = 'active'`]
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) {
        return { items: [], total: 0, page: filter.page, pageSize: filter.pageSize }
      }
      values.push(filter.plantIds)
      conditions.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.nameLike !== undefined) {
      values.push(`%${filter.nameLike}%`)
      conditions.push(`name LIKE $${values.length}`)
    }
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${WAREHOUSE_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM warehouse WHERE ${conditions.join(' AND ')}
       ORDER BY plant_id, code
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapWarehouse(row as WarehouseRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

interface LocationRow {
  id: string
  enterprise_id: string
  plant_id: string
  warehouse_id: string
  rack_id: string | null
  location_kind: 'NORMAL' | 'RACK'
  code: string
  zone_code: string | null
  remark: string | null
  qr_bound: boolean
  status: 'active' | 'retired'
  deleted_at: Date | string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

const LOCATION_COLUMNS = `id, enterprise_id, plant_id, warehouse_id, rack_id, location_kind, code,
  zone_code, remark, qr_bound, status, deleted_at, created_at, created_by, updated_at, updated_by`

function mapLocation(r: LocationRow) {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    warehouseId: r.warehouse_id,
    rackId: r.rack_id,
    locationKind: r.location_kind,
    code: r.code,
    zoneCode: r.zone_code,
    remark: r.remark,
    qrBound: r.qr_bound,
    status: r.status,
    deletedAt: r.deleted_at ? iso(r.deleted_at) : null,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgStorageLocationRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string) {
    const r = await this.client.query(`SELECT ${LOCATION_COLUMNS} FROM storage_location WHERE id = $1`, [id])
    return r.rows[0] ? mapLocation(r.rows[0] as LocationRow) : null
  }

  async findActiveByPlantAndCode(plantId: string, code: string) {
    const r = await this.client.query(
      `SELECT ${LOCATION_COLUMNS} FROM storage_location
       WHERE plant_id = $1 AND code = $2 AND status = 'active'`,
      [plantId, code],
    )
    return r.rows[0] ? mapLocation(r.rows[0] as LocationRow) : null
  }

  async insert(location: {
    id?: string
    enterpriseId: string
    plantId: string
    warehouseId: string
    rackId?: string | null
    locationKind: 'NORMAL' | 'RACK'
    code: string
    zoneCode?: string | null
    remark?: string | null
    createdBy?: string | null
  }) {
    const r = await this.client.query(
      `INSERT INTO storage_location (id, enterprise_id, plant_id, warehouse_id, rack_id, location_kind,
         code, zone_code, remark, qr_bound, status, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, false, 'active', $10)
       RETURNING ${LOCATION_COLUMNS}`,
      [
        location.id ?? null,
        location.enterpriseId,
        location.plantId,
        location.warehouseId,
        location.rackId ?? null,
        location.locationKind,
        location.code,
        location.zoneCode ?? null,
        location.remark ?? null,
        location.createdBy ?? null,
      ],
    )
    return mapLocation(r.rows[0] as LocationRow)
  }

  async update(id: string, patch: Record<string, unknown>, actor: string | null) {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch['code'] !== undefined) add('code', patch['code'])
    if (patch['remark'] !== undefined) add('remark', patch['remark'])
    if (patch['status'] !== undefined) {
      add('status', patch['status'])
      add('deleted_at', patch['status'] === 'retired' ? new Date() : null)
    }
    if (sets.length === 0) return this.findById(id)
    add('updated_at', new Date())
    add('updated_by', actor)
    values.push(id)
    const r = await this.client.query(
      `UPDATE storage_location SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${LOCATION_COLUMNS}`,
      values,
    )
    return r.rows[0] ? mapLocation(r.rows[0] as LocationRow) : null
  }

  async retire(id: string, actor: string | null) {
    return this.update(id, { status: 'retired' }, actor)
  }

  async listActiveByRack(rackId: string) {
    const r = await this.client.query(
      `SELECT ${LOCATION_COLUMNS} FROM storage_location
       WHERE rack_id = $1 AND status = 'active' ORDER BY code`,
      [rackId],
    )
    return r.rows.map((row) => mapLocation(row as LocationRow))
  }

  async countActiveByRack(rackId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM storage_location WHERE rack_id = $1 AND status = 'active'`,
      [rackId],
    )
    return (r.rows[0] as { n: number }).n
  }

  async countQrBoundActiveByRack(rackId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM storage_location
       WHERE rack_id = $1 AND status = 'active' AND qr_bound = true`,
      [rackId],
    )
    return (r.rows[0] as { n: number }).n
  }

  async listActiveIdsByRack(rackId: string): Promise<string[]> {
    const r = await this.client.query(
      `SELECT id FROM storage_location WHERE rack_id = $1 AND status = 'active'`,
      [rackId],
    )
    return r.rows.map((row) => (row as { id: string }).id)
  }

  /** MD-31：货架换仓时同步更新其下全部库位的所属仓库。 */
  async updateWarehouseOfRackLocations(rackId: string, warehouseId: string, actor: string | null) {
    const r = await this.client.query(
      `UPDATE storage_location SET warehouse_id = $2, updated_at = now(), updated_by = $3
       WHERE rack_id = $1 AND status = 'active'`,
      [rackId, warehouseId, actor],
    )
    return r.rowCount ?? 0
  }

  async list(filter: {
    plantIds: string[] | null
    warehouseId?: string
    codeLike?: string
    page: number
    pageSize: number
  }): Promise<PageResult<ReturnType<typeof mapLocation>>> {
    const conditions = [`status = 'active'`]
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) {
        return { items: [], total: 0, page: filter.page, pageSize: filter.pageSize }
      }
      values.push(filter.plantIds)
      conditions.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.warehouseId !== undefined) {
      values.push(filter.warehouseId)
      conditions.push(`warehouse_id = $${values.length}`)
    }
    if (filter.codeLike !== undefined) {
      values.push(`%${filter.codeLike}%`)
      conditions.push(`code LIKE $${values.length}`)
    }
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${LOCATION_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM storage_location WHERE ${conditions.join(' AND ')}
       ORDER BY plant_id, code
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapLocation(row as LocationRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

interface RackRow {
  id: string
  enterprise_id: string
  plant_id: string
  warehouse_id: string
  code: string
  zones: number
  layers: number
  remark: string | null
  status: 'active' | 'retired'
  deleted_at: Date | string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

const RACK_COLUMNS = `id, enterprise_id, plant_id, warehouse_id, code, zones, layers, remark, status,
  deleted_at, created_at, created_by, updated_at, updated_by`

function mapRack(r: RackRow) {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    warehouseId: r.warehouse_id,
    code: r.code,
    zones: r.zones,
    layers: r.layers,
    remark: r.remark,
    status: r.status,
    deletedAt: r.deleted_at ? iso(r.deleted_at) : null,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgRackRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string) {
    const r = await this.client.query(`SELECT ${RACK_COLUMNS} FROM rack WHERE id = $1`, [id])
    return r.rows[0] ? mapRack(r.rows[0] as RackRow) : null
  }

  async findActiveByPlantAndCode(plantId: string, code: string) {
    const r = await this.client.query(
      `SELECT ${RACK_COLUMNS} FROM rack WHERE plant_id = $1 AND code = $2 AND status = 'active'`,
      [plantId, code],
    )
    return r.rows[0] ? mapRack(r.rows[0] as RackRow) : null
  }

  async insert(rack: {
    id?: string
    enterpriseId: string
    plantId: string
    warehouseId: string
    code: string
    zones: number
    layers: number
    remark?: string | null
    createdBy?: string | null
  }) {
    const r = await this.client.query(
      `INSERT INTO rack (id, enterprise_id, plant_id, warehouse_id, code, zones, layers, remark, status, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, 'active', $9)
       RETURNING ${RACK_COLUMNS}`,
      [
        rack.id ?? null,
        rack.enterpriseId,
        rack.plantId,
        rack.warehouseId,
        rack.code,
        rack.zones,
        rack.layers,
        rack.remark ?? null,
        rack.createdBy ?? null,
      ],
    )
    return mapRack(r.rows[0] as RackRow)
  }

  async update(id: string, patch: Record<string, unknown>, actor: string | null) {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch['code'] !== undefined) add('code', patch['code'])
    if (patch['warehouseId'] !== undefined) add('warehouse_id', patch['warehouseId'])
    if (patch['plantId'] !== undefined) add('plant_id', patch['plantId'])
    if (patch['remark'] !== undefined) add('remark', patch['remark'])
    if (patch['status'] !== undefined) {
      add('status', patch['status'])
      add('deleted_at', patch['status'] === 'retired' ? new Date() : null)
    }
    if (sets.length === 0) return this.findById(id)
    add('updated_at', new Date())
    add('updated_by', actor)
    values.push(id)
    const r = await this.client.query(
      `UPDATE rack SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${RACK_COLUMNS}`,
      values,
    )
    return r.rows[0] ? mapRack(r.rows[0] as RackRow) : null
  }

  async retire(id: string, actor: string | null) {
    return this.update(id, { status: 'retired' }, actor)
  }

  async list(filter: {
    plantIds: string[] | null
    warehouseId?: string
    codeLike?: string
    page: number
    pageSize: number
  }): Promise<PageResult<ReturnType<typeof mapRack>>> {
    const conditions = [`status = 'active'`]
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) {
        return { items: [], total: 0, page: filter.page, pageSize: filter.pageSize }
      }
      values.push(filter.plantIds)
      conditions.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.warehouseId !== undefined) {
      values.push(filter.warehouseId)
      conditions.push(`warehouse_id = $${values.length}`)
    }
    if (filter.codeLike !== undefined) {
      values.push(`%${filter.codeLike}%`)
      conditions.push(`code LIKE $${values.length}`)
    }
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${RACK_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM rack WHERE ${conditions.join(' AND ')}
       ORDER BY plant_id, code
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapRack(row as RackRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

interface WorkCenterRow {
  id: string
  enterprise_id: string
  plant_id: string
  dept_id: string
  code: string
  name: string
  status: 'active' | 'retired'
  deleted_at: Date | string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

const WORK_CENTER_COLUMNS = `id, enterprise_id, plant_id, dept_id, code, name, status, deleted_at,
  created_at, created_by, updated_at, updated_by`

function mapWorkCenter(r: WorkCenterRow) {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    deptId: r.dept_id,
    code: r.code,
    name: r.name,
    status: r.status,
    deletedAt: r.deleted_at ? iso(r.deleted_at) : null,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgWorkCenterRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string) {
    const r = await this.client.query(`SELECT ${WORK_CENTER_COLUMNS} FROM work_center WHERE id = $1`, [id])
    return r.rows[0] ? mapWorkCenter(r.rows[0] as WorkCenterRow) : null
  }

  async findActiveByCode(code: string) {
    const r = await this.client.query(
      `SELECT ${WORK_CENTER_COLUMNS} FROM work_center WHERE code = $1 AND status = 'active'`,
      [code],
    )
    return r.rows[0] ? mapWorkCenter(r.rows[0] as WorkCenterRow) : null
  }

  async findActiveByDeptAndName(deptId: string, name: string) {
    const r = await this.client.query(
      `SELECT ${WORK_CENTER_COLUMNS} FROM work_center
       WHERE dept_id = $1 AND name = $2 AND status = 'active'`,
      [deptId, name],
    )
    return r.rows[0] ? mapWorkCenter(r.rows[0] as WorkCenterRow) : null
  }

  async insert(workCenter: {
    id?: string
    enterpriseId: string
    plantId: string
    deptId: string
    code: string
    name: string
    createdBy?: string | null
  }) {
    const r = await this.client.query(
      `INSERT INTO work_center (id, enterprise_id, plant_id, dept_id, code, name, status, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, 'active', $7)
       RETURNING ${WORK_CENTER_COLUMNS}`,
      [
        workCenter.id ?? null,
        workCenter.enterpriseId,
        workCenter.plantId,
        workCenter.deptId,
        workCenter.code,
        workCenter.name,
        workCenter.createdBy ?? null,
      ],
    )
    return mapWorkCenter(r.rows[0] as WorkCenterRow)
  }

  async update(id: string, patch: Record<string, unknown>, actor: string | null) {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch['code'] !== undefined) add('code', patch['code'])
    if (patch['name'] !== undefined) add('name', patch['name'])
    if (patch['deptId'] !== undefined) add('dept_id', patch['deptId'])
    if (patch['plantId'] !== undefined) add('plant_id', patch['plantId'])
    if (patch['status'] !== undefined) {
      add('status', patch['status'])
      add('deleted_at', patch['status'] === 'retired' ? new Date() : null)
    }
    if (sets.length === 0) return this.findById(id)
    add('updated_at', new Date())
    add('updated_by', actor)
    values.push(id)
    const r = await this.client.query(
      `UPDATE work_center SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${WORK_CENTER_COLUMNS}`,
      values,
    )
    return r.rows[0] ? mapWorkCenter(r.rows[0] as WorkCenterRow) : null
  }

  async retire(id: string, actor: string | null) {
    return this.update(id, { status: 'retired' }, actor)
  }

  /** MD-18①：活动设备引用数。 */
  async countActiveEquipment(workCenterId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM equipment WHERE work_center_id = $1 AND status = 'active'`,
      [workCenterId],
    )
    return (r.rows[0] as { n: number }).n
  }

  /** MD-18②：工序表属生产域未建，按 0 预留（建表后接入）。 */
  async countProcessRefs(workCenterId: string): Promise<number> {
    void workCenterId
    return 0
  }

  /** MD-18③：订单工序表属生产域未建，按 0 预留（建表后接入）。 */
  async countOrderProcessRefs(workCenterId: string): Promise<number> {
    void workCenterId
    return 0
  }

  async list(filter: {
    plantIds: string[] | null
    codeLike?: string
    page: number
    pageSize: number
  }): Promise<PageResult<ReturnType<typeof mapWorkCenter>>> {
    const conditions = [`status = 'active'`]
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) {
        return { items: [], total: 0, page: filter.page, pageSize: filter.pageSize }
      }
      values.push(filter.plantIds)
      conditions.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.codeLike !== undefined) {
      values.push(`%${filter.codeLike}%`)
      conditions.push(`code LIKE $${values.length}`)
    }
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${WORK_CENTER_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM work_center WHERE ${conditions.join(' AND ')}
       ORDER BY plant_id, code
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapWorkCenter(row as WorkCenterRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

/**
 * MD-37：库存引用计数实现——stock_balance / stock_transaction 属 inventory 块（0004+），
 * 表或列未落地时按 0 返回（预留，不猜测未冻结 schema；列名按冻结合同 IT-S8 推导）。
 */
export class PgStockReferenceCounter {
  constructor(private readonly client: SqlClient) {}

  /** 表存在且含指定列才计数；否则按 0 预留。 */
  private async count(table: string, column: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const reg = await this.client.query(
      `SELECT to_regclass($1) IS NOT NULL AS exists`,
      [`public.${table}`],
    )
    if ((reg.rows[0] as { exists: boolean } | undefined)?.exists !== true) return 0
    const col = await this.client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       ) AS exists`,
      [table, column],
    )
    if ((col.rows[0] as { exists: boolean } | undefined)?.exists !== true) return 0
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = ANY($1::uuid[])`,
      [ids],
    )
    return (r.rows[0] as { n: number }).n
  }

  async countByLocationIds(locationIds: string[]) {
    return {
      balanceRefs: await this.count('stock_balance', 'location_id', locationIds),
      // 0004 实际列名为 from_location_id / to_location_id（stock_transaction 无单列 location_id）
      transactionRefs:
        (await this.count('stock_transaction', 'from_location_id', locationIds)) +
        (await this.count('stock_transaction', 'to_location_id', locationIds)),
    }
  }

  async countByConversionLineIds(lineIds: string[]) {
    return {
      transactionRefs: await this.count('stock_transaction', 'conversion_revision_id', lineIds),
    }
  }
}

/** masterdata 仓储束（组合根装配用）。 */
export function createPgMasterDataRepositories(client: SqlClient) {
  return {
    materials: new PgMaterialRepository(client),
    conversions: new PgConversionRepository(client),
    equipment: new PgEquipmentRepository(client),
    warehouses: new PgWarehouseRepository(client),
    locations: new PgStorageLocationRepository(client),
    racks: new PgRackRepository(client),
    workCenters: new PgWorkCenterRepository(client),
    stockRefs: new PgStockReferenceCounter(client),
  }
}
