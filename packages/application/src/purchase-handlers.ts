import { ERROR_CODES } from '@cadenza/contracts'
import {
  InventoryRuleViolation,
  addQty,
  buildPostingLine,
  cmpQty,
  ensureStableLockOrder,
  subQty,
  zeroBalanceDisposition,
} from '@cadenza/domain'
// domain purchase 面未并入包名入口（domain/src/index.ts 为共享文件不改动）：
// 暂以 dist 相对导入消费已构建产物（构建顺序由 workspace 拓扑保证：domain 先于 application）；
// L0 整合步在 domain index 追加 `export * from './purchase'` 后改包名导入（同 masterdata/inventory 口径）。
import {
  PurchaseRuleViolation,
  assertBarcodeKindMatchesMaterialType,
  assertDetailQuantityPositive,
  assertDetailTripleUnique,
  assertJudgeExecutable,
  assertOrderLineReceivable,
  assertPriceReviewExecutable,
  assertReinspectionStartable,
  assertReturnExecutable,
  assertReturnReasonPresent,
  assertRevocationAllowed,
  assertSameLocationPerBarcode,
  assertSameProductionDatePerSupplierLot,
  assertWebInspectionExecutable,
  computeDetailQuantityFromPackage,
  computePriceSnapshot,
  computeTotalReceiptQty,
  initialDetailQualityStatus,
  mapDetailStatusToBalanceQuality,
  nextInspectionVersion,
  recalcOrderLineStatus,
  resolveEmptyBarcodeDisposition,
  resolveInspectionChainForCode,
  revokedDetailStatus,
  shouldWebInspectionWriteCode,
  summarizeBatchInspection,
  assertWithinOverReceiptLimit,
} from '@cadenza/domain'
import type { CommandHandler, HandlerOutcome } from './command-bus'
import { violationOutcome } from './inventory-handlers'
import { NOT_FOUND_RULE, buildPostingContext, receiveGoods, type PostingContext } from './inventory-posting'
import type {
  PurchaseCommandTools,
  PurchaseOrderLineRecord,
  PurchaseReceiptBatchRecord,
  ReceiptDetailRecord,
} from './purchase-repositories'
import { assertObjectWriteScope, type ObjectScope } from './object-scope-repositories'

/**
 * purchase 域命令处理器（T08 采购主链；全部在命令总线事务内运行，命令事务即 UoW）。
 *
 * 命令面（7）：
 * - purchase.order-sync：模拟入站采购订单同步（IF-08 五元组幂等 + external_revision 乱序保护 + IF-00.8 隔离）；
 * - purchase.receive-confirm：确认收货——一次事务内：批次/明细落库 + 逐明细调 inventory receiveGoods
 *   （同 UoW，端口注入）+ 初始质量状态（免检/待检，A-4）+ 订单行已收/状态回写（A-1）+
 *   首/末到货日期 + 价格快照（A-10）+ 免检批 Outbox 合格同步任务（IF-09）；
 * - purchase.inspection.conclude：质检结论（A-7/S14 版本化追加 + 批次重汇总 + 库存质量状态更新）；
 * - purchase.inspection.revoke：撤销质检（A-8/S14 保留历史、仅切生效指针）；
 * - purchase.inspection.start-reinspection：发起复检（A-6 复检至多一次，明细→待复检）；
 * - purchase.return：退货（A-9 反向流水 + 订单行扣减 + Outbox 退货同步 IF-10）；
 * - purchase.price-review.confirm：价格复核标记（A-10 只改状态/人/时间，已复核不可撤销）。
 *
 * 幂等/回执由 PgCommandBus 承担；规则违例以 `[A-x]` 前缀文案返回（BUSINESS_REJECTION）。
 */

type Payload = Record<string, unknown>

/** Diagnostic exception: replay only this Inbox fact after business rollback. */
class QuarantinedPurchaseInbound extends PurchaseRuleViolation {
  constructor(message: string, readonly persistRejectionDiagnostics: () => Promise<void>) {
    super('IF-00.8', message)
  }
}

