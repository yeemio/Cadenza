/**
 * shipping 域规则违例：携带规则编号（'A-T14-x'，对应规则底稿
 * architecture/contracts/prep/p1/04-supply-chain-rules-T08T12T13T14.md §A-T14；
 * 引用冻结合同 interfaces.md（IF-04/05/06/07）与 inventory-trace-core.md（IT-xx）时以原编号标注）。
 */
export class ShippingRuleViolation extends Error {
  /** 违反的规则编号（底稿 A-T14-x / 合同 IF-xx / IT-xx） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'ShippingRuleViolation'
    this.rule = rule
  }
}
