/**
 * purchase 域规则违例：携带规则底稿编号（`architecture/contracts/prep/p1/04-supply-chain-rules-T08T12T13T14.md`
 * A 节 T08 部分，标记形如 'A-1'～'A-11'；IF-xx 引冻结合同 interfaces.md）。
 * 应用层捕获后转为 CommandResult（BUSINESS_REJECTION + ERR_BUSINESS_RULE），
 * 错误文案以 `[A-x]` 前缀携带编号（测试与排障口径）。
 */
export class PurchaseRuleViolation extends Error {
  /** 违反的规则编号（底稿 A-x / IF-xx） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'PurchaseRuleViolation'
    this.rule = rule
  }
}
