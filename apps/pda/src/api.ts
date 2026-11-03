import {
  apiModeFromEnv,
  createApiClient,
  type ApiClient,
  type ApiMode,
  type DataScopeInfo,
  type SessionUserInfo,
} from '@cadenza/ui'

/**
 * PDA API 装配点（联调层入口）：与 web 相同约定。
 * - VITE_API_MODE=live（默认）直连 apps/api；=mock 演示数据（会话 key 独立于 web）。
 * - 会话 = 登录令牌 + /auth/me 上下文；PDA 任务端点为占位（后端 PDA 域未交付）。
 */
const env = import.meta.env as Record<string, string | undefined>

export const apiMode: ApiMode = apiModeFromEnv(env)
export const isMock = apiMode === 'mock'

const SESSION_KEY = 'cadenza.pda.session'

export interface StoredSession {
  token: string
  expiresAt: string
  user: SessionUserInfo
  permissions: string[]
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

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}
