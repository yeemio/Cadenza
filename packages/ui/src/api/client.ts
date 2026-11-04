import type { PageRequest, PageResult } from '@cadenza/contracts'
import { MockError, mockRoutes, mockSessionTokens, pageQueryOf } from './mock'
import type {
  ApiErrorShape,
  AuthMeResponse,
  BarcodeResolveDto,
  BalanceDto,
  CommandMeta,
  CommandOk,
  ConversionsResult,
  ConversionCreatePayload,
  ConversionNewVersionPayload,
  ConversionUpdatePayload,
  DispositionConcessionPayload,
  DispositionReleasePayload,
  EquipmentCapacityClearPayload,
  EquipmentCapacitySetPayload,
  EquipmentChangeStatusPayload,
  EquipmentCreatePayload,
  EquipmentDto,
  EquipmentStatusLogDto,
  EquipmentUpdatePayload,
  ExecutionDraftDto,
  FeedLinePayload,
  GrantPayload,
  InspectionDetailDto,
  InspectionGeneratePayload,
  InspectionOrderDto,
  InventoryIssuePayload,
  InventoryMovePayload,
  InventoryReceivePayload,
  InventorySplitPayload,
  InventoryTransferInPayload,
  InventoryTransferOutPayload,
  LaborRecordDto,
  LaborRecordPayload,
  LocationCreatePayload,
  LocationUpdatePayload,
  LoginRequest,
  LoginResponse,
  MaterialDto,
  DcCompositionDto,
  DcCompositionInboundPayload,
  PackingBindPayload,
  PackingCreatePayload,
  PackingOrderDto,
  PlInboundPayload,
  PurchaseOrderLineDto,
  PurchaseOrderSyncPayload,
  ShipConfirmPayload,
  ShipmentOrderDetailDto,
  ShipmentOrderDto,
  ShippingPhotoAttachPayload,
  ShippingScanDeletePayload,
  ShippingScanLoadPayload,
  ShippingScanSupplementPayload,
  ShippingSyncRetryPayload,
  MoveExecutePayload,
  OrderQuantitiesDto,
  OrderSchedulingViewDto,
  DeviceBoardViewDto,
  OrgNodeCreatePayload,
  OrgNodeDto,
  OrgNodeUpdatePayload,
  PdaPlanViewDto,
  PdaTaskDto,
  ProductionOrderDetailDto,
  ProductionOrderDto,
  ProductionOrderReceivePayload,
  ProductionOrderSuspendPayload,
  PutawayConfirmPayload,
  PutawayRefreshPayload,
  PutawayTaskDto,
  QualityHoldDto,
  RackCreatePayload,
  RackDto,
  RackUpdatePayload,
  ReportDetailViewDto,
  ReportEntryPayload,
  ReservationAcquirePayload,
  ReservationReleasePayload,
  RoleCreatePayload,
  RoleDto,
  RoleUpdatePayload,
  ScheduleSlotSavePayload,
  ScheduleSlotsBatchPayload,
  ScanContextEntryDto,
  ScopeGrantDto,
  ShiftInfoDto,
  ShiftParameterSetPayload,
  StorageLocationDto,
  SuspectRegisterPayload,
  SuspectRestorePayload,
  TestResultSubmitPayload,
  TransferCreatePayload,
  TransferDetailDto,
  TransferOrderDto,
  TransferReceivePayload,
  TransferShipPayload,
  TransferSubmitPayload,
  TransferTransitPayload,
  UnitDetailDto,
  UserAccountDto,
  UserCreatePayload,
  UserUpdatePayload,
  WarehouseCreatePayload,
  WarehouseDto,
  WarehouseMoveDto,
  WarehouseUpdatePayload,
  WorkCenterCreatePayload,
  WorkCenterDto,
  WorkCenterUpdatePayload,
} from './types'

/**
 * 统一 API 客户端（联调点集中层，与 apps/api 实际路由逐一对齐）：
 * - 路由：POST /auth/login、POST /auth/logout、GET /auth/me、
 *   /org/nodes|users|roles|grants 查询（分页）与命令端点（POST/PATCH/DELETE，经命令总线）、
 *   /masterdata/*（料品只读+换算行/设备/仓库/库位/货架/工作中心，MD 合同）与
 *   /inventory/*（余额/条码解析/单元详情查询 + 收发移调分预留命令，IT 合同）；
 * - 鉴权：Authorization: Bearer <token>；401（除登录）触发 onUnauthorized，由应用跳转登录页；
 * - 错误：非 2xx 统一体 {code,message,details} → ApiError（错误码中文映射见 errorMessages）；
 * - 命令端点带 x-operation-id（幂等键）头；高影响操作理由（OA-29）统一并入请求体
 *   body.reason（中文 reason 不进头——浏览器 fetch 头仅收 ISO-8859-1，控制器 run() 优先读 body.reason）；
 * - 分页参数拼装（page/pageSize，服务端上限 100）统一在此处理；
 * - 默认 live 模式；VITE_API_MODE=mock 切演示数据（不经网络，mock 保留"演示数据"标识）；
 * - GET /pda/tasks 为 PDA 域占位（后端端点未交付；mock 演示数据保留，live 下 404 由页面转占位空态）。
 */

export type ApiMode = 'mock' | 'live'

export type CommandIntentKind = 'feed' | 'putaway'
export interface CommandIntent {
  version: 1
  operationId: string
  kind: CommandIntentKind
  payload: Record<string, unknown>
  state: 'pending' | 'unknown' | 'rejected' | 'committed'
  result?: CommandOk
}
const intentQueues = new Map<string, Promise<void>>()
async function withIntentLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = intentQueues.get(key) ?? Promise.resolve()
  const result = previous.then(async () => {
    // Web Locks serialize cooperating tabs as well as this module's instances.
    if (typeof navigator !== 'undefined' && navigator.locks) return await navigator.locks.request(key, action)
    return await action()
  })
  const settled = result.then(() => undefined, () => undefined)
  intentQueues.set(key, settled)
  void settled.then(() => { if (intentQueues.get(key) === settled) intentQueues.delete(key) })
  return result
}
function intentFingerprint(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(intentFingerprint).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + intentFingerprint(v)).join(',') + '}'
  return JSON.stringify(value)
}

export class ApiError extends Error implements ApiErrorShape {
  readonly code: string
  readonly details?: unknown
  readonly httpStatus?: number
  readonly requestId?: string
  constructor(shape: ApiErrorShape) {
    super(shape.message)
    this.name = 'ApiError'
    this.code = shape.code
    this.details = shape.details
    this.httpStatus = shape.httpStatus
    this.requestId = shape.requestId
  }
}

export interface ApiClientOptions {
  /** Durable, user-scoped command intent storage; browsers default to localStorage. */
  intentStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /** 真实模式 API 基地址（如 http://127.0.0.1:3001） */
  baseURL?: string
  mode?: ApiMode
  /** mock 模拟延迟毫秒 */
  mockLatencyMs?: number
  getToken?: () => string | null
  /** 401 回调（登录接口除外）：应用侧清会话并跳转登录 */
  onUnauthorized?: () => void
}

