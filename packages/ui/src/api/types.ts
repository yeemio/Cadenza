import type {
  AuthMeResponse,
  DataScopeInfo,
  LoginPlatform,
  OrgNodeDto,
  PageRequest,
  PageResult,
  RoleDto,
  ScopeGrantDto,
  SessionUserInfo,
  UserAccountDto,
} from '@cadenza/contracts'

/**
 * API 客户端层类型：与 apps/api 实际路由/DTO 逐一对齐（第二波起接真实后端）。
 * 结构类型直接复用 packages/contracts（auth.ts/org 域 P1-S2 增补）；
 * 本文件补充：请求 payload 形状（org-handlers 逐字段核对）、标签字典与 UI 辅助类型。
 */

export type { AuthMeResponse, DataScopeInfo, LoginPlatform, OrgNodeDto, PageRequest, PageResult, RoleDto, ScopeGrantDto, SessionUserInfo, UserAccountDto }

// ---------------- auth ----------------

/** 登录请求（apps/api POST /auth/login body；platform 须为 WEB/PDA） */
export interface LoginRequest {
  loginName: string
  password: string
  platform?: LoginPlatform
}

/** 登录响应（控制器只回 userId/loginName；完整上下文经 GET /auth/me 获取） */
export interface LoginResponse {
  token: string
  tokenType: 'Bearer'
  expiresAt: string
  user: { userId: string; loginName: string }
}

// ---------------- org 标签字典（界面呈现用；字典事实在 domain，此处仅展示名） ----------------

/** 组织节点类型（OA-08 四层模型 + enterprise 根） */
export const ORG_NODE_KIND_LABELS: Record<string, string> = {
  enterprise: '企业',
  legal_entity: '法人',
  plant: '工厂',
  department: '部门',
  work_center: '工作中心',
}

/** OA-03 机构类型 3 值字典（仅 department 节点的分类属性）：1=车间 2=质检部 3=物流部 */
export const DEPT_CATEGORY_LABELS: Record<number, string> = {
  1: '车间',
  2: '质检部',
  3: '物流部',
}

/** 用户账号状态（OA-16：disabled 不可登录；锁定为独立缓存，见 lockedUntil） */
export const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  enabled: '启用',
  disabled: '禁用',
}

/** 登录平台（OA-12：单值，WEB 或 PDA） */
export const LOGIN_PLATFORM_LABELS: Record<string, string> = {
  WEB: 'Web 工作台',
  PDA: 'PDA 现场终端',
}

/** 数据范围三维（OA-23）展示名 */
export const SCOPE_TYPE_LABELS: Record<string, string> = {
  enterprise: '企业范围',
  plant: '工厂范围',
  workshop: '车间范围',
}

/** org 域岗位许可目录（domain ORG_PERMISSIONS 同值；服务端为准） */
export const ORG_PERMISSION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'org.read', label: '组织查询（org.read）' },
  { value: 'org.admin', label: '组织管理（org.admin）' },
  { value: 'org.role.admin', label: '管理员配置（org.role.admin）' },
]

/** scope_type 与目标节点类型的配对（OA-23/GAP-A4：workshop → work_center 节点） */
export const SCOPE_TYPE_OBJECT_KIND: Record<string, string> = {
  enterprise: 'enterprise',
  plant: 'plant',
  workshop: 'work_center',
}

// ---------------- 命令端点（POST/PATCH/DELETE /org/**；变更经命令总线） ----------------

/** 命令执行成功响应（COMMITTED/DRAFT_SAVED；业务拒绝走非 2xx {code,message,details}） */
export interface CommandOk {
  operationId: string
  status: 'COMMITTED' | 'DRAFT_SAVED'
  data: unknown
}

/** 高影响操作必填原因（OA-29：机构退役/授权变更；其他命令审计记录用，选填） */
export interface CommandMeta {
  reason?: string
  operationId?: string
}

/** 机构创建（org.node.create；code/name/kind 必填，plant 必填 plantCode≤10，department 必填 deptCategory） */
export interface OrgNodeCreatePayload {
  code: string
  name: string
  kind: string
  parentId: string | null
  plantCode?: string | null
  companyOrgCode?: string | null
  deptCategory?: number | null
}

/** 机构更新（org.node.update；kind 不可改，字段缺省保持原值） */
export interface OrgNodeUpdatePayload {
  name?: string
  parentId?: string | null
  plantCode?: string | null
  companyOrgCode?: string | null
  deptCategory?: number | null
}

/** 用户创建（org.user.create；OA-10/12/13/14 服务端终校；plantId 由部门归属服务端计算） */
export interface UserCreatePayload {
  loginName: string
  password: string
  displayName: string
  deptId: string
  workshopDeptId?: string | null
  roleId: string
  loginPlatform: LoginPlatform
  accountStatus: 'enabled' | 'disabled'
  phone?: string | null
}

/** 用户更新（org.user.update；字段缺省保持原值） */
export interface UserUpdatePayload {
  displayName?: string
  deptId?: string
  workshopDeptId?: string | null
  roleId?: string
  loginPlatform?: LoginPlatform
  accountStatus?: 'enabled' | 'disabled'
  phone?: string | null
}

/** 角色创建（org.role.create；OA-17 名称/别名/排序唯一，服务端终校） */
export interface RoleCreatePayload {
  name: string
  alias: string
  sort: number
  parentRoleId?: string | null
}

/** 角色更新（org.role.update；OA-18 内置角色别名不可改，服务端终校） */
export interface RoleUpdatePayload {
  name?: string
  alias?: string
  sort?: number
  parentRoleId?: string | null
}

/** 授权/回收（org.grant.grant / org.grant.revoke；OA-29 reason 必填，OA-22 同键合并） */
export interface GrantPayload {
  principalType: 'role' | 'user'
  principalId: string
  scopeType: 'enterprise' | 'plant' | 'workshop'
  scopeObjectId: string
  permissions: string[]
}

// ---------------- masterdata 视图（结构对齐 application 层 MaterialView/EquipmentView 等；字段以 masterdata-queries.ts 为准） ----------------

/** 时间字段一律 ISO-8601 字符串；数量字段（factor/capacity）为十进制字符串 */
export interface MaterialDto {
  id: string
  orgScopeId: string
  code: string
  name: string
  companyOrgCode: string | null
  materialGroupCode: string | null
  materialGroupName: string | null
  descriptionZh: string | null
  descriptionEn: string | null
  voltage: string | null
  standard: string | null
  customer: string | null
  materialType: number
  spec: string | null
  color: string | null
  baseUom: string
  qcFlag: number
  remark: string | null
  sourceSystem: string
  status: 'active' | 'retired'
  createdAt: string
  updatedAt: string
}

export interface ConversionLineDto {
  id: string
  materialId: string
  version: number
  unitName: string
  factor: string
  referenced: boolean
  status: 'active' | 'retired'
  createdAt: string
  updatedAt: string
}

/** GET /masterdata/materials/:id/conversions 响应 */
export interface ConversionsResult {
  material: MaterialDto | null
  items: ConversionLineDto[]
}

export interface EquipmentDto {
  id: string
  plantId: string
  deptId: string
  workCenterId: string
  code: string
  name: string
  actualNo: string | null
  model: string | null
  stdRateText: string | null
  /** MD-13 字典：1=正常 2=维修 */
  equipmentStatus: number
  /** DecimalString 或 null（MD-16：10 位整数＋4 位小数） */
  capacity: string | null
  status: 'active' | 'retired'
  createdAt: string
  updatedAt: string
}

