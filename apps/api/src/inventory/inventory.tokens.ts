/** inventory 模块注入令牌（独立文件：避免 controller ↔ module 循环引用，同 org.tokens 模式）。 */
export const INVENTORY_COMMAND_BUS = Symbol('INVENTORY_COMMAND_BUS')
export const INVENTORY_QUERY_SERVICE = Symbol('INVENTORY_QUERY_SERVICE')
