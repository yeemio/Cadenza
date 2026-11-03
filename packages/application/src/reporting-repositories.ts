import type {
  AxisQueryRowDto,
  MetricDefinitionDto,
  ShiftSnapshotDto,
  StockStatRowDto,
  TraceResultDto,
} from '@cadenza/contracts'
import type { CommandTools } from './command-bus'
import type { FactSetKey } from '@cadenza/domain'

/**
 * reporting 域端口与记录类型（P2-F / T20 只读投影域）。
 *
 * 读侧：库存统计投影表（0016）、轴查询（跨表实时投影，RP-11 权威表当前值）、
 * 报工汇总（0008 production_report/report_output 口径过滤）、班次快照、追溯（genealogy_edge）。
 * 维护侧：投影重建数据源（既有域业务事实的只读查询，跨包读取经
 * persistence 实现承载——本文件只声明端口，不含 SQL）。
 */

// ---------------- 库存统计投影 ----------------

/** 投影重建输入行（persistence collectStockStatSource 从既有域表只读聚合产出）。 */
export interface StockStatSourceRow {
  statKind: 'purchase_receive' | 'production'
  unitNo: string
  lotNo: string | null
  supplierLotNo: string | null
  materialId: string | null
  materialCode: string
  materialName: string | null
  materialType: 1 | 2 | 3 | null
  color: string | null
  spec: string | null
  voltage: string | null
  standard: string | null
  orderNo: string | null
  operationSeq: number | null
  operationName: string | null
  quantity: string
  uomId: string | null
  uomCode: string
  measurementBasis: string
  stockStatus: string | null
  axisStatus: string
  reportWarehouseKind: 'WAREHOUSE' | 'LINE_SIDE' | null
  customerAxisNos: string[]
  warehouseCode: string | null
  warehouseName: string | null
  locationCode: string | null
  ownerName: string | null
  inboundDate: string | null
  outboundDate: string | null
  plantId: string
  enterpriseId: string
}

export interface StockStatFilter {
  plantIds: string[] | null
  plantId?: string
  unitNoLike?: string
  customerAxisLike?: string
  stockStatus?: string
  /** RP-04 后半：筛选时同时限定库存状态=正常并按报工仓库类型匹配 */
  finishedEntryStatus?: 'entered_warehouse' | 'not_entered'
  page: number
  pageSize: number
}

export interface StockStatProjectionRepository {
  /** 全量重建（RP-07/S1）：同事务 DELETE（范围）+ INSERT；幂等=同事实集产出同结果。 */
  replaceAll(rows: readonly StockStatSourceRow[], options: { plantId?: string; actor: string }): Promise<number>
  listPaged(filter: StockStatFilter): Promise<{ items: StockStatRowDto[]; total: number }>
  /** RP-05：按 id 集合取全量行（服务端聚合，不依赖已加载分页）。 */
  listByIds(ids: readonly string[]): Promise<StockStatRowDto[]>
}

/** 投影重建数据源（既有域业务事实只读查询；测试/集成用）。 */
export interface StockStatSourceRepository {
  collectStockStatSource(plantId?: string): Promise<StockStatSourceRow[]>
}

// ---------------- 轴查询（实时跨域投影，RP-08~RP-11） ----------------

export interface AxisQueryFilter {
  plantIds: string[] | null
  plantId?: string
  unitNoLike?: string
  warehouseName?: string
  carrierLike?: string
  inboundStatus?: string
  qcStatus?: string
  saleStatus?: string
  salesOrderNoLike?: string
  orderNoLike?: string
  reporterLike?: string
  customerAxisLike?: string
  reportStatus?: string
  reportedFrom?: string
  reportedTo?: string
  workshopName?: string
  page: number
  pageSize: number
}

export interface AxisQueryRepository {
  listPaged(filter: AxisQueryFilter): Promise<{ items: AxisQueryRowDto[]; total: number }>
}

// ---------------- 报工汇总（RP-12~RP-17） ----------------

export interface ReportSummaryFilter {
  plantIds: string[] | null
  plantId?: string
  orderNoLike?: string
  dateFrom?: string
  dateTo?: string
  /** 勾选报工单 id（RP-12 汇总行按勾选；空数组=未勾选） */
  reportIds?: readonly string[] | null
}

/** 报工产出行原始记录（查询服务在应用层做口径过滤与分组——domain 纯规则消费点）。 */
export interface ReportOutputRow {
  reportId: string
  status: 'draft' | 'submitted' | 'deleted'
  reviewStatus: 'pending_review' | 'auto_approved' | 'manual_approved'
  stockUnitBound: boolean
  /** 生产单位（K08：单位从业务对象读取） */
  uomCode: string
  quantity: string
  qualifiedQty: string | null
  /** 产品轴号（库存单元号；无库存单元产出行为空） */
  unitNo: string | null
  /** 历史导入标记位（P1 无导入通道，恒 false；通道引入后实数——RP-13 排除） */
  historicalImport: boolean
  orderNo: string | null
  shiftDate: string
}

