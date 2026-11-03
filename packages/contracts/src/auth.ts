/**
 * 组织与权限（org-auth）HTTP 合同类型 —— P1-S2 增补（仅 auth/org 相关）。
 * 对应冻结合同 architecture/contracts/frozen/p1/org-auth.md。
 * 注意：contracts 零依赖且不得反向依赖 domain（domain → contracts 才是允许方向），
 * 因此此处本地定义与 domain 同形的线级联合类型。
 */

/** 登录平台（与 domain/org LOGIN_PLATFORMS 同形） */
export type LoginPlatform = 'WEB' | 'PDA'

/** 数据范围三维（与 domain/org ScopeType 同形；OA-23） */
export type ScopeType = 'enterprise' | 'plant' | 'workshop'

export interface LoginRequest {
  loginName: string
  password: string
  platform?: LoginPlatform
}

/** 会话用户信息（不含 password_hash——人员资料敏感字段不外泄，OA-27 底线）。 */
export interface SessionUserInfo {
  userId: string
  loginName: string
  displayName: string
  enterpriseId: string
  enterpriseName: string
  /** 主岗工厂（OA-33 隔离列，服务端由部门归属计算） */
  plantId: string
  plantName: string
  roleId: string
  roleName: string
  loginPlatform: LoginPlatform
}

export interface LoginSuccessResponse {
  token: string
  tokenType: 'Bearer'
  expiresAt: string
  user: SessionUserInfo
}

/** OA-25 服务端计算的数据范围（查询过滤、导出、附件同一口径）。 */
export interface DataScopeInfo {
  /** true=覆盖本企业全部工厂（仍受企业隔离，OA-33） */
  enterpriseWide: boolean
  plantIds: string[]
}

export interface AuthMeResponse {
  user: SessionUserInfo
  /** 岗位操作许可（OA-23 第一元，服务端计算，不信客户端自报） */
  permissions: string[]
  dataScope: DataScopeInfo
  session: { id: string; expiresAt: string }
}

export interface OrgNodeDto {
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
}

export interface UserAccountDto {
  id: string
  loginName: string
  displayName: string
  deptId: string
  workshopDeptId: string | null
  roleId: string
  loginPlatform: LoginPlatform
  accountStatus: string
  plantId: string
  phone: string | null
  failedLoginCount: number
  lockedUntil: string | null
  status: string
}

export interface RoleDto {
  id: string
  name: string
  alias: string
  sort: number
  isSystem: number
  parentRoleId: string | null
  status: string
}

export interface ScopeGrantDto {
  id: string
  principalType: 'role' | 'user'
  principalId: string
  permissions: string[]
  scopeType: ScopeType
  scopeObjectId: string
  status: string
}
