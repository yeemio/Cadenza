/**
 * 限额与取消合同测试（dsh-edge.md DS-10/DS-11；AR-09/AR-13）。
 * mock 脚本驱动（DS-13）：慢模型/慢查询复现在途轮次，断言超限拒绝不排队、
 * 取消后不再发起新的工具调用、终态 cancelled+阶段摘要。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAiRuntime } from '../../apps/ai/src/composition-root'
import type { AiRuntime } from '../../apps/ai/src/composition-root'
import { MockModelClient, DEFAULT_RUNTIME_PROFILE, withProfileOverrides } from '../../packages/integrations/dsh'
import type { MockModelStep, RuntimeProfile } from '../../packages/integrations/dsh'
import { MockControlledQueryClient } from '../../apps/ai/src/controlled-query-client'
import type { MockQueryScriptEntry } from '../../apps/ai/src/controlled-query-client'
import { ENVELOPE_SAMPLES, SAMPLE_CAPABILITIES_RESPONSE } from './envelope-samples'

const dataDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-limits-'))
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
}): Harness {
  const model = new MockModelClient({ steps: [...options.steps] })
  const query = new MockControlledQueryClient(options.queryScript ?? [], SAMPLE_CAPABILITIES_RESPONSE)
  const profile = withProfileOverrides(DEFAULT_RUNTIME_PROFILE, {
    defaultTenantLimits: { maxConcurrentTurns: 1, dailyTurnLimit: 3, perTurnBudgetMs: 30_000 },
    ...(options.profile ?? {}),
  })
  const runtime = createAiRuntime({ env: {}, model, queryClient: query, profile, dataDir: tempDir() })
  const sessionId = 'sess-limits-1'
  void runtime.store.registerSession({
    sessionId,
    enterpriseId: 'ent-limits',
    userId: 'user-1',
    channel: 'web',
    conversationRef: null,
  })
  return { runtime, model, query, sessionId }
}

const okEnvelope: MockQueryScriptEntry = {
  envelope: {
    status: ENVELOPE_SAMPLES['ok_with_data'].status,
    data: ENVELOPE_SAMPLES['ok_with_data'].data,
    completeness: ENVELOPE_SAMPLES['ok_with_data'].completeness,
    freshness: ENVELOPE_SAMPLES['ok_with_data'].freshness,
    contextEcho: ENVELOPE_SAMPLES['ok_with_data'].contextEcho,
  },
}

describe('DS-10 按租户限额（超限拒绝、不排队放大）', () => {
  it('并发超限：在途轮次占用并发额度，新轮立即被拒（不等待、不排队）', async () => {
    const h = makeHarness({
      steps: [
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.quality', capabilityVersion: 1, params: {} }] },
        { kind: 'answer', text: '慢轮完成' },
      ],
      queryScript: [{ ...okEnvelope, delayMs: 600 }],
    })
    const slow = h.runtime.orchestrator.runTurn({ requestId: 'req-slow', sessionId: h.sessionId, userMessage: '慢查询' })
    await new Promise((r) => setTimeout(r, 80)) // 确保慢轮已进入工具等待
    const started = Date.now()
    const rejected = await h.runtime.orchestrator.runTurn({ requestId: 'req-fast', sessionId: h.sessionId, userMessage: '第二问' })
    expect(Date.now() - started).toBeLessThan(400) // 立即返回，未排队等慢轮
    expect(rejected.outcome).toBe('unavailable')
    expect(rejected.statusDetail.status).toBe('over_limit')
    expect(rejected.statusDetail.which).toBe('concurrent')
    expect(rejected.statusDetail.limit).toBe(1)
    expect(rejected.message).toContain('暂不可用')
    const completed = await slow
    expect(completed.outcome).toBe('answer') // 慢轮不受拒绝影响
  })

  it('并发额度在轮次结束后释放（新轮可再次进入）', async () => {
    const h = makeHarness({ steps: [{ kind: 'answer', text: '快答' }] })
    const first = await h.runtime.orchestrator.runTurn({ requestId: 'r1', sessionId: h.sessionId, userMessage: 'a' })
    expect(first.outcome).toBe('answer')
    const second = await h.runtime.orchestrator.runTurn({ requestId: 'r2', sessionId: h.sessionId, userMessage: 'b' })
    expect(second.outcome).toBe('answer')
  })

  it('日调用次数超限：达限后拒绝（本例 dailyTurnLimit=3）', async () => {
    const h = makeHarness({ steps: [{ kind: 'answer', text: 'ok' }, { kind: 'answer', text: 'ok' }, { kind: 'answer', text: 'ok' }] })
    for (let i = 1; i <= 3; i += 1) {
      const response = await h.runtime.orchestrator.runTurn({ requestId: `d${String(i)}`, sessionId: h.sessionId, userMessage: 'x' })
      expect(response.outcome).toBe('answer')
    }
    const fourth = await h.runtime.orchestrator.runTurn({ requestId: 'd4', sessionId: h.sessionId, userMessage: 'x' })
    expect(fourth.outcome).toBe('unavailable')
    expect(fourth.statusDetail.status).toBe('over_limit')
    expect(fourth.statusDetail.which).toBe('daily')
    expect(h.query.received).toHaveLength(0) // 拒绝发生在任何工具调用之前（AR-13：不放大）
  })

  it('租户覆盖可收紧/放宽（tenantLimitOverrides 生效，配置声明）', async () => {
    const model = new MockModelClient({ steps: [] })
    const query = new MockControlledQueryClient([], SAMPLE_CAPABILITIES_RESPONSE)
    const runtime = createAiRuntime({
      env: { AI_TENANT_LIMITS: JSON.stringify({ 'ent-x': { maxConcurrentTurns: 2, dailyTurnLimit: 5 } }) },
      model,
      queryClient: query,
      dataDir: tempDir(),
    })
    expect(runtime.limits.limitsFor('ent-x').maxConcurrentTurns).toBe(2)
    expect(runtime.limits.limitsFor('ent-x').dailyTurnLimit).toBe(5)
    expect(runtime.limits.limitsFor('ent-other').maxConcurrentTurns).toBe(DEFAULT_RUNTIME_PROFILE.defaultTenantLimits.maxConcurrentTurns)
  })
})

describe('DS-11 取消合同（取消后不再发起新的工具调用）', () => {
  it('在途轮次取消：终态 cancelled+阶段摘要；不再发起后续工具调用；事件归档 cancel', async () => {
    const h = makeHarness({
      steps: [
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.quality', capabilityVersion: 1, params: {} }] },
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.order-progress', capabilityVersion: 1, params: {} }] },
        { kind: 'answer', text: '不应到达' },
      ],
      // 第 1 次查询挂起直至外部中止；取消触发 abort → 编排停止
      queryScript: [{ ...okEnvelope, hangUntilAborted: true }, okEnvelope],
    })
    const inFlight = h.runtime.orchestrator.runTurn({ requestId: 'req-cancel', sessionId: h.sessionId, userMessage: '慢查询' })
    await new Promise((r) => setTimeout(r, 100)) // 已进入第 1 次工具等待
    const decision = h.runtime.registry.requestCancel('req-cancel')
    expect(decision).toBe('cancelled_in_flight')
    const response = await inFlight
    expect(response.outcome).toBe('cancelled')
    expect(response.statusDetail.status).toBe('cancelled')
    expect(response.statusDetail.stageSummary).toContain('未再发起新的工具调用')
    expect(response.statusDetail.toolCallsUsed).toBe(0) // 第 1 次在途查询被中止，不计入完成
    expect(h.query.received).toHaveLength(1) // 只发起过 1 次工具调用，无第 2 次
    expect(h.model.calls()).toBe(1) // 取消后未再调用模型
    expect(response.message).toContain('已取消')

    const events = await h.runtime.store.listEvents(h.sessionId)
    expect(events.some((event) => event.kind === 'cancel' && event.requestId === 'req-cancel')).toBe(true)
    expect(events.some((event) => event.kind === 'turn_outcome' && event.requestId === 'req-cancel' && event.outcome === 'cancelled')).toBe(true)
  })

  it('取消时刚好完成的查询结果被丢弃（不可取消则等待返回后丢弃的 B 侧语义）', async () => {
    const h = makeHarness({
      steps: [
        { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.quality', capabilityVersion: 1, params: {} }] },
        { kind: 'answer', text: '不应到达' },
      ],
      queryScript: [{ ...okEnvelope, delayMs: 500 }],
    })
    const inFlight = h.runtime.orchestrator.runTurn({ requestId: 'req-cancel2', sessionId: h.sessionId, userMessage: 'x' })
    await new Promise((r) => setTimeout(r, 80))
    h.runtime.registry.requestCancel('req-cancel2')
    const response = await inFlight
    expect(response.outcome).toBe('cancelled')
    expect(h.query.received).toHaveLength(1)
    // 查询信封即便在取消瞬间返回也被丢弃：answerRefs 不包含该次结果或终态不受影响
    expect(response.statusDetail.status).toBe('cancelled')
  })

  it('已完成轮次的取消=幂等 no-op；未知 requestId 的取消=unknown（DS-23 decision）', async () => {
    const h = makeHarness({ steps: [{ kind: 'answer', text: 'done' }] })
    await h.runtime.orchestrator.runTurn({ requestId: 'req-done', sessionId: h.sessionId, userMessage: 'x' })
    expect(h.runtime.registry.requestCancel('req-done')).toBe('already_finished')
    expect(h.runtime.registry.requestCancel('req-nope')).toBe('unknown_request')
  })
})
