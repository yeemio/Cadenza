import type { VerifiedAuthContext } from './session-verifier'
import type { SapReconciliationRepository } from './sap-recon-repositories'

export class SapReconQueryService {
  constructor(private readonly deps: { sapReconciliation: SapReconciliationRepository }) {}

  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  async list(
    auth: VerifiedAuthContext,
    filter: {
      plantId?: string
      matchStatus?: string
      classification?: string
      page?: number
      pageSize?: number
    },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const plantIds = this.plantScope(auth)
    const matchStatus = filter.matchStatus ?? filter.classification
    const { total, items } = await this.deps.sapReconciliation.listPaged({
      plantIds,
      plantId: filter.plantId,
      matchStatus,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    const byClassification = await this.deps.sapReconciliation.countByClassification({
      plantIds,
      plantId: filter.plantId,
    })
    const enriched = items.map((it) => ({
      ...it,
      classification: it.classification ?? it.matchStatus,
    }))
    return {
      page,
      pageSize,
      total,
      items: enriched,
      byClassification,
      actual_connection: false,
      boundary:
        'SAP_SIM full recon classification (G-B02-aligned); ≠ /cost/recon-items；≠ fixture；≠ REAL-SAP；≠ 21-object product PASS',
    }
  }
}
