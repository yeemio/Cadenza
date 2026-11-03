/**
 * csw 域（受约束排程与外协，T22）规则违例：携带冻结合同规则编号（如 'CS-11'）。
 * 应用层捕获后转为 CommandResult（BUSINESS_REJECTION），错误文案以 `[CS-x]`
 * 前缀携带规则编号（测试与排障口径，沿用 scheduling/shipping 块模式）。
 *
 * 编号来源：architecture/contracts/frozen/p3/constrained-scheduling.md
 * （CS-01～CS-27 业务规则 + CS-S1～CS-S5 表级约束；承接基线 CS-01～03 属 T09 已冻结行为，
 * 本域只做 G4 增量）。CS-19～CS-25 外协部分原件输入为零、显式 [合同新造]。
 */
export class CswRuleViolation extends Error {
  /** 违反的冻结合同规则编号 */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'CswRuleViolation'
    this.rule = rule
  }
}
