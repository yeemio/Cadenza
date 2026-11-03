import type { PageRequest, PageResult } from '@cadenza/contracts'

/**
 * P2 域 API 客户端层类型（P2-UI 线，2026-10-28）。
 *
 * 依据六域冻结合同（architecture/contracts/frozen/p2/）定义 API 路由形状 / DTO 字段 /
 * 错误码（全中文 [编号-x]）。P2 六条后端线（P2-A～F）并行实施中、控制器未注册，
 * 本层按合同形状先行构建；与后端实际实现的差异记入交付记录"对账清单"，L0 整合时统一核对。
 *
 * 字段名对齐口径：
 * - T16 form-conversion / T17 warehouse-reverse / T20 reporting：后端线已落地
 *   packages/contracts/src/{conversion,reverse,reporting}.ts（独立新文件、未并入 index.ts），
 *   本文件这三域的 DTO 字段名与其逐一对齐（不直接 import，防并行线在途改动）；
 * - T15 rework-split / T18 quality-disposition / T19 maintenance：后端 contracts 未落地，
 *   按冻结合同形状定义（对账清单登记）。
 * 数量字段沿用十进制字符串口径（IT-07，DecimalString 同义；与 P1 client 一致）。
 */
export type { PageRequest, PageResult }

// ====================================================================
// T15 rework-split（倒轴 / 分托 / 轴号修正 / 轴码退役）
// ====================================================================

/** 倒轴主表（RS-08：主表＋明细展开只读，无新增/编辑/删除入口） */
export interface ReelSplitOrderDto {
  id: string
  /** 倒轴单号（RS-S1 append-only；纠正＝冲销记录关联原单） */
  splitNo: string
  /** 倒出轴（产品轴码） */
  sourceUnitNo: string
  materialCode: string
  materialName: string
  /** 关联生产订单（RS-08 主表字段） */
  productionOrderNo: string
  /** 原数量（守恒式基数，RS-01） */
  originalQuantity: string
  uom: string
  /** 全部倒入合计 */
  splitTotal: string
  /** 本次已登记损耗量（RS-11；默认 0） */
  lossQuantity: string
  /** 倒出轴剩余数量 = 原数量 − 该主单全部倒入合计（同主单多行数值相同，RS-08） */
  remainingQuantity: string
  operatorName: string
  operatedAt: string
  /** completed=已完成；reversed=已冲销（RS-12） */
  status: 'completed' | 'reversed'
}

export interface ReelSplitLineDto {
  id: string
  targetUnitNo: string
  quantity: string
  uom: string
}

export interface ReelSplitDetailDto extends ReelSplitOrderDto {
  lines: ReelSplitLineDto[]
  lossReason?: string
}

/**
 * 倒出轴扫码视图（PDA，RS-03 前置拒绝链：托码/不存在/锁定/质检未完成/报工未审核/
 * 异常未处理/已入物流部仓库/一码多物；载具码第 2 位 E/F/M/P）。
 */
export interface ReelSplitSourceScanDto {
  unitNo: string
  materialCode: string
  materialName: string
  quantity: string
  uom: string
  /** 带客户轴号或段长时必须全量倒出且倒入仅一条（RS-05 前端提示，服务端终校） */
  hasCustomerAxisNo: boolean
  hasSegmentLength: boolean
  productionOrderNo: string | null
}

/** 倒轴执行（PDA，RS-01/02/06/07：会话模型、提交事务内统一校验守恒式） */
export interface ReelSplitExecutePayload {
  sourceUnitNo: string
  lines: Array<{ targetUnitNo: string; quantity: string }>
  /** 损耗量（默认 0、4 位小数、≥0；>0 时 lossReason 必填，RS-11） */
  lossQuantity?: string
  lossReason?: string
}

/** 倒轴冲销（RS-12 [合同新造]：纠正走反向流水；下游引用时拒绝） */
export interface ReelSplitReversePayload {
  reason: string
}

/** 分托/解绑任务类型（RS-13/14：分托=改绑托码；解绑=清除托码） */
export type PalletTaskType = 'pallet_split' | 'pallet_unbind'

/** 分托任务单据（RS-14：同一人同一类型仅一条进行中；Web 只展示已完成） */
export interface PalletTaskDto {
  id: string
  taskType: PalletTaskType
  /** in_progress 不在 Web 台账展示（RS-14） */
  status: 'in_progress' | 'completed'
  /** 分入托码（解绑为空） */
  targetPalletCode: string | null
  warehouseName: string | null
  /** 组托人员/组托时间 = 本次操作人/首次扫码时间（RS-20） */
  operatorName: string
  firstScanAt: string
  completedAt: string | null
  itemCount: number
}

/** 分托明细行（RS-17：扫码时点快照——原托码/仓库/货架/库位为扫入快照） */
export interface PalletTaskItemDto {
  id: string
  unitNo: string
  materialCode: string
  materialName: string
  quantity: string
  uom: string
  snapshotPalletCode: string | null
  snapshotWarehouseName: string | null
  snapshotRackCode: string | null
  snapshotLocationCode: string | null
}

export interface PalletTaskDetailDto extends PalletTaskDto {
  items: PalletTaskItemDto[]
}

/** PDA 扫码结果（RS-16/22 拒绝清单命中时以 [RS-xx] 错误返回，不追加） */
export interface PalletScanResultDto {
  task: PalletTaskDto
  scannedCount: number
  scanned: {
    unitNo: string
    materialCode: string
    materialName: string
    quantity: string
    uom: string
    warehouseName: string | null
    locationCode: string | null
  }
}

/** PDA 分托/解绑扫码载荷（首次扫码生成进行中记录，RS-14） */
export interface PalletScanPayload {
  taskType: PalletTaskType
  /** 分托须传分入托码；解绑不需要（RS-19/22） */
  targetPalletCode?: string
  /** 非车间人员新托须选库位（RS-15/19：服务端按登录人部门类别分叉，RS-13） */
  locationCode?: string
  code: string
}

/** 轴号修正记录（RS-29/32：状态列＋修正目标码＋前后值快照） */
export interface AxisCorrectionDto {
  id: string
  unitNo: string
  originalCustomerAxisNo: string | null
  newCustomerAxisNo: string | null
  originalSegmentLength: string | null
  newSegmentLength: string | null
  originalVirtualAxisNo: string | null
  newVirtualAxisNo: string | null
  originalQuantity: string
  cutQuantity: string
  newQuantity: string
  /** 截取数量单位随物料主计量单位（RS-31，不固定"米"） */
  uom: string
  status: 'completed' | 'withdrawn'
  correctedBy: string
  correctedAt: string
  withdrawnBy?: string
  withdrawnAt?: string
}

