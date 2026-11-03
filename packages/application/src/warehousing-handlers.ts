import { ERROR_CODES } from '@cadenza/contracts'
import {
  InventoryRuleViolation,
  addQty,
  assertReservationUsableForCommit,
  cmpQty,
  ensureStableLockOrder,
  isPositiveQty,
  isValidQuantityString,
  subQty,
} from '@cadenza/domain'
// L0 整合步（Wave5）：domain index 已导出 './warehousing' 与 './quality'；改包名导入（原 dist 相对导入 + eslint-disable 删除）。
import {
  WarehousingRuleViolation,
  assertMoveExecutable,
  assertPutawayConfirmable,
  assertPutawayTargetWarehouse,
  assertRackPutawayLocation,
  assertTransferLockEffective,
  assertTransferLockIssuable,
  assertTransferOutboundExecutable,
  assertTransferStep,
  assertTransferWarehouses,
  assertTransitNotDoubleCounted,
  assertWholePalletPutaway,
  type MoveCheckFacts,
} from '@cadenza/domain'
import { assertOutboundQualityGate } from '@cadenza/domain'
import type { CommandHandler, HandlerOutcome } from './command-bus'
import {
  acquireReservation,
  moveStock,
  receiveGoods,
  transferIn,
  transferOut,
} from './inventory-posting'
import { violationOutcome } from './inventory-handlers'
import { NOT_FOUND_RULE, buildPostingContext, type PostingContext } from './inventory-posting'
import type {
  PutawayTaskRecord,
  WarehousingCommandTools,
} from './warehousing-repositories'

/**
 * warehousing 域命令处理器（T13 入库/移库/调拨；全部在命令总线事务内运行，命令事务即 UoW）。
 *
 * 命令面（8）：
 * - warehousing.putaway.refresh：入库任务刷新——从 ExecutionEventPort 重跑事件流生成待入库任务
 *   台账（来源幂等；A-T13-1 台账禁手工增删改，仅此通道写入）；
 * - warehousing.putaway.confirm：组单确认入库（任务台账/组单两入口共用同一记账服务——
 *   等价内部 receive 记账，调 inventory 同一记账序；A-T13-2 上架规则：成品类实体物流仓+
 *   货架码+层拼位+托码整托）；
 * - warehousing.move.execute：移库（同仓内库位移动；A-T13-4 四拒一成校验；生成移库记录）；
 * - warehousing.transfer.create / submit / ship / transit / receive：调拨状态机
 *   （A-T13-10：草稿→待执行→出库中→已出库在途→收货中→完成；每步原子两段——
 *   ship=来源减+在途增、receive=在途减+目的增 各自一个事务两行流水；transit=在途对账
 *   （两仓不重复统计）；submit 逐行锁定=作业预留含有效期 A-T13-11）。
 *
 * 幂等/回执由 PgCommandBus 承担；规则违例以 [A-T13-x]/[A-T12-x] 前缀返回（BUSINESS_REJECTION）。
 */

type Payload = Record<string, unknown>

function warehousingViolationOutcome(error: WarehousingRuleViolation): HandlerOutcome {
  // 组织隔离二道防线（OA-24/26 口径随行）→ FORBIDDEN_SCOPE（HTTP 403）；未找到 → NOT_FOUND（404）
  let errorCode: string = ERROR_CODES.BUSINESS_RULE
  if (error.rule === 'A-S1') errorCode = ERROR_CODES.FORBIDDEN_SCOPE
  else if (error.rule === NOT_FOUND_RULE) errorCode = ERROR_CODES.NOT_FOUND
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<Record<string, unknown>>): Promise<HandlerOutcome> {
  try {
    const data = await body()
    return { status: 'COMMITTED', data }
  } catch (error) {
    if (error instanceof WarehousingRuleViolation) return warehousingViolationOutcome(error)
    if (error instanceof InventoryRuleViolation) return violationOutcome(error)
    throw error
  }
}

