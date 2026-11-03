import type { PageRequest, PageResult } from '@cadenza/contracts'
import type { CommandTools } from './command-bus'

/**
 * process 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与 0005 迁移列一一对应；时间字段一律 ISO-8601 字符串（OA-31 系统时间口径）；
 * 数量字段为十进制字符串（DecimalString）。
 *
 * 注意：本文件未加入 application/src/index.ts 导出（S2 共享文件不可改，L0 整合步统一导出）；
 * persistence 实现以 dist 相对导入消费本端口（见 packages/persistence/src/process-repositories.ts）。
 */

export type ProcessMasterStatus = 'active' | 'retired'
export type ProcessRevisionStatus = 'draft' | 'reviewed' | 'published' | 'retired'
export type ProductionOrderStatus =
  | 'approved'
  | 'released'
  | 'in_progress'
  | 'pending_completion'
  | 'closed'
  | 'voided'
export type ProcessConfigStatus = 'unconfigured' | 'configured'
export type OperationExecutionStatus = 'pending' | 'executed'

/** BOM 行（jsonb 承载）。 */
export interface BomLine {
  materialId: string
  materialCode: string
  quantity: string
  uom: string
}

/** 工艺路线步（jsonb 承载；系数缺省 芯倍数=1、绞合=空）。 */
export interface RouteStep {
  seq: number
  operationDefinitionId: string
  workCenterId: string
  coreMultiple?: number
  strandFactor?: string | null
}

// ---------------- 记录类型 ----------------

