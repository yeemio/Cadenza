import { ERROR_CODES } from '@cadenza/contracts'
import {
  InventoryRuleViolation,
  MAINTENANCE_PLAN_KINDS,
  RESTART_ORDER_RESULT,
  SparePartInsufficientError,
  assertCancellable,
  assertCheckItemTemplate,
  assertCloseFields,
  assertDowntimeCloseNoNegativeDuration,
  assertDowntimeReason,
  assertDispatchFields,
  assertEquipmentStatusSource,
  assertFailedRoundAnomalyNote,
  assertInspectionResult,
  assertNoDowntimeOverlap,
  assertMaintenanceOrderTransition,
  assertPlanCycle,
  assertPlanEffectiveRange,
  assertPlanVersionNumber,
  assertRestartExecutable,
  assertSpareUsageQuantity,
  assertStartWorkExecutable,
  buildCapacityChangeEvent,
  buildRepairReportSuggestion,
  buildStatusLogEntry,
  computeAvailability,
  computeShiftDate,
  computeStartWorkBusinessDate,
  deductAvailableQuantity,
  ensureStableLockOrder,
  parseSpareQuantity,
  resolveScannedEquipmentCode,
  assertAnomalyReportSubmittable,
  assertMaintenanceEquipmentStatusValue,
  type MaintenancePlanKind,
} from '@cadenza/domain'
import type { CommandContext, CommandHandler, HandlerOutcome } from './command-bus'
import { closeUnitIfZero, writeLine, type PostingContext } from './inventory-posting'
import type { MaintenanceCommandTools, MaintenanceOrderRecord } from './maintenance-repositories'
import type { InventoryUnitRecord } from './inventory-repositories'

/**
 * maintenance 域命令处理器（T19 设备维护：点检/保养/维修工单/复机/备件）。
 *
 * 命令面（10，全部经 PgCommandBus 幂等＋审计）：
 * - maintenance.equipment.anomaly-report：异常上报（PDA，MT-03/04；置"维修"可关联建单 MT-13）；
 * - maintenance.order.create：Web 手工报修建单（MT-13）——建单置"维修"（MT-08）＋开停机事件
 *   （MT-09）＋发能力下降事件（MT-15）；
 * - maintenance.order.dispatch / start / finish-repair：状态机推进（MT-07/13）；
 * - maintenance.order.restart：复机关闭（MT-10）＋备件消耗同事务（MT-11 修复 2026-10：
 *   扣减直走 inventory-posting 内核 writeLine/closeUnitIfZero——稳定次序锁单元＋IT-14
 *   质量∧预留实时可用量校验＋流水/分录/扣前扣后＋零余额关闭，同事务审计与 Outbox）＋闭停机＋
 *   置正常＋发能力恢复事件（MT-15）——一次事务完成，失败回滚不改变工单状态；
 * - maintenance.order.cancel：取消语义（MT-14：原因必填、停机事实保留）；
 * - maintenance.plan.create-version / maintenance.inspection.record-round：点检/保养框架（MT-12）；
 * - maintenance.equipment.start-work：设备开工（MT-05/06：业务日幂等）。
 *
 * 规则违例以 [MT-xx] 前缀中文信息返回（BUSINESS_REJECTION）；可用量不足映射
 * ERR_INSUFFICIENT_STOCK；对象不存在映射 ERR_NOT_FOUND；范围越权映射 ERR_FORBIDDEN_SCOPE。
 */

type Payload = Record<string, unknown>

function maintenanceViolationOutcome(error: Error & { rule: string }): HandlerOutcome {
  let errorCode: string = ERROR_CODES.BUSINESS_RULE
  if (error.rule === 'A-S1') errorCode = ERROR_CODES.FORBIDDEN_SCOPE
  else if (error.rule === 'MT-NOT-FOUND') errorCode = ERROR_CODES.NOT_FOUND
  else if (error instanceof SparePartInsufficientError) errorCode = ERROR_CODES.INSUFFICIENT_STOCK
  // MT-11 修复（2026-10）：内核路径抛出的 InventoryRuleViolation 在 maintenance 域边界
  // 映射（裁定：MT-11→IT-14/IT-30 等）——余量/并发类拒绝按可用量不足承载，其余按域规则。
  else if (error instanceof InventoryRuleViolation && (error.rule === 'IT-14' || error.rule === 'IT-30' || error.rule === 'IT-15')) {
    errorCode = ERROR_CODES.INSUFFICIENT_STOCK
  } else if (error instanceof InventoryRuleViolation && error.rule === 'NOT_FOUND') {
    errorCode = ERROR_CODES.NOT_FOUND
  }
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<Record<string, unknown>>): Promise<HandlerOutcome> {
  try {
    const data = await body()
    return { status: 'COMMITTED', data }
  } catch (error) {
    if (error instanceof Error && 'rule' in error && typeof (error as { rule: unknown }).rule === 'string') {
      return maintenanceViolationOutcome(error as Error & { rule: string })
    }
    throw error
  }
}

