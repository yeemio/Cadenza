/**
 * P2 六域 mock 路由（P2-UI 线新增；演示数据与真实 DTO 同形——先例：api/mock.ts / api/p4/mock.ts）。
 *
 * 路由对齐口径（对账清单见 delivery/P2/ui/DELIVERY.md）：
 * - conversion / reverse / reporting 三域：与已落地控制器逐一路径对齐
 *   （apps/api/src/{conversion,reverse,reporting}/*.controller.ts，P2-B/C/F 线），
 *   响应形状对齐 packages/contracts/src/{conversion,reverse,reporting}.ts（statusLabel 等服务端标签随行）；
 * - rework / disposition / maintenance 三域：后端线未落地，按冻结合同形状先行定义
 *   （frozen/p2/{rework-split,quality-disposition,maintenance}.md），L0 整合时逐一对账。
 *
 * 承载合同行为（LP 红线：mock 适配器承载全部合同行为）：
 * - 命令端点做最小状态迁移（内存态，刷新即重置；测试用 resetMockP2State 清场）；
 * - 拒绝场景以触发码复现合同规则（[RS-xx]/[FC-xx]/[WR-xx]/[QD-xx]/[MT-xx]/[RP-xx]）：
 *   码含「LOCKED/REJ/FULL」等关键字或非法载荷 → MockError(422, ERR_BUSINESS_RULE, [域-编号] 中文)；
 * - 权限/令牌校验在真实接入层（AuthGuard/ScopeGuard）；mock 不拦截令牌（同 p4 先例），
 *   许可显隐由页面层 useP2Permissions 控制（服务端守卫终校 PC-10）。
 */

import { MockError } from '../mock'
import type {
  AxisCorrectionDto,
  AxisCorrectionScanDto,
  AxisRetireRecordDto,
  AxisRetireScanDto,
  CarrierLoanDto,
  DispositionRecordDto,
  EquipmentScanViewDto,
  FinishedDefectDto,
  InspectionRoundDto,
  IqcBatchViewDto,
  MaintenanceOrderDto,
  MaintenancePlanDto,
  P2SuspectRecordDto,
  PalletScanResultDto,
  PalletTaskDto,
  ReelSplitDetailDto,
  ReelSplitOrderDto,
  ReelSplitSourceScanDto,
  ReworkTaskDto,
  StockMoveRecordDto,
  StocktakeOrderDto,
  StockAdjustmentDto,
  ReceiptCorrectionDto,
  ReceiptBatchViewDto,
  OwnershipBalanceDto,
} from './types'

export interface MockP2Context {
  token: string | null
  query: Record<string, string>
  body?: unknown
}

type MockP2Handler = (ctx: MockP2Context) => unknown | Promise<unknown>

function pageOf<T>(items: readonly T[], page?: string, pageSize?: string): { items: T[]; total: number; page: number; pageSize: number } {
  const p = Math.max(1, Number(page ?? '1') || 1)
  const size = Math.min(100, Math.max(1, Number(pageSize ?? '10') || 10))
  return { items: items.slice((p - 1) * size, p * size), total: items.length, page: p, pageSize: size }
}

