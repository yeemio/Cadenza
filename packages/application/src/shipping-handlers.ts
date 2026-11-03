import { ERROR_CODES } from '@cadenza/contracts'
import {
  InventoryRuleViolation,
  buildPostingLine,
  cmpQty,
  ensureStableLockOrder,
  isValidQuantityString,
  subQty,
} from '@cadenza/domain'
 
import {
  ShippingRuleViolation,
  advanceLineProgress,
  applyScanRemoval,
  assertBindPalletReady,
  assertConfirmShippable,
  assertActualAxisRetryable,
  assertPackedPalletReadonly,
  assertPackingStartable,
  assertPlLinesShape,
  assertPlStep,
  assertScanLoadable,
  assertStatusSyncRetryable,
  assertSupplementaryAxisLoadable,
  deriveOrderStatus,
  readLineSnapshotSegment,
  resolveActualAxisSyncDecision,
  type ShipmentLineKind,
} from '@cadenza/domain'
 
import { assertOutboundQualityGate } from '@cadenza/domain'
import type { CommandHandler, HandlerOutcome } from './command-bus'
import { violationOutcome } from './inventory-handlers'
import { NOT_FOUND_RULE, buildPostingContext, type PostingContext } from './inventory-posting'
import type { ShippingCommandTools } from './shipping-repositories'

/**
 * shipping 域命令处理器（T14 分段装箱/发运；全部在命令总线事务内运行，命令事务即 UoW）。
 *
 * 命令面（11）：
 * - shipping.dc-composition.inbound：DC 分段/组成模拟入站（IF-04 dcId+销售订单号+行号幂等；
 *   缺组成数据→missing 标记；缺组织映射→隔离队列 IF-00.8）；
 * - shipping.pl.inbound：PL 模拟入站（IF-05 发货单号幂等；A-T14-1 外部下发禁手工新增——
 *   本通道即外部下发落库，无手工新增命令面；三类行规格断言 A-T14-3；缺 DC 组成→
 *   composition_missing 标记=生产订单行标黄数据源）；
 * - shipping.packing.create / packing.bind：打包任务（A-T14-4 先扫托码+选调入库位→逐行扫满→
 *   绑定托码；已打包托码库位只读）；
 * - shipping.scan.load / scan.delete / scan.supplement：扫码装入五拒一成（A-T14-3）、
 *   删码不满足退回待装箱、补码计入已扫件数（A-T14-5）；
 * - shipping.ship.confirm：确认出库（A-T14-7 仅待出库+应扫不足拒指名料品/段长；执行=已出库+
 *   出库人+完成时间+库存记已发货；Outbox 两行独立 A-T14-8）；
 * - shipping.sync.actual-axis.retry / sync.status.retry：两条回传重试（IF-06/IF-07 失败重试
 *   不重做已成功侧；快照重推不改当前值 IF-00.6）；
 * - shipping.photo.attach：装箱图附件元数据（A-T14-10 部分失败保留已成功）。
 *
 * 幂等/回执由 PgCommandBus 承担；规则违例以 [A-T14-x]/[IF-xx] 前缀返回（BUSINESS_REJECTION）。
 */

type Payload = Record<string, unknown>

/** Diagnostic exception: replay only this Inbox fact after business rollback. */
class QuarantinedShippingInbound extends ShippingRuleViolation {
  constructor(message: string, readonly persistRejectionDiagnostics: () => Promise<void>) {
    super('IF-00.8', message)
  }
}

