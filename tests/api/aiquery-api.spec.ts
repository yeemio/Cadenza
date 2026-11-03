import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { validateEnv } from '../../apps/api/src/env'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { DbModule } from '../../apps/api/src/db/db.module'
import { AiQueryModule } from '../../apps/api/src/aiquery/aiquery.module'
import { AQ_TEST_TIME_RANGE, AQ_TEST_DB_NAME, prepareAqTestDatabase, aqDatabaseUrl } from './aiquery-test-env'

/**
 * aiquery API 集成（真容器独立库 cadenza_query + supertest 自组装挂载，无桩；
 * 测试组合 = ConfigModule/DbModule/AuthModule（全局守卫）/AiQueryModule——不改共享
 * app.module.ts，L0 整合步统一注册）。
 *
 * 证据覆盖（dsh-edge §7 A 线验收门 + capability-contract）：
 * - DS-18/DS-19 内部端点形状 + 内部服务令牌（401/404）；
 * - AQ-REG-07 七状态中的六态（timeout 由 integration 侧 stub 仓储证）+ 信封六段；
 * - AQ-AUTH-01/02/03 撤权重验/能力许可/工厂范围（含 plantadmin 数据范围过滤）；
 * - AQ-REG-06 请求体 tenant/user/scope 字段忽略并记审计；
 * - AQ-AMB-01 多候选澄清；AQ-REG-08 零值=有效查询产物；AQ-AMB-02 时间回显（integration 侧）；
 * - AQ-C2 口径未定/单位不一致/价格列物理排除；AQ-C3 两族并查/结论过滤/时间窗；
 * - AQ-S2/DS-22 幂等重试（同一 requestId+toolCallSeq 至多一条审计行）。
 */

const INTERNAL_TOKEN = 'aq-test-internal-token'

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let adminToken = ''
let hfToken = ''
const run = `apaq${Date.now().toString(36)}`

