import { CswRuleViolation } from './errors'
import {
  addQty,
  assertQtyNonNegative,
  assertQtyPositive,
  cmpQty,
  dateRangesOverlap,
  formatQty,
  isValidProductionDate,
  parseQty,
  subQty,
} from './shared'

/**
 * csw 约束种类与强度分级 + 就绪规则 + 校准/停机约束输入（T22 冻结合同 §2）。
 *
 * CS-04 约束强度二分：硬约束违反即拒绝排产/开工命令；软约束违反须填写理由与责任人后方可提交；
 * CS-05 首期硬约束清单（①②承接 T09 已冻结行为，本域在排程输出提交时同链复检；
 * ③校准 ④冻结窗口 ⑤就绪）；CS-06 首期软约束清单；CS-07 就绪规则四条件；
 * CS-08 物料齐套默认口径；CS-09 维护停机占用设备可用能力；CS-10 校准约束（新建拒/已排标记）。
 */

// ---------------------------------------------------------------------------
// CS-04/CS-05/CS-06 约束强度分级与清单
// ---------------------------------------------------------------------------

/** [CS-05] 首期硬约束码（违反即拒绝排产/开工命令）。 */
export const CSW_HARD_CONSTRAINT_CODES = [
  'operation_total_limit', // ①工序计划合计≤下线数量（CS-02 原文强校验，T09 主闭合、提交侧同链复检）
  'equipment_repair', // ②维修中设备禁新建正数槽位（CS-01 原文）
  'calibration_invalid', // ③校准过期/失准设备禁新建正数槽位（PE-13/17 联动）
  'freeze_window', // ④冻结窗口内槽位对重排只读（CS-11）
  'readiness_not_met', // ⑤前置工序/物料/设备/质量就绪不满足不得开工（CS-07）
] as const

/** [CS-06] 首期软约束码（违反须填写理由与责任人后方可提交，记录 操作者、理由、影响范围）。 */
export const CSW_SOFT_CONSTRAINT_CODES = [
  'capacity_overrun', // ①超设备日产能（原文二次确认）
  'due_date_conflict', // ②交期冲突（建议完工晚于计划完成时间）
  'changeover_nonoptimal', // ③换型时间非最优
  'load_imbalance', // ④设备/班次负荷不均衡
] as const

export type CswHardConstraintCode = (typeof CSW_HARD_CONSTRAINT_CODES)[number]
export type CswSoftConstraintCode = (typeof CSW_SOFT_CONSTRAINT_CODES)[number]

export const CSW_CONSTRAINT_LABELS: Readonly<Record<string, string>> = {
  operation_total_limit: '工序计划合计超下线数量（硬约束）',
  equipment_repair: '维修中设备禁新建正数槽位（硬约束）',
  calibration_invalid: '校准过期/失准设备禁新建正数槽位（硬约束）',
  freeze_window: '冻结窗口内槽位对重排只读（硬约束）',
  readiness_not_met: '就绪条件不满足不得开工（硬约束）',
  capacity_overrun: '超设备日产能（软约束，二次确认）',
  due_date_conflict: '交期冲突：建议完工晚于计划完成时间（软约束）',
  changeover_nonoptimal: '换型时间非最优（软约束）',
  load_imbalance: '设备/班次负荷不均衡（软约束）',
  downtime: '维护停机占用设备可用能力（CS-09）',
  outsourcing_occupied: '外协占用：外协期间本厂设备不排产（CS-25）',
  outside_horizon: '求解窗口外（CS-18，仅列示不参与优化）',
}

/** [CS-04/CS-06] 软约束违反记录：操作者、理由、影响范围（缺一不可提交）。 */
export interface SoftOverrideRecord {
  operator: string
  reason: string
  affectedScope: string
  softCode: CswSoftConstraintCode
}

export function assertSoftOverrideComplete(record: {
  operator?: string | null
  reason?: string | null
  affectedScope?: string | null
  softCode: string
}): void {
  if (!record.operator || record.operator.trim() === '') {
    throw new CswRuleViolation('CS-06', '软约束违反提交必须记录操作者（责任人）')
  }
  if (!record.reason || record.reason.trim() === '') {
    throw new CswRuleViolation('CS-04', '软约束违反须填写理由后方可提交')
  }
  if (!record.affectedScope || record.affectedScope.trim() === '') {
    throw new CswRuleViolation('CS-06', '软约束违反提交必须记录影响范围')
  }
}