export interface ReportSummaryRepository {
  /** 报工产出行全量读取（RP-17：服务端聚合，不依赖已加载分页；过滤在 SQL 侧做范围）。 */
  listOutputRows(filter: ReportSummaryFilter): Promise<ReportOutputRow[]>
  /** PDA 累计行（RP-13：部门含下级 path 前缀、操作工只算自己参与）。 */
  listPdaRows(filter: {
    plantIds: string[] | null
    plantId?: string
    /** 部门子树 path 前缀（含下级；null=不限部门） */
    deptPathPrefix?: string | null
    operatorUserId?: string | null
  }): Promise<ReportOutputRow[]>
}

// ---------------- 指标定义与班次快照（RP-18~RP-21） ----------------

export interface NewMetricDefinition {
  metricKey: string
  family: 'wip' | 'delivery' | 'yield' | 'loss'
  version: number
  caliberVersion: string
  numeratorFactSet: { kind: string }
  denominatorFactSet: { kind: string } | null
  uomCode: string
  uomMode: 'plain' | 'percent'
  effectiveFrom: string
  effectiveTo: string | null
  status: 'draft' | 'active' | 'retired'
  description: string | null
  plantId: string | null
  enterpriseId: string | null
  createdBy: string
}

export interface MetricDefinitionRepository {
  insert(def: NewMetricDefinition): Promise<MetricDefinitionDto>
  findByKeyAndVersion(metricKey: string, version: number): Promise<MetricDefinitionDto | null>
  listAll(): Promise<MetricDefinitionDto[]>
  /** RP-S3：referenced 单向闩锁置位（快照引用后 immutable）。 */
  markReferenced(id: string): Promise<void>
}

export interface ShiftSnapshotUpsert {
  plantId: string
  enterpriseId: string
  shiftDate: string
  metricKey: string
  metricVersion: number
  caliberVersion: string
  numeratorValue: string | null
  denominatorValue: string | null
  value: string | null
  uomCode: string
  status: 'ok' | 'denominator_missing' | 'projection_failed'
  missingReason: string | null
  sourceRows: number
  computedBy: string
  commandReceiptId: string | null
}

export interface ShiftSnapshotFilter {
  plantIds: string[] | null
  plantId?: string
  shiftDateFrom?: string
  shiftDateTo?: string
  metricKeys?: string[]
  statuses?: string[]
  page: number
  pageSize: number
}

export interface ShiftSnapshotRepository {
  /** RP-S2：幂等键 ON CONFLICT 覆盖（重算不产生重复行）。 */
  upsertBatch(rows: readonly ShiftSnapshotUpsert[]): Promise<ShiftSnapshotDto[]>
  listPaged(filter: ShiftSnapshotFilter): Promise<{ items: ShiftSnapshotDto[]; total: number }>
}

/** 事实集聚合结果（引擎按定义调用，逐 (工厂, 班次日) 计算）。 */
export interface FactSetResult {
  /** 聚合值（DecimalString；计数事实集为整数串） */
  value: string
  /** 参与聚合的事实行数（RP-22 对账锚点） */
  rows: number
}

/** 事实集计算端口（persistence SQL 聚合实现；声明单位过滤——非声明单位的行不冒充入值）。 */
export interface SnapshotFactCalculator {
  calculate(
    kind: FactSetKey,
    args: { plantId: string; shiftDate: string; uomCode: string },
  ): Promise<FactSetResult>
  /** 该厂既有事实班次日集合（缺省全量重算用；来源=报工/投料/流水的 shift_date 并集）。 */
  listShiftDates(plantId: string): Promise<string[]>
}

// ---------------- 追溯（RP-22 / IT-35） ----------------

export interface TraceRepository {
  /**
   * 正反向追溯（原料→交付轴 / 交付轴→原料），含工序/设备/人员/检验引用；maxDepth 防失控。
   * 根单元按 plantIds（null=企业全范围）+enterpriseId 过滤；unitId/unitNo 二选一。
   */
  trace(args: {
    unitId?: string
    unitNo?: string
    direction: 'forward' | 'backward'
    plantIds: string[] | null
    enterpriseId: string
    maxDepth?: number
  }): Promise<TraceResultDto | null>
}

// ---------------- 导出审计（RP-S4） ----------------

export interface ExportAuditWriter {
  /** 导出与查询共用同一范围校验路径后记审计行（0001 audit_entry）。 */
  recordExport(entry: {
    actor: string
    reportKind: string
    filterDigest: string
    rowCount: number
    plantId?: string | null
  }): Promise<void>
}

// ---------------- 命令工具集 ----------------

/** reporting 维护命令工具集（org 基础 + 本域仓储束；命令只写投影表，不触碰业务表）。 */
export interface ReportingCommandTools extends CommandTools {
  reporting: {
    projections: StockStatProjectionRepository
    sources: StockStatSourceRepository
    definitions: MetricDefinitionRepository
    snapshots: ShiftSnapshotRepository
    facts: SnapshotFactCalculator
  }
}
