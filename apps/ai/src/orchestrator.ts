/**
 * 轮次编排器（dsh-edge.md §2 运行行为合同 DS-06～DS-13 的实现核心）。
 *
 * 唯一工具族＝受控查询（DS-01/AR-R1：无任何生产写通道）；
 * 数字与来源以结构化信封呈现，模型解释区分事实与推测（DS-12）；
 * 单轮工具调用上限/单次查询超时/单轮总预算/按租户限额/取消 各自独立可判
 * （DS-07/09/10/11），每条均落会话事件归档（DS-06/AR-17）。
 */
import type {
  AiQueryResultStatus,
  ClarificationOption,
  EnvelopeCompleteness,
  EnvelopeFreshness,
  ModelClientPort,
  ModelMessage,
  RuntimeProfile,
  SessionRuntimeRecord,
  SessionStorePort,
  ToolDescriptor,
  ToolResult,
  ToolResultAuditRef,
} from '../../../packages/integrations/dsh'
import type { ControlledQueryClient, CapabilitiesResponse, ExecuteRequest } from './controlled-query-client'
import type { TenantLimitsService } from './limits'
import type { TurnRegistry, TurnState } from './turn-registry'
import { isRelativeTimeExpression, resolveRelativeTime } from './time-basis'

export interface TurnRequest {
  requestId: string
  sessionId: string
  userMessage: string
  timeBasis?: { timeZone: 'Asia/Shanghai' }
}

/** 轮次终态详情（各停止原因独立可判，DS-09/10/11 断言位）。 */
export interface TurnStatusDetail {
  status:
    | 'ok'
    | 'tool_call_limit_reached'
    | 'timeout'
    | 'over_limit'
    | 'cancelled'
    | 'failed'
    | 'refused_out_of_scope'
    | 'clarify'
  scope?: 'single_query' | 'turn_budget'
  which?: 'concurrent' | 'daily'
  limit?: number
  toolCallsUsed?: number
  toolCallSeqReached?: number
  capabilityId?: string
  code?: string
  stageSummary?: string
}

/** DS-23 轮次响应。 */
export interface TurnResponse {
  outcome: 'answer' | 'clarify' | 'unavailable' | 'cancelled'
  message?: string
  options?: ClarificationOption[]
  answerRefs?: AnswerRef[]
  statusDetail: TurnStatusDetail
}

/** DS-12：数字与来源的结构化呈现引用（信封完整性/时效/审计锚点逐段携带）。 */
export interface AnswerRef {
  capabilityId: string
  capabilityVersion: number
  status: AiQueryResultStatus
  completeness: EnvelopeCompleteness
  freshness: EnvelopeFreshness
  auditRef: ToolResultAuditRef
}

export interface OrchestratorDeps {
  model: ModelClientPort
  queryClient: ControlledQueryClient
  store: SessionStorePort
  limits: TenantLimitsService
  registry: TurnRegistry
  profile: RuntimeProfile
  now?: () => Date
}

interface ToolAttempt {
  request: ExecuteRequest
  result: ToolResult
  timeBasisApplied?: { expression: string; from: string; to: string; timeZone: 'Asia/Shanghai' }
}

/** 循环安全上限（防御非收敛脚本；正常流远低于此）。 */
const MAX_MODEL_ITERATIONS = 64

export class TurnOrchestrator {
  private readonly nowFn: () => Date

  constructor(private readonly deps: OrchestratorDeps) {
    this.nowFn = deps.now ?? ((): Date => new Date())
  }

