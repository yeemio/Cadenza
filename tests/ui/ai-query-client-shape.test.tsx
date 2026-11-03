// @vitest-environment jsdom
/**
 * 问数客户端 live 形状测试（P4-UI 线；stub fetch，不经网络——先例 live-shape 模式）：
 * - 端点经接入层（/aiquery/*），无 apps/ai 直连面（AR-03/04）；
 * - 会话登记体 {channel}（A 线已实现端点）；问数轮体不含 tenant/user/scope 字段（AQ-REG-06 同则）；
 * - Bearer 鉴权与 401 回调；统一错误体 {code,message,details} → ApiError；
 * - health 503 不抛错（降级判定源）：unreachable/over_limit/starting 透传（AR-11/DS-24）；
 * - 规则码提取与中文映射（[AQ-xx-x]/[AR-xx-x]；未知码回退既有映射）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aiQueryRuleCodeOf,
  createAiQueryClient,
  formatAiQueryError,
  type AiAskTurnResponseDto,
} from '../../packages/ui/src/api/p4'

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function stubFetch(responses: Array<{ status: number; body: unknown }>): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  let call = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    captured.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body !== undefined ? (JSON.parse(String(init.body)) as unknown) : undefined,
    })
    const resp = responses[Math.min(call, responses.length - 1)] ?? { status: 200, body: {} }
    call += 1
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: { 'Content-Type': 'application/json', 'x-request-id': `rid-${call}` },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return captured
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function makeClient(onUnauthorized?: () => void) {
  return createAiQueryClient({
    mode: 'live',
    baseURL: 'http://api.test',
    getToken: () => 'tok-123',
    onUnauthorized,
  })
}

describe('端点形状（经接入层，AR-03/04）', () => {
  it('openSession：POST /aiquery/sessions，体 {channel}，Bearer 头', async () => {
    const captured = stubFetch([{ status: 201, body: { sessionId: 's-1', enterpriseId: 'e-1', userId: 'u-1', channel: 'web', status: 'open' } }])
    const client = makeClient()
    const resp = await client.openSession({ channel: 'web' })
    expect(resp.sessionId).toBe('s-1')
    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toBe('http://api.test/aiquery/sessions')
    expect(captured[0]?.method).toBe('POST')
    expect(captured[0]?.headers['Authorization']).toBe('Bearer tok-123')
    expect(captured[0]?.body).toEqual({ channel: 'web' })
  })

  it('askTurn：POST /aiquery/turns；体恰四字段且不含 tenant/user/scope（AQ-REG-06 同则）', async () => {
    const turn: AiAskTurnResponseDto = {
      requestId: 'rq-1',
      outcome: 'answer',
      message: 'ok',
      envelope: null,
      options: null,
      unavailableReason: null,
      statusDetail: null,
    }
    const captured = stubFetch([{ status: 200, body: turn }])
    const client = makeClient()
    const resp = await client.askTurn({ requestId: 'rq-1', sessionId: 's-1', userMessage: '问题', clarifyOptionId: null })
    expect(resp.outcome).toBe('answer')
    const body = captured[0]?.body as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['clarifyOptionId', 'requestId', 'sessionId', 'userMessage'])
    expect(JSON.stringify(body)).not.toMatch(/tenant|enterprise|userId|plantId|scope|dataScope/i)
  })

  it('cancelTurn：POST /aiquery/turns/:requestId/cancel（路径编码）', async () => {
    const captured = stubFetch([{ status: 200, body: { status: 'cancelled', decision: 'cancelled_in_flight' } }])
    const client = makeClient()
    const resp = await client.cancelTurn('rq/含斜杠')
    expect(resp.status).toBe('cancelled')
    expect(captured[0]?.url).toBe('http://api.test/aiquery/turns/rq%2F%E5%90%AB%E6%96%9C%E6%9D%A0/cancel')
  })
})

describe('健康探测（AR-11 降级判定源，503 不抛错）', () => {
  it('200 ok 透传 runtime 声明', async () => {
    stubFetch([{ status: 200, body: { status: 'ok', runtime: { kind: 'mock', version: 'mock-1' } } }])
    const client = makeClient()
    const resp = await client.health()
    expect(resp.status).toBe('ok')
  })

  it('503 over_limit 透传原因类别（DS-24）；网络失败 → unreachable', async () => {
    stubFetch([{ status: 503, body: { status: 'unavailable', reason: 'over_limit', message: '已超限 [AR-11]' } }])
    const client = makeClient()
    const resp = await client.health()
    expect(resp.status).toBe('unavailable')
    expect(resp).toMatchObject({ reason: 'over_limit', message: '已超限 [AR-11]' })

    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const resp2 = await client.health()
    expect(resp2).toMatchObject({ status: 'unavailable', reason: 'unreachable' })
  })
})

describe('错误形状与鉴权回调', () => {
  it('非 2xx {code,message,details} → ApiError；requestId 采集', async () => {
    stubFetch([{ status: 404, body: { code: 'ERR_AI_SESSION_NOT_FOUND', message: '问数会话不存在或已失效', details: null } }])
    const client = makeClient()
    await expect(client.askTurn({ requestId: 'rq-9', sessionId: 'nope', userMessage: 'x', clarifyOptionId: null })).rejects.toMatchObject({
      name: 'ApiError',
      code: 'ERR_AI_SESSION_NOT_FOUND',
      httpStatus: 404,
      requestId: 'rid-1',
    })
  })

  it('401 触发 onUnauthorized 并抛 ApiError', async () => {
    const onUnauthorized = vi.fn()
    stubFetch([{ status: 401, body: { code: 'ERR_AUTH_REQUIRED', message: '请先登录' } }])
    const client = makeClient(onUnauthorized)
    await expect(client.openSession({ channel: 'web' })).rejects.toMatchObject({ code: 'ERR_AUTH_REQUIRED' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })
})

describe('规则码映射（[AQ-xx-x]/[AR-xx-x]）', () => {
  it('提取规则码；已收录 → 可行动中文主文案 + 服务端原文 detail', () => {
    expect(aiQueryRuleCodeOf('命中的订单不止一张 [AQ-AMB-01]')).toBe('AQ-AMB-01')
    expect(aiQueryRuleCodeOf('AI 问数暂不可用 [AR-11]')).toBe('AR-11')
    expect(aiQueryRuleCodeOf('无规则码')).toBeNull()
    const formatted = formatAiQueryError({ code: 'ERR_FORBIDDEN', message: '无 AI 问数权限（aiquery.use）[AQ-AUTH-02]', requestId: 'rq-x' })
    expect(formatted.title).toBe('无 AI 问数权限（aiquery.use）或缺少对应业务域读权限，请联系管理员授权后再使用')
    expect(formatted.detail).toContain('[AQ-AUTH-02]')
    expect(formatted.detail).toContain('请求标识：rq-x')
  })

  it('未知规则码/平台错误码回退既有映射（不回归）', () => {
    const fallback = formatAiQueryError({ code: 'ERR_BUSINESS_RULE', message: 'channel 非法：xxx（须为 web/pda 之一）' })
    expect(fallback.title).toBe('业务规则校验未通过，请检查输入内容') // ERROR_MESSAGES_ZH 平台码回退
    expect(fallback.detail).toContain('channel 非法')
  })
})
