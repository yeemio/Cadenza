import type { DecimalString } from '@cadenza/contracts'
import { ProcessRuleViolation } from './errors'
import { computeOperationRequirements, type OperationRequirementInput } from './requirements'

/**
 * 生产订单状态机与订单侧规则。
 *
 * 状态轴 [底稿 A1-1 + DM §5（合同新造：完工待核、ERP 关闭分离）]：
 * approved(已核准) → released(允许开工) → in_progress(进行中) → pending_completion(完工待核)
 * → closed(已结束)；voided(已作废) 独立（非轴上状态）；suspended(挂起) 为独立布尔开关；
 * ERP 商业关闭（erp_closed_at/by）与 MOM 执行完成（business_closed_at）分离。
 */

export type ProductionOrderStatus =
  | 'approved'
  | 'released'
  | 'in_progress'
  | 'pending_completion'
  | 'closed'
  | 'voided'

export type ProcessConfigStatus = 'unconfigured' | 'configured'

export const PRODUCTION_ORDER_STATUS_VALUES: readonly ProductionOrderStatus[] = [
  'approved',
  'released',
  'in_progress',
  'pending_completion',
  'closed',
  'voided',
]

/** 轴上顺次迁移（voided 不在轴上，独立判定）。 */
const AXIS_TRANSITIONS: Readonly<Record<Exclude<ProductionOrderStatus, 'voided'>, ProductionOrderStatus>> = {
  approved: 'released',
  released: 'in_progress',
  in_progress: 'pending_completion',
  pending_completion: 'closed',
  closed: 'closed',
}

/**
 * [底稿 A1-1 / 合同新造 DM §5] 状态迁移校验：
 * - 轴上仅允许顺次前进（approved→released→in_progress→pending_completion→closed）；
 * - voided 可自 approved/released/in_progress/pending_completion 进入（已作废/已结束后不可作废）；
 * - closed/voided 为终态。
 */
export function assertOrderTransition(from: ProductionOrderStatus, to: ProductionOrderStatus): void {
  if (from === to) {
    throw new ProcessRuleViolation('NEW-1', `订单已处于目标状态 ${to}，无须迁移`)
  }
  if (from === 'voided' || from === 'closed') {
    throw new ProcessRuleViolation('NEW-1', `订单已${from === 'voided' ? '作废' : '结束'}，不可再变更状态`)
  }
  if (to === 'voided') return // 作废独立：approved/released/in_progress/pending_completion 均可
  const expected = AXIS_TRANSITIONS[from]
  if (expected !== to) {
    throw new ProcessRuleViolation(
      'NEW-1',
      `状态轴只允许顺次迁移（${from} 的下一态为 ${expected}，收到 ${to}）；作废请走独立作废动作`,
    )
  }
}

/**
 * [底稿 A1-1] 开工前置（全部满足才可开工；PRD 生产订单 §2.1 开工 + DM §5）：
 * - 状态 = 允许开工（released）；
 * - 已配置工序且存在工序行（processConfigStatus=configured 且 operationCount>0）；
 * - 工艺路线已确认（processConfirmedAt 非空；01 §3.1）；
 * - 非挂起（挂起独立开关，挂起态不可开工）；
 * - 开工时间必填（非空且为合法 ISO-8601 时间；缺省由调用方以服务端当前时间补齐，PRD 默认当前时间）。
 */
export interface OrderStartFacts {
  orderStatus: ProductionOrderStatus
  processConfigStatus: ProcessConfigStatus
  /** 已配置工序行数（当前设置版本） */
  operationCount: number
  /** 工艺路线确认时间（ISO-8601 或 null） */
  processConfirmedAt: string | null
  suspended: boolean
  /** 开工时间（ISO-8601 或 null） */
  actualStartAt: string | null
}

export function assertOrderStartable(facts: OrderStartFacts): void {
  if (facts.orderStatus === 'voided') {
    throw new ProcessRuleViolation('A1-1', '已作废订单不可开工')
  }
  if (facts.orderStatus === 'closed' || facts.orderStatus === 'pending_completion') {
    throw new ProcessRuleViolation('A1-1', `订单已进入 ${facts.orderStatus} 阶段，不可开工`)
  }
  if (facts.orderStatus !== 'released') {
    throw new ProcessRuleViolation(
      'A1-1',
      `仅「允许开工」状态可开工（当前 ${facts.orderStatus}；须上游放行后方可开工）`,
    )
  }
  if (facts.suspended) {
    throw new ProcessRuleViolation('A1-1', '订单处于挂起状态，不可开工（请先解除挂起）')
  }
  if (facts.processConfigStatus !== 'configured') {
    throw new ProcessRuleViolation('A1-1', '工序未配置，不可开工（须先配置工序路线）')
  }
  if (facts.operationCount <= 0) {
    throw new ProcessRuleViolation('A1-1', '已配置工序但不存在工序行，不可开工')
  }
  if (facts.processConfirmedAt === null) {
    throw new ProcessRuleViolation('A1-1', '工艺路线未确认，不可开工')
  }
  if (facts.actualStartAt === null || facts.actualStartAt === '') {
    throw new ProcessRuleViolation('A1-1', '开工时间必填（缺省时应以服务端当前时间补齐）')
  }
  if (Number.isNaN(Date.parse(facts.actualStartAt))) {
    throw new ProcessRuleViolation('A1-1', `开工时间必须为合法 ISO-8601 时间：${facts.actualStartAt}`)
  }
}

