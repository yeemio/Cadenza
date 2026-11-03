import { cva } from 'class-variance-authority'
import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from './cn'

export type MessageKind = 'success' | 'error' | 'info' | 'warning'

export interface MessageProps {
  kind: MessageKind
  /** 主错误/结果文案（同一次失败只展示一个主错误，PC-14） */
  title?: ReactNode
  /** 关联信息（如错误码、请求标识），供排查、不喧宾夺主 */
  detail?: ReactNode
  /** 无 title 时直接展示的内容 */
  children?: ReactNode
}

const messageVariants = cva(
  'cz-message flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm',
  {
    variants: {
      kind: {
        success: 'border-success/30 bg-success/10 text-success',
        error: 'border-destructive/30 bg-destructive/10 text-destructive',
        info: 'border-info/30 bg-info/10 text-info',
        warning: 'border-warning/35 bg-warning/10 text-warning',
      },
    },
    defaultVariants: { kind: 'info' },
  },
)

const ICONS = {
  success: CircleCheck,
  error: CircleX,
  info: Info,
  warning: TriangleAlert,
} as const

const roleOf: Record<MessageKind, string> = {
  success: 'status',
  error: 'alert',
  info: 'status',
  warning: 'alert',
}

export function Message({ kind, title, detail, children }: MessageProps) {
  const Icon = ICONS[kind]
  return (
    <div className={cn(messageVariants({ kind }), 'mb-3')} role={roleOf[kind]} data-slot="message">
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="mb-0.5 font-semibold">{title}</p> : null}
        {detail ? <p className="m-0 text-[13px] break-all opacity-90">{detail}</p> : null}
        {children}
      </div>
    </div>
  )
}
