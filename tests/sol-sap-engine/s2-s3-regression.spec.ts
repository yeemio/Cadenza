import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { assertSapSimReferenceData } from '@cadenza/domain'
import { SapSimEngineService, SapSimService } from '@cadenza/application'
import { createPool, createPgSapSimFactsRepositories, createPgSapSimRepositories, PgSapSimOutboxReceiptAdapter, migrateUp, migrations } from '@cadenza/persistence'
import { engineDatabaseUrl } from './test-database'
import { loadFrozenReferenceData, readFrozenCsv } from './frozen-reference-data'

const csvDirectory = '/Users/yeemio/AI/gitrep/Cadenza/delivery/company-simulation/group-sap-cn-kr-20261029/CBL01G_SAP_CN_KR_20261029/data/csv'
const evidenceDirectory = resolve(process.cwd(), 'delivery/sol-rework-20261031/sap-engine')
const observations: unknown[] = []
let pool: pg.Pool
let engine: SapSimEngineService
let service: SapSimService
let facts: ReturnType<typeof createPgSapSimFactsRepositories>

async function run(event: Record<string, unknown>) {
  const receipt = await engine.execute(event)
  observations.push({ event, receipt })
  return receipt
}

const synthetic = (key: string, topic: string, order: string, payload: Record<string, unknown>, version?: number, parent?: number) => ({
  event_key: `SOL-${key}`, topic, organization_code: 'SOL-S2', plant_code: 'SOL-P1',
  business_key: `SAPSIM|SOL-S2|SOL-P1|PRODUCTION|${order}|0010`, payload,
  ...(version ? { source_version: version } : {}), ...(parent ? { parent_version: parent } : {}),
})

function frozen(id: string): Record<string, unknown> {
  const row = readFrozenCsv(csvDirectory, 'messages').find((r) => r['id'] === `CBL01G-MSG-${id}`)
  if (!row) throw new Error(`Frozen message missing: ${id}`)
  const plant = readFrozenCsv(csvDirectory, 'plants').find((r) => r['id'] === row['plant_id'])
  if (!plant) throw new Error('Frozen plant missing')
  return {
    event_key: row['event_key'], topic: row['topic'], organization_code: plant['entity_id'], plant_code: plant['sap_plant'],
    business_key: row['business_key'], source_version: row['source_version'] ? Number(row['source_version']) : null,
    parent_version: row['parent_version'] ? Number(row['parent_version']) : null,
    occurred_at: row['occurred_at'], payload: JSON.parse(row['payload']),
  }
}

async function dispatchFrozen(id: string) {
  const event = frozen(id)
  const delivered = await service.deliverMessage({
    source_system: 'SAP_SIM', organization_code: event['organization_code'], plant_code: event['plant_code'],
    external_key: event['event_key'], entity_type: event['topic'], payload: event,
  })
  const before = delivered.outbox
  const receipt = await engine.dispatch(before.eventId)
  const after = await service.getMessage(before.eventId)
  expect(after?.eventId).toBe(before.eventId)
  expect(after?.requestDigest).toBe(before.requestDigest)
  expect(after?.externalRef).toBe(before.externalRef)
  expect(after?.status).toBe('DISPATCHED')
  expect(after?.payload['envelope']).toEqual(before.payload['envelope'])
  observations.push({ event, before, receipt, after })
  return receipt
}

beforeAll(async () => {
  pool = createPool(engineDatabaseUrl(), { max: 4 })
  await pool.query('SELECT 1')
  await migrateUp(pool, migrations)
  // The guard above is mandatory before the assignment-owned fixture can be cleared.
  await pool.query('TRUNCATE sim_sap_event_outcome, sim_sap_document, sim_sap_order, sim_sap_stock, sim_sap_in_transit, sim_sap_fault_scenario')
  await pool.query("DELETE FROM outbox WHERE external_ref LIKE 'CBL01G-EVKEY-MSG-%'")
  const repos = createPgSapSimRepositories(pool)
  facts = createPgSapSimFactsRepositories(pool)
  engine = new SapSimEngineService(facts, new PgSapSimOutboxReceiptAdapter(repos.outbox))
  service = new SapSimService(repos, engine)
})

