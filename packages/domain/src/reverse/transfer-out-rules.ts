// 包内上级目录相对导入（domain/src/reverse → domain/src/inventory）：未逃逸出 domain 包，
// 边界规则对包内子目录场景过宽（同 reporting/metric-rules.ts、trace/genealogy.ts 先例）；单行豁免留痕。
// eslint-disable-next-line no-restricted-imports
import { cmpQty } from '../inventory/quantity'
import { ReverseRuleViolation } from './errors'

/**
 * 调拨出库 P2 补全纯规则 —— 冻结合同 frozen/p2/warehouse-reverse.md §2（WR-06～WR-13；
 * 原件 调拨出库/调拨出库.md）。P1 A-T13-5/6/8/9/10/11 已建调拨主链状态机与两段原子步；
 * 本规则族冻结 P2 补全：无任务调拨（PDA 自动建单）、Web 有任务全流程（编辑/删除/扫码/完成）、
 * 仓库类型规则双点校验、CA-7 裁定前整码调出。
 */

/** 调出侧状态三值（WR-13：原文调出状态三值为调出侧投影，映射 DM 状态机前四段）。 */
export const TRANSFER_OUT_STATUSES = ['pending_out', 'outbounding', 'outbounded', 'cancelled'] as const
export type TransferOutStatus = (typeof TRANSFER_OUT_STATUSES)[number]

export const TRANSFER_OUT_STATUS_LABELS: Readonly<Record<TransferOutStatus, string>> = {
  pending_out: '待出库',
  outbounding: '出库中',
  outbounded: '已出库',
  cancelled: '已取消',
}

/** WR-13：调出状态机步进（待出库→出库中→已出库；删码删空回 待出库；取消自 待出库）。 */
export function assertTransferOutStep(from: TransferOutStatus, to: TransferOutStatus): void {
  if (from === to) return
  const allowed: Readonly<Record<TransferOutStatus, readonly TransferOutStatus[]>> = {
    pending_out: ['outbounding', 'cancelled'],
    outbounding: ['pending_out', 'outbounded'],
    outbounded: [],
    cancelled: [],
  }
  if (!allowed[from].includes(to)) {
    throw new ReverseRuleViolation(
      'WR-13',
      `调拨出库状态步进非法：${TRANSFER_OUT_STATUS_LABELS[from]} → ${TRANSFER_OUT_STATUS_LABELS[to]}（待出库→出库中→已出库；删码删空回待出库）`,
    )
  }
}

/** 三来源（WR-07）：①Web 新增（有任务）②PDA 无任务首扫自动建单③其它模块自动生成（生成即已出库）。 */
export const TRANSFER_OUT_SOURCE_KINDS = ['web_task', 'pda_taskless', 'auto'] as const
export type TransferOutSourceKind = (typeof TRANSFER_OUT_SOURCE_KINDS)[number]

export const TRANSFER_KINDS = ['production', 'warehouse'] as const
export type ReverseTransferKind = (typeof TRANSFER_KINDS)[number]

/**
 * WR-06：调拨仓库类型规则（新增与完成出库都校验）——
 * 调入 ≠ 调出；调出为线边仓时调入只能线边仓；生产调拨调入只能线边仓且料限原材料/半成品
 * （成品不能选、不能扫）；仓库已锁定拒绝。
 */
export function assertTransferOutWarehouseRules(input: {
  transferKind: string
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseKind: string
  toWarehouseKind: string
  lineMaterialTypes: readonly (number | null)[]
  fromWarehouseLocked: boolean
  toWarehouseLocked: boolean
}): void {
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw new ReverseRuleViolation('WR-06', '调入仓库不得等于调出仓库')
  }
  if (input.fromWarehouseKind === 'LINE_SIDE' && input.toWarehouseKind !== 'LINE_SIDE') {
    throw new ReverseRuleViolation(
      'WR-06',
      `调出仓库为线边仓时，调入仓库只能为线边仓（当前调入 ${input.toWarehouseKind}）`,
    )
  }
  if (input.transferKind === 'production') {
    if (input.toWarehouseKind !== 'LINE_SIDE') {
      throw new ReverseRuleViolation('WR-06', `生产调拨的调入仓库只能为线边仓（当前 ${input.toWarehouseKind}）`)
    }
    const illegal = [...new Set(input.lineMaterialTypes.filter((t) => t !== null && t !== 1 && t !== 2))]
    if (illegal.length > 0) {
      throw new ReverseRuleViolation(
        'WR-06',
        `生产调拨的料品仅限原材料/半成品，成品不能选、不能扫（料品类型 ${illegal.join('/')} 不在允许范围）`,
      )
    }
  }
  if (input.fromWarehouseLocked) {
    throw new ReverseRuleViolation('WR-06', '调出仓库处于锁定状态，拒绝')
  }
  if (input.toWarehouseLocked) {
    throw new ReverseRuleViolation('WR-06', '调入仓库处于锁定状态，拒绝')
  }
}

