/**
 * 内部受控查询客户端（dsh-edge.md §4，DS-18～DS-22；B 线实现）。
 *
 * - HttpControlledQueryClient：按 §4 冻结形状实现 HTTP 客户端（POST capabilities/execute，
 *   Bearer 内部服务令牌；非 2xx 统一 ERR_ 错误形状；网络/5xx 有限重试，
 *   同一 requestId+toolCallSeq 幂等重发——A 线以 UNIQUE 识别重复执行返回既有审计结果）。
 * - MockControlledQueryClient：合同级 mock（测试不经网络即回放信封，DS-21），
 *   支持延迟/挂起注入以复现超时与取消场景。
 * - AQ-AMB-01 澄清候选承载位映射：wire 各能力结果 DTO 的 data.candidates
 *   （contracts AiOrderProgressResultDto.candidates 等）在解析层映射为
 *   ToolResult.clarificationOptions（B 侧内部消费投影，非 wire 字段），
 *   与 HTTP 客户端同一映射源——A 线真实信封无需任何改写即可驱动 DS-08 澄清流。
 *
 * 传输与重试（DS-22）：重试上限与退避来自 RuntimeProfile.retry（由配置声明）；
 * 重试耗尽 → failed 可理解状态（不把失败伪装成 ok_no_records，AQ-REG-10）。
 */
import type { RetryPolicy, ToolResult, ToolResultAuditRef, ClarificationOption } from '../../../packages/integrations/dsh'
import type { AiQueryResultStatus, EnvelopeFailure } from '../../../packages/integrations/dsh'

