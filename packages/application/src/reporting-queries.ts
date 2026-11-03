import type { PageResult } from '@cadenza/contracts'
import type {
  AxisQueryRowDto,
  MetricDefinitionDto,
  PdaCumulativeDto,
  ReportCaliberTotalsDto,
  ReportSelectionSummaryDto,
  ShiftSnapshotDto,
  StockStatRowDto,
  TraceResultDto,
} from '@cadenza/contracts'
import {
  AXIS_FINISHED_ABNORMAL_LABELS,
  AXIS_INBOUND_STATUS_LABELS,
  AXIS_LOCK_STATUS_LABELS,
  AXIS_QC_STATUS_LABELS,
  AXIS_REPORT_STATUS_LABELS,
  AXIS_SALE_STATUS_LABELS,
  AXIS_STATUS_LABELS,
  AXIS_SUSPECT_STATUS_LABELS,
  FINISHED_ENTRY_LABELS,
  LEGACY_STOCK_STATUS_LABELS,
  METRIC_FAMILY_LABELS,
  PDA_CALIBERS,
  REPORT_CALIBERS,
  feetDisplay,
  matchesCaliber,
  pickCaliberQuantity,
  summarizeReportTotals,
  summarizeSelection,
  type ReportOutputQtyRow,
  type SelectableQtyRow,
} from '@cadenza/domain'
import type { VerifiedAuthContext } from './session-verifier'
import type { OrgNodeRepository } from './repositories'
import type {
  AxisQueryFilter,
  AxisQueryRepository,
  ExportAuditWriter,
  MetricDefinitionRepository,
  ReportSummaryFilter,
  ReportSummaryRepository,
  ReportOutputRow,
  ShiftSnapshotFilter,
  ShiftSnapshotRepository,
  StockStatFilter,
  StockStatProjectionRepository,
  TraceRepository,
} from './reporting-repositories'

/**
 * reporting 域查询服务（读侧，池连接只读；许可由 HTTP 守卫首检，数据范围在本服务内
 * 按授权上下文服务端过滤——OA-24/25，与 shipping 查询同口径）。
 *
 * RP-06/RP-10/RP-15：导出与列表/查询同条件同数据范围执行（同一方法，export 标记仅追加
 * 审计行）；RP-S4：导出与查询共用同一范围校验路径，导出记审计行。
 */

export interface ReportingQueryDeps {
  projections: StockStatProjectionRepository
  axis: AxisQueryRepository
  reports: ReportSummaryRepository
  definitions: MetricDefinitionRepository
  snapshots: ShiftSnapshotRepository
  trace: TraceRepository
  exports: ExportAuditWriter
  org: OrgNodeRepository
}

function toPageRequest(query: { page?: unknown; pageSize?: unknown }): { page: number; pageSize: number } {
  const page = typeof query.page === 'number' && Number.isInteger(query.page) && query.page >= 1 ? query.page : 1
  const pageSize =
    typeof query.pageSize === 'number' && Number.isInteger(query.pageSize) && query.pageSize >= 1
      ? Math.min(query.pageSize, 100)
      : 20
  return { page, pageSize }
}

const like = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const CALIBER_LABELS: Readonly<Record<string, string>> = {
  draft: '草稿量',
  submitted: '提交量',
  approved: '审核量',
  qualified: '合格量',
  stocked: '入库量',
}

const PDA_CALIBER_LABELS: Readonly<Record<string, string>> = {
  draft: '草稿口径',
  submitted: '提交口径',
  approved: '审核口径',
}

export class ReportingQueryService {
  constructor(private readonly deps: ReportingQueryDeps) {}

  /** 数据范围折算：企业范围 → null（不过滤）；否则限定授权工厂集合。 */
  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  private async exportAudit(
    actor: string,
    reportKind: string,
    filter: Record<string, unknown>,
    rowCount: number,
    plantId?: string | null,
  ): Promise<void> {
    await this.deps.exports.recordExport({
      actor,
      reportKind,
      filterDigest: JSON.stringify(filter),
      rowCount,
      plantId: plantId ?? null,
    })
  }

  // ---------------- 库存统计（RP-01~RP-07） ----------------

