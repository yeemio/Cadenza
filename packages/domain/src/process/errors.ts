/**
 * process 域规则违例：携带底稿规则编号（如 'A1-1'、'A2-2'）。
 * 应用层捕获后转为 CommandResult（BUSINESS_REJECTION），错误文案以 `[A1-x]`/`[A2-x]` 前缀
 * 携带规则编号（测试与排障口径，沿用 masterdata MD-xx 模式）。
 *
 * 编号来源（architecture/contracts/prep/p1/03-production-chain-rules-T05T09T10T11.md）：
 * - A1-1 订单状态轴与开工前置；A1-2 工序设置变更锁；A1-3 工序主数据（唯一性/引用保护/编辑锁）
 * - A2-1 工序需求推导；A2-2 版本冻结；A2-3 订单快照冻结；A2-4 变更版本（S04 裁定）
 * - NEW-1/NEW-2… 为本域无冻结合同时的 [合同新造] 项（对照表见 delivery 记录 §6）
 */
export class ProcessRuleViolation extends Error {
  /** 违反的底稿规则编号 */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'ProcessRuleViolation'
    this.rule = rule
  }
}
