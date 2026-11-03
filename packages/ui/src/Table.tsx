import { t } from './i18n'
import type { PageRequest, PageResult } from '@cadenza/contracts'
import { Loader2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './Button'
import { cn } from './cn'

export interface TableColumn<TItem> {
  key: string
  title: ReactNode
  /** 单元格渲染；默认取 row[key] */
  render?: (item: TItem, index: number) => ReactNode
  width?: number | string
}

export interface TableProps<TItem> {
  columns: ReadonlyArray<TableColumn<TItem>>
  rows: ReadonlyArray<TItem>
  rowKey: (item: TItem, index: number) => string
  /** 服务端分页结果；total 以服务端返回为准，不依赖已加载页数据（PC-16） */
  page?: PageRequest | null
  onPageChange?: (page: number) => void
  /** 服务端返回的总行数（PC-16：总计不依赖已加载分页数据） */
  total?: number
  loading?: boolean
  emptyText?: string
  /** 行密度：default 舒适（生产看板）/ compact 高密度（台账、核对类页面） */
  density?: 'default' | 'compact'
}

const cellDensity = {
  default: 'px-3.5 py-2.5',
  compact: 'px-3 py-1.5',
} as const

export function Table<TItem>({
  columns,
  rows,
  rowKey,
  page,
  onPageChange,
  total,
  loading,
  emptyText = t('暂无数据'),
  density = 'default',
}: TableProps<TItem>) {
  const showPagination = Boolean(page && onPageChange)
  // 内部页码跟随受控 page，输入框可临时编辑
  const [pageInput, setPageInput] = useState(page?.page ?? 1)
  const currentPage = page?.page
  useEffect(() => {
    if (currentPage != null) setPageInput(currentPage)
  }, [currentPage])

  const totalPages = page && typeof total === 'number' && page.pageSize > 0
    ? Math.max(1, Math.ceil(total / page.pageSize))
    : 1

  const cell = cellDensity[density]

  return (
    <div data-slot="table">
      <div className="w-full overflow-x-auto rounded-lg border border-border bg-card shadow-xs">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/60">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    'text-left font-semibold whitespace-nowrap text-muted-foreground',
                    cell,
                  )}
                  style={col.width ? { width: col.width } : undefined}
                >
                  {col.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  className={cn(
                    'text-center whitespace-nowrap text-muted-foreground',
                    cell,
                  )}
                  colSpan={columns.length}
                >
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    加载中…
                  </span>
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  className="py-7! text-center text-muted-foreground"
                  colSpan={columns.length}
                >
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((item, index) => (
                <tr key={rowKey(item, index)} className="border-b transition-colors last:border-b-0 hover:bg-accent/70">
                  {columns.map((col) => (
                    <td key={col.key} className={cn('whitespace-nowrap text-foreground', cell)}>
                      {col.render
                        ? col.render(item, index)
                        : String((item as Record<string, unknown>)[col.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {showPagination && page && onPageChange ? (
        <nav
          className="mt-2.5 flex flex-wrap items-center justify-end gap-2.5 py-1 text-[13.5px] text-muted-foreground"
          aria-label={t('分页')}
        >
          <span className="cz-pagination__info">
            {t('共 {total} 条 / 第 {page}/{totalPages} 页（每页 {pageSize} 条）', {
              total: total ?? '—',
              page: page.page,
              totalPages,
              pageSize: page.pageSize,
            })}
          </span>
          <span className="inline-flex gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={page.page <= 1}
              onClick={() => onPageChange(page.page - 1)}
            >
              {t('上一页')}
            </Button>
            <PaginationJumper
              pageInput={pageInput}
              setPageInput={setPageInput}
              totalPages={totalPages}
              onJump={(target) => onPageChange(target)}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={page.page >= totalPages}
              onClick={() => onPageChange(page.page + 1)}
            >
              {t('下一页')}
            </Button>
          </span>
        </nav>
      ) : null}
    </div>
  )
}

function PaginationJumper({
  pageInput,
  setPageInput,
  totalPages,
  onJump,
}: {
  pageInput: number
  setPageInput: (v: number) => void
  totalPages: number
  onJump: (page: number) => void
}) {
  const lastCommitted = useRef(pageInput)
  return (
    <span className="inline-flex" aria-label={t('跳页')}>
      <input
        className="h-7 w-14 rounded-md border border-input bg-card text-center text-[13px] shadow-xs transition-[border-color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25"
        aria-label={t('页码')}
        value={pageInput}
        inputMode="numeric"
        onChange={(e) => {
          const v = Number(e.target.value.replace(/[^0-9]/g, ''))
          setPageInput(Number.isFinite(v) ? v : lastCommitted.current)
        }}
        onBlur={() => {
          const target = Math.min(Math.max(1, pageInput || 1), totalPages)
          lastCommitted.current = target
          setPageInput(target)
          onJump(target)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            const target = Math.min(Math.max(1, pageInput || 1), totalPages)
            lastCommitted.current = target
            setPageInput(target)
            onJump(target)
          }
        }}
      />
    </span>
  )
}

/** 构造分页请求参数的辅助（1 起始页码）。 */
export function pageRequest(page: number, pageSize: number): PageRequest {
  return { page, pageSize }
}

/** 从 PageResult 提取安全展示用的总数（PC-16：以服务端 total 为准）。 */
export function totalOf<T>(result: PageResult<T> | null | undefined): number | undefined {
  return result ? result.total : undefined
}
