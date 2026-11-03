import { ERROR_CODES } from '@cadenza/contracts'
import {
  InventoryRuleViolation,
  isValidQuantityString,
  addQty,
  cmpQty,
  ensureStableLockOrder,
  subQty,
} from '@cadenza/domain'
import {
  AXIS_REASSIGN_PERMISSION,
  PALLET_RESERVATION_DEFAULT_HOURS,
  ReworkRuleViolation,
  assertAxisRetireCandidateExecutable,
  assertAxisRetireSelectionNonEmpty,
  assertCorrectionReassignAllowed,
  assertCorrectionScannable,
  assertCorrectionSubmitAcceptable,
  assertCorrectionUomFollowsMaterial,
  assertCorrectionWithdrawable,
  assertCorrectionWithdrawNotBlocked,
  assertOccupiedUnitClearable,
  assertOldPalletLocationImmutable,
  assertPalletConfirmable,
  assertPalletLineRemovable,
  assertPalletReservationUsable,
  assertPalletScanScope,
  assertPalletSplitScanAcceptable,
  assertPalletUnbindScanAcceptable,
  assertReelSplitReversible,
  assertUnitNotRetired,
  buildCorrectionOptions,
  isPalletAbandonOnLeave,
  judgePalletNewOrOld,
  planPalletConfirmChanges,
  validateReelSplitSubmission,
  type CorrectionOption,
} from '@cadenza/domain'
import type { CommandHandler, HandlerOutcome } from './command-bus'
import {
  buildPostingContext,
  closeUnitIfZero,
  moveStock,
  receiveGoods,
  writeLine,
  type PostingContext,
} from './inventory-posting'
import { violationOutcome } from './inventory-handlers'
import type {
  PalletScanRow,
  PalletTaskRecord,
  ReelSplitSourceRow,
  ReworkCommandTools,
} from './rework-repositories'
import type { InventoryUnitRecord, StockBalanceRecord } from './inventory-repositories'

/**
 * rework 域命令处理器（T15 倒轴/分盘/分托解绑/轴号修正/轴码退役；全部在命令总线事务内运行）。
 *
 * 命令面（11）：
 * - 倒轴（RS-01～12）：rework.reel-split.execute（会话模型：提交事务内统一校验＋守恒记账）、
 *   rework.reel-split.reverse（冲销：反向流水＋冲销事实，下游引用前置）；
 * - 分托/解绑（RS-13～24）：rework.pallet.scan-target / scan-item / set-location / remove-item /
 *   confirm / leave（服务端进行中单据＋作业预留锁定模型，与倒轴会话模型分立）；
 * - 轴号修正（RS-25～33）：rework.axis-correction.submit / withdraw（提交事务内重校验＋
 *   占用核权＋回撤下游拦截）；
 * - 轴码退役（RS-34～37）：rework.axis-retire.execute（退役状态＋清空记录＋库存统计事件
 *   一次事务；异步经 outbox 不阻塞）。
 *
 * 幂等/回执由 PgCommandBus 承担；规则违例以 [RS-xx] 前缀返回（BUSINESS_REJECTION）。
 * ABS 收编轮：记账原语直用 inventory-posting 核心 writeLine/closeUnitIfZero（原等价服务
 * writeLedgerLine/closeUnitIfZeroBalance 已删除；IT-25 同一记账序，行号显式递增 IT-19 唯一）。
 */

type Payload = Record<string, unknown>

function reworkViolationOutcome(error: ReworkRuleViolation): HandlerOutcome {
  let errorCode: string = ERROR_CODES.BUSINESS_RULE
  if (error.rule === 'RS-S1-SCOPE') errorCode = ERROR_CODES.FORBIDDEN_SCOPE
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<Record<string, unknown>>): Promise<HandlerOutcome> {
  try {
    const data = await body()
    return { status: 'COMMITTED', data }
  } catch (error) {
    if (error instanceof ReworkRuleViolation) return reworkViolationOutcome(error)
    if (error instanceof InventoryRuleViolation) return violationOutcome(error)
    throw error
  }
}