/** 设备状态流水（MD-14 append-only） */
export interface EquipmentStatusLogDto {
  id: string
  equipmentId: string
  oldStatus: number
  newStatus: number
  source: string
  actor: string
  createdAt: string
}

export interface WarehouseDto {
  id: string
  plantId: string
  deptId: string
  code: string
  name: string
  warehouseType: 'WAREHOUSE' | 'LINE_SIDE'
  materialTypes: number[]
  managerUserId: string | null
  phone: string | null
  address: string | null
  qrBound: boolean
  status: 'active' | 'retired'
  createdAt: string
  updatedAt: string
}

export interface StorageLocationDto {
  id: string
  plantId: string
  warehouseId: string
  rackId: string | null
  locationKind: 'NORMAL' | 'RACK'
  code: string
  zoneCode: string | null
  remark: string | null
  qrBound: boolean
  status: 'active' | 'retired'
  createdAt: string
  updatedAt: string
}

export interface RackDto {
  id: string
  plantId: string
  warehouseId: string
  code: string
  zones: number
  layers: number
  remark: string | null
  status: 'active' | 'retired'
  createdAt: string
  updatedAt: string
}

export interface WorkCenterDto {
  id: string
  plantId: string
  deptId: string
  code: string
  name: string
  status: 'active' | 'retired'
  createdAt: string
  updatedAt: string
}

// ---------------- inventory 视图（结构对齐 application 层 BalanceView/BarcodeResolveView/UnitDetailView） ----------------

/** 余额行（IT-20 账面 + IT-14 可用量三段；IT-10 feetDisplay 展示列） */
export interface BalanceDto {
  balanceId: string
  unitId: string
  unitNo: string
  materialCode: string
  lotNo: string
  locationCode: string
  ownerName: string
  quantity: string
  reservedQuantity: string
  availableQuantity: string
  uomCode: string
  qualityStatus: string
  status: string
  plantId: string
  feetDisplay: string
}

/** 条码解析候选（IT-04/05/06：一码多物需显式选择） */
export interface BarcodeCandidateDto {
  objectType: string
  objectId: string
  label: string
  via: 'direct_binding' | 'carrier_load'
}

export interface BarcodeResolveDto {
  barcodeValue: string
  kind: { kind: string; confidence: string; matchedPattern: string | null }
  hasActiveBinding: boolean
  boundType: string | null
  boundId: string | null
  candidates: BarcodeCandidateDto[]
}

export interface UnitDetailDto {
  unitId: string
  unitNo: string
  materialCode: string
  lotNo: string
  traceMode: string
  status: string
  balanceOpen: boolean
  balances: Array<{
    balanceId: string
    locationCode: string
    ownerName: string
    quantity: string
    qualityStatus: string
    status: string
  }>
  activeReservations: Array<{
    reservationId: string
    holderType: string
    holderRef: string
    quantity: string
    validUntil: string
  }>
  recentTransactions: Array<{
    transactionId: string
    lineNo: number
    movementKind: string
    quantity: string
    beforeQty: string
    afterQty: string
    businessTime: string
  }>
  genealogy: Array<{
    edgeId: string
    edgeKind: string
    fromType: string
    fromId: string
    toType: string
    toId: string
    quantity: string
  }>
}

// ---------------- masterdata 命令 payload（masterdata-handlers 逐字段核对） ----------------

/** 换算行创建（masterdata.conversion.create；MD-04：factor 非负、整数≤9 位、小数≤4 位） */
export interface ConversionCreatePayload {
  materialId: string
  unitName: string
  factor: string
}

export interface ConversionUpdatePayload {
  unitName?: string
  factor?: string
}

/** 换算行新版本（masterdata.conversion.newVersion；MD-05 原行不动生成新版本） */
export interface ConversionNewVersionPayload {
  factor: string
  unitName?: string
}

export interface EquipmentCreatePayload {
  code: string
  name: string
  deptId: string
  workCenterId: string
  /** MD-13：1=正常 2=维修 */
  equipmentStatus: number
  /** MD-16：10 位整数＋4 位小数十进制字符串 */
  capacity?: string
  actualNo?: string
  model?: string
  stdRateText?: string
}

/** 设备编辑（masterdata.equipment.update；状态变更走 changeStatus，不走本命令） */
export interface EquipmentUpdatePayload {
  name?: string
  deptId?: string
  workCenterId?: string
  capacity?: string
  actualNo?: string
  model?: string
  stdRateText?: string
}

/** 设备状态变更（masterdata.equipment.changeStatus；MD-14 记流水） */
export interface EquipmentChangeStatusPayload {
  equipmentStatus: number
  /** 来源字典 WEB/PDA，缺省 WEB */
  source?: string
}

export interface WarehouseCreatePayload {
  /** MD-22：4 位数字 */
  code: string
  name: string
  deptId: string
  warehouseType: 'WAREHOUSE' | 'LINE_SIDE'
  materialTypes: number[]
  managerUserId?: string
  phone?: string
  address?: string
}

export interface WarehouseUpdatePayload {
  code?: string
  name?: string
  deptId?: string
  warehouseType?: 'WAREHOUSE' | 'LINE_SIDE'
  materialTypes?: number[]
  managerUserId?: string
  phone?: string
  address?: string
}

/** 普通库位创建（masterdata.location.create；MD-28：8 位数字＝仓库码 4 位＋库位码 4 位） */
export interface LocationCreatePayload {
  warehouseId: string
  code: string
  remark?: string
}

export interface LocationUpdatePayload {
  code?: string
  remark?: string
}

/** 货架创建（masterdata.rack.create；MD-30 编号 2 位数字；MD-31 区域/层数 1–99，自动生成区域与库位） */
export interface RackCreatePayload {
  warehouseId: string
  code: string
  zones: number
  layers: number
  remark?: string
}

/** 货架编辑（MD-31：层数/区域数量编辑不可改，仅编号/换仓/备注） */
export interface RackUpdatePayload {
  code?: string
  warehouseId?: string
  remark?: string
}

export interface WorkCenterCreatePayload {
  code: string
  name: string
  deptId: string
}

export interface WorkCenterUpdatePayload {
  code?: string
  name?: string
  deptId?: string
}

// ---------------- inventory 命令 payload（inventory-posting 逐字段核对；数量一律十进制字符串 IT-07） ----------------

/** 收货入账（inventory.receive-goods；IT-01/02/07/08/25） */
export interface InventoryReceivePayload {
  plantId: string
  quantity: string
  uomId: string
  uomCode: string
  measurementBasis?: string
  locationId: string
  locationCode: string
  ownerId: string
  ownerName: string
  isCustomerSupplied?: boolean
  lotNo: string
  materialId: string
  materialCode: string
  supplierLotNo?: string
  unitNo: string
  traceMode?: 'quantity' | 'segment'
  qualityStatus?: string
  conversionRevisionId?: string
  reason?: string
}

/** 发料扣减（inventory.issue-material；IT-14/15/23/30-①；locationId/ownerId 缺省取唯一活动余额） */
export interface InventoryIssuePayload {
  unitId: string
  quantity: string
  locationId?: string
  ownerId?: string
  reservationId?: string
  refType?: string
  refId?: string
  reason?: string
}

/** 移位（inventory.move-stock） */
export interface InventoryMovePayload {
  unitId: string
  quantity: string
  toLocationId: string
  toLocationCode: string
  locationId?: string
  ownerId?: string
  reason?: string
}

/** 调拨出（inventory.transfer.out；转入中转库位） */
export interface InventoryTransferOutPayload {
  unitId: string
  quantity: string
  transitLocationId: string
  transitLocationCode: string
  locationId?: string
  ownerId?: string
  reason?: string
}

