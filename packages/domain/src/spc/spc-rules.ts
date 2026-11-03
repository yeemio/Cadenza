import type { DecimalString } from '@cadenza/contracts'
import { SpcRuleViolation } from './errors'
import { formatLimitValue, parseLimitValue, toSpcScaled } from './quantity'

/**
 * SPC 规则集/控制限/样本准入/判异纯规则（冻结合同 §3：PE-08～PE-14）。
 *
 * PE-13 边界（SPC 与放行）：本域无任何放行/隔离命令面——SPC 结论仅作为质量证据
 * 输入；失控任务只携带"质量存疑"级提示（qualityDoubtHint），挂起动作与解除权限
 * 属 CA-9 待裁。质量放行/隔离结论只能出自质量域（T12/T18）人工判定或让步流程。
 */

// ---------------- PE-09：规则集 ----------------

/** 控制图类型（常规控制图族子集）。 */
export const SPC_CHART_TYPES = ['xbar_r', 'i_mr', 'p'] as const
export type SpcChartType = (typeof SPC_CHART_TYPES)[number]

/** 判异准则代码（常规判异准则族子集选用，PE-09）。 */
export const SPC_CRITERIA_CODES = ['point_beyond_limits', 'run_same_side_6', 'trend_6'] as const
export type SpcCriterionCode = (typeof SPC_CRITERIA_CODES)[number]

export const SPC_CRITERIA_LABELS: Readonly<Record<SpcCriterionCode, string>> = {
  point_beyond_limits: '单点越限',
  run_same_side_6: '连续 6 点同侧',
  trend_6: '连续 6 点趋势',
}

/**
 * PE-09 默认规则集：现场未选定前按默认子集（单点越限＋连续 6 点同侧）运行
 * 并标注"默认规则集"（采用版本 → GAP-E14）。
 */
export const DEFAULT_SPC_CRITERIA: readonly SpcCriterionCode[] = ['point_beyond_limits', 'run_same_side_6']

/** 默认规则集名（应用层按工厂懒建，is_default=true 标注）。 */
export const DEFAULT_RULE_SET_NAME = '__default__'

/** 规则集状态：draft → published → retired（发布后内容不可改，PE-S2）。 */
export const SPC_RULE_SET_STATUSES = ['draft', 'published', 'retired'] as const
export type SpcRuleSetStatus = (typeof SPC_RULE_SET_STATUSES)[number]

/** PE-09 规则集形状：名称/版本/图型/判异准则子集（非空、无未知码、无重复）。 */
export function assertRuleSetShape(input: {
  name: string
  version: number
  chartType: string
  criteria: readonly string[]
}): void {
  if (!(input.name ?? '').trim()) throw new SpcRuleViolation('PE-09', '规则集名称不可为空')
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new SpcRuleViolation('PE-09', `规则集版本必须为正整数：${String(input.version)}`)
  }
  if (!SPC_CHART_TYPES.includes(input.chartType as SpcChartType)) {
    throw new SpcRuleViolation('PE-09', `控制图类型非法：${input.chartType}（须为 ${SPC_CHART_TYPES.join('/')}）`)
  }
  if (input.criteria.length === 0) {
    throw new SpcRuleViolation('PE-09', '规则集至少选用一条判异准则（可解释准则族子集）')
  }
  const seen = new Set<string>()
  for (const code of input.criteria) {
    if (!SPC_CRITERIA_CODES.includes(code as SpcCriterionCode)) {
      throw new SpcRuleViolation('PE-09', `判异准则代码非法：${code}（可选 ${SPC_CRITERIA_CODES.join('/')}）`)
    }
    if (seen.has(code)) throw new SpcRuleViolation('PE-09', `判异准则重复选用：${code}`)
    seen.add(code)
  }
}

/** PE-S2 被引用版本 immutable：published 内容不可改、retired 终态。 */
export function assertRuleSetMutable(status: SpcRuleSetStatus): void {
  if (status === 'published') {
    throw new SpcRuleViolation('PE-S2', '已发布规则集版本内容不可修改（版本化配置，变更走新版本）')
  }
  if (status === 'retired') {
    throw new SpcRuleViolation('PE-S2', '已失效规则集版本为终态，不可修改')
  }
}

/** 发布前置：draft 可发布；published 不可重复发布；retired 拒绝。 */
export function assertRuleSetPublishable(status: SpcRuleSetStatus): void {
  if (status === 'published') throw new SpcRuleViolation('PE-S2', '规则集版本已发布，不可重复发布')
  if (status === 'retired') throw new SpcRuleViolation('PE-S2', '已失效规则集版本不可发布')
}

