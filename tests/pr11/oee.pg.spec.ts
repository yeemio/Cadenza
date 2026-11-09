import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {createPool,migrateUp,migrations,seedOrgAuth} from '@cadenza/persistence'
import {createScryptPasswordHasher,type VerifiedAuthContext} from '@cadenza/application'
import type {OeeEquipmentBasis} from '@cadenza/domain'
import {buildCostQueryService} from '../../apps/api/src/cost/cost.composition'
import {seedExecutionFixtures,seedOrder,type ExecutionFixtureIds,UOM_M_ID,LOC_LINE_FIN,LOC_LINE_FIN_CODE} from '../api/execution-test-env'
const url=process.env['CADENZA_PR11_TEST_DB_URL']
if(!url||!/^cadenza_pr11_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1)))throw new Error('NOT_RUN: CADENZA_PR11_TEST_DB_URL must name a NEW empty cadenza_pr11_* PostgreSQL database')
const pool=createPool(url,{max:6}),oldBasis=process.env['CADENZA_OEE_BASES'],bases:Record<string,OeeEquipmentBasis>={}
let fx:ExecutionFixtureIds,auth:VerifiedAuthContext,orderId:string,opId:string,seq=0
const queries=buildCostQueryService(pool),one=async(sql:string,args:unknown[]=[])=>String((await pool.query(sql,args)).rows[0]!.id)
async function fixture(){
  const from=new Date(Date.UTC(2026,0,++seq,8)).toISOString(),to=new Date(Date.parse(from)+8*3600000).toISOString()
  const eq=async()=>{const code=`P11-${randomUUID().slice(0,12)}`;return {code,id:await one(`INSERT INTO equipment(enterprise_id,plant_id,dept_id,work_center_id,code,name,std_rate_text,equipment_status) VALUES($1,$2,$3,$4,$5,$5,'200',1) RETURNING id`,[fx.enterpriseId,fx.szPlantId,fx.szJzDeptId,fx.workCenterId,code])}}
  const a=await eq(),b=await eq();for(const e of [a,b])bases[e.id]={basisId:`PR11-${e.id}`,outputUomId:UOM_M_ID,outputUomCode:'M',standardSpeedPerHour:'200',plannedIntervals:[{fromAt:from,toAt:to}]};process.env['CADENZA_OEE_BASES']=JSON.stringify(bases)
  return {a,b,from,to,at:(hours:number)=>new Date(Date.parse(from)+hours*3600000).toISOString()}
}
type Fx=Awaited<ReturnType<typeof fixture>>
async function report(f:Fx,e=f.a,options:{qty?:string;good?:string;time?:string;uomId?:string;uomCode?:string;equipmentId?:string|null;sessionEquipmentId?:string|null;code?:string|null;cancelled?:boolean}={}){
  const time=options.time??f.at(4),eid=options.equipmentId===undefined?e.id:options.equipmentId,sid=options.sessionEquipmentId===undefined?eid:options.sessionEquipmentId,code=options.code===undefined?e.code:options.code
  const session=await one(`INSERT INTO execution_session(enterprise_id,plant_id,order_id,source,order_operation_id,operation_seq,equipment_id,equipment_code,operator_user_id,operator_login,shift_date,status,business_time) VALUES($1,$2,$3,'workbench',$4,1,$5,$6,$7,$8,$9::date,'submitted',$10) RETURNING id`,[fx.enterpriseId,fx.szPlantId,orderId,opId,sid,code,auth.user.id,auth.user.loginName,time.slice(0,10),time])
  const pr=await one(`INSERT INTO production_report(enterprise_id,plant_id,session_id,order_id,order_operation_id,operation_seq,source,status,review_status,operator_user_id,operator_login,business_time,shift_date,equipment_id,equipment_code,review_cancelled_at) VALUES($1,$2,$3,$4,$5,1,'workbench','submitted','auto_approved',$6,$7,$8,$9::date,$10,$11,$12) RETURNING id`,[fx.enterpriseId,fx.szPlantId,session,orderId,opId,auth.user.id,auth.user.loginName,time,time.slice(0,10),eid,code,options.cancelled?time:null])
  return one(`INSERT INTO report_output(enterprise_id,plant_id,report_id,line_no,quantity,qualified_qty,uom_id,uom_code,target_location_id,target_location_code,owner_id,owner_name) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$1,'PR11 fixture') RETURNING id`,[fx.enterpriseId,fx.szPlantId,pr,options.qty??'1400',options.good??'1330',options.uomId??UOM_M_ID,options.uomCode??'M',LOC_LINE_FIN,LOC_LINE_FIN_CODE])
}
async function down(f:Fx,from=f.at(-1),to:string|null=f.at(1),e=f.a){await pool.query(`INSERT INTO downtime_event(enterprise_id,plant_id,equipment_id,start_at,end_at,reason) VALUES($1,$2,$3,$4,$5,'PR11 isolated interval fixture')`,[fx.enterpriseId,fx.szPlantId,e.id,from,to])}
async function result(f:Fx,who=auth){const r=await queries.oee(who,{plantId:fx.szPlantId,equipmentCode:f.a.code,windowStart:f.from,windowEnd:f.to});expect(r).not.toBeNull();return r!}
beforeAll(async()=>{
  if((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rowCount)throw new Error('Refusing nonempty PR11 database')
  await migrateUp(pool,migrations);await seedOrgAuth(pool,{passwordHasher:createScryptPasswordHasher()});fx=await seedExecutionFixtures(pool)
  const u=(await pool.query("SELECT id,login_name,enterprise_id,role_id FROM user_account WHERE login_name='szqc01'")).rows[0]!
  auth={session:{id:'pr11-read-only-test',expiresAt:'2999-01-01T00:00:00Z'},user:{id:u.id,loginName:u.login_name,displayName:'PR11',enterpriseId:u.enterprise_id,plantId:fx.szPlantId,roleId:u.role_id,loginPlatform:'WEB'},role:{id:u.role_id,name:'fixture',alias:'fixture'},permissions:['cost.read'],dataScope:{enterpriseWide:false,plantIds:[fx.szPlantId]}}
  const order=await seedOrder(pool,fx,{orderNo:'PR11-ORDER',plannedQty:'100000',ops:[{seq:1,operationDefinitionId:fx.operationDefIds.seq1,deptId:fx.szJzDeptId,offlineQty:'100000'}]});orderId=order.orderId;opId=order.operationIds[0]!
},120_000)
afterAll(async()=>{if(oldBasis===undefined)delete process.env['CADENZA_OEE_BASES'];else process.env['CADENZA_OEE_BASES']=oldBasis;await pool.end()})
describe('PR11 actual PostgreSQL fact queries; isolated seeded source records, not a live operation claim',()=>{
  it('B production does not change A numerator, denominator or OEE',async()=>{const f=await fixture();const id=await report(f);await down(f);const before=await result(f);expect(before).toMatchObject({actualOutputQty:'1400.0000',qualifiedQty:'1330.0000',downtimeMinutes:'60.0000',availability:'0.8750',performance:'1.0000',qualityRate:'0.9500',oee:'0.8313',sourceOutputIds:[id],missing:[]});await report(f,f.b,{qty:'90000',good:'90000'});expect(await result(f)).toEqual(before);console.log('PR11_A_BEFORE_AFTER_B',JSON.stringify(before))})
  it.each([{start:-1,end:1,minutes:'60.0000'},{start:7,end:10,minutes:'60.0000'},{start:-1,end:10,minutes:'480.0000'},{start:7,end:null,minutes:'60.0000'}])('clips overlapping downtime %j',async c=>{const f=await fixture();await report(f);await down(f,f.at(c.start),c.end===null?null:f.at(c.end));expect((await result(f)).downtimeMinutes).toBe(c.minutes)})
  it('adjacent query windows do not both count a boundary report',async()=>{const f=await fixture();await report(f,f.a,{time:f.from});await report(f,f.a,{time:f.to,qty:'10',good:'10'});await down(f);expect((await result(f)).actualOutputQty).toBe('1400.0000')})
  it('same-device mixed units return missing, not summed quantities',async()=>{const f=await fixture();await report(f);await report(f,f.a,{qty:'10',good:'10',uomCode:'KG',uomId:randomUUID()});await down(f);expect(await result(f)).toMatchObject({oee:null,missing:expect.arrayContaining(['output_unit_mismatch'])})})
  it('code-only equipment attribution is explicitly missing',async()=>{const f=await fixture();await report(f,f.a,{equipmentId:null,sessionEquipmentId:null});await down(f);expect(await result(f)).toMatchObject({oee:null,missing:expect.arrayContaining(['equipment_attribution_missing_or_conflicting'])})})
  it('conflicting report and session UUIDs cannot assign output to A',async()=>{const f=await fixture();await report(f,f.a,{sessionEquipmentId:f.b.id});await down(f);expect((await result(f)).oee).toBeNull()})
  it('missing planned-time/rate/unit basis does not infer a plan from the query window',async()=>{const f=await fixture();await report(f);await down(f);delete bases[f.a.id];process.env['CADENZA_OEE_BASES']=JSON.stringify(bases);expect(await result(f)).toMatchObject({plannedMinutes:null,oee:null,missing:expect.arrayContaining(['equipment_plan_and_rate_basis_missing'])})})
  it('no downtime observation remains missing, not silently zero',async()=>{const f=await fixture();await report(f);expect(await result(f)).toMatchObject({downtimeMinutes:null,oee:null,missing:expect.arrayContaining(['downtime_missing'])})})
  it('cancelled-review output is excluded',async()=>{const f=await fixture();await report(f,f.a,{cancelled:true});await down(f);expect((await result(f)).missing).toContain('output_missing')})
  it('enterprise-wide scope cannot read another enterprise device',async()=>{const f=await fixture();const foreign={...auth,user:{...auth.user,enterpriseId:randomUUID()},dataScope:{enterpriseWide:true,plantIds:[]}};expect(await queries.oee(foreign,{plantId:fx.szPlantId,equipmentCode:f.a.code,windowStart:f.from,windowEnd:f.to})).toBeNull()})
  it('OEE queries leave all underlying reports, output and maintenance facts unchanged',async()=>{const f=await fixture();await report(f);await down(f);const snapshot=async()=>({reports:(await pool.query('SELECT * FROM production_report ORDER BY id')).rows,outputs:(await pool.query('SELECT * FROM report_output ORDER BY id')).rows,downtime:(await pool.query('SELECT * FROM downtime_event ORDER BY id')).rows});const before=await snapshot();await result(f);expect(await snapshot()).toEqual(before)})
})