function str(p: Payload, key: string): string | undefined {
  const v = p[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function requireStr(p: Payload, key: string, command: string): string {
  const v = str(p, key)
  if (v === undefined) throw new ReworkRuleViolation('RS-01', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

/** 操作人解析（RS-13 车间判定；未绑定工厂拒绝）。 */
async function operatorOf(tools: ReworkCommandTools, ctx: { actorUserId: string }): Promise<{
  loginName: string
  deptCategory: number | null
  plantId: string
}> {
  const org = await tools.rework.facts.operatorOrgFacts(ctx.actorUserId)
  if (org.plantId === null || org.plantId === '') {
    throw new ReworkRuleViolation('RS-13', '操作人未绑定工厂，不能执行 rework 命令')
  }
  return { loginName: org.loginName, deptCategory: org.deptCategory, plantId: org.plantId }
}

/** 组织范围二道防线（OA-24/26；A-S1 同型）。 */
async function assertPlantScope(tools: ReworkCommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new ReworkRuleViolation('RS-S1-SCOPE', `目标工厂不在授权数据范围内（plant=${plantId}）`)
  }
}

function rwTools(pc: PostingContext): ReworkCommandTools {
  return pc.tools as ReworkCommandTools
}

/** 锁定库存单元并校验存在（IT-25 稳定次序；RS-07/28 事务内重校验入口）。 */
async function lockUnits(
  tools: ReworkCommandTools,
  unitIds: readonly string[],
): Promise<Map<string, InventoryUnitRecord>> {
  const ordered = ensureStableLockOrder(unitIds)
  if (ordered.length !== unitIds.length) {
    throw new ReworkRuleViolation('RS-01', '载荷出现重复单元，拒绝')
  }
  const locked = await tools.inv.units.lockForUpdate(ordered)
  if (locked.length !== ordered.length) {
    throw new ReworkRuleViolation('RS-01', '库存单元不存在或已不可用')
  }
  return new Map(locked.map((u) => [u.id, u]))
}

// ABS 收编轮：原等价记账服务 writeLedgerLine/closeUnitIfZeroBalance 已删除——与
// inventory-posting 核心 writeLine/closeUnitIfZero 逐字段同构（IT-25 同一记账序），
// 现直导核心原语（见文件头 import），本域不再复制记账序。

/** 单元唯一活动余额（IT-20 多余额须显式指定；本域码级操作按唯一活动余额口径）。 */
async function singleActiveBalance(tools: ReworkCommandTools, unitId: string): Promise<StockBalanceRecord> {
  const list = await tools.inv.balances.listActiveByUnit(unitId)
  if (list.length === 0) {
    throw new ReworkRuleViolation('RS-01', '库存单元无活动余额')
  }
  if (list.length > 1) {
    throw new ReworkRuleViolation('RS-04', '一码多条库存记录且多库位，本域命令要求唯一活动余额')
  }
  return list[0]!
}

/** ReelSplitSourceRow → domain 扫码事实。 */
function toSourceFacts(row: ReelSplitSourceRow): Parameters<typeof validateReelSplitSubmission>[0]['source'] {
  return {
    unitNo: row.unitNo,
    exists: row.exists,
    isPalletCode: row.isPalletCode,
    locked: row.locked,
    qualityPending: row.qualityPending,
    reportUnreviewed: row.reportUnreviewed,
    anomalyOpen: row.anomalyOpen,
    inLogisticsWarehouse: row.inLogisticsWarehouse,
    multiMaterial: row.multiMaterial,
    balanceQty: row.balanceQty,
    materialId: row.materialId,
    materialCode: row.materialCode,
    customerAxisNo: row.customerAxisNo,
    segmentLength: row.segmentLength,
  }
}

// ---------------- 倒轴执行（RS-01～RS-11） ----------------

interface PourLinePayload {
  unitNo: string
  quantity: string
  locationId?: string
  locationCode?: string
}

async function reelSplitExecute(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rwTools(pc)
  const operator = await operatorOf(tools, pc.ctx)
  await assertPlantScope(tools, operator.plantId)
  const sourceUnitNo = requireStr(p, 'sourceUnitNo', 'rework.reel-split.execute')
  const rawLines = p['pourLines']
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new ReworkRuleViolation('RS-02', '倒轴至少一条倒入行')
  }
  const pourLines: PourLinePayload[] = rawLines.map((raw, index) => {
    const c = (raw ?? {}) as Payload
    return {
      unitNo: requireStr(c, 'unitNo', `rework.reel-split.execute.pourLines[${index}]`),
      quantity: (c['quantity'] ?? '') as string,
      locationId: str(c, 'locationId'),
      locationCode: str(c, 'locationCode'),
    }
  })

  // RS-03/04 前置事实装配（RS-06：提交时统一校验）
  let row = await tools.rework.facts.reelSplitSourceRow(operator.plantId, sourceUnitNo)
  if (row.exists && row.retired) {
    assertUnitNotRetired(true, sourceUnitNo) // RS-36
  }
  let validated = validateReelSplitSubmission({
    sourceScanned: true,
    source: toSourceFacts(row),
    pourLines,
    lossQty: p['lossQty'],
    lossReason: str(p, 'lossReason') ?? null,
  })

  // RS-09：倒入码已有料品且与倒出不一致 → 整体失败（事务回滚保留页面数据）
  const targetRows = await tools.rework.facts.reelSplitTargetRows(
    operator.plantId,
    pourLines.map((l) => l.unitNo),
  )
  for (const target of targetRows) {
    if (target.exists && target.materialId !== row.materialId) {
      throw new ReworkRuleViolation(
        'RS-09',
        `倒入码 ${target.unitNo} 已有料品（${target.materialCode}）与倒出料品（${row.materialCode}）不一致，整体失败`,
      )
    }
    if (target.unitNoTakenByOtherPlant) {
      throw new ReworkRuleViolation('RS-09', `倒入码 ${target.unitNo} 已被其它工厂占用`)
    }
    if (target.exists) {
      assertUnitNotRetired((await tools.rework.retires.findRetireState(target.unitId!)) !== null, target.unitNo)
    }
  }

  // RS-07：提交事务内最终校验——倒出轴余额行锁后实时复验守恒式与状态
  const unitIdsToLock = [row.unitId, ...targetRows.filter((t) => t.exists).map((t) => t.unitId!)]
  const locked = await lockUnits(tools, unitIdsToLock)
  row = await tools.rework.facts.reelSplitSourceRow(operator.plantId, sourceUnitNo)
  validated = validateReelSplitSubmission({
    sourceScanned: true,
    source: toSourceFacts(row),
    pourLines,
    lossQty: p['lossQty'],
    lossReason: str(p, 'lossReason') ?? null,
  })

  const sourceUnit = locked.get(row.unitId)!
  const sourceBalance = await singleActiveBalance(tools, row.unitId)

  const orderNo = await tools.rework.reelSplits.nextOrderNo(pc.tools.now())
  // 记账：line 1 源扣减（split）；后续行倒入侧生成/更新
  const sourceAfter = subQty(sourceBalance.quantity, addQty(validated.pourTotal, validated.lossQty))
  const sourceLine = await writeLine(pc, {
    lineNo: 1,
    movementKind: 'split',
    balance: sourceBalance,
    beforeQty: sourceBalance.quantity,
    afterQty: sourceAfter,
    unit: sourceUnit,
    reason: str(p, 'lossReason') ?? null,
    refType: 'reel_split_source',
  })

  const lineWrites: Array<{ targetUnitId: string; targetUnitNo: string; transactionId: string; createdNewUnit: boolean }> = []
  let lineNo = 2
  for (let i = 0; i < pourLines.length; i += 1) {
    const pour = pourLines[i]!
    const qty = validated.pourQtyList[i]!
    const targetRow = targetRows.find((t) => t.unitNo === pour.unitNo)!
    let targetUnit: InventoryUnitRecord
    let targetBalance: StockBalanceRecord
    let createdNewUnit = false
    if (targetRow.exists) {
      targetUnit = locked.get(targetRow.unitId!)!
      const balances = await tools.inv.balances.listActiveByUnit(targetRow.unitId!)
      const existing =
        balances.find((b) => b.locationId === (pour.locationId ?? targetRow.locationId)) ??
        (balances.length === 1 ? balances[0]! : null)
      if (existing === null) {
        throw new ReworkRuleViolation('RS-09', `倒入码 ${pour.unitNo} 多活动余额，须显式指定库位`)
      }
      targetBalance = existing
    } else {
      const childUnit = await tools.inv.units.insert({
        unitNo: pour.unitNo,
        materialId: sourceUnit.materialId,
        materialCode: sourceUnit.materialCode,
        lotId: sourceUnit.lotId,
        uomId: sourceBalance.uomId,
        uomCode: sourceBalance.uomCode,
        traceMode: 'quantity',
        status: 'in_stock',
        plantId: sourceUnit.plantId,
        enterpriseId: sourceUnit.enterpriseId,
        businessTime: pc.businessTime,
        createdBy: pc.ctx.actorLoginName,
      })
      targetUnit = childUnit
      targetBalance = await tools.inv.balances.insert({
        unitId: childUnit.id,
        locationId: pour.locationId ?? sourceBalance.locationId,
        locationCode: pour.locationCode ?? sourceBalance.locationCode,
        ownerId: sourceBalance.ownerId,
        ownerName: sourceBalance.ownerName,
        quantity: '0.0000',
        uomId: sourceBalance.uomId,
        uomCode: sourceBalance.uomCode,
        measurementBasis: sourceBalance.measurementBasis,
        conversionRevisionId: sourceBalance.conversionRevisionId,
        qualityStatus: sourceBalance.qualityStatus,
        plantId: sourceUnit.plantId,
        enterpriseId: sourceUnit.enterpriseId,
        businessTime: pc.businessTime,
        createdBy: pc.ctx.actorLoginName,
      })
      createdNewUnit = true
    }
    const written = await writeLine(pc, {
      lineNo,
      movementKind: 'split',
      balance: targetBalance,
      beforeQty: targetBalance.quantity,
      afterQty: addQty(targetBalance.quantity, qty),
      unit: targetUnit,
      reason: str(p, 'lossReason') ?? null,
      refType: 'reel_split_target',
    })
    lineWrites.push({
      targetUnitId: targetUnit.id,
      targetUnitNo: pour.unitNo,
      transactionId: written.transactionId,
      createdNewUnit,
    })
    // 谱系：倒出单元 --consumption--> 倒入单元（IT-34 同 splitStock 口径）
    await tools.inv.genealogy.insertEdge({
      fromType: 'inventory_unit',
      fromId: sourceUnit.id,
      toType: 'inventory_unit',
      toId: targetUnit.id,
      edgeKind: 'consumption',
      quantity: qty,
      uomId: sourceBalance.uomId,
      uomCode: sourceBalance.uomCode,
      measurementBasis: sourceBalance.measurementBasis,
      conversionRevisionId: sourceBalance.conversionRevisionId,
      commandReceiptId: pc.commandReceiptId,
      businessTime: pc.businessTime,
      plantId: sourceUnit.plantId,
      enterpriseId: sourceUnit.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
    lineNo += 1
  }
  await closeUnitIfZero(pc, sourceUnit, sourceLine.closed) // RS-10

  // RS-S1：主表＋明细（append-only；数量四元组 IT-08）
  const order = await tools.rework.reelSplits.insertOrder({
    orderNo,
    sourceUnitId: row.unitId,
    sourceUnitNo,
    originalQty: sourceBalance.quantity,
    retainedQty: sourceAfter,
    lossQty: validated.lossQty,
    lossReason: str(p, 'lossReason') ?? null,
    materialId: row.materialId,
    materialCode: row.materialCode,
    lotId: row.lotId,
    orderRef: str(p, 'orderRef') ?? null,
    splitBy: pc.ctx.actorLoginName,
    splitAt: pc.businessTime,
    uomId: sourceBalance.uomId,
    uomCode: sourceBalance.uomCode,
    measurementBasis: sourceBalance.measurementBasis,
    conversionRevisionId: sourceBalance.conversionRevisionId,
    commandReceiptId: pc.commandReceiptId,
    plantId: sourceUnit.plantId,
    enterpriseId: sourceUnit.enterpriseId,
    businessTime: pc.businessTime,
    createdBy: pc.ctx.actorLoginName,
  })
  await tools.rework.reelSplits.insertLines(
    order.id,
    lineWrites.map((w, index) => ({
      lineNo: index + 1,
      targetUnitId: w.targetUnitId,
      targetUnitNo: w.targetUnitNo,
      quantity: validated.pourQtyList[index]!,
      createdNewUnit: w.createdNewUnit,
    })),
  )

  await tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'rework.reel-split.execute',
    subjectType: 'reel_split_order',
    subjectId: order.id,
    before: { unitNo: sourceUnitNo, quantity: sourceBalance.quantity },
    after: {
      orderNo,
      retainedQty: sourceAfter,
      lossQty: validated.lossQty,
      children: lineWrites.map((w, i) => ({ unitNo: w.targetUnitNo, quantity: validated.pourQtyList[i] })),
    },
    reason: str(p, 'lossReason') ?? null,
  })
  tools.outbox.collect({
    aggregateType: 'reel_split_order',
    aggregateId: order.id,
    taskKind: 'rework.reel-split-executed',
    payload: {
      orderNo,
      sourceUnitNo,
      originalQty: sourceBalance.quantity,
      retainedQty: sourceAfter,
      lossQty: validated.lossQty,
      children: lineWrites.map((w, i) => ({ unitNo: w.targetUnitNo, quantity: validated.pourQtyList[i] })),
      businessTime: pc.businessTime,
    },
  })
  return {
    orderId: order.id,
    orderNo,
    sourceAfterQty: sourceAfter,
    sourceBalanceClosed: sourceLine.closed,
    lossQty: validated.lossQty,
    children: lineWrites,
  }
}

// ---------------- 倒轴冲销（RS-12） ----------------

async function reelSplitReverse(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rwTools(pc)
  const sourceOrderId = requireStr(p, 'sourceOrderId', 'rework.reel-split.reverse')
  const reason = requireStr(p, 'reason', 'rework.reel-split.reverse')
  const order = await tools.rework.reelSplits.findById(sourceOrderId)
  if (order === null) {
    throw new ReworkRuleViolation('RS-12', '倒轴单不存在')
  }
  await assertPlantScope(tools, order.plantId)
  const priorReversal = await tools.rework.reelSplits.findReversalBySourceOrder(order.id)
  if (order.status === 'reversed' || priorReversal !== null) {
    throw new ReworkRuleViolation('RS-12', `倒轴单 ${order.orderNo} 已冲销，不可重复冲销`)
  }
  const lines = await tools.rework.reelSplits.listLines(sourceOrderId)
  const childUnitIds = lines.map((l) => l.targetUnitId)
  const downstream = await tools.rework.facts.reelSplitReversalDownstream(childUnitIds, order.sourceUnitId)
  assertReelSplitReversible(downstream)

  const retiredIds = await tools.rework.retires.listRetiredUnitIds([order.sourceUnitId, ...childUnitIds])
  if (retiredIds.length > 0) {
    assertUnitNotRetired(true, '涉及码') // RS-36
  }

  // 行锁后实时复验（子段余额仍足额方可扣回）
  const locked = await lockUnits(tools, [order.sourceUnitId, ...childUnitIds])
  const reversalNo = await tools.rework.reelSplits.nextOrderNo(pc.tools.now())
  let lineNo = 1
  const writtenLines: string[] = []
  const childUnitIdsAfter: string[] = []
  for (const line of lines) {
    const childUnit = locked.get(line.targetUnitId)!
    const childBalance = await singleActiveBalance(tools, line.targetUnitId)
    if (cmpQty(childBalance.quantity, line.quantity) < 0) {
      throw new ReworkRuleViolation(
        'RS-12',
        `子轴 ${line.targetUnitNo} 当前余额 ${childBalance.quantity} 不足以扣回 ${line.quantity}，不可冲销`,
      )
    }
    const written = await writeLine(pc, {
      lineNo,
      movementKind: 'reverse',
      balance: childBalance,
      beforeQty: childBalance.quantity,
      afterQty: subQty(childBalance.quantity, line.quantity),
      unit: childUnit,
      reason,
      refType: 'reel_split_reverse_child',
      refId: order.id,
    })
    if (line.createdNewUnit) {
      await closeUnitIfZero(pc, childUnit, written.closed) // 冲销归零关闭，档案保留
    }
    writtenLines.push(written.transactionId)
    childUnitIdsAfter.push(line.targetUnitId)
    lineNo += 1
  }
  // 源恢复到原量（冲销把该倒轴单效果完全回退：retained → original；损耗事实随单撤销）。
  // 源可能已零余额关闭（RS-10）：取含 closed 的余额行（键不变），行级恢复。
  const sourceUnit = locked.get(order.sourceUnitId)!
  const sourceBalanceRows = await tools.rework.facts.unitBalancesIncludingClosed(order.sourceUnitId)
  const sourceBalanceRow = sourceBalanceRows[0]
  if (sourceBalanceRow === undefined) {
    throw new ReworkRuleViolation('RS-12', '倒出轴无余额行可恢复，不可冲销')
  }
  if (cmpQty(sourceBalanceRow.quantity, order.retainedQty) !== 0) {
    throw new ReworkRuleViolation(
      'RS-12',
      `倒出轴当前余额 ${sourceBalanceRow.quantity} 与倒轴后留存 ${order.retainedQty} 不一致（已被其它业务变动），不可冲销`,
    )
  }
  if (sourceBalanceRow.status === 'closed') {
    // 重开余额行（同一键；不删除历史，重开即活动）
    await tools.inv.balances.adjust(
      sourceBalanceRow.id,
      { quantity: sourceBalanceRow.quantity, status: 'active', closedAt: null },
      pc.ctx.actorLoginName,
    )
  }
  const sourceBalance = await singleActiveBalance(tools, order.sourceUnitId)
  const sourceAfterQty = order.originalQty
  await writeLine(pc, {
    lineNo,
    movementKind: 'reverse',
    balance: sourceBalance,
    beforeQty: sourceBalance.quantity,
    afterQty: sourceAfterQty,
    unit: sourceUnit,
    reason,
    refType: 'reel_split_reverse_source',
    refId: order.id,
  })
  await tools.inv.units.updateStatus(
    sourceUnit.id,
    { status: 'in_stock', balanceOpen: true, balanceClosedAt: null },
    pc.ctx.actorLoginName,
  )

  const reversal = await tools.rework.reelSplits.insertReversal({
    reversalNo,
    sourceOrderId: order.id,
    sourceOrderNo: order.orderNo,
    reason,
    reversedBy: pc.ctx.actorLoginName,
    reversedAt: pc.businessTime,
    commandReceiptId: pc.commandReceiptId,
    plantId: order.plantId,
    enterpriseId: order.enterpriseId,
  })
  // RS-S1 append-only：主表不改写——reversed 状态由冲销事实行存在性派生（查询层 JOIN 投影）

  await tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'rework.reel-split.reverse',
    subjectType: 'reel_split_order',
    subjectId: order.id,
    before: { status: 'executed' },
    after: { status: 'reversed', reversalNo, sourceAfterQty },
    reason,
  })
  tools.outbox.collect({
    aggregateType: 'reel_split_order',
    aggregateId: order.id,
    taskKind: 'rework.reel-split-reversed',
    payload: { orderNo: order.orderNo, reversalNo, sourceAfterQty, businessTime: pc.businessTime },
  })
  return { reversalId: reversal.id, reversalNo, sourceAfterQty, reversedChildUnitIds: childUnitIdsAfter }
}

