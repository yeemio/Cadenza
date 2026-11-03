import {
  ReworkRuleViolation,
  assertCorrectionScannable,
  assertReelSplitSourceScannable,
  buildCorrectionOptions,
  mergePalletExportRows,
  type CorrectionOption,
} from '@cadenza/domain'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  AxisRetireRepository,
  AxisNoRepository,
  PalletTaskRepository,
  ReelSplitRepository,
  ReworkFactsLookup,
  ReelSplitSourceRow,
  CorrectionScanRow,
} from './rework-repositories'

/**
 * rework 域查询服务（读侧，池连接只读；许可由 HTTP 守卫首检，数据范围按授权上下文
 * 服务端过滤——与 shipping/reverse 查询同口径）。
 * RS-25：轴号修正扫码只查询不改数据；RS-03 倒出轴扫码同属前端会话模型（RS-06：
 * 提交时统一校验，不落进行中单据）；RS-24：分托导出按导出那一刻绑定取数。
 */

export interface ReworkQueryDeps {
  reelSplits: ReelSplitRepository
  palletTasks: PalletTaskRepository
  axisNo: AxisNoRepository
  retires: AxisRetireRepository
  facts: ReworkFactsLookup
}

/** 本域分页视图（total/page/pageSize + pageCount；items 各查询自带行型）。 */
export interface Paged {
  total: number
  page: number
  pageSize: number
  pageCount: number
}

function pageOf(total: number, page: number, pageSize: number): Paged {
  return { total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) }
}

/** RS-03/04/06：倒出轴扫码查询（只读；返回同码合计数量作为倒出量基数）。 */
export async function reelSplitSourceScan(
  deps: ReworkQueryDeps,
  plantId: string,
  unitNo: string,
): Promise<{
  unitNo: string
  balanceQty: string
  materialCode: string
  customerAxisNo: string | null
  segmentLength: string | null
  requireFullPour: boolean
  requireSingleLine: boolean
}> {
  const row: ReelSplitSourceRow = await deps.facts.reelSplitSourceRow(plantId, unitNo)
  assertReelSplitSourceScannable({
    unitNo: row.unitNo,
    exists: row.exists,
    isPalletCode: row.isPalletCode,
    locked: row.locked,
    qualityPending: row.qualityPending,
    reportUnreviewed: row.reportUnreviewed,
    anomalyOpen: row.anomalyOpen,
    inLogisticsWarehouse: row.inLogisticsWarehouse,
    multiMaterial: row.multiMaterial,
    balanceQty: row.balanceQty,
    materialId: row.materialId,
    materialCode: row.materialCode,
    customerAxisNo: row.customerAxisNo,
    segmentLength: row.segmentLength,
  })
  const hasCustomerIdentity = row.customerAxisNo !== null || row.segmentLength !== null
  return {
    unitNo: row.unitNo,
    balanceQty: row.balanceQty,
    materialCode: row.materialCode,
    customerAxisNo: row.customerAxisNo,
    segmentLength: row.segmentLength,
    requireFullPour: hasCustomerIdentity,
    requireSingleLine: hasCustomerIdentity,
  }
}

/** RS-08：Web 倒轴记录 = 主表＋明细展开的只读查询（无新增/编辑/删除入口）。 */
export async function reelSplitRecords(
  deps: ReworkQueryDeps,
  auth: VerifiedAuthContext,
  page: number,
  pageSize: number,
): Promise<Paged & {
  items: Array<{
    id: string
    orderNo: string
    sourceUnitNo: string
    originalQty: string
    retainedQty: string
    /** 剩余数量 = 原数量 − 该主单全部倒入合计（同主单多行数值相同） */
    remainQty: string
    lossQty: string
    materialCode: string
    orderRef: string | null
    splitBy: string
    splitAt: string
    reversed: boolean
    lines: Array<{ lineNo: number; targetUnitNo: string; quantity: string }>
  }>
}> {
  const plantIds = auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  const { items, total } = await deps.reelSplits.listPaged({
    enterpriseId: auth.user.enterpriseId,
    plantIds,
    page,
    pageSize,
  })
  const detailed = await Promise.all(
    items.map(async (order) => {
      const lines = await deps.reelSplits.listLines(order.id)
      const pourTotal = lines.reduce((acc, l) => (Number(acc) + Number(l.quantity)).toFixed(4), '0.0000')
      return {
        id: order.id,
        orderNo: order.orderNo,
        sourceUnitNo: order.sourceUnitNo,
        originalQty: order.originalQty,
        retainedQty: order.retainedQty,
        remainQty: pourTotal === '' ? order.originalQty : (Number(order.originalQty) - Number(pourTotal)).toFixed(4),
        lossQty: order.lossQty,
        materialCode: order.materialCode,
        orderRef: order.orderRef,
        splitBy: order.splitBy,
        splitAt: order.splitAt,
        reversed: order.status === 'reversed',
        lines: lines.map((l) => ({ lineNo: l.lineNo, targetUnitNo: l.targetUnitNo, quantity: l.quantity })),
      }
    }),
  )
  return { ...pageOf(total, page, pageSize), items: detailed }
}

