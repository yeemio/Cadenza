/**
 * purchase 域岗位操作许可目录（OA-23 第一元在采购域的最小集；六类入口同检 OA-24 由全局守卫承担）。
 * 授权仍以 scope_grant 落库行为准（org 域机制复用）；本目录仅定义许可字符串常量。
 */
export const PURCHASE_PERMISSIONS = {
  /** 采购查询（订单行/批次/明细/价格复核投影） */
  PURCHASE_READ: 'purchase.read',
  /** 采购命令（订单同步入站、确认收货、质检结论、撤销、复检、退货、复核标记） */
  PURCHASE_POST: 'purchase.post',
} as const

export type PurchasePermission = (typeof PURCHASE_PERMISSIONS)[keyof typeof PURCHASE_PERMISSIONS]
