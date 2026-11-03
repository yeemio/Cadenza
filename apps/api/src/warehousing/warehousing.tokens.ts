/** warehousing 模块注入令牌（独立文件：避免 controller ↔ module 循环引用）。 */
export const WAREHOUSING_COMMAND_BUS = Symbol('WAREHOUSING_COMMAND_BUS')
export const WAREHOUSING_QUERY_SERVICE = Symbol('WAREHOUSING_QUERY_SERVICE')
