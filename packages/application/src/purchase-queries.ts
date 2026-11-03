import type { PageResult } from '@cadenza/contracts'
// domain purchase 面未并入包名入口（domain/src/index.ts 为共享文件不改动）：
// 暂以 dist 相对导入消费已构建产物；L0 整合步后改包名导入（同 purchase-handlers 口径）。
import {
  BATCH_INSPECTION_STATUS_LABELS,
  DETAIL_QUALITY_STATUS_LABELS,
  ORDER_LINE_STATUS_LABELS,
} from '@cadenza/domain'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  PurchaseBatchRepository,
  PurchaseOrderLineRecord,
  PurchaseOrderLineRepository,
  PurchaseReceiptBatchRecord,
  ReceiptDetailRepository,
  InspectionRecordRepository,
} from './purchase-repositories'

/**
 * purchase 域查询服务（读侧，池连接只读；许可由 HTTP 守卫首检，数据范围在本服务内
 * 按授权上下文服务端过滤——订单行/批次按 plant 收敛，与 masterdata 查询同口径）。
 */

export interface PurchaseQueryDeps {
  lines: PurchaseOrderLineRepository
  batches: PurchaseBatchRepository
  details: ReceiptDetailRepository
  inspections: InspectionRecordRepository
}

export type PurchaseOrderLineView = Omit<
  PurchaseOrderLineRecord,
  'purchaseOrderId' | 'enterpriseId' | 'createdAt' | 'updatedAt'
> & { statusLabel: string }

export type PurchaseBatchView = Omit<
  PurchaseReceiptBatchRecord,
  'plantId' | 'enterpriseId' | 'createdAt'
> & { inspectionStatusLabel: string }

function toLineView(line: PurchaseOrderLineRecord): PurchaseOrderLineView {
  return {
    id: line.id,
    lineNo: line.lineNo,
    orderNo: line.orderNo,
    orgCode: line.orgCode,
    sourceSystem: line.sourceSystem,
    plantId: line.plantId,
    materialId: line.materialId,
    materialCode: line.materialCode,
    materialName: line.materialName,
    materialType: line.materialType,
    spec: line.spec,
    model: line.model,
    color: line.color,
    requisitionSpec: line.requisitionSpec,
    salesOrderNo: line.salesOrderNo,
    salesLineNo: line.salesLineNo,
    uomCode: line.uomCode,
    plannedQty: line.plannedQty,
    receivedQty: line.receivedQty,
    overReceiptLimit: line.overReceiptLimit,
    status: line.status,
    erpClosed: line.erpClosed,
    plannedReceiptDate: line.plannedReceiptDate,
    firstArrivalDate: line.firstArrivalDate,
    lastArrivalDate: line.lastArrivalDate,
    externalRevision: line.externalRevision,
    statusLabel: ORDER_LINE_STATUS_LABELS[line.status as 0 | 1 | 2 | 3 | 4 | 5] ?? String(line.status),
  }
}

