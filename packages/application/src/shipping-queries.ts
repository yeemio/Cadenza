import type { PageResult } from '@cadenza/contracts'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  DcCompositionRepository,
  PackingOrderRepository,
  PackingScanRepository,
  ShipmentLineRepository,
  ShipmentOrderRecord,
  ShipmentOrderRepository,
  ShipmentPhotoRepository,
} from './shipping-repositories'

/**
 * shipping 域查询服务（读侧，池连接只读；许可由 HTTP 守卫首检，数据范围在本服务内
 * 按授权上下文服务端过滤——PL/打包/出库状态按 plant 收敛，与 warehousing 查询同口径）。
 */

export interface ShippingQueryDeps {
  orders: ShipmentOrderRepository
  lines: ShipmentLineRepository
  packings: PackingOrderRepository
  scans: PackingScanRepository
  photos: ShipmentPhotoRepository
  compositions: DcCompositionRepository
}

export type ShipmentOrderView = {
  orderId: string
  plNo: string
  salesOrderNo: string
  customerName: string | null
  status: ShipmentOrderRecord['status']
  statusLabel: string
  compositionMissing: boolean
  outboundBy: string | null
  outboundAt: string | null
  actualAxisSyncStatus: ShipmentOrderRecord['actualAxisSyncStatus']
  actualAxisSyncStatusLabel: string
  shippingStatusSyncStatus: ShipmentOrderRecord['shippingStatusSyncStatus']
  shippingStatusSyncStatusLabel: string
  actualAxisSnapshot: Record<string, unknown> | null
  statusSyncSnapshot: Record<string, unknown> | null
  plantId: string
  createdAt: string
}

const PL_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending_packing: '待装箱',
  ready_to_ship: '待出库',
  shipped: '已出库',
}

const ACTUAL_AXIS_LABELS: Readonly<Record<string, string>> = {
  pending: '待同步',
  synced: '已同步',
  sync_failed: '同步失败',
  noop_needed: '无需同步',
}

const STATUS_SYNC_LABELS: Readonly<Record<string, string>> = {
  pending: '待同步',
  synced: '已同步',
  sync_failed: '同步失败',
}

const PACKING_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: '待打包',
  bound: '已绑定',
  cancelled: '已取消',
}

const LINE_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending_packing: '待装箱',
  packed: '已装箱',
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

export class ShippingQueryService {
  constructor(private readonly deps: ShippingQueryDeps) {}

  /** 数据范围折算：企业范围 → null（不过滤）；否则限定授权工厂集合。 */
  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  private assertScope(auth: VerifiedAuthContext, plantId: string): boolean {
    const scope = this.plantScope(auth)
    return scope === null || scope.includes(plantId)
  }

