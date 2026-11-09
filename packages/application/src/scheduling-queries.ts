import type { VerifiedAuthContext } from './session-verifier'
// Shift-date queries use the same explicit factory calendar as inventory/report writes.
import {
  computeBoardDates,
  computeShiftDate,
  orderDetailEntryBlocker,
  pdaDefaultDateWindow,
  projectOperationScheduling,
  projectOrderSchedulingStatus,
  sumPlannedQty,
  type OrderSchedulingStatus,
} from '@cadenza/domain'
import { factoryCalendar } from './inventory-posting'
import type { SchedulingRepositories, SchedulingSlotViewRow } from './scheduling-repositories'

/**
 * scheduling 域查询服务：订单视图与设备视图两套投影读同一 schedule_slot 表
 * （[底稿 A3 / DM §2] 同一排产事实投影到订单和设备视图），PDA 排产计划只读（[A3-7]）。
 * 全部按授权数据范围服务端过滤（OA-24/25：plant 收敛 + 纵深防御）。
 *
 * 返回形状与 packages/contracts/src/scheduling.ts 的 DTO 字段级一致；
 * contracts 面在 L0 整合步前不经包名导出（S2 共享 index 不可改），故本文件本地声明
 * 视图形状，DTO 冻结断言由 tests/api/scheduling-api.spec.ts 以相对导入承担（process 先例）。
 */

/** 订单视图工序行（[A3-4] 回写链投影）。 */
export interface OrderViewOperation {
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
  slots: Array<{
    slotId: string
    equipmentId: string
    equipmentCode: string
    equipmentName: string
    equipmentStatus: 1 | 2
    productionDate: string
    plannedQty: string
    remark: string | null
  }>
}

/** 订单视图（订单排程详情投影）。 */
export interface OrderSchedulingView {
  orderId: string
  plantId: string
  orderNo: string
  uom: string
  orderStatus: string
  enterable: boolean
  entryBlocker: string | null
  schedulingStatus: 'unplanned' | 'partially_scheduled' | 'fully_scheduled'
  operations: OrderViewOperation[]
}

/** 设备看板视图（[A3-5]）。 */
export interface DeviceBoardView {
  plantId: string
  workCenterId: string | null
  today: string
  dates: string[]
  workCenters: Array<{ id: string; code: string; name: string }>
  equipments: Array<{
    equipmentId: string
    code: string
    name: string
    equipmentStatus: 1 | 2
    workCenterId: string
    cells: Array<{
      productionDate: string
      orderCount: number
      plannedTotal: string
      details: Array<{
        orderId: string
        orderNo: string
        salesOrderNo: string | null
        plannedQty: string
        uom: string
      }>
    }>
  }>
}

/** PDA 排产计划视图（只读，[A3-7 / PP §3.2]）。 */
export interface PdaPlanView {
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

/** 班次信息与双轨时间（[A4-2]）。 */
export interface ShiftInfo {
  plantId: string
  dayShiftStart: string | null
  actualTime: string
  shiftDate: string | null
  calendar: ReturnType<typeof factoryCalendar>
}

export interface SchedulingQueryDeps {
  scheduling: SchedulingRepositories
  /** 服务端当前时间（看板「今日」/班次计算；缺省真实时钟，测试可注入固定值）。 */
  now?: () => Date
}

export class SchedulingQueryService {
  constructor(private readonly deps: SchedulingQueryDeps) {}

  private repos(): SchedulingRepositories {
    return this.deps.scheduling
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10)
  }

  /** plant 过滤口径：显式 plantId 已由 ScopeGuard 校验在范围内；未指定按数据范围收敛。 */
  private plantFilter(auth: VerifiedAuthContext, plantId: unknown): string[] | null {
    if (typeof plantId === 'string' && plantId.length > 0) return [plantId]
    const scope = auth.dataScope
    return scope.enterpriseWide ? null : scope.plantIds
  }

