import { SpcRuleViolation } from './errors'
import type { SpcCalibrationStatus } from './spc-rules'

/**
 * 计量器具校准与失准影响范围纯规则（冻结合同 §4：PE-15～PE-19）+
 * 校准与排产/采集联动（PE-17：检测类任务不排产为 CS-05 硬约束③ 的排产侧等价服务）。
 */

// ---------------- PE-15：校准记录 ----------------

/** 校准结果：qualified 合格 / limited 限用 / failed 失准。 */
export const SPC_CALIBRATION_RESULTS = ['qualified', 'limited', 'failed'] as const
export type SpcCalibrationResult = (typeof SPC_CALIBRATION_RESULTS)[number]

export const SPC_CALIBRATION_RESULT_LABELS: Readonly<Record<SpcCalibrationResult, string>> = {
  qualified: '合格',
  limited: '限用',
  failed: '失准',
}

/** PE-15 校准记录形状：器具身份、校准日期、校准结果、证书编号、有效期至、校准依据。 */
export function assertCalibrationRecordShape(input: {
  gaugeId: string
  calibratedAt: string
  result: string
  certificateNo: string
  validUntil: string
  basis: string
}): void {
  if (!(input.gaugeId ?? '').trim()) throw new SpcRuleViolation('PE-15', '校准记录必须绑定计量器具身份（gauge_id）')
  if (!input.calibratedAt || Number.isNaN(Date.parse(input.calibratedAt))) {
    throw new SpcRuleViolation('PE-15', '校准记录必须携带校准日期（calibrated_at，可解析时间）')
  }
  if (!SPC_CALIBRATION_RESULTS.includes(input.result as SpcCalibrationResult)) {
    throw new SpcRuleViolation('PE-15', `校准结果非法：${input.result}（须为 合格/限用/失准）`)
  }
  if (!(input.certificateNo ?? '').trim()) throw new SpcRuleViolation('PE-15', '校准记录必须携带证书编号')
  if (!input.validUntil || Number.isNaN(Date.parse(input.validUntil))) {
    throw new SpcRuleViolation('PE-15', '校准记录必须携带有效期至（valid_until，可解析时间）')
  }
  if (!(input.basis ?? '').trim()) throw new SpcRuleViolation('PE-15', '校准记录必须携带校准依据')
}

/**
 * PE-15 追加式口径：新校准不改写旧记录——记录行 append-only（库级守卫），
 * 域侧以显式断言兜底（任何"更新校准记录"入口直接拒绝）。
 */
export function assertCalibrationRecordAppendOnly(): void {
  throw new SpcRuleViolation('PE-15', '校准记录为追加式（append-only）：新校准须追加新记录，不得改写旧记录')
}

// ---------------- PE-16：实测绑定器具状态（时点快照） ----------------

export interface CalibrationRecordFact {
  calibratedAt: string
  result: SpcCalibrationResult
  validUntil: string
}

/**
 * PE-16 采样时点校准状态：取校准日期 ≤ 采样时点的最新一条记录判定——
 * 失准 → invalid；合格且未过有效期 → valid；合格但已过有效期 → expired；
 * 限用 → limited（限用期内出具仍可参与，但快照留痕）；无更早记录 → unknown。
 */
export function calibrationStatusAt(
  records: readonly CalibrationRecordFact[],
  at: string,
): SpcCalibrationStatus {
  const atMs = Date.parse(at)
  if (Number.isNaN(atMs)) throw new SpcRuleViolation('PE-16', '采样时点必须是可解析时间')
  const sorted = [...records]
    .filter((r) => Date.parse(r.calibratedAt) <= atMs)
    .sort((a, b) => Date.parse(b.calibratedAt) - Date.parse(a.calibratedAt))
  const latest = sorted[0]
  if (latest === undefined) return 'unknown'
  if (latest.result === 'failed') return 'invalid'
  if (latest.result === 'limited') return 'limited'
  return atMs <= Date.parse(latest.validUntil) ? 'valid' : 'expired'
}

/** PE-16：校准失效后出具的测量不得以有效校准状态参与判定（准入侧由 PE-11 承接）。 */
export function assertCalibrationValidForJudgement(status: SpcCalibrationStatus, gaugeLabel: string): void {
  if (status === 'invalid' || status === 'expired' || status === 'unknown') {
    throw new SpcRuleViolation(
      'PE-16',
      `器具 ${gaugeLabel} 出具测量时校准状态为 ${status}：校准失效后出具的测量不得以有效校准状态参与判定`,
    )
  }
}

// ---------------- PE-17：校准与排产/采集联动 ----------------

