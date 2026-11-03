import { DECIMAL_STRING_REGEX, type DecimalString } from '@cadenza/contracts'
import { SchedulingRuleViolation } from './errors'

/**
 * scheduling 域排产槽位纯规则（T09）——规则来源为咨询底稿
 * architecture/contracts/prep/p1/03-production-chain-rules-T05T09T10T11.md 的 A3 节。
 *
 * 本目录自包含（根 eslint 边界规则限定 domain 包内文件只允许 './' 与 '@cadenza/contracts'）：
 * - 数量定点算术不复用 process/inventory 的工具（跨目录 '../..' 被禁），本文件内自实现同口径
 *   （DecimalString、scale=4 BigInt、半入）；
 * - 设备状态字典镜像 masterdata MD-13（1=正常 2=维修），常量值同源不耦合。
 */

/** 账面固定小数位（全仓约定，OA 系/底稿 A2 同口径）。 */
const QTY_SCALE = 4
const SCALE_FACTOR = 10n ** BigInt(QTY_SCALE)
/** [底稿 A3 / ES §2.1] 排产数量上限：10 位整数 + 4 位小数。 */
export const SCHEDULE_QTY_MAX_INT_DIGITS = 10
const MAX_SCALED = 10n ** BigInt(SCHEDULE_QTY_MAX_INT_DIGITS + QTY_SCALE) - 1n

/** 解析为 scale=4 定点 BigInt；非法输入抛 A3 违例（自包含口径，非负数域）。 */
function toScaled(value: string, field: string): bigint {
  if (typeof value !== 'string' || !DECIMAL_STRING_REGEX.test(value)) {
    throw new SchedulingRuleViolation(
      'A3-2',
      `${field} 必须是十进制定点字符串（≤${QTY_SCALE} 位小数，禁 number/科学计数法）：${String(value)}`,
    )
  }
  const negative = value.startsWith('-')
  const body = negative ? value.slice(1) : value
  const [intPart, fracPart = ''] = body.split('.')
  if (intPart.length > SCHEDULE_QTY_MAX_INT_DIGITS) {
    throw new SchedulingRuleViolation(
      'A3-2',
      `${field} 整数部分不得超过 ${SCHEDULE_QTY_MAX_INT_DIGITS} 位：${value}`,
    )
  }
  const fracPadded = (fracPart + '0'.repeat(QTY_SCALE)).slice(0, QTY_SCALE)
  const scaled = BigInt(intPart + fracPadded)
  if (scaled > MAX_SCALED) {
    throw new SchedulingRuleViolation('A3-2', `${field} 超出 numeric(14,4) 范围：${value}`)
  }
  return negative ? -scaled : scaled
}

/** 定点 BigInt → 十进制字符串（scale=4 后去尾零：与全仓 numeric 出参 dec() 口径一致）。 */
function formatScaled(scaled: bigint): string {
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const intPart = abs / SCALE_FACTOR
  const fracPart = (abs % SCALE_FACTOR).toString().padStart(QTY_SCALE, '0')
  const text = `${negative ? '-' : ''}${intPart}.${fracPart}`
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** 多个计划数量求和（scale=4 精确；空数组得 0.0000；批量保存/设备日累计用）。 */
export function sumPlannedQty(values: readonly string[], field = '计划产量合计'): string {
  let total = 0n
  for (const value of values) {
    const scaled = toScaled(value, field)
    if (scaled < 0n) throw new SchedulingRuleViolation('A3-2', `${field} 的输入不得为负：${value}`)
    total += scaled
  }
  return formatScaled(total)
}

// ---------------------------------------------------------------------------
// 基础口径校验
// ---------------------------------------------------------------------------

/** [底稿 A3-2 / ES §2.1] 排产计划数量：≥0、≤4 位小数、≤10 位整数（0=删槽语义，由 planSlotSave 消解）。 */
export function assertPlannedQtyValid(plannedQty: string, field = '计划产量'): void {
  const scaled = toScaled(plannedQty, field)
  if (scaled < 0n) {
    throw new SchedulingRuleViolation('A3-2', `${field} 不得为负：${plannedQty}`)
  }
}

/** [底稿 A3-2w] 设备日产能配置值：≥0（含 0=已配置零产能）、≤4 位小数、≤10 位整数；未配置以 null 表达。 */
export function assertCapacityValueValid(capacity: string, field = '设备日产能'): void {
  const scaled = toScaled(capacity, field)
  if (scaled < 0n) {
    throw new SchedulingRuleViolation('A3-2w', `${field} 不得为负：${capacity}`)
  }
}

/** [底稿 A3-1] 生产日期：YYYY-MM-DD 且为真实日历日（跨日/看板列/班次日期同口径）。 */
export function isValidProductionDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const [y, m, d] = date.split('-').map((p) => Number(p))
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const utc = new Date(Date.UTC(y, m - 1, d))
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d
}

