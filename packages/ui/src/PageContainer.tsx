import type { ReactNode } from 'react'
import { cn } from './cn'

/**
 * 页面容器：统一页面标题、描述与操作区（Tailwind 令牌版）。
 * PC-18：页面标题与菜单名保持同一岗位可理解名称，由调用方传入。
 */
export interface PageContainerProps {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  /** 紧凑模式：内容直接贴合作区（表格密集页）；默认带卡片化留白 */
  flush?: boolean
}

export function PageContainer({ title, description, actions, children, flush = false }: PageContainerProps) {
  return (
    <section className="flex min-w-0 flex-col gap-4" data-slot="page-container">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b pb-4">
        <div className="min-w-0">
          <h2 className="m-0 text-xl leading-tight font-semibold tracking-tight text-foreground">{title}</h2>
          {description ? (
            <p className="mt-1.5 mb-0 text-[13px] leading-snug text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2.5">{actions}</div> : null}
      </header>
      <div className={cn('min-h-0', !flush && 'pb-1')} data-slot="page-body">
        {children}
      </div>
    </section>
  )
}
