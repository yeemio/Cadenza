import type { InventoryCommandTools } from './inventory-repositories'

/**
 * conversionform 域仓储端口（应用层定义，persistence 层实现，依赖方向 persistence → application）。
 * 记录类型与迁移 0012 conversion 表列一一对应；时间字段一律 ISO-8601 字符串；
 * 数量/段长字段一律 DecimalString（IT-07）。
 *
 * 两协议分立（FC-01）：conversion_order 与 conversion_code_assignment（订单式）及
 * conversion_stock_order、conversion_code_rewrite（库存式）各自成表，端口不共享记录类型。
 *
 * 本文件未加入 application/src/index.ts 导出（共享文件不改动，L0 整合步统一导出）；
 * persistence 实现与 apps/api 组合根以 dist 相对导入消费本端口（[L0-整合标记]）。
 */

// ---------------- 协议A：订单转换单 ----------------

export interface ConversionOrderRecord {
  id: string
  conversionNo: string
  status: 'pending' | 'completed'
  syncStatus: 'pending' | 'sync_failed' | 'synced'
  completedBy: string | null
  completedAt: string | null
  completionSnapshot: Record<string, unknown> | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewConversionOrder {
  conversionNo: string
  plantId: string
  enterpriseId: string
  businessTime?: string
  createdBy?: string | null
  commandReceiptId?: string | null
}

export interface ConversionOrderLineRecord {
  id: string
  conversionOrderId: string
  lineNo: number
  sourceOrderId: string
  sourceSalesOrderNo: string
  sourceLineNo: string
  sourceProjectNo: string | null
  targetOrderId: string
  targetSalesOrderNo: string
  targetProjectNo: string
  materialId: string
  materialCode: string
  plannedQty: string
  uom: string
  scannedQty: string
  scannedAxes: number
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewConversionOrderLine {
  conversionOrderId: string
  lineNo: number
  sourceOrderId: string
  sourceSalesOrderNo: string
  sourceLineNo: string
  sourceProjectNo: string | null
  targetOrderId: string
  targetSalesOrderNo: string
  targetProjectNo: string
  materialId: string
  materialCode: string
  plannedQty: string
  uom: string
  createdBy?: string | null
}

export interface ConversionOrderScanRecord {
  id: string
  conversionOrderId: string
  conversionLineId: string
  inventoryUnitId: string
  unitNo: string
  segmentLength: string | null
  customerAxisNo: string | null
  quantity: string
  reservationId: string
  scannedBy: string
  scannedAt: string
  deleted: boolean
  deletedBy: string | null
  deletedAt: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
}

export interface NewConversionOrderScan {
  conversionOrderId: string
  conversionLineId: string
  inventoryUnitId: string
  unitNo: string
  segmentLength: string | null
  customerAxisNo: string | null
  quantity: string
  reservationId: string
  scannedBy: string
  scannedAt: string
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  businessTime?: string
  createdBy?: string | null
}

/** FC-08：二维码归属变更记录（本地先执行事实——归属改为转换后订单）。 */
export interface CodeAssignmentRecord {
  id: string
  conversionOrderId: string
  conversionLineId: string
  scanId: string
  inventoryUnitId: string
  unitNo: string
  fromOrderId: string
  toOrderId: string
  assignedBy: string
  assignedAt: string
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
}

export interface NewCodeAssignment {
  conversionOrderId: string
  conversionLineId: string
  scanId: string
  inventoryUnitId: string
  unitNo: string
  fromOrderId: string
  toOrderId: string
  assignedBy: string
  assignedAt: string
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  businessTime?: string
  createdBy?: string | null
}

// ---------------- 协议B：库存转换单 ----------------

export interface ConversionStockOrderRecord {
  id: string
  conversionNo: string
  internalStatus:
    | 'pending_execute'
    | 'external_processing'
    | 'local_processing'
    | 'completed'
    | 'pending_recovery'
    | 'manual_processing'
  displayStatus: 'convert_failed' | 'sync_failed' | 'convert_success'
  externalPushStatus: 'pending' | 'unknown' | 'succeeded' | 'failed'
  localApplyStatus: 'not_applied' | 'applied' | 'failed'
  u9Success: boolean
  materialId: string
  materialCode: string
  materialName: string | null
  spec: string | null
  color: string | null
  uom: string | null
  targetProjectNo: string | null
  targetSalesOrderNo: string
  targetLineNo: string
  targetBatchNo: string
  externalDocNo: string | null
  externalFailureReason: string | null
  submitSnapshot: Record<string, unknown> | null
  completedAt: string | null
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface NewConversionStockOrder {
  conversionNo: string
  materialId: string
  materialCode: string
  materialName?: string | null
  spec?: string | null
  color?: string | null
  uom?: string | null
  targetProjectNo: string | null
  targetSalesOrderNo: string
  targetLineNo: string
  targetBatchNo: string
  submitSnapshot: Record<string, unknown>
  plantId: string
  enterpriseId: string
  businessTime?: string
  createdBy?: string | null
  commandReceiptId?: string | null
}

export interface ConversionStockLineRecord {
  id: string
  conversionStockOrderId: string
  unitNo: string
  inventoryUnitId: string
  palletCode: string | null
  quantity: string
  uom: string
  segmentLength: string
  customerAxisNo: string | null
  materialId: string
  materialCode: string
  sourceProjectNo: string | null
  sourceSalesOrderNo: string | null
  sourceLineNo: string | null
  sourceBatchNo: string | null
  sourceVirtualAxisNo: string | null
  warehouseId: string | null
  warehouseCode: string | null
  locationId: string | null
  locationCode: string | null
  released: boolean
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
}

export interface NewConversionStockLine {
  conversionStockOrderId: string
  unitNo: string
  inventoryUnitId: string
  palletCode: string | null
  quantity: string
  uom: string
  segmentLength: string
  customerAxisNo: string | null
  materialId: string
  materialCode: string
  sourceProjectNo: string | null
  sourceSalesOrderNo: string | null
  sourceLineNo: string | null
  sourceBatchNo: string | null
  sourceVirtualAxisNo: string | null
  warehouseId: string | null
  warehouseCode: string | null
  locationId: string | null
  locationCode: string | null
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  businessTime?: string
  createdBy?: string | null
}

/** FC-16：MES 改码记录（本地应用事实——不改项目号由表结构保证：无 new_project_no 列）。 */
export interface CodeRewriteRecord {
  id: string
  conversionStockOrderId: string
  conversionLineId: string
  inventoryUnitId: string
  unitNo: string
  oldSalesOrderNo: string | null
  oldLineNo: string | null
  oldBatchNo: string | null
  oldVirtualAxisNo: string | null
  newSalesOrderNo: string
  newLineNo: string
  newBatchNo: string
  newSegmentLength: string
  newCustomerAxisNo: string | null
  virtualAxisCleared: boolean
  appliedBy: string
  appliedAt: string
  commandReceiptId: string | null
  plantId: string
  enterpriseId: string
  businessTime: string
  createdAt: string
  createdBy: string | null
}

export interface NewCodeRewrite {
  conversionStockOrderId: string
  conversionLineId: string
  inventoryUnitId: string
  unitNo: string
  oldSalesOrderNo: string | null
  oldLineNo: string | null
  oldBatchNo: string | null
  oldVirtualAxisNo: string | null
  newSalesOrderNo: string
  newLineNo: string
  newBatchNo: string
  newSegmentLength: string
  newCustomerAxisNo: string | null
  virtualAxisCleared: boolean
  appliedBy: string
  appliedAt: string
  commandReceiptId?: string | null
  plantId: string
  enterpriseId: string
  businessTime?: string
  createdBy?: string | null
}

// ---------------- 跨域只读视图（生产订单/产出/主数据窄读端口） ----------------

/** 生产订单窄读视图（0005 production_order 只读；订单式转换前后锚点）。 */
export interface ProductionOrderView {
  id: string
  orderNo: string
  materialId: string
  materialCode: string | null
  salesOrderNo: string | null
  lineNo: string | null
  orderStatus: string
  plantId: string
}

/** 料品窄读视图（0003 material 只读；FC-17 成品校验）。 */
export interface ConversionMaterialView {
  id: string
  code: string
  name: string
  materialType: number
  baseUom: string
}

/** 库存单元所在库位的仓库事实（FC-17：仓库类型=仓库，不含线边仓）。 */
export interface UnitStockFacts {
  unitId: string
  unitNo: string
  materialId: string
  materialCode: string
  unitStatus: string
  quantity: string
  uomId: string
  uomCode: string
  warehouseId: string | null
  warehouseCode: string | null
  warehouseType: string | null
  locationId: string | null
  locationCode: string | null
  /** 活动托盘绑定（有托=按托汇总；null=单轴一行）。 */
  palletCode: string | null
  customerAxisNo: string | null
  salesOrderNo: string | null
  salesLineNo: string | null
  batchNo: string | null
}

// ---------------- 仓储端口 ----------------

export interface ConversionOrderRepository {
  insert(order: NewConversionOrder): Promise<ConversionOrderRecord>
  findById(id: string): Promise<ConversionOrderRecord | null>
  /** 行锁（扫码/完成/编辑/删除前锁定，防状态机并发步进）。 */
  lockById(id: string): Promise<ConversionOrderRecord | null>
  /** FC-08：完成转换落库（完成人/完成时间/时点快照 FC-S5）。 */
  markCompleted(
    id: string,
    patch: {
      completedBy: string
      completedAt: string
      completionSnapshot: Record<string, unknown>
    },
    actor: string | null,
  ): Promise<ConversionOrderRecord | null>
  /** FC-09：同步状态推进（与转换状态两列独立）。 */
  updateSyncStatus(
    id: string,
    patch: { syncStatus: ConversionOrderRecord['syncStatus'] },
    actor: string | null,
  ): Promise<ConversionOrderRecord | null>
  /** FC-06：删除主单（仅待转换无扫码；明细由处理器同事务删除）。 */
  deleteById(id: string): Promise<void>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    statuses?: string[]
    syncStatuses?: string[]
    conversionNoLike?: string
    page: number
    pageSize: number
  }): Promise<{ items: ConversionOrderRecord[]; total: number }>
}

export interface ConversionOrderLineRepository {
  insert(line: NewConversionOrderLine): Promise<ConversionOrderLineRecord>
  findById(id: string): Promise<ConversionOrderLineRecord | null>
  lockById(id: string): Promise<ConversionOrderLineRecord | null>
  listByOrder(conversionOrderId: string): Promise<ConversionOrderLineRecord[]>
  /** FC-06 编辑：已有行更新数量（按料品比对明细——已有更新数量）。 */
  updatePlannedQty(id: string, plannedQty: string, actor: string | null): Promise<ConversionOrderLineRecord | null>
  /** FC-06 编辑：去掉的行删除（仅待转换无扫码语境）。 */
  deleteById(id: string): Promise<void>
  deleteByOrder(conversionOrderId: string): Promise<void>
  /** FC-07：扫码回写实扫数量/已扫轴数（删码重算同用）。 */
  updateProgress(
    id: string,
    patch: { scannedQty: string; scannedAxes: number },
    actor: string | null,
  ): Promise<ConversionOrderLineRecord | null>
}

export interface ConversionOrderScanRepository {
  insert(scan: NewConversionOrderScan): Promise<ConversionOrderScanRecord>
  findById(id: string): Promise<ConversionOrderScanRecord | null>
  listByOrder(conversionOrderId: string): Promise<ConversionOrderScanRecord[]>
  listActiveByOrder(conversionOrderId: string): Promise<ConversionOrderScanRecord[]>
  /** 同码本单未删查重（partial unique 口径的友好前置）。 */
  findActiveByOrderAndUnitNo(conversionOrderId: string, unitNo: string): Promise<ConversionOrderScanRecord | null>
  /** FC-07 删码：标记留痕（解锁由处理器释放预留；事实列库级触发器保护）。 */
  markDeleted(
    id: string,
    patch: { deletedBy: string; deletedAt: string },
    actor: string | null,
  ): Promise<ConversionOrderScanRecord | null>
}

export interface CodeAssignmentRepository {
  insertBatch(assignments: NewCodeAssignment[]): Promise<CodeAssignmentRecord[]>
  listByOrder(conversionOrderId: string): Promise<CodeAssignmentRecord[]>
}

export interface ConversionStockOrderRepository {
  insert(order: NewConversionStockOrder): Promise<ConversionStockOrderRecord>
  findById(id: string): Promise<ConversionStockOrderRecord | null>
  lockById(id: string): Promise<ConversionStockOrderRecord | null>
  /** 链路状态机推进（FC-02 四状态列 + FC-S4 u9_success 标记；display 由域规则投影）。 */
  updateState(
    id: string,
    patch: {
      internalStatus?: ConversionStockOrderRecord['internalStatus']
      displayStatus?: ConversionStockOrderRecord['displayStatus']
      externalPushStatus?: ConversionStockOrderRecord['externalPushStatus']
      localApplyStatus?: ConversionStockOrderRecord['localApplyStatus']
      u9Success?: boolean
      externalDocNo?: string | null
      externalFailureReason?: string | null
      completedAt?: string | null
      submitSnapshot?: Record<string, unknown>
    },
    actor: string | null,
  ): Promise<ConversionStockOrderRecord | null>
  listPaged(filter: {
    plantIds: string[] | null
    plantId?: string
    displayStatuses?: string[]
    internalStatuses?: string[]
    materialCodeLike?: string
    targetSalesOrderNoLike?: string
    targetProjectNoLike?: string
    conversionNoLike?: string
    page: number
    pageSize: number
    /** FC-21：列表转换数量=全部明细数量之和、转换轴数=明细行数（SQL 聚合）。 */
    withAggregates?: boolean
  }): Promise<{
    items: Array<
      ConversionStockOrderRecord & {
        totalQty: string
        axisCount: number
      }
    >
    total: number
  }>
}

export interface ConversionStockLineRepository {
  insertBatch(lines: NewConversionStockLine[]): Promise<ConversionStockLineRecord[]>
  listByOrder(conversionStockOrderId: string): Promise<ConversionStockLineRecord[]>
  /** FC-S3/FC-18：(二维码, 物料) 未完成占用查重（排除指定单据自身——重新转换带入原单更新）。 */
  findUnfinishedByUnitAndMaterial(
    unitNo: string,
    materialId: string,
    excludeOrderId?: string,
  ): Promise<{ orderId: string; conversionNo: string } | null>
  /** FC-13④/FC-S3：完成时释放明细占用（未完成唯一失效）。 */
  markReleasedByOrder(conversionStockOrderId: string): Promise<void>
  /** 重新转换：原单明细整集替换（原单 id 更新，可改可加减明细）。 */
  deleteByOrder(conversionStockOrderId: string): Promise<void>
}

export interface CodeRewriteRepository {
  insertBatch(rewrites: NewCodeRewrite[]): Promise<CodeRewriteRecord[]>
  listByOrder(conversionStockOrderId: string): Promise<CodeRewriteRecord[]>
}

// ---------------- 0001 outbox 窄读写（同 shipping 口径） ----------------

/** 0001 outbox 表的窄读写端口（FC-S4：复合身份 聚合+任务种类；重试按快照重推）。 */
export interface ConversionOutboxTaskAccess {
  findLatestByTask(aggregateType: string, aggregateId: string, taskKind: string): Promise<{
    eventId: string
    status: string
    payload: Record<string, unknown>
    attemptCount: number
  } | null>
  countByTask(aggregateType: string, aggregateId: string, taskKind: string): Promise<number>
  markStatus(
    eventId: string,
    patch: { status: 'DISPATCHED' | 'SYNC_FAILED' | 'NOOP_NEEDED'; lastError?: string | null },
  ): Promise<void>
}

// ---------------- 跨域只读端口 ----------------

/** 生产订单只读（0005）；订单式转换前后锚点事实。 */
export interface ConversionProcessLookups {
  findProductionOrder(id: string): Promise<ProductionOrderView | null>
  /** 码归属订单反查（0008 report_output ⋈ production_report：完工入库单元 → 生产订单）。 */
  findOrderForUnit(inventoryUnitId: string): Promise<{ orderId: string } | null>
}

/** 主数据/库存只读（0003/0004）；协议B选源与校验事实。 */
export interface ConversionStockLookups {
  findMaterial(id: string): Promise<ConversionMaterialView | null>
  /** 指定料品的当前库存数量合计（活动余额；FC-17 成品库存>0）。 */
  sumMaterialStock(plantId: string, materialId: string): Promise<string>
  /** 库存单元活动余额事实（含库位仓库类型/托盘绑定/来源字段；FC-17/FC-19）。 */
  findUnitStockFacts(plantId: string, unitNo: string): Promise<UnitStockFacts | null>
  /** FC-17 左侧库存候选源（指定料品、在库、仓库类型=仓库；无托单轴/有托按托汇总）。 */
  listStockCandidates(filter: {
    plantId: string
    materialId: string
    warehouseId?: string
    unitNoLike?: string
    palletCodeLike?: string
    salesOrderNoLike?: string
    batchNoLike?: string
    customerAxisNoLike?: string
  }): Promise<
    Array<{
      groupKind: 'axis' | 'pallet'
      productAxisNo: string | null
      palletCode: string | null
      quantity: string
      uom: string
      axisCount: number
      materialId: string
      materialCode: string
      customerAxisNo: string | null
      salesOrderNo: string | null
      lineNo: string | null
      batchNo: string | null
      warehouseCode: string | null
      locationCode: string | null
    }>
  >
}

// ---------------- 命令工具集 ----------------

/** conversionform 域仓储集合。 */
export interface ConversionRepositories {
  orders: ConversionOrderRepository
  orderLines: ConversionOrderLineRepository
  orderScans: ConversionOrderScanRepository
  assignments: CodeAssignmentRepository
  stockOrders: ConversionStockOrderRepository
  stockLines: ConversionStockLineRepository
  rewrites: CodeRewriteRepository
  outboxTasks: ConversionOutboxTaskAccess
  process: ConversionProcessLookups
  stock: ConversionStockLookups
}

/**
 * conversionform 命令工具集：InventoryCommandTools 超集（扫码锁定/源库存预留复用
 * inventory 仓储束与预留机制 IT-23——通过端口注入、同 UoW），追加 conversion 仓储束。
 */
export interface ConversionCommandTools extends InventoryCommandTools {
  conversion: ConversionRepositories
}
