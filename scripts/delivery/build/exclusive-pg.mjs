import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const apiRequire = createRequire(new URL('../../../apps/api/package.json', import.meta.url))

export function parseAdminUrl(raw) {
  if (!raw) throw new Error('CADENZA_TEST_ADMIN_URL is required; no default/shared database or skip is permitted')
  let url
  try { url = new URL(raw) } catch { throw new Error('Invalid explicit test admin URL') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username ||
      url.pathname !== '/postgres' || url.search || url.hash) {
    throw new Error('Test admin URL must explicitly name host, user and /postgres, without query overrides')
  }
  return url
}

export function freshDatabaseName(lane, uuid = randomUUID()) {
  if (!['engine', 'recon', 'idempotency', 'required'].includes(lane) || !/^[a-f0-9-]{36}$/.test(uuid)) {
    throw new Error('Invalid exclusive test lane or nonce')
  }
  return 'cadenza_pr13_' + lane + '_' + uuid.replaceAll('-', '')
}

/** CREATE only: never reuse, reset or drop a database. Requires an already-authorized test role. */
export async function createExclusiveDatabase(lane, env = process.env) {
  const url = parseAdminUrl(env.CADENZA_TEST_ADMIN_URL)
  const { Pool } = apiRequire('pg')
  const database = freshDatabaseName(lane)
  const runId = randomUUID()
  const admin = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 5000 })
  try { await admin.query('CREATE DATABASE "' + database + '"') }
  catch { throw new Error('Exclusive test database creation failed; no existing database was reused') }
  finally { await admin.end() }
  url.pathname = '/' + database
  const pool = new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000 })
  try {
    // Test infrastructure marker, never a migration or business fact; authorizes this run's resume only.
    await pool.query('CREATE TABLE cadenza_pr13_test_run (run_id text PRIMARY KEY, lane text NOT NULL)')
    await pool.query('INSERT INTO cadenza_pr13_test_run(run_id,lane) VALUES($1,$2)', [runId, lane])
    return { pool, database, runId, url: url.toString(), host: url.hostname, port: url.port || '5432' }
  } catch {
    await pool.end()
    throw new Error('Fresh test database initialization failed; database preserved for diagnosis')
  }
}

export async function resumeExclusiveDatabase(meta, env = process.env) {
  const url = parseAdminUrl(env.CADENZA_TEST_ADMIN_URL)
  if (!/^cadenza_pr13_recon_[a-f0-9]{32}$/.test(meta.database ?? '') ||
      !/^[a-f0-9-]{36}$/.test(meta.runId ?? '') || meta.host !== url.hostname ||
      String(meta.port) !== (url.port || '5432') || env.CADENZA_RECON_RESUME_RUN_ID !== meta.runId) {
    throw new Error('Resume requires the explicit same-run nonce and matching fresh recon endpoint')
  }
  url.pathname = '/' + meta.database
  const { Pool } = apiRequire('pg')
  const pool = new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000 })
  try {
    const marker = await pool.query('SELECT run_id, lane FROM cadenza_pr13_test_run')
    if (marker.rows.length !== 1 || marker.rows[0].run_id !== meta.runId || marker.rows[0].lane !== 'recon') {
      throw new Error('Wrong run')
    }
    return { pool, database: meta.database, runId: meta.runId, url: url.toString(), host: url.hostname, port: url.port || '5432' }
  } catch {
    await pool.end()
    throw new Error('Resume run marker does not match; no business mutation was attempted')
  }
}
