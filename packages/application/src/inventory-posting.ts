import {
  InventoryRuleViolation,
  INVENTORY_PERMISSIONS,
  addQty,
  assertEdgeEndpoints,
  assertNoActiveBindingConflict,
  assertNoDirectBalanceOverride,
  assertQuantityTuple,
  assertReservationAcquirable,
  assertReservationUsableForCommit,
  assertSplitConservation,
  assertStorageTriplet,
  buildPostingLine,
  cmpQty,
  computeShiftDate,
  computeAvailability,
  ensureStableLockOrder,
  feetDisplayFromMeters,
  isPositiveQty,
  isValidQuantityString,
  subQty,
  sumQty,
  zeroBalanceDisposition,
  type GenealogyEdgeKind,
  type MovementKind,
} from '@cadenza/domain'
import type { CommandContext } from './command-bus'
import { assertObjectWriteScope, type ObjectScope } from './object-scope-repositories'
import type {
  InventoryCommandTools,
  InventoryUnitRecord,
  StockBalanceRecord,
} from './inventory-repositories'


/**
 * 库存记账服务（内核核心，IT-18：库存域是数量/库位/所有权/预留的唯一维护方）。
 *
 * 全部函数运行于命令总线事务内（PgCommandBus 同一 UoW），执行序固定为
 * IT-25（DM §6）：**锁库存单元（稳定次序）→ 校验实时可用量 → 写流水（含扣前/扣后余额）→
 * 更新余额 → 预留 acquire/release（含有效期）**；Outbox 事件行同事务写入（collectOutbox）；
 * 零余额关闭活动余额、保留身份与谱系（IT-29）。
 *
 * 纯规则在 @cadenza/domain/inventory；本文件只做编排与事务内读写。
 */

export const NOT_FOUND_RULE = 'NOT_FOUND'

/** 记账上下文：命令事务绑定。 */
export interface PostingContext {
  tools: InventoryCommandTools
  ctx: CommandContext
  commandReceiptId: string
  /** IT-37：业务时间（载荷缺省取系统时间，但分列落库） */
  businessTime: string
  shiftDate: string | null
  /** Trusted originating command permission; never read from the payload. */
  writePermission?: string
}

type Payload = Record<string, unknown>

// ---------------- 载荷解析 ----------------

