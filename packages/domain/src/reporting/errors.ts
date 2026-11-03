/**
 * reporting 域规则违例：携带规则编号（'RP-xx'，对应冻结合同
 * architecture/contracts/frozen/p2/reporting.md；引用 P1 合同 IT/OA/PC 编号时以原编号标注）。
 */
export class ReportingRuleViolation extends Error {
  /** 违反的规则编号（RP-xx / IT-xx / A-S1） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'ReportingRuleViolation'
    this.rule = rule
  }
}
