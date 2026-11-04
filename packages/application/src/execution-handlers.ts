import { ERROR_CODES } from '@cadenza/contracts'
import {
  OrgRuleViolation,
  InventoryRuleViolation,
  isPlantInScope,
  buildPostingLine,
  zeroBalanceDisposition,
  assertEdgeEndpoints,
  addQty,
  cmpQty,
  sumQty,
  negateQty,
  isPositiveQty,
  isValidQuantityString,
} from '@cadenza/domain'
import type { CommandHandler, CommandTools, HandlerOutcome } from './command-bus'
import { assertObjectWriteScope } from './object-scope-repositories'
import type { InventoryCommandTools } from './inventory-repositories'
import type { InventoryUnitRecord, StockBalanceRecord } from './inventory-repositories'
import { buildPostingContext, bindPostingCalendar, shiftDateForPlant, receiveGoods, issueMaterial, type PostingContext } from './inventory-posting'
import type {
  ExecutionCommandTools,
  ExecutionConfig,
  ExecutionSessionRecord,
  NewReportOutput,
  NewMaterialConsumption,
  MaterialConsumptionRecord,
  ProductionReportRecord,
  ReportOutputRecord,
} from './execution-repositories'
import type { ProductionOrderRecord, OrderOperationRecord } from './process-repositories'
// L0 整合步（Wave5）：domain index 已导出 './execution'；改包名导入（原 dist 相对导入 + eslint-disable 删除）。
import {
  ExecutionRuleViolation,
  assertReportContext,
  assertDraftIsolationAllowed,
  assertNoCrossSourceOpenDraft,
  assertDraftOperationLocked,
  assertOperationReady,
  resolveLastNonQcOperation,
  decideReviewOutcome,
  assertReviewTransitionAllowed,
  shouldPushLastOperationOutput,
  assertReportOverrunLimit,
  assertFeedCodeAdmission,
  assertCrossOrderFeedAuthorized,
  assertSalesLineFeedWithinRemainder,
  assertFeedOperationSelectable,
  assertReportEditable,
  assertReportDeletable,
  assertReviewCancellable,
  reviewCancelTransition,
  assertCorrectionReference,
  assertReportBusinessTimeEditable,
  assertNoEmptyBarcodeForSubmit,
  EXECUTION_PERMISSIONS,
} from '@cadenza/domain'

/**
 * execution 域命令处理器（T10 三入口报工 + T11 投料；全部在命令总线事务内运行）。
 *
 * 规则来源：咨询底稿 03-production-chain-rules-T05T09T10T11.md 的 A5/A6/A7 节 + D 节
 * （本域尚无冻结合同，逐条对照见 delivery/L1/server-execution/DELIVERY.md §6）。
 *
 * 命令面（8）：
 * - execution.session.save 保存草稿/续作（[底稿 A6-2] 隔离键/互斥/锁工序）；
 * - execution.report.submit 提交（事务：就绪+超产校验 → 投料扣减 → 写入 → 自动审核者经
 *   inventory 记账产出转线边库 + 回写订单完成数量 + Outbox 末道产出推送，[底稿 A5/A6]）；
 * - execution.report.review 人工审核（[底稿 A6-4/A6-5] 统一动作）；
 * - execution.report.review.cancel 取消审核（守卫+逆操作，[底稿 A6-6/K18]）；
 * - execution.report.update 编辑（不改审核态，[底稿 A6-6]）；
 * - execution.report.delete 删除（仅待审且码未动，[底稿 A6-6/K15]）；
 * - execution.feed.submit 单独投料提交（事务：锁单元→实时余量→consume 记扣前扣后→
 *   谱系边→SAP 投料日志 Outbox，[底稿 A7]）；
 * - execution.labor.record 工时记录。
 *
 * 三入口同规则（证据①）：order/workbench/scan 三来源共用 ensureDraft/submit 单一服务端路径，
 * 来源仅影响 ReportContext 形态校验与扫码默认工序解析，规则面零分叉。
 */

type Payload = Record<string, unknown>

function bad(message: string, errorCode: string = ERROR_CODES.BUSINESS_RULE): HandlerOutcome {
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: message }
}

class Rejection extends Error {
  constructor(readonly outcome: HandlerOutcome) {
    super(outcome.errorMessage ?? '业务拒绝')
    this.name = 'ExecutionRejection'
  }
}

