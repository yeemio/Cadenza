import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScryptPasswordHasher, type CommandBus, type CommandContext } from '@cadenza/application'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { buildConversionCommandBus } from '../../apps/api/src/conversion/conversion.composition'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { TaskHandlerRegistry, buildRegistry, createNoopChannel, outboxRequestDigest, type OutboxTaskRow, type WorkerScope } from '../../apps/worker/src/handlers'
import { processBatch } from '../../apps/worker/src/outbox-claim'
// INSERT-only fixtures; no legacy DROP/CREATE or admin grant helpers.
import { seedCvFixtures, seedProductionOrder, seedUnitOwner, CV_OWNER_ID, CV_UOM_ID, type CvFixtures } from '../api/conversion-test-env'
const url = process.env['CADENZA_PR07_TEST_DB_URL']
if (!url || !/^cadenza_pr07_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) throw new Error('NOT_RUN: CADENZA_PR07_TEST_DB_URL must name a NEW empty cadenza_pr07_* PostgreSQL database')
const pool = createPool(url, { max: 8 })
type Payload = Record<string, unknown>
let fx: CvFixtures; let actor: CommandContext; let conversion: CommandBus; let inventory: CommandBus; let snapshotSql: string
const envelope = (commandType: string, payload: Payload) => ({ commandType, payload, operationId: randomUUID(), targetId: 'pr07', expectedRevision: 0 })
async function committed(bus: CommandBus, command: string, payload: Payload): Promise<Payload> {
  const e=envelope(command,payload);const r=await bus.execute(e,actor);expect(r.status,JSON.stringify(r)).toBe('COMMITTED');expect(await bus.execute(e,actor)).toEqual(r);return r.data as Payload
}
async function snapshot() {
  const r=await pool.query<{ table_name:string; content:string }>(snapshotSql)
  return Object.fromEntries(r.rows.map(v=>[v.table_name,createHash('sha256').update(v.content).digest('hex')]))
}
async function denied(payload: Payload) {
  const before=await snapshot();const e=envelope('conversion.order.sync-retry',payload);const r=await conversion.execute(e,actor)
  expect(r.status,JSON.stringify(r)).toBe('BUSINESS_REJECTION');expect(await snapshot()).toEqual(before)
  expect(await conversion.execute(e,actor)).toEqual(r);expect(await snapshot()).toEqual(before)
  console.log('PR07_DENIAL',JSON.stringify({operationId:e.operationId,before,after:await snapshot(),receipt:r}))
}
let fixturePlantSequence = 0
let fixtureCarrierSequence = 0
async function plants() {
  const ids: string[] = []
  for (let i=0; i<2; i++) {
    const id = randomUUID()
    const plantCode = `P07${String(++fixturePlantSequence).padStart(7,'0')}`
    const result = await pool.query<{id:string}>(`INSERT INTO org_node(id,code,name,kind,parent_id,parent_kind,path,depth,enterprise_id,plant_code)
      SELECT $3::uuid,$1,$1,'plant',parent_id,parent_kind,regexp_replace(path,'[^/]+/$','')||$3::text||'/',depth,enterprise_id,$4
      FROM org_node WHERE id=$2 RETURNING id`, [`P07-${randomUUID()}`,fx.szPlantId,id,plantCode])
    ids.push(result.rows[0]!.id)
  }
  return ids as [string,string]
}

