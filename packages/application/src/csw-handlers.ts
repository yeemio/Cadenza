import { ERROR_CODES } from '@cadenza/contracts'
import { OrgRuleViolation, isPlantInScope } from '@cadenza/domain'
import type { CommandHandler, CommandTools, HandlerOutcome } from './command-bus'
import { resolveBusinessTime, str, dec } from './inventory-posting'
import type { SlotIdentityKey } from './scheduling-repositories'
import type {
  CswChangeoverMatrixRecord,
  CswCommandTools,
  CswOutsourcingTaskRecord,
  CswOutsourcingUnitRecord,
  NewCswScheduleVersionItem,
} from './csw-repositories'
import { CswPostingContext, outsourceSendLine, outsourceReturnLine } from './csw-posting'
 
import {
  CswRuleViolation,
  CSW_PERMISSIONS,
  assertFreezeShape,
  assertNoActiveFreezeOverlap,
  assertUnfreezeReasonProvided,
  isSlotFrozen,
  isEquipmentDateFrozen,
  assertMatrixPublishable,
  nextMatrixVersionNo,
  lookupChangeoverMinutes,
  dimensionValueOf,
  DEFAULT_PRIORITY_WEIGHTS,
  assertPriorityWeightsValid,
  weightsDifferFromDefault,
  DEFAULT_HORIZON_DAYS,
  assertHorizonDaysValid,
  horizonDates,
  dueDateUrgency,
  assertSoftOverrideComplete,
  assertNoHardConstraintHit,
  calibrationEffectAt,
  assertCalibrationAllowsNewSlot,
  flagSlotsForCalibration,
  downtimeOccupancyFraction,
  effectiveCapacityForDate,
  assertOutsourcingTransition,
  isOutsourcingTerminal,
  assertOwnershipRetainedOnSend,
  assertSendLinesShape,
  assertReturnEntersPendingInspection,
  assertCloseRequiresInspectionPassed,
  assertNoSettlementFields,
  assertReturnWithinSent,
  evaluateCandidate,
  selectBestCandidate,
  buildTaskExplanation,
  buildConflictItem,
  classifyExistingSlot,
  remainingQtyOf,
  assertVersionTransition,
  assertQtyNonNegative,
  assertQtyPositive,
  addQty as cswAddQty,
  cmpQty as cswCmpQty,
  isValidProductionDate,
  type RescheduleTask,
  type CandidateInput,
  type CandidateEvaluation,
  type PriorityWeights,
  type OutsourcingAction,
  type OutsourcingStatus,
} from '@cadenza/domain'

/**
 * csw 域命令处理器（T22 受约束排程与外协；全部在命令总线事务内运行，命令事务即 UoW）。
 * 冻结合同 architecture/contracts/frozen/p3/constrained-scheduling.md（逐条对照见
 * delivery/P3/csw/DELIVERY.md §6）。写路径范围二道防线沿用 OA-26 模式（HTTP 守卫首检 +
 * 事务内服务端复核）。
 *
 * 命令面（16）：
 * - csw.freeze.create / release：冻结窗口（CS-11/S2；解冻具名权限 csw.unfreeze+理由留痕）；
 * - csw.changeover.publish：换型矩阵新版本（CS-16/S3 append-only）；
 * - csw.calibration.state.set：校准状态等价服务（CS-05③/CS-10；收编请求→T23 spc）；
 * - csw.downtime.register / close：维护停机等价服务（CS-09；关闭触发受影响排程计划评估提示）；
 * - csw.reschedule.propose / commit：有限能力可解释重排（CS-12~18/27；提交侧硬约束复检+
 *   软约束确认留痕+人工覆盖审计）；
 * - csw.outsourcing.create/submit/send/receive/inspect/close/recall/dispose：外协状态机
 *   （CS-19~25；send/receive 走 csw-posting 两段库存交接，CS-24 出站模拟）。
 */

type Payload = Record<string, unknown>

function bad(message: string, errorCode: string = ERROR_CODES.BUSINESS_RULE): HandlerOutcome {
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: message }
}

class Rejection extends Error {
  constructor(readonly outcome: HandlerOutcome) {
    super(outcome.errorMessage ?? '业务拒绝')
    this.name = 'CswRejection'
  }
}

function violationOutcome(error: CswRuleViolation | OrgRuleViolation): HandlerOutcome {
  const errorCode =
    error instanceof OrgRuleViolation ? ERROR_CODES.FORBIDDEN_SCOPE : ERROR_CODES.BUSINESS_RULE
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<HandlerOutcome>): Promise<HandlerOutcome> {
  try {
    return await body()
  } catch (error) {
    if (error instanceof Rejection) return error.outcome
    if (error instanceof CswRuleViolation || error instanceof OrgRuleViolation) {
      return violationOutcome(error)
    }
    throw error
  }
}

/** 取 csw 命令工具集（组合根装配的 CommandTools 超集）。 */
function cswTools(tools: CommandTools): CswCommandTools {
  return tools as CswCommandTools
}

/** 写路径范围二道防线（OA-26 模式）。 */
async function assertWriteScope(tools: CommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!isPlantInScope(scope, plantId)) {
    throw new OrgRuleViolation('OA-24', '目标工厂不在授权数据范围内（服务端范围检查）')
  }
}

/** [CS-11] 解冻具名权限二道防线（首检在 HTTP 守卫）。 */
async function assertUnfreezePermission(tools: CommandTools): Promise<void> {
  const perms = await tools.actorPermissions()
  if (!perms.includes(CSW_PERMISSIONS.CSW_UNFREEZE)) {
    throw new CswRuleViolation('CS-11', '解冻须具名权限 csw.unfreeze（服务端许可复核未通过）')
  }
}

