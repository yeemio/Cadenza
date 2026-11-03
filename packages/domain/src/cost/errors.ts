/**
 * cost 域规则违例：携带规则编号（'CE-xx'，对应冻结合同
 * architecture/contracts/frozen/p3/cost-energy.md；表级约束以 'CE-Sx' 标注；
 * 引用组织/库存等跨域合同时以原编号标注，如 'A-S1'；CA-12/CA-13 为 PROPOSED 依赖
 * 默认口径的显式标注位）。
 */
export class CostRuleViolation extends Error {
  /** 违反的规则编号（CE-xx / CE-Sx / A-S1 / NOT_FOUND / CA-12 / CA-13） */
  readonly rule: string

  constructor(rule: string, message: string) {
    // 消息内嵌规则码（全中文错误带规则码口径：裸抛到上层也自描述）
    super(`[${rule}] ${message}`)
    this.name = 'CostRuleViolation'
    this.rule = rule
  }
}

/** 通用"目标不存在"规则码（映射 NOT_FOUND 错误码，同各域先例）。 */
export const COST_NOT_FOUND_RULE = 'NOT_FOUND'
