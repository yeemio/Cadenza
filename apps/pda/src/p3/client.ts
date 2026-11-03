import { apiMode, loadSession } from '../api'
import { createP3Client, type P3Client } from '../../../../packages/ui/src/api/p3'

/**
 * PDA 侧 P3 客户端装配点（P3-UI 线新增；零共享文件——不改 apps/pda/src/api.ts）。
 */

const env = import.meta.env as Record<string, string | undefined>

export function createPdaP3Client(onUnauthorized?: () => void): P3Client {
  return createP3Client({
    mode: apiMode,
    baseURL: env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001',
    getToken: () => loadSession()?.token ?? null,
    onUnauthorized,
  })
}
