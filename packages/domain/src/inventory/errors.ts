/**
 * inventory 域规则违例：携带规则编号（如 'IT-14'，对应冻结合同 inventory-trace-core.md）。
 * 应用层捕获后转为 CommandResult（BUSINESS_REJECTION），映射到对应错误码（如
 * ERR_INSUFFICIENT_STOCK / ERR_BUSINESS_RULE）。
 */
export class InventoryRuleViolation extends Error {
  /** 违反的合同规则编号（inventory-trace-core.md IT-xx） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'InventoryRuleViolation'
    this.rule = rule
  }
}
