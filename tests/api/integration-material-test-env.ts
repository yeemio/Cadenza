import type pg from 'pg'
import {
  createPool,
  migrateUp,
  migrations,
  seedOrgAuth,
  grantDevDomainPermissions,
} from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'

export const IF01_TEST_DB_NAME = 'cadenza_if01'

export function if01DatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/[^/]+$/, `/${IF01_TEST_DB_NAME}`)
}

export async function ensureIf01TestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/[^/]+$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${IF01_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${IF01_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

export async function prepareIf01TestDatabase(): Promise<pg.Pool> {
  await ensureIf01TestDatabase()
  const pool = createPool(if01DatabaseUrl(), { max: 4 })
  await migrateUp(pool, [...migrations])
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantDevDomainPermissions(pool)
  return pool
}

export async function nodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (!r.rows[0]) throw new Error(`org_node ${code} missing`)
  return r.rows[0].id
}
