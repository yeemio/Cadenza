import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { assertSapSimReferenceData, sha256OfPayload, type SapSimReferenceData } from '@cadenza/domain'
import { SapSimEngineService, SapSimService } from '@cadenza/application'
import { createPool, createPgSapSimFactsRepositories, createPgSapSimRepositories, PgSapSimOutboxReceiptAdapter, migrateUp, migrations } from '@cadenza/persistence'
import { engineDatabaseUrl } from './test-database'
import { loadFrozenReferenceData, readFrozenCsv } from './frozen-reference-data'

const csvDirectory = '/Users/yeemio/AI/gitrep/Cadenza/delivery/company-simulation/group-sap-cn-kr-20261029/CBL01G_SAP_CN_KR_20261029/data/csv'
const evidenceDirectory = resolve(process.cwd(), 'delivery/sol-rework-20261031/sap-engine/r4-rework')
const prefix = `SOL-R4-${Date.now()}`
const observations: unknown[] = []
let pool: pg.Pool
let engine: SapSimEngineService
let service: SapSimService
let facts: ReturnType<typeof createPgSapSimFactsRepositories>
let originalReworkOutbox: string
let originalReworkDigest: string | null

function frozen(id: string): Record<string, unknown> {
  const row = readFrozenCsv(csvDirectory, 'messages').find((r) => r['id'] === `CBL01G-MSG-${id}`)
  if (!row) throw new Error(`Frozen message missing: ${id}`)
  const plant = readFrozenCsv(csvDirectory, 'plants').find((r) => r['id'] === row['plant_id'])!
  return {
    event_key: row['event_key'], topic: row['topic'], organization_code: plant['entity_id'], plant_code: plant['sap_plant'],
    business_key: row['business_key'], source_version: row['source_version'] ? Number(row['source_version']) : null,
    parent_version: row['parent_version'] ? Number(row['parent_version']) : null,
    occurred_at: row['occurred_at'], payload: JSON.parse(row['payload']),
  }
}

async function run(event: Record<string, unknown>) {
  const receipt = await engine.execute(event)
  observations.push({ event, receipt })
  return receipt
}

async function businessSnapshot() {
  const [stock, orders] = await Promise.all([
    pool.query('SELECT * FROM sim_sap_stock ORDER BY id'),
    pool.query('SELECT * FROM sim_sap_order ORDER BY id'),
  ])
  return { stock: stock.rows, orders: orders.rows }
}

async function dispatchFrozen(id: string) {
  const event = frozen(id)
  const delivered = await service.deliverMessage({ source_system: 'SAP_SIM', organization_code: event['organization_code'], plant_code: event['plant_code'],
    external_key: event['event_key'], entity_type: event['topic'], payload: event })
  const receipt = await engine.dispatch(delivered.outbox.eventId)
  const after = await service.getMessage(delivered.outbox.eventId)
  expect(after?.eventId).toBe(delivered.outbox.eventId)
  expect(after?.externalRef).toBe(delivered.outbox.externalRef)
  expect(after?.requestDigest).toBe(delivered.outbox.requestDigest)
  expect(after?.payload['envelope']).toEqual(delivered.outbox.payload['envelope'])
  observations.push({ event, outbox_before: delivered.outbox, receipt, outbox_after: after })
  return { delivered, receipt, after }
}

async function registerCn12(suffix: string, mutate?: (data: SapSimReferenceData) => void) {
  const data = loadFrozenReferenceData(csvDirectory, 'CBL01G-C100', 'CN12')
  data.version += `-ADVERSARIAL-R4-${suffix}`
  mutate?.(data)
  await run({ event_key: `${prefix}-MASTER-${suffix}`, topic: 'MASTER_VERSION_BUNDLE', organization_code: 'CBL01G-C100', plant_code: 'CN12', payload: { reference_data: data } })
  return data
}

beforeAll(async () => {
  pool = createPool(engineDatabaseUrl(), { max: 4 })
  await pool.query('SELECT 1')
  await migrateUp(pool, migrations)
  const repos = createPgSapSimRepositories(pool)
  facts = createPgSapSimFactsRepositories(pool)
  engine = new SapSimEngineService(facts, new PgSapSimOutboxReceiptAdapter(repos.outbox))
  service = new SapSimService(repos, engine)
  for (const [organization, plant] of [['CBL01G-C100', 'CN11'], ['CBL01G-C100', 'CN12'], ['CBL01G-K200', 'KR21'], ['CBL01G-K200', 'KR22']]) {
    await run({ event_key: `${prefix}-MASTER-${plant}`, topic: 'MASTER_VERSION_BUNDLE', organization_code: organization, plant_code: plant,
      payload: { reference_data: loadFrozenReferenceData(csvDirectory, organization, plant) } })
  }
})

