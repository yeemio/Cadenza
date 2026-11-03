import { useAuth } from './auth'

/**
 * 岗位许可显隐助手（PC-10：按钮/入口显隐与许可对应；服务端守卫终校）。
 * 许可字符串与 domain 各域 permissions 目录同值（process/scheduling/execution/
 * quality/warehousing 与 masterdata/inventory/org），来源为 /auth/me 的 permissions
 * （授权行 scope_grant 落库口径）。
 */
export const MASTERDATA_READ = 'masterdata.read'
export const MASTERDATA_ADMIN = 'masterdata.admin'
export const INVENTORY_READ = 'inventory.read'
export const PROCESS_READ = 'process.read'
export const PROCESS_ADMIN = 'process.admin'
export const SCHEDULING_READ = 'scheduling.read'
export const SCHEDULING_ADMIN = 'scheduling.admin'
export const EXECUTION_READ = 'execution.read'
export const EXECUTION_REPORT = 'execution.report'
export const EXECUTION_REVIEW = 'execution.review'
export const EXECUTION_FEED = 'execution.feed'
export const QUALITY_READ = 'quality.read'
export const QUALITY_POST = 'quality.post'
export const WAREHOUSING_READ = 'warehousing.read'
export const WAREHOUSING_POST = 'warehousing.post'
export const SHIPPING_READ = 'shipping.read'
export const SHIPPING_POST = 'shipping.post'
export const PURCHASE_READ = 'purchase.read'
export const PURCHASE_POST = 'purchase.post'
export const GROUP_READ = 'group.read'
export const GROUP_POST = 'group.post'
export const PRODUCTION_READ = 'production.read'
export const PRODUCTION_POST = 'production.post'
export const SCAN_BLOCK_READ = 'scan_block.read'
export const SCAN_BLOCK_POST = 'scan_block.post'

export function usePermissions(): { has: (permission: string) => boolean } {
  const { session } = useAuth()
  const list: readonly string[] = session?.permissions ?? []
  return { has: (permission) => list.includes(permission) }
}
