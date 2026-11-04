import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AiQueryService, createScryptPasswordHasher, type CommandBus, type CommandContext, type VerifiedAuthContext } from '@cadenza/application'
import { AI_QUERY_CAPABILITY_SEEDS, type QualityStatus } from '@cadenza/domain'
import { createPool, createPgQualityRepositories, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createPgAiQueryRepositories, seedAiQueryCapabilities } from '../../packages/persistence/src/aiquery-repositories'
import { buildInventoryCommandBus, buildInventoryQueryService } from '../../apps/api/src/inventory/inventory.composition'
import { buildQualityCommandBus } from '../../apps/api/src/quality/quality.composition'
import { buildShippingCommandBus } from '../../apps/api/src/shipping/shipping.composition'

// Mandatory real PG; no fallback, database recreation, shared DB or skip path.
const url = process.env['CADENZA_PR03_TEST_DB_URL']
if (!url || !/^cadenza_pr03_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) {
  throw new Error('NOT_RUN: CADENZA_PR03_TEST_DB_URL must name a NEW empty cadenza_pr03_* PostgreSQL database')
}
const pool = createPool(url, { max: 8 })
type Payload = Record<string, unknown>
interface Stock { unitId: string; unitNo: string; balanceId: string; materialId: string; materialCode: string }
let inventory: CommandBus; let quality: CommandBus; let shipping: CommandBus
let actor: CommandContext; let other: CommandContext; let auth: VerifiedAuthContext
let plantId: string; let enterpriseId: string; let locationId: string; let location2Id: string
let familyId: string; let deptId: string; let snapshotSql: string
const uomId = randomUUID()
const warehouseCode = '0301'
const locationCode = `${warehouseCode}0001`
const location2Code = `${warehouseCode}0002`
const qa = createPgQualityRepositories(pool)
const future = () => new Date(Date.now() + 3_600_000).toISOString()
const envelope = (commandType: string, payload: Payload) => ({ commandType, payload, operationId: randomUUID(), targetId: 'pr03', expectedRevision: 0 })

