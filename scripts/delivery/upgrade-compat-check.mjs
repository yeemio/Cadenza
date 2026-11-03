#!/usr/bin/env node
/**
 * 升级兼容检查（T26，DO-20）。
 *
 * 1) 漂移检测：库内已应用版本必须是发行 registry 的连续前缀（未知版本/跳号即 FAIL）；
 * 2) 路径检查：待应用路径逐段对照 COMPATIBILITY.json（不可跳转路径：降级禁止——
 *    --to 低于已应用最高版即拒绝〔矩阵 forbidden_paths〕）；
 * 3) 重入验证：对目标库重跑迁移（幂等：已应用版本自动跳过），期望零新应用——
 *    证明「迁移在已有业务数据上可重入，失败续跑不重复应用」（DO-20）。
 *
 * 用法：
 *   upgrade-compat-check.mjs --database-url URL [--compat FILE] [--repo-root DIR] [--to VERSION]
 *   [--no-reentrancy]（只读模式跳过第 3 步）
 */

import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations, withPool } from './lib/db.mjs'

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

async function registryVersions() {
  const require = createRequire(
    new URL('../../packages/persistence/package.json', import.meta.url),
  )
  const registry = require('./dist/migrations/registry.js')
  const versions = registry.migrations.map((m) => m.version).sort()
  if (versions.length === 0) throw new Error('registry 无迁移版本')
  return versions
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args['database-url']) {
    console.error('用法：upgrade-compat-check.mjs --database-url URL [--compat FILE] [--to VERSION] [--no-reentrancy]')
    process.exit(2)
  }
  const root = args['repo-root'] ? path.resolve(args['repo-root']) : DEFAULT_ROOT
  const compatPath = args['compat'] ?? path.join(root, 'deploy/upgrade/COMPATIBILITY.json')
  const compat = JSON.parse(await readFile(compatPath, 'utf8'))
  const registry = await registryVersions()
  const failures = []

  const applied = await withPool(args['database-url'], async (pool) => {
    const r = await pool.query('SELECT version FROM schema_migrations ORDER BY version')
    return r.rows.map((x) => x.version)
  })

  // 1) 漂移检测（连续前缀）
  const unknown = applied.filter((v) => !registry.includes(v))
  if (unknown.length > 0) failures.push(`库内存在未注册迁移版本：${unknown.join(', ')}（drift，需人工处置）`)
  let prefixOk = true
  for (let i = 0; i < applied.length; i += 1) {
    if (registry[i] !== applied[i]) {
      prefixOk = false
      failures.push(`已应用版本不是 registry 连续前缀：第 ${String(i + 1)} 个应用版本为 ${applied[i]}，registry 序列为 ${registry[i]}`)
      break
    }
  }
  const pending = registry.filter((v) => !applied.includes(v))
  console.log(`[DO-20] 已应用：${applied.length > 0 ? applied.join(', ') : '（空库）'}；registry：${registry.join(', ')}`)
  console.log(`[DO-20] 待应用路径：${pending.length > 0 ? pending.join(' → ') : '（无，已到顶）'}`)
  if (prefixOk && unknown.length === 0 && pending.length > 0) console.log(`[DO-20] 漂移检测：PASS（连续前缀，逐段顺序应用）`)

  // 2) 不可跳转路径（--to 显式降级拒绝；矩阵 forbidden_paths）
  const target = args['to']
  if (target !== undefined && target !== '') {
    const appliedMax = applied[applied.length - 1] ?? ''
    if (target < appliedMax) {
      const downgradeForbidden = compat.forbidden_paths.find((f) => f.type === 'downgrade')
      failures.push(
        `[DO-20-不可跳转] 目标版本 ${target} 低于已应用最高版 ${appliedMax}——${downgradeForbidden?.reason ?? '降级禁止'}；` +
        `数据后果：${downgradeForbidden?.data_consequence ?? '见 COMPATIBILITY.json'}`,
      )
    }
  }

  // 3) 重入验证（幂等重跑，期望零新应用）
  if (args['no-reentrancy'] === undefined) {
    const appliedNow = await applyMigrations(args['database-url'])
    if (appliedNow.length === 0) {
      console.log(`[DO-20] 重入验证：PASS（对已有业务数据重跑迁移，0 个新应用——幂等，失败续跑不重复应用）`)
    } else {
      failures.push(`重入验证异常：本次实际应用了 ${appliedNow.join(', ')}（升级前检查不应产生新应用；升级动作请用 upgrade.sh 执行）`)
    }
  }

  if (failures.length > 0) {
    console.error('[DO-20] 升级兼容检查 FAIL：')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('[DO-20] 升级兼容检查 PASS（可按 MANUAL-升级手册.md 执行 upgrade.sh）')
}

main().catch((error) => {
  console.error('升级兼容检查失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
