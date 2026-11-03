/** CSV 解析/序列化（RFC4180 子集：引号、转义引号、CRLF 兼容）。纯 JS。 */

/**
 * @returns {{ headers: string[], rows: string[][], rawLines: string[] }}
 *   rawLines 与 rows 同长，为原始行文本（拒绝清单的原文快照，DO-08）。
 */
export function parseCsv(text) {
  const normalized = text.replace(/^\uFEFF/, '')
  const records = []
  const rawLines = []
  let field = ''
  let record = []
  let inQuotes = false
  let rawLine = ''

  const pushField = () => {
    record.push(field)
    field = ''
  }
  const pushRecord = () => {
    pushField()
    if (record.length > 1 || record[0] !== '') {
      records.push(record)
      rawLines.push(rawLine)
    }
    record = []
    rawLine = ''
  }

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]
    rawLine += ch === '\n' || ch === '\r' ? '' : ch
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"'
          rawLine += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      pushField()
      continue
    }
    if (ch === '\r') {
      if (normalized[i + 1] === '\n') i += 1
      pushRecord()
      continue
    }
    if (ch === '\n') {
      pushRecord()
      continue
    }
    field += ch
  }
  if (field !== '' || record.length > 0 || inQuotes) {
    if (inQuotes) throw new Error('CSV 引号未闭合')
    pushRecord()
  }

  if (records.length === 0) throw new Error('CSV 为空（无表头行）')
  return { headers: records[0].map((h) => h.trim()), rows: records.slice(1), rawLines: rawLines.slice(1) }
}

export function stringifyCsv(headers, rows) {
  const quote = (value) => {
    const cell = value ?? ''
    return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
  }
  const lines = [headers.map(quote).join(','), ...rows.map((row) => row.map(quote).join(','))]
  return `${lines.join('\r\n')}\r\n`
}