export function str(p: Payload, key: string): string | undefined {
  const v = p[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export function dec(p: Payload, key: string): string | undefined {
  const v = p[key]
  return typeof v === 'string' && isValidQuantityString(v) ? v : undefined
}

/** ABS 收编轮：域级审计/Outbox 形状透传用（仅接受纯对象，防数组/原型污染载荷）。 */
function isPlainObject(v: unknown): v is Payload {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function requireStr(p: Payload, key: string, command: string): string {
  const v = str(p, key)
  if (v === undefined) throw new InventoryRuleViolation('IT-22', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

function requireDec(p: Payload, key: string, command: string): string {
  const v = dec(p, key)
  if (v === undefined) {
    throw new InventoryRuleViolation('IT-07', `${command}：数量字段 ${key} 必须为十进制定点字符串（≤4 位小数）`)
  }
  return v
}

/** IT-18：载荷不得携带直写余额/跳过校验的越域字段。 */
function assertPayloadSanity(p: Payload): void {
  assertNoDirectBalanceOverride(Object.keys(p))
}

/** IT-37：业务时间解析（缺省回落系统时间；分列落库）。 */
export function resolveBusinessTime(tools: InventoryCommandTools, raw: string | undefined): {
  businessTime: string
  shiftDate: string
} {
  const now = tools.now()
  const businessTime = raw !== undefined && !Number.isNaN(Date.parse(raw)) ? raw : now.toISOString()
  return { businessTime, shiftDate: computeShiftDate(businessTime) }
}

/** 组合上下文（处理器入口统一调用）。 */
export async function buildPostingContext(
  tools: InventoryCommandTools,
  ctx: CommandContext,
  commandType: string,
  operationId: string,
  payload: Payload,
): Promise<PostingContext> {
  assertPayloadSanity(payload)
  const receiptId = await tools.inv.receipts.findIdByKey(ctx.enterpriseId, commandType, operationId)
  if (receiptId === null) {
    throw new InventoryRuleViolation('IT-21', '命令回执未落库：幂等键缺失，拒绝记账')
  }
  const { businessTime, shiftDate } = resolveBusinessTime(tools, str(payload, 'businessTime'))
  const writePermission = commandType.startsWith('inventory.reservation.') ? INVENTORY_PERMISSIONS.INVENTORY_RESERVE
    : commandType.startsWith('inventory.') ? INVENTORY_PERMISSIONS.INVENTORY_POST
      : commandType.startsWith('quality.') ? 'quality.post'
        : commandType.startsWith('purchase.') ? 'purchase.post' : undefined
  return { tools, ctx, commandReceiptId: receiptId, businessTime, shiftDate, writePermission }
}

// ---------------- 通用前置 ----------------

/** Check persisted identity before any quantity, reservation or custody write. */
async function assertInventoryObjectScope(pc: PostingContext, target: ObjectScope, claimedPlantId?: string): Promise<void> {
  const reject = (message: string) => new InventoryRuleViolation('IT-S1', message)
  if (pc.writePermission !== undefined) {
    await assertObjectWriteScope(pc.tools, pc.ctx, target, pc.writePermission, reject, claimedPlantId)
    return
  }
  // Other domains own their originating command permission. Keep that contract,
  // while still checking the actual inventory identity at this shared boundary.
  const plant = await pc.tools.org.findById(target.plantId)
  if (target.enterpriseId !== pc.ctx.enterpriseId || plant === null || plant.kind !== 'plant' ||
      plant.status !== 'active' || plant.enterpriseId !== pc.ctx.enterpriseId ||
      (claimedPlantId !== undefined && claimedPlantId !== target.plantId)) throw reject('库存对象的真实企业/工厂不一致')
  const scope = await pc.tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(target.plantId)) throw reject('库存对象不在授权工厂范围内')
}

async function assertPlantScope(pc: PostingContext, plantId: string): Promise<void> {
  await assertInventoryObjectScope(pc, { enterpriseId: pc.ctx.enterpriseId, plantId })
}

/** 锁定库存单元并校验存在（IT-25：一切记账先锁单元，稳定次序）。 */
async function lockUnits(
  pc: PostingContext,
  unitIds: readonly string[],
  claimedPlantId?: string,
): Promise<Map<string, InventoryUnitRecord>> {
  const ordered = ensureStableLockOrder(unitIds) // IT-25/27 稳定次序
  if (ordered.length !== unitIds.length) {
    throw new InventoryRuleViolation('IT-25', '载荷出现重复单元，拒绝')
  }
  const locked = await pc.tools.inv.units.lockForUpdate(ordered)
  if (locked.length !== ordered.length) {
    throw new InventoryRuleViolation(NOT_FOUND_RULE, '库存单元不存在或已不可用')
  }
  for (const unit of locked) await assertInventoryObjectScope(pc, unit, claimedPlantId)
  return new Map(locked.map((u) => [u.id, u]))
}

/** 解析单元的唯一活动余额（多余额须显式指定键，IT-20/IT-04 显式选择精神）。 */
async function resolveSingleActiveBalance(
  tools: InventoryCommandTools,
  unit: InventoryUnitRecord,
): Promise<StockBalanceRecord> {
  const list = await tools.inv.balances.listActiveByUnit(unit.id)
  if (list.length === 0) {
    throw new InventoryRuleViolation(NOT_FOUND_RULE, `库存单元 ${unit.unitNo} 无活动余额`)
  }
  if (list.length > 1) {
    throw new InventoryRuleViolation(
      'IT-20',
      `库存单元 ${unit.unitNo} 存在 ${list.length} 条活动余额，须显式指定库位与所有者后重发`,
    )
  }
  return list[0]!
}

/** 锁定余额行（键显式时）；不存在返回 null（由调用方决定插入或拒绝）。 */
async function lockBalance(
  tools: InventoryCommandTools,
  unitId: string,
  locationId: string,
  ownerId: string,
): Promise<StockBalanceRecord | null> {
  return tools.inv.balances.lockByKey(unitId, locationId, ownerId)
}

/** 键显式时直接锁定；缺省解析唯一活动余额后锁定。不存在返回 null。 */
async function lockResolvedBalance(
  tools: InventoryCommandTools,
  unit: InventoryUnitRecord,
  locationId: string | undefined,
  ownerId: string | undefined,
): Promise<StockBalanceRecord | null> {
  if (locationId !== undefined && ownerId !== undefined) {
    return lockBalance(tools, unit.id, locationId, ownerId)
  }
  const single = await resolveSingleActiveBalance(tools, unit)
  return lockBalance(tools, unit.id, single.locationId, single.ownerId)
}

/**
 * 单行记账规格（内核记账原语；ABS 收编轮导出——rework 等价服务 writeLedgerLine/
 * closeUnitIfZeroBalance 收编回核心面，各域不得再复制本记账序）。
 */
export interface LineWrite {
  lineNo: number
  movementKind: MovementKind
  balance: StockBalanceRecord
  beforeQty: string
  afterQty: string
  unit: InventoryUnitRecord
  lotId?: string | null
  from?: { locationId: string; locationCode: string; ownerId: string; ownerName: string }
  to?: { locationId: string; locationCode: string; ownerId: string; ownerName: string }
  reason?: string | null
  refType?: string | null
  refId?: string | null
  /** 分录用途（缺省=流水类型；如 warehousing putaway_confirm 口径）。 */
  entryPurpose?: string | null
}

/** 写一行流水 + 同步余额 + 分录（IT-19：流水必含扣前/扣后；IT-29：零余额关闭）。 */
export async function writeLine(pc: PostingContext, spec: LineWrite): Promise<{ transactionId: string; closed: boolean }> {
  const inv = pc.tools.inv
  const actor = pc.ctx.actorLoginName
  await assertInventoryObjectScope(pc, spec.unit)
  if (spec.balance.unitId !== spec.unit.id || spec.balance.enterpriseId !== spec.unit.enterpriseId ||
      spec.balance.plantId !== spec.unit.plantId) {
    throw new InventoryRuleViolation('IT-S1', '余额与库存单元的真实企业/工厂不一致')
  }
  if (cmpQty(spec.afterQty,spec.beforeQty)<0 && (await inv.units.businessHolds(spec.unit.id)).length>0) {
    throw new InventoryRuleViolation('IT-BUSINESS-HOLD',`库存单元 ${spec.unit.unitNo} 处于业务留置，不可扣减、转移或拆分`)
  }
  const line = buildPostingLine({
    lineNo: spec.lineNo,
    movementKind: spec.movementKind,
    beforeQty: spec.beforeQty,
    deltaQty: subQty(spec.afterQty, spec.beforeQty),
    uomId: spec.balance.uomId,
  })
  const closes = zeroBalanceDisposition(line.afterQty) // IT-29：零余额关闭，不删除
  const inserted = await inv.transactions.insertLine({
    commandReceiptId: pc.commandReceiptId,
    lineNo: spec.lineNo,
    movementKind: spec.movementKind,
    unitId: spec.unit.id,
    lotId: spec.lotId ?? spec.unit.lotId,
    balanceId: spec.balance.id,
    fromLocationId: spec.from?.locationId ?? null,
    fromLocationCode: spec.from?.locationCode ?? null,
    toLocationId: spec.to?.locationId ?? null,
    toLocationCode: spec.to?.locationCode ?? null,
    fromOwnerId: spec.from?.ownerId ?? null,
    fromOwnerName: spec.from?.ownerName ?? null,
    toOwnerId: spec.to?.ownerId ?? null,
    toOwnerName: spec.to?.ownerName ?? null,
    quantity: subQty(line.afterQty, line.beforeQty),
    uomId: spec.balance.uomId,
    uomCode: spec.balance.uomCode,
    measurementBasis: spec.balance.measurementBasis,
    conversionRevisionId: spec.balance.conversionRevisionId,
    beforeQty: line.beforeQty,
    afterQty: line.afterQty,
    refType: spec.refType ?? null,
    refId: spec.refId ?? null,
    reason: spec.reason ?? null,
    businessTime: pc.businessTime,
    shiftDate: pc.shiftDate,
    plantId: spec.unit.plantId,
    enterpriseId: spec.unit.enterpriseId,
    createdBy: actor,
  })
  await inv.transactions.insertEntry({
    transactionId: inserted.id,
    entryNo: 1,
    balanceId: spec.balance.id,
    unitId: spec.unit.id,
    locationId: spec.balance.locationId,
    locationCode: spec.balance.locationCode,
    ownerId: spec.balance.ownerId,
    ownerName: spec.balance.ownerName,
    lotId: spec.lotId ?? spec.unit.lotId,
    quantityDelta: subQty(line.afterQty, line.beforeQty),
    beforeQty: line.beforeQty,
    afterQty: line.afterQty,
    purpose: spec.entryPurpose ?? spec.movementKind,
    plantId: spec.unit.plantId,
    enterpriseId: spec.unit.enterpriseId,
    createdBy: actor,
  })
  // 余额实时更新（IT-20：交易决策用的余额在主事务内实时更新）
  await inv.balances.adjust(
    spec.balance.id,
    closes.closeBalance
      ? { quantity: line.afterQty, status: 'closed', closedAt: pc.businessTime }
      : { quantity: line.afterQty, status: 'active', closedAt: null },
    actor,
  )
  return { transactionId: inserted.id, closed: closes.closeBalance }
}

/** 单元零余额关闭（IT-29：身份与谱系保留；状态轴→已耗尽 IT-13）。ABS 收编轮导出（rework 等价服务收编）。 */
export async function closeUnitIfZero(pc: PostingContext, unit: InventoryUnitRecord, closed: boolean): Promise<void> {
  if (!closed) return
  await pc.tools.inv.units.updateStatus(
    unit.id,
    { status: 'exhausted', balanceOpen: false, balanceClosedAt: pc.businessTime },
    pc.ctx.actorLoginName,
  )
}

// ---------------- 收货入账（IT-25 确认采购收货） ----------------

/**
 * 收货入账核心（IT-25）。ABS 收编轮参数化（缺省值＝收编前行为，既有调用方零破坏）：
 * - `lineNo`（缺省 1）：同一命令回执下多行收货（purchase 多明细 / warehousing 多任务）逐行递增，
 *   避让 stock_transaction (command_receipt_id, line_no) 唯一约束（IT-19）；
 * - `lotKind`（缺省 'purchase'）／`genealogyEdgeKind`（缺省 'receipt_origin'）：生产批次口径
 *   （warehousing 报工产出，kind='production'＋production_output 边）；
 * - `entryPurpose`（缺省＝movementKind）：分录用途列（warehousing putaway_confirm 口径）；
 * - `refType`/`refId`（缺省 null）：流水引用（purchase_receipt_batch / putaway_task）；
 * - `recordToColumns`（缺省 false）：收货流水行是否落 to_location/to_owner 列
 *   （purchase/warehousing 收编前口径为落列；inventory 命令既有口径为不落）；
 * - `auditAction`/`auditAfterExtra`/`outboxTaskKind`/`outboxPayloadExtra`（缺省＝inventory 口径）：
 *   域级审计动作与 Outbox 任务形状透传（warehousing putaway 口径）。
 */
export async function receiveGoods(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const inv = pc.tools.inv
  const plantId = requireStr(p, 'plantId', 'inventory.receive-goods')
  await assertPlantScope(pc, plantId)
  const quantity = requireDec(p, 'quantity', 'inventory.receive-goods')
  if (!isPositiveQty(quantity)) {
    throw new InventoryRuleViolation('IT-07', '收货数量必须大于 0')
  }
  const lineNoRaw = p['lineNo']
  const lineNo = typeof lineNoRaw === 'number' && Number.isInteger(lineNoRaw) && lineNoRaw >= 1 ? lineNoRaw : 1
  const lotKind = str(p, 'lotKind') === 'production' ? 'production' : 'purchase'
  const genealogyEdgeKindRaw = str(p, 'genealogyEdgeKind') ?? 'receipt_origin'
  // IT-34：收货谱系边固定 material_lot → inventory_unit 端点，边类型须属该配对合法集
  const genealogyEdgeKind: GenealogyEdgeKind =
    genealogyEdgeKindRaw === 'production_output' ? 'production_output' : 'receipt_origin'
  assertEdgeEndpoints(genealogyEdgeKind, 'material_lot', 'inventory_unit')
  const entryPurpose = str(p, 'entryPurpose') ?? null
  const auditAction = str(p, 'auditAction') ?? 'inventory.receive-goods'
  const auditAfterExtra = isPlainObject(p['auditAfterExtra']) ? (p['auditAfterExtra'] as Payload) : null
  const outboxTaskKind = str(p, 'outboxTaskKind') ?? 'inventory.goods-received'
  const outboxPayloadExtra = isPlainObject(p['outboxPayloadExtra']) ? (p['outboxPayloadExtra'] as Payload) : null
  const recordToColumns = p['recordToColumns'] === true
  const uomId = requireStr(p, 'uomId', 'inventory.receive-goods')
  const uomCode = requireStr(p, 'uomCode', 'inventory.receive-goods')
  const measurementBasis = str(p, 'measurementBasis') ?? 'nominal'
  assertQuantityTuple({ quantity, uomId, measurementBasis, conversionRevisionId: str(p, 'conversionRevisionId') ?? null }) // IT-08

  const locationId = requireStr(p, 'locationId', 'inventory.receive-goods')
  const locationCode = requireStr(p, 'locationCode', 'inventory.receive-goods')
  const ownerId = requireStr(p, 'ownerId', 'inventory.receive-goods')
  const ownerName = requireStr(p, 'ownerName', 'inventory.receive-goods')
  assertStorageTriplet({ ownerId, ownerName, custodianPlantId: plantId, locationId, locationCode, isCustomerSupplied: p['isCustomerSupplied'] === true }) // IT-02

  const lotNo = requireStr(p, 'lotNo', 'inventory.receive-goods')
  const materialId = requireStr(p, 'materialId', 'inventory.receive-goods')
  const materialCode = requireStr(p, 'materialCode', 'inventory.receive-goods')
  let lot = await inv.lots.findByNo(plantId, lotNo)
  if (lot === null) {
    lot = await inv.lots.insert({
      lotNo,
      kind: lotKind,
      materialId,
      materialCode,
      supplierLotNo: str(p, 'supplierLotNo') ?? null,
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      businessTime: pc.businessTime,
      createdBy: pc.ctx.actorLoginName,
    })
  } else {
    await assertInventoryObjectScope(pc, lot, plantId)
    if (lot.materialId !== materialId) {
      throw new InventoryRuleViolation('IT-01', `批次 ${lotNo} 已绑定其它物料，批次身份不可覆盖历史`)
    }
  }

  const unitNo = requireStr(p, 'unitNo', 'inventory.receive-goods')
  const existing = await inv.units.findByUnitNo(plantId, unitNo)
  if (existing !== null) {
    throw new InventoryRuleViolation('IT-01', `库存单元号 ${unitNo} 已存在（内部唯一 ID 不可重复）`)
  }
  const unit = await inv.units.insert({
    unitNo,
    materialId,
    materialCode,
    lotId: lot.id,
    uomId,
    uomCode,
    traceMode: str(p, 'traceMode') === 'segment' ? 'segment' : 'quantity',
    status: 'in_stock',
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    businessTime: pc.businessTime,
    createdBy: pc.ctx.actorLoginName,
  })

  const balance = await inv.balances.insert({
    unitId: unit.id,
    locationId,
    locationCode,
    ownerId,
    ownerName,
    quantity: '0.0000',
    uomId,
    uomCode,
    measurementBasis,
    conversionRevisionId: str(p, 'conversionRevisionId') ?? null,
    qualityStatus: (str(p, 'qualityStatus') as StockBalanceRecord['qualityStatus'] | undefined) ?? 'pending_inspection',
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    businessTime: pc.businessTime,
    createdBy: pc.ctx.actorLoginName,
  })

  const written = await writeLine(pc, {
    lineNo,
    movementKind: 'receive',
    balance,
    beforeQty: '0.0000',
    afterQty: quantity,
    unit,
    to: recordToColumns ? { locationId, locationCode, ownerId, ownerName } : undefined,
    reason: str(p, 'reason') ?? null,
    refType: str(p, 'refType') ?? null,
    refId: str(p, 'refId') ?? null,
    entryPurpose,
  })

  // 谱系：收货批次 → 库存单元（正向起点，IT-34；生产口径为 production_output 边）
  await inv.genealogy.insertEdge({
    fromType: 'material_lot',
    fromId: lot.id,
    toType: 'inventory_unit',
    toId: unit.id,
    edgeKind: genealogyEdgeKind,
    quantity,
    uomId,
    uomCode,
    measurementBasis,
    conversionRevisionId: str(p, 'conversionRevisionId') ?? null,
    commandReceiptId: pc.commandReceiptId,
    businessTime: pc.businessTime,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })

  // 可选：空码校验/绑定（IT-06：同码值至多一条活动绑定）
  const barcodeValue = str(p, 'barcodeValue')
  if (barcodeValue !== undefined) {
    const active = await inv.barcodes.findActiveBindingByValue(barcodeValue)
    assertNoActiveBindingConflict(barcodeValue, active) // 空码可收：已绑定则拒（IT-06）
    await inv.barcodes.insertLabel({
      barcodeValue,
      labelKind: 'raw_material',
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      printedBy: pc.ctx.actorLoginName,
      createdBy: pc.ctx.actorLoginName,
    })
    await inv.barcodes.insertBinding({
      barcodeValue,
      boundType: 'inventory_unit',
      boundId: unit.id,
      boundBy: pc.ctx.actorLoginName,
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: auditAction,
    subjectType: 'inventory_unit',
    subjectId: unit.id,
    after: { unitNo, lotNo, quantity, locationCode, ...(auditAfterExtra ?? {}) },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'inventory_unit',
    aggregateId: unit.id,
    taskKind: outboxTaskKind,
    payload: {
      unitId: unit.id,
      unitNo,
      lotNo,
      materialCode,
      quantity,
      uomCode,
      locationCode,
      businessTime: pc.businessTime,
      ...(outboxPayloadExtra ?? {}),
    },
  })
  return {
    unitId: unit.id,
    unitNo,
    lotId: lot.id,
    balanceId: balance.id,
    transactionId: written.transactionId,
    afterQty: quantity,
    feetDisplay: feetDisplayFromMeters(quantity), // IT-10 展示列（不入账）
  }
}

// ---------------- 发料扣减（IT-25 单独投料；IT-14/15/23/30-①） ----------------

export async function issueMaterial(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const inv = pc.tools.inv
  const unitId = requireStr(p, 'unitId', 'inventory.issue-material')
  const quantity = requireDec(p, 'quantity', 'inventory.issue-material')
  const units = await lockUnits(pc, [unitId], str(p, 'plantId')) // IT-25：先锁单元（稳定次序）
  const unit = units.get(unitId)!
  // 行号口径与 receiveGoods 一致：同一命令回执下多行发料（execution 多行投料）逐行递增，缺省 1。
  const issueLineNoRaw = p['lineNo']
  const issueLineNo =
    typeof issueLineNoRaw === 'number' && Number.isInteger(issueLineNoRaw) && issueLineNoRaw >= 1
      ? issueLineNoRaw
      : 1

  const locationId = str(p, 'locationId')
  const ownerId = str(p, 'ownerId')
  const balance = await lockResolvedBalance(pc.tools, unit, locationId, ownerId)
  if (balance === null || balance.status === 'closed') {
    throw new InventoryRuleViolation(NOT_FOUND_RULE, `库存单元 ${unit.unitNo} 在指定键上无活动余额`)
  }

  const now = pc.tools.now().toISOString()
  const reservations = await inv.reservations.listActiveByUnit(unitId)
  const reservationId = str(p, 'reservationId')
  let reservation = null
  if (reservationId !== undefined) {
    const found = await inv.reservations.findById(reservationId)
    if (found === null || found.unitId !== unitId) {
      throw new InventoryRuleViolation(NOT_FOUND_RULE, '预留不存在或不属于该库存单元')
    }
    assertReservationUsableForCommit(found, now) // IT-23：过期后旧终端提交必须重校验
    reservation = found
  }

  // IT-14：可用量 = 质量 ∧ 预留；IT-15：同码并发消费经行锁串行后实时校验
  const availability = computeAvailability({
    grossQty: balance.quantity,
    qualityStatus: balance.qualityStatus,
    activeReservations: reservations.map((r) => ({ status: r.status, quantity: r.quantity, validUntil: r.validUntil })),
    now,
  })
  const allowedMax =
    reservation !== null
      ? addQty(availability.available, reservation.quantity) // 预留持有人可消耗自己预留的量
      : availability.available
  if (cmpQty(allowedMax, quantity) < 0) {
    throw new InventoryRuleViolation(
      'IT-14',
      `可用量不足（单元 ${unit.unitNo} 毛量 ${availability.gross}、有效预留 ${availability.reserved}、` +
        `可用 ${availability.available}${reservation !== null ? `＋自有预留 ${reservation.quantity}` : ''}、本次申请 ${quantity}）`,
    )
  }

  const afterQty = subQty(balance.quantity, quantity)
  if (cmpQty(afterQty, '0.0000') < 0) {
    throw new InventoryRuleViolation('IT-30', `并发余量不足导致负库存（扣前 ${balance.quantity}、本次 ${quantity}），拒绝`)
  }
  const written = await writeLine(pc, {
    lineNo: issueLineNo,
    movementKind: 'issue',
    balance,
    beforeQty: balance.quantity,
    afterQty,
    unit,
    reason: str(p, 'reason') ?? null,
    refType: str(p, 'refType') ?? null,
    refId: str(p, 'refId') ?? null,
  })
  await closeUnitIfZero(pc, unit, written.closed) // IT-29

  if (reservation !== null) {
    // 预留消费：消耗量 = min(本次发料, 预留量)；余量留存
    const consumed = cmpQty(reservation.quantity, quantity) <= 0 ? reservation.quantity : quantity
    await inv.reservations.consume(reservation.id, consumed, now, pc.ctx.actorLoginName)
  }

  // 投料消费边（引用在制单元时，IT-34）
  if (str(p, 'refType') === 'inventory_unit' && str(p, 'refId') !== undefined) {
    await inv.genealogy.insertEdge({
      fromType: 'inventory_unit',
      fromId: unitId,
      toType: 'inventory_unit',
      toId: str(p, 'refId')!,
      edgeKind: 'consumption',
      quantity,
      uomId: balance.uomId,
      uomCode: balance.uomCode,
      measurementBasis: balance.measurementBasis,
      conversionRevisionId: balance.conversionRevisionId,
      commandReceiptId: pc.commandReceiptId,
      businessTime: pc.businessTime,
      plantId: unit.plantId,
      enterpriseId: unit.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'inventory.issue-material',
    subjectType: 'inventory_unit',
    subjectId: unitId,
    before: { quantity: balance.quantity },
    after: { quantity: afterQty },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'inventory_unit',
    aggregateId: unitId,
    taskKind: 'inventory.material-issued',
    payload: { unitId, unitNo: unit.unitNo, quantity, reservationId: reservationId ?? null, afterQty, businessTime: pc.businessTime },
  })
  return {
    unitId,
    balanceId: balance.id,
    transactionId: written.transactionId,
    beforeQty: balance.quantity,
    afterQty,
    balanceClosed: written.closed,
  }
}

// ---------------- 原料退料（T11：领用/投料后未用余料退回仓库，恢复账面量） ----------------

/**
 * 原料退料：inventory.issue-material / 投料的反向入账（movement_kind='reverse'，
 * ref_type='material_return'；IT-32 冲销写反向行语义）。
 * 守恒：累计退料量不得超过该单元累计 issue 量 − 已退量（防超退）；
 * 目标库位余额不存在时新建（质量状态/单位沿该单元最近余额谱系）；单元已耗尽则重开。
 */
export async function returnMaterial(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const inv = pc.tools.inv
  const plantId = requireStr(p, 'plantId', 'inventory.return-material')
  await assertPlantScope(pc, plantId)
  const unitId = requireStr(p, 'unitId', 'inventory.return-material')
  const quantity = requireDec(p, 'quantity', 'inventory.return-material')
  if (!isPositiveQty(quantity)) {
    throw new InventoryRuleViolation('IT-07', '退料数量必须大于 0')
  }
  const locationId = requireStr(p, 'locationId', 'inventory.return-material')
  const locationCode = requireStr(p, 'locationCode', 'inventory.return-material')

  const units = await lockUnits(pc, [unitId], str(p, 'plantId')) // IT-25：先锁单元
  const unit = units.get(unitId)!
  if (unit.status === 'in_transit' || unit.status === 'shipped') {
    throw new InventoryRuleViolation('IT-13', `库存单元 ${unit.unitNo} 状态为 ${unit.status}，不可退料`)
  }

  // 谱系依据：最近一条余额（含 closed）——所有者/单位/质量状态沿谱系；无历史余额拒绝（无据可退）
  const lineage = await inv.balances.findLatestByUnit(unitId)
  if (lineage === null) {
    throw new InventoryRuleViolation(NOT_FOUND_RULE, `库存单元 ${unit.unitNo} 无余额历史，无谱系依据，拒绝退料`)
  }
  const ownerId = str(p, 'ownerId') ?? lineage.ownerId
  const ownerName = str(p, 'ownerName') ?? lineage.ownerName

  // 防超退守恒：Σissue（负值）取绝对值 − Σ已退（reverse+material_return，正值）
  const issuedTotalRaw = await inv.transactions.sumQuantityByUnit(unitId, { movementKind: 'issue' })
  const returnedTotalRaw = await inv.transactions.sumQuantityByUnit(unitId, {
    movementKind: 'reverse',
    refType: 'material_return',
  })
  const issuedTotal = issuedTotalRaw.startsWith('-') ? issuedTotalRaw.slice(1) : issuedTotalRaw
  const remaining = subQty(issuedTotal, returnedTotalRaw)
  if (cmpQty(remaining, quantity) < 0) {
    throw new InventoryRuleViolation(
      'IT-28',
      `退料量超过可退余量（单元 ${unit.unitNo} 累计领用 ${issuedTotal}、已退 ${returnedTotalRaw}、可退 ${remaining}、本次 ${quantity}），拒绝`,
    )
  }

  // 目标键余额：无则新建；有（含曾被投空关闭的行）则在其上写反向行——writeLine 落账时
  // 以扣前/扣后重建余额行状态（afterQty>0 → active），零余额关闭行经退料自然重开（IT-29 身份保留）
  let target = await lockBalance(pc.tools, unitId, locationId, ownerId)
  if (target === null) {
    target = await inv.balances.insert({
      unitId,
      locationId,
      locationCode,
      ownerId,
      ownerName,
      quantity: '0.0000',
      uomId: lineage.uomId,
      uomCode: lineage.uomCode,
      measurementBasis: lineage.measurementBasis,
      conversionRevisionId: lineage.conversionRevisionId,
      qualityStatus: lineage.qualityStatus,
      plantId: unit.plantId,
      enterpriseId: unit.enterpriseId,
      businessTime: pc.businessTime,
      createdBy: pc.ctx.actorLoginName,
    })
  }

  const afterQty = addQty(target.quantity, quantity)
  const written = await writeLine(pc, {
    lineNo: 1,
    movementKind: 'reverse',
    balance: target,
    beforeQty: target.quantity,
    afterQty,
    unit,
    from: { locationId, locationCode, ownerId, ownerName },
    reason: str(p, 'reason') ?? null,
    refType: 'material_return',
    refId: str(p, 'refId') ?? null,
  })

  // 单元已耗尽（投空零余额关闭）→ 退料重开（IT-13 状态轴回在库）
  if (unit.status === 'exhausted') {
    await inv.units.updateStatus(
      unitId,
      { status: 'in_stock', balanceOpen: true, balanceClosedAt: null },
      pc.ctx.actorLoginName,
    )
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'inventory.return-material',
    subjectType: 'inventory_unit',
    subjectId: unitId,
    before: { quantity: target.quantity, location: target.locationCode },
    after: { quantity: afterQty, location: locationCode },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'inventory_unit',
    aggregateId: unitId,
    taskKind: 'inventory.material-returned',
    payload: {
      unitId,
      unitNo: unit.unitNo,
      quantity,
      locationCode,
      issuedTotal,
      returnedTotal: returnedTotalRaw,
      afterQty,
      businessTime: pc.businessTime,
    },
  })
  return {
    unitId,
    balanceId: target.id,
    transactionId: written.transactionId,
    beforeQty: target.quantity,
    afterQty,
    remainingReturnable: subQty(remaining, quantity),
  }
}

// ---------------- 移位（同厂库位/所有者变动） ----------------

export async function moveStock(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const unitId = requireStr(p, 'unitId', 'inventory.move-stock')
  const quantity = requireDec(p, 'quantity', 'inventory.move-stock')
  const toLocationId = requireStr(p, 'toLocationId', 'inventory.move-stock')
  const toLocationCode = requireStr(p, 'toLocationCode', 'inventory.move-stock')
  // 流水行号基（缺省 1：来源减=lineN、现库位增=lineN+1）。同一命令内多次移位（如组单入库逐任务
  // 移位）必须由调用方按占用行数推进，避让 stock_transaction (command_receipt_id, line_no) 唯一约束。
  const lineNoBaseRaw = p['lineNoBase']
  const lineNoBase =
    typeof lineNoBaseRaw === 'number' && Number.isInteger(lineNoBaseRaw) && lineNoBaseRaw >= 1 ? lineNoBaseRaw : 1
  const refType = str(p, 'refType') ?? null
  const refId = str(p, 'refId') ?? null
  const units = await lockUnits(pc, [unitId], str(p, 'plantId'))
  const unit = units.get(unitId)!

  const fromOwnerId = str(p, 'fromOwnerId')
  const from = await lockResolvedBalance(pc.tools, unit, str(p, 'fromLocationId'), fromOwnerId)
  if (from === null || from.status === 'closed') {
    throw new InventoryRuleViolation(NOT_FOUND_RULE, `库存单元 ${unit.unitNo} 来源余额不存在或已关闭`)
  }
  const toOwnerId = str(p, 'toOwnerId') ?? from.ownerId
  const toOwnerName = str(p, 'toOwnerName') ?? from.ownerName
  let to = await lockBalance(pc.tools, unitId, toLocationId, toOwnerId)
  if (to === null) {
    to = await pc.tools.inv.balances.insert({
      unitId,
      locationId: toLocationId,
      locationCode: toLocationCode,
      ownerId: toOwnerId,
      ownerName: toOwnerName,
      quantity: '0.0000',
      uomId: from.uomId,
      uomCode: from.uomCode,
      measurementBasis: from.measurementBasis,
      conversionRevisionId: from.conversionRevisionId,
      qualityStatus: from.qualityStatus,
      plantId: unit.plantId,
      enterpriseId: unit.enterpriseId,
      businessTime: pc.businessTime,
      createdBy: pc.ctx.actorLoginName,
    })
  }
  if (from.id === to.id) {
    throw new InventoryRuleViolation('IT-20', '移位来源与目标余额键相同（unit+location+owner），拒绝')
  }

  const fromAfter = subQty(from.quantity, quantity)
  if (cmpQty(fromAfter, '0.0000') < 0) {
    throw new InventoryRuleViolation('IT-30', `移位量超过来源余额（来源 ${from.quantity}、本次 ${quantity}），拒绝`)
  }
  const toAfter = addQty(to.quantity, quantity)

  const out = await writeLine(pc, {
    lineNo: lineNoBase,
    movementKind: 'move',
    balance: from,
    beforeQty: from.quantity,
    afterQty: fromAfter,
    unit,
    from: { locationId: from.locationId, locationCode: from.locationCode, ownerId: from.ownerId, ownerName: from.ownerName },
    to: { locationId: toLocationId, locationCode: toLocationCode, ownerId: toOwnerId, ownerName: toOwnerName },
    reason: str(p, 'reason') ?? null,
    refType,
    refId,
  })
  const into = await writeLine(pc, {
    lineNo: lineNoBase + 1,
    movementKind: 'move',
    balance: to,
    beforeQty: to.quantity,
    afterQty: toAfter,
    unit,
    from: { locationId: from.locationId, locationCode: from.locationCode, ownerId: from.ownerId, ownerName: from.ownerName },
    to: { locationId: toLocationId, locationCode: toLocationCode, ownerId: toOwnerId, ownerName: toOwnerName },
    reason: str(p, 'reason') ?? null,
    refType,
    refId,
  })

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'inventory.move-stock',
    subjectType: 'inventory_unit',
    subjectId: unitId,
    before: { location: from.locationCode, quantity: from.quantity },
    after: { location: toLocationCode, quantity: toAfter },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'inventory_unit',
    aggregateId: unitId,
    taskKind: 'inventory.stock-moved',
    payload: { unitId, unitNo: unit.unitNo, quantity, fromLocation: from.locationCode, toLocation: toLocationCode, businessTime: pc.businessTime },
  })
  return { unitId, fromBalanceId: from.id, toBalanceId: to.id, transactionIds: [out.transactionId, into.transactionId], fromAfter, toAfter }
}

// ---------------- 调拨两段步（IT-25：两段各自原子） ----------------

export async function transferOut(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const unitId = requireStr(p, 'unitId', 'inventory.transfer.out')
  const quantity = requireDec(p, 'quantity', 'inventory.transfer.out')
  const transitLocationId = requireStr(p, 'transitLocationId', 'inventory.transfer.out')
  const transitLocationCode = requireStr(p, 'transitLocationCode', 'inventory.transfer.out')
  // 流水行号基（缺省 1：来源减=lineN、在途增=lineN+1）。ABS 收编轮参数化：同一命令回执下
  // 多段调拨由调用方按占用行数推进（同 moveStock.lineNoBase 口径）。
  const lineNoBaseRaw = p['lineNoBase']
  const lineNoBase =
    typeof lineNoBaseRaw === 'number' && Number.isInteger(lineNoBaseRaw) && lineNoBaseRaw >= 1 ? lineNoBaseRaw : 1
  const units = await lockUnits(pc, [unitId], str(p, 'plantId'))
  const unit = units.get(unitId)!

  const from = await lockResolvedBalance(pc.tools, unit, str(p, 'fromLocationId'), str(p, 'ownerId'))
  if (from === null || from.status === 'closed') {
    throw new InventoryRuleViolation(NOT_FOUND_RULE, `库存单元 ${unit.unitNo} 来源余额不存在或已关闭`)
  }
  const ownerId = str(p, 'ownerId') ?? from.ownerId
  const ownerName = from.ownerName
  let transit = await lockBalance(pc.tools, unitId, transitLocationId, ownerId)
  if (transit === null) {
    transit = await pc.tools.inv.balances.insert({
      unitId,
      locationId: transitLocationId,
      locationCode: transitLocationCode,
      ownerId,
      ownerName,
      quantity: '0.0000',
      uomId: from.uomId,
      uomCode: from.uomCode,
      measurementBasis: from.measurementBasis,
      conversionRevisionId: from.conversionRevisionId,
      qualityStatus: from.qualityStatus,
      plantId: unit.plantId,
      enterpriseId: unit.enterpriseId,
      businessTime: pc.businessTime,
      createdBy: pc.ctx.actorLoginName,
    })
  }

  if (from.id === transit.id) throw new InventoryRuleViolation('IT-20', '调出与在途余额必须不同')
  const fromAfter = subQty(from.quantity, quantity)
  if (cmpQty(fromAfter, '0.0000') < 0) {
    throw new InventoryRuleViolation('IT-30', `调拨量超过来源余额（来源 ${from.quantity}、本次 ${quantity}），拒绝`)
  }
  const out = await writeLine(pc, {
    lineNo: lineNoBase,
    movementKind: 'transfer_out',
    balance: from,
    beforeQty: from.quantity,
    afterQty: fromAfter,
    unit,
    from: { locationId: from.locationId, locationCode: from.locationCode, ownerId: from.ownerId, ownerName: from.ownerName },
    to: { locationId: transitLocationId, locationCode: transitLocationCode, ownerId, ownerName },
    reason: str(p, 'reason') ?? null,
  })
  await writeLine(pc, {
    lineNo: lineNoBase + 1,
    movementKind: 'transfer_out',
    balance: transit,
    beforeQty: transit.quantity,
    afterQty: addQty(transit.quantity, quantity),
    unit,
    from: { locationId: from.locationId, locationCode: from.locationCode, ownerId: from.ownerId, ownerName },
    to: { locationId: transitLocationId, locationCode: transitLocationCode, ownerId, ownerName },
    reason: str(p, 'reason') ?? null,
  })
  // IT-13：状态轴 → 在途
  await pc.tools.inv.units.updateStatus(unitId, { status: 'in_transit' }, pc.ctx.actorLoginName)

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'inventory.transfer.out',
    subjectType: 'inventory_unit',
    subjectId: unitId,
    after: { quantity, from: from.locationCode, transit: transitLocationCode },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'inventory_unit',
    aggregateId: unitId,
    taskKind: 'inventory.transfer-out',
    payload: { unitId, unitNo: unit.unitNo, quantity, from: from.locationCode, transit: transitLocationCode, businessTime: pc.businessTime },
  })
  return { unitId, fromBalanceId: from.id, transitBalanceId: transit.id, firstLineId: out.transactionId }
}

export async function transferIn(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const unitId = requireStr(p, 'unitId', 'inventory.transfer.in')
  const quantity = requireDec(p, 'quantity', 'inventory.transfer.in')
  const transitLocationId = requireStr(p, 'transitLocationId', 'inventory.transfer.in')
  const toLocationId = requireStr(p, 'toLocationId', 'inventory.transfer.in')
  let toLocationCode = requireStr(p, 'toLocationCode', 'inventory.transfer.in')
  // 流水行号基（缺省 1：在途减=lineN、目的增=lineN+1）。ABS 收编轮参数化（同 transferOut 口径）。
  const lineNoBaseRaw = p['lineNoBase']
  const lineNoBase =
    typeof lineNoBaseRaw === 'number' && Number.isInteger(lineNoBaseRaw) && lineNoBaseRaw >= 1 ? lineNoBaseRaw : 1
  const units = await lockUnits(pc, [unitId], str(p, 'plantId'))
  const unit = units.get(unitId)!

  // 在途余额定位：显式 owner 或按"该库位上的活动余额"解析（在途余额在调拨出库段创建）
  let transit: StockBalanceRecord | null
  if (str(p, 'ownerId') !== undefined) {
    transit = await lockBalance(pc.tools, unitId, transitLocationId, str(p, 'ownerId')!)
  } else {
    const actives = await pc.tools.inv.balances.listActiveByUnit(unitId)
    const atLocation = actives.filter((b) => b.locationId === transitLocationId)
    if (atLocation.length === 1) {
      transit = await lockBalance(pc.tools, unitId, transitLocationId, atLocation[0]!.ownerId)
    } else if (atLocation.length === 0) {
      transit = null
    } else {
      throw new InventoryRuleViolation('IT-20', `在途库位 ${transitLocationId} 存在多个所有者余额，须显式指定 ownerId`)
    }
  }
  if (transit === null || transit.status === 'closed') {
    throw new InventoryRuleViolation(NOT_FOUND_RULE, `库存单元 ${unit.unitNo} 无在途余额（先执行调拨出库段）`)
  }
  let destOwnerId = transit.ownerId
  let destOwnerName = transit.ownerName
  let destUnit = unit
  const explicitDestination = str(p, 'toPlantId') !== undefined || str(p, 'toOwnerId') !== undefined
  if (explicitDestination) {
    if (unit.enterpriseId !== pc.ctx.enterpriseId) throw new InventoryRuleViolation('IT-S1', '源单元不属于本企业')
    await assertPlantScope(pc, unit.plantId)
    const toPlantId = requireStr(p, 'toPlantId', 'inventory.transfer.in')
    const toOwnerId = requireStr(p, 'toOwnerId', 'inventory.transfer.in')
    const destination = await pc.tools.inv.units.findTransferDestination(toPlantId, toOwnerId, toLocationId)
    const sourcePlant = await pc.tools.org.findById(unit.plantId)
    if (destination === null || destination.enterpriseId !== pc.ctx.enterpriseId || sourcePlant === null ||
        sourcePlant.kind !== 'plant' || sourcePlant.status !== 'active' || sourcePlant.enterpriseId !== pc.ctx.enterpriseId) {
      throw new InventoryRuleViolation('IT-S1', '目标厂/所有者/库位身份不合法或跨企业')
    }
    await assertPlantScope(pc, destination.plantId)
    const active = (await pc.tools.inv.balances.listActiveByUnit(unitId)).filter(row => cmpQty(row.quantity, '0') > 0)
    if (unit.status !== 'in_transit' || active.length !== 1 || active[0]!.id !== transit.id ||
        !(await pc.tools.inv.units.isTransferOutBalance(unitId, transit.id, unit.plantId))) {
      throw new InventoryRuleViolation('IT-20', '跨厂接收必须来自真实单一调出在途，剩余源库存须先分盘')
    }
    if (cmpQty(quantity, transit.quantity) !== 0) throw new InventoryRuleViolation('IT-30', '跨厂接收须本单元全量，部分接收须先分盘')
    destOwnerId = destination.ownerId
    destOwnerName = destination.ownerName
    toLocationCode = destination.locationCode
    destUnit = { ...unit, plantId: destination.plantId }
  }
  let dest = await lockBalance(pc.tools, unitId, toLocationId, destOwnerId)
  if (dest === null) {
    dest = await pc.tools.inv.balances.insert({
      unitId,
      locationId: toLocationId,
      locationCode: toLocationCode,
      ownerId: destOwnerId,
      ownerName: destOwnerName,
      quantity: '0.0000',
      uomId: transit.uomId,
      uomCode: transit.uomCode,
      measurementBasis: transit.measurementBasis,
      conversionRevisionId: transit.conversionRevisionId,
      qualityStatus: transit.qualityStatus,
      plantId: destUnit.plantId,
      enterpriseId: unit.enterpriseId,
      businessTime: pc.businessTime,
      createdBy: pc.ctx.actorLoginName,
    })
  }

  const transitAfter = subQty(transit.quantity, quantity)
  if (cmpQty(transitAfter, '0.0000') < 0) {
    throw new InventoryRuleViolation('IT-30', `调拨接收量超过在途余额（在途 ${transit.quantity}、本次 ${quantity}），拒绝`)
  }
  const out = await writeLine(pc, {
    lineNo: lineNoBase,
    movementKind: 'transfer_in',
    balance: transit,
    beforeQty: transit.quantity,
    afterQty: transitAfter,
    unit,
    from: { locationId: transit.locationId, locationCode: transit.locationCode, ownerId: transit.ownerId, ownerName: transit.ownerName },
    to: { locationId: toLocationId, locationCode: toLocationCode, ownerId: destOwnerId, ownerName: destOwnerName },
    reason: str(p, 'reason') ?? null,
  })
  await writeLine(pc, {
    lineNo: lineNoBase + 1,
    movementKind: 'transfer_in',
    balance: dest,
    beforeQty: dest.quantity,
    afterQty: addQty(dest.quantity, quantity),
    unit: destUnit,
    from: { locationId: transit.locationId, locationCode: transit.locationCode, ownerId: transit.ownerId, ownerName: transit.ownerName },
    to: { locationId: toLocationId, locationCode: toLocationCode, ownerId: destOwnerId, ownerName: destOwnerName },
    reason: str(p, 'reason') ?? null,
  })
  // IT-13：状态轴 → 在库
  if (explicitDestination) await pc.tools.inv.units.receiveAtPlant(unitId, destUnit.plantId, pc.ctx.actorLoginName)
  else await pc.tools.inv.units.updateStatus(unitId, { status: 'in_stock' }, pc.ctx.actorLoginName)

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'inventory.transfer.in',
    subjectType: 'inventory_unit',
    subjectId: unitId,
    after: { quantity, transit: transit.locationCode, to: toLocationCode },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'inventory_unit',
    aggregateId: unitId,
    taskKind: 'inventory.transfer-in',
    payload: { unitId, unitNo: unit.unitNo, quantity, transit: transit.locationCode, to: toLocationCode, businessTime: pc.businessTime },
  })
  return { unitId, transitBalanceId: transit.id, destBalanceId: dest.id, firstLineId: out.transactionId, plantId: destUnit.plantId, ownerId: destOwnerId }
}

