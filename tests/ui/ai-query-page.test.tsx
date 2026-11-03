// @vitest-environment jsdom
/**
 * 问数页流程测试（P4-UI 线；DS-23 四态 outcome + 澄清流 + 降级态 + 无权限态）：
 * - answer：结果卡片渲染（信封六段见 ai-query-card.test）；
 * - clarify：结构化选项（重名订单候选 AQ-AMB-01）→ 选择后带精确参数重发；
 * - unavailable：降级态文案 + 原因类别（AR-11）+ 不影响其它生产功能区文案；
 * - cancelled：在途取消 → 取消确认（DS-11）；
 * - 无权限态（aiquery.use 缺失）：提示 + 业务页面引导（AQ-AUTH-02）；
 * - 入口降级态：健康探测不可用（starting）→ 输入禁用 + 可重试。
 * mock 场景脚本见 packages/ui/src/api/p4/mock.ts 文件头（关键字路由）。
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { AiQueryPage } from '../../apps/web/src/p4/pages/AiQueryPage'
import { resetMockAiQueryState, setMockAiQueryHealth } from '../../packages/ui/src/api/p4'

const SESSION_KEY = 'cadenza.web.session'

function seedSession(permissions: string[]): void {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: 'mock-token-test',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: {
        userId: 'user-s-1',
        loginName: 'admin',
        displayName: '系统管理员',
        enterpriseId: 'n-ent',
        enterpriseName: '中辰线缆集团',
        plantId: 'n-plant',
        plantName: '杭州制造工厂',
        roleId: 'role-admin',
        roleName: '系统管理员',
        loginPlatform: 'WEB',
      },
      permissions,
      dataScope: { enterpriseWide: true, plantIds: ['n-plant'] },
    }),
  )
}

const AI_PERMISSIONS = ['aiquery.use', 'process.read', 'inventory.read', 'quality.read']

function renderPage(permissions: string[] = AI_PERMISSIONS): ReturnType<typeof render> {
  seedSession(permissions)
  return render(
    <MemoryRouter>
      <AuthProvider>
        <AiQueryPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  localStorage.removeItem(SESSION_KEY)
  resetMockAiQueryState()
})

async function ask(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.type(screen.getByLabelText('问数输入'), text)
  await user.click(screen.getByRole('button', { name: /发起问数/ }))
}

describe('answer：提问 → 结果卡片', () => {
  it('默认场景渲染信封卡片（五量原样 + 详情链接）与 AI 解释区分块', async () => {
    const user = userEvent.setup()
    renderPage()
    await ask(user, 'ORDER-AQ-1001 做到哪一步了')
    expect(await screen.findByTestId('ai-result-card')).toBeInTheDocument()
    expect(screen.getByTestId('ai-explain-note')).toHaveTextContent('AI 解释（解释非事实')
    expect(screen.getAllByText('80.0000 KM').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('link', { name: '查看订单详情' })).toHaveAttribute('href', '/production/orders/po-1001')
    // 用户提问轮呈现（会话轮次上下文）
    expect(screen.getByText('ORDER-AQ-1001 做到哪一步了')).toBeInTheDocument()
  })
})

describe('clarify：重名订单候选 → 选择后带精确参数重发（AQ-AMB-01）', () => {
  it('SC-2026-1024 呈现两候选，选择其一后出现结果卡片', async () => {
    const user = userEvent.setup()
    renderPage()
    await ask(user, 'SC-2026-1024 做到哪一步了')
    const panel = await screen.findByTestId('ai-clarify-panel')
    expect(panel).toHaveTextContent('命中的订单不止一张')
    expect(withinText(panel, '不会自行替您择一作答')).toBe(true)
    const option2 = await screen.findByRole('button', { name: /ORDER-AQ-1002（合肥线缆厂）/ })
    await user.click(option2)
    // 选择后带精确参数重发 → answer 卡片（按所选订单）
    expect(await screen.findByTestId('ai-result-card')).toBeInTheDocument()
    expect(screen.getByText(/已按您选择的订单 ORDER-AQ-1002 重新执行/)).toBeInTheDocument()
    expect(screen.getByText('已选择：ORDER-AQ-1002（合肥线缆厂）')).toBeInTheDocument()
    // 旧的澄清面板已非最后一轮 → 禁用
    const oldOption = screen.getByRole('button', { name: /ORDER-AQ-1001（杭州制造工厂）/ })
    expect(oldOption).toBeDisabled()
  })
})

describe('unavailable：降级态 + 原因类别（AR-11）', () => {
  it('超限场景：暂不可用 + 原因「已超出 AI 问数使用限额」+ 生产业务不受影响', async () => {
    const user = userEvent.setup()
    renderPage()
    await ask(user, '超限演示')
    const notice = await screen.findByTestId('ai-unavailable-notice')
    expect(notice).toHaveTextContent('AI 问数暂不可用')
    expect(notice).toHaveTextContent('原因：已超出 AI 问数使用限额')
    expect(notice).toHaveTextContent('生产业务（报工/质检/库存等）不受影响')
    expect(notice).toHaveTextContent('[AR-11]')
  })

  it('超时场景：阶段细节附注（timeout/single_query）+ 部分数据完整性标注', async () => {
    const user = userEvent.setup()
    renderPage()
    await ask(user, '超时演示')
    const notice = await screen.findByTestId('ai-unavailable-notice')
    expect(notice).toHaveTextContent('查询超时')
    expect(notice).toHaveTextContent('阶段细节：status=timeout；scope=single_query')
    // 已取部分数据随附（信封 timeout 态卡片 + 未取全标注）
    expect(await screen.findByTestId('ai-result-card')).toBeInTheDocument()
    expect(screen.getByTestId('ai-completeness')).toHaveTextContent('总量未知（未取全，不构成完整总量）')
  })
})

describe('cancelled：在途取消（DS-11）', () => {
  it('慢速轮在途时取消 → 「本轮已取消」确认', async () => {
    const user = userEvent.setup()
    renderPage()
    await ask(user, '慢速演示')
    const cancelBtn = await screen.findByRole('button', { name: '取消本轮' })
    await user.click(cancelBtn)
    expect(await screen.findByText('本轮已取消')).toBeInTheDocument()
    expect(screen.getByText(/发起新的工具调用/)).toBeInTheDocument()
    // 等待延迟轮次回执落地（去重后不追加第二个取消确认）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200))
    })
    expect(screen.getAllByText('本轮已取消').length).toBe(1)
  })
})

describe('无权限态（AQ-AUTH-02）', () => {
  it('缺 aiquery.use：无权限提示 + 业务页面引导，输入区不出现', () => {
    renderPage(['process.read'])
    expect(screen.getByText('无 AI 问数权限（aiquery.use）')).toBeInTheDocument()
    expect(screen.getByText(/请联系管理员授权（AQ-AUTH-02）/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '生产订单' })).toHaveAttribute('href', '/production/orders')
    expect(screen.getByRole('link', { name: '库存余额' })).toHaveAttribute('href', '/inventory/balances')
    expect(screen.queryByLabelText('问数输入')).toBeNull()
  })

  it('服务端 403 规则码映射：可行动中文主文案 + 服务端原文 detail', async () => {
    const user = userEvent.setup()
    renderPage()
    await ask(user, '无权限演示')
    expect(await screen.findByText('无 AI 问数权限（aiquery.use）或缺少对应业务域读权限，请联系管理员授权后再使用')).toBeInTheDocument()
    expect(screen.getByText(/\[AQ-AUTH-02\]/)).toBeInTheDocument()
  })
})

describe('入口降级态：健康探测不可用（经接入层代理面）', () => {
  it('starting：暂不可用横幅 + 输入禁用 + 可重试；重试恢复后可提问', async () => {
    setMockAiQueryHealth({ status: 'unavailable', reason: 'starting', message: 'AI 问数暂不可用：服务正在启动 [AR-11]' })
    const user = userEvent.setup()
    renderPage()
    const notice = await screen.findByTestId('ai-unavailable-notice')
    expect(notice).toHaveTextContent('AI 问数暂不可用')
    expect(notice).toHaveTextContent('原因：AI 服务正在启动，请稍候')
    expect(screen.getByLabelText('问数输入')).toBeDisabled()
    // 重试 → 健康恢复 → 输入可用
    setMockAiQueryHealth({ status: 'ok', runtime: { kind: 'mock', version: 'mock-1', profileRef: null } })
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitForInputEnabled()
    expect(screen.getByLabelText('问数输入')).toBeEnabled()
  })
})

/** 面板文本包含断言辅助（within 需组件级；这里用简单 includes） */
function withinText(container: HTMLElement, text: string): boolean {
  return container.textContent !== null && container.textContent.includes(text)
}

async function waitForInputEnabled(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300))
  })
}
