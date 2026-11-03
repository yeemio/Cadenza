import { getGlobalLocale } from './global'
import { translateWith } from './dictionaries'
import type { TParams } from './types'

/**
 * 翻译函数（source-keyed：zh 文案即键）。
 *
 * - zh-CN：恒等返回源串（含插值替换）——既有中文界面零变化；
 * - ko-KR：查合并字典；缺译回退源串（韩文工作稿未覆盖处显示中文，不空不崩）；
 * - `params` 替换源串中的 `{name}` 占位符（codemod 将模板串 `${expr}` 转为 `{pN}`）。
 */
export function t(source: string, params?: TParams): string {
  const locale = getGlobalLocale()
  const base = translateWith(locale, source)
  return interpolate(base, params)
}

/** 展示位动态值翻译：确定 string 入参返回 string（模块字典 label 等场景） */
export function tx(source: string, params?: TParams): string
/** 展示位动态值翻译：null/undefined 原样返回（不把"未提供"渲染成空串之外的形态） */
export function tx(source: string | null | undefined, params?: TParams): string | null | undefined
export function tx(source: string | null | undefined, params?: TParams): string | null | undefined {
  if (source === null || source === undefined) return source
  return t(source, params)
}

function interpolate(text: string, params: TParams | undefined): string {
  if (!params) return text
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  )
}
