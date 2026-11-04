import { ERROR_CODES } from '@cadenza/contracts'
import {
  InventoryRuleViolation,
  isPositiveQty,
} from '@cadenza/domain'
// L0 整合步（Wave5）：domain index 已导出 './quality'；改包名导入（原 dist 相对导入 + eslint-disable 删除）。
import {
  QualityRuleViolation,
  assertConcessionBasedOnEffectiveVersion,
  assertInspectionOrderGeneratable,
  assertReleaseExecutable,
  assertSpecReference,
  assertSuspectRegistratable,
  assertSuspectRestorable,
  assertTestResultSubmittable,
  nextTestResultVersion,
} from '@cadenza/domain'
import type { CommandHandler, HandlerOutcome } from './command-bus'
import { violationOutcome } from './inventory-handlers'
import { NOT_FOUND_RULE, buildPostingContext, type PostingContext } from './inventory-posting'
import type { InspectionOrderRecord, QualityCommandTools } from './quality-repositories'
import { assertObjectWriteScope, type ObjectScope } from './object-scope-repositories'

/**
 * quality 域命令处理器（T12 质量放行；全部在命令总线事务内运行，命令事务即 UoW）。
 *
 * 命令面（6）：
 * - quality.inspection.generate：检验任务生成——消费执行块提交事件（ExecutionEventPort 端口注入，
 *   L0 整合接线，测试内存实现），过程/成品检验任务来源报工；检验规范引用版本化 [A-T12-5]；
 * - quality.test-result.submit：实测提交——实测值追加历史 + 生效结论版本化（S14 同构：
 *   追加版本行 + 翻转生效指针，历史不清）；已结论单再提交=复检（版本链继续追加）；
 * - quality.disposition.release：判定放行（生效结论=合格；库存质量投影 qualified）[A-T12-1]；
 * - quality.disposition.concession：让步放行（保留原不合格事实：based_on_version 显式引用
 *   原结论版本，结论链不动；库存质量投影 qualified）[A-T12-1]；
 * - quality.suspect.register：存疑登记（在库+在库位+未存疑+托码拒；保留发起人/时间/生产部门）[A-T12-3]；
 * - quality.suspect.restore：存疑恢复（最小处置记录：恢复人/时间/处置依据必填）[A-T12-3/B-9]。
 *
 * 幂等/回执由 PgCommandBus 承担；规则违例以 [A-T12-x] 前缀文案返回（BUSINESS_REJECTION）。
 * 全部命令审计留痕（IT-S3 口径随行）。
 */

type Payload = Record<string, unknown>