function str(p: Payload, key: string): string | undefined {
  const v = p[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function requireStr(p: Payload, key: string, rule: string, command: string): string {
  const v = str(p, key)
  if (v === undefined) throw new RuleViolation(rule, `${command}：载荷缺少必填字段 ${key}`)
  return v
}

/** 本地规则违例（与 domain MaintenanceRuleViolation 同构，用于载荷形状守卫）。 */
class RuleViolation extends Error {
  readonly rule: string
  constructor(rule: string, message: string) {
    super(message)
    this.name = 'RuleViolation'
    this.rule = rule
  }
}

function notFound(message: string): RuleViolation {
  return new RuleViolation('MT-NOT-FOUND', message)
}

/** 组织范围二道防线（OA-24/26，同 reporting 口径）。 */
async function assertPlantScope(tools: MaintenanceCommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new RuleViolation('A-S1', `目标工厂不在授权数据范围内（plant=${plantId}）`)
  }
}

/** IT-37 同型：业务时间解析（缺省回落系统时间）。 */
function resolveBusinessTime(tools: MaintenanceCommandTools, raw: unknown): Date {
  if (typeof raw === 'string' && !Number.isNaN(Date.parse(raw))) return new Date(raw)
  return tools.now()
}

// ---------------- 共用服务：受理报修建单（MT-08/09/13/15） ----------------

async function createRepairOrder(
  tools: MaintenanceCommandTools,
  ctx: CommandContext,
  input: {
    equipmentId: string
    plantId: string
    enterpriseId: string
    description: string | null
    reason: string
    source: 'web_manual' | 'anomaly_report'
    orderNo?: string
  },
): Promise<MaintenanceOrderRecord> {
  const { maintenance } = tools
  const now = tools.now()
  // MT-09：置"维修"即开停机事件——同设备停机区间不重叠（应用层守卫＋库层 exclusion 双保险）
  assertDowntimeReason(input.reason)
  const openIntervals = await maintenance.downtime.findOpenByEquipment(input.equipmentId)
  assertNoDowntimeOverlap(
    { startAt: now.toISOString(), endAt: null },
    openIntervals.map((e) => ({ startAt: e.startAt, endAt: e.endAt })),
  )

  // 工单号：毫秒时间戳＋随机后缀（秒级时间戳＋同操作人会在同秒多单时撞 order_no 唯一键）
  const orderNo =
    input.orderNo ??
    `MO-${now.getTime().toString(36)}-${Math.floor(Math.random() * 46_656).toString(36).padStart(3, '0')}`
  const order = await maintenance.orders.insert({
    enterpriseId: input.enterpriseId,
    plantId: input.plantId,
    equipmentId: input.equipmentId,
    orderNo,
    source: input.source,
    description: input.description,
    reporter: ctx.actorLoginName,
  })

  // MT-08：受理报修建单置"维修"（状态是投影；新值=旧值不产生流水 MT-02）
  const equipment = await tools.equipment.findById(input.equipmentId)
  if (equipment !== null) {
    const log = buildStatusLogEntry({
      equipmentId: equipment.id,
      oldStatus: equipment.equipmentStatus as 1 | 2,
      newStatus: 2,
      source: input.source === 'anomaly_report' ? 'PDA' : 'WEB',
      actor: ctx.actorLoginName,
      occurredAt: now.toISOString(),
    })
    await tools.equipment.update(equipment.id, { equipmentStatus: 2 }, ctx.actorLoginName)
    if (log !== null) {
      await tools.equipment.appendStatusLog({
        equipmentId: equipment.id,
        oldStatus: log.oldStatus,
        newStatus: log.newStatus,
        source: log.source,
        actor: log.actor,
        occurredAt: now,
      })
    }
  }

  // MT-09：开停机事件（关联工单，起止原子记录）
  const downtime = await maintenance.downtime.open({
    enterpriseId: input.enterpriseId,
    plantId: input.plantId,
    equipmentId: input.equipmentId,
    orderId: order.id,
    startAt: now,
    reason: input.reason,
  })

  // MT-15：停机只发布能力变化事件（含起止与原因），不直接改排程结果
  const event = buildCapacityChangeEvent({
    changeKind: 'down',
    orderId: order.id,
    orderNo: order.orderNo,
    equipmentId: input.equipmentId,
    equipmentCode: equipment?.code ?? '',
    plantId: input.plantId,
    downtimeStartAt: downtime.startAt,
    downtimeEndAt: null,
    downtimeReason: input.reason,
    occurredAt: now.toISOString(),
  })
  await maintenance.outbox.insert(event)

  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'maintenance.order.create',
    subjectType: 'maintenance_order',
    subjectId: order.id,
    after: { orderNo: order.orderNo, source: input.source, status: order.status, downtimeId: downtime.id },
    reason: ctx.reason ?? null,
  })
  return order
}

