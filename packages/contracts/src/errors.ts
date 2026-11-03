/**
 * 平台级错误码常量。业务规则错误码由后续冻结的业务合同补充，不在本包预造。
 */
export const ERROR_CODES = {
  AUTH_REQUIRED: 'ERR_AUTH_REQUIRED',
  FORBIDDEN_SCOPE: 'ERR_FORBIDDEN_SCOPE',
  NOT_FOUND: 'ERR_NOT_FOUND',
  VERSION_CONFLICT: 'ERR_VERSION_CONFLICT',
  IDEMPOTENT_PAYLOAD_MISMATCH: 'ERR_IDEMPOTENT_PAYLOAD_MISMATCH',
  INSUFFICIENT_STOCK: 'ERR_INSUFFICIENT_STOCK',
  BUSINESS_RULE: 'ERR_BUSINESS_RULE',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** 所有错误码字符串值（用于唯一性校验等） */
export const ERROR_CODE_VALUES: readonly string[] = Object.values(ERROR_CODES)
