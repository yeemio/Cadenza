import { loadSession } from './api'

const env = import.meta.env as Record<string, string | undefined>
const baseURL = env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001'

export interface GroupPageResult<T> {
  page: number
  pageSize: number
  total: number
  items: T[]
}

async function groupRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = loadSession()?.token
  const res = await fetch(`${baseURL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { message: text }
  }
  if (!res.ok) {
    const err = data as { message?: string; code?: string }
    throw new Error(err?.message ?? `HTTP ${res.status}`)
  }
  return data as T
}

export function listAllocationRevisions(query?: {
  page?: number
  pageSize?: number
  plantId?: string
}): Promise<GroupPageResult<Record<string, unknown>>> {
  const q = new URLSearchParams()
  if (query?.page) q.set('page', String(query.page))
  if (query?.pageSize) q.set('pageSize', String(query.pageSize))
  if (query?.plantId) q.set('plantId', query.plantId)
  const qs = q.toString()
  return groupRequest('GET', `/group/allocation-revisions${qs ? `?${qs}` : ''}`)
}

export function listShortageKitting(query?: {
  page?: number
  pageSize?: number
  plantId?: string
}): Promise<GroupPageResult<Record<string, unknown>>> {
  const q = new URLSearchParams()
  if (query?.page) q.set('page', String(query.page))
  if (query?.pageSize) q.set('pageSize', String(query.pageSize))
  if (query?.plantId) q.set('plantId', query.plantId)
  const qs = q.toString()
  return groupRequest('GET', `/group/shortage-kitting${qs ? `?${qs}` : ''}`)
}

export function listProductRecalls(query?: {
  page?: number
  pageSize?: number
  plantId?: string
  status?: string
}): Promise<GroupPageResult<Record<string, unknown>>> {
  const q = new URLSearchParams()
  if (query?.page) q.set('page', String(query.page))
  if (query?.pageSize) q.set('pageSize', String(query.pageSize))
  if (query?.plantId) q.set('plantId', query.plantId)
  if (query?.status) q.set('status', query.status)
  const qs = q.toString()
  return groupRequest('GET', `/group/recalls${qs ? `?${qs}` : ''}`)
}

export function getProductRecall(id: string): Promise<Record<string, unknown>> {
  return groupRequest('GET', `/group/recalls/${encodeURIComponent(id)}`)
}

export function listVendorRisks(query?: {
  page?: number
  pageSize?: number
  plantId?: string
  vendorCodeLike?: string
  riskLevel?: string
}): Promise<GroupPageResult<Record<string, unknown>>> {
  const q = new URLSearchParams()
  if (query?.page) q.set('page', String(query.page))
  if (query?.pageSize) q.set('pageSize', String(query.pageSize))
  if (query?.plantId) q.set('plantId', query.plantId)
  if (query?.vendorCodeLike) q.set('vendorCodeLike', query.vendorCodeLike)
  if (query?.riskLevel) q.set('riskLevel', query.riskLevel)
  const qs = q.toString()
  return groupRequest('GET', `/group/vendor-risks${qs ? `?${qs}` : ''}`)
}

/** SAP 双账/对账列表（GET /sap/reconciliation；≠ /cost/recon-items） */
export interface SapReconciliationListResult {
  page: number
  pageSize: number
  total: number
  items: Record<string, unknown>[]
  /** G-B02 分类聚合（全量；筛选时仍返回全集计数） */
  byClassification?: Record<string, number>
  actual_connection?: boolean
  boundary?: string
}

export function listSapReconciliation(query?: {
  page?: number
  pageSize?: number
  plantId?: string
  matchStatus?: string
  /** 与 matchStatus 同义；优先走 classification query */
  classification?: string
}): Promise<SapReconciliationListResult> {
  const q = new URLSearchParams()
  if (query?.page) q.set('page', String(query.page))
  if (query?.pageSize) q.set('pageSize', String(query.pageSize))
  if (query?.plantId) q.set('plantId', query.plantId)
  if (query?.classification) q.set('classification', query.classification)
  else if (query?.matchStatus) q.set('matchStatus', query.matchStatus)
  const qs = q.toString()
  return groupRequest('GET', `/sap/reconciliation${qs ? `?${qs}` : ''}`)
}

/** 创建双账差异项（POST /sap/reconciliation；commandType sap.reconciliation.create） */
export function createSapReconciliation(body: {
  plantId: string
  objectCode: string
  title: string
  reason: string
  objectName?: string
  momQty?: string
  sapQty?: string
  diffQty?: string
  currencyCode?: string
  matchStatus?: string
  classification?: string
  reconNo?: string
  sapStockState?: string
  momHold?: boolean
  unknownSliceQty?: string
}): Promise<{ operationId: string; status: string; data: Record<string, unknown> | null }> {
  return groupRequest('POST', '/sap/reconciliation', body)
}