function qualityViolationOutcome(error: QualityRuleViolation): HandlerOutcome {
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
    if (error instanceof QualityRuleViolation) return qualityViolationOutcome(error)
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
  if (v === undefined) throw new QualityRuleViolation('A-T12-5', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

async function assertQualityObjectScope(pc: PostingContext, target: ObjectScope, claimedPlantId?: string): Promise<void> {
  await assertObjectWriteScope(pc.tools, pc.ctx, target, 'quality.post',
    (message) => new QualityRuleViolation('A-S1', message), claimedPlantId)
}

async function assertPlantScope(pc: PostingContext, plantId: string): Promise<void> {
  await assertQualityObjectScope(pc, { enterpriseId: pc.ctx.enterpriseId, plantId })
}

function qualityTools(pc: PostingContext): QualityCommandTools {
  return pc.tools as QualityCommandTools
}

/** 检验单绑定单元的库存质量投影刷新（T12 闸门消费口径：IT-14 库存余额 quality_status）。 */
async function syncUnitQualityByNo(
  pc: PostingContext,
  order: InspectionOrderRecord,
  target: 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect',
): Promise<string | null> {
  const tools = qualityTools(pc)
  if (order.unitNo === null && order.inventoryUnitId === null) return null
  const found = order.inventoryUnitId !== null
    ? await tools.inv.units.findById(order.inventoryUnitId)
    : await tools.inv.units.findByUnitNo(order.plantId, order.unitNo!)
  // A reported unit may not have been received yet. An explicit stale/foreign
  // binding is different: never silently project a different physical unit.
  if (found === null && order.inventoryUnitId === null) return null
  const unit = found === null ? undefined : (await tools.inv.units.lockForUpdate([found.id]))[0]
  if (unit === undefined) throw new QualityRuleViolation('A-S1', '检验单绑定的库存单元不存在')
  await assertQualityObjectScope(pc, unit, order.plantId)
  if (order.unitNo !== null && order.unitNo !== unit.unitNo) throw new QualityRuleViolation('A-S1', '检验单的库存身份不一致')
  // Inspection/concession facts may advance while custody remains isolated.
  // An active hold always wins the projection; release is a separate command.
  const activeHold = await tools.qa.holds.findActiveByUnit(unit.id)
  const projected = activeHold === null ? target : 'suspect'
  const balances = await tools.inv.balances.listActiveByUnit(unit.id)
  for (const b of balances) {
    if (b.unitId !== unit.id || b.enterpriseId !== unit.enterpriseId || b.plantId !== unit.plantId) {
      throw new QualityRuleViolation('A-S1', '检验单绑定余额的企业/工厂不一致')
    }
    if (b.qualityStatus !== projected) await tools.inv.balances.adjust(b.id, { qualityStatus: projected }, null)
  }
  return unit.id
}

// ---------------- 命令：检验任务生成（A-T12-5；消费执行块提交事件） ----------------

async function inspectionGenerate(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qualityTools(pc)
  const plantId = requireStr(p, 'plantId', 'quality.inspection.generate')
  await assertPlantScope(pc, plantId)

  const eventTypesRaw = p['eventTypes']
  const eventTypes = Array.isArray(eventTypesRaw) && eventTypesRaw.every((t) => typeof t === 'string')
    ? (eventTypesRaw as string[])
    : ['work_report_confirmed']
  const events = await tools.events.fetchEvents({ types: eventTypes, plantId })

  const created: Array<Record<string, unknown>> = []
  let skipped = 0
  let seq = 0
  for (const event of events) {
    if (event.eventType !== 'work_report_confirmed') continue // 检验任务仅消费报工确认事件
    await assertQualityObjectScope(pc, { enterpriseId: pc.ctx.enterpriseId, plantId: event.plantId }, plantId)
    const stage = event.payload.inspectionStage === 'process' ? 'process' : 'finished'
    const specCode = event.payload.specCode ?? str(p, 'defaultSpecCode')
    const specVersion = event.payload.specVersion ?? (p['defaultSpecVersion'] as number | undefined)
    // A-T12-5：来源/阶段/数量 + 检验规范引用版本化
    assertInspectionOrderGeneratable({
      sourceType: 'work_report',
      sourceRef: event.payload.sourceRef,
      inspectionStage: stage,
      quantity: event.payload.quantity,
      isPositive: isPositiveQty(event.payload.quantity),
    })
    assertSpecReference({ specCode, specVersion })
    const existing = await tools.qa.inspectionOrders.findBySource('work_report', event.payload.sourceRef, stage)
    if (existing !== null) {
      await assertQualityObjectScope(pc, existing, plantId)
      skipped += 1 // 事件重放幂等：来源唯一键查重跳过（不重复生成）
      continue
    }
    seq += 1
    const orderNo = `QIO-${Date.now().toString(36).toUpperCase()}-${seq.toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`
    const order = await tools.qa.inspectionOrders.insert({
      orderNo,
      sourceType: 'work_report',
      sourceRef: event.payload.sourceRef,
      inspectionStage: stage,
      specCode: specCode!,
      specVersion: specVersion as number,
      unitNo: event.payload.unitNo ?? null,
      materialId: event.payload.materialId,
      materialCode: event.payload.materialCode,
      quantity: event.payload.quantity,
      uomId: event.payload.uomId,
      uomCode: event.payload.uomCode,
      productionOrderNo: event.payload.productionOrderNo ?? null,
      productionDeptId: event.payload.productionDeptId ?? null,
      productionDeptName: event.payload.productionDeptName ?? null,
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
    // 结论链起点 v1（pending，S14 版本链起点；生成时无实测）
    await tools.qa.testResults.insert({
      inspectionOrderId: order.id,
      version: 1,
      conclusion: 'pending',
      items: [],
      resultKind: 'initial',
      isEffective: true,
      commandReceiptId: pc.commandReceiptId,
      createdBy: pc.ctx.actorLoginName,
    })
    created.push({ orderId: order.id, orderNo, stage, sourceRef: event.payload.sourceRef, specCode, specVersion })
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'quality.inspection.generate',
    subjectType: 'quality_inspection_order',
    subjectId: (created[0] as { orderId?: string } | undefined)?.orderId ?? 'n/a',
    after: { created: created.length, skipped, events: events.length },
    reason: str(p, 'reason') ?? null,
  })
  return { created, skipped, eventsSeen: events.length }
}

// ---------------- 命令：实测提交（A-T12-5/S14 追加历史+生效结论版本化） ----------------

async function testResultSubmit(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qualityTools(pc)
  const inspectionOrderId = requireStr(p, 'inspectionOrderId', 'quality.test-result.submit')
  const order = await tools.qa.inspectionOrders.findById(inspectionOrderId, true)
  if (order === null) throw new QualityRuleViolation(NOT_FOUND_RULE, '检验单不存在')
  await assertQualityObjectScope(pc, order, str(p, 'plantId'))

  const conclusionRaw = str(p, 'conclusion')
  if (conclusionRaw !== 'qualified' && conclusionRaw !== 'unqualified') {
    throw new QualityRuleViolation('A-T12-5', "conclusion 必须为 'qualified' 或 'unqualified'")
  }
  const itemsPayload = p['items']
  if (!Array.isArray(itemsPayload)) {
    throw new QualityRuleViolation('A-T12-5', '实测提交必须携带 items（检验项实测明细数组）')
  }
  const items = itemsPayload.map((raw): import('@cadenza/domain').InspectionItemMeasurement => {
    const item = (raw ?? {}) as Payload
    const judgement = item['judgement']
    return {
      itemNo: typeof item['itemNo'] === 'string' ? item['itemNo'] : '',
      itemName: typeof item['itemName'] === 'string' ? item['itemName'] : null,
      measuredValue: typeof item['measuredValue'] === 'string' ? item['measuredValue'] : '',
      judgement: judgement === 'pass' || judgement === 'fail' || judgement === 'not_tested' ? judgement : 'not_tested',
      note: typeof item['note'] === 'string' ? item['note'] : null,
    }
  })
  const isReinspection = order.status === 'concluded' // 已结论单再提交 = 复检（A-T12-5 复检规则）
  // 域断言（items 非空/结论非 pending/作废单拒）
  assertTestResultSubmittable({
    orderStatus: order.status,
    items,
    conclusion: conclusionRaw,
  })

  // S14：追加版本行 + 翻转生效指针（历史全保留）
  const chain = await tools.qa.testResults.listByOrder(order.id)
  const version = nextTestResultVersion(chain.map((r) => r.version))
  const effective = chain.find((r) => r.isEffective)
  if (effective !== undefined) {
    await tools.qa.testResults.setEffective(effective.id, false, pc.ctx.actorLoginName)
  }
  await tools.qa.testResults.insert({
    inspectionOrderId: order.id,
    version,
    conclusion: conclusionRaw,
    items,
    resultKind: isReinspection ? 're_inspection' : 'test',
    isEffective: true,
    inspector: str(p, 'inspector') ?? pc.ctx.actorLoginName,
    inspectedAt: pc.businessTime,
    commandReceiptId: pc.commandReceiptId,
    createdBy: pc.ctx.actorLoginName,
  })
  // 实测提交即出结论 → 检验单已出结论（复检提交同样即时出新结论）
  await tools.qa.inspectionOrders.updateStatus(order.id, 'concluded', pc.ctx.actorLoginName)

  // 库存质量投影：复检打开先置待检（复检中不可用）；结论即时投影（合格→可用，不合格→不可用）
  if (order.unitNo !== null || order.inventoryUnitId !== null) {
    await syncUnitQualityByNo(pc, order, conclusionRaw === 'qualified' ? 'qualified' : 'unqualified')
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'quality.test-result.submit',
    subjectType: 'quality_inspection_order',
    subjectId: order.id,
    before: { status: order.status, effectiveConclusion: effective?.conclusion ?? null, effectiveVersion: effective?.version ?? null },
    after: { status: 'concluded', conclusion: conclusionRaw, version, resultKind: isReinspection ? 're_inspection' : 'test' },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'quality_inspection_order',
    aggregateId: order.id,
    taskKind: 'quality.test-result-submitted',
    payload: { orderId: order.id, orderNo: order.orderNo, version, conclusion: conclusionRaw, isReinspection, businessTime: pc.businessTime },
  })
  return { orderId: order.id, version, conclusion: conclusionRaw, isReinspection, historyPreserved: chain.length }
}

// ---------------- 命令：判定放行（A-T12-1） ----------------

async function dispositionRelease(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qualityTools(pc)
  const inspectionOrderId = requireStr(p, 'inspectionOrderId', 'quality.disposition.release')
  const order = await tools.qa.inspectionOrders.findById(inspectionOrderId, true)
  if (order === null) throw new QualityRuleViolation(NOT_FOUND_RULE, '检验单不存在')
  await assertQualityObjectScope(pc, order, str(p, 'plantId'))
  const effective = await tools.qa.testResults.findEffective(order.id)
  if (effective === null) throw new QualityRuleViolation(NOT_FOUND_RULE, '检验单无生效结论行（链起点缺失）')
  const dispositions = await tools.qa.dispositions.listByOrder(order.id)
  // A-T12-1：仅生效结论=合格可常规放行（不合格走让步；待检不可放行）
  assertReleaseExecutable({
    effectiveConclusion: effective.conclusion,
    alreadyReleased: dispositions.some((d) => d.basedOnVersion === effective.version),
  })
  const disposition = await tools.qa.dispositions.insert({
    inspectionOrderId: order.id,
    dispositionKind: 'release',
    basedOnVersion: effective.version,
    releasedBy: pc.ctx.actorLoginName,
    releasedAt: pc.businessTime,
    reason: str(p, 'reason') ?? null,
    commandReceiptId: pc.commandReceiptId,
  })
  // 库存质量投影：合格放行 → qualified（可用量闸门放开）
  const unitId = await syncUnitQualityByNo(pc, order, 'qualified')

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'quality.disposition.release',
    subjectType: 'quality_inspection_order',
    subjectId: order.id,
    before: { effectiveConclusion: effective.conclusion, effectiveVersion: effective.version },
    after: { dispositionKind: 'release', basedOnVersion: effective.version, unitId },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'quality_inspection_order',
    aggregateId: order.id,
    taskKind: 'quality.disposition-released',
    payload: { orderId: order.id, orderNo: order.orderNo, basedOnVersion: effective.version, releasedAt: pc.businessTime },
  })
  return { dispositionId: disposition.id, dispositionKind: 'release', basedOnVersion: effective.version, unitId }
}

