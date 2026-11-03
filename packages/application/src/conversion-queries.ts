import type { PageResult } from '@cadenza/contracts'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  ConversionOrderRepository,
  ConversionStockLineRepository,
  ConversionStockOrderRepository,
  ConversionStockLookups,
} from './conversion-repositories'

/**
 * conversionform 域查询服务（读侧，池连接只读；许可由 HTTP 守卫首检，数据范围在本服务内
 * 按授权上下文服务端过滤——订单/库存转换单按 plant 收敛，与 shipping 查询同口径）。
 *
 * FC-21：库存转换列表 转换数量=全部明细数量之和、转换轴数=明细行数（一轴一行）；
 * 明细页只读。FC-12：订单转换列表 转换状态/同步状态两列独立投影。
 */

export interface ConversionQueryDeps {
  orders: ConversionOrderRepository
  orderLines: import('./conversion-repositories').ConversionOrderLineRepository
  orderScans: import('./conversion-repositories').ConversionOrderScanRepository
  assignments: import('./conversion-repositories').CodeAssignmentRepository
  stockOrders: ConversionStockOrderRepository
  stockLines: ConversionStockLineRepository
  rewrites: import('./conversion-repositories').CodeRewriteRepository
  stockLookups: ConversionStockLookups
}

const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: '待转换',
  completed: '已完成',
}

const ORDER_SYNC_LABELS: Readonly<Record<string, string>> = {
  pending: '未同步',
  sync_failed: '同步失败',
  synced: '已同步',
}

const STOCK_INTERNAL_LABELS: Readonly<Record<string, string>> = {
  pending_execute: '待执行',
  external_processing: '外部处理中',
  local_processing: '本地处理中',
  completed: '完成',
  pending_recovery: '待恢复',
  manual_processing: '人工处理',
}

const STOCK_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  convert_failed: '转换失败',
  sync_failed: '同步失败',
  convert_success: '转换成功',
}

function toPageRequest(query: { page?: unknown; pageSize?: unknown }): { page: number; pageSize: number } {
  const page = typeof query.page === 'number' && Number.isInteger(query.page) && query.page >= 1 ? query.page : 1
  const pageSize =
    typeof query.pageSize === 'number' && Number.isInteger(query.pageSize) && query.pageSize >= 1
      ? Math.min(query.pageSize, 100)
      : 20
  return { page, pageSize }
}

