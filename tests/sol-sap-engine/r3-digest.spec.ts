import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { sha256OfPayload } from '@cadenza/domain'
import { SapSimEngineService, SapSimService } from '@cadenza/application'
import { createPool, createPgSapSimFactsRepositories, createPgSapSimRepositories, PgSapSimOutboxReceiptAdapter, migrateUp, migrations } from '@cadenza/persistence'
import { engineDatabaseUrl } from './test-database'
import { readFrozenCsv } from './frozen-reference-data'

const csvDirectory = '/Users/yeemio/AI/gitrep/Cadenza/delivery/company-simulation/group-sap-cn-kr-20261029/CBL01G_SAP_CN_KR_20261029/data/csv'
const evidenceDirectory = resolve(process.cwd(), 'delivery/sol-rework-20261031/sap-engine/r3-digest')
const observations: unknown[] = []
let pool: pg.Pool
let engine: SapSimEngineService
let service: SapSimService

function frozenN1(id: string): Record<string, unknown> {
  const row = readFrozenCsv(csvDirectory, 'messages').find((r) => r['id'] === `CBL01G-MSG-${id}`)
  if (!row) throw new Error(`Frozen message missing: ${id}`)
  return {
    event_key: row['event_key'], topic: row['topic'], organization_code: 'CBL01G-C100', plant_code: 'CN11',
    business_key: row['business_key'], source_version: row['source_version'] ? Number(row['source_version']) : null,
    parent_version: row['parent_version'] ? Number(row['parent_version']) : null,
    occurred_at: row['occurred_at'], payload: JSON.parse(row['payload']),
  }
}

async function factSnapshot() {
  const [stock, documents, orders, outcomes] = await Promise.all([
    pool.query('SELECT * FROM sim_sap_stock ORDER BY id'),
    pool.query('SELECT * FROM sim_sap_document ORDER BY id'),
    pool.query('SELECT * FROM sim_sap_order ORDER BY id'),
    pool.query('SELECT * FROM sim_sap_event_outcome ORDER BY id'),
  ])
  return { stock: stock.rows, documents: documents.rows, orders: orders.rows, outcomes: outcomes.rows }
}

beforeAll(async () => {
  pool = createPool(engineDatabaseUrl(), { max: 4 })
  await pool.query('SELECT 1')
  await migrateUp(pool, migrations)
  const repos = createPgSapSimRepositories(pool)
  engine = new SapSimEngineService(createPgSapSimFactsRepositories(pool), new PgSapSimOutboxReceiptAdapter(repos.outbox))
  service = new SapSimService(repos, engine)
})

afterAll(async () => {
  mkdirSync(evidenceDirectory, { recursive: true })
  writeFileSync(`${evidenceDirectory}/engine-readback.json`, JSON.stringify({
    event: 'SOL-SAP-ENGINE-1031-R3-DIGEST', database: new URL(engineDatabaseUrl()).pathname.slice(1),
    claim_level: 'canonical_payload_digest_and_actual_simulator_idempotency', observations,
  }, null, 2))
  if (pool) await pool.end()
})