/** 调拨入（inventory.transfer.in；自中转库位转回目标库位） */
export interface InventoryTransferInPayload {
  unitId: string
  quantity: string
  toLocationId: string
  toLocationCode: string
  transitLocationId: string
  reason?: string
}

/** 分盘（inventory.split；retainedQty 留在原单元，余量生成新单元） */
export interface InventorySplitPayload {
  sourceUnitId: string
  quantity: string
  retainedQty: string
  reason?: string
}

/** 预留登记（inventory.reservation.acquire；IT-23 有效期须晚于当前时间） */
export interface ReservationAcquirePayload {
  unitId: string
  holderType: string
  holderRef: string
  quantity: string
  validUntil: string
}

/** 预留释放（inventory.reservation.release） */
export interface ReservationReleasePayload {
  reservationId: string
}

// ---------------- masterdata/inventory 标签字典（字典事实在 domain；此处仅展示名） ----------------

/** MD-23 仓库类型 */
export const WAREHOUSE_TYPE_LABELS: Record<string, string> = {
  WAREHOUSE: '仓库',
  LINE_SIDE: '线边仓',
}

/** 料品类型（1=原料 2=半成品 3=成品） */
export const MATERIAL_TYPE_LABELS: Record<number, string> = {
  1: '原料',
  2: '半成品',
  3: '成品',
}

/** MD-13 设备状态：1=正常 2=维修 */
export const EQUIPMENT_STATUS_LABELS: Record<number, string> = {
  1: '正常',
  2: '维修',
}

/** MD-36 主数据逻辑删除状态列 */
export const MASTERDATA_STATUS_LABELS: Record<string, string> = {
  active: '启用',
  retired: '已失效',
}

/** 库位类型（MD-28 普通 / MD-31 货架派生） */
export const LOCATION_KIND_LABELS: Record<string, string> = {
  NORMAL: '普通库位',
  RACK: '货架库位',
}

/** 质量状态（stock-state.ts QUALITY_STATUSES） */
export const QUALITY_STATUS_LABELS: Record<string, string> = {
  qualified: '合格',
  pending_inspection: '待检',
  unqualified: '不合格',
}

/** 库存单元状态 */
export const UNIT_STATUS_LABELS: Record<string, string> = {
  in_stock: '在库',
  exhausted: '已出清',
  closed: '已关闭',
}

/** 流水变动类型（posting.ts MOVEMENT_KINDS） */
export const MOVEMENT_KIND_LABELS: Record<string, string> = {
  receive: '收货',
  issue: '发料',
  move: '移位',
  transfer_out: '调拨出',
  transfer_in: '调拨入',
  split: '分盘',
  merge: '并盘',
  adjust: '调整',
  reverse: '冲销',
}

/** 追溯模式（IT 单元维度） */
export const TRACE_MODE_LABELS: Record<string, string> = {
  quantity: '数量追溯',
  segment: '线段追溯',
}

/** 条码解析候选来源 */
export const BARCODE_VIA_LABELS: Record<string, string> = {
  direct_binding: '码直接绑定',
  carrier_load: '载具装载',
}

/** masterdata 域许可（domain MASTERDATA_PERMISSIONS 同值；按钮显隐用，服务端终校） */
export const MASTERDATA_PERMISSION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'masterdata.read', label: '主数据查询（masterdata.read）' },
  { value: 'masterdata.admin', label: '主数据维护（masterdata.admin）' },
]

/** inventory 域许可（domain INVENTORY_PERMISSIONS 同值） */
export const INVENTORY_PERMISSION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'inventory.read', label: '库存查询（inventory.read）' },
  { value: 'inventory.post', label: '库存记账（inventory.post）' },
  { value: 'inventory.reserve', label: '预留管理（inventory.reserve）' },
]

/**
 * MD-23 展示层镜像：仓库类型限定可收料品类型集合
 * （仓库→原料/成品；线边仓→原料/半成品/成品）。前端即时提示用；服务端终校。
 */
export const ALLOWED_MATERIAL_TYPES_BY_WAREHOUSE_TYPE: Readonly<
  Record<'WAREHOUSE' | 'LINE_SIDE', readonly number[]>
> = {
  WAREHOUSE: [1, 3],
  LINE_SIDE: [1, 2, 3],
}

/**
 * MD-24 展示层镜像（domain DEFAULT_DEPT_WAREHOUSE_TYPE_RULE 同值）：
 * 物流部（3）只能建「仓库」、车间（1）只能建「线边仓」；质检部（2）不受限。
 * 返回 undefined 表示该部门类型不受限。
 */
export function deptAllowedWarehouseTypes(deptCategory: number | null | undefined): readonly ('WAREHOUSE' | 'LINE_SIDE')[] | undefined {
  if (deptCategory === 3) return ['WAREHOUSE']
  if (deptCategory === 1) return ['LINE_SIDE']
  return undefined
}

// ---------------- process 域（生产订单 T05；视图形状对齐 application/process-queries） ----------------

/** 生产订单主状态轴（[底稿 A1-1] + DM §5 完工待核显式新增） */
export type ProductionOrderStatusValue =
  | 'approved'
  | 'released'
  | 'in_progress'
  | 'pending_completion'
  | 'closed'
  | 'voided'

/** 工序设置状态（PRD 生产订单 §1.2：未配置/已配置） */
export type ProcessConfigStatusValue = 'unconfigured' | 'configured'

/** 工序执行状态（报工域置位，本块默认 pending） */
export type OperationExecutionStatusValue = 'pending' | 'executed'

/** 生产订单视图（ProductionOrderView：记录除 enterpriseId/createdBy/updatedBy 全量返回） */
export interface ProductionOrderDto {
  id: string
  plantId: string
  orderNo: string
  orderType: string | null
  salesContractNo: string | null
  salesOrderNo: string | null
  lineNo: string | null
  materialId: string
  /** 料品快照（接收时冻结；名称/规格/颜色等） */
  materialSnapshot: Record<string, unknown>
  productFamilyId: string | null
  productionDeptId: string
  /** 生产数量（DecimalString） */
  productionQty: string
  uom: string
  overrunRatio: string | null
  orderStatus: ProductionOrderStatusValue
  processConfigStatus: ProcessConfigStatusValue
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
  /** 当前工序设置版本（S04 变更版本预留） */
  currentSettingsVersion: number
  plannedStartAt: string | null
  plannedFinishAt: string | null
  segmentRequirement: string | null
  remark: string | null
  createdAt: string
  updatedAt: string
}

/** 订单工序视图（[底稿 A2-3] 快照冻结行） */
export interface OrderOperationDto {
  id: string
  plantId: string
  orderId: string
  seq: number
  /** 工序设置版本（快照版本） */
  settingsVersion: number
  executionStatus: OperationExecutionStatusValue
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
  routeRevisionId: string | null
  bomRevisionId: string | null
  createdAt: string
  updatedAt: string
}

/** GET /process/orders/:id 响应 */
export interface ProductionOrderDetailDto {
  order: ProductionOrderDto | null
  operations: OrderOperationDto[]
}

/** process.order.receive（模拟 U9 入站；同企业生产单号唯一） */
export interface ProductionOrderReceivePayload {
  orderNo: string
  materialId: string
  productionDeptId: string
  productionQty: string
  uom: string
  overrunRatio?: string
  /** 入站初始状态：approved（缺省）/released */
  initialStatus?: 'approved' | 'released'
  processConfirmed?: boolean
  productFamilyId?: string
  reason?: string
}

/** process.order.suspend（挂起必填原因） */
export interface ProductionOrderSuspendPayload {
  reason?: string
}

