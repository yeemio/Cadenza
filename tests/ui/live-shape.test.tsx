// @vitest-environment jsdom
/**
 * live 形状对齐测试（stub fetch，不依赖真实网络）：
 * 用 contracts 类型 + 与 apps/api 实际响应形状一致的样本夹具（fixtures/live-samples.ts，
 * 逐文件核对 AuthController/OrgController/AllExceptionsFilter/OrgQueryService），
 * 验证 client 在 live 模式下：
 * 1. 登录：请求体带 platform、响应形状（tokenType Bearer/expiresAt/user.userId）；401 错误体 → ApiError 中文映射；
 * 2. /org/users 分页：查询参数 page/pageSize/loginNameLike + Bearer 头；PageResult/UserAccountDto 字段齐全（无 password 类字段）；
 * 3. 命令端点：x-operation-id 头 + body.reason（中文留痕不进头——浏览器 fetch 头仅收
 *    ISO-8859-1，2026-10-28 起全 client 统一并入请求体）；成功 {operationId,status,data}；422 业务拒绝 → ApiError（[OA-10] message 进 detail）；
 * 4. 401（非登录接口）触发 onUnauthorized；
 * 5. /org/nodes /org/roles /org/grants 查询形状与 kind/deptCategory/isSystem/principalType 字典值。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient, ApiError, errorText, formatErrorTitleAndDetail } from '@cadenza/ui'
import {
  SAMPLE_AUTH_ME,
  SAMPLE_COMMAND_OK,
  SAMPLE_ERROR_401,
  SAMPLE_ERROR_422,
  SAMPLE_GRANTS_PAGE,
  SAMPLE_LOGIN_401,
  SAMPLE_LOGIN_OK,
  SAMPLE_NODES_PAGE,
  SAMPLE_ROLES_PAGE,
  SAMPLE_USERS_PAGE,
} from './fixtures/live-samples'

interface Recorded {
  url: URL
  method: string
  headers: Record<string, string>
  body: unknown
}

/** 按序消费的 fetch stub：每条响应对应一次请求，全部消费完再请求即失败 */
function stubFetch(responses: Array<{ status: number; body: unknown }>): Recorded[] {
  const recorded: Recorded[] = []
  let index = 0
  const impl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input : new URL(String(input))
    recorded.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body !== undefined ? (JSON.parse(String(init.body)) as unknown) : undefined,
    })
    const next = responses[index]
    index += 1
    if (!next) throw new Error(`未预期的第 ${index} 次请求：${url.pathname}`)
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json', 'x-request-id': `req-${index}` },
    })
  }
  vi.stubGlobal('fetch', vi.fn(impl))
  return recorded
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const BASE = 'http://127.0.0.1:3001'
const TOKEN = SAMPLE_LOGIN_OK.token

function liveClient(onUnauthorized?: () => void) {
  return createApiClient({
    mode: 'live',
    baseURL: BASE,
    getToken: () => TOKEN,
    onUnauthorized,
  })
}