function shippingViolationOutcome(error: ShippingRuleViolation): HandlerOutcome {
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
    if (error instanceof QuarantinedShippingInbound) {
      // Object.assign is compatible with the original HandlerOutcome type. The
      // new bus consumes this internal callback; the old bus keeps its old behavior.
      return Object.assign(shippingViolationOutcome(error), {
        persistRejectionDiagnostics: error.persistRejectionDiagnostics,
      })
    }
    if (error instanceof ShippingRuleViolation) return shippingViolationOutcome(error)
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
  if (v === undefined) throw new ShippingRuleViolation('A-T14-1', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

/** 组织范围二道防线（OA-24/26）。 */
async function assertPlantScope(tools: ShippingCommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new ShippingRuleViolation('A-S1', `目标工厂不在授权数据范围内（plant=${plantId}）`)
  }
}

function spTools(pc: PostingContext): ShippingCommandTools {
  return pc.tools as ShippingCommandTools
}

// ---------------- 命令：DC 分段/组成模拟入站（IF-04） ----------------

async function dcCompositionInbound(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = spTools(pc)
  const dcId = requireStr(p, 'dcId', 'shipping.dc-composition.inbound')
  const salesOrderNo = requireStr(p, 'salesOrderNo', 'shipping.dc-composition.inbound')
  const lineNoRaw = p['lineNo']
  const lineNo = typeof lineNoRaw === 'number' && Number.isInteger(lineNoRaw) && lineNoRaw >= 1 ? lineNoRaw : undefined
  if (lineNo === undefined) throw new ShippingRuleViolation('IF-04', 'lineNo 必须为正整数')
  const sourceSystem = str(p, 'sourceSystem') ?? 'DC'
  const plantId = str(p, 'plantId')
  const orgCode = str(p, 'orgCode')

  // IF-00.8：缺组织映射 → 隔离队列（非普通失败重试）
  if (plantId === undefined) {
    const persistQuarantine = async (): Promise<void> => {
      await tools.sp.quarantinedInbox.insertQuarantinedInbox({
        sourceSystem,
        organizationCode: orgCode ?? '',
        externalKey: `${dcId}+${salesOrderNo}+${lineNo}`,
        entityType: 'segment_composition',
        quarantineReason: '缺组织映射（route_key=segment_composition）：DC 分段/组成入隔离队列待人工补绑',
        payload: p,
      })
    }
    await persistQuarantine()
    throw new QuarantinedShippingInbound(`DC 组成 ${dcId} 缺组织映射（plantId），已写入隔离队列（QUARANTINED），不重复应用`, persistQuarantine)
  }
  await assertPlantScope(tools, plantId)

  const compositionRaw = p['composition']
  const composition =
    compositionRaw !== undefined && compositionRaw !== null && typeof compositionRaw === 'object' && !Array.isArray(compositionRaw)
      ? (compositionRaw as Record<string, unknown>)
      : null

  // IF-00.2/IF-04：dcId+销售订单号+行号幂等（重复报文幂等返回，不重复应用）
  const existing = await tools.sp.compositions.findByKey(dcId, salesOrderNo, lineNo)
  if (existing !== null) {
    const externalRevision = typeof p['externalRevision'] === 'number' ? (p['externalRevision'] as number) : null
    if (externalRevision !== null && existing.externalRevision !== null && externalRevision < existing.externalRevision) {
      throw new ShippingRuleViolation('IF-00.3', `外部修订号 ${externalRevision} 低于已应用修订 ${existing.externalRevision}（stale 不覆盖）`)
    }
    return { dcCompositionId: existing.id, dcId, salesOrderNo, lineNo, skipped: true, syncStatus: existing.syncStatus }
  }

  // A-T14-2：缺组成数据→missing 标记（生产订单行标黄+提示的数据源；GAP-D8 名单未定由查询侧消费）
  const record = await tools.sp.compositions.insert({
    dcId,
    salesOrderNo,
    lineNo,
    sourceSystem,
    externalRevision: typeof p['externalRevision'] === 'number' ? (p['externalRevision'] as number) : null,
    syncStatus: composition === null ? 'missing' : 'received',
    composition,
    missingMarkedAt: composition === null ? pc.businessTime : null,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'shipping.dc-composition.inbound',
    subjectType: 'dc_segment_composition',
    subjectId: record.id,
    after: { dcId, salesOrderNo, lineNo, syncStatus: record.syncStatus, hasComposition: composition !== null },
    reason: str(p, 'reason') ?? null,
  })
  return { dcCompositionId: record.id, dcId, salesOrderNo, lineNo, skipped: false, syncStatus: record.syncStatus }
}

// ---------------- 命令：PL 模拟入站（IF-05；A-T14-1/3） ----------------

async function plInbound(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = spTools(pc)
  const plNo = requireStr(p, 'plNo', 'shipping.pl.inbound')
  const salesOrderNo = requireStr(p, 'salesOrderNo', 'shipping.pl.inbound')
  const plantId = str(p, 'plantId')
  const orgCode = str(p, 'orgCode')

  if (plantId === undefined) {
    const persistQuarantine = async (): Promise<void> => {
      await tools.sp.quarantinedInbox.insertQuarantinedInbox({
        sourceSystem: str(p, 'sourceSystem') ?? 'PL',
        organizationCode: orgCode ?? '',
        externalKey: plNo,
        entityType: 'shipping_pl',
        quarantineReason: '缺组织映射（route_key=shipping_pl）：PL 入隔离队列待人工补绑（IF-00.8）',
        payload: p,
      })
    }
    await persistQuarantine()
    throw new QuarantinedShippingInbound(`发货单 ${plNo} 缺组织映射（plantId），已写入隔离队列（QUARANTINED），不重复应用`, persistQuarantine)
  }
  await assertPlantScope(tools, plantId)

  // IF-00.2/IF-05：发货单号幂等（重复下发幂等返回，不重复建）
  const existing = await tools.sp.orders.findByPlNo(plNo)
  if (existing !== null) {
    if (existing.plantId !== plantId) {
      throw new ShippingRuleViolation('A-S1', `发货单 ${plNo} 已存在于其它工厂（plant=${existing.plantId}）`)
    }
    return { orderId: existing.id, plNo, skipped: true, status: existing.status, created: 0 }
  }

  const linesPayload = p['lines']
  if (!Array.isArray(linesPayload)) throw new ShippingRuleViolation('A-T14-1', 'PL 载荷 lines 须为数组')
  const specs = linesPayload.map((raw, index) => {
    const l = (raw ?? {}) as Payload
    const kindRaw = str(l, 'lineKind')
    if (kindRaw !== 'pallet' && kindRaw !== 'axis_item' && kindRaw !== 'plain_item') {
      throw new ShippingRuleViolation('A-T14-3', `第 ${index + 1} 行 lineKind 必须为 pallet/axis_item/plain_item`)
    }
    const requiredRaw =
      l['requiredCount'] ?? (kindRaw === 'axis_item' ? 1 : undefined) ?? (kindRaw === 'pallet' ? l['totalAxes'] : l['pieces'])
    return {
      lineNo: typeof l['lineNo'] === 'number' && Number.isInteger(l['lineNo']) && (l['lineNo'] as number) >= 1
        ? (l['lineNo'] as number)
        : index + 1,
      lineKind: kindRaw as ShipmentLineKind,
      materialCode: str(l, 'materialCode') ?? '',
      salesOrderLineNo: str(l, 'salesOrderLineNo') ?? String((l['lineNo'] as number | undefined) ?? index + 1),
      requiredCount: typeof requiredRaw === 'number' && Number.isInteger(requiredRaw) ? requiredRaw : 0,
      customerAxisNo: str(l, 'customerAxisNo') ?? null,
      standardSegmentLength: dec(l, 'standardSegmentLength') ?? null,
      segmentLength: dec(l, 'segmentLength') ?? null,
      materialId: str(l, 'materialId') ?? null,
    }
  })
  // A-T14-3：三类行规格断言（有轴=客户轴号+标准段长；无轴=段长+件数；托盘=总轴数）
  assertPlLinesShape(specs.map((s) => ({ ...s, customerAxisNo: s.customerAxisNo ?? undefined })))

  // A-T14-2：缺组成数据标记（销售订单行无任何 DC 组成数据 → compositionMissing；标黄数据源）
  const compositions = await tools.sp.compositions.listBySalesOrder(salesOrderNo)
  const composedLineNos = new Set(compositions.filter((c) => c.composition !== null).map((c) => String(c.lineNo)))
  const compositionMissing = specs.some((s) => !composedLineNos.has(s.salesOrderLineNo))

  const order = await tools.sp.orders.insert({
    plNo,
    salesOrderNo,
    customerName: str(p, 'customerName') ?? null,
    sourceSystem: str(p, 'sourceSystem') ?? 'PL',
    externalRevision: typeof p['externalRevision'] === 'number' ? (p['externalRevision'] as number) : null,
    compositionMissing,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
    commandReceiptId: pc.commandReceiptId,
  })
  const lineResults: Array<Record<string, unknown>> = []
  for (const s of specs) {
    const line = await tools.sp.lines.insert({
      shipmentOrderId: order.id,
      lineNo: s.lineNo,
      lineKind: s.lineKind,
      materialId: s.materialId,
      materialCode: s.materialCode,
      salesOrderLineNo: s.salesOrderLineNo,
      customerAxisNo: s.lineKind === 'axis_item' ? s.customerAxisNo : null,
      standardSegmentLength: s.lineKind === 'axis_item' ? s.standardSegmentLength : null,
      segmentLength: s.lineKind === 'plain_item' ? s.segmentLength : null,
      requiredCount: s.requiredCount,
      packingStatus: s.lineKind === 'pallet' ? 'pending' : null,
      createdBy: pc.ctx.actorLoginName,
    })
    lineResults.push({ lineId: line.id, lineNo: line.lineNo, lineKind: line.lineKind })
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'shipping.pl.inbound',
    subjectType: 'shipment_order',
    subjectId: order.id,
    after: { plNo, salesOrderNo, lines: lineResults.length, compositionMissing, status: order.status },
    reason: str(p, 'reason') ?? null,
  })
  return { orderId: order.id, plNo, skipped: false, created: 1, compositionMissing, status: order.status, lines: lineResults }
}