/** 轴号修正扫码视图（RS-25 前置拒绝链 + RS-26 可选新轴号范围） */
export interface AxisCorrectionScanDto {
  unitNo: string
  materialCode: string
  materialName: string
  quantity: string
  uom: string
  customerAxisNo: string | null
  segmentLength: string | null
  maxSingleReportQuantity: string
  options: AxisCorrectionOptionDto[]
}

export interface AxisCorrectionOptionDto {
  customerAxisNo: string | null
  segmentLength: string | null
  virtualAxisNo: string | null
  /** 同订单范围内已有码占用相同"段长＋虚拟轴号"（RS-26） */
  used: boolean
  usedByUnitNo?: string
}

/** 轴号修正提交（RS-27 提交校验链；RS-30 占用核权须 confirm+reason） */
export interface AxisCorrectionPayload {
  unitNo: string
  newCustomerAxisNo?: string
  newSegmentLength?: string
  newVirtualAxisNo?: string
  cutQuantity: string
  /** 选中"已使用"轴号时必填 true＋reason（RS-30 客户轴段重新分配权限） */
  occupyConfirmed?: boolean
  reason?: string
}

/** 轴码退役记录（RS-35：清空记录快照字段集；逻辑退役不物理删行） */
export interface AxisRetireRecordDto {
  id: string
  unitNo: string
  quantityBefore: string
  uom: string
  productionDeptName: string
  productionOrderNo: string
  salesOrderNo: string
  lineNo: string
  materialCode: string
  materialName: string
  processName: string
  reportedBy: string
  reportedAt: string
  operatedBy: string
  operatedAt: string
}

/** 轴码退役扫码视图（RS-34 可执行前置） */
export interface AxisRetireScanDto {
  unitNo: string
  materialCode: string
  materialName: string
  quantity: string
  uom: string
  qualityCompleted: boolean
  reportReviewed: boolean
  /** 未入成品仓在库才可清空 */
  inFinishedWarehouse: boolean
}

/** 轴码退役执行（RS-35：至少勾选一条；写清空记录快照，事务内完成 RS-37） */
export interface AxisRetirePayload {
  unitNo: string
  reason?: string
}

// ====================================================================
// T16 form-conversion（订单 / 库存两种形态转换）
// 字段名对齐已落地 packages/contracts/src/conversion.ts（P2-B 线）
// ====================================================================

/** FC-12：转换状态 2 值（待转换/已完成），与同步状态分列。 */
export type OrderConversionStatusValue = 'pending' | 'completed'

/** FC-12：同步状态 3 值（未同步/同步失败/已同步）。 */
export type OrderSyncStatusValue = 'pending' | 'sync_failed' | 'synced'

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
  plannedQty: string
  scannedQty: string
  scannedAxes: number
  uom: string
}

/** 订单转换扫码视图（FC-07：码+锁定引用+删码标记留痕）。 */
export interface OrderConversionScanDto {
  scanId: string
  lineId: string
  unitNo: string
  inventoryUnitId: string
  segmentLength: string | null
  customerAxisNo: string | null
  quantity: string
  reservationId: string
  scannedBy: string
  scannedAt: string
  deleted: boolean
  deletedBy: string | null
  deletedAt: string | null
}

/** 订单转换单视图（FC-12：转换状态与同步状态两列独立投影）。 */
export interface OrderConversionDto {
  conversionId: string
  conversionNo: string
  status: OrderConversionStatusValue
  syncStatus: OrderSyncStatusValue
  /** 仅"待转换且尚无任何扫码"可编辑/删除（FC-06，前端按钮显隐；服务端终校） */
  editable: boolean
  /** 仅"已完成且同步失败"可重试（FC-09） */
  retryable: boolean
  /** 完成转换可执行 = 待转换且每条明细已扫轴数 > 0（FC-08） */
  completable: boolean
  completedBy: string | null
  completedAt: string | null
  lineCount: number
  plantId: string
  createdAt: string
  createdBy: string | null
}

export interface OrderConversionDetailDto extends OrderConversionDto {
  lines: OrderConversionLineDto[]
  scans: OrderConversionScanDto[]
}

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
  newSegmentLength: string
  newCustomerAxisNo: string | null
  /** 清空虚拟轴号、不改项目号（FC-16） */
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
  quantity: string
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
  /** 已添加到右侧的行左侧置灰不可再选（FC-17） */
  alreadyAdded: boolean
}

