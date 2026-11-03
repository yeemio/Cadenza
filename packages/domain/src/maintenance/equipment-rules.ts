import { MaintenanceRuleViolation } from './errors'

/**
 * 设备档案状态与开工规则（MT-01～MT-06，原三文明文部分）。
 *
 * 设备台账主数据归 T04（MD-09～MD-16 已冻结），本域不重建档案；本文件只承载
 * maintenance 合同冻结的守卫：状态字典（MT-01/MD-13）、状态流水判定（MT-02/MD-14）、
 * 异常上报提交守卫与设备码识别（MT-03/MT-04/CA-8）、设备开工可执行与幂等业务日
 * （MT-05/MT-06/IT-37）。
 */

// ---------------- MT-01：设备状态字典仅 2 值（MD-13 已冻结） ----------------

/** 设备状态字典（MT-01）：1=正常、2=维修；扩展状态值表达（点检不合格/待复机等）→ GAP-F23 待裁。 */
export const EQUIPMENT_STATUS = {
  NORMAL: 1,
  REPAIR: 2,
} as const

export type EquipmentStatusValue = 1 | 2

export const EQUIPMENT_STATUS_VALUES: readonly EquipmentStatusValue[] = [1, 2]

export const EQUIPMENT_STATUS_LABELS: Readonly<Record<EquipmentStatusValue, string>> = {
  1: '正常',
  2: '维修',
}

/** MT-01：超出 2 值的输入拒绝（1=正常、2=维修）。 */
export function assertEquipmentStatusValue(status: unknown): EquipmentStatusValue {
  if (status !== 1 && status !== 2) {
    throw new MaintenanceRuleViolation(
      'MT-01',
      `设备状态字典仅 2 值（1=正常、2=维修），非法状态输入：${String(status)}`,
    )
  }
  return status
}

// ---------------- MT-02：状态变更流水判定（MD-14；本域补充 PDA 来源） ----------------

/** 状态流水来源（MT-02）：1=WEB、2=PDA（库列 source IN ('WEB','PDA')）。 */
export type EquipmentStatusSource = 'WEB' | 'PDA'

export const EQUIPMENT_STATUS_SOURCES: readonly EquipmentStatusSource[] = ['WEB', 'PDA']

/** 一条待落库的状态流水（前值/后值/操作人/时间/来源，MD-14）。 */
export interface EquipmentStatusLogEntry {
  equipmentId: string
  oldStatus: EquipmentStatusValue
  newStatus: EquipmentStatusValue
  source: EquipmentStatusSource
  actor: string
  occurredAt: string
}

/**
 * MT-02：状态变化判定——新值=旧值时不产生流水（返回 null，命令仍算成功）；
 * 状态变化则返回流水条目（由调用方 append-only 落库，库层触发器禁改删）。
 */
export function buildStatusLogEntry(input: {
  equipmentId: string
  oldStatus: EquipmentStatusValue
  newStatus: EquipmentStatusValue
  source: EquipmentStatusSource
  actor: string
  occurredAt: string
}): EquipmentStatusLogEntry | null {
  if (input.oldStatus === input.newStatus) return null
  return { ...input }
}

/** MT-02：来源字典守卫（WEB/PDA）。 */
export function assertEquipmentStatusSource(source: unknown): EquipmentStatusSource {
  if (source !== 'WEB' && source !== 'PDA') {
    throw new MaintenanceRuleViolation(
      'MT-02',
      `状态流水来源仅 2 值（WEB/PDA），非法来源：${String(source)}`,
    )
  }
  return source
}

// ---------------- MT-03：异常上报命令守卫（PDA；与 Web 行内改状态同一服务端守卫 PC-08/10） ----------------

/**
 * MT-03：异常上报可提交判定——未扫到有效设备（无设备主键）或未选状态不可提交。
 * 状态相同仍算成功但不记变更（buildStatusLogEntry 返回 null 路径）。
 */
