// @vitest-environment jsdom
/**
 * 质量管理区测试（第四波；mock 演示数据与真实 DTO 同形）：
 * - 检验任务列表（来源/状态）；
 * - 检验执行页：实测值表单+结论提交（版本链追加与生效指针）；
 * - 让步操作：保留原不合格事实提示（A-T12-1）；
 * - 存疑登记/恢复（A-T12-3：处置依据必填）。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { QualityHoldsPage } from '../../apps/web/src/pages/QualityHoldsPage'
import { QualityInspectionDetailPage } from '../../apps/web/src/pages/QualityInspectionDetailPage'
import { QualityInspectionsPage } from '../../apps/web/src/pages/QualityInspectionsPage'

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

const ADMIN_PERMISSIONS = ['org.read', 'quality.read', 'quality.post']

afterEach(() => {
  localStorage.removeItem(SESSION_KEY)
})

function renderWithAuth(ui: React.ReactElement, initialEntry = '/'): ReturnType<typeof render> {
  seedSession(ADMIN_PERMISSIONS)
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  )
}

/** 详情页组件依赖 useParams：须经 Route 挂载（path 携带 :id） */
function renderDetail(initialEntry: string): ReturnType<typeof render> {
  seedSession(ADMIN_PERMISSIONS)
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>
        <Routes>
          <Route path="/quality/inspections/:id" element={<QualityInspectionDetailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('检验任务列表（来源/状态）', () => {
  it('QI-2026-1027-001 显示来源「报工（rp-002）」与「待检」状态', async () => {
    renderWithAuth(<QualityInspectionsPage />)
    const row = await screen.findByRole('row', { name: /QI-2026-1027-001/ })
    expect(within(row).getByText(/报工（rp-002）/)).toBeInTheDocument()
    expect(within(row).getByText('待检')).toBeInTheDocument()
    expect(within(row).getByText('过程检验')).toBeInTheDocument()
    // 已出结论 + 已处置的单（QI-2026-1026-008）
    const concludedRow = await screen.findByRole('row', { name: /QI-2026-1026-008/ })
    expect(within(concludedRow).getByText('已出结论')).toBeInTheDocument()
  })
})

describe('检验执行页（实测值表单 + 结论提交）', () => {
  it('qio-001 提交实测与结论：版本链追加 v1 并翻生效指针', async () => {
    const user = userEvent.setup()
    renderDetail('/quality/inspections/qio-001')
    expect(await screen.findByText(/QI-2026-1027-001/)).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('如 0.527'), '0.531')
    await user.click(screen.getByRole('button', { name: '提交实测与结论' }))
    expect(await screen.findByText(/实测已提交（版本 v1，初检）/)).toBeInTheDocument()
    // 版本链行：v1 生效中
    const chainRow = await screen.findByRole('row', { name: /v1/ })
    expect(within(chainRow).getByText('生效中')).toBeInTheDocument()
  })
})

describe('让步操作（保留原不合格事实）', () => {
  it('qio-003 让步放行：提示保留原不合格事实，引用 v1 原结论成功', async () => {
    const user = userEvent.setup()
    renderDetail('/quality/inspections/qio-003')
    expect(await screen.findByText(/QI-2026-1027-003/)).toBeInTheDocument()
    // 保留原不合格事实提示固定呈现
    expect(screen.getByText('让步放行保留原不合格事实')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /让步放行（保留原不合格事实）/ }))
    const dialog = await screen.findByRole('dialog', { name: /让步放行（保留原不合格事实）/ })
    await user.type(within(dialog).getByPlaceholderText('如 客户书面接受外观缺陷'), '客户书面接受外观缺陷')
    await user.click(within(dialog).getByRole('button', { name: '确认让步' }))
    expect(await screen.findByText(/已让步放行（引用原不合格结论 v1；原不合格事实保留/)).toBeInTheDocument()
    // 处置记录展示
    expect(await screen.findByText('让步放行')).toBeInTheDocument()
  })
})

describe('存疑登记/恢复（A-T12-3）', () => {
  it('登记 U-2026-1001-0001 → 存疑生效；恢复须填处置依据', async () => {
    const user = userEvent.setup()
    renderWithAuth(<QualityHoldsPage />)
    // 既有存疑行（hold-001 挤塑车间）
    const activeRow = await screen.findByRole('row', { name: /U-2026-1002-0005/ })
    expect(within(activeRow).getByText('质量存疑')).toBeInTheDocument()
    // 登记新存疑
    const manualInput = screen.getByRole('textbox', { name: '单元号' })
    await user.type(manualInput, 'U-2026-1001-0001')
    await user.click(screen.getByRole('button', { name: '登记存疑' }))
    expect(await screen.findByText(/U-2026-1001-0001 已登记存疑/)).toBeInTheDocument()
    // 恢复：处置依据必填
    const newRow = await screen.findByRole('row', { name: /U-2026-1001-0001/ })
    await user.click(within(newRow).getByRole('button', { name: '恢复' }))
    const dialog = await screen.findByRole('dialog', { name: '存疑恢复' })
    expect(within(dialog).getByRole('button', { name: '确认恢复' })).toBeDisabled()
    await user.type(within(dialog).getByRole('textbox'), '复检合格')
    await user.click(within(dialog).getByRole('button', { name: '确认恢复' }))
    expect(await screen.findByText(/存疑已恢复/)).toBeInTheDocument()
  })
})
