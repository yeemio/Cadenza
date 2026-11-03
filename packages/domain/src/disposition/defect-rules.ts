import { DispositionRuleViolation } from './errors'
import { checkDecimalScale } from './decimal-util'

/**
 * 成品异常规则（QD-05～QD-10，frozen/p2/quality-disposition.md §2）。
 * PDA 前置（QD-05）+ 提交校验（QD-06）+ Web 审核（QD-07/08/09）+ 字典与部门口径（QD-10）。
 */

/** QD-10：不合格类型 2 值（返工/报废）。 */
export type DefectTypeValue = 'rework' | 'scrap'

/** QD-10：审核状态 3 值（未审核/通过/不通过）。 */
export type DefectReviewStatusValue = 'unreviewed' | 'approved' | 'rejected'

/** QD-10：码异常状态 2 值（无异常/异常未处理）——投影，由记录推导。 */
export type UnitDefectStateValue = 'normal' | 'defect_open'

/** QD-08：扣数去向枚举（报废/返工/其它＋说明，必填）。 */
export type DefectDestinationKind = 'scrap' | 'rework' | 'other'

/** QD-05：PDA 扫码前置（只查询）。 */
export function checkDefectScan(input: {
  isPalletCode: boolean
  /** 码已入库 */
  isReceived: boolean
  /** 入库后所在仓库是否线边仓 */
  inLineSideWarehouse: boolean
  /** 仓库是否存在 */
  warehouseExists: boolean
}): 'ok' | 'pallet_code' | 'not_line_side' | 'warehouse_missing' {
  if (input.isPalletCode) return 'pallet_code'
  if (!input.isReceived) return 'ok' // 未入库的码允许（先于仓库检查）
  if (!input.warehouseExists) return 'warehouse_missing'
  if (!input.inLineSideWarehouse) return 'not_line_side'
  return 'ok'
}

/** QD-05：PDA 前置违例文案（确认时按扫码规则重校验）。 */
export function assertDefectScanAllowed(scanResult: ReturnType<typeof checkDefectScan>, unitNo: string): void {
  if (scanResult === 'ok') return
  const label: Record<Exclude<ReturnType<typeof checkDefectScan>, 'ok'>, string> = {
    pallet_code: '托码拒绝（不能提交成品异常）',
    not_line_side: '已入库的码仅线边仓允许提交成品异常（已入库且非线边仓拒绝）',
    warehouse_missing: '仓库不存在',
  }
  throw new DispositionRuleViolation('QD-05', `成品异常前置不满足（${label[scanResult]}，轴号 ${unitNo}）`)
}

/** QD-06：提交校验输入（应用层装载事实，本函数判定）。 */
export interface DefectSubmitInput {
  unitNo: string | null
  materialId: string | null
  /** 所选料品是否在扫码结果中 */
  materialInScanResult: boolean
  /** 该码该料品是否已有未处理异常（审核状态=未审核） */
  hasOpenDefect: boolean
  defectType: DefectTypeValue | null
  defectQty: string | null
  /** 该料品总数（同码该料品账面量） */
  materialTotalQty: string
}

/** QD-06：数量格式（>0、≤4 位小数、≤该料品总数）。 */
export function assertDefectQty(defectQty: string | null, totalQty: string): string {
  if (defectQty === null || defectQty.trim() === '') {
    throw new DispositionRuleViolation('QD-06', '未传不合格数量')
  }
  checkDecimalScale(defectQty, 'QD-06', '不合格数量')
  const qty = Number(defectQty)
  if (!Number.isFinite(qty) || qty <= 0) throw new DispositionRuleViolation('QD-06', '不合格数量必须大于 0')
  const total = Number(totalQty)
  if (!Number.isFinite(total)) throw new DispositionRuleViolation('QD-06', '该料品总数不可解析')
  if (qty > total) {
    throw new DispositionRuleViolation('QD-06', `不合格数量 ${defectQty} 大于该料品总数 ${totalQty}`)
  }
  return defectQty
}

