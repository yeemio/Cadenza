import { OrgRuleViolation } from './errors'
import type { OrgNodeKind } from './org-node'

/**
 * 服务端核权与数据范围纯规则 —— 对应冻结合同 org-auth.md §4/§3：OA-21～OA-26。
 */

/** 岗位操作许可目录（OA-23 第一元）。P1 org 域所需最小集。 */
export const ORG_PERMISSIONS = {
  /** 查询（命令、查询、导出、附件、后台任务、外部接口六类入口同检，OA-24） */
  ORG_READ: 'org.read',
  /** 机构/用户/角色/授权管理 */
  ORG_ADMIN: 'org.admin',
  /** 管理员标志：可配置 admin 角色（OA-20） */
  ROLE_ADMIN: 'org.role.admin',
} as const

export type OrgPermission = (typeof ORG_PERMISSIONS)[keyof typeof ORG_PERMISSIONS]

/** OA-23 数据范围三维：企业/工厂/车间。 */
export type ScopeType = 'enterprise' | 'plant' | 'workshop'

export const SCOPE_TYPES: readonly ScopeType[] = ['enterprise', 'plant', 'workshop']

/** scope_type 与目标节点类型的配对（车间范围取 work_center 节点；GAP-A4 映射未裁定时按此最小口径）。 */
export const SCOPE_OBJECT_KIND: Readonly<Record<ScopeType, OrgNodeKind>> = {
  enterprise: 'enterprise',
  plant: 'plant',
  workshop: 'work_center',
}

export interface GrantLike {
  principalType: 'role' | 'user'
  principalId: string
  /** 该主体对该范围对象被授予的岗位许可集合（OA-21：授权事实以落库行集合为准） */
  permissions: readonly string[]
  scopeType: ScopeType
  scopeObjectId: string
}

export interface ScopedNode {
  id: string
  parentId: string | null
  kind: OrgNodeKind
  path: string
  status?: string
}

/**
 * OA-23/OA-25 范围覆盖判定（服务端计算）：
 * enterprise 范围覆盖整个企业树；plant/workshop 范围覆盖对应节点的子树（path 前缀）。
 */
export function scopeCoversPath(
  grant: Pick<GrantLike, 'scopeType' | 'scopeObjectId'>,
  scopeObjectPath: string,
  enterprisePath: string,
  targetPath: string,
): boolean {
  const basePath = grant.scopeType === 'enterprise' ? enterprisePath : scopeObjectPath
  return targetPath.startsWith(basePath)
}

/** OA-23 第一元：岗位许可是否持有。 */
export function hasPermission(grants: readonly GrantLike[], permission: string): boolean {
  return grants.some((g) => g.permissions.includes(permission))
}

/** 汇总主体持有的全部岗位许可（角色授权 ∪ 用户授权，OA-21 以落库显式行为准）。 */
export function unionPermissions(grants: readonly GrantLike[]): string[] {
  const set = new Set<string>()
  for (const g of grants) {
    for (const p of g.permissions) set.add(p)
  }
  return [...set]
}

/** 沿 parent 链向上找祖先或自身的 plant 节点（组织树来自库，path/depth 已物化，OA-34）。 */
export function findAncestorOrSelfPlant(
  node: ScopedNode,
  nodesById: ReadonlyMap<string, ScopedNode>,
): ScopedNode | null {
  let current: ScopedNode | undefined = node
  let hops = 0
  while (current && hops < 64) {
    if (current.kind === 'plant') return current
    current = current.parentId ? nodesById.get(current.parentId) : undefined
    hops += 1
  }
  return null
}

/** 数据范围解析结果：enterpriseWide=true 表示覆盖全企业（仍限本企业，OA-33 隔离）。 */
export interface DataScope {
  enterpriseWide: boolean
  plantIds: string[]
}

/**
 * OA-25 数据范围按授权集合与组织树在服务端计算：
 * enterprise 授权 → 全企业；plant 授权 → 该厂；workshop 授权 → 该车间所属厂。
 */
export function computeDataScope(
  grants: readonly GrantLike[],
  enterpriseNodes: readonly ScopedNode[],
): DataScope {
  let enterpriseWide = false
  const plants = new Set<string>()
  const nodesById = new Map(enterpriseNodes.map((n) => [n.id, n]))
  for (const grant of grants) {
    if (grant.scopeType === 'enterprise') {
      enterpriseWide = true
      continue
    }
    const obj = nodesById.get(grant.scopeObjectId)
    if (!obj) continue
    const plant = findAncestorOrSelfPlant(obj, nodesById)
    if (plant) plants.add(plant.id)
  }
  if (enterpriseWide) {
    for (const n of enterpriseNodes) {
      if (n.kind === 'plant' && n.status !== 'retired') plants.add(n.id)
    }
  }
  return { enterpriseWide, plantIds: [...plants] }
}

/** OA-24/OA-26 写路径与显式查询参数的范围防线：目标厂是否在范围内。 */
export function isPlantInScope(scope: DataScope, plantId: string): boolean {
  return scope.enterpriseWide || scope.plantIds.includes(plantId)
}

/** OA-26 一切业务命令在服务端核权（含后台任务与接口触发的写）：命令内二道防线。 */
export function assertPlantInScope(scope: DataScope, plantId: string): void {
  if (!isPlantInScope(scope, plantId)) {
    throw new OrgRuleViolation('OA-24', '目标工厂不在授权数据范围内（服务端范围检查）')
  }
}

/** OA-22 scope_grant 行唯一键：同一主体对同一对象的同类授权至多一行（合并权限而非新增行）。 */
export interface GrantKeyInput {
  principalType: 'role' | 'user'
  principalId: string
  scopeType: ScopeType
  scopeObjectId: string
}

export function grantKeyOf(key: GrantKeyInput): string {
  return `${key.principalType}:${key.principalId}:${key.scopeType}:${key.scopeObjectId}`
}

/** 新授权与既有行同键时合并权限（至多一行，OA-22）；不同键直接放行。 */
export function mergeGrantPermissions(
  existing: readonly GrantLike[],
  incoming: GrantKeyInput & { permissions: readonly string[] },
): { mergeInto: GrantLike | null; permissions: string[] } {
  const same = existing.find(
    (g) =>
      g.principalType === incoming.principalType &&
      g.principalId === incoming.principalId &&
      g.scopeType === incoming.scopeType &&
      g.scopeObjectId === incoming.scopeObjectId,
  )
  const merged = new Set<string>([...(same?.permissions ?? []), ...incoming.permissions])
  return { mergeInto: same ?? null, permissions: [...merged] }
}
