import { ERROR_CODES } from '@cadenza/contracts'
import { OrgRuleViolation, isPlantInScope } from '@cadenza/domain'
import type { CommandHandler, CommandTools, HandlerOutcome } from './command-bus'
// L0 整合步（Wave5）：domain index 已导出 './scheduling'；改包名导入（原 dist 相对导入 + eslint-disable 删除）。
import {
  SchedulingRuleViolation,
  assertCapacityValueValid,
  assertDayShiftStartValid,
  assertEquipmentAllowsSlot,
  assertOperationPlannedQtyWithinOffline,
  evaluateCapacityWarning,
  isCapacityOverrunConfirmed,
  planSlotSave,
  sumOperationPlannedQty,
  sumPlannedQty,
  type SlotIdentityKey,
} from '@cadenza/domain'
import type {
  EquipmentLookup,
  SchedulingCommandTools,
  SchedulingOrderLookup,
  SchedulingOrderOperationLookup,
  SlotIdentityKey as AppSlotIdentityKey,
} from './scheduling-repositories'
import type { OrgNodeRecord } from './repositories'

/**
 * scheduling 域命令处理器（全部在命令总线事务内运行；命令事务即 UoW）。
 * 规则来源为咨询底稿 03-production-chain-rules-T05T09T10T11.md 的 A3/A4 节与 B11/S10 裁定
 * （本域尚无冻结合同，逐条对照见 delivery/L1/server-scheduling/DELIVERY.md §6）；
 * 写路径范围二道防线沿用 OA-26 模式（HTTP 守卫首检 + 事务内服务端复核）。
 *
 * 命令面（5）：
 * - scheduling.slot.save：单槽位保存（改 0 = 删槽；[底稿 A3-1] 唯一键替换语义；
 *   [A3-2] 硬校验强拒；[A3-2w] 超产能弱提醒 confirm 二次确认）；
 * - scheduling.slot.saveBatch：批量矩阵保存（订单「设备排产」/设备看板添加排产整批，
 *   硬校验逐工序、产能整批一次确认，[底稿 A3 / ES §2.1]）；
 * - scheduling.capacity.set / clear：设备日产能配置（[A3-2w] 产能空不比较的两种态）；
 * - scheduling.shift.set：白班起点（工厂级，[A4-1]）。
 *
 * 三个编辑入口（订单排程详情矩阵 / 设备看板 / 订单「设备排产」弹窗）共用同一提交能力
 * （OS §1.1/§2.2、ES §1.1）——即本命令面；PDA 排产计划只读无命令（[A3-7]）。
 */

type Payload = Record<string, unknown>

function bad(message: string, errorCode: string = ERROR_CODES.BUSINESS_RULE): HandlerOutcome {
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: message }
}

/** 辅助函数内提前拒绝（抛出后在 run() 内还原为 HandlerOutcome）。 */
class Rejection extends Error {
  constructor(readonly outcome: HandlerOutcome) {
    super(outcome.errorMessage ?? '业务拒绝')
    this.name = 'SchedulingRejection'
  }
}

function violationOutcome(error: SchedulingRuleViolation | OrgRuleViolation): HandlerOutcome {
  // 范围越界按 FORBIDDEN_SCOPE 语义（HTTP 层映射 403，沿用 OA-24 口径）
  const errorCode =
    error instanceof OrgRuleViolation ? ERROR_CODES.FORBIDDEN_SCOPE : ERROR_CODES.BUSINESS_RULE
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<HandlerOutcome>): Promise<HandlerOutcome> {
  try {
    return await body()
  } catch (error) {
    if (error instanceof Rejection) return error.outcome
    if (error instanceof SchedulingRuleViolation || error instanceof OrgRuleViolation) {
      return violationOutcome(error)
    }
    throw error
  }
}

function str(payload: Payload, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' ? v : undefined
}

