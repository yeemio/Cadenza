/**
 * reverse 域岗位操作许可目录（OA-23 第一元在仓储逆向域的最小集；六类入口同检 OA-24 由全局守卫承担）。
 * 仓管/盘点/采购纠正/载具管理岗位共用 reverse.post：Web/PDA 双入口共用同命令（PI S16 裁定精神随行），
 * 差异只在前端通道，不在许可面分层。
 */
export const REVERSE_PERMISSIONS = {
  /** 逆向查询（移库台账/调拨出入库单/盘点/调整/纠正/载具借还/所有权三分视图） */
  REVERSE_READ: 'reverse.read',
  /** 逆向命令（移库提交/调拨出入库/盘点与差异调整/采购批次纠正/所有权变更/载具借还） */
  REVERSE_POST: 'reverse.post',
} as const

export type ReversePermission = (typeof REVERSE_PERMISSIONS)[keyof typeof REVERSE_PERMISSIONS]
