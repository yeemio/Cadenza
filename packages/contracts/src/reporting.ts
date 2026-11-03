import type { DecimalString } from './decimal'
import type { PageResult } from './pagination'

/**
 * reporting 域公开线合同（P2-F / T20 全量业务查询、班次报表与核心指标——只读投影域）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p2/reporting.md（RP-01~RP-22、RP-S1~S4）：
 * - 查询接口只读；数量字段一律 DecimalString（IT-07 口径随行，禁 number）；
 * - 英尺数为展示列（RP-03）：非米单位返回 null（前端显示 `-`）；
 * - 班次快照缺失分母保留标记与原因（RP-21），不以 0 冒充；
 * - 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）。
 */

// ---------------- 库存统计（RP-01~RP-06） ----------------

/** 汇总口径两类码（RP-01）：采购收货码 / 其余码。 */
export type StockStatKindValue = 'purchase_receive' | 'production'

/** 成品入库状态（RP-04 推导；null=其余为空）。 */
export type FinishedEntryStatusValue = 'entered_warehouse' | 'not_entered' | null

/** 库存统计投影行视图（一行一条统计结果，列表不做二次聚合 RP-01）。 */
export interface StockStatRowDto {
  statId: string
  statKind: StockStatKindValue
  statKindLabel: string
  /** 华通轴号 */
  unitNo: string
  /** 入库批次号（采购收货码汇总键） */
  lotNo: string | null
  /** 厂家批次（采购收货码汇总键） */
  supplierLotNo: string | null
  /** 牌号/线径（料品编码） */
  materialCode: string
  materialName: string | null
  materialType: 1 | 2 | 3 | null
  color: string | null
  spec: string | null
  voltage: string | null
  standard: string | null
  /** 订单（其余码汇总键；可空） */
  orderNo: string | null
  /** 订单工序（有则） */
  operationSeq: number | null
  operationName: string | null
  /** 基本单位数量（汇总键下余额合计） */
  quantity: DecimalString
  uomCode: string
  /** 计量基准标注（RP-S1：数量列含 measurement_basis） */
  measurementBasis: string
  /** 英尺数展示列（RP-03）：米 → trunc4(数量÷0.3048)，非米 → null（显示 `-`） */
  feetQuantity: DecimalString | null
  /** 原库存状态字典 6 值（RP-02 legacy；GAP-A7 映射未裁，可空并存标注） */
  stockStatus: string | null
  stockStatusLabel: string | null
  /** 五状态轴（IT-13 权威口径，与 legacy 并存展示不混写） */
  axisStatus: string
  axisStatusLabel: string
  /** 报工仓库类型（成品入库状态推导输入） */
  reportWarehouseKind: 'WAREHOUSE' | 'LINE_SIDE' | null
  /** 成品入库状态（RP-04 推导；null=空） */
  finishedEntryStatus: FinishedEntryStatusValue
  finishedEntryStatusLabel: string | null
  /** 客户轴号集合（排序展示） */
  customerAxisNos: string[]
  warehouseCode: string | null
  warehouseName: string | null
  locationCode: string | null
  ownerName: string | null
  inboundDate: string | null
  outboundDate: string | null
  plantId: string
  createdAt: string
}

/** 勾选汇总（RP-05：服务端全量聚合，不依赖已加载分页）。 */
export interface SelectionSummaryDto {
  groups: Array<{
    uomCode: string | null
    /** 无单位记"未知单位"（RP-05） */
    uomLabel: string
    totalQuantity: DecimalString
  }>
  /** 总件数 = 勾选行数；未勾选时总量为 0 */
  totalRows: number
}

// ---------------- 轴查询（RP-08~RP-11） ----------------

export type AxisInboundStatusValue =
  | 'not_in'
  | 'in_stock'
  | 'shipped'
  | 'returned'
  | 'receipt_unconfirmed'
  | 'issue_unconfirmed'