beforeAll(async () => {
  try {
    pool = await prepareAqTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP aiquery api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${AQ_TEST_DB_NAME}）。`)
    return
  }
  process.env['DATABASE_URL'] = aqDatabaseUrl()
  process.env['AIQUERY_INTERNAL_TOKEN'] = INTERNAL_TOKEN
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, AuthModule, AiQueryModule],
  }).compile()
  app = moduleRef.createNestApplication()
  await app.init()
  adminToken = await login('admin', 'CadAdmin001')
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

async function openSession(token: string, channel = 'web'): Promise<string> {
  const res = await request(app.getHttpServer()).post('/aiquery/sessions').set('Authorization', `Bearer ${token}`).send({ channel })
  expect(res.status).toBe(201)
  expect(res.body.sessionId).toBeTypeOf('string')
  return res.body.sessionId as string
}

function execute(body: Record<string, unknown>) {
  return request(app.getHttpServer())
    .post('/internal/aiquery/execute')
    .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
    .send(body)
}

function envelopeBasics(res: { status: number; body: Record<string, unknown> }): void {
  // AQ-REG-07/DS-21：六段 + 状态标签 + auditRef（B 线双方断言同一信封样例）
  expect(res.body).toHaveProperty('status')
  expect(res.body).toHaveProperty('statusLabel')
  expect(res.body).toHaveProperty('message')
  expect(res.body).toHaveProperty('data')
  expect(res.body).toHaveProperty('completeness')
  expect(res.body).toHaveProperty('freshness')
  expect(res.body).toHaveProperty('contextEcho')
  expect(res.body).toHaveProperty('auditRef')
}

describe('① 会话登记与内部端点认证（AQ-S3/DS-18/DS-19）', () => {
  it('用户令牌 + aiquery.use 登记 ai_session；无模块许可 → 403', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const ok = await request(app.getHttpServer()).post('/aiquery/sessions').set('Authorization', `Bearer ${adminToken}`).send({ channel: 'web', conversationRef: 'conv-1' })
    expect(ok.status).toBe(201)
    expect(ok.body.channel).toBe('web')
    expect(ok.body.status).toBe('open')
    expect(ok.body.enterpriseId).toBeTypeOf('string')
    // szqc01（qc 角色，未授 aiquery.use）→ 403（OA-23 第一层）
    const qcLogin = await login('szqc01', 'SzQuality01')
    const denied = await request(app.getHttpServer()).post('/aiquery/sessions').set('Authorization', `Bearer ${qcLogin}`).send({ channel: 'web' })
    expect(denied.status).toBe(403)
    // channel 非法 → 422
    const badChannel = await request(app.getHttpServer()).post('/aiquery/sessions').set('Authorization', `Bearer ${adminToken}`).send({ channel: 'wechat' })
    expect(badChannel.status).toBe(422)
  })

  it('内部端点：无令牌/错误令牌 → 401；会话不存在 → 404 ERR_AI_SESSION_NOT_FOUND', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const noToken = await request(app.getHttpServer()).post('/internal/aiquery/capabilities').send({ sessionId: randomUUID() })
    expect(noToken.status).toBe(401)
    expect(noToken.body.code).toBe('ERR_AUTH_REQUIRED')
    const wrongToken = await request(app.getHttpServer())
      .post('/internal/aiquery/execute')
      .set('Authorization', 'Bearer wrong-internal-token')
      .send({ requestId: randomUUID(), toolCallSeq: 1, sessionId: randomUUID(), capabilityId: 'aq.order-progress', capabilityVersion: 1, params: {} })
    expect(wrongToken.status).toBe(401)
    expect(wrongToken.body.code).toBe('ERR_AUTH_REQUIRED')
    const notFound = await request(app.getHttpServer())
      .post('/internal/aiquery/capabilities')
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .send({ sessionId: randomUUID() })
    expect(notFound.status).toBe(404)
    expect(notFound.body.code).toBe('ERR_AI_SESSION_NOT_FOUND')
  })
})

describe('② 能力枚举（AQ-REG-05 许可预检 + §8 未就绪问法族）', () => {
  it('sysadmin：三能力 + 四项未就绪清单；plantadmin：仅 C1（预检失败能力对模型不可见）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const adminSession = await openSession(adminToken)
    const adminCaps = await request(app.getHttpServer())
      .post('/internal/aiquery/capabilities')
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .send({ sessionId: adminSession })
    expect(adminCaps.status).toBe(200)
    expect(adminCaps.body.capabilities.map((c: { capabilityId: string }) => c.capabilityId)).toEqual([
      'aq.material-shortage',
      'aq.order-progress',
      'aq.quality',
    ])
    expect(adminCaps.body.unreadyTopics).toHaveLength(4)
    expect(adminCaps.body.unreadyTopics[0]).toMatchObject({ capabilityId: 'aq.purchase-overdue-impact' })

    const hfSession = await openSession(hfToken, 'pda')
    const hfCaps = await request(app.getHttpServer())
      .post('/internal/aiquery/capabilities')
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .send({ sessionId: hfSession })
    expect(hfCaps.status).toBe(200)
    expect(hfCaps.body.capabilities.map((c: { capabilityId: string }) => c.capabilityId)).toEqual(['aq.order-progress'])
    expect(hfCaps.body.unreadyTopics).toHaveLength(4)
  })
})

describe('③ AQ-C1 订单进度（六段信封 + 五量/排程/未完成对照）', () => {
  it('黄金订单：信封六段齐全；五量与业务读面对照（SQL 聚合）；排程与未完成判定', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const res = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } },
    })
    expect(res.status).toBe(200)
    envelopeBasics(res)
    expect(res.body.status).toBe('ok_with_data')
    expect(res.body.data.order.orderNo).toBe('ORDER-AQ-1001')
    expect(res.body.data.order.materialDesc).toBe('AI演示-成品缆 / 3×95 / 红')
    expect(res.body.data.order.orderStatus).toBe('in_progress')
    expect(res.body.data.order.bomRevisionId).toBeTypeOf('string')

    // 信封段②：服务端绑定上下文回显（AQ-REG-06/AQ-AUTH-03）
    expect(res.body.contextEcho.sessionId).toBe(session)
    expect(res.body.contextEcho.dataScope.enterpriseWide).toBe(true)
    expect(res.body.contextEcho.capabilityId).toBe('aq.order-progress')
    expect(res.body.contextEcho.capabilityVersion).toBe(1)
    expect(res.body.auditRef.toolCallSeq).toBe(1)

    // 信封段③：五量分立（S02/A5-3）——与业务读面 SQL 聚合对照
    const orderRow = (await pool.query(`SELECT id FROM production_order WHERE order_no = 'ORDER-AQ-1001'`)).rows[0]!
    const sqlApproved = (
      await pool.query<{ sum: string | null }>(
        `SELECT COALESCE(SUM(ro.quantity), 0)::text AS sum FROM report_output ro
         JOIN production_report pr ON pr.id = ro.report_id
         WHERE pr.order_id = $1 AND pr.status = 'submitted'
           AND pr.review_status IN ('auto_approved', 'manual_approved')
           AND pr.review_cancelled_at IS NULL`,
        [orderRow.id],
      )
    ).rows[0]!.sum
    expect(res.body.data.order.totalQuantities.approvedQty).toBe(sqlApproved)
    expect(res.body.data.order.totalQuantities.qualifiedQty).toBe('78.0000')
    expect(res.body.data.order.totalQuantities.stockedQty).toBe('80.0000')
    expect(res.body.data.order.totalQuantities.draftQty).toBe('30.0000')
    expect(res.body.data.order.totalQuantities.submittedQty).toBe('0.0000')

    // 排程：op1 全排 100/100；op2 未排 → 订单 partially_scheduled、op2 未完成（GAP-P9：不看 execution_status）
    // scheduledQty 沿用 scheduling 域投影口径（scale=4 去尾零，'100.0000'→'100'，与排程页面 orderView 一致）
    expect(res.body.data.order.schedulingStatus).toBe('partially_scheduled')
    const ops = res.body.data.order.operations as Array<{
      seq: number
      scheduledQty: string
      fullyScheduled: boolean
      incomplete: boolean
      quantities: { approvedQty: string }
      ready: boolean
      readyReason: string
    }>
    expect(ops).toHaveLength(2)
    expect(ops[0]!.scheduledQty).toBe('100')
    expect(ops[0]!.fullyScheduled).toBe(true)
    expect(ops[0]!.incomplete).toBe(false)
    expect(ops[1]!.scheduledQty).toBe('0')
    expect(ops[1]!.fullyScheduled).toBe(false)
    expect(ops[1]!.incomplete).toBe(true)
    expect(ops[1]!.ready).toBe(true) // 前道已提交且有产出 → 就绪
    expect(res.body.message).toContain('未完成 1 道')

    // 信封段④：完整性与时效（freshness 来源=真实表名）
    expect(res.body.completeness).toMatchObject({ truncated: false, fetchedRows: 2, totalKnown: true, total: 2 })
    const sources = (res.body.freshness.sources as Array<{ source: string }>).map((s) => s.source)
    expect(sources).toEqual(['production_order', 'order_operation', 'schedule_slot', 'production_report', 'report_output'])
  })

  it('AQ-REG-08：零值＝有效查询产物——无报工订单仍 ok_with_data、五量全 0', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const res = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-ZERO' } },
    })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok_with_data')
    expect(res.body.data.order.totalQuantities).toEqual({
      draftQty: '0.0000',
      submittedQty: '0.0000',
      approvedQty: '0.0000',
      qualifiedQty: '0.0000',
      stockedQty: '0.0000',
    })
    expect(res.body.data.order.operations[0].incomplete).toBe(true)
  })

  it('AQ-AMB-01：模糊单号多命中 → 候选清单（order=null，不自行择一）；唯一/无命中路径', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const like = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNoLike', value: 'ORDER-AQ-AMB' } },
    })
    expect(like.body.status).toBe('ok_with_data')
    expect(like.body.data.order).toBeNull()
    expect(like.body.data.candidates.map((c: { orderNo: string }) => c.orderNo)).toEqual(['ORDER-AQ-AMB-1', 'ORDER-AQ-AMB-2'])
    expect(like.body.data.candidates[0]).toHaveProperty('materialDesc')
    expect(like.body.message).toContain('AQ-AMB-01')

    const bySales = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'salesOrderNo', value: 'SO-AQ-SHARED' } },
    })
    expect(bySales.body.data.candidates).toHaveLength(2)

    const none = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: `ORDER-NONE-${run}` } },
    })
    expect(none.body.status).toBe('ok_no_records')
    expect(none.body.message).toContain('AQ-REG-08')
  })

  it('数据范围（OA-25）：plantadmin 仅见本厂订单（SZ 单 → ok_no_records；HF 单正常）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(hfToken)
    const sz = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } },
    })
    expect(sz.body.status).toBe('ok_no_records')
    expect(sz.body.contextEcho.dataScope).toEqual({ enterpriseWide: false, plantIds: [sz.body.contextEcho.dataScope.plantIds[0]] })

    const own = await execute({
      requestId: randomUUID(),
      toolCallSeq: 2,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-HF-1' } },
    })
    expect(own.body.status).toBe('ok_with_data')
    expect(own.body.data.order.orderNo).toBe('ORDER-AQ-HF-1')
  })
})

describe('④ AQ-C2 物料缺口（口径未定 GAP-P4 + 三源并排 + 价格物理排除）', () => {
  it('黄金订单：BOM 三行并排；缺口数值列固定「口径未定」；单位不一致不折算；可用量=合格−预留', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const res = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.material-shortage',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } },
    })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok_with_data')
    expect(res.body.data.requirementBase).toBeNull()
    const lines = res.body.data.lines as Array<Record<string, unknown>>
    expect(lines).toHaveLength(3)

    const copper = lines.find((l) => l['materialCode'] === 'MAT-AQ-COPPER')!
    // 可用量 = 0.3000（合格）− 0.1000（活动预留）= 0.2000（IT-14）
    expect(copper['availability']).toEqual({ grossQty: '0.3000', reservedQty: '0.1000', availableQty: '0.2000' })
    // 在途 = 10 − 4 = 6（仅 status 0/1/2 且未 ERP 关闭）
    expect(copper['inTransitQty']).toBe('6.0000')
    expect(copper['requirementBase']).toBeNull()
    expect(copper['shortageQty']).toBeNull()
    expect(String(copper['shortageNote'])).toContain('口径未定')
    expect(copper['uomMismatch']).toBe(false)
    const purchaseLines = copper['purchaseLines'] as Array<Record<string, unknown>>
    expect(purchaseLines).toHaveLength(1)
    expect(purchaseLines[0]!).toMatchObject({ orderNo: 'PO-AQ-001', lineNo: 1, status: 1, statusLabel: '待收货', inTransitQty: '6.0000' })
    expect(purchaseLines[0]!['latestBatchInspectionStatusLabel']).toBe('全部不合格')

    const mixed = lines.find((l) => l['materialCode'] === 'MAT-AQ-MIXED')!
    expect(mixed['uomMismatch']).toBe(true)
    expect(String(mixed['shortageNote'])).toContain('单位不一致未折算')
    expect(mixed['uomSources']).toEqual({ bom: 'M', stock: 'M', purchase: 'KG' })

    // GAP-P5：价格类字段物理排除（响应键面无价格列）
    for (const line of lines) {
      expect(Object.keys(line)).not.toContain('unitPrice')
      expect(Object.keys(line)).not.toContain('avgPrice')
      for (const pl of line['purchaseLines'] as object[]) {
        expect(Object.keys(pl)).not.toContain('unitPrice')
        expect(Object.keys(pl)).not.toContain('priceHistory')
        expect(Object.keys(pl)).not.toContain('avgPrice')
        expect(Object.keys(pl)).not.toContain('deviationPpm')
        expect(Object.keys(pl)).not.toContain('priceFlag')
      }
    }
    // 附注含口径未定事实（AQ-AMB-03）
    expect((res.body.contextEcho.notes as string[]).some((n) => n.includes('口径未定'))).toBe(true)
  })

  it('订单未冻结 BOM → ok_no_records + 附注（不视为缺料为零，§3）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const res = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.material-shortage',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1002' } },
    })
    expect(res.body.status).toBe('ok_no_records')
    expect(res.body.message).toContain('未冻结 BOM')
    expect(res.body.data.lines).toEqual([])
  })
})

describe('⑤ AQ-C3 质量查询（两族并查 + 结论过滤 + 时间窗）', () => {
  const executeQuality = (session: string, params: Record<string, unknown>, toolCallSeq = 1) =>
    execute({
      requestId: randomUUID(),
      toolCallSeq,
      sessionId: session,
      capabilityId: 'aq.quality',
      capabilityVersion: 1,
      params: { timeRange: AQ_TEST_TIME_RANGE, ...params },
    })

  it('all：窗口内 3 条（2 检验单 + 1 批次）按业务时间倒序；判定/处置/隔离三者并排', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const res = await executeQuality(session, { objectScope: 'all' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok_with_data')
    expect(res.body.completeness.total).toBe(3)
    const inspections = res.body.data.inspectionOrders as Array<Record<string, unknown>>
    const batches = res.body.data.purchaseBatches as Array<Record<string, unknown>>
    expect(inspections).toHaveLength(2)
    expect(batches).toHaveLength(1)

    const unqualified = inspections.find((o) => o['orderNo'] === 'QIO-AQ-1')!
    // 生效结论=当前 is_effective 行（v2 不合格；v1 pending 不混作当前判定，S14）
    expect(unqualified['effectiveConclusion']).toMatchObject({ version: 2, conclusion: 'unqualified', resultKind: 're_inspection' })
    expect(unqualified['latestDisposition']).toMatchObject({ dispositionKind: 'concession', basedOnVersion: 2 })
    expect(unqualified['activeHold']).toMatchObject({ holdKind: 'unqualified' })
    expect(unqualified['statusLabel']).toBe('已出结论')

    const qualified = inspections.find((o) => o['orderNo'] === 'QIO-AQ-2')!
    expect(qualified['effectiveConclusion']).toMatchObject({ conclusion: 'qualified' })
    expect(qualified['latestDisposition']).toMatchObject({ dispositionKind: 'release' })
    expect(qualified['activeHold']).toBeNull()

    const batch = batches[0]!
    expect(batch['batchNo']).toBe('B-AQ-1')
    expect(batch['inspectionStatusLabel']).toBe('全部不合格')
    expect(batch['detailQualitySummary']).toEqual(
      expect.arrayContaining([
        { qualityStatus: 'unqualified', qualityStatusLabel: '不合格', count: 2 },
        { qualityStatus: 'qualified', qualityStatusLabel: '合格', count: 1 },
      ]),
    )
    // 时间窗：窗口外旧单/旧批次不进结果（QIO-AQ-OLD/B-AQ-OLD 排除）
    expect(JSON.stringify(res.body.data)).not.toContain('QIO-AQ-OLD')
    expect(JSON.stringify(res.body.data)).not.toContain('B-AQ-OLD')
  })

  it('conclusions/stages/objectScope 过滤与业务 SQL 对照', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const unqualifiedOnly = await executeQuality(session, { objectScope: 'all', conclusions: ['unqualified'] })
    expect(unqualifiedOnly.body.completeness.total).toBe(2) // QIO-AQ-1（生效不合格）+ B-AQ-1（all_unqualified）
    const qualifiedOnly = await executeQuality(session, { objectScope: 'all', conclusions: ['qualified'] })
    expect(qualifiedOnly.body.completeness.total).toBe(1)
    const processOnly = await executeQuality(session, { objectScope: 'inspection_order', inspectionStages: ['process'] })
    expect(processOnly.body.completeness.total).toBe(1)
    expect(processOnly.body.data.inspectionOrders[0].orderNo).toBe('QIO-AQ-1')
    const batchOnly = await executeQuality(session, { objectScope: 'purchase_batch' })
    expect(batchOnly.body.completeness.total).toBe(1)
    expect(batchOnly.body.data.inspectionOrders).toEqual([])

    // 与业务 SQL 对照（同条件计数：窗口内检验单恰为 2，与信封 total 一致）
    const sqlCount = (
      await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM quality_inspection_order
         WHERE business_time >= $1 AND business_time <= $2`,
        [AQ_TEST_TIME_RANGE.from, AQ_TEST_TIME_RANGE.to],
      )
    ).rows[0]!.count
    const allScope = await executeQuality(session, { objectScope: 'inspection_order' })
    expect(String(allScope.body.completeness.total)).toBe(sqlCount)
    expect(allScope.body.completeness.total).toBe(2)
  })
})

