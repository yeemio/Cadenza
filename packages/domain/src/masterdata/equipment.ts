import { MasterDataRuleViolation } from './errors'

/**
 * 设备纯规则 —— 对应冻结合同 master-data.md §2：MD-09～MD-16。
 */

/** MD-13：设备状态字典仅 2 值：1=正常、2=维修。 */
export const EQUIPMENT_STATUS = { NORMAL: 1, REPAIR: 2 } as const

export type EquipmentStatusValue = (typeof EQUIPMENT_STATUS)[keyof typeof EQUIPMENT_STATUS]

export const EQUIPMENT_STATUS_VALUES: readonly number[] = [
  EQUIPMENT_STATUS.NORMAL,
  EQUIPMENT_STATUS.REPAIR,
]

/** MD-14：状态变化来源字典（WEB/PDA）。 */
export const EQUIPMENT_STATUS_LOG_SOURCES: readonly string[] = ['WEB', 'PDA']

/** 设备编码长度上限（PRD 设备管理 §2.1：最长 32）。 */
export const EQUIPMENT_CODE_MAX = 32

/** 设备名称长度上限（PRD 设备管理 §2.1：最长 50）。 */
export const EQUIPMENT_NAME_MAX = 50

/**
 * MD-15：设备码固定格式 `EQU-` + 设备编码，前缀仅大写（CA-8 裁定前设备主档侧维持仅大写）。
 */
export const EQUIPMENT_QR_PREFIX = 'EQU-' as const

export function equipmentQrCode(code: string): string {
  return `${EQUIPMENT_QR_PREFIX}${code}`
}

/** MD-15：PDA 扫码按码前 4 位匹配设备码（仅大写 `EQU-`；小写 `equ-` 不匹配，CA-8 待裁）。 */
export function matchesEquipmentQrPrefix(scan: string): boolean {
  return scan.startsWith(EQUIPMENT_QR_PREFIX)
}

/** MD-15：扫码值解出设备业务编码；非设备码返回 null。 */
export function equipmentCodeFromQr(scan: string): string | null {
  if (!matchesEquipmentQrPrefix(scan)) return null
  return scan.slice(EQUIPMENT_QR_PREFIX.length)
}

/** 设备编码字段口径：非空、长度 ≤32，且不得自带前缀（避免落库后拼出 EQU-EQU-）。 */
export function assertEquipmentCodeValid(code: string): void {
  if (code.length === 0 || code.length > EQUIPMENT_CODE_MAX) {
    throw new MasterDataRuleViolation('MD-09', `设备编码必填且最长 ${EQUIPMENT_CODE_MAX} 字符`)
  }
  if (code.toUpperCase().startsWith(EQUIPMENT_QR_PREFIX)) {
    throw new MasterDataRuleViolation('MD-15', '设备编码不得自带 EQU- 前缀（设备码由系统按 EQU-+编码 生成）')
  }
}

/** MD-09：设备名称全局唯一、设备编码全局唯一（active 口径查重输入）。 */
export interface EquipmentUniquenessCandidate {
  id?: string
  code: string
  name: string
}

export function findEquipmentUniquenessConflict(
  candidate: EquipmentUniquenessCandidate,
  existing: ReadonlyArray<{ id: string; code: string; name: string }>,
): { field: 'code' | 'name'; value: string } | null {
  for (const row of existing) {
    if (row.id === candidate.id) continue
    if (row.code === candidate.code) return { field: 'code', value: row.code }
    if (row.name === candidate.name) return { field: 'name', value: row.name }
  }
  return null
}

/** MD-10：设备所属部门必须与其所属工作中心的所属部门一致，不一致拒绝。 */
export function assertEquipmentDeptConsistent(
  equipmentDeptId: string,
  workCenterDeptId: string | null | undefined,
): void {
  if (workCenterDeptId == null) {
    throw new MasterDataRuleViolation('MD-10', '工作中心未配置所属部门，设备无法保存')
  }
  if (equipmentDeptId !== workCenterDeptId) {
    throw new MasterDataRuleViolation('MD-10', '设备所属部门必须与其所属工作中心的所属部门一致')
  }
}

/** MD-11：设备删除前置——未被排产引用且未被报工引用才可删；任一命中拒绝。 */
export interface EquipmentDeleteFacts {
  schedulingRefs: number
  workReportRefs: number
}

export function assertEquipmentRetirable(facts: EquipmentDeleteFacts): void {
  if (facts.schedulingRefs > 0) {
    throw new MasterDataRuleViolation('MD-11', '存在已经排产的设备无法删除')
  }
  if (facts.workReportRefs > 0) {
    throw new MasterDataRuleViolation('MD-11', '存在已经报工的设备无法删除')
  }
}

/**
 * MD-12：被排产引用的设备编辑时，工作中心与所属部门两字段锁定不可改。
 * （排产引用标志由排产域落地后接入；当前调用方按 false 传入并注明预留。）
 */
export function assertEquipmentLockedFieldsEditable(
  facts: { schedulingReferenced: boolean },
  patch: { workCenterId?: string; deptId?: string },
): void {
  if (!facts.schedulingReferenced) return
  if (patch.workCenterId !== undefined || patch.deptId !== undefined) {
    throw new MasterDataRuleViolation(
      'MD-12',
      '设备已被排产引用，工作中心与所属部门不可修改',
    )
  }
}

/** MD-13：设备状态字典校验。 */
export function assertEquipmentStatusValue(value: number): void {
  if (!EQUIPMENT_STATUS_VALUES.includes(value)) {
    throw new MasterDataRuleViolation(
      'MD-13',
      `设备状态字典仅 2 值（1=正常 2=维修），拒绝输入：${value}`,
    )
  }
}

/** MD-14：新值=旧值时不产生状态流水。 */
export function shouldRecordStatusChange(oldStatus: number, newStatus: number): boolean {
  return oldStatus !== newStatus
}

/** MD-14：状态变化记流水的来源校验。 */
export function assertStatusLogSource(source: string): void {
  if (!EQUIPMENT_STATUS_LOG_SOURCES.includes(source)) {
    throw new MasterDataRuleViolation('MD-14', `状态变更来源须为 ${EQUIPMENT_STATUS_LOG_SOURCES.join('/')}`)
  }
}

/**
 * MD-16：设备产能字段口径——10 位整数＋4 位小数、非负、可为空。
 * 标准速率原文为自由文本（GAP-S1 未裁定），排程侧不得使用该字段做计算
 * （本域不提供数值化标准速率规则，裁定后补）。
 */
export function assertCapacityInput(input: string): void {
  const text = input.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new MasterDataRuleViolation('MD-16', `设备产能须为非负数字：${input}`)
  }
  const [intPart, decPart = ''] = text.split('.')
  if (intPart.length > 10) {
    throw new MasterDataRuleViolation('MD-16', `设备产能整数部分不得超过 10 位：${input}`)
  }
  if (decPart.length > 4) {
    throw new MasterDataRuleViolation('MD-16', `设备产能小数部分不得超过 4 位：${input}`)
  }
}
