import type { CommandTools } from './command-bus'
import type { OutboxCollector } from './inventory-repositories'
import type { InventoryRepositories } from './inventory-repositories'
import type { ProcessRepositories } from './process-repositories'
import type { PageRequest, PageResult } from '@cadenza/contracts'

/**
 * execution 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0008 表列一一对应；时间字段一律 ISO-8601 字符串；
 * 数量字段一律 DecimalString（映射 numeric(18,4)，pg 以字符串往返保真）。
 *
 * 注意：本文件未加入 application/src/index.ts 导出（S2 共享文件不可改，L0 整合步统一导出）；
 * persistence 实现以 dist 相对导入消费本端口（见 packages/persistence/src/execution-repositories.ts）。
 */

// ---------------- 记录类型 ----------------

export type ExecutionSessionStatus = 'open' | 'submitted' | 'cancelled'
export type ReportSourceValue = 'order' | 'workbench' | 'scan'
export type ReportStatusValue = 'draft' | 'submitted' | 'deleted'
/** 审核轴三值；取消审核=回到 pending_review 并以 reviewCancelledAt/By/Reason 留痕。 */
export type ReviewStatusValue = 'pending_review' | 'auto_approved' | 'manual_approved'
export type FeedTypeValue = 'report' | 'standalone'

