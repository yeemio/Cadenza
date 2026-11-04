import type { OeeOutputRow, OeeInterval } from '@cadenza/domain'
import type { OutboxIntent } from './unit-of-work'
import type { CommandTools } from './command-bus'

/**
 * cost 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0020 cost 表列一一对应；时间字段一律 ISO-8601 字符串；
 * 数量/能源量/金额一律 4 位小数 DecimalString、价格 6 位（CE-03 定点口径）。
 *
 * CE-02：归集管道对既有域（报工/消耗/停机/OT/库存）**只读**——写端口仅覆盖本域
 * 0020 表（表计/读数/版本/归集/对账/工时核对），无任何库存写命令。
 * 事实读取端口（CostFactReaders）= CE-05 唯一来源映射的消费面：
 * 材料=material_consumption、工时=labor_record（CA-12 主源）、损耗=report_output、
 * 设备运行/停机=ot_sample（等价计算）+downtime_event（T19）、备件=spare_part_usage、
 * 能源=cost_meter_reading（OT 样本固化+人工抄表）。
 */

// ---------------- 记录类型（0020 表） ----------------

export interface CostMeterRecord {
  id: string
  meterCode: string
  meterName: string | null
  energyType: 'electric' | 'water' | 'gas'
  coverageKind: 'equipment' | 'workshop'
  equipmentId: string | null
  workCenterId: string | null
  sampleSource: 'ot' | 'manual'
  otPointId: string | null
  uomCode: string
  status: 'active' | 'retired'
  remark: string | null
  enterpriseId: string
  plantId: string
  businessTime: string
  commandReceiptId: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewCostMeter {
  meterCode: string
  meterName?: string | null
  energyType: CostMeterRecord['energyType']
  coverageKind: CostMeterRecord['coverageKind']
  equipmentId?: string | null
  workCenterId?: string | null
  sampleSource: CostMeterRecord['sampleSource']
  otPointId?: string | null
  uomCode: string
  remark?: string | null
  enterpriseId: string
  plantId: string
  businessTime?: string
  commandReceiptId?: string | null
  createdBy?: string | null
}

export interface CostMeterReadingRecord {
  id: string
  meterId: string
  readingType: 'manual' | 'ot'
  reading: string
  readAt: string
  readBy: string | null
  otSampleId: string | null
  capturedEventTime: string | null
  enterpriseId: string
  plantId: string
  businessTime: string
  commandReceiptId: string | null
  createdAt: string
  createdBy: string | null
}

export interface NewCostMeterReading {
  meterId: string
  readingType: 'manual' | 'ot'
  reading: string
  readAt: string
  readBy?: string | null
  otSampleId?: string | null
  capturedEventTime?: string | null
  enterpriseId: string
  plantId: string
  businessTime?: string
  commandReceiptId?: string | null
  createdBy?: string | null
}

export interface CostAllocationVersionRecord {
  id: string
  versionNo: number
  formula: 'machine_hours' | 'output_qty' | 'power_weight'
  params: Record<string, unknown>
  overheadCaliber: string | null
  status: 'active' | 'retired'
  remark: string | null
  enterpriseId: string
  plantId: string
  businessTime: string
  commandReceiptId: string | null
  createdAt: string
  createdBy: string | null
}

export interface NewCostAllocationVersion {
  versionNo: number
  formula: CostAllocationVersionRecord['formula']
  params?: Record<string, unknown>
  overheadCaliber?: string | null
  remark?: string | null
  enterpriseId: string
  plantId: string
  businessTime?: string
  commandReceiptId?: string | null
  createdBy?: string | null
}

export interface CostPriceVersionRecord {
  id: string
  versionNo: number
  priceSource: 'standard_cost' | 'erp_actual'
  status: 'active' | 'retired'
  remark: string | null
  enterpriseId: string
  plantId: string
  businessTime: string
  commandReceiptId: string | null
  createdAt: string
  createdBy: string | null
  items: Array<{ materialCode: string; materialId: string | null; unitPrice: string; uomCode: string }>
}

export interface NewCostPriceVersion {
  versionNo: number
  priceSource: CostPriceVersionRecord['priceSource']
  items: Array<{ materialCode: string; materialId: string | null; unitPrice: string; uomCode: string }>
  remark?: string | null
  enterpriseId: string
  plantId: string
  businessTime?: string
  commandReceiptId?: string | null
  createdBy?: string | null
}

export interface CostAcquisitionRunRecord {
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
  laborSource: string
  equipmentCostCaliber: string
  recalcOf: string | null
  oldNewComparison: Record<string, unknown> | null
  enterpriseId: string
  plantId: string
  businessTime: string
  commandReceiptId: string
  createdAt: string
  createdBy: string | null
}

export interface NewCostAcquisitionRun {
  runNo: string
  orderId: string
  allocationVersionId: string
  priceVersionId: string
  shiftDate: string
  shiftCalendarId: string
  dataCutoffAt: string
  shiftSnapshotAnchor?: Record<string, unknown> | null
  estimateAmount?: string | null
  actualAmount?: string | null
  estimatePossible?: boolean
  estimateMissingReason?: string | null
  energyMeteredUsage?: string
  energyEstimatedUsage?: string
  energyCoverageRatio?: string | null
  energyUomCode?: string | null
  machineHours?: string
  laborSource?: string
  equipmentCostCaliber?: string
  recalcOf?: string | null
  oldNewComparison?: Record<string, unknown> | null
  enterpriseId: string
  plantId: string
  businessTime?: string
  commandReceiptId: string
  createdBy?: string | null
}

export interface CostAcquisitionLineRecord {
  id: string
  runId: string
  lineNo: number
  sourceKind: 'material' | 'labor' | 'scrap' | 'equipment_runtime' | 'spare_part' | 'energy'
  sourceTable: string
  sourceFactId: string
  valueFlag: 'measured' | 'estimated'
  orderId: string
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
  createdAt: string
  createdBy: string | null
}

export interface NewCostAcquisitionLine {
  runId: string
  lineNo: number
  sourceKind: CostAcquisitionLineRecord['sourceKind']
  sourceTable: string
  sourceFactId: string
  valueFlag: CostAcquisitionLineRecord['valueFlag']
  orderId: string
  orderOperationId?: string | null
  productFamilyId?: string | null
  quantity: string
  uomCode: string
  theoreticalQuantity?: string | null
  varianceQuantity?: string | null
  destinationBreakdownMissing?: boolean
  unitPrice?: string | null
  priceMissing?: boolean
  amount?: string | null
  facts?: Record<string, unknown>
  createdBy?: string | null
}

export interface CostReconItemRecord {
  id: string
  reconKey: string
  runId: string
  kind: 'material' | 'labor' | 'energy'
  localQuantity: string
  erpQuantity: string
  diffQuantity: string
  uomCode: string
  materialCode: string | null
  orderNo: string | null
  erpDocumentRef: string | null
  dispositionStatus: 'open' | 'confirmed' | 'adjusted'
  disposedBy: string | null
  disposedAt: string | null
  dispositionReason: string | null
  enterpriseId: string
  plantId: string
  businessTime: string
  commandReceiptId: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewCostReconItem {
  reconKey: string
  runId: string
  kind: CostReconItemRecord['kind']
  localQuantity: string
  erpQuantity: string
  diffQuantity: string
  uomCode: string
  materialCode?: string | null
  orderNo?: string | null
  erpDocumentRef?: string | null
  enterpriseId: string
  plantId: string
  commandReceiptId: string
  createdBy?: string | null
}

export interface CostLaborCheckRecord {
  id: string
  orderId: string
  operationKey: string
  orderOperationId: string | null
  shiftDate: string
  laborHours: string
  otRuntimeHours: string | null
  deviationRatio: string | null
  thresholdRatio: string
  status: 'open' | 'acknowledged'
  missingSide: 'labor' | 'ot' | null
  acknowledgedBy: string | null
  acknowledgedAt: string | null
  reason: string | null
  enterpriseId: string
  plantId: string
  businessTime: string
  commandReceiptId: string
  createdAt: string
  createdBy: string | null
}

export interface NewCostLaborCheck {
  orderId: string
  operationKey: string
  orderOperationId?: string | null
  shiftDate: string
  laborHours: string
  otRuntimeHours?: string | null
  deviationRatio?: string | null
  thresholdRatio: string
  status?: 'open' | 'acknowledged'
  missingSide?: 'labor' | 'ot' | null
  reason?: string | null
  enterpriseId: string
  plantId: string
  businessTime?: string
  commandReceiptId: string
  createdBy?: string | null
}

// ---------------- 写仓储端口 ----------------

export interface CostMeterRepository {
  insert(meter: NewCostMeter): Promise<CostMeterRecord>
  findById(id: string): Promise<CostMeterRecord | null>
  /** (plant, code) active 查重（CE-S3 唯一性）。 */
  findActiveByPlantAndCode(plantId: string, meterCode: string): Promise<CostMeterRecord | null>
  /** OT 点位被表计引用查重（换绑需先退役旧表计）。 */
  findActiveByOtPoint(otPointId: string): Promise<CostMeterRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    energyTypes?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: CostMeterRecord[]; total: number }>
  listActiveByPlant(plantId: string): Promise<CostMeterRecord[]>
}

export interface CostMeterReadingRepository {
  insert(reading: NewCostMeterReading): Promise<CostMeterReadingRecord>
  /** OT 样本固化幂等（(meter_id, ot_sample_id) 唯一；冲突跳过返回已存在行）。 */
  insertOtIfAbsent(reading: NewCostMeterReading): Promise<{ reading: CostMeterReadingRecord; inserted: boolean }>
  findById(id: string): Promise<CostMeterReadingRecord | null>
  listByMeterWindow(meterId: string, fromIso: string, toIso: string): Promise<CostMeterReadingRecord[]>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    meterId?: string
    page: number
    pageSize: number
  }): Promise<{ items: CostMeterReadingRecord[]; total: number }>
}

