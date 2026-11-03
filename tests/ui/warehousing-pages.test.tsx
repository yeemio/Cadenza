// @vitest-environment jsdom
/**
 * 仓储管理区测试（第四波；mock 演示数据与真实 DTO 同形）：
 * - 入库任务列表（刷新重跑）与组单入库（A-T13-1/2）；
 * - 移库页 [A-T13-4] 校验错误渲染（跨仓拒绝）；
 * - 调拨列表三段操作：状态机步骤可视化（A-T13-10）＋行级出库/接收。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { WarehousingMovesPage } from '../../apps/web/src/pages/WarehousingMovesPage'
import { WarehousingPutawayPage } from '../../apps/web/src/pages/WarehousingPutawayPage'
import { WarehousingTransfersPage } from '../../apps/web/src/pages/WarehousingTransfersPage'

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

const ADMIN_PERMISSIONS = ['org.read', 'warehousing.read', 'warehousing.post']

afterEach(() => {
  localStorage.removeItem(SESSION_KEY)
})

function renderWithAuth(ui: React.ReactElement): ReturnType<typeof render> {
  seedSession(ADMIN_PERMISSIONS)
  return render(
    <MemoryRouter>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  )
}

describe('入库任务（A-T13-1 台账 + 刷新重跑 + 组单入库）', () => {
  it('任务列表渲染（待入库/已完成）且「刷新重跑」成功回执', async () => {
    const user = userEvent.setup()
    renderWithAuth(<WarehousingPutawayPage />)
    const pendingRow = await screen.findByRole('row', { name: /选择任务 pt-002/ })
    expect(within(pendingRow).getByText('报工')).toBeInTheDocument()
    expect(within(pendingRow).getByText('rp-004')).toBeInTheDocument()
    expect(within(pendingRow).getByText('待入库')).toBeInTheDocument()
    const doneRow = screen.getByRole('row', { name: /qio-002/ })
    expect(within(doneRow).getByText('已完成')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /刷新重跑/ }))
    expect(await screen.findByText(/任务刷新重跑完成/)).toBeInTheDocument()
  })

  it('组单入库：勾选 pt-001 → 确认入库 → 任务转已完成', async () => {
    const user = userEvent.setup()
    renderWithAuth(<WarehousingPutawayPage />)
    await screen.findByRole('row', { name: /选择任务 pt-001/ })
    await user.click(screen.getByRole('checkbox', { name: '选择任务 pt-001' }))
    await user.click(screen.getByRole('button', { name: /组单入库（已选 1 条）/ }))
    const dialog = await screen.findByRole('dialog', { name: '组单确认入库' })
    await user.click(within(dialog).getByRole('button', { name: '确认入库' }))
    expect(await screen.findByText(/确认入库完成（1 条任务/)).toBeInTheDocument()
    // pt-001 状态翻转后与 pt-003 同为已完成（状态徽标 ≥2；过滤下拉 option 不计入）
    await waitFor(() => {
      const badges = screen.getAllByText('已完成').filter((node) => node.tagName === 'SPAN')
      expect(badges.length).toBeGreaterThanOrEqual(2)
    })
  })
})

describe('移库（A-T13-4 校验错误渲染）', () => {
  it('跨仓移动被拒：错误文案渲染（移库仅限同仓内库位移动）', async () => {
    const user = userEvent.setup()
    renderWithAuth(<WarehousingMovesPage />)
    await screen.findByRole('row', { name: /U-2026-1001-0003/ })
    await user.selectOptions(screen.getByRole('combobox', { name: '移库单元选择' }), 'u-0001')
    await user.selectOptions(screen.getByRole('combobox', { name: '移库目标库位选择' }), 'loc-02010001')
    await user.click(screen.getByRole('button', { name: '执行移库' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('跨仓')
    expect(alert.textContent).toContain('A-T13-4')
  })
})

describe('调拨（A-T13-10 状态机 + 三段操作）', () => {
  it('列表显示状态机进度与「已出库在途」；详情行级接收后整单完成', async () => {
    const user = userEvent.setup()
    renderWithAuth(<WarehousingTransfersPage />)
    const row = await screen.findByRole('row', { name: /TR-2026-1027-001/ })
    expect(within(row).getByText('已出库在途')).toBeInTheDocument()
    // 状态机可视化（aria-label 携带当前状态）
    expect(within(row).getByLabelText('状态机：已出库在途')).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: '详情/操作' }))
    const dialog = await screen.findByRole('dialog')
    // 详情步骤条：当前步「已出库在途」高亮（aria-label 步骤链）
    expect(within(dialog).getByLabelText('调拨状态机步骤')).toBeInTheDocument()
    // 行级两段事实：out 完成、in 未完成
    const lineRow = within(dialog).getByRole('row', { name: /U-2026-1002-0032/ })
    expect(within(lineRow).getByText('出库完成')).toBeInTheDocument()
    await user.click(within(lineRow).getByRole('button', { name: '接收' }))
    expect(await screen.findByText(/行 1 接收段完成/)).toBeInTheDocument()
  })
})