export interface ProductFamilyRecord {
  id: string
  enterpriseId: string
  plantId: string
  code: string
  name: string
  description: string | null
  status: ProcessMasterStatus
  deletedAt: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

/** 三张版本表的公共列（handler 泛型消费；具体记录类型各自扩展）。 */
export interface ProcessRevisionBase {
  id: string
  enterpriseId: string
  plantId: string
  productFamilyId: string
  version: number
  status: ProcessRevisionStatus
  remark: string | null
  publishedAt: string | null
  publishedBy: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface BomRevisionRecord extends ProcessRevisionBase {
  materialId: string
  lines: BomLine[]
}

export interface RouteRevisionRecord extends ProcessRevisionBase {
  steps: RouteStep[]
}

export interface ParameterSpecRevisionRecord extends ProcessRevisionBase {
  name: string
  parameters: unknown[]
}

export interface OperationDefinitionRecord {
  id: string
  enterpriseId: string
  plantId: string
  deptId: string
  workCenterId: string
  companyOrgCode: string
  code: string
  name: string
  remark: string | null
  status: ProcessMasterStatus
  deletedAt: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface ProductionOrderRecord {
  id: string
  enterpriseId: string
  plantId: string
  orderNo: string
  orderType: string | null
  salesContractNo: string | null
  salesOrderNo: string | null
  lineNo: string | null
  materialId: string
  materialSnapshot: Record<string, unknown>
  productFamilyId: string | null
  productionDeptId: string
  productionQty: string
  uom: string
  overrunRatio: string | null
  orderStatus: ProductionOrderStatus
  processConfigStatus: ProcessConfigStatus
  processConfirmedAt: string | null
  suspended: boolean
  suspendedReason: string | null
  actualStartAt: string | null
  actualFinishAt: string | null
  businessClosedAt: string | null
  erpClosedAt: string | null
  erpClosedBy: string | null
  bomRevisionId: string | null
  routeRevisionId: string | null
  currentSettingsVersion: number
  plannedStartAt: string | null
  plannedFinishAt: string | null
  segmentRequirement: string | null
  remark: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface OrderOperationRecord {
  id: string
  enterpriseId: string
  plantId: string
  orderId: string
  seq: number
  settingsVersion: number
  executionStatus: OperationExecutionStatus
  operationDefinitionId: string
  operationCode: string
  operationName: string
  operationRemark: string | null
  coreMultiple: number
  strandFactor: string | null
  offlineQty: string
  workCenterId: string
  workCenterCode: string
  workCenterName: string
  uom: string
  productionDeptId: string
  /** 路线版本引用（接收时冻结；显式工序无路线时为 null） */
  routeRevisionId: string | null
  bomRevisionId: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

// ---------------- 端口 ----------------

export interface NewProductFamily {
  id?: string
  enterpriseId: string
  plantId: string
  code: string
  name: string
  description?: string | null
  createdBy?: string | null
}

export interface ProductFamilyPatch {
  name?: string
  description?: string | null
  status?: ProcessMasterStatus
}

export interface ProductFamilyRepository {
  findById(id: string): Promise<ProductFamilyRecord | null>
  findActiveByPlantAndCode(plantId: string, code: string): Promise<ProductFamilyRecord | null>
  insert(family: NewProductFamily): Promise<ProductFamilyRecord>
  update(id: string, patch: ProductFamilyPatch, actor: string | null): Promise<ProductFamilyRecord | null>
  /** 逻辑删除（MD-36 同型：状态列 + deleted_at）。 */
  retire(id: string, actor: string | null): Promise<ProductFamilyRecord | null>
  /** 活动占用计数：未失效的 BOM/路线/参数版本 + 未作废订单对产品族的引用（retire 前置）。 */
  countActiveUsages(familyId: string): Promise<number>
  list(
    filter: { plantIds: string[] | null; nameLike?: string; codeLike?: string } & PageRequest,
  ): Promise<PageResult<ProductFamilyRecord>>
}

/** 版本定位键：BOM=(plant, material)；路线=(plant, family)；参数规范=(plant, family, name)。 */
export interface ProcessRevisionKey {
  plantId: string
  /** BOM 专属：产出料品 */
  materialId?: string
  /** 路线/参数规范：产品族 */
  productFamilyId?: string
  /** 参数规范专属：规范名称 */
  name?: string
}

export interface NewProcessRevision {
  id?: string
  enterpriseId: string
  plantId: string
  productFamilyId: string
  /** BOM 专属：产出料品 */
  materialId?: string
  /** 参数规范专属：规范名称 */
  name?: string
  version: number
  /** BOM 行 / 路线步 / 参数（jsonb） */
  content: BomLine[] | RouteStep[] | unknown[]
  remark?: string | null
  initialStatus?: ProcessRevisionStatus
  createdBy?: string | null
}

export interface ProcessRevisionPatch {
  content?: BomLine[] | RouteStep[] | unknown[]
  remark?: string | null
  /** draft→reviewed 中间态置位（review 命令面未建，经 update 载荷预留） */
  status?: ProcessRevisionStatus
}

/**
 * 三张版本表（BOM/路线/参数规范）共用的版本仓储端口（泛型记录类型；
 * 方法仅在返回位使用 TRecord，具体仓储协变可赋给 ProcessRevisionRepositoryPort<ProcessRevisionBase>）。
 */
export interface ProcessRevisionRepositoryPort<TRecord extends ProcessRevisionBase> {
  findById(id: string): Promise<TRecord | null>
  /** 同对象的既有版本号列表（BOM=plant+material；路线=plant+family；参数=plant+family+name）。 */
  listVersionsByKey(key: ProcessRevisionKey): Promise<number[]>
  /** 同对象当前 published 版本（无则 null；订单只引用已发布版本，[底稿 A2]）。 */
  findPublishedByKey(key: ProcessRevisionKey): Promise<TRecord | null>
  insert(revision: NewProcessRevision): Promise<TRecord>
  update(id: string, patch: ProcessRevisionPatch, actor: string | null): Promise<TRecord | null>
  /** 状态迁移（publish/retire；内容由冻结规则锁死，仅状态与发布时间可动）。 */
  updateStatus(
    id: string,
    next: ProcessRevisionStatus,
    actor: string | null,
    occurredAt: Date,
  ): Promise<TRecord | null>
  retire(id: string, actor: string | null): Promise<TRecord | null>
  list(
    filter: {
      plantIds: string[] | null
      productFamilyId?: string
      status?: ProcessRevisionStatus
    } & PageRequest,
  ): Promise<PageResult<TRecord>>
}

export type BomRevisionRepository = ProcessRevisionRepositoryPort<BomRevisionRecord>
export type RouteRevisionRepository = ProcessRevisionRepositoryPort<RouteRevisionRecord>
export type ParameterSpecRepository = ProcessRevisionRepositoryPort<ParameterSpecRevisionRecord>

export interface NewOperationDefinition {
  id?: string
  enterpriseId: string
  plantId: string
  deptId: string
  workCenterId: string
  companyOrgCode: string
  code: string
  name: string
  remark?: string | null
  createdBy?: string | null
}

export interface OperationDefinitionPatch {
  name?: string
  remark?: string | null
  status?: ProcessMasterStatus
  workCenterId?: string
  deptId?: string
}

export interface OperationDefinitionRepository {
  findById(id: string): Promise<OperationDefinitionRecord | null>
  /** 部门内名称唯一查重输入（active 口径由 SQL 过滤）。 */
  findActiveByDeptAndName(deptId: string, name: string): Promise<OperationDefinitionRecord | null>
  /** 公司组织编码内编码唯一查重输入。 */
  findActiveByOrgAndCode(companyOrgCode: string, code: string): Promise<OperationDefinitionRecord | null>
  insert(operation: NewOperationDefinition): Promise<OperationDefinitionRecord>
  update(id: string, patch: OperationDefinitionPatch, actor: string | null): Promise<OperationDefinitionRecord | null>
  retire(id: string, actor: string | null): Promise<OperationDefinitionRecord | null>
  /** [底稿 A1-3]① 模板引用计数（模板表未建，实现按 0 预留）。 */
  countTemplateRefs(operationId: string): Promise<number>
  /** [底稿 A1-3]② 订单排产引用计数（排产表属 T09 未建，实现按 0 预留）。 */
  countSchedulingRefs(operationId: string): Promise<number>
  /** [底稿 A1-3]③ 订单工序引用计数（order_operation，真实计数）。 */
  countOrderOperationRefs(operationId: string): Promise<number>
  list(
    filter: { plantIds: string[] | null; nameLike?: string; codeLike?: string } & PageRequest,
  ): Promise<PageResult<OperationDefinitionRecord>>
}

export interface NewProductionOrder {
  id?: string
  enterpriseId: string
  plantId: string
  orderNo: string
  orderType?: string | null
  salesContractNo?: string | null
  salesOrderNo?: string | null
  lineNo?: string | null
  materialId: string
  materialSnapshot?: Record<string, unknown>
  productFamilyId?: string | null
  productionDeptId: string
  productionQty: string
  uom: string
  overrunRatio?: string | null
  orderStatus?: ProductionOrderStatus
  processConfigStatus?: ProcessConfigStatus
  processConfirmedAt?: Date | null
  bomRevisionId?: string | null
  routeRevisionId?: string | null
  plannedStartAt?: Date | null
  plannedFinishAt?: Date | null
  segmentRequirement?: string | null
  remark?: string | null
  createdBy?: string | null
}

export interface ProductionOrderPatch {
  orderStatus?: ProductionOrderStatus
  processConfigStatus?: ProcessConfigStatus
  processConfirmedAt?: Date | null
  suspended?: boolean
  suspendedReason?: string | null
  actualStartAt?: Date | null
  bomRevisionId?: string | null
  routeRevisionId?: string | null
  productFamilyId?: string | null
}

export interface ProductionOrderRepository {
  findById(id: string): Promise<ProductionOrderRecord | null>
  findByEnterpriseAndOrderNo(enterpriseId: string, orderNo: string): Promise<ProductionOrderRecord | null>
  insert(order: NewProductionOrder): Promise<ProductionOrderRecord>
  update(id: string, patch: ProductionOrderPatch, actor: string | null): Promise<ProductionOrderRecord | null>
  list(
    filter: {
      plantIds: string[] | null
      orderNoLike?: string
      statuses?: ProductionOrderStatus[]
      suspended?: boolean
    } & PageRequest,
  ): Promise<PageResult<ProductionOrderRecord>>
}

export interface NewOrderOperation {
  id?: string
  enterpriseId: string
  plantId: string
  orderId: string
  seq: number
  settingsVersion?: number
  operationDefinitionId: string
  operationCode: string
  operationName: string
  operationRemark?: string | null
  coreMultiple: number
  strandFactor?: string | null
  offlineQty: string
  workCenterId: string
  workCenterCode: string
  workCenterName: string
  uom: string
  productionDeptId: string
  routeRevisionId?: string | null
  bomRevisionId?: string | null
  createdBy?: string | null
}

export interface OrderOperationRepository {
  listByOrder(orderId: string): Promise<OrderOperationRecord[]>
  /** 当前设置版本的工序行（settings_version = order.currentSettingsVersion）。 */
  listCurrentByOrder(orderId: string, settingsVersion: number): Promise<OrderOperationRecord[]>
  insertBatch(operations: NewOrderOperation[]): Promise<OrderOperationRecord[]>
  countByOrder(orderId: string): Promise<number>
}

/** 料品/工作中心只读视图（0003 主数据表的窄读端口：订单接收与工艺校验用）。 */
export interface MaterialLookup {
  id: string
  orgScopeId: string
  code: string
  name: string
  materialType: number
  baseUom: string
  status: ProcessMasterStatus
}

export interface WorkCenterLookup {
  id: string
  enterpriseId: string
  plantId: string
  deptId: string
  code: string
  name: string
  status: ProcessMasterStatus
}

/** masterdata 只读查询端口（本域消费既有 0003 表，不写主数据）。 */
export interface ProcessMasterDataLookups {
  findMaterial(id: string): Promise<MaterialLookup | null>
  findWorkCenter(id: string): Promise<WorkCenterLookup | null>
}

/** process 命令工具集：S2 CommandTools 超集（组合根装配时注入 process 仓储束）。 */
export interface ProcessRepositories {
  families: ProductFamilyRepository
  boms: BomRevisionRepository
  routes: RouteRevisionRepository
  parameters: ParameterSpecRepository
  operations: OperationDefinitionRepository
  orders: ProductionOrderRepository
  orderOperations: OrderOperationRepository
  lookups: ProcessMasterDataLookups
}

export interface ProcessCommandTools extends CommandTools {
  process: ProcessRepositories
}
