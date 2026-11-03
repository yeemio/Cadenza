import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { createServer, type Server } from 'node:http'
import { validateEnv } from '../../apps/api/src/env'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { DbModule } from '../../apps/api/src/db/db.module'
import { AiQueryModule } from '../../apps/api/src/aiquery/aiquery.module'
import { buildAiQueryService } from '../../apps/api/src/aiquery/aiquery.composition'
import { AiRuntimeClient } from '../../apps/api/src/aiquery/aiquery.runtime-client'
import { ImModule } from '../../apps/api/src/aiquery/im/im.module'
import { buildImRealSeams } from '../../apps/api/src/aiquery/im/im.real-seams'
import { aqDatabaseUrl, prepareAqTestDatabase } from '../api/aiquery-test-env'
import {
  InMemoryImChannelEventCounters,
  InMemoryImIdentityBindingStore,
  InMemoryImProcessingRecordStore,
  MockChannelSender,
  MockImChannelAdapter,
} from '../../packages/integrations/im/src/index'

/**
 * P4 五内部接缝真实承载证据（2026-10-30；PM 增量单 2026-10-29 §4：内部集成，mock 外部
 * 渠道/模型下证明真实内部数据链）。本轮独占新库 cadenza_sol_p4_1031 + supertest 自组装
 * （AuthModule+DbModule+AiQueryModule+ImModule〔五接缝=im.real-seams 真实实现〕）+
 * 进程内 mock apps/ai（node:http；其工具调用**真实回打**接入层 /internal/aiquery/execute，
 * 形成 im 回调 → ai_session 落库 → DS-23 转发 → execute → 审计落库 → 发送 → 审计回写的
 * 完整内部链）。
 *
 * 五接缝证据：
 * - 接缝 1 查询会话落库：ai_session 行落库（SQL 读回）+ 同键复用 + 「重启」（重建 app/渠道
 *   内存态）后同键仍复用同一 sessionId；
 * - 接缝 2 发送审计：answer → ai_query_audit.sent_result_status='sent'（SQL 读回）；
 *   拒发 → 'not_sent'；
 * - 接缝 3 权限重验：撤 aiquery.use → 同一轮内 execute=no_permission 且发送前再检拒发；
 *   用户禁用 → 再检拒发（不是缓存许可）；恢复后同流程可发送；
 * - 接缝 4a 转发 apps/ai turns：转发形状（requestId/sessionId/userMessage/timeBasis/内部令牌）
 *   + 澄清续轮复用同一 requestId；apps/ai 不可达 → unavailable 降级不伪装成功；
 * - 接缝 5 网页签发绑定码：登录用户 POST 签发 → IM 凭码绑定 → 一次性（重用拒）→
 *   过期/撤销拒 → 单活动码（新签发撤旧码）；核销行落库（SQL 读回 used_channel/platform）。
 */

const INTERNAL_TOKEN = 'imseam-test-internal-token'
const RUNTIME_TOKEN = 'imseam-test-runtime-token'

interface MockRuntimeState {
  sessions: Array<Record<string, unknown>>
  turns: Array<{ body: Record<string, unknown>; authorization: string | undefined }>
}

/**
 * mock 模型编排开关（DS-13 脚本化）：direct（缺省）= 新轮即工具调用真实回打 execute 后作答；
 * clarifyFirst = 未见过的 requestId 首轮澄清、同 requestId 续轮作答（AQ-AMB-04）。
 */
let afterExecute: (() => Promise<void>) | null = null
let clarifyFirst = false
const seenRequestIds = new Set<string>()

