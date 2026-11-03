/**
 * production 域岗位操作许可（E09 投料竞争/计划部分/迟修订专用面）。
 * 独立于 execution 投料/报工与 scheduling 排程。
 */
export const PRODUCTION_PERMISSIONS = {
  PRODUCTION_READ: 'production.read',
  PRODUCTION_POST: 'production.post',
} as const

export type ProductionPermission =
  (typeof PRODUCTION_PERMISSIONS)[keyof typeof PRODUCTION_PERMISSIONS]

export const PRODUCTION_PERMISSION_VALUES: readonly string[] = Object.values(PRODUCTION_PERMISSIONS)