// ---------------- 分盘（IT-28 守恒；IT-29 零余额关闭） ----------------

export async function splitStock(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const inv = pc.tools.inv
  const sourceUnitId = requireStr(p, 'sourceUnitId', 'inventory.split')
  const retainedQty = requireDec(p, 'retainedQty', 'inventory.split')
  const lossQty = dec(p, 'lossQty') ?? '0.0000'
  const reason = str(p, 'reason') ?? null
  if (cmpQty(lossQty, '0.0000') > 0 && (reason ?? '').trim() === '') {
    throw new InventoryRuleViolation('IT-31', '分盘记录损耗必须填写原因与去向（reason/ref）')
  }

  const units = await lockUnits(pc, [sourceUnitId], str(p, 'plantId'))
  const unit = units.get(sourceUnitId)!
  const source = await lockResolvedBalance(pc.tools, unit, undefined, undefined)
  if (source === null || source.status === 'closed') {
    throw new InventoryRuleViolation(NOT_FOUND_RULE, `库存单元 ${unit.unitNo} 无活动余额`)
  }

  const childrenPayload = p['children']
  if (!Array.isArray(childrenPayload) || childrenPayload.length === 0) {
    throw new InventoryRuleViolation('IT-28', '分盘至少一个子段')
  }
  const children = childrenPayload.map((raw, index) => {
    const c = (raw ?? {}) as Payload
    return {
      unitNo: requireStr(c, 'unitNo', `inventory.split.children[${index}]`),
      quantity: requireDec(c, 'quantity', `inventory.split.children[${index}]`),
      locationId: requireStr(c, 'locationId', `inventory.split.children[${index}]`),
      locationCode: requireStr(c, 'locationCode', `inventory.split.children[${index}]`),
      ownerId: str(c, 'ownerId') ?? source.ownerId,
      ownerName: str(c, 'ownerName') ?? source.ownerName,
    }
  })

  // IT-28：原量 = 子段合计 + 留存 + 损耗（同单位，IT-11）
  assertSplitConservation({
    originalQty: source.quantity,
    childQtyList: children.map((c) => c.quantity),
    retainedQty,
    lossQty,
    uomId: source.uomId,
  })

  const childrenTotal = sumQty(children.map((c) => c.quantity))
  const sourceAfter = subQty(source.quantity, addQty(childrenTotal, lossQty))
  const childUnitIds: string[] = []
  const results: Array<{ unitId: string; transactionId: string }> = []

  const sourceLine = await writeLine(pc, {
    lineNo: 1,
    movementKind: 'split',
    balance: source,
    beforeQty: source.quantity,
    afterQty: sourceAfter,
    unit,
    reason,
    refType: 'split_source',
  })

  let lineNo = 2
  for (const child of children) {
    const exists = await inv.units.findByUnitNo(unit.plantId, child.unitNo)
    if (exists !== null) {
      throw new InventoryRuleViolation('IT-01', `库存单元号 ${child.unitNo} 已存在`)
    }
    const childUnit = await inv.units.insert({
      unitNo: child.unitNo,
      materialId: unit.materialId,
      materialCode: unit.materialCode,
      lotId: unit.lotId,
      uomId: source.uomId,
      uomCode: source.uomCode,
      traceMode: 'quantity',
      status: 'in_stock',
      plantId: unit.plantId,
      enterpriseId: unit.enterpriseId,
      businessTime: pc.businessTime,
      createdBy: pc.ctx.actorLoginName,
    })
    childUnitIds.push(childUnit.id)
    const childBalance = await inv.balances.insert({
      unitId: childUnit.id,
      locationId: child.locationId,
      locationCode: child.locationCode,
      ownerId: child.ownerId,
      ownerName: child.ownerName,
      quantity: '0.0000',
      uomId: source.uomId,
      uomCode: source.uomCode,
      measurementBasis: source.measurementBasis,
      conversionRevisionId: source.conversionRevisionId,
      qualityStatus: source.qualityStatus,
      plantId: unit.plantId,
      enterpriseId: unit.enterpriseId,
      businessTime: pc.businessTime,
      createdBy: pc.ctx.actorLoginName,
    })
    const written = await writeLine(pc, {
      lineNo,
      movementKind: 'split',
      balance: childBalance,
      beforeQty: '0.0000',
      afterQty: child.quantity,
      unit: childUnit,
      reason,
      refType: 'split_child',
    })
    results.push({ unitId: childUnit.id, transactionId: written.transactionId })
    lineNo += 1
    // 谱系：源单元 --consumption--> 子单元（IT-34 投料消费边承载分盘数量来源）
    await inv.genealogy.insertEdge({
      fromType: 'inventory_unit',
      fromId: sourceUnitId,
      toType: 'inventory_unit',
      toId: childUnit.id,
      edgeKind: 'consumption',
      quantity: child.quantity,
      uomId: source.uomId,
      uomCode: source.uomCode,
      measurementBasis: source.measurementBasis,
      conversionRevisionId: source.conversionRevisionId,
      commandReceiptId: pc.commandReceiptId,
      businessTime: pc.businessTime,
      plantId: unit.plantId,
      enterpriseId: unit.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
  }
  await closeUnitIfZero(pc, unit, sourceLine.closed) // IT-29：零余额关闭，身份保留

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'inventory.split',
    subjectType: 'inventory_unit',
    subjectId: sourceUnitId,
    before: { quantity: source.quantity },
    after: { retainedQty, lossQty, children: children.map((c) => ({ unitNo: c.unitNo, quantity: c.quantity })) },
    reason,
  })
  pc.tools.outbox.collect({
    aggregateType: 'inventory_unit',
    aggregateId: sourceUnitId,
    taskKind: 'inventory.stock-split',
    payload: {
      sourceUnitId,
      sourceUnitNo: unit.unitNo,
      originalQty: source.quantity,
      retainedQty,
      lossQty,
      children: children.map((c) => ({ unitNo: c.unitNo, quantity: c.quantity })),
      businessTime: pc.businessTime,
    },
  })
  return {
    sourceUnitId,
    sourceAfterQty: sourceAfter,
    sourceBalanceClosed: sourceLine.closed,
    children: results,
    childUnitIds,
  }
}

