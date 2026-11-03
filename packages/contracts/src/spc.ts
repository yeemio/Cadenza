import type { DecimalString } from './decimal'

/**
 * spc 线合同 DTO（T23 工艺变更影响控制 / SPC 规则集与控制限 / 计量校准 / 工具寿命）。
 * 冻结合同：architecture/contracts/frozen/p3/process-change-spc-calibration.md。
 *
 * 字典值与 domain spc 面同源（domain 为判定入口，contracts 为边界载荷/视图形状）；
 * 数量/测量值一律 DecimalString（≤4 位小数）；控制限为计算产物，6 位小数字符串。
 *
 * 注意（L0-整合标记）：本文件**未并入 packages/contracts/src/index.ts**（共享文件，
 * 并行线不自改）；L0 整合步追加 `export * from './spc'`。
 */

// ---------------- 字典值（PE-03/04/09/10/11/12/15/17/19/20） ----------------

export type SpcChangeStatusDto = 'draft' | 'published'
export type SpcImpactCategoryDto = 'unexecuted' | 'in_process' | 'completed'
export type SpcInProcessDispositionDto = 'continue_old' | 'switch_new' | 'isolation_review'
export type SpcChartTypeDto = 'xbar_r' | 'i_mr' | 'p'
export type SpcCriterionCodeDto = 'point_beyond_limits' | 'run_same_side_6' | 'trend_6'
export type SpcRuleSetStatusDto = 'draft' | 'published' | 'retired'
export type SpcLimitTriggerKindDto = 'initial' | 'rule_set_change' | 'process_change' | 'calibration_change'
export type SpcLimitStatusDto = 'building' | 'active'
export type SpcSampleSourceDto = 'manual_inspection' | 'collection'
export type SpcSampleAdmissionDto = 'admitted' | 'rejected'
export type SpcSampleRejectReasonDto =
  | 'bad_point'
  | 'clock_deviation'
  | 'calibration_suspect'
  | 'quality_code_not_good'
  | 'test_result_missing'
export type SpcPointVerdictDto = 'in_control' | 'out_of_control'
export type SpcOocStatusDto = 'open' | 'disposed' | 're_control_confirmed'
export type SpcCalibrationResultDto = 'qualified' | 'limited' | 'failed'
export type SpcCalibrationStatusDto = 'valid' | 'limited' | 'invalid' | 'expired' | 'unknown'
export type SpcMiscalibrationActionKindDto = 'isolation' | 'retest' | 'concession' | 'rework_scrap'
export type SpcCircleItemKindDto =
  | 'measurement'
  | 'inspection_conclusion'
  | 'release'
  | 'lot'
  | 'wip_order'
  | 'stock_unit'
  | 'shipped_unit'
export type SpcToolLifeUomDto = 'count' | 'meters' | 'hours'
export type SpcToolExpirePolicyDto = 'block' | 'degrade'
export type SpcToolUsageSourceDto = 'work_report_output' | 'collected_sample'
export type SpcToolStatusDto = 'normal' | 'warning' | 'expired'

// ---------------- 命令载荷（spc.* 17 命令） ----------------

export interface SpcChangeCreatePayload {
  operationId?: string
  plantId: string
  /** 变更单号（缺省服务端生成）。 */
  changeNo?: string
  oldSpecRevisionId: string
  newSpecRevisionId: string
  /** 审批人（PE-05：审批与执行版本对应）。 */
  approver: string
  /** 生效时间（ISO-8601）。 */
  effectiveAt: string
  /** 工序变动清单（PE-07 守卫：已有报工的工序不可增/改名/调序/删行）。 */
  operationMutations?: Array<{ kind: 'add' | 'rename' | 'reorder' | 'remove'; targetSeq?: number }>
  reason?: string
}

export interface SpcChangeScanPayload {
  operationId?: string
  plantId: string
  changeId: string
  reason?: string
}

export interface SpcChangeDispositionPayload {
  operationId?: string
  plantId: string
  changeId: string
  impactId: string
  disposition: SpcInProcessDispositionDto
  reason?: string
}

export interface SpcChangePublishPayload {
  operationId?: string
  plantId: string
  changeId: string
  reason?: string
}

export interface SpcRuleSetCreatePayload {
  operationId?: string
  plantId: string
  name: string
  version: number
  chartType: SpcChartTypeDto
  criteria: SpcCriterionCodeDto[]
  reason?: string
}

export interface SpcRuleSetPublishPayload {
  operationId?: string
  plantId: string
  ruleSetId: string
  reason?: string
}

export interface SpcControlItemCreatePayload {
  operationId?: string
  plantId: string
  specCode: string
  specVersion: number
  itemNo: string
  itemName?: string
  /** 采集点位引用（OT-13 关联；P3-A 并行未落地前为文本引用）。 */
  pointRef?: string
  reason?: string
}

