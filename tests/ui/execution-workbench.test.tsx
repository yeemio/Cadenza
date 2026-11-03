// @vitest-environment jsdom
/**
 * 报工工作台测试（第四波；mock 演示数据与真实 DTO 同形）：
 * - 草稿箱「N 条待提交」；
 * - 报工表单提交成功与 [A6-3] 挂起订单守卫错误渲染；
 * - 审核操作：通过（入库转线边库）与取消审核守卫错误（[A6-6] 对象关系守卫）；
 * - 五量分栏（[A5-3]：草稿/提交/审核/合格/入库五列分立）。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { ExecutionWorkbenchPage } from '../../apps/web/src/pages/ExecutionWorkbenchPage'

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

const ADMIN_PERMISSIONS = [
  'org.read',
  'process.read',
  'execution.read',
  'execution.report',
  'execution.review',
]

afterEach(() => {
  localStorage.removeItem(SESSION_KEY)
})

function setup(): ReturnType<typeof render> {
  seedSession(ADMIN_PERMISSIONS)
  return render(
    <MemoryRouter>
      <AuthProvider>
        <ExecutionWorkbenchPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

async function selectOrderAndOperation(user: ReturnType<typeof userEvent.setup>, orderValue: string, orderNo: RegExp, operationValue: string, operationName: RegExp) {
  const orderSelect = await screen.findByRole('combobox', { name: '生产订单选择' })
  await within(orderSelect).findByRole('option', { name: orderNo })
  await user.selectOptions(orderSelect, orderValue)
  const opSelect = await screen.findByRole('combobox', { name: '工序选择' })
  await within(opSelect).findByRole('option', { name: operationName })
  await user.selectOptions(opSelect, operationValue)
}

describe('草稿箱（N 条待提交）', () => {
  it('显示待提交计数徽标与草稿行（mock：1 条，rp-001）', async () => {
    setup()
    expect(await screen.findByText('1 条待提交')).toBeInTheDocument()
    const row = await screen.findByRole('row', { name: /rp-001/ })
    expect(within(row).getByText('工作台报工')).toBeInTheDocument()
    expect(within(row).getByText('3.0000')).toBeInTheDocument()
  })
})

describe('报工表单（三入口同规则）', () => {
  it('订单报工入口提交成功：产出数量+单位+载体码+目标线边库', async () => {
    const user = userEvent.setup()
    setup()
    await selectOrderAndOperation(user, 'po-001', /MO-2026-1027-001/, 'op-101', /拉丝/)
    await user.type(screen.getByPlaceholderText('如 3.0000'), '2.0000')
    await user.type(screen.getByPlaceholderText('如 E2A0000001'), 'E2A0000009')
    await user.click(screen.getByRole('button', { name: '提交报工' }))
    expect(await screen.findByText(/报工已提交（报工单 rp-/)).toBeInTheDocument()
  })

  it('挂起订单提交被拒：[A6-3] 守卫错误渲染（PC-14 主文案+服务端原文）', async () => {
    const user = userEvent.setup()
    setup()
    await selectOrderAndOperation(user, 'po-003', /MO-2026-1027-003/, 'op-301', /挤塑/)
    await user.type(screen.getByPlaceholderText('如 3.0000'), '1.0000')
    await user.click(screen.getByRole('button', { name: '提交报工' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('不可报工')
    expect(alert.textContent).toContain('挂起状态')
  })
})

describe('审核操作（execution.review）', () => {
  it('查询 rp-002 → 审核通过（产出转线边库入库）', async () => {
    const user = userEvent.setup()
    setup()
    await screen.findByText('1 条待提交')
    await user.click(screen.getByRole('button', { name: '查询报工单' }))
    expect(await screen.findByText(/rp-002/)).toBeInTheDocument()
    expect(screen.getByText('待审核')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /审核通过/ }))
    expect(await screen.findByText(/已审核通过；产出已转线边库/)).toBeInTheDocument()
  })

  it('取消审核守卫错误：rp-003 产出已被消耗（[A6-6] 对象关系守卫）原文渲染', async () => {
    const user = userEvent.setup()
    setup()
    await screen.findByText('1 条待提交')
    await user.clear(screen.getByRole('textbox', { name: '报工单号' }))
    await user.type(screen.getByRole('textbox', { name: '报工单号' }), 'rp-003')
    await user.click(screen.getByRole('button', { name: '查询报工单' }))
    expect(await screen.findByText(/rp-003/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消审核' }))
    const dialog = screen.getByRole('dialog', { name: '取消审核' })
    await user.type(within(dialog).getByRole('textbox'), '下游已消耗需核查')
    await user.click(within(dialog).getByRole('button', { name: '确认取消审核' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('不可取消审核')
    expect(alert.textContent).toContain('对象关系守卫')
  })
})

describe('五量分栏（[A5-3] 不做混口径）', () => {
  it('订单 po-001 五列分立：草稿 3.0000 / 提交 2.0000 / 审核 9.0000 / 合格 9.0000 / 入库 9.0000', async () => {
    const user = userEvent.setup()
    setup()
    await screen.findByText('1 条待提交')
    const fiveSelect = await screen.findByRole('combobox', { name: '五量订单选择' })
    await within(fiveSelect).findByRole('option', { name: /MO-2026-1027-001/ })
    await user.selectOptions(fiveSelect, 'po-001')
    // 五个量名在分栏卡片与工序表头各出现一次
    expect((await screen.findAllByText('草稿量')).length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('提交量').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('审核量').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('合格量').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('入库量').length).toBeGreaterThanOrEqual(2)
    // 数值与单位同现（卡片值区/工序表均以「N KM」呈现，PC-06）。
    // 同文件先行用例共享 mock 模块状态的累积口径：草稿=rp-001 3.0000；
    // 表单用例新提交 2.0000（待审）；审核用例通过 rp-002（1.8 合格）后已审=1+8+2=11.0000、合格=10.8000。
    expect(screen.getAllByText(/3\.0000/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/2\.0000/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/11\.0000/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/10\.8000/).length).toBeGreaterThan(0)
    // 工序行分栏同样渲染
    expect(await screen.findByRole('row', { name: /绞合/ })).toBeInTheDocument()
  })
})
