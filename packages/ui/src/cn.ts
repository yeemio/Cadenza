import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * 类名合成工具（shadcn 体系惯例：clsx 收集 + tailwind-merge 去重）。
 * 应用侧可从 '@cadenza/ui' 直接引入 cn 做同类类名合并。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
