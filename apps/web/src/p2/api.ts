import { apiMode, loadSession } from '../api'
import { createP2ApiClient, type P2ApiClient } from '../../../../packages/ui/src/api/p2'

const env = import.meta.env as Record<string, string | undefined>

/**
 * P2 六域 API 客户端单例（P2-UI 线新增 web 入口）。
 * 模式与 P1 共用（VITE_API_MODE=mock 走演示数据）；路由对齐口径见
 * packages/ui/src/api/p2/client.ts 头注释。401 处理沿用应用级会话清理
 * （setUnauthorizedHandler 由 App 装配，本层不重复注册）。
 */
export const p2Api: P2ApiClient = createP2ApiClient({
  mode: apiMode,
  baseURL: env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001',
  getToken: () => loadSession()?.token ?? null,
})

export { apiMode }