function todayOf(tools: CommandTools): string {
  return tools.now().toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// 重排引擎（CS-12~18：确定性贪心，逐任务可解释）
// ---------------------------------------------------------------------------

interface EngineEquipment {
  id: string
  name: string
  equipmentStatus: number
  workCenterId: string
}

/** [CS-12/13/14/15/18] 引擎主体：返回拟写入的版本条目（不落槽位、不落版本——由处理器持久化）。 */
async function runEngine(
  tools: CommandTools,
  input: {
    plantId: string
    today: string
    horizonDays: number
    weights: PriorityWeights
    matrix: CswChangeoverMatrixRecord | null
  },
): Promise<{
  items: NewCswScheduleVersionItem[]
  summary: { taskTotal: number; kept: number; moved: number; newSlots: number; removed: number; conflicts: number; outsideHorizon: number; startedKept: number }
}> {
  const csw = cswTools(tools).csw
  const rows = await csw.lookups.listSchedulableOrders(input.plantId)
  const freezesActive = (await csw.freezes.list({ plantIds: [input.plantId], status: 'active', page: 1, pageSize: 1000 })).items
  const dates = horizonDates(input.today, input.horizonDays)
  const horizonEnd = dates[dates.length - 1]!

  // 任务装配（订单工序粒度）
  const byOp = new Map<string, typeof rows>()
  for (const row of rows) {
    const list = byOp.get(row.orderOperationId) ?? []
    list.push(row)
    byOp.set(row.orderOperationId, list)
  }
  const tasks: Array<{ task: RescheduleTask; row: (typeof rows)[number] }> = []
  for (const [opId, group] of byOp) {
    const row = group[0]!
    const slots = await csw.lookups.listSlotsByOrderOperation(opId)
    const planned = slots.reduce((acc, s) => cswAddQty(acc, s.plannedQty), '0')
    const outsourcing = await csw.outsourcingTasks.listOccupyingByOrderOperation(opId)
    tasks.push({
      row,
      task: {
        orderOperationId: opId,
        orderId: row.orderId,
        orderNo: row.orderNo,
        seq: row.seq,
        operationDefinitionId: row.operationDefinitionId,
        operationName: row.operationName,
        dimensionValue: dimensionValueOf(
          input.matrix?.dimensionKind ?? 'operation',
          { operationCode: row.operationCode, productAttribute: row.productAttribute },
        ),
        workCenterId: row.workCenterId,
        offlineQty: row.offlineQty,
        plannedQty: planned,
        executionStatus: row.executionStatus,
        dueDate: row.plannedFinishDate,
        outsourced: outsourcing.length > 0,
        uom: row.uom,
      },
    })
  }
  // [CS-17] 交期优先：紧迫度升序（已逾期最前；无计划完成时间最后）
  tasks.sort(
    (a, b) =>
      dueDateUrgency(a.task.dueDate, input.today) - dueDateUrgency(b.task.dueDate, input.today) ||
      a.row.orderNo.localeCompare(b.row.orderNo) ||
      a.task.seq - b.task.seq,
  )

  const items: NewCswScheduleVersionItem[] = []
  const summary = { taskTotal: tasks.length, kept: 0, moved: 0, newSlots: 0, removed: 0, conflicts: 0, outsideHorizon: 0, startedKept: 0 }
  let itemNo = 0
  const pushItem = (item: Omit<NewCswScheduleVersionItem, 'itemNo'>): number => {
    itemNo += 1
    items.push({ ...item, itemNo })
    return itemNo
  }

  // 设备/校准/停机/产能 缓存（按工作中心懒加载）
  const equipmentCache = new Map<string, EngineEquipment[]>()
  const calibrationCache = new Map<string, Awaited<ReturnType<typeof csw.calibration.findByEquipment>>>()
  const downtimeCache = new Map<string, Awaited<ReturnType<typeof csw.downtimes.listActiveByEquipment>>>()
  // 日负载与日末维度值（含既有槽位）
  const dayLoad = new Map<string, string>()
  const dayLastDim = new Map<string, string>()

  const ensureEquipment = async (workCenterId: string): Promise<EngineEquipment[]> => {
    const cached = equipmentCache.get(workCenterId)
    if (cached !== undefined) return cached
    const list = (await cswTools(tools).scheduling.lookups.listActiveEquipmentsByWorkCenter(workCenterId)).map((e) => ({
      id: e.id,
      name: e.name,
      equipmentStatus: e.equipmentStatus,
      workCenterId: e.workCenterId,
    }))
    equipmentCache.set(workCenterId, list)
    // 预载既有日负载（该工作中心全部设备 × 窗口）
    for (const eq of list) {
      const slots = await csw.lookups.listSlotsByEquipmentAndDateRange(eq.id, input.today, horizonEnd)
      for (const s of slots) {
        const key = `${eq.id}|${s.productionDate}`
        dayLoad.set(key, cswAddQty(dayLoad.get(key) ?? '0', s.plannedQty))
      }
      const cal = await csw.calibration.findByEquipment(eq.id)
      calibrationCache.set(eq.id, cal)
      const down = await csw.downtimes.listActiveByEquipment(eq.id)
      downtimeCache.set(eq.id, down)
    }
    return list
  }
  for (const { task } of tasks) {
    const slots = await csw.lookups.listSlotsByOrderOperation(task.orderOperationId)
    const started = task.executionStatus === 'executed'
    // 既有槽位分类（冻结/已开工 → keep；窗口外 → 仅列示）
    for (const s of slots) {
      const frozen = isSlotFrozen(
        { id: s.id, equipmentId: s.equipmentId, productionDate: s.productionDate },
        freezesActive,
      )
      if (s.productionDate > horizonEnd) {
        summary.outsideHorizon += 1
        pushItem({
          action: 'outside_horizon',
          orderOperationId: task.orderOperationId,
          orderId: task.orderId,
          orderNo: task.orderNo,
          operationName: task.operationName,
          operationDefinitionId: task.operationDefinitionId,
          equipmentId: s.equipmentId,
          productionDate: s.productionDate,
          plannedQty: s.plannedQty,
          slotId: s.id,
          frozen,
          started,
          explanation: { why: `${task.orderNo} ${task.operationName}：槽位生产日期在求解窗口（至 ${horizonEnd}）外，不参与优化、仅列示（CS-18）` },
        })
        continue
      }
      const cls = classifyExistingSlot({ id: s.id, frozen, started })
      if (cls === 'keep') {
        summary.kept += 1
        if (started) summary.startedKept += 1
        pushItem({
          action: 'keep',
          orderOperationId: task.orderOperationId,
          orderId: task.orderId,
          orderNo: task.orderNo,
          operationName: task.operationName,
          operationDefinitionId: task.operationDefinitionId,
          equipmentId: s.equipmentId,
          productionDate: s.productionDate,
          plannedQty: s.plannedQty,
          slotId: s.id,
          frozen,
          started,
          explanation: {
            why: started
              ? `${task.orderNo} ${task.operationName}：工序已开工，槽位不被自动移动，须人工决策（CS-14）`
              : `${task.orderNo} ${task.operationName}：槽位位于冻结窗口（${s.productionDate}），对自动重排只读（CS-11）`,
          },
        })
      }
    }
    const movable = slots.filter(
      (s) =>
        s.productionDate <= horizonEnd &&
        classifyExistingSlot({
          id: s.id,
          frozen: isSlotFrozen({ id: s.id, equipmentId: s.equipmentId, productionDate: s.productionDate }, freezesActive),
          started,
        }) === 'movable',
    )
    const remaining = remainingQtyOf(task)
    const movableQty = movable.reduce((acc, s) => cswAddQty(acc, s.plannedQty), '0')
    const chunk = cswAddQty(remaining, movableQty)

    if (cswCmpQty(chunk, '0') <= 0) continue // 已排满且无可动槽位
    if (started) {
      // [CS-14] 已开工任务不被自动移动：仅对余量出冲突项（须人工决策）
      summary.conflicts += 1
      const conflict = buildConflictItem({ task, horizonLastDate: horizonEnd, candidates: [], hasAnyEquipmentCandidate: false })
      pushItem({
        action: 'conflict',
        orderOperationId: task.orderOperationId,
        orderId: task.orderId,
        orderNo: task.orderNo,
        operationName: task.operationName,
        operationDefinitionId: task.operationDefinitionId,
        started,
        needManual: true,
        plannedQty: remaining,
        explanation: { why: `${task.orderNo} ${task.operationName}：工序已开工，余量 ${remaining} 不被自动排产（须人工决策）` },
        suggestions: conflict.suggestions,
      })
      continue
    }
    if (task.outsourced) {
      // [CS-25] 外协占用：本厂设备不排产，仅呈现冲突与建议
      summary.conflicts += 1
      const conflict = buildConflictItem({ task, horizonLastDate: horizonEnd, candidates: [], hasAnyEquipmentCandidate: false })
      pushItem({
        action: 'conflict',
        orderOperationId: task.orderOperationId,
        orderId: task.orderId,
        orderNo: task.orderNo,
        operationName: task.operationName,
        operationDefinitionId: task.operationDefinitionId,
        needManual: false,
        plannedQty: chunk,
        explanation: { why: `${task.orderNo} ${task.operationName}：工序外协占用中（CS-25），本厂设备不排产；回厂检验通过后完成判定走报工/接收事实` },
        suggestions: conflict.suggestions.filter((s) => s.option !== 'outsourcing'),
      })
      continue
    }

    const equipments = await ensureEquipment(task.workCenterId)
    const weightsNum = {
      changeover: Number(input.weights.changeover),
      loadBalance: Number(input.weights.loadBalance),
    }
    const candidates: CandidateEvaluation[] = []
    for (const eq of equipments) {
      const cal = calibrationCache.get(eq.id) ?? null
      const downtimes = downtimeCache.get(eq.id) ?? []
      for (const date of dates) {
        const downtimeFraction = downtimes.reduce(
          (max, d) => Math.max(max, downtimeOccupancyFraction({ equipmentId: d.equipmentId, from: d.fromAt, to: d.toAt, kind: d.kind }, date)),
          0,
        )
        const capacityRow = await cswTools(tools).scheduling.capacities.findByEquipmentAndDate(eq.id, date)
        const key = `${eq.id}|${date}`
        // 本任务可动槽位视为重排资源：其原占用量从当日负载中剔除
        const movableOnKey = movable
          .filter((s) => `${s.equipmentId}|${s.productionDate}` === key)
          .reduce((acc, s) => cswAddQty(acc, s.plannedQty), '0')
        let dayPlannedQty = dayLoad.get(key) ?? '0'
        if (cswCmpQty(movableOnKey, '0') > 0) {
          dayPlannedQty = cswAddQty(dayPlannedQty, negate(movableOnKey))
        }
        const capacity = capacityRow === null ? null : effectiveCapacityForDate({ capacity: capacityRow.capacity, downtimeFraction })
        const candidate: CandidateInput = {
          equipmentId: eq.id,
          equipmentName: eq.name,
          equipmentStatus: eq.equipmentStatus,
          calibrationEffect: calibrationEffectAt(cal, date),
          downtimeFraction,
          frozen: isEquipmentDateFrozen(eq.id, date, freezesActive),
          capacity,
          dayPlannedQty,
          previousDimensionValue: dayLastDim.get(key) ?? null,
          productionDate: date,
        }
        candidates.push(evaluateCandidate(task, candidate, chunk, weightsNum, (prev, next) => lookupChangeoverMinutes(
          input.matrix === null
            ? null
            : { id: input.matrix.id, plantId: input.matrix.plantId, versionNo: input.matrix.versionNo, dimensionKind: input.matrix.dimensionKind, defaultMinutes: input.matrix.defaultMinutes, entries: input.matrix.entries },
          prev,
          next,
        )))
      }
    }
    const chosen = selectBestCandidate(candidates)
    const explanation = buildTaskExplanation({ orderNo: task.orderNo, operationName: task.operationName, chosen, candidates })
    if (chosen === null) {
      // [CS-15] 无解呈现：不静默丢弃，冲突集+可选建议
      summary.conflicts += 1
      const conflict = buildConflictItem({ task, horizonLastDate: horizonEnd, candidates, hasAnyEquipmentCandidate: equipments.length > 0 })
      pushItem({
        action: 'conflict',
        orderOperationId: task.orderOperationId,
        orderId: task.orderId,
        orderNo: task.orderNo,
        operationName: task.operationName,
        operationDefinitionId: task.operationDefinitionId,
        plannedQty: remaining,
        explanation: { why: explanation.why, hitConstraints: explanation.hitConstraints, rejectedAlternatives: explanation.rejectedAlternatives, conflictSet: conflict.conflictSet },
        suggestions: conflict.suggestions,
      })
      continue
    }
    // 中选：落位并推进日负载/日末维度
    const key = `${chosen.equipmentId}|${chosen.productionDate}`
    dayLoad.set(key, cswAddQty(dayLoad.get(key) ?? '0', chunk))
    dayLastDim.set(key, task.dimensionValue)
    // 可动槽位原占用量从其原日负载剔除
    for (const s of movable) {
      const mKey = `${s.equipmentId}|${s.productionDate}`
      dayLoad.set(mKey, cswAddQty(dayLoad.get(mKey) ?? '0', negate(s.plannedQty)))
    }
    const sameKeySlot = movable.find((s) => `${s.equipmentId}|${s.productionDate}` === key) ?? null
    if (sameKeySlot !== null) {
      summary.moved += 1
      pushItem({
        action: 'move',
        orderOperationId: task.orderOperationId,
        orderId: task.orderId,
        orderNo: task.orderNo,
        operationName: task.operationName,
        operationDefinitionId: task.operationDefinitionId,
        equipmentId: chosen.equipmentId,
        productionDate: chosen.productionDate,
        plannedQty: chunk,
        slotId: sameKeySlot.id,
        softViolations: chosen.softViolations,
        explanation: { why: explanation.why, hitConstraints: explanation.hitConstraints, rejectedAlternatives: explanation.rejectedAlternatives },
      })
    } else {
      summary.newSlots += 1
      pushItem({
        action: 'new',
        orderOperationId: task.orderOperationId,
        orderId: task.orderId,
        orderNo: task.orderNo,
        operationName: task.operationName,
        operationDefinitionId: task.operationDefinitionId,
        equipmentId: chosen.equipmentId,
        productionDate: chosen.productionDate,
        plannedQty: chunk,
        softViolations: chosen.softViolations,
        explanation: { why: explanation.why, hitConstraints: explanation.hitConstraints, rejectedAlternatives: explanation.rejectedAlternatives },
      })
    }
    for (const s of movable) {
      if (sameKeySlot !== null && s.id === sameKeySlot.id) continue
      summary.removed += 1
      pushItem({
        action: 'remove',
        orderOperationId: task.orderOperationId,
        orderId: task.orderId,
        orderNo: task.orderNo,
        operationName: task.operationName,
        operationDefinitionId: task.operationDefinitionId,
        equipmentId: s.equipmentId,
        productionDate: s.productionDate,
        plannedQty: s.plannedQty,
        slotId: s.id,
        explanation: { why: `${task.orderNo} ${task.operationName}：槽位并入重排（整槽移动语义，删除后由中选位承接）` },
      })
    }
  }
  return { items, summary }
}

/** 数量取负（csw shared 无负数量语义；引擎内部负载剔除用，格式化后即减）。 */
function negate(qty: string): string {
  return qty.startsWith('-') ? qty.slice(1) : `-${qty}`
}

// ---------------------------------------------------------------------------
// 命令处理器
// ---------------------------------------------------------------------------

export function createCswCommandHandlers(): CommandHandler[] {
  // ---------------- 冻结（CS-11/S2） ----------------

  const freezeCreate: CommandHandler = {
    commandType: 'csw.freeze.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const plantId = str(p, 'plantId')
        const equipmentId = str(p, 'equipmentId')
        const scope = str(p, 'scope') === 'slot' ? 'slot' : 'equipment_date_range'
        const dateFrom = str(p, 'productionDateFrom')
        const dateTo = str(p, 'productionDateTo')
        if (!plantId || !equipmentId || !dateFrom || !dateTo) {
          return bad('payload 需要 plantId/equipmentId/productionDateFrom/productionDateTo')
        }
        await assertWriteScope(tools, plantId)
        const equipment = await cswTools(tools).scheduling.lookups.findEquipment(equipmentId)
        if (equipment === null || equipment.enterpriseId !== ctx.enterpriseId) {
          return bad('设备不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        if (equipment.plantId !== plantId) {
          return bad('[CS-11] 冻结设备不属于目标工厂（厂级隔离）')
        }
        const slotId: string | null = str(p, 'slotId') ?? null
        if (scope === 'slot') {
          if (slotId === null) return bad('[CS-11] 单槽位冻结必须携带 slotId')
          const slot = await cswTools(tools).scheduling.slots.findById(slotId)
          if (slot === null) return bad('槽位不存在', ERROR_CODES.NOT_FOUND)
          if (slot.equipmentId !== equipmentId) return bad('[CS-11] 单槽位冻结的设备与槽位不一致')
          if (dateFrom !== slot.productionDate || dateTo !== slot.productionDate) {
            return bad('[CS-11] 单槽位冻结的日期区间必须与槽位生产日期一致（单生产日）')
          }
        }
        assertFreezeShape({ scope, equipmentId, productionDateFrom: dateFrom, productionDateTo: dateTo, slotId })
        const active = await cswTools(tools).csw.freezes.listActiveByEquipment(equipmentId)
        assertNoActiveFreezeOverlap(
          { scope, equipmentId, productionDateFrom: dateFrom, productionDateTo: dateTo, slotId },
          active,
        )
        const saved = await cswTools(tools).csw.freezes.insert({
          enterpriseId: ctx.enterpriseId,
          plantId,
          scope,
          equipmentId,
          productionDateFrom: dateFrom,
          productionDateTo: dateTo,
          slotId,
          reason: str(p, 'reason') ?? null,
          frozenBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'csw.freeze.create',
          subjectType: 'csw_freeze_record',
          subjectId: saved.id,
          after: { scope, equipmentId, dateFrom, dateTo, slotId },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { freezeId: saved.id, scope, equipmentId, productionDateFrom: dateFrom, productionDateTo: dateTo, slotId } }
      }),
  }

  const freezeRelease: CommandHandler = {
    commandType: 'csw.freeze.release',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const freezeId = str(p, 'freezeId')
        if (!freezeId) return bad('payload 需要 freezeId')
        await assertUnfreezePermission(tools) // [CS-11] 具名权限二道防线
        const reason = str(p, 'reason') ?? ctx.reason ?? null
        assertUnfreezeReasonProvided(reason)
        const record = await cswTools(tools).csw.freezes.lockById(freezeId)
        if (record === null) return bad('冻结记录不存在', ERROR_CODES.NOT_FOUND)
        if (record.enterpriseId !== ctx.enterpriseId) return bad('冻结记录不属于本企业', ERROR_CODES.NOT_FOUND)
        await assertWriteScope(tools, record.plantId)
        if (record.status !== 'active') return bad('[CS-11] 冻结记录已解冻，不可重复解冻')
        const released = await cswTools(tools).csw.freezes.release(freezeId, {
          unfrozenBy: ctx.actorLoginName,
          unfreezeReason: reason,
          unfrozenAt: tools.now().toISOString(),
        })
        // [CS-26/S5] 高影响覆盖动作留痕：解冻行 操作者/理由/影响清单
        await cswTools(tools).csw.overrides.insert({
          enterpriseId: record.enterpriseId,
          plantId: record.plantId,
          overrideType: 'unfreeze',
          operator: ctx.actorLoginName,
          reason,
          affectedTasks: [`${record.equipmentId}|${record.productionDateFrom}~${record.productionDateTo}`],
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'csw.freeze.release',
          subjectType: 'csw_freeze_record',
          subjectId: freezeId,
          before: { status: 'active' },
          after: { status: 'ended', reason },
          reason,
        })
        return { status: 'COMMITTED', data: { freezeId, status: released.status, unfrozenBy: released.unfrozenBy, unfrozenAt: released.unfrozenAt } }
      }),
  }

  // ---------------- 换型矩阵（CS-16/S3） ----------------

  const changeoverPublish: CommandHandler = {
    commandType: 'csw.changeover.publish',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const plantId = str(p, 'plantId')
        const dimensionKind = str(p, 'dimensionKind') === 'product_attribute' ? 'product_attribute' : 'operation'
        const defaultMinutesRaw = p['defaultMinutes']
        if (!plantId || typeof defaultMinutesRaw !== 'number') {
          return bad('payload 需要 plantId/defaultMinutes/entries')
        }
        await assertWriteScope(tools, plantId)
        const rawEntries = p['entries']
        if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
          return bad('[CS-16] entries 必须为非空数组（维度键 → 换型时长）')
        }
        const entries = rawEntries.map((raw, i) => {
          const e = (raw ?? {}) as Payload
          const from = str(e, 'fromValue')
          const to = str(e, 'toValue')
          const minutes = e['minutes']
          if (!from || !to || typeof minutes !== 'number') {
            throw new CswRuleViolation('CS-16', `条目[${i}] 需要 fromValue/toValue/minutes`)
          }
          return { fromValue: from, toValue: to, minutes }
        })
        assertMatrixPublishable({ dimensionKind, defaultMinutes: defaultMinutesRaw, entries })
        const latest = await cswTools(tools).csw.matrices.findLatestByPlant(plantId)
        const versionNo = nextMatrixVersionNo(latest === null ? 0 : latest.versionNo)
        const saved = await cswTools(tools).csw.matrices.insert({
          enterpriseId: ctx.enterpriseId,
          plantId,
          versionNo,
          dimensionKind,
          defaultMinutes: defaultMinutesRaw,
          entries,
          note: str(p, 'note') ?? null,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'csw.changeover.publish',
          subjectType: 'csw_changeover_matrix',
          subjectId: saved.id,
          after: { plantId, versionNo, dimensionKind, defaultMinutes: defaultMinutesRaw, entryCount: entries.length },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { matrixId: saved.id, versionNo, dimensionKind, defaultMinutes: defaultMinutesRaw, entryCount: entries.length } }
      }),
  }

  // ---------------- 校准状态等价服务（CS-05③/CS-10；收编请求→T23 spc） ----------------

  const calibrationSet: CommandHandler = {
    commandType: 'csw.calibration.state.set',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const plantId = str(p, 'plantId')
        const equipmentId = str(p, 'equipmentId')
        const calibrationResult = str(p, 'calibrationResult')
        if (!plantId || !equipmentId || !calibrationResult) {
          return bad('payload 需要 plantId/equipmentId/calibrationResult')
        }
        if (calibrationResult !== 'qualified' && calibrationResult !== 'limited' && calibrationResult !== 'invalid') {
          return bad('[CS-10] calibrationResult 须为 qualified/limited/invalid（对齐 PE-15 结果枚举）')
        }
        await assertWriteScope(tools, plantId)
        const equipment = await cswTools(tools).scheduling.lookups.findEquipment(equipmentId)
        if (equipment === null || equipment.enterpriseId !== ctx.enterpriseId) {
          return bad('设备不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        const validUntil = str(p, 'validUntil') ?? null
        if (validUntil !== null && !isValidProductionDate(validUntil)) {
          return bad('[CS-10] validUntil 必须为 YYYY-MM-DD')
        }
        const today = todayOf(tools)
        // [CS-10] 失效设备的已排槽位标记清单（不删除，仅提示）
        const slots = await cswTools(tools).csw.lookups.listSlotsByEquipmentAndDateRange(equipmentId, today, '2999-12-31')
        const flagged = flagSlotsForCalibration(
          slots.map((s) => ({ id: s.id, equipmentId: s.equipmentId, productionDate: s.productionDate })),
          { equipmentId, calibrationResult, validUntil },
          today,
        )
        const saved = await cswTools(tools).csw.calibration.upsert({
          enterpriseId: ctx.enterpriseId,
          plantId,
          equipmentId,
          calibrationResult,
          validUntil,
          certificateNo: str(p, 'certificateNo') ?? null,
          affectedSlotIds: flagged.map((f) => f.slotId),
          updatedBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'csw.calibration.state.set',
          subjectType: 'csw_equipment_calibration_state',
          subjectId: saved.id,
          after: { equipmentId, calibrationResult, validUntil, flaggedSlots: flagged.length },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: {
            stateId: saved.id,
            equipmentId,
            calibrationResult,
            validUntil,
            flaggedSlotIds: flagged.map((f) => f.slotId),
            note: '等价服务（收编请求：T23 spc calibration_record 落地整合后由 L0 切换数据源）',
          },
        }
      }),
  }

  // ---------------- 停机等价服务（CS-09；收编请求→T19 downtime_event） ----------------

  const downtimeRegister: CommandHandler = {
    commandType: 'csw.downtime.register',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const plantId = str(p, 'plantId')
        const equipmentId = str(p, 'equipmentId')
        const fromAt = str(p, 'fromAt')
        const toAt = str(p, 'toAt')
        if (!plantId || !equipmentId || !fromAt || !toAt) {
          return bad('payload 需要 plantId/equipmentId/fromAt/toAt')
        }
        await assertWriteScope(tools, plantId)
        const equipment = await cswTools(tools).scheduling.lookups.findEquipment(equipmentId)
        if (equipment === null || equipment.enterpriseId !== ctx.enterpriseId) {
          return bad('设备不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        if (equipment.plantId !== plantId) return bad('[CS-09] 停机设备不属于目标工厂（厂级隔离）')
        const kind = str(p, 'kind') === 'repair' ? 'repair' : str(p, 'kind') === 'other' ? 'other' : 'planned_maintenance'
        if (fromAt > toAt) return bad('[CS-09] 停机窗口倒置（fromAt > toAt）')
        const saved = await cswTools(tools).csw.downtimes.insert({
          enterpriseId: ctx.enterpriseId,
          plantId,
          equipmentId,
          kind,
          fromAt,
          toAt,
          note: str(p, 'note') ?? null,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'csw.downtime.register',
          subjectType: 'csw_equipment_downtime',
          subjectId: saved.id,
          after: { equipmentId, kind, fromAt, toAt },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { downtimeId: saved.id, equipmentId, kind, fromAt, toAt, status: saved.status } }
      }),
  }

  const downtimeClose: CommandHandler = {
    commandType: 'csw.downtime.close',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const downtimeId = str(p, 'downtimeId')
        if (!downtimeId) return bad('payload 需要 downtimeId')
        const record = await cswTools(tools).csw.downtimes.lockById(downtimeId)
        if (record === null) return bad('停机记录不存在', ERROR_CODES.NOT_FOUND)
        if (record.enterpriseId !== ctx.enterpriseId) return bad('停机记录不属于本企业', ERROR_CODES.NOT_FOUND)
        await assertWriteScope(tools, record.plantId)
        if (record.status !== 'active') return bad('[CS-09] 停机记录已关闭')
        // [CS-09] 维修关闭触发受影响排程的计划评估：受影响槽位清单（提示计划员，不自动重排）
        const impact = await cswTools(tools).csw.lookups.listSlotsByEquipmentAndDateRange(
          record.equipmentId,
          record.fromAt.slice(0, 10),
          record.toAt.slice(0, 10),
        )
        const closed = await cswTools(tools).csw.downtimes.close(downtimeId, {
          closedBy: ctx.actorLoginName,
          closedAt: tools.now().toISOString(),
          impactSlotIds: impact.map((s) => s.id),
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'csw.downtime.close',
          subjectType: 'csw_equipment_downtime',
          subjectId: downtimeId,
          after: { impactedSlots: impact.length },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: {
            downtimeId,
            status: closed.status,
            impactedSlotIds: closed.impactSlotIds,
            prompt: '受影响排程清单已生成（提示计划员评估，不自动重排）',
          },
        }
      }),
  }

  // ---------------- 重排建议与提交（CS-12~18/CS-04/CS-26/CS-27） ----------------

  const reschedulePropose: CommandHandler = {
    commandType: 'csw.reschedule.propose',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const plantId = str(p, 'plantId')
        if (!plantId) return bad('payload 需要 plantId')
        await assertWriteScope(tools, plantId)
        const today = str(p, 'today') ?? todayOf(tools)
        if (!isValidProductionDate(today)) return bad('[CS-18] today 必须为 YYYY-MM-DD')
        const horizonDaysRaw = typeof p['horizonDays'] === 'number' ? (p['horizonDays'] as number) : DEFAULT_HORIZON_DAYS
        assertHorizonDaysValid(horizonDaysRaw)
        const weightsRaw = (p['weights'] ?? {}) as Payload
        const weights: PriorityWeights = {
          dueDate: str(weightsRaw, 'dueDate') ?? DEFAULT_PRIORITY_WEIGHTS.dueDate,
          changeover: str(weightsRaw, 'changeover') ?? DEFAULT_PRIORITY_WEIGHTS.changeover,
          loadBalance: str(weightsRaw, 'loadBalance') ?? DEFAULT_PRIORITY_WEIGHTS.loadBalance,
        }
        assertPriorityWeightsValid(weights)
        // [CS-26] 权重修改须记录操作者/理由/影响清单
        if (weightsDifferFromDefault(weights)) {
          const reason = str(p, 'reason') ?? ctx.reason ?? null
          if (reason === null || reason.trim() === '') {
            return bad('[CS-26] 约束权重修改必须填写理由（偏离默认权重的建议须留痕）')
          }
        }
        const matrix = await cswTools(tools).csw.matrices.findLatestByPlant(plantId)
        const engine = await runEngine(tools, { plantId, today, horizonDays: horizonDaysRaw, weights, matrix })
        const versionNo = await cswTools(tools).csw.versions.nextVersionNo(plantId)
        const latestCommitted = await cswTools(tools).csw.versions.findLatestCommitted(plantId)
        const version = await cswTools(tools).csw.versions.insert({
          enterpriseId: ctx.enterpriseId,
          plantId,
          versionNo,
          source: 'system_suggestion',
          parentVersionId: latestCommitted === null ? null : latestCommitted.id,
          matrixVersionId: matrix === null ? null : matrix.id,
          weights,
          horizonDays: horizonDaysRaw,
          horizonFrom: today,
          proposedBy: ctx.actorLoginName,
        })
        await cswTools(tools).csw.versionItems.insertMany(version.id, engine.items)
        if (weightsDifferFromDefault(weights)) {
          await cswTools(tools).csw.overrides.insert({
            enterpriseId: ctx.enterpriseId,
            plantId,
            overrideType: 'weight_change',
            operator: ctx.actorLoginName,
            reason: str(p, 'reason') ?? ctx.reason ?? '',
            affectedTasks: engine.items.map((i) => `${i.orderNo}/${i.operationName}`),
            scheduleVersionId: version.id,
          })
        }
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'csw.reschedule.propose',
          subjectType: 'csw_schedule_version',
          subjectId: version.id,
          after: { plantId, versionNo, horizonDays: horizonDaysRaw, weights, summary: engine.summary },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: {
            versionId: version.id,
            versionNo,
            status: version.status,
            weights,
            horizonDays: horizonDaysRaw,
            horizonFrom: today,
            matrixVersionNo: matrix === null ? null : matrix.versionNo,
            summary: engine.summary,
            items: engine.items,
          },
        }
      }),
  }

  const rescheduleCommit: CommandHandler = {
    commandType: 'csw.reschedule.commit',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const versionId = str(p, 'versionId')
        if (!versionId) return bad('payload 需要 versionId')
        const version = await cswTools(tools).csw.versions.lockById(versionId)
        if (version === null) return bad('排程版本不存在', ERROR_CODES.NOT_FOUND)
        if (version.enterpriseId !== ctx.enterpriseId) return bad('排程版本不属于本企业', ERROR_CODES.NOT_FOUND)
        await assertWriteScope(tools, version.plantId)
        if (version.status !== 'proposed') {
          return bad(`[CS-27] 排程版本状态为 ${version.status}，仅 proposed 版本可提交（历史版本不被静默改写）`)
        }
        const items = await cswTools(tools).csw.versionItems.listByVersion(versionId)

        // 人工覆盖（CS-13：操作者、理由、影响任务清单）
        const overridesRaw = p['overrides']
        const overrideList: Array<{ itemNo: number; equipmentId?: string; productionDate?: string; plannedQty?: string }> = []
        if (Array.isArray(overridesRaw) && overridesRaw.length > 0) {
          const overrideReason = str(p, 'reason') ?? ctx.reason ?? null
          if (overrideReason === null || overrideReason.trim() === '') {
            return bad('[CS-13] 人工覆盖建议必须填写理由（操作者、理由、影响任务清单留痕）')
          }
          for (const raw of overridesRaw) {
            const o = (raw ?? {}) as Payload
            const itemNo = o['itemNo']
            if (typeof itemNo !== 'number') return bad('[CS-13] overrides[].itemNo 必填')
            overrideList.push({
              itemNo,
              equipmentId: str(o, 'equipmentId'),
              productionDate: str(o, 'productionDate'),
              plannedQty: dec(o, 'plannedQty'),
            })
          }
        }

        // 覆盖应用 + 硬约束复检输入装配
        const finalItems = items.map((item) => {
          const ov = overrideList.find((o) => o.itemNo === item.itemNo)
          if (ov === undefined) return item
          if (item.action === 'keep' && (item.frozen || item.started)) {
            throw new CswRuleViolation(item.frozen ? 'CS-11' : 'CS-14', `条目 ${item.itemNo} 为${item.frozen ? '冻结' : '已开工'}槽位，不可被提交覆盖（先解冻或人工单独决策）`)
          }
          if (item.action === 'conflict' || item.action === 'outside_horizon') {
            throw new CswRuleViolation('CS-15', `条目 ${item.itemNo} 为${item.action === 'conflict' ? '冲突' : '窗口外'}条目，不可覆盖为排产（走对应处置通道）`)
          }
          return {
            ...item,
            equipmentId: ov.equipmentId ?? item.equipmentId,
            productionDate: ov.productionDate ?? item.productionDate,
            plannedQty: ov.plannedQty ?? item.plannedQty,
          }
        })

        // [CS-04] 硬约束复检（提交侧总闸：不绕过）
        const freezesActive = (await cswTools(tools).csw.freezes.list({ plantIds: [version.plantId], status: 'active', page: 1, pageSize: 1000 })).items
        const writeItems = finalItems.filter((i) => i.action === 'new' || i.action === 'move' || i.action === 'remove')
        for (const item of writeItems) {
          const op = await cswTools(tools).scheduling.lookups.findOrderOperation(item.orderOperationId)
          if (op === null) return bad(`条目 ${item.itemNo} 的订单工序不存在`, ERROR_CODES.NOT_FOUND)
          // ④ 冻结：目标 (设备,日期) 冻结拒；被删/移槽位自身冻结拒
          if (item.equipmentId !== null && item.productionDate !== null) {
            if (isEquipmentDateFrozen(item.equipmentId, item.productionDate, freezesActive)) {
              throw new CswRuleViolation('CS-11', `条目 ${item.itemNo} 目标 ${item.equipmentId}@${item.productionDate} 在冻结窗口内，先解冻（具名权限+理由）再提交`)
            }
          }
          if (item.action === 'remove' && item.slotId !== null) {
            const slot = await cswTools(tools).scheduling.slots.findById(item.slotId)
            if (slot !== null) {
              if (isSlotFrozen({ id: slot.id, equipmentId: slot.equipmentId, productionDate: slot.productionDate }, freezesActive)) {
                throw new CswRuleViolation('CS-11', `条目 ${item.itemNo} 删除的槽位在冻结窗口内，先解冻再提交`)
              }
              if (item.started) {
                throw new CswRuleViolation('CS-14', `条目 ${item.itemNo} 的工序已开工，已开工任务不被自动移动，须人工决策`)
              }
            }
          }
          // ③ 校准 / ② 维修（新建正数槽位；move 视为同键替换或新建）
          if ((item.action === 'new' || item.action === 'move') && item.equipmentId !== null && item.plannedQty !== null) {
            const equipment = await cswTools(tools).scheduling.lookups.findEquipment(item.equipmentId)
            if (equipment === null) return bad(`条目 ${item.itemNo} 的设备不存在`, ERROR_CODES.NOT_FOUND)
            const cal = await cswTools(tools).csw.calibration.findByEquipment(item.equipmentId)
            const effect = calibrationEffectAt(cal, item.productionDate ?? todayOf(tools))
            const existing = item.slotId !== null ? await cswTools(tools).scheduling.slots.findById(item.slotId) : null
            const existingIdentity: SlotIdentityKey = {
              orderId: item.orderId,
              orderOperationId: item.orderOperationId,
              operationDefinitionId: item.operationDefinitionId,
              equipmentId: item.equipmentId,
              productionDate: item.productionDate ?? todayOf(tools),
            }
            const sameKey = existing !== null && existing.equipmentId === existingIdentity.equipmentId && existing.productionDate === existingIdentity.productionDate
              ? existing
              : await cswTools(tools).scheduling.slots.findSlot(existingIdentity)
            assertCalibrationAllowsNewSlot({
              effect,
              equipmentName: equipment.name,
              existingSlotPlannedQty: sameKey === null ? null : sameKey.plannedQty,
              newPlannedQty: item.plannedQty,
            })
            // ② 维修（A3-3 同口径：维修且该键无既有槽 → 拒新建正数）
            if (equipment.equipmentStatus === 2 && sameKey === null) {
              throw new CswRuleViolation('CS-05', `设备【${equipment.name}】处于维修状态且该槽位尚无排产，不可新建正数排产`)
            }
            // [CS-25] 外协占用
            const occupying = await cswTools(tools).csw.outsourcingTasks.listOccupyingByOrderOperation(item.orderOperationId)
            if (occupying.length > 0) {
              assertQtyNonNegative(item.plannedQty, '计划产量', 'CS-25')
              throw new CswRuleViolation(
                'CS-25',
                `订单工序已挂接外协任务 ${occupying[0]!.taskNo}（外协期间本厂设备不排产）`,
              )
            }
          }
        }
        // ① 工序计划合计 ≤ 下线数量（A3-2 同链复检：其它槽合计 + 本版本对该工序的净变化；
        //    "其它"须剔除：被删除的槽位、被 move 整槽替换的槽位、与 new/move 同键的既有槽位——
        //    同键 upsert 语义下本槽按替换旧值计，不得双计）
        const touchedOps = new Set(writeItems.map((i) => i.orderOperationId))
        const removedSlotIds = new Set(
          writeItems
            .filter((i) => (i.action === 'remove' || i.action === 'move') && i.slotId !== null)
            .map((i) => i.slotId as string),
        )
        const replaceIdentities = new Set(
          writeItems
            .filter((i) => (i.action === 'new' || i.action === 'move') && i.equipmentId !== null && i.productionDate !== null)
            .map((i) => [i.orderId, i.orderOperationId, i.operationDefinitionId, i.equipmentId, i.productionDate].join('|')),
        )
        for (const opId of touchedOps) {
          const op = await cswTools(tools).scheduling.lookups.findOrderOperation(opId)
          if (op === null) continue
          const slots = await cswTools(tools).csw.lookups.listSlotsByOrderOperation(opId)
          const otherTotal = slots
            .filter(
              (s) =>
                !removedSlotIds.has(s.id) &&
                !replaceIdentities.has(
                  [s.orderId, s.orderOperationId, s.operationDefinitionId, s.equipmentId, s.productionDate].join('|'),
                ),
            )
            .reduce((acc, s) => cswAddQty(acc, s.plannedQty), '0')
          const batchTotal = writeItems
            .filter((i) => i.orderOperationId === opId && (i.action === 'new' || i.action === 'move') && i.plannedQty !== null)
            .reduce((acc, i) => cswAddQty(acc, i.plannedQty as string), '0')
          if (cswCmpQty(cswAddQty(otherTotal, batchTotal), op.offlineQty) > 0) {
            throw new CswRuleViolation(
              'CS-05',
              `工序 ${op.operationName} 计划合计 ${cswAddQty(otherTotal, batchTotal)} 超过下线数量 ${op.offlineQty}（本版本按替换旧值计），禁止提交`,
            )
          }
        }
        assertNoHardConstraintHit([]) // 总闸占位（上方逐项已断言）

        // 软约束确认（CS-04/06：违反须填写理由与责任人后方可提交）
        const softHits = finalItems.filter(
          (i) => (i.action === 'new' || i.action === 'move') && i.softViolations.length > 0,
        )
        const confirm = p['confirm'] === true
        if (softHits.length > 0 && !confirm) {
          const first = softHits[0]!
          return bad(
            `[CS-06] ${first.softViolations[0]!.code}：${first.softViolations[0]!.detail}（软约束违反须填写理由与责任人后携带 confirm=true 重新提交；共 ${softHits.length} 条目命中软约束）`,
          )
        }
        if (softHits.length > 0) {
          const softReason = str(p, 'reason') ?? ctx.reason ?? null
          if (softReason === null || softReason.trim() === '') {
            return bad('[CS-04] 软约束违反提交必须填写理由（责任人由操作者承载）')
          }
          assertSoftOverrideComplete({
            operator: ctx.actorLoginName,
            reason: softReason,
            affectedScope: `${softHits.length} 条排产条目`,
            softCode: softHits[0]!.softViolations[0]!.code as 'capacity_overrun',
          })
        }

        // 应用（写 T09 槽位表；keep 冲突/窗口外不动）
        const applied = { new: 0, moved: 0, removed: 0 }
        for (const item of writeItems) {
          const identity: SlotIdentityKey = {
            orderId: item.orderId,
            orderOperationId: item.orderOperationId,
            operationDefinitionId: item.operationDefinitionId,
            equipmentId: item.equipmentId as string,
            productionDate: item.productionDate as string,
          }
          if (item.action === 'remove') {
            await cswTools(tools).scheduling.slots.deleteSlot(identity)
            applied.removed += 1
            continue
          }
          // move 条目被人工覆盖到不同 (设备,日期) 时：先删原槽位（整槽移动语义，
          // 防止同工序出现双有效槽位——A3-2 同键替换口径在覆盖改键后不再成立）
          if (item.action === 'move' && item.slotId !== null) {
            const orig = await cswTools(tools).scheduling.slots.findById(item.slotId)
            if (
              orig !== null &&
              (orig.equipmentId !== identity.equipmentId || orig.productionDate !== identity.productionDate)
            ) {
              await cswTools(tools).scheduling.slots.deleteSlot({
                orderId: orig.orderId,
                orderOperationId: orig.orderOperationId,
                operationDefinitionId: orig.operationDefinitionId,
                equipmentId: orig.equipmentId,
                productionDate: orig.productionDate,
              })
              applied.removed += 1
            }
          }
          const op = await cswTools(tools).scheduling.lookups.findOrderOperation(item.orderOperationId)
          await cswTools(tools).scheduling.slots.upsert({
            enterpriseId: version.enterpriseId,
            plantId: version.plantId,
            orderId: identity.orderId,
            orderOperationId: identity.orderOperationId,
            operationDefinitionId: identity.operationDefinitionId,
            equipmentId: identity.equipmentId,
            productionDate: identity.productionDate,
            plannedQty: item.plannedQty as string,
            uom: op === null ? 'PCS' : op.uom,
            remark: `CSW v${version.versionNo}`,
            createdBy: ctx.actorLoginName,
          })
          if (item.action === 'move') applied.moved += 1
          else applied.new += 1
        }

        // 版本链（CS-27）：本版本 → committed；上一 committed → superseded
        const prevCommitted = await cswTools(tools).csw.versions.findLatestCommitted(version.plantId)
        if (prevCommitted !== null && prevCommitted.id !== version.id) {
          assertVersionTransition(prevCommitted.status, 'superseded')
          await cswTools(tools).csw.versions.markSuperseded(prevCommitted.id, tools.now().toISOString())
        }
        assertVersionTransition(version.status, 'committed')
        await cswTools(tools).csw.versions.markCommitted(version.id, {
          committedBy: ctx.actorLoginName,
          committedAt: tools.now().toISOString(),
        })
        // 覆盖审计（CS-13/CS-26）
        if (overrideList.length > 0) {
          await cswTools(tools).csw.overrides.insert({
            enterpriseId: version.enterpriseId,
            plantId: version.plantId,
            overrideType: 'manual_over_suggestion',
            operator: ctx.actorLoginName,
            reason: str(p, 'reason') ?? ctx.reason ?? '',
            affectedTasks: overrideList.map((o) => `item#${o.itemNo}`),
            scheduleVersionId: version.id,
          })
        }
        if (softHits.length > 0) {
          await cswTools(tools).csw.overrides.insert({
            enterpriseId: version.enterpriseId,
            plantId: version.plantId,
            overrideType: 'soft_constraint_confirm',
            operator: ctx.actorLoginName,
            reason: str(p, 'reason') ?? ctx.reason ?? '',
            affectedTasks: softHits.map((i) => `${i.orderNo}/${i.operationName}`),
            scheduleVersionId: version.id,
          })
        }
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'csw.reschedule.commit',
          subjectType: 'csw_schedule_version',
          subjectId: version.id,
          after: { versionNo: version.versionNo, applied, softConfirmed: softHits.length, overrides: overrideList.length },
          reason: ctx.reason ?? null,
        })
        // [CS-14] 受影响任务清单（执行前输出；已开工条目以 keep+needManual 呈现）
        const affectedTasks = items
          .filter((i) => i.action === 'move' || i.action === 'remove' || i.action === 'new')
          .map((i) => ({
            itemNo: i.itemNo,
            orderNo: i.orderNo,
            operationName: i.operationName,
            action: i.action,
            equipmentId: i.equipmentId,
            productionDate: i.productionDate,
            started: i.started,
            needManual: i.started || i.needManual,
          }))
        return {
          status: 'COMMITTED',
          data: { versionId: version.id, versionNo: version.versionNo, status: 'committed', applied, softConfirmed: softHits.length, overrides: overrideList.length, affectedTasks },
        }
      }),
  }

  // ---------------- 外协（CS-19~25） ----------------

  const outsourcingCreate: CommandHandler = {
    commandType: 'csw.outsourcing.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        assertNoSettlementFields(p) // [CS-24] 越界防护
        const orderOperationId = str(p, 'orderOperationId')
        const supplierName = str(p, 'supplierName')
        const qty = dec(p, 'qty')
        const transitLocationId = str(p, 'transitLocationId')
        const transitLocationCode = str(p, 'transitLocationCode')
        if (!orderOperationId || !supplierName || qty === undefined || !transitLocationId || !transitLocationCode) {
          return bad('payload 需要 orderOperationId/supplierName/qty/transitLocationId/transitLocationCode')
        }
        const operation = await cswTools(tools).scheduling.lookups.findOrderOperation(orderOperationId)
        if (operation === null) return bad('订单工序不存在', ERROR_CODES.NOT_FOUND)
        const order = await cswTools(tools).scheduling.lookups.findOrder(operation.orderId)
        if (order === null || order.enterpriseId !== ctx.enterpriseId) {
          return bad('生产订单不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, order.plantId)
        if (order.orderStatus === 'closed' || order.orderStatus === 'voided') {
          return bad('[CS-19] 已结束/已作废订单不可创建外协任务')
        }
        assertQtyPositive(qty, '外协数量')
        if (cswCmpQty(qty, operation.offlineQty) > 0) {
          return bad(`[CS-S4] 外协数量 ${qty} 超过工序下线数量 ${operation.offlineQty}`)
        }
        const location = await cswTools(tools).csw.lookups.findStorageLocation(transitLocationId)
        if (location === null) return bad('外协在途位不存在', ERROR_CODES.NOT_FOUND)
        const returnLocationId = str(p, 'returnLocationId') ?? null
        const returnLocationCode = str(p, 'returnLocationCode') ?? null
        if (returnLocationId !== null) {
          const ret = await cswTools(tools).csw.lookups.findStorageLocation(returnLocationId)
          if (ret === null) return bad('回厂目的位不存在', ERROR_CODES.NOT_FOUND)
        }
        const taskNo = `OWT-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`
        const saved = await cswTools(tools).csw.outsourcingTasks.insert({
          taskNo,
          enterpriseId: ctx.enterpriseId,
          plantId: order.plantId,
          orderId: order.id,
          orderOperationId,
          orderNo: order.orderNo,
          operationName: operation.operationName,
          supplierCode: str(p, 'supplierCode') ?? null,
          supplierName,
          qty,
          uom: operation.uom,
          transitLocationId,
          transitLocationCode,
          returnLocationId,
          returnLocationCode,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'csw.outsourcing.create',
          subjectType: 'csw_outsourcing_task',
          subjectId: saved.id,
          after: { taskNo, orderNo: order.orderNo, operationName: operation.operationName, supplierName, qty },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { taskId: saved.id, taskNo, status: saved.status } }
      }),
  }

  /** 外协任务加载 + 范围二道防线（共用；失败抛 Rejection——任务记录自身含 status 字段，不可用形状判别）。 */
  async function loadOutsourcingTask(
    tools: CommandTools,
    ctxEnterpriseId: string,
    taskId: string,
  ): Promise<CswOutsourcingTaskRecord> {
    const task = await cswTools(tools).csw.outsourcingTasks.lockById(taskId)
    if (task === null) throw new Rejection(bad('外协任务不存在', ERROR_CODES.NOT_FOUND))
    if (task.enterpriseId !== ctxEnterpriseId) {
      throw new Rejection(bad('外协任务不属于本企业', ERROR_CODES.NOT_FOUND))
    }
    await assertWriteScope(tools, task.plantId)
    return task
  }

  /** 具名命令通用执行器（CS-19 状态机校验 → 命令体 → 状态落库留痕）。 */
  async function driveOutsourcing(
    tools: CommandTools,
    ctx: Parameters<CommandHandler['handle']>[1],
    p: Payload,
    action: OutsourcingAction,
    body: (task: CswOutsourcingTaskRecord) => Promise<Partial<CswOutsourcingTaskRecord> | null>,
  ): Promise<HandlerOutcome> {
    const taskId = str(p, 'taskId')
    if (!taskId) return bad('payload 需要 taskId')
    const task = await loadOutsourcingTask(tools, ctx.enterpriseId, taskId)
    if (isOutsourcingTerminal(task.status)) {
      return bad(`[CS-19] 外协任务已处终态「${task.status}」，不可再迁移`)
    }
    const next = assertOutsourcingTransition(action, task.status as OutsourcingStatus)
    const patch = (await body(task)) ?? {}
    const updated = await cswTools(tools).csw.outsourcingTasks.update(task.id, {
      ...patch,
      status: next,
      updatedBy: ctx.actorLoginName,
    })
    await tools.audit.record({
      actor: ctx.actorLoginName,
      action: `csw.outsourcing.${action}`,
      subjectType: 'csw_outsourcing_task',
      subjectId: task.id,
      before: { status: task.status },
      after: { status: next, ...patch },
      reason: ctx.reason ?? null,
    })
    return { status: 'COMMITTED', data: { taskId: task.id, taskNo: task.taskNo, status: updated.status } }
  }

  const outsourcingSubmit: CommandHandler = {
    commandType: 'csw.outsourcing.submit',
    handle: (envelope, ctx, tools) =>
      run(() => driveOutsourcing(tools, ctx, envelope.payload as Payload, 'submit', async () => null)),
  }

  const outsourcingSend: CommandHandler = {
    commandType: 'csw.outsourcing.send',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        assertNoSettlementFields(p)
        const linesRaw = p['lines']
        const lines = Array.isArray(linesRaw)
          ? linesRaw.map((raw) => {
              const l = (raw ?? {}) as Payload
              return { unitId: str(l, 'unitId') ?? '', quantity: dec(l, 'quantity') ?? '' }
            })
          : []
        assertSendLinesShape(lines)
        return driveOutsourcing(tools, ctx, p, 'send', async (task) => {
          const { businessTime, shiftDate } = resolveBusinessTime(cswTools(tools), str(p, 'businessTime'))
          const receiptId = await cswTools(tools).inv.receipts.findIdByKey(ctx.enterpriseId, 'csw.outsourcing.send', envelope.operationId)
          const pc: CswPostingContext = {
            tools: cswTools(tools),
            ctx,
            commandReceiptId: receiptId ?? '',
            businessTime,
            shiftDate,
          }
          if (receiptId === null) {
            throw new CswRuleViolation('CS-S4', '命令回执未落库：幂等键缺失，拒绝记账')
          }
          const sentTotal = lines.reduce((acc, l) => cswAddQty(acc, l.quantity), '0')
          if (cswCmpQty(sentTotal, task.qty) > 0) {
            throw new CswRuleViolation('CS-S4', `发送合计 ${sentTotal} 超过外协任务数量 ${task.qty}`)
          }
          // 全量预校验（逐行存在唯一活动余额）——全部通过后才进入记账序，杜绝部分记账
          for (const l of lines) {
            const pre = await cswTools(tools).inv.units.findById(l.unitId)
            if (pre === null) {
              throw new CswRuleViolation('CS-21', `发送单元 ${l.unitId} 不存在`)
            }
            const balances = await cswTools(tools).inv.balances.listActiveByUnit(l.unitId)
            if (balances.length !== 1) {
              throw new CswRuleViolation('IT-20', `发送单元 ${pre.unitNo} 活动余额数 ${balances.length}（须唯一或显式指定库位）`)
            }
            if (cswCmpQty(balances[0]!.quantity, l.quantity) < 0) {
              throw new CswRuleViolation('CS-S4', `发送单元 ${pre.unitNo} 余额 ${balances[0]!.quantity} 不足 ${l.quantity}`)
            }
          }
          let lineNoBase = 1
          for (const l of lines) {
            const result = await outsourceSendLine(pc, {
              lineNoBase,
              unitId: l.unitId,
              quantity: l.quantity,
              fromLocationId: undefined,
              transitLocationId: task.transitLocationId,
              transitLocationCode: task.transitLocationCode,
              taskId: task.id,
              taskNo: task.taskNo,
            })
            // [CS-20] 所有权保留复核（等价记账已同所有者，此处断言双保险）
            const transitBalance = await cswTools(tools).inv.balances.findByKey(l.unitId, task.transitLocationId, result.ownerId)
            if (transitBalance === null) {
              throw new CswRuleViolation('CS-20', `外协在途余额未落库（单元 ${l.unitId}），状态异常`)
            }
            assertOwnershipRetainedOnSend({
              fromOwnerId: result.ownerId,
              toOwnerId: transitBalance.ownerId,
              unitNo: l.unitId,
            })
            const unit = await cswTools(tools).inv.units.findById(l.unitId)
            await cswTools(tools).csw.outsourcingUnits.insert({
              taskId: task.id,
              unitId: l.unitId,
              unitNo: unit === null ? l.unitId : unit.unitNo,
              sendLotId: unit === null ? null : unit.lotId,
              sentQty: l.quantity,
            })
            lineNoBase += 2
          }
          // [CS-24] 加工数量事实出站（模拟适配器先行；真实路由 BLOCKED_EXTERNAL）
          cswTools(tools).outbox.collect({
            aggregateType: 'csw_outsourcing_task',
            aggregateId: task.id,
            taskKind: 'csw.outsourcing.settlement-export',
            payload: { taskNo: task.taskNo, supplierName: task.supplierName, orderNo: task.orderNo, operationName: task.operationName, sentQty: sentTotal, uom: task.uom, businessTime },
          })
          return { sentQty: cswAddQty(task.sentQty, sentTotal), sentBy: ctx.actorLoginName, sentAt: businessTime }
        })
      }),
  }

  const outsourcingReceive: CommandHandler = {
    commandType: 'csw.outsourcing.receive',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        assertNoSettlementFields(p)
        const linesRaw = p['lines']
        const lines = Array.isArray(linesRaw)
          ? linesRaw.map((raw) => {
              const l = (raw ?? {}) as Payload
              return { unitId: str(l, 'unitId') ?? '', quantity: dec(l, 'quantity') ?? '', returnLotNo: str(l, 'returnLotNo') ?? null }
            })
          : []
        assertSendLinesShape(lines.map((l) => ({ unitId: l.unitId, quantity: l.quantity })))
        return driveOutsourcing(tools, ctx, p, 'receive', async (task) => {
          const returnLocationId = str(p, 'returnLocationId') ?? task.returnLocationId
          const returnLocationCode = str(p, 'returnLocationCode') ?? task.returnLocationCode
          if (returnLocationId === null || returnLocationCode === null || returnLocationId === undefined || returnLocationCode === undefined) {
            throw new CswRuleViolation('CS-22', '回厂接收需要回厂目的位（回厂仓/待检位）：returnLocationId/returnLocationCode')
          }
          const { businessTime, shiftDate } = resolveBusinessTime(cswTools(tools), str(p, 'businessTime'))
          const receiptId = await cswTools(tools).inv.receipts.findIdByKey(ctx.enterpriseId, 'csw.outsourcing.receive', envelope.operationId)
          if (receiptId === null) {
            throw new CswRuleViolation('CS-S4', '命令回执未落库：幂等键缺失，拒绝记账')
          }
          const pc: CswPostingContext = { tools: cswTools(tools), ctx, commandReceiptId: receiptId, businessTime, shiftDate }
          // 全量预校验（链接存在＋回厂量≤发送余量）——全部通过后才进入记账序，杜绝部分记账
          const linkByUnit = new Map<string, CswOutsourcingUnitRecord | null>()
          for (const l of lines) {
            const link = await cswTools(tools).csw.outsourcingUnits.findByTaskAndUnit(task.id, l.unitId)
            if (link === null) {
              throw new CswRuleViolation('CS-23', `单元 ${l.unitId} 不属于外协任务 ${task.taskNo}（谱系链接缺失）`)
            }
            const linkRemaining = cswAddQty(link.sentQty, negateForSub(link.returnedQty))
            if (cswCmpQty(l.quantity, linkRemaining) > 0) {
              throw new CswRuleViolation('CS-S4', `单元 ${l.unitId} 回厂量 ${l.quantity} 超过发送余量 ${linkRemaining}`)
            }
            linkByUnit.set(l.unitId, link)
          }
          let lineNoBase = 1
          let receivedTotal = '0'
          for (const l of lines) {
            const link = linkByUnit.get(l.unitId)!
            const result = await outsourceReturnLine(pc, {
              lineNoBase,
              unitId: l.unitId,
              quantity: l.quantity,
              transitLocationId: task.transitLocationId,
              toLocationId: returnLocationId as string,
              toLocationCode: returnLocationCode as string,
              taskId: task.id,
              taskNo: task.taskNo,
            })
            // [CS-22] 回厂默认全部必检：目的余额必须为待检
            const dest = await cswTools(tools).inv.balances.findByKey(l.unitId, returnLocationId as string, result.ownerId)
            if (dest === null) {
              throw new CswRuleViolation('CS-22', '回厂目的余额未落库，状态异常')
            }
            assertReturnEntersPendingInspection(dest.qualityStatus)
            // [CS-23] 回厂批次父子边（声明了不同于发送批次的新批次时追加 genealogy_edge）
            let returnLotId: string | null = null
            const unit = await cswTools(tools).inv.units.findById(l.unitId)
            if (l.returnLotNo !== null && unit !== null && unit.lotId !== null) {
              const sendLot = await cswTools(tools).inv.lots.findById(unit.lotId)
              if (sendLot !== null && sendLot.lotNo !== l.returnLotNo) {
                const existing = await cswTools(tools).inv.lots.findByNo(task.plantId, l.returnLotNo)
                const returnLot =
                  existing ??
                  (await cswTools(tools).inv.lots.insert({
                    lotNo: l.returnLotNo,
                    kind: 'production',
                    materialId: sendLot.materialId,
                    materialCode: sendLot.materialCode,
                    supplierLotNo: task.supplierCode,
                    plantId: task.plantId,
                    enterpriseId: task.enterpriseId,
                    businessTime,
                    note: `外协回厂批次 ${task.taskNo}`,
                    createdBy: ctx.actorLoginName,
                  }))
                returnLotId = returnLot.id
                await cswTools(tools).inv.genealogy.insertEdge({
                  fromType: 'material_lot',
                  fromId: sendLot.id,
                  toType: 'inventory_unit',
                  toId: unit.id,
                  edgeKind: 'production_output',
                  quantity: l.quantity,
                  uomId: dest.uomId,
                  uomCode: dest.uomCode,
                  measurementBasis: dest.measurementBasis,
                  conversionRevisionId: dest.conversionRevisionId,
                  commandReceiptId: receiptId,
                  businessTime,
                  plantId: task.plantId,
                  enterpriseId: task.enterpriseId,
                  createdBy: ctx.actorLoginName,
                })
              }
            }
            const linkDone = cswAddQty(link.returnedQty, l.quantity)
            await cswTools(tools).csw.outsourcingUnits.updateReturned(link.id, {
              returnedQty: linkDone,
              returnLotId,
              status: cswCmpQty(linkDone, link.sentQty) >= 0 ? 'returned' : 'sent',
            })
            receivedTotal = cswAddQty(receivedTotal, l.quantity)
            lineNoBase += 2
          }
          const returnedQty = cswAddQty(task.returnedQty, receivedTotal)
          assertReturnWithinSent({ sentQty: task.sentQty, returnedQty })
          return {
            returnedQty,
            receivedBy: ctx.actorLoginName,
            receivedAt: businessTime,
            returnLocationId: returnLocationId as string,
            returnLocationCode: returnLocationCode as string,
          }
        })
      }),
  }

  const outsourcingInspect: CommandHandler = {
    commandType: 'csw.outsourcing.inspect',
    handle: (envelope, ctx, tools) =>
      run(() =>
        driveOutsourcing(tools, ctx, envelope.payload as Payload, 'inspect', async (task) => {
          const p = envelope.payload as Payload
          const result = str(p, 'inspectionResult')
          if (result !== 'passed' && result !== 'rejected') {
            throw new CswRuleViolation('CS-22', 'inspectionResult 须为 passed/rejected（检验结论与放行走质量合同）')
          }
          const links = await cswTools(tools).csw.outsourcingUnits.listByTask(task.id)
          const unreturned = links.filter((l) => cswCmpQty(l.returnedQty, l.sentQty) < 0)
          if (unreturned.length > 0) {
            throw new CswRuleViolation('CS-S4', `存在未回厂单元（${unreturned.map((l) => l.unitNo).join('、')}），先完成回厂接收或收回`)
          }
          return { inspectionResult: result, inspectedBy: ctx.actorLoginName, inspectedAt: tools.now().toISOString() }
        }),
      ),
  }

  const outsourcingClose: CommandHandler = {
    commandType: 'csw.outsourcing.close',
    handle: (envelope, ctx, tools) =>
      run(() =>
        driveOutsourcing(tools, ctx, envelope.payload as Payload, 'close', async (task) => {
          // [CS-25] 关闭须检验通过（不以已发送充当完成）
          assertCloseRequiresInspectionPassed(task.inspectionResult)
          const now = tools.now().toISOString()
          // [CS-24] 结算事实出站（关闭时点快照）
          cswTools(tools).outbox.collect({
            aggregateType: 'csw_outsourcing_task',
            aggregateId: task.id,
            taskKind: 'csw.outsourcing.settlement-export',
            payload: {
              taskNo: task.taskNo,
              supplierName: task.supplierName,
              orderNo: task.orderNo,
              operationName: task.operationName,
              sentQty: task.sentQty,
              returnedQty: task.returnedQty,
              uom: task.uom,
              sentAt: task.sentAt,
              receivedAt: task.receivedAt,
              closedAt: now,
            },
          })
          return { closedBy: ctx.actorLoginName, closedAt: now }
        }),
      ),
  }

  const outsourcingRecall: CommandHandler = {
    commandType: 'csw.outsourcing.recall',
    handle: (envelope, ctx, tools) =>
      run(() =>
        driveOutsourcing(tools, ctx, envelope.payload as Payload, 'recall', async (task) => {
          const p = envelope.payload as Payload
          const recallReason = str(p, 'reason') ?? ctx.reason ?? null
          if (recallReason === null || recallReason.trim() === '') {
            throw new CswRuleViolation('CS-19', '已发送后取消走收回流程：必须填写理由并留痕')
          }
          const links = await cswTools(tools).csw.outsourcingUnits.listByTask(task.id)
          const pending = links.filter((l) => cswCmpQty(l.returnedQty, l.sentQty) < 0)
          if (pending.length > 0) {
            const returnLocationId = str(p, 'returnLocationId') ?? task.returnLocationId
            const returnLocationCode = str(p, 'returnLocationCode') ?? task.returnLocationCode
            if (returnLocationId === null || returnLocationId === undefined || returnLocationCode === null || returnLocationCode === undefined) {
              throw new CswRuleViolation('CS-19', '收回流程需要回厂目的位（在途余量回厂两段交接）')
            }
            const { businessTime, shiftDate } = resolveBusinessTime(cswTools(tools), str(p, 'businessTime'))
            const receiptId = await cswTools(tools).inv.receipts.findIdByKey(ctx.enterpriseId, 'csw.outsourcing.recall', envelope.operationId)
            if (receiptId === null) {
              throw new CswRuleViolation('CS-S4', '命令回执未落库：幂等键缺失，拒绝记账')
            }
            const pc: CswPostingContext = { tools: cswTools(tools), ctx, commandReceiptId: receiptId, businessTime, shiftDate }
            let lineNoBase = 1
            for (const link of pending) {
              const remain = cswAddQty(link.sentQty, negateForSub(link.returnedQty))
              if (cswCmpQty(remain, '0') <= 0) continue
              const result = await outsourceReturnLine(pc, {
                lineNoBase,
                unitId: link.unitId,
                quantity: remain,
                transitLocationId: task.transitLocationId,
                toLocationId: returnLocationId as string,
                toLocationCode: returnLocationCode as string,
                taskId: task.id,
                taskNo: task.taskNo,
              })
              const dest = await cswTools(tools).inv.balances.findByKey(link.unitId, returnLocationId as string, result.ownerId)
              if (dest !== null) assertReturnEntersPendingInspection(dest.qualityStatus) // [CS-22] 收回回厂同必检口径
              await cswTools(tools).csw.outsourcingUnits.updateReturned(link.id, {
                returnedQty: link.sentQty,
                status: 'returned',
              })
              lineNoBase += 2
            }
          }
          return {
            recallReason: recallReason as string,
            recalledBy: ctx.actorLoginName,
            recalledAt: tools.now().toISOString(),
            returnedQty: task.sentQty,
          }
        }),
      ),
  }

  const outsourcingDispose: CommandHandler = {
    commandType: 'csw.outsourcing.dispose',
    handle: (envelope, ctx, tools) =>
      run(() =>
        driveOutsourcing(tools, ctx, envelope.payload as Payload, 'dispose', async () => {
          const p = envelope.payload as Payload
          const disposeReason = str(p, 'reason') ?? ctx.reason ?? null
          if (disposeReason === null || disposeReason.trim() === '') {
            throw new CswRuleViolation('CS-19', '回厂后取消走退回处置：必须填写理由并留痕')
          }
          return {
            disposeReason: disposeReason as string,
            disposedBy: ctx.actorLoginName,
            disposedAt: tools.now().toISOString(),
          }
        }),
      ),
  }

  return [
    freezeCreate,
    freezeRelease,
    changeoverPublish,
    calibrationSet,
    downtimeRegister,
    downtimeClose,
    reschedulePropose,
    rescheduleCommit,
    outsourcingCreate,
    outsourcingSubmit,
    outsourcingSend,
    outsourcingReceive,
    outsourcingInspect,
    outsourcingClose,
    outsourcingRecall,
    outsourcingDispose,
  ]
}

/** 引擎内部负数量（负载剔除）：与 negate 保持一致（本文件内复用）。 */
function negateForSub(qty: string): string {
  return qty.startsWith('-') ? qty.slice(1) : `-${qty}`
}
