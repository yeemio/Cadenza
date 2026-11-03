/**
 * 报工/投工执行域公开合同（L1-P1-SERVER T10 三入口报工 + T11 投料块）。
 *
 * 规则来源：architecture/contracts/prep/p1/03-production-chain-rules-T05T09T10T11.md
 * 的 A5/A6/A7 节与 D 节（本域尚无冻结合同；字典值本地声明，contracts 零依赖，
 * 不反向 import domain，沿用 auth.ts/process.ts 模式）。
 *
 * 注意：本文件在 L0 整合步加入 packages/contracts/src/index.ts 导出前，
 * 由 tests/** 以相对路径直接引用做响应形状（DTO）冻结断言；数量字段一律 DecimalString。
 */

/** 报工来源三值（[底稿 A6-1]：订单报工/工作台报工/扫码报工）。 */
export type ExecutionSourceDtoValue = 'order' | 'workbench' | 'scan'

/** 会话/报工单提交轴（草稿→已提交；deleted 保留行供审计，K17 不做物理删除口径）。 */
export type ReportStatusDtoValue = 'draft' | 'submitted' | 'deleted'

/** 审核轴（[底稿 A6-4]：待审/自动通过/人工通过；cancelled=已取消审核回待审的留痕值）。 */
export type ReviewStatusDtoValue = 'pending_review' | 'auto_approved' | 'manual_approved' | 'cancelled'

/** 投料类型（[底稿 A7-4]：报工投料/单独投料）。 */
export type FeedTypeDtoValue = 'report' | 'standalone'

/** 报工会话（ReportContext 显式绑定视图）。 */
export interface ExecutionSessionDto {
  id: string
  orderId: string
  source: ExecutionSourceDtoValue
  orderOperationId: string | null
  operationSeq: number | null
  equipmentId: string | null
  equipmentCode: string | null
  operatorUserId: string
  operatorLogin: string
  shiftDate: string
  status: 'open' | 'submitted' | 'cancelled'
  businessTime: string
}

/** 报工单产出行（数量+单位+载体码+目标线边库）。 */
export interface ReportOutputDto {
  id: string
  lineNo: number
  quantity: string
  qualifiedQty: string
  uomId: string
  uomCode: string
  carrierCode: string | null
  targetLocationId: string
  targetLocationCode: string
  /** 审核通过转线边库后的库存单元（未入库为 null；五量 stocked 口径依据）。 */
  stockUnitId: string | null
}

/** 投料记录行（扣前/扣后 + 销售行归属 + 类型）。 */
export interface MaterialConsumptionDto {
  id: string
  orderId: string
  orderOperationId: string
  reportId: string | null
  feedType: FeedTypeDtoValue
  inventoryUnitId: string
  unitNo: string
  barcodeValue: string | null
  quantity: string
  beforeQty: string
  afterQty: string
  salesOrderNo: string | null
  salesLineNo: string | null
  crossOrder: boolean
  deviationReason: string | null
  issuedLocationId: string | null
  issuedLocationCode: string | null
  operatorLogin: string
  businessTime: string
  shiftDate: string | null
}

/** 报工单详情（含产出/投料/审核轴与更正引用）。 */
export interface ProductionReportDto {
  id: string
  sessionId: string
  orderId: string
  orderOperationId: string
  operationSeq: number
  source: ExecutionSourceDtoValue
  status: ReportStatusDtoValue
  reviewStatus: ReviewStatusDtoValue
  operatorUserId: string
  operatorLogin: string
  businessTime: string
  shiftDate: string
  reviewedAt: string | null
  reviewedBy: string | null
  reviewCancelledAt: string | null
  qcCompletedAt: string | null
  correctionOf: string | null
  remark: string | null
  outputs: ReportOutputDto[]
  feeds: MaterialConsumptionDto[]
}

/** 草稿列表行（主页「N条报工待提交」与三入口草稿隔离视图）。 */
export interface ReportDraftDto {
  sessionId: string
  reportId: string | null
  orderId: string
  source: ExecutionSourceDtoValue
  orderOperationId: string | null
  operationSeq: number | null
  operatorLogin: string
  createdAt: string
  remark: string | null
}

/** 五量分立视图（[底稿 A5-3]：草稿/提交/审核/合格/入库，不做混口径）。 */
export interface FiveQuantitiesDto {
  orderId: string
  orderOperationId: string | null
  operationSeq: number | null
  uom: string
  draftQty: string
  submittedQty: string
  approvedQty: string
  qualifiedQty: string
  stockedQty: string
}

/** 扫码报工上下文（扫设备码→按班次日期带任务单→工序/设备默认值）。 */
export interface ScanContextDto {
  equipmentId: string | null
  equipmentCode: string
  shiftDate: string
  scheduledOperations: Array<{
    orderId: string
    orderOperationId: string
    operationSeq: number
    operationDefinitionId: string
  }>
}

/** 工时记录视图。 */
export interface LaborRecordDto {
  id: string
  orderId: string
  orderOperationId: string | null
  reportId: string | null
  operatorUserId: string
  operatorLogin: string
  hours: string
  shiftDate: string
  businessTime: string
  note: string | null
}