async function mockTurnHandler(body: Record<string, unknown>, apiPort: number): Promise<Record<string, unknown>> {
  const requestId = body['requestId'] as string
  if (clarifyFirst && !seenRequestIds.has(requestId)) {
    seenRequestIds.add(requestId)
    return {
      outcome: 'clarify',
      message: '找到多张可能相关的生产订单，请确认要查询哪一张：',
      options: [
        { id: 'o1', label: 'ORDER-AQ-1001（苏州厂·进行中）' },
        { id: 'o2', label: 'ORDER-AQ-AMB-2（苏州厂·进行中）' },
      ],
      statusDetail: { status: 'clarify' },
    }
  }
  seenRequestIds.add(requestId)
  // 工具调用真实回打接入层 execute（AQ-C1 黄金订单 ORDER-AQ-1001 → 结构化信封）
  const executeResponse = await fetch(`http://127.0.0.1:${String(apiPort)}/internal/aiquery/execute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${INTERNAL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId,
      toolCallSeq: 1,
      sessionId: body['sessionId'],
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } },
    }),
  })
  const envelope = (await executeResponse.json()) as Record<string, unknown>
  if (afterExecute !== null) await afterExecute()
  return {
    outcome: 'answer',
    message: '生产订单 ORDER-AQ-1001 当前状态：进行中（数字与来源以结构化结果信封为准）。',
    answerRefs: [
      {
        capabilityId: 'aq.order-progress',
        capabilityVersion: 1,
        status: envelope['status'],
        completeness: envelope['completeness'],
        freshness: envelope['freshness'],
        auditRef: { requestId, toolCallSeq: 1 },
      },
    ],
    statusDetail: { status: 'ok', toolCallsUsed: 1 },
  }
}

/** 进程内 mock apps/ai：DS-23 三端点 + 工具调用真实回打接入层 execute（经真实 HTTP）。 */
function startMockRuntime(apiPort: number): Promise<{ server: Server; url: string; state: MockRuntimeState }> {
  const state: MockRuntimeState = { sessions: [], turns: [] }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {}
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
        void Promise.resolve(mockTurnHandler(body, apiPort)).then((payload) => send(200, payload))
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

interface EnvHarness {
  app: INestApplication
  port: number
  runtime: { server: Server; url: string; state: MockRuntimeState }
  sender: MockChannelSender
  bindings: InMemoryImIdentityBindingStore
  counters: InMemoryImChannelEventCounters
}

let pool: pg.Pool
let adminToken = ''
let adminUserId = ''
let h1: EnvHarness

async function buildEnv(): Promise<EnvHarness> {
  const sender = new MockChannelSender()
  const bindings = new InMemoryImIdentityBindingStore()
  const records = new InMemoryImProcessingRecordStore()
  const counters = new InMemoryImChannelEventCounters()
  const service = buildAiQueryService(pool)
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate: validateEnv }),
      DbModule,
      AuthModule,
      AiQueryModule,
      ImModule.register({
        adapters: [new MockImChannelAdapter()],
        sender,
        bindings,
        records,
        counters,
        seams: buildImRealSeams({ service, runtime: new AiRuntimeClient() }),
      }),
    ],
  }).compile()
  const app = moduleRef.createNestApplication()
  await app.listen(0, '127.0.0.1')
  const address = app.getHttpServer().address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const runtime = await startMockRuntime(port)
  process.env['AI_RUNTIME_URL'] = runtime.url
  process.env['AI_RUNTIME_INTERNAL_TOKEN'] = RUNTIME_TOKEN
  return { app, port, runtime, sender, bindings, counters }
}

async function closeEnv(h: EnvHarness): Promise<void> {
  await new Promise<void>((resolve) => {
    if (h.runtime.server.listening) h.runtime.server.close(() => resolve())
    else resolve()
  })
  await h.app.close()
}

async function restartMockRuntime(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (h1.runtime.server.listening) h1.runtime.server.close(() => resolve())
    else resolve()
  })
  const runtime = await startMockRuntime(h1.port)
  h1.runtime = runtime
  process.env['AI_RUNTIME_URL'] = runtime.url
}

async function login(loginName: string, password: string): Promise<string> {
  const res = await request(h1.app.getHttpServer()).post('/auth/login').send({ loginName, password, platform: 'WEB' })
  expect(res.status).toBe(200)
  return res.body.token as string
}

let msgSeq = 0

function mockTextPayload(input: { fromUser: string; text: string; chatId?: string }): Record<string, unknown> {
  msgSeq += 1
  return {
    app: 'app-imseam',
    fromUser: input.fromUser,
    msgId: `msg-${String(msgSeq)}`,
    chatType: 'single',
    chatId: input.chatId ?? 'chat-im-1',
    msgType: 'text',
    text: input.text,
  }
}

function mockBindingPayload(input: { fromUser: string; code: string }): Record<string, unknown> {
  msgSeq += 1
  return {
    app: 'app-imseam',
    fromUser: input.fromUser,
    msgId: `msg-${String(msgSeq)}`,
    chatType: 'single',
    chatId: 'chat-im-1',
    msgType: 'binding',
    verificationCode: input.code,
  }
}

async function imCallback(payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request(h1.app.getHttpServer()).post('/aiquery/im/channels/mock/callback').send(payload)
  return { status: res.status, body: res.body as Record<string, unknown> }
}

async function issueCode(): Promise<{ id: string; code: string; expiresAt: string }> {
  const res = await request(h1.app.getHttpServer())
    .post('/aiquery/im/binding-codes')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({})
  expect(res.status).toBe(201)
  return { id: res.body.id as string, code: res.body.code as string, expiresAt: res.body.expiresAt as string }
}

/** 管理员绑定到 mock 渠道平台身份（经真实一次性绑定码：签发→IM 凭码绑定）。 */
async function bindAdminPlatformUser(platformUserId: string): Promise<void> {
  const { code } = await issueCode()
  const result = await imCallback(mockBindingPayload({ fromUser: platformUserId, code }))
  expect(result.status).toBe(201)
  expect(result.body['outcome']).toBe('binding_ok')
}

beforeAll(async () => {
  pool = await prepareAqTestDatabase()
  process.env['DATABASE_URL'] = aqDatabaseUrl()
  process.env['AIQUERY_INTERNAL_TOKEN'] = INTERNAL_TOKEN
  h1 = await buildEnv()
  adminToken = await login('admin', 'CadAdmin001')
  const row = await pool.query<{ id: string }>(`SELECT id FROM user_account WHERE login_name = 'admin'`)
  adminUserId = row.rows[0]!.id
})

afterAll(async () => {
  if (h1) await closeEnv(h1)
  if (pool) await pool.end()
})



/** sysadmin 角色 enterprise grant 移除/恢复 aiquery.use（接缝 2/3 撤权向量）。 */
async function setAdminAiQueryUse(enabled: boolean): Promise<void> {
  const principal = `(SELECT r.id FROM role r WHERE r.alias = 'sysadmin' AND r.enterprise_id = (SELECT id FROM org_node WHERE code = 'ENT-HD'))`
  if (enabled) {
    await pool.query(
      `UPDATE scope_grant SET permissions = array_append(permissions, 'aiquery.use')
       WHERE principal_id = ${principal} AND scope_type = 'enterprise' AND NOT ('aiquery.use' = ANY(permissions))`,
    )
  } else {
    await pool.query(
      `UPDATE scope_grant SET permissions = array_remove(permissions, 'aiquery.use')
       WHERE principal_id = ${principal} AND scope_type = 'enterprise'`,
    )
  }
}

async function setUserDisabled(disabled: boolean): Promise<void> {
  // 0002 值域：account_status IN ('enabled','disabled')
  await pool.query(`UPDATE user_account SET account_status = $1 WHERE id = $2`, [
    disabled ? 'disabled' : 'enabled',
    adminUserId,
  ])
}

// ---------------------------------------------------------------------------
// 接缝 1：查询会话落库（ai_session 行 + 同键复用 + 重启后复用）
// ---------------------------------------------------------------------------

describe('接缝 1 查询会话落库：ai_session 行落库、同键复用、「重启」后仍复用', () => {
  it('绑定→提问→澄清→续问→回答：ai_session 恰一行（user/渠道/会话目标），两轮转发携带同一 sessionId', async () => {
    await bindAdminPlatformUser('u-imseam-1')
    clarifyFirst = true
    try {
      const first = await imCallback(mockTextPayload({ fromUser: 'u-imseam-1', text: '查一下 ORDER-AQ-1001 的进度' }))
      expect(first.status).toBe(201)
      expect(first.body['outcome']).toBe('clarify')
      const second = await imCallback(mockTextPayload({ fromUser: 'u-imseam-1', text: '第一张' }))
      expect(second.status).toBe(201)
      expect(second.body['outcome']).toBe('answer')
    } finally {
      clarifyFirst = false
    }

    const rows = await pool.query(
      `SELECT id, enterprise_id, user_id, channel, conversation_ref, status FROM ai_session
       WHERE user_id = $1 AND channel = 'mock' AND conversation_ref = 'chat-im-1'`,
      [adminUserId],
    )
    expect(rows.rowCount).toBe(1)
    const session = rows.rows[0]!
    expect(session.enterprise_id).toBeTruthy()
    expect(session.status).toBe('open')
    const turnBodies = h1.runtime.state.turns.map((t) => t.body)
    expect(turnBodies.length).toBe(2)
    expect(turnBodies.every((b) => b['sessionId'] === session.id)).toBe(true)
  })

  it('「重启」（重建 app+渠道内存态）后：同键再问不新建 ai_session 行，仍复用同一 sessionId', async () => {
    const before = await pool.query<{ id: string }>(
      `SELECT id FROM ai_session WHERE user_id = $1 AND channel = 'mock' AND conversation_ref = 'chat-im-1'`,
      [adminUserId],
    )
    expect(before.rowCount).toBe(1)
    const sessionIdBefore = before.rows[0]!.id

    await closeEnv(h1)
    h1 = await buildEnv()
    adminToken = await login('admin', 'CadAdmin001')

    // 渠道绑定存储为进程内存（IM-05 登记行为）：重启后重新经真实一次性绑定码绑定
    await bindAdminPlatformUser('u-imseam-1')
    clarifyFirst = true
    try {
      const result = await imCallback(mockTextPayload({ fromUser: 'u-imseam-1', text: '再问一次' }))
      expect(result.status).toBe(201)
      expect(result.body['outcome']).toBe('clarify')
    } finally {
      clarifyFirst = false
    }

    const after = await pool.query<{ id: string }>(
      `SELECT id FROM ai_session WHERE user_id = $1 AND channel = 'mock' AND conversation_ref = 'chat-im-1'`,
      [adminUserId],
    )
    expect(after.rowCount).toBe(1)
    expect(after.rows[0]!.id).toBe(sessionIdBefore)
    expect((h1.runtime.state.turns[0]!.body as Record<string, unknown>)['sessionId']).toBe(sessionIdBefore)
  })
})

// ---------------------------------------------------------------------------
// 接缝 4a：转发 apps/ai turns（真实 DS-23 HTTP 转发形状 + 澄清续轮 + 不可达降级）
// ---------------------------------------------------------------------------

describe('接缝 4a 转发 apps/ai turns：DS-23 形状、澄清续轮同 requestId、不可达降级', () => {
  it('转发载荷：requestId(UUID)/sessionId/userMessage/timeBasis(Asia/Shanghai) + 内部服务令牌；澄清续轮复用同一 requestId', async () => {
    // 清理上一用例遗留的澄清挂起（direct 模式一轮 answer 即消费挂起 requestId）
    await imCallback(mockTextPayload({ fromUser: 'u-imseam-1', text: '清理挂起' }))
    const turnsBefore = h1.runtime.state.turns.length
    clarifyFirst = true
    try {
      await imCallback(mockTextPayload({ fromUser: 'u-imseam-1', text: 'ORDER-AQ-1001 做到哪一步' }))
      await imCallback(mockTextPayload({ fromUser: 'u-imseam-1', text: '就第一张' }))
    } finally {
      clarifyFirst = false
    }
    const turns = h1.runtime.state.turns.slice(turnsBefore)
    expect(turns.length).toBe(2)
    for (const turn of turns) {
      expect(turn.authorization).toBe(`Bearer ${RUNTIME_TOKEN}`)
      expect(typeof turn.body['requestId']).toBe('string')
      expect(turn.body['requestId'] as string).toMatch(/^[0-9a-fA-F-]{36}$/)
      expect(turn.body['timeBasis']).toEqual({ timeZone: 'Asia/Shanghai' })
    }
    expect(turns[0]!.body['requestId']).toBe(turns[1]!.body['requestId'])
    expect(turns[0]!.body['userMessage']).toBe('ORDER-AQ-1001 做到哪一步')
  })

  it('apps/ai 不可达 → unavailable 降级提示照发、不伪装成功（AR-12/AR-11）', async () => {
    await new Promise<void>((resolve) => h1.runtime.server.close(() => resolve()))
    const result = await imCallback(mockTextPayload({ fromUser: 'u-imseam-1', text: 'AI 挂了吗' }))
    expect(result.status).toBe(201)
    expect(result.body['outcome']).toBe('unavailable')
    const sent = h1.sender.captured[h1.sender.captured.length - 1]!
    expect(sent.content.kind).toBe('notice')
    expect(sent.content.status).toBe('unavailable')
    expect(sent.content.text).toContain('暂不可用')
    await restartMockRuntime()
  })
})

// ---------------------------------------------------------------------------
// 接缝 2 + 接缝 3：发送审计 + 发送前权限重验（撤权/禁用 → 工具调用与交付都执行新检查）
// ---------------------------------------------------------------------------

describe('接缝 2 发送审计 + 接缝 3 权限重验：审计行 SQL 读回；撤权/禁用 → not_sent', () => {
  it('answer 交付 → ai_query_audit 该 requestId 全部行 sent_result_status=sent（SQL 读回）', async () => {
    const turnsBefore = h1.runtime.state.turns.length
    const result = await imCallback(mockTextPayload({ fromUser: 'u-imseam-1', text: '继续查 ORDER-AQ-1001' }))
    expect(result.body['outcome']).toBe('answer')
    const requestId = h1.runtime.state.turns[turnsBefore]!.body['requestId'] as string

    const auditRows = await pool.query(
      `SELECT result_status, sent_result_status, row_count FROM ai_query_audit WHERE request_id = $1::uuid`,
      [requestId],
    )
    expect(auditRows.rowCount).toBeGreaterThanOrEqual(1)
    for (const row of auditRows.rows) {
      expect(row.result_status).toBe('ok_with_data')
      expect(row.sent_result_status).toBe('sent')
    }
    expect(auditRows.rows[0]!.row_count).toBeGreaterThan(0)
  })

  for (const change of ['business_permission', 'plant_scope'] as const) {
    it(`工具成功后保留 aiquery.use、变更 ${change}：旧结果拒发且审计 not_sent`, async () => {
      const grant = await pool.query<{ id: string; permissions: string[]; scope_type: string; scope_object_id: string }>(
        `SELECT id, permissions, scope_type, scope_object_id FROM scope_grant
         WHERE principal_id = (SELECT id FROM role WHERE alias = 'sysadmin' AND enterprise_id = (SELECT id FROM org_node WHERE code = 'ENT-HD'))
           AND scope_type = 'enterprise'`,
      )
      expect(grant.rowCount).toBe(1)
      const original = grant.rows[0]!
      const turnsBefore = h1.runtime.state.turns.length
      const sentBefore = h1.sender.captured.length
      afterExecute = async () => {
        if (change === 'business_permission') {
          await pool.query(`UPDATE scope_grant SET permissions = array_remove(permissions, 'process.read') WHERE id = $1`, [original.id])
        } else {
          await pool.query(`UPDATE scope_grant SET scope_type = 'plant', scope_object_id = (SELECT id FROM org_node WHERE code = 'PLNT-HF') WHERE id = $1`, [original.id])
        }
      }
      try {
        const result = await imCallback(mockTextPayload({ fromUser: 'u-imseam-1', text: '生成成功后再撤权' }))
        expect(result.body['outcome']).toBe('answer')
        const requestId = h1.runtime.state.turns[turnsBefore]!.body['requestId'] as string
        const audit = await pool.query(`SELECT result_status, sent_result_status, params FROM ai_query_audit WHERE request_id = $1::uuid`, [requestId])
        expect(audit.rowCount).toBe(1)
        expect(audit.rows[0]!.result_status).toBe('ok_with_data')
        expect(audit.rows[0]!.sent_result_status).toBe('not_sent')
        expect(audit.rows[0]!.params.deliveryScope.enterpriseWide).toBe(true)
        expect(audit.rows[0]!.params.deliveryScope.plantIds).toHaveLength(2)
        expect(h1.sender.captured.length).toBe(sentBefore)
        const current = await pool.query<{ permissions: string[] }>('SELECT permissions FROM scope_grant WHERE id = $1', [original.id])
        expect(current.rows[0]!.permissions).toContain('aiquery.use')
      } finally {
        afterExecute = null
        await pool.query(`UPDATE scope_grant SET permissions = $2, scope_type = $3, scope_object_id = $4 WHERE id = $1`, [original.id, original.permissions, original.scope_type, original.scope_object_id])
      }
    })
  }

  it('撤 aiquery.use 后同一轮：execute=no_permission（工具调用重验）且发送前再检拒发 → 审计 not_sent、无出站（IM-13/IM-08）', async () => {
    await setAdminAiQueryUse(false)
    try {
      const turnsBefore = h1.runtime.state.turns.length
      const sentBefore = h1.sender.captured.length
      const result = await imCallback(mockTextPayload({ fromUser: 'u-imseam-1', text: '撤权后再问' }))
      // mock 模型照常作答（脚本化），但接入层两道新检查都生效：execute no_permission + 发送拒发
      expect(result.body['outcome']).toBe('answer')
      const requestId = h1.runtime.state.turns[turnsBefore]!.body['requestId'] as string
      const auditRows = await pool.query(
        `SELECT result_status, sent_result_status FROM ai_query_audit WHERE request_id = $1::uuid`,
        [requestId],
      )
      expect(auditRows.rowCount).toBe(1)
      expect(auditRows.rows[0]!.result_status).toBe('no_permission')
      expect(auditRows.rows[0]!.sent_result_status).toBe('not_sent')
      expect(h1.sender.captured.length).toBe(sentBefore) // 拒发：不发送任何内容
      expect(h1.counters.snapshot()['not_sent']).toBeGreaterThanOrEqual(1)
    } finally {
      await setAdminAiQueryUse(true)
    }
  })

  it('用户禁用（非缓存许可向量）→ 再检拒发 not_sent；恢复后同链路可发送并回写 sent', async () => {
    await setUserDisabled(true)
    try {
      const turnsBefore = h1.runtime.state.turns.length
      await imCallback(mockTextPayload({ fromUser: 'u-imseam-1', text: '禁用状态问数' }))
      const requestId = h1.runtime.state.turns[turnsBefore]!.body['requestId'] as string
      const auditRows = await pool.query(
        `SELECT result_status, sent_result_status FROM ai_query_audit WHERE request_id = $1::uuid`,
        [requestId],
      )
      expect(auditRows.rowCount).toBe(1)
      expect(auditRows.rows[0]!.result_status).toBe('no_permission')
      expect(auditRows.rows[0]!.sent_result_status).toBe('not_sent')
    } finally {
      await setUserDisabled(false)
    }
    const turnsBefore = h1.runtime.state.turns.length
    const result = await imCallback(mockTextPayload({ fromUser: 'u-imseam-1', text: '恢复后再问' }))
    expect(result.body['outcome']).toBe('answer')
    const requestId = h1.runtime.state.turns[turnsBefore]!.body['requestId'] as string
    const auditRows = await pool.query(
      `SELECT sent_result_status FROM ai_query_audit WHERE request_id = $1::uuid`,
      [requestId],
    )
    expect(auditRows.rows[0]!.sent_result_status).toBe('sent')
  })
})

// ---------------------------------------------------------------------------
// 接缝 5：网页签发绑定码（一次性 / 有效期 / 撤销 / 单活动码）
// ---------------------------------------------------------------------------

describe('接缝 5 网页签发绑定码：签发→IM 绑定→一次性重用拒；过期/撤销拒；单活动码', () => {
  it('登录用户签发 → IM 凭码绑定成功且核销行落库；同码重发 → binding_rejected（一次性）', async () => {
    const issued = await issueCode()
    expect(issued.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)

    const ok = await imCallback(mockBindingPayload({ fromUser: 'u-imseam-5a', code: issued.code }))
    expect(ok.body['outcome']).toBe('binding_ok')
    // 绑定生效：可进入问数流（会话落库 → 真实转发 → 回答）
    const ask = await imCallback(mockTextPayload({ fromUser: 'u-imseam-5a', text: '问一句' }))
    expect(ask.body['outcome']).toBe('answer')

    const reuse = await imCallback(mockBindingPayload({ fromUser: 'u-imseam-5b', code: issued.code }))
    expect(reuse.body['outcome']).toBe('binding_rejected')

    const row = await pool.query<{ status: string; used_channel: string | null; used_platform_user_id: string | null }>(
      `SELECT status, used_channel, used_platform_user_id FROM ai_im_binding_code WHERE id = $1::uuid`,
      [issued.id],
    )
    expect(row.rows[0]!.status).toBe('used')
    expect(row.rows[0]!.used_channel).toBe('mock')
    expect(row.rows[0]!.used_platform_user_id).toBe('u-imseam-5a')
  })

  it('过期码与已撤销码均拒；新签发自动撤销旧 issued 码（单活动码）；清单不回显明文码；匿名签发 401', async () => {
    // 过期：签发后把有效期改到过去（SQL 直改时间列＝时间推进的最小等价）
    const expiring = await issueCode()
    await pool.query(`UPDATE ai_im_binding_code SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid`, [expiring.id])
    const expiredTry = await imCallback(mockBindingPayload({ fromUser: 'u-imseam-5c', code: expiring.code }))
    expect(expiredTry.body['outcome']).toBe('binding_rejected')

    // 撤销：显式 revoke 端点（须属当前用户）
    const toRevoke = await issueCode()
    const revokeRes = await request(h1.app.getHttpServer())
      .post(`/aiquery/im/binding-codes/${encodeURIComponent(toRevoke.id)}/revoke`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(revokeRes.status).toBe(200)
    expect(revokeRes.body['status']).toBe('revoked')
    const revokedTry = await imCallback(mockBindingPayload({ fromUser: 'u-imseam-5d', code: toRevoke.code }))
    expect(revokedTry.body['outcome']).toBe('binding_rejected')

    // 单活动码：新签发自动撤销旧 issued 码
    const first = await issueCode()
    const second = await issueCode()
    const firstRow = await pool.query<{ status: string }>(`SELECT status FROM ai_im_binding_code WHERE id = $1::uuid`, [first.id])
    expect(firstRow.rows[0]!.status).toBe('revoked')
    const secondTry = await imCallback(mockBindingPayload({ fromUser: 'u-imseam-5e', code: second.code }))
    expect(secondTry.body['outcome']).toBe('binding_ok')

    // 清单：状态可见、无明文码字段
    const listRes = await request(h1.app.getHttpServer())
      .get('/aiquery/im/binding-codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send()
    expect(listRes.status).toBe(200)
    expect((listRes.body['items'] as unknown[]).length).toBeGreaterThanOrEqual(2)
    for (const item of listRes.body['items'] as Array<Record<string, unknown>>) {
      expect(item['code']).toBeUndefined()
      expect(item['codeHash']).toBeUndefined()
    }

    // 未登录签发 → 401（OA 会话守卫；绑定码入口须登录用户）
    const anon = await request(h1.app.getHttpServer()).post('/aiquery/im/binding-codes').send({})
    expect(anon.status).toBe(401)
  })
})