// ---------------- 分托/解绑（RS-13～RS-24） ----------------

async function palletTaskOf(
  tools: ReworkCommandTools,
  operator: { loginName: string; deptCategory: number | null; plantId: string },
  taskType: 'split_pallet' | 'unbind_pallet',
): Promise<PalletTaskRecord | null> {
  return tools.rework.palletTasks.findInProgress(operator.loginName, taskType)
}

async function ensurePalletTask(
  tools: ReworkCommandTools,
  pc: PostingContext,
  operator: { loginName: string; deptCategory: number | null; plantId: string },
  taskType: 'split_pallet' | 'unbind_pallet',
): Promise<PalletTaskRecord> {
  const existing = await palletTaskOf(tools, operator, taskType)
  if (existing !== null) return existing
  const taskNo = await tools.rework.palletTasks.nextTaskNo(pc.tools.now())
  return tools.rework.palletTasks.insert({
    taskNo,
    taskType,
    status: 'in_progress',
    operator: operator.loginName,
    operatorDeptCategory: operator.deptCategory,
    targetCarrierId: null,
    targetCarrierCode: null,
    warehouseId: null,
    warehouseCode: null,
    rackId: null,
    rackCode: null,
    locationId: null,
    locationCode: null,
    warehouseOfRecord: null,
    completedAt: null,
    firstScanAt: pc.businessTime,
    plantId: operator.plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
}

function palletScanFactsOf(row: PalletScanRow, args: {
  scannedInTask: boolean
  sameWarehouseAsScanned: boolean
  sameWarehouseAsTargetCarrier: boolean
}): Parameters<typeof assertPalletSplitScanAcceptable>[1] {
  return {
    unitNo: row.unitNo,
    exists: row.exists,
    isPalletCode: row.isPalletCode,
    multiMaterial: row.multiMaterial,
    inStock: row.inStock,
    inWarehouse: row.inWarehouse,
    boundCarrierId: row.boundCarrierId,
    boundCarrierCode: row.boundCarrierCode,
    warehouseId: row.warehouseId,
    lockedByOther: row.lockedByOther,
    scannedInTask: args.scannedInTask,
    sameWarehouseAsScanned: args.sameWarehouseAsScanned,
    sameWarehouseAsTargetCarrier: args.sameWarehouseAsTargetCarrier,
    warehouseLocked: row.warehouseLocked,
  }
}

/** RS-17/18：装入即锁定（作业预留：IT-23 四要素；有效期默认 8 小时，CA-5 建议待裁）。 */
async function acquirePalletLock(pc: PostingContext, unitId: string, quantity: string, taskNo: string): Promise<string> {
  const validUntil = new Date(pc.tools.now().getTime() + PALLET_RESERVATION_DEFAULT_HOURS * 3600_000).toISOString()
  const result = await (async () => {
    const tools = rwTools(pc)
    const units = await tools.inv.units.lockForUpdate([unitId])
    const unit = units[0]
    if (unit === undefined) throw new ReworkRuleViolation('RS-17', '库存单元不存在，不能锁定')
    const balances = await tools.inv.balances.listActiveByUnit(unitId)
    const balance = balances[0]
    if (balance === undefined) throw new ReworkRuleViolation('RS-17', '库存单元无活动余额，不能锁定')
    const active = await tools.inv.reservations.listActiveByUnit(unitId)
    const now = pc.tools.now().toISOString()
    for (const r of active) {
      if (new Date(r.validUntil).getTime() <= new Date(now).getTime()) continue
      if (r.holderRef !== taskNo) {
        throw new ReworkRuleViolation('RS-17', '该码已被其它业务锁定（装入前实时校验）')
      }
    }
    const reservation = await tools.inv.reservations.insert({
      unitId,
      locationId: balance.locationId,
      holderType: 'task',
      holderRef: taskNo,
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
    return reservation.id
  })()
  return result
}

async function releaseReservationOf(pc: PostingContext, reservationId: string, reason: string): Promise<void> {
  const tools = rwTools(pc)
  const reservation = await tools.inv.reservations.findById(reservationId)
  if (reservation === null || reservation.status !== 'active') return
  await tools.inv.reservations.release(reservationId, pc.ctx.actorLoginName, reason, pc.tools.now().toISOString())
}

async function palletScanTarget(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rwTools(pc)
  const operator = await operatorOf(tools, pc.ctx)
  await assertPlantScope(tools, operator.plantId)
  const carrierCode = requireStr(p, 'carrierCode', 'rework.pallet.scan-target')
  const task = await ensurePalletTask(tools, pc, operator, 'split_pallet')
  let carrier = await tools.rework.facts.carrierEverBound(carrierCode, operator.plantId)
  if (carrier === null) {
    // 新托：托码无任何料品码绑定史；carrier 档案不存在时即时建档（RS-15 新托判定按绑定史）
    const created = await tools.inv.carriers.insertCarrier({
      carrierCode,
      carrierKind: 'tray',
      plantId: operator.plantId,
      enterpriseId: pc.ctx.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
    carrier = {
      carrierId: created.id,
      everBound: false,
      warehouseId: null,
      warehouseCode: null,
      rackId: null,
      rackCode: null,
      locationId: null,
      locationCode: null,
    }
  }
  const palletKind = judgePalletNewOrOld(carrier.everBound)
  // RS-15：老托自动带出原托位置且不可改（新托非车间须手选库位或扫货架码后选层数）
  if (carrier !== null && palletKind === 'old') {
    await tools.rework.palletTasks.update(
      task.id,
      {
        targetCarrierId: carrier.carrierId,
        targetCarrierCode: carrierCode,
        warehouseId: carrier.warehouseId,
        warehouseCode: carrier.warehouseCode,
        rackId: carrier.rackId,
        rackCode: carrier.rackCode,
        locationId: carrier.locationId,
        locationCode: carrier.locationCode,
      },
      pc.ctx.actorLoginName,
      pc.businessTime,
    )
  } else {
    await tools.rework.palletTasks.update(
      task.id,
      { targetCarrierId: carrier?.carrierId ?? null, targetCarrierCode: carrierCode },
      pc.ctx.actorLoginName,
      pc.businessTime,
    )
  }
  await tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'rework.pallet.scan-target',
    subjectType: 'pallet_task',
    subjectId: task.id,
    after: { carrierCode, palletKind },
    reason: null,
  })
  return {
    taskId: task.id,
    taskNo: task.taskNo,
    carrierCode,
    palletKind,
    inheritedLocation: palletKind === 'old' && carrier !== null
      ? { warehouseId: carrier.warehouseId, rackId: carrier.rackId, locationId: carrier.locationId, locationCode: carrier.locationCode }
      : null,
  }
}

async function palletScanItem(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rwTools(pc)
  const operator = await operatorOf(tools, pc.ctx)
  await assertPlantScope(tools, operator.plantId)
  const taskTypeRaw = requireStr(p, 'taskType', 'rework.pallet.scan-item')
  if (taskTypeRaw !== 'split_pallet' && taskTypeRaw !== 'unbind_pallet') {
    throw new ReworkRuleViolation('RS-14', 'taskType 必须为 split_pallet 或 unbind_pallet')
  }
  const taskType = taskTypeRaw
  const unitNo = requireStr(p, 'unitNo', 'rework.pallet.scan-item')
  const task = await ensurePalletTask(tools, pc, operator, taskType)
  const row = await tools.rework.facts.palletScanRow(operator.plantId, unitNo, task.id, taskType)
  if (row.retired) {
    assertUnitNotRetired(true, unitNo) // RS-36
  }
  const existingLines = await tools.rework.palletTasks.listLines(task.id, true)
  const activeLines = existingLines.filter((l) => l.removedAt === null)
  const scannedInTask = activeLines.some((l) => l.unitNo === unitNo)
  const sameWarehouseAsScanned =
    activeLines.length === 0 || activeLines.every((l) => l.originalWarehouseId === row.warehouseId || l.originalWarehouseId === null)
  let sameWarehouseAsTargetCarrier = true
  if (taskType === 'split_pallet' && task.targetCarrierId !== null) {
    const carrierWarehouse = await tools.rework.facts.carrierWarehouseId(task.targetCarrierId)
    sameWarehouseAsTargetCarrier = carrierWarehouse === null || carrierWarehouse === row.warehouseId
  }
  const operatorFacts = { loginName: operator.loginName, deptCategory: operator.deptCategory }
  assertPalletScanScope(operatorFacts, palletScanFactsOf(row, { scannedInTask, sameWarehouseAsScanned, sameWarehouseAsTargetCarrier })) // RS-13 ①
  if (taskType === 'split_pallet') {
    assertPalletSplitScanAcceptable(operatorFacts, palletScanFactsOf(row, { scannedInTask, sameWarehouseAsScanned, sameWarehouseAsTargetCarrier })) // RS-16
  } else {
    assertPalletUnbindScanAcceptable(operatorFacts, palletScanFactsOf(row, { scannedInTask, sameWarehouseAsScanned, sameWarehouseAsTargetCarrier })) // RS-22
  }

  // RS-17/18：先取作业预留（装入即锁定，IT-23 四要素），再落扫入快照明细
  const balances = await tools.inv.balances.listActiveByUnit(row.unitId)
  const lockQty = balances.length > 0 ? balances.reduce((acc, b) => addQty(acc, b.quantity), '0.0000') : '0.0001'
  const reservationId = await acquirePalletLock(pc, row.unitId, lockQty, task.taskNo)
  const line = await tools.rework.palletTasks.insertLine({
    taskId: task.id,
    unitId: row.unitId,
    unitNo,
    originalCarrierId: row.boundCarrierId,
    originalCarrierCode: row.boundCarrierCode,
    originalWarehouseId: row.warehouseId,
    originalWarehouseCode: row.warehouseCode,
    originalRackId: row.rackId,
    originalRackCode: row.rackCode,
    originalLocationId: row.locationId,
    originalLocationCode: row.locationCode,
    reservationId,
    scannedAt: pc.businessTime,
    removedAt: null,
  })

  await tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'rework.pallet.scan-item',
    subjectType: 'pallet_task',
    subjectId: task.id,
    after: { taskType, unitNo, reservationId, snapshot: { carrier: row.boundCarrierCode, warehouse: row.warehouseCode, location: row.locationCode } },
    reason: null,
  })
  return { taskId: task.id, taskNo: task.taskNo, unitNo, reservationId, lineId: line.id }
}

async function palletSetLocation(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rwTools(pc)
  const operator = await operatorOf(tools, pc.ctx)
  await assertPlantScope(tools, operator.plantId)
  const task = await palletTaskOf(tools, operator, 'split_pallet')
  if (task === null) {
    throw new ReworkRuleViolation('RS-19', '尚无进行中的分托任务，不能选库位')
  }
  const locationId = requireStr(p, 'locationId', 'rework.pallet.set-location')
  const locationCode = str(p, 'locationCode') ?? locationId
  const warehouseId = str(p, 'warehouseId') ?? null
  const rackId = str(p, 'rackId') ?? null
  const carrier = task.targetCarrierId !== null
    ? await tools.rework.facts.carrierEverBound(task.targetCarrierCode ?? '', operator.plantId)
    : null
  const palletKind = judgePalletNewOrOld(carrier === null ? false : carrier.everBound)
  assertOldPalletLocationImmutable(palletKind, locationId, carrier?.locationId ?? null) // RS-15
  await tools.rework.palletTasks.update(
    task.id,
    {
      locationId,
      locationCode,
      warehouseId,
      warehouseCode: str(p, 'warehouseCode') ?? null,
      rackId,
      rackCode: str(p, 'rackCode') ?? null,
    },
    pc.ctx.actorLoginName,
    pc.businessTime,
  )
  return { taskId: task.id, locationId, palletKind }
}

async function palletRemoveItem(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rwTools(pc)
  const operator = await operatorOf(tools, pc.ctx)
  const unitNo = requireStr(p, 'unitNo', 'rework.pallet.remove-item')
  const taskTypeRaw = requireStr(p, 'taskType', 'rework.pallet.remove-item')
  const taskType = taskTypeRaw === 'unbind_pallet' ? 'unbind_pallet' : 'split_pallet'
  const task = await palletTaskOf(tools, operator, taskType as 'split_pallet' | 'unbind_pallet')
  if (task === null) {
    throw new ReworkRuleViolation('RS-17', '无进行中任务，不能删码')
  }
  assertPalletLineRemovable(task.status) // RS-17：已确认完成的单不允许再删码
  const lines = await tools.rework.palletTasks.listLines(task.id, true)
  const line = lines.find((l) => l.unitNo === unitNo && l.removedAt === null)
  if (line === undefined) {
    throw new ReworkRuleViolation('RS-17', `本次调整未扫过 ${unitNo}`)
  }
  if (line.reservationId !== null) {
    await releaseReservationOf(pc, line.reservationId, 'pallet.remove-item 删码解除锁定') // RS-17
  }
  await tools.rework.palletTasks.markLineRemoved(line.id, pc.businessTime)
  await tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'rework.pallet.remove-item',
    subjectType: 'pallet_task',
    subjectId: task.id,
    before: { unitNo },
    after: { removed: true },
    reason: null,
  })
  return { taskId: task.id, unitNo, removed: true }
}

