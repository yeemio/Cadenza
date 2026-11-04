import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ERROR_CODES, type CommandResult } from '@cadenza/contracts'
import { createScryptPasswordHasher, type CommandBus, type CommandContext } from '@cadenza/application'
import { createPool, createPgQualityRepositories, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildPurchaseCommandBus } from '../../apps/api/src/purchase/purchase.composition'
import { buildQualityCommandBus } from '../../apps/api/src/quality/quality.composition'

// This suite never creates/drops a database, never falls back to DATABASE_URL,
// and never turns an unavailable PG into skip/PASS. The controller supplies a
// NEW task-owned empty database and retains it for query/receipt inspection.
const url = process.env['CADENZA_PR02_TEST_DB_URL']
if (!url || !/^cadenza_pr02_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) {
  throw new Error('NOT_RUN: CADENZA_PR02_TEST_DB_URL must name a NEW empty cadenza_pr02_* PostgreSQL database')
}
const pool = createPool(url, { max: 6 })
type Payload = Record<string, unknown>
const writes = ['quality.post', 'purchase.post', 'inventory.post', 'inventory.reserve']
const reads = ['quality.read', 'purchase.read', 'inventory.read', 'group.read']
const uomId = randomUUID()
const future = () => new Date(Date.now() + 3_600_000).toISOString()
let inventory: CommandBus
let purchase: CommandBus
let quality: CommandBus
let groupReader: CommandContext
let mixedReader: CommandContext
let a: Factory
let b: Factory
let c: Factory
let snapshotSql: string
let barcodeSeq = 0

interface Stock { unitId: string; unitNo: string; balanceId: string; barcodeValue: string }
interface Factory {
  actor: CommandContext
  plantId: string
  enterpriseId: string
  materialId: string
  materialCode: string
  warehouseId: string
  locationId: string
  locationCode: string
  stock: Stock
  holdStock: Stock
  holdId: string
  reservationId: string
  inspectionId: string
  unqualifiedInspectionId: string
  orderNo: string
  orgCode: string
  lineId: string
  batchId: string
  detailId: string
  purchaseBarcode: string
}

function envelope(commandType: string, payload: Payload) {
  return { commandType, operationId: randomUUID(), targetId: 'pr02', expectedRevision: 0, payload }
}
async function committed(bus: CommandBus, ctx: CommandContext, commandType: string, payload: Payload): Promise<Payload> {
  const e = envelope(commandType, payload)
  const result = await bus.execute(e, ctx)
  expect(result.status, JSON.stringify(result)).toBe('COMMITTED')
  expect(await bus.execute(e, ctx)).toEqual(result)
  return result.data as Payload
}
async function actor(login: string): Promise<CommandContext & { plantId: string }> {
  const row = (await pool.query<{ id: string; login_name: string; enterprise_id: string; plant_id: string }>(
    'SELECT id,login_name,enterprise_id,plant_id FROM user_account WHERE login_name=$1', [login],
  )).rows[0]!
  return { actorUserId: row.id, actorLoginName: row.login_name, enterpriseId: row.enterprise_id, plantId: row.plant_id }
}
async function grant(ctx: CommandContext, plantId: string, permissions: string[], scopeType = 'plant') {
  // Test-only user grants in this new database; no administrator/role expansion.
  await pool.query(`INSERT INTO scope_grant(enterprise_id,principal_type,principal_id,permissions,scope_type,scope_object_id,status,created_by)
    VALUES ($1,'user',$2,$3,$4,$5,'active','pr02-fixture')`,
  [ctx.enterpriseId, ctx.actorUserId, permissions, scopeType, plantId])
}

async function stock(f: Pick<Factory, 'actor' | 'plantId' | 'enterpriseId' | 'materialId' | 'materialCode' | 'locationId' | 'locationCode'>): Promise<Stock> {
  const unitNo = `PR02-${randomUUID()}`
  const barcodeValue = `R${String(++barcodeSeq).padStart(9, '0')}`
  const data = await committed(inventory, f.actor, 'inventory.receive-goods', {
    plantId: f.plantId, materialId: f.materialId, materialCode: f.materialCode,
    unitNo, lotNo: `LOT-${unitNo}`, quantity: '20.0000', uomId, uomCode: 'KG',
    locationId: f.locationId, locationCode: f.locationCode, ownerId: f.enterpriseId, ownerName: 'PR02 owner',
    qualityStatus: 'qualified', barcodeValue,
  })
  return { unitId: data.unitId as string, balanceId: data.balanceId as string, unitNo, barcodeValue }
}

