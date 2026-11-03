/**
 * quality 域规则违例：携带规则编号（'A-T12-x'，对应规则底稿
 * architecture/contracts/prep/p1/04-supply-chain-rules-T08T12T13T14.md §A-T12；
 * 引用冻结合同 inventory-trace-core.md 时以 IT-xx 标注）。
 * 应用层捕获后转为 CommandResult（BUSINESS_REJECTION）。
 */
export class QualityRuleViolation extends Error {
  /** 违反的规则编号（底稿 A-T12-x / 合同 IT-xx） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'QualityRuleViolation'
    this.rule = rule
  }
}
