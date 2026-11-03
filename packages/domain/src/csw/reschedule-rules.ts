import { CswRuleViolation } from './errors'
import { addQty, cmpQty, parseQty, subQty } from './shared'
import type { CswSoftConstraintCode } from './constraint-rules'

/**
 * csw 有限能力可解释排程规则（T22 冻结合同 §3：CS-12/CS-13/CS-14/CS-15 + §5 CS-27）。
 *
 * [CS-12] 排程建议/重排输出必须逐任务给出 命中约束清单（为何移至此设备/此日期、被拒原因）；
 * 不使用无解释的黑盒数学优化输出直接落账——本文件为确定性贪心选择器（可解释、可回放），
 * 不做黑盒优化。[CS-14] 重排执行前先输出受影响任务清单；已开工任务不被自动移动，须人工决策。
 * [CS-15] 约束冲突无可行解时不静默丢弃任务，呈现冲突集与可选建议（放开工期/换设备/外协）。
 * [CS-27] 每次提交/重排生成排程版本；历史版本不被静默改写。
 */

/** 待排任务（订单工序粒度，余量 = 下线数量 − 已排合计）。 */
export interface RescheduleTask {
  orderOperationId: string
  orderId: string
  orderNo: string
  seq: number
  operationDefinitionId: string
  operationName: string
  /** 换型维度值（工序编码；产品属性维度由装配层换算后传入） */
  dimensionValue: string
  workCenterId: string
  offlineQty: string
  /** 既有槽位计划合计（T09 投影口径） */
  plannedQty: string
  /** T05 execution_status：executed＝已开工（不被自动移动） */
  executionStatus: 'pending' | 'executed'
  /** 计划完成时间（YYYY-MM-DD；null＝未定） */
  dueDate: string | null
  /** [CS-25] 外协占用中 */
  outsourced: boolean
  uom: string
}

/** 候选（设备 × 生产日期）评估输入。 */
export interface CandidateInput {
  equipmentId: string
  equipmentName: string
  equipmentStatus: number
  /** 校准有效性（constraint-rules.calibrationEffectAt 口径） */
  calibrationEffect: 'usable' | 'invalid' | 'expired' | 'unknown'
  /** [CS-09] 当日停机占用比例（0..1） */
  downtimeFraction: number
  /** [CS-11] (设备,日期) 冻结 */
  frozen: boolean
  /** 设备日产能（null＝未配置不参与比较） */
  capacity: string | null
  /** 当日既有排产合计（不含本任务） */
  dayPlannedQty: string
  /** [CS-16] 前序任务维度值（null＝当日首个） */
  previousDimensionValue: string | null
  productionDate: string
}

/** 硬拒原因码（CS-04 不得绕过）。 */
export type CandidateBlockReason =
  | 'equipment_repair'
  | 'calibration_invalid'
  | 'freeze_window'
  | 'downtime'
  | 'outsourcing_occupied'

export interface CandidateEvaluation {
  equipmentId: string
  productionDate: string
  blocked: CandidateBlockReason | null
  softViolations: Array<{ code: CswSoftConstraintCode; detail: string }>
  /** 建议完工晚于计划完成时间（CS-06② 交期冲突） */
  dueDateConflict: boolean
  changeoverMinutes: number
  /** (当日合计+本次)/有效产能 的负载率（0..∞；产能未配置＝null） */
  loadRatio: number | null
  /** 加权成本（权重由装配层按 CS-17 注入；越小越优） */
  cost: number
}

export interface SchedulingWeights {
  changeover: number
  loadBalance: number
}

/** [CS-16] 换型时间计入设备日历占用的日占用上限（分钟/设备日；超限为软提醒——无运行工时数据下的保守口径）。 */
export const CHANGEOVER_DAY_LIMIT_MINUTES = 480

/** [CS-09] 全日停机占用阈值（占用比例 ≥ 此值视为当日不可用）。 */
export const FULL_DAY_DOWNTIME_FRACTION = 1

