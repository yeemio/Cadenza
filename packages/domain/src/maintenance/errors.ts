/**
 * maintenance 域规则违例：携带规则编号（'MT-xx'，对应冻结合同
 * architecture/contracts/frozen/p2/maintenance.md；引用 P1 合同 MD/IT/PC/OA/A 编号时以原编号标注）。
 */
export class MaintenanceRuleViolation extends Error {
  /** 违反的规则编号（MT-xx / MD-xx / IT-xx / A-S1） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'MaintenanceRuleViolation'
    this.rule = rule
  }
}
