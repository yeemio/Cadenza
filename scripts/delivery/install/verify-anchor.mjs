#!/usr/bin/env node
/**
 * 环境版本锚校验（T26，DO-05）＋干净环境校验（DO-02）。
 *
 * - 锚校验：目标环境规格（容器运行时 / PostgreSQL 主版本 / Node 版本）与
 *   RELEASE-ANCHOR.json 成对登记的规格与版本比对，不匹配即拒绝（退出非零）。
 * - --assert-clean：目标库 public schema 存在任何表（含 schema_migrations）即拒绝——
 *   干净安装只允许在干净环境执行（无既有数据库/残留配置）。
 *
 * 用法：
 *   verify-anchor.mjs --anchor FILE --database-url URL [--no-container-runtime]
 *   verify-anchor.mjs --assert-clean --database-url URL
 */

import { readFile } from 'node:fs/promises'
import { withPool } from '../lib/db.mjs'

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
  const databaseUrl = args['database-url']
  if (!databaseUrl) {
    console.error('必须提供 --database-url')
    process.exit(2)
  }

  if (args['assert-clean'] !== undefined) {
    await withPool(databaseUrl, async (pool) => {
      const r = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`)
      if (r.rows.length > 0) {
        console.error(`[DO-02 干净安装] 目标库已有 ${String(r.rows.length)} 张表（${r.rows.slice(0, 5).map((x) => x.table_name).join(', ')}${r.rows.length > 5 ? '…' : ''}）——非干净环境，拒绝安装`)
        process.exit(1)
      }
      console.log('[DO-02 干净安装] 目标库 public schema 为空（干净环境确认）')
    })
    return
  }

  const anchorPath = args['anchor']
  if (!anchorPath) {
    console.error('必须提供 --anchor（或 --assert-clean）')
    process.exit(2)
  }
  const anchor = JSON.parse(await readFile(anchorPath, 'utf8'))
  const failures = []

  // 1) 容器运行时
  if (!args['no-container-runtime'] && anchor.target_environment.container_runtime === 'docker') {
    const { execFile } = await import('node:child_process')
    const dockerOk = await new Promise((resolve) => {
      execFile('docker', ['--version'], (error) => resolve(error === null))
    })
    if (!dockerOk) failures.push(`容器运行时：锚要求 docker，目标环境不可用（非容器部署用 --no-container-runtime 显式豁免并登记）`)
    else console.log('[DO-05] 容器运行时：docker 可用')
  }

  // 2) Node 版本
  const nodeMin = anchor.target_environment.node_runtime ?? '>=24'
  const minMajor = Number(/(\d+)/.exec(nodeMin)?.[1] ?? '24')
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < minMajor) {
    failures.push(`Node 版本：锚要求 ${nodeMin}，当前 ${process.versions.node}`)
  } else {
    console.log(`[DO-05] Node 运行时：${process.versions.node}（锚 ${nodeMin}）`)
  }

  // 3) 数据库主版本（连接目标库实测 SELECT version()）
  await withPool(databaseUrl, async (pool) => {
    const r = await pool.query('SELECT version() AS v')
    const major = Number(/PostgreSQL (\d+)/.exec(r.rows[0].v)?.[1] ?? '0')
    const expected = anchor.target_environment.database.major_version
    if (major !== expected) {
      failures.push(`PostgreSQL 主版本：锚要求 ${String(expected)}，目标库为 ${String(major)}`)
    } else {
      console.log(`[DO-05] PostgreSQL 主版本：${String(major)}（锚 ${String(expected)}）——规格与版本匹配`)
    }
  })

  if (failures.length > 0) {
    console.error('[DO-05] 环境版本锚校验失败（规格与版本不匹配，安装脚本拒绝执行）：')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('[DO-05] 环境版本锚校验通过')
}

main().catch((error) => {
  console.error('版本锚校验失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
