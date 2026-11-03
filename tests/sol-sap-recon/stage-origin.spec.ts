import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {it,expect} from 'vitest'
import type {CommandBus,CommandContext} from '@cadenza/application'
import {buildReworkCommandBus} from '../../apps/api/src/rework/rework.composition'
import {runMain} from '../../scripts/sol-sap-recon/main-run'

it('validates stage parents and all actual split/reel-split origins before false-confirmation feed',async()=>{
 const s=await runMain(),p=s.plants['CBL01G-CN11']!,other=s.plants['CBL01G-KR22']!,pool=s.run.pool,evidence:unknown[]=[]
 const call=async(bus:CommandBus,type:string,payload:Record<string,unknown>,accept=true,actor=s.context,targetId='new')=>{
  const envelope={operationId:randomUUID(),commandType:type,targetId,expectedRevision:0,payload},result=await bus.execute(envelope,actor)
  evidence.push({envelope,actor:actor.actorLoginName,result})
  expect(result.status,JSON.stringify(result)).toBe(accept?'COMMITTED':'BUSINESS_REJECTION')
  return {...result,data:(result.data??{}) as Record<string,unknown>}
 }
 try{
  const family=await call(s.process,'process.family.create',{plantId:p.id,code:'D8-PARENT',name:'D8 parent'})
  const familyId=String(family.data!.familyId)
  const route=await call(s.process,'process.route.create',{productFamilyId:familyId,steps:[1,2].map(seq=>({seq,operationDefinitionId:p.operation,workCenterId:p.wc,coreMultiple:1,strandFactor:'1'}))})
  await call(s.process,'process.route.publish',{},true,s.context,String(route.data!.revisionId))
  const parent=async(tag:string)=>{
   const r=await call(s.process,'process.order.receive',{orderNo:`D8-${tag}`,materialId:s.materials['CBL01G-F1'],productionDeptId:p.prod,productionQty:'100',uom:'M',productFamilyId:familyId,initialStatus:'released',processConfirmed:true,salesOrderNo:`D8-SO-${tag}`,lineNo:'10'})
   const id=String(r.data!.orderId);await call(s.process,'process.order.start',{},true,s.context,id)
   const ops=(await pool.query('SELECT id FROM order_operation WHERE order_id=$1 ORDER BY seq',[id])).rows
   return {id,first:String(ops[0]!.id),last:String(ops[1]!.id),salesOrderNo:`D8-SO-${tag}`}
  }
  const a=await parent('A'),b=await parent('B')
  const stagePayload=(no:string,parentId=a.id,operationId=a.first,dept=p.prod)=>({orderNo:no,materialId:s.materials['CBL01G-SF-N1'],productionDeptId:dept,productionQty:'100',uom:'M',initialStatus:'released',salesOrderNo:a.salesOrderNo,lineNo:'10',stageParentOrderId:parentId,stageParentOperationId:operationId,operations:[{seq:1,operationDefinitionId:p.operation,workCenterId:p.wc,offlineQty:'100'}]})
  const unknown=await call(s.process,'process.order.receive',stagePayload('D8-UNKNOWN',randomUUID()),false);expect(unknown.errorCode).toBe('ERR_FORBIDDEN_SCOPE')
  const final=await call(s.process,'process.order.receive',stagePayload('D8-FINAL',a.id,a.last),false);expect(final.errorMessage).toContain('真实非最终工序')
  // Use no foreign-family/operation precondition: the explicit parent itself is outside this actual receiving plant.
  const cross=await call(s.process,'process.order.receive',{...stagePayload('D8-CROSS',a.id,a.first,other.prod),operations:[{seq:1,operationDefinitionId:other.operation,workCenterId:other.wc,offlineQty:'100'}]},false);expect(cross.errorCode).toBe('ERR_FORBIDDEN_SCOPE')
  const stage=async(tag:string,parentOrder:typeof a,code:string)=>{
   const r=await call(s.process,'process.order.receive',{...stagePayload(`D8-STAGE-${tag}`,parentOrder.id,parentOrder.first),salesOrderNo:parentOrder.salesOrderNo,processConfirmed:true})
   const id=String(r.data!.orderId);await call(s.process,'process.order.start',{},true,s.context,id)
   const op=(await pool.query('SELECT id FROM order_operation WHERE order_id=$1',[id])).rows[0]!.id
   const produced=await call(s.execution,'execution.report.submit',{orderId:id,orderOperationId:op,source:'order',outputs:[{carrierCode:code,quantity:'100',uomId:randomUUID(),uomCode:'M',measurementBasis:'core_m',targetLocationId:p.location,targetLocationCode:p.locationCode,ownerId:p.owner,ownerName:'SIM stage'}]})
   const unit=String((produced.data!.stockedUnits as string[])[0]),unitNo=String((await pool.query('SELECT unit_no FROM inventory_unit WHERE id=$1',[unit])).rows[0]!.unit_no)
   return {unit,unitNo}
  }
  const own=await stage('A',a,'1F88771111'),foreign=await stage('B',b,'1F88771112')
  const split=await call(s.inventory,'inventory.split',{sourceUnitId:own.unit,retainedQty:'50',lossQty:'0',children:[{unitNo:'D8-SPLIT',quantity:'50',locationId:p.location,locationCode:p.locationCode}]})
  const splitId=String((split.data!.childUnitIds as string[])[0])
  const feed=(order:typeof a,unitId:string,op=order.last)=>({orderId:order.id,orderOperationId:op,lines:[{unitId,quantity:'1',confirmed:false,salesOrderNo:order.salesOrderNo,salesLineNo:'10'}]})
  const current=await call(s.execution,'execution.feed.submit',feed(a,splitId,a.first),false);expect(current.errorMessage).toContain('A7-2')
  await call(s.execution,'execution.feed.submit',feed(a,splitId))
  const outside=await call(s.execution,'execution.feed.submit',feed(a,foreign.unit),false);expect(outside.errorMessage).toContain('A7-3')
  await call(s.inventory,'inventory.split',{sourceUnitId:foreign.unit,retainedQty:'0',lossQty:'0',children:[{unitNo:'1F88771113',quantity:'100',locationId:p.location,locationCode:p.locationCode}]})
  const role=(await pool.query("SELECT id FROM role WHERE enterprise_id=$1 AND alias='sysadmin'",[s.context.enterpriseId])).rows[0]!.id
  const u=await call(s.org,'org.user.create',{loginName:'d8worker',password:'SolSim1031Pass',displayName:'D8 worker',deptId:p.prod,roleId:role,loginPlatform:'WEB'})
  const actor:CommandContext={...s.context,actorUserId:String(u.data!.userId),actorLoginName:'d8worker'}
  await call(buildReworkCommandBus(pool),'rework.reel-split.execute',{sourceUnitNo:'1F88771113',pourLines:[{unitNo:own.unitNo,quantity:'20'}],lossQty:'0'},true,actor)
  const mixed=await call(s.execution,'execution.feed.submit',feed(a,own.unit),false);expect(mixed.errorMessage).toContain('A7-3')
  evidence.push({actualMixedBalance:(await pool.query('SELECT quantity FROM stock_balance WHERE unit_id=$1 AND quantity>0',[own.unit])).rows})
 }finally{
  await writeFile(`${s.run.evidence}/d8-origin-guards.json`,JSON.stringify(evidence,null,2));await s.run.close()
 }
},180000)
