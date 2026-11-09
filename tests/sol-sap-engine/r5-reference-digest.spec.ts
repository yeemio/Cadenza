import { frozenCsvDirectory } from './frozen-reference-data'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { assertSapSimReferenceData, sha256OfSapSimReferenceData, type SapSimReferenceData } from '@cadenza/domain'
import { SapSimEngineService, SapSimService } from '@cadenza/application'
import { createPool, createPgSapSimFactsRepositories, createPgSapSimRepositories, PgSapSimOutboxReceiptAdapter, migrateUp, migrations } from '@cadenza/persistence'
import { engineDatabaseUrl, prepareEngineDatabase } from './test-database'
import { loadFrozenReferenceData, readFrozenCsv } from './frozen-reference-data'

const csvDirectory = frozenCsvDirectory()
const evidenceDirectory = resolve(process.cwd(), 'delivery/sol-rework-20261031/sap-engine/r5-reference-digest')
const prefix = `SOL-R5-REFERENCE-${Date.now()}`
const observations: unknown[] = []
let pool: pg.Pool
let engine: SapSimEngineService
let service: SapSimService
let facts: ReturnType<typeof createPgSapSimFactsRepositories>
let reference: SapSimReferenceData
let canonicalDigest: string
let activeMasterEventKey: string

function reorderObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderObjectKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorderObjectKeys(child)]))
  }
  return value
}

const masterEvent = (key: string, data: SapSimReferenceData): Record<string, unknown> => ({
  event_key: key, topic: 'MASTER_VERSION_BUNDLE', organization_code: 'CBL01G-C100', plant_code: 'CN12',
  payload: { reference_data: data },
})

function frozen(id: string): Record<string, unknown> {
  const row = readFrozenCsv(csvDirectory, 'messages').find((r) => r['id'] === `CBL01G-MSG-${id}`)
  if (!row) throw new Error(`Frozen message missing: ${id}`)
  return { event_key: row['event_key'], topic: row['topic'], organization_code: 'CBL01G-C100', plant_code: 'CN12',
    business_key: row['business_key'], source_version: row['source_version'] ? Number(row['source_version']) : null,
    parent_version: row['parent_version'] ? Number(row['parent_version']) : null,
    occurred_at: row['occurred_at'], payload: JSON.parse(row['payload']) }
}

async function factSnapshot() {
  const [stock, orders, documents, outcomes] = await Promise.all([
    pool.query('SELECT * FROM sim_sap_stock ORDER BY id'),
    pool.query('SELECT * FROM sim_sap_order ORDER BY id'),
    pool.query('SELECT * FROM sim_sap_document ORDER BY id'),
    pool.query('SELECT * FROM sim_sap_event_outcome ORDER BY id'),
  ])
  return { stock: stock.rows, orders: orders.rows, documents: documents.rows, outcomes: outcomes.rows }
}

beforeAll(async () => {
  pool = createPool(await prepareEngineDatabase(), { max: 4 })
  await pool.query('SELECT 1')
  await migrateUp(pool, migrations)
  const repos = createPgSapSimRepositories(pool)
  facts = createPgSapSimFactsRepositories(pool)
  engine = new SapSimEngineService(facts, new PgSapSimOutboxReceiptAdapter(repos.outbox))
  service = new SapSimService(repos, engine)
  reference = loadFrozenReferenceData(csvDirectory, 'CBL01G-C100', 'CN12')
  canonicalDigest = sha256OfSapSimReferenceData(reference)
})

afterAll(async () => {
  mkdirSync(evidenceDirectory, { recursive: true })
  writeFileSync(`${evidenceDirectory}/jsonb-and-trace-readback.json`, JSON.stringify({
    event: 'SOL-SAP-ENGINE-1031-R5-REFERENCE-DIGEST', database: new URL(engineDatabaseUrl()).pathname.slice(1),
    claim_level: 'actual_master_jsonb_digest_and_subsequent_rework_trace', observations,
  }, null, 2))
  if (pool) await pool.end()
})