async function inspection(f: Pick<Factory, 'actor' | 'plantId' | 'enterpriseId' | 'materialId' | 'materialCode'>, s: Stock, conclusion: 'qualified' | 'unqualified') {
  const qa = createPgQualityRepositories(pool)
  // Persist a genuine inspection source fixture, then use the production
  // command for its conclusion and every tested write. No repository doubles.
  const order = await qa.inspectionOrders.insert({
    orderNo: `Q-${randomUUID()}`, sourceType: 'work_report', sourceRef: randomUUID(), inspectionStage: 'finished',
    specCode: 'PR02-SPEC', specVersion: 1, unitNo: s.unitNo, materialId: f.materialId, materialCode: f.materialCode,
    quantity: '20.0000', uomId, uomCode: 'KG', plantId: f.plantId, enterpriseId: f.enterpriseId, createdBy: 'pr02-fixture',
  })
  await qa.testResults.insert({ inspectionOrderId: order.id, version: 1, conclusion: 'pending', resultKind: 'initial', isEffective: true })
  await committed(quality, f.actor, 'quality.test-result.submit', {
    inspectionOrderId: order.id, conclusion,
    items: [{ itemNo: 'P02', measuredValue: '1.0', judgement: conclusion === 'qualified' ? 'pass' : 'fail' }],
  })
  return order.id
}

type ReceiptFactory = Pick<Factory, 'lineId' | 'plantId' | 'warehouseId' | 'locationId' | 'locationCode' | 'enterpriseId'>
function receiptPayload(f: ReceiptFactory, line: Payload = { orderLineId: f.lineId }): Payload {
  return { plantId: f.plantId, ...line, arrivalTime: '2026-11-01T00:00:00.000Z',
    warehouseId: f.warehouseId, locationId: f.locationId, locationCode: f.locationCode,
    ownerId: f.enterpriseId, ownerName: 'PR02 owner', uomId, uomCode: 'KG',
    details: [{ barcodeValue: `R${String(++barcodeSeq).padStart(9, '0')}`, quantity: '5.0000', supplierLotNo: 'PR02', grade: 'A' }] }
}