/** 单候选评估（纯函数；解释字段完整返回，供 CS-12 逐任务命中约束清单）。 */
export function evaluateCandidate(
  task: RescheduleTask,
  c: CandidateInput,
  qtyToSchedule: string,
  weights: SchedulingWeights,
  changeoverMinutesOf: (previous: string | null, next: string) => number,
): CandidateEvaluation {
  const soft: Array<{ code: CswSoftConstraintCode; detail: string }> = []
  // 硬约束链（[CS-05]：②维修 ③校准 ④冻结窗口；CS-09 停机全日；CS-25 外协占用）
  let blocked: CandidateBlockReason | null = null
  if (c.equipmentStatus === 2) {
    blocked = 'equipment_repair'
  } else if (c.calibrationEffect === 'invalid' || c.calibrationEffect === 'expired') {
    blocked = 'calibration_invalid'
  } else if (c.frozen) {
    blocked = 'freeze_window'
  } else if (c.downtimeFraction >= FULL_DAY_DOWNTIME_FRACTION) {
    blocked = 'downtime'
  }
  if (task.outsourced) {
    blocked = 'outsourcing_occupied'
  }

  const changeoverMinutes = blocked === null ? changeoverMinutesOf(c.previousDimensionValue, task.dimensionValue) : 0

  let loadRatio: number | null = null
  if (blocked === null && c.capacity !== null) {
    const dayTotal = addQty(c.dayPlannedQty, qtyToSchedule)
    const capScaled = parseQty(c.capacity, '有效产能', 'CS-09')
    if (capScaled > 0n) {
      loadRatio = Number(parseQty(dayTotal, '当日合计', 'CS-09')) / Number(capScaled)
    } else {
      loadRatio = Number.POSITIVE_INFINITY // 已配置零产能：任何正数均超（CS-06① 弱提醒同 T09 口径）
    }
    if (loadRatio > 1) {
      soft.push({
        code: 'capacity_overrun',
        detail: `设备【${c.equipmentName}】${c.productionDate} 当日累计 ${dayTotal} 超有效产能 ${c.capacity}`,
      })
    }
  }
  if (blocked === null && changeoverMinutes > CHANGEOVER_DAY_LIMIT_MINUTES) {
    soft.push({
      code: 'changeover_nonoptimal',
      detail: `换型 ${changeoverMinutes} 分钟超设备日占用上限 ${CHANGEOVER_DAY_LIMIT_MINUTES} 分钟`,
    })
  }
  // [CS-06②] 交期冲突：建议完工晚于计划完成时间（当日建议 = 候选生产日期）
  const dueDateConflict =
    task.dueDate !== null && c.productionDate > task.dueDate
  if (dueDateConflict) {
    soft.push({
      code: 'due_date_conflict',
      detail: `建议完工 ${c.productionDate} 晚于计划完成时间 ${task.dueDate}`,
    })
  }

  // 加权成本（[CS-17] 换型最少 → 负荷均衡；交期紧迫度在任务排序侧承担——三层默认序的确定性实现）
  const changeoverCost = changeoverMinutes / 1440
  const loadCost = loadRatio === null ? 0 : Math.min(loadRatio, 5)
  const softPenalty = soft.length > 0 ? 1 + soft.length : 0
  const cost =
    blocked !== null ? Number.POSITIVE_INFINITY : weights.changeover * changeoverCost + weights.loadBalance * loadCost + softPenalty
  return {
    equipmentId: c.equipmentId,
    productionDate: c.productionDate,
    blocked,
    softViolations: soft,
    dueDateConflict,
    changeoverMinutes,
    loadRatio,
    cost,
  }
}

/** 确定性择优：非阻断候选中成本最小；并列时 (成本, 设备id, 日期) 字典序稳定排序。 */
export function selectBestCandidate(
  candidates: readonly CandidateEvaluation[],
): CandidateEvaluation | null {
  const feasible = candidates
    .filter((c) => c.blocked === null)
    .sort(
      (a, b) =>
        a.cost - b.cost ||
        (a.equipmentId < b.equipmentId ? -1 : a.equipmentId > b.equipmentId ? 1 : 0) ||
        (a.productionDate < b.productionDate ? -1 : 1),
    )
  return feasible[0] ?? null
}

/** [CS-12] 逐任务解释：为何移至此设备/此日期、被拒原因（命中约束清单）。 */
export interface TaskExplanation {
  why: string
  hitConstraints: string[]
  rejectedAlternatives: Array<{ equipmentId: string; productionDate: string; reason: string; softCodes?: string[] }>
}

export function buildTaskExplanation(input: {
  orderNo: string
  operationName: string
  chosen: CandidateEvaluation | null
  candidates: readonly CandidateEvaluation[]
}): TaskExplanation {
  const BLOCK_LABELS: Readonly<Record<CandidateBlockReason, string>> = {
    equipment_repair: '设备维修中（CS-05②）',
    calibration_invalid: '校准过期/失准（CS-05③/CS-10）',
    freeze_window: '冻结窗口内（CS-05④/CS-11）',
    downtime: '全日维护停机（CS-09）',
    outsourcing_occupied: '工序外协占用中（CS-25）',
  }
  const rejected = input.candidates
    .filter((c) => c.blocked !== null || c !== input.chosen)
    .map((c) => ({
      equipmentId: c.equipmentId,
      productionDate: c.productionDate,
      reason:
        c.blocked !== null
          ? (BLOCK_LABELS[c.blocked] ?? c.blocked)
          : `成本次优（cost=${c.cost.toFixed(4)}，换型 ${c.changeoverMinutes} 分钟）`,
      softCodes: c.blocked === null && c.softViolations.length > 0 ? c.softViolations.map((s) => s.code) : undefined,
    }))
  if (input.chosen === null) {
    return {
      why: `${input.orderNo} ${input.operationName}：窗口内无可行候选（冲突集见 rejectedAlternatives）`,
      hitConstraints: rejected.map((r) => r.reason),
      rejectedAlternatives: rejected,
    }
  }
  const softNotes = input.chosen.softViolations.map((s) => `${s.code}：${s.detail}`)
  return {
    why:
      `${input.orderNo} ${input.operationName} → 设备 ${input.chosen.equipmentId} @ ${input.chosen.productionDate}`
      + `（换型 ${input.chosen.changeoverMinutes} 分钟，成本 ${input.chosen.cost.toFixed(4)}；交期优先→换型最少→负荷均衡默认序）`,
    hitConstraints: [...softNotes],
    rejectedAlternatives: rejected,
  }
}

