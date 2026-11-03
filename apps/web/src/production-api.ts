import { loadSession } from './api'

const env = import.meta.env as Record<string, string | undefined>
const baseURL = env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001'

export interface ProductionPageResult<T> {
  page: number
  pageSize: number
  total: number
  items: T[]
}

async function productionRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
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

/** E09 投料竞争/计划部分/迟修订列表（≠ /execution/feeds）。 */
export function listFeedRacePlans(query?: {
  page?: number
  pageSize?: number
  plantId?: string
  planKind?: string
  status?: string
}): Promise<ProductionPageResult<Record<string, unknown>>> {
  const q = new URLSearchParams()
  if (query?.page) q.set('page', String(query.page))
  if (query?.pageSize) q.set('pageSize', String(query.pageSize))
  if (query?.plantId) q.set('plantId', query.plantId)
  if (query?.planKind) q.set('planKind', query.planKind)
  if (query?.status) q.set('status', query.status)
  const qs = q.toString()
  return productionRequest('GET', `/production/feed-race-plans${qs ? `?${qs}` : ''}`)
}