afterAll(async () => {
  mkdirSync(evidenceDirectory, { recursive: true })
  writeFileSync(`${evidenceDirectory}/behavior-readback.json`, JSON.stringify({
    event: 'SOL-SAP-ENGINE-1031-R4-REWORK', database: new URL(engineDatabaseUrl()).pathname.slice(1),
    claim_level: 'exact_rejected_source_association_and_explicit_order_identity', observations,
  }, null, 2))
  if (pool) await pool.end()
})

describe('R4 exact rejected REWORK-200 source association', () => {
  it('projects only movement/identity fields and retains the whole inventory/events and entity CSV hashes', () => {
    const data = loadFrozenReferenceData(csvDirectory, 'CBL01G-C100', 'CN12')
    assertSapSimReferenceData(data, 'CBL01G-C100', 'CN12')
    expect(data.tables.inventory_events).toHaveLength(2)
    for (const row of data.tables.inventory_events) {
      expect(Object.keys(row).sort()).toEqual(['id', 'object_id', 'at', 'plant_context_id', 'action', 'delta', 'unit', 'document_id'].sort())
    }
    for (const table of ['inventory_events', 'entities'] as const) {
      expect(data.sources[table].sha256).toBe(createHash('sha256').update(readFileSync(`${csvDirectory}/${table}.csv`)).digest('hex'))
    }
    expect(data.tables.entities.find((row) => row['id'] === 'CBL01G-K200')?.['sap_company_code']).toBe('K200')
  })

  it('keeps the original rejection and quantity facts unchanged while linking only the exact same-document source and target', async () => {
    await run(frozen('REL-G-CN'))
    await run(frozen('BUNDLE-G-CN-FIN'))
    const before = await businessSnapshot()
    expect((await facts.stock.find('CBL01G-C100', 'CN12', 'CBL01G-GC-2', 'm'))?.qty).toBe(2000)
    expect(await facts.stock.find('CBL01G-C100', 'CN12', 'CBL01G-REWORK-200', 'm')).toBeNull()
    const result = await dispatchFrozen('REWORK-200')
    originalReworkOutbox = result.delivered.outbox.eventId
    originalReworkDigest = result.delivered.outbox.requestDigest
    expect(result.receipt.outcome).toBe('REJECTED_MISSING_REWORK_ORDER')
    expect(result.receipt.applied).toBe(false)
    expect(result.receipt.detail).toMatchObject({ source_object_id: 'CBL01G-GC-2', target_object_id: 'CBL01G-REWORK-200',
      material_id: 'CBL01G-F2', basis: 'cable_m', unit: 'm', original_order_id: 'CBL01G-MO-G-CN',
      source_document_id: 'CBL01G-ABN-RW200', derived_association_only: true, target_posting_created: false })
    expect(await businessSnapshot()).toEqual(before)
    expect(await facts.stock.find('CBL01G-C100', 'CN12', 'CBL01G-REWORK-200', 'm')).toBeNull()
    const documents = await facts.documents.findByEventKey(String(frozen('REWORK-200')['event_key']))
    expect(documents).toHaveLength(1)
    expect(documents[0]!.docType).toBe('REJECT_NOTICE')
    expect(documents[0]!.receipt).toMatchObject({ applied: false, source_object_id: 'CBL01G-GC-2', target_object_id: 'CBL01G-REWORK-200' })
    expect(documents[0]!.payload['envelope']).toEqual(frozen('REWORK-200')['payload'])
    const linked = await pool.query("SELECT id FROM sim_sap_document WHERE doc_type='REJECT_NOTICE' AND organization_code=$2 AND plant_code=$3 AND jsonb_path_exists(payload, '$.** ? (@ == $ref)', jsonb_build_object('ref', to_jsonb($1::text)))", ['CBL01G-REWORK-200', 'CBL01G-C100', 'CN12'])
    expect(linked.rows).toHaveLength(1)
    const sibling = await pool.query("SELECT id FROM sim_sap_document WHERE doc_type='REJECT_NOTICE' AND jsonb_path_exists(payload, '$.** ? (@ == $ref)', jsonb_build_object('ref', to_jsonb($1::text)))", ['CBL01G-GC-1'])
    expect(sibling.rows).toHaveLength(0)
    const declared = readFrozenCsv(csvDirectory, 'messages').find((row) => row['id'] === 'CBL01G-MSG-REWORK-200')!['payload_sha256']
    expect(sha256OfPayload(frozen('REWORK-200')['payload'] as Record<string, unknown>)).toBe(declared)
    observations.push({ exact_association_documents: documents, quantity_facts_unchanged: true, original_target_stock_absent: true })
  })

  it('replays the original rejected message without another rejection document, stock or order', async () => {
    const before = await businessSnapshot()
    const receipt = await engine.dispatch(originalReworkOutbox)
    expect(receipt.outcome).toBe('DUPLICATE_RETURN_ORIGINAL')
    expect(receipt.applied).toBe(false)
    expect(await businessSnapshot()).toEqual(before)
    expect(await facts.documents.findByEventKey('CBL01G-EVKEY-MSG-REWORK-200')).toHaveLength(1)
    expect((await service.getMessage(originalReworkOutbox))?.requestDigest).toBe(originalReworkDigest)
  })

  it('does not derive a target from missing, wrong-source, ambiguous, mismatched-quantity or wrong-SKU references', async () => {
    const before = await businessSnapshot()
    const cases: Array<[string, (data: SapSimReferenceData) => void]> = [
      ['MISSING-DST', (data) => { data.tables.inventory_events = data.tables.inventory_events.filter((row) => row['delta'].startsWith('-')) }],
      ['WRONG-SOURCE', (data) => { data.tables.inventory_events.find((row) => row['delta'].startsWith('-'))!['object_id'] = 'CBL01G-GC-1' }],
      ['AMBIGUOUS', (data) => { data.tables.inventory_events.push(...data.tables.inventory_events.map((row) => ({ ...row, id: `${row['id']}-SECOND`, document_id: `${row['document_id']}-SECOND` }))) }],
      ['QTY', (data) => { data.tables.inventory_events.find((row) => !row['delta'].startsWith('-'))!['delta'] = '201.0000' }],
      ['SKU', (data) => { const target = data.tables.stock_objects.find((row) => row['id'] === 'CBL01G-REWORK-200')!; target['material_id'] = 'CBL01G-C40-BL'; target['basis'] = 'core_m' }],
    ]
    for (const [suffix, mutate] of cases) {
      await registerCn12(suffix, mutate)
      const event = { ...frozen('REWORK-200'), event_key: `${prefix}-REWORK-${suffix}` }
      const result = await run(event)
      expect(result.outcome).toBe('REJECTED_MISSING_REWORK_ORDER')
      expect(result.detail['target_object_id']).toBeUndefined()
      const doc = (await facts.documents.findByEventKey(String(event['event_key'])))[0]!
      expect(doc.payload['target_object_id']).toBeUndefined()
      expect(doc.receipt['target_object_id']).toBeUndefined()
      expect(await businessSnapshot()).toEqual(before)
    }
    await registerCn12('RESTORED')
    const sibling = await run({ ...frozen('REWORK-200'), event_key: `${prefix}-SIBLING-PARENT`, business_key: 'CBL01G-GC-1' })
    expect(sibling.detail['target_object_id']).toBeUndefined()
    const wrongQty = await run({ ...frozen('REWORK-200'), event_key: `${prefix}-WRONG-PAYLOAD-QTY`, payload: { deduct_finished_m: 201, add_rework_wip_m: 201, rework_order_id: null } })
    expect(wrongQty.detail['target_object_id']).toBeUndefined()
    expect(await businessSnapshot()).toEqual(before)
  })

  it('rejects wrong-plant/basis, balance fields and ambiguous company aliases before they can become reference facts', async () => {
    const before = await businessSnapshot()
    const cases: Array<[string, (data: SapSimReferenceData) => void]> = [
      ['BAD-PLANT', (data) => { data.tables.inventory_events[0]!['plant_context_id'] = 'CBL01G-KR21' }],
      ['BAD-BASIS', (data) => { data.tables.stock_objects.find((row) => row['id'] === 'CBL01G-REWORK-200')!['basis'] = 'core_m' }],
      ['BALANCE', (data) => { data.tables.inventory_events[0]!['quantity_after'] = '0' }],
      ['COMPANY-AMBIGUOUS', (data) => { data.tables.entities.find((row) => row['id'] === 'CBL01G-C100')!['sap_company_code'] = 'K200' }],
    ]
    for (const [suffix, mutate] of cases) {
      await expect(registerCn12(suffix, mutate)).rejects.toMatchObject({ rule: 'SAP-SIMENG-17' })
      expect(await businessSnapshot()).toEqual(before)
    }
  })
})