function str(p: Payload, key: string): string | undefined {
  const v = p[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function dec(p: Payload, key: string): string | undefined {
  const v = p[key]
  return typeof v === 'string' && isValidQuantityString(v) ? v : undefined
}

function requireStr(p: Payload, key: string, command: string): string {
  const v = str(p, key)
  if (v === undefined) throw new WarehousingRuleViolation('A-T13-1', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

/** 组织范围二道防线（OA-24/26）。 */
async function assertPlantScope(tools: WarehousingCommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new WarehousingRuleViolation('A-S1', `目标工厂不在授权数据范围内（plant=${plantId}）`)
  }
}

function whTools(pc: PostingContext): WarehousingCommandTools {
  return pc.tools as WarehousingCommandTools
}

// ---------------- 等价内部记账服务：报工产出单元入库（A-T13-1/IT-25 同一记账序） ----------------

/**
 * 确认入库的单任务库存入账。新单元路径原等价服务 createUnitLine 已删除（ABS 收编轮）：
 * inventory-posting.receiveGoods 已参数化 lineNo/lotKind=production/refType=putaway_task/
 * genealogyEdgeKind=production_output/entryPurpose=putaway_confirm/审计与 Outbox 域形状透传，
 * 本函数直调核心（同一记账序 IT-25、同一 tools.inv 端口束、同 UoW）。
 * 两入库入口（任务台账逐任务/组单批量）共用本函数——同一记账（余额/流水一致，证据③）。
 *
 * D-2 修复（S03：报工产出已在线边库形成单元）：任务 unitNo=同厂在库既有单元时，
 * 组单确认上架=对既有单元移位记账（moveStock 到目标仓/库位：身份/批次/谱系/质量态保留，
 * 不新建单元、不双计库存）；unitNo 无在库单元（真正的新收货来源，如质检放行外部产出）
 * 走新单元 receive 记账（核心 receiveGoods）。事件映射与来源幂等键不变。
 *
 * 差异注记：批次物料不符/单元号重复两条拒绝路径的规则码由 [A-T13-1] 随核心口径变为
 * [IT-01]（本域来源幂等键保证同 sourceRef 同物料、单元号存在性已前置判定，两路径不可达）。
 */
async function receiveUnitLine(
  pc: PostingContext,
  spec: {
    lineNo: number
    task: PutawayTaskRecord
    plantId: string
    qualityStatus: 'qualified' | 'pending_inspection'
    toLocationId: string
    toLocationCode: string
    ownerId: string
    ownerName: string
    reason?: string | null
  },
): Promise<{ unitId: string; lotId: string; balanceId: string; transactionId: string; unitNo: string; linesUsed: number }> {
  const wh = whTools(pc)
  if (spec.task.unitNo !== null) {
    const existing = await wh.inv.units.findByUnitNo(spec.plantId, spec.task.unitNo)
    if (existing !== null) {
      return moveExistingUnitLine(pc, spec, existing)
    }
  }
  // 新单元入账（unitNo 无在库单元的真正新收货来源）：直调核心 receiveGoods（ABS 收编）
  const goods = await receiveGoods(pc, {
    plantId: spec.plantId,
    lineNo: spec.lineNo,
    quantity: spec.task.quantity,
    uomId: spec.task.uomId,
    uomCode: spec.task.uomCode,
    locationId: spec.toLocationId,
    locationCode: spec.toLocationCode,
    ownerId: spec.ownerId,
    ownerName: spec.ownerName,
    lotNo: `PRD-${spec.task.sourceRef}`,
    lotKind: 'production',
    materialId: spec.task.materialId,
    materialCode: spec.task.materialCode,
    unitNo: spec.task.unitNo ?? `PUT-${spec.task.id.slice(0, 8).toUpperCase()}`,
    qualityStatus: spec.qualityStatus,
    refType: 'putaway_task',
    refId: spec.task.id,
    genealogyEdgeKind: 'production_output',
    entryPurpose: 'putaway_confirm',
    auditAction: 'warehousing.putaway.receive-line',
    auditAfterExtra: { sourceRef: spec.task.sourceRef, qualityStatus: spec.qualityStatus },
    outboxTaskKind: 'warehousing.goods-putaway',
    outboxPayloadExtra: { sourceRef: spec.task.sourceRef },
    recordToColumns: true,
    reason: spec.reason ?? undefined,
  })
  return {
    unitId: String(goods['unitId']),
    lotId: String(goods['lotId']),
    balanceId: String(goods['balanceId']),
    transactionId: String(goods['transactionId']),
    unitNo: String(goods['unitNo']),
    linesUsed: 1, // 新单元收货 1 行（既有单元移位 2 行）
  }
}

/**
 * 既有在库单元的移位上架（D-2）：复用 inventory moveStock 等价通道——锁单元→校验→
 * move 流水两行（原/现库位，ref=putaway_task）→余额（质量态保留，IT-29 零余额关闭原库位余额）。
 */
async function moveExistingUnitLine(
  pc: PostingContext,
  spec: {
    lineNo: number
    task: PutawayTaskRecord
    plantId: string
    qualityStatus: 'qualified' | 'pending_inspection'
    toLocationId: string
    toLocationCode: string
    ownerId: string
    ownerName: string
    reason?: string | null
  },
  unit: { id: string; unitNo: string; lotId: string; status: string },
): Promise<{ unitId: string; lotId: string; balanceId: string; transactionId: string; unitNo: string; linesUsed: number }> {
  if (unit.status !== 'in_stock') {
    throw new WarehousingRuleViolation(
      'A-T13-1',
      `库存单元 ${spec.task.unitNo} 已存在但不在库（状态 ${unit.status}），不可按新单元入库；请待单元回库后按移位上架`,
    )
  }
  const moved = await moveStock(pc, {
    unitId: unit.id,
    quantity: spec.task.quantity,
    lineNoBase: spec.lineNo,
    toLocationId: spec.toLocationId,
    toLocationCode: spec.toLocationCode,
    toOwnerId: spec.ownerId,
    toOwnerName: spec.ownerName,
    reason: spec.reason ?? `组单入库上架（任务 ${spec.task.sourceRef}：既有单元移位，不新建单元）`,
    refType: 'putaway_task',
    refId: spec.task.id,
  })
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'warehousing.putaway.move-line',
    subjectType: 'inventory_unit',
    subjectId: unit.id,
    after: {
      unitNo: unit.unitNo,
      quantity: spec.task.quantity,
      toLocationCode: spec.toLocationCode,
      sourceRef: spec.task.sourceRef,
      note: '既有单元移位上架（D-2：报工产出已在线边库成单元）',
    },
    reason: spec.reason ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'inventory_unit',
    aggregateId: unit.id,
    taskKind: 'warehousing.goods-putaway',
    payload: {
      unitId: unit.id,
      unitNo: unit.unitNo,
      lotId: unit.lotId,
      materialCode: spec.task.materialCode,
      quantity: spec.task.quantity,
      uomCode: spec.task.uomCode,
      locationCode: spec.toLocationCode,
      sourceRef: spec.task.sourceRef,
      moved: true,
      businessTime: pc.businessTime,
    },
  })
  return {
    unitId: unit.id,
    lotId: unit.lotId,
    balanceId: String(moved['toBalanceId'] ?? ''),
    transactionId: String((moved['transactionIds'] as string[] | undefined)?.[0] ?? ''),
    unitNo: unit.unitNo,
    linesUsed: 2, // move 两行（来源减 lineN / 现库位增 lineN+1）
  }
}


// ---------------- 命令：入库任务刷新（A-T13-1；从端口重跑） ----------------

async function putawayRefresh(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = whTools(pc)
  const plantId = requireStr(p, 'plantId', 'warehousing.putaway.refresh')
  await assertPlantScope(tools, plantId)

  const eventTypesRaw = p['eventTypes']
  const eventTypes = Array.isArray(eventTypesRaw) && eventTypesRaw.every((t) => typeof t === 'string')
    ? (eventTypesRaw as string[])
    : ['work_report_confirmed', 'finished_inspection_released']
  const events = await tools.events.fetchEvents({ types: eventTypes, plantId })

  const created: Array<Record<string, unknown>> = []
  let skipped = 0
  for (const event of events) {
    const sourceType = event.eventType === 'finished_inspection_released' ? 'finished_inspection' : 'work_report'
    const quantity = event.payload.quantity
    if (!isPositiveQty(quantity)) {
      throw new WarehousingRuleViolation('A-T13-1', `事件 ${event.eventId} 数量非法（须为正十进制定点字符串）`)
    }
    // A-T13-1：来源幂等（refresh 重跑不重复生成；台账禁手工增删改——仅此通道写入）
    const existing = await tools.wh.putawayTasks.findBySource(sourceType, event.payload.sourceRef)
    if (existing !== null) {
      skipped += 1
      continue
    }
    const task = await tools.wh.putawayTasks.insert({
      sourceType,
      sourceRef: event.payload.sourceRef,
      unitNo: event.payload.unitNo ?? null,
      palletCode: event.payload.palletCode ?? null,
      materialId: event.payload.materialId,
      materialCode: event.payload.materialCode,
      quantity,
      uomId: event.payload.uomId,
      uomCode: event.payload.uomCode,
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
    created.push({ taskId: task.id, sourceType, sourceRef: task.sourceRef, unitNo: task.unitNo, palletCode: task.palletCode })
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'warehousing.putaway.refresh',
    subjectType: 'putaway_task',
    subjectId: (created[0] as { taskId?: string } | undefined)?.taskId ?? 'n/a',
    after: { created: created.length, skipped, events: events.length },
    reason: str(p, 'reason') ?? null,
  })
  return { created, skipped, eventsSeen: events.length }
}

// ---------------- 命令：组单确认入库（A-T13-1/2；两入口共用同一记账） ----------------

async function putawayConfirm(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = whTools(pc)
  const plantId = requireStr(p, 'plantId', 'warehousing.putaway.confirm')
  await assertPlantScope(tools, plantId)

  const toWarehouseId = requireStr(p, 'toWarehouseId', 'warehousing.putaway.confirm')
  const toWarehouseKind = str(p, 'toWarehouseKind')
  if (toWarehouseKind === undefined) {
    throw new WarehousingRuleViolation(
      'A-T13-2',
      '确认入库须携带 toWarehouseKind（目标仓库类型事实：物流仓/成品仓；0003 主数据字典扩展后由查询提供）',
    )
  }
  const toLocationId = requireStr(p, 'toLocationId', 'warehousing.putaway.confirm')
  const toLocationCode = requireStr(p, 'toLocationCode', 'warehousing.putaway.confirm')
  const ownerId = requireStr(p, 'ownerId', 'warehousing.putaway.confirm')
  const ownerName = requireStr(p, 'ownerName', 'warehousing.putaway.confirm')
  // A-T13-2：目标=成品类实体物流仓 + 货架码+层拼位
  assertPutawayTargetWarehouse({ warehouseKind: toWarehouseKind, materialType: null, warehouseId: toWarehouseId })
  assertRackPutawayLocation(toLocationCode, toLocationId)
  const toLocation = await tools.wh.locations.findById(toLocationId)
  if (toLocation === null) throw new WarehousingRuleViolation(NOT_FOUND_RULE, '目标库位不存在')
  if (toLocation.warehouseId !== toWarehouseId) {
    throw new WarehousingRuleViolation('A-T13-2', '目标库位不属于目标仓库（同任务组单禁跨仓换库位）')
  }

  // 任务定位：taskIds（台账入口）∪ unitNos（组单入口）∪ palletCode（整托）
  const taskIdsRaw = p['taskIds']
  const taskIds = Array.isArray(taskIdsRaw) ? taskIdsRaw.filter((t): t is string => typeof t === 'string') : []
  const unitNosRaw = p['unitNos']
  const unitNos = Array.isArray(unitNosRaw) ? unitNosRaw.filter((t): t is string => typeof t === 'string') : []
  const palletCode = str(p, 'palletCode')

  const tasks = new Map<string, PutawayTaskRecord>()
  if (taskIds.length > 0) {
    for (const task of await tools.wh.putawayTasks.findByIds(taskIds)) {
      if (task.plantId !== plantId) throw new WarehousingRuleViolation('A-S1', `任务 ${task.sourceRef} 不在目标工厂`)
      tasks.set(task.id, task)
    }
    if (tasks.size !== taskIds.length) throw new WarehousingRuleViolation(NOT_FOUND_RULE, '部分任务不存在（taskIds 定位失败）')
  }
  if (unitNos.length > 0) {
    for (const task of await tools.wh.putawayTasks.listPendingByUnitNos(plantId, unitNos)) {
      tasks.set(task.id, task)
    }
    const found = new Set([...tasks.values()].filter((t) => t.unitNo !== null && unitNos.includes(t.unitNo)).map((t) => t.unitNo))
    const missing = unitNos.filter((u) => !found.has(u))
    if (missing.length > 0) {
      throw new WarehousingRuleViolation(NOT_FOUND_RULE, `以下单元号无待入库任务：${missing.join(',')}`)
    }
  }
  if (palletCode !== undefined) {
    // A-T13-2：托码确认=整托（同托所有未入库任务一并完成）
    const palletTasks = await tools.wh.putawayTasks.listPendingByPallet(palletCode)
    const payloadIds = [...tasks.keys()]
    assertWholePalletPutaway({ palletCode, payloadTaskIds: payloadIds, palletPendingTaskIds: palletTasks.map((t) => t.id) })
    for (const task of palletTasks) {
      if (task.plantId !== plantId) throw new WarehousingRuleViolation('A-S1', `托内任务 ${task.sourceRef} 不在目标工厂`)
      tasks.set(task.id, task)
    }
  }
  if (tasks.size === 0) {
    throw new WarehousingRuleViolation('A-T13-1', '确认入库至少包含一条待入库任务（taskIds/unitNos/palletCode）')
  }

  // 每任务校验 + 入库记账（同一记账服务：流水行号随任务实际占用推进——新单元 1 行、
  // 既有单元移位 2 行，避让 stock_transaction (command_receipt_id, line_no) 唯一约束）
  const results: Array<Record<string, unknown>> = []
  let lineNo = 0
  for (const task of tasks.values()) {
    assertPutawayConfirmable({ status: task.status, sourceRef: task.sourceRef }) // A-T13-1：仅 pending 可确认
    const materialType = await tools.wh.materials.findTypeById(task.materialId)
    assertPutawayTargetWarehouse({ warehouseKind: toWarehouseKind, materialType, warehouseId: toWarehouseId }) // A-T13-2：成品上架
    const goods = await receiveUnitLine(pc, {
      lineNo: lineNo + 1,
      task,
      plantId,
      qualityStatus: task.sourceType === 'finished_inspection' ? 'qualified' : 'pending_inspection',
      toLocationId,
      toLocationCode,
      ownerId,
      ownerName,
      reason: str(p, 'reason') ?? null,
    })
    lineNo += goods.linesUsed
    await tools.wh.putawayTasks.markDone(
      task.id,
      { inventoryUnitId: goods.unitId, locationId: toLocationId, locationCode: toLocationCode, putawayBy: pc.ctx.actorLoginName, putawayAt: pc.businessTime },
      pc.ctx.actorLoginName,
    )
    results.push({ taskId: task.id, sourceRef: task.sourceRef, unitId: goods.unitId, unitNo: goods.unitNo, quantity: task.quantity })
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'warehousing.putaway.confirm',
    subjectType: 'putaway_task',
    subjectId: (results[0] as { taskId?: string } | undefined)?.taskId ?? 'n/a',
    after: { tasks: results.length, toLocationCode, toWarehouseId, palletCode: palletCode ?? null },
    reason: str(p, 'reason') ?? null,
  })
  return { confirmed: results.length, toLocationCode, tasks: results }
}

// ---------------- 命令：移库（A-T13-4 四拒一成） ----------------

async function moveExecute(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = whTools(pc)
  const plantId = requireStr(p, 'plantId', 'warehousing.move.execute')
  await assertPlantScope(tools, plantId)
  const unitId = requireStr(p, 'unitId', 'warehousing.move.execute')
  const toLocationId = requireStr(p, 'toLocationId', 'warehousing.move.execute')
  const toLocationCode = requireStr(p, 'toLocationCode', 'warehousing.move.execute')

  // IT-25：锁单元（稳定次序）
  const locked = await tools.inv.units.lockForUpdate(ensureStableLockOrder([unitId]))
  if (locked.length !== 1) throw new WarehousingRuleViolation(NOT_FOUND_RULE, '库存单元不存在或已不可用')
  const unit = locked[0]!

  const balances = await tools.inv.balances.listActiveByUnit(unitId)
  const fromLocationId = str(p, 'fromLocationId')
  const activeBalances = balances.filter((b) => b.status === 'active' && (fromLocationId === undefined || b.locationId === fromLocationId))
  if (activeBalances.length === 0) throw new WarehousingRuleViolation(NOT_FOUND_RULE, `库存单元 ${unit.unitNo} 无活动余额`)
  if (activeBalances.length > 1) {
    throw new WarehousingRuleViolation('A-T13-4', `库存单元 ${unit.unitNo} 存在 ${activeBalances.length} 条活动余额，移库须显式指定 fromLocationId`)
  }
  const from = activeBalances[0]!
  const quantity = dec(p, 'quantity') ?? from.quantity // 缺省整单元移库

  // 域断言事实收集（A-T13-4）
  const toLocation = await tools.wh.locations.findById(toLocationId)
  if (toLocation === null) throw new WarehousingRuleViolation(NOT_FOUND_RULE, '目标库位不存在')
  const fromLocation = await tools.wh.locations.findById(from.locationId)
  const toWarehouse = await tools.wh.warehouses.findById(toLocation.warehouseId)
  if (toWarehouse === null) throw new WarehousingRuleViolation(NOT_FOUND_RULE, '目标仓库不存在')
  const now = pc.tools.now().toISOString()
  const activeReservations = await tools.inv.reservations.listActiveByUnit(unitId)
  const effectiveHolders = activeReservations.filter(
    (r) => r.status === 'active' && Date.parse(r.validUntil) >= Date.parse(now),
  )
  const facts: MoveCheckFacts = {
    unitNo: unit.unitNo,
    unitStatus: unit.status,
    warehouseLocked: toWarehouse.status !== 'active',
    toWarehouseKind: toWarehouse.warehouseType,
    sameWarehouse: fromLocation !== null && fromLocation.warehouseId === toLocation.warehouseId,
    lockedByOtherTask: effectiveHolders.length > 0,
    sameLocation: from.locationId === toLocationId,
    isPalletChildWithoutWhole: p['isPalletChild'] === true, // 托下单码禁扫（托绑定关系属 T15 分托域，事实由调用方声明）
  }
  assertMoveExecutable(facts)

  // 调 inventory 记账服务（同 UoW；IT-25 记账序：锁→校验→流水两行（原/现库位）→余额）
  const moved = await moveStock(pc, {
    unitId,
    quantity,
    fromLocationId: from.locationId,
    fromOwnerId: from.ownerId,
    toLocationId,
    toLocationCode,
    reason: str(p, 'reason') ?? null,
  })

  // 移库记录（A-T13-4：原/现库位逐码，append-only）
  const move = await tools.wh.moves.insert({
    inventoryUnitId: unitId,
    unitNo: unit.unitNo,
    fromLocationId: from.locationId,
    fromLocationCode: from.locationCode,
    toLocationId,
    toLocationCode,
    quantity,
    uomId: from.uomId,
    uomCode: from.uomCode,
    movedBy: pc.ctx.actorLoginName,
    movedAt: pc.businessTime,
    reason: str(p, 'reason') ?? null,
    commandReceiptId: pc.commandReceiptId,
    plantId: unit.plantId,
    enterpriseId: unit.enterpriseId,
    businessTime: pc.businessTime,
    createdBy: pc.ctx.actorLoginName,
  })

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'warehousing.move.execute',
    subjectType: 'inventory_unit',
    subjectId: unitId,
    before: { locationCode: from.locationCode, quantity: from.quantity },
    after: { locationCode: toLocationCode, quantity: moved.toAfter, moveId: move.id },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'inventory_unit',
    aggregateId: unitId,
    taskKind: 'warehousing.stock-moved',
    payload: { unitId, unitNo: unit.unitNo, quantity, from: from.locationCode, to: toLocationCode, moveId: move.id, businessTime: pc.businessTime },
  })
  return { unitId, moveId: move.id, fromBalanceId: moved.fromBalanceId, toBalanceId: moved.toBalanceId, fromAfter: moved.fromAfter, toAfter: moved.toAfter }
}

