// @vitest-environment jsdom
/**
 * 发运管理区测试（第五波；mock 演示数据与真实 DTO 同形）：
 * - PL 列表：状态轴 + 双回传状态列（A-T14-8 独立）；
 * - 备货工作台：三类行渲染、行扫满流转（A-T14-3）、五拒错误渲染、删码回退、补码；
 * - 打包：未满绑定拒（A-T14-4）→ 扫满 → 绑定成功；
 * - 出库确认：不足拒（A-T14-7 指名料品/段长）与成功（已出库+双回传）；
 * - 回传重试独立（实发轴/发货状态互不影响）。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createApiClient, formatErrorTitleAndDetail } from '@cadenza/ui'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { ShippingOrdersPage } from '../../apps/web/src/pages/ShippingOrdersPage'
import { ShippingOutboundPage } from '../../apps/web/src/pages/ShippingOutboundPage'
import { ShippingPackingPage } from '../../apps/web/src/pages/ShippingPackingPage'

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

const ADMIN_PERMISSIONS = ['org.read', 'shipping.read', 'shipping.post']

afterEach(() => {
  localStorage.removeItem(SESSION_KEY)
})

function renderWithAuth(ui: React.ReactElement): ReturnType<typeof render> {
  seedSession(ADMIN_PERMISSIONS)
  return render(
    <MemoryRouter>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  )
}

describe('PL 列表（A-T14-1 状态轴 + A-T14-8 双回传列）', () => {
  it('三态单渲染：状态轴标签、缺组成/齐备、双回传状态列（已出库单含同步失败）', async () => {
    renderWithAuth(<ShippingOrdersPage />)
    const rowA = await screen.findByRole('row', { name: /PL-2026-1028-001/ })
    expect(within(rowA).getByText('待装箱')).toBeInTheDocument()
    expect(within(rowA).getByText('齐备')).toBeInTheDocument()
    expect(within(rowA).getByLabelText('状态机：待装箱')).toBeInTheDocument()
    const rowB = screen.getByRole('row', { name: /PL-2026-1028-002/ })
    expect(within(rowB).getByText('待出库')).toBeInTheDocument()
    const rowC = screen.getByRole('row', { name: /PL-2026-1027-009/ })
    expect(within(rowC).getByText('已出库')).toBeInTheDocument()
    // 双回传状态列独立：实发轴=待同步、发货状态=同步失败（互不影响语义来自两列分立呈现）
    expect(within(rowC).getAllByText('待同步').length).toBeGreaterThanOrEqual(1)
    expect(within(rowC).getByText('同步失败')).toBeInTheDocument()
    expect(within(rowC).getByText(/admin｜2026-10-27 08:20/)).toBeInTheDocument()
  })

  it('详情弹窗：三类行（托盘/有轴/无轴）+ 打包任务 + 扫码记录', async () => {
    const user = userEvent.setup()
    renderWithAuth(<ShippingOrdersPage />)
    const rowB = await screen.findByRole('row', { name: /PL-2026-1028-002/ })
    await user.click(within(rowB).getByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('有轴单品')).toBeInTheDocument()
    expect(within(dialog).getByText('托盘行')).toBeInTheDocument()
    expect(within(dialog).getByText('PK-1028B01')).toBeInTheDocument()
    expect(within(dialog).getByText('SHPU-OK-003')).toBeInTheDocument()
  })
})

describe('备货工作台（A-T14-3 五拒一成 + 行扫满流转 + 删码/补码）', () => {
  it('三类行渲染（托盘/有轴/无轴）与进度（已扫/应扫）', async () => {
    renderWithAuth(<ShippingPackingPage />)
    const table = await screen.findByRole('table', { name: '备货行进度' })
    const axisRow = within(table).getByRole('row', { name: /CAX-A-01/ })
    expect(within(axisRow).getByText('有轴单品')).toBeInTheDocument()
    expect(within(axisRow).getByText('0/1')).toBeInTheDocument()
    expect(within(table).getAllByText('托盘行').length).toBeGreaterThanOrEqual(1)
    const plainRow = within(table).getByRole('row', { name: /200\.0000/ })
    expect(within(plainRow).getByText('无轴单品')).toBeInTheDocument()
    expect(within(plainRow).getByText('0/2')).toBeInTheDocument()
  })

  it('行扫满流转：有轴行装入合格码 → 行已装箱、单仍待装箱（托盘行未满）', async () => {
    const user = userEvent.setup()
    renderWithAuth(<ShippingPackingPage />)
    await screen.findByRole('table', { name: '备货行进度' })
    // 默认选中行 1（有轴）；输入合格演示码提交
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'SHPU-OK-001')
    await user.keyboard('{Enter}')
    expect(await screen.findByText(/装入成功：SHPU-OK-001/)).toBeInTheDocument()
    expect(await screen.findByText(/行进度 1\/1（已装箱）｜单状态 待装箱/)).toBeInTheDocument()
    // 行状态徽标翻转为已装箱
    const axisRow = screen.getByRole('row', { name: /CAX-A-01/ })
    expect(within(axisRow).getByText('已装箱')).toBeInTheDocument()
  })

  it('五拒渲染：待检（未审核）码拒装入，[A-T14-3] 错误文案可见', async () => {
    const user = userEvent.setup()
    renderWithAuth(<ShippingPackingPage />)
    await screen.findByRole('table', { name: '备货行进度' })
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'SHPU-PEND-001')
    await user.keyboard('{Enter}')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('A-T14-3')
    expect(alert.textContent).toContain('SHPU-PEND-001')
  })

  it('删码回退：删除本文件先行用例装入的 SHPU-OK-001 后，行退回待装箱', async () => {
    // 模块级 mock 状态共享：SHPU-OK-001 已由上文「行扫满流转」用例装入 sl-a1（同文件累积口径，同第四波先例）
    const user = userEvent.setup()
    renderWithAuth(<ShippingPackingPage />)
    const scanRow = await screen.findByRole('row', { name: /SHPU-OK-001/ })
    await user.click(within(scanRow).getByRole('button', { name: '删码' }))
    expect(await screen.findByText(/删码完成（行退回 待装箱/)).toBeInTheDocument()
    const axisRow = screen.getByRole('row', { name: /CAX-A-01/ })
    await waitFor(() => {
      expect(within(axisRow).getByText('待装箱')).toBeInTheDocument()
    })
  })

  it('补码：无轴行扫产品轴号（A-T14-5）计入已扫件数', async () => {
    const user = userEvent.setup()
    renderWithAuth(<ShippingPackingPage />)
    await screen.findByRole('table', { name: '备货行进度' })
    // 选无轴行（行2）
    await user.selectOptions(screen.getByRole('combobox', { name: '扫入目标行选择' }), 'sl-a2')
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'AX-2026-88-001')
    await user.keyboard('{Enter}')
    expect(await screen.findByText(/补码成功：AX-2026-88-001/)).toBeInTheDocument()
    expect(await screen.findByText(/行进度 1\/2（待装箱）/)).toBeInTheDocument()
  })
})

describe('打包（A-T14-4 先扫托码+调入库位 → 逐行扫满 → 绑定）', () => {
  it('未满绑定拒 → 扫满 → 绑定成功（bound）', async () => {
    const user = userEvent.setup()
    renderWithAuth(<ShippingPackingPage />)
    await screen.findByRole('table', { name: '备货行进度' })
    // 创建打包任务（默认选中 PL-A：托盘行 0/1）
    await user.click(screen.getByRole('button', { name: '创建打包任务' }))
    await user.click(screen.getByRole('button', { name: '创建（挂接未打包托盘行）' }))
    expect(await screen.findByText(/打包任务已创建/)).toBeInTheDocument()
    // 未满绑定 → [A-T14-4] 拒
    await user.click(screen.getByRole('button', { name: '绑定托码' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('A-T14-4')
    expect(alert.textContent).toContain('已扫/应扫未满')
    // 选托盘行装入合格码 → 扫满
    await user.selectOptions(screen.getByRole('combobox', { name: '扫入目标行选择' }), 'sl-a3')
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'SHPU-OK-005')
    await user.keyboard('{Enter}')
    await screen.findByText(/装入成功：SHPU-OK-005/)
    // 扫满后绑定成功
    await user.click(screen.getByRole('button', { name: '绑定托码' }))
    expect(await screen.findByText(/托码 PLT-2026-A01 已绑定/)).toBeInTheDocument()
  })
})

describe('出库确认（A-T14-7 应扫核对 + 确认出库 + A-T14-8 双回传）', () => {
  it('不足拒（A-T14-7）：待装箱单（行未扫满）确认出库被拒，指名单状态错误文案经错误映射渲染', async () => {
    // 页面级：核对清单存在未扫满行时「确认出库」禁用（前端呈现应扫不足）；
    // 命令级：对未扫满单（仍待装箱）直接调 shipConfirm → 422 [A-T14-7]，中文主文案映射。
    const client = createApiClient({ mode: 'mock' })
    await expect(client.shipConfirm({ plantId: 'n-plant', shipmentOrderId: 'shp-a' })).rejects.toMatchObject({
      code: 'ERR_BUSINESS_RULE',
      message: expect.stringContaining('A-T14-7'),
    })
    try {
      await client.shipConfirm({ plantId: 'n-plant', shipmentOrderId: 'shp-a' })
      expect.unreachable('应被拒绝')
    } catch (err) {
      const shaped = formatErrorTitleAndDetail(err as { code?: string; message?: string })
      expect(shaped.title).toContain('仅可自待出库')
      expect(shaped.detail).toContain('A-T14-7')
    }
    // 页面级分支：PL-B 核对清单全扫满 → 确认按钮可用（本用例不提交，留给下例）
    const user = userEvent.setup()
    renderWithAuth(<ShippingOutboundPage />)
    const row = await screen.findByRole('row', { name: /PL-2026-1028-002/ })
    await user.click(within(row).getByRole('button', { name: '应扫核对清单' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByText('扫满').length).toBe(2)
    expect(within(dialog).getByRole('button', { name: '确认出库' })).not.toBeDisabled()
  })

  it('确认出库成功：PL-B（全部行扫满）→ 已出库 + 出库人 + 双回传 pending/待同步', async () => {
    const user = userEvent.setup()
    renderWithAuth(<ShippingOutboundPage />)
    const row = await screen.findByRole('row', { name: /PL-2026-1028-002/ })
    await user.click(within(row).getByRole('button', { name: '应扫核对清单' }))
    const dialog = await screen.findByRole('dialog')
    // 核对清单：两行均扫满
    expect(within(dialog).getAllByText('扫满').length).toBe(2)
    await user.click(within(dialog).getByRole('button', { name: '确认出库' }))
    expect(await screen.findByText(/确认出库完成：PL-2026-1028-002/)).toBeInTheDocument()
    expect(await screen.findByText(/双回传（实发轴 pending／发货状态 pending）/)).toBeInTheDocument()
    // 已出库区出现该单
    await waitFor(() => {
      const shippedRow = screen.getByRole('row', { name: /PL-2026-1028-002/ })
      expect(within(shippedRow).getByText('已出库')).toBeInTheDocument()
    })
  })
})

describe('回传重试（A-T14-8 两列独立）', () => {
  it('发货状态回传重试成功（sync_failed → synced），实发轴列不受影响', async () => {
    const user = userEvent.setup()
    renderWithAuth(<ShippingOutboundPage />)
    const row = await screen.findByRole('row', { name: /PL-2026-1027-009/ })
    expect(within(row).getByText('同步失败')).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: '状态重试' }))
    expect(await screen.findByText(/回传重试完成（发货状态 → synced/)).toBeInTheDocument()
    await waitFor(() => {
      const rowAfter = screen.getByRole('row', { name: /PL-2026-1027-009/ })
      expect(within(rowAfter).getAllByText('已同步').length).toBeGreaterThanOrEqual(1)
      // 实发轴列仍为待同步（独立不受影响）
      expect(within(rowAfter).getAllByText('待同步').length).toBeGreaterThanOrEqual(1)
    })
  })
})
