import type { PageRequest, PageResult } from '@cadenza/contracts'
import type {
  LoginPlatform,
  OrgNodeKind,
  ScopeType,
} from '@cadenza/domain'

/**
 * org 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与表列一一对应；时间字段一律 ISO-8601 字符串（服务端系统时间，OA-31）。
 */

export interface OrgNodeRecord {
  id: string
  kind: OrgNodeKind
  code: string
  name: string
  parentId: string | null
  parentKind: string | null
  path: string
  depth: number
  plantCode: string | null
  companyOrgCode: string | null
  deptCategory: number | null
  status: 'active' | 'retired'
  enterpriseId: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface UserAccountRecord {
  id: string
  enterpriseId: string
  loginName: string
  passwordHash: string
  displayName: string
  deptId: string
  workshopDeptId: string | null
  roleId: string
  loginPlatform: LoginPlatform
  accountStatus: 'enabled' | 'disabled'
  phone: string | null
  plantId: string
  failedLoginCount: number
  lockedUntil: string | null
  status: 'active' | 'retired'
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface RoleRecord {
  id: string
  enterpriseId: string
  name: string
  alias: string
  sort: number
  isSystem: number
  parentRoleId: string | null
  status: 'active' | 'retired'
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface ScopeGrantRecord {
  id: string
  enterpriseId: string
  principalType: 'role' | 'user'
  principalId: string
  permissions: string[]
  scopeType: ScopeType
  scopeObjectId: string
  status: 'active' | 'retired'
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface AuthSessionRecord {
  id: string
  tokenHash: string
  userId: string
  enterpriseId: string
  plantId: string | null
  loginPlatform: string
  issuedAt: string
  expiresAt: string
  revokedAt: string | null
}

export interface AuditFactInput {
  actor: string
  action: string
  subjectType: string
  subjectId: string
  before?: unknown
  after?: unknown
  reason?: string | null
}

/** 审计写入端口：每条业务命令一行（OA-28），与业务事务同库同事务写入（OA-26/28）。 */
export interface AuditWriter {
  record(fact: AuditFactInput): Promise<void>
}

export interface NewOrgNode {
  id?: string
  kind: OrgNodeKind
  code: string
  name: string
  parentId: string | null
  parentKind: string | null
  path: string
  depth: number
  plantCode?: string | null
  companyOrgCode?: string | null
  deptCategory?: number | null
  enterpriseId: string
  createdBy?: string | null
}

export interface OrgNodePatch {
  name?: string
  parentId?: string
  plantCode?: string | null
  companyOrgCode?: string | null
  deptCategory?: number | null
}

export interface OrgNodeRepository {
  /** Existing persisted shift parameter, read in the same command transaction. */
  findPlantDayShiftStart?(plantId: string): Promise<string | null>
  findById(id: string): Promise<OrgNodeRecord | null>
  findByCode(code: string): Promise<OrgNodeRecord | null>
  findActiveByName(name: string): Promise<OrgNodeRecord | null>
  insert(node: NewOrgNode): Promise<OrgNodeRecord>
  /** 更新本节点字段；变更上级时由实现方同步重算并重写子树 path/depth（OA-34）。 */
  update(id: string, patch: OrgNodePatch, actor: string | null): Promise<OrgNodeRecord | null>
  /** OA-06 逻辑删除（状态列）整个子树；返回受影响行数。 */
  retireSubtree(rootId: string, actor: string | null): Promise<number>
  /** OA-05：子树内挂有活动用户的数量（按部门 path 前缀统计）。 */
  countActiveUsersUnderPath(path: string): Promise<number>
  /** OA-07：子树内活动 work_center 引用数。 */
  countActiveWorkCentersUnderPath(path: string): Promise<number>
  /** 企业全部活动节点（树/范围计算用，dev 规模）。 */
  listActiveByEnterprise(enterpriseId: string): Promise<OrgNodeRecord[]>
  list(
    filter: { enterpriseId: string; kinds?: OrgNodeKind[]; plantPaths: string[] | null } & PageRequest,
  ): Promise<PageResult<OrgNodeRecord>>
}

export interface NewUserAccount {
  id?: string
  enterpriseId: string
  loginName: string
  passwordHash: string
  displayName: string
  deptId: string
  workshopDeptId?: string | null
  roleId: string
  loginPlatform: LoginPlatform
  accountStatus: 'enabled' | 'disabled'
  phone?: string | null
  plantId: string
  createdBy?: string | null
}

export interface UserAccountPatch {
  displayName?: string
  deptId?: string
  workshopDeptId?: string | null
  roleId?: string
  loginPlatform?: LoginPlatform
  accountStatus?: 'enabled' | 'disabled'
  phone?: string | null
  plantId?: string
  passwordHash?: string
  failedLoginCount?: number
  lockedUntil?: Date | null
  /** OA-11/OA-16 配套：逻辑删除（retire）经状态列 */
  status?: 'active' | 'retired'
}

export interface UserAccountRepository {
  findById(id: string): Promise<UserAccountRecord | null>
  findByLoginName(loginName: string): Promise<UserAccountRecord | null>
  insert(user: NewUserAccount): Promise<UserAccountRecord>
  update(id: string, patch: UserAccountPatch, actor: string | null): Promise<UserAccountRecord | null>
  list(
    filter: { enterpriseId: string; plantIds: string[] | null; loginNameLike?: string } & PageRequest,
  ): Promise<PageResult<UserAccountRecord>>
  /** OA-19：角色下活动用户数。 */
  countActiveUsersByRole(roleId: string): Promise<number>
}

export interface NewRole {
  id?: string
  enterpriseId: string
  name: string
  alias: string
  sort: number
  isSystem: number
  parentRoleId?: string | null
  createdBy?: string | null
}

export interface RolePatch {
  name?: string
  alias?: string
  sort?: number
  parentRoleId?: string | null
}

export interface RoleRepository {
  findById(id: string): Promise<RoleRecord | null>
  listByEnterprise(enterpriseId: string, includeRetired?: boolean): Promise<RoleRecord[]>
  insert(role: NewRole): Promise<RoleRecord>
  update(id: string, patch: RolePatch, actor: string | null): Promise<RoleRecord | null>
  retire(id: string, actor: string | null): Promise<RoleRecord | null>
  /** OA-19：下级角色数 / 已关联活动用户数。 */
  countActiveChildRoles(roleId: string): Promise<number>
  countActiveUsers(roleId: string): Promise<number>
}

export interface ScopeGrantUpsert {
  enterpriseId: string
  principalType: 'role' | 'user'
  principalId: string
  scopeType: ScopeType
  scopeObjectId: string
  permissions: string[]
  actor?: string | null
}

export interface ScopeGrantRepository {
  /** OA-22：同键合并权限至一行（UPSERT 语义），返回合并后行。 */
  upsertMerge(grant: ScopeGrantUpsert): Promise<ScopeGrantRecord>
  /** 移除若干权限；移除后为空则整行退役。返回更新后行或 null（键不存在）。 */
  removePermissions(
    key: { principalType: 'role' | 'user'; principalId: string; scopeType: ScopeType; scopeObjectId: string },
    permissions: string[],
    actor: string | null,
  ): Promise<ScopeGrantRecord | null>
  findByKey(key: {
    principalType: 'role' | 'user'
    principalId: string
    scopeType: ScopeType
    scopeObjectId: string
  }): Promise<ScopeGrantRecord | null>
  /** 有效授权集合（status=active），供核权与范围计算（OA-23/25）。 */
  listActiveByPrincipals(
    principals: ReadonlyArray<{ principalType: 'role' | 'user'; principalId: string }>,
  ): Promise<ScopeGrantRecord[]>
  listByEnterprise(enterpriseId: string): Promise<ScopeGrantRecord[]>
}

export interface NewAuthSession {
  id?: string
  tokenHash: string
  userId: string
  enterpriseId: string
  plantId: string | null
  loginPlatform: string
  issuedAt: Date
  expiresAt: Date
}

export interface AuthSessionRepository {
  issue(session: NewAuthSession): Promise<AuthSessionRecord>
  /** 仅返回未撤销且未过期的会话。 */
  findActiveByTokenHash(tokenHash: string, now: Date): Promise<AuthSessionRecord | null>
  /** 撤销（登出）；幂等。 */
  revoke(id: string, now: Date): Promise<void>
}
