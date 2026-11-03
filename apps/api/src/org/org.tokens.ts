/** org 模块注入令牌（独立文件：避免 controller ↔ module 循环引用在 ESM 求值期产生 undefined）。 */
export const ORG_COMMAND_BUS = Symbol('ORG_COMMAND_BUS')
export const ORG_QUERY_SERVICE = Symbol('ORG_QUERY_SERVICE')
