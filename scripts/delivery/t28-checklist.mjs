#!/usr/bin/env node
/**
 * T28 第二工厂落地检查单执行器（§6 十项 / MP-20 / DO-32）。
 *
 * - 证据目录 items.json：[{item: 1..10, result: 'PASS', evidence: [文件], note}]；
 * - 第 1–9 项按登记判定（PASS 须有证据文件引用且文件存在）；
 * - 第 10 项（真实第二厂接入）内建 SITE_PENDING：除非存在 real_factory_readback
 *   授权链记录（真实工厂读回），否则恒为 SITE_PENDING——不以 mock 伪造（DO-32）；
 * - 报告归档到证据目录；任一应过项未通过即退出非零（MP-20：未通过项不得宣称落地）。
 *
 * 用法：t28-checklist.mjs --evidence DIR --check
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nowIso } from './lib/util.mjs'

const ITEMS = [
  { id: 1, name: '组织与权限隔离', refs: 'MP-04/05/08' },
  { id: 2, name: '主数据版本下发与主权划分', refs: 'MP-13/14' },
  { id: 3, name: '外部接口网关路由到归属工厂', refs: 'MP-15/16' },
  { id: 4, name: '跨厂调拨三段事实演练', refs: 'MP-09～12' },
  { id: 5, name: '集团汇总与延迟标注', refs: 'MP-06/07' },
  { id: 6, name: '配置包差异登记完整', refs: 'MP-17/18' },
  { id: 7, name: '双实例模拟环境验收', refs: 'MP-19' },
  { id: 8, name: '监控接入', refs: 'DO-21' },
  { id: 9, name: '第二厂岗位剧本与培训', refs: 'DO-22～25' },
  { id: 10, name: '真实第二厂接入', refs: 'MP-19/20' },
]

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
  const evidenceDir = args['evidence']
  if (!evidenceDir || args['check'] === undefined) {
    console.error('用法：t28-checklist.mjs --evidence DIR --check')
    process.exit(2)
  }
  const itemsFile = path.join(evidenceDir, 'items.json')
  const registered = existsSync(itemsFile) ? JSON.parse(await readFile(itemsFile, 'utf8')) : []
  const byItem = new Map(registered.map((r) => [r.item, r]))

  // 第 10 项：真实工厂读回记录（授权链绑定；当前不存在 → SITE_PENDING）
  const readbackFile = path.join(evidenceDir, 'real_factory_readback.json')
  const readback = existsSync(readbackFile) ? JSON.parse(await readFile(readbackFile, 'utf8')) : null

  const lines = [`# T28 第二工厂落地检查单报告（MP-20/DO-32）时间=${nowIso()}`, '']
  let allPassed = true
  for (const item of ITEMS) {
    const reg = byItem.get(item.id)
    if (item.id === 10) {
      if (readback && readback.factory && readback.readback_evidence && readback.authorization_ref) {
        lines.push(`| ${String(item.id)} | ${item.name} | ${item.refs} | PASS（真实工厂读回：${String(readback.factory)}） |`)
      } else {
        lines.push(`| ${String(item.id)} | ${item.name} | ${item.refs} | **SITE_PENDING**（未见真实工厂读回不勾选，DO-32） |`)
      }
      continue
    }
    if (!reg || reg.result !== 'PASS') {
      lines.push(`| ${String(item.id)} | ${item.name} | ${item.refs} | PENDING（未登记通过证据） |`)
      allPassed = false
      continue
    }
    const evidenceFiles = reg.evidence ?? []
    const missing = evidenceFiles.filter((f) => !existsSync(path.join(evidenceDir, f)))
    if (evidenceFiles.length === 0 || missing.length > 0) {
      lines.push(`| ${String(item.id)} | ${item.name} | ${item.refs} | FAIL（证据缺失：${missing.join(', ') || '未引用任何文件'}） |`)
      allPassed = false
      continue
    }
    lines.push(`| ${String(item.id)} | ${item.name} | ${item.refs} | PASS（${evidenceFiles.join('、')}${reg.note ? `；${String(reg.note)}` : ''}） |`)
  }

  lines.splice(2, 0, '| # | 检查项 | 合同引用 | 判定 |', '| --- | --- | --- | --- |')
  lines.push('')
  lines.push(allPassed
    ? '结论：第 1–9 项全部通过；第 10 项以工具判定为准（SITE_PENDING 期间不宣称真实接入，模拟环境验收结论不冒充现场）。'
    : '结论：存在未通过/未登记项——按 MP-20 未通过项不得宣称第二厂落地。')
  const report = path.join(evidenceDir, `t28-checklist-${nowIso().replace(/[:.]/g, '-')}.md`)
  await writeFile(report, lines.join('\n'), 'utf8')
  for (const line of lines) console.log(line)
  console.log(`报告：${report}`)
  if (!allPassed) process.exitCode = 1
}

main().catch((error) => {
  console.error('T28 检查单失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
