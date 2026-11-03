import { t } from './i18n'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { Slot } from 'radix-ui'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** 提交中状态：置灰并显示 loading 文案（PC-09：错误后保持可继续操作） */
  loading?: boolean
  loadingText?: string
  block?: boolean
  /** 渲染为子元素（Radix Slot，便于包 a/Link；不传保持原生 button） */
  asChild?: boolean
  children?: ReactNode
}

/**
 * 按钮变体（Tailwind 令牌 + CVA）：
 * - primary  工业蓝实底（主操作）；
 * - secondary 卡片底描边（次操作，hover 时描边/文字转主色）；
 * - danger   语义红实底（危险操作）；
 * - ghost    无底透明（轻量操作）。
 * 尺寸 sm 28px / md 36px / lg 44px（PDA 大触区走 lg）。
 */
const buttonVariants = cva(
  'group/button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/35 active:translate-y-px disabled:pointer-events-none disabled:opacity-55 aria-busy:opacity-70 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground shadow-xs hover:bg-primary/88 active:bg-primary/95',
        secondary:
          'border-input bg-card text-foreground shadow-xs hover:border-primary/45 hover:text-primary hover:bg-primary/[0.04]',
        danger:
          'bg-destructive text-white shadow-xs hover:bg-destructive/90 active:bg-destructive/95',
        ghost: 'text-primary hover:bg-accent',
      },
      size: {
        sm: 'h-7 px-2.5 text-[13px] gap-1',
        md: 'h-9 px-4 text-sm',
        lg: 'h-11 px-5 text-[15px]',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
)

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  loadingText = t('处理中…'),
  block = false,
  asChild = false,
  disabled,
  className,
  children,
  style,
  type,
  ...rest
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(
        buttonVariants({ variant, size }),
        block && 'w-full',
        className,
      )}
      style={style}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <>
          <Loader2 className="animate-spin" aria-hidden />
          {loadingText}
        </>
      ) : (
        children
      )}
    </Comp>
  )
}
