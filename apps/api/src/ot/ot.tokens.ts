/** ot 模块注入令牌（独立文件：避免 controller ↔ module 循环引用）。 */
export const OT_COMMAND_BUS = Symbol('OT_COMMAND_BUS')
export const OT_QUERY_SERVICE = Symbol('OT_QUERY_SERVICE')
