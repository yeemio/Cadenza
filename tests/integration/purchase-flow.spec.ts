import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext } from '@cadenza/application'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildPurchaseCommandBus } from '../../apps/api/src/purchase/purchase.composition'
import {
  PURCHASE_TEST_DB_NAME,
  nodeId,
  preparePurchaseTestDatabase,
} from '../api/purchase-test-env'

/**
 * 采购主链集成（真容器独立库 cadenza_pur + 真实命令总线与真实组合根，无桩）。
 * WorkItem 冻结七类证据：
 * ①确认收货后 库存余额/流水/批次/订单行 四账一致（数量逐层核对）
 * ②免检→直接可用 vs 需检→待检不可用（质量闸门消费侧：inventory.issue-material 断言）
 * ③重复 operationId 只入账一次
 * ④质检结论版本化（撤销后历史仍在、生效指针切换；含库级 S14 触发器拒改）
 * ⑤退货反向流水 + 已退不可再退
 * ⑥Outbox 合格/退货任务各一行（含时点快照）
 * （⑦跨厂 403 属 API 层，见 tests/api/purchase-api.spec.ts）
 * 另：A-3 超上限整单拒绝、A-2 码型/空码拒绝、S13 同码多批、A-10 价格快照、A-6 复检链。
 */

let pool: pg.Pool
let purchaseBus: ReturnType<typeof buildPurchaseCommandBus>
let inventoryBus: ReturnType<typeof buildInventoryCommandBus>
let adminCtx: CommandContext
let szPlantId = ''
let exemptMaterialId = ''
let qcMaterialId = ''
let dbAvailable = true
const run = `pur${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

const OWNER = '22222222-2222-4222-8222-222222222201'
const OWNER_NAME = '华东电缆集团（自有）'
const UOM = '33333333-3333-4333-8333-3333333333c1'
const WH = '55555555-5555-4555-8555-555555555501'
const LOC = '11111111-1111-4111-8111-1111111111a1'
const LOC_CODE = 'SZ01-01-01'

beforeAll(async () => {
  try {
    pool = await preparePurchaseTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP purchase-flow: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${PURCHASE_TEST_DB_NAME}）。`)
    return
  }
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  szPlantId = await nodeId(pool, 'PLNT-SZ')
  const byCode = await pool.query<{ code: string; id: string }>(
    `SELECT code, id FROM material WHERE code IN ('MAT-PUR-EXEMPT','MAT-PUR-QC')`,
  )
  exemptMaterialId = byCode.rows.find((r) => r.code === 'MAT-PUR-EXEMPT')!.id
  qcMaterialId = byCode.rows.find((r) => r.code === 'MAT-PUR-QC')!.id
  purchaseBus = buildPurchaseCommandBus(pool)
  inventoryBus = buildInventoryCommandBus(pool)
})

