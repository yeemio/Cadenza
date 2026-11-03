/**
 * 在途轮次注册表：取消管理（dsh-edge.md DS-11）与澄清延续（AQ-AMB-04）的进程内状态。
 *
 * - requestCancel：置取消标志并中止在途受控查询的等待信号；编排循环在每次
 *   新工具调用/模型调用前检查标志——取消后不再发起任何新的工具调用；
 * - 同一 requestId 的澄清延续（用户答复后继续）：新轮继承上一轮 pendingClarify。
 */
import type { ClarificationOption } from '../../../packages/integrations/dsh'
import type { SessionRuntimeRecord } from '../../../packages/integrations/dsh'

export interface TurnState {
  requestId: string
  sessionId: string
  enterpriseId: string
  startedAt: Date
  cancelRequested: boolean
  abortController: AbortController
  pendingClarify: { question: string; options: ClarificationOption[] } | null
  finished: boolean
  modelCalls: number
  toolCalls: number
}

export type CancelDecision = 'cancelled_in_flight' | 'already_finished' | 'unknown_request'

export class TurnRegistry {
  private readonly map = new Map<string, TurnState>()

  begin(requestId: string, session: SessionRuntimeRecord): TurnState {
    const prior = this.map.get(requestId)
    const state: TurnState = {
      requestId,
      sessionId: session.sessionId,
      enterpriseId: session.enterpriseId,
      startedAt: new Date(),
      cancelRequested: false,
      abortController: new AbortController(),
      // AQ-AMB-04：澄清轮计入同一 requestId——用户答复后延续（pendingClarify 继承）
      pendingClarify: prior?.pendingClarify ?? null,
      finished: false,
      modelCalls: 0,
      toolCalls: 0,
    }
    this.map.set(requestId, state)
    return state
  }

  get(requestId: string): TurnState | null {
    return this.map.get(requestId) ?? null
  }

  requestCancel(requestId: string): CancelDecision {
    const state = this.map.get(requestId)
    if (state === undefined) return 'unknown_request'
    if (state.finished) return 'already_finished'
    state.cancelRequested = true
    state.abortController.abort()
    return 'cancelled_in_flight'
  }
}
