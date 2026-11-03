import { useAuth } from '../auth'

/**
 * P4 问数许可（P4-UI 线新增；AQ-AUTH-02：模块许可 `aiquery.use` 落 scope_grant，
 * 与 domain/packages 的 packages/domain/src/aiquery/permissions.ts 同值——P4-A 线已落地）。
 * 问数入口本身需登录会话（路由挂载在 RequireAuth 内）；无 aiquery.use 时页面显示
 * 无权限态并引导走业务页面（不隐藏其它生产功能区）。
 */
export const AIQUERY_USE = 'aiquery.use'

export function useP4Permissions(): { has: (permission: string) => boolean } {
  const { session } = useAuth()
  const list: readonly string[] = session?.permissions ?? []
  return { has: (permission) => list.includes(permission) }
}