/** §4 DS-18 capabilities 响应。 */
export interface CapabilityInfo {
  capabilityId: string
  version: number
  displayName: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface UnreadyTopic {
  topic: string
  message: string
}

export interface CapabilitiesResponse {
  capabilities: CapabilityInfo[]
  unreadyTopics: UnreadyTopic[]
}

/** §4 DS-19 execute 请求体（执行上下文字段以服务端绑定为准，AQ-REG-06）。 */
export interface ExecuteRequest {
  requestId: string
  toolCallSeq: number
  sessionId: string
  capabilityId: string
  capabilityVersion: number
  params: Record<string, unknown>
}

export interface ExecuteOptions {
  /** 单次受控查询等待超时（DS-09，对齐 A 线 execute 超时）。 */
  timeoutMs: number
  signal?: AbortSignal
}

export interface ControlledQueryClient {
  readonly mode: 'http' | 'mock'
  listCapabilities(sessionId: string): Promise<CapabilitiesResponse>
  execute(request: ExecuteRequest, options: ExecuteOptions): Promise<ToolResult>
}

export class ControlledQuerySessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const STATUS_VALUES: readonly AiQueryResultStatus[] = [
  'ok_with_data',
  'ok_no_records',
  'no_permission',
  'not_supported',
  'source_not_ready',
  'timeout',
  'failed',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function envelopeFailure(stage: EnvelopeFailure['stage'], code: string, message: string): EnvelopeFailure {
  return { stage, code, message }
}

function emptyCompleteness() {
  return { truncated: false, fetchedRows: 0, totalKnown: false, total: null, page: null }
}

function syntheticContextEcho(request: ExecuteRequest, notes: string[]): ToolResult['contextEcho'] {
  // wire AiQueryContextEchoDto 13 字段原形（B 侧合成信封同形回填；unknown 语义见 notes）
  return {
    requestId: request.requestId,
    toolCallSeq: request.toolCallSeq,
    sessionId: request.sessionId,
    userId: '',
    enterpriseId: '',
    channel: '',
    dataScope: { enterpriseWide: false, plantIds: [] },
    capabilityId: request.capabilityId,
    capabilityVersion: request.capabilityVersion,
    effectiveFilters: {},
    ignoredRequestFields: [],
    factColumns: [],
    notes,
  }
}

function syntheticEnvelope(
  status: AiQueryResultStatus,
  request: ExecuteRequest,
  failure: EnvelopeFailure,
): ToolResult {
  return {
    status,
    data: null,
    completeness: emptyCompleteness(),
    freshness: { queriedAt: new Date().toISOString(), sources: [{ source: request.capabilityId, updatedAt: 'unknown' }] },
    contextEcho: syntheticContextEcho(request, [`synthetic:${status}`]),
    auditRef: { requestId: request.requestId, toolCallSeq: request.toolCallSeq },
    failure,
  }
}

/** 投影候选 → 澄清选项 id（确定性：同一 orderId 恒同一 id，跨工具结果/跨轮可引用与去重）。 */
export function candidateOptionId(orderId: string): string {
  return `order-${orderId}`
}

/**
 * AQ-AMB-01 澄清候选承载位映射（DS-21 对齐返工 2026-10-28）：
 * wire 各能力结果 DTO 的 data.candidates（AiOrderCandidateDto：orderId/orderNo/plantId/
 * orderStatus/materialDesc/createdAt）→ ToolResult.clarificationOptions（B 侧内部消费投影）。
 * confirm 带精确 orderId 重发（AQ-AMB-01：用户确认后带精确参数重执行，不自行择一）。
 * data 无 candidates 数组（如 aq.quality）时返回 undefined=该能力无澄清候选。
 */
export function deriveClarificationOptions(data: unknown, capabilityId: string): ClarificationOption[] | undefined {
  if (!isRecord(data) || !Array.isArray(data['candidates'])) return undefined
  const options: ClarificationOption[] = []
  for (const raw of data['candidates']) {
    if (!isRecord(raw)) continue
    const orderId = raw['orderId']
    const orderNo = raw['orderNo']
    if (typeof orderId !== 'string' || typeof orderNo !== 'string') continue
    const str = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '')
    options.push({
      id: candidateOptionId(orderId),
      label: `${orderNo}（${str('plantId')}）`,
      detail: {
        orderId,
        orderNo,
        plantId: str('plantId'),
        orderStatus: str('orderStatus'),
        materialDesc: str('materialDesc'),
        createdAt: str('createdAt'),
      },
      confirm: { capabilityId, params: { orderRef: { kind: 'orderId', value: orderId } } },
    })
  }
  return options
}

/** 校验 §4 信封六段并回填执行上下文（DS-21：字段漂移视为合同违约——B 侧守门）。 */
function parseEnvelope(raw: unknown, request: ExecuteRequest): ToolResult {
  if (!isRecord(raw)) {
    return syntheticEnvelope('failed', request, envelopeFailure('query', 'ERR_ENVELOPE_INVALID', '响应不是对象'))
  }
  const status = raw['status']
  if (typeof status !== 'string' || !(STATUS_VALUES as readonly string[]).includes(status)) {
    return syntheticEnvelope('failed', request, envelopeFailure('query', 'ERR_ENVELOPE_INVALID', `status 非法：${status}`))
  }
  const auditRef = raw['auditRef']
  if (
    !isRecord(auditRef) ||
    auditRef['requestId'] !== request.requestId ||
    auditRef['toolCallSeq'] !== request.toolCallSeq
  ) {
    return syntheticEnvelope(
      'failed',
      request,
      envelopeFailure('query', 'ERR_ENVELOPE_AUDIT_REF_MISMATCH', 'auditRef 与请求执行上下文不一致'),
    )
  }
  const envelope: ToolResult = {
    status: status as AiQueryResultStatus,
    data: raw['data'] ?? null,
    completeness: (isRecord(raw['completeness']) ? raw['completeness'] : emptyCompleteness()) as unknown as ToolResult['completeness'],
    freshness: (isRecord(raw['freshness']) ? raw['freshness'] : {
      queriedAt: new Date().toISOString(),
      sources: [],
    }) as unknown as ToolResult['freshness'],
    contextEcho: (isRecord(raw['contextEcho']) ? raw['contextEcho'] : syntheticContextEcho(request, ['contextEcho 缺失，B 侧按请求回填'])) as unknown as ToolResult['contextEcho'],
    auditRef: { requestId: request.requestId, toolCallSeq: request.toolCallSeq },
  }
  // AQ-AMB-01：澄清候选承载位=wire data.candidates（顶层 clarificationOptions 为 B 侧内部投影，
  // 不读取 wire 顶层同名字段、不对 A 线构成形状要求）
  const derived = deriveClarificationOptions(envelope.data, request.capabilityId)
  if (derived !== undefined) envelope.clarificationOptions = derived
  if (isRecord(raw['failure'])) {
    envelope.failure = raw['failure'] as unknown as EnvelopeFailure
  }
  return envelope
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class HttpControlledQueryClient implements ControlledQueryClient {
  readonly mode = 'http' as const

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly retry: RetryPolicy,
  ) {}

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }
  }

  async listCapabilities(sessionId: string): Promise<CapabilitiesResponse> {
    let lastError: unknown = null
    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}/capabilities`, {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify({ sessionId }),
          signal: AbortSignal.timeout(5_000),
        })
        if (response.status === 404) {
          const body = (await response.json().catch(() => ({}))) as { code?: string }
          throw new ControlledQuerySessionError(
            body.code ?? 'ERR_AI_SESSION_NOT_FOUND',
            '会话不存在或已失效（§4 capabilities）',
          )
        }
        if (!response.ok) throw new Error(`capabilities HTTP ${String(response.status)}`)
        const body = (await response.json()) as unknown
        if (!isRecord(body) || !Array.isArray(body['capabilities'])) {
          throw new Error('capabilities 响应形状非法')
        }
        return body as unknown as CapabilitiesResponse
      } catch (error) {
        if (error instanceof ControlledQuerySessionError) throw error
        lastError = error
      }
      if (attempt < this.retry.maxRetries) await sleep(this.retry.backoffBaseMs * 2 ** attempt)
    }
    throw new Error(`内部受控查询 capabilities 不可达：${String(lastError)}`)
  }

  async execute(request: ExecuteRequest, options: ExecuteOptions): Promise<ToolResult> {
    const body = JSON.stringify(request)
    let lastError: unknown = null
    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt += 1) {
      const signals: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs)]
      if (options.signal !== undefined) signals.push(options.signal)
      try {
        const response = await fetch(`${this.baseUrl}/execute`, {
          method: 'POST',
          headers: this.authHeaders(),
          body,
          signal: AbortSignal.any(signals),
        })
        if (response.ok) return parseEnvelope(await response.json(), request)
        if (response.status >= 500 && attempt < this.retry.maxRetries) {
          lastError = new Error(`execute HTTP ${String(response.status)}`)
          await sleep(this.retry.backoffBaseMs * 2 ** attempt)
          continue // DS-22：5xx 有限重试，同一 requestId+toolCallSeq 幂等重发
        }
        const errorBody = (await response.json().catch(() => ({}))) as { code?: string; message?: string }
        return syntheticEnvelope(
          'failed',
          request,
          envelopeFailure('query', errorBody.code ?? 'ERR_AI_QUERY_FAILED', errorBody.message ?? `execute HTTP ${String(response.status)}`),
        )
      } catch (error) {
        if (isAbortError(error)) {
          // 单次查询等待超时（DS-09）或取消中止（DS-11：编排层按取消标志判别）
          return syntheticEnvelope(
            'timeout',
            request,
            envelopeFailure('query', 'ERR_QUERY_WAIT_TIMEOUT', '单次受控查询等待超时/中止'),
          )
        }
        lastError = error
        if (attempt < this.retry.maxRetries) await sleep(this.retry.backoffBaseMs * 2 ** attempt)
      }
    }
    return syntheticEnvelope(
      'failed',
      request,
      envelopeFailure('query', 'ERR_QUERY_TRANSPORT_EXHAUSTED', `内部受控查询重试耗尽：${String(lastError)}`),
    )
  }
}

/** 合同级 mock 脚本条目（纯数据，可经 JSON 场景文件注入，DS-13/21）。 */
export interface MockQueryScriptEntry {
  /** 仅匹配该 capabilityId 的执行（缺省=按序消费的下一条）。 */
  matchCapabilityId?: string
  /** 回放的信封（auditRef 缺省由实际请求回填）。 */
  envelope: Omit<ToolResult, 'auditRef'> & { auditRef?: ToolResultAuditRef }
  /** 响应前延迟（复现超时场景）。 */
  delayMs?: number
  /** 挂起直至外部 signal 中止（复现在途取消）。 */
  hangUntilAborted?: boolean
}

export class MockControlledQueryClient implements ControlledQueryClient {
  readonly mode = 'mock' as const
  private readonly queue: MockQueryScriptEntry[]
  private readonly capabilitiesResponse: CapabilitiesResponse
  /** 已受理的执行请求（测试断言位：调用次序/参数/取消后是否仍发起新调用）。 */
  readonly received: ExecuteRequest[] = []

  constructor(entries: MockQueryScriptEntry[], capabilities: CapabilitiesResponse) {
    this.queue = [...entries]
    this.capabilitiesResponse = capabilities
  }

  async listCapabilities(_sessionId?: string): Promise<CapabilitiesResponse> {
    void _sessionId // 接口对齐（§4 capabilities 以 sessionId 预检）；mock 回放不区分会话
    return this.capabilitiesResponse
  }

  async execute(request: ExecuteRequest, options: ExecuteOptions): Promise<ToolResult> {
    this.received.push({ ...request })
    const index = this.queue.findIndex(
      (entry) => entry.matchCapabilityId === undefined || entry.matchCapabilityId === request.capabilityId,
    )
    const entry = index >= 0 ? this.queue.splice(index, 1)[0] : undefined
    if (entry === undefined) {
      return syntheticEnvelope(
        'failed',
        request,
        envelopeFailure('query', 'ERR_QUERY_SCRIPT_EXHAUSTED', 'mock 查询脚本耗尽'),
      )
    }
    // 等待语义与 HTTP 客户端一致：单次查询等待超时（DS-09）/外部中止（DS-11）都产生 timeout 信封
    const signals: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs)]
    if (options.signal !== undefined) signals.push(options.signal)
    const signal = AbortSignal.any(signals)
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'))
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (entry.hangUntilAborted === true) return // 挂起直至外部中止（DS-11 在途取消场景）
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, entry.delayMs ?? 0)
        void timer
      })
    } catch (error) {
      if (isAbortError(error)) {
        return syntheticEnvelope(
          'timeout',
          request,
          envelopeFailure('query', 'ERR_QUERY_WAIT_TIMEOUT', '单次受控查询等待超时/中止'),
        )
      }
      throw error
    }
    const result: ToolResult = {
      ...entry.envelope,
      auditRef: entry.envelope.auditRef ?? { requestId: request.requestId, toolCallSeq: request.toolCallSeq },
    }
    // 与 HTTP 客户端同一映射（DS-21 合同级 mock）：wire data.candidates → 澄清候选投影
    const derived = deriveClarificationOptions(result.data, request.capabilityId)
    if (derived !== undefined) result.clarificationOptions = derived
    return result
  }
}
