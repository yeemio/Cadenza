import { ERROR_CODES } from '@cadenza/contracts'
 
import {
  DEFAULT_LABOR_CHECK_THRESHOLD,
  EQUIPMENT_COST_CALIBER,
  LABOR_PRIMARY_SOURCE,
  SOURCE_TABLES,
  assertAcquisitionInput,
  assertAllocationVersionShape,
  assertMeterReadingShape,
  assertMeterShape,
  assertPriceVersionShape,
  assertReconImportRow,
  assertReconResolvable,
  buildLaborCheck,
  buildOldNewComparison,
  buildReconKey,
  computeEnergyCoverage,
  computeMaterialVariance,
  computeMeteredUsage,
  computeReconDiff,
  estimateMaterialFromBom,
  isValidCostDecimal,
  shiftDayWindow,
  CostRuleViolation,
  COST_NOT_FOUND_RULE,
} from '@cadenza/domain'
import type { CommandHandler, HandlerOutcome } from './command-bus'
import type {
  ConsumptionFact,
  CostAcquisitionLineRecord,
  CostAcquisitionRunRecord,
  CostCommandTools,
  NewCostAcquisitionLine,
} from './cost-repositories'

/**
 * cost 域命令处理器（P3-D / T24 能源与制造成本归集；全部在命令总线事务内运行）。
 *
 * 命令面（10）：
 * - cost.meter.register / cost.meter.reading.record：能源表计配置（CE-S3）与人工抄表（CE-09）；
 * - cost.allocation-version.create / cost.price-version.create：分摊与价格版本（CE-S2/CE-11/CE-14；
 *   被归集引用后库级 immutable）；
 * - cost.acquisition.run：归集（CE-S1/05/07/17/19；只读既有域事实，CE-02 无库存写命令）；
 * - cost.acquisition.recalc：显式重算（CE-11 新版本/新截止时点 → 新 run+新旧对照，历史不动）；
 * - cost.recon.erp-import / cost.recon.resolve：ERP 数量对账（CE-16 模拟适配器；CE-S5 处置流转）；
 * - cost.labor-check.run / cost.labor-check.acknowledge：工时核对（CA-12·PROPOSED 主从口径）。
 *
 * CA-12/CA-13 为 PROPOSED 依赖：工时行只来自 labor_record（主源）、设备成本口径=
 * 机时+备件消耗不含折旧（EQUIPMENT_COST_CALIBER）；PM/Owner 裁定后如改口径走返工小轮。
 */

type Payload = Record<string, unknown>

function costViolationOutcome(error: CostRuleViolation): HandlerOutcome {
  let errorCode: string = ERROR_CODES.BUSINESS_RULE
  if (error.rule === 'A-S1') errorCode = ERROR_CODES.FORBIDDEN_SCOPE
  else if (error.rule === COST_NOT_FOUND_RULE) errorCode = ERROR_CODES.NOT_FOUND
  // 消息已内嵌规则码（CostRuleViolation 构造），此处不重复前缀
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: error.message }
}

async function run(body: () => Promise<Record<string, unknown>>): Promise<HandlerOutcome> {
  try {
    const data = await body()
    return { status: 'COMMITTED', data }
  } catch (error) {
    if (error instanceof CostRuleViolation) return costViolationOutcome(error)
    throw error
  }
}

function str(p: Payload, key: string): string | undefined {
  const v = p[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function requireStr(p: Payload, key: string, command: string): string {
  const v = str(p, key)
  if (v === undefined) throw new CostRuleViolation('CE-S1', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

/** 组织范围二道防线（OA-24/26）。 */
async function assertPlantScope(tools: CostCommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new CostRuleViolation('A-S1', `目标工厂不在授权数据范围内（plant=${plantId}）`)
  }
}

/** 命令回执（同 maintenance 先例：回执未落库拒绝记账）。 */
async function requireReceipt(
  tools: CostCommandTools,
  enterpriseId: string,
  commandType: string,
  operationId: string,
): Promise<string> {
  const receiptId = await tools.cost.receipts.findIdByKey(enterpriseId, commandType, operationId)
  if (receiptId === null) {
    throw new CostRuleViolation('CE-S1', `${commandType}：命令回执未落库（幂等键缺失），拒绝执行`)
  }
  return receiptId
}

// ---------------- 命令：表计登记与人工抄表（CE-S3/CE-09） ----------------

async function meterRegister(tools: CostCommandTools, ctx: { enterpriseId: string; actorLoginName: string }, p: Payload, commandReceiptId: string): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'cost.meter.register')
  await assertPlantScope(tools, plantId)
  const meterCode = requireStr(p, 'meterCode', 'cost.meter.register')
  // CE-S3 形状（含 采样来源与 OT 点位成对）
  assertMeterShape({
    meterCode,
    meterName: str(p, 'meterName') ?? null,
    energyType: str(p, 'energyType') ?? '',
    coverageKind: str(p, 'coverageKind') ?? '',
    equipmentId: str(p, 'equipmentId') ?? null,
    workCenterId: str(p, 'workCenterId') ?? null,
    sampleSource: str(p, 'sampleSource') ?? '',
    otPointId: str(p, 'otPointId') ?? null,
    uomCode: str(p, 'uomCode') ?? '',
  })
  const existing = await tools.cost.meters.findActiveByPlantAndCode(plantId, meterCode)
  if (existing !== null) {
    throw new CostRuleViolation('CE-S3', `表计编码已存在（plant=${plantId}, code=${meterCode}）`)
  }
  const otPointId = str(p, 'otPointId') ?? null
  if (otPointId !== null) {
    const held = await tools.cost.meters.findActiveByOtPoint(otPointId)
    if (held !== null) {
      throw new CostRuleViolation('CE-S3', `OT 点位已被表计 ${held.meterCode} 绑定（一点一计，防双源混读）`)
    }
  }

  const meter = await tools.cost.meters.insert({
    meterCode,
    meterName: str(p, 'meterName') ?? null,
    energyType: str(p, 'energyType') as 'electric' | 'water' | 'gas',
    coverageKind: str(p, 'coverageKind') as 'equipment' | 'workshop',
    equipmentId: str(p, 'equipmentId') ?? null,
    workCenterId: str(p, 'workCenterId') ?? null,
    sampleSource: str(p, 'sampleSource') as 'ot' | 'manual',
    otPointId,
    uomCode: str(p, 'uomCode')!,
    remark: str(p, 'remark') ?? null,
    enterpriseId: ctx.enterpriseId,
    plantId,
    commandReceiptId,
    createdBy: ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'cost.meter.register',
    subjectType: 'cost_meter',
    subjectId: meter.id,
    after: { meterCode, energyType: meter.energyType, coverageKind: meter.coverageKind, sampleSource: meter.sampleSource },
    reason: str(p, 'reason') ?? null,
  })
  return { meterId: meter.id, meterCode: meter.meterCode, status: meter.status }
}

async function meterReadingRecord(tools: CostCommandTools, ctx: { enterpriseId: string; actorLoginName: string }, p: Payload, commandReceiptId: string): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'cost.meter.reading.record')
  await assertPlantScope(tools, plantId)
  const meterId = requireStr(p, 'meterId', 'cost.meter.reading.record')
  const meter = await tools.cost.meters.findById(meterId)
  if (meter === null) throw new CostRuleViolation(COST_NOT_FOUND_RULE, '表计不存在')
  if (meter.plantId !== plantId) throw new CostRuleViolation('A-S1', '表计不在目标工厂')
  if (meter.status !== 'active') throw new CostRuleViolation('CE-S3', '表计已退役，停止抄表')
  const reading = requireStr(p, 'reading', 'cost.meter.reading.record')
  const readAt = requireStr(p, 'readAt', 'cost.meter.reading.record')
  // CE-09 人工抄表通道形状（OT 来源读数只在归集时固化，不走本命令）
  assertMeterReadingShape({ readingType: 'manual', reading, readAt, readBy: ctx.actorLoginName, otSampleId: null })
  if (Number.isNaN(Date.parse(readAt))) throw new CostRuleViolation('CE-09', 'readAt 必须为 ISO-8601 时间')
  const existing = await tools.cost.readings.listByMeterWindow(meterId, readAt, readAt)
  if (existing.some((r) => r.readingType === 'manual')) {
    throw new CostRuleViolation('CE-09', `表计 ${meter.meterCode} 同一抄表时点已有读数（append-only，纠正走新时点读数）`)
  }

  const row = await tools.cost.readings.insert({
    meterId,
    readingType: 'manual',
    reading,
    readAt,
    readBy: ctx.actorLoginName,
    enterpriseId: ctx.enterpriseId,
    plantId,
    commandReceiptId,
    createdBy: ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'cost.meter.reading.record',
    subjectType: 'cost_meter_reading',
    subjectId: row.id,
    after: { meterCode: meter.meterCode, reading, readAt },
    reason: str(p, 'reason') ?? null,
  })
  return { readingId: row.id, meterId, reading, readAt }
}