export function assertProductionDateValid(productionDate: string): void {
  if (!isValidProductionDate(productionDate)) {
    throw new SchedulingRuleViolation('A3-1', `生产日期必须为 YYYY-MM-DD 且为真实日历日：${productionDate}`)
  }
}

/** 日期串 +1 天 / -1 天（UTC 日期算术，纯字符串口径，避免本地时区偏移）。 */
export function shiftDate(date: string, days: 1 | -1): string {
  const [y, m, d] = date.split('-').map((p) => Number(p))
  const utc = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000)
  return utc.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// [底稿 A3-1] 槽位唯一键与替换/删槽语义
// ---------------------------------------------------------------------------

/**
 * [底稿 A3-1] 槽位唯一键：同订单 + 同订单工序 + 同标准工序 + 同设备 + 同生产日期
 * 至多一条有效排产（OS §1.1/§2.2、ES §1.1）。
 */
export interface SlotIdentityKey {
  orderId: string
  orderOperationId: string
  operationDefinitionId: string
  equipmentId: string
  productionDate: string
}

export function sameSlotIdentity(a: SlotIdentityKey, b: SlotIdentityKey): boolean {
  return (
    a.orderId === b.orderId &&
    a.orderOperationId === b.orderOperationId &&
    a.operationDefinitionId === b.operationDefinitionId &&
    a.equipmentId === b.equipmentId &&
    a.productionDate === b.productionDate
  )
}

/** 槽位保存决策（保存能力三入口共用：订单排程详情矩阵 / 设备看板 / 订单「设备排产」弹窗）。 */
export type SlotSaveAction =
  | { kind: 'noop' }
  | { kind: 'delete'; identity: SlotIdentityKey }
  | { kind: 'upsert'; identity: SlotIdentityKey; plannedQty: DecimalString }

/**
 * [底稿 A3-1] 计划量改 0 保存 = 删槽（不弹超产能确认）；正数 = 同键替换（本槽按替换旧值计）；
 * 目标态同键至多一条有效行，重复保存走替换而非新增（唯一键冲突由库层 UNIQUE 双保险拦截）。
 */
export function planSlotSave(input: {
  identity: SlotIdentityKey
  plannedQty: string
  /** 现有同键槽位（无则 null） */
  existingSlot: { plannedQty: string } | null
}): SlotSaveAction {
  assertProductionDateValid(input.identity.productionDate)
  assertPlannedQtyValid(input.plannedQty)
  if (toScaled(input.plannedQty, '计划产量') === 0n) {
    return input.existingSlot === null
      ? { kind: 'noop' }
      : { kind: 'delete', identity: input.identity }
  }
  return { kind: 'upsert', identity: input.identity, plannedQty: input.plannedQty as DecimalString }
}

// ---------------------------------------------------------------------------
// [底稿 A3-2] 硬校验：工序计划合计 ≤ 下线数量（服务端强校验）
// ---------------------------------------------------------------------------

/**
 * [底稿 A3-2] 工序计划合计（本槽按替换旧值计）：其它槽位合计 + 本槽新值
 * （旧值被替换不再计入；批量保存时批内同工序行先合并为「新值集合」再入合计）。
 */
export function sumOperationPlannedQty(input: {
  otherSlotsPlannedQty: string
  currentSlotNewQty: string
}): string {
  return sumPlannedQty([input.otherSlotsPlannedQty, input.currentSlotNewQty], '工序计划合计')
}

/**
 * [底稿 A3-2 / S10 裁定] 硬校验：该订单工序下全部槽位计划合计（本槽替换旧值后）
 * 不得超过该工序下线数量；超则禁止保存，且不进入超产能确认（422 强拒，confirm 不豁免）。
 */
export function assertOperationPlannedQtyWithinOffline(input: {
  offlineQty: string
  plannedTotal: string
  operationLabel?: string
}): void {
  const offline = toScaled(input.offlineQty, '工序下线数量')
  const total = toScaled(input.plannedTotal, '工序计划合计')
  if (offline < 0n) {
    throw new SchedulingRuleViolation('A3-2', `工序下线数量不得为负：${input.offlineQty}`)
  }
  if (total > offline) {
    throw new SchedulingRuleViolation(
      'A3-2',
      `${input.operationLabel ?? '该工序'}计划合计 ${input.plannedTotal} 超过下线数量 ${input.offlineQty}（本槽按替换旧值计），禁止保存`,
    )
  }
}