// ---------------- PE-08：受控项目 ----------------

/**
 * PE-08 受控项目形状：受控参数 = 检验规范版本（inspection_plan_revision）中的
 * 计量型特性；清单随检验规范版本冻结（specCode+specVersion+itemNo 唯一）；
 * 可选挂接采集点位（OT-13 关联，P3-A 并行未落地前为文本引用）。
 */
export function assertControlItemShape(input: {
  specCode: string
  specVersion: number
  itemNo: string
  pointRef?: string | null
}): void {
  if (!(input.specCode ?? '').trim()) {
    throw new SpcRuleViolation('PE-08', '受控项目必须引用检验规范编码（spec_code，版本化冻结）')
  }
  if (!Number.isInteger(input.specVersion) || input.specVersion < 1) {
    throw new SpcRuleViolation('PE-08', `受控项目必须引用检验规范版本（spec_version ≥ 1）：${String(input.specVersion)}`)
  }
  if (!(input.itemNo ?? '').trim()) {
    throw new SpcRuleViolation('PE-08', '受控项目必须指向规范中的计量型特性项号（item_no）')
  }
}

// ---------------- PE-10：控制限版本 ----------------

/** 控制限计算口径（±3σ、以首 n 组建立；GAP-E15 现场口径待裁，默认 mean_pm_3sigma）。 */
export const SPC_LIMIT_METHODS = ['mean_pm_3sigma'] as const
export type SpcLimitMethod = (typeof SPC_LIMIT_METHODS)[number]

/** 控制限重算触发（PE-10）：初始建立 / 规则集变更 / 工艺变更生效 / 校准变更。 */
export const SPC_LIMIT_TRIGGER_KINDS = ['initial', 'rule_set_change', 'process_change', 'calibration_change'] as const
export type SpcLimitTriggerKind = (typeof SPC_LIMIT_TRIGGER_KINDS)[number]

/** 控制限版本状态：building（首 n 组未集齐）→ active（已建立）。 */
export const SPC_LIMIT_STATUSES = ['building', 'active'] as const
export type SpcLimitStatus = (typeof SPC_LIMIT_STATUSES)[number]

export interface ComputedControlLimits {
  cl: string
  ucl: string
  lcl: string
}

/**
 * PE-10 控制限计算：口径 mean_pm_3sigma（CL=均值，UCL/LCL=CL±3σ，样本标准差），
 * 以首 n 组（baselineCount）已准入样本建立；样本不足返回 null（版本落 building）。
 */
export function computeControlLimits(input: {
  method: string
  baselineCount: number
  values: readonly DecimalString[]
}): ComputedControlLimits | null {
  if (!SPC_LIMIT_METHODS.includes(input.method as SpcLimitMethod)) {
    throw new SpcRuleViolation('PE-10', `控制限计算口径非法：${input.method}（当前支持 mean_pm_3sigma）`)
  }
  if (!Number.isInteger(input.baselineCount) || input.baselineCount < 2) {
    throw new SpcRuleViolation('PE-10', `基线组数必须为 ≥2 的整数（首 n 组建立控制限）：${String(input.baselineCount)}`)
  }
  if (input.values.length < input.baselineCount) return null
  const baseline = input.values.slice(0, input.baselineCount).map((v) => {
    const scaled = toSpcScaled(v, '测量值')
    if (scaled < 0n) throw new SpcRuleViolation('PE-11', 'SPC 测量值不得为负')
    return Number(v)
  })
  const n = baseline.length
  const mean = baseline.reduce((s, v) => s + v, 0) / n
  const variance = baseline.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (n - 1)
  const sigma = Math.sqrt(variance)
  return {
    cl: formatLimitValue(mean),
    ucl: formatLimitValue(mean + 3 * sigma),
    lcl: formatLimitValue(mean - 3 * sigma),
  }
}

/** PE-S2：控制限版本 immutable（历史点位不随控制限重算改标，重算走新版本行）。 */
export function assertControlLimitVersionImmutable(): void {
  throw new SpcRuleViolation('PE-S2', '控制限版本行不可修改（历史点位保留判定时点所依据的版本；重算生成新版本）')
}

// ---------------- PE-11/PE-16：样本准入 ----------------

/** 样本来源：manual_inspection=人工检验实测值；collection=合格采集样本（OT-11/12）。 */
export const SPC_SAMPLE_SOURCES = ['manual_inspection', 'collection'] as const
export type SpcSampleSource = (typeof SPC_SAMPLE_SOURCES)[number]

