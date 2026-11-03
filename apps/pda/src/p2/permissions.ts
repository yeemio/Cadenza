import { useAuth } from '../auth'
import { isMock } from '../api'
import { P2_ALL_PERMISSIONS } from '../../../../packages/ui/src/api/p2'

/**
 * P2 PDA 页面许可助手（P2-UI 线新增；PC-10 显隐、服务端守卫终校）。
 * live 严格按 /auth/me；mock 演示模式 admin 合并 P2 许可全集（先例 L3 波次）。
 * 许可常量镜像自 packages/ui/src/api/p2/permissions.ts（对账清单登记）。
 */
export {
  REWORK_READ,
  REWORK_POST,
  CONVERSION_READ,
  CONVERSION_POST,
  REVERSE_READ,
  REVERSE_POST,
  DISPOSITION_READ,
  DISPOSITION_POST,
  MAINTENANCE_READ,
  MAINTENANCE_POST,
  REPORTING_READ,
} from '../../../../packages/ui/src/api/p2'

export function useP2PdaPermissions(): { has: (permission: string) => boolean; plantId: string | null } {
  const { session } = useAuth()
  let list: readonly string[] = session?.permissions ?? []
  if (isMock && session?.user.loginName === 'admin') {
    list = [...new Set([...list, ...P2_ALL_PERMISSIONS])]
  }
  return { has: (permission) => list.includes(permission), plantId: session?.user.plantId ?? null }
}