// ---------------- 命令：分摊版本与价格版本（CE-S2/CE-11/CE-14） ----------------

async function allocationVersionCreate(tools: CostCommandTools, ctx: { enterpriseId: string; actorLoginName: string }, p: Payload, commandReceiptId: string): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'cost.allocation-version.create')
  await assertPlantScope(tools, plantId)
  const versionNoRaw = p['versionNo']
  const versionNo = typeof versionNoRaw === 'number' && Number.isInteger(versionNoRaw) ? versionNoRaw : undefined
  if (versionNo === undefined) throw new CostRuleViolation('CE-S2', 'versionNo 必须为正整数')
  const paramsRaw = p['params']
  const params = paramsRaw !== undefined && paramsRaw !== null && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw)
    ? (paramsRaw as Record<string, unknown>)
    : {}
  const formula = str(p, 'formula') ?? ''
  assertAllocationVersionShape({ versionNo, formula, params })

  const existing = await tools.cost.allocationVersions.findByPlantAndVersionNo(plantId, versionNo)
  if (existing !== null) {
    throw new CostRuleViolation('CE-S2', `分摊版本号已存在（plant=${plantId}, version=${versionNo}）——变更须新建版本并显式重算（CE-11）`)
  }
  const version = await tools.cost.allocationVersions.insert({
    versionNo,
    formula: formula as 'machine_hours' | 'output_qty' | 'power_weight',
    params,
    overheadCaliber: str(p, 'overheadCaliber') ?? null,
    remark: str(p, 'remark') ?? null,
    enterpriseId: ctx.enterpriseId,
    plantId,
    commandReceiptId,
    createdBy: ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'cost.allocation-version.create',
    subjectType: 'cost_allocation_version',
    subjectId: version.id,
    after: { versionNo, formula, params },
    reason: str(p, 'reason') ?? null,
  })
  return { versionId: version.id, versionNo, formula, status: version.status }
}

async function priceVersionCreate(tools: CostCommandTools, ctx: { enterpriseId: string; actorLoginName: string }, p: Payload, commandReceiptId: string): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'cost.price-version.create')
  await assertPlantScope(tools, plantId)
  const versionNoRaw = p['versionNo']
  const versionNo = typeof versionNoRaw === 'number' && Number.isInteger(versionNoRaw) ? versionNoRaw : undefined
  if (versionNo === undefined) throw new CostRuleViolation('CE-14', 'versionNo 必须为正整数')
  const itemsRaw = p['items']
  if (!Array.isArray(itemsRaw)) throw new CostRuleViolation('CE-14', '价格版本必须包含 items 数组')
  const items = itemsRaw.map((raw) => {
    const it = (raw ?? {}) as Payload
    return {
      materialCode: str(it, 'materialCode') ?? '',
      materialId: str(it, 'materialId') ?? null,
      unitPrice: str(it, 'unitPrice') ?? '',
      uomCode: str(it, 'uomCode') ?? '',
    }
  })
  assertPriceVersionShape({ versionNo, priceSource: str(p, 'priceSource') ?? '', items })

  const existing = await tools.cost.priceVersions.findByPlantAndVersionNo(plantId, versionNo)
  if (existing !== null) {
    throw new CostRuleViolation('CE-14', `价格版本号已存在（plant=${plantId}, version=${versionNo}）——价格主权归上游，变更须新版本`)
  }
  const version = await tools.cost.priceVersions.insert({
    versionNo,
    priceSource: str(p, 'priceSource') as 'standard_cost' | 'erp_actual',
    items,
    remark: str(p, 'remark') ?? null,
    enterpriseId: ctx.enterpriseId,
    plantId,
    commandReceiptId,
    createdBy: ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'cost.price-version.create',
    subjectType: 'cost_price_version',
    subjectId: version.id,
    after: { versionNo, priceSource: version.priceSource, items: items.length },
    reason: str(p, 'reason') ?? null,
  })
  return { versionId: version.id, versionNo, priceSource: version.priceSource, items: items.length }
}

// ---------------- 归集核心（CE-02/03/05/07/09/12/17/18/19 + CA-12/13 默认口径） ----------------

interface AcquisitionOutcome {
  run: CostAcquisitionRunRecord
  lines: CostAcquisitionLineRecord[]
  summary: Record<string, unknown>
}

/** OT 表计读数固化（CE-05：能源=OT 表计样本；幂等 by (meter, sample)）。 */
async function ingestOtReadings(
  tools: CostCommandTools,
  meter: { id: string; otPointId: string | null },
  plantId: string,
  windowFrom: string,
  windowTo: string,
  ctx: { enterpriseId: string; actorLoginName: string },
  commandReceiptId: string,
): Promise<void> {
  if (meter.otPointId === null) return
  const samples = await tools.cost.facts.listOtSamplesByPoint(meter.otPointId, windowFrom, windowTo)
  for (const sample of samples) {
    await tools.cost.readings.insertOtIfAbsent({
      meterId: meter.id,
      readingType: 'ot',
      reading: sample.value,
      readAt: sample.eventTime,
      otSampleId: sample.id,
      capturedEventTime: sample.eventTime,
      enterpriseId: ctx.enterpriseId,
      plantId,
      commandReceiptId,
      createdBy: ctx.actorLoginName,
    })
  }
}