export interface CostAllocationVersionRepository {
  insert(version: NewCostAllocationVersion): Promise<CostAllocationVersionRecord>
  findById(id: string): Promise<CostAllocationVersionRecord | null>
  findByPlantAndVersionNo(plantId: string, versionNo: number): Promise<CostAllocationVersionRecord | null>
  /** 引用计数（CE-S2 被引用 immutable 的应用层断言源）。 */
  countRunsReferencing(id: string): Promise<number>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: CostAllocationVersionRecord[]; total: number }>
}

export interface CostPriceVersionRepository {
  insert(version: NewCostPriceVersion): Promise<CostPriceVersionRecord>
  findById(id: string): Promise<CostPriceVersionRecord | null>
  findByPlantAndVersionNo(plantId: string, versionNo: number): Promise<CostPriceVersionRecord | null>
  findItems(versionId: string): Promise<Array<{ materialCode: string; materialId: string | null; unitPrice: string; uomCode: string }>>
  countRunsReferencing(id: string): Promise<number>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: Omit<CostPriceVersionRecord, 'items'>[]; total: number }>
}

export interface CostAcquisitionRunRepository {
  insert(run: NewCostAcquisitionRun): Promise<CostAcquisitionRunRecord>
  findById(id: string): Promise<CostAcquisitionRunRecord | null>
  /** (order, shift) 最新归集（CE-11 首跑/重算分流）。 */
  findLatestByOrderAndShift(orderId: string, shiftDate: string): Promise<CostAcquisitionRunRecord | null>
  countByOrderAndShift(orderId: string, shiftDate: string): Promise<number>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    orderId?: string
    shiftDate?: string
    page: number
    pageSize: number
  }): Promise<{ items: CostAcquisitionRunRecord[]; total: number }>
}

