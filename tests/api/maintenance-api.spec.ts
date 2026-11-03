import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { validateEnv } from '../../apps/api/src/env'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { DbModule } from '../../apps/api/src/db/db.module'
import { MaintenanceModule } from '../../apps/api/src/maintenance/maintenance.module'
import {
  MNT_SPARE_INITIAL_QTY,
  MNT_TEST_DB_NAME,
  mntDatabaseUrl,
  prepareMntTestDatabase,
  seedMntFixtures,
  type MntFixtures,
} from './maintenance-test-env'

/**
 * maintenance API 集成（P2-E / T19：独立库 cadenza_maintenance + supertest 自组装挂载
 * ConfigModule/DbModule/AuthModule（全局守卫）/MaintenanceModule——不改共享 app.module.ts，
 * L0 整合步统一注册）。
 *
 * 端点级证据（合同 frozen/p2/maintenance.md 逐条）：
 * - A10 主链：报修→分派→处理→待复机→备件复机→能力恢复（MT-07/08/09/10/11/13/15）
 *   ——停机起止/原因、备件消耗与库存对账（扣前/扣后余额）、状态流水来源（WEB/PDA）、
 *   复机后排程可见能力恢复（capacity-events 读回）；
 * - 异常上报（MT-03/04：扫码前缀宽容、未扫到设备/未选状态拒绝、同状态成功不记变更）；
 * - 状态机封闭（MT-07）、复机前置（MT-10）、取消语义（MT-14：停机事实保留）；
 * - 停机区间不重叠（MT-09）、备件可用量不足回滚（MT-11：工单状态不变）；
 * - 开工（MT-05/06：状态=正常才可开工、(设备,业务日) 幂等更新不新建）；
 * - 点检/保养（MT-12：版本化、双存、超期提示不阻断、fail 异常记录＋建议报修不自动建单）；
 * - 鉴权与范围（OA-23/24/25）、命令幂等（同 operationId 回放）。
 */

let app: INestApplication
let pool: pg.Pool
let fx: MntFixtures
let adminToken = ''
let qcToken = ''
let hfToken = ''
let dbAvailable = true
const run = `mnt${Date.now().toString(36)}`

beforeAll(async () => {
  try {
    pool = await prepareMntTestDatabase()
    fx = await seedMntFixtures(pool)
  } catch (error) {
    dbAvailable = false
    console.warn(
      `SKIP maintenance api: 测试库准备失败（${error instanceof Error ? error.message : String(error)}）。独立库 ${MNT_TEST_DB_NAME}。`,
    )
    return
  }
  process.env['DATABASE_URL'] = mntDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, AuthModule, MaintenanceModule],
  }).compile()
  app = moduleRef.createNestApplication()
  await app.init()
  adminToken = await login('admin', 'CadAdmin001')
  qcToken = await login('szqc01', 'SzQuality01')
  hfToken = await login('hfadmin01', 'HfPlant0001')
})

