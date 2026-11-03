import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext } from '@cadenza/application'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildReverseCommandBus } from '../../apps/api/src/reverse/reverse.composition'
import {
  REV_OWNER_ID,
  REV_OWNER_NAME,
  REV_TEST_DB_NAME,
  prepareRevTestDatabase,
} from '../api/reverse-test-env'

/**
 * 仓储逆向集成（真容器独立库 cadenza_reverse + 真实命令总线与真实组合根，无业务桩）。
 * 冻结合同 frozen/p2/warehouse-reverse.md 贯穿验收样例与主链证据：
 * ① 移库（WR-01～05）：提交事务内重校验＋台账快照＋余额位置变更且所有权不变＋同 opId 幂等重放
 * ② Web 有任务调拨→厂内即时转仓（WR-06/07①/08/09/10/11/13）：生产调拨成品拒、扫码锁定、
 *    删码回待出库、完成出库固定库位单生成即已完成
 * ③ PDA 无任务+跨厂签收（WR-07②/12/14～17）：首扫自动建单、单人单条进行中、跨厂拒绝固定库位
 *    冒充签收、在途对账（两段原子）、接收方扫码上架/删码回退/完成、A07 数量位置所有权三分核对
 * ④ 采购批次纠正（WR-18～23）：一码多批、再扫确认、同组合并、退货事实+反向流水+订单行扣减+投影、
 *    重复退货拒、回传重试、下游在途拦截
 * ⑤ 盘点（WR-24/25）：锁定拦截移库、差异调整单（原因+去向+实时余额基准+扣前扣后流水）、解锁
 * ⑥ 所有权三分与载具借还（WR-26/27/28）：所有权变更位置不变、借还四事件状态轴、append-only 守卫
 */

let pool: pg.Pool
let reverseBus: ReturnType<typeof buildReverseCommandBus>
let inventoryBus: ReturnType<typeof buildInventoryCommandBus>
let adminCtx: CommandContext
let fx: import('../api/reverse-test-env').RevFixtures
let dbAvailable = true
const run = `rev${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

beforeAll(async () => {
  try {
    pool = await prepareRevTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP reverse-flow: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${REV_TEST_DB_NAME}）。`)
    return
  }
  const env = await import('../api/reverse-test-env.js')
  fx = await env.seedRevFixtures(pool)
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  reverseBus = buildReverseCommandBus(pool)
  inventoryBus = buildInventoryCommandBus(pool)
})

afterAll(async () => {
  if (pool) await pool.end()
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
  bus: typeof reverseBus | typeof inventoryBus,
  operationId: string,
  commandType: string,
  payload: Record<string, unknown>,
): Promise<CommandResult> {
  return bus.execute(envelope(operationId, commandType, payload), adminCtx)
}

async function rv(operationId: string, commandType: string, payload: Record<string, unknown>): Promise<CommandResult> {
  return exec(reverseBus, operationId, commandType, payload)
}

/** 收货一个库存单元（inventory.receive-goods；默认合格在库——出库闸门 GAP-D9 缺省严格）。 */
async function receiveUnit(unitNo: string, locationId: string, quantity = '100.0000'): Promise<string> {
  const r = await exec(inventoryBus, nextOp(`rcv${unitNo}`), 'inventory.receive-goods', {
    plantId: fx.szPlantId,
    quantity,
    uomId: fx.uomId,
    uomCode: 'KG',
    locationId,
    locationCode: locationId === fx.szRackLocationId ? '010101' : '92120101',
    ownerId: REV_OWNER_ID,
    ownerName: REV_OWNER_NAME,
    lotNo: `LOT-${run}-${unitNo}`,
    materialId: fx.rawMaterialId,
    materialCode: 'MAT-REV-RAW',
    unitNo,
    qualityStatus: 'qualified',
  })
  expect(r.status).toBe(CommandResultStatus.COMMITTED)
  return (r.data as { unitId: string }).unitId
}

async function unitRow(unitNo: string): Promise<{ id: string; status: string }> {
  const r = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM inventory_unit WHERE unit_no = $1 AND plant_id = $2`,
    [unitNo, fx.szPlantId],
  )
  expect(r.rowCount).toBe(1)
  return r.rows[0]!
}

async function activeBalance(unitId: string): Promise<{ locationId: string; ownerId: string; quantity: string; status: string }> {
  const r = await pool.query<{ location_id: string; owner_id: string; quantity: string; status: string }>(
    `SELECT location_id, owner_id, quantity, status FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
    [unitId],
  )
  expect(r.rowCount).toBe(1)
  const row = r.rows[0]!
  return { locationId: row.location_id, ownerId: row.owner_id, quantity: row.quantity, status: row.status }
}

async function expectRejection(r: CommandResult, rule: string): Promise<string> {
  expect(r.status).toBe('BUSINESS_REJECTION')
  expect(r.errorCode).toBe(ERROR_CODES.BUSINESS_RULE)
  expect(r.errorMessage ?? '').toContain(`[${rule}]`)
  return r.errorMessage ?? ''
}