export interface ListOrgNodesQuery extends PageRequest {
  kind?: string
  plantId?: string
}

export interface ListUsersQuery extends PageRequest {
  loginNameLike?: string
  plantId?: string
}

export interface ListRolesQuery extends PageRequest {
  includeRetired?: boolean
}

export interface ListGrantsQuery extends PageRequest {
  principalType?: 'role' | 'user'
  principalId?: string
  includeRetired?: boolean
}

// ---------------- masterdata / inventory 查询参数（apps/api 控制器 Query 逐一对齐） ----------------

export interface ListMaterialsQuery extends PageRequest {
  nameLike?: string
  codeLike?: string
}

export interface ListEquipmentQuery extends PageRequest {
  plantId?: string
  nameLike?: string
  codeLike?: string
}

export interface ListWarehousesQuery extends PageRequest {
  plantId?: string
  nameLike?: string
}

export interface ListLocationsQuery extends PageRequest {
  plantId?: string
  warehouseId?: string
  codeLike?: string
}

export interface ListRacksQuery extends PageRequest {
  plantId?: string
  warehouseId?: string
  codeLike?: string
}

export interface ListWorkCentersQuery extends PageRequest {
  plantId?: string
  codeLike?: string
}

export interface ListBalancesQuery extends PageRequest {
  plantId?: string
  unitNoLike?: string
  materialCode?: string
  includeClosed?: boolean
}

export interface UnitDetailQuery {
  unitId?: string
  unitNo?: string
}

// ---------------- process / scheduling / execution / quality / warehousing 查询参数（apps/api 控制器 Query 逐一对齐） ----------------

export interface ListProductionOrdersQuery extends PageRequest {
  plantId?: string
  orderNoLike?: string
  /** 逗号分隔多选状态（approved/released/in_progress/pending_completion/closed/voided） */
  statuses?: string
  suspended?: boolean
}

export interface DeviceViewQuery {
  plantId?: string
  workCenterId?: string
  equipmentId?: string
}

export interface PdaPlanQuery {
  workCenterId: string
  orderNoLike?: string
  equipmentId?: string
  date?: string
}

export interface ShiftInfoQuery {
  plantId: string
  at?: string
}

export interface ScanContextQuery {
  plantId: string
  equipmentId: string
  shiftDate?: string
}

export interface ListDraftsQuery extends PageRequest {
  orderId?: string
  source?: string
  operatorUserId?: string
}

export interface ListInspectionsQuery extends PageRequest {
  plantId?: string
  /** 逗号分隔多选 */
  statuses?: string
  stages?: string
  orderNoLike?: string
}

export interface ListHoldsQuery extends PageRequest {
  plantId?: string
  statuses?: string
  holdKinds?: string
}

export interface ListPutawayTasksQuery extends PageRequest {
  plantId?: string
  statuses?: string
  sourceTypes?: string
}

export interface ListMovesQuery extends PageRequest {
  plantId?: string
  unitNoLike?: string
}

export interface ListTransfersQuery extends PageRequest {
  plantId?: string
  statuses?: string
  orderNoLike?: string
}

// ---------------- shipping 查询参数（apps/api shipping.controller Query 逐一对齐） ----------------

export interface ListShipmentOrdersQuery extends PageRequest {
  plantId?: string
  /** 逗号分隔多选状态（pending_packing/ready_to_ship/shipped） */
  statuses?: string
  plNoLike?: string
}

export interface PackingBoardQuery extends PageRequest {
  plantId?: string
  /** 逗号分隔多选状态（pending/bound/cancelled） */
  statuses?: string
  palletCodeLike?: string
}

export interface OutboundStatusQuery extends PageRequest {
  plantId?: string
}

// ---------------- purchase 查询参数（apps/api purchase.controller Query 逐一对齐） ----------------

export interface ListPurchaseOrderLinesQuery extends PageRequest {
  plantId?: string
  orderNoLike?: string
  materialCode?: string
  /** 逗号分隔多选状态（0–5） */
  statuses?: string
}

