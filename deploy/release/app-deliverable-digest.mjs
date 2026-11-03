#!/usr/bin/env node
/**
 * 应用交付物身份（R3，2026-10-29）：对 pnpm build 产物逐包生成 sha256 清单。
 *
 * 当前发行为 pnpm workspace 形态、无独立容器镜像——按 PM-FINAL-RECEPTION R3 裁定，
 * 以 dist 清单摘要作为应用交付物 digest（现场发行打镜像时补 app_image_digest，
 * 并以镜像内构建产物与本清单核对一致为准）。
 *
 * 输出：deploy/release/APP-DELIVERABLE-DIGEST.json
 *   - per_package：每包 dist 文件数 + 该包清单摘要（对 "相对路径:文件sha256\n" 拼接串取 sha256）；
 *   - aggregate_digest：对 {各包摘要 + pnpm-lock.yaml 摘要} 的规范化 JSON 取 sha256
 *     ——RELEASE-ANCHOR.json app_deliverable 引用该值；
 *   - 明细文件级哈希不入锚（体积），由本文件 full_manifest 承载并随发行归档。
 *
 * 用法：node deploy/release/app-deliverable-digest.mjs [--repo-root DIR] [--out FILE] [--check FILE]
 *   --check：只读校验（重新计算与既有清单比对，不写文件；不一致退出 1）。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function sha256FileBinary(filePath) {
  const { open } = await import('node:fs/promises')
  const handle = await open(filePath, 'r')
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

/** 递归收集目录下全部文件相对路径（排序，剔除 .DS_Store 等环境噪声）。 */
async function walkFiles(root, dir = '', acc = []) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) await walkFiles(root, rel, acc)
    else if (entry.isFile() && entry.name !== '.DS_Store') acc.push(rel)
  }
  return acc
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

async function collectDigest(root) {
  const workspaceDirs = []
  for (const base of ['packages', 'apps']) {
    const baseDir = path.join(root, base)
    if (!existsSync(baseDir)) continue
    for (const entry of (await readdir(baseDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) workspaceDirs.push(`${base}/${entry.name}`)
    }
  }
  const perPackage = []
  const fullManifest = {}
  for (const dir of workspaceDirs) {
    const distDir = path.join(root, dir, 'dist')
    if (!existsSync(distDir)) continue
    const files = await walkFiles(distDir)
    const lines = []
    const fileHashes = {}
    for (const rel of files) {
      const hash = await sha256FileBinary(path.join(distDir, rel))
      fileHashes[rel] = hash
      lines.push(`${rel}:${hash}\n`)
    }
    const packageDigest = sha256Text(lines.join(''))
    perPackage.push({ package: dir, dist_files: files.length, sha256: packageDigest })
    fullManifest[dir] = fileHashes
  }
  if (perPackage.length === 0) throw new Error('未发现任何 dist 产物——先执行 pnpm build')
  const lockSha = await sha256FileBinary(path.join(root, 'pnpm-lock.yaml'))
  const aggregateInput = JSON.stringify({
    packages: perPackage.map((p) => ({ package: p.package, sha256: p.sha256, dist_files: p.dist_files })),
    dependency_lock: 'pnpm-lock.yaml',
    dependency_lock_sha256: lockSha,
  })
  return {
    per_package: perPackage,
    dependency_lock: { path: 'pnpm-lock.yaml', sha256: lockSha },
    aggregate_digest: sha256Text(aggregateInput),
    full_manifest: fullManifest,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = args['repo-root'] ? path.resolve(args['repo-root']) : DEFAULT_ROOT
  const out = args['out'] ?? path.join(root, 'deploy/release/APP-DELIVERABLE-DIGEST.json')

  const digest = await collectDigest(root)

  if (args['check'] !== undefined && args['check'] !== '') {
    const existing = JSON.parse(await readFile(args['check'], 'utf8'))
    const mismatches = []
    if (existing.aggregate_digest !== digest.aggregate_digest) mismatches.push('aggregate_digest 不一致')
    for (const pkg of digest.per_package) {
      const prior = (existing.per_package ?? []).find((p) => p.package === pkg.package)
      if (prior === undefined) mismatches.push(`包 ${pkg.package} 不在既有清单`)
      else if (prior.sha256 !== pkg.sha256 || prior.dist_files !== pkg.dist_files) mismatches.push(`包 ${pkg.package} 摘要/文件数不一致`)
    }
    for (const prior of existing.per_package ?? []) {
      if (!digest.per_package.some((p) => p.package === prior.package)) mismatches.push(`既有清单包 ${prior.package} 的 dist 已缺失`)
    }
    if (mismatches.length > 0) {
      console.error('[R3 应用交付物] 校验 FAIL：')
      for (const m of mismatches) console.error(`  - ${m}`)
      process.exit(1)
    }
    console.log(`[R3 应用交付物] 校验 PASS：aggregate_digest=${digest.aggregate_digest}（${String(digest.per_package.length)} 包）`)
    return
  }

  const record = {
    generated_at: new Date().toISOString(),
    node_version: process.versions.node,
    form: 'pnpm workspace dist 清单（无独立容器镜像——现场发行打镜像时补 app_image_digest 并以镜像内产物与本清单核对）',
    per_package: digest.per_package,
    dependency_lock: digest.dependency_lock,
    aggregate_digest: digest.aggregate_digest,
    full_manifest: digest.full_manifest,
  }
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  console.log(`[R3 应用交付物] ${String(digest.per_package.length)} 包 dist 清单已写入 ${out}`)
  for (const p of digest.per_package) console.log(`  - ${p.package}: ${String(p.dist_files)} 文件 sha256=${p.sha256.slice(0, 16)}…`)
  console.log(`  aggregate_digest=${digest.aggregate_digest}`)
}

main().catch((error) => {
  console.error('应用交付物摘要失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
