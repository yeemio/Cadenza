/**
 * 分托（托盘调整）与解绑规则（RS-13～RS-24）——冻结合同
 * architecture/contracts/frozen/p2/rework-split.md §2。
 *
 * 纯规则面：facts 由应用层装配。托盘 = carrier（carrier_kind='tray' 等），
 * 绑定 = carrier_binding；车间判定 = 登录人部门 dept_category=1（OA-03 字典：
 * 1=车间、2=质检部、3=物流部）。锁定落 reservation 表（IT-23 四要素，RS-S4）。
 */
// no-restricted-imports 对 domain 包内子目录场景过宽（同 reverse/reporting/trace 先例）；单行豁免留痕。
// eslint-disable-next-line no-restricted-imports
import { addQty } from '../inventory/quantity'
// eslint-disable-next-line no-restricted-imports
import { DEPT_CATEGORY } from '../org/org-node'
import { ReworkRuleViolation } from './errors'

/** 分托类型（RS-14：同一人同一分托类型同时只能有一条进行中）。 */
export type PalletTaskType = 'split_pallet' | 'unbind_pallet'

export type PalletTaskStatus = 'in_progress' | 'completed' | 'abandoned'

/** RS-13：登录人所属部门类别=车间（dept_category=1）视为车间人员。 */
export function isWorkshopOperator(deptCategory: number | null | undefined): boolean {
  return deptCategory === DEPT_CATEGORY.WORKSHOP
}

/** 分托/解绑操作人事实。 */
export interface PalletOperatorFacts {
  loginName: string
  deptCategory: number | null
}

/** 扫料品码事实（RS-16/RS-22 拒绝清单由装配方折叠）。 */
export interface PalletScanFacts {
  unitNo: string
  /** 码存在 */
  exists: boolean
  /** 父码（托码） */
  isPalletCode: boolean
  /** 一码多物 */
  multiMaterial: boolean
  /** 在库（stock_balance active；RS-13 ①非车间扫的码必须在库） */
  inStock: boolean
  /** 在仓库（非线边仓，warehouse_type='WAREHOUSE'；RS-13 ①车间人员的码不得在仓库） */
  inWarehouse: boolean
  /** 当前绑定托盘 carrier_id（RS-22：未绑定托盘拒绝；RS-15 老托判定） */
  boundCarrierId: string | null
  boundCarrierCode: string | null
  /** 所在仓库（与已扫码/分入托一致性校验用） */
  warehouseId: string | null
  /** 已被其它业务锁定（非本次分托/解绑任务的活动 reservation） */
  lockedByOther: boolean
  /** 本次任务已扫过 */
  scannedInTask: boolean
  /** 与本次已扫料品码同仓库 */
  sameWarehouseAsScanned: boolean
  /** 与分入托码同仓库（分托） */
  sameWarehouseAsTargetCarrier: boolean
  /** 当前仓库已锁定（如盘点中） */
  warehouseLocked: boolean
}

/**
 * RS-13 ①可扫范围（服务端执行，非仅前端）：
 * 非车间人员扫的托码/料品码必须在库；车间人员的码不得在仓库（非线边仓）。
 */
export function assertPalletScanScope(operator: PalletOperatorFacts, facts: PalletScanFacts): void {
  if (isWorkshopOperator(operator.deptCategory)) {
    if (facts.inWarehouse) {
      throw new ReworkRuleViolation('RS-13', '车间人员扫的码不得在仓库（非线边仓）')
    }
  } else {
    if (!facts.inStock) {
      throw new ReworkRuleViolation('RS-13', '非车间人员扫的托码/料品码必须在库')
    }
  }
}

/**
 * RS-16 分托扫料品码拒绝清单（任一命中拒绝；在 RS-13 范围之外叠加）。
 */
export function assertPalletSplitScanAcceptable(operator: PalletOperatorFacts, facts: PalletScanFacts): void {
  if (!facts.exists) {
    throw new ReworkRuleViolation('RS-16', '码不存在')
  }
  if (facts.isPalletCode) {
    throw new ReworkRuleViolation('RS-16', '该码为父码（托码），请扫单品码')
  }
  if (facts.multiMaterial) {
    throw new ReworkRuleViolation('RS-16', '一码多物，不能扫码装入')
  }
  assertPalletScanScope(operator, facts)
  if (facts.scannedInTask) {
    throw new ReworkRuleViolation('RS-16', '该码本次已扫过')
  }
  if (!facts.sameWarehouseAsScanned) {
    throw new ReworkRuleViolation('RS-16', '该码与已扫料品码不在同一仓库')
  }
  if (!facts.sameWarehouseAsTargetCarrier) {
    throw new ReworkRuleViolation('RS-16', '该码与分入托码不在同一仓库')
  }
  if (facts.lockedByOther) {
    throw new ReworkRuleViolation('RS-16', '该码已被其它业务锁定')
  }
  if (facts.warehouseLocked) {
    throw new ReworkRuleViolation('RS-16', '当前仓库已锁定（如盘点中），不能扫码')
  }
}

