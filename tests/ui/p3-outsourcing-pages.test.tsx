// @vitest-environment jsdom
/**
 * 外协页面测试（P3-UI；形状按当前 csw 控制器/仓储——并行线在途，L0 整合对账）：
 * - CS-19 状态机：草稿→提交→发送→回厂→检验→关闭全链路；按钮按状态启用（PC-10/11）；
 * - CS-20/25 所有权保留与外协占用提示；CS-21 发送/接收须带单元行；
 * - CS-24 ERP 加工数量事实导出；PDA 扫码回厂接收（PC-03/05/06/21）。
 * 注意：mock 为模块级内存状态，同文件用例按顺序共享状态（先例：第四波五量断言同型）。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { AuthProvider as PdaAuthProvider } from '../../apps/pda/src/auth'
import { OutsourcingReceivePage } from '../../apps/pda/src/p3/pages/OutsourcingReceivePage'
import { OutsourcingTasksPage } from '../../apps/web/src/p3/pages/OutsourcingTasksPage'
import { createP3Client, resetMockP3State } from '../../packages/ui/src/api/p3'
import { ApiError } from '@cadenza/ui'

const SESSION_KEY = 'cadenza.web.session'
const PDA_SESSION_KEY = 'cadenza.pda.session'

function seedSession(key: string, platform: 'WEB' | 'PDA'): void {
  localStorage.setItem(
    key,
    JSON.stringify({
      token: 'mock-token-test',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: {
        userId: 'user-s-1', loginName: 'admin', displayName: '系统管理员',
        enterpriseId: 'n-ent', enterpriseName: '中辰线缆集团', plantId: 'n-plant',
        plantName: '杭州制造工厂', roleId: 'role-admin', roleName: '系统管理员', loginPlatform: platform,
      },
      permissions: ['csw.read', 'csw.post'],
      dataScope: { enterpriseWide: true, plantIds: ['n-plant'] },
    }),
  )
}

function renderWeb(): ReturnType<typeof render> {
  seedSession(SESSION_KEY, 'WEB')
  return render(
    <MemoryRouter>
      <AuthProvider>
        <OutsourcingTasksPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

/** 主表与 ERP 导出表都含任务号：按附加标记定位主表行（ERP 行先渲染的竞态下轮询重试） */
async function taskRow(no: string, marker: RegExp): Promise<HTMLElement> {
  let found: HTMLElement | undefined
  await waitFor(() => {
    const rows = screen.getAllByRole('row', { name: new RegExp(no) })
    found = rows.find((r) => within(r).queryByText(marker) !== null)
    if (found === undefined) throw new Error(`未找到含 ${marker} 的 ${no} 行`)
  })
  return found!
}

/**
 * 点击并校验结果（列表 reload 的加载中→重挂载窗口内元素可能被替换，偶发点击落到
 * 脱挂节点上）：点击后等待期望结果；未出现则以新查询的元素重试（命令侧由状态机
 * 守卫兜底，重复点击只会收到可判定拒绝，不会双记账）。
 */
/**
 * 点击并校验结果（列表刷新窗口内元素偶发被替换、点击落到脱挂节点时）：
 * 点击后等待期望结果；未出现则以新查询的元素重试（命令侧由状态机守卫兜底，
 * 重复点击只会收到可判定拒绝，不会双记账——PC-08 同一命令同一套规则）。
 */
async function clickUntil(
  user: ReturnType<typeof userEvent.setup>,
  getTarget: () => HTMLElement,
  outcome: () => void,
  attempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let target: HTMLElement
    try {
      target = getTarget()
    } catch {
      await new Promise((r) => setTimeout(r, 120))
      continue
    }
    await user.click(target)
    try {
      await waitFor(outcome, { timeout: 1200 })
      return
    } catch (err) {
      if (attempt === attempts) throw err
    }
  }
  throw new Error('click 未生效（重试耗尽）')
}

afterEach(() => {
  localStorage.removeItem(SESSION_KEY)
  localStorage.removeItem(PDA_SESSION_KEY)
  resetMockP3State()
})