// ---------------- 命令：调拨创建（草稿） ----------------

async function transferCreate(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = whTools(pc)
  const plantId = requireStr(p, 'plantId', 'warehousing.transfer.create')
  await assertPlantScope(tools, plantId)
  const transferKindRaw = str(p, 'transferKind')
  if (transferKindRaw !== 'production' && transferKindRaw !== 'warehouse' && transferKindRaw !== 'auto') {
    throw new WarehousingRuleViolation('A-T13-5', "transferKind 必须为 'production'（生产调拨）、'warehouse'（仓库调拨）或 'auto'（自动生成）")
  }
  const fromWarehouseId = requireStr(p, 'fromWarehouseId', 'warehousing.transfer.create')
  const toWarehouseId = requireStr(p, 'toWarehouseId', 'warehousing.transfer.create')
  const fromWarehouse = await tools.wh.warehouses.findById(fromWarehouseId)
  const toWarehouse = await tools.wh.warehouses.findById(toWarehouseId)
  if (fromWarehouse === null || toWarehouse === null) {
    throw new WarehousingRuleViolation(NOT_FOUND_RULE, '调出/调入仓库不存在')
  }
  const transitLocationId = requireStr(p, 'transitLocationId', 'warehousing.transfer.create')
  const transitLocationCode = requireStr(p, 'transitLocationCode', 'warehousing.transfer.create')

  const linesPayload = p['lines']
  if (!Array.isArray(linesPayload) || linesPayload.length === 0) {
    throw new WarehousingRuleViolation('A-T13-5', '调拨单至少包含一行（unitId+quantity）')
  }
  const lines = linesPayload.map((raw, index) => {
    const l = (raw ?? {}) as Payload
    const unitId = str(l, 'unitId')
    const quantity = dec(l, 'quantity')
    if (unitId === undefined || quantity === undefined || !isPositiveQty(quantity)) {
      throw new WarehousingRuleViolation('A-T13-5', `第 ${index + 1} 行缺少 unitId 或 quantity（正十进制定点字符串）`)
    }
    return {
      unitId,
      unitNo: str(l, 'unitNo') ?? '',
      quantity,
      materialId: str(l, 'materialId') ?? null,
      materialCode: str(l, 'materialCode') ?? null,
      materialType: typeof l['materialType'] === 'number' ? (l['materialType'] as number) : null,
    }
  })
  // A-T13-6：调入≠调出、线边仓约束、生产调拨料限（创建时先行校验；submit 复校）
  assertTransferWarehouses({
    transferKind: transferKindRaw,
    fromWarehouseId,
    toWarehouseId,
    fromWarehouseKind: fromWarehouse.warehouseType,
    toWarehouseKind: toWarehouse.warehouseType,
    lineMaterialTypes: lines.map((l) => l.materialType),
  })

  const orderNo = `TO-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`
  const order = await tools.wh.transferOrders.insert({
    orderNo,
    transferKind: transferKindRaw,
    fromWarehouseId,
    toWarehouseId,
    fromWarehouseCode: fromWarehouse.code,
    toWarehouseCode: toWarehouse.code,
    fromWarehouseType: fromWarehouse.warehouseType,
    toWarehouseType: toWarehouse.warehouseType,
    transitLocationId,
    transitLocationCode,
    note: str(p, 'note') ?? null,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  const lineRecords = []
  for (const [index, l] of lines.entries()) {
    const line = await tools.wh.transferLines.insert({
      transferOrderId: order.id,
      lineNo: index + 1,
      inventoryUnitId: l.unitId,
      unitNo: l.unitNo,
      materialId: l.materialId,
      materialCode: l.materialCode,
      materialType: l.materialType,
      quantity: l.quantity,
      createdBy: pc.ctx.actorLoginName,
    })
    lineRecords.push({ lineId: line.id, lineNo: line.lineNo, unitId: l.unitId, quantity: l.quantity })
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'warehousing.transfer.create',
    subjectType: 'transfer_order',
    subjectId: order.id,
    after: { orderNo, transferKind: transferKindRaw, from: fromWarehouse.code, to: toWarehouse.code, lines: lineRecords.length, status: 'draft' },
    reason: str(p, 'reason') ?? null,
  })
  return { orderId: order.id, orderNo, status: 'draft', lines: lineRecords }
}

// ---------------- 命令：调拨提交（草稿→待执行；锁定=作业预留） ----------------

async function transferSubmit(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = whTools(pc)
  const transferOrderId = requireStr(p, 'transferOrderId', 'warehousing.transfer.submit')
  const lockValidUntil = requireStr(p, 'lockValidUntil', 'warehousing.transfer.submit')
  const order = await tools.wh.transferOrders.lockById(transferOrderId)
  if (order === null) throw new WarehousingRuleViolation(NOT_FOUND_RULE, '调拨单不存在')
  // A-T13-10：状态机步进（草稿→待执行）
  assertTransferStep(order.status, 'ready')
  // A-T13-11/IT-23：锁定=作业预留（含有效期）
  assertTransferLockIssuable({ validUntil: lockValidUntil, now: pc.tools.now().toISOString() })

  const lines = await tools.wh.transferLines.listByOrder(order.id)
  if (lines.length === 0) throw new WarehousingRuleViolation('A-T13-5', '调拨单无行，不可提交')
  // 料品类型事实补齐（行快照缺省时查主数据，仅用于本次校验，不回写行快照）
  const materialTypes: (number | null)[] = []
  for (const line of lines) {
    if (line.materialType === null && line.materialId !== null) {
      materialTypes.push(await tools.wh.materials.findTypeById(line.materialId))
    } else {
      materialTypes.push(line.materialType)
    }
  }
  assertTransferWarehouses({
    transferKind: order.transferKind,
    fromWarehouseId: order.fromWarehouseId,
    toWarehouseId: order.toWarehouseId,
    fromWarehouseKind: order.fromWarehouseType ?? 'WAREHOUSE',
    toWarehouseKind: order.toWarehouseType ?? 'WAREHOUSE',
    lineMaterialTypes: materialTypes,
  })

  // 逐行锁定（作业预留：holder=task:transferId，有效期；A-T13-11）
  const lockedLines: Array<{ lineId: string; reservationId: string }> = []
  for (const line of lines) {
    const acquired = await acquireReservation(pc, {
      unitId: line.inventoryUnitId,
      quantity: line.quantity,
      holderType: 'task',
      holderRef: `transfer:${order.id}`,
      validUntil: lockValidUntil,
      reason: `调拨锁定 ${order.orderNo}`,
    })
    const reservationId = (acquired as { reservationId: string }).reservationId
    await tools.wh.transferLines.setReservation(line.id, reservationId, pc.ctx.actorLoginName)
    lockedLines.push({ lineId: line.id, reservationId })
  }

  await tools.wh.transferOrders.updateStatus(
    order.id,
    { status: 'ready', lockedValidUntil: lockValidUntil, submittedBy: pc.ctx.actorLoginName, submittedAt: pc.businessTime },
    pc.ctx.actorLoginName,
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'warehousing.transfer.submit',
    subjectType: 'transfer_order',
    subjectId: order.id,
    before: { status: order.status },
    after: { status: 'ready', lockedValidUntil: lockValidUntil, lockedLines: lockedLines.length },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'transfer_order',
    aggregateId: order.id,
    taskKind: 'warehousing.transfer-submitted',
    payload: { orderId: order.id, orderNo: order.orderNo, lockedValidUntil: lockValidUntil, lines: lockedLines.length },
  })
  return { orderId: order.id, status: 'ready', lockedValidUntil: lockValidUntil, lockedLines }
}

