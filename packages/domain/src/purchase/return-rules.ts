import { PurchaseRuleViolation } from './errors'
import type { BatchInspectionStatus } from './inspection-rules'

/**
 * 采购退货规则 [底稿 A-9]（PRD 采购批次 §2.1 退货逻辑）：
 * 仅批次质检状态为全部不合格且未退货时可执行；执行=入库状态已退货+入库数量置 0+
 * 扣订单行已收并重算+回写库存（反向流水）+触发退货同步（A-11/IF-10）。
 */

/** 退货可执行前置 [A-9]：全部不合格且未退货。 */
export function assertReturnExecutable(input: {
  batchInspectionStatus: BatchInspectionStatus
  storageStatus: 'stored' | 'returned'
}): void {
  if (input.storageStatus === 'returned') {
    throw new PurchaseRuleViolation('A-9', '该批次已退货，不可重复退货')
  }
  if (input.batchInspectionStatus !== 'all_unqualified') {
    throw new PurchaseRuleViolation(
      'A-9',
      `退货仅对批次质检状态为全部不合格的批次可执行，当前为 ${input.batchInspectionStatus}`,
    )
  }
}

/** 退货备注必填（PRD 退货弹窗：退货备注必填、最长 200）。 */
export function assertReturnReasonPresent(reason: string | undefined | null): void {
  if (reason === undefined || reason === null || reason.trim() === '') {
    throw new PurchaseRuleViolation('A-9', '退货备注必填（最长 200 字）')
  }
  if (reason.length > 200) {
    throw new PurchaseRuleViolation('A-9', '退货备注最长 200 字')
  }
}