async function factory(login: string, tag: 'A' | 'B' | 'C'): Promise<Factory> {
  const who = await actor(login)
  // Use the seeded user's real department, with the same enterprise and plant ancestry.
  const department = (await pool.query<{ id: string }>(
    `SELECT d.id FROM user_account u
     JOIN org_node d ON d.id=u.dept_id AND d.kind='department' AND d.status='active'
     JOIN org_node p ON p.id=u.plant_id AND p.kind='plant' AND p.status='active'
     WHERE u.id=$1 AND u.enterprise_id=$2 AND u.plant_id=$3
       AND d.enterprise_id=u.enterprise_id AND p.enterprise_id=u.enterprise_id
       AND d.path LIKE p.path || '%'`, [who.actorUserId, who.enterpriseId, who.plantId],
  )).rows[0]
  if (!department) throw new Error(`PR02 fixture actor ${login} has no active department in its own factory`)
  await grant(who, who.plantId, writes)
  const materialCode = `PR02-CU-${tag}`
  const materialId = (await pool.query<{ id: string }>(
    `INSERT INTO material(org_scope_id,code,name,material_type,base_uom,qc_flag,source_system,created_by)
     VALUES ($1,$2,$2,1,'KG',1,'PR02','pr02-fixture') RETURNING id`, [who.enterpriseId, materialCode],
  )).rows[0]!.id
  const warehouseCode = ({ A: '0201', B: '0202', C: '0203' } as const)[tag]
  const warehouseId = (await pool.query<{ id: string }>(
    `INSERT INTO warehouse(enterprise_id,plant_id,dept_id,code,name,warehouse_type,material_types,created_by)
     VALUES ($1,$2,$3,$4,$5,'WAREHOUSE',ARRAY[1]::integer[],'pr02-fixture') RETURNING id`,
    [who.enterpriseId, who.plantId, department.id, warehouseCode, `PR02-WH-${tag}`],
  )).rows[0]!.id
  const locationCode = `${warehouseCode}0001`
  const locationId = (await pool.query<{ id: string }>(
    `INSERT INTO storage_location(enterprise_id,plant_id,warehouse_id,location_kind,code,created_by)
     VALUES ($1,$2,$3,'NORMAL',$4,'pr02-fixture') RETURNING id`, [who.enterpriseId, who.plantId, warehouseId, locationCode],
  )).rows[0]!.id
  const base = { actor: who, plantId: who.plantId, enterpriseId: who.enterpriseId, materialId, materialCode,
    warehouseId, locationId, locationCode }
  const initialStock = await stock(base)
  const holdStock = await stock(base)
  const holdId = (await committed(quality, who, 'quality.suspect.register', { plantId: base.plantId, unitId: holdStock.unitId })).holdId as string
  const reserved = await stock(base)
  const reservationId = (await committed(inventory, who, 'inventory.reservation.acquire', {
    unitId: reserved.unitId, quantity: '1.0000', holderType: 'task', holderRef: 'PR02', validUntil: future(),
  })).reservationId as string
  const inspectionId = await inspection(base, await stock(base), 'qualified')
  const unqualifiedInspectionId = await inspection(base, await stock(base), 'unqualified')
  const orderNo = `PR02-PO-${tag}`; const orgCode = `PR02-ORG-${tag}`
  const order = await committed(purchase, who, 'purchase.order-sync', {
    plantId: base.plantId, sourceSystem: 'PR02', orgCode, orderNo, externalRevision: 1,
    lines: [{ lineNo: 1, materialId, materialCode, plannedQty: '100.0000', overReceiptLimit: '100.0000', status: 1, uomCode: 'KG' }],
  })
  const lineId = (order.lines as Array<{ lineId: string }>)[0]!.lineId
  const payload = receiptPayload({ ...base, lineId })
  const purchaseBarcode = (payload.details as Array<{ barcodeValue: string }>)[0]!.barcodeValue
  const batchId = (await committed(purchase, who, 'purchase.receive-confirm', payload)).batchId as string
  const detailId = (await pool.query<{ id: string }>('SELECT id FROM receipt_detail WHERE batch_id=$1', [batchId])).rows[0]!.id
  return { ...base, stock: initialStock, holdStock, holdId, reservationId, inspectionId, unqualifiedInspectionId,
    orderNo, orgCode, lineId, batchId, detailId, purchaseBarcode }

}

beforeAll(async () => {
  const existing = await pool.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'`)
  if (existing.rowCount !== 0) throw new Error('Refusing to migrate a nonempty PR02 database; supply a new task-owned database')
  await migrateUp(pool, migrations)
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  inventory = buildInventoryCommandBus(pool)
  purchase = buildPurchaseCommandBus(pool)
  quality = buildQualityCommandBus(pool)
  a = await factory('szqc01', 'A')
  b = await factory('hfadmin01', 'B')
  c = await factory('gzadmin01', 'C')
  groupReader = await actor('admin')
  await grant(groupReader, groupReader.enterpriseId, reads, 'enterprise')
  mixedReader = await actor('szws01')
  await grant(mixedReader, a.plantId, writes)
  await grant(mixedReader, mixedReader.enterpriseId, reads, 'enterprise')
  // Snapshot ALL public base tables, including audit, outbox, inbox and grants.
  // Only command_receipt is excluded: one durable denial receipt is deliberate.
  const tables = (await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'command_receipt' ORDER BY tablename",
  )).rows.map((r) => r.tablename)
  snapshotSql = tables.map((table) => {
    const name = table.replaceAll('"', '""')
    const literal = table.replaceAll("'", "''")
    return `SELECT '${literal}'::text AS table_name,count(*)::int AS row_count,
      coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS content FROM "${name}" t`
  }).join(' UNION ALL ')
})
afterAll(async () => { await pool.end() })