/** [底稿 A1-1/合同新造] 挂起前置：非作废/非已结束订单可挂起（挂起独立开关）。 */
export function assertOrderSuspendable(facts: {
  orderStatus: ProductionOrderStatus
  suspended: boolean
}): void {
  if (facts.suspended) {
    throw new ProcessRuleViolation('NEW-1', '订单已处于挂起状态，无须重复挂起')
  }
  if (facts.orderStatus === 'voided' || facts.orderStatus === 'closed') {
    throw new ProcessRuleViolation(
      'NEW-1',
      `已${facts.orderStatus === 'voided' ? '作废' : '结束'}订单不可挂起`,
    )
  }
}

/** [底稿 A1-1/合同新造] 解除挂起前置：仅挂起态可解除。 */
export function assertOrderResumable(facts: { suspended: boolean }): void {
  if (!facts.suspended) {
    throw new ProcessRuleViolation('NEW-1', '订单未挂起，无须解除挂起')
  }
}

/** [底稿 A1-1/合同新造] 作废前置：非作废且非已结束可作废（已结束订单的更正走冲销，DM §8）。 */
export function assertOrderVoidable(facts: { orderStatus: ProductionOrderStatus }): void {
  if (facts.orderStatus === 'voided') {
    throw new ProcessRuleViolation('NEW-1', '订单已作废，无须重复作废')
  }
  if (facts.orderStatus === 'closed') {
    throw new ProcessRuleViolation('NEW-1', '订单已结束，不可作废（生效事实走冲销，不做隐式删除）')
  }
}

/**
 * [合同新造 DM §5] ERP 商业关闭与 MOM 执行完成分离：
 * - 执行完成 = business_closed_at（MOM 侧，由完工核/报工域驱动，本块无置位路径）；
 * - 商业关闭 = erp_closed_at/by（ERP 侧独立字段，同步回写）；
 * 两者互不覆盖、互不推导；本函数族仅提供口径判定，防止把 ERP 关闭当作执行完成。
 */
export function isExecutionClosed(facts: { businessClosedAt: string | null }): boolean {
  return facts.businessClosedAt !== null
}

export function isErpClosed(facts: { erpClosedAt: string | null }): boolean {
  return facts.erpClosedAt !== null
}

export function assertErpCloseDoesNotCloseExecution(facts: {
  erpClosedAt: string | null
  businessClosedAt: string | null
}): void {
  if (facts.erpClosedAt !== null && facts.businessClosedAt === null) {
    // 合法形态：ERP 已商业关闭而 MOM 执行未完成（分离口径的本意）；不抛错，仅可观测口径说明。
    return
  }
}

// ---------------------------------------------------------------------------
// 工序设置变更锁与变更版本 —— [底稿 A1-2 / A2-4（S04 裁定，PI §2）]
// ---------------------------------------------------------------------------

/** 工序设置的结构性变更类型（A1-2 锁定对象）。 */
export type OperationStructureChange = 'add' | 'remove' | 'reorder' | 'rename'

/**
 * [底稿 A1-2] 工序设置变更锁：已有报工（含未提交报工单）后，
 * 不可新增工序、不可调序、不可删行、不可改工序名称；
 * 工序备注、芯倍数、绞合系数、下线数量仍可改（改系数走变更版本，A2-4）。
 */
export function assertOperationStructureChangeAllowed(facts: {
  hasWorkReports: boolean
  change: OperationStructureChange
}): void {
  if (!facts.hasWorkReports) return
  const messages: Record<OperationStructureChange, string> = {
    add: '已有报工，不可新增工序',
    remove: '已有报工，不可删除工序行',
    reorder: '已有报工，不可调整工序顺序',
    rename: '已有报工，不可修改工序名称',
  }
  throw new ProcessRuleViolation('A1-2', `${messages[facts.change]}（工序备注/芯倍数/绞合/下线数量可经变更版本调整）`)
}

/** 当前工序设置行（变更版本规划的输入）。 */
export interface OperationSettingsRow {
  seq: number
  operationDefinitionId: string
  operationName: string
  coreMultiple: number
  strandFactor: DecimalString | null
  offlineQty: DecimalString
  /** 已执行（有实绩）行：变更版本下保留原版本（A2-4）。报工域未建，本块无置位路径。 */
  executed: boolean
}

