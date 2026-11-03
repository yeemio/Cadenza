import type {
  AuthSessionRecord,
  AuthSessionRepository,
  AuditFactInput,
  AuditWriter,
  NewAuthSession,
  NewOrgNode,
  NewRole,
  NewUserAccount,
  OrgNodePatch,
  OrgNodeRecord,
  OrgNodeRepository,
  RolePatch,
  RoleRecord,
  RoleRepository,
  ScopeGrantRecord,
  ScopeGrantRepository,
  ScopeGrantUpsert,
  UserAccountPatch,
  UserAccountRecord,
  UserAccountRepository,
} from '@cadenza/application'
import type { OrgNodeKind, ScopeType } from '@cadenza/domain'
import type { SqlClient } from './sql-client'

/**
 * org 域仓储的 PostgreSQL 实现（implements application 端口；依赖方向 persistence → application）。
 * 全部参数化查询；时间戳出参统一 ISO-8601 字符串（OA-31 系统时间）。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

interface OrgNodeRow {
  id: string
  kind: OrgNodeKind
  code: string
  name: string
  parent_id: string | null
  parent_kind: string | null
  path: string
  depth: number
  plant_code: string | null
  company_org_code: string | null
  dept_category: number | null
  status: 'active' | 'retired'
  enterprise_id: string
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapNode(r: OrgNodeRow): OrgNodeRecord {
  return {
    id: r.id,
    kind: r.kind,
    code: r.code,
    name: r.name,
    parentId: r.parent_id,
    parentKind: r.parent_kind,
    path: r.path,
    depth: r.depth,
    plantCode: r.plant_code,
    companyOrgCode: r.company_org_code,
    deptCategory: r.dept_category,
    status: r.status,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

interface UserRow {
  id: string
  enterprise_id: string
  login_name: string
  password_hash: string
  display_name: string
  dept_id: string
  workshop_dept_id: string | null
  role_id: string
  login_platform: 'WEB' | 'PDA'
  account_status: 'enabled' | 'disabled'
  phone: string | null
  plant_id: string
  failed_login_count: number
  locked_until: Date | string | null
  status: 'active' | 'retired'
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapUser(r: UserRow): UserAccountRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    loginName: r.login_name,
    passwordHash: r.password_hash,
    displayName: r.display_name,
    deptId: r.dept_id,
    workshopDeptId: r.workshop_dept_id,
    roleId: r.role_id,
    loginPlatform: r.login_platform,
    accountStatus: r.account_status,
    phone: r.phone,
    plantId: r.plant_id,
    failedLoginCount: r.failed_login_count,
    lockedUntil: isoOrNull(r.locked_until),
    status: r.status,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

interface RoleRow {
  id: string
  enterprise_id: string
  name: string
  alias: string
  sort: number
  is_system: number
  parent_role_id: string | null
  status: 'active' | 'retired'
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapRole(r: RoleRow): RoleRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    name: r.name,
    alias: r.alias,
    sort: r.sort,
    isSystem: r.is_system,
    parentRoleId: r.parent_role_id,
    status: r.status,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

interface GrantRow {
  id: string
  enterprise_id: string
  principal_type: 'role' | 'user'
  principal_id: string
  permissions: string[]
  scope_type: ScopeType
  scope_object_id: string
  status: 'active' | 'retired'
  created_at: Date | string
  created_by: string | null
  updated_at: Date | string
  updated_by: string | null
}

function mapGrant(r: GrantRow): ScopeGrantRecord {
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    principalType: r.principal_type,
    principalId: r.principal_id,
    permissions: r.permissions ?? [],
    scopeType: r.scope_type,
    scopeObjectId: r.scope_object_id,
    status: r.status,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by,
  }
}

interface SessionRow {
  id: string
  token_hash: string
  user_id: string
  enterprise_id: string
  plant_id: string | null
  login_platform: string
  issued_at: Date | string
  expires_at: Date | string
  revoked_at: Date | string | null
}

function mapSession(r: SessionRow): AuthSessionRecord {
  return {
    id: r.id,
    tokenHash: r.token_hash,
    userId: r.user_id,
    enterpriseId: r.enterprise_id,
    plantId: r.plant_id,
    loginPlatform: r.login_platform,
    issuedAt: iso(r.issued_at),
    expiresAt: iso(r.expires_at),
    revokedAt: isoOrNull(r.revoked_at),
  }
}

const NODE_COLUMNS = `id, kind, code, name, parent_id, parent_kind, path, depth, plant_code,
  company_org_code, dept_category, status, enterprise_id, created_at, created_by, updated_at, updated_by`

export class PgOrgNodeRepository implements OrgNodeRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<OrgNodeRecord | null> {
    const r = await this.client.query(`SELECT ${NODE_COLUMNS} FROM org_node WHERE id = $1`, [id])
    return r.rows[0] ? mapNode(r.rows[0] as OrgNodeRow) : null
  }

  async findByCode(code: string): Promise<OrgNodeRecord | null> {
    const r = await this.client.query(
      `SELECT ${NODE_COLUMNS} FROM org_node WHERE code = $1 AND status = 'active'`,
      [code],
    )
    return r.rows[0] ? mapNode(r.rows[0] as OrgNodeRow) : null
  }

  async findActiveByName(name: string): Promise<OrgNodeRecord | null> {
    const r = await this.client.query(
      `SELECT ${NODE_COLUMNS} FROM org_node WHERE name = $1 AND status = 'active'`,
      [name],
    )
    return r.rows[0] ? mapNode(r.rows[0] as OrgNodeRow) : null
  }

  async insert(node: NewOrgNode): Promise<OrgNodeRecord> {
    const r = await this.client.query(
      `INSERT INTO org_node (id, kind, code, name, parent_id, parent_kind, path, depth,
         plant_code, company_org_code, dept_category, status, enterprise_id, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         'active', $12, $13)
       RETURNING ${NODE_COLUMNS}`,
      [
        node.id ?? null,
        node.kind,
        node.code,
        node.name,
        node.parentId,
        node.parentKind,
        node.path,
        node.depth,
        node.plantCode ?? null,
        node.companyOrgCode ?? null,
        node.deptCategory ?? null,
        node.enterpriseId,
        node.createdBy ?? null,
      ],
    )
    return mapNode(r.rows[0] as OrgNodeRow)
  }

  async update(id: string, patch: OrgNodePatch, actor: string | null): Promise<OrgNodeRecord | null> {
    const current = await this.findById(id)
    if (current === null) return null

    // 变更上级：重算本节点 path/depth 并重写子树前缀（OA-34 物化维护）
    if (patch.parentId !== undefined && patch.parentId !== current.parentId) {
      let parent: OrgNodeRecord | null = null
      if (patch.parentId !== null) {
        parent = await this.findById(patch.parentId)
        if (parent === null) throw new Error(`上级机构不存在：${patch.parentId}`)
      }
      const newPath = parent ? `${parent.path}${id}/` : `/${id}/`
      const depthDelta = (parent ? parent.depth + 1 : 0) - current.depth
      await this.client.query(
        `UPDATE org_node SET parent_id = $1, parent_kind = $2, path = $3, depth = depth + $4,
           updated_at = now(), updated_by = $5
         WHERE id = $6`,
        [parent ? parent.id : null, parent ? parent.kind : null, newPath, depthDelta, actor, id],
      )
      await this.client.query(
        `UPDATE org_node SET path = $1 || substring(path from $2), depth = depth + $3,
           updated_at = now(), updated_by = $4
         WHERE path LIKE $5 AND id <> $6`,
        [newPath, current.path.length + 1, depthDelta, actor, `${current.path}%`, id],
      )
    }

    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch.name !== undefined) add('name', patch.name)
    if (patch.plantCode !== undefined) add('plant_code', patch.plantCode)
    if (patch.companyOrgCode !== undefined) add('company_org_code', patch.companyOrgCode)
    if (patch.deptCategory !== undefined) add('dept_category', patch.deptCategory)
    if (sets.length > 0) {
      add('updated_at', new Date())
      add('updated_by', actor)
      values.push(id)
      await this.client.query(
        `UPDATE org_node SET ${sets.join(', ')} WHERE id = $${values.length}`,
        values,
      )
    }
    return this.findById(id)
  }

  async retireSubtree(rootId: string, actor: string | null): Promise<number> {
    const root = await this.findById(rootId)
    if (root === null) return 0
    // OA-06：逻辑删除（状态列）整个子树（path 前缀 = 自身 + 全部下级）
    const r = await this.client.query(
      `UPDATE org_node SET status = 'retired', updated_at = now(), updated_by = $1
       WHERE path LIKE $2 AND status = 'active'`,
      [actor, `${root.path}%`],
    )
    return r.rowCount ?? 0
  }

  async countActiveUsersUnderPath(path: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM user_account u
         JOIN org_node d ON d.id = u.dept_id
       WHERE u.status = 'active' AND d.path LIKE $1`,
      [`${path}%`],
    )
    return (r.rows[0] as { n: number }).n
  }

  async countActiveWorkCentersUnderPath(path: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM org_node
       WHERE kind = 'work_center' AND status = 'active' AND path LIKE $1`,
      [`${path}%`],
    )
    return (r.rows[0] as { n: number }).n
  }

  async listActiveByEnterprise(enterpriseId: string): Promise<OrgNodeRecord[]> {
    const r = await this.client.query(
      `SELECT ${NODE_COLUMNS} FROM org_node WHERE enterprise_id = $1 AND status = 'active' ORDER BY path`,
      [enterpriseId],
    )
    return r.rows.map((row) => mapNode(row as OrgNodeRow))
  }

  async list(
    filter: { enterpriseId: string; kinds?: OrgNodeKind[]; plantPaths: string[] | null } & {
      page: number
      pageSize: number
    },
  ): Promise<{ items: OrgNodeRecord[]; total: number; page: number; pageSize: number }> {
    const conditions = [`enterprise_id = $1`, `status = 'active'`]
    const values: unknown[] = [filter.enterpriseId]
    if (filter.kinds && filter.kinds.length > 0) {
      values.push(filter.kinds)
      conditions.push(`kind = ANY($${values.length})`)
    }
    if (filter.plantPaths !== null) {
      values.push(filter.plantPaths.map((p) => `${p}%`))
      conditions.push(`path LIKE ANY($${values.length})`)
    }
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${NODE_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM org_node WHERE ${conditions.join(' AND ')}
       ORDER BY path
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapNode(row as OrgNodeRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }
}

const USER_COLUMNS = `id, enterprise_id, login_name, password_hash, display_name, dept_id,
  workshop_dept_id, role_id, login_platform, account_status, phone, plant_id,
  failed_login_count, locked_until, status, created_at, created_by, updated_at, updated_by`

export class PgUserAccountRepository implements UserAccountRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<UserAccountRecord | null> {
    const r = await this.client.query(`SELECT ${USER_COLUMNS} FROM user_account WHERE id = $1`, [id])
    return r.rows[0] ? mapUser(r.rows[0] as UserRow) : null
  }

  async findByLoginName(loginName: string): Promise<UserAccountRecord | null> {
    const r = await this.client.query(
      `SELECT ${USER_COLUMNS} FROM user_account WHERE login_name = $1`,
      [loginName],
    )
    return r.rows[0] ? mapUser(r.rows[0] as UserRow) : null
  }

  async insert(user: NewUserAccount): Promise<UserAccountRecord> {
    const r = await this.client.query(
      `INSERT INTO user_account (id, enterprise_id, login_name, password_hash, display_name,
         dept_id, workshop_dept_id, role_id, login_platform, account_status, phone, plant_id,
         failed_login_count, locked_until, status, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         0, NULL, 'active', $13)
       RETURNING ${USER_COLUMNS}`,
      [
        user.id ?? null,
        user.enterpriseId,
        user.loginName,
        user.passwordHash,
        user.displayName,
        user.deptId,
        user.workshopDeptId ?? null,
        user.roleId,
        user.loginPlatform,
        user.accountStatus,
        user.phone ?? null,
        user.plantId,
        user.createdBy ?? null,
      ],
    )
    return mapUser(r.rows[0] as UserRow)
  }

  async update(id: string, patch: UserAccountPatch, actor: string | null): Promise<UserAccountRecord | null> {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch.displayName !== undefined) add('display_name', patch.displayName)
    if (patch.deptId !== undefined) add('dept_id', patch.deptId)
    if (patch.workshopDeptId !== undefined) add('workshop_dept_id', patch.workshopDeptId)
    if (patch.roleId !== undefined) add('role_id', patch.roleId)
    if (patch.loginPlatform !== undefined) add('login_platform', patch.loginPlatform)
    if (patch.accountStatus !== undefined) add('account_status', patch.accountStatus)
    if (patch.phone !== undefined) add('phone', patch.phone)
    if (patch.plantId !== undefined) add('plant_id', patch.plantId)
    if (patch.passwordHash !== undefined) add('password_hash', patch.passwordHash)
    if (patch.failedLoginCount !== undefined) add('failed_login_count', patch.failedLoginCount)
    if (patch.lockedUntil !== undefined) add('locked_until', patch.lockedUntil)
    if (patch.status !== undefined) add('status', patch.status)
    if (sets.length === 0) return this.findById(id)
    add('updated_at', new Date())
    add('updated_by', actor)
    values.push(id)
    await this.client.query(
      `UPDATE user_account SET ${sets.join(', ')} WHERE id = $${values.length}`,
      values,
    )
    return this.findById(id)
  }

  async list(
    filter: { enterpriseId: string; plantIds: string[] | null; loginNameLike?: string } & {
      page: number
      pageSize: number
    },
  ): Promise<{ items: UserAccountRecord[]; total: number; page: number; pageSize: number }> {
    const conditions = [`enterprise_id = $1`, `status = 'active'`]
    const values: unknown[] = [filter.enterpriseId]
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) {
        return { items: [], total: 0, page: filter.page, pageSize: filter.pageSize }
      }
      values.push(filter.plantIds)
      conditions.push(`plant_id = ANY($${values.length})`)
    }
    if (filter.loginNameLike !== undefined) {
      values.push(`%${filter.loginNameLike}%`)
      conditions.push(`login_name LIKE $${values.length}`)
    }
    values.push(filter.pageSize, (filter.page - 1) * filter.pageSize)
    const r = await this.client.query(
      `SELECT ${USER_COLUMNS}, count(*) OVER () ::int AS total_count
       FROM user_account WHERE ${conditions.join(' AND ')}
       ORDER BY login_name
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
    const total = r.rows[0] ? (r.rows[0] as { total_count: number }).total_count : 0
    return {
      items: r.rows.map((row) => mapUser(row as UserRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    }
  }

  async countActiveUsersByRole(roleId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM user_account WHERE role_id = $1 AND status = 'active'`,
      [roleId],
    )
    return (r.rows[0] as { n: number }).n
  }
}

const ROLE_COLUMNS = `id, enterprise_id, name, alias, sort, is_system, parent_role_id, status,
  created_at, created_by, updated_at, updated_by`

export class PgRoleRepository implements RoleRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<RoleRecord | null> {
    const r = await this.client.query(`SELECT ${ROLE_COLUMNS} FROM role WHERE id = $1`, [id])
    return r.rows[0] ? mapRole(r.rows[0] as RoleRow) : null
  }

  async listByEnterprise(enterpriseId: string, includeRetired = false): Promise<RoleRecord[]> {
    const r = await this.client.query(
      `SELECT ${ROLE_COLUMNS} FROM role WHERE enterprise_id = $1
         ${includeRetired ? '' : `AND status = 'active'`}
       ORDER BY sort`,
      [enterpriseId],
    )
    return r.rows.map((row) => mapRole(row as RoleRow))
  }

  async insert(role: NewRole): Promise<RoleRecord> {
    const r = await this.client.query(
      `INSERT INTO role (id, enterprise_id, name, alias, sort, is_system, parent_role_id, status, created_by)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, 'active', $8)
       RETURNING ${ROLE_COLUMNS}`,
      [
        role.id ?? null,
        role.enterpriseId,
        role.name,
        role.alias,
        role.sort,
        role.isSystem,
        role.parentRoleId ?? null,
        role.createdBy ?? null,
      ],
    )
    return mapRole(r.rows[0] as RoleRow)
  }

  async update(id: string, patch: RolePatch, actor: string | null): Promise<RoleRecord | null> {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch.name !== undefined) add('name', patch.name)
    if (patch.alias !== undefined) add('alias', patch.alias)
    if (patch.sort !== undefined) add('sort', patch.sort)
    if (patch.parentRoleId !== undefined) add('parent_role_id', patch.parentRoleId)
    if (sets.length === 0) return this.findById(id)
    add('updated_at', new Date())
    add('updated_by', actor)
    values.push(id)
    await this.client.query(`UPDATE role SET ${sets.join(', ')} WHERE id = $${values.length}`, values)
    return this.findById(id)
  }

  async retire(id: string, actor: string | null): Promise<RoleRecord | null> {
    await this.client.query(
      `UPDATE role SET status = 'retired', updated_at = now(), updated_by = $1 WHERE id = $2`,
      [actor, id],
    )
    return this.findById(id)
  }

  async countActiveChildRoles(roleId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM role WHERE parent_role_id = $1 AND status = 'active'`,
      [roleId],
    )
    return (r.rows[0] as { n: number }).n
  }

  async countActiveUsers(roleId: string): Promise<number> {
    const r = await this.client.query(
      `SELECT count(*)::int AS n FROM user_account WHERE role_id = $1 AND status = 'active'`,
      [roleId],
    )
    return (r.rows[0] as { n: number }).n
  }
}

const GRANT_COLUMNS = `id, enterprise_id, principal_type, principal_id, permissions, scope_type,
  scope_object_id, status, created_at, created_by, updated_at, updated_by`

export class PgScopeGrantRepository implements ScopeGrantRepository {
  constructor(private readonly client: SqlClient) {}

  async upsertMerge(grant: ScopeGrantUpsert): Promise<ScopeGrantRecord> {
    // OA-22：同键至多一行；同键再授权 = 权限并集合并
    const r = await this.client.query(
      `INSERT INTO scope_grant (id, enterprise_id, principal_type, principal_id, permissions,
         scope_type, scope_object_id, status, created_by)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'active', $7)
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id)
       DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         status = 'active',
         updated_at = now(),
         updated_by = $7
       RETURNING ${GRANT_COLUMNS}`,
      [
        grant.enterpriseId,
        grant.principalType,
        grant.principalId,
        grant.permissions,
        grant.scopeType,
        grant.scopeObjectId,
        grant.actor ?? null,
      ],
    )
    return mapGrant(r.rows[0] as GrantRow)
  }

  async removePermissions(
    key: { principalType: 'role' | 'user'; principalId: string; scopeType: ScopeType; scopeObjectId: string },
    permissions: string[],
    actor: string | null,
  ): Promise<ScopeGrantRecord | null> {
    const r = await this.client.query(
      `UPDATE scope_grant SET
         permissions = COALESCE((
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions) AS t(p)
           WHERE NOT (p = ANY($5::text[]))
         ), ARRAY[]::text[]),
         updated_at = now(),
         updated_by = $6
       WHERE principal_type = $1 AND principal_id = $2 AND scope_type = $3 AND scope_object_id = $4
       RETURNING ${GRANT_COLUMNS}`,
      [key.principalType, key.principalId, key.scopeType, key.scopeObjectId, permissions, actor],
    )
    const row = r.rows[0] as GrantRow | undefined
    if (row === undefined) return null
    if ((row.permissions ?? []).length === 0) {
      // 权限移空 → 整行退役（授权行不再构成事实，OA-21）
      const r2 = await this.client.query(
        `UPDATE scope_grant SET status = 'retired', updated_at = now(), updated_by = $2
         WHERE id = $1 RETURNING ${GRANT_COLUMNS}`,
        [row.id, actor],
      )
      return mapGrant(r2.rows[0] as GrantRow)
    }
    return mapGrant(row)
  }

  async findByKey(key: {
    principalType: 'role' | 'user'
    principalId: string
    scopeType: ScopeType
    scopeObjectId: string
  }): Promise<ScopeGrantRecord | null> {
    const r = await this.client.query(
      `SELECT ${GRANT_COLUMNS} FROM scope_grant
       WHERE principal_type = $1 AND principal_id = $2 AND scope_type = $3 AND scope_object_id = $4`,
      [key.principalType, key.principalId, key.scopeType, key.scopeObjectId],
    )
    return r.rows[0] ? mapGrant(r.rows[0] as GrantRow) : null
  }

  async listActiveByPrincipals(
    principals: ReadonlyArray<{ principalType: 'role' | 'user'; principalId: string }>,
  ): Promise<ScopeGrantRecord[]> {
    if (principals.length === 0) return []
    const conditions = principals.map(
      (_, i) => `(principal_type = $${i * 2 + 1} AND principal_id = $${i * 2 + 2})`,
    )
    const values = principals.flatMap((p) => [p.principalType, p.principalId])
    const r = await this.client.query(
      `SELECT ${GRANT_COLUMNS} FROM scope_grant
       WHERE status = 'active' AND (${conditions.join(' OR ')})`,
      values,
    )
    return r.rows.map((row) => mapGrant(row as GrantRow))
  }

  async listByEnterprise(enterpriseId: string): Promise<ScopeGrantRecord[]> {
    const r = await this.client.query(
      `SELECT ${GRANT_COLUMNS} FROM scope_grant WHERE enterprise_id = $1 ORDER BY principal_type, principal_id`,
      [enterpriseId],
    )
    return r.rows.map((row) => mapGrant(row as GrantRow))
  }
}

export class PgAuthSessionRepository implements AuthSessionRepository {
  constructor(private readonly client: SqlClient) {}

  async issue(session: NewAuthSession): Promise<AuthSessionRecord> {
    const r = await this.client.query(
      `INSERT INTO auth_session (id, token_hash, user_id, enterprise_id, plant_id, login_platform,
         issued_at, expires_at, revoked_at)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, NULL)
       RETURNING id, token_hash, user_id, enterprise_id, plant_id, login_platform, issued_at, expires_at, revoked_at`,
      [
        session.id ?? null,
        session.tokenHash,
        session.userId,
        session.enterpriseId,
        session.plantId,
        session.loginPlatform,
        session.issuedAt,
        session.expiresAt,
      ],
    )
    return mapSession(r.rows[0] as SessionRow)
  }

  async findActiveByTokenHash(tokenHash: string, now: Date): Promise<AuthSessionRecord | null> {
    const r = await this.client.query(
      `SELECT id, token_hash, user_id, enterprise_id, plant_id, login_platform, issued_at,
         expires_at, revoked_at
       FROM auth_session
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [tokenHash, now],
    )
    return r.rows[0] ? mapSession(r.rows[0] as SessionRow) : null
  }

  async revoke(id: string, now: Date): Promise<void> {
    await this.client.query(
      `UPDATE auth_session SET revoked_at = $2, updated_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [id, now],
    )
  }
}

/** 审计写入：每条命令一行（OA-28）；与业务事务共用同一客户端（OA-26/28）。 */
export class PgAuditWriter implements AuditWriter {
  constructor(private readonly client: SqlClient) {}

  async record(fact: AuditFactInput): Promise<void> {
    await this.client.query(
      `INSERT INTO audit_entry (actor, action, subject_type, subject_id, before, after, reason)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [
        fact.actor,
        fact.action,
        fact.subjectType,
        fact.subjectId,
        fact.before === undefined ? null : JSON.stringify(fact.before),
        fact.after === undefined ? null : JSON.stringify(fact.after),
        fact.reason ?? null,
      ],
    )
  }
}