  /** 库存统计列表（RP-06：导出与列表同一套筛选与展示规则——export=true 时全量口径+审计行）。 */
  async listStockStats(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      unitNoLike?: string
      customerAxisLike?: string
      stockStatus?: string
      finishedEntryStatus?: 'entered_warehouse' | 'not_entered'
      export?: boolean
      page?: number
      pageSize?: number
    },
  ): Promise<PageResult<StockStatRowDto>> {
    const pageRequest = toPageRequest(query)
    const filter: StockStatFilter = {
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      unitNoLike: like(query.unitNoLike),
      customerAxisLike: like(query.customerAxisLike),
      stockStatus: like(query.stockStatus),
      finishedEntryStatus: query.finishedEntryStatus,
      ...pageRequest,
    }
    const page = await this.deps.projections.listPaged(filter)
    if (query.export === true) {
      await this.exportAudit(auth.user.loginName, 'stock-stat', { ...query, page: 1, pageSize: 'ALL' }, page.total, query.plantId)
    }
    return { items: page.items, total: page.total, ...pageRequest }
  }

  /** 勾选汇总（RP-05：服务端全量聚合，不依赖已加载分页；未勾选时总量为 0）。 */
  async selectionSummary(
    auth: VerifiedAuthContext,
    ids: readonly string[],
  ): Promise<ReturnType<typeof summarizeSelection>> {
    if (ids.length === 0) return summarizeSelection([])
    const rows = await this.deps.projections.listByIds(ids)
    // 范围过滤：越权 id 行不参与聚合（服务端数据范围二道防线）
    const scope = this.plantScope(auth)
    const visible = scope === null ? rows : rows.filter((r) => scope.includes(r.plantId))
    return summarizeSelection(
      visible.map((r): SelectableQtyRow => ({ quantity: r.quantity, uomCode: r.uomCode })),
    )
  }

  // ---------------- 轴查询（RP-08~RP-11） ----------------

  /** 轴查询（RP-10：导出与列表同一套筛选；RP-09：报工状态筛选不含采购来源轴）。 */
  async listAxisQuery(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      unitNoLike?: string
      warehouseName?: string
      carrierLike?: string
      inboundStatus?: string
      qcStatus?: string
      saleStatus?: string
      salesOrderNoLike?: string
      orderNoLike?: string
      reporterLike?: string
      customerAxisLike?: string
      reportStatus?: string
      reportedFrom?: string
      reportedTo?: string
      workshopName?: string
      export?: boolean
      page?: number
      pageSize?: number
    },
  ): Promise<PageResult<AxisQueryRowDto>> {
    const pageRequest = toPageRequest(query)
    const filter: AxisQueryFilter = {
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      unitNoLike: like(query.unitNoLike),
      warehouseName: like(query.warehouseName),
      carrierLike: like(query.carrierLike),
      inboundStatus: like(query.inboundStatus),
      qcStatus: like(query.qcStatus),
      saleStatus: like(query.saleStatus),
      salesOrderNoLike: like(query.salesOrderNoLike),
      orderNoLike: like(query.orderNoLike),
      reporterLike: like(query.reporterLike),
      customerAxisLike: like(query.customerAxisLike),
      reportStatus: like(query.reportStatus),
      reportedFrom: like(query.reportedFrom),
      reportedTo: like(query.reportedTo),
      workshopName: like(query.workshopName),
      ...pageRequest,
    }
    const page = await this.deps.axis.listPaged(filter)
    if (query.export === true) {
      await this.exportAudit(auth.user.loginName, 'axis-query', { ...query, page: 1, pageSize: 'ALL' }, page.total, query.plantId)
    }
    return { items: page.items, total: page.total, ...pageRequest }
  }

  // ---------------- 报工记录汇总（RP-12~RP-17） ----------------

  /**
   * 口径分层汇总（RP-16）：草稿/提交/审核/合格/入库逐口径展示，不混成一个完成量；
   * RP-17 服务端全量聚合。caliber+勾选：reportIds 提供时仅聚合勾选单（RP-12 Web 汇总行）。
   */
  async reportSummaryByCaliber(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      orderNoLike?: string
      dateFrom?: string
      dateTo?: string
      reportIds?: readonly string[] | null
    },
  ): Promise<ReportCaliberTotalsDto[]> {
    const filter: ReportSummaryFilter = {
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      orderNoLike: like(query.orderNoLike),
      dateFrom: like(query.dateFrom),
      dateTo: like(query.dateTo),
      reportIds: query.reportIds ?? null,
    }
    const rows = await this.deps.reports.listOutputRows(filter)
    const selected = query.reportIds === undefined || query.reportIds === null ? rows : filterByIds(rows, query.reportIds)
    return REPORT_CALIBERS.map((caliber) => {
      const caliberRows = selected.filter((r) => matchesCaliber(r, caliber))
      // RP-16：qualified 口径取合格数量列，其余口径取产出数量列
      const qtyColumn = pickCaliberQuantity(caliber)
      const totals = summarizeReportTotals(groupedByReport(caliberRows).map((rs) => rs.map((r) => toReportOutputQtyRow(r, qtyColumn))))
      return {
        caliber,
        caliberLabel: CALIBER_LABELS[caliber] ?? caliber,
        groups: totals.groups,
        axisCount: totals.totalAxisCount,
      }
    })
  }

  /** Web 汇总行（RP-12）：勾选行报工总量按生产单位 + 报工总轴数 + 英尺汇总列（RP-03 随行）。 */
  async reportSelectionSummary(
    auth: VerifiedAuthContext,
    reportIds: readonly string[],
    query: { plantId?: string; orderNoLike?: string; dateFrom?: string; dateTo?: string } = {},
  ): Promise<ReportSelectionSummaryDto> {
    const rows = await this.deps.reports.listOutputRows({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      orderNoLike: like(query.orderNoLike),
      dateFrom: like(query.dateFrom),
      dateTo: like(query.dateTo),
      reportIds: null,
    })
    const selected = filterByIds(rows, reportIds)
    const totals = summarizeReportTotals(groupedByReport(selected).map((rs) => rs.map((r) => toReportOutputQtyRow(r, 'quantity'))))
    // RP-03：英尺汇总列（生产单位为米的组提供，其余组不提供）
    const feetGroups =
      totals.groups.length === 0
        ? null
        : totals.groups.flatMap((g) => {
            const feet = feetDisplay(g.totalQuantity, g.uomCode)
            return feet === null ? [] : [{ uomCode: g.uomCode, feetQuantity: feet }]
          })
    return {
      caliber: 'submitted',
      caliberLabel: '报工总量（勾选）',
      groups: totals.groups,
      axisCount: totals.totalAxisCount,
      feetGroups,
    }
  }

  /**
   * PDA 累计报工（RP-13/K16 目标口径）：草稿/提交/审核分开统计、排除历史导入、
   * 精准订单身份；部门范围含下级（deptId → org path 前缀）；仅操作工角色时只算自己参与的
   * （operatorOnly 由调用方按角色判定传入 actor 自身 id）。
   */
  async pdaCumulative(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      deptId?: string
      orderNo?: string
      /** 仅操作工角色：只算自己参与（服务端以会话身份强制，不信客户端） */
      operatorOnly?: boolean
    },
  ): Promise<PdaCumulativeDto[]> {
    let deptPathPrefix: string | null = null
    if (query.deptId !== undefined && query.deptId !== '') {
      const node = await this.deps.org.findById(query.deptId)
      if (node !== null) deptPathPrefix = node.path
    }
    const rows = await this.deps.reports.listPdaRows({
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      deptPathPrefix,
      operatorUserId: query.operatorOnly === true ? auth.user.id : null,
    })
    const nonHistorical = rows.filter((r) => !r.historicalImport)
    const excludedHistoricalRows = rows.length - nonHistorical.length
    return PDA_CALIBERS.map((caliber) => {
      const caliberRows = nonHistorical.filter((r) => matchesCaliber(r, caliber))
      const totals = summarizeReportTotals(groupedByReport(caliberRows).map((rs) => rs.map((r) => toReportOutputQtyRow(r, 'quantity'))))
      return {
        caliber,
        caliberLabel: PDA_CALIBER_LABELS[caliber] ?? caliber,
        groups: totals.groups,
        excludedHistoricalRows,
      }
    })
  }

  // ---------------- 指标定义与班次快照（RP-18~RP-21 读侧） ----------------

  async listMetricDefinitions(): Promise<MetricDefinitionDto[]> {
    return this.deps.definitions.listAll()
  }

  async listShiftSnapshots(
    auth: VerifiedAuthContext,
    query: {
      plantId?: string
      shiftDateFrom?: string
      shiftDateTo?: string
      metricKeys?: string[]
      statuses?: string[]
      page?: number
      pageSize?: number
    },
  ): Promise<PageResult<ShiftSnapshotDto>> {
    const pageRequest = toPageRequest(query)
    const filter: ShiftSnapshotFilter = {
      plantIds: this.plantScope(auth),
      plantId: query.plantId,
      shiftDateFrom: like(query.shiftDateFrom),
      shiftDateTo: like(query.shiftDateTo),
      metricKeys: query.metricKeys,
      statuses: query.statuses,
      ...pageRequest,
    }
    const page = await this.deps.snapshots.listPaged(filter)
    return { items: page.items, total: page.total, ...pageRequest }
  }

  // ---------------- 追溯查询（RP-22 / IT-35） ----------------

  /**
   * 正反向追溯（原料→交付轴 / 交付轴→原料），含工序/设备/人员/检验引用。
   * 根单元按数据范围过滤（plant 范围用户只能以本厂单元为根；谱系链上跨厂节点随链展示）。
   */
  async trace(
    auth: VerifiedAuthContext,
    args: { unitId?: string; unitNo?: string; direction: 'forward' | 'backward' },
  ): Promise<TraceResultDto | null> {
    const result = await this.deps.trace.trace({
      unitId: args.unitId,
      unitNo: args.unitNo,
      direction: args.direction,
      plantIds: this.plantScope(auth),
      enterpriseId: auth.user.enterpriseId,
      maxDepth: 16,
    })
    return result
  }
}

