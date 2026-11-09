import { cswCalibrationEffectAt, cswDowntimeFraction } from './csw-repositories'
import type { VerifiedAuthContext } from './session-verifier'
import type {
  CswCalibrationStateRecord,
  CswChangeoverMatrixRecord,
  CswDowntimeRecord,
  CswFreezeRecord,
  CswOutsourcingTaskRecord,
  CswOutsourcingUnitRecord,
  CswOverrideAuditRecord,
  CswRepositories,
  CswScheduleVersionItemRecord,
  CswScheduleVersionRecord,
} from './csw-repositories'
import type { SchedulingRepositories } from './scheduling-repositories'
 
import {
  OUTSOURCING_STATUS_LABELS,
  buildSettlementFact,
  dueDateUrgency,
  evaluateMaterialSufficiency,
  evaluateReadiness,
  isOutsourcingOccupationActive,
  type OutsourcingSettlementFact,
} from '@cadenza/domain'

/**
 * csw 域查询服务（读侧，池连接只读；许可由 HTTP 守卫首检，数据范围在本服务内
 * 按授权上下文服务端过滤——OA-24/25 口径，同 shipping 查询模式）。
 *
 * 覆盖：冻结记录/换型矩阵版本/排程版本与条目（CS-13 回放并排比较）/覆盖审计/
 * 停机与受影响槽位提示/校准标记槽位（CS-10）/外协任务与 ERP 加工数量事实导出（CS-24）/
 * 就绪评估（CS-07/CS-08——开工闸门等价服务，收编请求见交付记录）。
 */

export interface CswQueryDeps {
  csw: CswRepositories
  scheduling: SchedulingRepositories
}

export type CswFreezeView = CswFreezeRecord & { scopeLabel: string; statusLabel: string }

export type CswVersionView = CswScheduleVersionRecord & { statusLabel: string }

export interface CswVersionDetailView {
  version: CswVersionView
  items: Array<CswScheduleVersionItemRecord & { actionLabel: string }>
}

/** [CS-13] 版本并排回放比较（系统建议 vs 人工最终、前后版本）。 */
export interface CswVersionCompareView {
  version: CswVersionView
  parent: CswVersionView | null
  changedItems: Array<{
    orderOperationId: string
    orderNo: string
    operationName: string
    current: CswScheduleVersionItemRecord | null
    parentItem: CswScheduleVersionItemRecord | null
  }>
}

export interface CswReadinessView {
  orderOperationId: string
  orderNo: string
  operationName: string
  ready: boolean
  blockers: Array<{ condition: string; rule: string; message: string }>
  materialBasis: 'default' | 'include_reserved'
  materialDemandQty: string
  materialAvailableQty: string
  materialShortfall: string | null
}

const VERSION_STATUS_LABELS: Readonly<Record<string, string>> = {
  proposed: '建议中',
  committed: '已提交',
  superseded: '已被替代',
}

const ACTION_LABELS: Readonly<Record<string, string>> = {
  keep: '保留（冻结/已开工只读）',
  move: '移动',
  new: '新增排产',
  remove: '移除槽位',
  conflict: '冲突（无解呈现）',
  outside_horizon: '求解窗口外（仅列示）',
}

const FREEZE_SCOPE_LABELS: Readonly<Record<string, string>> = {
  equipment_date_range: '设备×生产日期区间',
  slot: '单槽位',
}

export class CswQueryService {
  constructor(private readonly deps: CswQueryDeps) {}

  private plantScope(auth: VerifiedAuthContext): string[] | null {
    return auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds
  }

  private assertScope(auth: VerifiedAuthContext, plantId: string): boolean {
    const scope = this.plantScope(auth)
    return scope === null || scope.includes(plantId)
  }

  // ---------------- 冻结记录 ----------------