async function performAcquisition(
  tools: CostCommandTools,
  ctx: { enterpriseId: string; actorLoginName: string },
  p: Payload,
  commandType: string,
  commandReceiptId: string,
  opts: {
    recalcOf: string | null
    /** CE-11：重算时的旧 run 汇总（对照在新 run 落库前固化） */
    priorSummary: { runId: string; estimateAmount: string | null; actualAmount: string | null; lineCount: number; energyUsage: string; machineHours: string } | null
  },
): Promise<AcquisitionOutcome> {
  const plantId = requireStr(p, 'plantId', commandType)
  await assertPlantScope(tools, plantId)
  const input = {
    orderId: requireStr(p, 'orderId', commandType),
    shiftDate: requireStr(p, 'shiftDate', commandType),
    cutoffAt: requireStr(p, 'dataCutoffAt', commandType),
    allocationVersionId: requireStr(p, 'allocationVersionId', commandType),
    priceVersionId: requireStr(p, 'priceVersionId', commandType),
  }
  assertAcquisitionInput(input)
  // O-3 修复：窗口起点按工厂班次日历（Asia/Shanghai 白班 00:00 = 前日 16:00Z）对齐，
  // 与 labor_record.shift_date 同口径（原 `${shiftDate}T00:00:00Z` UTC 零点锚跨北京零点错位一日）
  const { from: windowFrom } = shiftDayWindow(input.shiftDate)
  if (Date.parse(input.cutoffAt) < Date.parse(windowFrom)) {
    throw new CostRuleViolation('CE-S1', '数据截止时点不得早于班次日期起点')
  }
  const windowTo = input.cutoffAt

  // 锚：订单/版本/班次日历（CE-S4：归集产出带业务班次引用）
  const order = await tools.cost.facts.findProductionOrder(input.orderId)
  if (order === null) throw new CostRuleViolation(COST_NOT_FOUND_RULE, '生产订单不存在')
  if (order.plantId !== plantId) throw new CostRuleViolation('A-S1', '生产订单不在目标工厂')
  const allocation = await tools.cost.allocationVersions.findById(input.allocationVersionId)
  if (allocation === null || allocation.plantId !== plantId) throw new CostRuleViolation(COST_NOT_FOUND_RULE, '分摊版本不存在或不属于目标工厂')
  if (allocation.status !== 'active') throw new CostRuleViolation('CE-S2', '分摊版本非 active，不可绑定归集')
  const priceVersion = await tools.cost.priceVersions.findById(input.priceVersionId)
  if (priceVersion === null || priceVersion.plantId !== plantId) throw new CostRuleViolation(COST_NOT_FOUND_RULE, '价格版本不存在或不属于目标工厂')
  if (priceVersion.status !== 'active') throw new CostRuleViolation('CE-14', '价格版本非 active，不可绑定归集')
  const priceItems = await tools.cost.priceVersions.findItems(input.priceVersionId)
  const shiftCalendar = await tools.cost.facts.findShiftCalendar(plantId)
  if (shiftCalendar === null) {
    throw new CostRuleViolation('CE-S4', '工厂无活动班次日历，归集缺少班次锚（先配置班次日历）')
  }
  // CE-19：班次快照锚（消费 0016 shift_snapshot；无行=null=快照缺项标注）
  const snapshotStats = await tools.cost.facts.shiftSnapshotStats(plantId, input.shiftDate)

  // ---- 事实读取（CE-05 唯一来源映射；CE-02 只读） ----
  const consumption = await tools.cost.facts.listConsumptionByOrder(input.orderId, windowTo)
  const labor = await tools.cost.facts.listLaborByOrder(input.orderId, windowTo)
  const outputs = await tools.cost.facts.listOutputsByOrder(input.orderId, windowTo)
  const orderSessionEquipments = await tools.cost.facts.listSessionEquipmentCountsByOrder(input.orderId, windowTo)
  const plantSessionEquipments = await tools.cost.facts.listSessionEquipmentCounts(plantId, windowFrom, windowTo)
  const plantOutputs = await tools.cost.facts.listPlantOutputByOrder(plantId, windowFrom, windowTo)

  const ops = await tools.cost.facts.listOrderOperations(input.orderId)
  const opById = new Map(ops.map((o) => [o.id, o]))
  const bomLines = await tools.cost.facts.findPublishedBomLines(input.orderId)

  // ---- 估算列（CE-17：BOM×计划数量×价格版本；无已发布 BOM=估算缺项） ----
  const estimateLines = bomLines === null
    ? null
    : estimateMaterialFromBom({ bomLines, plannedQty: order.plannedQty, priceItems })
  const estimateMissingCount = estimateLines?.filter((l) => l.priceMissing).length ?? 0

  // ---- 设备运行（CE-05：OT 采集等价计算；CA-12 参考源不入工时行） ----
  const equipmentByCode = new Map<string, { id: string; code: string; name: string; stdRateText: string | null }>()
  for (const se of plantSessionEquipments) {
    const eq = await tools.cost.facts.findEquipmentByCode(plantId, se.equipmentCode)
    if (eq !== null) equipmentByCode.set(eq.code, eq)
  }
  const runtimeByEquipment = new Map<string, { hours: string; firstSampleId: string | null; sampleCount: number }>()
  for (const eq of equipmentByCode.values()) {
    const rt = await tools.cost.facts.otRuntimeHoursByEquipment(eq.id, windowFrom, windowTo)
    if (rt !== null) runtimeByEquipment.set(eq.code, rt)
  }
  const plantTotalMachineHours = [...runtimeByEquipment.entries()]
    .filter(([code]) => plantSessionEquipments.some((s) => s.equipmentCode === code))
    .reduce((acc, [, rt]) => acc + Number(rt.hours), 0)
  const orderMachineHoursByEquipment = new Map<string, number>()
  const orderOpSessionsByEquipment = new Map<string, Map<string, number>>()
  for (const se of orderSessionEquipments) {
    const rt = runtimeByEquipment.get(se.equipmentCode)
    if (rt === undefined) continue
    const plantSessions = plantSessionEquipments.find((s) => s.equipmentCode === se.equipmentCode)?.sessionCount ?? 0
    const share = plantSessions > 0 ? Math.min(1, se.sessionCount / plantSessions) : 1
    orderMachineHoursByEquipment.set(se.equipmentCode, (orderMachineHoursByEquipment.get(se.equipmentCode) ?? 0) + Number(rt.hours) * share)
    const opKey = se.orderOperationId ?? ''
    const perOp = orderOpSessionsByEquipment.get(se.equipmentCode) ?? new Map<string, number>()
    perOp.set(opKey, (perOp.get(opKey) ?? 0) + se.sessionCount)
    orderOpSessionsByEquipment.set(se.equipmentCode, perOp)
  }
  const orderMachineHours = Number(orderMachineHoursByEquipment.size) === 0 ? 0 : [...orderMachineHoursByEquipment.values()].reduce((a, b) => a + b, 0)

  // ---- 能源（CE-09 计量口径/覆盖率；CE-12 分摊版本公式） ----
  const meters = await tools.cost.meters.listActiveByPlant(plantId)
  const meterUsages: Array<{ meter: { id: string; meterCode: string; energyType: string; coverageKind: string; equipmentId: string | null; uomCode: string; otPointId: string | null }; usage: string; firstReadingId: string | null; readingCount: number; window: { from: string; to: string } }> = []
  for (const meter of meters) {
    if (meter.sampleSource === 'ot') {
      await ingestOtReadings(tools, meter, plantId, windowFrom, windowTo, ctx, commandReceiptId)
    }
    const readings = await tools.cost.readings.listByMeterWindow(meter.id, windowFrom, windowTo)
    const usage = computeMeteredUsage(readings.map((r) => ({ readAt: r.readAt, reading: r.reading })))
    meterUsages.push({
      meter: { id: meter.id, meterCode: meter.meterCode, energyType: meter.energyType, coverageKind: meter.coverageKind, equipmentId: meter.equipmentId, uomCode: meter.uomCode, otPointId: meter.otPointId },
      usage: usage.usage,
      firstReadingId: readings[0]?.id ?? null,
      readingCount: usage.readingCount,
      window: { from: usage.fromAt ?? windowFrom, to: usage.toAt ?? windowTo },
    })
  }
  const meteredTotal = meterUsages.reduce((acc, m) => acc + Number(m.usage), 0)
  const coveredEquipmentCodes = new Set<string>()
  let workshopMeterPresent = false
  for (const m of meterUsages) {
    if (m.meter.coverageKind === 'equipment' && m.meter.equipmentId !== null) {
      const code = [...equipmentByCode.values()].find((eq) => eq.id === m.meter.equipmentId)?.code
      if (code !== undefined) coveredEquipmentCodes.add(code)
    } else if (m.meter.coverageKind === 'workshop') workshopMeterPresent = true
  }
  const coveredMachineHours = workshopMeterPresent
    ? plantTotalMachineHours
    : [...coveredEquipmentCodes].reduce((acc, code) => acc + Number(runtimeByEquipment.get(code)?.hours ?? 0), 0)
  const uncoveredMachineHours = Math.max(0, plantTotalMachineHours - coveredMachineHours)

  // CE-12：共用量分摊基（分摊公式版本决定）
  const plantOutputTotal = plantOutputs.reduce((acc, o) => acc + Number(o.quantity), 0)
  const orderOutputQty = outputs.reduce((acc, o) => acc + Number(o.quantity), 0)
  const plantRuntimeHoursByEquipment = new Map<string, number>()
  for (const [code, rt] of runtimeByEquipment) {
    if (plantSessionEquipments.some((s) => s.equipmentCode === code)) plantRuntimeHoursByEquipment.set(code, Number(rt.hours))
  }
  let orderEnergyShare = 0
  if (allocation.formula === 'machine_hours') {
    orderEnergyShare = plantTotalMachineHours > 0 ? orderMachineHours / plantTotalMachineHours : 0
  } else if (allocation.formula === 'output_qty') {
    orderEnergyShare = plantOutputTotal > 0 ? orderOutputQty / plantOutputTotal : 0
  } else {
    // power_weight：按设备功率权重×运行小时的加权占比（权重来自版本参数）
    const weights = (allocation.params['weights'] ?? {}) as Record<string, string>
    const weightedOf = (hoursByEquipment: Map<string, number>): number =>
      [...hoursByEquipment.entries()].reduce((acc, [code, hours]) => acc + Number(weights[code] ?? '0') * hours, 0)
    const orderWeighted = weightedOf(orderMachineHoursByEquipment)
    const plantWeighted = weightedOf(plantRuntimeHoursByEquipment)
    orderEnergyShare = plantWeighted > 0 ? orderWeighted / plantWeighted : 0
  }

  // CE-09：覆盖不足部分估算外推（强度=实测/覆盖机时；无实测基 → 不外推不冒充）
  const intensity = coveredMachineHours > 0 ? meteredTotal / coveredMachineHours : null
  const estimatedTotal = intensity !== null ? intensity * uncoveredMachineHours : 0

  // ---- 备件消耗（CA-13 默认口径组成部分） ----
  const spareFacts: Array<{ fact: { id: string; quantity: string; uomCode: string; materialCode: string | null; equipmentId: string; businessTime: string }; equipmentCode: string; share: number }> = []
  for (const [code] of orderMachineHoursByEquipment) {
    const eq = equipmentByCode.get(code)
    if (eq === undefined) continue
    const plantSessions = plantSessionEquipments.find((s) => s.equipmentCode === code)?.sessionCount ?? 0
    const orderSessions = orderSessionEquipments.filter((s) => s.equipmentCode === code).reduce((a, s) => a + s.sessionCount, 0)
    const share = plantSessions > 0 ? Math.min(1, orderSessions / plantSessions) : 1
    const usages = await tools.cost.facts.listSparePartUsageByEquipment(eq.id, windowFrom, windowTo)
    for (const fact of usages) spareFacts.push({ fact, equipmentCode: code, share })
  }

  // ---- 行装配（runId 在 run 落库后统一回填） ----
  const newLines: Array<Omit<NewCostAcquisitionLine, 'runId'>> = []
  let lineNo = 0
  const pushLine = (line: Omit<NewCostAcquisitionLine, 'lineNo' | 'runId'>): void => {
    lineNo += 1
    newLines.push({ ...line, lineNo })
  }
  const priceOf = (materialCode: string | null): { unitPrice: string; uomCode: string } | null =>
    materialCode === null ? null : (priceItems.find((i) => i.materialCode === materialCode) ?? null)

  // 1) 材料实耗（CE-05 消耗流水；CE-07 理论分列）——按 (工序, 料品) 聚合
  interface MaterialAgg { operationId: string; materialCode: string | null; uomCode: string; qty: number; ids: string[]; firstId: string; factsList: ConsumptionFact[] }
  const materialAgg = new Map<string, MaterialAgg>()
  for (const c of consumption) {
    const key = `${c.orderOperationId}|${c.materialCode ?? 'UNKNOWN'}`
    const agg = materialAgg.get(key) ?? {
      operationId: c.orderOperationId, materialCode: c.materialCode, uomCode: c.uomCode, qty: 0, ids: [], firstId: c.id, factsList: [] as ConsumptionFact[],
    }
    agg.qty += Number(c.quantity)
    agg.ids.push(c.id)
    agg.factsList.push(c)
    materialAgg.set(key, agg)
  }
  // CE-07：理论量按料品（BOM×计划数量）；损耗与去向缺口在行级标注
  const theoreticalByMaterial = new Map<string, string>()
  for (const line of estimateLines ?? []) theoreticalByMaterial.set(line.materialCode, line.theoreticalQty)
  const actualByMaterial = new Map<string, number>()
  for (const agg of materialAgg.values()) {
    actualByMaterial.set(agg.materialCode ?? 'UNKNOWN', (actualByMaterial.get(agg.materialCode ?? 'UNKNOWN') ?? 0) + agg.qty)
  }
  const scrapKnownTotal = outputs.reduce((acc, o) => acc + (Number(o.quantity) - Number(o.qualifiedQty)), 0)
  for (const agg of materialAgg.values()) {
    const theoretical = agg.materialCode !== null ? theoreticalByMaterial.get(agg.materialCode) ?? null : null
    const variance = theoretical !== null ? computeMaterialVariance({
      theoreticalQty: theoretical,
      actualQty: agg.qty.toFixed(4),
      wipChangeQty: '0.0000',
      scrapQty: '0.0000',
    }) : null
    const materialActualTotal = actualByMaterial.get(agg.materialCode ?? 'UNKNOWN') ?? 0
    const materialTheoretical = agg.materialCode !== null ? theoreticalByMaterial.get(agg.materialCode) : undefined
    const materialVariance = materialTheoretical !== undefined
      ? computeMaterialVariance({ theoreticalQty: materialTheoretical, actualQty: materialActualTotal.toFixed(4), wipChangeQty: '0.0000', scrapQty: scrapKnownTotal.toFixed(4) })
      : null
    const price = priceOf(agg.materialCode)
    const op = opById.get(agg.operationId)
    pushLine({
      sourceKind: 'material',
      sourceTable: SOURCE_TABLES.material,
      sourceFactId: agg.firstId,
      valueFlag: 'measured',
      orderId: input.orderId,
      orderOperationId: agg.operationId,
      productFamilyId: order.productFamilyId,
      quantity: agg.qty.toFixed(4),
      uomCode: agg.uomCode,
      theoreticalQuantity: theoretical,
      varianceQuantity: materialVariance?.varianceQty ?? variance?.varianceQty ?? null,
      destinationBreakdownMissing: materialVariance?.destinationBreakdownMissing ?? false,
      unitPrice: price?.unitPrice ?? null,
      priceMissing: price === null,
      amount: price === null ? null : (Number(agg.qty) * Number(price.unitPrice)).toFixed(4),
      facts: { consumptionIds: agg.ids, consumptionCount: agg.ids.length, materialCode: agg.materialCode, operationSeq: op?.seq ?? null, scrapKnownTotal: scrapKnownTotal.toFixed(4) },
      createdBy: ctx.actorLoginName,
    })
  }

  // 2) 工时（CA-12·PROPOSED：唯一主源 labor_record；工资金额出界 CE-01 → amount 恒 null）——按工序聚合
  const laborAgg = new Map<string, { operationId: string | null; hours: number; ids: string[]; firstId: string }>()
  for (const l of labor) {
    const key = l.orderOperationId ?? ''
    const agg = laborAgg.get(key) ?? { operationId: l.orderOperationId, hours: 0, ids: [], firstId: l.id }
    agg.hours += Number(l.hours)
    agg.ids.push(l.id)
    laborAgg.set(key, agg)
  }
  for (const agg of laborAgg.values()) {
    pushLine({
      sourceKind: 'labor',
      sourceTable: SOURCE_TABLES.labor,
      sourceFactId: agg.firstId,
      valueFlag: 'measured',
      orderId: input.orderId,
      orderOperationId: agg.operationId,
      productFamilyId: order.productFamilyId,
      quantity: agg.hours.toFixed(4),
      uomCode: 'H',
      unitPrice: null,
      priceMissing: false,
      amount: null,
      facts: { laborRecordIds: agg.ids, laborRecordCount: agg.ids.length, laborSource: LABOR_PRIMARY_SOURCE, note: '工资金额出界（CE-01），仅归集工时数量' },
      createdBy: ctx.actorLoginName,
    })
  }

  // 3) 损耗（CE-07：报工不合格量；去向=废料）
  for (const o of outputs) {
    const scrapQty = Number(o.quantity) - Number(o.qualifiedQty)
    if (scrapQty <= 0) continue
    const price = priceOf(order.materialCode)
    pushLine({
      sourceKind: 'scrap',
      sourceTable: SOURCE_TABLES.scrap,
      sourceFactId: o.id,
      valueFlag: 'measured',
      orderId: input.orderId,
      orderOperationId: o.orderOperationId,
      productFamilyId: order.productFamilyId,
      quantity: scrapQty.toFixed(4),
      uomCode: o.uomCode,
      unitPrice: price?.unitPrice ?? null,
      priceMissing: price === null,
      amount: price === null ? null : (scrapQty * Number(price.unitPrice)).toFixed(4),
      facts: { destination: 'scrap', outputQty: o.quantity, qualifiedQty: o.qualifiedQty, stockUnitId: o.stockUnitId },
      createdBy: ctx.actorLoginName,
    })
  }

  // 4) 设备运行机时（CE-05 OT 采集；CE-03 份额分摊<1 标估算）
  for (const [code] of orderMachineHoursByEquipment) {
    const rt = runtimeByEquipment.get(code)
    const eq = equipmentByCode.get(code)
    if (rt === undefined || eq === undefined) continue
    const plantSessions = plantSessionEquipments.find((s) => s.equipmentCode === code)?.sessionCount ?? 0
    const orderSessions = orderSessionEquipments.filter((s) => s.equipmentCode === code).reduce((a, s) => a + s.sessionCount, 0)
    const share = plantSessions > 0 ? Math.min(1, orderSessions / plantSessions) : 1
    if (rt.firstSampleId === null) continue
    // 按工序拆分（设备在本订单各工序的会话占比）
    const perOp = orderOpSessionsByEquipment.get(code) ?? new Map<string, number>([['', orderSessions]])
    const opTotal = [...perOp.values()].reduce((a, b) => a + b, 0) || 1
    for (const [opId, count] of perOp) {
      const portion = Number(rt.hours) * share * (count / opTotal)
      if (portion <= 0) continue
      pushLine({
        sourceKind: 'equipment_runtime',
        sourceTable: SOURCE_TABLES.equipment_runtime,
        sourceFactId: rt.firstSampleId,
        valueFlag: share === 1 ? 'measured' : 'estimated',
        orderId: input.orderId,
        orderOperationId: opId === '' ? null : opId,
        productFamilyId: order.productFamilyId,
        quantity: portion.toFixed(4),
        uomCode: 'H',
        unitPrice: null,
        priceMissing: false,
        amount: null,
        facts: { equipmentCode: eq.code, equipmentName: eq.name, sampleCount: rt.sampleCount, sessionShare: share.toFixed(4), orderSessions, plantSessions, note: '机时费率未配置（折旧出界 CA-13），仅归集机时数量' },
        createdBy: ctx.actorLoginName,
      })
    }
  }

  // 5) 备件消耗（CA-13 默认口径=机时+备件；份额分摊）
  for (const sp of spareFacts) {
    const qty = Number(sp.fact.quantity) * sp.share
    const price = priceOf(sp.fact.materialCode)
    pushLine({
      sourceKind: 'spare_part',
      sourceTable: SOURCE_TABLES.spare_part,
      sourceFactId: sp.fact.id,
      valueFlag: sp.share === 1 ? 'measured' : 'estimated',
      orderId: input.orderId,
      orderOperationId: null,
      productFamilyId: order.productFamilyId,
      quantity: qty.toFixed(4),
      uomCode: sp.fact.uomCode,
      unitPrice: price?.unitPrice ?? null,
      priceMissing: price === null,
      amount: price === null ? null : (qty * Number(price.unitPrice)).toFixed(4),
      facts: { equipmentCode: sp.equipmentCode, sessionShare: sp.share.toFixed(4), rawQuantity: sp.fact.quantity },
      createdBy: ctx.actorLoginName,
    })
  }

  // 6) 能源（CE-09：实测=表计读数差；估算=覆盖不足外推；CE-12 分摊）
  const energyUom = meterUsages[0]?.meter.uomCode ?? null
  for (const m of meterUsages) {
    if (Number(m.usage) <= 0) continue
    let allocatedQty: number
    let opId: string | null = null
    if (m.meter.coverageKind === 'equipment' && m.meter.equipmentId !== null) {
      // 设备级表计：按该设备订单机时份额归属（无 OT 运行→按会话份额）
      const eqCode = [...equipmentByCode.values()].find((eq) => eq.id === m.meter.equipmentId)?.code
      const orderHours = eqCode !== undefined ? orderMachineHoursByEquipment.get(eqCode) : undefined
      const eqTotalHours = eqCode !== undefined ? Number(runtimeByEquipment.get(eqCode)?.hours ?? 0) : 0
      if (orderHours !== undefined && eqTotalHours > 0) {
        allocatedQty = Number(m.usage) * (orderHours / eqTotalHours)
      } else {
        const plantSessions = plantSessionEquipments.find((s) => s.equipmentCode === eqCode)?.sessionCount ?? 0
        const orderSessions = orderSessionEquipments.filter((s) => s.equipmentCode === eqCode).reduce((a, s) => a + s.sessionCount, 0)
        allocatedQty = plantSessions > 0 ? Number(m.usage) * (orderSessions / plantSessions) : 0
      }
      if (eqCode !== undefined) {
        const perOp = [...(orderOpSessionsByEquipment.get(eqCode) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])
        if (perOp.length > 0) opId = perOp[0]![0] === '' ? null : perOp[0]![0]
      }
    } else {
      // 车间级表计：CE-12 公式份额
      allocatedQty = Number(m.usage) * orderEnergyShare
    }
    if (allocatedQty <= 0 || m.firstReadingId === null) continue
    pushLine({
      sourceKind: 'energy',
      sourceTable: SOURCE_TABLES.energy,
      sourceFactId: m.firstReadingId,
      valueFlag: 'measured',
      orderId: input.orderId,
      orderOperationId: opId,
      productFamilyId: order.productFamilyId,
      quantity: allocatedQty.toFixed(4),
      uomCode: m.meter.uomCode,
      unitPrice: null,
      priceMissing: false,
      amount: null,
      facts: { meterCode: m.meter.meterCode, energyType: m.meter.energyType, coverageKind: m.meter.coverageKind, meterUsage: m.usage, readingCount: m.readingCount, window: m.window, note: '能源价格未配置（GAP-E22），仅归集用量' },
      createdBy: ctx.actorLoginName,
    })
  }
  const estimatedForOrder = estimatedTotal * orderEnergyShare
  if (estimatedForOrder > 0 && meterUsages.some((m) => m.firstReadingId !== null)) {
    const basis = meterUsages.find((m) => m.firstReadingId !== null)!
    pushLine({
      sourceKind: 'energy',
      sourceTable: SOURCE_TABLES.energy,
      sourceFactId: basis.firstReadingId!,
      valueFlag: 'estimated',
      orderId: input.orderId,
      orderOperationId: null,
      productFamilyId: order.productFamilyId,
      quantity: estimatedForOrder.toFixed(4),
      uomCode: basis.meter.uomCode,
      unitPrice: null,
      priceMissing: false,
      amount: null,
      facts: { basis: 'intensity_extrapolation', intensityPerHour: intensity?.toFixed(6) ?? null, uncoveredMachineHours: uncoveredMachineHours.toFixed(4), shareBasis: allocation.formula, note: '覆盖不足部分按估算外推并显著标注（CE-09）' },
      createdBy: ctx.actorLoginName,
    })
  }
  const coverage = computeEnergyCoverage(meteredTotal.toFixed(4), estimatedTotal.toFixed(4))

  // ---- 金额汇总（CE-03：任一计价行缺价 → 金额 null 不出部分和假值） ----
  const pricedKinds = new Set(['material', 'scrap', 'spare_part'])
  let anyPriceMissing = false
  let actualSum = 0
  for (const line of newLines) {
    if (!pricedKinds.has(line.sourceKind)) continue
    if (line.priceMissing) anyPriceMissing = true
    if (line.amount !== null && line.amount !== undefined) actualSum += Number(line.amount)
  }
  const actualAmount = anyPriceMissing ? null : actualSum.toFixed(4)
  let estimateAmount: string | null = null
  let estimateMissingReason: string | null = null
  if (estimateLines === null) {
    estimateMissingReason = '无已发布 BOM 版本（估算缺项，不以假值冒充）'
  } else if (estimateLines.some((l) => l.priceMissing)) {
    estimateMissingReason = `${estimateMissingCount} 个估算行缺价（数量列示+缺价标注，不填默认价）`
  } else {
    estimateAmount = estimateLines.reduce((acc, l) => acc + Number(l.amount ?? 0), 0).toFixed(4)
  }

  const runNo = `CA-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`
  // CE-11：显式重算的新旧对照在落库前固化（run 为 append-only，事后不可补写）
  const energyUsageTotal = (meteredTotal + estimatedTotal).toFixed(4)
  const comparison = opts.priorSummary !== null
    ? buildOldNewComparison(opts.priorSummary, {
        runId: 'pending',
        estimateAmount,
        actualAmount,
        lineCount: newLines.length,
        energyUsage: energyUsageTotal,
        machineHours: orderMachineHours.toFixed(4),
      })
    : null
  const run = await tools.cost.runs.insert({
    runNo,
    orderId: input.orderId,
    allocationVersionId: input.allocationVersionId,
    priceVersionId: input.priceVersionId,
    shiftDate: input.shiftDate,
    shiftCalendarId: shiftCalendar.id,
    dataCutoffAt: input.cutoffAt,
    shiftSnapshotAnchor: snapshotStats === null ? null : { snapshotCount: snapshotStats.snapshotCount, lastComputedAt: snapshotStats.lastComputedAt, source: 'shift_snapshot(0016)' },
    estimateAmount,
    actualAmount,
    estimatePossible: estimateLines !== null,
    estimateMissingReason,
    energyMeteredUsage: meteredTotal.toFixed(4),
    energyEstimatedUsage: estimatedTotal.toFixed(4),
    energyCoverageRatio: coverage.coverageRatio,
    energyUomCode: energyUom,
    machineHours: orderMachineHours.toFixed(4),
    laborSource: LABOR_PRIMARY_SOURCE,
    equipmentCostCaliber: EQUIPMENT_COST_CALIBER,
    recalcOf: opts.recalcOf,
    oldNewComparison: comparison === null ? null : (comparison as unknown as Record<string, unknown>),
    enterpriseId: ctx.enterpriseId,
    plantId,
    businessTime: tools.now().toISOString(),
    commandReceiptId,
    createdBy: ctx.actorLoginName,
  })
  const lines = newLines.length > 0 ? await tools.cost.lines.insertMany(newLines.map((l) => ({ ...l, runId: run.id }))) : []

  tools.outbox.collect({
    aggregateType: 'cost_acquisition_run',
    aggregateId: run.id,
    taskKind: 'cost.acquisition.completed',
    payload: { runId: run.id, runNo, orderId: input.orderId, shiftDate: input.shiftDate, dataCutoffAt: input.cutoffAt, actualAmount, estimateAmount, lineCount: lines.length },
  })

  const summary = {
    runId: run.id,
    runNo,
    orderId: input.orderId,
    orderNo: order.orderNo,
    shiftDate: input.shiftDate,
    dataCutoffAt: input.cutoffAt,
    shiftSnapshotAnchor: run.shiftSnapshotAnchor,
    estimateAmount,
    estimatePossible: run.estimatePossible,
    estimateMissingReason,
    actualAmount,
    anyPriceMissing,
    lines: lines.length,
    energy: {
      meteredUsage: run.energyMeteredUsage,
      estimatedUsage: run.energyEstimatedUsage,
      coverageRatio: run.energyCoverageRatio,
      uomCode: run.energyUomCode,
      coveredMachineHours: coveredMachineHours.toFixed(4),
      uncoveredMachineHours: uncoveredMachineHours.toFixed(4),
      noMeteredBasis: meteredTotal === 0 && plantTotalMachineHours > 0,
    },
    machineHours: run.machineHours,
    laborSource: run.laborSource,
    equipmentCostCaliber: run.equipmentCostCaliber,
    wipChangeQty: outputs.filter((o) => o.stockUnitId === null).reduce((acc, o) => acc + Number(o.quantity), 0).toFixed(4),
    recalcOf: opts.recalcOf,
    oldNewComparison: comparison,
  }
  return { run, lines, summary }
}