function purchaseViolationOutcome(error: PurchaseRuleViolation): HandlerOutcome {
  // 采购域组织隔离二道防线（OA-24/26 口径随行）→ FORBIDDEN_SCOPE（HTTP 403）
  const errorCode = error.rule === 'A-S1' ? ERROR_CODES.FORBIDDEN_SCOPE : ERROR_CODES.BUSINESS_RULE
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<Record<string, unknown>>): Promise<HandlerOutcome> {
  try {
    const data = await body()
    return { status: 'COMMITTED', data }
  } catch (error) {
    if (error instanceof QuarantinedPurchaseInbound) {
      // Object.assign is compatible with the original HandlerOutcome type. The
      // new bus consumes this internal callback; the old bus keeps its old behavior.
      return Object.assign(purchaseViolationOutcome(error), {
        persistRejectionDiagnostics: error.persistRejectionDiagnostics,
      })
    }
    if (error instanceof PurchaseRuleViolation) return purchaseViolationOutcome(error)
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
  if (v === undefined) throw new PurchaseRuleViolation('A-3', `${command}：载荷缺少必填字段 ${key}`)
  return v
}

// ---------------- 通用前置 ----------------

async function assertPurchaseObjectScope(pc: PostingContext, target: ObjectScope, claimedPlantId?: string): Promise<void> {
  await assertObjectWriteScope(pc.tools, pc.ctx, target, 'purchase.post',
    (message) => new PurchaseRuleViolation('A-S1', message), claimedPlantId)
}

async function assertPlantScope(pc: PostingContext, plantId: string): Promise<void> {
  await assertPurchaseObjectScope(pc, { enterpriseId: pc.ctx.enterpriseId, plantId })
}

/** The locked line and its persisted parent must describe the same organization. */
async function assertPurchaseLineScope(pc: PostingContext, line: PurchaseOrderLineRecord, claimedPlantId?: string): Promise<void> {
  await assertPurchaseObjectScope(pc, line, claimedPlantId)
  const order = await purchaseTools(pc).pur.orders.findByKey(line.sourceSystem, line.orgCode, line.orderNo)
  if (order === null || order.id !== line.purchaseOrderId ||
      order.enterpriseId !== line.enterpriseId || order.plantId !== line.plantId) {
    throw new PurchaseRuleViolation('A-S1', '采购行与订单的真实企业/工厂不一致')
  }
  await assertPurchaseObjectScope(pc, order, line.plantId)
}

async function lockScopedBatch(pc: PostingContext, batchId: string, claimedPlantId?: string): Promise<PurchaseReceiptBatchRecord> {
  const tools = purchaseTools(pc)
  const batch = await tools.pur.batches.findById(batchId, true)
  if (batch === null) throw new PurchaseRuleViolation(NOT_FOUND_RULE, '采购批次不存在')
  await assertPurchaseObjectScope(pc, batch, claimedPlantId)
  const line = await tools.pur.lines.findById(batch.purchaseLineId)
  if (line === null) throw new PurchaseRuleViolation('A-S1', '采购批次的订单行不存在')
  await assertPurchaseLineScope(pc, line, batch.plantId)
  if (line.enterpriseId !== batch.enterpriseId || line.orderNo !== batch.orderNo ||
      line.lineNo !== batch.lineNo || line.materialId !== batch.materialId) {
    throw new PurchaseRuleViolation('A-S1', '采购批次与订单行的实际归属不一致')
  }
  return batch
}

function todayOf(iso: string): string {
  return iso.slice(0, 10)
}

/** PostingContext.tools 的 purchase 窄化（组合根构造的工具集含 pur 仓储束，见 purchase.composition）。 */
function purchaseTools(pc: PostingContext): PurchaseCommandTools {
  return pc.tools as PurchaseCommandTools
}

// ---------------- 单明细收货入账（ABS 收编：直调 inventory-posting.receiveGoods 核心面） ----------------

/**
 * 确认收货的单明细库存入账——原等价内部服务 receiveGoodsLine 已删除（ABS 收编轮）：
 * inventory-posting.receiveGoods 已参数化 lineNo/lotKind/refType/recordToColumns 等
 * （缺省值＝收编前核心行为），本域多明细同命令收货经 lineNo 逐明细递增直调核心
 * （同一记账序 IT-25，同一 tools.inv 端口束、同 UoW）。差异注记：
 * - 收编前批次 supplierLotNo 缺省落 ''，现随核心口径落 NULL（无读取方区分，全仓断言无涉及）；
 * - 批次物料不符/单元号重复两条拒绝路径的规则码由 [A-4] 随核心口径变为 [IT-01]
 *   （本域流程批次号/单元号均为新生成，两路径不可达）。
 */

// ---------------- A-1 订单行已收口径核心（ABS 收编：reverse 等价服务 deductOrderLine 并入） ----------------

/** 订单行已收扣减所需的锁定事实（purchase.lines.lockById 与 reverse rv.pur.lockOrderLine 均结构满足）。 */
export interface OrderLineDeductFacts {
  receivedQty: string
  plannedQty: string
  status: number
}

/**
 * 订单行已收扣减＋状态重算核心（A-1 已收口径的唯一实现；收编自 reverse deductOrderLine 等价服务）。
 * 锁定与落库经端口适配器注入（purchase=lockById+updateReceiptState 绝对值写；
 * reverse=lockOrderLine+adjustOrderLineReceivedQty 增量写，同事务行锁下二者等价）；
 * 不足策略由调用域自带：clamp-zero=purchase.return 截零（subtractReturnedQty 语义）；
 * reject-negative=reverse 冲销拒绝（WR-20）。违例构造器注入以保各域错误码/文案不变。
 */
export async function deductOrderLineReceived(
  lockFacts: () => Promise<OrderLineDeductFacts | null>,
  deductQty: string,
  opts: {
    policy: 'clamp-zero' | 'reject-negative'
    write: (newReceived: string, newStatus: number) => Promise<unknown>
    violation: (rule: string, message: string) => Error
  },
): Promise<{ receivedQty: string; status: number }> {
  const line = await lockFacts()
  if (line === null) throw opts.violation(NOT_FOUND_RULE, '采购订单行不存在')
  const after = subQty(line.receivedQty, deductQty)
  if (cmpQty(after, '0.0000') < 0 && opts.policy === 'reject-negative') {
    throw opts.violation('WR-20', `订单行已收数量不足以扣减（已收 ${line.receivedQty}、扣减 ${deductQty}）`)
  }
  const newReceived = cmpQty(after, '0.0000') < 0 ? '0.0000' : after
  const newStatus = recalcOrderLineStatus({
    status: line.status,
    plannedQty: line.plannedQty,
    receivedQty: newReceived,
  })
  await opts.write(newReceived, newStatus)
  return { receivedQty: newReceived, status: newStatus }
}

// ---------------- 批次质量状态刷新（A-6 汇总 + T12 库存质量投影） ----------------

/** 明细质量状态 → 库存余额质量状态同步（T12 闸门消费口径：免检/合格可用，待检/待复检不可用）。 */
async function syncUnitQuality(pc: PostingContext, batch: PurchaseReceiptBatchRecord, detail: ReceiptDetailRecord): Promise<void> {
  const tools = purchaseTools(pc)
  if (detail.batchId !== batch.id) throw new PurchaseRuleViolation('A-S1', '明细不属于实际采购批次')
  if (detail.inventoryUnitId === null) return
  const unit = (await tools.inv.units.lockForUpdate([detail.inventoryUnitId]))[0]
  if (unit === undefined) throw new PurchaseRuleViolation('A-S1', '采购明细绑定的库存单元不存在')
  await assertPurchaseObjectScope(pc, unit, batch.plantId)
  if (unit.materialId !== batch.materialId) throw new PurchaseRuleViolation('A-S1', '采购明细与库存料品身份不一致')
  const balances = await tools.inv.balances.listActiveByUnit(unit.id)
  const target = mapDetailStatusToBalanceQuality(detail.qualityStatus)
  for (const b of balances) {
    if (b.unitId !== unit.id || b.enterpriseId !== unit.enterpriseId || b.plantId !== unit.plantId) {
      throw new PurchaseRuleViolation('A-S1', '采购明细的库存余额归属不一致')
    }
    if (b.qualityStatus !== target) await tools.inv.balances.adjust(b.id, { qualityStatus: target }, null)
  }
}

/** 批次质检状态重汇总（A-6）+ 同一受权批次的库存投影。 */
async function refreshBatchQualityState(
  pc: PostingContext,
  batchId: string,
): Promise<PurchaseReceiptBatchRecord['inspectionStatus']> {
  const tools = purchaseTools(pc)
  const batch = await lockScopedBatch(pc, batchId)
  const details = await tools.pur.details.listByBatch(batchId)
  const summary = summarizeBatchInspection(details.map((d) => d.qualityStatus))
  for (const d of [...details].sort((a, b) => (a.inventoryUnitId ?? '').localeCompare(b.inventoryUnitId ?? ''))) {
    await syncUnitQuality(pc, batch, d)
  }
  const updated = await tools.pur.batches.updateInspectionStatus(batchId, summary, null)
  return updated?.inspectionStatus ?? summary
}

/** IF-09：批次达免检/全部合格且尚无合格同步任务 → Outbox 合格收货回传（时点快照）。 */
async function ensureQualifiedSyncTask(pc: PostingContext, batchId: string): Promise<void> {
  const batch = await lockScopedBatch(pc, batchId)
  if (batch.inspectionStatus !== 'exempt' && batch.inspectionStatus !== 'all_qualified') return
  if (batch.qualifiedSyncStatus !== 'none') return
  pc.tools.outbox.collect({
    aggregateType: 'purchase_receipt_batch',
    aggregateId: batch.id,
    taskKind: 'qualified_sync',
    payload: {
      routeKey: 'receipt_callback',
      batchNo: batch.batchNo,
      orderNo: batch.orderNo,
      lineNo: batch.lineNo,
      materialCode: batch.materialCode,
      materialName: batch.materialName,
      quantity: batch.receivedQty,
      uomCode: batch.uomCode,
      unitPrice: batch.unitPrice,
      inspectionStatus: batch.inspectionStatus,
      plantId: batch.plantId,
      warehouseId: batch.warehouseId,
      confirmTime: batch.confirmTime,
      receivedBy: batch.receivedBy,
      snapshotAt: pc.businessTime,
    },
  })
  await purchaseTools(pc).pur.batches.markQualifiedSyncPending(batch.id, pc.ctx.actorLoginName)
}

// ---------------- 命令：模拟入站订单同步（IF-08） ----------------

async function orderSync(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = purchaseTools(pc)
  const orgCode = requireStr(p, 'orgCode', 'purchase.order-sync')
  const orderNo = requireStr(p, 'orderNo', 'purchase.order-sync')
  const sourceSystem = str(p, 'sourceSystem') ?? 'ERP'
  const plantId = str(p, 'plantId')

  // IF-00.8：缺组织映射（模拟适配器未解析出 plantId）→ 隔离队列，非普通失败重试
  if (plantId === undefined) {
    const persistQuarantine = async (): Promise<void> => {
      await tools.pur.mappings.insertQuarantinedInbox({
        sourceSystem,
        organizationCode: orgCode,
        externalKey: orderNo,
        entityType: 'purchase_order',
        quarantineReason: '缺组织映射（route_key=purchase_order）：订单行入隔离队列待人工补绑',
        payload: p,
      })
    }
    await persistQuarantine()
    throw new QuarantinedPurchaseInbound(
      `订单 ${orderNo} 缺组织映射（plantId），已写入隔离队列（QUARANTINED），不重复应用`,
      persistQuarantine,
    )
  }
  await assertPlantScope(pc, plantId)

  let order = await tools.pur.orders.findByKey(sourceSystem, orgCode, orderNo, true)
  if (order === null) {
    order = await tools.pur.orders.insert({
      orderNo,
      orgCode,
      sourceSystem,
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      supplierName: str(p, 'supplierName') ?? null,
      contractNo: str(p, 'contractNo') ?? null,
      externalRevision: p['externalRevision'] as number | undefined ?? null,
      createdBy: pc.ctx.actorLoginName,
    })
  }

  await assertPurchaseObjectScope(pc, order, plantId)

  const linesPayload = p['lines']
  if (!Array.isArray(linesPayload) || linesPayload.length === 0) {
    throw new PurchaseRuleViolation('IF-08', '订单同步载荷至少包含一行订单行')
  }

  const results: Array<Record<string, unknown>> = []
  for (const [index, rawLine] of linesPayload.entries()) {
    const lp = (rawLine ?? {}) as Payload
    const lineNoRaw = lp['lineNo']
    const lineNo = typeof lineNoRaw === 'number' && Number.isInteger(lineNoRaw) && lineNoRaw >= 1 ? lineNoRaw : undefined
    if (lineNo === undefined) {
      throw new PurchaseRuleViolation('IF-08', `第 ${index + 1} 行 lineNo 必须为正整数`)
    }
    const materialCode = str(lp, 'materialCode')
    if (materialCode === undefined) {
      throw new PurchaseRuleViolation('IF-08', `第 ${index + 1} 行缺少 materialCode`)
    }

    // IF-00.2/IF-08 五元组幂等：命中既有映射 → 幂等/修订比较，不重复应用
    const existing = await tools.pur.mappings.findLineMapping({
      sourceSystem,
      organizationCode: orgCode,
      externalId: orderNo,
      lineNo,
    })
    const revision = (lp['externalRevision'] as number | undefined) ?? (p['externalRevision'] as number | undefined) ?? 1

    if (existing !== null) {
      const existingLine = await tools.pur.lines.lockById(existing.localObjectId)
      if (existingLine === null) {
        throw new PurchaseRuleViolation('IF-00.2', `五元组映射指向的订单行不存在（${orderNo}/${lineNo}）`)
      }
      await assertPurchaseLineScope(pc, existingLine, plantId)
      if (existingLine.purchaseOrderId !== order.id || existingLine.lineNo !== lineNo) {
        throw new PurchaseRuleViolation('A-S1', '五元组映射指向的实际订单行不一致')
      }
      // IF-00.3 外部修订号：低于当前已应用 → stale 不覆盖；等于 → 幂等重放；高于 → 应用新版
      if (revision <= (existingLine.externalRevision ?? 1)) {
        results.push({
          lineNo,
          lineId: existingLine.id,
          applied: false,
          stale: revision < (existingLine.externalRevision ?? 1),
          reason: revision < (existingLine.externalRevision ?? 1) ? 'external_revision 低于已应用版本，stale 不覆盖' : '五元组幂等命中，原结果重放',
        })
        continue
      }
      const updated = await tools.pur.lines.applySyncRevision(
        existingLine.id,
        {
          plannedQty: str(lp, 'plannedQty'),
          overReceiptLimit: str(lp, 'overReceiptLimit'),
          status: typeof lp['status'] === 'number' ? (lp['status'] as number) : undefined,
          erpClosed: lp['erpClosed'] === true ? true : undefined,
          externalRevision: revision,
        },
        pc.ctx.actorLoginName,
      )
      results.push({ lineNo, lineId: existingLine.id, applied: true, revisionApplied: revision, plannedQty: updated?.plannedQty })
      continue
    }

    // 料品解析（同步入站按编码；缺料品 → 业务拒绝，不生成默认值）
    const materialIdRaw = str(lp, 'materialId')
    const material = materialIdRaw !== undefined
      ? await tools.pur.materials.findById(materialIdRaw)
      : await tools.pur.materials.findByCode(materialCode, pc.ctx.enterpriseId)
    if (material === null) {
      throw new PurchaseRuleViolation(
        'IF-01',
        `第 ${index + 1} 行料品 ${materialCode} 不存在（同步入站不生成默认主数据）`,
      )
    }
    const scopedMaterial = await tools.pur.materials.findByCode(materialCode, pc.ctx.enterpriseId)
    if (scopedMaterial === null || scopedMaterial.id !== material.id) {
      throw new PurchaseRuleViolation('A-S1', '料品 ID/编码不属于当前企业的实际主数据')
    }
    const plannedQty = str(lp, 'plannedQty')
    if (plannedQty === undefined) {
      throw new PurchaseRuleViolation('IF-08', `第 ${index + 1} 行缺少 plannedQty`)
    }
    const overLimit = str(lp, 'overReceiptLimit') ?? plannedQty

    const inserted = await tools.pur.lines.insert({
      purchaseOrderId: order.id,
      lineNo,
      orderNo,
      orgCode,
      sourceSystem,
      materialId: material.id,
      materialCode,
      materialName: str(lp, 'materialName') ?? material.name,
      materialType: material.materialType ?? null,
      spec: str(lp, 'spec') ?? null,
      model: str(lp, 'model') ?? null,
      color: str(lp, 'color') ?? null,
      requisitionSpec: str(lp, 'requisitionSpec') ?? null,
      salesOrderNo: str(lp, 'salesOrderNo') ?? null,
      salesLineNo: str(lp, 'salesLineNo') ?? null,
      uomCode: str(lp, 'uomCode') ?? material.baseUom ?? '件',
      plannedQty,
      overReceiptLimit: overLimit,
      status: typeof lp['status'] === 'number' ? (lp['status'] as number) : 0,
      erpClosed: lp['erpClosed'] === true,
      plannedReceiptDate: str(lp, 'plannedReceiptDate') ?? null,
      externalRevision: revision,
      plantId,
      enterpriseId: pc.ctx.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
    await tools.pur.mappings.insertLineMapping({
      sourceSystem,
      organizationCode: orgCode,
      externalId: orderNo,
      lineNo,
      localObjectId: inserted.id,
      createdBy: pc.ctx.actorLoginName,
    })
    results.push({ lineNo, lineId: inserted.id, applied: true, revisionApplied: revision })
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'purchase.order-sync',
    subjectType: 'purchase_order',
    subjectId: order.id,
    after: { orderNo, orgCode, sourceSystem, lines: results.length },
    reason: str(p, 'reason') ?? null,
  })
  return { orderId: order.id, orderNo, lines: results }
}

// ---------------- 命令：确认收货（A-2/A-3/A-4/A-5；一次事务四账一致） ----------------

async function receiveConfirm(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = purchaseTools(pc)
  const plantId = requireStr(p, 'plantId', 'purchase.receive-confirm')
  await assertPlantScope(pc, plantId)

  // 订单行定位（orderLineId 优先，orderNo+lineNo 回退）
  const orderLineId = str(p, 'orderLineId')
  let line = orderLineId !== undefined
    ? await tools.pur.lines.lockById(orderLineId)
    : null
  if (orderLineId === undefined) {
    const orderNo = str(p, 'orderNo')
    const lineNoRaw = p['lineNo']
    const lineNo = typeof lineNoRaw === 'number' && Number.isInteger(lineNoRaw) ? lineNoRaw : undefined
    if (orderNo === undefined || lineNo === undefined) {
      throw new PurchaseRuleViolation('A-3', '确认收货须携带 orderLineId 或 orderNo+lineNo')
    }
    line = await tools.pur.lines.findByOrderNoAndLine(orderNo, lineNo, plantId)
    if (line !== null) line = await tools.pur.lines.lockById(line.id)
  }
  if (line === null) {
    throw new PurchaseRuleViolation(NOT_FOUND_RULE, '采购订单行不存在')
  }
  await assertPurchaseLineScope(pc, line, plantId)
  if ((str(p, 'orderNo') !== undefined && str(p, 'orderNo') !== line.orderNo) ||
      (p['lineNo'] !== undefined && p['lineNo'] !== line.lineNo)) {
    throw new PurchaseRuleViolation('A-S1', '采购行 ID 与自然键不一致')
  }
  if (line.erpClosed) {
    throw new PurchaseRuleViolation('A-1', '订单行已被 ERP 商业关闭（erp_closed），冻结不可收货（IF-08）')
  }
  assertOrderLineReceivable(line.status)

  const arrivalTime = requireStr(p, 'arrivalTime', 'purchase.receive-confirm')
  const confirmTime = str(p, 'confirmTime') ?? pc.businessTime
  if (Date.parse(arrivalTime) > Date.parse(confirmTime)) {
    throw new PurchaseRuleViolation('A-3', '到货时间须小于等于入库确认时间')
  }
  const warehouseId = requireStr(p, 'warehouseId', 'purchase.receive-confirm')
  const locationId = requireStr(p, 'locationId', 'purchase.receive-confirm')
  const locationCode = requireStr(p, 'locationCode', 'purchase.receive-confirm')
  const ownerId = requireStr(p, 'ownerId', 'purchase.receive-confirm')
  const ownerName = requireStr(p, 'ownerName', 'purchase.receive-confirm')
  const uomId = requireStr(p, 'uomId', 'purchase.receive-confirm')
  const uomCode = requireStr(p, 'uomCode', 'purchase.receive-confirm')

  const detailsPayload = p['details']
  if (!Array.isArray(detailsPayload) || detailsPayload.length === 0) {
    throw new PurchaseRuleViolation('A-3', '确认收货至少包含一条已扫明细')
  }

  // 明细解析：quantity 直传或 包装单位总量×码数（A-5）
  const parsed = detailsPayload.map((raw, index) => {
    const d = (raw ?? {}) as Payload
    const barcodeValue = str(d, 'barcodeValue')
    if (barcodeValue === undefined) {
      throw new PurchaseRuleViolation('A-3', `第 ${index + 1} 条明细缺少 barcodeValue`)
    }
    let quantity = str(d, 'quantity')
    if (quantity === undefined) {
      const packageUnitQty = str(d, 'packageUnitQty')
      const codeCountRaw = d['codeCount']
      const codeCount = typeof codeCountRaw === 'number' && Number.isInteger(codeCountRaw) ? codeCountRaw : undefined
      if (packageUnitQty === undefined || codeCount === undefined) {
        throw new PurchaseRuleViolation('A-5', `第 ${index + 1} 条明细缺少 quantity 或 packageUnitQty+codeCount`)
      }
      quantity = computeDetailQuantityFromPackage({ packageUnitQty, codeCount })
    }
    return {
      barcodeValue,
      supplierLotNo: str(d, 'supplierLotNo') ?? '',
      grade: str(d, 'grade') ?? '',
      productionDate: str(d, 'productionDate') ?? null,
      quantity,
      packageUnitQty: str(d, 'packageUnitQty') ?? null,
      codeCount: typeof d['codeCount'] === 'number' ? (d['codeCount'] as number) : null,
      conversionRevisionId: str(d, 'conversionRevisionId') ?? null,
      locationId: str(d, 'locationId') ?? locationId,
      locationCode: str(d, 'locationCode') ?? locationCode,
      note: str(d, 'note') ?? null,
    }
  })

  // 域校验 [A-3]：三元组唯一 / 生产日期一致 / 数量>0 / 同码库位一致
  assertDetailTripleUnique(parsed)
  assertSameProductionDatePerSupplierLot(parsed)
  assertDetailQuantityPositive(parsed)
  assertSameLocationPerBarcode(parsed)

  // 物料（免检判定 + 码型匹配）
  const material = await tools.pur.materials.findById(line.materialId)
  if (material === null) {
    throw new PurchaseRuleViolation('IF-01', `订单行物料 ${line.materialCode} 主数据缺失`)
  }
  const scopedMaterial = await tools.pur.materials.findByCode(line.materialCode, pc.ctx.enterpriseId)
  if (scopedMaterial === null || scopedMaterial.id !== material.id) {
    throw new PurchaseRuleViolation('A-S1', '采购行料品不属于当前企业的实际主数据')
  }
  const materialType = line.materialType ?? material.materialType ?? 1
  for (const d of parsed) {
    assertBarcodeKindMatchesMaterialType({ barcodeValue: d.barcodeValue, materialType })
  }

  // [A-3] 超上限整单拒绝
  const totalQty = computeTotalReceiptQty(parsed)
  assertWithinOverReceiptLimit({
    receivedQty: line.receivedQty,
    incomingQty: totalQty,
    overReceiptLimit: line.overReceiptLimit,
  })

  // [A-2] 空码校验（非采购收货来源记录拒绝；采购来源允许同码多批 S13）
  const barcodePlans: Array<{ firstPurchaseReceipt: boolean }> = []
  for (const d of parsed) {
    const active = await tools.inv.barcodes.findActiveBindingByValue(d.barcodeValue)
    let boundUnitLotKind: 'purchase' | 'production' | null = null
    if (active !== null) await assertPurchaseObjectScope(pc, active, plantId)
    if (active !== null && active.boundType === 'inventory_unit') {
      const unit = await tools.inv.units.findById(active.boundId)
      if (unit !== null) {
        await assertPurchaseObjectScope(pc, unit, plantId)
        const lot = await tools.inv.lots.findById(unit.lotId)
        if (lot !== null) await assertPurchaseObjectScope(pc, lot, plantId)
        boundUnitLotKind = lot?.kind ?? null
      }
    }
    barcodePlans.push(resolveEmptyBarcodeDisposition({ barcodeValue: d.barcodeValue, activeBinding: active, boundUnitLotKind }))
  }

  // [A-10] 价格快照（物料+组织近 5 次已入库有单价批次，时点固化）
  const unitPrice = str(p, 'unitPrice') ?? null
  const history = await tools.pur.batches.listRecentPricedByMaterialOrg(line.materialId, pc.ctx.enterpriseId, 5)
  const snapshot = computePriceSnapshot({ currentPrice: unitPrice, history })

  // [A-4] 免检判定（material.qc_flag）与批次初始质检状态（A-6 汇总）
  const initialStatus = initialDetailQualityStatus(material.qcFlag)
  const batchInspectionStatus = summarizeBatchInspection(parsed.map(() => initialStatus))

  const batchNo = `PRB${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`
  const batch = await tools.pur.batches.insert({
    batchNo,
    purchaseLineId: line.id,
    orderNo: line.orderNo,
    lineNo: line.lineNo,
    materialId: line.materialId,
    materialCode: line.materialCode,
    materialName: line.materialName,
    materialType,
    plantId,
    enterpriseId: pc.ctx.enterpriseId,
    warehouseId,
    warehouseCode: str(p, 'warehouseCode') ?? null,
    locationId,
    locationCode,
    uomId,
    uomCode,
    measurementBasis: str(p, 'measurementBasis') ?? 'nominal',
    inspectionStatus: batchInspectionStatus,
    receivedQty: totalQty,
    unitPrice,
    priceHistory: snapshot.history,
    avgPrice: snapshot.avgPrice,
    deviationPpm: snapshot.deviationPpm,
    priceFlag: snapshot.flag,
    arrivalTime,
    confirmTime,
    receivedBy: pc.ctx.actorLoginName,
    createdBy: pc.ctx.actorLoginName,
  })

  // 逐明细：核心收货入账同事务直调（A-4/DM §6 首行事务表；lineNo 逐明细递增）→ 明细落库 → 首检记录
  const detailResults: Array<{ detailId: string; unitId: string; unitNo: string }> = []
  for (const [index, d] of parsed.entries()) {
    const goods = await receiveGoods(pc, {
      plantId,
      lineNo: index + 1,
      quantity: d.quantity,
      uomId,
      uomCode,
      conversionRevisionId: d.conversionRevisionId ?? undefined,
      locationId: d.locationId,
      locationCode: d.locationCode,
      ownerId,
      ownerName,
      lotNo: batchNo,
      materialId: line.materialId,
      materialCode: line.materialCode,
      supplierLotNo: d.supplierLotNo || undefined,
      unitNo: `PUR-${batchNo}-${index + 1}`,
      measurementBasis: str(p, 'measurementBasis') ?? 'nominal',
      qualityStatus: mapDetailStatusToBalanceQuality(initialStatus),
      barcodeValue: barcodePlans[index]!.firstPurchaseReceipt ? d.barcodeValue : undefined,
      refType: 'purchase_receipt_batch',
      recordToColumns: true,
      reason: str(p, 'reason') ?? undefined,
    })
    const unitId = String(goods['unitId'])
    const detail = await tools.pur.details.insert({
      batchId: batch.id,
      barcodeValue: d.barcodeValue,
      supplierLotNo: d.supplierLotNo,
      grade: d.grade,
      productionDate: d.productionDate,
      quantity: d.quantity,
      packageQty: d.packageUnitQty,
      codeCount: d.codeCount,
      conversionRevisionId: d.conversionRevisionId,
      uomId,
      uomCode,
      qualityStatus: initialStatus,
      inventoryUnitId: unitId,
      locationId: d.locationId,
      locationCode: d.locationCode,
      note: d.note,
      createdBy: pc.ctx.actorLoginName,
    })
    // 首检记录 v1（A-7：需检→待质检、免检→免检；S14 版本链起点）
    await tools.pur.inspections.insert({
      batchId: batch.id,
      detailId: detail.id,
      barcodeValue: d.barcodeValue,
      inspectionType: 'first',
      version: 1,
      conclusion: initialStatus === 'exempt' ? 'exempt' : 'pending',
      isEffective: true,
      source: 'receive',
      commandReceiptId: pc.commandReceiptId,
      createdBy: pc.ctx.actorLoginName,
    })
    detailResults.push({ detailId: detail.id, unitId, unitNo: `PUR-${batchNo}-${index + 1}` })
  }

  // [A-1] 订单行回写：已收数量重算、状态重算、首/末到货日期
  const newReceived = addQty(line.receivedQty, totalQty)
  const newStatus = recalcOrderLineStatus({
    status: line.status,
    plannedQty: line.plannedQty,
    receivedQty: newReceived,
  })
  const arrivalDay = todayOf(confirmTime)
  await tools.pur.lines.updateReceiptState(
    line.id,
    {
      receivedQty: newReceived,
      status: newStatus,
      firstArrivalDate: line.firstArrivalDate ?? arrivalDay,
      lastArrivalDate: arrivalDay,
    },
    pc.ctx.actorLoginName,
  )

  // [A-11/IF-09] 免检批次 → 合格收货回传任务（需检批次待全部合格后于质检结论时生成）
  if (batchInspectionStatus === 'exempt') {
    await ensureQualifiedSyncTask(pc, batch.id)
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'purchase.receive-confirm',
    subjectType: 'purchase_receipt_batch',
    subjectId: batch.id,
    after: { batchNo, orderNo: line.orderNo, lineNo: line.lineNo, totalQty, details: detailResults.length, inspectionStatus: batchInspectionStatus },
    reason: str(p, 'reason') ?? null,
  })
  return {
    batchId: batch.id,
    batchNo,
    inspectionStatus: batchInspectionStatus,
    totalQty,
    lineStatus: newStatus,
    lineReceivedQty: newReceived,
    priceSnapshot: { avgPrice: snapshot.avgPrice, deviationPpm: snapshot.deviationPpm, priceFlag: snapshot.flag },
    details: detailResults,
  }
}

// ---------------- 命令：质检结论（A-7/S14 版本化追加） ----------------

/** 追加结论版本行并切换生效指针（S14：不清历史）。 */
async function appendInspectionVersion(
  pc: PostingContext,
  input: {
    batchId: string
    detailId: string
    barcodeValue: string
    inspectionType: 'first' | 're'
    conclusion: 'qualified' | 'unqualified'
    source: 'pda' | 'web' | 'judge'
  },
): Promise<void> {
  const tools = purchaseTools(pc)
  const chain = await tools.pur.inspections.listByDetailAndType(input.detailId, input.inspectionType)
  const version = nextInspectionVersion(chain.map((r) => r.version))
  const effective = chain.find((r) => r.isEffective)
  if (effective !== undefined) {
    await tools.pur.inspections.setEffective(effective.id, false, pc.ctx.actorLoginName)
  }
  await tools.pur.inspections.insert({
    batchId: input.batchId,
    detailId: input.detailId,
    barcodeValue: input.barcodeValue,
    inspectionType: input.inspectionType,
    version,
    conclusion: input.conclusion,
    isEffective: true,
    source: input.source,
    inspector: pc.ctx.actorLoginName,
    inspectedAt: pc.businessTime,
    commandReceiptId: pc.commandReceiptId,
    createdBy: pc.ctx.actorLoginName,
  })
}

async function locateDetail(
  pc: PostingContext,
  p: Payload,
): Promise<{ batch: PurchaseReceiptBatchRecord; detail: ReceiptDetailRecord }> {
  const tools = purchaseTools(pc)
  const batchId = str(p, 'batchId')
  const detailId = str(p, 'detailId')
  if (batchId !== undefined) {
    const batch = await lockScopedBatch(pc, batchId, str(p, 'plantId'))
    if (detailId !== undefined) {
      const detail = await tools.pur.details.findById(detailId)
      if (detail === null || detail.batchId !== batch.id) {
        throw new PurchaseRuleViolation(NOT_FOUND_RULE, '收货明细不存在或不属于该批次')
      }
      return { batch, detail }
    }
    const barcodeValue = str(p, 'barcodeValue')
    if (barcodeValue !== undefined) {
      const detail = await tools.pur.details.findByBarcode(batch.id, barcodeValue)
      if (detail === null) throw new PurchaseRuleViolation(NOT_FOUND_RULE, `批次内未找到二维码 ${barcodeValue} 的明细`)
      return { batch, detail }
    }
    throw new PurchaseRuleViolation('A-7', '定位明细须携带 detailId 或 barcodeValue')
  }
  if (detailId !== undefined) {
    const detail = await tools.pur.details.findById(detailId)
    if (detail === null) throw new PurchaseRuleViolation(NOT_FOUND_RULE, '收货明细不存在')
    const batch = await lockScopedBatch(pc, detail.batchId, str(p, 'plantId'))
    return { batch, detail }
  }
  throw new PurchaseRuleViolation('A-7', '定位明细须携带 batchId 或 detailId')
}

async function inspectionConclude(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = purchaseTools(pc)
  const mode = str(p, 'mode')
  if (mode !== 'code' && mode !== 'batch' && mode !== 'judge') {
    throw new PurchaseRuleViolation('A-7', "mode 必须为 'code'（PDA 单码）、'batch'（Web 批量质检）或 'judge'（整批判定）")
  }
  const conclusion = str(p, 'conclusion')
  if (conclusion !== 'qualified' && conclusion !== 'unqualified') {
    throw new PurchaseRuleViolation('A-7', "conclusion 必须为 'qualified' 或 'unqualified'")
  }

  const batchId = requireStr(p, 'batchId', 'purchase.inspection.conclude')
  const batch = await lockScopedBatch(pc, batchId, str(p, 'plantId'))

  let written = 0

  if (mode === 'code') {
    // [A-7] PDA 单码：可反复提交（后次覆盖=追加版本行）；免检码拒、已退货拒、复检优先
    const { detail } = await locateDetail(pc, p)
    const hasReinspection = (await tools.pur.inspections.listByDetailAndType(detail.id, 're')).length > 0
    const chain = resolveInspectionChainForCode({
      detailStatus: detail.qualityStatus,
      storageStatus: batch.storageStatus,
      hasReinspection,
    })
    await appendInspectionVersion(pc, {
      batchId: batch.id,
      detailId: detail.id,
      barcodeValue: detail.barcodeValue,
      inspectionType: chain,
      conclusion,
      source: 'pda',
    })
    await tools.pur.details.updateQualityStatus(detail.id, conclusion, pc.ctx.actorLoginName)
    written = 1
  } else if (mode === 'batch') {
    // [A-7] Web 质检/批量质检：只补仍待检码，不改已有结论
    assertWebInspectionExecutable({ batchStatus: batch.inspectionStatus, storageStatus: batch.storageStatus })
    const details = await tools.pur.details.listByBatch(batch.id)
    for (const d of details) {
      if (!shouldWebInspectionWriteCode(d.qualityStatus)) continue
      await appendInspectionVersion(pc, {
        batchId: batch.id,
        detailId: d.id,
        barcodeValue: d.barcodeValue,
        inspectionType: d.qualityStatus === 're_inspection' ? 're' : 'first',
        conclusion,
        source: 'web',
      })
      await tools.pur.details.updateQualityStatus(d.id, conclusion, pc.ctx.actorLoginName)
      written += 1
    }
    if (written === 0) {
      throw new PurchaseRuleViolation('A-7', '批次内无仍待检的码（已有结论的码不改），无可质检行')
    }
  } else {
    // [A-7] Web 判定：整批覆盖各码生效结论 + 判定记录（版本化，新覆盖旧）
    assertJudgeExecutable({ conclusion, batchStatus: batch.inspectionStatus, storageStatus: batch.storageStatus })
    const details = await tools.pur.details.listByBatch(batch.id)
    for (const d of details) {
      const hasReinspection = (await tools.pur.inspections.listByDetailAndType(d.id, 're')).length > 0
      const chain: 'first' | 're' = hasReinspection ? 're' : 'first'
      await appendInspectionVersion(pc, {
        batchId: batch.id,
        detailId: d.id,
        barcodeValue: d.barcodeValue,
        inspectionType: chain,
        conclusion,
        source: 'judge',
      })
      await tools.pur.details.updateQualityStatus(d.id, conclusion, pc.ctx.actorLoginName)
      written += 1
    }
    // 判定记录：同批次仅一条生效，新覆盖旧 = 版本追加 + 指针切换（S14）
    const existing = await tools.pur.judgements.listByBatch(batch.id)
    const version = nextInspectionVersion(existing.map((j) => j.version))
    for (const j of existing) {
      if (j.isEffective) await tools.pur.judgements.setEffective(j.id, false, pc.ctx.actorLoginName)
    }
    await tools.pur.judgements.insert({
      batchId: batch.id,
      version,
      conclusion,
      judgeBy: pc.ctx.actorLoginName,
      judgedAt: pc.businessTime,
      note: str(p, 'note') ?? null,
      commandReceiptId: pc.commandReceiptId,
    })
  }

  // 批次重汇总 + 库存质量状态更新（T12 闸门）
  const summary = await refreshBatchQualityState(pc, batch.id)
  // [A-11/IF-09] 全部合格 → 合格收货回传任务（仅一次）
  if (summary === 'all_qualified') {
    await ensureQualifiedSyncTask(pc, batch.id)
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'purchase.inspection.conclude',
    subjectType: 'purchase_receipt_batch',
    subjectId: batch.id,
    after: { mode, conclusion, written, inspectionStatus: summary },
    reason: str(p, 'note') ?? null,
  })
  return { batchId: batch.id, mode, conclusion, written, inspectionStatus: summary }
}