async function palletConfirm(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rwTools(pc)
  const operator = await operatorOf(tools, pc.ctx)
  await assertPlantScope(tools, operator.plantId)
  const taskTypeRaw = requireStr(p, 'taskType', 'rework.pallet.confirm')
  const taskType = taskTypeRaw === 'unbind_pallet' ? 'unbind_pallet' : 'split_pallet'
  const task = await palletTaskOf(tools, operator, taskType as 'split_pallet' | 'unbind_pallet')
  if (task === null) {
    throw new ReworkRuleViolation('RS-19', '无进行中任务，不能确认')
  }
  const lines = (await tools.rework.palletTasks.listLines(task.id, false)).filter((l) => l.removedAt === null)
  const warehouseLocked = await tools.rework.facts.warehouseLocked(task.warehouseId)
  assertPalletConfirmable({
    operator: { loginName: operator.loginName, deptCategory: operator.deptCategory },
    task: {
      taskType: task.taskType,
      status: task.status,
      operator: task.operator,
      targetCarrierId: task.targetCarrierId,
      targetCarrierCode: task.targetCarrierCode,
      warehouseId: task.warehouseId,
      rackId: task.rackId,
      locationId: task.locationId,
      locationCode: task.locationCode,
    },
    scannedCount: lines.length,
    warehouseLocked,
  }) // RS-19/RS-13 ②

  const retiredIds = await tools.rework.retires.listRetiredUnitIds(lines.map((l) => l.unitId))
  if (retiredIds.length > 0) {
    assertUnitNotRetired(true, '涉及码') // RS-36
  }

  // RS-18：旧终端过期后提交必须重新校验——确认时点校验每条预留仍有效，冲突拒绝并提示重扫
  const nowIso = pc.tools.now().toISOString()
  for (const line of lines) {
    if (line.reservationId === null) continue
    const reservation = await tools.inv.reservations.findById(line.reservationId)
    if (reservation !== null && reservation.status === 'active') {
      assertPalletReservationUsable(reservation.validUntil, nowIso)
    }
  }

  const locked = await lockUnits(tools, lines.map((l) => l.unitId))
  const changes = planPalletConfirmChanges({
    operator: { loginName: operator.loginName, deptCategory: operator.deptCategory },
    task: {
      taskType: task.taskType,
      status: task.status,
      operator: task.operator,
      targetCarrierId: task.targetCarrierId,
      targetCarrierCode: task.targetCarrierCode,
      warehouseId: task.warehouseId,
      rackId: task.rackId,
      locationId: task.locationId,
      locationCode: task.locationCode,
    },
  }) // RS-13 ③/Rs-20

  // 分托必须已扫分入托码（RS-19；托码档案在 scan-target 时点建立）
  const targetCarrierId = task.targetCarrierId
  if (task.taskType === 'split_pallet' && targetCarrierId === null) {
    throw new ReworkRuleViolation('RS-19', '分托确认前必须已扫分入托码')
  }

  let lineNo = 1
  for (const line of lines) {
    const unit = locked.get(line.unitId)!
    // RS-20/23：改绑托码（分托）或清除托码（解绑）
    await tools.inv.carriers.unloadCurrentLoad(line.unitId, pc.ctx.actorLoginName, `pallet.confirm ${task.taskType}`, pc.businessTime)
    if (task.taskType === 'split_pallet' && targetCarrierId !== null) {
      await tools.inv.carriers.loadCarrier({
        carrierId: targetCarrierId,
        unitId: line.unitId,
        loadedBy: pc.ctx.actorLoginName,
        plantId: operator.plantId,
        enterpriseId: unit.enterpriseId,
      })
    }
    // RS-20：非车间同步改仓库/货架/库位（车间不改）；解绑位置不变（RS-23）。
    // 移库复用 inventory moveStock 同一记账序（两行各记一边、delta 非 0，IT-19/25）。
    if (task.taskType === 'split_pallet' && changes.moveLocation && changes.targetLocationId !== null) {
      const balances = await tools.inv.balances.listActiveByUnit(line.unitId)
      for (const balance of balances) {
        if (balance.locationId === changes.targetLocationId) continue
        await moveStock(pc, {
          unitId: line.unitId,
          quantity: balance.quantity,
          fromLocationId: balance.locationId,
          toLocationId: changes.targetLocationId,
          toLocationCode: task.locationCode ?? changes.targetLocationId,
          lineNoBase: lineNo,
          reason: `pallet.confirm ${task.taskNo}`,
          refType: 'pallet_task',
          refId: task.id,
        })
        lineNo += 2
      }
    }
    // RS-20：全部料品码解除锁定
    if (line.reservationId !== null) {
      await releaseReservationOf(pc, line.reservationId, `pallet.confirm ${task.taskNo} 确认解除锁定`)
    }
  }

  const warehouseOfRecord = lines.length > 0 ? (lines[0]!.originalWarehouseCode ?? null) : null
  await tools.rework.palletTasks.update(
    task.id,
    { status: 'completed', completedAt: pc.businessTime, warehouseOfRecord },
    pc.ctx.actorLoginName,
    pc.businessTime,
  )
  await tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'rework.pallet.confirm',
    subjectType: 'pallet_task',
    subjectId: task.id,
    before: { status: 'in_progress' },
    after: { status: 'completed', units: lines.map((l) => l.unitNo), targetCarrierCode: task.targetCarrierCode },
    reason: null,
  })
  tools.outbox.collect({
    aggregateType: 'pallet_task',
    aggregateId: task.id,
    taskKind: 'rework.pallet-confirmed',
    payload: { taskNo: task.taskNo, taskType: task.taskType, units: lines.map((l) => l.unitNo), businessTime: pc.businessTime },
  })
  return {
    taskId: task.id,
    taskNo: task.taskNo,
    taskType: task.taskType,
    movedUnits: lines.map((l) => l.unitNo),
    targetCarrierCode: task.targetCarrierCode,
  }
}