function dec(payload: Payload, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** 取 scheduling 仓储束（组合根装配的 CommandTools 超集）。 */
function sch(tools: CommandTools): SchedulingCommandTools['scheduling'] {
  return (tools as SchedulingCommandTools).scheduling
}

// ---------------------------------------------------------------------------
// 范围与对象解析（沿用 process 块 OA-26 二道防线模式）
// ---------------------------------------------------------------------------

/** 企业活动节点索引（dev 规模，全量载入用于 plant 解析）。 */
async function nodeMapOf(tools: CommandTools, enterpriseId: string): Promise<Map<string, OrgNodeRecord>> {
  const nodes = await tools.org.listActiveByEnterprise(enterpriseId)
  return new Map(nodes.map((n) => [n.id, n]))
}

/** 写路径范围二道防线（OA-26 模式）：目标厂须在 actor 数据范围内。 */
async function assertWriteScope(tools: CommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!isPlantInScope(scope, plantId)) {
    throw new OrgRuleViolation('OA-24', '目标工厂不在授权数据范围内（服务端范围检查）')
  }
}

/** 解析有效工厂节点（班次参数等厂级对象的直接归属）。 */
async function requirePlant(tools: CommandTools, enterpriseId: string, plantId: string): Promise<OrgNodeRecord> {
  const map = await nodeMapOf(tools, enterpriseId)
  const plant = map.get(plantId)
  if (!plant || plant.kind !== 'plant') {
    throw new Rejection(bad('目标工厂不存在或不属于本企业', ERROR_CODES.NOT_FOUND))
  }
  return plant
}

/** 解析设备（0003 主数据；活动、同企业）。 */
async function requireEquipment(
  tools: CommandTools,
  enterpriseId: string,
  equipmentId: string,
): Promise<EquipmentLookup> {
  const equipment = await sch(tools).lookups.findEquipment(equipmentId)
  if (equipment === null || equipment.enterpriseId !== enterpriseId) {
    throw new Rejection(bad('设备不存在或不属于本企业', ERROR_CODES.NOT_FOUND))
  }
  if (equipment.status !== 'active') {
    throw new Rejection(bad(`设备【${equipment.name}】已失效，不可排产`))
  }
  return equipment
}

/** 解析订单 + 订单工序（0005 工艺订单表只读；返回二者）。 */
async function requireOrderAndOperation(
  tools: CommandTools,
  enterpriseId: string,
  orderOperationId: string,
): Promise<{ order: SchedulingOrderLookup; operation: SchedulingOrderOperationLookup }> {
  const operation = await sch(tools).lookups.findOrderOperation(orderOperationId)
  if (operation === null) {
    throw new Rejection(bad('订单工序不存在', ERROR_CODES.NOT_FOUND))
  }
  const order = await sch(tools).lookups.findOrder(operation.orderId)
  if (order === null || order.enterpriseId !== enterpriseId) {
    throw new Rejection(bad('生产订单不存在或不属于本企业', ERROR_CODES.NOT_FOUND))
  }
  return { order, operation }
}

/**
 * [合同新造 NEW-2] 已结束/已作废订单不可写入排产（PRD 仅在看板侧排除已结束订单排产；
 * 写入侧拒绝避免「保存成功但看板不可见」的不一致——同 A3-5 展示口径方向从严）。
 */
function assertOrderWritableForScheduling(order: SchedulingOrderLookup): void {
  if (order.orderStatus === 'closed') {
    throw new SchedulingRuleViolation('NEW-2', '订单已结束，不可写入排产')
  }
  if (order.orderStatus === 'voided') {
    throw new SchedulingRuleViolation('NEW-2', '订单已作废，不可写入排产')
  }
}

// ---------------------------------------------------------------------------
// 槽位保存共用的评估管线（单条与批量同一规则链，[底稿 A3] 三入口共用提交能力）
// ---------------------------------------------------------------------------

/** 待保存槽位条目（解析后的标准形状）。 */
interface SlotEntry {
  order: SchedulingOrderLookup
  operation: SchedulingOrderOperationLookup
  equipment: EquipmentLookup
  identity: AppSlotIdentityKey
  plannedQty: string
  remark: string | null
  confirm?: boolean
}