export interface ApiClient {
  readCommandIntent(slot: string): Promise<CommandIntent | null>
  executeCommandIntent(slot: string, kind: CommandIntentKind, payload: unknown): Promise<CommandOk>
  clearSettledCommandIntent(slot: string, operationId: string): Promise<void>
  readonly mode: ApiMode
  readonly baseURL: string
  login(request: LoginRequest): Promise<LoginResponse>
  me(): Promise<AuthMeResponse>
  logout(): Promise<void>
  // 机构
  listOrgNodes(query?: Partial<ListOrgNodesQuery>): Promise<PageResult<OrgNodeDto>>
  createOrgNode(payload: OrgNodeCreatePayload, meta?: CommandMeta): Promise<CommandOk>
  updateOrgNode(id: string, payload: OrgNodeUpdatePayload, meta?: CommandMeta): Promise<CommandOk>
  retireOrgNode(id: string, meta: CommandMeta): Promise<CommandOk>
  // 用户
  listUsers(query: ListUsersQuery): Promise<PageResult<UserAccountDto>>
  createUser(payload: UserCreatePayload, meta?: CommandMeta): Promise<CommandOk>
  updateUser(id: string, payload: UserUpdatePayload, meta?: CommandMeta): Promise<CommandOk>
  retireUser(id: string, meta?: CommandMeta): Promise<CommandOk>
  resetUserPassword(id: string, payload: { password?: string }, meta?: CommandMeta): Promise<CommandOk>
  unlockUser(id: string, meta?: CommandMeta): Promise<CommandOk>
  // 角色
  listRoles(query?: Partial<ListRolesQuery>): Promise<PageResult<RoleDto>>
  createRole(payload: RoleCreatePayload, meta?: CommandMeta): Promise<CommandOk>
  updateRole(id: string, payload: RoleUpdatePayload, meta?: CommandMeta): Promise<CommandOk>
  retireRole(id: string, meta?: CommandMeta): Promise<CommandOk>
  // 授权
  listGrants(query?: Partial<ListGrantsQuery>): Promise<PageResult<ScopeGrantDto>>
  grant(payload: GrantPayload, meta: CommandMeta): Promise<CommandOk>
  revokeGrant(payload: GrantPayload, meta: CommandMeta): Promise<CommandOk>
  // 主数据：料品（只读，MD-01/02）与换算行（MD-04/05，masterdata.admin）
  listMaterials(query?: Partial<ListMaterialsQuery>): Promise<PageResult<MaterialDto>>
  listConversions(materialId: string): Promise<ConversionsResult>
  createConversion(payload: ConversionCreatePayload, meta?: CommandMeta): Promise<CommandOk>
  updateConversion(id: string, payload: ConversionUpdatePayload, meta?: CommandMeta): Promise<CommandOk>
  newConversionVersion(id: string, payload: ConversionNewVersionPayload, meta?: CommandMeta): Promise<CommandOk>
  retireConversion(id: string, meta: CommandMeta): Promise<CommandOk>
  // 主数据：设备（MD-09～16；状态变更记流水 MD-14）
  listEquipment(query?: Partial<ListEquipmentQuery>): Promise<PageResult<EquipmentDto>>
  listEquipmentStatusLogs(equipmentId: string): Promise<EquipmentStatusLogDto[]>
  createEquipment(payload: EquipmentCreatePayload, meta?: CommandMeta): Promise<CommandOk>
  updateEquipment(id: string, payload: EquipmentUpdatePayload, meta?: CommandMeta): Promise<CommandOk>
  changeEquipmentStatus(id: string, payload: EquipmentChangeStatusPayload, meta?: CommandMeta): Promise<CommandOk>
  retireEquipment(id: string, meta: CommandMeta): Promise<CommandOk>
  // 主数据：仓库（MD-22～27；MD-24 建仓部门类型约束服务端终校）
  listWarehouses(query?: Partial<ListWarehousesQuery>): Promise<PageResult<WarehouseDto>>
  createWarehouse(payload: WarehouseCreatePayload, meta?: CommandMeta): Promise<CommandOk>
  updateWarehouse(id: string, payload: WarehouseUpdatePayload, meta?: CommandMeta): Promise<CommandOk>
  retireWarehouse(id: string, meta: CommandMeta): Promise<CommandOk>
  // 主数据：普通库位（MD-28/29）与货架（MD-30/31/33）
  listLocations(query?: Partial<ListLocationsQuery>): Promise<PageResult<StorageLocationDto>>
  createLocation(payload: LocationCreatePayload, meta?: CommandMeta): Promise<CommandOk>
  updateLocation(id: string, payload: LocationUpdatePayload, meta?: CommandMeta): Promise<CommandOk>
  retireLocation(id: string, meta: CommandMeta): Promise<CommandOk>
  listRacks(query?: Partial<ListRacksQuery>): Promise<PageResult<RackDto>>
  createRack(payload: RackCreatePayload, meta?: CommandMeta): Promise<CommandOk>
  updateRack(id: string, payload: RackUpdatePayload, meta?: CommandMeta): Promise<CommandOk>
  retireRack(id: string, meta: CommandMeta): Promise<CommandOk>
  // 主数据：工作中心（MD-17/18）
  listWorkCenters(query?: Partial<ListWorkCentersQuery>): Promise<PageResult<WorkCenterDto>>
  createWorkCenter(payload: WorkCenterCreatePayload, meta?: CommandMeta): Promise<CommandOk>
  updateWorkCenter(id: string, payload: WorkCenterUpdatePayload, meta?: CommandMeta): Promise<CommandOk>
  retireWorkCenter(id: string, meta: CommandMeta): Promise<CommandOk>
  // 库存查询（IT-20/IT-04/05/06/IT-01/35）
  listBalances(query?: Partial<ListBalancesQuery>): Promise<PageResult<BalanceDto>>
  resolveBarcode(value: string): Promise<BarcodeResolveDto>
  unitDetail(query: UnitDetailQuery): Promise<UnitDetailDto>
  // 库存命令（inventory.post / inventory.reserve；数量一律十进制字符串 IT-07）
  inventoryReceive(payload: InventoryReceivePayload, meta?: CommandMeta): Promise<CommandOk>
  inventoryIssue(payload: InventoryIssuePayload, meta?: CommandMeta): Promise<CommandOk>
  inventoryMove(payload: InventoryMovePayload, meta?: CommandMeta): Promise<CommandOk>
  inventoryTransferOut(payload: InventoryTransferOutPayload, meta?: CommandMeta): Promise<CommandOk>
  inventoryTransferIn(payload: InventoryTransferInPayload, meta?: CommandMeta): Promise<CommandOk>
  inventorySplit(payload: InventorySplitPayload, meta?: CommandMeta): Promise<CommandOk>
  acquireReservation(payload: ReservationAcquirePayload, meta?: CommandMeta): Promise<CommandOk>
  releaseReservation(payload: ReservationReleasePayload, meta?: CommandMeta): Promise<CommandOk>
  // PDA（占位：后端 PDA 域端点未交付）
  listTasks(page: PageRequest, status?: string): Promise<PageResult<PdaTaskDto>>
  // ---------------- 生产订单（process 域 T05：查询 process.read / 命令 process.admin） ----------------
  listProductionOrders(query?: Partial<ListProductionOrdersQuery>): Promise<PageResult<ProductionOrderDto>>
  productionOrderDetail(orderId: string): Promise<ProductionOrderDetailDto>
  receiveProductionOrder(payload: ProductionOrderReceivePayload, meta?: CommandMeta): Promise<CommandOk>
  releaseProductionOrder(id: string, meta?: CommandMeta): Promise<CommandOk>
  startProductionOrder(id: string, meta?: CommandMeta): Promise<CommandOk>
  suspendProductionOrder(id: string, payload: ProductionOrderSuspendPayload, meta: CommandMeta): Promise<CommandOk>
  resumeProductionOrder(id: string, meta?: CommandMeta): Promise<CommandOk>
  voidProductionOrder(id: string, meta: CommandMeta): Promise<CommandOk>
  // ---------------- 排程（scheduling 域 T09：查询 scheduling.read / 命令 scheduling.admin） ----------------
  schedulingOrderView(orderId: string): Promise<OrderSchedulingViewDto>
  schedulingDeviceView(query?: Partial<DeviceViewQuery>): Promise<DeviceBoardViewDto>
  schedulingPdaPlan(query: PdaPlanQuery): Promise<PdaPlanViewDto>
  schedulingShiftInfo(query: ShiftInfoQuery): Promise<ShiftInfoDto>
  saveScheduleSlot(payload: ScheduleSlotSavePayload, meta?: CommandMeta): Promise<CommandOk>
  saveScheduleSlotsBatch(payload: ScheduleSlotsBatchPayload, meta?: CommandMeta): Promise<CommandOk>
  setEquipmentCapacity(payload: EquipmentCapacitySetPayload, meta?: CommandMeta): Promise<CommandOk>
  clearEquipmentCapacity(payload: EquipmentCapacityClearPayload, meta?: CommandMeta): Promise<CommandOk>
  setShiftParameter(payload: ShiftParameterSetPayload, meta?: CommandMeta): Promise<CommandOk>
  // ---------------- 报工/投料（execution 域 T10/T11；三入口同规则仅 source 不同） ----------------
  executionScanContext(query: ScanContextQuery): Promise<ScanContextEntryDto[]>
  reportViaOrder(orderId: string, payload: ReportEntryPayload, meta?: CommandMeta): Promise<CommandOk>
  reportViaWorkbench(payload: ReportEntryPayload, meta?: CommandMeta): Promise<CommandOk>
  reportViaScan(payload: ReportEntryPayload, meta?: CommandMeta): Promise<CommandOk>
  listReportDrafts(query?: Partial<ListDraftsQuery>): Promise<PageResult<ExecutionDraftDto>>
  getReport(reportId: string): Promise<ReportDetailViewDto>
  submitReport(reportId: string, payload?: { reason?: string }, meta?: CommandMeta): Promise<CommandOk>
  reviewReport(reportId: string, payload?: { reason?: string }, meta?: CommandMeta): Promise<CommandOk>
  cancelReportReview(reportId: string, payload: { reason?: string }, meta: CommandMeta): Promise<CommandOk>
  updateReport(reportId: string, payload: Partial<ReportEntryPayload> & { reportId?: string }, meta?: CommandMeta): Promise<CommandOk>
  deleteReport(reportId: string, meta?: CommandMeta): Promise<CommandOk>
  submitFeed(payload: { orderId: string; orderOperationId: string; feeds: FeedLinePayload[]; businessTime?: string; reason?: string }, meta?: CommandMeta): Promise<CommandOk>
  recordLabor(payload: LaborRecordPayload, meta?: CommandMeta): Promise<CommandOk>
  orderQuantities(orderId: string): Promise<OrderQuantitiesDto>
  listLaborRecords(orderId: string): Promise<LaborRecordDto[]>
  // ---------------- 质量放行（quality 域 T12：查询 quality.read / 命令 quality.post） ----------------
  listInspections(query?: Partial<ListInspectionsQuery>): Promise<PageResult<InspectionOrderDto>>
  inspectionDetail(id: string): Promise<InspectionDetailDto>
  listQualityHolds(query?: Partial<ListHoldsQuery>): Promise<PageResult<QualityHoldDto>>
  generateInspections(payload: InspectionGeneratePayload, meta?: CommandMeta): Promise<CommandOk>
  submitTestResult(payload: TestResultSubmitPayload, meta?: CommandMeta): Promise<CommandOk>
  releaseInspection(payload: DispositionReleasePayload, meta?: CommandMeta): Promise<CommandOk>
  concessionInspection(payload: DispositionConcessionPayload, meta: CommandMeta): Promise<CommandOk>
  registerSuspect(payload: SuspectRegisterPayload, meta?: CommandMeta): Promise<CommandOk>
  restoreSuspect(payload: SuspectRestorePayload, meta: CommandMeta): Promise<CommandOk>
  // ---------------- 入库/移库/调拨（warehousing 域 T13：查询 warehousing.read / 命令 warehousing.post） ----------------
  listPutawayTasks(query?: Partial<ListPutawayTasksQuery>): Promise<PageResult<PutawayTaskDto>>
  listWarehouseMoves(query?: Partial<ListMovesQuery>): Promise<PageResult<WarehouseMoveDto>>
  listTransfers(query?: Partial<ListTransfersQuery>): Promise<PageResult<TransferOrderDto>>
  transferDetail(id: string): Promise<TransferDetailDto>
  putawayRefresh(payload: PutawayRefreshPayload, meta?: CommandMeta): Promise<CommandOk>
  putawayConfirm(payload: PutawayConfirmPayload, meta?: CommandMeta): Promise<CommandOk>
  executeWarehouseMove(payload: MoveExecutePayload, meta?: CommandMeta): Promise<CommandOk>
  createTransfer(payload: TransferCreatePayload, meta?: CommandMeta): Promise<CommandOk>
  submitTransfer(payload: TransferSubmitPayload, meta?: CommandMeta): Promise<CommandOk>
  shipTransfer(payload: TransferShipPayload, meta?: CommandMeta): Promise<CommandOk>
  transitTransfer(payload: TransferTransitPayload, meta?: CommandMeta): Promise<CommandOk>
  receiveTransfer(payload: TransferReceivePayload, meta?: CommandMeta): Promise<CommandOk>
  // ---------------- 装箱发运（shipping 域 T14：查询 shipping.read / 命令 shipping.post；Web/PDA 双入口共用同命令） ----------------
  listShipmentOrders(query?: Partial<ListShipmentOrdersQuery>): Promise<PageResult<ShipmentOrderDto>>
  shipmentDetail(shipmentOrderId: string): Promise<ShipmentOrderDetailDto>
  packingBoard(query?: Partial<PackingBoardQuery>): Promise<PageResult<PackingOrderDto>>
  outboundStatus(query?: Partial<OutboundStatusQuery>): Promise<PageResult<ShipmentOrderDto>>
  listDcCompositions(salesOrderNo: string): Promise<DcCompositionDto[]>
  dcCompositionInbound(payload: DcCompositionInboundPayload, meta?: CommandMeta): Promise<CommandOk>
  plInbound(payload: PlInboundPayload, meta?: CommandMeta): Promise<CommandOk>
  packingCreate(payload: PackingCreatePayload, meta?: CommandMeta): Promise<CommandOk>
  packingBind(payload: PackingBindPayload, meta?: CommandMeta): Promise<CommandOk>
  shippingScanLoad(payload: ShippingScanLoadPayload, meta?: CommandMeta): Promise<CommandOk>
  shippingScanDelete(payload: ShippingScanDeletePayload, meta?: CommandMeta): Promise<CommandOk>
  shippingScanSupplement(payload: ShippingScanSupplementPayload, meta?: CommandMeta): Promise<CommandOk>
  shipConfirm(payload: ShipConfirmPayload, meta?: CommandMeta): Promise<CommandOk>
  syncActualAxisRetry(payload: ShippingSyncRetryPayload, meta?: CommandMeta): Promise<CommandOk>
  syncStatusRetry(payload: ShippingSyncRetryPayload, meta?: CommandMeta): Promise<CommandOk>
  shippingPhotoAttach(payload: ShippingPhotoAttachPayload, meta?: CommandMeta): Promise<CommandOk>
  // ---------------- 采购（purchase 域 T08：查询 purchase.read / 命令 purchase.post） ----------------
  listPurchaseOrderLines(query?: Partial<ListPurchaseOrderLinesQuery>): Promise<PageResult<PurchaseOrderLineDto>>
  syncPurchaseOrders(payload: PurchaseOrderSyncPayload, meta?: CommandMeta): Promise<CommandOk>
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:3001'

interface RawErrorBody {
  code?: unknown
  message?: unknown
  details?: unknown
}

function toApiError(status: number, body: RawErrorBody | null, requestId?: string): ApiError {
  return new ApiError({
    code: typeof body?.code === 'string' ? body.code : 'ERR_UNKNOWN',
    message:
      typeof body?.message === 'string' && body.message
        ? body.message
        : `请求失败（HTTP ${status}）`,
    details: body?.details,
    httpStatus: status,
    requestId,
  })
}

function newOperationId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const mode: ApiMode = options.mode ?? 'live'
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const mockLatency = options.mockLatencyMs ?? 200

