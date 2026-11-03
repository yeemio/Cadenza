// @vitest-environment jsdom
/**
 * T17 warehouse-reverse 页面测试（P2-UI 线）：
 * - 逆向台账三 tab：移库只读（WR-05）、载具借还 append-only（WR-27）、所有物三分（WR-26）；
 * - 调拨出入库：来源/状态投影（WR-07/13）、入库方式列与码进度（WR-14/17）；
 * - 盘点：锁仓徽标与解锁（WR-24①）、差异调整单原因/去向列（WR-24②）；
 * - 采购批次纠正：回传失败重试（WR-23）、下游拦截清单（WR-22）、退货备注必填（WR-20）；
 * - PDA 移库：WR-02 校验拒绝与暂存提交。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { ReverseLedgerPage } from '../../apps/web/src/p2/pages/ReverseLedgerPage'
import { ReverseTransferPage } from '../../apps/web/src/p2/pages/ReverseTransferPage'
import { ReverseStocktakePage } from '../../apps/web/src/p2/pages/ReverseStocktakePage'
import { ReceiptCorrectionPage } from '../../apps/web/src/p2/pages/ReceiptCorrectionPage'
import { AuthProvider as PdaAuthProvider } from '../../apps/pda/src/auth'
import { ReverseMovePdaPage } from '../../apps/pda/src/p2/pages/ReverseMovePdaPage'

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

describe('逆向台账（WR-05/26/27）', () => {
  it('移库 tab 只读台账＋载具借还事件流＋所有物三分列', async () => {
    const user = userEvent.setup()
    seedSession(['reverse.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <ReverseLedgerPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const moveRow = await screen.findByRole('row', { name: /MV-20261028-0011/ })
    expect(within(moveRow).getByText('900.0000')).toBeInTheDocument()
    expect(within(moveRow).getByText('KG')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '载具借还' }))
    const loanRow = await screen.findByRole('row', { name: /TP-0091/ })
    expect(within(loanRow).getByText('借出')).toBeInTheDocument()
    expect(within(loanRow).getByText('华宇物流')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '所有物三分' }))
    const ownRow = await screen.findByRole('row', { name: /U-2026-1002-0002/ })
    expect(within(ownRow).getByText(/客户甲（来料加工）/)).toBeInTheDocument()
    expect(within(ownRow).getByText('n-plant')).toBeInTheDocument()
  })
})

describe('调拨出入库（WR-07/13/14/17）', () => {
  it('出库 tab：三来源列＋状态投影；入库 tab：入库方式列与码进度', async () => {
    const user = userEvent.setup()
    seedSession(['reverse.read', 'reverse.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <ReverseTransferPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const outRow = await screen.findByRole('row', { name: /TO-20261028-0003/ })
    expect(within(outRow).getByText('Web 有任务')).toBeInTheDocument()
    expect(within(outRow).getByText('生产调拨')).toBeInTheDocument()
    expect(within(outRow).getByText('待出库')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '调拨入库' }))
    const inRow = await screen.findByRole('row', { name: /TI-20261028-0002/ })
    expect(within(inRow).getByText(/扫码上架/)).toBeInTheDocument()
    expect(within(inRow).getByText('1/2')).toBeInTheDocument()
    // WR-17：仍有 pending 码 → 完成入库禁用
    expect(within(inRow).getByRole('button', { name: /完成入库（WR-17）/ })).toBeDisabled()
    const doneRow = screen.getByRole('row', { name: /TI-20261027-0006/ })
    expect(within(doneRow).getByText(/固定库位/)).toBeInTheDocument()
  })
})

describe('盘点与差异调整（WR-24）', () => {
  it('盘点中行显示锁仓徽标；差异调整单展示原因与去向列', async () => {
    seedSession(['reverse.read', 'reverse.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <ReverseStocktakePage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const countingRow = await screen.findByRole('row', { name: /SD-20261028-0001/ })
    expect(within(countingRow).getByText(/锁定中（拦截库存命令）/)).toBeInTheDocument()
    expect(within(countingRow).getByText('盘点中')).toBeInTheDocument()
    const adjRow = screen.getByRole('row', { name: /AD-20261020-0002/ })
    expect(within(adjRow).getByText(/盘点差异/)).toBeInTheDocument()
    expect(within(adjRow).getByText(/补记入待处理库位/)).toBeInTheDocument()
    expect(screen.getByText(/差异必须走调整单/)).toBeInTheDocument()
  })
})

describe('采购批次纠正（WR-19～23）', () => {
  it('回传失败行可重试；批次操作条件投影与下游拦截清单（WR-22）', async () => {
    seedSession(['reverse.read', 'reverse.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <ReceiptCorrectionPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const returnRow = await screen.findByRole('row', { name: /RC-20261027-0004/ })
    expect(within(returnRow).getByText('退货')).toBeInTheDocument()
    expect(within(returnRow).getByText(/回传失败（可重试）/)).toBeInTheDocument()
    expect(within(returnRow).getByRole('button', { name: /重试回传（WR-23）/ })).toBeInTheDocument()
    const blockedRow = screen.getByRole('row', { name: /LOT-20261020-02/ })
    expect(within(blockedRow).getAllByText(/已被下游使用/).length).toBeGreaterThan(0)
    expect(within(blockedRow).queryByRole('button', { name: /退货（WR-20）/ })).not.toBeInTheDocument()
  })

  it('退货弹层备注必填：空备注时确认不放行（WR-20 前端门）', async () => {
    const user = userEvent.setup()
    seedSession(['reverse.read', 'reverse.post'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <ReceiptCorrectionPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const batchRow = await screen.findByRole('row', { name: /LOT-20261026-01/ })
    await user.click(within(batchRow).getByRole('button', { name: /退货（WR-20）/ }))
    expect(await screen.findByText(/备注必填（≤200）、附件 ≤3/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认退货' })).toBeDisabled()
  })
})

describe('PDA 移库（WR-01/02）', () => {
  it('不在库码拒绝 [WR-02]；有效码暂存并提交成功', async () => {
    const user = userEvent.setup()
    seedSession(['reverse.read', 'reverse.post'], 'admin', 'cadenza.pda.session', 'PDA')
    render(
      <MemoryRouter>
        <PdaAuthProvider>
          <ReverseMovePdaPage />
        </PdaAuthProvider>
      </MemoryRouter>,
    )
    await user.type(screen.getByPlaceholderText(/扫描或输入条码后回车/), 'WR-NOSTOCK-01')
    await user.keyboard('{Enter}')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('WR-02')
    await user.type(screen.getByPlaceholderText(/扫描或输入条码后回车/), 'U-2026-1001-0001')
    await user.keyboard('{Enter}')
    await screen.findByText(/已暂存/)
    await user.type(screen.getByPlaceholderText(/移入库位编码/), '01010009')
    await user.click(screen.getByRole('button', { name: '提交移库' }))
    expect(await screen.findByRole('status')).toHaveTextContent('移库已提交')
  })
})
