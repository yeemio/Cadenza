import { useAuth } from '../auth'
import { isMock } from '../api'
import {
  P2_ALL_PERMISSIONS,
  REWORK_READ,
  CONVERSION_READ,
  REVERSE_READ,
  DISPOSITION_READ,
  MAINTENANCE_READ,
  REPORTING_READ,
} from '../../../../packages/ui/src/api/p2'

/**
 * P2 页面许可助手（P2-UI 线新增；PC-10 显隐、服务端守卫终校）。
 * - live 模式严格按 /auth/me 的 permissions（与 P1 usePermissions 同源）；
 * - mock 演示模式 admin 合并 P2 许可全集（先例：L3 波次 mock admin 许可合并），
 *   非登录态或 live 模式不合并；
 * - 许可常量取 packages/ui/src/api/p2/permissions.ts（后端 domain 落地值对账见交付记录）。
 */
export { REWORK_READ, CONVERSION_READ, REVERSE_READ, DISPOSITION_READ, MAINTENANCE_READ, REPORTING_READ }
export {
  REWORK_POST,
  CONVERSION_POST,
  REVERSE_POST,
  DISPOSITION_POST,
  MAINTENANCE_POST,
} from '../../../../packages/ui/src/api/p2'

export function useP2Permissions(): { has: (permission: string) => boolean; plantId: string | null } {
  const { session } = useAuth()
  let list: readonly string[] = session?.permissions ?? []
  if (isMock && session?.user.loginName === 'admin') {
    list = [...new Set([...list, ...P2_ALL_PERMISSIONS])]
  }
  return { has: (permission) => list.includes(permission), plantId: session?.user.plantId ?? null }
}
