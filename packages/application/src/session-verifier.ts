import type { DataScope, LoginPlatform } from '@cadenza/domain'
import { computeDataScope, unionPermissions } from '@cadenza/domain'
import { hashToken } from './login'
import type {
  AuthSessionRepository,
  OrgNodeRepository,
  RoleRepository,
  ScopeGrantRepository,
  UserAccountRepository,
} from './repositories'

/**
 * 会话校验与授权上下文计算（OA-23/25：岗位许可 + 数据范围全部服务端计算）。
 * 每个 HTTP 请求由 AuthGuard 调用一次，结果挂到请求上下文。
 */
export interface VerifiedAuthContext {
  session: { id: string; expiresAt: string }
  user: {
    id: string
    loginName: string
    displayName: string
    enterpriseId: string
    plantId: string
    roleId: string
    loginPlatform: LoginPlatform
  }
  role: { id: string; name: string; alias: string }
  permissions: string[]
  dataScope: DataScope
}

export interface SessionVerifierDeps {
  users: UserAccountRepository
  org: OrgNodeRepository
  roles: RoleRepository
  grants: ScopeGrantRepository
  sessions: AuthSessionRepository
  now(): Date
}

export class SessionVerifier {
  constructor(private readonly deps: SessionVerifierDeps) {}

  /** 校验 Bearer 令牌 → 授权上下文；任何不满足（无会话/过期/撤销/禁用/注销）返回 null。 */
  async verify(token: string): Promise<VerifiedAuthContext | null> {
    const { users, org, roles, grants, sessions } = this.deps
    const session = await sessions.findActiveByTokenHash(hashToken(token), this.deps.now())
    if (session === null) return null
    const user = await users.findById(session.userId)
    if (user === null || user.status === 'retired' || user.accountStatus === 'disabled') return null

    const [role, grantRows, nodes] = await Promise.all([
      roles.findById(user.roleId),
      grants.listActiveByPrincipals([
        { principalType: 'role', principalId: user.roleId },
        { principalType: 'user', principalId: user.id },
      ]),
      org.listActiveByEnterprise(user.enterpriseId),
    ])
    if (role === null || role.status === 'retired') return null

    const grantLikes = grantRows.map((g) => ({
      principalType: g.principalType,
      principalId: g.principalId,
      permissions: g.permissions,
      scopeType: g.scopeType,
      scopeObjectId: g.scopeObjectId,
    }))
    const dataScope = computeDataScope(
      grantLikes,
      nodes.map((n) => ({ id: n.id, parentId: n.parentId, kind: n.kind, path: n.path, status: n.status })),
    )

    return {
      session: { id: session.id, expiresAt: session.expiresAt },
      user: {
        id: user.id,
        loginName: user.loginName,
        displayName: user.displayName,
        enterpriseId: user.enterpriseId,
        plantId: user.plantId,
        roleId: user.roleId,
        loginPlatform: user.loginPlatform,
      },
      role: { id: role.id, name: role.name, alias: role.alias },
      permissions: unionPermissions(grantLikes),
      dataScope,
    }
  }
}
