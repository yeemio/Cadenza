/**
 * disposition 域岗位操作许可目录（OA-23 第一元在质量处置域的最小集；六类入口同检 OA-24 由全局守卫承担）。
 * 质检/处置/审核岗位共用 disposition.post：Web/PDA 双入口共用同命令（PI S16 裁定精神随行），
 * 差异只在前端通道，不在许可面分层。证书/客诉/召回许可面随 GAP-F16 裁定（QD-S5，不预造）。
 */
export const DISPOSITION_PERMISSIONS = {
  /** 处置域查询（存疑扫码预检/存疑与处置链/成品异常/批次质检视图/影响圈定） */
  DISPOSITION_READ: 'disposition.read',
  /** 处置域命令（存疑标记恢复/成品异常提交审核/采购质检写入判定复检/处置四类） */
  DISPOSITION_POST: 'disposition.post',
} as const

export type DispositionPermission = (typeof DISPOSITION_PERMISSIONS)[keyof typeof DISPOSITION_PERMISSIONS]
