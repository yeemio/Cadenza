import { frozenCsvDirectory } from './frozen-reference-data'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { SapSimEngineService, SapSimService, type SapSimFactsRepositories } from '@cadenza/application'
import { createPool, createPgSapSimFactsRepositories, createPgSapSimRepositories, PgSapSimOutboxReceiptAdapter, migrateUp, migrations } from '@cadenza/persistence'
import { engineDatabaseUrl, prepareEngineDatabase } from './test-database'
import { loadFrozenReferenceData, readFrozenCsv } from './frozen-reference-data'

const csvDirectory = frozenCsvDirectory()
const evidenceDirectory = resolve(process.cwd(), 'delivery/sol-rework-20261031/sap-engine/r2-custody')
const prefix = `SOL-R2-CUSTODY-${Date.now()}`
const observations: unknown[] = []
let pool: pg.Pool
let engine: SapSimEngineService
let service: SapSimService
let facts: SapSimFactsRepositories
let originalOutboxId: string
let originalDigest: string | null

function frozen(id: string): Record<string, unknown> {
  const row = readFrozenCsv(csvDirectory, 'messages').find((r) => r['id'] === `CBL01G-MSG-${id}`)
  if (!row) throw new Error(`Frozen message missing: ${id}`)
  return {
    event_key: row['event_key'], topic: row['topic'], organization_code: 'CBL01G-K200', plant_code: 'KR21',
    business_key: row['business_key'], source_version: row['source_version'] ? Number(row['source_version']) : null,
    parent_version: row['parent_version'] ? Number(row['parent_version']) : null,
    occurred_at: row['occurred_at'], payload: JSON.parse(row['payload']),
  }
}