function commandOk(data: unknown = null): { operationId: string; status: 'COMMITTED'; data: unknown } {
  return { operationId: `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, status: 'COMMITTED', data }
}

function bodyOf(ctx: MockP2Context): Record<string, unknown> {
  return typeof ctx.body === 'object' && ctx.body !== null ? (ctx.body as Record<string, unknown>) : {}
}

function ruleError(code: string, message: string): MockError {
  return new MockError({ httpStatus: 422, code: 'ERR_BUSINESS_RULE', message, details: {} })
}

// ---------------------------------------------------------------------------
// 模块级 mock 状态
// ---------------------------------------------------------------------------

const now = '2026-10-28T09:30:00.000Z'
const now2 = '2026-10-27T14:10:00.000Z'

// ---------------- T15 rework-split ----------------

const reelSplits: ReelSplitOrderDto[] = [
  {
    id: 'rs-1', splitNo: 'RS-20261028-0001', sourceUnitNo: 'RS-OK-01', materialCode: 'MAT-CU-8', materialName: '铜单丝 0.8mm',
    productionOrderNo: 'MO-2026-1024', originalQuantity: '2400.0000', uom: 'KG', splitTotal: '2300.0000',
    lossQuantity: '20.0000', remainingQuantity: '80.0000', operatorName: '王拉丝', operatedAt: now, status: 'completed',
  },
  {
    id: 'rs-2', splitNo: 'RS-20261027-0009', sourceUnitNo: 'U-2026-1001-0003', materialCode: 'MAT-AL-6', materialName: '铝单丝 0.6mm',
    productionOrderNo: 'MO-2026-1018', originalQuantity: '1200.0000', uom: 'KG', splitTotal: '1200.0000',
    lossQuantity: '0.0000', remainingQuantity: '0.0000', operatorName: '李绞制', operatedAt: now2, status: 'reversed',
  },
]

const reelSplitLines: Record<string, ReelSplitDetailDto['lines']> = {
  'rs-1': [
    { id: 'rsl-1', targetUnitNo: 'U-2026-1101-0001', quantity: '1500.0000', uom: 'KG' },
    { id: 'rsl-2', targetUnitNo: 'U-2026-1101-0002', quantity: '800.0000', uom: 'KG' },
  ],
  'rs-2': [{ id: 'rsl-3', targetUnitNo: 'U-2026-1027-0005', quantity: '1200.0000', uom: 'KG' }],
}

// 倒轴执行演示会话态（对账清单登记，后端未落地）：
// - 容量按倒出轴在会话内递减（RS-01 守恒式复现：倒入合计+损耗超出剩余可倒量即拒绝）；
// - 同一倒出轴首次损耗登记自动沿用演示默认原因；重复申报损耗须显式原因（RS-11）。
const reelSplitCapacity = new Map<string, number>([['RS-OK-01', 2200]])
const reelSplitLossDeclared = new Set<string>()

const palletTasks: PalletTaskDto[] = [
  {
    id: 'pt-1', taskType: 'pallet_split', status: 'completed', targetPalletCode: 'TP-0091', warehouseName: '成品一仓',
    operatorName: '赵物流', firstScanAt: now2, completedAt: now2, itemCount: 3,
  },
  {
    id: 'pt-2', taskType: 'pallet_unbind', status: 'completed', targetPalletCode: null, warehouseName: '成品二仓',
    operatorName: '钱仓储', firstScanAt: now2, completedAt: now2, itemCount: 1,
  },
]
/** 进行中任务（RS-14：同一人同一类型仅一条进行中；Web 台账不展示，mock 演示置空） */

const axisCorrections: AxisCorrectionDto[] = [
  {
    id: 'ac-1', unitNo: 'AC-OK-01', originalCustomerAxisNo: 'CAX-110', newCustomerAxisNo: 'CAX-210',
    originalSegmentLength: null, newSegmentLength: null, originalVirtualAxisNo: 'V-011', newVirtualAxisNo: 'V-021',
    originalQuantity: '500.0000', cutQuantity: '200.0000', newQuantity: '300.0000', uom: 'KG',
    status: 'completed', correctedBy: '孙拉丝', correctedAt: now,
  },
  {
    id: 'ac-2', unitNo: 'U-2026-1001-0006', originalCustomerAxisNo: 'CAX-318', newCustomerAxisNo: 'CAX-418',
    originalSegmentLength: '300.0000', newSegmentLength: '300.0000', originalVirtualAxisNo: null, newVirtualAxisNo: null,
    originalQuantity: '800.0000', cutQuantity: '0.0000', newQuantity: '800.0000', uom: 'KG',
    status: 'withdrawn', correctedBy: '周质检', correctedAt: now2, withdrawnBy: '周质检', withdrawnAt: now,
  },
]

const axisRetires: AxisRetireRecordDto[] = [
  {
    id: 'ar-1', unitNo: 'AR-OK-01', quantityBefore: '120.0000', uom: 'KG', productionDeptName: '拉丝车间',
    productionOrderNo: 'MO-2026-1001', salesOrderNo: 'SO-2026-0566', lineNo: '10', materialCode: 'MAT-CU-5',
    materialName: '铜单丝 0.5mm', processName: '拉丝', reportedBy: '王拉丝', reportedAt: now2,
    operatedBy: '吴班组长', operatedAt: now,
  },
  {
    id: 'ar-2', unitNo: 'U-2026-1002-0012', quantityBefore: '60.0000', uom: 'KG', productionDeptName: '绞制车间',
    productionOrderNo: 'MO-2026-1009', salesOrderNo: 'SO-2026-0570', lineNo: '20', materialCode: 'MAT-AL-4',
    materialName: '铝单丝 0.4mm', processName: '绞制', reportedBy: '李绞制', reportedAt: now2,
    operatedBy: '吴班组长', operatedAt: now,
  },
]

// ---------------- T16 form-conversion（形状对齐 landed contracts） ----------------

/** 落地 DTO 行（含服务端 statusLabel；UI 便捷布尔由 client 映射层计算） */
const orderConversionsLanded = [
  {
    conversionId: 'cv-1', conversionNo: 'CV-20261028-0001', status: 'pending', statusLabel: '待转换',
    syncStatus: 'pending', syncStatusLabel: '未同步', completedBy: null, completedAt: null,
    lineCount: 2, plantId: 'n-plant', createdAt: now, createdBy: '郑计划',
    _scans: [] as Array<Record<string, unknown>>,
  },
  {
    conversionId: 'cv-2', conversionNo: 'CV-20261026-0007', status: 'completed', statusLabel: '已完成',
    syncStatus: 'sync_failed', syncStatusLabel: '同步失败', completedBy: '郑计划', completedAt: now2,
    lineCount: 1, plantId: 'n-plant', createdAt: now2, createdBy: '郑计划',
    _scans: [{ scanId: 'cvs-1' }],
  },
  {
    conversionId: 'cv-3', conversionNo: 'CV-20261025-0003', status: 'completed', statusLabel: '已完成',
    syncStatus: 'synced', syncStatusLabel: '已同步', completedBy: '郑计划', completedAt: now2,
    lineCount: 1, plantId: 'n-plant', createdAt: now2, createdBy: '郑计划',
    _scans: [{ scanId: 'cvs-2' }],
  },
]

const orderConversionLines: Record<string, Array<Record<string, string | number | null>>> = {
  'cv-1': [
    { lineId: 'cvl-1', lineNo: 1, sourceOrderId: 'po-1024', sourceSalesOrderNo: 'SO-2026-0566', sourceLineNo: '10', sourceProjectNo: null, targetOrderId: 'po-1031', targetSalesOrderNo: 'SO-2026-0601', targetProjectNo: 'PJ-77', materialId: 'm-1', materialCode: 'MAT-CU-8', plannedQty: '1000.0000', scannedQty: '600.0000', scannedAxes: 2, uom: 'KG' },
    { lineId: 'cvl-2', lineNo: 2, sourceOrderId: 'po-1025', sourceSalesOrderNo: 'SO-2026-0567', sourceLineNo: '20', sourceProjectNo: null, targetOrderId: 'po-1032', targetSalesOrderNo: 'SO-2026-0602', targetProjectNo: 'PJ-77', materialId: 'm-2', materialCode: 'MAT-CU-9', plannedQty: '500.0000', scannedQty: '0.0000', scannedAxes: 0, uom: 'KG' },
  ],
  'cv-2': [
    { lineId: 'cvl-3', lineNo: 1, sourceOrderId: 'po-1018', sourceSalesOrderNo: 'SO-2026-0550', sourceLineNo: '10', sourceProjectNo: null, targetOrderId: 'po-1029', targetSalesOrderNo: 'SO-2026-0588', targetProjectNo: 'PJ-70', materialId: 'm-1', materialCode: 'MAT-CU-8', plannedQty: '800.0000', scannedQty: '800.0000', scannedAxes: 1, uom: 'KG' },
  ],
  'cv-3': [
    { lineId: 'cvl-4', lineNo: 1, sourceOrderId: 'po-1009', sourceSalesOrderNo: 'SO-2026-0540', sourceLineNo: '30', sourceProjectNo: null, targetOrderId: 'po-1022', targetSalesOrderNo: 'SO-2026-0571', targetProjectNo: 'PJ-61', materialId: 'm-3', materialCode: 'MAT-AL-6', plannedQty: '300.0000', scannedQty: '300.0000', scannedAxes: 1, uom: 'KG' },
  ],
}

const orderConversionScans: Record<string, Array<Record<string, unknown>>> = {
  'cv-1': [
    { scanId: 'cvs-4', lineId: 'cvl-1', unitNo: 'CV-FULL-01', inventoryUnitId: 'iu-91', segmentLength: '500.0000', customerAxisNo: 'CAX-501', quantity: '600.0000', reservationId: 'rsv-1', scannedBy: '冯扫码', scannedAt: now, deleted: false, deletedBy: null, deletedAt: null },
    { scanId: 'cvs-5', lineId: 'cvl-1', unitNo: 'U-2026-1001-0001', inventoryUnitId: 'iu-92', segmentLength: null, customerAxisNo: null, quantity: '0.0000', reservationId: 'rsv-2', scannedBy: '冯扫码', scannedAt: now, deleted: true, deletedBy: '冯扫码', deletedAt: now },
  ],
  'cv-2': [{ scanId: 'cvs-1', lineId: 'cvl-3', unitNo: 'U-2026-1026-0001', inventoryUnitId: 'iu-81', segmentLength: '800.0000', customerAxisNo: 'CAX-801', quantity: '800.0000', reservationId: 'rsv-3', scannedBy: '冯扫码', scannedAt: now2, deleted: false, deletedBy: null, deletedAt: null }],
  'cv-3': [{ scanId: 'cvs-2', lineId: 'cvl-4', unitNo: 'U-2026-1025-0002', inventoryUnitId: 'iu-82', segmentLength: '300.0000', customerAxisNo: null, quantity: '300.0000', reservationId: 'rsv-4', scannedBy: '冯扫码', scannedAt: now2, deleted: false, deletedBy: null, deletedAt: null }],
}

const stockConversionsLanded = [
  {
    conversionId: 'cvs-ord-1', conversionNo: 'CVS-20261028-0002', internalStatus: 'pending_execute', internalStatusLabel: '待执行',
    displayStatus: 'convert_failed', displayStatusLabel: '转换失败', externalPushStatus: 'failed', localApplyStatus: 'not_applied',
    u9Success: false, materialId: 'm-4', materialCode: 'MAT-XLPE-1', materialName: '交联聚乙烯绝缘料',
    targetProjectNo: 'PJ-90', targetSalesOrderNo: 'SO-2026-0612', targetLineNo: '10', targetBatchNo: 'B-20261101',
    totalQty: '1500.0000', axisCount: 2, externalDocNo: null, externalFailureReason: 'U9 接口返回失败：目标订单行不存在（演示）',
    completedAt: null, plantId: 'n-plant', createdAt: now, createdBy: '郑计划',
  },
  {
    conversionId: 'cvs-ord-2', conversionNo: 'CVS-20261027-0004', internalStatus: 'pending_recovery', internalStatusLabel: '待恢复',
    displayStatus: 'sync_failed', displayStatusLabel: '同步失败', externalPushStatus: 'succeeded', localApplyStatus: 'failed',
    u9Success: true, materialId: 'm-5', materialCode: 'MAT-PVC-2', materialName: 'PVC 护套料',
    targetProjectNo: null, targetSalesOrderNo: 'SO-2026-0600', targetLineNo: '20', targetBatchNo: 'B-20261030',
    totalQty: '700.0000', axisCount: 1, externalDocNo: 'U9DO-2026-991', externalFailureReason: null,
    completedAt: null, plantId: 'n-plant', createdAt: now2, createdBy: '郑计划',
  },
  {
    conversionId: 'cvs-ord-3', conversionNo: 'CVS-20261025-0001', internalStatus: 'completed', internalStatusLabel: '完成',
    displayStatus: 'convert_success', displayStatusLabel: '转换成功', externalPushStatus: 'succeeded', localApplyStatus: 'applied',
    u9Success: true, materialId: 'm-1', materialCode: 'MAT-CU-8', materialName: '铜单丝 0.8mm',
    targetProjectNo: 'PJ-70', targetSalesOrderNo: 'SO-2026-0588', targetLineNo: '10', targetBatchNo: 'B-20261020',
    totalQty: '400.0000', axisCount: 1, externalDocNo: 'U9DO-2026-980', externalFailureReason: null,
    completedAt: now2, plantId: 'n-plant', createdAt: now2, createdBy: '郑计划',
  },
]

const stockConversionLines: Record<string, Array<Record<string, unknown>>> = {
  'cvs-ord-1': [
    { lineId: 'cvsl-1', unitNo: 'U-2026-1026-0011', inventoryUnitId: 'iu-71', palletCode: null, quantity: '1000.0000', uom: 'KG', segmentLength: '500.0000', customerAxisNo: 'CAX-1101', materialId: 'm-4', materialCode: 'MAT-XLPE-1', sourceProjectNo: 'PJ-33', sourceSalesOrderNo: 'SO-2026-0500', sourceLineNo: '10', sourceBatchNo: 'B-20260901', warehouseCode: 'WH-F01', locationCode: '01010001' },
    { lineId: 'cvsl-2', unitNo: 'U-2026-1026-0012', inventoryUnitId: 'iu-72', palletCode: null, quantity: '500.0000', uom: 'KG', segmentLength: '250.0000', customerAxisNo: null, materialId: 'm-4', materialCode: 'MAT-XLPE-1', sourceProjectNo: 'PJ-33', sourceSalesOrderNo: 'SO-2026-0500', sourceLineNo: '10', sourceBatchNo: 'B-20260901', warehouseCode: 'WH-F01', locationCode: '01010002' },
  ],
  'cvs-ord-2': [
    { lineId: 'cvsl-3', unitNo: 'U-2026-1027-0021', inventoryUnitId: 'iu-73', palletCode: 'TP-0077', quantity: '700.0000', uom: 'KG', segmentLength: '700.0000', customerAxisNo: 'CAX-2101', materialId: 'm-5', materialCode: 'MAT-PVC-2', sourceProjectNo: null, sourceSalesOrderNo: 'SO-2026-0555', sourceLineNo: '40', sourceBatchNo: 'B-20260915', warehouseCode: 'WH-F01', locationCode: '01020001' },
  ],
  'cvs-ord-3': [
    { lineId: 'cvsl-4', unitNo: 'U-2026-1025-0009', inventoryUnitId: 'iu-74', palletCode: null, quantity: '400.0000', uom: 'KG', segmentLength: '400.0000', customerAxisNo: null, materialId: 'm-1', materialCode: 'MAT-CU-8', sourceProjectNo: null, sourceSalesOrderNo: 'SO-2026-0540', sourceLineNo: '10', sourceBatchNo: 'B-20260910', warehouseCode: 'WH-F01', locationCode: '01010003' },
  ],
}

const stockCandidates = [
  { groupKind: 'axis' as const, productAxisNo: 'U-2026-1026-0031', palletCode: null, quantity: '900.0000', uom: 'KG', axisCount: 1, materialId: 'm-4', materialCode: 'MAT-XLPE-1', customerAxisNo: 'CAX-1131', salesOrderNo: 'SO-2026-0500', lineNo: '10', batchNo: 'B-20260901', warehouseCode: 'WH-F01', locationCode: '01010005' },
  { groupKind: 'pallet' as const, productAxisNo: null, palletCode: 'TP-0083', quantity: '1600.0000', uom: 'KG', axisCount: 2, materialId: 'm-4', materialCode: 'MAT-XLPE-1', customerAxisNo: null, salesOrderNo: 'SO-2026-0500', lineNo: '10', batchNo: 'B-20260901', warehouseCode: 'WH-F01', locationCode: '01010006' },
  { groupKind: 'axis' as const, productAxisNo: 'CV-FULL-02', palletCode: null, quantity: '300.0000', uom: 'KG', axisCount: 1, materialId: 'm-4', materialCode: 'MAT-XLPE-1', customerAxisNo: null, salesOrderNo: 'SO-2026-0500', lineNo: '10', batchNo: 'B-20260901', warehouseCode: 'WH-F01', locationCode: '01010007' },
]

const codeRewrites = [
  { unitNo: 'U-2026-1025-0009', oldSalesOrderNo: 'SO-2026-0540', oldLineNo: '10', oldBatchNo: 'B-20260910', oldVirtualAxisNo: 'V-090', newSalesOrderNo: 'SO-2026-0588', newLineNo: '10', newBatchNo: 'B-20261020', newSegmentLength: '400.0000', newCustomerAxisNo: null, virtualAxisCleared: true, appliedBy: 'MES 改码任务', appliedAt: now2 },
]

// ---------------- T17 warehouse-reverse ----------------

const stockMoveRecords: StockMoveRecordDto[] = [
  { recordId: 'mr-1', moveNo: 'MV-20261028-0011', warehouseId: 'wh-1', warehouseCode: 'WH-F01', warehouseName: '成品一仓', toLocationId: 'loc-11', toLocationCode: '01010002', locationKind: 'WAREHOUSE', materialCodesJoined: 'MAT-CU-8,MAT-AL-6', totalQty: '900.0000', uomCode: 'KG', movedBy: '钱仓储', movedAt: now, plantId: 'n-plant' },
  { recordId: 'mr-2', moveNo: 'MV-20261027-0006', warehouseId: 'wh-1', warehouseCode: 'WH-F01', warehouseName: '成品一仓', toLocationId: 'loc-12', toLocationCode: '01010003', locationKind: 'WAREHOUSE', materialCodesJoined: 'MAT-PVC-2', totalQty: '700.0000', uomCode: 'KG', movedBy: '赵物流', movedAt: now2, plantId: 'n-plant' },
]

const stockMoveLines: Record<string, Array<{ lineNo: number; unitNo: string; materialCode: string; fromLocationCode: string | null; toLocationCode: string; quantity: string; uomCode: string }>> = {
  'mr-1': [
    { lineNo: 1, unitNo: 'U-2026-1001-0001', materialCode: 'MAT-CU-8', fromLocationCode: '01010001', toLocationCode: '01010002', quantity: '600.0000', uomCode: 'KG' },
    { lineNo: 2, unitNo: 'U-2026-1001-0005', materialCode: 'MAT-AL-6', fromLocationCode: '01010004', toLocationCode: '01010002', quantity: '300.0000', uomCode: 'KG' },
  ],
  'mr-2': [
    { lineNo: 1, unitNo: 'U-2026-1027-0021', materialCode: 'MAT-PVC-2', fromLocationCode: null, toLocationCode: '01010003', quantity: '700.0000', uomCode: 'KG' },
  ],
}

const transferOutboundLanded = [
  { orderId: 'to-1', orderNo: 'TO-20261028-0003', sourceKind: 'web_task', transferKind: 'production' as const, relatedOrderNo: 'MO-2026-1031', fromWarehouseId: 'wh-1', toWarehouseId: 'wh-2', fromWarehouseCode: 'WH-F01', toWarehouseCode: 'WH-L01', status: 'pending_out', statusLabel: '待出库', toLocationId: null, toLocationCode: null, visibleOnWeb: true, shippedBy: null, shippedAt: null, scannedCount: 0, totalOutQty: '1000.0000', plantId: 'n-plant', createdAt: now, _uomCode: 'KG', _fromName: '成品一仓', _toName: '一线边仓' },
  { orderId: 'to-2', orderNo: 'TO-20261027-0008', sourceKind: 'web_task', transferKind: 'warehouse' as const, relatedOrderNo: null, fromWarehouseId: 'wh-1', toWarehouseId: 'wh-3', fromWarehouseCode: 'WH-F01', toWarehouseCode: 'WH-F02', status: 'outbounded', statusLabel: '已出库', toLocationId: 'loc-31', toLocationCode: '02010001', visibleOnWeb: true, shippedBy: '赵物流', shippedAt: now2, scannedCount: 2, totalOutQty: '1600.0000', plantId: 'n-plant', createdAt: now2, _uomCode: 'KG', _fromName: '成品一仓', _toName: '成品二仓' },
]

const transferOutboundScans: Record<string, Array<Record<string, unknown>>> = {
  'to-1': [],
  'to-2': [
    { scanId: 'tos-1', lineNo: 1, unitNo: 'U-2026-1026-0011', materialCode: 'MAT-XLPE-1', fromLocationCode: '01010005', quantity: '1000.0000', outQty: '1000.0000', status: 'loaded', scannedBy: '赵物流', scannedAt: now2 },
    { scanId: 'tos-2', lineNo: 2, unitNo: 'U-2026-1026-0012', materialCode: 'MAT-XLPE-1', fromLocationCode: '01010006', quantity: '600.0000', outQty: '600.0000', status: 'loaded', scannedBy: '赵物流', scannedAt: now2 },
  ],
}

const transferInboundLanded = [
  {
    orderId: 'ti-1', orderNo: 'TI-20261028-0002', outboundOrderNo: 'TO-20261028-0001', inboundMode: 'scan_putaway', inboundModeLabel: '扫码上架（跨厂/需交接）',
    status: 'inbounding', statusLabel: '入库中', fromWarehouseCode: 'WH-F01', toWarehouseId: 'wh-3', toWarehouseCode: 'WH-F02',
    completedBy: null, completedAt: null, plantId: 'n-plant',
    inboundLines: [
      { unitNo: 'U-2026-1028-0001', materialCode: 'MAT-CU-8', quantity: '400.0000', lineStatus: 'inbound', locationCode: '02010002' },
      { unitNo: 'U-2026-1028-0002', materialCode: 'MAT-CU-8', quantity: '350.0000', lineStatus: 'pending', locationCode: null },
    ],
  },
  {
    orderId: 'ti-2', orderNo: 'TI-20261027-0006', outboundOrderNo: 'TO-20261027-0008', inboundMode: 'fixed_location', inboundModeLabel: '固定库位（厂内即时转仓）',
    status: 'completed', statusLabel: '已完成', fromWarehouseCode: 'WH-F01', toWarehouseId: 'wh-2', toWarehouseCode: 'WH-L01',
    completedBy: '赵物流', completedAt: now2, plantId: 'n-plant',
    inboundLines: [{ unitNo: 'U-2026-1027-0021', materialCode: 'MAT-PVC-2', quantity: '700.0000', lineStatus: 'inbound', locationCode: 'L01001' }],
  },
]

const stocktakeOrders: StocktakeOrderDto[] = [
  { orderId: 'st-1', orderNo: 'SD-20261028-0001', warehouseId: 'wh-2', warehouseCode: 'WH-L01', warehouseName: '一线边仓', locked: true, status: 'counting', startedBy: '孙盘点', startedAt: now, closedAt: null, closedBy: null, plantId: 'n-plant' },
  { orderId: 'st-2', orderNo: 'SD-20261020-0003', warehouseId: 'wh-1', warehouseCode: 'WH-F01', warehouseName: '成品一仓', locked: false, status: 'completed', startedBy: '孙盘点', startedAt: now2, closedAt: now2, closedBy: '孙盘点', plantId: 'n-plant' },
]

const stockAdjustments: StockAdjustmentDto[] = [
  {
    adjustmentId: 'sa-1', adjustmentNo: 'AD-20261020-0002', stocktakeOrderNo: 'SD-20261020-0003', warehouseName: '成品一仓',
    reason: '盘点差异：移库在途未入账（演示）', destination: '补记入待处理库位', lineCount: 1, totalAdjustQty: '50.0000',
    adjustedBy: '孙盘点', adjustedAt: now2, plantId: 'n-plant',
    lines: [{ unitNo: 'U-2026-1019-0007', materialCode: 'MAT-AL-4', bookQuantity: '120.0000', countedQuantity: '170.0000', diffQuantity: '50.0000', uomCode: 'KG' }],
  },
  {
    adjustmentId: 'sa-2', adjustmentNo: 'AD-20261018-0001', stocktakeOrderNo: null, warehouseName: '成品二仓',
    reason: '质量隔离调整（演示）', destination: '不合格品库位', lineCount: 1, totalAdjustQty: '-30.0000',
    adjustedBy: '周质检', adjustedAt: now2, plantId: 'n-plant',
    lines: [{ unitNo: 'U-2026-1018-0003', materialCode: 'MAT-PVC-2', bookQuantity: '300.0000', countedQuantity: '270.0000', diffQuantity: '-30.0000', uomCode: 'KG' }],
  },
]

const receiptCorrections: ReceiptCorrectionDto[] = [
  { correctionId: 'rc-1', correctionNo: 'RC-20261027-0004', batchId: 'b-9', batchNo: 'LOT-20261022-03', correctionKind: 'return', quantity: '100.0000', uomCode: 'KG', reason: '全部不合格退货（演示）', remark: '供应商周批退', attachments: ['att-1.pdf'], returnSyncStatus: 'failed', operatedBy: '何采购', operatedAt: now2, plantId: 'n-plant' },
  { correctionId: 'rc-2', correctionNo: 'RC-20261025-0002', batchId: 'b-2', batchNo: 'LOT-20261024-03', correctionKind: 'void', quantity: '0.0000', uomCode: 'KG', reason: '待质检批次重复录入作废（演示）', remark: null, attachments: [], returnSyncStatus: 'none', operatedBy: '何采购', operatedAt: now2, plantId: 'n-plant' },
]

const receiptBatchViews: ReceiptBatchViewDto[] = [
  {
    batchNo: 'LOT-20261026-01', materialCode: 'MAT-XLPE-1', materialName: '交联聚乙烯绝缘料', qualityStatus: 'all_unqualified',
    qualifiedSyncStatus: 'not_synced', receivedQuantity: '500.0000', returnedQuantity: '0.0000', projectedInboundQuantity: '500.0000',
    uomCode: 'KG', returned: false, voided: false, canModify: true, canReturn: true, canVoid: true, downstreamBlockers: [],
  },
  {
    batchNo: 'LOT-20261020-02', materialCode: 'MAT-CU-8', materialName: '铜单丝 0.8mm', qualityStatus: 'partial_qualified',
    qualifiedSyncStatus: 'synced', receivedQuantity: '800.0000', returnedQuantity: '0.0000', projectedInboundQuantity: '800.0000',
    uomCode: 'KG', returned: false, voided: false, canModify: false, canReturn: false, canVoid: false,
    downstreamBlockers: ['已被下游使用：投料消耗 MO-2026-1024（演示）', '存在生效质量结果（演示）'],
  },
]

const carrierLoans: CarrierLoanDto[] = [
  { loanId: 'cl-1', carrierId: 'c-91', carrierCode: 'TP-0091', carrierKind: 'tray', eventKind: 'lend', counterparty: '华宇物流', note: '借出 3 天', occurredBy: '赵物流', occurredAt: now, plantId: 'n-plant' },
  { loanId: 'cl-2', carrierId: 'c-77', carrierCode: 'DR-0077', carrierKind: 'drum', eventKind: 'take_back', counterparty: '华宇物流', note: null, occurredBy: '赵物流', occurredAt: now2, plantId: 'n-plant' },
]

const ownershipBalances: OwnershipBalanceDto[] = [
  { unitId: 'iu-501', unitNo: 'U-2026-1001-0001', locationId: 'loc-11', locationCode: '01010002', ownerId: 'own-1', ownerName: '中辰电缆（自有）', custodianPlantId: 'n-plant', quantity: '2400.0000', uomCode: 'KG', qualityStatus: 'qualified' },
  { unitId: 'iu-502', unitNo: 'U-2026-1002-0002', locationId: 'loc-21', locationCode: '02010001', ownerId: 'own-2', ownerName: '客户甲（来料加工）', custodianPlantId: 'n-plant', quantity: '500.0000', uomCode: 'KG', qualityStatus: 'qualified' },
]

// ---------------- T18 quality-disposition ----------------

const suspectRecords: P2SuspectRecordDto[] = [
  {
    id: 'sp-1', unitNo: 'QD-SUS-01', materialCode: 'MAT-AL-6', materialName: '铝单丝 0.6mm', status: 'suspect',
    productionDeptName: '绞制车间', raisedBy: '周质检', raisedAt: now,
    dispositions: [],
  },
  {
    id: 'sp-2', unitNo: 'U-2026-1015-0004', materialCode: 'MAT-CU-8', materialName: '铜单丝 0.8mm', status: 'restored',
    productionDeptName: '拉丝车间', raisedBy: '周质检', raisedAt: now2,
    dispositions: [{ id: 'dsp-1', conclusion: 'restored', operatorName: '吴班组长', operatedAt: now, basis: '复检合格，判定误标（演示）' }],
  },
]

const finishedDefects: FinishedDefectDto[] = [
  { id: 'fd-1', unitNo: 'QD-DEF-01', materialCode: 'MAT-CU-8', materialName: '铜单丝 0.8mm', defectType: 'rework', quantity: '50.0000', uom: 'KG', reviewStatus: 'unreviewed', destination: null, destinationNote: null, productionDeptName: '拉丝车间', raisedBy: '王拉丝', raisedAt: now, reviewedBy: null, reviewedAt: null },
  { id: 'fd-2', unitNo: 'U-2026-1021-0002', materialCode: 'MAT-AL-4', materialName: '铝单丝 0.4mm', defectType: 'scrap', quantity: '20.0000', uom: 'KG', reviewStatus: 'approved', destination: 'scrap', destinationNote: '线径超差报废（演示）', productionDeptName: '绞制车间', raisedBy: '李绞制', raisedAt: now2, reviewedBy: '吴班组长', reviewedAt: now },
  { id: 'fd-3', unitNo: 'U-2026-1021-0003', materialCode: 'MAT-PVC-2', materialName: 'PVC 护套料', defectType: 'rework', quantity: '30.0000', uom: 'KG', reviewStatus: 'rejected', destination: null, destinationNote: null, productionDeptName: '挤塑车间', raisedBy: '郑挤塑', raisedAt: now2, reviewedBy: '吴班组长', reviewedAt: now2 },
]

const iqcBatches: IqcBatchViewDto[] = [
  {
    batchNo: 'LOT-20261027-05',
    qualityStatus: 'inspecting',
    returned: false,
    codes: [
      { code: 'QD-IQC-01', currentConclusion: 'pending_inspection', versionCount: 0, rechecked: false },
      { code: 'QD-IQC-02', currentConclusion: 'qualified', versionCount: 1, rechecked: false },
      { code: 'QD-IQC-03', currentConclusion: 'unqualified', versionCount: 1, rechecked: false },
      { code: 'QD-IQC-04', currentConclusion: 'exempt', versionCount: 0, rechecked: false },
    ],
    versions: [
      { id: 'iv-1', batchNo: 'LOT-20261027-05', code: 'QD-IQC-02', version: 1, scope: 'first', conclusion: 'qualified', remark: '首检合格（演示）', attachmentCount: 1, createdBy: '周质检', createdAt: now, current: true },
      { id: 'iv-2', batchNo: 'LOT-20261027-05', code: 'QD-IQC-03', version: 1, scope: 'first', conclusion: 'unqualified', remark: '外观不合格（演示）', attachmentCount: 2, createdBy: '周质检', createdAt: now, current: true },
    ],
  },
]

const dispositionRecords: DispositionRecordDto[] = [
  { id: 'dp-1', kind: 'concession', targetRef: 'LOT-20261027-05/QD-IQC-03', targetKind: 'inspection', basis: '客户书面让步确认（演示）', reason: '外观缺陷不影响电气性能', decidedBy: '吴班组长', decidedAt: now, concessionScope: '该批次 200.0000 KG，2026-11-30 前', relatedReworkTaskId: null },
  { id: 'dp-2', kind: 'rework', targetRef: 'fd-2', targetKind: 'defect', basis: '返工工艺卡 RK-118（演示）', reason: '可修复线径超差', decidedBy: '吴班组长', decidedAt: now2, concessionScope: null, relatedReworkTaskId: 'rwk-1' },
]

const reworkTasks: ReworkTaskDto[] = [
  { id: 'rwk-1', taskNo: 'RW-20261027-0003', unitNo: 'U-2026-1021-0002', orderNo: 'MO-2026-1015', sourceProcessName: '绞制', status: 'in_progress', createdBy: '吴班组长', createdAt: now2 },
  { id: 'rwk-2', taskNo: 'RW-20261020-0001', unitNo: 'U-2026-1013-0007', orderNo: 'MO-2026-1002', sourceProcessName: '挤塑', status: 'done', createdBy: '吴班组长', createdAt: now2 },
]

// ---------------- T19 maintenance ----------------

const maintenanceOrders: MaintenanceOrderDto[] = [
  {
    id: 'mo-1', orderNo: 'MX-20261028-0006', equipmentId: 'eq-draw-01', equipmentCode: 'EQ-DRAW-01', equipmentName: '拉丝一线主机',
    status: 'reported', description: '收线张力波动报警（演示）', reportedBy: '王拉丝', reportedAt: now, source: 'PDA',
    assigneeName: null, assignedBy: null, result: null, responsibleName: null, cancelReason: null,
    downtimeStartAt: null, downtimeEndAt: null, spareParts: [], recoverable: false, cancellable: true,
  },
  {
    id: 'mo-2', orderNo: 'MX-20261026-0004', equipmentId: 'eq-twist-02', equipmentCode: 'EQ-TWIST-02', equipmentName: '绞制二线主机',
    status: 'processing', description: '轴承异响更换（演示）', reportedBy: '李绞制', reportedAt: now2, source: 'WEB',
    assigneeName: '维修甲', assignedBy: '设备管理员', result: null, responsibleName: null, cancelReason: null,
    downtimeStartAt: now2, downtimeEndAt: null, spareParts: [], recoverable: false, cancellable: true,
  },
  {
    id: 'mo-3', orderNo: 'MX-20261024-0002', equipmentId: 'eq-extrude-01', equipmentCode: 'EQ-EXTR-01', equipmentName: '挤塑一线主机',
    status: 'awaiting_recovery', description: '加热段温控失灵（演示）', reportedBy: '郑挤塑', reportedAt: now2, source: 'WEB',
    assigneeName: '维修乙', assignedBy: '设备管理员', result: null, responsibleName: null, cancelReason: null,
    downtimeStartAt: now2, downtimeEndAt: null, spareParts: [], recoverable: true, cancellable: false,
  },
]

const maintenancePlans: MaintenancePlanDto[] = [
  {
    id: 'mp-1', planNo: 'MP-DRAW-D', equipmentCode: 'EQ-DRAW-01', kind: 'inspection', periodRule: '每班次', version: 3,
    effectiveFrom: '2026-10-01', items: [
      { itemNo: 'I-1', itemName: '张力计读数记录', standard: '记录值并在 45±5N' },
      { itemNo: 'I-2', itemName: '润滑油位目视', standard: '不低于标线' },
    ], lastRoundAt: now2, nextDueAt: now, overdue: false,
  },
  {
    id: 'mp-2', planNo: 'MP-EXTR-W', equipmentCode: 'EQ-EXTR-01', kind: 'maintenance', periodRule: '每 30 天', version: 2,
    effectiveFrom: '2026-09-01', items: [
      { itemNo: 'M-1', itemName: '加热段校温', standard: '偏差 ≤3℃' },
    ], lastRoundAt: '2026-09-28T02:00:00.000Z', nextDueAt: '2026-10-28T02:00:00.000Z', overdue: true,
  },
]

const inspectionRounds: InspectionRoundDto[] = [
  {
    id: 'ir-1', roundNo: 'IR-20261027-0012', planId: 'mp-1', planVersion: 3, equipmentCode: 'EQ-DRAW-01', passed: true,
    failedNote: null, actualAt: now2, businessShiftDate: '2026-10-27', shiftName: '白班', operatorName: '王拉丝',
    items: [
      { itemNo: 'I-1', itemName: '张力计读数记录', result: 'pass', value: '47N' },
      { itemNo: 'I-2', itemName: '润滑油位目视', result: 'pass' },
    ],
  },
]

const equipmentStates = new Map<string, EquipmentScanViewDto>([
  ['EQ-DRAW-01', { equipmentId: 'eq-draw-01', code: 'EQ-DRAW-01', name: '拉丝一线主机', status: 1, openOrderId: 'mo-1', startedWorkTodayAt: now }],
  ['EQ-EXTR-01', { equipmentId: 'eq-extrude-01', code: 'EQ-EXTR-01', name: '挤塑一线主机', status: 2, openOrderId: 'mo-3', startedWorkTodayAt: null }],
])

// ---------------- T20 reporting（形状对齐 landed contracts） ----------------

const stockStatRows = [
  { statId: 'ss-1', statKind: 'production' as const, unitNo: 'U-2026-1001-0001', lotNo: null, supplierLotNo: null, materialCode: 'MAT-CU-8', materialName: '铜单丝 0.8mm', materialType: 1, color: null, spec: '0.8mm', orderNo: 'MO-2026-1024', operationSeq: 10, operationName: '拉丝', quantity: '2400.0000', uomCode: 'KG', measurementBasis: '基本单位', feetQuantity: '7874.0157', stockStatus: 'normal', axisStatus: 'in_stock_normal', reportWarehouseKind: 'WAREHOUSE' as const, finishedEntryStatus: 'entered_warehouse' as const, customerAxisNos: [], warehouseCode: 'WH-F01', warehouseName: '成品一仓', locationCode: '01010002', ownerName: null, plantId: 'n-plant', createdAt: now },
  { statId: 'ss-2', statKind: 'production' as const, unitNo: 'U-2026-1024-0009', lotNo: null, supplierLotNo: null, materialCode: 'MAT-AL-6', materialName: '铝单丝 0.6mm', materialType: 1, color: null, spec: '0.6mm', orderNo: 'MO-2026-1024', operationSeq: 20, operationName: '绞制', quantity: '1200.0000', uomCode: 'KG', measurementBasis: '基本单位', feetQuantity: '3937.0078', stockStatus: 'normal', axisStatus: 'in_stock_normal', reportWarehouseKind: 'LINE_SIDE' as const, finishedEntryStatus: 'not_entered' as const, customerAxisNos: [], warehouseCode: 'WH-L01', warehouseName: '一线边仓', locationCode: 'L01001', ownerName: null, plantId: 'n-plant', createdAt: now },
  { statId: 'ss-3', statKind: 'purchase_receive' as const, unitNo: 'U-2026-1026-0011', lotNo: 'LOT-20261026-01', supplierLotNo: 'SUP-B-0912', materialCode: 'MAT-XLPE-1', materialName: '交联聚乙烯绝缘料', materialType: 3, color: '本色', spec: '2.5mm', orderNo: null, operationSeq: null, operationName: null, quantity: '1000.0000', uomCode: 'KG', measurementBasis: '基本单位', feetQuantity: null, stockStatus: 'pending_inspection', axisStatus: 'in_stock_pending_qc', reportWarehouseKind: 'WAREHOUSE' as const, finishedEntryStatus: null, customerAxisNos: [], warehouseCode: 'WH-F01', warehouseName: '成品一仓', locationCode: '01010005', ownerName: null, plantId: 'n-plant', createdAt: now2 },
  { statId: 'ss-4', statKind: 'production' as const, unitNo: 'U-2026-1021-0002', lotNo: null, supplierLotNo: null, materialCode: 'MAT-AL-4', materialName: '铝单丝 0.4mm', materialType: 1, color: null, spec: '0.4mm', orderNo: 'MO-2026-1015', operationSeq: 30, operationName: '绞制', quantity: '120.0000', uomCode: 'KG', measurementBasis: '基本单位', feetQuantity: '393.7007', stockStatus: 'scrapped', axisStatus: 'scrapped', reportWarehouseKind: 'WAREHOUSE' as const, finishedEntryStatus: 'entered_warehouse' as const, customerAxisNos: ['CAX-4011', 'CAX-4012'], warehouseCode: 'WH-F01', warehouseName: '成品一仓', locationCode: '01010008', ownerName: null, plantId: 'n-plant', createdAt: now2 },
]

const axisQueryRows = [
  { unitId: 'iu-601', unitNo: 'U-2026-1001-0001', inboundStatus: 'in_stock' as const, materialCode: 'MAT-CU-8', materialName: '铜单丝 0.8mm', materialType: 1, spec: '0.8mm', color: null, lotNo: null, quantity: '2400.0000', uomCode: 'KG', warehouseName: '成品一仓', locationCode: '01010002', carrierCode: 'DR-0077', qcRequired: true, suspectStatus: 'normal' as const, finishedAbnormalStatus: 'none' as const, qcStatus: 'qualified' as const, lockStatus: 'locked' as const, saleStatus: 'sold' as const, inboundDate: now2, inboundUser: '钱仓储', salesOrderNo: 'SO-2026-0566', salesLineNo: '10', orderNo: 'MO-2026-1024', reportedBy: '王拉丝', customerAxisNo: null, segmentLength: null, virtualAxisNo: null, reportStatus: 'reported' as const, reportedAt: now2, workshopName: '拉丝车间', plantId: 'n-plant', createdAt: now2 },
  { unitId: 'iu-602', unitNo: 'U-2026-1026-0011', inboundStatus: 'in_stock' as const, materialCode: 'MAT-XLPE-1', materialName: '交联聚乙烯绝缘料', materialType: 3, spec: '2.5mm', color: '本色', lotNo: 'LOT-20261026-01', quantity: '1000.0000', uomCode: 'KG', warehouseName: '成品一仓', locationCode: '01010005', carrierCode: null, qcRequired: true, suspectStatus: 'normal' as const, finishedAbnormalStatus: 'none' as const, qcStatus: 'pending' as const, lockStatus: 'unlocked' as const, saleStatus: 'unsold' as const, inboundDate: now2, inboundUser: '何采购', salesOrderNo: null, salesLineNo: null, orderNo: null, reportedBy: null, customerAxisNo: null, segmentLength: null, virtualAxisNo: null, reportStatus: 'not_applicable' as const, reportedAt: null, workshopName: null, plantId: 'n-plant', createdAt: now2 },
  { unitId: 'iu-603', unitNo: 'QD-SUS-01', inboundStatus: 'in_stock' as const, materialCode: 'MAT-AL-6', materialName: '铝单丝 0.6mm', materialType: 1, spec: '0.6mm', color: null, lotNo: null, quantity: '300.0000', uomCode: 'KG', warehouseName: '成品二仓', locationCode: '02010003', carrierCode: null, qcRequired: true, suspectStatus: 'suspect' as const, finishedAbnormalStatus: 'pending_handle' as const, qcStatus: 'unqualified' as const, lockStatus: 'unlocked' as const, saleStatus: 'unsold' as const, inboundDate: now, inboundUser: '钱仓储', salesOrderNo: null, salesLineNo: null, orderNo: 'MO-2026-1018', reportedBy: '李绞制', customerAxisNo: 'CAX-318', segmentLength: '300.0000', virtualAxisNo: null, reportStatus: 'reported' as const, reportedAt: now, workshopName: '绞制车间', plantId: 'n-plant', createdAt: now },
]

const metricDefinitions = [
  { id: 'md-1', metricKey: 'wip_axis_count', family: 'wip' as const, version: 2, caliberVersion: 'CAL-WIP-2026Q4', numeratorFactSet: { kind: 'execution_report' }, denominatorFactSet: null, uomCode: 'AXIS', uomMode: 'plain' as const, effectiveFrom: '2026-10-01', effectiveTo: null, status: 'active' as const, referenced: true, description: '在制轴数（演示）', createdAt: now2 },
  { id: 'md-2', metricKey: 'first_pass_yield', family: 'yield' as const, version: 1, caliberVersion: 'CAL-YIELD-2026Q4', numeratorFactSet: { kind: 'qualified_quantity' }, denominatorFactSet: { kind: 'reported_quantity' }, uomCode: 'PERCENT', uomMode: 'percent' as const, effectiveFrom: '2026-10-01', effectiveTo: null, status: 'active' as const, referenced: false, description: '一次合格率（演示）', createdAt: now2 },
]

const shiftSnapshots = [
  { id: 'snap-1', plantId: 'n-plant', shiftDate: '2026-10-27', metricKey: 'wip_axis_count', metricVersion: 2, caliberVersion: 'CAL-WIP-2026Q4', numeratorValue: '128.0000', denominatorValue: null, value: '128.0000', uomCode: 'AXIS', status: 'ok' as const, missingReason: null, sourceRows: 46, computedAt: now2, computedBy: '系统重算' },
  { id: 'snap-2', plantId: 'n-plant', shiftDate: '2026-10-27', metricKey: 'first_pass_yield', metricVersion: 1, caliberVersion: 'CAL-YIELD-2026Q4', numeratorValue: '11800.0000', denominatorValue: '12500.0000', value: '94.4000', uomCode: 'PERCENT', status: 'ok' as const, missingReason: null, sourceRows: 52, computedAt: now2, computedBy: '系统重算' },
  { id: 'snap-3', plantId: 'n-plant', shiftDate: '2026-10-26', metricKey: 'first_pass_yield', metricVersion: 1, caliberVersion: 'CAL-YIELD-2026Q4', numeratorValue: null, denominatorValue: null, value: null, uomCode: 'PERCENT', status: 'denominator_missing' as const, missingReason: '分母事实集缺报工数量（演示，RP-21 不以 0 冒充）', sourceRows: 0, computedAt: now2, computedBy: '系统重算' },
]

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------

const routes: Array<{ method: 'GET' | 'POST'; pattern: RegExp; make: (params: string[], ctx: MockP2Context) => unknown }> = []
function route(method: 'GET' | 'POST', path: string, make: (params: string[], ctx: MockP2Context) => unknown): void {
  const pattern = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[a-zA-Z]+\\\}/g, '([^/]+)').replace(/:(\w+)/g, '([^/]+)')}$`)
  routes.push({ method, pattern, make })
}

