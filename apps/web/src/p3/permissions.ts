import { useAuth } from '../auth'
import { isMock } from '../api'
import { P3_ALL_PERMISSIONS } from '../../../../packages/ui/src/api/p3'

/**
 * P3 页面许可助手（P3-UI 线新增；PC-10 显隐、服务端守卫终校）。
 * - live 模式严格按 /auth/me 的 permissions（与 P1/P2 usePermissions 同源）；
 * - mock 演示模式 admin 合并 P3 许可全集（先例：P2-UI/L3 波次 mock admin 许可合并），
 *   非登录态或 live 模式不合并；
 * - 许可常量取 packages/ui/src/api/p3/permissions.ts（与 domain 四域 permissions.ts 落盘值
 *   逐一核对一致：ot/spc/csw/cost——cost 早期 PROPOSED 假设与 P3-D 落盘值相同，对账已闭合）。
 */
export { OT_READ, OT_POST, SPC_READ, SPC_POST, CSW_READ, CSW_POST, CSW_UNFREEZE, COST_READ, COST_POST } from '../../../../packages/ui/src/api/p3'

export function useP3Permissions(): { has: (permission: string) => boolean; plantId: string | null } {
  const { session } = useAuth()
  let list: readonly string[] = session?.permissions ?? []
  if (isMock && session?.user.loginName === 'admin') {
    list = [...new Set([...list, ...P3_ALL_PERMISSIONS])]
  }
  return { has: (permission) => list.includes(permission), plantId: session?.user.plantId ?? null }
}