/** RS-14：再次进入自动带出进行中单据（PDA 侧；Web 不展示进行中）。 */
export async function palletCurrentTask(
  deps: ReworkQueryDeps,
  operatorLoginName: string,
  taskType: 'split_pallet' | 'unbind_pallet',
): Promise<{
  taskId: string
  taskNo: string
  status: string
  targetCarrierCode: string | null
  warehouseCode: string | null
  rackCode: string | null
  locationCode: string | null
  lines: Array<{ unitNo: string; originalCarrierCode: string | null; originalWarehouseCode: string | null; originalLocationCode: string | null; scannedAt: string }>
}> {
  const task = await deps.palletTasks.findInProgress(operatorLoginName, taskType)
  if (task === null) {
    throw new ReworkRuleViolation('RS-14', '当前无进行中的该类型分托任务')
  }
  const lines = (await deps.palletTasks.listLines(task.id, false)).filter((l) => l.removedAt === null)
  return {
    taskId: task.id,
    taskNo: task.taskNo,
    status: task.status,
    targetCarrierCode: task.targetCarrierCode,
    warehouseCode: task.warehouseCode,
    rackCode: task.rackCode,
    locationCode: task.locationCode,
    lines: lines.map((l) => ({
      unitNo: l.unitNo,
      originalCarrierCode: l.originalCarrierCode,
      originalWarehouseCode: l.originalWarehouseCode,
      originalLocationCode: l.originalLocationCode,
      scannedAt: l.scannedAt,
    })),
  }
}

/** RS-S3/RS-20：Web 只展示已完成记录（进行中的不展示）。 */
export async function palletCompletedRecords(
  deps: ReworkQueryDeps,
  auth: VerifiedAuthContext,
  args: { taskType?: 'split_pallet' | 'unbind_pallet'; operator?: string; page: number; pageSize: number },
): Promise<Paged & {
  items: Array<{
    id: string
    taskNo: string
    taskType: string
    operator: string
    targetCarrierCode: string | null
    warehouseOfRecord: string | null
    firstScanAt: string
    completedAt: string | null
  }>
}> {
  const plantIds = auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  const { items, total } = await deps.palletTasks.listCompletedPaged({
    enterpriseId: auth.user.enterpriseId,
    plantIds,
    taskType: args.taskType,
    operator: args.operator,
    page: args.page,
    pageSize: args.pageSize,
  })
  return {
    ...pageOf(total, args.page, args.pageSize),
    items: items.map((t) => ({
      id: t.id,
      taskNo: t.taskNo,
      taskType: t.taskType,
      operator: t.operator,
      targetCarrierCode: t.targetCarrierCode,
      warehouseOfRecord: t.warehouseOfRecord,
      firstScanAt: t.firstScanAt,
      completedAt: t.completedAt,
    })),
  }
}

/**
 * RS-24 分托导出：按当前搜索条件取已完成记录的分入托码（去重去空），导出导出那一刻
 * 绑定在这些托码上的全部料品码（非历史快照）；同一托码下同产品轴号同料品合并一行、
 * 数量相加。
 */
