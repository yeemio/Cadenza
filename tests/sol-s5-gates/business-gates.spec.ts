import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CommandBus, CommandContext } from '@cadenza/application'
import type { CommandEnvelope, CommandResult } from '@cadenza/contracts'
import { DEFAULT_EXECUTION_CONFIG } from '@cadenza/application'
import { buildProcessCommandBus } from '../../apps/api/src/process/process.composition'
import { buildFrozenGroupSimRuntime } from '../../scripts/sol-s5-gates/runtime'
import { prepareS5GatesEnvironment } from '../../scripts/sol-s5-gates/environment'
import { seedExecutionFixtures, LOC_LINE_FIN, LOC_LINE_FIN_CODE, UOM_M_ID } from '../api/execution-test-env'

let env: Awaited<ReturnType<typeof prepareS5GatesEnvironment>>
let fx: Awaited<ReturnType<typeof seedExecutionFixtures>>
let runtime: ReturnType<typeof buildFrozenGroupSimRuntime>
let processBus: CommandBus
let ctx: CommandContext, restricted: CommandContext, noPermission: CommandContext
let clock = new Date('2026-10-22T12:00:00+08:00')
let scheduledOrder: string, n2Order: string, operationId: string, backupEquipment: string, ownerId: string
const evidence: unknown[] = []
function envelope(commandType: string, payload: Record<string, unknown>, targetId = 'new'): CommandEnvelope<Record<string, unknown>> {
  return { operationId: randomUUID(), commandType, targetId, expectedRevision: 0, payload }
}
async function execute(bus: CommandBus, commandType: string, payload: Record<string, unknown>, targetId = 'new', actor = ctx) {
  const command = envelope(commandType, payload, targetId)
  const result = await bus.execute(command, actor)
  evidence.push({ command, actor, result })
  return result
}
function data(result: CommandResult): Record<string, unknown> {
  expect(result.status, JSON.stringify(result)).toBe('COMMITTED')
  return result.data as Record<string, unknown>
}
async function snapshot() {
  const result = await env.pool.query(`SELECT
    (SELECT count(*) FROM production_report)::int reports,
    (SELECT count(*) FROM inventory_unit)::int units,
    (SELECT count(*) FROM stock_transaction)::int stock_transactions,
    (SELECT COALESCE(sum(quantity),0)::text FROM stock_balance) stock_qty,
    (SELECT count(*) FROM execution_session)::int sessions`)
  return result.rows[0] as Record<string, unknown>
}