describe('R3-DIGEST recursive payload identity', () => {
  it('matches all 56 original frozen declared payload digests without modifying the input', () => {
    const rows = readFrozenCsv(csvDirectory, 'messages')
    const comparison = rows.map((row) => {
      const calculated = sha256OfPayload(JSON.parse(row['payload']))
      return { message_id: row['id'], event_key: row['event_key'], declared_sha256: row['payload_sha256'], calculated_sha256: calculated, match: calculated === row['payload_sha256'] }
    })
    mkdirSync(evidenceDirectory, { recursive: true })
    writeFileSync(`${evidenceDirectory}/frozen-56-comparison.json`, JSON.stringify({
      source: `${csvDirectory}/messages.csv`, total: comparison.length, matched: comparison.filter((row) => row.match).length, comparison,
    }, null, 2))
    expect(comparison).toHaveLength(56)
    expect(comparison.filter((row) => !row.match)).toEqual([])
  })

  it('does not collide on nested changes and is stable under recursive object-key reordering', () => {
    const original = { lines: [{ material: 'RAW', qty: 4, details: { basis: 'kg', batch: { year: 2026, code: 'B1' } } }], order: { version: 1, id: 'ORDER' } }
    const reordered = { order: { id: 'ORDER', version: 1 }, lines: [{ details: { batch: { code: 'B1', year: 2026 }, basis: 'kg' }, qty: 4, material: 'RAW' }] }
    const tampered = structuredClone(original)
    tampered.lines[0]!.qty = 5
    expect(sha256OfPayload(original)).toBe(sha256OfPayload(reordered))
    expect(sha256OfPayload(original)).not.toBe(sha256OfPayload(tampered))
    expect(original.lines[0]!.qty).toBe(4)
  })

  it('preserves array order and JSON scalar values in the canonical digest', () => {
    const payload = { z: null, a: [{ z: 2, a: '2' }, null, false, 1, '1'] }
    const canonical = '{"a":[{"a":"2","z":2},null,false,1,"1"],"z":null}'
    expect(sha256OfPayload(payload)).toBe(createHash('sha256').update(canonical).digest('hex'))
    expect(sha256OfPayload({ lines: [{ qty: 1 }, { qty: 2 }] })).not.toBe(sha256OfPayload({ lines: [{ qty: 2 }, { qty: 1 }] }))
  })

  it('actual engine rejects same-key nested quantity tampering with zero facts written and accepts correct original-key replay', async () => {
    await engine.execute(frozenN1('REL-N1'))
    const event = frozenN1('N1-GI')
    const delivered = await service.deliverMessage({ source_system: 'SAP_SIM', organization_code: event['organization_code'], plant_code: event['plant_code'],
      external_key: event['event_key'], entity_type: event['topic'], payload: event })
    const first = await engine.dispatch(delivered.outbox.eventId)
    expect(first.outcome).toBe('CONFIRMED')
    const before = await factSnapshot()
    const tamperedPayload = structuredClone(event['payload']) as Record<string, unknown>
    const tamperedLines = tamperedPayload['lines'] as Array<Record<string, unknown>>
    tamperedLines[0]!['qty'] = Number(tamperedLines[0]!['qty']) + 1
    await expect(engine.execute({ ...event, payload: tamperedPayload })).rejects.toMatchObject({ rule: 'SAP-SIMENG-8' })
    expect(await factSnapshot()).toEqual(before)
    const originalPayload = event['payload'] as Record<string, unknown>
    const originalLines = originalPayload['lines'] as Array<Record<string, unknown>>
    const reorderedPayload = { lines: originalLines.map((line) => ({ unit: line['unit'], qty: line['qty'], material: line['material'] })), order_id: originalPayload['order_id'] }
    const reorderedReplay = await engine.execute({ ...event, payload: reorderedPayload })
    expect(reorderedReplay.outcome).toBe('DUPLICATE_RETURN_ORIGINAL')
    expect(reorderedReplay.doc_no).toBe(first.doc_no)
    const originalReplay = await engine.dispatch(delivered.outbox.eventId)
    expect(originalReplay.outcome).toBe('DUPLICATE_RETURN_ORIGINAL')
    expect(originalReplay.doc_no).toBe(first.doc_no)
    const afterReplay = await factSnapshot()
    expect(afterReplay.stock).toEqual(before.stock)
    expect(afterReplay.documents).toEqual(before.documents)
    expect(afterReplay.orders).toEqual(before.orders)
    const updated = await service.getMessage(delivered.outbox.eventId)
    expect(updated).toMatchObject({ eventId: delivered.outbox.eventId, requestDigest: delivered.outbox.requestDigest,
      externalRef: delivered.outbox.externalRef, status: 'DISPATCHED' })
    expect(updated?.payload['envelope']).toEqual(delivered.outbox.payload['envelope'])
    observations.push({ event, first, before, tampered_payload: tamperedPayload, tamper_rejection: 'SAP-SIMENG-8', facts_unchanged_after_tamper: true,
      reordered_replay: reorderedReplay, original_replay: originalReplay, after_replay: afterReplay, original_outbox: delivered.outbox, updated_outbox: updated })
  })
})