async function task(plantId?:string, options:{status?:string;retry?:string|null;actualPlant?:string;declaredPlant?:string;omitPlant?:boolean}={}) {
  let aggregateType='pr07_fixture';let aggregateId:string=randomUUID()
  if(options.actualPlant) {
    aggregateType='conversion_order'
    aggregateId=(await pool.query<{id:string}>('INSERT INTO conversion_order(conversion_no,plant_id,enterprise_id) VALUES ($1,$2,$3) RETURNING id',[`CV-${randomUUID()}`,options.actualPlant,fx.enterpriseId])).rows[0]!.id
  }
  const payload=options.omitPlant?{note:'scope omitted'}:{plantId:options.declaredPlant??plantId,note:'PR07 immutable'}
  const id=(await pool.query<{event_id:string}>(`INSERT INTO outbox(aggregate_type,aggregate_id,task_kind,payload,status,next_retry_at)
    VALUES($1,$2,'pr07.fixture',$3::jsonb,$4,$5) RETURNING event_id`,[aggregateType,aggregateId,JSON.stringify(payload),options.status??'PENDING',options.retry??null])).rows[0]!.event_id
  return id
}
const row=async(id:string)=>(await pool.query('SELECT * FROM outbox WHERE event_id=$1',[id])).rows[0]!
function registry(plantId:string, onRow?:(r:OutboxTaskRow)=>Promise<void>) {
  const scope={plantIds:[plantId]};return new TaskHandlerRegistry(scope).registerPrefix('',async r=>{
    await onRow?.(r);return {kind:'DISPATCHED',externalRef:`local-fixture:${r.eventId}`,requestDigest:outboxRequestDigest(r)}
  })
}
async function run(plantId:string,r=registry(plantId)) { return processBatch(pool,{limit:50,registry:r,scope:{plantIds:[plantId]}}) }
async function completedConversion() {
  const src=await seedProductionOrder(pool,fx,{orderNo:`SRC-${randomUUID()}`,salesOrderNo:`SO-${randomUUID()}`,lineNo:'1'})
  const tgt=await seedProductionOrder(pool,fx,{orderNo:`TGT-${randomUUID()}`,salesOrderNo:`SO-${randomUUID()}`,lineNo:'2'})
  const unitNo=`PE${String(++fixtureCarrierSequence).padStart(8,'0')}`
  const stock=await committed(inventory,'inventory.receive-goods',{plantId:fx.szPlantId,unitNo,lotNo:unitNo,materialId:fx.materialId,materialCode:'MAT-CV-FIN',
    quantity:'100',uomId:CV_UOM_ID,uomCode:'KG',locationId:fx.warehouseLocationId,locationCode:fx.warehouseLocationCode,ownerId:CV_OWNER_ID,ownerName:'PR07 owner',qualityStatus:'qualified'})
  await seedUnitOwner(pool,fx,{orderId:src.orderId,operationId:src.operationId,unitId:String(stock.unitId),quantity:'100'})
  const c=await committed(conversion,'conversion.order.create',{plantId:fx.szPlantId,lines:[{sourceOrderId:src.orderId,targetOrderId:tgt.orderId,targetProjectNo:'PR07',quantity:'100'}]})
  const id=String(c.conversionId);const lineId=(c.lines as {lineId:string}[])[0]!.lineId
  await committed(conversion,'conversion.order.scan',{plantId:fx.szPlantId,conversionOrderId:id,lineId,unitNo,segmentLength:'12.5000'})
  await committed(conversion,'conversion.order.complete',{plantId:fx.szPlantId,conversionOrderId:id})
  await committed(conversion,'conversion.order.sync-retry',{plantId:fx.szPlantId,conversionOrderId:id,outcome:'failure'})
  const taskRow=(await pool.query("SELECT * FROM outbox WHERE aggregate_type='conversion_order' AND aggregate_id=$1 AND task_kind='form_conversion_push'",[id])).rows[0]!
  const local=async()=>(await pool.query(`SELECT to_jsonb(a) AS assignment FROM conversion_code_assignment a WHERE conversion_order_id=$1 ORDER BY a.id`,[id])).rows
  return {id,task:taskRow,local,beforeLocal:await local()}
}