  /** 纵深防御：对象厂不在数据范围时按不存在处理。 */
  private inScope(auth: VerifiedAuthContext, plantId: string): boolean {
    const scope = auth.dataScope
    return scope.enterpriseWide || scope.plantIds.includes(plantId)
  }

  // -----------------------------------------------------------------------
  // 订单视图（订单排程详情：工序 Tab × 设备 × 日期矩阵；[底稿 A3-6] 前置 + [A3-4] 回写链投影）
  // -----------------------------------------------------------------------

  async orderView(auth: VerifiedAuthContext, orderId: string): Promise<OrderSchedulingView | null> {
    const order = await this.repos().lookups.findOrder(orderId)
    if (order === null || order.enterpriseId !== auth.user.enterpriseId) return null
    if (!this.inScope(auth, order.plantId)) return null
    const allOperations = await this.repos().lookups.listOrderOperations(orderId)
    // 当前设置版本的工序行（S04 变更版本结构；旧版本行不参与当前排程视图）
    const operations = allOperations.filter((op) => op.settingsVersion === order.currentSettingsVersion)
    const blocker = orderDetailEntryBlocker({
      processConfigStatus: order.processConfigStatus,
      operations: operations.map((op) => ({ workCenterId: op.workCenterId })),
    })
    const rows = await this.repos().slots.listViewRows({
      plantIds: [order.plantId],
      orderId,
      includeFinishedOrders: true, // 订单视图看本单全部有效排产（是否结束不影响本单详情口径）
    })
    const byOperation = new Map<string, SchedulingSlotViewRow[]>()
    for (const row of rows) {
      const list = byOperation.get(row.orderOperationId) ?? []
      list.push(row)
      byOperation.set(row.orderOperationId, list)
    }
    const operationDtos: OrderViewOperation[] = operations
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((op) => {
        const slots = byOperation.get(op.id) ?? []
        const scheduledQty = sumPlannedQty(slots.map((s) => s.plannedQty))
        const projection = projectOperationScheduling({ offlineQty: op.offlineQty, plannedQty: scheduledQty })
        const cells = slots
          .slice()
          .sort((a, b) => a.productionDate.localeCompare(b.productionDate) || a.equipmentName.localeCompare(b.equipmentName))
          .map((s) => ({
            slotId: s.slotId,
            equipmentId: s.equipmentId,
            equipmentCode: s.equipmentCode,
            equipmentName: s.equipmentName,
            equipmentStatus: (s.equipmentStatus === 2 ? 2 : 1) as 1 | 2,
            productionDate: s.productionDate,
            plannedQty: s.plannedQty,
            remark: s.remark,
          }))
        return {
          orderOperationId: op.id,
          seq: op.seq,
          operationDefinitionId: op.operationDefinitionId,
          operationName: op.operationName,
          operationRemark: op.operationRemark,
          offlineQty: op.offlineQty,
          scheduledQty: projection.scheduledQty,
          fullyScheduled: projection.fullyScheduled,
          uom: op.uom,
          workCenterId: op.workCenterId,
          slots: cells,
        }
      })
    const schedulingStatus: OrderSchedulingStatus = projectOrderSchedulingStatus(
      operations.map((op) => ({
        offlineQty: op.offlineQty,
        plannedQty: sumPlannedQty((byOperation.get(op.id) ?? []).map((s) => s.plannedQty)),
      })),
    )
    return {
      orderId: order.id,
      plantId: order.plantId,
      orderNo: order.orderNo,
      uom: order.uom,
      orderStatus: order.orderStatus,
      enterable: blocker === null,
      entryBlocker: blocker,
      schedulingStatus,
      operations: operationDtos,
    }
  }

  // -----------------------------------------------------------------------
  // 设备视图（设备排程看板：工作中心 Tab × 设备行 × 日期列；[底稿 A3-5]）
  // -----------------------------------------------------------------------

