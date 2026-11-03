import type { PageResult } from '@cadenza/contracts'
import type { VerifiedAuthContext } from './session-verifier'
import { assertMoveScanAcceptable, isCarrierAvailableForPlant } from '@cadenza/domain'
import type {
  CarrierLoanRepository,
  CarrierFactsLookup,
  ReceiptCorrectionRepository,
  ReverseLocationLookup,
  ReverseWarehouseLookup,
  StockAdjustmentRepository,
  StockMoveRecordRepository,
  StocktakeOrderRepository,
  StocktakeCountLineRepository,
  TransferInboundOrderRepository,
  TransferInboundLineRepository,
  TransferOutboundOrderRepository,
  TransferOutboundPlanLineRepository,
  TransferOutboundScanRepository,
  PurchaseBatchLookup,
} from './reverse-repositories'
import type { InventoryRepositories } from './inventory-repositories'

/**
 * reverse 域查询服务（读侧，池连接只读；许可由 HTTP 守卫首检，数据范围在本服务内
 * 按授权上下文服务端过滤——与 shipping/warehousing 查询同口径）。
 * WR-01：扫码查询只读（不改位置、不锁定）——moveScanInfo 无任何写路径。
 */

export interface ReverseQueryDeps {
  rv: {
    moveRecords: StockMoveRecordRepository
    outOrders: TransferOutboundOrderRepository
    outPlanLines: TransferOutboundPlanLineRepository
    outScans: TransferOutboundScanRepository
    inOrders: TransferInboundOrderRepository
    inLines: TransferInboundLineRepository
    stocktakes: StocktakeOrderRepository
    countLines: StocktakeCountLineRepository
    adjustments: StockAdjustmentRepository
    carrierLoans: CarrierLoanRepository
    corrections: ReceiptCorrectionRepository
    carrierFacts: CarrierFactsLookup
    pur: PurchaseBatchLookup
    warehouses: ReverseWarehouseLookup
    locations: ReverseLocationLookup
  }
  /** WR-03 移入库位范围按"登录人部门下"过滤：鉴权上下文不含部门 → 查用户主档。 */
  users: {
    findById(id: string): Promise<{ deptId: string | null } | null>
  }
  inv: Pick<InventoryRepositories, 'units' | 'balances' | 'reservations'>
}

const OUT_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending_out: '待出库',
  outbounding: '出库中',
  outbounded: '已出库',
  cancelled: '已取消',
}

const IN_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending_in: '待入库',
  inbounding: '入库中',
  completed: '已完成',
}

const IN_MODE_LABELS: Readonly<Record<string, string>> = {
  fixed_location: '固定库位（厂内即时转仓）',
  scan_putaway: '扫码上架（需交接/跨厂）',
}

const STOCKTAKE_LABELS: Readonly<Record<string, string>> = {
  counting: '盘点中（锁定）',
  completed: '已完成（解锁）',
  cancelled: '已取消（解锁）',
}

const CORRECTION_LABELS: Readonly<Record<string, string>> = {
  void: '作废',
  reverse: '冲销',
  return: '退货',
}

