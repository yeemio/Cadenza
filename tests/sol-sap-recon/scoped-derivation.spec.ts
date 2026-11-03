import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PgSapReconDerivationRepository } from '@cadenza/persistence'
import { SapReconDerivationQueryService, type VerifiedAuthContext, type CommandContext } from '@cadenza/application'
import { SAP_RECON_PERMISSIONS } from '@cadenza/domain'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { prepareExclusiveEnvironment } from '../../scripts/sol-sap-recon/environment'

let env: Awaited<ReturnType<typeof prepareExclusiveEnvironment>>
let service: SapReconDerivationQueryService
let auth: VerifiedAuthContext
let plant: string, otherPlant: string, owner: string, material: string
const facts: unknown[] = []
const base = { objectId: 'A', objectFullKey: 'WORLD-A', momMaterialCode: 'SKU', ownerEntityCode: 'LE-HDMIKE',
  plantCode: 'SZ0001', unit: 'm', basis: 'cable_m' }

beforeAll(async () => {
  env = await prepareExclusiveEnvironment('s1-scope')
  const { pool } = env
  const nodes = await pool.query('SELECT id,code FROM org_node')
  const id = (code: string) => nodes.rows.find(x => x.code === code)!.id as string
  plant = id('PLNT-SZ'); otherPlant = id('PLNT-HF'); owner = id('LE-HDMIKE')
  const user = (await pool.query("SELECT * FROM user_account WHERE login_name='admin'")).rows[0]!
  const context: CommandContext = { actorUserId: user.id, actorLoginName: 'admin', enterpriseId: user.enterprise_id, reason: 'S1 isolated fixture' }
  auth = { user: { id: user.id, enterpriseId: user.enterprise_id, loginName: 'admin', displayName: '', plantId: plant, roleId: user.role_id, loginPlatform: 'WEB' },
    role: { id: user.role_id, name: '', alias: '' }, session: { id: randomUUID(), expiresAt: '2099-01-01' },
    permissions: [SAP_RECON_PERMISSIONS.SAP_RECON_READ], dataScope: { enterpriseWide: true, plantIds: [] } }
  material = (await pool.query(`INSERT INTO material(org_scope_id,code,name,material_type,base_uom) VALUES($1,'SKU','Scoped fixture',3,'m') RETURNING id`, [user.enterprise_id])).rows[0]!.id
  // Adversarial fixture may use SQL for sim facts, while MOM stock is posted through its real command bus.
  const bus = buildInventoryCommandBus(pool)
  for (const [unitNo, lotNo, qty, plantId, basis, ownerId] of [
    ['WORLD-A','LOT-A','20',plant,'cable_m',owner], ['WORLD-B','LOT-B','900',plant,'cable_m',owner],
    ['WORLD-A','LOT-A','800',otherPlant,'cable_m',owner],
    ['CORE-A','LOT-CORE','60',plant,'core_m',owner], ['FOREIGN-A','LOT-FOREIGN','700',plant,'cable_m',id('LE-NFMIKE')],
  ]) {
    const result = await bus.execute({ operationId: randomUUID(), commandType: 'inventory.receive-goods', targetId: 'new', expectedRevision: 0,
      payload: { plantId, lotNo, unitNo, materialId: material, materialCode: 'SKU', quantity: qty, uomId: randomUUID(), uomCode: 'm',
        measurementBasis: basis, locationId: randomUUID(), locationCode: 'S1-LOC', ownerId, ownerName: 'fixture owner', qualityStatus: 'qualified' } }, context)
    expect(result.status, JSON.stringify(result)).toBe('COMMITTED'); facts.push(result)
  }
  await pool.query(`INSERT INTO sim_sap_stock(organization_code,plant_code,material_id,unit,qty) VALUES
    ('LE-HDMIKE','SZ0001','WORLD-A','m',20), ('LE-HDMIKE','HF0001','WORLD-A','m',800),
    ('LE-HDMIKE','SZ0001','WORLD-B','m',900), ('LE-NFMIKE','SZ0001','WORLD-A','m',700),
    ('LE-HDMIKE','SZ0001','WORLD-A','kg',40)`)
  service = new SapReconDerivationQueryService({ repo: new PgSapReconDerivationRepository(pool) })
}, 30000)
afterAll(async () => {
  if (env) { await writeFile(`${env.evidence}/readback.json`, JSON.stringify(facts, null, 2)); await env.pool.end() }
})

