import type { PageResult } from '@cadenza/contracts'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  DispositionRepository,
  InspectionOrderRepository,
  QualityHoldRecord,
  QualityHoldRepository,
  TestResultRepository,
} from './quality-repositories'
import type { InspectionOrderRecord, TestResultRecord } from './quality-repositories'

/**
 * quality 域查询服务（读侧，池连接只读；许可由 HTTP 守卫首检，数据范围在本服务内
 * 按授权上下文服务端过滤——检验单/存疑记录按 plant 收敛，与 purchase 查询同口径）。
 */

export interface QualityQueryDeps {
  inspectionOrders: InspectionOrderRepository
  testResults: TestResultRepository
  dispositions: DispositionRepository
  holds: QualityHoldRepository
}

export type InspectionOrderView = Omit<InspectionOrderRecord, 'enterpriseId' | 'businessTime' | 'createdAt' | 'updatedAt'>

export type QualityHoldView = Omit<QualityHoldRecord, 'enterpriseId' | 'createdAt'> & {
  holdKindLabel: string
}

const HOLD_KIND_LABELS: Readonly<Record<string, string>> = {
  pending_inspection: '待检隔离',
  unqualified: '不合格隔离',
  suspect: '质量存疑',
}

const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: '待检',
  in_progress: '检验中',
  concluded: '已出结论',
  cancelled: '已作废',
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

export class QualityQueryService {
  constructor(private readonly deps: QualityQueryDeps) {}

  /** 数据范围折算：企业范围 → null（不过滤）；否则限定授权工厂集合。 */
  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  /** 检验任务分页（A-T12-5：来源/阶段/规范版本化 + 生效结论投影）。 */
  async listInspectionOrders(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      statuses?: string[]
      stages?: string[]
      orderNoLike?: string
      page?: number
      pageSize?: number
    },
  ): Promise<PageResult<InspectionOrderView>> {
    const pageRequest = toPageRequest(query)
    const scope = this.plantScope(auth)
    const page = await this.deps.inspectionOrders.listPaged({
      plantIds: scope,
      plantId: query.plantId,
      statuses: query.statuses,
      stages: query.stages,
      orderNoLike: like(query.orderNoLike),
      ...pageRequest,
    })
    return { items: page.items.map(toOrderView), total: page.total, ...pageRequest }
  }

  /**
   * 检验单详情：结论版本链（S14 全量含生效指针）+ 实测明细 + 处置记录（放行/让步，
   * 让步 based_on_version 保留原不合格事实链接）。范围外返回 null。
   */
  async inspectionDetail(
    auth: VerifiedAuthContext,
    inspectionOrderId: string,
  ): Promise<(InspectionOrderView & {
    statusLabel: string
    results: Array<{
      resultId: string
      version: number
      resultKind: string
      conclusion: string
      items: unknown
      isEffective: boolean
      inspector: string | null
      inspectedAt: string | null
    }>
    dispositions: Array<{
      dispositionId: string
      dispositionKind: string
      basedOnVersion: number
      releasedBy: string
      releasedAt: string
      reason: string | null
    }>
  }) | null> {
    const order = await this.deps.inspectionOrders.findById(inspectionOrderId)
    if (order === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(order.plantId)) return null
    const results = await this.deps.testResults.listByOrder(order.id)
    const dispositions = await this.deps.dispositions.listByOrder(order.id)
    return {
      ...toOrderView(order),
      statusLabel: ORDER_STATUS_LABELS[order.status] ?? order.status,
      results: results.map(toResultView),
      dispositions: dispositions.map((d) => ({
        dispositionId: d.id,
        dispositionKind: d.dispositionKind,
        basedOnVersion: d.basedOnVersion,
        releasedBy: d.releasedBy,
        releasedAt: d.releasedAt,
        reason: d.reason,
      })),
    }
  }

  /** 隔离/存疑记录分页（A-T12-2/3）。 */
  async listHolds(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      statuses?: string[]
      holdKinds?: string[]
      page?: number
      pageSize?: number
    },
  ): Promise<PageResult<QualityHoldView>> {
    const pageRequest = toPageRequest(query)
    const scope = this.plantScope(auth)
    const page = await this.deps.holds.listPaged({
      plantIds: scope,
      plantId: query.plantId,
      statuses: query.statuses,
      holdKinds: query.holdKinds,
      ...pageRequest,
    })
    return {
      items: page.items.map((h) => ({
        id: h.id,
        inventoryUnitId: h.inventoryUnitId,
        unitNo: h.unitNo,
        holdKind: h.holdKind,
        holdKindLabel: HOLD_KIND_LABELS[h.holdKind] ?? h.holdKind,
        status: h.status,
        previousQualityStatus: h.previousQualityStatus,
        raisedBy: h.raisedBy,
        raisedAt: h.raisedAt,
        productionDeptId: h.productionDeptId,
        productionDeptName: h.productionDeptName,
        releasedBy: h.releasedBy,
        releasedAt: h.releasedAt,
        dispositionNote: h.dispositionNote,
        commandReceiptId: h.commandReceiptId,
        plantId: h.plantId,
        enterpriseId: h.enterpriseId,
        businessTime: h.businessTime,
      })),
      total: page.total,
      ...pageRequest,
    }
  }
}

function toOrderView(order: InspectionOrderRecord): InspectionOrderView {
  return {
    id: order.id,
    orderNo: order.orderNo,
    sourceType: order.sourceType,
    sourceRef: order.sourceRef,
    inspectionStage: order.inspectionStage,
    specCode: order.specCode,
    specVersion: order.specVersion,
    inventoryUnitId: order.inventoryUnitId,
    unitNo: order.unitNo,
    materialId: order.materialId,
    materialCode: order.materialCode,
    lotId: order.lotId,
    quantity: order.quantity,
    uomId: order.uomId,
    uomCode: order.uomCode,
    status: order.status,
    productionOrderNo: order.productionOrderNo,
    productionDeptId: order.productionDeptId,
    productionDeptName: order.productionDeptName,
    plantId: order.plantId,
  }
}

function toResultView(r: TestResultRecord): {
  resultId: string
  version: number
  resultKind: string
  conclusion: string
  items: unknown
  isEffective: boolean
  inspector: string | null
  inspectedAt: string | null
} {
  return {
    resultId: r.id,
    version: r.version,
    resultKind: r.resultKind,
    conclusion: r.conclusion,
    items: r.items,
    isEffective: r.isEffective,
    inspector: r.inspector,
    inspectedAt: r.inspectedAt,
  }
}
