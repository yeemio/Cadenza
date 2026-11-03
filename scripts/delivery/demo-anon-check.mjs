#!/usr/bin/env node
/**
 * 匿名演示数据合规检查（T25，DO-14）。
 *
 * - 禁入词命中（真实工厂标识：PRD 公司名等）即 FAIL——真实工厂数据未经授权不进入演示/测试包；
 * - 脱敏字段必须为空或演示占位（按 ANON-RULES 的字段域清单）；
 * - 数据分布保底：每个演示 CSV 行数不低于 ANON-RULES 声明的下限（保留数据分布，不拿两行假数据冒充）。
 *
 * 用法：demo-anon-check.mjs --dataset DIR [--blocklist-extra FILE]
 */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { nowIso } from './lib/util.mjs'

/** 默认禁入词（真实标识；现场可经 --blocklist-extra 追加，一行一词）。 */
const DEFAULT_BLOCKLIST = ['河北华通']

/** ANON-RULES.md 对应的脱敏字段域：演示数据中这些列必须为空或以「演示」开头。 */
const MASKED_COLUMN_HINTS = ['客户', '供应商', '客户名称', '供应商名称', '联系人', '地址', '电话']

/** 分布保底：演示数据包每个 CSV 的最少行数（ANON-RULES.md 同口径）。 */
const MIN_ROWS_PER_FILE = 5

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]?.replace(/^--/, '')
    if (!key) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      i += 1
    } else {
      args[key] = ''
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args['dataset']) {
    console.error('用法：demo-anon-check.mjs --dataset DIR [--blocklist-extra FILE]')
    process.exit(2)
  }
  let blocklist = [...DEFAULT_BLOCKLIST]
  if (args['blocklist-extra']) {
    const extra = (await readFile(args['blocklist-extra'], 'utf8')).split('\n').map((s) => s.trim()).filter((s) => s !== '')
    blocklist = blocklist.concat(extra)
  }

  const files = (await readdir(args['dataset'])).filter((f) => f.endsWith('.csv')).sort()
  if (files.length === 0) {
    console.error('[DO-14] 演示数据目录无 CSV 文件')
    process.exit(1)
  }
  const { parseCsv } = await import('./lib/csv.mjs')
  const violations = []
  const stats = []

  for (const file of files) {
    const parsed = parseCsv(await readFile(path.join(args['dataset'], file), 'utf8'))
    if (parsed.rows.length < MIN_ROWS_PER_FILE) {
      violations.push(`${file}: 行数 ${String(parsed.rows.length)} 低于分布保底下限 ${String(MIN_ROWS_PER_FILE)}（ANON-RULES：保留数据分布）`)
    }
    parsed.rows.forEach((cells, idx) => {
      parsed.headers.forEach((h, ci) => {
        const value = cells[ci] ?? ''
        for (const word of blocklist) {
          if (value.includes(word)) {
            violations.push(`${file} 第 ${String(idx + 2)} 行列「${h}」命中禁入词「${word}」（真实工厂数据未经授权不进入演示/测试包）`)
          }
        }
        if (MASKED_COLUMN_HINTS.includes(h) && value !== '' && !value.startsWith('演示')) {
          violations.push(`${file} 第 ${String(idx + 2)} 行列「${h}」为脱敏字段域，非空值必须以「演示」开头（当前：${value}）`)
        }
      })
    })
    stats.push(`${file}: ${String(parsed.rows.length)} 行`)
  }

  console.log(`[DO-14 匿名演示数据检查] 时间=${nowIso()}`)
  console.log(`  数据包：${args['dataset']}；文件 ${String(files.length)} 个（${stats.join('；')}）`)
  console.log(`  禁入词表：${blocklist.join('、')}`)
  if (violations.length === 0) {
    console.log('  结论：PASS（无真实标识、脱敏字段合规、分布保底达标）')
    return
  }
  console.log(`  结论：FAIL（${String(violations.length)} 处违规）`)
  for (const v of violations) console.log(`  - ${v}`)
  process.exitCode = 1
}

main().catch((error) => {
  console.error('匿名演示检查失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
