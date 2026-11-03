/**
 * shipping 域岗位操作许可目录（OA-23 第一元在发运域的最小集；六类入口同检 OA-24 由全局守卫承担）。
 * 仓管/出库岗位共用 shipping.post：Web/PDA 双入口共用同命令（PI S16 裁定随行），
 * 差异只在前端通道，不在许可面分层。
 */
export const SHIPPING_PERMISSIONS = {
  /** 发运查询（PL 列表/详情、打包看板、出库状态、附件元数据） */
  SHIPPING_READ: 'shipping.read',
  /** 发运命令（PL/DC 模拟入站、打包、扫码装入/删码/补码、绑定托码、确认出库、回传重试、附件登记） */
  SHIPPING_POST: 'shipping.post',
} as const

export type ShippingPermission = (typeof SHIPPING_PERMISSIONS)[keyof typeof SHIPPING_PERMISSIONS]