/** 库存转换明细视图（FC-21：一轴一行只读；来源快照列）。 */
export interface StockConversionLineDto {
  lineId: string
  unitNo: string
  inventoryUnitId: string
  palletCode: string | null
  quantity: string
  uom: string
  segmentLength: string
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

/** 库存转换单视图（FC-02/14：四列状态分立 + FC-21 聚合列）。 */
export interface StockConversionDto {
  conversionId: string
  conversionNo: string
  internalStatus: StockInternalStatusValue
  displayStatus: StockDisplayStatusValue
  /** FC-02：外部接口成功状态（与业务单据、库存投影分列）。 */
  externalPushStatus: 'pending' | 'unknown' | 'succeeded' | 'failed'
  /** FC-02：库存投影状态（本地 MES 改码＋库存统计应用态）。 */
  localApplyStatus: 'not_applied' | 'applied' | 'failed'
  /** U9 已成功步骤幂等标记（FC-S4：重新同步不再推 U9，FC-15） */
  u9Success: boolean
  materialId: string
  materialCode: string
  materialName: string | null
  targetProjectNo: string | null
  targetSalesOrderNo: string
  targetLineNo: string
  targetBatchNo: string
  /** FC-21：转换数量 = 全部明细数量之和。 */
  totalQty: string
  /** FC-21：转换轴数 = 明细行数（一轴一行）。 */
  axisCount: number
  externalDocNo: string | null
  externalFailureReason: string | null
  /** 重新转换可执行 = 转换失败（FC-15）；重新同步可执行 = 同步失败且 U9 已成功 */
  reconvertable: boolean
  resyncable: boolean
  completedAt: string | null
  plantId: string
  createdAt: string
  createdBy: string | null
}

export interface StockConversionDetailDto extends StockConversionDto {
  lines: StockConversionLineDto[]
}

/** 订单转换建单/编辑明细行载荷（FC-05）。 */
export interface OrderConversionLinePayload {
  sourceOrderId: string
  sourceSalesOrderNo?: string
  sourceLineNo?: string
  sourceProjectNo?: string | null
  targetOrderId: string
  targetProjectNo?: string
  quantity: string
  uom?: string
}

/** 订单转换建单载荷（FC-05：明细仅生产订单行；同料品非同单；"销售单号+行号"不重复）。 */
export interface OrderConversionCreatePayload {
  plantId: string
  lines: OrderConversionLinePayload[]
}

/** PDA 订单转换扫码（FC-07：载具码 E/F/M/P；提交锁定并回写实扫数量/已扫轴数）。 */
export interface OrderConversionScanPayload {
  conversionId: string
  lineId: string
  code: string
}

/** 库存转换建单明细行载荷（FC-18：右侧转换清单；字段名对齐 landed conversion.ts）。 */
export interface StockConversionLinePayload {
  unitNo: string
  segmentLength: string
  customerAxisNo?: string | null
  palletCode?: string | null
  quantity?: string
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

// ====================================================================
// T17 warehouse-reverse（仓储逆向：移库 / 调拨出入库 / 盘点 / 采购纠正 / 载具）
// 字段名对齐已落地 packages/contracts/src/reverse.ts（P2-C 线）
// ====================================================================

/** 调出侧状态（WR-13：调出侧投影；cancelled 为 PDA 无任务单放弃/删空）。 */
export type TransferOutStatusValue = 'pending_out' | 'outbounding' | 'outbounded' | 'cancelled'

/** 调拨三来源（WR-07）。 */
export type TransferOutSourceKindValue = 'web_task' | 'pda_taskless' | 'auto'

/** 调拨入库方式（WR-14：固定库位=厂内即时转仓；扫码上架=需交接/跨厂）。 */
export type TransferInModeValue = 'fixed_location' | 'scan_putaway'

/** 调拨入库单状态（WR-16/17）。 */
export type TransferInStatusValue = 'pending_in' | 'inbounding' | 'completed'

/** 盘点单状态（WR-24 最小语义；全流程 GAP-F10 待裁）。 */
export type StocktakeStatusValue = 'counting' | 'completed' | 'cancelled'

/** 采购批次纠正种类（WR-S6）。 */
export type ReceiptCorrectionKindValue = 'void' | 'reverse' | 'return'

/** 载具借还事件（WR-27：append-only）。 */
export type CarrierLoanEventKindValue = 'lend' | 'take_back' | 'damage' | 'scrap'

/** 移库台账行（WR-05：查询＋详情只读；详情为提交时快照）。 */
export interface StockMoveRecordDto {
  recordId: string
  moveNo: string
  warehouseId: string
  warehouseCode: string | null
  warehouseName: string | null
  toLocationId: string
  toLocationCode: string
  locationKind: string | null
  materialCodesJoined: string
  totalQty: string
  uomCode: string
  movedBy: string
  movedAt: string
  plantId: string
}

/** 移库明细行（WR-S1：原/现库位快照列）。 */
export interface StockMoveRecordLineDto {
  lineNo: number
  unitNo: string
  materialCode: string
  fromLocationCode: string | null
  toLocationCode: string
  quantity: string
  uomCode: string
}

export interface StockMoveRecordDetailDto extends StockMoveRecordDto {
  lines: StockMoveRecordLineDto[]
}

/** 调拨出库单视图（WR-06～13；无任务单完成出库前 Web 不显示，WR-07②）。 */
export interface TransferOutboundOrderDto {
  orderId: string
  orderNo: string
  sourceKind: TransferOutSourceKindValue
  transferKind: 'production' | 'warehouse'
  relatedOrderNo: string | null
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseCode: string | null
  fromWarehouseName: string | null
  toWarehouseCode: string | null
  toWarehouseName: string | null
  status: TransferOutStatusValue
  toLocationId: string | null
  toLocationCode: string | null
  visibleOnWeb: boolean
  shippedBy: string | null
  shippedAt: string | null
  scannedCount: number
  totalOutQty: string
  uomCode: string
  /** 仅"待出库且未扫过码"可编辑/删除（WR-08） */
  editable: boolean
  plantId: string
  createdAt: string
  createdBy: string | null
}

/** 调拨出库明细（WR-S2：码、原库位、数量、调出数量）。 */
export interface TransferOutboundScanDto {
  scanId: string
  lineNo: number
  unitNo: string
  materialCode: string | null
  fromLocationCode: string | null
  quantity: string
  outQty: string
  status: 'loaded' | 'removed'
  scannedBy: string
  scannedAt: string
}

export interface TransferOutboundDetailDto extends TransferOutboundOrderDto {
  scans: TransferOutboundScanDto[]
}

/** 调拨入库单视图（WR-14～17：入库方式列＋码入库状态列）。 */
export interface TransferInboundOrderDto {
  orderId: string
  orderNo: string
  outboundOrderNo: string | null
  inboundMode: TransferInModeValue
  status: TransferInStatusValue
  fromWarehouseCode: string | null
  fromWarehouseName: string | null
  toWarehouseId: string
  toWarehouseCode: string | null
  toWarehouseName: string | null
  /** 固定库位完成单：出库方身份快照（生成即已完成、入库人/时间=出库方，WR-14）。 */
  completedBy: string | null
  completedAt: string | null
  totalCount: number
  inboundCount: number
  /** 完成入库可执行 = 每料品已入库 ≥ 待入库、至少一码已入库（WR-17） */
  completable: boolean
  inboundLines: ReadonlyArray<{
    unitNo: string
    materialCode: string | null
    quantity: string
    uomCode: string
    lineStatus: 'pending' | 'inbound'
    locationCode: string | null
  }>
  plantId: string
}

/** 盘点单视图（WR-24；锁仓标志投影：拦截分托/解绑/移库/调拨出入库/入库）。 */
export interface StocktakeOrderDto {
  orderId: string
  orderNo: string
  warehouseId: string
  warehouseCode: string | null
  warehouseName: string | null
  /** 盘点期间仓库锁定（WR-24①：同事务校验，可解释拒绝"仓库盘点锁定"） */
  locked: boolean
  status: StocktakeStatusValue
  startedBy: string
  startedAt: string
  closedAt: string | null
  closedBy: string | null
  plantId: string
}

/** 差异调整单视图（WR-24②/③：原因必填＋去向＋关联流水；禁止直改余额）。 */
export interface StockAdjustmentDto {
  adjustmentId: string
  adjustmentNo: string
  stocktakeOrderNo: string | null
  warehouseName: string | null
  reason: string
  destination: string
  lineCount: number
  totalAdjustQty: string
  adjustedBy: string
  adjustedAt: string
  lines: ReadonlyArray<{
    unitNo: string
    materialCode: string
    bookQuantity: string
    countedQuantity: string
    diffQuantity: string
    uomCode: string
  }>
  plantId: string
}

/** 采购批次纠正视图（WR-S6：作废/冲销/退货三类，关联原批次与流水，含快照）。 */
export interface ReceiptCorrectionDto {
  correctionId: string
  correctionNo: string
  batchId: string
  batchNo: string
  correctionKind: ReceiptCorrectionKindValue
  quantity: string
  uomCode: string
  reason: string
  remark: string | null
  attachments: readonly string[]
  /** 退货回传同步状态（WR-23：异步、失败可重试、限已退货批次） */
  returnSyncStatus: 'none' | 'pending' | 'failed' | 'synced'
  operatedBy: string
  operatedAt: string
  plantId: string
}

/** 批次质检状态 6 值（QD-15 / WR-19 口径）。 */
export type BatchQualityStatusValue =
  | 'exempt'
  | 'pending_inspection'
  | 'inspecting'
  | 'all_qualified'
  | 'all_unqualified'
  | 'partial_qualified'

/** 采购批次纠正视图（WR-19/20/21 业务条件与拦截项）。 */
export interface ReceiptBatchViewDto {
  batchNo: string
  materialCode: string
  materialName: string
  qualityStatus: BatchQualityStatusValue
  qualifiedSyncStatus: 'not_synced' | 'synced'
  receivedQuantity: string
  returnedQuantity: string
  /** 投影 = 已入账 − 已退货（WR-20） */
  projectedInboundQuantity: string
  uomCode: string
  returned: boolean
  voided: boolean
  canModify: boolean
  canReturn: boolean
  canVoid: boolean
  /** 下游已使用拦截（WR-22：按对象关系而非整单标记） */
  downstreamBlockers: string[]
}

/** 载具借还事件视图（WR-S5：append-only，引用 carrier，不与产品退货表关联）。 */
export interface CarrierLoanDto {
  loanId: string
  carrierId: string
  carrierCode: string
  carrierKind: 'spool' | 'drum' | 'tray' | 'box'
  eventKind: CarrierLoanEventKindValue
  counterparty: string | null
  note: string | null
  occurredBy: string
  occurredAt: string
  plantId: string
}

/** 所有权三分视图（WR-26：数量、位置、所有权三者分别可核对）。 */
export interface OwnershipBalanceDto {
  unitId: string
  unitNo: string
  locationId: string
  locationCode: string
  ownerId: string
  ownerName: string
  custodianPlantId: string
  quantity: string
  uomCode: string
  qualityStatus: string
}

/** 移库提交（WR-01/02：扫码只查询不锁定、暂存本机；提交服务端事务重校验）。 */
export interface ReverseMoveSubmitPayload {
  plantId: string
  warehouseId: string
  toLocationId: string
  stagedUnitNos: readonly string[]
  reason?: string
  businessTime?: string
}

/** Web 有任务调拨出库建单（WR-07①：生产调拨/仓库调拨，明细计划调出数量）。 */
export interface ReverseTransferOutCreatePayload {
  plantId: string
  transferKind: 'production' | 'warehouse'
  fromWarehouseId: string
  toWarehouseId: string
  relatedOrderNo?: string
  lines: ReadonlyArray<{ materialCode: string; plannedQty: string; uomCode?: string }>
  reason?: string
}

/** 调拨出库扫码（有任务 orderId / PDA 无任务首扫建单，WR-07②/WR-09）。 */
export interface ReverseTransferOutScanPayload {
  plantId: string
  orderId?: string
  unitNo: string
  toWarehouseId?: string
  validUntil?: string
  reason?: string
}

/** 完成出库（WR-11：选调入库位→固定库位即时完成；未选→在途待入库）。 */
export interface ReverseTransferOutCompletePayload {
  plantId: string
  orderId: string
  toLocationId?: string
  transitLocationId?: string
  transitLocationCode?: string
  reason?: string
}

/** 调拨入库扫码上架（WR-15：调入仓为仓库须选库位；托下单码须扫托）。 */
export interface ReverseTransferInScanPayload {
  plantId: string
  orderId: string
  unitNo: string
  palletCode?: string
  locationCode?: string
  validUntil?: string
  reason?: string
}

/** 差异调整建单（WR-24②：原因必填＋去向；正向/反向库存流水）。 */
export interface ReverseStockAdjustmentPayload {
  plantId: string
  stocktakeOrderId?: string
  reason: string
  destination: string
  lines: ReadonlyArray<{
    unitNo: string
    locationCode?: string
    ownerName?: string
    countedQuantity: string
  }>
  businessTime?: string
}

/** 采购批次退货（WR-20：备注必填 ≤200、附件 ≤3）。 */
export interface ReceiptReturnPayload {
  batchNo: string
  remark: string
  attachmentCount?: number
}

/** 采购批次作废（WR-21：删除=逻辑作废＋操作记录，明细与质检数据保留可查）。 */
export interface ReceiptVoidPayload {
  batchNo: string
  reason: string
}

/** 采购批次修改（WR-19：待质检或全部不合格且合格同步未同步）。 */
export interface ReceiptModifyPayload {
  batchNo: string
  lines: ReadonlyArray<{ materialCode: string; quantity: string; locationCode?: string }>
}

/** 载具借还登记（WR-27：借出/回收/损坏/报废 append-only）。 */
export interface CarrierLoanCreatePayload {
  carrierCode: string
  carrierKind: CarrierLoanDto['carrierKind']
  eventKind: CarrierLoanEventKindValue
  counterparty?: string
  note?: string
}

// ====================================================================
// T18 quality-disposition（质量处置；后端 contracts 未落地，按冻结合同形状）
// ====================================================================

/** 质量存疑记录（QD-S1 append-only：恢复写处置记录、不覆盖原存疑记录） */
export interface P2SuspectRecordDto {
  id: string
  unitNo: string
  materialCode: string
  materialName: string
  status: 'suspect' | 'restored'
  productionDeptName: string
  raisedBy: string
  raisedAt: string
  /** 处置记录链（QD-03：存疑→恢复完整审计链） */
  dispositions: ReadonlyArray<{
    id: string
    conclusion: 'restored'
    operatorName: string
    operatedAt: string
    basis: string
  }>
}

/** PDA 存疑标记（QD-01：托码拒/未入库拒/无库位拒/已存疑拒；扫码只查询） */
export interface P2SuspectRegisterPayload {
  unitNo: string
}

export interface P2SuspectRestorePayload {
  suspectId: string
  /** 处置依据（最小处置记录必填；高影响场景强制，QD-03/GAP-D5） */
  basis: string
}

/** 成品异常记录（QD-06/10：审核状态 3 值；不合格类型 2 值） */
export interface FinishedDefectDto {
  id: string
  unitNo: string
  materialCode: string
  materialName: string
  defectType: 'rework' | 'scrap'
  quantity: string
  uom: string
  reviewStatus: 'unreviewed' | 'approved' | 'rejected'
  /** 扣数去向（QD-08：审核通过扣数必须记录去向——报废/返工/其它＋说明） */
  destination: 'scrap' | 'rework' | 'other' | null
  destinationNote: string | null
  productionDeptName: string
  raisedBy: string
  raisedAt: string
  reviewedBy: string | null
  reviewedAt: string | null
}

/** 成品异常上报（PDA，QD-06 提交校验链）。 */
export interface FinishedDefectCreatePayload {
  unitNo: string
  materialCode: string
  defectType: 'rework' | 'scrap'
  quantity: string
  reason?: string
}

export interface FinishedDefectReviewPayload {
  approved: boolean
  /** 通过时必填（QD-08：禁止无去向扣数） */
  destination?: 'scrap' | 'rework' | 'other'
  destinationNote?: string
}

/** 采购质检结论版本链行（QD-S2：append-only＋当前生效指针） */
export interface IqcConclusionVersionDto {
  id: string
  batchNo: string
  code: string | null
  version: number
  /** scope：batch_judgement=判定 / first=首检 / recheck=复检（版本链） */
  scope: 'batch_judgement' | 'first' | 'recheck'
  conclusion: 'qualified' | 'unqualified'
  remark: string | null
  attachmentCount: number
  createdBy: string
  createdAt: string
  current: boolean
}

export interface IqcBatchViewDto {
  batchNo: string
  /** 批次质检状态 6 值（QD-15：按各码当前生效结论汇总，可重算投影） */
  qualityStatus: BatchQualityStatusValue
  /** 入库状态=已退货为硬拦截（QD-17） */
  returned: boolean
  codes: ReadonlyArray<{
    code: string
    currentConclusion: 'pending_inspection' | 'qualified' | 'unqualified' | 'exempt'
    versionCount: number
    /** 同一码同一批次至多一次复检（QD-14） */
    rechecked: boolean
  }>
  versions: IqcConclusionVersionDto[]
}

/** Web 批量写入（QD-11：仅当前生效质检行仍为待质检的码）。 */
export interface IqcBatchWritePayload {
  batchNo: string
  codeResults: ReadonlyArray<{ code: string; conclusion: 'qualified' | 'unqualified' }>
}

export interface IqcJudgePayload {
  batchNo: string
  judgement: 'qualified' | 'unqualified'
  /** 备注必填（≤200 非纯空白，QD-13） */
  remark: string
  attachmentCount?: number
}

export interface IqcRecheckPayload {
  batchNo: string
}

/** PDA 单码结论（QD-12：追加历史、版本化切换；附件≤3）。 */
export interface IqcCodeConclusionPayload {
  batchNo: string
  code: string
  conclusion: 'qualified' | 'unqualified'
  scope: 'first' | 'recheck'
  attachmentCount?: number
}

/** 处置决定四类（QD-20：返工/报废/让步/放行）。 */
export type DispositionKindValue = 'rework' | 'scrap' | 'concession' | 'release'

export interface DispositionRecordDto {
  id: string
  kind: DispositionKindValue
  /** 关联检验或异常记录（QD-20） */
  targetRef: string
  targetKind: 'inspection' | 'defect' | 'unit'
  basis: string
  reason: string | null
  decidedBy: string
  decidedAt: string
  /** 让步范围（批次/数量/期限，QD-23） */
  concessionScope: string | null
  relatedReworkTaskId: string | null
}

export interface DispositionCreatePayload {
  kind: DispositionKindValue
  targetKind: DispositionRecordDto['targetKind']
  targetRef: string
  basis: string
  reason: string
  concessionScope?: string
}

/** 返工任务（QD-21：关联原工序/订单/码；产出走报工命令与谱系）。 */
export interface ReworkTaskDto {
  id: string
  taskNo: string
  unitNo: string
  orderNo: string
  sourceProcessName: string
  status: 'open' | 'in_progress' | 'done'
  createdBy: string
  createdAt: string
}

// ====================================================================
// T19 maintenance（设备维护；后端 contracts 未落地，按冻结合同形状）
// ====================================================================

/** 维修工单状态机（MT-07：已报修→分派→处理中→待复机→关闭；取消另记）。 */
export type MaintenanceOrderStatusValue =
  | 'reported'
  | 'assigned'
  | 'processing'
  | 'awaiting_recovery'
  | 'closed'
  | 'cancelled'

export interface MaintenanceOrderDto {
  id: string
  orderNo: string
  equipmentId: string
  equipmentCode: string
  equipmentName: string
  status: MaintenanceOrderStatusValue
  description: string
  reportedBy: string
  reportedAt: string
  source: 'WEB' | 'PDA'
  assigneeName: string | null
  assignedBy: string | null
  result: string | null
  responsibleName: string | null
  cancelReason: string | null
  /** 停机起止（MT-09：置维修即开停机事件、复机关闭即闭停机事件） */
  downtimeStartAt: string | null
  downtimeEndAt: string | null
  spareParts: ReadonlyArray<{ materialCode: string; materialName: string; quantity: string; uom: string }>
  /** 复机可执行 = 仅"待复机"（MT-10）；取消可执行 = 已报修/已分派/处理中（MT-14） */
  recoverable: boolean
  cancellable: boolean
}

export interface MaintenanceCreatePayload {
  equipmentId: string
  description: string
}

export interface MaintenanceAssignPayload {
  assigneeName: string
}

/** 复机（MT-10：工单关闭＋置正常＋闭停机事件＋能力变化事件；结果与责任人必填）。 */
export interface MaintenanceRecoveryPayload {
  result: string
  responsibleName: string
  /** 备件消耗（MT-11：与工单关闭同事务写消耗＋库存流水；≤实时可用量） */
  spareParts?: ReadonlyArray<{ materialCode: string; quantity: string }>
}

export interface MaintenanceCancelPayload {
  /** 取消原因必填（MT-14；停机事件与状态流水保留） */
  reason: string
}

/** 点检/保养计划（MT-12 [合同新造·框架]：版本化；超期提示不自动阻断生产）。 */
export interface MaintenancePlanDto {
  id: string
  planNo: string
  equipmentCode: string
  kind: 'inspection' | 'maintenance'
  periodRule: string
  version: number
  effectiveFrom: string
  items: ReadonlyArray<{ itemNo: string; itemName: string; standard: string }>
  lastRoundAt: string | null
  nextDueAt: string | null
  overdue: boolean
}

/** 点检/保养执行记录（MT-12：实际时间＋业务班次双存 IT-37；引用计划版本快照）。 */
export interface InspectionRoundDto {
  id: string
  roundNo: string
  planId: string
  planVersion: number
  equipmentCode: string
  passed: boolean
  failedNote: string | null
  actualAt: string
  businessShiftDate: string
  shiftName: string
  operatorName: string
  items: ReadonlyArray<{ itemNo: string; itemName: string; result: 'pass' | 'fail'; value?: string }>
}

export interface InspectionRoundCreatePayload {
  planId: string
  passed: boolean
  failedNote?: string
  items: ReadonlyArray<{ itemNo: string; result: 'pass' | 'fail'; value?: string }>
}

/** 设备扫码视图（MT-03/04：扫设备码带出档案与当前状态；EQU- 前缀宽容识别）。 */
export interface EquipmentScanViewDto {
  equipmentId: string
  code: string
  name: string
  /** MT-01：设备状态字典仅 2 值 1=正常 2=维修 */
  status: 1 | 2
  /** 置"维修"建议关联在单工单（是否强制 → GAP-F23） */
  openOrderId: string | null
  /** 当日开工记录（MT-05/06：重复开工=更新当日开工时间） */
  startedWorkTodayAt: string | null
}

/** 设备状态变更（MT-03：PDA 异常上报与 Web 行内同命令同守卫，PC-08/10）。 */
export interface EquipmentStatusChangePayload {
  equipmentId: string
  /** 1=正常 2=维修（MT-01） */
  status: 1 | 2
  /** 建议关联在单工单（GAP-F23 待裁，不强制） */
  relatedOrderId?: string
}

/** 设备开工（MT-05/06：设备存在且状态=正常；按（设备,业务日）幂等）。 */
export interface EquipmentStartPayload {
  equipmentId: string
}

// ====================================================================
// T20 reporting（报表与指标；字段名对齐已落地 packages/contracts/src/reporting.ts，P2-F 线）
// ====================================================================

/** 汇总口径两类码（RP-01）：采购收货码 / 其余码。 */
export type StockStatKindValue = 'purchase_receive' | 'production'

/** 成品入库状态（RP-04 推导；null=其余为空）。 */
export type FinishedEntryStatusValue = 'entered_warehouse' | 'not_entered' | null

/** 库存统计投影行视图（RP-01~06：一行一条统计结果，列表不做二次聚合）。 */
export interface StockStatRowDto {
  statId: string
  statKind: StockStatKindValue
  /** 华通轴号（汇总键 1） */
  unitNo: string
  /** 入库批次号（采购收货码汇总键） */
  lotNo: string | null
  /** 厂家批次（采购收货码汇总键） */
  supplierLotNo: string | null
  materialCode: string
  materialName: string | null
  materialType: 1 | 2 | 3 | null
  color: string | null
  spec: string | null
  /** 订单（其余码汇总键；可空） */
  orderNo: string | null
  /** 订单工序（有则） */
  operationSeq: number | null
  operationName: string | null
  quantity: string
  uomCode: string
  /** 计量基准标注（RP-S1：数量列含 measurement_basis） */
  measurementBasis: string
  /** 英尺数展示列（RP-03）：米 → trunc4(数量÷0.3048)，非米 → null（显示 `-`） */
  feetQuantity: string | null
  /** 原库存状态字典 6 值（RP-02 legacy；GAP-A7 映射未裁，可空并存标注） */
  stockStatus: string | null
  /** 五状态轴（IT-13 权威口径，与 legacy 并存展示不混写） */
  axisStatus: string
  reportWarehouseKind: 'WAREHOUSE' | 'LINE_SIDE' | null
  /** 成品入库状态（RP-04 推导；null=空） */
  finishedEntryStatus: FinishedEntryStatusValue
  /** 客户轴号集合（排序展示） */
  customerAxisNos: string[]
  warehouseCode: string | null
  warehouseName: string | null
  locationCode: string | null
  ownerName: string | null
  plantId: string
  createdAt: string
}

/** 勾选汇总（RP-05：服务端全量聚合，不依赖已加载分页）。 */
export interface SelectionSummaryDto {
  groups: ReadonlyArray<{
    uomCode: string | null
    /** 无单位记"未知单位"（RP-05） */
    uomLabel: string
    totalQuantity: string
  }>
  /** 总件数 = 勾选行数；未勾选时总量为 0 */
  totalRows: number
}

/** 轴查询状态值（RP-08：只读跨域投影，无新增/修改/删除/详情入口）。 */
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

export interface AxisQueryRowDto {
  unitId: string
  unitNo: string
  inboundStatus: AxisInboundStatusValue
  materialCode: string
  materialName: string | null
  materialType: 1 | 2 | 3 | null
  spec: string | null
  color: string | null
  lotNo: string | null
  quantity: string | null
  uomCode: string | null
  warehouseName: string | null
  locationCode: string | null
  carrierCode: string | null
  qcRequired: boolean
  suspectStatus: AxisSuspectStatusValue
  finishedAbnormalStatus: AxisFinishedAbnormalValue
  qcStatus: AxisQcStatusValue
  lockStatus: AxisLockStatusValue
  saleStatus: AxisSaleStatusValue
  inboundDate: string | null
  inboundUser: string | null
  salesOrderNo: string | null
  salesLineNo: string | null
  orderNo: string | null
  reportedBy: string | null
  customerAxisNo: string | null
  segmentLength: string | null
  /** 虚拟轴号（通道待 Owner 圈定——返回 null 不冒充） */
  virtualAxisNo: string | null
  reportStatus: AxisReportStatusValue
  reportedAt: string | null
  workshopName: string | null
  plantId: string
  createdAt: string
}

/** 口径分层（RP-16：草稿/提交/审核/合格/入库各自有口径，逐口径展示不混成一个完成量）。 */
export type ReportCaliberValue = 'draft' | 'submitted' | 'approved' | 'qualified' | 'stocked'

/** 单口径汇总（按生产单位分组，RP-12/RP-14：不同单位不得直接汇总）。 */
export interface ReportCaliberTotalsDto {
  caliber: ReportCaliberValue
  groups: ReadonlyArray<{ uomCode: string; totalQuantity: string }>
  axisCount: number
}

/** Web 汇总（RP-12：勾选行报工总量按单位 + 报工总轴数；服务端全量聚合 RP-17）。 */
export interface ReportSelectionSummaryDto extends ReportCaliberTotalsDto {
  /** 英尺汇总列（米组展示，RP-03 随行） */
  feetGroups: ReadonlyArray<{ uomCode: string; feetQuantity: string }> | null
}

/** PDA 累计报工（RP-13：口径分开统计、排除历史导入、精准订单身份）。 */
export interface PdaCumulativeDto {
  caliber: 'draft' | 'submitted' | 'approved'
  groups: ReadonlyArray<{ uomCode: string; totalQuantity: string }>
  /** 排除的历史导入行数（通道引入后实数） */
  excludedHistoricalRows: number
}

export type MetricFamilyValue = 'wip' | 'delivery' | 'yield' | 'loss'
export type MetricDefStatusValue = 'draft' | 'active' | 'retired'
export type SnapshotStatusValue = 'ok' | 'denominator_missing' | 'projection_failed'

/** 指标定义版本行（RP-19：分子/分母事实集、单位、口径版本、生效区间；referenced immutable）。 */
export interface MetricDefinitionDto {
  id: string
  metricKey: string
  family: MetricFamilyValue
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
  numeratorValue: string | null
  denominatorValue: string | null
  value: string | null
  uomCode: string
  status: SnapshotStatusValue
  /** 缺失/失败原因（RP-21 保留读回，不以 0 冒充） */
  missingReason: string | null
  /** 参与聚合的事实行数（RP-22 逐笔对账锚点） */
  sourceRows: number
  computedAt: string
  computedBy: string
}

/** 追溯查询（RP-22 / IT-35：正向批次→在制/轴段/客户交付；反向交付轴→原料/工序/设备/人员/检验）。 */
export interface TraceNodeDto {
  nodeId: string
  nodeType: 'material_lot' | 'inventory_unit' | 'material_segment' | 'customer_segment'
  unitNo: string | null
  materialCode: string | null
  status: string | null
  depth: number
  operationName: string | null
  equipmentCode: string | null
  operatorLogin: string | null
  holdCount: number
}

export interface TraceEdgeDto {
  fromNodeId: string
  toNodeId: string
  edgeKind: 'receipt_origin' | 'consumption' | 'production_output' | 'customer_binding'
  quantity: string
  uomCode: string
  businessTime: string
}

export interface TraceResultDto {
  direction: 'forward' | 'backward'
  root: { nodeId: string; nodeType: string; unitNo: string | null }
  nodes: TraceNodeDto[]
  edges: TraceEdgeDto[]
}

// ====================================================================
// 标签字典（界面呈现用；字典事实在 domain，此处仅展示名）
// ====================================================================

export const PALLET_TASK_TYPE_LABELS: Record<PalletTaskType, string> = {
  pallet_split: '托盘调整（分托）',
  pallet_unbind: '解绑托码',
}

export const REEL_SPLIT_STATUS_LABELS: Record<ReelSplitOrderDto['status'], string> = {
  completed: '已完成',
  reversed: '已冲销',
}

export const AXIS_CORRECTION_STATUS_LABELS: Record<AxisCorrectionDto['status'], string> = {
  completed: '已完成',
  withdrawn: '已撤销',
}

export const ORDER_CONVERSION_STATUS_LABELS: Record<OrderConversionStatusValue, string> = {
  pending: '待转换',
  completed: '已完成',
}

export const ORDER_SYNC_STATUS_LABELS: Record<OrderSyncStatusValue, string> = {
  pending: '未同步',
  sync_failed: '同步失败',
  synced: '已同步',
}

export const STOCK_INTERNAL_STATUS_LABELS: Record<StockInternalStatusValue, string> = {
  pending_execute: '待执行',
  external_processing: '外部处理中',
  local_processing: '本地处理中',
  completed: '完成',
  pending_recovery: '待恢复',
  manual_processing: '人工处理',
}

export const STOCK_DISPLAY_STATUS_LABELS: Record<StockDisplayStatusValue, string> = {
  convert_failed: '转换失败',
  sync_failed: '同步失败',
  convert_success: '转换成功',
}

export const STOCK_EXTERNAL_PUSH_LABELS: Record<StockConversionDto['externalPushStatus'], string> = {
  pending: '未外发',
  unknown: '外部结果未知',
  succeeded: '外部成功',
  failed: '外部失败',
}

export const STOCK_LOCAL_APPLY_LABELS: Record<StockConversionDto['localApplyStatus'], string> = {
  not_applied: '未应用',
  applied: '已应用',
  failed: '应用失败',
}

export const TRANSFER_OUT_STATUS_LABELS: Record<TransferOutStatusValue, string> = {
  pending_out: '待出库',
  outbounding: '出库中',
  outbounded: '已出库',
  cancelled: '已取消',
}

export const TRANSFER_OUT_SOURCE_LABELS: Record<TransferOutSourceKindValue, string> = {
  web_task: 'Web 有任务',
  pda_taskless: 'PDA 无任务',
  auto: '其它模块生成',
}

export const TRANSFER_IN_MODE_LABELS: Record<TransferInModeValue, string> = {
  fixed_location: '固定库位（厂内即时转仓）',
  scan_putaway: '扫码上架（跨厂/需交接）',
}

export const TRANSFER_IN_STATUS_LABELS: Record<TransferInStatusValue, string> = {
  pending_in: '待入库',
  inbounding: '入库中',
  completed: '已完成',
}

export const STOCKTAKE_STATUS_LABELS: Record<StocktakeStatusValue, string> = {
  counting: '盘点中',
  completed: '已关闭',
  cancelled: '已取消',
}

export const RECEIPT_CORRECTION_KIND_LABELS: Record<ReceiptCorrectionKindValue, string> = {
  void: '作废',
  reverse: '冲销',
  return: '退货',
}

export const RETURN_SYNC_STATUS_LABELS: Record<ReceiptCorrectionDto['returnSyncStatus'], string> = {
  none: '无需回传',
  pending: '待回传',
  failed: '回传失败（可重试）',
  synced: '已回传',
}

export const CARRIER_KIND_LABELS: Record<CarrierLoanDto['carrierKind'], string> = {
  spool: '轴盘',
  drum: '周转轴',
  tray: '托盘',
  box: '箱',
}

export const CARRIER_LOAN_EVENT_LABELS: Record<CarrierLoanEventKindValue, string> = {
  lend: '借出',
  take_back: '回收',
  damage: '损坏',
  scrap: '报废',
}

export const BATCH_QUALITY_STATUS_LABELS: Record<BatchQualityStatusValue, string> = {
  exempt: '免检',
  pending_inspection: '待质检',
  inspecting: '质检中',
  all_qualified: '全部合格',
  all_unqualified: '全部不合格',
  partial_qualified: '部分合格',
}

export const DEFECT_TYPE_LABELS: Record<FinishedDefectDto['defectType'], string> = {
  rework: '返工',
  scrap: '报废',
}

export const REVIEW_STATUS_LABELS: Record<FinishedDefectDto['reviewStatus'], string> = {
  unreviewed: '未审核',
  approved: '通过',
  rejected: '不通过',
}

export const DEFECT_DESTINATION_LABELS: Record<NonNullable<FinishedDefectReviewPayload['destination']>, string> = {
  scrap: '报废',
  rework: '返工',
  other: '其它',
}

export const IQC_SCOPE_LABELS: Record<IqcConclusionVersionDto['scope'], string> = {
  batch_judgement: '批次判定',
  first: '首检',
  recheck: '复检',
}

export const IQC_CODE_CONCLUSION_LABELS: Record<'pending_inspection' | 'qualified' | 'unqualified' | 'exempt', string> = {
  pending_inspection: '待质检',
  qualified: '合格',
  unqualified: '不合格',
  exempt: '免检',
}

export const DISPOSITION_KIND_LABELS: Record<DispositionKindValue, string> = {
  rework: '返工',
  scrap: '报废',
  concession: '让步',
  release: '放行',
}

export const REWORK_TASK_STATUS_LABELS: Record<ReworkTaskDto['status'], string> = {
  open: '待处理',
  in_progress: '进行中',
  done: '已完成',
}

export const MAINTENANCE_ORDER_STATUS_LABELS: Record<MaintenanceOrderStatusValue, string> = {
  reported: '已报修',
  assigned: '已分派',
  processing: '处理中',
  awaiting_recovery: '待复机',
  closed: '已关闭',
  cancelled: '已取消',
}

export const MAINTENANCE_PLAN_KIND_LABELS: Record<MaintenancePlanDto['kind'], string> = {
  inspection: '点检',
  maintenance: '保养',
}

export const EQUIPMENT_STATUS_P2_LABELS: Record<1 | 2, string> = {
  1: '正常',
  2: '维修',
}

export const STOCK_STAT_KIND_LABELS: Record<StockStatKindValue, string> = {
  purchase_receive: '采购收货码',
  production: '生产码',
}

/** RP-02：原库存状态字典 6 值（legacy；与五状态轴并存标注不混写，GAP-A7 未裁）。 */
export const STOCK_STATUS_LEGACY_LABELS: Record<string, string> = {
  normal: '正常',
  scrapped: '报废',
  frozen: '冻结',
  pending_inspection: '待检',
  outsourced: '外发',
  unqualified: '不合格',
}

export const FINISHED_ENTRY_STATUS_LABELS: Record<string, string> = {
  entered_warehouse: '成品已入库',
  not_entered: '成品未入库',
  '': '—',
}

export const AXIS_INBOUND_STATUS_LABELS: Record<AxisInboundStatusValue, string> = {
  not_in: '未入库',
  in_stock: '在库',
  shipped: '已发运',
  returned: '已退货',
  receipt_unconfirmed: '入库未确认',
  issue_unconfirmed: '出库未确认',
}

export const AXIS_QC_STATUS_LABELS: Record<AxisQcStatusValue, string> = {
  pending: '待检',
  qualified: '合格',
  exempt: '免检',
  unqualified: '不合格',
}

export const AXIS_SALE_STATUS_LABELS: Record<AxisSaleStatusValue, string> = {
  unsold: '未销售',
  sold: '已销售',
}

export const AXIS_REPORT_STATUS_LABELS: Record<AxisReportStatusValue, string> = {
  not_reported: '未报工',
  reported: '已报工',
  not_applicable: '-',
}

export const AXIS_SUSPECT_STATUS_LABELS: Record<AxisSuspectStatusValue, string> = {
  normal: '正常',
  suspect: '存疑',
}

export const AXIS_LOCK_STATUS_LABELS: Record<AxisLockStatusValue, string> = {
  unlocked: '未锁定',
  locked: '已锁定',
}

export const AXIS_ABNORMAL_STATUS_LABELS: Record<AxisFinishedAbnormalValue, string> = {
  none: '无异常',
  pending_handle: '异常未处理',
}

export const REPORT_CALIBER_LABELS: Record<ReportCaliberValue, string> = {
  draft: '草稿',
  submitted: '提交',
  approved: '审核',
  qualified: '合格',
  stocked: '入库',
}

export const METRIC_FAMILY_LABELS: Record<MetricFamilyValue, string> = {
  wip: '在制',
  delivery: '交期',
  yield: '良率',
  loss: '损耗',
}

export const METRIC_DEF_STATUS_LABELS: Record<MetricDefStatusValue, string> = {
  draft: '草稿',
  active: '生效',
  retired: '已退役',
}

export const SNAPSHOT_STATUS_LABELS: Record<SnapshotStatusValue, string> = {
  ok: '正常',
  denominator_missing: '分母缺失',
  projection_failed: '投影失败',
}

export const TRACE_EDGE_KIND_LABELS: Record<TraceEdgeDto['edgeKind'], string> = {
  receipt_origin: '收货来源',
  consumption: '投料消耗',
  production_output: '生产产出',
  customer_binding: '客户绑定',
}