/** 扫码校验事实（WR-09；事实由命令层事务内实时收集）。 */
export interface TransferOutScanFacts {
  unitNo: string
  /** 码或托下码不在库中 */
  notInStock: boolean
  /** 质检未通过且系统参数不允许质检未完成出库（GAP-D9：参数默认值待裁——缺省严格=不允许） */
  qualityUnfinished: boolean
  /** 码或托下码已被锁定（其它活动作业预留） */
  lockedByOtherTask: boolean
  /** 该码剩余数量为 0 */
  remainingQtyZero: boolean
  /** 有任务时料品不在本单明细 */
  materialNotInOrderDetail: boolean
  /** 码所在仓库不是本单调出仓库 */
  warehouseMismatch: boolean
  /** 仓库被锁定/已禁用 */
  warehouseLockedOrDisabled: boolean
  /** 本单调出/调入仓库已锁定 */
  orderWarehouseLocked: boolean
}

/** WR-09：扫码校验（任一命中拒绝）。 */
export function assertTransferOutScanAcceptable(facts: TransferOutScanFacts): void {
  if (facts.notInStock) {
    throw new ReverseRuleViolation('WR-09', `单元 ${facts.unitNo}不在库中，拒绝装入`)
  }
  if (facts.qualityUnfinished) {
    throw new ReverseRuleViolation(
      'WR-09',
      `单元 ${facts.unitNo}质检未通过且系统参数不允许质检未完成出库（GAP-D9 参数缺省=不允许），拒绝`,
    )
  }
  if (facts.lockedByOtherTask) {
    throw new ReverseRuleViolation('WR-09', `单元 ${facts.unitNo}已被锁定，拒绝装入`)
  }
  if (facts.remainingQtyZero) {
    throw new ReverseRuleViolation('WR-09', `单元 ${facts.unitNo}剩余数量为 0，拒绝装入`)
  }
  if (facts.materialNotInOrderDetail) {
    throw new ReverseRuleViolation('WR-09', `单元 ${facts.unitNo}的料品不在本单明细，拒绝装入`)
  }
  if (facts.warehouseMismatch) {
    throw new ReverseRuleViolation('WR-09', `单元 ${facts.unitNo}所在仓库不是本单调出仓库，拒绝装入`)
  }
  if (facts.warehouseLockedOrDisabled) {
    throw new ReverseRuleViolation('WR-09', '码所在仓库被锁定或已禁用，拒绝装入')
  }
  if (facts.orderWarehouseLocked) {
    throw new ReverseRuleViolation('WR-09', '本单调出/调入仓库已锁定，拒绝装入')
  }
}

/**
 * WR-10：调出数量语义——CA-7 两段语义（扫码默认整码＋明细允许调减部分调出）裁定前，
 * 按 :463 整码实现：按该码剩余数量整码调出，不实现部分调出（部分调出走 InventoryUnit
 * 拆分、剩余留原库位、托码整托——随 CA-7）。
 */
export function assertWholeCodeOutbound(input: {
  unitNo: string
  remainingQty: string
  requestedOutQty: string | undefined
}): string {
  if (input.requestedOutQty === undefined) return input.remainingQty
  if (cmpQty(input.requestedOutQty, input.remainingQty) !== 0) {
    throw new ReverseRuleViolation(
      'WR-10',
      `单元 ${input.unitNo}按整码调出（剩余 ${input.remainingQty}、请求 ${input.requestedOutQty}）：部分调出在 CA-7 裁定前不实现`,
    )
  }
  return input.requestedOutQty
}

