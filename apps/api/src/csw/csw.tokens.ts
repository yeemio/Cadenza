/** csw 模块注入令牌（独立文件：避免 controller ↔ module 循环引用）。 */
export const CSW_COMMAND_BUS = Symbol('CSW_COMMAND_BUS')
export const CSW_QUERY_SERVICE = Symbol('CSW_QUERY_SERVICE')
