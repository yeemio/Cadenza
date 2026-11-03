import { ERROR_CODES } from '@cadenza/contracts'
import { InventoryRuleViolation, addQty, cmpQty, ensureStableLockOrder, isValidQuantityString, subQty } from '@cadenza/domain'
import {
  assertCodeRewriteShape,
  assertCompletionScansValid,
  assertConversionCarrierCode,
  assertOrderCompletable,
  assertOrderConversionLines,
  assertOrderMutableForEdit,
  assertOrderScanAdmissible,
  assertOrderSyncRetryable,
  assertScanChoiceNotUsed,
  assertScanChoicePresent,
  assertStockLocalApplyable,
  assertStockPushable,
  assertStockPushResultAcceptable,
  assertStockReconvertable,
  assertStockResyncable,
  assertStockSubmitShape,
  projectStockDisplayStatus,
  type OrderConversionLineSpec,
  type StockInternalStatus,
} from '@cadenza/domain'
import type { CommandHandler, HandlerOutcome } from './command-bus'
import { violationOutcome } from './inventory-handlers'
import { NOT_FOUND_RULE, buildPostingContext, type PostingContext } from './inventory-posting'
import type {
  ConversionCommandTools,
  ConversionStockLineRecord,
  ConversionStockOrderRecord,
  NewCodeRewrite,
  NewConversionStockLine,
  ProductionOrderView,
  UnitStockFacts,
} from './conversion-repositories'

/**
 * conversionform 域命令处理器（T16 两种形态转换；全部在命令总线事务内运行，命令事务即 UoW）。
 *
 * 命令面（13，两协议分立 FC-01）：
 * - 协议A（订单式=本地先执行、后异步同步）：conversion.order.create/update/delete
 *   （FC-05/06 建单与编辑删除门）、conversion.order.scan / scan-delete（FC-07 扫码锁定/
 *   删码解锁）、conversion.order.complete（FC-08 本地先完成：归属改转换后订单＋Outbox 推
 *   U9/库存统计）、conversion.order.sync-retry（FC-09/10 仅已完成同步失败可重试，按完成
 *   时点快照重推不推当前值）；
 * - 协议B（库存式=外部先成功、再本地）：conversion.stock.create（FC-13① 保存单据＋预留
 *   源库存 DM §7.2）、conversion.stock.push（② 派发 U9——Outbox 任务驱动，业务事务不跨
 *   公网等待 IT-26）、conversion.stock.push-result（② 结果回填：成功/失败/未知——FC-03
 *   未知中间态进人工核对、不换键盲发）、conversion.stock.local-apply（③④ MES 改码＋库存
 *   统计→完成；FC-16 不改项目号、清空虚拟轴号）、conversion.stock.reconvert（FC-15 重新
 *   转换：原单 id 更新可改可加减明细再走完整链路）、conversion.stock.resync（FC-15 重新
 *   同步：只做本地、不再推 U9——U9 已成功步骤不重做）。
 *
 * 幂等/回执由 PgCommandBus 承担；规则违例以 [FC-x] 前缀返回（BUSINESS_REJECTION）；
 * 全部命令审计留痕；外部交互走模拟适配器（P1 GAP-B7 口径：outcome 载荷驱动）。
 */

type Payload = Record<string, unknown>

const CONVERSION_VIOLATION_NAME = 'ConversionRuleViolation'

/** 本地规则违例（载荷解析/编排层；name 与 domain ConversionRuleViolation 对齐以便统一映射）。 */
class ConversionViolation extends Error {
  readonly rule: string
  constructor(rule: string, message: string) {
    super(message)
    this.name = CONVERSION_VIOLATION_NAME
    this.rule = rule
  }
}

