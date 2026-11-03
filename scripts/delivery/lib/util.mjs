import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** 交付工具公共基础：摘要、时间、数值校验（P3-E T25–T28）。纯 JS，node 直接执行。 */

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export async function sha256File(path) {
  return sha256Text(await readFile(path, 'utf8'))
}

export async function sha256FileBinary(path) {
  const { open } = await import('node:fs/promises')
  const handle = await open(path, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1 << 16)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** 规范化 JSON（键排序、无多余空白），用于指纹与账本哈希链。 */
export function canonicalJson(value) {
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, sorted(val)]),
      )
    }
    return v
  }
  return JSON.stringify(sorted(value))
}

export function nowIso() {
  return new Date().toISOString()
}

export function fmtDuration(ms) {
  if (ms < 1000) return `${String(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${String(m)}m${String(s)}s`
}

/**
 * DecimalString 校验（全仓口径：数量一律十进制字符串，scale ≤ 4，禁 number/科学计数）。
 * 返回错误描述或 null（合法）。
 */
export function decimalStringError(raw, options = {}) {
  const value = raw.trim()
  if (!/^-?\d+(\.\d+)?$/.test(value)) return '非十进制数字字符串（禁止科学计数/千分位/全角）'
  if (value.startsWith('-')) {
    if (options.positiveOnly || !options.allowNegative) return '不允许为负'
  }
  const frac = value.split('.')[1]
  if (frac !== undefined && frac.length > 4) return '小数位超过 4（scale ≤ 4）'
  if (options.positiveOnly && Number(value) === 0) return '不允许为 0'
  return null
}

/** ISO 日期（YYYY-MM-DD）或日期时间校验。 */
export function isoDateError(raw, withTime = false) {
  const value = raw.trim()
  const pattern = withTime ? /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/ : /^\d{4}-\d{2}-\d{2}$/
  if (!pattern.test(value)) {
    return withTime ? '非 ISO 日期时间（YYYY-MM-DD HH:mm[:ss]）' : '非 ISO 日期（YYYY-MM-DD）'
  }
  const parsed = new Date(withTime ? value.replace(' ', 'T') : `${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return '日期不合法'
  return null
}

/** 解析 DATABASE_URL 的库名（仅用于展示与安全判定，不含密码）。 */
export function dbNameOf(url) {
  const match = /\/([^/?]+)(\?|$)/.exec(url)
  return match?.[1] ?? ''
}