describe('外协任务（CS-19～CS-25）', () => {
  it('状态机各阶段任务与外协占用提示（CS-20/25）；无发送行不允许关闭（按钮按状态启用）', async () => {
    renderWeb()
    const sentRow = await taskRow('OWT-2026-1028-003', /^已发送（在外加工）$/)
    expect(within(sentRow).getByText('已发送（在外加工）')).toBeInTheDocument()
    expect(within(sentRow).getByText('占用中（本厂不排产）')).toBeInTheDocument()
    const closedRow = await taskRow('OWT-2026-1026-004', /已关闭/)
    expect(within(closedRow).getByText('已关闭')).toBeInTheDocument()
    // 草稿任务只有「提交待发送」与「详情」，无发送/关闭按钮（PC-10/11：未交付能力不显示）
    const draftRow = await taskRow('OWT-2026-1028-001', /提交待发送/)
    expect(within(draftRow).getByRole('button', { name: '提交待发送' })).toBeInTheDocument()
    expect(within(draftRow).queryByRole('button', { name: '发送' })).not.toBeInTheDocument()
    expect(within(draftRow).queryByRole('button', { name: '关闭' })).not.toBeInTheDocument()
  })

  it('全链路：提交→发送（带单元行）→回厂接收→检验通过→关闭；CS-21 不带单元行被拒', async () => {
    const user = userEvent.setup()
    renderWeb()
    // 提交待发送（草稿）
    await taskRow('OWT-2026-1028-001', /提交待发送/)
    await clickUntil(
      user,
      () => within(taskRowSync('OWT-2026-1028-001', /提交待发送/)).getByRole('button', { name: '提交待发送' }),
      () => void screen.getByText(/已提交待发送/),
    )
    // 发送（先空行提交 → CS-21 拒绝）
    await taskRow('OWT-2026-1028-001', /^待发送$/)
    await clickUntil(
      user,
      () => within(taskRowSync('OWT-2026-1028-001', /^待发送$/)).getByRole('button', { name: '发送' }),
      () => screen.getByRole('dialog', { name: /外协发送：OWT-2026-1028-001/ }),
    )
    const sendDialog = await screen.findByRole('dialog', { name: /外协发送：OWT-2026-1028-001/ })
    await user.click(within(sendDialog).getByRole('button', { name: /确认发送/ }))
    expect(await screen.findByText(/\[CS-21\] 交接须携带单元行/)).toBeInTheDocument()
    await user.type(within(sendDialog).getByRole('textbox', { name: '单元 ID 1' }), 'unit-1009-0001')
    await user.type(within(sendDialog).getByRole('textbox', { name: '数量 1' }), '48')
    await user.click(within(sendDialog).getByRole('button', { name: /确认发送/ }))
    expect(await screen.findByText(/材料所有权保留不变，库存状态转入外协在途（CS-20）/)).toBeInTheDocument()
    // 回厂接收（已发送行）
    await taskRow('OWT-2026-1028-001', /已发送（在外加工）/)
    await clickUntil(
      user,
      () => within(taskRowSync('OWT-2026-1028-001', /已发送（在外加工）/)).getByRole('button', { name: '回厂接收' }),
      () => screen.getByRole('dialog', { name: /回厂接收：OWT-2026-1028-001/ }),
    )
    const receiveDialog = await screen.findByRole('dialog', { name: /回厂接收：OWT-2026-1028-001/ })
    await user.type(within(receiveDialog).getByRole('textbox', { name: '单元 ID 1' }), 'unit-1009-0001')
    await user.type(within(receiveDialog).getByRole('textbox', { name: '数量 1' }), '47.5')
    await user.type(within(receiveDialog).getByRole('textbox', { name: '回厂批次 1' }), 'LOT-0540')
    await user.click(within(receiveDialog).getByRole('button', { name: /确认接收/ }))
    expect(await screen.findByText(/回厂接收完成/)).toBeInTheDocument()
    // 检验通过（回厂接收待检行）→ 关闭（检验中行）
    await taskRow('OWT-2026-1028-001', /检验结论/)
    await clickUntil(
      user,
      () => within(taskRowSync('OWT-2026-1028-001', /检验结论/)).getByRole('button', { name: '检验结论' }),
      () => screen.getByRole('dialog', { name: /回厂检验结论：OWT-2026-1028-001/ }),
    )
    const inspectDialog = await screen.findByRole('dialog', { name: /回厂检验结论：OWT-2026-1028-001/ })
    await user.click(within(inspectDialog).getByRole('button', { name: '提交检验结论' }))
    expect(await screen.findByText(/检验结论已登记（通过）/)).toBeInTheDocument()
    await taskRow('OWT-2026-1028-001', /关闭/)
    await clickUntil(
      user,
      () => within(taskRowSync('OWT-2026-1028-001', /关闭/)).getByRole('button', { name: '关闭' }),
      () => void screen.getByText(/已关闭：工序完成判定走报工\/接收事实/),
    )
  })

/** taskRow 的同步版（clickUntil 内重试用：元素须即时取，避免持有脱挂引用） */
function taskRowSync(no: string, marker: RegExp): HTMLElement {
  const rows = screen.getAllByRole('row', { name: new RegExp(no) })
  const row = rows.find((r) => within(r).queryByText(marker) !== null)
  if (row === undefined) throw new Error(`未找到含 ${marker} 的 ${no} 行`)
  return row
}

  it('服务端状态机终校：非 draft 提交被 [CS-19] 拒绝（client 直连，规则码映射主文案）', async () => {
    const client = createP3Client({ mode: 'mock' })
    const err = await client.cswOutsourcingSubmit({ taskId: 'owt-002' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    const message = (err as ApiError).message
    expect(message).toContain('[CS-19]')
    // 已发送任务重复接收（先走一次合法接收改状态）→ 再 submit 拒绝
    await client.cswOutsourcingReceive({ taskId: 'owt-003', lines: [{ unitId: 'unit-1005-0001', quantity: '48' }] })
    const err2 = await client.cswOutsourcingSubmit({ taskId: 'owt-003' }).catch((e: unknown) => e)
    expect((err2 as ApiError).message).toContain('当前状态')
  })

  it('ERP 加工数量事实导出（CS-24）：含数量事实与结算归 ERP 说明', async () => {
    renderWeb()
    expect(await screen.findByText(/ERP 加工数量事实导出（CS-24）/)).toBeInTheDocument()
    expect(await screen.findByText(/商务结算归 ERP：本系统不记应付\/加工费\/发票/)).toBeInTheDocument()
    const erpRows = await screen.findAllByRole('row', { name: /OWT-2026-1026-004/ })
    expect(erpRows.some((r) => within(r).queryByText('苏州恒晟挤塑加工') !== null)).toBe(true)
  })
})

describe('PDA 外协接收（CS-21 回厂段；PC-03/05/06/21）', () => {
  it('错码清旧对象；扫单元号匹配任务→数量+单位同现→回厂接收服务端入账', async () => {
    const user = userEvent.setup()
    seedSession(PDA_SESSION_KEY, 'PDA')
    render(
      <MemoryRouter>
        <PdaAuthProvider>
          <OutsourcingReceivePage />
        </PdaAuthProvider>
      </MemoryRouter>,
    )
    // 在外加工任务提示（等待加载）
    await screen.findByText(/OWT-2026-1028-003（96\.0000 盘）/)
    // 错码 → 失败反馈并清除旧对象（PC-05）
    await user.type(screen.getByPlaceholderText(/扫\/输单元号/), 'XYZ-BAD-999{Enter}')
    expect(await screen.findByText(/未识别为库存单元码/)).toBeInTheDocument()
    expect(screen.queryByText(/OWT-2026-1028-003 ｜ MO-2026-1027-002／挤塑/)).not.toBeInTheDocument()
    expect(screen.queryByText(/OWT-2026-1028-003（96\.0000 盘）/)).not.toBeNull() // 任务清单区不受影响
    // 正确单元号 → 匹配卡片（数量与单位同现，PC-06；预填应回厂余量 48=发送 48−已回 0）
    await user.type(screen.getByPlaceholderText(/扫\/输单元号/), 'unit-1005-0001{Enter}')
    const card = await screen.findByText(/OWT-2026-1028-003 ｜ MO-2026-1027-002／挤塑/)
    expect(within(card.parentElement!).getByText(/发送量 96\.0000 盘/)).toBeInTheDocument()
    const qtyInput = screen.getByRole('textbox', { name: '回厂数量' })
    await user.clear(qtyInput)
    await user.type(qtyInput, '96')
    await user.click(screen.getByRole('button', { name: '确认回厂' }))
    expect(await screen.findByText(/已回厂接收 96 盘/)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText(/回厂后默认全部必检（CS-22）/)).toBeInTheDocument()
    })
  })
})