function conversionViolationOutcome(error: { rule: string; message: string }): HandlerOutcome {
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
    // domain dist 与本地违例统一按 name 识别（跨 dist 构造器身份不可 instanceof）
    if (error instanceof Error && error.name === CONVERSION_VIOLATION_NAME) {
      const violation = error as unknown as { rule: string; message: string }
      return conversionViolationOutcome(violation)
    }
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
  if (v === undefined) throw new ConversionViolation('FC-01', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

/** 组织范围二道防线（OA-24/26）。 */
async function assertPlantScope(tools: ConversionCommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new ConversionViolation('A-S1', `目标工厂不在授权数据范围内（plant=${plantId}）`)
  }
}

function cvTools(pc: PostingContext): ConversionCommandTools {
  return pc.tools as ConversionCommandTools
}

/** 预留有效期：锁定 30 天（持有期内其它业务操作该码被拒，FC-20）。 */
const SCAN_LOCK_VALID_DAYS = 30

function lockValidUntil(nowIso: string): string {
  return new Date(Date.parse(nowIso) + SCAN_LOCK_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

/** 活动有效预留判定（IT-23 口径：active 且未过有效期）。 */
function isEffectiveReservation(r: { status: string; validUntil: string }, nowIso: string): boolean {
  return r.status === 'active' && Date.parse(r.validUntil) >= Date.parse(nowIso)
}

// ---------------- 生产订单锚点事实（FC-05） ----------------

async function loadOrderAnchor(
  tools: ConversionCommandTools,
  orderId: string,
  label: string,
): Promise<ProductionOrderView> {
  const order = await tools.conversion.process.findProductionOrder(orderId)
  if (order === null) {
    throw new ConversionViolation(
      NOT_FOUND_RULE,
      `${label}生产订单不存在（订单式转换仅以生产订单为锚点，采购单入口禁用）`,
    )
  }
  return order
}

/** FC-05：明细行规格装配（转换前后订单事实查实；同料品/非同一订单/数量/重复行由域规则断言）。 */
async function buildLineSpecs(
  tools: ConversionCommandTools,
  plantId: string,
  linesPayload: unknown,
): Promise<OrderConversionLineSpec[]> {
  if (!Array.isArray(linesPayload)) throw new ConversionViolation('FC-05', '转换单载荷 lines 须为数组')
  const specs: OrderConversionLineSpec[] = []
  for (const [index, raw] of linesPayload.entries()) {
    const l = (raw ?? {}) as Payload
    const sourceOrderId = str(l, 'sourceOrderId')
    const targetOrderId = str(l, 'targetOrderId')
    if (sourceOrderId === undefined || targetOrderId === undefined) {
      throw new ConversionViolation('FC-05', `第 ${index + 1} 行缺少转换前/转换后订单 id`)
    }
    const quantity = dec(l, 'quantity')
    if (quantity === undefined) {
      throw new ConversionViolation('FC-05', `第 ${index + 1} 行数量必填且须为十进制定点字符串（精度 4 位）`)
    }
    const source = await loadOrderAnchor(tools, sourceOrderId, `第 ${index + 1} 行转换前`)
    const target = await loadOrderAnchor(tools, targetOrderId, `第 ${index + 1} 行转换后`)
    if (source.plantId !== plantId || target.plantId !== plantId) {
      throw new ConversionViolation('A-S1', `第 ${index + 1} 行转换前/后订单不在目标工厂`)
    }
    if (source.salesOrderNo === null || source.lineNo === null) {
      throw new ConversionViolation('FC-05', `第 ${index + 1} 行转换前订单缺少销售单号/行号（订单行不可选）`)
    }
    const payloadSo = str(l, 'sourceSalesOrderNo')
    const payloadLine = str(l, 'sourceLineNo')
    if (payloadSo !== undefined && payloadSo !== source.salesOrderNo) {
      throw new ConversionViolation('FC-05', `第 ${index + 1} 行转换前销售单号与订单事实不符（${payloadSo} ≠ ${source.salesOrderNo}）`)
    }
    if (payloadLine !== undefined && payloadLine !== source.lineNo) {
      throw new ConversionViolation('FC-05', `第 ${index + 1} 行转换前行号与订单事实不符（${payloadLine} ≠ ${source.lineNo}）`)
    }
    specs.push({
      sourceOrderId: source.id,
      sourceSalesOrderNo: source.salesOrderNo,
      sourceLineNo: source.lineNo,
      sourceProjectNo: str(l, 'sourceProjectNo') ?? null,
      targetOrderId: target.id,
      targetSalesOrderNo: target.salesOrderNo ?? target.orderNo,
      targetProjectNo: str(l, 'targetProjectNo') ?? '',
      sourceMaterialId: source.materialId,
      targetMaterialId: target.materialId,
      materialCode: '',
      quantity,
      uom: str(l, 'uom') ?? 'KG',
    })
  }
  assertOrderConversionLines(specs)
  for (const [index, spec] of specs.entries()) {
    const material = await tools.conversion.stock.findMaterial(spec.sourceMaterialId)
    if (material === null) throw new ConversionViolation(NOT_FOUND_RULE, `第 ${index + 1} 行料品不存在`)
    spec.materialCode = material.code
  }
  return specs
}

// ---------------- 命令：建单/编辑/删除（FC-05/06） ----------------

async function orderCreate(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.order.create')
  await assertPlantScope(tools, plantId)
  const specs = await buildLineSpecs(tools, plantId, p['lines'])

  const conversionNo = `CV${pc.businessTime.slice(0, 10).replaceAll('-', '')}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`
  const order = await tools.conversion.orders.insert({
    conversionNo,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
    commandReceiptId: pc.commandReceiptId,
  })
  const lineResults: Array<Record<string, unknown>> = []
  for (const [index, spec] of specs.entries()) {
    const line = await tools.conversion.orderLines.insert({
      conversionOrderId: order.id,
      lineNo: index + 1,
      sourceOrderId: spec.sourceOrderId,
      sourceSalesOrderNo: spec.sourceSalesOrderNo,
      sourceLineNo: spec.sourceLineNo,
      sourceProjectNo: spec.sourceProjectNo,
      targetOrderId: spec.targetOrderId,
      targetSalesOrderNo: spec.targetSalesOrderNo,
      targetProjectNo: spec.targetProjectNo,
      materialId: spec.sourceMaterialId,
      materialCode: spec.materialCode,
      plannedQty: spec.quantity,
      uom: spec.uom,
      createdBy: pc.ctx.actorLoginName,
    })
    lineResults.push({ lineId: line.id, lineNo: line.lineNo, sourceSalesOrderNo: line.sourceSalesOrderNo })
  }
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.order.create',
    subjectType: 'conversion_order',
    subjectId: order.id,
    after: { conversionNo, lines: lineResults.length, status: order.status, syncStatus: order.syncStatus },
    reason: str(p, 'reason') ?? null,
  })
  return { conversionId: order.id, conversionNo, status: order.status, syncStatus: order.syncStatus, lines: lineResults }
}

async function orderUpdate(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.order.update')
  await assertPlantScope(tools, plantId)
  const conversionOrderId = requireStr(p, 'conversionOrderId', 'conversion.order.update')
  const order = await tools.conversion.orders.lockById(conversionOrderId)
  if (order === null) throw new ConversionViolation(NOT_FOUND_RULE, '转换单不存在')
  if (order.plantId !== plantId) throw new ConversionViolation('A-S1', '转换单不在目标工厂')
  const scans = await tools.conversion.orderScans.listByOrder(order.id)
  // FC-06：仅待转换且该单尚无任何扫码可编辑（扫码事实 append-only——含已删码留痕；
  // 有扫码留痕时明细受 FK/触发器保护，形状不可再改）
  assertOrderMutableForEdit({ status: order.status, activeScanCount: scans.length, action: 'edit' })

  const specs = await buildLineSpecs(tools, plantId, p['lines'])
  const existing = await tools.conversion.orderLines.listByOrder(order.id)
  let updated = 0
  let removed = 0
  // FC-06 按料品比对明细：新增建行、已有更新数量、去掉删除
  for (const line of existing) {
    const spec = specs.find((s) => s.sourceSalesOrderNo === line.sourceSalesOrderNo && s.sourceLineNo === line.sourceLineNo)
    if (spec === undefined) {
      await tools.conversion.orderLines.deleteById(line.id)
      removed += 1
    } else if (spec.quantity !== line.plannedQty) {
      await tools.conversion.orderLines.updatePlannedQty(line.id, spec.quantity, pc.ctx.actorLoginName)
      updated += 1
    }
  }
  let nextLineNo = existing.reduce((max, l) => Math.max(max, l.lineNo), 0)
  const added: Array<Record<string, unknown>> = []
  for (const spec of specs) {
    if (existing.some((l) => l.sourceSalesOrderNo === spec.sourceSalesOrderNo && l.sourceLineNo === spec.sourceLineNo)) continue
    nextLineNo += 1
    const line = await tools.conversion.orderLines.insert({
      conversionOrderId: order.id,
      lineNo: nextLineNo,
      sourceOrderId: spec.sourceOrderId,
      sourceSalesOrderNo: spec.sourceSalesOrderNo,
      sourceLineNo: spec.sourceLineNo,
      sourceProjectNo: spec.sourceProjectNo,
      targetOrderId: spec.targetOrderId,
      targetSalesOrderNo: spec.targetSalesOrderNo,
      targetProjectNo: spec.targetProjectNo,
      materialId: spec.sourceMaterialId,
      materialCode: spec.materialCode,
      plannedQty: spec.quantity,
      uom: spec.uom,
      createdBy: pc.ctx.actorLoginName,
    })
    added.push({ lineId: line.id, lineNo: line.lineNo })
  }
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.order.update',
    subjectType: 'conversion_order',
    subjectId: order.id,
    before: { lineCount: existing.length },
    after: { updated, removed, added: added.length },
    reason: str(p, 'reason') ?? null,
  })
  return { conversionId: order.id, conversionNo: order.conversionNo, updated, removed, added }
}

async function orderDelete(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.order.delete')
  await assertPlantScope(tools, plantId)
  const conversionOrderId = requireStr(p, 'conversionOrderId', 'conversion.order.delete')
  const order = await tools.conversion.orders.lockById(conversionOrderId)
  if (order === null) throw new ConversionViolation(NOT_FOUND_RULE, '转换单不存在')
  if (order.plantId !== plantId) throw new ConversionViolation('A-S1', '转换单不在目标工厂')
  const scans = await tools.conversion.orderScans.listByOrder(order.id)
  // FC-06：仅待转换且尚无扫码可删除（删除主单及明细；扫码事实 append-only，含删码留痕均计入）
  assertOrderMutableForEdit({ status: order.status, activeScanCount: scans.length, action: 'delete' })
  await tools.conversion.orderLines.deleteByOrder(order.id)
  await tools.conversion.orders.deleteById(order.id)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.order.delete',
    subjectType: 'conversion_order',
    subjectId: order.id,
    before: { conversionNo: order.conversionNo, status: order.status },
    reason: str(p, 'reason') ?? null,
  })
  return { conversionId: order.id, conversionNo: order.conversionNo, deleted: true }
}

// ---------------- 命令：扫码/删码（FC-07） ----------------

