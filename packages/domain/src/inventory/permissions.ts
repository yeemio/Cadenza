/**
 * inventory 域岗位操作许可目录（OA-23 第一元在库存域的最小集；六类入口同检 OA-24 由全局守卫承担）。
 * 授权仍以 scope_grant 落库行为准（org 域机制复用）；本目录仅定义许可字符串常量。
 */
export const INVENTORY_PERMISSIONS = {
  /** 库存查询（余额/单元详情/条码解析） */
  INVENTORY_READ: 'inventory.read',
  /** 库存记账命令（收货/发料/移位/调拨/分盘） */
  INVENTORY_POST: 'inventory.post',
  /** 预留管理（acquire/release） */
  INVENTORY_RESERVE: 'inventory.reserve',
} as const

export type InventoryPermission = (typeof INVENTORY_PERMISSIONS)[keyof typeof INVENTORY_PERMISSIONS]
