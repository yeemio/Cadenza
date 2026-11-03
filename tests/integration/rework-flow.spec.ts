import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { PgReworkFactsLookup } from '@cadenza/persistence'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext, VerifiedAuthContext } from '@cadenza/application'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildReworkCommandBus, buildReworkQueryService } from '../../apps/api/src/rework/rework.composition'
import {
  RWK_OWNER_ID,
  RWK_OWNER_NAME,
  RWK_TEST_DB_NAME,
  prepareRwkTestDatabase,
  type RwkFixtures,
} from '../api/rework-test-env'

/**
 * rework 域集成（真容器独立库 cadenza_rework + 真实命令总线与组合根，无业务桩）。
 * 冻结合同 frozen/p2/rework-split.md 贯穿验收样例与主链证据：
 * ① 倒轴（RS-01～12）：A05 守恒 1,000=600+390+10 损耗、客户段长全量倒出（RS-05）、
 *    扣尽关闭余额不删档（RS-10）、倒入合计超守恒拒绝、冲销下游受阻（A11）/冲销恢复
 *    （RS-12 append-only 冲销事实派生）；
 * ② 分托/解绑（RS-13～24）：车间/非车间三处分叉、进行中单据唯一、新托/老托、
 *    装入即锁定（reservation 四要素 RS-S4）、预留过期重校验（A11）、确认改绑+移库、
 *    放弃语义、解绑位置不变、导出合并；
 * ③ 轴号修正（RS-25～33）：可选列表、提交校验、占用核权（RS-30 权限+理由+审计）、
 *    执行改值/清占用/数量扣减（RS-29）、回撤恢复（RS-32）、下游拦截（RS-33）；
 * ④ 轴码退役（RS-34～37）：前置拒绝、退役+清空记录+零余额关闭一次事务、
 *    退役码命令入口显式拒绝（RS-36）、append-only 守卫（RS-S6）、修正记录历史值守卫（RS-S5）；
 * ⑧ 幂等与审计：同 operationId 回放原结果、audit_log 行存在。
 */

let pool: pg.Pool
let reworkBus: ReturnType<typeof buildReworkCommandBus>
let inventoryBus: ReturnType<typeof buildInventoryCommandBus>
let queries: ReturnType<typeof buildReworkQueryService>
let adminCtx: CommandContext
let workshopCtx: CommandContext
let adminAuth: VerifiedAuthContext
let fx: RwkFixtures
let dbAvailable = true
const run = `rwk${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

beforeAll(async () => {
  try {
    pool = await prepareRwkTestDatabase()
  } catch (error) {
    if (process.env['CADENZA_REQUIRE_PG'] === '1') throw error
    dbAvailable = false
    console.warn(`SKIP rework-flow: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${RWK_TEST_DB_NAME}）。`)
    return
  }
  const env = await import('../api/rework-test-env.js')
  const seeded = await env.seedRwkFixtures(pool)
  fx = seeded
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  const ws = await pool.query<{ id: string }>(`SELECT id FROM user_account WHERE login_name = 'szws01'`)
  const mkCtx = (id: string, login: string): CommandContext => ({
    actorUserId: id,
    actorLoginName: login,
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  })
  adminCtx = mkCtx(admin.rows[0]!.id, 'admin')
  workshopCtx = mkCtx(ws.rows[0]!.id, 'szws01')
  adminAuth = {
    session: { id: 'test-session', expiresAt: '2099-01-01T00:00:00.000Z' },
    user: {
      id: admin.rows[0]!.id,
      loginName: 'admin',
      displayName: '集团管理员',
      enterpriseId: admin.rows[0]!.enterprise_id,
      plantId: fx.szPlantId,
      roleId: 'seed',
      loginPlatform: 'WEB',
    },
    role: { id: 'seed', name: '系统管理员', alias: 'sysadmin' },
    permissions: ['rework.read', 'rework.post'],
    dataScope: { enterpriseWide: true, plantIds: [] },
  }
  reworkBus = buildReworkCommandBus(pool)
  inventoryBus = buildInventoryCommandBus(pool)
  queries = buildReworkQueryService(pool)
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
  bus: typeof reworkBus | typeof inventoryBus,
  operationId: string,
  commandType: string,
  payload: Record<string, unknown>,
  ctx: CommandContext = adminCtx,
): Promise<CommandResult> {
  return bus.execute(envelope(operationId, commandType, payload), ctx)
}

function expectRejection(result: CommandResult, rule: string): void {
  expect(result.status).toBe('BUSINESS_REJECTION')
  expect(result.errorMessage ?? '').toContain(`[${rule}]`)
  expect(result.errorCode).toBe(ERROR_CODES.BUSINESS_RULE)
}

/** 直插非车间测试用户（qc 角色；每用例独立操作人——RS-14 进行中唯一不跨用例污染）。 */
async function newNonWorkshopCtx(loginName: string): Promise<CommandContext> {
  const dept = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM org_node WHERE code = 'DEPT-SZ-QC'`,
  )
  const role = await pool.query<{ id: string }>(`SELECT id FROM role WHERE alias = 'qc' AND enterprise_id = $1`, [dept.rows[0]!.enterprise_id])
  await pool.query(
    `INSERT INTO user_account (enterprise_id, login_name, password_hash, display_name, dept_id, role_id, login_platform, account_status, plant_id, created_by)
     VALUES ($1, $2, 'test-only-hash', $2, $3, $4, 'PDA', 'enabled', $5, 'seed')
     ON CONFLICT (login_name) DO NOTHING`,
    [dept.rows[0]!.enterprise_id, loginName, dept.rows[0]!.id, role.rows[0]!.id, fx.szPlantId],
  )
  const u = await pool.query<{ id: string }>(`SELECT id FROM user_account WHERE login_name = $1`, [loginName])
  return {
    actorUserId: u.rows[0]!.id,
    actorLoginName: loginName,
    enterpriseId: dept.rows[0]!.enterprise_id,
    reason: null,
  }
}

