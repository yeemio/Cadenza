#!/usr/bin/env node
/**
 * 安装后重启自检（T26，DO-04）。
 *
 * 点名历史坑：空模块配置与重启后失效的签名密钥在重启后才暴露——自检必须在
 * 「安装完成 + 应用启动」状态下执行，覆盖：
 *  1. 数据库连通（应用所用 DATABASE_URL 实连）；
 *  2. 迁移完备：schema_migrations == 发行锚登记的迁移版本集合；
 *  3. 关键配置非空：DATABASE_URL 显式提供（dev 回落要 FAIL——生产必须显式）；
 *  4. 健康端点（--api-url 提供时）：/health 返回 200 且 db=ok。
 *
 * 用法：selfcheck.mjs --database-url URL [--anchor FILE] [--api-url URL] [--allow-dev-default]
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withPool } from '../lib/db.mjs'

const DEFAULT_ANCHOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deploy/release/RELEASE-ANCHOR.json')

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
  const anchorPath = args['anchor'] ?? DEFAULT_ANCHOR
  const anchor = JSON.parse(await readFile(anchorPath, 'utf8'))
  const failures = []

  // 1) 配置非空（DO-04：空模块配置破坏运行）
  const databaseUrl = args['database-url']
  if (!databaseUrl) {
    failures.push('DATABASE_URL 未显式提供（生产必须显式；dev 回落属配置缺失）')
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    failures.push(`DATABASE_URL 非法：${databaseUrl}`)
  } else {
    console.log(`[DO-04] 配置：DATABASE_URL 已显式提供（目标库 ${databaseUrl.replace(/:[^:@/]*@/, ':***@')}）`)
  }

  // 2) 数据库连通 + 3) 迁移完备
  if (databaseUrl) {
    await withPool(databaseUrl, async (pool) => {
      await pool.query('SELECT 1')
      console.log('[DO-04] 数据库连通：OK')
      const r = await pool.query('SELECT version FROM schema_migrations ORDER BY version')
      const applied = r.rows.map((x) => x.version)
      const expected = [...anchor.migration_versions].sort()
      const missing = expected.filter((v) => !applied.includes(v))
      const extra = applied.filter((v) => !expected.includes(v))
      if (missing.length > 0) failures.push(`迁移不完备：缺 ${missing.join(', ')}`)
      if (extra.length > 0) failures.push(`库内存在锚外迁移版本：${extra.join(', ')}（升级走 DO-20 路径，此处按发行锚校验）`)
      if (missing.length === 0 && extra.length === 0) {
        console.log(`[DO-04] 迁移完备：${applied.join(', ')}（与发行锚一致）`)
      }
    }).catch((error) => {
      failures.push(`数据库连通失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // 4) 健康端点
  if (args['api-url']) {
    try {
      const response = await fetch(args['api-url'])
      const body = await response.json()
      if (response.status === 200 && body?.status === 'ok' && body?.db === 'ok') {
        console.log(`[DO-04] 健康端点：${args['api-url']} → 200 ok/db=ok（checkedAt=${String(body?.checkedAt)}）`)
      } else {
        failures.push(`健康端点异常：HTTP ${String(response.status)} ${JSON.stringify(body)}`)
      }
    } catch (error) {
      failures.push(`健康端点不可达：${args['api-url']}（${error instanceof Error ? error.message : String(error)}）——应用未启动或重启后配置失效（DO-04 点名坑）`)
    }
  }

  if (failures.length > 0) {
    console.error('[DO-04] 安装后重启自检失败：')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('[DO-04] 安装后重启自检通过')
}

main().catch((error) => {
  console.error('自检失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
