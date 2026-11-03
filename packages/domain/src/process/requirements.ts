import type { DecimalString } from '@cadenza/contracts'
import { ProcessRuleViolation } from './errors'
import {
  assertCoreMultiple,
  assertOfflineQty,
  assertOrderQty,
  assertStrandFactor,
  formatProcessScaled,
  mulProcessQty,
  mulProcessQtyByInt,
  toProcessScaled,
} from './quantity'

/**
 * 工序需求推导 —— [底稿 A2-1]（PRD 生产订单 §2.1 工序设置 + DM §4.1）。
 *
 * 公式（DM §4.1 样例：1000m × 3 × 1.02 = 3060m）：
 * - 末道下线数量 = 订单产量 × 末道芯倍数 × 末道绞合系数；
 * - 非末道下线数量 = 下一道（下游）下线量 × 本道芯倍数 × 本道绞合；
 * - 绞合未填（null）→ 该行跳过重算，保留现有下线数量；其上游行以该保留值为下游量继续递推；
 * - 变更后自末道向上游递推；
 * - 结果仅用于备料/排程，不生成库存账；损耗/余量必须独立命名、受版本控制，
 *   不得并入绞合系数（本公式输入仅 产量/芯倍数/绞合，结构上无损耗参数位）。
 *
 * operations 按 seq 升序传入（末道 = 最后一个元素）。
 */

export interface OperationRequirementInput {
  /** 工序顺序（≥1，数组内严格递增） */
  seq: number
  /** 芯倍数（正整数必填；新增行默认 1） */
  coreMultiple: number
  /** 绞合系数（选填；null=未填该行跳过重算；新增行默认 1 口径由调用方落库，推导时按未填处理） */
  strandFactor: DecimalString | null
  /** 现有下线数量（绞合未填或行被冻结时保留此值；新增行默认 = 订单产量） */
  currentOfflineQty: DecimalString
  /**
   * 冻结行（已执行实绩，[底稿 A2-4] 变更版本）：保留原值不参与重算，
   * 其上游以该保留值为下游量继续递推。接收展开时全部 false。
   */
  frozen?: boolean
}

export interface OperationRequirementResult {
  seq: number
  /** 推导后的下线数量（保留行=原值） */
  offlineQty: DecimalString
  /** true=该行未重算（绞合未填或冻结行，保留原值） */
  kept: boolean
}

export function computeOperationRequirements(input: {
  orderQty: DecimalString
  operations: readonly OperationRequirementInput[]
}): OperationRequirementResult[] {
  assertOrderQty(input.orderQty, '订单产量')
  if (input.operations.length === 0) return []

  let prevSeq = 0
  for (const op of input.operations) {
    if (!Number.isInteger(op.seq) || op.seq < 1 || op.seq <= prevSeq) {
      throw new ProcessRuleViolation('A2-1', `工序顺序必须为 ≥1 且严格递增的正整数（收到 seq=${String(op.seq)}）`)
    }
    prevSeq = op.seq
    assertCoreMultiple(op.coreMultiple, `工序 ${op.seq}`)
    assertStrandFactor(op.strandFactor, `工序 ${op.seq}`)
    assertOfflineQty(op.currentOfflineQty, `工序 ${op.seq}`)
  }

  // 自末道向上游递推（数组尾部 = 末道）
  const results: OperationRequirementResult[] = new Array(input.operations.length)
  let downstreamQty: DecimalString = input.orderQty
  for (let i = input.operations.length - 1; i >= 0; i -= 1) {
    const op = input.operations[i]!
    if (op.frozen === true || op.strandFactor === null) {
      // 冻结行（实绩保留原版本）或绞合未填：跳过重算，保留现有下线数量（统一 scale=4 输出）
      const keptQty = formatProcessScaled(
        toProcessScaled(op.currentOfflineQty, `工序 ${op.seq} 下线数量`),
      )
      results[i] = { seq: op.seq, offlineQty: keptQty, kept: true }
      downstreamQty = keptQty
      continue
    }
    // 下线数量 = 下游量 × 本道芯倍数（精确）× 本道绞合（4 位小数半入）
    const afterCore = mulProcessQtyByInt(downstreamQty, op.coreMultiple, `工序 ${op.seq}`)
    const offlineQty = mulProcessQty(afterCore, op.strandFactor, `工序 ${op.seq}`)
    results[i] = { seq: op.seq, offlineQty, kept: false }
    downstreamQty = offlineQty
  }
  return results
}
