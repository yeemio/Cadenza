// 包内上级目录相对导入（domain/src/reverse → domain/src/inventory）：未逃逸出 domain 包，
// 边界规则对包内子目录场景过宽（同 reporting/metric-rules.ts、trace/genealogy.ts 先例）；单行豁免留痕。
// eslint-disable-next-line no-restricted-imports
import { addQty, cmpQty } from '../inventory/quantity'
// 包内上级目录相对导入（domain/src/reverse → domain/src/inventory）：未逃逸出 domain 包，
// 边界规则对包内子目录场景过宽（同 reporting/metric-rules.ts、trace/genealogy.ts 先例）；单行豁免留痕。
// eslint-disable-next-line no-restricted-imports
import { sumQty } from '../inventory/posting'
import { ReverseRuleViolation } from './errors'

/**
 * 移库全量行为纯规则 —— 冻结合同 frozen/p2/warehouse-reverse.md §1（WR-01～WR-05；
 * 原件 移库管理/移库管理.md；DM §6）。P1 A-T13-4 已建最小子集（单码四拒一成）；
 * 本规则族冻结 P2 补全量：扫码只查询不改不锁、本机暂存、提交服务端事务内实时重校验、
 * 移库台账（表头＋逐码明细，同码同料合并）。
 */

/** WR-01：扫码只查询/校验/返回码信息——不改位置、不锁定（结构常量：扫码查询端点只读）。 */
export const MOVE_SCAN_IS_READONLY = true

/** 扫码校验事实（WR-02 扫码层；事实由查询/命令层实时收集——扫码不落任何锁）。 */
export interface MoveScanFacts {
  unitNo: string
  /** 码所在仓库 ≠ 所选仓库 */
  warehouseMismatch: boolean
  /** 所选仓库被锁定（盘点锁定/主数据停用） */
  selectedWarehouseLocked: boolean
  /** 码本身被其它任务锁定（活动作业预留） */
  unitLockedByOtherTask: boolean
  /** 托下有码已被锁定（整托口径：任一托下码被锁即拒） */
  palletMemberLocked: boolean
  /** 码不在库中（IT-13 状态轴） */
  notInStock: boolean
  /** 托下单码（只能整托，单码禁扫） */
  isPalletChildWithoutWhole: boolean
  /** 本次（本机暂存清单内）重复 */
  duplicateInStaging: boolean
  /** 原库位 = 新库位（所选目标） */
  sameLocation: boolean
}

/** WR-02：扫码校验（任一命中拒绝；顺序按原文 ：237-241）。 */
export function assertMoveScanAcceptable(facts: MoveScanFacts): void {
  if (facts.warehouseMismatch) {
    throw new ReverseRuleViolation('WR-02', `单元 ${facts.unitNo}所在仓库与所选仓库不同，拒绝`)
  }
  if (facts.selectedWarehouseLocked) {
    throw new ReverseRuleViolation('WR-02', '所选仓库处于锁定状态，拒绝扫码')
  }
  if (facts.unitLockedByOtherTask || facts.palletMemberLocked) {
    throw new ReverseRuleViolation(
      'WR-02',
      `单元 ${facts.unitNo}${facts.palletMemberLocked && !facts.unitLockedByOtherTask ? '所在托下有码' : ''}已被锁定，拒绝`,
    )
  }
  if (facts.notInStock) {
    throw new ReverseRuleViolation('WR-02', `单元 ${facts.unitNo}不在库中，拒绝`)
  }
  if (facts.isPalletChildWithoutWhole) {
    throw new ReverseRuleViolation('WR-02', `单元 ${facts.unitNo}为托下单码：移库只可整托，托下单码禁扫`)
  }
  if (facts.duplicateInStaging) {
    throw new ReverseRuleViolation('WR-02', `单元 ${facts.unitNo}本次已扫码（暂存清单内重复），拒绝`)
  }
  if (facts.sameLocation) {
    throw new ReverseRuleViolation('WR-02', `单元 ${facts.unitNo}原库位与新库位相同，拒绝`)
  }
}

/** 提交校验事实（WR-02 提交层——服务端事务内以实时状态重校验，WR-01）。 */
export interface MoveSubmitFacts {
  /** 暂存清单为空（无码可提交） */
  stagingEmpty: boolean
  /** 暂存数据异常（码不存在/结构缺失等） */
  stagingAnomaly: string | null
  /** 目标库位编码为空 */
  locationCodeEmpty: boolean
  /** 目标仓库为空 */
  warehouseEmpty: boolean
  /** 库位在该仓库下不存在（或不属于该仓库） */
  locationNotInWarehouse: boolean
}

