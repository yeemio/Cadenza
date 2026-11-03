import {
  computeNextDueDate,
  isPlanOverdue,
  MAINTENANCE_ORDER_STATUS_LABELS,
  MAINTENANCE_ORDER_SOURCE_LABELS,
  MAINTENANCE_PLAN_KIND_LABELS,
  type MaintenanceOrderStatus,
} from '@cadenza/domain'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  DowntimeEventFilter,
  DowntimeEventRepository,
  EquipmentStartRecordRepository,
  InspectionRoundRepository,
  MaintenanceEquipmentReader,
  MaintenanceOrderRepository,
  MaintenancePlanRepository,
  SparePartUsageRepository,
  CapacityOutboxPort,
} from './maintenance-repositories'

/**
 * maintenance 域查询服务（只读；数据范围服务端过滤 OA-24/25）。
 *
 * A10 证据面：工单列表/详情（含停机事件、备件消耗、状态流水对齐——MT-02/08"状态变更
 * 流水来源完整、与工单事件可对齐"）、停机事件、能力变化事件读回（MT-10/15：复机后
 * 排程可见能力恢复——T09 消费前以 outbox 行为证据）、超期未执行提示（MT-12：提示
 * 不阻断）、开工记录、点检/保养轮次。
 */
export class MaintenanceQueryService {
  constructor(
    private readonly deps: {
      orders: MaintenanceOrderRepository
      downtime: DowntimeEventRepository
      usages: SparePartUsageRepository
      plans: MaintenancePlanRepository
      rounds: InspectionRoundRepository
      starts: EquipmentStartRecordRepository
      outbox: CapacityOutboxPort
      equipment: MaintenanceEquipmentReader
    },
  ) {}

  /** 数据范围折算：企业范围 → null（不过滤）；否则限定授权工厂集合。 */
  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  private assertStatusValue(status: string | undefined): MaintenanceOrderStatus | undefined {
    if (status === undefined) return undefined
    if (!(status in MAINTENANCE_ORDER_STATUS_LABELS)) {
      const allowed = Object.keys(MAINTENANCE_ORDER_STATUS_LABELS).join('/')
      throw new Error(`[MT-07] 工单状态筛选值非法（${status}），支持：${allowed}`)
    }
    return status as MaintenanceOrderStatus
  }

  /** 工单列表（状态机读回，标签中文口径）。 */
  async listOrders(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; equipmentId?: string; status?: string; page?: number; pageSize?: number },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const rows = await this.deps.orders.list({
      plantIds: this.plantScope(auth),
      equipmentId: filter.equipmentId,
      status: this.assertStatusValue(filter.status),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return {
      page,
      pageSize,
      total: rows.length,
      items: rows.map((order) => ({
        ...order,
        statusLabel: MAINTENANCE_ORDER_STATUS_LABELS[order.status],
        sourceLabel: MAINTENANCE_ORDER_SOURCE_LABELS[order.source],
      })),
    }
  }

  /**
   * 工单详情对齐视图（A10）：工单＋停机事件＋备件消耗（含库存流水引用）＋
   * 该设备状态流水（MT-02：来源 WEB/PDA 完整，与工单事件可对齐——工单建单/复机
   * 时间与状态流水同事务产生，按时间排序对齐）。
   */
  async getOrderDetail(auth: VerifiedAuthContext, orderId: string) {
    const order = await this.deps.orders.findById(orderId)
    if (order === null) throw new Error(`[MT-NOT-FOUND] 维修工单不存在（id=${orderId}）`)
    const scope = this.plantScope(auth)
    if (scope !== null && !scope.includes(order.plantId)) {
      throw new Error('[A-S1] 目标工厂不在授权数据范围内')
    }
    const downtime = await this.deps.downtime.list({ plantIds: null, orderId: order.id })
    const usages = await this.deps.usages.listByOrder(order.id)
    const statusLogs = await this.deps.equipment.listStatusLogs(order.equipmentId)
    const capacityEvents = await this.deps.outbox.listCapacityEvents({ orderId: order.id })
    return {
      order: {
        ...order,
        statusLabel: MAINTENANCE_ORDER_STATUS_LABELS[order.status],
        sourceLabel: MAINTENANCE_ORDER_SOURCE_LABELS[order.source],
      },
      downtimeEvents: downtime,
      spareUsages: usages,
      equipmentStatusLogs: statusLogs,
      capacityEvents,
    }
  }

  /** 停机事件列表（openOnly=在停机中，MT-S2）。 */
  async listDowntimeEvents(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; equipmentId?: string; openOnly?: boolean; page?: number; pageSize?: number },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const rows = await this.deps.downtime.list({
      plantIds: this.plantScope(auth),
      equipmentId: filter.equipmentId,
      openOnly: filter.openOnly === true,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    } satisfies DowntimeEventFilter)
    return { page, pageSize, total: rows.length, items: rows }
  }

