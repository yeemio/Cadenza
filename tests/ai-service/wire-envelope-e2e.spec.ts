/**
 * DS-21 共同冻结面端到端对齐测试（返工 2026-10-28）：
 * 以 A 线真实运行时信封 JSON（delivery/P4/query/ENVELOPE-SAMPLE.md 样例一——独立库
 * 黄金夹具 ORDER-AQ-1001 的一次性 supertest 真实抓取）驱动 B 线两层：
 * HttpControlledQueryClient 解析层 + TurnOrchestrator 澄清流（DS-08/AQ-AMB-01），
 * 证明 wire 原形——澄清候选承载位=各能力结果 DTO 的 data.candidates、
 * freshness.sources[].source 键、contextEcho 13 字段富形状（无顶层 timeRange）——
 * 无需任何 B 侧改写即可驱动澄清流。
 *
 * 样例一原样为唯一命中路径（candidates=[]）；本文件另备 AQ-AMB-01 多候选变体
 * （A 线 tests/api/aiquery-api.spec.ts AQ-AMB-01 用例同场景：模糊单号 ORDER-AQ-AMB
 * 命中两订单、order=null）。变体相对真实抓取仅替换：data.order/data.candidates、
 * completeness 计数、contextEcho.effectiveFilters（模糊单号回显）与 message；
 * 其余字段（statusLabel/completeness 结构/freshness 五源/contextEcho 其余 12 字段/
 * auditRef）与真实抓取逐字一致。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpControlledQueryClient, MockControlledQueryClient, candidateOptionId } from '../../apps/ai/src/controlled-query-client'
import type { ExecuteRequest, MockQueryScriptEntry } from '../../apps/ai/src/controlled-query-client'
import { createAiRuntime } from '../../apps/ai/src/composition-root'
import { MockModelClient } from '../../packages/integrations/dsh'
import type { AiQueryResultStatus } from '../../packages/integrations/dsh'
import { SAMPLE_CAPABILITIES_RESPONSE } from './envelope-samples'

/** A 线真实信封（ENVELOPE-SAMPLE.md 样例一逐字誊入；requestId 供 HTTP 客户端 auditRef 校验用）。 */
const REAL_REQUEST_ID = 'aa678815-5723-42ae-9b62-b127d376fcd7'
const REAL_ORDER_ID = 'a9d80b91-694d-4177-b8ee-85603a9c82cc'

