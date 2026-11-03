// @vitest-environment jsdom
/**
 * IM 绑定码面板（接缝 5 web 签发入口）测试（2026-10-30 P4 五内部接缝补齐）：
 * - 签发：点按「生成绑定码」→ POST /aiquery/im/binding-codes（带登录令牌）→
 *   明文码一次性展示 + 有效期文案（服务端只存摘要的提示语）；
 * - 状态：查看清单（issued/used/revoked/expired 中文态）+ 撤销操作（:id/revoke 后刷新）；
 * - 失败态：非 2xx → 错误消息呈现（不静默）。
 * fetch 全程 stub（面板无自动加载——不影响既有问数页用例）。
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImBindingCodePanel } from '../../apps/web/src/p4/binding/ImBindingCodePanel'

const SESSION_KEY = 'cadenza.web.session'

interface FetchCall {
  url: string
  method: string
  authorization: string | null
}

let calls: FetchCall[] = []
let respond: ((input: FetchCall) => { status: number; body: unknown }) | null = null

function stubFetch(handler: (input: FetchCall) => { status: number; body: unknown }): void {
  respond = handler
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const authorization = (() => {
        const header = init?.headers
        if (header === undefined) return null
        if (Array.isArray(header)) {
          const found = header.find(([k]) => k.toLowerCase() === 'authorization')
          return found ? (found[1] as string) : null
        }
        if (typeof header === 'object' && header !== null && 'Authorization' in header) {
          return String((header as Record<string, string>)['Authorization'])
        }
        return null
      })()
      const call: FetchCall = { url: String(url), method: init?.method ?? 'GET', authorization }
      calls.push(call)
      const result = respond!(call)
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.body,
      } as Response
    }),
  )
}

function seedSession(): void {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: 'token-binding-test',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: { userId: 'u-1', loginName: 'admin', displayName: '管理员', enterpriseId: 'e-1', enterpriseName: '企业', plantId: 'p-1', plantName: '工厂', roleId: 'r-1', roleName: '系统管理员', loginPlatform: 'WEB' },
      permissions: ['aiquery.use'],
      dataScope: { enterpriseWide: true, plantIds: ['p-1'] },
    }),
  )
}

beforeEach(() => {
  calls = []
  seedSession()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('IM 绑定码面板：签发（接缝 5 web 入口）', () => {
  it('点按生成 → 携带登录令牌 POST → 明文码一次性展示与有效期提示', async () => {
    stubFetch(() => ({
      status: 201,
      body: { id: 'b-1', code: 'A2BJ-7KQM', expiresAt: '2026-10-30T12:10:00.000Z', status: 'issued' },
    }))
    const user = userEvent.setup()
    render(<ImBindingCodePanel />)
    await user.click(screen.getByTestId('im-binding-code-issue'))
    const issued = await screen.findByTestId('im-binding-code-issued')
    expect(screen.getByTestId('im-binding-code-value')).toHaveTextContent('A2BJ-7KQM')
    expect(issued).toHaveTextContent('仅此一次显示')
    expect(calls.length).toBe(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toContain('/aiquery/im/binding-codes')
    expect(calls[0]!.authorization).toBe('Bearer token-binding-test')
  })

  it('签发失败（403 无权限）→ 错误消息呈现，不静默', async () => {
    stubFetch(() => ({ status: 403, body: { code: 'ERR_FORBIDDEN', message: '缺少 aiquery.use 许可' } }))
    const user = userEvent.setup()
    render(<ImBindingCodePanel />)
    await user.click(screen.getByTestId('im-binding-code-issue'))
    expect(await screen.findByText(/缺少 aiquery.use 许可/)).toBeInTheDocument()
    expect(screen.queryByTestId('im-binding-code-issued')).toBeNull()
  })
})

describe('IM 绑定码面板：状态清单与撤销', () => {
  it('查看状态 → GET 清单渲染四态中文标签；issued 行可撤销（:id/revoke 后刷新）', async () => {
    stubFetch((input) => {
      if (input.method === 'GET') {
        return {
          status: 200,
          body: {
            items: [
              { id: 'b-1', status: 'issued', issuedAt: '2026-10-30T12:00:00.000Z', expiresAt: '2026-10-30T12:10:00.000Z', usedAt: null, usedChannel: null, usedPlatformUserId: null, revokedAt: null },
              { id: 'b-0', status: 'used', issuedAt: '2026-10-29T12:00:00.000Z', expiresAt: '2026-10-29T12:10:00.000Z', usedAt: '2026-10-29T12:01:00.000Z', usedChannel: 'mock', usedPlatformUserId: 'u-im-9', revokedAt: null },
              { id: 'b-2', status: 'revoked', issuedAt: '2026-10-28T12:00:00.000Z', expiresAt: '2026-10-28T12:10:00.000Z', usedAt: null, usedChannel: null, usedPlatformUserId: null, revokedAt: '2026-10-28T12:05:00.000Z' },
              { id: 'b-3', status: 'expired', issuedAt: '2026-10-27T12:00:00.000Z', expiresAt: '2026-10-27T12:10:00.000Z', usedAt: null, usedChannel: null, usedPlatformUserId: null, revokedAt: null },
            ],
            total: 4,
          },
        }
      }
      return { status: 200, body: { id: 'b-1', status: 'revoked' } }
    })
    const user = userEvent.setup()
    render(<ImBindingCodePanel />)
    await user.click(screen.getByTestId('im-binding-code-refresh'))
    const list = await screen.findByTestId('im-binding-code-list')
    expect(list).toHaveTextContent('待使用')
    expect(list).toHaveTextContent('已使用')
    expect(list).toHaveTextContent('已撤销')
    expect(list).toHaveTextContent('已过期')
    expect(list).toHaveTextContent('mock / u-im-9')

    await user.click(screen.getAllByRole('button', { name: '撤销' })[0]!)
    await waitFor(() => {
      const revokeCall = calls.find((c) => c.method === 'POST' && c.url.includes('/revoke'))
      expect(revokeCall).toBeDefined()
      expect(revokeCall!.url).toContain(encodeURIComponent('b-1'))
    })
    // 撤销后刷新清单（GET 二次调用）
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'GET').length).toBe(2)
    })
  })

  it('清单为空 → 空态文案；撤销失败（422）→ 错误呈现不静默', async () => {
    const emptyRows: Array<Record<string, unknown>> = []
    let rows = emptyRows
    stubFetch((input) => {
      if (input.method === 'GET') {
        return { status: 200, body: { items: rows, total: rows.length } }
      }
      if (input.url.includes('/revoke')) {
        return { status: 422, body: { code: 'ERR_BUSINESS_RULE', message: '撤销失败：已不可撤销' } }
      }
      return { status: 200, body: {} }
    })
    const user = userEvent.setup()
    render(<ImBindingCodePanel />)
    await user.click(screen.getByTestId('im-binding-code-refresh'))
    expect(await screen.findByText('暂无绑定码记录')).toBeInTheDocument()

    // 切换为含 issued 行的清单 → 撤销失败路径
    rows = [
      { id: 'b-9', status: 'issued', issuedAt: '2026-10-30T12:00:00.000Z', expiresAt: '2026-10-30T12:10:00.000Z', usedAt: null, usedChannel: null, usedPlatformUserId: null, revokedAt: null },
    ]
    await act(async () => {
      await user.click(screen.getByTestId('im-binding-code-refresh'))
    })
    const revokeButton = await screen.findByRole('button', { name: '撤销' })
    await user.click(revokeButton)
    expect(await screen.findByText(/撤销失败：已不可撤销/)).toBeInTheDocument()
  })
})