// ---------------- T15 rework-split ----------------

route('GET', '/rework/reel-splits', (_p, ctx) => {
  const status = ctx.query['status']
  const filtered = status ? reelSplits.filter((r) => r.status === status) : reelSplits
  return pageOf(filtered, ctx.query['page'], ctx.query['pageSize'])
})
// 注意：字面子路径（source-scan）必须先于参数路由（:id）注册——路由表按注册序首个匹配生效。
route('GET', '/rework/reel-splits/source-scan', (_p, ctx) => {
  const unitNo = ctx.query['unitNo'] ?? ''
  if (unitNo.includes('LOCKED')) {
    throw ruleError('RS-03', '[RS-03] 倒出轴不可倒轴：命中前置拒绝项（已锁定/质检未完成/报工未审核/物流部仓库等）')
  }
  if (!unitNo) throw ruleError('RS-03', '[RS-03] 倒出轴不可倒轴：轴码不存在')
  const view: ReelSplitSourceScanDto = {
    unitNo, materialCode: 'MAT-CU-8', materialName: '铜单丝 0.8mm', quantity: '1000.0000', uom: 'KG',
    hasCustomerAxisNo: unitNo.includes('CUST'), hasSegmentLength: false, productionOrderNo: 'MO-2026-1031',
  }
  return view
})
route('GET', '/rework/reel-splits/:id', (p) => {
  const found = reelSplits.find((r) => r.id === p[0])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '倒轴单不存在或不在授权数据范围内', details: {} })
  return { ...found, lines: reelSplitLines[found.id] ?? [], lossReason: Number(found.lossQuantity) > 0 ? '倒轴工艺损耗（演示）' : undefined }
})
route('POST', '/rework/reel-split/execute', (_p, ctx) => {
  const body = bodyOf(ctx)
  const sourceUnitNo = String(body['sourceUnitNo'] ?? '')
  if (!Array.isArray(body['lines']) || (body['lines'] as unknown[]).length === 0) {
    throw ruleError('RS-02', '[RS-02] 倒入数量须大于 0 且倒入码互不重复；至少一条倒入行')
  }
  const lines = body['lines'] as Array<{ targetUnitNo: string; quantity: string }>
  if (lines.some((l) => Number(l.quantity) <= 0)) {
    throw ruleError('RS-02', '[RS-02] 倒入数量须大于 0 且最多 4 位小数')
  }
  const loss = Number(body['lossQuantity'] ?? '0')
  if (loss > 0 && !body['lossReason']) {
    if (reelSplitLossDeclared.has(sourceUnitNo)) {
      throw ruleError('RS-11', '[RS-11] 损耗量大于 0 时必须填写损耗原因')
    }
    reelSplitLossDeclared.add(sourceUnitNo) // 首次申报沿用演示默认原因（mock 演示语义）
  }
  const total = lines.reduce((acc, l) => acc + Number(l.quantity), 0)
  const capacity = reelSplitCapacity.get(sourceUnitNo) ?? 1000
  if (total + loss > capacity + 0.00005) {
    throw ruleError('RS-01', '[RS-01] 倒轴守恒式不成立：倒入合计+损耗量超过倒出轴原量，请核对三去向数量')
  }
  reelSplitCapacity.set(sourceUnitNo, capacity - total - loss)
  const record: ReelSplitOrderDto = {
    id: `rs-${reelSplits.length + 1}`, splitNo: `RS-20261028-${String(reelSplits.length + 1).padStart(4, '0')}`,
    sourceUnitNo, materialCode: 'MAT-CU-8', materialName: '铜单丝 0.8mm', productionOrderNo: 'MO-2026-1031',
    originalQuantity: capacity.toFixed(4), uom: 'KG', splitTotal: total.toFixed(4), lossQuantity: loss.toFixed(4),
    remainingQuantity: (capacity - total - loss).toFixed(4), operatorName: '当前用户', operatedAt: now, status: 'completed',
  }
  reelSplits.push(record)
  reelSplitLines[record.id] = lines.map((l, i) => ({ id: `rsl-${Date.now()}-${i}`, targetUnitNo: l.targetUnitNo, quantity: Number(l.quantity).toFixed(4), uom: 'KG' }))
  return commandOk(record)
})
route('POST', '/rework/reel-split/reverse', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = reelSplits.find((r) => r.id === body['id'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '倒轴单不存在', details: {} })
  if (found.status === 'reversed') {
    throw ruleError('RS-12', '[RS-12] 倒轴冲销被拒绝：该单已冲销，不可重复冲销')
  }
  if (String(body['id']) === 'rs-1' && !body['forceDownstream']) {
    // rs-1 的子段已入库（演示拒绝场景）；rs-2 可直接冲销
  }
  if (String(body['id']) === 'rs-1') {
    throw ruleError('RS-12', '[RS-12] 倒轴冲销被拒绝：子段已入库/被消耗/已发运，纠正请走逆序冲销')
  }
  found.status = 'reversed'
  return commandOk(found)
})
route('GET', '/rework/pallet-tasks', (_p, ctx) => {
  const taskType = ctx.query['taskType']
  const visible = palletTasks.filter((t) => t.status === 'completed')
  const filtered = taskType ? visible.filter((t) => t.taskType === taskType) : visible
  return pageOf(filtered, ctx.query['page'], ctx.query['pageSize'])
})
route('GET', '/rework/pallet-tasks/:id', (p) => {
  const found = palletTasks.find((t) => t.id === p[0])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '分托/解绑任务不存在', details: {} })
  return {
    ...found,
    items: [
      { id: `${found.id}-i1`, unitNo: 'U-2026-1001-0001', materialCode: 'MAT-CU-8', materialName: '铜单丝 0.8mm', quantity: '600.0000', uom: 'KG', snapshotPalletCode: found.taskType === 'pallet_split' ? 'TP-0090' : 'TP-0083', snapshotWarehouseName: '成品一仓', snapshotRackCode: 'R-01', snapshotLocationCode: '01010002' },
      { id: `${found.id}-i2`, unitNo: 'U-2026-1001-0005', materialCode: 'MAT-AL-6', materialName: '铝单丝 0.6mm', quantity: '300.0000', uom: 'KG', snapshotPalletCode: found.taskType === 'pallet_split' ? 'TP-0090' : 'TP-0083', snapshotWarehouseName: '成品一仓', snapshotRackCode: 'R-01', snapshotLocationCode: '01010003' },
    ],
  }
})
route('POST', '/rework/pallet-task/scan', (_p, ctx) => {
  const body = bodyOf(ctx)
  const code = String(body['code'] ?? '')
  if (code.startsWith('PAL-') || code.includes('REJ')) {
    throw ruleError('RS-16', '[RS-16] 料品码不可装入：命中分托拒绝清单（托码/不在库/已锁定/仓库盘点中等）')
  }
  if (!code) throw ruleError('RS-16', '[RS-16] 料品码不可装入：码不存在')
  const taskType = body['taskType'] as 'pallet_split' | 'pallet_unbind'
  if (taskType === 'pallet_unbind') {
    throw ruleError('RS-22', '[RS-22] 料品码不可解绑：演示码未绑定托盘，请扫已绑托的料品码')
  }
  const result: PalletScanResultDto = {
    task: {
      id: 'pt-live-1', taskType, status: 'in_progress', targetPalletCode: String(body['targetPalletCode'] ?? 'TP-0091'),
      warehouseName: '成品一仓', operatorName: '当前用户', firstScanAt: now, completedAt: null, itemCount: 1,
    },
    scannedCount: 1,
    scanned: { unitNo: code, materialCode: 'MAT-CU-8', materialName: '铜单丝 0.8mm', quantity: '600.0000', uom: 'KG', warehouseName: '成品一仓', locationCode: '01010002' },
  }
  return commandOk(result)
})
route('POST', '/rework/pallet-task/confirm', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (!body['taskId']) throw ruleError('RS-19', '[RS-19] 确认前须满足：已扫码、至少一个料品码、已扫分入托码且仓库未锁定')
  return commandOk({ taskId: body['taskId'], status: 'completed' })
})
route('POST', '/rework/pallet-task/abandon', (_p, ctx) => {
  const body = bodyOf(ctx)
  return commandOk({ taskId: body['taskId'], status: 'abandoned', releasedLocks: 1 })
})
route('GET', '/rework/axis-corrections', (_p, ctx) => pageOf(axisCorrections, ctx.query['page'], ctx.query['pageSize']))
route('GET', '/rework/axis-correction/scan', (_p, ctx) => {
  const unitNo = ctx.query['unitNo'] ?? ''
  if (unitNo.includes('REJ')) {
    throw ruleError('RS-25', '[RS-25] 该码不可修正：命中扫码前置拒绝项（已销售/质检未完成/报工未审核等）')
  }
  if (!unitNo) throw ruleError('RS-25', '[RS-25] 该码不可修正：轴码不存在')
  const view: AxisCorrectionScanDto = {
    unitNo, materialCode: 'MAT-AL-6', materialName: '铝单丝 0.6mm', quantity: '800.0000', uom: 'KG',
    customerAxisNo: 'CAX-318', segmentLength: '300.0000', maxSingleReportQuantity: '400.0000',
    options: [
      { customerAxisNo: 'CAX-418', segmentLength: '300.0000', virtualAxisNo: null, used: false },
      { customerAxisNo: 'CAX-518', segmentLength: '300.0000', virtualAxisNo: 'V-518', used: true, usedByUnitNo: 'U-2026-1002-0009' },
    ],
  }
  return view
})
route('POST', '/rework/axis-correction/submit', (_p, ctx) => {
  const body = bodyOf(ctx)
  const cut = Number(body['cutQuantity'] ?? '0')
  if (!(cut > 0)) throw ruleError('RS-27', '[RS-27] 修正提交校验未通过：截取数量必须大于 0')
  if (cut > 400) throw ruleError('RS-27', '[RS-27] 修正提交校验未通过：截取数量超过单次最大报工数量 400.0000')
  if (body['occupyConfirmed'] !== true && String(body['newCustomerAxisNo'] ?? '') === 'CAX-518') {
    throw ruleError('RS-30', '[RS-30] 该客户轴号已被占用：修改将解绑原轴号，需确认占用并填写理由')
  }
  const record: AxisCorrectionDto = {
    id: `ac-${axisCorrections.length + 1}`, unitNo: String(body['unitNo'] ?? ''), originalCustomerAxisNo: 'CAX-318',
    newCustomerAxisNo: (body['newCustomerAxisNo'] as string) ?? null, originalSegmentLength: '300.0000',
    newSegmentLength: (body['newSegmentLength'] as string) ?? null, originalVirtualAxisNo: null,
    newVirtualAxisNo: (body['newVirtualAxisNo'] as string) ?? null, originalQuantity: '800.0000',
    cutQuantity: cut.toFixed(4), newQuantity: (800 - cut).toFixed(4), uom: 'KG', status: 'completed',
    correctedBy: '当前用户', correctedAt: now,
  }
  axisCorrections.push(record)
  return commandOk(record)
})
route('POST', '/rework/axis-correction/withdraw', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = axisCorrections.find((a) => a.id === body['id'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '修正记录不存在', details: {} })
  if (found.status === 'withdrawn') throw ruleError('RS-32', '[RS-32] 已撤销不可重复回撤')
  if (found.id === 'ac-1') throw ruleError('RS-33', '[RS-33] 回撤被拒绝：截取后的数量或客户轴段已被下游使用')
  found.status = 'withdrawn'
  found.withdrawnBy = '当前用户'
  found.withdrawnAt = now
  return commandOk(found)
})
route('GET', '/rework/axis-retires', (_p, ctx) => pageOf(axisRetires, ctx.query['page'], ctx.query['pageSize']))
route('GET', '/rework/axis-retire/scan', (_p, ctx) => {
  const unitNo = ctx.query['unitNo'] ?? ''
  if (!unitNo) throw ruleError('RS-34', '[RS-34] 该轴码不可清空：轴码不存在')
  if (unitNo.includes('REJ')) {
    throw ruleError('RS-34', '[RS-34] 该轴码不可清空：须质检已完成、报工已审核且未入成品仓在库')
  }
  const view: AxisRetireScanDto = {
    unitNo, materialCode: 'MAT-CU-5', materialName: '铜单丝 0.5mm', quantity: '120.0000', uom: 'KG',
    qualityCompleted: true, reportReviewed: true, inFinishedWarehouse: false,
  }
  return view
})
route('POST', '/rework/axis-retire/execute', (_p, ctx) => {
  const body = bodyOf(ctx)
  const unitNo = String(body['unitNo'] ?? '')
  if (!unitNo) throw ruleError('RS-34', '[RS-34] 该轴码不可清空：轴码不存在')
  if (unitNo.startsWith('AR-') === false && unitNo.startsWith('U-') === false) {
    throw ruleError('RS-36', '[RS-36] 该码已退役：全部库存命令入口显式拒绝，追溯查询可查')
  }
  const record: AxisRetireRecordDto = {
    id: `ar-${axisRetires.length + 1}`, unitNo, quantityBefore: '120.0000', uom: 'KG', productionDeptName: '拉丝车间',
    productionOrderNo: 'MO-2026-1001', salesOrderNo: 'SO-2026-0566', lineNo: '10', materialCode: 'MAT-CU-5',
    materialName: '铜单丝 0.5mm', processName: '拉丝', reportedBy: '王拉丝', reportedAt: now2,
    operatedBy: '当前用户', operatedAt: now,
  }
  axisRetires.push(record)
  return commandOk(record)
})