// ---------------- 命令：归集与显式重算（CE-11） ----------------

async function acquisitionRun(tools: CostCommandTools, ctx: { enterpriseId: string; actorLoginName: string }, p: Payload, _operationId: string, commandReceiptId: string): Promise<Record<string, unknown>> {
  const orderId = requireStr(p, 'orderId', 'cost.acquisition.run')
  const shiftDate = requireStr(p, 'shiftDate', 'cost.acquisition.run')
  // CE-11：同 (order, shift) 已有归集 → 首跑命令拒绝，重算走显式 recalc
  const existingCount = await tools.cost.runs.countByOrderAndShift(orderId, shiftDate)
  if (existingCount > 0) {
    throw new CostRuleViolation('CE-11', `订单 ${orderId} 班次 ${shiftDate} 已有归集产出（${existingCount} 次）——历史报表不静默重算，重算走显式命令 cost.acquisition.recalc`)
  }
  const { run, summary } = await performAcquisition(tools, ctx, p, 'cost.acquisition.run', commandReceiptId, { recalcOf: null, priorSummary: null })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'cost.acquisition.run',
    subjectType: 'cost_acquisition_run',
    subjectId: run.id,
    after: summary,
    reason: str(p, 'reason') ?? null,
  })
  return summary
}

async function acquisitionRecalc(tools: CostCommandTools, ctx: { enterpriseId: string; actorLoginName: string }, p: Payload, commandReceiptId: string): Promise<Record<string, unknown>> {
  // OA-29：显式重算为高影响操作，理由必填
  const reason = str(p, 'reason')
  if (reason === undefined) throw new CostRuleViolation('CE-11', 'cost.acquisition.recalc：重算必须填写理由（reason，OA-29 高影响操作留痕）')
  const orderId = requireStr(p, 'orderId', 'cost.acquisition.recalc')
  const shiftDate = requireStr(p, 'shiftDate', 'cost.acquisition.recalc')
  const prior = await tools.cost.runs.findLatestByOrderAndShift(orderId, shiftDate)
  if (prior === null) {
    throw new CostRuleViolation('CE-11', `订单 ${orderId} 班次 ${shiftDate} 无既有归集产出——首次归集走 cost.acquisition.run`)
  }
  const priorLines = await tools.cost.lines.listByRun(prior.id)
  const { run, summary } = await performAcquisition(tools, ctx, p, 'cost.acquisition.recalc', commandReceiptId, {
    recalcOf: prior.id,
    priorSummary: {
      runId: prior.id,
      estimateAmount: prior.estimateAmount,
      actualAmount: prior.actualAmount,
      lineCount: priorLines.length,
      energyUsage: (Number(prior.energyMeteredUsage) + Number(prior.energyEstimatedUsage)).toFixed(4),
      machineHours: prior.machineHours,
    },
  })
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'cost.acquisition.recalc',
    subjectType: 'cost_acquisition_run',
    subjectId: run.id,
    before: { priorRunId: prior.id, priorActualAmount: prior.actualAmount },
    after: summary,
    reason,
  })
  return summary
}

