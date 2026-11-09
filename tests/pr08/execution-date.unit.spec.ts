import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  PgExecutionSessionRepository,
  PgProductionReportRepository,
  PgMaterialConsumptionRepository,
  PgLaborRecordRepository,
} from '../../packages/persistence/src/execution-repositories'
import type { SqlClient } from '../../packages/persistence/src/sql-client'

// Bounded repository mapping tests with an explicit SQL-client double, not PG.
// Raw DATE-parser instants use explicit offsets; process.env.TZ is never changed.
// The server-projected calendar text must win over the raw parsed Date in every
// read/RETURNING path. Timestamps retain the existing ISO-instant contract.
const enterpriseId = '08000000-0000-4000-8000-000000000001'
const plantId = '08000000-0000-4000-8000-000000000002'
const orderId = '08000000-0000-4000-8000-000000000003'
const userId = '08000000-0000-4000-8000-000000000004'
const rowId = '08000000-0000-4000-8000-000000000005'
const operationId = '08000000-0000-4000-8000-000000000006'
const businessTime = '2026-11-03T23:30:00+08:00'
const businessIso = '2026-11-03T15:30:00.000Z'
const auditIso = '2026-11-03T17:45:00.000Z'
const actor = 'pr08date'
const commonInput = {
  enterpriseId, plantId, orderId, operatorUserId: userId,
  operatorLogin: actor, businessTime,
}
const zones = [
  { name: 'UTC', day: '2026-11-03', offset: '+00:00' },
  { name: 'UTC+08 SZ observed failure', day: '2026-11-03', offset: '+08:00' },
  { name: 'UTC+09 HF business day', day: '2026-11-04', offset: '+09:00' },
  { name: 'UTC+14 year boundary', day: '2027-01-01', offset: '+14:00' },
  { name: 'UTC-10 leap day', day: '2024-02-29', offset: '-10:00' },
]

function row(day: string | null, offset: string): Record<string, unknown> {
  return {
    id: rowId, enterprise_id: enterpriseId, plant_id: plantId,
    order_id: orderId, session_id: rowId, order_operation_id: operationId,
    operation_seq: 2, source: 'order', status: 'draft',
    review_status: 'pending_review', operator_user_id: userId, operator_login: actor,
    // Retain both fields to catch accidental use of the old OID1082 Date.
    shift_date: day === null ? null : new Date(`${day}T00:00:00${offset}`),
    shift_date_text: day,
    business_time: businessTime,
    created_at: new Date(auditIso), updated_at: '2026-11-03T09:45:00-08:00',
    reviewed_at: new Date(auditIso), review_cancelled_at: null,
    qc_completed_at: '2026-11-04T01:45:00+08:00', deleted_at: null,
    draft_feeds: [], quantity: '4.0000', before_qty: '20.0000', after_qty: '16.0000',
    hours: '1.5000',
  }
}

