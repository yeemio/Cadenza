import type { VerifiedAuthContext } from './session-verifier'
import type { ScanBlockEventRepository } from './scan-block-repositories'

/**
 * SCAN-BLOCK 域查询：拦截事件列表。空库 200 空分页。
 */
export class ScanBlockQueryService {
  constructor(
    private readonly deps: {
      scanBlockEvents: ScanBlockEventRepository
    },
  ) {}

  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  async listEvents(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; policyCode?: string; status?: string; page?: number; pageSize?: number },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const { total, items } = await this.deps.scanBlockEvents.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      policyCode: filter.policyCode,
      status: filter.status,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return { page, pageSize, total, items }
  }
}
