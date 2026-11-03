/**
 * IM 渠道统一消息形状（IM-02，frozen/p4/im-channels.md §1）。
 *
 * 接入层（apps/api/src/aiquery/im）只消费本统一形状，不感知平台差异；
 * 平台载荷 → 统一消息的适配由各渠道适配器完成（adapter.ts / mock / wecom / feishu）。
 */

/** 渠道种类（IM-02；AQ-S2 ai_query_audit.channel / AQ-S3 ai_session.channel 同值域）。 */
export type ImChannelKind = 'wecom' | 'feishu' | 'mock'

/** 会话目标：首版个人会话（direct）为默认问数与回复目的地；群目标见 IM-10/11。 */
export interface ImConversationTarget {
  kind: 'direct' | 'group'
  /** 平台会话标识（单聊=平台会话 id；群聊=群 id）。 */
  ref: string
}

/** 入站消息类型（首版联合）：text=提问正文；binding=用户主动发起的绑定动作；unbind=解绑动作。 */
export type ImInboundMessageType = 'text' | 'binding' | 'unbind'

/** 入站内容（按 messageType 判别联合）。 */
export type ImInboundMessageContent =
  | { kind: 'text'; text: string }
  | { kind: 'binding'; verificationCode: string }
  | { kind: 'unbind' }

/**
 * 统一入站消息（IM-02 原文形状）：
 * channelKind/enterpriseAppRef/platformUserId/platformMessageId/conversationTarget/
 * messageType/content/receivedAt（ISO-8601 字符串）。
 */
export interface InboundChannelMessage {
  channelKind: ImChannelKind
  /** 企业应用维度标识（多企业/多应用隔离的组成部分，见 IM-03/IM-06）。 */
  enterpriseAppRef: string
  platformUserId: string
  platformMessageId: string
  conversationTarget: ImConversationTarget
  messageType: ImInboundMessageType
  content: ImInboundMessageContent
  receivedAt: string
}

/** 出站内容类型（首版联合）：answer=问数回答；clarify=结构化澄清（DS-08 question+options）；guidance=引导文案（绑定引导/群引导）；notice=系统提示。 */
export type ImOutboundContentKind = 'answer' | 'clarify' | 'guidance' | 'notice'

/** 出站机器可读状态（供渠道侧与测试断言；与 AQ-REG-07 信封状态词汇对齐处标注）。 */
export type ImOutboundStatus = 'ok' | 'no_permission' | 'unavailable' | 'intercepted'

export interface ImOutboundMessageContent {
  kind: ImOutboundContentKind
  text: string
  /** clarify 选项（DS-08：选项来自能力结果，不由模型自由编造）。 */
  options?: string[]
  status?: ImOutboundStatus
}

/** 统一出站消息（IM-02 原文形状）：channelKind/conversationTarget/content。 */
export interface OutboundChannelMessage {
  channelKind: ImChannelKind
  conversationTarget: ImConversationTarget
  content: ImOutboundMessageContent
}