describe('⑥ 七状态机与权限重验（AQ-REG-07/AQ-AUTH-01/02/03）', () => {
  it('not_supported：未注册能力；已停用版本（AQ-REG-01/04）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const unknown = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.nonexistent',
      capabilityVersion: 1,
      params: {},
    })
    expect(unknown.body.status).toBe('not_supported')
    expect(unknown.body.message).toContain('AQ-REG-01')
    expect(unknown.body.data).toBeNull()

    // 注册一个 disabled v2 行 → execute v2 → not_supported（AQ-REG-04）
    await pool.query(
      `INSERT INTO ai_capability_registry (enterprise_id, capability_id, version, status, definition, remark, created_by)
       VALUES ((SELECT enterprise_id FROM org_node WHERE code = 'ENT-HD'), 'aq.order-progress', 2, 'disabled',
         '{"displayName":"订单进度查询","description":"v2 停用演示","inputSchema":{},"requiredPermissions":["aiquery.use"],"allowedObjects":[],"maxQueryRange":{},"caliberParams":{}}'::jsonb,
         'disabled 演示行', 'test')`,
    )
    const disabled = await execute({
      requestId: randomUUID(),
      toolCallSeq: 2,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 2,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } },
    })
    expect(disabled.body.status).toBe('not_supported')
    expect(disabled.body.message).toContain('AQ-REG-04')
  })

  it('source_not_ready：§8 未就绪问法族固定清单命中', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const res = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.purchase-overdue-impact',
      capabilityVersion: 1,
      params: {},
    })
    expect(res.body.status).toBe('source_not_ready')
    expect(res.body.message).toContain('数据源未就绪')
    expect(res.body.message).toContain('AQ-REG-01')
    expect(res.body.data).toBeNull()
  })

  it('no_permission：能力域读许可缺失（plantadmin 执行 C2）；plantId 越范围（AQ-AUTH-02/03）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(hfToken)
    const missingPerms = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.material-shortage',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-HF-1' } },
    })
    expect(missingPerms.body.status).toBe('no_permission')
    expect(missingPerms.body.message).toContain('AQ-AUTH-02')
    expect(missingPerms.body.message).toContain('inventory.read')

    const crossPlant = await execute({
      requestId: randomUUID(),
      toolCallSeq: 2,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' }, plantId: (await pool.query(`SELECT id FROM org_node WHERE code = 'PLNT-SZ'`)).rows[0]!.id },
    })
    expect(crossPlant.body.status).toBe('no_permission')
    expect(crossPlant.body.message).toContain('AQ-AUTH-03')
  })

  it('AQ-AUTH-01：撤权后下一次 execute 立即 no_permission（不信任会话快照）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const before = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } },
    })
    expect(before.body.status).toBe('ok_with_data')

    // 撤销 sysadmin 的 aiquery.use（角色授权行 array_remove）
    await pool.query(
      `UPDATE scope_grant SET permissions = array_remove(permissions, 'aiquery.use')
       WHERE principal_type = 'role' AND principal_id = (SELECT r.id FROM role r JOIN org_node e ON e.id = r.enterprise_id WHERE e.code = 'ENT-HD' AND r.alias = 'sysadmin')
         AND scope_type = 'enterprise'`,
    )
    const revoked = await execute({
      requestId: randomUUID(),
      toolCallSeq: 2,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } },
    })
    expect(revoked.body.status).toBe('no_permission')
    expect(revoked.body.message).toContain('AQ-AUTH-02')
    // 恢复授权（不污染后续用例）
    await pool.query(
      `UPDATE scope_grant SET permissions = array_append(permissions, 'aiquery.use')
       WHERE principal_type = 'role' AND principal_id = (SELECT r.id FROM role r JOIN org_node e ON e.id = r.enterprise_id WHERE e.code = 'ENT-HD' AND r.alias = 'sysadmin')
         AND scope_type = 'enterprise'`,
    )
    const restored = await execute({
      requestId: randomUUID(),
      toolCallSeq: 3,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } },
    })
    expect(restored.body.status).toBe('ok_with_data')
  })

  it('failed：orderRef 缺失（AQ-C1-1）与非法时间范围（AQ-C3-1）都带规则码', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const noRef = await execute({
      requestId: randomUUID(),
      toolCallSeq: 1,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: {},
    })
    expect(noRef.body.status).toBe('failed')
    expect(noRef.body.message).toContain('AQ-C1-1')

    const badRange = await execute({
      requestId: randomUUID(),
      toolCallSeq: 2,
      sessionId: session,
      capabilityId: 'aq.quality',
      capabilityVersion: 1,
      params: { timeRange: { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' } },
    })
    expect(badRange.body.status).toBe('failed')
    expect(badRange.body.message).toContain('AQ-C3-1')
    // DS-20：失败不得伪装成 ok_no_records（错误态与无记录态明确分立）
    expect(noRef.body.status).not.toBe('ok_no_records')
    expect(badRange.body.status).not.toBe('ok_no_records')
  })
})

