import { t } from './i18n'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'
import { cn } from './cn'

export type BadgeTone = 'default' | 'success' | 'danger' | 'warning' | 'info'

const badgeVariants = cva(
  'inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        default: 'border-border bg-muted text-muted-foreground',
        success: 'border-success/30 bg-success/10 text-success',
        danger: 'border-destructive/30 bg-destructive/10 text-destructive',
        warning: 'border-warning/35 bg-warning/10 text-warning',
        info: 'border-info/30 bg-info/10 text-info',
      },
      size: {
        md: 'text-xs px-2 py-0.5',
        lg: 'px-2.5 py-1 text-[13px]',
      },
    },
    defaultVariants: {
      tone: 'default',
      size: 'md',
    },
  },
)

export interface BadgeProps extends VariantProps<typeof badgeVariants> {
  tone?: BadgeTone
  size?: 'md' | 'lg'
  className?: string
  children: ReactNode
}

export function Badge({ tone = 'default', size = 'md', className, children, ...rest }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} data-slot="badge" {...rest}>
      {children}
    </span>
  )
}

/** mock 模式全局标识（任务书：mock 与真实模式在界面明确标识"演示数据"）。 */
export function MockBadge() {
  return (
    <Badge tone="warning" size="lg" aria-label={t('当前为演示数据模式')}>
      {t('演示数据')}
    </Badge>
  )
}