// ---------------- 命令：让步放行（A-T12-1：保留原不合格事实） ----------------

async function dispositionConcession(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qualityTools(pc)
  const inspectionOrderId = requireStr(p, 'inspectionOrderId', 'quality.disposition.concession')
  const order = await tools.qa.inspectionOrders.findById(inspectionOrderId, true)
  if (order === null) throw new QualityRuleViolation(NOT_FOUND_RULE, '检验单不存在')
  await assertQualityObjectScope(pc, order, str(p, 'plantId'))
  const effective = await tools.qa.testResults.findEffective(order.id)
  if (effective === null) throw new QualityRuleViolation(NOT_FOUND_RULE, '检验单无生效结论行（链起点缺失）')
  const dispositions = await tools.qa.dispositions.listByOrder(order.id)
  if (dispositions.some((d) => d.basedOnVersion === effective.version)) {
    throw new QualityRuleViolation('A-T12-1', '该检验单已有生效处置（放行/让步），不得重复处置')
  }
  const basedOnVersionRaw = p['basedOnVersion']
  const basedOnVersion =
    typeof basedOnVersionRaw === 'number' && Number.isInteger(basedOnVersionRaw) ? basedOnVersionRaw : -1
  const reason = str(p, 'reason')
  if (reason === undefined) {
    throw new QualityRuleViolation('A-T12-1', '让步放行必须填写让步原因（受权放行留痕）')
  }
  // A-T12-1：让步保留原不合格事实——必须引用当前生效的不合格结论版本，结论链不动
  assertConcessionBasedOnEffectiveVersion({
    effectiveConclusion: effective.conclusion,
    effectiveVersion: effective.version,
    basedOnVersion,
  })
  const disposition = await tools.qa.dispositions.insert({
    inspectionOrderId: order.id,
    dispositionKind: 'concession',
    basedOnVersion: effective.version,
    releasedBy: pc.ctx.actorLoginName,
    releasedAt: pc.businessTime,
    reason,
    commandReceiptId: pc.commandReceiptId,
  })
  // 库存质量投影：让步后可用（qualified）；原不合格结论行保持生效（事实保留，断言见测试②）
  const unitId = await syncUnitQualityByNo(pc, order, 'qualified')

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'quality.disposition.concession',
    subjectType: 'quality_inspection_order',
    subjectId: order.id,
    before: { effectiveConclusion: effective.conclusion, effectiveVersion: effective.version },
    after: { dispositionKind: 'concession', basedOnVersion: effective.version, unitId, originalFactPreserved: true },
    reason,
  })
  pc.tools.outbox.collect({
    aggregateType: 'quality_inspection_order',
    aggregateId: order.id,
    taskKind: 'quality.disposition-concession',
    payload: { orderId: order.id, orderNo: order.orderNo, basedOnVersion: effective.version, reason, releasedAt: pc.businessTime },
  })
  return { dispositionId: disposition.id, dispositionKind: 'concession', basedOnVersion: effective.version, unitId, originalConclusionPreserved: effective.conclusion }
}