// ---------------- 命令：异常上报（MT-03/04；PDA） ----------------

async function anomalyReport(tools: MaintenanceCommandTools, ctx: CommandContext, p: Payload): Promise<Record<string, unknown>> {
  const code = resolveScannedEquipmentCode(p['equipmentCode']) // MT-03/04：识别宽容（前缀大小写归一）
  const equipment = await tools.equipment.findActiveByCode(code)
  assertAnomalyReportSubmittable({ equipmentId: equipment?.id ?? null, targetStatus: p['targetStatus'] }) // MT-03
  const targetStatus = assertMaintenanceEquipmentStatusValue(p['targetStatus']) // MT-01
  if (equipment === null) throw notFound(`未扫到有效设备（设备编码=${code}）`)
  await assertPlantScope(tools, equipment.plantId)

  const now = tools.now()
  const oldStatus = equipment.equipmentStatus as 1 | 2
  const log = buildStatusLogEntry({
    equipmentId: equipment.id,
    oldStatus,
    newStatus: targetStatus,
    source: 'PDA',
    actor: ctx.actorLoginName,
    occurredAt: now.toISOString(),
  })
  let statusChanged = false
  if (log !== null) {
    // MT-03：状态变化则更新设备状态＋记流水（来源 PDA）；MT-02：相同状态仍算成功但不记变更
    await tools.equipment.update(equipment.id, { equipmentStatus: targetStatus }, ctx.actorLoginName)
    await tools.equipment.appendStatusLog({
      equipmentId: equipment.id,
      oldStatus: log.oldStatus,
      newStatus: log.newStatus,
      source: log.source,
      actor: log.actor,
      occurredAt: now,
    })
    statusChanged = true
  }

  // MT-13：异常上报置"维修"时可关联建单（同事务）
  let order: MaintenanceOrderRecord | null = null
  if (targetStatus === 2 && p['createOrder'] === true) {
    order = await createRepairOrder(tools, ctx, {
      equipmentId: equipment.id,
      plantId: equipment.plantId,
      enterpriseId: equipment.enterpriseId,
      description: str(p, 'description') ?? `异常上报：${equipment.code}`,
      reason: str(p, 'reason') ?? str(p, 'description') ?? `异常上报停机：${equipment.code}`,
      source: 'anomaly_report',
    })
  }

  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'maintenance.equipment.anomaly-report',
    subjectType: 'equipment',
    subjectId: equipment.id,
    before: { equipmentStatus: oldStatus },
    after: { equipmentStatus: targetStatus, statusChanged, orderId: order?.id ?? null },
    reason: ctx.reason ?? null,
  })
  return {
    equipmentId: equipment.id,
    equipmentCode: equipment.code,
    oldStatus,
    newStatus: targetStatus,
    statusChanged,
    orderId: order?.id ?? null,
    orderNo: order?.orderNo ?? null,
  }
}

// ---------------- 命令：Web 手工报修建单（MT-13） ----------------

async function orderCreate(tools: MaintenanceCommandTools, ctx: CommandContext, p: Payload): Promise<Record<string, unknown>> {
  const equipment =
    str(p, 'equipmentId') !== undefined
      ? await tools.equipment.findById(str(p, 'equipmentId') as string)
      : await tools.equipment.findActiveByCode(requireStr(p, 'equipmentCode', 'MT-13', 'maintenance.order.create'))
  if (equipment === null || equipment.status !== 'active') {
    throw notFound(`设备不存在或已退役（${str(p, 'equipmentCode') ?? str(p, 'equipmentId') ?? ''}）`)
  }
  await assertPlantScope(tools, equipment.plantId)
  const description = str(p, 'description') ?? null
  const order = await createRepairOrder(tools, ctx, {
    equipmentId: equipment.id,
    plantId: equipment.plantId,
    enterpriseId: equipment.enterpriseId,
    description,
    reason: str(p, 'reason') ?? description ?? `手工报修停机：${equipment.code}`,
    source: 'web_manual',
    orderNo: str(p, 'orderNo'),
  })
  return { orderId: order.id, orderNo: order.orderNo, status: order.status }
}

// ---------------- 命令：状态机推进（MT-07/13） ----------------

async function loadOrder(tools: MaintenanceCommandTools, orderId: string): Promise<MaintenanceOrderRecord> {
  const order = await tools.maintenance.orders.findById(orderId)
  if (order === null) throw notFound(`维修工单不存在（id=${orderId}）`)
  return order
}