/**
 * PE-17 排产侧等价服务（CS-05 硬约束③）：校准过期或失准期间——检测类任务不排产。
 * 排产域（scheduling）属共享域不自改，本规则由 spc 查询面暴露
 * （gaugeDetail.schedulableForInspection），L0 整合时收编进排产前置。
 */
export function assertGaugeSchedulableForInspection(status: SpcCalibrationStatus, gaugeLabel: string): void {
  if (status === 'invalid' || status === 'expired' || status === 'unknown') {
    throw new SpcRuleViolation(
      'PE-17',
      `器具 ${gaugeLabel} 校准状态为 ${status}（过期/失准/无记录）：检测类任务不得排产（CS-05 硬约束③）`,
    )
  }
}

/** PE-17 查询口径：检测类任务可排产判定（invalid/expired/unknown → false）。 */
export function isGaugeSchedulableForInspection(status: SpcCalibrationStatus): boolean {
  return status === 'valid' || status === 'limited'
}

// ---------------- PE-18：失准影响圈定（追溯清单） ----------------

export interface CircleMeasurementFact {
  sampleId: string
  source: string
  sampledAt: string
  measuredValue: string
  admission: string
  testResultId: string | null
  productionOrderNo: string | null
  operationSeq: number | null
  inventoryUnitId: string | null
  unitNo: string | null
  lotNo: string | null
}

export interface CircleTestResultFact {
  testResultId: string
  conclusion: string
  inspectedAt: string | null
  inspector: string | null
  inspectionOrderNo: string
  inspectionOrderStatus: string
  productionOrderNo: string | null
  /** 关联生产订单状态（仓储侧补全；closed/voided 之外的订单计入在制 PE-18）。 */
  productionOrderStatus: string | null
  inventoryUnitId: string | null
  unitNo: string | null
  lotNo: string | null
  lotId: string | null
  materialCode: string | null
  releasedBy: string | null
  releasedAt: string | null
  releaseKind: string | null
}

export interface CircleUnitFact {
  inventoryUnitId: string
  unitNo: string
  status: string
  lotNo: string | null
  materialCode: string | null
  productionOrderNo: string | null
  productionOrderStatus: string | null
}

export interface MiscalibrationCircleResult {
  /** 该时段该器具出具的全部实测（含被拒样本，标注 admission）。 */
  measurements: CircleMeasurementFact[]
  /** 关联检验结论（人工来源样本 → quality_test_result → 检验单结论）。 */
  inspectionConclusions: CircleTestResultFact[]
  /** 关联放行/让步（quality_disposition）。 */
  releases: Array<{ testResultId: string; releasedBy: string | null; releasedAt: string | null; releaseKind: string | null }>
  /** 关联批次/轴段清单。 */
  lots: Array<{ lotNo: string | null; unitNo: string | null; materialCode: string | null }>
  /** 在制清单（未结束生产订单）。 */
  wipOrders: string[]
  /** 库存清单（在库/在途单元）。 */
  stockUnits: CircleUnitFact[]
  /** 已发运清单（→ 客诉/召回提示范围 PE-19）。 */
  shippedUnits: CircleUnitFact[]
  /** 客诉/召回提示（已发运项进入提示范围）。 */
  customerComplaintHints: Array<{ unitNo: string; productionOrderNo: string | null }>
}

/**
 * PE-18 失准圈定（[合同新造] 圈定算法，可判定口径）：
 * 给定 失准器具＋失准时段，从 实测 → 检验结论/放行 → 批次/轴段/在制/库存/已发运
 * 逐层圈定；输出为只读追溯清单，不自动改写质量结论（PE-S4：可重建查询视图，
 * 不落地为可改写表）。units = 时段内样本/结论引用到的库存单元事实（仓储侧补全）。
 */
