/**
 * 会话存储端口（dsh-edge.md DS-15 第 3 族）。
 *
 * 会话记录（消息、工具调用、模型应答）按 requestId 归档于 apps/ai 会话存储，
 * 落独立数据目录（AR-08/AR-17：与生产业务账本分离，AI 历史不是业务事实，AR-18）。
 * 生命周期：open → active（轮次进行）→ closed（用户结束/超时空闲）→ 过期清理（DS-06）。
 */
import type { ModelTurnResult } from './model-client'
import type { ClarificationOption, ToolResult } from './tools'

/** 会话渠道值域（与 0021 ai_session/ai_query_audit 的 CHECK 值域一致，AQ-S2/S3）。 */
export type SessionChannel = 'web' | 'pda' | 'wecom' | 'feishu' | 'mock'

export type SessionLifecycleStatus = 'open' | 'active' | 'closed' | 'expired'

/** 运行时会话索引记录（DS-23：由接入层在建 ai_session 后同步登记；仅索引，不赋权）。 */
export interface SessionRuntimeRecord {
  sessionId: string
  enterpriseId: string
  userId: string
  channel: SessionChannel
  conversationRef: string | null
  status: SessionLifecycleStatus
  createdAt: string
  lastActiveAt: string
  closedAt: string | null
  closedReason: 'user_closed' | 'idle_timeout' | null
  expiredAt: string | null
}

/** 轮次终态四值（DS-23 outcome）。 */
export type TurnOutcome = 'answer' | 'clarify' | 'unavailable' | 'cancelled'

/** 会话事件（append-only，按时间序归档； requestId 贯穿 AR-15 审计链）。 */
export type SessionEventRecord =
  | { kind: 'user_message'; at: string; requestId: string; content: string }
  | { kind: 'model_turn'; at: string; requestId: string; turnSeq: number; result: ModelTurnResult }
  | {
      kind: 'tool_call'
      at: string
      requestId: string
      toolCallSeq: number
      capabilityId: string
      params: Record<string, unknown>
      result: ToolResult
      durationMs: number
      /** 编排层已把自然语言相对时间换算为显式起止时的回执（§1 总则）。 */
      timeBasisApplied?: { expression: string; from: string; to: string; timeZone: 'Asia/Shanghai' }
    }
  | { kind: 'clarify'; at: string; requestId: string; question: string; options: ClarificationOption[] }
  | { kind: 'turn_outcome'; at: string; requestId: string; outcome: TurnOutcome; statusDetail: unknown }
  | { kind: 'cancel'; at: string; requestId: string; stageSummary: string; toolCallsCompleted: number }
  | { kind: 'session_lifecycle'; at: string; from: SessionLifecycleStatus; to: SessionLifecycleStatus; reason: string }

/** 会话存储端口：apps/ai 组合根装配本地实现（独立数据目录，DS-17）。 */
export interface SessionStorePort {
  /** 登记运行时会话（重复登记幂等覆盖绑定信息，保留既有事件归档）。 */
  registerSession(record: Omit<SessionRuntimeRecord, 'status' | 'createdAt' | 'lastActiveAt' | 'closedAt' | 'closedReason' | 'expiredAt'>): Promise<SessionRuntimeRecord>
  findSession(sessionId: string): Promise<SessionRuntimeRecord | null>
  appendEvent(sessionId: string, event: SessionEventRecord): Promise<void>
  listEvents(sessionId: string): Promise<SessionEventRecord[]>
  /** open→active / 刷新 lastActiveAt。 */
  touchActive(sessionId: string, at: string): Promise<void>
  closeSession(sessionId: string, reason: 'user_closed' | 'idle_timeout', at: string): Promise<void>
  /**
   * 空闲关停与过期清理（DS-06）：
   * 1) open/active 且 lastActiveAt 早于 idleDeadline 的会话 → closed（idle_timeout）；
   * 2) closed 且 closedAt 早于 retentionDeadline 的会话 → expired（过期清理）。
   * 返回受影响 sessionId 列表（先空闲关停、后过期）。
   */
  sweepSessions(idleMs: number, retentionMs: number, now: Date): Promise<string[]>
}