/** QD-06：提交校验（任一命中拒绝）。 */
export function assertDefectSubmittable(input: DefectSubmitInput): void {
  if (input.unitNo === null || input.unitNo === '') {
    throw new DispositionRuleViolation('QD-06', '产品轴号为空')
  }
  if (input.materialId === null || input.materialId === '') {
    throw new DispositionRuleViolation('QD-06', '未选料品')
  }
  if (!input.materialInScanResult) {
    throw new DispositionRuleViolation('QD-06', '所选料品不在扫码结果中')
  }
  if (input.hasOpenDefect) {
    throw new DispositionRuleViolation('QD-06', '该码该料品已有异常未处理（不可重复提交）')
  }
  if (input.defectType === null) {
    throw new DispositionRuleViolation('QD-06', '未传不合格类型')
  }
  assertDefectQty(input.defectQty, input.materialTotalQty)
}

/** QD-07：审核可执行 = 记录存在且审核状态=未审核（权限由应用层另校）。 */
export function assertDefectReviewable(reviewStatus: DefectReviewStatusValue | null, defectNo: string): void {
  if (reviewStatus === null) {
    throw new DispositionRuleViolation('QD-07', `成品异常记录不存在（单号 ${defectNo}）`)
  }
  if (reviewStatus !== 'unreviewed') {
    throw new DispositionRuleViolation('QD-07', `成品异常记录 ${defectNo} 审核状态为 ${reviewStatus}，仅未审核记录可审核`)
  }
}

/** QD-07：审核结果必传。 */
export function assertReviewResultPresent(result: 'approved' | 'rejected' | null): 'approved' | 'rejected' {
  if (result !== 'approved' && result !== 'rejected') {
    throw new DispositionRuleViolation('QD-07', '审核结果必传（通过/不通过）')
  }
  return result
}

/** QD-08：审核通过扣数必须记录调整原因与去向（禁止无去向扣数）。 */
export function assertDeductionDestination(kind: DefectDestinationKind | null, note: string | null, reason: string | null): {
  destinationKind: DefectDestinationKind
  destinationNote: string
  reason: string
} {
  if (kind === null) throw new DispositionRuleViolation('QD-08', '审核通过扣数必须记录去向（报废/返工/其它）')
  if (note === null || note.trim() === '') throw new DispositionRuleViolation('QD-08', '扣数去向说明必填')
  if (reason === null || reason.trim() === '') throw new DispositionRuleViolation('QD-08', '审核通过扣数必须记录调整原因')
  return { destinationKind: kind, destinationNote: note, reason }
}

/** QD-09：多码依次扣的扣减分配（提交事务内基于实时余额计算；纯分配计算，行锁由应用层 SELECT FOR UPDATE 承担）。
 * 足减多码依次扣：按给定有序余额行分配，返回每行扣减量；任一不足即整体拒绝（不部分扣）。 */
export function allocateDeduction(
  lines: Array<{ balanceId: string; availableQty: string }>,
  totalQty: string,
): Array<{ balanceId: string; deductQty: string }> {
  let remain = Number(totalQty)
  if (!Number.isFinite(remain) || remain <= 0) {
    throw new DispositionRuleViolation('QD-09', '扣减数量必须大于 0')
  }
  const out: Array<{ balanceId: string; deductQty: string }> = []
  for (const line of lines) {
    if (remain <= 0) break
    const avail = Number(line.availableQty)
    if (!Number.isFinite(avail) || avail < 0) {
      throw new DispositionRuleViolation('QD-09', '余额不可解析或为负')
    }
    const take = Math.min(avail, remain)
    if (take > 0) {
      out.push({ balanceId: line.balanceId, deductQty: take.toFixed(4) })
      remain = Number((remain - take).toFixed(4))
    }
  }
  if (remain > 0) {
    throw new DispositionRuleViolation('QD-09', `该轴该料品余额不足（尚缺 ${remain.toFixed(4)}），不部分扣减`)
  }
  return out
}

/** QD-10：码异常状态投影（2 值；由该码该料品是否存在未审核异常记录推导）。 */
export function unitDefectState(hasOpenDefect: boolean): UnitDefectStateValue {
  return hasOpenDefect ? 'defect_open' : 'normal'
}
