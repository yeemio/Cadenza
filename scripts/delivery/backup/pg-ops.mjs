#!/usr/bin/env node
/**
 * 备份恢复脚本的低层 PG 操作助手（bash 脚本调用）。
 *
 * 子命令：
 *   applied  --database-url URL                      → 打印已应用迁移版本（逗号分隔）
 *   recreate --admin-url URL --database NAME --target-confirm NAME → 重建目标库（DROP+CREATE）
 *   exists   --admin-url URL --database NAME         → 打印 yes/no
 *   server-now --database-url URL                    → 打印数据库当前时间（RPO 锚）
 *
 * recreate 安全：--target-confirm 必须与 --database 完全一致（输入目标库名确认），
 * 并显式拒绝 cadenza dev 主库名与并行线测试库前缀（防误恢复覆盖）。
 */

import { createDatabase, databaseExists, dropDatabase, withPool } from '../lib/db.mjs'

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
  const command = process.argv[2]
  if (command === 'applied') {
    const versions = await withPool(args['database-url'], async (pool) => {
      const r = await pool.query('SELECT version FROM schema_migrations ORDER BY version')
      return r.rows.map((x) => x.version)
    })
    console.log(versions.join(','))
    return
  }
  if (command === 'server-now') {
    await withPool(args['database-url'], async (pool) => {
      const r = await pool.query('SELECT now()::text AS now')
      console.log(r.rows[0].now)
    })
    return
  }
  if (command === 'exists') {
    console.log((await databaseExists(args['admin-url'], args['database'])) ? 'yes' : 'no')
    return
  }
  if (command === 'recreate') {
    const name = args['database']
    if (!name || args['target-confirm'] !== name) {
      console.error('恢复安全确认失败：--target-confirm 必须与 --database 完全一致（输入目标库名确认）')
      process.exit(2)
    }
    // 保护：dev 主库与并行线测试库一律拒绝（cadenza_dops_* 演练临时库除外）
    if (name === 'cadenza' || (/^cadenza_/.test(name) && !/^cadenza_dops_/.test(name))) {
      console.error(`恢复目标 ${name} 受保护（dev 主库/并行线测试库），拒绝重建`)
      process.exit(1)
    }
    if (await databaseExists(args['admin-url'], name)) {
      await dropDatabase(args['admin-url'], name)
    }
    await createDatabase(args['admin-url'], name)
    console.log(`recreated: ${name}`)
    return
  }
  console.error('用法：pg-ops.mjs applied|server-now|exists|recreate …（见文件头注释）')
  process.exit(2)
}

main().catch((error) => {
  console.error('pg-ops 失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
