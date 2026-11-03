import {
  buildPostingLine,
  ensureStableLockOrder,
  subQty,
  addQty,
  cmpQty,
  InventoryRuleViolation,
  type MovementKind,
} from '@cadenza/domain'
import type { CommandContext } from './command-bus'
import type { InventoryUnitRecord, StockBalanceRecord } from './inventory-repositories'
import type { CswCommandTools } from './csw-repositories'

/**
 * csw 外协两段库存交接等价记账服务（CS-21 沿用调拨两段原子步模式 IT-25；
 * 先例：shipping 的 shipUnitLine 等价内部记账服务——inventory-posting 的 writeLine 未导出，
 * 本文件以同一记账序复写：锁单元（稳定次序）→ 校验 → 写流水（含扣前/扣后）→ 更新余额）。
 *
 * 发送段（CS-20/21）：来源减＋外协在途增，movement_kind='transfer_out'，
 * 所有者不变（fromOwner==toOwner 强制），单元状态轴 → in_transit（外协在途＝在途具名细分，
 * 细分事实由 csw_outsourcing_unit 链接行承载）。
 * 回厂段（CS-22）：外协在途减＋目的增（回厂仓/待检位），movement_kind='transfer_in'，
 * 目的余额质量状态置 待检（回厂接收默认全部必检），单元状态轴 → in_stock。
 */

/** 记账上下文（同 PostingContext 口径；绑定 CswCommandTools）。 */
export interface CswPostingContext {
  tools: CswCommandTools
  ctx: CommandContext
  commandReceiptId: string
  businessTime: string
  shiftDate: string | null
}

/** 锁定单元（IT-25 稳定次序；外协逐单元串行）。 */
async function lockUnit(pc: CswPostingContext, unitId: string): Promise<InventoryUnitRecord> {
  const ordered = ensureStableLockOrder([unitId])
  const locked = await pc.tools.inv.units.lockForUpdate(ordered)
  if (locked.length !== 1) {
    throw new InventoryRuleViolation('NOT_FOUND', `库存单元 ${unitId} 不存在或已不可用`)
  }
  return locked[0]!
}

/** 解析单元唯一活动余额（多余额须显式指定键，IT-20 显式选择精神）。 */
async function resolveSingleActiveBalance(
  pc: CswPostingContext,
  unit: InventoryUnitRecord,
  locationId?: string,
): Promise<StockBalanceRecord> {
  const list = await pc.tools.inv.balances.listActiveByUnit(unit.id)
  const atLocation = locationId !== undefined ? list.filter((b) => b.locationId === locationId) : list
  if (atLocation.length === 0) {
    throw new InventoryRuleViolation('NOT_FOUND', `库存单元 ${unit.unitNo} 在指定键上无活动余额`)
  }
  if (atLocation.length > 1) {
    throw new InventoryRuleViolation('IT-20', `库存单元 ${unit.unitNo} 存在 ${atLocation.length} 条活动余额，须显式指定库位`)
  }
  return atLocation[0]!
}

interface LineWriteSpec {
  lineNo: number
  movementKind: MovementKind
  balance: StockBalanceRecord
  beforeQty: string
  afterQty: string
  unit: InventoryUnitRecord
  from: { locationId: string; locationCode: string; ownerId: string; ownerName: string }
  to: { locationId: string; locationCode: string; ownerId: string; ownerName: string }
  reason: string
  refType: string
  refId: string
}

/** 写一行流水 + 分录 + 余额实时更新（IT-19 扣前/扣后；IT-29 零余额关闭）。 */
async function writeLine(pc: CswPostingContext, spec: LineWriteSpec): Promise<{ transactionId: string; closed: boolean }> {
  const inv = pc.tools.inv
  const actor = pc.ctx.actorLoginName
  const line = buildPostingLine({
    lineNo: spec.lineNo,
    movementKind: spec.movementKind,
    beforeQty: spec.beforeQty,
    deltaQty: subQty(spec.afterQty, spec.beforeQty),
    uomId: spec.balance.uomId,
  })
  const inserted = await inv.transactions.insertLine({
    commandReceiptId: pc.commandReceiptId,
    lineNo: spec.lineNo,
    movementKind: spec.movementKind,
    unitId: spec.unit.id,
    lotId: spec.unit.lotId,
    balanceId: spec.balance.id,
    fromLocationId: spec.from.locationId,
    fromLocationCode: spec.from.locationCode,
    fromOwnerId: spec.from.ownerId,
    fromOwnerName: spec.from.ownerName,
    toLocationId: spec.to.locationId,
    toLocationCode: spec.to.locationCode,
    toOwnerId: spec.to.ownerId,
    toOwnerName: spec.to.ownerName,
    quantity: subQty(line.afterQty, line.beforeQty),
    uomId: spec.balance.uomId,
    uomCode: spec.balance.uomCode,
    measurementBasis: spec.balance.measurementBasis,
    conversionRevisionId: spec.balance.conversionRevisionId,
    beforeQty: line.beforeQty,
    afterQty: line.afterQty,
    refType: spec.refType,
    refId: spec.refId,
    reason: spec.reason,
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
    lotId: spec.unit.lotId,
    quantityDelta: subQty(line.afterQty, line.beforeQty),
    beforeQty: line.beforeQty,
    afterQty: line.afterQty,
    purpose: spec.movementKind,
    plantId: spec.unit.plantId,
    enterpriseId: spec.unit.enterpriseId,
    createdBy: actor,
  })
  const closes = cmpQty(line.afterQty, '0.0000') === 0
  await inv.balances.adjust(
    spec.balance.id,
    closes
      ? { quantity: line.afterQty, status: 'closed', closedAt: pc.businessTime }
      : { quantity: line.afterQty, status: 'active', closedAt: null },
    actor,
  )
  return { transactionId: inserted.id, closed: closes }
}

