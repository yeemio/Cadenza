import type pg from 'pg'

/**
 * 版本化迁移执行器。
 *
 * - 记录表 schema_migrations(version, name, applied_at)；
 * - 每个迁移的 up/down 在独立事务内执行（PostgreSQL 支持事务性 DDL）；
 * - up 按注册顺序应用未执行的版本；down 按逆序回退；
 * - up 保证幂等跳过已应用版本；down 校验 drift（库里有未知版本即拒绝）。
 */

export interface Migration {
  /** 版本号，字符串排序即应用顺序（如 '0001'） */
  version: string
  name: string
  up: string
  down: string
}

const ENSURE_REGISTRY = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)
`

async function appliedVersions(client: pg.PoolClient): Promise<string[]> {
  const result = await client.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version DESC',
  )
  return result.rows.map((r) => r.version)
}

export async function migrateUp(pool: pg.Pool, migrations: readonly Migration[]): Promise<string[]> {
  const appliedNow: string[] = []
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(ENSURE_REGISTRY)
    const applied = new Set(await appliedVersions(client))
    for (const migration of [...migrations].sort((a, b) => a.version.localeCompare(b.version))) {
      if (applied.has(migration.version)) continue
      await client.query(migration.up)
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ])
      appliedNow.push(migration.version)
    }
    await client.query('COMMIT')
    return appliedNow
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export interface MigrateDownOptions {
  /** 回退全部已应用版本（默认只回退最近一个） */
  all?: boolean
}

export async function migrateDown(
  pool: pg.Pool,
  migrations: readonly Migration[],
  options: MigrateDownOptions = {},
): Promise<string[]> {
  const removed: string[] = []
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(ENSURE_REGISTRY)
    const known = new Map(migrations.map((m) => [m.version, m]))
    const applied = await appliedVersions(client) // DESC
    for (const version of applied) {
      const migration = known.get(version)
      if (!migration) {
        throw new Error(
          `migration drift: schema_migrations 含未注册版本 ${version}，拒绝回退（需人工处置）`,
        )
      }
      await client.query(migration.down)
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [version])
      removed.push(version)
      if (!options.all) break
    }
    if ((await appliedVersions(client)).length === 0) {
      await client.query('DROP TABLE IF EXISTS schema_migrations')
    }
    await client.query('COMMIT')
    return removed
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function migrateStatus(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect()
  try {
    await client.query(ENSURE_REGISTRY)
    const versions = await appliedVersions(client)
    return versions
  } finally {
    client.release()
  }
}
