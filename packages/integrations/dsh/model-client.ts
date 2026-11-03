/**
 * 模型客户端端口（dsh-edge.md DS-15 第 1 族）。
 *
 * 输入：消息序列 + 工具描述；输出：文本（回答）/ 工具调用意图 / 澄清意图 / 越权拒答意图
 * ＋ 用量（或 unknown，AR-16：用量未知须标记 unknown，不估数）。
 * 厂商类型止于本包（DS-04）：domain/application/contracts/ui/apps/api 不得引用本文件。
 */
import type { ToolDescriptor, ToolResult } from './tools'

export type ModelRole = 'system' | 'user' | 'assistant' | 'tool'

/** 对话消息；role=tool 时携带该次受控查询的结构化结果。 */
export interface ModelMessage {
  role: ModelRole
  content: string
  toolResult?: ToolResult
}

/** 模型输出的工具调用意图（对唯一工具族＝受控查询）。 */
export interface ToolCallIntent {
  capabilityId: string
  capabilityVersion: number
  params: Record<string, unknown>
  note?: string
}

/** 模型用量：计数或显式 unknown（不估数）。 */
export type ModelUsage = { kind: 'unknown' } | { kind: 'counted'; inputTokens: number; outputTokens: number }

/** 模型回合产物的四种意图：
 *  - answer：结构化作答（文本由模型生成，数字与来源以 ToolResult 为准，DS-12）；
 *  - tool_calls：请求调用受控查询（params 可含 relativeTime 由编排层换算，§1 总则）；
 *  - clarify：澄清意图（optionIds 必须引用能力结果中的 clarificationOptions，DS-08）；
 *  - refuse：越权问法拒答（提示走业务页面，DS-13）。 */
export type ModelTurnResult =
  | { kind: 'answer'; text: string; usage: ModelUsage }
  | { kind: 'tool_calls'; toolCalls: ToolCallIntent[]; usage: ModelUsage }
  | { kind: 'clarify'; question: string; optionIds: string[]; usage: ModelUsage }
  | { kind: 'refuse'; text: string; usage: ModelUsage }

/** 模型调用请求。 */
export interface ModelRequest {
  requestId: string
  sessionId: string
  /** 本 requestId 内第几次模型调用（从 1 递增）。 */
  turnSeq: number
  messages: ModelMessage[]
  tools: ToolDescriptor[]
}

/** 模型客户端端口：apps/ai 组合根装配实现（首版=本包 MockModelClient，DS-16/17）。 */
export interface ModelClientPort {
  readonly vendor: string
  complete(request: ModelRequest): Promise<ModelTurnResult>
}