const probe = (suffix: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({ ...frozen('SCRAP-100'), event_key: `${prefix}-${suffix}`, ...patch })

async function run(event: Record<string, unknown>) {
  const receipt = await engine.execute(event)
  observations.push({ event, receipt })
  return receipt
}

async function businessSnapshot() {
  const stocks = await pool.query('SELECT organization_code, plant_code, material_id, unit, qty FROM sim_sap_stock ORDER BY organization_code, plant_code, material_id, unit')
  const documents = await pool.query("SELECT id, source_event_key, payload, receipt FROM sim_sap_document WHERE doc_type='SCRAP_CONFIRM' ORDER BY created_at, id")
  return { stocks: stocks.rows, documents: documents.rows }
}

beforeAll(async () => {
  pool = createPool(await prepareEngineDatabase(), { max: 4 })
  await pool.query('SELECT 1')
  await migrateUp(pool, migrations)
  // This suite never truncates or resets a database. Its runner creates a fresh assignment-owned database.
  const repos = createPgSapSimRepositories(pool)
  facts = createPgSapSimFactsRepositories(pool)
  engine = new SapSimEngineService(facts, new PgSapSimOutboxReceiptAdapter(repos.outbox))
  service = new SapSimService(repos, engine)
  await run({ event_key: `${prefix}-MASTER-KR21`, topic: 'MASTER_VERSION_BUNDLE', organization_code: 'CBL01G-K200', plant_code: 'KR21',
    payload: { reference_data: loadFrozenReferenceData(csvDirectory, 'CBL01G-K200', 'KR21') } })
})

afterAll(async () => {
  if (pool) {
    observations.push({ final_business_snapshot: await businessSnapshot(), custody_outcomes: await facts?.outcomes.listByEventKey('CBL01G-EVKEY-MSG-SCRAP-100') })
    mkdirSync(evidenceDirectory, { recursive: true })
    writeFileSync(`${evidenceDirectory}/behavior-readback.json`, JSON.stringify({
      assignment_event: 'SOL-SAP-ENGINE-1031-R2-CUSTODY', database: new URL(engineDatabaseUrl()).pathname.slice(1),
      claim_level: 'scoped_simulator_custody_regression', csvDirectory, observations,
    }, null, 2))
    await pool.end()
  }
})

describe('R2-CUSTODY source-to-custody accounting scrap', () => {
  it('a catalog reference without a real source balance refuses with zero business writes', async () => {
    const before = await businessSnapshot()
    const result = await run(probe('SOURCE-ABSENT'))
    expect(result.outcome).toBe('REJECTED_INSUFFICIENT_STOCK')
    expect(result.applied).toBe(false)
    expect(await businessSnapshot()).toEqual(before)
  })

  it('the exact original scrap event moves source quantity into physical custody and retains the original message identity', async () => {
    for (const id of ['REL-G-KR', 'REV2-G-KR', 'REV3-G-KR', 'BUNDLE-G-KR-FIN']) await run(frozen(id))
    const event = frozen('SCRAP-100')
    const originalPayload = event['payload'] as Record<string, unknown>
    const qty = Number(originalPayload['qty'])
    const sourceBefore = await facts.stock.find('CBL01G-K200', 'KR21', 'CBL01G-GK-2', 'm')
    const custodyBefore = await facts.stock.find('CBL01G-K200', 'KR21', 'CBL01G-FGSCRAP-100', 'm')
    expect(sourceBefore!.qty).toBeGreaterThan(qty)
    expect(custodyBefore).toBeNull()
    const delivered = await service.deliverMessage({ source_system: 'SAP_SIM', organization_code: 'CBL01G-K200', plant_code: 'KR21',
      external_key: event['event_key'], entity_type: event['topic'], payload: event })
    originalOutboxId = delivered.outbox.eventId
    originalDigest = delivered.outbox.requestDigest
    const receipt = await engine.dispatch(originalOutboxId)
    expect(receipt.outcome).toBe('CONFIRMED')
    expect(receipt.detail).toMatchObject({ source_object_id: 'CBL01G-GK-2', custody_object_id: 'CBL01G-FGSCRAP-100',
      sku_material_id: 'CBL01G-F2', basis: 'cable_m', physical_retained: true, physical_disposed: false })
    const sourceAfter = await facts.stock.find('CBL01G-K200', 'KR21', 'CBL01G-GK-2', 'm')
    const custodyAfter = await facts.stock.find('CBL01G-K200', 'KR21', 'CBL01G-FGSCRAP-100', 'm')
    expect(sourceAfter!.qty).toBe(sourceBefore!.qty - qty)
    expect(custodyAfter!.qty).toBe(qty)
    expect(sourceAfter!.qty + custodyAfter!.qty).toBe(sourceBefore!.qty)
    const documents = await facts.documents.findByEventKey(String(event['event_key']))
    expect(documents).toHaveLength(1)
    expect(documents[0]!.payload['envelope']).toEqual(originalPayload)
    expect(documents[0]!.payload['quantity_effects']).toEqual([{ object_id: 'CBL01G-GK-2', delta: -qty }, { object_id: 'CBL01G-FGSCRAP-100', delta: qty }])
    expect(documents[0]!.receipt['physical_retained']).toBe(true)
    const outbox = await service.getMessage(originalOutboxId)
    expect(outbox).toMatchObject({ eventId: originalOutboxId, requestDigest: originalDigest,
      externalRef: event['event_key'], status: 'DISPATCHED' })
    expect(outbox?.payload['envelope']).toEqual(delivered.outbox.payload['envelope'])
    observations.push({ event, before: { source: sourceBefore, custody: custodyBefore }, receipt,
      after: { source: sourceAfter, custody: custodyAfter }, documents, outbox })
  })

  it('same-key concurrent redelivery returns the original document without a second transfer or changed digest', async () => {
    const before = await businessSnapshot()
    const results = await Promise.all([engine.dispatch(originalOutboxId), engine.dispatch(originalOutboxId)])
    expect(results.map((r) => r.outcome)).toEqual(['DUPLICATE_RETURN_ORIGINAL', 'DUPLICATE_RETURN_ORIGINAL'])
    expect(results[0]!.doc_no).toBe(results[1]!.doc_no)
    expect(await businessSnapshot()).toEqual(before)
    expect((await service.getMessage(originalOutboxId))?.requestDigest).toBe(originalDigest)
    await expect(engine.execute({ ...frozen('SCRAP-100'), payload: { qty: 101, unit: 'm', custody_object_id: 'CBL01G-FGSCRAP-100' } })).rejects.toMatchObject({ rule: 'SAP-SIMENG-8' })
    expect(await businessSnapshot()).toEqual(before)
    observations.push({ redelivery: results })
  })

  it('missing source, self-custody, wrong SKU/basis/factory and insufficient real source refuse with zero business writes', async () => {
    const before = await businessSnapshot()
    for (const [suffix, patch] of [
      ['NO-SOURCE-KEY', { business_key: null }],
      ['SELF', { business_key: 'CBL01G-FGSCRAP-100' }],
      ['WRONG-SKU', { business_key: 'CBL01G-C40-BL' }],
      ['WRONG-BASIS', { payload: { qty: 1, unit: 'm', basis: 'core_m', custody_object_id: 'CBL01G-FGSCRAP-100' } }],
      ['WRONG-CUSTODY-FACTORY', { payload: { qty: 1, unit: 'm', custody_object_id: 'CBL01G-REWORK-200' } }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await run(probe(suffix, patch))
      expect(result.outcome).toBe('REJECT_NOTICE')
      expect(result.detail['no_business_writes']).toBe(true)
      expect(await businessSnapshot()).toEqual(before)
    }
    const source = await facts.stock.find('CBL01G-K200', 'KR21', 'CBL01G-GK-2', 'm')
    const excessive = await run(probe('INSUFFICIENT', { payload: { qty: source!.qty + 1, unit: 'm', custody_object_id: 'CBL01G-FGSCRAP-100' } }))
    expect(excessive.outcome).toBe('REJECTED_INSUFFICIENT_STOCK')
    await expect(engine.execute(probe('WRONG-ORG', { organization_code: 'CBL01G-C100' }))).rejects.toMatchObject({ rule: 'SAP-SIMENG-17' })
    await expect(engine.execute(probe('WRONG-PLANT', { plant_code: 'KR22' }))).rejects.toMatchObject({ rule: 'SAP-SIMENG-17' })
    expect(await businessSnapshot()).toEqual(before)
  })

  it('a document failure rolls back both stock movements and the event outcome', async () => {
    const before = await businessSnapshot()
    const failingFacts: SapSimFactsRepositories = { ...facts,
      runInEventTransaction: <T>(key: string, work: (tx: SapSimFactsRepositories) => Promise<T>) =>
        facts.runInEventTransaction(key, (tx) => work({ ...tx, documents: new Proxy(tx.documents, {
          get(target, property, receiver) {
            if (property === 'insert') return async () => { throw new Error('Injected custody document failure') }
            const value = Reflect.get(target, property, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }) })),
    }
    const repos = createPgSapSimRepositories(pool)
    const failingEngine = new SapSimEngineService(failingFacts, new PgSapSimOutboxReceiptAdapter(repos.outbox))
    const event = probe('ROLLBACK', { business_key: 'CBL01G-GK-1', payload: { qty: 50, unit: 'm', custody_object_id: 'CBL01G-FGSCRAP-100' } })
    await expect(failingEngine.execute(event)).rejects.toThrow('Injected custody document failure')
    expect(await businessSnapshot()).toEqual(before)
    expect(await facts.outcomes.listByEventKey(String(event['event_key']))).toHaveLength(0)
    observations.push({ rollback_probe: event, business_state_unchanged: true, outcome_absent: true })
  })

  it('ordinary direct scrap keeps its existing decrement-only branch without altering custody stock', async () => {
    const sourceBefore = await facts.stock.find('CBL01G-K200', 'KR21', 'CBL01G-GK-1', 'm')
    const custodyBefore = await facts.stock.find('CBL01G-K200', 'KR21', 'CBL01G-FGSCRAP-100', 'm')
    const event = probe('DIRECT', { business_key: 'CBL01G-GK-1', payload: { qty: 7, unit: 'm', material_id: 'CBL01G-GK-1' } })
    expect((await run(event)).outcome).toBe('CONFIRMED')
    expect((await facts.stock.find('CBL01G-K200', 'KR21', 'CBL01G-GK-1', 'm'))!.qty).toBe(sourceBefore!.qty - 7)
    expect(await facts.stock.find('CBL01G-K200', 'KR21', 'CBL01G-FGSCRAP-100', 'm')).toEqual(custodyBefore)
    expect((await facts.documents.findByEventKey(String(event['event_key'])))[0]!.payload['envelope']).toEqual(event['payload'])
  })
})
