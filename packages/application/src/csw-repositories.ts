import type { PageRequest, PageResult } from '@cadenza/contracts'
import type { CommandTools } from './command-bus'
import type { OutboxCollector, InventoryRepositories } from './inventory-repositories'
import type { SchedulingRepositories } from './scheduling-repositories'
 
import type {
  CalibrationStateView,
  ChangeoverDimensionKind,
  ChangeoverEntry,
  DowntimeWindow,
} from '@cadenza/domain'

/**
 * csw 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0018 csw 表列一一对应；时间字段一律 ISO-8601 字符串；数量字段 DecimalString；
 * 日期字段 YYYY-MM-DD 字符串（停机窗口允许日期时间串——date-only 视为整日）。
 *
 * 注意：本文件未加入 application/src/index.ts 导出（S2 共享文件不可改，L0 整合步统一导出）；
 * persistence 实现以 dist 相对导入消费本端口（见 packages/persistence/src/csw-repositories.ts）。
 *
 * CswCommandTools = InventoryCommandTools 超集（外协两段库存交接复用 inventory 记账服务，
 * IT-18 库存域唯一维护方）+ scheduling 仓储束（排程底座 T09 只读写，不改其文件）
 * + csw 仓储束 + Outbox 收集器（CS-24 加工数量事实模拟出站）。
 */

// ---------------- 冻结记录（CS-11/CS-S2） ----------------

export type CswFreezeScope = 'equipment_date_range' | 'slot'