describe('⑦ AQ-REG-06 上下文字段忽略 + AQ-S2/DS-22 幂等', () => {
  it('请求体携带 tenant/user/scope 与 params.enterpriseId → 忽略并记审计（contextEcho + ai_query_audit）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const requestId = randomUUID()
    const res = await execute({
      requestId,
      toolCallSeq: 7,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' }, enterpriseId: '00000000-0000-0000-0000-0000000000ee', tenantId: 'tenant-x' },
      tenantId: 'tenant-x',
      userId: '00000000-0000-0000-0000-0000000000ff',
      scope: 'enterprise',
      dataScope: { enterpriseWide: false, plantIds: [] },
    })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok_with_data')
    // 服务端绑定为准：enterpriseId/userId 仍是会话绑定值
    expect(res.body.contextEcho.enterpriseId).not.toBe('00000000-0000-0000-0000-0000000000ee')
    expect(res.body.contextEcho.userId).not.toBe('00000000-0000-0000-0000-0000000000ff')
    const ignored = res.body.contextEcho.ignoredRequestFields as string[]
    for (const key of ['tenantId', 'userId', 'scope', 'dataScope', 'enterpriseId']) {
      expect(ignored).toContain(key)
    }
    // 审计落库（AQ-S2）：脱敏载荷含 filters/ignoredRequestFields，不含聊天正文；model_info=unknown 字面
    const audit = (
      await pool.query<{ params: Record<string, unknown>; model_info: unknown; result_status: string; row_count: number; channel: string }>(
        `SELECT params, model_info, result_status, row_count, channel FROM ai_query_audit WHERE request_id = $1 AND tool_call_seq = 7`,
        [requestId],
      )
    ).rows[0]!
    expect(audit.result_status).toBe('ok_with_data')
    expect(audit.row_count).toBe(2)
    expect(audit.channel).toBe('web')
    expect(audit.model_info).toBe('unknown')
    expect((audit.params['ignoredRequestFields'] as string[]).length).toBeGreaterThanOrEqual(5)
    expect(audit.params['filters']).toMatchObject({ orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } })
  })

  it('DS-22/AQ-S2：同一 (requestId, toolCallSeq) 重放 → 同一审计行不重复落库，信封带幂等重放标注', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const session = await openSession(adminToken)
    const requestId = randomUUID()
    const body = {
      requestId,
      toolCallSeq: 3,
      sessionId: session,
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } },
    }
    const first = await execute(body)
    expect(first.body.status).toBe('ok_with_data')
    expect((first.body.contextEcho.notes as string[]).some((n) => n.includes('幂等重放'))).toBe(false)
    const replay = await execute(body)
    expect(replay.status).toBe(200)
    expect(replay.body.status).toBe('ok_with_data')
    expect((replay.body.contextEcho.notes as string[]).some((n) => n.includes('幂等重放'))).toBe(true)
    const count = (
      await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ai_query_audit WHERE request_id = $1 AND tool_call_seq = 3`, [requestId])
    ).rows[0]!.count
    expect(count).toBe('1')
    // UNIQUE (request_id, tool_call_seq) 库层双保险
    const uniqueIndexes = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'ai_query_audit' AND indexname = 'ai_query_audit_request_seq_unique'`,
    )
    expect(uniqueIndexes.rowCount).toBe(1)
  })
})