// ---------------- 命令：打包任务创建/绑定（A-T14-4） ----------------

async function packingCreate(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = spTools(pc)
  const plantId = requireStr(p, 'plantId', 'shipping.packing.create')
  await assertPlantScope(tools, plantId)
  const shipmentOrderId = requireStr(p, 'shipmentOrderId', 'shipping.packing.create')
  const palletCode = requireStr(p, 'palletCode', 'shipping.packing.create')
  const toLocationId = requireStr(p, 'toLocationId', 'shipping.packing.create')
  const toLocationCode = requireStr(p, 'toLocationCode', 'shipping.packing.create')

  const order = await tools.sp.orders.lockById(shipmentOrderId)
  if (order === null) throw new ShippingRuleViolation(NOT_FOUND_RULE, '发货单不存在')
  if (order.plantId !== plantId) throw new ShippingRuleViolation('A-S1', '发货单不在目标工厂')
  const lines = await tools.sp.lines.listByOrder(order.id)
  const palletLines = lines.filter((l) => l.lineKind === 'pallet')
  // A-T14-4：先扫托码+选调入库位（货架码+层数拼位）
  assertPackingStartable({
    orderStatus: order.status,
    palletCode,
    toLocationId,
    toLocationCode,
    palletLineCount: palletLines.filter((l) => l.packingOrderId === null).length,
  })
  // A-T14-4：已打包托码库位只读（同托码已绑定 → 拒）
  const boundPacking = await tools.sp.packings.findBoundByPallet(palletCode)
  assertPackedPalletReadonly({
    palletCode,
    boundPackingExists: boundPacking !== null,
    existingPackingLocationId: boundPacking?.toLocationId ?? null,
    requestedLocationId: toLocationId,
  })

  const packingNo = `PK-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`
  const packing = await tools.sp.packings.insert({
    packingNo,
    shipmentOrderId: order.id,
    palletCode,
    toLocationId,
    toLocationCode,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
    commandReceiptId: pc.commandReceiptId,
  })
  // 托盘行挂接打包任务（打包状态 pending）
  const linked: string[] = []
  for (const line of palletLines.filter((l) => l.packingOrderId === null)) {
    await tools.sp.lines.updateProgress(
      line.id,
      { scannedCount: line.scannedCount, lineStatus: line.lineStatus, packingOrderId: packing.id, packingStatus: 'pending' },
      pc.ctx.actorLoginName,
    )
    linked.push(line.id)
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'shipping.packing.create',
    subjectType: 'packing_order',
    subjectId: packing.id,
    after: { packingNo, shipmentOrderId: order.id, palletCode, toLocationCode, linkedLines: linked.length },
    reason: str(p, 'reason') ?? null,
  })
  return { packingId: packing.id, packingNo, palletCode, toLocationCode, linkedLines: linked, status: packing.status }
}

async function packingBind(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = spTools(pc)
  const plantId = requireStr(p, 'plantId', 'shipping.packing.bind')
  await assertPlantScope(tools, plantId)
  const packingOrderId = requireStr(p, 'packingOrderId', 'shipping.packing.bind')

  const packing = await tools.sp.packings.lockById(packingOrderId)
  if (packing === null) throw new ShippingRuleViolation(NOT_FOUND_RULE, '打包任务不存在')
  if (packing.plantId !== plantId) throw new ShippingRuleViolation('A-S1', '打包任务不在目标工厂')
  const order = await tools.sp.orders.lockById(packing.shipmentOrderId)
  if (order === null) throw new ShippingRuleViolation(NOT_FOUND_RULE, '发货单不存在')

  const lines = await tools.sp.lines.listByOrder(order.id)
  const linkedLines = lines.filter((l) => l.packingOrderId === packing.id)
  const scannedOutside = lines.filter((l) => l.packingOrderId !== packing.id && l.lineKind === 'pallet' && l.scannedCount > 0)
  // A-T14-4：绑定托码前置——每行已扫完 + 托码 + 库位
  assertBindPalletReady({
    status: packing.status,
    palletCode: packing.palletCode,
    toLocationId: packing.toLocationId,
    lines: linkedLines.map((l) => ({ lineId: l.id, lineKind: l.lineKind, requiredCount: l.requiredCount, scannedCount: l.scannedCount, lineStatus: l.lineStatus })),
    scannedOutsidePallet: scannedOutside.length,
  })

  const bound = await tools.sp.packings.bind(
    packing.id,
    { boundBy: pc.ctx.actorLoginName, boundAt: pc.businessTime },
    pc.ctx.actorLoginName,
  )
  // 托盘行打包状态 → bound（已打包）
  for (const line of linkedLines) {
    await tools.sp.lines.updateProgress(
      line.id,
      { scannedCount: line.scannedCount, lineStatus: line.lineStatus, packingStatus: 'bound' },
      pc.ctx.actorLoginName,
    )
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'shipping.packing.bind',
    subjectType: 'packing_order',
    subjectId: packing.id,
    before: { status: packing.status },
    after: { status: bound?.status ?? 'bound', palletCode: packing.palletCode, lines: linkedLines.length },
    reason: str(p, 'reason') ?? null,
  })
  return { packingId: packing.id, status: 'bound', palletCode: packing.palletCode, boundLines: linkedLines.length, boundAt: bound?.boundAt ?? pc.businessTime }
}

// ---------------- 命令：扫码装入/删码/补码（A-T14-3/5） ----------------

