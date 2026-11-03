import { useAuth } from './auth'

/**
 * PDA 岗位许可显隐助手（与 web 同值镜像；服务端守卫终校，PC-10）。
 */
export const EXECUTION_READ = 'execution.read'
export const EXECUTION_REPORT = 'execution.report'
export const EXECUTION_FEED = 'execution.feed'
export const WAREHOUSING_READ = 'warehousing.read'
export const WAREHOUSING_POST = 'warehousing.post'
export const SHIPPING_READ = 'shipping.read'
export const SHIPPING_POST = 'shipping.post'

export function usePermissions(): { has: (permission: string) => boolean } {
  const { session } = useAuth()
  const list: readonly string[] = session?.permissions ?? []
  return { has: (permission) => list.includes(permission) }
}