async function committed(bus: CommandBus, command: string, payload: Payload, who = actor): Promise<Payload> {
  const e = envelope(command, payload); const result = await bus.execute(e, who)
  expect(result.status, JSON.stringify(result)).toBe('COMMITTED')
  expect(await bus.execute(e, who)).toEqual(result)
  return result.data as Payload
}
async function snapshot() {
  const r = await pool.query<{ table_name: string; row_count: number; content: string }>(snapshotSql)
  return Object.fromEntries(r.rows.map((row) => [row.table_name, { count: row.row_count, sha256: createHash('sha256').update(row.content).digest('hex') }]))
}
async function denied(bus: CommandBus, command: string, payload: Payload, rule: string, who = actor) {
  const before = await snapshot(); const e = envelope(command, payload); const result = await bus.execute(e, who)
  expect(result.status, JSON.stringify(result)).toBe('BUSINESS_REJECTION'); expect(result.errorMessage).toContain(rule)
  const after = await snapshot(); expect(after).toEqual(before)
  expect(await bus.execute(e, who)).toEqual(result); expect(await snapshot()).toEqual(before)
  const receipts = await pool.query('SELECT status FROM command_receipt WHERE enterprise_id=$1 AND command_type=$2 AND operation_id=$3', [who.enterpriseId, command, e.operationId])
  expect(receipts.rows).toEqual([{ status: 'BUSINESS_REJECTION' }])
  console.log('PR03_QUERY', JSON.stringify({ command, operationId: e.operationId, rule, before, after, replayUnchanged: true, receiptRows: 1 }))
}
async function stock(status: QualityStatus = 'qualified', quantity = '20.0000'): Promise<Stock> {
  const materialCode = `P03-${randomUUID().slice(0, 12)}`
  const materialId = (await pool.query<{ id: string }>(`INSERT INTO material(org_scope_id,code,name,material_type,base_uom,qc_flag,source_system)
    VALUES ($1,$2,$2,3,'M',1,'PR03') RETURNING id`, [enterpriseId, materialCode])).rows[0]!.id
  const unitNo = `U-${randomUUID()}`
  const data = await committed(inventory, 'inventory.receive-goods', { plantId, unitNo, lotNo: `L-${unitNo}`, materialId, materialCode,
    quantity, uomId, uomCode: 'M', locationId, locationCode, ownerId: enterpriseId, ownerName: 'PR03 owner', qualityStatus: status })
  return { unitId: String(data.unitId), balanceId: String(data.balanceId), unitNo, materialId, materialCode }
}
async function inspection(s: Stock, conclusion: 'qualified' | 'unqualified') {
  const order = await qa.inspectionOrders.insert({ orderNo: `Q-${randomUUID()}`, sourceType: 'work_report', sourceRef: randomUUID(),
    inspectionStage: 'finished', specCode: 'P03', specVersion: 1, unitNo: s.unitNo, materialId: s.materialId, materialCode: s.materialCode,
    quantity: '20.0000', uomId, uomCode: 'M', plantId, enterpriseId, createdBy: actor.actorLoginName })
  await qa.testResults.insert({ inspectionOrderId: order.id, version: 1, conclusion: 'pending', resultKind: 'initial', isEffective: true })
  await result(order.id, conclusion); return order.id
}
async function result(inspectionOrderId: string, conclusion: 'qualified' | 'unqualified') {
  return committed(quality, 'quality.test-result.submit', { inspectionOrderId, conclusion,
    items: [{ itemNo: 'P03', measuredValue: '1.0000', judgement: conclusion === 'qualified' ? 'pass' : 'fail' }] })
}
async function hold(s: Stock) { return String((await committed(quality, 'quality.suspect.register', { plantId, unitId: s.unitId })).holdId) }
async function restore(holdId: string) { return committed(quality, 'quality.suspect.restore', { holdId, dispositionNote: 'PR03 evidenced release of quality custody only' }) }
async function reserve(s: Stock, quantity = '10.0000') {
  return String((await committed(inventory, 'inventory.reservation.acquire', { unitId: s.unitId, quantity, holderType: 'task', holderRef: 'PR03-task', validUntil: future() })).reservationId)
}
async function balance(s: Stock) { return (await pool.query('SELECT quantity::text,quality_status,status FROM stock_balance WHERE id=$1', [s.balanceId])).rows[0]! }
async function businessHold(s: Stock) { await committed(inventory, 'inventory.business-hold.establish', { unitIds: [s.unitId], reason: 'PR03 independent custody', businessRef: randomUUID() }) }
async function readyShipment(stocks: Stock[]) {
  const plNo = `PL-${randomUUID()}`
  const order = await committed(shipping, 'shipping.pl.inbound', { plantId, plNo, salesOrderNo: `SO-${plNo}`,
    lines: stocks.map((s, i) => ({ lineNo: i + 1, lineKind: 'plain_item', materialId: s.materialId, materialCode: s.materialCode,
      salesOrderLineNo: String(i + 1), segmentLength: '20.0000', requiredCount: 1 })) })
  const shipmentOrderId = String(order.orderId)
  const lines = (await pool.query<{ id: string; line_no: number }>('SELECT id,line_no FROM shipment_line WHERE shipment_order_id=$1 ORDER BY line_no', [shipmentOrderId])).rows
  expect(lines).toHaveLength(stocks.length)
  for (const [i, s] of stocks.entries()) await committed(shipping, 'shipping.scan.load', { plantId, shipmentOrderId, lineId: lines[i]!.id, unitNo: s.unitNo, actualSegmentLength: '20.0000' })
  return shipmentOrderId
}