/** [CS-04] 排程输出（人工或系统建议）不得绕过硬约束：逐码断言（提交侧总闸）。 */
export function assertNoHardConstraintHit(hardHits: readonly string[]): void {
  if (hardHits.length === 0) return
  const labels = hardHits.map((c) => CSW_CONSTRAINT_LABELS[c] ?? c)
  throw new CswRuleViolation(
    'CS-04',
    `排程输出不得绕过硬约束，命中：${labels.join('；')}（先消除硬约束或走对应处置通道）`,
  )
}

// ---------------------------------------------------------------------------
// CS-10 校准约束（新建正数槽位拒绝；已排槽位不自动删除，标记提示）
// ---------------------------------------------------------------------------

/** 校准状态投影行（等价服务 csw_equipment_calibration_state；结果枚举对齐 PE-15 合格/限用/失准）。 */
export interface CalibrationStateView {
  equipmentId: string
  /** 合格 qualified / 限用 limited / 失准 invalid */
  calibrationResult: 'qualified' | 'limited' | 'invalid'
  /** 有效期至（YYYY-MM-DD；null＝未限期） */
  validUntil: string | null
}

export type CalibrationEffect = 'usable' | 'invalid' | 'expired'

/** 判定设备在给定日期的校准有效性（无投影行＝unknown，不触发约束）。 */
export function calibrationEffectAt(
  view: CalibrationStateView | null,
  onDate: string,
): CalibrationEffect | 'unknown' {
  if (view === null) return 'unknown'
  if (view.calibrationResult === 'invalid') return 'invalid'
  if (view.validUntil !== null && view.validUntil < onDate) return 'expired'
  // qualified 且未过期、或 limited（限用为计量范围限制，不构成排产硬拒）→ 可用
  return 'usable'
}

/**
 * [CS-05③/CS-10] 校准过期/失准设备的**新建**正数槽位拒绝（硬约束）；
 * 已有槽位可改正数或改 0 删除（已排不自动删除，仅标记提示——处置 → CA-11 待裁）。
 */
export function assertCalibrationAllowsNewSlot(input: {
  effect: CalibrationEffect | 'unknown'
  equipmentName: string
  existingSlotPlannedQty: string | null
  newPlannedQty: string
}): void {
  assertQtyNonNegative(input.newPlannedQty, '计划产量', 'CS-05')
  if (input.effect === 'usable' || input.effect === 'unknown') return
  if (parseQty(input.newPlannedQty, '计划产量', 'CS-05') <= 0n) return // 删槽不要求校准有效
  if (input.existingSlotPlannedQty !== null) return // 已排槽位可改正数/改 0（标记提示由计划员决定）
  throw new CswRuleViolation(
    'CS-10',
    `设备【${input.equipmentName}】校准${input.effect === 'invalid' ? '失准' : '已过期'}，不可新建正数排产`
      + `（已排槽位不自动删除，请由计划员决定转移或保留）`,
  )
}

/** [CS-10] 校准失效设备的已排槽位标记清单（不删除，仅提示）。 */
export function flagSlotsForCalibration(
  slots: ReadonlyArray<{ id: string; equipmentId: string; productionDate: string }>,
  view: CalibrationStateView | null,
  onDate: string,
): Array<{ slotId: string; effect: CalibrationEffect }> {
  if (view === null) return []
  return slots
    .filter(
      (s) =>
        s.equipmentId === view.equipmentId &&
        (view.calibrationResult === 'invalid' ||
          (view.validUntil !== null && s.productionDate > view.validUntil)) &&
        s.productionDate >= onDate,
    )
    .map((s) => ({
      slotId: s.id,
      effect: view.calibrationResult === 'invalid' ? 'invalid' : 'expired',
    }))
}

// ---------------------------------------------------------------------------
// CS-07 就绪规则（四条件；不能只以"前道出现过一张报工单"判定就绪）
// ---------------------------------------------------------------------------

export type ReadinessCondition = 'prior_operation' | 'material_ready' | 'equipment_available' | 'quality_rule'

