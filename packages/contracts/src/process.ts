/**
 * 工艺与生产订单公开合同（L1-P1-SERVER T05 工艺/生产订单块）。
 *
 * 规则来源：architecture/contracts/prep/p1/03-production-chain-rules-T05T09T10T11.md
 * 的 A1/A2 节与 B1/B11（本域尚无冻结合同；字典值本地声明，contracts 零依赖，
 * 不反向 import domain，沿用 auth.ts/masterdata.ts 模式）。
 *
 * 注意：本文件在 L0 整合步加入 packages/contracts/src/index.ts 导出前，
 * 由 tests/** 以相对路径直接引用做响应形状（DTO）冻结断言；集成后由 UI/PDA 线消费。
 * 数量字段一律 DecimalString（十进制字符串，见 decimal.ts 约定）。
 */

/** 工艺版本状态轴（[底稿 A2-2]：draft→reviewed→published→retired）。 */
export type ProcessRevisionStatusDtoValue = 'draft' | 'reviewed' | 'published' | 'retired'

/** 生产订单主状态轴（[底稿 A1-1] + DM §5 完工待核显式新增）。 */
export type ProductionOrderStatusDtoValue =
  | 'approved'
  | 'released'
  | 'in_progress'
  | 'pending_completion'
  | 'closed'
  | 'voided'

/** 工序设置状态（PRD 生产订单 §1.2：未配置/已配置）。 */
export type ProcessConfigStatusDtoValue = 'unconfigured' | 'configured'

/** 订单工序执行状态（[底稿 A2-4] 变更版本预留：报工域置位，本块默认 pending）。 */
export type OperationExecutionStatusDtoValue = 'pending' | 'executed'

/** 主数据逻辑删除状态（沿用 MD-36 口径）。 */
export type ProcessMasterStatusDtoValue = 'active' | 'retired'

/** 产品族 DTO（工艺分组主数据；工艺验证按厂进行，厂级隔离）。 */
export interface ProductFamilyDto {
  id: string
  plantId: string
  code: string
  name: string
  description: string | null
  status: ProcessMasterStatusDtoValue
}

/** BOM 行（jsonb 承载：料品/数量/单位；P1 行级查询未需求）。 */
export interface BomLineDto {
  materialId: string
  materialCode: string
  quantity: string
  uom: string
}

/** 制造 BOM 版本 DTO（[底稿 A2-2]：published 后冻结，变更须生成新版本）。 */
export interface BomRevisionDto {
  id: string
  plantId: string
  productFamilyId: string
  materialId: string
  version: number
  status: ProcessRevisionStatusDtoValue
  lines: BomLineDto[]
  remark: string | null
  publishedAt: string | null
}

/** 工艺路线步（jsonb 承载；系数缺省 芯倍数=1、绞合=空）。 */
export interface RouteStepDto {
  seq: number
  operationDefinitionId: string
  workCenterId: string
  /** 芯倍数缺省（正整数） */
  coreMultiple?: number
  /** 绞合系数缺省（选填） */
  strandFactor?: string | null
}

/** 工艺路线版本 DTO（订单接收时按已发布路线展开订单工序）。 */
export interface RouteRevisionDto {
  id: string
  plantId: string
  productFamilyId: string
  version: number
  status: ProcessRevisionStatusDtoValue
  steps: RouteStepDto[]
  remark: string | null
  publishedAt: string | null
}

/** 工序主数据 DTO（[底稿 A1-3]：部门内名称唯一、组织编码内编码唯一、引用保护/编辑锁）。 */
export interface OperationDefinitionDto {
  id: string
  plantId: string
  deptId: string
  workCenterId: string
  companyOrgCode: string
  code: string
  name: string
  remark: string | null
  status: ProcessMasterStatusDtoValue
}

/** 参数规范版本 DTO（同一状态轴）。 */
export interface ParameterSpecRevisionDto {
  id: string
  plantId: string
  productFamilyId: string
  name: string
  version: number
  status: ProcessRevisionStatusDtoValue
  parameters: unknown[]
  remark: string | null
  publishedAt: string | null
}

/** 生产订单 DTO（[底稿 A1-1] 状态轴 + 挂起/作废独立 + ERP 关闭分离）。 */
export interface ProductionOrderDto {
  id: string
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
  /** 生产数量（DecimalString） */
  productionQty: string
  uom: string
  /** 超额比例（DecimalString 或 null；同步只读，报工域消费） */
  overrunRatio: string | null
  orderStatus: ProductionOrderStatusDtoValue
  processConfigStatus: ProcessConfigStatusDtoValue
  processConfirmedAt: string | null
  suspended: boolean
  suspendedReason: string | null
  actualStartAt: string | null
  businessClosedAt: string | null
  /** ERP 商业关闭（与执行完成分离，DM §5） */
  erpClosedAt: string | null
  bomRevisionId: string | null
  routeRevisionId: string | null
  /** 当前工序设置版本（S04 变更版本预留结构） */
  currentSettingsVersion: number
  plannedStartAt: string | null
  plannedFinishAt: string | null
  segmentRequirement: string | null
  remark: string | null
}

/** 订单工序 DTO（[底稿 A2-3] 快照冻结：芯倍数/绞合/下线数量/工作中心/单位 + 版本引用）。 */
export interface OrderOperationDto {
  id: string
  orderId: string
  seq: number
  /** 工序设置版本（S04 变更版本预留） */
  settingsVersion: number
  executionStatus: OperationExecutionStatusDtoValue
  operationDefinitionId: string
  operationCode: string
  operationName: string
  operationRemark: string | null
  /** 芯倍数（正整数，[底稿 A2-1]） */
  coreMultiple: number
  /** 绞合系数（DecimalString 或 null=未填） */
  strandFactor: string | null
  /** 下线数量（DecimalString，≤4 位小数） */
  offlineQty: string
  workCenterId: string
  workCenterCode: string
  workCenterName: string
  uom: string
  productionDeptId: string
  /** 路线版本引用（接收时冻结；入站载荷显式给工序而无路线时为 null） */
  routeRevisionId: string | null
  /** BOM 版本引用（接收时冻结，可空） */
  bomRevisionId: string | null
}