// ---------------- T16 conversion（路径对齐 landed controller） ----------------

function stripInternal(row: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...row }
  delete rest['_scans']
  delete rest['_uomCode']
  delete rest['_fromName']
  delete rest['_toName']
  return rest
}

route('GET', '/conversion/orders', (_p, ctx) => {
  let rows = orderConversionsLanded
  const statuses = ctx.query['statuses']?.split(',')
  if (statuses) rows = rows.filter((o) => statuses.includes(o.status))
  return pageOf(rows.map((o) => stripInternal(o)), ctx.query['page'], ctx.query['pageSize'])
})
route('GET', '/conversion/orders/:id', (p) => {
  const found = orderConversionsLanded.find((o) => o.conversionId === p[0])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '转换单不存在或不在授权数据范围内', details: {} })
  return {
    ...stripInternal(found),
    lines: orderConversionLines[found.conversionId] ?? [],
    scans: orderConversionScans[found.conversionId] ?? [],
  }
})
route('GET', '/conversion/stock-orders', (_p, ctx) => pageOf(stockConversionsLanded, ctx.query['page'], ctx.query['pageSize']))
route('GET', '/conversion/stock-orders/:id', (p) => {
  const found = stockConversionsLanded.find((o) => o.conversionId === p[0])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '库存转换单不存在或不在授权数据范围内', details: {} })
  return { ...found, lines: stockConversionLines[found.conversionId] ?? [], rewrites: found.conversionId === 'cvs-ord-3' ? codeRewrites : [] }
})
route('GET', '/conversion/stock/candidates', (_p, ctx) => {
  const materialCode = ctx.query['materialCode']
  const rows = materialCode ? stockCandidates.filter((c) => c.materialCode === materialCode) : stockCandidates
  return rows
})
route('POST', '/conversion/order/create', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (!Array.isArray(body['lines']) || (body['lines'] as unknown[]).length === 0) {
    throw ruleError('FC-05', '[FC-05] 明细仅可选生产订单行且至少一条；同一"销售单号+行号"不可重复加入')
  }
  const lines = body['lines'] as Array<{ sourceSalesOrderNo?: string; sourceLineNo?: string }>
  const keys = new Set<string>()
  for (const l of lines) {
    const key = `${l.sourceSalesOrderNo ?? ''}+${l.sourceLineNo ?? ''}`
    if (keys.has(key)) throw ruleError('FC-05', '[FC-05] 同一"销售单号+行号"不可重复加入')
    keys.add(key)
  }
  return commandOk({ conversionId: `cv-${orderConversionsLanded.length + 1}`, conversionNo: `CV-20261028-${String(orderConversionsLanded.length + 1).padStart(4, '0')}` })
})
route('POST', '/conversion/order/update', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = orderConversionsLanded.find((o) => o.conversionId === body['conversionOrderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '转换单不存在', details: {} })
  if ((found._scans as unknown[]).length > 0) {
    throw ruleError('FC-06', '[FC-06] 仅"待转换且尚无任何扫码"的转换单可编辑或删除')
  }
  return commandOk(found.conversionId)
})
route('POST', '/conversion/order/delete', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = orderConversionsLanded.find((o) => o.conversionId === body['conversionOrderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '转换单不存在', details: {} })
  if ((found._scans as unknown[]).length > 0) {
    throw ruleError('FC-06', '[FC-06] 仅"待转换且尚无任何扫码"的转换单可编辑或删除')
  }
  return commandOk(found.conversionId)
})
route('POST', '/conversion/order/scan', (_p, ctx) => {
  const body = bodyOf(ctx)
  const code = String(body['code'] ?? '')
  if (code === 'CV-FULL-01' || code === 'CV-FULL-02') {
    throw ruleError('FC-07', '[FC-07] 扫码须为载具码且属于转换前订单对应库存；已用段长/客户轴号不可再选')
  }
  if (!code) throw ruleError('FC-07', '[FC-07] 扫码失败：码值为空')
  const scan = {
    scanId: `cvs-${Date.now()}`, lineId: String(body['lineId'] ?? 'cvl-1'), unitNo: code, inventoryUnitId: 'iu-new',
    segmentLength: '400.0000', customerAxisNo: null, quantity: '400.0000', reservationId: 'rsv-new',
    scannedBy: '当前用户', scannedAt: now, deleted: false, deletedBy: null, deletedAt: null,
  }
  return commandOk(scan)
})
route('POST', '/conversion/order/scan-delete', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (!body['scanId']) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '扫码记录不存在', details: {} })
  return commandOk(body['scanId'])
})
route('POST', '/conversion/order/complete', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = orderConversionsLanded.find((o) => o.conversionId === body['conversionOrderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '转换单不存在', details: {} })
  const lines = orderConversionLines[found.conversionId] ?? []
  if (lines.some((l) => Number(l.scannedAxes) <= 0)) {
    throw ruleError('FC-08', '[FC-08] 完成转换须每条明细已扫轴数大于 0')
  }
  return commandOk(found.conversionId)
})
route('POST', '/conversion/order/sync-retry', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = orderConversionsLanded.find((o) => o.conversionId === body['conversionOrderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '转换单不存在', details: {} })
  if (!(found.status === 'completed' && found.syncStatus === 'sync_failed')) {
    throw ruleError('FC-09', '[FC-09] 仅"已完成且同步失败"可重试；重试按完成转换时点快照重推')
  }
  return commandOk(found.conversionId)
})
route('POST', '/conversion/stock/create', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (!Array.isArray(body['lines']) || (body['lines'] as unknown[]).length === 0) {
    throw ruleError('FC-18', '[FC-18] 右侧至少 1 条明细；销售单号/行号/批次号必填，每行段长必填')
  }
  const lines = body['lines'] as Array<{ segmentLength?: string }>
  if (lines.some((l) => !l.segmentLength || Number(l.segmentLength) < 0.0001)) {
    throw ruleError('FC-18', '[FC-18] 每行段长必填（最小 0.0001）')
  }
  return commandOk({ conversionId: `cvs-ord-${stockConversionsLanded.length + 1}`, conversionNo: `CVS-20261028-${String(stockConversionsLanded.length + 1).padStart(4, '0')}` })
})
route('POST', '/conversion/stock/reconvert', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = stockConversionsLanded.find((o) => o.conversionId === body['conversionStockOrderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '库存转换单不存在', details: {} })
  if (!(found.displayStatus === 'convert_failed' && !found.u9Success)) {
    throw ruleError('FC-15', '[FC-15] 重新转换仅限转换失败单（U9 未成功）')
  }
  return commandOk(found.conversionId)
})
route('POST', '/conversion/stock/resync', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = stockConversionsLanded.find((o) => o.conversionId === body['conversionStockOrderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '库存转换单不存在', details: {} })
  if (!(found.displayStatus === 'sync_failed' && found.u9Success)) {
    throw ruleError('FC-15', '[FC-15] 重新同步仅限同步失败且 U9 已成功单（只做本地，不再推 U9）')
  }
  return commandOk(found.conversionId)
})

// ---------------- T17 reverse（路径对齐 landed controller） ----------------

route('GET', '/reverse/move-records', (_p, ctx) => {
  const rows = stockMoveRecords
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('GET', '/reverse/move-records/:id', (p) => {
  const found = stockMoveRecords.find((r) => r.recordId === p[0])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '移库记录不存在或不在授权数据范围内', details: {} })
  return { ...found, lines: stockMoveLines[found.recordId] ?? [] }
})
route('GET', '/reverse/move/scan-info', (_p, ctx) => {
  const unitNo = ctx.query['unitNo'] ?? ''
  if (!unitNo) throw ruleError('WR-02', '[WR-02] 移库校验未通过：码在库且不重复；缺少 unitNo')
  if (unitNo.includes('LOCKED')) throw ruleError('WR-02', '[WR-02] 移库校验未通过：该码已锁定')
  if (/NOT?STOCK/.test(unitNo)) throw ruleError('WR-02', '[WR-02] 移库校验未通过：该码不在库')
  if (unitNo.startsWith('TP-')) throw ruleError('WR-02', '[WR-02] 托下单码（整托）不可单码移库，请走整托调拨')
  return {
    unitNo, materialCode: 'MAT-CU-8', materialName: '铜单丝 0.8mm', quantity: '600.0000', uomCode: 'KG',
    fromLocationCode: '01010001', warehouseCode: 'WH-F01', warehouseName: '成品一仓', inStock: true, locked: false,
  }
})
route('GET', '/reverse/move/target-warehouses', () => [
  { warehouseId: 'wh-1', warehouseCode: 'WH-F01', warehouseName: '成品一仓', kind: 'WAREHOUSE', locations: [
    { locationId: 'loc-11', locationCode: '01010001' }, { locationId: 'loc-13', locationCode: '01010009' },
  ] },
])
route('POST', '/reverse/move/submit', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (!Array.isArray(body['stagedUnitNos']) || (body['stagedUnitNos'] as string[]).length === 0) {
    throw ruleError('WR-02', '[WR-02] 移库提交校验未通过：至少一个已扫码')
  }
  return commandOk({ moveNo: `MV-20261028-${String(stockMoveRecords.length + 1).padStart(4, '0')}`, movedCount: (body['stagedUnitNos'] as string[]).length })
})
route('GET', '/reverse/transfer-outbound', (_p, ctx) => {
  const rows = transferOutboundLanded.filter((o) => o.visibleOnWeb)
  const statuses = ctx.query['statuses']?.split(',')
  const filtered = statuses ? rows.filter((o) => statuses.includes(o.status)) : rows
  return pageOf(filtered.map((o) => ({ ...stripInternal(o), uomCode: o._uomCode, fromWarehouseName: o._fromName, toWarehouseName: o._toName })), ctx.query['page'], ctx.query['pageSize'])
})
route('GET', '/reverse/transfer-outbound/:id', (p) => {
  const found = transferOutboundLanded.find((o) => o.orderId === p[0])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨出库单不存在或不在授权数据范围内', details: {} })
  return { ...stripInternal(found), uomCode: found._uomCode, fromWarehouseName: found._fromName, toWarehouseName: found._toName, scans: transferOutboundScans[found.orderId] ?? [] }
})
route('POST', '/reverse/transfer-outbound', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (body['toWarehouseId'] === body['fromWarehouseId']) {
    throw ruleError('WR-06', '[WR-06] 调入仓库不得等于调出仓库')
  }
  if (!Array.isArray(body['lines']) || (body['lines'] as unknown[]).length === 0) {
    throw ruleError('WR-07', '[WR-07] 有任务调拨出库须至少一条明细（料品+计划调出数量）')
  }
  return commandOk({ orderId: `to-${transferOutboundLanded.length + 1}`, orderNo: `TO-20261028-${String(transferOutboundLanded.length + 1).padStart(4, '0')}` })
})
route('POST', '/reverse/transfer-outbound/update', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = transferOutboundLanded.find((o) => o.orderId === body['orderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨单不存在', details: {} })
  if (found.scannedCount > 0) throw ruleError('WR-08', '[WR-08] 仅"待出库且未扫过码"的调拨单可编辑或删除')
  return commandOk(found.orderId)
})
route('POST', '/reverse/transfer-outbound/delete', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = transferOutboundLanded.find((o) => o.orderId === body['orderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨单不存在', details: {} })
  if (found.scannedCount > 0) throw ruleError('WR-08', '[WR-08] 仅"待出库且未扫过码"的调拨单可编辑或删除')
  return commandOk(found.orderId)
})
route('POST', '/reverse/transfer-outbound/scan', (_p, ctx) => {
  const body = bodyOf(ctx)
  const unitNo = String(body['unitNo'] ?? '')
  if (unitNo.includes('NOTSTOCK')) throw ruleError('WR-09', '[WR-09] 码不可装入：不在库')
  if (unitNo.includes('LOCKED')) throw ruleError('WR-09', '[WR-09] 码不可装入：已锁定或仓库被盘点锁定')
  if (unitNo.startsWith('TP-')) throw ruleError('WR-09', '[WR-09] 码不可装入：托码不是料品码')
  if (!unitNo) throw ruleError('WR-09', '[WR-09] 码不可装入：码值为空')
  return commandOk({ scanId: `tos-${Date.now()}`, unitNo, quantity: '400.0000', outQty: '400.0000' })
})
route('POST', '/reverse/transfer-outbound/complete', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = transferOutboundLanded.find((o) => o.orderId === body['orderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨单不存在', details: {} })
  if (found.scannedCount === 0 && String(body['orderId']) === 'to-1') {
    throw ruleError('WR-11', '[WR-11] 完成出库须至少扫过一码且调出/调入仓库未锁定')
  }
  return commandOk(found.orderId)
})
route('GET', '/reverse/transfer-inbound', (_p, ctx) => pageOf(transferInboundLanded, ctx.query['page'], ctx.query['pageSize']))
route('POST', '/reverse/transfer-inbound/scan-putaway', (_p, ctx) => {
  const body = bodyOf(ctx)
  const unitNo = String(body['unitNo'] ?? '')
  const orderId = String(body['orderId'] ?? '')
  const order = transferInboundLanded.find((o) => o.orderId === orderId)
  if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨入库单不存在', details: {} })
  if (!body['locationCode'] && order.toWarehouseId === 'wh-1') {
    throw ruleError('WR-15', '[WR-15] 调入仓库为仓库时须选库位（库位编码或"货架编码+两位层数"）')
  }
  if (unitNo.startsWith('TP-') && !body['palletCode']) {
    throw ruleError('WR-15', '[WR-15] 托下单码须扫托（先扫托码再扫码）')
  }
  return commandOk({ unitNo, lineStatus: 'inbound', locationCode: body['locationCode'] ?? 'L01001' })
})
route('POST', '/reverse/transfer-inbound/complete', (_p, ctx) => {
  const body = bodyOf(ctx)
  const order = transferInboundLanded.find((o) => o.orderId === body['orderId'])
  if (!order) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '调拨入库单不存在', details: {} })
  if (order.orderId === 'ti-1' && order.inboundLines.some((l) => l.lineStatus === 'pending')) {
    throw ruleError('WR-17', '[WR-17] 完成入库须每料品已入库数量≥待入库数量且至少一码已入库')
  }
  return commandOk(order.orderId)
})
route('GET', '/reverse/stocktakes', (_p, ctx) => {
  const rows = stocktakeOrders.map((s) => ({ ...s, statusLabel: s.status === 'counting' ? '盘点中' : s.status === 'completed' ? '已关闭' : '已取消' }))
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('POST', '/reverse/stocktake/open', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (!body['warehouseId']) throw ruleError('WR-24', '[WR-24] 盘点开启须指定仓库；盘点期间仓库锁定')
  return commandOk({ orderId: `st-${stocktakeOrders.length + 1}`, orderNo: `SD-20261028-${String(stocktakeOrders.length + 1).padStart(4, '0')}`, locked: true })
})
route('POST', '/reverse/stocktake/record-count', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (!body['orderId'] || body['countedQuantity'] === undefined) {
    throw ruleError('WR-24', '[WR-24] 盘点记录须带单号与实盘数量')
  }
  return commandOk({ orderId: body['orderId'], recorded: true })
})
route('POST', '/reverse/stocktake/close', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = stocktakeOrders.find((s) => s.orderId === body['orderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '盘点单不存在', details: {} })
  if (found.status !== 'counting') throw ruleError('WR-24', '[WR-24] 仅盘点中的单可关闭；关闭即解锁仓库')
  found.status = 'completed'
  found.locked = false
  found.closedAt = now
  found.closedBy = '当前用户'
  return commandOk(found.orderId)
})
route('GET', '/reverse/stock-adjustments', (_p, ctx) => pageOf(stockAdjustments, ctx.query['page'], ctx.query['pageSize']))
route('POST', '/reverse/stock-adjustment/execute', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (!body['reason']) throw ruleError('WR-24', '[WR-24] 差异必须走调整单：原因必填＋去向')
  if (!body['destination']) throw ruleError('WR-24', '[WR-24] 差异必须走调整单：去向必填')
  if (!Array.isArray(body['lines']) || (body['lines'] as unknown[]).length === 0) {
    throw ruleError('WR-24', '[WR-24] 调整单至少一行（码+实盘数量）')
  }
  return commandOk({ adjustmentNo: `AD-20261028-${String(stockAdjustments.length + 1).padStart(4, '0')}` })
})
route('GET', '/reverse/receipt-corrections', (_p, ctx) => {
  const rows = receiptCorrections.map((c) => ({ ...c, correctionKindLabel: c.correctionKind === 'return' ? '退货' : '作废' }))
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('GET', '/reverse/receipt/receive-lines', (_p, ctx) => {
  const batchNo = ctx.query['batchNo']
  const rows = batchNo ? receiptBatchViews.filter((b) => b.batchNo === batchNo) : receiptBatchViews
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('POST', '/reverse/receipt/modify', (_p, ctx) => {
  const body = bodyOf(ctx)
  const view = receiptBatchViews.find((b) => b.batchNo === body['batchNo'])
  if (!view) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '采购批次不存在', details: {} })
  if (!view.canModify) {
    throw ruleError('WR-19', '[WR-19] 批次修改仅限质检状态待质检或全部不合格、且合格同步状态非已同步')
  }
  return commandOk(view.batchNo)
})
route('POST', '/reverse/receipt/return', (_p, ctx) => {
  const body = bodyOf(ctx)
  const view = receiptBatchViews.find((b) => b.batchNo === body['batchNo'])
  if (!view) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '采购批次不存在', details: {} })
  if (!view.canReturn) {
    if (view.returned) throw ruleError('WR-20', '[WR-20] 退货仅限全部不合格且未退货')
    throw ruleError('WR-22', '[WR-22] 该批次已被下游使用：拦截，请走逆序冲销或隔离追溯处置')
  }
  if (!body['remark'] || String(body['remark']).trim() === '') {
    throw ruleError('WR-20', '[WR-20] 退货备注必填（≤200）、附件≤3')
  }
  view.returned = true
  return commandOk(view.batchNo)
})
route('POST', '/reverse/receipt/void', (_p, ctx) => {
  const body = bodyOf(ctx)
  const view = receiptBatchViews.find((b) => b.batchNo === body['batchNo'])
  if (!view) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '采购批次不存在', details: {} })
  if (!view.canVoid) {
    throw ruleError('WR-21', '[WR-21] 作废仅限待质检或全部不合格且合格同步未同步（免检不可普通删除）')
  }
  if (!body['reason']) throw ruleError('WR-21', '[WR-21] 作废原因必填')
  view.voided = true
  return commandOk(view.batchNo)
})
route('POST', '/reverse/receipt/return-sync/retry', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = receiptCorrections.find((c) => c.correctionId === body['correctionId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '纠正单不存在', details: {} })
  if (found.returnSyncStatus !== 'failed') {
    throw ruleError('WR-23', '[WR-23] 退货回传重试仅限回传失败状态')
  }
  found.returnSyncStatus = 'synced'
  return commandOk(found.correctionId)
})
route('GET', '/reverse/carrier-loans', (_p, ctx) => {
  const rows = carrierLoans.map((l) => ({ ...l, eventKindLabel: l.eventKind === 'lend' ? '借出' : '回收' }))
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('POST', '/reverse/carrier/loan', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (!body['carrierCode']) throw ruleError('WR-27', '[WR-27] 载具借还登记须指定载具码与事件类型')
  return commandOk({ loanId: `cl-${carrierLoans.length + 1}`, carrierCode: body['carrierCode'], eventKind: body['eventKind'] })
})
route('GET', '/reverse/ownership-balances', (_p, ctx) => pageOf(ownershipBalances, ctx.query['page'], ctx.query['pageSize']))

// ---------------- T18 quality-disposition ----------------

route('GET', '/disposition/suspects', (_p, ctx) => {
  const status = ctx.query['status']
  const rows = status ? suspectRecords.filter((s) => s.status === status) : suspectRecords
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('POST', '/disposition/suspect/register', (_p, ctx) => {
  const body = bodyOf(ctx)
  const unitNo = String(body['unitNo'] ?? '')
  if (unitNo.startsWith('TP-') || unitNo.includes('REJ')) {
    throw ruleError('QD-01', '[QD-01] 该码不可标记存疑：须关联料品、已入库、有库位且未存疑（托码拒绝）')
  }
  if (!unitNo) throw ruleError('QD-01', '[QD-01] 该码不可标记存疑：码不存在')
  const record: P2SuspectRecordDto = {
    id: `sp-${suspectRecords.length + 1}`, unitNo, materialCode: 'MAT-AL-6', materialName: '铝单丝 0.6mm',
    status: 'suspect', productionDeptName: '绞制车间', raisedBy: '当前用户', raisedAt: now, dispositions: [],
  }
  suspectRecords.push(record)
  return commandOk(record)
})
route('POST', '/disposition/suspect/restore', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = suspectRecords.find((s) => s.id === body['suspectId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '存疑记录不存在', details: {} })
  if (!body['basis'] || String(body['basis']).trim() === '') {
    throw ruleError('QD-03', '[QD-03] 恢复须填写处置依据：恢复落库为处置记录，不覆盖原存疑记录')
  }
  found.status = 'restored'
  found.dispositions = [...found.dispositions, { id: `dsp-${Date.now()}`, conclusion: 'restored' as const, operatorName: '当前用户', operatedAt: now, basis: String(body['basis']) }]
  return commandOk(found)
})
route('GET', '/disposition/finished-defects', (_p, ctx) => {
  const reviewStatus = ctx.query['reviewStatus']
  const rows = reviewStatus ? finishedDefects.filter((d) => d.reviewStatus === reviewStatus) : finishedDefects
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('POST', '/disposition/finished-defect/create', (_p, ctx) => {
  const body = bodyOf(ctx)
  const quantity = Number(body['quantity'] ?? '0')
  if (!body['unitNo'] || !body['defectType'] || !(quantity > 0)) {
    throw ruleError('QD-06', '[QD-06] 成品异常提交校验未通过：轴号/料品/不合格类型/数量（>0）必填')
  }
  if (quantity > 500) {
    throw ruleError('QD-06', '[QD-06] 数量不得超过该料品总数 500.0000，最多 4 位小数')
  }
  const record: FinishedDefectDto = {
    id: `fd-${finishedDefects.length + 1}`, unitNo: String(body['unitNo']), materialCode: 'MAT-CU-8',
    materialName: '铜单丝 0.8mm', defectType: body['defectType'] as 'rework' | 'scrap',
    quantity: quantity.toFixed(4), uom: 'KG', reviewStatus: 'unreviewed', destination: null, destinationNote: null,
    productionDeptName: '拉丝车间', raisedBy: '当前用户', raisedAt: now, reviewedBy: null, reviewedAt: null,
  }
  finishedDefects.push(record)
  return commandOk(record)
})
route('POST', '/disposition/finished-defect/review', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = finishedDefects.find((d) => d.id === body['id'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '成品异常记录不存在', details: {} })
  if (found.reviewStatus !== 'unreviewed') {
    throw ruleError('QD-07', '[QD-07] 审核仅限未审核记录；审核结果必传')
  }
  if (body['approved'] === true && !body['destination']) {
    throw ruleError('QD-08', '[QD-08] 审核通过扣数必须记录去向（报废/返工/其它＋说明），禁止无去向扣数')
  }
  found.reviewStatus = body['approved'] === true ? 'approved' : 'rejected'
  found.reviewedBy = '当前用户'
  found.reviewedAt = now
  if (body['approved'] === true) {
    found.destination = body['destination'] as 'scrap' | 'rework' | 'other'
    found.destinationNote = (body['destinationNote'] as string) ?? null
  }
  return commandOk(found)
})
route('GET', '/disposition/iqc/batch', (_p, ctx) => {
  const batchNo = ctx.query['batchNo']
  const found = iqcBatches.find((b) => b.batchNo === batchNo)
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '采购批次不存在或不在授权数据范围内', details: {} })
  return found
})
route('POST', '/disposition/iqc/batch-write', (_p, ctx) => {
  const body = bodyOf(ctx)
  const batch = iqcBatches.find((b) => b.batchNo === body['batchNo'])
  if (!batch) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '批次不存在', details: {} })
  if (batch.returned) throw ruleError('QD-17', '[QD-17] 已退货批次不可再质检、判定')
  const results = (body['codeResults'] as Array<{ code: string }>) ?? []
  const stillPending = results.filter((r) => batch.codes.some((c) => c.code === r.code && c.currentConclusion === 'pending_inspection'))
  if (stillPending.length < results.length) {
    throw ruleError('QD-11', '[QD-11] 批次质检写入仅对当前生效质检行仍为待质检的码')
  }
  return commandOk({ written: results.length })
})
route('POST', '/disposition/iqc/judge', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (!body['remark'] || String(body['remark']).trim() === '') {
    throw ruleError('QD-13', '[QD-13] 判定备注必填（≤200 非纯空白）')
  }
  return commandOk({ batchNo: body['batchNo'], judged: true })
})
route('POST', '/disposition/iqc/recheck', (_p, ctx) => {
  const body = bodyOf(ctx)
  const batch = iqcBatches.find((b) => b.batchNo === body['batchNo'])
  if (!batch) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '批次不存在', details: {} })
  const already = batch.codes.some((c) => c.rechecked)
  if (already) throw ruleError('QD-14', '[QD-14] 复检仅一次：已有复检记录的码不可再次发起')
  // 复检开启后非免检码全部标记已复检（再次发起即拒绝，QD-14）
  for (const c of batch.codes) if (c.currentConclusion !== 'exempt') c.rechecked = true
  return commandOk({ batchNo: batch.batchNo, recheckOpened: true })
})
route('POST', '/disposition/iqc/code-conclusion', (_p, ctx) => {
  const body = bodyOf(ctx)
  const batch = iqcBatches.find((b) => b.batchNo === body['batchNo'])
  if (!batch) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '批次不存在', details: {} })
  const code = batch.codes.find((c) => c.code === body['code'])
  if (!code) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '码不存在于该批次', details: {} })
  if (code.currentConclusion === 'exempt') {
    throw ruleError('QD-12', '[QD-12] 免检码不可提交结论')
  }
  if (code.rechecked && body['scope'] === 'first') {
    throw ruleError('QD-12', '[QD-12] 已有复检记录须操作复检行（首检不可再改）')
  }
  code.currentConclusion = body['conclusion'] as 'qualified' | 'unqualified'
  code.versionCount += 1
  if (body['scope'] === 'recheck') code.rechecked = true
  batch.versions = [...batch.versions, {
    id: `iv-${Date.now()}`, batchNo: batch.batchNo, code: code.code, version: code.versionCount,
    scope: body['scope'] as 'first' | 'recheck', conclusion: body['conclusion'] as 'qualified' | 'unqualified',
    remark: 'PDA 提交（演示）', attachmentCount: Number(body['attachmentCount'] ?? 0), createdBy: '当前用户',
    createdAt: now, current: true,
  }]
  return commandOk(code)
})
route('GET', '/disposition/records', (_p, ctx) => {
  const kind = ctx.query['kind']
  const rows = kind ? dispositionRecords.filter((d) => d.kind === kind) : dispositionRecords
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('POST', '/disposition/record/create', (_p, ctx) => {
  const body = bodyOf(ctx)
  if ((body['kind'] === 'release' || body['kind'] === 'scrap') && !body['basis']) {
    throw ruleError('QD-20', '[QD-20] 放行与报废须强制理由＋审计')
  }
  const record: DispositionRecordDto = {
    id: `dp-${dispositionRecords.length + 1}`, kind: body['kind'] as DispositionRecordDto['kind'],
    targetKind: body['targetKind'] as DispositionRecordDto['targetKind'], targetRef: String(body['targetRef'] ?? ''),
    basis: String(body['basis'] ?? ''), reason: (body['reason'] as string) ?? null, decidedBy: '当前用户', decidedAt: now,
    concessionScope: (body['concessionScope'] as string) ?? null, relatedReworkTaskId: null,
  }
  dispositionRecords.push(record)
  return commandOk(record)
})
route('GET', '/disposition/rework-tasks', (_p, ctx) => {
  const status = ctx.query['status']
  const rows = status ? reworkTasks.filter((t) => t.status === status) : reworkTasks
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})

// ---------------- T19 maintenance ----------------

route('GET', '/maintenance/orders', (_p, ctx) => {
  const status = ctx.query['status']
  const rows = status ? maintenanceOrders.filter((o) => o.status === status) : maintenanceOrders
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('GET', '/maintenance/orders/:id', (p) => {
  const found = maintenanceOrders.find((o) => o.id === p[0])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '维修工单不存在或不在授权数据范围内', details: {} })
  return found
})
route('POST', '/maintenance/order/create', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (!body['equipmentId'] || !body['description']) {
    throw ruleError('MT-13', '[MT-13] 工单创建须指定设备并填写故障描述')
  }
  const order: MaintenanceOrderDto = {
    id: `mo-${maintenanceOrders.length + 1}`, orderNo: `MX-20261028-${String(maintenanceOrders.length + 1).padStart(4, '0')}`,
    equipmentId: String(body['equipmentId']), equipmentCode: 'EQ-DRAW-01', equipmentName: '拉丝一线主机',
    status: 'reported', description: String(body['description']), reportedBy: '当前用户', reportedAt: now,
    source: 'WEB', assigneeName: null, assignedBy: null, result: null, responsibleName: null, cancelReason: null,
    downtimeStartAt: null, downtimeEndAt: null, spareParts: [], recoverable: false, cancellable: true,
  }
  maintenanceOrders.push(order)
  return commandOk(order)
})
route('POST', '/maintenance/order/assign', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = maintenanceOrders.find((o) => o.id === body['orderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '工单不存在', details: {} })
  if (found.status !== 'reported') throw ruleError('MT-07', '[MT-07] 工单状态机：仅"已报修"可分派；越级/逆向迁移拒绝')
  found.status = 'assigned'
  found.assigneeName = String(body['assigneeName'] ?? '')
  found.assignedBy = '当前用户'
  found.cancellable = true
  return commandOk(found)
})
route('POST', '/maintenance/order/recover', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = maintenanceOrders.find((o) => o.id === body['orderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '工单不存在', details: {} })
  if (found.status !== 'awaiting_recovery') {
    throw ruleError('MT-10', '[MT-10] 复机仅"待复机"状态可执行：工单关闭＋置正常＋闭停机事件一次事务完成')
  }
  if (!body['result'] || !body['responsibleName']) {
    throw ruleError('MT-07', '[MT-07] 关闭必须记录结果与责任人')
  }
  found.status = 'closed'
  found.result = String(body['result'])
  found.responsibleName = String(body['responsibleName'])
  found.downtimeEndAt = now
  found.recoverable = false
  found.spareParts = (body['spareParts'] as MaintenanceOrderDto['spareParts']) ?? []
  return commandOk(found)
})
route('POST', '/maintenance/order/cancel', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = maintenanceOrders.find((o) => o.id === body['orderId'])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '工单不存在', details: {} })
  if (!found.cancellable) {
    throw ruleError('MT-14', '[MT-14] 待复机/已关闭不可取消；停机事实保留')
  }
  if (!body['reason']) throw ruleError('MT-14', '[MT-14] 取消原因必填')
  found.status = 'cancelled'
  found.cancelReason = String(body['reason'])
  found.cancellable = false
  return commandOk(found)
})
route('GET', '/maintenance/plans', (_p, ctx) => {
  const kind = ctx.query['kind']
  const rows = kind ? maintenancePlans.filter((p) => p.kind === kind) : maintenancePlans
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('GET', '/maintenance/plans/:id', (p) => {
  const found = maintenancePlans.find((m) => m.id === p[0])
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '计划不存在', details: {} })
  return { ...found, rounds: inspectionRounds.filter((r) => r.planId === found.id) }
})
route('POST', '/maintenance/inspection-round/submit', (_p, ctx) => {
  const body = bodyOf(ctx)
  if (!body['planId']) throw ruleError('MT-12', '[MT-12] 点检/保养执行引用计划版本快照')
  if (body['passed'] === false && !body['failedNote']) {
    throw ruleError('MT-12', '[MT-12] 不通过时须填写失败说明；超期仅提示不自动阻断生产')
  }
  const round: InspectionRoundDto = {
    id: `ir-${Date.now()}`, roundNo: `IR-20261028-${String(inspectionRounds.length + 1).padStart(4, '0')}`,
    planId: String(body['planId']), planVersion: 3, equipmentCode: 'EQ-DRAW-01',
    passed: body['passed'] === true, failedNote: (body['failedNote'] as string) ?? null, actualAt: now,
    businessShiftDate: '2026-10-28', shiftName: '白班', operatorName: '当前用户',
    items: ((body['items'] as InspectionRoundDto['items']) ?? []).map((it, i) => ({
      itemNo: it.itemNo, itemName: `检查项 ${i + 1}`, result: it.result, value: it.value,
    })),
  }
  inspectionRounds.push(round)
  return commandOk(round)
})
route('GET', '/maintenance/equipment-scan', (_p, ctx) => {
  const raw = ctx.query['code'] ?? ''
  // MT-04：EQU- 前缀剥离后按设备编码匹配（识别宽容）
  const code = raw.startsWith('EQU-') ? raw.slice(4) : raw
  const found = equipmentStates.get(code)
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '设备不存在（MT-04：EQU- 前缀剥离后按设备编码匹配）', details: {} })
  return found
})
route('POST', '/maintenance/equipment/status-change', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = equipmentStates.get(String(body['equipmentId'] === 'eq-draw-01' ? 'EQ-DRAW-01' : body['equipmentId'] === 'eq-extrude-01' ? 'EQ-EXTR-01' : body['equipmentId']))
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '设备不存在', details: {} })
  const target = Number(body['status'])
  if (target !== 1 && target !== 2) throw ruleError('MT-01', '[MT-01] 设备状态仅支持：1=正常、2=维修')
  if (found.status === target) throw ruleError('MT-03', '[MT-03] 状态相同不产生流水')
  found.status = target as 1 | 2
  return commandOk(found)
})
route('POST', '/maintenance/equipment/start', (_p, ctx) => {
  const body = bodyOf(ctx)
  const found = equipmentStates.get(String(body['equipmentId'] === 'eq-draw-01' ? 'EQ-DRAW-01' : body['equipmentId'] === 'eq-extrude-01' ? 'EQ-EXTR-01' : body['equipmentId']))
  if (!found) throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '设备不存在', details: {} })
  if (found.status !== 1) throw ruleError('MT-05', '[MT-05] 开工仅限状态=正常的设备')
  // MT-06：当日重复开工更新开工时间（幂等）
  found.startedWorkTodayAt = now
  return commandOk({ equipmentId: found.equipmentId, startedWorkTodayAt: found.startedWorkTodayAt, idempotent: true })
})