describe('R4 explicit release identity before duplicate-version return', () => {
  it('rejects the original frozen COLLISION rather than treating the existing order as a duplicate', async () => {
    await run(frozen('REL-G-KR'))
    const before = await businessSnapshot()
    const result = await dispatchFrozen('COLLISION')
    expect(result.receipt.outcome).toBe('REJECT_ORGANIZATION_MISMATCH')
    expect(result.receipt.applied).toBe(false)
    expect(result.after?.status).toBe('NOOP_NEEDED')
    expect(await businessSnapshot()).toEqual(before)
    const doc = (await facts.documents.findByEventKey('CBL01G-EVKEY-MSG-COLLISION'))[0]!
    expect(doc.payload['envelope']).toEqual(frozen('COLLISION')['payload'])
    observations.push({ frozen_collision_rejection: doc, order_and_stock_unchanged: true })
  })

  it('separately rejects explicit plant/company and parsed-key contradictions or unproven company aliases without stock/order writes', async () => {
    const before = await businessSnapshot()
    const base = frozen('COLLISION')
    const cases: Array<[string, Record<string, unknown>]> = [
      ['PLANT', { payload: { company: 'K200', plant: 'CN11', short_order_no: '00001001', qty: 6000 } }],
      ['COMPANY', { payload: { company: 'C100', plant: 'KR21', short_order_no: '00001001', qty: 6000 } }],
      ['PARSED-PLANT', { business_key: 'SAPSIM|CBL01G-K200|CN11|PRODUCTION|00001001|0010', payload: { company: 'K200', plant: 'KR21', short_order_no: '00001001', qty: 6000 } }],
      ['PARSED-COMPANY', { business_key: 'SAPSIM|CBL01G-C100|KR21|PRODUCTION|00001001|0010', payload: { company: 'K200', plant: 'KR21', short_order_no: '00001001', qty: 6000 } }],
      ['UNKNOWN-COMPANY', { payload: { company: 'UNKNOWN-K200', plant: 'KR21', short_order_no: '00001001', qty: 6000 } }],
    ]
    for (const [suffix, patch] of cases) {
      const result = await run({ ...base, ...patch, event_key: `${prefix}-IDENTITY-${suffix}` })
      expect(result.outcome).toBe('REJECT_ORGANIZATION_MISMATCH')
      expect(await businessSnapshot()).toEqual(before)
    }
  })

  it('uses proven company aliases for a valid existing order and keeps correct original-key replay idempotent', async () => {
    const before = await businessSnapshot()
    const payload = { company: 'K200', plant: 'KR21', short_order_no: '00001001', qty: 6000 }
    const fullEnvelope = await run({ ...frozen('COLLISION'), event_key: `${prefix}-VALID-ALIAS`, payload })
    expect(fullEnvelope.outcome).toBe('DUPLICATE_SAME_HASH_NOOP')
    const shortEnvelope = await run({ ...frozen('COLLISION'), event_key: `${prefix}-VALID-SHORT-ENVELOPE`, organization_code: 'K200', payload })
    expect(shortEnvelope.outcome).toBe('DUPLICATE_SAME_HASH_NOOP')
    expect((await run(frozen('REL-G-KR'))).outcome).toBe('DUPLICATE_SAME_HASH_NOOP')
    expect(await businessSnapshot()).toEqual(before)
    const fork = await pool.query("SELECT id FROM sim_sap_order WHERE organization_code='K200'")
    expect(fork.rows).toHaveLength(0)
  })

  it('allows the same short order number in two legitimate factories', async () => {
    const orderNo = `${prefix}-SAME-SHORT`
    for (const plant of ['CN11', 'CN12']) {
      const result = await run({ event_key: `${prefix}-LEGAL-${plant}`, topic: 'PRODUCTION_RELEASE', organization_code: 'CBL01G-C100', plant_code: plant,
        business_key: `SAPSIM|C100|${plant}|PRODUCTION|${orderNo}|0010`, source_version: 1,
        payload: { company: 'C100', plant, short_order_no: orderNo, qty: 10, unit: 'm', material_id: 'CBL01G-F2' } })
      expect(result.outcome).toBe('APPLIED_ONCE')
    }
    const records = await pool.query('SELECT organization_code, plant_code, order_no FROM sim_sap_order WHERE order_no=$1 ORDER BY plant_code', [orderNo])
    expect(records.rows).toEqual([
      { organization_code: 'CBL01G-C100', plant_code: 'CN11', order_no: orderNo },
      { organization_code: 'CBL01G-C100', plant_code: 'CN12', order_no: orderNo },
    ])
  })
})
