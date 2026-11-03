import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  CommandResultStatus,
  ERROR_CODES,
  type CommandEnvelope,
  type CommandResult,
} from '@cadenza/contracts'
import { createScryptPasswordHasher, type CommandContext } from '@cadenza/application'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { migration0004 } from '../../packages/persistence/src/migrations/0004-inventory-trace'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'

/**
 * 库存记账内核集成（真容器 cadenza-dev-pg @55433，真实命令总线与真实组合根，无桩）。
 * 证据六类（WorkItem 冻结）：①余量竞争 ②同 operationId 重放只入账一次 ③分盘守恒+零余额关闭
 * ④append-only 违反被拒 ⑤预留过期后旧提交须重校验（⑥跨厂 403 属 API 层，见 tests/api）。
 * 迁移：注册表（0001/0002）+ 本块 0004（不注册，编程式单独应用——L0 整合步统一注册）。
 */

let pool: pg.Pool
let bus: ReturnType<typeof buildInventoryCommandBus>
let adminCtx: CommandContext
let szPlantId = ''
let hfPlantId = ''
let enterpriseId = ''
let dbAvailable = true
const run = `inv${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

const LOC_A = '11111111-1111-4111-8111-1111111111a1' // 主库位（uuid 占位：库位主数据属 0003，快照编码携带）
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
    console.warn('SKIP inventory-posting: 数据库不可达。请先 docker compose up -d 再重跑。')
    return
  }
  await migrateUp(pool, migrations) // 0001 + 0002（幂等）
  await migrateUp(pool, [migration0004]) // 0004 编程式应用（不注册共享表）
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
  enterpriseId = admin.rows[0]!.enterprise_id
  const plants = await pool.query<{ code: string; id: string }>(
    `SELECT code, id FROM org_node WHERE code IN ('PLNT-SZ','PLNT-HF')`,
  )
  szPlantId = plants.rows.find((r) => r.code === 'PLNT-SZ')!.id
  hfPlantId = plants.rows.find((r) => r.code === 'PLNT-HF')!.id
  bus = buildInventoryCommandBus(pool)
})

afterAll(async () => {
  if (pool) {
    // 测试痕迹清理（append-only 表用 TRUNCATE CASCADE，不触发行级 DELETE 触发器；
    // CASCADE 连带清空依赖 0004 表的后块数据行——report_output 等）。
    // 0004 已由 Wave3 注册进 registry：不再「卸下 0004」——DROP 0004 表 CASCADE 会连带
    // DROP 0008/0009 的 FK 依赖表（report_output 等）而 schema_migrations 行仍在，
    // migrateUp 无法恢复（Wave5 注册 0007–0009 后该清理口径已不可用）。
    await pool
      .query(
        `TRUNCATE stock_entry, stock_transaction, stock_balance, reservation, genealogy_edge,
           customer_segment, carrier_binding, carrier, barcode_binding, barcode_label, barcode_format,
           material_segment, inventory_unit, material_lot CASCADE`,
      )
      .catch(() => undefined)
    await pool
      .query(`DELETE FROM command_receipt WHERE operation_id LIKE 'inv-%' OR operation_id LIKE $1`, [`${run}%`])
      .catch(() => undefined)
    await pool.query(`DELETE FROM outbox WHERE aggregate_type IN ('inventory_unit','reservation')`).catch(() => undefined)
    await pool.query(`DELETE FROM audit_entry WHERE action LIKE 'inventory.%'`).catch(() => undefined)
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

async function receive(operationId: string, unitNo: string, quantity: string, overrides: Record<string, unknown> = {}): Promise<CommandResult> {
  return bus.execute(
    envelope(operationId, 'inventory.receive-goods', {
      plantId: szPlantId,
      lotNo: `LOT-${run}`,
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
      ...overrides,
    }),
    adminCtx,
  )
}

async function balanceOf(unitId: string): Promise<{ quantity: string; status: string }> {
  const r = await pool.query<{ quantity: string; status: string }>(
    `SELECT quantity::text AS quantity, status FROM stock_balance WHERE unit_id = $1`,
    [unitId],
  )
  return r.rows[0]!
}

describe('① 余量竞争（IT-30-①：100m 并发扣 70/50 → 恰一成功、可解释拒绝、无负库存、重试不重复扣）', () => {
  it('并发两笔发料：恰好一笔 COMMITTED、另一笔 ERR_INSUFFICIENT_STOCK；账面 = 100 − 成交额', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const unitNo = `HT-${run}-R1`
    const received = await receive(nextOp('r1'), unitNo, '100.0000')
    expect(received.status).toBe(CommandResultStatus.COMMITTED)
    const unitId = (received.data as { unitId: string }).unitId

    const requestA = { opId: nextOp('i70'), qty: '70.0000' }
    const requestB = { opId: nextOp('i50'), qty: '50.0000' }
    const [resA, resB] = await Promise.all([
      bus.execute(envelope(requestA.opId, 'inventory.issue-material', { unitId, quantity: requestA.qty }), adminCtx),
      bus.execute(envelope(requestB.opId, 'inventory.issue-material', { unitId, quantity: requestB.qty }), adminCtx),
    ])
    const outcomes = [resA, resB].sort((x, y) => x.status.localeCompare(y.status))
    const committed = outcomes.find((r) => r.status === CommandResultStatus.COMMITTED)
    const rejected = outcomes.find((r) => r.status === CommandResultStatus.BUSINESS_REJECTION)
    expect(committed).toBeDefined()
    expect(rejected).toBeDefined()
    expect(rejected!.errorCode).toBe(ERROR_CODES.INSUFFICIENT_STOCK)
    expect(rejected!.errorMessage).toContain('IT-14')

    const committedQty = (committed!.data as { afterQty: string }).afterQty
    const after = await balanceOf(unitId)
    expect(after.quantity).toBe(committedQty) // 100−70=30 或 100−50=50，账上无负数（CHECK quantity>=0 兜底）
    expect(Number(after.quantity)).toBeGreaterThan(0)

    // 重试不重复扣：被拒命令原 operationId + 原载荷重放 → 原拒绝结果原样返回，不产生第二条扣减流水
    const rejectedRequest = rejected === resA ? requestA : requestB
    const replayRejected = await bus.execute(
      envelope(rejectedRequest.opId, 'inventory.issue-material', { unitId, quantity: rejectedRequest.qty }),
      adminCtx,
    )
    expect(replayRejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(replayRejected.errorCode).toBe(ERROR_CODES.INSUFFICIENT_STOCK)
    const lines = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM stock_transaction WHERE unit_id = $1 AND movement_kind = 'issue'`,
      [unitId],
    )
    expect(lines.rows[0]!.n).toBe(1) // 仅成交一笔扣减流水
    expect((await balanceOf(unitId)).quantity).toBe(committedQty)
  })
})