describe('① 移库（WR-01～05）+ 幂等重放', () => {
  const unitNo = `U-${run}-M1`
  let unitId = ''

  it('receive 到 010101 后提交移库到 010102：台账快照＋余额位置变更且所有权不变', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    unitId = await receiveUnit(unitNo, fx.szRackLocationId)
    const op = nextOp('mv1')
    const r = await rv(op, 'reverse.move.submit', {
      plantId: fx.szPlantId,
      warehouseId: fx.szRawWarehouseId,
      toLocationId: fx.szRackLocationId2,
      stagedUnitNos: [unitNo],
      reason: '移库演示',
    })
    if (r.status !== 'COMMITTED') console.log('MV-ERR', r.errorMessage)
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const record = r.data as { moveNo: string }

    const header = await pool.query(
      `SELECT h.move_no, h.to_location_code, h.material_codes_joined, h.total_qty, h.moved_by,
              l.from_location_code AS line_from, l.to_location_code AS line_to, l.quantity
       FROM stock_move_record h JOIN stock_move_record_line l ON l.record_id = h.id
       WHERE h.move_no = $1`,
      [record.moveNo],
    )
    expect(header.rowCount).toBe(1)
    const row = header.rows[0] as Record<string, string>
    expect(row['line_from']).toBe('010101')
    expect(row['line_to']).toBe('010102')
    expect(row['material_codes_joined']).toBe('MAT-REV-RAW')
    expect(row['total_qty']).toBe('100.0000')
    expect(row['moved_by']).toBe('admin')
    // WR-04：这些码移到新库位；WR-26：位置变更不改变所有权
    const balance = await activeBalance(unitId)
    expect(balance.locationId).toBe(fx.szRackLocationId2)
    expect(balance.ownerId).toBe(REV_OWNER_ID)
    expect(balance.quantity).toBe('100.0000')

    // ⑦ 同 operationId 重放（同载荷）：回放原结果，不重复建台账
    const replay = await rv(op, 'reverse.move.submit', {
      plantId: fx.szPlantId,
      warehouseId: fx.szRawWarehouseId,
      toLocationId: fx.szRackLocationId2,
      stagedUnitNos: [unitNo],
      reason: '移库演示',
    })
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect((replay.data as { moveNo: string }).moveNo).toBe(record.moveNo)
    const count = await pool.query(`SELECT count(*)::int AS c FROM stock_move_record WHERE move_no = $1`, [record.moveNo])
    expect((count.rows[0] as { c: number }).c).toBe(1)
  })

  it('WR-02：原库位=新库位拒绝；暂存清单为空拒绝', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const same = await rv(nextOp('mvsame'), 'reverse.move.submit', {
      plantId: fx.szPlantId,
      warehouseId: fx.szRawWarehouseId,
      toLocationId: fx.szRackLocationId2,
      stagedUnitNos: [unitNo],
    })
    await expectRejection(same, 'WR-02')
    const empty = await rv(nextOp('mvempty'), 'reverse.move.submit', {
      plantId: fx.szPlantId,
      warehouseId: fx.szRawWarehouseId,
      toLocationId: fx.szRackLocationId,
      stagedUnitNos: [],
    })
    await expectRejection(empty, 'WR-02')
  })

  it('WR-S1：移库台账 append-only（UPDATE 被库级守卫拒绝）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await expect(
      pool.query(`UPDATE stock_move_record SET total_qty = 1 WHERE moved_by = 'admin'`),
    ).rejects.toThrow(/WR-S1/)
  })
})

