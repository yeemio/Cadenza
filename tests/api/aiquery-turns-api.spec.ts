import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { validateEnv } from '../../apps/api/src/env'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { DbModule } from '../../apps/api/src/db/db.module'
import { AiQueryModule } from '../../apps/api/src/aiquery/aiquery.module'
import { AQ_TEST_DB_NAME, prepareAqTestDatabase, aqDatabaseUrl } from './aiquery-test-env'

/**
 * aiquery 用户面问数轮 API 集成（P4-A 补充任务；真容器独立库 cadenza_query + supertest
 * 自组装挂载 + **进程内 mock apps/ai**（node:http 实现 DS-23 四端点冻结形状，不依赖真实
 * B 线进程））。用户面 wire 形状以 packages/ui/src/api/p4/types.ts 冻结面断言。
 *
 * 证据覆盖（DS-23/DS-24/AR-11/AR-12/AQ-AMB-04/DS-11）：
 * - 健康代理：ok 透传 / 不可达 → 明确 unavailable/unreachable 形状（非 5xx 裸抛）；
 * - 会话登记后向 apps/ai 同步登记（DS-23 sessions）；
 * - askTurn answer：转发形状（timeBasis Asia/Shanghai + 内部令牌）+ answerRefs→信封取回组装；
 * - askTurn clarify：选项透传 + 澄清答复轮本地解析（同一 requestId 延续，AQ-AMB-04；
 *   confirm 精确参数经本线 execute 重执行，审计链 seq=max+1，选项消费后失效）；
 * - askTurn unavailable：B 侧 over_limit 透传 / B 不可达 → unreachable；
 * - cancel：归属校验（他人轮次 403）/未知轮 unknown_request（不达 B）/转发 decision 透传。
 */

const INTERNAL_TOKEN = 'aq-test-internal-token'
const RUNTIME_TOKEN = 'aq-test-runtime-token'

interface MockRuntimeState {
  sessions: Array<Record<string, unknown>>
  turns: Array<{ body: Record<string, unknown>; authorization: string | undefined }>
  cancels: string[]
}

function startMockRuntime(onTurn: (body: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<{ server: Server; url: string; state: MockRuntimeState }> {
  const state: MockRuntimeState = { sessions: [], turns: [], cancels: [] }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>) : {}
      const authorization = req.headers['authorization']
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(payload))
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && url === '/ai-runtime/health') {
        send(200, { status: 'ok', runtime: { kind: 'mock', version: 'mock-1', profileRef: null } })
        return
      }
      if (authorization !== `Bearer ${RUNTIME_TOKEN}`) {
        send(401, { code: 'ERR_AI_RUNTIME_UNAUTHORIZED', message: '缺少或错误的内部服务令牌' })
        return
      }
      if (req.method === 'POST' && url === '/ai-runtime/sessions') {
        state.sessions.push(body)
        send(201, { sessionId: body['sessionId'], status: 'open' })
        return
      }
      if (req.method === 'POST' && url === '/ai-runtime/turns') {
        state.turns.push({ body, authorization: authorization as string })
        void Promise.resolve(onTurn(body)).then((payload) => send(200, payload))
        return
      }
      const cancelMatch = /^\/ai-runtime\/turns\/([^/]+)\/cancel$/.exec(url)
      if (req.method === 'POST' && cancelMatch !== null) {
        state.cancels.push(cancelMatch[1] as string)
        send(200, { status: 'cancelled', decision: 'cancelled_in_flight' })
        return
      }
      send(404, { code: 'ERR_NOT_FOUND', message: `无此路由：${String(req.method)} ${url}` })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${String(port)}`, state })
    })
  })
}

let app: INestApplication
let pool: pg.Pool
let mockRuntime: { server: Server; url: string; state: MockRuntimeState }
let onTurn: (body: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
let dbAvailable = true
let adminToken = ''
let hfToken = ''

beforeAll(async () => {
  try {
    pool = await prepareAqTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP aiquery turns api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${AQ_TEST_DB_NAME}）。`)
    return
  }
  onTurn = () => ({ outcome: 'answer', statusDetail: { status: 'ok' } })
  const started = await startMockRuntime((body) => onTurn(body))
  mockRuntime = started
  process.env['DATABASE_URL'] = aqDatabaseUrl()
  process.env['AIQUERY_INTERNAL_TOKEN'] = INTERNAL_TOKEN
  process.env['AI_RUNTIME_URL'] = mockRuntime.url
  process.env['AI_RUNTIME_INTERNAL_TOKEN'] = RUNTIME_TOKEN
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
  if (mockRuntime) await new Promise<void>((resolve) => mockRuntime.server.close(() => resolve()))
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
  return res.body.sessionId as string
}

