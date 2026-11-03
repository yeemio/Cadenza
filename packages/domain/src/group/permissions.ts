/**
 * group 域岗位操作许可（G 场景：集团分配修订 / 缺料齐套）。
 * 独立于 cost.read/post（成本分摊）与 execution/csw（投料/排程）。
 */
export const GROUP_PERMISSIONS = {
  /** 集团分配修订与缺料/齐套查询 */
  GROUP_READ: 'group.read',
  /** 集团分配修订命令、缺料/齐套检查触发 */
  GROUP_POST: 'group.post',
} as const

export type GroupPermission = (typeof GROUP_PERMISSIONS)[keyof typeof GROUP_PERMISSIONS]

export const GROUP_PERMISSION_VALUES: readonly string[] = Object.values(GROUP_PERMISSIONS)
