import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  CommandResultStatus,
  type CommandEnvelope,
  type CommandResult,
} from '@cadenza/contracts'
import { createScryptPasswordHasher, type CommandContext } from '@cadenza/application'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'

/**
 * T11 原料退料集成（真容器 + 真实命令总线/组合根，无桩）：
 * - 正常退料：issue 后余料退回仓库新键 → reverse 反向流水（含扣前/扣后）、余额恢复、审计、Outbox 任务；
 * - 防超退（IT-28 守恒）：退料量 > 累计领用 − 已退 → BUSINESS_REJECTION；
 * - 投空退回原键：零余额关闭行经退料重开（IT-29 身份保留），单元从 exhausted 回在库；
 * - 在途单元不可退料（IT-13）；
 * - 同 operationId 幂等重放：返回原结果、流水不重复。
 */

let pool: pg.Pool
let bus: ReturnType<typeof buildInventoryCommandBus>
let adminCtx: CommandContext
let szPlantId = ''
let dbAvailable = true
const run = `mret${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

const LOC_A = '11111111-1111-4111-8111-1111111111a1'
const LOC_A_CODE = 'SZ01-01-01'
const LOC_B = '11111111-1111-4111-8111-1111111111b2'
const LOC_B_CODE = 'SZ01-01-02'
const LOC_T = '11111111-1111-4111-8111-1111111111e9'
const LOC_T_CODE = 'TRANSIT-01'
const OWNER = '22222222-2222-4222-8222-222222222201'
const OWNER_NAME = '华东电缆集团（自有）'
const UOM_M = '33333333-3333-4333-8333-3333333333c1'
const MATERIAL = '44444444-4444-4444-8444-4444444444d1'

beforeAll(async () => {
  pool = createPool(undefined, { max: 4 })
  try {
    await pool.query('SELECT 1')
  } catch {
    dbAvailable = false
    console.warn('SKIP material-return: 数据库不可达。请先 docker compose up -d 再重跑。')
    return
  }
  await migrateUp(pool, migrations)
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  szPlantId = (await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'PLNT-SZ'`)).rows[0]!.id
  bus = buildInventoryCommandBus(pool)
})

