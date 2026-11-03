import type { PageResult } from '@cadenza/contracts'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  ExecutionRepositories,
  ExecutionSessionRecord,
  ProductionReportRecord,
  ReportOutputRecord,
  MaterialConsumptionRecord,
  ScheduleReadPort,
} from './execution-repositories'
import type { ProcessRepositories } from './process-repositories'
// L0 整合步（Wave5）：domain index 已导出 './execution'；改包名导入（原 dist 相对导入 + eslint-disable 删除）。
import { computeFiveQuantities, computeOperationReadiness, resolveLastNonQcOperation, EXECUTION_PERMISSIONS } from '@cadenza/domain'

/**
 * execution 域查询服务（池连接只读）。
 *
 * 数据范围口径（[底稿 A6/D4/K09]）：操作工仅自己参与（无 execution.review 时查询限定本人）；
 * 班组长/厂区按授权厂范围（enterpriseWide 或 plantIds 过滤）。五量查询（[底稿 A5-3]）是
 * 展示口径的唯一来源——禁止任何单一「完成数量」混口径展示。
 */

export interface ExecutionQueryDeps {
  execution: ExecutionRepositories
  process: ProcessRepositories
  schedule?: ScheduleReadPort
  /** 质检部门清单（与命令侧同一注入源，就绪/五量视图的质检判定）。 */
  qcDeptIds?: string[]
}

interface ScopedFilter {
  plantIds: string[] | null
  operatorUserId?: string
}

/** 数据范围 + 操作工仅自己（D4/K09：列表/角标/详情同一口径）。 */
function scopedFilter(auth: VerifiedAuthContext, requestedOperator?: string): ScopedFilter {
  const reviewer = auth.permissions.includes(EXECUTION_PERMISSIONS.review)
  const scope = auth.dataScope
  const plantIds = scope.enterpriseWide ? null : scope.plantIds
  if (!reviewer) {
    return { plantIds, operatorUserId: auth.user.id }
  }
  return { plantIds, operatorUserId: requestedOperator }
}

export interface DraftView {
  sessionId: string
  reportId: string | null
  orderId: string
  source: string
  orderOperationId: string | null
  operationSeq: number | null
  operatorUserId: string
  operatorLogin: string
  shiftDate: string
  businessTime: string
  remark: string | null
  draftFeeds: unknown[]
  /** 草稿续作锁工序（[底稿 A6-2]：已有产出的草稿工序不可改）。 */
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

export interface ReportDetailView {
  report: ProductionReportRecord
  outputs: ReportOutputRecord[]
  feeds: MaterialConsumptionRecord[]
  reviewCancelled: boolean
}

export interface OrderQuantitiesView {
  orderId: string
  orderNo: string
  uom: string
  total: { draftQty: string; submittedQty: string; approvedQty: string; qualifiedQty: string; stockedQty: string }
  operations: Array<{
    orderOperationId: string
    seq: number
    operationName: string
    isQc: boolean
    isLastNonQc: boolean
    quantities: { draftQty: string; submittedQty: string; approvedQty: string; qualifiedQty: string; stockedQty: string }
    /** 工序就绪判定（三入口共用单一服务端规则，K13）。 */
    ready: boolean
    readyReason: string
  }>
}

export class ExecutionQueryService {
  constructor(private readonly deps: ExecutionQueryDeps) {}

  private get qcDeptIds(): string[] {
    // 查询侧就绪/质检判定配置与命令侧一致由组合根保证（同一注入源）；缺省空清单=无质检工序口径。
    return this.deps.qcDeptIds ?? []
  }

  /** 草稿列表（主页「N条报工待提交」+ 三入口草稿隔离视图）。 */
  async listDrafts(
    auth: VerifiedAuthContext,
    query: { orderId?: string; source?: string; operatorUserId?: string; page?: number; pageSize?: number },
  ): Promise<PageResult<DraftView>> {
    const filter = scopedFilter(auth, query.operatorUserId)
    const sessions = await this.deps.execution.sessions.list({
      enterpriseId: auth.user.enterpriseId,
      plantIds: filter.plantIds,
      orderId: query.orderId,
      operatorUserId: filter.operatorUserId,
      source: query.source as ExecutionSessionRecord['source'] | undefined,
      status: 'open',
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    })
    const items: DraftView[] = []
    for (const session of sessions.items) {
      const report = await this.deps.execution.reports.findBySessionId(session.id)
      const outputs =
        report === null
          ? []
          : await this.deps.execution.outputs.listByReport(report.id)
      items.push({
        sessionId: session.id,
        reportId: report?.id ?? null,
        orderId: session.orderId,
        source: session.source,
        orderOperationId: session.orderOperationId,
        operationSeq: session.operationSeq,
        operatorUserId: session.operatorUserId,
        operatorLogin: session.operatorLogin,
        shiftDate: session.shiftDate,
        businessTime: session.businessTime,
        remark: session.remark,
        draftFeeds: session.draftFeeds,
        lockedOperationId: outputs.length > 0 ? session.orderOperationId : null,
        outputs: outputs.map((o) => ({
          lineNo: o.lineNo,
          quantity: o.quantity,
          qualifiedQty: o.qualifiedQty,
          uomCode: o.uomCode,
          carrierCode: o.carrierCode,
          targetLocationId: o.targetLocationId,
          targetLocationCode: o.targetLocationCode,
        })),
      })
    }
    return { items, total: sessions.total, page: sessions.page, pageSize: sessions.pageSize }
  }

