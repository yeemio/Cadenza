/** quality 模块注入令牌（独立文件：避免 controller ↔ module 循环引用，同 org/inventory/purchase tokens 模式）。 */
export const QUALITY_COMMAND_BUS = Symbol('QUALITY_COMMAND_BUS')
export const QUALITY_QUERY_SERVICE = Symbol('QUALITY_QUERY_SERVICE')
