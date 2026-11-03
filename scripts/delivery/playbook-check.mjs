#!/usr/bin/env node
/**
 * 剧本矩阵校验（T25，DO-22）。
 *
 * - 矩阵完备：十岗 × A01–A14 每格有 适用/不适用 判定；适用格必须有剧本条目（ready 或 pending）；
 * - 三段式：每个 ready 剧本须含 ## 步骤 / ## 预期反馈 / ## 失败恢复路径 三节且内容非空——
 *   不写无恢复路径的"只成功"剧本（DO-22 明文）；
 * - --strict：存在 pending（适用但未编制）即 FAIL；默认输出覆盖率统计（编制状态如实呈现）。
 *
 * 用法：playbook-check.mjs [--matrix FILE] [--repo-root DIR] [--strict]
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

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

function sectionBody(text, heading) {
  const pattern = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |$)`, 'm')
  const match = pattern.exec(text)
  return match ? match[1].trim() : null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = args['repo-root'] ? path.resolve(args['repo-root']) : DEFAULT_ROOT
  const matrixPath = args['matrix'] ?? path.join(root, 'deploy/training/playbook-matrix.json')
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'))
  const problems = []

  const positions = matrix.positions
  const journeys = matrix.journeys
  if (positions.length !== 10) problems.push(`岗位数 ${String(positions.length)} ≠ 10（DO-22 十岗）`)
  if (journeys.length !== 14) problems.push(`旅程数 ${String(journeys.length)} ≠ 14（A01–A14）`)

  let applicable = 0
  let ready = 0
  let pending = 0
  const pendingCells = []

  for (const position of positions) {
    const row = matrix.cells[position.id]
    if (!row) {
      problems.push(`${position.id} 无矩阵行`)
      continue
    }
    for (const journey of journeys) {
      const cell = row[journey.id]
      if (!cell) {
        problems.push(`${position.id}×${journey.id} 缺格（矩阵不完备）`)
        continue
      }
      if (cell[0] === 'y') {
        applicable += 1
        if (cell[1] === 'ready') {
          ready += 1
          const playbookPath = path.join(path.dirname(matrixPath), 'playbooks', cell[2])
          if (!existsSync(playbookPath)) {
            problems.push(`${position.id}×${journey.id} ready 但剧本文件缺失：${cell[2]}`)
            continue
          }
          const text = await readFile(playbookPath, 'utf8')
          for (const section of ['步骤', '预期反馈', '失败恢复路径']) {
            const body = sectionBody(text, section)
            if (body === null) {
              problems.push(`${cell[2]} 缺「## ${section}」节（DO-22 三段式）`)
            } else if (body.length < 10) {
              problems.push(`${cell[2]} 「${section}」节内容为空（${section === '失败恢复路径' ? '只成功剧本，DO-22 禁止' : 'DO-22 三段式不完整'}）`)
            }
          }
        } else {
          pending += 1
          pendingCells.push(`${position.id}×${journey.id}`)
        }
      }
    }
  }

  const notApplicable = positions.length * journeys.length - applicable
  console.log(`[DO-22 剧本矩阵] 岗位 ${String(positions.length)} × 旅程 ${String(journeys.length)}`)
  console.log(`  适用格 ${String(applicable)}（ready ${String(ready)} / pending ${String(pending)}）；不适用 ${String(notApplicable)}`)
  if (pendingCells.length > 0) {
    console.log(`  pending 格（适用、待编制——须现场岗位参与编制并执行验收，DO-23）：${pendingCells.join('、')}`)
  }
  if (problems.length > 0) {
    console.error('[DO-22] 剧本矩阵校验 FAIL：')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  if (args['strict'] !== undefined && pending > 0) {
    console.error(`[DO-22 --strict] 存在 ${String(pending)} 个适用格待编制，FAIL`)
    process.exit(1)
  }
  console.log(`[DO-22] 剧本矩阵校验 PASS${args['strict'] !== undefined ? '（strict：全部适用格已编制）' : '（ready 剧本三段式全部合格；pending 状态如实呈现）'}`)
}

main().catch((error) => {
  console.error('剧本矩阵校验失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
