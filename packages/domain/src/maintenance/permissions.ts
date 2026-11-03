/**
 * maintenance 域许可常量（OA-23 岗位许可；与各域同型：read=查询、post=命令）。
 */
export const MAINTENANCE_PERMISSIONS = {
  MAINTENANCE_READ: 'maintenance.read',
  MAINTENANCE_POST: 'maintenance.post',
} as const

export const MAINTENANCE_PERMISSION_VALUES: readonly string[] = Object.values(MAINTENANCE_PERMISSIONS)