beforeAll(async () => {
  const tables = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
  if (tables.rowCount !== 0) throw new Error('Refusing nonempty PR03 database; supply a fresh task-owned database')
  await migrateUp(pool, migrations); await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  const users = (await pool.query<{ id: string; login_name: string; enterprise_id: string; plant_id: string; role_id: string; dept_id: string }>(
    `SELECT u.id,u.login_name,u.enterprise_id,u.plant_id,u.role_id,u.dept_id FROM user_account u
     JOIN org_node d ON d.id=u.dept_id AND d.kind='department' AND d.status='active'
     JOIN org_node p ON p.id=u.plant_id AND p.kind='plant' AND p.status='active'
     WHERE u.login_name IN ('szqc01','szws01')
       AND d.enterprise_id=u.enterprise_id AND p.enterprise_id=u.enterprise_id
       AND d.path LIKE p.path || '%' ORDER BY u.login_name`)).rows
  const first = users.find((u) => u.login_name === 'szqc01'); const second = users.find((u) => u.login_name === 'szws01')
  if (!first || !second || first.enterprise_id !== second.enterprise_id || first.plant_id !== second.plant_id) {
    throw new Error('PR03 fixture requires both seeded users and their active departments in the same enterprise and factory')
  }
  actor = { actorUserId: first.id, actorLoginName: first.login_name, enterpriseId: first.enterprise_id }
  other = { actorUserId: second.id, actorLoginName: second.login_name, enterpriseId: second.enterprise_id }
  plantId = first.plant_id; enterpriseId = first.enterprise_id
  const permissions = ['inventory.post','inventory.reserve','inventory.read','quality.post','quality.read','shipping.post','shipping.read',
    'aiquery.use','process.read','purchase.read','execution.read','scheduling.read']
  for (const who of [actor, other]) await pool.query(`INSERT INTO scope_grant(enterprise_id,principal_type,principal_id,permissions,scope_type,scope_object_id,status,created_by)
    VALUES ($1,'user',$2,$3,'plant',$4,'active','pr03-fixture')`, [enterpriseId, who.actorUserId, permissions, plantId])
  auth = { user: { id: first.id, loginName: first.login_name, displayName: first.login_name, enterpriseId, plantId, roleId: first.role_id, loginPlatform: 'WEB' },
    role: { id: first.role_id, name: 'fixture', alias: 'qc' }, session: { id: randomUUID(), expiresAt: future() },
    permissions, dataScope: { enterpriseWide: false, plantIds: [plantId] } }
  const warehouseId = (await pool.query<{ id: string }>(`INSERT INTO warehouse(enterprise_id,plant_id,dept_id,code,name,warehouse_type,material_types)
    VALUES ($1,$2,$3,$4,'PR03 warehouse','WAREHOUSE',ARRAY[3]::integer[]) RETURNING id`, [enterpriseId, plantId, first.dept_id, warehouseCode])).rows[0]!.id
  const locations = (await pool.query<{ id: string; code: string }>(`INSERT INTO storage_location(enterprise_id,plant_id,warehouse_id,location_kind,code)
    VALUES ($1,$2,$3,'NORMAL',$4),($1,$2,$3,'NORMAL',$5) RETURNING id,code`, [enterpriseId, plantId, warehouseId, locationCode, location2Code])).rows
  locationId = locations.find((l) => l.code === locationCode)!.id; location2Id = locations.find((l) => l.code === location2Code)!.id
  familyId = (await pool.query<{ id: string }>(`INSERT INTO product_family(enterprise_id,plant_id,code,name) VALUES ($1,$2,'P03','P03') RETURNING id`, [enterpriseId, plantId])).rows[0]!.id
  deptId = second.dept_id // The same seeded DEPT-SZ-JZ production department, now verified under this factory.
  inventory = buildInventoryCommandBus(pool); quality = buildQualityCommandBus(pool); shipping = buildShippingCommandBus(pool)
  await seedAiQueryCapabilities(pool, enterpriseId, AI_QUERY_CAPABILITY_SEEDS, 'pr03-fixture')
  const names = (await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'command_receipt' ORDER BY tablename")).rows.map((r) => r.tablename)
  snapshotSql = names.map((name) => `SELECT '${name.replaceAll("'", "''")}'::text AS table_name,count(*)::int AS row_count,
    coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS content FROM "${name.replaceAll('"','""')}" t`).join(' UNION ALL ')
})
afterAll(async () => { await pool.end() })

describe('PR03 quality facts, isolation and restoration on real PostgreSQL', () => {
  it('qualified test and release cannot remove an active hold', async () => {
    const s = await stock(); const id = await inspection(s, 'qualified'); const h = await hold(s)
    await result(id, 'qualified'); await committed(quality, 'quality.disposition.release', { inspectionOrderId: id })
    expect((await balance(s)).quality_status).toBe('suspect'); expect((await qa.holds.findById(h))?.status).toBe('active')
    await denied(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '1.0000' }, 'IT-14')
  })
  it('a current concession remains isolated until explicit hold restoration', async () => {
    const s = await stock(); const id = await inspection(s, 'unqualified'); const h = await hold(s)
    await committed(quality, 'quality.disposition.concession', { inspectionOrderId: id, basedOnVersion: 2, reason: 'PR03 concession' })
    expect((await balance(s)).quality_status).toBe('suspect'); expect((await qa.testResults.findEffective(id))?.conclusion).toBe('unqualified')
    expect((await restore(h)).restoredQualityStatus).toBe('qualified')
    await committed(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '1.0000' })
  })
  it('old qualified pre-hold snapshot cannot override a new unqualified result', async () => {
    const s = await stock(); const id = await inspection(s, 'qualified'); const h = await hold(s)
    await result(id, 'unqualified'); expect((await restore(h)).restoredQualityStatus).toBe('unqualified')
    expect((await balance(s)).quality_status).toBe('unqualified')
    await denied(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '1.0000' }, 'IT-14')
  })
  it('old unqualified pre-hold snapshot does not undo a new qualified result', async () => {
    const s = await stock(); const id = await inspection(s, 'unqualified'); const h = await hold(s)
    await result(id, 'qualified'); expect((await restore(h)).restoredQualityStatus).toBe('qualified')
  })
  it('a concession for version 2 cannot release a later unqualified version 3', async () => {
    const s = await stock(); const id = await inspection(s, 'unqualified')
    await committed(quality, 'quality.disposition.concession', { inspectionOrderId: id, basedOnVersion: 2, reason: 'PR03 old concession' })
    const h = await hold(s); await result(id, 'unqualified'); expect((await restore(h)).restoredQualityStatus).toBe('unqualified')
    expect((await qa.dispositions.listByOrder(id))).toHaveLength(1); expect((await qa.testResults.findEffective(id))?.version).toBe(3)
  })
  it('a new version can receive its own disposition while the old one stays in history', async () => {
    const s = await stock(); const id = await inspection(s, 'qualified')
    await committed(quality, 'quality.disposition.release', { inspectionOrderId: id }); await result(id, 'unqualified')
    await committed(quality, 'quality.disposition.concession', { inspectionOrderId: id, basedOnVersion: 3, reason: 'PR03 new version' })
    expect((await qa.dispositions.listByOrder(id)).map((d) => d.basedOnVersion).sort()).toEqual([2,3])
  })
  it('plain stock without a later inspection retains its evidenced pre-hold quality', async () => {
    const s = await stock(); const h = await hold(s); expect((await restore(h)).restoredQualityStatus).toBe('qualified')
  })
  it('hold restoration preserves independent business custody and zero availability', async () => {
    const s = await stock(); const id = await inspection(s, 'qualified'); await businessHold(s); const h = await hold(s)
    await result(id, 'qualified'); await restore(h)
    expect((await pool.query('SELECT id FROM inventory_business_hold WHERE unit_id=$1', [s.unitId])).rows).toHaveLength(1)
    await denied(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '1.0000' }, 'IT-14')
  })
  it('final ship confirmation rechecks the hold after successful load scans and rolls back all units', async () => {
    const first = await stock(); const second = await stock(); const order = await readyShipment([first, second]); await hold(second)
    // Explicit legacy/corruption fixture: a qualified projection is not a release of the independent hold.
    await pool.query("UPDATE stock_balance SET quality_status='qualified' WHERE id=$1", [second.balanceId])
    await denied(shipping, 'shipping.ship.confirm', { plantId, shipmentOrderId: order }, 'A-T12-2')
    expect((await balance(first)).quantity).toBe('20.0000'); expect((await balance(second)).quantity).toBe('20.0000')
  })
})