/** 解析并校验一条槽位载荷（存在性/范围/隔离/NEW-2 订单可排产性）。 */
async function parseSlotEntry(
  tools: CommandTools,
  enterpriseId: string,
  entry: Payload,
  index: number,
): Promise<SlotEntry> {
  const orderOperationId = str(entry, 'orderOperationId')
  const equipmentId = str(entry, 'equipmentId')
  const productionDate = str(entry, 'productionDate')
  const plannedQty = dec(entry, 'plannedQty')
  if (!orderOperationId || !equipmentId || !productionDate || plannedQty === undefined) {
    throw new SchedulingRuleViolation(
      'A3-1',
      `槽位条目[${index}] 需要 orderOperationId/equipmentId/productionDate/plannedQty`,
    )
  }
  const { order, operation } = await requireOrderAndOperation(tools, enterpriseId, orderOperationId)
  await assertWriteScope(tools, order.plantId)
  assertOrderWritableForScheduling(order)
  const equipment = await requireEquipment(tools, enterpriseId, equipmentId)
  // [合同新造 NEW-1] 厂级隔离：排产设备须与订单同厂（plant_id 隔离口径，DM §2 订单/调度同厂）
  if (equipment.plantId !== order.plantId) {
    throw new SchedulingRuleViolation('NEW-1', '排产设备不属于订单所在工厂（厂级隔离）')
  }
  return {
    order,
    operation,
    equipment,
    identity: {
      orderId: order.id,
      orderOperationId: operation.id,
      operationDefinitionId: operation.operationDefinitionId,
      equipmentId,
      productionDate,
    },
    plannedQty,
    remark: str(entry, 'remark') ?? null,
    confirm: entry['confirm'] === true ? true : undefined,
  }
}

/**
 * 硬校验 + 设备状态 + 产能弱提醒的完整评估。
 * 返回逐条保存决策与弱提醒集合；任何硬违规直接抛（A3-2/A3-3 强拒，confirm 不豁免）。
 */
