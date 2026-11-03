import { useAuth } from '../auth'
import { isMock } from '../api'
import { P3_ALL_PERMISSIONS } from '../../../../packages/ui/src/api/p3'

/**
 * P3 PDA 页面许可助手（P3-UI 线新增；PC-10 显隐、服务端守卫终校）。
 * live 严格按 /auth/me；mock 演示模式 admin 合并 P3 许可全集（先例：P2 PDA/L3 波次）。
 * 许可常量镜像自 packages/ui/src/api/p3/permissions.ts（与 domain 四域落盘值对账一致）。
 */
export { CSW_READ, CSW_POST, CSW_UNFREEZE } from '../../../../packages/ui/src/api/p3'

export function useP3PdaPermissions(): { has: (permission: string) => boolean; plantId: string | null } {
  const { session } = useAuth()
  let list: readonly string[] = session?.permissions ?? []
  if (isMock && session?.user.loginName === 'admin') {
    list = [...new Set([...list, ...P3_ALL_PERMISSIONS])]
  }
  return { has: (permission) => list.includes(permission), plantId: session?.user.plantId ?? null }
}
