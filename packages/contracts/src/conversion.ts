import type { DecimalString } from './decimal'
import type { PageResult } from './pagination'

/**
 * conversionform 域公开线合同（P2-B / T16 两种形态转换——订单式 FC-05～12 与
 * 库存式 FC-13～21，冻结合同 architecture/contracts/frozen/p2/form-conversion.md）。
 * - 数量/段长字段一律 DecimalString（IT-07 口径随行：十进制定点、≤4 位小数，禁 number）；
 * - 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）；
 * - 两协议单据/命令/查询面分立（FC-01），不共享载荷形状。
 */

// ---------------- 协议A（订单形态转换）状态字典 ----------------

/** FC-12：转换状态 2 值（待转换/已完成），与同步状态分列。 */
export type OrderConversionStatusValue = 'pending' | 'completed'

/** FC-12：同步状态 3 值（未同步/同步失败/已同步）。 */
export type OrderSyncStatusValue = 'pending' | 'sync_failed' | 'synced'

// ---------------- 协议B（库存形态转换）状态字典 ----------------

/** FC-14：内部六态（DM §7.2）。 */
export type StockInternalStatusValue =
  | 'pending_execute'
  | 'external_processing'
  | 'local_processing'
  | 'completed'
  | 'pending_recovery'
  | 'manual_processing'

/** FC-14：对外三态投影（原文 02:29-35）。 */
export type StockDisplayStatusValue = 'convert_failed' | 'sync_failed' | 'convert_success'

/** FC-02：外部接口成功状态（与业务单据状态、库存投影状态分列存储）。 */
export type StockExternalPushStatusValue = 'pending' | 'unknown' | 'succeeded' | 'failed'

/** FC-02：库存投影状态（本地 MES 改码＋库存统计应用态）。 */
export type StockLocalApplyStatusValue = 'not_applied' | 'applied' | 'failed'

/** FC-03：外部结果回填三态（模拟适配器/外部流水查询结果）。 */
export type ExternalOutcomeValue = 'success' | 'failure' | 'unknown'

// ---------------- 协议A 查询侧 DTO ----------------

/** 订单转换明细视图（FC-05：转换前后订单锚点 + 实扫数量/已扫轴数）。 */
export interface OrderConversionLineDto {
  lineId: string
  lineNo: number
  sourceOrderId: string
  sourceSalesOrderNo: string
  sourceLineNo: string
  sourceProjectNo: string | null
  targetOrderId: string
  targetSalesOrderNo: string
  targetProjectNo: string
  materialId: string
  materialCode: string
  plannedQty: DecimalString
  scannedQty: DecimalString
  scannedAxes: number
  uom: string
}

/** 订单转换扫码视图（FC-07：码+选择项+锁定引用+删码标记留痕）。 */
export interface OrderConversionScanDto {
  scanId: string
  lineId: string
  unitNo: string
  inventoryUnitId: string
  segmentLength: DecimalString | null
  customerAxisNo: string | null
  quantity: DecimalString
  reservationId: string
  scannedBy: string
  scannedAt: string
  deleted: boolean
  deletedBy: string | null
  deletedAt: string | null
}

/** FC-08：二维码归属变更视图（完成后归属改为转换后订单）。 */
export interface CodeAssignmentDto {
  unitNo: string
  inventoryUnitId: string
  fromOrderId: string
  toOrderId: string
  assignedBy: string
  assignedAt: string
}

/** 订单转换单视图（FC-12：转换状态与同步状态两列独立投影）。 */
export interface OrderConversionDto {
  conversionId: string
  conversionNo: string
  status: OrderConversionStatusValue
  statusLabel: string
  syncStatus: OrderSyncStatusValue
  syncStatusLabel: string
  completedBy: string | null
  completedAt: string | null
  lineCount: number
  plantId: string
  createdAt: string
  createdBy: string | null
}

export type OrderConversionPage = PageResult<OrderConversionDto>

