import { createHash, randomBytes } from 'node:crypto'
import type { LoginPlatform } from '@cadenza/domain'
import {
  assertLoginEligibility,
  assertLoginNameValid,
  DEFAULT_LOCK_MINUTES,
  DEFAULT_MAX_LOGIN_FAILURES,
  nextFailureState,
} from '@cadenza/domain'
import type {
  AuthSessionRepository,
  AuditWriter,
  OrgNodeRepository,
  UserAccountRepository,
  UserAccountRecord,
} from './repositories'
import type { PasswordHasher } from './password'

/**
 * 登录用例（OA-10/16；SA §8 会话签发/撤销）：
 * - 账号禁用不可登录；失败计数达上限锁定；成功后签发不透明会话令牌（库存哈希）；
 * - 一切判定在服务端完成；凭据不写日志。
 */
export class AuthFlowError extends Error {
  readonly code: string
  readonly httpStatus: number

  constructor(code: string, message: string, httpStatus = 401) {
    super(message)
    this.name = 'AuthFlowError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export interface LoginDeps {
  users: UserAccountRepository
  org: Pick<OrgNodeRepository, 'findById'>
  sessions: AuthSessionRepository
  audit: AuditWriter
  hasher: PasswordHasher
  now(): Date
  /** 会话有效期（分钟） */
  sessionTtlMinutes: number
  maxLoginFailures?: number
  lockMinutes?: number
}

export interface LoginSuccess {
  token: string
  expiresAt: string
  user: {
    userId: string
    loginName: string
    displayName: string
    enterpriseId: string
    plantId: string
    roleId: string
    loginPlatform: string
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function login(
  deps: LoginDeps,
  input: { loginName: string; password: string; platform?: LoginPlatform },
): Promise<LoginSuccess> {
  const { users, sessions, audit, hasher, now } = deps
  const nowDate = now()
  const maxFailures = deps.maxLoginFailures ?? DEFAULT_MAX_LOGIN_FAILURES
  const lockMinutes = deps.lockMinutes ?? DEFAULT_LOCK_MINUTES

  // OA-10：字符集仅字母与数字（防异常输入；存在性信息不外泄）
  try {
    assertLoginNameValid(input.loginName)
  } catch {
    throw new AuthFlowError('ERR_AUTH_REQUIRED', '登录账号或密码错误')
  }

  const user = await users.findByLoginName(input.loginName)
  if (user === null) {
    throw new AuthFlowError('ERR_AUTH_REQUIRED', '登录账号或密码错误')
  }

  // OA-16：禁用不可登录；锁定缓存到期前拒绝（解封仅清缓存）
  try {
    assertLoginEligibility({
      accountStatus: user.accountStatus,
      status: user.status,
      lockedUntil: user.lockedUntil,
      now: nowDate,
    })
  } catch (error) {
    await audit.record({
      actor: input.loginName,
      action: 'auth.login.rejected',
      subjectType: 'user_account',
      subjectId: user.id,
      reason: error instanceof Error ? error.message : '登录资格校验未通过',
    })
    throw new AuthFlowError('ERR_AUTH_REQUIRED', error instanceof Error ? error.message : '登录被拒绝')
  }

  // 登录平台口径：账号登记的平台须与请求平台一致（OA-12 登录平台字段的服务端使用）
  if (input.platform != null && user.loginPlatform !== input.platform) {
    throw new AuthFlowError('ERR_AUTH_REQUIRED', `该账号登录平台为 ${user.loginPlatform}，与请求平台不符`)
  }

  const ok = await hasher.verify(input.password, user.passwordHash)
  if (!ok) {
    const next = nextFailureState(
      { failedLoginCount: user.failedLoginCount, lockedUntil: user.lockedUntil ? new Date(user.lockedUntil) : null },
      nowDate,
      maxFailures,
      lockMinutes,
    )
    await users.update(user.id, { failedLoginCount: next.failedLoginCount, lockedUntil: next.lockedUntil }, 'auth')
    await audit.record({
      actor: input.loginName,
      action: 'auth.login.failed',
      subjectType: 'user_account',
      subjectId: user.id,
      after: {
        failedLoginCount: next.failedLoginCount,
        locked: next.lockedUntil !== null && next.lockedUntil > (user.lockedUntil ? new Date(user.lockedUntil) : new Date(0)),
      },
    })
    throw new AuthFlowError('ERR_AUTH_REQUIRED', '登录账号或密码错误')
  }

  // 成功：清失败计数并签发会话（不透明随机令牌，库中仅存 sha256）
  if (user.failedLoginCount !== 0 || user.lockedUntil !== null) {
    await users.update(user.id, { failedLoginCount: 0, lockedUntil: null }, 'auth')
  }
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(nowDate.getTime() + deps.sessionTtlMinutes * 60_000)
  const session = await sessions.issue({
    tokenHash: hashToken(token),
    userId: user.id,
    enterpriseId: user.enterpriseId,
    plantId: user.plantId,
    loginPlatform: input.platform ?? user.loginPlatform,
    issuedAt: nowDate,
    expiresAt,
  })
  await audit.record({
    actor: user.loginName,
    action: 'auth.login',
    subjectType: 'auth_session',
    subjectId: session.id,
    after: { userId: user.id, expiresAt: session.expiresAt },
  })

  return {
    token,
    expiresAt: session.expiresAt,
    user: {
      userId: user.id,
      loginName: user.loginName,
      displayName: user.displayName,
      enterpriseId: user.enterpriseId,
      plantId: user.plantId,
      roleId: user.roleId,
      loginPlatform: user.loginPlatform,
    },
  }
}

export async function logout(
  deps: Pick<LoginDeps, 'sessions' | 'audit' | 'now'>,
  actor: Pick<UserAccountRecord, 'id' | 'loginName'>,
  sessionId: string,
): Promise<void> {
  await deps.sessions.revoke(sessionId, deps.now())
  await deps.audit.record({
    actor: actor.loginName,
    action: 'auth.logout',
    subjectType: 'auth_session',
    subjectId: sessionId,
  })
}
