import { ExecutionRuleViolation } from './errors'

/**
 * 工序可开工（就绪）统一判定 —— [底稿 A6-3 + K13/DM §5（合同新造：收敛三入口三种判定）]。
 *
 * 现状三口径（底稿 A6-3）：实绩录入=首道或前道有已提交报工；工作台=前道（跳过质检工序）
 * 存在已提交且有产出的报工单；扫码=同实绩且工序限定设备工作中心。
 * DM §5 目标（B12 裁定收敛）：按前置工序、物料、设备与质量规则就绪，不能只判断
 * 「前道出现过一张报工单」。P1 落地面：统一为「首道非质检工序直接就绪；否则最近的
 * 非质检前道存在已提交且有产出的报工单（跳过质检工序）」，物料/设备/质量扩展位以
 * 事实入参预留（facts 扩展不破坏判定），三入口共用本函数（同工序规则不分叉）。
 *
 * 工序可选择性（01 §3.3）：质检工序、未设生产部门工序一律不可选；非本部门工序不可选
 * （部门准入经 actorDeptIds 入参，服务端计算）。
 */

export interface ReadinessOperation {
  seq: number
  /** 质检工序标志（生产部门属质检部门清单，配置注入；0005 工序行无显式标志列，[合同新造]）。 */
  isQc: boolean
  /** 订单工序的生产部门（0005 production_dept_id；未设=不可选）。 */
  productionDeptId: string | null
}

export interface ReadinessReportFact {
  seq: number
  /** 已提交（含未审核；不含已删除/已撤审作废口径由调用方过滤后传入）。 */
  submitted: boolean
  /** 有产出（产出数量合计 > 0）。 */
  hasOutput: boolean
}

/**
 * [底稿 A6-3/K13 合同新造] 单一服务端就绪判定：目标工序是否可开工报工。
 */
export function computeOperationReadiness(input: {
  operations: readonly ReadinessOperation[]
  reports: readonly ReadinessReportFact[]
  targetSeq: number
  /** actor 可操作的部门集合（空数组=不限部门口径仅用于企业范围管理员；null=不做部门准入）。 */
  actorDeptIds?: readonly string[] | null
}): { ready: boolean; reason: string } {
  const target = input.operations.find((op) => op.seq === input.targetSeq)
  if (target === undefined) {
    return { ready: false, reason: `工序 seq=${String(input.targetSeq)} 不存在于当前订单工序设置` }
  }
  if (target.isQc) {
    return { ready: false, reason: '质检工序一律不可选（不可报工）' }
  }
  if (target.productionDeptId === null || target.productionDeptId === '') {
    return { ready: false, reason: '未设生产部门的工序不可选' }
  }
  if (
    input.actorDeptIds !== null &&
    input.actorDeptIds !== undefined &&
    input.actorDeptIds.length > 0 &&
    !input.actorDeptIds.includes(target.productionDeptId)
  ) {
    return { ready: false, reason: '非本部门工序不可选' }
  }
  // 首道非质检工序直接就绪
  const predecessors = input.operations
    .filter((op) => op.seq < target.seq && !op.isQc)
    .sort((a, b) => b.seq - a.seq)
  if (predecessors.length === 0) {
    return { ready: true, reason: '首道（非质检）工序就绪' }
  }
  // 非首道：最近的非质检前道须存在「已提交且有产出」的报工单
  const nearest = predecessors[0]!
  const satisfied = input.reports.some((r) => r.seq === nearest.seq && r.submitted && r.hasOutput)
  if (!satisfied) {
    return {
      ready: false,
      reason: `前道（跳过质检工序）seq=${String(nearest.seq)} 尚无已提交且有产出的报工单，工序不可开工`,
    }
  }
  return { ready: true, reason: `前道 seq=${String(nearest.seq)} 已提交且有产出，工序就绪` }
}

/** [底稿 A6-3/K13] 三入口共用的提交前置断言（readiness 不满足即拒绝）。 */
export function assertOperationReady(input: Parameters<typeof computeOperationReadiness>[0]): void {
  const verdict = computeOperationReadiness(input)
  if (!verdict.ready) {
    throw new ExecutionRuleViolation('A6-3', `工序就绪判定未通过：${verdict.reason}`)
  }
}