// ---------------------------------------------------------------------------
// [底稿 A3-2w / B11 / S10 裁定] 弱提醒：超设备日产能二次确认可过
// ---------------------------------------------------------------------------

/** 超设备日产能弱提醒（可确认后提交；产能未配置不比较）。 */
export interface CapacityWarning {
  equipmentName: string
  productionDate: string
  /** 当日该设备累计排产（本槽/本批已按替换后计入） */
  plannedTotal: string
  /** 设备日产能（已配置值，含 0） */
  capacity: string
  /** PRD 确认弹窗文案（OS §2.2 / ES §2.1 同文案口径） */
  message: string
}

/**
 * [底稿 A3-2w] 超设备日产能弱提醒：设备已配置日产能（含 0）且当日累计排产（本槽位按替换旧值计）
 * 超过产能时返回 warning（confirm=true 可提交、confirm=false 拒并回 warning 提示）；
 * 产能未配置（null）不参与比较，返回 null（OS §2.2、ES §2.1）。
 * 删槽（计划量改 0）不触发本提醒（planSlotSave 已消解，调用方不评估）。
 */
export function evaluateCapacityWarning(input: {
  equipmentName: string
  productionDate: string
  /** 设备日产能（capacity_calendar 当日行；null=未配置） */
  capacity: string | null
  /** 当日该设备累计排产（其它订单/槽位合计 + 本槽/本批替换后新值） */
  equipmentDayPlannedTotal: string
}): CapacityWarning | null {
  if (input.capacity === null || input.capacity === undefined) return null
  const capacity = toScaled(input.capacity, '设备日产能')
  const total = toScaled(input.equipmentDayPlannedTotal, '当日设备累计排产')
  if (total <= capacity) return null
  return {
    equipmentName: input.equipmentName,
    productionDate: input.productionDate,
    plannedTotal: input.equipmentDayPlannedTotal,
    capacity: input.capacity,
    message: `设备【${input.equipmentName}】${input.productionDate.slice(5).replace('-', '-')} 当天的累计排产 ${input.equipmentDayPlannedTotal}，超过设备产能 ${input.capacity}。确定要继续排产吗？`,
  }
}

/** 弱提醒是否放行：confirm=true 才可提交；未确认视为业务拒绝（可携带 warning 重试）。 */
export function isCapacityOverrunConfirmed(confirm: boolean | undefined): boolean {
  return confirm === true
}

// ---------------------------------------------------------------------------
// [底稿 A3-3] 设备状态约束
// ---------------------------------------------------------------------------

/**
 * 设备状态字典（镜像 masterdata MD-13：1=正常、2=维修；域内自包含，
 * 值同源不耦合——L0 整合时可改为统一常量导出）。
 */
export const SCHEDULE_EQUIPMENT_STATUS = { NORMAL: 1, REPAIR: 2 } as const

export type ScheduleEquipmentStatusValue =
  (typeof SCHEDULE_EQUIPMENT_STATUS)[keyof typeof SCHEDULE_EQUIPMENT_STATUS]

/**
 * [底稿 A3-3 / OS §1.1、ES §1.1] 设备状态约束：
 * - 维修且本槽尚无排产 → 不可新建正数排产（拒绝）；
 * - 已有槽位仍可改正数或改 0 删槽（放行）；
 * - 删槽（计划量 ≤ 0）不要求设备正常（放行）；
 * - 正常设备不限制。
 */
export function assertEquipmentAllowsSlot(input: {
  equipmentStatus: number
  equipmentName: string
  /** 现有同键槽位计划量（无则 null=本槽新建） */
  existingSlotPlannedQty: string | null
  newPlannedQty: string
}): void {
  assertPlannedQtyValid(input.newPlannedQty)
  const newQty = toScaled(input.newPlannedQty, '计划产量')
  if (input.equipmentStatus !== SCHEDULE_EQUIPMENT_STATUS.REPAIR) return
  if (newQty <= 0n) return // 删槽不要求设备正常
  if (input.existingSlotPlannedQty !== null) return // 已有槽位可改正数
  throw new SchedulingRuleViolation(
    'A3-3',
    `设备【${input.equipmentName}】处于维修状态且本槽位尚无排产，不可新建正数排产（已有槽位可改正数或改 0 删除）`,
  )
}

// ---------------------------------------------------------------------------
// [底稿 A3-4] 回写链投影：槽位 → 工序已排/是否排完 → 订单排产状态
// ---------------------------------------------------------------------------

/** 单道工序排产投影（已排数量 = 该工序各槽位计划合计；是否排完 = 合计 ≥ 下线数量）。 */
export interface OperationSchedulingProjection {
  scheduledQty: DecimalString
  fullyScheduled: boolean
}