async function evaluateSlotEntries(
  tools: CommandTools,
  entries: readonly SlotEntry[],
): Promise<{
  plans: Array<{ entry: SlotEntry; plan: ReturnType<typeof planSlotSave>; existingPlannedQty: string | null }>
  warnings: string[]
}> {
  const slots = sch(tools).slots
  const plans: Array<{ entry: SlotEntry; plan: ReturnType<typeof planSlotSave>; existingPlannedQty: string | null }> = []
  for (const entry of entries) {
    const existing = await slots.findSlot(entry.identity)
    const plan = planSlotSave({
      identity: entry.identity,
      plannedQty: entry.plannedQty,
      existingSlot: existing === null ? null : { plannedQty: existing.plannedQty },
    })
    plans.push({ entry, plan, existingPlannedQty: existing === null ? null : existing.plannedQty })
  }

  // [底稿 A3-2] 硬校验：按订单工序分组，其它槽合计（排除本批替换/删除的键）+ 本批新值合计 ≤ 下线数量
  const byOperation = new Map<string, { entries: typeof plans; offlineQty: string; label: string }>()
  for (const item of plans) {
    if (item.plan.kind === 'noop') continue // 无现存槽改 0：不参与任何校验
    const key = item.entry.operation.id
    const group = byOperation.get(key) ?? {
      entries: [],
      offlineQty: item.entry.operation.offlineQty,
      label: `工序 ${item.entry.operation.operationName}`,
    }
    group.entries.push(item)
    byOperation.set(key, group)
  }
  for (const [operationId, group] of byOperation) {
    const batchIdentities = new Set(group.entries.map((i) => identityKeyString(i.entry.identity)))
    const otherSlots = await slots.listByOrderOperation(operationId)
    const otherTotal = sumPlannedQty(
      otherSlots
        .filter((s) => !batchIdentities.has(identityKeyString(s)))
        .map((s) => s.plannedQty),
      '其它槽位计划合计',
    )
    const batchTotal = sumPlannedQty(
      group.entries.map((i) => (i.plan.kind === 'upsert' ? i.plan.plannedQty : '0')),
      '本批计划合计',
    )
    assertOperationPlannedQtyWithinOffline({
      offlineQty: group.offlineQty,
      plannedTotal: sumOperationPlannedQty({
        otherSlotsPlannedQty: otherTotal,
        currentSlotNewQty: batchTotal,
      }),
      operationLabel: group.label,
    })
  }

  // [底稿 A3-3] 设备状态约束（仅对正数 upsert 行；删槽行放行）
  for (const item of plans) {
    if (item.plan.kind !== 'upsert') continue
    assertEquipmentAllowsSlot({
      equipmentStatus: item.entry.equipment.equipmentStatus,
      equipmentName: item.entry.equipment.name,
      existingSlotPlannedQty: item.existingPlannedQty,
      newPlannedQty: item.plan.plannedQty,
    })
  }

  // [底稿 A3-2w] 超设备日产能弱提醒：按（设备, 日期）分组，其它槽合计（排除本批键）+ 本批新值合计
  const warnings: string[] = []
  const byEquipmentDay = new Map<string, { entry: SlotEntry; newQtySum: string }>()
  for (const item of plans) {
    if (item.plan.kind !== 'upsert') continue // 删槽不触发超产能确认（OS §2.2）
    const key = `${item.entry.identity.equipmentId}|${item.entry.identity.productionDate}`
    const current = byEquipmentDay.get(key)
    if (current === undefined) {
      byEquipmentDay.set(key, { entry: item.entry, newQtySum: item.plan.plannedQty })
    } else {
      current.newQtySum = sumPlannedQty([current.newQtySum, item.plan.plannedQty], '本批设备日计划合计')
    }
  }
  for (const [key, group] of byEquipmentDay) {
    const [equipmentId, productionDate] = key.split('|')
    const capacityRow = await sch(tools).capacities.findByEquipmentAndDate(equipmentId!, productionDate!)
    if (capacityRow === null) continue // 产能未配置（空）不比较（OS §2.2、ES §2.1）
    const batchIdentities = new Set(
      plans
        .filter((i) => i.plan.kind === 'upsert')
        .map((i) => identityKeyString(i.entry.identity)),
    )
    const dayRows = await slots.listViewRows({
      plantIds: null,
      equipmentId,
      dates: [productionDate!],
      includeFinishedOrders: true, // 当日累计口径 = 全部订单（弱提醒比的是设备物理负载）
    })
    const otherDayTotal = sumPlannedQty(
      dayRows
        .filter((row) => {
          const rowIdentity: AppSlotIdentityKey = {
            orderId: row.orderId,
            orderOperationId: row.orderOperationId,
            operationDefinitionId: row.operationDefinitionId,
            equipmentId: row.equipmentId,
            productionDate: row.productionDate,
          }
          return !batchIdentities.has(identityKeyString(rowIdentity))
        })
        .map((row) => row.plannedQty),
      '当日设备其它排产合计',
    )
    const warning = evaluateCapacityWarning({
      equipmentName: group.entry.equipment.name,
      productionDate: productionDate!,
      capacity: capacityRow.capacity,
      equipmentDayPlannedTotal: sumPlannedQty([otherDayTotal, group.newQtySum], '当日设备累计排产'),
    })
    if (warning !== null) warnings.push(warning.message)
  }
  return { plans, warnings }
}

/** 唯一键稳定串（排除集合比较用）。 */
function identityKeyString(identity: AppSlotIdentityKey | SlotIdentityKey): string {
  return [
    identity.orderId,
    identity.orderOperationId,
    identity.operationDefinitionId,
    identity.equipmentId,
    identity.productionDate,
  ].join('|')
}