// ---------------- 命令：ERP 对账（CE-16 模拟适配器 / CE-S5 处置） ----------------

async function reconErpImport(tools: CostCommandTools, ctx: { enterpriseId: string; actorLoginName: string }, p: Payload, commandReceiptId: string): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'cost.recon.erp-import')
  await assertPlantScope(tools, plantId)
  const runId = requireStr(p, 'runId', 'cost.recon.erp-import')
  const run = await tools.cost.runs.findById(runId)
  if (run === null) throw new CostRuleViolation(COST_NOT_FOUND_RULE, '归集产出不存在')
  if (run.plantId !== plantId) throw new CostRuleViolation('A-S1', '归集产出不在目标工厂')
  const rowsRaw = p['rows']
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
    throw new CostRuleViolation('CE-16', '对账入站必须包含 rows 数组（至少一行）')
  }
  const order = await tools.cost.facts.findProductionOrder(run.orderId)
  const inserted: Array<Record<string, unknown>> = []
  const skipped: Array<Record<string, unknown>> = []
  for (const [index, raw] of rowsRaw.entries()) {
    const r = (raw ?? {}) as Payload
    const kind = str(r, 'kind') ?? ''
    const row = {
      kind,
      localQuantity: str(r, 'localQuantity') ?? '',
      erpQuantity: str(r, 'erpQuantity') ?? '',
      uomCode: str(r, 'uomCode') ?? '',
      materialCode: str(r, 'materialCode') ?? null,
      orderNo: str(r, 'orderNo') ?? order?.orderNo ?? null,
      erpDocumentRef: str(r, 'erpDocumentRef') ?? null,
    }
    // CE-16：数量基础双侧校验（数量可核对）
    assertReconImportRow(row as Parameters<typeof assertReconImportRow>[0])
    const reconKey = buildReconKey({ runId, kind: kind as 'material' | 'labor' | 'energy', materialCode: row.materialCode, orderNo: row.orderNo })
    const existing = await tools.cost.reconItems.findByKey(reconKey)
    if (existing !== null) {
      skipped.push({ index, reconKey, dispositionStatus: existing.dispositionStatus })
      continue
    }
    const diff = computeReconDiff(row.localQuantity, row.erpQuantity)
    const item = await tools.cost.reconItems.insert({
      reconKey,
      runId,
      kind: kind as 'material' | 'labor' | 'energy',
      localQuantity: row.localQuantity,
      erpQuantity: row.erpQuantity,
      diffQuantity: diff,
      uomCode: row.uomCode,
      materialCode: row.materialCode,
      orderNo: row.orderNo,
      erpDocumentRef: row.erpDocumentRef,
      enterpriseId: ctx.enterpriseId,
      plantId,
      commandReceiptId,
      createdBy: ctx.actorLoginName,
    })
    inserted.push({ itemId: item.id, reconKey, diffQuantity: diff, dispositionStatus: item.dispositionStatus })
  }
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'cost.recon.erp-import',
    subjectType: 'cost_acquisition_run',
    subjectId: runId,
    after: { inserted: inserted.length, skipped: skipped.length, adapter: 'simulated（真实 ERP 对账 BLOCKED_EXTERNAL，CE-16 接口无样例期间以模拟适配器证明合同）' },
    reason: str(p, 'reason') ?? null,
  })
  return { runId, inserted, skipped, adapter: 'simulated' }
}

