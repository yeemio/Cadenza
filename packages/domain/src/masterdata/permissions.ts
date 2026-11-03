/**
 * masterdata 域岗位许可目录（沿用 org 域 OA-23/24 模式：六类入口同一检查）。
 * 种子用户不带本域许可；主数据测试/运行时由授权行（scope_grant）显式配置。
 */
export const MASTERDATA_PERMISSIONS = {
  /** 主数据查询（命令、查询、导出等入口同检） */
  MASTERDATA_READ: 'masterdata.read',
  /** 主数据维护（新增/编辑/失效/换算行编辑/状态切换） */
  MASTERDATA_ADMIN: 'masterdata.admin',
} as const

export type MasterDataPermission = (typeof MASTERDATA_PERMISSIONS)[keyof typeof MASTERDATA_PERMISSIONS]
