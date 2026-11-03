/**
 * im 接入子模块端口（apps/api/src/aiquery/im，AR-01 接入层 C 线部分）。
 *
 * [L0-整合标记] 本文件中「边缘包镜像」段（IM-02/03/04/06/07 形状）是
 * `packages/integrations/im/src`（@cadenza/im）合同形状的本地镜像：该目录当前不是
 * pnpm workspace 成员、无 dist 产物保证，apps/api 直接 import 会破坏 build（rootDir
 * 约束）与干净检出基线，故以结构化类型镜像承载；注入侧（测试组合/L0 组合根）以
 * @cadenza/im 实现类注入，结构兼容由 typecheck 强制（漂移=编译错误）。
 * L0 整合步：将 packages/integrations/im 升格为 workspace 包并构建后，删除镜像段、
 * 改 `import type { ... } from '@cadenza/im'`（见 delivery/P4/im/DELIVERY.md §L0）。
 *
 * 「A/B 线接缝」段为本子模块定义的合同形状端口（不 import A 线文件）：
 * - ai_session 登记（AQ-S3）、问数轮（DS-23 turns）、ai_query_audit 发送结果回写（AQ-S2）、
 *   发送前权限再检（IM-08）、绑定码验证（IM-03）——2026-10-30 五内部接缝补齐轮起由
 *   im.real-seams.ts 真实承载（ai_session/ai_query_audit 落库、SessionVerifier 同口径重验、
 *   DS-23 转发 apps/ai、0030 一次性绑定码）；im.mock-seams.ts 保留为测试/演示承载
 *   （ImModule.register 缺省，测试自组装路径不变）。
 */
// ---------------------------------------------------------------------------
// 边缘包镜像（[L0-整合标记] 见文件头；与 packages/integrations/im/src 逐字段一致）
// ---------------------------------------------------------------------------

export type ImChannelKind = 'wecom' | 'feishu' | 'mock'

export interface ImConversationTarget {
  kind: 'direct' | 'group'
  ref: string
}

export type ImInboundMessageType = 'text' | 'binding' | 'unbind'

export type ImInboundMessageContent =
  | { kind: 'text'; text: string }
  | { kind: 'binding'; verificationCode: string }
  | { kind: 'unbind' }

/** 统一入站消息（IM-02 原文形状）。 */
export interface InboundChannelMessage {
  channelKind: ImChannelKind
  enterpriseAppRef: string
  platformUserId: string
  platformMessageId: string
  conversationTarget: ImConversationTarget
  messageType: ImInboundMessageType
  content: ImInboundMessageContent
  receivedAt: string
}

export type ImOutboundContentKind = 'answer' | 'clarify' | 'guidance' | 'notice'

export type ImOutboundStatus = 'ok' | 'no_permission' | 'unavailable' | 'intercepted'

export interface ImOutboundMessageContent {
  kind: ImOutboundContentKind
  text: string
  options?: string[]
  status?: ImOutboundStatus
}

/** 统一出站消息（IM-02 原文形状）。 */
export interface OutboundChannelMessage {
  channelKind: ImChannelKind
  conversationTarget: ImConversationTarget
  content: ImOutboundMessageContent
}

export interface ImMessageKey {
  channelKind: ImChannelKind
  enterpriseAppRef: string
  platformMessageId: string
}

/** 发送结果（IM-04）。 */
export interface ImSendResult {
  status: 'sent' | 'unknown' | 'failed'
  detail?: string
}

/** 处理阶段（IM-07 生命周期）。 */
export type ImProcessingPhase =
  | 'received'
  | 'duplicate_dropped'
  | 'group_intercepted'
  | 'identity_unresolved'
  | 'binding_verified'
  | 'binding_rejected'
  | 'unbind_done'
  | 'unbind_noop'
  | 'turn_started'
  | 'clarify_sent'
  | 'sent'
  | 'send_unknown'
  | 'send_failed'
  | 'not_sent'
  | 'cancelled'
  | 'turn_error'

export interface ImProcessingPhaseEvent {
  phase: ImProcessingPhase
  at: string
  note?: string
}

/** 处理记录（IM-07：messageKey、requestId、处理阶段、发送结果、时间戳）。 */
export interface ImProcessingRecord {
  messageKey: string
  requestId: string | null
  phases: ImProcessingPhaseEvent[]
  sendResult: ImSendResult | null
  duplicateDropCount: number
  receivedAt: string
}

/** 渠道事件可观测计数器键（IM-06 合同强制 duplicate_dropped；其余按行为一一对应）。 */
export type ImChannelEventCounter =
  | 'duplicate_dropped'
  | 'group_intercepted'
  | 'unbound_guidance'
  | 'binding_ok'
  | 'binding_rejected'
  | 'unbind'
  | 'turn_clarify'
  | 'turn_answer'
  | 'turn_unavailable'
  | 'turn_cancelled'
  | 'turn_error'
  | 'sent'
  | 'send_unknown'
  | 'send_failed'
  | 'not_sent'

