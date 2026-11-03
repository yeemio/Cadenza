/**
 * mock 模型适配器（dsh-edge.md DS-13/DS-16；红线 AR-R6/DS-25：真实付费模型不接通）。
 *
 * 实现 ModelClientPort：确定性、可脚本注入（steps 为纯数据，可经 JSON 场景文件注入
 * 到独立进程），不访问网络、不产生付费调用。行为覆盖 DS-06～DS-13 的模型侧可观察状态：
 *  - 结构化作答（answer，解释文字由脚本注入并标注「解释非事实」，DS-12）；
 *  - 工具调用意图（tool_calls，含 relativeTime 相对时间参数供编排层换算，§1 总则）；
 *  - 澄清意图（clarify，optionIds 引用能力结果的 clarificationOptions，DS-08）；
 *  - 越权问法拒答（refuse，提示走业务页面，DS-13）；
 *  - 延迟注入（delayMs）与用量 unknown 标记（AR-16 不估数）——配合编排层复现
 *    超时（DS-09）/限额（DS-10）/取消（DS-11）场景。
 */
import type { ModelClientPort, ModelRequest, ModelTurnResult, ModelUsage, ToolCallIntent } from './model-client'
import type { ToolResult } from './tools'

/** 脚本步骤（纯数据，JSON 可序列化；测试按序注入）。 */
export interface MockModelStep {
  kind: 'answer' | 'tool_calls' | 'clarify' | 'refuse'
  text?: string
  toolCalls?: Array<{
    capabilityId: string
    capabilityVersion: number
    params: Record<string, unknown>
    note?: string
  }>
  question?: string
  optionIds?: string[]
  /** 本步模型调用前的人为延迟（毫秒），用于复现超时/取消场景。 */
  delayMs?: number
  /** 用量按 unknown 标记（AR-16：不估数）。 */
  usageUnknown?: boolean
}

export interface MockModelOptions {
  /** 按消耗顺序排列的脚本；耗尽后回落 fallback 行为。 */
  steps?: MockModelStep[]
  /** 脚本耗尽后的回落：answer-from-results（用已有工具结果作收口）或 refuse。 */
  fallback?: 'answer-from-results' | 'refuse'
  vendor?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function countedUsage(request: ModelRequest): ModelUsage {
  return { kind: 'counted', inputTokens: request.messages.length * 32, outputTokens: 24 }
}

/** 从消息序列取最近一次工具结果（供 fallback 收口）。 */
function latestToolResults(request: ModelRequest): ToolResult[] {
  const results: ToolResult[] = []
  for (const message of request.messages) {
    if (message.role === 'tool' && message.toolResult) results.push(message.toolResult)
  }
  return results
}

export class MockModelClient implements ModelClientPort {
  readonly vendor: string
  private readonly queue: MockModelStep[]
  private readonly fallback: NonNullable<MockModelOptions['fallback']>
  private readonly consumedSteps: MockModelStep[] = []
  /** 累计 complete() 调用次数（测试断言位：取消后不得再发起模型调用）。 */
  private callCount = 0

  constructor(options: MockModelOptions = {}) {
    this.vendor = options.vendor ?? 'mock-model-1'
    this.queue = [...(options.steps ?? [])]
    this.fallback = options.fallback ?? 'answer-from-results'
  }

  async complete(request: ModelRequest): Promise<ModelTurnResult> {
    this.callCount += 1
    const step = this.queue.length > 0 ? this.queue.shift() : undefined
    if (step !== undefined) this.consumedSteps.push(step)
    if (step?.delayMs !== undefined && step.delayMs > 0) await sleep(step.delayMs)
    const usage: ModelUsage =
      step?.usageUnknown === true ? { kind: 'unknown' } : countedUsage(request)
    if (step === undefined) return this.fallbackResult(request, usage)
    switch (step.kind) {
      case 'answer':
        return { kind: 'answer', text: step.text ?? '', usage }
      case 'refuse':
        return { kind: 'refuse', text: step.text ?? '', usage }
      case 'clarify':
        return {
          kind: 'clarify',
          question: step.question ?? '请补充信息',
          optionIds: step.optionIds ?? [],
          usage,
        }
      case 'tool_calls': {
        const toolCalls: ToolCallIntent[] = (step.toolCalls ?? []).map((call) => ({
          capabilityId: call.capabilityId,
          capabilityVersion: call.capabilityVersion,
          params: call.params,
          note: call.note,
        }))
        return { kind: 'tool_calls', toolCalls, usage }
      }
    }
  }

  private fallbackResult(request: ModelRequest, usage: ModelUsage): ModelTurnResult {
    if (this.fallback === 'refuse') {
      return {
        kind: 'refuse',
        text: '该问法超出问数只读范围，请走业务页面操作。【解释非事实】',
        usage,
      }
    }
    const results = latestToolResults(request)
    const summary =
      results.length === 0
        ? '未能获取结构化结果。'
        : `已获取 ${results.length} 个结构化结果（${results
            .map((r) => r.status)
            .join('、')}），数字与来源以结构化结果为准。【解释非事实】`
    return { kind: 'answer', text: summary, usage }
  }

  /** 测试断言辅助：已消耗的脚本步骤。 */
  consumed(): readonly MockModelStep[] {
    return this.consumedSteps
  }

  /** 测试断言辅助：剩余步骤数。 */
  pending(): number {
    return this.queue.length
  }

  /** 测试断言辅助：模型调用计数。 */
  calls(): number {
    return this.callCount
  }
}
