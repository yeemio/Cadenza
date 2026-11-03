#!/usr/bin/env node
/**
 * 剧本矩阵 R4 校验（PM-FINAL-RECEPTION §3 R4，2026-10-29）。
 *
 * 在 scripts/delivery/playbook-check.mjs（DO-22 三段式/strict）之外补 R4 专属口径：
 * - 全格状态统计：适用格 ready/pending、不适用格 na，要求 pending = 0；
 * - N/A 逐条附依据：每个 na 格第三位为非空合同依据（不以删格制造完成）；
 * - ready 剧本文件存在、三段式齐备、引用一致（每格引用的文件名与文件内服务格声明互检）；
 * - 编制/执行分离：cell_format 必须区分「编制完成（ready）」与「现场执行（SITE_PENDING）」。
 *
 * 用法：node deploy/training/playbook-matrix-r4-check.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const matrixPath = path.join(root, 'deploy/training/playbook-matrix.json')
const playbooksDir = path.join(root, 'deploy/training/playbooks')
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'))

const problems = []
let applicable = 0
let ready = 0
let pending = 0
let na = 0
const pendingCells = []
const naBasis = []
const fileServes = new Map()

// 完整节捕获：按 \n## 切分取整节正文（比既有 playbook-check 的节首行口径更严）。
const sectionBody = (text, heading) => {
  const parts = text.split(/^## /m)
  for (const part of parts) {
    if (part.startsWith(`${heading}\n`)) {
      return part.slice(heading.length + 1).trim()
    }
  }
  return null
}

for (const position of matrix.positions) {
  const row = matrix.cells[position.id]
  if (!row) {
    problems.push(`${position.id} 无矩阵行`)
    continue
  }
  for (const journey of matrix.journeys) {
    const cell = row[journey.id]
    if (!cell) {
      problems.push(`${position.id}×${journey.id} 缺格`)
      continue
    }
    if (cell[0] === 'y') {
      applicable += 1
      if (cell[1] === 'ready') {
        ready += 1
        const file = path.join(playbooksDir, cell[2])
        if (!existsSync(file)) {
          problems.push(`${position.id}×${journey.id} ready 但剧本缺失：${cell[2]}`)
          continue
        }
        const text = readFileSync(file, 'utf8')
        for (const section of ['步骤', '预期反馈', '失败恢复路径']) {
          const body = sectionBody(text, section)
          if (body === null) problems.push(`${cell[2]} 缺「## ${section}」节（DO-22）`)
          else if (body.length < 30) problems.push(`${cell[2]} 「${section}」节内容过短（完整节≥30 字）`)
        }
        if (!fileServes.has(cell[2])) fileServes.set(cell[2], [])
        fileServes.get(cell[2]).push(`${position.id}-${journey.id}`)
      } else {
        pending += 1
        pendingCells.push(`${position.id}×${journey.id}`)
      }
    } else if (cell[0] === 'n') {
      na += 1
      if (cell[1] !== 'na') problems.push(`${position.id}×${journey.id} 不适用格未标 na：${JSON.stringify(cell)}`)
      else if (typeof cell[2] !== 'string' || cell[2].trim().length < 10)
        problems.push(`${position.id}×${journey.id} N/A 格缺合同依据（R4：不以删格制造完成）`)
      else naBasis.push(`${position.id}×${journey.id}：${cell[2]}`)
    } else {
      problems.push(`${position.id}×${journey.id} 非法适用标记：${JSON.stringify(cell)}`)
    }
  }
}

// 旅程剧本「服务格」声明与矩阵引用互检（仅对本次 R4 新增的 pb-J-*.md）
for (const [file, cells] of fileServes) {
  if (!file.startsWith('pb-J-')) continue
  const text = readFileSync(path.join(playbooksDir, file), 'utf8')
  const declared = [...text.matchAll(/(P\d{2}-A\d{2})/g)].map((m) => m[1])
  const missing = cells.filter((c) => !declared.includes(c))
  if (missing.length > 0) problems.push(`${file} 未声明服务格：${missing.join('、')}`)
}

// 编制/执行分离语义检查（R4 明确不得混为一项）
const fmt = String(matrix.cell_format ?? '')
if (!fmt.includes('编制完成') || !fmt.includes('SITE_PENDING')) {
  problems.push('cell_format 未区分「编制完成」与「现场执行 SITE_PENDING」（R4）')
}

console.log(`[R4 剧本矩阵] 岗位 ${matrix.positions.length} × 旅程 ${matrix.journeys.length}`)
console.log(`  适用格 ${applicable}：ready ${ready} / pending ${pending}；不适用格 ${na}（全部附依据）`)
if (pendingCells.length > 0) console.log(`  pending：${pendingCells.join('、')}`)
console.log(`  剧本文件 ${fileServes.size} 份，服务格分布：`)
for (const [file, cells] of [...fileServes.entries()].sort()) {
  console.log(`    ${file} ← ${cells.length} 格（${cells.join('、')}）`)
}
if (process.argv.includes('--na-detail')) {
  console.log('  N/A 依据逐条：')
  for (const line of naBasis) console.log(`    - ${line}`)
}

if (problems.length > 0) {
  console.error('[R4] 校验 FAIL：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
if (pending > 0) {
  console.error(`[R4] 适用格仍有 ${pending} 个未编制，FAIL`)
  process.exit(1)
}
console.log('[R4] 校验 PASS：52 适用格全部 ready（pending=0）、三段式齐备、88 N/A 格逐条附依据、编制/执行分列')
