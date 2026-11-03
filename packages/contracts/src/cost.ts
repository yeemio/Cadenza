import type { DecimalString } from './decimal'

/**
 * cost 域公开线合同（P3-D / T24 能源与制造成本归集）。
 *
 * 依据：冻结合同 architecture/contracts/frozen/p3/cost-energy.md（CE-01～CE-20 +
 * CE-S1～CE-S5）；CA-12（工时主从）/CA-13（折旧口径）为 **PROPOSED 依赖**——
 * 本合同按冻结合同默认口径定义，PM/Owner 裁定后如改口径走返工小轮。
 * - 数量/能源量/金额一律 DecimalString（十进制定点、≤4 位小数；价格 ≤6 位，禁 number）；
 * - 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）。
 */

// ---------------- 字典值 ----------------

/** 能源类型（CE-S3：电/水/气）。 */
export type EnergyTypeValue = 'electric' | 'water' | 'gas'

/** 表计覆盖范围（CE-S3：设备级/车间级）。 */
export type MeterCoverageKindValue = 'equipment' | 'workshop'

/** 表计采样来源（CE-S3/CE-09：OT 表计样本/人工抄表）。 */
export type MeterSampleSourceValue = 'ot' | 'manual'

/** 读数来源（manual=人工抄表；ot=OT 样本固化）。 */
export type ReadingTypeValue = 'manual' | 'ot'

/** 分摊公式（CE-12：默认 machine_hours——[合同新造·默认待裁]，PROPOSED 依赖 GAP-E21）。 */
export type AllocationFormulaValue = 'machine_hours' | 'output_qty' | 'power_weight'

/** 价格取数来源（CE-14：标准成本/ERP 采购实际价——价格主权归上游）。 */
export type PriceSourceValue = 'standard_cost' | 'erp_actual'

/** 归集来源类型（CE-05 唯一来源映射）。 */
export type CostSourceKindValue =
  | 'material'
  | 'labor'
  | 'scrap'
  | 'equipment_runtime'
  | 'spare_part'
  | 'energy'

/** 归集明细值标志（CE-03：实测/估算分开，不以估算冒充实测）。 */
export type CostValueFlagValue = 'measured' | 'estimated'

/** 对账数量基础维度（CE-15/16）。 */
export type ReconKindValue = 'material' | 'labor' | 'energy'

/** 对账处置状态（CE-S5：未处置不得清零）。 */
export type ReconDispositionValue = 'open' | 'confirmed' | 'adjusted'

/** 工时核对提示状态（CA-12：open 超阈值待核对/acknowledged 已确认）。 */
export type LaborCheckStatusValue = 'open' | 'acknowledged'

// ---------------- 查询侧 DTO ----------------

/** 表计配置视图（CE-S3）。 */
export interface CostMeterDto {
  meterId: string
  meterCode: string
  meterName: string | null
  energyType: EnergyTypeValue
  coverageKind: MeterCoverageKindValue
  equipmentId: string | null
  equipmentCode: string | null
  workCenterId: string | null
  sampleSource: MeterSampleSourceValue
  otPointId: string | null
  otPointCode: string | null
  uomCode: string
  status: 'active' | 'retired'
}

/** 表计读数视图（CE-05：带源事实引用——OT 读数指向 ot_sample）。 */
export interface CostMeterReadingDto {
  readingId: string
  meterId: string
  readingType: ReadingTypeValue
  reading: DecimalString
  readAt: string
  readBy: string | null
  otSampleId: string | null
  capturedEventTime: string | null
}

/** 分摊版本视图（CE-S2/CE-11/12）。 */
export interface CostAllocationVersionDto {
  versionId: string
  versionNo: number
  formula: AllocationFormulaValue
  params: Record<string, unknown>
  overheadCaliber: string | null
  status: 'active' | 'retired'
  referencedByRuns: number
}

/** 价格版本视图（CE-14）。 */
export interface CostPriceVersionDto {
  versionId: string
  versionNo: number
  priceSource: PriceSourceValue
  status: 'active' | 'retired'
  items: Array<{ materialCode: string; unitPrice: string; uomCode: string }>
}