async function orderScan(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.order.scan')
  await assertPlantScope(tools, plantId)
  const conversionOrderId = requireStr(p, 'conversionOrderId', 'conversion.order.scan')
  const lineId = requireStr(p, 'lineId', 'conversion.order.scan')
  const scannedCode = requireStr(p, 'unitNo', 'conversion.order.scan')

  const order = await tools.conversion.orders.lockById(conversionOrderId)
  if (order === null) throw new ConversionViolation(NOT_FOUND_RULE, '转换单不存在')
  if (order.plantId !== plantId) throw new ConversionViolation('A-S1', '转换单不在目标工厂')
  if (order.status !== 'pending') {
    throw new ConversionViolation('FC-07', `仅待转换单可扫码（当前 ${order.status}；已完成只读）`)
  }
  const line = await tools.conversion.orderLines.lockById(lineId)
  if (line === null || line.conversionOrderId !== order.id) {
    throw new ConversionViolation(NOT_FOUND_RULE, '转换明细不存在或不属于该转换单')
  }
  // FC-07：载具码类型位 E/F/M/P（不含 R）
  assertConversionCarrierCode(scannedCode)
  const binding = await tools.inv.barcodes.findActiveBindingByValue(scannedCode)
  if (binding !== null && binding.boundType !== 'inventory_unit') {
    throw new ConversionViolation('FC-07', '扫码未绑定独立库存单元')
  }
  const unit = binding?.boundType === 'inventory_unit'
    ? await tools.inv.units.findById(binding.boundId)
    : await tools.inv.units.findByUnitNo(plantId, scannedCode)
  if (unit === null || unit.plantId !== plantId || unit.enterpriseId !== pc.ctx.enterpriseId) {
    throw new ConversionViolation('FC-07', '扫码未绑定本工厂的库存单元')
  }
  const unitNo = unit.unitNo
  const rawSegment = p['segmentLength']
  if (rawSegment !== undefined && rawSegment !== null && dec(p, 'segmentLength') === undefined) {
    throw new ConversionViolation('FC-07', '段长须为十进制定点字符串（精度 4 位）')
  }
  const segmentLength = dec(p, 'segmentLength') ?? null
  const customerAxisNo = str(p, 'customerAxisNo') ?? null
  // FC-07：弹层选择段长或客户轴号（至少一项）
  assertScanChoicePresent({ unitNo, segmentLength, customerAxisNo })
  const activeScans = await tools.conversion.orderScans.listActiveByOrder(order.id)
  // FC-07：已用段长/客户轴号不可再选
  assertScanChoiceNotUsed({
    unitNo,
    segmentLength,
    customerAxisNo,
    usedSegmentLengths: new Set(activeScans.map((s) => s.segmentLength).filter((v): v is string => v !== null)),
    usedCustomerAxisNos: new Set(activeScans.map((s) => s.customerAxisNo).filter((v): v is string => v !== null)),
  })

  // 单元事实：锁单元行（IT-15 同码并发串行）→ 在库/余额/归属/锁定/跨协议占用（FC-07/FC-20）
  await tools.inv.units.lockForUpdate([unit.id])
  const balances = (await tools.inv.balances.listActiveByUnit(unit.id)).filter((b) => b.status === 'active')
  const ownerOrder = await tools.conversion.process.findOrderForUnit(unit.id)
  const nowIso = tools.now().toISOString()
  const reservations = await tools.inv.reservations.listActiveByUnit(unit.id)
  const lockedByOther = reservations.some((r) => isEffectiveReservation(r, nowIso))
  const occupiedByStockConversion =
    (await tools.conversion.stockLines.findUnfinishedByUnitAndMaterial(unitNo, line.materialId)) !== null
  assertOrderScanAdmissible({
    unitNo,
    unitStatus: unit.status,
    balanceExists: balances.length > 0,
    unitOwnerOrderId: ownerOrder?.orderId ?? null,
    sourceOrderId: line.sourceOrderId,
    lockedByOther,
    occupiedByStockConversion,
    alreadyScannedInOrder: activeScans.some((s) => s.unitNo === unitNo),
  })
  const balance = balances[0]!

  // 扫码提交锁定二维码（FC-S2 锁定引用 reservation；IT-23 预留机制）
  const reservation = await tools.inv.reservations.insert({
    unitId: unit.id,
    locationId: balance.locationId,
    holderType: 'order',
    holderRef: `conversion:${line.id}`,
    quantity: balance.quantity,
    uomId: balance.uomId,
    uomCode: balance.uomCode,
    measurementBasis: balance.measurementBasis,
    validUntil: lockValidUntil(nowIso),
    commandReceiptId: pc.commandReceiptId,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  const scan = await tools.conversion.orderScans.insert({
    conversionOrderId: order.id,
    conversionLineId: line.id,
    inventoryUnitId: unit.id,
    unitNo,
    segmentLength,
    customerAxisNo,
    quantity: balance.quantity,
    reservationId: reservation.id,
    scannedBy: pc.ctx.actorLoginName,
    scannedAt: pc.businessTime,
    commandReceiptId: pc.commandReceiptId,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  // FC-07：回写实扫数量/已扫轴数
  const nextQty = addQty(line.scannedQty, balance.quantity)
  const nextAxes = line.scannedAxes + 1
  await tools.conversion.orderLines.updateProgress(
    line.id,
    { scannedQty: nextQty, scannedAxes: nextAxes },
    pc.ctx.actorLoginName,
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.order.scan',
    subjectType: 'conversion_order_scan',
    subjectId: scan.id,
    after: { scannedCode, unitId: unit.id, unitNo, lineId: line.id, reservationId: reservation.id, scannedQty: nextQty, scannedAxes: nextAxes },
    reason: str(p, 'reason') ?? null,
  })
  return { scanId: scan.id, scannedCode, inventoryUnitId: unit.id, unitNo, lineId: line.id, reservationId: reservation.id, scannedQty: nextQty, scannedAxes: nextAxes, plannedQty: line.plannedQty }
}

async function orderScanDelete(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.order.scan-delete')
  await assertPlantScope(tools, plantId)
  const conversionOrderId = requireStr(p, 'conversionOrderId', 'conversion.order.scan-delete')
  const scanId = requireStr(p, 'scanId', 'conversion.order.scan-delete')

  const order = await tools.conversion.orders.lockById(conversionOrderId)
  if (order === null) throw new ConversionViolation(NOT_FOUND_RULE, '转换单不存在')
  if (order.plantId !== plantId) throw new ConversionViolation('A-S1', '转换单不在目标工厂')
  if (order.status !== 'pending') {
    throw new ConversionViolation('FC-07', `仅待转换单可删码（当前 ${order.status}）`)
  }
  const scan = await tools.conversion.orderScans.findById(scanId)
  if (scan === null || scan.conversionOrderId !== order.id) {
    throw new ConversionViolation(NOT_FOUND_RULE, '扫码记录不存在或不属于该转换单')
  }
  if (scan.deleted) throw new ConversionViolation('FC-07', '扫码记录已删除，不可重复删码')
  const line = await tools.conversion.orderLines.lockById(scan.conversionLineId)
  if (line === null) throw new ConversionViolation(NOT_FOUND_RULE, '转换明细不存在')
  // 删码提交解锁二维码并重算实扫数量/已扫轴数（FC-07；删码模式不校验载具码类型位规则——本命令按 scanId 定位）
  await tools.conversion.orderScans.markDeleted(
    scan.id,
    { deletedBy: pc.ctx.actorLoginName, deletedAt: pc.businessTime },
    pc.ctx.actorLoginName,
  )
  await tools.inv.reservations.release(
    scan.reservationId,
    pc.ctx.actorLoginName,
    `订单形态转换删码解锁（转换单 ${order.conversionNo}）`,
    tools.now().toISOString(),
  )
  const rawNext = subQty(line.scannedQty, scan.quantity)
  const nextQty = cmpQty(rawNext, '0.0000') < 0 ? '0.0000' : rawNext
  const nextAxes = Math.max(0, line.scannedAxes - 1)
  await tools.conversion.orderLines.updateProgress(
    line.id,
    { scannedQty: nextQty, scannedAxes: nextAxes },
    pc.ctx.actorLoginName,
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.order.scan-delete',
    subjectType: 'conversion_order_scan',
    subjectId: scan.id,
    before: { deleted: false, scannedQty: line.scannedQty, scannedAxes: line.scannedAxes },
    after: { deleted: true, scannedQty: nextQty, scannedAxes: nextAxes },
    reason: str(p, 'reason') ?? null,
  })
  return { scanId: scan.id, deleted: true, reservationReleased: true, scannedQty: nextQty, scannedAxes: nextAxes }
}

// ---------------- 命令：完成转换（FC-08；本地先执行） ----------------

async function orderComplete(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.order.complete')
  await assertPlantScope(tools, plantId)
  const conversionOrderId = requireStr(p, 'conversionOrderId', 'conversion.order.complete')

  const order = await tools.conversion.orders.lockById(conversionOrderId)
  if (order === null) throw new ConversionViolation(NOT_FOUND_RULE, '转换单不存在')
  if (order.plantId !== plantId) throw new ConversionViolation('A-S1', '转换单不在目标工厂')
  const lines = await tools.conversion.orderLines.listByOrder(order.id)
  // FC-08：可执行 = 待转换且每条明细已扫轴数 > 0
  assertOrderCompletable({
    status: order.status,
    lines: lines.map((l) => ({ lineId: l.id, scannedAxes: l.scannedAxes })),
  })
  const activeScans = await tools.conversion.orderScans.listActiveByOrder(order.id)
  // FC-08：轴号/虚拟轴号校验不过则失败、状态不变
  assertCompletionScansValid(
    activeScans.map((s) => ({
      unitNo: s.unitNo,
      quantity: s.quantity,
      segmentLength: s.segmentLength,
      customerAxisNo: s.customerAxisNo,
    })),
  )
  const lineById = new Map(lines.map((l) => [l.id, l]))

  // 本地先执行：二维码归属改为转换后订单（FC-08）
  const completedAt = pc.businessTime
  const assignments: Array<Record<string, unknown>> = []
  for (const scan of activeScans) {
    const line = lineById.get(scan.conversionLineId)!
    await tools.conversion.assignments.insertBatch([
      {
        conversionOrderId: order.id,
        conversionLineId: line.id,
        scanId: scan.id,
        inventoryUnitId: scan.inventoryUnitId,
        unitNo: scan.unitNo,
        fromOrderId: line.sourceOrderId,
        toOrderId: line.targetOrderId,
        assignedBy: pc.ctx.actorLoginName,
        assignedAt: completedAt,
        commandReceiptId: pc.commandReceiptId,
        plantId,
        enterpriseId: pc.ctx.enterpriseId,
        createdBy: pc.ctx.actorLoginName,
      },
    ])
    assignments.push({ unitNo: scan.unitNo, fromOrderId: line.sourceOrderId, toOrderId: line.targetOrderId })
    await tools.inv.reservations.release(
      scan.reservationId,
      pc.ctx.actorLoginName,
      `订单形态转换完成释放锁定（转换单 ${order.conversionNo}）`,
      tools.now().toISOString(),
    )
  }
  // FC-S5：完成转换时点快照固化（FC-09 重试按快照重推、不推当前值）
  const completionSnapshot: Record<string, unknown> = {
    conversionNo: order.conversionNo,
    completedAt,
    completedBy: pc.ctx.actorLoginName,
    lines: lines.map((l) => ({
      lineId: l.id,
      sourceOrderId: l.sourceOrderId,
      sourceSalesOrderNo: l.sourceSalesOrderNo,
      sourceLineNo: l.sourceLineNo,
      targetOrderId: l.targetOrderId,
      targetSalesOrderNo: l.targetSalesOrderNo,
      materialCode: l.materialCode,
      plannedQty: l.plannedQty,
      scannedQty: l.scannedQty,
      scannedAxes: l.scannedAxes,
      scans: activeScans
        .filter((s) => s.conversionLineId === l.id)
        .map((s) => ({ unitNo: s.unitNo, segmentLength: s.segmentLength, customerAxisNo: s.customerAxisNo, quantity: s.quantity })),
    })),
  }
  const completed = await tools.conversion.orders.markCompleted(
    order.id,
    { completedBy: pc.ctx.actorLoginName, completedAt, completionSnapshot },
    pc.ctx.actorLoginName,
  )
  // 触发 U9 同步（Outbox 异步）与库存统计（FC-08；FC-S4 复合身份 聚合+任务种类）
  pc.tools.outbox.collect({
    aggregateType: 'conversion_order',
    aggregateId: order.id,
    taskKind: 'form_conversion_push',
    payload: completionSnapshot,
  })
  pc.tools.outbox.collect({
    aggregateType: 'conversion_order',
    aggregateId: order.id,
    taskKind: 'form_conversion.inventory-stats',
    payload: { conversionNo: order.conversionNo, completedAt, assignments, kind: 'order' },
  })
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.order.complete',
    subjectType: 'conversion_order',
    subjectId: order.id,
    before: { status: order.status },
    after: { status: 'completed', assignments: assignments.length, completedAt },
    reason: str(p, 'reason') ?? null,
  })
  return {
    conversionId: order.id,
    conversionNo: order.conversionNo,
    status: 'completed',
    syncStatus: completed?.syncStatus ?? 'pending',
    completedBy: pc.ctx.actorLoginName,
    completedAt,
    assignments,
  }
}

