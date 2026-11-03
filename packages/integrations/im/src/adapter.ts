/**
 * 渠道适配器端口（IM-01/02）：平台协议载荷 ↔ 统一消息。
 *
 * 每个渠道一个适配器实例：parseInbound 完成形状映射（纯数据变换，无网络）；
 * verifyInboundAuthenticity 承担真实回调验签——企微/飞书为 SITE_PENDING 桩（IM-16），
 * mock 渠道无外部签名面（恒通过）。
 * 接入层对一切非 mock 渠道在 parse 之前必须先过验签闸门。
 */
import type { ImChannelKind, InboundChannelMessage } from './messages'
import { ImMessageShapeError } from './errors'

export interface ImChannelAdapterPort {
  readonly channelKind: ImChannelKind

  /**
   * 平台回调载荷 → 统一入站消息（IM-02）。
   * 载荷形状非法 → ImMessageShapeError [IM-02-1]（全中文，指名字段）。
   * 本方法不做验签/解密（那是 verifyInboundAuthenticity/decrypt 的职责）。
   */
  parseInbound(payload: unknown): InboundChannelMessage

  /**
   * 真实回调验签闸门（IM-16）：企微/飞书实现为 SITE_PENDING 桩（抛 SitePendingImError）；
   * mock 渠道恒通过（无外部签名面）。
   */
  verifyInboundAuthenticity(payload: unknown): void
}

/**
 * 归一化字段提取辅助（各渠道适配器把平台字段名映射到本结构后共用校验/组装逻辑；
 * 首版统一联合 text|binding|unbind——真实渠道的绑定意图识别按样例校准，见 IM-16 注记）。
 */
export interface NormalizedInboundFields {
  enterpriseAppRef: string
  platformUserId: string
  platformMessageId: string
  conversationKind: 'direct' | 'group'
  conversationRef: string
  messageType: 'text' | 'binding' | 'unbind'
  text?: string
  verificationCode?: string
  timestamp?: string
}

export function requireString(source: unknown, field: string, channel: string): string {
  if (typeof source !== 'object' || source === null) {
    throw new ImMessageShapeError(`${channel} 回调载荷必须是对象 [IM-02-1]`)
  }
  const value = (source as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ImMessageShapeError(`${channel} 回调载荷字段“${field}”缺失或非非空字符串 [IM-02-1]`)
  }
  return value
}

export function optionalString(
  source: unknown,
  field: string,
): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 归一化字段 → 统一消息（共用校验：text 需正文；binding 需验证码；时间缺省由调用方补）。 */
export function buildInboundFromNormalized(
  channelKind: ImChannelKind,
  fields: NormalizedInboundFields,
  fallbackReceivedAt: string,
): InboundChannelMessage {
  if (fields.enterpriseAppRef.includes('|') || fields.platformMessageId.includes('|')) {
    throw new ImMessageShapeError(
      `${channelKind} 载荷字段不得含“|”（去重键安全，IM-06） [IM-02-1]`,
    )
  }
  const receivedAt = fields.timestamp ?? fallbackReceivedAt
  if (fields.messageType === 'text') {
    if (fields.text === undefined || fields.text.length === 0) {
      throw new ImMessageShapeError(`${channelKind} text 消息缺少正文“text/content” [IM-02-1]`)
    }
    return {
      channelKind,
      enterpriseAppRef: fields.enterpriseAppRef,
      platformUserId: fields.platformUserId,
      platformMessageId: fields.platformMessageId,
      conversationTarget: { kind: fields.conversationKind, ref: fields.conversationRef },
      messageType: 'text',
      content: { kind: 'text', text: fields.text },
      receivedAt,
    }
  }
  if (fields.messageType === 'binding') {
    if (fields.verificationCode === undefined || fields.verificationCode.length === 0) {
      throw new ImMessageShapeError(`${channelKind} binding 消息缺少验证码字段 [IM-02-1]`)
    }
    return {
      channelKind,
      enterpriseAppRef: fields.enterpriseAppRef,
      platformUserId: fields.platformUserId,
      platformMessageId: fields.platformMessageId,
      conversationTarget: { kind: fields.conversationKind, ref: fields.conversationRef },
      messageType: 'binding',
      content: { kind: 'binding', verificationCode: fields.verificationCode },
      receivedAt,
    }
  }
  return {
    channelKind,
    enterpriseAppRef: fields.enterpriseAppRef,
    platformUserId: fields.platformUserId,
    platformMessageId: fields.platformMessageId,
    conversationTarget: { kind: fields.conversationKind, ref: fields.conversationRef },
    messageType: 'unbind',
    content: { kind: 'unbind' },
    receivedAt,
  }
}

/** 会话种类字段归一（平台各自叫法 → direct/group）。 */
export function normalizeConversationKind(raw: string, channel: string): 'direct' | 'group' {
  if (raw === 'single' || raw === 'direct' || raw === 'p2p') return 'direct'
  if (raw === 'group') return 'group'
  throw new ImMessageShapeError(`${channel} 会话种类字段非法（期望 single/direct/p2p 或 group）[IM-02-1]`)
}