// ---------------- 命令：撤销质检（A-8/S14 保留历史、仅切生效指针） ----------------

async function inspectionRevoke(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = purchaseTools(pc)
  const { batch, detail } = await locateDetail(pc, p)
  const requestedType = str(p, 'inspectionType')
  const chain: 'first' | 're' =
    requestedType === 'first' || requestedType === 're'
      ? requestedType
      : detail.qualityStatus === 're_inspection'
        ? 're'
        : 'first'

  const chainRows = await tools.pur.inspections.listByDetailAndType(detail.id, chain)
  const effective = chainRows.find((r) => r.isEffective)
  if (effective === undefined) {
    throw new PurchaseRuleViolation('A-8', `该码 ${chain === 're' ? '复检' : '首检'}链无生效结论行`)
  }
  assertRevocationAllowed({
    effectiveConclusion: effective.conclusion,
    effectiveVersion: effective.version,
    storageStatus: batch.storageStatus,
  })

  // S14：保留历史，仅切生效指针 → 首检/复检链初始行（v1）
  const initialRow = chainRows.find((r) => r.version === 1)
  if (initialRow === undefined) {
    throw new PurchaseRuleViolation('A-8', '质检链初始记录缺失，无法回退')
  }
  await tools.pur.inspections.setEffective(effective.id, false, pc.ctx.actorLoginName)
  await tools.pur.inspections.setEffective(initialRow.id, true, pc.ctx.actorLoginName)

  const newStatus = revokedDetailStatus({ chain, initialConclusion: initialRow.conclusion })
  await tools.pur.details.updateQualityStatus(detail.id, newStatus, pc.ctx.actorLoginName)
  const summary = await refreshBatchQualityState(pc, batch.id)

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'purchase.inspection.revoke',
    subjectType: 'receipt_detail',
    subjectId: detail.id,
    before: { conclusion: effective.conclusion, version: effective.version, isEffective: true },
    after: { conclusion: initialRow.conclusion, version: 1, qualityStatus: newStatus, inspectionStatus: summary },
    reason: null,
  })
  return {
    detailId: detail.id,
    barcodeValue: detail.barcodeValue,
    chain,
    revokedVersion: effective.version,
    restoredVersion: 1,
    historyPreserved: chainRows.length,
    qualityStatus: newStatus,
    inspectionStatus: summary,
  }
}