export async function palletExport(
  deps: ReworkQueryDeps,
  auth: VerifiedAuthContext,
  plantId: string,
  args: { taskType?: 'split_pallet' | 'unbind_pallet'; operator?: string; page: number; pageSize: number },
): Promise<{ rows: Array<{ carrierCode: string; productAxisNo: string | null; materialCode: string; quantity: string; unitCount: number }> }> {
  const plantIds = auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  const { items } = await deps.palletTasks.listCompletedPaged({
    enterpriseId: auth.user.enterpriseId,
    plantIds,
    taskType: args.taskType ?? 'split_pallet',
    operator: args.operator,
    page: args.page,
    pageSize: args.pageSize,
  })
  const carrierCodes = [...new Set(items.map((t) => t.targetCarrierCode ?? '').filter((c) => c !== ''))]
  if (carrierCodes.length === 0) return { rows: [] }
  const rawRows = await deps.facts.palletExportRows(plantId, carrierCodes)
  const merged = mergePalletExportRows(
    rawRows.map((r) => ({ carrierCode: r.carrierCode, productAxisNo: r.productAxisNo, materialCode: r.materialCode, quantity: r.quantity })),
  )
  const unitCount = new Map<string, number>()
  for (const r of rawRows) {
    unitCount.set(r.carrierCode, (unitCount.get(r.carrierCode) ?? 0) + 1)
  }
  return {
    rows: merged.map((r) => ({
      carrierCode: r.carrierCode,
      productAxisNo: r.productAxisNo,
      materialCode: r.materialCode,
      quantity: r.quantity,
      unitCount: unitCount.get(r.carrierCode) ?? 0,
    })),
  }
}

/** RS-25/26：轴号修正扫码查询（只查询不改数据；返回可选新轴号列表）。 */
export async function correctionScan(
  deps: ReworkQueryDeps,
  plantId: string,
  unitNo: string,
): Promise<{
  unitNo: string
  currentQty: string
  maxSingleReportQty: string
  customerAxisNo: string | null
  segmentLength: string | null
  virtualAxisNo: string | null
  options: CorrectionOption[]
  materialPrimaryUomCode: string | null
}> {
  const row: CorrectionScanRow = await deps.facts.correctionScanRow(plantId, unitNo)
  assertCorrectionScannable({
    qrPassed: true,
    unitNo,
    exists: row.exists,
    isPalletCode: row.isPalletCode,
    multiMaterial: row.multiMaterial,
    inLogisticsWarehouse: row.inLogisticsWarehouse,
    sold: row.sold,
    qualityPending: row.qualityPending,
    reportUnreviewed: row.reportUnreviewed,
    anomalyOpen: row.anomalyOpen,
    locked: row.locked,
    hasOrder: row.hasOrder,
    transitAxisPending: row.transitAxisPending,
  })
  const state = row.unitId !== null ? await deps.axisNo.getState(row.unitId) : null
  const orderStates = row.salesOrderNo !== null ? await deps.axisNo.listByOrder(row.salesOrderNo) : []
  const options = row.unitId !== null ? buildCorrectionOptions(orderStates, row.unitId) : []
  return {
    unitNo,
    currentQty: row.currentQty ?? '0.0000',
    maxSingleReportQty: row.maxSingleReportQty,
    customerAxisNo: state?.customerAxisNo ?? null,
    segmentLength: state?.segmentLength ?? null,
    virtualAxisNo: state?.virtualAxisNo ?? null,
    options,
    materialPrimaryUomCode: row.materialPrimaryUomCode,
  }
}

/** RS-S5/RS-32：修正记录列表（含已撤销；回撤入口按状态与权限）。 */
export async function correctionRecords(
  deps: ReworkQueryDeps,
  auth: VerifiedAuthContext,
  page: number,
  pageSize: number,
): Promise<Paged & {
  items: Array<{
    id: string
    correctionNo: string
    targetUnitNo: string
    beforeCustomerAxisNo: string | null
    afterCustomerAxisNo: string | null
    originalQty: string
    cutQty: string
    newQty: string
    status: string
    correctedBy: string
    correctedAt: string
    withdrawnAt: string | null
  }>
}> {
  const plantIds = auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  const { items, total } = await deps.axisNo.listCorrectionsPaged({
    enterpriseId: auth.user.enterpriseId,
    plantIds,
    page,
    pageSize,
  })
  return {
    ...pageOf(total, page, pageSize),
    items: items.map((c) => ({
      id: c.id,
      correctionNo: c.correctionNo,
      targetUnitNo: c.targetUnitNo,
      beforeCustomerAxisNo: c.beforeCustomerAxisNo,
      afterCustomerAxisNo: c.afterCustomerAxisNo,
      originalQty: c.originalQty,
      cutQty: c.cutQty,
      newQty: c.newQty,
      status: c.status,
      correctedBy: c.correctedBy,
      correctedAt: c.correctedAt,
      withdrawnAt: c.withdrawnAt,
    })),
  }
}