afterAll(async () => {
  if (pool) {
    observations.push({ stock: await engine?.listStock(), orders: await engine?.listOrders() })
    mkdirSync(evidenceDirectory, { recursive: true })
    writeFileSync(`${evidenceDirectory}/behavior-readback.json`, JSON.stringify({
      assignment: 'SOL-SAP-ENGINE-1031', claim_level: 'sim_engine_regression_only',
      database: new URL(engineDatabaseUrl()).pathname.slice(1), csvDirectory, observations,
    }, null, 2))
    await pool.end()
  }
})

describe('S2 output accounting and order-version limits', () => {
  it('intermediate stage and final output each count once; shipment does not release final-output allowance', async () => {
    await run(synthetic('REL-I', 'PRODUCTION_RELEASE', 'I', { qty: 6000, unit: 'm', material_id: 'FIN-I' }, 1))
    const intermediate = await run(synthetic('SF-I', 'INTERMEDIATE_OUTPUT', 'I', { material_id: 'SF-I', qty: 6000, unit: 'm', step: '10' }))
    expect(intermediate.detail['produced_total']).toBe(0)
    expect(intermediate.detail['intermediate_total']).toBe(6000)
    expect((await run(synthetic('SF-OVER', 'INTERMEDIATE_OUTPUT', 'I', { material_id: 'SF-I', qty: 1, unit: 'm', step: '10' }))).outcome).toBe('REJECTED_QTY_EXCEEDED')
    await run(synthetic('GI-I', 'MATERIAL_CONSUMPTION', 'I', { lines: [{ material: 'SF-I', qty: 6000, unit: 'm' }] }))
    expect((await run(synthetic('GR-I', 'PRODUCTION_OUTPUT', 'I', { qty: 6000, unit: 'm' }))).outcome).toBe('CONFIRMED')
    expect((await run(synthetic('SHIP-I', 'SHIPMENT_CONFIRM', 'I', { qty: 6000, unit: 'm' }))).outcome).toBe('CONFIRMED')
    expect((await run(synthetic('GR-AGAIN', 'PRODUCTION_OUTPUT', 'I', { qty: 1, unit: 'm' }))).outcome).toBe('REJECTED_QTY_EXCEEDED')
    expect((await facts.orders.findByIdentity('SOL-S2', 'SOL-P1', 'I'))?.producedQty).toBe(6000)
    expect((await facts.stock.find('SOL-S2', 'SOL-P1', 'SF-I', 'm'))?.qty).toBe(0)
  })

  it('ordinary and bundled outputs share the cap; a rejected bundle changes neither inputs nor outputs', async () => {
    await run(synthetic('REL-B', 'PRODUCTION_RELEASE', 'B', { qty: 10, unit: 'm', material_id: 'FIN-B' }, 1))
    await run(synthetic('GR-B', 'PRODUCTION_OUTPUT', 'B', { qty: 4, unit: 'm' }))
    const bad = await run(synthetic('B-OVER', 'EXECUTION_BUNDLE', 'B', {
      consumption_lines: [{ source_object_id: 'RAW-B', qty: 5, unit: 'kg' }],
      output_lines: [{ object_id: 'B-1', qty: 3, unit: 'm' }, { object_id: 'B-2', qty: 4, unit: 'm' }],
    }))
    expect(bad.outcome).toBe('REJECTED_QTY_EXCEEDED')
    expect(await facts.stock.find('SOL-S2', 'SOL-P1', 'RAW-B', 'kg')).toBeNull()
    expect(await facts.stock.find('SOL-S2', 'SOL-P1', 'B-1', 'm')).toBeNull()
    const good = await run(synthetic('B-WITHIN', 'EXECUTION_BUNDLE', 'B', { output_lines: [{ object_id: 'B-1', qty: 6, unit: 'm' }] }))
    expect(good.outcome).toBe('LINES_CONFIRMED')
    expect(good.detail['produced_total']).toBe(10)
    expect((await facts.stock.find('SOL-S2', 'SOL-P1', 'B-1', 'm'))?.qty).toBe(6)
    expect((await run(synthetic('B-REG-OVER', 'PRODUCTION_OUTPUT', 'B', { qty: 1, unit: 'm' }))).outcome).toBe('REJECTED_QTY_EXCEEDED')
    await expect(run(synthetic('B-NEG', 'EXECUTION_BUNDLE', 'B', { output_lines: [{ object_id: 'B-1', qty: -10, unit: 'm' }] }))).rejects.toMatchObject({ rule: 'SAP-SIMENG-12' })
    expect((await facts.orders.findByIdentity('SOL-S2', 'SOL-P1', 'B'))?.producedQty).toBe(10)
  })

  it('revisions retain 4000 produced; cancel/shrink/extra output refuse and the original v2 key never rolls back v3 (R3-D)', async () => {
    await run(synthetic('REL-V', 'PRODUCTION_RELEASE', 'V', { qty: 6000, unit: 'm', material_id: 'FIN-V' }, 1))
    await run(synthetic('GR-V', 'PRODUCTION_OUTPUT', 'V', { qty: 4000, unit: 'm' }))
    const v2 = synthetic('REV-V2', 'PRODUCTION_REVISION', 'V', { date_only: true }, 2, 1)
    await run(v2)
    await run(synthetic('REV-V3', 'PRODUCTION_REVISION', 'V', { new_qty: 4000 }, 3, 2))
    expect((await run(v2)).outcome).toBe('DUPLICATE_SAME_HASH_NOOP')
    expect((await facts.orders.findByIdentity('SOL-S2', 'SOL-P1', 'V'))).toMatchObject({ orderVersion: 3, producedQty: 4000, qty: 4000 })
    expect((await run(synthetic('CANCEL-V', 'CANCEL_REQUEST', 'V', { requested_qty: 0 }, 4, 3))).outcome).toBe('REJECT_ALREADY_PRODUCED')
    expect((await run(synthetic('SHRINK-V', 'PRODUCTION_REVISION', 'V', { new_qty: 3999 }, 4, 3))).outcome).toBe('REJECTED_QTY_EXCEEDED')
    expect((await run(synthetic('EXTRA-V', 'EXECUTION_BUNDLE', 'V', { output_lines: [{ object_id: 'FIN-V', qty: 1, unit: 'm' }] }))).outcome).toBe('REJECTED_QTY_EXCEEDED')
    expect((await facts.orders.findVersion('SOL-S2', 'SOL-P1', 'V', 1))?.producedQty).toBe(4000)
  })

  it('intermediate facts also survive revisions and prevent cancellation; cancelled fresh orders reject both output entries', async () => {
    await run(synthetic('REL-C', 'PRODUCTION_RELEASE', 'C', { qty: 100, unit: 'm', material_id: 'FIN-C' }, 1))
    await run(synthetic('SF-C', 'INTERMEDIATE_OUTPUT', 'C', { material_id: 'SF-C', qty: 100, unit: 'm', step: '10' }))
    await run(synthetic('REV-C', 'PRODUCTION_REVISION', 'C', { date_only: true }, 2, 1))
    expect((await run(synthetic('CANCEL-C', 'CANCEL_REQUEST', 'C', {}))).outcome).toBe('REJECT_ALREADY_PRODUCED')
    expect((await run(synthetic('SF-C-OVER', 'INTERMEDIATE_OUTPUT', 'C', { material_id: 'SF-C', qty: 1, unit: 'm', step: '10' }))).outcome).toBe('REJECTED_QTY_EXCEEDED')
    await run(synthetic('REL-EMPTY', 'PRODUCTION_RELEASE', 'EMPTY', { qty: 100, unit: 'm', material_id: 'FIN-E' }, 1))
    expect((await run(synthetic('CANCEL-EMPTY', 'CANCEL_REQUEST', 'EMPTY', {}))).outcome).toBe('CANCELLED')
    expect((await run(synthetic('EMPTY-GR', 'PRODUCTION_OUTPUT', 'EMPTY', { qty: 1, unit: 'm' }))).outcome).toBe('REJECT_NOTICE')
    expect((await run(synthetic('EMPTY-B', 'EXECUTION_BUNDLE', 'EMPTY', { output_lines: [{ object_id: 'FIN-E', qty: 1, unit: 'm' }] }))).outcome).toBe('REJECT_NOTICE')
  })
})