  async runTurn(request: TurnRequest): Promise<TurnResponse> {
    const { store, limits, registry, profile } = this.deps
    const session = await store.findSession(request.sessionId)
    if (session === null) {
      return this.unavailable({ status: 'failed', code: 'ERR_AI_SESSION_NOT_FOUND', stageSummary: '会话未在运行时登记' })
    }
    if (session.status === 'closed') {
      return this.unavailable({ status: 'failed', code: 'ERR_AI_SESSION_CLOSED', stageSummary: '会话已关闭' })
    }
    if (session.status === 'expired') {
      return this.unavailable({ status: 'failed', code: 'ERR_AI_SESSION_EXPIRED', stageSummary: '会话已过期清理' })
    }

    const acquired = limits.tryAcquire(session.enterpriseId, this.nowFn())
    if (!acquired.ok) {
      // DS-10：超限拒绝新轮，不排队放大
      return this.unavailable({
        status: 'over_limit',
        which: acquired.which,
        limit: acquired.limit,
        stageSummary: acquired.which === 'concurrent' ? '并发轮数已超限/暂不可用' : '日调用次数已超限/暂不可用',
      })
    }

    try {
      await store.touchActive(request.sessionId, this.nowFn().toISOString()) // DS-06：open→active
      await store.appendEvent(request.sessionId, {
        kind: 'user_message',
        at: this.nowFn().toISOString(),
        requestId: request.requestId,
        content: request.userMessage,
      })

      let capabilities: CapabilitiesResponse
      try {
        capabilities = await this.deps.queryClient.listCapabilities(request.sessionId)
      } catch (error) {
        return await this.finishUnreachable(request, session, error)
      }

      const tools: ToolDescriptor[] = capabilities.capabilities.map((capability) => ({
        capabilityId: capability.capabilityId,
        version: capability.version,
        displayName: capability.displayName,
        description: capability.description,
        inputSchema: capability.inputSchema,
      }))

      const state = registry.begin(request.requestId, session)
      const effectiveBudgetMs = Math.min(
        profile.turnBudgetMs,
        limits.limitsFor(session.enterpriseId).perTurnBudgetMs,
      )
      const startedAtMs = this.nowFn().getTime()

      const messages: ModelMessage[] = [
        {
          role: 'system',
          content: JSON.stringify({
            rules: [
              'AI 问数只读：仅可调用列出的受控查询能力，无任何生产写通道',
              '数字与来源以工具结果信封为准；解释文字须标注「解释非事实」',
              '澄清选项只能引用工具结果候选（信封 data.candidates 投影出的澄清选项）的 id',
            ],
            capabilities: capabilities.capabilities,
            unreadyTopics: capabilities.unreadyTopics,
            timeZone: profile.timezone,
          }),
        },
        { role: 'user', content: request.userMessage },
      ]

      const attempts: ToolAttempt[] = []
      // 澄清延续（AQ-AMB-04）：同 requestId 上一轮的待选选项继续可用
      const pendingOptions: ClarificationOption[] = [...(state.pendingClarify?.options ?? [])]
      let pushedToolMessages = 0

      for (let iteration = 0; iteration < MAX_MODEL_ITERATIONS; iteration += 1) {
        if (state.cancelRequested) return await this.finishCancelled(request, session, state, attempts)
        if (this.nowFn().getTime() - startedAtMs >= effectiveBudgetMs) {
          return await this.finishTurnBudgetTimeout(request, session, state, attempts, effectiveBudgetMs)
        }

        const modelResult = await this.deps.model.complete({
          requestId: request.requestId,
          sessionId: request.sessionId,
          turnSeq: state.modelCalls + 1,
          messages,
          tools,
        })
        state.modelCalls += 1
        await store.appendEvent(request.sessionId, {
          kind: 'model_turn',
          at: this.nowFn().toISOString(),
          requestId: request.requestId,
          turnSeq: state.modelCalls,
          result: modelResult,
        })

        switch (modelResult.kind) {
          case 'answer':
            return await this.finishAnswer(request, session, state, attempts, modelResult.text)
          case 'refuse':
            // DS-13：越权问法拒答——提示走业务页面
            return await this.finishRefused(request, session, state, attempts, modelResult.text)
          case 'clarify': {
            // 消费位说明：result.clarificationOptions 是受控查询客户端自 wire 各能力结果
            // DTO 的 data.candidates（AQ-AMB-01 候选清单）映射的 B 侧内部消费投影——
            // 选项机器来源仍是能力结果（DS-08），模型编造的 id 一律无法命中。
            const available: ClarificationOption[] = []
            for (const option of [
              ...pendingOptions,
              ...attempts.flatMap((a) => a.result.clarificationOptions ?? []),
            ]) {
              if (!available.some((o) => o.id === option.id)) available.push(option)
            }
            const resolved: ClarificationOption[] = []
            for (const optionId of modelResult.optionIds) {
              const found = available.find((option) => option.id === optionId)
              if (found !== undefined && !resolved.some((o) => o.id === found.id)) resolved.push(found)
            }
            if (resolved.length === 0) {
              // DS-08：选项必须来自能力结果——模型编造的选项一律拒绝呈现
              return await this.finishClarifyInvalid(request, session, state, attempts)
            }
            // 遗留池=本轮全部可得候选（含未呈现项），供同 requestId 延续轮解析（AQ-AMB-04）
            state.pendingClarify = { question: modelResult.question, options: available }
            await store.appendEvent(request.sessionId, {
              kind: 'clarify',
              at: this.nowFn().toISOString(),
              requestId: request.requestId,
              question: modelResult.question,
              options: resolved,
            }) // AQ-AMB-04：澄清轮计入同一 requestId 的会话记录
            return await this.finishOutcome(request, session, state, {
              outcome: 'clarify',
              message: modelResult.question,
              options: resolved,
              statusDetail: { status: 'clarify', stageSummary: '等待用户澄清答复（同一 requestId 延续）' },
            })
          }
          case 'tool_calls': {
            let timedOutQuery: ToolAttempt | undefined
            for (const intent of modelResult.toolCalls) {
              if (state.cancelRequested) return await this.finishCancelled(request, session, state, attempts)
              if (state.toolCalls >= profile.toolCallLimitPerTurn) {
                // DS-07：上限触发即停止调工具，以已获结果收口作答
                return await this.finishToolLimitReached(request, session, state, attempts)
              }
              const remaining = effectiveBudgetMs - (this.nowFn().getTime() - startedAtMs)
              if (remaining <= 0) {
                return await this.finishTurnBudgetTimeout(request, session, state, attempts, effectiveBudgetMs)
              }
              const attempt = await this.executeTool(intent, state, request, session, remaining)
              if (attempt === null) return await this.finishCancelled(request, session, state, attempts)
              attempts.push(attempt)
              state.toolCalls += 1
              if (attempt.result.status === 'timeout') {
                if (state.cancelRequested) return await this.finishCancelled(request, session, state, attempts)
                timedOutQuery = attempt
                break // DS-09：单次查询超时——停止继续调工具
              }
            }
            if (timedOutQuery !== undefined) {
              return await this.finishSingleQueryTimeout(request, session, state, attempts, timedOutQuery)
            }
            messages.push({ role: 'assistant', content: JSON.stringify({ toolCalls: modelResult.toolCalls }) })
            for (; pushedToolMessages < attempts.length; pushedToolMessages += 1) {
              messages.push({ role: 'tool', content: summarizeResult(attempts[pushedToolMessages]!), toolResult: attempts[pushedToolMessages]!.result })
            }
            continue
          }
        }
      }
      return await this.finishOutcome(request, session, state, {
        outcome: 'unavailable',
        message: '本轮编排未收敛，已停止。请稍后重试。',
        statusDetail: { status: 'failed', code: 'ERR_LOOP_NOT_CONVERGED', stageSummary: '模型循环未收敛' },
      })
    } finally {
      limits.release(session.enterpriseId)
    }
  }