// ---------------- scheduling 域（T09；形状对齐 application/scheduling-queries 视图） ----------------

/** 订单排产状态（[底稿 A3-4 / OS §1.2]） */
export type OrderSchedulingStatusValue = 'unplanned' | 'partially_scheduled' | 'fully_scheduled'

/** 订单视图工序行下槽位格 */
export interface OrderViewSlotCellDto {
  slotId: string
  equipmentId: string
  equipmentCode: string
  equipmentName: string
  /** 1=正常 2=维修（[A3-3] 设备状态标签） */
  equipmentStatus: number
  productionDate: string
  plannedQty: string
  remark: string | null
}

/** 订单视图工序行（[A3-4] 回写链投影） */
export interface OrderViewOperationDto {
  orderOperationId: string
  seq: number
  operationDefinitionId: string
  operationName: string
  operationRemark: string | null
  offlineQty: string
  scheduledQty: string
  fullyScheduled: boolean
  uom: string
  workCenterId: string
  slots: OrderViewSlotCellDto[]
}

/** 订单视图投影（GET /scheduling/order-view/:orderId） */
export interface OrderSchedulingViewDto {
  orderId: string
  plantId: string
  orderNo: string
  uom: string
  orderStatus: string
  /** [A3-6] 详情前置（工序已配置且均已配置工作中心） */
  enterable: boolean
  entryBlocker: string | null
  schedulingStatus: OrderSchedulingStatusValue
  operations: OrderViewOperationDto[]
}

/** 设备看板格明细（悬停/点击明细：当日该设备某订单计划量） */
export interface DeviceBoardCellDetailDto {
  orderId: string
  orderNo: string
  salesOrderNo: string | null
  plannedQty: string
  uom: string
}

/** 设备看板格 */
export interface DeviceBoardCellDto {
  productionDate: string
  orderCount: number
  plannedTotal: string
  details: DeviceBoardCellDetailDto[]
}

/** 设备看板行 */
export interface DeviceBoardEquipmentRowDto {
  equipmentId: string
  code: string
  name: string
  equipmentStatus: number
  workCenterId: string
  cells: DeviceBoardCellDto[]
}

/** 设备视图投影（GET /scheduling/device-view） */
export interface DeviceBoardViewDto {
  plantId: string
  workCenterId: string | null
  today: string
  dates: string[]
  workCenters: Array<{ id: string; code: string; name: string }>
  equipments: DeviceBoardEquipmentRowDto[]
}

/** PDA 排产计划（只读，按工作中心分组） */
export interface PdaPlanViewDto {
  workCenterId: string
  workCenterName: string
  groups: Array<{
    productionDate: string
    items: Array<{
      slotId: string
      orderNo: string
      salesOrderNo: string | null
      equipmentId: string
      equipmentName: string
      materialDesc: string
      plannedQty: string
      uom: string
      remark: string | null
    }>
  }>
}

/** 班次信息与双轨时间（[A4-2]） */
export interface ShiftInfoDto {
  calendar?: { dayShiftStartHour: number; dayShiftStartMinute: number; utcOffsetHours: number; verification: 'CONFIGURED_SITE_UNVERIFIED' | 'UNVERIFIED_DEFAULT' }
  plantId: string
  dayShiftStart: string | null
  actualTime: string
  shiftDate: string | null
}

/** scheduling.slot.save（单槽；改 0 = 删槽；confirm 为 [A3-2w] 超产能弱提醒二次提交标志） */
export interface ScheduleSlotSavePayload {
  orderOperationId: string
  equipmentId: string
  /** 生产日期 YYYY-MM-DD */
  productionDate: string
  /** 计划产量（DecimalString，>0；'0' = 删槽） */
  plannedQty: string
  remark?: string
  confirm?: boolean
  reason?: string
}

/** scheduling.slot.saveBatch（批量矩阵保存） */
export interface ScheduleSlotsBatchPayload {
  entries: Array<Omit<ScheduleSlotSavePayload, 'reason'>>
  confirm?: boolean
  reason?: string
}

/** scheduling.capacity.set（设备日产能配置；0 = 已配置零产能） */
export interface EquipmentCapacitySetPayload {
  equipmentId: string
  productionDate: string
  capacity: string
  uom?: string
  reason?: string
}

/** scheduling.capacity.clear */
export interface EquipmentCapacityClearPayload {
  equipmentId: string
  productionDate: string
  reason?: string
}

/** scheduling.shift.set（白班起点，工厂级唯一 [A4-1]） */
export interface ShiftParameterSetPayload {
  plantId: string
  /** HH:MM 24 小时制 */
  dayShiftStart: string
  reason?: string
}

// ---------------- execution 域（T10/T11；形状对齐 application/execution-queries 视图与记录） ----------------

/** 报工来源三值（[底稿 A6-1]） */
export type ExecutionSourceValue = 'order' | 'workbench' | 'scan'

/** 报工单提交轴（deleted 保留行供审计） */
export type ReportStatusValue = 'draft' | 'submitted' | 'deleted'

/** 审核轴（cancelled=已取消审核回待审的留痕值） */
export type ReviewStatusValue = 'pending_review' | 'auto_approved' | 'manual_approved' | 'cancelled'

/** 投料类型（[底稿 A7-4]） */
export type FeedTypeValue = 'report' | 'standalone'

/** 草稿列表行（主页「N 条报工待提交」） */
export interface ExecutionDraftDto {
  sessionId: string
  reportId: string | null
  orderId: string
  source: ExecutionSourceValue
  orderOperationId: string | null
  operationSeq: number | null
  operatorUserId: string
  operatorLogin: string
  shiftDate: string
  businessTime: string
  remark: string | null
  draftFeeds: unknown[]
  /** 草稿续作锁工序（已有产出的草稿工序不可改，[A6-2]） */
  lockedOperationId: string | null
  outputs: Array<{
    lineNo: number
    quantity: string
    qualifiedQty: string
    uomCode: string
    carrierCode: string | null
    targetLocationId: string
    targetLocationCode: string
  }>
}

/** 报工单产出行（数量+单位+载体码+目标线边库） */
export interface ReportOutputDto {
  id: string
  reportId: string
  lineNo: number
  quantity: string
  qualifiedQty: string
  uomId: string
  uomCode: string
  carrierCode: string | null
  targetLocationId: string
  targetLocationCode: string
  ownerId: string
  ownerName: string
  measurementBasis: string
  /** 审核通过转线边库后的库存单元（五量 stocked 口径依据） */
  stockUnitId: string | null
  createdAt: string
}

/** 投料记录行（扣前/扣后 + 销售行归属 + 类型） */
export interface MaterialConsumptionDto {
  id: string
  orderId: string
  orderOperationId: string
  operationSeq: number
  reportId: string | null
  feedType: FeedTypeValue
  inventoryUnitId: string
  unitNo: string
  barcodeValue: string | null
  quantity: string
  beforeQty: string
  afterQty: string
  uomCode: string
  salesOrderNo: string | null
  salesLineNo: string | null
  crossOrder: boolean
  deviationReason: string | null
  issuedLocationCode: string | null
  operatorLogin: string
  businessTime: string
  shiftDate: string | null
}

/** 报工单详情（GET /execution/reports/:id） */
export interface ReportDetailViewDto {
  report: {
    id: string
    sessionId: string
    orderId: string
    orderOperationId: string
    operationSeq: number
    source: ExecutionSourceValue
    status: ReportStatusValue
    reviewStatus: ReviewStatusValue
    operatorUserId: string
    operatorLogin: string
    businessTime: string
    shiftDate: string
    equipmentCode: string | null
    reviewedAt: string | null
    reviewedBy: string | null
    reviewCancelledAt: string | null
    qcCompletedAt: string | null
    correctionOf: string | null
    remark: string | null
  }
  outputs: ReportOutputDto[]
  feeds: MaterialConsumptionDto[]
  reviewCancelled: boolean
}

