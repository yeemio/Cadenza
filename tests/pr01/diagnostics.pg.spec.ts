import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher, type CommandBus, type CommandContext } from '@cadenza/application'
import { buildPurchaseCommandBus } from '../../apps/api/src/purchase/purchase.composition'
import { buildShippingCommandBus } from '../../apps/api/src/shipping/shipping.composition'

// Full repositories and migrations, in a NEW empty database only. Do not call
// the legacy prepare* helpers: those drop fixed database names. Keep this DB
// after the run so the controller can inspect its facts and receipts.
const url = process.env['CADENZA_PR01_DIAGNOSTICS_DB_URL']
if (!url || !/^cadenza_pr01_diag_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) {
  throw new Error('NOT_RUN: CADENZA_PR01_DIAGNOSTICS_DB_URL must name a new cadenza_pr01_diag_* database')
}
const pool = createPool(url, { max: 4 })
let context: CommandContext
let plantId: string
let purchase: CommandBus
let shipping: CommandBus

beforeAll(async () => {
  const existing = await pool.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'`)
  if (existing.rowCount !== 0) throw new Error('Refusing to migrate a nonempty diagnostic test database')
  await migrateUp(pool, migrations)
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  const admin = (await pool.query<{ id: string; enterprise_id: string }>(
    "SELECT id,enterprise_id FROM user_account WHERE login_name='admin'",
  )).rows[0]!
  context = { actorUserId: admin.id, actorLoginName: 'admin', enterpriseId: admin.enterprise_id }
  plantId = (await pool.query<{ id: string }>("SELECT id FROM org_node WHERE code='PLNT-SZ'")).rows[0]!.id
  purchase = buildPurchaseCommandBus(pool)
  shipping = buildShippingCommandBus(pool)
})
afterAll(async () => { await pool.end() })

function command(commandType: string, payload: Record<string, unknown>) {
  return { commandType, operationId: randomUUID(), targetId: 'new', expectedRevision: 0, payload }
}

async function businessCounts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM purchase_order) AS purchase_orders,
    (SELECT count(*)::int FROM purchase_order_line) AS purchase_lines,
    (SELECT count(*)::int FROM shipment_order) AS shipment_orders,
    (SELECT count(*)::int FROM shipment_line) AS shipment_lines,
    (SELECT count(*)::int FROM dc_segment_composition) AS compositions,
    (SELECT count(*)::int FROM stock_transaction) AS transactions,
    (SELECT count(*)::int FROM stock_entry) AS entries,
    (SELECT count(*)::int FROM audit_entry) AS audits,
    (SELECT count(*)::int FROM outbox) AS outbox`)).rows[0]
}

describe('actual quarantine handlers retain only their deliberate Inbox fact', () => {
  it.each(['purchase', 'pl', 'dc'] as const)('%s missing organization mapping is durable and replayable', async (kind) => {
    const external = `PR01-${kind}-${randomUUID()}`
    const payload: Record<string, unknown> = kind === 'purchase'
      ? { sourceSystem: 'ERP', orgCode: 'PR01-NO-MAPPING', orderNo: external, lines: [] }
      : kind === 'pl'
        ? { sourceSystem: 'PL', orgCode: 'PR01-NO-MAPPING', plNo: external, salesOrderNo: external, lines: [] }
        : { sourceSystem: 'ERP', orgCode: 'PR01-NO-MAPPING', dcId: external, salesOrderNo: external, lineNo: 1 }
    const type = kind === 'purchase' ? 'purchase.order-sync'
      : kind === 'pl' ? 'shipping.pl.inbound' : 'shipping.dc-composition.inbound'
    const entityType = kind === 'purchase' ? 'purchase_order'
      : kind === 'pl' ? 'shipping_pl' : 'segment_composition'
    const externalKey = kind === 'dc' ? `${external}+${external}+1` : external
    const bus = kind === 'purchase' ? purchase : shipping
    const envelope = command(type, payload)
    const before = await businessCounts()
    const first = await bus.execute(envelope, context)
    expect(first.status).toBe('BUSINESS_REJECTION')
    expect(first.errorMessage).toContain('IF-00.8')
    expect(await bus.execute(envelope, context)).toEqual(first)
    expect(await businessCounts()).toEqual(before)
    const inbox = await pool.query('SELECT status,payload FROM inbox WHERE external_key=$1 AND entity_type=$2', [externalKey, entityType])
    expect(inbox.rows).toEqual([{ status: 'QUARANTINED', payload }])
    const receipt = await pool.query('SELECT status,result FROM command_receipt WHERE operation_id=$1', [envelope.operationId])
    expect(receipt.rows).toHaveLength(1)
    expect(receipt.rows[0]!.status).toBe('BUSINESS_REJECTION')
    expect(receipt.rows[0]!.result).toEqual(JSON.parse(JSON.stringify(first)))
    expect(receipt.rows[0]!.result).not.toHaveProperty('persistRejectionDiagnostics')
  })

  it('the actual per-photo contract commits accepted rows and replays both row outcomes', async () => {
    const plNo = `PR01-PHOTOS-${randomUUID()}`
    const order = (await pool.query<{ id: string }>(
      `INSERT INTO shipment_order(pl_no,sales_order_no,status,plant_id,enterprise_id,created_by)
       VALUES ($1,$1,'pending_packing',$2,$3,'pr01-fixture') RETURNING id`,
      [plNo, plantId, context.enterpriseId],
    )).rows[0]!
    const envelope = command('shipping.photo.attach', {
      plantId, shipmentOrderId: order.id,
      photos: [{ fileName: 'box.jpg', storageKey: 'pr01/box.jpg' }, { fileName: '', storageKey: 'invalid-row' }],
    })
    const first = await shipping.execute(envelope, context)
    expect(first.status).toBe('COMMITTED')
    const data = first.data as { attached: unknown[]; failed: unknown[] }
    expect(data.attached).toHaveLength(1)
    expect(data.failed).toHaveLength(1)
    expect(await shipping.execute(envelope, context)).toEqual(first)
    expect((await pool.query('SELECT file_name FROM shipment_photo WHERE shipment_order_id=$1', [order.id])).rows)
      .toEqual([{ file_name: 'box.jpg' }])
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_entry WHERE action='shipping.photo.attach' AND subject_id=$1", [order.id])).rows[0]!.n).toBe(1)
  })
})
