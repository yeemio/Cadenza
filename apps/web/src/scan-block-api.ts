import { loadSession } from './api'

const env = import.meta.env as Record<string, string | undefined>
const baseURL = env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001'

export interface ScanBlockPageResult<T> {
  page: number
  pageSize: number
  total: number
  items: T[]
}

async function scanBlockRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
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

/** E09 SCAN-BLOCK 拦截事件列表（≠ 通用扫码/报工）。 */
export function listScanBlockEvents(query?: {
  page?: number
  pageSize?: number
  plantId?: string
  policyCode?: string
  status?: string
}): Promise<ScanBlockPageResult<Record<string, unknown>>> {
  const q = new URLSearchParams()
  if (query?.page) q.set('page', String(query.page))
  if (query?.pageSize) q.set('pageSize', String(query.pageSize))
  if (query?.plantId) q.set('plantId', query.plantId)
  if (query?.policyCode) q.set('policyCode', query.policyCode)
  if (query?.status) q.set('status', query.status)
  const qs = q.toString()
  return scanBlockRequest('GET', `/scan-block/events${qs ? `?${qs}` : ''}`)
}
