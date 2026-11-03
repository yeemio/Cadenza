/** rework 模块注入令牌（独立文件：避免 controller ↔ module 循环引用）。 */
export const REWORK_COMMAND_BUS = Symbol('REWORK_COMMAND_BUS')
export const REWORK_QUERY_SERVICE = Symbol('REWORK_QUERY_SERVICE')
