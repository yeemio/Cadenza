#!/usr/bin/env node
/**
 * 期初库存差异对账工具（T25，DO-13）。
 *
 * 对账维度不只对数量：数量、单位、质量状态、库位四维逐键比对。
 * 输出具名差异清单交业务确认后处置——差异调整走调整事实（产品命令面），
 * 本工具只读比对、绝不直接改账。
 *
 * 用法：
 *   reconcile-inventory.mjs --source <源端清单.csv> --against-csv <目标端清单.csv> --out <目录>
 *   reconcile-inventory.mjs --source <源端清单.csv> --against-db --database-url URL --out <目录>
 *
 * 清单列（与 initial-02-inventory 模板一致）：
 *   料品编码,批次号,仓库编码,库位编码,数量,单位,质量状态
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseCsv, stringifyCsv } from '../lib/csv.mjs'
import { withPool } from '../lib/db.mjs'
import { decimalStringError, nowIso } from '../lib/util.mjs'

const KEY_COLUMNS = ['料品编码', '批次号', '仓库编码', '库位编码', '质量状态']

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]?.replace(/^--/, '')
    if (!key) continue
    const next = argv[i + 1]
    if (key === 'against-db') {
      args[key] = ''
    } else if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      i += 1
    } else {
      args[key] = ''
    }
  }
  return args
}

async function readSourceCsv(file) {
  const { readFile } = await import('node:fs/promises')
  const parsed = parseCsv(await readFile(file, 'utf8'))
  const missing = KEY_COLUMNS.concat(['数量', '单位']).filter((c) => !parsed.headers.includes(c))
  if (missing.length > 0) throw new Error(`清单缺列：${missing.join(', ')}`)
  const rows = []
  parsed.rows.forEach((cells, idx) => {
    const values = {}
    parsed.headers.forEach((h, i) => {
      values[h] = cells[i] ?? ''
    })
    rows.push({ lineNo: idx + 2, values, key: KEY_COLUMNS.map((c) => values[c].trim()).join('|') })
  })
  return rows
}

async function readTargetFromDb(databaseUrl) {
  return withPool(databaseUrl, async (pool) => {
    const result = await pool.query(`
      SELECT m.code AS material_code, l.lot_no, w.code AS warehouse_code, s.code AS location_code,
             sb.quantity::text AS quantity, u.code AS uom_code, sb.quality_status
      FROM stock_balance sb
      JOIN inventory_unit iu ON iu.id = sb.unit_id
      JOIN material m ON m.id = iu.material_id
      JOIN material_lot l ON l.id = iu.lot_id
      JOIN storage_location s ON s.id = sb.location_id
      JOIN warehouse w ON w.id = s.warehouse_id
      JOIN uom u ON u.id = sb.uom_id
      WHERE sb.status = 'active'
    `)
    return result.rows.map((r, idx) => {
      const values = {
        料品编码: r.material_code,
        批次号: r.lot_no,
        仓库编码: r.warehouse_code,
        库位编码: r.location_code,
        数量: r.quantity,
        单位: r.uom_code,
        质量状态: r.quality_status,
      }
      return { lineNo: idx + 1, values, key: KEY_COLUMNS.map((c) => values[c]).join('|') }
    })
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args['source'] || !args['out'] || !(args['against-csv'] || args['against-db'] !== undefined)) {
    console.error('用法：--source <csv> (--against-csv <csv> | --against-db --database-url URL) --out <目录>')
    process.exit(2)
  }
  const source = await readSourceCsv(args['source'])
  const target = args['against-csv']
    ? await readSourceCsv(args['against-csv'])
    : await readTargetFromDb(args['database-url'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza')

  const sourceByKey = new Map(source.map((r) => [r.key, r]))
  const targetByKey = new Map(target.map((r) => [r.key, r]))
  const differences = []

  for (const [key, s] of sourceByKey) {
    const t = targetByKey.get(key)
    if (!t) {
      differences.push({ key, dim: '库位/键', detail: '源端有、目标端无（未导入或库位不符）', source: JSON.stringify(s.values), target: '' })
      continue
    }
    const qtyErr = decimalStringError(s.values['数量'], { allowNegative: true })
    if (qtyErr) {
      differences.push({ key, dim: '数量', detail: `源端数量非法（${qtyErr}）`, source: s.values['数量'], target: t.values['数量'] })
      continue
    }
    const sq = Number(s.values['数量'])
    const tq = Number(t.values['数量'])
    if (Math.abs(sq - tq) > 1e-9) {
      differences.push({ key, dim: '数量', detail: `数量不一致`, source: s.values['数量'], target: t.values['数量'] })
    }
    if (s.values['单位'].trim() !== t.values['单位'].trim()) {
      differences.push({ key, dim: '单位', detail: '单位不一致（含换算口径差异，交业务判定）', source: s.values['单位'], target: t.values['单位'] })
    }
    if (s.values['质量状态'].trim() !== t.values['质量状态'].trim()) {
      differences.push({ key, dim: '质量状态', detail: '质量状态不一致', source: s.values['质量状态'], target: t.values['质量状态'] })
    }
  }
  for (const [key, t] of targetByKey) {
    if (!sourceByKey.has(key)) {
      differences.push({ key, dim: '库位/键', detail: '目标端有、源端无（导入多入或源端清单缺行）', source: '', target: JSON.stringify(t.values) })
    }
  }

  const outDir = args['out']
  await mkdir(outDir, { recursive: true })
  const stamp = nowIso().replace(/[:.]/g, '-')
  const csv = stringifyCsv(
    ['对账键', '差异维度', '差异说明', '源端值', '目标端值', '处置要求'],
    differences.map((d) => [d.key, d.dim, d.detail, d.source, d.target, '交业务确认后以调整事实处置，不直接改账（DO-13）']))
  await writeFile(path.join(outDir, `inventory-differences-${stamp}.csv`), csv, 'utf8')
  const summary = [
    `# 期初库存差异对账（DO-13）`,
    '',
    `- 时间：${nowIso()}`,
    `- 源端：${args['source']}（${String(source.length)} 键）`,
    `- 目标端：${args['against-csv'] ?? `数据库 ${String(args['database-url'] ?? '')}`}（${String(target.length)} 键）`,
    `- 差异：${String(differences.length)} 条（数量 ${String(differences.filter((d) => d.dim === '数量').length)} / 单位 ${String(differences.filter((d) => d.dim === '单位').length)} / 质量状态 ${String(differences.filter((d) => d.dim === '质量状态').length)} / 键 ${String(differences.filter((d) => d.dim === '库位/键').length)}）`,
    '',
    differences.length === 0
      ? '四维（数量/单位/质量状态/库位）全部一致。'
      : '差异清单见同名 CSV；接受阈值与处置时限由现场定，差异调整走调整事实，不直接改账。',
  ]
  await writeFile(path.join(outDir, `inventory-reconcile-${stamp}.md`), summary.join('\n'), 'utf8')
  console.log(`[DO-13 对账完成] 源 ${String(source.length)} 键 / 目标 ${String(target.length)} 键 / 差异 ${String(differences.length)} 条`)
  console.log(`  输出：${path.join(outDir, `inventory-reconcile-${stamp}.md`)}`)
  if (differences.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('对账失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
