import type { PageRequest, PageResult } from '@cadenza/contracts'

/**
 * P3 域 API 客户端层类型（P3-UI 线新增，2026-10-28）。
 *
 * 覆盖四域：ot（T21）/ spc（T23）/ csw 外协（T22）/ cost（T24）——四域后端均已于
 * 2026-10-28 落盘（本线接续时 cost 由"按冻结合同先行"切换为对齐落盘 API，对账项见交付记录）。
 * 字段名对齐口径（先例 P2-UI types.ts，不直接 import 防并行线在途改动）：
 * - ot/spc：与 packages/application/src/{ot,spc}-queries.ts 实际返回形状（即控制器透传的线上形状）
 *   逐一对齐——注意这与 packages/contracts/src/{ot,spc}.ts 的 DTO 视图（L0 整合对齐目标）存在
 *   少量字段差异（如 ot 样本 badReasons 为 {code,label}[]、汇总带 dataLagSeconds/badRate），
 *   本层按实际返回形状消费并注明（先例：L3 第四波"视图形状以 application 层为准"）；
 * - csw：与 packages/application/src/csw-queries.ts + csw-repositories.ts 形状对齐（交付时点快照，
 *   交付记录登记"L0 整合时复核"）；
 * - cost：与 packages/contracts/src/cost.ts + application/src/cost-{queries,repositories}.ts +
 *   apps/api/src/cost/cost.controller.ts 落盘形状对齐（P3-D 交付/L0 注册后复核）。
 *
 * 数量/测量值/金额一律十进制字符串（IT-07 同源；CE 金额同口径）；遥测原始值为设备侧数值。
 * 页面端点语义：OT-25 样本明细必须按设备收敛；CE-03 实测/估算分列；CS-19 状态机驱动。
 */

export type { PageRequest, PageResult }

// ====================================================================
// T21 ot（设备与仪器采集）——字典值
// ====================================================================

export type OtGatewayStatusValue = 'online' | 'offline'
export type OtGatewayEventKindValue = 'registered' | 'heartbeat_restored' | 'offline' | 'overflow'
export type OtQualityLevelValue = 'good' | 'uncertain' | 'bad'
export type OtClockSkewKindValue = 'offset' | 'backward' | 'ahead'
export type OtSessionLinkStatusValue = 'auto_bound' | 'pending_confirm' | 'unlinked' | 'manual_bound'
export type OtPointSemanticValue =
  | 'meter_length'
  | 'speed'
  | 'temperature'
  | 'weight'
  | 'stop_signal'
  | 'inspection_result'
  | 'other'
export type OtAggregateGranularityValue = 'minute' | 'shift'
export type OtFactKindValue = 'meter_to_quantity' | 'stop_to_downtime'
export type OtConfirmModeValue = 'auto' | 'manual'
export type OtFactStatusValue = 'pending_confirm' | 'dispatched'

// ====================================================================
// T21 ot ——查询视图（application ot-queries 实际形状）
// ====================================================================

export interface OtGatewayView {
  gatewayId: string
  gatewayCode: string
  plantId: string
  protocolConfig: Record<string, unknown>
  sampleRateHz: number
  bufferCapacity: number
  heartbeatTimeoutSeconds: number
  status: OtGatewayStatusValue | string
  statusLabel: string
  lastHeartbeatAt: string | null
  checkpointSeq: number
  lastBacklogCount: number
  deviceCount: number
}

export type OtGatewayPage = PageResult<OtGatewayView>

export interface OtGatewayEventView {
  eventId: string
  gatewayCode: string
  eventKind: OtGatewayEventKindValue | string
  eventKindLabel: string
  detail: Record<string, unknown>
  occurredAt: string
  createdBy: string | null
}

export interface OtDeviceView {
  deviceSerial: string
  plantId: string
  gatewayCode: string | null
  equipmentId: string | null
  equipmentCode: string | null
  boundBy: string | null
  boundAt: string | null
  clockSkewThresholdSeconds: number
  lastSampleAt: string | null
  /** 采集延迟（OT-29）；null=无样本（OT-28 缺项，不以估算冒充） */
  lastSampleAgeSeconds: number | null
  quarantinedSampleCount: number
}

export type OtDevicePage = PageResult<OtDeviceView>

export interface OtPointView {
  pointId: string
  plantId: string
  deviceSerial: string
  pointCode: string
  semantic: string
  semanticLabel: string
  uomId: string | null
  uomCode: string
  sampleRateSeconds: number
  rangeMin: string | null
  rangeMax: string | null
  participatesInBusiness: boolean
  calibrationRecordNo: string | null
  calibrationValidUntil: string | null
  version: number
}

