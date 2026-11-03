import { t } from './i18n'
import { ScanLine } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './Button'
import { cn } from './cn'

/**
 * 扫码输入组件（PDA 用，支持键盘楔入模式）。
 *
 * 合同落点：
 * - PC-03：页内"扫码"按钮与输入框回车共用同一提交入口（onScan），等同侧键扫码；
 * - PC-04：识别结果反馈（成功/失败形态）由调用方按任务上下文呈现；
 * - PC-05：每次提交后清空输入，不残留上一码；
 * - PC-09：空码（空串/纯空白）不提交，保持可继续操作。
 *
 * 换肤迁移：键盘楔入逻辑原样保留（WEDGE_GAP_MS / WEDGE_MAX_BUFFER / 全局监听），
 * 仅输入与按钮外观升级为大触区 Tailwind 令牌样式。
 */
export interface ScanInputProps {
  /** 扫码结果回调（已 trim，保证非空） */
  onScan: (code: string) => void
  placeholder?: string
  /** 自动聚焦输入框 */
  autoFocus?: boolean
  /** 键盘楔入模式：焦点不在输入框时，捕获扫码枪的快速键入+回车（全局监听） */
  wedge?: boolean
  hint?: ReactNode
  disabled?: boolean
  /** 扫码按钮文案（PC-03：与侧键同一命令入口） */
  buttonLabel?: string
  /** 紧凑高度（PC 页面内嵌时用）；默认 PDA 大触区高度 */
  compact?: boolean
}

/** 楔入缓冲判定：相邻按键间隔超过该毫秒数视为新序列 */
const WEDGE_GAP_MS = 120
/** 楔入缓冲最长长度（防误捕正常打字） */
const WEDGE_MAX_BUFFER = 128

export function ScanInput({
  onScan,
  placeholder = t('扫描或输入条码后回车'),
  autoFocus = true,
  wedge = true,
  hint,
  disabled = false,
  buttonLabel = t('扫码'),
  compact = false,
}: ScanInputProps) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  /** PC-09：空码不提交；PC-05：提交后清空 */
  const submit = useCallback((raw: string) => {
    const code = raw.trim()
    if (!code) return false
    onScanRef.current(code)
    return true
  }, [])

  const handleInputSubmit = useCallback(() => {
    if (submit(value)) setValue('')
  }, [submit, value])

  // 键盘楔入：扫码枪模拟键盘快速输入、回车结束。焦点在可编辑控件时跳过。
  useEffect(() => {
    if (!wedge) return
    let buffer = ''
    let lastKeyAt = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const flushExpired = () => {
      if (Date.now() - lastKeyAt > WEDGE_GAP_MS * 4) buffer = ''
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inEditable =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      flushExpired()
      lastKeyAt = Date.now()
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        buffer = ''
      }, WEDGE_GAP_MS * 4)
      if (e.key === 'Enter') {
        if (inEditable) return // 输入框自己的回车走表单逻辑
        const code = buffer.trim()
        buffer = ''
        if (code) onScanRef.current(code)
        return
      }
      if (inEditable) return
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        buffer = (buffer + e.key).slice(-WEDGE_MAX_BUFFER)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (timer) clearTimeout(timer)
    }
  }, [wedge])

  return (
    <div className="flex flex-col gap-2" data-slot="scan-input">
      <div className="flex gap-2.5">
        <input
          ref={inputRef}
          className={cn(
            'min-w-0 flex-1 rounded-lg border border-input bg-card font-sans tracking-wider shadow-xs transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground/80 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25',
            compact ? 'h-9 text-sm' : 'h-12 text-lg',
          )}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          disabled={disabled}
          aria-label={t('扫码输入')}
          inputMode="text"
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleInputSubmit()
            }
          }}
        />
        <Button
          size={compact ? 'md' : 'lg'}
          disabled={disabled}
          title="与侧键扫码同一命令入口"
          onClick={() => {
            // PC-03：按钮与回车共用同一提交入口；无码时聚焦输入等待扫码
            if (!submit(value)) {
              inputRef.current?.focus()
              return
            }
            setValue('')
          }}
        >
          <ScanLine aria-hidden />
          {buttonLabel}
        </Button>
      </div>
      {hint ? <div className="text-[12.5px] text-muted-foreground">{hint}</div> : null}
    </div>
  )
}