async function orderDispatch(tools: MaintenanceCommandTools, ctx: CommandContext, p: Payload): Promise<Record<string, unknown>> {
  const orderId = requireStr(p, 'orderId', 'MT-13', 'maintenance.order.dispatch')
  const order = await loadOrder(tools, orderId)
  await assertPlantScope(tools, order.plantId)
  const assignee = requireStr(p, 'assignee', 'MT-13', 'maintenance.order.dispatch')
  assertDispatchFields(assignee) // MT-13：分派记录分派人与被派人
  assertMaintenanceOrderTransition(order.status, 'dispatched') // MT-07
  const updated = await tools.maintenance.orders.update(
    order.id,
    { status: 'dispatched', dispatcher: ctx.actorLoginName, assignee },
    ctx.actorLoginName,
  )
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'maintenance.order.dispatch',
    subjectType: 'maintenance_order',
    subjectId: order.id,
    before: { status: order.status },
    after: { status: updated?.status, dispatcher: ctx.actorLoginName, assignee },
    reason: ctx.reason ?? null,
  })
  return { orderId: order.id, status: updated?.status, dispatcher: ctx.actorLoginName, assignee }
}

async function orderStart(tools: MaintenanceCommandTools, ctx: CommandContext, p: Payload): Promise<Record<string, unknown>> {
  const order = await loadOrder(tools, requireStr(p, 'orderId', 'MT-07', 'maintenance.order.start'))
  await assertPlantScope(tools, order.plantId)
  assertMaintenanceOrderTransition(order.status, 'in_progress') // MT-07
  const updated = await tools.maintenance.orders.update(order.id, { status: 'in_progress' }, ctx.actorLoginName)
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'maintenance.order.start',
    subjectType: 'maintenance_order',
    subjectId: order.id,
    before: { status: order.status },
    after: { status: updated?.status },
    reason: ctx.reason ?? null,
  })
  return { orderId: order.id, status: updated?.status }
}

async function orderFinishRepair(tools: MaintenanceCommandTools, ctx: CommandContext, p: Payload): Promise<Record<string, unknown>> {
  const order = await loadOrder(tools, requireStr(p, 'orderId', 'MT-07', 'maintenance.order.finish-repair'))
  await assertPlantScope(tools, order.plantId)
  assertMaintenanceOrderTransition(order.status, 'pending_restart') // MT-07
  const updated = await tools.maintenance.orders.update(order.id, { status: 'pending_restart' }, ctx.actorLoginName)
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'maintenance.order.finish-repair',
    subjectType: 'maintenance_order',
    subjectId: order.id,
    before: { status: order.status },
    after: { status: updated?.status },
    reason: ctx.reason ?? null,
  })
  return { orderId: order.id, status: updated?.status }
}

// ---------------- 命令：复机关闭（MT-10/11/15；一次事务完成） ----------------

