import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScryptPasswordHasher, type CommandBus, type CommandContext } from '@cadenza/application'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildShippingCommandBus } from '../../apps/api/src/shipping/shipping.composition'
import { buildQualityCommandBus } from '../../apps/api/src/quality/quality.composition'
// Only the INSERT-only fixture helpers are reused. Never call the legacy
// prepare/ensure database helpers (which recreate their own database).
import { seedExecutionFixtures, seedOrder, LOC_NON_LINE, LOC_NON_LINE_CODE, UOM_M_ID,
  type ExecutionFixtureIds } from '../api/execution-test-env'

const url = process.env['CADENZA_PR04_TEST_DB_URL']
if (!url || !/^cadenza_pr04_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) {
  throw new Error('NOT_RUN: CADENZA_PR04_TEST_DB_URL must name a NEW empty cadenza_pr04_* PostgreSQL database')
}
const pool = createPool(url, { max: 8 })
type Payload = Record<string, unknown>
interface Stock { unitId: string; unitNo: string; balanceId: string; materialId: string; materialCode: string;
  salesOrderNo: string; salesOrderLineNo: string; reportId?: string; productionOrderId?: string }
let inventory: CommandBus; let shipping: CommandBus; let quality: CommandBus
let actor: CommandContext; let fx: ExecutionFixtureIds; let plantId: string; let enterpriseId: string; let snapshotSql: string
const envelope = (commandType: string, payload: Payload) => ({ commandType, payload, operationId: randomUUID(), targetId: 'pr04', expectedRevision: 0 })
async function committed(bus: CommandBus, command: string, payload: Payload): Promise<Payload> {
  const e = envelope(command, payload); const result = await bus.execute(e, actor)
  expect(result.status, JSON.stringify(result)).toBe('COMMITTED'); expect(await bus.execute(e, actor)).toEqual(result)
  return result.data as Payload
}
async function snapshot() {
  const r = await pool.query<{ table_name: string; row_count: number; content: string }>(snapshotSql)
  return Object.fromEntries(r.rows.map(row => [row.table_name, { count: row.row_count, sha256: createHash('sha256').update(row.content).digest('hex') }]))
}
async function denied(command: string, payload: Payload, rule = 'A-T14-FULFILMENT') {
  const before = await snapshot(); const e = envelope(command, payload); const result = await shipping.execute(e, actor)
  expect(result.status, JSON.stringify(result)).toBe('BUSINESS_REJECTION'); expect(result.errorMessage).toContain(rule)
  const after = await snapshot(); expect(after).toEqual(before)
  expect(await shipping.execute(e, actor)).toEqual(result); expect(await snapshot()).toEqual(before)
  const receipts = await pool.query('SELECT status FROM command_receipt WHERE enterprise_id=$1 AND command_type=$2 AND operation_id=$3', [enterpriseId, command, e.operationId])
  expect(receipts.rows).toEqual([{ status: 'BUSINESS_REJECTION' }])
  console.log('PR04_QUERY', JSON.stringify({ command, operationId: e.operationId, rule, before, after, replayUnchanged: true, receiptRows: 1 }))
}
// Explicit approved-output provenance fixture; shipping/inventory behavior uses
// the real command buses. This does not claim execution-report workflow coverage.
async function origin(s: Stock, options: { salesOrderNo?: string; salesOrderLineNo?: string; uom?: string } = {}) {
  const order = await seedOrder(pool, { ...fx, materialId: s.materialId }, { orderNo: `MO-${randomUUID()}`, plannedQty: '20',
    ops: [{ seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '20' }] })
  await pool.query('UPDATE production_order SET sales_order_no=$2,line_no=$3,uom=$4 WHERE id=$1',
    [order.orderId, options.salesOrderNo ?? s.salesOrderNo, options.salesOrderLineNo ?? s.salesOrderLineNo, options.uom ?? 'M'])
  const sessionId = (await pool.query<{ id: string }>(`INSERT INTO execution_session(enterprise_id,plant_id,order_id,source,order_operation_id,
    operation_seq,operator_user_id,operator_login,shift_date,status,business_time)
    VALUES ($1,$2,$3,'order',$4,1,$5,$6,CURRENT_DATE,'submitted',clock_timestamp()) RETURNING id`,
    [enterpriseId, plantId, order.orderId, order.operationIds[0], actor.actorUserId, actor.actorLoginName])).rows[0]!.id
  const reportId = (await pool.query<{ id: string }>(`INSERT INTO production_report(enterprise_id,plant_id,session_id,order_id,order_operation_id,
    operation_seq,source,status,review_status,operator_user_id,operator_login,business_time,shift_date)
    VALUES ($1,$2,$3,$4,$5,1,'order','submitted','manual_approved',$6,$7,clock_timestamp(),CURRENT_DATE) RETURNING id`,
    [enterpriseId, plantId, sessionId, order.orderId, order.operationIds[0], actor.actorUserId, actor.actorLoginName])).rows[0]!.id
  await pool.query(`INSERT INTO report_output(enterprise_id,plant_id,report_id,line_no,quantity,qualified_qty,uom_id,uom_code,
    target_location_id,target_location_code,owner_id,owner_name,stock_unit_id)
    VALUES ($1,$2,$3,1,20,20,$4,'M',$5,$6,$1,'PR04 owner',$7)`,
    [enterpriseId, plantId, reportId, UOM_M_ID, LOC_NON_LINE, LOC_NON_LINE_CODE, s.unitId])
  return { reportId, productionOrderId: order.orderId }
}
async function stock(options: { unitNo?: string; salesOrderNo?: string; salesOrderLineNo?: string; withoutOrigin?: boolean; differentMaterial?: boolean; quantity?: string } = {}): Promise<Stock> {
  let materialId = fx.materialId; let materialCode = 'MAT-EXE-CU'
  if (options.differentMaterial) {
    materialCode = `P04-${randomUUID()}`
    materialId = (await pool.query<{ id: string }>(`INSERT INTO material(org_scope_id,code,name,material_type,base_uom,qc_flag,source_system)
      VALUES ($1,$2,$2,3,'M',1,'PR04') RETURNING id`, [enterpriseId, materialCode])).rows[0]!.id
  }
  const unitNo = options.unitNo ?? `U-${randomUUID()}`
  const data = await committed(inventory, 'inventory.receive-goods', { plantId, unitNo, lotNo: `L-${unitNo}`, materialId, materialCode,
    quantity: options.quantity ?? '20.0000', uomId: UOM_M_ID, uomCode: 'M', locationId: LOC_NON_LINE, locationCode: LOC_NON_LINE_CODE,
    ownerId: enterpriseId, ownerName: 'PR04 owner', qualityStatus: 'qualified' })
  const s: Stock = { unitId: String(data.unitId), balanceId: String(data.balanceId), unitNo, materialId, materialCode,
    salesOrderNo: options.salesOrderNo ?? `SO-${randomUUID()}`, salesOrderLineNo: options.salesOrderLineNo ?? '1' }
  if (!options.withoutOrigin) Object.assign(s, await origin(s))
  return s
}
async function pl(stocks: Stock[], options: { kind?: 'axis_item' | 'plain_item'; count?: number; segment?: string; salesOrderNo?: string } = {}) {
  const order = await committed(shipping, 'shipping.pl.inbound', { plantId, plNo: `PL-${randomUUID()}`,
    salesOrderNo: options.salesOrderNo ?? stocks[0]!.salesOrderNo,
    lines: stocks.map((s, i) => ({ lineNo: i + 1, lineKind: options.kind ?? 'plain_item', materialId: s.materialId,
      materialCode: s.materialCode, salesOrderLineNo: s.salesOrderLineNo, requiredCount: options.count ?? 1,
      ...(options.kind === 'axis_item' ? { customerAxisNo: `CA-${i}`, standardSegmentLength: options.segment ?? '20.0000' }
        : { segmentLength: options.segment ?? '20.0000' }) })) })
  const shipmentOrderId = String(order.orderId)
  const lines = (await pool.query<{ id: string }>('SELECT id FROM shipment_line WHERE shipment_order_id=$1 ORDER BY line_no', [shipmentOrderId])).rows
  return { shipmentOrderId, lineIds: lines.map(l => l.id) }
}
async function load(s: Stock, order: Awaited<ReturnType<typeof pl>>, lineId: string | undefined = order.lineIds[0]) {
  return committed(shipping, 'shipping.scan.load', { plantId, shipmentOrderId: order.shipmentOrderId, unitNo: s.unitNo, ...(lineId ? { lineId } : {}) })
}
async function confirm(order: Awaited<ReturnType<typeof pl>>) { return committed(shipping, 'shipping.ship.confirm', { plantId, shipmentOrderId: order.shipmentOrderId }) }

