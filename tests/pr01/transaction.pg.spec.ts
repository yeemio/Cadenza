import { randomUUID } from 'node:crypto'
import { createPool } from '../../packages/persistence/src/env'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PgCommandBus } from '../../packages/persistence/src/pg-command-bus'
import type { CommandContext, CommandHandler, CommandTools, HandlerOutcome } from '@cadenza/application'
import type { CommandEnvelope } from '@cadenza/contracts'
import type { SqlClient } from '../../packages/persistence/src/sql-client'

// Mandatory real PostgreSQL gate. Never silently skip or default to a shared DB.
const url = process.env['CADENZA_PR01_DB_URL']
if (!url || !/^cadenza_pr01_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) {
  throw new Error('NOT_RUN: CADENZA_PR01_DB_URL must name an isolated cadenza_pr01_* database')
}
const schema = `pr01_${randomUUID().replaceAll('-', '')}`
const admin = createPool(url, { max: 1 })
const scopedUrl = new URL(url)
scopedUrl.searchParams.set('options', `-c search_path=${schema}`)
const pool = createPool(scopedUrl.toString(), { max: 8 })
const context: CommandContext = { enterpriseId: 'enterprise', actorUserId: 'user', actorLoginName: 'user' }
type Tools = CommandTools & { sql: SqlClient; effects: string[] }
let calls = 0
let handle: (tools: Tools, envelope: CommandEnvelope<unknown>) => Promise<HandlerOutcome>
const handler: CommandHandler = { commandType: 'pr01.atomic', handle: async (_e, _c, t) => { calls++; return handle(t as Tools, _e) } }
const bus = new PgCommandBus(pool, [handler], (sql) => {
  const effects: string[] = []
  return { sql, effects, flushEffects: async () => {
    for (const kind of effects) await sql.query('INSERT INTO outbox(kind) VALUES ($1)', [kind])
  } } as unknown as Tools
})
const envelope = (operationId: string = randomUUID()) => ({ operationId, commandType: handler.commandType, targetId: 'x', expectedRevision: 0, payload: { qty: '1.0000' } })
const counts = async () => (await pool.query(`SELECT
  (SELECT count(*)::int FROM business) AS business,
  (SELECT count(*)::int FROM audit) AS audit,
  (SELECT count(*)::int FROM outbox) AS outbox,
  (SELECT count(*)::int FROM inbox) AS inbox,
  (SELECT count(*)::int FROM command_receipt) AS receipts`)).rows[0]