// ---------------- 预留（IT-23 四要素 + 有效期） ----------------

export async function acquireReservation(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const inv = pc.tools.inv
  const unitId = requireStr(p, 'unitId', 'inventory.reservation.acquire')
  const quantity = requireDec(p, 'quantity', 'inventory.reservation.acquire')
  const holderType = requireStr(p, 'holderType', 'inventory.reservation.acquire')
  const holderRef = requireStr(p, 'holderRef', 'inventory.reservation.acquire')
  const validUntil = requireStr(p, 'validUntil', 'inventory.reservation.acquire')
  const now = pc.tools.now().toISOString()
  assertReservationAcquirable({ unitId, holderType, holderRef, quantity, validUntil, now }) // IT-23

  const units = await lockUnits(pc, [unitId], str(p, 'plantId')) // IT-15：同码并发消费/预留串行
  const unit = units.get(unitId)!
  const balances = await inv.balances.listActiveByUnit(unitId)
  const balance =
    str(p, 'locationId') !== undefined
      ? balances.find((b) => b.locationId === str(p, 'locationId')) ?? null
      : balances.length === 1
        ? balances[0]!
        : null
  if (balance === null) {
    throw new InventoryRuleViolation('IT-23', `库存单元 ${unit.unitNo} 无唯一活动余额，预留须显式指定库位`)
  }
  if (balance.unitId !== unit.id || balance.enterpriseId !== unit.enterpriseId || balance.plantId !== unit.plantId) {
    throw new InventoryRuleViolation('IT-S1', '预留余额与库存单元的实际归属不一致')
  }
  const reservations = await inv.reservations.listActiveByUnit(unitId)
  const availability = computeAvailability({
    grossQty: balance.quantity,
    qualityStatus: balance.qualityStatus,
    activeReservations: reservations.map((r) => ({ status: r.status, quantity: r.quantity, validUntil: r.validUntil })),
    now,
  })
  const afterReserved = addQty(availability.reserved, quantity)
  if (cmpQty(afterReserved, balance.quantity) > 0) {
    throw new InventoryRuleViolation(
      'IT-23',
      `预留合计不得超过余额（毛量 ${balance.quantity}、已预留 ${availability.reserved}、本次 ${quantity}）`,
    )
  }

  const reservation = await inv.reservations.insert({
    unitId,
    locationId: str(p, 'locationId') ?? null,
    holderType: holderType as 'job' | 'task' | 'order' | 'manual',
    holderRef,
    quantity,
    uomId: balance.uomId,
    uomCode: balance.uomCode,
    measurementBasis: balance.measurementBasis,
    validUntil,
    commandReceiptId: pc.commandReceiptId,
    plantId: unit.plantId,
    enterpriseId: unit.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'inventory.reservation.acquire',
    subjectType: 'reservation',
    subjectId: reservation.id,
    after: { unitId, quantity, holderType, holderRef, validUntil },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'reservation',
    aggregateId: reservation.id,
    taskKind: 'inventory.reservation-acquired',
    payload: { reservationId: reservation.id, unitId, unitNo: unit.unitNo, quantity, holderType, holderRef, validUntil },
  })
  return { reservationId: reservation.id, validUntil, quantity }
}