export interface SpcControlLimitRecalcPayload {
  operationId?: string
  plantId: string
  controlItemId: string
  /** 基线组数（首 n 组建立；缺省 25）。 */
  baselineGroupCount?: number
  /** 重算触发（PE-10）：缺省 initial；规则集变更/工艺变更生效/校准变更各为独立触发。 */
  triggerKind?: SpcLimitTriggerKindDto
  triggerRef?: string
  reason?: string
}

export interface SpcSampleRecordPayload {
  operationId?: string
  plantId: string
  controlItemId: string
  source: SpcSampleSourceDto
  measuredValue: DecimalString
  sampledAt?: string
  /** 人工来源：引用检验实测结果 id（PE-11）。 */
  testResultId?: string
  /** 采集来源：质量码（OT-11，good 才准入）。 */
  qualityCode?: string
  /** 出具器具（PE-16：绑定器具+当时校准状态）。 */
  gaugeId?: string
  badPoint?: boolean
  clockDeviation?: boolean
  /** PE-14 工序执行实例引用（失控点定位到订单/工序/设备/班次）。 */
  productionOrderId?: string
  orderOperationId?: string
  operationSeq?: number
  equipmentId?: string
  equipmentCode?: string
  shiftDate?: string
  reason?: string
}

export interface SpcOocDisposePayload {
  operationId?: string
  plantId: string
  oocTaskId: string
  causeCategory: string
  correctiveAction: string
  isolationSuggestion?: string
  reason?: string
}

export interface SpcOocConfirmRecontrolPayload {
  operationId?: string
  plantId: string
  oocTaskId: string
  reason?: string
}

export interface SpcGaugeRegisterPayload {
  operationId?: string
  plantId: string
  gaugeNo: string
  name: string
  gaugeKind?: string
  reason?: string
}

export interface SpcCalibrationRecordPayload {
  operationId?: string
  plantId: string
  gaugeId: string
  calibratedAt: string
  result: SpcCalibrationResultDto
  certificateNo: string
  validUntil: string
  basis: string
  reason?: string
}

export interface SpcMiscalibrationActionPayload {
  operationId?: string
  plantId: string
  gaugeId: string
  windowFrom: string
  windowTo: string
  itemKind: SpcCircleItemKindDto
  itemRef: string
  itemLabel?: string
  actionKind: SpcMiscalibrationActionKindDto
  externalRef?: string
  reason?: string
}

export interface SpcToolRegisterPayload {
  operationId?: string
  plantId: string
  toolNo: string
  name: string
  toolKind?: string
  lifeUom: SpcToolLifeUomDto
  ratedLife: DecimalString
  warningThreshold: DecimalString
  expirePolicy: SpcToolExpirePolicyDto
  reason?: string
}

export interface SpcToolConfigRevisePayload {
  operationId?: string
  plantId: string
  toolId: string
  lifeUom: SpcToolLifeUomDto
  ratedLife: DecimalString
  warningThreshold: DecimalString
  expirePolicy: SpcToolExpirePolicyDto
  reason?: string
}

export interface SpcToolConsumePayload {
  operationId?: string
  plantId: string
  toolId: string
  source: SpcToolUsageSourceDto
  quantity: DecimalString
  refType: string
  refId: string
  reason?: string
}

export interface SpcToolAdjustPayload {
  operationId?: string
  plantId: string
  toolId: string
  delta: DecimalString
  reason: string
}

// ---------------- 查询视图 ----------------

export interface SpcChangeView {
  changeId: string
  changeNo: string
  status: SpcChangeStatusDto
  oldSpecRevisionId: string
  newSpecRevisionId: string
  oldSpecLabel: string
  newSpecLabel: string
  approver: string
  effectiveAt: string
  publishedAt: string | null
  operationMutationCount: number
  impactSummary: { unexecuted: number; inProcess: number; completed: number }
}

export interface SpcChangeImpactView {
  impactId: string
  category: SpcImpactCategoryDto
  productionOrderId: string
  orderNo: string
  orderStatus: string
  orderOperationId: string
  operationSeq: number
  operationName: string
  /** 已排产未开工（可调整未执行，PE-03）。 */
  scheduled: boolean
  disposition: SpcInProcessDispositionDto | null
  followsVersion: 'old' | 'new' | null
  plannedQty: DecimalString
  recomputedPlannedQty: DecimalString | null
}