describe('② 同 operationId 重放只入账一次（IT-19/21）', () => {
  it('收货命令重放：同一 unitNo 原结果返回；行数断言 1', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const unitNo = `HT-${run}-IDEM`
    const operationId = nextOp('idem')
    const first = await receive(operationId, unitNo, '80.0000')
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const replay = await receive(operationId, unitNo, '80.0000')
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect((replay.data as { unitId: string }).unitId).toBe((first.data as { unitId: string }).unitId)

    const units = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM inventory_unit WHERE unit_no = $1 AND plant_id = $2`,
      [unitNo, szPlantId],
    )
    expect(units.rows[0]!.n).toBe(1)
    const receipts = await pool.query<{ n: number; lines: number }>(
      `SELECT (SELECT count(*)::int FROM command_receipt WHERE operation_id = $1) AS n,
              (SELECT count(*)::int FROM stock_transaction st
                 JOIN command_receipt cr ON cr.id = st.command_receipt_id
               WHERE cr.operation_id = $1) AS lines`,
      [operationId],
    )
    expect(receipts.rows[0]!.n).toBe(1)
    expect(receipts.rows[0]!.lines).toBe(1) // 重放不产生第二条流水
    const balances = await pool.query<{ n: number; qty: string }>(
      `SELECT count(*)::int AS n, max(quantity)::text AS qty FROM stock_balance WHERE unit_id = (SELECT id FROM inventory_unit WHERE unit_no = $1 AND plant_id = $2)`,
      [unitNo, szPlantId],
    )
    expect(balances.rows[0]!.n).toBe(1)
    expect(balances.rows[0]!.qty).toBe('80.0000')
  })
})

describe('③ 分盘守恒与零余额关闭（IT-28/29）', () => {
  it('1000m 分为 600+390+10 损耗：守恒通过；源单元零余额关闭且身份保留；子单元可查', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const unitNo = `HT-${run}-SP`
    const received = await receive(nextOp('sp-r'), unitNo, '1000.0000')
    expect(received.status).toBe(CommandResultStatus.COMMITTED)
    const unitId = (received.data as { unitId: string }).unitId

    const split = await bus.execute(
      envelope(nextOp('sp-s'), 'inventory.split', {
        sourceUnitId: unitId,
        retainedQty: '0.0000',
        lossQty: '10.0000',
        reason: '倒轴截头损耗（集成证据）',
        children: [
          { unitNo: `HT-${run}-SP-C1`, quantity: '600.0000', locationId: LOC_A, locationCode: LOC_A_CODE },
          { unitNo: `HT-${run}-SP-C2`, quantity: '390.0000', locationId: LOC_B, locationCode: LOC_B_CODE },
        ],
      }),
      adminCtx,
    )
    expect(split.status).toBe(CommandResultStatus.COMMITTED)
    expect((split.data as { sourceBalanceClosed: boolean }).sourceBalanceClosed).toBe(true)

    // 源单元：零余额关闭活动余额，身份与谱系节点保留（不删除档案）
    const source = await pool.query<{ status: string; balance_open: boolean; quantity: string; bal_status: string }>(
      `SELECT iu.status, iu.balance_open, sb.quantity::text AS quantity, sb.status AS bal_status
       FROM inventory_unit iu JOIN stock_balance sb ON sb.unit_id = iu.id
       WHERE iu.id = $1`,
      [unitId],
    )
    expect(source.rows[0]!.bal_status).toBe('closed')
    expect(source.rows[0]!.quantity).toBe('0.0000')
    expect(source.rows[0]!.balance_open).toBe(false)
    expect(source.rows[0]!.status).toBe('exhausted')

    // 守恒：600 + 390 + 10(损耗) = 1000
    const children = await pool.query<{ unit_no: string; quantity: string }>(
      `SELECT iu.unit_no, sb.quantity::text AS quantity
       FROM inventory_unit iu JOIN stock_balance sb ON sb.unit_id = iu.id
       WHERE iu.unit_no LIKE $1`,
      [`HT-${run}-SP-C%`],
    )
    expect(children.rows).toHaveLength(2)
    const total = children.rows.reduce((acc, r) => acc + Number(r.quantity), 0)
    expect(total + 10).toBe(1000)

    // 谱系：源单元 → 两个子单元的消费边（IT-34；身份保留的证据）
    const edges = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM genealogy_edge WHERE from_id = $1 AND edge_kind = 'consumption'`,
      [unitId],
    )
    expect(edges.rows[0]!.n).toBe(2)
  })
})

