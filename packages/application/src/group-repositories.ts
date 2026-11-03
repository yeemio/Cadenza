import type { CommandTools } from './command-bus'

/** 集团分配修订行（非成本分摊）。 */
export interface GroupAllocationRevisionRecord {
  id: string
  revisionNo: string
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

export interface NewGroupAllocationRevision {
  id: string
  revisionNo: string
  title: string
  reason: string
  status: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  createdBy: string
  commandReceiptId?: string | null
}

export interface GroupAllocationRevisionFilter {
  plantIds: string[] | null
  plantId?: string
  status?: string
  limit: number
  offset: number
}

export interface GroupAllocationRevisionRepository {
  listPaged(filter: GroupAllocationRevisionFilter): Promise<{ total: number; items: GroupAllocationRevisionRecord[] }>
  findById(id: string): Promise<GroupAllocationRevisionRecord | null>
  insert(row: NewGroupAllocationRevision): Promise<GroupAllocationRevisionRecord>
}

/** 缺料/齐套检查结果行。 */
export interface GroupShortageKittingRecord {
  id: string
  orderNo: string
  orderId: string | null
  checkStatus: string
  shortageLines: unknown[]
  checkedAt: Date
  enterpriseId: string
  plantId: string
  createdAt: Date
  createdBy: string | null
}

export interface NewGroupShortageKittingResult {
  id: string
  orderNo: string
  orderId?: string | null
  checkStatus: string
  shortageLines: unknown[]
  enterpriseId: string
  plantId: string
  createdBy: string
  commandReceiptId?: string | null
}

export interface GroupShortageKittingFilter {
  plantIds: string[] | null
  plantId?: string
  orderNoLike?: string
  limit: number
  offset: number
}

export interface GroupShortageKittingRepository {
  listPaged(filter: GroupShortageKittingFilter): Promise<{ total: number; items: GroupShortageKittingRecord[] }>
  insert(row: NewGroupShortageKittingResult): Promise<GroupShortageKittingRecord>
}

export interface GroupCommandTools extends CommandTools {
  allocationRevisions: GroupAllocationRevisionRepository
  shortageKitting: GroupShortageKittingRepository
  productRecalls: GroupProductRecallRepository
  vendorRisks: GroupVendorRiskRepository
  reworkWrites: GroupReworkWriteRepository
  scrapWrites: GroupScrapWriteRepository
}


export interface GroupProductRecallRecord {
  id: string
  recallNo: string
  recallScope: string
  batchNo: string | null
  materialCode: string | null
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

export interface NewGroupProductRecall {
  id: string
  recallNo: string
  recallScope: string
  batchNo?: string | null
  materialCode?: string | null
  title: string
  reason: string
  status: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  createdBy: string
  commandReceiptId?: string | null
}

export interface GroupProductRecallFilter {
  plantIds: string[] | null
  plantId?: string
  status?: string
  limit: number
  offset: number
}

export interface GroupProductRecallRepository {
  listPaged(filter: GroupProductRecallFilter): Promise<{ total: number; items: GroupProductRecallRecord[] }>
  findById(id: string): Promise<GroupProductRecallRecord | null>
  insert(row: NewGroupProductRecall): Promise<GroupProductRecallRecord>
  findByIdForUpdate(id: string): Promise<GroupProductRecallRecord | null>
  updateState(id: string, status: string, payload: Record<string, unknown>, actor: string): Promise<GroupProductRecallRecord>

}

export interface GroupVendorRiskRecord {
  id: string
  riskNo: string
  vendorCode: string
  vendorName: string | null
  riskLevel: string
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

export interface NewGroupVendorRisk {
  id: string
  riskNo: string
  vendorCode: string
  vendorName?: string | null
  riskLevel: string
  title: string
  reason: string
  status: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  createdBy: string
  commandReceiptId?: string | null
}

export interface GroupVendorRiskFilter {
  plantIds: string[] | null
  plantId?: string
  vendorCodeLike?: string
  riskLevel?: string
  limit: number
  offset: number
}

export interface GroupVendorRiskRepository {
  listPaged(filter: GroupVendorRiskFilter): Promise<{ total: number; items: GroupVendorRiskRecord[] }>
  insert(row: NewGroupVendorRisk): Promise<GroupVendorRiskRecord>
}


export interface GroupReworkWriteRecord {
  id: string
  reworkNo: string
  title: string
  reason: string
  unitNo: string | null
  batchNo: string | null
  materialCode: string | null
  status: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  createdAt: Date
  createdBy: string | null
  updatedAt: Date
  updatedBy: string | null
}

export interface NewGroupReworkWrite {
  id: string
  reworkNo: string
  title: string
  reason: string
  unitNo?: string | null
  batchNo?: string | null
  materialCode?: string | null
  status: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  createdBy: string
  commandReceiptId?: string | null
}

export interface GroupReworkWriteFilter {
  plantIds: string[] | null
  plantId?: string
  status?: string
  limit: number
  offset: number
}

export interface GroupReworkWriteRepository {
  listPaged(filter: GroupReworkWriteFilter): Promise<{ total: number; items: GroupReworkWriteRecord[] }>
  insert(row: NewGroupReworkWrite): Promise<GroupReworkWriteRecord>
}

export interface GroupScrapWriteRecord {
  id: string
  scrapNo: string
  title: string
  reason: string
  unitNo: string | null
  batchNo: string | null
  materialCode: string | null
  scrapQty: string | null
  status: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  createdAt: Date
  createdBy: string | null
  updatedAt: Date
  updatedBy: string | null
}

export interface NewGroupScrapWrite {
  id: string
  scrapNo: string
  title: string
  reason: string
  unitNo?: string | null
  batchNo?: string | null
  materialCode?: string | null
  scrapQty?: string | null
  status: string
  payload: Record<string, unknown>
  enterpriseId: string
  plantId: string
  createdBy: string
  commandReceiptId?: string | null
}

export interface GroupScrapWriteFilter {
  plantIds: string[] | null
  plantId?: string
  status?: string
  limit: number
  offset: number
}

export interface GroupScrapWriteRepository {
  listPaged(filter: GroupScrapWriteFilter): Promise<{ total: number; items: GroupScrapWriteRecord[] }>
  insert(row: NewGroupScrapWrite): Promise<GroupScrapWriteRecord>
}
