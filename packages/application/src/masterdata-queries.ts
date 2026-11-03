import type { PageRequest, PageResult } from '@cadenza/contracts'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  ConversionLineRecord,
  EquipmentRecord,
  EquipmentStatusLogRecord,
  MaterialRecord,
  RackRecord,
  StorageLocationRecord,
  WarehouseRecord,
  WorkCenterRecord,
} from './masterdata-repositories'
import type { MasterDataRepositories } from './masterdata-repositories'

/**
 * masterdata 域查询服务：分页 + 按授权数据范围服务端过滤
 * （OA-24/25 六类入口同一范围检查；料品为企业级只读主数据，任何持
 * masterdata.read 许可者可见，不做工厂收敛；其余按 plant_id 隔离过滤）。
 */

export interface MasterDataQueryDeps {
  masterdata: MasterDataRepositories
}

export type MaterialView = Omit<MaterialRecord, 'deletedAt' | 'createdBy' | 'updatedBy'>
export type ConversionLineView = Omit<ConversionLineRecord, 'deletedAt' | 'createdBy' | 'updatedBy'>
export type EquipmentView = Omit<EquipmentRecord, 'enterpriseId' | 'deletedAt' | 'createdBy' | 'updatedBy'>
export type WarehouseView = Omit<WarehouseRecord, 'enterpriseId' | 'deletedAt' | 'createdBy' | 'updatedBy'>
export type StorageLocationView = Omit<StorageLocationRecord, 'enterpriseId' | 'deletedAt' | 'createdBy' | 'updatedBy'>
export type RackView = Omit<RackRecord, 'enterpriseId' | 'deletedAt' | 'createdBy' | 'updatedBy'>
export type WorkCenterView = Omit<WorkCenterRecord, 'enterpriseId' | 'deletedAt' | 'createdBy' | 'updatedBy'>

function toPageRequest(query: { page?: unknown; pageSize?: unknown }): PageRequest {
  const page = typeof query.page === 'number' && Number.isInteger(query.page) && query.page >= 1 ? query.page : 1
  const pageSize =
    typeof query.pageSize === 'number' && Number.isInteger(query.pageSize) && query.pageSize >= 1
      ? Math.min(query.pageSize, 100)
      : 20
  return { page, pageSize }
}

