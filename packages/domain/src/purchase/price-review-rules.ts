import type { DecimalString } from '@cadenza/contracts'
// 包内子目录引用被过宽的包逃逸 eslint 规则误伤（同 trace/genealogy.ts 先例，不逃逸出 domain 包）。
// eslint-disable-next-line no-restricted-imports
import { isValidQuantityString } from '../inventory/quantity'
// eslint-disable-next-line no-restricted-imports
import { sumQty } from '../inventory/posting'
import { PurchaseRuleViolation } from './errors'

/**
 * 价格复核规则 [底稿 A-10]（PRD 采购复核 §1.1/§2.1）：
 * - 收货确认时按「物料+组织」快照近 5 次已入库有单价批次 → 本批单价/历史均价/浮动=(本批−均价)/均价；
 * - 复核仅待复核且非退货批次，只改复核状态/人/时间，已复核不可撤销，不影响质检领料投料退货；
 * - 浮动 ≥ +10% 行浅红、≤ −10% 行浅绿（展示标记）。
 */

export type PriceDeviationFlag = 'up' | 'down' | null

export interface PricedBatchHistoryItem {
  batchNo: string
  price: DecimalString
  confirmTime: string
}

export interface PriceSnapshotResult {
  /** 近 5 次历史明细（时点快照，随批次固化） */
  history: PricedBatchHistoryItem[]
  /** 历史均价（无历史为 null） */
  avgPrice: DecimalString | null
  /** 浮动比例（本批相对均价，百万分比 ppm；无历史/无单价为 null） */
  deviationPpm: number | null
  /** 展示标记：≥ +10% → 'up'（浅红）；≤ −10% → 'down'（浅绿） */
  flag: PriceDeviationFlag
}

/** 历史口径截取：近 5 次（调用方按 confirm_time DESC 传入，此处截前 5）。 */
export const PRICE_HISTORY_WINDOW = 5

/** 浮动阈值（±10%，含边界；ppm 表示）。 */
export const PRICE_DEVIATION_THRESHOLD_PPM = 100_000

/**
 * [A-10] 价格快照计算：本批单价 + 近 5 次历史 → 均价/浮动/标记。
 * 本批单价为空（C-1 缺口：单价来源接口未定义）→ 快照仅存历史，均价/浮动为空、不标记。
 */
export function computePriceSnapshot(input: {
  currentPrice: DecimalString | null | undefined
  history: readonly PricedBatchHistoryItem[]
}): PriceSnapshotResult {
  const history = input.history.slice(0, PRICE_HISTORY_WINDOW)
  if (history.length === 0) {
    return { history: [], avgPrice: null, deviationPpm: null, flag: null }
  }
  const avg = averagePrice(history.map((h) => h.price))
  if (input.currentPrice === undefined || input.currentPrice === null) {
    return { history, avgPrice: avg, deviationPpm: null, flag: null }
  }
  if (!isValidQuantityString(input.currentPrice)) {
    throw new PurchaseRuleViolation('A-10', '本批单价必须为十进制定点字符串')
  }
  const deviation = deviationPpm(input.currentPrice, avg)
  const flag: PriceDeviationFlag =
    deviation >= PRICE_DEVIATION_THRESHOLD_PPM
      ? 'up'
      : deviation <= -PRICE_DEVIATION_THRESHOLD_PPM
        ? 'down'
        : null
  return { history, avgPrice: avg, deviationPpm: deviation, flag }
}

/** 均值：Σ/数量（scale=4 定点；除不尽按四舍五入到第 4 位——展示口径）。 */
function averagePrice(prices: readonly DecimalString[]): DecimalString {
  const total = sumQty(prices)
  return divQtyRound(total, prices.length)
}

/** 定点除法（scale 4，四舍五入）：仅用于价格均值展示口径。 */
function divQtyRound(a: DecimalString, divisor: number): DecimalString {
  const scaled = a.replace('.', '')
  const negative = scaled.startsWith('-')
  const digits = negative ? scaled.slice(1) : scaled
  const value = BigInt(digits) // a 已是 scale-4 定点（整数部分×10^4 + 小数）
  const d = BigInt(divisor)
  const quotient = (value * 2n + d) / (2n * d) // 四舍五入（scale-4 结果）
  const s = quotient.toString().padStart(5, '0')
  const rounded = `${s.slice(0, -4)}.${s.slice(-4)}`
  return (negative ? '-' : '') + rounded
}

/** 浮动比例 ppm = (本批 − 均价)/均价 × 1,000,000（定点近似：先放大再整除）。 */
export function deviationPpm(current: DecimalString, avg: DecimalString): number {
  const toScaled = (v: DecimalString): bigint => {
    const [int, frac = ''] = v.split('.')
    return BigInt(int + frac.padEnd(4, '0'))
  }
  const cur = toScaled(current)
  const base = toScaled(avg)
  if (base === 0n) return 0
  const diff = cur - base
  // diff/base * 1e6，四舍五入（绝对值放大后整除）
  const sign = diff < 0n ? -1n : 1n
  const ppm = (sign * diff * 1_000_000n * 2n + base) / (2n * base)
  return Number(sign * ppm)
}

/**
 * [A-10] 复核标记命令前置：复核状态为待复核，且入库状态非已退货（已复核不可撤销——
 * 不存在撤销复核路径；复核不影响质检/领料/投料/退货）。
 */
export function assertPriceReviewExecutable(input: {
  reviewStatus: 'pending' | 'reviewed'
  storageStatus: 'stored' | 'returned'
}): void {
  if (input.reviewStatus === 'reviewed') {
    throw new PurchaseRuleViolation('A-10', '该批次已复核，不可重复复核（已复核不可撤销）')
  }
  if (input.storageStatus === 'returned') {
    throw new PurchaseRuleViolation('A-10', '已退货批次不可复核')
  }
}

/** 历史合计（测试与展示口径便利）。 */
export function sumPriceHistory(prices: readonly DecimalString[]): DecimalString {
  return sumQty(prices)
}
