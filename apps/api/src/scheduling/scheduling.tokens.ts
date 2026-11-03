/** scheduling 模块注入令牌（独立文件避免 controller ↔ module 循环引用，沿用 org/process.tokens 模式）。 */
export const SCHEDULING_COMMAND_BUS = Symbol('SCHEDULING_COMMAND_BUS')
export const SCHEDULING_QUERIES = Symbol('SCHEDULING_QUERIES')