const like = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export class MasterDataQueryService {
  constructor(private readonly deps: MasterDataQueryDeps) {}

  private repos(): MasterDataRepositories {
    return this.deps.masterdata
  }

  /** 料品分页（企业级只读，MD-01：无新增/删除入口）。 */
  async listMaterials(
    auth: VerifiedAuthContext,
    query: { nameLike?: string; codeLike?: string; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<MaterialView>> {
    const pageRequest = toPageRequest(query)
    const page = await this.repos().materials.list({
      orgScopeId: auth.user.enterpriseId,
      nameLike: like(query.nameLike),
      codeLike: like(query.codeLike),
      ...pageRequest,
    })
    return { items: page.items.map(toMaterialView), total: page.total, ...pageRequest }
  }

  /** 指定料品的活动换算行（按版本序；MD-05 referenced 状态随行返回）。 */
  async listConversions(
    auth: VerifiedAuthContext,
    materialId: string,
  ): Promise<{ material: MaterialView | null; items: ConversionLineView[] }> {
    const material = await this.repos().materials.findById(materialId)
    if (material === null || material.orgScopeId !== auth.user.enterpriseId) {
      return { material: null, items: [] }
    }
    const lines = await this.repos().conversions.listActiveByMaterial(materialId)
    return { material: toMaterialView(material), items: lines.map(toConversionView) }
  }

  /** 设备分页（按数据范围过滤；MD-09~16 视图含设备码）。 */
  async listEquipment(
    auth: VerifiedAuthContext,
    query: { plantId?: string; nameLike?: string; codeLike?: string; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<EquipmentView>> {
    const pageRequest = toPageRequest(query)
    const plantIds = this.plantFilter(auth, query.plantId)
    if (plantIds !== null && plantIds.length === 0) {
      return { items: [], total: 0, ...pageRequest }
    }
    const page = await this.repos().equipment.list({
      plantIds,
      nameLike: like(query.nameLike),
      codeLike: like(query.codeLike),
      ...pageRequest,
    })
    return { items: page.items.map(toEquipmentView), total: page.total, ...pageRequest }
  }

  /** 设备状态流水（MD-14，append-only）。 */
  async listEquipmentStatusLogs(
    auth: VerifiedAuthContext,
    equipmentId: string,
  ): Promise<EquipmentStatusLogRecord[]> {
    const equipment = await this.repos().equipment.findById(equipmentId)
    if (equipment === null || equipment.enterpriseId !== auth.user.enterpriseId) return []
    return this.repos().equipment.listStatusLogs(equipmentId)
  }

  /** 仓库分页（按数据范围过滤）。 */
  async listWarehouses(
    auth: VerifiedAuthContext,
    query: { plantId?: string; nameLike?: string; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<WarehouseView>> {
    const pageRequest = toPageRequest(query)
    const plantIds = this.plantFilter(auth, query.plantId)
    if (plantIds !== null && plantIds.length === 0) {
      return { items: [], total: 0, ...pageRequest }
    }
    const page = await this.repos().warehouses.list({
      plantIds,
      nameLike: like(query.nameLike),
      ...pageRequest,
    })
    return { items: page.items.map(toWarehouseView), total: page.total, ...pageRequest }
  }

  /** 库位分页（按数据范围过滤；可按仓库收敛）。 */
  async listLocations(
    auth: VerifiedAuthContext,
    query: { plantId?: string; warehouseId?: string; codeLike?: string; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<StorageLocationView>> {
    const pageRequest = toPageRequest(query)
    const plantIds = this.plantFilter(auth, query.plantId)
    if (plantIds !== null && plantIds.length === 0) {
      return { items: [], total: 0, ...pageRequest }
    }
    const page = await this.repos().locations.list({
      plantIds,
      warehouseId: like(query.warehouseId),
      codeLike: like(query.codeLike),
      ...pageRequest,
    })
    return { items: page.items.map(toLocationView), total: page.total, ...pageRequest }
  }

  /** 货架分页（按数据范围过滤）。 */
  async listRacks(
    auth: VerifiedAuthContext,
    query: { plantId?: string; warehouseId?: string; codeLike?: string; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<RackView>> {
    const pageRequest = toPageRequest(query)
    const plantIds = this.plantFilter(auth, query.plantId)
    if (plantIds !== null && plantIds.length === 0) {
      return { items: [], total: 0, ...pageRequest }
    }
    const page = await this.repos().racks.list({
      plantIds,
      warehouseId: like(query.warehouseId),
      codeLike: like(query.codeLike),
      ...pageRequest,
    })
    return { items: page.items.map(toRackView), total: page.total, ...pageRequest }
  }

  /** 工作中心分页（按数据范围过滤）。 */
  async listWorkCenters(
    auth: VerifiedAuthContext,
    query: { plantId?: string; codeLike?: string; page?: unknown; pageSize?: unknown },
  ): Promise<PageResult<WorkCenterView>> {
    const pageRequest = toPageRequest(query)
    const plantIds = this.plantFilter(auth, query.plantId)
    if (plantIds !== null && plantIds.length === 0) {
      return { items: [], total: 0, ...pageRequest }
    }
    const page = await this.repos().workCenters.list({
      plantIds,
      codeLike: like(query.codeLike),
      ...pageRequest,
    })
    return { items: page.items.map(toWorkCenterView), total: page.total, ...pageRequest }
  }

  /**
   * plant 过滤口径：显式 plantId 已由 ScopeGuard 校验在范围内（越范围 403）；
   * 未指定时按数据范围收敛（企业范围 = null 全量；OA-25 纵深防御同口径）。
   */
  private plantFilter(auth: VerifiedAuthContext, plantId: unknown): string[] | null {
    if (typeof plantId === 'string' && plantId.length > 0) return [plantId]
    const scope = auth.dataScope
    return scope.enterpriseWide ? null : scope.plantIds
  }
}

function toMaterialView(r: MaterialRecord): MaterialView {
  return {
    id: r.id,
    orgScopeId: r.orgScopeId,
    code: r.code,
    name: r.name,
    companyOrgCode: r.companyOrgCode,
    materialGroupCode: r.materialGroupCode,
    materialGroupName: r.materialGroupName,
    descriptionZh: r.descriptionZh,
    descriptionEn: r.descriptionEn,
    voltage: r.voltage,
    standard: r.standard,
    customer: r.customer,
    materialType: r.materialType,
    spec: r.spec,
    color: r.color,
    baseUom: r.baseUom,
    qcFlag: r.qcFlag,
    remark: r.remark,
    sourceSystem: r.sourceSystem,
    externalRevision: r.externalRevision,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function toConversionView(r: ConversionLineRecord): ConversionLineView {
  return {
    id: r.id,
    materialId: r.materialId,
    version: r.version,
    unitName: r.unitName,
    factor: r.factor,
    referenced: r.referenced,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function toEquipmentView(r: EquipmentRecord): EquipmentView {
  return {
    id: r.id,
    plantId: r.plantId,
    deptId: r.deptId,
    workCenterId: r.workCenterId,
    code: r.code,
    name: r.name,
    actualNo: r.actualNo,
    model: r.model,
    stdRateText: r.stdRateText,
    equipmentStatus: r.equipmentStatus,
    capacity: r.capacity,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function toWarehouseView(r: WarehouseRecord): WarehouseView {
  return {
    id: r.id,
    plantId: r.plantId,
    deptId: r.deptId,
    code: r.code,
    name: r.name,
    warehouseType: r.warehouseType,
    materialTypes: r.materialTypes,
    managerUserId: r.managerUserId,
    phone: r.phone,
    address: r.address,
    qrBound: r.qrBound,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function toLocationView(r: StorageLocationRecord): StorageLocationView {
  return {
    id: r.id,
    plantId: r.plantId,
    warehouseId: r.warehouseId,
    rackId: r.rackId,
    locationKind: r.locationKind,
    code: r.code,
    zoneCode: r.zoneCode,
    remark: r.remark,
    qrBound: r.qrBound,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function toRackView(r: RackRecord): RackView {
  return {
    id: r.id,
    plantId: r.plantId,
    warehouseId: r.warehouseId,
    code: r.code,
    zones: r.zones,
    layers: r.layers,
    remark: r.remark,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function toWorkCenterView(r: WorkCenterRecord): WorkCenterView {
  return {
    id: r.id,
    plantId: r.plantId,
    deptId: r.deptId,
    code: r.code,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}