/** 五量分立（[底稿 A5-3]：草稿/提交/审核/合格/入库，不做混口径） */
export interface FiveQuantities {
  draftQty: string
  submittedQty: string
  approvedQty: string
  qualifiedQty: string
  stockedQty: string
}

/** 五量查询视图（GET /execution/orders/:id/quantities） */
export interface OrderQuantitiesDto {
  orderId: string
  orderNo: string
  uom: string
  total: FiveQuantities
  operations: Array<{
    orderOperationId: string
    seq: number
    operationName: string
    isQc: boolean
    isLastNonQc: boolean
    quantities: FiveQuantities
    ready: boolean
    readyReason: string
  }>
}

/** 扫码报工上下文（扫设备码→按班次日期带任务单） */
export interface ScanContextEntryDto {
  orderId: string
  orderOperationId: string
  operationSeq: number
  operationDefinitionId: string
}

/** 工时记录视图 */
export interface LaborRecordDto {
  id: string
  orderId: string
  orderOperationId: string | null
  reportId: string | null
  operatorUserId: string
  operatorLogin: string
  hours: string
  shiftDate: string
  businessTime: string
  note: string | null
}

/** 报工产出行载荷（[A6-5/A5-2]：数量+单位+载体码+目标线边库；单位与订单一致） */
export interface ReportOutputPayload {
  quantity: string
  qualifiedQty?: string
  uomId: string
  uomCode: string
  carrierCode?: string | null
  targetLocationId: string
  targetLocationCode: string
}

/** 投料意图行（草稿快照与提交共用；unitId 或 barcodeValue 二选一） */
export interface FeedLinePayload {
  unitId?: string
  barcodeValue?: string
  quantity: string
  salesOrderNo?: string
  salesLineNo?: string
  /** 跨订单显式确认（[A7-3]） */
  confirmed?: boolean
  deviationReason?: string | null
  locationId?: string
}

/** 三入口报工载荷（action 缺省=提交；'draft'=仅存草稿；source/orderId 由服务端注入） */
export interface ReportEntryPayload {
  orderId?: string
  orderOperationId?: string
  equipmentId?: string
  equipmentCode?: string
  operatorUserId?: string
  businessTime?: string
  action?: 'submit' | 'draft'
  outputs: ReportOutputPayload[]
  feeds?: FeedLinePayload[]
  remark?: string
  correctionOf?: string
}

/** execution.labor.record */
export interface LaborRecordPayload {
  orderId: string
  orderOperationId?: string
  reportId?: string
  operatorUserId?: string
  hours: string
  note?: string
  reason?: string
}

// ---------------- quality 域（T12；形状对齐 application/quality-queries 视图） ----------------

/** 检验单状态 */
export type InspectionStatusValue = 'pending' | 'in_progress' | 'concluded' | 'cancelled'

/** 检验阶段（过程/成品） */
export type InspectionStageValue = 'process' | 'finished'

/** 检验结论（版本化生效指针口径） */
export type TestConclusionValue = 'pending' | 'qualified' | 'unqualified'

/** 处置种类（放行/让步——让步保留原不合格事实） */
export type DispositionKindValue = 'release' | 'concession'

/** 隔离种类 */
export type HoldKindValue = 'pending_inspection' | 'unqualified' | 'suspect'

/** 检验任务视图（GET /quality/inspections 行） */
export interface InspectionOrderDto {
  id: string
  orderNo: string
  sourceType: 'work_report' | 'putaway_receipt'
  sourceRef: string
  inspectionStage: InspectionStageValue
  specCode: string
  specVersion: number
  inventoryUnitId: string | null
  unitNo: string | null
  materialId: string
  materialCode: string
  lotId: string | null
  quantity: string
  uomId: string
  uomCode: string
  status: InspectionStatusValue
  productionOrderNo: string | null
  productionDeptId: string | null
  productionDeptName: string | null
  plantId: string
}

/** 检验项实测明细 */
export interface InspectionItemMeasurementDto {
  itemNo: string
  itemName: string | null
  measuredValue: string
  judgement: 'pass' | 'fail' | 'not_tested'
  note: string | null
}

/** 结论版本行（追加历史+生效指针，S14） */
export interface TestResultVersionDto {
  resultId: string
  version: number
  resultKind: 'initial' | 'test' | 're_inspection'
  conclusion: TestConclusionValue
  items: unknown
  isEffective: boolean
  inspector: string | null
  inspectedAt: string | null
}

/** 处置记录（放行/让步） */
export interface InspectionDispositionDto {
  dispositionId: string
  dispositionKind: DispositionKindValue
  basedOnVersion: number
  releasedBy: string
  releasedAt: string
  reason: string | null
}

/** 检验单详情（GET /quality/inspections/:id） */
export interface InspectionDetailDto extends InspectionOrderDto {
  statusLabel: string
  results: TestResultVersionDto[]
  dispositions: InspectionDispositionDto[]
}

/** 存疑/隔离记录视图（GET /quality/holds 行） */
export interface QualityHoldDto {
  id: string
  inventoryUnitId: string
  unitNo: string
  holdKind: HoldKindValue
  holdKindLabel: string
  status: 'active' | 'released'
  previousQualityStatus: string | null
  raisedBy: string
  raisedAt: string
  productionDeptId: string | null
  productionDeptName: string | null
  releasedBy: string | null
  releasedAt: string | null
  dispositionNote: string | null
  plantId: string
  businessTime: string
}

/** quality.inspection.generate */
export interface InspectionGeneratePayload {
  plantId: string
  eventTypes?: string[]
  defaultSpecCode?: string
  defaultSpecVersion?: number
  reason?: string
}

/** quality.test-result.submit（追加版本行+翻生效指针） */
export interface TestResultSubmitPayload {
  inspectionOrderId: string
  conclusion: 'qualified' | 'unqualified'
  items: InspectionItemMeasurementDto[]
  inspector?: string
  reason?: string
  businessTime?: string
}

/** quality.disposition.release */
export interface DispositionReleasePayload {
  inspectionOrderId: string
  reason?: string
  businessTime?: string
}

/** quality.disposition.concession（basedOnVersion 引用原结论，保留不合格事实） */
export interface DispositionConcessionPayload {
  inspectionOrderId: string
  basedOnVersion: number
  reason: string
  businessTime?: string
}

/** quality.suspect.register（在库+在库位+未存疑+托码拒） */
export interface SuspectRegisterPayload {
  plantId: string
  unitId?: string
  unitNo?: string
  barcodeValue?: string
  productionDeptId?: string
  productionDeptName?: string
  reason?: string
  businessTime?: string
}

/** quality.suspect.restore（处置依据必填） */
export interface SuspectRestorePayload {
  holdId?: string
  unitId?: string
  dispositionNote: string
  reason?: string
  businessTime?: string
}

// ---------------- warehousing 域（T13；形状对齐 application/warehousing-queries 视图） ----------------

/** 待入库任务状态 */
export type PutawayTaskStatusValue = 'pending' | 'done' | 'cancelled'

/** 调拨状态机（A-T13-10） */
export type TransferStatusValue =
  | 'draft'
  | 'ready'
  | 'shipping'
  | 'shipped_in_transit'
  | 'receiving'
  | 'completed'
  | 'cancelled'

