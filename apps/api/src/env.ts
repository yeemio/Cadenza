import { DEFAULT_DEV_DATABASE_URL } from '@cadenza/persistence'

/**
 * 环境变量校验（ConfigModule.validate 用）。
 * 无 class-validator 依赖：显式函数校验，失败即抛错阻止启动。
 */

export interface ApiEnv {
  PORT: number
  DATABASE_URL: string
  /** 会话有效期（分钟），默认 720（实现参数） */
  AUTH_SESSION_TTL_MINUTES: number
  /** 登录失败锁定阈值（实现参数，原文未定量） */
  AUTH_MAX_LOGIN_FAILURES: number
  /** 登录锁定时长（分钟，实现参数） */
  AUTH_LOCK_MINUTES: number
  /** OA-15 系统参数 account.initPassword（未配置时域规则兜底 '123456'） */
  ACCOUNT_INIT_PASSWORD?: string
}

/** 3000 被其他项目容器占用，默认端口改为 3001，见 delivery/L1/stage1/DELIVERY.md。 */
export const DEFAULT_API_PORT = 3001

function intEnv(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw[key] === undefined ? fallback : Number(raw[key])
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} 非法：${String(raw[key])}（须为 ${min}–${max} 整数）`)
  }
  return value
}

export function validateEnv(raw: Record<string, unknown>): ApiEnv {
  const portRaw = raw['PORT'] ?? String(DEFAULT_API_PORT)
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 非法：${String(portRaw)}（须为 1–65535 整数）`)
  }
  const databaseUrlRaw = raw['DATABASE_URL']
  const databaseUrl =
    typeof databaseUrlRaw === 'string' && databaseUrlRaw.length > 0 ? databaseUrlRaw : undefined
  if (databaseUrl !== undefined && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error(`DATABASE_URL 非法：${databaseUrl}（须为 postgres:// 连接串）`)
  }
  // dev 缺省回落到 compose 默认（与 persistence 包同一常量）；生产部署必须显式提供。
  if (databaseUrl === undefined) {
    console.warn(`[api] DATABASE_URL 未设置，回落 dev 默认：${DEFAULT_DEV_DATABASE_URL}`)
  }
  const initPasswordRaw = raw['ACCOUNT_INIT_PASSWORD']
  return {
    PORT: port,
    DATABASE_URL: databaseUrl ?? DEFAULT_DEV_DATABASE_URL,
    AUTH_SESSION_TTL_MINUTES: intEnv(raw, 'AUTH_SESSION_TTL_MINUTES', 720, 1, 60 * 24 * 30),
    AUTH_MAX_LOGIN_FAILURES: intEnv(raw, 'AUTH_MAX_LOGIN_FAILURES', 5, 1, 100),
    AUTH_LOCK_MINUTES: intEnv(raw, 'AUTH_LOCK_MINUTES', 15, 1, 24 * 60),
    ACCOUNT_INIT_PASSWORD:
      typeof initPasswordRaw === 'string' && initPasswordRaw.length > 0 ? initPasswordRaw : undefined,
  }
}