/** OT-09/OT-10：原始值与归一值并存；OT-22 坏点/偏差保留可查带原因。 */
export interface OtSampleView {
  sampleId: string
  deviceSerial: string
  pointCode: string
  eventId: string
  gatewaySeq: number
  eventTime: string
  receivedAt: string
  gatewayCode: string
  rawValue: string
  rawUnit: string
  normalizedValue: string | null
  conversionRevision: number | null
  conversionMissing: boolean
  qualityLevel: string
  qualityLabel: string
  deviceQualityCode: string | null
  isBad: boolean
  badReasons: Array<{ code: string; label: string }>
  isClockSkew: boolean
  clockSkewKind: string | null
  clockSkewLabel: string | null
  isLate: boolean
  calibrationSuspect: boolean
  sessionId: string | null
  sessionLinkStatus: string
  sessionLinkStatusLabel: string
  isQuarantined: boolean
  quarantineReason: string | null
}

export type OtSamplePage = PageResult<OtSampleView>

/** OT-25：汇总投影带更新时间与延迟标注。 */
export interface OtAggregateView {
  aggregateId: string
  deviceSerial: string
  pointCode: string
  granularity: OtAggregateGranularityValue | string
  windowStart: string
  sampleCount: number
  goodCount: number
  badCount: number
  skewCount: number
  sumValue: string
  minValue: string | null
  maxValue: string | null
  firstEventTime: string
  lastEventTime: string
  updatedAt: string
  /** 延迟标注（OT-25）：投影数据截至事件时间距今秒数 */
  dataLagSeconds: number
  /** 坏点率（OT-22 按设备/点位统计展示） */
  badRate: number | null
}

export type OtAggregatePage = PageResult<OtAggregateView>

export interface OtMappingView {
  mappingId: string
  plantId: string
  deviceSerial: string
  pointCode: string
  factKind: OtFactKindValue | string
  factKindLabel: string
  confirmMode: OtConfirmModeValue | string
  confirmModeLabel: string
  params: Record<string, unknown>
  version: number
}

export type OtMappingPage = PageResult<OtMappingView>

export interface OtFactView {
  factId: string
  mappingId: string
  mappingVersion: number
  factKind: string
  factKindLabel: string
  deviceSerial: string
  pointCode: string
  windowStart: string
  windowEnd: string
  value: string | null
  payload: Record<string, unknown>
  status: OtFactStatusValue | string
  statusLabel: string
  confirmedBy: string | null
  confirmedAt: string | null
  outboxEventId: string | null
}

export type OtFactPage = PageResult<OtFactView>

export interface OtStatsView {
  statDate: string
  gatewayCode: string
  deviceSerial: string
  dedupCount: number
  overflowCount: number
  overflowFirstAt: string | null
  overflowLastAt: string | null
}

export type OtStatsPage = PageResult<OtStatsView>

/** OT-29 必监项总览（边缘离线/采集延迟含缺项 OT-28/积压溢出/去重异常）。 */
export interface OtMonitorOverview {
  gateways: Array<{
    gatewayCode: string
    plantId: string
    status: string
    statusLabel: string
    lastHeartbeatAt: string | null
    staleSeconds: number | null
    backlogCount: number
  }>
  deviceLatency: Array<{
    deviceSerial: string
    equipmentCode: string | null
    lastSampleAt: string | null
    latencySeconds: number | null
    noData: boolean
  }>
  dedup: Array<{ statDate: string; gatewayCode: string; deviceSerial: string; dedupCount: number; dedupAnomaly: boolean }>
  overflow: Array<{ statDate: string; gatewayCode: string; deviceSerial: string; overflowCount: number }>
}

// ====================================================================
// T21 ot ——命令载荷（页面用子集）
// ====================================================================

/** ot.device.bind（OT-07：隔离态样本人工补绑/纠错）。 */
export interface OtDeviceBindPayload {
  operationId?: string
  plantId: string
  deviceSerial: string
  gatewayCode?: string
  equipmentId?: string | null
  clockSkewThresholdSeconds?: number
  reason?: string
}

/** ot.session.link（OT-13 人工绑定/纠错留痕；sessionId=null 解除绑定）。 */
export interface OtSessionLinkPayload {
  operationId?: string
  plantId: string
  sampleId: string
  sessionId: string | null
  reason?: string
}

/** ot.gateway.monitor（OT-29 巡检：心跳超时→离线事件留痕并告警）。 */
export interface OtGatewayMonitorPayload {
  operationId?: string
  plantId?: string
  reason?: string
}