export type AxisQcStatusValue = 'pending' | 'qualified' | 'exempt' | 'unqualified'
export type AxisSaleStatusValue = 'unsold' | 'sold'
export type AxisReportStatusValue = 'not_reported' | 'reported' | 'not_applicable'
export type AxisSuspectStatusValue = 'normal' | 'suspect'
export type AxisLockStatusValue = 'unlocked' | 'locked'
export type AxisFinishedAbnormalValue = 'none' | 'pending_handle'

/** 轴查询行视图（产品轴二维码主数据的只读跨域投影，无新增/修改/删除/详情入口 RP-08）。 */
export interface AxisQueryRowDto {
  unitId: string
  /** 产品轴号 */
  unitNo: string
  inboundStatus: AxisInboundStatusValue
  inboundStatusLabel: string
  materialCode: string
  materialName: string | null
  materialType: 1 | 2 | 3 | null
  spec: string | null
  color: string | null
  lotNo: string | null
  quantity: DecimalString | null
  uomCode: string | null
  warehouseName: string | null
  locationCode: string | null
  /** 托码（当前活动载具绑定） */
  carrierCode: string | null
  qcRequired: boolean
  suspectStatus: AxisSuspectStatusValue
  suspectStatusLabel: string
  finishedAbnormalStatus: AxisFinishedAbnormalValue
  finishedAbnormalStatusLabel: string
  qcStatus: AxisQcStatusValue
  qcStatusLabel: string
  lockStatus: AxisLockStatusValue
  lockStatusLabel: string
  saleStatus: AxisSaleStatusValue
  saleStatusLabel: string
  inboundDate: string | null
  inboundUser: string | null
  salesOrderNo: string | null
  salesLineNo: string | null
  orderNo: string | null
  /** 报工人员 */
  reportedBy: string | null
  /** 客户轴号 */
  customerAxisNo: string | null
  /** 段长 */
  segmentLength: DecimalString | null
  /** 虚拟轴号（P1 无权威列，通道待 Owner 圈定——返回 null 不冒充） */
  virtualAxisNo: string | null
  reportStatus: AxisReportStatusValue
  reportStatusLabel: string
  reportedAt: string | null
  /** 车间（报工订单工序生产部门） */
  workshopName: string | null
  plantId: string
  createdAt: string
}

// ---------------- 报工记录汇总（RP-12~RP-17） ----------------

/** 口径分层（RP-16：草稿/提交/审核/合格/入库各自有口径，逐口径展示不混成一个完成量）。 */
export type ReportCaliberValue = 'draft' | 'submitted' | 'approved' | 'qualified' | 'stocked'

/** 单口径汇总（按生产单位分组，RP-12/RP-14：不同单位不得直接汇总）。 */
export interface ReportCaliberTotalsDto {
  caliber: ReportCaliberValue
  caliberLabel: string
  groups: Array<{ uomCode: string; totalQuantity: DecimalString }>
  axisCount: number
}

/** Web 汇总行（RP-12：勾选行报工总量按单位 + 报工总轴数）。 */
export interface ReportSelectionSummaryDto extends ReportCaliberTotalsDto {
  /** 英尺汇总列（米组展示，RP-03 随行）：仅 uomCode='M' 的组提供 */
  feetGroups: Array<{ uomCode: string; feetQuantity: DecimalString }> | null
}

/** PDA 累计报工（RP-13：口径分开统计、排除历史导入、精准订单身份）。 */
export interface PdaCumulativeDto {
  caliber: 'draft' | 'submitted' | 'approved'
  caliberLabel: string
  groups: Array<{ uomCode: string; totalQuantity: DecimalString }>
  /** 排除的历史导入行数（P1 无导入通道，结构性为 0；通道引入后实数） */
  excludedHistoricalRows: number
}

// ---------------- 指标定义与班次快照（RP-18~RP-22） ----------------

export type MetricFamilyValue = 'wip' | 'delivery' | 'yield' | 'loss'
export type MetricDefStatusValue = 'draft' | 'active' | 'retired'
export type SnapshotStatusValue = 'ok' | 'denominator_missing' | 'projection_failed'

