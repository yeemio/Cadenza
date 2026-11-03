import {
  apiModeFromEnv,
  createApiClient,
  type ApiClient,
  type ApiMode,
  type DataScopeInfo,
  type SessionUserInfo,
} from '@cadenza/ui'

/**
 * 应用 API 装配点（联调层入口）：
 * - VITE_API_MODE=live（默认）直连 apps/api（VITE_API_BASE_URL，默认 http://127.0.0.1:3001）；
 * - VITE_API_MODE=mock 演示数据（不经网络，界面显示"演示数据"标识）；
 * - 会话 = 登录令牌 + /auth/me 的用户/许可/数据范围（OA-23/25 服务端口径）。
 */
const env = import.meta.env as Record<string, string | undefined>

export const apiMode: ApiMode = apiModeFromEnv(env)
export const isMock = apiMode === 'mock'

/** 会话存取（localStorage）：token + /auth/me 上下文 */
const SESSION_KEY = 'cadenza.web.session'

export interface StoredSession {
  token: string
  expiresAt: string
  user: SessionUserInfo
  /** 岗位操作许可（OA-23） */
  permissions: string[]
  /** 服务端计算的数据范围（OA-25） */
  dataScope: DataScopeInfo
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as StoredSession).token === 'string' &&
      typeof (parsed as StoredSession).user === 'object'
    ) {
      return parsed as StoredSession
    }
    return null
  } catch {
    return null
  }
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY)
}

let unauthorizedHandler: (() => void) | null = null
/** 登录后、会话落库前的过渡令牌（login → me 两步间的请求鉴权） */
let pendingToken: string | null = null

export function setPendingToken(token: string | null): void {
  pendingToken = token
}

export const api: ApiClient = createApiClient({
  mode: apiMode,
  baseURL: env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001',
  getToken: () => pendingToken ?? loadSession()?.token ?? null,
  onUnauthorized: () => unauthorizedHandler?.(),
})

/** 401 时由认证层注册：清会话并跳登录 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}