/** 模拟 B 线工具调用穿透接入层 execute（信封登记进轮次上下文）。 */
async function bSideExecute(requestId: string, toolCallSeq: number, sessionId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await request(app.getHttpServer())
    .post('/internal/aiquery/execute')
    .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
    .send({ requestId, toolCallSeq, sessionId, capabilityId: 'aq.order-progress', capabilityVersion: 1, params })
  expect(res.status).toBe(200)
  return res.body as Record<string, unknown>
}

function askTurn(token: string, body: Record<string, unknown>) {
  return request(app.getHttpServer()).post('/aiquery/turns').set('Authorization', `Bearer ${token}`).send(body)
}

describe('① 健康代理（AR-03/AR-11：终端不直连；不可达=明确 unavailable 形状）', () => {
  it('apps/ai 可达 → ok+runtime 透传；不可达 → unavailable/unreachable（非 5xx 裸抛）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const ok = await request(app.getHttpServer()).get('/aiquery/health')
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ status: 'ok', runtime: { kind: 'mock', version: 'mock-1', profileRef: null } })

    const savedUrl = process.env['AI_RUNTIME_URL']
    process.env['AI_RUNTIME_URL'] = 'http://127.0.0.1:9' // 不可达端口
    try {
      const down = await request(app.getHttpServer()).get('/aiquery/health')
      expect(down.status).toBe(200)
      expect(down.body.status).toBe('unavailable')
      expect(down.body.reason).toBe('unreachable')
      expect(down.body.message).toContain('AR-11')
    } finally {
      process.env['AI_RUNTIME_URL'] = savedUrl
    }
    const restored = await request(app.getHttpServer()).get('/aiquery/health')
    expect(restored.body.status).toBe('ok')
  })
})

describe('② 问数轮 answer（DS-23 转发形状 + answerRefs→信封取回）', () => {
  it('会话登记同步 apps/ai；转发带 timeBasis/内部令牌；answer 组装完整六段信封', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const sessionId = await openSession(adminToken)
    // DS-23：建 ai_session 后同步登记（best-effort）——等待异步登记落位
    await new Promise((r) => setTimeout(r, 150))
    expect(mockRuntime.state.sessions).toHaveLength(1)
    expect(mockRuntime.state.sessions[0]).toMatchObject({ sessionId, channel: 'web' })
    expect(mockRuntime.state.sessions[0]).toHaveProperty('enterpriseId')
    expect(mockRuntime.state.sessions[0]).toHaveProperty('userId')

    const requestId = randomUUID()
    const envelope = await bSideExecute(requestId, 1, sessionId, { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } })
    expect(envelope['status']).toBe('ok_with_data')

    onTurn = (body) => {
      expect(body['requestId']).toBe(requestId)
      expect(body['sessionId']).toBe(sessionId)
      expect(body['timeBasis']).toEqual({ timeZone: 'Asia/Shanghai' })
      return {
        outcome: 'answer',
        message: '该订单进度如下（本段为 AI 解释、非事实）。',
        answerRefs: [
          {
            capabilityId: 'aq.order-progress',
            capabilityVersion: 1,
            status: 'ok_with_data',
            completeness: envelope['completeness'],
            freshness: envelope['freshness'],
            auditRef: { requestId, toolCallSeq: 1 },
          },
        ],
        statusDetail: { status: 'ok', toolCallsUsed: 1 },
      }
    }
    const res = await askTurn(adminToken, { requestId, sessionId, userMessage: 'ORDER-AQ-1001 进度如何' })
    expect(res.status).toBe(200)
    expect(res.body.requestId).toBe(requestId)
    expect(res.body.outcome).toBe('answer')
    expect(res.body.message).toContain('AI 解释、非事实')
    expect(res.body.envelope.status).toBe('ok_with_data')
    expect(res.body.envelope.data.order.orderNo).toBe('ORDER-AQ-1001')
    expect(res.body.envelope.auditRef).toEqual({ requestId, toolCallSeq: 1 })
    expect(res.body.options).toBeNull()
    expect(res.body.unavailableReason).toBeNull()
    expect(res.body.statusDetail).toMatchObject({ status: 'ok', toolCallsUsed: 1 })
    // 转发认证：mock 侧收到的 Authorization 为内部服务令牌（Bearer 运行时令牌）
    expect(mockRuntime.state.turns[0]!.authorization).toBe(`Bearer ${RUNTIME_TOKEN}`)
  })
})