function filterByIds(rows: readonly ReportOutputRow[], ids: readonly string[]): ReportOutputRow[] {
  const wanted = new Set(ids)
  return rows.filter((r) => wanted.has(r.reportId))
}

/** RP-12：按报工单分组（summarizeReportTotals 以"单"为轴数去重单位——轴数=各单内不重复轴号之和）。 */
function groupedByReport(rows: readonly ReportOutputRow[]): ReportOutputRow[][] {
  const byReport = new Map<string, ReportOutputRow[]>()
  for (const row of rows) {
    const bucket = byReport.get(row.reportId)
    if (bucket === undefined) byReport.set(row.reportId, [row])
    else bucket.push(row)
  }
  return [...byReport.values()]
}

function toReportOutputQtyRow(r: ReportOutputRow, qtyColumn: 'quantity' | 'qualified_qty'): ReportOutputQtyRow {
  const quantity = qtyColumn === 'qualified_qty' ? (r.qualifiedQty ?? '0.0000') : r.quantity
  return { quantity, qualifiedQty: r.qualifiedQty, uomCode: r.uomCode, unitNo: r.unitNo }
}

// 供 persistence 映射层复用的标签字典集中导出（视图标签统一口径）
export const REPORTING_LABELS = {
  axisInbound: AXIS_INBOUND_STATUS_LABELS,
  axisLock: AXIS_LOCK_STATUS_LABELS,
  axisQc: AXIS_QC_STATUS_LABELS,
  axisReport: AXIS_REPORT_STATUS_LABELS,
  axisSale: AXIS_SALE_STATUS_LABELS,
  axisSuspect: AXIS_SUSPECT_STATUS_LABELS,
  axisFinishedAbnormal: AXIS_FINISHED_ABNORMAL_LABELS,
  finishedEntry: FINISHED_ENTRY_LABELS,
  legacyStock: LEGACY_STOCK_STATUS_LABELS,
  axisStatus: AXIS_STATUS_LABELS,
  metricFamily: METRIC_FAMILY_LABELS,
} as const
