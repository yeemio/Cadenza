import { ERROR_CODES } from '@cadenza/contracts'
 
import {
  DEFAULT_RULE_SET_NAME,
  DEFAULT_SPC_CRITERIA,
  SpcRuleViolation,
  assertCalibrationRecordShape,
  assertChangeOrderShape,
  assertChangePublishable,
  assertControlItemShape,
  assertDispositionChoice,
  assertMiscalibrationActionShape,
  assertNamedAdjustment,
  assertOocDisposable,
  assertOperationMutationShape,
  assertOperationMutationsAllowed,
  assertRecontrolConfirmable,
  assertRuleSetPublishable,
  assertRuleSetShape,
  assertToolConfigShape,
  assertToolConsumption,
  calibrationStatusAt,
  classifyOrderImpact,
  compositeFactor,
  computeControlLimits,
  evaluateSampleAdmission,
  followsVersionAfterChange,
  judgeSamplePoint,
  markShippedItemComplaintHint,
  nextToolConfigVersion,
  recomputePlannedQty,
  type SpcInProcessDisposition,
  type SpcOperationMutation,
} from '@cadenza/domain'
import type { CommandContext, CommandHandler, HandlerOutcome } from './command-bus'
import { dec, str } from './inventory-posting'
import type {
  SpcCommandTools,
  SpcControlItemRecord,
  SpcRuleSetRecord,
} from './spc-repositories'

/**
 * spc 域命令处理器（T23 工艺变更影响控制/SPC/计量校准/工具寿命；全部在命令总线事务内运行）。
 *
 * 命令面（18）：
 * - spc.change.create / scan / disposition / publish：变更单四步（PE-01~07）——
 *   起草（版本对+审批人+生效时间 PE-S1）、影响扫描（PE-03 分类/PE-06 落库）、
 *   在制逐单处置（PE-04 三选项）、生效（无未处置在制任务方可发布 PE-S1；
 *   未执行任务自动重算计划量+调整记录 PE-03；PE-07 已有报工工序行为边界守卫）；
 * - spc.rule-set.create / publish：规则集版本（PE-09/S2）；
 * - spc.control-item.create：受控项目（PE-08 随检验规范版本冻结）；
 * - spc.control-limit.recalc：控制限重算（PE-10 触发版本化；历史点位不改标）；
 * - spc.sample.record：样本登记+准入判定（PE-11）+判异（PE-12/14）+失控任务生成
 *   （PE-12；**不写质量域**——SPC 结论仅作质量证据输入 PE-13）；
 * - spc.ooc.dispose / confirm-recontrol：失控处置闭环（PE-12）；
 * - spc.gauge.register / spc.calibration.record：器具台账+校准记录（PE-15/16 append-only）；
 * - spc.miscalibration.action：失准逐项处置（PE-19）；
 * - spc.tool.register / config-revise / consume / adjust：工具寿命（PE-20/21/S5）。
 *
 * 幂等/回执由 PgCommandBus 承担；规则违例以 [PE-xx] 前缀返回（BUSINESS_REJECTION）。
 */

type Payload = Record<string, unknown>

const NOT_FOUND_RULE = 'NOT_FOUND'

function spcViolationOutcome(error: SpcRuleViolation): HandlerOutcome {
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
    if (error instanceof SpcRuleViolation) return spcViolationOutcome(error)
    throw error
  }
}

