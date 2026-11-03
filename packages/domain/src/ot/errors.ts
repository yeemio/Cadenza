/**
 * ot 域规则违例：携带规则编号（'OT-xx'，对应冻结合同
 * architecture/contracts/frozen/p3/ot-collection.md §1–§7）；
 * 引用既有域合同时以原编号标注（A-S1 数据范围二道防线 / NOT_FOUND 通用未找到）。
 */
export class OtRuleViolation extends Error {
  /** 违反的规则编号（OT-xx / A-S1 / NOT_FOUND） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'OtRuleViolation'
    this.rule = rule
  }
}