/** 收集扫码校验事实（单元/余额/预留）。 */
async function collectUnitFacts(
  tools: ShippingCommandTools,
  plantId: string,
  unitNo: string,
): Promise<{
  unitId: string
  unitStatus: string
  qualityStatus: string
  lockedByOtherTask: boolean
  actualSegmentLength: string | null
}> {
  const unit = await tools.inv.units.findByUnitNo(plantId, unitNo)
  if (unit === null) throw new ShippingRuleViolation(NOT_FOUND_RULE, `库存单元 ${unitNo} 不存在`)
  const balances = await tools.inv.balances.listActiveByUnit(unit.id)
  const active = balances.filter((b) => b.status === 'active')
  if (active.length === 0) throw new ShippingRuleViolation(NOT_FOUND_RULE, `库存单元 ${unitNo} 无活动余额`)
  if (active.length > 1) {
    throw new ShippingRuleViolation('A-T14-3', `库存单元 ${unitNo} 存在 ${active.length} 条活动余额，装入须先收敛余额键`)
  }
  const balance = active[0]!
  const nowIso = tools.now().toISOString()
  const reservations = await tools.inv.reservations.listActiveByUnit(unit.id)
  const effective = reservations.filter((r) => r.status === 'active' && Date.parse(r.validUntil) >= Date.parse(nowIso))
  const segments = await tools.inv.segments.listByUnit(unit.id)
  const actualSegmentLength = segments.length > 0 ? segments[0]!.quantity : null
  return {
    unitId: unit.id,
    unitStatus: unit.status,
    qualityStatus: balance.qualityStatus,
    lockedByOtherTask: effective.length > 0,
    actualSegmentLength,
  }
}

async function scanLoad(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = spTools(pc)
  const plantId = requireStr(p, 'plantId', 'shipping.scan.load')
  await assertPlantScope(tools, plantId)
  const shipmentOrderId = requireStr(p, 'shipmentOrderId', 'shipping.scan.load')
  const lineId = requireStr(p, 'lineId', 'shipping.scan.load')
  const unitNo = requireStr(p, 'unitNo', 'shipping.scan.load')

  const order = await tools.sp.orders.lockById(shipmentOrderId)
  if (order === null) throw new ShippingRuleViolation(NOT_FOUND_RULE, '发货单不存在')
  if (order.plantId !== plantId) throw new ShippingRuleViolation('A-S1', '发货单不在目标工厂')
  if (order.status === 'shipped') throw new ShippingRuleViolation('A-T14-3', 'PL 已出库，不可再装入')
  const line = await tools.sp.lines.lockById(lineId)
  if (line === null || line.shipmentOrderId !== order.id) {
    throw new ShippingRuleViolation(NOT_FOUND_RULE, '备货行不存在或不属于该发货单')
  }

  const already = await tools.sp.scans.findActiveByOrderAndUnitNo(order.id, unitNo)
  const facts = await collectUnitFacts(tools, plantId, unitNo)
  // A-T14-3：五拒一成（未审核/存疑/被锁定/未关联销售订单行/无段长拒收）
  assertScanLoadable({
    unitNo,
    unitStatus: facts.unitStatus,
    qualityStatus: facts.qualityStatus,
    suspectHoldActive: facts.qualityStatus === 'suspect',
    lockedByOtherTask: facts.lockedByOtherTask,
    matchedLine: {
      lineId: line.id,
      lineKind: line.lineKind,
      segmentLength: readLineSnapshotSegment({
        lineKind: line.lineKind,
        standardSegmentLength: line.standardSegmentLength,
        segmentLength: line.segmentLength,
      }),
      requiredCount: line.requiredCount,
      scannedCount: line.scannedCount,
    },
    alreadyLoadedInOrder: already !== null,
  })

  const actualSegmentLength = dec(p, 'actualSegmentLength') ?? facts.actualSegmentLength
  const scan = await tools.sp.scans.insert({
    shipmentOrderId: order.id,
    shipmentLineId: line.id,
    scanKind: 'load',
    inventoryUnitId: facts.unitId,
    unitNo,
    customerAxisNo: line.customerAxisNo,
    actualSegmentLength,
    scannedBy: pc.ctx.actorLoginName,
    scannedAt: pc.businessTime,
    commandReceiptId: pc.commandReceiptId,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  // A-T14-3：行扫满→已装箱；全部行扫满→待出库
  const progress = advanceLineProgress({ scannedCount: line.scannedCount, requiredCount: line.requiredCount })
  await tools.sp.lines.updateProgress(
    line.id,
    {
      scannedCount: progress.scannedCount,
      lineStatus: progress.lineStatus,
      ...(line.lineKind === 'axis_item' && actualSegmentLength !== undefined ? { actualSegmentLength } : {}),
    },
    pc.ctx.actorLoginName,
  )
  const allLines = await tools.sp.lines.listByOrder(order.id)
  const nextStatus = deriveOrderStatus(allLines.map((l) => (l.id === line.id ? progress.lineStatus : l.lineStatus)))
  if (nextStatus !== order.status) {
    assertPlStep(order.status, nextStatus)
    await tools.sp.orders.updateStatus(order.id, { status: nextStatus }, pc.ctx.actorLoginName)
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'shipping.scan.load',
    subjectType: 'packing_scan',
    subjectId: scan.id,
    after: { unitNo, lineId: line.id, lineNo: line.lineNo, scanned: progress.scannedCount, required: line.requiredCount, orderStatus: nextStatus },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'shipment_order',
    aggregateId: order.id,
    taskKind: 'shipping.scan-loaded',
    payload: { orderId: order.id, plNo: order.plNo, scanId: scan.id, unitNo, lineId: line.id, lineNo: line.lineNo, scanned: progress.scannedCount, required: line.requiredCount },
  })
  return {
    scanId: scan.id,
    unitNo,
    lineId: line.id,
    scannedCount: progress.scannedCount,
    requiredCount: line.requiredCount,
    lineStatus: progress.lineStatus,
    orderStatus: nextStatus,
  }
}

async function scanDelete(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = spTools(pc)
  const plantId = requireStr(p, 'plantId', 'shipping.scan.delete')
  await assertPlantScope(tools, plantId)
  const shipmentOrderId = requireStr(p, 'shipmentOrderId', 'shipping.scan.delete')
  const scanId = requireStr(p, 'scanId', 'shipping.scan.delete')

  const order = await tools.sp.orders.lockById(shipmentOrderId)
  if (order === null) throw new ShippingRuleViolation(NOT_FOUND_RULE, '发货单不存在')
  if (order.plantId !== plantId) throw new ShippingRuleViolation('A-S1', '发货单不在目标工厂')
  const scan = await tools.sp.scans.findById(scanId)
  if (scan === null || scan.shipmentOrderId !== order.id) throw new ShippingRuleViolation(NOT_FOUND_RULE, '扫码记录不存在或不属于该发货单')
  if (scan.deleted) throw new ShippingRuleViolation('A-T14-3', '扫码记录已删除，不可重复删码')

  const line = await tools.sp.lines.lockById(scan.shipmentLineId)
  if (line === null) throw new ShippingRuleViolation(NOT_FOUND_RULE, '备货行不存在')
  // A-T14-3：删码不满足退回待装箱（行回退+单重推）
  const removal = applyScanRemoval({
    orderStatus: order.status,
    lineStatus: line.lineStatus,
    scannedCount: line.scannedCount,
    requiredCount: line.requiredCount,
  })
  await tools.sp.scans.markDeleted(scan.id, { deletedBy: pc.ctx.actorLoginName, deletedAt: pc.businessTime }, pc.ctx.actorLoginName)
  await tools.sp.lines.updateProgress(
    line.id,
    { scannedCount: removal.scannedCount, lineStatus: removal.lineStatus },
    pc.ctx.actorLoginName,
  )
  const allLines = await tools.sp.lines.listByOrder(order.id)
  const nextStatus = deriveOrderStatus(allLines.map((l) => (l.id === line.id ? removal.lineStatus : l.lineStatus)))
  if (nextStatus !== order.status) {
    await tools.sp.orders.updateStatus(order.id, { status: nextStatus }, pc.ctx.actorLoginName)
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'shipping.scan.delete',
    subjectType: 'packing_scan',
    subjectId: scan.id,
    before: { deleted: false, scanned: line.scannedCount },
    after: { deleted: true, scanned: removal.scannedCount, lineStatus: removal.lineStatus, orderStatus: nextStatus },
    reason: str(p, 'reason') ?? null,
  })
  return { scanId: scan.id, deleted: true, scannedCount: removal.scannedCount, lineStatus: removal.lineStatus, orderStatus: nextStatus }
}

