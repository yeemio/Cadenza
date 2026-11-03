import { ERROR_CODES, type DecimalString } from '@cadenza/contracts'
import { InventoryRuleViolation, addQty, cmpQty, subQty } from '@cadenza/domain'
import {
  DispositionRuleViolation,
  allocateDeduction,
  assertConcession,
  checkDefectScan,
  assertDefectScanAllowed,
  assertDefectSubmittable,
  assertDeductionDestination,
  assertDefectReviewable,
  assertDispositionDecision,
  assertJudgementCondition,
  assertJudgementWritable,
  assertDispositionNotDownstreamConsumed,
  assertPdaConclusion,
  assertPdaSubmitAllowed,
  assertReInspectionInitiable,
  assertReworkTaskLink,
  assertScrapQty,
  assertSuspectMarkAllowed,
  assertSuspectRecovery,
  assertUnitNotSuspectForConsumption,
  assertWebWriteBatchState,
  assertWebWriteConclusion,
  assertWebWriteTargetPending,
  checkSuspectScan,
  joinMaterialKey,
  judgementUnifiedConclusion,
  summarizeBatchInspectionStatus,
  type BatchInspectionStatus,
} from '@cadenza/domain'
import type { CommandHandler, HandlerOutcome } from './command-bus'
import { buildPostingContext, NOT_FOUND_RULE, str, type PostingContext } from './inventory-posting'
import { violationOutcome } from './inventory-handlers'
import type { DispositionCommandTools, ReceiptDetailQcView } from './disposition-repositories'

/**
 * disposition 域命令处理器（T18 质量处置：QD-01～QD-25；全部在命令总线事务内运行，命令事务即 UoW）。
 *
 * 命令面（12）：
 * - disposition.suspect.mark：存疑标记（QD-01/02：扫码前置重校验＋存疑记录 append-only＋库存投影 suspect）；
 * - disposition.suspect.release：存疑恢复=处置记录（QD-03：一键入口落库为处置记录，不覆盖原存疑记录；
 *   高影响场景强制处置依据）；
 * - disposition.defect.submit：成品异常提交（QD-05/06：PDA 前置＋提交校验；记录未审核）；
 * - disposition.defect.review：成品异常审核（QD-07/08/09：通过=足减依次扣＋去向必填；不通过=只清异常
 *   状态不扣数量；扣数在事务内基于实时余额行锁）；
 * - disposition.qc.write-web：Web 质检写入（QD-11：批次状态门槛＋仅待质检码＋已有结论不改＋重汇总）；
 * - disposition.qc.submit-pda：PDA 结论版本化（QD-12：0006 inspection_record 追加历史＋生效指针切换；
 *   免检码拒；首检已有复检须操作复检记录；附件≤3；码质检结果同步）；
 * - disposition.qc.judge：批次判定（QD-13/CA-4：条件门槛＋整批统一＋0006 batch_judgement 版本链＋
 *   备注必填；免检可判不合格=追加检验记录切换，不删免检事实）；
 * - disposition.qc.re-inspect：复检发起（QD-14：同码同批次至多一次＋不合格前提＋无记录码补首检；
 *   整单原子）；
 * - disposition.disposition.rework：返工处置（QD-21：返工任务关联原工序/订单/码，不在库存账凭空生成数量）；
 * - disposition.disposition.scrap：报废处置（QD-22：可用量足额扣减＋adjust 流水＋去向记录；
 *   报废数量不可再进入可用量与发运）；
 * - disposition.disposition.concession：让步放行（QD-23：保留原不合格事实＋审批人＋让步范围）；
 * - disposition.disposition.release：放行（QD-19/20：高影响强制理由＋关联检验/异常记录，事实不覆盖）。
 *
 * 证书/客诉/召回：GAP-F16 裁定前不建命令（QD-24/25/QD-S5）——待裁项登记交付记录。
 * QD-16：批次已下游使用（投料/发运/转换）时，切有效结论类动作拦截并转隔离/追溯处置。
 * 采购质检存储消费 0006 既有表（inspection_record 首检/复检双链、batch_judgement 版本链、
 * receipt_detail 码质量投影、purchase_receipt_batch.inspection_status 批次状态投影）。
 * 幂等/回执由 PgCommandBus 承担；违例以 [QD-x] 前缀文案返回（BUSINESS_REJECTION）；全部命令审计留痕。
 */

type Payload = Record<string, unknown>

function qdViolationOutcome(error: DispositionRuleViolation): HandlerOutcome {
  let errorCode: string = ERROR_CODES.BUSINESS_RULE
  if (error.rule === 'IT-S1') errorCode = ERROR_CODES.FORBIDDEN_SCOPE
  else if (error.rule === NOT_FOUND_RULE) errorCode = ERROR_CODES.NOT_FOUND
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<Record<string, unknown>>): Promise<HandlerOutcome> {
  try {
    const data = await body()
    return { status: 'COMMITTED', data }
  } catch (error) {
    if (error instanceof DispositionRuleViolation) return qdViolationOutcome(error)
    if (error instanceof InventoryRuleViolation) return violationOutcome(error)
    throw error
  }
}

