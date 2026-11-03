/** cost 模块注入令牌（独立文件：避免 controller ↔ module 循环引用）。 */
export const COST_COMMAND_BUS = Symbol('COST_COMMAND_BUS')
export const COST_QUERY_SERVICE = Symbol('COST_QUERY_SERVICE')