async function scanSupplement(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = spTools(pc)
  const plantId = requireStr(p, 'plantId', 'shipping.scan.supplement')
  await assertPlantScope(tools, plantId)
  const shipmentOrderId = requireStr(p, 'shipmentOrderId', 'shipping.scan.supplement')
  const lineId = requireStr(p, 'lineId', 'shipping.scan.supplement')
  const unitNo = requireStr(p, 'unitNo', 'shipping.scan.supplement')

  const order = await tools.sp.orders.lockById(shipmentOrderId)
  if (order === null) throw new ShippingRuleViolation(NOT_FOUND_RULE, '发货单不存在')
  if (order.plantId !== plantId) throw new ShippingRuleViolation('A-S1', '发货单不在目标工厂')
  if (order.status === 'shipped') throw new ShippingRuleViolation('A-T14-5', 'PL 已出库，不可再补码')
  const line = await tools.sp.lines.lockById(lineId)
  if (line === null || line.shipmentOrderId !== order.id) {
    throw new ShippingRuleViolation(NOT_FOUND_RULE, '备货行不存在或不属于该发货单')
  }
  // A-T14-5：补码——无轴行缺产品轴号时扫码补轴号（无数量输入，计入已扫件数）
  assertSupplementaryAxisLoadable({
    lineKind: line.lineKind,
    scannedCount: line.scannedCount,
    requiredCount: line.requiredCount,
    unitNo,
  })
  const already = await tools.sp.scans.findActiveByOrderAndUnitNo(order.id, unitNo)
  if (already !== null) throw new ShippingRuleViolation('A-T14-5', `轴号 ${unitNo} 已登记本单且未删除，拒绝重复补码`)

  const actualSegmentLength = dec(p, 'actualSegmentLength') ?? line.segmentLength
  const scan = await tools.sp.scans.insert({
    shipmentOrderId: order.id,
    shipmentLineId: line.id,
    scanKind: 'supplement',
    inventoryUnitId: null, // 补码=轴号登记（缺产品轴号场景），不要求库存单元绑定
    unitNo,
    customerAxisNo: null,
    actualSegmentLength,
    scannedBy: pc.ctx.actorLoginName,
    scannedAt: pc.businessTime,
    commandReceiptId: pc.commandReceiptId,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  const progress = advanceLineProgress({ scannedCount: line.scannedCount, requiredCount: line.requiredCount })
  await tools.sp.lines.updateProgress(
    line.id,
    { scannedCount: progress.scannedCount, lineStatus: progress.lineStatus },
    pc.ctx.actorLoginName,
  )
  const allLines = await tools.sp.lines.listByOrder(order.id)
  const nextStatus = deriveOrderStatus(allLines.map((l) => (l.id === line.id ? progress.lineStatus : l.lineStatus)))
  if (nextStatus !== order.status) {
    assertPlStep(order.status, nextStatus)
    await tools.sp.orders.updateStatus(order.id, { status: nextStatus }, pc.ctx.actorLoginName)
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'shipping.scan.supplement',
    subjectType: 'packing_scan',
    subjectId: scan.id,
    after: { unitNo, lineId: line.id, scanned: progress.scannedCount, required: line.requiredCount, orderStatus: nextStatus },
    reason: str(p, 'reason') ?? null,
  })
  return {
    scanId: scan.id,
    unitNo,
    lineId: line.id,
    scanKind: 'supplement',
    scannedCount: progress.scannedCount,
    requiredCount: line.requiredCount,
    lineStatus: progress.lineStatus,
    orderStatus: nextStatus,
  }
}

// ---------------- 确认出库：库存已发运记账（A-T14-7；IT-25 同一记账序） ----------------

/**
 * 单单元发运记账（与 inventory-posting.issueMaterial 同一记账序：锁单元→校验→流水（含扣前/
 * 扣后）→分录→余额（零余额关闭）→单元状态轴 shipped（IT-13：库存记已发货）；lineNo 随单元递增。
 */
async function shipUnitLine(
  pc: PostingContext,
  spec: {
    lineNo: number
    unit: { id: string; unitNo: string; lotId: string | null; plantId: string; enterpriseId: string }
    balance: {
      id: string
      locationId: string
      locationCode: string
      ownerId: string
      ownerName: string
      quantity: string
      uomId: string
      uomCode: string
      measurementBasis: string
      conversionRevisionId: string | null
      lotId?: string | null
    }
    orderId: string
    plNo: string
  },
): Promise<{ transactionId: string }> {
  const inv = spTools(pc).inv
  const actor = pc.ctx.actorLoginName
  const beforeQty = spec.balance.quantity
  const afterQty = '0.0000' // 发运=整单元记已发货（余额关闭，IT-29 身份保留）
  const postingLine = buildPostingLine({
    lineNo: spec.lineNo,
    movementKind: 'issue',
    beforeQty,
    deltaQty: subQty(afterQty, beforeQty),
    uomId: spec.balance.uomId,
  })
  const inserted = await inv.transactions.insertLine({
    commandReceiptId: pc.commandReceiptId,
    lineNo: spec.lineNo,
    movementKind: 'issue',
    unitId: spec.unit.id,
    lotId: spec.unit.lotId,
    balanceId: spec.balance.id,
    fromLocationId: spec.balance.locationId,
    fromLocationCode: spec.balance.locationCode,
    fromOwnerId: spec.balance.ownerId,
    fromOwnerName: spec.balance.ownerName,
    quantity: subQty(afterQty, beforeQty),
    uomId: spec.balance.uomId,
    uomCode: spec.balance.uomCode,
    measurementBasis: spec.balance.measurementBasis,
    conversionRevisionId: spec.balance.conversionRevisionId,
    beforeQty: postingLine.beforeQty,
    afterQty: postingLine.afterQty,
    refType: 'shipment_order',
    refId: spec.orderId,
    reason: `发运出库 ${spec.plNo}`,
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
    quantityDelta: subQty(afterQty, beforeQty),
    beforeQty: postingLine.beforeQty,
    afterQty: postingLine.afterQty,
    purpose: 'shipment_outbound',
    plantId: spec.unit.plantId,
    enterpriseId: spec.unit.enterpriseId,
    createdBy: actor,
  })
  await inv.balances.adjust(
    spec.balance.id,
    { quantity: afterQty, status: 'closed', closedAt: pc.businessTime },
    actor,
  )
  // IT-13：状态轴 → shipped（库存记已发货；IT-29 零余额关闭、身份与谱系保留）
  await inv.units.updateStatus(
    spec.unit.id,
    { status: 'shipped', balanceOpen: false, balanceClosedAt: pc.businessTime },
    actor,
  )
  return { transactionId: inserted.id }
}

// ---------------- 命令：确认出库（A-T14-7/8） ----------------

async function shipConfirm(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = spTools(pc)
  const plantId = requireStr(p, 'plantId', 'shipping.ship.confirm')
  await assertPlantScope(tools, plantId)
  const shipmentOrderId = requireStr(p, 'shipmentOrderId', 'shipping.ship.confirm')

  const order = await tools.sp.orders.lockById(shipmentOrderId)
  if (order === null) throw new ShippingRuleViolation(NOT_FOUND_RULE, '发货单不存在')
  if (order.plantId !== plantId) throw new ShippingRuleViolation('A-S1', '发货单不在目标工厂')
  const lines = await tools.sp.lines.listByOrder(order.id)
  // A-T14-7：仅待出库；任一行已扫<应扫拒并指名料品/段长
  assertConfirmShippable({
    orderStatus: order.status,
    lines: lines.map((l) => ({
      lineId: l.id,
      lineNo: l.lineNo,
      materialCode: l.materialCode,
      segmentLabel: readLineSnapshotSegment({
        lineKind: l.lineKind,
        standardSegmentLength: l.standardSegmentLength,
        segmentLength: l.segmentLength,
      }),
      requiredCount: l.requiredCount,
      scannedCount: l.scannedCount,
    })),
  })

  const scans = (await tools.sp.scans.listByOrder(order.id)).filter((s) => !s.deleted)
  // 锁定全部已扫库存单元（IT-25 稳定次序）
  const unitIds = [...new Set(scans.map((s) => s.inventoryUnitId).filter((id): id is string => id !== null))]
  const lockedUnits = await tools.inv.units.lockForUpdate(ensureStableLockOrder(unitIds))
  if (lockedUnits.length !== unitIds.length) {
    throw new ShippingRuleViolation(NOT_FOUND_RULE, '存在已扫但不可锁定的库存单元（状态已变）')
  }
  const unitById = new Map(lockedUnits.map((u) => [u.id, u]))

  // 逐单元：余额收敛+质量闸门复检（A-T12-4 严格模式；存疑恒拒）+无外来锁定 → 记已发货
  const nowIso = tools.now().toISOString()
  let lineNo = 0
  const posted: Array<Record<string, unknown>> = []
  for (const scan of scans) {
    if (scan.inventoryUnitId === null) continue // 补码登记（无库存单元绑定）不参与库存记账
    const unit = unitById.get(scan.inventoryUnitId)!
    if((await tools.inv.units.businessHolds(unit.id)).length>0)throw new ShippingRuleViolation('IT-BUSINESS-HOLD',`库存单元 ${unit.unitNo} 处于业务留置，拒绝出库`)
    const balances = await tools.inv.balances.listActiveByUnit(unit.id)
    const active = balances.filter((b) => b.status === 'active')
    if (active.length === 0) throw new ShippingRuleViolation(NOT_FOUND_RULE, `库存单元 ${unit.unitNo} 无活动余额，不可发运`)
    if (active.length > 1) {
      throw new ShippingRuleViolation('A-T14-7', `库存单元 ${unit.unitNo} 存在 ${active.length} 条活动余额，发运须先收敛余额键`)
    }
    const balance = active[0]!
    if (cmpQty(balance.quantity, '0.0000') <= 0) {
      throw new ShippingRuleViolation('A-T14-7', `库存单元 ${unit.unitNo} 余额为零，不可发运`)
    }
    assertOutboundQualityGate({
      qualityStatus: balance.qualityStatus,
      policy: { allowUnfinishedOutbound: false },
      unitNo: unit.unitNo,
      action: '确认出库',
    })
    const reservations = await tools.inv.reservations.listActiveByUnit(unit.id)
    const effective = reservations.filter((r) => r.status === 'active' && Date.parse(r.validUntil) >= Date.parse(nowIso))
    if (effective.length > 0) {
      throw new ShippingRuleViolation('A-T14-7', `库存单元 ${unit.unitNo} 被其它业务锁定（活动作业预留），拒绝出库`)
    }
    lineNo += 1
    const written = await shipUnitLine(pc, {
      lineNo,
      unit,
      balance,
      orderId: order.id,
      plNo: order.plNo,
    })
    posted.push({ unitId: unit.id, unitNo: unit.unitNo, transactionId: written.transactionId, quantity: balance.quantity })
  }

  // A-T14-8/IF-06：实发轴差异判定（按行快照客户轴号 vs 装入实发轴号；出库时点快照）
  const plannedCustomerAxes = lines.filter((l) => l.lineKind === 'axis_item' && l.customerAxisNo !== null).map((l) => l.customerAxisNo!)
  const actualAxes = scans.filter((s) => s.scanKind === 'load').map((s) => s.unitNo)
  const decision = resolveActualAxisSyncDecision({ plannedCustomerAxes, actualAxes })

  // A-T14-7：执行=已出库+出库人+完成时间+库存记已发货（上面逐单元已记）；双回传状态列独立落库
  const outboundAt = pc.businessTime
  const shippedOrder = await tools.sp.orders.markShipped(
    order.id,
    {
      outboundBy: pc.ctx.actorLoginName,
      outboundAt,
      actualAxisSyncStatus: decision.status,
      shippingStatusSyncStatus: 'pending',
      actualAxisSnapshot: {
        plannedCustomerAxes,
        actualAxes,
        missingOnActual: decision.missingOnActual,
        extraOnActual: decision.extraOnActual,
        decidedAt: outboundAt,
      },
      // IF-00.6：发货状态重推载荷=出库完成时点快照（重试按快照，不推当前值）
      statusSyncSnapshot: { plNo: order.plNo, salesOrderNo: order.salesOrderNo, status: 'shipped', completedAt: outboundAt },
    },
    pc.ctx.actorLoginName,
  )

  // A-T14-8/IF-00.5：两条回传独立 Outbox 任务行（复合身份：聚合+任务种类）
  spTools(pc).outbox.collect(
    {
      aggregateType: 'shipment_order',
      aggregateId: order.id,
      taskKind: 'shipping.actual-axis-sync',
      payload: { orderId: order.id, plNo: order.plNo, plannedCustomerAxes, actualAxes, missingOnActual: decision.missingOnActual, extraOnActual: decision.extraOnActual, decidedAt: outboundAt },
    },
    { status: decision.hasDiff ? 'PENDING' : 'NOOP_NEEDED' },
  )
  spTools(pc).outbox.collect(
    {
      aggregateType: 'shipment_order',
      aggregateId: order.id,
      taskKind: 'shipping.status-sync',
      payload: shippedOrder?.statusSyncSnapshot ?? { plNo: order.plNo, status: 'shipped', completedAt: outboundAt },
    },
  )

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'shipping.ship.confirm',
    subjectType: 'shipment_order',
    subjectId: order.id,
    before: { status: order.status },
    after: {
      status: 'shipped',
      outboundBy: pc.ctx.actorLoginName,
      outboundAt,
      postedUnits: posted.length,
      actualAxisSyncStatus: decision.status,
      shippingStatusSyncStatus: 'pending',
    },
    reason: str(p, 'reason') ?? null,
  })
  return {
    orderId: order.id,
    plNo: order.plNo,
    status: 'shipped',
    outboundBy: pc.ctx.actorLoginName,
    outboundAt,
    postedUnits: posted.length,
    posted,
    actualAxisSyncStatus: decision.status,
    actualAxisDiff: decision.hasDiff
      ? { missingOnActual: decision.missingOnActual, extraOnActual: decision.extraOnActual }
      : null,
    shippingStatusSyncStatus: 'pending',
  }
}

