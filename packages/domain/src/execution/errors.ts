/**
 * execution 域规则违例：携带底稿规则编号（如 'A5-1'、'A6-2'、'A7-4'）。
 * 应用层捕获后转为 CommandResult（BUSINESS_REJECTION），错误文案以 `[A5-x]`/`[A6-x]`/`[A7-x]`
 * 前缀携带规则编号（测试与排障口径，沿用 process A1-x / inventory IT-xx 模式）。
 *
 * 编号来源（architecture/contracts/prep/p1/03-production-chain-rules-T05T09T10T11.md）：
 * - A5-1 报工硬限（末道非质检累计 ≤ 计划×超额系数）；A5-2 超产服务端同单位；A5-3 五量分立
 * - A6-1 三入口与来源绑定；A6-2 草稿隔离键+跨来源互斥；A6-3 工序就绪统一判定；
 *   A6-4 审核轴判定；A6-5 审核统一动作；A6-6 修正/撤销/编辑/删除守卫
 * - A7-1 单独投料定位；A7-2 码准入链；A7-3 跨订单授权偏离；A7-4 扣减与记录；A7-5 外传
 * - NEW-1/NEW-2… 为本域无冻结合同时的 [合同新造] 项（对照表见 delivery 记录 §6）
 */
export class ExecutionRuleViolation extends Error {
  /** 违反的底稿规则编号 */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'ExecutionRuleViolation'
    this.rule = rule
  }
}