async function snapshot() {
  const result = await pool.query<{ table_name: string; row_count: number; content: string }>(snapshotSql)
  return Object.fromEntries(result.rows.map((r) => [r.table_name, {
    rows: r.row_count, sha256: createHash('sha256').update(r.content).digest('hex'),
  }]))
}

async function denied(bus: CommandBus, who: CommandContext, type: string, payload: Payload, expectedCode: string = ERROR_CODES.FORBIDDEN_SCOPE) {
  const e = envelope(type, payload)
  const before = await snapshot()
  const result: CommandResult = await bus.execute(e, who)
  expect(result.status, JSON.stringify(result)).toBe('BUSINESS_REJECTION')
  expect(result.errorCode, JSON.stringify(result)).toBe(expectedCode)
  const after = await snapshot()
  expect(after).toEqual(before)
  expect(await bus.execute(e, who)).toEqual(result)
  const replay = await snapshot()
  expect(replay).toEqual(before)
  const receipts = await pool.query('SELECT status,result FROM command_receipt WHERE enterprise_id=$1 AND command_type=$2 AND operation_id=$3',
    [who.enterpriseId, type, e.operationId])
  expect(receipts.rows).toHaveLength(1)
  expect(receipts.rows[0]!.status).toBe('BUSINESS_REJECTION')
  expect(receipts.rows[0]!.result).toEqual(JSON.parse(JSON.stringify(result)))
  console.log('PR02_QUERY', JSON.stringify({ command: type, operationId: e.operationId, actor: who.actorLoginName,
    expectedCode, before, after, replay, receiptRows: 1 }))
}