// ---------------- 命令：两条回传重试（IF-06/IF-07/IF-00.6/IF-00.7） ----------------

async function syncActualAxisRetry(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = spTools(pc)
  const plantId = requireStr(p, 'plantId', 'shipping.sync.actual-axis.retry')
  await assertPlantScope(tools, plantId)
  const shipmentOrderId = requireStr(p, 'shipmentOrderId', 'shipping.sync.actual-axis.retry')

  const order = await tools.sp.orders.lockById(shipmentOrderId)
  if (order === null) throw new ShippingRuleViolation(NOT_FOUND_RULE, '发货单不存在')
  if (order.plantId !== plantId) throw new ShippingRuleViolation('A-S1', '发货单不在目标工厂')
  // IF-06：已成功侧（synced/noop_needed 终态）不重做
  const gate = assertActualAxisRetryable({ orderStatus: order.status, currentStatus: order.actualAxisSyncStatus })
  if (gate.skipped) {
    return { orderId: order.id, task: 'actual-axis-sync', skipped: true, status: order.actualAxisSyncStatus, dispatched: false }
  }
  const task = await tools.sp.outboxTasks.findLatestByTask('shipment_order', order.id, 'shipping.actual-axis-sync')
  if (task === null) {
    throw new ShippingRuleViolation(NOT_FOUND_RULE, '实发轴同步任务行缺失（无任务不重推，不按当前值重建）')
  }
  // IF-00.6：按出库时点快照重推（task.payload 固化于确认出库时；不重算当前扫码集合）
  const outcome = str(p, 'outcome') === 'failure' ? 'failure' : 'success'
  if (outcome === 'success') {
    await tools.sp.outboxTasks.markStatus(task.eventId, { status: 'DISPATCHED' })
    await tools.sp.orders.updateSyncStatus(order.id, { actualAxisSyncStatus: 'synced' }, pc.ctx.actorLoginName)
  } else {
    await tools.sp.outboxTasks.markStatus(task.eventId, { status: 'SYNC_FAILED', lastError: '模拟适配器返回失败（GAP-B7 重试）' })
    await tools.sp.orders.updateSyncStatus(order.id, { actualAxisSyncStatus: 'sync_failed' }, pc.ctx.actorLoginName)
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'shipping.sync.actual-axis.retry',
    subjectType: 'shipment_order',
    subjectId: order.id,
    before: { actualAxisSyncStatus: order.actualAxisSyncStatus, taskStatus: task.status },
    after: { outcome, snapshotPayload: task.payload },
    reason: str(p, 'reason') ?? null,
  })
  return {
    orderId: order.id,
    task: 'actual-axis-sync',
    skipped: false,
    outcome,
    dispatched: outcome === 'success',
    status: outcome === 'success' ? 'synced' : 'sync_failed',
    snapshot: task.payload,
  }
}