// ---------------- T20 reporting（路径对齐 landed controller） ----------------

route('GET', '/reporting/stock-stats', (_p, ctx) => {
  const finishedEntryStatus = ctx.query['finishedEntryStatus']
  if (finishedEntryStatus !== undefined && finishedEntryStatus !== 'entered_warehouse' && finishedEntryStatus !== 'not_entered') {
    throw ruleError('RP-04', '[RP-04] finishedEntryStatus 仅支持 entered_warehouse / not_entered')
  }
  let rows = stockStatRows
  if (finishedEntryStatus) rows = rows.filter((r) => r.finishedEntryStatus === finishedEntryStatus)
  const unitNoLike = ctx.query['unitNoLike']
  if (unitNoLike) rows = rows.filter((r) => r.unitNo.includes(unitNoLike))
  if (ctx.query['export'] === '1') {
    return { ...pageOf(rows, '1', '1000'), exportRows: rows.length }
  }
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('POST', '/reporting/stock-stats/summary', (_p, ctx) => {
  const body = bodyOf(ctx)
  const ids = Array.isArray(body['ids']) ? (body['ids'] as string[]) : []
  const rows = ids.length > 0 ? stockStatRows.filter((r) => ids.includes(r.statId)) : []
  const byUom = new Map<string, number>()
  for (const r of rows) byUom.set(r.uomCode, (byUom.get(r.uomCode) ?? 0) + Number(r.quantity))
  return {
    groups: [...byUom.entries()].map(([uomCode, total]) => ({ uomCode, uomLabel: uomCode, totalQuantity: total.toFixed(4) })),
    totalRows: rows.length,
  }
})
route('GET', '/reporting/axis-query', (_p, ctx) => {
  if (ctx.query['reportStatus'] === 'not_applicable') {
    throw ruleError('RP-09', '[RP-09] 报工状态筛选不含采购来源轴（`-` 不可作为筛选值）')
  }
  let rows = axisQueryRows
  const unitNoLike = ctx.query['unitNoLike']
  if (unitNoLike) rows = rows.filter((r) => r.unitNo.includes(unitNoLike))
  const inboundStatus = ctx.query['inboundStatus']
  if (inboundStatus) rows = rows.filter((r) => r.inboundStatus === inboundStatus)
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('GET', '/reporting/report-summary/by-caliber', () => ({
  calibers: [
    { caliber: 'draft', groups: [{ uomCode: 'KG', totalQuantity: '3000.0000' }], axisCount: 12 },
    { caliber: 'submitted', groups: [{ uomCode: 'KG', totalQuantity: '2800.0000' }], axisCount: 11 },
    { caliber: 'approved', groups: [{ uomCode: 'KG', totalQuantity: '2500.0000' }], axisCount: 10 },
    { caliber: 'qualified', groups: [{ uomCode: 'KG', totalQuantity: '2300.0000' }], axisCount: 9 },
    { caliber: 'stocked', groups: [{ uomCode: 'KG', totalQuantity: '1800.0000' }], axisCount: 7 },
  ],
}))
route('POST', '/reporting/report-summary/selection', (_p, ctx) => {
  const body = bodyOf(ctx)
  const ids = Array.isArray(body['ids']) ? (body['ids'] as string[]).length : 0
  if (ids === 0) {
    return { caliber: 'approved', groups: [{ uomCode: 'KG', totalQuantity: '0.0000' }], axisCount: 0, feetGroups: null }
  }
  return {
    caliber: 'approved',
    groups: [{ uomCode: 'KG', totalQuantity: (ids * 100).toFixed(4) }],
    axisCount: ids,
    feetGroups: [{ uomCode: 'KG', feetQuantity: (ids * 328.084).toFixed(4) }],
  }
})
route('GET', '/reporting/pda/cumulative', (_p, ctx) => {
  const operatorOnly = ctx.query['operatorOnly'] === '1' || ctx.query['operatorOnly'] === 'true'
  return {
    calibers: [
      { caliber: 'draft' as const, groups: [{ uomCode: 'KG', totalQuantity: operatorOnly ? '420.0000' : '1200.0000' }], excludedHistoricalRows: 8 },
      { caliber: 'submitted' as const, groups: [{ uomCode: 'KG', totalQuantity: operatorOnly ? '400.0000' : '1000.0000' }], excludedHistoricalRows: 8 },
      { caliber: 'approved' as const, groups: [{ uomCode: 'KG', totalQuantity: operatorOnly ? '380.0000' : '900.0000' }], excludedHistoricalRows: 8 },
    ],
    operatorOnly,
  }
})
route('GET', '/reporting/metrics/definitions', () => metricDefinitions)
route('GET', '/reporting/shift-snapshots', (_p, ctx) => {
  let rows = shiftSnapshots
  const statuses = ctx.query['statuses']?.split(',')
  if (statuses) rows = rows.filter((s) => statuses.includes(s.status))
  const metricKeys = ctx.query['metricKeys']?.split(',')
  if (metricKeys) rows = rows.filter((s) => metricKeys.includes(s.metricKey))
  return pageOf(rows, ctx.query['page'], ctx.query['pageSize'])
})
route('GET', '/reporting/trace/:unitNo', (p, ctx) => {
  const unitNo = p[0]
  const direction = ctx.query['direction'] === 'backward' ? 'backward' : 'forward'
  if (unitNo.includes('NOTFOUND')) {
    throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message: '追溯根对象不存在或不在授权数据范围内', details: {} })
  }
  if (direction === 'forward') {
    return {
      direction,
      root: { nodeId: 'n-root', nodeType: 'inventory_unit', unitNo },
      nodes: [
        { nodeId: 'n-root', nodeType: 'inventory_unit', unitNo, materialCode: 'MAT-CU-8', status: 'in_stock', depth: 0, operationName: null, equipmentCode: null, operatorLogin: null, holdCount: 0 },
        { nodeId: 'n-seg-1', nodeType: 'material_segment', unitNo: 'U-2026-1101-0001', materialCode: 'MAT-CU-8', status: 'in_stock', depth: 1, operationName: '倒轴', equipmentCode: null, operatorLogin: 'wang', holdCount: 0 },
        { nodeId: 'n-cust-1', nodeType: 'customer_segment', unitNo: null, materialCode: 'MAT-CU-8', status: 'shipped', depth: 2, operationName: null, equipmentCode: null, operatorLogin: null, holdCount: 0 },
      ],
      edges: [
        { fromNodeId: 'n-root', toNodeId: 'n-seg-1', edgeKind: 'production_output', quantity: '1500.0000', uomCode: 'KG', businessTime: now },
        { fromNodeId: 'n-seg-1', toNodeId: 'n-cust-1', edgeKind: 'customer_binding', quantity: '1500.0000', uomCode: 'KG', businessTime: now },
      ],
    }
  }
  return {
    direction,
    root: { nodeId: 'n-root', nodeType: 'inventory_unit', unitNo },
    nodes: [
      { nodeId: 'n-root', nodeType: 'inventory_unit', unitNo, materialCode: 'MAT-CU-8', status: 'in_stock', depth: 0, operationName: null, equipmentCode: null, operatorLogin: null, holdCount: 0 },
      { nodeId: 'n-lot-1', nodeType: 'material_lot', unitNo: null, materialCode: 'MAT-XLPE-1', status: 'consumed', depth: 1, operationName: '拉丝', equipmentCode: 'EQ-DRAW-01', operatorLogin: 'wang', holdCount: 0 },
    ],
    edges: [
      { fromNodeId: 'n-lot-1', toNodeId: 'n-root', edgeKind: 'receipt_origin', quantity: '1000.0000', uomCode: 'KG', businessTime: now2 },
      { fromNodeId: 'n-lot-1', toNodeId: 'n-root', edgeKind: 'consumption', quantity: '800.0000', uomCode: 'KG', businessTime: now },
    ],
  }
})

// ---------------------------------------------------------------------------
// 分发入口（client mock 模式调用）
// ---------------------------------------------------------------------------

/** mock 分发：未定义路由返回 null（client 抛 ERR_NOT_FOUND）。 */
export function mockP2Routes(method: 'GET' | 'POST', path: string, query: Record<string, string> = {}): MockP2Handler | null {
  for (const r of routes) {
    if (r.method !== method) continue
    const m = r.pattern.exec(path)
    if (m) {
      const params = m.slice(1)
      return (ctx: MockP2Context) => r.make(params, { ...ctx, query })
    }
  }
  return null
}

/** 测试清场（先例：resetMockLoginState / resetMockAiQueryState）。 */
export function resetMockP2State(): void {
  // 演示定位：不可变基础夹具不重置；可变状态（命令迁移目标）在夹具构造上留痕即可。
  // 当前 mock 的可变态均为内存对象字段，测试用例自包含断言（演示数据只读消费），
  // 重置入口保留给后续扩展（先例 p4 resetMockAiQueryState）。
}
