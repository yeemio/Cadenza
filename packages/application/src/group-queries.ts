import type { VerifiedAuthContext } from './session-verifier'
import type {
  GroupAllocationRevisionRepository,
  GroupShortageKittingRepository,
  GroupProductRecallRepository,
  GroupVendorRiskRepository,
  GroupReworkWriteRepository,
  GroupScrapWriteRepository,
} from './group-repositories'

/**
 * group 域查询：分配修订 / 缺料齐套 / 成品召回 / 供应商风险 / 返工写 / 报废写。
 * 空库返回 200 空分页；数据范围服务端过滤（OA-24/25）。
 */
export class GroupQueryService {
  constructor(
    private readonly deps: {
      allocationRevisions: GroupAllocationRevisionRepository
      shortageKitting: GroupShortageKittingRepository
      productRecalls: GroupProductRecallRepository
      vendorRisks: GroupVendorRiskRepository
      reworkWrites: GroupReworkWriteRepository
      scrapWrites: GroupScrapWriteRepository
    },
  ) {}

  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  async listAllocationRevisions(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; status?: string; page?: number; pageSize?: number },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const { total, items } = await this.deps.allocationRevisions.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      status: filter.status,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return { page, pageSize, total, items }
  }

  async getAllocationRevision(auth: VerifiedAuthContext, id: string) {
    const row = await this.deps.allocationRevisions.findById(id)
    if (row === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(row.plantId)) return null
    return row
  }

  async listShortageKitting(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; orderNoLike?: string; page?: number; pageSize?: number },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const { total, items } = await this.deps.shortageKitting.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      orderNoLike: filter.orderNoLike,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return { page, pageSize, total, items }
  }

  async listProductRecalls(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; status?: string; page?: number; pageSize?: number },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const { total, items } = await this.deps.productRecalls.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      status: filter.status,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return { page, pageSize, total, items }
  }

  async getProductRecall(auth: VerifiedAuthContext, id: string) {
    const row = await this.deps.productRecalls.findById(id)
    if (row === null) return null
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(row.plantId)) return null
    return row
  }

  async listVendorRisks(
    auth: VerifiedAuthContext,
    filter: {
      plantId?: string
      vendorCodeLike?: string
      riskLevel?: string
      page?: number
      pageSize?: number
    },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const { total, items } = await this.deps.vendorRisks.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      vendorCodeLike: filter.vendorCodeLike,
      riskLevel: filter.riskLevel,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return { page, pageSize, total, items }
  }

  async listReworkWrites(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; status?: string; page?: number; pageSize?: number },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const { total, items } = await this.deps.reworkWrites.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      status: filter.status,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return { page, pageSize, total, items }
  }

  async listScrapWrites(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; status?: string; page?: number; pageSize?: number },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const { total, items } = await this.deps.scrapWrites.listPaged({
      plantIds: this.plantScope(auth),
      plantId: filter.plantId,
      status: filter.status,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return { page, pageSize, total, items }
  }
}
