import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { createPool,migrateUp,migrations,seedOrgAuth,createPgGroupRepositories } from '@cadenza/persistence'
import { createScryptPasswordHasher,type CommandBus,type CommandContext,type GroupKittingCalculation } from '@cadenza/application'
import { buildGroupCommandBus } from '../../apps/api/src/group/group.composition'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildQualityCommandBus } from '../../apps/api/src/quality/quality.composition'
import { seedExecutionFixtures,seedOrder,type ExecutionFixtureIds,LOC_LINE_SEMI,LOC_LINE_SEMI_CODE,UOM_M_ID } from '../api/execution-test-env'
const url=process.env['CADENZA_PR09_TEST_DB_URL']
if(!url||!/^cadenza_pr09_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1)))throw new Error('NOT_RUN: CADENZA_PR09_TEST_DB_URL must name a NEW empty cadenza_pr09_* PostgreSQL database')
const pool=createPool(url,{max:8}),oldBasis=process.env['CADENZA_KITTING_BOM_BASES']
let fx:ExecutionFixtureIds,actor:CommandContext,other:CommandContext,group:CommandBus,inventory:CommandBus,quality:CommandBus,plantB:string,locB:string,family:string
const bases:Record<string,{outputQuantity:string;outputUom:string}>={}
const WH_B_CODE='9309',LOC_B_CODE=`${WH_B_CODE}0001`
const one=async(sql:string,args:unknown[]=[])=>String((await pool.query(sql,args)).rows[0]!.id)
async function committed(bus:CommandBus,type:string,payload:Record<string,unknown>,who=actor){const e={commandType:type,operationId:randomUUID(),targetId:'pr09',expectedRevision:0,payload};const r=await bus.execute(e,who);expect(r.status,JSON.stringify(r)).toBe('COMMITTED');expect(await bus.execute(e,who)).toEqual(r);return r.data as Record<string,unknown>}
async function fixture(options:{basis?:boolean;empty?:boolean;noBom?:boolean;qty?:string;duplicate?:boolean}={}){
  const materialId=await one(`INSERT INTO material(org_scope_id,code,name,material_type,base_uom,qc_flag,source_system) VALUES($1,$2,$2,1,'M',1,'PR09') RETURNING id`,[fx.enterpriseId,`C-${randomUUID()}`])
  const materialCode=String((await pool.query('SELECT code FROM material WHERE id=$1',[materialId])).rows[0]!.code)
  const lines=options.empty?[]:[{materialId,materialCode,quantity:options.qty??'10.0000',uom:'M'},...(options.duplicate?[{materialId,materialCode,quantity:'3.0000',uom:'M'}]:[])]
  // A distinct finished SKU gives each test its own frozen BOM version.
  const out=await one(`INSERT INTO material(org_scope_id,code,name,material_type,base_uom,qc_flag,source_system) VALUES($1,$2,$2,3,'M',1,'PR09') RETURNING id`,[fx.enterpriseId,`OUT-${randomUUID()}`])
  const bom=options.noBom?null:await one(`INSERT INTO manufacturing_bom_revision(enterprise_id,plant_id,product_family_id,material_id,version,status,lines,published_at) VALUES($1,$2,$3,$4,3,'published',$5::jsonb,now()) RETURNING id`,[fx.enterpriseId,fx.szPlantId,family,out,JSON.stringify(lines)])
  const orderNo=`MO-${randomUUID()}`,o=await seedOrder(pool,{...fx,materialId:out},{orderNo,plannedQty:'100.0000',ops:[{seq:1,operationDefinitionId:fx.operationDefIds.seq1,deptId:fx.szJzDeptId,offlineQty:'100.0000'}]})
  await pool.query('UPDATE production_order SET bom_revision_id=$2 WHERE id=$1',[o.orderId,bom])
  await pool.query('UPDATE order_operation SET bom_revision_id=$2 WHERE order_id=$1',[o.orderId,bom])
  if(bom&&options.basis!==false){bases[bom]={outputQuantity:'100.0000',outputUom:'M'};process.env['CADENZA_KITTING_BOM_BASES']=JSON.stringify(bases)}
  return {materialId,materialCode,bom,orderNo,orderId:o.orderId}
}
type Fixture=Awaited<ReturnType<typeof fixture>>
async function stock(s:Fixture,qty:string,options:{uom?:string;quality?:string;foreign?:boolean;conversion?:string}={}){
  const data=await committed(inventory,'inventory.receive-goods',{plantId:options.foreign?plantB:fx.szPlantId,unitNo:`U-${randomUUID()}`,lotNo:`L-${randomUUID()}`,materialId:s.materialId,materialCode:s.materialCode,quantity:qty,uomId:options.uom?randomUUID():UOM_M_ID,uomCode:options.uom??'M',locationId:options.foreign?locB:LOC_LINE_SEMI,locationCode:options.foreign?LOC_B_CODE:LOC_LINE_SEMI_CODE,ownerId:fx.enterpriseId,ownerName:'PR09 fixture owner',qualityStatus:options.quality??'qualified',...(options.conversion?{conversionRevisionId:options.conversion}:{})},options.foreign?other:actor)
  return String(data.unitId)
}
async function check(s:Fixture,bus=group){const data=await committed(bus,'group.shortage-kitting.check',{plantId:fx.szPlantId,orderNo:s.orderNo});const result=data.calculation as GroupKittingCalculation;expect(data.checkStatus).not.toBe('empty');expect((await pool.query('SELECT order_id,check_status,shortage_lines FROM group_shortage_kitting_result WHERE id=$1',[data.id])).rows[0]).toMatchObject({order_id:s.orderId,check_status:result.checkStatus,shortage_lines:[{kind:'calculation',...result}]});return result}
beforeAll(async()=>{
  if((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rowCount)throw new Error('Refusing nonempty PR09 database')
  await migrateUp(pool,migrations);await seedOrgAuth(pool,{passwordHasher:createScryptPasswordHasher()});fx=await seedExecutionFixtures(pool)
  const users=(await pool.query("SELECT id,login_name,enterprise_id FROM user_account WHERE login_name IN ('szqc01','szws01')")).rows
  const a=users.find(u=>u.login_name==='szqc01')!,b=users.find(u=>u.login_name==='szws01')!
  actor={actorUserId:a.id,actorLoginName:a.login_name,enterpriseId:a.enterprise_id};other={actorUserId:b.id,actorLoginName:b.login_name,enterpriseId:b.enterprise_id}
  plantB=await one("SELECT id FROM org_node WHERE code='PLNT-HF'")
  for(const [who,plant] of [[actor,fx.szPlantId],[other,plantB]] as const)await pool.query(`INSERT INTO scope_grant(enterprise_id,principal_type,principal_id,permissions,scope_type,scope_object_id,status,created_by) VALUES($1,'user',$2,$3,'plant',$4,'active','pr09-fixture')`,[fx.enterpriseId,who.actorUserId,['inventory.post','inventory.reserve','quality.post','group.read','group.post'],plant])
  await pool.query(`INSERT INTO scope_grant(enterprise_id,principal_type,principal_id,permissions,scope_type,scope_object_id,status,created_by) VALUES($1,'user',$2,ARRAY['group.read'],'plant',$3,'active','pr09-fixture')`,[fx.enterpriseId,actor.actorUserId,plantB])
  const deptB=await one("SELECT id FROM org_node WHERE code='DEPT-HF-JZ' AND kind='department' AND parent_kind='plant' AND parent_id=$1 AND enterprise_id=$2",[plantB,fx.enterpriseId])
  const whB=await one(`INSERT INTO warehouse(enterprise_id,plant_id,dept_id,code,name,warehouse_type,material_types) VALUES($1,$2,$3,$4,'P09-B','WAREHOUSE',ARRAY[1]) RETURNING id`,[fx.enterpriseId,plantB,deptB,WH_B_CODE])
  locB=await one(`INSERT INTO storage_location(enterprise_id,plant_id,warehouse_id,location_kind,code) VALUES($1,$2,$3,'NORMAL',$4) RETURNING id`,[fx.enterpriseId,plantB,whB,LOC_B_CODE])
  family=await one(`INSERT INTO product_family(enterprise_id,plant_id,code,name) VALUES($1,$2,'P09-F','P09-F') RETURNING id`,[fx.enterpriseId,fx.szPlantId])
  group=buildGroupCommandBus(pool);inventory=buildInventoryCommandBus(pool);quality=buildQualityCommandBus(pool)
},120_000)
afterAll(async()=>{if(oldBasis===undefined)delete process.env['CADENZA_KITTING_BOM_BASES'];else process.env['CADENZA_KITTING_BOM_BASES']=oldBasis;await pool.end()})
describe('PR09 actual PG group calculation, measurement and isolation',()=>{
  it('missing authorized-factory order records ORDER_NOT_FOUND, never empty/ok',async()=>{const d=await committed(group,'group.shortage-kitting.check',{plantId:fx.szPlantId,orderNo:'DOES-NOT-EXIST'});expect(d).toMatchObject({outcome:'ORDER_NOT_FOUND',checkStatus:'error'})})
  it.each([{noBom:true},{empty:true},{basis:false}])('missing BOM information %j remains MISSING_DATA',async options=>{expect((await check(await fixture(options))).outcome).toBe('MISSING_DATA')})
  it('computes actual shortage and retains exact requirement/available/shortage evidence',async()=>{const s=await fixture();await stock(s,'6');const result=await check(s);expect(result.lines[0]).toMatchObject({required:'10.0000',available:'6.0000',shortage:'4.0000'});console.log('PR09_QUERY',JSON.stringify(result))})
  it('sufficient real stock is KIT_COMPLETE with nonempty component calculation',async()=>{const s=await fixture();await stock(s,'10');expect(await check(s)).toMatchObject({outcome:'KIT_COMPLETE',lines:[{required:'10.0000',available:'10.0000',shortage:'0.0000'}]})})
  it('duplicate component demands share inventory once',async()=>{const s=await fixture({duplicate:true});await stock(s,'12');expect((await check(s)).lines[0]).toMatchObject({required:'13.0000',available:'12.0000',shortage:'1.0000'})})
  it('business hold, quality hold and pending stock are independently unavailable',async()=>{const s=await fixture(),held=await stock(s,'50'),suspect=await stock(s,'50');await stock(s,'50',{quality:'pending_inspection'});await stock(s,'4');await committed(inventory,'inventory.business-hold.establish',{unitIds:[held],reason:'PR09 custody',businessRef:randomUUID()});await committed(quality,'quality.suspect.register',{plantId:fx.szPlantId,unitId:suspect});expect((await check(s)).lines[0]).toMatchObject({available:'4.0000',shortage:'6.0000'})})
  it('deducts active reservation once and stops deducting after actual expiry instant',async()=>{const s=await fixture(),id=await stock(s,'20'),until=new Date(Date.now()+600_000);await committed(inventory,'inventory.reservation.acquire',{unitId:id,quantity:'15.0000',holderType:'task',holderRef:'p09',validUntil:until.toISOString()});expect((await check(s)).lines[0]!.available).toBe('5.0000');const future=buildGroupCommandBus(pool,()=>new Date(until.getTime()+1));expect((await check(s,future)).lines[0]!.available).toBe('20.0000')})
  it('material-specific conversion permits comparable stock quantity',async()=>{const s=await fixture({qty:'500'});await pool.query(`INSERT INTO conversion_revision(material_id,version,unit_name,factor) VALUES($1,1,'KM',1000)`,[s.materialId]);await stock(s,'1',{uom:'KM'});expect((await check(s)).lines[0]).toMatchObject({required:'500.0000',available:'1000.0000',shortage:'0.0000'})})
  it('uses frozen referenced stock conversion even when it is retired and current factor differs',async()=>{const s=await fixture({qty:'500'});const id=await one(`INSERT INTO conversion_revision(material_id,version,unit_name,factor,referenced,status) VALUES($1,1,'ROLL',600,true,'retired') RETURNING id`,[s.materialId]);await pool.query(`INSERT INTO conversion_revision(material_id,version,unit_name,factor) VALUES($1,2,'ROLL',1000)`,[s.materialId]);await stock(s,'1',{uom:'ROLL',conversion:id});expect((await check(s)).lines[0]!.available).toBe('600.0000')})
  it('unknown unit conversion returns UNCONVERTIBLE rather than a made-up shortage',async()=>{const s=await fixture();await stock(s,'500',{uom:'UNKNOWN-UOM'});expect(await check(s)).toMatchObject({outcome:'UNCONVERTIBLE',checkStatus:'error'})})
  it('other-factory stock does not satisfy this factory and read scope does not confer write',async()=>{const s=await fixture();await stock(s,'100',{foreign:true});expect((await check(s)).lines[0]!.available).toBe('0.0000');const r=await group.execute({commandType:'group.shortage-kitting.check',operationId:randomUUID(),targetId:'p09',expectedRevision:0,payload:{plantId:plantB,orderNo:s.orderNo}},actor);expect(r.status).toBe('BUSINESS_REJECTION');expect(r.errorCode).toBe('ERR_FORBIDDEN_SCOPE')})
  it('current settings reference conflict is not silently calculated from old BOM',async()=>{const s=await fixture();await pool.query('UPDATE order_operation SET bom_revision_id=NULL WHERE order_id=$1',[s.orderId]);await pool.query('UPDATE production_order SET current_settings_version=2 WHERE id=$1',[s.orderId]);expect((await check(s)).reason).toBe('CURRENT_SETTINGS_BOM_CONFLICT_OR_MISSING')})
  it('enterprise-wide list remains bound to current enterprise',async()=>{const foreign=await one("SELECT id FROM org_node WHERE code='ENT-NF'"),plant=await one("SELECT id FROM org_node WHERE code='PLNT-GZ'");await pool.query(`INSERT INTO group_shortage_kitting_result(order_no,check_status,enterprise_id,plant_id) VALUES('P09-FOREIGN','error',$1,$2)`,[foreign,plant]);const r=await createPgGroupRepositories(pool).shortageKitting.listPaged({enterpriseId:fx.enterpriseId,plantIds:null,limit:100,offset:0});expect(r.items.some(x=>x.orderNo==='P09-FOREIGN')).toBe(false)})
  it('same-key concurrent checks persist one result and change no inventory facts',async()=>{const s=await fixture();await stock(s,'12');const before=(await pool.query('SELECT count(*)::int n FROM stock_transaction')).rows[0]!.n;const e={commandType:'group.shortage-kitting.check',operationId:randomUUID(),targetId:'p09',expectedRevision:0,payload:{plantId:fx.szPlantId,orderNo:s.orderNo}};const results=await Promise.all([group.execute(e,actor),group.execute(e,actor)]);expect(results[0]).toEqual(results[1]);expect((await pool.query('SELECT count(*)::int n FROM group_shortage_kitting_result WHERE order_id=$1',[s.orderId])).rows[0]!.n).toBe(1);expect((await pool.query('SELECT count(*)::int n FROM stock_transaction')).rows[0]!.n).toBe(before)})
})
