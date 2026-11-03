// @vitest-environment jsdom
/**
 * 用户管理页测试（apps/web OrgUsersPage，mock 客户端返回与真实 DTO 同形的演示数据）：
 * - 列表加载渲染（首行 admin，角色名经 roleId→角色列表映射解析）与服务端分页总计（28 条，PC-16）；
 * - 禁用账号状态徽标呈现（OA-16 口径的界面呈现）；
 * - loginNameLike 服务端过滤走客户端层统一入口。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { OrgUsersPage } from '../../apps/web/src/pages/OrgUsersPage'

function paginationInfo(): HTMLElement {
  const el = document.querySelector('.cz-pagination__info')
  expect(el).not.toBeNull()
  return el as HTMLElement
}

describe('用户管理页（mock 演示数据，真实 DTO 形状）', () => {
  it('加载演示用户列表：首行 admin，总计 28 条（服务端口径）', async () => {
    render(<OrgUsersPage />)
    // admin 行：角色名经 roleId→roles 映射解析为"系统管理员"（UserAccountDto 不含角色名字段）
    const firstRow = await screen.findByRole('row', { name: /admin/ })
    expect(within(firstRow).getAllByText('系统管理员').length).toBeGreaterThanOrEqual(1)
    expect(paginationInfo()).toHaveTextContent('共 28 条 / 第 1/3 页（每页 10 条）')
    // 禁用账号状态徽标（OA-16 界面呈现）
    const disabledRow = await screen.findByRole('row', { name: /qian06/ })
    expect(within(disabledRow).getByText('禁用')).toBeInTheDocument()
  })

  it('禁用账号显示"禁用"徽标；loginNameLike 过滤走客户端层统一入口', async () => {
    const user = userEvent.setup()
    render(<OrgUsersPage />)
    await screen.findByRole('row', { name: /qian06/ })
    const disabledRow = screen.getByRole('row', { name: /qian06/ })
    expect(within(disabledRow).getByText('禁用')).toBeInTheDocument()
    // 过滤 admin：loginNameLike 服务端过滤后仅剩 1 行（total=1）
    await user.type(screen.getByPlaceholderText('按登录账号搜索（loginNameLike）'), 'admin')
    expect(await screen.findByRole('row', { name: /admin/ })).toBeInTheDocument()
    expect(paginationInfo()).toHaveTextContent('共 1 条')
  })
})