// ---------------- 命令：同步重试（FC-09/FC-10） ----------------

async function orderSyncRetry(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.order.sync-retry')
  await assertPlantScope(tools, plantId)
  const conversionOrderId = requireStr(p, 'conversionOrderId', 'conversion.order.sync-retry')
  const order = await tools.conversion.orders.lockById(conversionOrderId)
  if (order === null) throw new ConversionViolation(NOT_FOUND_RULE, '转换单不存在')
  if (order.plantId !== plantId) throw new ConversionViolation('A-S1', '转换单不在目标工厂')
  const outcome = str(p, 'outcome') === 'failure' ? 'failure' : 'success'
  if (outcome === 'success') {
    // FC-09：重试成功仅"已完成且同步失败"可执行（重新推 U9，成功后同步状态=已同步）
    assertOrderSyncRetryable({ status: order.status, syncStatus: order.syncStatus })
  } else if (order.status !== 'completed') {
    // FC-10：外部失败登记仅针对已完成单（保留本地已执行事实与待同步差异，本地不回滚）；
    // 同步状态 pending（首次外发失败登记差异）或 sync_failed（再次失败）均可登记。
    throw new ConversionViolation('FC-10', `仅已完成的转换单可登记外部同步结果（当前转换状态 ${order.status}）`)
  }
  // FC-09：按完成转换时点快照重推，不推当前值（任务行缺失即拒——不按当前值重建）
  const task = await tools.conversion.outboxTasks.findLatestByTask('conversion_order', order.id, 'form_conversion_push')
  if (task === null) {
    throw new ConversionViolation(NOT_FOUND_RULE, 'U9 同步任务行缺失（无任务不重推，不按当前值重建）')
  }
  if (outcome === 'success') {
    await tools.conversion.outboxTasks.markStatus(task.eventId, { status: 'DISPATCHED' })
    await tools.conversion.orders.updateSyncStatus(order.id, { syncStatus: 'synced' }, pc.ctx.actorLoginName)
  } else {
    // FC-10：外部失败保留本地已执行事实与待同步差异，本地不回滚、不重复本地转换
    await tools.conversion.outboxTasks.markStatus(task.eventId, {
      status: 'SYNC_FAILED',
      lastError: '模拟适配器返回失败（GAP-B7 重试）',
    })
    await tools.conversion.orders.updateSyncStatus(order.id, { syncStatus: 'sync_failed' }, pc.ctx.actorLoginName)
  }
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.order.sync-retry',
    subjectType: 'conversion_order',
    subjectId: order.id,
    before: { syncStatus: order.syncStatus, taskStatus: task.status },
    after: { outcome, snapshotPayload: task.payload },
    reason: str(p, 'reason') ?? null,
  })
  return { conversionId: order.id, outcome, syncStatus: outcome === 'success' ? 'synced' : 'sync_failed', snapshot: task.payload }
}

