import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateEnv } from '../../apps/api/src/env'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { DbModule } from '../../apps/api/src/db/db.module'
import { AiQueryModule } from '../../apps/api/src/aiquery/aiquery.module'
import { aqDatabaseUrl, prepareAqTestDatabase } from '../api/aiquery-test-env'
import { spawnAiRuntime, type SpawnedAiRuntime } from './ai-runtime-spawn'
import { SAMPLE_CAPABILITIES_RESPONSE } from './envelope-samples'
import type { MockScenarioFile } from '../../apps/ai/src/composition-root'

/** Real apps/ai + real API/query/database; only model and external channel are mock.
 * Complete runtime logs stay in apps/ai, optional HTTP forwarding stores only anchors/state.
 */

const INTERNAL_TOKEN = 'evt-test-internal-token'

interface RuntimeEventRow {
  seq: string
  session_id: string
  enterprise_id: string | null
  user_id: string | null
  request_id: string | null
  kind: string
  event: Record<string, unknown>
}

let app: INestApplication
let appPort = 0
let pool: pg.Pool
let adminToken = ''
let sessionId = ''
let enterpriseId = ''
let userId = ''
let spawned: SpawnedAiRuntime
let deadSinkRuntime: SpawnedAiRuntime | null = null

const SCENARIO: MockScenarioFile = {
  capabilities: SAMPLE_CAPABILITIES_RESPONSE,
  modelSteps: [
    { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.order-progress', capabilityVersion: 1, params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } } }] },
    { kind: 'answer', text: '生产订单 ORDER-AQ-1001 当前状态：进行中。（数字与来源以结构化结果信封为准）' },
  ],
  queryScript: [],
}

async function fetchEvents(sessionId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${String(appPort)}/internal/aiquery/runtime-events?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
  })
  return { status: response.status, body: ((await response.json()) as Record<string, unknown>) }
}

beforeAll(async () => {
  pool = await prepareAqTestDatabase()
  process.env['DATABASE_URL'] = aqDatabaseUrl()
  process.env['AIQUERY_INTERNAL_TOKEN'] = INTERNAL_TOKEN
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate: validateEnv }), DbModule, AuthModule, AiQueryModule],
  }).compile()
  app = moduleRef.createNestApplication()
  await app.listen(0, '127.0.0.1')
  const address = app.getHttpServer().address()
  appPort = typeof address === 'object' && address !== null ? address.port : 0

  const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ loginName: 'admin', password: 'CadAdmin001', platform: 'WEB' })
  expect(loginRes.status).toBe(200)
  adminToken = loginRes.body.token as string
  const sessionRes = await request(app.getHttpServer())
    .post('/aiquery/sessions')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ channel: 'web' })
  expect(sessionRes.status).toBe(201)
  sessionId = sessionRes.body.sessionId as string
  enterpriseId = sessionRes.body.enterpriseId as string
  userId = sessionRes.body.userId as string

  spawned = await spawnAiRuntime({
    scenario: SCENARIO,
    env: {
      AI_CONTROLLED_QUERY_MODE: 'http',
      AI_CONTROLLED_QUERY_BASE_URL: `http://127.0.0.1:${String(appPort)}/internal/aiquery`,
      AI_INTERNAL_QUERY_TOKEN: INTERNAL_TOKEN,
        AI_SESSION_EVENT_SINK_URL: `http://127.0.0.1:${String(appPort)}/internal/aiquery/runtime-events`,
    },
  })
})

afterAll(async () => {
  if (deadSinkRuntime) await deadSinkRuntime.stop()
  if (spawned) await spawned.stop()
  if (app) await app.close()
  if (pool) await pool.end()
})



async function registerSession(rt: SpawnedAiRuntime): Promise<void> {
  const response = await rt.post('/ai-runtime/sessions', {
    sessionId,
    enterpriseId,
    userId,
    channel: 'web',
    conversationRef: null,
  })
  expect(response.status).toBe(201)
}

async function runTurn(rt: SpawnedAiRuntime): Promise<Record<string, unknown>> {
  const response = await rt.post('/ai-runtime/turns', {
    requestId: randomUUID(),
    sessionId,
    userMessage: 'ORDER-AQ-1001 做到哪一步了',
    timeBasis: { timeZone: 'Asia/Shanghai' },
  })
  expect(response.status).toBe(200)
  expect(response.body['outcome']).toBe('answer')
  return response.body as Record<string, unknown>
}

