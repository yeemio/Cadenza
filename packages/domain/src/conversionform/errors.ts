/**
 * conversionform 域规则违例：携带规则编号（'FC-x'，对应冻结合同
 * architecture/contracts/frozen/p2/form-conversion.md FC-01～FC-21；
 * 引用 P1 冻结合同（IT-xx/IF-xx/OA-xx）与 GAP-Fx 时以原编号标注）。
 */
export class ConversionRuleViolation extends Error {
  /** 违反的规则编号（合同 FC-x / P1 合同 IF-xx、IT-xx、OA-xx / 未决 GAP-Fx） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'ConversionRuleViolation'
    this.rule = rule
  }
}
