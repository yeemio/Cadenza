import type { CommandTools } from './command-bus'
import type { OutboxIntent } from './unit-of-work'

/**
 * spc 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0019 spc 表列一一对应；时间字段一律 ISO-8601 字符串；
 * 数量/测量值一律 DecimalString（IT-07 口径）；控制限为计算产物（6 位小数字符串）。
 *
 * SpcCommandTools = CommandTools（org 基础）+ spc 仓储束 + 跨域只读投影端口
 * （process/execution/quality/inventory 只读——PE-03 判定/PE-11 样本来源/PE-18 圈定；
 * **不持有任何跨域写端口**：PE-13 SPC 结论仅作为质量证据输入，质量放行/隔离结论
 * 只能出自质量域）+ Outbox 收集器。
 */

// ---------------- 记录类型：工艺变更（PE-01~PE-07） ----------------

export interface SpcProcessChangeRecord {
  id: string
  changeNo: string
  status: 'draft' | 'published'
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

export interface NewSpcProcessChange {
  changeNo: string
  plantId: string
  oldSpecRevisionId: string
  newSpecRevisionId: string
  approver: string
  effectiveAt: string
  operationMutations?: unknown
  commandReceiptId?: string | null
  enterpriseId: string
  createdBy?: string | null
}

export interface SpcChangeImpactRecord {
  id: string
  changeId: string
  category: 'unexecuted' | 'in_process' | 'completed'
  productionOrderId: string
  orderNo: string
  orderStatus: string
  orderOperationId: string
  operationSeq: number
  operationName: string
  scheduled: boolean
  disposition: 'continue_old' | 'switch_new' | 'isolation_review' | null
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

export interface NewSpcChangeImpact {
  changeId: string
  category: SpcChangeImpactRecord['category']
  productionOrderId: string
  orderNo: string
  orderStatus: string
  orderOperationId: string
  operationSeq: number
  operationName: string
  scheduled: boolean
  followsVersion: 'old' | 'new' | null
  plannedQty: string
  recomputedPlannedQty?: string | null
  enterpriseId: string
  createdBy?: string | null
}

export interface SpcChangeAdjustmentRecord {
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

export interface NewSpcChangeAdjustment {
  changeId: string
  orderOperationId: string
  orderNo: string
  operationSeq: number
  oldPlannedQty: string
  newPlannedQty: string
  basis?: unknown
  enterpriseId: string
  createdBy?: string | null
}

// ---------------- 记录类型：SPC 规则集/控制限/受控项目（PE-08~PE-10） ----------------

export interface SpcRuleSetRecord {
  id: string
  name: string
  version: number
  chartType: 'xbar_r' | 'i_mr' | 'p'
  criteria: string[]
  status: 'draft' | 'published' | 'retired'
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

export interface NewSpcRuleSet {
  name: string
  version: number
  chartType: SpcRuleSetRecord['chartType']
  criteria: string[]
  isDefault?: boolean
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface SpcControlItemRecord {
  id: string
  specCode: string
  specVersion: number
  itemNo: string
  itemName: string | null
  pointRef: string | null
  /** 采用的规则集版本（PE-09；缺省=默认规则集，样本登记时懒建）。 */
  ruleSetId: string | null
  status: 'active' | 'retired'
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewSpcControlItem {
  specCode: string
  specVersion: number
  itemNo: string
  itemName?: string | null
  pointRef?: string | null
  ruleSetId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface SpcControlLimitRecord {
  id: string
  controlItemId: string
  version: number
  method: 'mean_pm_3sigma'
  baselineGroupCount: number
  cl: string | null
  ucl: string | null
  lcl: string | null
  status: 'building' | 'active'
  triggerKind: 'initial' | 'rule_set_change' | 'process_change' | 'calibration_change'
  triggerRef: string | null
  ruleSetId: string | null
  createdAt: string
  createdBy: string | null
}

export interface NewSpcControlLimit {
  controlItemId: string
  version: number
  method: 'mean_pm_3sigma'
  baselineGroupCount: number
  cl?: string | null
  ucl?: string | null
  lcl?: string | null
  status: 'building' | 'active'
  triggerKind: SpcControlLimitRecord['triggerKind']
  triggerRef?: string | null
  ruleSetId?: string | null
  enterpriseId: string
  createdBy?: string | null
}

// ---------------- 记录类型：样本/判定/失控任务（PE-11~PE-14） ----------------

export interface SpcSampleRecord {
  id: string
  controlItemId: string
  source: 'manual_inspection' | 'collection'
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
  calibrationStatus: 'valid' | 'limited' | 'invalid' | 'expired' | 'unknown' | null
  admission: 'admitted' | 'rejected'
  rejectReason: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
}

export interface NewSpcSample {
  controlItemId: string
  source: SpcSampleRecord['source']
  testResultId?: string | null
  measuredValue: string
  sampledAt: string
  productionOrderId?: string | null
  orderOperationId?: string | null
  operationSeq?: number | null
  equipmentId?: string | null
  equipmentCode?: string | null
  shiftDate?: string | null
  gaugeId?: string | null
  calibrationStatus?: SpcSampleRecord['calibrationStatus']
  admission: 'admitted' | 'rejected'
  rejectReason?: string | null
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface SpcPointJudgementRecord {
  id: string
  sampleId: string
  controlItemId: string
  pointNo: number
  verdict: 'in_control' | 'out_of_control'
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

export interface NewSpcPointJudgement {
  sampleId: string
  controlItemId: string
  pointNo: number
  verdict: 'in_control' | 'out_of_control'
  violatedCodes: string[]
  ruleSetId?: string | null
  ruleSetVersion?: number | null
  controlLimitId?: string | null
  controlLimitVersion?: number | null
  judgedAt: string
  enterpriseId: string
  createdBy?: string | null
}

export interface SpcOocTaskRecord {
  id: string
  taskNo: string
  status: 'open' | 'disposed' | 're_control_confirmed'
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

export interface NewSpcOocTask {
  taskNo: string
  controlItemId: string
  sampleId: string
  notifyRoles: string[]
  qualityDoubtHint: boolean
  raisedAt: string
  raisedBy: string
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

// ---------------- 记录类型：器具/校准/失准处置（PE-15~PE-19） ----------------

export interface SpcGaugeRecord {
  id: string
  gaugeNo: string
  name: string
  gaugeKind: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
}

export interface NewSpcGauge {
  gaugeNo: string
  name: string
  gaugeKind?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface SpcCalibrationRecord {
  id: string
  gaugeId: string
  calibratedAt: string
  result: 'qualified' | 'limited' | 'failed'
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

export interface NewSpcCalibrationRecord {
  gaugeId: string
  calibratedAt: string
  result: SpcCalibrationRecord['result']
  certificateNo: string
  validUntil: string
  basis: string
  recordedBy?: string | null
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface SpcMiscalibrationActionRecord {
  id: string
  gaugeId: string
  windowFrom: string
  windowTo: string
  itemKind: string
  itemRef: string
  itemLabel: string | null
  actionKind: 'isolation' | 'retest' | 'concession' | 'rework_scrap'
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

export interface NewSpcMiscalibrationAction {
  gaugeId: string
  windowFrom: string
  windowTo: string
  itemKind: string
  itemRef: string
  itemLabel?: string | null
  actionKind: SpcMiscalibrationActionRecord['actionKind']
  externalRef?: string | null
  customerComplaintHint: boolean
  actedBy: string
  actedAt: string
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

// ---------------- 记录类型：工具寿命（PE-20/PE-21） ----------------

export interface SpcToolLedgerRecord {
  id: string
  toolNo: string
  name: string
  toolKind: string | null
  configVersion: number
  lifeUom: 'count' | 'meters' | 'hours'
  ratedLife: string
  warningThreshold: string
  expirePolicy: 'block' | 'degrade'
  accumulatedLife: string
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewSpcToolLedger {
  toolNo: string
  name: string
  toolKind?: string | null
  configVersion: number
  lifeUom: SpcToolLedgerRecord['lifeUom']
  ratedLife: string
  warningThreshold: string
  expirePolicy: SpcToolLedgerRecord['expirePolicy']
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface SpcToolConfigRecord {
  id: string
  toolId: string
  version: number
  lifeUom: SpcToolLedgerRecord['lifeUom']
  ratedLife: string
  warningThreshold: string
  expirePolicy: SpcToolLedgerRecord['expirePolicy']
  effectiveAt: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
}

export interface NewSpcToolConfig {
  toolId: string
  version: number
  lifeUom: SpcToolConfigRecord['lifeUom']
  ratedLife: string
  warningThreshold: string
  expirePolicy: SpcToolConfigRecord['expirePolicy']
  effectiveAt: string
  enterpriseId: string
  createdBy?: string | null
}

export interface SpcToolUsageRecord {
  id: string
  toolId: string
  source: 'work_report_output' | 'collected_sample'
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

export interface NewSpcToolUsage {
  toolId: string
  source: SpcToolUsageRecord['source']
  quantity: string
  refType: string
  refId: string
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface SpcToolAdjustmentRecord {
  id: string
  toolId: string
  delta: string
  reason: string
  commandReceiptId: string | null
  enterpriseId: string
  createdAt: string
  createdBy: string | null
}

export interface NewSpcToolAdjustment {
  toolId: string
  delta: string
  reason: string
  commandReceiptId?: string | null
  enterpriseId: string
  createdBy?: string | null
}

// ---------------- 跨域只读投影端口（PE-03/11/18 收集事实；无写端口 PE-13） ----------------

/** process 域参数规范版本投影（只读）。 */
export interface ProcessSpecRevisionFact {
  id: string
  plantId: string
  productFamilyId: string
  name: string
  version: number
  status: string
  parameters: unknown
}

/** process 域生产订单投影（只读）。 */
export interface ProductionOrderFact {
  id: string
  orderNo: string
  orderStatus: string
  productFamilyId: string | null
  plantId: string
}

/** process 域订单工序投影（只读；PE-03 判定与 PE-03 重算输入）。 */
export interface OrderOperationFact {
  id: string
  orderId: string
  seq: number
  operationName: string
  settingsVersion: number
  executionStatus: string
  coreMultiple: number
  strandFactor: string | null
  offlineQty: string
  uom: string
}

/** quality 域检验实测/结论投影（只读；PE-11 人工样本来源）。 */
export interface TestResultFact {
  id: string
  inspectionOrderId: string
  conclusion: string
  items: unknown
  inspectedAt: string | null
  inspector: string | null
}

export interface InspectionOrderFact {
  id: string
  orderNo: string
  status: string
  productionOrderNo: string | null
  inventoryUnitId: string | null
  unitNo: string | null
  lotId: string | null
  materialCode: string | null
}

export interface QualityDispositionFact {
  id: string
  inspectionOrderId: string
  dispositionKind: string
  releasedBy: string
  releasedAt: string
}

/** inventory 域库存单元投影（只读；PE-18 圈定分桶）。 */
export interface InventoryUnitFact {
  id: string
  unitNo: string
  status: string
  lotId: string | null
}

export interface MaterialLotFact {
  id: string
  lotNo: string
}

/**
 * 跨域只读投影端口：spc 域读取 process/execution/scheduling/quality/inventory
 * 既有表收集判定与圈定事实（0005/0007/0008/0009/0004 表），**只读不自改**。
 */
export interface SpcCrossDomainReader {
  getProcessSpecRevision(id: string): Promise<ProcessSpecRevisionFact | null>
  listProcessSpecRevisions(plantId: string, name?: string): Promise<ProcessSpecRevisionFact[]>
  listOrdersByProductFamily(plantId: string, productFamilyId: string): Promise<ProductionOrderFact[]>
  listOrderOperations(orderId: string): Promise<OrderOperationFact[]>
  /** PE-03：该订单工序是否存在已提交报工（草稿不计）。 */
  hasSubmittedReport(orderOperationId: string): Promise<boolean>
  /** 已提交报工的工序 seq 集合（PE-07 守卫输入）。 */
  listReportedOperationSeqs(orderId: string): Promise<number[]>
  /** 该订单工序是否有排产槽位（已排产未开工标记，PE-03）。 */
  listScheduledOperationIds(orderId: string): Promise<string[]>
  getTestResult(id: string): Promise<TestResultFact | null>
  getInspectionOrder(id: string): Promise<InspectionOrderFact | null>
  listDispositionsByInspectionOrder(inspectionOrderId: string): Promise<QualityDispositionFact[]>
  getInventoryUnit(id: string): Promise<InventoryUnitFact | null>
  getMaterialLot(id: string): Promise<MaterialLotFact | null>
  getProductionOrderById(id: string): Promise<ProductionOrderFact | null>
  /** 检验单关联生产订单状态（PE-18 在制分桶）。 */
  getProductionOrderStatus(orderNo: string): Promise<string | null>
}

// ---------------- 仓储端口 ----------------

/** 命令回执查询（PgCommandBus 已在事务内抢占幂等键；此处取回 id 供业务行 FK 引用）。 */
export interface SpcReceiptLookup {
  findIdByKey(enterpriseId: string, commandType: string, operationId: string): Promise<string | null>
}

export interface SpcProcessChangeRepository {
  insert(change: NewSpcProcessChange): Promise<SpcProcessChangeRecord>
  findById(id: string): Promise<SpcProcessChangeRecord | null>
  lockById(id: string): Promise<SpcProcessChangeRecord | null>
  findByNo(changeNo: string): Promise<SpcProcessChangeRecord | null>
  /** 生效落库（守卫触发器限定状态列：draft→published + published_at/by）。 */
  markPublished(id: string, patch: { publishedAt: string; publishedBy: string }, actor: string | null): Promise<SpcProcessChangeRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: SpcProcessChangeRecord[]; total: number }>
}

export interface SpcChangeImpactRepository {
  insertMany(impacts: NewSpcChangeImpact[]): Promise<SpcChangeImpactRecord[]>
  listByChange(changeId: string): Promise<SpcChangeImpactRecord[]>
  findById(id: string): Promise<SpcChangeImpactRecord | null>
  /** 逐单处置落库（守卫触发器限定处置列）。 */
  setDisposition(
    id: string,
    patch: {
      disposition: 'continue_old' | 'switch_new' | 'isolation_review'
      followsVersion: 'old' | 'new'
      dispositionBy: string
      dispositionAt: string
    },
    actor: string | null,
  ): Promise<SpcChangeImpactRecord | null>
  /** 发布时回填重算计划量（守卫触发器限定 recomputed 列）。 */
  setRecomputed(id: string, recomputedPlannedQty: string, actor: string | null): Promise<SpcChangeImpactRecord | null>
}

export interface SpcChangeAdjustmentRepository {
  insert(adjustment: NewSpcChangeAdjustment): Promise<SpcChangeAdjustmentRecord>
  listByChange(changeId: string): Promise<SpcChangeAdjustmentRecord[]>
}

export interface SpcRuleSetRepository {
  insert(ruleSet: NewSpcRuleSet): Promise<SpcRuleSetRecord>
  findById(id: string): Promise<SpcRuleSetRecord>
  findByIdOrNull(id: string): Promise<SpcRuleSetRecord | null>
  /** 同名同版本查重（UNIQUE plant+name+version）。 */
  findByPlantNameVersion(plantId: string, name: string, version: number): Promise<SpcRuleSetRecord | null>
  /** 工厂最新已发布规则集（受控项目绑定点；缺省规则集懒建入口）。 */
  findLatestPublished(plantId: string, name?: string): Promise<SpcRuleSetRecord | null>
  publish(id: string, patch: { publishedAt: string; publishedBy: string }, actor: string | null): Promise<SpcRuleSetRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: SpcRuleSetRecord[]; total: number }>
}

export interface SpcControlItemRepository {
  insert(item: NewSpcControlItem): Promise<SpcControlItemRecord>
  findById(id: string): Promise<SpcControlItemRecord | null>
  findBySpecItem(specCode: string, specVersion: number, itemNo: string): Promise<SpcControlItemRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    page: number
    pageSize: number
  }): Promise<{ items: SpcControlItemRecord[]; total: number }>
}

export interface SpcControlLimitRepository {
  insert(limit: NewSpcControlLimit): Promise<SpcControlLimitRecord>
  listByItem(controlItemId: string): Promise<SpcControlLimitRecord[]>
  /** 最新版本（含 building；判定取最新 active）。 */
  findLatest(controlItemId: string): Promise<SpcControlLimitRecord | null>
  findLatestActive(controlItemId: string): Promise<SpcControlLimitRecord | null>
  nextVersion(controlItemId: string): Promise<number>
}

export interface SpcSampleRepository {
  insert(sample: NewSpcSample): Promise<SpcSampleRecord>
  findById(id: string): Promise<SpcSampleRecord | null>
  /** 已准入样本按时序（控制限基线与判异历史）。 */
  listAdmittedByItem(controlItemId: string): Promise<SpcSampleRecord[]>
  /** 失准圈定：该器具全部样本（含被拒，PE-18 全部实测口径）。 */
  listByGauge(gaugeId: string): Promise<SpcSampleRecord[]>
}

export interface SpcPointJudgementRepository {
  insert(judgement: NewSpcPointJudgement): Promise<SpcPointJudgementRecord>
  findBySample(sampleId: string): Promise<SpcPointJudgementRecord | null>
  listByItem(controlItemId: string): Promise<SpcPointJudgementRecord[]>
  /** 处置时点之后的在控判定数（复控确认证据，PE-12）。 */
  countInControlAfter(controlItemId: string, afterIso: string): Promise<number>
}

export interface SpcOocTaskRepository {
  insert(task: NewSpcOocTask): Promise<SpcOocTaskRecord>
  findById(id: string): Promise<SpcOocTaskRecord | null>
  findBySample(sampleId: string): Promise<SpcOocTaskRecord | null>
  /** 失控未处置不得静默关闭：列表默认含 open（处置链可查）。 */
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: SpcOocTaskRecord[]; total: number }>
  dispose(
    id: string,
    patch: {
      causeCategory: string
      correctiveAction: string
      isolationSuggestion: string | null
      disposedBy: string
      disposedAt: string
    },
  ): Promise<SpcOocTaskRecord | null>
  confirmRecontrol(
    id: string,
    patch: { recontrolConfirmedBy: string; recontrolConfirmedAt: string },
  ): Promise<SpcOocTaskRecord | null>
}

export interface SpcGaugeRepository {
  insert(gauge: NewSpcGauge): Promise<SpcGaugeRecord>
  findById(id: string): Promise<SpcGaugeRecord | null>
  findByNo(plantId: string, gaugeNo: string): Promise<SpcGaugeRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    page: number
    pageSize: number
  }): Promise<{ items: SpcGaugeRecord[]; total: number }>
}

export interface SpcCalibrationRepository {
  insert(record: NewSpcCalibrationRecord): Promise<SpcCalibrationRecord>
  /** 追加式：按校准日期倒序（PE-15 新校准不改写旧记录）。 */
  listByGauge(gaugeId: string): Promise<SpcCalibrationRecord[]>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    gaugeId?: string
    page: number
    pageSize: number
  }): Promise<{ items: SpcCalibrationRecord[]; total: number }>
}

export interface SpcMiscalibrationActionRepository {
  insert(action: NewSpcMiscalibrationAction): Promise<SpcMiscalibrationActionRecord>
  listByGaugeWindow(gaugeId: string, windowFrom: string, windowTo: string): Promise<SpcMiscalibrationActionRecord[]>
}

export interface SpcToolLedgerRepository {
  insert(tool: NewSpcToolLedger): Promise<SpcToolLedgerRecord>
  findById(id: string): Promise<SpcToolLedgerRecord | null>
  lockById(id: string): Promise<SpcToolLedgerRecord | null>
  findByNo(plantId: string, toolNo: string): Promise<SpcToolLedgerRecord | null>
  /** 寿命累计（守卫触发器：累计列只增，PE-S5/PE-21）。 */
  addConsumption(id: string, quantity: string, actor: string | null): Promise<SpcToolLedgerRecord | null>
  /** 配置修订（守卫触发器：版本必须递增）。 */
  applyConfig(
    id: string,
    patch: {
      configVersion: number
      lifeUom: SpcToolLedgerRecord['lifeUom']
      ratedLife: string
      warningThreshold: string
      expirePolicy: SpcToolLedgerRecord['expirePolicy']
    },
    actor: string | null,
  ): Promise<SpcToolLedgerRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: SpcToolLedgerRecord[]; total: number }>
}

export interface SpcToolConfigRepository {
  insert(config: NewSpcToolConfig): Promise<SpcToolConfigRecord>
  listByTool(toolId: string): Promise<SpcToolConfigRecord[]>
}

export interface SpcToolUsageRepository {
  insert(usage: NewSpcToolUsage): Promise<SpcToolUsageRecord>
  listByTool(toolId: string): Promise<SpcToolUsageRecord[]>
}

export interface SpcToolAdjustmentRepository {
  insert(adjustment: NewSpcToolAdjustment): Promise<SpcToolAdjustmentRecord>
  listByTool(toolId: string): Promise<SpcToolAdjustmentRecord[]>
  /** 调整合计（带符号；有效寿命 = 累计列 + 调整合计）。 */
  sumByTool(toolId: string): Promise<string>
}

// ---------------- 命令工具集 ----------------

/** spc 域仓储集合。 */
export interface SpcRepositories {
  receipts: SpcReceiptLookup
  changes: SpcProcessChangeRepository
  impacts: SpcChangeImpactRepository
  adjustments: SpcChangeAdjustmentRepository
  ruleSets: SpcRuleSetRepository
  controlItems: SpcControlItemRepository
  controlLimits: SpcControlLimitRepository
  samples: SpcSampleRepository
  judgements: SpcPointJudgementRepository
  oocTasks: SpcOocTaskRepository
  gauges: SpcGaugeRepository
  calibrations: SpcCalibrationRepository
  miscalibrationActions: SpcMiscalibrationActionRepository
  tools: SpcToolLedgerRepository
  toolConfigs: SpcToolConfigRepository
  toolUsages: SpcToolUsageRepository
  toolAdjustments: SpcToolAdjustmentRepository
}

/** Outbox 收集器（同事务写 outbox 平台表；结构兼容 InventoryCommandTools.outbox）。 */
export interface SpcOutboxCollector {
  collect(intent: OutboxIntent): void
}

/**
 * spc 命令工具集：CommandTools（org 基础 + 审计 + 数据范围）超集，
 * 追加 spc 仓储束、跨域只读投影端口与 Outbox 收集器。
 */
export interface SpcCommandTools extends CommandTools {
  spc: SpcRepositories
  cross: SpcCrossDomainReader
  outbox: SpcOutboxCollector
}