// ---------------- 命令：发起复检（A-6 复检至多一次） ----------------

async function reinspectionStart(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = purchaseTools(pc)
  const items = p['items']
  if (!Array.isArray(items) || items.length === 0) {
    throw new PurchaseRuleViolation('A-6', '发起复检至少包含一个「二维码+批次」条目')
  }
  const results: Array<Record<string, unknown>> = []
  const touchedBatches = new Set<string>()
  for (const [index, raw] of items.entries()) {
    const item = (raw ?? {}) as Payload
    const batchId = str(item, 'batchId')
    const barcodeValue = str(item, 'barcodeValue')
    if (batchId === undefined || barcodeValue === undefined) {
      throw new PurchaseRuleViolation('A-6', `第 ${index + 1} 项缺少 batchId 或 barcodeValue`)
    }
    const batch = await lockScopedBatch(pc, batchId, str(item, 'plantId') ?? str(p, 'plantId'))
    const detail = await tools.pur.details.findByBarcode(batch.id, barcodeValue)
    if (detail === null) {
      throw new PurchaseRuleViolation(NOT_FOUND_RULE, `批次内未找到二维码 ${barcodeValue} 的明细`)
    }
    const hasReinspection = (await tools.pur.inspections.listByDetailAndType(detail.id, 're')).length > 0
    assertReinspectionStartable({
      detailStatus: detail.qualityStatus,
      hasReinspection,
      storageStatus: batch.storageStatus,
    })
    // 复检链 v1（待质检，发起质检时间=提交时间）；明细 → 待复检
    await tools.pur.inspections.insert({
      batchId: batch.id,
      detailId: detail.id,
      barcodeValue,
      inspectionType: 're',
      version: 1,
      conclusion: 'pending',
      isEffective: true,
      source: 'reinspection_start',
      commandReceiptId: pc.commandReceiptId,
      createdBy: pc.ctx.actorLoginName,
    })
    await tools.pur.details.updateQualityStatus(detail.id, 're_inspection', pc.ctx.actorLoginName)
    touchedBatches.add(batch.id)
    results.push({ detailId: detail.id, barcodeValue })
  }
  const summaries: Record<string, unknown> = {}
  for (const batchId of touchedBatches) {
    summaries[batchId] = await refreshBatchQualityState(pc, batchId)
  }
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'purchase.inspection.start-reinspection',
    subjectType: 'purchase_receipt_batch',
    subjectId: [...touchedBatches][0] ?? 'n/a',
    after: { items: results.length },
    reason: null,
  })
  return { items: results, batchInspectionStatus: summaries }
}