describe('接缝 4：完整事件留 apps/ai，业务库仅锚点与状态', () => {
  it('① 真实 turns/execute 保留；完整事件本地落盘，业务库仅存锚点与状态', async () => {
    await registerSession(spawned)
    const turn = await runTurn(spawned)
    const answerRefs = turn['answerRefs'] as Array<{ auditRef: { requestId: string } }> | undefined
    expect(answerRefs !== undefined && answerRefs.length > 0).toBe(true)
    const requestId = answerRefs![0]!.auditRef.requestId

    const rows = await pool.query<RuntimeEventRow>(
      `SELECT seq::text, session_id, enterprise_id, user_id, request_id::text AS request_id, kind, event
       FROM ai_runtime_event WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    )
    const kinds = rows.rows.map((r) => r.kind)
    expect(kinds).toEqual(['session_lifecycle', 'user_message', 'model_turn', 'tool_call', 'model_turn', 'turn_outcome'])
    for (const row of rows.rows) {
      expect(row.enterprise_id).toBe(enterpriseId)
      expect(row.user_id).toBe(userId)
    }
    // requestId 贯穿（AR-15）：user_message/tool_call/turn_outcome 事件均携带
    const withRequestId = rows.rows.filter((r) => r.request_id !== null)
    expect(withRequestId.length).toBeGreaterThanOrEqual(3)
    const requestIds = new Set(withRequestId.map((r) => r.request_id))
    expect(requestIds.size).toBe(1)
    expect(requestIds.has(requestId)).toBe(true)
    const toolCall = rows.rows.find((r) => r.kind === 'tool_call')!
    expect(toolCall.event).toEqual({ status: 'ok_with_data' })
    for (const row of rows.rows) {
      expect(Object.keys(row.event).every((key) => ['outcome', 'status'].includes(key))).toBe(true)
    }
    const localPath = join(spawned.dataDir, 'sessions', sessionId, 'events.jsonl')
    const fullEvents = readFileSync(localPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(fullEvents.find((event) => event['kind'] === 'user_message')!['content']).toBe('ORDER-AQ-1001 做到哪一步了')
    expect((fullEvents.find((event) => event['kind'] === 'tool_call')!['result'] as Record<string, unknown>)['status']).toBe('ok_with_data')
    expect(existsSync(join(spawned.dataDir, 'sessions', sessionId, 'meta.json'))).toBe(true)

    // api 端点读回（重启可查的查询面）
    const events = await fetchEvents(sessionId)
    expect(events.status).toBe(200)
    expect(events.body['total']).toBe(rows.rows.length)
  })

  it('② 重启后旧锚点仍可查，新轮次追加；原进程完整正文仍在独立目录', async () => {
    const before = await fetchEvents(sessionId)
    const totalBefore = before.body['total'] as number

    const previousLog = join(spawned.dataDir, 'sessions', sessionId, 'events.jsonl')
    const previousContent = readFileSync(previousLog, 'utf8')
    // Restart only the process created by this test.
    await spawned.stop()
    spawned = await spawnAiRuntime({
      scenario: SCENARIO,
      env: {
        AI_CONTROLLED_QUERY_MODE: 'http',
        AI_CONTROLLED_QUERY_BASE_URL: `http://127.0.0.1:${String(appPort)}/internal/aiquery`,
        AI_INTERNAL_QUERY_TOKEN: INTERNAL_TOKEN,
        AI_SESSION_EVENT_SINK_URL: `http://127.0.0.1:${String(appPort)}/internal/aiquery/runtime-events`,
      },
    })
    await registerSession(spawned)
    await runTurn(spawned)

    expect(readFileSync(previousLog, 'utf8')).toBe(previousContent)
    const after = await fetchEvents(sessionId)
    expect(after.status).toBe(200)
    const items = after.body['items'] as Array<{ seq: number; kind: string }>
    // 新进程首轮 6 事件（session_lifecycle〔touchActive open→active〕+ user_message +
    // model_turn + tool_call + model_turn + turn_outcome）；DB 留档跨进程累计
    expect(items.length).toBe(totalBefore + 6)
    const seqs = items.map((item) => item.seq)
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
  })

  it('③ 锚点端点不可达也保留完整本地日志，不阻断真实轮次', async () => {
    deadSinkRuntime = await spawnAiRuntime({
      scenario: SCENARIO,
      env: {
        AI_CONTROLLED_QUERY_MODE: 'http',
        AI_CONTROLLED_QUERY_BASE_URL: `http://127.0.0.1:${String(appPort)}/internal/aiquery`,
        AI_INTERNAL_QUERY_TOKEN: INTERNAL_TOKEN,
        AI_SESSION_EVENT_SINK_URL: 'http://127.0.0.1:9/internal/aiquery/runtime-events', // 不可达端点
      },
    })
    await registerSession(deadSinkRuntime)
    const turn = await runTurn(deadSinkRuntime) // 轮次不阻断
    expect(turn['outcome']).toBe('answer')
    // 事件回退本地 events.jsonl（AR-13 同则：AI 侧归档失败不放大为轮次失败）
    const localPath = join(deadSinkRuntime.dataDir, 'sessions', sessionId, 'events.jsonl')
    expect(existsSync(localPath)).toBe(true)
    const lines = readFileSync(localPath, 'utf8').split('\n').filter((line) => line.length > 0)
    expect(lines.length).toBeGreaterThanOrEqual(5)
    await deadSinkRuntime.stop()
    deadSinkRuntime = null
  })
  it('④ 即使内部客户端显式发送正文，服务端也只落固定状态值', async () => {
    const requestId = randomUUID()
    const response = await fetch(`http://127.0.0.1:${String(appPort)}/internal/aiquery/runtime-events`, {
      method: 'POST', headers: { Authorization: `Bearer ${INTERNAL_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, event: { kind: 'tool_call', at: new Date().toISOString(), requestId, params: { secret: 'private-params' }, result: { status: 'ok_with_data', data: 'private-result' }, content: 'private-chat' } }),
    })
    expect(response.status).toBe(201)
    expect((await response.json() as { contentStored: boolean }).contentStored).toBe(false)
    const rows = await pool.query('SELECT event FROM ai_runtime_event WHERE request_id = $1', [requestId])
    expect(rows.rows).toEqual([{ event: { status: 'ok_with_data' } }])
  })

})
