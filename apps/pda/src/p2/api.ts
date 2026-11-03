import { apiMode, loadSession } from '../api'
import { createP2ApiClient, type P2ApiClient } from '../../../../packages/ui/src/api/p2'

const env = import.meta.env as Record<string, string | undefined>

/** P2 六域 API 客户端单例（PDA 入口；模式与 P1 共用）。 */
export const p2Api: P2ApiClient = createP2ApiClient({
  mode: apiMode,
  baseURL: env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001',
  getToken: () => loadSession()?.token ?? null,
})