async function orderRestart(
  tools: MaintenanceCommandTools,
  ctx: CommandContext,
  p: Payload,
  operationId: string,
): Promise<Record<string, unknown>> {
  const order = await loadOrder(tools, requireStr(p, 'orderId', 'MT-10', 'maintenance.order.restart'))
  await assertPlantScope(tools, order.plantId)
  assertRestartExecutable(order.status) // MT-10：仅"待复机"可执行复机
  const responsible = requireStr(p, 'responsible', 'MT-10', 'maintenance.order.restart')
  assertCloseFields(RESTART_ORDER_RESULT, responsible) // MT-07/10：关闭记录结果与责任人
  const source = assertEquipmentStatusSource(str(p, 'source') ?? 'WEB') // MT-02：流水来源
  const now = tools.now()

  // MT-11：备件动用与工单关闭同事务写消耗记录＋库存流水（IT-18 唯一记账方）
  const receiptId = await tools.maintenance.receipts.findIdByKey(
    ctx.enterpriseId,
    'maintenance.order.restart',
    operationId,
  )
  if (receiptId === null) {
    throw new RuleViolation('MT-11', 'maintenance.order.restart：命令回执未落库（幂等键缺失），拒绝记账备件消耗')
  }
  const spareLinesInput = Array.isArray(p['spareParts']) ? (p['spareParts'] as unknown[]) : []
  // 载荷先行解析（锁前失败快拒绝；MT-11 工单行/备件行结构不变：unitId/quantity）
  const spareLines: Array<{ unitId: string; quantity: string }> = []
  for (const line of spareLinesInput) {
    if (typeof line !== 'object' || line === null) {
      throw new RuleViolation('MT-11', 'maintenance.order.restart：spareParts 行必须为对象（unitId/quantity）')
    }
    const row = line as Payload
    const unitId = requireStr(row, 'unitId', 'MT-11', 'maintenance.order.restart')
    const quantity = parseSpareQuantity(row['quantity']) // MT-11：数量口径
    spareLines.push({ unitId, quantity })
  }

  // ===== MT-11 修复（2026-10，PM 裁定 MT-11）：备件扣减直走 inventory-posting 内核路径 =====
  // IT-25：先按稳定次序锁全部备件单元（同码并发消费在此串行化），再逐行校验记账。
  const inv = tools.inv
  const orderedUnitIds = ensureStableLockOrder([...new Set(spareLines.map((l) => l.unitId))])
  const lockedUnits = orderedUnitIds.length > 0 ? await inv.units.lockForUpdate(orderedUnitIds) : []
  if (lockedUnits.length !== orderedUnitIds.length) {
    throw new RuleViolation('MT-NOT-FOUND', '备件库存单元不存在或已不可用，拒绝消耗')
  }
  const unitById = new Map<string, InventoryUnitRecord>(lockedUnits.map((u) => [u.id, u]))

  // 内核记账上下文（businessTime/shiftDate 与库存域同口径，IT-37 双存）
  const pc: PostingContext = {
    tools,
    ctx,
    commandReceiptId: receiptId,
    businessTime: now.toISOString(),
    shiftDate: computeShiftDate(now.toISOString()),
  }

  const usageRows: Array<Record<string, unknown>> = []
  let lineNo = 0
  for (const line of spareLines) {
    const unit = unitById.get(line.unitId)!
    const quantity = line.quantity
    // 首个 active+qualified 余额（沿 MT-11 既有选择语义：created_at,id 次序）
    const actives = (await inv.balances.listActiveByUnit(unit.id))
      .filter((b) => b.qualityStatus === 'qualified')
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
    if (actives.length === 0) {
      throw new RuleViolation('MT-11', `备件单元无可用余额（unitId=${unit.id}），拒绝消耗`)
    }
    // IT-20：主事务内行锁余额行（交易决策用的余额实时更新）
    const balance = await inv.balances.lockByKey(unit.id, actives[0]!.locationId, actives[0]!.ownerId)
    if (balance === null || balance.status === 'closed') {
      throw new RuleViolation('MT-11', `备件单元无可用余额（unitId=${unit.id}），拒绝消耗`)
    }
    // IT-14：可用量 = 质量 ∧ 预留（实时校验，预留感知——不再以毛量作可用量）
    const nowIso = now.toISOString()
    const reservations = await inv.reservations.listActiveByUnit(unit.id)
    const availability = computeAvailability({
      grossQty: balance.quantity,
      qualityStatus: balance.qualityStatus,
      activeReservations: reservations.map((r) => ({ status: r.status, quantity: r.quantity, validUntil: r.validUntil })),
      now: nowIso,
    })
    assertSpareUsageQuantity(quantity, availability.available) // MT-11：>0 且 ≤ 实时可用量
    const afterQuantity = deductAvailableQuantity(balance.quantity, quantity)
    lineNo += 1
    // IT-19/IT-25 内核记账：流水（含扣前/扣后）＋stock_entry 分录＋余额实时更新＋IT-29 零余额关闭
    const written = await writeLine(pc, {
      lineNo,
      movementKind: 'issue',
      balance,
      beforeQty: balance.quantity,
      afterQty: afterQuantity,
      unit,
      from: { locationId: balance.locationId, locationCode: balance.locationCode, ownerId: balance.ownerId, ownerName: balance.ownerName },
      reason: '维修工单备件消耗（MT-11）',
      refType: 'maintenance_order',
      refId: order.id,
    })
    await closeUnitIfZero(pc, unit, written.closed) // IT-29：扣尽关闭，身份与谱系保留

    const usage = await tools.maintenance.usages.insert({
      enterpriseId: order.enterpriseId,
      plantId: order.plantId,
      orderId: order.id,
      unitId: unit.id,
      balanceId: balance.id,
      stockTransactionId: written.transactionId,
      quantity,
      beforeQuantity: balance.quantity,
      afterQuantity,
      uomId: balance.uomId,
      uomCode: balance.uomCode,
    })
    usageRows.push({ usageId: usage.id, stockTransactionId: written.transactionId, quantity, afterQuantity })
    // 审计与 Outbox 同事务（备件库存变动独立留痕，工单级审计在命令尾统一记录）
    await tools.audit.record({
      actor: ctx.actorLoginName,
      action: 'maintenance.spare.issue',
      subjectType: 'inventory_unit',
      subjectId: unit.id,
      before: { quantity: balance.quantity, balanceId: balance.id },
      after: { quantity: afterQuantity, orderId: order.id, stockTransactionId: written.transactionId, balanceClosed: written.closed },
      reason: '维修工单备件消耗（MT-11）',
    })
    tools.outbox.collect({
      aggregateType: 'inventory_unit',
      aggregateId: unit.id,
      taskKind: 'maintenance.spare-issued',
      payload: {
        unitId: unit.id,
        unitNo: unit.unitNo,
        orderId: order.id,
        orderNo: order.orderNo,
        quantity,
        beforeQty: balance.quantity,
        afterQty: afterQuantity,
        businessTime: pc.businessTime,
      },
    })
  }

  // MT-10：置设备状态正常＋闭停机事件（MT-08 投影；MT-02 新值=旧值不产生流水）
  const equipment = await tools.equipment.findById(order.equipmentId)
  if (equipment !== null) {
    const log = buildStatusLogEntry({
      equipmentId: equipment.id,
      oldStatus: equipment.equipmentStatus as 1 | 2,
      newStatus: 1,
      source,
      actor: ctx.actorLoginName,
      occurredAt: now.toISOString(),
    })
    await tools.equipment.update(equipment.id, { equipmentStatus: 1 }, ctx.actorLoginName)
    if (log !== null) {
      await tools.equipment.appendStatusLog({
        equipmentId: equipment.id,
        oldStatus: log.oldStatus,
        newStatus: log.newStatus,
        source: log.source,
        actor: log.actor,
        occurredAt: now,
      })
    }
  }

  // MT-09/10：复机关闭即闭停机事件（起止原子记录；无负时长）
  const openDowntime = await tools.maintenance.downtime.findOpenByOrder(order.id)
  let downtimeClosed: { id: string; startAt: string; endAt: string; reason: string } | null = null
  if (openDowntime.length > 0) {
    const event = openDowntime[0] as { id: string; startAt: string; reason: string }
    assertDowntimeCloseNoNegativeDuration(event.startAt, now.toISOString())
    const closed = await tools.maintenance.downtime.close(event.id, now)
    downtimeClosed = { id: closed.id, startAt: closed.startAt, endAt: closed.endAt as string, reason: closed.reason }
  }

  // MT-07/10：关闭工单（结果=复机正常＋责任人）
  const updated = await tools.maintenance.orders.update(
    order.id,
    { status: 'closed', result: RESTART_ORDER_RESULT, responsible, closedAt: now },
    ctx.actorLoginName,
  )

  // MT-15：复机发布能力恢复事件（含停机起止与原因；T09 消费触发计划评估）
  const capacityEvent = buildCapacityChangeEvent({
    changeKind: 'restored',
    orderId: order.id,
    orderNo: order.orderNo,
    equipmentId: order.equipmentId,
    equipmentCode: equipment?.code ?? '',
    plantId: order.plantId,
    downtimeStartAt: downtimeClosed?.startAt ?? now.toISOString(),
    downtimeEndAt: downtimeClosed?.endAt ?? now.toISOString(),
    downtimeReason: downtimeClosed?.reason ?? order.description ?? '',
    occurredAt: now.toISOString(),
  })
  const capacityEventId = await tools.maintenance.outbox.insert(capacityEvent)

  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'maintenance.order.restart',
    subjectType: 'maintenance_order',
    subjectId: order.id,
    before: { status: order.status },
    after: {
      status: updated?.status,
      result: RESTART_ORDER_RESULT,
      responsible,
      downtimeClosedId: downtimeClosed?.id ?? null,
      spareLines: usageRows.length,
      capacityEventId,
    },
    reason: ctx.reason ?? null,
  })
  return {
    orderId: order.id,
    status: updated?.status,
    result: RESTART_ORDER_RESULT,
    responsible,
    downtime: downtimeClosed,
    spareUsage: usageRows,
    capacityEventId,
  }
}

