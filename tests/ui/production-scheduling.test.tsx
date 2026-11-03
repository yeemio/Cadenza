// @vitest-environment jsdom
/**
 * 生产排程页测试（第四波；mock 演示数据与真实 DTO 同形）：
 * - 订单列表：状态轴标签 + [A3-4] 排产状态列（逐单调 /scheduling/order-view）；
 * - 双视图同值渲染：订单视图与设备视图展示同一排产事实（[A3] 双投影）；
 * - 槽位编辑抽屉：[A3-2] 硬校验错误渲染（无确认弹窗）与 [A3-2w] 超产能弱提醒
 *   ConfirmModal 二次确认分支（confirm=true 重新提交后成功）。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { ProductionOrdersPage } from '../../apps/web/src/pages/ProductionOrdersPage'
import { SchedulingPage } from '../../apps/web/src/pages/SchedulingPage'

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

function renderWithAuth(ui: React.ReactElement, initialEntry = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  )
}

const ADMIN_PERMISSIONS = [
  'org.read',
  'process.read',
  'process.admin',
  'scheduling.read',
  'scheduling.admin',
  'execution.read',
  'execution.report',
  'execution.review',
]

afterEach(() => {
  localStorage.removeItem(SESSION_KEY)
})

/** 选择订单前先等选项加载完成（mock 延迟下 combobox 先渲染、选项后到） */
async function selectOrder(user: ReturnType<typeof userEvent.setup>, orderValue: string, orderNoRegex: RegExp) {
  const orderSelect = await screen.findByRole('combobox')
  await screen.findByRole('option', { name: orderNoRegex })
  await user.selectOptions(orderSelect, orderValue)
}

describe('生产订单列表（状态轴标签 + 排产状态列）', () => {
  it('MO-2026-1027-001 显示「进行中」状态标签与「部分排产」排产状态列（A3-4 回写链投影）', async () => {
    seedSession(ADMIN_PERMISSIONS)
    renderWithAuth(<ProductionOrdersPage />)
    const row = await screen.findByRole('row', { name: /MO-2026-1027-001/ })
    expect(within(row).getByText('进行中')).toBeInTheDocument()
    // 排产状态列（scheduling.read 时逐单调订单视图；op-101 已排 6/12 → 部分排产）
    expect(await within(row).findByText('部分排产')).toBeInTheDocument()
    // 挂起订单（MO-2026-1027-003）显示挂起徽标
    const suspendedRow = await screen.findByRole('row', { name: /MO-2026-1027-003/ })
    expect(within(suspendedRow).getByText('挂起')).toBeInTheDocument()
  })
})

describe('生产排程：双视图同值渲染（同一排产事实两投影）', () => {
  it('订单视图「已排 6.0000」与设备视图当日明细「6.0000 KM」同值（[A3] 双投影）', async () => {
    const user = userEvent.setup()
    seedSession(ADMIN_PERMISSIONS)
    renderWithAuth(<SchedulingPage />)
    // 订单视图：选择 MO-2026-1027-001
    await selectOrder(user, 'po-001', /MO-2026-1027-001/)
    // [A3-6] 前置通过 + 工序行已排数量
    const opBlock = await screen.findByText(/1\. 拉丝/, { selector: 'b' })
    expect(opBlock).toBeInTheDocument()
    expect(await screen.findByText(/已排 6\.0000 KM/)).toBeInTheDocument()
    // 设备视图：同一事实的另一投影
    await user.click(screen.getByRole('tab', { name: '设备视图' }))
    const cell = await screen.findByRole('button', { name: /2 单 \/ 11\.0000/ })
    await user.click(cell)
    // 当日明细：两单分别 6.0000（po-001）与 5.0000（po-002）——同值渲染
    const detail = await screen.findByText(/MO-2026-1027-001：6\.0000 KM/)
    expect(detail).toBeInTheDocument()
    expect(screen.getByText(/MO-2026-1027-002：5\.0000 KM/)).toBeInTheDocument()
  })
})

describe('槽位编辑抽屉：硬校验与弱提醒分支', () => {
  it('[A3-2] 超下线数量为硬校验：错误渲染且不出现确认弹窗（confirm 不豁免）', async () => {
    const user = userEvent.setup()
    seedSession(ADMIN_PERMISSIONS)
    renderWithAuth(<SchedulingPage />)
    await selectOrder(user, 'po-001', /MO-2026-1027-001/)
    await screen.findByText(/已排 6\.0000 KM/)
    await user.click(screen.getAllByRole('button', { name: '编辑槽位' })[0]!)
    const drawer = await screen.findByRole('dialog', { name: '槽位编辑抽屉' })
    const equipmentSelect = await within(drawer).findByDisplayValue('选择设备')
    await within(equipmentSelect).findByRole('option', { name: /中拉机 01/ })
    await user.selectOptions(equipmentSelect, 'eq-0001')
    await user.clear(within(drawer).getByPlaceholderText('如 6.0000'))
    await user.type(within(drawer).getByPlaceholderText('如 6.0000'), '13.0000')
    await user.click(within(drawer).getByRole('button', { name: '保存槽位' }))
    // 硬校验错误渲染（PC-14：规则码主文案 + 服务端原文），无确认弹窗
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('硬校验拒绝')
    expect(screen.queryByText('超出设备日产能（弱提醒确认）')).not.toBeInTheDocument()
  })

  it('[A3-2w] 超设备日产能为弱提醒：ConfirmModal 二次确认后携带 confirm=true 重新提交成功', async () => {
    const user = userEvent.setup()
    seedSession(ADMIN_PERMISSIONS)
    renderWithAuth(<SchedulingPage />)
    await selectOrder(user, 'po-002', /MO-2026-1027-002/)
    await screen.findByText(/1\. 拉丝/, { selector: 'b' })
    await user.click(screen.getAllByRole('button', { name: '编辑槽位' })[0]!)
    const drawer = await screen.findByRole('dialog', { name: '槽位编辑抽屉' })
    const equipmentSelect = await within(drawer).findByDisplayValue('选择设备')
    await within(equipmentSelect).findByRole('option', { name: /中拉机 01/ })
    await user.selectOptions(equipmentSelect, 'eq-0001')
    // eq-0001 在 2026-10-27 已排 11.0000（同键 5.0000 被替换）→ 其余 6.0 + 本值 4.0 = 10.0 > 日产能 8.0
    await user.clear(within(drawer).getByPlaceholderText('如 6.0000'))
    await user.type(within(drawer).getByPlaceholderText('如 6.0000'), '4.0000')
    await user.click(within(drawer).getByRole('button', { name: '保存槽位' }))
    // 弱提醒 → ConfirmModal（文案即二次确认提示）
    const confirmModal = await screen.findByText('超出设备日产能（弱提醒确认）')
    expect(confirmModal).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /确认提交/ }))
    // confirm=true 重新提交 → 成功（含弱提醒回执）
    expect(await screen.findByText(/已保存（含超产能弱提醒）/)).toBeInTheDocument()
  })
})

describe('许可显隐（PC-10）', () => {
  it('无 scheduling.admin：编辑槽位入口不出现，查询仍可用', async () => {
    seedSession(['org.read', 'process.read', 'scheduling.read'])
    renderWithAuth(<SchedulingPage />)
    const user = userEvent.setup()
    await selectOrder(user, 'po-001', /MO-2026-1027-001/)
    await screen.findByText(/已排 6\.0000 KM/)
    expect(screen.queryByRole('button', { name: '编辑槽位' })).not.toBeInTheDocument()
  })
})
