// @vitest-environment jsdom
/**
 * 表格分页测试（@cadenza/ui Table）：
 * - 总计显示服务端 total（PC-16：不依赖已加载分页数据）；
 * - 首页"上一页"禁用、末页"下一页"禁用；
 * - 翻页回调携带目标页码。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Table } from '@cadenza/ui'

interface Row {
  id: string
  name: string
}

function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: `r-${i + 1}`, name: `行${i + 1}` }))
}

const columns = [{ key: 'name', title: '名称' }]

function findPaginationInfo(): HTMLElement {
  // 分页信息节点（文本被拆分为多个子节点，直接按容器类名定位）
  const el = document.querySelector('.cz-pagination__info')
  expect(el).not.toBeNull()
  return el as HTMLElement
}

describe('Table 分页（服务端分页口径）', () => {
  it('显示服务端 total：仅加载 10 行时总计仍为 28（PC-16）', () => {
    render(
      <Table<Row>
        columns={columns}
        rows={makeRows(10)}
        rowKey={(r) => r.id}
        page={{ page: 1, pageSize: 10 }}
        total={28}
        onPageChange={() => {}}
      />,
    )
    expect(findPaginationInfo()).toHaveTextContent('共 28 条 / 第 1/3 页（每页 10 条）')
    // 已加载行数与总计分离：仅 10 行在表格内
    expect(screen.getAllByRole('row')).toHaveLength(11) // 1 表头 + 10 数据行
  })

  it('首页上一页禁用；点击下一页回调 page=2；第 3 页下一页禁用', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn()
    const { rerender } = render(
      <Table<Row>
        columns={columns}
        rows={makeRows(10)}
        rowKey={(r) => r.id}
        page={{ page: 1, pageSize: 10 }}
        total={28}
        onPageChange={onPageChange}
      />,
    )
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '下一页' }))
    expect(onPageChange).toHaveBeenCalledWith(2)

    rerender(
      <Table<Row>
        columns={columns}
        rows={makeRows(8)}
        rowKey={(r) => r.id}
        page={{ page: 3, pageSize: 10 }}
        total={28}
        onPageChange={onPageChange}
      />,
    )
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled()
  })

  it('空数据显示空态文案', () => {
    render(
      <Table<Row>
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        emptyText="暂无数据"
      />,
    )
    expect(screen.getByText('暂无数据')).toBeInTheDocument()
  })
})
