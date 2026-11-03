import type pg from 'pg'
import {
  createPool,
  migrateUp,
  migrations,
  seedOrgAuth,
  grantDevDomainPermissions,
} from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'

export const GROUP_TEST_DB_NAME = 'cadenza_group_g'

export function groupDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/[^/]+$/, `/${GROUP_TEST_DB_NAME}`)
}

export async function ensureGroupTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/[^/]+$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${GROUP_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${GROUP_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

export async function prepareGroupTestDatabase(): Promise<pg.Pool> {
  await ensureGroupTestDatabase()
  const pool = createPool(groupDatabaseUrl(), { max: 4 })
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