  /** 执行一次受控查询（含相对时间换算与预算裁剪）。返回 null 表示已取消。 */
  private async executeTool(
    intent: { capabilityId: string; capabilityVersion: number; params: Record<string, unknown> },
    state: TurnState,
    request: TurnRequest,
    session: SessionRuntimeRecord,
    remainingBudgetMs: number,
  ): Promise<ToolAttempt | null> {
    const { profile } = this.deps
    const toolCallSeq = state.toolCalls + 1
    let params: Record<string, unknown> = { ...intent.params }
    let timeBasisApplied: ToolAttempt['timeBasisApplied']
    // §1 总则：自然语言相对时间由 B 线换算为显式起止（Asia/Shanghai）后传参
    if (isRelativeTimeExpression(params['relativeTime'])) {
      const resolved = resolveRelativeTime(params['relativeTime'], this.nowFn())
      params = { ...params, timeRange: { from: resolved.from, to: resolved.to } }
      delete params['relativeTime']
      timeBasisApplied = resolved
    }
    const executeRequest: ExecuteRequest = {
      requestId: request.requestId,
      toolCallSeq,
      sessionId: session.sessionId,
      capabilityId: intent.capabilityId,
      capabilityVersion: intent.capabilityVersion,
      params,
    }
    const timeoutMs = Math.max(1, Math.min(profile.singleQueryTimeoutMs, remainingBudgetMs))
    const startedMs = this.nowFn().getTime()
    const result = await this.deps.queryClient.execute(executeRequest, {
      timeoutMs,
      signal: state.abortController.signal,
    })
    const durationMs = this.nowFn().getTime() - startedMs
    await this.deps.store.appendEvent(session.sessionId, {
      kind: 'tool_call',
      at: this.nowFn().toISOString(),
      requestId: request.requestId,
      toolCallSeq,
      capabilityId: intent.capabilityId,
      params,
      result,
      durationMs,
      timeBasisApplied,
    })
    if (state.cancelRequested) return null
    return { request: executeRequest, result, timeBasisApplied }
  }