// ---------------- 命令：存疑登记（A-T12-3） ----------------

async function suspectRegister(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qualityTools(pc)
  const plantId = requireStr(p, 'plantId', 'quality.suspect.register')
  await assertPlantScope(pc, plantId)

  // 单元定位：unitId 优先；barcodeValue 经活动绑定解析（IT-04）；unitNo 兜底
  let unitId = str(p, 'unitId') ?? null
  const unitNo = str(p, 'unitNo') ?? null
  const barcodeValue = str(p, 'barcodeValue')
  const barcodeKind = str(p, 'barcodeKind') === 'pallet' ? 'pallet' : str(p, 'barcodeKind') === 'unknown' ? 'unknown' : 'unit'
  if (unitId === null && barcodeValue !== undefined) {
    const binding = await tools.inv.barcodes.findActiveBindingByValue(barcodeValue)
    if (binding !== null && binding.boundType === 'inventory_unit') unitId = binding.boundId
  }
  if (unitId === null && unitNo === null) {
    throw new QualityRuleViolation('A-T12-3', '存疑登记须携带 unitId/unitNo/barcodeValue 之一定位单元')
  }
  const resolved = unitId !== null
    ? await tools.inv.units.findById(unitId)
    : unitNo !== null
      ? await tools.inv.units.findByUnitNo(plantId, unitNo)
      : null
  if (resolved === null) {
    throw new QualityRuleViolation(NOT_FOUND_RULE, '库存单元不存在（存疑登记须在库单元）')
  }
  const unit = (await tools.inv.units.lockForUpdate([resolved.id]))[0]
  if (unit === undefined) throw new QualityRuleViolation(NOT_FOUND_RULE, '库存单元已不存在')
  await assertQualityObjectScope(pc, unit, plantId)
  if (unitNo !== null && unitNo !== unit.unitNo) throw new QualityRuleViolation('A-S1', '库存单元 ID 与自然键不一致')
  const balances = await tools.inv.balances.listActiveByUnit(unit.id)
  for (const balance of balances) {
    if (balance.enterpriseId !== unit.enterpriseId || balance.plantId !== unit.plantId) {
      throw new QualityRuleViolation('A-S1', '库存余额与单元的企业/工厂不一致')
    }
  }
  const activeHold = await tools.qa.holds.findActiveByUnit(unit.id)
  // A-T12-3：在库+在库位+未存疑+托码拒（域断言）
  assertSuspectRegistratable({
    barcodeKind,
    unitStatus: unit.status,
    hasLocation: balances.length > 0,
    hasActiveSuspect: activeHold !== null,
    unitNo: unit.unitNo,
  })
  const previous = balances[0]?.qualityStatus ?? 'qualified'
  const hold = await tools.qa.holds.insert({
    inventoryUnitId: unit.id,
    unitNo: unit.unitNo,
    holdKind: 'suspect',
    previousQualityStatus: previous,
    raisedBy: pc.ctx.actorLoginName,
    raisedAt: pc.businessTime,
    productionDeptId: str(p, 'productionDeptId') ?? null,
    productionDeptName: str(p, 'productionDeptName') ?? null,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    commandReceiptId: pc.commandReceiptId,
    createdBy: pc.ctx.actorLoginName,
  })
  // 码质量状态 = 存疑（不可用，IT-14/T12 闸门）
  for (const b of balances) {
    if (b.qualityStatus !== 'suspect') {
      await tools.inv.balances.adjust(b.id, { qualityStatus: 'suspect' }, null)
    }
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'quality.suspect.register',
    subjectType: 'quality_hold',
    subjectId: hold.id,
    before: { qualityStatus: previous },
    after: { holdKind: 'suspect', qualityStatus: 'suspect', unitNo: unit.unitNo, productionDeptName: str(p, 'productionDeptName') ?? null },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'quality_hold',
    aggregateId: hold.id,
    taskKind: 'quality.suspect-registered',
    payload: { holdId: hold.id, unitId: unit.id, unitNo: unit.unitNo, raisedBy: pc.ctx.actorLoginName, raisedAt: pc.businessTime },
  })
  return { holdId: hold.id, unitId: unit.id, unitNo: unit.unitNo, previousQualityStatus: previous }
}

