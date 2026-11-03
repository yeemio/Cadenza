/**
 * 飞书（feishu）渠道适配器（IM-01/02/16，GAP-P2）。
 *
 * 与 wecom 同构：parseInbound 为简化占位形状映射（真实事件订阅报文含 challenge/加密 envelopes，
 * 验签解密为 SITE_PENDING 桩）；token/ticket 桩同则；不持有任何凭据（IM-17）。
 */
import {
  buildInboundFromNormalized,
  normalizeConversationKind,
  optionalString,
  requireString,
  type ImChannelAdapterPort,
} from '../adapter'
import { SitePendingImError, ImMessageShapeError } from '../errors'
import type { InboundChannelMessage } from '../messages'

/** 飞书事件载荷（简化占位形状）。 */
export interface FeishuInboundPayload {
  /** 应用维度（App ID）→ enterpriseAppRef */
  appRef: string
  /** open_id → platformUserId */
  fromUserId: string
  messageId: string
  chatType: 'p2p' | 'group'
  chatId: string
  msgType: 'text' | 'binding' | 'unbind'
  /** text 正文（msgType=text 必填） */
  text?: string
  /** 绑定验证码（msgType=binding 必填） */
  verificationCode?: string
  timestamp?: string
}

export class FeishuImChannelAdapter implements ImChannelAdapterPort {
  readonly channelKind = 'feishu' as const

  parseInbound(payload: unknown): InboundChannelMessage {
    return buildInboundFromNormalized('feishu', {
      enterpriseAppRef: requireString(payload, 'appRef', '飞书'),
      platformUserId: requireString(payload, 'fromUserId', '飞书'),
      platformMessageId: requireString(payload, 'messageId', '飞书'),
      conversationKind: normalizeConversationKind(requireString(payload, 'chatType', '飞书'), '飞书'),
      conversationRef: requireString(payload, 'chatId', '飞书'),
      messageType: parseFeishuMessageType(payload),
      text: optionalString(payload, 'text'),
      verificationCode: optionalString(payload, 'verificationCode'),
      timestamp: optionalString(payload, 'timestamp'),
    }, new Date().toISOString())
  }

  /** 真实回调验签（IM-16）：SITE_PENDING 桩。 */
  verifyInboundAuthenticity(_payload: unknown): void {
    void _payload // 桩不读取载荷（参数保留对齐端口形状）
    throw new SitePendingImError('飞书事件订阅验签（Verification Token / encrypt 校验）')
  }

  /** 消息解密（IM-16）：SITE_PENDING 桩。 */
  decryptInboundPayload(_encrypted: string): never {
    void _encrypted // 桩不读取密文（参数保留对齐端口形状）
    throw new SitePendingImError('飞书事件消息解密')
  }

  /** tenant_access_token 管理（IM-16）：SITE_PENDING 桩。 */
  getTenantAccessToken(): never {
    throw new SitePendingImError('飞书 tenant_access_token 获取/刷新')
  }
}

function parseFeishuMessageType(payload: unknown): 'text' | 'binding' | 'unbind' {
  const raw = requireString(payload, 'msgType', '飞书')
  if (raw === 'text' || raw === 'binding' || raw === 'unbind') return raw
  throw new ImMessageShapeError(`飞书载荷 msgType 非法（期望 text/binding/unbind，得到“${raw}”）[IM-02-1]`)
}