// ---------------------------------------------------------------------------
// CS-14 受影响任务呈现 + 已开工不自动移动；CS-15 无解呈现
// ---------------------------------------------------------------------------

/** 版本条目动作。 */
export type VersionItemAction = 'keep' | 'move' | 'new' | 'remove' | 'conflict' | 'outside_horizon'

export const VERSION_ITEM_ACTION_VALUES: readonly VersionItemAction[] = [
  'keep',
  'move',
  'new',
  'remove',
  'conflict',
  'outside_horizon',
]

/** [CS-15] 无解呈现：不静默丢弃任务，冲突集 + 可选建议（放开工期/换设备/外协）。 */
export interface ConflictSuggestion {
  option: 'delay_start' | 'change_equipment' | 'outsourcing' | 'manual_decision'
  detail: string
}

export function buildConflictItem(input: {
  task: RescheduleTask
  horizonLastDate: string
  candidates: readonly CandidateEvaluation[]
  hasAnyEquipmentCandidate: boolean
}): { suggestions: ConflictSuggestion[]; conflictSet: string[] } {
  const conflictSet = input.candidates.map((c) => `${c.equipmentId}@${c.productionDate}:${c.blocked ?? 'soft'}`)
  const suggestions: ConflictSuggestion[] = []
  if (input.task.executionStatus === 'executed') {
    suggestions.push({
      option: 'manual_decision',
      detail: '工序已开工：已开工任务不被自动移动，须人工决策（CS-14）',
    })
  }
  suggestions.push({
    option: 'delay_start',
    detail: `放开工期：求解窗口（至 ${input.horizonLastDate}）内无可行候选，可扩大窗口或后移开工`,
  })
  if (input.hasAnyEquipmentCandidate) {
    suggestions.push({ option: 'change_equipment', detail: '换设备：存在部分受阻候选，处置其阻断约束后可排' })
  }
  if (input.task.executionStatus === 'pending') {
    suggestions.push({ option: 'outsourcing', detail: '外协：可创建外协任务挂接该工序（CS-19 状态机承接）' })
  }
  return { suggestions, conflictSet }
}

/** 既有槽位在重排中的动作分类：冻结/已开工 → keep（只读）；其余按引擎决策。 */
export function classifyExistingSlot(slot: {
  id: string
  frozen: boolean
  started: boolean
}): 'keep' | 'movable' {
  if (slot.frozen) return 'keep' // [CS-11] 冻结窗口内槽位对自动重排只读
  if (slot.started) return 'keep' // [CS-14] 已开工任务不被自动移动
  return 'movable'
}

// ---------------------------------------------------------------------------
// CS-27 排程版本（提交/重排生成版本；历史版本不被静默改写）
// ---------------------------------------------------------------------------

export type ScheduleVersionStatus = 'proposed' | 'committed' | 'superseded'

export const SCHEDULE_VERSION_STATUS_VALUES: readonly ScheduleVersionStatus[] = [
  'proposed',
  'committed',
  'superseded',
]

/** [CS-27] 版本状态迁移：proposed→committed（提交）／proposed|committed→superseded（被新版本替代）；其余拒。 */
export function assertVersionTransition(from: ScheduleVersionStatus, to: ScheduleVersionStatus): void {
  const ok =
    (from === 'proposed' && to === 'committed') ||
    (from === 'proposed' && to === 'superseded') ||
    (from === 'committed' && to === 'superseded')
  if (!ok) {
    throw new CswRuleViolation(
      'CS-27',
      `排程版本状态不可从 ${from} 迁移到 ${to}（proposed→committed/superseded、committed→superseded；历史版本不被静默改写）`,
    )
  }
}

/** 余量计算（下线 − 已排，下限 0）。 */
export function remainingQtyOf(task: Pick<RescheduleTask, 'offlineQty' | 'plannedQty'>): string {
  if (cmpQty(task.plannedQty, task.offlineQty) >= 0) return '0'
  return subQty(task.offlineQty, task.plannedQty, 'CS-05')
}
