
import type { CommandTools } from './command-bus'

export interface FeedRacePlanRecord {
  id: string
  planNo: string
  planKind: string
  title: string
  reason: string
  status: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  createdAt: Date
  createdBy: string | null
  updatedAt: Date
  updatedBy: string | null
}

export interface NewFeedRacePlan {
  id: string
  planNo: string
  planKind: string
  title: string
  reason: string
  status: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  createdBy: string
  commandReceiptId?: string | null
}

export interface FeedRacePlanFilter {
  plantIds: string[] | null
  plantId?: string
  planKind?: string
  status?: string
  limit: number
  offset: number
}

export interface FeedRacePlanRepository {
  listPaged(filter: FeedRacePlanFilter): Promise<{ total: number; items: FeedRacePlanRecord[] }>
  insert(row: NewFeedRacePlan): Promise<FeedRacePlanRecord>
}

export interface ProductionCommandTools extends CommandTools {
  feedRacePlans: FeedRacePlanRepository
}
