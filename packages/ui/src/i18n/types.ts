/**
 * i18n 基础类型（R5：中文/韩文岗位操作界面）。
 *
 * 方案：轻量自建字典 + 模块级当前语言 + Context 驱动重挂载（不引入 react-i18next）。
 * 字典以 zh 文案为键（source-keyed）：`t('登录账号')` 在 zh-CN 下恒等返回原文
 * （既有中文界面与测试零变化），ko-KR 下查字典翻译；缺译回退 zh 原文（不崩、不空）。
 */

/** 支持的界面语言（R5 冻结范围：中文简体 + 韩文工作稿） */
export type Locale = 'zh-CN' | 'ko-KR'

export const LOCALES: readonly Locale[] = ['zh-CN', 'ko-KR'] as const

export const DEFAULT_LOCALE: Locale = 'zh-CN'

/** 语言选择器展示名（各自语言原文，不随当前语言变化） */
export const LOCALE_LABELS: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'ko-KR': '한국어',
}

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'ko-KR'
}

/** 插值参数：源串中 `{name}` 占位符替换为参数值（String() 语义，与模板字面量一致） */
export type TParams = Record<string, string | number | boolean | null | undefined>