export interface OutsourceSendLineResult {
  unitId: string
  fromBalanceId: string
  transitBalanceId: string
  ownerId: string
  firstLineNo: number
  sourceClosed: boolean
}

/**
 * [CS-20/CS-21] 外协发送段（等价 transferOut 两行：来源减＋外协在途增）。
 * 所有者不变由调用方以 source.ownerId 显式传入 transitOwner 保证（所有权保留）；
 * 单元状态轴 → in_transit。
 */
export async function outsourceSendLine(
  pc: CswPostingContext,
  spec: {
    lineNoBase: number
    unitId: string
    quantity: string
    fromLocationId?: string
    transitLocationId: string
    transitLocationCode: string
    taskId: string
    taskNo: string
  },
): Promise<OutsourceSendLineResult> {
  const unit = await lockUnit(pc, spec.unitId)
  const from = await resolveSingleActiveBalance(pc, unit, spec.fromLocationId)
  if (from.status === 'closed') {
    throw new InventoryRuleViolation('NOT_FOUND', `库存单元 ${unit.unitNo} 来源余额已关闭`)
  }
  const fromAfter = subQty(from.quantity, spec.quantity)
  if (cmpQty(fromAfter, '0.0000') < 0) {
    throw new InventoryRuleViolation('IT-30', `外协发送量超过来源余额（来源 ${from.quantity}、本次 ${spec.quantity}），拒绝`)
  }
  // [CS-20] 所有权保留：外协在途余额与来源同所有者（不变更所有者、不作出库报废）
  const ownerId = from.ownerId
  const ownerName = from.ownerName
  let transit = await pc.tools.inv.balances.lockByKey(unit.id, spec.transitLocationId, ownerId)
  if (transit === null) {
    transit = await pc.tools.inv.balances.insert({
      unitId: unit.id,
      locationId: spec.transitLocationId,
      locationCode: spec.transitLocationCode,
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
  if (transit.status === 'closed') {
    throw new InventoryRuleViolation('NOT_FOUND', `库存单元 ${unit.unitNo} 外协在途余额已关闭（先处理历史在途）`)
  }
  const fromRef = { locationId: from.locationId, locationCode: from.locationCode, ownerId: from.ownerId, ownerName: from.ownerName }
  const toRef = { locationId: spec.transitLocationId, locationCode: spec.transitLocationCode, ownerId, ownerName }
  const out = await writeLine(pc, {
    lineNo: spec.lineNoBase,
    movementKind: 'transfer_out',
    balance: from,
    beforeQty: from.quantity,
    afterQty: fromAfter,
    unit,
    from: fromRef,
    to: toRef,
    reason: `外协发送 ${spec.taskNo}`,
    refType: 'csw_outsourcing_task',
    refId: spec.taskId,
  })
  await writeLine(pc, {
    lineNo: spec.lineNoBase + 1,
    movementKind: 'transfer_out',
    balance: transit,
    beforeQty: transit.quantity,
    afterQty: addQty(transit.quantity, spec.quantity),
    unit,
    from: fromRef,
    to: toRef,
    reason: `外协发送 ${spec.taskNo}`,
    refType: 'csw_outsourcing_task',
    refId: spec.taskId,
  })
  // IT-13：状态轴 → 在途（外协在途＝in_transit 的具名细分，CS-20）
  await pc.tools.inv.units.updateStatus(unit.id, { status: 'in_transit' }, pc.ctx.actorLoginName)
  return {
    unitId: unit.id,
    fromBalanceId: from.id,
    transitBalanceId: transit.id,
    ownerId,
    firstLineNo: spec.lineNoBase,
    sourceClosed: out.closed,
  }
}

export interface OutsourceReturnLineResult {
  unitId: string
  transitBalanceId: string
  destBalanceId: string
  ownerId: string
  firstLineNo: number
}

/**
 * [CS-21/CS-22] 外协回厂段（等价 transferIn 两行：外协在途减＋目的增）。
 * 目的余额质量状态置 待检（回厂接收默认全部必检）；单元状态轴 → in_stock。
 * 回厂量不得超过该单元外协在途余额（调用方按链接行核对发送余量）。
 */
export async function outsourceReturnLine(
  pc: CswPostingContext,
  spec: {
    lineNoBase: number
    unitId: string
    quantity: string
    transitLocationId: string
    toLocationId: string
    toLocationCode: string
    taskId: string
    taskNo: string
  },
): Promise<OutsourceReturnLineResult> {
  const unit = await lockUnit(pc, spec.unitId)
  const actives = await pc.tools.inv.balances.listActiveByUnit(unit.id)
  const atTransit = actives.filter((b) => b.locationId === spec.transitLocationId)
  if (atTransit.length === 0) {
    throw new InventoryRuleViolation('NOT_FOUND', `库存单元 ${unit.unitNo} 无外协在途余额（先执行发送段）`)
  }
  if (atTransit.length > 1) {
    throw new InventoryRuleViolation('IT-20', `外协在途库位存在 ${atTransit.length} 条所有者余额，状态异常须人工处置`)
  }
  const transit = atTransit[0]!
  if (transit.status === 'closed') {
    throw new InventoryRuleViolation('NOT_FOUND', `库存单元 ${unit.unitNo} 外协在途余额已关闭`)
  }
  const destOwnerId = transit.ownerId
  let dest = await pc.tools.inv.balances.lockByKey(unit.id, spec.toLocationId, destOwnerId)
  if (dest === null) {
    dest = await pc.tools.inv.balances.insert({
      unitId: unit.id,
      locationId: spec.toLocationId,
      locationCode: spec.toLocationCode,
      ownerId: destOwnerId,
      ownerName: transit.ownerName,
      quantity: '0.0000',
      uomId: transit.uomId,
      uomCode: transit.uomCode,
      measurementBasis: transit.measurementBasis,
      conversionRevisionId: transit.conversionRevisionId,
      // [CS-22] 回厂接收默认全部必检：目的余额落待检（后续放行走质量域）
      qualityStatus: 'pending_inspection',
      plantId: unit.plantId,
      enterpriseId: unit.enterpriseId,
      businessTime: pc.businessTime,
      createdBy: pc.ctx.actorLoginName,
    })
  }
  const transitAfter = subQty(transit.quantity, spec.quantity)
  if (cmpQty(transitAfter, '0.0000') < 0) {
    throw new InventoryRuleViolation('IT-30', `回厂量超过外协在途余额（在途 ${transit.quantity}、本次 ${spec.quantity}），拒绝`)
  }
  const fromRef = { locationId: transit.locationId, locationCode: transit.locationCode, ownerId: transit.ownerId, ownerName: transit.ownerName }
  const toRef = { locationId: spec.toLocationId, locationCode: spec.toLocationCode, ownerId: destOwnerId, ownerName: transit.ownerName }
  await writeLine(pc, {
    lineNo: spec.lineNoBase,
    movementKind: 'transfer_in',
    balance: transit,
    beforeQty: transit.quantity,
    afterQty: transitAfter,
    unit,
    from: fromRef,
    to: toRef,
    reason: `外协回厂 ${spec.taskNo}`,
    refType: 'csw_outsourcing_task',
    refId: spec.taskId,
  })
  await writeLine(pc, {
    lineNo: spec.lineNoBase + 1,
    movementKind: 'transfer_in',
    balance: dest,
    beforeQty: dest.quantity,
    afterQty: addQty(dest.quantity, spec.quantity),
    unit,
    from: fromRef,
    to: toRef,
    reason: `外协回厂 ${spec.taskNo}`,
    refType: 'csw_outsourcing_task',
    refId: spec.taskId,
  })
  // [CS-22] 既有目的余额（重复回厂同位）也置待检（回厂接收默认全部必检）
  await pc.tools.inv.balances.adjust(
    dest.id,
    { qualityStatus: 'pending_inspection' },
    pc.ctx.actorLoginName,
  )
  // IT-13：状态轴 → 在库（回厂仓/待检位）
  await pc.tools.inv.units.updateStatus(unit.id, { status: 'in_stock' }, pc.ctx.actorLoginName)
  return {
    unitId: unit.id,
    transitBalanceId: transit.id,
    destBalanceId: dest.id,
    ownerId: destOwnerId,
    firstLineNo: spec.lineNoBase,
  }
}
