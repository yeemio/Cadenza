import type { VerifiedAuthContext } from './session-verifier'
import type { FeedRacePlanRepository } from './production-repositories'

/**
 * production 域查询：投料竞争/计划部分/迟修订列表。
 * 空库 200 空分页；数据范围服务端过滤。
 */
export class ProductionQueryService {
  constructor(
    private readonly deps: {
      feedRacePlans: FeedRacePlanRepository
    },
  ) {}

  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  async listFeedRacePlans(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; planKind?: string; status?: string; page?: number; pageSize?: number },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const { total, items } = await this.deps.feedRacePlans.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      planKind: filter.planKind,
      status: filter.status,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return { page, pageSize, total, items }
  }
}