  /** 报工单详情（草稿续作带出产出/托码/库位/备注）。 */
  async getReport(auth: VerifiedAuthContext, reportId: string): Promise<ReportDetailView | null> {
    const report = await this.deps.execution.reports.findById(reportId)
    if (report === null || report.enterpriseId !== auth.user.enterpriseId) return null
    const filter = scopedFilter(auth)
    if (filter.plantIds !== null && !filter.plantIds.includes(report.plantId)) return null
    if (filter.operatorUserId !== undefined && filter.operatorUserId !== report.operatorUserId) return null
    const outputs = await this.deps.execution.outputs.listByReport(report.id)
    const feeds = await this.deps.execution.feeds.listByReport(report.id)
    return { report, outputs, feeds, reviewCancelled: report.reviewCancelledAt !== null }
  }

  /** 五量分立查询（[底稿 A5-3/S02]：草稿/提交/审核/合格/入库分别展示，不做混口径）。 */
  async orderQuantities(auth: VerifiedAuthContext, orderId: string): Promise<OrderQuantitiesView | null> {
    const order = await this.deps.process.orders.findById(orderId)
    if (order === null || order.enterpriseId !== auth.user.enterpriseId) return null
    const filter = scopedFilter(auth)
    if (filter.plantIds !== null && !filter.plantIds.includes(order.plantId)) return null

    const operations = await this.deps.process.orderOperations.listCurrentByOrder(
      order.id,
      order.currentSettingsVersion,
    )
    const reports = (await this.deps.execution.reports.listByOrder(order.id)).filter(
      (r) => filter.operatorUserId === undefined || r.operatorUserId === filter.operatorUserId,
    )
    const outputs = await this.deps.execution.outputs.listByOrder(order.id)
    const outputsByReport = new Map<string, ReportOutputRecord[]>()
    for (const o of outputs) {
      const list = outputsByReport.get(o.reportId) ?? []
      list.push(o)
      outputsByReport.set(o.reportId, list)
    }
    const reportsOf = (orderOperationId: string): ProductionReportRecord[] =>
      reports.filter((r) => r.orderOperationId === orderOperationId)

    const readinessOps = operations.map((o) => ({
      seq: o.seq,
      isQc: this.qcDeptIds.includes(o.productionDeptId),
      productionDeptId: o.productionDeptId,
    }))
    const lastNonQc = resolveLastNonQcOperation(readinessOps)
    const reportFacts = reports
      .filter((r) => r.status === 'submitted' && r.reviewCancelledAt === null)
      .map((r) => ({
        seq: r.operationSeq,
        submitted: true,
        hasOutput: (outputsByReport.get(r.id)?.length ?? 0) > 0,
      }))

    const toInput = (r: ProductionReportRecord) => ({
      status: r.status,
      reviewStatus: r.reviewStatus,
      outputs: (outputsByReport.get(r.id) ?? []).map((o) => ({
        quantity: o.quantity,
        qualifiedQty: o.qualifiedQty,
        stockUnitId: o.stockUnitId,
      })),
      uomId: order.uom,
    })

    const rows = operations.map((op) => {
      const quantities = computeFiveQuantities(reportsOf(op.id).map(toInput))
      const verdict = computeOperationReadiness({
        operations: readinessOps,
        reports: reportFacts,
        targetSeq: op.seq,
      })
      return {
        orderOperationId: op.id,
        seq: op.seq,
        operationName: op.operationName,
        isQc: this.qcDeptIds.includes(op.productionDeptId),
        isLastNonQc: lastNonQc !== null && op.seq === lastNonQc.seq,
        quantities: {
          draftQty: quantities.draft,
          submittedQty: quantities.submitted,
          approvedQty: quantities.approved,
          qualifiedQty: quantities.qualified,
          stockedQty: quantities.stocked,
        },
        ready: verdict.ready,
        readyReason: verdict.reason,
      }
    })
    const total = computeFiveQuantities(reports.map(toInput))
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      uom: order.uom,
      total: {
        draftQty: total.draft,
        submittedQty: total.submitted,
        approvedQty: total.approved,
        qualifiedQty: total.qualified,
        stockedQty: total.stocked,
      },
      operations: rows,
    }
  }

  /** 扫码报工上下文（[底稿 A6-1/03 §3.2]：扫设备码→按班次日期带任务单→工序/设备默认）。 */
  async scanContext(
    auth: VerifiedAuthContext,
    query: { plantId: string; equipmentId: string; shiftDate: string },
  ): Promise<Array<{ orderId: string; orderOperationId: string; operationSeq: number; operationDefinitionId: string }>> {
    const filter = scopedFilter(auth)
    if (filter.plantIds !== null && !filter.plantIds.includes(query.plantId)) return []
    if (this.deps.schedule === undefined) return []
    return this.deps.schedule.listScheduledOperations({
      plantId: query.plantId,
      equipmentId: query.equipmentId,
      date: query.shiftDate,
    })
  }

  /** 工时记录查询（按订单）。 */
  async listLaborByOrder(auth: VerifiedAuthContext, orderId: string) {
    const order = await this.deps.process.orders.findById(orderId)
    if (order === null || order.enterpriseId !== auth.user.enterpriseId) return []
    const filter = scopedFilter(auth)
    if (filter.plantIds !== null && !filter.plantIds.includes(order.plantId)) return []
    const rows = await this.deps.execution.labor.listByOrder(orderId)
    return filter.operatorUserId === undefined
      ? rows
      : rows.filter((r) => r.operatorUserId === filter.operatorUserId)
  }
}