describe('③ 问数轮 clarify + 澄清答复轮（AQ-AMB-01/04：同一 requestId 延续）', () => {
  it('clarify 选项透传 → 用户选择后接入层本地解析精确重发（seq=max+1，审计两行，选项消费后失效）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const sessionId = await openSession(adminToken)
    const requestId = randomUUID()
    // B 线工具调用（模糊单号 → 多候选信封）
    const ambiguous = await bSideExecute(requestId, 1, sessionId, { orderRef: { kind: 'orderNoLike', value: 'ORDER-AQ-AMB' } })
    expect(ambiguous['status']).toBe('ok_with_data')

    onTurn = () => ({
      outcome: 'clarify',
      message: '单号命中多个订单，请确认具体订单',
      options: [
        {
          id: 'opt-amb-1',
          label: 'ORDER-AQ-AMB-1',
          detail: { orderNo: 'ORDER-AQ-AMB-1', orderStatus: 'released' },
          confirm: { capabilityId: 'aq.order-progress', params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-AMB-1' } } },
        },
        {
          id: 'opt-amb-2',
          label: 'ORDER-AQ-AMB-2',
          detail: { orderNo: 'ORDER-AQ-AMB-2', orderStatus: 'in_progress' },
          confirm: { capabilityId: 'aq.order-progress', params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-AMB-2' } } },
        },
      ],
      statusDetail: { status: 'clarify' },
    })
    const clarify = await askTurn(adminToken, { requestId, sessionId, userMessage: 'ORDER-AQ-AMB 的进度' })
    expect(clarify.status).toBe(200)
    expect(clarify.body.outcome).toBe('clarify')
    expect(clarify.body.envelope).toBeNull()
    expect(clarify.body.options).toHaveLength(2)
    expect(clarify.body.options[0]).toMatchObject({ id: 'opt-amb-1', label: 'ORDER-AQ-AMB-1' })
    expect(clarify.body.options[0].confirm).toEqual({
      capabilityId: 'aq.order-progress',
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-AMB-1' } },
    })

    // 澄清答复轮：同一 requestId、userMessage 空、clarifyOptionId 承载选择（不转发 apps/ai）
    const turnsBefore = mockRuntime.state.turns.length
    const confirm = await askTurn(adminToken, { requestId, sessionId, userMessage: '', clarifyOptionId: 'opt-amb-1' })
    expect(confirm.status).toBe(200)
    expect(confirm.body.outcome).toBe('answer')
    expect(confirm.body.envelope.data.order.orderNo).toBe('ORDER-AQ-AMB-1')
    expect(confirm.body.statusDetail).toMatchObject({ resolvedBy: 'clarify_confirm', toolCallSeq: 2 })
    expect(mockRuntime.state.turns.length).toBe(turnsBefore) // 澄清确认不达 B（A 线不调用模型，AR-01）
    // AQ-AMB-04/AR-15：同一 requestId 审计链延续（seq 1+2 两行）
    const auditCount = (
      await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ai_query_audit WHERE request_id = $1`, [requestId])
    ).rows[0]!.count
    expect(auditCount).toBe('2')

    // 选项消费后失效（防重放）
    const replayOption = await askTurn(adminToken, { requestId, sessionId, userMessage: '', clarifyOptionId: 'opt-amb-1' })
    expect(replayOption.status).toBe(422)
    expect(replayOption.body.message).toContain('澄清选项不存在或已过期')
  })
})

describe('④ 问数轮 unavailable（DS-24 三类原因透传）', () => {
  it('B 侧 over_limit → unavailableReason=over_limit；B 不可达 → unreachable', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const sessionId = await openSession(adminToken)
    onTurn = () => ({ outcome: 'unavailable', message: '已超出 AI 问数使用限额', statusDetail: { status: 'over_limit', which: 'daily' } })
    const overLimit = await askTurn(adminToken, { requestId: randomUUID(), sessionId, userMessage: '问点啥' })
    expect(overLimit.status).toBe(200)
    expect(overLimit.body.outcome).toBe('unavailable')
    expect(overLimit.body.unavailableReason).toBe('over_limit')
    expect(overLimit.body.message).toContain('限额')

    const savedUrl = process.env['AI_RUNTIME_URL']
    process.env['AI_RUNTIME_URL'] = 'http://127.0.0.1:9'
    try {
      const unreachable = await askTurn(adminToken, { requestId: randomUUID(), sessionId, userMessage: '问点啥' })
      expect(unreachable.status).toBe(200)
      expect(unreachable.body.outcome).toBe('unavailable')
      expect(unreachable.body.unavailableReason).toBe('unreachable')
      expect(unreachable.body.message).toContain('AR-11')
    } finally {
      process.env['AI_RUNTIME_URL'] = savedUrl
    }
  })
})

describe('⑤ 取消与归属（DS-11 + 可信身份）', () => {
  it('未知轮 → unknown_request（不达 B）；他人轮次 → 403；本人轮 → 转发 decision 透传', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const cancelsBefore = mockRuntime.state.cancels.length
    const unknown = await request(app.getHttpServer())
      .post(`/aiquery/turns/${randomUUID()}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(unknown.status).toBe(200)
    expect(unknown.body).toEqual({ status: 'cancelled', decision: 'unknown_request' })
    expect(mockRuntime.state.cancels.length).toBe(cancelsBefore) // 未达 B

    // 受理一轮（admin）后取消：归属校验 + 转发
    const sessionId = await openSession(adminToken)
    const requestId = randomUUID()
    onTurn = () => ({ outcome: 'answer', message: '已回答', statusDetail: { status: 'ok' } })
    const turn = await askTurn(adminToken, { requestId, sessionId, userMessage: 'ORDER-AQ-1001 进度' })
    expect(turn.body.outcome).toBe('answer')

    const foreign = await request(app.getHttpServer())
      .post(`/aiquery/turns/${requestId}/cancel`)
      .set('Authorization', `Bearer ${hfToken}`)
      .send({})
    expect(foreign.status).toBe(403)
    expect(foreign.body.code).toBe('ERR_FORBIDDEN_SCOPE')

    const own = await request(app.getHttpServer())
      .post(`/aiquery/turns/${requestId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(own.status).toBe(200)
    expect(own.body.status).toBe('cancelled')
    expect(own.body.decision).toBe('cancelled_in_flight')
    expect(mockRuntime.state.cancels).toContain(requestId)
  })

  it('轮次端点归属：他人会话 → 403；会话不存在 → 404 ERR_AI_SESSION_NOT_FOUND；无 aiquery.use → 403', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const adminSession = await openSession(adminToken)
    const foreign = await askTurn(hfToken, { requestId: randomUUID(), sessionId: adminSession, userMessage: '问点啥' })
    expect(foreign.status).toBe(403)
    const notFound = await askTurn(adminToken, { requestId: randomUUID(), sessionId: randomUUID(), userMessage: '问点啥' })
    expect(notFound.status).toBe(404)
    expect(notFound.body.code).toBe('ERR_AI_SESSION_NOT_FOUND')
    // szqc01 无 aiquery.use → 会话登记与轮次均 403（OA-23 第一层）
    const qcToken = await login('szqc01', 'SzQuality01')
    const qcTurn = await askTurn(qcToken, { requestId: randomUUID(), sessionId: adminSession, userMessage: '问点啥' })
    expect(qcTurn.status).toBe(403)
    // 参数校验：userMessage 与 clarifyOptionId 至少一项
    const badBody = await askTurn(adminToken, { requestId: randomUUID(), sessionId: adminSession, userMessage: '' })
    expect(badBody.status).toBe(422)
  })
})