// ---------------- 命令：存疑恢复（A-T12-3 + B-9 最小处置记录） ----------------

async function suspectReview(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qualityTools(pc)
  if (str(p, 'decision') !== 'reject' || !str(p, 'reason')) {
    throw new QualityRuleViolation('A-T12-3', '本入口仅记录有理由的拒绝恢复决定')
  }
  const hold = await lockScopedHold(pc, p)
  if (hold.status !== 'active') throw new QualityRuleViolation(NOT_FOUND_RULE, '没有对应活动隔离记录')
  const decidedAt = tools.now().toISOString()
  await tools.audit.record({ actor: pc.ctx.actorLoginName, action: 'quality.suspect.review', subjectType: 'quality_hold', subjectId: hold.id,
    after: { decision: 'reject', holdStatus: hold.status, unitId: hold.inventoryUnitId, decidedAt, restoredQty: '0.0000' }, reason: str(p, 'reason')! })
  return { holdId: hold.id, reviewDecision: 'reject', holdStatus: hold.status, restoredQty: '0.0000', decidedAt }
}

async function lockScopedHold(pc: PostingContext, p: Payload) {
  const tools = qualityTools(pc)
  const holdId = str(p, 'holdId')
  const unitId = str(p, 'unitId')
  const found = holdId !== undefined ? await tools.qa.holds.findById(holdId)
    : unitId !== undefined ? await tools.qa.holds.findActiveByUnit(unitId) : null
  if (found === null) throw new QualityRuleViolation(NOT_FOUND_RULE, '未找到指定存疑记录（holdId/unitId 定位失败）')
  // Same order as registration: physical unit first, then the hold record.
  const unit = (await tools.inv.units.lockForUpdate([found.inventoryUnitId]))[0]
  if (unit === undefined) throw new QualityRuleViolation('A-S1', '隔离单元不存在')
  const hold = await tools.qa.holds.findById(found.id, true)
  if (hold === null || hold.inventoryUnitId !== unit.id || hold.unitNo !== unit.unitNo ||
      (unitId !== undefined && unitId !== unit.id)) throw new QualityRuleViolation('A-S1', '隔离记录与库存身份不一致')
  await assertQualityObjectScope(pc, hold, str(p, 'plantId'))
  await assertQualityObjectScope(pc, unit, hold.plantId)
  return hold
}

