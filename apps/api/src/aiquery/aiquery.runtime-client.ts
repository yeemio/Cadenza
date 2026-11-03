/**
 * apps/ai 运行服务 HTTP 客户端（dsh-edge.md §5 DS-23/DS-24；P4-A 补充任务新增）。
 *
 * 接入层 → apps/ai 的唯一通道（AR-03：终端不直连 apps/ai；AR-12：转发设超时上限）：
 * - POST /ai-runtime/sessions（会话登记，DS-23；建 ai_session 后同步登记，best-effort）；
 * - POST /ai-runtime/turns（问数轮：requestId/sessionId/userMessage + timeBasis Asia/Shanghai）；
 * - POST /ai-runtime/turns/:requestId/cancel（DS-11 取消）；
 * - GET /ai-runtime/health（AR-11 降级判定源）。
 * 认证：Bearer 内部服务令牌（env AI_RUNTIME_INTERNAL_TOKEN；凭据不构成权限来源）。
 * apps/ai 基址 env AI_RUNTIME_URL（缺省 http://127.0.0.1:4300，B 线端口约定）。
 * env 逐调用读取（部署一次性配置；测试可在进程内切换指向）。
 */

/** DS-23 轮次响应（B 线 apps/ai/src/orchestrator.ts TurnResponse 同形透传）。 */
export interface AiRuntimeTurnResponse {
  outcome: 'answer' | 'clarify' | 'unavailable' | 'cancelled'
  message?: string
  options?: Array<{ id: string; label: string; detail?: Record<string, unknown>; confirm?: { capabilityId: string; params: Record<string, unknown> } }>
  answerRefs?: Array<{
    capabilityId: string
    capabilityVersion: number
    status: string
    completeness: unknown
    freshness: unknown
    auditRef: { requestId: string; toolCallSeq: number }
  }>
  statusDetail: Record<string, unknown>
}

export type AiRuntimeTurnResult = { unreachable: true; detail: string } | { unreachable: false; response: AiRuntimeTurnResponse }

export interface AiRuntimeHealthResult {
  ok: boolean
  runtime?: Record<string, unknown>
  detail?: string
}

export interface AiRuntimeCancelResult {
  ok: boolean
  decision?: string
  detail?: string
}

/** 单轮转发超时上限（AR-12；env AI_RUNTIME_TURN_TIMEOUT_MS 可覆盖，缺省 25s——UI 客户端 30s 之内）。 */
export function resolveTurnTimeoutMs(): number {
  const raw = process.env['AI_RUNTIME_TURN_TIMEOUT_MS']
  if (raw === undefined || raw === '') return 25_000
  const n = Number(raw)
  return Number.isInteger(n) && n >= 100 ? n : 25_000
}

const HEALTH_TIMEOUT_MS = 3_000

function baseUrl(): string {
  return (process.env['AI_RUNTIME_URL'] ?? 'http://127.0.0.1:4300').replace(/\/+$/, '')
}

function token(): string {
  return process.env['AI_RUNTIME_INTERNAL_TOKEN'] ?? ''
}

async function postJson(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: unknown } | { unreachable: true; detail: string }> {
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const parsed = (await response.json().catch(() => null)) as unknown
    return { status: response.status, body: parsed }
  } catch (error) {
    return { unreachable: true, detail: error instanceof Error ? error.message : String(error) }
  }
}

export class AiRuntimeClient {
  /** 会话登记（DS-23：建 ai_session 后同步登记；best-effort——B 不可达不阻断会话建立，轮次自会报 unavailable）。 */
  async registerSession(input: {
    sessionId: string
    enterpriseId: string
    userId: string
    channel: string
    conversationRef?: string | null
  }): Promise<boolean> {
    const result = await postJson('/ai-runtime/sessions', input, HEALTH_TIMEOUT_MS)
    return !(typeof result === 'object' && result !== null && 'unreachable' in result) && result.status === 201
  }

  async runTurn(input: { requestId: string; sessionId: string; userMessage: string }): Promise<AiRuntimeTurnResult> {
    const result = await postJson(
      '/ai-runtime/turns',
      { ...input, timeBasis: { timeZone: 'Asia/Shanghai' } },
      resolveTurnTimeoutMs(),
    )
    if ('unreachable' in result) return { unreachable: true, detail: result.detail }
    if (result.status !== 200 || typeof result.body !== 'object' || result.body === null) {
      return { unreachable: true, detail: `AI 运行服务应答异常（HTTP ${String(result.status)}）` }
    }
    const body = result.body as Record<string, unknown>
    if (typeof body['outcome'] !== 'string' || typeof body['statusDetail'] !== 'object') {
      return { unreachable: true, detail: 'AI 运行服务轮次应答形状非法（DS-23）' }
    }
    return { unreachable: false, response: body as unknown as AiRuntimeTurnResponse }
  }

  async cancelTurn(requestId: string): Promise<AiRuntimeCancelResult> {
    const result = await postJson(`/ai-runtime/turns/${encodeURIComponent(requestId)}/cancel`, {}, HEALTH_TIMEOUT_MS)
    if ('unreachable' in result) return { ok: false, detail: result.detail }
    if (result.status !== 200 || typeof result.body !== 'object' || result.body === null) {
      return { ok: false, detail: `AI 运行服务取消应答异常（HTTP ${String(result.status)}）` }
    }
    const decision = (result.body as Record<string, unknown>)['decision']
    return { ok: true, decision: typeof decision === 'string' ? decision : undefined }
  }

  async health(): Promise<AiRuntimeHealthResult> {
    try {
      const response = await fetch(`${baseUrl()}/ai-runtime/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      if (response.status !== 200) return { ok: false, detail: `HTTP ${String(response.status)}` }
      const body = (await response.json().catch(() => null)) as { status?: unknown; runtime?: unknown } | null
      if (body === null || body.status !== 'ok') return { ok: false, detail: 'health 应答形状非法' }
      return { ok: true, runtime: (body.runtime ?? null) as Record<string, unknown> | undefined }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }
}