describe('R5 canonical reference digest across PostgreSQL JSONB', () => {
  it('stores the input canonical digest and recomputes the same digest from an actually reordered JSONB readback', async () => {
    activeMasterEventKey = `${prefix}-MASTER`
    const result = await engine.execute(masterEvent(activeMasterEventKey, reference))
    expect(result.outcome).toBe('APPLIED')
    const master = (await facts.documents.findByEventKey(activeMasterEventKey))[0]!
    const readback = master.payload['reference_data'] as SapSimReferenceData
    expect(readback).toEqual(reference)
    expect(JSON.stringify(readback)).not.toBe(JSON.stringify(reference))
    expect(master.payload['reference_data_sha256']).toBe(canonicalDigest)
    expect(sha256OfSapSimReferenceData(readback)).toBe(canonicalDigest)
    observations.push({ input_digest: canonicalDigest, stored_master: master, recomputed_jsonb_digest: sha256OfSapSimReferenceData(readback),
      jsonb_object_field_order_actually_changed: true })
  })

  it('accepts the same version with recursively reordered fields while preserving arrays and scalar values', async () => {
    const reordered = reorderObjectKeys(reference) as SapSimReferenceData
    expect(reordered).toEqual(reference)
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(reference))
    expect(sha256OfSapSimReferenceData(reordered)).toBe(canonicalDigest)
    const before = await factSnapshot()
    activeMasterEventKey = `${prefix}-MASTER-REORDERED`
    const receipt = await engine.execute(masterEvent(activeMasterEventKey, reordered))
    expect(receipt.outcome).toBe('APPLIED')
    const after = await factSnapshot()
    expect(after.stock).toEqual(before.stock)
    expect(after.orders).toEqual(before.orders)
    const master = (await facts.documents.findByEventKey(activeMasterEventKey))[0]!
    expect(master.payload['reference_data_sha256']).toBe(canonicalDigest)
    expect(sha256OfSapSimReferenceData(master.payload['reference_data'] as SapSimReferenceData)).toBe(canonicalDigest)
    const arrayReordered = structuredClone(reference)
    arrayReordered.tables.inventory_events.reverse()
    expect(sha256OfSapSimReferenceData(arrayReordered)).not.toBe(canonicalDigest)
    observations.push({ reordered_master_receipt: receipt, stored_reordered_master: master, array_order_preserved_in_digest: true })
  })

  it('rejects a real same-version content change and leaves every stock/order/document/outcome fact unchanged', async () => {
    const changed = structuredClone(reference)
    changed.tables.inventory_events[0]!['delta'] = String(Number(changed.tables.inventory_events[0]!['delta']) - 1)
    assertSapSimReferenceData(changed, 'CBL01G-C100', 'CN12')
    expect(sha256OfSapSimReferenceData(changed)).not.toBe(canonicalDigest)
    const before = await factSnapshot()
    try {
      await engine.execute(masterEvent(`${prefix}-MASTER-REAL-CHANGE`, changed))
      throw new Error('Expected same-version reference replacement refusal')
    } catch (error) {
      expect(error).toMatchObject({ rule: 'SAP-SIMENG-17' })
      observations.push({ changed_digest: sha256OfSapSimReferenceData(changed), actual_rejection: String(error), no_fact_writes: true })
    }
    expect(await factSnapshot()).toEqual(before)
  })

  it('uses the same stored master digest and master key in a real subsequent original REWORK rejection', async () => {
    await engine.execute(frozen('REL-G-CN'))
    await engine.execute(frozen('BUNDLE-G-CN-FIN'))
    const before = await factSnapshot()
    const event = frozen('REWORK-200')
    const delivered = await service.deliverMessage({ source_system: 'SAP_SIM', organization_code: 'CBL01G-C100', plant_code: 'CN12',
      external_key: event['event_key'], entity_type: event['topic'], payload: event })
    const receipt = await engine.dispatch(delivered.outbox.eventId)
    expect(receipt.outcome).toBe('REJECTED_MISSING_REWORK_ORDER')
    expect(receipt.applied).toBe(false)
    expect(receipt.detail).toMatchObject({ reference_master_event_key: activeMasterEventKey, reference_data_sha256: canonicalDigest,
      source_object_id: 'CBL01G-GC-2', target_object_id: 'CBL01G-REWORK-200' })
    const master = (await facts.documents.findByEventKey(activeMasterEventKey))[0]!
    const reject = (await facts.documents.findByEventKey(String(event['event_key'])))[0]!
    expect(reject.payload['reference_master_event_key']).toBe(master.sourceEventKey)
    expect(reject.payload['reference_data_sha256']).toBe(master.payload['reference_data_sha256'])
    expect(reject.receipt['reference_data_sha256']).toBe(master.payload['reference_data_sha256'])
    expect(sha256OfSapSimReferenceData(master.payload['reference_data'] as SapSimReferenceData)).toBe(master.payload['reference_data_sha256'])
    const after = await factSnapshot()
    expect(after.stock).toEqual(before.stock)
    expect(after.orders).toEqual(before.orders)
    const updated = await service.getMessage(delivered.outbox.eventId)
    expect(updated?.requestDigest).toBe(delivered.outbox.requestDigest)
    expect(updated?.externalRef).toBe(delivered.outbox.externalRef)
    expect(updated?.payload['envelope']).toEqual(delivered.outbox.payload['envelope'])
    observations.push({ event, receipt, actual_master: master, actual_rejection: reject, quantity_facts_unchanged: true,
      outbox_before: delivered.outbox, outbox_after: updated })
  })
})