afterAll(async () => {
  if (pool) await pool.end() // 独立库每轮 DROP+CREATE 重建，无须细清痕迹
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

let opSeq = 0
function nextOp(tag: string): string {
  opSeq += 1
  return `${run}-${tag}-${opSeq}`
}

function envelope(operationId: string, commandType: string, payload: Record<string, unknown>): CommandEnvelope {
  return { operationId, commandType, targetId: 'new', expectedRevision: 0, payload }
}

async function exec(
  bus: ReturnType<typeof buildPurchaseCommandBus> | ReturnType<typeof buildInventoryCommandBus>,
  operationId: string,
  commandType: string,
  payload: Record<string, unknown>,
  ctx: CommandContext = adminCtx,
): Promise<CommandResult> {
  return bus.execute(envelope(operationId, commandType, payload), ctx)
}

/** 模拟 ERP 订单同步（IF-08）。 */
async function syncOrder(
  orderNo: string,
  materialId: string,
  materialCode: string,
  plannedQty: string,
  overReceiptLimit: string,
): Promise<{ orderId: string; lineId: string }> {
  const res = await exec(purchaseBus, nextOp('sync'), 'purchase.order-sync', {
    orgCode: 'ORG-ERP-HD',
    orderNo,
    plantId: szPlantId,
    supplierName: '演示供应商',
    contractNo: `CT-${run}`,
    externalRevision: 1,
    lines: [
      {
        lineNo: 1,
        materialId,
        materialCode,
        materialType: 1,
        uomCode: 'KG',
        plannedQty,
        overReceiptLimit,
        status: 1,
      },
    ],
  })
  expect(res.status).toBe(CommandResultStatus.COMMITTED)
  const data = res.data as { orderId: string; lines: Array<{ lineId: string }> }
  return { orderId: data.orderId, lineId: data.lines[0]!.lineId }
}

/** 确认收货。 */
async function receiveConfirm(
  operationId: string,
  lineId: string,
  details: Array<{ barcodeValue: string; quantity: string; supplierLotNo?: string; grade?: string }>,
  overrides: Record<string, unknown> = {},
): Promise<CommandResult> {
  return exec(purchaseBus, operationId, 'purchase.receive-confirm', {
    plantId: szPlantId,
    orderLineId: lineId,
    arrivalTime: '2026-10-27T08:00:00.000Z',
    confirmTime: '2026-10-27T09:00:00.000Z',
    warehouseId: WH,
    warehouseCode: 'SZ-RAW-01',
    locationId: LOC,
    locationCode: LOC_CODE,
    ownerId: OWNER,
    ownerName: OWNER_NAME,
    uomId: UOM,
    uomCode: 'KG',
    details,
    ...overrides,
  })
}

describe('① 确认收货四账一致（A-4/DM §6 首行事务表；数量逐层核对）', () => {
  const barcode1 = `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '1')}`
  const barcode2 = `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '2')}`
  let lineId = ''

  it('同步订单 → 收货 2 明细（30+20）→ 批次/明细/余额/流水/订单行逐层数量一致', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const order = await syncOrder(`PO-${run}-QC1`, qcMaterialId, 'MAT-PUR-QC', '80.0000', '100.0000')
    lineId = order.lineId

    const received = await receiveConfirm(nextOp('rcv1'), lineId, [
      { barcodeValue: barcode1, quantity: '30.0000', supplierLotNo: `SL-${run}`, grade: 'TG-1' },
      { barcodeValue: barcode2, quantity: '20.0000', supplierLotNo: `SL-${run}`, grade: 'TG-2' },
    ], { unitPrice: '100.0000' })
    expect(received.status).toBe(CommandResultStatus.COMMITTED)
    const data = received.data as { batchId: string; batchNo: string; totalQty: string; inspectionStatus: string; lineStatus: number }
    expect(data.totalQty).toBe('50.0000')
    expect(data.inspectionStatus).toBe('pending') // 需检料 → 待质检（A-4/A-6）

    // 批次账：received_qty=50、待质检
    const batch = await pool.query<{ received_qty: string; inspection_status: string; storage_status: string }>(
      `SELECT received_qty::text AS received_qty, inspection_status, storage_status
       FROM purchase_receipt_batch WHERE id = $1`,
      [data.batchId],
    )
    expect(batch.rows[0]!.received_qty).toBe('50.0000')
    expect(batch.rows[0]!.inspection_status).toBe('pending')
    expect(batch.rows[0]!.storage_status).toBe('stored')

    // 明细账：2 行、数量 30/20、待检、首检记录 v1 各一条
    const details = await pool.query<{ quantity: string; quality_status: string }>(
      `SELECT quantity::text AS quantity, quality_status FROM receipt_detail WHERE batch_id = $1 ORDER BY quantity DESC`,
      [data.batchId],
    )
    expect(details.rows).toHaveLength(2)
    expect(details.rows.map((d) => d.quantity)).toEqual(['30.0000', '20.0000'])
    expect(details.rows.every((d) => d.quality_status === 'pending_inspection')).toBe(true)
    const firstInspections = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM inspection_record WHERE batch_id = $1 AND inspection_type = 'first' AND version = 1`,
      [data.batchId],
    )
    expect(firstInspections.rows[0]!.n).toBe(2)

    // 库存账：2 单元余额 30/20、质量待检（T12 闸门：待检不可用）
    const balances = await pool.query<{ quantity: string; quality_status: string }>(
      `SELECT sb.quantity::text AS quantity, sb.quality_status
       FROM stock_balance sb JOIN receipt_detail rd ON rd.inventory_unit_id = sb.unit_id
       WHERE rd.batch_id = $1 ORDER BY sb.quantity DESC`,
      [data.batchId],
    )
    expect(balances.rows.map((b) => b.quantity)).toEqual(['30.0000', '20.0000'])
    expect(balances.rows.every((b) => b.quality_status === 'pending_inspection')).toBe(true)

    // 流水账：receive 2 行（扣前 0、扣后 30/20）、引用本采购命令回执
    const transactions = await pool.query<{ movement_kind: string; before_qty: string; after_qty: string; op: string }>(
      `SELECT st.movement_kind, st.before_qty::text AS before_qty, st.after_qty::text AS after_qty,
              cr.operation_id AS op
       FROM stock_transaction st JOIN command_receipt cr ON cr.id = st.command_receipt_id
       WHERE st.movement_kind = 'receive' AND cr.operation_id = $1
       ORDER BY st.after_qty DESC`,
      [received.operationId],
    )
    expect(transactions.rows).toHaveLength(2)
    expect(transactions.rows.map((t) => t.after_qty)).toEqual(['30.0000', '20.0000'])
    expect(transactions.rows.every((t) => t.before_qty === '0.0000' && t.movement_kind === 'receive')).toBe(true)

    // 订单行账：已收 50、状态部分收货(2)、首/末到货日期（A-1）
    const line = await pool.query<{ received_qty: string; status: number; first_arrival_date: string | null; last_arrival_date: string | null }>(
      `SELECT received_qty::text AS received_qty, status, first_arrival_date::text AS first_arrival_date,
              last_arrival_date::text AS last_arrival_date
       FROM purchase_order_line WHERE id = $1`,
      [lineId],
    )
    expect(line.rows[0]!.received_qty).toBe('50.0000')
    expect(line.rows[0]!.status).toBe(2)
    expect(line.rows[0]!.first_arrival_date).toBe('2026-10-27')
    expect(line.rows[0]!.last_arrival_date).toBe('2026-10-27')

    // 数量逐层守恒：Σ明细 = 批次 = 订单行已收 = Σ余额 = Σ流水扣后
    const sumDetail = details.rows.reduce((acc, d) => acc + Number(d.quantity), 0)
    const sumBalance = balances.rows.reduce((acc, b) => acc + Number(b.quantity), 0)
    const sumTx = transactions.rows.reduce((acc, t) => acc + Number(t.after_qty), 0)
    expect(sumDetail).toBe(50)
    expect(sumBalance).toBe(50)
    expect(sumTx).toBe(50)
    expect(Number(line.rows[0]!.received_qty)).toBe(50)
  })
})

describe('② 质量闸门消费侧（A-4：免检直接可用 vs 需检待检不可用）', () => {
  it('免检批收货 → inventory 发料成功；需检批收货 → 发料被 IT-14 拒绝（待检不可用）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 免检料订单 + 收货 40
    const orderEx = await syncOrder(`PO-${run}-EX1`, exemptMaterialId, 'MAT-PUR-EXEMPT', '60.0000', '70.0000')
    const barcodeEx = `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '3')}`
    const exemptReceipt = await receiveConfirm(nextOp('rcv-ex'), orderEx.lineId, [
      { barcodeValue: barcodeEx, quantity: '40.0000' },
    ], { unitPrice: '90.0000' })
    expect(exemptReceipt.status).toBe(CommandResultStatus.COMMITTED)
    const exemptData = exemptReceipt.data as { batchId: string; inspectionStatus: string; details: Array<{ unitId: string }> }
    expect(exemptData.inspectionStatus).toBe('exempt') // 免检 → 批次免检

    // 免检单元余额质量 = qualified（直接可用）→ 消费侧发料 40 成功
    const exemptUnit = exemptData.details[0]!.unitId
    const issueOk = await exec(inventoryBus, nextOp('issue-ex'), 'inventory.issue-material', {
      unitId: exemptUnit,
      quantity: '40.0000',
      reason: '免检料直接投用（质量闸门证据）',
    })
    expect(issueOk.status).toBe(CommandResultStatus.COMMITTED)

    // 需检批（①的批次）：待检不可用 → 发料拒绝 ERR_INSUFFICIENT_STOCK
    const qcDetails = await pool.query<{ inventory_unit_id: string }>(
      `SELECT rd.inventory_unit_id FROM receipt_detail rd
       JOIN purchase_receipt_batch b ON b.id = rd.batch_id
       JOIN purchase_order_line l ON l.id = b.purchase_line_id
       WHERE l.order_no = $1 ORDER BY rd.quantity DESC LIMIT 1`,
      [`PO-${run}-QC1`],
    )
    const qcUnit = qcDetails.rows[0]!.inventory_unit_id
    const issueDenied = await exec(inventoryBus, nextOp('issue-qc'), 'inventory.issue-material', {
      unitId: qcUnit,
      quantity: '5.0000',
    })
    expect(issueDenied.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(issueDenied.errorCode).toBe(ERROR_CODES.INSUFFICIENT_STOCK)
    expect(issueDenied.errorMessage).toContain('IT-14') // 质量不满足 → 可用量 0
  })
})

describe('③ 重复 operationId 只入账一次（IF-00.2/IT-21 同口径）', () => {
  it('同 operationId 重放确认收货 → 原结果回放；批次/明细/流水/余额行数不变', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const order = await syncOrder(`PO-${run}-IDEM`, qcMaterialId, 'MAT-PUR-QC', '80.0000', '100.0000')
    const barcode = `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '4')}`
    const operationId = nextOp('idem')
    const payloadDetails = [{ barcodeValue: barcode, quantity: '25.0000' }]
    const first = await receiveConfirm(operationId, order.lineId, payloadDetails)
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const firstData = first.data as { batchId: string; batchNo: string }

    const replay = await receiveConfirm(operationId, order.lineId, payloadDetails)
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect((replay.data as { batchNo: string }).batchNo).toBe(firstData.batchNo)

    const counts = await pool.query<{ batches: number; details: number; units: number; tx: number; receipts: number }>(
      `SELECT
         (SELECT count(*)::int FROM purchase_receipt_batch WHERE batch_no = $1) AS batches,
         (SELECT count(*)::int FROM receipt_detail WHERE batch_id = $2) AS details,
         (SELECT count(*)::int FROM receipt_detail WHERE batch_id = $2 AND inventory_unit_id IS NOT NULL) AS units,
         (SELECT count(*)::int FROM stock_transaction st JOIN command_receipt cr ON cr.id = st.command_receipt_id
            WHERE cr.operation_id = $3) AS tx,
         (SELECT count(*)::int FROM command_receipt WHERE operation_id = $3) AS receipts`,
      [firstData.batchNo, firstData.batchId, operationId],
    )
    expect(counts.rows[0]!.batches).toBe(1)
    expect(counts.rows[0]!.details).toBe(1)
    expect(counts.rows[0]!.units).toBe(1)
    expect(counts.rows[0]!.tx).toBe(1) // 重放不产生第二条流水
    expect(counts.rows[0]!.receipts).toBe(1)
  })
})

describe('④ 质检结论版本化（A-7/A-8/S14：撤销后历史仍在、生效指针切换）', () => {
  it('PDA 合格→不合格→撤销：版本链 v1/v2/v3 全保留、生效切回 v1、明细回待检、批次重汇总', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const order = await syncOrder(`PO-${run}-VER`, qcMaterialId, 'MAT-PUR-QC', '80.0000', '100.0000')
    const barcode = `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '5')}`
    const received = await receiveConfirm(nextOp('rcv-ver'), order.lineId, [{ barcodeValue: barcode, quantity: '10.0000' }])
    expect(received.status).toBe(CommandResultStatus.COMMITTED)
    const batchId = (received.data as { batchId: string }).batchId
    const detailIdRow = await pool.query<{ id: string }>(
      `SELECT id FROM receipt_detail WHERE batch_id = $1`,
      [batchId],
    )
    const detailId = detailIdRow.rows[0]!.id

    // PDA 单码合格（v2）
    const pass = await exec(purchaseBus, nextOp('qc-pass'), 'purchase.inspection.conclude', {
      batchId,
      mode: 'code',
      barcodeValue: barcode,
      conclusion: 'qualified',
    })
    expect(pass.status).toBe(CommandResultStatus.COMMITTED)
    // PDA 同码不合格（v3，后次覆盖=追加版本）
    const fail = await exec(purchaseBus, nextOp('qc-fail'), 'purchase.inspection.conclude', {
      batchId,
      mode: 'code',
      barcodeValue: barcode,
      conclusion: 'unqualified',
    })
    expect(fail.status).toBe(CommandResultStatus.COMMITTED)
    let chain = await pool.query<{ version: number; conclusion: string; is_effective: boolean }>(
      `SELECT version, conclusion, is_effective FROM inspection_record
       WHERE detail_id = $1 AND inspection_type = 'first' ORDER BY version`,
      [detailId],
    )
    expect(chain.rows.map((r) => r.version)).toEqual([1, 2, 3])
    expect(chain.rows[2]!.is_effective).toBe(true)

    // 撤销：仅切生效指针 → v1（pending）；历史 v2/v3 保留（S14）
    const revoke = await exec(purchaseBus, nextOp('qc-revoke'), 'purchase.inspection.revoke', { detailId })
    expect(revoke.status).toBe(CommandResultStatus.COMMITTED)
    const revokeData = revoke.data as { revokedVersion: number; restoredVersion: number; historyPreserved: number; qualityStatus: string }
    expect(revokeData.revokedVersion).toBe(3)
    expect(revokeData.restoredVersion).toBe(1)
    expect(revokeData.historyPreserved).toBe(3)
    expect(revokeData.qualityStatus).toBe('pending_inspection')

    chain = await pool.query<{ version: number; conclusion: string; is_effective: boolean }>(
      `SELECT version, conclusion, is_effective FROM inspection_record
       WHERE detail_id = $1 AND inspection_type = 'first' ORDER BY version`,
      [detailId],
    )
    expect(chain.rows).toHaveLength(3) // 历史仍在（判定/撤销不清历史）
    expect(chain.rows[0]!.is_effective).toBe(true) // 生效指针切回 v1
    expect(chain.rows[1]!.is_effective).toBe(false)
    expect(chain.rows[2]!.conclusion).toBe('unqualified') // 被撤销的结论保留可追溯
    const batch = await pool.query<{ inspection_status: string }>(
      `SELECT inspection_status FROM purchase_receipt_batch WHERE id = $1`,
      [batchId],
    )
    expect(batch.rows[0]!.inspection_status).toBe('pending') // 批次重汇总会待质检

    // 库级 S14 守卫：改事实列 / 删除历史行均被触发器拒绝（同值无操作不拦，改结论事实必拦）
    const mutation = await pool
      .query(`UPDATE inspection_record SET conclusion = 'pending' WHERE detail_id = $1 AND version = 2`, [detailId])
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    expect(mutation).toContain('A-S14')
    const deletion = await pool
      .query(`DELETE FROM inspection_record WHERE detail_id = $1`, [detailId])
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    expect(deletion).toContain('A-S14')

    // Web 批量质检合格（仍待检码补结论 → 全部合格；A-7 只补待检不改已有）
    const web = await exec(purchaseBus, nextOp('qc-web'), 'purchase.inspection.conclude', {
      batchId,
      mode: 'batch',
      conclusion: 'qualified',
    })
    expect(web.status).toBe(CommandResultStatus.COMMITTED)
    expect((web.data as { inspectionStatus: string }).inspectionStatus).toBe('all_qualified')
    const finalChain = await pool.query<{ version: number; conclusion: string; is_effective: boolean }>(
      `SELECT version, conclusion, is_effective FROM inspection_record
       WHERE detail_id = $1 AND inspection_type = 'first' ORDER BY version`,
      [detailId],
    )
    expect(finalChain.rows).toHaveLength(4) // v4 追加（web），v1-v3 历史不动
    expect(finalChain.rows[3]!.is_effective).toBe(true)
    expect(finalChain.rows[0]!.is_effective).toBe(false)
  })
})

describe('⑤ 退货反向流水 + 已退不可再退（A-9）', () => {
  it('全部不合格 → 退货：reverse 流水冲平、余额关闭、批次置 0、订单行扣减；再退拒绝', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const order = await syncOrder(`PO-${run}-RET`, qcMaterialId, 'MAT-PUR-QC', '60.0000', '60.0000')
    const b1 = `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '6')}`
    const b2 = `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '7')}`
    const received = await receiveConfirm(nextOp('rcv-ret'), order.lineId, [
      { barcodeValue: b1, quantity: '20.0000' },
      { barcodeValue: b2, quantity: '30.0000' },
    ])
    expect(received.status).toBe(CommandResultStatus.COMMITTED)
    const batchId = (received.data as { batchId: string }).batchId

    // Web 批量质检全部不合格 → all_unqualified
    const fail = await exec(purchaseBus, nextOp('ret-qc'), 'purchase.inspection.conclude', {
      batchId,
      mode: 'batch',
      conclusion: 'unqualified',
    })
    expect(fail.status).toBe(CommandResultStatus.COMMITTED)
    expect((fail.data as { inspectionStatus: string }).inspectionStatus).toBe('all_unqualified')

    // 退货
    const returned = await exec(purchaseBus, nextOp('ret'), 'purchase.return', {
      batchId,
      reason: '来料全部不合格，整批退回供应商',
    })
    expect(returned.status).toBe(CommandResultStatus.COMMITTED)

    // 反向流水：2 行 reverse，扣前=原量、扣后=0（IT-32 反向行；IT-19 含扣前扣后）
    const reverseLines = await pool.query<{ movement_kind: string; before_qty: string; after_qty: string; ref_type: string }>(
      `SELECT movement_kind, before_qty::text AS before_qty, after_qty::text AS after_qty, ref_type
       FROM stock_transaction st JOIN command_receipt cr ON cr.id = st.command_receipt_id
       WHERE cr.operation_id = $1 ORDER BY st.before_qty DESC`,
      [returned.operationId],
    )
    expect(reverseLines.rows).toHaveLength(2)
    expect(reverseLines.rows.every((r) => r.movement_kind === 'reverse' && r.after_qty === '0.0000' && r.ref_type === 'purchase_receipt_batch')).toBe(true)
    expect(reverseLines.rows.map((r) => r.before_qty)).toEqual(['30.0000', '20.0000'])

    // 余额关闭 + 单元耗尽（IT-29：身份与谱系保留）
    const units = await pool.query<{ bal_status: string; unit_status: string; bal_qty: string }>(
      `SELECT sb.status AS bal_status, sb.quantity::text AS bal_qty, iu.status AS unit_status
       FROM receipt_detail rd
       JOIN stock_balance sb ON sb.unit_id = rd.inventory_unit_id
       JOIN inventory_unit iu ON iu.id = rd.inventory_unit_id
       WHERE rd.batch_id = $1`,
      [batchId],
    )
    expect(units.rows).toHaveLength(2)
    expect(units.rows.every((u) => u.bal_status === 'closed' && u.bal_qty === '0.0000' && u.unit_status === 'exhausted')).toBe(true)

    // 批次已退货 + 入库数量置 0；订单行已收扣减并重算（A-1 退货剔除）
    const batch = await pool.query<{ storage_status: string; received_qty: string; returned_at: string | null }>(
      `SELECT storage_status, received_qty::text AS received_qty, returned_at FROM purchase_receipt_batch WHERE id = $1`,
      [batchId],
    )
    expect(batch.rows[0]!.storage_status).toBe('returned')
    expect(batch.rows[0]!.received_qty).toBe('0.0000')
    expect(batch.rows[0]!.returned_at).not.toBeNull()
    const line = await pool.query<{ received_qty: string; status: number }>(
      `SELECT received_qty::text AS received_qty, status FROM purchase_order_line WHERE id = $1`,
      [order.lineId],
    )
    expect(line.rows[0]!.received_qty).toBe('0.0000')
    expect(line.rows[0]!.status).toBe(1) // 50→0 → 待收货（重算回落）

    // 已退不可再退
    const again = await exec(purchaseBus, nextOp('ret-again'), 'purchase.return', { batchId, reason: '再次退货应被拒绝' })
    expect(again.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(again.errorMessage).toContain('A-9')
  })
})

describe('⑥ Outbox 合格/退货任务各一行（A-11/IF-09/10，含时点快照）', () => {
  it('免检批与全合格批 → qualified_sync 各 1 行；退货批 → return_sync 1 行；快照字段在位', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 免检批次（②已收货，批次即免检 → 收货时生成任务）
    const exemptBatch = await pool.query<{ id: string; batch_no: string }>(
      `SELECT b.id, b.batch_no FROM purchase_receipt_batch b
       JOIN purchase_order_line l ON l.id = b.purchase_line_id
       WHERE l.order_no = $1`,
      [`PO-${run}-EX1`],
    )
    const exemptBatchId = exemptBatch.rows[0]!.id
    const qualifiedTasks = await pool.query<{ task_kind: string; status: string; payload: Record<string, unknown> }>(
      `SELECT task_kind, status, payload FROM outbox
       WHERE aggregate_type = 'purchase_receipt_batch' AND aggregate_id = $1`,
      [exemptBatchId],
    )
    expect(qualifiedTasks.rows).toHaveLength(1)
    expect(qualifiedTasks.rows[0]!.task_kind).toBe('qualified_sync')
    expect(qualifiedTasks.rows[0]!.status).toBe('PENDING')
    expect(qualifiedTasks.rows[0]!.payload['routeKey']).toBe('receipt_callback')
    expect(qualifiedTasks.rows[0]!.payload['batchNo']).toBe(exemptBatch.rows[0]!.batch_no)
    expect(qualifiedTasks.rows[0]!.payload['quantity']).toBe('40.0000') // 时点快照
    expect(qualifiedTasks.rows[0]!.payload['unitPrice']).toBe('90.0000')

    // 全合格批次（④批次 web 质检后 all_qualified → 生成任务）
    const verBatch = await pool.query<{ id: string }>(
      `SELECT b.id FROM purchase_receipt_batch b
       JOIN purchase_order_line l ON l.id = b.purchase_line_id
       WHERE l.order_no = $1`,
      [`PO-${run}-VER`],
    )
    const verTasks = await pool.query<{ task_kind: string }>(
      `SELECT task_kind FROM outbox
       WHERE aggregate_type = 'purchase_receipt_batch' AND aggregate_id = $1`,
      [verBatch.rows[0]!.id],
    )
    expect(verTasks.rows).toHaveLength(1)
    expect(verTasks.rows[0]!.task_kind).toBe('qualified_sync')

    // 退货批次 → return_sync 1 行（⑤批次）
    const retBatch = await pool.query<{ id: string }>(
      `SELECT b.id FROM purchase_receipt_batch b
       JOIN purchase_order_line l ON l.id = b.purchase_line_id
       WHERE l.order_no = $1`,
      [`PO-${run}-RET`],
    )
    const retTasks = await pool.query<{ task_kind: string; payload: Record<string, unknown> }>(
      `SELECT task_kind, payload FROM outbox
       WHERE aggregate_type = 'purchase_receipt_batch' AND aggregate_id = $1`,
      [retBatch.rows[0]!.id],
    )
    expect(retTasks.rows).toHaveLength(1)
    expect(retTasks.rows[0]!.task_kind).toBe('return_sync')
    expect(retTasks.rows[0]!.payload['routeKey']).toBe('return_callback')
    expect(retTasks.rows[0]!.payload['returnedQty']).toBe('50.0000') // 退货时点数量快照
    expect(String(retTasks.rows[0]!.payload['reason'])).toContain('整批退回')

    // 两流并行分存（IF-00.5）：合格/退货为同聚合不同任务种类，互不覆盖
    const allTasks = await pool.query<{ task_kind: string }>(
      `SELECT task_kind FROM outbox WHERE aggregate_type = 'purchase_receipt_batch'`,
    )
    expect(allTasks.rows.filter((t) => t.task_kind === 'qualified_sync').length).toBeGreaterThanOrEqual(2)
    expect(allTasks.rows.filter((t) => t.task_kind === 'return_sync').length).toBeGreaterThanOrEqual(1)
  })
})

describe('补充证据：A-2/A-3/S13/A-10/A-6 拒绝与扩展路径', () => {
  it('A-3：已收+本次 > 采购上限 → 整单拒绝（无批次/明细/流水产生）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const order = await syncOrder(`PO-${run}-LIM`, qcMaterialId, 'MAT-PUR-QC', '50.0000', '60.0000')
    await receiveConfirm(nextOp('lim-1'), order.lineId, [
      { barcodeValue: `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '8')}`, quantity: '50.0000' },
    ])
    const over = await receiveConfirm(nextOp('lim-2'), order.lineId, [
      { barcodeValue: `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '9')}`, quantity: '20.0000' },
    ])
    expect(over.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(over.errorMessage).toContain('A-3')
    const batches = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM purchase_receipt_batch b
       JOIN purchase_order_line l ON l.id = b.purchase_line_id WHERE l.id = $1`,
      [order.lineId],
    )
    expect(batches.rows[0]!.n).toBe(1) // 仅第一批；超限批次未产生
  })

  it('A-2：原料行扫 E 码（成品码）拒绝；ERP 已完成行冻结拒绝收货', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const order = await syncOrder(`PO-${run}-CODE`, qcMaterialId, 'MAT-PUR-QC', '80.0000', '100.0000')
    const wrongKind = await receiveConfirm(nextOp('code-x'), order.lineId, [
      { barcodeValue: 'E123456789', quantity: '10.0000' },
    ])
    expect(wrongKind.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(wrongKind.errorMessage).toContain('A-2')

    // ERP 已完成行（status=5）冻结
    const closed = await exec(purchaseBus, nextOp('sync-closed'), 'purchase.order-sync', {
      orgCode: 'ORG-ERP-HD',
      orderNo: `PO-${run}-CLOSED`,
      plantId: szPlantId,
      lines: [{ lineNo: 1, materialId: qcMaterialId, materialCode: 'MAT-PUR-QC', plannedQty: '10.0000', status: 5 }],
    })
    expect(closed.status).toBe(CommandResultStatus.COMMITTED)
    const closedLineId = (closed.data as { lines: Array<{ lineId: string }> }).lines[0]!.lineId
    const frozen = await receiveConfirm(nextOp('frozen'), closedLineId, [
      { barcodeValue: 'R098765432', quantity: '5.0000' },
    ])
    expect(frozen.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(frozen.errorMessage).toContain('A-1')
  })

  it('S13：同码第二次收货合法（一码多批）；价格快照近 5 次口径（A-10）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const order = await syncOrder(`PO-${run}-S13`, exemptMaterialId, 'MAT-PUR-EXEMPT', '60.0000', '70.0000')
    const sameBarcode = `R${run.replace(/[^0-9]/g, '').slice(0, 8).padEnd(8, '0')}1`
    const first = await receiveConfirm(nextOp('s13-1'), order.lineId, [{ barcodeValue: sameBarcode, quantity: '10.0000' }], { unitPrice: '90.0000' })
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const second = await receiveConfirm(nextOp('s13-2'), order.lineId, [{ barcodeValue: sameBarcode, quantity: '20.0000' }], { unitPrice: '100.0000' })
    expect(second.status).toBe(CommandResultStatus.COMMITTED) // 同码多批合法，不因既有绑定拒绝

    // 活动绑定仍只有 1 条（首收绑定；二收数量入新单元）
    const bindings = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM barcode_binding WHERE barcode_value = $1 AND active`,
      [sameBarcode],
    )
    expect(bindings.rows[0]!.n).toBe(1)
    const secondData = second.data as { batchId: string; details: Array<{ unitId: string }> }
    const firstData = first.data as { details: Array<{ unitId: string }> }
    expect(secondData.details[0]!.unitId).not.toBe(firstData.details[0]!.unitId) // 新库存单元

    // 价格快照：第二批历史=同物料+组织近 5 次有单价已入库批次（②批次 90 与本批一批 90）→ 均价 90、浮动 +11.11%
    const batch2 = await pool.query<{ avg_price: string; deviation_ppm: number; price_flag: string; price_history: Array<{ price: string }> }>(
      `SELECT avg_price::text AS avg_price, deviation_ppm, price_flag, price_history
       FROM purchase_receipt_batch WHERE id = $1`,
      [secondData.batchId],
    )
    expect(batch2.rows[0]!.avg_price).toBe('90.0000')
    expect(batch2.rows[0]!.deviation_ppm).toBe(111111)
    expect(batch2.rows[0]!.price_flag).toBe('up')
    expect(batch2.rows[0]!.price_history).toHaveLength(2) // ②免检批（90）+ 本批第一批（90）

    // 订单行汇总两批：30 → 部分收货（60 计划）
    const line = await pool.query<{ received_qty: string; status: number }>(
      `SELECT received_qty::text AS received_qty, status FROM purchase_order_line WHERE id = $1`,
      [order.lineId],
    )
    expect(line.rows[0]!.received_qty).toBe('30.0000')
    expect(line.rows[0]!.status).toBe(2)
  })

  it('A-6：不合格 → 发起复检（待复检）→ 复检合格；复检至多一次', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const order = await syncOrder(`PO-${run}-RE`, qcMaterialId, 'MAT-PUR-QC', '40.0000', '40.0000')
    const barcode = `R${run.replace(/[^0-9]/g, '').slice(0, 8).padEnd(8, '2')}2`
    const received = await receiveConfirm(nextOp('re-r'), order.lineId, [{ barcodeValue: barcode, quantity: '40.0000' }])
    const batchId = (received.data as { batchId: string }).batchId
    await exec(purchaseBus, nextOp('re-qc'), 'purchase.inspection.conclude', {
      batchId, mode: 'code', barcodeValue: barcode, conclusion: 'unqualified',
    })
    // 发起复检 → 明细待复检、批次质检中
    const start = await exec(purchaseBus, nextOp('re-start'), 'purchase.inspection.start-reinspection', {
      items: [{ batchId, barcodeValue: barcode }],
    })
    expect(start.status).toBe(CommandResultStatus.COMMITTED)
    const detail = await pool.query<{ quality_status: string }>(
      `SELECT quality_status FROM receipt_detail WHERE batch_id = $1`,
      [batchId],
    )
    expect(detail.rows[0]!.quality_status).toBe('re_inspection')
    const batch = await pool.query<{ inspection_status: string }>(
      `SELECT inspection_status FROM purchase_receipt_batch WHERE id = $1`,
      [batchId],
    )
    expect(batch.rows[0]!.inspection_status).toBe('in_progress')

    // 复检结论（走复检链）：PDA 提交 → 合格
    const conclude = await exec(purchaseBus, nextOp('re-pass'), 'purchase.inspection.conclude', {
      batchId, mode: 'code', barcodeValue: barcode, conclusion: 'qualified',
    })
    expect(conclude.status).toBe(CommandResultStatus.COMMITTED)
    expect((conclude.data as { inspectionStatus: string }).inspectionStatus).toBe('all_qualified')

    // 复检至多一次：再次发起 → 拒绝
    const again = await exec(purchaseBus, nextOp('re-again'), 'purchase.inspection.start-reinspection', {
      items: [{ batchId, barcodeValue: barcode }],
    })
    expect(again.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(again.errorMessage).toContain('A-6')
  })

  it('A-10：价格复核标记（待复核→已复核、记录人/时间、已复核不可再复核）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const exemptBatch = await pool.query<{ id: string }>(
      `SELECT b.id FROM purchase_receipt_batch b
       JOIN purchase_order_line l ON l.id = b.purchase_line_id
       WHERE l.order_no = $1`,
      [`PO-${run}-S13`],
      )
    const batchId = exemptBatch.rows[0]!.id
    const review = await exec(purchaseBus, nextOp('review'), 'purchase.price-review.confirm', { batchId })
    expect(review.status).toBe(CommandResultStatus.COMMITTED)
    const reviewed = await pool.query<{ review_status: string; reviewed_by: string; reviewed_at: string | null }>(
      `SELECT review_status, reviewed_by, reviewed_at FROM purchase_receipt_batch WHERE id = $1`,
      [batchId],
    )
    expect(reviewed.rows[0]!.review_status).toBe('reviewed')
    expect(reviewed.rows[0]!.reviewed_by).toBe('admin')
    expect(reviewed.rows[0]!.reviewed_at).not.toBeNull()
    const again = await exec(purchaseBus, nextOp('review-2'), 'purchase.price-review.confirm', { batchId })
    expect(again.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(again.errorMessage).toContain('A-10') // 已复核不可撤销/重复
  })
})