/** 归集明细行视图（CE-S1/CE-15：源事实表+ID 可逐项回算）。 */
export interface CostAcquisitionLineDto {
  lineId: string
  lineNo: number
  sourceKind: CostSourceKindValue
  sourceTable: string
  sourceFactId: string
  valueFlag: CostValueFlagValue
  orderOperationId: string | null
  operationSeq: number | null
  productFamilyId: string | null
  quantity: DecimalString
  uomCode: string
  theoreticalQuantity: DecimalString | null
  varianceQuantity: DecimalString | null
  destinationBreakdownMissing: boolean
  unitPrice: string | null
  priceMissing: boolean
  amount: DecimalString | null
  facts: Record<string, unknown>
}

/** 归集产出视图（CE-S1/CE-11/CE-17：估算/实测两列并存）。 */
export interface CostAcquisitionRunDto {
  runId: string
  runNo: string
  orderId: string
  orderNo: string
  allocationVersionId: string
  priceVersionId: string
  shiftDate: string
  shiftCalendarId: string
  dataCutoffAt: string
  shiftSnapshotAnchor: Record<string, unknown> | null
  estimateAmount: DecimalString | null
  actualAmount: DecimalString | null
  estimatePossible: boolean
  estimateMissingReason: string | null
  energyMeteredUsage: DecimalString
  energyEstimatedUsage: DecimalString
  energyCoverageRatio: DecimalString | null
  energyUomCode: string | null
  machineHours: DecimalString
  /** CA-12（PROPOSED 默认）：工时主源=labor_record */
  laborSource: string
  /** CA-13（PROPOSED 默认）：设备成本=机时+备件消耗，不含折旧 */
  equipmentCostCaliber: string
  recalcOf: string | null
  oldNewComparison: Record<string, unknown> | null
  createdAt: string
}

/** 订单成本汇总（CE-17：估算/实测两列并存；CE-18 在制口径）。 */
export interface OrderCostSummaryDto {
  orderId: string
  orderNo: string
  latestRun: CostAcquisitionRunDto | null
  /** CE-17：估算列（计划 BOM×价格版本；无已发布 BOM/缺价时金额为 null 并标注） */
  estimate: {
    possible: boolean
    missingReason: string | null
    amount: DecimalString | null
    lines: Array<{
      materialCode: string
      theoreticalQty: DecimalString
      unitPrice: string | null
      uomCode: string
      amount: DecimalString | null
      priceMissing: boolean
    }>
  }
  /** CE-17：实测列（归集）；CE-18：在制按工序已投入（材料+工时，实测口径） */
  wipByOperation: Array<{
    orderOperationId: string | null
    operationSeq: number | null
    materialQty: DecimalString
    materialAmount: DecimalString | null
    laborHours: DecimalString
    laborAmount: DecimalString | null
  }>
}

/** 能源单耗视图（CE-09：产品族/工序能源单耗+覆盖率）。 */
export interface EnergyIntensityDto {
  plantId: string
  productFamilyId: string | null
  productFamilyCode: string | null
  meteredUsage: DecimalString
  estimatedUsage: DecimalString
  coverageRatio: DecimalString | null
  uomCode: string | null
  outputQty: DecimalString | null
  /** 能源单耗 = 总用量/产出量；产出为零或全缺 → null（不以 0 冒充 CE-03） */
  intensityPerOutput: DecimalString | null
}

/** OEE 视图（CE-10：分母齐备后才计算；缺项展示缺项而非假百分比）。 */
export interface OeeDto {
  equipmentId: string
  equipmentCode: string
  windowStart: string
  windowEnd: string
  plannedMinutes: DecimalString | null
  downtimeMinutes: DecimalString | null
  standardSpeedPerHour: DecimalString | null
  actualOutputQty: DecimalString | null
  qualifiedQty: DecimalString | null
  availability: DecimalString | null
  performance: DecimalString | null
  qualityRate: DecimalString | null
  oee: DecimalString | null
  missing: string[]
}

/** 对账差异行视图（CE-S5/CE-16）。 */
export interface CostReconItemDto {
  itemId: string
  reconKey: string
  runId: string
  kind: ReconKindValue
  localQuantity: DecimalString
  erpQuantity: DecimalString
  diffQuantity: DecimalString
  uomCode: string
  materialCode: string | null
  orderNo: string | null
  erpDocumentRef: string | null
  dispositionStatus: ReconDispositionValue
  disposedBy: string | null
  disposedAt: string | null
  dispositionReason: string | null
}

