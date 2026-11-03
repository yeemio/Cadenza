// 包内上级目录相对导入（domain/src/reverse → domain/src/inventory）：未逃逸出 domain 包，
// 边界规则对包内子目录场景过宽（同 reporting/metric-rules.ts、trace/genealogy.ts 先例）；单行豁免留痕。
// eslint-disable-next-line no-restricted-imports
import { addQty, cmpQty } from '../inventory/quantity'
import { ReverseRuleViolation } from './errors'

/**
 * 盘点（S12 显式新增，无独立原件）纯规则 —— 冻结合同 frozen/p2/warehouse-reverse.md §5
 * （WR-24/WR-25，**[合同新造·最小语义]**；DM §6/§8；IT-19/IT-20；OA-29）。
 * 盘单生成/审批流/解锁条件 → GAP-F10 待 Owner 最小集裁定：本规则族只冻结
 * 锁定拦截、差异调整单（原因必填＋去向）、正向/反向库存流水、调整基准=实时余额。
 */

/** 盘点单状态（WR-S4：仓库范围、锁定标志、状态；GAP-F10 前最小集：盘点中/已完成/已取消）。 */
export const STOCKTAKE_STATUSES = ['counting', 'completed', 'cancelled'] as const
export type StocktakeStatus = (typeof STOCKTAKE_STATUSES)[number]

export const STOCKTAKE_STATUS_LABELS: Readonly<Record<StocktakeStatus, string>> = {
  counting: '盘点中（锁定）',
  completed: '已完成（解锁）',
  cancelled: '已取消（解锁）',
}

/** WR-24①：盘点期间仓库锁定标志拦截——同事务校验，可解释拒绝（"仓库盘点锁定"）。 */
export function assertNotStocktakeLocked(input: {
  warehouseId: string
  warehouseCode: string | null
  activeStocktakeOrderNo: string | null
  action: string
}): void {
  if (input.activeStocktakeOrderNo !== null) {
    throw new ReverseRuleViolation(
      'WR-24',
      `仓库盘点锁定中（仓库 ${input.warehouseCode ?? input.warehouseId}、盘单 ${input.activeStocktakeOrderNo}）：${input.action}被拦截`,
    )
  }
}

/** 盘点锁定的拦截动作清单（WR-24①：分托/解绑属 T15 域——本域拦截移库/调拨出入库/入库，T15 侧收编请求见交付记录）。 */
export const STOCKTAKE_INTERCEPTED_ACTIONS: readonly string[] = [
  '移库',
  '调拨出库扫码',
  '调拨出库完成',
  '调拨入库扫码上架',
  '调拨入库完成',
]

/** 差异调整行（WR-24②：调整必须对应调整原因和去向，DM §8）。 */
export interface StockAdjustmentLineInput {
  unitId: string
  unitNo: string
  locationId: string
  ownerId: string
  /** 差异数量：正=盘盈（正向流水）、负=盘亏（反向流水） */
  adjustQty: string
}

/**
 * WR-24②/③：差异调整单——调整原因必填＋去向；禁止直接改 stock_balance（本命令走
 * 正向/反向库存流水，直写通道不存在——IT-18 assertNoDirectBalanceOverride 随行）；
 * 高影响操作（OA-29 清单）：强制理由＋审计。
 */
export function assertAdjustmentExecutable(input: {
  reason: string | undefined
  destination: string | undefined
  lines: readonly StockAdjustmentLineInput[]
}): void {
  const reason = (input.reason ?? '').trim()
  if (reason === '') {
    throw new ReverseRuleViolation('WR-24', '差异调整单必须填写调整原因（盘点差异调整=高影响操作，OA-29 强制理由）')
  }
  if ((input.destination ?? '').trim() === '') {
    throw new ReverseRuleViolation('WR-24', '差异调整单必须填写差异去向（DM §8：盘点必须对应调整原因和去向）')
  }
  if (input.lines.length === 0) {
    throw new ReverseRuleViolation('WR-24', '差异调整单至少包含一行差异')
  }
  for (const line of input.lines) {
    if (cmpQty(line.adjustQty, '0.0000') === 0) {
      throw new ReverseRuleViolation('WR-24', `单元 ${line.unitNo}差异数量为 0：无差异行不入调整单`)
    }
  }
}

/**
 * WR-25：调整基准 = 调整命令时点实时余额（盘点点数的账面数量仅作差异计算依据）；
 * 盘亏不得越实时余额（IT-30 无负库存）。
 */
export function assertAdjustmentAgainstRealtimeBalance(input: {
  unitNo: string
  realtimeQty: string
  adjustQty: string
}): void {
  const after = addQty(input.realtimeQty, input.adjustQty)
  if (cmpQty(after, '0.0000') < 0) {
    throw new ReverseRuleViolation(
      'WR-25',
      `单元 ${input.unitNo}调整后余额为负（实时 ${input.realtimeQty}、本次 ${input.adjustQty}）：拒绝（无负库存，IT-30）`,
    )
  }
}

/** WR-25：流水含扣前/扣后余额（IT-19）——调整行扣前=实时余额、扣后=实时＋差异。 */
export function buildAdjustmentBalances(input: { realtimeQty: string; adjustQty: string }): {
  beforeQty: string
  afterQty: string
} {
  return { beforeQty: input.realtimeQty, afterQty: addQty(input.realtimeQty, input.adjustQty) }
}
