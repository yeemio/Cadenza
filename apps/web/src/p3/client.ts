import { apiMode, loadSession } from '../api'
import { createP3Client, type P3Client } from '../../../../packages/ui/src/api/p3'

/**
 * web 侧 P3 客户端装配点（P3-UI 线新增；零共享文件——不改 apps/web/src/api.ts）。
 * live（默认）直连 apps/api；mock 走演示场景；401 由认证层统一处理（此处仅回调清会话跳登录）。
 */

const env = import.meta.env as Record<string, string | undefined>

export function createWebP3Client(onUnauthorized?: () => void): P3Client {
  return createP3Client({
    mode: apiMode,
    baseURL: env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001',
    getToken: () => loadSession()?.token ?? null,
    onUnauthorized,
  })
}