describe('live 形状对齐（auth）', () => {
  it('登录请求带 platform，响应为 {token,tokenType:Bearer,expiresAt,user:{userId,loginName}}；失败 401 → ApiError 中文主文案 + 服务端 message', async () => {
    const recorded = stubFetch([
      { status: 200, body: SAMPLE_LOGIN_OK },
      { status: 401, body: SAMPLE_LOGIN_401 },
    ])
    const client = createApiClient({ mode: 'live', baseURL: BASE })

    const ok = await client.login({ loginName: 'admin', password: 'CadAdmin001', platform: 'WEB' })
    expect(recorded[0]?.url.pathname).toBe('/auth/login')
    expect(recorded[0]?.method).toBe('POST')
    expect(recorded[0]?.body).toEqual({ loginName: 'admin', password: 'CadAdmin001', platform: 'WEB' })
    // 响应形状（编译期已按 LoginResponse 约束，运行时再断言关键值）
    expect(ok.tokenType).toBe('Bearer')
    expect(ok.token).toBe(SAMPLE_LOGIN_OK.token)
    expect(typeof ok.expiresAt).toBe('string')
    expect(Number.isNaN(Date.parse(ok.expiresAt))).toBe(false)
    expect(ok.user).toEqual({ userId: SAMPLE_LOGIN_OK.user.userId, loginName: 'admin' })

    // 失败：真实 401 错误体 {code,message,details} → ApiError + PC-14 组装
    const err = await client.login({ loginName: 'admin', password: 'WrongPassword1', platform: 'WEB' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    const apiErr = err as ApiError
    expect(apiErr.httpStatus).toBe(401)
    expect(apiErr.code).toBe('ERR_AUTH_REQUIRED')
    expect(errorText(apiErr.code)).toBe('请先登录：会话缺失或已过期，请重新登录')
    const formatted = formatErrorTitleAndDetail(apiErr)
    expect(formatted.detail).toContain('登录账号或密码错误')
  })

  it('/auth/me 响应含服务端计算的 permissions 与 dataScope（OA-23/25），请求携带 Bearer', async () => {
    const recorded = stubFetch([{ status: 200, body: SAMPLE_AUTH_ME }])
    const client = liveClient()
    const me = await client.me()
    expect(recorded[0]?.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    expect(me.user.loginName).toBe('admin')
    expect(me.user.enterpriseName).toBe('华东电缆集团')
    expect(me.permissions).toContain('org.admin')
    expect(me.dataScope.enterpriseWide).toBe(true)
    expect(Array.isArray(me.dataScope.plantIds)).toBe(true)
    expect(typeof me.session.expiresAt).toBe('string')
  })
})

describe('live 形状对齐（org 分页查询）', () => {
  it('/org/users：查询参数 page/pageSize/loginNameLike；PageResult/UserAccountDto 字段齐全且不含敏感字段', async () => {
    const recorded = stubFetch([{ status: 200, body: SAMPLE_USERS_PAGE }])
    const client = liveClient()
    const page = await client.listUsers({ page: 1, pageSize: 10, loginNameLike: 'admin' })
    const url = recorded[0]?.url
    expect(url?.pathname).toBe('/org/users')
    expect(url?.searchParams.get('page')).toBe('1')
    expect(url?.searchParams.get('pageSize')).toBe('10')
    expect(url?.searchParams.get('loginNameLike')).toBe('admin')
    expect(recorded[0]?.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    // 分页四元组
    expect(page.total).toBe(6)
    expect(page.page).toBe(1)
    expect(page.pageSize).toBe(10)
    // DTO 字段齐全（OA-27：无 password_hash 类敏感字段）
    const u = page.items[0]!
    for (const key of [
      'id', 'loginName', 'displayName', 'deptId', 'workshopDeptId', 'roleId',
      'loginPlatform', 'accountStatus', 'plantId', 'phone', 'failedLoginCount', 'lockedUntil', 'status',
    ] as const) {
      expect(u).toHaveProperty(key)
    }
    expect(Object.keys(u).some((k) => k.toLowerCase().includes('password'))).toBe(false)
    expect(u.loginPlatform === 'WEB' || u.loginPlatform === 'PDA').toBe(true)
    expect(u.accountStatus === 'enabled' || u.accountStatus === 'disabled').toBe(true)
  })

  it('/org/nodes|roles|grants：kind/deptCategory/isSystem/principalType 字典值与 PageResult 形状', async () => {
    const recorded = stubFetch([
      { status: 200, body: SAMPLE_NODES_PAGE },
      { status: 200, body: SAMPLE_ROLES_PAGE },
      { status: 200, body: SAMPLE_GRANTS_PAGE },
    ])
    const client = liveClient()
    const nodes = await client.listOrgNodes({ page: 1, pageSize: 100 })
    expect(nodes.items[0]?.kind).toBe('enterprise')
    const dept = nodes.items.find((n) => n.kind === 'department')
    expect(dept?.deptCategory).toBe(1) // OA-03：1=车间 2=质检部 3=物流部
    expect(typeof dept?.path).toBe('string')

    const roles = await client.listRoles({ page: 1, pageSize: 10 })
    expect(roles.items[0]?.isSystem).toBe(2) // OA-18：内置=2
    expect(roles.items[1]?.status).toBe('active')

    const grants = await client.listGrants({ principalType: 'role' })
    expect(grants.items[0]?.principalType).toBe('role')
    expect(grants.items[0]?.scopeType).toBe('enterprise')
    expect(grants.items[0]?.permissions).toContain('org.admin')
    expect(recorded[2]?.url.searchParams.get('principalType')).toBe('role')
  })
})

describe('live 形状对齐（命令端点与错误）', () => {
  it('POST /org/users：携带 x-operation-id 头与 body.reason（不发 x-reason 头）；成功 {operationId,status:COMMITTED,data}；422 业务拒绝 → ApiError（[OA-10] 进 detail）', async () => {
    const recorded = stubFetch([
      { status: 201, body: SAMPLE_COMMAND_OK },
      { status: 422, body: SAMPLE_ERROR_422 },
    ])
    const client = liveClient()
    const ok = await client.createUser(
      {
        loginName: 'newuser01',
        password: 'Newuser001',
        displayName: '新用户',
        deptId: 'dep-1',
        roleId: 'role-2',
        loginPlatform: 'PDA',
        accountStatus: 'enabled',
      },
      { reason: '管理员新建账号 newuser01' },
    )
    expect(recorded[0]?.method).toBe('POST')
    expect(recorded[0]?.url.pathname).toBe('/org/users')
    expect(typeof recorded[0]?.headers['x-operation-id']).toBe('string')
    // reason 统一并入 body（控制器 run() 优先读 payload.reason）；不再发 x-reason 头
    expect((recorded[0]?.body as Record<string, unknown>)['reason']).toBe('管理员新建账号 newuser01')
    expect(recorded[0]?.headers['x-reason']).toBeUndefined()
    expect(ok.status).toBe('COMMITTED')
    expect(ok.operationId).toBe(SAMPLE_COMMAND_OK.operationId)
    expect((ok.data as { loginName: string }).loginName).toBe('newuser01')

    const err = await client
      .createUser(
        {
          loginName: 'admin',
          password: 'Newuser001',
          displayName: '重复账号',
          deptId: 'dep-1',
          roleId: 'role-2',
          loginPlatform: 'PDA',
          accountStatus: 'enabled',
        },
        { reason: '重复账号测试' },
      )
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    const apiErr = err as ApiError
    expect(apiErr.httpStatus).toBe(422)
    expect(apiErr.code).toBe('ERR_BUSINESS_RULE')
    expect(errorText(apiErr.code)).toBe('业务规则校验未通过，请检查输入内容')
    const formatted = formatErrorTitleAndDetail(apiErr)
    expect(formatted.detail).toContain('[OA-10] 登录账号已存在：admin')
  })

  it('401（非登录接口）触发 onUnauthorized；401 错误体形状 {code,message,details}', async () => {
    const onUnauthorized = vi.fn()
    const recorded = stubFetch([{ status: 401, body: SAMPLE_ERROR_401 }])
    const client = liveClient(onUnauthorized)
    const err = await client.listUsers({ page: 1, pageSize: 10 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('ERR_AUTH_REQUIRED')
    expect((err as ApiError).details).toEqual({})
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(recorded[0]?.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
  })
})
