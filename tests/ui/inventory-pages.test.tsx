// @vitest-environment jsdom
/**
 * 库存查询区页面测试（第三波；mock 客户端演示数据与真实 DTO 同形）：
 * - 余额列表：数量与单位同现（PC-06）、英尺展示列（IT-10）、待检徽标、服务端分页总数；
 * - 条码解析：载具码一码多物 → 「需选择」警告 + 候选行（IT-06）；未识别码 → IT-04 文案；
 * - 单元详情：按单元号反查身份/余额/流水/谱系边摘要（IT-01/35）。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { InventoryBalancesPage } from '../../apps/web/src/pages/InventoryBalancesPage'
import { InventoryBarcodePage } from '../../apps/web/src/pages/InventoryBarcodePage'
import { InventoryUnitPage } from '../../apps/web/src/pages/InventoryUnitPage'

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

function renderPage(ui: React.ReactElement, initialEntries?: string[]): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  localStorage.removeItem(SESSION_KEY)
})

describe('库存余额页（IT-14/20/10 + PC-06）', () => {
  it('默认不含已关闭余额：在库行数量与单位同现，英尺列与待检徽标渲染', async () => {
    seedSession(['inventory.read'])
    renderPage(<InventoryBalancesPage />)
    const row = await screen.findByRole('row', { name: /U-2026-1001-0001/ })
    // PC-06：数量与单位同现
    expect(within(row).getByText('2400.0000')).toBeInTheDocument()
    expect(within(row).getByText('KG')).toBeInTheDocument()
    expect(within(row).getByText('7874 英尺')).toBeInTheDocument()
    expect(within(row).getByText('合格')).toBeInTheDocument()
    // 待检徽标（pending_inspection）
    const pendingRow = screen.getByRole('row', { name: /U-2026-1001-0002/ })
    expect(within(pendingRow).getByText('待检')).toBeInTheDocument()
    // 已出清单元默认不显示（includeClosed=false），勾选后出现
    expect(screen.queryByRole('row', { name: /U-2026-1002-0006/ })).not.toBeInTheDocument()
  })

  it('勾选「含已关闭余额」后已出清单元出现；服务端分页总数回显', async () => {
    const user = userEvent.setup()
    seedSession(['inventory.read'])
    renderPage(<InventoryBalancesPage />)
    await screen.findByRole('row', { name: /U-2026-1001-0001/ })
    expect(screen.queryByRole('row', { name: /U-2026-1002-0006/ })).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('含已关闭余额'))
    const closedRow = await screen.findByRole('row', { name: /U-2026-1002-0006/ })
    expect(within(closedRow).getByText(/已出清|关闭/)).toBeInTheDocument()
    const info = document.querySelector('.cz-pagination__info') as HTMLElement | null
    expect(info).not.toBeNull()
    expect(info).toHaveTextContent('共 6 条')
  })
})

describe('条码解析页（IT-04/05/06）', () => {
  it('载具码一码多物：显示「需选择」警告与 2 个候选行', async () => {
    const user = userEvent.setup()
    seedSession(['inventory.read'])
    renderPage(<InventoryBarcodePage />)
    await user.type(screen.getByPlaceholderText(/输入条码\/二维码值/), 'BC-CR-01')
    await user.click(screen.getByRole('button', { name: '解析' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('一码多物：解析到 2 个候选对象，需选择要操作的目标')
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows.length).toBe(3) // 表头 + 2 候选
    expect(within(table).getAllByText('库存单元').length).toBe(2)
    expect(within(table).getAllByText('载具装载').length).toBe(2)
    expect(within(table).getAllByRole('link', { name: '查看单元详情' }).length).toBe(2)
  })

  it('未识别码：IT-04 可行动文案，无候选表', async () => {
    const user = userEvent.setup()
    seedSession(['inventory.read'])
    renderPage(<InventoryBarcodePage />)
    await user.type(screen.getByPlaceholderText(/输入条码\/二维码值/), 'XYZ-NOT-EXIST')
    await user.click(screen.getByRole('button', { name: '解析' }))
    // info 级提示（初始引导与结果态均为 role=status，按文案等待解析完成）
    const status = await screen.findByText('该码未解析到候选对象（IT-04）')
    expect(status.closest('[role="status"]')).not.toBeNull()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('单元详情页（IT-01/35）', () => {
  it('按单元号反查：身份、余额、近期流水与谱系边摘要同页呈现', async () => {
    seedSession(['inventory.read'])
    renderPage(<InventoryUnitPage />)
    const input = screen.getByPlaceholderText(/输入库存单元号/)
    await userEvent.type(input, 'U-2026-1001-0001')
    await userEvent.click(screen.getByRole('button', { name: '查询' }))
    expect(await screen.findByText('数量追溯')).toBeInTheDocument()
    expect(screen.getByText('receipt_origin')).toBeInTheDocument()
    expect(screen.getByText('收货')).toBeInTheDocument() // 流水变动类型中文（MOVEMENT_KIND_LABELS）
    expect(screen.getAllByText('01010001').length).toBeGreaterThanOrEqual(1) // 余额库位
    expect(screen.getByText(/生产订单|production_order/)).toBeInTheDocument() // 有效预留占用者
  })
})
