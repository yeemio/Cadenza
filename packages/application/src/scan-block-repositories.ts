
import type { CommandTools } from './command-bus'

export interface ScanBlockEventRecord {
  id: string
  eventNo: string
  policyCode: string
  scanCode: string
  blockReason: string
  severity: string
  status: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  createdAt: Date
  createdBy: string | null
  updatedAt: Date
  updatedBy: string | null
}

export interface NewScanBlockEvent {
  id: string
  eventNo: string
  policyCode: string
  scanCode: string
  blockReason: string
  severity: string
  status: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  createdBy: string
  commandReceiptId?: string | null
}

export interface ScanBlockEventFilter {
  plantIds: string[] | null
  plantId?: string
  policyCode?: string
  status?: string
  limit: number
  offset: number
}

export interface ScanBlockEventRepository {
  listPaged(filter: ScanBlockEventFilter): Promise<{ total: number; items: ScanBlockEventRecord[] }>
  insert(row: NewScanBlockEvent): Promise<ScanBlockEventRecord>
}

export interface ScanBlockCommandTools extends CommandTools {
  scanBlockEvents: ScanBlockEventRepository
}