/** 调拨种类 */
export type TransferKindValue = 'production' | 'warehouse' | 'auto'

/** 待入库任务视图 */
export interface PutawayTaskDto {
  id: string
  sourceType: 'work_report' | 'finished_inspection'
  sourceRef: string
  unitNo: string | null
  palletCode: string | null
  materialId: string
  materialCode: string
  quantity: string
  uomId: string
  uomCode: string
  targetWarehouseId: string | null
  status: PutawayTaskStatusValue
  statusLabel: string
  inventoryUnitId: string | null
  locationId: string | null
  locationCode: string | null
  putawayBy: string | null
  putawayAt: string | null
  plantId: string
}

/** 移库记录视图（append-only） */
export interface WarehouseMoveDto {
  id: string
  inventoryUnitId: string
  unitNo: string
  fromLocationId: string | null
  fromLocationCode: string | null
  toLocationId: string | null
  toLocationCode: string | null
  quantity: string
  uomId: string
  uomCode: string
  movedBy: string
  movedAt: string
  reason: string | null
  plantId: string
}

/** 调拨单视图（列表行） */
export interface TransferOrderDto {
  id: string
  orderNo: string
  transferKind: TransferKindValue
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseCode: string | null
  toWarehouseCode: string | null
  fromWarehouseType: string | null
  toWarehouseType: string | null
  status: TransferStatusValue
  statusLabel: string
  transitLocationId: string | null
  transitLocationCode: string | null
  lockedValidUntil: string | null
  note: string | null
  submittedBy: string | null
  submittedAt: string | null
  shippedBy: string | null
  shippedAt: string | null
  completedBy: string | null
  completedAt: string | null
  plantId: string
}

/** 调拨行（两段事实 out/in + 预留引用） */
export interface TransferLineDto {
  lineId: string
  lineNo: number
  inventoryUnitId: string
  unitNo: string
  materialCode: string | null
  quantity: string
  outQty: string
  inQty: string
  reservationId: string | null
  outDone: boolean
  inDone: boolean
}

/** 调拨单详情（GET /warehousing/transfers/:id） */
export interface TransferDetailDto extends TransferOrderDto {
  lines: TransferLineDto[]
}

/** warehousing.putaway.refresh（从执行事件重跑；台账禁手工增删改） */
export interface PutawayRefreshPayload {
  plantId: string
  eventTypes?: string[]
  reason?: string
}

/** warehousing.putaway.confirm（任务台账 taskIds / 组单 unitNos / 托码整托三入口） */
export interface PutawayConfirmPayload {
  plantId: string
  taskIds?: string[]
  unitNos?: string[]
  palletCode?: string
  toWarehouseId: string
  toWarehouseCode?: string
  toWarehouseKind?: string
  toLocationId: string
  toLocationCode: string
  ownerId?: string
  ownerName?: string
  reason?: string
  businessTime?: string
}

/** warehousing.move.execute（同仓内库位移动，原/现库位逐码） */
export interface MoveExecutePayload {
  plantId: string
  unitId: string
  fromLocationId?: string
  toLocationId: string
  toLocationCode: string
  quantity?: string
  reason?: string
  businessTime?: string
}

/** warehousing.transfer.create（草稿；行=单元+数量） */
export interface TransferCreatePayload {
  plantId: string
  transferKind: TransferKindValue
  fromWarehouseId: string
  toWarehouseId: string
  fromWarehouseKind?: string
  toWarehouseKind?: string
  transitLocationId: string
  transitLocationCode: string
  lines: Array<{
    unitId: string
    unitNo: string
    quantity: string
    materialId?: string
    materialCode?: string
    materialType?: number
  }>
  note?: string
  reason?: string
}

/** warehousing.transfer.submit（锁定=作业预留，有效期必填 A-T13-11/IT-23） */
export interface TransferSubmitPayload {
  transferOrderId: string
  lockValidUntil: string
  reason?: string
}

/** warehousing.transfer.ship（单行原子出库段） */
export interface TransferShipPayload {
  transferOrderId: string
  lineId: string
  quantity?: string
  reason?: string
}

/** warehousing.transfer.transit（状态推进+在途对账断言，幂等） */
export interface TransferTransitPayload {
  transferOrderId: string
  reason?: string
}

/** warehousing.transfer.receive（单行原子接收段） */
export interface TransferReceivePayload {
  transferOrderId: string
  lineId: string
  quantity?: string
  toLocationId?: string
  toLocationCode?: string
  reason?: string
}

// ---------------- 四域标签字典（字典事实在 domain；此处仅展示名） ----------------

/** 生产订单主状态轴（[底稿 A1-1]） */
export const PRODUCTION_ORDER_STATUS_LABELS: Record<string, string> = {
  approved: '已审批',
  released: '已下达',
  in_progress: '进行中',
  pending_completion: '完工待核',
  closed: '已关闭',
  voided: '已作废',
}

/** 订单排产状态（[底稿 A3-4]） */
export const ORDER_SCHEDULING_STATUS_LABELS: Record<string, string> = {
  unplanned: '未排产',
  partially_scheduled: '部分排产',
  fully_scheduled: '已排产',
}

/** 工序设置状态 */
export const PROCESS_CONFIG_STATUS_LABELS: Record<string, string> = {
  unconfigured: '未配置',
  configured: '已配置',
}

/** 工序执行状态 */
export const OPERATION_EXECUTION_STATUS_LABELS: Record<string, string> = {
  pending: '未执行',
  executed: '已执行',
}

/** 报工来源三值（[底稿 A6-1]） */
export const EXECUTION_SOURCE_LABELS: Record<string, string> = {
  order: '订单报工',
  workbench: '工作台报工',
  scan: '扫码报工',
}

/** 报工单状态 */
export const REPORT_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  deleted: '已删除',
}

/** 审核轴（[底稿 A6-4]） */
export const REVIEW_STATUS_LABELS: Record<string, string> = {
  pending_review: '待审核',
  auto_approved: '自动通过',
  manual_approved: '人工通过',
  cancelled: '已取消审核',
}

/** 投料类型（[底稿 A7-4]） */
export const FEED_TYPE_LABELS: Record<string, string> = {
  report: '报工投料',
  standalone: '单独投料',
}

/** 检验单状态 */
export const INSPECTION_STATUS_LABELS: Record<string, string> = {
  pending: '待检',
  in_progress: '检验中',
  concluded: '已出结论',
  cancelled: '已作废',
}

/** 检验阶段 */
export const INSPECTION_STAGE_LABELS: Record<string, string> = {
  process: '过程检验',
  finished: '成品检验',
}

/** 检验来源 */
export const INSPECTION_SOURCE_LABELS: Record<string, string> = {
  work_report: '报工',
  putaway_receipt: '入库',
}

/** 检验结论 */
export const TEST_CONCLUSION_LABELS: Record<string, string> = {
  pending: '待定',
  qualified: '合格',
  unqualified: '不合格',
}

/** 结论版本行种类 */
export const RESULT_KIND_LABELS: Record<string, string> = {
  initial: '初检',
  test: '实测',
  re_inspection: '复检',
}

/** 处置种类（让步保留原不合格事实） */
export const DISPOSITION_KIND_LABELS: Record<string, string> = {
  release: '判定放行',
  concession: '让步放行',
}

/** 隔离/存疑种类（视图已带 holdKindLabel，此处兜底） */
export const HOLD_KIND_LABELS: Record<string, string> = {
  pending_inspection: '待检隔离',
  unqualified: '不合格隔离',
  suspect: '质量存疑',
}

