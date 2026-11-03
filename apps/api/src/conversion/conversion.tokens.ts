/** conversion 模块注入令牌（独立文件：避免 controller ↔ module 循环引用）。 */
export const CONVERSION_COMMAND_BUS = Symbol('CONVERSION_COMMAND_BUS')
export const CONVERSION_QUERY_SERVICE = Symbol('CONVERSION_QUERY_SERVICE')
