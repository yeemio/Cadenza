/** aiquery 接入层注入令牌（AR-01：可信身份、会话归属、能力/权限服务端重验、审计落库）。 */
export const AIQUERY_SERVICE = Symbol('AIQUERY_SERVICE')

/** 部署配置的内部服务令牌（DS-18/19：内部 HTTP 认证；不构成权限来源——权限按 AQ-AUTH-01 实时重算）。 */
export const AIQUERY_INTERNAL_TOKEN = Symbol('AIQUERY_INTERNAL_TOKEN')

/** 问数轮上下文（requestId 锚的轮次归属/信封缓存/澄清选项绑定；P4-A 补充任务）。 */
export const AIQUERY_TURN_CONTEXT = Symbol('AIQUERY_TURN_CONTEXT')

/** apps/ai 运行服务 HTTP 客户端（DS-23/24 转发通道；AR-03 终端不直连）。 */
export const AIQUERY_RUNTIME_CLIENT = Symbol('AIQUERY_RUNTIME_CLIENT')