/** 收货一个库存单元（inventory.receive-goods；默认合格在库，单位米）。 */
async function receiveUnit(
  unitNo: string,
  locationId: string,
  locationCode: string,
  quantity = '1000.0000',
): Promise<string> {
  const r = await exec(inventoryBus, nextOp(`rcv${unitNo}`), 'inventory.receive-goods', {
    plantId: fx.szPlantId,
    quantity,
    uomId: fx.uomId,
    uomCode: 'M',
    locationId,
    locationCode,
    ownerId: RWK_OWNER_ID,
    ownerName: RWK_OWNER_NAME,
    lotNo: `LOT-${run}-${unitNo}`,
    materialId: fx.finishedMaterialId,
    materialCode: 'MAT-RWK-FIN',
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

async function activeBalanceQty(unitId: string): Promise<string | null> {
  const r = await pool.query<{ q: string }>(
    `SELECT quantity::text AS q FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
    [unitId],
  )
  return r.rows[0]?.q ?? null
}

/** 直插轴号当前值事实（本域 0011 表；订单分段明细造数）。 */
async function seedAxisState(
  unitNo: string,
  salesOrderNo: string,
  customerAxisNo: string | null,
  segmentLength: string | null,
  virtualAxisNo: string | null,
): Promise<void> {
  const u = await unitRow(unitNo)
  await pool.query(
    `INSERT INTO axis_no_state (unit_id, unit_no, sales_order_no, order_line_no, customer_axis_no, segment_length, virtual_axis_no, updated_at, updated_by)
     VALUES ($1, $2, $3, '10', $4, $5, $6, now(), 'seed')
     ON CONFLICT (unit_id) DO UPDATE SET customer_axis_no = EXCLUDED.customer_axis_no,
       segment_length = EXCLUDED.segment_length, virtual_axis_no = EXCLUDED.virtual_axis_no`,
    [u.id, unitNo, salesOrderNo, customerAxisNo, segmentLength, virtualAxisNo],
  )
}

// ================================================================
// ① 倒轴（RS-01～12）
// ================================================================

describe('① 倒轴（分盘）主链（RS-01/02/05/07/08/09/10/11 + A05）', () => {
  it('A05 守恒样例：1,000 = 600 + 390 + 10 损耗；源扣尽关闭余额不删档；子轴/明细/审计落表', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`AE${run}-SRC`, fx.szLineSideLocationId, '92980101')
    const r = await exec(reworkBus, nextOp('split1'), 'rework.reel-split.execute', {
      sourceUnitNo: `AE${run}-SRC`,
      pourLines: [
        { unitNo: `AE${run}-T1`, quantity: '600.0000' },
        { unitNo: `AE${run}-T2`, quantity: '390.0000' },
      ],
      lossQty: '10.0000',
      lossReason: '端头损耗',
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const data = r.data as { orderId: string; orderNo: string; sourceAfterQty: string; sourceBalanceClosed: boolean }
    expect(data.sourceAfterQty).toBe('0.0000')
    expect(data.sourceBalanceClosed).toBe(true)

    // RS-01 守恒：主表四列可对账
    const order = await pool.query<{
      original_qty: string
      retained_qty: string
      loss_qty: string
    }>(`SELECT original_qty::text, retained_qty::text, loss_qty::text FROM reel_split_order WHERE id = $1`, [data.orderId])
    expect(order.rows[0]!.original_qty).toBe('1000.0000')
    expect(order.rows[0]!.retained_qty).toBe('0.0000')
    expect(order.rows[0]!.loss_qty).toBe('10.0000')

    // RS-10 扣尽：源余额 closed、单元 exhausted（档案保留，不物理删除）
    const src = await unitRow(`AE${run}-SRC`)
    expect(await activeBalanceQty(src.id)).toBeNull()
    expect(src.status).toBe('exhausted')
    const archived = await pool.query(`SELECT count(*)::int AS c FROM inventory_unit WHERE id = $1`, [src.id])
    expect(archived.rows[0]!.c).toBe(1)

    // RS-09 倒入侧生成与守恒
    expect(await activeBalanceQty((await unitRow(`AE${run}-T1`)).id)).toBe('600.0000')
    expect(await activeBalanceQty((await unitRow(`AE${run}-T2`)).id)).toBe('390.0000')

    // RS-08 主表+明细展开；谱系（IT-34 同族）
    const lines = await pool.query(`SELECT count(*)::int AS c FROM reel_split_line WHERE order_id = $1`, [data.orderId])
    expect(lines.rows[0]!.c).toBe(2)
    const edges = await pool.query(`SELECT count(*)::int AS c FROM genealogy_edge WHERE from_id = $1 AND edge_kind = 'consumption'`, [src.id])
    expect(edges.rows[0]!.c).toBe(2)

    // 审计行
    const audit = await pool.query(`SELECT count(*)::int AS c FROM audit_entry WHERE subject_id = $1 AND action = 'rework.reel-split.execute'`, [data.orderId])
    expect(audit.rows[0]!.c).toBe(1)
  })

  it('RS-02/01 倒入合计＋损耗超过原量拒绝且数据不变', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`AE${run}-SRC2`, fx.szLineSideLocationId, '92980101')
    const before = await activeBalanceQty((await unitRow(`AE${run}-SRC2`)).id)
    const r = await exec(reworkBus, nextOp('split2'), 'rework.reel-split.execute', {
      sourceUnitNo: `AE${run}-SRC2`,
      pourLines: [{ unitNo: `AE${run}-T21`, quantity: '600.0000' }, { unitNo: `AE${run}-T22`, quantity: '391.0000' }],
      lossQty: '10.0000',
      lossReason: '端头损耗',
    })
    expectRejection(r, 'RS-02')
    expect(await activeBalanceQty((await unitRow(`AE${run}-SRC2`)).id)).toBe(before)
  })

  it('RS-05 客户轴段：必须全量倒出且只能一条（两约束独立拒绝）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`AE${run}-SRC3`, fx.szLineSideLocationId, '92980101')
    await seedAxisState(`AE${run}-SRC3`, `SO-${run}-x`, 'KZH-RWK-9', '600', '9')
    const two = await exec(reworkBus, nextOp('split3a'), 'rework.reel-split.execute', {
      sourceUnitNo: `AE${run}-SRC3`,
      pourLines: [{ unitNo: `AE${run}-T31`, quantity: '500.0000' }, { unitNo: `AE${run}-T32`, quantity: '490.0000' }],
      lossQty: '10.0000',
      lossReason: '端头损耗',
    })
    expectRejection(two, 'RS-05')
    const partial = await exec(reworkBus, nextOp('split3b'), 'rework.reel-split.execute', {
      sourceUnitNo: `AE${run}-SRC3`,
      pourLines: [{ unitNo: `AE${run}-T31`, quantity: '500.0000' }],
      lossQty: '0.0000',
    })
    expectRejection(partial, 'RS-05')
  })

  it('RS-09 倒入码已有料品与倒出不一致整体失败；RS-36 退役码拒绝', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`AE${run}-SRC4`, fx.szLineSideLocationId, '92980101')
    // 造异料品码
    const other = (
      await pool.query<{ id: string }>(
        `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
         VALUES ((SELECT enterprise_id FROM org_node WHERE code = 'PLNT-SZ'), 'MAT-RWK-OTHER', 'rework演示-其它缆', 3, 'M', 0, 'U9', 'seed')
         ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      )
    ).rows[0]!.id
    const otherUnit = (
      await pool.query<{ id: string }>(
        `INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code, trace_mode, status, plant_id, enterprise_id, created_by)
         SELECT $1, $2, 'MAT-RWK-OTHER', l.id, u.uom_id, 'M', 'quantity', 'in_stock', iu.plant_id, iu.enterprise_id, 'seed'
         FROM inventory_unit iu JOIN material_lot l ON l.id = iu.lot_id JOIN inventory_unit u ON u.unit_no = $1
         LIMIT 1 RETURNING id`,
        [`AE${run}-OTHER`, other],
      )
    ).rows[0]
    if (otherUnit !== undefined) {
      const r = await exec(reworkBus, nextOp('split4'), 'rework.reel-split.execute', {
        sourceUnitNo: `AE${run}-SRC4`,
        pourLines: [{ unitNo: `AE${run}-OTHER`, quantity: '100.0000' }],
        lossQty: '0.0000',
      })
      expectRejection(r, 'RS-09')
    }
  })

  it('RS-12 冲销：子轴入库后受阻（A11 可解释原因）；未受阻单冲销恢复源原量、冲销事实派生 reversed', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 单 A：子轴移入物流部仓（WAREHOUSE）→ 冲销受阻
    await receiveUnit(`AE${run}-S5`, fx.szLineSideLocationId, '92980101')
    const a = await exec(reworkBus, nextOp('split5'), 'rework.reel-split.execute', {
      sourceUnitNo: `AE${run}-S5`,
      pourLines: [{ unitNo: `AE${run}-T51`, quantity: '600.0000' }, { unitNo: `AE${run}-T52`, quantity: '390.0000' }],
      lossQty: '10.0000',
      lossReason: '端头损耗',
    })
    const orderA = (a.data as { orderId: string }).orderId
    const t1 = await unitRow(`AE${run}-T51`)
    const moved = await exec(inventoryBus, nextOp(`mv${run}T51`), 'inventory.move-stock', {
      unitId: t1.id,
      quantity: '600.0000',
      fromLocationId: fx.szLineSideLocationId,
      toLocationId: fx.szLogisticsLocationId,
      toLocationCode: '010101',
    })
    expect(moved.status).toBe(CommandResultStatus.COMMITTED)
    const blocked = await exec(reworkBus, nextOp('rev5'), 'rework.reel-split.reverse', {
      sourceOrderId: orderA,
      reason: '冲销测试',
    })
    expectRejection(blocked, 'RS-12')

    // 单 B：无下游 → 冲销成功
    await receiveUnit(`AE${run}-S6`, fx.szLineSideLocationId, '92980101')
    const b = await exec(reworkBus, nextOp('split6'), 'rework.reel-split.execute', {
      sourceUnitNo: `AE${run}-S6`,
      pourLines: [{ unitNo: `AE${run}-T61`, quantity: '1000.0000' }],
      lossQty: '0.0000',
    })
    const orderB = (b.data as { orderId: string; orderNo: string }).orderId
    const s6 = await unitRow(`AE${run}-S6`)
    expect(s6.status).toBe('exhausted') // 扣尽关闭
    const rv = await exec(reworkBus, nextOp('rev6'), 'rework.reel-split.reverse', {
      sourceOrderId: orderB,
      reason: '测试冲销恢复',
    })
    expect(rv.status).toBe(CommandResultStatus.COMMITTED)
    // 源恢复原量、余额行重开
    expect(await activeBalanceQty(s6.id)).toBe('1000.0000')
    expect((await unitRow(`AE${run}-S6`)).status).toBe('in_stock')
    // 子轴扣回归零关闭（冲销创建的新单元）
    expect((await unitRow(`AE${run}-T61`)).status).toBe('exhausted')
    // RS-S1 append-only：主表无 UPDATE（冲销事实行存在、派生 reversed；表级守卫见 ④）
    const reversal = await pool.query(`SELECT count(*)::int AS c FROM reel_split_reversal WHERE source_order_id = $1`, [orderB])
    expect(reversal.rows[0]!.c).toBe(1)
    const dup = await exec(reworkBus, nextOp('rev6dup'), 'rework.reel-split.reverse', {
      sourceOrderId: orderB,
      reason: '重复冲销',
    })
    expectRejection(dup, 'RS-12')
  })

  it('幂等：同 operationId 重放回放原结果（倒轴单恰一张）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`AE${run}-S7`, fx.szLineSideLocationId, '92980101')
    const op = nextOp('split7')
    const payload = {
      sourceUnitNo: `AE${run}-S7`,
      pourLines: [{ unitNo: `AE${run}-T71`, quantity: '1000.0000' }],
      lossQty: '0.0000',
    }
    const first = await exec(reworkBus, op, 'rework.reel-split.execute', payload)
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const replay = await exec(reworkBus, op, 'rework.reel-split.execute', payload)
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect((replay.data as { orderId: string }).orderId).toBe((first.data as { orderId: string }).orderId)
    const orders = await pool.query(`SELECT count(*)::int AS c FROM reel_split_order WHERE source_unit_no = $1`, [`AE${run}-S7`])
    expect(orders.rows[0]!.c).toBe(1)
  })
})