async function reconResolve(tools: CostCommandTools, ctx: { enterpriseId: string; actorLoginName: string }, p: Payload): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'cost.recon.resolve')
  await assertPlantScope(tools, plantId)
  const itemId = requireStr(p, 'itemId', 'cost.recon.resolve')
  const targetStatus = requireStr(p, 'targetStatus', 'cost.recon.resolve')
  // 理由缺失由 CE-S5 域断言拒（处置流转须理由——非载荷形状问题）
  const reason = str(p, 'reason') ?? null
  const item = await tools.cost.reconItems.findById(itemId)
  if (item === null) throw new CostRuleViolation(COST_NOT_FOUND_RULE, '对账差异行不存在')
  if (item.plantId !== plantId) throw new CostRuleViolation('A-S1', '对账差异行不在目标工厂')
  assertReconResolvable({ currentStatus: item.dispositionStatus, targetStatus, reason })
  if (reason === null) throw new CostRuleViolation('CE-S5', '对账处置必须填写理由（reason，差异处置留痕）') // 类型窄化（域断言已拒，不可达）

  const updated = await tools.cost.reconItems.updateDisposition(
    itemId,
    {
      dispositionStatus: targetStatus as 'open' | 'confirmed' | 'adjusted',
      disposedBy: ctx.actorLoginName,
      disposedAt: tools.now().toISOString(),
      dispositionReason: reason,
    },
    ctx.actorLoginName,
  )
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'cost.recon.resolve',
    subjectType: 'cost_recon_item',
    subjectId: itemId,
    before: { dispositionStatus: item.dispositionStatus, diffQuantity: item.diffQuantity },
    after: { dispositionStatus: targetStatus },
    reason,
  })
  return { itemId, dispositionStatus: updated?.dispositionStatus ?? targetStatus, diffQuantity: item.diffQuantity }
}