async function palletLeave(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rwTools(pc)
  const operator = await operatorOf(tools, pc.ctx)
  const taskTypeRaw = requireStr(p, 'taskType', 'rework.pallet.leave')
  const taskType = taskTypeRaw === 'unbind_pallet' ? 'unbind_pallet' : 'split_pallet'
  const task = await palletTaskOf(tools, operator, taskType as 'split_pallet' | 'unbind_pallet')
  if (task === null) {
    return { taskId: null, abandoned: false, note: '无进行中任务' }
  }
  const lines = (await tools.rework.palletTasks.listLines(task.id, false)).filter((l) => l.removedAt === null)
  const abandon = isPalletAbandonOnLeave(task.taskType, task.targetCarrierId !== null, lines.length) // RS-21/23
  if (abandon) {
    for (const line of lines) {
      if (line.reservationId !== null) {
        await releaseReservationOf(pc, line.reservationId, `pallet.leave 放弃解除锁定 ${task.taskNo}`)
      }
    }
    await tools.rework.palletTasks.update(
      task.id,
      { status: 'abandoned' },
      pc.ctx.actorLoginName,
      pc.businessTime,
    )
  }
  await tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'rework.pallet.leave',
    subjectType: 'pallet_task',
    subjectId: task.id,
    after: { abandoned: abandon },
    reason: null,
  })
  return { taskId: task.id, abandoned: abandon }
}