  async function request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts: { query?: URLSearchParams; body?: unknown; meta?: CommandMeta } = {},
  ): Promise<T> {
    const token = options.getToken?.() ?? null

    if (mode === 'mock') {
      await new Promise((r) => setTimeout(r, mockLatency))
      const handler = mockRoutes(method, path)
      if (!handler) {
        throw new ApiError({
          code: 'ERR_NOT_FOUND',
          message: `mock 未定义路由：${method} ${path}`,
          httpStatus: 404,
        })
      }
      try {
        const data = handler({
          query: opts.query ?? new URLSearchParams(),
          body: opts.body,
          token,
          meta: opts.meta,
        })
        // 登录成功的 token 记入 mock 会话集合（鉴权演示用）
        if (method === 'POST' && path === '/auth/login') {
          const resp = data as LoginResponse
          if (resp?.token) mockSessionTokens.add(resp.token)
        }
        return data as T
      } catch (err) {
        if (err instanceof MockError) {
          const apiErr = new ApiError({
            code: err.code,
            message: err.message,
            details: err.details,
            httpStatus: err.httpStatus,
          })
          // mock：非登录接口 401 同样触发未授权回调
          if (err.httpStatus === 401 && path !== '/auth/login') options.onUnauthorized?.()
          throw apiErr
        }
        throw err
      }
    }

    const url = new URL(`${baseURL}${path}`)
    if (opts.query) for (const [k, v] of opts.query.entries()) url.searchParams.set(k, v)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    // 命令端点：幂等操作号头（x-operation-id）。OA-29 留痕 reason 不走头——浏览器
    // fetch 头仅收 ISO-8859-1，中文 reason 会直接抛错；由 command() 统一并入 body.reason。
    if (opts.meta?.operationId) headers['x-operation-id'] = opts.meta.operationId

    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      })
    } catch (cause) {
      throw new ApiError({
        code: 'ERR_NETWORK',
        message: cause instanceof Error ? `网络请求失败：${cause.message}` : '网络请求失败',
      })
    }
    const requestId = res.headers.get('x-request-id') ?? undefined
    if (res.status === 401 && path !== '/auth/login') {
      options.onUnauthorized?.()
    }
    if (!res.ok) {
      let body: RawErrorBody | null = null
      try {
        body = (await res.json()) as RawErrorBody
      } catch {
        body = null
      }
      throw toApiError(res.status, body, requestId)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  /** 命令端点统一封装：自动生成幂等 operationId（未显式提供时）；OA-29 reason 并入请求体 */
  function command<T extends CommandOk>(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    meta: CommandMeta = {},
  ): Promise<T> {
    // reason 统一并入 body（控制器 run() 优先读 payload.reason；中文不进头，避免浏览器
    // fetch 抛 non-ISO-8859-1）。载荷自带 reason 优先，meta.reason 兜底（与原
    // payload.reason || x-reason 头的提取语义一致）；两者皆无则保持载荷原样不加键。
    const payload =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {}
    const bodyReason = typeof payload['reason'] === 'string' ? payload['reason'] : undefined
    const effectiveReason = bodyReason || (typeof meta.reason === 'string' ? meta.reason : undefined)
    return request<T>(method, path, {
      body:
        effectiveReason === undefined || bodyReason === effectiveReason
          ? payload
          : { ...payload, reason: effectiveReason },
      meta: { operationId: newOperationId(), ...meta },
    })
  }

  const intentError = (code: string, message: string) => new ApiError({ code, message })
  async function intentContext(slot: string) {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(slot)) throw intentError('ERR_INTENT_SLOT', '操作入口标识无效')
    const token = options.getToken?.() ?? null
    const me = await request<AuthMeResponse>('GET', '/auth/me')
    if (token !== (options.getToken?.() ?? null) || !me.user?.userId || !me.user.enterpriseId) {
      throw intentError('ERR_INTENT_IDENTITY', '会话身份已改变，请重新打开操作页')
    }
    const storage = options.intentStorage ?? globalThis.localStorage
    if (!storage) throw intentError('ERR_INTENT_STORAGE', '不能保存操作意图，尚未发送命令')
    const key = 'cadenza.intent.v1.' + [mode, baseURL, me.user.enterpriseId, me.user.userId, slot].map(encodeURIComponent).join('|')
    return { storage, key, token }
  }
  function readIntent(storage: Pick<Storage, 'getItem'>, key: string): CommandIntent | null {
    const raw = storage.getItem(key)
    if (raw === null) return null
    let value: CommandIntent
    try { value = JSON.parse(raw) as CommandIntent } catch { throw intentError('ERR_INTENT_STORAGE', '原操作记录损坏；尚未发送新命令') }
    if (value?.version !== 1 || !value.operationId || !['feed', 'putaway'].includes(value.kind) ||
        !['pending', 'unknown', 'rejected', 'committed'].includes(value.state) ||
        !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
      throw intentError('ERR_INTENT_STORAGE', '原操作记录无效；尚未发送新命令')
    }
    return value
  }
  async function readCommandIntent(slot: string): Promise<CommandIntent | null> {
    const { storage, key } = await intentContext(slot)
    return readIntent(storage, key)
  }
  async function clearSettledCommandIntent(slot: string, operationId: string): Promise<void> {
    const { storage, key } = await intentContext(slot)
    await withIntentLock(key, async () => {
      const existing = readIntent(storage, key)
      if (existing === null) return
      if (existing.operationId !== operationId || !['committed', 'rejected'].includes(existing.state)) {
        throw intentError('ERR_INTENT_PENDING', '原操作结果尚未确认，不能换键或清除')
      }
      storage.removeItem(key)
    })
  }
  async function executeCommandIntent(slot: string, kind: CommandIntentKind, body: unknown): Promise<CommandOk> {
    // Clone before any await: later edits cannot change the transmitted intent.
    const payload: unknown = JSON.parse(JSON.stringify(body))
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw intentError('ERR_INTENT_BODY', '命令载荷无效')
    const { storage, key, token } = await intentContext(slot)
    return withIntentLock(key, async () => {
      if (token !== (options.getToken?.() ?? null)) throw intentError('ERR_INTENT_IDENTITY', '会话身份已改变')
      const existing = readIntent(storage, key)
      if (existing && (existing.kind !== kind || intentFingerprint(existing.payload) !== intentFingerprint(payload))) {
        throw intentError('ERR_INTENT_PENDING', '已有原操作，请先确认其结果；不能替换载荷或操作键')
      }
      if (existing?.state === 'committed') {
        if (!existing.result || existing.result.operationId !== existing.operationId) throw intentError('ERR_INTENT_STORAGE', '已完成操作回执损坏')
        return existing.result
      }
      if (existing?.state === 'rejected') throw intentError('ERR_INTENT_REJECTED', '原操作已明确拒绝；请确认编辑为新操作')
      const intent: CommandIntent = existing ?? { version: 1, operationId: newOperationId(), kind, payload: payload as Record<string, unknown>, state: 'pending' }
      const previouslyUnknown = existing !== null // a persisted pending write may already have committed
      storage.setItem(key, JSON.stringify(intent)) // MUST succeed before sending
      try {
        const result = await command<CommandOk>('POST', kind === 'feed' ? '/execution/feeds' : '/warehousing/putaway/confirm', intent.payload, { operationId: intent.operationId })
        if (result?.operationId !== intent.operationId || !['COMMITTED', 'DRAFT_SAVED'].includes(result.status)) {
          throw intentError('ERR_INTENT_RECEIPT', '响应未确认原操作，保留原键等待重试')
        }
        storage.setItem(key, JSON.stringify({ ...intent, state: 'committed', result }))
        return result
      } catch (error) {
        // A later 4xx cannot disprove an earlier commit whose response was lost.
        const definiteRejection = !previouslyUnknown && error instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(error.httpStatus ?? 0)
        storage.setItem(key, JSON.stringify({ ...intent, state: definiteRejection ? 'rejected' : 'unknown' }))
        throw error
      }
    })
  }

  const commandQuery = (query?: Partial<
    ListOrgNodesQuery &
      ListUsersQuery &
      ListRolesQuery &
      ListGrantsQuery &
      ListMaterialsQuery &
      ListEquipmentQuery &
      ListWarehousesQuery &
      ListLocationsQuery &
      ListRacksQuery &
      ListWorkCentersQuery &
      ListBalancesQuery &
      ListProductionOrdersQuery &
      DeviceViewQuery &
      PdaPlanQuery &
      ShiftInfoQuery &
      ScanContextQuery &
      ListDraftsQuery &
      ListInspectionsQuery &
      ListHoldsQuery &
    ListPutawayTasksQuery &
    ListMovesQuery &
    ListTransfersQuery &
    ListShipmentOrdersQuery &
    PackingBoardQuery &
    OutboundStatusQuery &
    ListPurchaseOrderLinesQuery
  >): URLSearchParams => {
    const { page, pageSize, ...rest } = query ?? {}
    const search = new URLSearchParams()
    if (page != null) search.set('page', String(page))
    if (pageSize != null) search.set('pageSize', String(pageSize))
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null || v === '') continue
      search.set(k, typeof v === 'boolean' ? String(v) : String(v))
    }
    return search
  }

  return {
    mode,
    baseURL,
    readCommandIntent,
    executeCommandIntent,
    clearSettledCommandIntent,
    login(payload) {
      return request<LoginResponse>('POST', '/auth/login', { body: payload })
    },
    me() {
      return request<AuthMeResponse>('GET', '/auth/me')
    },
    async logout() {
      try {
        await request<{ ok: boolean; sessionId: string }>('POST', '/auth/logout')
      } catch {
        // 登出失败不阻断本地会话清理
      }
    },
    // ---------------- 机构 ----------------
    listOrgNodes(query) {
      return request<PageResult<OrgNodeDto>>('GET', '/org/nodes', { query: commandQuery(query) })
    },
    createOrgNode(payload, meta) {
      return command('POST', '/org/nodes', payload, meta)
    },
    updateOrgNode(id, payload, meta) {
      return command('PATCH', `/org/nodes/${encodeURIComponent(id)}`, payload, meta)
    },
    retireOrgNode(id, meta) {
      return command('DELETE', `/org/nodes/${encodeURIComponent(id)}`, {}, meta)
    },
    // ---------------- 用户 ----------------
    listUsers(query) {
      return request<PageResult<UserAccountDto>>('GET', '/org/users', { query: commandQuery(query) })
    },
    createUser(payload, meta) {
      return command('POST', '/org/users', payload, meta)
    },
    updateUser(id, payload, meta) {
      return command('PATCH', `/org/users/${encodeURIComponent(id)}`, payload, meta)
    },
    retireUser(id, meta) {
      return command('DELETE', `/org/users/${encodeURIComponent(id)}`, {}, meta)
    },
    resetUserPassword(id, payload, meta) {
      return command('POST', `/org/users/${encodeURIComponent(id)}/reset-password`, payload, meta)
    },
    unlockUser(id, meta) {
      return command('POST', `/org/users/${encodeURIComponent(id)}/unlock`, {}, meta)
    },
    // ---------------- 角色 ----------------
    listRoles(query) {
      return request<PageResult<RoleDto>>('GET', '/org/roles', { query: commandQuery(query) })
    },
    createRole(payload, meta) {
      return command('POST', '/org/roles', payload, meta)
    },
    updateRole(id, payload, meta) {
      return command('PATCH', `/org/roles/${encodeURIComponent(id)}`, payload, meta)
    },
    retireRole(id, meta) {
      return command('DELETE', `/org/roles/${encodeURIComponent(id)}`, {}, meta)
    },
    // ---------------- 授权 ----------------
    listGrants(query) {
      return request<PageResult<ScopeGrantDto>>('GET', '/org/grants', { query: commandQuery(query) })
    },
    grant(payload, meta) {
      return command('POST', '/org/grants', payload, meta)
    },
    revokeGrant(payload, meta) {
      return command('POST', '/org/grants/revoke', payload, meta)
    },
    // ---------------- 主数据：料品与换算行 ----------------
    listMaterials(query) {
      return request<PageResult<MaterialDto>>('GET', '/masterdata/materials', { query: commandQuery(query) })
    },
    listConversions(materialId) {
      return request<ConversionsResult>('GET', `/masterdata/materials/${encodeURIComponent(materialId)}/conversions`)
    },
    createConversion(payload, meta) {
      return command('POST', '/masterdata/conversions', payload, meta)
    },
    updateConversion(id, payload, meta) {
      return command('PATCH', `/masterdata/conversions/${encodeURIComponent(id)}`, payload, meta)
    },
    newConversionVersion(id, payload, meta) {
      return command('POST', `/masterdata/conversions/${encodeURIComponent(id)}/new-version`, payload, meta)
    },
    retireConversion(id, meta) {
      return command('DELETE', `/masterdata/conversions/${encodeURIComponent(id)}`, {}, meta)
    },
    // ---------------- 主数据：设备 ----------------
    listEquipment(query) {
      return request<PageResult<EquipmentDto>>('GET', '/masterdata/equipment', { query: commandQuery(query) })
    },
    listEquipmentStatusLogs(equipmentId) {
      return request<EquipmentStatusLogDto[]>('GET', `/masterdata/equipment/${encodeURIComponent(equipmentId)}/status-logs`)
    },
    createEquipment(payload, meta) {
      return command('POST', '/masterdata/equipment', payload, meta)
    },
    updateEquipment(id, payload, meta) {
      return command('PATCH', `/masterdata/equipment/${encodeURIComponent(id)}`, payload, meta)
    },
    changeEquipmentStatus(id, payload, meta) {
      return command('POST', `/masterdata/equipment/${encodeURIComponent(id)}/change-status`, payload, meta)
    },
    retireEquipment(id, meta) {
      return command('DELETE', `/masterdata/equipment/${encodeURIComponent(id)}`, {}, meta)
    },
    // ---------------- 主数据：仓库 ----------------
    listWarehouses(query) {
      return request<PageResult<WarehouseDto>>('GET', '/masterdata/warehouses', { query: commandQuery(query) })
    },
    createWarehouse(payload, meta) {
      return command('POST', '/masterdata/warehouses', payload, meta)
    },
    updateWarehouse(id, payload, meta) {
      return command('PATCH', `/masterdata/warehouses/${encodeURIComponent(id)}`, payload, meta)
    },
    retireWarehouse(id, meta) {
      return command('DELETE', `/masterdata/warehouses/${encodeURIComponent(id)}`, {}, meta)
    },
    // ---------------- 主数据：普通库位 ----------------
    listLocations(query) {
      return request<PageResult<StorageLocationDto>>('GET', '/masterdata/locations', { query: commandQuery(query) })
    },
    createLocation(payload, meta) {
      return command('POST', '/masterdata/locations', payload, meta)
    },
    updateLocation(id, payload, meta) {
      return command('PATCH', `/masterdata/locations/${encodeURIComponent(id)}`, payload, meta)
    },
    retireLocation(id, meta) {
      return command('DELETE', `/masterdata/locations/${encodeURIComponent(id)}`, {}, meta)
    },
    // ---------------- 主数据：货架 ----------------
    listRacks(query) {
      return request<PageResult<RackDto>>('GET', '/masterdata/racks', { query: commandQuery(query) })
    },
    createRack(payload, meta) {
      return command('POST', '/masterdata/racks', payload, meta)
    },
    updateRack(id, payload, meta) {
      return command('PATCH', `/masterdata/racks/${encodeURIComponent(id)}`, payload, meta)
    },
    retireRack(id, meta) {
      return command('DELETE', `/masterdata/racks/${encodeURIComponent(id)}`, {}, meta)
    },
    // ---------------- 主数据：工作中心 ----------------
    listWorkCenters(query) {
      return request<PageResult<WorkCenterDto>>('GET', '/masterdata/work-centers', { query: commandQuery(query) })
    },
    createWorkCenter(payload, meta) {
      return command('POST', '/masterdata/work-centers', payload, meta)
    },
    updateWorkCenter(id, payload, meta) {
      return command('PATCH', `/masterdata/work-centers/${encodeURIComponent(id)}`, payload, meta)
    },
    retireWorkCenter(id, meta) {
      return command('DELETE', `/masterdata/work-centers/${encodeURIComponent(id)}`, {}, meta)
    },
    // ---------------- 库存查询 ----------------
    listBalances(query) {
      return request<PageResult<BalanceDto>>('GET', '/inventory/balances', { query: commandQuery(query) })
    },
    resolveBarcode(value) {
      return request<BarcodeResolveDto>('GET', `/inventory/barcode/${encodeURIComponent(value)}/resolve`)
    },
    unitDetail(query) {
      const search = new URLSearchParams()
      if (query.unitId) search.set('unitId', query.unitId)
      if (query.unitNo) search.set('unitNo', query.unitNo)
      return request<UnitDetailDto>('GET', '/inventory/units', { query: search })
    },
    // ---------------- 库存命令 ----------------
    inventoryReceive(payload, meta) {
      return command('POST', '/inventory/receive', payload, meta)
    },
    inventoryIssue(payload, meta) {
      return command('POST', '/inventory/issue', payload, meta)
    },
    inventoryMove(payload, meta) {
      return command('POST', '/inventory/move', payload, meta)
    },
    inventoryTransferOut(payload, meta) {
      return command('POST', '/inventory/transfer/out', payload, meta)
    },
    inventoryTransferIn(payload, meta) {
      return command('POST', '/inventory/transfer/in', payload, meta)
    },
    inventorySplit(payload, meta) {
      return command('POST', '/inventory/split', payload, meta)
    },
    acquireReservation(payload, meta) {
      return command('POST', '/inventory/reservations', payload, meta)
    },
    releaseReservation(payload, meta) {
      return command('POST', '/inventory/reservations/release', payload, meta)
    },
    // ---------------- PDA（占位） ----------------
    listTasks(page, status) {
      return request<PageResult<PdaTaskDto>>('GET', '/pda/tasks', {
        query: pageQueryOf(page, status ? { status } : undefined),
      })
    },
    // ---------------- 生产订单（process） ----------------
    listProductionOrders(query) {
      return request<PageResult<ProductionOrderDto>>('GET', '/process/orders', { query: commandQuery(query) })
    },
    productionOrderDetail(orderId) {
      return request<ProductionOrderDetailDto>('GET', `/process/orders/${encodeURIComponent(orderId)}`)
    },
    receiveProductionOrder(payload, meta) {
      return command('POST', '/process/orders/receive', payload, meta)
    },
    releaseProductionOrder(id, meta) {
      return command('POST', `/process/orders/${encodeURIComponent(id)}/release`, {}, meta)
    },
    startProductionOrder(id, meta) {
      return command('POST', `/process/orders/${encodeURIComponent(id)}/start`, {}, meta)
    },
    suspendProductionOrder(id, payload, meta) {
      return command('POST', `/process/orders/${encodeURIComponent(id)}/suspend`, payload, meta)
    },
    resumeProductionOrder(id, meta) {
      return command('POST', `/process/orders/${encodeURIComponent(id)}/resume`, {}, meta)
    },
    voidProductionOrder(id, meta) {
      return command('POST', `/process/orders/${encodeURIComponent(id)}/void`, {}, meta)
    },
    // ---------------- 排程（scheduling） ----------------
    schedulingOrderView(orderId) {
      return request<OrderSchedulingViewDto>('GET', `/scheduling/order-view/${encodeURIComponent(orderId)}`)
    },
    schedulingDeviceView(query) {
      return request<DeviceBoardViewDto>('GET', '/scheduling/device-view', { query: commandQuery(query) })
    },
    schedulingPdaPlan(query) {
      return request<PdaPlanViewDto>('GET', '/scheduling/pda/plan', { query: commandQuery(query) })
    },
    schedulingShiftInfo(query) {
      return request<ShiftInfoDto>('GET', '/scheduling/shift-date', { query: commandQuery(query) })
    },
    saveScheduleSlot(payload, meta) {
      return command('POST', '/scheduling/slots', payload, meta)
    },
    saveScheduleSlotsBatch(payload, meta) {
      return command('POST', '/scheduling/slots/batch', payload, meta)
    },
    setEquipmentCapacity(payload, meta) {
      return command('POST', '/scheduling/capacity', payload, meta)
    },
    clearEquipmentCapacity(payload, meta) {
      return command('DELETE', '/scheduling/capacity', payload, meta)
    },
    setShiftParameter(payload, meta) {
      return command('POST', '/scheduling/shift', payload, meta)
    },
    // ---------------- 报工/投料（execution 三入口） ----------------
    executionScanContext(query) {
      return request<ScanContextEntryDto[]>('GET', '/execution/scan/context', { query: commandQuery(query) })
    },
    reportViaOrder(orderId, payload, meta) {
      return command('POST', `/execution/orders/${encodeURIComponent(orderId)}/reports`, payload, meta)
    },
    reportViaWorkbench(payload, meta) {
      return command('POST', '/execution/workbench/reports', payload, meta)
    },
    reportViaScan(payload, meta) {
      return command('POST', '/execution/scan/reports', payload, meta)
    },
    listReportDrafts(query) {
      return request<PageResult<ExecutionDraftDto>>('GET', '/execution/reports/drafts', { query: commandQuery(query) })
    },
    getReport(reportId) {
      return request<ReportDetailViewDto>('GET', `/execution/reports/${encodeURIComponent(reportId)}`)
    },
    submitReport(reportId, payload, meta) {
      return command('POST', `/execution/reports/${encodeURIComponent(reportId)}/submit`, payload ?? {}, meta)
    },
    reviewReport(reportId, payload, meta) {
      return command('POST', `/execution/reports/${encodeURIComponent(reportId)}/review`, payload ?? {}, meta)
    },
    cancelReportReview(reportId, payload, meta) {
      return command('POST', `/execution/reports/${encodeURIComponent(reportId)}/review-cancel`, payload, meta)
    },
    updateReport(reportId, payload, meta) {
      return command('PATCH', `/execution/reports/${encodeURIComponent(reportId)}`, payload, meta)
    },
    deleteReport(reportId, meta) {
      return command('DELETE', `/execution/reports/${encodeURIComponent(reportId)}`, {}, meta)
    },
    submitFeed(payload, meta) {
      return command('POST', '/execution/feeds', payload, meta)
    },
    recordLabor(payload, meta) {
      return command('POST', '/execution/labor-records', payload, meta)
    },
    orderQuantities(orderId) {
      return request<OrderQuantitiesDto>('GET', `/execution/orders/${encodeURIComponent(orderId)}/quantities`)
    },
    listLaborRecords(orderId) {
      return request<LaborRecordDto[]>('GET', `/execution/orders/${encodeURIComponent(orderId)}/labor-records`)
    },
    // ---------------- 质量放行（quality） ----------------
    listInspections(query) {
      return request<PageResult<InspectionOrderDto>>('GET', '/quality/inspections', { query: commandQuery(query) })
    },
    inspectionDetail(id) {
      return request<InspectionDetailDto>('GET', `/quality/inspections/${encodeURIComponent(id)}`)
    },
    listQualityHolds(query) {
      return request<PageResult<QualityHoldDto>>('GET', '/quality/holds', { query: commandQuery(query) })
    },
    generateInspections(payload, meta) {
      return command('POST', '/quality/inspections/generate', payload, meta)
    },
    submitTestResult(payload, meta) {
      return command('POST', '/quality/test-results', payload, meta)
    },
    releaseInspection(payload, meta) {
      return command('POST', '/quality/dispositions/release', payload, meta)
    },
    concessionInspection(payload, meta) {
      return command('POST', '/quality/dispositions/concession', payload, meta)
    },
    registerSuspect(payload, meta) {
      return command('POST', '/quality/suspects', payload, meta)
    },
    restoreSuspect(payload, meta) {
      return command('POST', '/quality/suspects/restore', payload, meta)
    },
    // ---------------- 入库/移库/调拨（warehousing） ----------------
    listPutawayTasks(query) {
      return request<PageResult<PutawayTaskDto>>('GET', '/warehousing/putaway-tasks', { query: commandQuery(query) })
    },
    listWarehouseMoves(query) {
      return request<PageResult<WarehouseMoveDto>>('GET', '/warehousing/moves', { query: commandQuery(query) })
    },
    listTransfers(query) {
      return request<PageResult<TransferOrderDto>>('GET', '/warehousing/transfers', { query: commandQuery(query) })
    },
    transferDetail(id) {
      return request<TransferDetailDto>('GET', `/warehousing/transfers/${encodeURIComponent(id)}`)
    },
    putawayRefresh(payload, meta) {
      return command('POST', '/warehousing/putaway/refresh', payload, meta)
    },
    putawayConfirm(payload, meta) {
      return command('POST', '/warehousing/putaway/confirm', payload, meta)
    },
    executeWarehouseMove(payload, meta) {
      return command('POST', '/warehousing/moves', payload, meta)
    },
    createTransfer(payload, meta) {
      return command('POST', '/warehousing/transfers', payload, meta)
    },
    submitTransfer(payload, meta) {
      return command('POST', '/warehousing/transfers/submit', payload, meta)
    },
    shipTransfer(payload, meta) {
      return command('POST', '/warehousing/transfers/ship', payload, meta)
    },
    transitTransfer(payload, meta) {
      return command('POST', '/warehousing/transfers/transit', payload, meta)
    },
    receiveTransfer(payload, meta) {
      return command('POST', '/warehousing/transfers/receive', payload, meta)
    },
    // ---------------- 装箱发运（shipping；对齐 shipping.controller.ts 实际路由） ----------------
    listShipmentOrders(query) {
      return request<PageResult<ShipmentOrderDto>>('GET', '/shipping/shipment-orders', { query: commandQuery(query) })
    },
    shipmentDetail(shipmentOrderId) {
      return request<ShipmentOrderDetailDto>('GET', `/shipping/shipment-orders/${encodeURIComponent(shipmentOrderId)}`)
    },
    packingBoard(query) {
      return request<PageResult<PackingOrderDto>>('GET', '/shipping/packing-board', { query: commandQuery(query) })
    },
    outboundStatus(query) {
      return request<PageResult<ShipmentOrderDto>>('GET', '/shipping/outbound-status', { query: commandQuery(query) })
    },
    listDcCompositions(salesOrderNo) {
      const search = new URLSearchParams({ salesOrderNo })
      return request<DcCompositionDto[]>('GET', '/shipping/dc-compositions', { query: search })
    },
    dcCompositionInbound(payload, meta) {
      return command('POST', '/shipping/dc-composition/inbound', payload, meta)
    },
    plInbound(payload, meta) {
      return command('POST', '/shipping/pl/inbound', payload, meta)
    },
    packingCreate(payload, meta) {
      return command('POST', '/shipping/packing', payload, meta)
    },
    packingBind(payload, meta) {
      return command('POST', '/shipping/packing/bind', payload, meta)
    },
    shippingScanLoad(payload, meta) {
      return command('POST', '/shipping/scan/load', payload, meta)
    },
    shippingScanDelete(payload, meta) {
      return command('POST', '/shipping/scan/delete', payload, meta)
    },
    shippingScanSupplement(payload, meta) {
      return command('POST', '/shipping/scan/supplement', payload, meta)
    },
    shipConfirm(payload, meta) {
      return command('POST', '/shipping/ship/confirm', payload, meta)
    },
    syncActualAxisRetry(payload, meta) {
      return command('POST', '/shipping/sync/actual-axis/retry', payload, meta)
    },
    syncStatusRetry(payload, meta) {
      return command('POST', '/shipping/sync/status/retry', payload, meta)
    },
    shippingPhotoAttach(payload, meta) {
      return command('POST', '/shipping/photos', payload, meta)
    },
    // ---------------- 采购（purchase；对齐 purchase.controller.ts） ----------------
    listPurchaseOrderLines(query) {
      return request<PageResult<PurchaseOrderLineDto>>('GET', '/purchase/order-lines', { query: commandQuery(query) })
    },
    syncPurchaseOrders(payload, meta) {
      return command('POST', '/purchase/orders/sync', payload, meta)
    },
  }
}

/** 环境开关解析：VITE_API_MODE=live（默认，接真实后端）| mock（演示数据） */
export function apiModeFromEnv(env: Record<string, string | undefined>): ApiMode {
  return env.VITE_API_MODE === 'mock' ? 'mock' : 'live'
}