// ---------------- 命令：工时核对（CA-12·PROPOSED 主从口径） ----------------

async function laborCheckRun(tools: CostCommandTools, ctx: { enterpriseId: string; actorLoginName: string }, p: Payload, commandReceiptId: string): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'cost.labor-check.run')
  await assertPlantScope(tools, plantId)
  const orderId = requireStr(p, 'orderId', 'cost.labor-check.run')
  const shiftDate = requireStr(p, 'shiftDate', 'cost.labor-check.run')
  const order = await tools.cost.facts.findProductionOrder(orderId)
  if (order === null) throw new CostRuleViolation(COST_NOT_FOUND_RULE, '生产订单不存在')
  if (order.plantId !== plantId) throw new CostRuleViolation('A-S1', '生产订单不在目标工厂')
  const thresholdRatio = str(p, 'thresholdRatio') ?? DEFAULT_LABOR_CHECK_THRESHOLD
  if (!isValidCostDecimal(thresholdRatio)) throw new CostRuleViolation('CA-12', 'thresholdRatio 必须为十进制字符串')

  // O-3 修复：核对窗口与归集同款按工厂班次日历对齐（原 `${shiftDate}T23:59:59Z` UTC 锚跨北京零点
  // 使 labor.shift_date 与 shiftDate 相差一日、工时行被过滤——R3 实测错位）
  const { from: shiftFrom, to: shiftTo } = shiftDayWindow(shiftDate)
  const laborFacts = await tools.cost.facts.listLaborByOrder(orderId, shiftTo)
  const byOperation = new Map<string, { operationId: string | null; hours: number }>()
  for (const l of laborFacts) {
    if (l.shiftDate !== shiftDate) continue
    const key = l.orderOperationId ?? ''
    const agg = byOperation.get(key) ?? { operationId: l.orderOperationId, hours: 0 }
    agg.hours += Number(l.hours)
    byOperation.set(key, agg)
  }
  // CA-12 参考源：订单占用设备的 OT 运行小时（订单级窗口；无 OT → 缺侧标注，不冒充）
  const sessionEquips = await tools.cost.facts.listSessionEquipmentCountsByOrder(orderId, shiftTo)
  const otHoursByOperation = new Map<string, { hours: number; present: boolean }>()
  const noOtEquipments: string[] = []
  for (const se of sessionEquips) {
    const eq = await tools.cost.facts.findEquipmentByCode(plantId, se.equipmentCode)
    if (eq === null) continue
    const rt = await tools.cost.facts.otRuntimeHoursByEquipment(eq.id, shiftFrom, shiftTo)
    if (rt === null) {
      noOtEquipments.push(se.equipmentCode)
      continue
    }
    const key = se.orderOperationId ?? ''
    const agg = otHoursByOperation.get(key) ?? { hours: 0, present: false }
    agg.hours += Number(rt.hours)
    agg.present = true
    otHoursByOperation.set(key, agg)
  }

  const created: Array<Record<string, unknown>> = []
  const skipped: Array<Record<string, unknown>> = []
  const belowThreshold: Array<Record<string, unknown>> = []
  for (const [key, agg] of byOperation) {
    const existing = await tools.cost.laborChecks.findByKey(orderId, key, shiftDate)
    if (existing !== null) {
      skipped.push({ checkId: existing.id, status: existing.status })
      continue
    }
    const ot = otHoursByOperation.get(key) ?? { hours: 0, present: false }
    const check = buildLaborCheck({
      laborHours: agg.hours > 0 ? agg.hours.toFixed(2) : null,
      otRuntimeHours: ot.present ? ot.hours.toFixed(2) : null,
      thresholdRatio,
    })
    if (check.status === 'skipped' && check.missingSide === null) {
      // 偏差在阈值内：无核对事项，不落提示行（CA-12 只在超阈值/缺侧时提示）
      belowThreshold.push({ operationKey: key || '(订单级)', deviationRatio: check.deviationRatio })
      continue
    }
    const record = await tools.cost.laborChecks.insert({
      orderId,
      operationKey: key,
      orderOperationId: agg.operationId,
      shiftDate,
      laborHours: agg.hours.toFixed(2),
      otRuntimeHours: check.otRuntimeHours,
      deviationRatio: check.deviationRatio,
      thresholdRatio,
      status: 'open',
      missingSide: check.missingSide,
      reason: check.missingSide !== null
        ? `OT 参考源缺侧（${check.missingSide === 'ot' ? '设备无采集运行时间' : '报工工时缺失'}），缺项标注不冒充（CA-12）`
        : `偏差 ${check.deviationRatio ?? '0'} 超阈值 ${thresholdRatio}（CA-12·PROPOSED：不改写报工工时，仅提示核对）`,
      enterpriseId: ctx.enterpriseId,
      plantId,
      businessTime: tools.now().toISOString(),
      commandReceiptId,
      createdBy: ctx.actorLoginName,
    })
    created.push({ checkId: record.id, operationKey: key || '(订单级)', status: record.status, deviationRatio: record.deviationRatio, missingSide: record.missingSide })
  }
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'cost.labor-check.run',
    subjectType: 'production_order',
    subjectId: orderId,
    after: { shiftDate, created: created.length, skipped: skipped.length, belowThreshold: belowThreshold.length, noOtEquipments },
    reason: str(p, 'reason') ?? null,
  })
  return {
    orderId,
    shiftDate,
    thresholdRatio,
    created,
    skipped,
    belowThreshold,
    noOtEquipments,
    note: 'CA-12·PROPOSED：报工 labor_record 为主源，OT 运行时间仅参考；偏差提示不改写报工',
  }
}