// ---------------- 命令：退货（A-9 反向流水 + 订单行扣减 + Outbox 退货同步） ----------------

async function returnBatch(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = purchaseTools(pc)
  const batchId = requireStr(p, 'batchId', 'purchase.return')
  const reason = str(p, 'reason')
  assertReturnReasonPresent(reason)
  const returnReason: string = reason ?? ''
  // PR02's row lock is held until the command UoW commits: waiting callers
  // re-read the batch state before any stock reversal or parent deduction.
  const batch = await lockScopedBatch(pc, batchId, str(p, 'plantId'))
  assertReturnExecutable({ batchInspectionStatus: batch.inspectionStatus, storageStatus: batch.storageStatus })

  const details = await tools.pur.details.listByBatch(batch.id)
  // 反向流水：锁全部库存单元（稳定次序 IT-15/27 口径）→ 每单元一笔 reverse 流水（IT-32 反向行）
  const unitIds = details.map((d) => d.inventoryUnitId).filter((id): id is string => id !== null)
  const locked = unitIds.length > 0 ? await tools.inv.units.lockForUpdate(ensureStableLockOrder(unitIds)) : []
  const unitMap = new Map(locked.map((u) => [u.id, u]))

  let lineNo = 0
  const lines: Array<{ unitId: string; unitNo: string; transactionId: string; qty: string }> = []
  for (const d of details) {
    if (d.inventoryUnitId === null) continue
    const unit = unitMap.get(d.inventoryUnitId)
    if (unit === undefined) {
      throw new PurchaseRuleViolation(NOT_FOUND_RULE, `明细 ${d.barcodeValue} 的库存单元不存在`)
    }
    if (d.batchId !== batch.id) throw new PurchaseRuleViolation('A-S1', '退货明细不属于实际批次')
    await assertPurchaseObjectScope(pc, unit, batch.plantId)
    if (unit.materialId !== batch.materialId) throw new PurchaseRuleViolation('A-S1', '退货单元与采购料品不一致')
    const balances = await tools.inv.balances.listActiveByUnit(unit.id)
    if (balances.some((b) => b.unitId !== unit.id || b.enterpriseId !== unit.enterpriseId || b.plantId !== unit.plantId)) {
      throw new PurchaseRuleViolation('A-S1', '退货单元与实际余额归属不一致')
    }
    if (balances.length === 0) continue // 该单元余额已关闭（历史退货/耗尽），无账可冲
    if (balances.length > 1) {
      throw new PurchaseRuleViolation('A-9', `库存单元 ${unit.unitNo} 存在多条活动余额，退货须逐键处置`)
    }
    const balance = balances[0]!
    lineNo += 1
    const delta = subQty('0.0000', balance.quantity) // 反向：余额全额冲回
    const line = buildPostingLine({
      lineNo,
      movementKind: 'reverse',
      beforeQty: balance.quantity,
      deltaQty: delta,
      uomId: balance.uomId,
    })
    const closes = zeroBalanceDisposition(line.afterQty) // IT-29：零余额关闭，身份与谱系保留
    const inserted = await tools.inv.transactions.insertLine({
      commandReceiptId: pc.commandReceiptId,
      lineNo,
      movementKind: 'reverse',
      unitId: unit.id,
      lotId: unit.lotId,
      balanceId: balance.id,
      fromLocationId: balance.locationId,
      fromLocationCode: balance.locationCode,
      fromOwnerId: balance.ownerId,
      fromOwnerName: balance.ownerName,
      quantity: delta,
      uomId: balance.uomId,
      uomCode: balance.uomCode,
      measurementBasis: balance.measurementBasis,
      conversionRevisionId: balance.conversionRevisionId,
      beforeQty: line.beforeQty,
      afterQty: line.afterQty,
      refType: 'purchase_receipt_batch',
      refId: batch.id,
      reason: `采购退货（批次 ${batch.batchNo}）`,
      businessTime: pc.businessTime,
      shiftDate: pc.shiftDate,
      plantId: unit.plantId,
      enterpriseId: unit.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
    await tools.inv.transactions.insertEntry({
      transactionId: inserted.id,
      entryNo: 1,
      balanceId: balance.id,
      unitId: unit.id,
      locationId: balance.locationId,
      locationCode: balance.locationCode,
      ownerId: balance.ownerId,
      ownerName: balance.ownerName,
      lotId: unit.lotId,
      quantityDelta: delta,
      beforeQty: line.beforeQty,
      afterQty: line.afterQty,
      purpose: 'purchase_return',
      plantId: unit.plantId,
      enterpriseId: unit.enterpriseId,
      createdBy: pc.ctx.actorLoginName,
    })
    await tools.inv.balances.adjust(
      balance.id,
      closes.closeBalance
        ? { quantity: line.afterQty, status: 'closed', closedAt: pc.businessTime }
        : { quantity: line.afterQty },
      pc.ctx.actorLoginName,
    )
    if (closes.closeBalance) {
      await tools.inv.units.updateStatus(
        unit.id,
        { status: 'exhausted', balanceOpen: false, balanceClosedAt: pc.businessTime },
        pc.ctx.actorLoginName,
      )
    }
    lines.push({ unitId: unit.id, unitNo: unit.unitNo, transactionId: inserted.id, qty: balance.quantity })
  }

  // 批次：已退货 + 入库数量置 0（A-9）
  const returnedQty = batch.receivedQty
  const transitioned = await tools.pur.batches.updateReturnState(
    batch.id,
    { storageStatus: 'returned', receivedQty: '0.0000', returnedAt: pc.businessTime, returnReason: returnReason },
    pc.ctx.actorLoginName,
  )
  if (transitioned === null) throw new PurchaseRuleViolation('A-9', '采购批次已退货或状态已变化，禁止重复扣减累计收货量')

  // [A-1] 订单行：已收扣减（退货剔除）+ 状态重算（ABS 收编：直调本域 deductOrderLineReceived 核心）
  const deducted = await deductOrderLineReceived(
    () => tools.pur.lines.lockById(batch.purchaseLineId),
    returnedQty,
    {
      policy: 'clamp-zero',
      write: (newReceived, newStatus) =>
        tools.pur.lines.updateReceiptState(batch.purchaseLineId, { receivedQty: newReceived, status: newStatus }, pc.ctx.actorLoginName),
      violation: (rule, message) => new PurchaseRuleViolation(rule, message),
    },
  )
  const newReceived = deducted.receivedQty
  const newStatus = deducted.status

  // [A-11/IF-10] 退货回传任务（时点快照：退货时点数量与原因）
  if (batch.returnSyncStatus === 'none') {
    pc.tools.outbox.collect({
      aggregateType: 'purchase_receipt_batch',
      aggregateId: batch.id,
      taskKind: 'return_sync',
      payload: {
        routeKey: 'return_callback',
        batchNo: batch.batchNo,
        orderNo: batch.orderNo,
        lineNo: batch.lineNo,
        materialCode: batch.materialCode,
        returnedQty,
        uomCode: batch.uomCode,
        reason,
        returnedAt: pc.businessTime,
        snapshotAt: pc.businessTime,
      },
    })
    await tools.pur.batches.markReturnSyncPending(batch.id, pc.ctx.actorLoginName)
  }

  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'purchase.return',
    subjectType: 'purchase_receipt_batch',
    subjectId: batch.id,
    before: { storageStatus: 'stored', receivedQty: returnedQty },
    after: { storageStatus: 'returned', receivedQty: '0.0000', lineReceivedQty: newReceived, lineStatus: newStatus },
    reason,
  })
  return {
    batchId: batch.id,
    batchNo: batch.batchNo,
    returnedQty,
    reverseLines: lines,
    lineReceivedQty: newReceived,
    lineStatus: newStatus,
  }
}

