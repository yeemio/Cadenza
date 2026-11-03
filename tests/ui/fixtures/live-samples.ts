import type { AuthMeResponse, OrgNodeDto, PageResult, RoleDto, ScopeGrantDto, UserAccountDto } from '@cadenza/contracts'
import type { LoginResponse } from '@cadenza/ui'

/**
 * live 形状样本夹具：与 apps/api 实际响应形状逐一对齐
 * （AuthController / OrgController / AllExceptionsFilter / OrgQueryService，
 *  逐文件核对于 2026-10-27；字段语义见 packages/contracts/src/auth.ts）。
 * 供 tests/ui live-shape / live-smoke 用例在编译期（contracts 类型）与运行时双重对齐。
 */

/** POST /auth/login 成功响应（控制器只回 userId/loginName；上下文经 /auth/me） */
export const SAMPLE_LOGIN_OK: LoginResponse = {
  token: 'a3f0c9e2-1b4d-4c6a-9e2f-7d8b5a1c0e3f',
  tokenType: 'Bearer',
  expiresAt: '2026-10-27T12:00:00.000Z',
  user: { userId: '0192f0a1-1111-7000-8000-abc000000001', loginName: 'admin' },
}

/** GET /auth/me 成功响应（OA-23/25：许可与数据范围服务端计算） */
export const SAMPLE_AUTH_ME: AuthMeResponse = {
  user: {
    userId: '0192f0a1-1111-7000-8000-abc000000001',
    loginName: 'admin',
    displayName: '系统管理员',
    enterpriseId: '0192f0a0-0000-7000-8000-ent000000001',
    enterpriseName: '华东电缆集团',
    plantId: '0192f0a0-0000-7000-8000-plt000000001',
    plantName: '华东电缆合肥工厂',
    roleId: '0192f0a0-0000-7000-8000-rol000000001',
    roleName: '系统管理员',
    loginPlatform: 'WEB',
  },
  permissions: ['org.read', 'org.admin', 'org.role.admin'],
  dataScope: { enterpriseWide: true, plantIds: ['0192f0a0-0000-7000-8000-plt000000001'] },
  session: { id: '0192f0a2-2222-7000-8000-ses000000001', expiresAt: '2026-10-27T12:00:00.000Z' },
}

/** GET /org/users?page=1&pageSize=10 成功响应（PageResult + UserAccountDto，无 password_hash） */
export const SAMPLE_USERS_PAGE: PageResult<UserAccountDto> = {
  items: [
    {
      id: '0192f0a1-1111-7000-8000-abc000000001',
      loginName: 'admin',
      displayName: '系统管理员',
      deptId: '0192f0a0-0000-7000-8000-dep000000001',
      workshopDeptId: null,
      roleId: '0192f0a0-0000-7000-8000-rol000000001',
      loginPlatform: 'WEB',
      accountStatus: 'enabled',
      plantId: '0192f0a0-0000-7000-8000-plt000000001',
      phone: null,
      failedLoginCount: 0,
      lockedUntil: null,
      status: 'active',
    },
    {
      id: '0192f0a1-1111-7000-8000-abc000000002',
      loginName: 'hfadmin01',
      displayName: '合肥厂管理员',
      deptId: '0192f0a0-0000-7000-8000-dep000000002',
      workshopDeptId: null,
      roleId: '0192f0a0-0000-7000-8000-rol000000002',
      loginPlatform: 'WEB',
      accountStatus: 'enabled',
      plantId: '0192f0a0-0000-7000-8000-plt000000001',
      phone: null,
      failedLoginCount: 0,
      lockedUntil: null,
      status: 'active',
    },
  ],
  total: 6,
  page: 1,
  pageSize: 10,
}

/** GET /org/nodes 成功响应样本（kind/deptCategory 真实字典） */
export const SAMPLE_NODES_PAGE: PageResult<OrgNodeDto> = {
  items: [
    {
      id: '0192f0a0-0000-7000-8000-ent000000001',
      kind: 'enterprise',
      code: 'EC-GROUP',
      name: '华东电缆集团',
      parentId: null,
      parentKind: null,
      path: '/0192f0a0-0000-7000-8000-ent000000001/',
      depth: 0,
      plantCode: null,
      companyOrgCode: null,
      deptCategory: null,
      status: 'active',
    },
    {
      id: '0192f0a0-0000-7000-8000-dep000000010',
      kind: 'department',
      code: 'PLT-HF-DRAW',
      name: '拉丝车间',
      parentId: '0192f0a0-0000-7000-8000-plt000000001',
      parentKind: 'plant',
      path: '/0192f0a0-0000-7000-8000-ent000000001/0192f0a0-0000-7000-8000-plt000000001/0192f0a0-0000-7000-8000-dep000000010/',
      depth: 3,
      plantCode: null,
      companyOrgCode: null,
      deptCategory: 1,
      status: 'active',
    },
  ],
  total: 2,
  page: 1,
  pageSize: 100,
}

/** GET /org/roles 成功响应样本 */
export const SAMPLE_ROLES_PAGE: PageResult<RoleDto> = {
  items: [
    { id: '0192f0a0-0000-7000-8000-rol000000001', name: '系统管理员', alias: 'sys_admin', sort: 1, isSystem: 2, parentRoleId: null, status: 'active' },
    { id: '0192f0a0-0000-7000-8000-rol000000002', name: '厂区管理员', alias: 'plant_admin', sort: 2, isSystem: 1, parentRoleId: null, status: 'active' },
  ],
  total: 2,
  page: 1,
  pageSize: 10,
}

/** GET /org/grants 成功响应样本 */
export const SAMPLE_GRANTS_PAGE: PageResult<ScopeGrantDto> = {
  items: [
    {
      id: '0192f0a0-0000-7000-8000-grt000000001',
      principalType: 'role',
      principalId: '0192f0a0-0000-7000-8000-rol000000001',
      permissions: ['org.read', 'org.admin', 'org.role.admin'],
      scopeType: 'enterprise',
      scopeObjectId: '0192f0a0-0000-7000-8000-ent000000001',
      status: 'active',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 10,
}

/** 命令端点成功响应（COMMITTED；业务拒绝走非 2xx） */
export const SAMPLE_COMMAND_OK = {
  operationId: '0192f0a3-3333-7000-8000-op0000000001',
  status: 'COMMITTED',
  data: { userId: '0192f0a1-1111-7000-8000-abc000000009', loginName: 'newuser01' },
} as const

/** 401 错误体（AuthGuard / AllExceptionsFilter：{code,message,details}） */
export const SAMPLE_ERROR_401 = {
  code: 'ERR_AUTH_REQUIRED',
  message: '会话无效或已过期',
  details: {},
} as const

/** 422 业务拒绝错误体（命令端点：details 带 operationId；message 含 [OA-xx]） */
export const SAMPLE_ERROR_422 = {
  code: 'ERR_BUSINESS_RULE',
  message: '[OA-10] 登录账号已存在：admin',
  details: { operationId: '0192f0a3-3333-7000-8000-op0000000002' },
} as const

/** 登录失败错误体（登录失败统一 401 ERR_AUTH_REQUIRED，不泄露账号存在性） */
export const SAMPLE_LOGIN_401 = {
  code: 'ERR_AUTH_REQUIRED',
  message: '登录账号或密码错误',
  details: {},
} as const