describe('S3 original frozen messages resolve business references', () => {
  it('accepts scoped, immutable reference masters and rejects scope/oracle-field/same-version replacement', async () => {
    for (const [organization, plant] of [['CBL01G-C100', 'CN11'], ['CBL01G-C100', 'CN12'], ['CBL01G-K200', 'KR21'], ['CBL01G-K200', 'KR22']]) {
      const data = loadFrozenReferenceData(csvDirectory, organization, plant)
      assertSapSimReferenceData(data, organization, plant)
      expect((await run({ event_key: `SOL-REFERENCE-${plant}`, topic: 'MASTER_VERSION_BUNDLE', organization_code: organization, plant_code: plant,
        payload: { reference_data: data } })).outcome).toBe('APPLIED')
    }
    const data = loadFrozenReferenceData(csvDirectory, 'CBL01G-C100', 'CN11')
    expect(() => assertSapSimReferenceData(data, 'CBL01G-K200', 'CN11')).toThrow()
    const oracle = structuredClone(data)
    oracle.tables.stock_objects[0]!['closing_qty'] = '999'
    expect(() => assertSapSimReferenceData(oracle, 'CBL01G-C100', 'CN11')).toThrow()
    const changed = structuredClone(data)
    changed.tables.transfer_lines[0]!['qty'] = '4081.0000'
    await expect(run({ event_key: 'SOL-REFERENCE-REPLACE', topic: 'MASTER_VERSION_BUNDLE', organization_code: 'CBL01G-C100', plant_code: 'CN11',
      payload: { reference_data: changed } })).rejects.toMatchObject({ rule: 'SAP-SIMENG-17' })
  })

  it('original N1 inputs debit CU/PVC objects using order-specific rows, preserving the original outbox identity and payload', async () => {
    await run(frozen('REL-N1'))
    await run(frozen('N1-SFGR'))
    const receipt = await dispatchFrozen('N1-GI')
    expect(receipt.outcome).toBe('CONFIRMED')
    expect((await facts.stock.find('CBL01G-C100', 'CN11', 'CBL01G-RAW-CUCN', 'kg'))?.qty).toBe(-82)
    expect((await facts.stock.find('CBL01G-C100', 'CN11', 'CBL01G-RAW-PVCG', 'kg'))?.qty).toBe(-46.5)
    expect(await facts.stock.find('CBL01G-C100', 'CN11', 'CBL01G-RAW-PVCS', 'kg')).toBeNull()
    expect(await facts.stock.find('CBL01G-C100', 'CN11', 'CU15', 'kg')).toBeNull()
    const doc = (await facts.documents.findByEventKey(String(frozen('N1-GI')['event_key'])))[0]!
    expect(doc.payload['envelope']).toEqual(frozen('N1-GI')['payload'])
    expect(doc.payload['reference_data_version']).toBe('CBL01G-SIM-v2.0')
    expect((await dispatchFrozen('N1-GR')).outcome).toBe('CONFIRMED')
    expect((await dispatchFrozen('N1-SHIP')).outcome).toBe('CONFIRMED')
  })

  it('T4 original line_ids transfer four real 2020m objects; original N2 summary consumes 8080 core_m and its own 102kg jacket', async () => {
    for (const color of ['BL', 'BN', 'BK', 'GY']) {
      await run(frozen(`REL-C40-${color}`))
      expect((await run(frozen(`BUNDLE-C40-${color}`))).outcome).toBe('LINES_CONFIRMED')
    }
    expect((await dispatchFrozen('T4-OUT')).outcome).toBe('ISSUE_CONFIRMED')
    expect((await dispatchFrozen('T4-IN')).outcome).toBe('RECEIPT_CONFIRMED')
    await run(frozen('REL-N2'))
    expect((await dispatchFrozen('N2-GI')).outcome).toBe('CONFIRMED')
    for (const color of ['BL', 'BN', 'BK', 'GY']) {
      expect((await facts.stock.find('CBL01G-K200', 'KR21', `CBL01G-C40-${color}`, 'm'))?.qty).toBe(0)
      expect((await facts.stock.find('CBL01G-K200', 'KR22', `CBL01G-C40-${color}`, 'm'))?.qty).toBe(0)
    }
    expect((await facts.stock.find('CBL01G-K200', 'KR22', 'CBL01G-RAW-J22', 'kg'))?.qty).toBe(-102)
    expect(await facts.stock.find('CBL01G-K200', 'KR22', 'CBL01G-RAW-JKBAD', 'kg')).toBeNull()
    const doc = (await facts.documents.findByEventKey(String(frozen('N2-GI')['event_key'])))[0]!
    const lines = doc.payload['lines'] as Array<Record<string, unknown>>
    expect(lines.filter((row) => row['basis'] === 'core_m')).toHaveLength(4)
    expect(lines.every((row) => (row['sourceReferences'] as string[]).length >= 2)).toBe(true)
    expect(doc.payload['envelope']).toEqual({ core_m: 8080, jacket_kg: 102 })
    await expect(run({ ...frozen('N2-GI'), event_key: 'SOL-BAD-SUMMARY', payload: { core_m: 8081, jacket_kg: 102 } })).rejects.toMatchObject({ rule: 'SAP-SIMENG-17' })
    expect(await facts.documents.findByEventKey('CBL01G-EVKEY-MSG-N2-GR-B')).toHaveLength(0)
  })

  it('T2 keeps 3×4080m in transit under source ownership; T3 transfers actual GC-1 2000m to the receiving organization', async () => {
    for (const color of ['BL', 'BN', 'BK']) {
      await run(frozen(`REL-C15-${color}`))
      await run(frozen(`BUNDLE-C15-${color}-3`))
    }
    expect((await dispatchFrozen('T2-OUT')).outcome).toBe('ISSUE_CONFIRMED')
    const transit = await pool.query("SELECT organization_code, from_plant, to_plant, material_id, qty, status, issue_doc_id FROM sim_sap_in_transit WHERE transfer_key='CBL01G-T2' ORDER BY material_id")
    expect(transit.rows).toHaveLength(3)
    for (const row of transit.rows) {
      expect(row).toMatchObject({ organization_code: 'CBL01G-C100', from_plant: 'CN11', to_plant: 'KR21', status: 'IN_TRANSIT' })
      expect(Number(row['qty'])).toBe(4080)
      expect(row['issue_doc_id']).toBeTruthy()
    }
    await run(frozen('REL-G-CN'))
    await run(frozen('BUNDLE-G-CN-FIN'))
    expect((await dispatchFrozen('T3-OUT')).outcome).toBe('ISSUE_CONFIRMED')
    expect((await dispatchFrozen('T3-IN')).outcome).toBe('RECEIPT_CONFIRMED')
    expect((await facts.stock.find('CBL01G-C100', 'CN12', 'CBL01G-GC-1', 'm'))?.qty).toBe(0)
    expect((await facts.stock.find('CBL01G-K200', 'KR22', 'CBL01G-GC-1', 'm'))?.qty).toBe(2000)
    expect(await facts.stock.find('CBL01G-C100', 'KR22', 'CBL01G-GC-1', 'm')).toBeNull()
    expect(await facts.stock.find('CBL01G-K200', 'KR22', 'CBL01G-F2', 'm')).toBeNull()
  })

  it('unknown/duplicate line_ids and wrong receipt scope fail before changing any stock', async () => {
    const before = await engine.listStock()
    await expect(run({ ...frozen('T2-OUT'), event_key: 'SOL-T2-BAD-ID', payload: { transfer_id: 'CBL01G-T2', line_ids: ['MISSING'] } })).rejects.toMatchObject({ rule: 'SAP-SIMENG-17' })
    const id = 'CBL01G-TL-T2-C15-BL-3'
    await expect(run({ ...frozen('T2-OUT'), event_key: 'SOL-T2-DUP-ID', payload: { transfer_id: 'CBL01G-T2', line_ids: [id, id] } })).rejects.toMatchObject({ rule: 'SAP-SIMENG-17' })
    await expect(run({ ...frozen('T3-IN'), event_key: 'SOL-T3-WRONG-OWNER', organization_code: 'CBL01G-C100' })).rejects.toMatchObject({ rule: 'SAP-SIMENG-17' })
    expect(await engine.listStock()).toEqual(before)
  })
})
