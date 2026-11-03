/**
 * warehousing 域岗位操作许可目录（OA-23 第一元在仓储域的最小集；六类入口同检 OA-24 由全局守卫承担）。
 */
export const WAREHOUSING_PERMISSIONS = {
  /** 仓储查询（待入库任务/移库记录/调拨单） */
  WAREHOUSING_READ: 'warehousing.read',
  /** 仓储命令（任务刷新/确认入库/移库/调拨） */
  WAREHOUSING_POST: 'warehousing.post',
} as const

export type WarehousingPermission = (typeof WAREHOUSING_PERMISSIONS)[keyof typeof WAREHOUSING_PERMISSIONS]
