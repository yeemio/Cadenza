/**
 * mock 渠道适配器（IM-15：首版 mock 双向通道承载全部合同行为）。
 *
 * 入站：脚本化消息（测试/演示以 mock 平台载荷 POST 回调端点，经本适配器映射为统一消息）；
 * 出站：由 MockChannelSender（send.ts）捕获；
 * 验签：mock 渠道无外部签名面，恒通过（真实渠道的验签闸门见 IM-16）。
 * 不访问网络。
 */
import {
  buildInboundFromNormalized,
  normalizeConversationKind,
  optionalString,
  requireString,
  type ImChannelAdapterPort,
} from '../adapter'
import { ImMessageShapeError } from '../errors'
import type { InboundChannelMessage } from '../messages'

/** mock 平台载荷形状（与统一消息刻意不同字段名，证明适配层真实存在）。 */
export interface MockInboundPayload {
  /** 企业应用标识 → enterpriseAppRef */
  app: string
  /** 平台用户 → platformUserId */
  fromUser: string
  /** 平台消息标识 → platformMessageId（IM-06 去重键成分） */
  msgId: string
  /** single | group → conversationTarget.kind */
  chatType: 'single' | 'group'
  /** 会话标识 → conversationTarget.ref */
  chatId: string
  /** text | binding | unbind → messageType */
  msgType: 'text' | 'binding' | 'unbind'
  /** text 正文（msgType=text 必填） */
  text?: string
  /** 绑定验证码（msgType=binding 必填） */
  verificationCode?: string
  /** 消息时间戳（ISO-8601，可缺省） */
  timestamp?: string
}

export class MockImChannelAdapter implements ImChannelAdapterPort {
  readonly channelKind = 'mock' as const

  parseInbound(payload: unknown): InboundChannelMessage {
    return buildInboundFromNormalized('mock', {
      enterpriseAppRef: requireString(payload, 'app', 'mock'),
      platformUserId: requireString(payload, 'fromUser', 'mock'),
      platformMessageId: requireString(payload, 'msgId', 'mock'),
      conversationKind: normalizeConversationKind(requireString(payload, 'chatType', 'mock'), 'mock'),
      conversationRef: requireString(payload, 'chatId', 'mock'),
      messageType: parseMockMessageType(payload),
      text: optionalString(payload, 'text'),
      verificationCode: optionalString(payload, 'verificationCode'),
      timestamp: optionalString(payload, 'timestamp'),
    }, new Date().toISOString())
  }

  /** mock 渠道无外部签名面：恒通过（IM-16 桩只约束企微/飞书）。 */
  verifyInboundAuthenticity(_payload: unknown): void {
    void _payload // 无操作（有意留空：mock 渠道不存在真实验签问题；参数保留对齐端口形状）
  }
}

function parseMockMessageType(payload: unknown): 'text' | 'binding' | 'unbind' {
  const raw = requireString(payload, 'msgType', 'mock')
  if (raw === 'text' || raw === 'binding' || raw === 'unbind') return raw
  throw new ImMessageShapeError(`mock 载荷 msgType 非法（期望 text/binding/unbind，得到“${raw}”）[IM-02-1]`)
}