/** 执行保存决策（删/upsert；noop 跳过）。 */
async function applySlotPlans(
  tools: CommandTools,
  actor: string | null,
  plans: ReadonlyArray<{ entry: SlotEntry; plan: ReturnType<typeof planSlotSave> }>,
): Promise<{ deleted: number; upserted: number; noop: number; slotIds: string[] }> {
  const slots = sch(tools).slots
  let deleted = 0
  let upserted = 0
  let noop = 0
  const slotIds: string[] = []
  for (const { entry, plan } of plans) {
    if (plan.kind === 'noop') {
      noop += 1
      continue
    }
    if (plan.kind === 'delete') {
      await slots.deleteSlot(entry.identity)
      deleted += 1
      continue
    }
    const saved = await slots.upsert({
      enterpriseId: entry.order.enterpriseId,
      plantId: entry.order.plantId,
      orderId: entry.identity.orderId,
      orderOperationId: entry.identity.orderOperationId,
      operationDefinitionId: entry.identity.operationDefinitionId,
      equipmentId: entry.identity.equipmentId,
      productionDate: entry.identity.productionDate,
      plannedQty: plan.plannedQty,
      uom: entry.operation.uom,
      remark: entry.remark,
      createdBy: actor,
    })
    upserted += 1
    slotIds.push(saved.id)
  }
  return { deleted, upserted, noop, slotIds }
}

// ---------------------------------------------------------------------------
// 命令处理器
// ---------------------------------------------------------------------------