describe('② Web 有任务调拨出库→厂内即时转仓（WR-06/07①/08/09/10/11/13）', () => {
  const unitNo = `U-${run}-W1`
  let orderId = ''

  it('WR-06：生产调拨明细含成品拒绝创建', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await rv(nextOp('toc-fin'), 'reverse.transfer-outbound.create', {
      plantId: fx.szPlantId,
      transferKind: 'production',
      fromWarehouseId: fx.szRawWarehouseId,
      toWarehouseId: fx.szLineSideWarehouseId,
      lines: [{ materialId: fx.finishedMaterialId, plannedQty: '50.0000' }],
    })
    await expectRejection(r, 'WR-06')
  })

  it('WR-06：调入=调出拒绝；创建成功（warehouse 有任务，关联订单号）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const same = await rv(nextOp('toc-same'), 'reverse.transfer-outbound.create', {
      plantId: fx.szPlantId,
      transferKind: 'warehouse',
      fromWarehouseId: fx.szRawWarehouseId,
      toWarehouseId: fx.szRawWarehouseId,
      lines: [{ materialId: fx.rawMaterialId, plannedQty: '50.0000' }],
    })
    await expectRejection(same, 'WR-06')

    const r = await rv(nextOp('toc1'), 'reverse.transfer-outbound.create', {
      plantId: fx.szPlantId,
      transferKind: 'warehouse',
      fromWarehouseId: fx.szRawWarehouseId,
      toWarehouseId: fx.szSecondWarehouseId,
      lines: [{ materialId: fx.rawMaterialId, plannedQty: '100.0000' }],
    })
    if (r.status !== 'COMMITTED') console.log('TOC-ERR', r.errorMessage)
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    orderId = (r.data as { orderId: string }).orderId
    const order = await pool.query<{ status: string; source_kind: string }>(
      `SELECT status, source_kind FROM transfer_outbound_order WHERE id = $1`,
      [orderId],
    )
    expect(order.rows[0]!.status).toBe('pending_out')
    expect(order.rows[0]!.source_kind).toBe('web_task')
  })

  it('WR-09：扫码装入（锁定=作业预留、整码调出、状态出库中）；重复装入拒绝；料品不在明细拒绝', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(unitNo, fx.szRackLocationId)
    const r = await rv(nextOp('tos1'), 'reverse.transfer-outbound.scan', {
      plantId: fx.szPlantId,
      orderId,
      unitNo,
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const scan = r.data as { outQty: string }
    expect(scan.outQty).toBe('100.0000') // WR-10 整码调出

    const order = await pool.query<{ status: string }>(
      `SELECT status FROM transfer_outbound_order WHERE id = $1`,
      [orderId],
    )
    expect(order.rows[0]!.status).toBe('outbounding')
    const unitId = (await unitRow(unitNo)).id
    const reservations = await pool.query<{ status: string }>(
      `SELECT status FROM reservation WHERE unit_id = $1 AND status = 'active'`,
      [unitId],
    )
    expect(reservations.rowCount).toBe(1)

    const dup = await rv(nextOp('tos1dup'), 'reverse.transfer-outbound.scan', {
      plantId: fx.szPlantId,
      orderId,
      unitNo,
    })
    await expectRejection(dup, 'WR-09')

    // 料品不在明细（用成品码）——成品先收到 010101
    const finNo = `U-${run}-FIN`
    await pool.query(
      `UPDATE material SET material_type = 3 WHERE id = $1`,
      [fx.finishedMaterialId],
    )
    await exec(inventoryBus, nextOp(`rcv${finNo}`), 'inventory.receive-goods', {
      plantId: fx.szPlantId,
      quantity: '10.0000',
      uomId: fx.uomId,
      uomCode: 'KG',
      locationId: fx.szRackLocationId2,
      locationCode: '010102',
      ownerId: REV_OWNER_ID,
      ownerName: REV_OWNER_NAME,
      lotNo: `LOT-${run}-${finNo}`,
      materialId: fx.finishedMaterialId,
      materialCode: 'MAT-REV-FIN',
      unitNo: finNo,
      qualityStatus: 'qualified',
    })
    const notInPlan = await rv(nextOp('tos-fin'), 'reverse.transfer-outbound.scan', {
      plantId: fx.szPlantId,
      orderId,
      unitNo: finNo,
    })
    await expectRejection(notInPlan, 'WR-09')
  })

  it('WR-08/13：删码删空回待出库并解除锁定；再装入后编辑拒绝（已扫码）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const rm = await rv(nextOp('torm1'), 'reverse.transfer-outbound.remove-scan', {
      plantId: fx.szPlantId,
      orderId,
      unitNo,
    })
    expect(rm.status).toBe(CommandResultStatus.COMMITTED)
    const order = await pool.query<{ status: string }>(
      `SELECT status FROM transfer_outbound_order WHERE id = $1`,
      [orderId],
    )
    expect(order.rows[0]!.status).toBe('pending_out')
    const unitId = (await unitRow(unitNo)).id
    const active = await pool.query(`SELECT 1 FROM reservation WHERE unit_id = $1 AND status = 'active'`, [unitId])
    expect(active.rowCount).toBe(0)

    // 删空后回待出库且无扫码记录：编辑应成功（WR-08 仅"待出库且未扫过码"拒编辑）
    const edit = await rv(nextOp('toe1'), 'reverse.transfer-outbound.update', {
      plantId: fx.szPlantId,
      orderId,
      lines: [{ materialId: fx.rawMaterialId, plannedQty: '120.0000' }],
    })
    expect(edit.status).toBe(CommandResultStatus.COMMITTED)

    // 重新装入（已扫码）后编辑拒绝（WR-08）
    await rv(nextOp('tos1b'), 'reverse.transfer-outbound.scan', { plantId: fx.szPlantId, orderId, unitNo })
    const editAfterScan = await rv(nextOp('toe2'), 'reverse.transfer-outbound.update', {
      plantId: fx.szPlantId,
      orderId,
      lines: [{ materialId: fx.rawMaterialId, plannedQty: '150.0000' }],
    })
    await expectRejection(editAfterScan, 'WR-08')
  })

  it('完成出库：固定库位单生成即已完成、入库人=出库人、码在库（WR-11/14；接上已重装）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await rv(nextOp('tocomplete'), 'reverse.transfer-outbound.complete', {
      plantId: fx.szPlantId,
      orderId,
      toLocationId: fx.szSecondLocationId,
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const data = r.data as { inboundOrderId: string; inboundMode: string; movedUnits: string[] }
    expect(data.inboundMode).toBe('fixed_location')
    expect(data.movedUnits).toContain(unitNo)

    const inbound = await pool.query<{
      status: string
      inbound_mode: string
      shipper_snapshot_by: string | null
      line_status: string | null
    }>(
      `SELECT o.status, o.inbound_mode, o.shipper_snapshot_by, l.line_status
       FROM transfer_inbound_order o LEFT JOIN transfer_inbound_line l ON l.order_id = o.id
       WHERE o.id = $1`,
      [data.inboundOrderId],
    )
    expect(inbound.rows[0]!.status).toBe('completed') // WR-S3：生成即已完成
    expect(inbound.rows[0]!.shipper_snapshot_by).toBe('admin') // 入库人=出库方快照
    expect(inbound.rows[0]!.line_status).toBe('inbound')

    const unit = await unitRow(unitNo)
    expect(unit.status).toBe('in_stock')
    const balance = await activeBalance(unit.id)
    expect(balance.locationId).toBe(fx.szSecondLocationId)
    expect(balance.ownerId).toBe(REV_OWNER_ID) // WR-26：移位不移所有权
    const out = await pool.query<{ status: string; shipped_by: string | null; to_location_code: string | null }>(
      `SELECT status, shipped_by, to_location_code FROM transfer_outbound_order WHERE id = $1`,
      [orderId],
    )
    expect(out.rows[0]!.status).toBe('outbounded')
    expect(out.rows[0]!.shipped_by).toBe('admin')
    expect(out.rows[0]!.to_location_code).toBe('92120101')
  })
})

