/**
 * masterdata 域规则违例：携带合同规则编号（如 'MD-05'、'MD-24'）。
 * 应用层捕获后转为 CommandResult（BUSINESS_REJECTION + ERR_BUSINESS_RULE），
 * 错误文案以 `[MD-xx]` 前缀携带规则编号（测试与排障口径）。
 */
export class MasterDataRuleViolation extends Error {
  /** 违反的合同规则编号（master-data.md） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'MasterDataRuleViolation'
    this.rule = rule
  }
}
