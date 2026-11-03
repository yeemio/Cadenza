/**
 * P2 六域 API 客户端（P2-UI 线新增；联调点集中层，先例 p4/client.ts）。
 *
 * 路由对齐口径（对账清单见 delivery/P2/ui/DELIVERY.md）：
 * - conversion / reverse / reporting：与已落地控制器路径逐一一致（P2-B/C/F 线）；
 * - rework / disposition / maintenance：后端线未落地，按冻结合同形状先行定义，
 *   L0 整合时逐一对账；
 * - 命令端点响应统一 {operationId,status,data}（CommandOk）；业务拒绝为非 2xx
 *   {code,message,details} → ApiError（[域-编号] 规则码经 formatP2ErrorTitleAndDetail 映射）。
 *
 * UI 便捷布尔（editable/retryable/completable/reconvertable/resyncable/visibleOnWeb）：
 * 落地后端 DTO 不携带这些列（landed contracts 无此字段），本层在响应映射时按
 * 合同门条件（FC-06/08/09/15、WR-08/17）统一计算——mock 与 live 走同一映射，
 * 页面不重复实现门条件。
 */

import { ApiError, type ApiMode } from '../client'
import { MockError } from '../mock'
import { mockP2Routes } from './mock'
import type {
  AxisCorrectionDto,
  AxisCorrectionPayload,
  AxisCorrectionScanDto,
  AxisRetirePayload,
  AxisRetireRecordDto,
  AxisRetireScanDto,
  CarrierLoanCreatePayload,
  DispositionCreatePayload,
  DispositionRecordDto,
  EquipmentScanViewDto,
  EquipmentStartPayload,
  EquipmentStatusChangePayload,
  FinishedDefectCreatePayload,
  FinishedDefectReviewPayload,
  IqcBatchViewDto,
  IqcBatchWritePayload,
  IqcCodeConclusionPayload,
  IqcJudgePayload,
  IqcRecheckPayload,
  MaintenanceAssignPayload,
  MaintenanceCancelPayload,
  MaintenanceCreatePayload,
  MaintenanceOrderDto,
  MaintenancePlanDto,
  MaintenanceRecoveryPayload,
  P2SuspectRecordDto,
  P2SuspectRegisterPayload,
  P2SuspectRestorePayload,
  PageRequest,
  PageResult,
  PalletScanPayload,
  PalletScanResultDto,
  PalletTaskDetailDto,
  PalletTaskDto,
  ReceiptCorrectionDto,
  ReceiptModifyPayload,
  ReceiptReturnPayload,
  ReceiptVoidPayload,
  ReelSplitDetailDto,
  ReelSplitExecutePayload,
  ReelSplitOrderDto,
  ReelSplitReversePayload,
  ReelSplitSourceScanDto,
  ReportCaliberTotalsDto,
  ReportSelectionSummaryDto,
  ReworkTaskDto,
  SelectionSummaryDto,
  StockAdjustmentDto,
  StockCandidateDto,
  StockConversionDetailDto,
  StockConversionDto,
  StockMoveRecordDetailDto,
  StockMoveRecordDto,
  OwnershipBalanceDto,
  CarrierLoanDto,
  InspectionRoundCreatePayload,
  InspectionRoundDto,
  ReverseMoveSubmitPayload,
  ReverseStockAdjustmentPayload,
  ReverseTransferOutCompletePayload,
  ReverseTransferOutCreatePayload,
  ReverseTransferOutScanPayload,
  ReverseTransferInScanPayload,
  ShiftSnapshotDto,
  MetricDefinitionDto,
  AxisQueryRowDto,
  StockStatRowDto,
  TraceResultDto,
  PdaCumulativeDto,
  ReceiptBatchViewDto,
  StocktakeOrderDto,
  TransferInboundOrderDto,
  TransferOutboundOrderDto,
  TransferOutboundDetailDto,
  TransferOutboundScanDto,
  FinishedDefectDto,
  OrderConversionCreatePayload,
  OrderConversionDetailDto,
  OrderConversionDto,
  OrderConversionScanPayload,
  StockConversionLinePayload,
} from './types'

export * from './types'
export { P2_RULE_MESSAGES_ZH, p2RuleCodeOf, formatP2ErrorTitleAndDetail } from './errorMessages'
export { P2_ALL_PERMISSIONS } from './permissions'
export { resetMockP2State } from './mock'

/** 命令执行成功响应（与既有 client CommandOk 同形）。 */
export interface P2CommandOk {
  operationId: string
  status: 'COMMITTED' | 'DRAFT_SAVED'
  data: unknown
}