export interface CostAcquisitionLineRepository {
  insertMany(lines: NewCostAcquisitionLine[]): Promise<CostAcquisitionLineRecord[]>
  listByRun(runId: string): Promise<CostAcquisitionLineRecord[]>
  listByOrder(orderId: string): Promise<CostAcquisitionLineRecord[]>
}

export interface CostReconItemRepository {
  insert(item: NewCostReconItem): Promise<CostReconItemRecord>
  findById(id: string): Promise<CostReconItemRecord | null>
  findByKey(reconKey: string): Promise<CostReconItemRecord | null>
  /** 处置列流转（事实列由库级守卫保护）。 */
  updateDisposition(
    id: string,
    patch: {
      dispositionStatus: CostReconItemRecord['dispositionStatus']
      disposedBy: string
      disposedAt: string
      dispositionReason: string
      erpDocumentRef?: string | null
    },
    actor: string | null,
  ): Promise<CostReconItemRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    runId?: string
    kinds?: string[]
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: CostReconItemRecord[]; total: number }>
}

export interface CostLaborCheckRepository {
  insert(check: NewCostLaborCheck): Promise<CostLaborCheckRecord>
  findById(id: string): Promise<CostLaborCheckRecord | null>
  findByKey(orderId: string, operationKey: string, shiftDate: string): Promise<CostLaborCheckRecord | null>
  /** 确认列流转（事实列由库级守卫保护；CA-12 不改写报工）。 */
  updateAcknowledged(
    id: string,
    patch: { acknowledgedBy: string; acknowledgedAt: string; reason: string },
    actor: string | null,
  ): Promise<CostLaborCheckRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    orderId?: string
    statuses?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: CostLaborCheckRecord[]; total: number }>
}

