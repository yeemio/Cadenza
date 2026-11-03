/**
 * scheduling 域规则违例：携带底稿规则编号（如 'A3-1'、'A4-1'）。
 * 应用层捕获后转为 CommandResult（BUSINESS_REJECTION），错误文案以 `[A3-x]`/`[A4-x]`
 * 前缀携带规则编号（测试与排障口径，沿用 process 块 A1/A2 模式）。
 *
 * 编号来源（architecture/contracts/prep/p1/03-production-chain-rules-T05T09T10T11.md）：
 * - A3-1 排产槽位唯一键与替换/删槽语义；A3-2 硬校验（工序计划合计 ≤ 下线数量，本槽按替换旧值计）
 *   与超设备日产能弱提醒（二次确认可过，产能空不比较）；
 * - A3-3 设备状态约束（维修且无槽不可新建正数）；A3-4 回写链投影（工序已排/是否排完/订单排产状态）；
 * - A3-5 设备看板日期列（今日起 30 天 ∪ 已有排产日）与已结束订单排产不展示；
 * - A3-6 订单排程详情前置（工序已配置且各工序均已配置工作中心）；A3-7 PDA 排产计划只读；
 * - A4-1 班次参数（白班起点，工厂级）；A4-2 班次日期计算（早于白班起点取前一日，双轨时间）。
 * - NEW-x 为本域无冻结合同时的 [合同新造] 项（对照表见 delivery/L1/server-scheduling/DELIVERY.md §6）。
 */
export class SchedulingRuleViolation extends Error {
  /** 违反的底稿规则编号 */
  readonly rule: string

  constructor(rule: string, message: string) {
    super(message)
    this.name = 'SchedulingRuleViolation'
    this.rule = rule
  }
}