async function suspectRestore(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qualityTools(pc)
  const dispositionNote = str(p, 'dispositionNote')
  if (dispositionNote === undefined) {
    throw new QualityRuleViolation('A-T12-3', '存疑恢复必须填写处置依据（disposition_note，最小处置记录）')
  }
  const hold = await lockScopedHold(pc, p)
  // Release custody separately; the historical pre-hold snapshot must never
  // overwrite a later effective test or current-version concession.
  assertSuspectRestorable({ holdStatus: hold.status, releasedBy: pc.ctx.actorLoginName, dispositionNote, unitNo: hold.unitNo })
  const currentFact = await tools.qa.holds.currentQualityByUnit(hold.inventoryUnitId)
  const balances = await tools.inv.balances.listActiveByUnit(hold.inventoryUnitId)
  const historical = hold.previousQualityStatus
  const fallback = balances.length === 1 && (historical === 'qualified' || historical === 'unqualified' || historical === 'pending_inspection')
    ? historical : 'pending_inspection'
  const current = [currentFact, ...balances.map((b) => b.qualityStatus === 'suspect' ? null : b.qualityStatus)]
  const restored = current.includes('unqualified') ? 'unqualified' : current.includes('suspect') ? 'suspect'
    : current.includes('pending_inspection') ? 'pending_inspection' : current.includes('qualified') ? 'qualified' : fallback
  const released = await tools.qa.holds.release(
    hold.id,
    { releasedBy: pc.ctx.actorLoginName, releasedAt: pc.businessTime, dispositionNote },
    pc.ctx.actorLoginName,
  )
  for (const b of balances) {
    if (b.enterpriseId !== hold.enterpriseId || b.plantId !== hold.plantId || b.unitId !== hold.inventoryUnitId) {
      throw new QualityRuleViolation('A-S1', '隔离余额与单元的企业/工厂不一致')
    }
    if (b.qualityStatus !== restored) {
      await tools.inv.balances.adjust(b.id, { qualityStatus: restored }, null)
    }
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'quality.suspect.restore',
    subjectType: 'quality_hold',
    subjectId: hold.id,
    before: { status: 'active', holdKind: hold.holdKind },
    after: { status: 'released', restoredQualityStatus: restored, qualitySource: current.some((value) => value !== null) ? 'current_fact' : 'last_known_pre_hold', dispositionNote },
    reason: str(p, 'reason') ?? null,
  })
  pc.tools.outbox.collect({
    aggregateType: 'quality_hold',
    aggregateId: hold.id,
    taskKind: 'quality.suspect-restored',
    payload: { holdId: hold.id, unitId: hold.inventoryUnitId, restoredQualityStatus: restored, releasedAt: pc.businessTime },
  })
  return { holdId: hold.id, status: released?.status ?? 'released', restoredQualityStatus: restored }
}

// ---------------- 处理器装配 ----------------

type QualityHandlerFn = (pc: PostingContext, p: Payload) => Promise<Record<string, unknown>>

/** 命令处理器清单（组合根装配进 PgCommandBus）。 */
export function createQualityCommandHandlers(): CommandHandler[] {
  const make = (commandType: string, fn: QualityHandlerFn): CommandHandler => ({
    commandType,
    handle: (envelope, ctx, tools): Promise<HandlerOutcome> =>
      run(async () => {
        const qualityTools = tools as QualityCommandTools // 组合根构造的工具集窄化（见 quality.composition）
        const payload = (envelope.payload ?? {}) as Payload
        const pc = await buildPostingContext(qualityTools, ctx, commandType, envelope.operationId, payload)
        return fn(pc, payload)
      }),
  })

  return [
    make('quality.inspection.generate', inspectionGenerate),
    make('quality.test-result.submit', testResultSubmit),
    make('quality.disposition.release', dispositionRelease),
    make('quality.disposition.concession', dispositionConcession),
    make('quality.suspect.register', suspectRegister),
    make('quality.suspect.review', suspectReview),
    make('quality.suspect.restore', suspectRestore),
  ]
}
