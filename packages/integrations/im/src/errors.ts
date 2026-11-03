/**
 * IM 边缘包错误（全中文 + 规则码 [IM-xx-x]，P2 包共同协议第 4 条）。
 * SITE_PENDING 语义见 frozen/p4/im-channels.md §5 / GAP-P.md GAP-P2。
 */

/** 边缘包错误基类：message 必须含规则码。 */
export class ImEdgeError extends Error {
  readonly ruleCode: string

  constructor(message: string, ruleCode: string) {
    super(message)
    this.name = 'ImEdgeError'
    this.ruleCode = ruleCode
  }
}

/**
 * 统一消息形状非法（IM-02：适配器解析失败）。
 * 例如：mock 载荷缺 platformMessageId、企微载荷缺会话标识等。
 */
export class ImMessageShapeError extends ImEdgeError {
  constructor(message: string) {
    super(message, 'IM-02-1')
    this.name = 'ImMessageShapeError'
  }
}

/**
 * 待授权桩（IM-16/IM-17，GAP-P2）：企微/飞书真实回调验签、消息解密、
 * access_token/ticket 管理、企业应用凭据均未授权。
 * 抛出本错误 = 该能力存在但显式拒绝执行；未经 Owner 授权不得接通真实端点、
 * 不得落真实凭据、不得产生外呼。
 */
export class SitePendingImError extends ImEdgeError {
  readonly sitePendingAction: string

  constructor(action: string) {
    super(
      `SITE_PENDING（待授权桩）：${action} 属企微/飞书真实企业应用能力，未获 Owner 授权前不接通、不落真实凭据、不产生外呼 [IM-16-1]`,
      'IM-16-1',
    )
    this.name = 'SitePendingImError'
    this.sitePendingAction = action
  }
}