export interface ReadinessInput {
  /** 前置工序完成（同订单 seq 更小工序全部完成——完成事实为报工/接收，不是"出现过报工单"） */
  priorOperationsDone: boolean
  /** 未完成的前置工序清单（提示用） */
  pendingPriorOperations: string[]
  /** 物料齐套（CS-08 默认口径判定结果） */
  materialReady: boolean
  materialShortfall: string | null
  /** 设备可用（状态正常＋校准有效＋无全日停机） */
  equipmentAvailable: boolean
  equipmentBlocker: string | null
  /** 质量规则放行（待检/存疑物料不得投产后道） */
  qualityCleared: boolean
  qualityBlocker: string | null
}

export interface ReadinessVerdict {
  ready: boolean
  blockers: Array<{ condition: ReadinessCondition; rule: string; message: string }>
}

/** [CS-07/CS-05⑤] 就绪规则：四条件全满足才 ready；任一不满足即为开工硬约束阻断。 */
export function evaluateReadiness(input: ReadinessInput): ReadinessVerdict {
  const blockers: ReadinessVerdict['blockers'] = []
  if (!input.priorOperationsDone) {
    blockers.push({
      condition: 'prior_operation',
      rule: 'CS-07',
      message: `前置工序未完成：${input.pendingPriorOperations.join('、') || '（未知工序）'}`
        + '（完成判定走报工/接收事实，不以出现过报工单充当完成）',
    })
  }
  if (!input.materialReady) {
    blockers.push({
      condition: 'material_ready',
      rule: 'CS-08',
      message: `物料不齐套：可用量（满足质量与预留条件的余额）未覆盖工序计划需求${
        input.materialShortfall !== null ? `，缺口 ${input.materialShortfall}` : ''
      }`,
    })
  }
  if (!input.equipmentAvailable) {
    blockers.push({
      condition: 'equipment_available',
      rule: 'CS-07',
      message: `设备不可用：${input.equipmentBlocker ?? '状态/校准/停机阻断'}`,
    })
  }
  if (!input.qualityCleared) {
    blockers.push({
      condition: 'quality_rule',
      rule: 'CS-07',
      message: `质量规则未放行：${input.qualityBlocker ?? '待检/存疑状态阻断'}`,
    })
  }
  return { ready: blockers.length === 0, blockers }
}

/**
 * [CS-08] 物料齐套默认口径：该工序计划需求的可用量（满足质量与预留条件的余额，IT-14 语义）覆盖；
 * "计入在途/预留"扩展口径为配置项（取值 → GAP-E12）。
 */
export function evaluateMaterialSufficiency(input: {
  demandQty: string
  /** 质量 ∧ 预留过滤后的可用余额（默认口径输入） */
  availableQty: string
  /** 扩展口径：计入在途/预留量（默认 false——GAP-E12 现场裁定前不启用） */
  includeReserved?: boolean
  reservedQty?: string
}): { sufficient: boolean; shortfall: string | null; basis: 'default' | 'include_reserved' } {
  assertQtyNonNegative(input.demandQty, '工序计划需求', 'CS-08')
  assertQtyNonNegative(input.availableQty, '可用余额', 'CS-08')
  const basis = input.includeReserved === true ? 'include_reserved' : 'default'
  const pool =
    basis === 'include_reserved' ? addQty(input.availableQty, input.reservedQty ?? '0') : input.availableQty
  if (cmpQty(pool, input.demandQty) >= 0) return { sufficient: true, shortfall: null, basis }
  return { sufficient: false, shortfall: subQty(input.demandQty, pool, 'CS-08'), basis }
}

// ---------------------------------------------------------------------------
// CS-09 维护约束（停机占用设备可用能力；维修关闭触发计划评估提示）
// ---------------------------------------------------------------------------

/** 停机占用行（等价服务 csw_equipment_downtime；T19 downtime_event 落地后由 L0 收编数据源）。 */
export interface DowntimeWindow {
  equipmentId: string
  /** ISO 日期（YYYY-MM-DD）或日期时间（YYYY-MM-DDThh:mm:ss(.sss)Z）；date-only＝整日 */
  from: string
  to: string
  kind: 'planned_maintenance' | 'repair' | 'other'
}

const DAY_MS = 86_400_000