async function syncStatusRetry(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = spTools(pc)
  const plantId = requireStr(p, 'plantId', 'shipping.sync.status.retry')
  await assertPlantScope(tools, plantId)
  const shipmentOrderId = requireStr(p, 'shipmentOrderId', 'shipping.sync.status.retry')

  const order = await tools.sp.orders.lockById(shipmentOrderId)
  if (order === null) throw new ShippingRuleViolation(NOT_FOUND_RULE, '发货单不存在')
  if (order.plantId !== plantId) throw new ShippingRuleViolation('A-S1', '发货单不在目标工厂')
  const task = await tools.sp.outboxTasks.findLatestByTask('shipment_order', order.id, 'shipping.status-sync')
  if (task === null) {
    throw new ShippingRuleViolation(NOT_FOUND_RULE, '发货状态同步任务行缺失（无任务不重推，不按当前值重建）')
  }
  const snapshotCompletedAt =
    typeof task.payload['completedAt'] === 'string' ? (task.payload['completedAt'] as string) : null
  // IF-07/IF-00.6：仅已出库；已成功侧不重做；载荷固化时点快照不可改推当前值
  const gate = assertStatusSyncRetryable({
    orderStatus: order.status,
    currentStatus: order.shippingStatusSyncStatus,
    snapshotCompletedAt,
    orderCompletedAt: order.outboundAt,
  })
  if (gate.skipped) {
    return { orderId: order.id, task: 'status-sync', skipped: true, status: order.shippingStatusSyncStatus, dispatched: false }
  }
  const outcome = str(p, 'outcome') === 'failure' ? 'failure' : 'success'
  if (outcome === 'success') {
    await tools.sp.outboxTasks.markStatus(task.eventId, { status: 'DISPATCHED' })
    await tools.sp.orders.updateSyncStatus(order.id, { shippingStatusSyncStatus: 'synced' }, pc.ctx.actorLoginName)
  } else {
    await tools.sp.outboxTasks.markStatus(task.eventId, { status: 'SYNC_FAILED', lastError: '模拟适配器返回失败（GAP-B7 重试）' })
    await tools.sp.orders.updateSyncStatus(order.id, { shippingStatusSyncStatus: 'sync_failed' }, pc.ctx.actorLoginName)
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'shipping.sync.status.retry',
    subjectType: 'shipment_order',
    subjectId: order.id,
    before: { shippingStatusSyncStatus: order.shippingStatusSyncStatus, taskStatus: task.status },
    after: { outcome, snapshotPayload: task.payload },
    reason: str(p, 'reason') ?? null,
  })
  return {
    orderId: order.id,
    task: 'status-sync',
    skipped: false,
    outcome,
    dispatched: outcome === 'success',
    status: outcome === 'success' ? 'synced' : 'sync_failed',
    snapshot: task.payload,
  }
}