beforeAll(async () => {
  env = await prepareS5GatesEnvironment()
  fx = await seedExecutionFixtures(env.pool)
  const users = await env.pool.query(`SELECT u.id,u.login_name,u.enterprise_id,r.alias FROM user_account u JOIN role r ON r.id=u.role_id WHERE u.login_name IN ('admin','hfadmin01','szqc01')`)
  const admin = users.rows.find(row => row.login_name === 'admin')!
  const hf = users.rows.find(row => row.alias === 'plantadmin')!
  const qc = users.rows.find(row => row.login_name === 'szqc01')!
  ctx = { actorUserId: admin.id, actorLoginName: admin.login_name, enterpriseId: admin.enterprise_id, reason: 'Frozen S5 SIM gates' }
  restricted = { actorUserId: hf.id, actorLoginName: hf.login_name, enterpriseId: hf.enterprise_id }
  noPermission = { actorUserId: qc.id, actorLoginName: qc.login_name, enterpriseId: qc.enterprise_id }
  await env.pool.query(`UPDATE scope_grant SET permissions=array_append(permissions,'group.post') WHERE principal_id=(SELECT role_id FROM user_account WHERE id=$1) AND NOT ('group.post'=ANY(permissions))`, [hf.id])
  ownerId = (await env.pool.query("SELECT id FROM org_node WHERE code='LE-HDMIKE'")).rows[0]!.id
  backupEquipment = (await env.pool.query(`INSERT INTO equipment (enterprise_id,plant_id,dept_id,work_center_id,code,name,equipment_status,created_by)
    VALUES ($1,$2,$3,$4,'CBGCN12CAB02','CN12 backup SIM fixture',1,'s5-master-seed') RETURNING id`,
  [fx.enterpriseId, fx.szPlantId, fx.szJzDeptId, fx.workCenterId])).rows[0]!.id
  processBus = buildProcessCommandBus(env.pool)
  const family = data(await execute(processBus, 'process.family.create', { plantId: fx.szPlantId, code: 'S5G-FAMILY', name: 'S5 isolated fixture' }))
  const route = data(await execute(processBus, 'process.route.create', { productFamilyId: family['familyId'], steps: [{ seq: 1,
    operationDefinitionId: fx.operationDefIds.seq1, workCenterId: fx.workCenterId, coreMultiple: 1, strandFactor: '1' }] }))
  data(await execute(processBus, 'process.route.publish', {}, String(route['revisionId'])))
  const bom = data(await execute(processBus, 'process.bom.create', { productFamilyId: family['familyId'], materialId: fx.materialId,
    lines: [{ materialId: fx.materialId, materialCode: 'MAT-EXE-CU', quantity: '1', uom: 'M' }] }))
  data(await execute(processBus, 'process.bom.publish', {}, String(bom['revisionId'])))
  const order = async (orderNo: string, quantity: string) => {
    const result = data(await execute(processBus, 'process.order.receive', { orderNo, materialId: fx.materialId, productionDeptId: fx.szJzDeptId,
      productionQty: quantity, uom: 'M', productFamilyId: family['familyId'], initialStatus: 'released', processConfirmed: true }))
    data(await execute(processBus, 'process.order.start', {}, String(result['orderId'])))
    return String(result['orderId'])
  }
  scheduledOrder = await order('CBL01G-MO-G-CN', '4000')
  n2Order = await order('CBL01G-MO-N2', '2000')
  operationId = (await env.pool.query('SELECT id FROM order_operation WHERE order_id=$1', [scheduledOrder])).rows[0]!.id
  runtime = buildFrozenGroupSimRuntime(env.pool, { enterpriseId: fx.enterpriseId, cn12PlantId: fx.szPlantId, kr22PlantId: fx.szPlantId,
    cn12BackupEquipmentId: backupEquipment, n2OrderId: n2Order, deliveryPlantId: fx.szPlantId }, () => new Date(clock),
  { ...DEFAULT_EXECUTION_CONFIG, lastOperationAutoReviewDeptIds: [fx.szJzDeptId] })
  await writeFile(`${env.evidence}/server-configuration.json`, JSON.stringify(runtime.configuration, null, 2))
})
afterAll(async () => {
  if (env) {
    await writeFile(`${env.evidence}/business-evidence.json`, JSON.stringify(evidence, null, 2))
    await env.pool.end()
  }
})