// ---------------- 轴号修正（RS-25～RS-33） ----------------

/** Initial axis metadata for an approved output. Order identity is read from report_output, never supplied by the caller. */
async function axisRegister(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rwTools(pc)
  if (!(await tools.actorPermissions()).includes('rework.post')) {
    throw new ReworkRuleViolation('RS-S1-SCOPE', '缺少轴号登记许可')
  }
  const operator = await operatorOf(tools, pc.ctx)
  await assertPlantScope(tools, operator.plantId)
  const unitNo = requireStr(p, 'unitNo', 'rework.axis-register')
  const unit = await tools.inv.units.findByUnitNo(operator.plantId, unitNo)
  if (unit === null || unit.enterpriseId !== pc.ctx.enterpriseId) {
    throw new ReworkRuleViolation('RS-S1-SCOPE', '库存单元不在本人工厂或企业')
  }
  await lockUnits(tools, [unit.id])
  const origin = await tools.rework.facts.axisRegistrationOrigin(unit.id)
  if (origin === null || origin.plantId !== operator.plantId || origin.enterpriseId !== pc.ctx.enterpriseId ||
      (str(p, 'sourceOrderId') !== undefined && str(p, 'sourceOrderId') !== origin.orderId)) {
    throw new ReworkRuleViolation('RS-25', '仅允许对本工厂已审核的真实生产产出登记，订单不得由载荷改写')
  }
  const row = await tools.rework.facts.correctionScanRow(operator.plantId, unitNo)
  assertCorrectionScannable({ ...row, qrPassed: true })
  if (row.retired) assertUnitNotRetired(true, unitNo)
  if (await tools.rework.axisNo.getState(unit.id)) {
    throw new ReworkRuleViolation('RS-27', '轴号已登记，变更须走轴号修正')
  }
  const customerAxisNo = requireStr(p, 'customerAxisNo', 'rework.axis-register')
  const segmentLength = requireStr(p, 'segmentLength', 'rework.axis-register')
  if (!isValidQuantityString(segmentLength) || cmpQty(segmentLength, '0') <= 0 || cmpQty(segmentLength, origin.outputQty) > 0) {
    throw new ReworkRuleViolation('RS-27', '段长必须为实际产出数量以内的正十进制数量')
  }
  const states = await tools.rework.axisNo.listByOrder(origin.salesOrderNo, operator.plantId)
  if (states.some(s => s.customerAxisNo === customerAxisNo)) {
    throw new ReworkRuleViolation('RS-27', '客户轴号已占用，不能通过初始登记重新分配')
  }
  const state = await tools.rework.axisNo.upsertState({ unitId: unit.id, unitNo: unit.unitNo,
    salesOrderNo: origin.salesOrderNo, orderLineNo: origin.lineNo, customerAxisNo, segmentLength,
    virtualAxisNo: str(p, 'virtualAxisNo') ?? null }, pc.ctx.actorLoginName, pc.businessTime)
  await tools.audit.record({ actor: pc.ctx.actorLoginName, action: 'rework.axis-register', subjectType: 'inventory_unit',
    subjectId: unit.id, after: { ...state, sourceOrderId: origin.orderId }, reason: pc.ctx.reason })
  return { state, sourceOrderId: origin.orderId, quantityChanged: false }
}

