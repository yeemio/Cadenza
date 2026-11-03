/**
 * quality 域岗位操作许可目录（OA-23 第一元在质量域的最小集；六类入口同检 OA-24 由全局守卫承担）。
 * 放行/让步/存疑恢复等受权操作（底稿 C-5：授权角色待裁）以 quality.post 许可 + 审计留痕承担。
 */
export const QUALITY_PERMISSIONS = {
  /** 质量查询（检验任务/结论历史/存疑记录） */
  QUALITY_READ: 'quality.read',
  /** 质量命令（任务生成/实测提交/放行/让步/存疑登记与恢复） */
  QUALITY_POST: 'quality.post',
} as const

export type QualityPermission = (typeof QUALITY_PERMISSIONS)[keyof typeof QUALITY_PERMISSIONS]