// ---------------- 命令：调拨出库段（A-T13-7/8/10/11：来源减+在途增，单行原子） ----------------

async function transferShip(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = whTools(pc)
  const transferOrderId = requireStr(p, 'transferOrderId', 'warehousing.transfer.ship')
  const lineId = requireStr(p, 'lineId', 'warehousing.transfer.ship')
  const order = await tools.wh.transferOrders.lockById(transferOrderId)
  if (order === null) throw new WarehousingRuleViolation(NOT_FOUND_RULE, '调拨单不存在')
  if (order.status !== 'ready' && order.status !== 'shipping') {
    throw new WarehousingRuleViolation('A-T13-10', `调拨单状态为 ${order.status}，出库段仅可自 待执行/出库中 执行（状态机步进非法）`)
  }
  const line = await tools.wh.transferLines.lockById(lineId)
  if (line === null || line.transferOrderId !== order.id) {
    throw new WarehousingRuleViolation(NOT_FOUND_RULE, '调拨行不存在或不属于该调拨单')
  }
  if (line.outDone) {
    throw new WarehousingRuleViolation('A-T13-8', `行 ${line.lineNo} 已完成出库（out_done），不可重复出库`)
  }
  const quantity = dec(p, 'quantity') ?? line.quantity
  const outAfter = addQty(line.outQty, quantity)
  if (cmpQty(outAfter, line.quantity) > 0) {
    throw new WarehousingRuleViolation('A-T13-8', `调拨出库量超过行计划量（行 ${line.quantity}、累计 ${outAfter}），拒绝`)
  }

  // A-T13-11/IT-23：锁定（作业预留）过期后旧提交必须重新校验——不得凭过期锁定直接出库
  const now = pc.tools.now().toISOString()
  if (line.reservationId !== null) {
    const reservation = await tools.inv.reservations.findById(line.reservationId)
    if (reservation === null) throw new WarehousingRuleViolation(NOT_FOUND_RULE, '调拨锁定（预留）不存在')
    assertTransferLockEffective({
      reservationId: reservation.id,
      status: reservation.status,
      validUntil: reservation.validUntil,
      now,
      action: '调拨出库',
    })
    assertReservationUsableForCommit(reservation, now) // IT-23 同语义复核

    // 出库后终结锁定：整量=消费；部分=消费+剩余释放（原码回写剩余并解锁，A-T13-8）
    const consumed = cmpQty(quantity, reservation.quantity) <= 0 ? quantity : reservation.quantity
    await tools.inv.reservations.consume(reservation.id, consumed, now, pc.ctx.actorLoginName)
    if (cmpQty(outAfter, line.quantity) < 0) {
      const afterConsume = await tools.inv.reservations.findById(reservation.id)
      if (afterConsume !== null && afterConsume.status === 'active') {
        await tools.inv.reservations.release(
          reservation.id,
          pc.ctx.actorLoginName,
          `调拨 ${order.orderNo} 部分数量调出：原码回写剩余并解锁（行 ${line.lineNo}）`,
          now,
        )
      }
    }
  }

  // 单元/余额事实（A-T13-7 出库扫码校验 + A-T12-4 参数化闸门）
  const lockedUnits = await tools.inv.units.lockForUpdate(ensureStableLockOrder([line.inventoryUnitId]))
  if (lockedUnits.length !== 1) throw new WarehousingRuleViolation(NOT_FOUND_RULE, `调拨行 ${line.lineNo} 的库存单元不存在`)
  const unit = lockedUnits[0]!
  const balances = await tools.inv.balances.listActiveByUnit(unit.id)
  const active = balances.filter((b) => b.status === 'active')
  if (active.length === 0) throw new WarehousingRuleViolation(NOT_FOUND_RULE, `库存单元 ${unit.unitNo} 无活动余额`)
  if (active.length > 1) {
    throw new WarehousingRuleViolation('A-T13-7', `库存单元 ${unit.unitNo} 存在 ${active.length} 条活动余额，调拨出库须先收敛余额键`)
  }
  const balance = active[0]!
  const fromLocation = await tools.wh.locations.findById(balance.locationId)
  const fromWarehouse = fromLocation !== null ? await tools.wh.warehouses.findById(fromLocation.warehouseId) : null
  const otherHolders = (await tools.inv.reservations.listActiveByUnit(unit.id)).filter(
    (r) => r.status === 'active' && r.id !== line.reservationId && Date.parse(r.validUntil) >= Date.parse(now),
  )
  assertTransferOutboundExecutable({
    unitNo: unit.unitNo,
    unitStatus: unit.status,
    lockedByOtherTask: otherHolders.length > 0,
    remainingQtyPositive: cmpQty(balance.quantity, '0.0000') > 0,
    warehouseMatch: fromWarehouse !== null && fromWarehouse.id === order.fromWarehouseId,
    warehouseLocked: fromWarehouse !== null && fromWarehouse.status !== 'active',
  })
  // A-T12-4：质检未完成禁出库（参数化闸门；存疑恒拒 A-T12-3）
  assertOutboundQualityGate({
    qualityStatus: balance.qualityStatus,
    policy: { allowUnfinishedOutbound: p['gateAllowUnfinishedOutbound'] === true },
    unitNo: unit.unitNo,
    action: '调拨出库',
  })

  // 调拨出库段（IT-25：来源减+在途增 两行流水一个事务）
  const out = await transferOut(pc, {
    unitId: unit.id,
    quantity,
    transitLocationId: order.transitLocationId!,
    transitLocationCode: order.transitLocationCode!,
    ownerId: balance.ownerId,
    reason: `调拨出库 ${order.orderNo}（行 ${line.lineNo}）${str(p, 'reason') ? '：' + str(p, 'reason') : ''}`,
  })

  await tools.wh.transferLines.markOut(
    line.id,
    { outQty: outAfter, outDone: cmpQty(outAfter, line.quantity) >= 0, outAt: pc.businessTime },
    pc.ctx.actorLoginName,
  )
  const allLines = await tools.wh.transferLines.listByOrder(order.id)
  const firstShip = order.status === 'ready'
  if (firstShip) {
    await tools.wh.transferOrders.updateStatus(
      order.id,
      { status: 'shipping', shippedBy: pc.ctx.actorLoginName, shippedAt: pc.businessTime },
      pc.ctx.actorLoginName,
    )
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'warehousing.transfer.ship',
    subjectType: 'transfer_order',
    subjectId: order.id,
    before: { status: order.status, lineOutQty: line.outQty },
    after: { status: firstShip ? 'shipping' : order.status, lineNo: line.lineNo, outQty: outAfter, quantity },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'transfer_order',
    aggregateId: order.id,
    taskKind: 'warehousing.transfer-shipped-line',
    payload: { orderId: order.id, orderNo: order.orderNo, lineId: line.id, lineNo: line.lineNo, quantity, outQty: outAfter, allOutDone: allLines.every((l) => l.outDone) },
  })
  return { orderId: order.id, lineId: line.id, quantity, outQty: outAfter, firstLineId: out.firstLineId, status: firstShip ? 'shipping' : order.status }
}

