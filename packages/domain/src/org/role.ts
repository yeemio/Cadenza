import { OrgRuleViolation } from './errors'

/**
 * 角色与授权纯规则 —— 对应冻结合同 org-auth.md §3：OA-17～OA-22。
 */

export interface RoleSnapshot {
  id: string
  enterpriseId: string
  name: string
  alias: string
  sort: number
  /** 2=内置角色（OA-18），1=普通 */
  isSystem: number
  status: string
}

/** OA-18 内置角色标志值。 */
export const BUILTIN_ROLE_FLAG = 2

/**
 * OA-17 角色唯一性：同一租户及其上级范围内，名称、别名、排序三者任一与既有角色
 * 重复即拒绝。enterprise 是租户树的根（OA-08 四层模型），因此"租户及其上级范围"
 * 归结为同一 enterprise_id 范围内的比较。
 */
export function findRoleUniquenessConflict(
  candidate: { name: string; alias: string; sort: number; id?: string },
  existing: readonly RoleSnapshot[],
): RoleSnapshot | null {
  for (const role of existing) {
    if (role.status !== 'active') continue
    if (candidate.id != null && role.id === candidate.id) continue
    if (
      role.name === candidate.name ||
      role.alias === candidate.alias ||
      role.sort === candidate.sort
    ) {
      return role
    }
  }
  return null
}

/** OA-18 内置角色（isSystem=2）不可删除、不可修改别名。 */
export function assertBuiltinRoleMutable(
  role: Pick<RoleSnapshot, 'isSystem' | 'alias'>,
  patch: { alias?: string | null },
): void {
  if (role.isSystem === BUILTIN_ROLE_FLAG && patch.alias != null && patch.alias !== role.alias) {
    throw new OrgRuleViolation('OA-18', '内置角色不可修改别名')
  }
}

/** OA-18/OA-19 角色删除前置。 */
export interface RoleDeleteFacts {
  assignedActiveUsers: number
  childRoles: number
}

export function assertRoleDeletable(
  role: Pick<RoleSnapshot, 'id' | 'isSystem' | 'name'>,
  facts: RoleDeleteFacts,
): void {
  if (role.isSystem === BUILTIN_ROLE_FLAG) {
    throw new OrgRuleViolation('OA-18', `内置角色（${role.name}）不可删除`)
  }
  if (facts.assignedActiveUsers > 0) {
    throw new OrgRuleViolation('OA-19', '已关联用户的角色不可删除')
  }
  if (facts.childRoles > 0) {
    throw new OrgRuleViolation('OA-19', '存在下级角色，须先删除全部下级角色')
  }
}

/**
 * OA-20 非管理员不可配置 admin 角色（服务端拒绝，非仅按钮隐藏）。
 * "管理员"判定 = 持有 ROLE_ADMIN_PERMISSION 权限；"admin 角色" = 授权中含该权限
 * 的配置或内置角色本身（映射说明见 DELIVERY 覆盖表）。
 */
export const ROLE_ADMIN_PERMISSION = 'org.role.admin'

export function assertCanAdministerAdminRole(actorPermissions: readonly string[]): void {
  if (!actorPermissions.includes(ROLE_ADMIN_PERMISSION)) {
    throw new OrgRuleViolation('OA-20', '非管理员不可配置 admin 角色（服务端拒绝）')
  }
}

export function isAdminCarryingPermissions(permissions: readonly string[]): boolean {
  return permissions.includes(ROLE_ADMIN_PERMISSION)
}
