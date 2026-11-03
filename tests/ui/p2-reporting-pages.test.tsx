// @vitest-environment jsdom
/**
 * T20 reporting 页面测试（P2-UI 线）：
 * - 库存统计：口径徽标与汇总键列（RP-01）、英尺列非米显示"-"（RP-03）、
 *   成品入库推导（RP-04）、勾选汇总服务端全量聚合（RP-05/17）；
 * - 轴查询：只读投影（RP-08）、采购来源轴报工固定"-"且不作为筛选值（RP-09）；
 * - 报工口径汇总：五口径分列不混成完成量（RP-16）、按单位分组（RP-14）、勾选行汇总；
 * - 指标与追溯：指标版本化与 immutable（RP-19）、快照缺失不以 0 冒充（RP-21）、
 *   追溯正反向（RP-22）；PDA 累计报工口径分开（RP-13）。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { StockStatisticsPage } from '../../apps/web/src/p2/pages/StockStatisticsPage'
import { AxisQueryPage } from '../../apps/web/src/p2/pages/AxisQueryPage'
import { ReportSummaryPage } from '../../apps/web/src/p2/pages/ReportSummaryPage'
import { ShiftMetricsPage } from '../../apps/web/src/p2/pages/ShiftMetricsPage'
import { AuthProvider as PdaAuthProvider } from '../../apps/pda/src/auth'
import { PdaCumulativePdaPage } from '../../apps/pda/src/p2/pages/PdaCumulativePdaPage'

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

describe('库存统计（RP-01/03/04/05）', () => {
  it('生产码行：口径徽标、基准标注、英尺列与成品入库推导；采购收货码行英尺为"-"', async () => {
    seedSession(['reporting.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <StockStatisticsPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const prodRow = await screen.findByRole('row', { name: /U-2026-1001-0001/ })
    expect(within(prodRow).getByText('生产码')).toBeInTheDocument()
    expect(within(prodRow).getByText(/2400\.0000/)).toBeInTheDocument()
    expect(within(prodRow).getByText(/（基本单位）/)).toBeInTheDocument()
    expect(within(prodRow).getByText('7874.0157')).toBeInTheDocument()
    expect(within(prodRow).getByText(/成品已入库/)).toBeInTheDocument()
    const purchaseRow = screen.getByRole('row', { name: /U-2026-1026-0011/ })
    expect(within(purchaseRow).getByText('采购收货码')).toBeInTheDocument()
    expect(within(purchaseRow).getByText('SUP-B-0912')).toBeInTheDocument()
    expect(within(purchaseRow).getByText('待检')).toBeInTheDocument()
    expect(within(purchaseRow).getByText('-')).toBeInTheDocument() // 英尺非米显示"-"（RP-03）
  })

  it('勾选汇总：服务端全量聚合（RP-05），按单位分组展示', async () => {
    const user = userEvent.setup()
    seedSession(['reporting.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <StockStatisticsPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('row', { name: /U-2026-1001-0001/ })
    await user.click(screen.getByLabelText('选择 U-2026-1001-0001'))
    await user.click(screen.getByRole('button', { name: /勾选汇总（RP-05）/ }))
    expect(await screen.findByText(/勾选汇总：共 1 件/)).toBeInTheDocument()
    expect(screen.getByText(/KG：2400\.0000/)).toBeInTheDocument()
  })
})

describe('轴查询（RP-08/09）', () => {
  it('只读投影：多状态分列；采购来源轴报工固定"-"且筛选值不含"-"', async () => {
    seedSession(['reporting.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <AxisQueryPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(screen.getByText(/只查询\/导出，无新增\/修改\/删除\/详情入口（RP-08）/)).toBeInTheDocument()
    const prodRow = await screen.findByRole('row', { name: /U-2026-1001-0001/ })
    expect(within(prodRow).getByText('在库')).toBeInTheDocument()
    expect(within(prodRow).getByText('已锁定')).toBeInTheDocument()
    expect(within(prodRow).getByText('已销售')).toBeInTheDocument()
    expect(within(prodRow).getByText('已报工')).toBeInTheDocument()
    const purchaseRow = screen.getByRole('row', { name: /U-2026-1026-0011/ })
    expect(within(purchaseRow).getByText('-')).toBeInTheDocument() // 报工固定"-"（RP-09）
    // RP-09：报工状态筛选不提供"-"（采购来源轴不可按报工状态筛）
    const reportSelect = screen.getByRole('combobox', { name: '报工状态' })
    expect(within(reportSelect).queryByRole('option', { name: '-' })).not.toBeInTheDocument()
    expect(within(reportSelect).getByRole('option', { name: '未报工' })).toBeInTheDocument()
    expect(within(reportSelect).getByRole('option', { name: '已报工' })).toBeInTheDocument()
  })
})

describe('报工口径汇总（RP-14/16/17）', () => {
  it('五口径分列展示不混成一个完成量；勾选行汇总走服务端全量聚合', async () => {
    const user = userEvent.setup()
    seedSession(['reporting.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <ReportSummaryPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: '查询汇总' }))
    const draftRow = await screen.findByRole('row', { name: /^草稿/ })
    expect(within(draftRow).getByText(/KG：3000\.0000/)).toBeInTheDocument()
    const stockedRow = screen.getByRole('row', { name: /^入库/ })
    expect(within(stockedRow).getByText(/KG：1800\.0000/)).toBeInTheDocument()
    expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(5) // 五口径各一行
    await user.click(screen.getByRole('button', { name: /汇总勾选行（rep-1、rep-2）/ }))
    expect(await screen.findByText(/口径 审核｜轴数 2/)).toBeInTheDocument()
    expect(screen.getByText(/KG：200\.0000/)).toBeInTheDocument()
    expect(screen.getByText(/英尺（RP-03）/)).toBeInTheDocument()
  })
})

describe('指标与追溯（RP-18～22）', () => {
  it('指标定义：版本与口径版本分列；被快照引用即 immutable（RP-19）', async () => {
    seedSession(['reporting.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <ShiftMetricsPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    const wipRow = await screen.findByRole('row', { name: /wip_axis_count/ })
    expect(within(wipRow).getByText('CAL-WIP-2026Q4')).toBeInTheDocument()
    expect(within(wipRow).getByText('是（不可改）')).toBeInTheDocument()
  })

  it('班次快照：分母缺失保留标记与原因，不以 0 冒充（RP-21）', async () => {
    const user = userEvent.setup()
    seedSession(['reporting.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <ShiftMetricsPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('row', { name: /wip_axis_count/ })
    await user.click(screen.getByRole('button', { name: '班次快照' }))
    const missingRow = await screen.findByRole('row', { name: /2026-10-26/ })
    expect(within(missingRow).getByText('分母缺失')).toBeInTheDocument()
    expect(within(missingRow).getAllByText(/不以 0 冒充/).length).toBeGreaterThan(0)
    expect(within(missingRow).getByText(/分母事实集缺报工数量/)).toBeInTheDocument()
  })

  it('追溯正向：根轴→轴段→客户交付，边类型徽标与数量随行（RP-22/IT-35）', async () => {
    const user = userEvent.setup()
    seedSession(['reporting.read'])
    render(
      <MemoryRouter>
        <AuthProvider>
          <ShiftMetricsPage />
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('row', { name: /wip_axis_count/ })
    await user.click(screen.getByRole('button', { name: /追溯（RP-22）/ }))
    await user.click(screen.getByRole('button', { name: '追溯' }))
    expect(await screen.findByText(/方向：正向｜根：U-2026-1001-0001/)).toBeInTheDocument()
    expect(screen.getByText(/U-2026-1101-0001/)).toBeInTheDocument()
    expect(screen.getByText('生产产出')).toBeInTheDocument()
    expect(screen.getAllByText(/1500\.0000/).length).toBeGreaterThanOrEqual(2) // 两条边数量随行
  })
})

describe('PDA 累计报工（RP-13）', () => {
  it('口径分开统计；操作工只算自己；排除历史导入行如实展示', async () => {
    const user = userEvent.setup()
    seedSession(['reporting.read'], 'admin', 'cadenza.pda.session', 'PDA')
    render(
      <MemoryRouter>
        <PdaAuthProvider>
          <PdaCumulativePdaPage />
        </PdaAuthProvider>
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText(/KG：1200\.0000/)).toBeInTheDocument()
    expect(screen.getByText(/已排除历史导入行（8 行/)).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: '统计范围' }), 'self')
    expect(await screen.findByText(/KG：420\.0000/)).toBeInTheDocument()
  })
})
