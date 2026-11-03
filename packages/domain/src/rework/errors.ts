/**
 * rework 域规则违例：携带规则编号（'RS-xx'，对应冻结合同
 * architecture/contracts/frozen/p2/rework-split.md；引用 P1 冻结合同
 * （IT-xx/OA-xx/MD-xx 等）时以原编号标注）。
 * 标注 [合同新造] 的规则在 CA/GAP 裁定前不视为已接受（合同状态约定随行）。
 */
export class ReworkRuleViolation extends Error {
  /** 违反的规则编号（RS-xx / 合同引用编号） */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'ReworkRuleViolation'
    this.rule = rule
  }
}
