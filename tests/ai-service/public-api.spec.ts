/**
 * apps/ai 公开运行接口 HTTP 合同测试（dsh-edge.md DS-03/DS-23）。
 * spawn 真实独立进程（apps/ai/dist 入口）+ mock 场景文件注入（DS-13）：
 * 认证、健康（runtime 声明）、会话登记、同步轮次四终态、取消、并发超限。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnAiRuntime, waitRefused, AI_TEST_TOKEN } from './ai-runtime-spawn'
import type { SpawnedAiRuntime } from './ai-runtime-spawn'
import { candidateOptionId } from '../../apps/ai/src/controlled-query-client'
import { ENVELOPE_SAMPLES, SAMPLE_CAPABILITIES_RESPONSE, SAMPLE_ORDER_CANDIDATES } from './envelope-samples'
import type { MockScenarioFile } from '../../apps/ai/src/composition-root'

const SESSION = { sessionId: 'sess-api-1', enterpriseId: 'ent-api', userId: 'user-1', channel: 'web', conversationRef: 'conv-1' }

/** wire 冻结样例回放条目（ok_with_data 携带 data.candidates；澄清候选由 mock 客户端同源投影）。 */
const okQueryEntry = {
  envelope: {
    status: ENVELOPE_SAMPLES['ok_with_data'].status,
    data: ENVELOPE_SAMPLES['ok_with_data'].data,
    completeness: ENVELOPE_SAMPLES['ok_with_data'].completeness,
    freshness: ENVELOPE_SAMPLES['ok_with_data'].freshness,
    contextEcho: ENVELOPE_SAMPLES['ok_with_data'].contextEcho,
  },
}

const spawned: SpawnedAiRuntime[] = []

async function spawnWith(scenario: MockScenarioFile, env?: Record<string, string>): Promise<SpawnedAiRuntime> {
  const runtime = await spawnAiRuntime({ scenario, env })
  spawned.push(runtime)
  return runtime
}

afterAll(async () => {
  for (const runtime of spawned) await runtime.stop()
})

async function registerSession(rt: SpawnedAiRuntime, sessionId = SESSION.sessionId): Promise<void> {
  const response = await rt.post('/ai-runtime/sessions', { ...SESSION, sessionId })
  expect(response.status).toBe(201)
}

describe('DS-03/DS-23 认证与健康', () => {
  let rt: SpawnedAiRuntime

  beforeAll(async () => {
    rt = await spawnWith({ capabilities: SAMPLE_CAPABILITIES_RESPONSE, modelSteps: [{ kind: 'answer', text: 'ok' }], queryScript: [] })
  })

  it('health 无鉴权可达，返回 runtime 声明（UI 暂不可用判定源，AR-11/DS-14）', async () => {
    const response = await rt.get('/ai-runtime/health')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok', runtime: { kind: 'mock', version: 'mock-1', profileRef: null } })
  })

  it('sessions/turns/cancel 无令牌或错令牌一律 401（仅接受接入层转发）', async () => {
    for (const path of ['/ai-runtime/sessions', '/ai-runtime/turns']) {
      const noToken = await rt.post(path, {}, 'wrong-token-or-none')
      expect(noToken.status).toBe(401)
      expect(noToken.body['code']).toBe('ERR_AI_RUNTIME_UNAUTHORIZED')
    }
    const wrongCancel = await rt.post('/ai-runtime/turns/whatever/cancel', {}, 'nope')
    expect(wrongCancel.status).toBe(401)
    expect(await rt.post('/ai-runtime/sessions', { ...SESSION }, AI_TEST_TOKEN)).toMatchObject({ status: 201 })
  })

  it('会话登记幂等（重复登记 201）；非法 channel 400；未知路由 404', async () => {
    const again = await rt.post('/ai-runtime/sessions', { ...SESSION })
    expect(again.status).toBe(201)
    expect(again.body['status']).toBe('open') // 重复登记幂等：未跑过轮次的会话保持 open（DS-23 仅索引）
    const bad = await rt.post('/ai-runtime/sessions', { ...SESSION, sessionId: 'sess-bad', channel: 'sms' })
    expect(bad.status).toBe(400)
    const unknown = await rt.post('/ai-runtime/anything', {})
    expect(unknown.status).toBe(404)
    expect(unknown.body['code']).toBe('ERR_NOT_FOUND')
  })
})