function requireStr(p: Payload, key: string, command: string): string {
  const v = str(p, key)
  if (v === undefined) throw new DispositionRuleViolation('QD-20', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

/** 组织范围二道防线（OA-24/26 口径随行；IT-S1 编号触发 403 映射）。 */
async function assertPlantScope(tools: DispositionCommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new InventoryRuleViolation('IT-S1', `目标工厂不在授权数据范围内（plant=${plantId}）`)
  }
}

function qdTools(pc: PostingContext): DispositionCommandTools {
  return pc.tools as unknown as DispositionCommandTools
}

/** 处置域单号（域前缀 + 时间基 + 随机尾；唯一性由库级 UNIQUE 兜底，冲突即事务拒绝）。 */
function nextNo(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString(36)}`
}

// ---------------- 检验记录版本链追加（0006 inspection_record；QD-S2/S14 追加历史＋生效指针切换） ----------------

type DetailConclusion = 'exempt' | 'pending' | 'qualified' | 'unqualified'

/** 码库存质量投影映射（exempt=免于检验直接可用；stock_balance 枚举无 exempt）。 */
const STOCK_QUALITY_BY_CONCLUSION: Record<DetailConclusion, 'qualified' | 'pending_inspection' | 'unqualified'> = {
  exempt: 'qualified',
  pending: 'pending_inspection',
  qualified: 'qualified',
  unqualified: 'unqualified',
}

/** 0006 receipt_detail.quality_status 投影映射（该枚举含 exempt/re_inspection）。 */
const DETAIL_STATUS_BY_CONCLUSION: Record<DetailConclusion, string> = {
  exempt: 'exempt',
  pending: 'pending_inspection',
  qualified: 'qualified',
  unqualified: 'unqualified',
}

async function appendInspectionRecord(
  tools: DispositionCommandTools,
  input: {
    batchId: string
    detail: ReceiptDetailQcView
    inspectionType: 'first' | 're'
    conclusion: DetailConclusion
    source: 'receive' | 'pda' | 'web' | 'judge' | 'reinspection_start'
    inspector: string | null
    commandReceiptId: string
    businessTime: string
    attachments?: unknown
  },
): Promise<{ version: number }> {
  const chain = tools.qd.inspectionChain
  const current = await chain.findEffectiveForDetail(input.detail.detailId)
  const chainRow = current !== null && current.inspectionType === input.inspectionType ? current : null
  const version = (await chain.maxVersion(input.detail.detailId, input.inspectionType)) + 1
  if (chainRow !== null) await chain.markIneffective(chainRow.id, input.inspector) // 旧生效行翻指针（事实列锁定）
  await chain.insert({
    batchId: input.batchId,
    detailId: input.detail.detailId,
    barcodeValue: input.detail.barcodeValue,
    inspectionType: input.inspectionType,
    version,
    conclusion: input.conclusion,
    source: input.source,
    inspector: input.inspector,
    inspectedAt: input.businessTime,
    attachments: input.attachments ?? [],
    commandReceiptId: input.commandReceiptId,
    createdBy: input.inspector,
  })
  // QD-12：码质检结果同步（receipt_detail 投影 + 库存余额质量投影——IT-18 库存域唯一维护方）
  await chain.updateDetailQualityStatus(input.detail.detailId, DETAIL_STATUS_BY_CONCLUSION[input.conclusion], input.inspector)
  if (input.detail.unitId !== null) {
    const balances = await tools.inv.balances.listActiveByUnit(input.detail.unitId)
    for (const b of balances) {
      const target = STOCK_QUALITY_BY_CONCLUSION[input.conclusion]
      if (b.qualityStatus !== target) await tools.inv.balances.adjust(b.id, { qualityStatus: target }, input.inspector)
    }
  }
  return { version }
}

/** QD-15：批次质检状态投影重算写回（按各码当前生效结论汇总；可重算）。 */
async function recomputeBatchInspectionStatus(
  tools: DispositionCommandTools,
  batchId: string,
  actor: string | null,
): Promise<BatchInspectionStatus> {
  const effective = await tools.qd.inspectionChain.listEffectiveByBatch(batchId)
  const status = summarizeBatchInspectionStatus(effective.map((r) => r.conclusion))
  await tools.qd.batchQc.updateInspectionStatus(batchId, status, actor)
  return status
}

/** QD-16：批次下游使用拦截（切有效结论类动作统一前置）。 */
async function assertBatchNotDownstreamUsed(tools: DispositionCommandTools, batchId: string, batchNo: string): Promise<void> {
  const consumed = await tools.qd.trace.downstreamConsumedByBatch(batchId)
  assertDispositionNotDownstreamConsumed({ batchNo, downstreamConsumed: consumed })
}

/** 单码全部活动余额质量投影刷新（IT-18 口径）。 */
async function syncUnitQuality(
  tools: DispositionCommandTools,
  unitId: string,
  target: 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect',
  actor: string | null,
): Promise<number> {
  const balances = await tools.inv.balances.listActiveByUnit(unitId)
  let touched = 0
  for (const b of balances) {
    if (b.qualityStatus !== target) {
      await tools.inv.balances.adjust(b.id, { qualityStatus: target }, actor)
      touched += 1
    }
  }
  return touched
}

/** 从码的活动余额依次扣减（QD-09：事务内实时余额＋行锁＋足减依次扣＋adjust 流水；不部分扣）。 */
async function deductFromBalances(
  pc: PostingContext,
  tools: DispositionCommandTools,
  input: {
    unitId: string
    unitNo: string
    totalQty: string
    refType: string
    refId: string
    reason: string | null
  },
): Promise<{ transactionIds: string[]; lines: Array<{ balanceId: string; beforeQty: string; afterQty: string }> }> {
  const inv = tools.inv
  const actor = pc.ctx.actorLoginName
  const balances = (await inv.balances.listActiveByUnit(input.unitId))
    .filter((b) => b.quantity !== '0.0000')
    .sort((a, b) => a.id.localeCompare(b.id)) // QD-09：稳定次序行锁
  const locked = []
  for (const b of balances) {
    const row = await inv.balances.lockByKey(b.unitId, b.locationId, b.ownerId)
    if (row !== null && row.status === 'active') locked.push(row)
  }
  const alloc = allocateDeduction(
    locked.map((b) => ({ balanceId: b.id, availableQty: b.quantity })),
    input.totalQty,
  )
  const transactionIds: string[] = []
  const lines: Array<{ balanceId: string; beforeQty: string; afterQty: string }> = []
  let lineNo = 0
  for (const a of alloc) {
    lineNo += 1
    const balance = locked.find((b) => b.id === a.balanceId)!
    const afterQty = subQty(balance.quantity, a.deductQty)
    if (cmpQty(afterQty, '0.0000') < 0) {
      throw new DispositionRuleViolation('QD-09', `并发扣减导致负余额（扣前 ${balance.quantity}、本次 ${a.deductQty}），拒绝`)
    }
    const inserted = await inv.transactions.insertLine({
      commandReceiptId: pc.commandReceiptId,
      lineNo,
      movementKind: 'adjust',
      unitId: input.unitId,
      lotId: null,
      balanceId: balance.id,
      fromLocationId: balance.locationId,
      fromLocationCode: balance.locationCode,
      toLocationId: null,
      toLocationCode: null,
      fromOwnerId: balance.ownerId,
      fromOwnerName: balance.ownerName,
      toOwnerId: null,
      toOwnerName: null,
      quantity: subQty(a.deductQty, '0.0000'),
      uomId: balance.uomId,
      uomCode: balance.uomCode,
      measurementBasis: balance.measurementBasis,
      conversionRevisionId: null,
      beforeQty: balance.quantity,
      afterQty,
      refType: input.refType,
      refId: input.refId,
      reason: input.reason,
      businessTime: pc.businessTime,
      shiftDate: pc.shiftDate,
      plantId: balance.plantId,
      enterpriseId: balance.enterpriseId,
      createdBy: actor,
    })
    await inv.transactions.insertEntry({
      transactionId: inserted.id,
      entryNo: 1,
      balanceId: balance.id,
      unitId: input.unitId,
      locationId: balance.locationId,
      locationCode: balance.locationCode,
      ownerId: balance.ownerId,
      ownerName: balance.ownerName,
      lotId: null,
      quantityDelta: subQty('0.0000', a.deductQty),
      beforeQty: balance.quantity,
      afterQty,
      purpose: 'adjust',
      plantId: balance.plantId,
      enterpriseId: balance.enterpriseId,
      createdBy: actor,
    })
    const closes = cmpQty(afterQty, '0.0000') === 0
    await inv.balances.adjust(
      balance.id,
      closes ? { quantity: afterQty, status: 'closed', closedAt: pc.businessTime } : { quantity: afterQty, status: 'active', closedAt: null },
      actor,
    )
    transactionIds.push(inserted.id)
    lines.push({ balanceId: balance.id, beforeQty: balance.quantity, afterQty })
  }
  return { transactionIds, lines }
}

/** 批次内按轴号定位码明细（QD-11/12/14：items 以 unitNo 寻址）。 */
async function findDetailByUnitNo(
  tools: DispositionCommandTools,
  batchId: string,
  unitNo: string,
): Promise<ReceiptDetailQcView | null> {
  const details = await tools.qd.batchQc.listDetails(batchId)
  return details.find((d) => d.unitNo === unitNo) ?? null
}

// ---------------- 命令：存疑标记（QD-01/02） ----------------

async function suspectMark(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qdTools(pc)
  const plantId = requireStr(p, 'plantId', 'disposition.suspect.mark')
  const unitNo = requireStr(p, 'unitNo', 'disposition.suspect.mark')
  await assertPlantScope(tools, plantId)

  // QD-01：扫码只查询不改数据；确认时按扫码规则重校验（事实装载 → 纯判定）
  const unit = await tools.inv.units.findByUnitNo(plantId, unitNo)
  const balances = unit === null ? [] : await tools.inv.balances.listActiveByUnit(unit.id)
  const barcodeKind = str(p, 'barcodeKind') ?? 'unit'
  const alreadySuspect = balances.some((b) => b.qualityStatus === 'suspect')
  const scan = checkSuspectScan({
    hasLinkedMaterial: unit !== null && unit.materialId !== '',
    isPalletCode: barcodeKind === 'pallet',
    isReceived: unit !== null,
    hasLocation: balances.length > 0,
    alreadySuspect,
  })
  assertSuspectMarkAllowed(scan, unitNo)

  // QD-02：存疑记录（料品去重拼接＋生产部门＋发起人/时间=确认人/时间）
  const inserted = await tools.qd.suspectRecords.insert({
    unitId: unit!.id,
    unitNo,
    materialKeyJoined: joinMaterialKey([
      { code: unit!.materialCode, name: unit!.materialCode, spec: null, color: null },
    ]),
    productionDeptId: str(p, 'productionDeptId') ?? null,
    productionDeptName: str(p, 'productionDeptName') ?? null,
    raisedBy: pc.ctx.actorLoginName,
    raisedAt: pc.businessTime,
    previousQualityStatus:
      balances[0]?.qualityStatus === 'qualified' || balances[0]?.qualityStatus === 'pending_inspection' || balances[0]?.qualityStatus === 'unqualified'
        ? balances[0].qualityStatus
        : null,
    commandReceiptId: pc.commandReceiptId,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  const touched = await syncUnitQuality(tools, unit!.id, 'suspect', pc.ctx.actorLoginName)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'disposition.suspect.mark',
    subjectType: 'qd_suspect_record',
    subjectId: inserted.id,
    before: { qualityStatus: balances[0]?.qualityStatus ?? null },
    after: { qualityStatus: 'suspect', balancesTouched: touched },
    reason: str(p, 'reason') ?? null,
  })
  return { suspectRecordId: inserted.id, unitNo, qualityStatus: 'suspect', balancesTouched: touched }
}

// ---------------- 命令：存疑恢复（QD-03） ----------------

async function suspectRelease(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qdTools(pc)
  const plantId = requireStr(p, 'plantId', 'disposition.suspect.release')
  const unitNo = requireStr(p, 'unitNo', 'disposition.suspect.release')
  await assertPlantScope(tools, plantId)

  const unit = await tools.inv.units.findByUnitNo(plantId, unitNo)
  if (unit === null) throw new DispositionRuleViolation(NOT_FOUND_RULE, `库存单元不存在（${unitNo}）`)
  const chain = await tools.qd.suspectRecords.listByUnit(unit.id)
  const balances = await tools.inv.balances.listActiveByUnit(unit.id)
  const activeSuspect = balances.some((b) => b.qualityStatus === 'suspect')
  // QD-03：恢复落库为处置记录（关联原存疑记录），不覆盖原存疑记录
  const latest = chain.length > 0 ? chain[chain.length - 1]! : null
  if (latest === null || !activeSuspect) {
    throw new DispositionRuleViolation('QD-03', `码 ${unitNo} 当前无活动存疑记录，不可恢复`)
  }
  const reservations = await tools.inv.reservations.listActiveByUnit(unit.id)
  const nowIso = pc.tools.now().toISOString()
  const effectiveReservations = reservations.filter((r) => r.validUntil === null || r.validUntil >= nowIso)
  const decision = assertSuspectRecovery({
    suspectRecordId: latest.id,
    operator: pc.ctx.actorLoginName,
    occurredAt: new Date(pc.businessTime),
    basis: str(p, 'basis') ?? str(p, 'reason') ?? null,
    highImpact: effectiveReservations.length > 0, // 高影响场景：码已进入备货/待发运（存在有效活动预留）
  })
  const previous = latest.previousQualityStatus
  const restoreTo = previous ?? 'pending_inspection'
  const fact = await tools.qd.dispositions.insert({
    dispositionNo: nextNo('QD-DISP'),
    dispositionKind: 'hold_release',
    targetType: 'qd_suspect_record',
    targetId: decision.suspectRecordId,
    decidedBy: decision.operator,
    decidedAt: decision.occurredAt.toISOString(),
    basis: decision.basis,
    reason: decision.basis,
    destinationKind: null,
    destinationNote: '存疑恢复正常（处置记录，不覆盖原存疑记录）',
    commandReceiptId: pc.commandReceiptId,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  const touched = await syncUnitQuality(tools, unit.id, restoreTo, pc.ctx.actorLoginName)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'disposition.suspect.release',
    subjectType: 'qd_disposition_record',
    subjectId: fact.id,
    before: { qualityStatus: 'suspect', suspectRecordId: latest.id },
    after: { qualityStatus: restoreTo, highImpact: effectiveReservations.length > 0, balancesTouched: touched },
    reason: decision.basis,
  })
  return {
    dispositionId: fact.id,
    dispositionNo: fact.dispositionNo,
    suspectRecordId: decision.suspectRecordId,
    restoredQualityStatus: restoreTo,
    originalRecordPreserved: true,
  }
}

// ---------------- 命令：成品异常提交（QD-05/06） ----------------

async function defectSubmit(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qdTools(pc)
  const plantId = requireStr(p, 'plantId', 'disposition.defect.submit')
  const unitNoRaw = str(p, 'unitNo') ?? null
  await assertPlantScope(tools, plantId)

  const unit = unitNoRaw === null ? null : await tools.inv.units.findByUnitNo(plantId, unitNoRaw)
  const balances = unit === null ? [] : await tools.inv.balances.listActiveByUnit(unit.id)
  const barcodeKind = str(p, 'barcodeKind') ?? 'unit'
  // QD-05：PDA 前置（已入库且非线边仓拒绝；仓库不存在拒绝；扫码只查询）
  const warehouseKinds =
    unit !== null ? await tools.qd.batchQc.findWarehouseKindsByUnitNo(plantId, unitNoRaw!) : []
  const scan = checkDefectScan({
    isPalletCode: barcodeKind === 'pallet',
    isReceived: unit !== null && balances.length > 0,
    inLineSideWarehouse: warehouseKinds.some((k) => k === 'LINE_SIDE'),
    warehouseExists: unit === null || warehouseKinds.length > 0,
  })
  assertDefectScanAllowed(scan, unitNoRaw ?? '')

  const materialId = str(p, 'materialId') ?? null
  const defectTypeRaw = str(p, 'defectType') ?? null
  const defectType = defectTypeRaw === 'rework' || defectTypeRaw === 'scrap' ? defectTypeRaw : null
  const openDefect = unit !== null && materialId !== null
    ? await tools.qd.defects.findOpenByUnitMaterial(unit.id, materialId)
    : null
  // 该码该料品账面总量（QD-06：数量大于该料品总数拒绝）
  const totalQty = balances.reduce((acc, b) => addQty(acc, b.quantity), '0.0000' as DecimalString)
  assertDefectSubmittable({
    unitNo: unitNoRaw,
    materialId,
    materialInScanResult: unit !== null && materialId !== null && unit.materialId === materialId,
    hasOpenDefect: openDefect !== null,
    defectType,
    defectQty: str(p, 'defectQty') ?? null,
    materialTotalQty: totalQty,
  })
  const defect = await tools.qd.defects.insert({
    defectNo: nextNo('QD-FGD'),
    unitId: unit!.id,
    unitNo: unitNoRaw!,
    materialId: materialId!,
    materialCode: unit!.materialCode,
    defectType: defectType!,
    defectQty: str(p, 'defectQty')!,
    uomCode: balances[0]?.uomCode ?? unit!.uomCode,
    submittedBy: pc.ctx.actorLoginName,
    submittedAt: pc.businessTime,
    productionDeptId: str(p, 'productionDeptId') ?? null,
    productionDeptName: str(p, 'productionDeptName') ?? null,
    commandReceiptId: pc.commandReceiptId,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'disposition.defect.submit',
    subjectType: 'finished_goods_defect',
    subjectId: defect.id,
    after: { defectNo: defect.defectNo, reviewStatus: 'unreviewed', defectType: defect.defectType, defectQty: defect.defectQty },
    reason: str(p, 'reason') ?? null,
  })
  return { defectId: defect.id, defectNo: defect.defectNo, reviewStatus: 'unreviewed', unitDefectState: 'defect_open' }
}

// ---------------- 命令：成品异常审核（QD-07/08/09） ----------------

async function defectReview(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qdTools(pc)
  const defectNo = requireStr(p, 'defectNo', 'disposition.defect.review')
  const defect = await tools.qd.defects.findByNo(defectNo)
  if (defect === null) throw new DispositionRuleViolation(NOT_FOUND_RULE, `成品异常记录不存在（${defectNo}）`)
  await assertPlantScope(tools, defect.plantId)

  // QD-07：可执行 = 记录存在且审核状态=未审核；审核结果必传
  assertDefectReviewable(defect.reviewStatus, defectNo)
  const resultRaw = str(p, 'result')
  const result = resultRaw === 'approved' || resultRaw === 'rejected' ? resultRaw : null
  if (result === null) {
    throw new DispositionRuleViolation('QD-07', '审核结果必传（通过/不通过）')
  }

  if (result === 'approved') {
    // QD-08：审核通过扣数必须记录调整原因与去向（禁止无去向扣数）
    const destRaw = str(p, 'destinationKind')
    const destinationKind = destRaw === 'scrap' || destRaw === 'rework' || destRaw === 'other' ? destRaw : null
    const destination = assertDeductionDestination(destinationKind, str(p, 'destinationNote') ?? null, str(p, 'adjustReason') ?? null)
    // QD-04 防线：扣减前质量状态检查（存疑码不可扣减消费）
    const balances = await tools.inv.balances.listActiveByUnit(defect.unitId)
    for (const b of balances) assertUnitNotSuspectForConsumption(b.qualityStatus, defect.unitNo)
    // QD-09：事务内基于实时余额（行锁）足减依次扣
    await tools.inv.units.lockForUpdate([defect.unitId])
    const deduction = await deductFromBalances(pc, tools, {
      unitId: defect.unitId,
      unitNo: defect.unitNo,
      totalQty: defect.defectQty,
      refType: 'finished_goods_defect',
      refId: defect.id,
      reason: destination.reason,
    })
    await tools.qd.defects.applyReview(
      defect.id,
      {
        reviewStatus: 'approved',
        reviewedBy: pc.ctx.actorLoginName,
        reviewedAt: pc.businessTime,
        destinationKind: destination.destinationKind,
        destinationNote: destination.destinationNote,
        adjustReason: destination.reason,
        deductionTransactionIds: deduction.transactionIds,
      },
      pc.ctx.actorLoginName,
    )
    await pc.tools.audit.record({
      actor: pc.ctx.actorLoginName,
      action: 'disposition.defect.review',
      subjectType: 'finished_goods_defect',
      subjectId: defect.id,
      before: { reviewStatus: defect.reviewStatus, defectQty: defect.defectQty },
      after: {
        reviewStatus: 'approved',
        destinationKind: destination.destinationKind,
        destinationNote: destination.destinationNote,
        lines: deduction.lines,
      },
      reason: destination.reason,
    })
    return {
      defectNo,
      reviewStatus: 'approved',
      destination: destination.destinationKind,
      deductionLines: deduction.lines,
      transactionIds: deduction.transactionIds,
      unitDefectState: 'normal',
    }
  }

  // QD-07：不通过 → 只清异常状态（不扣数量）
  await tools.qd.defects.applyReview(
    defect.id,
    { reviewStatus: 'rejected', reviewedBy: pc.ctx.actorLoginName, reviewedAt: pc.businessTime },
    pc.ctx.actorLoginName,
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'disposition.defect.review',
    subjectType: 'finished_goods_defect',
    subjectId: defect.id,
    before: { reviewStatus: defect.reviewStatus },
    after: { reviewStatus: 'rejected', quantityDeducted: '0.0000' },
    reason: str(p, 'reason') ?? null,
  })
  return { defectNo, reviewStatus: 'rejected', quantityDeducted: '0.0000', unitDefectState: 'normal' }
}

// ---------------- 命令：Web 质检写入（QD-11） ----------------

async function qcWriteWeb(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qdTools(pc)
  const batchNo = requireStr(p, 'batchNo', 'disposition.qc.write-web')
  const batch = await tools.qd.batchQc.findByNo(batchNo)
  if (batch === null) throw new DispositionRuleViolation(NOT_FOUND_RULE, `采购收货批次不存在（${batchNo}）`)
  await assertPlantScope(tools, batch.plantId)

  assertWebWriteBatchState(batch.storageStatus, batch.inspectionStatus)
  await assertBatchNotDownstreamUsed(tools, batch.id, batch.batchNo) // QD-16：切有效结论类动作统一拦截

  const items = p['items']
  if (!Array.isArray(items) || items.length === 0) {
    throw new DispositionRuleViolation('QD-11', 'Web 质检写入必须携带 items（码结论数组）')
  }
  const written: Array<{ unitNo: string; version: number; conclusion: string }> = []
  for (const item of items) {
    const row = item as Record<string, unknown>
    const unitNo = typeof row['unitNo'] === 'string' ? row['unitNo'] : ''
    if (unitNo === '') throw new DispositionRuleViolation('QD-11', 'items[].unitNo 必填')
    const conclusion = assertWebWriteConclusion(typeof row['conclusion'] === 'string' ? row['conclusion'] : '')
    const detail = await findDetailByUnitNo(tools, batch.id, unitNo)
    if (detail === null) throw new DispositionRuleViolation('QD-11', `码 ${unitNo} 不在批次 ${batchNo} 内`)
    const effective = await tools.qd.inspectionChain.findEffectiveForDetail(detail.detailId)
    // QD-11：仅对当前生效质检行仍为待质检的码写入；已有结论的码不改（无记录=待质检，补建首检链）
    assertWebWriteTargetPending(effective === null ? null : effective.conclusion, unitNo)
    const chainType = effective !== null && effective.inspectionType === 're' ? 're' : 'first'
    const appended = await appendInspectionRecord(tools, {
      batchId: batch.id,
      detail,
      inspectionType: chainType,
      conclusion,
      source: 'web',
      inspector: pc.ctx.actorLoginName,
      commandReceiptId: pc.commandReceiptId,
      businessTime: pc.businessTime,
    })
    written.push({ unitNo, version: appended.version, conclusion })
  }
  // QD-11：批次状态按码结论重汇总（QD-15 投影重算）
  const batchStatus = await recomputeBatchInspectionStatus(tools, batch.id, pc.ctx.actorLoginName)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'disposition.qc.write-web',
    subjectType: 'purchase_receipt_batch',
    subjectId: batch.id,
    before: { inspectionStatus: batch.inspectionStatus },
    after: { written: written.length, inspectionStatus: batchStatus },
    reason: str(p, 'reason') ?? null,
  })
  return { batchNo, written, batchInspectionStatus: batchStatus }
}

// ---------------- 命令：PDA 结论版本化（QD-12） ----------------

async function qcSubmitPda(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qdTools(pc)
  const batchNo = requireStr(p, 'batchNo', 'disposition.qc.submit-pda')
  const unitNo = requireStr(p, 'unitNo', 'disposition.qc.submit-pda')
  const batch = await tools.qd.batchQc.findByNo(batchNo)
  if (batch === null) throw new DispositionRuleViolation(NOT_FOUND_RULE, `采购收货批次不存在（${batchNo}）`)
  await assertPlantScope(tools, batch.plantId)
  const detail = await findDetailByUnitNo(tools, batch.id, unitNo)
  if (detail === null) throw new DispositionRuleViolation(NOT_FOUND_RULE, `码 ${unitNo} 不在批次 ${batchNo} 内`)
  const attachments = Array.isArray(p['attachments']) ? (p['attachments'] as unknown[]) : []
  const conclusion = assertPdaConclusion(str(p, 'conclusion') ?? '', attachments)

  const effective = await tools.qd.inspectionChain.findEffectiveForDetail(detail.detailId)
  const hasRe = (await tools.qd.inspectionChain.countReInspection(detail.detailId)) > 0
  // QD-12：免检码不可提交；首检已有复检记录则不可再操作首检行（须操作复检记录）；批次未退货
  assertPdaSubmitAllowed({
    storageStatus: batch.storageStatus,
    isExempt: effective?.conclusion === 'exempt' || detail.qualityStatus === 'exempt',
    hasReInspection: hasRe,
    targetKind: hasRe ? 're_inspection' : 'initial',
    unitNo,
  })
  await assertBatchNotDownstreamUsed(tools, batch.id, batch.batchNo) // QD-16

  // 追加历史＋生效指针切换（后一次覆盖前次=新版本行生效；新旧记录均可查）
  const appended = await appendInspectionRecord(tools, {
    batchId: batch.id,
    detail,
    inspectionType: hasRe ? 're' : 'first',
    conclusion,
    source: 'pda',
    inspector: pc.ctx.actorLoginName,
    commandReceiptId: pc.commandReceiptId,
    businessTime: pc.businessTime,
    attachments,
  })
  const batchStatus = await recomputeBatchInspectionStatus(tools, batch.id, pc.ctx.actorLoginName)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'disposition.qc.submit-pda',
    subjectType: 'purchase_receipt_batch',
    subjectId: batch.id,
    before: { effectiveConclusion: effective?.conclusion ?? null, effectiveVersion: effective?.version ?? null },
    after: { conclusion, version: appended.version, inspectionType: hasRe ? 're' : 'first', inspectionStatus: batchStatus, historyPreserved: true },
    reason: str(p, 'reason') ?? null,
  })
  return {
    batchNo,
    unitNo,
    version: appended.version,
    inspectionType: hasRe ? 're' : 'first',
    conclusion,
    batchInspectionStatus: batchStatus,
    historyPreserved: true,
  }
}

// ---------------- 命令：批次判定（QD-13/CA-4） ----------------

async function qcJudge(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qdTools(pc)
  const batchNo = requireStr(p, 'batchNo', 'disposition.qc.judge')
  const batch = await tools.qd.batchQc.findByNo(batchNo)
  if (batch === null) throw new DispositionRuleViolation(NOT_FOUND_RULE, `采购收货批次不存在（${batchNo}）`)
  await assertPlantScope(tools, batch.plantId)

  const judgementRaw = str(p, 'judgement')
  const judgement = judgementRaw === 'qualified' || judgementRaw === 'unqualified' ? judgementRaw : null
  if (judgement === null) throw new DispositionRuleViolation('QD-13', '判定结论必传（合格/不合格）')
  const attachments = Array.isArray(p['attachments']) ? (p['attachments'] as unknown[]) : []
  assertJudgementWritable({ storageStatus: batch.storageStatus, remark: str(p, 'remark') ?? null, attachments })
  assertJudgementCondition(judgement, batch.inspectionStatus)
  await assertBatchNotDownstreamUsed(tools, batch.id, batch.batchNo) // QD-16：整批切换有效结论

  // 判定记录版本链（QD-13：0006 batch_judgement——同批次仅一条生效，新覆盖旧=追加版本行）
  const prevEffective = await tools.qd.judgements.findEffective(batch.id)
  const version = (await tools.qd.judgements.maxVersion(batch.id)) + 1
  if (prevEffective !== null) await tools.qd.judgements.markIneffective(prevEffective.id, pc.ctx.actorLoginName)
  await tools.qd.judgements.insert({
    batchId: batch.id,
    version,
    conclusion: judgement,
    judgeBy: pc.ctx.actorLoginName,
    judgedAt: pc.businessTime,
    note: str(p, 'remark')!,
    attachments,
    isEffective: true,
    commandReceiptId: pc.commandReceiptId,
    createdBy: pc.ctx.actorLoginName,
  })

  // 执行后整批全部码当前生效结论置统一值（QD-13）；免检码=CA-4：追加检验记录切换，免检事实保留可查
  const unified = judgementUnifiedConclusion(judgement)
  const details = await tools.qd.batchQc.listDetails(batch.id)
  const affected: Array<{ unitNo: string; version: number }> = []
  for (const detail of details) {
    const effective = await tools.qd.inspectionChain.findEffectiveForDetail(detail.detailId)
    if (effective === null) {
      // 无检验记录的码：补首检事实行（免检批=exempt 行保留可查；否则 pending）再切换
      await appendInspectionRecord(tools, {
        batchId: batch.id,
        detail,
        inspectionType: 'first',
        conclusion: detail.qualityStatus === 'exempt' ? 'exempt' : 'pending',
        source: 'judge',
        inspector: pc.ctx.actorLoginName,
        commandReceiptId: pc.commandReceiptId,
        businessTime: pc.businessTime,
      })
    }
    const hasRe = (await tools.qd.inspectionChain.countReInspection(detail.detailId)) > 0
    const appended = await appendInspectionRecord(tools, {
      batchId: batch.id,
      detail,
      inspectionType: hasRe ? 're' : 'first',
      conclusion: unified,
      source: 'judge',
      inspector: pc.ctx.actorLoginName,
      commandReceiptId: pc.commandReceiptId,
      businessTime: pc.businessTime,
    })
    affected.push({ unitNo: detail.unitNo ?? detail.barcodeValue, version: appended.version })
  }
  const batchStatus = await recomputeBatchInspectionStatus(tools, batch.id, pc.ctx.actorLoginName)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'disposition.qc.judge',
    subjectType: 'purchase_receipt_batch',
    subjectId: batch.id,
    before: { inspectionStatus: batch.inspectionStatus },
    after: { judgement, judgementVersion: version, unified, codesAffected: affected.length, inspectionStatus: batchStatus },
    reason: str(p, 'remark') ?? null,
  })
  return {
    batchNo,
    judgement,
    judgementVersion: version,
    unified,
    codesAffected: affected.length,
    inspectionStatus: batchStatus,
    exemptFactPreserved: true,
  }
}

// ---------------- 命令：复检发起（QD-14，整单原子） ----------------

async function qcReInspect(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qdTools(pc)
  const batchNo = requireStr(p, 'batchNo', 'disposition.qc.re-inspect')
  const batch = await tools.qd.batchQc.findByNo(batchNo)
  if (batch === null) throw new DispositionRuleViolation(NOT_FOUND_RULE, `采购收货批次不存在（${batchNo}）`)
  await assertPlantScope(tools, batch.plantId)

  const items = p['items']
  if (!Array.isArray(items) || items.length === 0) {
    throw new DispositionRuleViolation('QD-14', '复检发起必须携带 items（码数组；任一条不满足整单失败）')
  }
  // 同"二维码＋批次"重复提交按一条处理（载荷去重）
  const seen = new Set<string>()
  const unitNos: string[] = []
  for (const item of items) {
    const unitNo = typeof (item as Record<string, unknown>)['unitNo'] === 'string' ? (item as Record<string, unknown>)['unitNo'] as string : ''
    if (unitNo === '') throw new DispositionRuleViolation('QD-14', 'items[].unitNo 必填')
    if (seen.has(unitNo)) continue
    seen.add(unitNo)
    unitNos.push(unitNo)
  }
  await assertBatchNotDownstreamUsed(tools, batch.id, batch.batchNo) // QD-16（复检切换有效结论）

  // 全量校验（QD-14：任一条不满足整单失败、不部分提交）。两类合法目标：
  // - 有生效结论且不合格且尚无复检 → 发起复检；
  // - 无任何检验记录 → 补首检（first 待质检），不产生复检行（QD-14"无质检记录的码补首检"）。
  const targets: Array<{ detail: ReceiptDetailQcView; kind: 're_inspect' | 'supplement' }> = []
  for (const unitNo of unitNos) {
    const detail = await findDetailByUnitNo(tools, batch.id, unitNo)
    if (detail === null) throw new DispositionRuleViolation(NOT_FOUND_RULE, `码 ${unitNo} 不在批次 ${batchNo} 内`)
    const effective = await tools.qd.inspectionChain.findEffectiveForDetail(detail.detailId)
    const hasRe = (await tools.qd.inspectionChain.countReInspection(detail.detailId)) > 0
    if (effective === null) {
      targets.push({ detail, kind: 'supplement' })
      continue
    }
    assertReInspectionInitiable({
      storageStatus: batch.storageStatus,
      alreadyHasReInspection: hasRe,
      effectiveConclusion: effective.conclusion,
      unitNo,
    })
    targets.push({ detail, kind: 're_inspect' })
  }
  // 执行：补首检（first pending）或追加复检记录（re 待质检）并切换生效指针
  const created: Array<{ unitNo: string; action: string; version: number }> = []
  for (const t of targets) {
    if (t.kind === 'supplement') {
      const appended = await appendInspectionRecord(tools, {
        batchId: batch.id,
        detail: t.detail,
        inspectionType: 'first',
        conclusion: 'pending',
        source: 'reinspection_start',
        inspector: pc.ctx.actorLoginName,
        commandReceiptId: pc.commandReceiptId,
        businessTime: pc.businessTime,
      })
      created.push({ unitNo: t.detail.unitNo ?? t.detail.barcodeValue, action: 'supplement_first', version: appended.version })
      continue
    }
    const appended = await appendInspectionRecord(tools, {
      batchId: batch.id,
      detail: t.detail,
      inspectionType: 're',
      conclusion: 'pending',
      source: 'reinspection_start',
      inspector: pc.ctx.actorLoginName,
      commandReceiptId: pc.commandReceiptId,
      businessTime: pc.businessTime,
    })
    // 码质检结果改待质检（detail 投影 re_inspection——复检中；库存投影 pending_inspection 不可用）
    await tools.qd.inspectionChain.updateDetailQualityStatus(t.detail.detailId, 're_inspection', pc.ctx.actorLoginName)
    if (t.detail.unitId !== null) await syncUnitQuality(tools, t.detail.unitId, 'pending_inspection', pc.ctx.actorLoginName)
    created.push({ unitNo: t.detail.unitNo ?? t.detail.barcodeValue, action: 're_inspection', version: appended.version })
  }
  const batchStatus = await recomputeBatchInspectionStatus(tools, batch.id, pc.ctx.actorLoginName)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'disposition.qc.re-inspect',
    subjectType: 'purchase_receipt_batch',
    subjectId: batch.id,
    before: { inspectionStatus: batch.inspectionStatus },
    after: { codes: created.length, inspectionStatus: batchStatus },
    reason: str(p, 'reason') ?? null,
  })
  return { batchNo, reInspections: created, inspectionStatus: batchStatus }
}

// ---------------- 命令：返工处置（QD-20/21） ----------------

async function dispositionRework(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qdTools(pc)
  const plantId = requireStr(p, 'plantId', 'disposition.disposition.rework')
  const unitNo = requireStr(p, 'unitNo', 'disposition.disposition.rework')
  await assertPlantScope(tools, plantId)
  const unit = await tools.inv.units.findByUnitNo(plantId, unitNo)
  if (unit === null) throw new DispositionRuleViolation(NOT_FOUND_RULE, `库存单元不存在（${unitNo}）`)

  // QD-21：返工任务关联原工序/订单/码；产出走报工命令与谱系（不在库存账凭空生成数量）
  const link = assertReworkTaskLink({
    originUnitNo: unitNo,
    originProcessOrderNo: str(p, 'originProcessOrderNo') ?? null,
    originOperation: str(p, 'originOperation') ?? null,
  })
  const fact = await tools.qd.dispositions.insert({
    dispositionNo: nextNo('QD-DISP'),
    dispositionKind: 'rework',
    targetType: 'inventory_unit',
    targetId: unit.id,
    decidedBy: pc.ctx.actorLoginName,
    decidedAt: pc.businessTime,
    basis: str(p, 'basis') ?? null,
    destinationKind: 'rework',
    destinationNote: `返工任务关联原工序/订单 ${link.originProcessOrderNo}`,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    commandReceiptId: pc.commandReceiptId,
    createdBy: pc.ctx.actorLoginName,
  })
  const task = await tools.qd.reworkTasks.insert({
    taskNo: nextNo('QD-RW'),
    dispositionId: fact.id,
    originUnitId: unit.id,
    originUnitNo: unit.unitNo,
    originProcessOrderNo: link.originProcessOrderNo,
    originOperation: link.originOperation,
    note: str(p, 'note') ?? null,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    createdBy: pc.ctx.actorLoginName,
  })
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'disposition.disposition.rework',
    subjectType: 'qd_disposition_record',
    subjectId: fact.id,
    after: { dispositionNo: fact.dispositionNo, taskNo: task.taskNo, originProcessOrderNo: link.originProcessOrderNo },
    reason: str(p, 'basis') ?? null,
  })
  return { dispositionId: fact.id, dispositionNo: fact.dispositionNo, reworkTaskNo: task.taskNo, stockQuantityGenerated: '0.0000' }
}

// ---------------- 命令：报废处置（QD-20/22） ----------------

async function dispositionScrap(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qdTools(pc)
  const plantId = requireStr(p, 'plantId', 'disposition.disposition.scrap')
  const unitNo = requireStr(p, 'unitNo', 'disposition.disposition.scrap')
  const scrapQty = str(p, 'scrapQty') ?? null
  await assertPlantScope(tools, plantId)
  const unit = await tools.inv.units.findByUnitNo(plantId, unitNo)
  if (unit === null) throw new DispositionRuleViolation(NOT_FOUND_RULE, `库存单元不存在（${unitNo}）`)

  await tools.inv.units.lockForUpdate([unit.id]) // QD-09 口径：先锁单元（稳定次序）
  const balances = (await tools.inv.balances.listActiveByUnit(unit.id))
    .filter((b) => b.qualityStatus === 'qualified') // 可用量=满足质量条件的余额（IT-14/QD-04）
  const availableQty = balances.reduce((acc, b) => addQty(acc, b.quantity), '0.0000' as DecimalString)
  // QD-20：报废高影响——强制理由；QD-22：可用量足额
  const kind = assertDispositionDecision({
    dispositionKind: 'scrap',
    decidedBy: pc.ctx.actorLoginName,
    decidedAt: new Date(pc.businessTime),
    basis: str(p, 'basis') ?? null,
    targetType: 'inventory_unit',
    targetId: unit.id,
  })
  assertScrapQty({ scrapQty, availableQty, unitNo })
  const destinationNote = str(p, 'destinationNote') ?? null
  if (destinationNote === null || destinationNote.trim() === '') {
    throw new DispositionRuleViolation('QD-22', '报废处置必须记录去向说明（去向记录）')
  }
  // 处置记录先落库（预生成 id——扣减流水 ref 回指处置记录）；随后扣减（数量从可用量移除）
  const factId = crypto.randomUUID()
  const fact = await tools.qd.dispositions.insert({
    id: factId,
    dispositionNo: nextNo('QD-DISP'),
    dispositionKind: kind,
    targetType: 'inventory_unit',
    targetId: unit.id,
    decidedBy: pc.ctx.actorLoginName,
    decidedAt: pc.businessTime,
    basis: str(p, 'basis') ?? null,
    reason: str(p, 'basis') ?? null,
    destinationKind: 'scrap',
    destinationNote,
    quantity: scrapQty!,
    uomCode: balances[0]?.uomCode ?? unit.uomCode,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    commandReceiptId: pc.commandReceiptId,
    createdBy: pc.ctx.actorLoginName,
  })
  const deduction = await deductFromBalances(pc, tools, {
    unitId: unit.id,
    unitNo,
    totalQty: scrapQty!,
    refType: 'qd_disposition_record',
    refId: factId,
    reason: str(p, 'basis') ?? null,
  })
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'disposition.disposition.scrap',
    subjectType: 'qd_disposition_record',
    subjectId: fact.id,
    before: { availableQty },
    after: { scrapQty, lines: deduction.lines, transactionIds: deduction.transactionIds },
    reason: str(p, 'basis') ?? null,
  })
  return {
    dispositionId: fact.id,
    dispositionNo: fact.dispositionNo,
    scrapQty,
    deductionLines: deduction.lines,
    transactionIds: deduction.transactionIds,
    reEnterAvailableDenied: true,
  }
}

// ---------------- 命令：让步放行（QD-20/23） ----------------

async function dispositionConcession(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qdTools(pc)
  const plantId = requireStr(p, 'plantId', 'disposition.disposition.concession')
  const unitNo = requireStr(p, 'unitNo', 'disposition.disposition.concession')
  await assertPlantScope(tools, plantId)
  const unit = await tools.inv.units.findByUnitNo(plantId, unitNo)
  if (unit === null) throw new DispositionRuleViolation(NOT_FOUND_RULE, `库存单元不存在（${unitNo}）`)

  const expiresAtRaw = str(p, 'expiresAt')
  const checked = assertConcession({
    approver: str(p, 'approver') ?? null,
    scope: {
      batchNo: str(p, 'scopeBatchNo') ?? null,
      qty: str(p, 'scopeQty') ?? null,
      expiresAt: expiresAtRaw !== undefined && !Number.isNaN(Date.parse(expiresAtRaw)) ? new Date(expiresAtRaw) : null,
    },
    requestedQty: str(p, 'requestedQty') ?? null,
  })
  // QD-20：处置决定最低字段（concession 非高影响 reason 强制，但依据仍落库）
  const kind = assertDispositionDecision({
    dispositionKind: 'concession',
    decidedBy: pc.ctx.actorLoginName,
    decidedAt: new Date(pc.businessTime),
    basis: str(p, 'basis') ?? '让步放行（审批人附范围）',
    targetType: 'inventory_unit',
    targetId: unit.id,
  })
  const fact = await tools.qd.dispositions.insert({
    dispositionNo: nextNo('QD-DISP'),
    dispositionKind: kind,
    targetType: 'inventory_unit',
    targetId: unit.id,
    decidedBy: pc.ctx.actorLoginName,
    decidedAt: pc.businessTime,
    basis: str(p, 'basis') ?? null,
    destinationKind: null,
    destinationNote: '让步放行：保留原不合格事实（检验链不动）',
    concessionScope: { batchNo: checked.scope.batchNo, qty: checked.scope.qty, expiresAt: checked.scope.expiresAt?.toISOString() ?? null },
    approver: checked.approver,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    commandReceiptId: pc.commandReceiptId,
    createdBy: pc.ctx.actorLoginName,
  })
  // 让步=放行决定：码质量投影→qualified；范围外数量（其它码/无处置）仍按不合格拦截（QD-23）
  const touched = await syncUnitQuality(tools, unit.id, 'qualified', pc.ctx.actorLoginName)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'disposition.disposition.concession',
    subjectType: 'qd_disposition_record',
    subjectId: fact.id,
    before: { qualityStatus: 'unqualified' },
    after: { qualityStatus: 'qualified', approver: checked.approver, scope: checked.scope, balancesTouched: touched },
    reason: str(p, 'basis') ?? null,
  })
  return { dispositionId: fact.id, dispositionNo: fact.dispositionNo, approver: checked.approver, scope: checked.scope, unqualifiedFactPreserved: true }
}

// ---------------- 命令：放行（QD-19/20） ----------------

async function dispositionRelease(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = qdTools(pc)
  const plantId = requireStr(p, 'plantId', 'disposition.disposition.release')
  const unitNo = requireStr(p, 'unitNo', 'disposition.disposition.release')
  await assertPlantScope(tools, plantId)
  const unit = await tools.inv.units.findByUnitNo(plantId, unitNo)
  if (unit === null) throw new DispositionRuleViolation(NOT_FOUND_RULE, `库存单元不存在（${unitNo}）`)

  // QD-20：放行高影响——强制理由＋关联检验或异常记录指针
  const kind = assertDispositionDecision({
    dispositionKind: 'release',
    decidedBy: pc.ctx.actorLoginName,
    decidedAt: new Date(pc.businessTime),
    basis: str(p, 'basis') ?? null,
    targetType: str(p, 'targetType') ?? null,
    targetId: str(p, 'targetId') ?? null,
  })
  const fact = await tools.qd.dispositions.insert({
    dispositionNo: nextNo('QD-DISP'),
    dispositionKind: kind,
    targetType: str(p, 'targetType')!,
    targetId: str(p, 'targetId')!,
    decidedBy: pc.ctx.actorLoginName,
    decidedAt: pc.businessTime,
    basis: str(p, 'basis') ?? null,
    reason: str(p, 'basis') ?? null,
    destinationKind: null,
    destinationNote: '放行决定（"审核通过"≠"质检合格"：事实与判定分开存储 QD-19）',
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    commandReceiptId: pc.commandReceiptId,
    createdBy: pc.ctx.actorLoginName,
  })
  const touched = await syncUnitQuality(tools, unit.id, 'qualified', pc.ctx.actorLoginName)
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'disposition.disposition.release',
    subjectType: 'qd_disposition_record',
    subjectId: fact.id,
    after: { qualityStatus: 'qualified', targetType: str(p, 'targetType'), balancesTouched: touched },
    reason: str(p, 'basis') ?? null,
  })
  return { dispositionId: fact.id, dispositionNo: fact.dispositionNo, releasedTo: 'qualified', factsPreserved: true }
}

// ---------------- 处理器注册 ----------------

function handler(commandType: string, body: (pc: PostingContext, p: Payload) => Promise<Record<string, unknown>>): CommandHandler {
  return {
    commandType,
    async handle(envelope, context, tools) {
      return run(async () => {
        const invTools = tools as unknown as DispositionCommandTools
        const pc = await buildPostingContext(
          invTools as unknown as Parameters<typeof buildPostingContext>[0],
          context,
          commandType,
          envelope.operationId,
          envelope.payload as Payload,
        )
        return body(pc, envelope.payload as Payload)
      })
    },
  }
}

/** 创建 disposition 域命令处理器集（组合根装配用）。 */
export function createDispositionCommandHandlers(): CommandHandler[] {
  return [
    handler('disposition.suspect.mark', suspectMark),
    handler('disposition.suspect.release', suspectRelease),
    handler('disposition.defect.submit', defectSubmit),
    handler('disposition.defect.review', defectReview),
    handler('disposition.qc.write-web', qcWriteWeb),
    handler('disposition.qc.submit-pda', qcSubmitPda),
    handler('disposition.qc.judge', qcJudge),
    handler('disposition.qc.re-inspect', qcReInspect),
    handler('disposition.disposition.rework', dispositionRework),
    handler('disposition.disposition.scrap', dispositionScrap),
    handler('disposition.disposition.concession', dispositionConcession),
    handler('disposition.disposition.release', dispositionRelease),
  ]
}