// ---------------- 命令：调拨在途段（A-T13-10：对账断言+状态推进，幂等） ----------------

async function transferTransit(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = whTools(pc)
  const transferOrderId = requireStr(p, 'transferOrderId', 'warehousing.transfer.transit')
  const order = await tools.wh.transferOrders.lockById(transferOrderId)
  if (order === null) throw new WarehousingRuleViolation(NOT_FOUND_RULE, '调拨单不存在')
  if (order.status === 'shipped_in_transit') {
    // 幂等对账重放（不同 operationId 的重复对账：只重跑断言，不重复推进）
    return { orderId: order.id, status: order.status, reconciliation: await reconcileTransit(tools, order) }
  }
  if (order.status !== 'shipping') {
    throw new WarehousingRuleViolation('A-T13-10', `调拨单状态为 ${order.status}，在途段仅可自 出库中 执行（须全部行完成出库）`)
  }
  const lines = await tools.wh.transferLines.listByOrder(order.id)
  if (!lines.every((l) => l.outDone)) {
    throw new WarehousingRuleViolation('A-T13-10', '存在未完成出库的行：在途确认须全部行完成出库（已出库在途）')
  }
  // A-T13-10：状态机步进（出库中→已出库在途）
  assertTransferStep(order.status, 'shipped_in_transit')
  const reconciliation = await reconcileTransit(tools, order)

  await tools.wh.transferOrders.updateStatus(order.id, { status: 'shipped_in_transit' }, pc.ctx.actorLoginName)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'warehousing.transfer.transit',
    subjectType: 'transfer_order',
    subjectId: order.id,
    before: { status: order.status },
    after: { status: 'shipped_in_transit', reconciliation },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'transfer_order',
    aggregateId: order.id,
    taskKind: 'warehousing.transfer-in-transit',
    payload: { orderId: order.id, orderNo: order.orderNo, ...reconciliation },
  })
  return { orderId: order.id, status: 'shipped_in_transit', reconciliation }
}