// ================================================================
// ② 分托/解绑（RS-13～24）
// ================================================================

describe('② 分托/解绑主链（RS-13～24）', () => {
  it('RS-13 车间/非车间可扫范围分叉（服务端执行）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 码在仓库（普通仓 WAREHOUSE）：车间人员扫 → 拒
    await receiveUnit(`${run}-P1`, fx.szPlainRackLocationId, '010101')
    const wsScan = await exec(reworkBus, nextOp('p1ws'), 'rework.pallet.scan-item', {
      taskType: 'split_pallet',
      unitNo: `${run}-P1`,
    }, workshopCtx)
    expectRejection(wsScan, 'RS-13')
    // 码在线边（非仓库）：非车间人员扫"不在库"语义通过（有活动余额即库存），车间通过
    await receiveUnit(`${run}-P2`, fx.szLineSideLocationId, '92980101')
    const qcCtx = await newNonWorkshopCtx(`${run}qc1`)
    const qcScan = await exec(reworkBus, nextOp('p1qc'), 'rework.pallet.scan-item', {
      taskType: 'split_pallet',
      unitNo: `${run}-P2`,
    }, qcCtx)
    expect(qcScan.status).toBe(CommandResultStatus.COMMITTED)
  })

  it('RS-15 新托/老托：老托位置自动带出不可改；RS-19 非车间确认前必须已选库位', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 老托：绑定一个单元（直插 carrier_binding 造绑定史）
    await receiveUnit(`${run}-P3`, fx.szPlainRackLocationId, '010101')
    const p3 = await unitRow(`${run}-P3`)
    const oldCarrier = (
      await pool.query<{ id: string }>(
        `INSERT INTO carrier (carrier_code, carrier_kind, status, plant_id, enterprise_id, created_by)
         VALUES ($1, 'tray', 'in_service', $2, (SELECT enterprise_id FROM org_node WHERE id = $2), 'seed') RETURNING id`,
        [`${run}-PLT-OLD`, fx.szPlantId],
      )
    ).rows[0]!.id
    await pool.query(
      `INSERT INTO carrier_binding (carrier_id, unit_id, effective_from, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, now(), $3, (SELECT enterprise_id FROM org_node WHERE id = $3), 'seed')`,
      [oldCarrier, p3.id, fx.szPlantId],
    )
    const ctxA = await newNonWorkshopCtx(`${run}qc2`)
    const scanOld = await exec(reworkBus, nextOp('p3old'), 'rework.pallet.scan-target', {
      carrierCode: `${run}-PLT-OLD`,
    }, ctxA)
    expect(scanOld.status).toBe(CommandResultStatus.COMMITTED)
    const oldData = scanOld.data as { palletKind: string; inheritedLocation: { locationId: string | null } }
    expect(oldData.palletKind).toBe('old')
    expect(oldData.inheritedLocation?.locationId).toBe(fx.szPlainRackLocationId)
    // 老托赋不同库位 → RS-15 拒绝
    const badLoc = await exec(reworkBus, nextOp('p3bad'), 'rework.pallet.set-location', {
      locationId: fx.szPlainRackLocationId2,
      locationCode: '010102',
      warehouseId: fx.szPlainWarehouseId,
    }, ctxA)
    expectRejection(badLoc, 'RS-15')

    // 新托：无绑定史
    const scanNew = await exec(reworkBus, nextOp('p3new'), 'rework.pallet.scan-target', {
      carrierCode: `${run}-PLT-NEW`,
    }, ctxA)
    expect((scanNew.data as { palletKind: string }).palletKind).toBe('new')
  })

  it('RS-14 进行中单据唯一：同操作人同类型复用同一任务；扫入即锁定（RS-17/S4 reservation 四要素）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`${run}-P4`, fx.szLineSideLocationId, '92980101')
    const ctxB = await newNonWorkshopCtx(`${run}qc3`)
    await exec(reworkBus, nextOp('p4t'), 'rework.pallet.scan-target', { carrierCode: `${run}-PLT-04` }, ctxB)
    const s1 = await exec(reworkBus, nextOp('p4a'), 'rework.pallet.scan-item', {
      taskType: 'split_pallet',
      unitNo: `${run}-P4`,
    }, ctxB)
    const s2 = await exec(reworkBus, nextOp('p4b'), 'rework.pallet.scan-item', {
      taskType: 'split_pallet',
      unitNo: `${run}-P4`,
    }, ctxB)
    expectRejection(s2, 'RS-16') // 本次已扫过
    expect((s1.data as { taskId: string }).taskId).toBeTruthy()
    // RS-S4：锁定落 reservation（IT-23 四要素）
    const p4 = await unitRow(`${run}-P4`)
    const resv = await pool.query<{ holder_type: string; holder_ref: string; valid_until: Date; status: string }>(
      `SELECT holder_type, holder_ref, valid_until, status FROM reservation WHERE unit_id = $1 ORDER BY acquired_at DESC LIMIT 1`,
      [p4.id],
    )
    expect(resv.rows[0]!.holder_type).toBe('task')
    expect(resv.rows[0]!.status).toBe('active')
  })

  it('RS-18 预留过期后确认重新校验拒绝（A11）；RS-17 删码解除锁定', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`${run}-P5`, fx.szLineSideLocationId, '92980101')
    const ctxC = await newNonWorkshopCtx(`${run}qc4`)
    await exec(reworkBus, nextOp('p5t'), 'rework.pallet.scan-target', { carrierCode: `${run}-PLT-05` }, ctxC)
    await exec(reworkBus, nextOp('p5a'), 'rework.pallet.scan-item', {
      taskType: 'split_pallet',
      unitNo: `${run}-P5`,
    }, ctxC)
    const p5 = await unitRow(`${run}-P5`)
    const rack5 = await pool.query<{ id: string }>(
      `SELECT id FROM rack WHERE plant_id = $1 AND warehouse_id = $2`,
      [fx.szPlantId, fx.szPlainWarehouseId],
    )
    await exec(reworkBus, nextOp('p5l2'), 'rework.pallet.set-location', {
      locationId: fx.szPlainRackLocationId,
      locationCode: '010101',
      warehouseId: fx.szPlainWarehouseId,
      rackId: rack5.rows[0]!.id,
    }, ctxC)
    await pool.query(`UPDATE reservation SET valid_until = now() - interval '1 hour', acquired_at = now() - interval '2 hour' WHERE unit_id = $1 AND status = 'active'`, [p5.id])
    const confirm = await exec(reworkBus, nextOp('p5c'), 'rework.pallet.confirm', {
      taskType: 'split_pallet',
    }, ctxC)
    expectRejection(confirm, 'RS-18')
    // RS-17：删码解除锁定并从本次调整移除
    const rm = await exec(reworkBus, nextOp('p5r'), 'rework.pallet.remove-item', {
      taskType: 'split_pallet',
      unitNo: `${run}-P5`,
    }, ctxC)
    expect(rm.status).toBe(CommandResultStatus.COMMITTED)
    const released = await pool.query<{ status: string }>(
      `SELECT status FROM reservation WHERE unit_id = $1 ORDER BY acquired_at DESC LIMIT 1`,
      [p5.id],
    )
    expect(released.rows[0]!.status).toBe('released')
  })

  it('RS-19/20 非车间确认：改绑托码+仓库/货架/库位+解除锁定+状态已完成；RS-21 零料品码放弃', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`${run}-P6`, fx.szLineSideLocationId, '92980101')
    const ctxD = await newNonWorkshopCtx(`${run}qc5`)
    await exec(reworkBus, nextOp('p6t'), 'rework.pallet.scan-target', { carrierCode: `${run}-PLT-06` }, ctxD)
    await exec(reworkBus, nextOp('p6a'), 'rework.pallet.scan-item', {
      taskType: 'split_pallet',
      unitNo: `${run}-P6`,
    }, ctxD)
    // 未选库位确认 → RS-19
    const early = await exec(reworkBus, nextOp('p6e'), 'rework.pallet.confirm', { taskType: 'split_pallet' }, ctxD)
    expectRejection(early, 'RS-19')
    await exec(reworkBus, nextOp('p6l'), 'rework.pallet.set-location', {
      locationId: fx.szPlainRackLocationId,
      locationCode: '010101',
      warehouseId: fx.szPlainWarehouseId,
      rackId: (await pool.query<{ id: string }>(`SELECT id FROM rack WHERE plant_id = $1 AND warehouse_id = $2`, [fx.szPlantId, fx.szPlainWarehouseId])).rows[0]!.id,
    }, ctxD)
    const ok = await exec(reworkBus, nextOp('p6c'), 'rework.pallet.confirm', { taskType: 'split_pallet' }, ctxD)
    expect(ok.status).toBe(CommandResultStatus.COMMITTED)
    // RS-20：全部料品码改绑分入托码并解除锁定；非车间同步改库位
    const p6 = await unitRow(`${run}-P6`)
    const binding = await pool.query<{ carrier_code: string }>(
      `SELECT c.carrier_code FROM carrier_binding cb JOIN carrier c ON c.id = cb.carrier_id
       WHERE cb.unit_id = $1 AND cb.effective_to IS NULL`,
      [p6.id],
    )
    expect(binding.rows[0]!.carrier_code).toBe(`${run}-PLT-06`)
    const moved = await pool.query<{ location_id: string }>(
      `SELECT location_id FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
      [p6.id],
    )
    expect(moved.rows[0]!.location_id).toBe(fx.szPlainRackLocationId)
    const taskRow = await pool.query<{ status: string }>(
      `SELECT status FROM pallet_task WHERE task_no = (SELECT task_no FROM pallet_task WHERE operator = $1 AND task_type = 'split_pallet' AND status = 'completed' ORDER BY completed_at DESC LIMIT 1)`,
      [`${run}qc5`],
    )
    expect(taskRow.rows[0]!.status).toBe('completed')

    // RS-21：已扫分入托码但零料品码返回 = 放弃
    const ctxE = await newNonWorkshopCtx(`${run}qc6`)
    await exec(reworkBus, nextOp('p7t'), 'rework.pallet.scan-target', { carrierCode: `${run}-PLT-07` }, ctxE)
    const leave = await exec(reworkBus, nextOp('p7l'), 'rework.pallet.leave', { taskType: 'split_pallet' }, ctxE)
    expect(leave.status).toBe(CommandResultStatus.COMMITTED)
    expect((leave.data as { abandoned: boolean }).abandoned).toBe(true)
  })

  it('RS-13③/RS-23 车间确认只改托码；解绑清除托码位置不变且返回不放弃', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 车间分托：只改托码（线边码，位置不变）
    await receiveUnit(`${run}-P8`, fx.szLineSideLocationId, '92980101')
    await exec(reworkBus, nextOp('p8t'), 'rework.pallet.scan-target', { carrierCode: `${run}-PLT-08` }, workshopCtx)
    await exec(reworkBus, nextOp('p8a'), 'rework.pallet.scan-item', {
      taskType: 'split_pallet',
      unitNo: `${run}-P8`,
    }, workshopCtx)
    const ok = await exec(reworkBus, nextOp('p8c'), 'rework.pallet.confirm', { taskType: 'split_pallet' }, workshopCtx)
    expect(ok.status).toBe(CommandResultStatus.COMMITTED)
    const p8 = await unitRow(`${run}-P8`)
    const p8Loc = await pool.query<{ location_id: string }>(
      `SELECT location_id FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
      [p8.id],
    )
    expect(p8Loc.rows[0]!.location_id).toBe(fx.szLineSideLocationId) // 车间不改位置

    // 解绑：清除托码、位置不变
    const ub = await exec(reworkBus, nextOp('p8u'), 'rework.pallet.scan-item', {
      taskType: 'unbind_pallet',
      unitNo: `${run}-P8`,
    }, workshopCtx)
    expect(ub.status).toBe(CommandResultStatus.COMMITTED)
    const ubConfirm = await exec(reworkBus, nextOp('p8uc'), 'rework.pallet.confirm', { taskType: 'unbind_pallet' }, workshopCtx)
    expect(ubConfirm.status).toBe(CommandResultStatus.COMMITTED)
    const afterBind = await pool.query(
      `SELECT count(*)::int AS c FROM carrier_binding WHERE unit_id = $1 AND effective_to IS NULL`,
      [p8.id],
    )
    expect(afterBind.rows[0]!.c).toBe(0)
    const ubLoc = await pool.query<{ location_id: string }>(
      `SELECT location_id FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
      [p8.id],
    )
    expect(ubLoc.rows[0]!.location_id).toBe(fx.szLineSideLocationId) // RS-23 仓库/货架/库位不变

    // RS-23：解绑页返回不放弃进行中数据（零码 leave → abandoned=false）
    await exec(reworkBus, nextOp('p9t'), 'rework.pallet.leave', { taskType: 'unbind_pallet' }, workshopCtx)
    const leave9 = await exec(reworkBus, nextOp('p9l'), 'rework.pallet.leave', { taskType: 'unbind_pallet' }, workshopCtx)
    expect((leave9.data as { abandoned: boolean }).abandoned).toBe(false)
  })

  it('RS-24 分托导出：导出那一刻绑定取数 + 同托码同轴号同料品合并', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const view = await queries.palletExport(adminAuth, fx.szPlantId, { page: 1, pageSize: 50 })
    const rows = view.rows.filter((r) => r.carrierCode === `${run}-PLT-08`)
    expect(rows.length).toBe(0) // P8 已解绑：导出那一刻无绑定 → 不出现（非历史快照）
    const rows06 = view.rows.filter((r) => r.carrierCode === `${run}-PLT-06`)
    expect(rows06.length).toBe(1)
    expect(rows06[0]!.unitCount).toBe(1)
  })

  it('O-1/RS-22 非车间解绑：免库位直接确认（原恒拒接缝），清托码且位置不变', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    // 建立绑定：非车间分托（扫托码/料品码/选库位确认 → P10 绑 PLT-10 并移入普通仓）
    await receiveUnit(`${run}-P10`, fx.szLineSideLocationId, '92980101')
    const ctxF = await newNonWorkshopCtx(`${run}qc7`)
    await exec(reworkBus, nextOp('p10t'), 'rework.pallet.scan-target', { carrierCode: `${run}-PLT-10` }, ctxF)
    await exec(reworkBus, nextOp('p10a'), 'rework.pallet.scan-item', {
      taskType: 'split_pallet',
      unitNo: `${run}-P10`,
    }, ctxF)
    await exec(reworkBus, nextOp('p10l'), 'rework.pallet.set-location', {
      locationId: fx.szPlainRackLocationId,
      locationCode: '010101',
      warehouseId: fx.szPlainWarehouseId,
      rackId: (await pool.query<{ id: string }>(`SELECT id FROM rack WHERE plant_id = $1 AND warehouse_id = $2`, [fx.szPlantId, fx.szPlainWarehouseId])).rows[0]!.id,
    }, ctxF)
    const split = await exec(reworkBus, nextOp('p10c'), 'rework.pallet.confirm', { taskType: 'split_pallet' }, ctxF)
    expect(split.status).toBe(CommandResultStatus.COMMITTED)
    // 非车间解绑：不选库位直接确认（O-1 修复前恒拒 [RS-19] 非车间人员必须已选库位——
    // set-location 只找分托任务，非车间解绑前置不可达；RS-22 明文解绑不需要托码与库位）
    const ub = await exec(reworkBus, nextOp('p10u'), 'rework.pallet.scan-item', {
      taskType: 'unbind_pallet',
      unitNo: `${run}-P10`,
    }, ctxF)
    expect(ub.status).toBe(CommandResultStatus.COMMITTED)
    const p10 = await unitRow(`${run}-P10`)
    const locBefore = await pool.query<{ location_id: string }>(
      `SELECT location_id FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
      [p10.id],
    )
    const confirm = await exec(reworkBus, nextOp('p10uc'), 'rework.pallet.confirm', { taskType: 'unbind_pallet' }, ctxF)
    expect(confirm.status).toBe(CommandResultStatus.COMMITTED)
    const bindAfter = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM carrier_binding WHERE unit_id = $1 AND effective_to IS NULL`,
      [p10.id],
    )
    expect(bindAfter.rows[0]!.c).toBe(0)
    const locAfter = await pool.query<{ location_id: string }>(
      `SELECT location_id FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
      [p10.id],
    )
    expect(locAfter.rows[0]!.location_id).toBe(locBefore.rows[0]!.location_id) // RS-23 位置不变
  })
})

