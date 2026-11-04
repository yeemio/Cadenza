import type { InventoryCommandTools } from './inventory-repositories'

/**
 * quality 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0009 quality 表列一一对应；时间字段一律 ISO-8601 字符串；
 * 数量字段一律 DecimalString（IT-07）。
 *
 * QualityCommandTools = InventoryCommandTools 超集（放行/让步/存疑复用 inv 仓储束
 * 更新库存质量投影——通过端口注入、同 UoW，IT-18 库存域唯一维护方口径）+ 事件端口。
 */

// ---------------- 记录类型 ----------------

export interface InspectionOrderRecord {
  id: string
  orderNo: string
  sourceType: 'work_report' | 'putaway_receipt'
  sourceRef: string
  inspectionStage: 'process' | 'finished'
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
  status: 'pending' | 'in_progress' | 'concluded' | 'cancelled'
  productionOrderNo: string | null
  productionDeptId: string | null
  productionDeptName: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  updatedAt: string
}

export interface NewInspectionOrder {
  orderNo: string
  sourceType: InspectionOrderRecord['sourceType']
  sourceRef: string
  inspectionStage: InspectionOrderRecord['inspectionStage']
  specCode: string
  specVersion: number
  unitNo?: string | null
  materialId: string
  materialCode: string
  lotId?: string | null
  quantity: string
  uomId: string
  uomCode: string
  productionOrderNo?: string | null
  productionDeptId?: string | null
  productionDeptName?: string | null
  plantId: string
  enterpriseId: string
  createdBy?: string | null
}

export interface TestResultRecord {
  id: string
  inspectionOrderId: string
  version: number
  conclusion: 'pending' | 'qualified' | 'unqualified'
  items: unknown
  resultKind: 'initial' | 'test' | 're_inspection'
  isEffective: boolean
  inspector: string | null
  inspectedAt: string | null
  commandReceiptId: string | null
  createdAt: string
}

export interface NewTestResult {
  inspectionOrderId: string
  version: number
  conclusion: TestResultRecord['conclusion']
  items?: unknown
  resultKind?: TestResultRecord['resultKind']
  isEffective?: boolean
  inspector?: string | null
  inspectedAt?: string | null
  commandReceiptId?: string | null
  createdBy?: string | null
}

export interface DispositionRecord {
  id: string
  inspectionOrderId: string
  dispositionKind: 'release' | 'concession'
  basedOnVersion: number
  releasedBy: string
  releasedAt: string
  reason: string | null
  commandReceiptId: string | null
  createdAt: string
}

export interface QualityHoldRecord {
  id: string
  inventoryUnitId: string
  unitNo: string
  holdKind: 'pending_inspection' | 'unqualified' | 'suspect'
  status: 'active' | 'released'
  previousQualityStatus: string | null
  raisedBy: string
  raisedAt: string
  productionDeptId: string | null
  productionDeptName: string | null
  releasedBy: string | null
  releasedAt: string | null
  dispositionNote: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
}

export interface NewQualityHold {
  inventoryUnitId: string
  unitNo: string
  holdKind: QualityHoldRecord['holdKind']
  previousQualityStatus?: string | null
  raisedBy: string
  raisedAt: string
  productionDeptId?: string | null
  productionDeptName?: string | null
  plantId: string
  enterpriseId: string
  commandReceiptId?: string | null
  createdBy?: string | null
}

// ---------------- 仓储端口 ----------------

export interface InspectionOrderRepository {
  findById(id: string, forUpdate?: boolean): Promise<InspectionOrderRecord | null>
  /** 来源幂等查重（A-T12-5：(source_type, source_ref, inspection_stage) 唯一）。 */
  findBySource(
    sourceType: InspectionOrderRecord['sourceType'],
    sourceRef: string,
    inspectionStage: InspectionOrderRecord['inspectionStage'],
  ): Promise<InspectionOrderRecord | null>
  insert(order: NewInspectionOrder): Promise<InspectionOrderRecord>
  updateStatus(id: string, status: InspectionOrderRecord['status'], actor: string | null): Promise<InspectionOrderRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    stages?: string[]
    orderNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: InspectionOrderRecord[]; total: number }>
}