/**
 * RS-22 解绑前置拒绝清单（任一命中拒绝）：解绑不需要托码与库位，
 * 车间/非车间校验相同（除 RS-13 范围分叉保留在服务端语义内）。
 */
export function assertPalletUnbindScanAcceptable(operator: PalletOperatorFacts, facts: PalletScanFacts): void {
  if (!facts.exists) {
    throw new ReworkRuleViolation('RS-22', '码不存在')
  }
  if (facts.isPalletCode) {
    throw new ReworkRuleViolation('RS-22', '该码为父码（托码），不能解绑')
  }
  if (facts.multiMaterial) {
    throw new ReworkRuleViolation('RS-22', '一码多物，不能解绑')
  }
  assertPalletScanScope(operator, facts)
  if (facts.boundCarrierId === null) {
    throw new ReworkRuleViolation('RS-22', '该码未绑定托盘，不能解绑')
  }
  if (facts.scannedInTask) {
    throw new ReworkRuleViolation('RS-22', '该码本次已扫过')
  }
  if (!facts.sameWarehouseAsScanned) {
    throw new ReworkRuleViolation('RS-22', '该码与已扫料品码不在同一仓库')
  }
  if (facts.lockedByOther) {
    throw new ReworkRuleViolation('RS-22', '该码已被其它业务锁定')
  }
}

/** 分托任务单据事实（RS-S3：pallet_task 表对应）。 */
export interface PalletTaskFacts {
  taskType: PalletTaskType
  status: PalletTaskStatus
  operator: string
  /** 分入托码（解绑任务为 null） */
  targetCarrierId: string | null
  targetCarrierCode: string | null
  /** 非车间已选库位（车间为 null） */
  warehouseId: string | null
  rackId: string | null
  locationId: string | null
  locationCode: string | null
}

/**
 * RS-15 新托/老托判定：系统中无任何料品码绑定过的托码 = 新托（非车间须手选库位或
 * 扫货架码后选层数）；已有绑定 = 老托（库位、仓库自动带出原托位置且不可改）。
 */
export function judgePalletNewOrOld(everBound: boolean): 'new' | 'old' {
  return everBound ? 'old' : 'new'
}

/** RS-15：老托不可赋值不同库位（选库位入口不可用；扫货架码选层提示原托已经入库）。 */
export function assertOldPalletLocationImmutable(
  palletKind: 'new' | 'old',
  newLocationId: string | null,
  originalLocationId: string | null,
): void {
  if (palletKind === 'old' && newLocationId !== null && newLocationId !== originalLocationId) {
    throw new ReworkRuleViolation('RS-15', '原托已经入库，不可以赋值不同的库位')
  }
}

/**
 * RS-13 ②托盘调整确认前：非车间必须已选库位（车间不需要）。
 */
export function assertPalletConfirmLocation(operator: PalletOperatorFacts, task: PalletTaskFacts): void {
  if (!isWorkshopOperator(operator.deptCategory)) {
    if (task.locationId === null || task.warehouseId === null) {
      throw new ReworkRuleViolation('RS-13', '非车间人员确认前必须已选库位（且已带出仓库）')
    }
  }
}

/**
 * RS-19 确认可执行条件（按序校验）：已扫码开始本次调整 → 至少一个料品码 →
 * 非车间已选库位且已带出仓库且仓库未锁定 → 已扫分入托码。
 * RS-22（解绑）：解绑不需要托码与库位，车间/非车间校验相同——库位/仓库前置仅对
 * 分托任务生效（O-1 修复，2026-10-29：原对 unbind 同样要求已选库位，而选库位命令
 * 只服务分托任务，非车间解绑确认恒拒——RS-22 明文免托码与库位）。
 */
