import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { INestApplication } from '@nestjs/common'
import { createPool, migrateUp, migrations, seedOrgAuth, createPgWarehousingRepositories } from '@cadenza/persistence'
import { createScryptPasswordHasher, type CommandBus, type CommandContext } from '@cadenza/application'
import { createApiClient } from '../../packages/ui/src/api/client'
import { computeBusinessShiftDate } from '../../packages/ui/src/i18n/time'
// No fallback to DATABASE_URL, no recreation, no runtime skips. A task-owned EMPTY DB only.
const url = process.env['CADENZA_PR08_TEST_DB_URL']
if (!url || !/^cadenza_pr08_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) throw new Error('NOT_RUN: CADENZA_PR08_TEST_DB_URL must name a NEW empty cadenza_pr08_* PostgreSQL database')
const pool = createPool(url, { max: 8 })
const realFetch = globalThis.fetch
const uom = randomUUID(), time = '2026-11-03T15:30:00.000Z'
const oldOffsets = process.env['CADENZA_PLANT_UTC_OFFSETS'], oldKinds = process.env['CADENZA_PUTAWAY_WAREHOUSE_KINDS']
let app: INestApplication, baseURL: string, inventory: CommandBus
interface Factory { enterpriseId: string; plantId: string; deptId: string; userId: string; login: string; token: string; ctx: CommandContext; materialId: string; wc: string; defs: string[]; location: string; locationCode: string; rackLocation: string; warehouse: string; offset: number }
const factories: Factory[] = []
const one = async (sql: string, args: unknown[] = []): Promise<string> => String((await pool.query(sql, args)).rows[0]!.id)
const command = async (bus: CommandBus, ctx: CommandContext, type: string, payload: Record<string, unknown>) => {
  const result = await bus.execute({ commandType: type, operationId: randomUUID(), targetId: 'pr08', expectedRevision: 0, payload }, ctx)
  expect(result.status, JSON.stringify(result)).toBe('COMMITTED'); return result.data as Record<string, unknown>
}
async function fixture(f: Factory, finished = false, withOrigin = true) {
  const orderId = await one(`INSERT INTO production_order(enterprise_id,plant_id,order_no,sales_order_no,line_no,material_id,production_dept_id,production_qty,uom,order_status,process_config_status,process_confirmed_at,actual_start_at)
    VALUES ($1,$2,$3,$4,'27',$5,$6,100,'M','in_progress','configured',now(),now()) RETURNING id`,
    [f.enterpriseId,f.plantId,`MO-PR08-${randomUUID()}`,`SO-REAL-${randomUUID()}`,f.materialId,f.deptId])
  const ops: string[] = []
  for (let i = 0; i < 2; i++) ops.push(await one(`INSERT INTO order_operation(enterprise_id,plant_id,order_id,seq,operation_definition_id,operation_code,operation_name,offline_qty,work_center_id,work_center_code,work_center_name,uom,production_dept_id)
    VALUES ($1,$2,$3,$4,$5,$6,$6,100,$7,'P08-WC','P08-WC','M',$8) RETURNING id`,[f.enterpriseId,f.plantId,orderId,i+1,f.defs[i],`P08-OP${i+1}`,f.wc,f.deptId]))
  let materialId = f.materialId
  if (finished) materialId = await one(`INSERT INTO material(org_scope_id,code,name,material_type,base_uom,qc_flag,source_system) VALUES ($1,$2,$2,3,'M',1,'PR08') RETURNING id`, [f.enterpriseId,`FG-${randomUUID()}`])
  // A separate finished order is needed so the report source and actual material agree.
  if (finished) await pool.query('UPDATE production_order SET material_id=$2 WHERE id=$1', [orderId,materialId])
  const received = await command(inventory,f.ctx,'inventory.receive-goods',{ plantId:f.plantId,unitNo:`U-${randomUUID()}`,lotNo:`L-${randomUUID()}`,materialId,materialCode:'PR08',quantity:'20.0000',uomId:uom,uomCode:'M',locationId:f.location,locationCode:f.locationCode,ownerId:f.userId,ownerName:f.login,qualityStatus:'qualified',businessTime:time })
  const unitId=String(received.unitId), unitNo=String((await pool.query('SELECT unit_no FROM inventory_unit WHERE id=$1',[unitId])).rows[0]!.unit_no)
  let reportId='', outputId=''
  if (withOrigin) {
    const session=await one(`INSERT INTO execution_session(enterprise_id,plant_id,order_id,source,order_operation_id,operation_seq,operator_user_id,operator_login,shift_date,status,business_time)
      VALUES($1,$2,$3,'order',$4,1,$5,$6,'2026-11-03','submitted',$7) RETURNING id`,[f.enterpriseId,f.plantId,orderId,ops[0],f.userId,f.login,time])
    reportId=await one(`INSERT INTO production_report(enterprise_id,plant_id,session_id,order_id,order_operation_id,operation_seq,source,status,review_status,operator_user_id,operator_login,business_time,shift_date)
      VALUES($1,$2,$3,$4,$5,1,'order','submitted','manual_approved',$6,$7,$8,'2026-11-03') RETURNING id`,[f.enterpriseId,f.plantId,session,orderId,ops[0],f.userId,f.login,time])
    outputId=await one(`INSERT INTO report_output(enterprise_id,plant_id,report_id,line_no,quantity,qualified_qty,uom_id,uom_code,target_location_id,target_location_code,owner_id,owner_name,stock_unit_id)
      VALUES($1,$2,$3,1,20,20,$4,'M',$5,$6,$7,$8,$9) RETURNING id`,[f.enterpriseId,f.plantId,reportId,uom,f.location,f.locationCode,f.userId,f.login,unitId])
  }
  const sales=(await pool.query('SELECT sales_order_no,line_no FROM production_order WHERE id=$1',[orderId])).rows[0]!
  return { orderId, ops, unitId, unitNo, reportId, outputId, materialId, sales }
}
const storage = () => { const cells=new Map<string,string>(); return { getItem:(k:string)=>cells.get(k)??null,setItem:(k:string,v:string)=>{cells.set(k,v)},removeItem:(k:string)=>{cells.delete(k)} } }
function client(f:Factory, s=storage()) { return createApiClient({ baseURL,getToken:()=>f.token,intentStorage:s }) }
function dropFirstCommittedResponse(path:string) {
  let dropped=false
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response=await realFetch(input,init)
    if (!dropped && new URL(String(input)).pathname===path && init?.method==='POST' && response.ok) {
      const body=await response.json(); expect(body.status).toBe('COMMITTED'); dropped=true
      throw new Error('PR08 deliberately discarded the REAL committed HTTP response')
    }
    return response
  })
  return () => { expect(dropped).toBe(true); vi.unstubAllGlobals() }
}
async function rejectedUnchanged(f:Factory, path:string, payload:unknown) {
  const before=(await pool.query(`SELECT (SELECT count(*) FROM stock_transaction)::int AS tx,(SELECT count(*) FROM stock_entry)::int AS entries,(SELECT count(*) FROM material_consumption)::int AS feeds,(SELECT count(*) FROM outbox)::int AS tasks`)).rows[0]
  const response=await realFetch(baseURL+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${f.token}`,'x-operation-id':randomUUID()},body:JSON.stringify(payload)})
  expect([403,404,409,422]).toContain(response.status)
  expect((await pool.query(`SELECT (SELECT count(*) FROM stock_transaction)::int AS tx,(SELECT count(*) FROM stock_entry)::int AS entries,(SELECT count(*) FROM material_consumption)::int AS feeds,(SELECT count(*) FROM outbox)::int AS tasks`)).rows[0]).toEqual(before)
  return response.json()
}
beforeAll(async () => {
  if ((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rowCount) throw new Error('Refusing nonempty PR08 database')
  await migrateUp(pool,migrations); await seedOrgAuth(pool,{passwordHasher:createScryptPasswordHasher()})
  // These imports require the project's actual API dependencies; no substitute server/controller.
  const [{ Test },{ ConfigModule },{ DbModule,PG_POOL },{ AuthModule },{ ExecutionApiModule },{ WarehousingModule },{ SchedulingApiModule }, inv] = await Promise.all([
    import('@nestjs/testing'),import('@nestjs/config'),import('../../apps/api/src/db/db.module'),import('../../apps/api/src/auth/auth.module'),
    import('../../apps/api/src/execution/execution.composition'),import('../../apps/api/src/warehousing/warehousing.module'),
    import('../../apps/api/src/scheduling/scheduling.composition'),import('../../apps/api/src/inventory/inventory.composition'),
  ])
  inventory=inv.buildInventoryCommandBus(pool)
  const enterpriseId=await one("SELECT id FROM org_node WHERE code='ENT-HD'")
  const role=await one("SELECT id FROM role WHERE enterprise_id=$1 AND alias='qc'",[enterpriseId])
  for (const [i,code] of ['SZ','HF'].entries()) {
    const plantId=await one('SELECT id FROM org_node WHERE code=$1',[`PLNT-${code}`])
    const deptId=await one("SELECT id FROM org_node WHERE code=$1 AND kind='department' AND parent_kind='plant' AND parent_id=$2 AND enterprise_id=$3",[`DEPT-${code}-JZ`,plantId,enterpriseId])
    const login=`pr08${code.toLowerCase()}`
    const userId=await one(`INSERT INTO user_account(enterprise_id,login_name,password_hash,display_name,dept_id,role_id,login_platform,account_status,plant_id,status)
      VALUES($1,$2,$3,$2,$4,$5,'WEB','enabled',$6,'active') RETURNING id`,[enterpriseId,login,await createScryptPasswordHasher().hash('Pr08TestOnly1'),deptId,role,plantId])
    await pool.query(`INSERT INTO scope_grant(enterprise_id,principal_type,principal_id,permissions,scope_type,scope_object_id,status,created_by)
      VALUES($1,'user',$2,$3,'plant',$4,'active','pr08-fixture')`,[enterpriseId,userId,['inventory.post','inventory.read','execution.feed','execution.read','execution.report','warehousing.post','warehousing.read','scheduling.read','process.read'],plantId])
    const wc=await one(`INSERT INTO work_center(enterprise_id,plant_id,dept_id,code,name) VALUES($1,$2,$3,$4,$4) RETURNING id`,[enterpriseId,plantId,deptId,`P08-WC-${i}`])
    const defs=[]
    for (let n=1;n<=2;n++) defs.push(await one(`INSERT INTO operation_definition(enterprise_id,plant_id,dept_id,work_center_id,company_org_code,code,name)
      VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id`,[enterpriseId,plantId,deptId,wc,`P08-${i}`,`P08-${i}-${n}`]))
    const materialId=await one(`INSERT INTO material(org_scope_id,code,name,material_type,base_uom,qc_flag,source_system) VALUES($1,$2,$2,2,'M',1,'PR08') RETURNING id`,[enterpriseId,`P08-M-${i}`])
    const lineCode=String(8100+i*2), warehouseCode=String(8101+i*2), locationCode=`${lineCode}0001`
    const line=await one(`INSERT INTO warehouse(enterprise_id,plant_id,dept_id,code,name,warehouse_type,material_types) VALUES($1,$2,$3,$4,$5,'LINE_SIDE',ARRAY[2,3]) RETURNING id`,[enterpriseId,plantId,deptId,lineCode,`P08-LINE-${i}`])
    const warehouse=await one(`INSERT INTO warehouse(enterprise_id,plant_id,dept_id,code,name,warehouse_type,material_types) VALUES($1,$2,$3,$4,$5,'WAREHOUSE',ARRAY[3]) RETURNING id`,[enterpriseId,plantId,deptId,warehouseCode,`P08-FG-${i}`])
    const location=await one(`INSERT INTO storage_location(enterprise_id,plant_id,warehouse_id,location_kind,code) VALUES($1,$2,$3,'NORMAL',$4) RETURNING id`,[enterpriseId,plantId,line,locationCode])
    const rackLocation=await one(`INSERT INTO storage_location(enterprise_id,plant_id,warehouse_id,location_kind,code) VALUES($1,$2,$3,'RACK','010101') RETURNING id`,[enterpriseId,plantId,warehouse])
    await pool.query(`INSERT INTO shift_parameter(enterprise_id,plant_id,day_shift_start) VALUES($1,$2,'00:00')`,[enterpriseId,plantId])
    factories.push({enterpriseId,plantId,deptId,userId,login,token:'',ctx:{actorUserId:userId,actorLoginName:login,enterpriseId},materialId,wc,defs,location,locationCode,rackLocation,warehouse,offset:8+i})
  }
  process.env['CADENZA_PLANT_UTC_OFFSETS']=JSON.stringify(Object.fromEntries(factories.map(f=>[f.plantId,f.offset])))
  process.env['CADENZA_PUTAWAY_WAREHOUSE_KINDS']=JSON.stringify(Object.fromEntries(factories.map(f=>[f.warehouse,'FINISHED'])))
  const module=await Test.createTestingModule({imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true}),DbModule,AuthModule,ExecutionApiModule,WarehousingModule,SchedulingApiModule]})
    .overrideProvider(PG_POOL).useValue(pool).compile()
  app=module.createNestApplication();await app.listen(0,'127.0.0.1');baseURL=await app.getUrl()
  for (const f of factories) {
    const response=await realFetch(baseURL+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({loginName:f.login,password:'Pr08TestOnly1',platform:'WEB'})})
    expect(response.status).toBe(200);f.token=(await response.json()).token
  }
},120_000)
afterAll(async()=>{
  vi.unstubAllGlobals()
  if(oldOffsets===undefined)delete process.env['CADENZA_PLANT_UTC_OFFSETS'];else process.env['CADENZA_PLANT_UTC_OFFSETS']=oldOffsets
  if(oldKinds===undefined)delete process.env['CADENZA_PUTAWAY_WAREHOUSE_KINDS'];else process.env['CADENZA_PUTAWAY_WAREHOUSE_KINDS']=oldKinds
  if(app)await app.close();else await pool.end()
})
describe('PR08 actual API + actual isolated PG; no skips or business doubles',()=>{
  for(const index of [0,1]) {
    it(`factory ${index}: dropped committed feed response / reload / second operation / trusted sales / calendar`,async()=>{
      const f=factories[index]!,s=await fixture(f),memory=storage(),c=client(f,memory)
      const payload={orderId:s.orderId,orderOperationId:s.ops[1],feeds:[{unitId:s.unitId,quantity:'4.0000'}],businessTime:time}
      const stop=dropFirstCommittedResponse('/execution/feeds')
      try {await expect(c.executeCommandIntent('pda.feed','feed',payload)).rejects.toThrow('discarded')} finally {stop()}
      const saved=(await c.readCommandIntent('pda.feed'))!,result=await client(f,memory).executeCommandIntent('pda.feed','feed',saved.payload)
      expect(result.operationId).toBe(saved.operationId)
      const rows=(await pool.query('SELECT order_id,order_operation_id,quantity::text,sales_order_no,sales_line_no FROM material_consumption WHERE inventory_unit_id=$1',[s.unitId])).rows
      expect(rows).toEqual([{order_id:s.orderId,order_operation_id:s.ops[1],quantity:'4.0000',sales_order_no:s.sales.sales_order_no,sales_line_no:'27'}])
      expect((await pool.query("SELECT quantity::text FROM stock_balance WHERE unit_id=$1 AND status='active'",[s.unitId])).rows).toEqual([{quantity:'16.0000'}])
      expect((await pool.query('SELECT count(*)::int n FROM command_receipt WHERE operation_id=$1',[saved.operationId])).rows[0]!.n).toBe(1)
      const info=await c.schedulingShiftInfo({plantId:f.plantId,at:time}), date=index===0?'2026-11-03':'2026-11-04'
      expect(info.shiftDate).toBe(date);expect(computeBusinessShiftDate(new Date(time),info.calendar!)).toBe(date)
      expect((await pool.query('SELECT DISTINCT shift_date::text FROM stock_transaction WHERE unit_id=$1',[s.unitId])).rows).toEqual([{shift_date:date}])
      const reportResponse=await realFetch(baseURL+`/execution/orders/${s.orderId}/reports`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${f.token}`,'x-operation-id':randomUUID()},body:JSON.stringify({action:'draft',orderOperationId:s.ops[1],businessTime:time,outputs:[{quantity:'1.0000',qualifiedQty:'1.0000',uomId:uom,uomCode:'M',targetLocationId:f.location,targetLocationCode:f.locationCode,ownerId:f.userId,ownerName:f.login}]})})
      expect(reportResponse.ok,await reportResponse.clone().text()).toBe(true)
      const reportReceipt=await reportResponse.json()
      const detailResponse=await realFetch(baseURL+`/execution/reports/${reportReceipt.data.reportId}`,{headers:{authorization:`Bearer ${f.token}`}})
      expect(detailResponse.ok).toBe(true);expect((await detailResponse.json()).report.shiftDate).toBe(date)
      console.log('PR08_HTTP_PG',JSON.stringify({plant:f.plantId,operationId:saved.operationId,committedResponseDiscarded:true,feedRows:rows,balance:'16.0000',shiftDate:date}))
    })
    it(`factory ${index}: dropped putaway response preserves actual task ownership`,async()=>{
      const f=factories[index]!,s=await fixture(f,true),repo=createPgWarehousingRepositories(pool)
      const task=await repo.putawayTasks.insert({sourceType:'work_report',sourceRef:s.outputId,unitNo:s.unitNo,materialId:s.materialId,materialCode:'PR08',quantity:'20.0000',uomId:uom,uomCode:'M',plantId:f.plantId,enterpriseId:f.enterpriseId})
      const payload={plantId:f.plantId,taskIds:[task.id],toWarehouseId:f.warehouse,toLocationId:f.rackLocation,toLocationCode:'010101'},memory=storage(),c=client(f,memory)
      const stop=dropFirstCommittedResponse('/warehousing/putaway/confirm')
      try {await expect(c.executeCommandIntent('pda.putaway','putaway',payload)).rejects.toThrow('discarded')} finally {stop()}
      const saved=(await c.readCommandIntent('pda.putaway'))!
      await client(f,memory).executeCommandIntent('pda.putaway','putaway',saved.payload)
      expect((await repo.putawayTasks.findById(task.id))?.status).toBe('done')
      expect((await pool.query("SELECT owner_id,owner_name,plant_id,location_id,quantity::text FROM stock_balance WHERE unit_id=$1 AND status='active'",[s.unitId])).rows).toEqual([{owner_id:f.userId,owner_name:f.login,plant_id:f.plantId,location_id:f.rackLocation,quantity:'20.0000'}])
      expect((await pool.query('SELECT count(*)::int n FROM warehouse_move WHERE inventory_unit_id=$1',[s.unitId])).rows[0]!.n).toBe(0) // putaway uses inventory ledger, not a second move command
      expect((await pool.query('SELECT count(*)::int n FROM stock_transaction WHERE unit_id=$1',[s.unitId])).rows[0]!.n).toBe(3) // receive + one debit/credit
    })
  }
  it('rejects forged sales and cross-factory second-operation intent without effects',async()=>{
    const a=factories[0]!,b=factories[1]!,s=await fixture(a),other=await fixture(b)
    const payload={orderId:s.orderId,orderOperationId:s.ops[1],feeds:[{unitId:s.unitId,quantity:'1.0000',salesOrderNo:'SO-2026-0301',salesLineNo:'10'}]}
    expect(JSON.stringify(await rejectedUnchanged(a,'/execution/feeds',payload))).toContain('实物')
    await rejectedUnchanged(a,'/execution/feeds',{orderId:other.orderId,orderOperationId:other.ops[1],feeds:[{unitId:other.unitId,quantity:'1.0000'}]})
    await rejectedUnchanged(a,'/execution/feeds',{orderId:s.orderId,orderOperationId:other.ops[1],feeds:[{unitId:s.unitId,quantity:'1.0000'}]})
  })
  it('unknown real origin cannot be replaced with a client sales claim',async()=>{
    const f=factories[0]!,s=await fixture(f,false,false)
    expect(JSON.stringify(await rejectedUnchanged(f,'/execution/feeds',{orderId:s.orderId,orderOperationId:s.ops[1],feeds:[{unitId:s.unitId,quantity:'1.0000',salesOrderNo:'SO-2026-0301',salesLineNo:'10'}]}))).toContain('UNKNOWN')
  })
  it('rejects wrong owner, foreign target and unconfigured warehouse purpose',async()=>{
    const f=factories[0]!,other=factories[1]!,s=await fixture(f,true)
    const task=await createPgWarehousingRepositories(pool).putawayTasks.insert({sourceType:'work_report',sourceRef:s.outputId,unitNo:s.unitNo,materialId:s.materialId,materialCode:'PR08',quantity:'20.0000',uomId:uom,uomCode:'M',plantId:f.plantId,enterpriseId:f.enterpriseId})
    const payload={plantId:f.plantId,taskIds:[task.id],toWarehouseId:f.warehouse,toLocationId:f.rackLocation,toLocationCode:'010101'}
    await rejectedUnchanged(f,'/warehousing/putaway/confirm',{...payload,ownerId:other.userId})
    await rejectedUnchanged(f,'/warehousing/putaway/confirm',{...payload,toWarehouseId:other.warehouse,toLocationId:other.rackLocation})
    const before=process.env['CADENZA_PUTAWAY_WAREHOUSE_KINDS'];delete process.env['CADENZA_PUTAWAY_WAREHOUSE_KINDS']
    try {expect(JSON.stringify(await rejectedUnchanged(f,'/warehousing/putaway/confirm',payload))).toContain('UNKNOWN')} finally {process.env['CADENZA_PUTAWAY_WAREHOUSE_KINDS']=before}
  })
})
