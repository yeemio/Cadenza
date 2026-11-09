import type { PageResult } from '@cadenza/contracts'
import {
  feetDisplayFromMeters,
  matchBarcodeKind,
  resolveBarcodeCandidates,
  evaluateAvailability,
  type BarcodeKind,
} from '@cadenza/domain'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  BarcodeRepository,
  CarrierRepository,
  GenealogyRepository,
  InventoryUnitRecord,
  InventoryBusinessHoldRecord,
  InventoryUnitRepository,
  MaterialLotRepository,
  MaterialSegmentRepository,
  ReservationRepository,
  StockBalanceRepository,
  StockTransactionRepository,
} from './inventory-repositories'

/**
 * inventory 域查询服务（读侧，池连接只读；IT-24：命令/查询入口同检——许可由 HTTP 守卫首检，
 * 数据范围在本服务内按授权上下文服务端过滤；IT-20：统计投影允许延迟，本服务直查账面余额）。
 */

export interface InventoryQueryDeps {
  lots: MaterialLotRepository
  units: InventoryUnitRepository
  segments: MaterialSegmentRepository
  balances: StockBalanceRepository
  transactions: StockTransactionRepository
  reservations: ReservationRepository
  barcodes: BarcodeRepository
  carriers: CarrierRepository
  genealogy: GenealogyRepository
}

export interface BalanceView {
  balanceId: string
  unitId: string
  unitNo: string
  materialCode: string
  lotNo: string
  locationCode: string
  ownerName: string
  quantity: string
  reservedQuantity: string
  businessHeld: boolean
  qualityHeld: boolean
  unavailableReasons: string[]
  availableQuantity: string
  uomCode: string
  qualityStatus: string
  status: string
  plantId: string
  feetDisplay: string
}

export interface BarcodeCandidateView {
  objectType: string
  objectId: string
  label: string
  via: 'direct_binding' | 'carrier_load'
}

export interface BarcodeResolveView {
  barcodeValue: string
  kind: { kind: string; confidence: string; matchedPattern: string | null }
  hasActiveBinding: boolean
  boundType: string | null
  boundId: string | null
  candidates: BarcodeCandidateView[]
}

export interface UnitDetailView {
  unitId: string
  unitNo: string
  materialCode: string
  lotNo: string
  traceMode: string
  status: string
  balanceOpen: boolean
  balances: Array<{ balanceId: string; locationCode: string; ownerName: string; quantity: string; qualityStatus: string; status: string }>
  businessHolds: InventoryBusinessHoldRecord[]
  activeReservations: Array<{ reservationId: string; holderType: string; holderRef: string; quantity: string; validUntil: string }>
  recentTransactions: Array<{
    transactionId: string
    lineNo: number
    movementKind: string
    quantity: string
    beforeQty: string
    afterQty: string
    businessTime: string
  }>
  genealogy: Array<{
    edgeId: string
    edgeKind: string
    fromType: string
    fromId: string
    toType: string
    toId: string
    quantity: string
  }>
}

function toPageRequest(query: { page?: unknown; pageSize?: unknown }): { page: number; pageSize: number } {
  const page = typeof query.page === 'number' && Number.isInteger(query.page) && query.page >= 1 ? query.page : 1
  const pageSize =
    typeof query.pageSize === 'number' && Number.isInteger(query.pageSize) && query.pageSize >= 1
      ? Math.min(query.pageSize, 100)
      : 20
  return { page, pageSize }
}

export class InventoryQueryService {
  constructor(private readonly deps: InventoryQueryDeps) {}