  /** PL 分页（A-T14-1 列表；出库回传双状态列独立投影）。 */
  async listShipmentOrders(
    auth: VerifiedAuthContext,
    query: { plantId?: string; statuses?: string[]; plNoLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<ShipmentOrderView>> {
    const pageRequest = toPageRequest(query)
    const scope = this.plantScope(auth)
    const page = await this.deps.orders.listPaged({
      plantIds: scope,
      plantId: query.plantId,
      statuses: query.statuses,
      plNoLike: like(query.plNoLike),
      ...pageRequest,
    })
    return { items: page.items.map(toOrderView), total: page.total, ...pageRequest }
  }

  /** PL 详情（行三类+扫码记录+打包任务+附件）。范围外返回 null。 */
  async shipmentDetail(
    auth: VerifiedAuthContext,
    shipmentOrderId: string,
  ): Promise<(ShipmentOrderView & {
    lines: ReturnType<typeof toLineView>[]
    scans: ReturnType<typeof toScanView>[]
    packings: ReturnType<typeof toPackingView>[]
    photos: ReturnType<typeof toPhotoView>[]
  }) | null> {
    const order = await this.deps.orders.findById(shipmentOrderId)
    if (order === null) return null
    if (!this.assertScope(auth, order.plantId)) return null
    const [lines, scans, packings, photos] = await Promise.all([
      this.deps.lines.listByOrder(order.id),
      this.deps.scans.listByOrder(order.id),
      this.deps.packings.listByShipment(order.id),
      this.deps.photos.listByOrder(order.id),
    ])
    return {
      ...toOrderView(order),
      lines: lines.map(toLineView),
      scans: scans.map(toScanView),
      packings: packings.map((po) => toPackingView(po, lines)),
      photos: photos.map(toPhotoView),
    }
  }

  /** 打包看板（A-T14-4：托码+调入库位+逐行扫满+绑定状态）。 */
  async packingBoard(
    auth: VerifiedAuthContext,
    query: { plantId?: string; statuses?: string[]; palletCodeLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<ReturnType<typeof toPackingView>>> {
    const pageRequest = toPageRequest(query)
    const scope = this.plantScope(auth)
    const page = await this.deps.packings.listPaged({
      plantIds: scope,
      plantId: query.plantId,
      statuses: query.statuses,
      palletCodeLike: like(query.palletCodeLike),
      ...pageRequest,
    })
    // 看板每单附行进度（列表页逐单查询；页尺寸 ≤100 可接受）
    const items = [] as ReturnType<typeof toPackingView>[]
    for (const po of page.items) {
      const lines = await this.deps.lines.listByOrder(po.shipmentOrderId)
      items.push(toPackingView(po, lines))
    }
    return { items, total: page.total, ...pageRequest }
  }

  /** 出库状态（A-T14-7/8：已出库集合×两条回传双状态列独立）。 */
  async outboundStatus(
    auth: VerifiedAuthContext,
    query: { plantId?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<ShipmentOrderView>> {
    return this.listShipmentOrders(auth, { ...query, statuses: ['shipped'] })
  }

  /** DC 分段/组成数据（IF-04：缺组成数据标记=生产订单行标黄数据源）。 */
  async listCompositions(
    auth: VerifiedAuthContext,
    query: { salesOrderNo: string },
  ): Promise<ReturnType<typeof toCompositionView>[]> {
    const rows = await this.deps.compositions.listBySalesOrder(query.salesOrderNo)
    const scope = this.plantScope(auth)
    return rows.filter((r) => scope === null || scope.includes(r.plantId)).map(toCompositionView)
  }
}

function toOrderView(o: import('./shipping-repositories').ShipmentOrderRecord): ShipmentOrderView {
  return {
    orderId: o.id,
    plNo: o.plNo,
    salesOrderNo: o.salesOrderNo,
    customerName: o.customerName,
    status: o.status,
    statusLabel: PL_STATUS_LABELS[o.status] ?? o.status,
    compositionMissing: o.compositionMissing,
    outboundBy: o.outboundBy,
    outboundAt: o.outboundAt,
    actualAxisSyncStatus: o.actualAxisSyncStatus,
    actualAxisSyncStatusLabel: ACTUAL_AXIS_LABELS[o.actualAxisSyncStatus] ?? o.actualAxisSyncStatus,
    shippingStatusSyncStatus: o.shippingStatusSyncStatus,
    shippingStatusSyncStatusLabel: STATUS_SYNC_LABELS[o.shippingStatusSyncStatus] ?? o.shippingStatusSyncStatus,
    actualAxisSnapshot: o.actualAxisSnapshot,
    statusSyncSnapshot: o.statusSyncSnapshot,
    plantId: o.plantId,
    createdAt: o.createdAt,
  }
}

function toLineView(l: import('./shipping-repositories').ShipmentLineRecord) {
  return {
    lineId: l.id,
    lineNo: l.lineNo,
    lineKind: l.lineKind,
    materialId: l.materialId,
    materialCode: l.materialCode,
    salesOrderLineNo: l.salesOrderLineNo,
    customerAxisNo: l.customerAxisNo,
    standardSegmentLength: l.standardSegmentLength,
    actualSegmentLength: l.actualSegmentLength,
    segmentLength: l.segmentLength,
    requiredCount: l.requiredCount,
    scannedCount: l.scannedCount,
    lineStatus: l.lineStatus,
    lineStatusLabel: LINE_STATUS_LABELS[l.lineStatus] ?? l.lineStatus,
    packingStatus: l.packingStatus,
    packingOrderId: l.packingOrderId,
  }
}

function toScanView(s: import('./shipping-repositories').PackingScanRecord) {
  return {
    scanId: s.id,
    shipmentLineId: s.shipmentLineId,
    scanKind: s.scanKind,
    inventoryUnitId: s.inventoryUnitId,
    unitNo: s.unitNo,
    customerAxisNo: s.customerAxisNo,
    actualSegmentLength: s.actualSegmentLength,
    scannedBy: s.scannedBy,
    scannedAt: s.scannedAt,
    deleted: s.deleted,
    deletedBy: s.deletedBy,
    deletedAt: s.deletedAt,
  }
}

function toPackingView(
  po: import('./shipping-repositories').PackingOrderRecord,
  lines: import('./shipping-repositories').ShipmentLineRecord[],
) {
  return {
    packingId: po.id,
    packingNo: po.packingNo,
    shipmentOrderId: po.shipmentOrderId,
    palletCode: po.palletCode,
    toLocationId: po.toLocationId,
    toLocationCode: po.toLocationCode,
    status: po.status,
    statusLabel: PACKING_STATUS_LABELS[po.status] ?? po.status,
    boundBy: po.boundBy,
    boundAt: po.boundAt,
    lines: lines
      .filter((l) => l.packingOrderId === po.id)
      .map((l) => ({
        lineId: l.id,
        lineNo: l.lineNo,
        materialCode: l.materialCode,
        requiredCount: l.requiredCount,
        scannedCount: l.scannedCount,
        lineStatus: l.lineStatus,
      })),
    plantId: po.plantId,
  }
}

function toPhotoView(ph: import('./shipping-repositories').ShipmentPhotoRecord) {
  return {
    photoId: ph.id,
    fileName: ph.fileName,
    storageKey: ph.storageKey,
    contentType: ph.contentType,
    sizeBytes: ph.sizeBytes,
    uploadedBy: ph.uploadedBy,
    uploadedAt: ph.uploadedAt,
  }
}

function toCompositionView(c: import('./shipping-repositories').DcCompositionRecord) {
  return {
    id: c.id,
    dcId: c.dcId,
    salesOrderNo: c.salesOrderNo,
    lineNo: c.lineNo,
    syncStatus: c.syncStatus,
    composition: c.composition,
    missingMarkedAt: c.missingMarkedAt,
    plantId: c.plantId,
  }
}
