/**
 * 运行行为合同测试（dsh-edge.md §2：DS-06/07/08/09/12 + 时间基准总则）。
 * 组合根直构（进程内），mock 模型脚本 + 合同级 mock 查询客户端驱动；每条均为可复现证据。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAiRuntime } from '../../apps/ai/src/composition-root'
import type { AiRuntime } from '../../apps/ai/src/composition-root'
import { MockModelClient } from '../../packages/integrations/dsh'
import type { MockModelStep, RuntimeProfile } from '../../packages/integrations/dsh'
import { DEFAULT_RUNTIME_PROFILE, withProfileOverrides } from '../../packages/integrations/dsh'
import { MockControlledQueryClient, ControlledQuerySessionError, candidateOptionId } from '../../apps/ai/src/controlled-query-client'
import type { ControlledQueryClient, MockQueryScriptEntry } from '../../apps/ai/src/controlled-query-client'
import { ENVELOPE_SAMPLES, SAMPLE_CAPABILITIES_RESPONSE, SAMPLE_ORDER_CANDIDATES } from './envelope-samples'

const dataDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-'))
  dataDirs.push(dir)
  return dir
}

afterEach(() => {
  while (dataDirs.length > 0) {
    const dir = dataDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

interface Harness {
  runtime: AiRuntime
  model: MockModelClient
  query: MockControlledQueryClient
  sessionId: string
}

function makeHarness(options: {
  steps: MockModelStep[]
  queryScript?: MockQueryScriptEntry[]
  profile?: Partial<RuntimeProfile>
  registerSession?: boolean
  now?: () => Date
}): Harness {
  const model = new MockModelClient({ steps: [...options.steps] })
  const query = new MockControlledQueryClient(options.queryScript ?? [], SAMPLE_CAPABILITIES_RESPONSE)
  const profile = withProfileOverrides(DEFAULT_RUNTIME_PROFILE, options.profile ?? {})
  const runtime = createAiRuntime({
    env: {},
    model,
    queryClient: query,
    profile,
    dataDir: tempDir(),
    now: options.now,
  })
  const sessionId = 'sess-orch-1'
  if (options.registerSession !== false) {
    void runtime.store.registerSession({
      sessionId,
      enterpriseId: 'ent-1',
      userId: 'user-1',
      channel: 'web',
      conversationRef: 'conv-1',
    })
  }
  return { runtime, model, query, sessionId }
}

/** wire 冻结样例回放条目（ok_with_data 携带 data.candidates；澄清候选由 mock 客户端同源投影）。 */
const okEnvelopeEntry: MockQueryScriptEntry = {
  envelope: {
    status: 'ok_with_data',
    data: ENVELOPE_SAMPLES['ok_with_data'].data,
    completeness: ENVELOPE_SAMPLES['ok_with_data'].completeness,
    freshness: ENVELOPE_SAMPLES['ok_with_data'].freshness,
    contextEcho: ENVELOPE_SAMPLES['ok_with_data'].contextEcho,
  },
}

describe('DS-06 会话生命周期与归档', () => {
  it('open → active（轮次进行）→ closed → 过期清理；事件按 requestId 归档于独立数据目录', async () => {
    const h = makeHarness({ steps: [{ kind: 'answer', text: '好的。' }] })
    const registered = await h.runtime.store.findSession(h.sessionId)
    expect(registered?.status).toBe('open')

    const response = await h.runtime.orchestrator.runTurn({ requestId: 'req-1', sessionId: h.sessionId, userMessage: '你好' })
    expect(response.outcome).toBe('answer')
    expect((await h.runtime.store.findSession(h.sessionId))?.status).toBe('active')

    // 空闲关停：lastActiveAt 已是过去（idle 阈值 1ms）
    await new Promise((r) => setTimeout(r, 10))
    const swept = await h.runtime.store.sweepSessions(1, Number.MAX_SAFE_INTEGER, new Date())
    expect(swept).toContain(h.sessionId)
    expect((await h.runtime.store.findSession(h.sessionId))?.status).toBe('closed')
    expect((await h.runtime.store.findSession(h.sessionId))?.closedReason).toBe('idle_timeout')

    // 过期清理
    await h.runtime.store.sweepSessions(1, 0, new Date())
    expect((await h.runtime.store.findSession(h.sessionId))?.status).toBe('expired')

    const events = await h.runtime.store.listEvents(h.sessionId)
    const kinds = events.map((event) => event.kind)
    expect(kinds).toContain('session_lifecycle')
    expect(kinds).toContain('user_message')
    expect(kinds).toContain('model_turn')
    expect(kinds).toContain('turn_outcome')
    expect(events.filter((event) => event.kind !== 'session_lifecycle').every((event) => event.requestId === 'req-1')).toBe(true)
  })

  it('closed/expired 会话新轮拒绝；未登记会话拒绝（可理解状态+错误码）', async () => {
    const h = makeHarness({ steps: [{ kind: 'answer', text: 'x' }] })
    const unregistered = await h.runtime.orchestrator.runTurn({ requestId: 'r0', sessionId: 'no-such', userMessage: 'x' })
    expect(unregistered.outcome).toBe('unavailable')
    expect(unregistered.statusDetail.code).toBe('ERR_AI_SESSION_NOT_FOUND')

    await h.runtime.store.closeSession(h.sessionId, 'user_closed', new Date().toISOString())
    const closed = await h.runtime.orchestrator.runTurn({ requestId: 'r1', sessionId: h.sessionId, userMessage: 'x' })
    expect(closed.statusDetail.code).toBe('ERR_AI_SESSION_CLOSED')
  })
})