  /** 数据范围折算：企业范围 → null（不过滤）；否则限定授权工厂集合。 */
  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  /** 余额分页（IT-20 余额账面 + IT-14 可用量三段展示；IT-17 统计口径属展示层另行投影）。 */
  async listBalances(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      unitNoLike?: string
      materialCode?: string
      includeClosed?: boolean
      page?: number
      pageSize?: number
      now?: string
    },
  ): Promise<PageResult<BalanceView>> {
    const scope = this.plantScope(auth)
    // OA-24/25：显式工厂参数越范围由守卫 403；此处再按数据范围收敛（隐式过滤）
    const plantId = query.plantId !== undefined && (scope === null || scope.includes(query.plantId)) ? query.plantId : undefined
    const effectiveScope = scope === null ? undefined : plantId !== undefined ? [plantId] : scope
    const { page, pageSize } = toPageRequest(query)
    const now = query.now ?? new Date().toISOString()

    const { items, total } = await this.deps.balances.listPaged({
      enterpriseId: auth.user.enterpriseId,
      plantIds: effectiveScope ?? null,
      plantId,
      unitNoLike: query.unitNoLike,
      materialCode: query.materialCode,
      includeClosed: query.includeClosed ?? false,
      page,
      pageSize,
    })
    const views: BalanceView[] = []
    for (const b of items) {
      const unit = await this.deps.units.findById(b.unitId)
      const lot = unit === null ? null : await this.deps.lots.findById(unit.lotId)
      const reservations = await this.deps.reservations.listActiveByUnit(b.unitId)
      const qualityHeld = await this.deps.units.hasActiveQualityHold(b.unitId)
      const businessHolds = await this.deps.units.businessHolds(b.unitId)
      const availability = evaluateAvailability({
        grossQty: b.quantity,
        qualityStatus: b.qualityStatus,
        qualityHeld,
        businessHeld: businessHolds.length > 0,
        activeReservations: reservations.filter((r) => r.locationId === null || r.locationId === b.locationId),
        now,
      })
      views.push({
        balanceId: b.id,
        unitId: b.unitId,
        unitNo: unit?.unitNo ?? '',
        materialCode: unit?.materialCode ?? '',
        lotNo: lot?.lotNo ?? '',
        locationCode: b.locationCode,
        ownerName: b.ownerName,
        quantity: b.quantity,
        reservedQuantity: availability.reserved,
        businessHeld: businessHolds.length>0,
        qualityHeld,
        unavailableReasons: availability.reasons,
        availableQuantity: availability.available,
        uomCode: b.uomCode,
        qualityStatus: qualityHeld ? 'suspect' : b.qualityStatus,
        status: b.status,
        plantId: b.plantId,
        feetDisplay: feetDisplayFromMeters(b.quantity), // IT-10 展示列
      })
    }
    return { items: views, total, page, pageSize }
  }

  /** 按码解析候选对象（IT-04/05/06：barcode → binding → 候选集合，任务显式选择）。 */
  async resolveBarcode(auth: VerifiedAuthContext, barcodeValue: string): Promise<BarcodeResolveView> {
    const formats = await this.deps.barcodes.listFormatRules()
    const kind = matchBarcodeKind(barcodeValue, formats.map((f) => ({ ...f, labelKind: f.labelKind as BarcodeKind })))
    const binding = await this.deps.barcodes.findActiveBindingByValue(barcodeValue)
    const loadedUnits =
      binding?.boundType === 'carrier' ? await this.deps.carriers.listLoadedUnits(binding.boundId) : []
    const unitLabels: Record<string, string> = {}
    if (binding?.boundType === 'inventory_unit') {
      const unit = await this.deps.units.findById(binding.boundId)
      if (unit !== null) {
        // OA-24/25：绑定单元厂不在范围内 → 候选不展开（服务端过滤）
        const scope = this.plantScope(auth)
        if (scope === null || scope.includes(unit.plantId)) unitLabels[unit.id] = unit.unitNo
      }
    }
    const candidates = resolveBarcodeCandidates({
      activeBinding: binding === null ? null : { boundType: binding.boundType, boundId: binding.boundId },
      loadedUnits,
      unitLabels,
    })
    return {
      barcodeValue,
      kind: { kind: kind.kind, confidence: kind.confidence, matchedPattern: kind.matchedPattern ?? null },
      hasActiveBinding: binding !== null,
      boundType: binding?.boundType ?? null,
      boundId: binding?.boundId ?? null,
      candidates,
    }
  }

  /** 单元详情（身份 + 余额 + 预留 + 近期流水 + 谱系，IT-01/35）。 */
  async unitDetail(auth: VerifiedAuthContext, key: { unitId?: string; unitNo?: string }): Promise<UnitDetailView | null> {
    let unit: InventoryUnitRecord | null = null
    if (key.unitId !== undefined) {
      unit = await this.deps.units.findById(key.unitId)
    } else if (key.unitNo !== undefined) {
      // 企业范围授权 → 全企业反查；工厂范围授权 → 限定授权厂逐一反查（OA-24/25 服务端过滤）
      const scope = this.plantScope(auth)
      if (scope === null) {
        unit = await this.deps.units.findByUnitNoEnterprise(auth.user.enterpriseId, key.unitNo)
      } else {
        for (const plantId of scope) {
          unit = await this.deps.units.findByUnitNo(plantId, key.unitNo)
          if (unit !== null) break
        }
      }
    }
    if (unit === null) return null
    // OA-24/25：单元所属厂须在数据范围内（否则视为不可见）
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(unit.plantId)) return null

    const lot = await this.deps.lots.findById(unit.lotId)
    const allBalances = await this.deps.balances.listPaged({
      enterpriseId: auth.user.enterpriseId,
      plantIds: [unit.plantId],
      includeClosed: true,
      page: 1,
      pageSize: 100,
    })
    const unitBalances = allBalances.items.filter((b) => b.unitId === unit!.id)
    const reservations = await this.deps.reservations.listActiveByUnit(unit.id)
    const transactions = await this.deps.transactions.listByUnit(unit.id, 20)
    const edges = [
      ...(await this.deps.genealogy.listForward('inventory_unit', unit.id)),
      ...(await this.deps.genealogy.listBackward('inventory_unit', unit.id)),
      ...(await this.deps.genealogy.listBackward('material_lot', unit.lotId)).filter((e) => e.toId === unit!.id),
    ]
    return {
      unitId: unit.id,
      unitNo: unit.unitNo,
      materialCode: unit.materialCode,
      lotNo: lot?.lotNo ?? '',
      traceMode: unit.traceMode,
      status: unit.status,
      balanceOpen: unit.balanceOpen,
      balances: unitBalances.map((b) => ({
        balanceId: b.id,
        locationCode: b.locationCode,
        ownerName: b.ownerName,
        quantity: b.quantity,
        qualityStatus: b.qualityStatus,
        status: b.status,
      })),
      businessHolds: await this.deps.units.businessHolds(unit.id),
      activeReservations: reservations
        .filter((r) => r.status === 'active')
        .map((r) => ({
          reservationId: r.id,
          holderType: r.holderType,
          holderRef: r.holderRef,
          quantity: r.quantity,
          validUntil: r.validUntil,
        })),
      recentTransactions: transactions.map((t) => ({
        transactionId: t.id,
        lineNo: t.lineNo,
        movementKind: t.movementKind,
        quantity: t.quantity,
        beforeQty: t.beforeQty,
        afterQty: t.afterQty,
        businessTime: t.businessTime,
      })),
      genealogy: edges.map((e) => ({
        edgeId: e.id,
        edgeKind: e.edgeKind,
        fromType: e.fromType,
        fromId: e.fromId,
        toType: e.toType,
        toId: e.toId,
        quantity: e.quantity,
      })),
    }
  }
}