const writes = async (t: Tools) => {
  await t.sql.query("INSERT INTO business(kind) VALUES ('first-axis')")
  await t.sql.query("INSERT INTO audit(kind) VALUES ('posted')")
  t.effects.push('posted')
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`)
  await pool.query(`CREATE TABLE command_receipt (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), enterprise_id text NOT NULL,
    command_type text NOT NULL, operation_id text NOT NULL, payload_digest text NOT NULL,
    status text NOT NULL, result jsonb NOT NULL, created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(), UNIQUE(enterprise_id,command_type,operation_id));
    CREATE TABLE business(id bigserial PRIMARY KEY, kind text);
    CREATE TABLE audit(id bigserial PRIMARY KEY, kind text CHECK(kind <> 'fail'));
    CREATE TABLE outbox(id bigserial PRIMARY KEY, kind text CHECK(kind <> 'fail'));
    CREATE TABLE inbox(id bigserial PRIMARY KEY, kind text);`)
})
beforeEach(async () => { calls = 0; await pool.query('TRUNCATE command_receipt,business,audit,outbox,inbox') })
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end() })

describe('real PG transaction and durable receipt', () => {
  it.each(['BUSINESS_REJECTION', 'VERSION_CONFLICT'] as const)('%s rolls back all writes and replays the refusal', async (status) => {
    handle = async (t) => { await writes(t); return { status, errorCode: 'late', errorMessage: 'second axis refused' } }
    const e = envelope(); const first = await bus.execute(e, context)
    expect(first.status).toBe(status)
    expect(await counts()).toEqual({ business: 0, audit: 0, outbox: 0, inbox: 0, receipts: 1 })
    handle = async () => ({ status: 'COMMITTED' })
    expect(await bus.execute(e, context)).toEqual(first); expect(calls).toBe(1)
  })
  it.each(['COMMITTED', 'DRAFT_SAVED'] as const)('%s commits facts, audit, outbox and receipt together', async (status) => {
    handle = async (t) => { await writes(t); return { status, data: { acceptedRows: [1], refusedRows: [2] } } }
    const e = envelope(); const first = await bus.execute(e, context)
    expect(first.status).toBe(status)
    expect(await counts()).toEqual({ business: 1, audit: 1, outbox: 1, inbox: 0, receipts: 1 })
    // Caller discarded the first response; the original key retrieves the same receipt.
    expect(await bus.execute(e, context)).toEqual(first); expect(calls).toBe(1)
  })
  it('quarantine is explicitly re-established after rollback, exactly once with its refusal', async () => {
    handle = async (t) => {
      await writes(t)
      const diagnostic = async () => { await t.sql.query("INSERT INTO inbox(kind) VALUES ('QUARANTINED')") }
      await diagnostic()
      return { status: 'BUSINESS_REJECTION', persistRejectionDiagnostics: diagnostic }
    }
    const e = envelope(); const first = await bus.execute(e, context)
    expect(await bus.execute(e, context)).toEqual(first)
    expect(await counts()).toEqual({ business: 0, audit: 0, outbox: 0, inbox: 1, receipts: 1 })
    expect(first).not.toHaveProperty('persistRejectionDiagnostics')
  })
  it('concurrent identical keys execute once, changed payload never replaces the result', async () => {
    handle = async (t) => { await t.sql.query('SELECT pg_sleep(0.02)'); await writes(t); return { status: 'COMMITTED', data: { done: true } } }
    const e = envelope(); const results = await Promise.all(Array.from({ length: 8 }, () => bus.execute(e, context)))
    expect(calls).toBe(1); for (const r of results) expect(r).toEqual(results[0])
    const changed = await bus.execute({ ...e, payload: { qty: '2.0000' } }, context)
    expect(changed.errorCode).toBe('ERR_IDEMPOTENT_PAYLOAD_MISMATCH')
    expect(await bus.execute(e, context)).toEqual(results[0]); expect(calls).toBe(1)
  })
  it('concurrent different payloads have one winner and cannot overwrite its receipt', async () => {
    handle = async (t, e) => {
      await t.sql.query('SELECT pg_sleep(0.02)')
      await writes(t)
      return { status: 'COMMITTED', data: e.payload }
    }
    const firstEnvelope = envelope()
    const secondEnvelope = { ...firstEnvelope, payload: { qty: '2.0000' } }
    const results = await Promise.all([bus.execute(firstEnvelope, context), bus.execute(secondEnvelope, context)])
    expect(calls).toBe(1)
    expect(results.filter((r) => r.status === 'COMMITTED')).toHaveLength(1)
    expect(results.filter((r) => r.errorCode === 'ERR_IDEMPOTENT_PAYLOAD_MISMATCH')).toHaveLength(1)
    const winner = results[0]!.status === 'COMMITTED' ? 0 : 1
    expect(await bus.execute([firstEnvelope, secondEnvelope][winner]!, context)).toEqual(results[winner])
    expect(await counts()).toEqual({ business: 1, audit: 1, outbox: 1, inbox: 0, receipts: 1 })
  })
  it('failure while re-establishing quarantine rolls back diagnostics and the receipt', async () => {
    handle = async (t) => {
      await writes(t)
      return { status: 'BUSINESS_REJECTION', persistRejectionDiagnostics: async () => {
        await t.sql.query("INSERT INTO inbox(kind) VALUES ('QUARANTINED')")
        throw new Error('diagnostic storage failed')
      } }
    }
    await expect(bus.execute(envelope(), context)).rejects.toThrow('diagnostic storage failed')
    expect(await counts()).toEqual({ business: 0, audit: 0, outbox: 0, inbox: 0, receipts: 0 })
  })
  it('unawaited repository SQL is drained before committing a successful command', async () => {
    handle = async (t) => {
      void t.sql.query("INSERT INTO audit(kind) SELECT 'queued' FROM pg_sleep(0.02)").catch(() => undefined)
      return { status: 'COMMITTED' }
    }
    expect((await bus.execute(envelope(), context)).status).toBe('COMMITTED')
    expect(await counts()).toEqual({ business: 0, audit: 1, outbox: 0, inbox: 0, receipts: 1 })
  })
  it('exception before commit rolls back everything and leaves the key retryable', async () => {
    handle = async (t) => { await writes(t); throw new Error('quality exception') }
    const e = envelope(); await expect(bus.execute(e, context)).rejects.toThrow('quality exception')
    expect(await counts()).toEqual({ business: 0, audit: 0, outbox: 0, inbox: 0, receipts: 0 })
    handle = async (t) => { await writes(t); return { status: 'COMMITTED' } }
    expect((await bus.execute(e, context)).status).toBe('COMMITTED')
  })
  it('outbox failure rolls back the successful handler and receipt', async () => {
    handle = async (t) => { await writes(t); t.effects.push('fail'); return { status: 'COMMITTED' } }
    await expect(bus.execute(envelope(), context)).rejects.toThrow()
    expect(await counts()).toEqual({ business: 0, audit: 0, outbox: 0, inbox: 0, receipts: 0 })
  })
  it('swallowed audit SQL failure cannot become a committed business refusal', async () => {
    handle = async (t) => {
      await writes(t)
      await t.sql.query("INSERT INTO audit(kind) VALUES ('fail')").catch(() => undefined)
      return { status: 'BUSINESS_REJECTION' }
    }
    await expect(bus.execute(envelope(), context)).rejects.toThrow()
    expect(await counts()).toEqual({ business: 0, audit: 0, outbox: 0, inbox: 0, receipts: 0 })
  })
  it('a captured repository connection refuses all writes after commit', async () => {
    let captured: SqlClient | undefined
    handle = async (t) => { captured = t.sql; return { status: 'COMMITTED' } }
    await bus.execute(envelope(), context)
    await expect(captured!.query("INSERT INTO business(kind) VALUES ('late')")).rejects.toThrow('closed')
    expect((await counts()).business).toBe(0)
  })
})