describe('DS-07 单轮工具调用上限', () => {
  it('上限（本例 2）触发即停止调工具，以已获结果收口作答；不虚构未取数据', async () => {
    const h = makeHarness({
      steps: [
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.quality', capabilityVersion: 1, params: { conclusions: ['unqualified'] } }] },
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.order-progress', capabilityVersion: 1, params: { orderRef: { kind: 'orderNo', value: 'SC-1' } } }] },
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.material-shortage', capabilityVersion: 1, params: {} }] },
        { kind: 'answer', text: '不应到达' },
      ],
      queryScript: [okEnvelopeEntry, okEnvelopeEntry],
      profile: { toolCallLimitPerTurn: 2 },
    })
    const response = await h.runtime.orchestrator.runTurn({ requestId: 'req-limit', sessionId: h.sessionId, userMessage: '查一下' })
    expect(response.outcome).toBe('answer')
    expect(response.statusDetail.status).toBe('tool_call_limit_reached')
    expect(response.statusDetail.limit).toBe(2)
    expect(response.statusDetail.toolCallsUsed).toBe(2)
    expect(h.query.received).toHaveLength(2) // 第三次工具调用未发出
    expect(h.model.calls()).toBe(3) // 第 3 次模型意图返回 tool_calls 但被上限拦截
    expect(response.answerRefs).toHaveLength(2)
    expect(response.message).toContain('上限')
    expect(response.message).toContain('不总结为完整总量') // 收口文案含完整性声明
  })
})

