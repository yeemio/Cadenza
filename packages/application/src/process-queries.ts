import type { PageRequest, PageResult } from '@cadenza/contracts'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  BomRevisionRecord,
  OperationDefinitionRecord,
  OrderOperationRecord,
  ParameterSpecRevisionRecord,
  ProcessConfigStatus,
  ProcessMasterStatus,
  ProcessRepositories,
  ProcessRevisionStatus,
  ProductFamilyRecord,
  ProductionOrderRecord,
  ProductionOrderStatus,
  RouteRevisionRecord,
} from './process-repositories'

/**
 * process 域查询服务：分页 + 按授权数据范围服务端过滤
 * （OA-24/25 六类入口同一范围检查；全部对象按 plant_id 收敛——产品族/工艺版本/
 * 工序主数据/生产订单均为厂级隔离对象，料品快照随订单行返回不另查）。
 */

export interface ProcessQueryDeps {
  process: ProcessRepositories
}

export type ProductFamilyView = Omit<ProductFamilyRecord, 'enterpriseId' | 'deletedAt' | 'createdBy' | 'updatedBy'>
export type BomRevisionView = Omit<BomRevisionRecord, 'enterpriseId' | 'createdBy' | 'updatedBy' | 'publishedBy'>
export type RouteRevisionView = Omit<RouteRevisionRecord, 'enterpriseId' | 'createdBy' | 'updatedBy' | 'publishedBy'>
export type ParameterSpecView = Omit<ParameterSpecRevisionRecord, 'enterpriseId' | 'createdBy' | 'updatedBy' | 'publishedBy'>
export type OperationDefinitionView = Omit<OperationDefinitionRecord, 'enterpriseId' | 'deletedAt' | 'createdBy' | 'updatedBy'>
export type ProductionOrderView = Omit<ProductionOrderRecord, 'enterpriseId' | 'createdBy' | 'updatedBy'>
export type OrderOperationView = Omit<OrderOperationRecord, 'enterpriseId' | 'createdBy' | 'updatedBy'>

function toPageRequest(query: { page?: unknown; pageSize?: unknown }): PageRequest {
  const page = typeof query.page === 'number' && Number.isInteger(query.page) && query.page >= 1 ? query.page : 1
  const pageSize =
    typeof query.pageSize === 'number' && Number.isInteger(query.pageSize) && query.pageSize >= 1
      ? Math.min(query.pageSize, 100)
      : 20
  return { page, pageSize }
}

