/**
 * org 域规则违例：携带规则编号（如 'OA-14'）。
 * 应用层捕获后转为 CommandResult（BUSINESS_REJECTION + ERR_BUSINESS_RULE），
 * 服务端拒绝语义由命令层守卫保证（OA-26）。
 */
export class OrgRuleViolation extends Error {
  /** 违反的合同规则编号（org-auth.md） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'OrgRuleViolation'
    this.rule = rule
  }
}