export function assertAnomalyReportSubmittable(input: {
  equipmentId: string | null
  targetStatus: unknown
}): void {
  if (input.equipmentId === null || input.equipmentId === '') {
    throw new MaintenanceRuleViolation('MT-03', '未扫到有效设备（无设备主键），不可提交异常上报')
  }
  if (input.targetStatus === undefined || input.targetStatus === null) {
    throw new MaintenanceRuleViolation('MT-03', '未选择目标状态，不可提交异常上报')
  }
  assertEquipmentStatusValue(input.targetStatus)
}

// ---------------- MT-04：设备码识别（生成严格、识别宽容；CA-8 待裁） ----------------

/**
 * MT-04/CA-8：设备码识别宽容——异常上报入口码可带 `EQU-`/`equ-` 前缀（大小写归一剥离后
 * 按设备编码匹配）；设备主档生成侧维持仅大写（MD-15，T04 域，不属于本域）。
 * 裁定前异常上报侧维持原文宽容行为。
 */
export function normalizeScannedEquipmentCode(raw: string): string {
  return raw.replace(/^equ-/i, '')
}

/** MT-03/MT-04：扫码头解析——剥离前缀后为空视为未扫到有效设备。 */
export function resolveScannedEquipmentCode(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new MaintenanceRuleViolation('MT-03', '未扫到有效设备（扫码内容为空），不可提交异常上报')
  }
  const code = normalizeScannedEquipmentCode(raw.trim())
  if (code === '') {
    throw new MaintenanceRuleViolation('MT-03', '扫码内容剥离前缀后为空，不可提交异常上报')
  }
  return code
}

// ---------------- MT-05：设备开工可执行（PDA） ----------------

/** 开工可执行判定的设备只读视图（T04 档案：状态 1/2＋档案状态 active/retired）。 */
export interface StartWorkEquipmentView {
  id: string
  equipmentStatus: number
  status: string
}

/** MT-05：可执行 = 设备存在且状态=正常（非正常拒绝；退役设备同样拒绝）。 */
export function assertStartWorkExecutable(equipment: StartWorkEquipmentView | null): void {
  if (equipment === null) {
    throw new MaintenanceRuleViolation('MT-05', '设备不存在，不可开工')
  }
  if (equipment.status !== 'active') {
    throw new MaintenanceRuleViolation('MT-05', `设备已退役（status=${equipment.status}），不可开工`)
  }
  if (equipment.equipmentStatus !== EQUIPMENT_STATUS.NORMAL) {
    throw new MaintenanceRuleViolation(
      'MT-05',
      `设备状态非正常（当前=${EQUIPMENT_STATUS_LABELS[equipment.equipmentStatus as 1 | 2] ?? equipment.equipmentStatus}），不可开工`,
    )
  }
}

// ---------------- MT-06：开工幂等业务日（[合同新造]；IT-37 班次规则，GAP-A3 待裁） ----------------

/**
 * 业务日参数（GAP-A3 班次细则未裁：默认 UTC+8、零点白班起点——与库存/排程域同源口径；
 * domain 包内禁止跨子目录相对导入（lint 规则），本域内联同口径实现，同 scheduling/inventory 先例）。
 */
const BUSINESS_DAY_UTC_OFFSET_HOURS = 8

/**
 * MT-06：开工业务日按工厂日历＋班次规则计算（IT-37），不按自然日硬编码——
 * 以工厂本地时区折算班次日（白班起点前小时归前一班次日；细则 GAP-A3 裁定后统一升级）。
 */
export function computeStartWorkBusinessDate(startedAtIso: string): string {
  const ms = Date.parse(startedAtIso)
  if (Number.isNaN(ms)) {
    throw new MaintenanceRuleViolation('IT-37', `开工/执行时间非法（ISO-8601）：${startedAtIso}`)
  }
  const localMs = ms + BUSINESS_DAY_UTC_OFFSET_HOURS * 3_600_000
  const localDate = new Date(localMs)
  const hours = localDate.getUTCHours()
  let shiftMs = localMs - hours * 3_600_000
  if (hours < 0) shiftMs -= 86_400_000
  return new Date(shiftMs).toISOString().slice(0, 10)
}