  private answerRefs(attempts: ToolAttempt[]): AnswerRef[] {
    return attempts.map((attempt) => ({
      capabilityId: attempt.request.capabilityId,
      capabilityVersion: attempt.request.capabilityVersion,
      status: attempt.result.status,
      completeness: attempt.result.completeness,
      freshness: attempt.result.freshness,
      auditRef: attempt.result.auditRef,
    }))
  }

  private partialSummary(attempts: ToolAttempt[]): string {
    if (attempts.length === 0) return '尚未获取任何结构化结果'
    return attempts
      .map(
        (attempt) =>
          `${attempt.request.capabilityId}(status=${attempt.result.status}, fetchedRows=${attempt.result.completeness.fetchedRows}, truncated=${attempt.result.completeness.truncated ? '是' : '否'})`,
      )
      .join('；')
  }

  private async finishAnswer(
    request: TurnRequest,
    session: SessionRuntimeRecord,
    state: TurnState,
    attempts: ToolAttempt[],
    text: string,
  ): Promise<TurnResponse> {
    return this.finishOutcome(request, session, state, {
      outcome: 'answer',
      message: text,
      answerRefs: this.answerRefs(attempts), // DS-12：数字与来源以结构化信封呈现
      statusDetail: { status: 'ok', toolCallsUsed: state.toolCalls },
    })
  }

  private async finishRefused(
    request: TurnRequest,
    session: SessionRuntimeRecord,
    state: TurnState,
    attempts: ToolAttempt[],
    text: string,
  ): Promise<TurnResponse> {
    return this.finishOutcome(request, session, state, {
      outcome: 'answer',
      message: text,
      answerRefs: this.answerRefs(attempts),
      statusDetail: { status: 'refused_out_of_scope', toolCallsUsed: state.toolCalls },
    })
  }

  private async finishToolLimitReached(
    request: TurnRequest,
    session: SessionRuntimeRecord,
    state: TurnState,
    attempts: ToolAttempt[],
  ): Promise<TurnResponse> {
    // DS-07：已达工具调用上限——用已获结构化结果收口作答，不得虚构未取数据
    return this.finishOutcome(request, session, state, {
      outcome: 'answer',
      message: `已达到单轮工具调用上限（${String(this.deps.profile.toolCallLimitPerTurn)} 次）。已获取的结构化结果：${this.partialSummary(attempts)}。未取全的部分不总结为完整总量。`,
      answerRefs: this.answerRefs(attempts),
      statusDetail: {
        status: 'tool_call_limit_reached',
        limit: this.deps.profile.toolCallLimitPerTurn,
        toolCallsUsed: state.toolCalls,
        stageSummary: '已达单轮工具调用上限，停止继续调用工具并以已获结果收口',
      },
    })
  }

  private async finishSingleQueryTimeout(
    request: TurnRequest,
    session: SessionRuntimeRecord,
    state: TurnState,
    attempts: ToolAttempt[],
    timedOut: ToolAttempt,
  ): Promise<TurnResponse> {
    // DS-09：单次查询等待超时——停止继续调工具，timeout 独立可判；
    // 已取部分数据带完整性标注，未取全不得总结为完整总量
    return this.finishOutcome(request, session, state, {
      outcome: 'unavailable',
      message: `单次受控查询等待超时（能力 ${timedOut.request.capabilityId}）。已完成阶段：${this.partialSummary(attempts)}。以上为部分数据（含完整性标注），不代表完整总量。`,
      answerRefs: this.answerRefs(attempts),
      statusDetail: {
        status: 'timeout',
        scope: 'single_query',
        capabilityId: timedOut.request.capabilityId,
        toolCallSeqReached: timedOut.request.toolCallSeq,
        toolCallsUsed: state.toolCalls,
        stageSummary: '单次查询等待超时，已停止继续调用工具',
      },
    })
  }