afterAll(async () => {
  if (pool) {
    // 同 inventory-posting.spec 口径：共享 dev 库测试痕迹清理（append-only 表用 TRUNCATE CASCADE）
    await pool
      .query(
        `TRUNCATE stock_entry, stock_transaction, stock_balance, reservation, genealogy_edge,
           customer_segment, carrier_binding, carrier, barcode_binding, barcode_label, barcode_format,
           material_segment, inventory_unit, material_lot CASCADE`,
      )
      .catch(() => undefined)
    await pool.query(`DELETE FROM outbox WHERE aggregate_type = 'inventory_unit'`).catch(() => undefined)
    await pool.query(`DELETE FROM audit_entry WHERE action = 'inventory.return-material'`).catch(() => undefined)
    await pool.query(`DELETE FROM command_receipt WHERE operation_id LIKE $1`, [`${run}%`]).catch(() => undefined)
    await pool.end()
  }
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

async function receive(operationId: string, unitNo: string, quantity: string): Promise<CommandResult> {
  return bus.execute(
    envelope(operationId, 'inventory.receive-goods', {
      plantId: szPlantId,
      lotNo: `LOT-${run}-${unitNo}`,
      unitNo,
      materialId: MATERIAL,
      materialCode: 'MAT-CABLE-01',
      uomId: UOM_M,
      uomCode: 'm',
      quantity,
      measurementBasis: 'nominal',
      locationId: LOC_A,
      locationCode: LOC_A_CODE,
      ownerId: OWNER,
      ownerName: OWNER_NAME,
      qualityStatus: 'qualified',
    }),
    adminCtx,
  )
}

async function issue(operationId: string, unitId: string, quantity: string): Promise<CommandResult> {
  return bus.execute(
    envelope(operationId, 'inventory.issue-material', { unitId, quantity, reason: 'P1 退料测试领用' }),
    adminCtx,
  )
}

async function returnMat(operationId: string, unitId: string, quantity: string, locationId = LOC_B, locationCode = LOC_B_CODE): Promise<CommandResult> {
  return bus.execute(
    envelope(operationId, 'inventory.return-material', {
      plantId: szPlantId,
      unitId,
      quantity,
      locationId,
      locationCode,
      reason: 'P1 退料测试：未用余料退回仓库',
    }),
    adminCtx,
  )
}

describe('inventory.return-material 原料退料（真容器）', () => {
  it('正常退料：reverse 反向流水（扣前/扣后）+ 新键余额 + Outbox 任务 + 可退余量核减', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const recv = await receive(nextOp('recv'), `U-${run}-A`, '100.0000')
    const uid = String((recv.data as Record<string, unknown> | null)?.['unitId'] ?? '')
    expect(recv.status).toBe(CommandResultStatus.COMMITTED)
    expect(uid).toBeTruthy()

    const issued = await issue(nextOp('issue'), uid, '70.0000')
    expect(issued.status).toBe(CommandResultStatus.COMMITTED)

    const ret = await returnMat(nextOp('ret'), uid, '20.0000')
    expect(ret.status).toBe(CommandResultStatus.COMMITTED)
    const data = (ret.data ?? {}) as Record<string, unknown>
    expect(data['beforeQty']).toBe('0.0000')
    expect(data['afterQty']).toBe('20.0000')
    expect(data['remainingReturnable']).toBe('50.0000') // 70 领用 − 20 已退

    // 新键余额 20；原键余额 30
    const balances = await pool.query<{ location_code: string; quantity: string; status: string }>(
      `SELECT location_code, quantity::text, status FROM stock_balance WHERE unit_id = $1 ORDER BY location_code`,
      [uid],
    )
    const byLoc = new Map(balances.rows.map((r) => [r.location_code, r]))
    expect(byLoc.get(LOC_B_CODE)).toMatchObject({ quantity: '20.0000', status: 'active' })
    expect(byLoc.get(LOC_A_CODE)).toMatchObject({ quantity: '30.0000', status: 'active' })

    // reverse 反向流水：扣前 0 → 扣后 20，ref_type=material_return
    const lines = await pool.query<{
      movement_kind: string
      quantity: string
      before_qty: string
      after_qty: string
      ref_type: string
    }>(
      `SELECT movement_kind, quantity::text, before_qty::text, after_qty::text, ref_type
       FROM stock_transaction WHERE unit_id = $1 AND movement_kind = 'reverse'`,
      [uid],
    )
    expect(lines.rows).toHaveLength(1)
    expect(lines.rows[0]).toMatchObject({
      quantity: '20.0000',
      before_qty: '0.0000',
      after_qty: '20.0000',
      ref_type: 'material_return',
    })

    // Outbox 任务行（同事务）
    const outbox = await pool.query<{ task_kind: string }>(
      `SELECT task_kind FROM outbox WHERE aggregate_id = $1 AND task_kind = 'inventory.material-returned'`,
      [uid],
    )
    expect(outbox.rows).toHaveLength(1)

    // 审计行
    const audit = await pool.query(`SELECT 1 FROM audit_entry WHERE action = 'inventory.return-material' AND subject_id = $1`, [uid])
    expect(audit.rowCount).toBe(1)
  })

  it('防超退：退料量超过 累计领用−已退 → BUSINESS_REJECTION [IT-28]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const recv = await receive(nextOp('recv2'), `U-${run}-B`, '100.0000')
    const uid = String((recv.data as Record<string, unknown> | null)?.['unitId'] ?? '')
    await issue(nextOp('issue2'), uid, '50.0000')
    // 可退 50；退 50.0001 → 拒
    const over = await returnMat(nextOp('ret-over'), uid, '50.0001')
    expect(over.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(String((over as { errorMessage?: string }).errorMessage)).toContain('IT-28')
    // 无 reverse 流水落库
    const lines = await pool.query(`SELECT 1 FROM stock_transaction WHERE unit_id = $1 AND movement_kind = 'reverse'`, [uid])
    expect(lines.rowCount).toBe(0)
  })

  it('投空退回原键：零余额关闭行重开（同 balanceId），单元 exhausted → in_stock', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const recv = await receive(nextOp('recv3'), `U-${run}-C`, '50.0000')
    const uid = String((recv.data as Record<string, unknown> | null)?.['unitId'] ?? '')
    const balanceId = String((recv.data as Record<string, unknown> | null)?.['balanceId'] ?? '')
    await issue(nextOp('issue3'), uid, '50.0000') // 全量投空 → 零余额关闭 + exhausted

    const closed = await pool.query<{ status: string; quantity: string }>(
      `SELECT sb.status, sb.quantity::text FROM stock_balance sb WHERE sb.id = $1`,
      [balanceId],
    )
    expect(closed.rows[0]).toMatchObject({ status: 'closed', quantity: '0.0000' })
    const unitExhausted = await pool.query<{ status: string }>(`SELECT status FROM inventory_unit WHERE id = $1`, [uid])
    expect(unitExhausted.rows[0]!.status).toBe('exhausted')

    // 退回原库位：关闭行重开（同 id）、量恢复 50、单元回在库
    const ret = await returnMat(nextOp('ret3'), uid, '50.0000', LOC_A, LOC_A_CODE)
    expect(ret.status).toBe(CommandResultStatus.COMMITTED)

    const reopened = await pool.query<{ status: string; quantity: string }>(
      `SELECT status, quantity::text FROM stock_balance WHERE id = $1`,
      [balanceId],
    )
    expect(reopened.rows[0]).toMatchObject({ status: 'active', quantity: '50.0000' })
    const unitBack = await pool.query<{ status: string; balance_open: boolean }>(
      `SELECT status, balance_open FROM inventory_unit WHERE id = $1`,
      [uid],
    )
    expect(unitBack.rows[0]).toMatchObject({ status: 'in_stock', balance_open: true })
    // 全单元余额合计守恒：50（退回即恢复原量）
    const total = await pool.query<{ sum: string }>(
      `SELECT COALESCE(sum(quantity),0)::text AS sum FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
      [uid],
    )
    expect(total.rows[0]!.sum).toBe('50.0000')
  })

  it('在途单元不可退料（IT-13）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const recv = await receive(nextOp('recv4'), `U-${run}-D`, '30.0000')
    const uid = String((recv.data as Record<string, unknown> | null)?.['unitId'] ?? '')
    await issue(nextOp('issue4'), uid, '10.0000')
    const out = await bus.execute(
      envelope(nextOp('tout'), 'inventory.transfer.out', {
        unitId: uid,
        quantity: '20.0000',
        transitLocationId: LOC_T,
        transitLocationCode: LOC_T_CODE,
      }),
      adminCtx,
    )
    expect(out.status).toBe(CommandResultStatus.COMMITTED)

    const ret = await returnMat(nextOp('ret4'), uid, '5.0000')
    expect(ret.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(String((ret as { errorMessage?: string }).errorMessage)).toContain('IT-13')
  })

  it('同 operationId 幂等重放：返回原结果、reverse 流水不重复', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const recv = await receive(nextOp('recv5'), `U-${run}-E`, '40.0000')
    const uid = String((recv.data as Record<string, unknown> | null)?.['unitId'] ?? '')
    await issue(nextOp('issue5'), uid, '30.0000')
    const op = nextOp('ret5')
    const first = await returnMat(op, uid, '10.0000')
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const replay = await returnMat(op, uid, '10.0000')
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect((replay.data ?? null)).toEqual(first.data ?? null)
    const lines = await pool.query(`SELECT 1 FROM stock_transaction WHERE unit_id = $1 AND movement_kind = 'reverse'`, [uid])
    expect(lines.rowCount).toBe(1)
  })
})