export interface TestResultRepository {
  insert(record: NewTestResult): Promise<TestResultRecord>
  listByOrder(inspectionOrderId: string): Promise<TestResultRecord[]>
  findEffective(inspectionOrderId: string): Promise<TestResultRecord | null>
  /** S14 指针翻转：仅更新 is_effective（触发器守卫事实列）。 */
  setEffective(id: string, isEffective: boolean, actor: string | null): Promise<void>
}

export interface DispositionRepository {
  insert(input: {
    inspectionOrderId: string
    dispositionKind: 'release' | 'concession'
    basedOnVersion: number
    releasedBy: string
    releasedAt: string
    reason?: string | null
    commandReceiptId?: string | null
  }): Promise<DispositionRecord>
  listByOrder(inspectionOrderId: string): Promise<DispositionRecord[]>
}

export interface QualityHoldRepository {
  insert(hold: NewQualityHold): Promise<QualityHoldRecord>
  findById(id: string, forUpdate?: boolean): Promise<QualityHoldRecord | null>
  /** 活动隔离（含已过期的活动作业预留口径行——有效性由域规则判定）。 */
  findActiveByUnit(inventoryUnitId: string): Promise<QualityHoldRecord | null>
  listByUnit(inventoryUnitId: string): Promise<QualityHoldRecord[]>
  /** 恢复（A-T12-3 最小处置记录：released_by/released_at/disposition_note 必留痕；行不删除）。 */
  release(
    id: string,
    patch: { releasedBy: string; releasedAt: string; dispositionNote: string },
    actor: string | null,
  ): Promise<QualityHoldRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    holdKinds?: string[]
    page: number
    pageSize: number
  }): Promise<{ items: QualityHoldRecord[]; total: number }>
}

// ---------------- 执行块事件端口 ----------------

/** 执行块提交事件（T10 报工域未建：L0 整合接线；测试内存实现）。 */
export interface ExecutionEventRecord {
  eventId: string
  /** work_report_confirmed=报工确认（过程/成品检验任务与待入库任务来源）；finished_inspection_released=成品质检放行（待入库任务来源）。 */
  eventType: 'work_report_confirmed' | 'finished_inspection_released'
  occurredAt: string
  plantId: string
  payload: {
    /** 来源幂等键（报工块 ID / 检验单 ID）。 */
    sourceRef: string
    unitNo?: string
    materialId: string
    materialCode: string
    materialType?: number | null
    quantity: string
    uomId: string
    uomCode: string
    productionOrderNo?: string
    productionDeptId?: string
    productionDeptName?: string
    /** 检验阶段（过程/成品；缺省 finished）。 */
    inspectionStage?: 'process' | 'finished'
    /** 检验规范引用（版本化；quality.generate 缺省值兜底）。 */
    specCode?: string
    specVersion?: number
    /** 托码（整托上架）。 */
    palletCode?: string
  }
}

/**
 * 执行块事件端口（端口注入，L0 整合接线；测试内存实现）。
 * quality.inspection.generate（检验任务生成）与 warehousing.putaway.refresh
 * （入库任务刷新）从本端口拉取事件流重跑；幂等由目标表来源唯一键承担（重放不重复生成）。
 */
export interface ExecutionEventPort {
  fetchEvents(input: { types?: string[]; plantId?: string }): Promise<ExecutionEventRecord[]>
}

// ---------------- 命令工具集扩展 ----------------

/** quality 域仓储集合。 */
export interface QualityRepositories {
  inspectionOrders: InspectionOrderRepository
  testResults: TestResultRepository
  dispositions: DispositionRepository
  holds: QualityHoldRepository
}

/**
 * quality 命令工具集：InventoryCommandTools（org 基础 + inv 仓储 + Outbox 收集）超集，
 * 追加 quality 仓储束与执行块事件端口（检验任务生成消费执行块提交后事件）。
 */
export interface QualityCommandTools extends InventoryCommandTools {
  qa: QualityRepositories
  events: ExecutionEventPort
}
