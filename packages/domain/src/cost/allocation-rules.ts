import { CostRuleViolation } from './errors'
import { add4, cmp4, div4, mul4, parseScaled } from './decimals'

/**
 * 分摊规则版本与分摊计算（CE-11 分摊版本化/显式重算+新旧对照、CE-12 默认口径与三级目标、
 * CE-S2 版本表枚举+参数+被引用 immutable）。
 */

/** 分摊公式（CE-12：默认工序机时占比；产量占比/功率权重为可选口径——业务取值 GAP-E21 待裁）。 */
export const ALLOCATION_FORMULAS = ['machine_hours', 'output_qty', 'power_weight'] as const
export type AllocationFormula = (typeof ALLOCATION_FORMULAS)[number]

/** 默认公式（CE-12 [合同新造·默认待裁]——PROPOSED 依赖，PM/Owner 裁定后可改走返工小轮）。 */
export const DEFAULT_ALLOCATION_FORMULA: AllocationFormula = 'machine_hours'

/** 分摊目标层级（CE-12：只到 订单/工序/产品族 三级，不生成会计科目分录）。 */
export const ALLOCATION_LEVELS = ['order', 'operation', 'product_family'] as const
export type AllocationLevel = (typeof ALLOCATION_LEVELS)[number]

export interface AllocationVersionShapeInput {
  versionNo: number
  formula: string
  params?: Record<string, unknown> | null
}

/** CE-S2/CE-12：版本形状（版本号≥1、公式枚举、参数与公式匹配）。 */
export function assertAllocationVersionShape(input: AllocationVersionShapeInput): void {
  if (!Number.isInteger(input.versionNo) || input.versionNo < 1) {
    throw new CostRuleViolation('CE-S2', `分摊版本号必须为正整数：${String(input.versionNo)}`)
  }
  if (!ALLOCATION_FORMULAS.includes(input.formula as AllocationFormula)) {
    throw new CostRuleViolation('CE-S2', `分摊公式必须为 machine_hours/output_qty/power_weight：${input.formula}`)
  }
  const params = input.params ?? {}
  if (params !== null && typeof params !== 'object') {
    throw new CostRuleViolation('CE-S2', '分摊参数必须为对象（params）')
  }
  if (input.formula === 'power_weight') {
    // 功率权重口径：参数须为 设备ID→正权重 的非空映射（CE-12 可选口径）
    const weights = params['weights']
    if (weights === undefined || weights === null || typeof weights !== 'object' || Array.isArray(weights)) {
      throw new CostRuleViolation('CE-S2', 'power_weight 公式必须提供 weights 参数（设备→权重映射）')
    }
    const entries = Object.entries(weights as Record<string, unknown>)
    if (entries.length === 0) throw new CostRuleViolation('CE-S2', 'weights 参数不得为空映射')
    for (const [key, value] of entries) {
      if (typeof value !== 'string' || parseScaled(value, 'CE-S2') <= 0n) {
        throw new CostRuleViolation('CE-S2', `weights[${key}] 必须为正十进制字符串权重`)
      }
    }
  } else {
    const known = Object.keys(params)
    if (known.length > 0) {
      throw new CostRuleViolation('CE-S2', `${input.formula} 公式不接受参数（仅 power_weight 需要 weights）`)
    }
  }
}

export interface AllocationShareLine {
  key: string
  /** 占比基（机时/产量/权重值；正数） */
  share: string
}

export interface AllocationResultLine {
  key: string
  amount: string
}

/**
 * CE-12：按占比基分摊总量到目标（份额和>0）；金额 scale=4 half-up，
 * 舍入余量归最大份额目标（保证分摊和恒等于总量，无静默丢失）。
 */
export function allocateByShares(total: string, shares: readonly AllocationShareLine[]): AllocationResultLine[] {
  if (shares.length === 0) return []
  for (const s of shares) {
    if (parseScaled(s.share, 'CE-12') <= 0n) {
      throw new CostRuleViolation('CE-S2', `占比基必须为正数：${s.key}=${s.share}`)
    }
  }
  const shareSum = shares.reduce((acc, s) => add4(acc, s.share, 'CE-12'), '0.0000')
  if (cmp4(shareSum, '0.0000', 'CE-12') <= 0) {
    throw new CostRuleViolation('CE-12', '占比基合计必须为正数（无占用则无从分摊）')
  }
  const lines: AllocationResultLine[] = shares.map((s) => ({
    key: s.key,
    amount: mul4(total, div4(s.share, shareSum, 'CE-12'), 'CE-12'),
  }))
  // 舍入余量归最大份额目标：分摊和与总量差补到最大份额行
  const allocatedSum = lines.reduce((acc, l) => add4(acc, l.amount, 'CE-12'), '0.0000')
  const remainder = parseScaled(total, 'CE-12') - parseScaled(allocatedSum, 'CE-12')
  if (remainder !== 0n) {
    let maxIdx = 0
    for (const [i, s] of shares.entries()) {
      if (cmp4(s.share, shares[maxIdx]!.share, 'CE-12') > 0) maxIdx = i
    }
    const patched = parseScaled(lines[maxIdx]!.amount, 'CE-12') + remainder
    const negative = patched < 0n
    const abs = negative ? -patched : patched
    const intPart = abs / 10000n
    const fracPart = (abs % 10000n).toString().padStart(4, '0')
    lines[maxIdx] = { key: lines[maxIdx]!.key, amount: `${negative ? '-' : ''}${intPart}.${fracPart}` }
  }
  return lines
}

export interface RunSummaryCompare {
  runId: string
  estimateAmount: string | null
  actualAmount: string | null
  lineCount: number
  energyUsage: string
  machineHours: string
}

/** CE-11：显式重算输出新旧对照（金额/用量/行数逐项对比；差异列为差值而非覆盖）。 */
export function buildOldNewComparison(oldRun: RunSummaryCompare, newRun: RunSummaryCompare): {
  dimensions: Array<{ dimension: string; old: string; new: string; diff: string | null }>
} {
  const diffOf = (a: string | null, b: string | null): string | null => {
    if (a === null || b === null) return null
    const d = parseScaled(a, 'CE-11') - parseScaled(b, 'CE-11')
    const negative = d < 0n
    const abs = negative ? -d : d
    return `${negative ? '-' : ''}${abs / 10000n}.${(abs % 10000n).toString().padStart(4, '0')}`
  }
  return {
    dimensions: [
      { dimension: 'estimateAmount', old: oldRun.estimateAmount ?? '', new: newRun.estimateAmount ?? '', diff: diffOf(oldRun.estimateAmount, newRun.estimateAmount) },
      { dimension: 'actualAmount', old: oldRun.actualAmount ?? '', new: newRun.actualAmount ?? '', diff: diffOf(oldRun.actualAmount, newRun.actualAmount) },
      { dimension: 'energyUsage', old: oldRun.energyUsage, new: newRun.energyUsage, diff: diffOf(oldRun.energyUsage, newRun.energyUsage) },
      { dimension: 'machineHours', old: oldRun.machineHours, new: newRun.machineHours, diff: diffOf(oldRun.machineHours, newRun.machineHours) },
      { dimension: 'lineCount', old: String(oldRun.lineCount), new: String(newRun.lineCount), diff: null },
    ],
  }
}