beforeAll(async()=>{
  if((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rowCount!==0)throw new Error('Refusing nonempty PR07 database')
  await migrateUp(pool,migrations);await seedOrgAuth(pool,{passwordHasher:createScryptPasswordHasher()});fx=await seedCvFixtures(pool)
  const u=(await pool.query<{id:string;login_name:string}>("SELECT id,login_name FROM user_account WHERE login_name='szqc01'")).rows[0]!
  actor={actorUserId:u.id,actorLoginName:u.login_name,enterpriseId:fx.enterpriseId}
  await pool.query(`INSERT INTO scope_grant(enterprise_id,principal_type,principal_id,permissions,scope_type,scope_object_id,status,created_by)
    VALUES($1,'user',$2,$3,'plant',$4,'active','pr07-fixture')`,[fx.enterpriseId,u.id,['conversion.post','inventory.post','inventory.reserve'],fx.szPlantId])
  conversion=buildConversionCommandBus(pool);inventory=buildInventoryCommandBus(pool)
  const names=(await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'command_receipt' ORDER BY tablename")).rows.map(r=>r.tablename)
  snapshotSql=names.map(n=>`SELECT '${n.replaceAll("'","''")}'::text AS table_name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]')::text AS content FROM "${n.replaceAll('"','""')}" t`).join(' UNION ALL ')
})
afterAll(async()=>{await pool.end()})

describe('PR07 actual PG claim scope, without external network',()=>{
  for(const first of [0,1])it(`two workers concurrent, start order ${first}, foreign row never locked or mutated`,async()=>{
    const p=await plants();const events=[await task(p[0]),await task(p[1])];const foreign=events[1-first]!;const before=await row(foreign)
    let open!:()=>void;let entered!:()=>void;const gate=new Promise<void>(r=>{open=r});const ready=new Promise<void>(r=>{entered=r})
    const pending=run(p[first]!,registry(p[first]!,async()=>{entered();await gate}))
    try {
      await Promise.race([ready,pending.then(()=>{throw new Error('worker finished before entering its handler')})])
      const probe=await pool.connect();try {await probe.query('BEGIN');await probe.query('SELECT event_id FROM outbox WHERE event_id=$1 FOR UPDATE NOWAIT',[foreign]);await probe.query('ROLLBACK')}finally{probe.release()}
      expect(await row(foreign)).toEqual(before)
      const other=await run(p[1-first]!);expect(other.results.map(r=>r.eventId)).toEqual([foreign])
    }finally{open()}
    const own=await pending;expect(own.results.map(r=>r.eventId)).toEqual([events[first]])
    for(const id of events)expect(await row(id!)).toMatchObject({status:'DISPATCHED',attempt_count:1})
  })
  it('one plant offline leaves its due retry intact until its worker returns',async()=>{
    const [a,b]=await plants();await task(a);const id=await task(b,{status:'FAILED',retry:'2020-01-01T00:00:00Z'});const before=await row(id)
    await run(a);await run(a);expect(await row(id)).toEqual(before)
    expect((await run(b)).results.map(r=>r.eventId)).toEqual([id]);expect(await row(id)).toMatchObject({status:'DISPATCHED',attempt_count:1})
  })
  it('known object with missing plant snapshot resolves actual factory before claim',async()=>{
    const [a,b]=await plants();const id=await task(undefined,{actualPlant:b,omitPlant:true});const before=await row(id)
    expect((await run(a)).claimed).toBe(0);expect(await row(id)).toEqual(before)
    expect((await run(b)).results.map(r=>r.eventId)).toEqual([id])
  })
  it('conflicting plant snapshot and actual object remains unchanged for both workers',async()=>{
    const [a,b]=await plants();const id=await task(a,{actualPlant:b});const before=await row(id)
    expect((await run(a)).claimed).toBe(0);expect((await run(b)).claimed).toBe(0);expect(await row(id)).toEqual(before)
  })
  it('unresolved scope is not claimed or changed',async()=>{
    const [a]=await plants();const id=await task(undefined,{omitPlant:true});const before=await row(id)
    expect((await run(a)).claimed).toBe(0);expect(await row(id)).toEqual(before)
  })
  it('noop cannot make a real external receipt',async()=>{
    const [a]=await plants();const id=await task(a);const scope:WorkerScope={plantIds:[a]}
    await run(a,buildRegistry(createNoopChannel(),scope));expect(await row(id)).toMatchObject({status:'NOOP_NEEDED',external_ref:null,request_digest:null,attempt_count:1})
  })
  it('legacy custom noop DISPATCHED is normalized to NOOP_NEEDED',async()=>{
    const [a]=await plants();const id=await task(a);const r=new TaskHandlerRegistry({plantIds:[a]}).registerPrefix('',async v=>({kind:'DISPATCHED',externalRef:'noop:legacy',requestDigest:outboxRequestDigest(v)}))
    await run(a,r);expect(await row(id)).toMatchObject({status:'NOOP_NEEDED',external_ref:null})
  })
  it('unknown delivery is isolated and not blindly retried',async()=>{
    const [a]=await plants();const id=await task(a);const scope={plantIds:[a]}
    await run(a,buildRegistry({name:'local-unknown-fixture',deliver:async()=>({outcome:'unknown'})},scope))
    expect(await row(id)).toMatchObject({status:'EXTERNAL_UNKNOWN',next_retry_at:null,external_ref:null});expect((await run(a)).claimed).toBe(0)
  })
})
describe('PR07 real conversion commands keep local execution and require persisted acknowledgement',()=>{
  for(const outcome of [undefined,null,'','SUCCESS',true,'invalid'])it(`invalid outcome ${String(outcome)} changes no business rows`,async()=>{
    const c=await completedConversion();await denied({plantId:fx.szPlantId,conversionOrderId:c.id,...(outcome===undefined?{}:{outcome})});expect(await c.local()).toEqual(c.beforeLocal)
  })
  it('unknown preserves local assignment/snapshot and leaves EXTERNAL_UNKNOWN',async()=>{
    const c=await completedConversion();const result=await committed(conversion,'conversion.order.sync-retry',{plantId:fx.szPlantId,conversionOrderId:c.id,outcome:'unknown'})
    expect(result).toMatchObject({outcome:'unknown',externalStatus:'UNKNOWN',syncStatus:'sync_failed',localReapplied:false})
    expect(await c.local()).toEqual(c.beforeLocal);expect(await row(c.task.event_id)).toMatchObject({status:'EXTERNAL_UNKNOWN',payload:c.task.payload,next_retry_at:null})
  })
  for(const proof of ['missing','noop','wrong-digest'])it(`success with ${proof} persisted receipt is rejected`,async()=>{
    const c=await completedConversion()
    if(proof!=='missing')await pool.query("UPDATE outbox SET status='DISPATCHED',external_ref=$2,request_digest=$3 WHERE event_id=$1",[c.task.event_id,proof==='noop'?'noop:fixture':'fixture:confirmed',proof==='noop'?outboxRequestDigest({aggregateType:'conversion_order',aggregateId:c.id,taskKind:'form_conversion_push',payload:c.task.payload}):'wrong'])
    await denied({plantId:fx.szPlantId,conversionOrderId:c.id,outcome:'success',externalRef:'payload-forgery',requestDigest:'payload-forgery'})
    expect(await c.local()).toEqual(c.beforeLocal)
  })
  it('matching persisted fixture receipt confirms once without reapplying local conversion',async()=>{
    const c=await completedConversion();const digest=outboxRequestDigest({aggregateType:'conversion_order',aggregateId:c.id,taskKind:'form_conversion_push',payload:c.task.payload})
    // Explicit local external-receipt fixture, not a real U9 call or real receipt.
    await pool.query("UPDATE outbox SET status='DISPATCHED',external_ref='fixture:confirmed',request_digest=$2 WHERE event_id=$1",[c.task.event_id,digest])
    const result=await committed(conversion,'conversion.order.sync-retry',{plantId:fx.szPlantId,conversionOrderId:c.id,outcome:'success'})
    expect(result).toMatchObject({syncStatus:'synced',localReapplied:false});expect(await c.local()).toEqual(c.beforeLocal)
    expect(await row(c.task.event_id)).toMatchObject({payload:c.task.payload,request_digest:digest,status:'DISPATCHED'})
    await denied({plantId:fx.szPlantId,conversionOrderId:c.id,outcome:'success'})
  })
})
