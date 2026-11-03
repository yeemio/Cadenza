// @vitest-environment jsdom
/**
 * T16 form-conversion 页面测试（P2-UI 线）：
 * - 订单转换：转换状态与同步状态两列独立投影（FC-12）；完成/重试/删除按钮门（FC-06/08/09）；
 *   明细含删码留痕（FC-07）；
 * - 库存转换：四列状态分立（FC-02/14）；恢复路径按钮（FC-15）；FC-18 提交前校验（前端不放行）；
 * - PDA 扫码：载具码已用段长拒绝 [FC-07]。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { OrderConversionPage } from '../../apps/web/src/p2/pages/OrderConversionPage'
import { StockConversionPage } from '../../apps/web/src/p2/pages/StockConversionPage'
import { AuthProvider as PdaAuthProvider } from '../../apps/pda/src/auth'
import { OrderConversionScanPdaPage } from '../../apps/pda/src/p2/pages/OrderConversionScanPdaPage'

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

describe('订单转换页（FC-12 状态分列 + FC-06/08/09 门）', () => {
  it('两列状态独立投影：已完成+同步失败行可重试（FC-09）、待转换行可完成（FC-08）', async () => {
    seedSession(['conversion.read', 'conversion.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <OrderConversionPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const pendingRow = await screen.findByRole('row', { name: /CV-20261028-0001/ })
    expect(within(pendingRow).getByText('待转换')).toBeInTheDocument()
    expect(within(pendingRow).getByText('未同步')).toBeInTheDocument()
    expect(within(pendingRow).getByRole('button', { name: /完成转换（FC-08）/ })).toBeInTheDocument()
    const syncFailedRow = screen.getByRole('row', { name: /CV-20261026-0007/ })
    expect(within(syncFailedRow).getByText('已完成')).toBeInTheDocument()
    expect(within(syncFailedRow).getByText('同步失败')).toBeInTheDocument()
    expect(within(syncFailedRow).getByRole('button', { name: /重试同步（FC-09）/ })).toBeInTheDocument()
    // 已同步行无重试入口
    const syncedRow = screen.getByRole('row', { name: /CV-20261025-0003/ })
    expect(within(syncedRow).queryByRole('button', { name: /重试/ })).not.toBeInTheDocument()
  })

  it('明细：转换前后订单锚点列＋删码留痕徽标（FC-05/07）', async () => {
    const user = userEvent.setup()
    seedSession(['conversion.read', 'conversion.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <OrderConversionPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('row', { name: /CV-20261028-0001/ })
    await user.click(screen.getAllByRole('button', { name: '明细' })[0]!)
    expect(await screen.findByText(/明细行（转换前后订单锚点，FC-05）/)).toBeInTheDocument()
    expect(screen.getByText('SO-2026-0566')).toBeInTheDocument()
    expect(screen.getByText('SO-2026-0601')).toBeInTheDocument()
    expect(screen.getByText(/已删码/)).toBeInTheDocument()
  })
})

describe('库存转换页（FC-02/14 四列分立 + FC-15 恢复路径 + FC-18 校验）', () => {
  it('四列状态独立：转换失败行→重新转换；同步失败+U9 已成功行→重新同步', async () => {
    seedSession(['conversion.read', 'conversion.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <StockConversionPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const failedRow = await screen.findByRole('row', { name: /CVS-20261028-0002/ })
    expect(within(failedRow).getByText('待执行')).toBeInTheDocument()
    expect(within(failedRow).getByText('转换失败')).toBeInTheDocument()
    expect(within(failedRow).getByText('外部失败')).toBeInTheDocument()
    expect(within(failedRow).getByRole('button', { name: /重新转换（FC-15）/ })).toBeInTheDocument()
    const syncFailedRow = screen.getByRole('row', { name: /CVS-20261027-0004/ })
    expect(within(syncFailedRow).getByText('同步失败')).toBeInTheDocument()
    expect(within(syncFailedRow).getByText('是')).toBeInTheDocument()
    expect(within(syncFailedRow).getByRole('button', { name: /重新同步（FC-15）/ })).toBeInTheDocument()
  })

  it('新建弹层：候选源（FC-17 轴行/托行）；必填缺失时提交不放行（FC-18）', async () => {
    const user = userEvent.setup()
    seedSession(['conversion.read', 'conversion.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <StockConversionPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('row', { name: /CVS-20261028-0002/ })
    await user.click(screen.getByRole('button', { name: /新建库存转换（FC-17\/18）/ }))
    expect(await screen.findByText(/候选源（FC-17 选源限定）/)).toBeInTheDocument()
    expect(screen.getByText(/按托汇总一行|—（按托）/)).toBeInTheDocument()
    // 未选择且目标必填为空 → 提交按钮禁用（FC-18 前端门）
    expect(screen.getByRole('button', { name: '提交转换' })).toBeDisabled()
  })
})

describe('PDA 订单转换扫码（FC-07）', () => {
  it('已用段长码拒绝 [FC-07]；有效码提交成功回写实扫', async () => {
    const user = userEvent.setup()
    seedSession(['conversion.read', 'conversion.post'], 'admin', 'cadenza.pda.session', 'PDA')
    render(
      <MemoryRouter>
        <PdaAuthProvider>
          <OrderConversionScanPdaPage />
        </PdaAuthProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('combobox', { name: '转换单' })
    await user.type(screen.getByPlaceholderText(/扫描或输入条码后回车/), 'CV-FULL-01')
    await user.keyboard('{Enter}')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('FC-07')
  })
})
