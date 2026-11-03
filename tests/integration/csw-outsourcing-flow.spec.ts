import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext } from '@cadenza/application'
import { buildCswCommandBus, buildCswQueryService } from '../../apps/api/src/csw/csw.composition'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import {
  CSW_TEST_DB_NAME,
  CSW_OWNER_ID,
  CSW_OWNER_NAME,
  prepareCswTestDatabase,
  seedCswFixtures,
  type CswFixtures,
} from '../api/csw-test-env'

/**
 * 外协集成（真容器独立库 cadenza_p3b + 真实命令总线与库存记账，无业务桩）。
 * 冻结合同 §4 证据（CS-19～CS-25，原件零输入、显式 [合同新造]）：
 * ① CS-19 状态机全生命周期 + 非法迁移拒 + 每步操作者/时间留痕
 * ② CS-20/21 发送段：来源减＋外协在途增、所有者不变、单元 in_transit、transfer_out 双行含扣前/扣后、无出库报废
 * ③ CS-22 回厂段：外协在途减＋待检位增、目的余额待检、单元 in_stock、超发拒（CS-S4）
 * ④ CS-23 回厂批次父子边（genealogy_edge 追加）+ 供应方加工事实留痕
 * ⑤ CS-25/24 关闭须检验通过；关闭出站结算事实（outbox 模拟适配器）
 * ⑥ CS-19 收回流程（已发送后取消：余量回厂两段交接→recalled 终态）
 * ⑦ CS-19 退回处置（回厂后取消→return_disposed 终态）
 * ⑧ CS-24 商务结算归 ERP：载荷金额字段拒 + 加工数量事实导出
 * ⑨ 幂等：同 operationId send 重放不重复记账
 */

const TODAY = '2026-10-28'
const UOM_ID = '33333333-3333-4333-8333-3333333333c1'

let pool: pg.Pool
let cswBus: ReturnType<typeof buildCswCommandBus>
let inventoryBus: ReturnType<typeof buildInventoryCommandBus>
let queries: ReturnType<typeof buildCswQueryService>
let adminCtx: CommandContext
let fx: CswFixtures
let dbAvailable = true
const run = `owt${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

let opSeq = 0
function nextOp(tag: string): string {
  opSeq += 1
  return `${run}-${tag}-${opSeq}`
}
const envelope = (operationId: string, commandType: string, payload: Record<string, unknown>): CommandEnvelope => ({
  operationId,
  commandType,
  targetId: 'new',
  expectedRevision: 0,
  payload,
})
async function exec(bus: typeof cswBus | typeof inventoryBus, operationId: string, commandType: string, payload: Record<string, unknown>): Promise<CommandResult> {
  return bus.execute(envelope(operationId, commandType, payload), adminCtx)
}
async function c(operationId: string, commandType: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await exec(cswBus, operationId, commandType, payload)
  expect(r.status).toBe(CommandResultStatus.COMMITTED)
  return (r.data ?? {}) as Record<string, unknown>
}
async function rj(operationId: string, commandType: string, payload: Record<string, unknown>): Promise<CommandResult> {
  const r = await exec(cswBus, operationId, commandType, payload)
  expect(r.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
  return r
}

async function receiveUnit(unitNo: string, quantity: string): Promise<string> {
  const r = await exec(inventoryBus, nextOp(`rcv${unitNo}`), 'inventory.receive-goods', {
    plantId: fx.szPlantId,
    quantity,
    uomId: UOM_ID,
    uomCode: 'M',
    locationId: fx.stockLocationId,
    locationCode: fx.stockLocationCode,
    ownerId: CSW_OWNER_ID,
    ownerName: CSW_OWNER_NAME,
    lotNo: `LOT-${run}-${unitNo}`,
    materialId: fx.materialId,
    materialCode: 'MAT-CSW-CU',
    unitNo,
    qualityStatus: 'qualified',
  })
  expect(r.status).toBe(CommandResultStatus.COMMITTED)
  return (r.data as { unitId: string }).unitId
}

let authAdmin: Awaited<ReturnType<typeof mkAdmin>>['admin']
async function mkAdmin() {
  const me = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  return {
    admin: {
      session: { id: 's', expiresAt: '2999-01-01T00:00:00Z' },
      user: {
        id: me.rows[0]!.id,
        loginName: 'admin',
        displayName: 'admin',
        enterpriseId: me.rows[0]!.enterprise_id,
        plantId: fx.szPlantId,
        roleId: 'r',
        loginPlatform: 'WEB' as never,
      },
      role: { id: 'r', name: 'sysadmin', alias: 'sysadmin' },
      permissions: ['csw.read'],
      dataScope: { enterpriseWide: true, plantIds: [] },
    },
  }
}

beforeAll(async () => {
  try {
    pool = await prepareCswTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP csw-outsourcing: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${CSW_TEST_DB_NAME}）。`)
    return
  }
  fx = await seedCswFixtures(pool, TODAY)
  const admin = await mkAdmin()
  authAdmin = admin.admin
  adminCtx = {
    actorUserId: admin.admin.user.id,
    actorLoginName: 'admin',
    enterpriseId: admin.admin.user.enterpriseId,
    reason: null,
  }
  cswBus = buildCswCommandBus(pool)
  inventoryBus = buildInventoryCommandBus(pool)
  queries = buildCswQueryService(pool)
})