const realEnvelope = {
  status: 'ok_with_data',
  statusLabel: '查询成功（有数据）',
  message: '查询成功：订单 ORDER-AQ-1001 当前进度（2 道当前版本工序，其中未完成 1 道）',
  data: {
    capabilityId: 'aq.order-progress',
    order: {
      orderId: REAL_ORDER_ID,
      plantId: '5ac3b8ff-62ed-4c2b-84b1-28955e372cf3',
      orderNo: 'ORDER-AQ-1001',
      orderType: 'NORMAL',
      salesContractNo: null,
      salesOrderNo: null,
      lineNo: null,
      materialDesc: 'AI演示-成品缆 / 3×95 / 红',
      productionQty: '100.0000',
      uom: 'KM',
      orderStatus: 'in_progress',
      suspended: false,
      suspendedReason: null,
      processConfigStatus: 'configured',
      bomRevisionId: 'ab37b36b-a6e7-43bb-9190-4589f15ff9a4',
      routeRevisionId: null,
      actualStartAt: null,
      plannedStartAt: null,
      plannedFinishAt: null,
      businessClosedAt: null,
      erpClosedAt: null,
      totalQuantities: {
        draftQty: '30.0000',
        submittedQty: '0.0000',
        approvedQty: '80.0000',
        qualifiedQty: '78.0000',
        stockedQty: '80.0000',
      },
      schedulingStatus: 'partially_scheduled',
      operations: [
        {
          orderOperationId: 'f1e6a97e-f4a3-4de5-9c59-75d2eb5a25c0',
          seq: 1,
          operationName: 'AI演示绞制工序',
          offlineQty: '100.0000',
          uom: 'KM',
          quantities: {
            draftQty: '0.0000',
            submittedQty: '0.0000',
            approvedQty: '80.0000',
            qualifiedQty: '78.0000',
            stockedQty: '80.0000',
          },
          scheduledQty: '100',
          fullyScheduled: true,
          ready: true,
          readyReason: '首道（非质检）工序就绪',
          incomplete: false,
        },
        {
          orderOperationId: '164cfc48-eb6b-434d-8f5b-09ba9e863e3c',
          seq: 2,
          operationName: 'AI演示质检工序',
          offlineQty: '100.0000',
          uom: 'KM',
          quantities: {
            draftQty: '30.0000',
            submittedQty: '0.0000',
            approvedQty: '0.0000',
            qualifiedQty: '0.0000',
            stockedQty: '0.0000',
          },
          scheduledQty: '0',
          fullyScheduled: false,
          ready: true,
          readyReason: '前道 seq=1 已提交且有产出，工序就绪',
          incomplete: true,
        },
      ],
    },
    candidates: [],
  },
  completeness: { truncated: false, fetchedRows: 2, totalKnown: true, total: 2, page: null },
  freshness: {
    queriedAt: '2026-10-28T03:44:40.927Z',
    sources: [
      { source: 'production_order', updatedAt: '2026-10-28T03:44:40.791Z' },
      { source: 'order_operation', updatedAt: '2026-10-28T03:44:40.804Z' },
      { source: 'schedule_slot', updatedAt: '2026-10-28T03:44:40.806Z' },
      { source: 'production_report', updatedAt: '2026-10-28T03:44:40.811Z' },
      { source: 'report_output', updatedAt: '2026-10-28T03:44:40.816Z' },
    ],
  },
  contextEcho: {
    requestId: REAL_REQUEST_ID,
    toolCallSeq: 1,
    sessionId: '8e15fe33-4868-41a7-abdf-d36993c5ae2d',
    userId: '1d7bf65c-8655-455c-983d-317be8f7cbda',
    enterpriseId: '6eefe3b1-04a1-4f0a-805f-37232156a1e4',
    channel: 'web',
    dataScope: {
      enterpriseWide: true,
      plantIds: ['5ac3b8ff-62ed-4c2b-84b1-28955e372cf3', 'c47b2383-9492-43a9-8104-90842837584d'],
    },
    capabilityId: 'aq.order-progress',
    capabilityVersion: 1,
    effectiveFilters: {
      orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' },
      orderId: REAL_ORDER_ID,
    },
    ignoredRequestFields: [],
    factColumns: [],
    notes: [],
  },
  auditRef: { requestId: REAL_REQUEST_ID, toolCallSeq: 1 },
}

/** AQ-AMB-01 多候选变体（派生自真实信封，仅替换候选相关字段；见文件头注）。 */
const AMB_CANDIDATE_1_ID = '0a1b2c3d-0000-4000-8000-0000000000a1'
const AMB_CANDIDATE_2_ID = '0a1b2c3d-0000-4000-8000-0000000000a2'
const ambiguousEnvelope = {
  ...realEnvelope,
  message: '查询成功：模糊单号命中 2 张订单，待确认目标订单（AQ-AMB-01）',
  data: {
    capabilityId: 'aq.order-progress',
    order: null,
    candidates: [
      {
        orderId: AMB_CANDIDATE_1_ID,
        orderNo: 'ORDER-AQ-AMB-1',
        plantId: '5ac3b8ff-62ed-4c2b-84b1-28955e372cf3',
        orderStatus: 'in_progress',
        materialDesc: 'AI演示-成品缆 / 3×95 / 红',
        createdAt: '2026-01-10T08:00:00.000Z',
      },
      {
        orderId: AMB_CANDIDATE_2_ID,
        orderNo: 'ORDER-AQ-AMB-2',
        plantId: 'c47b2383-9492-43a9-8104-90842837584d',
        orderStatus: 'released',
        materialDesc: 'AI演示-成品缆 / 3×95 / 蓝',
        createdAt: '2026-01-12T08:00:00.000Z',
      },
    ],
  },
  contextEcho: {
    ...realEnvelope.contextEcho,
    effectiveFilters: { orderRef: { kind: 'orderNoLike', value: 'ORDER-AQ-AMB' } },
  },
}

