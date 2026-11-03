import type { PageResult } from '@cadenza/contracts'
import type { SqlClient } from './sql-client'
// [L0-整合标记] 跨包新文件 dist 相对导入（Wave3 协议）：待 packages/application/src/index.ts
// 导出 process 面后改为 `from '@cadenza/application'`。type-only 导入：运行时零依赖 dist，
// 但 typecheck/build 解析 application/dist 类型声明（变更端口后须先重建 application）。
import type {
  BomLine,
  BomRevisionRecord,
  MaterialLookup,
  NewOperationDefinition,
  NewOrderOperation,
  NewProcessRevision,
  NewProductFamily,
  OperationDefinitionPatch,
  OperationDefinitionRecord,
  OrderOperationRecord,
  ParameterSpecRevisionRecord,
  ProcessMasterStatus,
  ProcessRevisionKey,
  ProcessRevisionPatch,
  ProcessRevisionStatus,
  ProcessRevisionRepositoryPort,
  ProcessRevisionBase,
  ProductFamilyPatch,
  ProductFamilyRecord,
  ProductionOrderPatch,
  ProductionOrderRecord,
  ProductionOrderStatus,
  RouteRevisionRecord,
  RouteStep,
  WorkCenterLookup,
} from '@cadenza/application'

/**
 * process 域仓储的 PostgreSQL 实现（对应 0005 迁移七表；端口接口见
 * application/src/process-repositories.ts）。
 * 全部参数化查询；numeric 出参规范化为十进制字符串（去尾零）；
 * jsonb（BOM 行/路线步/参数/料品快照）直接以 pg 解析对象往返。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** numeric 列出参规范化："3060.0000" → "3060"；"1.0200" → "1.02"。 */
function dec(value: string | number | null): string | null {
  if (value === null) return null
  const text = String(value)
  if (!text.includes('.')) return text
  return text.replace(/0+$/, '').replace(/\.$/, '')
}

// ---------------- 产品族 ----------------

interface ProductFamilyRow {
  id: string
  enterprise_id: string
  plant_id: string
  code: string
  name: string
  description: string | null
  status: 'active' | 'retired'
  deleted_at: Date | string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

const FAMILY_COLUMNS = `id, enterprise_id, plant_id, code, name, description, status,
  deleted_at, created_at, created_by, updated_at, updated_by`

function mapFamily(r: ProductFamilyRow): ProductFamilyRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    code: r.code,
    name: r.name,
    description: r.description,
    status: r.status,
    deletedAt: r.deleted_at ? iso(r.deleted_at) : null,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgProductFamilyRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<ProductFamilyRecord | null> {
    const r = await this.client.query(
      `SELECT ${FAMILY_COLUMNS} FROM product_family WHERE id = $1`,
      [id],
    )
    return r.rows[0] ? mapFamily(r.rows[0] as ProductFamilyRow) : null
  }

  async findActiveByPlantAndCode(plantId: string, code: string): Promise<ProductFamilyRecord | null> {
    const r = await this.client.query(
      `SELECT ${FAMILY_COLUMNS} FROM product_family
       WHERE plant_id = $1 AND code = $2 AND status = 'active'`,
      [plantId, code],
    )
    return r.rows[0] ? mapFamily(r.rows[0] as ProductFamilyRow) : null
  }

  async insert(family: NewProductFamily): Promise<ProductFamilyRecord> {
    const r = await this.client.query(
      `INSERT INTO product_family (id, enterprise_id, plant_id, code, name, description, status, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, 'active', $7)
       RETURNING ${FAMILY_COLUMNS}`,
      [
        family.id ?? null,
        family.enterpriseId,
        family.plantId,
        family.code,
        family.name,
        family.description ?? null,
        family.createdBy ?? null,
      ],
    )
    return mapFamily(r.rows[0] as ProductFamilyRow)
  }