  private async finishTurnBudgetTimeout(
    request: TurnRequest,
    session: SessionRuntimeRecord,
    state: TurnState,
    attempts: ToolAttempt[],
    budgetMs: number,
  ): Promise<TurnResponse> {
    // DS-09：单轮总预算超时——与单次查询超时分别可判
    return this.finishOutcome(request, session, state, {
      outcome: 'unavailable',
      message: `单轮总预算超时（${String(budgetMs)}ms）。已完成阶段：${this.partialSummary(attempts)}。以上为部分数据（含完整性标注），不代表完整总量。`,
      answerRefs: this.answerRefs(attempts),
      statusDetail: {
        status: 'timeout',
        scope: 'turn_budget',
        toolCallsUsed: state.toolCalls,
        stageSummary: '单轮总预算超时，已停止',
      },
    })
  }

  private async finishCancelled(
    request: TurnRequest,
    session: SessionRuntimeRecord,
    state: TurnState,
    attempts: ToolAttempt[],
  ): Promise<TurnResponse> {
    // DS-11：取消后不再发起任何新的工具调用；终态 cancelled + 阶段摘要；
    // apps/ai 无发送动作（IM 目的地按 im-channels.md 由接入层处理）
    const stageSummary = `已完成 ${String(state.toolCalls)} 次工具调用、${String(state.modelCalls)} 次模型调用；收到取消后未再发起新的工具调用`
    await this.deps.store.appendEvent(session.sessionId, {
      kind: 'cancel',
      at: this.nowFn().toISOString(),
      requestId: request.requestId,
      stageSummary,
      toolCallsCompleted: state.toolCalls,
    })
    return this.finishOutcome(request, session, state, {
      outcome: 'cancelled',
      message: `本轮已取消。${stageSummary}。已获取的部分结果：${this.partialSummary(attempts)}`,
      answerRefs: this.answerRefs(attempts),
      statusDetail: { status: 'cancelled', toolCallsUsed: state.toolCalls, stageSummary },
    })
  }

  private async finishClarifyInvalid(
    request: TurnRequest,
    session: SessionRuntimeRecord,
    state: TurnState,
    attempts: ToolAttempt[],
  ): Promise<TurnResponse> {
    return this.finishOutcome(request, session, state, {
      outcome: 'unavailable',
      message: '模型给出的澄清选项未出现在任何能力结果中（DS-08：选项只能来自能力结果），本轮不呈现该澄清，请改述问题。',
      answerRefs: this.answerRefs(attempts),
      statusDetail: { status: 'failed', code: 'ERR_CLARIFY_OPTIONS_NOT_FROM_CAPABILITY', stageSummary: '澄清选项不在能力结果中' },
    })
  }

  private async finishUnreachable(
    request: TurnRequest,
    session: SessionRuntimeRecord,
    error: unknown,
  ): Promise<TurnResponse> {
    const code =
      typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'ERR_CONTROLLED_QUERY_UNREACHABLE'
    await this.deps.store.appendEvent(session.sessionId, {
      kind: 'turn_outcome',
      at: this.nowFn().toISOString(),
      requestId: request.requestId,
      outcome: 'unavailable',
      statusDetail: { status: 'failed', code },
    })
    return {
      outcome: 'unavailable',
      message: '受控查询层不可达或会话失效，本轮无法执行（AQ 问数暂不可用）。',
      statusDetail: { status: 'failed', code, stageSummary: '受控查询层不可达/会话失效' },
    }
  }

  private unavailable(statusDetail: TurnStatusDetail): TurnResponse {
    return { outcome: 'unavailable', message: 'AI 问数暂不可用。', statusDetail }
  }

  private async finishOutcome(
    request: TurnRequest,
    session: SessionRuntimeRecord,
    state: TurnState,
    response: TurnResponse,
  ): Promise<TurnResponse> {
    state.finished = true
    await this.deps.store.appendEvent(session.sessionId, {
      kind: 'turn_outcome',
      at: this.nowFn().toISOString(),
      requestId: request.requestId,
      outcome: response.outcome,
      statusDetail: response.statusDetail,
    })
    return response
  }
}

function summarizeResult(attempt: ToolAttempt): string {
  return JSON.stringify({
    capabilityId: attempt.request.capabilityId,
    toolCallSeq: attempt.request.toolCallSeq,
    status: attempt.result.status,
    completeness: attempt.result.completeness,
    // 内部投影 id（源自 wire data.candidates，AQ-AMB-01）；供模型 clarify 意图引用
    clarificationOptionIds: (attempt.result.clarificationOptions ?? []).map((option) => option.id),
  })
}