  async listFreezeRecords(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; equipmentId?: string; status?: 'active' | 'ended'; page?: number; pageSize?: number },
  ) {
    const plantIds = filter.plantId !== undefined ? [filter.plantId] : this.plantScope(auth)
    const page = await this.deps.csw.freezes.list({
      plantIds,
      equipmentId: filter.equipmentId,
      status: filter.status,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
    return {
      ...page,
      items: page.items.map((r) => ({
        ...r,
        scopeLabel: FREEZE_SCOPE_LABELS[r.scope] ?? r.scope,
        statusLabel: r.status === 'active' ? '生效中' : '已解冻',
      })),
    }
  }

  // ---------------- 换型矩阵 ----------------

  async listChangeoverMatrices(auth: VerifiedAuthContext, filter: { plantId?: string }) {
    const plantIds = filter.plantId !== undefined ? [filter.plantId] : this.plantScope(auth)
    return this.deps.csw.matrices.list({ plantIds })
  }

  // ---------------- 排程版本（CS-13/27 回放比较） ----------------

  async listVersions(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; status?: CswScheduleVersionRecord['status']; page?: number; pageSize?: number },
  ) {
    const plantIds = filter.plantId !== undefined ? [filter.plantId] : this.plantScope(auth)
    const page = await this.deps.csw.versions.list({
      plantIds,
      status: filter.status,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
    return {
      ...page,
      items: page.items.map((v) => ({ ...v, statusLabel: VERSION_STATUS_LABELS[v.status] ?? v.status })),
    }
  }

  async versionDetail(auth: VerifiedAuthContext, versionId: string): Promise<CswVersionDetailView | null> {
    const version = await this.deps.csw.versions.findById(versionId)
    if (version === null || version.enterpriseId !== auth.user.enterpriseId) return null
    if (!this.assertScope(auth, version.plantId)) return null
    const items = await this.deps.csw.versionItems.listByVersion(versionId)
    return {
      version: { ...version, statusLabel: VERSION_STATUS_LABELS[version.status] ?? version.status },
      items: items.map((i) => ({ ...i, actionLabel: ACTION_LABELS[i.action] ?? i.action })),
    }
  }

  /** [CS-13] 系统建议与人工最终、以及前后版本并排回放比较。 */
  async versionCompare(auth: VerifiedAuthContext, versionId: string): Promise<CswVersionCompareView | null> {
    const detail = await this.versionDetail(auth, versionId)
    if (detail === null) return null
    let parent: CswVersionView | null = null
    let parentItems: CswScheduleVersionItemRecord[] = []
    if (detail.version.parentVersionId !== null) {
      const parentDetail = await this.versionDetail(auth, detail.version.parentVersionId)
      if (parentDetail !== null) {
        parent = parentDetail.version
        parentItems = parentDetail.items
      }
    }
    const keyOf = (i: CswScheduleVersionItemRecord) => `${i.orderOperationId}|${i.action}`
    const changedItems: CswVersionCompareView['changedItems'] = []
    const parentByOp = new Map(parentItems.map((i) => [i.orderOperationId, i]))
    for (const item of detail.items) {
      const parentItem = parentItems.find((p) => keyOf(p) === keyOf(item)) ?? parentByOp.get(item.orderOperationId) ?? null
      changedItems.push({
        orderOperationId: item.orderOperationId,
        orderNo: item.orderNo,
        operationName: item.operationName,
        current: item,
        parentItem,
      })
    }
    return { version: detail.version, parent, changedItems }
  }

  // ---------------- 覆盖审计（CS-26） ----------------

  async listOverrideAudit(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; overrideType?: CswOverrideAuditRecord['overrideType']; page?: number; pageSize?: number },
  ) {
    const plantIds = filter.plantId !== undefined ? [filter.plantId] : this.plantScope(auth)
    return this.deps.csw.overrides.list({
      plantIds,
      overrideType: filter.overrideType,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
  }

  // ---------------- 停机（CS-09 提示） ----------------

  async listDowntimes(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; equipmentId?: string; status?: 'active' | 'closed'; page?: number; pageSize?: number },
  ) {
    const plantIds = filter.plantId !== undefined ? (this.assertScope(auth, filter.plantId) ? [filter.plantId] : []) : this.plantScope(auth)
    return this.deps.csw.downtimes.list({
      plantIds,
      enterpriseId: auth.user.enterpriseId,
      equipmentId: filter.equipmentId,
      status: filter.status,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
  }

  // ---------------- 校准标记槽位（CS-10） ----------------

  async listCalibrationStates(auth: VerifiedAuthContext, filter: { plantId?: string }) {
    const plantIds = filter.plantId !== undefined ? (this.assertScope(auth, filter.plantId) ? [filter.plantId] : []) : this.plantScope(auth)
    const states = await this.deps.csw.calibration.list({ plantIds, enterpriseId: auth.user.enterpriseId })
    const today = new Date().toISOString().slice(0, 10)
    return states.map((s) => ({
      ...s,
      effect: cswCalibrationEffectAt(s as CswCalibrationStateRecord, today),
      flaggedSlotIds: s.affectedSlotIds,
      note: s.source === 'UNKNOWN' ? `UNKNOWN: ${s.sourceIssue}; 未证明校准有效` : '读取 SPC 校准业务记录；按完整 UTC 排程日核验，变更仅提示计划员复核',
    }))
  }

  // ---------------- 外协任务（CS-19/24） ----------------

  async listOutsourcingTasks(
    auth: VerifiedAuthContext,
    filter: {
      plantId?: string
      status?: CswOutsourcingTaskRecord['status']
      orderOperationId?: string
      taskNoLike?: string
      page?: number
      pageSize?: number
    },
  ) {
    const plantIds = filter.plantId !== undefined ? [filter.plantId] : this.plantScope(auth)
    const page = await this.deps.csw.outsourcingTasks.list({
      plantIds,
      status: filter.status,
      orderOperationId: filter.orderOperationId,
      taskNoLike: filter.taskNoLike,
      page: filter.page ?? 1,
      pageSize: filter.pageSize ?? 20,
    })
    return {
      ...page,
      items: page.items.map((t) => ({
        ...t,
        statusLabel: OUTSOURCING_STATUS_LABELS[t.status] ?? t.status,
        occupationActive: isOutsourcingOccupationActive(t.status),
      })),
    }
  }

  async outsourcingDetail(auth: VerifiedAuthContext, taskId: string) {
    const task = await this.deps.csw.outsourcingTasks.findById(taskId)
    if (task === null || task.enterpriseId !== auth.user.enterpriseId) return null
    if (!this.assertScope(auth, task.plantId)) return null
    const links: CswOutsourcingUnitRecord[] = await this.deps.csw.outsourcingUnits.listByTask(taskId)
    return {
      task: { ...task, statusLabel: OUTSOURCING_STATUS_LABELS[task.status] ?? task.status, occupationActive: isOutsourcingOccupationActive(task.status) },
      units: links,
    }
  }

  /** [CS-24] 加工数量事实导出（供 ERP 结算核对；本系统不记应付/加工费/发票）。 */
  async outsourcingErpExport(
    auth: VerifiedAuthContext,
    filter: { plantId?: string; page?: number; pageSize?: number },
  ): Promise<{ facts: OutsourcingSettlementFact[]; note: string }> {
    const page = await this.listOutsourcingTasks(auth, { plantId: filter.plantId, page: filter.page, pageSize: 1000 })
    const facts = page.items.map((t) =>
      buildSettlementFact({
        taskNo: t.taskNo,
        supplierCode: t.supplierCode,
        supplierName: t.supplierName,
        orderNo: t.orderNo,
        operationName: t.operationName,
        sentQty: t.sentQty,
        returnedQty: t.returnedQty,
        uom: t.uom,
        sentAt: t.sentAt,
        receivedAt: t.receivedAt,
        closedAt: t.closedAt,
      }),
    )
    return {
      facts,
      note: '外协加工数量事实导出（模拟适配器先行；真实接口族无样例 BLOCKED_EXTERNAL，GAP-B1 口径）',
    }
  }

  // ---------------- 就绪评估（CS-07/CS-08 等价服务；开工闸门收编请求见交付记录） ----------------

  async evaluateReadiness(
    auth: VerifiedAuthContext,
    input: { orderOperationId: string },
  ): Promise<CswReadinessView | null> {
    const op = await this.deps.scheduling.lookups.findOrderOperation(input.orderOperationId)
    if (op === null) return null
    const order = await this.deps.scheduling.lookups.findOrder(op.orderId)
    if (order === null || order.enterpriseId !== auth.user.enterpriseId) return null
    if (!this.assertScope(auth, op.plantId)) return null

    // 本域排程富行（含 execution_status / materialId——T09 只读窄面未列，走本域扩展查询）
    const schedulableRows = await this.deps.csw.lookups.listSchedulableOrders(op.plantId)
    const opRow = schedulableRows.find((r) => r.orderOperationId === op.id) ?? null

    // ① 前置工序完成（报工/接收事实＝execution_status executed；不以出现过报工单充当完成）
    const priorOps = schedulableRows.filter((r) => r.orderId === op.orderId && r.seq < op.seq)
    const pendingPrior = priorOps.filter((r) => r.executionStatus !== 'executed')
    const priorOperationsDone = priorOps.length === 0 || pendingPrior.length === 0

    // ② 物料齐套（CS-08 默认口径：质量 ∧ 预留 过滤后的余额覆盖）
    const materialId = opRow === null ? (order.materialSnapshot['materialId'] as string | undefined) ?? '' : opRow.materialId
    const availability = await this.deps.csw.lookups.computeMaterialAvailability(op.plantId, materialId)
    const sufficiency = evaluateMaterialSufficiency({
      demandQty: op.offlineQty,
      availableQty: availability.availableQty,
    })

    // ③ 设备可用（工作中心内存在 状态正常＋校准有效＋当日非全日停机 的活动设备）
    const today = new Date().toISOString().slice(0, 10)
    const equipments = await this.deps.scheduling.lookups.listActiveEquipmentsByWorkCenter(op.workCenterId)
    let equipmentBlocker: string | null = null
    if (equipments.length === 0) {
      equipmentBlocker = '工作中心无活动设备'
    } else {
      const calStates = new Map<string, CswCalibrationStateRecord | null>()
      const downFractions = new Map<string, number>()
      for (const eq of equipments) {
        calStates.set(eq.id, await this.deps.csw.calibration.findByEquipment(eq.id, today))
        downFractions.set(eq.id, cswDowntimeFraction(await this.deps.csw.downtimes.listActiveByEquipment(eq.id, today, today), today))
      }
      const available = equipments.filter((eq) => {
        if (eq.equipmentStatus !== 1) return false
        const effect = cswCalibrationEffectAt(calStates.get(eq.id) ?? null, today)
        if (effect === 'invalid' || effect === 'expired' || (downFractions.get(eq.id) ?? 0) >= 1) return false
        return true
      })
      if (available.length === 0) {
        equipmentBlocker = '工作中心设备全部不可用（维修/校准失效/停机）'
      }
    }
    const equipmentAvailable = equipmentBlocker === null

    // ④ 质量规则（存在可用合格物料即视为质量通道就绪——待检/存疑不构成可用；不足由物料条件阻断）
    const qualityCleared = sufficiency.sufficient || Number(availability.availableQty) > 0
    const verdict = evaluateReadiness({
      priorOperationsDone,
      pendingPriorOperations: pendingPrior.map((o) => `工序${o.seq} ${o.operationName}`),
      materialReady: sufficiency.sufficient,
      materialShortfall: sufficiency.shortfall,
      equipmentAvailable,
      equipmentBlocker,
      qualityCleared,
      qualityBlocker: qualityCleared ? null : '物料可用量以合格（质量 ∧ 预留）口径不足——待检/存疑物料未放行',
    })
    return {
      orderOperationId: op.id,
      orderNo: order.orderNo,
      operationName: op.operationName,
      ready: verdict.ready,
      blockers: verdict.blockers,
      materialBasis: sufficiency.basis,
      materialDemandQty: op.offlineQty,
      materialAvailableQty: availability.availableQty,
      materialShortfall: sufficiency.shortfall,
    }
  }

  /** [CS-17] 交期紧迫度快照（建议排序口径展示）。 */
  dueDateUrgencyOf(dueDate: string | null, today: string): number {
    return dueDateUrgency(dueDate, today)
  }

  /** [CS-09] 停机占用比例展示（诊断用途）。 */
  downtimeFractionOf(downtime: CswDowntimeRecord, productionDate: string): number {
    return cswDowntimeFraction([downtime], productionDate)
  }

  /** [CS-16] 换型矩阵当前版本（诊断用途）。 */
  async activeMatrix(auth: VerifiedAuthContext, plantId: string): Promise<CswChangeoverMatrixRecord | null> {
    if (!this.assertScope(auth, plantId)) return null
    return this.deps.csw.matrices.findLatestByPlant(plantId)
  }
}