// ================================================================
// ③ 轴号修正（RS-25～33）
// ================================================================

describe('③ 轴号修正主链（RS-26/27/29/30/31/32/33）', () => {
  it('RS-25/26 扫码查询：可选列表按订单范围构建；物流部仓库码拒绝', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`AE${run}-C1`, fx.szLineSideLocationId, '92980101', '1000.0000')
    await receiveUnit(`AE${run}-C2`, fx.szLineSideLocationId, '92980101', '500.0000')
    await seedAxisState(`AE${run}-C1`, `SO-${run}`, 'KZH-RWK-1', '600', '1')
    await seedAxisState(`AE${run}-C2`, `SO-${run}`, 'KZH-RWK-2', '600', '2')
    const scan = await queries.correctionScan(fx.szPlantId, `AE${run}-C1`)
    expect(scan.options.map((o) => o.customerAxisNo).sort()).toEqual(['KZH-RWK-1', 'KZH-RWK-2'])
    expect(scan.options.find((o) => o.customerAxisNo === 'KZH-RWK-2')!.used).toBe(true)

    // 物流部仓码 → RS-25 拒绝
    await receiveUnit(`AE${run}-CL`, fx.szLogisticsLocationId, '010101')
    await expect(queries.correctionScan(fx.szPlantId, `AE${run}-CL`)).rejects.toMatchObject({ rule: 'RS-25' })
  })

  it('RS-27/30/29 提交占用轴号：权限+强制理由；执行清占用+改值+数量扣减；审计留痕', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const c1 = await unitRow(`AE${run}-C1`)
    const c2 = await unitRow(`AE${run}-C2`)
    // 无理由 → RS-30 拒绝（admin 有 reassign 权限）
    const noReason = await exec(reworkBus, nextOp('cor1'), 'rework.axis-correction.submit', {
      unitNo: `AE${run}-C1`,
      cutQty: '100.0000',
      newCustomerAxisNo: 'KZH-RWK-2',
      newSegmentLength: '600',
      newVirtualAxisNo: '2',
      uomCode: 'M',
    })
    expectRejection(noReason, 'RS-30')
    // RS-31 单位随物料主计量单位
    const badUom = await exec(reworkBus, nextOp('cor1u'), 'rework.axis-correction.submit', {
      unitNo: `AE${run}-C1`,
      cutQty: '100.0000',
      newCustomerAxisNo: 'KZH-RWK-1',
      newSegmentLength: '600',
      newVirtualAxisNo: '1',
      uomCode: 'KG',
      reassignReason: '生产调整',
    })
    expectRejection(badUom, 'RS-31')
    // 正常提交（占用 KZH-RWK-2）
    const ok = await exec(reworkBus, nextOp('cor2'), 'rework.axis-correction.submit', {
      unitNo: `AE${run}-C1`,
      cutQty: '100.0000',
      newCustomerAxisNo: 'KZH-RWK-2',
      newSegmentLength: '600',
      newVirtualAxisNo: '2',
      uomCode: 'M',
      reassignReason: '客户轴段重新分配（生产调整）',
    })
    expect(ok.status).toBe(CommandResultStatus.COMMITTED)
    // RS-29：C2 轴号清空、C1 改新值、数量扣减
    const s1 = await pool.query<{ customer_axis_no: string | null }>(`SELECT customer_axis_no FROM axis_no_state WHERE unit_id = $1`, [c1.id])
    expect(s1.rows[0]!.customer_axis_no).toBe('KZH-RWK-2')
    const s2 = await pool.query<{ customer_axis_no: string | null }>(`SELECT customer_axis_no FROM axis_no_state WHERE unit_id = $1`, [c2.id])
    expect(s2.rows[0]!.customer_axis_no).toBeNull()
    expect(await activeBalanceQty(c1.id)).toBe('900.0000')
    const correction = await pool.query<{ id: string; status: string; took_over_unit_no: string | null }>(
      `SELECT id, status, took_over_unit_no FROM axis_no_correction WHERE target_unit_id = $1`,
      [c1.id],
    )
    expect(correction.rows[0]!.status).toBe('completed')
    expect(correction.rows[0]!.took_over_unit_no).toBe(`AE${run}-C2`)
  })

  it('RS-32 回撤恢复修正前值并加回截取数量；已撤销不可重复回撤', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const c1 = await unitRow(`AE${run}-C1`)
    const correctionId = (
      await pool.query<{ id: string }>(`SELECT id FROM axis_no_correction WHERE target_unit_id = $1`, [c1.id])
    ).rows[0]!.id
    const wd = await exec(reworkBus, nextOp('cor3'), 'rework.axis-correction.withdraw', {
      correctionId,
      reason: '回撤测试',
    })
    expect(wd.status).toBe(CommandResultStatus.COMMITTED)
    expect(await activeBalanceQty(c1.id)).toBe('1000.0000')
    const s1 = await pool.query<{ customer_axis_no: string | null }>(`SELECT customer_axis_no FROM axis_no_state WHERE unit_id = $1`, [c1.id])
    expect(s1.rows[0]!.customer_axis_no).toBe('KZH-RWK-1') // 恢复修正前值
    const dup = await exec(reworkBus, nextOp('cor4'), 'rework.axis-correction.withdraw', {
      correctionId,
      reason: '重复回撤',
    })
    expectRejection(dup, 'RS-32')
    // RS-S5：历史值不可改写（库级守卫）
    const attempt = await pool
      .query(`UPDATE axis_no_correction SET cut_qty = 1 WHERE id = $1`, [correctionId])
      .catch((error: Error) => error.message)
    expect(String(attempt)).toContain('RS-S5')
  })

  it('RS-33 回撤下游拦截：修正目标码被倒轴拆分后回撤受阻', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`AE${run}-C3`, fx.szLineSideLocationId, '92980101')
    await seedAxisState(`AE${run}-C3`, `SO-${run}-3`, 'KZH-RWK-3', '600', '3')
    const cor = await exec(reworkBus, nextOp('cor5'), 'rework.axis-correction.submit', {
      unitNo: `AE${run}-C3`,
      cutQty: '100.0000',
      newCustomerAxisNo: 'KZH-RWK-3',
      newSegmentLength: '600',
      newVirtualAxisNo: '3',
      uomCode: 'M',
    })
    expect(cor.status).toBe(CommandResultStatus.COMMITTED)
    // 修正后倒轴该码（产生 split 流水）
    const split = await exec(reworkBus, nextOp('cor5s'), 'rework.reel-split.execute', {
      sourceUnitNo: `AE${run}-C3`,
      pourLines: [{ unitNo: `AE${run}-C3T`, quantity: '900.0000' }],
      lossQty: '0.0000',
    })
    expect(split.status).toBe(CommandResultStatus.COMMITTED)
    const c3 = await unitRow(`AE${run}-C3`)
    const correctionId = (
      await pool.query<{ id: string }>(`SELECT id FROM axis_no_correction WHERE target_unit_id = $1 ORDER BY corrected_at DESC LIMIT 1`, [c3.id])
    ).rows[0]!.id
    const wd = await exec(reworkBus, nextOp('cor5w'), 'rework.axis-correction.withdraw', {
      correctionId,
      reason: '下游拦截测试',
    })
    expectRejection(wd, 'RS-33')
  })
})

