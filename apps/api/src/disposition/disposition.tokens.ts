/** disposition 模块注入令牌（独立文件：避免 controller ↔ module 循环引用）。 */
export const DISPOSITION_COMMAND_BUS = Symbol('DISPOSITION_COMMAND_BUS')
export const DISPOSITION_QUERY_SERVICE = Symbol('DISPOSITION_QUERY_SERVICE')