  async update(
    id: string,
    patch: ProductFamilyPatch,
    actor: string | null,
  ): Promise<ProductFamilyRecord | null> {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown) => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch.name !== undefined) add('name', patch.name)
    if (patch.description !== undefined) add('description', patch.description)
    if (patch.status !== undefined) {
      add('status', patch.status)
      add('deleted_at', patch.status === 'retired' ? new Date() : null)
    }
    if (sets.length === 0) return this.findById(id)
    add('updated_at', new Date())
    add('updated_by', actor)
    values.push(id)
    const r = await this.client.query(
      `UPDATE product_family SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${FAMILY_COLUMNS}`,
      values,
    )
    return r.rows[0] ? mapFamily(r.rows[0] as ProductFamilyRow) : null
  }

  async retire(id: string, actor: string | null): Promise<ProductFamilyRecord | null> {
    return this.update(id, { status: 'retired' }, actor)
  }

  /** 活动占用：未失效版本（BOM/路线/参数）+ 未作废订单。 */
  async countActiveUsages(familyId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT (
         (SELECT count(*) FROM manufacturing_bom_revision WHERE product_family_id = $1 AND status <> 'retired')
       + (SELECT count(*) FROM route_revision WHERE product_family_id = $1 AND status <> 'retired')
       + (SELECT count(*) FROM parameter_spec_revision WHERE product_family_id = $1 AND status <> 'retired')
       + (SELECT count(*) FROM production_order WHERE product_family_id = $1 AND order_status <> 'voided')
       )::int AS n`,
      [familyId],
    )
    return (r.rows[0] as { n: number }).n
  }

  async list(filter: {
    plantIds: string[] | null
    nameLike?: string
    codeLike?: string
    page: number
    pageSize: number
  }): Promise<PageResult<ProductFamilyRecord>> {
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
      `SELECT ${FAMILY_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM product_family WHERE ${conditions.join(' AND ')}
       ORDER BY plant_id, code
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapFamily(row as ProductFamilyRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

// ---------------- 版本表（BOM/路线/参数规范，泛型实现） ----------------

interface RevisionRowBase {
  id: string
  enterprise_id: string
  plant_id: string
  product_family_id: string
  version: number
  status: ProcessRevisionStatus
  remark: string | null
  published_at: Date | string | null
  published_by: string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

interface RevisionRepoConfig<TRecord extends ProcessRevisionBase> {
  table: 'manufacturing_bom_revision' | 'route_revision' | 'parameter_spec_revision'
  /** 内容列（lines/steps/parameters）。 */
  contentColumn: 'lines' | 'steps' | 'parameters'
  /** 版本定位键 WHERE 构造（缺失必填键段时抛编程错误）。 */
  keyValues(key: ProcessRevisionKey): unknown[]
  keyClauses(key: ProcessRevisionKey): string[]
  extraColumns: string
  mapRow(row: RevisionRowBase & Record<string, unknown>): TRecord
}

const REVISION_BASE_COLUMNS = `id, enterprise_id, plant_id, product_family_id, version, status,
  remark, published_at, published_by, created_at, created_by, updated_at, updated_by`

export class PgProcessRevisionRepository<TRecord extends ProcessRevisionBase>
  implements ProcessRevisionRepositoryPort<TRecord>
{
  constructor(
    private readonly client: SqlClient,
    private readonly config: RevisionRepoConfig<TRecord>,
  ) {}

  private columns(): string {
    return `${REVISION_BASE_COLUMNS}${this.config.extraColumns ? `, ${this.config.extraColumns}` : ''}`
  }

  async findById(id: string): Promise<TRecord | null> {
    const r = await this.client.query(
      `SELECT ${this.columns()} FROM ${this.config.table} WHERE id = $1`,
      [id],
    )
    return r.rows[0] ? this.config.mapRow(r.rows[0]) : null
  }

  async listVersionsByKey(key: ProcessRevisionKey): Promise<number[]> {
    const values = this.config.keyValues(key)
    const clauses = this.config.keyClauses(key)
    const r = await this.client.query(
      `SELECT version FROM ${this.config.table} WHERE ${clauses.join(' AND ')}`,
      values,
    )
    return r.rows.map((row) => (row as { version: number }).version)
  }

  async findPublishedByKey(key: ProcessRevisionKey): Promise<TRecord | null> {
    const values = this.config.keyValues(key)
    const clauses = this.config.keyClauses(key)
    const r = await this.client.query(
      `SELECT ${this.columns()} FROM ${this.config.table}
       WHERE ${clauses.join(' AND ')} AND status = 'published'`,
      values,
    )
    return r.rows[0] ? this.config.mapRow(r.rows[0]) : null
  }

  async insert(revision: NewProcessRevision): Promise<TRecord> {
    const content = JSON.stringify(revision.content)
    const base: unknown[] = [
      revision.id ?? null,
      revision.enterpriseId,
      revision.plantId,
      revision.productFamilyId,
    ]
    let sql: string
    let values: unknown[]
    if (this.config.table === 'manufacturing_bom_revision') {
      sql = `INSERT INTO manufacturing_bom_revision
           (id, enterprise_id, plant_id, product_family_id, material_id, version, status, lines,
            remark, created_by)
         VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
         RETURNING ${this.columns()}`
      values = [
        ...base,
        revision.materialId ?? null,
        revision.version,
        revision.initialStatus ?? 'draft',
        content,
        revision.remark ?? null,
        revision.createdBy ?? null,
      ]
    } else if (this.config.table === 'route_revision') {
      sql = `INSERT INTO route_revision
           (id, enterprise_id, plant_id, product_family_id, version, status, steps, remark, created_by)
         VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         RETURNING ${this.columns()}`
      values = [
        ...base,
        revision.version,
        revision.initialStatus ?? 'draft',
        content,
        revision.remark ?? null,
        revision.createdBy ?? null,
      ]
    } else {
      sql = `INSERT INTO parameter_spec_revision
           (id, enterprise_id, plant_id, product_family_id, name, version, status, parameters,
            remark, created_by)
         VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
         RETURNING ${this.columns()}`
      values = [
        ...base,
        revision.name ?? null,
        revision.version,
        revision.initialStatus ?? 'draft',
        content,
        revision.remark ?? null,
        revision.createdBy ?? null,
      ]
    }
    const r = await this.client.query(sql, values)
    return this.config.mapRow(r.rows[0])
  }

  async update(id: string, patch: ProcessRevisionPatch, actor: string | null): Promise<TRecord | null> {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown) => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch.content !== undefined) add(this.config.contentColumn, JSON.stringify(patch.content))
    if (patch.remark !== undefined) add('remark', patch.remark)
    if (patch.status !== undefined) add('status', patch.status)
    if (sets.length === 0) return this.findById(id)
    add('updated_at', new Date())
    add('updated_by', actor)
    values.push(id)
    const r = await this.client.query(
      `UPDATE ${this.config.table} SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${this.columns()}`,
      values,
    )
    return r.rows[0] ? this.config.mapRow(r.rows[0]) : null
  }

  async updateStatus(
    id: string,
    next: ProcessRevisionStatus,
    actor: string | null,
    occurredAt: Date,
  ): Promise<TRecord | null> {
    const r = await this.client.query(
      `UPDATE ${this.config.table}
       SET status = $1,
           published_at = CASE WHEN $1 = 'published' THEN $2 ELSE published_at END,
           published_by = CASE WHEN $1 = 'published' THEN $3 ELSE published_by END,
           updated_at = $2, updated_by = $3
       WHERE id = $4
       RETURNING ${this.columns()}`,
      [next, occurredAt, actor, id],
    )
    return r.rows[0] ? this.config.mapRow(r.rows[0]) : null
  }

  async retire(id: string, actor: string | null): Promise<TRecord | null> {
    return this.updateStatus(id, 'retired', actor, new Date())
  }

  async list(filter: {
    plantIds: string[] | null
    productFamilyId?: string
    status?: ProcessRevisionStatus
    page: number
    pageSize: number
  }): Promise<PageResult<TRecord>> {
    const conditions = [`status <> 'retired'`]
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) {
        return { items: [], total: 0, page: filter.page, pageSize: filter.pageSize }
      }
      values.push(filter.plantIds)
      conditions.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.productFamilyId !== undefined) {
      values.push(filter.productFamilyId)
      conditions.push(`product_family_id = $${values.length}`)
    }
    if (filter.status !== undefined) {
      values.push(filter.status)
      conditions.push(`status = $${values.length}`)
    }
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${this.columns()}, count(*) OVER () ::int AS total_count
       FROM ${this.config.table} WHERE ${conditions.join(' AND ')}
       ORDER BY plant_id, product_family_id, version DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => this.config.mapRow(row)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

function mapRevisionBase(r: RevisionRowBase): ProcessRevisionBase {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    productFamilyId: r.product_family_id,
    version: r.version,
    status: r.status,
    remark: r.remark,
    publishedAt: r.published_at ? iso(r.published_at) : null,
    publishedBy: r.published_by,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export function createPgBomRevisionRepository(client: SqlClient): PgProcessRevisionRepository<BomRevisionRecord> {
  return new PgProcessRevisionRepository<BomRevisionRecord>(client, {
    table: 'manufacturing_bom_revision',
    contentColumn: 'lines',
    extraColumns: 'material_id, lines',
    keyClauses: () => ['plant_id = $1', 'material_id = $2'],
    keyValues: (key) => {
      if (key.materialId === undefined) throw new Error('BOM 版本定位键缺少 materialId（编程错误）')
      return [key.plantId, key.materialId]
    },
    mapRow: (row) => ({
      ...mapRevisionBase(row),
      materialId: (row as unknown as { material_id: string }).material_id,
      lines: ((row as unknown as { lines: BomLine[] }).lines ?? []) as BomLine[],
    }),
  })
}

export function createPgRouteRevisionRepository(client: SqlClient): PgProcessRevisionRepository<RouteRevisionRecord> {
  return new PgProcessRevisionRepository<RouteRevisionRecord>(client, {
    table: 'route_revision',
    contentColumn: 'steps',
    extraColumns: 'steps',
    keyClauses: () => ['plant_id = $1', 'product_family_id = $2'],
    keyValues: (key) => {
      if (key.productFamilyId === undefined) throw new Error('路线版本定位键缺少 productFamilyId（编程错误）')
      return [key.plantId, key.productFamilyId]
    },
    mapRow: (row) => ({
      ...mapRevisionBase(row),
      steps: ((row as unknown as { steps: RouteStep[] }).steps ?? []) as RouteStep[],
    }),
  })
}

export function createPgParameterSpecRepository(
  client: SqlClient,
): PgProcessRevisionRepository<ParameterSpecRevisionRecord> {
  return new PgProcessRevisionRepository<ParameterSpecRevisionRecord>(client, {
    table: 'parameter_spec_revision',
    contentColumn: 'parameters',
    extraColumns: 'name, parameters',
    keyClauses: () => ['plant_id = $1', 'product_family_id = $2', 'name = $3'],
    keyValues: (key) => {
      if (key.productFamilyId === undefined || key.name === undefined) {
        throw new Error('参数规范版本定位键缺少 productFamilyId/name（编程错误）')
      }
      return [key.plantId, key.productFamilyId, key.name]
    },
    mapRow: (row) => ({
      ...mapRevisionBase(row),
      name: (row as unknown as { name: string }).name,
      parameters: ((row as unknown as { parameters: unknown[] }).parameters ?? []) as unknown[],
    }),
  })
}

// ---------------- 工序主数据 ----------------

interface OperationRow {
  id: string
  enterprise_id: string
  plant_id: string
  dept_id: string
  work_center_id: string
  company_org_code: string
  code: string
  name: string
  remark: string | null
  status: 'active' | 'retired'
  deleted_at: Date | string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

const OPERATION_COLUMNS = `id, enterprise_id, plant_id, dept_id, work_center_id, company_org_code,
  code, name, remark, status, deleted_at, created_at, created_by, updated_at, updated_by`

function mapOperation(r: OperationRow): OperationDefinitionRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    deptId: r.dept_id,
    workCenterId: r.work_center_id,
    companyOrgCode: r.company_org_code,
    code: r.code,
    name: r.name,
    remark: r.remark,
    status: r.status,
    deletedAt: r.deleted_at ? iso(r.deleted_at) : null,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgOperationDefinitionRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<OperationDefinitionRecord | null> {
    const r = await this.client.query(
      `SELECT ${OPERATION_COLUMNS} FROM operation_definition WHERE id = $1`,
      [id],
    )
    return r.rows[0] ? mapOperation(r.rows[0] as OperationRow) : null
  }

  async findActiveByDeptAndName(deptId: string, name: string): Promise<OperationDefinitionRecord | null> {
    const r = await this.client.query(
      `SELECT ${OPERATION_COLUMNS} FROM operation_definition
       WHERE dept_id = $1 AND name = $2 AND status = 'active'`,
      [deptId, name],
    )
    return r.rows[0] ? mapOperation(r.rows[0] as OperationRow) : null
  }

  async findActiveByOrgAndCode(
    companyOrgCode: string,
    code: string,
  ): Promise<OperationDefinitionRecord | null> {
    const r = await this.client.query(
      `SELECT ${OPERATION_COLUMNS} FROM operation_definition
       WHERE company_org_code = $1 AND code = $2 AND status = 'active'`,
      [companyOrgCode, code],
    )
    return r.rows[0] ? mapOperation(r.rows[0] as OperationRow) : null
  }

  async insert(operation: NewOperationDefinition): Promise<OperationDefinitionRecord> {
    const r = await this.client.query(
      `INSERT INTO operation_definition
         (id, enterprise_id, plant_id, dept_id, work_center_id, company_org_code, code, name, remark,
          status, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10)
       RETURNING ${OPERATION_COLUMNS}`,
      [
        operation.id ?? null,
        operation.enterpriseId,
        operation.plantId,
        operation.deptId,
        operation.workCenterId,
        operation.companyOrgCode,
        operation.code,
        operation.name,
        operation.remark ?? null,
        operation.createdBy ?? null,
      ],
    )
    return mapOperation(r.rows[0] as OperationRow)
  }

  async update(
    id: string,
    patch: OperationDefinitionPatch,
    actor: string | null,
  ): Promise<OperationDefinitionRecord | null> {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown) => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch.name !== undefined) add('name', patch.name)
    if (patch.remark !== undefined) add('remark', patch.remark)
    if (patch.workCenterId !== undefined) add('work_center_id', patch.workCenterId)
    if (patch.deptId !== undefined) add('dept_id', patch.deptId)
    if (patch.status !== undefined) {
      add('status', patch.status)
      add('deleted_at', patch.status === 'retired' ? new Date() : null)
    }
    if (sets.length === 0) return this.findById(id)
    add('updated_at', new Date())
    add('updated_by', actor)
    values.push(id)
    const r = await this.client.query(
      `UPDATE operation_definition SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${OPERATION_COLUMNS}`,
      values,
    )
    return r.rows[0] ? mapOperation(r.rows[0] as OperationRow) : null
  }

  async retire(id: string, actor: string | null): Promise<OperationDefinitionRecord | null> {
    return this.update(id, { status: 'retired' }, actor)
  }

  /** [底稿 A1-3]① 模板引用：工序模板表未建，按 0 预留（建表后接入）。 */
  async countTemplateRefs(operationId: string): Promise<number> {
    void operationId
    return 0
  }

  /** [底稿 A1-3]② 订单排产引用：排产表属 T09 未建，按 0 预留（建表后接入）。 */
  async countSchedulingRefs(operationId: string): Promise<number> {
    void operationId
    return 0
  }

  /** [底稿 A1-3]③ 订单工序引用（order_operation，真实计数）。 */
  async countOrderOperationRefs(operationId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM order_operation WHERE operation_definition_id = $1`,
      [operationId],
    )
    return (r.rows[0] as { n: number }).n
  }

  async list(filter: {
    plantIds: string[] | null
    nameLike?: string
    codeLike?: string
    page: number
    pageSize: number
  }): Promise<PageResult<OperationDefinitionRecord>> {
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
      `SELECT ${OPERATION_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM operation_definition WHERE ${conditions.join(' AND ')}
       ORDER BY plant_id, code
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapOperation(row as OperationRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

// ---------------- 生产订单 ----------------

interface OrderRow {
  id: string
  enterprise_id: string
  plant_id: string
  order_no: string
  order_type: string | null
  sales_contract_no: string | null
  sales_order_no: string | null
  line_no: string | null
  material_id: string
  material_snapshot: Record<string, unknown> | null
  product_family_id: string | null
  production_dept_id: string
  production_qty: string
  uom: string
  overrun_ratio: string | null
  order_status: ProductionOrderStatus
  process_config_status: 'unconfigured' | 'configured'
  process_confirmed_at: Date | string | null
  suspended: boolean
  suspended_reason: string | null
  actual_start_at: Date | string | null
  actual_finish_at: Date | string | null
  business_closed_at: Date | string | null
  erp_closed_at: Date | string | null
  erp_closed_by: string | null
  bom_revision_id: string | null
  route_revision_id: string | null
  current_settings_version: number
  planned_start_at: Date | string | null
  planned_finish_at: Date | string | null
  segment_requirement: string | null
  remark: string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

const ORDER_COLUMNS = `id, enterprise_id, plant_id, order_no, order_type, sales_contract_no,
  sales_order_no, line_no, material_id, material_snapshot, product_family_id, production_dept_id,
  production_qty, uom, overrun_ratio, order_status, process_config_status, process_confirmed_at,
  suspended, suspended_reason, actual_start_at, actual_finish_at, business_closed_at, erp_closed_at,
  erp_closed_by, bom_revision_id, route_revision_id, current_settings_version, planned_start_at,
  planned_finish_at, segment_requirement, remark, created_at, created_by, updated_at, updated_by`

function mapOrder(r: OrderRow): ProductionOrderRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    orderNo: r.order_no,
    orderType: r.order_type,
    salesContractNo: r.sales_contract_no,
    salesOrderNo: r.sales_order_no,
    lineNo: r.line_no,
    materialId: r.material_id,
    materialSnapshot: r.material_snapshot ?? {},
    productFamilyId: r.product_family_id,
    productionDeptId: r.production_dept_id,
    productionQty: dec(r.production_qty) ?? '0',
    uom: r.uom,
    overrunRatio: dec(r.overrun_ratio),
    orderStatus: r.order_status,
    processConfigStatus: r.process_config_status,
    processConfirmedAt: r.process_confirmed_at ? iso(r.process_confirmed_at) : null,
    suspended: r.suspended,
    suspendedReason: r.suspended_reason,
    actualStartAt: r.actual_start_at ? iso(r.actual_start_at) : null,
    actualFinishAt: r.actual_finish_at ? iso(r.actual_finish_at) : null,
    businessClosedAt: r.business_closed_at ? iso(r.business_closed_at) : null,
    erpClosedAt: r.erp_closed_at ? iso(r.erp_closed_at) : null,
    erpClosedBy: r.erp_closed_by,
    bomRevisionId: r.bom_revision_id,
    routeRevisionId: r.route_revision_id,
    currentSettingsVersion: r.current_settings_version,
    plannedStartAt: r.planned_start_at ? iso(r.planned_start_at) : null,
    plannedFinishAt: r.planned_finish_at ? iso(r.planned_finish_at) : null,
    segmentRequirement: r.segment_requirement,
    remark: r.remark,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgProductionOrderRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<ProductionOrderRecord | null> {
    const r = await this.client.query(`SELECT ${ORDER_COLUMNS} FROM production_order WHERE id = $1`, [id])
    return r.rows[0] ? mapOrder(r.rows[0] as OrderRow) : null
  }

  async findByEnterpriseAndOrderNo(enterpriseId: string, orderNo: string): Promise<ProductionOrderRecord | null> {
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM production_order WHERE enterprise_id = $1 AND order_no = $2`,
      [enterpriseId, orderNo],
    )
    return r.rows[0] ? mapOrder(r.rows[0] as OrderRow) : null
  }

  async insert(order: {
    id?: string
    enterpriseId: string
    plantId: string
    orderNo: string
    orderType?: string | null
    salesContractNo?: string | null
    salesOrderNo?: string | null
    lineNo?: string | null
    materialId: string
    materialSnapshot?: Record<string, unknown>
    productFamilyId?: string | null
    productionDeptId: string
    productionQty: string
    uom: string
    overrunRatio?: string | null
    orderStatus?: ProductionOrderStatus
    processConfigStatus?: 'unconfigured' | 'configured'
    processConfirmedAt?: Date | null
    bomRevisionId?: string | null
    routeRevisionId?: string | null
    plannedStartAt?: Date | null
    plannedFinishAt?: Date | null
    segmentRequirement?: string | null
    remark?: string | null
    createdBy?: string | null
  }): Promise<ProductionOrderRecord> {
    const r = await this.client.query(
      `INSERT INTO production_order
         (id, enterprise_id, plant_id, order_no, order_type, sales_contract_no, sales_order_no, line_no,
          material_id, material_snapshot, product_family_id, production_dept_id, production_qty, uom,
          overrun_ratio, order_status, process_config_status, process_confirmed_at, suspended,
          bom_revision_id, route_revision_id, current_settings_version, planned_start_at,
          planned_finish_at, segment_requirement, remark, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
               $13::numeric, $14, $15::numeric, $16, $17, $18, false, $19, $20, 1, $21, $22, $23, $24, $25)
       RETURNING ${ORDER_COLUMNS}`,
      [
        order.id ?? null,
        order.enterpriseId,
        order.plantId,
        order.orderNo,
        order.orderType ?? null,
        order.salesContractNo ?? null,
        order.salesOrderNo ?? null,
        order.lineNo ?? null,
        order.materialId,
        JSON.stringify(order.materialSnapshot ?? {}),
        order.productFamilyId ?? null,
        order.productionDeptId,
        order.productionQty,
        order.uom,
        order.overrunRatio ?? null,
        order.orderStatus ?? 'approved',
        order.processConfigStatus ?? 'unconfigured',
        // timestamptz 参数须经 iso() 转字符串：Date 直传在非 UTC 本地时区（如 GMT+0800）会被
        // 驱动序列化为 PG 无法解析的本地格式（R1 期初在制导入经 process.order.receive 实测发现）。
        order.processConfirmedAt ? iso(order.processConfirmedAt) : null,
        order.bomRevisionId ?? null,
        order.routeRevisionId ?? null,
        order.plannedStartAt ? iso(order.plannedStartAt) : null,
        order.plannedFinishAt ? iso(order.plannedFinishAt) : null,
        order.segmentRequirement ?? null,
        order.remark ?? null,
        order.createdBy ?? null,
      ],
    )
    return mapOrder(r.rows[0] as OrderRow)
  }

  async update(
    id: string,
    patch: ProductionOrderPatch,
    actor: string | null,
  ): Promise<ProductionOrderRecord | null> {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown) => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch.orderStatus !== undefined) add('order_status', patch.orderStatus)
    if (patch.processConfigStatus !== undefined) add('process_config_status', patch.processConfigStatus)
    if (patch.processConfirmedAt !== undefined) add('process_confirmed_at', patch.processConfirmedAt)
    if (patch.suspended !== undefined) add('suspended', patch.suspended)
    if (patch.suspendedReason !== undefined) add('suspended_reason', patch.suspendedReason)
    if (patch.actualStartAt !== undefined) add('actual_start_at', patch.actualStartAt)
    if (patch.bomRevisionId !== undefined) add('bom_revision_id', patch.bomRevisionId)
    if (patch.routeRevisionId !== undefined) add('route_revision_id', patch.routeRevisionId)
    if (patch.productFamilyId !== undefined) add('product_family_id', patch.productFamilyId)
    if (sets.length === 0) return this.findById(id)
    add('updated_at', new Date())
    add('updated_by', actor)
    values.push(id)
    const r = await this.client.query(
      `UPDATE production_order SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${ORDER_COLUMNS}`,
      values,
    )
    return r.rows[0] ? mapOrder(r.rows[0] as OrderRow) : null
  }

  async list(filter: {
    plantIds: string[] | null
    orderNoLike?: string
    statuses?: ProductionOrderStatus[]
    suspended?: boolean
    page: number
    pageSize: number
  }): Promise<PageResult<ProductionOrderRecord>> {
    const conditions = [`order_status <> 'voided'`]
    const values: unknown[] = []
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) {
        return { items: [], total: 0, page: filter.page, pageSize: filter.pageSize }
      }
      values.push(filter.plantIds)
      conditions.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.orderNoLike !== undefined) {
      values.push(`%${filter.orderNoLike}%`)
      conditions.push(`order_no LIKE $${values.length}`)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      // 显式含 voided 时放开默认排除（PRD：列表默认筛选不含已作废，可显式查询）
      conditions[0] = `true`
      values.push(filter.statuses)
      conditions.push(`order_status = ANY($${values.length})`)
    }
    if (filter.suspended !== undefined) {
      values.push(filter.suspended)
      conditions.push(`suspended = $${values.length}`)
    }
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM production_order WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, order_no
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapOrder(row as OrderRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

// ---------------- 订单工序 ----------------

interface OrderOperationRow {
  id: string
  enterprise_id: string
  plant_id: string
  order_id: string
  seq: number
  settings_version: number
  execution_status: 'pending' | 'executed'
  operation_definition_id: string
  operation_code: string
  operation_name: string
  operation_remark: string | null
  core_multiple: number
  strand_factor: string | null
  offline_qty: string
  work_center_id: string
  work_center_code: string
  work_center_name: string
  uom: string
  production_dept_id: string
  route_revision_id: string | null
  bom_revision_id: string | null
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

const ORDER_OPERATION_COLUMNS = `id, enterprise_id, plant_id, order_id, seq, settings_version,
  execution_status, operation_definition_id, operation_code, operation_name, operation_remark,
  core_multiple, strand_factor, offline_qty, work_center_id, work_center_code, work_center_name,
  uom, production_dept_id, route_revision_id, bom_revision_id, created_at, created_by, updated_at,
  updated_by`

function mapOrderOperation(r: OrderOperationRow): OrderOperationRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    orderId: r.order_id,
    seq: r.seq,
    settingsVersion: r.settings_version,
    executionStatus: r.execution_status,
    operationDefinitionId: r.operation_definition_id,
    operationCode: r.operation_code,
    operationName: r.operation_name,
    operationRemark: r.operation_remark,
    coreMultiple: r.core_multiple,
    strandFactor: dec(r.strand_factor),
    offlineQty: dec(r.offline_qty) ?? '0',
    workCenterId: r.work_center_id,
    workCenterCode: r.work_center_code,
    workCenterName: r.work_center_name,
    uom: r.uom,
    productionDeptId: r.production_dept_id,
    routeRevisionId: r.route_revision_id,
    bomRevisionId: r.bom_revision_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

export class PgOrderOperationRepository {
  constructor(private readonly client: SqlClient) {}

  async listByOrder(orderId: string): Promise<OrderOperationRecord[]> {
    const r = await this.client.query(
      `SELECT ${ORDER_OPERATION_COLUMNS} FROM order_operation
       WHERE order_id = $1 ORDER BY seq, settings_version`,
      [orderId],
    )
    return r.rows.map((row) => mapOrderOperation(row as OrderOperationRow))
  }

  async listCurrentByOrder(orderId: string, settingsVersion: number): Promise<OrderOperationRecord[]> {
    const r = await this.client.query(
      `SELECT ${ORDER_OPERATION_COLUMNS} FROM order_operation
       WHERE order_id = $1 AND settings_version = $2 ORDER BY seq`,
      [orderId, settingsVersion],
    )
    return r.rows.map((row) => mapOrderOperation(row as OrderOperationRow))
  }

  async insertBatch(operations: NewOrderOperation[]): Promise<OrderOperationRecord[]> {
    if (operations.length === 0) return []
    const values: unknown[] = []
    const tuples = operations.map((op) => {
      const tuple: unknown[] = [
        op.id ?? null,
        op.enterpriseId,
        op.plantId,
        op.orderId,
        op.seq,
        op.settingsVersion ?? 1,
        op.operationDefinitionId,
        op.operationCode,
        op.operationName,
        op.operationRemark ?? null,
        op.coreMultiple,
        op.strandFactor ?? null,
        op.offlineQty,
        op.workCenterId,
        op.workCenterCode,
        op.workCenterName,
        op.uom,
        op.productionDeptId,
        op.routeRevisionId ?? null,
        op.bomRevisionId ?? null,
        op.createdBy ?? null,
      ]
      const startIndex = values.length + 1
      values.push(...tuple)
      // 首列 id 允许调用方缺省 → 库端生成（与单行 insert 的 COALESCE 口径一致）
      const placeholders = tuple.map((_, i) =>
        i === 0 ? `COALESCE($${startIndex}, gen_random_uuid())` : `$${startIndex + i}`,
      )
      return `(${placeholders.join(', ')})`
    })
    const r = await this.client.query(
      `INSERT INTO order_operation
         (id, enterprise_id, plant_id, order_id, seq, settings_version, operation_definition_id,
          operation_code, operation_name, operation_remark, core_multiple, strand_factor,
          offline_qty, work_center_id, work_center_code, work_center_name, uom, production_dept_id,
          route_revision_id, bom_revision_id, created_by)
       VALUES ${tuples.join(', ')}
       RETURNING ${ORDER_OPERATION_COLUMNS}`,
      values,
    )
    return r.rows.map((row) => mapOrderOperation(row as OrderOperationRow))
  }

  async countByOrder(orderId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM order_operation WHERE order_id = $1`,
      [orderId],
    )
    return (r.rows[0] as { n: number }).n
  }
}

// ---------------- masterdata 只读查询（0003 表窄读） ----------------

export class PgProcessMasterDataLookups {
  constructor(private readonly client: SqlClient) {}

  async findMaterial(id: string): Promise<MaterialLookup | null> {
    const r = await this.client.query(
      `SELECT id, org_scope_id, code, name, material_type, base_uom, status
       FROM material WHERE id = $1`,
      [id],
    )
    const row = r.rows[0] as
      | {
          id: string
          org_scope_id: string
          code: string
          name: string
          material_type: number
          base_uom: string
          status: ProcessMasterStatus
        }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      orgScopeId: row.org_scope_id,
      code: row.code,
      name: row.name,
      materialType: row.material_type,
      baseUom: row.base_uom,
      status: row.status,
    }
  }

  async findWorkCenter(id: string): Promise<WorkCenterLookup | null> {
    const r = await this.client.query(
      `SELECT id, enterprise_id, plant_id, dept_id, code, name, status
       FROM work_center WHERE id = $1`,
      [id],
    )
    const row = r.rows[0] as
      | {
          id: string
          enterprise_id: string
          plant_id: string
          dept_id: string
          code: string
          name: string
          status: ProcessMasterStatus
        }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      enterpriseId: row.enterprise_id,
      plantId: row.plant_id,
      deptId: row.dept_id,
      code: row.code,
      name: row.name,
      status: row.status,
    }
  }
}

/** process 仓储束（组合根装配用）。 */
export function createPgProcessRepositories(client: SqlClient) {
  return {
    families: new PgProductFamilyRepository(client),
    boms: createPgBomRevisionRepository(client),
    routes: createPgRouteRevisionRepository(client),
    parameters: createPgParameterSpecRepository(client),
    operations: new PgOperationDefinitionRepository(client),
    orders: new PgProductionOrderRepository(client),
    orderOperations: new PgOrderOperationRepository(client),
    lookups: new PgProcessMasterDataLookups(client),
  }
}
