/**
 * conversionform 域岗位操作许可目录（OA-23 第一元在形态转换域的最小集；
 * 六类入口同检 OA-24 由全局守卫承担）。
 *
 * FC-01 两协议分立：订单形态转换（Web 建单 + PDA 扫码完成）与库存形态转换（仅 Web）
 * 共用同一许可面（P1 PI S16 裁定随行：差异在前端通道，不在许可面分层）；
 * 单据与菜单不混用由两套表/两套命令面/两套查询面分立承载。
 */
export const CONVERSION_PERMISSIONS = {
  /** 形态转换查询（订单/库存转换单列表、详情、库存候选源） */
  CONVERSION_READ: 'conversion.read',
  /** 形态转换命令（订单式建单/编辑/删除/扫码/删码/完成/重试；库存式提交/派发/结果/改码/重转/重同步） */
  CONVERSION_POST: 'conversion.post',
} as const

export type ConversionPermission = (typeof CONVERSION_PERMISSIONS)[keyof typeof CONVERSION_PERMISSIONS]