// ---------------- 协议B：库存转换（FC-13～21） ----------------

/** 协议B 转换单号编码（与协议A CV 前缀分立：CVS——两套单据不混用 FC-01）。 */
function nextStockConversionNo(pc: PostingContext): string {
  return `CVS${pc.businessTime.slice(0, 10).replaceAll('-', '')}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`
}

interface StockLineFact {
  lockedByOther: boolean
  occupiedUnfinished: boolean
}

/** FC-17/19：逐行解析库存事实（在库/仓库类型=仓库/同料品/来源快照），锁定单元行后复核占用与锁定。 */
async function buildStockLines(
  tools: ConversionCommandTools,
  pc: PostingContext,
  plantId: string,
  materialId: string,
  linesPayload: unknown,
  excludeOrderId?: string,
): Promise<{ rows: Array<Omit<NewConversionStockLine, 'conversionStockOrderId'>>; facts: StockLineFact[] }> {
  if (!Array.isArray(linesPayload)) throw new ConversionViolation('FC-18', '库存转换单载荷 lines 须为数组')
  const resolved: Array<{ row: Omit<NewConversionStockLine, 'conversionStockOrderId'>; facts: UnitStockFacts }> = []
  for (const [index, raw] of linesPayload.entries()) {
    const l = (raw ?? {}) as Payload
    const unitNo = str(l, 'unitNo')
    const segmentLength = dec(l, 'segmentLength')
    if (unitNo === undefined) throw new ConversionViolation('FC-18', `第 ${index + 1} 行缺少二维码（unitNo）`)
    if (segmentLength === undefined) {
      throw new ConversionViolation('FC-18', `第 ${index + 1} 行段长必填且须为十进制定点字符串（精度 4 位）`)
    }
    const facts = await tools.conversion.stock.findUnitStockFacts(plantId, unitNo)
    if (facts === null) throw new ConversionViolation(NOT_FOUND_RULE, `库存单元 ${unitNo} 不存在`)
    if (facts.unitStatus !== 'in_stock') {
      throw new ConversionViolation('FC-17', `码 ${unitNo} 不在库（当前 ${facts.unitStatus}），不可转换`)
    }
    if (facts.warehouseType !== 'WAREHOUSE') {
      throw new ConversionViolation('FC-17', `码 ${unitNo} 所在仓库类型须为仓库（当前 ${facts.warehouseType ?? '未知'}，不含线边仓）`)
    }
    if (facts.materialId !== materialId) {
      throw new ConversionViolation('FC-17', `码 ${unitNo} 物料与所选料品不符（多物料托/平行轴只保留本料品相关轴）`)
    }
    resolved.push({
      row: {
        unitNo,
        inventoryUnitId: facts.unitId,
        palletCode: str(l, 'palletCode') ?? facts.palletCode,
        quantity: dec(l, 'quantity') ?? facts.quantity,
        uom: str(l, 'uom') ?? facts.uomCode,
        segmentLength,
        customerAxisNo: str(l, 'customerAxisNo') ?? null,
        materialId,
        materialCode: facts.materialCode,
        sourceProjectNo: str(l, 'sourceProjectNo') ?? null,
        sourceSalesOrderNo: str(l, 'sourceSalesOrderNo') ?? facts.salesOrderNo,
        sourceLineNo: str(l, 'sourceLineNo') ?? facts.salesLineNo,
        sourceBatchNo: str(l, 'sourceBatchNo') ?? facts.batchNo,
        sourceVirtualAxisNo: str(l, 'sourceVirtualAxisNo') ?? null,
        warehouseId: str(l, 'warehouseId') ?? facts.warehouseId,
        warehouseCode: str(l, 'warehouseCode') ?? facts.warehouseCode,
        locationId: str(l, 'locationId') ?? facts.locationId,
        locationCode: str(l, 'locationCode') ?? facts.locationCode,
        plantId,
        enterpriseId: pc.ctx.enterpriseId,
        createdBy: pc.ctx.actorLoginName,
      },
      facts,
    })
  }
  // IT-25/27：稳定次序锁定全部源单元（同码并发提交在此串行化——后提交方读到已提交占用，FC-20）
  const unitIds = ensureStableLockOrder(resolved.map((r) => r.row.inventoryUnitId))
  const locked = await tools.inv.units.lockForUpdate(unitIds)
  if (locked.length !== unitIds.length) {
    throw new ConversionViolation(NOT_FOUND_RULE, '存在不可锁定的库存单元（状态已变）')
  }
  const nowIso = tools.now().toISOString()
  const factsOut: StockLineFact[] = []
  for (const item of resolved) {
    const reservations = await tools.inv.reservations.listActiveByUnit(item.row.inventoryUnitId)
    factsOut.push({
      lockedByOther: reservations.some((r) => isEffectiveReservation(r, nowIso)),
      occupiedUnfinished:
        (await tools.conversion.stockLines.findUnfinishedByUnitAndMaterial(
          item.row.unitNo,
          materialId,
          excludeOrderId,
        )) !== null,
    })
  }
  return { rows: resolved.map((r) => r.row), facts: factsOut }
}

/** FC-13①/FC-17/18/20：提交前校验（料品成品且库存>0；右侧至少 1 条；必填/段长/≤50；占用与锁定复核）。 */
function assertStockSubmission(input: {
  material: { code: string; materialType: number }
  materialStockQty: string
  p: Payload
  rows: ReadonlyArray<Omit<NewConversionStockLine, 'conversionStockOrderId'>>
  facts: StockLineFact[]
}): void {
  assertStockSubmitShape({
    materialCode: input.material.code,
    materialType: input.material.materialType,
    materialStockQty: input.materialStockQty,
    targetProjectNo: str(input.p, 'targetProjectNo') ?? null,
    targetSalesOrderNo: str(input.p, 'targetSalesOrderNo') ?? '',
    targetLineNo: str(input.p, 'targetLineNo') ?? '',
    targetBatchNo: str(input.p, 'targetBatchNo') ?? '',
    lines: input.rows.map((r, i) => ({
      unitNo: r.unitNo,
      segmentLength: r.segmentLength,
      customerAxisNo: r.customerAxisNo,
      quantity: r.quantity,
      materialId: r.materialId,
      lockedByOther: input.facts[i]!.lockedByOther,
      occupiedUnfinished: input.facts[i]!.occupiedUnfinished,
    })),
  })
}