async function correctionSubmit(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rwTools(pc)
  const operator = await operatorOf(tools, pc.ctx)
  await assertPlantScope(tools, operator.plantId)
  const unitNo = requireStr(p, 'unitNo', 'rework.axis-correction.submit')
  const row = await tools.rework.facts.correctionScanRow(operator.plantId, unitNo)
  if (row.retired) {
    assertUnitNotRetired(true, unitNo) // RS-36
  }

  const state = row.unitId !== null ? await tools.rework.axisNo.getState(row.unitId) : null
  const orderStates = row.salesOrderNo !== null ? await tools.rework.axisNo.listByOrder(row.salesOrderNo, operator.plantId) : []
  const options: CorrectionOption[] = row.unitId !== null ? buildCorrectionOptions(orderStates, row.unitId) : []
  const submitFacts = {
    currentQty: row.currentQty ?? '0.0000',
    maxSingleReportQty: row.maxSingleReportQty,
    options,
    currentCustomerAxisNo: state?.customerAxisNo ?? null,
    currentSegmentLength: state?.segmentLength ?? null,
    occupiedUnitInWarehouse: false,
    occupiedUnitSold: false,
    occupiedUnitLocked: false,
  }
  const cutQty = assertCorrectionSubmitAcceptable(
    {
      cutQty: p['cutQty'],
      newCustomerAxisNo: str(p, 'newCustomerAxisNo') ?? null,
      newSegmentLength: str(p, 'newSegmentLength') ?? null,
      newVirtualAxisNo: str(p, 'newVirtualAxisNo') ?? null,
    },
    submitFacts,
  ) // RS-27

  // RS-30：占用核权（选中"已使用"轴号 → 权限＋强制理由＋审计）
  const targetOption = {
    newCustomerAxisNo: str(p, 'newCustomerAxisNo') ?? null,
    newSegmentLength: str(p, 'newSegmentLength') ?? null,
    newVirtualAxisNo: str(p, 'newVirtualAxisNo') ?? null,
  }
  const permissions = await tools.actorPermissions()
  assertCorrectionReassignAllowed({
    options,
    ...targetOption,
    hasPermission: permissions.includes(AXIS_REASSIGN_PERMISSION),
    reason: str(p, 'reassignReason') ?? pc.ctx.reason,
  })
  const occupiedOption = options.find(
    (o) =>
      o.used &&
      (o.customerAxisNo ?? '') === (targetOption.newCustomerAxisNo ?? '') &&
      (o.segmentLength ?? '') === (targetOption.newSegmentLength ?? '') &&
      (o.virtualAxisNo ?? '') === (targetOption.newVirtualAxisNo ?? ''),
  )
  let occupiedUnit: { unitId: string; unitNo: string } | null = null
  if (occupiedOption !== undefined && occupiedOption.occupiedByUnitId !== null) {
    occupiedUnit = { unitId: occupiedOption.occupiedByUnitId, unitNo: occupiedOption.occupiedByUnitNo ?? '' }
    const occRow = await tools.rework.facts.correctionOccupiedUnitRow(occupiedUnit.unitId)
    if (occRow !== null) {
      assertOccupiedUnitClearable({ ...submitFacts, occupiedUnitInWarehouse: occRow.inWarehouse, occupiedUnitSold: occRow.sold, occupiedUnitLocked: occRow.locked })
    }
  }

  // RS-31：截取数量单位随物料主计量单位
  if (row.materialPrimaryUomCode !== null) {
    assertCorrectionUomFollowsMaterial(str(p, 'uomCode') ?? row.materialPrimaryUomCode, row.materialPrimaryUomCode)
  }

  // RS-28：提交事务内重校验（防扫码与提交间的竞态）
  if (row.unitId === null) {
    throw new ReworkRuleViolation('RS-25', '码不存在（提交时重校验失败）')
  }
  const locked = await lockUnits(tools, [row.unitId])
  const unit = locked.get(row.unitId)!
  const recheck = await tools.rework.facts.correctionScanRow(operator.plantId, unitNo)
  if (recheck.unitId === null || recheck.locked || recheck.qualityPending || recheck.reportUnreviewed || recheck.sold) {
    throw new ReworkRuleViolation('RS-28', '扫码与提交间该码状态已变化（被锁定/入库/已销售等），请重新扫码')
  }
  const balance = await singleActiveBalance(tools, row.unitId)

  const correctionNo = await tools.rework.axisNo.nextCorrectionNo(pc.tools.now())
  // RS-29：新客户轴号原被其它码占用 → 先清空占用码的客户轴号/段长/虚拟轴号
  if (occupiedUnit !== null) {
    const occState = await tools.rework.axisNo.getState(occupiedUnit.unitId)
    if (occState !== null) {
      await tools.rework.axisNo.upsertState(
        { ...occState, customerAxisNo: null, segmentLength: null, virtualAxisNo: null },
        pc.ctx.actorLoginName,
        pc.businessTime,
      )
    }
  }
  // 数量按截取数量扣减
  const newQty = subQty(balance.quantity, cutQty)
  if (cmpQty(cutQty, '0') > 0) {
    const written = await writeLine(pc, {
      lineNo: 1, movementKind: 'adjust', balance, beforeQty: balance.quantity, afterQty: newQty, unit,
      reason: `axis-correction ${correctionNo}`, refType: 'axis_no_correction',
    })
    await closeUnitIfZero(pc, unit, written.closed)
  }
  // 本码轴号改新值
  await tools.rework.axisNo.upsertState(
    {
      unitId: row.unitId,
      unitNo,
      salesOrderNo: row.salesOrderNo ?? state?.salesOrderNo ?? '',
      orderLineNo: state?.orderLineNo ?? null,
      customerAxisNo: str(p, 'newCustomerAxisNo') ?? null,
      segmentLength: str(p, 'newSegmentLength') ?? null,
      virtualAxisNo: str(p, 'newVirtualAxisNo') ?? null,
    },
    pc.ctx.actorLoginName,
    pc.businessTime,
  )
  const record = await tools.rework.axisNo.insertCorrection({
    correctionNo,
    targetUnitId: row.unitId,
    targetUnitNo: unitNo,
    // RS-S5 对象版本引用：P1 单元行无版本列，以行锁时点 createdAt epoch 秒作最小可复核引用
    targetObjectVersion: Math.floor(new Date(unit.createdAt).getTime() / 1000),
    beforeCustomerAxisNo: state?.customerAxisNo ?? null,
    afterCustomerAxisNo: str(p, 'newCustomerAxisNo') ?? null,
    beforeSegmentLength: state?.segmentLength ?? null,
    afterSegmentLength: str(p, 'newSegmentLength') ?? null,
    beforeVirtualAxisNo: state?.virtualAxisNo ?? null,
    afterVirtualAxisNo: str(p, 'newVirtualAxisNo') ?? null,
    originalQty: balance.quantity,
    cutQty,
    newQty,
    uomId: balance.uomId,
    uomCode: balance.uomCode,
    status: 'completed',
    tookOverUnitId: occupiedUnit?.unitId ?? null,
    tookOverUnitNo: occupiedUnit?.unitNo ?? null,
    reassignReason: str(p, 'reassignReason') ?? pc.ctx.reason ?? null,
    correctedBy: pc.ctx.actorLoginName,
    correctedAt: pc.businessTime,
    withdrawnBy: null,
    withdrawnAt: null,
    commandReceiptId: pc.commandReceiptId,
    plantId: unit.plantId,
    enterpriseId: unit.enterpriseId,
    businessTime: pc.businessTime,
    createdBy: pc.ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'rework.axis-correction.submit',
    subjectType: 'axis_no_correction',
    subjectId: record.id,
    before: { unitNo, quantity: balance.quantity, customerAxisNo: state?.customerAxisNo ?? null },
    after: { correctionNo, cutQty, newQty, tookOverUnitNo: occupiedUnit?.unitNo ?? null },
    reason: str(p, 'reassignReason') ?? pc.ctx.reason ?? null,
  })
  tools.outbox.collect({
    aggregateType: 'axis_no_correction',
    aggregateId: record.id,
    taskKind: 'rework.axis-correction-submitted',
    payload: { correctionNo, unitNo, cutQty, newQty, businessTime: pc.businessTime },
  })
  return { correctionId: record.id, correctionNo, cutQty, newQty, tookOverUnitNo: occupiedUnit?.unitNo ?? null }
}

async function correctionWithdraw(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rwTools(pc)
  const correctionId = requireStr(p, 'correctionId', 'rework.axis-correction.withdraw')
  const record = await tools.rework.axisNo.findCorrectionById(correctionId)
  if (record === null) {
    throw new ReworkRuleViolation('RS-32', '修正记录不存在')
  }
  await assertPlantScope(tools, record.plantId)
  const permissions = await tools.actorPermissions()
  assertCorrectionWithdrawable(record.status, permissions.includes('rework.axis-correction.withdraw')) // RS-32
  // 回撤前按"扫码"同类规则重校验（operatorOf 保留未绑定工厂拒绝副作用）
  await operatorOf(tools, pc.ctx)
  const row = await tools.rework.facts.correctionScanRow(record.plantId, record.targetUnitNo)
  if (row.unitId === null || row.unitId !== record.targetUnitId) {
    throw new ReworkRuleViolation('RS-32', '修正目标码身份已变化，不能回撤（按记录绑定码 ID 校验失败）')
  }
  assertCorrectionScannable({
    qrPassed: true,
    unitNo: record.targetUnitNo,
    exists: row.exists,
    isPalletCode: row.isPalletCode,
    multiMaterial: row.multiMaterial,
    inLogisticsWarehouse: row.inLogisticsWarehouse,
    sold: row.sold,
    qualityPending: row.qualityPending,
    reportUnreviewed: row.reportUnreviewed,
    anomalyOpen: row.anomalyOpen,
    locked: row.locked,
    hasOrder: row.hasOrder,
    transitAxisPending: row.transitAxisPending,
  })
  if (row.retired) {
    assertUnitNotRetired(true, record.targetUnitNo) // RS-36
  }
  const downstream = await tools.rework.facts.correctionWithdrawDownstream(record.targetUnitId)
  assertCorrectionWithdrawNotBlocked(downstream) // RS-33

  const locked = await lockUnits(tools, [record.targetUnitId])
  const unit = locked.get(record.targetUnitId)!
  const balance = await singleActiveBalance(tools, record.targetUnitId)
  const restoredQty = addQty(balance.quantity, record.cutQty)
  if (cmpQty(record.cutQty, '0') > 0) {
    await writeLine(pc, {
      lineNo: 1, movementKind: 'adjust', balance, beforeQty: balance.quantity, afterQty: restoredQty, unit,
      reason: `axis-correction.withdraw ${record.correctionNo}`, refType: 'axis_no_correction_withdraw', refId: record.id,
    })
  }
  // 恢复修正前客户轴号/段长/虚拟轴号（按记录绑定码 ID，不按"数量最大"启发式重选）
  const state = await tools.rework.axisNo.getState(record.targetUnitId)
  await tools.rework.axisNo.upsertState(
    {
      unitId: record.targetUnitId,
      unitNo: record.targetUnitNo,
      salesOrderNo: state?.salesOrderNo ?? '',
      orderLineNo: state?.orderLineNo ?? null,
      customerAxisNo: record.beforeCustomerAxisNo,
      segmentLength: record.beforeSegmentLength,
      virtualAxisNo: record.beforeVirtualAxisNo,
    },
    pc.ctx.actorLoginName,
    pc.businessTime,
  )
  await tools.rework.axisNo.markWithdrawn(record.id, pc.ctx.actorLoginName, pc.businessTime)
  await tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'rework.axis-correction.withdraw',
    subjectType: 'axis_no_correction',
    subjectId: record.id,
    before: { status: 'completed', quantity: balance.quantity },
    after: { status: 'withdrawn', restoredQty },
    reason: str(p, 'reason') ?? null,
  })
  tools.outbox.collect({
    aggregateType: 'axis_no_correction',
    aggregateId: record.id,
    taskKind: 'rework.axis-correction-withdrawn',
    payload: { correctionNo: record.correctionNo, restoredQty, businessTime: pc.businessTime },
  })
  return { correctionId: record.id, status: 'withdrawn', restoredQty }
}

