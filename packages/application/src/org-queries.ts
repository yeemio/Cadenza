import type { OrgNodeDto, PageRequest, PageResult, RoleDto, ScopeGrantDto, UserAccountDto } from '@cadenza/contracts'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  OrgNodeRepository,
  RoleRepository,
  ScopeGrantRepository,
  UserAccountRepository,
} from './repositories'

/**
 * org 域查询服务：列表一律按授权上下文做服务端过滤（OA-24/25——
 * 命令、查询、导出等六类入口同一范围检查；界面/查询/导出口径一致）。
 * 敏感字段（password_hash 等）不进入 DTO（OA-27 底线）。
 */

export interface OrgQueryDeps {
  org: OrgNodeRepository
  users: UserAccountRepository
  roles: RoleRepository
  grants: ScopeGrantRepository
}

function toPageRequest(query: { page?: unknown; pageSize?: unknown }): PageRequest {
  const page = typeof query.page === 'number' && Number.isInteger(query.page) && query.page >= 1 ? query.page : 1
  const pageSize =
    typeof query.pageSize === 'number' && Number.isInteger(query.pageSize) && query.pageSize >= 1
      ? Math.min(query.pageSize, 100)
      : 20
  return { page, pageSize }
}

function nodeToDto(n: {
  id: string
  kind: string
  code: string
  name: string
  parentId: string | null
  parentKind: string | null
  path: string
  depth: number
  plantCode: string | null
  companyOrgCode: string | null
  deptCategory: number | null
  status: string
}): OrgNodeDto {
  return {
    id: n.id,
    kind: n.kind,
    code: n.code,
    name: n.name,
    parentId: n.parentId,
    parentKind: n.parentKind,
    path: n.path,
    depth: n.depth,
    plantCode: n.plantCode,
    companyOrgCode: n.companyOrgCode,
    deptCategory: n.deptCategory,
    status: n.status,
  }
}

function userToDto(u: {
  id: string
  loginName: string
  displayName: string
  deptId: string
  workshopDeptId: string | null
  roleId: string
  loginPlatform: string
  accountStatus: string
  plantId: string
  phone: string | null
  failedLoginCount: number
  lockedUntil: string | null
  status: string
}): UserAccountDto {
  // 不含 password_hash（人员资料敏感字段不外泄，OA-27）
  return {
    id: u.id,
    loginName: u.loginName,
    displayName: u.displayName,
    deptId: u.deptId,
    workshopDeptId: u.workshopDeptId,
    roleId: u.roleId,
    loginPlatform: u.loginPlatform as UserAccountDto['loginPlatform'],
    accountStatus: u.accountStatus,
    plantId: u.plantId,
    phone: u.phone,
    failedLoginCount: u.failedLoginCount,
    lockedUntil: u.lockedUntil,
    status: u.status,
  }
}

function roleToDto(r: {
  id: string
  name: string
  alias: string
  sort: number
  isSystem: number
  parentRoleId: string | null
  status: string
}): RoleDto {
  return {
    id: r.id,
    name: r.name,
    alias: r.alias,
    sort: r.sort,
    isSystem: r.isSystem,
    parentRoleId: r.parentRoleId,
    status: r.status,
  }
}

function grantToDto(g: {
  id: string
  principalType: 'role' | 'user'
  principalId: string
  permissions: string[]
  scopeType: ScopeGrantDto['scopeType']
  scopeObjectId: string
  status: string
}): ScopeGrantDto {
  return {
    id: g.id,
    principalType: g.principalType,
    principalId: g.principalId,
    permissions: g.permissions,
    scopeType: g.scopeType,
    scopeObjectId: g.scopeObjectId,
    status: g.status,
  }
}

export class OrgQueryService {
  constructor(private readonly deps: OrgQueryDeps) {}

  /** 可见企业集合：本企业 ∪ 主体有效授权中 enterprise 范围的 scopeObjectId（跨企业可见）。 */
  private async visibleEnterpriseIds(auth: VerifiedAuthContext): Promise<string[]> {
    const ids = new Set<string>([auth.user.enterpriseId])
    const grantRows = await this.deps.grants.listActiveByPrincipals([
      { principalType: 'user', principalId: auth.user.id },
      { principalType: 'role', principalId: auth.user.roleId },
    ])
    for (const g of grantRows) {
      if (g.scopeType === 'enterprise') ids.add(g.scopeObjectId)
      else ids.add(g.enterpriseId)
    }
    return [...ids]
  }

