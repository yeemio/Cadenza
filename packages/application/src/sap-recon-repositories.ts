import type { CommandTools } from './command-bus'

export interface SapReconciliationItemRecord {
  id: string
  reconNo: string
  objectCode: string
  objectName: string | null
  momQty: string | null
  sapQty: string | null
  diffQty: string | null
  currencyCode: string | null
  matchStatus: string
  /** G-B02 分类别名（= matchStatus） */
  classification?: string
  title: string
  reason: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  sapStockState?: string | null
  momHold?: boolean | null
  unknownSliceQty?: string | null
  createdAt: Date
  createdBy: string | null
  updatedAt: Date
  updatedBy: string | null
}

export interface NewSapReconciliationItem {
  id: string
  reconNo: string
  objectCode: string
  objectName?: string | null
  momQty?: string | null
  sapQty?: string | null
  diffQty?: string | null
  currencyCode?: string | null
  matchStatus: string
  title: string
  reason: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  createdBy: string
  commandReceiptId?: string | null
  sapStockState?: string | null
  momHold?: boolean | null
  unknownSliceQty?: string | null
}

export interface SapReconciliationFilter {
  plantIds: string[] | null
  plantId?: string
  matchStatus?: string
  limit: number
  offset: number
}

export interface SapReconciliationRepository {
  listPaged(filter: SapReconciliationFilter): Promise<{ total: number; items: SapReconciliationItemRecord[] }>
  insert(row: NewSapReconciliationItem): Promise<SapReconciliationItemRecord>
  /** 按 match_status 聚合计数（全量分类加深）。 */
  countByClassification(filter: {
    plantIds: string[] | null
    plantId?: string
  }): Promise<Record<string, number>>
}

export interface SapReconCommandTools extends CommandTools {
  sapReconciliation: SapReconciliationRepository
}
