/** process 模块注入令牌（独立文件避免 controller ↔ module 循环引用，沿用 org/masterdata.tokens 模式）。 */
export const PROCESS_COMMAND_BUS = Symbol('PROCESS_COMMAND_BUS')
export const PROCESS_QUERIES = Symbol('PROCESS_QUERIES')