describe('S1 exact identity and trusted scope', () => {
  it('same SKU stays separated by object, plant, owner and unit; no unrecorded basis comparison', async () => {
    const result = await service.derive(auth, base)
    facts.push(result)
    expect(result.mom.physicalQty).toBe(20)
    expect(result.sim.derived.stockQty).toBe(20)
    expect(result.mom.stockTxn.inQty).toBe(20)
    expect(result.diff.status).toBe('MEASUREMENT_NOT_COMPARABLE')
    expect(result.diff.delta).toBeNull()
    expect(result.sim.measurement.mapping).toBeNull()
  })
  it('exact batch selector does not fall back to SKU or substring', async () => {
    expect((await service.derive(auth, { ...base, momLotNo: 'LOT-B' })).mom.physicalQty).toBe(900)
    expect((await service.derive(auth, { ...base, momUnitNo: 'WORLD' })).mom.physicalQty).toBeNull()
    expect((await service.derive(auth, { ...base, momUnitNo: 'FOREIGN-A' })).mom.physicalQty).toBeNull()
  })
  it('basis is read from facts and core_m never becomes cable_m', async () => {
    const result = await service.derive(auth, { ...base, momUnitNo: 'CORE-A' })
    expect(result.mom.physicalQty).toBeNull()
    expect(result.mom.stock.measures).toEqual([{ unit: 'm', basis: 'core_m', qty: 60, rowCount: 1 }])
  })
  it('denies insufficient plant scope and cross-enterprise even under enterpriseWide', async () => {
    const limited = { ...auth, dataScope: { ...auth.dataScope, enterpriseWide: false, plantIds: [otherPlant] } }
    await expect(service.derive(limited, base)).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' })
    await expect(service.derive(auth, { ...base, plantCode: 'GZ0001', ownerEntityCode: 'LE-NFMIKE' })).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' })
  })
  it('denies missing permission, conflicting selectors and SKU aggregation override', async () => {
    await expect(service.derive({ ...auth, permissions: [] }, base)).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' })
    await expect(service.derive(auth, { ...base, momUnitNo: 'WORLD-A', momLotNo: 'LOT-A' })).rejects.toMatchObject({ code: 'INVALID_IDENTITY' })
    await expect(service.derive(auth, { ...base, simMaterialKey: 'SKU' })).rejects.toMatchObject({ code: 'INVALID_IDENTITY' })
  })
  it('reads persisted scoped reference basis and resolves only this object line quantity', async () => {
    const sha = 'a'.repeat(64)
    const reference = { version: 'S1-v1', sources: { stock_objects: { path: 'fixture/stock_objects.csv', sha256: sha } },
      tables: { stock_objects: [{ id: 'WORLD-A', material_id: 'SKU', unit: 'm', basis: 'cable_m' },
        { id: 'WORLD-B', material_id: 'SKU', unit: 'm', basis: 'core_m' }] } }
    await env.pool.query(`INSERT INTO sim_sap_document(doc_no,doc_type,organization_code,plant_code,source_event_key,payload)
      VALUES('MASTER-S1','MASTER_BUNDLE','LE-HDMIKE','SZ0001','S1-MASTER',$1)`,
      [{ reference_data: reference, reference_data_sha256: sha }])
    const payload = { goods_movement_code: '03', reference_data_sha256: sha, reference_master_event_key: 'S1-MASTER',
      lines: [{ materialId: 'WORLD-A', skuMaterialId: 'SKU', qty: 3, unit: 'm', basis: 'cable_m', sourceReferences: ['S1-feed-A'] },
        { materialId: 'WORLD-B', skuMaterialId: 'SKU', qty: 999, unit: 'm', basis: 'core_m', sourceReferences: ['S1-feed-B'] }] }
    await env.pool.query(`INSERT INTO sim_sap_document(doc_no,doc_type,organization_code,plant_code,source_event_key,material_id,qty,unit,payload,receipt)
      VALUES('ISSUE-S1','MATERIAL_DOCUMENT','LE-HDMIKE','SZ0001','S1-ISSUE','SKU',1002,'MIXED',$1,'{"applied":true}')`, [payload])
    await env.pool.query(`INSERT INTO sim_sap_document(doc_no,doc_type,organization_code,plant_code,source_event_key,payload,receipt)
      VALUES('OTHER-S1','MATERIAL_DOCUMENT','LE-HDMIKE','HF0001','S1-OTHER',$1,'{"applied":true}'),
      ('PREFIX-S1','MATERIAL_DOCUMENT','LE-HDMIKE','SZ0001','WORLD-A-BOGUS','{"object_id":"WORLD-A-MORE"}','{"applied":true}')`, [payload])
    const result = await service.derive(auth, base)
    expect(result.diff.status).toBe('BOTH_DERIVED'); expect(result.diff.delta).toBe(0)
    expect(result.sim.measurement.status).toBe('VERIFIED_REFERENCE_MAPPING')
    expect(result.sim.measurement.mapping?.basis).toBe('cable_m')
    expect(result.sim.derived.consumedQty).toBe(3)
    expect(result.sim.documents.map(x => x.docNo)).toEqual(['ISSUE-S1'])
    expect(result.sim.documents[0]!.quantitySource).toBe('RESOLVED_REFERENCE_LINES')
    expect(result.mom.objectUnits.map(x => x.unitNo)).toEqual(['WORLD-A'])
    facts.push(result)
  })

  it('keeps exact external unknown even when the simulator has internal object stock', async () => {
    await env.pool.query(`INSERT INTO outbox(aggregate_type,aggregate_id,task_kind,status,external_ref,request_digest,payload)
      VALUES('s1_fixture','WORLD-A','SAP_SIM.PRODUCTION_OUTPUT','EXTERNAL_UNKNOWN','S1-UNKNOWN','s1-unknown-digest',$1)`,
      [{organization_code:'LE-HDMIKE',plant_code:'SZ0001',attempt_outcome:'QUERY_UNAVAILABLE',envelope:{axis_ids:['WORLD-A']}}])
    const result=await service.derive(auth,base)
    expect(result.sim.derived.stockQty).toBe(20)
    expect(result.sim.derived.observedQty).toBeNull()
    expect(result.diff).toMatchObject({simQty:null,delta:null,unknownSlice:true,status:'UNKNOWN_SLICE_PRESERVED',unknownEventKeys:['S1-UNKNOWN']})
    expect(result.sim.derived.observedRule).toBe('SIM_EXTERNAL_UNKNOWN_HOLD')
    facts.push(result)
  })

})
