/**
 * 受控查询客户端合同测试（dsh-edge.md §4：DS-18～DS-22；DS-21 信封样例断言）。
 *
 * - MockControlledQueryClient：合同级回放（不经网络）与 DS-21 冻结信封样例逐字段一致；
 * - HttpControlledQueryClient：对进程内 stub 服务器断言请求形状（Bearer 内部令牌、
 *   execute 体六字段且无 tenant/user/scope 字段，AQ-REG-06）、5xx 有限重试
 *   同一 requestId+toolCallSeq 幂等重发（DS-22）、等待超时→timeout 信封不再重试（DS-09）、
 *   auditRef 漂移→ERR_ENVELOPE_AUDIT_REF_MISMATCH（DS-21 字段漂移守门）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  HttpControlledQueryClient,
  MockControlledQueryClient,
  ControlledQuerySessionError,
  candidateOptionId,
  deriveClarificationOptions,
} from '../../apps/ai/src/controlled-query-client'
import type { ExecuteRequest, MockQueryScriptEntry } from '../../apps/ai/src/controlled-query-client'
import {
  ENVELOPE_SAMPLES,
  SAMPLE_CAPABILITIES_RESPONSE,
  SAMPLE_EXECUTE_REQUEST,
  SAMPLE_ORDER_CANDIDATES,
  SAMPLE_REQUEST_ID,
} from './envelope-samples'
import type { ToolResult } from '../../packages/integrations/dsh'

interface StubCall {
  path: string
  authorization: string | undefined
  body: Record<string, unknown>
}

describe('MockControlledQueryClient（DS-21 合同级回放）', () => {
  it('回放信封与七状态冻结样例逐字段一致（auditRef 由实际请求回填；澄清候选=wire data.candidates 投影）', async () => {
    const statuses = Object.keys(ENVELOPE_SAMPLES) as Array<keyof typeof ENVELOPE_SAMPLES>
    expect(statuses).toHaveLength(7)
    for (const status of statuses) {
      const template = ENVELOPE_SAMPLES[status]
      const entry: MockQueryScriptEntry = {
        envelope: { status: template.status, data: template.data, completeness: template.completeness, freshness: template.freshness, contextEcho: template.contextEcho, ...(template.failure !== undefined ? { failure: template.failure } : {}) },
      }
      const client = new MockControlledQueryClient([entry], SAMPLE_CAPABILITIES_RESPONSE)
      const result = await client.execute({ ...SAMPLE_EXECUTE_REQUEST, params: { ...SAMPLE_EXECUTE_REQUEST.params } }, { timeoutMs: 1_000 })
      // mock 与 HTTP 客户端同一映射：ok_with_data（data.candidates 非空）投影出澄清候选
      const expectedClarification = deriveClarificationOptions(template.data, SAMPLE_EXECUTE_REQUEST.capabilityId)
      const expected: ToolResult = {
        ...template,
        auditRef: { requestId: SAMPLE_REQUEST_ID, toolCallSeq: 1 },
        ...(expectedClarification !== undefined ? { clarificationOptions: expectedClarification } : {}),
      }
      expect(result).toEqual(expected)
    }
  })

  it('capabilities 返回 DS-18 形状（三能力+未就绪问法族）；received 记录取参数', async () => {
    const client = new MockControlledQueryClient([], SAMPLE_CAPABILITIES_RESPONSE)
    const capabilities = await client.listCapabilities(SAMPLE_EXECUTE_REQUEST.sessionId)
    expect(capabilities.capabilities.map((c) => c.capabilityId)).toEqual(['aq.order-progress', 'aq.material-shortage', 'aq.quality'])
    expect(capabilities.unreadyTopics).toHaveLength(4)
    await client.execute({ ...SAMPLE_EXECUTE_REQUEST }, { timeoutMs: 1_000 })
    expect(client.received).toHaveLength(1)
    expect(client.received[0]?.capabilityId).toBe('aq.order-progress')
  })

  it('脚本耗尽→failed 可理解状态（不伪装 ok_no_records，AQ-REG-10）', async () => {
    const client = new MockControlledQueryClient([], SAMPLE_CAPABILITIES_RESPONSE)
    const result = await client.execute({ ...SAMPLE_EXECUTE_REQUEST }, { timeoutMs: 1_000 })
    expect(result.status).toBe('failed')
    expect(result.failure?.code).toBe('ERR_QUERY_SCRIPT_EXHAUSTED')
  })
})

describe('HttpControlledQueryClient（DS-18/19/22 传输合同）', () => {
  let server: Server
  let port = 0
  const calls: StubCall[] = []
  /** 每条路径的行为脚本（按调用次序消费）。 */
  const behavior: Record<string, Array<(body: Record<string, unknown>) => { status: number; body: unknown } | { status: number; body: unknown; delayMs: number }>> = {
    '/internal/aiquery/capabilities': [],
    '/internal/aiquery/execute': [],
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        calls.push({ path: req.url ?? '', authorization: req.headers['authorization'], body })
        const script = behavior[req.url ?? ''] ?? []
        const action = script.shift() ?? ((): { status: number; body: unknown } => ({ status: 404, body: { code: 'ERR_NOT_FOUND' } }))
        const result = action(body)
        if ('delayMs' in result) {
          setTimeout(() => {
            res.writeHead(result.status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result.body))
          }, result.delayMs)
        } else {
          res.writeHead(result.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result.body))
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function makeClient(retry = { maxRetries: 1, backoffBaseMs: 20 }): HttpControlledQueryClient {
    return new HttpControlledQueryClient(`http://127.0.0.1:${String(port)}/internal/aiquery`, 'stub-internal-token', retry)
  }

  it('capabilities：Bearer 内部令牌 + sessionId 体；404→ERR_AI_SESSION_NOT_FOUND 会话错误', async () => {
    behavior['/internal/aiquery/capabilities'] = [
      () => ({ status: 200, body: SAMPLE_CAPABILITIES_RESPONSE }),
      () => ({ status: 404, body: { code: 'ERR_AI_SESSION_NOT_FOUND', message: '会话不存在或已失效' } }),
    ]
    const client = makeClient()
    const ok = await client.listCapabilities('sess-x')
    expect(ok.capabilities).toHaveLength(3)
    expect(calls.at(-1)?.authorization).toBe('Bearer stub-internal-token')
    expect(calls.at(-1)?.body).toEqual({ sessionId: 'sess-x' })
    await expect(client.listCapabilities('sess-gone')).rejects.toMatchObject({
      code: 'ERR_AI_SESSION_NOT_FOUND',
    })
    expect(ControlledQuerySessionError.name).toBe('ControlledQuerySessionError')
  })

  it('execute：请求体恰为 DS-19 六字段（无 tenant/user/scope 字段，AQ-REG-06）且 200 信封原样解析', async () => {
    behavior['/internal/aiquery/execute'] = [() => ({ status: 200, body: ENVELOPE_SAMPLES['ok_with_data'] })]
    const client = makeClient()
    const request: ExecuteRequest = { ...SAMPLE_EXECUTE_REQUEST }
    const result = await client.execute(request, { timeoutMs: 2_000 })
    expect(result.status).toBe('ok_with_data')
    expect(result.auditRef).toEqual({ requestId: request.requestId, toolCallSeq: request.toolCallSeq })
    // AQ-AMB-01：澄清候选承载位=wire data.candidates，解析层映射为内部投影（id 确定性派生自 orderId）
    expect(result.clarificationOptions?.map((o) => o.id)).toEqual(SAMPLE_ORDER_CANDIDATES.map((c) => candidateOptionId(c.orderId)))
    expect(result.clarificationOptions?.[0]?.confirm).toEqual({
      capabilityId: 'aq.order-progress',
      params: { orderRef: { kind: 'orderId', value: SAMPLE_ORDER_CANDIDATES[0].orderId } },
    })
    // DS-21 wire 原形：freshness.sources[].source 键；contextEcho 13 字段富形状、无顶层 timeRange
    expect(result.freshness.sources).toEqual([
      { source: 'production_order', updatedAt: '2026-10-27T09:30:00.000Z' },
      { source: 'order_operation', updatedAt: 'unknown' },
    ])
    expect(Object.keys(result.contextEcho).sort()).toEqual(
      ['capabilityId', 'capabilityVersion', 'channel', 'dataScope', 'effectiveFilters', 'enterpriseId', 'factColumns', 'ignoredRequestFields', 'notes', 'requestId', 'sessionId', 'toolCallSeq', 'userId'],
    )
    expect('timeRange' in result.contextEcho).toBe(false)
    const sent = calls.at(-1)?.body
    expect(Object.keys(sent ?? {}).sort()).toEqual(['capabilityId', 'capabilityVersion', 'params', 'requestId', 'sessionId', 'toolCallSeq'])
    expect(sent?.['requestId']).toBe(request.requestId)
  })

  it('DS-22 幂等重试：5xx 后同一 requestId+toolCallSeq 原样重发；成功后停', async () => {
    behavior['/internal/aiquery/execute'] = [
      () => ({ status: 500, body: { code: 'ERR_INTERNAL', message: 'x' } }),
      () => ({ status: 200, body: ENVELOPE_SAMPLES['ok_no_records'] }),
    ]
    const client = makeClient({ maxRetries: 2, backoffBaseMs: 10 })
    const request: ExecuteRequest = { ...SAMPLE_EXECUTE_REQUEST }
    const result = await client.execute(request, { timeoutMs: 2_000 })
    expect(result.status).toBe('ok_no_records')
    const executeCalls = calls.filter((c) => c.path === '/internal/aiquery/execute').slice(-2)
    expect(executeCalls).toHaveLength(2)
    expect(executeCalls[0]?.body).toEqual(executeCalls[1]?.body) // 同一执行载荷逐字重发
  })

  it('DS-22 重试耗尽→failed（带阶段码），不伪装成功', async () => {
    behavior['/internal/aiquery/execute'] = [
      () => ({ status: 503, body: { code: 'ERR_AI_UPSTREAM_UNAVAILABLE', message: '上游不可用' } }),
      () => ({ status: 503, body: { code: 'ERR_AI_UPSTREAM_UNAVAILABLE', message: '上游不可用' } }),
    ]
    const client = makeClient({ maxRetries: 1, backoffBaseMs: 10 })
    const result = await client.execute({ ...SAMPLE_EXECUTE_REQUEST }, { timeoutMs: 2_000 })
    expect(result.status).toBe('failed')
    expect(result.failure?.stage).toBe('query')
    expect(result.failure?.code).toBe('ERR_AI_UPSTREAM_UNAVAILABLE')
  })

  it('DS-09 等待超时→timeout 信封且不再重试（单次尝试即停）', async () => {
    behavior['/internal/aiquery/execute'] = [
      () => ({ status: 200, body: ENVELOPE_SAMPLES['ok_with_data'], delayMs: 700 }),
      () => ({ status: 200, body: ENVELOPE_SAMPLES['ok_with_data'] }),
    ]
    const client = makeClient({ maxRetries: 2, backoffBaseMs: 10 })
    const before = calls.filter((c) => c.path === '/internal/aiquery/execute').length
    const result = await client.execute({ ...SAMPLE_EXECUTE_REQUEST }, { timeoutMs: 150 })
    expect(result.status).toBe('timeout')
    expect(result.failure?.code).toBe('ERR_QUERY_WAIT_TIMEOUT')
    expect(calls.filter((c) => c.path === '/internal/aiquery/execute').length).toBe(before + 1) // 超时后未重试
  })

  it('DS-21 字段漂移守门：auditRef 不一致→failed(ERR_ENVELOPE_AUDIT_REF_MISMATCH)；status 非法→ERR_ENVELOPE_INVALID', async () => {
    behavior['/internal/aiquery/execute'] = [
      () => ({ status: 200, body: { ...ENVELOPE_SAMPLES['ok_with_data'], auditRef: { requestId: 'other', toolCallSeq: 9 } } }),
      () => ({ status: 200, body: { ...ENVELOPE_SAMPLES['ok_with_data'], status: 'weird_status' } }),
    ]
    const client = makeClient({ maxRetries: 0, backoffBaseMs: 10 })
    const mismatch = await client.execute({ ...SAMPLE_EXECUTE_REQUEST }, { timeoutMs: 2_000 })
    expect(mismatch.status).toBe('failed')
    expect(mismatch.failure?.code).toBe('ERR_ENVELOPE_AUDIT_REF_MISMATCH')
    const invalid = await client.execute({ ...SAMPLE_EXECUTE_REQUEST }, { timeoutMs: 2_000 })
    expect(invalid.failure?.code).toBe('ERR_ENVELOPE_INVALID')
  })

  it('非 2xx 统一错误形状透传 code（先例 AllExceptionsFilter ERR_ 前缀）', async () => {
    behavior['/internal/aiquery/execute'] = [() => ({ status: 422, body: { code: 'ERR_AI_QUERY_PARAMS_INVALID', message: '参数非法' } })]
    const client = makeClient({ maxRetries: 0, backoffBaseMs: 10 })
    const result = await client.execute({ ...SAMPLE_EXECUTE_REQUEST }, { timeoutMs: 2_000 })
    expect(result.status).toBe('failed')
    expect(result.failure?.code).toBe('ERR_AI_QUERY_PARAMS_INVALID')
  })
})