/** 系数级变更（仅允许芯倍数/绞合/下线数量/备注；结构字段不在载荷形状内）。 */
export interface OperationCoefficientUpdate {
  seq: number
  coreMultiple?: number
  strandFactor?: DecimalString | null
  offlineQty?: DecimalString
  operationRemark?: string
}

export interface OperationSettingsChangePlanRow {
  seq: number
  operationDefinitionId: string
  operationName: string
  coreMultiple: number
  strandFactor: DecimalString | null
  offlineQty: DecimalString
  operationRemark?: string
  /** 该行归属的设置版本：已执行行保留 currentSettingsVersion，未执行行进 nextSettingsVersion */
  settingsVersion: number
  executed: boolean
  /** 该行下线数量是否重算 */
  recomputed: boolean
}

export interface OperationSettingsChangePlan {
  currentSettingsVersion: number
  nextSettingsVersion: number
  rows: OperationSettingsChangePlanRow[]
}

/**
 * [底稿 A2-4（S04 裁定）] 变更版本规划：已有报工后修改芯倍数/绞合/下线数量
 * → 形成新的工序设置版本，仅调整未执行任务；已执行行保留原版本与原值（实绩不动）；
 * 无报工时同样产出下一版本规划（全部行未执行，等价于原位调整+版本递增）。
 *
 * 校验：
 * - 变更载荷的 seq 必须全部命中现有工序行（新增/删除/调序/改名在结构锁 A1-2 拦截，
 *   本函数不再接受结构字段）；
 * - 已执行行的系数不可改（实绩绑定原版本）；
 * - 未执行行按「自末道向上递推」重算下线数量（冻结行保留原值，A2-1）。
 *
 * 预留说明：报工域未建（executed 无置位路径），本函数与 A1-2 锁为 S04 预留规则面，
 * 数据结构（order_operation.settings_version/execution_status）已在 0005 落库。
 */
export function planOperationSettingsChange(input: {
  orderQty: DecimalString
  currentSettingsVersion: number
  operations: readonly OperationSettingsRow[]
  updates: readonly OperationCoefficientUpdate[]
}): OperationSettingsChangePlan {
  if (input.currentSettingsVersion < 1) {
    throw new ProcessRuleViolation('A2-4', `当前设置版本必须 ≥1：${String(input.currentSettingsVersion)}`)
  }
  const bySeq = new Map(input.operations.map((op) => [op.seq, op]))
  for (const update of input.updates) {
    const target = bySeq.get(update.seq)
    if (target === undefined) {
      throw new ProcessRuleViolation(
        'A2-4',
        `变更载荷包含不存在的工序行 seq=${String(update.seq)}（新增/删除/调序/改名须先通过结构锁校验）`,
      )
    }
    if (target.executed && (
      update.coreMultiple !== undefined ||
      update.strandFactor !== undefined ||
      update.offlineQty !== undefined
    )) {
      throw new ProcessRuleViolation(
        'A2-4',
        `工序 seq=${String(update.seq)} 已有实绩，系数保留原版本不可改（已完成实绩保留原版本）`,
      )
    }
  }

  const nextVersion = input.currentSettingsVersion + 1
  // 先合成未执行行的目标系数，再自末道向上重算（已执行行冻结）
  const planned: OperationRequirementInput[] = input.operations.map((op) => {
    const update = input.updates.find((u) => u.seq === op.seq)
    return {
      seq: op.seq,
      coreMultiple: update?.coreMultiple ?? op.coreMultiple,
      strandFactor: update?.strandFactor !== undefined ? update.strandFactor : op.strandFactor,
      currentOfflineQty: update?.offlineQty ?? op.offlineQty,
      frozen: op.executed,
    }
  })
  const derived = new Map(computeOperationRequirements({ orderQty: input.orderQty, operations: planned }).map((r) => [r.seq, r]))

  const rows: OperationSettingsChangePlanRow[] = input.operations.map((op) => {
    const update = input.updates.find((u) => u.seq === op.seq)
    const derivedRow = derived.get(op.seq)!
    return {
      seq: op.seq,
      operationDefinitionId: op.operationDefinitionId,
      operationName: op.operationName,
      coreMultiple: update?.coreMultiple ?? op.coreMultiple,
      strandFactor: update?.strandFactor !== undefined ? update.strandFactor : op.strandFactor,
      offlineQty: derivedRow.offlineQty,
      operationRemark: update?.operationRemark,
      settingsVersion: op.executed ? input.currentSettingsVersion : nextVersion,
      executed: op.executed,
      recomputed: !derivedRow.kept && !op.executed,
    }
  })
  return { currentSettingsVersion: input.currentSettingsVersion, nextSettingsVersion: nextVersion, rows }
}