describe('PR03 reservation allocation has no quality or ownership bypass', () => {
  for (const status of ['pending_inspection','unqualified','suspect'] as QualityStatus[]) {
    for (const own of [false,true]) it(`${status} rejects issue with ${own ? 'own prior reservation' : 'no reservation'}`, async () => {
      const s = await stock(); const reservationId = own ? await reserve(s) : undefined
      // A persisted post-reservation quality deterioration, read by the real command under its unit lock.
      await pool.query('UPDATE stock_balance SET quality_status=$2 WHERE id=$1', [s.balanceId, status])
      await denied(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '5.0000', ...(reservationId ? { reservationId } : {}) }, 'IT-14')
    })
    it(`${status} cannot acquire new reservation despite positive gross stock`, async () => {
      const s = await stock(status)
      await denied(inventory, 'inventory.reservation.acquire', { unitId: s.unitId, quantity: '5.0000', holderType: 'task', holderRef: 'P03', validUntil: future() }, 'IT-23')
    })
  }
  it('quality hold prevents consuming an own reservation after a qualified reinspection', async () => {
    const s = await stock(); const reservationId = await reserve(s); const id = await inspection(s, 'qualified'); await hold(s); await result(id, 'qualified')
    await denied(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '5.0000', reservationId }, 'IT-14')
  })
  for (const kind of ['quality','business']) it(`${kind} custody prevents new reservation`, async () => {
    const s = await stock(); if (kind === 'quality') await hold(s); else await businessHold(s)
    await denied(inventory, 'inventory.reservation.acquire', { unitId: s.unitId, quantity: '5.0000', holderType: 'task', holderRef: 'P03', validUntil: future() }, 'IT-23')
  })
  it('a different actor cannot consume a known reservation even with the exact holder reference', async () => {
    const s = await stock(); const reservationId = await reserve(s)
    await denied(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '5.0000', reservationId, holderType: 'task', holderRef: 'PR03-task' }, 'IT-23', other)
  })
  it('a different actor cannot release the reservation to free its allocation', async () => {
    const s = await stock(); const reservationId = await reserve(s)
    await denied(inventory, 'inventory.reservation.release', { reservationId }, 'IT-23', other)
  })
  it('own reservation cannot be reassigned to a different business reference', async () => {
    const s = await stock(); const reservationId = await reserve(s)
    await denied(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '5.0000', reservationId, refType: 'task', refId: 'another-task' }, 'IT-23')
  })
  it('matching holder fields cannot conceal a contradictory posting reference', async () => {
    const s = await stock(); const reservationId = await reserve(s)
    await denied(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '5.0000', reservationId,
      holderType: 'task', holderRef: 'PR03-task', refType: 'task', refId: 'different-task' }, 'IT-23')
  })
  it('a reservation at another location cannot be consumed', async () => {
    const s = await stock(); const reservationId = await reserve(s)
    // Persist a malformed association explicitly; no repository substitution.
    await pool.query('UPDATE reservation SET location_id=$2 WHERE id=$1', [reservationId, location2Id])
    await denied(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '5.0000', reservationId }, 'IT-23')
  })
  it('expired reference rejects while unreserved stock remains usable', async () => {
    const s = await stock(); const reservationId = await reserve(s)
    await pool.query("UPDATE reservation SET acquired_at=clock_timestamp()-interval '2 seconds',valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [reservationId])
    await denied(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '5.0000', reservationId }, 'IT-23')
    await committed(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '5.0000' })
  })
  it('valid own reservation consumes only its own allocation and preserves a competing one', async () => {
    const s = await stock(); const reservationId = await reserve(s, '10.0000')
    const competing = String((await committed(inventory, 'inventory.reservation.acquire', { unitId: s.unitId, quantity: '10.0000', holderType: 'task', holderRef: 'other-task', validUntil: future() }, other)).reservationId)
    await denied(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '1.0000' }, 'IT-14')
    await committed(inventory, 'inventory.issue-material', { unitId: s.unitId, quantity: '5.0000', reservationId })
    expect((await balance(s)).quantity).toBe('15.0000')
    const rows = (await pool.query<{ id: string; quantity: string; status: string }>('SELECT id,quantity::text,status FROM reservation WHERE unit_id=$1', [s.unitId])).rows
    expect(rows.find((r) => r.id === reservationId)).toMatchObject({ quantity: '5.0000', status: 'active' })
    expect(rows.find((r) => r.id === competing)).toMatchObject({ quantity: '10.0000', status: 'active' })
    await committed(inventory, 'inventory.reservation.release', { reservationId })
  })
})

