import { t } from './i18n'
import { X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import type { ReactNode } from 'react'
import { Button } from './Button'
import { cn } from './cn'

export interface ModalProps {
  open: boolean
  title: ReactNode
  onClose: () => void
  size?: 'sm' | 'md' | 'lg'
  footer?: ReactNode
  children?: ReactNode
}

const sizeClass: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
}

/**
 * 弹窗（Radix Dialog 原语 + Tailwind 令牌）。
 * 行为兼容点：
 * - open=false 不渲染任何内容；ESC 关闭（走 onClose）；遮罩点击关闭（遮罩自身
 *   onPointerDown，与旧版"点遮罩关闭"一致）；
 * - 关闭逻辑不走 DismissableLayer 的 document 级外点监听（onPointerDownOutside/
 *   onInteractOutside 均阻止默认）：旧版在"弹窗未关时点击页面元素触发重开/换题"
 *   的既有行为（jsdom 测试依赖，如 CE-11 错误路径后直接点"显式重算"）保持不变；
 * - 采用 modal={false}（非模态）：不加 aria-hidden 到背景——既有的"弹窗未关时
 *   页面级 alert 仍可被角色查询"的行为保持不变（PC-14 主错误可并存的观察路径）。
 */
export function Modal({ open, title, onClose, size = 'md', footer, children }: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }} modal={false}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-foreground/45 backdrop-blur-[2px]',
            'data-[state=open]:animate-[cz-overlay-in_150ms_ease-out]',
            'data-[state=closed]:animate-[cz-overlay-out_120ms_ease-in]',
          )}
          onPointerDown={() => onClose()}
        />
        <Dialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2.5rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-card shadow-lg outline-none',
            sizeClass[size],
            'data-[state=open]:animate-[cz-content-in_170ms_cubic-bezier(0.16,1,0.3,1)]',
            'data-[state=closed]:animate-[cz-content-out_120ms_ease-in]',
          )}
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="flex items-center justify-between border-b px-5 py-3.5">
            <Dialog.Title className="m-0 text-base font-semibold text-foreground">{title}</Dialog.Title>
            <Dialog.Close
              className="rounded-md p-1.5 text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/35"
              aria-label={t('关闭')}
            >
              <X className="size-4.5" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <div className="flex justify-end gap-2.5 border-t px-5 py-3">{footer}</div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export interface ConfirmModalProps {
  open: boolean
  /** 危险操作（删除/撤销类）必须显式展示后果（PC-13） */
  tone?: 'danger' | 'primary'
  title: ReactNode
  /** 后果描述，必填语义：调用方应写明影响范围 */
  description: ReactNode
  confirmText?: string
  cancelText?: string
  onConfirm: () => void
  onCancel: () => void
  confirmLoading?: boolean
}

export function ConfirmModal({
  open,
  tone = 'primary',
  title,
  description,
  confirmText = t('确认'),
  cancelText = t('取消'),
  onConfirm,
  onCancel,
  confirmLoading,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={confirmLoading}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <p className="m-0 text-sm leading-relaxed text-foreground">{description}</p>
    </Modal>
  )
}
