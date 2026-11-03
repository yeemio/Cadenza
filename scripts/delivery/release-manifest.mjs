#!/usr/bin/env node
/**
 * 发行清单生成与九项齐套校验（T26，DO-01/03/05，DO-S1）。
 *
 * - DO-01 九项齐套：锁定依赖、镜像身份、数据库迁移、配置清单、支持的模块与设备、
 *   匿名演示数据、用户手册、安装/升级/恢复说明、已知限制——缺一不可发版（FAIL 并指名缺失项）。
 * - DO-03 四件分离指纹：依赖锁 / 镜像身份 / 迁移脚本 / 种子演示数据 分别标识、分别版本化；
 *   生产安装默认不含演示数据（由 install.sh 落实，本工具只校验演示数据包独立成目录）。
 * - DO-S1 发行清单登记：RELEASE-MANIFEST.json 含四件指纹齐套校验结果。
 *
 * 用法：release-manifest.mjs [--repo-root DIR] [--out FILE]
 *   --repo-root 缺省取本文件上三级（仓库根）。九项在 repo-root 下的固定路径见 CHECKS。
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, nowIso, sha256FileBinary, sha256Text } from './lib/util.mjs'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** DO-01 九项齐套检查表：项号 → 缺一不可的路径/生成逻辑。 */
const NINE_ITEMS = [
  { id: 1, name: '锁定依赖', path: 'pnpm-lock.yaml', kind: 'file' },
  { id: 2, name: '镜像身份', path: 'deploy/release/RELEASE-ANCHOR.json', kind: 'anchor' },
  { id: 3, name: '数据库迁移', path: 'packages/persistence/src/migrations/registry.ts', kind: 'migrations' },
  { id: 4, name: '配置清单', path: 'deploy/config/CONFIG-CHECKLIST.md', kind: 'file' },
  { id: 5, name: '支持的模块与设备', path: 'deploy/release/SUPPORTED-MODULES.md', kind: 'file' },
  { id: 6, name: '匿名演示数据', path: 'deploy/demo/ANON-RULES.md', kind: 'demo' },
  { id: 7, name: '用户手册', path: 'deploy/training/MANUAL-操作手册框架.md', kind: 'file' },
  { id: 8, name: '安装/升级/恢复说明', paths: [
      'deploy/install/MANUAL-安装手册.md',
      'deploy/upgrade/MANUAL-升级手册.md',
      'deploy/backup/MANUAL-备份恢复手册.md',
    ], kind: 'multi' },
  { id: 9, name: '已知限制', path: 'deploy/release/KNOWN-LIMITATIONS.md', kind: 'file' },
]

async function migrationFingerprints(root) {
  const require = createRequire(
    new URL('../../packages/persistence/package.json', import.meta.url),
  )
  const registry = require('./dist/migrations/registry.js')
  const versions = registry.migrations.map((m) => m.version).sort()
  if (versions.length === 0) throw new Error('registry 无迁移版本')
  const registryPath = path.join(root, 'packages/persistence/src/migrations/registry.ts')
  return { registry_sha256: await sha256Text(await readFile(registryPath, 'utf8')), versions }
}