describe('④ append-only 违反被拒（IT-S6/IT-33）', () => {
  it('material_lot UPDATE / genealogy_edge DELETE 均被触发器拒绝；行仍在', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const unitNo = `HT-${run}-APP`
    const received = await receive(nextOp('app'), unitNo, '10.0000')
    const unitId = (received.data as { unitId: string }).unitId
    const lotId = (received.data as { lotId: string }).lotId

    const upd = await pool
      .query(`UPDATE material_lot SET note = '篡改历史' WHERE id = $1`, [lotId])
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    expect(upd).toContain('IT-S6')

    const del = await pool
      .query(`DELETE FROM genealogy_edge WHERE to_id = $1`, [unitId])
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    expect(del).toContain('IT-S6')

    const lot = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM material_lot WHERE id = $1`, [lotId])
    expect(lot.rows[0]!.n).toBe(1)
    const edge = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM genealogy_edge WHERE to_id = $1 AND edge_kind = 'receipt_origin'`,
      [unitId],
    )
    expect(edge.rows[0]!.n).toBe(1)
  })
})

describe('⑤ 预留过期后旧提交须重校验（IT-23）', () => {
  it('有效预留内发料成功；过期后凭旧预留提交被拒（且可用量已不含过期预留）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const unitNo = `HT-${run}-RES`
    const received = await receive(nextOp('res-r'), unitNo, '100.0000')
    const unitId = (received.data as { unitId: string }).unitId

    // 第二单元：签发短有效期预留
    const until = new Date(Date.now() + 1_500).toISOString()
    const acquired = await bus.execute(
      envelope(nextOp('res-a'), 'inventory.reservation.acquire', {
        unitId,
        quantity: '60.0000',
        holderType: 'job',
        holderRef: 'WO-RES-TEST',
        validUntil: until,
      }),
      adminCtx,
    )
    expect(acquired.status).toBe(CommandResultStatus.COMMITTED)
    const reservationId = (acquired.data as { reservationId: string }).reservationId

    // 签发即时可用预留（另签一笔）验证预留内发料成功路径
    const acquired2 = await bus.execute(
      envelope(nextOp('res-a2'), 'inventory.reservation.acquire', {
        unitId,
        quantity: '5.0000',
        holderType: 'job',
        holderRef: 'WO-RES-OK',
        validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      adminCtx,
    )
    expect(acquired2.status).toBe(CommandResultStatus.COMMITTED)
    const withReservation = await bus.execute(
      envelope(nextOp('res-i2'), 'inventory.issue-material', {
        unitId,
        quantity: '5.0000',
        reservationId: (acquired2.data as { reservationId: string }).reservationId,
      }),
      adminCtx,
    )
    expect(withReservation.status).toBe(CommandResultStatus.COMMITTED)

    // 等待第一笔预留过期
    await new Promise((resolve) => setTimeout(resolve, 1_800))

    // 过期后旧终端提交：凭过期预留发料 → 必须重校验失败（不得凭过期预留直接入账）
    const stale = await bus.execute(
      envelope(nextOp('res-stale'), 'inventory.issue-material', { unitId, quantity: '60.0000', reservationId }),
      adminCtx,
    )
    expect(stale.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(stale.errorMessage).toContain('IT-23')

    // 过期预留不占可用量：无预留引用发料 30（毛量 95 − 有效预留 0 = 95 ≥ 30）应成功
    const free = await bus.execute(
      envelope(nextOp('res-free'), 'inventory.issue-material', { unitId, quantity: '30.0000' }),
      adminCtx,
    )
    expect(free.status).toBe(CommandResultStatus.COMMITTED)
    expect((await balanceOf(unitId)).quantity).toBe('65.0000') // 100 − 5(预留内核销) − 30(过期后自由扣)
  }, 20_000)
})

describe('记账服务补证：移位与调拨两段（IT-20/25）', () => {
  it('移位 A→B 两行流水守恒；调拨出（源减+在途增）与调拨入（在途减+目的增）两段各自原子', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const unitNo = `HT-${run}-MV`
    const received = await receive(nextOp('mv-r'), unitNo, '100.0000')
    const unitId = (received.data as { unitId: string }).unitId

    const moved = await bus.execute(
      envelope(nextOp('mv-m'), 'inventory.move-stock', {
        unitId,
        quantity: '40.0000',
        toLocationId: LOC_B,
        toLocationCode: LOC_B_CODE,
      }),
      adminCtx,
    )
    expect(moved.status).toBe(CommandResultStatus.COMMITTED)
    const balances = await pool.query<{ location_code: string; quantity: string }>(
      `SELECT location_code, quantity::text AS quantity FROM stock_balance WHERE unit_id = $1 ORDER BY location_code`,
      [unitId],
    )
    expect(balances.rows).toEqual([
      { location_code: LOC_A_CODE, quantity: '60.0000' },
      { location_code: LOC_B_CODE, quantity: '40.0000' },
    ])

    const out = await bus.execute(
      envelope(nextOp('mv-to'), 'inventory.transfer.out', {
        unitId,
        quantity: '60.0000',
        fromLocationId: LOC_A,
        ownerId: OWNER, // 移位后单元存在两条活动余额：显式指定键（IT-20 显式选择）
        transitLocationId: LOC_T,
        transitLocationCode: LOC_T_CODE,
      }),
      adminCtx,
    )
    expect(out.status).toBe(CommandResultStatus.COMMITTED)
    const unitStatus = await pool.query<{ status: string; t_qty: string }>(
      `SELECT iu.status, (SELECT quantity::text FROM stock_balance WHERE unit_id = iu.id AND location_id = $2) AS t_qty
       FROM inventory_unit iu WHERE iu.id = $1`,
      [unitId, LOC_T],
    )
    expect(unitStatus.rows[0]!.status).toBe('in_transit') // IT-13 状态轴
    expect(unitStatus.rows[0]!.t_qty).toBe('60.0000')

    const transferredIn = await bus.execute(
      envelope(nextOp('mv-ti'), 'inventory.transfer.in', {
        unitId,
        quantity: '60.0000',
        transitLocationId: LOC_T,
        toLocationId: LOC_A,
        toLocationCode: LOC_A_CODE,
      }),
      adminCtx,
    )
    expect(transferredIn.status).toBe(CommandResultStatus.COMMITTED)
    const after = await pool.query<{ status: string; a_qty: string; t_closed: string }>(
      `SELECT iu.status,
              (SELECT quantity::text FROM stock_balance WHERE unit_id = iu.id AND location_id = $2) AS a_qty,
              (SELECT status FROM stock_balance WHERE unit_id = iu.id AND location_id = $3) AS t_closed
       FROM inventory_unit iu WHERE iu.id = $1`,
      [unitId, LOC_A, LOC_T],
    )
    expect(after.rows[0]!.status).toBe('in_stock')
    expect(after.rows[0]!.a_qty).toBe('60.0000')
    expect(after.rows[0]!.t_closed).toBe('closed') // 在途余额归零关闭（IT-29）
  })

  it('IT-S1：厂范围 actor 向范围外工厂收货被拒（FORBIDDEN_SCOPE）；范围内成功', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hfUser = await pool.query<{ id: string }>(
      `SELECT id FROM user_account WHERE login_name = 'hfadmin01'`,
    )
    const hfCtx: CommandContext = {
      actorUserId: hfUser.rows[0]!.id,
      actorLoginName: 'hfadmin01',
      enterpriseId,
      reason: null,
    }
    // 合肥厂 actor（plantadmin 授权仅覆盖 PLNT-HF）向苏州厂收货 → FORBIDDEN_SCOPE（写路径二道防线）
    const denied = await bus.execute(
      envelope(nextOp('scope-x'), 'inventory.receive-goods', {
        plantId: szPlantId,
        lotNo: `LOT-${run}`,
        unitNo: `HT-${run}-XPLANT`,
        materialId: MATERIAL,
        materialCode: 'MAT-CABLE-01',
        uomId: UOM_M,
        uomCode: 'm',
        quantity: '5.0000',
        measurementBasis: 'nominal',
        locationId: LOC_A,
        locationCode: LOC_A_CODE,
        ownerId: OWNER,
        ownerName: OWNER_NAME,
      }),
      hfCtx,
    )
    expect(denied.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(denied.errorCode).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    expect(denied.errorMessage).toContain('IT-S1')

    // 同 actor 向本厂（合肥）收货成功（plant 隔离列语义而非硬编码厂）
    const ok = await bus.execute(
      envelope(nextOp('scope-ok'), 'inventory.receive-goods', {
        plantId: hfPlantId,
        lotNo: `LOT-${run}`,
        unitNo: `HT-${run}-HF`,
        materialId: MATERIAL,
        materialCode: 'MAT-CABLE-01',
        uomId: UOM_M,
        uomCode: 'm',
        quantity: '5.0000',
        measurementBasis: 'nominal',
        locationId: LOC_A,
        locationCode: LOC_A_CODE,
        ownerId: OWNER,
        ownerName: OWNER_NAME,
      }),
      hfCtx,
    )
    expect(ok.status).toBe(CommandResultStatus.COMMITTED)
  })
})