// ---------------- 事实读取端口（CE-05 唯一来源映射；只读 CE-02） ----------------

/** 投料消耗事实（T11 material_consumption，经 inventory_unit 带出料品码）。 */
export interface ConsumptionFact {
  id: string
  orderId: string
  orderOperationId: string
  operationSeq: number
  quantity: string
  uomCode: string
  unitNo: string
  materialCode: string | null
  businessTime: string
}

/** 工时事实（T10 labor_record——CA-12 PROPOSED 默认：唯一入账主源）。 */
export interface LaborFact {
  id: string
  orderId: string
  orderOperationId: string | null
  operationSeq: number | null
  hours: string
  shiftDate: string
  businessTime: string
}

/** 报工产出事实（report_output 挂 production_report；submitted 口径）。 */
export interface OutputFact {
  id: string
  orderId: string
  orderOperationId: string
  operationSeq: number
  quantity: string
  qualifiedQty: string
  stockUnitId: string | null
  uomCode: string
  businessTime: string
}

/** 备件消耗事实（T19 spare_part_usage）。 */
export interface SparePartFact {
  id: string
  quantity: string
  uomCode: string
  materialCode: string | null
  equipmentId: string
  businessTime: string
}

/** OT 采集事实（T21 ot_sample；表计累计读数与运行秒数等价计算的源）。 */
export interface OtSampleFact {
  id: string
  deviceSerial: string
  pointCode: string
  eventTime: string
  value: string
  qualityLevel: string
}