afterAll(async () => {
  if (app) await app.close()
  if (pool) await pool.end()
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

async function login(loginName: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer()).post('/auth/login').send({ loginName, password, platform: 'WEB' })
  expect(res.status).toBe(200)
  return res.body.token as string
}

interface CommandReply {
  operationId: string
  status: string
  errorCode?: string
  errorMessage?: string
  data?: Record<string, unknown>
}

/**
 * 命令 POST（O-2 修复后与其余域同款映射）：
 * - 成功（COMMITTED）→ HTTP 200，body 形状 { operationId, status, data }；
 * - 业务拒绝/范围/未找到 → HTTP 403/404/409/422，body 形状 { code, message, details: { operationId } }
 *   （helper 归一化为 CommandReply 便于既有断言；线上的 4xx 形状由映射专项用例直证）。
 */
async function postCommand(
  path: string,
  body: Record<string, unknown>,
  operationId: string,
  token = adminToken,
): Promise<CommandReply> {
  const res = await request(app.getHttpServer())
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .set('x-operation-id', operationId)
    .send(body)
  if (res.status === 200) {
    expect(res.body).toMatchObject({ operationId, status: 'COMMITTED' })
    return res.body as CommandReply
  }
  expect([403, 404, 409, 422]).toContain(res.status)
  expect(res.body.details).toMatchObject({ operationId })
  return {
    operationId,
    status: 'BUSINESS_REJECTION',
    errorCode: res.body.code,
    errorMessage: res.body.message,
  }
}

async function getJson(path: string, token = adminToken): Promise<Record<string, unknown>> {
  const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`)
  expect(res.status).toBe(200)
  return res.body as Record<string, unknown>
}

// ---------------- 鉴权与数据范围（OA-23/24/25） ----------------

describe('鉴权与数据范围', () => {
  it('未鉴权 401', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer()).get('/maintenance/orders')
    expect(res.status).toBe(401)
  })

  it('qc 只读许可：查询 200、命令 403（OA-23）', async () => {
    if (skipIfNoDb()) return
    const list = await request(app.getHttpServer()).get('/maintenance/orders').set('Authorization', `Bearer ${qcToken}`)
    expect(list.status).toBe(200)
    const post = await request(app.getHttpServer())
      .post('/maintenance/orders')
      .set('Authorization', `Bearer ${qcToken}`)
      .set('x-operation-id', `${run}-qc-no-post`)
      .send({ equipmentCode: fx.eq1Code, reason: '越权' })
    expect(post.status).toBe(403)
  })

  it('HF 厂管理员显式 SZ 工厂查询 403（OA-24/25）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get(`/maintenance/orders?plantId=${fx.szPlantId}`)
      .set('Authorization', `Bearer ${hfToken}`)
    expect(res.status).toBe(403)
  })

  it('命令二道防线 [A-S1]：HF 厂管理员对 SZ 设备建单拒绝', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/orders',
      { equipmentCode: fx.eq1Code, reason: '跨厂建单' },
      `${run}-hf-a-s1`,
      hfToken,
    )
    expect(reply.status).toBe('BUSINESS_REJECTION')
    expect(reply.errorCode).toBe('ERR_FORBIDDEN_SCOPE')
    expect(reply.errorMessage).toContain('[A-S1]')
  })
})

// ---------------- A10 主链：报修→分派→处理→待复机→备件复机→能力恢复 ----------------

describe('A10 主链（MT-07/08/09/10/11/13/15）', () => {
  let orderAId = ''
  const orderAOp = `${run}-a-create`

  it('Web 手工报修建单：状态 reported＋置设备维修＋开停机＋能力下降事件（MT-13/08/09/15）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/orders',
      { equipmentCode: fx.eq1Code, description: '绞制一号机换轴承', reason: '轴承磨损' },
      orderAOp,
    )
    expect(reply.status).toBe('COMMITTED')
    const data = reply.data as { orderId: string; orderNo: string; status: string }
    orderAId = data.orderId
    expect(data.status).toBe('reported')
    expect(data.orderNo).toMatch(/^MO-/)

    const detail = (await getJson(`/maintenance/orders/${orderAId}`)) as {
      order: { status: string; source: string }
      downtimeEvents: Array<{ endAt: string | null; reason: string }>
      equipmentStatusLogs: Array<{ oldStatus: number; newStatus: number; source: string }>
      capacityEvents: Array<{ payload: { changeKind: string; downtimeReason: string } }>
    }
    expect(detail.order.status).toBe('reported')
    // MT-08：受理报修建单置"维修"（状态是投影）＋MT-02 流水（来源 WEB）
    expect(detail.equipmentStatusLogs).toContainEqual(
      expect.objectContaining({ oldStatus: 1, newStatus: 2, source: 'WEB' }),
    )
    // MT-09：置"维修"即开停机事件（endAt 空=在停机中，起止原子记录）
    expect(detail.downtimeEvents).toHaveLength(1)
    expect(detail.downtimeEvents[0]!.endAt).toBeNull()
    expect(detail.downtimeEvents[0]!.reason).toBe('轴承磨损')
    // MT-15：停机发布能力下降事件（含原因）
    expect(detail.capacityEvents).toHaveLength(1)
    expect(detail.capacityEvents[0]!.payload.changeKind).toBe('down')
    expect(detail.capacityEvents[0]!.payload.downtimeReason).toBe('轴承磨损')
  })

  it('分派→处理中→待复机（MT-07/13：记录分派人与被派人）', async () => {
    if (skipIfNoDb()) return
    const dispatch = await postCommand(
      '/maintenance/orders/dispatch',
      { orderId: orderAId, assignee: '李四' },
      `${run}-a-dispatch`,
    )
    expect(dispatch.status).toBe('COMMITTED')
    expect((dispatch.data as { status: string }).status).toBe('dispatched')
    const start = await postCommand('/maintenance/orders/start', { orderId: orderAId }, `${run}-a-start`)
    expect((start.data as { status: string }).status).toBe('in_progress')
    const finish = await postCommand('/maintenance/orders/finish-repair', { orderId: orderAId }, `${run}-a-finish`)
    expect((finish.data as { status: string }).status).toBe('pending_restart')

    const detail = (await getJson(`/maintenance/orders/${orderAId}`)) as {
      order: { dispatcher: string | null; assignee: string | null }
    }
    expect(detail.order.dispatcher).toBe('admin')
    expect(detail.order.assignee).toBe('李四')
  })

  it('备件复机关闭：消耗同事务＋置正常＋闭停机＋能力恢复事件（MT-10/11/15）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/orders/restart',
      {
        orderId: orderAId,
        responsible: '张三',
        spareParts: [{ unitId: fx.spareUnitId, quantity: '30.5000' }],
      },
      `${run}-a-restart`,
    )
    expect(reply.status).toBe('COMMITTED')
    const data = reply.data as {
      status: string
      result: string
      responsible: string
      downtime: { endAt: string } | null
      spareUsage: Array<{ quantity: string; afterQuantity: string }>
      capacityEventId: string
    }
    expect(data.status).toBe('closed')
    expect(data.result).toBe('复机正常')
    expect(data.responsible).toBe('张三')
    expect(data.downtime?.endAt).toBeTruthy()
    expect(data.spareUsage).toHaveLength(1)
    expect(data.spareUsage[0]!.quantity).toBe('30.5000')
    expect(data.capacityEventId).toBeTruthy()
  })

  it('A10 对账读回：备件消耗与库存对账（扣前/扣后）、状态流水对齐、能力链可追溯', async () => {
    if (skipIfNoDb()) return
    const detail = (await getJson(`/maintenance/orders/${orderAId}`)) as {
      order: { status: string; result: string | null; responsible: string | null }
      downtimeEvents: Array<{ startAt: string; endAt: string | null }>
      spareUsages: Array<{
        quantity: string
        beforeQuantity: string
        afterQuantity: string
        stockTransactionId: string
        unitNo: string | null
      }>
      equipmentStatusLogs: Array<{ oldStatus: number; newStatus: number; source: string; createdAt: string }>
      capacityEvents: Array<{
        payload: { changeKind: string; downtimeStartAt: string; downtimeEndAt: string | null; downtimeReason: string }
      }>
    }
    expect(detail.order.status).toBe('closed')
    expect(detail.order.result).toBe('复机正常')
    expect(detail.order.responsible).toBe('张三')
    // 停机起止原子记录（MT-09）
    expect(detail.downtimeEvents[0]!.endAt).not.toBeNull()
    expect(detail.downtimeEvents[0]!.startAt <= detail.downtimeEvents[0]!.endAt!).toBe(true)
    // MT-11：消耗行关联库存流水＋扣前/扣后余额
    expect(detail.spareUsages).toHaveLength(1)
    expect(detail.spareUsages[0]!.unitNo).toBe(fx.spareUnitNo)
    expect(detail.spareUsages[0]!.beforeQuantity).toBe(MNT_SPARE_INITIAL_QTY)
    expect(detail.spareUsages[0]!.afterQuantity).toBe('69.5000')
    expect(detail.spareUsages[0]!.stockTransactionId).toBeTruthy()
    // MT-02/08：状态流水与工单事件可对齐（1→2 建单、2→1 复机，来源 WEB）
    expect(detail.equipmentStatusLogs).toContainEqual(expect.objectContaining({ oldStatus: 1, newStatus: 2, source: 'WEB' }))
    expect(detail.equipmentStatusLogs).toContainEqual(expect.objectContaining({ oldStatus: 2, newStatus: 1, source: 'WEB' }))
    // MT-10/15：能力事件链（down 含 null end；restored 含闭口起止与原因）
    const down = detail.capacityEvents.find((e) => e.payload.changeKind === 'down')
    const restored = detail.capacityEvents.find((e) => e.payload.changeKind === 'restored')
    expect(down?.payload.downtimeEndAt).toBeNull()
    expect(restored?.payload.downtimeEndAt).not.toBeNull()
    expect(restored?.payload.downtimeStartAt).toBe(detail.downtimeEvents[0]!.startAt)
    expect(restored?.payload.downtimeEndAt).toBe(detail.downtimeEvents[0]!.endAt)
    expect(restored?.payload.downtimeReason).toBe('轴承磨损')

    // 库存对账（DB 直查）：余额 69.5＋issue 流水扣前/扣后（IT-19 同口径）
    const balance = await pool.query(`SELECT quantity::text AS q FROM stock_balance WHERE unit_id = $1`, [fx.spareUnitId])
    expect(balance.rows[0]!.q).toBe('69.5000')
    const tx = await pool.query(
      `SELECT movement_kind, quantity::text AS q, before_qty::text AS before_qty, after_qty::text AS after_qty,
         reason, ref_type, ref_id::text AS ref_id, from_location_code, shift_date
       FROM stock_transaction WHERE unit_id = $1`,
      [fx.spareUnitId],
    )
    expect(tx.rows).toHaveLength(1)
    expect(tx.rows[0]).toMatchObject({
      movement_kind: 'issue',
      q: '-30.5000',
      before_qty: MNT_SPARE_INITIAL_QTY,
      after_qty: '69.5000',
      reason: '维修工单备件消耗（MT-11）',
      ref_type: 'maintenance_order',
      ref_id: orderAId,
      from_location_code: fx.spareLocationCode,
    })
    // MT-11 修复（2026-10）②：stock_entry 分录对账（内核 writeLine 同事务写入；IT-19/25）
    const entry = await pool.query(
      `SELECT e.entry_no, e.quantity_delta::text AS delta, e.before_qty::text AS before_qty,
         e.after_qty::text AS after_qty, e.purpose, e.location_code,
         e.balance_id::text = b.id::text AS entry_balance_match, e.transaction_id::text = t.id::text AS entry_tx_match
       FROM stock_entry e
       JOIN stock_transaction t ON t.id = e.transaction_id
       JOIN stock_balance b ON b.id = e.balance_id
       WHERE e.unit_id = $1`,
      [fx.spareUnitId],
    )
    expect(entry.rows).toHaveLength(1)
    expect(entry.rows[0]).toMatchObject({
      entry_no: 1,
      delta: '-30.5000',
      before_qty: MNT_SPARE_INITIAL_QTY,
      after_qty: '69.5000',
      purpose: 'issue',
      location_code: fx.spareLocationCode,
      entry_balance_match: true,
      entry_tx_match: true,
    })
    // 同事务审计与 Outbox（MT-11 修复：库存变动独立留痕）
    const spareAudit = await pool.query(
      `SELECT count(*)::int AS c FROM audit_entry WHERE action = 'maintenance.spare.issue' AND subject_id = $1`,
      [fx.spareUnitId],
    )
    expect(spareAudit.rows[0]!.c).toBe(1)
    const spareOutbox = await pool.query(
      `SELECT payload->>'orderId' AS order_ref, payload->>'afterQty' AS after_qty
       FROM outbox WHERE task_kind = 'maintenance.spare-issued' AND aggregate_id = $1`,
      [fx.spareUnitId],
    )
    expect(spareOutbox.rows).toHaveLength(1)
    expect(spareOutbox.rows[0]).toMatchObject({ order_ref: orderAId, after_qty: '69.5000' })
    const usage = await pool.query(`SELECT count(*)::int AS c FROM spare_part_usage WHERE order_id = $1`, [orderAId])
    expect(usage.rows[0]!.c).toBe(1)
    // MT-08：复机置设备正常（投影）
    const eq = await pool.query(`SELECT equipment_status FROM equipment WHERE id = $1`, [fx.eq1Id])
    expect(eq.rows[0]!.equipment_status).toBe(1)
  })

  it('复机后排程可见能力恢复（capacity-events 读回，MT-10/15）', async () => {
    if (skipIfNoDb()) return
    const events = (await getJson(`/maintenance/capacity-events?equipmentId=${fx.eq1Id}`)) as unknown as Array<{
      payload: { changeKind: string }
    }>
    expect(Array.isArray(events)).toBe(true)
    expect(events.map((e) => e.payload.changeKind).sort()).toEqual(['down', 'restored'])
  })

  it('命令幂等：同 operationId 复机回放不重复消耗（不重复扣库存）', async () => {
    if (skipIfNoDb()) return
    const replay = await postCommand(
      '/maintenance/orders/restart',
      {
        orderId: orderAId,
        responsible: '张三',
        spareParts: [{ unitId: fx.spareUnitId, quantity: '30.5000' }],
      },
      `${run}-a-restart`,
    )
    expect(replay.status).toBe('COMMITTED')
    const usage = await pool.query(`SELECT count(*)::int AS c FROM spare_part_usage WHERE order_id = $1`, [orderAId])
    expect(usage.rows[0]!.c).toBe(1)
    const balance = await pool.query(`SELECT quantity::text AS q FROM stock_balance WHERE unit_id = $1`, [fx.spareUnitId])
    expect(balance.rows[0]!.q).toBe('69.5000')
    // MT-11 修复 ④：重复 operationId 不多扣——流水与分录均不重复（IT-19 幂等唯一）
    const txCount = await pool.query(
      `SELECT count(*)::int AS c FROM stock_transaction WHERE unit_id = $1 AND movement_kind = 'issue'`,
      [fx.spareUnitId],
    )
    expect(txCount.rows[0]!.c).toBe(1)
    const entryCount = await pool.query(`SELECT count(*)::int AS c FROM stock_entry WHERE unit_id = $1`, [fx.spareUnitId])
    expect(entryCount.rows[0]!.c).toBe(1)
  })
})

// ---------------- 异常上报（MT-03/04；PDA）与取消语义（MT-14） ----------------

describe('异常上报与取消语义（MT-03/04/02/07/14）', () => {
  let anomalyOrderId = ''

  it('扫码前缀宽容（equ-/EQU-）＋置"维修"可关联建单（MT-04/13）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/equipment/anomaly-report',
      { equipmentCode: `equ-${fx.eq3Code}`, targetStatus: 2, createOrder: true, description: '轴承异响' },
      `${run}-ano-1`,
    )
    expect(reply.status).toBe('COMMITTED')
    const data = reply.data as { statusChanged: boolean; orderId: string | null; oldStatus: number; newStatus: number }
    expect(data.statusChanged).toBe(true)
    expect(data.oldStatus).toBe(1)
    expect(data.newStatus).toBe(2)
    expect(data.orderId).toBeTruthy()
    anomalyOrderId = data.orderId as string
    // MT-02/03：状态变化记流水（来源 PDA）
    const logs = await pool.query(
      `SELECT old_status, new_status, source FROM equipment_status_log WHERE equipment_id = $1 ORDER BY created_at DESC`,
      [fx.eq3Id],
    )
    expect(logs.rows[0]).toMatchObject({ old_status: 1, new_status: 2, source: 'PDA' })
    const source = await pool.query(`SELECT source FROM maintenance_order WHERE id = $1`, [anomalyOrderId])
    expect(source.rows[0]!.source).toBe('anomaly_report')
  })

  it('状态相同仍算成功但不记变更（MT-03/02）', async () => {
    if (skipIfNoDb()) return
    const before = await pool.query(`SELECT count(*)::int AS c FROM equipment_status_log WHERE equipment_id = $1`, [fx.eq3Id])
    const reply = await postCommand(
      '/maintenance/equipment/anomaly-report',
      { equipmentCode: fx.eq3Code, targetStatus: 2 },
      `${run}-ano-same`,
    )
    expect(reply.status).toBe('COMMITTED')
    expect((reply.data as { statusChanged: boolean }).statusChanged).toBe(false)
    const after = await pool.query(`SELECT count(*)::int AS c FROM equipment_status_log WHERE equipment_id = $1`, [fx.eq3Id])
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c)
  })

  it('未扫到有效设备（MT-03）与非法状态值（MT-01）拒绝', async () => {
    if (skipIfNoDb()) return
    const notFound = await postCommand(
      '/maintenance/equipment/anomaly-report',
      { equipmentCode: 'equ-NOPE-99', targetStatus: 2 },
      `${run}-ano-nf`,
    )
    expect(notFound.status).toBe('BUSINESS_REJECTION')
    expect(notFound.errorMessage).toContain('[MT-03]')
    expect(notFound.errorMessage).toContain('未扫到有效设备')
    const noStatus = await postCommand(
      '/maintenance/equipment/anomaly-report',
      { equipmentCode: fx.eq3Code },
      `${run}-ano-ns`,
    )
    expect(noStatus.status).toBe('BUSINESS_REJECTION')
    expect(noStatus.errorMessage).toContain('[MT-03]')
    expect(noStatus.errorMessage).toContain('未选择目标状态')
    const badValue = await postCommand(
      '/maintenance/equipment/anomaly-report',
      { equipmentCode: fx.eq3Code, targetStatus: 3 },
      `${run}-ano-bad`,
    )
    expect(badValue.status).toBe('BUSINESS_REJECTION')
    expect(badValue.errorMessage).toContain('[MT-01]')
  })

  it('状态机负例：越级分派外推进与缺被派人（MT-07/13）', async () => {
    if (skipIfNoDb()) return
    const skip = await postCommand('/maintenance/orders/start', { orderId: anomalyOrderId }, `${run}-ano-skip`)
    expect(skip.status).toBe('BUSINESS_REJECTION')
    expect(skip.errorMessage).toContain('[MT-07]')
    const noAssignee = await postCommand(
      '/maintenance/orders/dispatch',
      { orderId: anomalyOrderId, assignee: '' },
      `${run}-ano-noass`,
    )
    expect(noAssignee.status).toBe('BUSINESS_REJECTION')
    expect(noAssignee.errorMessage).toContain('[MT-13]')
  })

  it('停机区间不重叠：在途停机中同设备再建单拒绝（MT-09）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/orders',
      { equipmentCode: fx.eq3Code, reason: '重叠停机' },
      `${run}-ano-overlap`,
    )
    expect(reply.status).toBe('BUSINESS_REJECTION')
    expect(reply.errorMessage).toContain('[MT-09]')
    expect(reply.errorMessage).toContain('不重叠')
  })

  it('取消语义：处理中可取消（原因必填）且停机事实保留（MT-14）', async () => {
    if (skipIfNoDb()) return
    await postCommand('/maintenance/orders/dispatch', { orderId: anomalyOrderId, assignee: '王五' }, `${run}-ano-disp`)
    await postCommand('/maintenance/orders/start', { orderId: anomalyOrderId }, `${run}-ano-start`)
    const noReason = await postCommand('/maintenance/orders/cancel', { orderId: anomalyOrderId }, `${run}-ano-nor`)
    expect(noReason.status).toBe('BUSINESS_REJECTION')
    expect(noReason.errorMessage).toContain('[MT-14]')
    const cancel = await postCommand(
      '/maintenance/orders/cancel',
      { orderId: anomalyOrderId, cancelReason: '重复报修，合并到主单' },
      `${run}-ano-cancel`,
    )
    expect(cancel.status).toBe('COMMITTED')
    expect((cancel.data as { status: string }).status).toBe('cancelled')
    // 停机事实保留：取消不删除停机事件与状态流水（仍开区间）
    const detail = (await getJson(`/maintenance/orders/${anomalyOrderId}`)) as {
      downtimeEvents: Array<{ endAt: string | null }>
      equipmentStatusLogs: unknown[]
    }
    expect(detail.downtimeEvents[0]!.endAt).toBeNull()
    expect(detail.equipmentStatusLogs.length).toBeGreaterThan(0)
  })

  it('取消后同设备建单仍被在途停机拦截（停机事实保留的直接后果，MT-09/14）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/orders',
      { equipmentCode: fx.eq3Code, reason: '取消后再建' },
      `${run}-ano-after-cancel`,
    )
    expect(reply.status).toBe('BUSINESS_REJECTION')
    expect(reply.errorMessage).toContain('[MT-09]')
  })

  it('直接改状态命令保留原文行为：PDA 置回正常＋记流水（MT-03/08）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/equipment/anomaly-report',
      { equipmentCode: fx.eq3Code, targetStatus: 1 },
      `${run}-ano-restore`,
    )
    expect(reply.status).toBe('COMMITTED')
    expect((reply.data as { statusChanged: boolean }).statusChanged).toBe(true)
    const logs = await pool.query(
      `SELECT old_status, new_status, source FROM equipment_status_log WHERE equipment_id = $1 ORDER BY created_at DESC`,
      [fx.eq3Id],
    )
    expect(logs.rows[0]).toMatchObject({ old_status: 2, new_status: 1, source: 'PDA' })
  })
})

// ---------------- 备件不足回滚与待复机不可取消（MT-11/10/14） ----------------

describe('备件不足回滚与复机前置（MT-11/10/14）', () => {
  let orderBId = ''

  it('第二单推进到待复机', async () => {
    if (skipIfNoDb()) return
    const create = await postCommand(
      '/maintenance/orders',
      { equipmentCode: fx.eq1Code, reason: '第二轮检修' },
      `${run}-b-create`,
    )
    orderBId = (create.data as { orderId: string }).orderId
    await postCommand('/maintenance/orders/dispatch', { orderId: orderBId, assignee: '赵六' }, `${run}-b-disp`)
    await postCommand('/maintenance/orders/start', { orderId: orderBId }, `${run}-b-start`)
    await postCommand('/maintenance/orders/finish-repair', { orderId: orderBId }, `${run}-b-finish`)
  })

  it('复机于非待复机状态拒绝（MT-10）', async () => {
    if (skipIfNoDb()) return
    const create = await postCommand(
      '/maintenance/orders',
      { equipmentCode: fx.eq2Code, reason: '复位校验单' },
      `${run}-c-create`,
    )
    const orderCId = (create.data as { orderId: string }).orderId
    const early = await postCommand(
      '/maintenance/orders/restart',
      { orderId: orderCId, responsible: '张三' },
      `${run}-c-early`,
    )
    expect(early.status).toBe('BUSINESS_REJECTION')
    expect(early.errorMessage).toContain('[MT-10]')
    expect(early.errorMessage).toContain('待复机')
    await postCommand('/maintenance/orders/cancel', { orderId: orderCId, cancelReason: '测试清理' }, `${run}-c-cancel`)
  })

  it('消耗数量为 0 拒绝（MT-11）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/orders/restart',
      { orderId: orderBId, responsible: '张三', spareParts: [{ unitId: fx.spareUnitId, quantity: '0.0000' }] },
      `${run}-b-zero`,
    )
    expect(reply.status).toBe('BUSINESS_REJECTION')
    expect(reply.errorMessage).toContain('[MT-11]')
    expect(reply.errorMessage).toContain('大于 0')
  })

  it('可用量不足：整单回滚不改变工单状态（MT-11/10；余额与停机不动）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/orders/restart',
      { orderId: orderBId, responsible: '张三', spareParts: [{ unitId: fx.spareUnitId, quantity: '200.0000' }] },
      `${run}-b-short`,
    )
    expect(reply.status).toBe('BUSINESS_REJECTION')
    expect(reply.errorCode).toBe('ERR_INSUFFICIENT_STOCK')
    expect(reply.errorMessage).toContain('[MT-11]')
    // 复机失败不改变工单状态（MT-10）＋不扣库存＋停机仍开
    const order = await pool.query(`SELECT status FROM maintenance_order WHERE id = $1`, [orderBId])
    expect(order.rows[0]!.status).toBe('pending_restart')
    const balance = await pool.query(`SELECT quantity::text AS q FROM stock_balance WHERE unit_id = $1`, [fx.spareUnitId])
    expect(balance.rows[0]!.q).toBe('69.5000')
    const downtime = await pool.query(
      `SELECT end_at FROM downtime_event WHERE order_id = $1 AND end_at IS NULL`,
      [orderBId],
    )
    expect(downtime.rows).toHaveLength(1)
  })

  it('待复机不可取消（MT-14）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/orders/cancel',
      { orderId: orderBId, cancelReason: '不可取消' },
      `${run}-b-cancel`,
    )
    expect(reply.status).toBe('BUSINESS_REJECTION')
    expect(reply.errorMessage).toContain('[MT-14]')
    expect(reply.errorMessage).toContain('不可取消')
  })

  it('无备件复机成功：能力事件成对（该设备 down×2＋restored×2）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/orders/restart',
      { orderId: orderBId, responsible: '钱七' },
      `${run}-b-restart`,
    )
    expect(reply.status).toBe('COMMITTED')
    const events = (await getJson(`/maintenance/capacity-events?equipmentId=${fx.eq1Id}`)) as unknown as Array<{
      payload: { changeKind: string }
    }>
    const kinds = events.map((e) => e.payload.changeKind)
    expect(kinds.filter((k) => k === 'down')).toHaveLength(2)
    expect(kinds.filter((k) => k === 'restored')).toHaveLength(2)
  })
})

// ---------------- MT-11 修复（2026-10）：库存内核路径（IT-14/18/19/25/29） ----------------

describe('MT-11 修复：预留感知可用量与内核记账（IT-14/18/19/25/29）', () => {
  let orderId = ''

  it('推进取证工单到待复机（夹具：合格 40＋活动预留 25 → 可用 15）', async () => {
    if (skipIfNoDb()) return
    const created = await postCommand('/maintenance/orders', { equipmentCode: fx.eq1Code, reason: 'MT-11 修复取证' }, `${run}-fix-create`)
    orderId = (created.data as { orderId: string }).orderId
    await postCommand('/maintenance/orders/dispatch', { orderId, assignee: '验收员' }, `${run}-fix-dispatch`)
    await postCommand('/maintenance/orders/start', { orderId }, `${run}-fix-start`)
    await postCommand('/maintenance/orders/finish-repair', { orderId }, `${run}-fix-finish`)
    const status = await pool.query(`SELECT status FROM maintenance_order WHERE id = $1`, [orderId])
    expect(status.rows[0]!.status).toBe('pending_restart')
  })

  it('①预留感知拒绝：消耗 20 > 可用 15（毛量 40−预留 25）→ ERR_INSUFFICIENT_STOCK，工单/余额/停机不动', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/orders/restart',
      { orderId, responsible: '张三', spareParts: [{ unitId: fx.spareReservedUnitId, quantity: '20.0000' }] },
      `${run}-fix-resv-reject`,
    )
    expect(reply.status).toBe('BUSINESS_REJECTION')
    expect(reply.errorCode).toBe('ERR_INSUFFICIENT_STOCK')
    expect(reply.errorMessage).toContain('[MT-11]')
    expect(reply.errorMessage).toContain('可用=15')
    // 整单回滚：工单不动＋余额仍 40＋无 issue 流水＋停机仍开
    const order = await pool.query(`SELECT status FROM maintenance_order WHERE id = $1`, [orderId])
    expect(order.rows[0]!.status).toBe('pending_restart')
    const balance = await pool.query(`SELECT quantity::text AS q FROM stock_balance WHERE unit_id = $1`, [fx.spareReservedUnitId])
    expect(balance.rows[0]!.q).toBe('40.0000')
    const tx = await pool.query(`SELECT count(*)::int AS c FROM stock_transaction WHERE unit_id = $1`, [fx.spareReservedUnitId])
    expect(tx.rows[0]!.c).toBe(0)
    const downtime = await pool.query(`SELECT count(*)::int AS c FROM downtime_event WHERE order_id = $1 AND end_at IS NULL`, [orderId])
    expect(downtime.rows[0]!.c).toBe(1)
  })

  it('①预留内合法扣减：消耗 15 = 可用量成功（旧路径按毛量 40 放行 20 的缺口不再存在）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/orders/restart',
      { orderId, responsible: '张三', spareParts: [{ unitId: fx.spareReservedUnitId, quantity: '15.0000' }] },
      `${run}-fix-resv-ok`,
    )
    expect(reply.status).toBe('COMMITTED')
    expect((reply.data as { status: string }).status).toBe('closed')
    // 余额 40→25（毛量−消耗；预留 25 保留原状——maintenance 无预留核销语义）
    const balance = await pool.query(
      `SELECT quantity::text AS q, quality_status FROM stock_balance WHERE unit_id = $1`,
      [fx.spareReservedUnitId],
    )
    expect(balance.rows[0]).toMatchObject({ q: '25.0000', quality_status: 'qualified' })
    const reservation = await pool.query(
      `SELECT status, quantity::text AS q FROM reservation WHERE unit_id = $1`,
      [fx.spareReservedUnitId],
    )
    expect(reservation.rows[0]).toMatchObject({ status: 'active', q: '25.0000' })
    // 流水＋分录对账（扣前 40/扣后 25）
    const tx = await pool.query(
      `SELECT before_qty::text AS before_qty, after_qty::text AS after_qty FROM stock_transaction WHERE unit_id = $1 AND movement_kind = 'issue'`,
      [fx.spareReservedUnitId],
    )
    expect(tx.rows).toHaveLength(1)
    expect(tx.rows[0]).toMatchObject({ before_qty: '40.0000', after_qty: '25.0000' })
    const entry = await pool.query(
      `SELECT quantity_delta::text AS delta, before_qty::text AS before_qty, after_qty::text AS after_qty
       FROM stock_entry WHERE unit_id = $1`,
      [fx.spareReservedUnitId],
    )
    expect(entry.rows).toHaveLength(1)
    expect(entry.rows[0]).toMatchObject({ delta: '-15.0000', before_qty: '40.0000', after_qty: '25.0000' })
  })

  it('①不可用库存拒绝：待检余额不进入可用量（IT-14 质量∧可用）', async () => {
    if (skipIfNoDb()) return
    // eq2 已被早前"复位校验单"取消留下的开区间停机占用（MT-14 停机事实保留）——用 eq4
    const created = await postCommand('/maintenance/orders', { equipmentCode: fx.eq4Code, reason: '待检备件取证' }, `${run}-fix-unq-create`)
    const unqOrderId = (created.data as { orderId: string }).orderId
    await postCommand('/maintenance/orders/dispatch', { orderId: unqOrderId, assignee: '验收员' }, `${run}-fix-unq-dispatch`)
    await postCommand('/maintenance/orders/start', { orderId: unqOrderId }, `${run}-fix-unq-start`)
    await postCommand('/maintenance/orders/finish-repair', { orderId: unqOrderId }, `${run}-fix-unq-finish`)
    const reply = await postCommand(
      '/maintenance/orders/restart',
      { orderId: unqOrderId, responsible: '张三', spareParts: [{ unitId: fx.spareUnqualifiedUnitId, quantity: '5.0000' }] },
      `${run}-fix-unq-reject`,
    )
    expect(reply.status).toBe('BUSINESS_REJECTION')
    expect(reply.errorMessage).toContain('[MT-11]')
    expect(reply.errorMessage).toContain('无可用余额')
    // 工单留在待复机（取证后以无备件复机收尾，还设备正常供后续夹具）
    const order = await pool.query(`SELECT status FROM maintenance_order WHERE id = $1`, [unqOrderId])
    expect(order.rows[0]!.status).toBe('pending_restart')
    const tx = await pool.query(`SELECT count(*)::int AS c FROM stock_transaction WHERE unit_id = $1`, [fx.spareUnqualifiedUnitId])
    expect(tx.rows[0]!.c).toBe(0)
    await postCommand('/maintenance/orders/restart', { orderId: unqOrderId, responsible: '张三' }, `${run}-fix-unq-close`)
  })

  it('③扣尽关闭：整额消耗后余额关闭＋单元耗尽（IT-29 身份与谱系保留）', async () => {
    if (skipIfNoDb()) return
    const created = await postCommand('/maintenance/orders', { equipmentCode: fx.eq4Code, reason: '扣尽关闭取证' }, `${run}-fix-drain-create`)
    const drainOrderId = (created.data as { orderId: string }).orderId
    await postCommand('/maintenance/orders/dispatch', { orderId: drainOrderId, assignee: '验收员' }, `${run}-fix-drain-dispatch`)
    await postCommand('/maintenance/orders/start', { orderId: drainOrderId }, `${run}-fix-drain-start`)
    await postCommand('/maintenance/orders/finish-repair', { orderId: drainOrderId }, `${run}-fix-drain-finish`)
    const reply = await postCommand(
      '/maintenance/orders/restart',
      { orderId: drainOrderId, responsible: '张三', spareParts: [{ unitId: fx.spareDrainUnitId, quantity: '20.0000' }] },
      `${run}-fix-drain-restart`,
    )
    expect(reply.status).toBe('COMMITTED')
    // 余额行关闭（不删除，closed_at 落值）＋单元状态轴 → 已耗尽（IT-13/29）
    const balance = await pool.query(
      `SELECT status, quantity::text AS q, closed_at IS NOT NULL AS has_closed_at FROM stock_balance WHERE unit_id = $1`,
      [fx.spareDrainUnitId],
    )
    expect(balance.rows[0]).toMatchObject({ status: 'closed', q: '0.0000', has_closed_at: true })
    const unit = await pool.query(`SELECT status, balance_open FROM inventory_unit WHERE id = $1`, [fx.spareDrainUnitId])
    expect(unit.rows[0]).toMatchObject({ status: 'exhausted', balance_open: false })
    // 零余额流水/分录齐备（扣前 20/扣后 0）
    const entry = await pool.query(
      `SELECT quantity_delta::text AS delta, before_qty::text AS before_qty, after_qty::text AS after_qty
       FROM stock_entry WHERE unit_id = $1`,
      [fx.spareDrainUnitId],
    )
    expect(entry.rows).toHaveLength(1)
    expect(entry.rows[0]).toMatchObject({ delta: '-20.0000', before_qty: '20.0000', after_qty: '0.0000' })
  })
})

// ---------------- 设备开工（MT-05/06） ----------------

describe('设备开工（MT-05/06）', () => {
  it('正常设备开工：业务日幂等（重复开工更新时间不新建，MT-05/06）', async () => {
    if (skipIfNoDb()) return
    const first = await postCommand(
      '/maintenance/equipment/start-work',
      { equipmentCode: fx.eq1Code, startedAt: '2026-10-28T09:00:00+08:00' },
      `${run}-sw-1`,
    )
    expect(first.status).toBe('COMMITTED')
    const data = first.data as { businessDate: string; updatedExistingRecord: boolean; recordId: string }
    expect(data.businessDate).toBe('2026-10-28')
    expect(data.updatedExistingRecord).toBe(false)
    const again = await postCommand(
      '/maintenance/equipment/start-work',
      { equipmentCode: fx.eq1Code, startedAt: '2026-10-28T14:30:00+08:00' },
      `${run}-sw-2`,
    )
    expect((again.data as { updatedExistingRecord: boolean }).updatedExistingRecord).toBe(true)
    expect((again.data as { recordId: string }).recordId).toBe(data.recordId)
    const records = (await getJson(`/maintenance/start-records?equipmentId=${fx.eq1Id}&businessDate=2026-10-28`)) as {
      total: number
      items: Array<{ startedAt: string; businessDate: string }>
    }
    expect(records.total).toBe(1)
    // ISO-8601 UTC 读回：北京时间 14:30 = UTC 06:30（当日重复开工=更新开工时间）
    expect(records.items[0]!.startedAt).toBe(new Date('2026-10-28T14:30:00+08:00').toISOString())
  })

  it('业务日按班次规则折算（UTC 前日深夜归本地次日，MT-06/IT-37）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/equipment/start-work',
      { equipmentCode: fx.eq1Code, startedAt: '2026-10-29T17:30:00Z' },
      `${run}-sw-3`,
    )
    // 2026-10-29T17:30:00Z = 北京时间 10-30 01:30 → 业务日 2026-10-30（非 UTC 自然日 10-29）
    expect((reply.data as { businessDate: string }).businessDate).toBe('2026-10-30')
  })

  it('非正常状态设备不可开工（MT-05）', async () => {
    if (skipIfNoDb()) return
    // eq2 置维修（直接改状态命令，原文行为）→ 开工拒绝
    await postCommand(
      '/maintenance/equipment/anomaly-report',
      { equipmentCode: fx.eq2Code, targetStatus: 2 },
      `${run}-sw-eq2-down`,
    )
    const reply = await postCommand(
      '/maintenance/equipment/start-work',
      { equipmentCode: fx.eq2Code },
      `${run}-sw-reject`,
    )
    expect(reply.status).toBe('BUSINESS_REJECTION')
    expect(reply.errorMessage).toContain('[MT-05]')
    // 还原 eq2 供后续夹具稳定
    await postCommand(
      '/maintenance/equipment/anomaly-report',
      { equipmentCode: fx.eq2Code, targetStatus: 1 },
      `${run}-sw-eq2-up`,
    )
  })
})

// ---------------- 点检/保养（MT-12） ----------------

describe('点检/保养计划与执行（MT-12）', () => {
  it('计划版本化：v1→v2 自动递增（周期＋检查项模板）', async () => {
    if (skipIfNoDb()) return
    const v1 = await postCommand(
      '/maintenance/plans/create-version',
      {
        planKey: 'PLAN-MNT-A',
        kind: 'inspection',
        equipmentCode: fx.eq1Code,
        cycle: { everyDays: 7 },
        checkItems: ['轴承温度', '油位'],
        effectiveFrom: '2026-10-01',
      },
      `${run}-plan-v1`,
    )
    expect(v1.status).toBe('COMMITTED')
    expect((v1.data as { version: number }).version).toBe(1)
    const v2 = await postCommand(
      '/maintenance/plans/create-version',
      {
        planKey: 'PLAN-MNT-A',
        kind: 'inspection',
        equipmentCode: fx.eq1Code,
        cycle: { everyDays: 3 },
        checkItems: ['轴承温度', '油位', '皮带张力'],
        effectiveFrom: '2026-10-20',
      },
      `${run}-plan-v2`,
    )
    expect((v2.data as { version: number }).version).toBe(2)
  })

  it('计划守卫负例：周期/模板/种类/生效区间（MT-12）', async () => {
    if (skipIfNoDb()) return
    const badCycle = await postCommand(
      '/maintenance/plans/create-version',
      { planKey: 'PLAN-MNT-X1', kind: 'inspection', equipmentCode: fx.eq1Code, cycle: { everyDays: 0 }, checkItems: ['x'], effectiveFrom: '2026-10-01' },
      `${run}-plan-bad-cycle`,
    )
    expect(badCycle.status).toBe('BUSINESS_REJECTION')
    expect(badCycle.errorMessage).toContain('[MT-12]')
    const badItems = await postCommand(
      '/maintenance/plans/create-version',
      { planKey: 'PLAN-MNT-X2', kind: 'inspection', equipmentCode: fx.eq1Code, cycle: { everyDays: 7 }, checkItems: [], effectiveFrom: '2026-10-01' },
      `${run}-plan-bad-items`,
    )
    expect(badItems.status).toBe('BUSINESS_REJECTION')
    const badKind = await postCommand(
      '/maintenance/plans/create-version',
      { planKey: 'PLAN-MNT-X3', kind: 'daily', equipmentCode: fx.eq1Code, cycle: { everyDays: 7 }, checkItems: ['x'], effectiveFrom: '2026-10-01' },
      `${run}-plan-bad-kind`,
    )
    expect(badKind.status).toBe('BUSINESS_REJECTION')
  })

  it('执行轮次：实际时间＋业务班次双存（MT-12/IT-37）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/rounds',
      { planKey: 'PLAN-MNT-A', version: 1, result: 'pass', executedAt: '2026-10-20T10:00:00+08:00' },
      `${run}-round-pass`,
    )
    expect(reply.status).toBe('COMMITTED')
    const data = reply.data as { shiftDate: string; executedAt: string; repairSuggestion: unknown }
    expect(data.shiftDate).toBe('2026-10-20')
    expect(data.executedAt).toContain('2026-10-20')
    expect(data.repairSuggestion).toBeNull()
  })

  it('不合格必填异常说明；建议报修但不自动建单（MT-12/GAP-F19）', async () => {
    if (skipIfNoDb()) return
    const ordersBefore = await pool.query(`SELECT count(*)::int AS c FROM maintenance_order`)
    const noNote = await postCommand(
      '/maintenance/rounds',
      { planKey: 'PLAN-MNT-A', version: 1, result: 'fail' },
      `${run}-round-fail-nonote`,
    )
    expect(noNote.status).toBe('BUSINESS_REJECTION')
    expect(noNote.errorMessage).toContain('[MT-12]')
    expect(noNote.errorMessage).toContain('异常说明')
    const fail = await postCommand(
      '/maintenance/rounds',
      { planKey: 'PLAN-MNT-A', version: 1, result: 'fail', anomalyNote: '轴承温度超限', executedAt: '2026-10-21T15:00:00+08:00' },
      `${run}-round-fail`,
    )
    expect(fail.status).toBe('COMMITTED')
    const suggestion = (fail.data as { repairSuggestion: { suggested: boolean; anomalyNote: string } | null }).repairSuggestion
    expect(suggestion?.suggested).toBe(true)
    expect(suggestion?.anomalyNote).toBe('轴承温度超限')
    const ordersAfter = await pool.query(`SELECT count(*)::int AS c FROM maintenance_order`)
    expect(ordersAfter.rows[0]!.c).toBe(ordersBefore.rows[0]!.c)
  })

  it('轮次必须引用存在的计划版本（快照引用）', async () => {
    if (skipIfNoDb()) return
    const reply = await postCommand(
      '/maintenance/rounds',
      { planKey: 'PLAN-MNT-A', version: 99, result: 'pass' },
      `${run}-round-badver`,
    )
    expect(reply.status).toBe('BUSINESS_REJECTION')
    expect(reply.errorCode).toBe('ERR_NOT_FOUND')
    expect(reply.errorMessage).toContain('计划版本不存在')
  })

  it('超期未执行提示（不阻断生产；锚点=最近执行班次日/生效日＋周期）', async () => {
    if (skipIfNoDb()) return
    await postCommand(
      '/maintenance/plans/create-version',
      {
        planKey: 'PLAN-MNT-B',
        kind: 'maintenance',
        equipmentCode: fx.eq2Code,
        cycle: { everyDays: 7 },
        checkItems: ['润滑脂补注'],
        effectiveFrom: '2026-10-01',
      },
      `${run}-plan-b`,
    )
    const overdue = (await getJson('/maintenance/plans/overdue?today=2026-10-28')) as {
      items: Array<{ planKey: string; version: number; anchorDate: string; nextDueDate: string; note: string }>
    }
    // PLAN-MNT-A：当日生效版本为 v2（everyDays=3，自 10-20 生效——配置变更不回写已执行记录）；
    // 锚点=最近执行 2026-10-21 ＋3 天 = 10-24 < 10-28 → 超期（仅列生效版本，v1 不重复列）
    const planAEntries = overdue.items.filter((i) => i.planKey === 'PLAN-MNT-A')
    expect(planAEntries).toHaveLength(1)
    expect(planAEntries[0]).toMatchObject({ version: 2, anchorDate: '2026-10-21', nextDueDate: '2026-10-24' })
    // PLAN-MNT-B：无执行，锚点=生效日 10-01 ＋7 天 = 10-08 < 10-28 → 超期
    const planB = overdue.items.find((i) => i.planKey === 'PLAN-MNT-B')
    expect(planB).toMatchObject({ anchorDate: '2026-10-01', nextDueDate: '2026-10-08' })
    expect(planB!.note).toContain('不自动阻断')
  })

  it('查询杂项：状态筛选值非法 422（MT-07 字典）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get('/maintenance/orders?status=bogus')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(422)
  })
})

// ---------------- O-2 错误码映射（与其余域一致：ERR_* → 4xx/409 语义） ----------------

describe('O-2 命令错误码映射（200 包络废除，按错误类别承载 HTTP 状态）', () => {
  it('业务规则拒绝 → 422 ERR_BUSINESS_RULE，body { code, message, details.operationId }', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .post('/maintenance/equipment/anomaly-report')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-operation-id', `${run}-map-422`)
      .send({ equipmentCode: 'equ-NOPE-MAP', targetStatus: 2 })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('ERR_BUSINESS_RULE')
    expect(res.body.message).toContain('[MT-03]')
    expect(res.body.details).toMatchObject({ operationId: `${run}-map-422` })
  })

  it('未找到 → 404 ERR_NOT_FOUND（轮次引用不存在计划版本）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .post('/maintenance/rounds')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-operation-id', `${run}-map-404`)
      .send({ planKey: 'PLAN-MNT-A', version: 99, result: 'pass' })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('ERR_NOT_FOUND')
    expect(res.body.message).toContain('计划版本不存在')
  })

  it('范围拒绝 → 403 ERR_FORBIDDEN_SCOPE（HF 厂管理员对 SZ 设备建单，A-S1）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .post('/maintenance/orders')
      .set('Authorization', `Bearer ${hfToken}`)
      .set('x-operation-id', `${run}-map-403`)
      .send({ equipmentCode: fx.eq1Code, reason: '映射取证' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ERR_FORBIDDEN_SCOPE')
    expect(res.body.message).toContain('[A-S1]')
  })

  it('成功仍 200：body { operationId, status: COMMITTED, data }', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .post('/maintenance/equipment/start-work')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-operation-id', `${run}-map-200`)
      .send({ equipmentCode: fx.eq1Code, startedAt: '2026-10-28T10:00:00+08:00' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ operationId: `${run}-map-200`, status: 'COMMITTED' })
    expect(res.body.data).toBeTruthy()
  })
})