// ---------------- 命令：取消（MT-14） ----------------

async function orderCancel(tools: MaintenanceCommandTools, ctx: CommandContext, p: Payload): Promise<Record<string, unknown>> {
  const order = await loadOrder(tools, requireStr(p, 'orderId', 'MT-14', 'maintenance.order.cancel'))
  await assertPlantScope(tools, order.plantId)
  const cancelReason = requireStr(p, 'cancelReason', 'MT-14', 'maintenance.order.cancel')
  assertCancellable(order.status, cancelReason) // MT-14：待复机/已关闭不可取消；原因必填
  assertMaintenanceOrderTransition(order.status, 'cancelled') // MT-07：取消另记（合法迁移集内）
  // MT-14：取消不删除已产生的停机事件与状态流水（停机事实保留）——本命令对两表零写入
  const updated = await tools.maintenance.orders.update(
    order.id,
    { status: 'cancelled', cancelReason },
    ctx.actorLoginName,
  )
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'maintenance.order.cancel',
    subjectType: 'maintenance_order',
    subjectId: order.id,
    before: { status: order.status },
    after: { status: updated?.status, cancelReason },
    reason: cancelReason,
  })
  return { orderId: order.id, status: updated?.status, cancelReason }
}

// ---------------- 命令：点检/保养计划版本（MT-12/MT-S4） ----------------