export interface ExecutionSessionRecord {
  id: string
  enterpriseId: string
  plantId: string
  orderId: string
  source: ReportSourceValue
  orderOperationId: string | null
  operationSeq: number | null
  equipmentId: string | null
  equipmentCode: string | null
  operatorUserId: string
  operatorLogin: string
  shiftDate: string
  status: ExecutionSessionStatus
  businessTime: string
  /** 草稿投料意图行（jsonb 快照；提交时逐行扣减并转 material_consumption）。 */
  draftFeeds: unknown[]
  remark: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewExecutionSession {
  id?: string
  enterpriseId: string
  plantId: string
  orderId: string
  source: ReportSourceValue
  orderOperationId?: string | null
  operationSeq?: number | null
  equipmentId?: string | null
  equipmentCode?: string | null
  operatorUserId: string
  operatorLogin: string
  shiftDate: string
  businessTime: string
  draftFeeds?: unknown[]
  remark?: string | null
  createdBy?: string | null
}

export interface ExecutionSessionPatch {
  orderOperationId?: string | null
  operationSeq?: number | null
  equipmentId?: string | null
  equipmentCode?: string | null
  shiftDate?: string
  businessTime?: string
  status?: ExecutionSessionStatus
  draftFeeds?: unknown[]
  remark?: string | null
}

export interface ProductionReportRecord {
  id: string
  enterpriseId: string
  plantId: string
  sessionId: string
  orderId: string
  orderOperationId: string
  operationSeq: number
  source: ReportSourceValue
  status: ReportStatusValue
  reviewStatus: ReviewStatusValue
  operatorUserId: string
  operatorLogin: string
  businessTime: string
  shiftDate: string
  equipmentId: string | null
  equipmentCode: string | null
  reviewedAt: string | null
  reviewedBy: string | null
  reviewCancelledAt: string | null
  reviewCancelledBy: string | null
  reviewCancelReason: string | null
  qcCompletedAt: string | null
  correctionOf: string | null
  deletedAt: string | null
  deletedBy: string | null
  remark: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewProductionReport {
  id?: string
  enterpriseId: string
  plantId: string
  sessionId: string
  orderId: string
  orderOperationId: string
  operationSeq: number
  source: ReportSourceValue
  status?: ReportStatusValue
  reviewStatus?: ReviewStatusValue
  operatorUserId: string
  operatorLogin: string
  businessTime: string
  shiftDate: string
  equipmentId?: string | null
  equipmentCode?: string | null
  correctionOf?: string | null
  remark?: string | null
  createdBy?: string | null
}

export interface ProductionReportPatch {
  status?: ReportStatusValue
  reviewStatus?: ReviewStatusValue
  reviewedAt?: string | null
  reviewedBy?: string | null
  reviewCancelledAt?: string | null
  reviewCancelledBy?: string | null
  reviewCancelReason?: string | null
  qcCompletedAt?: string | null
  deletedAt?: string | null
  deletedBy?: string | null
  remark?: string | null
  operatorUserId?: string
  operatorLogin?: string
  businessTime?: string
  shiftDate?: string
}

export interface ReportOutputRecord {
  id: string
  enterpriseId: string
  plantId: string
  reportId: string
  lineNo: number
  quantity: string
  qualifiedQty: string
  uomId: string
  uomCode: string
  carrierCode: string | null
  targetLocationId: string
  targetLocationCode: string
  ownerId: string
  ownerName: string
  measurementBasis: string
  stockUnitId: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewReportOutput {
  reportId: string
  lineNo: number
  quantity: string
  qualifiedQty: string
  uomId: string
  uomCode: string
  carrierCode?: string | null
  targetLocationId: string
  targetLocationCode: string
  ownerId: string
  ownerName: string
  measurementBasis?: string
  enterpriseId: string
  plantId: string
  createdBy?: string | null
}

export interface MaterialConsumptionRecord {
  id: string
  enterpriseId: string
  plantId: string
  orderId: string
  orderOperationId: string
  operationSeq: number
  reportId: string | null
  feedType: FeedTypeValue
  inventoryUnitId: string
  unitNo: string
  barcodeValue: string | null
  quantity: string
  beforeQty: string
  afterQty: string
  uomId: string
  uomCode: string
  salesOrderNo: string | null
  salesLineNo: string | null
  crossOrder: boolean
  deviationReason: string | null
  issuedLocationId: string | null
  issuedLocationCode: string | null
  genealogyTargetUnitId: string | null
  operatorUserId: string
  operatorLogin: string
  businessTime: string
  shiftDate: string | null
  commandReceiptId: string
  createdAt: string
  createdBy: string | null
}

export interface NewMaterialConsumption {
  id?: string
  enterpriseId: string
  plantId: string
  orderId: string
  orderOperationId: string
  operationSeq: number
  reportId?: string | null
  feedType: FeedTypeValue
  inventoryUnitId: string
  unitNo: string
  barcodeValue?: string | null
  quantity: string
  beforeQty: string
  afterQty: string
  uomId: string
  uomCode: string
  salesOrderNo?: string | null
  salesLineNo?: string | null
  crossOrder?: boolean
  deviationReason?: string | null
  issuedLocationId?: string | null
  issuedLocationCode?: string | null
  genealogyTargetUnitId?: string | null
  operatorUserId: string
  operatorLogin: string
  businessTime: string
  shiftDate?: string | null
  commandReceiptId: string
  createdBy?: string | null
}

export interface LaborRecordRecord {
  id: string
  enterpriseId: string
  plantId: string
  orderId: string
  orderOperationId: string | null
  reportId: string | null
  operatorUserId: string
  operatorLogin: string
  hours: string
  businessTime: string
  shiftDate: string
  note: string | null
  createdAt: string
  createdBy: string | null
}

export interface NewLaborRecord {
  id?: string
  enterpriseId: string
  plantId: string
  orderId: string
  orderOperationId?: string | null
  reportId?: string | null
  operatorUserId: string
  operatorLogin: string
  hours: string
  businessTime: string
  shiftDate: string
  note?: string | null
  createdBy?: string | null
}

// ---------------- 仓储端口 ----------------

export interface ExecutionSessionRepository {
  findById(id: string): Promise<ExecutionSessionRecord | null>
  findBySessionReportId(reportId: string): Promise<ExecutionSessionRecord | null>
  /** 同操作工+同订单的全部 open 会话（[底稿 A6-2] 隔离键与跨来源互斥判定输入）。 */
  listOpenByOperatorAndOrder(operatorUserId: string, orderId: string): Promise<ExecutionSessionRecord[]>
  insert(session: NewExecutionSession): Promise<ExecutionSessionRecord>
  update(id: string, patch: ExecutionSessionPatch, actor: string | null): Promise<ExecutionSessionRecord | null>
  list(
    filter: {
      enterpriseId: string
      plantIds: string[] | null
      orderId?: string
      operatorUserId?: string
      source?: ReportSourceValue
      status?: ExecutionSessionStatus
    } & PageRequest,
  ): Promise<PageResult<ExecutionSessionRecord>>
}

export interface ProductionReportRepository {
  findById(id: string): Promise<ProductionReportRecord | null>
  findBySessionId(sessionId: string): Promise<ProductionReportRecord | null>
  insert(report: NewProductionReport): Promise<ProductionReportRecord>
  update(id: string, patch: ProductionReportPatch, actor: string | null): Promise<ProductionReportRecord | null>
  listByOrder(orderId: string): Promise<ProductionReportRecord[]>
  listByOrderOperation(orderId: string, orderOperationId: string): Promise<ProductionReportRecord[]>
  list(
    filter: {
      enterpriseId: string
      plantIds: string[] | null
      orderId?: string
      operatorUserId?: string
      statuses?: ReportStatusValue[]
      reviewStatuses?: ReviewStatusValue[]
    } & PageRequest,
  ): Promise<PageResult<ProductionReportRecord>>
}

export interface ReportOutputRepository {
  insertBatch(outputs: NewReportOutput[]): Promise<ReportOutputRecord[]>
  listByReport(reportId: string): Promise<ReportOutputRecord[]>
  /** 订单全量产出行（就绪事实/超产累计/五量聚合输入；按 report_id 分组消费）。 */
  listByOrder(orderId: string): Promise<ReportOutputRecord[]>
  /** 按入库单元反查产出行（投料码准入「非本工序产出/本订单前道产出」判定输入）。 */
  listByStockUnit(stockUnitId: string): Promise<ReportOutputRecord[]>
  originReportsForUnit(stockUnitId: string): Promise<Array<{ reportId: string | null }>>
  listStageReadiness(parentOrderId: string): Promise<Array<{ seq: number; submitted: boolean; hasOutput: boolean }>>
  updateStockUnit(id: string, stockUnitId: string | null, actor: string | null): Promise<ReportOutputRecord | null>
  /** 草稿产出行替换（保存草稿整集语义；仅 status=draft 报工单允许调用）。 */
  replaceDraftOutputs(reportId: string, outputs: NewReportOutput[], actor: string | null): Promise<ReportOutputRecord[]>
  /** 已提交待审单的数量/合格数修正（不改载体码——K15/删除守卫「码未动」的结构保证）。 */
  updateQuantities(id: string, quantity: string, qualifiedQty: string, actor: string | null): Promise<ReportOutputRecord | null>
}

export interface MaterialConsumptionRepository {
  insert(record: NewMaterialConsumption): Promise<MaterialConsumptionRecord>
  findById(id: string): Promise<MaterialConsumptionRecord | null>
  listByReport(reportId: string): Promise<MaterialConsumptionRecord[]>
  listByOrder(orderId: string): Promise<MaterialConsumptionRecord[]>
  /** 按被耗单元反查（取消审核守卫「产出已被消耗」对象关系检查，K18）。 */
  listByUnit(inventoryUnitId: string): Promise<MaterialConsumptionRecord[]>
  /** 谱系边未回填的投料行（报工产出单元落成时补写 production_output 边）。 */
  listUnlinkedByOrderOperation(orderId: string, orderOperationId: string): Promise<MaterialConsumptionRecord[]>
  markGenealogyTarget(id: string, targetUnitId: string, actor: string | null): Promise<MaterialConsumptionRecord | null>
}

export interface LaborRecordRepository {
  insert(record: NewLaborRecord): Promise<LaborRecordRecord>
  listByOrder(orderId: string): Promise<LaborRecordRecord[]>
}

/** 订单完成数量回写（[底稿 A6-5]：0005 无完成数量列，本块 0008 追加列的窄写端口；非负钳制）。 */
export interface OrderProgressWriteBack {
  addCompletedQty(orderId: string, delta: string, actor: string | null): Promise<string>
}

/**
 * masterdata 只读查询窄端口（0003 表；D-1 修复引入）：
 * [合同 A7-2/底稿 A7] 投料码准入「所在库位必须在线边库」的判定事实——
 * 库位 → 隶属仓库类型（warehouse.warehouse_type，MD-23 两值字典），线边=LINE_SIDE。
 */
export interface ExecutionMasterDataLookups {
  /** 库位隶属仓库类型；库位不存在返回 null。 */
  findWarehouseTypeByLocation(locationId: string): Promise<string | null>
}

export interface ExecutionRepositories {
  sessions: ExecutionSessionRepository
  reports: ProductionReportRepository
  outputs: ReportOutputRepository
  feeds: MaterialConsumptionRepository
  labor: LaborRecordRepository
  orderProgress: OrderProgressWriteBack
  masterdata: ExecutionMasterDataLookups
}

// ---------------- 排程读取端口（窄接口，排程并行块未落地） ----------------

/**
 * 排程查询端口：按设备+日期查排产工序（扫码报工上下文：工序默认=该设备当天排产工序）。
 * 排程并行块（T09 scheduling）未落地——组合根注入实现：测试给内存实现；
 * L0 整合时接真实排产查询。本端口不 import scheduling 任何文件（派发约束）。
 */
export interface ScheduledOperationView {
  orderId: string
  orderOperationId: string
  operationSeq: number
  operationDefinitionId: string
}

export interface ScheduleReadPort {
  listScheduledOperations(query: {
    plantId: string
    equipmentId: string
    /** 班次日期（yyyy-MM-dd，A4 白班起点口径）。 */
    date: string
  }): Promise<ScheduledOperationView[]>
}

// ---------------- 配置端口（[合同新造 + GAP C1/C2]，不编造现场值） ----------------

/**
 * execution 域配置注入：
 * - defaultOverrunRatio：超额系数默认值（GAP C1：配置位置/默认值/来源 PRD 未定义；
 *   null → 域规则保守默认 '1.0000' 不允许超产）；
 * - lastOperationAutoReviewDeptIds：「末道自动审核车间」（生产部门 id 清单，GAP C2；
 *   缺省空 = 末道一律待审核）；
 * - qcDeptIds：质检部门清单（0005 工序行无质检标志列；质检工序判定=生产部门属质检部门）；
 * - consumableMaterialTypes：可耗物料类型码清单（成品/原料不可消耗；null=不做类型校验，
 *   GAP：物料类型字典未冻结）；
 * - defaultOwnerId/defaultOwnerName：产出所有者缺省（receiveGoods 记账需要；产出行可显式覆盖）。
 *
 * 线边库判定（D-1 修复，原 lineSideLocationIds 已移除）：[合同 A7-2/底稿 A7] 校验的是
 * 单元所在库位隶属的仓库类型=LINE_SIDE（0003 warehouse.warehouse_type 主数据事实），
 * 不是硬编码库位 ID 清单成员；产出目标库位由载荷显式指定（线边库细分档案未落库，GAP 登记）。
 */
export interface ExecutionConfig {
  defaultOverrunRatio: string | null
  lastOperationAutoReviewDeptIds: string[]
  qcDeptIds: string[]
  consumableMaterialTypes: number[] | null
  defaultOwnerId: string | null
  defaultOwnerName: string | null
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  defaultOverrunRatio: null,
  lastOperationAutoReviewDeptIds: [],
  qcDeptIds: [],
  consumableMaterialTypes: null,
  defaultOwnerId: null,
  defaultOwnerName: null,
}

// ---------------- 命令工具集扩展 ----------------

/**
 * execution 命令工具集：org 基础 + 本域仓储 + 消费 inventory 记账服务与 process 订单仓储
 * （经端口，不 import scheduling）+ Outbox 收集 + 配置注入。
 */
export interface ExecutionCommandTools extends CommandTools {
  execution: ExecutionRepositories
  inv: InventoryRepositories
  process: ProcessRepositories
  outbox: OutboxCollector
  schedule: ScheduleReadPort
  config: ExecutionConfig
}