/** 为源库存明细建立预留（DM §7.2：创建转换意图并预留源库存；锁定期间其它业务操作该码被拒）。 */
async function reserveStockUnits(
  tools: ConversionCommandTools,
  pc: PostingContext,
  plantId: string,
  orderId: string,
  lines: ReadonlyArray<{ inventoryUnitId: string; unitNo: string }>,
): Promise<void> {
  const nowIso = tools.now().toISOString()
  for (const line of lines) {
    const balance = (await tools.inv.balances.listActiveByUnit(line.inventoryUnitId)).find((b) => b.status === 'active')
    if (balance === undefined) throw new ConversionViolation(NOT_FOUND_RULE, `库存单元 ${line.unitNo} 无活动余额，预留失败`)
    await tools.inv.reservations.insert({
      unitId: line.inventoryUnitId,
      locationId: balance.locationId,
      holderType: 'order',
      holderRef: `conversion-stock:${orderId}`,
      quantity: balance.quantity,
      uomId: balance.uomId,
      uomCode: balance.uomCode,
      measurementBasis: balance.measurementBasis,
      validUntil: lockValidUntil(nowIso),
      commandReceiptId: pc.commandReceiptId,
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
  }
}

/** 释放本单持有的源库存预留（删行/重建/完成）。 */
async function releaseStockReservations(
  tools: ConversionCommandTools,
  pc: PostingContext,
  orderId: string,
  conversionNo: string,
  unitIds: readonly string[],
  reasonPrefix: string,
): Promise<void> {
  for (const unitId of unitIds) {
    const reservations = await tools.inv.reservations.listActiveByUnit(unitId)
    for (const r of reservations) {
      if (r.status === 'active' && r.holderRef === `conversion-stock:${orderId}`) {
        await tools.inv.reservations.release(
          r.id,
          pc.ctx.actorLoginName,
          `${reasonPrefix}（转换单 ${conversionNo}）`,
          tools.now().toISOString(),
        )
      }
    }
  }
}

async function stockCreate(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.stock.create')
  await assertPlantScope(tools, plantId)
  const materialId = requireStr(p, 'materialId', 'conversion.stock.create')
  const material = await tools.conversion.stock.findMaterial(materialId)
  if (material === null) throw new ConversionViolation(NOT_FOUND_RULE, '转换料品不存在')
  const { rows, facts } = await buildStockLines(tools, pc, plantId, materialId, p['lines'])
  const materialStockQty = await tools.conversion.stock.sumMaterialStock(plantId, materialId)
  assertStockSubmission({ material, materialStockQty, p, rows, facts })

  const order = await tools.conversion.stockOrders.insert({
    conversionNo: nextStockConversionNo(pc),
    materialId,
    materialCode: material.code,
    materialName: material.name,
    uom: material.baseUom,
    targetProjectNo: str(p, 'targetProjectNo') ?? null,
    targetSalesOrderNo: str(p, 'targetSalesOrderNo')!,
    targetLineNo: str(p, 'targetLineNo')!,
    targetBatchNo: str(p, 'targetBatchNo')!,
    submitSnapshot: {
      materialId,
      materialCode: material.code,
      targetProjectNo: str(p, 'targetProjectNo') ?? null,
      targetSalesOrderNo: str(p, 'targetSalesOrderNo')!,
      targetLineNo: str(p, 'targetLineNo')!,
      targetBatchNo: str(p, 'targetBatchNo')!,
      lines: rows.map((r) => ({
        unitNo: r.unitNo,
        segmentLength: r.segmentLength,
        customerAxisNo: r.customerAxisNo,
        quantity: r.quantity,
        materialId: r.materialId,
      })),
    },
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
    commandReceiptId: pc.commandReceiptId,
  })
  const inserted = await tools.conversion.stockLines.insertBatch(
    rows.map((r) => ({ ...r, conversionStockOrderId: order.id, commandReceiptId: pc.commandReceiptId })),
  )
  await reserveStockUnits(tools, pc, plantId, order.id, inserted)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.stock.create',
    subjectType: 'conversion_stock_order',
    subjectId: order.id,
    after: { conversionNo: order.conversionNo, internalStatus: order.internalStatus, displayStatus: order.displayStatus, lines: inserted.length },
    reason: str(p, 'reason') ?? null,
  })
  return {
    conversionId: order.id,
    conversionNo: order.conversionNo,
    internalStatus: order.internalStatus,
    displayStatus: order.displayStatus,
    lines: inserted.length,
  }
}

async function stockPush(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.stock.push')
  await assertPlantScope(tools, plantId)
  const conversionStockOrderId = requireStr(p, 'conversionStockOrderId', 'conversion.stock.push')
  const order = await tools.conversion.stockOrders.lockById(conversionStockOrderId)
  if (order === null) throw new ConversionViolation(NOT_FOUND_RULE, '库存转换单不存在')
  if (order.plantId !== plantId) throw new ConversionViolation('A-S1', '库存转换单不在目标工厂')
  // FC-13②：仅待执行可派发（已派发不盲重发，防 U9 侧两张单 FC-03/FC-04）
  assertStockPushable({ internalStatus: order.internalStatus })
  // 幂等键 = 聚合身份（conversion_stock_order + id + form_conversion_push）——重推不换键
  pc.tools.outbox.collect({
    aggregateType: 'conversion_stock_order',
    aggregateId: order.id,
    taskKind: 'form_conversion_push',
    payload: {
      idempotencyKey: order.id,
      conversionNo: order.conversionNo,
      materialCode: order.materialCode,
      target: {
        projectNo: order.targetProjectNo,
        salesOrderNo: order.targetSalesOrderNo,
        lineNo: order.targetLineNo,
        batchNo: order.targetBatchNo,
      },
      lines: order.submitSnapshot?.['lines'] ?? [],
      submittedAt: order.businessTime,
    },
  })
  const updated = await tools.conversion.stockOrders.updateState(
    order.id,
    { internalStatus: 'external_processing', displayStatus: projectStockDisplayStatus('external_processing', order.u9Success) },
    pc.ctx.actorLoginName,
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.stock.push',
    subjectType: 'conversion_stock_order',
    subjectId: order.id,
    before: { internalStatus: order.internalStatus },
    after: { internalStatus: 'external_processing', idempotencyKey: order.id },
    reason: str(p, 'reason') ?? null,
  })
  return {
    conversionId: order.id,
    internalStatus: 'external_processing',
    displayStatus: updated?.displayStatus ?? 'convert_failed',
    idempotencyKey: order.id,
  }
}