describe('DS-08 澄清交互（选项来自能力结果）+ AQ-AMB-04 同 requestId 延续', () => {
  it('有效澄清：选项解析自信封候选（data.candidates 投影），模型编造的选项被丢弃', async () => {
    const h = makeHarness({
      steps: [
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.order-progress', capabilityVersion: 1, params: { orderRef: { kind: 'orderNoLike', value: 'SC-2026-1024' } } }] },
        { kind: 'clarify', question: '找到两张同号订单，请确认是哪一张？', optionIds: [candidateOptionId(SAMPLE_ORDER_CANDIDATES[0].orderId), 'opt-order-invented'] },
      ],
      queryScript: [okEnvelopeEntry],
    })
    const response = await h.runtime.orchestrator.runTurn({ requestId: 'req-amb', sessionId: h.sessionId, userMessage: 'SC-2026-1024 进度' })
    expect(response.outcome).toBe('clarify')
    expect(response.message).toContain('哪一张')
    expect(response.options).toHaveLength(1)
    expect(response.options?.[0]?.id).toBe(candidateOptionId(SAMPLE_ORDER_CANDIDATES[0].orderId)) // 编造选项被丢弃（DS-08）
    expect(response.options?.[0]?.confirm?.capabilityId).toBe('aq.order-progress')
    expect(response.options?.[0]?.confirm?.params).toEqual({
      orderRef: { kind: 'orderId', value: SAMPLE_ORDER_CANDIDATES[0].orderId }, // AQ-AMB-01：精确 orderId 重发
    })

    const events = await h.runtime.store.listEvents(h.sessionId)
    expect(events.some((event) => event.kind === 'clarify' && event.requestId === 'req-amb')).toBe(true) // AQ-AMB-04：澄清事件归档
  })

  it('澄清延续：用户答复后同一 requestId 继续，上一轮待选选项仍可解析', async () => {
    const h = makeHarness({
      steps: [
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.order-progress', capabilityVersion: 1, params: { orderRef: { kind: 'orderNoLike', value: 'SC-2026-1024' } } }] },
        { kind: 'clarify', question: '请确认订单', optionIds: [candidateOptionId(SAMPLE_ORDER_CANDIDATES[0].orderId)] },
        { kind: 'clarify', question: '再次确认？', optionIds: [candidateOptionId(SAMPLE_ORDER_CANDIDATES[1].orderId)] },
      ],
      queryScript: [okEnvelopeEntry],
    })
    const first = await h.runtime.orchestrator.runTurn({ requestId: 'req-cont', sessionId: h.sessionId, userMessage: '查 SC-2026-1024' })
    expect(first.outcome).toBe('clarify')
    // 第二轮同 requestId：模型只引用上一轮遗留选项（无新工具结果）
    const second = await h.runtime.orchestrator.runTurn({ requestId: 'req-cont', sessionId: h.sessionId, userMessage: '苏州一厂那张' })
    expect(second.outcome).toBe('clarify')
    expect(second.options?.[0]?.id).toBe(candidateOptionId(SAMPLE_ORDER_CANDIDATES[1].orderId)) // 遗留选项池仍可解析
  })

  it('全部选项不在能力结果中→拒绝呈现澄清（可理解失败）', async () => {
    const h = makeHarness({
      steps: [
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.order-progress', capabilityVersion: 1, params: {} }] },
        { kind: 'clarify', question: '选一个？', optionIds: ['made-up-a', 'made-up-b'] },
      ],
      queryScript: [okEnvelopeEntry],
    })
    const response = await h.runtime.orchestrator.runTurn({ requestId: 'req-bad-amb', sessionId: h.sessionId, userMessage: 'x' })
    expect(response.outcome).toBe('unavailable')
    expect(response.statusDetail.code).toBe('ERR_CLARIFY_OPTIONS_NOT_FROM_CAPABILITY')
    expect(response.options).toBeUndefined()
  })
})

describe('DS-09 超时合同（单次查询超时与单轮总预算分别可判）', () => {
  it('单次查询等待超时：停止继续调工具，timeout/single_query 可判，部分数据带完整性标注', async () => {
    const h = makeHarness({
      steps: [
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.quality', capabilityVersion: 1, params: {} }] },
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.order-progress', capabilityVersion: 1, params: {} }] },
        { kind: 'answer', text: '不应到达' },
      ],
      queryScript: [{ ...okEnvelopeEntry, delayMs: 800 }],
      profile: { singleQueryTimeoutMs: 150, turnBudgetMs: 10_000 },
    })
    const response = await h.runtime.orchestrator.runTurn({ requestId: 'req-qto', sessionId: h.sessionId, userMessage: 'x' })
    expect(response.outcome).toBe('unavailable')
    expect(response.statusDetail.status).toBe('timeout')
    expect(response.statusDetail.scope).toBe('single_query')
    expect(response.statusDetail.capabilityId).toBe('aq.quality')
    expect(response.statusDetail.toolCallSeqReached).toBe(1)
    expect(h.query.received).toHaveLength(1) // 超时后未再发第二次工具调用
    expect(h.model.calls()).toBe(1) // 循环停止（后续脚本未消费）
    expect(response.message).toContain('部分数据')
    expect(response.answerRefs?.[0]?.completeness).toBeDefined() // 完整性标注随行
  })

  it('单轮总预算超时：与单次查询超时独立可判（scope=turn_budget）', async () => {
    const h = makeHarness({
      steps: [
        { kind: 'tool_calls', delayMs: 400, toolCalls: [{ capabilityId: 'aq.quality', capabilityVersion: 1, params: {} }] },
      ],
      queryScript: [okEnvelopeEntry],
      profile: { singleQueryTimeoutMs: 5_000, turnBudgetMs: 200 },
    })
    const response = await h.runtime.orchestrator.runTurn({ requestId: 'req-bto', sessionId: h.sessionId, userMessage: 'x' })
    expect(response.outcome).toBe('unavailable')
    expect(response.statusDetail.status).toBe('timeout')
    expect(response.statusDetail.scope).toBe('turn_budget')
    expect(response.statusDetail.toolCallsUsed).toBe(0)
    expect(h.query.received).toHaveLength(0) // 预算耗尽在工具调用前拦截
  })
})