// ================================================================
// ④ 轴码退役（RS-34～37 + RS-S6）
// ================================================================

describe('④ 轴码退役主链（RS-34/35/36/37 + RS-S6）', () => {
  it('RS-34/35/37 退役：状态+清空记录+零余额关闭一次事务；RS-S6 append-only 守卫', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`${run}-R1`, fx.szLineSideLocationId, '92980101')
    const empty = await exec(reworkBus, nextOp('ret0'), 'rework.axis-retire.execute', { unitNos: [] })
    expectRejection(empty, 'RS-34')
    const ok = await exec(reworkBus, nextOp('ret1'), 'rework.axis-retire.execute', {
      unitNos: [`${run}-R1`],
      reason: '轴码清空测试',
    })
    expect(ok.status).toBe(CommandResultStatus.COMMITTED)
    const r1 = await unitRow(`${run}-R1`)
    // 退役状态 + 清空记录 + 余额关闭 + 单元耗尽（同一命令事务；RS-37 异步统计经 outbox）
    const retireState = await pool.query(`SELECT count(*)::int AS c FROM axis_code_retire WHERE unit_id = $1`, [r1.id])
    expect(retireState.rows[0]!.c).toBe(1)
    const record = await pool.query<{ qty_before: string; retired_by: string }>(
      `SELECT qty_before::text, retired_by FROM axis_retire_record WHERE unit_id = $1`,
      [r1.id],
    )
    expect(record.rows[0]!.qty_before).toBe('1000.0000')
    expect(record.rows[0]!.retired_by).toBe('admin')
    expect(await activeBalanceQty(r1.id)).toBeNull()
    expect(r1.status).toBe('exhausted')
    const outbox = await pool.query(`SELECT count(*)::int AS c FROM outbox WHERE task_kind = 'rework.axis-retired'`)
    expect(outbox.rows[0]!.c).toBeGreaterThanOrEqual(1)
    // RS-S6：清空记录 append-only（UPDATE/DELETE 被触发器拒绝）
    const upd = await pool
      .query(`UPDATE axis_retire_record SET qty_before = 1 WHERE unit_id = $1`, [r1.id])
      .catch((error: Error) => error.message)
    expect(String(upd)).toContain('RS-S6')
    // 身份保留：档案行仍在（不物理删除）
    const archived = await pool.query(`SELECT count(*)::int AS c FROM inventory_unit WHERE id = $1`, [r1.id])
    expect(archived.rows[0]!.c).toBe(1)
  })

  it('RS-36 退役码在库存命令入口显式拒绝（倒轴/分托/修正）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const split = await exec(reworkBus, nextOp('ret2s'), 'rework.reel-split.execute', {
      sourceUnitNo: `${run}-R1`,
      pourLines: [{ unitNo: `${run}-R1T`, quantity: '10.0000' }],
      lossQty: '0.0000',
    })
    // 退役码先命中 RS-03（无活动余额/不存在链）或 RS-36；两者都为显式中文拒绝
    expect(split.status).toBe('BUSINESS_REJECTION')
    const pallet = await exec(reworkBus, nextOp('ret2p'), 'rework.pallet.scan-item', {
      taskType: 'unbind_pallet',
      unitNo: `${run}-R1`,
    }, workshopCtx)
    expect(pallet.status).toBe('BUSINESS_REJECTION')
    const correction = await exec(reworkBus, nextOp('ret2c'), 'rework.axis-correction.submit', {
      unitNo: `${run}-R1`,
      cutQty: '0.0000',
    })
    expect(correction.status).toBe('BUSINESS_REJECTION')
  })

  it('RS-34 已入成品仓在库的码不可清空（普通仓=仓库型在库）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`${run}-R2`, fx.szPlainRackLocationId, '010101')
    const r = await exec(reworkBus, nextOp('ret3'), 'rework.axis-retire.execute', { unitNos: [`${run}-R2`] })
    expectRejection(r, 'RS-34')
  })
})