export interface CswFreezeRecord {
  id: string
  enterpriseId: string
  plantId: string
  scope: CswFreezeScope
  equipmentId: string
  productionDateFrom: string
  productionDateTo: string
  slotId: string | null
  status: 'active' | 'ended'
  reason: string | null
  frozenBy: string | null
  frozenAt: string
  unfrozenBy: string | null
  unfrozenAt: string | null
  unfreezeReason: string | null
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewCswFreezeRecord {
  id?: string
  enterpriseId: string
  plantId: string
  scope: CswFreezeScope
  equipmentId: string
  productionDateFrom: string
  productionDateTo: string
  slotId?: string | null
  reason?: string | null
  frozenBy?: string | null
}

export interface CswFreezeRepository {
  insert(record: NewCswFreezeRecord): Promise<CswFreezeRecord>
  findById(id: string): Promise<CswFreezeRecord | null>
  /** 行锁（解冻同事务复核状态）。 */
  lockById(id: string): Promise<CswFreezeRecord | null>
  listActiveByEquipment(equipmentId: string): Promise<CswFreezeRecord[]>
  list(filter: { plantIds: string[] | null; equipmentId?: string; status?: 'active' | 'ended' } & PageRequest): Promise<
    PageResult<CswFreezeRecord>
  >
  /** [CS-11] 解冻落痕：操作者/时间/理由。 */
  release(id: string, patch: { unfrozenBy: string; unfreezeReason: string; unfrozenAt: string }): Promise<CswFreezeRecord>
}

// ---------------- 换型矩阵版本（CS-16/CS-S3） ----------------

export interface CswChangeoverMatrixRecord {
  id: string
  enterpriseId: string
  plantId: string
  versionNo: number
  dimensionKind: ChangeoverDimensionKind
  defaultMinutes: number
  entries: ChangeoverEntry[]
  note: string | null
  createdBy: string | null
  createdAt: string
}

export interface NewCswChangeoverMatrix {
  id?: string
  enterpriseId: string
  plantId: string
  versionNo: number
  dimensionKind: ChangeoverDimensionKind
  defaultMinutes: number
  entries: ChangeoverEntry[]
  note?: string | null
  createdBy?: string | null
}

export interface CswChangeoverMatrixRepository {
  insert(matrix: NewCswChangeoverMatrix): Promise<CswChangeoverMatrixRecord>
  findById(id: string): Promise<CswChangeoverMatrixRecord | null>
  /** 活动版本＝同厂最大 versionNo（append-only 版本行，被引用版本 immutable）。 */
  findLatestByPlant(plantId: string): Promise<CswChangeoverMatrixRecord | null>
  list(filter: { plantIds: string[] | null }): Promise<CswChangeoverMatrixRecord[]>
}

// ---------------- 排程版本与条目（CS-12/13/14/15/27） ----------------

export type CswScheduleVersionStatus = 'proposed' | 'committed' | 'superseded'

export interface CswScheduleVersionRecord {
  id: string
  enterpriseId: string
  plantId: string
  versionNo: number
  source: 'system_suggestion' | 'manual_commit'
  parentVersionId: string | null
  matrixVersionId: string | null
  weights: { dueDate: string; changeover: string; loadBalance: string }
  horizonDays: number
  horizonFrom: string
  status: CswScheduleVersionStatus
  proposedBy: string | null
  committedBy: string | null
  committedAt: string | null
  supersededAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  updatedBy: string | null
}

export interface NewCswScheduleVersion {
  id?: string
  enterpriseId: string
  plantId: string
  versionNo: number
  source: 'system_suggestion' | 'manual_commit'
  parentVersionId?: string | null
  matrixVersionId?: string | null
  weights: { dueDate: string; changeover: string; loadBalance: string }
  horizonDays: number
  horizonFrom: string
  proposedBy?: string | null
}

export interface CswScheduleVersionItemRecord {
  id: string
  versionId: string
  itemNo: number
  action: 'keep' | 'move' | 'new' | 'remove' | 'conflict' | 'outside_horizon'
  orderOperationId: string
  orderId: string
  orderNo: string
  operationName: string
  operationDefinitionId: string
  equipmentId: string | null
  productionDate: string | null
  plannedQty: string | null
  slotId: string | null
  frozen: boolean
  started: boolean
  needManual: boolean
  softViolations: Array<{ code: string; detail: string }>
  explanation: Record<string, unknown>
  suggestions: Array<{ option: string; detail: string }>
  createdAt: string
}

export interface NewCswScheduleVersionItem {
  itemNo: number
  action: CswScheduleVersionItemRecord['action']
  orderOperationId: string
  orderId: string
  orderNo: string
  operationName: string
  operationDefinitionId: string
  equipmentId?: string | null
  productionDate?: string | null
  plannedQty?: string | null
  slotId?: string | null
  frozen?: boolean
  started?: boolean
  needManual?: boolean
  softViolations?: Array<{ code: string; detail: string }>
  explanation?: Record<string, unknown>
  suggestions?: Array<{ option: string; detail: string }>
}

export interface CswScheduleVersionRepository {
  insert(version: NewCswScheduleVersion): Promise<CswScheduleVersionRecord>
  findById(id: string): Promise<CswScheduleVersionRecord | null>
  lockById(id: string): Promise<CswScheduleVersionRecord | null>
  findLatestCommitted(plantId: string): Promise<CswScheduleVersionRecord | null>
  /** 下一版本号（同厂递增）。 */
  nextVersionNo(plantId: string): Promise<number>
  markCommitted(id: string, patch: { committedBy: string; committedAt: string }): Promise<CswScheduleVersionRecord>
  markSuperseded(id: string, at: string): Promise<CswScheduleVersionRecord>
  list(filter: { plantIds: string[] | null; status?: CswScheduleVersionStatus } & PageRequest): Promise<
    PageResult<CswScheduleVersionRecord>
  >
}

export interface CswScheduleVersionItemRepository {
  insertMany(versionId: string, items: readonly NewCswScheduleVersionItem[]): Promise<number>
  listByVersion(versionId: string): Promise<CswScheduleVersionItemRecord[]>
}

// ---------------- 人工覆盖审计（CS-26/CS-S5） ----------------

export type CswOverrideType =
  | 'soft_constraint_confirm'
  | 'unfreeze'
  | 'weight_change'
  | 'manual_over_suggestion'

export interface CswOverrideAuditRecord {
  id: string
  enterpriseId: string
  plantId: string
  overrideType: CswOverrideType
  operator: string
  reason: string
  affectedTasks: string[]
  scheduleVersionId: string | null
  createdAt: string
}

export interface NewCswOverrideAudit {
  enterpriseId: string
  plantId: string
  overrideType: CswOverrideType
  operator: string
  reason: string
  affectedTasks: string[]
  scheduleVersionId?: string | null
}

export interface CswOverrideAuditRepository {
  insert(entry: NewCswOverrideAudit): Promise<CswOverrideAuditRecord>
  list(filter: { plantIds: string[] | null; overrideType?: CswOverrideType } & PageRequest): Promise<
    PageResult<CswOverrideAuditRecord>
  >
}

// ---------------- 校准状态投影（CS-05③/CS-10 等价服务，收编请求：T23 spc 校准记录） ----------------

export interface CswCalibrationStateRecord extends CalibrationStateView {
  id: string
  enterpriseId: string
  plantId: string
  equipmentId: string
  calibrationResult: 'qualified' | 'limited' | 'invalid'
  validUntil: string | null
  certificateNo: string | null
  /** [CS-10] 校准失效时的已排槽位标记清单（不删除，仅提示；处置 → CA-11 待裁） */
  affectedSlotIds: string[]
  updatedBy: string | null
  updatedAt: string
  createdBy: string | null
  createdAt: string
}

export interface CswCalibrationStateRepository {
  upsert(state: {
    enterpriseId: string
    plantId: string
    equipmentId: string
    calibrationResult: 'qualified' | 'limited' | 'invalid'
    validUntil: string | null
    certificateNo?: string | null
    affectedSlotIds: string[]
    updatedBy: string | null
  }): Promise<CswCalibrationStateRecord>
  findByEquipment(equipmentId: string): Promise<CswCalibrationStateRecord | null>
  list(filter: { plantIds: string[] | null }): Promise<CswCalibrationStateRecord[]>
}

// ---------------- 停机窗口（CS-09 等价服务，收编请求：T19 downtime_event） ----------------

export interface CswDowntimeRecord {
  id: string
  enterpriseId: string
  plantId: string
  equipmentId: string
  kind: DowntimeWindow['kind']
  /** ISO 日期或日期时间串（date-only＝整日） */
  fromAt: string
  toAt: string
  status: 'active' | 'closed'
  note: string | null
  /** [CS-09] 关闭时的受影响槽位清单（提示计划员，不自动重排） */
  impactSlotIds: string[]
  closedBy: string | null
  closedAt: string | null
  createdBy: string | null
  createdAt: string
}

export interface NewCswDowntimeRecord {
  enterpriseId: string
  plantId: string
  equipmentId: string
  kind: DowntimeWindow['kind']
  fromAt: string
  toAt: string
  note?: string | null
  createdBy?: string | null
}

export interface CswDowntimeRepository {
  insert(downtime: NewCswDowntimeRecord): Promise<CswDowntimeRecord>
  findById(id: string): Promise<CswDowntimeRecord | null>
  lockById(id: string): Promise<CswDowntimeRecord | null>
  close(id: string, patch: { closedBy: string; closedAt: string; impactSlotIds: string[] }): Promise<CswDowntimeRecord>
  listActiveByEquipment(equipmentId: string): Promise<CswDowntimeRecord[]>
  list(filter: { plantIds: string[] | null; equipmentId?: string; status?: 'active' | 'closed' } & PageRequest): Promise<
    PageResult<CswDowntimeRecord>
  >
}

// ---------------- 外协任务（CS-19～CS-25/CS-S4） ----------------

export type CswOutsourcingStatus =
  | 'draft'
  | 'pending_send'
  | 'sent'
  | 'return_received'
  | 'inspecting'
  | 'closed'
  | 'recalled'
  | 'return_disposed'

export interface CswOutsourcingTaskRecord {
  id: string
  taskNo: string
  enterpriseId: string
  plantId: string
  orderId: string
  orderOperationId: string
  orderNo: string
  operationName: string
  supplierCode: string | null
  supplierName: string
  qty: string
  uom: string
  /** 外协在途位（发送段 transit；CS-21 两段原子步） */
  transitLocationId: string
  transitLocationCode: string
  /** 回厂目的位（回厂仓/待检位；CS-22 默认全部必检） */
  returnLocationId: string | null
  returnLocationCode: string | null
  status: CswOutsourcingStatus
  inspectionResult: 'pending' | 'passed' | 'rejected' | null
  sentQty: string
  returnedQty: string
  sentBy: string | null
  sentAt: string | null
  receivedBy: string | null
  receivedAt: string | null
  inspectedBy: string | null
  inspectedAt: string | null
  closedBy: string | null
  closedAt: string | null
  recallReason: string | null
  recalledBy: string | null
  recalledAt: string | null
  disposeReason: string | null
  disposedBy: string | null
  disposedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  updatedBy: string | null
}

export interface NewCswOutsourcingTask {
  id?: string
  taskNo: string
  enterpriseId: string
  plantId: string
  orderId: string
  orderOperationId: string
  orderNo: string
  operationName: string
  supplierCode?: string | null
  supplierName: string
  qty: string
  uom: string
  transitLocationId: string
  transitLocationCode: string
  returnLocationId?: string | null
  returnLocationCode?: string | null
  createdBy?: string | null
}

export interface CswOutsourcingUnitRecord {
  id: string
  taskId: string
  unitId: string
  unitNo: string
  /** 发送时单元批次（谱系父子边的 from 端） */
  sendLotId: string | null
  sentQty: string
  returnedQty: string
  /** 回厂新批次（声明且不同于发送批次时落 genealogy_edge，CS-23） */
  returnLotId: string | null
  status: 'sent' | 'returned'
  createdAt: string
  updatedAt: string
}

export interface NewCswOutsourcingUnit {
  taskId: string
  unitId: string
  unitNo: string
  sendLotId?: string | null
  sentQty: string
  createdBy?: string | null
}

export interface CswOutsourcingTaskRepository {
  insert(task: NewCswOutsourcingTask): Promise<CswOutsourcingTaskRecord>
  findById(id: string): Promise<CswOutsourcingTaskRecord | null>
  findByTaskNo(taskNo: string): Promise<CswOutsourcingTaskRecord | null>
  lockById(id: string): Promise<CswOutsourcingTaskRecord | null>
  /** 状态迁移与事实列更新（同命令事务；CS-S4 与库存交接同事务）。 */
  update(
    id: string,
    patch: Partial<
      Pick<
        CswOutsourcingTaskRecord,
        | 'status'
        | 'inspectionResult'
        | 'sentQty'
        | 'returnedQty'
        | 'sentBy'
        | 'sentAt'
        | 'receivedBy'
        | 'receivedAt'
        | 'inspectedBy'
        | 'inspectedAt'
        | 'closedBy'
        | 'closedAt'
        | 'recallReason'
        | 'recalledBy'
        | 'recalledAt'
        | 'disposeReason'
        | 'disposedBy'
        | 'disposedAt'
        | 'returnLocationId'
        | 'returnLocationCode'
        | 'updatedBy'
      >
    >,
  ): Promise<CswOutsourcingTaskRecord>
  /** [CS-25] 订单工序的外协占用查询（占用状态：pending_send/sent/return_received/inspecting）。 */
  listOccupyingByOrderOperation(orderOperationId: string): Promise<CswOutsourcingTaskRecord[]>
  list(
    filter: { plantIds: string[] | null; status?: CswOutsourcingStatus; orderOperationId?: string; taskNoLike?: string } &
      PageRequest,
  ): Promise<PageResult<CswOutsourcingTaskRecord>>
}

export interface CswOutsourcingUnitRepository {
  insert(link: NewCswOutsourcingUnit): Promise<CswOutsourcingUnitRecord>
  listByTask(taskId: string): Promise<CswOutsourcingUnitRecord[]>
  findByTaskAndUnit(taskId: string, unitId: string): Promise<CswOutsourcingUnitRecord | null>
  /** 回厂段更新：returnedQty / returnLotId / status（发送余量在装配层校验）。 */
  updateReturned(
    id: string,
    patch: { returnedQty: string; returnLotId?: string | null; status?: 'sent' | 'returned' },
  ): Promise<CswOutsourcingUnitRecord>
}

// ---------------- csw 只读扩展查询（T09 排程底座的窄读面，收编请求随 L0 统一处置） ----------------

/** 可排产订单富行（引擎输入：含计划完成时间 CS-17 交期紧迫度来源）。 */
export interface CswSchedulableOrderRow {
  orderId: string
  orderNo: string
  plantId: string
  orderStatus: string
  materialId: string
  materialCode: string
  /** 产品属性维度值（料品快照 spec；换型矩阵 product_attribute 维度用） */
  productAttribute: string | null
  plannedFinishDate: string | null
  orderOperationId: string
  seq: number
  operationDefinitionId: string
  operationCode: string | null
  operationName: string
  offlineQty: string
  workCenterId: string
  executionStatus: 'pending' | 'executed'
  uom: string
}

export interface CswSlotBrief {
  id: string
  orderId: string
  orderOperationId: string
  operationDefinitionId: string
  equipmentId: string
  productionDate: string
  plannedQty: string
}

/** 物料可用量行（CS-08 默认口径：质量 ∧ 预留 过滤后的余额）。 */
export interface CswMaterialAvailabilityRow {
  materialId: string
  availableQty: string
  reservedQty: string
}

export interface CswStorageLocationBrief {
  id: string
  code: string
  plantId: string
}

export interface CswLookups {
  /** 厂内可排产订单工序富行（排除 closed/voided 订单；含计划完成日期）。 */
  listSchedulableOrders(plantId: string): Promise<CswSchedulableOrderRow[]>
  /** 订单工序全部有效槽位（引擎/硬校验输入；复用 T09 表只读）。 */
  listSlotsByOrderOperation(orderOperationId: string): Promise<CswSlotBrief[]>
  /** 设备×日期既有排产合计与行集（引擎负载输入）。 */
  listSlotsByEquipmentAndDateRange(
    equipmentId: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<CswSlotBrief[]>
  /** 物料可用量（质量 ∧ 预留；CS-08 默认口径）。 */
  computeMaterialAvailability(plantId: string, materialId: string): Promise<CswMaterialAvailabilityRow>
  /** 库位存在性（0003 主数据只读；外协在途位/回厂待检位校验）。 */
  findStorageLocation(locationId: string): Promise<CswStorageLocationBrief | null>
}

// ---------------- 端口束 ----------------

export interface CswRepositories {
  freezes: CswFreezeRepository
  matrices: CswChangeoverMatrixRepository
  versions: CswScheduleVersionRepository
  versionItems: CswScheduleVersionItemRepository
  overrides: CswOverrideAuditRepository
  calibration: CswCalibrationStateRepository
  downtimes: CswDowntimeRepository
  outsourcingTasks: CswOutsourcingTaskRepository
  outsourcingUnits: CswOutsourcingUnitRepository
  lookups: CswLookups
}

/** csw 命令工具集：InventoryCommandTools 超集（组合根装配时注入库存/排程/csw 仓储束）。 */
export interface CswCommandTools extends CommandTools {
  inv: InventoryRepositories
  scheduling: SchedulingRepositories
  csw: CswRepositories
  outbox: OutboxCollector
}
