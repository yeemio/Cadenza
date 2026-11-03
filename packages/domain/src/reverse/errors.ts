/**
 * reverse 域规则违例：携带规则编号（'WR-xx'，对应冻结合同
 * architecture/contracts/frozen/p2/warehouse-reverse.md；
 * 引用 P1 冻结合同（IT-xx/OA-xx/IF-xx/A-S1 等）时以原编号标注）。
 * 标注 [合同新造] 的规则在 CA/GAP 裁定前不视为已接受（合同状态约定随行）。
 */
export class ReverseRuleViolation extends Error {
  /** 违反的规则编号（WR-xx / 合同引用编号） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'ReverseRuleViolation'
    this.rule = rule
  }
}