export function projectOperationScheduling(input: {
  offlineQty: string
  plannedQty: string
}): OperationSchedulingProjection {
  const offline = toScaled(input.offlineQty, '工序下线数量')
  const planned = toScaled(input.plannedQty, '工序已排数量')
  if (offline < 0n || planned < 0n) {
    throw new SchedulingRuleViolation('A3-4', '工序排产投影的输入不得为负')
  }
  return {
    scheduledQty: formatScaled(planned),
    fullyScheduled: planned >= offline,
  }
}

/** [底稿 A3-4 / OS §1.2 字典] 订单排产状态（回写链投影，非落列——slot 表为事实源）。 */
export type OrderSchedulingStatus = 'unplanned' | 'partially_scheduled' | 'fully_scheduled'

export const ORDER_SCHEDULING_STATUS_VALUES: readonly OrderSchedulingStatus[] = [
  'unplanned',
  'partially_scheduled',
  'fully_scheduled',
]

/**
 * [底稿 A3-4] 订单排产状态投影（OS §1.2/§2.2 回写链）：
 * - 未排产：各工序尚无有效已排计划（总合计为 0，含无工序行）；
 * - 已排产：全部工序均已排完（各工序计划合计 ≥ 该工序下线数量）；
 * - 部分排产：其余情形。
 * 下线数量为 0 的工序按 0≥0 视为已排完（PRD 加权口径跳过下线 ≤0 工序，此处同向）。
 */
export function projectOrderSchedulingStatus(
  operations: ReadonlyArray<{ offlineQty: string; plannedQty: string }>,
): OrderSchedulingStatus {
  if (operations.length === 0) return 'unplanned'
  let totalPlanned = 0n
  let allFully = true
  for (const op of operations) {
    const projection = projectOperationScheduling(op)
    totalPlanned += toScaled(projection.scheduledQty, '工序已排数量')
    if (!projection.fullyScheduled) allFully = false
  }
  if (totalPlanned === 0n) return 'unplanned'
  return allFully ? 'fully_scheduled' : 'partially_scheduled'
}

// ---------------------------------------------------------------------------
// [底稿 A3-5] 设备看板日期列与已结束订单排产不展示
// ---------------------------------------------------------------------------

/** 设备看板固定列数：今日起连续 30 天（含今日）。 */
export const DEVICE_BOARD_DAY_WINDOW = 30

/**
 * [底稿 A3-5 / ES §2.1] 看板日期列 = 今日起连续 30 天 ∪ 各行已有排产日期（升序去重；
 * 已有日期中的非法值忽略；30 天窗口外的历史排产日仍保留展示）。
 */
export function computeBoardDates(input: { today: string; existingDates: readonly string[] }): string[] {
  assertProductionDateValid(input.today)
  const dates = new Set<string>()
  let cursor = input.today
  for (let i = 0; i < DEVICE_BOARD_DAY_WINDOW; i += 1) {
    dates.add(cursor)
    cursor = shiftDate(cursor, 1)
  }
  for (const date of input.existingDates) {
    if (isValidProductionDate(date)) dates.add(date)
  }
  return [...dates].sort()
}

/** [底稿 A3-5 / ES §2.1] 已结束订单排产不展示的口径判定（看板/PDA 行过滤输入）。 */
export function isOrderExcludedFromBoard(orderStatus: string): boolean {
  // closed=已结束（PRD 字面）；voided=已作废（[合同新造 NEW-1]：作废订单无生产事实，同口径排除）
  return orderStatus === 'closed' || orderStatus === 'voided'
}

// ---------------------------------------------------------------------------
// [底稿 A3-6] 订单排程详情前置
// ---------------------------------------------------------------------------

/**
 * [底稿 A3-6 / OS §2.1] 订单排程进详情前置：工序设置 = 已配置，且各工序均已配置工作中心；
 * 返回阻塞原因（null=可进详情）。校验失败不产生副作用，由调用方决定阻断形态（UI 留本页）。
 */
export function orderDetailEntryBlocker(input: {
  processConfigStatus: string
  operations: ReadonlyArray<{ workCenterId: string | null }>
}): string | null {
  if (input.processConfigStatus !== 'configured') {
    return '[A3-6] 工序设置未配置，无法进入生产排程详情（须先配置工艺路线）'
  }
  if (input.operations.length === 0) {
    return '[A3-6] 已配置工序但不存在工序行，无法进入生产排程详情'
  }
  const missing = input.operations.some((op) => op.workCenterId === null || op.workCenterId === '')
  if (missing) {
    return '[A3-6] 存在未配置工作中心的工序，无法进入生产排程详情（各工序均须已配置工作中心）'
  }
  return null
}
