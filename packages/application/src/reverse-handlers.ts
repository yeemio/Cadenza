import { ERROR_CODES } from '@cadenza/contracts'
import {
  InventoryRuleViolation,
  QualityRuleViolation,
  addQty,
  buildPostingLine,
  cmpQty,
  ensureStableLockOrder,
  isPositiveQty,
  isValidQuantityString,
  recalcOrderLineStatus,
  subQty,
  zeroBalanceDisposition,
  type MovementKind,
} from '@cadenza/domain'
import { assertOutboundQualityGate } from '@cadenza/domain'
import {
  ReverseRuleViolation,
  assertAdjustmentAgainstRealtimeBalance,
  assertAdjustmentExecutable,
  assertBatchDeletableAllOrNothing,
  assertCarrierLoanEventExecutable,
  assertCrossPlantNeedsIndependentReceipt,
  assertGroupNotDuplicatedInPayload,
  assertInboundCompletable,
  assertInboundScanRemovable,
  assertMoveScanAcceptable,
  assertMoveSubmitAcceptable,
  assertMoveTargetWarehouse,
  assertNamedReversalExecutable,
  assertNotCustomerReturnPayload,
  assertNotDownstreamConsumed,
  assertNotStocktakeLocked,
  assertOutboundCompletable,
  assertOutboundOrderEditable,
  assertOwnershipTransferExecutable,
  assertPutawayLocationInput,
  assertPutawayScanAcceptable,
  assertReScanConfirmed,
  assertReceiptModifiable,
  assertReverseReturnExecutable,
  assertReturnSyncRetryable,
  assertTasklessFromWarehouseConsistent,
  assertTasklessSingleInProgress,
  assertTransferOutScanAcceptable,
  assertTransferOutStep,
  assertTransferOutWarehouseRules,
  assertVoidExecutable,
  assertWholeCodeOutbound,
  assertReservationAcquirable,
  buildAdjustmentBalances,
  inboundStatusAfterRemoval,
  isSamePlantImmediateTransfer,
  isCarrierAvailableForPlant,
  mergeMoveLines,
  totalMovedQty,
  assertMergedLinesPositive,
  type CarrierLoanEventKind,
  type MoveScanFacts,
} from '@cadenza/domain'
import type { CommandHandler, HandlerOutcome } from './command-bus'
import {
  acquireReservation,
  buildPostingContext,
  moveStock,
  NOT_FOUND_RULE,
  type PostingContext,
} from './inventory-posting'
import { violationOutcome } from './inventory-handlers'
// ABS 收编轮：订单行已收扣减＋状态重算直调 purchase 域核心（原本域等价服务 deductOrderLine 已删除）
import { deductOrderLineReceived } from './purchase-handlers'
import { assertObjectWriteScope } from './object-scope-repositories'
import type {
  CarrierFacts,
  PurchaseBatchFacts,
  ReverseCommandTools,
  TransferOutboundOrderRecord,
  TransferInboundOrderRecord,
  TransferInboundLineRecord,
} from './reverse-repositories'
import type { InventoryUnitRecord, StockBalanceRecord } from './inventory-repositories'

/**
 * reverse 域命令处理器（T17 仓储异常与逆向；全部在命令总线事务内运行，命令事务即 UoW）。
 *
 * 命令面（22）：
 * - 移库（WR-01～05）：reverse.move.submit（PDA 暂存提交：服务端事务内实时重校验＋台账）；
 * - 调拨出库（WR-06～13）：reverse.transfer-outbound.create/update/delete/scan/remove-scan/
 *   complete/auto-generate（Web 有任务全流程＋PDA 无任务首扫建单＋自动生成）；
 * - 调拨入库与跨厂签收（WR-14～17）：reverse.transfer-inbound.scan-putaway/remove-scan/complete
 *   （跨厂必须记录独立接收事实，不以调出方填库位冒充签收）；
 * - 采购批次纠正（WR-18～23）：reverse.receipt.receive-lines/modify/return/void/reverse/
 *   return-sync.retry（目标口径：退货事实＋反向流水＋投影，隐式归零与管理删除废除）；
 * - 盘点（WR-24/25，[合同新造·最小语义]）：reverse.stocktake.open/record-count/close＋
 *   reverse.stock-adjustment.execute（差异调整单：原因必填＋去向＋正向/反向流水）；
 * - 所有权三分与载具借还（WR-26/27）：reverse.ownership.transfer＋reverse.carrier.loan
 *   （lend/take_back/damage/scrap 四事件 append-only）。
 *
 * 幂等/回执由 PgCommandBus 承担；规则违例以 [WR-xx] 前缀返回（BUSINESS_REJECTION）。
 * 等价记账服务（收编请求见交付记录 §7）：transferOutUnitLine/transferInUnitLine/
 * reverseBalanceLine/adjustBalanceLine——与 inventory-posting 同一记账序（IT-25），
 * 行号显式递增（IT-19 (command_receipt_id, line_no) 唯一）。
 */

type Payload = Record<string, unknown>

