// @vitest-environment jsdom
/**
 * 采集域页面测试（P3-UI；mock 演示数据与真实 DTO 同形——形状对齐 application ot-queries）：
 * - 监控页：OT-29 必监项（离线/积压/去重异常/溢出）与 OT-28 无样本缺项；
 * - 样本页：OT-25 按设备收敛（未选设备不查询）、OT-22 坏点带原因、OT-20 时钟偏差、OT-13 人工绑定；
 * - 入账页：OT-26 评估生成候选 → 人工确认派发（Outbox）。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { OtFactsPage } from '../../apps/web/src/p3/pages/OtFactsPage'
import { OtMonitorPage } from '../../apps/web/src/p3/pages/OtMonitorPage'
import { OtSamplesPage } from '../../apps/web/src/p3/pages/OtSamplesPage'
import { resetMockP3State } from '../../packages/ui/src/api/p3'

const SESSION_KEY = 'cadenza.web.session'
const ADMIN_PERMISSIONS = ['ot.read', 'ot.post']

function seedSession(permissions: string[]): void {
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
      permissions,
      dataScope: { enterpriseWide: true, plantIds: ['n-plant'] },
    }),
  )
}

function renderWithAuth(ui: React.ReactElement): ReturnType<typeof render> {
  seedSession(ADMIN_PERMISSIONS)
  return render(
    <MemoryRouter>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  resetMockP3State()
})

afterEach(() => {
  localStorage.removeItem(SESSION_KEY)
})

describe('采集监控（OT-29/OT-28/OT-17）', () => {
  it('网关离线与缓冲积压、设备无样本缺项、去重异常与溢出告警同屏可见', async () => {
    renderWithAuth(<OtMonitorPage />)
    const gwRows = await screen.findAllByRole('row', { name: /GW-EXTR-02/ })
    const offlineRow = gwRows.find((row) => within(row).queryByText('离线') !== null)
    expect(offlineRow).toBeDefined()
    expect(within(offlineRow!).getByText('1280 条')).toBeInTheDocument()
    // OT-28：SN-DRAW-002 无样本 → 缺项，不以估算冒充
    const noDataRow = await screen.findByRole('row', { name: /SN-DRAW-002/ })
    expect(within(noDataRow).getByText('缺项（无样本）')).toBeInTheDocument()
    // OT-07：SN-EXTR-009 未映射 → 隔离态提示
    const quarantinedRows = screen.getAllByRole('row', { name: /SN-EXTR-009/ })
    expect(quarantinedRows.some((row) => within(row).queryByText('未映射（OT-07 隔离）') !== null)).toBe(true)
    // 去重异常（>阈值 100）
    expect(await screen.findByText('128（异常）')).toBeInTheDocument()
    // OT-17 溢出告警（丢弃最旧样本并记录统计，不静默丢弃）
    expect(await screen.findByText(/缓冲溢出告警（OT-17）/)).toBeInTheDocument()
  })

  it('执行巡检（ot.post）：完成提示含离线数，离线事件留痕口径', async () => {
    const user = userEvent.setup()
    renderWithAuth(<OtMonitorPage />)
    await user.click(await screen.findByRole('button', { name: '执行巡检' }))
    expect(await screen.findByText(/巡检完成：检查 2 个网关，离线 1 个/)).toBeInTheDocument()
  })
})

/** 设备下拉异步加载：等待选项出现后再选择 */
async function selectDevice(user: ReturnType<typeof userEvent.setup>, value: string): Promise<void> {
  await screen.findByRole('option', { name: new RegExp(value) })
  await user.selectOptions(screen.getByRole('combobox', { name: '设备序列号' }), value)
}