/** 样本拒绝原因（PE-11：坏点/时钟偏差/校准状态可疑不入 SPC）。 */
export const SPC_SAMPLE_REJECT_REASONS = [
  'bad_point',
  'clock_deviation',
  'calibration_suspect',
  'quality_code_not_good',
  'test_result_missing',
] as const
export type SpcSampleRejectReason = (typeof SPC_SAMPLE_REJECT_REASONS)[number]

/** 校准状态（PE-16/17 时点快照口径）。 */
export const SPC_CALIBRATION_STATUSES = ['valid', 'limited', 'invalid', 'expired', 'unknown'] as const
export type SpcCalibrationStatus = (typeof SPC_CALIBRATION_STATUSES)[number]

export interface SampleAdmissionFacts {
  source: SpcSampleSource
  /** 人工来源：引用的检验实测结果（quality_test_result id）。 */
  testResultRef: string | null
  /** 采集来源：采集质量码（OT-11）。 */
  qualityCode: string | null
  /** 出具器具（PE-16：随实测保存；采集来源必填）。 */
  gaugeId: string | null
  /** 采样时点校准状态快照（PE-16/17）。 */
  calibrationStatus: SpcCalibrationStatus | null
  /** 坏点标记（OT-20）。 */
  badPoint: boolean
  /** 时钟偏差样本标记（OT-21）。 */
  clockDeviation: boolean
}

export interface SampleAdmissionDecision {
  admitted: boolean
  rejectReason: SpcSampleRejectReason | null
}

/**
 * PE-11 样本准入：SPC 样本 = 人工检验实测值（须引用既有实测结果）＋ 合格采集样本
 * （质量码 good 且校准状态有效）；坏点、时钟偏差样本、校准状态可疑样本不得入 SPC。
 * 人工来源的器具绑定沿用 PE-16 时点快照（绑定则须非失效）。
 */
export function evaluateSampleAdmission(facts: SampleAdmissionFacts): SampleAdmissionDecision {
  if (facts.badPoint) return { admitted: false, rejectReason: 'bad_point' }
  if (facts.clockDeviation) return { admitted: false, rejectReason: 'clock_deviation' }
  if (facts.calibrationStatus === 'invalid' || facts.calibrationStatus === 'expired' || facts.calibrationStatus === 'unknown') {
    return { admitted: false, rejectReason: 'calibration_suspect' }
  }
  if (facts.source === 'manual_inspection') {
    if (!facts.testResultRef) return { admitted: false, rejectReason: 'test_result_missing' }
    return { admitted: true, rejectReason: null }
  }
  if (facts.qualityCode !== 'good') return { admitted: false, rejectReason: 'quality_code_not_good' }
  if (!facts.gaugeId) return { admitted: false, rejectReason: 'calibration_suspect' }
  return { admitted: true, rejectReason: null }
}

// ---------------- PE-12：判异准则求值 ----------------

export interface SpcPointInput {
  /** 测量值（4 位定点字符串）。 */
  value: DecimalString
  cl: string
  ucl: string
  lcl: string
}

export interface SpcCriterionViolation {
  code: SpcCriterionCode
  /** 覆盖的连续点位区间（下标，含端点）。 */
  fromIndex: number
  toIndex: number
}

/**
 * PE-09/PE-12 判异求值（可解释准则）：对已判点位序列运行准则子集，
 * 返回命中区间。单点判定时取 toIndex == 末位的命中。
 * - point_beyond_limits：单点越限（> UCL 或 < LCL）；
 * - run_same_side_6：连续 6 点位于 CL 同侧（=CL 中断连run）；
 * - trend_6：连续 6 点严格单调递增或递减。
 */
