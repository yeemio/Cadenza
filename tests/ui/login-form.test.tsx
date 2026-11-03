// @vitest-environment jsdom
/**
 * 登录表单测试（apps/web LoginPage，mock 客户端）：
 * - 空字段校验；
 * - 失败错误提示（含剩余次数与失败锁定文案口径，OA-16）；
 * - 连续失败达到阈值 → 锁定提示；
 * - 演示账号登录成功 → 会话落 localStorage 并跳转看板。
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { LoginPage } from '../../apps/web/src/pages/LoginPage'
import { MOCK_DEMO_ACCOUNT, MOCK_DEMO_PASSWORD } from '@cadenza/ui'

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/dashboard" element={<div>看板已进入</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('登录表单（web，mock 模式）', () => {
  it('空账号与密码提交时逐字段提示，不发请求', async () => {
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByText('请输入登录账号')).toBeInTheDocument()
    expect(screen.getByText('请输入密码')).toBeInTheDocument()
    // 未触发服务端：无主错误消息条
    expect(screen.queryByText(/账号或密码错误/)).not.toBeInTheDocument()
  })

  it('错误密码展示主错误与失败锁定指引文案（PC-14/OA-16）', async () => {
    const user = userEvent.setup()
    renderLogin()
    await user.type(screen.getByLabelText(/登录账号/), 'admin')
    await user.type(screen.getByLabelText(/密码/), 'WrongPassword1')
    await user.click(screen.getByRole('button', { name: '登录' }))
    const mainError = await screen.findByText(/账号或密码错误/)
    const messageBox = mainError.closest('.cz-message') as HTMLElement
    expect(messageBox).not.toBeNull()
    expect(messageBox).toHaveTextContent('连续多次失败将临时锁定账号')
    // 字段级校验未触发（两字段均已填）
    expect(screen.queryByText('请输入登录账号')).not.toBeInTheDocument()
  })

  it('连续失败达到阈值（5 次）后提示账号已临时锁定', async () => {
    const user = userEvent.setup()
    renderLogin()
    for (let i = 0; i < 5; i++) {
      await user.clear(screen.getByLabelText(/登录账号/))
      await user.clear(screen.getByLabelText(/密码/))
      await user.type(screen.getByLabelText(/登录账号/), 'admin')
      await user.type(screen.getByLabelText(/密码/), 'WrongPassword1')
      await user.click(screen.getByRole('button', { name: /^登录$|登录中…/ }))
      await screen.findByText(/账号或密码错误|已临时锁定/)
    }
    const messageBox = screen.getByText(/已临时锁定/).closest('.cz-message') as HTMLElement
    expect(messageBox).toHaveTextContent('请联系管理员解封')
  })

  it('演示账号登录成功：会话写入 localStorage 并跳转看板', async () => {
    const user = userEvent.setup()
    renderLogin()
    await user.type(screen.getByLabelText(/登录账号/), MOCK_DEMO_ACCOUNT)
    await user.type(screen.getByLabelText(/密码/), MOCK_DEMO_PASSWORD)
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByText('看板已进入')).toBeInTheDocument()
    await waitFor(() => {
      const stored = localStorage.getItem('cadenza.web.session')
      expect(stored).toBeTruthy()
      expect(JSON.parse(stored!).user.loginName).toBe(MOCK_DEMO_ACCOUNT)
    })
  })
})
