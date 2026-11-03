import type { VerifiedAuthContext } from '@cadenza/application'

/**
 * execution 查询端口（api 模块本地结构化接口，同 ProcessQueriesPort 模式）。
 * 生产实现为 application 层 ExecutionQueryService；L0 整合前由装配点注入。
 */
export interface ExecutionQueriesPort {
  listDrafts(
    auth: VerifiedAuthContext,
    query: {
      orderId?: string
      source?: string
      operatorUserId?: string
      page?: number
      pageSize?: number
    },
  ): Promise<unknown>
  getReport(auth: VerifiedAuthContext, reportId: string): Promise<unknown>
  orderQuantities(auth: VerifiedAuthContext, orderId: string): Promise<unknown>
  scanContext(
    auth: VerifiedAuthContext,
    query: { plantId: string; equipmentId: string; shiftDate: string },
  ): Promise<unknown>
  listLaborByOrder(auth: VerifiedAuthContext, orderId: string): Promise<unknown>
}