/** ot.mapping.evaluate（OT-26 显式命令生成业务事实候选）。 */
export interface OtMappingEvaluatePayload {
  operationId?: string
  plantId: string
  mappingId: string
  from: string
  to: string
  reason?: string
}

/** ot.mapping.confirm（OT-26 manual 模式候选人工确认后派发）。 */
export interface OtMappingConfirmPayload {
  operationId?: string
  plantId: string
  factId: string
  reason?: string
}

/** ot.aggregate.rebuild（OT-S4：从原始层显式重建，重建不触发外部调用与二次扣账）。 */
export interface OtAggregateRebuildPayload {
  operationId?: string
  plantId?: string
  deviceSerial?: string
  granularity: OtAggregateGranularityValue
  from: string
  to: string
  reason?: string
}

// ====================================================================
// T23 spc ——字典值（与 domain spc 面同值）
// ====================================================================

export type SpcChangeStatusValue = 'draft' | 'published'
export type SpcImpactCategoryValue = 'unexecuted' | 'in_process' | 'completed'
export type SpcInProcessDispositionValue = 'continue_old' | 'switch_new' | 'isolation_review'
export type SpcChartTypeValue = 'xbar_r' | 'i_mr' | 'p'
export type SpcCriterionCodeValue = 'point_beyond_limits' | 'run_same_side_6' | 'trend_6'
export type SpcRuleSetStatusValue = 'draft' | 'published' | 'retired'
export type SpcLimitTriggerKindValue = 'initial' | 'rule_set_change' | 'process_change' | 'calibration_change'
export type SpcLimitStatusValue = 'building' | 'active'
export type SpcSampleSourceValue = 'manual_inspection' | 'collection'
export type SpcSampleAdmissionValue = 'admitted' | 'rejected'
export type SpcPointVerdictValue = 'in_control' | 'out_of_control'
export type SpcOocStatusValue = 'open' | 'disposed' | 're_control_confirmed'
export type SpcCalibrationResultValue = 'qualified' | 'limited' | 'failed'
export type SpcCalibrationStatusValue = 'valid' | 'limited' | 'invalid' | 'expired' | 'unknown'
export type SpcMiscalibrationActionKindValue = 'isolation' | 'retest' | 'concession' | 'rework_scrap'
export type SpcCircleItemKindValue =
  | 'measurement'
  | 'inspection_conclusion'
  | 'release'
  | 'lot'
  | 'wip_order'
  | 'stock_unit'
  | 'shipped_unit'
export type SpcToolLifeUomValue = 'count' | 'meters' | 'hours'
export type SpcToolExpirePolicyValue = 'block' | 'degrade'
export type SpcToolUsageSourceValue = 'work_report_output' | 'collected_sample'
export type SpcToolStatusValue = 'normal' | 'warning' | 'expired'

// ====================================================================
// T23 spc ——查询视图（application spc-queries 实际形状：记录 + 组装字段）
// ====================================================================