async function stockPushResult(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.stock.push-result')
  await assertPlantScope(tools, plantId)
  const conversionStockOrderId = requireStr(p, 'conversionStockOrderId', 'conversion.stock.push-result')
  const outcomeRaw = str(p, 'outcome')
  if (outcomeRaw !== 'success' && outcomeRaw !== 'failure' && outcomeRaw !== 'unknown') {
    throw new ConversionViolation('FC-03', 'outcome 须为 success/failure/unknown（模拟适配器/外部流水查询结果）')
  }
  const order = await tools.conversion.stockOrders.lockById(conversionStockOrderId)
  if (order === null) throw new ConversionViolation(NOT_FOUND_RULE, '库存转换单不存在')
  if (order.plantId !== plantId) throw new ConversionViolation('A-S1', '库存转换单不在目标工厂')
  assertStockPushResultAcceptable({ internalStatus: order.internalStatus })
  const externalDocNo = str(p, 'externalDocNo') ?? null
  const task = await tools.conversion.outboxTasks.findLatestByTask('conversion_stock_order', order.id, 'form_conversion_push')

  let internalStatus: StockInternalStatus
  let externalPushStatus: ConversionStockOrderRecord['externalPushStatus']
  let u9Success = order.u9Success
  let failureReason: string | null = order.externalFailureReason
  if (outcomeRaw === 'success') {
    internalStatus = 'local_processing'
    externalPushStatus = 'succeeded'
    u9Success = true
    failureReason = null
    if (task !== null) await tools.conversion.outboxTasks.markStatus(task.eventId, { status: 'DISPATCHED' })
  } else if (outcomeRaw === 'failure') {
    // FC-13②：失败保持转换失败（展示态）并记录失败原因；内部态=待恢复（可重新转换）
    internalStatus = 'pending_recovery'
    externalPushStatus = 'failed'
    failureReason = str(p, 'failureReason') ?? 'U9 形态转换失败（模拟适配器结果）'
    if (task !== null) {
      await tools.conversion.outboxTasks.markStatus(task.eventId, { status: 'SYNC_FAILED', lastError: failureReason })
    }
  } else {
    // FC-03：外部结果未知中间态——不换键盲发（不得造成 U9 侧两张单），进入人工核对；
    // 不声称恰好一次；任务行保持原状态（未定论不推进）。
    internalStatus = 'manual_processing'
    externalPushStatus = 'unknown'
    failureReason = str(p, 'failureReason') ?? '外部结果未知（超时/缺幂等回执），先查询外部流水，人工核对'
  }
  const displayStatus = projectStockDisplayStatus(internalStatus, u9Success)
  await tools.conversion.stockOrders.updateState(
    order.id,
    {
      internalStatus,
      displayStatus,
      externalPushStatus,
      u9Success,
      externalDocNo: externalDocNo ?? order.externalDocNo,
      externalFailureReason: failureReason,
    },
    pc.ctx.actorLoginName,
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.stock.push-result',
    subjectType: 'conversion_stock_order',
    subjectId: order.id,
    before: { internalStatus: order.internalStatus, externalPushStatus: order.externalPushStatus },
    after: { outcome: outcomeRaw, internalStatus, externalPushStatus, u9Success, externalDocNo },
    reason: str(p, 'reason') ?? null,
  })
  return { conversionId: order.id, outcome: outcomeRaw, internalStatus, displayStatus, u9Success, externalDocNo }
}

/** FC-13③④/FC-15/FC-16：本地应用（MES 改码＋库存统计→完成；重新同步同逻辑、不再推 U9）。 */
async function applyStockLocal(
  pc: PostingContext,
  tools: ConversionCommandTools,
  order: ConversionStockOrderRecord,
  lines: ConversionStockLineRecord[],
  outcome: 'success' | 'failure',
  failureReason: string,
): Promise<Record<string, unknown>> {
  if (outcome === 'failure') {
    // 本地失败：待恢复（对外=同步失败——U9 已成功、MES 未完成）；不回滚 U9 已成功标记
    await tools.conversion.stockOrders.updateState(
      order.id,
      {
        internalStatus: 'pending_recovery',
        displayStatus: 'sync_failed',
        localApplyStatus: 'failed',
        externalFailureReason: failureReason,
      },
      pc.ctx.actorLoginName,
    )
    return { internalStatus: 'pending_recovery', displayStatus: 'sync_failed', localApplyStatus: 'failed' }
  }
  const appliedAt = pc.businessTime
  // FC-16：MES 改码——回写销售单号/行号/批次号/段长/客户轴号、清空虚拟轴号、不改项目号
  // （改码记录表无 new_project_no 列——结构保证"码上项目号不变"；单据 target_project_no 只记单据）。
  const rewrites: NewCodeRewrite[] = lines.map((line) => {
    assertCodeRewriteShape({
      unitNo: line.unitNo,
      oldSalesOrderNo: line.sourceSalesOrderNo,
      oldLineNo: line.sourceLineNo,
      oldBatchNo: line.sourceBatchNo,
      oldVirtualAxisNo: line.sourceVirtualAxisNo,
      newSalesOrderNo: order.targetSalesOrderNo,
      newLineNo: order.targetLineNo,
      newBatchNo: order.targetBatchNo,
      newSegmentLength: line.segmentLength,
      newCustomerAxisNo: line.customerAxisNo,
      clearVirtualAxis: true,
    })
    return {
      conversionStockOrderId: order.id,
      conversionLineId: line.id,
      inventoryUnitId: line.inventoryUnitId,
      unitNo: line.unitNo,
      oldSalesOrderNo: line.sourceSalesOrderNo,
      oldLineNo: line.sourceLineNo,
      oldBatchNo: line.sourceBatchNo,
      oldVirtualAxisNo: line.sourceVirtualAxisNo,
      newSalesOrderNo: order.targetSalesOrderNo,
      newLineNo: order.targetLineNo,
      newBatchNo: order.targetBatchNo,
      newSegmentLength: line.segmentLength,
      newCustomerAxisNo: line.customerAxisNo,
      virtualAxisCleared: line.sourceVirtualAxisNo !== null && line.sourceVirtualAxisNo.trim() !== '',
      appliedBy: pc.ctx.actorLoginName,
      appliedAt,
      commandReceiptId: pc.commandReceiptId,
      plantId: order.plantId,
      enterpriseId: order.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    }
  })
  await tools.conversion.rewrites.insertBatch(rewrites)
  // FC-S3：明细占用释放（未完成唯一失效）＋源库存预留释放
  await tools.conversion.stockLines.markReleasedByOrder(order.id)
  await releaseStockReservations(
    tools,
    pc,
    order.id,
    order.conversionNo,
    lines.map((l) => l.inventoryUnitId),
    '库存形态转换完成释放',
  )
  await tools.conversion.stockOrders.updateState(
    order.id,
    { internalStatus: 'completed', displayStatus: 'convert_success', localApplyStatus: 'applied', completedAt: appliedAt },
    pc.ctx.actorLoginName,
  )
  // 库存统计事件（Outbox；FC-13③）
  pc.tools.outbox.collect({
    aggregateType: 'conversion_stock_order',
    aggregateId: order.id,
    taskKind: 'form_conversion.inventory-stats',
    payload: {
      conversionNo: order.conversionNo,
      appliedAt,
      kind: 'stock',
      rewrites: rewrites.map((r) => ({ unitNo: r.unitNo, quantity: lines.find((l) => l.unitNo === r.unitNo)?.quantity ?? null })),
    },
  })
  return {
    internalStatus: 'completed',
    displayStatus: 'convert_success',
    localApplyStatus: 'applied',
    appliedAt,
    rewrites: rewrites.length,
  }
}

async function stockLocalApply(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.stock.local-apply')
  await assertPlantScope(tools, plantId)
  const conversionStockOrderId = requireStr(p, 'conversionStockOrderId', 'conversion.stock.local-apply')
  const order = await tools.conversion.stockOrders.lockById(conversionStockOrderId)
  if (order === null) throw new ConversionViolation(NOT_FOUND_RULE, '库存转换单不存在')
  if (order.plantId !== plantId) throw new ConversionViolation('A-S1', '库存转换单不在目标工厂')
  // FC-13③：U9 明确成功后执行 MES 改码＋库存统计
  assertStockLocalApplyable({ internalStatus: order.internalStatus, u9Success: order.u9Success })
  const lines = await tools.conversion.stockLines.listByOrder(order.id)
  const outcome = str(p, 'outcome') === 'failure' ? 'failure' : 'success'
  const result = await applyStockLocal(
    pc,
    tools,
    order,
    lines,
    outcome,
    str(p, 'failureReason') ?? 'MES 改码/库存统计本地应用失败（A09 注入）',
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.stock.local-apply',
    subjectType: 'conversion_stock_order',
    subjectId: order.id,
    before: { internalStatus: order.internalStatus, u9Success: order.u9Success },
    after: result,
    reason: str(p, 'reason') ?? null,
  })
  return { conversionId: order.id, ...result }
}