export function assertPalletConfirmable(input: {
  operator: PalletOperatorFacts
  task: PalletTaskFacts
  scannedCount: number
  warehouseLocked: boolean
}): void {
  if (input.task.status !== 'in_progress') {
    throw new ReworkRuleViolation('RS-19', '本次调整尚未扫码开始（无进行中单据）')
  }
  if (input.scannedCount < 1) {
    throw new ReworkRuleViolation('RS-19', '至少扫描一个料品码后方可确认')
  }
  if (input.task.taskType === 'split_pallet' && !isWorkshopOperator(input.operator.deptCategory)) {
    if (input.task.locationId === null) {
      throw new ReworkRuleViolation('RS-19', '非车间人员必须已选库位')
    }
    if (input.task.warehouseId === null) {
      throw new ReworkRuleViolation('RS-19', '非车间人员必须已带出仓库')
    }
    if (input.warehouseLocked) {
      throw new ReworkRuleViolation('RS-19', '目标仓库已锁定（如盘点中），不能确认')
    }
  }
  if (input.task.taskType === 'split_pallet' && input.task.targetCarrierId === null) {
    throw new ReworkRuleViolation('RS-19', '分托确认前必须已扫分入托码')
  }
}

/** RS-17：已确认完成的单不允许再删码。 */
export function assertPalletLineRemovable(taskStatus: PalletTaskStatus): void {
  if (taskStatus !== 'in_progress') {
    throw new ReworkRuleViolation('RS-17', '已确认完成的单不允许再删码')
  }
}

/**
 * RS-21 放弃语义（分托）：已扫分入托码但一个料品码都没扫（或已全部删掉）时点返回
 * = 放弃本次调整（解除全部已扫码锁定、删除进行中记录）；其它情况返回直接回主页、
 * 进行中数据保留。RS-23：解绑页返回不放弃进行中数据（即使一个码都没扫也不放弃）。
 */
export function isPalletAbandonOnLeave(
  taskType: PalletTaskType,
  hasTargetCarrier: boolean,
  scannedCount: number,
): boolean {
  if (taskType === 'unbind_pallet') return false
  return hasTargetCarrier && scannedCount === 0
}

/**
 * RS-18 长作业预留：到期未完成自动释放并留释放记录；旧终端过期后提交必须重新校验，
 * 冲突拒绝并提示重扫（A11）。有效期默认 8 小时（CA-5 建议，待裁；GAP-D10）。
 */
export const PALLET_RESERVATION_DEFAULT_HOURS = 8

/** RS-18：校验预留仍有效（提交时点重校验；过期即拒绝并提示重扫）。 */
export function assertPalletReservationUsable(validUntil: string, now: string): void {
  if (new Date(validUntil).getTime() <= new Date(now).getTime()) {
    throw new ReworkRuleViolation(
      'RS-18',
      '该码的作业预留已过期（到期自动释放），请重新扫码后再提交',
    )
  }
}

/** RS-24 导出行（导出那一刻绑定在托码上的全部料品码）。 */
export interface PalletExportRow {
  carrierCode: string
  productAxisNo: string | null
  materialCode: string
  quantity: string
}

/**
 * RS-24 分托导出合并：同一托码下同产品轴号同料品合并一行、数量相加
 * （非历史快照：按导出那一刻的绑定取数）。
 */
export function mergePalletExportRows(rows: readonly PalletExportRow[]): PalletExportRow[] {
  const keyOf = (r: PalletExportRow) => `${r.carrierCode}||${r.productAxisNo ?? ''}||${r.materialCode}`
  const merged = new Map<string, PalletExportRow>()
  for (const row of rows) {
    const key = keyOf(row)
    const existing = merged.get(key)
    if (existing === undefined) {
      merged.set(key, { ...row })
      continue
    }
    existing.quantity = addQty(existing.quantity, row.quantity)
  }
  return [...merged.values()]
}

/**
 * RS-13 ③确认后改动：非车间改托码＋仓库＋货架＋库位，车间只改托码。
 * 返回确认执行后的位置改动计划（应用层按此落 stock_balance 移库与 carrier_binding）。
 */
export function planPalletConfirmChanges(input: {
  operator: PalletOperatorFacts
  task: PalletTaskFacts
}): { moveLocation: boolean; targetLocationId: string | null; targetWarehouseId: string | null } {
  const workshop = isWorkshopOperator(input.operator.deptCategory)
  if (workshop) {
    // 车间只改托码：仓库/货架/库位不动
    return { moveLocation: false, targetLocationId: null, targetWarehouseId: null }
  }
  return {
    moveLocation: input.task.locationId !== null,
    targetLocationId: input.task.locationId,
    targetWarehouseId: input.task.warehouseId,
  }
}