export function evaluateSpcCriteria(input: {
  criteria: readonly string[]
  points: readonly SpcPointInput[]
}): SpcCriterionViolation[] {
  for (const code of input.criteria) {
    if (!SPC_CRITERIA_CODES.includes(code as SpcCriterionCode)) {
      throw new SpcRuleViolation('PE-09', `判异准则代码非法：${code}`)
    }
  }
  const violations: SpcCriterionViolation[] = []
  const numeric = input.points.map((p) => ({
    value: Number(p.value),
    cl: parseLimitValue(p.cl, 'CL'),
    ucl: parseLimitValue(p.ucl, 'UCL'),
    lcl: parseLimitValue(p.lcl, 'LCL'),
  }))
  if (input.criteria.includes('point_beyond_limits')) {
    numeric.forEach((p, i) => {
      if (p.value > p.ucl || p.value < p.lcl) {
        violations.push({ code: 'point_beyond_limits', fromIndex: i, toIndex: i })
      }
    })
  }
  if (input.criteria.includes('run_same_side_6')) {
    let runStart = 0
    let runSide = 0 // 1=CL 上方，-1=CL 下方，0=压线（中断）
    for (let i = 0; i < numeric.length; i += 1) {
      const side = numeric[i]!.value > numeric[i]!.cl ? 1 : numeric[i]!.value < numeric[i]!.cl ? -1 : 0
      if (side === 0 || side !== runSide) {
        runStart = i
        runSide = side
      }
      if (runSide !== 0 && i - runStart + 1 >= 6) {
        violations.push({ code: 'run_same_side_6', fromIndex: i - 5, toIndex: i })
      }
    }
  }
  if (input.criteria.includes('trend_6')) {
    let runStart = 0
    let direction = 0 // 1=严格递增，-1=严格递减
    for (let i = 1; i < numeric.length; i += 1) {
      const step = numeric[i]!.value > numeric[i - 1]!.value ? 1 : numeric[i]!.value < numeric[i - 1]!.value ? -1 : 0
      if (step === 0 || step !== direction) {
        runStart = i - 1
        direction = step
      }
      if (direction !== 0 && i - runStart + 1 >= 6) {
        violations.push({ code: 'trend_6', fromIndex: i - 5, toIndex: i })
      }
    }
  }
  return violations
}

/** 单点判定（新样本准入后按当前控制限版本判）：返回该点是否失控与命中准则。 */
export function judgeSamplePoint(input: {
  criteria: readonly string[]
  history: readonly SpcPointInput[]
  newPoint: SpcPointInput
}): { verdict: 'in_control' | 'out_of_control'; violatedCodes: SpcCriterionCode[] } {
  const all = [...input.history, input.newPoint]
  const lastIndex = all.length - 1
  const violations = evaluateSpcCriteria({ criteria: input.criteria, points: all })
  const hit = violations.filter((v) => v.toIndex === lastIndex)
  return {
    verdict: hit.length > 0 ? 'out_of_control' : 'in_control',
    violatedCodes: [...new Set(hit.map((v) => v.code))],
  }
}

// ---------------- PE-12：失控处置闭环 ----------------

/** 失控处置任务状态：open → disposed → re_control_confirmed。 */
export const SPC_OOC_STATUSES = ['open', 'disposed', 're_control_confirmed'] as const
export type SpcOocStatus = (typeof SPC_OOC_STATUSES)[number]

/** 通知对象（PE-12 可配置：质量/工艺/班组长）。 */
export const SPC_OOC_NOTIFY_ROLES = ['quality', 'process', 'shift_leader'] as const
export type SpcOocNotifyRole = (typeof SPC_OOC_NOTIFY_ROLES)[number]

/** PE-12 处置记录：原因分类 + 纠正措施必填（隔离建议可选）；失控未处置不得静默关闭。 */
export function assertOocDisposable(input: {
  status: SpcOocStatus
  causeCategory: string
  correctiveAction: string
}): void {
  if (input.status !== 'open') {
    throw new SpcRuleViolation('PE-12', `失控处置任务已处于 ${input.status} 状态，不可重复处置`)
  }
  if (!(input.causeCategory ?? '').trim()) {
    throw new SpcRuleViolation('PE-12', '失控处置必须填写原因分类（处置记录：原因分类/纠正措施/隔离建议）')
  }
  if (!(input.correctiveAction ?? '').trim()) {
    throw new SpcRuleViolation('PE-12', '失控处置必须填写纠正措施（处置记录：原因分类/纠正措施/隔离建议）')
  }
}

/** PE-12 复控确认：仅已处置任务可确认；须有处置时点之后 ≥1 个在控样本支撑复控。 */
export function assertRecontrolConfirmable(input: {
  status: SpcOocStatus
  subsequentInControlCount: number
}): void {
  if (input.status === 'open') {
    throw new SpcRuleViolation('PE-12', '失控处置任务尚未处置（先完成处置记录再确认复控）')
  }
  if (input.status === 're_control_confirmed') {
    throw new SpcRuleViolation('PE-12', '失控处置任务已确认复控，无须重复确认')
  }
  if (input.subsequentInControlCount < 1) {
    throw new SpcRuleViolation('PE-12', '复控确认须有处置之后至少 1 个在控样本支撑（不得无证据确认复控）')
  }
}
