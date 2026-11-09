import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExclusiveDatabase } from '../../scripts/delivery/build/exclusive-pg.mjs'

let a: ExclusiveDatabase, b: ExclusiveDatabase
let createExclusiveDatabase: typeof import('../../scripts/delivery/build/exclusive-pg.mjs').createExclusiveDatabase
let resumeExclusiveDatabase: typeof import('../../scripts/delivery/build/exclusive-pg.mjs').resumeExclusiveDatabase
beforeAll(async () => {
  ({ createExclusiveDatabase, resumeExclusiveDatabase } = await import('../../scripts/delivery/build/exclusive-pg.mjs'))
  // Missing explicit authorized admin URL is a setup failure, never a runtime skip.
  a = await createExclusiveDatabase('recon')
  await a.pool.query('CREATE TABLE pr13_sentinel (value text NOT NULL)')
  await a.pool.query('INSERT INTO pr13_sentinel VALUES ($1)', ['A survives creation of B'])
  b = await createExclusiveDatabase('recon')
})
afterAll(async () => { await a?.pool.end(); await b?.pool.end() })
describe('PR13 real PostgreSQL exclusive test infrastructure', () => {
  it('creates different fresh databases without resetting the previous lane', async () => {
    expect(a.database).not.toBe(b.database)
    expect((await a.pool.query('SELECT value FROM pr13_sentinel')).rows).toEqual([{ value: 'A survives creation of B' }])
    expect((await b.pool.query("SELECT to_regclass('public.pr13_sentinel') AS relation")).rows[0].relation).toBeNull()
  })
  it('reads the actual database names and per-run markers from both servers', async () => {
    for (const db of [a, b]) {
      expect((await db.pool.query('SELECT current_database() AS name')).rows[0].name).toBe(db.database)
      expect((await db.pool.query('SELECT run_id, lane FROM cadenza_pr13_test_run')).rows).toEqual([{ run_id: db.runId, lane: 'recon' }])
    }
  })
  it('resumes only a matching run marker with the explicit nonce', async () => {
    const resumed = await resumeExclusiveDatabase(a, { ...process.env, CADENZA_RECON_RESUME_RUN_ID: a.runId })
    try { expect((await resumed.pool.query('SELECT value FROM pr13_sentinel')).rows).toHaveLength(1) }
    finally { await resumed.pool.end() }
  })
  it('rejects a wrong database/run pairing and leaves both databases unchanged', async () => {
    await expect(resumeExclusiveDatabase({ ...b, runId: a.runId }, { ...process.env, CADENZA_RECON_RESUME_RUN_ID: a.runId })).rejects.toThrow('marker does not match')
    expect((await a.pool.query('SELECT value FROM pr13_sentinel')).rows).toHaveLength(1)
    expect((await b.pool.query('SELECT run_id FROM cadenza_pr13_test_run')).rows).toEqual([{ run_id: b.runId }])
  })
})