async function planCreateVersion(tools: MaintenanceCommandTools, ctx: CommandContext, p: Payload): Promise<Record<string, unknown>> {
  const planKey = requireStr(p, 'planKey', 'MT-12', 'maintenance.plan.create-version')
  const kindRaw = requireStr(p, 'kind', 'MT-12', 'maintenance.plan.create-version')
  if (!MAINTENANCE_PLAN_KINDS.includes(kindRaw as MaintenancePlanKind)) {
    throw new RuleViolation('MT-12', `计划种类仅 inspection/maintenance（点检/保养），非法输入：${kindRaw}`)
  }
  const equipment =
    str(p, 'equipmentId') !== undefined
      ? await tools.equipment.findById(str(p, 'equipmentId') as string)
      : await tools.equipment.findActiveByCode(requireStr(p, 'equipmentCode', 'MT-12', 'maintenance.plan.create-version'))
  if (equipment === null || equipment.status !== 'active') {
    throw notFound(`计划目标设备不存在或已退役（${str(p, 'equipmentCode') ?? str(p, 'equipmentId') ?? ''}）`)
  }
  await assertPlantScope(tools, equipment.plantId)
  const cycle = assertPlanCycle(p['cycle']) // MT-12：最小周期机制
  const checkItems = assertCheckItemTemplate(p['checkItems']) // MT-12：检查项模板
  const effectiveFrom = requireStr(p, 'effectiveFrom', 'MT-12', 'maintenance.plan.create-version')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw new RuleViolation('MT-12', `生效日起非法（yyyy-MM-dd）：${effectiveFrom}`)
  }
  const effectiveTo = str(p, 'effectiveTo') ?? null
  assertPlanEffectiveRange(effectiveFrom, effectiveTo)
  const version = assertPlanVersionNumber(p['version'] ?? (await tools.maintenance.plans.maxVersionByKey(planKey)) + 1)
  const plan = await tools.maintenance.plans.insertVersion({
    enterpriseId: equipment.enterpriseId,
    plantId: equipment.plantId,
    equipmentId: equipment.id,
    planKey,
    version,
    kind: kindRaw as MaintenancePlanKind,
    cycle,
    checkItems,
    effectiveFrom,
    effectiveTo,
    description: str(p, 'description') ?? null,
  })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'maintenance.plan.create-version',
    subjectType: 'maintenance_plan',
    subjectId: plan.id,
    after: { planKey, version, kind: kindRaw, effectiveFrom, effectiveTo },
    reason: ctx.reason ?? null,
  })
  return { planId: plan.id, planKey, version, status: plan.status }
}

// ---------------- 命令：点检/保养执行记录（MT-12） ----------------

async function inspectionRecordRound(tools: MaintenanceCommandTools, ctx: CommandContext, p: Payload): Promise<Record<string, unknown>> {
  const planKey = requireStr(p, 'planKey', 'MT-12', 'maintenance.inspection.record-round')
  const versionRaw = p['version']
  const version = typeof versionRaw === 'number' ? versionRaw : undefined
  if (version === undefined) throw new RuleViolation('MT-12', 'maintenance.inspection.record-round：载荷缺少必填字段 version')
  const plan = await tools.maintenance.plans.findByKeyAndVersion(planKey, version)
  if (plan === null) throw notFound(`计划版本不存在（planKey=${planKey}, version=${version}）——执行记录必须引用计划版本快照`)
  await assertPlantScope(tools, plan.plantId)
  const executedAt = resolveBusinessTime(tools, p['executedAt'])
  // MT-12/IT-37：实际时间＋业务班次双存（班次细则 GAP-A3 待裁，复用库存域班次日口径）
  const shiftDate = str(p, 'shiftDate') ?? computeStartWorkBusinessDate(executedAt.toISOString())
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
    throw new RuleViolation('MT-12', `业务班次日非法（yyyy-MM-dd）：${shiftDate}`)
  }
  const result = assertInspectionResult(p['result']) // MT-12：pass/fail
  const anomalyNote = str(p, 'anomalyNote') ?? null
  assertFailedRoundAnomalyNote(result, anomalyNote) // MT-12：不合格必记异常说明
  let orderId: string | null = null
  if (str(p, 'orderId') !== undefined) {
    const linked = await loadOrder(tools, str(p, 'orderId') as string)
    orderId = linked.id
  }
  const round = await tools.maintenance.rounds.insert({
    enterpriseId: plan.enterpriseId,
    plantId: plan.plantId,
    planId: plan.id,
    planKey: plan.planKey,
    planVersion: plan.version,
    equipmentId: plan.equipmentId,
    executedAt,
    shiftDate,
    result,
    anomalyNote,
    performedBy: ctx.actorLoginName,
    orderId,
  })
  // MT-12：点检不合格产生异常记录并建议关联报修（不自动建单——GAP-F19 待裁）
  const suggestion = buildRepairReportSuggestion({ result, equipmentId: plan.equipmentId, anomalyNote })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'maintenance.inspection.record-round',
    subjectType: 'inspection_round',
    subjectId: round.id,
    after: { planKey, planVersion: plan.version, result, shiftDate, orderId },
    reason: ctx.reason ?? null,
  })
  return { roundId: round.id, planKey, planVersion: plan.version, result, executedAt: round.executedAt, shiftDate, repairSuggestion: suggestion }
}

