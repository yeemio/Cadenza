import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScryptPasswordHasher, type CommandBus, type CommandContext } from '@cadenza/application'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildReverseCommandBus } from '../../apps/api/src/reverse/reverse.composition'
import { buildPurchaseCommandBus } from '../../apps/api/src/purchase/purchase.composition'
// INSERT-only helper. Never call prepareRevTestDatabase/ensureRevTestDatabase
// or the legacy administrator grant helper.
import { seedRevFixtures, REV_OWNER_ID, REV_CUSTOMER_OWNER_ID, type RevFixtures } from '../api/reverse-test-env'

const url = process.env['CADENZA_PR06_TEST_DB_URL']
if (!url || !/^cadenza_pr06_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) {
  throw new Error('NOT_RUN: CADENZA_PR06_TEST_DB_URL must name a NEW empty cadenza_pr06_* PostgreSQL database')
}
const pool = createPool(url, { max: 8 })
type Payload = Record<string, unknown>
let inventory: CommandBus; let reverse: CommandBus; let purchase: CommandBus
let a: CommandContext; let b: CommandContext; let fx: RevFixtures; let snapshotSql: string; let seq = 0
const envelope = (commandType: string, payload: Payload) => ({ commandType, payload, operationId: randomUUID(), targetId: 'pr06', expectedRevision: 0 })
async function committed(bus: CommandBus, actor: CommandContext, command: string, payload: Payload): Promise<Payload> {
  const e = envelope(command, payload); const result = await bus.execute(e, actor)
  expect(result.status, JSON.stringify(result)).toBe('COMMITTED'); expect(await bus.execute(e, actor)).toEqual(result)
  return result.data as Payload
}
async function snapshot() {
  const r = await pool.query<{ table_name: string; row_count: number; content: string }>(snapshotSql)
  return Object.fromEntries(r.rows.map(row => [row.table_name, { count: row.row_count, sha256: createHash('sha256').update(row.content).digest('hex') }]))
}
async function denied(actor: CommandContext, command: string, payload: Payload, rule?: string) {
  const before = await snapshot(); const e = envelope(command, payload); const result = await reverse.execute(e, actor)
  expect(result.status, JSON.stringify(result)).toBe('BUSINESS_REJECTION')
  if (rule) expect(result.errorMessage).toContain(rule)
  const after = await snapshot(); expect(after).toEqual(before)
  expect(await reverse.execute(e, actor)).toEqual(result); expect(await snapshot()).toEqual(before)
  expect((await pool.query('SELECT status FROM command_receipt WHERE enterprise_id=$1 AND command_type=$2 AND operation_id=$3',
    [actor.enterpriseId, command, e.operationId])).rows).toEqual([{ status: 'BUSINESS_REJECTION' }])
  console.log('PR06_QUERY', JSON.stringify({ command, operationId: e.operationId, before, after, replayUnchanged: true }))
}
async function actor(login: string) {
  const row = (await pool.query<{ id: string; login_name: string; enterprise_id: string }>('SELECT id,login_name,enterprise_id FROM user_account WHERE login_name=$1', [login])).rows[0]!
  return { actorUserId: row.id, actorLoginName: row.login_name, enterpriseId: row.enterprise_id }
}
async function stock(ownerId = REV_OWNER_ID, otherMaterial = false) {
  const unitNo = `P06-${randomUUID()}`
  const materialId = otherMaterial ? fx.finishedMaterialId : fx.rawMaterialId
  const materialCode = otherMaterial ? 'MAT-REV-FIN' : 'MAT-REV-RAW'
  const r = await committed(inventory, a, 'inventory.receive-goods', { plantId: fx.szPlantId, unitNo, lotNo: unitNo,
    materialId, materialCode, quantity: '10.0000', uomId: fx.uomId, uomCode: 'KG',
    locationId: fx.szRackLocationId, locationCode: '010101', ownerId, ownerName: 'PR06 unchanged owner', qualityStatus: 'qualified' })
  return { unitId: String(r.unitId), unitNo, ownerId }
}
async function dispatch(count = 2, ownerId = REV_OWNER_ID, multiMaterial = false) {
  const stocks = []
  for (let i = 0; i < count; i++) stocks.push(await stock(ownerId, multiMaterial && i > 0))
  let outId: string | undefined
  for (const s of stocks) {
    const data = await committed(reverse, a, 'reverse.transfer-outbound.scan', { plantId: fx.szPlantId, unitNo: s.unitNo,
      toWarehouseId: fx.hfWarehouseId, ...(outId ? { orderId: outId } : {}) })
    outId = String(data.orderId)
  }
  const data = await committed(reverse, a, 'reverse.transfer-outbound.complete', { plantId: fx.szPlantId, orderId: outId, transitLocationId: fx.szTransitLocationId })
  return { stocks, orderId: String(data.inboundOrderId), outId: outId! }
}
const scan = (orderId: string, unitNo: string) => committed(reverse, b, 'reverse.transfer-inbound.scan-putaway', { orderId, unitNo, locationCode: '010101' })
const complete = (orderId: string) => committed(reverse, b, 'reverse.transfer-inbound.complete', { orderId })
async function verifyCustody(d: Awaited<ReturnType<typeof dispatch>>) {
  const units = (await pool.query('SELECT id,plant_id,status FROM inventory_unit WHERE id=ANY($1::uuid[]) ORDER BY id', [d.stocks.map(s => s.unitId)])).rows
  expect(units).toHaveLength(d.stocks.length)
  for (const unit of units) expect(unit).toMatchObject({ plant_id: fx.hfPlantId, status: 'in_stock' })
  const balances = (await pool.query('SELECT unit_id,plant_id,location_id,owner_id,quantity::text FROM stock_balance WHERE unit_id=ANY($1::uuid[]) AND status=\'active\'', [d.stocks.map(s => s.unitId)])).rows
  expect(balances).toHaveLength(d.stocks.length)
  for (const row of balances) expect(row).toMatchObject({ plant_id: fx.hfPlantId, location_id: fx.hfRackLocationId, quantity: '10.0000', owner_id: d.stocks.find(s => s.unitId === row.unit_id)!.ownerId })
  const entries = (await pool.query(`SELECT e.unit_id,e.plant_id,e.quantity_delta::text,e.owner_id,t.plant_id AS transaction_plant
    FROM stock_entry e JOIN stock_transaction t ON t.id=e.transaction_id WHERE t.ref_type='transfer_inbound_order' AND t.ref_id=$1 ORDER BY e.quantity_delta`, [d.orderId])).rows
  expect(entries).toHaveLength(d.stocks.length * 2)
  for (const e of entries) {
    const plant = Number(e.quantity_delta) < 0 ? fx.szPlantId : fx.hfPlantId
    expect(e.plant_id).toBe(plant); expect(e.transaction_plant).toBe(plant)
    expect(e.owner_id).toBe(d.stocks.find(s => s.unitId === e.unit_id)!.ownerId)
  }
  const inbound = (await pool.query('SELECT status,received_by FROM transfer_inbound_order WHERE id=$1', [d.orderId])).rows[0]
  expect(inbound).toEqual({ status: 'completed', received_by: b.actorLoginName })
  expect((await pool.query("SELECT event_id FROM outbox WHERE aggregate_id=$1 AND task_kind='reverse.transfer-inbound-completed'", [d.orderId])).rowCount).toBe(1)
  console.log('PR06_CUSTODY', JSON.stringify({ orderId: d.orderId, units, balances, entries, inbound }))
}