interface DenialCase { name: string; bus: () => CommandBus; command: string; payload: (f: Factory) => Payload }
const cases: DenialCase[] = [
  { name: 'inventory issue UUID / omitted plantId', bus: () => inventory, command: 'inventory.issue-material', payload: (f) => ({ unitId: f.stock.unitId, quantity: '1.0000' }) },
  { name: 'inventory issue UUID / forged plantId', bus: () => inventory, command: 'inventory.issue-material', payload: (f) => ({ unitId: f.stock.unitId, quantity: '1.0000', plantId: a.plantId }) },
  { name: 'inventory return UUID', bus: () => inventory, command: 'inventory.return-material', payload: (f) => ({ plantId: f.plantId, unitId: f.stock.unitId, quantity: '1.0000', reason: 'PR02' }) },
  { name: 'inventory move UUID', bus: () => inventory, command: 'inventory.move-stock', payload: (f) => ({ unitId: f.stock.unitId, quantity: '1.0000', toLocationId: f.locationId, toLocationCode: f.locationCode }) },
  { name: 'inventory transfer out UUID', bus: () => inventory, command: 'inventory.transfer.out', payload: (f) => ({ unitId: f.stock.unitId, quantity: '1.0000', transitLocationId: f.locationId, transitLocationCode: f.locationCode }) },
  { name: 'inventory transfer in UUID', bus: () => inventory, command: 'inventory.transfer.in', payload: (f) => ({ unitId: f.stock.unitId, quantity: '1.0000', transitLocationId: f.locationId, toLocationId: f.locationId, toLocationCode: f.locationCode }) },
  { name: 'inventory split UUID', bus: () => inventory, command: 'inventory.split', payload: (f) => ({ sourceUnitId: f.stock.unitId, retainedQty: '19.0000', lossQty: '0.0000', children: [{ unitNo: 'PR02-NOT-CREATED', quantity: '1.0000' }] }) },
  { name: 'inventory reserve UUID', bus: () => inventory, command: 'inventory.reservation.acquire', payload: (f) => ({ unitId: f.stock.unitId, quantity: '1.0000', holderType: 'task', holderRef: 'PR02', validUntil: future() }) },
  { name: 'inventory release reservation UUID', bus: () => inventory, command: 'inventory.reservation.release', payload: (f) => ({ reservationId: f.reservationId }) },
  { name: 'inventory business hold UUID', bus: () => inventory, command: 'inventory.business-hold.establish', payload: (f) => ({ unitIds: [f.stock.unitId], reason: 'PR02', businessRef: 'PR02-REF' }) },
  { name: 'quality submit UUID', bus: () => quality, command: 'quality.test-result.submit', payload: (f) => ({ inspectionOrderId: f.inspectionId, conclusion: 'qualified', items: [{ itemNo: 'PR02', measuredValue: '1.0', judgement: 'pass' }] }) },
  { name: 'quality release UUID', bus: () => quality, command: 'quality.disposition.release', payload: (f) => ({ inspectionOrderId: f.inspectionId }) },
  { name: 'quality concession UUID', bus: () => quality, command: 'quality.disposition.concession', payload: (f) => ({ inspectionOrderId: f.unqualifiedInspectionId, basedOnVersion: 2, reason: 'PR02' }) },
  { name: 'quality register UUID / forged plantId', bus: () => quality, command: 'quality.suspect.register', payload: (f) => ({ plantId: a.plantId, unitId: f.stock.unitId }) },
  { name: 'quality register barcode / forged plantId', bus: () => quality, command: 'quality.suspect.register', payload: (f) => ({ plantId: a.plantId, barcodeValue: f.stock.barcodeValue }) },
  { name: 'quality register natural unitNo', bus: () => quality, command: 'quality.suspect.register', payload: (f) => ({ plantId: f.plantId, unitNo: f.stock.unitNo }) },
  { name: 'quality restore hold UUID / omitted plantId', bus: () => quality, command: 'quality.suspect.restore', payload: (f) => ({ holdId: f.holdId, dispositionNote: 'PR02' }) },
  { name: 'quality restore unit UUID', bus: () => quality, command: 'quality.suspect.restore', payload: (f) => ({ unitId: f.holdStock.unitId, dispositionNote: 'PR02' }) },
  { name: 'quality review hold UUID', bus: () => quality, command: 'quality.suspect.review', payload: (f) => ({ holdId: f.holdId, decision: 'reject', reason: 'PR02' }) },
  { name: 'purchase receive UUID / forged plantId', bus: () => purchase, command: 'purchase.receive-confirm', payload: (f) => ({ ...receiptPayload(f), plantId: a.plantId }) },
  { name: 'purchase receive natural order+line', bus: () => purchase, command: 'purchase.receive-confirm', payload: (f) => receiptPayload(f, { orderNo: f.orderNo, lineNo: 1 }) },
  { name: 'purchase code inspection batch+barcode', bus: () => purchase, command: 'purchase.inspection.conclude', payload: (f) => ({ batchId: f.batchId, barcodeValue: f.purchaseBarcode, mode: 'code', conclusion: 'qualified' }) },
  { name: 'purchase Web batch inspection UUID', bus: () => purchase, command: 'purchase.inspection.conclude', payload: (f) => ({ batchId: f.batchId, mode: 'batch', conclusion: 'qualified' }) },
  { name: 'purchase judge batch UUID', bus: () => purchase, command: 'purchase.inspection.conclude', payload: (f) => ({ batchId: f.batchId, mode: 'judge', conclusion: 'qualified' }) },
  { name: 'purchase revoke detail UUID', bus: () => purchase, command: 'purchase.inspection.revoke', payload: (f) => ({ detailId: f.detailId }) },
  { name: 'purchase reinspection batch+barcode', bus: () => purchase, command: 'purchase.inspection.start-reinspection', payload: (f) => ({ items: [{ batchId: f.batchId, barcodeValue: f.purchaseBarcode }] }) },
  { name: 'purchase return batch UUID', bus: () => purchase, command: 'purchase.return', payload: (f) => ({ batchId: f.batchId, reason: 'PR02' }) },
  { name: 'purchase price review batch UUID', bus: () => purchase, command: 'purchase.price-review.confirm', payload: (f) => ({ batchId: f.batchId }) },
  { name: 'purchase sync natural key / forged plantId', bus: () => purchase, command: 'purchase.order-sync', payload: (f) => ({
    plantId: a.plantId, sourceSystem: 'PR02', orgCode: f.orgCode, orderNo: f.orderNo, externalRevision: 2,
    lines: [{ lineNo: 1, materialId: f.materialId, materialCode: f.materialCode, plannedQty: '999.0000' }],
  }) },
]

