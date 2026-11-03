/**
 * 企业微信（wecom）渠道适配器（IM-01/02/16，GAP-P2）。
 *
 * - parseInbound：企微回调载荷（按公开文档简化的 JSON 投影占位形状）→ 统一消息。
 *   真实回调为带签名的加密报文，解密与验签为 SITE_PENDING 桩——真实接入授权时按企业样例
 *   校准字段映射（差异不视为合同变更，IM-16 注记）；
 * - verifyInboundAuthenticity / decryptInboundPayload / getAccessToken / getJsapiTicket：
 *   全部 SITE_PENDING 桩（IM-16：不接真实端点、不落真实凭据、不产生外呼）；
 * - 企业应用凭据只存服务端凭据配置（IM-17），本包不持有任何凭据字段。
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

/**
 * 企微回调载荷（简化占位形状）：真实接入前仅用于形状映射演示与桩位声明。
 * msgType 首版归一为 text|binding|unbind（真实渠道绑定意图按样例校准）。
 */
export interface WecomInboundPayload {
  /** 企业应用 CorpId+AgentId 维度 → enterpriseAppRef */
  toUserName: string
  /** 平台用户 UserId → platformUserId */
  fromUserName: string
  msgId: string
  chatType: 'single' | 'group'
  chatId: string
  msgType: 'text' | 'binding' | 'unbind'
  /** text 正文（msgType=text 必填） */
  content?: string
  /** 绑定验证码（msgType=binding 必填） */
  verificationCode?: string
  timestamp?: string
}

export class WecomImChannelAdapter implements ImChannelAdapterPort {
  readonly channelKind = 'wecom' as const

  parseInbound(payload: unknown): InboundChannelMessage {
    return buildInboundFromNormalized('wecom', {
      enterpriseAppRef: requireString(payload, 'toUserName', '企微'),
      platformUserId: requireString(payload, 'fromUserName', '企微'),
      platformMessageId: requireString(payload, 'msgId', '企微'),
      conversationKind: normalizeConversationKind(requireString(payload, 'chatType', '企微'), '企微'),
      conversationRef: requireString(payload, 'chatId', '企微'),
      messageType: parseWecomMessageType(payload),
      text: optionalString(payload, 'content'),
      verificationCode: optionalString(payload, 'verificationCode'),
      timestamp: optionalString(payload, 'timestamp'),
    }, new Date().toISOString())
  }

  /** 真实回调验签（IM-16）：SITE_PENDING 桩——未授权前一切企微入站在此闸门被拒。 */
  verifyInboundAuthenticity(_payload: unknown): void {
    void _payload // 桩不读取载荷（参数保留对齐端口形状）
    throw new SitePendingImError('企业微信回调验签（msg_signature 校验）')
  }

  /** 消息解密（IM-16）：SITE_PENDING 桩。 */
  decryptInboundPayload(_encrypted: string): never {
    void _encrypted // 桩不读取密文（参数保留对齐端口形状）
    throw new SitePendingImError('企业微信回调消息解密（AES）')
  }

  /** access_token 管理（IM-16）：SITE_PENDING 桩——不请求真实端点、不持有 secret。 */
  getAccessToken(): never {
    throw new SitePendingImError('企业微信 access_token 获取/刷新')
  }

  /** jsapi_ticket 管理（IM-16）：SITE_PENDING 桩。 */
  getJsapiTicket(): never {
    throw new SitePendingImError('企业微信 jsapi_ticket 获取')
  }
}

function parseWecomMessageType(payload: unknown): 'text' | 'binding' | 'unbind' {
  const raw = requireString(payload, 'msgType', '企微')
  if (raw === 'text' || raw === 'binding' || raw === 'unbind') return raw
  throw new ImMessageShapeError(`企微载荷 msgType 非法（期望 text/binding/unbind，得到“${raw}”）[IM-02-1]`)
}
