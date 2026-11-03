/** spc 模块注入令牌（独立文件：避免 controller ↔ module 循环引用）。 */
export const SPC_COMMAND_BUS = Symbol('SPC_COMMAND_BUS')
export const SPC_QUERY_SERVICE = Symbol('SPC_QUERY_SERVICE')