describe.each(['same-enterprise-other-plant', 'other-enterprise', 'group-read-only', 'enterprise-read-plus-local-write'] as const)(
  'PR02 actual PostgreSQL denial: %s', (scenario) => {
    it.each(cases)('$name leaves every business table unchanged and replays one denial', async (test) => {
      const f = scenario === 'other-enterprise' ? c : scenario === 'group-read-only' ? a : b
      const who = scenario === 'group-read-only' ? groupReader : scenario === 'enterprise-read-plus-local-write' ? mixedReader : a.actor
      await denied(test.bus(), who, test.command, test.payload(f))
    })
  },
)

describe('PR02 valid local commands, malformed associations and actual row locks', () => {
  it('an omitted mandatory receive plantId is a rejection with no write', async () => {
    const payload = receiptPayload(b); delete payload.plantId
    await denied(purchase, a.actor, 'purchase.receive-confirm', payload, ERROR_CODES.BUSINESS_RULE)
  })
  it('an omitted mandatory natural-key factory never selects a foreign object', async () => {
    await denied(quality, a.actor, 'quality.suspect.register', { unitNo: b.stock.unitNo }, ERROR_CODES.BUSINESS_RULE)
  })
  it('a claimed current factory does not substitute for a foreign natural purchase key', async () => {
    const payload = receiptPayload(b, { orderNo: b.orderNo, lineNo: 1 }); payload.plantId = a.plantId
    await denied(purchase, a.actor, 'purchase.receive-confirm', payload, ERROR_CODES.BUSINESS_RULE)
  })
  it('the mixed reader can still issue from its explicitly writable local factory', async () => {
    const data = await committed(inventory, mixedReader, 'inventory.issue-material', { unitId: a.stock.unitId, quantity: '1.0000' })
    expect(data.afterQty).toBe('19.0000')
    expect((await pool.query('SELECT quantity::text FROM stock_balance WHERE id=$1', [a.stock.balanceId])).rows[0]!.quantity).toBe('19.0000')
  })
  it('ordinary local quality release and concession commit actual dispositions', async () => {
    await committed(quality, a.actor, 'quality.disposition.release', { inspectionOrderId: a.inspectionId })
    await committed(quality, a.actor, 'quality.disposition.concession', { inspectionOrderId: a.unqualifiedInspectionId, basedOnVersion: 2, reason: 'PR02 accepted local concession' })
    const rows = (await pool.query('SELECT inspection_order_id,disposition_kind FROM quality_disposition WHERE inspection_order_id=ANY($1::uuid[]) ORDER BY disposition_kind',
      [[a.inspectionId, a.unqualifiedInspectionId]])).rows
    expect(rows).toEqual([
      { inspection_order_id: a.unqualifiedInspectionId, disposition_kind: 'concession' },
      { inspection_order_id: a.inspectionId, disposition_kind: 'release' },
    ])
  })
  it('local hold review/restore retains the hold and restores the same real unit', async () => {
    await committed(quality, a.actor, 'quality.suspect.review', { holdId: a.holdId, decision: 'reject', reason: 'PR02 review' })
    await committed(quality, a.actor, 'quality.suspect.restore', { holdId: a.holdId, dispositionNote: 'PR02 local restoration' })
    expect((await pool.query('SELECT status FROM quality_hold WHERE id=$1', [a.holdId])).rows[0]!.status).toBe('released')
    expect((await pool.query('SELECT quality_status FROM stock_balance WHERE id=$1', [a.holdStock.balanceId])).rows[0]!.quality_status).toBe('qualified')
  })
  it('local purchase inspection, revoke, reinspection, return and price review use the original parent', async () => {
    await committed(purchase, a.actor, 'purchase.price-review.confirm', { batchId: a.batchId })
    await committed(purchase, a.actor, 'purchase.inspection.conclude', { batchId: a.batchId, mode: 'code', detailId: a.detailId, conclusion: 'qualified' })
    await committed(purchase, a.actor, 'purchase.inspection.revoke', { detailId: a.detailId })
    await committed(purchase, a.actor, 'purchase.inspection.conclude', { batchId: a.batchId, mode: 'code', barcodeValue: a.purchaseBarcode, conclusion: 'unqualified' })
    await committed(purchase, a.actor, 'purchase.inspection.start-reinspection', { items: [{ batchId: a.batchId, barcodeValue: a.purchaseBarcode }] })
    await committed(purchase, a.actor, 'purchase.inspection.conclude', { batchId: a.batchId, mode: 'code', barcodeValue: a.purchaseBarcode, conclusion: 'unqualified' })
    await committed(purchase, a.actor, 'purchase.return', { batchId: a.batchId, reason: 'PR02 local return' })
    expect((await pool.query('SELECT storage_status,received_qty::text FROM purchase_receipt_batch WHERE id=$1', [a.batchId])).rows[0])
      .toEqual({ storage_status: 'returned', received_qty: '0.0000' })
    expect((await pool.query('SELECT received_qty::text FROM purchase_order_line WHERE id=$1', [a.lineId])).rows[0]!.received_qty).toBe('0.0000')
  })
  it('local natural-key receipt still resolves and locks the actual order line', async () => {
    const data = await committed(purchase, b.actor, 'purchase.receive-confirm', receiptPayload(b, { orderNo: b.orderNo, lineNo: 1 }))
    const row = (await pool.query('SELECT plant_id,enterprise_id,purchase_line_id FROM purchase_receipt_batch WHERE id=$1', [data.batchId])).rows[0]
    expect(row).toEqual({ plant_id: b.plantId, enterprise_id: b.enterpriseId, purchase_line_id: b.lineId })
  })
  it('foreign unit linked from an otherwise local inspection is refused and fully rolled back', async () => {
    const id = await inspection(a, await stock(a), 'qualified')
    await pool.query('UPDATE quality_inspection_order SET inventory_unit_id=$2 WHERE id=$1', [id, b.stock.unitId])
    await denied(quality, a.actor, 'quality.disposition.release', { inspectionOrderId: id })
  })
  it('a local purchase batch with a foreign parent line is refused before price review', async () => {
    const data = await committed(purchase, a.actor, 'purchase.receive-confirm', receiptPayload(a))
    await pool.query('UPDATE purchase_receipt_batch SET purchase_line_id=$2 WHERE id=$1', [data.batchId, b.lineId])
    await denied(purchase, a.actor, 'purchase.price-review.confirm', { batchId: data.batchId })
  })
  it('a local inventory balance with foreign organization metadata cannot be posted', async () => {
    const s = await stock(a)
    await pool.query('UPDATE stock_balance SET plant_id=$2 WHERE id=$1', [s.balanceId, b.plantId])
    await denied(inventory, a.actor, 'inventory.issue-material', { unitId: s.unitId, quantity: '1.0000' })
  })
  it('a revoked local grant is re-read for the next operation (no grant cache)', async () => {
    await pool.query("UPDATE scope_grant SET status='retired' WHERE principal_type='user' AND principal_id=$1 AND scope_type='plant'", [mixedReader.actorUserId])
    await denied(inventory, mixedReader, 'inventory.issue-material', { unitId: a.stock.unitId, quantity: '1.0000' })
  })
  it('production inspection and hold repository reads take FOR UPDATE row locks', async () => {
    const first = await pool.connect(); const second = await pool.connect()
    try {
      await first.query('BEGIN'); await second.query('BEGIN')
      const qa = createPgQualityRepositories(first)
      await qa.inspectionOrders.findById(b.inspectionId, true)
      await second.query('SAVEPOINT lock_probe')
      await expect(second.query('SELECT id FROM quality_inspection_order WHERE id=$1 FOR UPDATE NOWAIT', [b.inspectionId])).rejects.toMatchObject({ code: '55P03' })
      await second.query('ROLLBACK TO SAVEPOINT lock_probe')
      await qa.holds.findById(b.holdId, true)
      await expect(second.query('SELECT id FROM quality_hold WHERE id=$1 FOR UPDATE NOWAIT', [b.holdId])).rejects.toMatchObject({ code: '55P03' })
    } finally {
      await first.query('ROLLBACK'); await second.query('ROLLBACK'); first.release(); second.release()
    }
  })
})