function sqlRows(table: string, data: Record<string, unknown>) {
  const rowQueries: Array<{ sql: string; values: readonly unknown[] | undefined }> = []
  const client: SqlClient = {
    async query(sql, values) {
      if (/SELECT count\(\*\)::text AS n/.test(sql)) {
        assert.match(sql, new RegExp(`FROM ${table}\\b`))
        return { rows: [{ n: '1' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] }
      }
      assert.match(sql, new RegExp(`(?:FROM|INTO|UPDATE) ${table}\\b`))
      const qualified = /\bexecution_session s\b/.test(sql)
      const dateExpression = qualified ? 's.shift_date' : 'shift_date'
      assert.ok(sql.includes(`to_char(${dateExpression}::timestamp, 'YYYY-MM-DD') AS shift_date_text`),
        'Every DATE-bearing SELECT/RETURNING must project calendar text without a time-zone cast')
      rowQueries.push({ sql, values })
      return { rows: [{ ...data }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] }
    },
  }
  return { client, rowQueries }
}

type ReadCall = [name: string, execute: () => Promise<unknown>]

function sessionCalls(client: SqlClient, day: string): ReadCall[] {
  const repository = new PgExecutionSessionRepository(client)
  const input: Parameters<PgExecutionSessionRepository['insert']>[0] = {
    ...commonInput, source: 'order', shiftDate: day,
  }
  return [
    ['findById', () => repository.findById(rowId)],
    ['findBySessionReportId', () => repository.findBySessionReportId(rowId)],
    ['listOpenByOperatorAndOrder', () => repository.listOpenByOperatorAndOrder(userId, orderId)],
    ['insert RETURNING', () => repository.insert(input)],
    ['update RETURNING', () => repository.update(rowId, { shiftDate: day, businessTime }, actor)],
    ['list', () => repository.list({ enterpriseId, plantIds: [plantId], page: 1, pageSize: 2 })],
  ]
}

function reportCalls(client: SqlClient, day: string): ReadCall[] {
  const repository = new PgProductionReportRepository(client)
  const input: Parameters<PgProductionReportRepository['insert']>[0] = {
    ...commonInput, sessionId: rowId, orderOperationId: operationId,
    operationSeq: 2, source: 'order', shiftDate: day,
  }
  return [
    ['findById', () => repository.findById(rowId)],
    ['findBySessionId', () => repository.findBySessionId(rowId)],
    ['insert RETURNING', () => repository.insert(input)],
    ['update RETURNING', () => repository.update(rowId, { shiftDate: day, businessTime }, actor)],
    ['listByOrder', () => repository.listByOrder(orderId)],
    ['listByOrderOperation', () => repository.listByOrderOperation(orderId, operationId)],
    ['list', () => repository.list({ enterpriseId, plantIds: [plantId], page: 1, pageSize: 2 })],
  ]
}

function feedCalls(client: SqlClient, day: string | null): ReadCall[] {
  const repository = new PgMaterialConsumptionRepository(client)
  const input: Parameters<PgMaterialConsumptionRepository['insert']>[0] = {
    ...commonInput, orderOperationId: operationId, operationSeq: 2,
    feedType: 'standalone', inventoryUnitId: rowId, unitNo: 'PE08000001',
    quantity: '4.0000', beforeQty: '20.0000', afterQty: '16.0000',
    uomId: rowId, uomCode: 'M', shiftDate: day, commandReceiptId: rowId,
  }
  return [
    ['insert RETURNING', () => repository.insert(input)],
    ['findById', () => repository.findById(rowId)],
    ['listByReport', () => repository.listByReport(rowId)],
    ['listByOrder', () => repository.listByOrder(orderId)],
    ['listByUnit', () => repository.listByUnit(rowId)],
    ['listUnlinkedByOrderOperation', () => repository.listUnlinkedByOrderOperation(orderId, operationId)],
    ['markGenealogyTarget RETURNING', () => repository.markGenealogyTarget(rowId, rowId, actor)],
  ]
}

function laborCalls(client: SqlClient, day: string): ReadCall[] {
  const repository = new PgLaborRecordRepository(client)
  const input: Parameters<PgLaborRecordRepository['insert']>[0] = {
    ...commonInput, hours: '1.5000', shiftDate: day,
  }
  return [
    ['insert RETURNING', () => repository.insert(input)],
    ['listByOrder', () => repository.listByOrder(orderId)],
  ]
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>
  assert.ok(value !== null && typeof value === 'object')
  if ('items' in value) {
    assert.ok('total' in value)
    assert.equal(value.total, 1)
    assert.ok(Array.isArray(value.items))
    return value.items as Array<Record<string, unknown>>
  }
  return [value as Record<string, unknown>]
}

async function checkReads(calls: ReadCall[], day: string | null, family: string) {
  for (const [name, execute] of calls) {
    const mapped = records(await execute())
    assert.equal(mapped.length, 1, `${family}.${name} row count`)
    const value = mapped[0]!
    assert.equal(value.shiftDate, day, `${family}.${name} DATE calendar value`)
    assert.equal(value.businessTime, businessIso, `${family}.${name} business timestamp`)
    assert.equal(value.createdAt, auditIso, `${family}.${name} Date audit timestamp`)
    assert.equal(value.id, rowId)
    assert.equal(value.enterpriseId, enterpriseId)
    assert.equal(value.plantId, plantId)
    if (family === 'session' || family === 'report') {
      assert.equal(value.updatedAt, auditIso, 'offset string audit timestamp remains an ISO instant')
    }
    if (family === 'report') {
      assert.equal(value.reviewedAt, auditIso)
      assert.equal(value.reviewCancelledAt, null)
      assert.equal(value.qcCompletedAt, auditIso)
      assert.equal(value.deletedAt, null)
    }
    if (family === 'feed') {
      assert.equal(value.quantity, '4.0000')
      assert.equal(value.beforeQty, '20.0000')
      assert.equal(value.afterQty, '16.0000')
    }
    if (family === 'labor') assert.equal(value.hours, '1.5000')
  }
}

describe('PR08 DATE-only repository reads; SQL doubles, no process TZ mutation', () => {
  const families = [
    { name: 'session', table: 'execution_session', calls: sessionCalls, pathCount: 6 },
    { name: 'report', table: 'production_report', calls: reportCalls, pathCount: 7 },
    { name: 'feed', table: 'material_consumption', calls: feedCalls, pathCount: 7 },
    { name: 'labor', table: 'labor_record', calls: laborCalls, pathCount: 2 },
  ]
  for (const zone of zones) {
    for (const family of families) {
      it(`${family.name}: ${zone.name} retains DATE text and ISO timestamps on every read path`, async () => {
        const data = row(zone.day, zone.offset)
        const rawDate = data.shift_date as Date
        const rawInstant = rawDate.toISOString()
        // The two observed positive-offset dates and the year boundary differ
        // from the UTC date; the mapper must never derive DATE from this instant.
        if (zone.offset === '+08:00' || zone.offset === '+09:00' || zone.offset === '+14:00') {
          assert.notEqual(rawInstant.slice(0, 10), zone.day)
        }
        const { client, rowQueries } = sqlRows(family.table, data)
        const calls = family.calls(client, zone.day)
        assert.equal(calls.length, family.pathCount)
        await checkReads(calls, zone.day, family.name)
        assert.equal(rowQueries.length, family.pathCount)
        assert.equal(rawDate.toISOString(), rawInstant, 'raw driver Date must not be mutated')
      })
    }
  }

  it('feed: nullable DATE stays null on all seven read/RETURNING paths', async () => {
    const { client, rowQueries } = sqlRows('material_consumption', row(null, '+00:00'))
    await checkReads(feedCalls(client, null), null, 'feed')
    assert.equal(rowQueries.length, 7)
  })
})