describe('PR03 same physical stock in inventory and AI deterministic queries', () => {
  for (const kind of ['business','quality','reservation','none']) it(`same quantity and reasons for ${kind}`, async () => {
    const s = await stock()
    if (kind === 'business') await businessHold(s)
    if (kind === 'quality') await hold(s)
    if (kind === 'reservation') await reserve(s, '6.0000')
    const bomId = (await pool.query<{ id: string }>(`INSERT INTO manufacturing_bom_revision(enterprise_id,plant_id,product_family_id,material_id,version,status,lines)
      VALUES ($1,$2,$3,$4,1,'published',$5::jsonb) RETURNING id`, [enterpriseId,plantId,familyId,s.materialId,JSON.stringify([{materialId:s.materialId,materialCode:s.materialCode,quantity:'1.0000',uom:'M'}])])).rows[0]!.id
    const orderId = (await pool.query<{ id: string }>(`INSERT INTO production_order(enterprise_id,plant_id,order_no,material_id,production_dept_id,production_qty,uom,bom_revision_id)
      VALUES ($1,$2,$3,$4,$5,1,'M',$6) RETURNING id`, [enterpriseId,plantId,`ORDER-${randomUUID()}`,s.materialId,deptId,bomId])).rows[0]!.id
    const now = new Date(); const inv = await buildInventoryQueryService(pool).listBalances(auth, { materialCode: s.materialCode, now: now.toISOString() })
    expect(inv.items).toHaveLength(1)
    const repos = createPgAiQueryRepositories(pool)
    const session = await repos.sessions.insert({ enterpriseId, userId: actor.actorUserId, channel: 'mock', conversationRef: randomUUID() })
    const response = await new AiQueryService({ repos, now: () => now }).execute({ requestId: randomUUID(), toolCallSeq: 1, sessionId: session.id,
      capabilityId: 'aq.material-shortage', capabilityVersion: 1, params: { orderRef: { kind: 'orderId', value: orderId } } })
    expect(response.status, JSON.stringify(response)).toBe('ok_with_data')
    if (response.data?.capabilityId !== 'aq.material-shortage') throw new Error('Missing real AI query result')
    const line = response.data.lines[0]!; const row = inv.items[0]!
    expect(line.availability).toEqual({ grossQty: row.quantity, reservedQty: row.reservedQuantity, availableQty: row.availableQuantity })
    if (row.unavailableReasons.length > 0) expect(response.contextEcho.notes.join('\n')).toContain(`库存单元 ${s.unitId} 可用量限制：${row.unavailableReasons.join(',')}`)
    expect(row.availableQuantity).toBe(kind === 'business' || kind === 'quality' ? '0.0000' : kind === 'reservation' ? '14.0000' : '20.0000')
    console.log('PR03_AVAILABILITY', JSON.stringify({ unitId: s.unitId, kind, inventory: row, ai: line.availability, notes: response.contextEcho.notes }))
  })
})