export interface SpcChangeRecord {
  id: string
  changeNo: string
  status: SpcChangeStatusValue
  plantId: string
  oldSpecRevisionId: string
  newSpecRevisionId: string
  approver: string
  effectiveAt: string
  operationMutations: unknown
  publishedAt: string | null
  publishedBy: string | null
  commandReceiptId: string | null
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

/** 列表项＝变更记录＋影响摘要（application listChanges 组装）。 */
export interface SpcChangeListItem extends SpcChangeRecord {
  impactSummary: { unexecuted: number; inProcess: number; completed: number }
}

export type SpcChangeListPage = PageResult<SpcChangeListItem>

export interface SpcChangeImpactView {
  id: string
  changeId: string
  category: SpcImpactCategoryValue
  productionOrderId: string
  orderNo: string
  orderStatus: string
  orderOperationId: string
  operationSeq: number
  operationName: string
  scheduled: boolean
  disposition: SpcInProcessDispositionValue | null
  followsVersion: 'old' | 'new' | null
  plannedQty: string
  recomputedPlannedQty: string | null
  dispositionBy: string | null
  dispositionAt: string | null
  enterpriseId: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface SpcChangeAdjustmentView {
  id: string
  changeId: string
  orderOperationId: string
  orderNo: string
  operationSeq: number
  oldPlannedQty: string
  newPlannedQty: string
  basis: unknown
  createdAt: string
  createdBy: string | null
}

/** GET /spc/changes/:id（控制器组装：change 记录＋impactGroups 三类清单，PE-06）。 */
export interface SpcChangeDetailResponse {
  change: SpcChangeRecord
  oldSpecLabel: string
  newSpecLabel: string
  impactGroups: {
    unexecuted: SpcChangeImpactView[]
    inProcess: SpcChangeImpactView[]
    completed: SpcChangeImpactView[]
  }
  adjustments: SpcChangeAdjustmentView[]
}

export interface SpcRuleSetView {
  id: string
  name: string
  version: number
  chartType: SpcChartTypeValue
  criteria: string[]
  status: SpcRuleSetStatusValue
  isDefault: boolean
  publishedAt: string | null
  publishedBy: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export type SpcRuleSetPage = PageResult<SpcRuleSetView>

export interface SpcControlItemView {
  id: string
  specCode: string
  specVersion: number
  itemNo: string
  itemName: string | null
  pointRef: string | null
  ruleSetId: string | null
  status: 'active' | 'retired'
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export type SpcControlItemPage = PageResult<SpcControlItemView>

export interface SpcControlLimitView {
  id: string
  controlItemId: string
  version: number
  method: 'mean_pm_3sigma'
  baselineGroupCount: number
  cl: string | null
  ucl: string | null
  lcl: string | null
  status: SpcLimitStatusValue
  triggerKind: SpcLimitTriggerKindValue
  triggerRef: string | null
  ruleSetId: string | null
  createdAt: string
  createdBy: string | null
}

export interface SpcSampleView {
  id: string
  controlItemId: string
  source: SpcSampleSourceValue
  testResultId: string | null
  measuredValue: string
  sampledAt: string
  productionOrderId: string | null
  orderOperationId: string | null
  operationSeq: number | null
  equipmentId: string | null
  equipmentCode: string | null
  shiftDate: string | null
  gaugeId: string | null
  calibrationStatus: SpcCalibrationStatusValue | null
  admission: SpcSampleAdmissionValue
  rejectReason: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
  judgement: SpcPointJudgementView | null
}

export interface SpcPointJudgementView {
  id: string
  sampleId: string
  controlItemId: string
  pointNo: number
  verdict: SpcPointVerdictValue
  violatedCodes: string[]
  ruleSetId: string | null
  ruleSetVersion: number | null
  controlLimitId: string | null
  controlLimitVersion: number | null
  judgedAt: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
}

/** GET /spc/control-items/:id/chart（PE-10/14）。 */
export interface SpcControlChartResponse {
  controlItem: SpcControlItemView
  ruleSet: {
    ruleSetId: string
    name: string
    version: number
    chartType: string
    criteria: string[]
    isDefault: boolean
  } | null
  limitVersions: SpcControlLimitView[]
  samples: SpcSampleView[]
}

export interface SpcOocTaskView {
  id: string
  taskNo: string
  status: SpcOocStatusValue
  controlItemId: string
  sampleId: string
  notifyRoles: string[]
  causeCategory: string | null
  correctiveAction: string | null
  isolationSuggestion: string | null
  qualityDoubtHint: boolean
  raisedAt: string
  raisedBy: string
  disposedBy: string | null
  disposedAt: string | null
  recontrolConfirmedBy: string | null
  recontrolConfirmedAt: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
}

export type SpcOocTaskPage = PageResult<SpcOocTaskView>

/** GET /spc/ooc-tasks/:id（PE-12 处置链可查）。 */
export interface SpcOocTaskDetailResponse {
  task: SpcOocTaskView
  sample: SpcSampleView | null
  judgement: SpcPointJudgementView | null
}

/** GET /spc/gauges/:id（PE-15/16/17）。 */
export interface SpcGaugeDetailResponse {
  gauge: { id: string; gaugeNo: string; name: string; gaugeKind: string | null; plantId: string }
  calibrationStatus: SpcCalibrationStatusValue | string
  schedulableForInspection: boolean
  calibrationHistory: SpcCalibrationRecordView[]
}

export interface SpcCalibrationRecordView {
  id: string
  gaugeId: string
  calibratedAt: string
  result: SpcCalibrationResultValue
  certificateNo: string
  validUntil: string
  basis: string
  recordedBy: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
}

/** PE-18 圈定清单（只读追溯；PE-S4 可重建视图）。 */
export interface SpcMiscalibrationCircleResponse {
  gauge: { id: string; gaugeNo: string; name: string }
  circle: {
    measurements: Array<{
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
    }>
    inspectionConclusions: Array<{
      testResultId: string
      conclusion: string
      inspectedAt: string | null
      inspector: string | null
      inspectionOrderNo: string
      inspectionOrderStatus: string
      productionOrderNo: string | null
      productionOrderStatus: string | null
      inventoryUnitId: string | null
      unitNo: string | null
      lotNo: string | null
      lotId: string | null
      materialCode: string | null
      releasedBy: string | null
      releasedAt: string | null
      releaseKind: string | null
    }>
    releases: Array<{ testResultId: string; releasedBy: string | null; releasedAt: string | null; releaseKind: string | null }>
    lots: Array<{ lotNo: string | null; unitNo: string | null; materialCode: string | null }>
    wipOrders: string[]
    stockUnits: Array<{
      inventoryUnitId: string
      unitNo: string
      status: string
      lotNo: string | null
      materialCode: string | null
      productionOrderNo: string | null
      productionOrderStatus: string | null
    }>
    shippedUnits: Array<{
      inventoryUnitId: string
      unitNo: string
      status: string
      lotNo: string | null
      materialCode: string | null
      productionOrderNo: string | null
      productionOrderStatus: string | null
    }>
    customerComplaintHints: Array<{ unitNo: string; productionOrderNo: string | null }>
  }
  actions: SpcMiscalibrationActionView[]
  dispositionProgress: { acted: number; pending: number }
}

export interface SpcMiscalibrationActionView {
  id: string
  gaugeId: string
  windowFrom: string
  windowTo: string
  itemKind: string
  itemRef: string
  itemLabel: string | null
  actionKind: SpcMiscalibrationActionKindValue
  externalRef: string | null
  customerComplaintHint: boolean
  actedBy: string
  actedAt: string
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
}

export interface SpcToolListItem {
  id: string
  toolNo: string
  name: string
  toolKind: string | null
  configVersion: number
  lifeUom: SpcToolLifeUomValue
  ratedLife: string
  warningThreshold: string
  expirePolicy: SpcToolExpirePolicyValue
  accumulatedLife: string
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
  adjustmentSum: string
  effectiveLife: string
  status: SpcToolStatusValue | string
  /** PE-21：到期工具经 T22 工装约束阻止继续排产（block 策略 false / degrade 策略 true） */
  schedulableForScheduling: boolean
}

export type SpcToolListPage = PageResult<SpcToolListItem>

export interface SpcToolConfigView {
  id: string
  toolId: string
  version: number
  lifeUom: SpcToolLifeUomValue
  ratedLife: string
  warningThreshold: string
  expirePolicy: SpcToolExpirePolicyValue
  effectiveAt: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
}

export interface SpcToolUsageView {
  id: string
  toolId: string
  source: SpcToolUsageSourceValue
  quantity: string
  refType: string
  refId: string
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
}

export interface SpcToolAdjustmentView {
  id: string
  toolId: string
  delta: string
  reason: string
  commandReceiptId: string | null
  enterpriseId: string
  createdAt: string
  createdBy: string | null
}

/** GET /spc/tools/:id（PE-20/21 台账：配置版本链+消耗行+具名调整）。 */
export interface SpcToolDetailResponse {
  tool: SpcToolListItem
  adjustmentSum: string
  effectiveLife: string
  status: SpcToolStatusValue | string
  schedulableForScheduling: boolean
  configHistory: SpcToolConfigView[]
  usage: SpcToolUsageView[]
  adjustments: SpcToolAdjustmentView[]
}

// ====================================================================
// T23 spc ——命令载荷（页面用子集）
// ====================================================================

export interface SpcChangeCreatePayload {
  operationId?: string
  plantId: string
  changeNo?: string
  oldSpecRevisionId: string
  newSpecRevisionId: string
  approver: string
  effectiveAt: string
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
  disposition: SpcInProcessDispositionValue
  reason?: string
}

export interface SpcChangePublishPayload {
  operationId?: string
  plantId: string
  changeId: string
  reason?: string
}

export interface SpcSampleRecordPayload {
  operationId?: string
  plantId: string
  controlItemId: string
  source: SpcSampleSourceValue
  measuredValue: string
  sampledAt?: string
  testResultId?: string
  qualityCode?: string
  gaugeId?: string
  badPoint?: boolean
  clockDeviation?: boolean
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

export interface SpcCalibrationRecordPayload {
  operationId?: string
  plantId: string
  gaugeId: string
  calibratedAt: string
  result: SpcCalibrationResultValue
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
  itemKind: SpcCircleItemKindValue
  itemRef: string
  itemLabel?: string
  actionKind: SpcMiscalibrationActionKindValue
  externalRef?: string
  reason?: string
}

export interface SpcToolConsumePayload {
  operationId?: string
  plantId: string
  toolId: string
  source: SpcToolUsageSourceValue
  quantity: string
  refType: string
  refId: string
  reason?: string
}

/** PE-21：寿命累计只增不改；修正走具名调整（reason 必填）。 */
export interface SpcToolAdjustPayload {
  operationId?: string
  plantId: string
  toolId: string
  delta: string
  reason: string
}

// ====================================================================
// T22 csw 外协（P3-B 已交付：形状按 csw-queries/csw-repositories 交付时点快照，L0 注册后复核）
// ====================================================================

export type CswOutsourcingStatusValue =
  | 'draft'
  | 'pending_send'
  | 'sent'
  | 'return_received'
  | 'inspecting'
  | 'closed'
  | 'recalled'
  | 'return_disposed'

export interface CswOutsourcingTaskView {
  id: string
  taskNo: string
  enterpriseId: string
  plantId: string
  orderId: string
  orderOperationId: string
  orderNo: string
  operationName: string
  supplierCode: string | null
  supplierName: string
  qty: string
  uom: string
  transitLocationId: string
  transitLocationCode: string
  returnLocationId: string | null
  returnLocationCode: string | null
  status: CswOutsourcingStatusValue
  statusLabel: string
  inspectionResult: 'pending' | 'passed' | 'rejected' | null
  /** CS-25：外协期间本厂设备不排产（占用表达） */
  occupationActive: boolean
  sentQty: string
  returnedQty: string
  sentBy: string | null
  sentAt: string | null
  receivedBy: string | null
  receivedAt: string | null
  inspectedBy: string | null
  inspectedAt: string | null
  closedBy: string | null
  closedAt: string | null
  recallReason: string | null
  recalledBy: string | null
  recalledAt: string | null
  disposeReason: string | null
  disposedBy: string | null
  disposedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  updatedBy: string | null
}

export type CswOutsourcingTaskPage = PageResult<CswOutsourcingTaskView>

/** CS-21 两段原子步的单元行（发送批次→回厂批次）。 */
export interface CswOutsourcingUnitView {
  id: string
  taskId: string
  unitId: string
  unitNo: string
  sendLotId: string | null
  sentQty: string
  returnedQty: string
  returnLotId: string | null
  status: 'sent' | 'returned'
  createdAt: string
  updatedAt: string
}

export interface CswOutsourcingDetailResponse {
  task: CswOutsourcingTaskView
  units: CswOutsourcingUnitView[]
}

/** CS-24 加工数量事实导出（供 ERP 结算核对；本系统不记应付/加工费/发票）。 */
export interface CswOutsourcingErpExportResponse {
  facts: Array<{
    taskNo: string
    supplierCode: string | null
    supplierName: string
    orderNo: string
    operationName: string
    sentQty: string
    returnedQty: string
    uom: string
    sentAt: string | null
    receivedAt: string | null
    closedAt: string | null
  }>
  note: string
}

export interface CswOutsourcingCreatePayload {
  operationId?: string
  orderOperationId: string
  supplierCode?: string
  supplierName: string
  qty: string
  transitLocationId: string
  transitLocationCode: string
  returnLocationId?: string
  returnLocationCode?: string
  reason?: string
}

export interface CswOutsourcingSubmitPayload {
  operationId?: string
  taskId: string
  reason?: string
}

export interface CswOutsourcingSendPayload {
  operationId?: string
  taskId: string
  lines: Array<{ unitId: string; quantity: string }>
  businessTime?: string
  reason?: string
}

export interface CswOutsourcingReceivePayload {
  operationId?: string
  taskId: string
  lines: Array<{ unitId: string; quantity: string; returnLotNo?: string }>
  returnLocationId?: string
  returnLocationCode?: string
  businessTime?: string
  reason?: string
}

export interface CswOutsourcingInspectPayload {
  operationId?: string
  taskId: string
  inspectionResult: 'passed' | 'rejected'
  reason?: string
}

export interface CswOutsourcingTaskIdPayload {
  operationId?: string
  taskId: string
  reason?: string
}

// ====================================================================
// T24 cost 能源与制造成本——形状对齐落盘 API（packages/contracts/src/cost.ts +
// packages/application/src/cost-{queries,repositories}.ts + apps/api/src/cost/
// 控制器，2026-10-28 13 时落盘；P3-D 线交付/L0 注册后以最终形态复核）
// ====================================================================

export type CostSourceKindValue = 'material' | 'labor' | 'scrap' | 'equipment_runtime' | 'spare_part' | 'energy'
export type CostValueFlagValue = 'measured' | 'estimated'
export type CostEnergyTypeValue = 'electric' | 'water' | 'gas'
export type CostMeterCoverageKindValue = 'equipment' | 'workshop'
export type CostMeterSampleSourceValue = 'ot' | 'manual'
export type CostReadingTypeValue = 'manual' | 'ot'
export type CostAllocationFormulaValue = 'machine_hours' | 'output_qty' | 'power_weight'
export type CostPriceSourceValue = 'standard_cost' | 'erp_actual'
export type CostReconKindValue = 'material' | 'labor' | 'energy'
export type CostReconDispositionValue = 'open' | 'confirmed' | 'adjusted'
export type CostLaborCheckStatusValue = 'open' | 'acknowledged'

/** 归集产出（GET /cost/runs 行；CE-17 估算/实测两列＋CE-11 分摊版本与数据截止时点）。 */
export interface CostRunView {
  id: string
  runNo: string
  orderId: string
  allocationVersionId: string
  priceVersionId: string
  shiftDate: string
  shiftCalendarId: string
  dataCutoffAt: string
  shiftSnapshotAnchor: Record<string, unknown> | null
  estimateAmount: string | null
  actualAmount: string | null
  estimatePossible: boolean
  estimateMissingReason: string | null
  energyMeteredUsage: string
  energyEstimatedUsage: string
  energyCoverageRatio: string | null
  energyUomCode: string | null
  machineHours: string
  /** CA-12（PROPOSED 默认）：工时主源=labor_record */
  laborSource: string
  /** CA-13（PROPOSED 默认）：设备成本口径（不含折旧列示并标注） */
  equipmentCostCaliber: string
  recalcOf: string | null
  oldNewComparison: Record<string, unknown> | null
  plantId: string
  createdAt: string
}

export type CostRunPage = PageResult<CostRunView>

/** GET /cost/runs/:id（CE-15 回算路径：明细行带源事实表+ID）。 */
export interface CostRunDetailResponse {
  run: {
    runId: string
    runNo: string
    orderId: string
    allocationVersionId: string
    priceVersionId: string
    shiftDate: string
    shiftCalendarId: string
    dataCutoffAt: string
    shiftSnapshotAnchor: Record<string, unknown> | null
    estimateAmount: string | null
    actualAmount: string | null
    energyMeteredUsage: string
    energyEstimatedUsage: string
    energyCoverageRatio: string | null
    machineHours: string
    laborSource: string
    equipmentCostCaliber: string
    recalcOf: string | null
    oldNewComparison: Record<string, unknown> | null
  }
  lines: CostLineView[]
}

/** CE-S1/CE-03/05/07/14：归集明细行（源事实 ID 非空、实测/估算标志、理论/差异分列）。 */
export interface CostLineView {
  lineId: string
  lineNo: number
  sourceKind: CostSourceKindValue | string
  sourceTable: string
  sourceFactId: string
  valueFlag: CostValueFlagValue | string
  orderOperationId: string | null
  productFamilyId: string | null
  quantity: string
  uomCode: string
  theoreticalQuantity: string | null
  varianceQuantity: string | null
  destinationBreakdownMissing: boolean
  unitPrice: string | null
  priceMissing: boolean
  amount: string | null
  facts: Record<string, unknown>
}

/** GET /cost/orders/:orderId/summary（CE-17 两列并存＋CE-18 在制按工序已投入）。 */
export interface CostOrderSummaryResponse {
  orderId: string
  orderNo: string
  orderStatus: string
  plannedQty: string
  estimate: {
    possible: boolean
    missingReason: string | null
    amount: string | null
    lines: Array<{
      materialCode: string
      theoreticalQty: string
      unitPrice: string | null
      uomCode: string
      amount: string | null
      priceMissing: boolean
    }>
  }
  actual: {
    runId: string
    runNo: string
    shiftDate: string
    dataCutoffAt: string
    amount: string | null
    estimateAmount: string | null
    anyPriceMissing: boolean
    laborSource: string
    equipmentCostCaliber: string
  } | null
  wipByOperation: Array<{
    orderOperationId: string | null
    operationSeq: number | null
    materialQty: string
    materialAmount: string | null
    laborHours: string
  }>
}

/** GET /cost/energy-intensity（CE-09 单耗与覆盖率；产出为零/全缺 → intensityPerOutput=null 不冒充）。 */
export interface CostEnergyIntensityResponse {
  items: Array<{
    runId: string
    orderNo: string | null
    productFamilyId: string | null
    shiftDate: string
    meteredUsage: string
    estimatedUsage: string
    coverageRatio: string | null
    uomCode: string | null
    outputQty: string
    intensityPerOutput: string | null
  }>
  total: number
}

/** GET /cost/oee（CE-10：分母齐备后才计算；missing=缺项清单，不出假百分比）。 */
export interface CostOeeResponse {
  equipmentId: string
  equipmentCode: string
  windowStart: string
  windowEnd: string
  plannedMinutes: string | null
  downtimeMinutes: string | null
  standardSpeedPerHour: string | null
  stdRateText?: string | null
  actualOutputQty: string | null
  qualifiedQty: string | null
  availability: string | null
  performance: string | null
  qualityRate: string | null
  oee: string | null
  missing: string[]
}

/** 表计配置（CE-S3/CE-09：先明确计量表清单与采样覆盖）。 */
export interface CostMeterView {
  id: string
  meterCode: string
  meterName: string | null
  energyType: CostEnergyTypeValue | string
  coverageKind: CostMeterCoverageKindValue | string
  equipmentId: string | null
  workCenterId: string | null
  sampleSource: CostMeterSampleSourceValue | string
  otPointId: string | null
  uomCode: string
  status: 'active' | 'retired' | string
  plantId: string
}

export type CostMeterPage = PageResult<CostMeterView>

/** 分摊版本（CE-S2/CE-11：版本化、被引用版本 immutable）。 */
export interface CostAllocationVersionView {
  id: string
  versionNo: number
  formula: CostAllocationFormulaValue | string
  params: Record<string, unknown>
  overheadCaliber: string | null
  status: 'active' | 'retired' | string
  referencedByRuns?: number
  plantId: string
  createdAt: string
}

export type CostAllocationVersionPage = PageResult<CostAllocationVersionView>

/** 价格版本（CE-14：价格主权归上游，本系统只引用并标版本）。 */
export interface CostPriceVersionView {
  id: string
  versionNo: number
  priceSource: CostPriceSourceValue | string
  status: 'active' | 'retired' | string
  remark: string | null
  items: Array<{ materialCode: string; materialId: string | null; unitPrice: string; uomCode: string }>
  plantId: string
  createdAt: string
}

export type CostPriceVersionPage = PageResult<CostPriceVersionView>

/** 对账差异行（CE-S5/CE-16：处置状态；未处置不得清零）。 */
export interface CostReconItemView {
  id: string
  reconKey: string
  runId: string
  kind: CostReconKindValue | string
  localQuantity: string
  erpQuantity: string
  diffQuantity: string
  uomCode: string
  materialCode: string | null
  orderNo: string | null
  erpDocumentRef: string | null
  dispositionStatus: CostReconDispositionValue | string
  disposedBy: string | null
  disposedAt: string | null
  dispositionReason: string | null
  plantId: string
}

export type CostReconItemPage = PageResult<CostReconItemView>

/** 工时核对提示（CA-12·PROPOSED：报工工时主源 vs OT 运行时间参考源）。 */
export interface CostLaborCheckView {
  id: string
  orderId: string
  operationKey: string
  orderOperationId: string | null
  shiftDate: string
  laborHours: string
  otRuntimeHours: string | null
  deviationRatio: string | null
  thresholdRatio: string
  status: CostLaborCheckStatusValue | string
  missingSide: 'labor' | 'ot' | null
  acknowledgedBy: string | null
  acknowledgedAt: string | null
  reason: string | null
  plantId: string
}

export type CostLaborCheckPage = PageResult<CostLaborCheckView>

// ---------------- cost 命令载荷 ----------------

/** cost.acquisition.run（CE-S1/CE-11：首次归集）。 */
export interface CostAcquisitionRunPayload {
  operationId?: string
  plantId: string
  orderId: string
  shiftDate: string
  dataCutoffAt: string
  allocationVersionId: string
  priceVersionId: string
  reason?: string
}

/** cost.acquisition.recalc（CE-11：显式重算——新版本/新截止时点，输出新旧对照；理由必填）。 */
export interface CostAcquisitionRecalcPayload {
  operationId?: string
  plantId: string
  orderId: string
  shiftDate: string
  dataCutoffAt: string
  allocationVersionId: string
  priceVersionId: string
  reason: string
}

/** cost.recon.resolve（CE-S5：差异处置流转；理由必填，未处置不得清零）。 */
export interface CostReconResolvePayload {
  operationId?: string
  plantId: string
  itemId: string
  targetStatus: CostReconDispositionValue
  reason: string
}

/** cost.labor-check.run（CA-12：偏差核对提示生成）。 */
export interface CostLaborCheckRunPayload {
  operationId?: string
  plantId: string
  orderId: string
  shiftDate: string
  thresholdRatio?: string
  reason?: string
}

/** cost.labor-check.acknowledge（CA-12：核对确认留痕；理由必填）。 */
export interface CostLaborCheckAcknowledgePayload {
  operationId?: string
  plantId: string
  checkId: string
  reason: string
}
