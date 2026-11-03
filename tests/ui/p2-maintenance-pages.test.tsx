// @vitest-environment jsdom
/**
 * T19 maintenance 页面测试（P2-UI 线）：
 * - 维修工单：状态机投影（MT-07 已报修/处理中/待复机）、取消门（MT-14）、
 *   复机弹层结果/责任人必填与成功关单流转（MT-07/10）、分派门；
 * - 点检/保养计划：版本快照与检查项、超期仅提示（MT-12/IT-37）；
 * - PDA 设备：EQU- 前缀宽容识别（MT-04）、同状态不产生流水（MT-03）、
 *   维修中不可开工（MT-05）、当日重复开工幂等（MT-06）。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { MaintenanceOrdersPage } from '../../apps/web/src/p2/pages/MaintenanceOrdersPage'
import { MaintenancePlansPage } from '../../apps/web/src/p2/pages/MaintenancePlansPage'
import { AuthProvider as PdaAuthProvider } from '../../apps/pda/src/auth'
import { EquipmentExceptionPdaPage } from '../../apps/pda/src/p2/pages/EquipmentExceptionPdaPage'
import { EquipmentStartPdaPage } from '../../apps/pda/src/p2/pages/EquipmentStartPdaPage'

function seedSession(permissions: string[], loginName = 'admin', key = 'cadenza.web.session', platform: 'WEB' | 'PDA' = 'WEB'): void {
  localStorage.setItem(
    key,
    JSON.stringify({
      token: 'mock-token-test',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: {
        userId: 'user-s-1', loginName, displayName: '系统管理员', enterpriseId: 'n-ent', enterpriseName: '中辰线缆集团',
        plantId: 'n-plant', plantName: '杭州制造工厂', roleId: 'role-admin', roleName: '系统管理员', loginPlatform: platform,
      },
      permissions,
      dataScope: { enterpriseWide: true, plantIds: ['n-plant'] },
    }),
  )
}

afterEach(() => {
  localStorage.clear()
})

describe('维修工单状态机（MT-07/14）', () => {
  it('状态投影：已报修可分派/取消；待复机可复机不可取消；处理中无复机入口', async () => {
    seedSession(['maintenance.read', 'maintenance.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <MaintenanceOrdersPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const reportedRow = await screen.findByRole('row', { name: /MX-20261028-0006/ })
    expect(within(reportedRow).getByText('已报修')).toBeInTheDocument()
    expect(within(reportedRow).getByRole('button', { name: '分派' })).toBeInTheDocument()
    expect(within(reportedRow).getByRole('button', { name: /取消（MT-14）/ })).toBeInTheDocument()
    const processingRow = screen.getByRole('row', { name: /MX-20261026-0004/ })
    expect(within(processingRow).getByText('处理中')).toBeInTheDocument()
    expect(within(processingRow).queryByRole('button', { name: /复机/ })).not.toBeInTheDocument()
    const recoverRow = screen.getByRole('row', { name: /MX-20261024-0002/ })
    expect(within(recoverRow).getByText('待复机')).toBeInTheDocument()
    expect(within(recoverRow).getByRole('button', { name: /复机（MT-10）/ })).toBeInTheDocument()
    expect(within(recoverRow).queryByRole('button', { name: /取消/ })).not.toBeInTheDocument()
  })

  it('分派弹层：处理人未填不放行（MT-07 前端门）', async () => {
    const user = userEvent.setup()
    seedSession(['maintenance.read', 'maintenance.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <MaintenanceOrdersPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const reportedRow = await screen.findByRole('row', { name: /MX-20261028-0006/ })
    await user.click(within(reportedRow).getByRole('button', { name: '分派' }))
    expect(await screen.findByText(/分派工单 MX-20261028-0006/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认分派' })).toBeDisabled()
    await user.type(screen.getByLabelText('处理人'), '维修丙')
    expect(screen.getByRole('button', { name: '确认分派' })).toBeEnabled()
  })
})

describe('点检/保养计划（MT-12/IT-37）', () => {
  it('计划行：类型徽标＋周期＋版本快照；详情展开检查项；超期仅提示不阻断', async () => {
    const user = userEvent.setup()
    seedSession(['maintenance.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <MaintenancePlansPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(screen.getByText(/超期仅提示不自动阻断生产（MT-12）/)).toBeInTheDocument()
    const planRow = await screen.findByRole('row', { name: /MP-DRAW-D/ })
    expect(within(planRow).getByText('点检')).toBeInTheDocument()
    expect(within(planRow).getByText('每班次')).toBeInTheDocument()
    expect(within(planRow).getByText('正常')).toBeInTheDocument()
    await user.click(within(planRow).getByRole('button', { name: '详情' }))
    expect(await screen.findByText(/计划 MP-DRAW-D 检查项（版本 3 快照）/)).toBeInTheDocument()
    expect(screen.getByText('张力计读数记录')).toBeInTheDocument()
  })
})

describe('PDA 设备（MT-03/04/05/06）', () => {
  it('EQU- 前缀宽容识别（MT-04）；同状态变更拒绝 [MT-03]', async () => {
    const user = userEvent.setup()
    seedSession(['maintenance.read', 'maintenance.post'], 'admin', 'cadenza.pda.session', 'PDA')
    render(
      <MemoryRouter>
        <PdaAuthProvider>
          <EquipmentExceptionPdaPage />
        </PdaAuthProvider>
      </MemoryRouter>,
    )
    await user.type(screen.getByPlaceholderText(/扫描或输入条码后回车/), 'EQU-EQ-EXTR-01')
    await user.keyboard('{Enter}')
    expect(await screen.findByText(/挤塑一线主机/)).toBeInTheDocument()
    expect(screen.getByText(/当前/)).toBeInTheDocument()
    // 目标状态与当前一致（维修=2）→ 提交被拒（MT-03）
    await user.selectOptions(screen.getByRole('combobox', { name: '目标状态' }), '2')
    await user.click(screen.getByRole('button', { name: '提交状态变更' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('MT-03')
  })

  it('维修中设备不可开工（MT-05）；正常设备当日重复开工幂等（MT-06）', async () => {
    const user = userEvent.setup()
    seedSession(['maintenance.read', 'maintenance.post'], 'admin', 'cadenza.pda.session', 'PDA')
    render(
      <MemoryRouter>
        <PdaAuthProvider>
          <EquipmentStartPdaPage />
        </PdaAuthProvider>
      </MemoryRouter>,
    )
    await user.type(screen.getByPlaceholderText(/扫描或输入条码后回车/), 'EQ-EXTR-01')
    await user.keyboard('{Enter}')
    expect(await screen.findByText(/挤塑一线主机/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开工' })).toBeDisabled()
    expect(screen.getByText(/维修中设备不可开工（MT-05）/)).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText(/扫描或输入条码后回车/), 'EQ-DRAW-01')
    await user.keyboard('{Enter}')
    const startButton = await screen.findByRole('button', { name: /更新开工时间（幂等）/ })
    await user.click(startButton)
    expect(await screen.findByRole('status')).toHaveTextContent('开工已登记')
  })
})

describe('复机流转（MT-07/10）', () => {
  it('结果/责任人未填不放行；填后关单成功并投影已关闭', async () => {
    const user = userEvent.setup()
    seedSession(['maintenance.read', 'maintenance.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <MaintenanceOrdersPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const recoverRow = await screen.findByRole('row', { name: /MX-20261024-0002/ })
    await user.click(within(recoverRow).getByRole('button', { name: /复机（MT-10）/ }))
    expect(await screen.findByText(/备件消耗与关单同事务且 ≤ 实时可用量（MT-11）/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认复机关单' })).toBeDisabled()
    await user.type(screen.getByLabelText('处理结果'), '更换温控模块并校准')
    expect(screen.getByRole('button', { name: '确认复机关单' })).toBeDisabled()
    await user.type(screen.getByLabelText('责任人'), '维修乙')
    expect(screen.getByRole('button', { name: '确认复机关单' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '确认复机关单' }))
    expect(await screen.findByRole('status')).toHaveTextContent('复机完成')
    const closedRow = await screen.findByRole('row', { name: /MX-20261024-0002/ })
    expect(within(closedRow).getByText('已关闭')).toBeInTheDocument()
  })
})
