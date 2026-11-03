/** purchase 模块注入令牌（独立文件：避免 controller ↔ module 循环引用，同 org/inventory tokens 模式）。 */
export const PURCHASE_COMMAND_BUS = Symbol('PURCHASE_COMMAND_BUS')
export const PURCHASE_QUERY_SERVICE = Symbol('PURCHASE_QUERY_SERVICE')