/** 在途对账（A-T13-10：在途量只挂专用在途库位；两仓不重复统计）。 */
async function reconcileTransit(
  tools: WarehousingCommandTools,
  order: import('./warehousing-repositories').TransferOrderRecord,
): Promise<Record<string, string>> {
  const lines = await tools.wh.transferLines.listByOrder(order.id)
  const transitLocationId = order.transitLocationId!
  const fromNormalIds = new Set(await tools.wh.locations.listWarehouseLocationIds([order.fromWarehouseId]))
  const toNormalIds = new Set(await tools.wh.locations.listWarehouseLocationIds([order.toWarehouseId]))
  let transitQty = '0.0000'
  let expectedTransitQty = '0.0000'
  let fromWarehouseNormalQty = '0.0000'
  let expectedFromRemainQty = '0.0000'
  let toWarehouseNormalQty = '0.0000'
  for (const line of lines) {
    const balances = await tools.inv.balances.listActiveByUnit(line.inventoryUnitId)
    for (const b of balances) {
      if (b.locationId === transitLocationId) transitQty = addQty(transitQty, b.quantity)
      else if (fromNormalIds.has(b.locationId)) fromWarehouseNormalQty = addQty(fromWarehouseNormalQty, b.quantity)
      else if (toNormalIds.has(b.locationId)) toWarehouseNormalQty = addQty(toWarehouseNormalQty, b.quantity)
    }
    expectedTransitQty = addQty(expectedTransitQty, subQty(line.outQty, line.inQty))
    expectedFromRemainQty = addQty(expectedFromRemainQty, subQty(line.quantity, line.outQty))
  }
  assertTransitNotDoubleCounted({
    transitQty,
    expectedTransitQty,
    fromWarehouseNormalQty,
    expectedFromRemainQty,
    toWarehouseNormalQty,
  })
  return { transitQty, expectedTransitQty, fromWarehouseRemainQty: fromWarehouseNormalQty, toWarehouseQty: toWarehouseNormalQty }
}

