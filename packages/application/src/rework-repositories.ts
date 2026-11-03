import type { InventoryCommandTools } from './inventory-repositories'

/**
 * rework 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0011 表列一一对应；时间字段一律 ISO-8601 字符串；数量一律 DecimalString（IT-07）。
 *
 * ReworkCommandTools = InventoryCommandTools 超集（倒轴/分托/修正/退役复用 inv 仓储束与
 * inventory 记账服务——通过端口注入、同 UoW，IT-18 口径）+ 本域 0011 表仓储束 +
 * 跨域只读事实装配（ReworkFactsLookup：P1 报工/质检/订单/仓库部门类别等）。
 * 等价记账与事实装配为收编候选，列入交付记录 §7（协议第 3 条）。
 */

// ---------------- 记录类型（0011 表） ----------------

/** 倒轴主表（RS-S1，append-only）。 */
export interface ReelSplitOrderRecord {
  id: string
  orderNo: string
  sourceUnitId: string
  sourceUnitNo: string
  originalQty: string
  retainedQty: string
  lossQty: string
  lossReason: string | null
  materialId: string
  materialCode: string
  lotId: string
  orderRef: string | null
  splitBy: string
  splitAt: string
  status: 'executed' | 'reversed'
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
}

export interface ReelSplitLineRecord {
  id: string
  orderId: string
  lineNo: number
  targetUnitId: string
  targetUnitNo: string
  quantity: string
  createdNewUnit: boolean
  createdAt: string
}

/** 倒轴冲销事实（RS-12，append-only）。 */
export interface ReelSplitReversalRecord {
  id: string
  reversalNo: string
  sourceOrderId: string
  sourceOrderNo: string
  reason: string
  reversedBy: string
  reversedAt: string
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
}

