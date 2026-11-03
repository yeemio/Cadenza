import { Fragment, createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { LOCALE_LABELS, LOCALES, type Locale } from './types'
import { persistLocale, readStoredLocale, setGlobalLocale } from './global'
import { cn } from '../cn'

/**
 * 语言上下文：当前语言 + 切换函数（顶栏/PDA 选择器消费）。
 */
interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const I18nContext = createContext<I18nContextValue>({ locale: 'zh-CN', setLocale: () => {} })

/**
 * 语言 Provider（R5）：
 * - 初始语言读 localStorage（刷新/重开保持；非法值回退 zh-CN 默认）；
 * - 切换时持久化并按 `key={locale}` 重挂载子树——t() 为纯函数、非 Context 消费，
 *   重挂载保证全部展示点（含页面局部状态外的模块字典渲染位）按新语言重渲染；
 * - 渲染期同步模块级当前语言（幂等赋值；StrictMode 双渲染无副作用差异）。
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale())
  setGlobalLocale(locale)
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale: (next: Locale) => {
        setLocaleState(next)
        persistLocale(next)
      },
    }),
    [locale],
  )
  return (
    <I18nContext.Provider value={value}>
      <Fragment key={locale}>{children}</Fragment>
    </I18nContext.Provider>
  )
}

export function useLocale(): I18nContextValue {
  return useContext(I18nContext)
}

/**
 * 语言选择器（Web 顶栏 / PDA 顶栏共用；原生 select，大触区可用）。
 * 选项文字用各自语言原文（语言名不随当前语言翻译，便于认读）。
 */
export function LocaleSelect({ className }: { className?: string }) {
  const { locale, setLocale } = useLocale()
  return (
    <select
      value={locale}
      onChange={(e) => {
        const next = e.target.value
        if (next === 'zh-CN' || next === 'ko-KR') setLocale(next)
      }}
      aria-label={locale === 'ko-KR' ? '언어 선택' : '语言选择'}
      className={cn(
        'h-8 cursor-pointer rounded-md border border-border bg-card px-2 text-[13px] text-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/35',
        className,
      )}
      data-testid="locale-select"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_LABELS[l]}
        </option>
      ))}
    </select>
  )
}