async function laborCheckAcknowledge(tools: CostCommandTools, ctx: { enterpriseId: string; actorLoginName: string }, p: Payload): Promise<Record<string, unknown>> {
  const plantId = requireStr(p, 'plantId', 'cost.labor-check.acknowledge')
  await assertPlantScope(tools, plantId)
  const checkId = requireStr(p, 'checkId', 'cost.labor-check.acknowledge')
  const reason = requireStr(p, 'reason', 'cost.labor-check.acknowledge')
  const check = await tools.cost.laborChecks.findById(checkId)
  if (check === null) throw new CostRuleViolation(COST_NOT_FOUND_RULE, '工时核对提示不存在')
  if (check.plantId !== plantId) throw new CostRuleViolation('A-S1', '工时核对提示不在目标工厂')
  if (check.status !== 'open') throw new CostRuleViolation('CA-12', '提示已确认，不可重复确认')

  const updated = await tools.cost.laborChecks.updateAcknowledged(
    checkId,
    { acknowledgedBy: ctx.actorLoginName, acknowledgedAt: tools.now().toISOString(), reason },
    ctx.actorLoginName,
  )
  await tools.audit.record({
    actor: ctx.actorLoginName,
    action: 'cost.labor-check.acknowledge',
    subjectType: 'cost_labor_check',
    subjectId: checkId,
    before: { status: 'open' },
    after: { status: 'acknowledged' },
    reason,
  })
  return { checkId, status: updated?.status ?? 'acknowledged' }
}

// ---------------- 处理器装配 ----------------

/**
 * 命令处理器清单（组合根装配进 PgCommandBus）。
 * 幂等/回执由 PgCommandBus 承担（同 opId 重放返回原结果）；规则违例以
 * [CE-xx]/[CE-Sx]/[A-S1]/[CA-12]/[CA-13] 前缀返回（BUSINESS_REJECTION）。
 */
export function createCostCommandHandlers(): CommandHandler[] {
  const make = (
    commandType: string,
    fn: (tools: CostCommandTools, ctx: { enterpriseId: string; actorLoginName: string }, p: Payload, operationId: string, commandReceiptId: string) => Promise<Record<string, unknown>>,
  ): CommandHandler => ({
    commandType,
    handle: (envelope, context, baseTools): Promise<HandlerOutcome> =>
      run(async () => {
        const tools = baseTools as CostCommandTools
        const payload = (envelope.payload ?? {}) as Payload
        const commandReceiptId = await requireReceipt(tools, context.enterpriseId, commandType, envelope.operationId)
        const ctx = { enterpriseId: context.enterpriseId, actorLoginName: context.actorLoginName }
        return fn(tools, ctx, payload, envelope.operationId, commandReceiptId)
      }),
  })

  return [
    make('cost.meter.register', (tools, ctx, p, _op, receipt) => meterRegister(tools, ctx, p, receipt)),
    make('cost.meter.reading.record', (tools, ctx, p, _op, receipt) => meterReadingRecord(tools, ctx, p, receipt)),
    make('cost.allocation-version.create', (tools, ctx, p, _op, receipt) => allocationVersionCreate(tools, ctx, p, receipt)),
    make('cost.price-version.create', (tools, ctx, p, _op, receipt) => priceVersionCreate(tools, ctx, p, receipt)),
    make('cost.acquisition.run', acquisitionRun),
    make('cost.acquisition.recalc', (tools, ctx, p, _op, receipt) => acquisitionRecalc(tools, ctx, p, receipt)),
    make('cost.recon.erp-import', (tools, ctx, p, _op, receipt) => reconErpImport(tools, ctx, p, receipt)),
    make('cost.recon.resolve', reconResolve),
    make('cost.labor-check.run', (tools, ctx, p, _op, receipt) => laborCheckRun(tools, ctx, p, receipt)),
    make('cost.labor-check.acknowledge', laborCheckAcknowledge),
  ]
}