  async deviceBoard(
    auth: VerifiedAuthContext,
    query: { plantId?: string; workCenterId?: string; equipmentId?: string },
  ): Promise<DeviceBoardView | null> {
    const plantIds = this.plantFilter(auth, query.plantId)
    if (plantIds !== null && plantIds.length === 0) {
      // 范围内无厂：返回空看板（保持投影形状，不视为错误）
      return null
    }
    const plantId = plantIds !== null ? plantIds[0]! : (query.plantId ?? '')
    if (plantId === '') return null
    if (!this.inScope(auth, plantId)) return null
    const workCenters = await this.repos().lookups.listActiveWorkCentersByPlant(plantId)
    const selectedWorkCenterId =
      query.workCenterId !== undefined && query.workCenterId !== ''
        ? query.workCenterId
        : (workCenters[0]?.id ?? null)
    const wcDtos = workCenters.map((wc) => ({
      id: wc.id,
      code: wc.code,
      name: wc.name,
    }))
    const today = this.today()
    let equipments: DeviceBoardView['equipments'] = []
    let dates: string[] = [today]
    if (selectedWorkCenterId !== null) {
      const equipmentList = await this.repos().lookups.listActiveEquipmentsByWorkCenter(selectedWorkCenterId)
      const rows = await this.repos().slots.listViewRows({
        plantIds: [plantId],
        workCenterId: selectedWorkCenterId,
        includeFinishedOrders: false, // [底稿 A3-5] 已结束/已作废订单排产不展示
      })
      // [底稿 A3-5] 日期列 = 今日起连续 30 天 ∪ 各行已有排产日
      dates = computeBoardDates({ today, existingDates: rows.map((r) => r.productionDate) })
      const byEquipment = new Map<string, SchedulingSlotViewRow[]>()
      for (const row of rows) {
        const list = byEquipment.get(row.equipmentId) ?? []
        list.push(row)
        byEquipment.set(row.equipmentId, list)
      }
      equipments = equipmentList
        .filter((e) => query.equipmentId === undefined || query.equipmentId === '' || e.id === query.equipmentId)
        .map((e) => {
          const equipmentRows = byEquipment.get(e.id) ?? []
          const byDate = new Map<string, SchedulingSlotViewRow[]>()
          for (const row of equipmentRows) {
            const list = byDate.get(row.productionDate) ?? []
            list.push(row)
            byDate.set(row.productionDate, list)
          }
          const cells = dates
            .map((date) => {
              const dayRows = byDate.get(date) ?? []
              if (dayRows.length === 0) return null
              const details = dayRows.map((r) => ({
                orderId: r.orderId,
                orderNo: r.orderNo,
                salesOrderNo: r.salesOrderNo,
                plannedQty: r.plannedQty,
                uom: r.uom,
              }))
              return {
                productionDate: date,
                orderCount: new Set(dayRows.map((r) => r.orderId)).size,
                plannedTotal: sumPlannedQty(dayRows.map((r) => r.plannedQty)),
                details,
              }
            })
            .filter((c): c is NonNullable<typeof c> => c !== null)
          return {
            equipmentId: e.id,
            code: e.code,
            name: e.name,
            equipmentStatus: (e.equipmentStatus === 2 ? 2 : 1) as 1 | 2,
            workCenterId: e.workCenterId,
            cells,
          }
        })
    }
    return {
      plantId,
      workCenterId: selectedWorkCenterId,
      today,
      dates,
      workCenters: wcDtos,
      equipments,
    }
  }

  // -----------------------------------------------------------------------
  // PDA 排产计划（只读，[底稿 A3-7 / PP §3.2]：按工作中心 + 排产日期分组）
  // -----------------------------------------------------------------------