describe('采集样本（OT-25/OT-22/OT-20/OT-13）', () => {
  it('未选设备不查询（OT-25 服务端同样拒绝）；选设备后样本行含双轨时间与坏点原因', async () => {
    const user = userEvent.setup()
    renderWithAuth(<OtSamplesPage />)
    expect(await screen.findByText('请先选择设备（OT-25：样本明细必须按设备收敛）')).toBeInTheDocument()
    await selectDevice(user, 'SN-DRAW-001')
    const badRow = await screen.findByRole('row', { name: /182060\.0 M/ })
    expect(within(badRow).getAllByText(/量程越界/).length).toBeGreaterThan(0)
    expect(within(badRow).getAllByText(/质量码 bad/).length).toBeGreaterThan(0)
    // OT-09 双轨时间分列
    expect(within(badRow).getAllByText(/2026-10-28T09:12/).length).toBeGreaterThan(0)
    // OT-20 时钟偏差样本
    const skewRow = screen.getByRole('row', { name: /860\.0 m\/min/ })
    expect(within(skewRow).getByText(/时钟偏差（偏差超阈值）/)).toBeInTheDocument()
  })

  it('只看坏点筛选收敛结果；坏点样本不参与业务判定的口径可见', async () => {
    const user = userEvent.setup()
    renderWithAuth(<OtSamplesPage />)
    await selectDevice(user, 'SN-DRAW-001')
    await screen.findByRole('row', { name: /182060\.0 M/ })
    await user.click(screen.getByLabelText('只看坏点'))
    await screen.findByRole('row', { name: /182060\.0 M/ })
    await waitFor(() => {
      expect(screen.queryByRole('row', { name: /860\.0 m\/min/ })).not.toBeInTheDocument()
    })
  })

  it('待确认样本人工绑定工序会话（OT-13 留痕，不自动静默改绑）', async () => {
    const user = userEvent.setup()
    renderWithAuth(<OtSamplesPage />)
    await selectDevice(user, 'SN-DRAW-001')
    const skewRow = await screen.findByRole('row', { name: /860\.0 m\/min/ })
    await user.click(within(skewRow).getByRole('button', { name: '人工绑定' }))
    const dialog = await screen.findByRole('dialog', { name: /样本-工序会话人工绑定/ })
    await user.type(within(dialog).getByRole('textbox', { name: /工序会话 ID/ }), 'exec-20261028-a')
    await user.click(within(dialog).getByRole('button', { name: '确认绑定' }))
    expect(await screen.findByText(/已人工绑定/)).toBeInTheDocument()
    // reload 落地后行标签翻转（waitFor 规避 notice 先于列表刷新的竞态）
    await waitFor(() => {
      const updatedRow = screen.getByRole('row', { name: /860\.0 m\/min/ })
      expect(within(updatedRow).getByText('人工绑定')).toBeInTheDocument()
    })
  })
})

describe('采集入账（OT-26）', () => {
  it('评估生成事实候选 → 人工确认派发（Outbox 入列）；映射确认规则标签可见', async () => {
    const user = userEvent.setup()
    renderWithAuth(<OtFactsPage />)
    // 映射清单：manual 模式须人工确认（确认规则标签）
    const mappingRow = await screen.findByRole('row', { name: /P-LEN/ })
    expect(within(mappingRow).getByText('须人工确认')).toBeInTheDocument()
    // 既有待确认候选 fact-001
    const factRow = await screen.findByRole('row', { name: /fact-001/ })
    expect(within(factRow).getByText('待确认')).toBeInTheDocument()
    await user.click(within(factRow).getByRole('button', { name: '人工确认' }))
    const confirmDialog = await screen.findByRole('dialog', { name: '确认采集入账（OT-26）' })
    await user.click(within(confirmDialog).getByRole('button', { name: '确认派发' }))
    expect(await screen.findByText(/fact-001 已确认派发/)).toBeInTheDocument()
    const dispatchedRow = await screen.findByRole('row', { name: /fact-001/ })
    expect(within(dispatchedRow).getByText('已派发')).toBeInTheDocument()
    expect(within(dispatchedRow).getAllByText(/oevt-/).length).toBeGreaterThan(0)
  })

  it('显式评估生成新候选（评估为显式命令，非自动入账）', async () => {
    const user = userEvent.setup()
    renderWithAuth(<OtFactsPage />)
    await screen.findByRole('row', { name: /fact-001/ })
    await user.click(screen.getAllByRole('button', { name: '评估生成候选' })[0]!)
    expect(await screen.findByText(/评估完成：生成事实候选 fact-/)).toBeInTheDocument()
    expect(await screen.findByRole('row', { name: /fact-003/ })).toBeInTheDocument()
  })
})
