/**
 * spc 域规则违例：携带规则编号（'PE-xx'，对应冻结合同
 * architecture/contracts/frozen/p3/process-change-spc-calibration.md；
 * 引用既有域规则（A-S1 数据范围二道防线 / NOT_FOUND）时以原编号标注）。
 */
export class SpcRuleViolation extends Error {
  /** 违反的规则编号（合同 PE-01～PE-21 / PE-S1～S5 / A-S1 / NOT_FOUND） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'SpcRuleViolation'
    this.rule = rule
  }
}
