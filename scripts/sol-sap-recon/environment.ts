import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createPool, migrateUp, migrations, seedOrgAuth, grantDevDomainPermissions } from '@cadenza/persistence'

/** Only creates a fresh lane-owned DB. Never drops or resets any database; no .env loading. */
export async function prepareExclusiveEnvironment(label: string) {
  const admin = createPool('postgres://postgres:cadenza_dev@127.0.0.1:55433/postgres', { max: 1 })
  let database = 'cadenza_sol_recon_1031'
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])
    if (exists.rowCount) database += `_${Date.now()}_${process.pid}`
    if (!/^cadenza_sol_recon_1031(?:_\d+_\d+)?$/.test(database)) throw new Error('Invalid lane database')
    await admin.query(`CREATE DATABASE "${database}"`)
  } finally { await admin.end() }
  const url = new URL('postgres://postgres:cadenza_dev@127.0.0.1:55433/postgres')
  url.pathname = `/${database}`
  const pool = createPool(url.toString(), { max: 4 })
  const evidence = path.resolve('delivery/sol-rework-20261031/sap-recon', `${label}-${database}`)
  await mkdir(evidence, { recursive: true })
  await writeFile(path.join(evidence, 'environment.json'), JSON.stringify({ database, host: url.hostname,
    port: url.port, freshDatabase: true, cleanup: 'PRESERVED', actual_connection: false }, null, 2))
  try {
    const applied = await migrateUp(pool, migrations)
    await seedOrgAuth(pool)
    await grantDevDomainPermissions(pool)
    await writeFile(path.join(evidence, 'migrations.json'), JSON.stringify(applied))
    return { pool, database, evidence, url: url.toString() }
  } catch (error) { await pool.end(); throw error }
}
