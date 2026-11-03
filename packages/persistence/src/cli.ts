import type pg from 'pg'
import { createPool, resolveDatabaseUrl } from './env'
import { migrateDown, migrateStatus, migrateUp } from './migrations/index'
import { migrations } from './migrations/registry'
import { grantDevDomainPermissions, seedDefaultAiQueryCapabilities, seedOrgAuth } from './seed'

/** 迁移 CLI：`cli.ts up | down [--all] | status | seed`（经根脚本 db:migrate:up/down/db:seed 调用）。 */

function usage(): never {
  console.error('usage: cli.ts up | down [--all] | status | seed')
  process.exitCode = 2
  throw new Error('invalid args')
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const url = resolveDatabaseUrl()
  const pool: pg.Pool = createPool(url)
  try {
    if (command === 'up') {
      const applied = await migrateUp(pool, migrations)
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up-to-date')
    } else if (command === 'down') {
      const all = rest.includes('--all')
      const removed = await migrateDown(pool, migrations, { all })
      console.log(removed.length ? `reverted: ${removed.join(', ')}` : 'nothing to revert')
    } else if (command === 'status') {
      const versions = await migrateStatus(pool)
      console.log(versions.length ? `applied: ${versions.join(', ')}` : 'no migrations applied')
    } else if (command === 'seed') {
      // 种子幂等：先确保迁移就位，再执行（可重复运行收敛同一状态）
      const applied = await migrateUp(pool, migrations)
      if (applied.length) console.log(`applied: ${applied.join(', ')}`)
      const counts = await seedOrgAuth(pool)
      await grantDevDomainPermissions(pool)
      // AQ-REG-03 首版三能力注册（dev 种子收编，2026-10-29；华东企业范围）
      const ent = await pool.query<{ id: string }>(
        `SELECT id FROM org_node WHERE code = 'ENT-HD' AND kind = 'enterprise' AND status = 'active' LIMIT 1`,
      )
      const aiCapabilities = ent.rows[0]
        ? await seedDefaultAiQueryCapabilities(pool, ent.rows[0].id)
        : -1
      console.log(
        `seeded (idempotent): org_nodes=${counts.orgNodes} roles=${counts.roles} users=${counts.users} grants=${counts.grants} shifts=${counts.shifts} ai_capabilities=${aiCapabilities}`,
      )
    } else {
      usage()
    }
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(`migrate failed:`, error instanceof Error ? error.message : error)
  process.exit(1)
})