describe('DS-23 同步轮次：answer / clarify / unavailable / cancelled', () => {
  it('answer：工具调用→信封回放→结构化应答（answerRefs+auditRef 贯穿）', async () => {
    const rt = await spawnWith({
      capabilities: SAMPLE_CAPABILITIES_RESPONSE,
      modelSteps: [
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.quality', capabilityVersion: 1, params: { relativeTime: 'last_7_days' } }] },
        { kind: 'answer', text: '最近 7 个自然日不合格检验 1 单。【解释非事实】推测与来料相关。' },
      ],
      queryScript: [okQueryEntry],
    })
    await registerSession(rt)
    const response = await rt.post('/ai-runtime/turns', {
      requestId: 'req-api-1',
      sessionId: SESSION.sessionId,
      userMessage: '最近一周质量',
      timeBasis: { timeZone: 'Asia/Shanghai' },
    })
    expect(response.status).toBe(200)
    expect(response.body['outcome']).toBe('answer')
    expect(response.body['message']).toContain('【解释非事实】')
    const refs = response.body['answerRefs'] as Array<Record<string, unknown>>
    expect(refs).toHaveLength(1)
    expect(refs[0]?.['auditRef']).toEqual({ requestId: 'req-api-1', toolCallSeq: 1 })
    expect(refs[0]?.['status']).toBe('ok_with_data')
    // 事件归档断言（DS-06）：相对时间换算回执落档
    const events = rt.sessionEvents(SESSION.sessionId)
    const toolCall = events.find((event) => event.kind === 'tool_call')
    expect(toolCall !== undefined && toolCall.kind === 'tool_call' && toolCall.params['timeRange'] !== undefined).toBe(true)
    expect(toolCall !== undefined && toolCall.kind === 'tool_call' && toolCall.params['relativeTime']).toBeUndefined()
  })

  it('clarify：结构化 question+options（选项来自信封候选 data.candidates 投影，DS-08）', async () => {
    const rt = await spawnWith({
      capabilities: SAMPLE_CAPABILITIES_RESPONSE,
      modelSteps: [
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.order-progress', capabilityVersion: 1, params: { orderRef: { kind: 'orderNoLike', value: 'SC-2026-1024' } } }] },
        { kind: 'clarify', question: '找到两张同号订单，请确认是哪一张？', optionIds: [candidateOptionId(SAMPLE_ORDER_CANDIDATES[0].orderId)] },
      ],
      queryScript: [okQueryEntry],
    })
    await registerSession(rt)
    const response = await rt.post('/ai-runtime/turns', {
      requestId: 'req-api-2',
      sessionId: SESSION.sessionId,
      userMessage: 'SC-2026-1024 进度',
    })
    expect(response.status).toBe(200)
    expect(response.body['outcome']).toBe('clarify')
    expect(response.body['message']).toContain('哪一张')
    const options = response.body['options'] as Array<Record<string, unknown>>
    expect(options).toHaveLength(1)
    expect(options[0]?.['id']).toBe(candidateOptionId(SAMPLE_ORDER_CANDIDATES[0].orderId))
    expect(String(options[0]?.['label'] ?? '')).toContain('SC-2026-1024')
  })

  it('unavailable：单次查询超时经 HTTP 面透传（timeout/single_query 可判）', async () => {
    const rt = await spawnWith(
      {
        capabilities: SAMPLE_CAPABILITIES_RESPONSE,
        modelSteps: [{ kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.quality', capabilityVersion: 1, params: {} }] }],
        queryScript: [{ ...okQueryEntry, delayMs: 5_000 }],
      },
      { AI_SINGLE_QUERY_TIMEOUT_MS: '400', AI_TURN_BUDGET_MS: '10000' },
    )
    await registerSession(rt)
    const response = await rt.post('/ai-runtime/turns', {
      requestId: 'req-api-3',
      sessionId: SESSION.sessionId,
      userMessage: 'x',
    })
    expect(response.status).toBe(200)
    expect(response.body['outcome']).toBe('unavailable')
    const detail = response.body['statusDetail'] as Record<string, unknown>
    expect(detail['status']).toBe('timeout')
    expect(detail['scope']).toBe('single_query')
  })

  it('cancelled：在途轮次经 HTTP 取消，事件档案证明取消后无新工具调用（DS-11）', async () => {
    const rt = await spawnWith({
      capabilities: SAMPLE_CAPABILITIES_RESPONSE,
      modelSteps: [
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.quality', capabilityVersion: 1, params: {} }] },
        { kind: 'answer', text: '不应到达' },
      ],
      queryScript: [{ ...okQueryEntry, delayMs: 3_000 }, okQueryEntry],
    })
    await registerSession(rt)
    const inFlight = rt.post('/ai-runtime/turns', {
      requestId: 'req-api-cancel',
      sessionId: SESSION.sessionId,
      userMessage: '慢查询',
    })
    await new Promise((r) => setTimeout(r, 250))
    const cancel = await rt.post('/ai-runtime/turns/req-api-cancel/cancel', {})
    expect(cancel.status).toBe(200)
    expect(cancel.body['status']).toBe('cancelled')
    expect(cancel.body['decision']).toBe('cancelled_in_flight')
    const response = await inFlight
    expect(response.body['outcome']).toBe('cancelled')
    const detail = response.body['statusDetail'] as Record<string, unknown>
    expect(detail['stageSummary']).toContain('未再发起新的工具调用')
    const events = rt.sessionEvents(SESSION.sessionId)
    const toolCalls = events.filter((event) => event.kind === 'tool_call')
    expect(toolCalls).toHaveLength(1) // 第 2 次工具调用未发生
    expect(events.some((event) => event.kind === 'cancel')).toBe(true)
  })

  it('over_limit：并发额度 1，第二个并发轮立即被拒（HTTP 面可见，DS-24 降级原因类别）', async () => {
    const rt = await spawnWith(
      {
        capabilities: SAMPLE_CAPABILITIES_RESPONSE,
        modelSteps: [
          { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.quality', capabilityVersion: 1, params: {} }] },
          { kind: 'answer', text: '慢轮完成' },
        ],
        queryScript: [{ ...okQueryEntry, delayMs: 900 }],
      },
      { AI_TENANT_LIMITS: JSON.stringify({ 'ent-api': { maxConcurrentTurns: 1 } }) },
    )
    await registerSession(rt)
    const slow = rt.post('/ai-runtime/turns', { requestId: 'req-slow-2', sessionId: SESSION.sessionId, userMessage: 'a' })
    await new Promise((r) => setTimeout(r, 200))
    const rejected = await rt.post('/ai-runtime/turns', { requestId: 'req-fast-2', sessionId: SESSION.sessionId, userMessage: 'b' })
    expect(rejected.body['outcome']).toBe('unavailable')
    const detail = rejected.body['statusDetail'] as Record<string, unknown>
    expect(detail['status']).toBe('over_limit')
    expect(detail['which']).toBe('concurrent')
    expect((await slow).body['outcome']).toBe('answer')
  })

  it('进程停止后端口拒绝连接（AI 问数暂不可用的 unreachable 判定源，AR-11）', async () => {
    const rt = await spawnWith({ capabilities: SAMPLE_CAPABILITIES_RESPONSE, modelSteps: [], queryScript: [] })
    const health = await rt.get('/ai-runtime/health')
    expect(health.status).toBe(200)
    await rt.stop()
    expect(await waitRefused(rt.port)).toBe(true)
  })
})
