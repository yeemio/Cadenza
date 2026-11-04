import { createRequire } from 'node:module'
import { dbNameOf } from './util.mjs'

/**
 * pg 连接帮助：优先根 node_modules 的 pg，回落 persistence 包依赖（pnpm 隔离布局）。
 * 演练/临时库安全护栏：任何 DROP/CREATE 目标库名必须匹配 cadenza_dops_* 白名单前缀，
 * 绝不允许操作 cadenza 主库与既有并行线测试库（P3-E 特别事项 3）。
 */

let cachedPg = undefined

export async function loadPg() {
  if (cachedPg) return cachedPg
  try {
    const mod = await import('pg')
    cachedPg = mod.default ?? mod
  } catch {
    const require = createRequire(
      new URL('../../../packages/persistence/package.json', import.meta.url),
    )
    cachedPg = require('pg')
  }
  return cachedPg
}

const DRILL_DB_PATTERN = /^cadenza_dops_[a-z0-9_]+$/
const FORBIDDEN_DB_NAMES = new Set(['cadenza', 'postgres', 'template0', 'template1'])

/** 临时库安全护栏：仅允许 cadenza_dops_* 前缀，且永不等于主库/系统库。 */
export function assertDrillSafeDbName(name) {
  if (FORBIDDEN_DB_NAMES.has(name) || !DRILL_DB_PATTERN.test(name)) {
    throw new Error(
      `[DO-安全护栏] 目标库 ${name} 不在临时库白名单（cadenza_dops_* 前缀），拒绝操作；` +
        'cadenza 主库与既有测试库受特别事项 3 保护，不可用于演练写入/删除。',
    )
  }
}

export async function withPool(url, fn) {
  const pg = await loadPg()
  const pool = new pg.Pool({ connectionString: url, max: 4 })
  try {
    return await fn(pool)
  } finally {
    await pool.end()
  }
}

/** 同主机维护库连接（CREATE/DROP DATABASE 须连 postgres 库）。 */
export function adminUrlOf(url) {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('Invalid PostgreSQL URL')
  parsed.pathname = '/postgres'
  return parsed.toString()
}

export async function createDatabase(adminUrl, name) {
  assertDrillSafeDbName(name)
  await withPool(adminUrl, async (pool) => {
    await pool.query(`CREATE DATABASE "${name}" ENCODING 'UTF8'`)
  })
}

export async function dropDatabase(adminUrl, name) {
  assertDrillSafeDbName(name)
  await withPool(adminUrl, async (pool) => {
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    )
    await pool.query(`DROP DATABASE IF EXISTS "${name}"`)
  })
}

export async function databaseExists(adminUrl, name) {
  return withPool(adminUrl, async (pool) => {
    const result = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    return result.rows.length > 0
  })
}

/** 迁移执行（复用产品迁移器，registry 全量；幂等：已应用版本自动跳过）。 */
export async function applyMigrations(url) {
  const require = createRequire(
    new URL('../../../packages/persistence/package.json', import.meta.url),
  )
  const migrationsIndex = require('./dist/migrations/index.js')
  const registry = require('./dist/migrations/registry.js')
  const pg = await loadPg()
  const pool = new pg.Pool({ connectionString: url, max: 2 })
  try {
    return await migrationsIndex.migrateUp(pool, registry.migrations)
  } finally {
    await pool.end()
  }
}

export async function appliedMigrations(url) {
  return withPool(url, async (pool) => {
    const result = await pool.query('SELECT version FROM schema_migrations ORDER BY version')
    return result.rows.map((r) => r.version)
  })
}

/** 目标库是否已有产品 schema（干净安装判定，DO-02：非空即拒绝干净安装）。 */
export async function targetHasSchema(url) {
  return withPool(url, async (pool) => {
    const db = dbNameOf(url)
    if (db === '') return { hasSchema: false, tableCount: 0 }
    const result = await pool.query(
      `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'`,
    )
    const count = Number(result.rows[0]?.count ?? '0')
    return { hasSchema: count > 0, tableCount: count }
  })
}

/** A server-enforced read-only snapshot; never call migrateStatus (it creates the registry table). */
export async function withReadOnlyConnection(url, fn) {
  return withPool(url, async pool => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SET LOCAL statement_timeout = '30s'")
      return await fn(client)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
}
