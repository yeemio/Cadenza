import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { migrateUp, migrations, seedOrgAuth, grantDevDomainPermissions } from '@cadenza/persistence'

/** Fresh explicitly authorized test DB only. Original fixture grants remain confined to this new DB. */
export async function prepareExclusiveEnvironment(label: string) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid evidence label')
  const { createExclusiveDatabase } = await import('../delivery/build/exclusive-pg.mjs')
  const fresh = await createExclusiveDatabase('recon')
  const { pool, database, runId, host, port } = fresh
  const evidence = path.resolve('delivery/sol-rework-20261031/sap-recon', label + '-' + database)
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(path.join(evidence, 'environment.json'), JSON.stringify({ database, runId, host, port,
      freshDatabase: true, cleanup: 'PRESERVED', postgresConnection: 'REAL', actual_connection: false,
      actual_connection_meaning: 'No real SAP connection; this is the local simulator.' }, null, 2))
    const applied = await migrateUp(pool, migrations)
    await seedOrgAuth(pool)
    await grantDevDomainPermissions(pool)
    await writeFile(path.join(evidence, 'migrations.json'), JSON.stringify(applied))
    return { ...fresh, evidence }
  } catch (error) { await pool.end(); throw error }
}
