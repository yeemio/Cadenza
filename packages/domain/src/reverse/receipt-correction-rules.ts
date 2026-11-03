// 包内上级目录相对导入（domain/src/reverse → domain/src/inventory）：未逃逸出 domain 包，
// 边界规则对包内子目录场景过宽（同 reporting/metric-rules.ts、trace/genealogy.ts 先例）；单行豁免留痕。
// eslint-disable-next-line no-restricted-imports
import { addQty } from '../inventory/quantity'
import { ReverseRuleViolation } from './errors'

/**
 * 采购批次库存纠正纯规则 —— 冻结合同 frozen/p2/warehouse-reverse.md §4（WR-18～WR-23；
 * 原件 采购管理/采购批次.md；DM §8；IT-31/32/33；IF-10）。
 * 目标口径（CA-16/CA-17 废除隐式归零与管理删除）：退货写退货事实＋反向流水（投影=已入账−已退货）；
 * 删除=作废（逻辑删除＋操作记录）；已入账批次纠正走具名冲销。
 */

/** 采购批次质检状态（0006 purchase_receipt_batch.inspection_status 字典随行）。 */
export type ReceiptInspectionStatus =
  | 'exempt'
  | 'pending'
  | 'in_progress'
  | 'all_qualified'
  | 'all_unqualified'
  | 'partially_qualified'

/** 纠正种类（WR-S6：作废/冲销/退货三类，append-only）。 */
export const RECEIPT_CORRECTION_KINDS = ['void', 'reverse', 'return'] as const
export type ReceiptCorrectionKind = (typeof RECEIPT_CORRECTION_KINDS)[number]

export const RECEIPT_CORRECTION_KIND_LABELS: Readonly<Record<ReceiptCorrectionKind, string>> = {
  void: '作废',
  reverse: '冲销',
  return: '退货',
}

/** WR-18：一码多批收货分组键（二维码＋厂家批号＋牌号/线径）。 */
export interface ReceiveGroupKey {
  barcodeValue: string
  supplierLotNo: string
  grade: string
}

export interface ReceiveLineInput extends ReceiveGroupKey {
  quantity: string
}

/** WR-18：同组多次保存合并数量相加；组键比较（空值规范化为空串，随 0006 三元组唯一口径）。 */
export function receiveGroupKeyOf(line: ReceiveGroupKey): string {
  return `${line.barcodeValue}::${(line.supplierLotNo ?? '').trim()}::${(line.grade ?? '').trim()}`
}

/** WR-18：同一收货单内同组不可重复（单次载荷内重复即拒；跨次保存同组=合并）。 */
export function assertGroupNotDuplicatedInPayload(lines: readonly ReceiveLineInput[]): void {
  const seen = new Set<string>()
  for (const line of lines) {
    const key = receiveGroupKeyOf(line)
    if (seen.has(key)) {
      throw new ReverseRuleViolation(
        'WR-18',
        `收货单内同组不可重复：二维码 ${line.barcodeValue}＋厂家批号 ${line.supplierLotNo || '（空）'}＋牌号/线径 ${line.grade || '（空）'}`,
      )
    }
    seen.add(key)
  }
}

/** WR-18：同组合并（既有数量＋本次数量相加）。 */
export function mergeReceiveQuantity(existingQty: string, incomingQty: string): string {
  return addQty(existingQty, incomingQty)
}

/**
 * WR-18：已收货的码再扫先弹确认——未携带确认标志时拒绝并回传「系统已记＋本机已保存数量」
 * 事实（确认弹窗数据源由查询端点提供；本断言保证服务端不静默继续）。
 */
export function assertReScanConfirmed(input: {
  barcodeValue: string
  systemRecordedQty: string
  localSavedQty: string
  confirmReScan: boolean
}): void {
  if (!input.confirmReScan) {
    throw new ReverseRuleViolation(
      'WR-18',
      `码 ${input.barcodeValue}已有收货记录（系统已记 ${input.systemRecordedQty}、本机已保存 ${input.localSavedQty}）：再扫须先确认才继续（confirmReScan=true）`,
    )
  }
}

/** WR-19：修改（普通）业务条件——质检状态待质检或全部不合格、且合格同步状态非已同步。 */
export function assertReceiptModifiable(input: {
  batchNo: string
  inspectionStatus: string
  qualifiedSyncStatus: string
}): void {
  const inspectable = input.inspectionStatus === 'pending' || input.inspectionStatus === 'all_unqualified'
  if (!inspectable) {
    throw new ReverseRuleViolation(
      'WR-19',
      `批次 ${input.batchNo}质检状态为 ${input.inspectionStatus}：修改仅限 待质检 或 全部不合格（「管理员修改不受限」路径已废除，CA-3/CA 登记不采用）`,
    )
  }
  if (input.qualifiedSyncStatus === 'synced') {
    throw new ReverseRuleViolation('WR-19', `批次 ${input.batchNo}合格同步状态为已同步：已同步批次不可修改`)
  }
}