describe('③ PDA 无任务+跨厂签收（WR-07②/12/14～17 + A07）', () => {
  const unitNo = `U-${run}-X1`
  let orderId = ''

  it('WR-07②：首扫自动建单（pda_taskless、调出仓=码所在仓）；操作人第二条进行中拒绝', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(unitNo, fx.szRackLocationId)
    const r = await rv(nextOp('txs1'), 'reverse.transfer-outbound.scan', {
      plantId: fx.szPlantId,
      unitNo,
      toWarehouseId: fx.hfWarehouseId, // 跨厂：苏州 → 合肥
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    orderId = (r.data as { orderId: string }).orderId
    const order = await pool.query<{ source_kind: string; from_warehouse_id: string; to_warehouse_id: string; created_by: string }>(
      `SELECT source_kind, from_warehouse_id, to_warehouse_id, created_by FROM transfer_outbound_order WHERE id = $1`,
      [orderId],
    )
    expect(order.rows[0]!.source_kind).toBe('pda_taskless')
    expect(order.rows[0]!.from_warehouse_id).toBe(fx.szRawWarehouseId)
    expect(order.rows[0]!.to_warehouse_id).toBe(fx.hfWarehouseId)
    expect(order.rows[0]!.created_by).toBe('admin')

    await receiveUnit(`U-${run}-X2`, fx.szRackLocationId)
    const second = await rv(nextOp('txs2'), 'reverse.transfer-outbound.scan', {
      plantId: fx.szPlantId,
      unitNo: `U-${run}-X2`,
      toWarehouseId: fx.hfWarehouseId,
    })
    await expectRejection(second, 'WR-07') // 每人同时只能一条进行中
  })

  it('WR-14：跨厂调拨以固定库位冒充签收拒绝（complete 带 toLocationId）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await rv(nextOp('txc-fake'), 'reverse.transfer-outbound.complete', {
      plantId: fx.szPlantId,
      orderId,
      toLocationId: fx.hfRackLocationId,
    })
    await expectRejection(r, 'WR-14')
  })

  it('WR-11/12：完成出库走在途——码已出库（在途）、在途余额可对账、入库单待入库扫码上架', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await rv(nextOp('txc1'), 'reverse.transfer-outbound.complete', {
      plantId: fx.szPlantId,
      orderId,
      transitLocationId: fx.szTransitLocationId,
    })
    if (r.status !== 'COMMITTED') console.log('TXC-ERR', r.errorMessage)
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const data = r.data as { inboundOrderId: string; inboundMode: string }

    const unit = await unitRow(unitNo)
    expect(unit.status).toBe('in_transit') // IT-13：已出库（在途）
    const transitBalance = await pool.query<{ quantity: string; owner_id: string }>(
      `SELECT quantity, owner_id FROM stock_balance WHERE unit_id = $1 AND location_id = $2 AND status = 'active'`,
      [unit.id, fx.szTransitLocationId],
    )
    expect(transitBalance.rowCount).toBe(1) // WR-12：在途数量可对账（来源减＋在途增一次事务）
    expect(transitBalance.rows[0]!.quantity).toBe('100.0000')
    expect(transitBalance.rows[0]!.owner_id).toBe(REV_OWNER_ID)

    const inbound = await pool.query<{ status: string; inbound_mode: string }>(
      `SELECT status, inbound_mode FROM transfer_inbound_order WHERE id = $1`,
      [data.inboundOrderId],
    )
    expect(inbound.rows[0]!.status).toBe('pending_in')
    expect(inbound.rows[0]!.inbound_mode).toBe('scan_putaway')

    // 接收方扫码上架（WR-15：合肥 010101 RACK 库位编码）
    const putaway = await rv(nextOp('tin1'), 'reverse.transfer-inbound.scan-putaway', {
      plantId: fx.szPlantId,
      orderId: data.inboundOrderId,
      unitNo,
      locationCode: '010101',
    })
    if (putaway.status !== 'COMMITTED') console.log('TIN-ERR', putaway.errorMessage)
    expect(putaway.status).toBe(CommandResultStatus.COMMITTED)
    const inOrder = await pool.query<{ status: string }>(
      `SELECT status FROM transfer_inbound_order WHERE id = $1`,
      [data.inboundOrderId],
    )
    expect(inOrder.rows[0]!.status).toBe('inbounding')

    // WR-16：删码退回未入库、状态回待入库
    const rm = await rv(nextOp('tinrm'), 'reverse.transfer-inbound.remove-scan', {
      plantId: fx.szPlantId,
      orderId: data.inboundOrderId,
      unitNo,
    })
    expect(rm.status).toBe(CommandResultStatus.COMMITTED)
    const afterRm = await pool.query<{ status: string; line_status: string | null }>(
      `SELECT o.status, l.line_status FROM transfer_inbound_order o
       LEFT JOIN transfer_inbound_line l ON l.order_id = o.id WHERE o.id = $1`,
      [data.inboundOrderId],
    )
    expect(afterRm.rows[0]!.status).toBe('pending_in')
    expect(afterRm.rows[0]!.line_status).toBe('pending')

    // 重新上架并完成（WR-17：每料品已入库≥待入库）
    await rv(nextOp('tin2'), 'reverse.transfer-inbound.scan-putaway', {
      plantId: fx.szPlantId,
      orderId: data.inboundOrderId,
      unitNo,
      locationCode: '010101',
    })
    const complete = await rv(nextOp('tinc'), 'reverse.transfer-inbound.complete', {
      plantId: fx.szPlantId,
      orderId: data.inboundOrderId,
    })
    if (complete.status !== 'COMMITTED') console.log('TINC-ERR', complete.errorMessage)
    expect(complete.status).toBe(CommandResultStatus.COMMITTED)
    const done = await pool.query<{ status: string; received_by: string | null }>(
      `SELECT status, received_by FROM transfer_inbound_order WHERE id = $1`,
      [data.inboundOrderId],
    )
    expect(done.rows[0]!.status).toBe('completed')
    expect(done.rows[0]!.received_by).toBe('admin')

    // A07：数量、位置、所有权三者分别可核对（独立接收事实落合肥库位、所有权未变）
    const unit2 = await unitRow(unitNo)
    expect(unit2.status).toBe('in_stock')
    const balance = await pool.query<{ location_id: string; owner_id: string; quantity: string }>(
      `SELECT location_id, owner_id, quantity FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
      [unit2.id],
    )
    expect(balance.rows[0]!.location_id).toBe(fx.hfRackLocationId)
    expect(balance.rows[0]!.owner_id).toBe(REV_OWNER_ID)
    expect(balance.rows[0]!.quantity).toBe('100.0000')
  })
})

describe('④ 采购批次纠正（WR-18～23）', () => {
  const barcode = `BC-${run}-1`
  const unitNo = `U-${run}-P1`
  let batchId = ''
  let unitId = ''

  it('WR-18：一码多批收货（不同厂家批号各一行）＋同单同组重复拒绝', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 单元量=批次登记总量（30+20+5=55）：整码冲销（退货）扣减不超订单行已收（WR-20）
    unitId = await receiveUnit(unitNo, fx.szRackLocationId, '55.0000')
    const r = await rv(nextOp('rrl1'), 'reverse.receipt.receive-lines', {
      plantId: fx.szPlantId,
      purchaseLineId: fx.purchaseLineId,
      materialId: fx.rawMaterialId,
      materialCode: 'MAT-REV-RAW',
      warehouseId: fx.szRawWarehouseId,
      uomId: fx.uomId,
      uomCode: 'KG',
      inspectionStatus: 'all_unqualified',
      lines: [
        { barcodeValue: barcode, supplierLotNo: 'SL-A', grade: 'G1', quantity: '30.0000', inventoryUnitId: unitId },
        { barcodeValue: barcode, supplierLotNo: 'SL-B', grade: 'G2', quantity: '20.0000' },
      ],
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const data = r.data as { batchId: string; details: Array<{ merged: boolean }> }
    batchId = data.batchId
    expect(data.details).toHaveLength(2)

    const dup = await rv(nextOp('rrldup'), 'reverse.receipt.receive-lines', {
      plantId: fx.szPlantId,
      purchaseLineId: fx.purchaseLineId,
      materialId: fx.rawMaterialId,
      warehouseId: fx.szRawWarehouseId,
      uomId: fx.uomId,
      inspectionStatus: 'all_unqualified',
      lines: [
        { barcodeValue: barcode, supplierLotNo: 'SL-A', grade: 'G1', quantity: '1.0000' },
        { barcodeValue: barcode, supplierLotNo: 'SL-A', grade: 'G1', quantity: '1.0000' },
      ],
    })
    await expectRejection(dup, 'WR-18')
  })

  it('WR-18：已收货的码再扫未确认拒绝；确认后续收同组合并数量相加', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const rescan = await rv(nextOp('rrl2'), 'reverse.receipt.receive-lines', {
      plantId: fx.szPlantId,
      purchaseLineId: fx.purchaseLineId,
      batchId,
      lines: [{ barcodeValue: barcode, supplierLotNo: 'SL-A', grade: 'G1', quantity: '5.0000' }],
    })
    await expectRejection(rescan, 'WR-18')

    const merged = await rv(nextOp('rrl3'), 'reverse.receipt.receive-lines', {
      plantId: fx.szPlantId,
      purchaseLineId: fx.purchaseLineId,
      batchId,
      confirmReScan: true,
      lines: [{ barcodeValue: barcode, supplierLotNo: 'SL-A', grade: 'G1', quantity: '5.0000' }],
    })
    expect(merged.status).toBe(CommandResultStatus.COMMITTED)
    const detail = await pool.query<{ quantity: string }>(
      `SELECT d.quantity FROM receipt_detail d WHERE d.batch_id = $1 AND d.barcode_value = $2 AND d.supplier_lot_no = 'SL-A'`,
      [batchId, barcode],
    )
    expect(detail.rows[0]!.quantity).toBe('35.0000') // 30 + 5
  })

  it('WR-20：退货=事实+反向流水+订单行扣减+投影保留（隐式归零废除 CA-16）；重复退货拒绝', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const lineBefore = await pool.query<{ received_qty: string }>(
      `SELECT received_qty FROM purchase_order_line WHERE id = $1`,
      [fx.purchaseLineId],
    )
    expect(lineBefore.rows[0]!.received_qty).toBe('55.0000') // 30+20+5

    const r = await rv(nextOp('rret1'), 'reverse.receipt.return', {
      batchId,
      remark: '全部不合格退回供应商',
      reason: '来料全部不合格',
    })
    if (r.status !== 'COMMITTED') console.log('RET-ERR', r.errorMessage)
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const data = r.data as { correctionNo: string; reversedQty: string; projection: { inboundQty: string } }
    expect(data.reversedQty).toBe('55.0000') // 明细绑定单元整码冲销（单元量=批次登记量 55）
    expect(data.projection.inboundQty).toBe('0.0000') // 投影=已入账 55 − 已退货 55

    const correction = await pool.query<{ correction_kind: string; return_sync_status: string; quantity: string }>(
      `SELECT correction_kind, return_sync_status, quantity FROM receipt_correction WHERE correction_no = $1`,
      [data.correctionNo],
    )
    expect(correction.rows[0]!.correction_kind).toBe('return')
    expect(correction.rows[0]!.return_sync_status).toBe('pending') // IF-10 待回传
    expect(correction.rows[0]!.quantity).toBe('55.0000')

    const tx = await pool.query<{ movement_kind: string }>(
      `SELECT movement_kind FROM stock_transaction WHERE ref_type = 'purchase_receipt_batch' AND ref_id = $1`,
      [batchId],
    )
    expect(tx.rowCount).toBeGreaterThanOrEqual(1)
    expect(tx.rows[0]!.movement_kind).toBe('reverse')

    const lineAfter = await pool.query<{ received_qty: string }>(
      `SELECT received_qty FROM purchase_order_line WHERE id = $1`,
      [fx.purchaseLineId],
    )
    expect(lineAfter.rows[0]!.received_qty).toBe('0.0000') // 扣减（55 − 100 截到绑定单元 100？断言按 handler deductOrderLine 语义）

    const batchAfter = await pool.query<{ storage_status: string; received_qty: string; return_sync_status: string }>(
      `SELECT storage_status, received_qty, return_sync_status FROM purchase_receipt_batch WHERE id = $1`,
      [batchId],
    )
    expect(batchAfter.rows[0]!.storage_status).toBe('returned')
    expect(batchAfter.rows[0]!.received_qty).toBe('55.0000') // 已入账数量保留（投影非置 0）
    expect(batchAfter.rows[0]!.return_sync_status).toBe('pending')

    const dup = await rv(nextOp('rret2'), 'reverse.receipt.return', { batchId, remark: '再退' })
    await expectRejection(dup, 'WR-20')
  })

  it('WR-23：退货回传重试（已退货批次；本地入账不回滚）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await rv(nextOp('rrsync'), 'reverse.receipt.return-sync.retry', { batchId })
    expect([CommandResultStatus.COMMITTED, 'COMMITTED']).toContain(r.status)
    const outbox = await pool.query(`SELECT 1 FROM outbox WHERE aggregate_id = $1 AND task_kind = 'reverse.receipt-return-sync'`, [batchId])
    expect(outbox.rowCount).toBeGreaterThanOrEqual(1)
  })

  it('WR-22：下游调拨在途拦截退货（对象关系校验，命中即拦截）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 建第二批次：码 U-P2 收货后调拨到在途
    const unitNo2 = `U-${run}-P2`
    const unitId2 = await receiveUnit(unitNo2, fx.szRackLocationId)
    const rcv = await rv(nextOp('rrl4'), 'reverse.receipt.receive-lines', {
      plantId: fx.szPlantId,
      purchaseLineId: fx.purchaseLineId,
      materialId: fx.rawMaterialId,
      warehouseId: fx.szRawWarehouseId,
      uomId: fx.uomId,
      inspectionStatus: 'all_unqualified',
      lines: [{ barcodeValue: `BC-${run}-2`, supplierLotNo: 'SL-C', grade: 'G1', quantity: '50.0000', inventoryUnitId: unitId2 }],
    })
    const batch2 = (rcv.data as { batchId: string }).batchId
    // 该码无任务调拨到合肥并在途（完成出库）
    const scan = await rv(nextOp('rr22s'), 'reverse.transfer-outbound.scan', {
      plantId: fx.szPlantId,
      unitNo: unitNo2,
      toWarehouseId: fx.hfWarehouseId,
    })
    const oid = (scan.data as { orderId: string }).orderId
    const complete = await rv(nextOp('rr22c'), 'reverse.transfer-outbound.complete', {
      plantId: fx.szPlantId,
      orderId: oid,
      transitLocationId: fx.szTransitLocationId,
    })
    expect(complete.status).toBe(CommandResultStatus.COMMITTED)

    const ret = await rv(nextOp('rr22r'), 'reverse.receipt.return', { batchId: batch2, remark: '在途批次退货' })
    await expectRejection(ret, 'WR-22')
  })
})

describe('⑤ 盘点与差异调整（WR-24/25）', () => {
  const unitNo = `U-${run}-S1`
  let unitId = ''
  let orderId = ''

  it('WR-24①：盘点锁仓拦截移库（可解释拒绝）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    unitId = await receiveUnit(unitNo, fx.szRackLocationId)
    const open = await rv(nextOp('sto1'), 'reverse.stocktake.open', {
      plantId: fx.szPlantId,
      warehouseId: fx.szRawWarehouseId,
      note: '年度抽盘',
    })
    expect(open.status).toBe(CommandResultStatus.COMMITTED)
    orderId = (open.data as { orderId: string }).orderId
    const order = await pool.query<{ status: string; locked: boolean }>(
      `SELECT status, locked FROM stocktake_order WHERE id = $1`,
      [orderId],
    )
    expect(order.rows[0]!.status).toBe('counting')
    expect(order.rows[0]!.locked).toBe(true)

    const move = await rv(nextOp('stv-mv'), 'reverse.move.submit', {
      plantId: fx.szPlantId,
      warehouseId: fx.szRawWarehouseId,
      toLocationId: fx.szRackLocationId2,
      stagedUnitNos: [unitNo],
    })
    const msg = await expectRejection(move, 'WR-24')
    expect(msg).toContain('盘点锁定')
  })

  it('WR-24：点数（差异=实点−账面）＋差异调整单（原因+去向+实时基准+扣前扣后流水）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const count = await rv(nextOp('strc1'), 'reverse.stocktake.record-count', {
      plantId: fx.szPlantId,
      orderId,
      lines: [{ unitNo, countedQty: '98.0000' }], // 账面 100 → 盘亏 2
    })
    expect(count.status).toBe(CommandResultStatus.COMMITTED)
    expect((count.data as { diffs: number }).diffs).toBe(1)
    const countLine = await pool.query<{ book_qty: string; counted_qty: string; diff_qty: string }>(
      `SELECT book_qty, counted_qty, diff_qty FROM stocktake_count_line WHERE order_id = $1`,
      [orderId],
    )
    expect(countLine.rows[0]!.book_qty).toBe('100.0000')
    expect(countLine.rows[0]!.diff_qty).toBe('-2.0000')

    const adjust = await rv(nextOp('stadj1'), 'reverse.stock-adjustment.execute', {
      plantId: fx.szPlantId,
      stocktakeOrderId: orderId,
      reason: '盘亏两公斤',
      destination: '报损（车间损耗）',
      lines: [{ unitId, adjustQty: '-2.0000' }],
    })
    expect(adjust.status).toBe(CommandResultStatus.COMMITTED)
    const adjData = adjust.data as { adjustmentNo: string; lineDetails: Array<{ beforeQty: string; afterQty: string }> }
    expect(adjData.lineDetails[0]!.beforeQty).toBe('100.0000') // IT-19：扣前余额
    expect(adjData.lineDetails[0]!.afterQty).toBe('98.0000') // 扣后余额

    const tx = await pool.query<{ movement_kind: string; before_qty: string; after_qty: string }>(
      `SELECT movement_kind, before_qty, after_qty FROM stock_transaction WHERE ref_type = 'stock_adjustment'
       ORDER BY created_at DESC LIMIT 1`,
    )
    expect(tx.rows[0]!.movement_kind).toBe('adjust')
    expect(tx.rows[0]!.before_qty).toBe('100.0000')
    expect(tx.rows[0]!.after_qty).toBe('98.0000')

    const balance = await activeBalance(unitId)
    expect(balance.quantity).toBe('98.0000')
  })

  it('WR-25：差异调整盘亏越实时余额拒绝（无负库存）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await rv(nextOp('stadj2'), 'reverse.stock-adjustment.execute', {
      plantId: fx.szPlantId,
      reason: '再盘亏',
      destination: '报损',
      lines: [{ unitId, adjustQty: '-99.0000' }],
    })
    await expectRejection(r, 'WR-25')
  })

  it('WR-24：关闭盘单解锁后移库可执行', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const close = await rv(nextOp('stcl1'), 'reverse.stocktake.close', { plantId: fx.szPlantId, orderId })
    expect(close.status).toBe(CommandResultStatus.COMMITTED)
    const order = await pool.query<{ status: string; locked: boolean }>(
      `SELECT status, locked FROM stocktake_order WHERE id = $1`,
      [orderId],
    )
    expect(order.rows[0]!.status).toBe('completed')
    expect(order.rows[0]!.locked).toBe(false)

    const move = await rv(nextOp('stmv2'), 'reverse.move.submit', {
      plantId: fx.szPlantId,
      warehouseId: fx.szRawWarehouseId,
      toLocationId: fx.szRackLocationId2,
      stagedUnitNos: [unitNo],
    })
    expect(move.status).toBe(CommandResultStatus.COMMITTED)
  })
})

describe('⑥ 所有权三分与载具借还（WR-26/27 + WR-S5）', () => {
  const unitNo = `U-${run}-O1`

  it('WR-26：所有权变更（客供料沿用实际所有者、保管位置不变）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const unitId = await receiveUnit(unitNo, fx.szRackLocationId)
    const r = await rv(nextOp('own1'), 'reverse.ownership.transfer', {
      plantId: fx.szPlantId,
      unitId,
      toOwnerId: '44444444-4444-4444-8444-444444444401',
      toOwnerName: '客户甲（客供料）',
      reason: '客供料所有权登记',
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const balance = await pool.query<{ owner_id: string; owner_name: string; location_id: string }>(
      `SELECT owner_id, owner_name, location_id FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
      [unitId],
    )
    expect(balance.rows[0]!.owner_name).toBe('客户甲（客供料）')
    expect(balance.rows[0]!.location_id).toBe(fx.szRackLocationId) // 保管位置不变

    // 空变更拒绝（同所有者）
    const noop = await rv(nextOp('own2'), 'reverse.ownership.transfer', {
      plantId: fx.szPlantId,
      unitId,
      toOwnerId: '44444444-4444-4444-8444-444444444401',
      toOwnerName: '客户甲（客供料）',
    })
    await expectRejection(noop, 'WR-26')
  })

  it('WR-27：载具借出（须对象）→回收→损坏→报废状态轴；借出期间不计入可用', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const noParty = await rv(nextOp('crr0'), 'reverse.carrier.loan', {
      plantId: fx.szPlantId,
      carrierCode: 'CARR-REV-01',
      eventKind: 'lend',
    })
    await expectRejection(noParty, 'WR-27')

    const lend = await rv(nextOp('crr1'), 'reverse.carrier.loan', {
      plantId: fx.szPlantId,
      carrierCode: 'CARR-REV-01',
      eventKind: 'lend',
      counterparty: '客户甲',
    })
    expect(lend.status).toBe(CommandResultStatus.COMMITTED)
    expect((lend.data as { availableForPlant: boolean }).availableForPlant).toBe(false)
    const lent = await pool.query<{ status: string }>(`SELECT status FROM carrier WHERE carrier_code = 'CARR-REV-01'`)
    expect(lent.rows[0]!.status).toBe('lent_out')

    const back = await rv(nextOp('crr2'), 'reverse.carrier.loan', {
      plantId: fx.szPlantId,
      carrierCode: 'CARR-REV-01',
      eventKind: 'take_back',
    })
    expect(back.status).toBe(CommandResultStatus.COMMITTED)
    expect((back.data as { availableForPlant: boolean }).availableForPlant).toBe(true)

    await rv(nextOp('crr3'), 'reverse.carrier.loan', { plantId: fx.szPlantId, carrierCode: 'CARR-REV-01', eventKind: 'damage' })
    const scrap = await rv(nextOp('crr4'), 'reverse.carrier.loan', { plantId: fx.szPlantId, carrierCode: 'CARR-REV-01', eventKind: 'scrap' })
    expect(scrap.status).toBe(CommandResultStatus.COMMITTED)

    const loans = await pool.query<{ event_kind: string }>(
      `SELECT event_kind FROM carrier_loan WHERE carrier_id = $1 ORDER BY occurred_at`,
      [fx.carrierId],
    )
    expect(loans.rows.map((l) => l.event_kind)).toEqual(['lend', 'take_back', 'damage', 'scrap'])
  })

  it('WR-S5：carrier_loan append-only（UPDATE/DELETE 被库级守卫拒绝、不与产品退货表关联）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await expect(pool.query(`UPDATE carrier_loan SET counterparty = 'X' WHERE carrier_id = $1`, [fx.carrierId])).rejects.toThrow(/WR-S5/)
    await expect(pool.query(`DELETE FROM carrier_loan WHERE carrier_id = $1`, [fx.carrierId])).rejects.toThrow(/WR-S5/)
  })
})