export interface ImChannelAdapterPort {
  readonly channelKind: ImChannelKind
  parseInbound(payload: unknown): InboundChannelMessage
  /** 真实回调验签闸门（IM-16）：企微/飞书 SITE_PENDING 桩抛错；mock 恒通过。 */
  verifyInboundAuthenticity(payload: unknown): void
}

export interface ImIdentityBindingKey {
  channelKind: ImChannelKind
  enterpriseAppRef: string
  platformUserId: string
}

export interface ImIdentityBindingPort {
  resolve(binding: ImIdentityBindingKey): Promise<{ userId: string } | null>
  bind(binding: ImIdentityBindingKey, userId: string, boundAt: string): Promise<void>
  unbind(binding: ImIdentityBindingKey): Promise<boolean>
}

export interface ImSendPort {
  send(message: OutboundChannelMessage): Promise<ImSendResult>
}

export interface ImProcessingRecordStorePort {
  claim(
    key: ImMessageKey,
    receivedAt: string,
  ): Promise<{ record: ImProcessingRecord; duplicate: boolean }>
  appendPhase(key: ImMessageKey, phase: ImProcessingPhase, at: string, note?: string): Promise<void>
  setRequestId(key: ImMessageKey, requestId: string): Promise<void>
  recordSendResult(key: ImMessageKey, result: ImSendResult): Promise<void>
  findByKey(key: ImMessageKey): Promise<ImProcessingRecord | null>
  list(): Promise<ImProcessingRecord[]>
}

export interface ImChannelEventCountersPort {
  increment(counter: ImChannelEventCounter): void
  snapshot(): Record<ImChannelEventCounter, number>
}

// ---------------------------------------------------------------------------
// A/B 线接缝端口（合同形状；L0 整合时接通，首版 mock 承载）
// ---------------------------------------------------------------------------

/**
 * ai_session 登记接缝（AQ-S3 形状）：会话按 租户/用户/渠道/会话目标 四元划分（IM-12），
 * channel + conversationRef 由本子模块携带；enterpriseId/user_account 校验归 A 线实现
 * （首版 mock 以 userId+channel+conversationRef 为键，租户维度由 A 线落库时补全）。
 */
export interface AiQuerySessionPort {
  ensureSession(input: {
    userId: string
    channel: ImChannelKind
    conversationRef: string
  }): Promise<{ sessionId: string; status: 'open' | 'closed' | 'expired' }>
}

/** 问数轮接缝（DS-23 POST /ai-runtime/turns 形状；时间基准 Asia/Shanghai，GAP-P11）。 */
export interface AiQueryTurnPort {
  submitTurn(input: {
    requestId: string
    sessionId: string
    userMessage: string
    timeBasis: { timeZone: 'Asia/Shanghai' }
  }): Promise<{
    outcome: 'answer' | 'clarify' | 'unavailable' | 'cancelled'
    message?: string
    options?: string[]
    answerRefs?: string[]
    statusDetail?: string
  }>
}

/**
 * ai_query_audit 发送结果回写接缝（AQ-S2 sent_result_status 值域：
 * sent/send_unknown/failed/not_sent；IM-04 unknown→send_unknown 不冒称、IM-08 拒发→not_sent）。
 */
export interface AiAuditSendResultPort {
  recordSendResult(input: {
    requestId: string
    sentResultStatus: 'sent' | 'send_unknown' | 'failed' | 'not_sent'
    detail?: string
  }): Promise<void>
}

/**
 * 发送前再检接缝（IM-08）：问数轮结果发送前执行的目的地与访问权限再检。
 * 目的地规则（提问者本人会话）由本子模块结构化校验；权限实时重验（AQ-AUTH-01 口径）
 * 归 A 线实现——撤权时此处返回 denied，本子模块不发送并以 not_sent 计审计。
 */
export interface ImAccessRecheckPort {
  recheck(input: {
    requestId: string
    userId: string
    channelKind: ImChannelKind
    conversationTarget: ImConversationTarget
  }): Promise<{ allowed: true } | { allowed: false; reason: string }>
}

/**
 * 绑定码验证接缝（IM-03：绑定必须由用户主动发起并经验证）：
 * 绑定码由 Cadence 网页端对已登录用户签发（接缝 5 真实承载=0030 ai_im_binding_code 一次性核销，
 * 见 im.real-seams.ts DbBindingCodeVerifier；首版 mock 由测试/演示脚本签发），
 * 验证通过返回目标 user_account；无效/过期/已用/已撤销返回 null。
 */
export interface ImBindingVerificationPort {
  verifyBindingCode(
    code: string,
    context?: { channelKind: ImChannelKind; platformUserId: string },
  ): Promise<{ userId: string } | null>
}