async function demoFingerprints(root) {
  const demoDir = path.join(root, 'deploy/demo/demo-dataset')
  if (!existsSync(demoDir)) throw new Error('演示数据目录不存在')
  const { readdir } = await import('node:fs/promises')
  const entries = (await readdir(demoDir)).filter((f) => f.endsWith('.csv')).sort()
  if (entries.length === 0) throw new Error('演示数据目录无 CSV 数据包')
  const fingerprints = []
  for (const entry of entries) {
    fingerprints.push({ file: `deploy/demo/demo-dataset/${entry}`, sha256: await sha256FileBinary(path.join(demoDir, entry)) })
  }
  return fingerprints
}

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
  const root = args['repo-root'] ? path.resolve(args['repo-root']) : DEFAULT_ROOT
  const out = args['out'] ?? path.join(root, 'delivery/P3/delivery-ops/evidence/release/RELEASE-MANIFEST.json')

  const results = []
  const details = {}
  for (const item of NINE_ITEMS) {
    const paths = item.paths ?? [item.path]
    const missing = paths.filter((p) => !existsSync(path.join(root, p)))
    if (missing.length > 0) {
      results.push({ id: item.id, name: item.name, ok: false, missing })
      continue
    }
    try {
      if (item.kind === 'file' || item.kind === 'multi') {
        results.push({ id: item.id, name: item.name, ok: true })
      } else if (item.kind === 'anchor') {
        const anchor = JSON.parse(await readFile(path.join(root, item.path), 'utf8'))
        if (!anchor.image_identity || !anchor.target_environment || !anchor.migration_versions) {
          throw new Error('锚文件缺 image_identity/target_environment/migration_versions')
        }
        details.anchor = anchor
        results.push({ id: item.id, name: item.name, ok: true })
      } else if (item.kind === 'migrations') {
        details.migrations = await migrationFingerprints(root)
        results.push({ id: item.id, name: item.name, ok: true })
      } else if (item.kind === 'demo') {
        details.demo_dataset = await demoFingerprints(root)
        const anonRules = await readFile(path.join(root, 'deploy/demo/ANON-RULES.md'), 'utf8')
        if (!anonRules.includes('脱敏字段') || !anonRules.includes('数据分布')) {
          throw new Error('ANON-RULES.md 未同时说明脱敏字段与数据分布')
        }
        results.push({ id: item.id, name: item.name, ok: true })
      }
    } catch (error) {
      results.push({ id: item.id, name: item.name, ok: false, missing: [error instanceof Error ? error.message : String(error)] })
    }
  }

  // DO-03 四件分离指纹
  const fourItems = {
    dependency_lock: { path: 'pnpm-lock.yaml', sha256: await sha256FileBinary(path.join(root, 'pnpm-lock.yaml')) },
    image_identity: details.anchor
      ? { path: 'deploy/release/RELEASE-ANCHOR.json', image_identity: details.anchor.image_identity }
      : null,
    migrations: details.migrations ?? null,
    seed_demo_data: details.demo_dataset
      ? { path: 'deploy/demo/demo-dataset/', files: details.demo_dataset, production_default_excludes_demo: true }
      : null,
  }

  const complete = results.every((r) => r.ok) && Object.values(fourItems).every((v) => v !== null)
  const manifest = {
    generated_at: nowIso(),
    repo_root: root,
    rule_refs: ['DO-01', 'DO-03', 'DO-05', 'DO-S1'],
    nine_item_check: results,
    nine_item_complete: complete,
    four_item_separation: fourItems,
    four_item_fingerprint_ok: Object.values(fourItems).every((v) => v !== null),
    manifest_sha256: null,
  }
  const { manifest_sha256: _omit, ...body } = manifest
  void _omit
  manifest.manifest_sha256 = sha256Text(canonicalJson(body))

  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  console.log(`[DO-01 九项齐套] ${complete ? 'PASS（缺一不可已满足）' : 'FAIL（缺一不可，禁止发版）'}`)
  for (const r of results) {
    console.log(`  ${String(r.id)}. ${r.name}: ${r.ok ? 'OK' : `缺失 ${r.missing.join(', ')}`}`)
  }
  console.log(`[DO-03 四件分离] ${manifest.four_item_fingerprint_ok ? 'PASS（依赖锁/镜像/迁移/演示数据四件指纹齐套）' : 'FAIL'}`)
  if (details.migrations) {
    console.log(`  迁移版本：${details.migrations.versions.join(', ')}`)
  }
  console.log(`[DO-S1] RELEASE-MANIFEST 已写入 ${out}（manifest_sha256=${manifest.manifest_sha256.slice(0, 16)}…）`)
  if (!complete) process.exitCode = 1
}

main().catch((error) => {
  console.error('发行清单生成失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