  async pdaPlan(
    auth: VerifiedAuthContext,
    query: { workCenterId: string; orderNoLike?: string; equipmentId?: string; date?: string },
  ): Promise<PdaPlanView | null> {
    const workCenter = await this.repos().lookups.findWorkCenter(query.workCenterId)
    if (workCenter === null || workCenter.enterpriseId !== auth.user.enterpriseId) return null
    if (!this.inScope(auth, workCenter.plantId)) return null
    const today = this.today()
    // [底稿 A4 / PP §3.2] 未选排产日期时默认含当天及往前 7 天；选了日期只查该日
    const dates = query.date !== undefined && query.date !== '' ? [query.date] : pdaDefaultDateWindow(today)
    const rows = await this.repos().slots.listViewRows({
      plantIds: [workCenter.plantId],
      workCenterId: workCenter.id,
      equipmentId: query.equipmentId === '' ? undefined : query.equipmentId,
      dates,
      includeFinishedOrders: false, // 看板同口径：已结束/已作废订单排产不展示
    })
    const filtered =
      query.orderNoLike !== undefined && query.orderNoLike !== ''
        ? rows.filter((r) => r.orderNo.includes(query.orderNoLike!))
        : rows
    const byDate = new Map<string, SchedulingSlotViewRow[]>()
    for (const row of filtered) {
      const list = byDate.get(row.productionDate) ?? []
      list.push(row)
      byDate.set(row.productionDate, list)
    }
    const groups = [...byDate.keys()].sort().map((date) => ({
      productionDate: date,
      items: (byDate.get(date) ?? [])
        .slice()
        .sort((a, b) => a.orderNo.localeCompare(b.orderNo) || a.equipmentName.localeCompare(b.equipmentName))
        .map((r) => ({
          slotId: r.slotId,
          orderNo: r.orderNo,
          salesOrderNo: r.salesOrderNo,
          equipmentId: r.equipmentId,
          equipmentName: r.equipmentName,
          materialDesc: materialDesc(r.materialSnapshot),
          plannedQty: r.plannedQty,
          uom: r.uom,
          remark: r.remark,
        })),
    }))
    return { workCenterId: workCenter.id, workCenterName: workCenter.name, groups }
  }

  // -----------------------------------------------------------------------
  // 班次信息与双轨时间（[底稿 A4-2]：实际时间 + 业务班次日期并存）
  // -----------------------------------------------------------------------

  async shiftInfo(
    auth: VerifiedAuthContext,
    query: { plantId: string; at?: string },
  ): Promise<ShiftInfo | null> {
    const plantFilter = this.plantFilter(auth, query.plantId)
    if (plantFilter === null || !plantFilter.includes(query.plantId)) {
      // 显式 plantId 已由 ScopeGuard 校验；此处纵深防御（数据范围外按不可用返回）
      if (!this.inScope(auth, query.plantId)) return null
    }
    const shift = await this.repos().shifts.findByPlant(query.plantId)
    const actualTime = query.at !== undefined && query.at !== '' ? query.at : this.now().toISOString()
    const calendar = factoryCalendar(query.plantId, shift?.dayShiftStart ?? null)
    const shiftDate = computeShiftDate(actualTime, calendar)
    return {
      plantId: query.plantId,
      dayShiftStart: shift?.dayShiftStart ?? null,
      actualTime,
      shiftDate,
      calendar,
    }
  }
}

/** PP §3.2 物料描述：料品名称/规格/颜色以 " / " 拼接（都空显示 "-"）。 */
function materialDesc(snapshot: Record<string, unknown>): string {
  const name = typeof snapshot['name'] === 'string' && snapshot['name'] !== '' ? snapshot['name'] : null
  const spec = typeof snapshot['spec'] === 'string' && snapshot['spec'] !== '' ? snapshot['spec'] : null
  const color = typeof snapshot['color'] === 'string' && snapshot['color'] !== '' ? snapshot['color'] : null
  const parts = [name, spec, color].filter((p): p is string => p !== null)
  return parts.length > 0 ? parts.join(' / ') : '-'
}

// 类型口径再导出（查询端口消费侧避免 dist 相对导入泄漏到多文件）
export type { OrderSchedulingStatus }