/** WR-07②：PDA 无任务调拨——每人同时只能一条进行中（待出库/出库中）。 */
export function assertTasklessSingleInProgress(input: {
  operator: string
  existingInProgress: { orderNo: string; status: string } | null
}): void {
  if (input.existingInProgress !== null) {
    throw new ReverseRuleViolation(
      'WR-07',
      `操作人 ${input.operator}已有一条进行中的无任务调拨单（${input.existingInProgress.orderNo}，${input.existingInProgress.status}），每人同时只能一条进行中`,
    )
  }
}

/** WR-07②：无任务单后续扫码——调出仓库必须与首码一致（不校验料品）。 */
export function assertTasklessFromWarehouseConsistent(input: {
  unitNo: string
  unitWarehouseId: string
  orderFromWarehouseId: string
}): void {
  if (input.unitWarehouseId !== input.orderFromWarehouseId) {
    throw new ReverseRuleViolation(
      'WR-07',
      `单元 ${input.unitNo}所在仓库与本无任务单调出仓库不一致（后续扫码须同调出仓库，不校验料品），拒绝`,
    )
  }
}

/** WR-08：编辑/删除前置——仅「待出库且未扫过码」可编辑/删除；无任务单不可编辑/删除。 */
export function assertOutboundOrderEditable(input: {
  orderNo: string
  sourceKind: string
  status: string
  scannedCount: number
  action?: 'edit' | 'delete'
}): void {
  const action = input.action ?? 'edit'
  if (input.sourceKind === 'pda_taskless') {
    throw new ReverseRuleViolation('WR-08', `无任务调拨单 ${input.orderNo}不可${action === 'edit' ? '编辑' : '删除'}（PDA 自动建单）`)
  }
  if (input.status !== 'pending_out') {
    throw new ReverseRuleViolation(
      'WR-08',
      `调拨单 ${input.orderNo}状态为 ${TRANSFER_OUT_STATUS_LABELS[input.status as TransferOutStatus] ?? input.status}，仅待出库可${action === 'edit' ? '编辑' : '删除'}`,
    )
  }
  if (input.scannedCount > 0) {
    throw new ReverseRuleViolation('WR-08', `调拨单 ${input.orderNo}已扫过码，不可${action === 'edit' ? '编辑' : '删除'}`)
  }
}

/** WR-08：批量删除任一条不满足整批不删。 */
export function assertBatchDeletableAllOrNothing(
  orders: ReadonlyArray<{ orderNo: string; sourceKind: string; status: string; scannedCount: number }>,
): void {
  const bad = orders.filter(
    (o) => o.sourceKind === 'pda_taskless' || o.status !== 'pending_out' || o.scannedCount > 0,
  )
  if (bad.length > 0) {
    throw new ReverseRuleViolation(
      'WR-08',
      `批量删除整批不删：${bad
        .map((o) => `${o.orderNo}(${o.sourceKind === 'pda_taskless' ? '无任务单' : o.status !== 'pending_out' ? '非待出库' : '已扫码'})`)
        .join('、')} 不满足删除条件`,
    )
  }
}

/**
 * WR-11：完成出库前置——本单至少扫过一码；有货架层数未选拒绝。
 * 跨厂调拨不适用"有货架层数未选"拒绝（crossPlant=true 豁免）：跨厂必须走独立接收事实
 * （WR-14：接收方扫码上架/签收，禁止以固定库位冒充签收），完成出库时选调入库位本身即被拒，
 * 在途路径（未选库位 → 码变为已出库（在途），WR-11 后段）是跨厂唯一合法完成方式。
 */
export function assertOutboundCompletable(input: {
  orderNo: string
  loadedScanCount: number
  toWarehouseHasRack: boolean
  toLocationId: string | undefined
  /** 跨厂调拨（调出厂与调入厂不同厂）：在途路径豁免货架未选拒绝（WR-14）。 */
  crossPlant?: boolean
}): void {
  if (input.loadedScanCount === 0) {
    throw new ReverseRuleViolation('WR-11', `调拨单 ${input.orderNo}未扫过任何码，不可完成出库`)
  }
  if (input.crossPlant !== true && input.toWarehouseHasRack && input.toLocationId === undefined) {
    throw new ReverseRuleViolation('WR-11', `调入仓库存在货架库位：有货架层数未选（须选择调入库位/货架层）才可完成出库`)
  }
}