afterAll(async () => {
  if (pool) await pool.end()
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

async function balanceRow(unitId: string, locationId: string): Promise<{ quantity: string; quality_status: string; owner_id: string; status: string } | null> {
  const r = await pool.query(
    `SELECT quantity::text AS quantity, quality_status, owner_id, status FROM stock_balance WHERE unit_id = $1 AND location_id = $2 AND status = 'active'`,
    [unitId, locationId],
  )
  return (r.rows[0] as typeof r.rows[0] & { quantity: string }) ?? null
}

describe('csw 外协任务（状态机/两段交接/谱系/结算事实）', () => {
  let taskA: string
  let u1: string
  let u2: string

  it('① CS-19 状态机：create→submit→send→receive→inspect→close 全程留痕 + 非法迁移拒', async () => {
    if (skipIfNoDb()) return
    u1 = await receiveUnit(`U-${run}-1`, '100.0000')
    u2 = await receiveUnit(`U-${run}-2`, '50.0000')
    const created = await c(nextOp('owt'), 'csw.outsourcing.create', {
      orderOperationId: fx.order4OpId,
      supplierCode: 'SUP-CSW-01',
      supplierName: '外协加工一厂',
      qty: '100.0000',
      transitLocationId: fx.transitLocationId,
      transitLocationCode: fx.transitLocationCode,
      returnLocationId: fx.returnLocationId,
      returnLocationCode: fx.returnLocationCode,
    })
    taskA = created['taskId'] as string
    // 非法迁移：draft 直接 send / close 拒
    const badSend = await rj(nextOp('owt'), 'csw.outsourcing.send', { taskId: taskA, lines: [{ unitId: u1, quantity: '100' }] })
    expect(badSend.errorMessage).toContain('CS-19')
    const badClose = await rj(nextOp('owt'), 'csw.outsourcing.close', { taskId: taskA })
    expect(badClose.errorMessage).toContain('CS-19')
    await c(nextOp('owt'), 'csw.outsourcing.submit', { taskId: taskA })
    await c(nextOp('owt'), 'csw.outsourcing.send', {
      taskId: taskA,
      lines: [
        { unitId: u1, quantity: '60.0000' },
        { unitId: u2, quantity: '40.0000' },
      ],
    })
    // 超发拒（状态仍 sent；预校验先行不部分记账）
    const over = await rj(nextOp('owt'), 'csw.outsourcing.receive', {
      taskId: taskA,
      lines: [{ unitId: u1, quantity: '70.0000' }],
    })
    expect(over.errorMessage).toContain('CS-S4')
    await c(nextOp('owt'), 'csw.outsourcing.receive', {
      taskId: taskA,
      lines: [
        { unitId: u1, quantity: '60.0000', returnLotNo: `HB-${run}-1` },
        { unitId: u2, quantity: '40.0000' },
      ],
    })
    await c(nextOp('owt'), 'csw.outsourcing.inspect', { taskId: taskA, inspectionResult: 'passed' })
    await c(nextOp('owt'), 'csw.outsourcing.close', { taskId: taskA })
    // 每步操作者与时间留痕
    const detail = await queries.outsourcingDetail(authAdmin, taskA)
    expect(detail!.task.status).toBe('closed')
    expect(detail!.task.sentBy).toBe('admin')
    expect(detail!.task.sentAt).not.toBeNull()
    expect(detail!.task.receivedBy).toBe('admin')
    expect(detail!.task.inspectedAt).not.toBeNull()
    expect(detail!.task.closedAt).not.toBeNull()
    // 终态不可再迁移
    const afterClose = await rj(nextOp('owt'), 'csw.outsourcing.dispose', { taskId: taskA, reason: '终态' })
    expect(afterClose.errorMessage).toContain('CS-19')
  })

  it('② CS-20/21 发送段库存交接：来源减＋外协在途增、所有者不变、in_transit、无出库报废', async () => {
    if (skipIfNoDb()) return
    // U1 发送 60 后又回厂（①全生命周期）：来源余额 40（发送段来源减的终态证据）
    const src = await balanceRow(u1, fx.stockLocationId)
    expect(src).not.toBeNull()
    expect(src!.quantity).toBe('40.0000')
    expect(src!.owner_id).toBe(CSW_OWNER_ID)
    // 流水：transfer_out 双行（来源减/在途增），含扣前/扣后；无 issue/adjust（不作出库报废）
    const tx = await pool.query(
      `SELECT movement_kind, before_qty::text AS b, after_qty::text AS a, ref_type FROM stock_transaction WHERE unit_id = $1 ORDER BY line_no`,
      [u1],
    )
    const sendRows = tx.rows.filter((row) => row.movement_kind === 'transfer_out')
    expect(sendRows.length).toBe(2)
    expect(sendRows[0]).toMatchObject({ b: '100.0000', a: '40.0000', ref_type: 'csw_outsourcing_task' })
    expect(sendRows[1]).toMatchObject({ b: '0.0000', a: '60.0000' }) // 外协在途增（CS-21 两段之一）
    expect(tx.rows.some((row) => row.movement_kind === 'issue' || row.movement_kind === 'adjust')).toBe(false) // 不作出库报废（CS-20）
    // 单元→任务链接（外协在途具名细分承载）
    const link = await pool.query(`SELECT sent_qty::text AS q, status FROM csw_outsourcing_unit WHERE task_id = $1 AND unit_id = $2`, [taskA, u1])
    expect(link.rows[0]).toMatchObject({ q: '60.0000', status: 'returned' })
  })

  it('③ CS-22 回厂段：外协在途减＋待检位增、目的余额必检、in_stock', async () => {
    if (skipIfNoDb()) return
    const transit = await balanceRow(u1, fx.transitLocationId)
    expect(transit).toBeNull() // 在途已清（零余额关闭）
    const dest = await balanceRow(u1, fx.returnLocationId)
    expect(dest).not.toBeNull()
    expect(dest!.quantity).toBe('60.0000')
    expect(dest!.quality_status).toBe('pending_inspection') // 默认全部必检（CS-22）
    expect(dest!.owner_id).toBe(CSW_OWNER_ID) // 回厂不变更所有者
    const unit = await pool.query<{ status: string }>(`SELECT status FROM inventory_unit WHERE id = $1`, [u1])
    expect(unit.rows[0]!.status).toBe('in_stock')
    const tx = await pool.query(
      `SELECT movement_kind, before_qty::text AS b, after_qty::text AS a FROM stock_transaction WHERE unit_id = $1`,
      [u1],
    )
    const ins = tx.rows.filter((row) => row.movement_kind === 'transfer_in')
    expect(ins.length).toBe(2) // 回厂两行：在途减＋目的增（CS-21）
    expect(ins.some((row) => row.b === '60.0000' && row.a === '0.0000')).toBe(true)
    expect(ins.some((row) => row.b === '0.0000' && row.a === '60.0000')).toBe(true)
  })

  it('④ CS-23 回厂批次父子边（genealogy_edge）+ 供应方加工事实留痕', async () => {
    if (skipIfNoDb()) return
    const edge = await pool.query(
      `SELECT e.edge_kind, e.quantity::text AS q, l.lot_no AS from_lot
       FROM genealogy_edge e JOIN material_lot l ON l.id = e.from_id
       WHERE e.to_type = 'inventory_unit' AND e.to_id = $1 AND e.edge_kind = 'production_output'`,
      [u1],
    )
    expect(edge.rows.length).toBe(1)
    expect(edge.rows[0]).toMatchObject({ edge_kind: 'production_output', q: '60.0000', from_lot: `LOT-${run}-U-${run}-1` })
    const returnLot = await pool.query<{ kind: string; lot_no: string }>(
      `SELECT kind, lot_no FROM material_lot WHERE lot_no = $1`,
      [`HB-${run}-1`],
    )
    expect(returnLot.rows[0]!.kind).toBe('production') // 回厂批次＝新生产批次
    const link = await pool.query<{ return_lot_id: string }>(
      `SELECT return_lot_id FROM csw_outsourcing_unit WHERE task_id = $1 AND unit_id = $2`,
      [taskA, u1],
    )
    const returnLotId = await pool.query<{ id: string }>(`SELECT id FROM material_lot WHERE lot_no = $1`, [`HB-${run}-1`])
    expect(link.rows[0]!.return_lot_id).toBe(returnLotId.rows[0]!.id) // 链接行留存回厂批次引用
    // 供应方加工事实（供应方、工序、时段）留痕于外协任务
    const detail = await queries.outsourcingDetail(authAdmin, taskA)
    expect(detail!.task.supplierName).toBe('外协加工一厂')
    expect(detail!.task.operationName).toBe('绞线')
    expect(detail!.task.sentAt).not.toBeNull()
    expect(detail!.task.receivedAt).not.toBeNull()
  })

  it('⑤ CS-25/24 关闭须检验通过；关闭出站结算事实（outbox 模拟）', async () => {
    if (skipIfNoDb()) return
    const outbox = await pool.query(
      `SELECT task_kind, payload FROM outbox WHERE aggregate_id = $1 ORDER BY created_at`,
      [taskA],
    )
    expect(outbox.rows.length).toBeGreaterThanOrEqual(2) // 发送时点 + 关闭时点快照
    const closeRow = outbox.rows[outbox.rows.length - 1]!
    expect(closeRow.task_kind).toBe('csw.outsourcing.settlement-export')
    expect(closeRow.payload['closedAt']).not.toBeNull()
    expect(closeRow.payload['sentQty']).toBe('100.0000')
    // 未检验通过不可关闭（用收回路径外的新任务验证）
    const t = await c(nextOp('owt'), 'csw.outsourcing.create', {
      orderOperationId: fx.order5OpId,
      supplierName: '外协加工二厂',
      qty: '10.0000',
      transitLocationId: fx.transitLocationId,
      transitLocationCode: fx.transitLocationCode,
    })
    await c(nextOp('owt'), 'csw.outsourcing.submit', { taskId: t['taskId'] })
    const u3 = await receiveUnit(`U-${run}-3`, '30.0000')
    await c(nextOp('owt'), 'csw.outsourcing.send', { taskId: t['taskId'], lines: [{ unitId: u3, quantity: '10.0000' }] })
    await c(nextOp('owt'), 'csw.outsourcing.receive', {
      taskId: t['taskId'],
      lines: [{ unitId: u3, quantity: '10.0000' }],
      returnLocationId: fx.returnLocationId,
      returnLocationCode: fx.returnLocationCode,
    })
    await c(nextOp('owt'), 'csw.outsourcing.inspect', { taskId: t['taskId'], inspectionResult: 'rejected' })
    const noClose = await rj(nextOp('owt'), 'csw.outsourcing.close', { taskId: t['taskId'] })
    expect(noClose.errorMessage).toContain('CS-25') // 不以已发送/未通过充当完成
    await c(nextOp('owt'), 'csw.outsourcing.dispose', { taskId: t['taskId'], reason: '检验不合格退回处置' })
  })

  it('⑥ CS-19 收回流程：已发送后取消→余量回厂两段交接→recalled 终态', async () => {
    if (skipIfNoDb()) return
    const t = await c(nextOp('owt'), 'csw.outsourcing.create', {
      orderOperationId: fx.order6OpId,
      supplierName: '外协加工三厂',
      qty: '50.0000',
      transitLocationId: fx.transitLocationId,
      transitLocationCode: fx.transitLocationCode,
      returnLocationId: fx.returnLocationId,
      returnLocationCode: fx.returnLocationCode,
    })
    await c(nextOp('owt'), 'csw.outsourcing.submit', { taskId: t['taskId'] })
    const u4 = await receiveUnit(`U-${run}-4`, '80.0000')
    await c(nextOp('owt'), 'csw.outsourcing.send', { taskId: t['taskId'], lines: [{ unitId: u4, quantity: '50.0000' }] })
    // 中途态证据：外协在途余额（同所有者）+ 单元状态轴 in_transit（CS-20 外协在途＝在途具名细分）
    const transitMid = await balanceRow(u4, fx.transitLocationId)
    expect(transitMid).not.toBeNull()
    expect(transitMid!.quantity).toBe('50.0000')
    expect(transitMid!.owner_id).toBe(CSW_OWNER_ID)
    const unitMid = await pool.query<{ status: string }>(`SELECT status FROM inventory_unit WHERE id = $1`, [u4])
    expect(unitMid.rows[0]!.status).toBe('in_transit')
    // 收回须理由
    const noReason = await rj(nextOp('owt'), 'csw.outsourcing.recall', { taskId: t['taskId'] })
    expect(noReason.errorMessage).toContain('CS-19')
    const recalled = await c(nextOp('owt'), 'csw.outsourcing.recall', { taskId: t['taskId'], reason: '供应商产能不足，收回自制' })
    expect(recalled['status']).toBe('recalled')
    // 余量（50）回厂两段交接：在途清零、回厂位 50 且必检
    expect(await balanceRow(u4, fx.transitLocationId)).toBeNull()
    const dest = await balanceRow(u4, fx.returnLocationId)
    expect(dest!.quantity).toBe('50.0000')
    expect(dest!.quality_status).toBe('pending_inspection')
    const detail = await queries.outsourcingDetail(authAdmin, t['taskId'] as string)
    expect(detail!.task.recallReason).toContain('收回自制')
    expect(detail!.task.recalledAt).not.toBeNull()
  })

  it('⑦ CS-19 退回处置：回厂后取消→return_disposed 终态（须理由）', async () => {
    if (skipIfNoDb()) return
    const t = await c(nextOp('owt'), 'csw.outsourcing.create', {
      orderOperationId: fx.order1OpId,
      supplierName: '外协加工四厂',
      qty: '20.0000',
      transitLocationId: fx.transitLocationId,
      transitLocationCode: fx.transitLocationCode,
      returnLocationId: fx.returnLocationId,
      returnLocationCode: fx.returnLocationCode,
    })
    await c(nextOp('owt'), 'csw.outsourcing.submit', { taskId: t['taskId'] })
    const u5 = await receiveUnit(`U-${run}-5`, '20.0000')
    await c(nextOp('owt'), 'csw.outsourcing.send', { taskId: t['taskId'], lines: [{ unitId: u5, quantity: '20.0000' }] })
    await c(nextOp('owt'), 'csw.outsourcing.receive', { taskId: t['taskId'], lines: [{ unitId: u5, quantity: '20.0000' }] })
    const noReason = await rj(nextOp('owt'), 'csw.outsourcing.dispose', { taskId: t['taskId'] })
    expect(noReason.errorMessage).toContain('CS-19')
    const disposed = await c(nextOp('owt'), 'csw.outsourcing.dispose', { taskId: t['taskId'], reason: '客户订单取消，退回处置' })
    expect(disposed['status']).toBe('return_disposed')
  })

  it('⑧ CS-24 结算字段越界拒 + 加工数量事实导出', async () => {
    if (skipIfNoDb()) return
    const bad = await rj(nextOp('owt'), 'csw.outsourcing.create', {
      orderOperationId: fx.order4OpId,
      supplierName: '外协加工五厂',
      qty: '10.0000',
      transitLocationId: fx.transitLocationId,
      transitLocationCode: fx.transitLocationCode,
      amount: '5000',
    })
    expect(bad.errorMessage).toContain('CS-24')
    const export_ = await queries.outsourcingErpExport(authAdmin, { plantId: fx.szPlantId })
    expect(export_.facts.length).toBeGreaterThanOrEqual(4)
    const closedDetail = await queries.outsourcingDetail(authAdmin, taskA)
    const closedFact = export_.facts.find((f) => f.taskNo === closedDetail!.task.taskNo)!
    expect(closedFact.sentQty).toBe('100.0000')
    expect(closedFact.returnedQty).toBe('100.0000')
    expect(closedFact.supplierName).toBe('外协加工一厂')
    expect(closedFact.closedAt).not.toBeNull()
  })

  it('⑨ 幂等：同 operationId send 重放原结果，不重复记账', async () => {
    if (skipIfNoDb()) return
    const t = await c(nextOp('owt'), 'csw.outsourcing.create', {
      orderOperationId: fx.order2OpId,
      supplierName: '外协加工六厂',
      qty: '15.0000',
      transitLocationId: fx.transitLocationId,
      transitLocationCode: fx.transitLocationCode,
    })
    await c(nextOp('owt'), 'csw.outsourcing.submit', { taskId: t['taskId'] })
    const u6 = await receiveUnit(`U-${run}-6`, '15.0000')
    const opId = nextOp('send-idem')
    const first = await exec(cswBus, opId, 'csw.outsourcing.send', { taskId: t['taskId'], lines: [{ unitId: u6, quantity: '15.0000' }] })
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const before = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM stock_transaction WHERE unit_id = $1`, [u6])
    const replay = await exec(cswBus, opId, 'csw.outsourcing.send', { taskId: t['taskId'], lines: [{ unitId: u6, quantity: '15.0000' }] })
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect(replay.data).toEqual(first.data)
    const after = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM stock_transaction WHERE unit_id = $1`, [u6])
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n) // 零重复入账
  })
})
