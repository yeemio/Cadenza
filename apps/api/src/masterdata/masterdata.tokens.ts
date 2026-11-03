/** masterdata 模块注入令牌（独立文件避免 controller ↔ module 循环引用，沿用 org.tokens 模式）。 */
export const MASTERDATA_COMMAND_BUS = Symbol('MASTERDATA_COMMAND_BUS')
export const MASTERDATA_QUERIES = Symbol('MASTERDATA_QUERIES')
