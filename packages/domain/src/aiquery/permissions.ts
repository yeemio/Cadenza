/**
 * aiquery 域许可键（capability-contract.md AQ-AUTH-02）。
 *
 * 两层许可：模块许可 aiquery.use（新增权限键，落 scope_grant，OA-23 岗位许可机制）
 * + 能力所需域读权限（首版仅引用既有键：process.read/execution.read/scheduling.read/
 * inventory.read/purchase.read/quality.read，定义于 domain 各域 permissions.ts）。
 * 管理动作（注册行启停）许可 aiquery.admin，不由 AI 会话触发（AQ-REG-03）。
 */
export const AIQUERY_PERMISSIONS = {
  USE: 'aiquery.use',
  ADMIN: 'aiquery.admin',
} as const

export const AIQUERY_PERMISSION_VALUES: readonly string[] = [
  AIQUERY_PERMISSIONS.USE,
  AIQUERY_PERMISSIONS.ADMIN,
]

/** 域读权限键（AQ-AUTH-02 引用的既有键，与各域 permissions.ts 同值——本文件集中声明供注册表校验）。 */
export const AIQUERY_DOMAIN_READ_PERMISSIONS: readonly string[] = [
  'process.read',
  'execution.read',
  'scheduling.read',
  'inventory.read',
  'purchase.read',
  'quality.read',
]