// ---------------- 轴码退役（RS-34～RS-37） ----------------

async function axisRetireExecute(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = rwTools(pc)
  const operator = await operatorOf(tools, pc.ctx)
  await assertPlantScope(tools, operator.plantId)
  const rawNos = p['unitNos']
  if (!Array.isArray(rawNos)) {
    throw new ReworkRuleViolation('RS-34', '载荷 unitNos 必须为数组')
  }
  const unitNos = [...new Set(rawNos.map((v) => String(v ?? '').trim()).filter((v) => v !== ''))]
  assertAxisRetireSelectionNonEmpty(unitNos.length) // RS-34 至少勾选一条
  const rows = await tools.rework.facts.axisRetireCandidateRows(operator.plantId, unitNos)
  if (rows.length !== unitNos.length) {
    throw new ReworkRuleViolation('RS-34', '存在无效码（不存在或非本厂），不能清空')
  }
  for (const row of rows) {
    if (row.retired) {
      assertUnitNotRetired(true, row.unitNo) // RS-36：退役码命令入口拒绝
    }
    assertAxisRetireCandidateExecutable({
      unitNo: row.unitNo,
      isProductAxisCode: row.isProductAxisCode,
      qualityCompleted: row.qualityCompleted,
      reportReviewed: row.reportReviewed,
      transitAxisPending: row.transitAxisPending,
      inFinishedGoodsStock: row.inFinishedGoodsStock,
    }) // RS-34
  }

  // RS-37：退役状态切换、清空记录、库存统计事件、审计一次事务完成
  const locked = await lockUnits(tools, rows.map((r) => r.unitId))
  const results: Array<{ unitNo: string; retireNo: string; retireRecordId: string; custodyUnitId: string; custodyQty: string }> = []
  let lineNo = 1
  for (const row of rows) {
    const unit = locked.get(row.unitId)!
    if (row.balanceId === null) {
      throw new ReworkRuleViolation('RS-34', `轴码 ${row.unitNo} 无活动余额，不能清空`)
    }
    const balances = await tools.inv.balances.listActiveByUnit(row.unitId)
    const balance = balances[0]
    if (balance === undefined) {
      throw new ReworkRuleViolation('RS-34', `轴码 ${row.unitNo} 无活动余额，不能清空`)
    }
    const retireNo = await tools.rework.retires.nextRetireNo(pc.tools.now())
    const written = await writeLine(pc, {
      lineNo,
      movementKind: 'adjust',
      balance,
      beforeQty: balance.quantity,
      afterQty: '0.0000',
      unit,
      reason: `axis-retire ${retireNo}`,
      refType: 'axis_retire',
    })
    await closeUnitIfZero(pc, unit, written.closed) // RS-10 同族：零余额关闭
    await tools.rework.retires.insertRetireState({
      unitId: row.unitId,
      unitNo: row.unitNo,
      retiredBy: pc.ctx.actorLoginName,
      retiredAt: pc.businessTime,
      commandReceiptId: pc.commandReceiptId,
      plantId: unit.plantId,
      enterpriseId: unit.enterpriseId,
    })
    const recordRow = await tools.rework.retires.insertRecord({
      retireNo,
      unitId: row.unitId,
      unitNo: row.unitNo,
      qtyBefore: balance.quantity,
      productionDept: row.productionDept,
      productionOrderNo: row.productionOrderNo,
      salesOrderNo: row.salesOrderNo,
      lineNo: row.lineNo,
      materialId: row.materialId,
      materialCode: row.materialCode,
      processName: row.processName,
      reportBy: row.reportBy,
      reportAt: row.reportAt,
      retiredBy: pc.ctx.actorLoginName,
      retiredAt: pc.businessTime,
      uomId: balance.uomId,
      uomCode: balance.uomCode,
      measurementBasis: balance.measurementBasis,
      conversionRevisionId: balance.conversionRevisionId,
      commandReceiptId: pc.commandReceiptId,
      plantId: unit.plantId,
      enterpriseId: unit.enterpriseId,
    })
    const lot = await tools.inv.lots.findById(unit.lotId)
    if (lot === null) throw new ReworkRuleViolation('RS-34', '原批次来源缺失，不能清码移存')
    const custody = await receiveGoods(pc, {
      plantId: unit.plantId, lineNo: lineNo + 1, quantity: balance.quantity,
      lotNo: lot.lotNo, lotKind: lot.kind, unitNo: `UNTAGGED-${recordRow.id}`,
      materialId: unit.materialId, materialCode: unit.materialCode,
      uomId: balance.uomId, uomCode: balance.uomCode, measurementBasis: balance.measurementBasis,
      locationId: balance.locationId, locationCode: balance.locationCode, ownerId: balance.ownerId, ownerName: balance.ownerName,
      qualityStatus: 'suspect', refType: 'axis_retire_custody', refId: recordRow.id,
      entryPurpose: 'axis_retire_physical_custody_relocation', reason: `原物移存，来源 ${row.unitId} / ${recordRow.id}`,
    })
    const custodyUnitId = String(custody['unitId'])
    await tools.inv.genealogy.insertEdge({ fromType: 'inventory_unit', fromId: row.unitId, toType: 'inventory_unit', toId: custodyUnitId,
      edgeKind: 'consumption', quantity: balance.quantity, uomId: balance.uomId, uomCode: balance.uomCode,
      measurementBasis: balance.measurementBasis, conversionRevisionId: balance.conversionRevisionId,
      commandReceiptId: pc.commandReceiptId, businessTime: pc.businessTime, plantId: unit.plantId, enterpriseId: unit.enterpriseId })
    await tools.audit.record({
      actor: pc.ctx.actorLoginName,
      action: 'rework.axis-retire.execute',
      subjectType: 'inventory_unit',
      subjectId: row.unitId,
      before: { unitNo: row.unitNo, quantity: balance.quantity },
      after: { retireNo, status: 'retired', custodyUnitId, custodyQty: balance.quantity },
      reason: str(p, 'reason') ?? null,
    })
    results.push({ unitNo: row.unitNo, retireNo, retireRecordId: recordRow.id, custodyUnitId, custodyQty: balance.quantity })
    lineNo += 2
  }
  // RS-37：异步部分（统计投影）经事件不阻塞主事务
  tools.outbox.collect({
    aggregateType: 'axis_retire',
    aggregateId: results[0]?.retireRecordId ?? 'batch',
    taskKind: 'rework.axis-retired',
    payload: { retired: results, businessTime: pc.businessTime },
  })
  return { retired: results }
}

// ---------------- 处理器装配 ----------------

type ReworkHandlerFn = (pc: PostingContext, p: Payload) => Promise<Record<string, unknown>>

/** 命令处理器清单（组合根装配进 PgCommandBus）。 */
export function createReworkCommandHandlers(): CommandHandler[] {
  const make = (commandType: string, fn: ReworkHandlerFn): CommandHandler => ({
    commandType,
    handle: (envelope, ctx, tools): Promise<HandlerOutcome> =>
      run(async () => {
        const reworkTools = tools as ReworkCommandTools
        const payload = (envelope.payload ?? {}) as Payload
        const pc = await buildPostingContext(reworkTools, ctx, commandType, envelope.operationId, payload)
        return fn(pc, payload)
      }),
  })

  return [
    make('rework.reel-split.execute', reelSplitExecute),
    make('rework.reel-split.reverse', reelSplitReverse),
    make('rework.pallet.scan-target', palletScanTarget),
    make('rework.pallet.scan-item', palletScanItem),
    make('rework.pallet.set-location', palletSetLocation),
    make('rework.pallet.remove-item', palletRemoveItem),
    make('rework.pallet.confirm', palletConfirm),
    make('rework.pallet.leave', palletLeave),
    make('rework.axis-register', axisRegister),
    make('rework.axis-correction.submit', correctionSubmit),
    make('rework.axis-correction.withdraw', correctionWithdraw),
    make('rework.axis-retire.execute', axisRetireExecute),
  ]
}