/** WR-02：提交另校验（库位为空/仓库为空/库位在该仓库下不存在/暂存数据异常）。 */
export function assertMoveSubmitAcceptable(facts: MoveSubmitFacts): void {
  if (facts.stagingEmpty) {
    throw new ReverseRuleViolation('WR-02', '暂存清单为空：无已扫码码可提交移库')
  }
  if (facts.stagingAnomaly !== null) {
    throw new ReverseRuleViolation('WR-02', `暂存数据异常：${facts.stagingAnomaly}`)
  }
  if (facts.locationCodeEmpty) {
    throw new ReverseRuleViolation('WR-02', '移入库位为空，拒绝提交')
  }
  if (facts.warehouseEmpty) {
    throw new ReverseRuleViolation('WR-02', '移入仓库为空，拒绝提交')
  }
  if (facts.locationNotInWarehouse) {
    throw new ReverseRuleViolation('WR-02', '移入库位在该仓库下不存在，拒绝提交')
  }
}

/**
 * WR-03：移入库位范围——只列当前登录人部门下、已启用、仓库类型（不含线边仓）的仓库；
 * 所选仓库与已扫码仓库不一致时拒绝。
 */
export function assertMoveTargetWarehouse(input: {
  warehouseId: string
  warehouseKind: string
  warehouseStatus: string
  inActorDept: boolean
  scannedWarehouseId: string | null
}): void {
  if (!input.inActorDept) {
    throw new ReverseRuleViolation('WR-03', `仓库 ${input.warehouseId}不在当前登录人部门下，不可作为移入库位范围`)
  }
  if (input.warehouseStatus !== 'active') {
    throw new ReverseRuleViolation('WR-03', `仓库 ${input.warehouseId}未启用，不可作为移入库位范围`)
  }
  if (input.warehouseKind === 'LINE_SIDE') {
    throw new ReverseRuleViolation('WR-03', `线边仓 ${input.warehouseId}不在移入库位范围（只列仓库类型仓库）`)
  }
  if (input.scannedWarehouseId !== null && input.scannedWarehouseId !== input.warehouseId) {
    throw new ReverseRuleViolation(
      'WR-03',
      `所选仓库与已扫码仓库不一致（已扫码仓库 ${input.scannedWarehouseId}、所选 ${input.warehouseId}），拒绝`,
    )
  }
}

/** 移库明细输入行（提交载荷归一化后；同码同料品合并数量相加，WR-04）。 */
export interface MoveLineInput {
  unitNo: string
  materialCode: string
  quantity: string
}

/** 移库明细归一化行（WR-04：同一码同一料品合并数量相加）。 */
export interface MergedMoveLine {
  unitNo: string
  materialCode: string
  quantity: string
}

/**
 * WR-04：明细合并——同一码同一料品合并数量相加（暂存清单内同码可能多次暂存）；
 * 表头料品名称 = 料品编码去重后拼接。
 */
export function mergeMoveLines(lines: readonly MoveLineInput[]): {
  merged: MergedMoveLine[]
  materialCodesJoined: string
} {
  const byKey = new Map<string, MergedMoveLine>()
  for (const line of lines) {
    const key = `${line.unitNo}::${line.materialCode}`
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, { unitNo: line.unitNo, materialCode: line.materialCode, quantity: line.quantity })
    } else {
      existing.quantity = addQty(existing.quantity, line.quantity)
    }
  }
  const merged = [...byKey.values()]
  const distinctCodes = [...new Set(merged.map((l) => l.materialCode))]
  return { merged, materialCodesJoined: distinctCodes.join('、') }
}

/** WR-04：合并后数量必须为正（合并退化保护）。 */
export function assertMergedLinesPositive(merged: readonly MergedMoveLine[]): void {
  for (const line of merged) {
    if (cmpQty(line.quantity, '0.0000') <= 0) {
      throw new ReverseRuleViolation('WR-04', `单元 ${line.unitNo}合并后数量非正（${line.quantity}），拒绝生成移库记录`)
    }
  }
}

/** WR-04：整单合计（库存统计按本次的码重算——对账断言用）。 */
export function totalMovedQty(merged: readonly MergedMoveLine[]): string {
  return sumQty(merged.map((l) => l.quantity))
}