export function createSchedulingCommandHandlers(): CommandHandler[] {
  /**
   * scheduling.slot.save：单槽位保存（[底稿 A3-1] 改 0 = 删槽 / 同键替换）。
   * confirm 语义（[A3-2w]）：超产能且未确认 → 拒（错误文案即二次确认提示，携带 confirm=true 重试）；
   * 超产能且已确认 → 提交并在 data.warning 返回提醒文案；硬校验（[A3-2]）不豁免。
   */
  const slotSave: CommandHandler = {
    commandType: 'scheduling.slot.save',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const entry = await parseSlotEntry(tools, ctx.enterpriseId, p, 0)
        const { plans, warnings } = await evaluateSlotEntries(tools, [entry])
        const batchConfirm = p['confirm'] === true
        if (warnings.length > 0 && !isCapacityOverrunConfirmed(batchConfirm)) {
          return bad(`[A3-2w] ${warnings[0]!}（超设备日产能为弱提醒，确认后请携带 confirm=true 重新提交）`)
        }
        const applied = await applySlotPlans(tools, ctx.actorLoginName, plans)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'scheduling.slot.save',
          subjectType: 'schedule_slot',
          subjectId: entry.identity.orderOperationId,
          before: { plannedQty: plans[0]?.existingPlannedQty ?? null },
          after: {
            equipmentId: entry.identity.equipmentId,
            productionDate: entry.identity.productionDate,
            plannedQty: entry.plannedQty,
            applied,
            capacityOverrunConfirmed: warnings.length > 0,
          },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: {
            action:
              applied.upserted > 0 ? 'upserted' : applied.deleted > 0 ? 'deleted' : 'noop',
            slotId: applied.slotIds[0] ?? null,
            warnings: warnings.length > 0 ? warnings : null,
          },
        }
      }),
  }

  /**
   * scheduling.slot.saveBatch：批量矩阵保存（设备看板「添加排产」整批 / 订单「设备排产」弹窗）。
   * [底稿 A3 / ES §2.1] 硬校验逐工序拒绝整批；超产能弱提醒整批只确认一次（confirm 载荷级）。
   */
  const slotSaveBatch: CommandHandler = {
    commandType: 'scheduling.slot.saveBatch',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const raw = p['entries']
        if (!Array.isArray(raw) || raw.length === 0) {
          return bad('[A3-1] entries 必须为非空数组（批量矩阵保存载荷）')
        }
        const entries: SlotEntry[] = []
        for (let i = 0; i < raw.length; i += 1) {
          entries.push(await parseSlotEntry(tools, ctx.enterpriseId, (raw[i] ?? {}) as Payload, i))
        }
        // 批内唯一键查重（同一键出现两次=载荷冲突；目标态同键至多一条有效行）
        const seen = new Set<string>()
        for (const entry of entries) {
          const key = identityKeyString(entry.identity)
          if (seen.has(key)) {
            return bad('[A3-1] 批量载荷包含重复槽位键（同订单工序+设备+生产日期），请合并为一行')
          }
          seen.add(key)
        }
        const { plans, warnings } = await evaluateSlotEntries(tools, entries)
        const batchConfirm = p['confirm'] === true
        if (warnings.length > 0 && !isCapacityOverrunConfirmed(batchConfirm)) {
          return bad(
            `[A3-2w] ${warnings.join('；')}（超设备日产能为弱提醒，整批确认一次，请携带 confirm=true 重新提交）`,
          )
        }
        const applied = await applySlotPlans(tools, ctx.actorLoginName, plans)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'scheduling.slot.saveBatch',
          subjectType: 'schedule_slot',
          subjectId: 'batch',
          after: {
            entryCount: entries.length,
            applied,
            capacityOverrunConfirmed: warnings.length > 0,
          },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: {
            applied,
            warnings: warnings.length > 0 ? warnings : null,
          },
        }
      }),
  }

  /** scheduling.capacity.set：设备日产能配置（[A3-2w] 数值 + 单位；含配置为 0 = 零产能）。 */
  const capacitySet: CommandHandler = {
    commandType: 'scheduling.capacity.set',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const equipmentId = str(p, 'equipmentId')
        const productionDate = str(p, 'productionDate')
        const capacity = dec(p, 'capacity')
        if (!equipmentId || !productionDate || capacity === undefined) {
          return bad('payload 需要 equipmentId/productionDate/capacity')
        }
        const equipment = await requireEquipment(tools, ctx.enterpriseId, equipmentId)
        await assertWriteScope(tools, equipment.plantId)
        // [底稿 A3-2w] 产能口径（ES §2.1：已配置含 0；未配置由行不存在表达）
        assertCapacityValueValid(capacity)
        const saved = await sch(tools).capacities.upsert({
          enterpriseId: ctx.enterpriseId,
          plantId: equipment.plantId,
          equipmentId,
          productionDate,
          capacity,
          uom: str(p, 'uom') ?? null,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'scheduling.capacity.set',
          subjectType: 'capacity_calendar',
          subjectId: saved.id,
          after: { equipmentId, productionDate, capacity, uom: saved.uom },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { capacityId: saved.id, equipmentId, productionDate, capacity } }
      }),
  }

  /** scheduling.capacity.clear：删除设备日产能配置（回到「未配置不比较」态）。 */
  const capacityClear: CommandHandler = {
    commandType: 'scheduling.capacity.clear',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const equipmentId = str(p, 'equipmentId')
        const productionDate = str(p, 'productionDate')
        if (!equipmentId || !productionDate) {
          return bad('payload 需要 equipmentId/productionDate')
        }
        const equipment = await requireEquipment(tools, ctx.enterpriseId, equipmentId)
        await assertWriteScope(tools, equipment.plantId)
        const deleted = await sch(tools).capacities.deleteByEquipmentAndDate(equipmentId, productionDate)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'scheduling.capacity.clear',
          subjectType: 'capacity_calendar',
          subjectId: `${equipmentId}|${productionDate}`,
          before: { equipmentId, productionDate },
          after: { deleted },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { equipmentId, productionDate, deleted } }
      }),
  }

  /** scheduling.shift.set：白班起点（工厂级唯一，[底稿 A4-1]）。 */
  const shiftSet: CommandHandler = {
    commandType: 'scheduling.shift.set',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const plantId = str(p, 'plantId')
        const dayShiftStart = str(p, 'dayShiftStart')
        if (!plantId || !dayShiftStart) {
          return bad('payload 需要 plantId/dayShiftStart')
        }
        const plant = await requirePlant(tools, ctx.enterpriseId, plantId)
        await assertWriteScope(tools, plant.id)
        // [底稿 A4-1] 白班起点口径（HH:MM 24 小时制）
        assertDayShiftStartValid(dayShiftStart)
        const saved = await sch(tools).shifts.upsert({
          enterpriseId: ctx.enterpriseId,
          plantId: plant.id,
          dayShiftStart,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'scheduling.shift.set',
          subjectType: 'shift_parameter',
          subjectId: saved.id,
          after: { plantId: plant.id, dayShiftStart },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { shiftId: saved.id, plantId: plant.id, dayShiftStart } }
      }),
  }

  return [slotSave, slotSaveBatch, capacitySet, capacityClear, shiftSet]
}