function reverseViolationOutcome(error: ReverseRuleViolation): HandlerOutcome {
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
    if (error instanceof ReverseRuleViolation) return reverseViolationOutcome(error)
    if (error instanceof InventoryRuleViolation) return violationOutcome(error)
    if (error instanceof QualityRuleViolation) {
      return {
        status: 'BUSINESS_REJECTION',
        errorCode: ERROR_CODES.BUSINESS_RULE,
        errorMessage: `[WR-09] ${error.message}`,
      }
    }
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
  if (v === undefined) throw new ReverseRuleViolation('WR-01', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

/** 组织范围二道防线（OA-24/26）。 */
async function assertPlantScope(tools: ReverseCommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new ReverseRuleViolation('A-S1', `目标工厂不在授权数据范围内（plant=${plantId}）`)
  }
}

function rvTools(pc: PostingContext): ReverseCommandTools {
  return pc.tools as ReverseCommandTools
}

function genNo(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656)
    .toString(36)
    .toUpperCase()
    .padStart(3, '0')}`
}

/** 仓库事实（0003 warehouse 只读投影）。 */
interface ReverseWarehouseFactsRow {
  id: string
  code: string
  warehouseType: string
  status: string
  deptId: string | null
  plantId: string
  enterpriseId: string
}

/** WR-24①：盘点锁定检查——仓库存在 + 活动盘单拦截（返回仓库事实）。 */
async function warehouseOpenFor(
  tools: ReverseCommandTools,
  warehouseId: string,
  action: string,
  rule: string,
): Promise<ReverseWarehouseFactsRow> {
  const wh = await tools.rv.warehouses.findById(warehouseId)
  if (wh === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `仓库 ${warehouseId} 不存在`)
  const stocktake = await tools.rv.stocktakes.findCountingByWarehouse(warehouseId)
  assertNotStocktakeLocked({
    warehouseId,
    warehouseCode: wh.code,
    activeStocktakeOrderNo: stocktake?.orderNo ?? null,
    action,
  })
  if (wh.status !== 'active') {
    throw new ReverseRuleViolation(rule, `仓库 ${wh.code} 处于锁定/停用状态（status=${wh.status}）：${action}拒绝`)
  }
  return wh
}

/** 单元的唯一活动余额（多键须显式，IT-20）。 */
async function singleActiveBalance(
  tools: ReverseCommandTools,
  unitId: string,
): Promise<StockBalanceRecord> {
  const list = await tools.inv.balances.listActiveByUnit(unitId)
  if (list.length === 0) {
    throw new ReverseRuleViolation(NOT_FOUND_RULE, '库存单元无活动余额')
  }
  if (list.length > 1) {
    throw new ReverseRuleViolation('WR-01', `库存单元存在 ${list.length} 条活动余额，须显式指定库位与所有者`)
  }
  return list[0]!
}

/** 有效（未过期）活动预留。 */
async function effectiveReservations(tools: ReverseCommandTools, unitId: string, now: string) {
  const list = await tools.inv.reservations.listActiveByUnit(unitId)
  return list.filter((r) => r.status === 'active' && Date.parse(r.validUntil) >= Date.parse(now))
}

/** 单元所在托（tray 载具）的成员单元与载具码（无托返回 null）。 */
async function trayMembership(
  tools: ReverseCommandTools,
  unitId: string,
): Promise<{ carrierId: string; carrierCode: string; memberUnitIds: string[] } | null> {
  const binding = await tools.inv.carriers.findActiveLoadBindingByUnit(unitId)
  if (binding === null) return null
  const carrier = await tools.rv.carrierFacts.findById(binding.carrierId)
  if (carrier === null || carrier.carrierKind !== 'tray') return null
  const members = await tools.inv.carriers.listLoadedUnits(carrier.id)
  return { carrierId: carrier.id, carrierCode: carrier.carrierCode, memberUnitIds: members.map((m) => m.unitId) }
}

// ---------------- 等价内部记账服务（IT-25 同一记账序；行号显式递增） ----------------

interface LedgerLineSpec {
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
}

/** 写一行流水＋分录＋余额实时更新（IT-19 扣前/扣后；IT-29 零余额关闭）。 */
async function writeLedgerLine(
  pc: PostingContext,
  spec: LedgerLineSpec,
): Promise<{ transactionId: string; closed: boolean }> {
  const inv = rvTools(pc).inv
  const line = buildPostingLine({
    lineNo: spec.lineNo,
    movementKind: spec.movementKind,
    beforeQty: spec.beforeQty,
    deltaQty: subQty(spec.afterQty, spec.beforeQty),
    uomId: spec.balance.uomId,
  })
  const closes = zeroBalanceDisposition(line.afterQty)
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
    createdBy: pc.ctx.actorLoginName,
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
    purpose: spec.movementKind,
    plantId: spec.unit.plantId,
    enterpriseId: spec.unit.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  await inv.balances.adjust(
    spec.balance.id,
    closes.closeBalance
      ? { quantity: line.afterQty, status: 'closed', closedAt: pc.businessTime }
      : { quantity: line.afterQty, status: 'active', closedAt: null },
    pc.ctx.actorLoginName,
  )
  return { transactionId: inserted.id, closed: closes.closeBalance }
}

async function closeUnitIfZeroBalance(
  pc: PostingContext,
  unit: InventoryUnitRecord,
  closed: boolean,
): Promise<void> {
  if (!closed) return
  await rvTools(pc).inv.units.updateStatus(
    unit.id,
    { status: 'exhausted', balanceOpen: false, balanceClosedAt: pc.businessTime },
    pc.ctx.actorLoginName,
  )
}

/** 目标余额锁定/插入（IT-20 键 = unit+location+owner）。 */
async function lockOrInsertBalance(
  pc: PostingContext,
  unit: InventoryUnitRecord,
  template: StockBalanceRecord,
  locationId: string,
  locationCode: string,
  ownerId: string,
  ownerName: string,
): Promise<StockBalanceRecord> {
  const tools = rvTools(pc)
  const existing = await tools.inv.balances.lockByKey(unit.id, locationId, ownerId)
  if (existing !== null) return existing
  return tools.inv.balances.insert({
    unitId: unit.id,
    locationId,
    locationCode,
    ownerId,
    ownerName,
    quantity: '0.0000',
    uomId: template.uomId,
    uomCode: template.uomCode,
    measurementBasis: template.measurementBasis,
    conversionRevisionId: template.conversionRevisionId,
    qualityStatus: template.qualityStatus,
    plantId: unit.plantId,
    enterpriseId: unit.enterpriseId,
    businessTime: pc.businessTime,
    createdBy: pc.ctx.actorLoginName,
  })
}

/**
 * WR-12 调拨出库段（来源减＋在途增，各自一次事务原子完成——本函数运行于命令总线事务内）：
 * 行号 lineNo（来源减）与 lineNo+1（在途增）；单元状态轴 → 在途（IT-13）。
 */
async function transferOutUnitLine(
  pc: PostingContext,
  spec: {
    unit: InventoryUnitRecord
    from: StockBalanceRecord
    transitLocationId: string
    transitLocationCode: string
    quantity: string
    lineNo: number
    reason: string | null
    refType: string
    refId: string
  },
): Promise<{ transitBalanceId: string; linesUsed: number }> {
  const fromAfter = subQty(spec.from.quantity, spec.quantity)
  if (cmpQty(fromAfter, '0.0000') < 0) {
    throw new ReverseRuleViolation('WR-12', `调拨出库量超过来源余额（来源 ${spec.from.quantity}、本次 ${spec.quantity}），拒绝`)
  }
  const transit = await lockOrInsertBalance(
    pc,
    spec.unit,
    spec.from,
    spec.transitLocationId,
    spec.transitLocationCode,
    spec.from.ownerId,
    spec.from.ownerName,
  )
  await writeLedgerLine(pc, {
    lineNo: spec.lineNo,
    movementKind: 'transfer_out',
    balance: spec.from,
    beforeQty: spec.from.quantity,
    afterQty: fromAfter,
    unit: spec.unit,
    from: { locationId: spec.from.locationId, locationCode: spec.from.locationCode, ownerId: spec.from.ownerId, ownerName: spec.from.ownerName },
    to: { locationId: spec.transitLocationId, locationCode: spec.transitLocationCode, ownerId: spec.from.ownerId, ownerName: spec.from.ownerName },
    reason: spec.reason,
    refType: spec.refType,
    refId: spec.refId,
  })
  await writeLedgerLine(pc, {
    lineNo: spec.lineNo + 1,
    movementKind: 'transfer_out',
    balance: transit,
    beforeQty: transit.quantity,
    afterQty: addQty(transit.quantity, spec.quantity),
    unit: spec.unit,
    from: { locationId: spec.from.locationId, locationCode: spec.from.locationCode, ownerId: spec.from.ownerId, ownerName: spec.from.ownerName },
    to: { locationId: spec.transitLocationId, locationCode: spec.transitLocationCode, ownerId: spec.from.ownerId, ownerName: spec.from.ownerName },
    reason: spec.reason,
    refType: spec.refType,
    refId: spec.refId,
  })
  await rvTools(pc).inv.units.updateStatus(spec.unit.id, { status: 'in_transit' }, pc.ctx.actorLoginName)
  return { transitBalanceId: transit.id, linesUsed: 2 }
}

/**
 * WR-12 调拨入库段（在途减＋目的增）：行号 lineNo（在途减）与 lineNo+1（目的增）；
 * 单元状态轴 → 在库（IT-13）。返回目的余额。
 */
async function transferInUnitLine(
  pc: PostingContext,
  spec: {
    unit: InventoryUnitRecord
    transit: StockBalanceRecord
    toLocationId: string
    toLocationCode: string
    toPlantId: string
    quantity: string
    lineNo: number
    reason: string | null
    refType: string
    refId: string
  },
): Promise<{ destBalanceId: string; linesUsed: number }> {
  const transitAfter = subQty(spec.transit.quantity, spec.quantity)
  if (cmpQty(transitAfter, '0.0000') < 0) {
    throw new ReverseRuleViolation('WR-12', `调拨接收量超过在途余额（在途 ${spec.transit.quantity}、本次 ${spec.quantity}），拒绝`)
  }
  if (cmpQty(transitAfter, '0.0000') !== 0) throw new ReverseRuleViolation('WR-17', '整码接收必须消尽唯一在途余额；部分接收须先分盘')
  // Physical custody changes at independent receipt; legal ownership stays on
  // the balance. Debit the source plant and credit the verified destination.
  const destUnit = { ...spec.unit, plantId: spec.toPlantId }
  const dest = await lockOrInsertBalance(
    pc,
    destUnit,
    spec.transit,
    spec.toLocationId,
    spec.toLocationCode,
    spec.transit.ownerId,
    spec.transit.ownerName,
  )
  if (dest.enterpriseId !== destUnit.enterpriseId || dest.plantId !== destUnit.plantId ||
      cmpQty(dest.quantity, '0') !== 0 || dest.uomCode !== spec.transit.uomCode) {
    throw new ReverseRuleViolation('WR-17', '目标余额的企业/工厂/数量/单位与本次接收身份不一致')
  }
  await writeLedgerLine(pc, {
    lineNo: spec.lineNo,
    movementKind: 'transfer_in',
    balance: spec.transit,
    beforeQty: spec.transit.quantity,
    afterQty: transitAfter,
    unit: spec.unit,
    from: { locationId: spec.transit.locationId, locationCode: spec.transit.locationCode, ownerId: spec.transit.ownerId, ownerName: spec.transit.ownerName },
    to: { locationId: spec.toLocationId, locationCode: spec.toLocationCode, ownerId: spec.transit.ownerId, ownerName: spec.transit.ownerName },
    reason: spec.reason,
    refType: spec.refType,
    refId: spec.refId,
  })
  await writeLedgerLine(pc, {
    lineNo: spec.lineNo + 1,
    movementKind: 'transfer_in',
    balance: dest,
    beforeQty: dest.quantity,
    afterQty: addQty(dest.quantity, spec.quantity),
    unit: destUnit,
    from: { locationId: spec.transit.locationId, locationCode: spec.transit.locationCode, ownerId: spec.transit.ownerId, ownerName: spec.transit.ownerName },
    to: { locationId: spec.toLocationId, locationCode: spec.toLocationCode, ownerId: spec.transit.ownerId, ownerName: spec.transit.ownerName },
    reason: spec.reason,
    refType: spec.refType,
    refId: spec.refId,
  })
  await rvTools(pc).inv.units.receiveAtPlant(spec.unit.id, spec.toPlantId, pc.ctx.actorLoginName)
  return { destBalanceId: dest.id, linesUsed: 2 }
}

/** WR-20/21/24：反向流水（余额全额/差额冲回，movement_kind='reverse'/'adjust'）。 */
async function reverseBalanceLine(
  pc: PostingContext,
  spec: {
    unit: InventoryUnitRecord
    balance: StockBalanceRecord
    movementKind: 'reverse' | 'adjust'
    lineNo: number
    reason: string
    refType: string
    refId: string
  },
): Promise<{ transactionId: string; closed: boolean }> {
  const written = await writeLedgerLine(pc, {
    lineNo: spec.lineNo,
    movementKind: spec.movementKind,
    balance: spec.balance,
    beforeQty: spec.balance.quantity,
    afterQty: '0.0000',
    unit: spec.unit,
    from: { locationId: spec.balance.locationId, locationCode: spec.balance.locationCode, ownerId: spec.balance.ownerId, ownerName: spec.balance.ownerName },
    reason: spec.reason,
    refType: spec.refType,
    refId: spec.refId,
  })
  await closeUnitIfZeroBalance(pc, spec.unit, written.closed)
  return written
}

// ---------------- 命令：移库提交（WR-01～05） ----------------

async function moveSubmit(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.move.submit'
  const plantId = requireStr(p, 'plantId', command)
  await assertPlantScope(tools, plantId)
  const warehouseId = requireStr(p, 'warehouseId', command)
  const toLocationId = requireStr(p, 'toLocationId', command)
  const stagedRaw = p['stagedUnitNos']
  if (!Array.isArray(stagedRaw)) throw new ReverseRuleViolation('WR-02', `${command}：stagedUnitNos 须为字符串数组（本机暂存清单）`)
  const stagedUnitNos = stagedRaw.filter((v): v is string => typeof v === 'string' && v.length > 0)

  // WR-03：目标仓库范围（部门下、已启用、仓库类型不含线边仓）
  const targetWh = await tools.rv.warehouses.findById(warehouseId)
  if (targetWh === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `仓库 ${warehouseId} 不存在`)
  const actorUser = await tools.users.findById(pc.ctx.actorUserId)
  const scope = await tools.actorDataScope()
  const inActorDept =
    scope.enterpriseWide || (actorUser !== null && targetWh.deptId !== null && targetWh.deptId === actorUser.deptId)
  assertMoveTargetWarehouse({
    warehouseId,
    warehouseKind: targetWh.warehouseType,
    warehouseStatus: targetWh.status,
    inActorDept,
    scannedWarehouseId: null, // 逐码校验（扫码层 WR-02：码所在仓库与所选仓库不同）
  })

  // WR-24①：盘点锁定拦截移库
  await warehouseOpenFor(tools, warehouseId, '移库', 'WR-02')

  const toLocation = await tools.rv.locations.findById(toLocationId)
  if (toLocation === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '移入库位不存在')

  // 暂存数据解析（码不存在=暂存数据异常，WR-02）
  const duplicateCheck = new Set<string>()
  for (const unitNo of stagedUnitNos) {
    if (duplicateCheck.has(unitNo)) {
      throw new ReverseRuleViolation('WR-02', `暂存清单内单元 ${unitNo} 重复（本次重复拒绝）`)
    }
    duplicateCheck.add(unitNo)
  }
  const resolved: Array<{ unit: InventoryUnitRecord; balance: StockBalanceRecord }> = []
  let stagingAnomaly: string | null = null
  for (const unitNo of stagedUnitNos) {
    const unit = await tools.inv.units.findByUnitNo(plantId, unitNo)
    if (unit === null) {
      stagingAnomaly = `单元 ${unitNo} 不存在或已不在本厂`
      break
    }
    const balances = await tools.inv.balances.listActiveByUnit(unit.id)
    if (balances.length === 0) {
      stagingAnomaly = `单元 ${unitNo} 无活动余额`
      break
    }
    if (balances.length > 1) {
      stagingAnomaly = `单元 ${unitNo} 存在 ${balances.length} 条活动余额，暂存数据异常`
      break
    }
    resolved.push({ unit, balance: balances[0]! })
  }
  assertMoveSubmitAcceptable({
    stagingEmpty: resolved.length === 0 && stagingAnomaly === null,
    stagingAnomaly,
    locationCodeEmpty: (toLocation.code ?? '') === '',
    warehouseEmpty: false,
    locationNotInWarehouse: toLocation.warehouseId !== warehouseId,
  })

  // 锁单元（IT-25 稳定次序；WR-25：与业务流水并发时按事务序串行）
  await tools.inv.units.lockForUpdate(ensureStableLockOrder(resolved.map((r) => r.unit.id)))
  const now = pc.tools.now().toISOString()

  // WR-02 扫码层逐码实时重校验（提交在服务端事务内以实时状态重校验，WR-01）
  for (const { unit, balance } of resolved) {
    const fromLocation = await tools.rv.locations.findById(balance.locationId)
    const effective = await effectiveReservations(tools, unit.id, now)
    const tray = await trayMembership(tools, unit.id)
    const trayMembersLocked =
      tray !== null &&
      (
        await Promise.all(
          tray.memberUnitIds
            .filter((id) => id !== unit.id)
            .map(async (id) => effectiveReservations(tools, id, now)),
        )
      ).some((list) => list.length > 0)
    const facts: MoveScanFacts = {
      unitNo: unit.unitNo,
      warehouseMismatch: fromLocation === null ? true : fromLocation.warehouseId !== warehouseId,
      selectedWarehouseLocked: targetWh.status !== 'active',
      unitLockedByOtherTask: effective.length > 0,
      palletMemberLocked: trayMembersLocked,
      notInStock: unit.status !== 'in_stock',
      isPalletChildWithoutWhole:
        tray !== null && !tray.memberUnitIds.every((id) => resolved.some((r) => r.unit.id === id)),
      duplicateInStaging: false,
      sameLocation: balance.locationId === toLocationId,
    }
    assertMoveScanAcceptable(facts)
  }

  // WR-04：明细合并（同一码同一料品合并数量相加——暂存内同码同料必为整码，此处为同码多料不可能，保留合并语义）
  const merged = mergeMoveLines(
    resolved.map((r) => ({ unitNo: r.unit.unitNo, materialCode: r.unit.materialCode, quantity: r.balance.quantity })),
  )
  assertMergedLinesPositive(merged.merged)
  const totalQty = totalMovedQty(merged.merged)

  // 移库记录（表头＋逐码快照，append-only，WR-S1）
  const created = await tools.rv.moveRecords.insert(
    {
      moveNo: genNo('SM'),
      warehouseId,
      warehouseCode: targetWh.code,
      toLocationId,
      toLocationCode: toLocation.code,
      locationKind: toLocation.locationKind,
      materialCodesJoined: merged.materialCodesJoined,
      totalQty,
      movedBy: pc.ctx.actorLoginName,
      movedAt: pc.businessTime,
      reason: str(p, 'reason') ?? null,
      commandReceiptId: pc.commandReceiptId,
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      businessTime: pc.businessTime,
    },
    resolved.map((r, index) => ({
      lineNo: index + 1,
      inventoryUnitId: r.unit.id,
      unitNo: r.unit.unitNo,
      materialId: r.unit.materialId,
      materialCode: r.unit.materialCode,
      fromLocationId: r.balance.locationId,
      fromLocationCode: r.balance.locationCode,
      toLocationId,
      toLocationCode: toLocation.code,
      quantity: r.balance.quantity,
      uomId: r.balance.uomId,
      uomCode: r.balance.uomCode,
    })),
  )

  // 记账：逐码移位（WR-04：这些码移到新库位；库存统计按本次的码重算；所有权不变，WR-26）
  let lineNo = 1
  for (const { balance } of resolved) {
    await moveStock(pc, {
      unitId: balance.unitId,
      quantity: balance.quantity,
      fromLocationId: balance.locationId,
      fromOwnerId: balance.ownerId,
      toLocationId,
      toLocationCode: toLocation.code,
      lineNoBase: lineNo,
      reason: str(p, 'reason') ?? `移库提交（单号 ${created.header.moveNo}）`,
      refType: 'stock_move_record',
      refId: created.header.id,
    })
    lineNo += 2
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'stock_move_record',
    subjectId: created.header.id,
    after: { moveNo: created.header.moveNo, warehouseCode: targetWh.code, toLocationCode: toLocation.code, unitCount: resolved.length, totalQty },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'stock_move_record',
    aggregateId: created.header.id,
    taskKind: 'reverse.stock-move-submitted',
    payload: { moveNo: created.header.moveNo, unitCount: resolved.length, totalQty, toLocationCode: toLocation.code, businessTime: pc.businessTime },
  })
  return {
    moveNo: created.header.moveNo,
    recordId: created.header.id,
    lineCount: created.lines.length,
    totalQty,
    movedUnits: resolved.map((r) => r.unit.unitNo),
  }
}

// ---------------- 命令：调拨出库（WR-06～13） ----------------

/** WR-06 仓库规则事实收集＋断言（新增与完成出库都校验）。 */
type ReverseWarehouseView = NonNullable<Awaited<ReturnType<ReverseCommandTools['rv']['warehouses']['findById']>>>

async function assertOutboundWarehouseRules(
  tools: ReverseCommandTools,
  input: { transferKind: string; fromWarehouseId: string; toWarehouseId: string; lineMaterialIds: readonly string[]; forCompletion: boolean },
): Promise<{ from: ReverseWarehouseView; to: ReverseWarehouseView }> {
  const from = await tools.rv.warehouses.findById(input.fromWarehouseId)
  const to = await tools.rv.warehouses.findById(input.toWarehouseId)
  if (from === null || to === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '调出/调入仓库不存在')
  const materialTypes: (number | null)[] = []
  for (const materialId of input.lineMaterialIds) {
    materialTypes.push(await tools.rv.materials.findTypeById(materialId))
  }
  const fromLocked = from.status !== 'active'
  const toLocked = to.status !== 'active'
  assertTransferOutWarehouseRules({
    transferKind: input.transferKind,
    fromWarehouseId: input.fromWarehouseId,
    toWarehouseId: input.toWarehouseId,
    fromWarehouseKind: from.warehouseType,
    toWarehouseKind: to.warehouseType,
    lineMaterialTypes: materialTypes,
    fromWarehouseLocked: fromLocked,
    toWarehouseLocked: toLocked,
  })
  return { from, to }
}

async function transferOutCreate(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.transfer-outbound.create'
  const plantId = requireStr(p, 'plantId', command)
  await assertPlantScope(tools, plantId)
  const transferKindRaw = str(p, 'transferKind')
  if (transferKindRaw !== 'production' && transferKindRaw !== 'warehouse') {
    throw new ReverseRuleViolation('WR-07', "transferKind 必须为 'production'（生产调拨）或 'warehouse'（仓库调拨）")
  }
  const fromWarehouseId = requireStr(p, 'fromWarehouseId', command)
  const toWarehouseId = requireStr(p, 'toWarehouseId', command)
  const relatedOrderNo = str(p, 'relatedOrderNo')
  if (transferKindRaw === 'warehouse' && relatedOrderNo !== undefined) {
    throw new ReverseRuleViolation('WR-07', '关联订单编号仅生产调拨可填（仓库调拨不可关联订单编号）')
  }
  const linesPayload = p['lines']
  if (!Array.isArray(linesPayload) || linesPayload.length === 0) {
    throw new ReverseRuleViolation('WR-07', '调拨单至少一行料品明细（计划调出数量）')
  }
  const lines = linesPayload.map((raw, index) => {
    const l = (raw ?? {}) as Payload
    const materialId = str(l, 'materialId')
    const plannedQty = dec(l, 'plannedQty')
    if (materialId === undefined || plannedQty === undefined || !isPositiveQty(plannedQty)) {
      throw new ReverseRuleViolation('WR-07', `第 ${index + 1} 行缺少 materialId 或 plannedQty（正十进制定点字符串）`)
    }
    return { materialId, plannedQty, materialCode: str(l, 'materialCode') ?? '' }
  })
  const resolvedLines = []
  for (const line of lines) {
    const material = await tools.rv.materials.findById(line.materialId)
    if (material === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `料品 ${line.materialId} 不存在`)
    resolvedLines.push({ ...line, materialCode: material.code, materialType: material.materialType })
  }
  const warehouses = await assertOutboundWarehouseRules(tools, {
    transferKind: transferKindRaw,
    fromWarehouseId,
    toWarehouseId,
    lineMaterialIds: resolvedLines.map((l) => l.materialId),
    forCompletion: false,
  })
  const order = await tools.rv.outOrders.insert({
    orderNo: genNo('TO'),
    sourceKind: 'web_task',
    transferKind: transferKindRaw,
    relatedOrderNo: relatedOrderNo ?? null,
    fromWarehouseId,
    toWarehouseId,
    fromWarehouseCode: warehouses.from.code,
    toWarehouseCode: warehouses.to.code,
    fromWarehouseType: warehouses.from.warehouseType,
    toWarehouseType: warehouses.to.warehouseType,
    note: str(p, 'note') ?? null,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  const planLines = await tools.rv.outPlanLines.insert(
    resolvedLines.map((l, index) => ({
      orderId: order.id,
      lineNo: index + 1,
      materialId: l.materialId,
      materialCode: l.materialCode,
      materialType: l.materialType,
      plannedQty: l.plannedQty,
      createdBy: pc.ctx.actorLoginName,
    })),
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'transfer_outbound_order',
    subjectId: order.id,
    after: { orderNo: order.orderNo, transferKind: transferKindRaw, lines: planLines.length, status: order.status },
    reason: str(p, 'reason') ?? null,
  })
  return { orderId: order.id, orderNo: order.orderNo, status: order.status, lines: planLines.length }
}

async function transferOutUpdate(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.transfer-outbound.update'
  const orderId = requireStr(p, 'orderId', command)
  const order = await tools.rv.outOrders.lockById(orderId)
  if (order === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '调拨单不存在')
  await assertPlantScope(tools, order.plantId)
  const scans = await tools.rv.outScans.listByOrder(orderId)
  assertOutboundOrderEditable({
    orderNo: order.orderNo,
    sourceKind: order.sourceKind,
    status: order.status,
    scannedCount: scans.filter((s) => s.status === 'loaded').length,
    action: 'edit',
  })
  const linesPayload = p['lines']
  if (!Array.isArray(linesPayload) || linesPayload.length === 0) {
    throw new ReverseRuleViolation('WR-08', '编辑载荷至少一行料品明细（按料品比对明细增删改）')
  }
  const resolvedLines = []
  for (const raw of linesPayload) {
    const l = (raw ?? {}) as Payload
    const materialId = str(l, 'materialId')
    const plannedQty = dec(l, 'plannedQty')
    if (materialId === undefined || plannedQty === undefined || !isPositiveQty(plannedQty)) {
      throw new ReverseRuleViolation('WR-08', '明细行缺少 materialId 或 plannedQty（正十进制定点字符串）')
    }
    const material = await tools.rv.materials.findById(materialId)
    if (material === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `料品 ${materialId} 不存在`)
    resolvedLines.push({ materialId, materialCode: material.code, materialType: material.materialType, plannedQty })
  }
  await assertOutboundWarehouseRules(tools, {
    transferKind: order.transferKind,
    fromWarehouseId: order.fromWarehouseId,
    toWarehouseId: order.toWarehouseId,
    lineMaterialIds: resolvedLines.map((l) => l.materialId),
    forCompletion: false,
  })
  const planLines = await tools.rv.outPlanLines.replaceOrderLines(
    orderId,
    resolvedLines.map((l, index) => ({
      orderId,
      lineNo: index + 1,
      materialId: l.materialId,
      materialCode: l.materialCode,
      materialType: l.materialType,
      plannedQty: l.plannedQty,
      createdBy: pc.ctx.actorLoginName,
    })),
    pc.ctx.actorLoginName,
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'transfer_outbound_order',
    subjectId: orderId,
    before: { status: order.status },
    after: { lines: planLines.length },
    reason: str(p, 'reason') ?? null,
  })
  return { orderId, lines: planLines.length }
}

async function transferOutDelete(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.transfer-outbound.delete'
  const idsPayload = p['orderIds']
  if (!Array.isArray(idsPayload) || idsPayload.length === 0) {
    throw new ReverseRuleViolation('WR-08', `${command}：orderIds 须为非空数组（批量删除）`)
  }
  const orders: TransferOutboundOrderRecord[] = []
  for (const raw of idsPayload) {
    const id = typeof raw === 'string' ? raw : undefined
    if (id === undefined) throw new ReverseRuleViolation('WR-08', 'orderIds 元素须为字符串')
    const order = await tools.rv.outOrders.lockById(id)
    if (order === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `调拨单 ${id} 不存在`)
    await assertPlantScope(tools, order.plantId)
    orders.push(order)
  }
  const scansByOrder = new Map<string, number>()
  for (const order of orders) {
    const scans = await tools.rv.outScans.listByOrder(order.id)
    scansByOrder.set(order.id, scans.filter((s) => s.status === 'loaded').length)
  }
  assertBatchDeletableAllOrNothing(
    orders.map((o) => ({
      orderNo: o.orderNo,
      sourceKind: o.sourceKind,
      status: o.status,
      scannedCount: scansByOrder.get(o.id) ?? 0,
    })),
  )
  for (const order of orders) {
    await tools.rv.outOrders.updateStatus(order.id, { status: 'cancelled' }, pc.ctx.actorLoginName)
  }
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'transfer_outbound_order',
    subjectId: orders[0]!.id,
    after: { cancelled: orders.map((o) => o.orderNo) },
    reason: str(p, 'reason') ?? null,
  })
  return { cancelled: orders.map((o) => o.orderNo) }
}

/** 调拨出库扫码（WR-07② 无任务首扫建单 / WR-09 校验 / WR-10 整码 / 锁定=作业预留）。 */
async function transferOutScan(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.transfer-outbound.scan'
  const plantId = requireStr(p, 'plantId', command)
  await assertPlantScope(tools, plantId)
  const unitNo = requireStr(p, 'unitNo', command)
  const unit = await tools.inv.units.findByUnitNo(plantId, unitNo)
  if (unit === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `库存单元 ${unitNo} 不存在`)
  const balance = await singleActiveBalance(tools, unit.id)

  // 订单解析：orderId 显式（Web 有任务/PDA 续扫）或无任务首扫自动建单（WR-07②）
  let order: TransferOutboundOrderRecord | null
  if (str(p, 'orderId') !== undefined) {
    order = await tools.rv.outOrders.lockById(str(p, 'orderId')!)
    if (order === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '调拨单不存在')
  } else {
    const toWarehouseId = requireStr(p, 'toWarehouseId', command)
    const fromLocation = await tools.rv.locations.findById(balance.locationId)
    if (fromLocation === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `单元 ${unitNo} 库位不存在`)
    const existing = await tools.rv.outOrders.findTasklessInProgressByOperator(pc.ctx.actorLoginName)
    assertTasklessSingleInProgress({
      operator: pc.ctx.actorLoginName,
      existingInProgress: existing === null ? null : { orderNo: existing.orderNo, status: existing.status },
    })
    const warehouses = await assertOutboundWarehouseRules(tools, {
      transferKind: 'warehouse',
      fromWarehouseId: fromLocation.warehouseId,
      toWarehouseId,
      lineMaterialIds: [unit.materialId],
      forCompletion: false,
    })
    order = await tools.rv.outOrders.insert({
      orderNo: genNo('TO'),
      sourceKind: 'pda_taskless',
      transferKind: 'warehouse',
      fromWarehouseId: fromLocation.warehouseId,
      toWarehouseId,
      fromWarehouseCode: warehouses.from.code,
      toWarehouseCode: warehouses.to.code,
      fromWarehouseType: warehouses.from.warehouseType,
      toWarehouseType: warehouses.to.warehouseType,
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
    await pc.tools.audit.record({
      actor: pc.ctx.actorLoginName,
      action: `${command}.auto-create`,
      subjectType: 'transfer_outbound_order',
      subjectId: order.id,
      after: { orderNo: order.orderNo, sourceKind: 'pda_taskless', fromWarehouseCode: warehouses.from.code },
      reason: 'PDA 无任务调拨首扫自动建单（调出仓库=该码所在仓库）',
    })
  }

  if (order.status !== 'pending_out' && order.status !== 'outbounding') {
    throw new ReverseRuleViolation('WR-13', `调拨单 ${order.orderNo}状态为 ${order.status}，仅 待出库/出库中 可扫码装入`)
  }
  // WR-24①：盘点锁定拦截调拨出库扫码（调出/调入仓库）
  await warehouseOpenFor(tools, order.fromWarehouseId, '调拨出库扫码', 'WR-09')
  await warehouseOpenFor(tools, order.toWarehouseId, '调拨出库扫码', 'WR-09')

  // 同单重复装入（库级 partial unique 双保险先行给出可解释拒绝）
  const alreadyLoaded = await tools.rv.outScans.findLoadedByUnit(order.id, unit.id)
  if (alreadyLoaded !== null) {
    throw new ReverseRuleViolation('WR-09', `单元 ${unitNo}已在本单装入（删码后可重装），拒绝重复装入`)
  }

  const fromLocation = await tools.rv.locations.findById(balance.locationId)
  const now = pc.tools.now().toISOString()
  const effective = (await effectiveReservations(tools, unit.id, now)).filter(
    (r) => r.holderRef !== `reverse.transfer-outbound:${order!.id}`,
  )
  const planLines = order.sourceKind === 'web_task' ? await tools.rv.outPlanLines.listByOrder(order.id) : []
  const materialPlan = planLines.find((l) => l.materialId === unit.materialId) ?? null
  if (order.sourceKind === 'web_task' && materialPlan === null) {
    throw new ReverseRuleViolation('WR-09', `单元 ${unitNo}的料品 ${unit.materialCode} 不在本单明细，拒绝装入`)
  }
  if (materialPlan !== null && cmpQty(addQty(materialPlan.outQty, balance.quantity), materialPlan.plannedQty) > 0) {
    throw new ReverseRuleViolation(
      'WR-09',
      `料品 ${unit.materialCode} 装入超出计划调出数量（计划 ${materialPlan.plannedQty}、已装 ${materialPlan.outQty}、本次 ${balance.quantity}）`,
    )
  }
  if (order.sourceKind === 'pda_taskless') {
    assertTasklessFromWarehouseConsistent({
      unitNo,
      unitWarehouseId: fromLocation?.warehouseId ?? '',
      orderFromWarehouseId: order.fromWarehouseId,
    })
  }
  assertTransferOutScanAcceptable({
    unitNo,
    notInStock: unit.status !== 'in_stock',
    qualityUnfinished: false, // 出库闸门单独断言（A-T12-4 参数化；GAP-D9 缺省严格）
    lockedByOtherTask: effective.length > 0,
    remainingQtyZero: cmpQty(balance.quantity, '0.0000') <= 0,
    materialNotInOrderDetail: false, // 有任务料品校验已先行（含计划上限）
    warehouseMismatch: fromLocation === null || fromLocation.warehouseId !== order.fromWarehouseId,
    warehouseLockedOrDisabled: false, // warehouseOpenFor 已先行（含盘点锁定）
    orderWarehouseLocked: false, // 同上
  })
  // 出库质量闸门（A-T12-4 参数化；GAP-D9 参数默认值待裁——缺省严格=不允许质检未完成出库）
  assertOutboundQualityGate({ qualityStatus: balance.qualityStatus, unitNo, action: '调拨出库' })

  // WR-10：整码调出（CA-7 裁定前不实现部分调出）
  const outQty = assertWholeCodeOutbound({ unitNo, remainingQty: balance.quantity, requestedOutQty: dec(p, 'outQty') })

  // 装入成功即锁定（动作=调拨出库，作业预留含有效期，IT-23）
  const validUntil = str(p, 'validUntil') ?? new Date(Date.parse(now) + 4 * 3600_000).toISOString()
  const reservation = await acquireReservation(pc, {
    unitId: unit.id,
    quantity: outQty,
    holderType: 'order',
    holderRef: `reverse.transfer-outbound:${order.id}`,
    validUntil,
    locationId: balance.locationId,
    reason: `调拨出库锁定（单号 ${order.orderNo}）`,
  })

  const scans = await tools.rv.outScans.listByOrder(order.id)
  const scan = await tools.rv.outScans.insert({
    orderId: order.id,
    lineNo: scans.length + 1,
    inventoryUnitId: unit.id,
    unitNo,
    materialId: unit.materialId,
    materialCode: unit.materialCode,
    materialType: (await tools.rv.materials.findTypeById(unit.materialId)) ?? null,
    fromLocationId: balance.locationId,
    fromLocationCode: balance.locationCode,
    quantity: balance.quantity,
    outQty,
    reservationId: String(reservation['reservationId'] ?? '') || null,
    scannedBy: pc.ctx.actorLoginName,
    scannedAt: pc.businessTime,
    commandReceiptId: pc.commandReceiptId,
  })
  if (materialPlan !== null) {
    await tools.rv.outPlanLines.addOutQty(order.id, unit.materialId, outQty, pc.ctx.actorLoginName)
  }
  if (order.status === 'pending_out') {
    assertTransferOutStep('pending_out', 'outbounding')
    await tools.rv.outOrders.updateStatus(order.id, { status: 'outbounding' }, pc.ctx.actorLoginName)
  }
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'transfer_outbound_order',
    subjectId: order.id,
    after: { unitNo, outQty, reservationId: reservation['reservationId'] ?? null, status: 'outbounding' },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'transfer_outbound_order',
    aggregateId: order.id,
    taskKind: 'reverse.transfer-outbound-scanned',
    payload: { orderNo: order.orderNo, unitNo, outQty, businessTime: pc.businessTime },
  })
  return { orderId: order.id, orderNo: order.orderNo, scanId: scan.id, unitNo, outQty, reservationId: reservation['reservationId'] ?? null }
}

async function transferOutRemoveScan(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.transfer-outbound.remove-scan'
  const orderId = requireStr(p, 'orderId', command)
  const unitNo = requireStr(p, 'unitNo', command)
  const order = await tools.rv.outOrders.lockById(orderId)
  if (order === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '调拨单不存在')
  await assertPlantScope(tools, order.plantId)
  if (order.status !== 'outbounding' && order.status !== 'pending_out') {
    throw new ReverseRuleViolation('WR-13', `调拨单 ${order.orderNo}状态为 ${order.status}，仅 出库中 可删码`)
  }
  const unit = await tools.inv.units.findByUnitNo(order.plantId, unitNo)
  if (unit === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `库存单元 ${unitNo} 不存在`)
  const scan = await tools.rv.outScans.findLoadedByUnit(orderId, unit.id)
  if (scan === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `单元 ${unitNo} 在本单无活动装入记录`)
  if (scan.reservationId !== null) {
    const reservation = await tools.inv.reservations.findById(scan.reservationId)
    if (reservation !== null && reservation.status === 'active') {
      await tools.inv.reservations.release(scan.reservationId, pc.ctx.actorLoginName, '调拨出库删码解除锁定', pc.tools.now().toISOString())
    }
  }
  await tools.rv.outScans.markRemoved(scan.id, pc.ctx.actorLoginName, pc.businessTime)
  if (scan.materialId !== null) {
    await tools.rv.outPlanLines.addOutQty(orderId, scan.materialId, `-${scan.outQty}`, pc.ctx.actorLoginName)
  }
  // WR-13：删码删空后状态回待出库
  const remaining = (await tools.rv.outScans.listByOrder(orderId)).filter((s) => s.status === 'loaded')
  if (remaining.length === 0 && order.status === 'outbounding') {
    assertTransferOutStep('outbounding', 'pending_out')
    await tools.rv.outOrders.updateStatus(orderId, { status: 'pending_out' }, pc.ctx.actorLoginName)
  }
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'transfer_outbound_order',
    subjectId: orderId,
    after: { unitNo, remainingLoaded: remaining.length },
    reason: str(p, 'reason') ?? null,
  })
  return { orderId, unitNo, removed: true, remainingLoaded: remaining.length }
}

/** 完成出库（WR-11/12/14：两段原子、固定库位即时转仓 vs 在途+待入库；跨厂必须独立接收事实）。 */
async function transferOutComplete(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.transfer-outbound.complete'
  const orderId = requireStr(p, 'orderId', command)
  const order = await tools.rv.outOrders.lockById(orderId)
  if (order === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '调拨单不存在')
  await assertPlantScope(tools, order.plantId)
  if (order.status !== 'outbounding' && order.status !== 'pending_out') {
    throw new ReverseRuleViolation('WR-13', `调拨单 ${order.orderNo}状态为 ${order.status}，仅 待出库/出库中 可完成出库`)
  }
  const scans = (await tools.rv.outScans.listByOrder(orderId)).filter((s) => s.status === 'loaded')
  const toWh = await tools.rv.warehouses.findById(order.toWarehouseId)
  if (toWh === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '调入仓库不存在')
  const fromWh = await tools.rv.warehouses.findById(order.fromWarehouseId)
  if (fromWh === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '调出仓库不存在')
  const toLocationId = str(p, 'toLocationId')
  const hasRack = await tools.rv.warehouses.hasRackLocations(order.toWarehouseId)
  // WR-14：跨厂走独立接收（在途）——豁免"有货架层数未选"拒绝（WR-11 后段：未选 → 码变在途）
  assertOutboundCompletable({
    orderNo: order.orderNo,
    loadedScanCount: scans.length,
    toWarehouseHasRack: hasRack,
    toLocationId,
    crossPlant: !isSamePlantImmediateTransfer(fromWh.plantId, toWh.plantId),
  })

  // WR-06 完成出库复校（仓库类型规则＋锁定）＋ WR-24① 盘点拦截（调拨出库完成）
  await assertOutboundWarehouseRules(tools, {
    transferKind: order.transferKind,
    fromWarehouseId: order.fromWarehouseId,
    toWarehouseId: order.toWarehouseId,
    lineMaterialIds: scans.map((s) => s.materialId ?? '').filter((id) => id !== ''),
    forCompletion: true,
  })
  await warehouseOpenFor(tools, order.fromWarehouseId, '调拨出库完成', 'WR-06')
  await warehouseOpenFor(tools, order.toWarehouseId, '调拨出库完成', 'WR-06')

  let resolvedToLocation: { id: string; code: string } | null = null
  if (toLocationId !== undefined) {
    const location = await tools.rv.locations.findById(toLocationId)
    if (location === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '调入库位不存在')
    if (location.warehouseId !== order.toWarehouseId) {
      throw new ReverseRuleViolation('WR-11', '调入库位不属于调入仓库，拒绝完成出库')
    }
    resolvedToLocation = { id: location.id, code: location.code }
  }

  // WR-14：路径判定——固定库位即时完成仅限厂内即时转仓；跨厂必须独立接收事实
  const samePlant = isSamePlantImmediateTransfer(fromWh.plantId, toWh.plantId)
  const fixedPath = resolvedToLocation !== null && samePlant
  if (resolvedToLocation !== null && !samePlant) {
    // 跨厂：显式拒绝以固定库位冒充签收（入库单以待入库生成，接收方扫码上架/签收）
    assertCrossPlantNeedsIndependentReceipt({ fromPlantId: fromWh.plantId, toPlantId: toWh.plantId, orderNo: order.orderNo })
  }
  let transitLocation: { id: string; code: string } | null = null
  if (!fixedPath) {
    const transitLocationId = str(p, 'transitLocationId') ?? order.transitLocationId ?? undefined
    if (transitLocationId === undefined) {
      throw new ReverseRuleViolation('WR-11', '未选调入库位（或跨厂调拨）时必须指定在途库位（transitLocationId）才可完成出库')
    }
    const location = await tools.rv.locations.findById(transitLocationId)
    if (location === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '在途库位不存在')
    transitLocation = { id: location.id, code: location.code }
  }

  // 锁单元（IT-25 稳定次序）
  const locked = await tools.inv.units.lockForUpdate(ensureStableLockOrder(scans.map((s) => s.inventoryUnitId)))
  const unitMap = new Map(locked.map((u) => [u.id, u]))

  let lineNo = 1
  const movedUnits: string[] = []
  if (fixedPath) {
    // 厂内即时转仓：直接移到调入库位（变为在库、托码关系保留——载具绑定不受移位影响）
    for (const scan of scans) {
      const unit = unitMap.get(scan.inventoryUnitId)!
      const from = await singleActiveBalance(tools, unit.id)
      await moveStock(pc, {
        unitId: unit.id,
        quantity: scan.outQty,
        fromLocationId: from.locationId,
        fromOwnerId: from.ownerId,
        toLocationId: resolvedToLocation!.id,
        toLocationCode: resolvedToLocation!.code,
        lineNoBase: lineNo,
        reason: `调拨出库完成（厂内即时转仓，单号 ${order.orderNo}）`,
        refType: 'transfer_outbound_order',
        refId: order.id,
      })
      lineNo += 2
      movedUnits.push(unit.unitNo)
    }
  } else {
    // 在途路径：来源减＋在途增（IT-13 在途）；码变为已出库（在途）并解锁
    for (const scan of scans) {
      const unit = unitMap.get(scan.inventoryUnitId)!
      const from = await singleActiveBalance(tools, unit.id)
      await transferOutUnitLine(pc, {
        unit,
        from,
        transitLocationId: transitLocation!.id,
        transitLocationCode: transitLocation!.code,
        quantity: scan.outQty,
        lineNo,
        reason: `调拨出库完成（在途，单号 ${order.orderNo}）`,
        refType: 'transfer_outbound_order',
        refId: order.id,
      })
      lineNo += 2
      if (scan.reservationId !== null) {
        const reservation = await tools.inv.reservations.findById(scan.reservationId)
        if (reservation !== null && reservation.status === 'active') {
          await tools.inv.reservations.release(scan.reservationId, pc.ctx.actorLoginName, '调拨出库完成（码变在途并解锁）', pc.tools.now().toISOString())
        }
      }
      movedUnits.push(unit.unitNo)
    }
  }

  // 生成调拨入库单（WR-S3/WR-14）；码入库状态列＝上架状态快照（固定库位=已入库；扫码上架=待入库）
  const inboundOrder = await tools.rv.inOrders.insert({
    orderNo: genNo('TI'),
    outboundOrderId: order.id,
    inboundMode: fixedPath ? 'fixed_location' : 'scan_putaway',
    status: fixedPath ? 'completed' : 'pending_in',
    fromWarehouseId: order.fromWarehouseId,
    toWarehouseId: order.toWarehouseId,
    fromWarehouseCode: order.fromWarehouseCode,
    toWarehouseCode: order.toWarehouseCode,
    suggestedLocationId: resolvedToLocation?.id ?? null,
    suggestedLocationCode: resolvedToLocation?.code ?? null,
    shipperSnapshotBy: fixedPath ? pc.ctx.actorLoginName : null,
    shipperSnapshotAt: fixedPath ? pc.businessTime : null,
    completedAt: fixedPath ? pc.businessTime : null,
    commandReceiptId: pc.commandReceiptId,
    plantId: toWh.plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  // 托码关系保留（WR-11）：入库行 is_pallet_child 按载具绑定实时判定（tray 载具成员）
  const palletChildByUnit = new Map<string, boolean>()
  for (const scan of scans) {
    const tray = await trayMembership(tools, scan.inventoryUnitId)
    palletChildByUnit.set(scan.inventoryUnitId, tray !== null)
  }
  await tools.rv.inLines.insert(
    scans.map((scan, index) => ({
      orderId: inboundOrder.id,
      lineNo: index + 1,
      inventoryUnitId: scan.inventoryUnitId,
      unitNo: scan.unitNo,
      materialId: scan.materialId,
      materialCode: scan.materialCode,
      quantity: scan.outQty,
      isPalletChild: palletChildByUnit.get(scan.inventoryUnitId) ?? false,
      locationId: fixedPath ? resolvedToLocation!.id : null,
      locationCode: fixedPath ? resolvedToLocation!.code : null,
      lineStatus: fixedPath ? ('inbound' as const) : ('pending' as const),
      inboundAt: fixedPath ? pc.businessTime : null,
      createdBy: pc.ctx.actorLoginName,
    })),
  )

  // 出库单收口（WR-11：状态=已出库、记出库人员/完成时间/调入库位/库位类型）
  if (order.status !== 'outbounding') {
    throw new ReverseRuleViolation('WR-13', `调拨单 ${order.orderNo}状态为 ${order.status}：完成出库前须至少一码装入（出库中）`)
  }
  assertTransferOutStep('outbounding', 'outbounded')
  await tools.rv.outOrders.updateStatus(
    orderId,
    {
      status: 'outbounded',
      toLocationId: resolvedToLocation?.id ?? null,
      toLocationCode: resolvedToLocation?.code ?? null,
      toLocationKind: resolvedToLocation !== null ? (hasRack ? 'RACK' : 'NORMAL') : null,
      // 在途路径回写在途库位（WR-12：调拨入库完成时按此对账"在途减"）
      transitLocationId: transitLocation?.id ?? null,
      shippedBy: pc.ctx.actorLoginName,
      shippedAt: pc.businessTime,
    },
    pc.ctx.actorLoginName,
  )

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'transfer_outbound_order',
    subjectId: orderId,
    before: { status: order.status },
    after: {
      status: 'outbounded',
      inboundOrderId: inboundOrder.id,
      inboundMode: inboundOrder.inboundMode,
      units: movedUnits.length,
    },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'transfer_outbound_order',
    aggregateId: orderId,
    taskKind: 'reverse.transfer-outbound-completed',
    payload: {
      orderNo: order.orderNo,
      inboundOrderNo: inboundOrder.orderNo,
      inboundMode: inboundOrder.inboundMode,
      units: movedUnits,
      businessTime: pc.businessTime,
    },
  })
  return {
    orderId,
    orderNo: order.orderNo,
    status: 'outbounded',
    inboundOrderId: inboundOrder.id,
    inboundOrderNo: inboundOrder.orderNo,
    inboundMode: inboundOrder.inboundMode,
    movedUnits,
  }
}

/** WR-07③ 其它模块自动生成（成品入库/采购入库转仓）：生成即已出库（固定库位即时路径直执行）。 */
async function transferOutAutoGenerate(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.transfer-outbound.auto-generate'
  const plantId = requireStr(p, 'plantId', command)
  await assertPlantScope(tools, plantId)
  const fromWarehouseId = requireStr(p, 'fromWarehouseId', command)
  const toWarehouseId = requireStr(p, 'toWarehouseId', command)
  const toLocationId = requireStr(p, 'toLocationId', command)
  const unitNosPayload = p['unitNos']
  if (!Array.isArray(unitNosPayload) || unitNosPayload.length === 0) {
    throw new ReverseRuleViolation('WR-07', `${command}：unitNos 须为非空数组`)
  }
  const units: InventoryUnitRecord[] = []
  for (const raw of unitNosPayload) {
    const unitNo = typeof raw === 'string' ? raw : undefined
    if (unitNo === undefined) throw new ReverseRuleViolation('WR-07', 'unitNos 元素须为字符串')
    const unit = await tools.inv.units.findByUnitNo(plantId, unitNo)
    if (unit === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `库存单元 ${unitNo} 不存在`)
    units.push(unit)
  }
  await assertOutboundWarehouseRules(tools, {
    transferKind: 'warehouse',
    fromWarehouseId,
    toWarehouseId,
    lineMaterialIds: units.map((u) => u.materialId),
    forCompletion: false,
  })
  await warehouseOpenFor(tools, fromWarehouseId, '调拨出库自动生成', 'WR-06')
  await warehouseOpenFor(tools, toWarehouseId, '调拨出库自动生成', 'WR-06')
  const toLocation = await tools.rv.locations.findById(toLocationId)
  if (toLocation === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '调入库位不存在')
  if (toLocation.warehouseId !== toWarehouseId) {
    throw new ReverseRuleViolation('WR-11', '调入库位不属于调入仓库，拒绝自动生成')
  }
  const order = await tools.rv.outOrders.insert({
    orderNo: genNo('TO'),
    sourceKind: 'auto',
    transferKind: 'warehouse',
    fromWarehouseId,
    toWarehouseId,
    toLocationId,
    toLocationCode: toLocation.code,
    status: 'outbounded',
    shippedBy: pc.ctx.actorLoginName,
    shippedAt: pc.businessTime,
    note: str(p, 'note') ?? '其它模块自动生成（成品入库/采购入库转仓，生成即已出库）',
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  const locked = await tools.inv.units.lockForUpdate(ensureStableLockOrder(units.map((u) => u.id)))
  const unitMap = new Map(locked.map((u) => [u.id, u]))
  let lineNo = 1
  const scanInputs: Array<{ unit: InventoryUnitRecord; outQty: string }> = []
  for (const unit of units) {
    const live = unitMap.get(unit.id)!
    const from = await singleActiveBalance(tools, unit.id)
    await moveStock(pc, {
      unitId: unit.id,
      quantity: from.quantity,
      fromLocationId: from.locationId,
      fromOwnerId: from.ownerId,
      toLocationId,
      toLocationCode: toLocation.code,
      lineNoBase: lineNo,
      reason: `自动调拨（单号 ${order.orderNo}：生成即已出库）`,
      refType: 'transfer_outbound_order',
      refId: order.id,
    })
    lineNo += 2
    scanInputs.push({ unit: live, outQty: from.quantity })
  }
  await tools.rv.outScans.insertMany(
    scanInputs.map((s, index) => ({
      orderId: order.id,
      lineNo: index + 1,
      inventoryUnitId: s.unit.id,
      unitNo: s.unit.unitNo,
      materialId: s.unit.materialId,
      materialCode: s.unit.materialCode,
      fromLocationCode: null,
      quantity: s.outQty,
      outQty: s.outQty,
      scannedBy: pc.ctx.actorLoginName,
      scannedAt: pc.businessTime,
      commandReceiptId: pc.commandReceiptId,
    })),
  )
  const inboundOrder = await tools.rv.inOrders.insert({
    orderNo: genNo('TI'),
    outboundOrderId: order.id,
    inboundMode: 'fixed_location',
    status: 'completed',
    fromWarehouseId,
    toWarehouseId,
    suggestedLocationId: toLocationId,
    suggestedLocationCode: toLocation.code,
    shipperSnapshotBy: pc.ctx.actorLoginName,
    shipperSnapshotAt: pc.businessTime,
    completedAt: pc.businessTime,
    commandReceiptId: pc.commandReceiptId,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  await tools.rv.inLines.insert(
    scanInputs.map((s, index) => ({
      orderId: inboundOrder.id,
      lineNo: index + 1,
      inventoryUnitId: s.unit.id,
      unitNo: s.unit.unitNo,
      materialId: s.unit.materialId,
      materialCode: s.unit.materialCode,
      quantity: s.outQty,
      locationId: toLocationId,
      locationCode: toLocation.code,
      lineStatus: 'inbound' as const,
      inboundAt: pc.businessTime,
      createdBy: pc.ctx.actorLoginName,
    })),
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'transfer_outbound_order',
    subjectId: order.id,
    after: { orderNo: order.orderNo, sourceKind: 'auto', status: 'outbounded', inboundOrderNo: inboundOrder.orderNo },
    reason: str(p, 'reason') ?? null,
  })
  return { orderId: order.id, orderNo: order.orderNo, status: order.status, inboundOrderNo: inboundOrder.orderNo }
}

// ---------------- 命令：调拨入库与跨厂签收（WR-14～17） ----------------

/** Authorize custody receipt at the actual destination, then bind it to the
 * completed dispatch. A receiver needs no source-factory write grant. */
async function receiptHandoff(pc: PostingContext, order: TransferInboundOrderRecord) {
  const tools = rvTools(pc)
  await assertObjectWriteScope(tools, pc.ctx, order, 'reverse.post', message => new ReverseRuleViolation('A-S1', message))
  const toWarehouse = await warehouseOpenFor(tools, order.toWarehouseId, '调拨入库', 'WR-17')
  const fromWarehouse = await tools.rv.warehouses.findById(order.fromWarehouseId)
  const outbound = await tools.rv.outOrders.findById(order.outboundOrderId)
  if (order.inboundMode !== 'scan_putaway' || toWarehouse.status !== 'active' ||
      toWarehouse.plantId !== order.plantId || toWarehouse.enterpriseId !== order.enterpriseId ||
      fromWarehouse === null || fromWarehouse.enterpriseId !== order.enterpriseId ||
      outbound === null || outbound.status !== 'outbounded' || outbound.enterpriseId !== order.enterpriseId ||
      outbound.plantId !== fromWarehouse.plantId || outbound.fromWarehouseId !== order.fromWarehouseId ||
      outbound.toWarehouseId !== order.toWarehouseId || outbound.transitLocationId === null) {
    throw new ReverseRuleViolation('WR-17', '调入单、实际调入厂与已完成调出交接事实不一致')
  }
  const transitLocation = await tools.rv.locations.findById(outbound.transitLocationId)
  if (transitLocation === null || transitLocation.plantId !== fromWarehouse.plantId) {
    throw new ReverseRuleViolation('WR-17', '调出在途库位与源厂保管身份不一致')
  }
  const lines = await tools.rv.inLines.listByOrder(order.id)
  const scans = (await tools.rv.outScans.listByOrder(outbound.id)).filter(scan => scan.status === 'loaded')
  if (lines.length === 0 || lines.length !== scans.length ||
      new Set(lines.map(line => line.inventoryUnitId)).size !== lines.length ||
      new Set(scans.map(scan => scan.inventoryUnitId)).size !== scans.length ||
      lines.some(line => line.orderId !== order.id || !isPositiveQty(line.quantity) ||
        !scans.some(scan => scan.inventoryUnitId === line.inventoryUnitId && scan.unitNo === line.unitNo &&
          scan.materialId === line.materialId && cmpQty(scan.outQty, line.quantity) === 0))) {
    throw new ReverseRuleViolation('WR-17', '入库实物清单必须与调出清单逐码、逐料、全量对应，且不得重复')
  }
  return { toWarehouse, fromWarehouse, outbound, lines }
}

async function receiptBalance(pc: PostingContext, order: TransferInboundOrderRecord,
  handoff: Awaited<ReturnType<typeof receiptHandoff>>, line: TransferInboundLineRecord,
  unit: InventoryUnitRecord | undefined, forRemoval = false): Promise<StockBalanceRecord> {
  const tools = rvTools(pc)
  if (unit === undefined || unit.enterpriseId !== order.enterpriseId || unit.plantId !== handoff.fromWarehouse.plantId ||
      unit.status !== 'in_transit' || unit.unitNo !== line.unitNo || unit.materialId !== line.materialId) {
    throw new ReverseRuleViolation('WR-17', '接收单元不是本次交接的源厂在途实物')
  }
  const balances = await tools.inv.balances.listActiveByUnit(unit.id)
  const balance = balances.length === 1 ? balances[0]! : null
  if (balance === null || balance.locationId !== handoff.outbound.transitLocationId ||
      balance.enterpriseId !== unit.enterpriseId || balance.plantId !== unit.plantId ||
      cmpQty(balance.quantity, line.quantity) !== 0 ||
      !await tools.inv.units.isTransferOutBalance(unit.id, balance.id, unit.plantId)) {
    throw new ReverseRuleViolation('WR-17', '接收数量、在途余额或调出流水与实物交接不一致')
  }
  if (!forRemoval && (await tools.inv.units.businessHolds(unit.id)).length > 0) {
    throw new ReverseRuleViolation('WR-17', '在途实物仍有业务锁定，不可接收')
  }
  if (!forRemoval) assertOutboundQualityGate({ qualityStatus: balance.qualityStatus, unitNo: unit.unitNo, action: '调拨接收' })
  return balance
}

async function receiptLocation(pc: PostingContext, order: TransferInboundOrderRecord, locationId: string | null) {
  const location = locationId === null ? null : await rvTools(pc).rv.locations.findById(locationId)
  if (location === null || location.status !== 'active' || location.plantId !== order.plantId || location.warehouseId !== order.toWarehouseId) {
    throw new ReverseRuleViolation('WR-17', '接收库位必须属于实际调入厂、调入仓库且活动')
  }
  return location
}

async function checkReceiptReservation(pc: PostingContext, order: TransferInboundOrderRecord,
  line: TransferInboundLineRecord, balance: StockBalanceRecord, forRemoval = false) {
  const inv = pc.tools.inv
  const own = line.reservationId === null ? null : await inv.reservations.findById(line.reservationId)
  if (own === null || own.unitId !== line.inventoryUnitId || own.locationId !== balance.locationId ||
      own.enterpriseId !== order.enterpriseId || own.plantId !== balance.plantId || own.holderType !== 'order' ||
      own.holderRef !== `reverse.transfer-inbound:${order.id}` || cmpQty(own.quantity, line.quantity) !== 0 ||
      own.uomId !== balance.uomId || own.uomCode !== balance.uomCode ||
      (own.status !== 'active' && !(forRemoval && own.status === 'expired')) ||
      (!forRemoval && Date.parse(own.validUntil) <= pc.tools.now().getTime())) {
    throw new ReverseRuleViolation('WR-17', '接收预留身份与本单在途实物不一致')
  }
  const now = pc.tools.now().getTime()
  const other = (await inv.reservations.listActiveByUnit(line.inventoryUnitId))
    .some(row => row.id !== own.id && row.status === 'active' && Date.parse(row.validUntil) > now)
  if (!forRemoval && other) throw new ReverseRuleViolation('WR-17', '在途实物已有其它活动预留，不可接收')
  return own
}

/** 扫码上架（WR-15：记仓库/货架/库位并锁定（动作=调拨入库）、单据状态变入库中——不移库存）。 */
async function transferInScanPutaway(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.transfer-inbound.scan-putaway'
  const orderId = requireStr(p, 'orderId', command)
  const order = await tools.rv.inOrders.lockById(orderId)
  if (order === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '调拨入库单不存在')
  if (order.status !== 'pending_in' && order.status !== 'inbounding') {
    throw new ReverseRuleViolation('WR-15', `调拨入库单 ${order.orderNo}状态为 ${order.status}，仅 待入库/入库中 可扫码上架`)
  }
  if (order.inboundMode === 'fixed_location') {
    throw new ReverseRuleViolation('WR-15', `调拨入库单 ${order.orderNo}为固定库位完成单（厂内即时转仓）：无需扫码上架`)
  }
  const handoff = await receiptHandoff(pc, order)
  const { toWarehouse } = handoff

  // 目标行解析：单品码 / 托码（整托上架）
  const lines = handoff.lines
  const unitNo = str(p, 'unitNo')
  const palletCode = str(p, 'palletCode')
  let targetLines = []
  if (unitNo !== undefined) {
    const line = lines.find((l) => l.unitNo === unitNo)
    if (line === undefined) throw new ReverseRuleViolation('WR-15', `单元 ${unitNo} 不在本调拨入库单，拒绝上架`)
    targetLines = [line]
  } else if (palletCode !== undefined) {
    for (const line of lines.filter((l) => l.lineStatus === 'pending')) {
      const tray = await trayMembership(tools, line.inventoryUnitId)
      if (tray !== null && tray.carrierCode === palletCode) targetLines.push(line)
    }
    if (targetLines.length === 0) {
      throw new ReverseRuleViolation(NOT_FOUND_RULE, `托码 ${palletCode} 下无本单待入库码`)
    }
  } else {
    throw new ReverseRuleViolation('WR-01', `${command}：unitNo 与 palletCode 必填其一`)
  }

  // 库位解析（WR-15：仓库类型须选库位=库位编码或货架编码+两位层数；线边仓直接上架不选）
  const locationCode = str(p, 'locationCode')
  if (toWarehouse.warehouseType !== 'LINE_SIDE') {
    assertPutawayLocationInput({ orderNo: order.orderNo, toWarehouseKind: toWarehouse.warehouseType, locationCode })
  }
  let location: { id: string; code: string } | null = null
  if (locationCode !== undefined) {
    const found = await tools.rv.locations.findByCode(order.plantId, locationCode)
    if (found === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `库位 ${locationCode} 不存在`)
    if (found.warehouseId !== order.toWarehouseId) {
      throw new ReverseRuleViolation('WR-15', `库位 ${locationCode} 不属于调入仓库，拒绝上架`)
    }
    location = { id: found.id, code: found.code }
  } else {
    const actives = await tools.rv.locations.listActiveByWarehouse(order.toWarehouseId)
    if (actives.length === 1) location = { id: actives[0]!.id, code: actives[0]!.code }
    else if (actives.length > 1) {
      throw new ReverseRuleViolation('WR-15', '调入仓库存在多个库位：线边仓直接上架也须显式指定库位（locationCode）')
    } else {
      throw new ReverseRuleViolation(NOT_FOUND_RULE, '调入仓库无活动库位')
    }
  }

  await receiptLocation(pc, order, location!.id)
  const locked = await tools.inv.units.lockForUpdate(ensureStableLockOrder(targetLines.map(line => line.inventoryUnitId)))
  const unitMap = new Map(locked.map(unit => [unit.id, unit]))
  const now = pc.tools.now().toISOString()
  const putawayLineIds: string[] = []
  for (const line of targetLines) {
    const unit = unitMap.get(line.inventoryUnitId)
    const currentBalance = await receiptBalance(pc, order, handoff, line, unit)
    if (unit === undefined) throw new ReverseRuleViolation(NOT_FOUND_RULE, '接收单元不存在')
    const facts = {
      unitNo: line.unitNo,
      notInOrder: false,
      alreadyInboundInOrder: line.lineStatus === 'inbound',
      palletChildWithoutPalletScan: false,
      alreadyInStock: unit.status === 'in_stock',
      toWarehouseLocked: toWarehouse.status !== 'active',
    }
    if (line.isPalletChild && palletCode === undefined) {
      const tray = await trayMembership(tools, line.inventoryUnitId)
      facts.palletChildWithoutPalletScan = tray !== null
    }
    if (palletCode !== undefined && line.isPalletChild) {
      const tray = await trayMembership(tools, line.inventoryUnitId)
      if (tray === null || tray.carrierCode !== palletCode) {
        throw new ReverseRuleViolation('WR-15', `单元 ${line.unitNo} 不在托 ${palletCode} 上（托下单码须扫所在托），拒绝`)
      }
    }
    assertPutawayScanAcceptable(facts)
    // 锁定（动作=调拨入库，作业预留含有效期，IT-23）——预留挂单元当前（在途）余额：
    // 上架目标库位此刻尚无余额（WR-12 目的增在完成入库时发生），目的库位由入库行记录。
    const validUntil = str(p, 'validUntil') ?? new Date(Date.parse(now) + 4 * 3600_000).toISOString()
    const holderRef = `reverse.transfer-inbound:${orderId}`
    assertReservationAcquirable({ unitId: unit.id, holderType: 'order', holderRef, quantity: line.quantity, validUntil, now })
    if ((await tools.inv.reservations.listActiveByUnit(unit.id)).some(row => row.status === 'active' && Date.parse(row.validUntil) > Date.parse(now))) {
      throw new ReverseRuleViolation('WR-15', '在途实物已预留，不可重复接收')
    }
    // Dedicated handoff reservation: authority is the verified destination
    // order, while reservation custody remains at source until receipt commits.
    const reservation = await tools.inv.reservations.insert({
      unitId: unit.id, locationId: currentBalance.locationId, holderType: 'order', holderRef,
      quantity: line.quantity, validUntil, uomId: currentBalance.uomId, uomCode: currentBalance.uomCode,
      measurementBasis: currentBalance.measurementBasis, conversionRevisionId: currentBalance.conversionRevisionId,
      commandReceiptId: pc.commandReceiptId, plantId: unit.plantId, enterpriseId: unit.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
    const updated = await tools.rv.inLines.markPutaway(
      line.id,
      {
        lineStatus: 'inbound',
        locationId: location!.id,
        locationCode: location!.code,
        reservationId: reservation.id,
        inboundAt: pc.businessTime,
      },
      pc.ctx.actorLoginName,
    )
    putawayLineIds.push(updated?.id ?? line.id)
  }
  if (order.status === 'pending_in') {
    await tools.rv.inOrders.updateStatus(orderId, { status: 'inbounding' }, pc.ctx.actorLoginName)
  }
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'transfer_inbound_order',
    subjectId: orderId,
    after: { lines: putawayLineIds.length, locationCode: location!.code, receiver: pc.ctx.actorLoginName },
    reason: str(p, 'reason') ?? null,
  })
  return {
    orderId,
    orderNo: order.orderNo,
    status: 'inbounding',
    putawayLines: putawayLineIds.length,
    locationCode: location!.code,
    receiver: pc.ctx.actorLoginName,
  }
}

async function transferInRemoveScan(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.transfer-inbound.remove-scan'
  const orderId = requireStr(p, 'orderId', command)
  const unitNo = requireStr(p, 'unitNo', command)
  const order = await tools.rv.inOrders.lockById(orderId)
  if (order === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '调拨入库单不存在')
  if (order.status !== 'inbounding' && order.status !== 'pending_in') throw new ReverseRuleViolation('WR-16', '已完成接收不可删码重开')
  const handoff = await receiptHandoff(pc, order)
  const line = await tools.rv.inLines.findByUnitNo(orderId, unitNo)
  if (line === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `单元 ${unitNo} 不在本调拨入库单`)
  assertInboundScanRemovable({ unitNo, lineStatus: line.lineStatus })
  const reverted: string[] = [unitNo]
  // 托码连同托下码（同托成员一并退回未入库）
  const tray = await trayMembership(tools, line.inventoryUnitId)
  const lines = await tools.rv.inLines.listByOrder(orderId)
  const siblingIds: string[] = []
  if (tray !== null) {
    for (const other of lines) {
      if (other.id === line.id || other.lineStatus !== 'inbound') continue
      if (tray.memberUnitIds.includes(other.inventoryUnitId)) siblingIds.push(other.id)
    }
  }
  const releaseIds = [line.id, ...siblingIds]
  const locked = await tools.inv.units.lockForUpdate(ensureStableLockOrder(lines.filter(item => releaseIds.includes(item.id)).map(item => item.inventoryUnitId)))
  const unitMap = new Map(locked.map(unit => [unit.id, unit]))
  const releaseLine = async (lineId: string): Promise<void> => {
    const target = lines.find((l) => l.id === lineId)!
    const balance = await receiptBalance(pc, order, handoff, target, unitMap.get(target.inventoryUnitId), true)
    await checkReceiptReservation(pc, order, target, balance, true)
    if (target.reservationId !== null) {
      const reservation = await tools.inv.reservations.findById(target.reservationId)
      if (reservation !== null && reservation.status === 'active') {
        await tools.inv.reservations.release(target.reservationId, pc.ctx.actorLoginName, '调拨入库删码解除锁定', pc.tools.now().toISOString())
      }
    }
    await tools.rv.inLines.markReverted(lineId, pc.businessTime, pc.ctx.actorLoginName)
  }
  await releaseLine(line.id)
  for (const siblingId of siblingIds) {
    await releaseLine(siblingId)
    reverted.push(lines.find((l) => l.id === siblingId)!.unitNo)
  }
  // WR-16：本单已无已入库码时状态回待入库
  const after = await tools.rv.inLines.listByOrder(orderId)
  const newStatus = inboundStatusAfterRemoval(after.filter((l) => l.lineStatus === 'inbound').length)
  if (order.status !== newStatus) {
    await tools.rv.inOrders.updateStatus(orderId, { status: newStatus }, pc.ctx.actorLoginName)
  }
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'transfer_inbound_order',
    subjectId: orderId,
    after: { reverted, status: newStatus },
    reason: str(p, 'reason') ?? null,
  })
  return { orderId, reverted, status: newStatus }
}

/** 完成入库（WR-17：在途减＋目的增、变为在库并解除锁定、记入库人/时间=独立接收事实）。 */
async function transferInComplete(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.transfer-inbound.complete'
  const orderId = requireStr(p, 'orderId', command)
  const order = await tools.rv.inOrders.lockById(orderId)
  if (order === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '调拨入库单不存在')
  if (order.status !== 'inbounding' && order.status !== 'pending_in') {
    throw new ReverseRuleViolation('WR-17', `调拨入库单 ${order.orderNo}状态为 ${order.status}，仅 入库中 可完成入库`)
  }
  const handoff = await receiptHandoff(pc, order)
  const lines = handoff.lines
  // WR-17：每料品剩余未收数量必须为零（全部实物码已登记接收）。
  const byMaterial = new Map<string, { pendingQty: string; inboundQty: string }>()
  for (const line of lines) {
    const key = line.materialCode ?? line.unitNo
    const entry = byMaterial.get(key) ?? { pendingQty: '0.0000', inboundQty: '0.0000' }
    if (line.lineStatus === 'inbound') entry.inboundQty = addQty(entry.inboundQty, line.quantity)
    else entry.pendingQty = addQty(entry.pendingQty, line.quantity)
    byMaterial.set(key, entry)
  }
  assertInboundCompletable({
    orderNo: order.orderNo,
    lines: [...byMaterial.entries()].map(([materialCode, v]) => ({ materialCode, ...v })),
    toWarehouseLocked: false,
  })

  const inboundLines = lines.filter((l) => l.lineStatus === 'inbound')
  const locked = await tools.inv.units.lockForUpdate(ensureStableLockOrder(inboundLines.map((l) => l.inventoryUnitId)))
  const unitMap = new Map(locked.map((u) => [u.id, u]))
  let lineNo = 1
  const receivedUnits: string[] = []
  for (const line of inboundLines) {
    const unit = unitMap.get(line.inventoryUnitId)
    const transit = await receiptBalance(pc, order, handoff, line, unit)
    if (unit === undefined) throw new ReverseRuleViolation(NOT_FOUND_RULE, '接收单元不存在')
    await checkReceiptReservation(pc, order, line, transit)
    const location = await receiptLocation(pc, order, line.locationId)
    await transferInUnitLine(pc, {
      unit,
      transit,
      toLocationId: location.id,
      toLocationCode: location.code,
      toPlantId: handoff.toWarehouse.plantId,
      quantity: line.quantity,
      lineNo,
      reason: `调拨入库完成（单号 ${order.orderNo}）`,
      refType: 'transfer_inbound_order',
      refId: orderId,
    })
    lineNo += 2
    if (line.reservationId !== null) {
      const reservation = await tools.inv.reservations.findById(line.reservationId)
      if (reservation !== null && reservation.status === 'active') {
        await tools.inv.reservations.release(line.reservationId, pc.ctx.actorLoginName, '调拨入库完成（在库并解除锁定）', pc.tools.now().toISOString())
      }
    }
    receivedUnits.push(line.unitNo)
  }
  await tools.rv.inOrders.updateStatus(
    orderId,
    { status: 'completed', receivedBy: pc.ctx.actorLoginName, receivedAt: pc.businessTime, completedAt: pc.businessTime },
    pc.ctx.actorLoginName,
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'transfer_inbound_order',
    subjectId: orderId,
    before: { status: order.status },
    after: { status: 'completed', receivedUnits, receivedBy: pc.ctx.actorLoginName },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'transfer_inbound_order',
    aggregateId: orderId,
    taskKind: 'reverse.transfer-inbound-completed',
    payload: { orderNo: order.orderNo, receivedUnits, receivedBy: pc.ctx.actorLoginName, businessTime: pc.businessTime },
  })
  return { orderId, orderNo: order.orderNo, status: 'completed', receivedUnits, receivedBy: pc.ctx.actorLoginName }
}

// ---------------- 命令：采购批次库存纠正（WR-18～23） ----------------

/** WR-22：下游已使用事实收集（对象关系：单元状态轴＋流水种类＋生效质量结论）。 */
async function collectDownstreamFacts(
  tools: ReverseCommandTools,
  batch: PurchaseBatchFacts,
): Promise<void> {
  const details = await tools.rv.pur.listDetailsByBatch(batch.id)
  const unitIds = details.map((d) => d.inventoryUnitId).filter((id): id is string => id !== null)
  const shippedUnitNos: string[] = []
  const inTransitUnitNos: string[] = []
  const issuedUnitNos: string[] = []
  const convertedUnitNos: string[] = []
  for (const unitId of unitIds) {
    const unit = await tools.inv.units.findById(unitId)
    if (unit === null) continue
    if (unit.status === 'shipped') shippedUnitNos.push(unit.unitNo)
    if (unit.status === 'in_transit') inTransitUnitNos.push(unit.unitNo)
    const transactions = await tools.inv.transactions.listByUnit(unitId, 50)
    if (transactions.some((t) => t.movementKind === 'issue')) issuedUnitNos.push(unit.unitNo)
    if (transactions.some((t) => t.movementKind === 'split' || t.movementKind === 'merge')) convertedUnitNos.push(unit.unitNo)
  }
  const effectiveQualifiedDetailNos = await tools.rv.pur.listEffectiveQualifiedDetailNos(batch.id)
  assertNotDownstreamConsumed({
    batchNo: batch.batchNo,
    shippedUnitNos,
    issuedUnitNos,
    inTransitUnitNos,
    convertedUnitNos,
    effectiveQualifiedDetailNos,
  })
}

/** 反向流水＋零余额关闭（退货/作废/冲销共通记账序；行号显式）。 */
async function reverseBatchStock(
  pc: PostingContext,
  batch: PurchaseBatchFacts,
  lineNoStart: number,
  reason: string,
  refId: string,
): Promise<{ linesUsed: number; reversedQty: string; transactionIds: string[] }> {
  const tools = rvTools(pc)
  const details = await tools.rv.pur.listDetailsByBatch(batch.id)
  const unitIds = details.map((d) => d.inventoryUnitId).filter((id): id is string => id !== null)
  const locked = unitIds.length > 0 ? await tools.inv.units.lockForUpdate(ensureStableLockOrder(unitIds)) : []
  const unitMap = new Map(locked.map((u) => [u.id, u]))
  let lineNo = lineNoStart
  let reversedQty = '0.0000'
  const transactionIds: string[] = []
  for (const detail of details) {
    if (detail.inventoryUnitId === null) continue
    const unit = unitMap.get(detail.inventoryUnitId)
    if (unit === undefined) continue
    const balances = await tools.inv.balances.listActiveByUnit(unit.id)
    const balance = balances.length === 1 ? balances[0]! : null
    if (balance === null) continue // 该单元余额已关闭（历史处置），无账可冲
    const written = await reverseBalanceLine(pc, {
      unit,
      balance,
      movementKind: 'reverse',
      lineNo,
      reason,
      refType: 'purchase_receipt_batch',
      refId,
    })
    transactionIds.push(written.transactionId)
    reversedQty = addQty(reversedQty, balance.quantity)
    lineNo += 1
  }
  return { linesUsed: lineNo - lineNoStart, reversedQty, transactionIds }
}

// ABS 收编轮：原等价服务 deductOrderLine（订单行已收扣减＋状态重算，等价 purchase 线服务）
// 已收编为 purchase 域核心 deductOrderLineReceived（purchase-handlers.ts）；本域三处冲销
// 调用点直调核心（policy=reject-negative 保 WR-20 语义；端口适配器沿用 rv.pur 行锁与增量写）。

/** WR-18：一码多批收货（等价服务：分组/合并/再扫确认；同组不可重复）。 */
async function receiptReceiveLines(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.receipt.receive-lines'
  assertNotCustomerReturnPayload(p)
  const plantId = requireStr(p, 'plantId', command)
  await assertPlantScope(tools, plantId)
  const purchaseLineId = requireStr(p, 'purchaseLineId', command)
  const orderLine = await tools.rv.pur.lockOrderLine(purchaseLineId)
  if (orderLine === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '采购订单行不存在')
  const linesPayload = p['lines']
  if (!Array.isArray(linesPayload) || linesPayload.length === 0) {
    throw new ReverseRuleViolation('WR-18', `${command}：lines 须为非空数组（一码多批收货行）`)
  }
  const lines = linesPayload.map((raw, index) => {
    const l = (raw ?? {}) as Payload
    const barcodeValue = str(l, 'barcodeValue')
    const quantity = dec(l, 'quantity')
    if (barcodeValue === undefined || quantity === undefined || !isPositiveQty(quantity)) {
      throw new ReverseRuleViolation('WR-18', `第 ${index + 1} 行缺少 barcodeValue 或 quantity（正十进制定点字符串）`)
    }
    return {
      barcodeValue,
      supplierLotNo: str(l, 'supplierLotNo') ?? '',
      grade: str(l, 'grade') ?? '',
      quantity,
      qualityStatus: str(l, 'qualityStatus') ?? 'pending_inspection',
      inventoryUnitId: str(l, 'inventoryUnitId') ?? null,
      locationId: str(l, 'locationId') ?? null,
      locationCode: str(l, 'locationCode') ?? null,
    }
  })
  assertGroupNotDuplicatedInPayload(lines)

  // WR-18：已收货的码再扫先弹确认（未确认拒绝并回传系统已记数量）
  const confirmReScan = p['confirmReScan'] === true
  const reScanSummaries: Record<string, unknown>[] = []
  for (const barcodeValue of [...new Set(lines.map((l) => l.barcodeValue))]) {
    const received = await tools.rv.pur.listReceivedGroupsByBarcode(plantId, barcodeValue)
    if (received.length > 0) {
      const systemRecordedQty = received.reduce((acc, r) => addQty(acc, r.quantity), '0.0000')
      const localSavedQty = lines
        .filter((l) => l.barcodeValue === barcodeValue)
        .reduce((acc, l) => addQty(acc, l.quantity), '0.0000')
      if (!confirmReScan) {
        assertReScanConfirmed({ barcodeValue, systemRecordedQty, localSavedQty, confirmReScan })
      }
      reScanSummaries.push({ barcodeValue, systemRecordedQty, localSavedQty, groups: received.length })
    }
  }

  // 批次解析：batchId 续收既有批次；否则新建
  const totalQty = lines.reduce((acc, l) => addQty(acc, l.quantity), '0.0000')
  let batch: PurchaseBatchFacts
  const batchId = str(p, 'batchId')
  if (batchId !== undefined) {
    const existing = await tools.rv.pur.findById(batchId)
    if (existing === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '采购批次不存在')
    if (existing.purchaseLineId !== purchaseLineId) {
      throw new ReverseRuleViolation('WR-18', '批次不属于指定采购订单行，拒绝续收')
    }
    batch = existing
    await tools.rv.pur.adjustBatchReceivedQty(batch.id, totalQty, pc.ctx.actorLoginName)
  } else {
    batch = await tools.rv.pur.insertBatch({
      batchNo: genNo('RB'),
      purchaseLineId,
      orderNo: `PO-${purchaseLineId.slice(0, 8).toUpperCase()}`,
      lineNo: 1,
      materialId: requireStr(p, 'materialId', command),
      materialCode: str(p, 'materialCode') ?? '',
      materialType: null,
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      warehouseId: requireStr(p, 'warehouseId', command),
      uomId: requireStr(p, 'uomId', command),
      uomCode: str(p, 'uomCode') ?? 'KG',
      inspectionStatus: str(p, 'inspectionStatus') ?? 'pending',
      receivedQty: totalQty,
      arrivalTime: str(p, 'arrivalTime') ?? pc.businessTime,
      confirmTime: str(p, 'confirmTime') ?? pc.businessTime,
      receivedBy: pc.ctx.actorLoginName,
      createdBy: pc.ctx.actorLoginName,
    })
  }

  // 明细写入：同组多次保存合并数量相加；不同厂家批号/牌号线径各一行
  const detailResults: Record<string, unknown>[] = []
  for (const line of lines) {
    const existing = await tools.rv.pur.findDetailByTriple(batch.id, line.barcodeValue, line.supplierLotNo, line.grade)
    if (existing !== null) {
      const merged = await tools.rv.pur.mergeDetailQuantity(existing.id, line.quantity, pc.ctx.actorLoginName)
      detailResults.push({ detailId: existing.id, barcodeValue: line.barcodeValue, merged: true, quantity: merged?.quantity ?? null })
    } else {
      const inserted = await tools.rv.pur.insertDetail({
        batchId: batch.id,
        barcodeValue: line.barcodeValue,
        supplierLotNo: line.supplierLotNo,
        grade: line.grade,
        quantity: line.quantity,
        uomId: batch.uomId,
        uomCode: batch.uomCode,
        qualityStatus: line.qualityStatus,
        inventoryUnitId: line.inventoryUnitId,
        locationId: line.locationId,
        locationCode: line.locationCode,
        createdBy: pc.ctx.actorLoginName,
      })
      detailResults.push({ detailId: inserted.id, barcodeValue: line.barcodeValue, merged: false, quantity: inserted.quantity })
    }
  }
  // 订单行已收回补（等价服务直写）
  const newLineStatus = recalcOrderLineStatus({ status: orderLine.status, plannedQty: orderLine.plannedQty, receivedQty: addQty(orderLine.receivedQty, totalQty) })
  await tools.rv.pur.adjustOrderLineReceivedQty(purchaseLineId, totalQty, newLineStatus, pc.ctx.actorLoginName)

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'purchase_receipt_batch',
    subjectId: batch.id,
    after: { batchNo: batch.batchNo, lines: detailResults.length, totalQty, reScanConfirmed: reScanSummaries.length > 0 },
    reason: str(p, 'reason') ?? null,
  })
  return { batchId: batch.id, batchNo: batch.batchNo, totalQty, details: detailResults, reScanSummaries }
}

/** WR-19：修改（普通）——业务条件校验＋批次时间/明细仓位数量/订单行已收/库存数据更新。 */
async function receiptModify(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.receipt.modify'
  assertNotCustomerReturnPayload(p)
  const batchId = requireStr(p, 'batchId', command)
  const batch = await tools.rv.pur.findById(batchId)
  if (batch === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '采购批次不存在')
  await assertPlantScope(tools, batch.plantId)
  assertReceiptModifiable({ batchNo: batch.batchNo, inspectionStatus: batch.inspectionStatus, qualifiedSyncStatus: batch.qualifiedSyncStatus })

  const patchesPayload = p['detailPatches']
  if (!Array.isArray(patchesPayload) || patchesPayload.length === 0) {
    throw new ReverseRuleViolation('WR-19', `${command}：detailPatches 须为非空数组`)
  }
  let lineNo = 1
  let qtyDelta = '0.0000'
  const applied: Record<string, unknown>[] = []
  for (const raw of patchesPayload) {
    const patch = (raw ?? {}) as Payload
    const detailId = str(patch, 'detailId')
    if (detailId === undefined) throw new ReverseRuleViolation('WR-19', 'detailPatches 行缺少 detailId')
    const details = await tools.rv.pur.listDetailsByBatch(batchId)
    const detail = details.find((d) => d.id === detailId)
    if (detail === undefined) throw new ReverseRuleViolation(NOT_FOUND_RULE, `收货明细 ${detailId} 不属于批次 ${batch.batchNo}`)
    // 数量修改：库存数据经流水（movement_kind='adjust'，差额调整）
    const newQty = dec(patch, 'quantity')
    if (newQty !== undefined && detail.inventoryUnitId !== null) {
      const unit = await tools.inv.units.findById(detail.inventoryUnitId)
      if (unit !== null) {
        const balance = await singleActiveBalance(tools, unit.id)
        const delta = subQty(newQty, detail.quantity)
        if (cmpQty(delta, '0.0000') !== 0) {
          const after = addQty(balance.quantity, delta)
          if (cmpQty(after, '0.0000') < 0) {
            throw new ReverseRuleViolation('WR-19', `明细数量调减超实时余额（余额 ${balance.quantity}、调减 ${delta}），拒绝`)
          }
          await writeLedgerLine(pc, {
            lineNo,
            movementKind: 'adjust',
            balance,
            beforeQty: balance.quantity,
            afterQty: after,
            unit,
            reason: `采购批次修改（批次 ${batch.batchNo}）`,
            refType: 'purchase_receipt_batch',
            refId: batch.id,
          })
          lineNo += 1
          qtyDelta = addQty(qtyDelta, delta)
        }
      }
    }
    // 仓位修改：移位（原/现库位两行流水）
    const newLocationId = str(patch, 'locationId')
    if (newLocationId !== undefined && detail.inventoryUnitId !== null) {
      const unit = await tools.inv.units.findById(detail.inventoryUnitId)
      const location = await tools.rv.locations.findById(newLocationId)
      if (location === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '目标库位不存在')
      if (unit !== null) {
        const from = await singleActiveBalance(tools, unit.id)
        if (from.locationId !== newLocationId) {
          await moveStock(pc, {
            unitId: unit.id,
            quantity: from.quantity,
            fromLocationId: from.locationId,
            fromOwnerId: from.ownerId,
            toLocationId: newLocationId,
            toLocationCode: location.code,
            lineNoBase: lineNo,
            reason: `采购批次修改（明细换仓，批次 ${batch.batchNo}）`,
            refType: 'purchase_receipt_batch',
            refId: batch.id,
          })
          lineNo += 2
        }
      }
    }
    await tools.rv.pur.updateDetailStorage(
      detailId,
      {
        locationId: newLocationId ?? detail.locationId,
        locationCode: str(patch, 'locationCode') ?? detail.locationCode,
        quantity: newQty ?? detail.quantity,
      },
      pc.ctx.actorLoginName,
    )
    applied.push({ detailId, quantity: newQty ?? null, locationId: newLocationId ?? null })
  }
  // 批次到货/入库确认时间更新＋已收数量随明细数量联动
  const arrivalTime = str(p, 'arrivalTime')
  const confirmTime = str(p, 'confirmTime')
  if (arrivalTime !== undefined || confirmTime !== undefined) {
    await tools.rv.pur.updateBatchTimes(batchId, { arrivalTime, confirmTime }, pc.ctx.actorLoginName)
  }
  if (cmpQty(qtyDelta, '0.0000') !== 0) {
    await tools.rv.pur.adjustBatchReceivedQty(batchId, qtyDelta, pc.ctx.actorLoginName)
    await tools.rv.pur.adjustOrderLineReceivedQty(batch.purchaseLineId, qtyDelta, null, pc.ctx.actorLoginName)
  }
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'purchase_receipt_batch',
    subjectId: batchId,
    before: { inspectionStatus: batch.inspectionStatus, qualifiedSyncStatus: batch.qualifiedSyncStatus },
    after: { applied, qtyDelta },
    reason: str(p, 'reason') ?? null,
  })
  return { batchId, applied, qtyDelta }
}

/** WR-20：退货——退货事实＋反向流水＋投影（已入账保留、入库数量/状态=已入账−已退货）；触发 IF-10。 */
async function receiptReturn(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.receipt.return'
  assertNotCustomerReturnPayload(p)
  const batchId = requireStr(p, 'batchId', command)
  const batch = await tools.rv.pur.findById(batchId)
  if (batch === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '采购批次不存在')
  await assertPlantScope(tools, batch.plantId)
  const attachmentsRaw = p['attachments']
  const attachments = Array.isArray(attachmentsRaw) ? attachmentsRaw.filter((v): v is string => typeof v === 'string') : []
  const remark = str(p, 'remark')
  assertReverseReturnExecutable({
    batchNo: batch.batchNo,
    inspectionStatus: batch.inspectionStatus,
    storageStatus: batch.storageStatus,
    remark,
    attachments,
  })
  await collectDownstreamFacts(tools, batch)

  const correction = await tools.rv.corrections.insert({
    correctionNo: genNo('RC'),
    batchId,
    batchNo: batch.batchNo,
    correctionKind: 'return',
    quantity: batch.receivedQty,
    reason: str(p, 'reason') ?? remark ?? '采购退货',
    remark: remark ?? null,
    attachments,
    returnSyncStatus: 'pending',
    snapshot: {
      batchNo: batch.batchNo,
      inspectionStatus: batch.inspectionStatus,
      receivedQty: batch.receivedQty,
      qualifiedSyncStatus: batch.qualifiedSyncStatus,
      projectionRule: '已入账−已退货（隐式归零废除，CA-16）',
    },
    operatedBy: pc.ctx.actorLoginName,
    operatedAt: pc.businessTime,
    commandReceiptId: pc.commandReceiptId,
    plantId: batch.plantId,
    enterpriseId: batch.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  const reversed = await reverseBatchStock(
    pc,
    batch,
    1,
    `采购退货（批次 ${batch.batchNo}，纠正单 ${correction.correctionNo}）`,
    batch.id,
  )
  const deductQty = reversed.reversedQty === '0.0000' ? batch.receivedQty : reversed.reversedQty
  await deductOrderLineReceived(
    () => tools.rv.pur.lockOrderLine(batch.purchaseLineId),
    deductQty,
    {
      policy: 'reject-negative', // WR-20：不足即拒，整单回滚
      write: (_newReceived, newStatus) =>
        tools.rv.pur.adjustOrderLineReceivedQty(batch.purchaseLineId, `-${deductQty}`, newStatus, pc.ctx.actorLoginName),
      violation: (rule, message) => new ReverseRuleViolation(rule, message),
    },
  )
  // 批次投影：storage_status=returned＋回传 pending；received_qty 保留（WR-20 目标口径）
  await tools.rv.pur.setBatchReturnState(
    batchId,
    { storageStatus: 'returned', returnedAt: pc.businessTime, returnReason: remark ?? '', returnSyncStatus: 'pending' },
    pc.ctx.actorLoginName,
  )
  // IF-10 退货回传任务（本地入账不因外部失败回滚，WR-23）
  pc.tools.outbox.collect({
    aggregateType: 'purchase_receipt_batch',
    aggregateId: batchId,
    taskKind: 'reverse.receipt-return-sync',
    payload: {
      routeKey: 'return_callback',
      correctionNo: correction.correctionNo,
      batchNo: batch.batchNo,
      orderNo: batch.orderNo,
      lineNo: batch.lineNo,
      materialCode: batch.materialCode,
      returnedQty: reversed.reversedQty,
      uomCode: batch.uomCode,
      remark: remark ?? null,
      returnedAt: pc.businessTime,
      snapshotAt: pc.businessTime,
    },
  })
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'purchase_receipt_batch',
    subjectId: batchId,
    before: { storageStatus: batch.storageStatus, receivedQty: batch.receivedQty },
    after: { storageStatus: 'returned', reversedQty: reversed.reversedQty, correctionNo: correction.correctionNo },
    reason: remark ?? null,
  })
  return {
    batchId,
    correctionId: correction.id,
    correctionNo: correction.correctionNo,
    reversedQty: reversed.reversedQty,
    projection: { bookedQty: batch.receivedQty, returnedQty: reversed.reversedQty, inboundQty: subQty(batch.receivedQty, reversed.reversedQty) },
    returnSyncStatus: 'pending',
  }
}

/** WR-21：普通删除=作废（逻辑删除＋操作记录；明细与质检数据保留可查；管理删除废除 CA-17）。 */
async function receiptVoid(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.receipt.void'
  const batchId = requireStr(p, 'batchId', command)
  const batch = await tools.rv.pur.findById(batchId)
  if (batch === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '采购批次不存在')
  await assertPlantScope(tools, batch.plantId)
  const reasonRaw = str(p, 'reason')
  if (reasonRaw === undefined || reasonRaw.trim() === '') {
    throw new ReverseRuleViolation('WR-21', '作废（普通删除）必须填写理由（操作记录留档）')
  }
  const reason = reasonRaw
  assertVoidExecutable({
    batchNo: batch.batchNo,
    inspectionStatus: batch.inspectionStatus,
    qualifiedSyncStatus: batch.qualifiedSyncStatus,
    storageStatus: batch.storageStatus,
  })
  await collectDownstreamFacts(tools, batch)

  const correction = await tools.rv.corrections.insert({
    correctionNo: genNo('RC'),
    batchId,
    batchNo: batch.batchNo,
    correctionKind: 'void',
    quantity: batch.receivedQty,
    reason,
    snapshot: {
      batchNo: batch.batchNo,
      inspectionStatus: batch.inspectionStatus,
      receivedQty: batch.receivedQty,
      voidRule: '作废=逻辑删除＋操作记录（明细与质检数据保留可查；管理删除废除，CA-17）',
    },
    operatedBy: pc.ctx.actorLoginName,
    operatedAt: pc.businessTime,
    commandReceiptId: pc.commandReceiptId,
    plantId: batch.plantId,
    enterpriseId: batch.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  const reversed = await reverseBatchStock(pc, batch, 1, `采购批次作废（批次 ${batch.batchNo}，纠正单 ${correction.correctionNo}）`, batch.id)
  const deductQty = reversed.reversedQty === '0.0000' ? batch.receivedQty : reversed.reversedQty
  await deductOrderLineReceived(
    () => tools.rv.pur.lockOrderLine(batch.purchaseLineId),
    deductQty,
    {
      policy: 'reject-negative', // WR-20：不足即拒，整单回滚
      write: (_newReceived, newStatus) =>
        tools.rv.pur.adjustOrderLineReceivedQty(batch.purchaseLineId, `-${deductQty}`, newStatus, pc.ctx.actorLoginName),
      violation: (rule, message) => new ReverseRuleViolation(rule, message),
    },
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'purchase_receipt_batch',
    subjectId: batchId,
    before: { inspectionStatus: batch.inspectionStatus },
    after: { voided: true, correctionNo: correction.correctionNo, reversedQty: reversed.reversedQty },
    reason,
  })
  return { batchId, correctionId: correction.id, correctionNo: correction.correctionNo, reversedQty: reversed.reversedQty, voided: true }
}

/** WR-21：具名冲销（已入账批次纠正：反向流水＋纠正事实＋强制理由＋审计；GAP-F13 形态最小实现）。 */
async function receiptReverse(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.receipt.reverse'
  const batchId = requireStr(p, 'batchId', command)
  const batch = await tools.rv.pur.findById(batchId)
  if (batch === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '采购批次不存在')
  await assertPlantScope(tools, batch.plantId)
  const reason = str(p, 'reason')
  assertNamedReversalExecutable({ batchNo: batch.batchNo, reason, reverseQty: batch.receivedQty, bookedQty: batch.receivedQty })
  await collectDownstreamFacts(tools, batch)

  const correction = await tools.rv.corrections.insert({
    correctionNo: genNo('RC'),
    batchId,
    batchNo: batch.batchNo,
    correctionKind: 'reverse',
    quantity: batch.receivedQty,
    reason: reason!,
    snapshot: {
      batchNo: batch.batchNo,
      inspectionStatus: batch.inspectionStatus,
      receivedQty: batch.receivedQty,
      reverseRule: '已入账批次纠正=具名冲销（反向流水＋纠正事实＋强制理由，GAP-F13 最小形态）',
    },
    operatedBy: pc.ctx.actorLoginName,
    operatedAt: pc.businessTime,
    commandReceiptId: pc.commandReceiptId,
    plantId: batch.plantId,
    enterpriseId: batch.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  const reversed = await reverseBatchStock(pc, batch, 1, `采购批次具名冲销（批次 ${batch.batchNo}，纠正单 ${correction.correctionNo}）`, batch.id)
  const deductQty = reversed.reversedQty === '0.0000' ? batch.receivedQty : reversed.reversedQty
  await deductOrderLineReceived(
    () => tools.rv.pur.lockOrderLine(batch.purchaseLineId),
    deductQty,
    {
      policy: 'reject-negative', // WR-20：不足即拒，整单回滚
      write: (_newReceived, newStatus) =>
        tools.rv.pur.adjustOrderLineReceivedQty(batch.purchaseLineId, `-${deductQty}`, newStatus, pc.ctx.actorLoginName),
      violation: (rule, message) => new ReverseRuleViolation(rule, message),
    },
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'purchase_receipt_batch',
    subjectId: batchId,
    after: { correctionNo: correction.correctionNo, reversedQty: reversed.reversedQty },
    reason,
  })
  return { batchId, correctionId: correction.id, correctionNo: correction.correctionNo, reversedQty: reversed.reversedQty }
}

/** WR-23：退货回传重试（模拟适配器 outcome 载荷——真实路由待 GAP-B 族；已成功侧不重做）。 */
async function receiptReturnSyncRetry(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.receipt.return-sync.retry'
  const batchId = requireStr(p, 'batchId', command)
  const batch = await tools.rv.pur.findById(batchId)
  if (batch === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '采购批次不存在')
  await assertPlantScope(tools, batch.plantId)
  const { skipped } = assertReturnSyncRetryable({
    batchNo: batch.batchNo,
    storageStatus: batch.storageStatus,
    returnSyncStatus: batch.returnSyncStatus,
  })
  if (skipped) {
    return { batchId, skipped: true, returnSyncStatus: batch.returnSyncStatus }
  }
  const outcome = str(p, 'outcome') === 'failure' ? 'failure' : 'success'
  const newStatus = outcome === 'success' ? 'synced' : 'failed'
  // WR-S6：receipt_correction 为 append-only 事实（触发器禁止 UPDATE）——重试结果只更新
  // 批次投影 purchase_receipt_batch.return_sync_status；纠正事实行保留创建时快照，重试留审计记录。
  await tools.rv.pur.setBatchReturnSyncStatus(batchId, newStatus, pc.ctx.actorLoginName)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'purchase_receipt_batch',
    subjectId: batchId,
    before: { returnSyncStatus: batch.returnSyncStatus },
    after: { returnSyncStatus: newStatus, outcome },
    reason: str(p, 'reason') ?? null,
  })
  return { batchId, skipped: false, outcome, returnSyncStatus: newStatus }
}

// ---------------- 命令：盘点（WR-24/25，[合同新造·最小语义]） ----------------

async function stocktakeOpen(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.stocktake.open'
  const plantId = requireStr(p, 'plantId', command)
  await assertPlantScope(tools, plantId)
  const warehouseId = requireStr(p, 'warehouseId', command)
  const warehouse = await tools.rv.warehouses.findById(warehouseId)
  if (warehouse === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '仓库不存在')
  const existing = await tools.rv.stocktakes.findCountingByWarehouse(warehouseId)
  if (existing !== null) {
    throw new ReverseRuleViolation('WR-24', `仓库 ${warehouse.code} 已有盘点中的盘单（${existing.orderNo}）：同仓库不可重复开盘`)
  }
  const order = await tools.rv.stocktakes.insert({
    orderNo: genNo('ST'),
    warehouseId,
    warehouseCode: warehouse.code,
    note: str(p, 'note') ?? null,
    startedBy: pc.ctx.actorLoginName,
    startedAt: pc.businessTime,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'stocktake_order',
    subjectId: order.id,
    after: { orderNo: order.orderNo, warehouseCode: warehouse.code, locked: true },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'stocktake_order',
    aggregateId: order.id,
    taskKind: 'reverse.stocktake-opened',
    payload: { orderNo: order.orderNo, warehouseCode: warehouse.code, locked: true, businessTime: pc.businessTime },
  })
  return { orderId: order.id, orderNo: order.orderNo, warehouseCode: warehouse.code, locked: true, status: order.status }
}

async function stocktakeRecordCount(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.stocktake.record-count'
  const orderId = requireStr(p, 'orderId', command)
  const order = await tools.rv.stocktakes.lockById(orderId)
  if (order === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '盘单不存在')
  await assertPlantScope(tools, order.plantId)
  if (order.status !== 'counting') {
    throw new ReverseRuleViolation('WR-24', `盘单 ${order.orderNo}状态为 ${order.status}，仅盘点中可记录点数`)
  }
  const linesPayload = p['lines']
  if (!Array.isArray(linesPayload) || linesPayload.length === 0) {
    throw new ReverseRuleViolation('WR-24', `${command}：lines 须为非空数组（盘点点数）`)
  }
  const countLines = []
  for (const raw of linesPayload) {
    const l = (raw ?? {}) as Payload
    const unitNo = str(l, 'unitNo')
    const countedQty = dec(l, 'countedQty')
    if (unitNo === undefined || countedQty === undefined) {
      throw new ReverseRuleViolation('WR-24', '点数行缺少 unitNo 或 countedQty')
    }
    const unit = await tools.inv.units.findByUnitNo(order.plantId, unitNo)
    if (unit === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `库存单元 ${unitNo} 不存在`)
    const balance = await singleActiveBalance(tools, unit.id)
    countLines.push({
      orderId,
      inventoryUnitId: unit.id,
      unitNo,
      materialCode: unit.materialCode,
      locationId: balance.locationId,
      locationCode: balance.locationCode,
      bookQty: balance.quantity,
      countedQty,
      diffQty: subQty(countedQty, balance.quantity),
      countedBy: pc.ctx.actorLoginName,
      countedAt: pc.businessTime,
      commandReceiptId: pc.commandReceiptId,
    })
  }
  const inserted = await tools.rv.countLines.insert(countLines)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'stocktake_order',
    subjectId: orderId,
    after: { lines: inserted.length },
    reason: str(p, 'reason') ?? null,
  })
  return { orderId, lines: inserted.length, diffs: inserted.filter((l) => l.diffQty !== '0.0000').length }
}

async function stocktakeClose(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.stocktake.close'
  const orderId = requireStr(p, 'orderId', command)
  const order = await tools.rv.stocktakes.lockById(orderId)
  if (order === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '盘单不存在')
  await assertPlantScope(tools, order.plantId)
  if (order.status !== 'counting') {
    throw new ReverseRuleViolation('WR-24', `盘单 ${order.orderNo}状态为 ${order.status}，仅盘点中可关闭`)
  }
  const cancel = p['cancel'] === true
  const closed = await tools.rv.stocktakes.close(
    orderId,
    {
      status: cancel ? 'cancelled' : 'completed',
      locked: false,
      closedBy: pc.ctx.actorLoginName,
      closedAt: pc.businessTime,
    },
    pc.ctx.actorLoginName,
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'stocktake_order',
    subjectId: orderId,
    before: { status: 'counting', locked: true },
    after: { status: closed?.status ?? 'completed', locked: false },
    reason: str(p, 'reason') ?? null,
  })
  return { orderId, status: closed?.status ?? 'completed', locked: false }
}

/** WR-24②/③＋WR-25：差异调整单——原因必填＋去向＋正向/反向流水（基准=实时余额，IT-19/IT-30）。 */
async function stockAdjustmentExecute(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.stock-adjustment.execute'
  const plantId = requireStr(p, 'plantId', command)
  await assertPlantScope(tools, plantId)
  const linesPayload = p['lines']
  if (!Array.isArray(linesPayload) || linesPayload.length === 0) {
    throw new ReverseRuleViolation('WR-24', `${command}：lines 须为非空数组（差异调整行）`)
  }
  const inputLines = linesPayload.map((raw, index) => {
    const l = (raw ?? {}) as Payload
    const unitId = str(l, 'unitId')
    const adjustQty = dec(l, 'adjustQty')
    if (unitId === undefined || adjustQty === undefined) {
      throw new ReverseRuleViolation('WR-24', `第 ${index + 1} 行缺少 unitId 或 adjustQty（带符号十进制定点字符串）`)
    }
    return { unitId, adjustQty, locationId: str(l, 'locationId'), ownerId: str(l, 'ownerId') }
  })
  assertAdjustmentExecutable({
    reason: str(p, 'reason'),
    destination: str(p, 'destination'),
    lines: inputLines.map((l) => ({
      unitId: l.unitId,
      unitNo: l.unitId,
      locationId: l.locationId ?? '',
      ownerId: l.ownerId ?? '',
      adjustQty: l.adjustQty,
    })),
  })
  const stocktakeOrderId = str(p, 'stocktakeOrderId')
  if (stocktakeOrderId !== undefined) {
    const stocktake = await tools.rv.stocktakes.findById(stocktakeOrderId)
    if (stocktake === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '关联盘单不存在')
    if (stocktake.status !== 'counting') {
      throw new ReverseRuleViolation('WR-24', `关联盘单 ${stocktake.orderNo}非盘点中：差异调整须在盘点锁定期内执行`)
    }
  }

  // 基准=调整命令时点实时余额（WR-25：先锁单元→解析实时余额→断言→流水）
  const locked = await tools.inv.units.lockForUpdate(ensureStableLockOrder(inputLines.map((l) => l.unitId)))
  const unitMap = new Map(locked.map((u) => [u.id, u]))
  const resolvedLines: Array<{ unit: InventoryUnitRecord; balance: StockBalanceRecord; adjustQty: string; beforeQty: string; afterQty: string }> = []
  for (const line of inputLines) {
    const unit = unitMap.get(line.unitId)
    if (unit === undefined) throw new ReverseRuleViolation(NOT_FOUND_RULE, `库存单元 ${line.unitId} 不存在`)
    const balances = await tools.inv.balances.listActiveByUnit(unit.id)
    let balance: StockBalanceRecord | null = null
    if (line.locationId !== undefined && line.ownerId !== undefined) {
      balance = balances.find((b) => b.locationId === line.locationId && b.ownerId === line.ownerId) ?? null
    } else if (balances.length === 1) {
      balance = balances[0]!
    } else if (balances.length > 1) {
      throw new ReverseRuleViolation('WR-24', `单元 ${unit.unitNo} 存在 ${balances.length} 条活动余额：调整行须显式指定库位与所有者`)
    }
    if (balance === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, `单元 ${unit.unitNo} 无可调整的活动余额`)
    assertAdjustmentAgainstRealtimeBalance({ unitNo: unit.unitNo, realtimeQty: balance.quantity, adjustQty: line.adjustQty })
    const { beforeQty, afterQty } = buildAdjustmentBalances({ realtimeQty: balance.quantity, adjustQty: line.adjustQty })
    resolvedLines.push({ unit, balance, adjustQty: line.adjustQty, beforeQty, afterQty })
  }
  const totalQty = resolvedLines.reduce((acc, l) => addQty(acc, l.adjustQty), '0.0000')

  const created = await tools.rv.adjustments.insert(
    {
      adjustmentNo: genNo('SA'),
      stocktakeOrderId: stocktakeOrderId ?? null,
      reason: str(p, 'reason')!,
      destination: str(p, 'destination')!,
      totalQty,
      adjustedBy: pc.ctx.actorLoginName,
      adjustedAt: pc.businessTime,
      commandReceiptId: pc.commandReceiptId,
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    },
    resolvedLines.map((l, index) => ({
      lineNo: index + 1,
      inventoryUnitId: l.unit.id,
      unitNo: l.unit.unitNo,
      locationId: l.balance.locationId,
      locationCode: l.balance.locationCode,
      ownerId: l.balance.ownerId,
      ownerName: l.balance.ownerName,
      adjustQty: l.adjustQty,
      beforeQty: l.beforeQty,
      afterQty: l.afterQty,
      transactionId: null,
      balanceId: l.balance.id,
    })),
  )

  // 正向/反向库存流水（movement_kind='adjust'；盘亏负差、盘盈正差；禁止直接改 stock_balance）
  for (const [index, line] of resolvedLines.entries()) {
    const written = await writeLedgerLine(pc, {
      lineNo: index + 1,
      movementKind: 'adjust',
      balance: line.balance,
      beforeQty: line.beforeQty,
      afterQty: line.afterQty,
      unit: line.unit,
      reason: `盘点差异调整（调整单 ${created.adjustment.adjustmentNo}：${str(p, 'reason')}；去向 ${str(p, 'destination')}）`,
      refType: 'stock_adjustment',
      refId: created.adjustment.id,
    })
    await closeUnitIfZeroBalance(pc, line.unit, written.closed)
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'stock_adjustment',
    subjectId: created.adjustment.id,
    after: { adjustmentNo: created.adjustment.adjustmentNo, lines: resolvedLines.length, totalQty, destination: str(p, 'destination') },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'stock_adjustment',
    aggregateId: created.adjustment.id,
    taskKind: 'reverse.stock-adjustment-executed',
    payload: { adjustmentNo: created.adjustment.adjustmentNo, totalQty, lines: resolvedLines.length, businessTime: pc.businessTime },
  })
  return {
    adjustmentId: created.adjustment.id,
    adjustmentNo: created.adjustment.adjustmentNo,
    lines: resolvedLines.length,
    totalQty,
    lineDetails: created.lines.map((l) => ({ unitNo: l.unitNo, adjustQty: l.adjustQty, beforeQty: l.beforeQty, afterQty: l.afterQty })),
  }
}

// ---------------- 命令：所有权变更与载具借还（WR-26/27） ----------------

async function ownershipTransfer(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.ownership.transfer'
  const plantId = requireStr(p, 'plantId', command)
  await assertPlantScope(tools, plantId)
  const unitId = requireStr(p, 'unitId', command)
  const toOwnerId = requireStr(p, 'toOwnerId', command)
  const toOwnerName = requireStr(p, 'toOwnerName', command)
  const locked = await tools.inv.units.lockForUpdate([unitId])
  if (locked.length !== 1) throw new ReverseRuleViolation(NOT_FOUND_RULE, '库存单元不存在')
  const unit = locked[0]!
  const balances = await tools.inv.balances.listActiveByUnit(unitId)
  if (balances.length === 0) throw new ReverseRuleViolation(NOT_FOUND_RULE, '库存单元无活动余额')
  if (balances.length > 1) {
    throw new ReverseRuleViolation('WR-26', `库存单元 ${unit.unitNo} 存在 ${balances.length} 条活动余额：所有权变更须显式指定库位（fromLocationId/fromOwnerId）`)
  }
  const balance = balances[0]!
  const quantity = dec(p, 'quantity') ?? balance.quantity
  assertOwnershipTransferExecutable({
    unitNo: unit.unitNo,
    fromOwnerId: balance.ownerId,
    toOwnerId,
    fromLocationId: balance.locationId,
    toLocationId: balance.locationId,
    quantity,
  })
  const moved = await moveStock(pc, {
    unitId,
    quantity,
    fromLocationId: balance.locationId,
    fromOwnerId: balance.ownerId,
    toLocationId: balance.locationId,
    toLocationCode: balance.locationCode,
    toOwnerId,
    toOwnerName,
    lineNoBase: 1,
    reason: str(p, 'reason') ?? `所有权变更（${balance.ownerName} → ${toOwnerName}，保管位置不变）`,
    refType: 'ownership_transfer',
    refId: unitId,
  })
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'inventory_unit',
    subjectId: unitId,
    before: { ownerId: balance.ownerId, ownerName: balance.ownerName, locationCode: balance.locationCode },
    after: { ownerId: toOwnerId, ownerName: toOwnerName, locationCode: balance.locationCode },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'inventory_unit',
    aggregateId: unitId,
    taskKind: 'reverse.ownership-transferred',
    payload: { unitId, unitNo: unit.unitNo, fromOwnerId: balance.ownerId, toOwnerId, locationCode: balance.locationCode, quantity, businessTime: pc.businessTime },
  })
  return { unitId, unitNo: unit.unitNo, fromOwnerId: balance.ownerId, toOwnerId, locationCode: balance.locationCode, quantity, toBalanceId: moved.toBalanceId }
}

async function carrierLoan(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rvTools(pc)
  const command = 'reverse.carrier.loan'
  const plantId = requireStr(p, 'plantId', command)
  await assertPlantScope(tools, plantId)
  const eventKindRaw = str(p, 'eventKind')
  if (eventKindRaw !== 'lend' && eventKindRaw !== 'take_back' && eventKindRaw !== 'damage' && eventKindRaw !== 'scrap') {
    throw new ReverseRuleViolation('WR-27', "eventKind 必须为 'lend'（借出）、'take_back'（回收）、'damage'（损坏）或 'scrap'（报废）")
  }
  const eventKind = eventKindRaw as CarrierLoanEventKind
  const carrierId = str(p, 'carrierId')
  const carrierCode = str(p, 'carrierCode')
  let carrier: CarrierFacts | null = null
  if (carrierId !== undefined) carrier = await tools.rv.carrierFacts.findById(carrierId)
  else if (carrierCode !== undefined) carrier = await tools.rv.carrierFacts.findByCode(plantId, carrierCode)
  else throw new ReverseRuleViolation('WR-01', `${command}：carrierId 与 carrierCode 必填其一`)
  if (carrier === null) throw new ReverseRuleViolation(NOT_FOUND_RULE, '载具不存在')
  if (carrier.plantId !== plantId) {
    throw new ReverseRuleViolation('A-S1', `载具 ${carrier.carrierCode} 不在目标工厂（跨厂数据范围外）`)
  }
  assertCarrierLoanEventExecutable({
    carrierCode: carrier.carrierCode,
    eventKind,
    currentStatus: carrier.status,
    counterparty: str(p, 'counterparty'),
  })

  const statusByEvent: Record<CarrierLoanEventKind, CarrierFacts['status']> = {
    lend: 'lent_out',
    take_back: 'returned',
    damage: 'damaged',
    scrap: 'scrapped',
  }
  let unloaded = 0
  if (eventKind === 'take_back') {
    // WR-27/IT-01：清空仅解除当前装载（历史区间保留；不作产品退货处理）
    unloaded = await tools.rv.carrierLoans.endActiveLoads(carrier.id, pc.ctx.actorLoginName, '载具回收清空（仅解除当前装载，IT-01）', pc.tools.now().toISOString())
  }
  const updated = await tools.rv.carrierFacts.updateStatus(carrier.id, statusByEvent[eventKind], pc.ctx.actorLoginName)
  const loan = await tools.rv.carrierLoans.insert({
    carrierId: carrier.id,
    carrierCode: carrier.carrierCode,
    carrierKind: carrier.carrierKind,
    eventKind,
    counterparty: str(p, 'counterparty') ?? null,
    note: str(p, 'note') ?? null,
    occurredBy: pc.ctx.actorLoginName,
    occurredAt: pc.businessTime,
    commandReceiptId: pc.commandReceiptId,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: command,
    subjectType: 'carrier',
    subjectId: carrier.id,
    before: { status: carrier.status },
    after: { status: statusByEvent[eventKind], eventKind, unloadedBindings: unloaded },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'carrier',
    aggregateId: carrier.id,
    taskKind: 'reverse.carrier-loan-event',
    payload: { carrierCode: carrier.carrierCode, eventKind, counterparty: loan.counterparty, occurredAt: pc.businessTime },
  })
  return {
    loanId: loan.id,
    carrierCode: carrier.carrierCode,
    eventKind,
    carrierStatus: updated?.status ?? statusByEvent[eventKind],
    availableForPlant: isCarrierAvailableForPlant(statusByEvent[eventKind]),
    unloadedBindings: unloaded,
  }
}

// ---------------- 处理器装配 ----------------

type ReverseHandlerFn = (pc: PostingContext, p: Payload) => Promise<Record<string, unknown>>

/** 命令处理器清单（组合根装配进 PgCommandBus）。 */
export function createReverseCommandHandlers(): CommandHandler[] {
  const make = (commandType: string, fn: ReverseHandlerFn): CommandHandler => ({
    commandType,
    handle: (envelope, ctx, tools): Promise<HandlerOutcome> =>
      run(async () => {
        const reverseTools = tools as ReverseCommandTools
        const payload = (envelope.payload ?? {}) as Payload
        const pc = await buildPostingContext(reverseTools, ctx, commandType, envelope.operationId, payload)
        return fn(pc, payload)
      }),
  })

  return [
    make('reverse.move.submit', moveSubmit),
    make('reverse.transfer-outbound.create', transferOutCreate),
    make('reverse.transfer-outbound.update', transferOutUpdate),
    make('reverse.transfer-outbound.delete', transferOutDelete),
    make('reverse.transfer-outbound.scan', transferOutScan),
    make('reverse.transfer-outbound.remove-scan', transferOutRemoveScan),
    make('reverse.transfer-outbound.complete', transferOutComplete),
    make('reverse.transfer-outbound.auto-generate', transferOutAutoGenerate),
    make('reverse.transfer-inbound.scan-putaway', transferInScanPutaway),
    make('reverse.transfer-inbound.remove-scan', transferInRemoveScan),
    make('reverse.transfer-inbound.complete', transferInComplete),
    make('reverse.receipt.receive-lines', receiptReceiveLines),
    make('reverse.receipt.modify', receiptModify),
    make('reverse.receipt.return', receiptReturn),
    make('reverse.receipt.void', receiptVoid),
    make('reverse.receipt.reverse', receiptReverse),
    make('reverse.receipt.return-sync.retry', receiptReturnSyncRetry),
    make('reverse.stocktake.open', stocktakeOpen),
    make('reverse.stocktake.record-count', stocktakeRecordCount),
    make('reverse.stocktake.close', stocktakeClose),
    make('reverse.stock-adjustment.execute', stockAdjustmentExecute),
    make('reverse.ownership.transfer', ownershipTransfer),
    make('reverse.carrier.loan', carrierLoan),
  ]
}