export function buildMiscalibrationCircle(input: {
  windowFrom: string
  windowTo: string
  measurements: readonly CircleMeasurementFact[]
  testResults: readonly CircleTestResultFact[]
  units: readonly CircleUnitFact[]
}): MiscalibrationCircleResult {
  const fromMs = Date.parse(input.windowFrom)
  const toMs = Date.parse(input.windowTo)
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    throw new SpcRuleViolation('PE-18', '失准时段起止必须是可解析时间')
  }
  if (fromMs > toMs) {
    throw new SpcRuleViolation('PE-18', '失准时段起点晚于终点（from ≤ to）')
  }
  const inWindow = input.measurements.filter((m) => {
    const ms = Date.parse(m.sampledAt)
    return !Number.isNaN(ms) && ms >= fromMs && ms <= toMs
  })
  const resultMap = new Map(input.testResults.map((t) => [t.testResultId, t]))
  const conclusions: CircleTestResultFact[] = []
  const releases: MiscalibrationCircleResult['releases'] = []
  const lotSet = new Map<string, { lotNo: string | null; unitNo: string | null; materialCode: string | null }>()
  const wipSet = new Set<string>()
  const stockUnits: CircleUnitFact[] = []
  const shippedUnits: CircleUnitFact[] = []

  for (const m of inWindow) {
    if (m.testResultId !== null) {
      const tr = resultMap.get(m.testResultId)
      if (tr !== undefined) {
        conclusions.push(tr)
        if (tr.releasedBy !== null) {
          releases.push({
            testResultId: tr.testResultId,
            releasedBy: tr.releasedBy,
            releasedAt: tr.releasedAt,
            releaseKind: tr.releaseKind,
          })
        }
      }
    }
    if (m.lotNo !== null || m.unitNo !== null) {
      lotSet.set(`${m.lotNo ?? ''}|${m.unitNo ?? ''}`, {
        lotNo: m.lotNo,
        unitNo: m.unitNo,
        materialCode: null,
      })
    }
  }
  // 检验结论层：未结束生产订单 → 在制；批次/轴段/物料汇总
  for (const tr of conclusions) {
    if (
      tr.productionOrderNo !== null &&
      tr.productionOrderNo !== '' &&
      tr.productionOrderStatus !== 'closed' &&
      tr.productionOrderStatus !== 'voided'
    ) {
      wipSet.add(tr.productionOrderNo)
    }
    if (tr.lotNo !== null || tr.unitNo !== null) {
      lotSet.set(`${tr.lotNo ?? ''}|${tr.unitNo ?? ''}`, {
        lotNo: tr.lotNo,
        unitNo: tr.unitNo,
        materialCode: tr.materialCode,
      })
    }
  }
  // 单元层分桶：已发运（→ 客诉/召回提示范围 PE-19）/ 库存（在库、在途）
  for (const unit of input.units) {
    if (unit.status === 'shipped') shippedUnits.push(unit)
    else stockUnits.push(unit)
  }
  return {
    measurements: inWindow,
    inspectionConclusions: conclusions,
    releases,
    lots: [...lotSet.values()],
    wipOrders: [...wipSet],
    stockUnits,
    shippedUnits,
    customerComplaintHints: shippedUnits.map((u) => ({
      unitNo: u.unitNo,
      productionOrderNo: u.productionOrderNo,
    })),
  }
}

// ---------------- PE-19：失准处置 ----------------

/** 失准处置动作（圈定后逐项走质量处置 T18：隔离/复检/让步/返工报废）。 */
export const SPC_MISCALIBRATION_ACTION_KINDS = ['isolation', 'retest', 'concession', 'rework_scrap'] as const
export type SpcMiscalibrationActionKind = (typeof SPC_MISCALIBRATION_ACTION_KINDS)[number]

export const SPC_MISCALIBRATION_ACTION_LABELS: Readonly<Record<SpcMiscalibrationActionKind, string>> = {
  isolation: '隔离',
  retest: '复检',
  concession: '让步',
  rework_scrap: '返工/报废',
}

/** 圈定项种类（追溯链各层）。 */
export const SPC_CIRCLE_ITEM_KINDS = [
  'measurement',
  'inspection_conclusion',
  'release',
  'lot',
  'wip_order',
  'stock_unit',
  'shipped_unit',
] as const
export type SpcCircleItemKind = (typeof SPC_CIRCLE_ITEM_KINDS)[number]

/** PE-19 失准处置记录形状：逐项处置动作 + 引用；处置完成前圈定清单不得删除（记录 append-only 天然满足）。 */
export function assertMiscalibrationActionShape(input: {
  actionKind: string
  itemKind: string
  itemRef: string
}): void {
  if (!SPC_MISCALIBRATION_ACTION_KINDS.includes(input.actionKind as SpcMiscalibrationActionKind)) {
    throw new SpcRuleViolation(
      'PE-19',
      `失准处置动作非法：${input.actionKind}（须为 隔离/复检/让步/返工报废）`,
    )
  }
  if (!SPC_CIRCLE_ITEM_KINDS.includes(input.itemKind as SpcCircleItemKind)) {
    throw new SpcRuleViolation('PE-19', `圈定项种类非法：${input.itemKind}`)
  }
  if (!(input.itemRef ?? '').trim()) throw new SpcRuleViolation('PE-19', '失准处置必须携带圈定项引用（item_ref）')
}

/** PE-19 已发运项处置：进入客诉/召回提示范围（提示标记，不自动发起到客诉域）。 */
export function markShippedItemComplaintHint(itemKind: SpcCircleItemKind): boolean {
  return itemKind === 'shipped_unit'
}
