/**
 * scheduling 域岗位许可目录（沿用 org/masterdata/process 模式：六类入口同一检查，
 * 授权以 scope_grant 落库行为准，OA-24/26 全局守卫 + 命令事务内二道防线）。
 *
 * 注意：本文件经 domain 包 index 导出前，api 侧以本地镜像常量消费（apps/api/src/scheduling/
 * scheduling.controller.ts 内注释标记，L0 整合步统一转包名导入）；测试授权直接落字符串。
 */
export const SCHEDULING_PERMISSIONS = {
  /** 排产查询（订单视图/设备看板/PDA 排产计划/班次信息） */
  SCHEDULING_READ: 'scheduling.read',
  /** 排产槽位保存/批量保存、设备日产能配置、班次参数维护 */
  SCHEDULING_ADMIN: 'scheduling.admin',
} as const

export type SchedulingPermission = (typeof SCHEDULING_PERMISSIONS)[keyof typeof SCHEDULING_PERMISSIONS]
