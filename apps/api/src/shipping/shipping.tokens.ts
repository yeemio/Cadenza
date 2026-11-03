/** shipping 模块注入令牌（独立文件：避免 controller ↔ module 循环引用）。 */
export const SHIPPING_COMMAND_BUS = Symbol('SHIPPING_COMMAND_BUS')
export const SHIPPING_QUERY_SERVICE = Symbol('SHIPPING_QUERY_SERVICE')
