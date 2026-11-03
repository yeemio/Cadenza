/** Only the explicitly selected, assignment-owned local database may be mutated by these suites. */
export function engineDatabaseUrl(): string {
  const raw = process.env['CADENZA_SOL_ENGINE_DATABASE_URL']
  if (!raw) throw new Error('CADENZA_SOL_ENGINE_DATABASE_URL must explicitly select the assignment-owned database')
  const url = new URL(raw)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '55433' ||
      !/^\/cadenza_sol_engine_1031(?:_[a-zA-Z0-9_]+)?$/.test(url.pathname)) {
    throw new Error('Refusing to mutate a database outside SOL-SAP-ENGINE-1031')
  }
  return raw
}