/** 分托/解绑任务单（RS-S3：(操作人, 分托类型) 进行中唯一 partial）。 */
export interface PalletTaskRecord {
  id: string
  taskNo: string
  taskType: 'split_pallet' | 'unbind_pallet'
  status: 'in_progress' | 'completed' | 'abandoned'
  operator: string
  operatorDeptCategory: number | null
  targetCarrierId: string | null
  targetCarrierCode: string | null
  warehouseId: string | null
  warehouseCode: string | null
  rackId: string | null
  rackCode: string | null
  locationId: string | null
  locationCode: string | null
  warehouseOfRecord: string | null
  completedAt: string | null
  firstScanAt: string
  plantId: string
  enterpriseId: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

/** 分托/解绑扫入明细（RS-S3/RS-17：扫入快照列）。 */
export interface PalletTaskLineRecord {
  id: string
  taskId: string
  unitId: string
  unitNo: string
  originalCarrierId: string | null
  originalCarrierCode: string | null
  originalWarehouseId: string | null
  originalWarehouseCode: string | null
  originalRackId: string | null
  originalRackCode: string | null
  originalLocationId: string | null
  originalLocationCode: string | null
  reservationId: string | null
  scannedAt: string
  removedAt: string | null
  createdAt: string
}

/** 轴号当前值（本域事实表：码 → 客户轴号/段长/虚拟轴号；0011 建，不改共享表）。 */
export interface AxisNoStateRecord {
  unitId: string
  unitNo: string
  salesOrderNo: string
  orderLineNo: string | null
  customerAxisNo: string | null
  segmentLength: string | null
  virtualAxisNo: string | null
  updatedAt: string
  updatedBy: string | null
}

/** 轴号修正记录（RS-S5：状态列 + 目标码 ID + 前后值快照 + 对象版本）。 */
export interface AxisNoCorrectionRecord {
  id: string
  correctionNo: string
  targetUnitId: string
  targetUnitNo: string
  targetObjectVersion: number
  beforeCustomerAxisNo: string | null
  afterCustomerAxisNo: string | null
  beforeSegmentLength: string | null
  afterSegmentLength: string | null
  beforeVirtualAxisNo: string | null
  afterVirtualAxisNo: string | null
  originalQty: string
  cutQty: string
  newQty: string
  uomId: string
  uomCode: string
  status: 'completed' | 'withdrawn'
  tookOverUnitId: string | null
  tookOverUnitNo: string | null
  reassignReason: string | null
  correctedBy: string
  correctedAt: string
  withdrawnBy: string | null
  withdrawnAt: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
}

/** 退役状态行（RS-S6：RS-36 命令入口判定；独立状态表实现，不改共享 inventory_unit）。 */
export interface AxisCodeRetireRecord {
  unitId: string
  unitNo: string
  retiredBy: string
  retiredAt: string
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
}

/** 轴码清空记录（RS-35 快照字段集，append-only）。 */
export interface AxisRetireRecordEntry {
  id: string
  retireNo: string
  unitId: string
  unitNo: string
  qtyBefore: string
  productionDept: string | null
  productionOrderNo: string | null
  salesOrderNo: string | null
  lineNo: string | null
  materialId: string
  materialCode: string
  processName: string | null
  reportBy: string | null
  reportAt: string | null
  retiredBy: string
  retiredAt: string
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  createdAt: string
}

// ---------------- 仓储接口 ----------------

export interface ReelSplitRepository {
  insertOrder(order: Omit<ReelSplitOrderRecord, 'id' | 'createdAt' | 'status'>): Promise<ReelSplitOrderRecord>
  insertLines(orderId: string, lines: Array<Omit<ReelSplitLineRecord, 'id' | 'orderId' | 'createdAt'>>): Promise<ReelSplitLineRecord[]>
  findById(id: string): Promise<ReelSplitOrderRecord | null>
  findByNo(orderNo: string): Promise<ReelSplitOrderRecord | null>
  listLines(orderId: string): Promise<ReelSplitLineRecord[]>
  insertReversal(reversal: Omit<ReelSplitReversalRecord, 'id' | 'createdAt'>): Promise<ReelSplitReversalRecord>
  /** RS-S1 append-only：冲销状态由冲销事实行存在性派生，不改写主表。 */
  findReversalBySourceOrder(orderId: string): Promise<ReelSplitReversalRecord | null>
  listPaged(filter: {
    enterpriseId: string
    plantIds: string[] | null
    page: number
    pageSize: number
  }): Promise<{ items: ReelSplitOrderRecord[]; total: number }>
  /** 下一个单号（RSP-yyyyMMdd-序号）。 */
  nextOrderNo(now: Date): Promise<string>
}

export interface PalletTaskRepository {
  findInProgress(operator: string, taskType: 'split_pallet' | 'unbind_pallet'): Promise<PalletTaskRecord | null>
  findById(id: string): Promise<PalletTaskRecord | null>
  insert(task: Omit<PalletTaskRecord, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>): Promise<PalletTaskRecord>
  update(id: string, patch: Partial<Omit<PalletTaskRecord, 'id' | 'createdAt'>>, actor: string, now: string): Promise<PalletTaskRecord | null>
  insertLine(line: Omit<PalletTaskLineRecord, 'id' | 'createdAt'>): Promise<PalletTaskLineRecord>
  listLines(taskId: string, includeRemoved: boolean): Promise<PalletTaskLineRecord[]>
  markLineRemoved(lineId: string, now: string): Promise<PalletTaskLineRecord | null>
  listCompletedPaged(filter: {
    enterpriseId: string
    plantIds: string[] | null
    taskType?: 'split_pallet' | 'unbind_pallet'
    operator?: string
    page: number
    pageSize: number
  }): Promise<{ items: PalletTaskRecord[]; total: number }>
  nextTaskNo(now: Date): Promise<string>
}

export interface AxisNoRepository {
  getState(unitId: string): Promise<AxisNoStateRecord | null>
  listByOrder(salesOrderNo: string, plantId?: string): Promise<AxisNoStateRecord[]>
  upsertState(state: Omit<AxisNoStateRecord, 'updatedAt' | 'updatedBy'>, actor: string, now: string): Promise<AxisNoStateRecord>
  insertCorrection(c: Omit<AxisNoCorrectionRecord, 'id' | 'createdAt'>): Promise<AxisNoCorrectionRecord>
  findCorrectionById(id: string): Promise<AxisNoCorrectionRecord | null>
  listCorrectionsPaged(filter: {
    enterpriseId: string
    plantIds: string[] | null
    status?: 'completed' | 'withdrawn'
    page: number
    pageSize: number
  }): Promise<{ items: AxisNoCorrectionRecord[]; total: number }>
  markWithdrawn(id: string, withdrawnBy: string, now: string): Promise<AxisNoCorrectionRecord | null>
  nextCorrectionNo(now: Date): Promise<string>
}

export interface AxisRetireRepository {
  insertRetireState(row: Omit<AxisCodeRetireRecord, never>): Promise<AxisCodeRetireRecord>
  findRetireState(unitId: string): Promise<AxisCodeRetireRecord | null>
  listRetiredUnitIds(unitIds: readonly string[]): Promise<string[]>
  insertRecord(row: Omit<AxisRetireRecordEntry, 'id' | 'createdAt'>): Promise<AxisRetireRecordEntry>
  listRecordsPaged(filter: {
    enterpriseId: string
    plantIds: string[] | null
    page: number
    pageSize: number
  }): Promise<{ items: AxisRetireRecordEntry[]; total: number }>
  nextRetireNo(now: Date): Promise<string>
}

// ---------------- 跨域只读事实装配（收编候选，交付记录 §7） ----------------

/** 操作人组织事实（RS-13 车间判定）。 */
export interface ReworkOperatorOrgFacts {
  loginName: string
  deptCategory: number | null
  plantId: string | null
}

/**
 * 倒出轴事实装配结果：除 domain ReelSplitSourceFacts 字段外补齐库位/所有者键
 * （记账装配用，等价 splitStock 的余额解析）。
 */
export interface ReelSplitSourceRow extends Record<string, unknown> {
  unitId: string
  unitNo: string
  exists: boolean
  isPalletCode: boolean
  locked: boolean
  qualityPending: boolean
  reportUnreviewed: boolean
  anomalyOpen: boolean
  inLogisticsWarehouse: boolean
  multiMaterial: boolean
  balanceQty: string
  materialId: string
  materialCode: string
  lotId: string
  customerAxisNo: string | null
  segmentLength: string | null
  uomId: string
  uomCode: string
  retired: boolean
}

/** 倒入码事实（RS-09：倒入码已有料品校验 + 余额键）。 */
export interface ReelSplitTargetRow {
  unitId: string | null
  unitNo: string
  exists: boolean
  materialId: string | null
  materialCode: string | null
  locationId: string | null
  locationCode: string | null
  ownerId: string | null
  ownerName: string | null
  unitNoTakenByOtherPlant: boolean
}

/** 倒轴冲销下游引用事实（RS-12）。 */
export interface ReelSplitReversalDownstreamRow {
  anyChildStocked: boolean
  anyChildConsumed: boolean
  anyChildConverted: boolean
  anyChildShipped: boolean
  anyChildQualityEffective: boolean
}

/** 分托/解绑扫料品码事实（含位置快照）。 */
export interface PalletScanRow {
  unitId: string
  unitNo: string
  exists: boolean
  isPalletCode: boolean
  multiMaterial: boolean
  inStock: boolean
  inWarehouse: boolean
  boundCarrierId: string | null
  boundCarrierCode: string | null
  warehouseId: string | null
  warehouseCode: string | null
  rackId: string | null
  rackCode: string | null
  locationId: string | null
  locationCode: string | null
  lockedByOther: boolean
  warehouseLocked: boolean
  retired: boolean
}

/** 修正扫码事实行（RS-25 装配）。 */
export interface CorrectionScanRow {
  unitId: string | null
  unitNo: string
  exists: boolean
  isPalletCode: boolean
  multiMaterial: boolean
  inLogisticsWarehouse: boolean
  sold: boolean
  qualityPending: boolean
  reportUnreviewed: boolean
  anomalyOpen: boolean
  locked: boolean
  hasOrder: boolean
  transitAxisPending: boolean
  retired: boolean
  currentQty: string | null
  maxSingleReportQty: string
  materialId: string | null
  materialPrimaryUomCode: string | null
  salesOrderNo: string | null
}

/** 修正回撤下游事实（RS-33）。 */
export interface CorrectionWithdrawDownstreamRow {
  splitAfterCorrection: boolean
  shipped: boolean
  converted: boolean
  qualityEffective: boolean
}

/** 退役候选事实行（RS-34 装配）。 */
export interface AxisRetireCandidateRow {
  unitId: string
  unitNo: string
  isProductAxisCode: boolean
  qualityCompleted: boolean
  reportReviewed: boolean
  transitAxisPending: boolean
  inFinishedGoodsStock: boolean
  retired: boolean
  qtyBefore: string
  productionDept: string | null
  productionOrderNo: string | null
  salesOrderNo: string | null
  lineNo: string | null
  materialId: string
  materialCode: string
  processName: string | null
  reportBy: string | null
  reportAt: string | null
  uomId: string
  uomCode: string
  measurementBasis: string
  conversionRevisionId: string | null
  balanceId: string | null
  locationId: string | null
  ownerId: string | null
}

/** 分托导出行（RS-24：导出那一刻绑定在托码上的料品码）。 */
export interface PalletExportQueryRow {
  carrierCode: string
  unitNo: string
  productAxisNo: string | null
  materialCode: string
  quantity: string
}

export interface ReworkFactsLookup {
  operatorOrgFacts(userId: string): Promise<ReworkOperatorOrgFacts>
  reelSplitSourceRow(plantId: string, unitNo: string): Promise<ReelSplitSourceRow>
  reelSplitTargetRows(plantId: string, unitNos: readonly string[]): Promise<ReelSplitTargetRow[]>
  reelSplitReversalDownstream(childUnitIds: readonly string[], sourceUnitId: string): Promise<ReelSplitReversalDownstreamRow>
  /** RS-12 冲销源恢复：含已关闭（零余额）行的余额键（stock_balance active+closed）。 */
  unitBalancesIncludingClosed(unitId: string): Promise<Array<{
    id: string
    locationId: string
    locationCode: string
    ownerId: string
    ownerName: string
    quantity: string
    status: 'active' | 'closed'
    uomId: string
    uomCode: string
    measurementBasis: string
    conversionRevisionId: string | null
  }>>
  palletScanRow(plantId: string, unitNo: string, taskId: string | null, taskType: 'split_pallet' | 'unbind_pallet'): Promise<PalletScanRow>
  carrierEverBound(carrierCode: string, plantId: string): Promise<{ carrierId: string; everBound: boolean; warehouseId: string | null; warehouseCode: string | null; rackId: string | null; rackCode: string | null; locationId: string | null; locationCode: string | null } | null>
  carrierWarehouseId(carrierId: string): Promise<string | null>
  warehouseLocked(warehouseId: string | null): Promise<boolean>
  axisRegistrationOrigin(unitId: string): Promise<{ orderId: string; salesOrderNo: string; lineNo: string | null;
    plantId: string; enterpriseId: string; outputQty: string } | null>
  correctionScanRow(plantId: string, unitNo: string): Promise<CorrectionScanRow>
  correctionOccupiedUnitRow(unitId: string): Promise<{ inWarehouse: boolean; sold: boolean; locked: boolean } | null>
  correctionWithdrawDownstream(unitId: string): Promise<CorrectionWithdrawDownstreamRow>
  axisRetireCandidateRows(plantId: string, unitNos: readonly string[]): Promise<AxisRetireCandidateRow[]>
  palletExportRows(plantId: string, carrierCodes: readonly string[]): Promise<PalletExportQueryRow[]>
}

// ---------------- 命令工具集 ----------------

/** rework 命令工具集：inventory 工具集 + 本域仓储束 + 跨域事实装配。 */
export interface ReworkCommandTools extends InventoryCommandTools {
  rework: {
    reelSplits: ReelSplitRepository
    palletTasks: PalletTaskRepository
    axisNo: AxisNoRepository
    retires: AxisRetireRepository
    facts: ReworkFactsLookup
  }
}