async function stockReconvert(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.stock.reconvert')
  await assertPlantScope(tools, plantId)
  const conversionStockOrderId = requireStr(p, 'conversionStockOrderId', 'conversion.stock.reconvert')
  const order = await tools.conversion.stockOrders.lockById(conversionStockOrderId)
  if (order === null) throw new ConversionViolation(NOT_FOUND_RULE, '库存转换单不存在')
  if (order.plantId !== plantId) throw new ConversionViolation('A-S1', '库存转换单不在目标工厂')
  // FC-15：重新转换仅转换失败单（原单 id 更新，可改可加减明细，再走完整链路）
  assertStockReconvertable({ internalStatus: order.internalStatus, u9Success: order.u9Success })
  const material = await tools.conversion.stock.findMaterial(order.materialId)
  if (material === null) throw new ConversionViolation(NOT_FOUND_RULE, '转换料品不存在')
  const oldLines = await tools.conversion.stockLines.listByOrder(order.id)
  // 释放本单既有源库存预留（带出原清单可改可加减——预留随明细整集重建）
  await releaseStockReservations(
    tools,
    pc,
    order.id,
    order.conversionNo,
    oldLines.map((l) => l.inventoryUnitId),
    '重新转换重建源库存预留',
  )
  // 原单明细整集替换（排除自身复核占用——保留行不因自身旧占用被拒）
  const { rows, facts } = await buildStockLines(tools, pc, plantId, order.materialId, p['lines'], order.id)
  const materialStockQty = await tools.conversion.stock.sumMaterialStock(plantId, order.materialId)
  // FC-15：拉取详情带入原数据（未提供的目标字段沿用原单），再走完整链路提交校验
  const targetProjectNo = str(p, 'targetProjectNo') ?? order.targetProjectNo
  const targetSalesOrderNo = str(p, 'targetSalesOrderNo') ?? order.targetSalesOrderNo
  const targetLineNo = str(p, 'targetLineNo') ?? order.targetLineNo
  const targetBatchNo = str(p, 'targetBatchNo') ?? order.targetBatchNo
  const mergedP: Payload = {
    ...p,
    targetProjectNo,
    targetSalesOrderNo,
    targetLineNo,
    targetBatchNo,
  }
  assertStockSubmission({ material, materialStockQty, p: mergedP, rows, facts })
  await tools.conversion.stockLines.deleteByOrder(order.id)
  const inserted = await tools.conversion.stockLines.insertBatch(
    rows.map((r) => ({ ...r, conversionStockOrderId: order.id, commandReceiptId: pc.commandReceiptId })),
  )
  await reserveStockUnits(tools, pc, plantId, order.id, inserted)
  // 状态重置：待执行（链路重走；外部幂等键=聚合身份不变，不换键盲发）
  await tools.conversion.stockOrders.updateState(
    order.id,
    {
      internalStatus: 'pending_execute',
      displayStatus: 'convert_failed',
      externalPushStatus: 'pending',
      localApplyStatus: 'not_applied',
      u9Success: false,
      externalFailureReason: null,
      submitSnapshot: {
        materialId: order.materialId,
        materialCode: order.materialCode,
        targetProjectNo,
        targetSalesOrderNo,
        targetLineNo,
        targetBatchNo,
        lines: inserted.map((r) => ({
          unitNo: r.unitNo,
          segmentLength: r.segmentLength,
          customerAxisNo: r.customerAxisNo,
          quantity: r.quantity,
          materialId: r.materialId,
        })),
      },
    },
    pc.ctx.actorLoginName,
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.stock.reconvert',
    subjectType: 'conversion_stock_order',
    subjectId: order.id,
    before: { internalStatus: order.internalStatus, lines: oldLines.length },
    after: { internalStatus: 'pending_execute', lines: inserted.length },
    reason: str(p, 'reason') ?? null,
  })
  return {
    conversionId: order.id,
    conversionNo: order.conversionNo,
    internalStatus: 'pending_execute',
    displayStatus: 'convert_failed',
    lines: inserted.length,
  }
}

async function stockResync(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = cvTools(pc)
  const plantId = requireStr(p, 'plantId', 'conversion.stock.resync')
  await assertPlantScope(tools, plantId)
  const conversionStockOrderId = requireStr(p, 'conversionStockOrderId', 'conversion.stock.resync')
  const order = await tools.conversion.stockOrders.lockById(conversionStockOrderId)
  if (order === null) throw new ConversionViolation(NOT_FOUND_RULE, '库存转换单不存在')
  if (order.plantId !== plantId) throw new ConversionViolation('A-S1', '库存转换单不在目标工厂')
  // FC-15：重新同步仅同步失败单——只做 MES 改码与库存统计，不再推 U9（已成功步骤不重做）
  assertStockResyncable({
    internalStatus: order.internalStatus,
    u9Success: order.u9Success,
    localApplyStatus: order.localApplyStatus,
  })
  const lines = await tools.conversion.stockLines.listByOrder(order.id)
  const outcome = str(p, 'outcome') === 'failure' ? 'failure' : 'success'
  const result = await applyStockLocal(
    pc,
    tools,
    order,
    lines,
    outcome,
    str(p, 'failureReason') ?? 'MES 改码/库存统计重新同步失败（A09 注入）',
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'conversion.stock.resync',
    subjectType: 'conversion_stock_order',
    subjectId: order.id,
    before: { internalStatus: order.internalStatus, u9Success: order.u9Success },
    after: { ...result, repushedU9: false },
    reason: str(p, 'reason') ?? null,
  })
  return { conversionId: order.id, repushedU9: false, ...result }
}

// ---------------- 处理器装配 ----------------

type ConversionHandlerFn = (pc: PostingContext, p: Payload) => Promise<Record<string, unknown>>

/** 命令处理器清单（组合根装配进 PgCommandBus）。 */
export function createConversionCommandHandlers(): CommandHandler[] {
  const make = (commandType: string, fn: ConversionHandlerFn): CommandHandler => ({
    commandType,
    handle: (envelope, ctx, tools): Promise<HandlerOutcome> =>
      run(async () => {
        const conversionTools = tools as ConversionCommandTools // 组合根构造的工具集窄化（见 conversion.composition）
        const payload = (envelope.payload ?? {}) as Payload
        const pc = await buildPostingContext(conversionTools, ctx, commandType, envelope.operationId, payload)
        return fn(pc, payload)
      }),
  })

  return [
    make('conversion.order.create', orderCreate),
    make('conversion.order.update', orderUpdate),
    make('conversion.order.delete', orderDelete),
    make('conversion.order.scan', orderScan),
    make('conversion.order.scan-delete', orderScanDelete),
    make('conversion.order.complete', orderComplete),
    make('conversion.order.sync-retry', orderSyncRetry),
    make('conversion.stock.create', stockCreate),
    make('conversion.stock.push', stockPush),
    make('conversion.stock.push-result', stockPushResult),
    make('conversion.stock.local-apply', stockLocalApply),
    make('conversion.stock.reconvert', stockReconvert),
    make('conversion.stock.resync', stockResync),
  ]
}
