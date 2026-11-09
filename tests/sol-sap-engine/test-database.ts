let selectedUrl: string | undefined
/** A separate freshly-created database per isolated Vitest file; never shared, reset or dropped. */
export async function prepareEngineDatabase(): Promise<string> {
  if (selectedUrl) throw new Error('Engine database already initialized for this test file')
  const { createExclusiveDatabase } = await import('../../scripts/delivery/build/exclusive-pg.mjs')
  const database = await createExclusiveDatabase('engine')
  selectedUrl = database.url
  await database.pool.end()
  return selectedUrl
}
export function engineDatabaseUrl(): string {
  if (!selectedUrl) throw new Error('Engine exclusive database was not initialized')
  return selectedUrl
}