// ---------------- 命令：价格复核标记（A-10） ----------------

async function priceReviewConfirm(pc: PostingContext, p: Payload): Promise<Record<string, unknown>> {
  const tools = purchaseTools(pc)
  const batchId = requireStr(p, 'batchId', 'purchase.price-review.confirm')
  const batch = await lockScopedBatch(pc, batchId, str(p, 'plantId'))
  await assertPlantScope(pc, batch.plantId)
  // A-10：复核仅待复核且非退货批次；只改复核状态/人/时间；已复核不可撤销；不影响质检领料投料退货
  assertPriceReviewExecutable({ reviewStatus: batch.reviewStatus, storageStatus: batch.storageStatus })
  await tools.pur.batches.updateReview(
    batch.id,
    { reviewStatus: 'reviewed', reviewedBy: pc.ctx.actorLoginName, reviewedAt: pc.businessTime },
    pc.ctx.actorLoginName,
  )
  await pc.tools.audit.record({
    actor: pc.ctx.actorLoginName,
    action: 'purchase.price-review.confirm',
    subjectType: 'purchase_receipt_batch',
    subjectId: batch.id,
    before: { reviewStatus: 'pending' },
    after: { reviewStatus: 'reviewed', unitPrice: batch.unitPrice, avgPrice: batch.avgPrice, deviationPpm: batch.deviationPpm },
    reason: null,
  })
  return { batchId, reviewStatus: 'reviewed', reviewedBy: pc.ctx.actorLoginName, reviewedAt: pc.businessTime }
}

// ---------------- 处理器装配 ----------------

type PurchaseHandlerFn = (pc: PostingContext, p: Payload) => Promise<Record<string, unknown>>

/** 命令处理器清单（组合根装配进 PgCommandBus）。 */
export function createPurchaseCommandHandlers(): CommandHandler[] {
  const make = (commandType: string, fn: PurchaseHandlerFn): CommandHandler => ({
    commandType,
    handle: (envelope, ctx, tools): Promise<HandlerOutcome> =>
      run(async () => {
        const purchaseTools = tools as PurchaseCommandTools // 组合根构造的工具集窄化（见 purchase.composition）
        const payload = (envelope.payload ?? {}) as Payload
        const pc = await buildPostingContext(purchaseTools, ctx, commandType, envelope.operationId, payload)
        return fn(pc, payload)
      }),
  })

  return [
    make('purchase.order-sync', orderSync),
    make('purchase.receive-confirm', receiveConfirm),
    make('purchase.inspection.conclude', inspectionConclude),
    make('purchase.inspection.revoke', inspectionRevoke),
    make('purchase.inspection.start-reinspection', reinspectionStart),
    make('purchase.return', returnBatch),
    make('purchase.price-review.confirm', priceReviewConfirm),
  ]
}
