import type { PageResult } from '@cadenza/contracts'
import type { VerifiedAuthContext } from '@cadenza/application'

/**
 * masterdata 查询端口（api 模块本地结构化接口）。
 * 生产实现为 application 层 MasterDataQueryService；
 * 在 L0 整合步把 masterdata 导出加入各包 index 前，模块以注入方式接收实现
 * （组装点见 tests/api/masterdata-api.spec.ts 与 delivery 记录的整合说明）。
 */
export interface MasterDataQueriesPort {
  listMaterials(
    auth: VerifiedAuthContext,
    query: { nameLike?: string; codeLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<unknown>>
  listConversions(
    auth: VerifiedAuthContext,
    materialId: string,
  ): Promise<{ material: unknown | null; items: unknown[] }>
  listEquipment(
    auth: VerifiedAuthContext,
    query: { plantId?: string; nameLike?: string; codeLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<unknown>>
  listEquipmentStatusLogs(auth: VerifiedAuthContext, equipmentId: string): Promise<unknown[]>
  listWarehouses(
    auth: VerifiedAuthContext,
    query: { plantId?: string; nameLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<unknown>>
  listLocations(
    auth: VerifiedAuthContext,
    query: { plantId?: string; warehouseId?: string; codeLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<unknown>>
  listRacks(
    auth: VerifiedAuthContext,
    query: { plantId?: string; warehouseId?: string; codeLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<unknown>>
  listWorkCenters(
    auth: VerifiedAuthContext,
    query: { plantId?: string; codeLike?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<unknown>>
}
