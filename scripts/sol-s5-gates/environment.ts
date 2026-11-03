import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createPool, migrateUp, migrations, seedOrgAuth, grantDevDomainPermissions } from '@cadenza/persistence'

/** Creates this assignment's empty local DB and preserves it on success or failure. No .env use. */
export async function prepareS5GatesEnvironment() {
  const url = new URL('postgres://postgres:cadenza_dev@127.0.0.1:55433/postgres')
  const admin = createPool(url.toString(), { max: 1 })
  let database = 'cadenza_sol_s5gates_1031'
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])
    if (exists.rowCount) database += `_${Date.now()}_${process.pid}`
    if (!/^cadenza_sol_s5gates_1031(?:_\d+_\d+)?$/.test(database)) throw new Error('Invalid assignment database')
    await admin.query(`CREATE DATABASE "${database}"`)
  } finally { await admin.end() }
  url.pathname = `/${database}`
  const pool = createPool(url.toString(), { max: 4 })
  const evidence = resolve('delivery/sol-rework-20261031/s5-gates', database)
  await mkdir(evidence, { recursive: true })
  await writeFile(`${evidence}/environment.json`, JSON.stringify({ database, host: url.hostname, port: url.port,
    freshDatabase: true, cleanup: 'PRESERVED', production: false }, null, 2))
  try {
    const applied = await migrateUp(pool, migrations)
    await seedOrgAuth(pool)
    await grantDevDomainPermissions(pool)
    await writeFile(`${evidence}/migrations.json`, JSON.stringify(applied, null, 2))
    return { pool, database, evidence }
  } catch (error) { await pool.end(); throw error }
}