beforeAll(async () => {
  if ((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rowCount !== 0) {
    throw new Error('Refusing nonempty PR04 database; supply a fresh task-owned database')
  }
  await migrateUp(pool, migrations); await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  fx = await seedExecutionFixtures(pool); plantId = fx.szPlantId; enterpriseId = fx.enterpriseId
  const user = (await pool.query<{ id: string; login_name: string }>("SELECT id,login_name FROM user_account WHERE login_name='szqc01'")).rows[0]!
  actor = { actorUserId: user.id, actorLoginName: user.login_name, enterpriseId }
  await pool.query(`INSERT INTO scope_grant(enterprise_id,principal_type,principal_id,permissions,scope_type,scope_object_id,status,created_by)
    VALUES ($1,'user',$2,$3,'plant',$4,'active','pr04-fixture')`,
    [enterpriseId, actor.actorUserId, ['inventory.post','inventory.reserve','shipping.post','quality.post'], plantId])
  inventory = buildInventoryCommandBus(pool); shipping = buildShippingCommandBus(pool); quality = buildQualityCommandBus(pool)
  const names = (await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'command_receipt' ORDER BY tablename")).rows.map(r => r.tablename)
  snapshotSql = names.map(name => `SELECT '${name.replaceAll("'", "''")}'::text AS table_name,count(*)::int AS row_count,
    coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS content FROM "${name.replaceAll('"','""')}" t`).join(' UNION ALL ')
})
afterAll(async () => { await pool.end() })

describe('PR04 actual physical fulfilment with real PostgreSQL repositories', () => {
  for (const kind of ['axis_item','plain_item'] as const) it(`legitimate ${kind} scans and ships with a physical binding snapshot`, async () => {
    const s = await stock(); const order = await pl([s], { kind }); await load(s, order)
    const result = await confirm(order); expect(result.postedUnits).toBe(1)
    expect((await pool.query('SELECT status FROM inventory_unit WHERE id=$1', [s.unitId])).rows[0]!.status).toBe('shipped')
    expect((await pool.query('SELECT quantity::text,status FROM stock_balance WHERE id=$1', [s.balanceId])).rows).toEqual([{ quantity: '0.0000', status: 'closed' }])
    const snapshot = (await pool.query('SELECT actual_axis_snapshot FROM shipment_order WHERE id=$1', [order.shipmentOrderId])).rows[0]!.actual_axis_snapshot
    expect(snapshot.physicalBindings).toEqual([expect.objectContaining({ unitId: s.unitId, quantity: '20.0000', sourceOrderIds: [s.productionOrderId] })])
  })
  it('automatic matching uses exactly the same physical identity gate', async () => {
    const s = await stock(); const order = await pl([s])
    const result = await committed(shipping, 'shipping.scan.load', { plantId, shipmentOrderId: order.shipmentOrderId, unitNo: s.unitNo })
    expect(result.lineId).toBe(order.lineIds[0]); expect((await confirm(order)).postedUnits).toBe(1)
  })
  for (const automatic of [false,true]) for (const mismatch of ['material','sales-order','sales-line','segment','quantity','UOM','unknown'] as const) {
    it(`${automatic ? 'automatic' : 'explicit'} line selection rejects ${mismatch}`, async () => {
      const s = await stock({ withoutOrigin: mismatch === 'unknown', quantity: mismatch === 'quantity' ? '21.0000' : undefined })
      if (mismatch === 'sales-order') await pool.query('UPDATE production_order SET sales_order_no=$2 WHERE id=$1', [s.productionOrderId, 'OTHER-SO'])
      if (mismatch === 'sales-line') await pool.query("UPDATE production_order SET line_no='OTHER-LINE' WHERE id=$1", [s.productionOrderId])
      if (mismatch === 'UOM') await pool.query("UPDATE production_order SET uom='KG' WHERE id=$1", [s.productionOrderId])
      const line = mismatch === 'material' ? { ...s, materialCode: 'OTHER-MATERIAL', materialId: null as unknown as string } : s
      const order = await pl([line], { segment: mismatch === 'segment' ? '19.0000' : undefined })
      await denied('shipping.scan.load', { plantId, shipmentOrderId: order.shipmentOrderId, unitNo: s.unitNo, ...(automatic ? {} : { lineId: order.lineIds[0] }) })
    })
  }
  it('rejects ambiguous automatic row selection', async () => {
    const s = await stock(); const order = await pl([s, s])
    await denied('shipping.scan.load', { plantId, shipmentOrderId: order.shipmentOrderId, unitNo: s.unitNo })
  })
  for (const actualSegmentLength of ['19.0000', 20]) it(`does not trust client segment claim ${JSON.stringify(actualSegmentLength)}`, async () => {
    const s = await stock(); const order = await pl([s])
    await denied('shipping.scan.load', { plantId, shipmentOrderId: order.shipmentOrderId, lineId: order.lineIds[0], unitNo: s.unitNo, actualSegmentLength })
  })
  it('keeps an unresolved supplementary registration but rejects zero-unit shipping', async () => {
    const s = await stock(); const order = await pl([s]); const missing = `MISSING-${randomUUID()}`
    const scan = await committed(shipping, 'shipping.scan.supplement', { plantId, shipmentOrderId: order.shipmentOrderId, lineId: order.lineIds[0], unitNo: missing })
    expect(scan.inventoryIdentityStatus).toBe('UNRESOLVED'); expect(scan.inventoryUnitId).toBeNull()
    await denied('shipping.ship.confirm', { plantId, shipmentOrderId: order.shipmentOrderId })
    expect((await pool.query('SELECT status FROM shipment_order WHERE id=$1', [order.shipmentOrderId])).rows[0]!.status).toBe('ready_to_ship')
  })
  it('a known supplementary item binds to stock and posts one real unit', async () => {
    const s = await stock(); const order = await pl([s])
    const scan = await committed(shipping, 'shipping.scan.supplement', { plantId, shipmentOrderId: order.shipmentOrderId, lineId: order.lineIds[0], unitNo: s.unitNo })
    expect(scan.inventoryUnitId).toBe(s.unitId); expect((await confirm(order)).postedUnits).toBe(1)
  })
  it('later-resolved supplementary identity is frozen in outbound snapshot while original scan stays immutable', async () => {
    const s = await stock(); const order = await pl([s]); const unitNo = `LATER-${randomUUID()}`
    const scan = await committed(shipping, 'shipping.scan.supplement', { plantId, shipmentOrderId: order.shipmentOrderId, lineId: order.lineIds[0], unitNo })
    const scanBefore = (await pool.query('SELECT * FROM packing_scan WHERE id=$1', [scan.scanId])).rows[0]
    const later = await stock({ unitNo, salesOrderNo: s.salesOrderNo }); expect((await confirm(order)).postedUnits).toBe(1)
    expect((await pool.query('SELECT * FROM packing_scan WHERE id=$1', [scan.scanId])).rows[0]).toEqual(scanBefore)
    const actual = (await pool.query('SELECT actual_axis_snapshot FROM shipment_order WHERE id=$1', [order.shipmentOrderId])).rows[0]!.actual_axis_snapshot
    expect(actual.physicalBindings[0]).toMatchObject({ scanId: scan.scanId, unitId: later.unitId, scanKind: 'supplement' })
  })
  it('a known wrong-sales-line unit cannot enter through supplementary registration', async () => {
    const s = await stock(); const order = await pl([s]); const wrong = await stock({ salesOrderNo: s.salesOrderNo, salesOrderLineNo: '2' })
    await denied('shipping.scan.supplement', { plantId, shipmentOrderId: order.shipmentOrderId, lineId: order.lineIds[0], unitNo: wrong.unitNo })
  })
  it('an unresolved registration cannot later resolve to a different commercial source', async () => {
    const s = await stock(); const order = await pl([s]); const unitNo = `LATER-WRONG-${randomUUID()}`
    await committed(shipping, 'shipping.scan.supplement', { plantId, shipmentOrderId: order.shipmentOrderId, lineId: order.lineIds[0], unitNo })
    await stock({ unitNo }); await denied('shipping.ship.confirm', { plantId, shipmentOrderId: order.shipmentOrderId })
  })
  it('progress counters cannot substitute for missing scans', async () => {
    const s = await stock(); const order = await pl([s], { count: 2 }); await load(s, order)
    await pool.query("UPDATE shipment_line SET scanned_count=2,line_status='packed' WHERE id=$1", [order.lineIds[0]])
    await pool.query("UPDATE shipment_order SET status='ready_to_ship' WHERE id=$1", [order.shipmentOrderId])
    await denied('shipping.ship.confirm', { plantId, shipmentOrderId: order.shipmentOrderId })
  })
  for (const changed of ['quantity','origin'] as const) it(`confirmation rereads ${changed} after scan`, async () => {
    const s = await stock(); const order = await pl([s]); await load(s, order)
    if (changed === 'quantity') await pool.query('UPDATE stock_balance SET quantity=19 WHERE id=$1', [s.balanceId])
    else await pool.query("UPDATE production_report SET review_status='pending_review',review_cancelled_at=clock_timestamp() WHERE id=$1", [s.reportId])
    await denied('shipping.ship.confirm', { plantId, shipmentOrderId: order.shipmentOrderId })
  })
  it('multiple incompatible approved origins are UNKNOWN', async () => {
    const s = await stock(); await origin(s, { salesOrderNo: 'OTHER-SALES' }); const order = await pl([s])
    await denied('shipping.scan.load', { plantId, shipmentOrderId: order.shipmentOrderId, lineId: order.lineIds[0], unitNo: s.unitNo })
  })
  for (const gate of ['quality','business','reservation'] as const) it(`late ${gate} rejection leaves all first/second-unit facts unchanged and replays rejection`, async () => {
    const first = await stock(); const second = await stock({ salesOrderNo: first.salesOrderNo }); const order = await pl([first], { count: 2 })
    await load(first, order); await load(second, order)
    if (gate === 'quality') {
      await committed(quality, 'quality.suspect.register', { plantId, unitId: second.unitId })
      await pool.query("UPDATE stock_balance SET quality_status='qualified' WHERE id=$1", [second.balanceId])
    } else if (gate === 'business') {
      await committed(inventory, 'inventory.business-hold.establish', { unitIds: [second.unitId], reason: 'PR04 custody', businessRef: randomUUID() })
    } else await committed(inventory, 'inventory.reservation.acquire', { unitId: second.unitId, quantity: '1.0000', holderType: 'task', holderRef: 'PR04-other-task', validUntil: new Date(Date.now()+3_600_000).toISOString() })
    await denied('shipping.ship.confirm', { plantId, shipmentOrderId: order.shipmentOrderId }, gate === 'quality' ? 'A-T12-2' : gate === 'business' ? 'IT-BUSINESS-HOLD' : 'A-T14-7')
    expect((await pool.query('SELECT quantity::text,status FROM stock_balance WHERE id=ANY($1::uuid[]) ORDER BY id', [[first.balanceId, second.balanceId]])).rows)
      .toEqual([{ quantity: '20.0000', status: 'active' }, { quantity: '20.0000', status: 'active' }])
  })
})