  /** 能力变化事件读回（MT-10/15：工单→停机→能力事件链可追溯；T09 消费前排程可见证据）。 */
  async listCapacityEvents(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; orderId?: string; equipmentId?: string; limit?: number },
  ) {
    return this.deps.outbox.listCapacityEvents({
      plantId: filter.plantId,
      orderId: filter.orderId,
      equipmentId: filter.equipmentId,
      limit: Math.min(filter.limit ?? 50, 200),
    })
  }

  /** 点检/保养计划列表（版本化）。 */
  async listPlans(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; equipmentId?: string; kind?: 'inspection' | 'maintenance' },
  ) {
    const rows = await this.deps.plans.list({ plantIds: this.plantScope(auth), equipmentId: filter.equipmentId, kind: filter.kind })
    return {
      total: rows.length,
      items: rows.map((plan) => ({
        ...plan,
        kindLabel: MAINTENANCE_PLAN_KIND_LABELS[plan.kind],
        checkItemsCount: plan.checkItems.length,
      })),
    }
  }

  /**
   * 超期未执行提示（MT-12：提示口径，不自动阻断生产——默认口径，GAP-F19 待裁）。
   * 版本择优：同 planKey 取当日生效的最高 active 版本（配置变更不回写已执行记录——
   * 轮次引用版本快照，锚点=该计划任意版本最近一次执行班次日，无执行则生效日）＋周期 everyDays。
   */
  async listOverduePlans(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; equipmentId?: string; today?: string },
  ) {
    const today = filter.today ?? new Date().toISOString().slice(0, 10)
    const plans = await this.deps.plans.list({ plantIds: this.plantScope(auth), equipmentId: filter.equipmentId })
    const byKey = new Map<string, (typeof plans)[number]>()
    for (const plan of plans) {
      if (plan.status !== 'active') continue
      if (today < plan.effectiveFrom) continue
      if (plan.effectiveTo !== null && today > plan.effectiveTo) continue
      const current = byKey.get(plan.planKey)
      if (current === undefined || plan.version > current.version) byKey.set(plan.planKey, plan)
    }
    const items: Array<Record<string, unknown>> = []
    for (const plan of byKey.values()) {
      const anchor = (await this.deps.rounds.lastShiftDateByPlan(plan.planKey)) ?? plan.effectiveFrom
      const nextDueDate = computeNextDueDate(anchor, plan.cycle)
      if (isPlanOverdue(nextDueDate, today)) {
        items.push({
          planId: plan.id,
          planKey: plan.planKey,
          version: plan.version,
          kind: plan.kind,
          kindLabel: MAINTENANCE_PLAN_KIND_LABELS[plan.kind],
          equipmentId: plan.equipmentId,
          anchorDate: anchor,
          nextDueDate,
          overdueDays: Math.round((Date.parse(today) - Date.parse(nextDueDate)) / 86_400_000),
          note: '超期未执行提示（不自动阻断生产；现场流程 GAP-F19 待裁）',
        })
      }
    }
    return { today, total: items.length, items }
  }

  /** 点检/保养执行轮次列表（实际时间＋业务班次双存读回，MT-12/IT-37）。 */
  async listRounds(
    auth: VerifiedAuthContext,
    filter: { planKey?: string; equipmentId?: string; result?: 'pass' | 'fail'; page?: number; pageSize?: number },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const rows = await this.deps.rounds.list({
      plantIds: this.plantScope(auth),
      planKey: filter.planKey,
      equipmentId: filter.equipmentId,
      result: filter.result,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return { page, pageSize, total: rows.length, items: rows }
  }

  /** 设备开工记录列表（(设备, 业务日) 唯一读回，MT-05/06）。 */
  async listStartRecords(
    auth: VerifiedAuthContext,
    filter: { equipmentId?: string; businessDate?: string; page?: number; pageSize?: number },
  ) {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 100)
    const page = Math.max(filter.page ?? 1, 1)
    const rows = await this.deps.starts.list({
      plantIds: this.plantScope(auth),
      equipmentId: filter.equipmentId,
      businessDate: filter.businessDate,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return { page, pageSize, total: rows.length, items: rows }
  }
}