export interface SpcControlChartView {
  controlItem: {
    controlItemId: string
    specCode: string
    specVersion: number
    itemNo: string
    itemName: string | null
    pointRef: string | null
  }
  ruleSet: {
    ruleSetId: string
    name: string
    version: number
    chartType: SpcChartTypeDto
    criteria: SpcCriterionCodeDto[]
    isDefault: boolean
  } | null
  limitVersions: Array<{
    limitVersionId: string
    version: number
    status: SpcLimitStatusDto
    triggerKind: SpcLimitTriggerKindDto
    triggerRef: string | null
    cl: string | null
    ucl: string | null
    lcl: string | null
  }>
  samples: Array<{
    sampleId: string
    source: SpcSampleSourceDto
    measuredValue: DecimalString
    sampledAt: string
    admission: SpcSampleAdmissionDto
    rejectReason: SpcSampleRejectReasonDto | null
    gaugeId: string | null
    calibrationStatus: SpcCalibrationStatusDto | null
    productionOrderNo: string | null
    operationSeq: number | null
    equipmentCode: string | null
    shiftDate: string | null
    judgement: {
      pointNo: number
      verdict: SpcPointVerdictDto
      violatedCodes: SpcCriterionCodeDto[]
      ruleSetVersion: number | null
      limitVersion: number | null
    } | null
  }>
}

export interface SpcOocTaskView {
  oocTaskId: string
  taskNo: string
  status: SpcOocStatusDto
  controlItemId: string
  sampleId: string
  notifyRoles: string[]
  causeCategory: string | null
  correctiveAction: string | null
  isolationSuggestion: string | null
  qualityDoubtHint: boolean
  raisedAt: string
  disposedBy: string | null
  disposedAt: string | null
  recontrolConfirmedBy: string | null
  recontrolConfirmedAt: string | null
}

export interface SpcGaugeDetailView {
  gaugeId: string
  gaugeNo: string
  name: string
  gaugeKind: string | null
  /** 当前校准状态（按最新校准记录时点快照口径，PE-16）。 */
  calibrationStatus: SpcCalibrationStatusDto
  /** PE-17 检测类任务可排产判定（CS-05 硬约束③ 排产侧等价服务）。 */
  schedulableForInspection: boolean
  calibrationHistory: Array<{
    calibrationId: string
    calibratedAt: string
    result: SpcCalibrationResultDto
    certificateNo: string
    validUntil: string
    basis: string
    recordedBy: string | null
  }>
}

export interface SpcMiscalibrationCircleView {
  gaugeId: string
  windowFrom: string
  windowTo: string
  measurements: Array<{
    sampleId: string
    source: SpcSampleSourceDto
    sampledAt: string
    measuredValue: DecimalString
    admission: SpcSampleAdmissionDto
    testResultId: string | null
    productionOrderNo: string | null
    unitNo: string | null
    lotNo: string | null
  }>
  inspectionConclusions: Array<{
    testResultId: string
    conclusion: string
    inspectedAt: string | null
    inspectionOrderNo: string
    productionOrderNo: string | null
    unitNo: string | null
    lotNo: string | null
  }>
  releases: Array<{ testResultId: string; releasedBy: string | null; releasedAt: string | null; releaseKind: string | null }>
  lots: Array<{ lotNo: string | null; unitNo: string | null; materialCode: string | null }>
  wipOrders: string[]
  stockUnits: Array<{ inventoryUnitId: string; unitNo: string; status: string; productionOrderNo: string | null }>
  shippedUnits: Array<{ inventoryUnitId: string; unitNo: string; status: string; productionOrderNo: string | null }>
  customerComplaintHints: Array<{ unitNo: string; productionOrderNo: string | null }>
  /** PE-19 处置进度：已处置圈定项 / 全部圈定项（处置完成前圈定清单不得删除）。 */
  dispositionProgress: { acted: number; pending: number }
  actions: Array<{
    actionId: string
    itemKind: SpcCircleItemKindDto
    itemRef: string
    actionKind: SpcMiscalibrationActionKindDto
    actedBy: string
    actedAt: string
    customerComplaintHint: boolean
  }>
}

export interface SpcToolDetailView {
  toolId: string
  toolNo: string
  name: string
  toolKind: string | null
  configVersion: number
  lifeUom: SpcToolLifeUomDto
  ratedLife: DecimalString
  warningThreshold: DecimalString
  expirePolicy: SpcToolExpirePolicyDto
  accumulatedLife: DecimalString
  adjustmentSum: DecimalString
  effectiveLife: DecimalString
  status: SpcToolStatusDto
  /** PE-21 排产侧等价服务（T22 工装约束，CS-05 扩展项）。 */
  schedulableForScheduling: boolean
  configHistory: Array<{
    version: number
    lifeUom: SpcToolLifeUomDto
    ratedLife: DecimalString
    warningThreshold: DecimalString
    expirePolicy: SpcToolExpirePolicyDto
    effectiveAt: string
  }>
  usage: Array<{ usageId: string; source: SpcToolUsageSourceDto; quantity: DecimalString; refType: string; refId: string; consumedAt: string }>
  adjustments: Array<{ adjustmentId: string; delta: DecimalString; reason: string; adjustedBy: string; adjustedAt: string }>
}
