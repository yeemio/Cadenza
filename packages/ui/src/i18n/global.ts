import { DEFAULT_LOCALE, isLocale, type Locale } from './types'

/**
 * 模块级当前语言（渲染期由 LocaleProvider 同步；无 Provider 时恒为默认 zh-CN）。
 *
 * 设计约束：
 * - `t()` 是纯函数而非 hook —— 页面/组件无需逐个接 Context，渲染期读此值即可；
 * - LocaleProvider 切换语言时以 `key={locale}` 重挂载子树，保证全部展示点按新语言重渲染；
 * - 既有测试不包 Provider 时行为与历史完全一致（zh-CN 恒等）。
 */

export const LOCALE_STORAGE_KEY = 'cadenza.locale'

let currentLocale: Locale = DEFAULT_LOCALE

/** 读持久化语言（localStorage 不可用或非法值时回退默认 zh-CN） */
export function readStoredLocale(): Locale {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY)
    return isLocale(raw) ? raw : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

export function persistLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // 隐私模式等写入失败：仅影响"刷新保持"，不影响当前会话切换
  }
}

export function getGlobalLocale(): Locale {
  return currentLocale
}

export function setGlobalLocale(locale: Locale): void {
  currentLocale = locale
}

/** 测试隔离用：重置模块语言（tests/ui setup afterEach 调用，防跨用例串语言） */
export function resetGlobalLocaleForTests(): void {
  currentLocale = DEFAULT_LOCALE
}