// ---------------- 命令：装箱图附件元数据（A-T14-10） ----------------

async function photoAttach(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = spTools(pc)
  const plantId = requireStr(p, 'plantId', 'shipping.photo.attach')
  await assertPlantScope(tools, plantId)
  const shipmentOrderId = requireStr(p, 'shipmentOrderId', 'shipping.photo.attach')
  const order = await tools.sp.orders.findById(shipmentOrderId)
  if (order === null) throw new ShippingRuleViolation(NOT_FOUND_RULE, '发货单不存在')
  if (order.plantId !== plantId) throw new ShippingRuleViolation('A-S1', '发货单不在目标工厂')

  const photosPayload = p['photos']
  if (!Array.isArray(photosPayload) || photosPayload.length === 0) {
    throw new ShippingRuleViolation('A-T14-10', '装箱图附件至少一张（photos 数组）')
  }
  // A-T14-10：部分失败保留已成功——逐张校验，合法张落库、非法张入失败清单（整命令仍 COMMITTED）
  const attached: Array<Record<string, unknown>> = []
  const failed: Array<Record<string, unknown>> = []
  for (const [index, raw] of photosPayload.entries()) {
    const ph = (raw ?? {}) as Payload
    const fileName = str(ph, 'fileName')
    const storageKey = str(ph, 'storageKey')
    if (fileName === undefined || storageKey === undefined) {
      failed.push({ index, fileName, reason: '缺少 fileName 或 storageKey' })
      continue
    }
    const photo = await tools.sp.photos.insert({
      shipmentOrderId: order.id,
      fileName,
      storageKey,
      contentType: str(ph, 'contentType') ?? null,
      sizeBytes: typeof ph['sizeBytes'] === 'number' && Number.isInteger(ph['sizeBytes']) ? (ph['sizeBytes'] as number) : null,
      uploadedBy: pc.ctx.actorLoginName,
      uploadedAt: pc.businessTime,
      commandReceiptId: pc.commandReceiptId,
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
    attached.push({ photoId: photo.id, fileName })
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'shipping.photo.attach',
    subjectType: 'shipment_order',
    subjectId: order.id,
    after: { attached: attached.length, failed: failed.length },
    reason: str(p, 'reason') ?? null,
  })
  return { orderId: order.id, attached, failed }
}

// ---------------- 处理器装配 ----------------

type ShippingHandlerFn = (pc: PostingContext, p: Payload) => Promise<Record<string, unknown>>

/** 命令处理器清单（组合根装配进 PgCommandBus）。 */
export function createShippingCommandHandlers(): CommandHandler[] {
  const make = (commandType: string, fn: ShippingHandlerFn): CommandHandler => ({
    commandType,
    handle: (envelope, ctx, tools): Promise<HandlerOutcome> =>
      run(async () => {
        const shippingTools = tools as ShippingCommandTools // 组合根构造的工具集窄化（见 shipping.composition）
        const payload = (envelope.payload ?? {}) as Payload
        const pc = await buildPostingContext(shippingTools, ctx, commandType, envelope.operationId, payload)
        return fn(pc, payload)
      }),
  })

  return [
    make('shipping.dc-composition.inbound', dcCompositionInbound),
    make('shipping.pl.inbound', plInbound),
    make('shipping.packing.create', packingCreate),
    make('shipping.packing.bind', packingBind),
    make('shipping.scan.load', scanLoad),
    make('shipping.scan.delete', scanDelete),
    make('shipping.scan.supplement', scanSupplement),
    make('shipping.ship.confirm', shipConfirm),
    make('shipping.sync.actual-axis.retry', syncActualAxisRetry),
    make('shipping.sync.status.retry', syncStatusRetry),
    make('shipping.photo.attach', photoAttach),
  ]
}