/** 工时核对提示视图（CA-12·PROPOSED）。 */
export interface CostLaborCheckDto {
  checkId: string
  orderId: string
  orderNo: string
  orderOperationId: string | null
  operationSeq: number | null
  shiftDate: string
  laborHours: DecimalString
  otRuntimeHours: DecimalString | null
  deviationRatio: DecimalString | null
  thresholdRatio: DecimalString
  status: LaborCheckStatusValue
  missingSide: 'labor' | 'ot' | null
}

// ---------------- 命令载荷 ----------------

/** cost.meter.register 载荷（CE-S3）。 */
export interface CostMeterRegisterPayload {
  plantId: string
  meterCode: string
  meterName?: string
  energyType: EnergyTypeValue
  coverageKind: MeterCoverageKindValue
  equipmentId?: string
  workCenterId?: string
  sampleSource: MeterSampleSourceValue
  otPointId?: string
  uomCode: string
  remark?: string
  reason?: string
  operationId?: string
  businessTime?: string
}

/** cost.meter.reading.record 载荷（CE-09：人工抄表通道）。 */
export interface CostMeterReadingRecordPayload {
  plantId: string
  meterId: string
  reading: DecimalString
  readAt: string
  reason?: string
  operationId?: string
  businessTime?: string
}

/** cost.allocation-version.create 载荷（CE-S2/CE-11/12）。 */
export interface CostAllocationVersionCreatePayload {
  plantId: string
  versionNo: number
  formula: AllocationFormulaValue
  params?: Record<string, unknown>
  overheadCaliber?: string
  remark?: string
  reason?: string
  operationId?: string
  businessTime?: string
}

/** cost.price-version.create 载荷（CE-14）。 */
export interface CostPriceVersionCreatePayload {
  plantId: string
  versionNo: number
  priceSource: PriceSourceValue
  items: Array<{ materialCode: string; materialId?: string; unitPrice: string; uomCode: string }>
  remark?: string
  reason?: string
  operationId?: string
  businessTime?: string
}

/** cost.acquisition.run 载荷（CE-S1/CE-11：首次归集）。 */
export interface CostAcquisitionRunPayload {
  plantId: string
  orderId: string
  shiftDate: string
  dataCutoffAt: string
  allocationVersionId: string
  priceVersionId: string
  reason?: string
  operationId?: string
  businessTime?: string
}

/** cost.acquisition.recalc 载荷（CE-11：显式重算——新版本/新截止时点，输出新旧对照；理由必填）。 */
export interface CostAcquisitionRecalcPayload {
  plantId: string
  orderId: string
  shiftDate: string
  dataCutoffAt: string
  allocationVersionId: string
  priceVersionId: string
  reason: string
  operationId?: string
  businessTime?: string
}

/** cost.recon.erp-import 载荷（CE-16：模拟适配器入站——真实 ERP 对账 BLOCKED_EXTERNAL）。 */
export interface CostReconErpImportPayload {
  plantId: string
  runId: string
  rows: Array<{
    kind: ReconKindValue
    localQuantity: DecimalString
    erpQuantity: DecimalString
    uomCode: string
    materialCode?: string
    orderNo?: string
    erpDocumentRef?: string
  }>
  reason?: string
  operationId?: string
  businessTime?: string
}

/** cost.recon.resolve 载荷（CE-S5：处置流转，理由必填）。 */
export interface CostReconResolvePayload {
  plantId: string
  itemId: string
  targetStatus: ReconDispositionValue
  reason: string
  operationId?: string
  businessTime?: string
}

/** cost.labor-check.run 载荷（CA-12：偏差核对提示生成）。 */
export interface CostLaborCheckRunPayload {
  plantId: string
  orderId: string
  shiftDate: string
  thresholdRatio?: DecimalString
  reason?: string
  operationId?: string
  businessTime?: string
}

/** cost.labor-check.acknowledge 载荷（CA-12：核对确认留痕）。 */
export interface CostLaborCheckAcknowledgePayload {
  plantId: string
  checkId: string
  reason: string
  operationId?: string
  businessTime?: string
}