export interface CostFactReaders {
  /** 0005 生产订单（归集锚）。 */
  findProductionOrder(orderId: string): Promise<{
    id: string
    orderNo: string
    plantId: string
    enterpriseId: string
    materialId: string
    materialCode: string
    plannedQty: string
    uom: string
    bomRevisionId: string | null
    productFamilyId: string | null
    orderStatus: string
  } | null>
  /** 0005 订单工序。 */
  listOrderOperations(orderId: string): Promise<Array<{ id: string; seq: number; operationCode: string; operationName: string }>>
  /** 0005 已发布 BOM 行（理论量；订单未绑已发布 BOM → null=估算缺项 CE-03）。 */
  findPublishedBomLines(orderId: string): Promise<Array<{ materialCode: string; qtyPerUnit: string; uomCode: string }> | null>
  /** 0008 投料实耗（cutoff 前，feed_type report/standalone 均为实耗事实）。 */
  listConsumptionByOrder(orderId: string, cutoffIso: string): Promise<ConsumptionFact[]>
  /** 0008 报工工时（CA-12 主源）。 */
  listLaborByOrder(orderId: string, cutoffIso: string): Promise<LaborFact[]>
  /** 0008 报工产出（submitted 口径；损耗与在制变化来源）。 */
  listOutputsByOrder(orderId: string, cutoffIso: string): Promise<OutputFact[]>
  /** 0008 报工会话（订单-设备占用关系：equipment_code 去重+按工序计数）。 */
  listSessionEquipmentCountsByOrder(orderId: string, cutoffIso: string): Promise<Array<{ equipmentCode: string; orderOperationId: string | null; sessionCount: number }>>
  /** 全厂会话设备占用计数（窗口内份额分母；订单归属可选过滤）。 */
  listSessionEquipmentCounts(plantId: string, fromIso: string, toIso: string, orderId?: string): Promise<Array<{ equipmentCode: string; sessionCount: number }>>
  /** 全厂窗口内各订单产出合计（output_qty 分摊基；report_output submitted 口径）。 */
  listPlantOutputByOrder(plantId: string, fromIso: string, toIso: string): Promise<Array<{ orderId: string; quantity: string }>>
  /** 全厂窗口内产出合计与合格量合计（OEE 质量率/性能率分子；无产出 → null=缺项）。 */
  plantOutputTotals(plantId: string, fromIso: string, toIso: string): Promise<{ totalQty: string | null; qualifiedQty: string | null }>
  /** Same-enterprise/factory equipment attribution candidates, exact [start,end) report time. */
  equipmentOeeFacts(equipmentId:string,fromIso:string,toIso:string):Promise<{outputs:OeeOutputRow[];downtime:OeeInterval[];downtimeFactCount:number}>
  /** 0003 设备（按 code）。 */
  findEquipmentByCode(plantId: string, code: string): Promise<{ id: string; code: string; name: string; stdRateText: string | null; enterpriseId:string; plantId:string } | null>
  /** 0002 班次日历（归集锚引用）。 */
  findShiftCalendar(plantId: string): Promise<{ id: string; code: string; name: string } | null>
  /** 0016 班次快照统计（CE-19 时点锚；无行 → null）。 */
  shiftSnapshotStats(plantId: string, shiftDate: string): Promise<{ snapshotCount: number; lastComputedAt: string } | null>
  /** 0015 停机分钟（窗口内合计；无事实行 → null=停机缺项）。 */
  downtimeMinutesByEquipment(equipmentId: string, fromIso: string, toIso: string): Promise<string | null>
  /** 0015 备件消耗（CA-13 设备成本口径组成部分）。 */
  listSparePartUsageByEquipment(equipmentId: string, fromIso: string, toIso: string): Promise<SparePartFact[]>
  /** 0017 OT 运行小时（CA-12 参考源；speed>0 优良采样去重秒数÷3600；无采样 → null）。 */
  otRuntimeHoursByEquipment(equipmentId: string, fromIso: string, toIso: string): Promise<{ hours: string; firstSampleId: string | null; sampleCount: number } | null>
  /** 0017 OT 表计点位样本（表计读数固化来源）。 */
  listOtSamplesByPoint(otPointId: string, fromIso: string, toIso: string): Promise<OtSampleFact[]>
}

// ---------------- 命令工具集 ----------------

/** cost 域仓储集合（0020 表写端口）。 */
export interface CostRepositories {
  meters: CostMeterRepository
  readings: CostMeterReadingRepository
  allocationVersions: CostAllocationVersionRepository
  priceVersions: CostPriceVersionRepository
  runs: CostAcquisitionRunRepository
  lines: CostAcquisitionLineRepository
  reconItems: CostReconItemRepository
  laborChecks: CostLaborCheckRepository
  /** 事实读取端口（CE-05 唯一来源映射；只读）。 */
  facts: CostFactReaders
  /** 0001 命令回执窄读（处理器上下文构建，同 maintenance 先例）。 */
  receipts: { findIdByKey(enterpriseId: string, commandType: string, operationId: string): Promise<string | null> }
}

/** Outbox 收集器窄口（同事务写 0001 outbox；成本归集完成通知任务）。 */
export interface CostOutboxCollector {
  collect(intent: OutboxIntent): void
}

/** cost 命令工具集：基础 CommandTools + cost 仓储束。 */
export interface CostCommandTools extends CommandTools {
  cost: CostRepositories
  outbox: CostOutboxCollector
}
