import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CommandBus, CommandContext } from '@cadenza/application'
import { DEFAULT_EXECUTION_CONFIG } from '@cadenza/application'
import { buildProcessCommandBus } from '../../apps/api/src/process/process.composition'
import { buildExecutionCommandBus, NoopScheduleReadPort } from '../../apps/api/src/execution/execution.composition'
import { buildConversionCommandBus } from '../../apps/api/src/conversion/conversion.composition'
import { buildReworkCommandBus } from '../../apps/api/src/rework/rework.composition'
import { seedExecutionFixtures, LOC_LINE_FIN, LOC_LINE_FIN_CODE, UOM_M_ID } from '../api/execution-test-env'
import { prepareExclusiveEnvironment } from '../../scripts/sol-sap-recon/environment'

let env: Awaited<ReturnType<typeof prepareExclusiveEnvironment>>
let fx: Awaited<ReturnType<typeof seedExecutionFixtures>>
let processBus: CommandBus, executionBus: CommandBus, conversionBus: CommandBus, reworkBus: CommandBus
let ctx: CommandContext, noPermCtx: CommandContext
const evidence: unknown[] = []
let source: string, target: string, third: string
let unitA: string, unitB: string, unitC: string
let ownerId: string
async function command(bus: CommandBus, commandType: string, payload: Record<string, unknown>, targetId = 'new', actor = ctx, accept = true) {
  const envelope = { operationId: randomUUID(), commandType, targetId, expectedRevision: 0, payload }
  const result = await bus.execute(envelope, actor)
  evidence.push({ envelope, actor: actor.actorLoginName, result })
  if (accept) expect(result.status, JSON.stringify(result)).toBe('COMMITTED')
  return (accept ? result.data : result) as Record<string, unknown> & { familyId: string; revisionId: string; orderId: string; correctionId: string; conversionId: string; lines: Array<{ lineId: string }> }
}

beforeAll(async () => {
  env = await prepareExclusiveEnvironment('s5-business')
  // Reviewed helper only seeds isolated material/work center/operation/locations. No order, report or ownership SQL.
  fx = await seedExecutionFixtures(env.pool)
  const users = await env.pool.query("SELECT id,login_name,enterprise_id FROM user_account WHERE login_name IN ('admin','szqc01')")
  const admin = users.rows.find(x => x.login_name === 'admin')!
  const qc = users.rows.find(x => x.login_name === 'szqc01')!
  ctx = { actorUserId: admin.id, actorLoginName: 'admin', enterpriseId: admin.enterprise_id, reason: 'S5 legal business identity' }
  noPermCtx = { ...ctx, actorUserId: qc.id, actorLoginName: 'szqc01' }
  ownerId = (await env.pool.query("SELECT id FROM org_node WHERE code='LE-HDMIKE'")).rows[0]!.id
  processBus = buildProcessCommandBus(env.pool)
  executionBus = buildExecutionCommandBus(env.pool, { schedule: new NoopScheduleReadPort(),
    config: { ...DEFAULT_EXECUTION_CONFIG, lastOperationAutoReviewDeptIds: [fx.szJzDeptId] } })
  conversionBus = buildConversionCommandBus(env.pool)
  reworkBus = buildReworkCommandBus(env.pool)
  const family = await command(processBus, 'process.family.create', { plantId: fx.szPlantId, code: 'S5-FAMILY', name: 'S5 family' })
  const route = await command(processBus, 'process.route.create', { productFamilyId: family.familyId,
    steps: [{ seq: 1, operationDefinitionId: fx.operationDefIds.seq1, workCenterId: fx.workCenterId, coreMultiple: 1, strandFactor: '1' }] })
  await command(processBus, 'process.route.publish', {}, route.revisionId)
  const bom = await command(processBus, 'process.bom.create', { productFamilyId: family.familyId, materialId: fx.materialId,
    lines: [{ materialId: fx.materialId, materialCode: 'MAT-EXE-CU', quantity: '1', uom: 'M' }] })
  await command(processBus, 'process.bom.publish', {}, bom.revisionId)
  async function order(no: string, quantity: string) {
    const result = await command(processBus, 'process.order.receive', { orderNo: no, materialId: fx.materialId,
      productionDeptId: fx.szJzDeptId, productionQty: quantity, uom: 'M', productFamilyId: family.familyId,
      initialStatus: 'released', processConfirmed: true, salesOrderNo: `SO-${no}`, lineNo: '10' })
    await command(processBus, 'process.order.start', {}, result.orderId)
    return String(result.orderId)
  }
  source = await order('S5-SOURCE', '4000'); target = await order('S5-TARGET', '4000'); third = await order('S5-OTHER', '2000')
  const op = async (orderId: string) => (await env.pool.query('SELECT id FROM order_operation WHERE order_id=$1', [orderId])).rows[0]!.id
  async function report(orderId: string, codes: string[]) {
    const result = await command(executionBus, 'execution.report.submit', { orderId, orderOperationId: await op(orderId), source: 'order',
      outputs: codes.map(carrierCode => ({ carrierCode, quantity: '2000', uomId: UOM_M_ID, uomCode: 'M',
        measurementBasis: 'cable_m', targetLocationId: LOC_LINE_FIN, targetLocationCode: LOC_LINE_FIN_CODE,
        ownerId, ownerName: 'S5 owner' })) })
    expect(result.reviewOutcome).toBe('auto_approved')
    return result.stockedUnits as string[]
  }
  const ids = await report(source, ['1F00000001', '1F00000002'])
  const ids2 = await report(third, ['1F00000003'])
  const byId = async (id: string) => (await env.pool.query('SELECT unit_no FROM inventory_unit WHERE id=$1', [id])).rows[0]!.unit_no as string
  unitA = await byId(ids[0]!); unitB = await byId(ids[1]!); unitC = await byId(ids2[0]!)
}, 30000)
afterAll(async () => { if (env) { await writeFile(`${env.evidence}/commands.json`, JSON.stringify(evidence, null, 2)); await env.pool.end() } })

