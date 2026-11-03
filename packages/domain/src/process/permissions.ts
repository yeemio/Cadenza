/**
 * process 域岗位许可目录（沿用 org/masterdata/inventory 模式：六类入口同一检查，
 * 授权以 scope_grant 落库行为准，OA-24/26 全局守卫 + 命令事务内二道防线）。
 *
 * 注意：本文件经 domain 包 index 导出前，api 侧以本地镜像常量消费（apps/api/src/process/
 * process.controller.ts 内注释标记，L0 整合步统一转包名导入）；测试授权直接落字符串。
 */
export const PROCESS_PERMISSIONS = {
  /** 工艺与生产订单查询（工艺术数据、订单列表/明细） */
  PROCESS_READ: 'process.read',
  /** 工艺术数据维护与订单命令（接收/放行/开工/挂起/作废/发布/失效） */
  PROCESS_ADMIN: 'process.admin',
} as const

export type ProcessPermission = (typeof PROCESS_PERMISSIONS)[keyof typeof PROCESS_PERMISSIONS]