const like = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export class ProcessQueryService {
  constructor(private readonly deps: ProcessQueryDeps) {}

  private repos(): ProcessRepositories {
    return this.deps.process
  }

  /**
   * plant 过滤口径：显式 plantId 已由 ScopeGuard 校验在范围内（越范围 403）；
   * 未指定时按数据范围收敛（企业范围 = null 全量；OA-25 纵深防御同口径）。
   */
  private plantFilter(auth: VerifiedAuthContext, plantId: unknown): string[] | null {
    if (typeof plantId === 'string' && plantId.length > 0) return [plantId]
    const scope = auth.dataScope
    return scope.enterpriseWide ? null : scope.plantIds
  }

  private emptyPage<T>(pageRequest: PageRequest): PageResult<T> {
    return { items: [], total: 0, ...pageRequest }
  }

  /** 产品族分页。 */
  async listFamilies(
    auth: VerifiedAuthContext,
    query: { plantId?: string; nameLike?: string; codeLike?: string; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<ProductFamilyView>> {
    const pageRequest = toPageRequest(query)
    const plantIds = this.plantFilter(auth, query.plantId)
    if (plantIds !== null && plantIds.length === 0) return this.emptyPage(pageRequest)
    const page = await this.repos().families.list({
      plantIds,
      nameLike: like(query.nameLike),
      codeLike: like(query.codeLike),
      ...pageRequest,
    })
    return {
      items: page.items.map((r) => ({ ...r, status: r.status as ProcessMasterStatus })),
      total: page.total,
      ...pageRequest,
    }
  }

  /** 制造 BOM 版本分页（可按产品族/状态收敛）。 */
  async listBoms(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      productFamilyId?: string
      status?: string
      page?: unknown
      pageSize?: unknown
    },
  ): Promise<PageResult<BomRevisionView>> {
    const pageRequest = toPageRequest(query)
    const plantIds = this.plantFilter(auth, query.plantId)
    if (plantIds !== null && plantIds.length === 0) return this.emptyPage(pageRequest)
    const page = await this.repos().boms.list({
      plantIds,
      productFamilyId: like(query.productFamilyId),
      status: this.statusFilter(query.status),
      ...pageRequest,
    })
    return {
      items: page.items.map((r) => ({ ...r, status: r.status as ProcessRevisionStatus })),
      total: page.total,
      ...pageRequest,
    }
  }

  /** 工艺路线版本分页。 */
  async listRoutes(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      productFamilyId?: string
      status?: string
      page?: unknown
      pageSize?: unknown
    },
  ): Promise<PageResult<RouteRevisionView>> {
    const pageRequest = toPageRequest(query)
    const plantIds = this.plantFilter(auth, query.plantId)
    if (plantIds !== null && plantIds.length === 0) return this.emptyPage(pageRequest)
    const page = await this.repos().routes.list({
      plantIds,
      productFamilyId: like(query.productFamilyId),
      status: this.statusFilter(query.status),
      ...pageRequest,
    })
    return {
      items: page.items.map((r) => ({ ...r, status: r.status as ProcessRevisionStatus })),
      total: page.total,
      ...pageRequest,
    }
  }

  /** 参数规范版本分页。 */
  async listParameters(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      productFamilyId?: string
      status?: string
      page?: unknown
      pageSize?: unknown
    },
  ): Promise<PageResult<ParameterSpecView>> {
    const pageRequest = toPageRequest(query)
    const plantIds = this.plantFilter(auth, query.plantId)
    if (plantIds !== null && plantIds.length === 0) return this.emptyPage(pageRequest)
    const page = await this.repos().parameters.list({
      plantIds,
      productFamilyId: like(query.productFamilyId),
      status: this.statusFilter(query.status),
      ...pageRequest,
    })
    return {
      items: page.items.map((r) => ({ ...r, status: r.status as ProcessRevisionStatus })),
      total: page.total,
      ...pageRequest,
    }
  }

  /** 工序主数据分页（A1-3：供工艺配置/订单工序选择）。 */
  async listOperations(
    auth: VerifiedAuthContext,
    query: { plantId?: string; nameLike?: string; codeLike?: string; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<OperationDefinitionView>> {
    const pageRequest = toPageRequest(query)
    const plantIds = this.plantFilter(auth, query.plantId)
    if (plantIds !== null && plantIds.length === 0) return this.emptyPage(pageRequest)
    const page = await this.repos().operations.list({
      plantIds,
      nameLike: like(query.nameLike),
      codeLike: like(query.codeLike),
      ...pageRequest,
    })
    return {
      items: page.items.map((r) => ({ ...r, status: r.status as ProcessMasterStatus })),
      total: page.total,
      ...pageRequest,
    }
  }

  /**
   * 生产订单分页（[底稿 A1-1] 列表口径：生产单号模糊、状态多选、挂起过滤；
   * 按数据范围服务端过滤——跨厂 403 与列表过滤证据位）。
   */
  async listOrders(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      orderNoLike?: string
      statuses?: string
      suspended?: boolean
      page?: unknown
      pageSize?: unknown
    },
  ): Promise<PageResult<ProductionOrderView>> {
    const pageRequest = toPageRequest(query)
    const plantIds = this.plantFilter(auth, query.plantId)
    if (plantIds !== null && plantIds.length === 0) return this.emptyPage(pageRequest)
    const statuses = this.parseStatuses(query.statuses)
    const page = await this.repos().orders.list({
      plantIds,
      orderNoLike: like(query.orderNoLike),
      statuses,
      suspended: query.suspended,
      ...pageRequest,
    })
    return {
      items: page.items.map((r) => ({
        ...r,
        orderStatus: r.orderStatus as ProductionOrderStatus,
        processConfigStatus: r.processConfigStatus as ProcessConfigStatus,
      })),
      total: page.total,
      ...pageRequest,
    }
  }

  /**
   * 订单详情 + 订单工序明细（[底稿 A2-3] 快照行按 seq/settingsVersion 升序全量返回；
   * 变更版本行并列保留，报工域落地后按 execution_status 区分）。
   */
  async getOrderDetail(
    auth: VerifiedAuthContext,
    orderId: string,
  ): Promise<{ order: ProductionOrderView | null; operations: OrderOperationView[] }> {
    const order = await this.repos().orders.findById(orderId)
    if (order === null || order.enterpriseId !== auth.user.enterpriseId) {
      return { order: null, operations: [] }
    }
    // 纵深防御：订单厂不在数据范围时按不存在处理（列表过滤同口径）
    const scope = auth.dataScope
    if (!scope.enterpriseWide && !scope.plantIds.includes(order.plantId)) {
      return { order: null, operations: [] }
    }
    const operations = await this.repos().orderOperations.listByOrder(orderId)
    return {
      order: {
        ...order,
        orderStatus: order.orderStatus as ProductionOrderStatus,
        processConfigStatus: order.processConfigStatus as ProcessConfigStatus,
      },
      operations: operations.map((r) => ({ ...r })),
    }
  }

  /** 状态多选（逗号分隔；非法值忽略）。 */
  private parseStatuses(raw: unknown): ProductionOrderStatus[] | undefined {
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    const allowed: readonly string[] = [
      'approved',
      'released',
      'in_progress',
      'pending_completion',
      'closed',
      'voided',
    ]
    const values = raw
      .split(',')
      .map((v) => v.trim())
      .filter((v) => allowed.includes(v))
    return values.length > 0 ? (values as ProductionOrderStatus[]) : undefined
  }

  /** 版本状态过滤（非法值忽略）。 */
  private statusFilter(raw: unknown): ProcessRevisionStatus | undefined {
    if (typeof raw !== 'string') return undefined
    const allowed: readonly string[] = ['draft', 'reviewed', 'published', 'retired']
    return allowed.includes(raw) ? (raw as ProcessRevisionStatus) : undefined
  }
}