function violationOutcome(error: ExecutionRuleViolation | OrgRuleViolation | InventoryRuleViolation): HandlerOutcome {
  let errorCode: string = ERROR_CODES.BUSINESS_RULE
  if (error instanceof OrgRuleViolation) {
    errorCode = ERROR_CODES.FORBIDDEN_SCOPE
  } else if (error instanceof InventoryRuleViolation) {
    // inventory 记账服务的余量/预留拒绝映射（IT-14/15/30→余量 409；IT-S1→范围 403；其余业务 422）
    if (error.rule === 'IT-14' || error.rule === 'IT-15' || error.rule === 'IT-30') {
      errorCode = ERROR_CODES.INSUFFICIENT_STOCK
    } else if (error.rule === 'IT-S1') {
      errorCode = ERROR_CODES.FORBIDDEN_SCOPE
    }
  }
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<HandlerOutcome>): Promise<HandlerOutcome> {
  try {
    return await body()
  } catch (error) {
    if (error instanceof Rejection) return error.outcome
    if (
      error instanceof ExecutionRuleViolation ||
      error instanceof OrgRuleViolation ||
      error instanceof InventoryRuleViolation
    ) {
      return violationOutcome(error)
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

function bool(p: Payload, key: string): boolean | undefined {
  const v = p[key]
  return typeof v === 'boolean' ? v : undefined
}

function requireStr(p: Payload, key: string, command: string): string {
  const v = str(p, key)
  if (v === undefined) throw new Rejection(bad(`${command}：载荷缺少必填字段 ${key}`))
  return v
}

function requireDec(p: Payload, key: string, command: string): string {
  const v = dec(p, key)
  if (v === undefined) {
    throw new Rejection(bad(`${command}：数量字段 ${key} 必须为十进制定点字符串（≤4 位小数）`))
  }
  return v
}

/** 取 execution 工具集（组合根装配的 CommandTools 超集）。 */
function ex(tools: CommandTools): ExecutionCommandTools {
  return tools as ExecutionCommandTools
}

/** [D4] 写路径范围二道防线：目标厂须在 actor 数据范围内（OA-24/26 模式）。 */
async function assertWriteScope(tools: CommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!isPlantInScope(scope, plantId)) {
    throw new OrgRuleViolation('OA-24', '目标工厂不在授权数据范围内（服务端范围检查）')
  }
}

/** [D4] 许可二道防线（HTTP 守卫首检后服务端复核）。 */
async function requirePermission(tools: CommandTools, permission: string): Promise<void> {
  const permissions = await tools.actorPermissions()
  if (!permissions.includes(permission)) {
    throw new Rejection(bad(`缺少岗位操作许可 ${permission}`, ERROR_CODES.FORBIDDEN_SCOPE))
  }
}

interface ActorContext {
  enterpriseId: string
  actorUserId: string
  actorLoginName: string
}

/** [D4] 操作工仅自己：载荷指定的操作者 ≠ actor 时须持审核许可（班组长+）。 */
async function resolveOperator(
  tools: CommandTools,
  ctx: ActorContext,
  p: Payload,
): Promise<{ operatorUserId: string; operatorLogin: string }> {
  const requested = str(p, 'operatorUserId')
  if (requested === undefined || requested === ctx.actorUserId) {
    return { operatorUserId: ctx.actorUserId, operatorLogin: ctx.actorLoginName }
  }
  const permissions = await tools.actorPermissions()
  if (!permissions.includes(EXECUTION_PERMISSIONS.review)) {
    throw new Rejection(
      bad(
        '[D4] 操作工仅自己参与报工/投料（代他人操作须持 execution.review 许可）',
        ERROR_CODES.FORBIDDEN_SCOPE,
      ),
    )
  }
  const user = await tools.users.findById(requested)
  if (user === null || user.enterpriseId !== ctx.enterpriseId) {
    throw new Rejection(bad('载荷指定的操作者不存在或不属于本企业', ERROR_CODES.NOT_FOUND))
  }
  return { operatorUserId: requested, operatorLogin: user.loginName }
}

/** 订单工序行（当前设置版本）+ 质检标志（质检判定=生产部门 ∈ 配置质检部门清单，[合同新造]）。 */
interface OpRow {
  record: OrderOperationRecord
  isQc: boolean
}

async function loadOperations(tools: CommandTools, orderId: string, settingsVersion: number): Promise<OpRow[]> {
  const config = ex(tools).config
  const rows = await ex(tools).process.orderOperations.listCurrentByOrder(orderId, settingsVersion)
  return rows.map((record) => ({ record, isQc: config.qcDeptIds.includes(record.productionDeptId) }))
}

function readinessOps(ops: readonly OpRow[]): Array<{ seq: number; isQc: boolean; productionDeptId: string | null }> {
  return ops.map((o) => ({ seq: o.record.seq, isQc: o.isQc, productionDeptId: o.record.productionDeptId }))
}

// ---------------- 载荷行解析 ----------------

interface OutputLinePayload {
  quantity: string
  qualifiedQty: string
  uomId: string
  uomCode: string
  carrierCode: string | null
  targetLocationId: string
  targetLocationCode: string
  ownerId: string
  ownerName: string
  measurementBasis: string
}

/** 产出行校验（[底稿 A6-5/A5-2]：数量+单位+载体码+目标库位；同单位；空码拦截在提交）。 */
function parseOutputLines(
  p: Payload,
  order: ProductionOrderRecord,
  config: ExecutionConfig,
  command: string,
): OutputLinePayload[] {
  const raw = p['outputs']
  if (!Array.isArray(raw) || raw.length === 0) return []
  return raw.map((item, index) => {
    const line = (item ?? {}) as Payload
    const quantity = requireDec(line, 'quantity', `${command}.outputs[${index}]`)
    if (!isPositiveQty(quantity)) {
      throw new Rejection(bad(`${command}.outputs[${index}] 产出数量必须大于 0`))
    }
    const qualifiedRaw = dec(line, 'qualifiedQty') ?? quantity
    if (cmpQty(qualifiedRaw, quantity) > 0) {
      throw new Rejection(bad(`${command}.outputs[${index}] 合格数量不得大于产出数量`))
    }
    const uomCode = requireStr(line, 'uomCode', `${command}.outputs[${index}]`)
    // [底稿 A5-2] 服务端同单位：产出单位必须与订单生产单位一致（件数/盘数与长度/重量不可互相覆盖）
    if (uomCode !== order.uom) {
      throw new Rejection(
        bad(`[A5-2] 产出单位 ${uomCode} 与订单生产单位 ${order.uom} 不一致（超产/五量须同单位），拒绝`),
      )
    }
    const targetLocationId = requireStr(line, 'targetLocationId', `${command}.outputs[${index}]`)
    const targetLocationCode = requireStr(line, 'targetLocationCode', `${command}.outputs[${index}]`)
    // [底稿 A6-5] 产出转所选线边库：末道成品线边库/其余半成品线边库的细分档案未落库，
    // P1 以载荷显式目标库位承载（GAP 登记；原配置线边库清单校验已随 D-1 修复移除——
    // 线边判定统一走仓库类型主数据事实，见 admitFeedLine）。
    const ownerId = str(line, 'ownerId') ?? config.defaultOwnerId ?? null
    const ownerName = str(line, 'ownerName') ?? config.defaultOwnerName ?? null
    if (ownerId === null || ownerName === null) {
      throw new Rejection(bad(`${command}.outputs[${index}] 需要 ownerId/ownerName（或配置默认所有者）`))
    }
    return {
      quantity,
      qualifiedQty: qualifiedRaw,
      uomId: requireStr(line, 'uomId', `${command}.outputs[${index}]`),
      uomCode,
      carrierCode: str(line, 'carrierCode') ?? null,
      targetLocationId,
      targetLocationCode,
      ownerId,
      ownerName,
      measurementBasis: str(line, 'measurementBasis') ?? 'nominal',
    }
  })
}

function toNewOutputs(
  lines: readonly OutputLinePayload[],
  report: { id: string; enterpriseId: string; plantId: string },
  actor: string,
): NewReportOutput[] {
  return lines.map((line, i) => ({
    reportId: report.id,
    lineNo: i + 1,
    quantity: line.quantity,
    qualifiedQty: line.qualifiedQty,
    uomId: line.uomId,
    uomCode: line.uomCode,
    carrierCode: line.carrierCode,
    targetLocationId: line.targetLocationId,
    targetLocationCode: line.targetLocationCode,
    ownerId: line.ownerId,
    ownerName: line.ownerName,
    measurementBasis: line.measurementBasis,
    enterpriseId: report.enterpriseId,
    plantId: report.plantId,
    createdBy: actor,
  }))
}

/** 投料意图行（草稿快照与提交载荷共用形状）。 */
interface FeedLinePayload {
  unitId?: string
  barcodeValue?: string
  quantity: string
  salesOrderNo?: string
  salesLineNo?: string
  crossOrder?: boolean
  confirmed?: boolean
  deviationReason?: string | null
  locationId?: string
  ownerId?: string
}

function parseFeedLines(p: Payload, command: string): FeedLinePayload[] {
  const raw = p['feeds'] ?? p['lines']
  if (!Array.isArray(raw)) return []
  return raw.map((item, index) => {
    const line = (item ?? {}) as Payload
    const quantity = requireDec(line, 'quantity', `${command} 行 ${index}`)
    if (!isPositiveQty(quantity)) {
      throw new Rejection(bad(`${command} 行 ${index} 投料数量必须大于 0`))
    }
    const unitId = str(line, 'unitId')
    const barcodeValue = str(line, 'barcodeValue')
    if (unitId === undefined && barcodeValue === undefined) {
      throw new Rejection(bad(`${command} 行 ${index} 需要 unitId 或 barcodeValue`))
    }
    return {
      unitId,
      barcodeValue,
      quantity,
      salesOrderNo: str(line, 'salesOrderNo'),
      salesLineNo: str(line, 'salesLineNo'),
      crossOrder: bool(line, 'crossOrder'),
      confirmed: bool(line, 'confirmed'),
      deviationReason: str(line, 'deviationReason') ?? null,
      locationId: str(line, 'locationId'),
      ownerId: str(line, 'ownerId'),
    }
  })
}

// ---------------- 投料执行（[底稿 A7] 单一服务端路径：报工投料与单独投料共用） ----------------

interface FeedExecutionContext {
  tools: ExecutionCommandTools
  ctx: ActorContext
  pc: PostingContext
  order: ProductionOrderRecord
  operation: OrderOperationRecord
  /** 报工投料携带 reportId；单独投料为 null。 */
  reportId: string | null
}

/** 组装单行码准入事实并执行链校验 + 实时扣减（[底稿 A7-2/A7-3/A7-4]）。 */
/** 准入通过后的投料行执行上下文（第一阶段校验产物；第二阶段逐行扣减消费）。 */
interface AdmittedFeedLine {
  line: FeedLinePayload
  unitId: string
  unitNo: string
  isCrossOrder: boolean
  deviationReason: string | null
  issuedLocationId: string | null
  issuedLocationCode: string | null
  issuedOwnerId: string | null
  uomId: string
  uomCode: string
}

/** Resolve all submitted barcodes, then acquire stock locks in stable order. */
async function lockFeedSources(tools: ExecutionCommandTools, lines: FeedLinePayload[]): Promise<FeedLinePayload[]> {
  const resolved: FeedLinePayload[] = []
  for (const line of lines) {
    let unitId = line.unitId
    if (line.barcodeValue !== undefined) {
      const binding = await tools.inv.barcodes.findActiveBindingByValue(line.barcodeValue)
      if (binding === null || binding.boundType !== 'inventory_unit' || (unitId !== undefined && unitId !== binding.boundId)) {
        throw new Rejection(bad('[A7-2] 产品轴码与实际库存单元绑定不一致'))
      }
      unitId = binding.boundId
    }
    if (!unitId) throw new Rejection(bad('[A7-2] 投料行缺少实际库存单元'))
    resolved.push({ ...line, unitId })
  }
  await tools.inv.units.lockForUpdate([...new Set(resolved.map(l => l.unitId!))].sort())
  return resolved
}

/** 阶段一：逐行码准入链 + 跨订单偏离 + 销售行汇总校验（零写入；一批全过才进入扣减）。 */
async function admitFeedLine(
  ec: FeedExecutionContext,
  line: FeedLinePayload,
  remainders: Map<string, string>,
): Promise<AdmittedFeedLine> {
  const { tools, order, operation } = ec
  const inv = tools.inv
  const config = tools.config

  // 单元解析：unitId 直取；条码走产品轴码 + 活动绑定（一码多物显式拒绝，K07 空码先拦）
  let unitId = line.unitId ?? null
  if (line.barcodeValue !== undefined) {
    const active = await inv.barcodes.findActiveBindingByValue(line.barcodeValue)
    if (active === null || active.boundType !== 'inventory_unit' || (unitId !== null && unitId !== active.boundId)) {
      throw new Rejection(
        bad(`[A7-2] 码 ${line.barcodeValue} 无活动库存单元绑定（托码/未绑定码拒绝）`, ERROR_CODES.NOT_FOUND),
      )
    }
    unitId = active.boundId
  }
  if (unitId === null) {
    throw new Rejection(bad('投料行缺少库存单元（unitId/barcodeValue 解析失败）'))
  }

  const unit = (await inv.units.lockForUpdate([unitId]))[0] ?? null
  if (unit === null || unit.plantId !== order.plantId || unit.enterpriseId !== order.enterpriseId) {
    throw new Rejection(bad('投料库存单元不存在或不属于订单所在工厂', ERROR_CODES.NOT_FOUND))
  }
  const balances = (await inv.balances.listActiveByUnit(unit.id)).filter((b) => b.status === 'active')
  const activeBalance = balances.length >= 1 ? balances[0]! : null
  const availableQty = sumQty(balances.map((b) => b.quantity))
  const material = await tools.process.lookups.findMaterial(unit.materialId)

  // 产出归属事实（「非本工序产出 / 本订单前道产出」判定输入）
  const origins = await tools.execution.outputs.originReportsForUnit(unit.id)
  const classified: Array<{ sameOrder: boolean; seq: number; sameOperation: boolean }> = []
  const salesOrigins = new Map<string, { salesOrderNo: string; salesLineNo: string }>()
  let unknownSalesOrigin = origins.length === 0
  for (const origin of origins) {
    if (origin.reportId === null) { unknownSalesOrigin = true; classified.push({sameOrder:false,seq:0,sameOperation:false}); continue }
    const productionReport = await tools.execution.reports.findById(origin.reportId)
    if (productionReport === null) { unknownSalesOrigin = true; classified.push({sameOrder:false,seq:0,sameOperation:false}); continue }
    let originOrderId=productionReport.orderId, originOperationId=productionReport.orderOperationId, originSeq=productionReport.operationSeq
    const producingOrder=await tools.process.orders.findById(originOrderId)
    const stage=producingOrder?.materialSnapshot['_cadenzaStageParent']
    if (typeof stage==='object' && stage!==null && !Array.isArray(stage)) {
      const parent=stage as Record<string,unknown>
      if (parent['source']==='PROCESS_RECEIVE_VERIFIED_STAGE' && parent['enterpriseId']===order.enterpriseId &&
          parent['plantId']===order.plantId && parent['parentOrderId']===order.id && parent['parentSettingsVersion']===order.currentSettingsVersion) {
        originOrderId=String(parent['parentOrderId']); originOperationId=String(parent['parentOperationId']); originSeq=Number(parent['parentOperationSeq'])
      }
    }
    const salesOrder = originOrderId === order.id ? order : producingOrder
    if (!salesOrder || salesOrder.enterpriseId !== order.enterpriseId || salesOrder.plantId !== order.plantId ||
        !salesOrder.salesOrderNo || !salesOrder.lineNo) unknownSalesOrigin = true
    else salesOrigins.set(JSON.stringify([salesOrder.salesOrderNo, salesOrder.lineNo]), { salesOrderNo: salesOrder.salesOrderNo, salesLineNo: salesOrder.lineNo })
    const sameOrder=originOrderId===order.id && producingOrder?.enterpriseId===order.enterpriseId && producingOrder?.plantId===order.plantId
    classified.push({sameOrder,seq:originSeq,sameOperation:sameOrder && originOperationId===operation.id})
  }
  if (unknownSalesOrigin || salesOrigins.size !== 1) {
    throw new Rejection(bad('[A7-2] 实物销售归属 UNKNOWN/多义，不能使用客户端声明补造'))
  }
  const sales = [...salesOrigins.values()][0]!
  if (line.salesOrderNo !== undefined && line.salesOrderNo !== sales.salesOrderNo ||
      line.salesLineNo !== undefined && line.salesLineNo !== sales.salesLineNo) {
    throw new Rejection(bad('[A7-2] 客户端销售单/行与实物已验证来源不一致'))
  }
  line = { ...line, ...sales }
  const producedByThisOrder=classified.length>0 && classified.every(fact=>fact.sameOrder)
  const producedByCurrentOperation=classified.some(fact=>fact.sameOperation)
  const producedByEarlierOperationOfOrder=producedByThisOrder && classified.every(fact=>fact.seq<operation.seq)
  const isCrossOrder = !producedByThisOrder

  // [合同 A7-2/底稿 A7] 线边判定（D-1 修复）：单元所在库位隶属的仓库类型=LINE_SIDE
  // （0003 主数据事实），非配置库位清单成员——空清单恒拒的配置缺陷已随 lineSideLocationIds 移除。
  const warehouseTypeByLocation = new Map<string, string | null>()
  for (const locationId of new Set(balances.map((b) => b.locationId))) {
    warehouseTypeByLocation.set(
      locationId,
      await tools.execution.masterdata.findWarehouseTypeByLocation(locationId),
    )
  }

  // [底稿 A7-2] 码准入链（链序固定；unitId 直投无码值→格式/档案步骤按已满足，条码投料逐链校验）
  assertFeedCodeAdmission({
    barcodeValue: line.barcodeValue ?? null,
    barcodeArchived: true, // 活动绑定存在即档案在册（unitId 直投路径无码值，档案步骤按已满足）
    salesOrderNo: line.salesOrderNo ?? null,
    salesLineNo: line.salesLineNo ?? null,
    qualityAdmitted: activeBalance !== null && activeBalance.qualityStatus === 'qualified',
    inStock: unit.status === 'in_stock',
    balanceExists: balances.length > 0,
    atLineSideLocation: balances.some((b) => warehouseTypeByLocation.get(b.locationId) === 'LINE_SIDE'),
    consumableMaterial:
      config.consumableMaterialTypes === null
        ? true
        : material !== null && config.consumableMaterialTypes.includes(material.materialType),
    notCurrentOperationOutput: !producedByCurrentOperation,
    acceptableOrigin: producedByThisOrder ? producedByEarlierOperationOfOrder : true,
    availableQty,
  })

  // [底稿 A7-3/S11] 跨订单授权偏离记录（非本订单来源或显式声明跨订单）
  const deviation = assertCrossOrderFeedAuthorized({
    isCrossOrder,
    confirmed: line.confirmed === true,
    reason: line.deviationReason,
  })

  // [底稿 A7-4] 按销售行汇总本次投料 ≤ 剩余（P1 以单元活动余额为销售行剩余口径；行级档案 GAP）
  if (line.salesOrderNo !== undefined && line.salesLineNo !== undefined) {
    const key = `${line.salesOrderNo}|${line.salesLineNo}`
    const remain = remainders.get(key) ?? availableQty
    assertSalesLineFeedWithinRemainder({
      lines: [{ salesOrderNo: line.salesOrderNo, salesLineNo: line.salesLineNo, quantity: line.quantity }],
      remainders: { [key]: remain },
      barcodeValue: line.barcodeValue ?? unit.unitNo,
    })
    remainders.set(key, addQty(remain, negateQty(line.quantity)))
  }

  return {
    line,
    unitId: unit.id,
    unitNo: unit.unitNo,
    isCrossOrder,
    deviationReason: deviation.deviationReason,
    issuedLocationId: activeBalance?.locationId ?? null,
    issuedLocationCode: activeBalance?.locationCode ?? null,
    issuedOwnerId: activeBalance?.ownerId ?? null,
    uomId: activeBalance?.uomId ?? unit.uomId,
    uomCode: activeBalance?.uomCode ?? unit.uomCode,
  }
}

/** 阶段二：[底稿 A7-4/K05] 实时余量校验并扣减（inventory 记账服务：锁单元→校验→流水（扣前/扣后）→余额）。 */
async function issueAdmittedFeedLine(
  ec: FeedExecutionContext,
  admitted: AdmittedFeedLine,
  lineNo: number,
): Promise<NewMaterialConsumption> {
  const { order, operation } = ec
  const result = await issueMaterial(ec.pc, {
    unitId: admitted.unitId,
    quantity: admitted.line.quantity,
    locationId: admitted.line.locationId ?? admitted.issuedLocationId,
    ownerId: admitted.line.ownerId ?? admitted.issuedOwnerId,
    reason: `execution feed ${order.id}#${String(operation.seq)}`,
    refType: 'execution_feed',
    refId: ec.reportId ?? order.id,
    lineNo,
  })
  return {
    enterpriseId: order.enterpriseId,
    plantId: order.plantId,
    orderId: order.id,
    orderOperationId: operation.id,
    operationSeq: operation.seq,
    reportId: ec.reportId,
    feedType: ec.reportId === null ? 'standalone' : 'report',
    inventoryUnitId: admitted.unitId,
    unitNo: admitted.unitNo,
    barcodeValue: admitted.line.barcodeValue ?? null,
    quantity: admitted.line.quantity,
    beforeQty: String(result['beforeQty'] ?? '0.0000'),
    afterQty: String(result['afterQty'] ?? '0.0000'),
    uomId: admitted.uomId,
    uomCode: admitted.uomCode,
    salesOrderNo: admitted.line.salesOrderNo ?? null,
    salesLineNo: admitted.line.salesLineNo ?? null,
    crossOrder: admitted.isCrossOrder,
    deviationReason: admitted.deviationReason,
    issuedLocationId: admitted.issuedLocationId,
    issuedLocationCode: admitted.issuedLocationCode,
    operatorUserId: ec.ctx.actorUserId,
    operatorLogin: ec.ctx.actorLoginName,
    businessTime: ec.pc.businessTime,
    shiftDate: ec.pc.shiftDate,
    commandReceiptId: ec.pc.commandReceiptId,
    createdBy: ec.ctx.actorLoginName,
  }
}

/** 谱系边回填：consumed 单元 → 产出单元（production_output 边，[底稿 A7-4] 谱系边）。 */
async function backfillGenealogyEdges(
  tools: ExecutionCommandTools,
  ctx: ActorContext,
  pc: PostingContext,
  orderId: string,
  orderOperationId: string,
  targetUnitId: string,
): Promise<number> {
  const unlinked = await tools.execution.feeds.listUnlinkedByOrderOperation(orderId, orderOperationId)
  let written = 0
  for (const row of unlinked) {
    assertEdgeEndpoints('production_output', 'inventory_unit', 'inventory_unit')
    await tools.inv.genealogy.insertEdge({
      fromType: 'inventory_unit',
      fromId: row.inventoryUnitId,
      toType: 'inventory_unit',
      toId: targetUnitId,
      edgeKind: 'production_output',
      quantity: row.quantity,
      uomId: row.uomId,
      uomCode: row.uomCode,
      measurementBasis: 'nominal',
      commandReceiptId: pc.commandReceiptId,
      businessTime: pc.businessTime,
      plantId: row.plantId,
      enterpriseId: row.enterpriseId,
      createdBy: ctx.actorLoginName,
    })
    await tools.execution.feeds.markGenealogyTarget(row.id, targetUnitId, ctx.actorLoginName)
    written += 1
  }
  return written
}

/** 该订单+工序最近一个已入库产出单元（单独投料即时补谱系边用）。 */
async function latestStockedOutputUnit(
  tools: ExecutionCommandTools,
  orderId: string,
  orderOperationId: string,
): Promise<string | null> {
  const reports = await tools.execution.reports.listByOrderOperation(orderId, orderOperationId)
  const approved = reports.filter(
    (r) =>
      (r.reviewStatus === 'auto_approved' || r.reviewStatus === 'manual_approved') &&
      r.reviewCancelledAt === null &&
      r.status === 'submitted',
  )
  for (let i = approved.length - 1; i >= 0; i -= 1) {
    const outputs = await tools.execution.outputs.listByReport(approved[i]!.id)
    const stocked = outputs.find((o) => o.stockUnitId !== null)
    if (stocked !== undefined) return stocked.stockUnitId
  }
  return null
}

// ---------------- 审核统一动作（[底稿 A6-5]：自动/人工审核通过后同一 Posting 路径） ----------------

async function postApproval(
  tools: ExecutionCommandTools,
  ctx: ActorContext,
  pc: PostingContext,
  report: ProductionReportRecord,
  order: ProductionOrderRecord,
  ops: readonly OpRow[],
  outputs: readonly ReportOutputRecord[],
  reviewKind: 'auto_approved' | 'manual_approved',
): Promise<{ stockedUnits: string[]; completedQtyDelta: string; pushed: boolean }> {
  const last = resolveLastNonQcOperation(readinessOps(ops))
  const isLast = last !== null && report.operationSeq === last.seq
  const stockedUnits: string[] = []
  for (const output of outputs) {
    // 产出转所选线边库：经 inventory 记账服务 receiveGoods（新单元+余额+receipt_origin 边+审计，同一 UoW）
    const result = await receiveGoods(pc, {
      plantId: order.plantId,
      quantity: output.quantity,
      uomId: output.uomId,
      uomCode: output.uomCode,
      measurementBasis: output.measurementBasis,
      locationId: output.targetLocationId,
      locationCode: output.targetLocationCode,
      ownerId: output.ownerId,
      ownerName: output.ownerName,
      lotNo: `PRDLOT-${order.id.slice(0, 8)}-${String(report.operationSeq)}`,
      materialId: order.materialId,
      materialCode: String(order.materialSnapshot['code'] ?? order.materialId),
      unitNo: `PRDU-${report.id.slice(0, 8)}-${String(output.lineNo)}`,
      barcodeValue: output.carrierCode ?? undefined,
      lineNo: output.lineNo,
      qualityStatus: 'qualified',
      reason: `execution.report 审核 ${reviewKind} 产出转线边库`,
      businessTime: pc.businessTime,
    })
    const unitId = String(result['unitId'] ?? '')
    if (unitId === '') throw new Rejection(bad('产出转线边库失败：记账服务未返回库存单元'))
    await tools.execution.outputs.updateStockUnit(output.id, unitId, ctx.actorLoginName)
    stockedUnits.push(unitId)
  }
  // 谱系边回填：consumed → 产出单元（含此前单独投料未回填行，[底稿 A7-4]）
  if (stockedUnits.length > 0) {
    await backfillGenealogyEdges(tools, ctx, pc, order.id, report.orderOperationId, stockedUnits[0]!)
  }
  // 回写订单已完成数量：仅末道非质检审核产出（[底稿 A6-5]；非末道不回写——五量展示走分立口径 A5-3）
  let completedQtyDelta = '0.0000'
  if (isLast && outputs.length > 0) {
    completedQtyDelta = sumQty(outputs.map((o) => o.quantity))
    await tools.execution.orderProgress.addCompletedQty(order.id, completedQtyDelta, ctx.actorLoginName)
  }
  // Outbox 末道产出推送任务（[底稿 A6-5/D3]：ERP 产出回传 + 上架任务；末道非质检非样品）
  const pushed = shouldPushLastOperationOutput({ isLastNonQc: isLast, orderType: order.orderType })
  if (pushed) {
    tools.outbox.collect({
      aggregateType: 'production_report',
      aggregateId: report.id,
      taskKind: 'execution.last-operation-output-push',
      payload: {
        reportId: report.id,
        orderId: order.id,
        orderNo: order.orderNo,
        operationSeq: report.operationSeq,
        quantities: outputs.map((o) => ({ quantity: o.quantity, uomCode: o.uomCode, qualifiedQty: o.qualifiedQty })),
        stockedUnits,
        businessTime: pc.businessTime,
      },
    })
  }
  await tools.execution.reports.update(
    report.id,
    { reviewStatus: reviewKind, reviewedAt: pc.businessTime, reviewedBy: ctx.actorLoginName },
    ctx.actorLoginName,
  )
  return { stockedUnits, completedQtyDelta, pushed }
}

// ---------------- 草稿 ensure（保存/续作/提交共用单一服务端路径，[底稿 A6-1/A6-2]） ----------------

interface DraftEnsureResult {
  session: ExecutionSessionRecord
  report: ProductionReportRecord
  order: ProductionOrderRecord
  ops: OpRow[]
  operation: OrderOperationRecord
  outputs: ReportOutputRecord[]
  created: boolean
}

async function resolveEntry(
  tools: CommandTools,
  ctx: ActorContext,
  p: Payload,
): Promise<{
  source: 'order' | 'workbench' | 'scan'
  operator: { operatorUserId: string; operatorLogin: string }
  order: ProductionOrderRecord
  ops: OpRow[]
  operation: OpRow
  equipmentId: string | null
  equipmentCode: string | null
  businessTime: string
  shiftDate: string
  openDrafts: ExecutionSessionRecord[]
  resume: ExecutionSessionRecord | null
  resumeReport: ProductionReportRecord | null
  resumeOutputs: ReportOutputRecord[]
}> {
  const et = ex(tools)
  const command = 'execution.session.save'
  const orderId = requireStr(p, 'orderId', command)
  const source = requireStr(p, 'source', command)
  const operator = await resolveOperator(tools, ctx, p)

  const order = await et.process.orders.findById(orderId)
  if (order === null || order.enterpriseId !== ctx.enterpriseId) {
    throw new Rejection(bad('生产订单不存在', ERROR_CODES.NOT_FOUND))
  }
  await assertWriteScope(tools, order.plantId)
  if (order.orderStatus === 'voided') {
    throw new Rejection(bad('[A6-1] 已作废订单不可报工'))
  }

  // 工序解析：显式绑定 > 扫码默认（设备+班次日期排产工序，[底稿 A6-1/03 §3.2]）
  let orderOperationId = str(p, 'orderOperationId') ?? null
  const equipmentId = str(p, 'equipmentId') ?? null
  const equipmentCode = str(p, 'equipmentCode') ?? null
  const businessTime = str(p, 'businessTime') ?? tools.now().toISOString()
  const shiftDate = await shiftDateForPlant(et, order.plantId, businessTime)
  if (orderOperationId === null && source === 'scan') {
    const scheduled = await et.schedule.listScheduledOperations({
      plantId: order.plantId,
      equipmentId: equipmentId!,
      date: shiftDate,
    })
    if (scheduled.length === 0) {
      throw new Rejection(bad('[A6-1] 扫码报工未携带工序且该设备当天班次无排产工序，无法默认绑定'))
    }
    orderOperationId = scheduled[0]!.orderOperationId
  }

  // [底稿 A6-1/K13] ReportContext 显式绑定校验
  assertReportContext({
    source,
    orderId,
    orderOperationId,
    equipmentId,
    equipmentCode,
    shiftDate,
    operatorUserId: operator.operatorUserId,
  })

  const ops = await loadOperations(tools, order.id, order.currentSettingsVersion)
  const operation = ops.find((o) => o.record.id === orderOperationId)
  if (operation === undefined) {
    throw new Rejection(bad('订单工序不存在或不在当前设置版本', ERROR_CODES.NOT_FOUND))
  }
  if (operation.isQc) {
    throw new Rejection(bad('[A6-3] 质检工序一律不可选（不可报工）'))
  }

  // [底稿 A6-2] 草稿隔离键 + 跨来源互斥（服务端权威；隔离键库层双保险见 0008）
  const openDrafts = await et.execution.sessions.listOpenByOperatorAndOrder(operator.operatorUserId, order.id)
  const draftFacts = openDrafts.map((s) => ({
    sessionId: s.id,
    source: s.source,
    orderOperationId: s.orderOperationId,
    operatorUserId: s.operatorUserId,
    orderId: s.orderId,
  }))
  assertNoCrossSourceOpenDraft({
    operatorUserId: operator.operatorUserId,
    orderId: order.id,
    source: source as 'order' | 'workbench' | 'scan',
    openDrafts: draftFacts,
  })
  const resume =
    openDrafts.find(
      (s) => s.source === source && (source !== 'workbench' || s.orderOperationId === operation.record.id),
    ) ?? null
  assertDraftIsolationAllowed({
    operatorUserId: operator.operatorUserId,
    orderId: order.id,
    source: source as 'order' | 'workbench' | 'scan',
    orderOperationId: operation.record.id,
    excludeSessionId: resume?.id ?? null,
    openDrafts: draftFacts,
  })

  const resumeReport = resume === null ? null : await et.execution.reports.findBySessionId(resume.id)
  const resumeOutputs =
    resumeReport === null ? [] : await et.execution.outputs.listByReport(resumeReport.id)
  // [底稿 A6-2] 草稿续作：带出产出/托码/库位/备注并锁工序（已有产出的草稿不可换工序）
  assertDraftOperationLocked({
    currentOperationId: resume?.orderOperationId ?? null,
    requestedOperationId: operation.record.id,
    hasOutputs: resumeOutputs.length > 0,
  })
  // [底稿 A6-6] 更正引用校验（更正单引用同订单同工序原单）
  const correctionOf = str(p, 'correctionOf') ?? resumeReport?.correctionOf ?? null
  if (correctionOf !== null) {
    const original = await et.execution.reports.findById(correctionOf)
    assertCorrectionReference({
      correctionOf,
      original:
        original === null
          ? null
          : { id: original.id, orderId: original.orderId, orderOperationId: original.orderOperationId },
      newOrderId: order.id,
      newOrderOperationId: operation.record.id,
    })
  }

  return {
    source: source as 'order' | 'workbench' | 'scan',
    operator,
    order,
    ops,
    operation,
    equipmentId,
    equipmentCode,
    businessTime,
    shiftDate,
    openDrafts,
    resume,
    resumeReport,
    resumeOutputs,
  }
}

async function ensureDraft(
  tools: CommandTools,
  ctx: ActorContext,
  p: Payload,
): Promise<DraftEnsureResult> {
  const et = ex(tools)
  const command = 'execution.session.save'
  // ---- 校验阶段（零写入：业务拒绝不得残留草稿——命令总线对拒绝结果同样 COMMIT 回执）----
  const entry = await resolveEntry(tools, ctx, p)
  const outputLines = parseOutputLines(p, entry.order, et.config, command) // 解析失败在校验阶段抛出
  const feedLines = parseFeedLines(p, command)

  // ---- 写入阶段（隔离键/互斥/锁工序/更正引用已全部通过）----
  const { order, operation, operator } = entry
  let session: ExecutionSessionRecord
  let report: ProductionReportRecord
  let created = false
  if (entry.resume === null) {
    session = await et.execution.sessions.insert({
      enterpriseId: ctx.enterpriseId,
      plantId: order.plantId,
      orderId: order.id,
      source: entry.source,
      orderOperationId: operation.record.id,
      operationSeq: operation.record.seq,
      equipmentId: entry.equipmentId,
      equipmentCode: entry.equipmentCode,
      operatorUserId: operator.operatorUserId,
      operatorLogin: operator.operatorLogin,
      shiftDate: entry.shiftDate,
      businessTime: entry.businessTime,
      draftFeeds: feedLines,
      remark: str(p, 'remark') ?? null,
      createdBy: ctx.actorLoginName,
    })
    report = await et.execution.reports.insert({
      enterpriseId: ctx.enterpriseId,
      plantId: order.plantId,
      sessionId: session.id,
      orderId: order.id,
      orderOperationId: operation.record.id,
      operationSeq: operation.record.seq,
      source: entry.source,
      status: 'draft',
      reviewStatus: 'pending_review',
      operatorUserId: operator.operatorUserId,
      operatorLogin: operator.operatorLogin,
      businessTime: entry.businessTime,
      shiftDate: entry.shiftDate,
      equipmentId: entry.equipmentId,
      equipmentCode: entry.equipmentCode,
      correctionOf: str(p, 'correctionOf') ?? null,
      remark: str(p, 'remark') ?? null,
      createdBy: ctx.actorLoginName,
    })
    created = true
  } else {
    session = (await et.execution.sessions.update(
      entry.resume.id,
      {
        orderOperationId: operation.record.id,
        operationSeq: operation.record.seq,
        equipmentId: entry.equipmentId ?? entry.resume.equipmentId,
        equipmentCode: entry.equipmentCode ?? entry.resume.equipmentCode,
        shiftDate: entry.shiftDate,
        businessTime: entry.businessTime,
        draftFeeds: p['feeds'] !== undefined ? feedLines : entry.resume.draftFeeds,
        remark: str(p, 'remark') ?? entry.resume.remark,
      },
      ctx.actorLoginName,
    )) ?? entry.resume
    report = entry.resumeReport!
    report = (await et.execution.reports.update(
      report.id,
      {
        businessTime: entry.businessTime,
        shiftDate: entry.shiftDate,
        remark: str(p, 'remark') ?? report.remark,
        operatorUserId: operator.operatorUserId,
        operatorLogin: operator.operatorLogin,
      },
      ctx.actorLoginName,
    )) ?? report
  }

  // 产出行：草稿整集替换（保存即快照；提交读库为准——单一事实源）
  if (created) {
    if (outputLines.length > 0) {
      await et.execution.outputs.insertBatch(toNewOutputs(outputLines, report, ctx.actorLoginName))
    }
  } else if (p['outputs'] !== undefined) {
    await et.execution.outputs.replaceDraftOutputs(
      report.id,
      toNewOutputs(outputLines, report, ctx.actorLoginName),
      ctx.actorLoginName,
    )
  }
  const outputs = await et.execution.outputs.listByReport(report.id)

  // [底稿 A6-1/K15] 一张报工单只存一道工序：报工单/产出行/投料行共享唯一工序绑定
  // （production_report.order_operation_id NOT NULL + 会话 1:1，结构性保证，见 0008）。

  return { session, report, order, ops: entry.ops, operation: operation.record, outputs, created }
}

/** 订单+工序的既有报工产出合计（[底稿 A5-1]：含未提交草稿；剔除已删除与已撤审单）。 */
async function reportedTotalForOperation(
  tools: ExecutionCommandTools,
  orderId: string,
  orderOperationId: string,
  excludeReportId: string | null,
): Promise<string> {
  const reports = await tools.execution.reports.listByOrderOperation(orderId, orderOperationId)
  const counted = reports.filter(
    (r) => r.status !== 'deleted' && r.reviewCancelledAt === null && r.id !== excludeReportId,
  )
  if (counted.length === 0) return '0.0000'
  const outputs = await tools.execution.outputs.listByOrder(orderId)
  const byReport = new Map<string, string[]>()
  for (const o of outputs) {
    const list = byReport.get(o.reportId) ?? []
    list.push(o.quantity)
    byReport.set(o.reportId, list)
  }
  const totals: string[] = []
  for (const r of counted) {
    const quantities = byReport.get(r.id)
    if (quantities !== undefined && quantities.length > 0) totals.push(sumQty(quantities))
  }
  return totals.length === 0 ? '0.0000' : sumQty(totals)
}

/** 订单报工事实（就绪判定输入：已提交且有产出）。 */
async function readinessReportFacts(tools: ExecutionCommandTools, orderId: string) {
  const reports = await tools.execution.reports.listByOrder(orderId)
  const outputs = await tools.execution.outputs.listByOrder(orderId)
  const outputsByReport = new Map<string, number>()
  for (const o of outputs) {
    outputsByReport.set(o.reportId, (outputsByReport.get(o.reportId) ?? 0) + 1)
  }
  const direct = reports
    .filter((r) => r.status === 'submitted' && r.reviewCancelledAt === null)
    .map((r) => ({
      seq: r.operationSeq,
      submitted: true,
      hasOutput: (outputsByReport.get(r.id) ?? 0) > 0,
    }))
  return [...direct,...await tools.execution.outputs.listStageReadiness(orderId)]
}

/** 提交前置校验集（直提路径在落稿前全部完成：拒绝不残留草稿；[底稿 A5-1/A6-3/K07]）。 */
async function assertSubmitPreconditions(input: {
  tools: ExecutionCommandTools
  order: ProductionOrderRecord
  ops: readonly OpRow[]
  operation: OpRow
  incomingQty: string
  excludeReportId: string | null
  payload: Payload
}): Promise<void> {
  const { tools, order, ops, operation } = input
  // [底稿 A6-3] 订单执行态前置：开工后才能报工（挂起拦截）
  if (order.orderStatus !== 'in_progress') {
    throw new Rejection(bad(`[A6-3] 订单状态 ${order.orderStatus} 不可报工（须进行中）`))
  }
  if (order.suspended) {
    throw new Rejection(bad('[A6-3] 订单处于挂起状态，不可报工'))
  }
  // [底稿 A6-3/K13] 三入口共用的就绪判定（单一服务端规则）
  await assertOperationReady({
    operations: readinessOps(ops),
    reports: await readinessReportFacts(tools, order.id),
    targetSeq: operation.record.seq,
  })
  // [底稿 A6-6/K07] 空码不能提交
  const outputRows = Array.isArray(input.payload['outputs']) ? (input.payload['outputs'] as Payload[]) : []
  const feedRows = Array.isArray(input.payload['feeds']) ? (input.payload['feeds'] as Payload[]) : []
  assertNoEmptyBarcodeForSubmit({
    barcodeValues: [
      ...outputRows.map((o) => str(o, 'carrierCode') ?? null),
      ...feedRows.map((f) => str(f, 'barcodeValue') ?? null),
    ],
  })
  // [底稿 A5-1/A5-2] 末道非质检超产硬限（含未提交草稿；服务端同单位）
  const last = resolveLastNonQcOperation(readinessOps(ops))
  if (last !== null && operation.record.seq === last.seq) {
    const existing = await reportedTotalForOperation(tools, order.id, operation.record.id, input.excludeReportId)
    assertReportOverrunLimit({
      plannedQty: order.productionQty,
      overrunRatio: order.overrunRatio ?? tools.config.defaultOverrunRatio,
      existingReportedTotal: existing,
      incomingQty: input.incomingQty,
      uom: order.uom,
      existingUom: order.uom,
      plannedUom: order.uom,
    })
  }
}

// ---------------- 命令处理器 ----------------

export function createExecutionCommandHandlers(): CommandHandler[] {
  /** execution.session.save —— 保存草稿/续作（[底稿 A6-1/A6-2]）。 */
  const sessionSave: CommandHandler = {
    commandType: 'execution.session.save',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        await requirePermission(tools, EXECUTION_PERMISSIONS.report)
        const result = await ensureDraft(tools, ctx, envelope.payload as Payload)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'execution.session.save',
          subjectType: 'execution_session',
          subjectId: result.session.id,
          after: {
            orderId: result.order.id,
            source: result.session.source,
            operationSeq: result.operation.seq,
            outputCount: result.outputs.length,
          },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'DRAFT_SAVED',
          data: {
            sessionId: result.session.id,
            reportId: result.report.id,
            lockedOperationId: result.operation.id,
            lockedOperationSeq: result.operation.seq,
            outputCount: result.outputs.length,
          },
        }
      }),
  }

  /** execution.report.submit —— 提交（[底稿 A5/A6]）。 */
  /** execution.report.submit —— 提交（[底稿 A5/A6]；校验全部先于写入：拒绝不留草稿残留）。 */
  const reportSubmit: CommandHandler = {
    commandType: 'execution.report.submit',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        await requirePermission(tools, EXECUTION_PERMISSIONS.report)
        const et = ex(tools)
        const p = envelope.payload as Payload
        const command = 'execution.report.submit'

        // ---- 阶段一：定位 + 全量校验（零写入；命令总线对业务拒绝同样 COMMIT 回执，必须无残留）----
        let draft: DraftEnsureResult
        const targetReportId = envelope.targetId !== 'new' ? envelope.targetId : str(p, 'reportId')
        if (targetReportId !== undefined || str(p, 'sessionId') !== undefined) {
          const sessionId = str(p, 'sessionId')
          let report =
            targetReportId !== undefined
              ? await et.execution.reports.findById(targetReportId)
              : sessionId !== undefined
                ? await et.execution.reports.findBySessionId(sessionId)
                : null
          if (report === null || report.enterpriseId !== ctx.enterpriseId) {
            throw new Rejection(bad('报工单不存在', ERROR_CODES.NOT_FOUND))
          }
          if (report.status !== 'draft') {
            throw new Rejection(bad(`[A6-6] 报工单状态 ${report.status} 不可提交（仅草稿可提交）`))
          }
          const session = await et.execution.sessions.findById(report.sessionId)
          if (session === null) throw new Rejection(bad('报工会话不存在', ERROR_CODES.NOT_FOUND))
          const order = await et.process.orders.findById(report.orderId)
          if (order === null) throw new Rejection(bad('生产订单不存在', ERROR_CODES.NOT_FOUND))
          await assertWriteScope(tools, order.plantId)
          const ops = await loadOperations(tools, order.id, order.currentSettingsVersion)
          const operation = ops.find((o) => o.record.id === report!.orderOperationId)
          if (operation === undefined) {
            throw new Rejection(bad('订单工序不存在或不在当前设置版本', ERROR_CODES.NOT_FOUND))
          }
          // 载荷覆盖（产出/投料/备注）——草稿唯一事实源替换
          if (p['outputs'] !== undefined) {
            const lines = parseOutputLines(p, order, et.config, command)
            await et.execution.outputs.replaceDraftOutputs(
              report.id,
              toNewOutputs(lines, report, ctx.actorLoginName),
              ctx.actorLoginName,
            )
          }
          if (p['feeds'] !== undefined) {
            await et.execution.sessions.update(
              session.id,
              { draftFeeds: parseFeedLines(p, command) },
              ctx.actorLoginName,
            )
          }
          if (str(p, 'remark') !== undefined) {
            report = (await et.execution.reports.update(
              report.id,
              { remark: str(p, 'remark') },
              ctx.actorLoginName,
            )) ?? report
          }
          const outputs = await et.execution.outputs.listByReport(report.id)
          const sessionAfter = (await et.execution.sessions.findById(session.id)) ?? session
          draft = { session: sessionAfter, report, order, ops, operation: operation.record, outputs, created: false }
        } else {
          // 直提路径（三入口直接提交）：先做全部跨域校验，再 ensureDraft 落稿
          const entry = await resolveEntry(tools, ctx, p)
          const payloadOutputs = parseOutputLines(p, entry.order, et.config, command)
          if (payloadOutputs.length === 0 && entry.resumeOutputs.length === 0) {
            throw new Rejection(bad('[A6-5] 报工单缺少产出行（保存界面产出数量为必填），拒绝提交'))
          }
          const incomingQty = sumQty(
            (payloadOutputs.length > 0 ? payloadOutputs.map((l) => l.quantity) : entry.resumeOutputs.map((o) => o.quantity)),
          )
          await assertSubmitPreconditions({
            tools: et,
            order: entry.order,
            ops: entry.ops,
            operation: entry.operation,
            incomingQty,
            excludeReportId: entry.resumeReport?.id ?? null,
            payload: p,
          })
          draft = await ensureDraft(tools, ctx, p)
          if (p['outputs'] !== undefined || p['feeds'] !== undefined) {
            draft.outputs = await et.execution.outputs.listByReport(draft.report.id)
          }
        }

        const { session, report, order, ops, operation, outputs } = draft
        if (outputs.length === 0) {
          throw new Rejection(bad('[A6-5] 报工单缺少产出行（保存界面产出数量为必填），拒绝提交'))
        }

        const pc = await buildPostingContext(
          et as unknown as InventoryCommandTools,
          ctx,
          'execution.report.submit',
          envelope.operationId,
          p,
        )
        await bindPostingCalendar(pc, order.plantId)

        // 报工投料扣减（[底稿 A7-4]：一批先全量准入，再逐行实时校验扣减，记扣前/扣后）
        const remainders = new Map<string, string>()
        const feedContext = { tools: et, ctx, pc, order, operation, reportId: report.id }
        const admittedFeeds: AdmittedFeedLine[] = []
        const feedLines = await lockFeedSources(et, parseFeedLines({ feeds: session.draftFeeds }, command))
        for (const line of feedLines) {
          admittedFeeds.push(await admitFeedLine(feedContext, line, remainders))
        }
        for (const [feedIdx, admitted] of admittedFeeds.entries()) {
          const record = await et.execution.feeds.insert(
            await issueAdmittedFeedLine(feedContext, admitted, feedIdx + 1),
          )
          // [底稿 A7-5/D3] SAP 投料日志（消息含真实被消费单元，与流水原子提交）
          et.outbox.collect({
            aggregateType: 'material_consumption',
            aggregateId: record.id,
            taskKind: 'execution.sap-feeding-log',
            payload: {
              reportId: report.id,
              orderId: order.id,
              operationSeq: operation.seq,
              consumptionId: record.id,
              unitId: record.inventoryUnitId,
              unitNo: record.unitNo,
              quantity: record.quantity,
              beforeQty: record.beforeQty,
              afterQty: record.afterQty,
              salesOrderNo: record.salesOrderNo,
              salesLineNo: record.salesLineNo,
              businessTime: pc.businessTime,
            },
          })
        }

        // 状态轴推进：draft → submitted（会话同步）
        const submitted = (await et.execution.reports.update(
          report.id,
          { status: 'submitted' },
          ctx.actorLoginName,
        )) ?? report
        await et.execution.sessions.update(session.id, { status: 'submitted' }, ctx.actorLoginName)

        // [底稿 A6-4] 审核轴判定（末道非质检 + 自动审核车间配置）
        const outcome = decideReviewOutcome({
          operations: readinessOps(ops),
          reportedSeq: operation.seq,
          autoReviewDeptIds: et.config.lastOperationAutoReviewDeptIds,
        })
        let stockedUnits: string[] = []
        let completedQtyDelta = '0.0000'
        if (outcome === 'auto_approved') {
          const posted = await postApproval(et, ctx, pc, submitted, order, ops, outputs, 'auto_approved')
          stockedUnits = posted.stockedUnits
          completedQtyDelta = posted.completedQtyDelta
        }

        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'execution.report.submit',
          subjectType: 'production_report',
          subjectId: report.id,
          after: {
            orderId: order.id,
            operationSeq: operation.seq,
            source: report.source,
            reviewOutcome: outcome,
            outputTotal: sumQty(outputs.map((o) => o.quantity)),
            feedCount: session.draftFeeds.length,
          },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: {
            reportId: report.id,
            sessionId: session.id,
            reviewOutcome: outcome,
            stockedUnits,
            completedQtyDelta,
          },
        }
      }),
  }

  const reportReview: CommandHandler = {
    commandType: 'execution.report.review',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        await requirePermission(tools, EXECUTION_PERMISSIONS.review)
        const et = ex(tools)
        const report = await et.execution.reports.findById(envelope.targetId)
        if (report === null || report.enterpriseId !== ctx.enterpriseId) {
          throw new Rejection(bad('报工单不存在', ERROR_CODES.NOT_FOUND))
        }
        const order = await et.process.orders.findById(report.orderId)
        if (order === null) throw new Rejection(bad('生产订单不存在', ERROR_CODES.NOT_FOUND))
        await assertWriteScope(tools, order.plantId)
        // [底稿 A6-5] 草稿不能审核；已审核不可重复；撤审回待审可重新审核
        assertReviewTransitionAllowed({ status: report.status, reviewStatus: report.reviewStatus })
        const outputs = await et.execution.outputs.listByReport(report.id)
        if (outputs.length === 0) {
          throw new Rejection(bad('报工单无产出行，不可审核'))
        }
        const ops = await loadOperations(tools, order.id, order.currentSettingsVersion)
        const operation = ops.find((o) => o.record.id === report.orderOperationId)
        if (operation === undefined) {
          throw new Rejection(bad('订单工序不存在或不在当前设置版本', ERROR_CODES.NOT_FOUND))
        }
        const pc = await buildPostingContext(
          et as unknown as InventoryCommandTools,
          ctx,
          'execution.report.review',
          envelope.operationId,
          (envelope.payload as Payload) ?? {},
        )
        await bindPostingCalendar(pc, order.plantId)
        const posted = await postApproval(et, ctx, pc, report, order, ops, outputs, 'manual_approved')
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'execution.report.review',
          subjectType: 'production_report',
          subjectId: report.id,
          before: { reviewStatus: report.reviewStatus },
          after: { reviewStatus: 'manual_approved', stockedUnits: posted.stockedUnits },
          reason: ctx.reason ?? (str(envelope.payload as Payload, 'reason') ?? null),
        })
        return {
          status: 'COMMITTED',
          data: {
            reportId: report.id,
            reviewStatus: 'manual_approved',
            stockedUnits: posted.stockedUnits,
            completedQtyDelta: posted.completedQtyDelta,
          },
        }
      }),
  }

  /** execution.report.review.cancel —— 取消审核（守卫+逆操作，[底稿 A6-6/K18]）。 */
  const reportReviewCancel: CommandHandler = {
    commandType: 'execution.report.review.cancel',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        await requirePermission(tools, EXECUTION_PERMISSIONS.review)
        const et = ex(tools)
        const p = envelope.payload as Payload
        const report = await et.execution.reports.findById(envelope.targetId)
        if (report === null || report.enterpriseId !== ctx.enterpriseId) {
          throw new Rejection(bad('报工单不存在', ERROR_CODES.NOT_FOUND))
        }
        const order = await et.process.orders.findById(report.orderId)
        if (order === null) throw new Rejection(bad('生产订单不存在', ERROR_CODES.NOT_FOUND))
        await assertWriteScope(tools, order.plantId)
        const outputs = await et.execution.outputs.listByReport(report.id)
        const ops = await loadOperations(tools, order.id, order.currentSettingsVersion)
        const last = resolveLastNonQcOperation(readinessOps(ops))
        const isLast = last !== null && report.operationSeq === last.seq

        // [底稿 A6-6/K18] 对象关系守卫：任一产出已入库（移出线边库/上架）/被消耗/质检完成即拦截
        let anyOutputPutAway = false
        let anyOutputConsumed = false
        const reversalTargets: Array<{ output: ReportOutputRecord; unit: InventoryUnitRecord; balance: StockBalanceRecord }> = []
        for (const output of outputs) {
          if (output.stockUnitId === null) continue
          const unit = await et.inv.units.findById(output.stockUnitId)
          if (unit === null) continue
          if (unit.status !== 'in_stock') {
            anyOutputPutAway = true // 发运/在途/耗尽均视为移出线边（对象关系口径）
            continue
          }
          const balances = (await et.inv.balances.listActiveByUnit(unit.id)).filter((b) => b.status === 'active')
          const atTarget = balances.filter((b) => b.locationId === output.targetLocationId)
          if (balances.length > atTarget.length) {
            anyOutputPutAway = true // 有余额在目标线边库之外（上架/移库）
            continue
          }
          const balance = atTarget[0] ?? null
          if (balance === null || cmpQty(balance.quantity, output.quantity) < 0) {
            anyOutputConsumed = true // 余额不足＝已被下游消耗
            continue
          }
          const downstreamEdges = await et.inv.genealogy.listForward('inventory_unit', unit.id)
          const downstreamFeeds = await et.execution.feeds.listByUnit(unit.id)
          if (downstreamEdges.length > 0 || downstreamFeeds.length > 0) {
            anyOutputConsumed = true
            continue
          }
          reversalTargets.push({ output, unit, balance })
        }
        assertReviewCancellable({
          status: report.status,
          reviewStatus: report.reviewStatus,
          reviewCancelledAt: report.reviewCancelledAt,
          anyOutputPutAway,
          anyOutputConsumed,
          qcCompleted: report.qcCompletedAt !== null,
        })

        const pc = await buildPostingContext(
          et as unknown as InventoryCommandTools,
          ctx,
          'execution.report.review.cancel',
          envelope.operationId,
          p,
        )
        await bindPostingCalendar(pc, order.plantId)

        // 逆操作：撤回入库（reverse 流水行：扣前/扣后 + 余额回退 + 零余额关闭；身份与谱系保留）
        for (const target of reversalTargets) {
          const line = buildPostingLine({
            lineNo: 1,
            movementKind: 'reverse',
            beforeQty: target.balance.quantity,
            deltaQty: negateQty(target.output.quantity),
            uomId: target.balance.uomId,
          })
          const closes = zeroBalanceDisposition(line.afterQty)
          const insertedLine = await et.inv.transactions.insertLine({
            commandReceiptId: pc.commandReceiptId,
            lineNo: line.lineNo,
            movementKind: 'reverse',
            unitId: target.unit.id,
            lotId: target.unit.lotId,
            balanceId: target.balance.id,
            quantity: line.deltaQty,
            uomId: target.balance.uomId,
            uomCode: target.balance.uomCode,
            measurementBasis: target.balance.measurementBasis,
            conversionRevisionId: target.balance.conversionRevisionId,
            beforeQty: line.beforeQty,
            afterQty: line.afterQty,
            refType: 'production_report',
            refId: report.id,
            reason: str(p, 'reason') ?? 'execution.report.review.cancel 撤回入库',
            businessTime: pc.businessTime,
            shiftDate: pc.shiftDate,
            plantId: target.unit.plantId,
            enterpriseId: target.unit.enterpriseId,
            createdBy: ctx.actorLoginName,
          })
          await et.inv.transactions.insertEntry({
            transactionId: insertedLine.id,
            entryNo: 1,
            balanceId: target.balance.id,
            unitId: target.unit.id,
            locationId: target.balance.locationId,
            locationCode: target.balance.locationCode,
            ownerId: target.balance.ownerId,
            ownerName: target.balance.ownerName,
            lotId: target.unit.lotId,
            quantityDelta: line.deltaQty,
            beforeQty: line.beforeQty,
            afterQty: line.afterQty,
            purpose: 'reverse',
            plantId: target.unit.plantId,
            enterpriseId: target.unit.enterpriseId,
            createdBy: ctx.actorLoginName,
          })
          await et.inv.balances.adjust(
            target.balance.id,
            closes.closeBalance
              ? { quantity: line.afterQty, status: 'closed', closedAt: pc.businessTime }
              : { quantity: line.afterQty, status: 'active', closedAt: null },
            ctx.actorLoginName,
          )
          if (closes.closeBalance) {
            await et.inv.units.updateStatus(
              target.unit.id,
              { status: 'exhausted', balanceOpen: false, balanceClosedAt: pc.businessTime },
              ctx.actorLoginName,
            )
          }
          await et.execution.outputs.updateStockUnit(target.output.id, null, ctx.actorLoginName)
        }

        // 逆操作：完成数量回退（非负钳制）+ 回到待审核（留痕列承载取消事实）
        let completedDelta = '0.0000'
        if (isLast && reversalTargets.length > 0) {
          completedDelta = negateQty(sumQty(reversalTargets.map((t) => t.output.quantity)))
          await et.execution.orderProgress.addCompletedQty(order.id, completedDelta, ctx.actorLoginName)
        }
        const next = reviewCancelTransition({ reviewStatus: report.reviewStatus })
        await et.execution.reports.update(
          report.id,
          {
            reviewStatus: next,
            reviewCancelledAt: pc.businessTime,
            reviewCancelledBy: ctx.actorLoginName,
            reviewCancelReason: str(p, 'reason') ?? null,
          },
          ctx.actorLoginName,
        )
        // [底稿 A6-5/D3] 对外冲销事件（异步，不阻塞本地冲销入账）
        et.outbox.collect({
          aggregateType: 'production_report',
          aggregateId: report.id,
          taskKind: 'execution.review-cancelled',
          payload: {
            reportId: report.id,
            orderId: order.id,
            operationSeq: report.operationSeq,
            reversedUnits: reversalTargets.map((t) => t.unit.id),
            completedQtyDelta: completedDelta,
            reason: str(p, 'reason') ?? null,
            businessTime: pc.businessTime,
          },
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'execution.report.review.cancel',
          subjectType: 'production_report',
          subjectId: report.id,
          before: { reviewStatus: report.reviewStatus },
          after: { reviewStatus: next, reversedUnits: reversalTargets.length },
          reason: str(p, 'reason') ?? ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: { reportId: report.id, reviewStatus: next, reversedUnits: reversalTargets.length },
        }
      }),
  }

  /** execution.report.update —— 编辑（不改审核态，[底稿 A6-6]）。 */
  const reportUpdate: CommandHandler = {
    commandType: 'execution.report.update',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        await requirePermission(tools, EXECUTION_PERMISSIONS.report)
        const et = ex(tools)
        const p = envelope.payload as Payload
        const report = await et.execution.reports.findById(envelope.targetId)
        if (report === null || report.enterpriseId !== ctx.enterpriseId) {
          throw new Rejection(bad('报工单不存在', ERROR_CODES.NOT_FOUND))
        }
        const order = await et.process.orders.findById(report.orderId)
        if (order === null) throw new Rejection(bad('生产订单不存在', ERROR_CODES.NOT_FOUND))
        await assertWriteScope(tools, order.plantId)
        const outputs = await et.execution.outputs.listByReport(report.id)
        // [底稿 A6-6] 编辑守卫：不改审核状态；有产出时工序不可改；人工审核通过后不可编辑
        assertReportEditable({
          status: report.status,
          reviewStatus: report.reviewStatus,
          hasOutputs: outputs.length > 0,
          currentOperationId: report.orderOperationId,
          requestedOperationId: str(p, 'orderOperationId') ?? null,
          attemptsReviewStateChange: p['reviewStatus'] !== undefined || p['status'] !== undefined,
        })
        // 时间编辑不重置事实（K01）
        if (str(p, 'businessTime') !== undefined) {
          assertReportBusinessTimeEditable({
            requestedBusinessTime: str(p, 'businessTime')!,
            currentActualStartAt: order.actualStartAt,
          })
        }
        // 操作者编辑（人员可改；操作工仅自己口径复用 resolveOperator）
        let operatorPatch: { operatorUserId?: string; operatorLogin?: string } = {}
        if (str(p, 'operatorUserId') !== undefined) {
          const operator = await resolveOperator(tools, ctx, p)
          operatorPatch = { operatorUserId: operator.operatorUserId, operatorLogin: operator.operatorLogin }
        }
        // 产出行编辑：草稿整集替换；待审单仅数量/合格数（载体码不可改——删除守卫「码未动」结构保证）
        if (p['outputs'] !== undefined) {
          const lines = parseOutputLines(p, order, et.config, 'execution.report.update')
          if (report.status === 'draft') {
            await et.execution.outputs.replaceDraftOutputs(
              report.id,
              toNewOutputs(lines, report, ctx.actorLoginName),
              ctx.actorLoginName,
            )
          } else {
            const existing = await et.execution.outputs.listByReport(report.id)
            if (lines.length !== existing.length) {
              throw new Rejection(bad('[A6-6] 待审单编辑仅允许改产出数量/合格数（行数与载体码不可改）'))
            }
            for (let i = 0; i < lines.length; i += 1) {
              if (lines[i]!.carrierCode !== existing[i]!.carrierCode) {
                throw new Rejection(bad('[A6-6] 待审单编辑不可改产出载体码（删除守卫「码未动」前提）'))
              }
              await et.execution.outputs.updateQuantities(
                existing[i]!.id,
                lines[i]!.quantity,
                lines[i]!.qualifiedQty,
                ctx.actorLoginName,
              )
            }
            // 待审末道单增产后须复校超产硬限（[底稿 A5-1]）
            const ops = await loadOperations(tools, order.id, order.currentSettingsVersion)
            const last = resolveLastNonQcOperation(readinessOps(ops))
            if (last !== null && report.operationSeq === last.seq) {
              const incoming = sumQty(lines.map((l) => l.quantity))
              const existing0 = await reportedTotalForOperation(et, order.id, report.orderOperationId, report.id)
              assertReportOverrunLimit({
                plannedQty: order.productionQty,
                overrunRatio: order.overrunRatio ?? et.config.defaultOverrunRatio,
                existingReportedTotal: existing0,
                incomingQty: incoming,
                uom: order.uom,
                existingUom: order.uom,
                plannedUom: order.uom,
              })
            }
          }
        }
        if (report.status === 'draft' && p['feeds'] !== undefined) {
          await et.execution.sessions.update(
            report.sessionId,
            { draftFeeds: parseFeedLines(p, 'execution.report.update') },
            ctx.actorLoginName,
          )
        }
        const updated = (await et.execution.reports.update(
          report.id,
          {
            remark: str(p, 'remark') ?? undefined,
            businessTime: str(p, 'businessTime') ?? undefined,
            shiftDate: str(p, 'businessTime') !== undefined ? await shiftDateForPlant(et, report.plantId, str(p, 'businessTime')!) : undefined,
            ...operatorPatch,
          },
          ctx.actorLoginName,
        )) ?? report
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'execution.report.update',
          subjectType: 'production_report',
          subjectId: report.id,
          before: { status: report.status, reviewStatus: report.reviewStatus },
          after: { remark: updated.remark, businessTime: updated.businessTime, ...operatorPatch },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { reportId: report.id, status: updated.status } }
      }),
  }

  /** execution.report.delete —— 删除（仅待审且码未动，[底稿 A6-6/K15/K17]）。 */
  const reportDelete: CommandHandler = {
    commandType: 'execution.report.delete',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        await requirePermission(tools, EXECUTION_PERMISSIONS.report)
        const et = ex(tools)
        const p = envelope.payload as Payload
        const report = await et.execution.reports.findById(envelope.targetId)
        if (report === null || report.enterpriseId !== ctx.enterpriseId) {
          throw new Rejection(bad('报工单不存在', ERROR_CODES.NOT_FOUND))
        }
        const order = await et.process.orders.findById(report.orderId)
        if (order === null) throw new Rejection(bad('生产订单不存在', ERROR_CODES.NOT_FOUND))
        await assertWriteScope(tools, order.plantId)
        const outputs = await et.execution.outputs.listByReport(report.id)
        // 「产出码未被改动」由 update 命令结构性保证（待审单载体码不可改），此处仅查入库事实
        assertReportDeletable({
          status: report.status,
          reviewStatus: report.reviewStatus,
          outputsStocked: outputs.some((o) => o.stockUnitId !== null),
          outputsModified: false,
        })
        await et.execution.reports.update(
          report.id,
          { status: 'deleted', deletedAt: tools.now().toISOString(), deletedBy: ctx.actorLoginName },
          ctx.actorLoginName,
        )
        const session = await et.execution.sessions.findById(report.sessionId)
        if (session !== null && session.status === 'open') {
          await et.execution.sessions.update(session.id, { status: 'cancelled' }, ctx.actorLoginName)
        }
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'execution.report.delete',
          subjectType: 'production_report',
          subjectId: report.id,
          before: { status: report.status, reviewStatus: report.reviewStatus },
          after: { status: 'deleted' },
          reason: str(p, 'reason') ?? ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { reportId: report.id, status: 'deleted' } }
      }),
  }

  /** execution.feed.submit —— 单独投料提交（[底稿 A7]）。 */
  const feedSubmit: CommandHandler = {
    commandType: 'execution.feed.submit',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        await requirePermission(tools, EXECUTION_PERMISSIONS.feed)
        const et = ex(tools)
        const p = envelope.payload as Payload
        const command = 'execution.feed.submit'
        const orderId = requireStr(p, 'orderId', command)
        const order = await et.process.orders.findById(orderId)
        if (order === null || order.enterpriseId !== ctx.enterpriseId) {
          throw new Rejection(bad('生产订单不存在', ERROR_CODES.NOT_FOUND))
        }
        await assertObjectWriteScope(tools, ctx, order, EXECUTION_PERMISSIONS.feed, message => new Rejection(bad(message, ERROR_CODES.FORBIDDEN_SCOPE)))
        if (order.orderStatus !== 'in_progress' || order.suspended) {
          throw new Rejection(bad('[A7-1/K03] 投料须订单进行中且未挂起（统一归属、部门、可开工、非质检四检）'))
        }
        const ops = await loadOperations(tools, order.id, order.currentSettingsVersion)
        const operationId = requireStr(p, 'orderOperationId', command)
        const operation = ops.find((o) => o.record.id === operationId)
        if (operation === undefined) {
          throw new Rejection(bad('投料工序不存在或不在当前设置版本', ERROR_CODES.NOT_FOUND))
        }
        // [底稿 A7-1] 工序单选、质检不可选、非质检四检
        assertFeedOperationSelectable({
          isQc: operation.isQc,
          productionDeptId: operation.record.productionDeptId,
          existingFeedOperationId: null,
          requestedOperationId: operation.record.id,
        })
        const lines = parseFeedLines(p, command)
        if (lines.length === 0) {
          throw new Rejection(bad('投料提交至少一行（一次提交一批）'))
        }
        assertNoEmptyBarcodeForSubmit({ barcodeValues: lines.map((l) => l.barcodeValue ?? null) })

        const pc = await buildPostingContext(
          et as unknown as InventoryCommandTools,
          ctx,
          command,
          envelope.operationId,
          p,
        )
        await bindPostingCalendar(pc, order.plantId)
        const remainders = new Map<string, string>()
        const feedContext = { tools: et, ctx, pc, order, operation: operation.record, reportId: null }
        const admitted: AdmittedFeedLine[] = []
        for (const line of await lockFeedSources(et, lines)) {
          admitted.push(await admitFeedLine(feedContext, line, remainders))
        }
        const records: MaterialConsumptionRecord[] = []
        for (const [feedIdx, line] of admitted.entries()) {
          records.push(await et.execution.feeds.insert(await issueAdmittedFeedLine(feedContext, line, feedIdx + 1)))
        }
        // 谱系边：已有已入库产出单元则即时补写（否则留待下次报工产出落成回填）
        const target = await latestStockedOutputUnit(et, order.id, operation.record.id)
        if (target !== null) {
          await backfillGenealogyEdges(et, ctx, pc, order.id, operation.record.id, target)
        }
        // [底稿 A7-5/D3] SAP 投料日志 Outbox（消息含真实被消费单元，与流水原子提交）
        et.outbox.collect({
          aggregateType: 'material_consumption',
          aggregateId: records[0]?.id ?? order.id,
          taskKind: 'execution.sap-feeding-log',
          payload: {
            orderId: order.id,
            operationSeq: operation.record.seq,
            lines: records.map((r) => ({
              consumptionId: r.id,
              unitId: r.inventoryUnitId,
              unitNo: r.unitNo,
              quantity: r.quantity,
              beforeQty: r.beforeQty,
              afterQty: r.afterQty,
              salesOrderNo: r.salesOrderNo,
              salesLineNo: r.salesLineNo,
            })),
            businessTime: pc.businessTime,
          },
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'execution.feed.submit',
          subjectType: 'production_order',
          subjectId: order.id,
          after: {
            operationSeq: operation.record.seq,
            lineCount: records.length,
            totalQty: sumQty(records.map((r) => r.quantity)),
          },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: {
            orderId: order.id,
            operationSeq: operation.record.seq,
            consumptionIds: records.map((r) => r.id),
          },
        }
      }),
  }

  /** execution.labor.record —— 工时记录（[底稿 A6-5] 工时日志）。 */
  const laborRecord: CommandHandler = {
    commandType: 'execution.labor.record',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        await requirePermission(tools, EXECUTION_PERMISSIONS.labor)
        const et = ex(tools)
        const p = envelope.payload as Payload
        const command = 'execution.labor.record'
        const orderId = requireStr(p, 'orderId', command)
        const order = await et.process.orders.findById(orderId)
        if (order === null || order.enterpriseId !== ctx.enterpriseId) {
          throw new Rejection(bad('生产订单不存在', ERROR_CODES.NOT_FOUND))
        }
        await assertWriteScope(tools, order.plantId)
        const hours = requireDec(p, 'hours', command)
        if (!isPositiveQty(hours)) {
          throw new Rejection(bad('工时必须大于 0'))
        }
        const operator = await resolveOperator(tools, ctx, p)
        const businessTime = str(p, 'businessTime') ?? tools.now().toISOString()
        const record = await et.execution.labor.insert({
          enterpriseId: ctx.enterpriseId,
          plantId: order.plantId,
          orderId: order.id,
          orderOperationId: str(p, 'orderOperationId') ?? null,
          reportId: str(p, 'reportId') ?? null,
          operatorUserId: operator.operatorUserId,
          operatorLogin: operator.operatorLogin,
          hours,
          businessTime,
          shiftDate: await shiftDateForPlant(et, order.plantId, businessTime),
          note: str(p, 'note') ?? null,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'execution.labor.record',
          subjectType: 'labor_record',
          subjectId: record.id,
          after: { orderId: order.id, hours, operatorLogin: operator.operatorLogin },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { laborRecordId: record.id } }
      }),
  }

  return [
    sessionSave,
    reportSubmit,
    reportReview,
    reportReviewCancel,
    reportUpdate,
    reportDelete,
    feedSubmit,
    laborRecord,
  ]
}
