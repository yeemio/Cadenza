// @vitest-environment jsdom
/**
 * T18 quality-disposition 页面测试（P2-UI 线）：
 * - 存疑台账：存疑/已恢复与处置记录链（QD-03 审计链）；
 * - 成品异常：审核门（QD-07）＋去向必填（QD-08 前端不放行）；
 * - IQC 版本链：码级当前生效＋版本历史＋当前指针（QD-S2）；复检仅一次（QD-14）；
 * - 处置决定：四类徽标与让步范围（QD-20/23）；
 * - PDA：存疑标记拒绝（QD-01）与免检码结论拒绝（QD-12）。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { QualitySuspectPage } from '../../apps/web/src/p2/pages/QualitySuspectPage'
import { FinishedDefectPage } from '../../apps/web/src/p2/pages/FinishedDefectPage'
import { IqcVersionPage } from '../../apps/web/src/p2/pages/IqcVersionPage'
import { DispositionPage } from '../../apps/web/src/p2/pages/DispositionPage'
import { AuthProvider as PdaAuthProvider } from '../../apps/pda/src/auth'
import { QualitySuspectPdaPage } from '../../apps/pda/src/p2/pages/QualitySuspectPdaPage'
import { IqcCodePdaPage } from '../../apps/pda/src/p2/pages/IqcCodePdaPage'

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

describe('质量存疑台账（QD-03/04）', () => {
  it('存疑中行拦截徽标；已恢复行展示处置记录链（不覆盖原记录）', async () => {
    seedSession(['disposition.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <QualitySuspectPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const suspectRow = await screen.findByRole('row', { name: /QD-SUS-01/ })
    expect(within(suspectRow).getByText(/存疑中（QD-04 拦截）/)).toBeInTheDocument()
    expect(within(suspectRow).getByText(/—（待处置）/)).toBeInTheDocument()
    const restoredRow = screen.getByRole('row', { name: /U-2026-1015-0004/ })
    expect(within(restoredRow).getByText('已恢复')).toBeInTheDocument()
    expect(within(restoredRow).getByText(/复检合格，判定误标/)).toBeInTheDocument()
  })
})

describe('成品异常审核（QD-07/08）', () => {
  it('仅未审核行有审核入口；通过时去向说明未填不放行（QD-08 前端门）', async () => {
    const user = userEvent.setup()
    seedSession(['disposition.read', 'disposition.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <FinishedDefectPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const unreviewedRow = await screen.findByRole('row', { name: /QD-DEF-01/ })
    expect(within(unreviewedRow).getByText('未审核')).toBeInTheDocument()
    await user.click(within(unreviewedRow).getByRole('button', { name: /审核（QD-07）/ }))
    expect(await screen.findByText(/通过扣数必须记录去向/)).toBeInTheDocument()
    // 去向说明为空 → 提交禁用
    expect(screen.getByRole('button', { name: '提交审核' })).toBeDisabled()
    // 审核通过历史行展示去向（报废＋说明）
    const approvedRow = screen.getByRole('row', { name: /U-2026-1021-0002/ })
    expect(within(approvedRow).getByText(/线径超差报废/)).toBeInTheDocument()
  })
})

describe('IQC 版本链（QD-S2/11～14）', () => {
  it('批次查询：码级当前生效结论、版本链历史与当前指针', async () => {
    seedSession(['disposition.read', 'disposition.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <IqcVersionPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/码级当前生效结论/)).toBeInTheDocument()
    const codeRow = screen.getByRole('row', { name: /QD-IQC-02/ })
    expect(within(codeRow).getByText('合格')).toBeInTheDocument()
    expect(within(codeRow).getByText('否')).toBeInTheDocument()
    expect(screen.getByText(/版本链（历史可查，QD-S2）/)).toBeInTheDocument()
    expect(screen.getAllByText('是').length).toBeGreaterThan(0) // 当前生效指针
    // 批量写入门（QD-11）按钮存在
    expect(screen.getByRole('button', { name: /批量写入合格（QD-11/ })).toBeInTheDocument()
  })

  it('复检仅一次：对已复检演示夹具再次发起 → [QD-14] 拒绝（mock 复现）', async () => {
    const user = userEvent.setup()
    seedSession(['disposition.read', 'disposition.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <IqcVersionPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByText(/码级当前生效结论/)
    // 先发起一次复检（夹具内无已复检码 → 成功）
    await user.click(screen.getByRole('button', { name: /发起复检（QD-14/ }))
    expect(await screen.findByRole('status')).toHaveTextContent('复检已发起')
    // 再次发起 → [QD-14] 拒绝
    await user.click(screen.getByRole('button', { name: /发起复检（QD-14/ }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('QD-14')
  })
})

describe('处置决定（QD-20/23）', () => {
  it('四类徽标与让步范围列展示', async () => {
    seedSession(['disposition.read', 'disposition.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <DispositionPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const concessionRow = await screen.findByRole('row', { name: /dp-1|LOT-20261027-05/ })
    expect(within(concessionRow).getByText('让步')).toBeInTheDocument()
    expect(within(concessionRow).getByText(/该批次 200\.0000 KG/)).toBeInTheDocument()
    const reworkRow = screen.getByRole('row', { name: /fd-2/ })
    expect(within(reworkRow).getByText('返工')).toBeInTheDocument()
  })
})

describe('PDA 存疑与单码结论（QD-01/12）', () => {
  it('托码/拒绝码标记存疑 → [QD-01]；免检码提交结论 → [QD-12]', async () => {
    const user = userEvent.setup()
    seedSession(['disposition.read', 'disposition.post'], 'admin', 'cadenza.pda.session', 'PDA')
    render(
      <MemoryRouter>
        <PdaAuthProvider>
          <QualitySuspectPdaPage />
        </PdaAuthProvider>
      </MemoryRouter>,
    )
    await user.type(screen.getByPlaceholderText(/扫描或输入条码后回车/), 'TP-0091')
    await user.keyboard('{Enter}')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('QD-01')
  })

  it('PDA 单码结论：免检码拒绝 [QD-12]', async () => {
    const user = userEvent.setup()
    seedSession(['disposition.read', 'disposition.post'], 'admin', 'cadenza.pda.session', 'PDA')
    render(
      <MemoryRouter>
        <PdaAuthProvider>
          <IqcCodePdaPage />
        </PdaAuthProvider>
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: '查询批次' }))
    await screen.findByText(/当前生效/)
    await user.type(screen.getByPlaceholderText('码（扫码带出）'), 'QD-IQC-04')
    await user.click(screen.getByRole('button', { name: '提交结论' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('QD-12')
  })
})
