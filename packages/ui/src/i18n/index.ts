/**
 * i18n 公共出口（R5）：轻量字典 + LocaleProvider + 业务日/工厂时钟。
 *
 * 用法：
 * - `import { t, tx } from '@cadenza/ui'`：渲染/事件期直接调用（zh 恒等，ko 查字典）；
 * - `<LocaleProvider>` 包在应用根部：语言切换 + localStorage 持久化 + 重挂载重渲染；
 * - `<LocaleSelect>` 顶栏选择器；`<BusinessClock>` 业务日/工厂时间展示。
 */
export * from './types'
export * from './global'
export * from './translate'
export * from './dictionaries'
export * from './LocaleProvider'
export * from './time'