/** 停机窗口起止毫秒（date-only 视为整日 [00:00, 次日00:00)）。 */
function windowRange(w: DowntimeWindow): { start: number; end: number } {
  const dayOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)
  const start = dayOnly(w.from) ? Date.parse(`${w.from}T00:00:00Z`) : Date.parse(w.from)
  const end = dayOnly(w.to) ? Date.parse(`${w.to}T00:00:00Z`) + DAY_MS : Date.parse(w.to)
  return { start, end }
}

/**
 * [CS-09] 停机对某生产日的占用比例（0..1）：计划保养与已发生维护停机占用设备可用能力。
 * 与生产日 [00:00, 24:00) 相交时长占比；全日停机＝1。
 */
export function downtimeOccupancyFraction(
  downtime: DowntimeWindow,
  productionDate: string,
): number {
  if (!isValidProductionDate(productionDate)) return 0
  const { start, end } = windowRange(downtime)
  const dayStart = Date.parse(`${productionDate}T00:00:00Z`)
  const dayEnd = dayStart + DAY_MS
  const overlap = Math.min(end, dayEnd) - Math.max(start, dayStart)
  if (overlap <= 0) return 0
  return Math.min(1, overlap / DAY_MS)
}

/** [CS-09] 给定日期设备有效产能：配置产能 ×（1－停机占用比例）；产能未配置返回 null（不参与比较）。 */
export function effectiveCapacityForDate(input: {
  capacity: string | null
  downtimeFraction: number
}): string | null {
  if (input.capacity === null || input.capacity === undefined) return null
  assertQtyNonNegative(input.capacity, '设备日产能', 'CS-09')
  if (input.downtimeFraction <= 0) return input.capacity
  const scaled = parseQty(input.capacity, '设备日产能', 'CS-09')
  const kept = BigInt(Math.round(Number(scaled) * (1 - Math.min(1, input.downtimeFraction))))
  return formatQty(kept < 0n ? 0n : kept)
}

/** [CS-09] 停机窗口是否与给定日期区间相交（维修关闭触发受影响排程计划评估的圈定口径）。 */
export function downtimeTouchesRange(
  downtime: DowntimeWindow,
  range: { from: string; to: string },
): boolean {
  const { start, end } = windowRange(downtime)
  const rStart = Date.parse(`${range.from}T00:00:00Z`)
  const rEnd = Date.parse(`${range.to}T00:00:00Z`) + DAY_MS
  return start < rEnd && rStart < end || dateRangesOverlap(
    { from: downtime.from.slice(0, 10), to: downtime.to.slice(0, 10) },
    range,
  )
}

// ---------------------------------------------------------------------------
// CS-25 外协占用（外协期间该订单工序本厂设备不排产）
// ---------------------------------------------------------------------------

/**
 * [CS-25] 外协占用判定：外协任务处于占用状态（待发送→检验期间）时，挂接订单工序
 * 不得新建本厂设备正数槽位（占用表达为外协占用约束；草稿不占用，关闭/收回/退回处置后释放）。
 */
export function isOutsourcingOccupationActive(taskStatus: string): boolean {
  return taskStatus === 'pending_send' || taskStatus === 'sent' || taskStatus === 'return_received' || taskStatus === 'inspecting'
}

export function assertOperationNotOutsourced(input: {
  occupationActive: boolean
  taskNo: string
  newPlannedQty: string
}): void {
  assertQtyNonNegative(input.newPlannedQty, '计划产量', 'CS-25')
  if (!input.occupationActive) return
  if (parseQty(input.newPlannedQty, '计划产量', 'CS-25') <= 0n) return
  throw new CswRuleViolation(
    'CS-25',
    `订单工序已挂接外协任务 ${input.taskNo}（外协期间本厂设备不排产，占用表达为外协占用约束；回厂检验通过后完成判定走报工/接收事实）`,
  )
}

/** [CS-22 系] 外协数量守恒：发送量 ≥ 已回厂量（回厂不得超发）。 */
export function assertReturnWithinSent(input: { sentQty: string; returnedQty: string }): void {
  assertQtyPositive(input.sentQty, '外协发送量', 'CS-S4')
  assertQtyNonNegative(input.returnedQty, '外协回厂量', 'CS-S4')
  if (cmpQty(input.returnedQty, input.sentQty) > 0) {
    throw new CswRuleViolation(
      'CS-S4',
      `外协回厂量 ${input.returnedQty} 超过发送量 ${input.sentQty}（回厂不得超发，状态迁移与库存交接同事务）`,
    )
  }
}
