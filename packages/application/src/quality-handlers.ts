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
import type { QualityCommandTools } from './quality-repositories'

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

/** 组织范围二道防线（OA-24/26：目标工厂须在 actor 数据范围）。 */
async function assertPlantScope(tools: QualityCommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new QualityRuleViolation('A-S1', `目标工厂不在授权数据范围内（plant=${plantId}）`)
  }
}

function qualityTools(pc: PostingContext): QualityCommandTools {
  return pc.tools as QualityCommandTools
}

/** 检验单绑定单元的库存质量投影刷新（T12 闸门消费口径：IT-14 库存余额 quality_status）。 */
async function syncUnitQualityByNo(
  tools: QualityCommandTools,
  plantId: string,
  unitNo: string | null,
  target: 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect',
): Promise<string | null> {
  if (unitNo === null) return null
  const unit = await tools.inv.units.findByUnitNo(plantId, unitNo)
  if (unit === null) return null // 单元未入库（报工后、入库前）：仅记质量域事实，不动库存
  const balances = await tools.inv.balances.listActiveByUnit(unit.id)
  for (const b of balances) {
    if (b.qualityStatus !== target) {
      await tools.inv.balances.adjust(b.id, { qualityStatus: target }, null)
    }
  }
  return unit.id
}

// ---------------- 命令：检验任务生成（A-T12-5；消费执行块提交事件） ----------------

async function inspectionGenerate(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qualityTools(pc)
  const plantId = requireStr(p, 'plantId', 'quality.inspection.generate')
  await assertPlantScope(tools, plantId)

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
  const order = await tools.qa.inspectionOrders.findById(inspectionOrderId)
  if (order === null) throw new QualityRuleViolation(NOT_FOUND_RULE, '检验单不存在')

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
  if (order.unitNo !== null) {
    await syncUnitQualityByNo(tools, order.plantId, order.unitNo, conclusionRaw === 'qualified' ? 'qualified' : 'unqualified')
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
  const order = await tools.qa.inspectionOrders.findById(inspectionOrderId)
  if (order === null) throw new QualityRuleViolation(NOT_FOUND_RULE, '检验单不存在')
  const effective = await tools.qa.testResults.findEffective(order.id)
  if (effective === null) throw new QualityRuleViolation(NOT_FOUND_RULE, '检验单无生效结论行（链起点缺失）')
  const dispositions = await tools.qa.dispositions.listByOrder(order.id)
  // A-T12-1：仅生效结论=合格可常规放行（不合格走让步；待检不可放行）
  assertReleaseExecutable({
    effectiveConclusion: effective.conclusion,
    alreadyReleased: dispositions.length > 0,
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
  const unitId = await syncUnitQualityByNo(tools, order.plantId, order.unitNo, 'qualified')

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
  const order = await tools.qa.inspectionOrders.findById(inspectionOrderId)
  if (order === null) throw new QualityRuleViolation(NOT_FOUND_RULE, '检验单不存在')
  const effective = await tools.qa.testResults.findEffective(order.id)
  if (effective === null) throw new QualityRuleViolation(NOT_FOUND_RULE, '检验单无生效结论行（链起点缺失）')
  const dispositions = await tools.qa.dispositions.listByOrder(order.id)
  if (dispositions.length > 0) {
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
  const unitId = await syncUnitQualityByNo(tools, order.plantId, order.unitNo, 'qualified')

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
  await assertPlantScope(tools, plantId)

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
  const unit = unitId !== null
    ? await tools.inv.units.findById(unitId)
    : unitNo !== null
      ? await tools.inv.units.findByUnitNo(plantId, unitNo)
      : null
  if (unit === null) {
    throw new QualityRuleViolation(NOT_FOUND_RULE, '库存单元不存在（存疑登记须在库单元）')
  }
  if (unit.plantId !== plantId) {
    throw new QualityRuleViolation('A-S1', `单元不在目标工厂（plant=${plantId}）`)
  }
  const balances = await tools.inv.balances.listActiveByUnit(unit.id)
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
  const tools=qualityTools(pc)
  if (!(await tools.actorPermissions()).includes('quality.post')) throw new QualityRuleViolation('A-S1','缺少质量决定许可')
  if (str(p,'decision')!=='reject' || !str(p,'reason')) throw new QualityRuleViolation('A-T12-3','本入口仅记录有理由的拒绝恢复决定')
  const hold=await tools.qa.holds.findById(str(p,'holdId') ?? '')
  if (hold===null || hold.status!=='active') throw new QualityRuleViolation(NOT_FOUND_RULE,'没有对应活动隔离记录')
  const unit=await tools.inv.units.findById(hold.inventoryUnitId)
  if (unit===null || unit.enterpriseId!==pc.ctx.enterpriseId || hold.enterpriseId!==pc.ctx.enterpriseId || unit.plantId!==hold.plantId) throw new QualityRuleViolation('A-S1','隔离单元不在本企业/工厂')
  await assertPlantScope(tools,unit.plantId)
  const decidedAt=tools.now().toISOString()
  await tools.audit.record({actor:pc.ctx.actorLoginName,action:'quality.suspect.review',subjectType:'quality_hold',subjectId:hold.id,
    after:{decision:'reject',holdStatus:hold.status,unitId:unit.id,decidedAt,restoredQty:'0.0000'},reason:str(p,'reason')!})
  return {holdId:hold.id,reviewDecision:'reject',holdStatus:hold.status,restoredQty:'0.0000',decidedAt}
}

async function suspectRestore(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qualityTools(pc)
  const dispositionNote = str(p, 'dispositionNote')
  if (dispositionNote === undefined) {
    throw new QualityRuleViolation('A-T12-3', '存疑恢复必须填写处置依据（disposition_note，最小处置记录）')
  }
  let hold = null
  const holdId = str(p, 'holdId')
  if (holdId !== undefined) {
    hold = await tools.qa.holds.findById(holdId)
  }
  if (hold === null) {
    const unitId = str(p, 'unitId')
    if (unitId !== undefined) {
      hold = await tools.qa.holds.findActiveByUnit(unitId)
    }
  }
  if (hold === null) {
    throw new QualityRuleViolation(NOT_FOUND_RULE, '未找到指定存疑记录（holdId/unitId 定位失败）')
  }
  // A-T12-3/B-9：恢复须留恢复人/处置依据；记录与码回正常（previous_quality_status）
  assertSuspectRestorable({ holdStatus: hold.status, releasedBy: pc.ctx.actorLoginName, dispositionNote, unitNo: hold.unitNo })
  const restored = (hold.previousQualityStatus as 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect' | null) ?? 'qualified'
  const released = await tools.qa.holds.release(
    hold.id,
    { releasedBy: pc.ctx.actorLoginName, releasedAt: pc.businessTime, dispositionNote },
    pc.ctx.actorLoginName,
  )
  const balances = await tools.inv.balances.listActiveByUnit(hold.inventoryUnitId)
  for (const b of balances) {
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
    after: { status: 'released', restoredQualityStatus: restored, dispositionNote },
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