export async function releaseReservation(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const reservationId = requireStr(p, 'reservationId', 'inventory.reservation.release')
  const reservation = await pc.tools.inv.reservations.findById(reservationId)
  if (reservation === null) {
    throw new InventoryRuleViolation(NOT_FOUND_RULE, '预留不存在')
  }
  const units = await lockUnits(pc, [reservation.unitId], str(p, 'plantId'))
  const unit = units.get(reservation.unitId)!
  if (reservation.enterpriseId !== unit.enterpriseId || reservation.plantId !== unit.plantId) {
    throw new InventoryRuleViolation('IT-S1', '预留与库存单元的真实企业/工厂不一致')
  }
  if (reservation.status !== 'active') {
    throw new InventoryRuleViolation('IT-23', `预留 ${reservationId} 已处于 ${reservation.status} 状态，无须释放`)
  }
  // IT-23：释放记录（released_by 由实现层落 actor；此处断言释放人非空）
  const released = await pc.tools.inv.reservations.release(
    reservationId,
    pc.ctx.actorLoginName,
    str(p, 'releaseReason') ?? null,
    pc.tools.now().toISOString(),
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'inventory.reservation.release',
    subjectType: 'reservation',
    subjectId: reservationId,
    before: { status: 'active', quantity: reservation.quantity },
    after: { status: 'released' },
    reason: str(p, 'releaseReason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'reservation',
    aggregateId: reservationId,
    taskKind: 'inventory.reservation-released',
    payload: { reservationId, unitId: reservation.unitId, quantity: reservation.quantity },
  })
  return { reservationId, releasedAt: released?.releasedAt ?? null }
}



