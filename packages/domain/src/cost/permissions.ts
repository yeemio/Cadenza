/**
 * cost 域岗位操作许可目录（OA-23 第一元在成本/能源域的最小集）。
 * 成本/能源归集为只读业务事实的重建投影（CE-02），命令面仅配置（表计/版本）、
 * 显式归集/重算、对账处置与工时核对——发 read/post 两级；岗位细分授权待 Owner 裁定。
 */
export const COST_PERMISSIONS = {
  /** 成本/能源查询（订单成本、归集明细、能源单耗与覆盖率、OEE、对账清单、工时核对） */
  COST_READ: 'cost.read',
  /** 成本/能源命令（表计登记/抄表、分摊与价格版本、归集/显式重算、ERP 对账导入/处置、工时核对） */
  COST_POST: 'cost.post',
} as const

export type CostPermission = (typeof COST_PERMISSIONS)[keyof typeof COST_PERMISSIONS]
