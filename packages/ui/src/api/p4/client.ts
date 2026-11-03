/**
 * P4 问数 API 客户端（P4-UI 线新增；联调点集中层）。
 *
 * 架构约束：
 * - AR-03/AR-04：只消费**接入层**（apps/api，默认 http://127.0.0.1:3001）的 HTTP 合同，
 *   终端不直连 apps/ai 端口（4300）——本客户端无任何 apps/ai 地址配置面；
 * - AR-11/AR-12：健康探测与问数轮均设客户端超时上限（不静默空白、不超时悬挂），
 *   超时按失败态返回（health → unavailable/unreachable；turn → ApiError ERR_TIMEOUT）；
 * - 鉴权：Authorization: Bearer <token>（登录会话，OA 同源）；401 触发 onUnauthorized；
 * - 错误：非 2xx 统一体 {code,message,details} → ApiError（复用既有 client 的错误形状，
 *   规则码中文映射见 ./errorMessages）；health 的 503 不抛错（降级判定源，返回 unavailable 形状）。
 *
 * 接缝说明（真实接线归 L0，AR-21/22）：
 * - POST /aiquery/sessions 为 A 线已实现端点；
 * - POST /aiquery/turns、POST /aiquery/turns/:requestId/cancel、GET /aiquery/health 为
 *   接入层转发 apps/ai（DS-23 四端点）的用户面——本客户端按冻结合同形状先行定义，
 *   L0 整合时以同形状挂载，字段漂移视为合同违约（DS-21 同则）。
 */

import { ApiError, type ApiMode } from '../client'
import { MockError } from '../mock'
import { mockAiQueryRoutes } from './mock'
import type {
  AiAskCancelResponseDto,
  AiAskTurnRequestDto,
  AiAskTurnResponseDto,
  AiQueryHealthResponseDto,
  AiSessionOpenRequestDto,
  AiSessionOpenResponseDto,
} from './types'

export * from './types'
export { aiQueryRuleCodeOf, formatAiQueryError, AIQUERY_RULE_MESSAGES_ZH } from './errorMessages'
export { resetMockAiQueryState, setMockAiQueryHealth } from './mock'

export interface AiQueryClientOptions {
  /** 接入层基地址（apps/api；不配置 apps/ai 地址——AR-03/04） */
  baseURL?: string
  mode?: ApiMode
  /** mock 模拟延迟毫秒 */
  mockLatencyMs?: number
  getToken?: () => string | null
  /** 401 回调：应用侧清会话并跳登录 */
  onUnauthorized?: () => void
  /** 健康探测客户端超时（缺省 5000ms；AR-11 不悬挂） */
  healthTimeoutMs?: number
  /** 问数轮客户端超时（缺省 30000ms；AR-12 接入层转发超时上限之内） */
  turnTimeoutMs?: number
}