describe('Frozen NEG07/13/14/15/18 through actual SIM consumers and PostgreSQL command buses', () => {
  it('NEG07: normal backup equipment schedules before qualification expiry; expired tool blocks replacing that real slot', async () => {
    clock = new Date('2026-10-22T12:00:00+08:00')
    const allowed = envelope('scheduling.slot.save', { orderOperationId: operationId, equipmentId: backupEquipment,
      productionDate: '2026-10-22', plannedQty: '1000.0000', confirm: true })
    const positive = await runtime.service.scheduleWithTool('CBL01G-TOOL-CN12', allowed, ctx)
    data(positive)
    const before = await env.pool.query('SELECT equipment_id,planned_qty::text FROM schedule_slot WHERE order_id=$1', [scheduledOrder])
    expect(before.rows).toEqual([{ equipment_id: backupEquipment, planned_qty: '1000.0000' }])
    clock = new Date('2026-10-23T08:00:00+08:00')
    const rejected = await runtime.service.scheduleWithTool('CBL01G-TOOL-CN12', envelope('scheduling.slot.save', { ...allowed.payload,
      plannedQty: '2000.0000', qualified: true, now: '2026-10-21' }), ctx)
    expect(rejected.status).toBe('BUSINESS_REJECTION'); expect(rejected.errorMessage).toContain('SIM_TOOL_EXPIRED')
    const after = await env.pool.query('SELECT equipment_id,planned_qty::text FROM schedule_slot WHERE order_id=$1', [scheduledOrder])
    expect(after.rows).toEqual(before.rows)
    const equipment = await env.pool.query('SELECT equipment_status FROM equipment WHERE id=$1', [backupEquipment])
    expect(equipment.rows[0]!.equipment_status).toBe(1)
    evidence.push({ id: 'NEG07', classification: 'SIM_BUSINESS_REFUSAL', allowed, positive, rejected, before: before.rows, after: after.rows, equipment: equipment.rows })
  })

  it('NEG13: original CNY/KRW amounts cannot create an unlabelled total; separated proposal actually persists', async () => {
    const proposal = () => envelope('group.allocation-revision.create', { plantId: fx.szPlantId, title: 'SIM allocation proposal', reason: 'Frozen mixed-currency source' })
    const input = { amountRefs: ['CBL01G-FQ-CNY', 'CBL01G-FQ-KRW'], omitCurrency: true }
    const before = await env.pool.query('SELECT count(*)::int n FROM group_allocation_revision')
    const rejected = await runtime.service.createAllocationProposal(input, proposal(), ctx)
    expect(rejected.errorMessage).toContain('SIM_CURRENCY_REQUIRED')
    expect((await env.pool.query('SELECT count(*)::int n FROM group_allocation_revision')).rows).toEqual(before.rows)
    const accepted = await runtime.service.createAllocationProposal({ ...input, omitCurrency: false }, proposal(), ctx)
    const result = data(accepted)
    const row = await env.pool.query('SELECT payload FROM group_allocation_revision WHERE id=$1', [result['id']])
    expect(row.rows[0]!.payload.currencySummary.byCurrency).toEqual({ CNY: '15600.0000', KRW: '36400000.0000' })
    expect(row.rows[0]!.payload.currencySummary.convertedTotal).toBeNull()
    evidence.push({ id: 'NEG13', input, rejected, accepted, persisted: row.rows })
  })

  it('NEG14: m core_m cannot become the same m cable_m quantity; 3.06 rule creates only a real 4000m plan', async () => {
    const input = { referenceId: 'CBL01G-T1', sourceQty: '12240.0000', sourceBasis: 'core_m', targetQty: '12240.0000', targetBasis: 'cable_m', unit: 'm' }
    const plan = (quantity: string) => envelope('shipping.pl.inbound', { plNo: `S5G-PL-${quantity}`, salesOrderNo: 'CBL01G-SO-G', plantId: fx.szPlantId,
      lines: [{ lineKind: 'plain_item', materialCode: 'CBL01G-F2', requiredCount: 1, segmentLength: quantity }] })
    const before = await env.pool.query('SELECT count(*)::int n FROM shipment_order')
    const rejected = await runtime.service.receiveConvertedDeliveryPlan(input, plan(input.targetQty), ctx)
    expect(rejected.errorMessage).toContain('SIM_BASIS_CONVERSION')
    expect((await env.pool.query('SELECT count(*)::int n FROM shipment_order')).rows).toEqual(before.rows)
    const accepted = await runtime.service.receiveConvertedDeliveryPlan({ ...input, targetQty: '4000.0000' }, plan('4000.0000'), ctx)
    const result = data(accepted)
    const row = await env.pool.query('SELECT material_code,segment_length::text,required_count FROM shipment_line WHERE shipment_order_id=$1', [result['orderId']])
    expect(row.rows).toEqual([{ material_code: 'CBL01G-F2', segment_length: '4000.0000', required_count: 1 }])
    evidence.push({ id: 'NEG14', input, rejected, accepted, persisted: row.rows, actualShipped: false })
  })

  it('NEG15: bound permit allows actual report and inventory posting before cutoff, then blocks another otherwise in-range 500m', async () => {
    const n2Operation = (await env.pool.query('SELECT id FROM order_operation WHERE order_id=$1', [n2Order])).rows[0]!.id
    const report = (carrierCode: string) => envelope('execution.report.submit', { orderId: n2Order, orderOperationId: n2Operation, source: 'order',
      outputs: [{ carrierCode, quantity: '500.0000', measurementBasis: 'cable_m', uomId: UOM_M_ID, uomCode: 'M',
        targetLocationId: LOC_LINE_FIN, targetLocationCode: LOC_LINE_FIN_CODE, ownerId, ownerName: 'S5G owner' }] })
    clock = new Date('2026-10-28T05:59:59+09:00')
    const before = await snapshot()
    const accepted = await runtime.service.submitOfflineReport('CBL01G-PERMIT-N2', report('1G00000001'), ctx)
    expect(data(accepted)['reviewOutcome']).toBe('auto_approved')
    const afterAllowed = await snapshot()
    expect(afterAllowed['reports']).toBe(Number(before['reports']) + 1)
    expect(afterAllowed['stock_qty']).toBe('500.0000')
    expect(Number(afterAllowed['units'])).toBeGreaterThan(Number(before['units']))
    clock = new Date('2026-10-28T06:00:00+09:00')
    const attempted = report('1G00000002')
    attempted.payload = { ...attempted.payload, businessTime: '2026-10-28T05:00:00+09:00', permit: { expiresAt: '2099-01-01', confirmed: true } }
    const rejected = await runtime.service.submitOfflineReport('CBL01G-PERMIT-N2', attempted, ctx)
    expect(rejected.errorMessage).toContain('SIM_PERMIT_EXPIRED')
    const afterRejected = await snapshot()
    expect(afterRejected).toEqual(afterAllowed)
    const receipt = await env.pool.query('SELECT count(*)::int n FROM command_receipt WHERE operation_id=$1', [attempted.operationId])
    expect(receipt.rows[0]!.n).toBe(0)
    evidence.push({ id: 'NEG15', accepted, attempted, rejected, before, afterAllowed, afterRejected })
  })

  it('NEG18: forged creation flags do not confirm; unconfirmed return is persisted as waiting with zero stock movement', async () => {
    clock = new Date('2026-10-29T09:00:00Z')
    const recall = data(await execute(runtime.group, 'group.product-recall.create', { plantId: fx.szPlantId, recallNo: 'CBL01G-RECALL-GK1',
      recallScope: 'finished_product', batchNo: 'CBL01G-GK-1', materialCode: 'CBL01G-F2', title: 'Frozen GK1 SIM recall', reason: 'Frozen customer confirmation unknown',
      status: 'submitted', confirmed: true, confirmation: { state: 'CONFIRMED' }, returnedQty: '2000' }))
    const before = await snapshot()
    const result = await execute(runtime.group, 'group.product-recall.return-request', { confirmed: true, status: 'confirmed', returnedQty: '2000' }, String(recall['id']))
    expect(data(result)['returnStatus']).toBe('AWAITING_CUSTOMER_CONFIRMATION')
    expect(data(result)['returnedQty']).toBe('0.0000')
    const rows = await env.pool.query('SELECT status,payload FROM group_product_recall WHERE id=$1', [recall['id']])
    expect(rows.rows[0]!.status).toBe('draft')
    expect(rows.rows[0]!.payload.confirmation.state).toBe('AWAITING_CUSTOMER_CONFIRMATION')
    expect(rows.rows[0]!.payload.returnRequest.state).toBe('AWAITING_CUSTOMER_CONFIRMATION')
    expect(await snapshot()).toEqual(before)
    evidence.push({ id: 'NEG18', result, persisted: rows.rows, inventoryBefore: before, inventoryAfter: await snapshot() })
  })

  it('recall confirmation is locked/idempotent, permission/enterprise/plant checked; confirmed return only becomes READY', async () => {
    const id = (await env.pool.query("SELECT id FROM group_product_recall WHERE recall_no='CBL01G-RECALL-GK1'")).rows[0]!.id as string
    const before = await snapshot()
    for (const actor of [restricted, noPermission, { ...ctx, enterpriseId: randomUUID() }]) {
      const denied = await execute(runtime.group, 'group.product-recall.confirm', { confirmationRef: 'ACK-UNAUTHORIZED' }, id, actor)
      expect(denied.status).toBe('BUSINESS_REJECTION')
      expect(denied.errorCode).toBe('ERR_FORBIDDEN_SCOPE')
    }
    const confirmed = await Promise.all([execute(runtime.group, 'group.product-recall.confirm', { confirmationRef: 'SIM-CUSTOMER-ACK-GK1', confirmedAt: '2099-01-01' }, id),
      execute(runtime.group, 'group.product-recall.confirm', { confirmationRef: 'SIM-CUSTOMER-ACK-GK1' }, id)])
    for (const result of confirmed) expect(data(result)['status']).toBe('submitted')
    const final = data(await execute(runtime.group, 'group.product-recall.return-request', {}, id))
    expect(final['returnStatus']).toBe('READY_FOR_RETURN'); expect(final['returnedQty']).toBe('0.0000')
    const row = (await env.pool.query('SELECT status,payload FROM group_product_recall WHERE id=$1', [id])).rows[0]!
    expect(row.payload.confirmation.confirmedBy).toBe('admin')
    expect(row.payload.confirmation.confirmedAt).toBe(clock.toISOString())
    const audits = await env.pool.query(`SELECT action,"after" FROM audit_entry WHERE subject_id=$1 AND action='group.product-recall.confirm'`, [id])
    expect(audits.rowCount).toBe(1)
    expect(await snapshot()).toEqual(before)
    const conflicting = await execute(runtime.group, 'group.product-recall.confirm', { confirmationRef: 'DIFFERENT-ACK' }, id)
    expect(conflicting.status).toBe('BUSINESS_REJECTION')
    evidence.push({ confirmed, final, persisted: row, audit: audits.rows, inventoryBefore: before, inventoryAfter: await snapshot() })
  })
})
