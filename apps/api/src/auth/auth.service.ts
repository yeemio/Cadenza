import { Inject, Injectable } from '@nestjs/common'
// 注意：vitest/esbuild 不发射 design:paramtypes 元数据，类类型注入一律显式 @Inject
// （运行时 tsc dist 有元数据，显式注入同样成立）。
import { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import type { SessionUserInfo } from '@cadenza/contracts'
import {
  createScryptPasswordHasher,
  login as loginUseCase,
  logout as logoutUseCase,
  SessionVerifier,
  type LoginSuccess,
  type VerifiedAuthContext,
} from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
} from '@cadenza/persistence'
import { PG_POOL } from '../db/db.module'
import { AuthFlowError } from '@cadenza/application'

/**
 * 认证服务：登录（失败计数锁定、会话签发）/ 会话校验 / 登出撤销。
 * 只读路径直接使用连接池；审计随用例写入（auth.* 动作，OA-28）。
 */
@Injectable()
export class AuthService {
  private readonly verifier: SessionVerifier
  private readonly sessionTtlMinutes: number
  private readonly maxLoginFailures: number
  private readonly lockMinutes: number
  private readonly hasher = createScryptPasswordHasher()

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.sessionTtlMinutes = config.get<number>('AUTH_SESSION_TTL_MINUTES', 720)!
    this.maxLoginFailures = config.get<number>('AUTH_MAX_LOGIN_FAILURES', 5)!
    this.lockMinutes = config.get<number>('AUTH_LOCK_MINUTES', 15)!
    this.verifier = new SessionVerifier({
      users: new PgUserAccountRepository(pool),
      org: new PgOrgNodeRepository(pool),
      roles: new PgRoleRepository(pool),
      grants: new PgScopeGrantRepository(pool),
      sessions: new PgAuthSessionRepository(pool),
      now: () => new Date(),
    })
  }

  /** 登录成功返回令牌与用户信息；失败抛 AuthFlowError（HTTP 401 ERR_AUTH_REQUIRED）。 */
  async login(input: {
    loginName: string
    password: string
    platform?: 'WEB' | 'PDA'
  }): Promise<LoginSuccess> {
    return loginUseCase(
      {
        users: new PgUserAccountRepository(this.pool),
        org: new PgOrgNodeRepository(this.pool),
        sessions: new PgAuthSessionRepository(this.pool),
        audit: new PgAuditWriter(this.pool),
        hasher: this.hasher,
        now: () => new Date(),
        sessionTtlMinutes: this.sessionTtlMinutes,
        maxLoginFailures: this.maxLoginFailures,
        lockMinutes: this.lockMinutes,
      },
      input,
    )
  }

  /** Bearer 令牌 → 授权上下文（许可 + 数据范围服务端计算，OA-23/25）。 */
  async verifyToken(token: string): Promise<VerifiedAuthContext | null> {
    return this.verifier.verify(token)
  }

  async logout(auth: VerifiedAuthContext): Promise<void> {
    await logoutUseCase(
      {
        sessions: new PgAuthSessionRepository(this.pool),
        audit: new PgAuditWriter(this.pool),
        now: () => new Date(),
      },
      { id: auth.user.id, loginName: auth.user.loginName },
      auth.session.id,
    )
  }

  /** 登录/会话信息组装（/auth/me 载荷）。 */
  async meInfo(auth: VerifiedAuthContext): Promise<{
    user: SessionUserInfo
    permissions: string[]
    dataScope: { enterpriseWide: boolean; plantIds: string[] }
    session: { id: string; expiresAt: string }
  }> {
    const org = new PgOrgNodeRepository(this.pool)
    const [enterprise, plant] = await Promise.all([
      org.findById(auth.user.enterpriseId),
      org.findById(auth.user.plantId),
    ])
    return {
      user: {
        userId: auth.user.id,
        loginName: auth.user.loginName,
        displayName: auth.user.displayName,
        enterpriseId: auth.user.enterpriseId,
        enterpriseName: enterprise?.name ?? '',
        plantId: auth.user.plantId,
        plantName: plant?.name ?? '',
        roleId: auth.role.id,
        roleName: auth.role.name,
        loginPlatform: auth.user.loginPlatform,
      },
      permissions: auth.permissions,
      dataScope: auth.dataScope,
      session: auth.session,
    }
  }
}

export { AuthFlowError }