/** Establish unresolved business custody under the same unit locks as quantity writes. */
export async function establishBusinessHold(pc: PostingContext,p:Payload):Promise<Record<string,unknown>> {
  const permissions=await pc.tools.actorPermissions()
  if(!permissions.includes(INVENTORY_PERMISSIONS.INVENTORY_POST))throw new InventoryRuleViolation('IT-S1','缺少 inventory.post 权限')
  const ids=p['unitIds']
  if(!Array.isArray(ids)||ids.length===0||ids.some(id=>typeof id!=='string'||id.trim()===''))throw new InventoryRuleViolation('IT-22','业务留置须提供真实unitIds')
  const reason=requireStr(p,'reason','inventory.business-hold.establish').trim()
  const businessRef=requireStr(p,'businessRef','inventory.business-hold.establish').trim()
  if(!reason||!businessRef)throw new InventoryRuleViolation('IT-22','留置理由和业务引用不可为空')
  const units=await lockUnits(pc,ids as string[],str(p,'plantId'))
  // Validate all units before inserting any hold/audit, including enterprise-wide actors.
  for(const unit of units.values()){
    const plant=await pc.tools.org.findById(unit.plantId)
    if(unit.enterpriseId!==pc.ctx.enterpriseId||plant===null||plant.kind!=='plant'||plant.status!=='active'||plant.enterpriseId!==pc.ctx.enterpriseId)throw new InventoryRuleViolation('IT-S1','留置单元不在本企业真实活动工厂')
    await assertPlantScope(pc,unit.plantId)
    if(unit.status!=='in_stock'||(await pc.tools.inv.balances.listActiveByUnit(unit.id)).every(b=>cmpQty(b.quantity,'0')<=0))throw new InventoryRuleViolation('IT-BUSINESS-HOLD','仅可留置真实在库实物')
  }
  const holds=[]
  for(const unit of units.values()){
    const existing=(await pc.tools.inv.units.businessHolds(unit.id)).find(row=>row.businessRef===businessRef)
    if(existing){holds.push(existing);continue}
    const hold=await pc.tools.inv.units.insertBusinessHold({unitId:unit.id,enterpriseId:unit.enterpriseId,plantId:unit.plantId,reason,businessRef,commandReceiptId:pc.commandReceiptId,actorUserId:pc.ctx.actorUserId,actorLoginName:pc.ctx.actorLoginName,createdAt:pc.tools.now().toISOString()})
    await pc.tools.audit.record({actor:pc.ctx.actorLoginName,action:'inventory.business-hold.establish',subjectType:'inventory_unit',subjectId:unit.id,after:{holdId:hold.id,businessRef,reason},reason})
    holds.push(hold)
  }
  return {holds,qualityChanged:false,quantityChanged:false}
}