/** 指标定义版本行（RP-19：分子/分母事实集、单位、口径版本、生效区间；referenced 行 immutable）。 */
export interface MetricDefinitionDto {
  id: string
  metricKey: string
  family: MetricFamilyValue
  familyLabel: string
  version: number
  caliberVersion: string
  numeratorFactSet: { kind: string }
  denominatorFactSet: { kind: string } | null
  uomCode: string
  uomMode: 'plain' | 'percent'
  effectiveFrom: string
  effectiveTo: string | null
  status: MetricDefStatusValue
  /** 已被快照引用（immutable，RP-S3） */
  referenced: boolean
  description: string | null
  createdAt: string
}

/** 班次快照行（RP-S2 幂等键：工厂+班次日期+指标+指标版本）。 */
export interface ShiftSnapshotDto {
  id: string
  plantId: string
  shiftDate: string
  metricKey: string
  metricVersion: number
  caliberVersion: string
  numeratorValue: DecimalString | null
  denominatorValue: DecimalString | null
  value: DecimalString | null
  uomCode: string
  status: SnapshotStatusValue
  /** 缺失/失败原因（RP-21 保留读回） */
  missingReason: string | null
  /** 参与聚合的事实行数（RP-22 逐笔对账锚点） */
  sourceRows: number
  computedAt: string
  computedBy: string
}

// ---------------- 追溯查询（RP-22 / IT-35） ----------------

export type TraceDirectionValue = 'forward' | 'backward'

/** 追溯节点（原料→交付轴 / 交付轴→原料；附工序/设备/人员/检验引用）。 */
export interface TraceNodeDto {
  nodeId: string
  nodeType: 'material_lot' | 'inventory_unit' | 'material_segment' | 'customer_segment'
  unitNo: string | null
  materialCode: string | null
  status: string | null
  depth: number
  /** 工序引用（产出该单元的报工工序名） */
  operationName: string | null
  /** 设备引用（产出报工设备码） */
  equipmentCode: string | null
  /** 人员引用（产出报工操作员/投料操作员） */
  operatorLogin: string | null
  /** 检验引用（该单元质量隔离记录数） */
  holdCount: number
}

export interface TraceEdgeDto {
  fromNodeId: string
  toNodeId: string
  edgeKind: 'receipt_origin' | 'consumption' | 'production_output' | 'customer_binding'
  quantity: DecimalString
  uomCode: string
  businessTime: string
}

export interface TraceResultDto {
  direction: TraceDirectionValue
  root: { nodeId: string; nodeType: string; unitNo: string | null }
  nodes: TraceNodeDto[]
  edges: TraceEdgeDto[]
}

// ---------------- 命令载荷（投影维护：只写本域投影表，不触碰业务表 RP-07/RP-18） ----------------

/** reporting.stock-stat.rebuild：库存统计投影全量重建（RP-07/S1：可由事件源全量重建、幂等）。 */
export interface StockStatRebuildCommandPayload {
  plantId?: string
}

/** reporting.shift-snapshot.rebuild：班次快照重算（RP-18/S2：幂等键覆盖、重算不重执行业务）。 */
export interface ShiftSnapshotRebuildCommandPayload {
  plantId: string
  /** 重算班次日（缺省=重算该厂全部既有事实班次日） */
  shiftDate?: string
  /** 重算指标键（缺省=全部 active 指标） */
  metricKeys?: string[]
}

/** reporting.metric-definition.register：注册指标定义新版本（RP-19/S3）。 */
export interface MetricDefinitionRegisterCommandPayload {
  metricKey: string
  family: MetricFamilyValue
  version: number
  caliberVersion: string
  numeratorFactSet: { kind: string }
  denominatorFactSet: { kind: string } | null
  uomCode: string
  uomMode: 'plain' | 'percent'
  effectiveFrom: string
  effectiveTo?: string | null
  status?: MetricDefStatusValue
  description?: string
}

/** 命令返回视图（分页容器复用 PageResult）。 */
export type StockStatPage = PageResult<StockStatRowDto>
export type AxisQueryPage = PageResult<AxisQueryRowDto>
export type ShiftSnapshotPage = PageResult<ShiftSnapshotDto>