const like = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export class ConversionQueryService {
  constructor(private readonly deps: ConversionQueryDeps) {}

  /** 数据范围折算：企业范围 → null（不过滤）；否则限定授权工厂集合。 */
  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  private assertScope(auth: VerifiedAuthContext, plantId: string): boolean {
    const scope = this.plantScope(auth)
    return scope === null || scope.includes(plantId)
  }

  /** FC-12：订单转换列表（转换状态/同步状态两列独立投影；PDA 状态 Tab 同用 statuses 过滤）。 */
  async listOrderConversions(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      statuses?: string[]
      syncStatuses?: string[]
      conversionNoLike?: string
      page?: number
      pageSize?: number
    },
  ): Promise<
    PageResult<{
      conversionId: string
      conversionNo: string
      status: string
      statusLabel: string
      syncStatus: string
      syncStatusLabel: string
      completedBy: string | null
      completedAt: string | null
      plantId: string
      createdAt: string
      createdBy: string | null
    }>
  > {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.orders.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      statuses: query.statuses,
      syncStatuses: query.syncStatuses,
      conversionNoLike: like(query.conversionNoLike),
      ...pageRequest,
    })
    return {
      items: page.items.map((o) => ({
        conversionId: o.id,
        conversionNo: o.conversionNo,
        status: o.status,
        statusLabel: ORDER_STATUS_LABELS[o.status] ?? o.status,
        syncStatus: o.syncStatus,
        syncStatusLabel: ORDER_SYNC_LABELS[o.syncStatus] ?? o.syncStatus,
        completedBy: o.completedBy,
        completedAt: o.completedAt,
        plantId: o.plantId,
        createdAt: o.createdAt,
        createdBy: o.createdBy,
      })),
      total: page.total,
      ...pageRequest,
    }
  }

  /** 订单转换详情（明细+已扫二维码+归属变更；范围外返回 null）。 */
  async orderConversionDetail(auth: VerifiedAuthContext, conversionId: string) {
    const order = await this.deps.orders.findById(conversionId)
    if (order === null) return null
    if (!this.assertScope(auth, order.plantId)) return null
    const [lines, scans, assignments] = await Promise.all([
      this.deps.orderLines.listByOrder(order.id),
      this.deps.orderScans.listByOrder(order.id),
      this.deps.assignments.listByOrder(order.id),
    ])
    return {
      conversionId: order.id,
      conversionNo: order.conversionNo,
      status: order.status,
      statusLabel: ORDER_STATUS_LABELS[order.status] ?? order.status,
      syncStatus: order.syncStatus,
      syncStatusLabel: ORDER_SYNC_LABELS[order.syncStatus] ?? order.syncStatus,
      completedBy: order.completedBy,
      completedAt: order.completedAt,
      plantId: order.plantId,
      createdAt: order.createdAt,
      createdBy: order.createdBy,
      lines: lines.map((l) => ({
        lineId: l.id,
        lineNo: l.lineNo,
        sourceOrderId: l.sourceOrderId,
        sourceSalesOrderNo: l.sourceSalesOrderNo,
        sourceLineNo: l.sourceLineNo,
        sourceProjectNo: l.sourceProjectNo,
        targetOrderId: l.targetOrderId,
        targetSalesOrderNo: l.targetSalesOrderNo,
        targetProjectNo: l.targetProjectNo,
        materialId: l.materialId,
        materialCode: l.materialCode,
        plannedQty: l.plannedQty,
        scannedQty: l.scannedQty,
        scannedAxes: l.scannedAxes,
        uom: l.uom,
      })),
      scans: scans.map((s) => ({
        scanId: s.id,
        lineId: s.conversionLineId,
        unitNo: s.unitNo,
        inventoryUnitId: s.inventoryUnitId,
        segmentLength: s.segmentLength,
        customerAxisNo: s.customerAxisNo,
        quantity: s.quantity,
        reservationId: s.reservationId,
        scannedBy: s.scannedBy,
        scannedAt: s.scannedAt,
        deleted: s.deleted,
        deletedBy: s.deletedBy,
        deletedAt: s.deletedAt,
      })),
      assignments: assignments.map((a) => ({
        unitNo: a.unitNo,
        inventoryUnitId: a.inventoryUnitId,
        fromOrderId: a.fromOrderId,
        toOrderId: a.toOrderId,
        assignedBy: a.assignedBy,
        assignedAt: a.assignedAt,
      })),
    }
  }

  /** FC-21/FC-02/FC-14：库存转换列表（对外三态投影 + 内部六态/外部/本地分列 + 聚合列）。 */
  async listStockConversions(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      displayStatuses?: string[]
      materialCodeLike?: string
      targetSalesOrderNoLike?: string
      targetProjectNoLike?: string
      conversionNoLike?: string
      page?: number
      pageSize?: number
    },
  ) {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.stockOrders.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      displayStatuses: query.displayStatuses,
      materialCodeLike: like(query.materialCodeLike),
      targetSalesOrderNoLike: like(query.targetSalesOrderNoLike),
      targetProjectNoLike: like(query.targetProjectNoLike),
      conversionNoLike: like(query.conversionNoLike),
      withAggregates: true,
      ...pageRequest,
    })
    return {
      items: page.items.map((o) => ({
        conversionId: o.id,
        conversionNo: o.conversionNo,
        internalStatus: o.internalStatus,
        internalStatusLabel: STOCK_INTERNAL_LABELS[o.internalStatus] ?? o.internalStatus,
        displayStatus: o.displayStatus,
        displayStatusLabel: STOCK_DISPLAY_LABELS[o.displayStatus] ?? o.displayStatus,
        externalPushStatus: o.externalPushStatus,
        localApplyStatus: o.localApplyStatus,
        u9Success: o.u9Success,
        materialId: o.materialId,
        materialCode: o.materialCode,
        materialName: o.materialName,
        targetProjectNo: o.targetProjectNo,
        targetSalesOrderNo: o.targetSalesOrderNo,
        targetLineNo: o.targetLineNo,
        targetBatchNo: o.targetBatchNo,
        totalQty: o.totalQty,
        axisCount: o.axisCount,
        externalDocNo: o.externalDocNo,
        externalFailureReason: o.externalFailureReason,
        completedAt: o.completedAt,
        plantId: o.plantId,
        createdAt: o.createdAt,
        createdBy: o.createdBy,
      })),
      total: page.total,
      ...pageRequest,
    }
  }

  /** FC-21：库存转换明细页（只读，一轴一行；含改码记录）。 */
  async stockConversionDetail(auth: VerifiedAuthContext, conversionStockOrderId: string) {
    const order = await this.deps.stockOrders.findById(conversionStockOrderId)
    if (order === null) return null
    if (!this.assertScope(auth, order.plantId)) return null
    const [lines, rewrites] = await Promise.all([
      this.deps.stockLines.listByOrder(order.id),
      this.deps.rewrites.listByOrder(order.id),
    ])
    const totalQty = lines.reduce((acc, l) => accCount(acc, l.quantity), '0.0000')
    return {
      conversionId: order.id,
      conversionNo: order.conversionNo,
      internalStatus: order.internalStatus,
      internalStatusLabel: STOCK_INTERNAL_LABELS[order.internalStatus] ?? order.internalStatus,
      displayStatus: order.displayStatus,
      displayStatusLabel: STOCK_DISPLAY_LABELS[order.displayStatus] ?? order.displayStatus,
      externalPushStatus: order.externalPushStatus,
      localApplyStatus: order.localApplyStatus,
      u9Success: order.u9Success,
      materialId: order.materialId,
      materialCode: order.materialCode,
      targetProjectNo: order.targetProjectNo,
      targetSalesOrderNo: order.targetSalesOrderNo,
      targetLineNo: order.targetLineNo,
      targetBatchNo: order.targetBatchNo,
      totalQty,
      axisCount: lines.length,
      completedAt: order.completedAt,
      plantId: order.plantId,
      createdAt: order.createdAt,
      createdBy: order.createdBy,
      lines: lines.map((l) => ({
        lineId: l.id,
        unitNo: l.unitNo,
        inventoryUnitId: l.inventoryUnitId,
        palletCode: l.palletCode,
        quantity: l.quantity,
        uom: l.uom,
        segmentLength: l.segmentLength,
        customerAxisNo: l.customerAxisNo,
        materialId: l.materialId,
        materialCode: l.materialCode,
        sourceProjectNo: l.sourceProjectNo,
        sourceSalesOrderNo: l.sourceSalesOrderNo,
        sourceLineNo: l.sourceLineNo,
        sourceBatchNo: l.sourceBatchNo,
        warehouseCode: l.warehouseCode,
        locationCode: l.locationCode,
      })),
      rewrites: rewrites.map((r) => ({
        unitNo: r.unitNo,
        oldSalesOrderNo: r.oldSalesOrderNo,
        oldLineNo: r.oldLineNo,
        oldBatchNo: r.oldBatchNo,
        oldVirtualAxisNo: r.oldVirtualAxisNo,
        newSalesOrderNo: r.newSalesOrderNo,
        newLineNo: r.newLineNo,
        newBatchNo: r.newBatchNo,
        newSegmentLength: r.newSegmentLength,
        newCustomerAxisNo: r.newCustomerAxisNo,
        virtualAxisCleared: r.virtualAxisCleared,
        appliedBy: r.appliedBy,
        appliedAt: r.appliedAt,
      })),
    }
  }

  /** FC-17：库存候选源（指定料品、在库、仓库类型=仓库；无托单轴一行/有托按托汇总一行）。 */
  async listStockCandidates(
    auth: VerifiedAuthContext,
    query: {
      plantId: string
      materialId: string
      warehouseId?: string
      unitNoLike?: string
      palletCodeLike?: string
      salesOrderNoLike?: string
      batchNoLike?: string
      customerAxisNoLike?: string
    },
  ) {
    if (!this.assertScope(auth, query.plantId)) return []
    return this.deps.stockLookups.listStockCandidates({
      plantId: query.plantId,
      materialId: query.materialId,
      warehouseId: like(query.warehouseId),
      unitNoLike: like(query.unitNoLike),
      palletCodeLike: like(query.palletCodeLike),
      salesOrderNoLike: like(query.salesOrderNoLike),
      batchNoLike: like(query.batchNoLike),
      customerAxisNoLike: like(query.customerAxisNoLike),
    })
  }
}

/** DecimalString 求和（查询侧聚合展示；scale 4 定点）。 */
function accCount(a: string, b: string): string {
  const scale = (v: string): bigint => {
    const [intPart, fracPart = ''] = v.split('.')
    return BigInt(intPart + (fracPart + '0000').slice(0, 4))
  }
  const total = scale(a) + scale(b)
  const S = 10n ** 4n
  return `${total / S}.${(total % S).toString().padStart(4, '0')}`
}
