import type { VerifiedAuthContext } from '@cadenza/application'

/**
 * scheduling 查询端口（api 模块本地结构化接口；process.queries-port 同型：unknown 返回形状）。
 * 生产实现为 application 层 SchedulingQueryService（返回形状与
 * packages/contracts/src/scheduling.ts 的 DTO 字段级一致，L0 整合步统一导出；
 * DTO 冻结断言由 tests/api/scheduling-api.spec.ts 以相对导入承担）。
 */
export interface SchedulingQueriesPort {
  /** 订单视图（订单排程详情：工序 Tab × 设备 × 日期矩阵 + [A3-4] 回写链投影）。 */
  orderView(auth: VerifiedAuthContext, orderId: string): Promise<unknown | null>
  /** 设备视图（设备排程看板：[A3-5] 日期列 = 今日起 30 天 ∪ 已有排产日）。 */
  deviceBoard(
    auth: VerifiedAuthContext,
    query: { plantId?: string; workCenterId?: string; equipmentId?: string },
  ): Promise<unknown | null>
  /** PDA 排产计划只读（[A3-7 / PP §3.2] 按工作中心 + 排产日期分组）。 */
  pdaPlan(
    auth: VerifiedAuthContext,
    query: { workCenterId: string; orderNoLike?: string; equipmentId?: string; date?: string },
  ): Promise<unknown | null>
  /** 班次信息与双轨时间（[A4-2] 实际时间 + 业务班次日期）。 */
  shiftInfo(auth: VerifiedAuthContext, query: { plantId: string; at?: string }): Promise<unknown | null>
}
