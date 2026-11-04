import type { CommandTools } from './command-bus'
import type { QualityStatus, ReservationLike } from '@cadenza/domain'

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
  enterpriseId: string
  plantIds: string[] | null
  plantId?: string
  orderNoLike?: string
  limit: number
  offset: number
}

export interface GroupKittingFacts {
  order: { id: string; enterpriseId: string; plantId: string; orderNo: string; materialId: string; quantity: string; uom: string; settingsVersion: number; bomRevisionId: string | null; status: string; operationCount: number; operationBomIds: string[] } | null
  bom: { id: string; enterpriseId: string; plantId: string; materialId: string; version: number; status: string; publishedAt: string | null; lines: unknown[] } | null
  materials: Array<{ id: string; code: string; baseUom: string; status: string; conversions: Array<{ id: string; version: number; unitName: string; factor: string }> }>
  stocks: Array<{ unitId: string; materialId: string; uom: string; quantity: string; qualityStatus: QualityStatus; unitStatus: string; qualityHeld: boolean; businessHeld: boolean; measurementKnown: boolean; conversionRevisionId?: string | null; conversionFactor?: string | null; reservations: ReservationLike[] }>
}
export interface GroupKittingBasis { outputQuantity: string; outputUom: string }
export interface GroupKittingCalculation {
  requirementBasis: 'FULL_ORDER_BOM'
  stockScope: 'CURRENT_FACTORY_UNRESERVED'
  outcome: 'KIT_COMPLETE' | 'SHORTAGE' | 'ORDER_NOT_FOUND' | 'MISSING_DATA' | 'UNCONVERTIBLE'
  checkStatus: 'ok' | 'shortage' | 'error'
  reason: string | null
  orderId: string | null
  settingsVersion: number | null
  bomRevisionId: string | null
  bomVersion: number | null
  basis: GroupKittingBasis | null
  evaluatedAt: string
  lines: Array<{ materialId: string; materialCode: string; uom: string; required: string; available: string; shortage: string; eligibleUnitIds: string[]; excludedUnitIds: string[] }>
}

export interface GroupShortageKittingRepository {
  /** One statement snapshot, already restricted to actual enterprise/factory/order. */
  readFacts(enterpriseId: string, plantId: string, orderNo: string): Promise<GroupKittingFacts>
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
