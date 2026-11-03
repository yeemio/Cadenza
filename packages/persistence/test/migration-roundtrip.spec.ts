import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { createPool, resolveDatabaseUrl } from '../src/env'
import { migrateDown, migrateStatus, migrateUp } from '../src/migrations/index'
import { migrations } from '../src/migrations/registry'

/**
 * 真容器迁移往返实测：docker compose up -d（cadenza-dev-pg @ 127.0.0.1:55433）后运行。
 * 容器未启动时逐条 skip 并明示原因（不视为失败）。
 *
 * P1-S2 起（0002 注册）期望版本改为按注册表推导（DESC），不再硬编码；
 * 断言意图不变：up 建齐表、幂等、全量回退往返、单步回退只动最近一个版本。
 */

const DATABASE_URL = resolveDatabaseUrl()

/** 注册表推导的期望状态（migrateStatus / down 返回均为版本 DESC）。 */
const EXPECTED_DESC = [...migrations].map((m) => m.version).sort((a, b) => b.localeCompare(a))

async function withPool<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = createPool(DATABASE_URL, { max: 1 })
  try {
    return await fn(pool)
  } finally {
    await pool.end()
  }
}

/** 可用性探测只做一次，结果缓存。 */
let dbAvailable: boolean | undefined

async function ensureDb(): Promise<boolean> {
  if (dbAvailable === undefined) {
    try {
      await withPool((pool) => pool.query('SELECT 1'))
      dbAvailable = true
    } catch {
      dbAvailable = false
      console.warn(
        `SKIP migration-roundtrip: 数据库不可达（${DATABASE_URL}）。请先 docker compose up -d 再重跑。`,
      )
    }
  }
  return dbAvailable
}

function tableExists(name: string): Promise<boolean> {
  return withPool(async (pool) => {
    const result = await pool.query<{ exists: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [`public.${name}`],
    )
    return result.rows[0]?.exists === true
  })
}

const TABLES = [
  'command_receipt',
  'outbox',
  'inbox',
  'audit_entry',
  'org_node',
  'role',
  'user_account',
  'scope_grant',
  'auth_session',
  'shift_calendar',
  'external_mapping',
  'schema_migrations',
]

describe('persistence 迁移（真实容器）', () => {
  it('up 建齐平台表与组织权限表（对已应用状态幂等收敛）', async (ctx) => {
    if (!(await ensureDb())) return ctx.skip()
    await withPool((pool) => migrateUp(pool, migrations))
    expect(await withPool((pool) => migrateStatus(pool))).toEqual(EXPECTED_DESC)
    for (const table of TABLES) {
      expect(await tableExists(table), table).toBe(true)
    }
  })

  it('up 幂等：重复执行不报错且状态一致', async (ctx) => {
    if (!(await ensureDb())) return ctx.skip()
    const applied = await withPool((pool) => migrateUp(pool, migrations))
    expect(applied).toEqual([])
    expect(await withPool((pool) => migrateStatus(pool))).toEqual(EXPECTED_DESC)
  })

  it('down --all 全量回退后表消失，再 up 可重新应用（往返可重入）', async (ctx) => {
    if (!(await ensureDb())) return ctx.skip()
    const removed = await withPool((pool) => migrateDown(pool, migrations, { all: true }))
    expect(removed).toEqual(EXPECTED_DESC)
    for (const table of TABLES) {
      expect(await tableExists(table), table).toBe(false)
    }
    const applied = await withPool((pool) => migrateUp(pool, migrations))
    expect(applied).toEqual([...EXPECTED_DESC].sort())
    expect(await tableExists('outbox')).toBe(true)
    expect(await tableExists('org_node')).toBe(true)
  })

  it('单步 down 只回退最近一个版本', async (ctx) => {
    if (!(await ensureDb())) return ctx.skip()
    const removed = await withPool((pool) => migrateDown(pool, migrations))
    expect(removed).toEqual([EXPECTED_DESC[0]!])
    await withPool((pool) => migrateUp(pool, migrations)) // 恢复现场
  })
})