/** WR-20：退货可执行——质检状态全部不合格且未退货；退货备注必填（≤200）、附件≤3。 */
export function assertReturnExecutable(input: {
  batchNo: string
  inspectionStatus: string
  storageStatus: string
  remark: string | undefined
  attachments: readonly unknown[]
}): void {
  if (input.inspectionStatus !== 'all_unqualified') {
    throw new ReverseRuleViolation(
      'WR-20',
      `批次 ${input.batchNo}质检状态为 ${input.inspectionStatus}：退货仅限 全部不合格 批次`,
    )
  }
  if (input.storageStatus === 'returned') {
    throw new ReverseRuleViolation('WR-20', `批次 ${input.batchNo}已退货，不可重复退货`)
  }
  const remark = (input.remark ?? '').trim()
  if (remark === '') {
    throw new ReverseRuleViolation('WR-20', '退货备注必填')
  }
  if (remark.length > 200) {
    throw new ReverseRuleViolation('WR-20', `退货备注超长（${remark.length} 字 > 200 字上限）`)
  }
  if (input.attachments.length > 3) {
    throw new ReverseRuleViolation('WR-20', `退货附件超限（${input.attachments.length} 件 > 3 件上限）`)
  }
}

/** WR-21：普通删除（=作废）——待质检或全部不合格且合格同步未同步；免检不可普通删除。 */
export function assertVoidExecutable(input: {
  batchNo: string
  inspectionStatus: string
  qualifiedSyncStatus: string
  storageStatus: string
}): void {
  if (input.inspectionStatus === 'exempt') {
    throw new ReverseRuleViolation('WR-21', `批次 ${input.batchNo}为免检批次：免检不可普通删除（作废）`)
  }
  const deletable = input.inspectionStatus === 'pending' || input.inspectionStatus === 'all_unqualified'
  if (!deletable) {
    throw new ReverseRuleViolation(
      'WR-21',
      `批次 ${input.batchNo}质检状态为 ${input.inspectionStatus}：普通删除仅限 待质检 或 全部不合格（「管理删除无视状态」路径已废除，CA-17）`,
    )
  }
  if (input.qualifiedSyncStatus === 'synced') {
    throw new ReverseRuleViolation('WR-21', `批次 ${input.batchNo}合格同步状态为已同步：不可普通删除`)
  }
  if (input.storageStatus === 'returned') {
    throw new ReverseRuleViolation('WR-21', `批次 ${input.batchNo}已退货：不可普通删除（退货事实保留）`)
  }
}

/** WR-21：具名冲销（已入账批次纠正）——强制理由＋审计（OA-29 高影响），纠正事实与快照留档。 */
export function assertNamedReversalExecutable(input: {
  batchNo: string
  reason: string | undefined
  reverseQty: string
  bookedQty: string
}): void {
  const reason = (input.reason ?? '').trim()
  if (reason === '') {
    throw new ReverseRuleViolation('WR-21', `批次 ${input.batchNo}具名冲销必须填写理由（已入账批次纠正=高影响操作，OA-29）`)
  }
  if (input.reverseQty === '0.0000') {
    throw new ReverseRuleViolation('WR-21', `批次 ${input.batchNo}冲销数量必须大于 0`)
  }
}

/** 下游使用事实（WR-22：校验对象关系而非整单标记）。 */
export interface DownstreamUsageFacts {
  batchNo: string
  /** 已发运（IT-13 shipped） */
  shippedUnitNos: readonly string[]
  /** 已投料（存在 issue 流水） */
  issuedUnitNos: readonly string[]
  /** 调拨在途（IT-13 in_transit） */
  inTransitUnitNos: readonly string[]
  /** 已转换（形态转换消费） */
  convertedUnitNos: readonly string[]
  /** 形成生效质量结果（生效结论=qualified 的检验记录） */
  effectiveQualifiedDetailNos: readonly string[]
}

/** WR-22：下游已使用拦截——命中即拦截并转逆序冲销或隔离追溯处置。 */
export function assertNotDownstreamConsumed(facts: DownstreamUsageFacts): void {
  const hits: string[] = []
  if (facts.shippedUnitNos.length > 0) hits.push(`已发运（${facts.shippedUnitNos.join('、')}）`)
  if (facts.issuedUnitNos.length > 0) hits.push(`已投料（${facts.issuedUnitNos.join('、')}）`)
  if (facts.inTransitUnitNos.length > 0) hits.push(`调拨在途（${facts.inTransitUnitNos.join('、')}）`)
  if (facts.convertedUnitNos.length > 0) hits.push(`已转换（${facts.convertedUnitNos.join('、')}）`)
  if (facts.effectiveQualifiedDetailNos.length > 0) hits.push(`已形成生效质量结果（${facts.effectiveQualifiedDetailNos.join('、')}）`)
  if (hits.length > 0) {
    throw new ReverseRuleViolation(
      'WR-22',
      `批次 ${facts.batchNo}下游已使用（对象关系校验命中：${hits.join('；')}）：拦截删除/退货，转逆序冲销或隔离追溯处置`,
    )
  }
}

/** WR-23：退货回传重试前置——仅已退货批次；已同步侧不重做（重试不重复外部已成功步骤）。 */
export function assertReturnSyncRetryable(input: {
  batchNo: string
  storageStatus: string
  returnSyncStatus: string
}): { skipped: boolean } {
  if (input.storageStatus !== 'returned') {
    throw new ReverseRuleViolation('WR-23', `批次 ${input.batchNo}未处于已退货状态：退货回传重试仅限已退货批次（IF-10）`)
  }
  return { skipped: input.returnSyncStatus === 'synced' }
}