  /** 机构分页列表：含跨企业授权可见的新建企业树（WI-L1-ORG-GRANT-CROSS-ENT）。 */
  async listNodes(
    auth: VerifiedAuthContext,
    query: { kind?: string; plantId?: string; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<OrgNodeDto>> {
    const pageRequest = toPageRequest(query)
    const enterpriseIds = await this.visibleEnterpriseIds(auth)
    const nodesArrays = await Promise.all(
      enterpriseIds.map((eid) => this.deps.org.listActiveByEnterprise(eid)),
    )
    const nodes = nodesArrays.flat()
    const byId = new Map(nodes.map((n) => [n.id, n]))

    const scope = auth.dataScope
    const enterpriseWide = scope.enterpriseWide
    const allowedPlants = enterpriseWide
      ? new Set(nodes.filter((n) => n.kind === 'plant').map((n) => n.id))
      : new Set(scope.plantIds.filter((id) => byId.has(id)))

    let plantFilter: Set<string> | null = null
    if (typeof query.plantId === 'string' && query.plantId.length > 0) {
      plantFilter = new Set([query.plantId])
    }

    const items: OrgNodeDto[] = []
    for (const n of nodes) {
      // 跨企业节点：若对该企业有 enterprise 授权则可见；本企业仍按原范围规则
      const isHome = n.enterpriseId === auth.user.enterpriseId
      if (!isHome) {
        if (typeof query.kind === 'string' && query.kind.length > 0 && n.kind !== query.kind) continue
        items.push(nodeToDto(n))
        continue
      }
      const belongs = plantBelongs(n, byId, allowedPlants, enterpriseWide)
      if (!belongs) continue
      if (plantFilter !== null && !plantFilter.has(nodePlantId(n, byId) ?? '')) continue
      if (typeof query.kind === 'string' && query.kind.length > 0 && n.kind !== query.kind) continue
      items.push(nodeToDto(n))
    }
    items.sort((a, b) => a.path.localeCompare(b.path))
    const total = items.length
    const start = (pageRequest.page - 1) * pageRequest.pageSize
    return { items: items.slice(start, start + pageRequest.pageSize), total, ...pageRequest }
  }

  /** 用户分页列表：按 plant_id 隔离列过滤（OA-33）。 */
  async listUsers(
    auth: VerifiedAuthContext,
    query: { plantId?: string; loginNameLike?: string; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<UserAccountDto>> {
    const pageRequest = toPageRequest(query)
    const scope = auth.dataScope
    const plantIds =
      typeof query.plantId === 'string' && query.plantId.length > 0
        ? [query.plantId]
        : scope.enterpriseWide
          ? null
          : scope.plantIds
    const page = await this.deps.users.list({
      enterpriseId: auth.user.enterpriseId,
      plantIds,
      loginNameLike:
        typeof query.loginNameLike === 'string' && query.loginNameLike.length > 0
          ? query.loginNameLike
          : undefined,
      ...pageRequest,
    })
    return { items: page.items.map(userToDto), total: page.total, ...pageRequest }
  }

  /** 角色列表（企业维度）。 */
  async listRoles(
    auth: VerifiedAuthContext,
    query: { includeRetired?: boolean; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<RoleDto>> {
    const pageRequest = toPageRequest(query)
    const all = await this.deps.roles.listByEnterprise(auth.user.enterpriseId, query.includeRetired === true)
    const active = all.filter((r) => query.includeRetired === true || r.status === 'active')
    const start = (pageRequest.page - 1) * pageRequest.pageSize
    return {
      items: active.slice(start, start + pageRequest.pageSize).map(roleToDto),
      total: active.length,
      ...pageRequest,
    }
  }

  /** 授权列表：本企业 ∪ 主体跨企业授权行（WI-L1-ORG-GRANT-CROSS-ENT）。 */
  async listGrants(
    auth: VerifiedAuthContext,
    query: { principalType?: string; principalId?: string; includeRetired?: boolean; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<ScopeGrantDto>> {
    const pageRequest = toPageRequest(query)
    const enterpriseIds = await this.visibleEnterpriseIds(auth)
    const byEnt = await Promise.all(enterpriseIds.map((eid) => this.deps.grants.listByEnterprise(eid)))
    const principalRows = await this.deps.grants.listActiveByPrincipals([
      { principalType: 'user', principalId: auth.user.id },
      { principalType: 'role', principalId: auth.user.roleId },
    ])
    const merged = new Map<string, (typeof principalRows)[number]>()
    for (const g of byEnt.flat()) merged.set(g.id, g)
    for (const g of principalRows) merged.set(g.id, g)
    const all = [...merged.values()]
    const filtered = all.filter((g) => {
      if (query.includeRetired !== true && g.status !== 'active') return false
      if (query.principalType === 'role' && g.principalType !== 'role') return false
      if (query.principalType === 'user' && g.principalType !== 'user') return false
      if (typeof query.principalId === 'string' && query.principalId.length > 0 && g.principalId !== query.principalId) {
        return false
      }
      return true
    })
    const start = (pageRequest.page - 1) * pageRequest.pageSize
    return {
      items: filtered.slice(start, start + pageRequest.pageSize).map(grantToDto),
      total: filtered.length,
      ...pageRequest,
    }
  }

  /** 机构树（前端拉平树用）：同 listNodes 不过滤 kind。 */
  async listTree(auth: VerifiedAuthContext, query: { plantId?: string; page?: unknown; pageSize?: unknown }) {
    return this.listNodes(auth, query)
  }
}

/** 节点归属厂：plant 自身即该厂；下层节点向上找 plant；企业/法人层为 null。 */
function nodePlantId(
  n: { id: string; kind: string; parentId: string | null },
  byId: ReadonlyMap<string, { id: string; kind: string; parentId: string | null }>,
): string | null {
  let current: { id: string; kind: string; parentId: string | null } | undefined = n
  let hops = 0
  while (current && hops < 64) {
    if (current.kind === 'plant') return current.id
    current = current.parentId ? byId.get(current.parentId) : undefined
    hops += 1
  }
  return null
}

function plantBelongs(
  n: { id: string; kind: string; parentId: string | null },
  byId: ReadonlyMap<string, { id: string; kind: string; parentId: string | null }>,
  allowedPlants: ReadonlySet<string>,
  enterpriseWide: boolean,
): boolean {
  if (n.kind === 'enterprise' || n.kind === 'legal_entity') {
    // 企业/法人层节点仅企业范围授权可见
    return enterpriseWide
  }
  const plantId = nodePlantId(n, byId)
  return plantId !== null && allowedPlants.has(plantId)
}