/** 实测判定 */
export const MEASUREMENT_JUDGEMENT_LABELS: Record<string, string> = {
  pass: '合格',
  fail: '不合格',
  not_tested: '未检',
}

/** 待入库任务状态 */
export const PUTAWAY_TASK_STATUS_LABELS: Record<string, string> = {
  pending: '待入库',
  done: '已完成',
  cancelled: '已取消',
}

/** 待入库任务来源 */
export const PUTAWAY_SOURCE_LABELS: Record<string, string> = {
  work_report: '报工',
  finished_inspection: '成品质检',
}

/** 调拨状态机步骤顺序（A-T13-10；cancelled 独立） */
export const TRANSFER_STATUS_STEPS: readonly TransferStatusValue[] = [
  'draft',
  'ready',
  'shipping',
  'shipped_in_transit',
  'receiving',
  'completed',
]

export const TRANSFER_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  ready: '待执行',
  shipping: '出库中',
  shipped_in_transit: '已出库在途',
  receiving: '收货中',
  completed: '完成',
  cancelled: '已取消',
}

/** 调拨种类 */
export const TRANSFER_KIND_LABELS: Record<string, string> = {
  production: '生产调拨',
  warehouse: '仓库调拨',
  auto: '自动生成',
}

// ---------------- 四域许可目录（domain 域 permissions 同值；按钮显隐用，服务端终校） ----------------

export const PROCESS_PERMISSION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'process.read', label: '工艺/订单查询（process.read）' },
  { value: 'process.admin', label: '工艺/订单管理（process.admin）' },
]

export const SCHEDULING_PERMISSION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'scheduling.read', label: '排产查询（scheduling.read）' },
  { value: 'scheduling.admin', label: '排产维护（scheduling.admin）' },
]

export const EXECUTION_PERMISSION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'execution.read', label: '执行查询（execution.read）' },
  { value: 'execution.report', label: '报工（execution.report）' },
  { value: 'execution.review', label: '报工审核（execution.review）' },
  { value: 'execution.feed', label: '投料（execution.feed）' },
  { value: 'execution.labor', label: '工时记录（execution.labor）' },
]

export const QUALITY_PERMISSION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'quality.read', label: '质量查询（quality.read）' },
  { value: 'quality.post', label: '质量操作（quality.post）' },
]

export const WAREHOUSING_PERMISSION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'warehousing.read', label: '仓储查询（warehousing.read）' },
  { value: 'warehousing.post', label: '仓储操作（warehousing.post）' },
]

// ---------------- shipping 域（T14 分段装箱/发运；视图对齐 application/src/shipping-queries.ts） ----------------

/** PL 状态（A-T14-1：待装箱→待出库→已出库，单向不可逆） */
export type PlStatusValue = 'pending_packing' | 'ready_to_ship' | 'shipped'

/** 实发轴同步四态（IF-06：无需同步不是失败态） */
export type ActualAxisSyncStatusValue = 'pending' | 'synced' | 'sync_failed' | 'noop_needed'

/** 发货状态同步三态（IF-07：与实发轴同步互不改变对方状态） */
export type ShippingStatusSyncStatusValue = 'pending' | 'synced' | 'sync_failed'

/** 备货三类行（A-T14-3：托盘/有轴单品/无轴单品） */
export type ShipmentLineKindValue = 'pallet' | 'axis_item' | 'plain_item'

/** PL 列表行（GET /shipping/shipment-orders；ShipmentOrderView 逐字段对齐） */
export interface ShipmentOrderDto {
  orderId: string
  plNo: string
  salesOrderNo: string
  customerName: string | null
  status: PlStatusValue
  statusLabel: string
  /** A-T14-2：缺 DC 组成数据标记（生产订单行标黄数据源） */
  compositionMissing: boolean
  outboundBy: string | null
  outboundAt: string | null
  actualAxisSyncStatus: ActualAxisSyncStatusValue
  actualAxisSyncStatusLabel: string
  shippingStatusSyncStatus: ShippingStatusSyncStatusValue
  shippingStatusSyncStatusLabel: string
  actualAxisSnapshot: Record<string, unknown> | null
  statusSyncSnapshot: Record<string, unknown> | null
  plantId: string
  createdAt: string
}

/** 备货行（三类行快照 + 已扫/应扫进度；A-T14-3） */
export interface ShipmentLineDto {
  lineId: string
  lineNo: number
  lineKind: ShipmentLineKindValue
  materialId: string | null
  materialCode: string
  salesOrderLineNo: string
  customerAxisNo: string | null
  standardSegmentLength: string | null
  actualSegmentLength: string | null
  segmentLength: string | null
  requiredCount: number
  scannedCount: number
  lineStatus: 'pending_packing' | 'packed'
  lineStatusLabel: string
  packingStatus: 'pending' | 'bound' | 'cancelled' | null
  packingOrderId: string | null
}

/** 扫码记录（装入 load / 补码 supplement；删码保留行并标记） */
export interface PackingScanDto {
  scanId: string
  shipmentLineId: string
  scanKind: 'load' | 'supplement'
  inventoryUnitId: string | null
  unitNo: string
  customerAxisNo: string | null
  actualSegmentLength: string | null
  scannedBy: string
  scannedAt: string
  deleted: boolean
  deletedBy: string | null
  deletedAt: string | null
}

/** 打包任务看板行（A-T14-4：托码+调入库位+逐行扫满+绑定状态） */
export interface PackingOrderDto {
  packingId: string
  packingNo: string
  shipmentOrderId: string
  palletCode: string
  toLocationId: string | null
  toLocationCode: string | null
  status: 'pending' | 'bound' | 'cancelled'
  statusLabel: string
  boundBy: string | null
  boundAt: string | null
  lines: Array<{
    lineId: string
    lineNo: number
    materialCode: string
    requiredCount: number
    scannedCount: number
    lineStatus: 'pending_packing' | 'packed'
  }>
  plantId: string
}

/** 装箱图附件元数据（A-T14-10） */
export interface ShipmentPhotoDto {
  photoId: string
  fileName: string
  storageKey: string
  contentType: string | null
  sizeBytes: number | null
  uploadedBy: string
  uploadedAt: string
}

/** PL 详情（GET /shipping/shipment-orders/:id） */
export interface ShipmentOrderDetailDto extends ShipmentOrderDto {
  lines: ShipmentLineDto[]
  scans: PackingScanDto[]
  packings: PackingOrderDto[]
  photos: ShipmentPhotoDto[]
}

/** DC 分段/组成行（IF-04；缺组成数据→missing 标记） */
export interface DcCompositionDto {
  id: string
  dcId: string
  salesOrderNo: string
  lineNo: number
  syncStatus: 'missing' | 'received'
  composition: Record<string, unknown> | null
  missingMarkedAt: string | null
  plantId: string
}

/** shipping.dc-composition.inbound（IF-04 模拟入站；幂等 dcId+销售订单号+行号） */
export interface DcCompositionInboundPayload {
  dcId: string
  salesOrderNo: string
  lineNo: number
  plantId?: string
  orgCode?: string
  sourceSystem?: string
  externalRevision?: number
  /** 组成数据对象；缺省=missing 标记（A-T14-2） */
  composition?: Record<string, unknown> | null
  reason?: string
}

/** shipping.pl.inbound（IF-05 模拟入站；发货单号幂等；三类行规格断言 A-T14-3） */
export interface PlInboundPayload {
  plNo: string
  salesOrderNo: string
  plantId?: string
  orgCode?: string
  customerName?: string
  sourceSystem?: string
  externalRevision?: number
  lines: Array<{
    lineNo?: number
    lineKind: ShipmentLineKindValue
    materialCode: string
    materialId?: string
    salesOrderLineNo?: string
    /** 托盘行=总轴数；有轴单品固定 1；无轴单品=件数 */
    requiredCount?: number
    totalAxes?: number
    pieces?: number
    customerAxisNo?: string
    standardSegmentLength?: string
    segmentLength?: string
  }>
  reason?: string
}

