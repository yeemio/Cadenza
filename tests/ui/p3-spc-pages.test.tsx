// @vitest-environment jsdom
/**
 * SPC 域页面测试（P3-UI；mock 演示数据与真实 DTO 同形——形状对齐 application spc-queries）：
 * - 工艺变更：PE-06 三类影响分组、PE-04 在制逐单处置与发布守卫（未处置禁止发布）、
 *   转新版生成调整指令（PE-04②）；
 * - 控制图：PE-09 默认规则集标注、PE-10 判定绑定控制限版本、越限样本自动生成失控任务
 *   （PE-12）、处置→复控确认闭环；
 * - 计量校准：PE-15 追加式校准、PE-17 不可排产判定（CS-05③）、PE-18/19 失准圈定与逐项处置；
 * - 工具寿命：PE-20 预警阈值状态、PE-21 具名调整理由必填。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { SpcCalibrationPage } from '../../apps/web/src/p3/pages/SpcCalibrationPage'
import { SpcChartsPage } from '../../apps/web/src/p3/pages/SpcChartsPage'
import { SpcChangesPage } from '../../apps/web/src/p3/pages/SpcChangesPage'
import { SpcToolsPage } from '../../apps/web/src/p3/pages/SpcToolsPage'
import { resetMockP3State } from '../../packages/ui/src/api/p3'

const SESSION_KEY = 'cadenza.web.session'
const ADMIN_PERMISSIONS = ['spc.read', 'spc.post']

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

describe('工艺变更（PE-04/PE-06）', () => {
  it('详情三类影响分组：未执行/在制（未处置标记）/已完成（不可变更）', async () => {
    renderWithAuth(<SpcChangesPage />)
    expect(await screen.findByText(/CHG-2026-1028-001/)).toBeInTheDocument()
    // 未执行组
    expect(await screen.findByText(/① 受影响未执行任务/)).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /MO-2026-1027-003/ })).toBeInTheDocument()
    // 在制组：未处置标记
    const inProcessRow = screen.getByRole('row', { name: /MO-2026-1027-001/ })
    expect(within(inProcessRow).getByText('未处置')).toBeInTheDocument()
    // 已完成组
    expect(screen.getByText(/③ 已完成\/已发运（不可变更/)).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /MO-2026-1026-008/ })).toBeInTheDocument()
  })

  it('发布守卫：在制未处置时发布被拒（[PE-04] 可行动文案）', async () => {
    const user = userEvent.setup()
    renderWithAuth(<SpcChangesPage />)
    await screen.findByText(/① 受影响未执行任务/)
    await user.click(screen.getByRole('button', { name: '发布变更' }))
    expect(await screen.findByText(/存在 1 个未处置的在制任务/)).toBeInTheDocument()
    // 规则码映射主文案与服务端原文（detail）并存——PC-14 口径
    expect((await screen.findAllByText(/变更发布前须逐单选择处置（继续旧版\/转新版\/隔离评审），不允许不选择即发布/)).length).toBeGreaterThan(0)
  })

  it('逐单处置（转新版生成调整指令）→ 发布成功', async () => {
    const user = userEvent.setup()
    renderWithAuth(<SpcChangesPage />)
    const inProcessRow = await screen.findByRole('row', { name: /MO-2026-1027-001/ })
    await user.selectOptions(within(inProcessRow).getByRole('combobox'), 'switch_new')
    expect(await screen.findByText(/MO-2026-1027-001 绞制 已处置/)).toBeInTheDocument()
    // 调整指令：96.0000 → 100.8000（在制行与调整行都含 96.0000，按 100.8000 定位调整行）
    const adjRows = await screen.findAllByRole('row', { name: /100\.8000/ })
    expect(adjRows.length).toBeGreaterThanOrEqual(1)
    await user.click(screen.getByRole('button', { name: '发布变更' }))
    expect(await screen.findByText(/CHG-2026-1028-001 已发布/)).toBeInTheDocument()
    expect(await screen.findByText(/新版本只影响获准的未执行任务，历史实绩保留旧参数不重算（PE-02）/)).toBeInTheDocument()
  })
})

describe('SPC 控制图（PE-09/10/11/12）', () => {
  it('默认规则集标注（PE-09）与失控点判定（绑定控制限版本 v2）', async () => {
    renderWithAuth(<SpcChartsPage />)
    expect(await screen.findByText('默认规则集（PE-09，采用版本待裁 GAP-E14）')).toBeInTheDocument()
    // 失控样本行：0.5412 → 单点越限，限 v2
    const oocRow = await screen.findByRole('row', { name: /0\.5412/ })
    expect(within(oocRow).getByText(/失控：单点越限（限 v2）/)).toBeInTheDocument()
    // 控制图 SVG 渲染（含 UCL/CL/LCL 参考线与失控橙点）
    const svg = screen.getByRole('img', { name: /OD-01 控制图/ })
    expect(within(svg).getAllByText(/UCL 0\.5334/).length).toBe(1)
    expect(within(svg).getAllByText(/CL 0\.5270/).length).toBe(1)
  })

  it('登记越限样本 → 自动生成失控处置任务（PE-12）并闭环（处置→复控确认）', async () => {
    const user = userEvent.setup()
    renderWithAuth(<SpcChartsPage />)
    await screen.findByRole('row', { name: /0\.5412/ })
    await user.click(screen.getByRole('button', { name: '登记样本' }))
    const dialog = await screen.findByRole('dialog', { name: /登记 SPC 样本/ })
    await user.clear(within(dialog).getByRole('textbox', { name: '测量值' }))
    await user.type(within(dialog).getByRole('textbox', { name: '测量值' }), '0.5501')
    await user.click(within(dialog).getByRole('button', { name: '提交样本' }))
    expect(await screen.findByText(/已生成 SPC 异常处置任务（PE-12）/)).toBeInTheDocument()
    // 处置闭环：处置（原因分类+纠正措施）→ 复控确认
    const oocRow = await screen.findByRole('row', { name: /OOC-2026-1028-002/ })
    await user.click(within(oocRow).getByRole('button', { name: '处置' }))
    const disposeDialog = await screen.findByRole('dialog', { name: /失控处置/ })
    await user.type(within(disposeDialog).getByRole('textbox', { name: '原因分类' }), '模具磨损')
    await user.type(within(disposeDialog).getByRole('textbox', { name: '纠正措施' }), '更换模具并复测')
    await user.click(within(disposeDialog).getByRole('button', { name: '提交处置' }))
    expect(await screen.findByText(/处置已记录；复控确认后闭环/)).toBeInTheDocument()
    const disposedRow = await screen.findByRole('row', { name: /OOC-2026-1028-002/ })
    await user.click(within(disposedRow).getByRole('button', { name: '复控确认' }))
    expect(await screen.findByText(/已确认复控，处置链闭环/)).toBeInTheDocument()
  })

  it('坏点样本登记被拒绝准入（PE-11：记录保留可查、不入控制图）', async () => {
    const user = userEvent.setup()
    renderWithAuth(<SpcChartsPage />)
    await screen.findByRole('row', { name: /0\.5412/ })
    await user.click(screen.getByRole('button', { name: '登记样本' }))
    const dialog = await screen.findByRole('dialog', { name: /登记 SPC 样本/ })
    await user.type(within(dialog).getByRole('textbox', { name: '测量值' }), '0.5280')
    // 出具器具切换为失准器具 g-002（演示 OT-12/PE-11 校准状态可疑拒绝准入）
    await user.clear(within(dialog).getByRole('textbox', { name: '出具器具' }))
    await user.type(within(dialog).getByRole('textbox', { name: '出具器具' }), 'g-002')
    await user.click(within(dialog).getByRole('button', { name: '提交样本' }))
    expect(await screen.findByText(/样本已登记但拒绝准入（PE-11）/)).toBeInTheDocument()
    expect(await screen.findByText(/校准状态可疑样本（OT-12）不得入 SPC/)).toBeInTheDocument()
  })
})

describe('计量校准（PE-15/17/18/19）', () => {
  it('失准器具：状态失准＋检测类任务不可排产（CS-05 硬约束③）；校准历史追加式', async () => {
    const user0 = userEvent.setup()
    renderWithAuth(<SpcCalibrationPage />)
    await user0.click(await screen.findByRole('button', { name: '查询器具' }))
    expect(await screen.findByText(/G-DIA-002 激光测径仪/)).toBeInTheDocument()
    // 当前状态失准（Badge）＋ 校准历史行结果失准（各一处）
    expect((await screen.findAllByText('失准')).length).toBeGreaterThanOrEqual(2)
    expect(await screen.findByText('不可排产（CS-05 硬约束③）')).toBeInTheDocument()
    // 校准历史（最新在前：cal-003）
    const historyRow = await screen.findByRole('row', { name: /JJG-laser-2026-021/ })
    expect(within(historyRow).getByText('2026-03-30')).toBeInTheDocument()
  })

  it('登记校准记录：追加不改写（PE-15），状态按最新记录翻转', async () => {
    const user = userEvent.setup()
    renderWithAuth(<SpcCalibrationPage />)
    await user.click(await screen.findByRole('button', { name: '查询器具' }))
    await screen.findByText(/G-DIA-002/)
    await user.click(screen.getByRole('button', { name: '登记校准记录' }))
    const dialog = await screen.findByRole('dialog', { name: /登记校准记录/ })
    await user.type(within(dialog).getByRole('textbox', { name: '证书编号' }), 'JJG-laser-2026-099')
    await user.click(within(dialog).getByRole('button', { name: '提交校准记录' }))
    expect(await screen.findByText(/校准记录已追加（PE-15：新校准不改写旧记录/)).toBeInTheDocument()
    expect(await screen.findByText('可排产')).toBeInTheDocument()
  })

  it('失准圈定：已发运进入客诉提示（PE-19）、处置进度逐项推进（PE-18）', async () => {
    const user = userEvent.setup()
    renderWithAuth(<SpcCalibrationPage />)
    await user.click(await screen.findByRole('button', { name: '查询器具' }))
    await screen.findByText(/G-DIA-002/)
    await user.click(screen.getByRole('button', { name: '查询失准圈定（PE-18，只读追溯清单）' }))
    expect(await screen.findByText(/已处置 0 \/ 待处置 12/)).toBeInTheDocument()
    expect(await screen.findByText(/客诉\/召回提示（PE-19）：已发运 U-2026-0910-0005/)).toBeInTheDocument()
    // 已发运单元行 → 登记处置 → 进度 acted=1
    const shippedRow = screen.getByRole('row', { name: /U-2026-0910-0005/ })
    await user.click(within(shippedRow).getByRole('button', { name: '登记处置' }))
    const actionDialog = await screen.findByRole('dialog', { name: /失准处置：U-2026-0910-0005/ })
    await user.click(within(actionDialog).getByRole('button', { name: '登记处置' }))
    expect(await screen.findByText(/U-2026-0910-0005 已登记处置/)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText(/已处置 1 \/ 待处置 11/)).toBeInTheDocument()
    })
  })
})

describe('工具寿命（PE-20/21）', () => {
  it('接近预警阈值状态与累计列；具名调整理由必填（PE-21 服务端口径拒绝）', async () => {
    const user = userEvent.setup()
    renderWithAuth(<SpcToolsPage />)
    const toolRow = await screen.findByRole('row', { name: /TL-DIE-014/ })
    expect(within(toolRow).getByText('接近预警阈值')).toBeInTheDocument()
    await screen.findByText(/台账详情：TL-DIE-014/)
    await user.click(screen.getByRole('button', { name: '具名调整' }))
    const dialog = await screen.findByRole('dialog', { name: /具名调整/ })
    await user.type(within(dialog).getByRole('textbox', { name: '调整增量' }), '-1500')
    await user.click(within(dialog).getByRole('button', { name: '提交调整' }))
    // 理由为空 → 服务端口径拒绝文案（规则码映射主文案）
    expect(await screen.findByText(/寿命修正必须填写具名调整理由并留审计/)).toBeInTheDocument()
  })

  it('具名调整入账：调整审计行与累计更新', async () => {
    const user = userEvent.setup()
    renderWithAuth(<SpcToolsPage />)
    await screen.findByRole('row', { name: /TL-DIE-014/ })
    await screen.findByText(/台账详情：TL-DIE-014/)
    await user.click(screen.getByRole('button', { name: '具名调整' }))
    const dialog = await screen.findByRole('dialog', { name: /具名调整/ })
    await user.type(within(dialog).getByRole('textbox', { name: '调整增量' }), '-1500')
    await user.type(within(dialog).getByRole('textbox', { name: '调整理由' }), '计量修正：上次报工重复计入 1500 米')
    await user.click(within(dialog).getByRole('button', { name: '提交调整' }))
    expect(await screen.findByText(/具名调整已入账/)).toBeInTheDocument()
    expect((await screen.findAllByRole('row', { name: /-1500/ })).length).toBeGreaterThanOrEqual(1)
  })
})