function toBatchView(batch: PurchaseReceiptBatchRecord): PurchaseBatchView {
  return {
    id: batch.id,
    batchNo: batch.batchNo,
    purchaseLineId: batch.purchaseLineId,
    orderNo: batch.orderNo,
    lineNo: batch.lineNo,
    materialId: batch.materialId,
    materialCode: batch.materialCode,
    materialName: batch.materialName,
    materialType: batch.materialType,
    warehouseId: batch.warehouseId,
    warehouseCode: batch.warehouseCode,
    locationId: batch.locationId,
    locationCode: batch.locationCode,
    uomId: batch.uomId,
    uomCode: batch.uomCode,
    inspectionStatus: batch.inspectionStatus,
    inspectionStatusLabel: BATCH_INSPECTION_STATUS_LABELS[batch.inspectionStatus] ?? batch.inspectionStatus,
    storageStatus: batch.storageStatus,
    receivedQty: batch.receivedQty,
    unitPrice: batch.unitPrice,
    priceHistory: batch.priceHistory,
    avgPrice: batch.avgPrice,
    deviationPpm: batch.deviationPpm,
    priceFlag: batch.priceFlag,
    reviewStatus: batch.reviewStatus,
    reviewedBy: batch.reviewedBy,
    reviewedAt: batch.reviewedAt,
    qualifiedSyncStatus: batch.qualifiedSyncStatus,
    returnSyncStatus: batch.returnSyncStatus,
    arrivalTime: batch.arrivalTime,
    confirmTime: batch.confirmTime,
    receivedBy: batch.receivedBy,
    returnedAt: batch.returnedAt,
    returnReason: batch.returnReason,
  }
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

export class PurchaseQueryService {
  constructor(private readonly deps: PurchaseQueryDeps) {}

  /** 数据范围折算：企业范围 → null（不过滤）；否则限定授权工厂集合。 */
  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  /** 订单行分页（IF-08：MES 零增删改，行维度查询与状态汇总）。 */
  async listOrderLines(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      orderNoLike?: string
      materialCode?: string
      statuses?: string[]
      page?: number
      pageSize?: number
    },
  ): Promise<PageResult<PurchaseOrderLineView>> {
    const pageRequest = toPageRequest(query)
    const scope = this.plantScope(auth)
    const statuses = (query.statuses ?? [])
      .map((s) => Number(s))
      .filter((s) => Number.isInteger(s) && s >= 0 && s <= 5)
    const page = await this.deps.lines.listPaged({
      plantIds: scope,
      plantId: query.plantId,
      orderNoLike: like(query.orderNoLike),
      materialCode: like(query.materialCode),
      statuses: statuses.length > 0 ? statuses : undefined,
      ...pageRequest,
    })
    return { items: page.items.map(toLineView), total: page.total, ...pageRequest }
  }

  /** 批次分页（A-4/A-6/A-9/A-10 投影列 + 近 5 次价格历史随详情返回）。 */
  async listBatches(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      batchNoLike?: string
      orderNoLike?: string
      inspectionStatuses?: string[]
      storageStatuses?: string[]
      reviewStatuses?: string[]
      page?: number
      pageSize?: number
    },
  ): Promise<PageResult<PurchaseBatchView>> {
    const pageRequest = toPageRequest(query)
    const scope = this.plantScope(auth)
    const page = await this.deps.batches.listPaged({
      plantIds: scope,
      plantId: query.plantId,
      batchNoLike: like(query.batchNoLike),
      orderNoLike: like(query.orderNoLike),
      inspectionStatuses: query.inspectionStatuses,
      storageStatuses: query.storageStatuses,
      reviewStatuses: query.reviewStatuses,
      ...pageRequest,
    })
    return { items: page.items.map(toBatchView), total: page.total, ...pageRequest }
  }

  /**
   * 批次详情：明细（含当前质量状态投影）+ 质检历史版本链（S14 全量，含生效指针）+
   * 价格复核只读投影（本批单价/近 5 次历史明细/均价/浮动，A-10）。
   * 范围外（数据范围不可见）返回 null。
   */
  async batchDetail(
    auth: VerifiedAuthContext,
    batchId: string,
  ): Promise<(PurchaseBatchView & {
    details: Array<{
      detailId: string
      barcodeValue: string
      supplierLotNo: string
      grade: string
      productionDate: string | null
      quantity: string
      uomCode: string
      qualityStatus: string
      qualityStatusLabel: string
      inventoryUnitId: string | null
      locationCode: string | null
    }>
    inspectionHistory: Array<{
      recordId: string
      detailId: string
      barcodeValue: string
      inspectionType: string
      version: number
      conclusion: string
      isEffective: boolean
      source: string
      inspector: string | null
      inspectedAt: string | null
    }>
    priceHistory: Array<{ batchNo: string; price: string; confirmTime: string }>
  }) | null> {
    const batch = await this.deps.batches.findById(batchId)
    if (batch === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(batch.plantId)) return null
    const details = await this.deps.details.listByBatch(batchId)
    const history = await this.deps.inspections.listByBatch(batchId)
    return {
      ...toBatchView(batch),
      details: details.map((d) => ({
        detailId: d.id,
        barcodeValue: d.barcodeValue,
        supplierLotNo: d.supplierLotNo,
        grade: d.grade,
        productionDate: d.productionDate,
        quantity: d.quantity,
        uomCode: d.uomCode,
        qualityStatus: d.qualityStatus,
        qualityStatusLabel: DETAIL_QUALITY_STATUS_LABELS[d.qualityStatus] ?? d.qualityStatus,
        inventoryUnitId: d.inventoryUnitId,
        locationCode: d.locationCode,
      })),
      inspectionHistory: history.map((r) => ({
        recordId: r.id,
        detailId: r.detailId,
        barcodeValue: r.barcodeValue,
        inspectionType: r.inspectionType,
        version: r.version,
        conclusion: r.conclusion,
        isEffective: r.isEffective,
        source: r.source,
        inspector: r.inspector,
        inspectedAt: r.inspectedAt,
      })),
      priceHistory: batch.priceHistory ?? [],
    }
  }
}