// ---------------- 命令：调拨接收段（A-T13-9/10：在途减+目的增，单行原子） ----------------

async function transferReceive(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = whTools(pc)
  const transferOrderId = requireStr(p, 'transferOrderId', 'warehousing.transfer.receive')
  const lineId = requireStr(p, 'lineId', 'warehousing.transfer.receive')
  const order = await tools.wh.transferOrders.lockById(transferOrderId)
  if (order === null) throw new WarehousingRuleViolation(NOT_FOUND_RULE, '调拨单不存在')
  if (order.status !== 'shipped_in_transit' && order.status !== 'receiving') {
    throw new WarehousingRuleViolation('A-T13-10', `调拨单状态为 ${order.status}，接收段仅可自 已出库在途/收货中 执行（跨厂收货需接收方事实）`)
  }
  const line = await tools.wh.transferLines.lockById(lineId)
  if (line === null || line.transferOrderId !== order.id) {
    throw new WarehousingRuleViolation(NOT_FOUND_RULE, '调拨行不存在或不属于该调拨单')
  }
  if (!line.outDone) {
    throw new WarehousingRuleViolation('A-T13-9', `行 ${line.lineNo} 尚未完成出库，不可接收`)
  }
  if (line.inDone) {
    throw new WarehousingRuleViolation('A-T13-9', `行 ${line.lineNo} 已完成接收（in_done），不可重复接收`)
  }
  const quantity = dec(p, 'quantity') ?? subQty(line.outQty, line.inQty)
  const inAfter = addQty(line.inQty, quantity)
  if (cmpQty(inAfter, line.outQty) > 0) {
    throw new WarehousingRuleViolation('A-T13-9', `调拨接收量超过已出库量（已出库 ${line.outQty}、累计接收 ${inAfter}），拒绝`)
  }
  const toLocationId = requireStr(p, 'toLocationId', 'warehousing.transfer.receive')
  const toLocationCode = requireStr(p, 'toLocationCode', 'warehousing.transfer.receive')
  const toLocation = await tools.wh.locations.findById(toLocationId)
  if (toLocation === null) throw new WarehousingRuleViolation(NOT_FOUND_RULE, '接收库位不存在')
  if (toLocation.warehouseId !== order.toWarehouseId) {
    throw new WarehousingRuleViolation('A-T13-9', '接收库位不属于调入仓库')
  }

  // 调拨接收段（IT-25：在途减+目的增 两行流水一个事务）
  const inn = await transferIn(pc, {
    unitId: line.inventoryUnitId,
    quantity,
    transitLocationId: order.transitLocationId!,
    toLocationId,
    toLocationCode,
    ownerId: null, // 在途余额所有者解析（transferIn 支持按在途库位唯一余额解析）
    reason: `调拨接收 ${order.orderNo}（行 ${line.lineNo}）${str(p, 'reason') ? '：' + str(p, 'reason') : ''}`,
  })

  await tools.wh.transferLines.markIn(
    line.id,
    { inQty: inAfter, inDone: cmpQty(inAfter, line.outQty) >= 0, inAt: pc.businessTime },
    pc.ctx.actorLoginName,
  )
  const allLines = await tools.wh.transferLines.listByOrder(order.id)
  let newStatus: 'receiving' | 'completed' = 'receiving'
  if (allLines.every((l) => l.inDone)) {
    newStatus = 'completed' // A-T13-9：完成条件=每料品已入库≥待入库且至少一码（全部行 in_done）
  }
  await tools.wh.transferOrders.updateStatus(
    order.id,
    {
      status: newStatus,
      ...(newStatus === 'completed' ? { completedBy: pc.ctx.actorLoginName, completedAt: pc.businessTime } : {}),
    },
    pc.ctx.actorLoginName,
  )

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'warehousing.transfer.receive',
    subjectType: 'transfer_order',
    subjectId: order.id,
    before: { status: order.status, lineInQty: line.inQty },
    after: { status: newStatus, lineNo: line.lineNo, inQty: inAfter, quantity },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'transfer_order',
    aggregateId: order.id,
    taskKind: 'warehousing.transfer-received-line',
    payload: { orderId: order.id, orderNo: order.orderNo, lineId: line.id, lineNo: line.lineNo, quantity, inQty: inAfter, status: newStatus },
  })
  return { orderId: order.id, lineId: line.id, quantity, inQty: inAfter, status: newStatus, destBalanceId: inn.destBalanceId }
}