export interface P2ClientOptions {
  baseURL?: string
  mode?: ApiMode
  mockLatencyMs?: number
  getToken?: () => string | null
  onUnauthorized?: () => void
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:3001'

interface RawErrorBody {
  code?: unknown
  message?: unknown
  details?: unknown
}

function toApiError(status: number, body: RawErrorBody | null, requestId?: string): ApiError {
  return new ApiError({
    code: typeof body?.code === 'string' ? body.code : 'ERR_UNKNOWN',
    message:
      typeof body?.message === 'string' && body.message
        ? body.message
        : `请求失败（HTTP ${status}）`,
    details: body?.details,
    httpStatus: status,
    requestId,
  })
}

// ---------------------------------------------------------------------------
// 落地域响应 → UI DTO 映射（门条件布尔统一计算；mock/live 同路）
// ---------------------------------------------------------------------------

interface LandedOrderConversionRow {
  conversionId: string
  status: 'pending' | 'completed'
  syncStatus: 'pending' | 'sync_failed' | 'synced'
  completedBy?: string | null
  completedAt?: string | null
  lineCount: number
  plantId: string
  createdAt: string
  createdBy?: string | null
  conversionNo: string
  [k: string]: unknown
}

/** FC-06/09：列表级布尔（editable 列表近似=待转换；详情按扫码事实精确化）。 */
function mapOrderConversion(row: LandedOrderConversionRow): OrderConversionDto {
  return {
    conversionId: row.conversionId,
    conversionNo: row.conversionNo,
    status: row.status,
    syncStatus: row.syncStatus,
    editable: row.status === 'pending',
    retryable: row.status === 'completed' && row.syncStatus === 'sync_failed',
    completable: row.status === 'pending' && row.lineCount > 0,
    completedBy: row.completedBy ?? null,
    completedAt: row.completedAt ?? null,
    lineCount: row.lineCount,
    plantId: row.plantId,
    createdAt: row.createdAt,
    createdBy: row.createdBy ?? null,
  }
}

/** FC-06/08：详情级精确布尔（含删码留痕的扫码事实）。 */
function mapOrderConversionDetail(raw: Record<string, unknown>): OrderConversionDetailDto {
  const base = mapOrderConversion(raw as unknown as LandedOrderConversionRow)
  const scans = (raw['scans'] as OrderConversionDetailDto['scans']) ?? []
  const lines = (raw['lines'] as OrderConversionDetailDto['lines']) ?? []
  return {
    ...base,
    editable: base.status === 'pending' && scans.length === 0,
    completable: base.status === 'pending' && lines.length > 0 && lines.every((l) => l.scannedAxes > 0),
    lines,
    scans,
  }
}

interface LandedStockConversionRow {
  conversionId: string
  conversionNo: string
  internalStatus: StockConversionDto['internalStatus']
  displayStatus: StockConversionDto['displayStatus']
  externalPushStatus: StockConversionDto['externalPushStatus']
  localApplyStatus: StockConversionDto['localApplyStatus']
  u9Success: boolean
  materialId: string
  materialCode: string
  materialName?: string | null
  targetProjectNo?: string | null
  targetSalesOrderNo: string
  targetLineNo: string
  targetBatchNo: string
  totalQty: string
  axisCount: number
  externalDocNo?: string | null
  externalFailureReason?: string | null
  completedAt?: string | null
  plantId: string
  createdAt: string
  createdBy?: string | null
}

/** FC-15：恢复路径门（重新转换=转换失败且 U9 未成功；重新同步=同步失败且 U9 已成功）。 */
function mapStockConversion(row: LandedStockConversionRow): StockConversionDto {
  return {
    conversionId: row.conversionId,
    conversionNo: row.conversionNo,
    internalStatus: row.internalStatus,
    displayStatus: row.displayStatus,
    externalPushStatus: row.externalPushStatus,
    localApplyStatus: row.localApplyStatus,
    u9Success: row.u9Success,
    materialId: row.materialId,
    materialCode: row.materialCode,
    materialName: row.materialName ?? null,
    targetProjectNo: row.targetProjectNo ?? null,
    targetSalesOrderNo: row.targetSalesOrderNo,
    targetLineNo: row.targetLineNo,
    targetBatchNo: row.targetBatchNo,
    totalQty: row.totalQty,
    axisCount: row.axisCount,
    externalDocNo: row.externalDocNo ?? null,
    externalFailureReason: row.externalFailureReason ?? null,
    reconvertable: row.displayStatus === 'convert_failed' && !row.u9Success,
    resyncable: row.displayStatus === 'sync_failed' && row.u9Success,
    completedAt: row.completedAt ?? null,
    plantId: row.plantId,
    createdAt: row.createdAt,
    createdBy: row.createdBy ?? null,
  }
}

function mapStockConversionDetail(raw: Record<string, unknown>): StockConversionDetailDto {
  return {
    ...mapStockConversion(raw as unknown as LandedStockConversionRow),
    lines: (raw['lines'] as StockConversionDetailDto['lines']) ?? [],
  }
}

interface LandedTransferOutRow {
  orderId: string
  orderNo: string
  sourceKind: TransferOutboundOrderDto['sourceKind']
  transferKind: 'production' | 'warehouse'
  relatedOrderNo?: string | null
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseCode?: string | null
  toWarehouseCode?: string | null
  status: TransferOutboundOrderDto['status']
  toLocationId?: string | null
  toLocationCode?: string | null
  visibleOnWeb?: boolean
  shippedBy?: string | null
  shippedAt?: string | null
  scannedCount: number
  totalOutQty: string
  plantId: string
  createdAt: string
  [k: string]: unknown
}

/** WR-08：仅"待出库且未扫过码"可编辑/删除。 */
function mapTransferOutbound(row: LandedTransferOutRow): TransferOutboundOrderDto {
  return {
    orderId: row.orderId,
    orderNo: row.orderNo,
    sourceKind: row.sourceKind,
    transferKind: row.transferKind,
    relatedOrderNo: row.relatedOrderNo ?? null,
    fromWarehouseId: row.fromWarehouseId,
    toWarehouseId: row.toWarehouseId,
    fromWarehouseCode: row.fromWarehouseCode ?? null,
    fromWarehouseName: (row['fromWarehouseName'] as string | null) ?? null,
    toWarehouseCode: row.toWarehouseCode ?? null,
    toWarehouseName: (row['toWarehouseName'] as string | null) ?? null,
    status: row.status,
    toLocationId: row.toLocationId ?? null,
    toLocationCode: row.toLocationCode ?? null,
    visibleOnWeb: row.visibleOnWeb ?? true,
    shippedBy: row.shippedBy ?? null,
    shippedAt: row.shippedAt ?? null,
    scannedCount: row.scannedCount,
    totalOutQty: row.totalOutQty,
    uomCode: (row['uomCode'] as string | undefined) ?? '',
    editable: row.status === 'pending_out' && row.scannedCount === 0,
    plantId: row.plantId,
    createdAt: row.createdAt,
    createdBy: (row['createdBy'] as string | null) ?? null,
  }
}

interface LandedTransferInRow {
  orderId: string
  orderNo: string
  outboundOrderNo?: string | null
  inboundMode: TransferInboundOrderDto['inboundMode']
  status: TransferInboundOrderDto['status']
  fromWarehouseCode?: string | null
  toWarehouseId: string
  toWarehouseCode?: string | null
  completedBy?: string | null
  completedAt?: string | null
  plantId: string
  inboundLines?: ReadonlyArray<{
    unitNo: string
    materialCode: string | null
    quantity: string
    uomCode?: string
    lineStatus: 'pending' | 'inbound'
    locationCode: string | null
  }>
}

/** WR-17：每料品已入库 ≥ 待入库、至少一码已入库。 */
function mapTransferInbound(row: LandedTransferInRow): TransferInboundOrderDto {
  const lines = (row.inboundLines ?? []).map((l) => ({
    unitNo: l.unitNo,
    materialCode: l.materialCode,
    quantity: l.quantity,
    uomCode: l.uomCode ?? '',
    lineStatus: l.lineStatus,
    locationCode: l.locationCode,
  }))
  const byMaterial = new Map<string, { pending: number; inbound: number }>()
  for (const l of lines) {
    const key = l.materialCode ?? ''
    const agg = byMaterial.get(key) ?? { pending: 0, inbound: 0 }
    if (l.lineStatus === 'inbound') agg.inbound += 1
    else agg.pending += 1
    byMaterial.set(key, agg)
  }
  // WR-17：可执行 = 每料品已入库数量 ≥ 待入库数量（待入库＝该料品订单行总数，即全部行已入库）
  // 且至少一码已入库；调入仓库锁定由服务端终校。
  const completable =
    lines.length > 0 &&
    lines.some((l) => l.lineStatus === 'inbound') &&
    [...byMaterial.values()].every((agg) => agg.inbound >= agg.pending + agg.inbound)
  return {
    orderId: row.orderId,
    orderNo: row.orderNo,
    outboundOrderNo: row.outboundOrderNo ?? null,
    inboundMode: row.inboundMode,
    status: row.status,
    fromWarehouseCode: row.fromWarehouseCode ?? null,
    fromWarehouseName: null,
    toWarehouseId: row.toWarehouseId,
    toWarehouseCode: row.toWarehouseCode ?? null,
    toWarehouseName: null,
    completedBy: row.completedBy ?? null,
    completedAt: row.completedAt ?? null,
    totalCount: lines.length,
    inboundCount: lines.filter((l) => l.lineStatus === 'inbound').length,
    completable,
    inboundLines: lines,
    plantId: row.plantId,
  }
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export interface P2ApiClient {
  readonly mode: ApiMode
  readonly baseURL: string

  // ---------------- T15 rework-split ----------------
  listReelSplitOrders(query: P2ListQuery & PageRequest): Promise<PageResult<ReelSplitOrderDto>>
  getReelSplit(id: string): Promise<ReelSplitDetailDto>
  scanReelSplitSource(unitNo: string): Promise<ReelSplitSourceScanDto>
  executeReelSplit(payload: ReelSplitExecutePayload): Promise<ReelSplitOrderDto>
  reverseReelSplit(id: string, payload: ReelSplitReversePayload): Promise<ReelSplitOrderDto>
  listPalletTasks(query: P2PalletTaskQuery & PageRequest): Promise<PageResult<PalletTaskDto>>
  getPalletTask(id: string): Promise<PalletTaskDetailDto>
  palletScan(payload: PalletScanPayload): Promise<PalletScanResultDto>
  palletConfirm(taskId: string): Promise<unknown>
  palletAbandon(taskId: string): Promise<unknown>
  listAxisCorrections(query: P2ListQuery & PageRequest): Promise<PageResult<AxisCorrectionDto>>
  scanAxisCorrection(unitNo: string): Promise<AxisCorrectionScanDto>
  submitAxisCorrection(payload: AxisCorrectionPayload): Promise<AxisCorrectionDto>
  withdrawAxisCorrection(id: string): Promise<AxisCorrectionDto>
  listAxisRetires(query: P2ListQuery & PageRequest): Promise<PageResult<AxisRetireRecordDto>>
  scanAxisRetire(unitNo: string): Promise<AxisRetireScanDto>
  executeAxisRetire(payload: AxisRetirePayload): Promise<AxisRetireRecordDto>

  // ---------------- T16 form-conversion ----------------
  listOrderConversions(query: P2OrderConversionQuery & PageRequest): Promise<PageResult<OrderConversionDto>>
  getOrderConversion(id: string): Promise<OrderConversionDetailDto>
  createOrderConversion(payload: OrderConversionCreatePayload): Promise<P2CommandOk>
  updateOrderConversion(conversionOrderId: string, lines: OrderConversionCreatePayload['lines'], plantId: string): Promise<P2CommandOk>
  deleteOrderConversion(conversionOrderId: string): Promise<P2CommandOk>
  orderConversionScan(payload: OrderConversionScanPayload & { segmentLength?: string; customerAxisNo?: string }): Promise<OrderConversionDetailDto['scans'][number]>
  orderConversionScanDelete(scanId: string): Promise<P2CommandOk>
  completeOrderConversion(conversionOrderId: string): Promise<P2CommandOk>
  retryOrderConversionSync(conversionOrderId: string): Promise<P2CommandOk>
  listStockConversions(query: P2ListQuery & PageRequest): Promise<PageResult<StockConversionDto>>
  getStockConversion(id: string): Promise<StockConversionDetailDto>
  listStockCandidates(query: { materialCode?: string }): Promise<StockCandidateDto[]>
  createStockConversion(payload: {
    plantId: string
    targetSalesOrderNo: string
    targetLineNo: string
    targetBatchNo: string
    targetProjectNo?: string | null
    lines: StockConversionLinePayload[]
  }): Promise<P2CommandOk>
  reconvertStock(conversionStockOrderId: string): Promise<P2CommandOk>
  resyncStock(conversionStockOrderId: string): Promise<P2CommandOk>

  // ---------------- T17 warehouse-reverse ----------------
  listMoveRecords(query: P2ListQuery & PageRequest): Promise<PageResult<StockMoveRecordDto>>
  getMoveRecord(id: string): Promise<StockMoveRecordDetailDto>
  moveScanInfo(query: { plantId: string; unitNo: string; warehouseId: string; toLocationId?: string }): Promise<Record<string, unknown>>
  listMoveTargetWarehouses(query: { plantId?: string; deptId?: string }): Promise<Array<Record<string, unknown>>>
  submitMove(payload: ReverseMoveSubmitPayload): Promise<P2CommandOk>
  listTransferOutbound(query: P2ListQuery & PageRequest): Promise<PageResult<TransferOutboundOrderDto>>
  getTransferOutbound(id: string): Promise<TransferOutboundDetailDto>
  createTransferOutbound(payload: ReverseTransferOutCreatePayload): Promise<P2CommandOk>
  transferOutboundScan(payload: ReverseTransferOutScanPayload): Promise<P2CommandOk>
  completeTransferOutbound(payload: ReverseTransferOutCompletePayload): Promise<P2CommandOk>
  listTransferInbound(query: P2ListQuery & PageRequest): Promise<PageResult<TransferInboundOrderDto>>
  transferInboundScanPutaway(payload: ReverseTransferInScanPayload): Promise<P2CommandOk>
  completeTransferInbound(orderId: string, plantId: string): Promise<P2CommandOk>
  listStocktakes(query: P2ListQuery & PageRequest): Promise<PageResult<StocktakeOrderDto>>
  openStocktake(plantId: string, warehouseId: string): Promise<P2CommandOk>
  closeStocktake(orderId: string, plantId: string): Promise<P2CommandOk>
  listStockAdjustments(query: P2ListQuery & PageRequest): Promise<PageResult<StockAdjustmentDto>>
  executeStockAdjustment(payload: ReverseStockAdjustmentPayload): Promise<P2CommandOk>
  listReceiptCorrections(query: P2ListQuery & PageRequest): Promise<PageResult<ReceiptCorrectionDto>>
  listReceiptBatches(query: { batchNo?: string } & PageRequest): Promise<PageResult<ReceiptBatchViewDto>>
  modifyReceiptBatch(payload: ReceiptModifyPayload): Promise<P2CommandOk>
  returnReceiptBatch(payload: ReceiptReturnPayload): Promise<P2CommandOk>
  voidReceiptBatch(payload: ReceiptVoidPayload): Promise<P2CommandOk>
  retryReceiptReturnSync(correctionId: string): Promise<P2CommandOk>
  listCarrierLoans(query: P2ListQuery & PageRequest): Promise<PageResult<CarrierLoanDto>>
  createCarrierLoan(payload: CarrierLoanCreatePayload): Promise<P2CommandOk>
  listOwnershipBalances(query: P2ListQuery & PageRequest): Promise<PageResult<OwnershipBalanceDto>>

  // ---------------- T18 quality-disposition ----------------
  listSuspects(query: { status?: 'suspect' | 'restored' } & PageRequest): Promise<PageResult<P2SuspectRecordDto>>
  registerSuspect(payload: P2SuspectRegisterPayload): Promise<P2SuspectRecordDto>
  restoreSuspect(payload: P2SuspectRestorePayload): Promise<P2SuspectRecordDto>
  listFinishedDefects(query: { reviewStatus?: 'unreviewed' | 'approved' | 'rejected' } & PageRequest): Promise<PageResult<FinishedDefectDto>>
  createFinishedDefect(payload: FinishedDefectCreatePayload): Promise<FinishedDefectDto>
  reviewFinishedDefect(id: string, payload: FinishedDefectReviewPayload): Promise<FinishedDefectDto>
  getIqcBatch(batchNo: string): Promise<IqcBatchViewDto>
  iqcBatchWrite(payload: IqcBatchWritePayload): Promise<P2CommandOk>
  iqcJudge(payload: IqcJudgePayload): Promise<P2CommandOk>
  iqcRecheck(payload: IqcRecheckPayload): Promise<P2CommandOk>
  iqcCodeConclusion(payload: IqcCodeConclusionPayload): Promise<P2CommandOk>
  listDispositions(query: { kind?: DispositionRecordDto['kind'] } & PageRequest): Promise<PageResult<DispositionRecordDto>>
  createDisposition(payload: DispositionCreatePayload): Promise<DispositionRecordDto>
  listReworkTasks(query: { status?: ReworkTaskDto['status'] } & PageRequest): Promise<PageResult<ReworkTaskDto>>

  // ---------------- T19 maintenance ----------------
  listMaintenanceOrders(query: { status?: MaintenanceOrderDto['status'] } & PageRequest): Promise<PageResult<MaintenanceOrderDto>>
  getMaintenanceOrder(id: string): Promise<MaintenanceOrderDto>
  createMaintenanceOrder(payload: MaintenanceCreatePayload): Promise<MaintenanceOrderDto>
  assignMaintenanceOrder(orderId: string, payload: MaintenanceAssignPayload): Promise<MaintenanceOrderDto>
  recoverMaintenanceOrder(orderId: string, payload: MaintenanceRecoveryPayload): Promise<MaintenanceOrderDto>
  cancelMaintenanceOrder(orderId: string, payload: MaintenanceCancelPayload): Promise<MaintenanceOrderDto>
  listMaintenancePlans(query: { kind?: MaintenancePlanDto['kind'] } & PageRequest): Promise<PageResult<MaintenancePlanDto>>
  submitInspectionRound(payload: InspectionRoundCreatePayload): Promise<InspectionRoundDto>
  scanEquipment(code: string): Promise<EquipmentScanViewDto>
  changeEquipmentStatus(payload: EquipmentStatusChangePayload): Promise<EquipmentScanViewDto>
  startEquipment(payload: EquipmentStartPayload): Promise<P2CommandOk>

  // ---------------- T20 reporting ----------------
  listStockStats(query: P2StockStatQuery & PageRequest): Promise<PageResult<StockStatRowDto>>
  stockStatSelectionSummary(ids: readonly string[]): Promise<SelectionSummaryDto>
  listAxisQuery(query: P2AxisQueryQuery & PageRequest): Promise<PageResult<AxisQueryRowDto>>
  reportSummaryByCaliber(query: { orderNoLike?: string; dateFrom?: string; dateTo?: string }): Promise<{ calibers: ReportCaliberTotalsDto[] }>
  reportSelectionSummary(ids: readonly string[], query: { orderNoLike?: string; dateFrom?: string; dateTo?: string }): Promise<ReportSelectionSummaryDto>
  pdaCumulative(query: { deptId?: string; operatorOnly?: boolean }): Promise<{ calibers: PdaCumulativeDto[]; operatorOnly: boolean }>
  listMetricDefinitions(): Promise<MetricDefinitionDto[]>
  listShiftSnapshots(query: P2SnapshotQuery & PageRequest): Promise<PageResult<ShiftSnapshotDto>>
  trace(unitNo: string, direction?: 'forward' | 'backward'): Promise<TraceResultDto>
}

export interface P2ListQuery {
  plantId?: string
  [key: string]: string | number | boolean | undefined
}

export interface P2PalletTaskQuery {
  taskType?: 'pallet_split' | 'pallet_unbind'
}

export interface P2OrderConversionQuery {
  plantId?: string
  statuses?: readonly string[]
  syncStatuses?: readonly string[]
  conversionNoLike?: string
}

export interface P2StockStatQuery {
  unitNoLike?: string
  customerAxisLike?: string
  stockStatus?: string
  finishedEntryStatus?: 'entered_warehouse' | 'not_entered'
  export?: boolean
}

export interface P2AxisQueryQuery {
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
  export?: boolean
}

export interface P2SnapshotQuery {
  shiftDateFrom?: string
  shiftDateTo?: string
  metricKeys?: readonly string[]
  statuses?: readonly string[]
}

export function createP2ApiClient(options: P2ClientOptions = {}): P2ApiClient {
  const mode: ApiMode = options.mode ?? 'live'
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const mockLatency = options.mockLatencyMs ?? 120

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const token = options.getToken?.() ?? null
    if (mode === 'mock') {
      await new Promise((r) => setTimeout(r, mockLatency))
      const query: Record<string, string> = {}
      for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') query[k] = v
      const handler = mockP2Routes(method, path, query)
      if (!handler) {
        throw new ApiError({ code: 'ERR_NOT_FOUND', message: `mock 未定义路由：${method} ${path}`, httpStatus: 404 })
      }
      try {
        return (await handler({ token, query, body: opts.body })) as T
      } catch (err) {
        if (err instanceof MockError) {
          if (err.httpStatus === 401) options.onUnauthorized?.()
          throw new ApiError({ code: err.code, message: err.message, details: err.details, httpStatus: err.httpStatus })
        }
        throw err
      }
    }

    const url = new URL(`${baseURL}${path}`)
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, v)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      })
    } catch (cause) {
      throw new ApiError({
        code: 'ERR_NETWORK',
        message: cause instanceof Error ? `网络请求失败：${cause.message}` : '网络请求失败',
      })
    }
    const requestId = res.headers.get('x-request-id') ?? undefined
    if (res.status === 401) {
      options.onUnauthorized?.()
    }
    let body: unknown = null
    if (res.status !== 204) {
      try {
        body = await res.json()
      } catch {
        body = null
      }
    }
    if (!(res.status >= 200 && res.status < 300)) {
      throw toApiError(res.status, body as RawErrorBody | null, requestId)
    }
    return body as T
  }

  const pageQuery = (q: object): Record<string, string | undefined> => {
    const out: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === '' || v === false) continue
      if (Array.isArray(v)) {
        const arr = v as readonly (string | number | boolean)[]
        if (arr.length > 0) out[k] = arr.join(',')
      } else if (typeof v === 'number' || typeof v === 'string' || v === true) {
        out[k] = String(v)
      }
    }
    return out
  }

  async function command(path: string, body: Record<string, unknown>): Promise<P2CommandOk> {
    return request<P2CommandOk>('POST', path, { body })
  }

  /** 命令响应 data 载荷直取（CommandOk.data）。 */
  async function commandData<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const ok = await command(path, body)
    return (ok.data ?? null) as T
  }

  return {
    mode,
    baseURL,

    // ---------------- T15 ----------------
    async listReelSplitOrders(query) {
      return request('GET', '/rework/reel-splits', { query: pageQuery(query) })
    },
    async getReelSplit(id) {
      return request('GET', `/rework/reel-splits/${encodeURIComponent(id)}`)
    },
    async scanReelSplitSource(unitNo) {
      return request('GET', '/rework/reel-splits/source-scan', { query: { unitNo } })
    },
    async executeReelSplit(payload) {
      return commandData('/rework/reel-split/execute', payload as unknown as Record<string, unknown>)
    },
    async reverseReelSplit(id, payload) {
      return commandData('/rework/reel-split/reverse', { id, ...payload })
    },
    async listPalletTasks(query) {
      return request('GET', '/rework/pallet-tasks', { query: pageQuery(query) })
    },
    async getPalletTask(id) {
      return request('GET', `/rework/pallet-tasks/${encodeURIComponent(id)}`)
    },
    async palletScan(payload) {
      return commandData('/rework/pallet-task/scan', payload as unknown as Record<string, unknown>)
    },
    async palletConfirm(taskId) {
      return commandData('/rework/pallet-task/confirm', { taskId })
    },
    async palletAbandon(taskId) {
      return commandData('/rework/pallet-task/abandon', { taskId })
    },
    async listAxisCorrections(query) {
      return request('GET', '/rework/axis-corrections', { query: pageQuery(query) })
    },
    async scanAxisCorrection(unitNo) {
      return request('GET', '/rework/axis-correction/scan', { query: { unitNo } })
    },
    async submitAxisCorrection(payload) {
      return commandData('/rework/axis-correction/submit', payload as unknown as Record<string, unknown>)
    },
    async withdrawAxisCorrection(id) {
      return commandData('/rework/axis-correction/withdraw', { id })
    },
    async listAxisRetires(query) {
      return request('GET', '/rework/axis-retires', { query: pageQuery(query) })
    },
    async scanAxisRetire(unitNo) {
      return request('GET', '/rework/axis-retire/scan', { query: { unitNo } })
    },
    async executeAxisRetire(payload) {
      return commandData('/rework/axis-retire/execute', payload as unknown as Record<string, unknown>)
    },

    // ---------------- T16 ----------------
    async listOrderConversions(query) {
      const raw = await request<PageResult<LandedOrderConversionRow>>('GET', '/conversion/orders', { query: pageQuery(query) })
      return { ...raw, items: raw.items.map(mapOrderConversion) }
    },
    async getOrderConversion(id) {
      const raw = await request<Record<string, unknown>>('GET', `/conversion/orders/${encodeURIComponent(id)}`)
      return mapOrderConversionDetail(raw)
    },
    async createOrderConversion(payload) {
      return command('/conversion/order/create', payload as unknown as Record<string, unknown>)
    },
    async updateOrderConversion(conversionOrderId, lines, plantId) {
      return command('/conversion/order/update', { conversionOrderId, plantId, lines: lines as unknown as unknown[] })
    },
    async deleteOrderConversion(conversionOrderId) {
      return command('/conversion/order/delete', { conversionOrderId })
    },
    async orderConversionScan(payload) {
      return commandData('/conversion/order/scan', payload as unknown as Record<string, unknown>)
    },
    async orderConversionScanDelete(scanId) {
      return command('/conversion/order/scan-delete', { scanId })
    },
    async completeOrderConversion(conversionOrderId) {
      return command('/conversion/order/complete', { conversionOrderId })
    },
    async retryOrderConversionSync(conversionOrderId) {
      return command('/conversion/order/sync-retry', { conversionOrderId })
    },
    async listStockConversions(query) {
      const raw = await request<PageResult<LandedStockConversionRow>>('GET', '/conversion/stock-orders', { query: pageQuery(query) })
      return { ...raw, items: raw.items.map(mapStockConversion) }
    },
    async getStockConversion(id) {
      const raw = await request<Record<string, unknown>>('GET', `/conversion/stock-orders/${encodeURIComponent(id)}`)
      return mapStockConversionDetail(raw)
    },
    async listStockCandidates(query) {
      return request('GET', '/conversion/stock/candidates', { query: { materialCode: query.materialCode } })
    },
    async createStockConversion(payload) {
      return command('/conversion/stock/create', payload as unknown as Record<string, unknown>)
    },
    async reconvertStock(conversionStockOrderId) {
      return command('/conversion/stock/reconvert', { conversionStockOrderId })
    },
    async resyncStock(conversionStockOrderId) {
      return command('/conversion/stock/resync', { conversionStockOrderId })
    },

    // ---------------- T17 ----------------
    async listMoveRecords(query) {
      return request('GET', '/reverse/move-records', { query: pageQuery(query) })
    },
    async getMoveRecord(id) {
      return request('GET', `/reverse/move-records/${encodeURIComponent(id)}`)
    },
    async moveScanInfo(query) {
      return request('GET', '/reverse/move/scan-info', { query })
    },
    async listMoveTargetWarehouses(query) {
      return request('GET', '/reverse/move/target-warehouses', { query })
    },
    async submitMove(payload) {
      return command('/reverse/move/submit', payload as unknown as Record<string, unknown>)
    },
    async listTransferOutbound(query) {
      const raw = await request<PageResult<LandedTransferOutRow>>('GET', '/reverse/transfer-outbound', { query: pageQuery(query) })
      return { ...raw, items: raw.items.map(mapTransferOutbound) }
    },
    async getTransferOutbound(id) {
      const raw = await request<LandedTransferOutRow & { scans?: TransferOutboundScanDto[] }>('GET', `/reverse/transfer-outbound/${encodeURIComponent(id)}`)
      return { ...mapTransferOutbound(raw), scans: raw.scans ?? [] }
    },
    async createTransferOutbound(payload) {
      return command('/reverse/transfer-outbound', payload as unknown as Record<string, unknown>)
    },
    async transferOutboundScan(payload) {
      return command('/reverse/transfer-outbound/scan', payload as unknown as Record<string, unknown>)
    },
    async completeTransferOutbound(payload) {
      return command('/reverse/transfer-outbound/complete', payload as unknown as Record<string, unknown>)
    },
    async listTransferInbound(query) {
      const raw = await request<PageResult<LandedTransferInRow>>('GET', '/reverse/transfer-inbound', { query: pageQuery(query) })
      return { ...raw, items: raw.items.map(mapTransferInbound) }
    },
    async transferInboundScanPutaway(payload) {
      return command('/reverse/transfer-inbound/scan-putaway', payload as unknown as Record<string, unknown>)
    },
    async completeTransferInbound(orderId, plantId) {
      return command('/reverse/transfer-inbound/complete', { orderId, plantId })
    },
    async listStocktakes(query) {
      return request('GET', '/reverse/stocktakes', { query: pageQuery(query) })
    },
    async openStocktake(plantId, warehouseId) {
      return command('/reverse/stocktake/open', { plantId, warehouseId })
    },
    async closeStocktake(orderId, plantId) {
      return command('/reverse/stocktake/close', { orderId, plantId })
    },
    async listStockAdjustments(query) {
      return request('GET', '/reverse/stock-adjustments', { query: pageQuery(query) })
    },
    async executeStockAdjustment(payload) {
      return command('/reverse/stock-adjustment/execute', payload as unknown as Record<string, unknown>)
    },
    async listReceiptCorrections(query) {
      return request('GET', '/reverse/receipt-corrections', { query: pageQuery(query) })
    },
    async listReceiptBatches(query) {
      return request('GET', '/reverse/receipt/receive-lines', { query: pageQuery(query) })
    },
    async modifyReceiptBatch(payload) {
      return command('/reverse/receipt/modify', payload as unknown as Record<string, unknown>)
    },
    async returnReceiptBatch(payload) {
      return command('/reverse/receipt/return', payload as unknown as Record<string, unknown>)
    },
    async voidReceiptBatch(payload) {
      return command('/reverse/receipt/void', payload as unknown as Record<string, unknown>)
    },
    async retryReceiptReturnSync(correctionId) {
      return command('/reverse/receipt/return-sync/retry', { correctionId })
    },
    async listCarrierLoans(query) {
      return request('GET', '/reverse/carrier-loans', { query: pageQuery(query) })
    },
    async createCarrierLoan(payload) {
      return command('/reverse/carrier/loan', payload as unknown as Record<string, unknown>)
    },
    async listOwnershipBalances(query) {
      return request('GET', '/reverse/ownership-balances', { query: pageQuery(query) })
    },

    // ---------------- T18 ----------------
    async listSuspects(query) {
      return request('GET', '/disposition/suspects', { query: pageQuery(query) })
    },
    async registerSuspect(payload) {
      return commandData('/disposition/suspect/register', payload as unknown as Record<string, unknown>)
    },
    async restoreSuspect(payload) {
      return commandData('/disposition/suspect/restore', payload as unknown as Record<string, unknown>)
    },
    async listFinishedDefects(query) {
      return request('GET', '/disposition/finished-defects', { query: pageQuery(query) })
    },
    async createFinishedDefect(payload) {
      return commandData('/disposition/finished-defect/create', payload as unknown as Record<string, unknown>)
    },
    async reviewFinishedDefect(id, payload) {
      return commandData('/disposition/finished-defect/review', { id, ...payload })
    },
    async getIqcBatch(batchNo) {
      return request('GET', '/disposition/iqc/batch', { query: { batchNo } })
    },
    async iqcBatchWrite(payload) {
      return command('/disposition/iqc/batch-write', payload as unknown as Record<string, unknown>)
    },
    async iqcJudge(payload) {
      return command('/disposition/iqc/judge', payload as unknown as Record<string, unknown>)
    },
    async iqcRecheck(payload) {
      return command('/disposition/iqc/recheck', payload as unknown as Record<string, unknown>)
    },
    async iqcCodeConclusion(payload) {
      return command('/disposition/iqc/code-conclusion', payload as unknown as Record<string, unknown>)
    },
    async listDispositions(query) {
      return request('GET', '/disposition/records', { query: pageQuery(query) })
    },
    async createDisposition(payload) {
      return commandData('/disposition/record/create', payload as unknown as Record<string, unknown>)
    },
    async listReworkTasks(query) {
      return request('GET', '/disposition/rework-tasks', { query: pageQuery(query) })
    },

    // ---------------- T19 ----------------
    async listMaintenanceOrders(query) {
      return request('GET', '/maintenance/orders', { query: pageQuery(query) })
    },
    async getMaintenanceOrder(id) {
      return request('GET', `/maintenance/orders/${encodeURIComponent(id)}`)
    },
    async createMaintenanceOrder(payload) {
      return commandData('/maintenance/order/create', payload as unknown as Record<string, unknown>)
    },
    async assignMaintenanceOrder(orderId, payload) {
      return commandData('/maintenance/order/assign', { orderId, ...payload })
    },
    async recoverMaintenanceOrder(orderId, payload) {
      return commandData('/maintenance/order/recover', { orderId, ...payload })
    },
    async cancelMaintenanceOrder(orderId, payload) {
      return commandData('/maintenance/order/cancel', { orderId, ...payload })
    },
    async listMaintenancePlans(query) {
      return request('GET', '/maintenance/plans', { query: pageQuery(query) })
    },
    async submitInspectionRound(payload) {
      return commandData('/maintenance/inspection-round/submit', payload as unknown as Record<string, unknown>)
    },
    async scanEquipment(code) {
      return request('GET', '/maintenance/equipment-scan', { query: { code } })
    },
    async changeEquipmentStatus(payload) {
      return commandData('/maintenance/equipment/status-change', payload as unknown as Record<string, unknown>)
    },
    async startEquipment(payload) {
      return command('/maintenance/equipment/start', payload as unknown as Record<string, unknown>)
    },

    // ---------------- T20 ----------------
    async listStockStats(query) {
      return request('GET', '/reporting/stock-stats', { query: pageQuery(query) })
    },
    async stockStatSelectionSummary(ids) {
      return request('POST', '/reporting/stock-stats/summary', { body: { ids } })
    },
    async listAxisQuery(query) {
      return request('GET', '/reporting/axis-query', { query: pageQuery(query) })
    },
    async reportSummaryByCaliber(query) {
      return request('GET', '/reporting/report-summary/by-caliber', { query })
    },
    async reportSelectionSummary(ids, query) {
      return request('POST', '/reporting/report-summary/selection', { body: { ids }, query })
    },
    async pdaCumulative(query) {
      return request('GET', '/reporting/pda/cumulative', { query: { deptId: query.deptId, operatorOnly: query.operatorOnly ? '1' : undefined } })
    },
    async listMetricDefinitions() {
      return request('GET', '/reporting/metrics/definitions')
    },
    async listShiftSnapshots(query) {
      return request('GET', '/reporting/shift-snapshots', { query: pageQuery(query) })
    },
    async trace(unitNo, direction = 'forward') {
      return request('GET', `/reporting/trace/${encodeURIComponent(unitNo)}`, { query: { direction } })
    },
  }
}