describe('DS-12 回答组织与时间基准', () => {
  it('answer：数字与来源以 answerRefs（信封段）呈现；解释文字由模型生成并标注非事实', async () => {
    const h = makeHarness({
      steps: [
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.quality', capabilityVersion: 1, params: { relativeTime: 'last_7_days' } }] },
        { kind: 'answer', text: '最近 7 个自然日不合格检验 1 单（数字与来源见结构化结果）。【解释非事实】推测与来料批次相关，待复核。' },
      ],
      queryScript: [okEnvelopeEntry],
      now: (): Date => new Date('2026-10-28T06:30:00.000Z'), // 上海 2026-10-28 14:30
    })
    const response = await h.runtime.orchestrator.runTurn({ requestId: 'req-ans', sessionId: h.sessionId, userMessage: '最近一周质量' })
    expect(response.outcome).toBe('answer')
    expect(response.message).toContain('【解释非事实】') // 事实与推测分开（AQ-C3 §4）
    expect(response.answerRefs?.[0]).toMatchObject({
      capabilityId: 'aq.quality',
      capabilityVersion: 1,
      status: 'ok_with_data',
    })
    expect(response.answerRefs?.[0]?.auditRef).toEqual({ requestId: 'req-ans', toolCallSeq: 1 })
    expect(response.answerRefs?.[0]?.freshness.queriedAt).toBeTruthy()

    // §1 总则：相对时间由 B 线换算 Asia/Shanghai 显式起止后传参（contextEcho 回显由 A 线承担，此处断言传参形状）
    const sent = h.query.received[0]?.params as Record<string, unknown>
    expect(sent['relativeTime']).toBeUndefined()
    expect(sent['timeRange']).toEqual({ from: '2026-10-21T16:00:00.000Z', to: '2026-10-28T16:00:00.000Z' })

    const events = await h.runtime.store.listEvents(h.sessionId)
    const toolCall = events.find((event) => event.kind === 'tool_call')
    expect(toolCall !== undefined && toolCall.kind === 'tool_call' && toolCall.timeBasisApplied?.timeZone).toBe('Asia/Shanghai')
  })
})

describe('受控查询层不可达（capabilities 阶段）', () => {
  it('会话失效（404 语义）→ unavailable ERR_AI_SESSION_NOT_FOUND；不可达→ERR_CONTROLLED_QUERY_UNREACHABLE', async () => {
    const brokenSession: ControlledQueryClient = {
      mode: 'mock',
      listCapabilities: () => {
        throw new ControlledQuerySessionError('ERR_AI_SESSION_NOT_FOUND', '会话不存在或已失效')
      },
      execute: () => {
        throw new Error('不应调用')
      },
    }
    const runtime1 = createAiRuntime({ env: {}, model: new MockModelClient({ steps: [] }), queryClient: brokenSession, dataDir: tempDir() })
    await runtime1.store.registerSession({ sessionId: 's1', enterpriseId: 'e1', userId: 'u1', channel: 'web', conversationRef: null })
    const r1 = await runtime1.orchestrator.runTurn({ requestId: 'rq1', sessionId: 's1', userMessage: 'x' })
    expect(r1.outcome).toBe('unavailable')
    expect(r1.statusDetail.code).toBe('ERR_AI_SESSION_NOT_FOUND')

    const unreachable: ControlledQueryClient = {
      mode: 'mock',
      listCapabilities: () => {
        throw new Error('ECONNREFUSED')
      },
      execute: () => {
        throw new Error('不应调用')
      },
    }
    const runtime2 = createAiRuntime({ env: {}, model: new MockModelClient({ steps: [] }), queryClient: unreachable, dataDir: tempDir() })
    await runtime2.store.registerSession({ sessionId: 's2', enterpriseId: 'e2', userId: 'u2', channel: 'web', conversationRef: null })
    const r2 = await runtime2.orchestrator.runTurn({ requestId: 'rq2', sessionId: 's2', userMessage: 'x' })
    expect(r2.outcome).toBe('unavailable')
    expect(r2.statusDetail.code).toBe('ERR_CONTROLLED_QUERY_UNREACHABLE')
  })
})