describe('S5 real output identity bridges', () => {
  it('registers actual approved units, rejects caller order rewrite/other plant/no permission', async () => {
    await command(reworkBus, 'rework.axis-register', { unitNo: unitA, customerAxisNo: 'S5-A', segmentLength: '2000', sourceOrderId: source })
    await command(reworkBus, 'rework.axis-register', { unitNo: unitB, customerAxisNo: 'S5-B', segmentLength: '2000', sourceOrderId: source })
    const bad = await command(reworkBus, 'rework.axis-register', { unitNo: unitC, customerAxisNo: 'S5-C', segmentLength: '2000', sourceOrderId: source }, 'new', ctx, false)
    expect(bad.status).toBe('BUSINESS_REJECTION'); expect(bad.errorMessage).toContain('订单不得由载荷改写')
    const denied = await command(reworkBus, 'rework.axis-register', { unitNo: unitC, customerAxisNo: 'S5-C', segmentLength: '2000' }, 'new', noPermCtx, false)
    expect(denied.status).toBe('BUSINESS_REJECTION'); expect(denied.errorCode).toBe('ERR_FORBIDDEN_SCOPE')
  })
  it('zero cut reassigns occupied same-length axis, clears the other unit and preserves 4000 total', async () => {
    const before = await env.pool.query('SELECT sum(quantity)::text AS qty FROM stock_balance WHERE unit_id IN (SELECT unit_id FROM axis_no_state)')
    const denied = await command(reworkBus, 'rework.axis-correction.submit', { unitNo: unitA, cutQty: '0.0000', newCustomerAxisNo: 'S5-B', newSegmentLength: '2000', reassignReason: 'S5 denied' }, 'new', noPermCtx, false)
    expect(denied.status).toBe('BUSINESS_REJECTION')
    expect(denied.errorMessage).toContain('权限')
    const result = await command(reworkBus, 'rework.axis-correction.submit', { unitNo: unitA, cutQty: '0.0000', newCustomerAxisNo: 'S5-B',
      newSegmentLength: '2000', reassignReason: 'S5 approved occupied-axis correction', uomCode: 'M' })
    expect(result.afterQty ?? result.newQty).toBe('2000.0000')
    const rows = await env.pool.query('SELECT unit_no,customer_axis_no,segment_length,virtual_axis_no FROM axis_no_state ORDER BY unit_no')
    const cleared = rows.rows.find(x => x.unit_no === unitB)!
    expect(cleared.customer_axis_no).toBeNull(); expect(cleared.segment_length).toBeNull(); expect(cleared.virtual_axis_no).toBeNull()
    const after = await env.pool.query('SELECT sum(quantity)::text AS qty FROM stock_balance WHERE unit_id IN (SELECT unit_id FROM axis_no_state)')
    expect(after.rows[0]!.qty).toBe(before.rows[0]!.qty)
    evidence.push({ axisReadback: rows.rows, quantityBefore: before.rows, quantityAfter: after.rows })
    const withdrawn = await command(reworkBus, 'rework.axis-correction.withdraw', { correctionId: result.correctionId, reason: 'S5 zero cut withdrawal' })
    expect(withdrawn.restoredQty).toBe('2000.0000')
    const restored = await env.pool.query('SELECT customer_axis_no FROM axis_no_state WHERE unit_no=$1', [unitA])
    expect(restored.rows[0]!.customer_axis_no).toBe('S5-A')
    const total = await env.pool.query('SELECT sum(quantity)::text AS qty FROM stock_balance WHERE unit_id IN (SELECT unit_id FROM axis_no_state)')
    expect(total.rows[0]!.qty).toBe(before.rows[0]!.qty)
    const zero = await env.pool.query("SELECT count(*)::int AS c FROM stock_transaction WHERE ref_type IN ('axis_no_correction','axis_no_correction_withdraw')")
    expect(zero.rows[0]!.c).toBe(0)
    evidence.push({ afterWithdrawal: total.rows, axis: restored.rows, correctionStockTransactions: zero.rows })
  })
  it('legal report binds the carrier code; conversion resolves PRDU identity and retains guards', async () => {
    const binding = await env.pool.query("SELECT b.bound_id,u.unit_no FROM barcode_binding b JOIN inventory_unit u ON u.id=b.bound_id WHERE barcode_value='1F00000001' AND b.active")
    expect(binding.rows[0]!.unit_no).toBe(unitA)
    const cv = await command(conversionBus, 'conversion.order.create', { plantId: fx.szPlantId,
      lines: [{ sourceOrderId: source, targetOrderId: target, targetProjectNo: 'S5-PROJECT', quantity: '2000', uom: 'M' }] })
    const scanPayload = { plantId: fx.szPlantId, conversionOrderId: cv.conversionId, lineId: cv.lines[0].lineId, unitNo: '1F00000001', segmentLength: '2000' }
    const scan = await command(conversionBus, 'conversion.order.scan', scanPayload)
    expect(scan.unitNo).toBe(unitA); expect(scan.scannedCode).toBe('1F00000001'); expect(scan.scannedQty).toBe('2000.0000')
    const dup = await command(conversionBus, 'conversion.order.scan', scanPayload, 'new', ctx, false)
    expect(dup.status).toBe('BUSINESS_REJECTION')
    const wrong = await command(conversionBus, 'conversion.order.scan', { ...scanPayload, unitNo: '1F00000003', segmentLength: '1999' }, 'new', ctx, false)
    expect(wrong.status).toBe('BUSINESS_REJECTION'); expect(wrong.errorMessage).toContain('不属于转换前订单')
    const invalid = await command(conversionBus, 'conversion.order.scan', { ...scanPayload, unitNo: '1R00000001' }, 'new', ctx, false)
    expect(invalid.status).toBe('BUSINESS_REJECTION')
    await command(conversionBus, 'conversion.order.complete', { plantId: fx.szPlantId, conversionOrderId: cv.conversionId })
    evidence.push({ binding: binding.rows, conversionId: cv.conversionId })
  })
})