/** RS-35：Web 清空记录可查（退役档案保留）。 */
export async function retireRecords(
  deps: ReworkQueryDeps,
  auth: VerifiedAuthContext,
  page: number,
  pageSize: number,
): Promise<Paged & {
  items: Array<{
    id: string
    retireNo: string
    unitNo: string
    qtyBefore: string
    productionDept: string | null
    productionOrderNo: string | null
    salesOrderNo: string | null
    materialCode: string
    processName: string | null
    reportBy: string | null
    retiredBy: string
    retiredAt: string
  }>
}> {
  const plantIds = auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  const { items, total } = await deps.retires.listRecordsPaged({
    enterpriseId: auth.user.enterpriseId,
    plantIds,
    page,
    pageSize,
  })
  return {
    ...pageOf(total, page, pageSize),
    items: items.map((r) => ({
      id: r.id,
      retireNo: r.retireNo,
      unitNo: r.unitNo,
      qtyBefore: r.qtyBefore,
      productionDept: r.productionDept,
      productionOrderNo: r.productionOrderNo,
      salesOrderNo: r.salesOrderNo,
      materialCode: r.materialCode,
      processName: r.processName,
      reportBy: r.reportBy,
      retiredBy: r.retiredBy,
      retiredAt: r.retiredAt,
    })),
  }
}

/**
 * rework 查询服务（组合根注入池连接仓储；方法委托上方纯函数——同 ReverseQueryService
 * 的类包装模式，供 api 层 controller 消费）。
 */
export class ReworkQueryService {
  constructor(private readonly deps: ReworkQueryDeps) {}

  /** RS-03/04/06：倒出轴扫码查询（只读）。 */
  reelSplitSourceScan(plantId: string, unitNo: string) {
    return reelSplitSourceScan(this.deps, plantId, unitNo)
  }

  /** RS-08：Web 倒轴记录。 */
  reelSplitRecords(auth: VerifiedAuthContext, page: number, pageSize: number) {
    return reelSplitRecords(this.deps, auth, page, pageSize)
  }

  /** RS-14：进行中单据带出。 */
  palletCurrentTask(operatorLoginName: string, taskType: 'split_pallet' | 'unbind_pallet') {
    return palletCurrentTask(this.deps, operatorLoginName, taskType)
  }

  /** RS-S3/RS-20：已完成记录。 */
  palletCompletedRecords(
    auth: VerifiedAuthContext,
    args: { taskType?: 'split_pallet' | 'unbind_pallet'; operator?: string; page: number; pageSize: number },
  ) {
    return palletCompletedRecords(this.deps, auth, args)
  }

  /** RS-24：分托导出。 */
  palletExport(
    auth: VerifiedAuthContext,
    plantId: string,
    args: { taskType?: 'split_pallet' | 'unbind_pallet'; operator?: string; page: number; pageSize: number },
  ) {
    return palletExport(this.deps, auth, plantId, args)
  }

  /** RS-25/26：修正扫码查询。 */
  correctionScan(plantId: string, unitNo: string) {
    return correctionScan(this.deps, plantId, unitNo)
  }

  /** RS-S5/RS-32：修正记录列表。 */
  correctionRecords(auth: VerifiedAuthContext, page: number, pageSize: number) {
    return correctionRecords(this.deps, auth, page, pageSize)
  }

  /** RS-35：清空记录列表。 */
  retireRecords(auth: VerifiedAuthContext, page: number, pageSize: number) {
    return retireRecords(this.deps, auth, page, pageSize)
  }
}