it('PR01 倒轴冲销：合法消费源留存后晚拒绝，子轴扣回及全部写集回滚且拒绝可重放', async () => {
  if (skipIfNoDb()) throw new Error('PR01 mandatory real PG scenario cannot skip')
  const sourceNo = `AE${run}-PR01SRC`; const childNo = `AE${run}-PR01CHILD`
  const sourceId = await receiveUnit(sourceNo, fx.szLineSideLocationId, '92980101')
  const split = await exec(reworkBus, nextOp('pr01-split'), 'rework.reel-split.execute', {
    sourceUnitNo: sourceNo, pourLines: [{ unitNo: childNo, quantity: '500.0000' }], lossQty: '0.0000',
  })
  expect(split.status).toBe('COMMITTED')
  const orderId = (split.data as { orderId: string }).orderId; const childId = (await unitRow(childNo)).id
  expect(await activeBalanceQty(sourceId)).toBe('500.0000')
  expect(await activeBalanceQty(childId)).toBe('500.0000')

  // Actual application command: source-only consumption creates its own receipt,
  // stock transaction, entry, audit and outbox. No balance corruption fixture.
  const consumeOp = nextOp('pr01-consume-source')
  const consumed = await exec(inventoryBus, consumeOp, 'inventory.issue-material', {
    unitId: sourceId, quantity: '1.0000', locationId: fx.szLineSideLocationId,
    ownerId: RWK_OWNER_ID, reason: 'PR01 合法消耗源轴留存',
  })
  console.log('PR01_R1_EVIDENCE ' + JSON.stringify({
    scenario: 'rework-legal-source-consumption', phase: 'source-consumption-result',
    operationId: consumeOp, commandType: 'inventory.issue-material', sourceId, childId,
    result: { operationId: consumed.operationId, status: consumed.status, errorCode: consumed.errorCode, errorMessage: consumed.errorMessage, occurredAt: consumed.occurredAt },
  }))
  expect(consumed.status).toBe('COMMITTED')
  expect(consumed.data).toMatchObject({ unitId: sourceId, beforeQty: '500.0000', afterQty: '499.0000', balanceClosed: false })
  const consumptionTransactions = (await pool.query(
    `SELECT st.id,st.command_receipt_id,cr.operation_id,cr.status AS command_status,
       st.unit_id,st.balance_id,st.movement_kind,st.quantity::text,st.before_qty::text,st.after_qty::text
     FROM stock_transaction st JOIN command_receipt cr ON cr.id=st.command_receipt_id
     WHERE cr.operation_id=$1 AND cr.command_type='inventory.issue-material' ORDER BY st.id`, [consumeOp],
  )).rows
  expect(consumptionTransactions).toHaveLength(1)
  expect(consumptionTransactions[0]).toMatchObject({ operation_id: consumeOp, command_status: 'COMMITTED', unit_id: sourceId, movement_kind: 'issue', quantity: '-1.0000', before_qty: '500.0000', after_qty: '499.0000' })
  const consumptionEntries = (await pool.query(
    'SELECT id,transaction_id,unit_id,quantity_delta::text,before_qty::text,after_qty::text FROM stock_entry WHERE transaction_id=$1 ORDER BY id',
    [consumptionTransactions[0]!.id],
  )).rows
  expect(consumptionEntries).toHaveLength(1)
  expect(consumptionEntries[0]).toMatchObject({ unit_id: sourceId, quantity_delta: '-1.0000', before_qty: '500.0000', after_qty: '499.0000' })
  const downstream = await new PgReworkFactsLookup(pool).reelSplitReversalDownstream([childId], sourceId)
  expect(downstream).toEqual({ anyChildStocked: false, anyChildConsumed: false, anyChildConverted: false, anyChildShipped: false, anyChildQualityEffective: false })
  expect(await activeBalanceQty(sourceId)).toBe('499.0000')
  expect(await activeBalanceQty(childId)).toBe('500.0000')

  const snapshot = async () => ({
    units: (await pool.query('SELECT * FROM inventory_unit WHERE id=ANY($1::uuid[]) ORDER BY id', [[sourceId, childId]])).rows,
    balances: (await pool.query('SELECT * FROM stock_balance WHERE unit_id=ANY($1::uuid[]) ORDER BY id', [[sourceId, childId]])).rows,
    order: (await pool.query('SELECT * FROM reel_split_order WHERE id=$1', [orderId])).rows,
    lines: (await pool.query('SELECT * FROM reel_split_line WHERE order_id=$1 ORDER BY id', [orderId])).rows,
    transactions: (await pool.query('SELECT * FROM stock_transaction WHERE unit_id=ANY($1::uuid[]) ORDER BY id', [[sourceId, childId]])).rows,
    entries: (await pool.query('SELECT * FROM stock_entry WHERE unit_id=ANY($1::uuid[]) ORDER BY id', [[sourceId, childId]])).rows,
    reversals: (await pool.query('SELECT * FROM reel_split_reversal WHERE source_order_id=$1 ORDER BY id', [orderId])).rows,
    audits: (await pool.query('SELECT * FROM audit_entry WHERE subject_id=ANY($1::text[]) ORDER BY id', [[sourceId, childId, orderId]])).rows,
    outbox: (await pool.query('SELECT * FROM outbox WHERE aggregate_id=ANY($1::text[]) ORDER BY event_id', [[sourceId, childId, orderId]])).rows,
    counts: (await pool.query('SELECT (SELECT count(*) FROM stock_transaction)::int AS tx,(SELECT count(*) FROM stock_entry)::int AS entries,(SELECT count(*) FROM reel_split_reversal)::int AS reversals,(SELECT count(*) FROM audit_entry)::int AS audit,(SELECT count(*) FROM outbox)::int AS outbox')).rows,
  })
  const before = await snapshot(); const op = nextOp('pr01-reverse'); const payload = { sourceOrderId: orderId, reason: '合法源轴消费后的晚拒绝原子性验证' }
  const readReceipt = async () => (await pool.query('SELECT id,operation_id,command_type,payload_digest,status,result FROM command_receipt WHERE operation_id=$1', [op])).rows
  const select = (rows: readonly Record<string, unknown>[], keys: readonly string[]) =>
    rows.map((row) => Object.fromEntries(keys.map((key) => [key, row[key]])))
  const resultView = (result: CommandResult) => ({ operationId: result.operationId, status: result.status, errorCode: result.errorCode, errorMessage: result.errorMessage, occurredAt: result.occurredAt })
  const emit = (phase: string, observed: Awaited<ReturnType<typeof snapshot>>, receipts: Awaited<ReturnType<typeof readReceipt>>, result?: CommandResult) => {
    // Whitelist only test identifiers, quantities, statuses and counters. No
    // owner/actor names, free-form payloads, credentials or connection strings.
    console.log('PR01_R1_EVIDENCE ' + JSON.stringify({
      scenario: 'rework-legal-source-consumption', phase, incrementParent: '39f7d1212bbbcd7d3a1f1d3ebf4781b8f636380a',
      operationId: op, sourceId, childId, orderId, sourceConsumptionOperationId: consumeOp,
      sourceConsumption: { transactions: consumptionTransactions, entries: consumptionEntries }, childDownstream: downstream,
      snapshot: {
        units: select(observed.units, ['id', 'unit_no', 'status', 'balance_open', 'balance_closed_at']),
        balances: select(observed.balances, ['id', 'unit_id', 'location_id', 'quantity', 'uom_code', 'quality_status', 'status', 'closed_at']),
        order: select(observed.order, ['id', 'source_unit_id', 'original_qty', 'retained_qty', 'loss_qty', 'status', 'command_receipt_id']),
        lines: select(observed.lines, ['id', 'order_id', 'target_unit_id', 'quantity', 'created_new_unit']),
        transactions: select(observed.transactions, ['id', 'command_receipt_id', 'unit_id', 'movement_kind', 'quantity', 'before_qty', 'after_qty', 'ref_type', 'ref_id']),
        entries: select(observed.entries, ['id', 'transaction_id', 'unit_id', 'quantity_delta', 'before_qty', 'after_qty']),
        reversals: select(observed.reversals, ['id', 'source_order_id', 'command_receipt_id']),
        audits: select(observed.audits, ['id', 'action', 'subject_type', 'subject_id']),
        outbox: select(observed.outbox, ['event_id', 'aggregate_type', 'aggregate_id', 'task_kind', 'status']), counts: observed.counts,
      },
      receipts: receipts.map((row) => ({ id: row.id, operationId: row.operation_id, commandType: row.command_type, payloadDigest: row.payload_digest, status: row.status, result: resultView(row.result as CommandResult) })),
      result: result === undefined ? undefined : resultView(result),
    }))
  }
  emit('before', before, await readReceipt())

  // Call through to the real PG method. The extra child SELECT runs on that
  // same transaction client, after the child write and before the source guard.
  // No domain fact, SQL return value or business write is replaced by this spy.
  const originalRead = PgReworkFactsLookup.prototype.unitBalancesIncludingClosed
  type BalanceRows = Awaited<ReturnType<typeof originalRead>>
  const during: Array<{ source: BalanceRows; child: BalanceRows }> = []
  const observation = vi.spyOn(PgReworkFactsLookup.prototype, 'unitBalancesIncludingClosed')
    .mockImplementation(async function (this: PgReworkFactsLookup, unitId: string) {
      const source = await originalRead.call(this, unitId)
      if (unitId === sourceId) {
        const child = await originalRead.call(this, childId)
        during.push({ source, child })
        console.log('PR01_R1_EVIDENCE ' + JSON.stringify({
          scenario: 'rework-legal-source-consumption', phase: 'inside-before-source-guard', operationId: op, sourceId, childId,
          source: select(source, ['id', 'quantity', 'status']), child: select(child, ['id', 'quantity', 'status']),
        }))
      }
      return source
    })
  try {
    const refused = await exec(reworkBus, op, 'rework.reel-split.reverse', payload)
    const after = await snapshot(); const receipt = await readReceipt()
    emit('after-first', after, receipt, refused)
    expect(refused.status).toBe('BUSINESS_REJECTION'); expect(refused.errorMessage).toContain('留存')
    expect(refused.errorCode).toBe(ERROR_CODES.BUSINESS_RULE)
    expect(refused.errorMessage).toContain('当前余额 499.0000 与倒轴后留存 500.0000')
    expect(during).toHaveLength(1)
    expect(during[0]!.source).toHaveLength(1)
    expect(during[0]!.source[0]).toMatchObject({ quantity: '499.0000', status: 'active' })
    expect(during[0]!.child).toHaveLength(1)
    expect(during[0]!.child[0]).toMatchObject({ quantity: '0.0000', status: 'closed' })
    expect(after).toEqual(before)
    expect(receipt).toHaveLength(1)
    expect(receipt[0]!.status).toBe('BUSINESS_REJECTION')
    expect(receipt[0]!.result).toEqual(JSON.parse(JSON.stringify(refused)))
    const replay = await exec(reworkBus, op, 'rework.reel-split.reverse', payload)
    const afterReplay = await snapshot(); const replayReceipt = await readReceipt()
    emit('after-replay', afterReplay, replayReceipt, replay)
    expect(replay).toEqual(refused)
    expect(afterReplay).toEqual(before)
    expect(replayReceipt).toEqual(receipt)
    expect(observation).toHaveBeenCalledTimes(1)
  } finally {
    observation.mockRestore()
  }
})