export interface AiQueryClient {
  readonly mode: ApiMode
  readonly baseURL: string
  /** 会话登记（A 线已实现端点：用户令牌 + aiquery.use + channel 值域） */
  openSession(request: AiSessionOpenRequestDto): Promise<AiSessionOpenResponseDto>
  /** 发起问数轮（DS-23 outcome 四态；requestId 由 UI 预生成仅为在途取消关联，服务端回执为准） */
  askTurn(request: AiAskTurnRequestDto): Promise<AiAskTurnResponseDto>
  /** 取消在途轮次（DS-11：取消后不再发起新的工具调用） */
  cancelTurn(requestId: string): Promise<AiAskCancelResponseDto>
  /** 健康探测（经接入层代理面；不可达/超时 → unavailable/unreachable，不抛错） */
  health(): Promise<AiQueryHealthResponseDto>
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:3001'

function newRequestId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** UI 侧轮次标识生成（AR-15 requestId 为 UUID；服务端回执为准，AQ-REG-06）。 */
export function newAiRequestId(): string {
  return newRequestId()
}

function abortSignalOf(ms: number): AbortSignal | null {
  const c = globalThis.AbortSignal
  if (c && typeof c.timeout === 'function') return c.timeout(ms)
  return null
}

interface RawErrorBody {
  code?: unknown
  message?: unknown
  details?: unknown
}

function toApiError(status: number, body: RawErrorBody | null, requestId?: string): ApiError {
  return new ApiError({
    code: typeof body?.code === 'string' ? body.code : 'ERR_UNKNOWN',
    message:
      typeof body?.message === 'string' && body.message
        ? body.message
        : `请求失败（HTTP ${status}）`,
    details: body?.details,
    httpStatus: status,
    requestId,
  })
}

export function createAiQueryClient(options: AiQueryClientOptions = {}): AiQueryClient {
  const mode: ApiMode = options.mode ?? 'live'
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const mockLatency = options.mockLatencyMs ?? 120
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  const turnTimeoutMs = options.turnTimeoutMs ?? 30_000

  async function requestJson(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; timeoutMs: number; onUnauthorized: boolean } = { timeoutMs: 15_000, onUnauthorized: true },
  ): Promise<{ status: number; body: unknown; requestId?: string }> {
    const token = options.getToken?.() ?? null

    if (mode === 'mock') {
      await new Promise((r) => setTimeout(r, mockLatency))
      const handler = mockAiQueryRoutes(method, path)
      if (!handler) {
        throw new ApiError({ code: 'ERR_NOT_FOUND', message: `mock 未定义路由：${method} ${path}`, httpStatus: 404 })
      }
      try {
        const data = await handler({ token, body: opts.body })
        return { status: 200, body: data }
      } catch (err) {
        if (err instanceof MockError) {
          if (err.httpStatus === 401 && opts.onUnauthorized) options.onUnauthorized?.()
          throw new ApiError({ code: err.code, message: err.message, details: err.details, httpStatus: err.httpStatus })
        }
        throw err
      }
    }

    const url = new URL(`${baseURL}${path}`)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: abortSignalOf(opts.timeoutMs) ?? undefined,
      })
    } catch (cause) {
      // 中止=客户端超时（AR-11/12 不悬挂）；其余=网络失败
      const aborted = cause instanceof DOMException && cause.name === 'TimeoutError'
      throw new ApiError({
        code: aborted ? 'ERR_TIMEOUT' : 'ERR_NETWORK',
        message: aborted
          ? `请求超时：AI 问数未在时限内返回 [AR-12]`
          : cause instanceof Error
            ? `网络请求失败：${cause.message}`
            : '网络请求失败',
      })
    }
    const requestId = res.headers.get('x-request-id') ?? undefined
    if (res.status === 401 && opts.onUnauthorized) {
      options.onUnauthorized?.()
    }
    let body: unknown = null
    if (res.status !== 204) {
      try {
        body = await res.json()
      } catch {
        body = null
      }
    }
    return { status: res.status, body, requestId }
  }

  return {
    mode,
    baseURL,
    async openSession(request) {
      const { status, body, requestId } = await requestJson('POST', '/aiquery/sessions', {
        body: request,
        timeoutMs: turnTimeoutMs,
        onUnauthorized: true,
      })
      if (status === 401) throw toApiError(401, body as RawErrorBody | null, requestId) // onUnauthorized 已回调
      if (!(status === 200 || status === 201)) throw toApiError(status, body as RawErrorBody | null, requestId)
      return body as AiSessionOpenResponseDto
    },
    async askTurn(request) {
      const { status, body, requestId } = await requestJson('POST', '/aiquery/turns', {
        body: request,
        timeoutMs: turnTimeoutMs,
        onUnauthorized: true,
      })
      if (status === 401) throw toApiError(401, body as RawErrorBody | null, requestId)
      if (status !== 200) throw toApiError(status, body as RawErrorBody | null, requestId)
      return body as AiAskTurnResponseDto
    },
    async cancelTurn(requestId) {
      const { status, body, requestId: rid } = await requestJson(
        'POST',
        `/aiquery/turns/${encodeURIComponent(requestId)}/cancel`,
        { body: {}, timeoutMs: turnTimeoutMs, onUnauthorized: true },
      )
      if (status === 401) throw toApiError(401, body as RawErrorBody | null, rid)
      if (status !== 200) throw toApiError(status, body as RawErrorBody | null, rid)
      return body as AiAskCancelResponseDto
    },
    async health() {
      try {
        const { status, body } = await requestJson('GET', '/aiquery/health', {
          timeoutMs: healthTimeoutMs,
          // 探测端点不做 401 跳转（入口降级判定，非业务请求）
          onUnauthorized: false,
        })
        // 统一形状判定：body 自述 status（200 直述 / 503 携带均可），不按 HTTP 码猜测
        const parsed = body as { status?: unknown; reason?: unknown; message?: unknown } | null
        const reasonOf = (): 'unreachable' | 'over_limit' | 'starting' =>
          parsed?.reason === 'over_limit' || parsed?.reason === 'starting' || parsed?.reason === 'unreachable' ? parsed.reason : 'unreachable'
        if (parsed?.status === 'ok') return body as AiQueryHealthResponseDto
        if (parsed?.status === 'unavailable') {
          return {
            status: 'unavailable' as const,
            reason: reasonOf(),
            message:
              typeof parsed.message === 'string' && parsed.message
                ? parsed.message
                : 'AI 问数暂不可用 [AR-11]',
          }
        }
        if (status === 503) {
          return { status: 'unavailable' as const, reason: reasonOf(), message: 'AI 问数暂不可用 [AR-11]' }
        }
        return { status: 'unavailable' as const, reason: 'unreachable' as const, message: `AI 问数服务探测失败（HTTP ${status}）[AR-11]` }
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'ERR_TIMEOUT' || err.code === 'ERR_NETWORK')) {
          return { status: 'unavailable' as const, reason: 'unreachable' as const, message: err.message }
        }
        throw err
      }
    },
  }
}