// ---------------- 协议B 查询侧 DTO ----------------

/** 库存转换明细视图（FC-21：一轴一行只读；原批次/项目等来源快照列）。 */
export interface StockConversionLineDto {
  lineId: string
  unitNo: string
  inventoryUnitId: string
  palletCode: string | null
  quantity: DecimalString
  uom: string
  segmentLength: DecimalString
  customerAxisNo: string | null
  materialId: string
  materialCode: string
  sourceProjectNo: string | null
  sourceSalesOrderNo: string | null
  sourceLineNo: string | null
  sourceBatchNo: string | null
  warehouseCode: string | null
  locationCode: string | null
}

/** 库存转换单视图（FC-02/14：内部六态/对外三态/外部/本地四列分立 + FC-21 聚合列）。 */
export interface StockConversionDto {
  conversionId: string
  conversionNo: string
  internalStatus: StockInternalStatusValue
  internalStatusLabel: string
  displayStatus: StockDisplayStatusValue
  displayStatusLabel: string
  externalPushStatus: StockExternalPushStatusValue
  localApplyStatus: StockLocalApplyStatusValue
  u9Success: boolean
  materialId: string
  materialCode: string
  materialName: string | null
  targetProjectNo: string | null
  targetSalesOrderNo: string
  targetLineNo: string
  targetBatchNo: string
  /** FC-21：转换数量 = 全部明细数量之和。 */
  totalQty: DecimalString
  /** FC-21：转换轴数 = 明细行数（一轴一行）。 */
  axisCount: number
  externalDocNo: string | null
  externalFailureReason: string | null
  completedAt: string | null
  plantId: string
  createdAt: string
  createdBy: string | null
}

export type StockConversionPage = PageResult<StockConversionDto>

/** FC-16：MES 改码记录视图。 */
export interface CodeRewriteDto {
  unitNo: string
  oldSalesOrderNo: string | null
  oldLineNo: string | null
  oldBatchNo: string | null
  oldVirtualAxisNo: string | null
  newSalesOrderNo: string
  newLineNo: string
  newBatchNo: string
  newSegmentLength: DecimalString
  newCustomerAxisNo: string | null
  virtualAxisCleared: boolean
  appliedBy: string
  appliedAt: string
}

/** FC-17：库存候选源视图（左侧库存：无托按单轴一行、有托按托汇总一行）。 */
export interface StockCandidateDto {
  /** 分组键：单轴=unitNo；按托=托码（产品轴号显示 `-` → productAxisNo=null）。 */
  groupKind: 'axis' | 'pallet'
  productAxisNo: string | null
  palletCode: string | null
  quantity: DecimalString
  uom: string
  axisCount: number
  materialId: string
  materialCode: string
  customerAxisNo: string | null
  salesOrderNo: string | null
  lineNo: string | null
  batchNo: string | null
  warehouseCode: string | null
  locationCode: string | null
}

// ---------------- 命令载荷（命令总线 payload 形状，均为新增端点专用） ----------------

/** conversion.order.create / conversion.order.update 明细行载荷。 */
export interface OrderConversionLinePayload {
  sourceOrderId: string
  sourceSalesOrderNo?: string
  sourceLineNo?: string
  sourceProjectNo?: string | null
  targetOrderId: string
  targetProjectNo: string
  quantity: DecimalString
  uom?: string
}

/** conversion.stock.create / conversion.stock.reconvert 明细行载荷（右侧转换清单）。 */
export interface StockConversionLinePayload {
  unitNo: string
  segmentLength: DecimalString
  customerAxisNo?: string | null
  palletCode?: string | null
  quantity?: DecimalString
  uom?: string
  sourceProjectNo?: string | null
  sourceSalesOrderNo?: string | null
  sourceLineNo?: string | null
  sourceBatchNo?: string | null
  sourceVirtualAxisNo?: string | null
  warehouseId?: string | null
  warehouseCode?: string | null
  locationId?: string | null
  locationCode?: string | null
}
