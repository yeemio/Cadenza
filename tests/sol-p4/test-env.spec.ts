import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  query: vi.fn(), end: vi.fn(), migrate: vi.fn(), seed: vi.fn(), create: vi.fn(),
}))
vi.mock('@cadenza/persistence', () => ({
  createPool: db.create, migrateUp: db.migrate, migrations: [], seedOrgAuth: db.seed,
}))
import { AQ_TEST_DB_NAME, aqDatabaseUrl, ensureAqTestDatabase, prepareAqTestDatabase } from '../api/aiquery-test-env'

const original = process.env['AQ_TEST_DATABASE_URL']
beforeEach(() => {
  vi.clearAllMocks()
  process.env['AQ_TEST_DATABASE_URL'] = 'postgres://tester:test@127.0.0.1:55433/arbitrary_old_name?application_name=p4'
  db.create.mockReturnValue({ query: db.query, end: db.end })
  db.query.mockResolvedValue({ rowCount: 0, rows: [] })
  db.end.mockResolvedValue(undefined)
  db.migrate.mockResolvedValue(undefined)
})
afterEach(() => {
  if (original === undefined) delete process.env['AQ_TEST_DATABASE_URL']
  else process.env['AQ_TEST_DATABASE_URL'] = original
})

describe('P4 exclusive test database and honest preparation failures', () => {
  it('parses any base database name and preserves connection query options', () => {
    const url = new URL(aqDatabaseUrl())
    expect(url.pathname).toBe(`/${AQ_TEST_DB_NAME}`)
    expect(url.searchParams.get('application_name')).toBe('p4')
    expect(url.port).toBe('55433')
  })
  it('rejects non-local connections before any database operation', async () => {
    process.env['AQ_TEST_DATABASE_URL'] = 'postgres://tester:test@example.invalid/old'
    await expect(ensureAqTestDatabase()).rejects.toThrow('local PostgreSQL')
    expect(db.create).not.toHaveBeenCalled()
  })
  it('allocates a new suffix for an existing name, never drops or resets databases', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
    await ensureAqTestDatabase()
    expect(AQ_TEST_DB_NAME).toMatch(/^cadenza_sol_p4_1031_\d+_\d+$/)
    expect(db.query.mock.calls.map(([sql]) => sql)).toEqual([
      'SELECT 1 FROM pg_database WHERE datname = $1', `CREATE DATABASE "${AQ_TEST_DB_NAME}"`,
    ])
    expect(new URL(db.create.mock.calls[0]![0] as string).pathname).toBe('/postgres')
  })
  it('propagates migration errors and closes the failed pool without seeding', async () => {
    const failure = new Error('deliberate migration failure')
    db.migrate.mockRejectedValueOnce(failure)
    await expect(prepareAqTestDatabase()).rejects.toBe(failure)
    expect(db.seed).not.toHaveBeenCalled()
    expect(db.end).toHaveBeenCalledTimes(2)
  })
  it('propagates seed/fixture preparation errors instead of returning an empty passing setup', async () => {
    const failure = new Error('deliberate seed failure')
    db.seed.mockRejectedValueOnce(failure)
    await expect(prepareAqTestDatabase()).rejects.toBe(failure)
    expect(db.end).toHaveBeenCalledTimes(2)
  })

})