describe('A 线真实信封 × HttpControlledQueryClient（DS-21 解析层）', () => {
  let server: Server
  let port = 0
  const responses: unknown[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = responses.shift() ?? { code: 'ERR_NOT_FOUND' }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** 与真实信封 auditRef 一致的执行请求（解析层守门：requestId/toolCallSeq 必须回显一致）。 */
  function realExecuteRequest(): ExecuteRequest {
    return {
      requestId: REAL_REQUEST_ID,
      toolCallSeq: 1,
      sessionId: '8e15fe33-4868-41a7-abdf-d36993c5ae2d',
      capabilityId: 'aq.order-progress',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNoLike', value: 'ORDER-AQ-AMB' } },
    }
  }

  it('真实信封原样解析：data.candidates→澄清候选投影（精确 orderId 重发）、freshness.source 键、contextEcho 13 字段原形', async () => {
    responses.push(ambiguousEnvelope, realEnvelope)
    const client = new HttpControlledQueryClient(`http://127.0.0.1:${String(port)}/internal/aiquery`, 'stub-token', {
      maxRetries: 0,
      backoffBaseMs: 10,
    })

    const ambiguous = await client.execute(realExecuteRequest(), { timeoutMs: 2_000 })
    expect(ambiguous.status).toBe('ok_with_data')
    // AQ-AMB-01：承载位=data.candidates；投影 id 确定性派生自 orderId；confirm 带精确 orderId
    expect(ambiguous.clarificationOptions?.map((o) => o.id)).toEqual([
      candidateOptionId(AMB_CANDIDATE_1_ID),
      candidateOptionId(AMB_CANDIDATE_2_ID),
    ])
    expect(ambiguous.clarificationOptions?.[0]?.detail).toMatchObject({ orderNo: 'ORDER-AQ-AMB-1', plantId: '5ac3b8ff-62ed-4c2b-84b1-28955e372cf3' })
    expect(ambiguous.clarificationOptions?.[0]?.confirm).toEqual({
      capabilityId: 'aq.order-progress',
      params: { orderRef: { kind: 'orderId', value: AMB_CANDIDATE_1_ID } },
    })
    // DS-21 wire 原形：freshness.sources[].source（键名与真实抓取一致）；contextEcho 原样透传且无顶层 timeRange
    expect(ambiguous.freshness.sources.map((s) => s.source)).toEqual(['production_order', 'order_operation', 'schedule_slot', 'production_report', 'report_output'])
    expect(ambiguous.contextEcho).toEqual(ambiguousEnvelope.contextEcho)
    expect('timeRange' in ambiguous.contextEcho).toBe(false)

    // 唯一命中路径（真实抓取原样，candidates=[]）→ 投影为空清单，answer 路径不受影响
    const uniqueHit = await client.execute({ ...realExecuteRequest(), params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } } }, { timeoutMs: 2_000 })
    expect(uniqueHit.status).toBe('ok_with_data')
    expect(uniqueHit.clarificationOptions).toEqual([])
  })
})

