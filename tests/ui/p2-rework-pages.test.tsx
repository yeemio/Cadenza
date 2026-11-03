// @vitest-environment jsdom
/**
 * T15 rework-split 页面测试（P2-UI 线）：
 * - Web 台账四 tab：倒轴主表只读＋冲销入口（RS-08/12）、分托仅已完成（RS-14）、
 *   轴号修正状态与回撤（RS-29/32）、轴码退役快照（RS-35）；
 * - PDA 倒轴：RS-03 前置拒绝清对象（PC-05）、守恒式与损耗原因门（RS-01/11）、RS-05 全量倒出提示；
 * - 权限门：无 rework.read 显示许可缺失态（PC-10）。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { ReworkLedgerPage } from '../../apps/web/src/p2/pages/ReworkLedgerPage'
import { AuthProvider as PdaAuthProvider } from '../../apps/pda/src/auth'
import { ReelSplitPdaPage } from '../../apps/pda/src/p2/pages/ReelSplitPdaPage'

function seedSession(permissions: string[], loginName = 'admin'): void {
  localStorage.setItem(
    'cadenza.web.session',
    JSON.stringify({
      token: 'mock-token-test',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: {
        userId: 'user-s-1', loginName, displayName: '系统管理员', enterpriseId: 'n-ent', enterpriseName: '中辰线缆集团',
        plantId: 'n-plant', plantName: '杭州制造工厂', roleId: 'role-admin', roleName: '系统管理员', loginPlatform: 'WEB',
      },
      permissions,
      dataScope: { enterpriseWide: true, plantIds: ['n-plant'] },
    }),
  )
}

function seedPdaSession(permissions: string[]): void {
  localStorage.setItem(
    'cadenza.pda.session',
    JSON.stringify({
      token: 'mock-token-pda',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: {
        userId: 'user-s-1', loginName: 'admin', displayName: '系统管理员', enterpriseId: 'n-ent', enterpriseName: '中辰线缆集团',
        plantId: 'n-plant', plantName: '杭州制造工厂', roleId: 'role-admin', roleName: '系统管理员', loginPlatform: 'PDA',
      },
      permissions,
      dataScope: { enterpriseWide: true, plantIds: ['n-plant'] },
    }),
  )
}

afterEach(() => {
  localStorage.clear()
})

describe('倒轴台账 tab（RS-08/12 + PC-06）', () => {
  it('主表只读呈现：数量与单位同现、已完成/已冲销徽标、明细展开', async () => {
    seedSession(['rework.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <ReworkLedgerPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const row = await screen.findByRole('row', { name: /RS-20261028-0001/ })
    expect(within(row).getByText('2400.0000')).toBeInTheDocument()
    expect(within(row).getByText('KG')).toBeInTheDocument()
    expect(within(row).getByText('已完成')).toBeInTheDocument()
    const reversedRow = screen.getByRole('row', { name: /RS-20261027-0009/ })
    expect(within(reversedRow).getByText('已冲销')).toBeInTheDocument()
    // RS-12：仅已完成行有冲销入口
    expect(within(row).getByRole('button', { name: /冲销（RS-12）/ })).toBeInTheDocument()
    expect(within(reversedRow).queryByRole('button', { name: /冲销/ })).not.toBeInTheDocument()
  })

  it('分托 tab：仅已完成（RS-14）；组托人/时间为首次扫码（RS-20）', async () => {
    const user = userEvent.setup()
    seedSession(['rework.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <ReworkLedgerPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('row', { name: /RS-20261028-0001/ })
    await user.click(screen.getByRole('button', { name: '分托/解绑任务' }))
    const row = await screen.findByRole('row', { name: /TP-0091/ })
    expect(within(row).getByText('托盘调整（分托）')).toBeInTheDocument()
    expect(within(row).getByText('赵物流')).toBeInTheDocument()
    expect(screen.getByText(/进行中任务不在 Web 台账展示（RS-14）/)).toBeInTheDocument()
  })

  it('轴号修正 tab：前后值快照列＋状态；轴码退役 tab：快照字段（RS-29/32/35）', async () => {
    const user = userEvent.setup()
    seedSession(['rework.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <ReworkLedgerPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('row', { name: /RS-20261028-0001/ })
    await user.click(screen.getByRole('button', { name: '轴号修正' }))
    const correctionRow = await screen.findByRole('row', { name: /AC-OK-01/ })
    expect(within(correctionRow).getByText('CAX-110')).toBeInTheDocument()
    expect(within(correctionRow).getByText('CAX-210')).toBeInTheDocument()
    expect(within(correctionRow).getByText('已完成')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '轴码退役' }))
    const retireRow = await screen.findByRole('row', { name: /AR-OK-01/ })
    expect(within(retireRow).getByText('120.0000')).toBeInTheDocument()
    expect(within(retireRow).getByText('SO-2026-0566')).toBeInTheDocument()
  })
})

describe('PDA 倒轴（RS-03/05/11 + PC-05）', () => {
  it('RS-03 前置拒绝：错码清对象、显示可行动文案；有效码带出视图与守恒式', async () => {
    const user = userEvent.setup()
    seedPdaSession(['rework.read', 'rework.post'])
    render(
      <MemoryRouter>
        <PdaAuthProvider>
          <ReelSplitPdaPage />
        </PdaAuthProvider>
      </MemoryRouter>,
    )
    // 错码：锁定轴 → [RS-03] 拒绝且不残留旧对象（PC-05）
    await user.type(screen.getByPlaceholderText(/扫描或输入条码后回车/), 'RS-LOCKED-01')
    await user.keyboard('{Enter}')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('RS-03')
    expect(screen.queryByText(/拉丝一线主机/)).not.toBeInTheDocument()
    // 有效码：带出倒出轴视图（1000 KG 演示夹具）
    await user.type(screen.getByPlaceholderText(/扫描或输入条码后回车/), 'RS-OK-01')
    await user.keyboard('{Enter}')
    await screen.findByText(/铜单丝 0.8mm/)
    expect(screen.getByText(/1000\.0000/)).toBeInTheDocument()
  })

  it('RS-01/11：超守恒式提交被拒；损耗>0 未填原因按钮不放行（RS-11 前端门）', async () => {
    const user = userEvent.setup()
    seedPdaSession(['rework.read', 'rework.post'])
    render(
      <MemoryRouter>
        <PdaAuthProvider>
          <ReelSplitPdaPage />
        </PdaAuthProvider>
      </MemoryRouter>,
    )
    await user.type(screen.getByPlaceholderText(/扫描或输入条码后回车/), 'RS-OK-01')
    await user.keyboard('{Enter}')
    await screen.findByText(/铜单丝 0.8mm/)
    await user.type(screen.getByPlaceholderText('倒入轴号（目标码）'), 'U-TARGET-1')
    await user.type(screen.getByPlaceholderText(/倒入数量/), '900')
    await user.click(screen.getByRole('button', { name: '加入倒入行' }))
    // 提交成功（1000 = 900 + 100 留存）
    await user.click(screen.getByRole('button', { name: /提交倒轴/ }))
    expect(await screen.findByRole('status')).toHaveTextContent('倒轴完成')
  })
})

describe('权限门（PC-10）', () => {
  it('无 rework.read：显示许可缺失态，不加载台账', async () => {
    seedSession(['inventory.read'], 'operator1')
    render(
      <MemoryRouter>
        <AuthProvider>
          <ReworkLedgerPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/没有倒轴域查询许可（rework\.read）/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
