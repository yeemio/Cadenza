/** reverse 模块注入令牌（独立文件：避免 controller ↔ module 循环引用）。 */
export const REVERSE_COMMAND_BUS = Symbol('REVERSE_COMMAND_BUS')
export const REVERSE_QUERY_SERVICE = Symbol('REVERSE_QUERY_SERVICE')
