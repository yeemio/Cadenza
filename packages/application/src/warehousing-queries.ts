import type { PageResult } from '@cadenza/contracts'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  PutawayTaskRecord,
  TransferOrderRecord,
  WarehouseMoveRecord,
} from './warehousing-repositories'
import type {
  PutawayTaskRepository,
  TransferLineRepository,
  TransferOrderRepository,
  WarehouseMoveRepository,
} from './warehousing-repositories'

/**
 * warehousing 域查询服务（读侧，池连接只读；许可由 HTTP 守卫首检，数据范围在本服务内
 * 按授权上下文服务端过滤——任务/移库/调拨按 plant 收敛，与 purchase 查询同口径）。
 */

export interface WarehousingQueryDeps {
  putawayTasks: PutawayTaskRepository
  moves: WarehouseMoveRepository
  transferOrders: TransferOrderRepository
  transferLines: TransferLineRepository
}

export type PutawayTaskView = Omit<PutawayTaskRecord, 'enterpriseId' | 'createdAt' | 'updatedAt'> & {
  statusLabel: string
}

export type WarehouseMoveView = Omit<WarehouseMoveRecord, 'enterpriseId' | 'businessTime' | 'createdAt'>

export type TransferOrderView = Omit<TransferOrderRecord, 'enterpriseId' | 'businessTime' | 'createdAt' | 'updatedAt'> & {
  statusLabel: string
}

export type TransferLineView = {
  lineId: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  materialCode: string | null
  quantity: string
  outQty: string
  inQty: string
  reservationId: string | null
  outDone: boolean
  inDone: boolean
}

const PUTAWAY_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: '待入库',
  done: '已完成',
  cancelled: '已取消',
}

const TRANSFER_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: '草稿',
  ready: '待执行',
  shipping: '出库中',
  shipped_in_transit: '已出库在途',
  receiving: '收货中',
  completed: '完成',
  cancelled: '已取消',
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

export class WarehousingQueryService {
  constructor(private readonly deps: WarehousingQueryDeps) {}

  /** 数据范围折算：企业范围 → null（不过滤）；否则限定授权工厂集合。 */
  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  /** 待入库任务分页（A-T13-1：台账只读查询——任务禁手工增删改）。 */
  async listPutawayTasks(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      statuses?: string[]
      sourceTypes?: string[]
      page?: number
      pageSize?: number
    },
  ): Promise<PageResult<PutawayTaskView>> {
    const pageRequest = toPageRequest(query)
    const scope = this.plantScope(auth)
    const page = await this.deps.putawayTasks.listPaged({
      plantIds: scope,
      plantId: query.plantId,
      statuses: query.statuses,
      sourceTypes: query.sourceTypes,
      ...pageRequest,
    })
    return { items: page.items.map(toTaskView), total: page.total, ...pageRequest }
  }

  /** 移库记录分页（A-T13-4：append-only 历史）。 */
  async listMoves(
    auth: VerifiedAuthContext,
    query: { plantId?: string; unitNoLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<WarehouseMoveView>> {
    const pageRequest = toPageRequest(query)
    const scope = this.plantScope(auth)
    const page = await this.deps.moves.listPaged({
      plantIds: scope,
      plantId: query.plantId,
      unitNoLike: like(query.unitNoLike),
      ...pageRequest,
    })
    return {
      items: page.items.map((m) => ({
        id: m.id,
        inventoryUnitId: m.inventoryUnitId,
        unitNo: m.unitNo,
        fromLocationId: m.fromLocationId,
        fromLocationCode: m.fromLocationCode,
        toLocationId: m.toLocationId,
        toLocationCode: m.toLocationCode,
        quantity: m.quantity,
        uomId: m.uomId,
        uomCode: m.uomCode,
        movedBy: m.movedBy,
        movedAt: m.movedAt,
        reason: m.reason,
        commandReceiptId: m.commandReceiptId,
        plantId: m.plantId,
      })),
      total: page.total,
      ...pageRequest,
    }
  }

  /** 调拨单分页（A-T13-10 状态机投影）。 */
  async listTransferOrders(
    auth: VerifiedAuthContext,
    query: { plantId?: string; statuses?: string[]; orderNoLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<TransferOrderView>> {
    const pageRequest = toPageRequest(query)
    const scope = this.plantScope(auth)
    const page = await this.deps.transferOrders.listPaged({
      plantIds: scope,
      plantId: query.plantId,
      statuses: query.statuses,
      orderNoLike: like(query.orderNoLike),
      ...pageRequest,
    })
    return { items: page.items.map(toOrderView), total: page.total, ...pageRequest }
  }

  /** 调拨单详情（含两段事实行）。范围外返回 null。 */
  async transferDetail(
    auth: VerifiedAuthContext,
    transferOrderId: string,
  ): Promise<(TransferOrderView & { lines: TransferLineView[] }) | null> {
    const order = await this.deps.transferOrders.findById(transferOrderId)
    if (order === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(order.plantId)) return null
    const lines = await this.deps.transferLines.listByOrder(order.id)
    return { ...toOrderView(order), lines: lines.map(toLineView) }
  }
}

function toTaskView(t: PutawayTaskRecord): PutawayTaskView {
  return {
    id: t.id,
    sourceType: t.sourceType,
    sourceRef: t.sourceRef,
    unitNo: t.unitNo,
    palletCode: t.palletCode,
    materialId: t.materialId,
    materialCode: t.materialCode,
    quantity: t.quantity,
    uomId: t.uomId,
    uomCode: t.uomCode,
    targetWarehouseId: t.targetWarehouseId,
    status: t.status,
    statusLabel: PUTAWAY_STATUS_LABELS[t.status] ?? t.status,
    inventoryUnitId: t.inventoryUnitId,
    locationId: t.locationId,
    locationCode: t.locationCode,
    putawayBy: t.putawayBy,
    putawayAt: t.putawayAt,
    plantId: t.plantId,
  }
}

function toOrderView(o: TransferOrderRecord): TransferOrderView {
  return {
    id: o.id,
    orderNo: o.orderNo,
    transferKind: o.transferKind,
    fromWarehouseId: o.fromWarehouseId,
    toWarehouseId: o.toWarehouseId,
    fromWarehouseCode: o.fromWarehouseCode,
    toWarehouseCode: o.toWarehouseCode,
    fromWarehouseType: o.fromWarehouseType,
    toWarehouseType: o.toWarehouseType,
    status: o.status,
    statusLabel: TRANSFER_STATUS_LABELS[o.status] ?? o.status,
    transitLocationId: o.transitLocationId,
    transitLocationCode: o.transitLocationCode,
    lockedValidUntil: o.lockedValidUntil,
    note: o.note,
    submittedBy: o.submittedBy,
    submittedAt: o.submittedAt,
    shippedBy: o.shippedBy,
    shippedAt: o.shippedAt,
    completedBy: o.completedBy,
    completedAt: o.completedAt,
    plantId: o.plantId,
  }
}

function toLineView(l: import('./warehousing-repositories').TransferLineRecord): TransferLineView {
  return {
    lineId: l.id,
    lineNo: l.lineNo,
    inventoryUnitId: l.inventoryUnitId,
    unitNo: l.unitNo,
    materialCode: l.materialCode,
    quantity: l.quantity,
    outQty: l.outQty,
    inQty: l.inQty,
    reservationId: l.reservationId,
    outDone: l.outDone,
    inDone: l.inDone,
  }
}