beforeAll(async () => {
  if ((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rowCount !== 0) throw new Error('Refusing nonempty PR06 database')
  await migrateUp(pool, migrations); await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  fx = await seedRevFixtures(pool); a = await actor('szqc01'); b = await actor('hfadmin01')
  for (const [who, plantId, permissions] of [[a, fx.szPlantId, ['reverse.post','purchase.post','inventory.post','inventory.reserve']], [b, fx.hfPlantId, ['reverse.post']]] as const) {
    await pool.query(`INSERT INTO scope_grant(enterprise_id,principal_type,principal_id,permissions,scope_type,scope_object_id,status,created_by)
      VALUES ($1,'user',$2,$3,'plant',$4,'active','pr06-fixture')`, [who.enterpriseId, who.actorUserId, permissions, plantId])
  }
  inventory = buildInventoryCommandBus(pool); reverse = buildReverseCommandBus(pool); purchase = buildPurchaseCommandBus(pool)
  const tables = (await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'command_receipt' ORDER BY tablename")).rows.map(row => row.tablename)
  snapshotSql = tables.map(name => `SELECT '${name.replaceAll("'", "''")}'::text AS table_name,count(*)::int AS row_count,
    coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS content FROM "${name.replaceAll('"','""')}" t`).join(' UNION ALL ')
})
afterAll(async () => { await pool.end() })

describe('PR06 real PostgreSQL receipt lifecycle', () => {
  for (const ownerId of [REV_OWNER_ID, REV_CUSTOMER_OWNER_ID]) it(`destination-only receiver changes custody and preserves owner ${ownerId}`, async () => {
    const d = await dispatch(2, ownerId); for (const s of d.stocks) await scan(d.orderId, s.unitNo)
    await complete(d.orderId); await verifyCustody(d)
  })
  it('one of two axes cannot close the order; rejection rolls back and all-received later succeeds', async () => {
    const d = await dispatch(); await scan(d.orderId, d.stocks[0]!.unitNo)
    await denied(b, 'reverse.transfer-inbound.complete', { orderId: d.orderId }, 'WR-17')
    await scan(d.orderId, d.stocks[1]!.unitNo); await complete(d.orderId); await verifyCustody(d)
  })
  it('multiple materials must all be received', async () => {
    const d = await dispatch(2, REV_OWNER_ID, true); await scan(d.orderId, d.stocks[0]!.unitNo)
    await denied(b, 'reverse.transfer-inbound.complete', { orderId: d.orderId }, 'WR-17')
    await scan(d.orderId, d.stocks[1]!.unitNo); await complete(d.orderId); await verifyCustody(d)
  })
  it('duplicate scan with a different operationId creates no extra reservation', async () => {
    const d = await dispatch(1); await scan(d.orderId, d.stocks[0]!.unitNo)
    await denied(b, 'reverse.transfer-inbound.scan-putaway', { orderId: d.orderId, unitNo: d.stocks[0]!.unitNo, locationCode: '010101' }, 'WR-15')
  })
  it('source-only writer cannot sign for destination', async () => {
    const d = await dispatch(1)
    await denied(a, 'reverse.transfer-inbound.scan-putaway', { orderId: d.orderId, unitNo: d.stocks[0]!.unitNo, locationCode: '010101' }, 'A-S1')
  })
  it('completed receipt cannot be reopened by deleting its scan', async () => {
    const d = await dispatch(1); await scan(d.orderId, d.stocks[0]!.unitNo); await complete(d.orderId)
    await denied(b, 'reverse.transfer-inbound.remove-scan', { orderId: d.orderId, unitNo: d.stocks[0]!.unitNo }, 'WR-16')
    await denied(b, 'reverse.transfer-inbound.complete', { orderId: d.orderId }, 'WR-17')
  })
  it('pre-completion remove/rescan remains legitimate', async () => {
    const d = await dispatch(1); await scan(d.orderId, d.stocks[0]!.unitNo)
    await committed(reverse, b, 'reverse.transfer-inbound.remove-scan', { orderId: d.orderId, unitNo: d.stocks[0]!.unitNo })
    await scan(d.orderId, d.stocks[0]!.unitNo); await complete(d.orderId); await verifyCustody(d)
  })
  for (const mismatch of ['quantity','dispatch-status','location-plant','line-unit','reservation-holder','reservation-expired'] as const) it(`final ${mismatch} mismatch leaves every business table unchanged`, async () => {
    const d = await dispatch(2); for (const s of d.stocks) await scan(d.orderId, s.unitNo)
    const last = d.stocks[1]!
    if (mismatch === 'quantity') await pool.query("UPDATE stock_balance SET quantity=9 WHERE unit_id=$1 AND status='active'", [last.unitId])
    if (mismatch === 'dispatch-status') await pool.query("UPDATE transfer_outbound_order SET status='cancelled' WHERE id=$1", [d.outId])
    if (mismatch === 'location-plant') await pool.query('UPDATE transfer_inbound_line SET location_id=$2 WHERE order_id=$1 AND inventory_unit_id=$3', [d.orderId, fx.szRackLocationId, last.unitId])
    if (mismatch === 'line-unit') await pool.query('UPDATE transfer_inbound_line SET inventory_unit_id=$2 WHERE order_id=$1 AND inventory_unit_id=$3', [d.orderId, d.stocks[0]!.unitId, last.unitId])
    if (mismatch === 'reservation-holder') await pool.query("UPDATE reservation SET holder_ref='other-order' WHERE id=(SELECT reservation_id FROM transfer_inbound_line WHERE order_id=$1 AND inventory_unit_id=$2)", [d.orderId, last.unitId])
    if (mismatch === 'reservation-expired') await pool.query("UPDATE reservation SET acquired_at=statement_timestamp()-interval '2 seconds', valid_until=statement_timestamp()-interval '1 second' WHERE id=(SELECT reservation_id FROM transfer_inbound_line WHERE order_id=$1 AND inventory_unit_id=$2)", [d.orderId, last.unitId])
    await denied(b, 'reverse.transfer-inbound.complete', { orderId: d.orderId }, 'WR-17')
  })
  it('same parent, two batches, concurrent different-key returns consume one batch once', async () => {
    const order = await committed(purchase, a, 'purchase.order-sync', { plantId: fx.szPlantId, sourceSystem: 'PR06', orgCode: 'P06', orderNo: `PO-${randomUUID()}`, externalRevision: 1,
      lines: [{ lineNo: 1, materialId: fx.rawMaterialId, materialCode: 'MAT-REV-RAW', plannedQty: '100', overReceiptLimit: '100', status: 1, uomCode: 'KG' }] })
    const lineId = (order.lines as { lineId: string }[])[0]!.lineId
    const batches: string[] = []
    for (const quantity of ['5.0000','7.0000']) {
      const data = await committed(purchase, a, 'purchase.receive-confirm', { plantId: fx.szPlantId, orderLineId: lineId, arrivalTime: '2026-11-03T00:00:00.000Z',
        warehouseId: fx.szRawWarehouseId, locationId: fx.szRackLocationId, locationCode: '010101', ownerId: REV_OWNER_ID, ownerName: 'PR06 owner', uomId: fx.uomId, uomCode: 'KG',
        details: [{ barcodeValue: `R${String(++seq).padStart(9,'0')}`, quantity, supplierLotNo: 'PR06', grade: 'A' }] })
      batches.push(String(data.batchId))
    }
    // Explicit all-unqualified fixture; tested returns use actual command UoWs.
    await pool.query("UPDATE purchase_receipt_batch SET inspection_status='all_unqualified' WHERE id=ANY($1::uuid[])", [batches])
    const other = async () => (await pool.query(`SELECT to_jsonb(b) AS batch,
      (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') FROM stock_balance s WHERE s.unit_id IN
        (SELECT inventory_unit_id FROM receipt_detail WHERE batch_id=b.id)) AS balances,
      (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.event_id),'[]') FROM outbox o WHERE o.aggregate_id=b.id::text) AS tasks
      FROM purchase_receipt_batch b WHERE b.id=$1`, [batches[1]])).rows
    const otherBefore = await other(); const before = await snapshot()
    const keys = [envelope('purchase.return', { batchId: batches[0], reason: 'PR06 concurrent return' }), envelope('purchase.return', { batchId: batches[0], reason: 'PR06 concurrent return' })]
    const blocker = await pool.connect(); let results
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM purchase_receipt_batch WHERE id=$1 FOR UPDATE', [batches[0]])
      const pending = keys.map(key => purchase.execute(key, a))
      const deadline = Date.now() + 5000; let waiters = 0
      while (Date.now() < deadline) {
        waiters = Number((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%purchase_receipt_batch%'")).rows[0]!.n)
        if (waiters >= 2) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await blocker.query('COMMIT'); results = await Promise.all(pending); expect(waiters).toBeGreaterThanOrEqual(2)
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    expect(results.map(r => r.status).sort()).toEqual(['BUSINESS_REJECTION','COMMITTED'])
    expect((await pool.query('SELECT received_qty::text FROM purchase_order_line WHERE id=$1', [lineId])).rows).toEqual([{ received_qty: '7.0000' }])
    expect((await pool.query("SELECT storage_status,received_qty::text FROM purchase_receipt_batch WHERE id=$1", [batches[0]])).rows).toEqual([{ storage_status: 'returned', received_qty: '0.0000' }])
    expect((await pool.query("SELECT event_id FROM outbox WHERE aggregate_id=$1 AND task_kind='return_sync'", [batches[0]])).rowCount).toBe(1)
    expect(await other()).toEqual(otherBefore)
    const after = await snapshot(); for (let i=0; i<keys.length; i++) expect(await purchase.execute(keys[i]!, a)).toEqual(results[i])
    expect(await snapshot()).toEqual(after)
    console.log('PR06_CONCURRENCY', JSON.stringify({ operationIds: keys.map(k => k.operationId), results, before, after, otherBatchUnchanged: true }))
  })
})