// ---------------- 命令：设备开工（MT-05/06） ----------------

async function equipmentStartWork(tools: MaintenanceCommandTools, ctx: CommandContext, p: Payload): Promise<Record<string, unknown>> {
  const equipment =
    str(p, 'equipmentId') !== undefined
      ? await tools.equipment.findById(str(p, 'equipmentId') as string)
      : await tools.equipment.findActiveByCode(requireStr(p, 'equipmentCode', 'MT-05', 'maintenance.equipment.start-work'))
  assertStartWorkExecutable(equipment) // MT-05：设备存在且状态=正常（非正常拒绝）
  await assertPlantScope(tools, (equipment as { plantId: string }).plantId)
  const startedAt = resolveBusinessTime(tools, p['startedAt'])
  const source = assertEquipmentStatusSource(str(p, 'source') ?? 'PDA') // MT-02：来源字典
  // MT-06：开工按（设备, 业务日）幂等——业务日按工厂日历＋班次规则计算（IT-37），不按自然日硬编码
  const businessDate = computeStartWorkBusinessDate(startedAt.toISOString())
  const { record, updated } = await tools.maintenance.starts.upsertStart({
    enterpriseId: (equipment as { enterpriseId: string }).enterpriseId,
    plantId: (equipment as { plantId: string }).plantId,
    equipmentId: (equipment as { id: string }).id,
    businessDate,
    startedAt,
    source,
    actor: ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'maintenance.equipment.start-work',
    subjectType: 'equipment_start_record',
    subjectId: record.id,
    after: { equipmentId: record.equipmentId, businessDate, startedAt: record.startedAt, updated },
    reason: ctx.reason ?? null,
  })
  // MT-05：当日重复开工=更新当日开工记录的开工时间，不新建记录（updated=true）
  return { recordId: record.id, equipmentId: record.equipmentId, businessDate, startedAt: record.startedAt, updatedExistingRecord: updated }
}

// ---------------- 注册 ----------------

interface HandlerSpec {
  commandType: string
  handle: (
    tools: MaintenanceCommandTools,
    ctx: CommandContext,
    p: Payload,
    operationId: string,
  ) => Promise<Record<string, unknown>>
}

const HANDLER_SPECS: readonly HandlerSpec[] = [
  { commandType: 'maintenance.equipment.anomaly-report', handle: (t, c, p) => anomalyReport(t, c, p) },
  { commandType: 'maintenance.order.create', handle: (t, c, p) => orderCreate(t, c, p) },
  { commandType: 'maintenance.order.dispatch', handle: (t, c, p) => orderDispatch(t, c, p) },
  { commandType: 'maintenance.order.start', handle: (t, c, p) => orderStart(t, c, p) },
  { commandType: 'maintenance.order.finish-repair', handle: (t, c, p) => orderFinishRepair(t, c, p) },
  { commandType: 'maintenance.order.restart', handle: (t, c, p, op) => orderRestart(t, c, p, op) },
  { commandType: 'maintenance.order.cancel', handle: (t, c, p) => orderCancel(t, c, p) },
  { commandType: 'maintenance.plan.create-version', handle: (t, c, p) => planCreateVersion(t, c, p) },
  { commandType: 'maintenance.inspection.record-round', handle: (t, c, p) => inspectionRecordRound(t, c, p) },
  { commandType: 'maintenance.equipment.start-work', handle: (t, c, p) => equipmentStartWork(t, c, p) },
]

export function createMaintenanceCommandHandlers(): readonly CommandHandler[] {
  return HANDLER_SPECS.map((spec) => ({
    commandType: spec.commandType,
    handle: async (envelope, context, tools) =>
      run(() => spec.handle(tools as MaintenanceCommandTools, context, envelope.payload as Payload, envelope.operationId)),
  }))
}
