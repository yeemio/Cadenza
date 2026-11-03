// @vitest-environment jsdom
/**
 * 成本/能源页面测试（P3-UI；端点与形状对齐落盘 apps/api/src/cost——P3-D 2026-10-28 落盘形态）：
 * - CE-17 估算与实测两列并存（缺项显示缺项说明，不互相覆盖）；
 * - CE-03/05/07/14/15 明细带源事实 ID、实测/估算分列、理论/差异分列、缺价不计金额；
 * - CE-11 首跑/显式重算守卫（已有产出拒首跑、重算理由必填＋新旧对照）；
 * - CE-16/CE-S5 对账差异处置（理由必填）；CA-12 工时核对（OT 缺项不冒充）；
 * - CE-09 覆盖率与估算标注；CE-10 OEE 分母缺项（不显示假百分比）。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { CostEnergyPage } from '../../apps/web/src/p3/pages/CostEnergyPage'
import { CostReportsPage } from '../../apps/web/src/p3/pages/CostReportsPage'
import { resetMockP3State } from '../../packages/ui/src/api/p3'

const SESSION_KEY = 'cadenza.web.session'

function seedSession(): void {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: 'mock-token-test',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: {
        userId: 'user-s-1', loginName: 'admin', displayName: '系统管理员',
        enterpriseId: 'n-ent', enterpriseName: '中辰线缆集团', plantId: 'n-plant',
        plantName: '杭州制造工厂', roleId: 'role-admin', roleName: '系统管理员', loginPlatform: 'WEB',
      },
      permissions: ['cost.read', 'cost.post'],
      dataScope: { enterpriseWide: true, plantIds: ['n-plant'] },
    }),
  )
}

function renderWithAuth(ui: React.ReactElement): ReturnType<typeof render> {
  seedSession()
  return render(
    <MemoryRouter>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  localStorage.removeItem(SESSION_KEY)
  resetMockP3State()
})

describe('成本报表（CE-17/03/14/05/15/18）', () => {
  it('归集产出：估算/实测两列并存；缺价→实测缺项（CE-14）、无 BOM→估算缺项（CE-17/03）', async () => {
    renderWithAuth(<CostReportsPage />)
    // 两列并存的产出（CE-17）
    const fullRow = await screen.findByRole('row', { name: /CR-2026-1027-001/ })
    expect(within(fullRow).getByText('130680.0000')).toBeInTheDocument()
    expect(within(fullRow).getByText('141605.5000')).toBeInTheDocument()
    // CE-14 缺价 → 实测列缺项（不计金额）
    const noPriceRow = screen.getByRole('row', { name: /CR-2026-1027-002/ })
    expect(within(noPriceRow).getByText(/缺项（存在缺价行，CE-14 不计金额）/)).toBeInTheDocument()
    // 无 BOM → 估算列缺项
    const noBomRow = screen.getByRole('row', { name: /CR-2026-1026-101/ })
    expect(within(noBomRow).getByText(/缺项（无已发布 BOM 版本/)).toBeInTheDocument()
    // 能源实测/估算与覆盖率同列呈现（CE-09）
    expect(within(fullRow).getByText(/18400\.0000 \/ 4800\.0000 KWH（79\.3%，CE-09）/)).toBeInTheDocument()
  })

  it('归集明细：源事实 ID 可回算（CE-15）、实测/估算分列、倒冲标注估算（CE-08）、订单在制列示（CE-18）', async () => {
    const user = userEvent.setup()
    renderWithAuth(<CostReportsPage />)
    const fullRow = await screen.findByRole('row', { name: /CR-2026-1027-001/ })
    await user.click(within(fullRow).getByRole('button', { name: '明细＋订单汇总' }))
    // 明细行：材料实耗（实测）带源事实表+ID（CE-05/15）与理论/差异分列（CE-07）
    const materialRow = await screen.findByRole('row', { name: /material_consumption／mc-20261027-0012/ })
    expect(within(materialRow).getByText('实测')).toBeInTheDocument()
    expect(within(materialRow).getByText(/18000\.0000（差 600\.0000）/)).toBeInTheDocument()
    // 自动倒冲（CE-08）→ 估算标注
    const flushRow = screen.getByRole('row', { name: /自动倒冲/ })
    expect(within(flushRow).getByText('估算')).toBeInTheDocument()
    // 能源覆盖不足 → 估算
    const energyRow = screen.getByRole('row', { name: /mr-20261027-0089/ })
    expect(within(energyRow).getByText('估算')).toBeInTheDocument()
    // 订单汇总：估算行（BOM×价格版本）＋在制按工序已投入（CE-18）
    expect(await screen.findByText(/订单汇总：MO-2026-1027-001/)).toBeInTheDocument()
    const wipRow = screen.getByRole('row', { name: /19220\.0000/ })
    expect(within(wipRow).getByText('128.5000')).toBeInTheDocument()
  })

  it('CE-11 守卫：首跑撞既有产出被拒（可行动文案）；重算理由必填；重算输出新旧对照', async () => {
    const user = userEvent.setup()
    renderWithAuth(<CostReportsPage />)
    await screen.findByRole('row', { name: /CR-2026-1027-001/ })
    // 首跑：同订单同班次已有产出 → [CE-11] 拒绝
    await user.click(screen.getByRole('button', { name: '执行归集（首跑）' }))
    let dialog = await screen.findByRole('dialog', { name: /执行归集（首跑/ })
    // 演示默认 orderId=po-1027-001 / shiftDate=2026-10-28：改为已归集班次 2026-10-27
    const shiftInput = within(dialog).getByRole('textbox', { name: '班次日期' })
    await user.clear(shiftInput)
    await user.type(shiftInput, '2026-10-27')
    await user.click(within(dialog).getByRole('button', { name: '执行归集' }))
    // 规则码映射主文案（CE-11 收录文案）与服务端原文（detail）并存——PC-14 口径
    expect(await screen.findAllByText(/历史报表不随新分摊版本静默重算，重算为显式命令/)).not.toBeNull()
    expect(await screen.findByText(/已有归集产出——历史报表不静默重算，重算走显式命令/)).toBeInTheDocument()
    // 重算：理由为空 → 拒绝
    await user.click(screen.getByRole('button', { name: '显式重算（CE-11）' }))
    dialog = await screen.findByRole('dialog', { name: /显式重算/ })
    const reasonInput = within(dialog).getByRole('textbox', { name: '重算理由' })
    await user.click(within(dialog).getByRole('button', { name: '执行重算' }))
    expect(await screen.findByText(/显式重算必须填写理由/)).toBeInTheDocument()
    await user.type(reasonInput, '换用新价格版本重估')
    await user.click(within(dialog).getByRole('button', { name: '执行重算' }))
    expect(await screen.findByText(/重算完成：新旧对照已固化/)).toBeInTheDocument()
    expect(await screen.findByText(/priorRunId=run-001/)).toBeInTheDocument()
  })

  it('CE-16/CE-S5 对账差异：差异量并列展示、处置理由必填、处置后状态翻转', async () => {
    const user = userEvent.setup()
    renderWithAuth(<CostReportsPage />)
    await screen.findByRole('row', { name: /CR-2026-1027-001/ })
    const diffRow = await screen.findByRole('row', { name: /ERP-MV-202610-0451/ })
    expect(within(diffRow).getByText('80.0000')).toBeInTheDocument()
    expect(within(diffRow).getByText('未处置')).toBeInTheDocument()
    await user.click(within(diffRow).getByRole('button', { name: '处置' }))
    const dialog = await screen.findByRole('dialog', { name: /对账差异处置/ })
    await user.click(within(dialog).getByRole('button', { name: '提交处置' }))
    expect(await screen.findByText(/对账处置必须填写理由/)).toBeInTheDocument()
    await user.type(within(dialog).getByRole('textbox', { name: '处置理由' }), '计量口径差，业务确认')
    await user.click(within(dialog).getByRole('button', { name: '提交处置' }))
    expect(await screen.findByText(/已处置（已确认）/)).toBeInTheDocument()
  })

  it('CA-12 工时核对：报工工时主源 vs OT 参考（OT 缺项不冒充）；确认须理由', async () => {
    const user = userEvent.setup()
    renderWithAuth(<CostReportsPage />)
    await screen.findByRole('row', { name: /CR-2026-1027-001/ })
    // lc-002（挤塑）：OT 侧无数据 → 缺项（不以估算冒充）
    const missingRow = await screen.findByRole('row', { name: /挤塑/ })
    expect(within(missingRow).getByText(/缺项（OT 侧无数据）/)).toBeInTheDocument()
    // lc-001（拉丝）：偏差率在阈值内平铺展示
    const okRow = screen.getByRole('row', { name: /拉丝/ })
    expect(within(okRow).getByText(/0\.0988 \/ 0\.1000/)).toBeInTheDocument()
    await user.click(within(okRow).getByRole('button', { name: '确认留痕' }))
    const dialog = await screen.findByRole('dialog', { name: /工时核对确认/ })
    await user.type(within(dialog).getByRole('textbox', { name: '确认理由' }), '设备待机计入 OT 运行，报工无误')
    await user.click(within(dialog).getByRole('button', { name: '确认留痕' }))
    expect(await screen.findByText(/报工工时为主源不被改写，CA-12/)).toBeInTheDocument()
  })
})

describe('能源单耗（CE-09/CE-10/CE-S3）', () => {
  it('表计清单（CE-S3）与单耗实测/估算分列＋覆盖率分档；产出为零单耗缺项（CE-03）', async () => {
    renderWithAuth(<CostEnergyPage />)
    // 表计清单
    expect(await screen.findByRole('row', { name: /EM-F01-MAIN/ })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /WM-DRAW-01/ })).toBeInTheDocument()
    // 单耗行：部分覆盖 79.3%＋估算显著标注（CE-09）
    const yjvRow = await screen.findByRole('row', { name: /MO-2026-1027-001/ })
    expect(within(yjvRow).getByText('79.3%')).toBeInTheDocument()
    expect(within(yjvRow).getByText(/4800\.0000 KWH（估算，显著标注）/)).toBeInTheDocument()
    // 表计未装 → 0% 全估算；产出为零 → 单耗缺项（CE-03 不以 0 冒充）
    const bvRow = screen.getByRole('row', { name: /MO-2026-1026-008/ })
    expect(within(bvRow).getByText('0%（表计未装，全估算）')).toBeInTheDocument()
    expect(within(bvRow).getByText(/缺项（产出为零或全缺/)).toBeInTheDocument()
    // 全覆盖行
    const fullRow = screen.getByRole('row', { name: /MO-2026-1027-002/ })
    expect(within(fullRow).getByText('100%')).toBeInTheDocument()
  })

  it('OEE 查询（CE-10）：EQU-0007 分母缺项全缺项展示＋缺项清单；EQU-0001 齐备出百分比', async () => {
    const user = userEvent.setup()
    renderWithAuth(<CostEnergyPage />)
    await screen.findByRole('row', { name: /EM-F01-MAIN/ })
    // 默认 EQU-0007（缺项演示）
    await user.click(screen.getByRole('button', { name: '查询 OEE' }))
    const oeeRow = await screen.findByRole('row', { name: /EQU-0007/ })
    expect(within(oeeRow).getAllByText('缺项').length).toBeGreaterThanOrEqual(4)
    expect(await screen.findByText(/EQU-0007：标准速率未数值化（std_rate_text="约200米\/分"，GAP-S1）/)).toBeInTheDocument()
    // 切换齐备设备
    await user.clear(screen.getByRole('textbox', { name: '设备编码' }))
    await user.type(screen.getByRole('textbox', { name: '设备编码' }), 'EQU-0001')
    await user.click(screen.getByRole('button', { name: '查询 OEE' }))
    const okRow = await screen.findByRole('row', { name: /EQU-0001/ })
    expect(within(okRow).getByText('79.7%')).toBeInTheDocument()
  })
})