describe('A 线真实信封 × TurnOrchestrator 澄清流（DS-08/AQ-AMB-01 端到端）', () => {
  const dataDirs: string[] = []

  afterEach(() => {
    while (dataDirs.length > 0) {
      const dir = dataDirs.pop()
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ai-wire-e2e-'))
    dataDirs.push(dir)
    return dir
  }

  /** 真实信封回放条目（auditRef 缺省由实际请求回填；wire data.candidates 由 mock 同源投影）。 */
  function realEntry(envelope: typeof ambiguousEnvelope | typeof realEnvelope): MockQueryScriptEntry {
    const { status, data, completeness, freshness, contextEcho } = envelope
    return { envelope: { status: status as AiQueryResultStatus, data, completeness, freshness, contextEcho } }
  }

  it('AQ-AMB-01：真实 wire 信封（data.candidates 两候选）驱动澄清——编造选项被丢弃、确认带精确 orderId', async () => {
    const runtime = createAiRuntime({
      env: {},
      model: new MockModelClient({
        steps: [
          { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.order-progress', capabilityVersion: 1, params: { orderRef: { kind: 'orderNoLike', value: 'ORDER-AQ-AMB' } } }] },
          { kind: 'clarify', question: '模糊单号命中两张订单，请确认是哪一张？', optionIds: [candidateOptionId(AMB_CANDIDATE_1_ID), 'opt-invented'] },
        ],
      }),
      queryClient: new MockControlledQueryClient([realEntry(ambiguousEnvelope)], SAMPLE_CAPABILITIES_RESPONSE),
      dataDir: tempDir(),
    })
    void runtime.store.registerSession({ sessionId: 'sess-wire-1', enterpriseId: 'ent-1', userId: 'user-1', channel: 'web', conversationRef: null })

    const response = await runtime.orchestrator.runTurn({
      requestId: 'req-wire-amb',
      sessionId: 'sess-wire-1',
      userMessage: 'ORDER-AQ-AMB 的进度',
    })
    expect(response.outcome).toBe('clarify')
    expect(response.message).toContain('哪一张')
    expect(response.options).toHaveLength(1) // 编造 id 落选（DS-08：选项只能来自能力结果）
    expect(response.options?.[0]?.id).toBe(candidateOptionId(AMB_CANDIDATE_1_ID))
    expect(response.options?.[0]?.label).toContain('ORDER-AQ-AMB-1')
    expect(response.options?.[0]?.confirm?.params).toEqual({ orderRef: { kind: 'orderId', value: AMB_CANDIDATE_1_ID } })
    // AQ-AMB-04：澄清事件归档于同一 requestId
    const events = await runtime.store.listEvents('sess-wire-1')
    expect(events.some((event) => event.kind === 'clarify' && event.requestId === 'req-wire-amb')).toBe(true)
  })

  it('唯一命中路径：真实抓取信封（candidates=[]）经编排器正常作答，投影不引入澄清', async () => {
    const runtime = createAiRuntime({
      env: {},
      model: new MockModelClient({
        steps: [
          { kind: 'tool_calls', toolCalls: [{ capabilityId: 'aq.order-progress', capabilityVersion: 1, params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } } }] },
          { kind: 'answer', text: '订单 ORDER-AQ-1001 有 2 道当前版本工序，其中未完成 1 道。【解释非事实】' },
        ],
      }),
      queryClient: new MockControlledQueryClient([realEntry(realEnvelope)], SAMPLE_CAPABILITIES_RESPONSE),
      dataDir: tempDir(),
    })
    void runtime.store.registerSession({ sessionId: 'sess-wire-2', enterpriseId: 'ent-1', userId: 'user-1', channel: 'web', conversationRef: null })

    const response = await runtime.orchestrator.runTurn({
      requestId: 'req-wire-hit',
      sessionId: 'sess-wire-2',
      userMessage: 'ORDER-AQ-1001 的进度',
    })
    expect(response.outcome).toBe('answer')
    expect(response.answerRefs?.[0]).toMatchObject({ capabilityId: 'aq.order-progress', status: 'ok_with_data' })
    expect(response.answerRefs?.[0]?.auditRef).toEqual({ requestId: 'req-wire-hit', toolCallSeq: 1 })
    expect(response.answerRefs?.[0]?.freshness.sources.map((s) => s.source)).toEqual(['production_order', 'order_operation', 'schedule_slot', 'production_report', 'report_output'])
  })
})