const LOAN_LABELS: Readonly<Record<string, string>> = {
  lend: '借出',
  take_back: '回收',
  damage: '损坏',
  scrap: '报废',
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

export class ReverseQueryService {
  constructor(private readonly deps: ReverseQueryDeps) {}

  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  // ---------------- 移库台账（WR-05：查询＋详情只读；详情为提交时快照） ----------------

  async listMoveRecords(
    auth: VerifiedAuthContext,
    query: { plantId?: string; unitNoLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<Record<string, unknown>>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.rv.moveRecords.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      unitNoLike: like(query.unitNoLike),
      ...pageRequest,
    })
    return { items: page.items as unknown as Record<string, unknown>[], total: page.total, ...pageRequest }
  }

  async moveRecordDetail(auth: VerifiedAuthContext, id: string): Promise<Record<string, unknown> | null> {
    const found = await this.deps.rv.moveRecords.findById(id)
    if (found === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(found.header.plantId)) return null
    return { ...found.header, lines: found.lines }
  }

  // ---------------- 移库扫码查询（WR-01：只查询、校验并返回码信息，不改不锁） ----------------

  async moveScanInfo(
    auth: VerifiedAuthContext,
    query: { plantId: string; unitNo: string; warehouseId: string; toLocationId?: string },
  ): Promise<Record<string, unknown> | null> {
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(query.plantId)) return null
    const unit = await this.deps.inv.units.findByUnitNo(query.plantId, query.unitNo)
    if (unit === null) return { ok: false, rejection: '[WR-02] 单元不在本厂或不存在', unitNo: query.unitNo }
    const balances = await this.deps.inv.balances.listActiveByUnit(unit.id)
    const warehouse = await this.deps.rv.warehouses.findById(query.warehouseId)
    const reservations = await this.deps.inv.reservations.listActiveByUnit(unit.id)
    const now = new Date().toISOString()
    const effective = reservations.filter((r) => r.status === 'active' && Date.parse(r.validUntil) >= Date.parse(now))
    const fromLocation = balances.length === 1 ? await this.deps.rv.locations.findById(balances[0]!.locationId) : null
    let rejection: string | null = null
    try {
      assertMoveScanAcceptable({
        unitNo: unit.unitNo,
        warehouseMismatch: fromLocation === null || fromLocation.warehouseId !== query.warehouseId,
        selectedWarehouseLocked: warehouse === null || warehouse.status !== 'active',
        unitLockedByOtherTask: effective.length > 0,
        palletMemberLocked: false, // 托关系事实由提交命令事务内收集（只读查询不展开）
        notInStock: unit.status !== 'in_stock',
        isPalletChildWithoutWhole: false,
        duplicateInStaging: false, // 本机暂存状态由端侧持有（服务端无暂存态，WR-01）
        sameLocation: query.toLocationId !== undefined && balances.length === 1 && balances[0]!.locationId === query.toLocationId,
      })
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error)
    }
    return {
      ok: rejection === null,
      rejection,
      unitNo: unit.unitNo,
      unitStatus: unit.status,
      materialCode: unit.materialCode,
      balance: balances.length === 1 ? { locationCode: balances[0]!.locationCode, quantity: balances[0]!.quantity, uomCode: balances[0]!.uomCode, qualityStatus: balances[0]!.qualityStatus } : null,
      scannedWarehouseId: fromLocation?.warehouseId ?? null,
    }
  }

  /** WR-03：移入库位范围——登录人部门下、已启用、仓库类型（不含线边仓）。 */
  async listMoveTargetWarehouses(
    auth: VerifiedAuthContext,
    query: { plantId: string; deptId?: string },
  ): Promise<Record<string, unknown>[]> {
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(query.plantId)) return []
    const deptId =
      query.deptId ?? ((await this.deps.users.findById(auth.user.id))?.deptId ?? null)
    return this.deps.rv.warehouses.listMoveTargetWarehouses(deptId, query.plantId)
  }

  // ---------------- 调拨出库（WR-07②：无任务单完成出库前 Web 不显示） ----------------

  async listTransferOutbound(
    auth: VerifiedAuthContext,
    query: { plantId?: string; statuses?: string[]; includeTasklessInProgress?: boolean; page?: number; pageSize?: number },
  ): Promise<PageResult<Record<string, unknown>>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.rv.outOrders.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      statuses: query.statuses,
      includeTasklessInProgress: query.includeTasklessInProgress === true,
      ...pageRequest,
    })
    const items = []
    for (const order of page.items) {
      const scans = await this.deps.rv.outScans.listByOrder(order.id)
      const loaded = scans.filter((s) => s.status === 'loaded')
      items.push({
        ...order,
        statusLabel: OUT_STATUS_LABELS[order.status] ?? order.status,
        visibleOnWeb: order.sourceKind !== 'pda_taskless' || order.status === 'outbounded',
        scannedCount: loaded.length,
        totalOutQty: loaded.reduce((acc, s) => (Number(acc) + Number(s.outQty)).toFixed(4), '0.0000'),
      })
    }
    return { items, total: page.total, ...pageRequest }
  }

  async transferOutboundDetail(auth: VerifiedAuthContext, id: string): Promise<Record<string, unknown> | null> {
    const order = await this.deps.rv.outOrders.findById(id)
    if (order === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(order.plantId)) return null
    const scans = await this.deps.rv.outScans.listByOrder(id)
    const planLines = await this.deps.rv.outPlanLines.listByOrder(id)
    return {
      ...order,
      statusLabel: OUT_STATUS_LABELS[order.status] ?? order.status,
      visibleOnWeb: order.sourceKind !== 'pda_taskless' || order.status === 'outbounded',
      scans,
      planLines,
    }
  }

  // ---------------- 调拨入库（WR-S3：入库方式列＋码入库状态列；跨厂签收=receivedBy≠出库方） ----------------

  async listTransferInbound(
    auth: VerifiedAuthContext,
    query: { plantId?: string; statuses?: string[]; page?: number; pageSize?: number },
  ): Promise<PageResult<Record<string, unknown>>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.rv.inOrders.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      statuses: query.statuses,
      ...pageRequest,
    })
    const items = []
    for (const order of page.items) {
      const lines = await this.deps.rv.inLines.listByOrder(order.id)
      items.push({
        orderId: order.id,
        orderNo: order.orderNo,
        inboundMode: order.inboundMode,
        inboundModeLabel: IN_MODE_LABELS[order.inboundMode] ?? order.inboundMode,
        status: order.status,
        statusLabel: IN_STATUS_LABELS[order.status] ?? order.status,
        fromWarehouseCode: order.fromWarehouseCode,
        toWarehouseId: order.toWarehouseId,
        toWarehouseCode: order.toWarehouseCode,
        completedAt: order.completedAt,
        // WR-14/WR-S3：固定库位完成单=出库方身份快照；扫码上架完成单=独立接收事实（receivedBy）
        shipperSnapshotBy: order.shipperSnapshotBy,
        shipperSnapshotAt: order.shipperSnapshotAt,
        receivedBy: order.receivedBy,
        receivedAt: order.receivedAt,
        inboundLines: lines.map((l) => ({
          unitNo: l.unitNo,
          materialCode: l.materialCode,
          quantity: l.quantity,
          lineStatus: l.lineStatus,
          locationCode: l.locationCode,
        })),
        plantId: order.plantId,
      })
    }
    return { items, total: page.total, ...pageRequest }
  }

  async transferInboundDetail(auth: VerifiedAuthContext, id: string): Promise<Record<string, unknown> | null> {
    const order = await this.deps.rv.inOrders.findById(id)
    if (order === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(order.plantId)) return null
    const lines = await this.deps.rv.inLines.listByOrder(id)
    return {
      ...order,
      inboundModeLabel: IN_MODE_LABELS[order.inboundMode] ?? order.inboundMode,
      statusLabel: IN_STATUS_LABELS[order.status] ?? order.status,
      inboundLines: lines,
    }
  }

  // ---------------- 盘点与差异调整（WR-24） ----------------

  async listStocktakes(
    auth: VerifiedAuthContext,
    query: { plantId?: string; statuses?: string[]; page?: number; pageSize?: number },
  ): Promise<PageResult<Record<string, unknown>>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.rv.stocktakes.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      statuses: query.statuses,
      ...pageRequest,
    })
    return {
      items: page.items.map((o) => ({ ...o, statusLabel: STOCKTAKE_LABELS[o.status] ?? o.status })),
      total: page.total,
      ...pageRequest,
    }
  }

  async stocktakeDetail(auth: VerifiedAuthContext, id: string): Promise<Record<string, unknown> | null> {
    const order = await this.deps.rv.stocktakes.findById(id)
    if (order === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(order.plantId)) return null
    const lines = await this.deps.rv.countLines.listByOrder(id)
    return { ...order, statusLabel: STOCKTAKE_LABELS[order.status] ?? order.status, countLines: lines }
  }

  async listAdjustments(
    auth: VerifiedAuthContext,
    query: { plantId?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<Record<string, unknown>>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.rv.adjustments.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      ...pageRequest,
    })
    return { items: page.items as unknown as Record<string, unknown>[], total: page.total, ...pageRequest }
  }

  async adjustmentDetail(auth: VerifiedAuthContext, id: string): Promise<Record<string, unknown> | null> {
    const found = await this.deps.rv.adjustments.findById(id)
    if (found === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(found.adjustment.plantId)) return null
    return { ...found.adjustment, lines: found.lines }
  }

  // ---------------- 采购批次纠正（WR-18～23） ----------------

  async listCorrections(
    auth: VerifiedAuthContext,
    query: { plantId?: string; correctionKinds?: string[]; batchNoLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<Record<string, unknown>>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.rv.corrections.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      correctionKinds: query.correctionKinds,
      batchNoLike: like(query.batchNoLike),
      ...pageRequest,
    })
    return {
      items: page.items.map((c) => ({ ...c, correctionKindLabel: CORRECTION_LABELS[c.correctionKind] ?? c.correctionKind })),
      total: page.total,
      ...pageRequest,
    }
  }

  async correctionDetail(auth: VerifiedAuthContext, id: string): Promise<Record<string, unknown> | null> {
    const correction = await this.deps.rv.corrections.findById(id)
    if (correction === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(correction.plantId)) return null
    return { ...correction, correctionKindLabel: CORRECTION_LABELS[correction.correctionKind] ?? correction.correctionKind }
  }

  /** WR-18：码已收货分组事实（再扫确认弹窗数据源：系统已记数量按组返回）。 */
  async codeReceivedSummary(
    auth: VerifiedAuthContext,
    query: { plantId: string; barcodeValue: string },
  ): Promise<Record<string, unknown> | null> {
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(query.plantId)) return null
    const groups = await this.deps.rv.pur.listReceivedGroupsByBarcode(query.plantId, query.barcodeValue)
    return {
      barcodeValue: query.barcodeValue,
      groups,
      systemRecordedQty: groups.reduce((acc, g) => (Number(acc) + Number(g.quantity)).toFixed(4), '0.0000'),
    }
  }

  // ---------------- 载具借还（WR-27） ----------------

  async listCarrierLoans(
    auth: VerifiedAuthContext,
    query: { plantId?: string; eventKinds?: string[]; page?: number; pageSize?: number },
  ): Promise<PageResult<Record<string, unknown>>> {
    const pageRequest = toPageRequest(query)
    const page = await this.deps.rv.carrierLoans.listPaged({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      eventKinds: query.eventKinds,
      ...pageRequest,
    })
    return {
      items: page.items.map((l) => ({ ...l, eventKindLabel: LOAN_LABELS[l.eventKind] ?? l.eventKind })),
      total: page.total,
      ...pageRequest,
    }
  }

  /** WR-27：本厂可用载具（借出/损坏/报废不计入）。 */
  async availableCarriers(
    auth: VerifiedAuthContext,
    query: { plantId: string },
  ): Promise<Record<string, unknown>[]> {
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(query.plantId)) return []
    const all = await this.deps.rv.carrierFacts.listAvailable(query.plantId)
    return all
      .filter((c) => isCarrierAvailableForPlant(c.status))
      .map((c) => ({ ...c, availableForPlant: true }))
  }

  // ---------------- 所有权三分视图（WR-26/A07：数量、位置、所有权分别可核对） ----------------

  async ownershipBalances(
    auth: VerifiedAuthContext,
    query: { plantId?: string; unitNo?: string },
  ): Promise<Record<string, unknown>[]> {
    const unitNo = like(query.unitNo)
    if (unitNo === undefined) return []
    const plants = query.plantId !== undefined ? [query.plantId] : this.plantScope(auth) ?? []
    const items: Record<string, unknown>[] = []
    for (const plantId of plants) {
      const unit = await this.deps.inv.units.findByUnitNo(plantId, unitNo)
      if (unit === null) continue
      const scope = this.plantScope(auth)
      if (scope !== null && !scope.includes(unit.plantId)) continue
      const balances = await this.deps.inv.balances.listActiveByUnit(unit.id)
      for (const balance of balances) {
        items.push({
          unitId: unit.id,
          unitNo: unit.unitNo,
          locationId: balance.locationId,
          locationCode: balance.locationCode,
          ownerId: balance.ownerId,
          ownerName: balance.ownerName,
          custodianPlantId: balance.plantId,
          quantity: balance.quantity,
          uomCode: balance.uomCode,
          qualityStatus: balance.qualityStatus,
        })
      }
    }
    return items
  }
}
