// @vitest-environment jsdom
/**
 * 主数据区页面测试（第三波；mock 客户端演示数据与真实 DTO 同形）：
 * - 料品页只读语义（MD-01：无新增/删除入口）与换算行弹窗（版本/referenced 徽标 MD-05）；
 * - 仓库表单 MD-24 前端即时提示分支（物流部→仅仓库；车间→仅线边仓）与 MD-23 料品类型禁选；
 * - 许可显隐（PC-10）：无 masterdata.admin 时命令入口不出现、查询可用；
 * - 设备页状态标签（MD-13：2=维修）。
 * 页面经 useAuth 读许可 → 以 localStorage 会话种子驱动（/auth/me 口径 StoredSession 形状）。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../../apps/web/src/auth'
import { MasterEquipmentPage } from '../../apps/web/src/pages/MasterEquipmentPage'
import { MasterMaterialsPage } from '../../apps/web/src/pages/MasterMaterialsPage'
import { MasterWarehousesPage } from '../../apps/web/src/pages/MasterWarehousesPage'

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

function renderPage(ui: React.ReactElement): ReturnType<typeof render> {
  return render(<MemoryRouter><AuthProvider>{ui}</AuthProvider></MemoryRouter>)
}

const ADMIN_PERMISSIONS = [
  'org.read',
  'org.admin',
  'masterdata.read',
  'masterdata.admin',
  'inventory.read',
]
const READ_ONLY_PERMISSIONS = ['org.read', 'masterdata.read']

afterEach(() => {
  localStorage.removeItem(SESSION_KEY)
})

describe('料品管理页（MD-01 只读 + MD-04/05 换算行）', () => {
  it('列表只读：无新增/删除料品入口；行内提供「换算行」查看', async () => {
    seedSession(ADMIN_PERMISSIONS)
    renderPage(<MasterMaterialsPage />)
    const row = await screen.findByRole('row', { name: /CU-8\.00/ })
    expect(within(row).getByText('原料')).toBeInTheDocument()
    expect(within(row).getByText('质检')).toBeInTheDocument()
    // MD-01：料品主档由 U9 同步，页面无任何新增/删除料品按钮
    expect(screen.queryByRole('button', { name: '新建设备' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建料品' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建仓库' })).not.toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '换算行' })).toBeInTheDocument()
  })

  it('换算行弹窗：版本行渲染，referenced 行标记「已被引用」且修改/删除禁用（MD-05）', async () => {
    const user = userEvent.setup()
    seedSession(ADMIN_PERMISSIONS)
    renderPage(<MasterMaterialsPage />)
    const row = await screen.findByRole('row', { name: /CU-8\.00/ })
    await user.click(within(row).getByRole('button', { name: '换算行' }))
    const modal = await screen.findByRole('dialog')
    const v1 = await within(modal).findByRole('row', { name: /卷/ })
    expect(within(v1).getByText('已被引用')).toBeInTheDocument()
    expect(within(v1).getByRole('button', { name: '修改' })).toBeDisabled()
    expect(within(v1).getByRole('button', { name: '删除' })).toBeDisabled()
    expect(within(v1).getByRole('button', { name: '生成新版本' })).toBeEnabled()
    const v2 = within(modal).getByRole('row', { name: /捆/ })
    expect(within(v2).getByText('未引用')).toBeInTheDocument()
    expect(within(v2).getByRole('button', { name: '修改' })).toBeEnabled()
    // 弹窗提供新增换算行入口（本系统唯一可编辑部分）
    expect(within(modal).getByRole('button', { name: '新增换算行' })).toBeInTheDocument()
  })

  it('无 masterdata.admin 许可：换算行弹窗只读，不出现编辑按钮（PC-10）', async () => {
    const user = userEvent.setup()
    seedSession(READ_ONLY_PERMISSIONS)
    renderPage(<MasterMaterialsPage />)
    const row = await screen.findByRole('row', { name: /CU-8\.00/ })
    await user.click(within(row).getByRole('button', { name: '换算行' }))
    const modal = await screen.findByRole('dialog')
    expect(await within(modal).findByRole('row', { name: /卷/ })).toBeInTheDocument()
    expect(within(modal).queryByRole('button', { name: '新增换算行' })).not.toBeInTheDocument()
    expect(within(modal).getAllByText(/只读（需 masterdata\.admin）/).length).toBeGreaterThan(0)
  })
})

describe('仓库管理页（MD-24 前端即时提示 + MD-23 料品类型约束）', () => {
  it('MD-24：物流部建仓仅允许「仓库」，线边仓选项禁用并显示规则提示', async () => {
    const user = userEvent.setup()
    seedSession(ADMIN_PERMISSIONS)
    renderPage(<MasterWarehousesPage />)
    await screen.findByRole('row', { name: /原料一库/ })
    await user.click(screen.getByRole('button', { name: '新建仓库' }))
    const modal = await screen.findByRole('dialog')
    const deptSelect = within(modal).getByDisplayValue(/请选择部门/)
    // mock 部门：物流一部（deptCategory=3）→ 仅允许 WAREHOUSE（MD-24 默认规则）
    await user.selectOptions(deptSelect, 'n-log')
    // 提示出现在「建仓部门」与「仓库类型」两个字段 hint（同一条 MD-24 约束）
    expect(within(modal).getAllByText(/该部门类型（物流部）仅允许创建仓库（MD-24，服务端终校）/).length).toBeGreaterThanOrEqual(1)
    const typeSelect = within(modal).getByDisplayValue('仓库') as HTMLSelectElement
    const lineSideOption = Array.from(typeSelect.options).find((o) => o.value === 'LINE_SIDE')
    expect(lineSideOption?.disabled).toBe(true)
    // MD-23：仓库类型下「半成品」不在允许集合，禁选
    expect(within(modal).getByLabelText('半成品')).toBeDisabled()
  })

  it('MD-24：车间部门仅允许「线边仓」，部门切换后类型自动收敛', async () => {
    const user = userEvent.setup()
    seedSession(ADMIN_PERMISSIONS)
    renderPage(<MasterWarehousesPage />)
    await screen.findByRole('row', { name: /原料一库/ })
    await user.click(screen.getByRole('button', { name: '新建仓库' }))
    const modal = await screen.findByRole('dialog')
    const deptSelect = within(modal).getByDisplayValue(/请选择部门/)
    await user.selectOptions(deptSelect, 'n-draw')
    expect(within(modal).getAllByText(/该部门类型（车间）仅允许创建线边仓（MD-24，服务端终校）/).length).toBeGreaterThanOrEqual(1)
    const typeSelect = within(modal).getByDisplayValue('线边仓') as HTMLSelectElement
    const warehouseOption = Array.from(typeSelect.options).find((o) => o.value === 'WAREHOUSE')
    expect(warehouseOption?.disabled).toBe(true)
    // 线边仓允许半成品（MD-23：LINE_SIDE → 原料/半成品/成品）
    expect(within(modal).getByLabelText('半成品')).toBeEnabled()
  })

  it('无 masterdata.admin 许可：新建入口不出现，列表仍可查询（PC-10）', async () => {
    seedSession(READ_ONLY_PERMISSIONS)
    renderPage(<MasterWarehousesPage />)
    await screen.findByRole('row', { name: /成品一库/ })
    expect(screen.queryByRole('button', { name: '新建仓库' })).not.toBeInTheDocument()
    // 查询仍可用：二维码占用徽标（MD-26 展示）
    const row = screen.getByRole('row', { name: /成品一库/ })
    expect(within(row).getByText('已占用')).toBeInTheDocument()
  })
})

describe('设备管理页（MD-13 状态标签）', () => {
  it('维修中设备显示「维修」标签，正常设备显示「正常」', async () => {
    seedSession(ADMIN_PERMISSIONS)
    renderPage(<MasterEquipmentPage />)
    const repairRow = await screen.findByRole('row', { name: /中拉机 02/ })
    expect(within(repairRow).getByText('维修')).toBeInTheDocument()
    const normalRow = screen.getByRole('row', { name: /中拉机 01/ })
    expect(within(normalRow).getByText('正常')).toBeInTheDocument()
  })
})
