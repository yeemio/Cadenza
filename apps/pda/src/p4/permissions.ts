import { useAuth } from '../auth'

/**
 * P4 问数许可（PDA 可选入口；与 web 侧 apps/web/src/p4/permissions.ts 同值——
 * `aiquery.use`，AQ-AUTH-02，P4-A 线 domain/aiquery/permissions.ts 已落地该权限键）。
 */
export const AIQUERY_USE = 'aiquery.use'

export function useP4Permissions(): { has: (permission: string) => boolean } {
  const { session } = useAuth()
  const list: readonly string[] = session?.permissions ?? []
  return { has: (permission) => list.includes(permission) }
}