function requireStr(p: Payload, key: string, command: string): string {
  const v = str(p, key)
  if (v === undefined) throw new SpcRuleViolation('PE-01', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

/** 组织范围二道防线（OA-24/26）。 */
async function assertPlantScope(tools: SpcCommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new SpcRuleViolation('A-S1', `目标工厂不在授权数据范围内（plant=${plantId}）`)
  }
}

/** 命令上下文（回执 id + 业务时点；IT-37 分列口径）。 */
interface SpcContext {
  tools: SpcCommandTools
  commandReceiptId: string
  businessTime: string
}

async function buildSpcContext(
  tools: SpcCommandTools,
  ctx: CommandContext,
  commandType: string,
  operationId: string,
): Promise<SpcContext> {
  const receiptId = await tools.spc.receipts.findIdByKey(ctx.enterpriseId, commandType, operationId)
  if (receiptId === null) {
    throw new SpcRuleViolation(NOT_FOUND_RULE, '命令回执未落库：幂等键缺失，拒绝执行')
  }
  return { tools, commandReceiptId: receiptId, businessTime: tools.now().toISOString() }
}

// 包装：处理器入口统一组装上下文（tools 扩展字段由组合根窄化）。
interface Ctx {
  tools: SpcCommandTools
  ctx: CommandContext
  commandReceiptId: string
  businessTime: string
}

function intOf(p: Payload, key: string): number | undefined {
  const v = p[key]
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined
}

function genNo(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`
}

// ---------------- 工艺变更：起草（PE-S1/PE-05/PE-07 形状） ----------------

async function changeCreate(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.change.create')
  await assertPlantScope(tools, plantId)
  const oldSpecRevisionId = requireStr(p, 'oldSpecRevisionId', 'spc.change.create')
  const newSpecRevisionId = requireStr(p, 'newSpecRevisionId', 'spc.change.create')
  const approver = requireStr(p, 'approver', 'spc.change.create')
  const effectiveAt = requireStr(p, 'effectiveAt', 'spc.change.create')

  const oldSpec = await tools.cross.getProcessSpecRevision(oldSpecRevisionId)
  const newSpec = await tools.cross.getProcessSpecRevision(newSpecRevisionId)
  if (oldSpec === null || newSpec === null) {
    throw new SpcRuleViolation(NOT_FOUND_RULE, '版本对引用的工艺参数规范版本不存在')
  }
  // PE-S1：同工厂同规范名（同对象、仅版本不同）
  assertChangeOrderShape({
    oldSpecRevisionId,
    newSpecRevisionId,
    sameSpecObject: oldSpec.plantId === newSpec.plantId && oldSpec.name === newSpec.name,
    approver,
    effectiveAt,
  })
  // PE-07：工序变动清单形状（行为边界守卫在 scan/publish 时按报工事实执行）
  const mutationsRaw = p['operationMutations']
  const mutations: SpcOperationMutation[] = Array.isArray(mutationsRaw)
    ? mutationsRaw.map((raw, index) => {
        const m = (raw ?? {}) as Payload
        const kind = str(m, 'kind') as SpcOperationMutation['kind'] | undefined
        const targetSeq = intOf(m, 'targetSeq')
        const mutation: SpcOperationMutation = { kind: kind ?? ('unknown' as SpcOperationMutation['kind']), targetSeq }
        assertOperationMutationShape(mutation, index)
        return mutation
      })
    : []
  // 版本对须为同对象不同版本号（PE-01 沿用 T05 版本模型：发布版本对 old→new）
  if (oldSpec.version >= newSpec.version) {
    throw new SpcRuleViolation('PE-S1', `版本对方向非法：旧版本 v${oldSpec.version} 须低于新版本 v${newSpec.version}`)
  }

  // 变更单号幂等（显式 changeNo 重复 → 幂等返回）
  const changeNo = str(p, 'changeNo') ?? genNo('PC')
  const existing = await tools.spc.changes.findByNo(changeNo)
  if (existing !== null) {
    return { changeId: existing.id, changeNo, skipped: true, status: existing.status }
  }

  const change = await tools.spc.changes.insert({
    changeNo,
    plantId,
    oldSpecRevisionId,
    newSpecRevisionId,
    approver,
    effectiveAt,
    operationMutations: mutations,
    commandReceiptId: c.commandReceiptId,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.change.create',
    subjectType: 'spc_process_change',
    subjectId: change.id,
    after: { changeNo, oldSpecRevisionId, newSpecRevisionId, approver, effectiveAt, mutations: mutations.length },
    reason: str(p, 'reason') ?? null,
  })
  return { changeId: change.id, changeNo, skipped: false, status: change.status }
}

// ---------------- 工艺变更：影响扫描（PE-03/PE-06） ----------------

async function changeScan(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.change.scan')
  await assertPlantScope(tools, plantId)
  const changeId = requireStr(p, 'changeId', 'spc.change.scan')

  const change = await tools.spc.changes.lockById(changeId)
  if (change === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '变更单不存在')
  if (change.plantId !== plantId) throw new SpcRuleViolation('A-S1', '变更单不在目标工厂')
  if (change.status !== 'draft') throw new SpcRuleViolation('PE-06', '变更单已生效，影响清单冻结（生效后不可重扫）')
  const existingImpacts = await tools.spc.impacts.listByChange(changeId)
  if (existingImpacts.length > 0) {
    throw new SpcRuleViolation('PE-06', '变更单已扫描过影响清单（同一变更单不重复扫描；同 operationId 重放由幂等键回放）')
  }

  const oldSpec = await tools.cross.getProcessSpecRevision(change.oldSpecRevisionId)
  if (oldSpec === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '变更单旧版本引用不存在')
  // PE-06 影响范围：该规范对象（产品族）的订单 → 工序任务
  const orders = await tools.cross.listOrdersByProductFamily(plantId, oldSpec.productFamilyId)
  const scheduledOpIds = new Set<string>()
  const impacts: Array<{
    category: 'unexecuted' | 'in_process' | 'completed'
    order: { id: string; orderNo: string; orderStatus: string }
    op: { id: string; seq: number; operationName: string; plannedQty: string }
  }> = []
  for (const order of orders) {
    const ops = await tools.cross.listOrderOperations(order.id)
    const reportedSeqs = new Set(await tools.cross.listReportedOperationSeqs(order.id))
    for (const opId of await tools.cross.listScheduledOperationIds(order.id)) scheduledOpIds.add(opId)
    for (const op of ops) {
      const category = classifyOrderImpact({ orderStatus: order.orderStatus, hasSubmittedReport: reportedSeqs.has(op.seq) })
      if (category === null) continue // 作废单不在影响范围
      // 计划量 = 该工序排产槽位合计（PE-03：已排产未开工随变更自动重算）
      const plannedQty = op.offlineQty
      impacts.push({
        category,
        order: { id: order.id, orderNo: order.orderNo, orderStatus: order.orderStatus },
        op: { id: op.id, seq: op.seq, operationName: op.operationName, plannedQty },
      })
    }
  }

  const rows = await tools.spc.impacts.insertMany(
    impacts.map((i) => ({
      changeId: change.id,
      category: i.category,
      productionOrderId: i.order.id,
      orderNo: i.order.orderNo,
      orderStatus: i.order.orderStatus,
      orderOperationId: i.op.id,
      operationSeq: i.op.seq,
      operationName: i.op.operationName,
      scheduled: scheduledOpIds.has(i.op.id),
      // PE-04/PE-05：在制任务处置前 followsVersion 置空（处置后按 continue_old/switch_new 定向）；
      // 未执行→new（随变更按新版）；已完成→old（历史实绩保留旧参数）
      followsVersion:
        i.category === 'in_process' ? null : followsVersionAfterChange({ category: i.category, disposition: null }),
      plannedQty: i.op.plannedQty,
      enterpriseId: c.ctx.enterpriseId,
      createdBy: c.ctx.actorLoginName,
    })),
  )
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.change.scan',
    subjectType: 'spc_process_change',
    subjectId: change.id,
    after: {
      orders: orders.length,
      impacts: rows.length,
      unexecuted: rows.filter((r) => r.category === 'unexecuted').length,
      inProcess: rows.filter((r) => r.category === 'in_process').length,
      completed: rows.filter((r) => r.category === 'completed').length,
    },
    reason: str(p, 'reason') ?? null,
  })
  return {
    changeId: change.id,
    scanned: rows.length,
    summary: {
      unexecuted: rows.filter((r) => r.category === 'unexecuted').length,
      inProcess: rows.filter((r) => r.category === 'in_process').length,
      completed: rows.filter((r) => r.category === 'completed').length,
    },
  }
}

// ---------------- 工艺变更：在制逐单处置（PE-04） ----------------

async function changeDisposition(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.change.disposition')
  await assertPlantScope(tools, plantId)
  const changeId = requireStr(p, 'changeId', 'spc.change.disposition')
  const impactId = requireStr(p, 'impactId', 'spc.change.disposition')
  const dispositionRaw = str(p, 'disposition')
  if (dispositionRaw !== 'continue_old' && dispositionRaw !== 'switch_new' && dispositionRaw !== 'isolation_review') {
    throw new SpcRuleViolation('PE-04', `处置选项非法：${String(dispositionRaw)}（continue_old/switch_new/isolation_review）`)
  }
  const disposition = dispositionRaw as SpcInProcessDisposition

  const change = await tools.spc.changes.lockById(changeId)
  if (change === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '变更单不存在')
  if (change.plantId !== plantId) throw new SpcRuleViolation('A-S1', '变更单不在目标工厂')
  if (change.status !== 'draft') throw new SpcRuleViolation('PE-04', '变更单已生效，不可再变更处置结论')
  const impact = await tools.spc.impacts.findById(impactId)
  if (impact === null || impact.changeId !== changeId) throw new SpcRuleViolation(NOT_FOUND_RULE, '影响任务行不存在或不属于该变更单')
  // PE-04：在制任务逐单显式选择（未选择/非法值拒）；未执行/已完成任务不得携带处置
  assertDispositionChoice({ category: impact.category, disposition })
  const follows = followsVersionAfterChange({ category: impact.category, disposition })

  const updated = await tools.spc.impacts.setDisposition(
    impactId,
    { disposition, followsVersion: follows, dispositionBy: c.ctx.actorLoginName, dispositionAt: c.businessTime },
    c.ctx.actorLoginName,
  )
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.change.disposition',
    subjectType: 'spc_change_impact',
    subjectId: impactId,
    before: { disposition: impact.disposition, followsVersion: impact.followsVersion },
    after: { disposition, followsVersion: follows, orderNo: impact.orderNo, operationSeq: impact.operationSeq },
    reason: str(p, 'reason') ?? null,
  })
  return { impactId, orderNo: updated?.orderNo ?? impact.orderNo, disposition, followsVersion: follows }
}

// ---------------- 工艺变更：生效（PE-S1/PE-02/PE-03/PE-04/PE-07） ----------------

/** 从参数规范 jsonb 提取工序系数（容忍形状：数组项含 coreMultiple/strandFactor 键）。 */
function extractSpecFactor(parameters: unknown): { coreMultiple: number; strandFactor: string | null } | null {
  if (!Array.isArray(parameters)) return null
  for (const raw of parameters) {
    const item = (raw ?? {}) as Payload
    const core = item['coreMultiple']
    const strand = item['strandFactor']
    if (typeof core === 'number' && Number.isInteger(core) && core >= 1) {
      return {
        coreMultiple: core,
        strandFactor: typeof strand === 'string' && strand.length > 0 ? strand : null,
      }
    }
  }
  return null
}

async function changePublish(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.change.publish')
  await assertPlantScope(tools, plantId)
  const changeId = requireStr(p, 'changeId', 'spc.change.publish')

  const change = await tools.spc.changes.lockById(changeId)
  if (change === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '变更单不存在')
  if (change.plantId !== plantId) throw new SpcRuleViolation('A-S1', '变更单不在目标工厂')
  const impacts = await tools.spc.impacts.listByChange(changeId)
  // PE-S1/PE-04：无未处置在制任务方可生效
  assertChangePublishable({
    status: change.status,
    impacts: impacts.map((i) => ({ category: i.category, disposition: i.disposition })),
  })

  // PE-07：已有报工的工序行为边界（原文约束保留为命令守卫）——逐受影响订单校验
  const mutations = Array.isArray(change.operationMutations) ? (change.operationMutations as SpcOperationMutation[]) : []
  const orderIds = [...new Set(impacts.map((i) => i.productionOrderId))]
  for (const orderId of orderIds) {
    const reportedSeqs = await tools.cross.listReportedOperationSeqs(orderId)
    assertOperationMutationsAllowed({ mutations, reportedSeqs })
  }

  const oldSpec = await tools.cross.getProcessSpecRevision(change.oldSpecRevisionId)
  const newSpec = await tools.cross.getProcessSpecRevision(change.newSpecRevisionId)
  if (oldSpec === null || newSpec === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '版本对引用不存在')
  const newFactorSpec = extractSpecFactor(newSpec.parameters)

  // PE-03：未执行（含已排产未开工）与 转新版在制 → 自动重算计划量并留调整记录；
  // PE-02：已完成/继续旧版/隔离评审 → 不重算（历史实绩保留旧参数，不静默重算）
  const adjustments: Array<Record<string, unknown>> = []
  for (const impact of impacts) {
    if (impact.plannedQty === '0.0000') continue
    const shouldRecompute =
      impact.category === 'unexecuted' || (impact.category === 'in_process' && impact.disposition === 'switch_new')
    if (!shouldRecompute) continue
    const ops = await tools.cross.listOrderOperations(impact.productionOrderId)
    const op = ops.find((o) => o.id === impact.orderOperationId)
    if (op === undefined) continue
    const oldFactor = compositeFactor({ coreMultiple: op.coreMultiple, strandFactor: op.strandFactor })
    const newFactor = newFactorSpec !== null
      ? compositeFactor({ coreMultiple: newFactorSpec.coreMultiple, strandFactor: newFactorSpec.strandFactor })
      : oldFactor
    const newPlanned = recomputePlannedQty({ plannedQty: impact.plannedQty, oldFactor, newFactor })
    const written = await tools.spc.adjustments.insert({
      changeId: change.id,
      orderOperationId: impact.orderOperationId,
      orderNo: impact.orderNo,
      operationSeq: impact.operationSeq,
      oldPlannedQty: impact.plannedQty,
      newPlannedQty: newPlanned,
      basis: {
        oldFactor,
        newFactor,
        factorChanged: newFactor !== oldFactor,
        category: impact.category,
        disposition: impact.disposition,
        approver: change.approver,
        effectiveAt: change.effectiveAt,
      },
      enterpriseId: c.ctx.enterpriseId,
      createdBy: c.ctx.actorLoginName,
    })
    await tools.spc.impacts.setRecomputed(impact.id, newPlanned, c.ctx.actorLoginName)
    adjustments.push({
      adjustmentId: written.id,
      orderNo: impact.orderNo,
      operationSeq: impact.operationSeq,
      oldPlannedQty: impact.plannedQty,
      newPlannedQty: newPlanned,
      // 转新版在制后续产出按新版；未执行任务随变更按新版（PE-04②/PE-03）
      followsVersion: 'new',
    })
  }

  const published = await tools.spc.changes.markPublished(
    change.id,
    { publishedAt: c.businessTime, publishedBy: c.ctx.actorLoginName },
    c.ctx.actorLoginName,
  )
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.change.publish',
    subjectType: 'spc_process_change',
    subjectId: change.id,
    before: { status: 'draft' },
    after: {
      status: 'published',
      approver: change.approver,
      effectiveAt: change.effectiveAt,
      impacts: impacts.length,
      adjustments: adjustments.length,
    },
    reason: str(p, 'reason') ?? null,
  })
  c.tools.outbox.collect({
    aggregateType: 'spc_process_change',
    aggregateId: change.id,
    taskKind: 'spc.process-change-published',
    payload: {
      changeId: change.id,
      changeNo: change.changeNo,
      oldSpecRevisionId: change.oldSpecRevisionId,
      newSpecRevisionId: change.newSpecRevisionId,
      approver: change.approver,
      effectiveAt: change.effectiveAt,
      adjustments: adjustments.length,
    },
  })
  return {
    changeId: change.id,
    changeNo: change.changeNo,
    status: 'published',
    approver: change.approver,
    effectiveAt: change.effectiveAt,
    publishedAt: published?.publishedAt ?? c.businessTime,
    impactCount: impacts.length,
    adjustments,
  }
}

// ---------------- SPC：规则集（PE-09/PE-S2） ----------------

async function ruleSetCreate(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.rule-set.create')
  await assertPlantScope(tools, plantId)
  const name = requireStr(p, 'name', 'spc.rule-set.create')
  const versionRaw = intOf(p, 'version') ?? 1
  const chartType = str(p, 'chartType') ?? 'i_mr'
  const criteriaRaw = p['criteria']
  const criteria = Array.isArray(criteriaRaw) ? criteriaRaw.filter((v): v is string => typeof v === 'string') : []
  assertRuleSetShape({ name, version: versionRaw, chartType, criteria })
  if (name === DEFAULT_RULE_SET_NAME) {
    throw new SpcRuleViolation('PE-09', `规则集名 ${DEFAULT_RULE_SET_NAME} 为默认规则集保留名（现场未选定前的默认子集）`)
  }
  const existing = await tools.spc.ruleSets.findByPlantNameVersion(plantId, name, versionRaw)
  if (existing !== null) {
    throw new SpcRuleViolation('PE-S2', `规则集 ${name} v${versionRaw} 已存在（版本化配置不可重复建）`)
  }
  const ruleSet = await tools.spc.ruleSets.insert({
    name,
    version: versionRaw,
    chartType: chartType as 'xbar_r' | 'i_mr' | 'p',
    criteria,
    plantId,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.rule-set.create',
    subjectType: 'spc_rule_set',
    subjectId: ruleSet.id,
    after: { name, version: versionRaw, chartType, criteria },
    reason: str(p, 'reason') ?? null,
  })
  return { ruleSetId: ruleSet.id, name, version: versionRaw, status: ruleSet.status }
}

async function ruleSetPublish(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.rule-set.publish')
  await assertPlantScope(tools, plantId)
  const ruleSetId = requireStr(p, 'ruleSetId', 'spc.rule-set.publish')
  const ruleSet = await tools.spc.ruleSets.findByIdOrNull(ruleSetId)
  if (ruleSet === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '规则集不存在')
  if (ruleSet.plantId !== plantId) throw new SpcRuleViolation('A-S1', '规则集不在目标工厂')
  assertRuleSetPublishable(ruleSet.status)
  const published = await tools.spc.ruleSets.publish(
    ruleSetId,
    { publishedAt: c.businessTime, publishedBy: c.ctx.actorLoginName },
    c.ctx.actorLoginName,
  )
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.rule-set.publish',
    subjectType: 'spc_rule_set',
    subjectId: ruleSetId,
    before: { status: ruleSet.status },
    after: { status: 'published', name: ruleSet.name, version: ruleSet.version, criteria: ruleSet.criteria },
    reason: str(p, 'reason') ?? null,
  })
  return { ruleSetId, name: ruleSet.name, version: ruleSet.version, status: published?.status ?? 'published' }
}

// ---------------- SPC：受控项目（PE-08） ----------------

async function controlItemCreate(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.control-item.create')
  await assertPlantScope(tools, plantId)
  const specCode = requireStr(p, 'specCode', 'spc.control-item.create')
  const specVersion = intOf(p, 'specVersion')
  if (specVersion === undefined || specVersion < 1) {
    throw new SpcRuleViolation('PE-08', 'specVersion 必须为正整数（受控清单随检验规范版本冻结）')
  }
  const itemNo = requireStr(p, 'itemNo', 'spc.control-item.create')
  const pointRef = str(p, 'pointRef') ?? null
  assertControlItemShape({ specCode, specVersion, itemNo, pointRef })
  // 清单随检验规范版本冻结：同规范同项唯一
  const existing = await tools.spc.controlItems.findBySpecItem(specCode, specVersion, itemNo)
  if (existing !== null) {
    throw new SpcRuleViolation('PE-08', `受控项目已存在（${specCode} v${specVersion} 项 ${itemNo}）：清单随规范版本冻结，不可重复登记`)
  }
  const ruleSetId = str(p, 'ruleSetId') ?? null
  if (ruleSetId !== null) {
    const rs = await tools.spc.ruleSets.findByIdOrNull(ruleSetId)
    if (rs === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '绑定的规则集版本不存在')
  }
  const item = await tools.spc.controlItems.insert({
    specCode,
    specVersion,
    itemNo,
    itemName: str(p, 'itemName') ?? null,
    pointRef,
    ruleSetId,
    plantId,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.control-item.create',
    subjectType: 'spc_control_item',
    subjectId: item.id,
    after: { specCode, specVersion, itemNo, pointRef, ruleSetId },
    reason: str(p, 'reason') ?? null,
  })
  return { controlItemId: item.id, specCode, specVersion, itemNo, ruleSetId }
}

// ---------------- SPC：控制限重算（PE-10/PE-S2） ----------------

async function controlLimitRecalc(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.control-limit.recalc')
  await assertPlantScope(tools, plantId)
  const controlItemId = requireStr(p, 'controlItemId', 'spc.control-limit.recalc')
  const item = await tools.spc.controlItems.findById(controlItemId)
  if (item === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '受控项目不存在')
  if (item.plantId !== plantId) throw new SpcRuleViolation('A-S1', '受控项目不在目标工厂')
  const baselineGroupCount = intOf(p, 'baselineGroupCount') ?? 25
  const triggerKindRaw = str(p, 'triggerKind') ?? 'initial'
  if (!['initial', 'rule_set_change', 'process_change', 'calibration_change'].includes(triggerKindRaw)) {
    throw new SpcRuleViolation('PE-10', `重算触发类型非法：${triggerKindRaw}`)
  }
  const triggerKind = triggerKindRaw as 'initial' | 'rule_set_change' | 'process_change' | 'calibration_change'
  const triggerRef = str(p, 'triggerRef') ?? null
  if (triggerKind !== 'initial' && triggerRef === null) {
    throw new SpcRuleViolation('PE-10', `触发类型 ${triggerKind} 必须携带触发引用（triggerRef）`)
  }

  // PE-10：以首 n 组已准入样本建立；历史点位不随重算改标（判定行 append-only，绑定判定时点版本）
  const admitted = await tools.spc.samples.listAdmittedByItem(controlItemId)
  const values = admitted.map((s) => s.measuredValue)
  const limits = computeControlLimits({ method: 'mean_pm_3sigma', baselineCount: baselineGroupCount, values })
  const version = await tools.spc.controlLimits.nextVersion(controlItemId)
  const ruleSet = await resolveRuleSetForItem(c, item)
  const record = await tools.spc.controlLimits.insert({
    controlItemId,
    version,
    method: 'mean_pm_3sigma',
    baselineGroupCount,
    cl: limits?.cl ?? null,
    ucl: limits?.ucl ?? null,
    lcl: limits?.lcl ?? null,
    status: limits === null ? 'building' : 'active',
    triggerKind,
    triggerRef,
    ruleSetId: ruleSet.id,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.control-limit.recalc',
    subjectType: 'spc_control_limit',
    subjectId: record.id,
    after: {
      controlItemId,
      version,
      status: record.status,
      triggerKind,
      triggerRef,
      baselineGroupCount,
      admittedSamples: admitted.length,
      cl: record.cl,
      ucl: record.ucl,
      lcl: record.lcl,
    },
    reason: str(p, 'reason') ?? null,
  })
  return {
    limitVersionId: record.id,
    controlItemId,
    version,
    status: record.status,
    triggerKind,
    cl: record.cl,
    ucl: record.ucl,
    lcl: record.lcl,
    baselineGroupCount,
    admittedSamples: admitted.length,
  }
}

/** 受控项目的采用规则集：绑定版本优先；缺省=默认规则集（PE-09 懒建+标注）。 */
async function resolveRuleSetForItem(c: Ctx, item: SpcControlItemRecord): Promise<SpcRuleSetRecord> {
  const tools = c.tools
  if (item.ruleSetId !== null) {
    const bound = await tools.spc.ruleSets.findByIdOrNull(item.ruleSetId)
    if (bound !== null && bound.status === 'published') return bound
    if (bound !== null) {
      throw new SpcRuleViolation('PE-09', `绑定的规则集 ${bound.name} v${bound.version} 未发布（${bound.status}），不可用于判异`)
    }
  }
  // 默认规则集：单点越限＋连续 6 点同侧，标注 is_default（GAP-E14 采用版本待裁）
  let def = await tools.spc.ruleSets.findLatestPublished(item.plantId, DEFAULT_RULE_SET_NAME)
  if (def === null) {
    const created = await tools.spc.ruleSets.insert({
      name: DEFAULT_RULE_SET_NAME,
      version: 1,
      chartType: 'i_mr',
      criteria: [...DEFAULT_SPC_CRITERIA],
      isDefault: true,
      plantId: item.plantId,
      enterpriseId: c.ctx.enterpriseId,
      createdBy: c.ctx.actorLoginName,
    })
    def = await tools.spc.ruleSets.publish(
      created.id,
      { publishedAt: c.businessTime, publishedBy: c.ctx.actorLoginName },
      c.ctx.actorLoginName,
    )
    if (def === null) throw new SpcRuleViolation('PE-09', '默认规则集建立失败')
  }
  return def
}

// ---------------- SPC：样本登记+准入+判异（PE-11/12/13/14/16） ----------------

async function sampleRecord(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.sample.record')
  await assertPlantScope(tools, plantId)
  const controlItemId = requireStr(p, 'controlItemId', 'spc.sample.record')
  const item = await tools.spc.controlItems.findById(controlItemId)
  if (item === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '受控项目不存在')
  if (item.plantId !== plantId) throw new SpcRuleViolation('A-S1', '受控项目不在目标工厂')
  const sourceRaw = str(p, 'source')
  if (sourceRaw !== 'manual_inspection' && sourceRaw !== 'collection') {
    throw new SpcRuleViolation('PE-11', `样本来源非法：${String(sourceRaw)}（manual_inspection/collection）`)
  }
  const source = sourceRaw as 'manual_inspection' | 'collection'
  const measuredValue = dec(p, 'measuredValue')
  if (measuredValue === undefined) {
    throw new SpcRuleViolation('PE-11', 'measuredValue 必须为十进制定点字符串（≤4 位小数）')
  }
  const sampledAt = str(p, 'sampledAt') ?? c.businessTime
  const testResultId = str(p, 'testResultId') ?? null
  const qualityCode = str(p, 'qualityCode') ?? null
  const gaugeId = str(p, 'gaugeId') ?? null
  const badPoint = p['badPoint'] === true
  const clockDeviation = p['clockDeviation'] === true

  // PE-11 事实收集：人工来源实测引用存在性；器具时点校准快照（PE-16/17）
  if (source === 'manual_inspection' && testResultId !== null) {
    const tr = await tools.cross.getTestResult(testResultId)
    if (tr === null) throw new SpcRuleViolation(NOT_FOUND_RULE, `检验实测结果 ${testResultId} 不存在（人工样本须引用既有实测）`)
  }
  let calibrationStatus: 'valid' | 'limited' | 'invalid' | 'expired' | 'unknown' | null = null
  if (gaugeId !== null) {
    const gauge = await tools.spc.gauges.findById(gaugeId)
    if (gauge === null) throw new SpcRuleViolation(NOT_FOUND_RULE, `计量器具 ${gaugeId} 不存在`)
    const records = await tools.spc.calibrations.listByGauge(gaugeId)
    calibrationStatus = calibrationStatusAt(
      records.map((r) => ({ calibratedAt: r.calibratedAt, result: r.result, validUntil: r.validUntil })),
      sampledAt,
    )
  }
  // PE-11 准入判定
  const decision = evaluateSampleAdmission({
    source,
    testResultRef: testResultId,
    qualityCode,
    gaugeId,
    calibrationStatus,
    badPoint,
    clockDeviation,
  })
  const sample = await tools.spc.samples.insert({
    controlItemId,
    source,
    testResultId,
    measuredValue,
    sampledAt,
    productionOrderId: str(p, 'productionOrderId') ?? null,
    orderOperationId: str(p, 'orderOperationId') ?? null,
    operationSeq: intOf(p, 'operationSeq') ?? null,
    equipmentId: str(p, 'equipmentId') ?? null,
    equipmentCode: str(p, 'equipmentCode') ?? null,
    shiftDate: str(p, 'shiftDate') ?? null,
    gaugeId,
    calibrationStatus,
    admission: decision.admitted ? 'admitted' : 'rejected',
    rejectReason: decision.rejectReason,
    commandReceiptId: c.commandReceiptId,
    plantId,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })

  // 准入后判异（PE-12/14）：须存在 active 控制限版本；历史点位不重判（append-only）
  let judgement: Record<string, unknown> | null = null
  let oocTask: Record<string, unknown> | null = null
  if (decision.admitted) {
    const limit = await tools.spc.controlLimits.findLatestActive(controlItemId)
    if (limit !== null && limit.cl !== null && limit.ucl !== null && limit.lcl !== null) {
      const ruleSet = await resolveRuleSetForItem(c, item)
      const history = (await tools.spc.samples.listAdmittedByItem(controlItemId))
        .filter((s) => s.id !== sample.id && Date.parse(s.sampledAt) <= Date.parse(sample.sampledAt))
      const historyPoints = history.map((s) => ({
        value: s.measuredValue,
        cl: limit.cl!,
        ucl: limit.ucl!,
        lcl: limit.lcl!,
      }))
      const judged = judgeSamplePoint({
        criteria: ruleSet.criteria,
        history: historyPoints,
        newPoint: { value: measuredValue, cl: limit.cl!, ucl: limit.ucl!, lcl: limit.lcl! },
      })
      const pointNo = (await tools.spc.judgements.listByItem(controlItemId)).length + 1
      const judgementRow = await tools.spc.judgements.insert({
        sampleId: sample.id,
        controlItemId,
        pointNo,
        verdict: judged.verdict,
        violatedCodes: judged.violatedCodes,
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
        controlLimitId: limit.id,
        controlLimitVersion: limit.version,
        judgedAt: c.businessTime,
        enterpriseId: c.ctx.enterpriseId,
        createdBy: c.ctx.actorLoginName,
      })
      judgement = {
        pointNo,
        verdict: judged.verdict,
        violatedCodes: judged.violatedCodes,
        ruleSet: `${ruleSet.name} v${ruleSet.version}${ruleSet.isDefault ? '（默认规则集）' : ''}`,
        limitVersion: limit.version,
        judgementId: judgementRow.id,
      }
      // PE-12：判异命中 → 生成 SPC 异常处置任务（通知对象可配置）；
      // PE-13：不写质量域——失控≠自动不合格，仅携带"质量存疑"级提示
      if (judged.verdict === 'out_of_control') {
        const notifyRolesRaw = p['notifyRoles']
        const notifyRoles = Array.isArray(notifyRolesRaw)
          ? notifyRolesRaw.filter((v): v is string => typeof v === 'string' && ['quality', 'process', 'shift_leader'].includes(v))
          : ['quality', 'process', 'shift_leader']
        const task = await tools.spc.oocTasks.insert({
          taskNo: genNo('OOC'),
          controlItemId,
          sampleId: sample.id,
          notifyRoles,
          qualityDoubtHint: true,
          raisedAt: c.businessTime,
          raisedBy: c.ctx.actorLoginName,
          commandReceiptId: c.commandReceiptId,
          plantId,
          enterpriseId: c.ctx.enterpriseId,
          createdBy: c.ctx.actorLoginName,
        })
        oocTask = { oocTaskId: task.id, taskNo: task.taskNo, status: task.status, notifyRoles, qualityDoubtHint: true }
        c.tools.outbox.collect({
          aggregateType: 'spc_ooc_task',
          aggregateId: task.id,
          taskKind: 'spc.out-of-control-detected',
          payload: {
            oocTaskId: task.id,
            taskNo: task.taskNo,
            controlItemId,
            sampleId: sample.id,
            violatedCodes: judged.violatedCodes,
            notifyRoles,
            qualityDoubtHint: true,
            detectedAt: c.businessTime,
          },
        })
      }
    }
  }

  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.sample.record',
    subjectType: 'spc_sample',
    subjectId: sample.id,
    after: {
      controlItemId,
      source,
      measuredValue,
      sampledAt,
      admission: sample.admission,
      rejectReason: sample.rejectReason,
      calibrationStatus,
      gaugeId,
      judgement,
      oocTask,
    },
    reason: str(p, 'reason') ?? null,
  })
  return {
    sampleId: sample.id,
    admission: sample.admission,
    rejectReason: sample.rejectReason,
    calibrationStatus,
    judgement,
    oocTask,
  }
}

// ---------------- SPC：失控处置闭环（PE-12） ----------------

async function oocDispose(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.ooc.dispose')
  await assertPlantScope(tools, plantId)
  const oocTaskId = requireStr(p, 'oocTaskId', 'spc.ooc.dispose')
  const causeCategory = requireStr(p, 'causeCategory', 'spc.ooc.dispose')
  const correctiveAction = requireStr(p, 'correctiveAction', 'spc.ooc.dispose')
  const isolationSuggestion = str(p, 'isolationSuggestion') ?? null

  const task = await tools.spc.oocTasks.findById(oocTaskId)
  if (task === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '失控处置任务不存在')
  if (task.plantId !== plantId) throw new SpcRuleViolation('A-S1', '失控处置任务不在目标工厂')
  assertOocDisposable({ status: task.status, causeCategory, correctiveAction })
  const disposed = await tools.spc.oocTasks.dispose(oocTaskId, {
    causeCategory,
    correctiveAction,
    isolationSuggestion,
    disposedBy: c.ctx.actorLoginName,
    disposedAt: c.businessTime,
  })
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.ooc.dispose',
    subjectType: 'spc_ooc_task',
    subjectId: oocTaskId,
    before: { status: task.status },
    after: { status: 'disposed', causeCategory, correctiveAction, isolationSuggestion },
    reason: str(p, 'reason') ?? null,
  })
  return { oocTaskId, status: disposed?.status ?? 'disposed', causeCategory, correctiveAction, isolationSuggestion }
}

async function oocConfirmRecontrol(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.ooc.confirm-recontrol')
  await assertPlantScope(tools, plantId)
  const oocTaskId = requireStr(p, 'oocTaskId', 'spc.ooc.confirm-recontrol')

  const task = await tools.spc.oocTasks.findById(oocTaskId)
  if (task === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '失控处置任务不存在')
  if (task.plantId !== plantId) throw new SpcRuleViolation('A-S1', '失控处置任务不在目标工厂')
  // PE-12：复控确认须有处置时点之后 ≥1 个在控样本支撑
  const subsequentInControl =
    task.disposedAt !== null ? await tools.spc.judgements.countInControlAfter(task.controlItemId, task.disposedAt) : 0
  assertRecontrolConfirmable({ status: task.status, subsequentInControlCount: subsequentInControl })
  const confirmed = await tools.spc.oocTasks.confirmRecontrol(oocTaskId, {
    recontrolConfirmedBy: c.ctx.actorLoginName,
    recontrolConfirmedAt: c.businessTime,
  })
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.ooc.confirm-recontrol',
    subjectType: 'spc_ooc_task',
    subjectId: oocTaskId,
    before: { status: task.status },
    after: { status: 're_control_confirmed', subsequentInControl },
    reason: str(p, 'reason') ?? null,
  })
  return {
    oocTaskId,
    status: confirmed?.status ?? 're_control_confirmed',
    subsequentInControl,
    recontrolConfirmedAt: confirmed?.recontrolConfirmedAt ?? c.businessTime,
  }
}

// ---------------- 计量器具与校准（PE-15/16/17） ----------------

async function gaugeRegister(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.gauge.register')
  await assertPlantScope(tools, plantId)
  const gaugeNo = requireStr(p, 'gaugeNo', 'spc.gauge.register')
  const name = requireStr(p, 'name', 'spc.gauge.register')
  const existing = await tools.spc.gauges.findByNo(plantId, gaugeNo)
  if (existing !== null) {
    throw new SpcRuleViolation('PE-15', `计量器具 ${gaugeNo} 已登记（器具身份唯一）`)
  }
  const gauge = await tools.spc.gauges.insert({
    gaugeNo,
    name,
    gaugeKind: str(p, 'gaugeKind') ?? null,
    plantId,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.gauge.register',
    subjectType: 'spc_gauge',
    subjectId: gauge.id,
    after: { gaugeNo, name },
    reason: str(p, 'reason') ?? null,
  })
  return { gaugeId: gauge.id, gaugeNo, name }
}

async function calibrationRecord(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.calibration.record')
  await assertPlantScope(tools, plantId)
  const gaugeId = requireStr(p, 'gaugeId', 'spc.calibration.record')
  const calibratedAt = requireStr(p, 'calibratedAt', 'spc.calibration.record')
  const result = str(p, 'result')
  const certificateNo = requireStr(p, 'certificateNo', 'spc.calibration.record')
  const validUntil = requireStr(p, 'validUntil', 'spc.calibration.record')
  const basis = requireStr(p, 'basis', 'spc.calibration.record')
  const gauge = await tools.spc.gauges.findById(gaugeId)
  if (gauge === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '计量器具不存在')
  if (gauge.plantId !== plantId) throw new SpcRuleViolation('A-S1', '计量器具不在目标工厂')
  // PE-15：记录形状 + 追加式（无更新路径；新校准不改写旧记录）
  assertCalibrationRecordShape({ gaugeId, calibratedAt, result: result ?? '', certificateNo, validUntil, basis })
  const record = await tools.spc.calibrations.insert({
    gaugeId,
    calibratedAt,
    result: result as 'qualified' | 'limited' | 'failed',
    certificateNo,
    validUntil,
    basis,
    recordedBy: c.ctx.actorLoginName,
    commandReceiptId: c.commandReceiptId,
    plantId,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })
  // 失准 → 失准圈定提示事件（PE-18 入口提示；圈定本身为只读查询）
  if (record.result === 'failed') {
    c.tools.outbox.collect({
      aggregateType: 'spc_gauge',
      aggregateId: gaugeId,
      taskKind: 'spc.miscalibration-detected',
      payload: {
        gaugeId,
        gaugeNo: gauge.gaugeNo,
        calibratedAt,
        validUntil,
        certificateNo,
        detectedAt: c.businessTime,
      },
    })
  }
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.calibration.record',
    subjectType: 'spc_calibration_record',
    subjectId: record.id,
    after: { gaugeId, gaugeNo: gauge.gaugeNo, calibratedAt, result, certificateNo, validUntil, basis },
    reason: str(p, 'reason') ?? null,
  })
  return { calibrationId: record.id, gaugeId, result, certificateNo, validUntil }
}

// ---------------- 失准逐项处置（PE-19） ----------------

async function miscalibrationAction(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.miscalibration.action')
  await assertPlantScope(tools, plantId)
  const gaugeId = requireStr(p, 'gaugeId', 'spc.miscalibration.action')
  const windowFrom = requireStr(p, 'windowFrom', 'spc.miscalibration.action')
  const windowTo = requireStr(p, 'windowTo', 'spc.miscalibration.action')
  const itemKind = str(p, 'itemKind') ?? ''
  const itemRef = requireStr(p, 'itemRef', 'spc.miscalibration.action')
  const actionKind = str(p, 'actionKind') ?? ''
  const gauge = await tools.spc.gauges.findById(gaugeId)
  if (gauge === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '计量器具不存在')
  if (gauge.plantId !== plantId) throw new SpcRuleViolation('A-S1', '计量器具不在目标工厂')
  assertMiscalibrationActionShape({ actionKind, itemKind, itemRef })
  // PE-19：已发运项进入客诉/召回提示范围
  const complaintHint = markShippedItemComplaintHint(itemKind as 'shipped_unit')
  const action = await tools.spc.miscalibrationActions.insert({
    gaugeId,
    windowFrom,
    windowTo,
    itemKind,
    itemRef,
    itemLabel: str(p, 'itemLabel') ?? null,
    actionKind: actionKind as 'isolation' | 'retest' | 'concession' | 'rework_scrap',
    externalRef: str(p, 'externalRef') ?? null,
    customerComplaintHint: complaintHint,
    actedBy: c.ctx.actorLoginName,
    actedAt: c.businessTime,
    commandReceiptId: c.commandReceiptId,
    plantId,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.miscalibration.action',
    subjectType: 'spc_miscalibration_action',
    subjectId: action.id,
    after: { gaugeId, windowFrom, windowTo, itemKind, itemRef, actionKind, customerComplaintHint: complaintHint },
    reason: str(p, 'reason') ?? null,
  })
  return {
    actionId: action.id,
    gaugeId,
    itemKind,
    itemRef,
    actionKind,
    customerComplaintHint: complaintHint,
  }
}

// ---------------- 工具寿命（PE-20/PE-21/PE-S5） ----------------

async function toolRegister(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.tool.register')
  await assertPlantScope(tools, plantId)
  const toolNo = requireStr(p, 'toolNo', 'spc.tool.register')
  const name = requireStr(p, 'name', 'spc.tool.register')
  const lifeUom = str(p, 'lifeUom') ?? ''
  const ratedLife = dec(p, 'ratedLife')
  const warningThreshold = dec(p, 'warningThreshold')
  const expirePolicy = str(p, 'expirePolicy') ?? ''
  if (ratedLife === undefined || warningThreshold === undefined) {
    throw new SpcRuleViolation('PE-20', 'ratedLife/warningThreshold 必须为十进制定点字符串（≤4 位小数）')
  }
  assertToolConfigShape({ lifeUom, ratedLife, warningThreshold, expirePolicy, version: 1 })
  const existing = await tools.spc.tools.findByNo(plantId, toolNo)
  if (existing !== null) throw new SpcRuleViolation('PE-20', `工具 ${toolNo} 已登记（台账唯一）`)
  const tool = await tools.spc.tools.insert({
    toolNo,
    name,
    toolKind: str(p, 'toolKind') ?? null,
    configVersion: 1,
    lifeUom: lifeUom as 'count' | 'meters' | 'hours',
    ratedLife,
    warningThreshold,
    expirePolicy: expirePolicy as 'block' | 'degrade',
    plantId,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })
  await tools.spc.toolConfigs.insert({
    toolId: tool.id,
    version: 1,
    lifeUom: tool.lifeUom,
    ratedLife,
    warningThreshold,
    expirePolicy: tool.expirePolicy,
    effectiveAt: c.businessTime,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.tool.register',
    subjectType: 'spc_tool_ledger',
    subjectId: tool.id,
    after: { toolNo, name, lifeUom, ratedLife, warningThreshold, expirePolicy, configVersion: 1 },
    reason: str(p, 'reason') ?? null,
  })
  return { toolId: tool.id, toolNo, configVersion: 1, accumulatedLife: tool.accumulatedLife }
}

async function toolConfigRevise(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.tool.config-revise')
  await assertPlantScope(tools, plantId)
  const toolId = requireStr(p, 'toolId', 'spc.tool.config-revise')
  const lifeUom = str(p, 'lifeUom') ?? ''
  const ratedLife = dec(p, 'ratedLife')
  const warningThreshold = dec(p, 'warningThreshold')
  const expirePolicy = str(p, 'expirePolicy') ?? ''
  if (ratedLife === undefined || warningThreshold === undefined) {
    throw new SpcRuleViolation('PE-20', 'ratedLife/warningThreshold 必须为十进制定点字符串（≤4 位小数）')
  }
  const tool = await tools.spc.tools.lockById(toolId)
  if (tool === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '工具台账不存在')
  if (tool.plantId !== plantId) throw new SpcRuleViolation('A-S1', '工具不在目标工厂')
  // PE-20：版本化配置——新配置走 v+1 版本行（历史版本 append-only 留痕）
  const versions = (await tools.spc.toolConfigs.listByTool(toolId)).map((r) => r.version)
  const nextVersion = nextToolConfigVersion(versions)
  assertToolConfigShape({ lifeUom, ratedLife, warningThreshold, expirePolicy, version: nextVersion })
  const updated = await tools.spc.tools.applyConfig(
    toolId,
    {
      configVersion: nextVersion,
      lifeUom: lifeUom as 'count' | 'meters' | 'hours',
      ratedLife,
      warningThreshold,
      expirePolicy: expirePolicy as 'block' | 'degrade',
    },
    c.ctx.actorLoginName,
  )
  await tools.spc.toolConfigs.insert({
    toolId,
    version: nextVersion,
    lifeUom: lifeUom as 'count' | 'meters' | 'hours',
    ratedLife,
    warningThreshold,
    expirePolicy: expirePolicy as 'block' | 'degrade',
    effectiveAt: c.businessTime,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.tool.config-revise',
    subjectType: 'spc_tool_ledger',
    subjectId: toolId,
    before: { configVersion: tool.configVersion, ratedLife: tool.ratedLife, warningThreshold: tool.warningThreshold },
    after: { configVersion: nextVersion, lifeUom, ratedLife, warningThreshold, expirePolicy },
    reason: str(p, 'reason') ?? null,
  })
  return { toolId, configVersion: updated?.configVersion ?? nextVersion, ratedLife, warningThreshold, expirePolicy }
}

async function toolConsume(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.tool.consume')
  await assertPlantScope(tools, plantId)
  const toolId = requireStr(p, 'toolId', 'spc.tool.consume')
  const source = str(p, 'source') ?? ''
  const quantity = dec(p, 'quantity')
  if (quantity === undefined) throw new SpcRuleViolation('PE-20', 'quantity 必须为十进制定点字符串（≤4 位小数）')
  const refType = requireStr(p, 'refType', 'spc.tool.consume')
  const refId = requireStr(p, 'refId', 'spc.tool.consume')
  assertToolConsumption({ quantity, source, refType, refId })
  const tool = await tools.spc.tools.lockById(toolId)
  if (tool === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '工具台账不存在')
  if (tool.plantId !== plantId) throw new SpcRuleViolation('A-S1', '工具不在目标工厂')
  // PE-21/PE-S5：累计列只增（库级守卫双保险）；消耗行 append-only
  const updated = await tools.spc.tools.addConsumption(toolId, quantity, c.ctx.actorLoginName)
  const usage = await tools.spc.toolUsages.insert({
    toolId,
    source: source as 'work_report_output' | 'collected_sample',
    quantity,
    refType,
    refId,
    commandReceiptId: c.commandReceiptId,
    plantId,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.tool.consume',
    subjectType: 'spc_tool_ledger',
    subjectId: toolId,
    before: { accumulatedLife: tool.accumulatedLife },
    after: { accumulatedLife: updated?.accumulatedLife ?? tool.accumulatedLife, source, quantity, refType, refId },
    reason: str(p, 'reason') ?? null,
  })
  return {
    toolId,
    usageId: usage.id,
    accumulatedLife: updated?.accumulatedLife ?? tool.accumulatedLife,
    source,
    quantity,
  }
}

async function toolAdjust(c: Ctx, p: Payload): Promise<Record<string, unknown>> {
  const tools = c.tools
  const plantId = requireStr(p, 'plantId', 'spc.tool.adjust')
  await assertPlantScope(tools, plantId)
  const toolId = requireStr(p, 'toolId', 'spc.tool.adjust')
  const delta = dec(p, 'delta')
  if (delta === undefined) throw new SpcRuleViolation('PE-21', 'delta 必须为十进制定点字符串（≤4 位小数）')
  const reason = requireStr(p, 'reason', 'spc.tool.adjust')
  assertNamedAdjustment({ delta, reason })
  const tool = await tools.spc.tools.lockById(toolId)
  if (tool === null) throw new SpcRuleViolation(NOT_FOUND_RULE, '工具台账不存在')
  if (tool.plantId !== plantId) throw new SpcRuleViolation('A-S1', '工具不在目标工厂')
  // PE-21：修正走具名调整（理由＋审计）；调整审计行独立，累计列不静默重置
  const adjustment = await tools.spc.toolAdjustments.insert({
    toolId,
    delta,
    reason,
    commandReceiptId: c.commandReceiptId,
    enterpriseId: c.ctx.enterpriseId,
    createdBy: c.ctx.actorLoginName,
  })
  const adjustmentSum = await tools.spc.toolAdjustments.sumByTool(toolId)
  await tools.audit.record({
    actor: c.ctx.actorLoginName,
    action: 'spc.tool.adjust',
    subjectType: 'spc_tool_ledger',
    subjectId: toolId,
    before: { accumulatedLife: tool.accumulatedLife },
    after: { adjustmentId: adjustment.id, delta, reason, adjustmentSum },
    reason,
  })
  return { toolId, adjustmentId: adjustment.id, delta, adjustmentSum, accumulatedLife: tool.accumulatedLife }
}

// ---------------- 处理器装配 ----------------

type SpcHandlerFn = (c: Ctx, p: Payload) => Promise<Record<string, unknown>>

/** 命令处理器清单（组合根装配进 PgCommandBus）。 */
export function createSpcCommandHandlers(): CommandHandler[] {
  const make = (commandType: string, fn: SpcHandlerFn): CommandHandler => ({
    commandType,
    handle: (envelope, ctx, tools): Promise<HandlerOutcome> =>
      run(async () => {
        const spcTools = tools as SpcCommandTools // 组合根构造的工具集窄化（见 spc.composition）
        const payload = (envelope.payload ?? {}) as Payload
        const spcCtx = await buildSpcContext(spcTools, ctx, commandType, envelope.operationId)
        return fn({ ...spcCtx, ctx }, payload)
      }),
  })

  return [
    make('spc.change.create', changeCreate),
    make('spc.change.scan', changeScan),
    make('spc.change.disposition', changeDisposition),
    make('spc.change.publish', changePublish),
    make('spc.rule-set.create', ruleSetCreate),
    make('spc.rule-set.publish', ruleSetPublish),
    make('spc.control-item.create', controlItemCreate),
    make('spc.control-limit.recalc', controlLimitRecalc),
    make('spc.sample.record', sampleRecord),
    make('spc.ooc.dispose', oocDispose),
    make('spc.ooc.confirm-recontrol', oocConfirmRecontrol),
    make('spc.gauge.register', gaugeRegister),
    make('spc.calibration.record', calibrationRecord),
    make('spc.miscalibration.action', miscalibrationAction),
    make('spc.tool.register', toolRegister),
    make('spc.tool.config-revise', toolConfigRevise),
    make('spc.tool.consume', toolConsume),
    make('spc.tool.adjust', toolAdjust),
  ]
}