// ---------------- 处理器装配 ----------------

type WarehousingHandlerFn = (pc: PostingContext, p: Payload) => Promise<Record<string, unknown>>

/** 命令处理器清单（组合根装配进 PgCommandBus）。 */
export function createWarehousingCommandHandlers(): CommandHandler[] {
  const make = (commandType: string, fn: WarehousingHandlerFn): CommandHandler => ({
    commandType,
    handle: (envelope, ctx, tools): Promise<HandlerOutcome> =>
      run(async () => {
        const warehousingTools = tools as WarehousingCommandTools // 组合根构造的工具集窄化（见 warehousing.composition）
        const payload = (envelope.payload ?? {}) as Payload
        const pc = await buildPostingContext(warehousingTools, ctx, commandType, envelope.operationId, payload)
        return fn(pc, payload)
      }),
  })

  return [
    make('warehousing.putaway.refresh', putawayRefresh),
    make('warehousing.putaway.confirm', putawayConfirm),
    make('warehousing.move.execute', moveExecute),
    make('warehousing.transfer.create', transferCreate),
    make('warehousing.transfer.submit', transferSubmit),
    make('warehousing.transfer.ship', transferShip),
    make('warehousing.transfer.transit', transferTransit),
    make('warehousing.transfer.receive', transferReceive),
  ]
}
