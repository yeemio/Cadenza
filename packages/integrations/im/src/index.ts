/**
 * @cadenza/im —— IM 渠道边缘包出口（IM-01：承载且仅承载渠道协议适配、mock 双向通道、
 * 身份绑定端口、发送端口；不维护业务查询/权限/会话编排——那些归接入层/运行服务/受控查询层）。
 *
 * 真实验签解密与企业凭据 = SITE_PENDING（IM-16/17，GAP-P2）；
 * 首版身份绑定与处理记录以包内存储承载（IM-05，GAP-P8）。
 */
export type {
  ImChannelKind,
  ImConversationTarget,
  ImInboundMessageType,
  ImInboundMessageContent,
  InboundChannelMessage,
  ImOutboundContentKind,
  ImOutboundStatus,
  ImOutboundMessageContent,
  OutboundChannelMessage,
} from './messages'
export { ImEdgeError, ImMessageShapeError, SitePendingImError } from './errors'
export {
  type ImIdentityBindingKey,
  type ImIdentityBindingPort,
  type StoredImIdentityBinding,
  imIdentityBindingKeyString,
  assertImIdentityKeySafe,
  InMemoryImIdentityBindingStore,
} from './identity-binding'
export {
  type ImMessageKey,
  type ImProcessingPhase,
  type ImProcessingPhaseEvent,
  type ImProcessingRecord,
  type ImProcessingRecordStorePort,
  type ImChannelEventCounter,
  type ImChannelEventCountersPort,
  imMessageKeyString,
  InMemoryImProcessingRecordStore,
  InMemoryImChannelEventCounters,
} from './processing'
export { type ImSendResult, type ImSendPort, MockChannelSender } from './send'
export {
  type ImChannelAdapterPort,
  type NormalizedInboundFields,
  requireString,
  optionalString,
  buildInboundFromNormalized,
  normalizeConversationKind,
} from './adapter'
export { type MockInboundPayload, MockImChannelAdapter } from './mock/mock-channel'
export { type WecomInboundPayload, WecomImChannelAdapter } from './wecom/wecom-channel'
export { type FeishuInboundPayload, FeishuImChannelAdapter } from './feishu/feishu-channel'
