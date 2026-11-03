import type { PageResult } from '@cadenza/contracts'
import type { VerifiedAuthContext } from '@cadenza/application'

/**
 * process 查询端口（api 模块本地结构化接口）。
 * 生产实现为 application 层 ProcessQueryService；
 * 在 L0 整合步把 process 面加入各包 index 前，模块以注入方式接收实现
 * （组装点见 tests/api/process-api.spec.ts 与 delivery 记录的整合说明）。
 */
export interface ProcessQueriesPort {
  listFamilies(
    auth: VerifiedAuthContext,
    query: { plantId?: string; nameLike?: string; codeLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<unknown>>
  listBoms(
    auth: VerifiedAuthContext,
    query: { plantId?: string; productFamilyId?: string; status?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<unknown>>
  listRoutes(
    auth: VerifiedAuthContext,
    query: { plantId?: string; productFamilyId?: string; status?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<unknown>>
  listParameters(
    auth: VerifiedAuthContext,
    query: { plantId?: string; productFamilyId?: string; status?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<unknown>>
  listOperations(
    auth: VerifiedAuthContext,
    query: { plantId?: string; nameLike?: string; codeLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<unknown>>
  listOrders(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      orderNoLike?: string
      statuses?: string
      suspended?: boolean
      page?: number
      pageSize?: number
    },
  ): Promise<PageResult<unknown>>
  getOrderDetail(
    auth: VerifiedAuthContext,
    orderId: string,
  ): Promise<{ order: unknown | null; operations: unknown[] }>
}