/** shipping.packing.create（A-T14-4：先扫托码+选调入库位） */
export interface PackingCreatePayload {
  plantId: string
  shipmentOrderId: string
  palletCode: string
  toLocationId: string
  toLocationCode: string
  reason?: string
}

/** shipping.packing.bind（A-T14-4：每行扫满后绑定托码；已打包托码库位只读） */
export interface PackingBindPayload {
  plantId: string
  packingOrderId: string
  reason?: string
}

/** shipping.scan.load（A-T14-3：五拒一成；行扫满→已装箱） */
export interface ShippingScanLoadPayload {
  plantId: string
  shipmentOrderId: string
  lineId: string
  unitNo: string
  /** 实际段长补记（有轴行；缺省取单元轴段） */
  actualSegmentLength?: string
  reason?: string
}

/** shipping.scan.delete（A-T14-3：删码不满足退回待装箱） */
export interface ShippingScanDeletePayload {
  plantId: string
  shipmentOrderId: string
  scanId: string
  reason?: string
}

/** shipping.scan.supplement（A-T14-5：无轴行缺产品轴号补码，计入已扫件数） */
export interface ShippingScanSupplementPayload {
  plantId: string
  shipmentOrderId: string
  lineId: string
  unitNo: string
  actualSegmentLength?: string
  reason?: string
}

/** shipping.ship.confirm（A-T14-7：仅待出库；执行=已出库+出库人+库存记已发货+双回传） */
export interface ShipConfirmPayload {
  plantId: string
  shipmentOrderId: string
  reason?: string
}

/** shipping.sync.actual-axis.retry / shipping.sync.status.retry（outcome 缺省 success） */
export interface ShippingSyncRetryPayload {
  plantId: string
  shipmentOrderId: string
  outcome?: 'success' | 'failure'
  reason?: string
}

/** shipping.photo.attach（A-T14-10：逐张校验，部分失败保留已成功） */
export interface ShippingPhotoAttachPayload {
  plantId: string
  shipmentOrderId: string
  photos: Array<{ fileName: string; storageKey: string; contentType?: string; sizeBytes?: number }>
  reason?: string
}

// ---------------- shipping 标签字典（字典事实在 domain；此处展示名与查询服务 label 同口径） ----------------

/** PL 状态轴（A-T14-1：状态机步骤顺序） */
export const PL_STATUS_STEPS: readonly PlStatusValue[] = ['pending_packing', 'ready_to_ship', 'shipped']

export const PL_STATUS_LABELS: Record<string, string> = {
  pending_packing: '待装箱',
  ready_to_ship: '待出库',
  shipped: '已出库',
}

export const PL_LINE_STATUS_LABELS: Record<string, string> = {
  pending_packing: '待装箱',
  packed: '已装箱',
}

export const ACTUAL_AXIS_SYNC_LABELS: Record<string, string> = {
  pending: '待同步',
  synced: '已同步',
  sync_failed: '同步失败',
  noop_needed: '无需同步',
}

export const SHIPPING_STATUS_SYNC_LABELS: Record<string, string> = {
  pending: '待同步',
  synced: '已同步',
  sync_failed: '同步失败',
}

export const PACKING_STATUS_LABELS: Record<string, string> = {
  pending: '待打包',
  bound: '已绑定',
  cancelled: '已取消',
}

/** 备货三类行（A-T14-3） */
export const SHIPMENT_LINE_KIND_LABELS: Record<string, string> = {
  pallet: '托盘行',
  axis_item: '有轴单品',
  plain_item: '无轴单品',
}

/** 扫码记录种类 */
export const SCAN_KIND_LABELS: Record<string, string> = {
  load: '装入',
  supplement: '补码',
}

/** shipping 域许可目录（domain shipping/permissions.ts 同值；按钮显隐用，服务端终校） */
export const SHIPPING_PERMISSION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'shipping.read', label: '发运查询（shipping.read）' },
  { value: 'shipping.post', label: '发运操作（shipping.post）' },
]


// ---------------- purchase 域（T08 采购主链；视图对齐 application/src/purchase-queries.ts） ----------------

/** 订单行状态 0–5（IF-08） */
export type PurchaseOrderLineStatusValue = 0 | 1 | 2 | 3 | 4 | 5

export const PURCHASE_ORDER_LINE_STATUS_LABELS: Record<PurchaseOrderLineStatusValue, string> = {
  0: '已开立',
  1: '待收货',
  2: '部分收货',
  3: '完全收货',
  4: '超额收货',
  5: '已完成',
}

/** 采购订单行视图（GET /purchase/order-lines） */
export interface PurchaseOrderLineDto {
  lineId: string
  orderNo: string
  lineNo: number
  sourceSystem: string
  orgCode: string
  plantId: string
  contractNo: string | null
  salesOrderNo: string | null
  salesLineNo: string | null
  materialId: string
  materialCode: string
  materialName: string | null
  spec: string | null
  model: string | null
  color: string | null
  requisitionSpec: string | null
  supplierName: string | null
  uomCode: string
  plannedQty: string
  receivedQty: string
  overReceiptLimit: string
  status: PurchaseOrderLineStatusValue
  statusLabel: string
  erpClosed: boolean
  plannedReceiptDate: string | null
  firstArrivalDate: string | null
  lastArrivalDate: string | null
  externalRevision: number | null
}

/** 模拟入站：采购订单同步（POST /purchase/orders/sync；IF-08） */
export interface PurchaseOrderSyncPayload {
  sourceSystem?: string
  orgCode: string
  orderNo: string
  plantId?: string
  supplierName?: string
  contractNo?: string
  externalRevision?: number
  lines: Array<{
    lineNo: number
    materialId?: string
    materialCode: string
    materialName?: string
    materialType?: number
    spec?: string
    model?: string
    color?: string
    requisitionSpec?: string
    salesOrderNo?: string
    salesLineNo?: string
    uomCode?: string
    plannedQty: string
    overReceiptLimit?: string
    status?: PurchaseOrderLineStatusValue
    erpClosed?: boolean
    plannedReceiptDate?: string
    externalRevision?: number
  }>
  reason?: string
}

/** purchase 域许可目录（domain purchase/permissions.ts 同值） */
export const PURCHASE_PERMISSION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'purchase.read', label: '采购查询（purchase.read）' },
  { value: 'purchase.post', label: '采购操作（purchase.post）' },
]

// ---------------- PDA 占位 ----------------

/** PDA 任务占位（后端 PDA 域端点未交付，本波保持占位并标注；mock 演示数据保留） */
export interface PdaTaskDto {
  id: string
  title: string
  /** 任务来源上下文（PC-07：显式 ReportContext 的一部分） */
  orderNo: string
  processName: string
  /** 数量与单位必须同时呈现（PC-06）；数量一律 DecimalString */
  quantity: string
  unit: string
  status: 'PENDING' | 'IN_PROGRESS' | 'DONE'
}

// ---------------- 错误 ----------------

/** 客户端错误：携带合同错误码（ERROR_CODES）与中文文案 */
export interface ApiErrorShape {
  code: string
  message: string
  /** 服务端 details 原样保留供排查（PC-14：保留关联请求信息） */
  details?: unknown
  httpStatus?: number
  /** 请求标识（若响应带 x-request-id） */
  requestId?: string
}
