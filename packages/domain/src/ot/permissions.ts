/**
 * ot 域岗位操作许可目录（OA-23 第一元在采集域的最小集）。
 * ot.read=采集监控/点位/样本查询；ot.post=网关注册/设备绑定/点位配置/样本入池/
 * 会话人工关联/汇总重建/业务映射评估与确认。遥测通道只读（OT-03）：一切业务写
 * 仍走命令通道，ot.post 不含任何质量放行或生产控制能力（OT-01/OT-02）。
 */
export const OT_PERMISSIONS = {
  /** 采集查询（网关/设备/点位/样本/汇总/映射/监控/统计） */
  OT_READ: 'ot.read',
  /** 采集命令（注册/心跳/监控巡检/绑定/点位/质量码/换算/入池/会话关联/重建/映射） */
  OT_POST: 'ot.post',
} as const

export type OtPermission = (typeof OT_PERMISSIONS)[keyof typeof OT_PERMISSIONS]
