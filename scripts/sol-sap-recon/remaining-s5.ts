import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { appendFile,writeFile } from 'node:fs/promises'
import type { CommandBus,CommandContext } from '@cadenza/application'
import { DEFAULT_EXECUTION_CONFIG } from '@cadenza/application'
import { buildExecutionCommandBus,NoopScheduleReadPort } from '../../apps/api/src/execution/execution.composition'
import { buildReworkCommandBus } from '../../apps/api/src/rework/rework.composition'
import { buildReverseCommandBus } from '../../apps/api/src/reverse/reverse.composition'
import { buildSchedulingCommandBus } from '../../apps/api/src/scheduling/scheduling.composition'
import { buildInventoryQueryService } from '../../apps/api/src/inventory/inventory.composition'
import { buildFrozenGroupSimRuntime } from '../sol-s5-gates/runtime'
import type { runMain } from './main-run'
type R=Record<string,unknown>
const data=(value:unknown)=>value as R
const list=(value:unknown)=>value as R[]
const str=(value:unknown)=>String(value)
export async function remainingS5(session:Awaited<ReturnType<typeof runMain>>) {
 const {run,context,plants,materials,orders}=session,pool=run.pool,cn11=plants['CBL01G-CN11']!,cn12=plants['CBL01G-CN12']!,kr22=plants['CBL01G-KR22']!,kr21=plants['CBL01G-KR21']!
 const evidence:unknown[]=[]
 const log=async(v:unknown)=>{evidence.push(v);await appendFile(`${run.evidence}/s5-events.jsonl`,JSON.stringify(v)+'\n')}
 const mainIds=Object.values(session.objectUnits)
 const snapshot=async()=> (await pool.query('SELECT u.id,u.plant_id,u.status,b.id AS balance_id,b.owner_id,b.quantity,b.quality_status FROM inventory_unit u JOIN stock_balance b ON b.unit_id=u.id WHERE u.id=ANY($1::uuid[]) ORDER BY u.id,b.id',[mainIds])).rows
 const before=await snapshot()
 const call=async(bus:CommandBus,type:string,payload:R,target='new',actor=context)=>data((await run.command(bus,actor,type,target,payload)).result.data)
 const reject=async(bus:CommandBus,type:string,payload:R,expected:string,target='new',actor=context)=>{
  const envelope={operationId:randomUUID(),commandType:type,targetId:target,expectedRevision:0,payload}
  const result=await bus.execute(envelope,actor);await log({kind:'NEGATIVE_BUSINESS_COMMAND',envelope,actor:actor.actorLoginName,result})
  assert.equal(result.status,'BUSINESS_REJECTION');assert.ok(result.errorMessage?.includes(expected),JSON.stringify(result));return result
 }
 const eq=async(p:typeof cn11,code:string,dept=p.prod,wc=p.wc)=>str((await call(session.md,'masterdata.equipment.create',{code,name:code,deptId:dept,workCenterId:wc,equipmentStatus:1})).equipmentId)
 const roles=(await pool.query("SELECT id FROM role WHERE enterprise_id=$1 AND alias='sysadmin'",[context.enterpriseId])).rows[0]!
 const user=await call(session.org,'org.user.create',{loginName:'solcn11worker',password:'SolSim1031Pass',displayName:'SIM CN11 worker',deptId:cn11.prod,roleId:roles.id,loginPlatform:'WEB'})
 const actor:CommandContext={...context,actorUserId:str(user.userId),actorLoginName:'solcn11worker'}
 const execution=buildExecutionCommandBus(pool,{schedule:new NoopScheduleReadPort(),config:{...DEFAULT_EXECUTION_CONFIG,lastOperationAutoReviewDeptIds:Object.values(plants).flatMap(p=>[p.prod,p.whDept])}})
 const rework=buildReworkCommandBus(pool),reverse=buildReverseCommandBus(pool),schedule=buildSchedulingCommandBus(pool)
 let next=0
 async function branch(tag:string,qty:string,p=cn11,operation=p.operation,materialId=materials['CBL01G-F2']!){
  const family=await call(session.process,'process.family.create',{plantId:p.id,code:`BR-${tag}`,name:`BR ${tag}`})
  const route=await call(session.process,'process.route.create',{productFamilyId:family.familyId,steps:[{seq:1,operationDefinitionId:operation,workCenterId:p.wc,coreMultiple:1,strandFactor:'1'}]})
  await call(session.process,'process.route.publish',{},str(route.revisionId))
  const existing=(await pool.query("SELECT id,lines FROM manufacturing_bom_revision WHERE enterprise_id=$1 AND plant_id=$2 AND material_id=$3 AND status='published'",[context.enterpriseId,p.id,materialId])).rows
  assert.ok(existing.length<=1)
  let bomRevisionId:string
  if(existing.length){
   const bom=existing[0]!
   // These branches add no recipe override. Reuse the actual published SKU recipe;
   // an existing nonempty recipe must be the one already used by this run's source order.
   if(list(bom.lines).length){
    const used=(await pool.query('SELECT id FROM production_order WHERE id=ANY($1::uuid[]) AND bom_revision_id=$2',[Object.values(orders).map(o=>o.id),bom.id])).rows
    assert.ok(used.length>0,'Published recipe must match an actual original-input source order')
   } else assert.deepEqual(bom.lines,[])
   bomRevisionId=str(bom.id)
   await log({kind:'BRANCH_REUSES_PUBLISHED_BOM',tag,plantId:p.id,materialId,bomRevisionId,requiredRecipe:bom.lines})
  }else{
   const bom=await call(session.process,'process.bom.create',{productFamilyId:family.familyId,materialId,lines:[]})
   await call(session.process,'process.bom.publish',{},str(bom.revisionId));bomRevisionId=str(bom.revisionId)
  }
  const order=await call(session.process,'process.order.receive',{orderNo:`BR-${tag}`,materialId,productionDeptId:p.prod,productionQty:qty,uom:'M',productFamilyId:family.familyId,bomRevisionId,initialStatus:'released',processConfirmed:true,salesOrderNo:`BR-SO-${tag}`,lineNo:'10'})
  await call(session.process,'process.order.start',{},str(order.orderId))
  const op=(await pool.query('SELECT id FROM order_operation WHERE order_id=$1',[order.orderId])).rows[0]!
  return {id:str(order.orderId),op:str(op.id),p}
 }
 async function output(order:Awaited<ReturnType<typeof branch>>,qty:string,barcode?:string,source='order',equipmentId?:string){
  const code=barcode ?? `1F${String(88000000+(++next)).padStart(8,'0')}`
  const result=await call(execution,'execution.report.submit',{orderId:order.id,orderOperationId:order.op,source,equipmentId,outputs:[{carrierCode:code,quantity:qty,uomId:randomUUID(),uomCode:'M',measurementBasis:'cable_m',targetLocationId:order.p.location,targetLocationCode:order.p.locationCode,ownerId:order.p.owner,ownerName:'SIM owner'}]})
  const unit=str((result.stockedUnits as string[])[0]),row=(await pool.query('SELECT unit_no FROM inventory_unit WHERE id=$1',[unit])).rows[0]!
  assert.equal(result.reviewOutcome,'auto_approved');return {unit,unitNo:str(row.unit_no),barcode:code,result}
 }
 // Correct sequential save scenario, not a single rejected batch.
 const planned=await branch('PLAN-PARTIAL','4000',kr21),a=await eq(kr21,'EQ-PLAN-A'),b=await eq(kr21,'EQ-PLAN-B')
 await call(schedule,'scheduling.slot.save',{orderOperationId:planned.op,equipmentId:a,productionDate:'2026-10-31',plannedQty:'3000',confirm:true})
 await reject(schedule,'scheduling.slot.save',{orderOperationId:planned.op,equipmentId:b,productionDate:'2026-10-31',plannedQty:'3000',confirm:true},'A3-2')
 const slots=(await pool.query('SELECT equipment_id,planned_qty FROM schedule_slot WHERE order_id=$1',[planned.id])).rows
 assert.deepEqual(slots,[{equipment_id:a,planned_qty:'3000.0000'}]);await log({id:'V-PLAN-PARTIAL',slots})
 // Authorized business rejection of restoration keeps the exact 2000m physical hold.
 const qo=await branch('QUALITY-RESTORE','2000',kr22),qu=await output(qo,'2000')
 const hold=await call(session.quality,'quality.suspect.register',{plantId:kr22.id,unitId:qu.unit,reason:'Frozen independent quality decision'})
 const review=await call(session.quality,'quality.suspect.review',{holdId:hold.holdId,decision:'reject',reason:'SIM decision owner refuses restoration'})
 assert.equal(review.restoredQty,'0.0000')
 const held=(await pool.query('SELECT b.quantity,b.quality_status,h.status FROM stock_balance b JOIN quality_hold h ON h.inventory_unit_id=b.unit_id WHERE b.unit_id=$1',[qu.unit])).rows
 assert.deepEqual(held,[{quantity:'2000.0000',quality_status:'suspect',status:'active'}])
 const qc=(await pool.query("SELECT id FROM user_account WHERE login_name='szqc01'")).rows[0]!
 await reject(session.quality,'quality.suspect.review',{holdId:hold.holdId,decision:'reject',reason:'no permission'},'A-S1','new',{...context,actorUserId:qc.id,actorLoginName:'szqc01'})
 const hf=(await pool.query("SELECT id,plant_id FROM user_account WHERE login_name='hfadmin01'")).rows[0]!
 await call(session.org,'org.grant.grant',{principalType:'user',principalId:hf.id,scopeType:'plant',scopeObjectId:hf.plant_id,permissions:['quality.post']})
 const auditBefore=(await pool.query("SELECT count(*)::int AS n FROM audit_entry WHERE action='quality.suspect.review' AND subject_id=$1",[hold.holdId])).rows
 await reject(session.quality,'quality.suspect.review',{holdId:hold.holdId,decision:'reject',reason:'wrong scope'},'A-S1','new',{...context,actorUserId:hf.id,actorLoginName:'hfadmin01'})
 assert.deepEqual((await pool.query("SELECT count(*)::int AS n FROM audit_entry WHERE action='quality.suspect.review' AND subject_id=$1",[hold.holdId])).rows,auditBefore)
 await log({id:'V-QUALITY-RESTORE',review,held,decisionAudit:auditBefore})
 // Explicit logistics auto-review configuration; reusing an occupied code fails without creating another 2000m.
 const wc=await call(session.md,'masterdata.workcenter.create',{plantId:kr22.id,deptId:kr22.whDept,code:'WC-LOG-S5',name:'SIM logistics'})
 const op=await call(session.process,'process.operation.create',{deptId:kr22.whDept,workCenterId:wc.workCenterId,companyOrgCode:'CBL01G-K200',code:'OP-LOG-S5',name:'Logistics'})
 const lp={...kr22,wc:str(wc.workCenterId)},logOrder=await branch('LOG-REPORT','2000',lp,str(op.operationId),materials['CBL01G-F2'])
 const logEq=await eq(lp,'EQ-LOG-S5',lp.whDept,lp.wc)
 const logOutput=await output(logOrder,'2000',undefined,'scan',logEq)
 const retryOrder=await branch('LOG-REUSE','2000',lp,str(op.operationId),materials['CBL01G-F2'])
 const reuseBefore=(await pool.query('SELECT sum(quantity)::text AS qty FROM stock_balance WHERE unit_id=$1',[logOutput.unit])).rows
 await reject(execution,'execution.report.submit',{orderId:retryOrder.id,orderOperationId:retryOrder.op,source:'scan',equipmentId:logEq,outputs:[{carrierCode:logOutput.barcode,quantity:'2000',uomId:randomUUID(),uomCode:'M',measurementBasis:'cable_m',targetLocationId:lp.location,targetLocationCode:lp.locationCode,ownerId:lp.owner,ownerName:'SIM'}]},'IT-06')
 const reuseAfter=(await pool.query('SELECT sum(quantity)::text AS qty FROM stock_balance WHERE unit_id=$1',[logOutput.unit])).rows;assert.deepEqual(reuseAfter,reuseBefore)
 await log({id:'V-LOG-REPORT',configuration:{lastOperationAutoReviewDeptIds:[lp.whDept]},positive:logOutput.result,reuse:'CORRECT_WAIT_ACTIVE_CODE',before:reuseBefore,after:reuseAfter})
 // 5990 coded unit + 10 untagged custody conserves the source, with no physical scrap.
 const clearOrder=await branch('CLEAR','6000'),clear=await output(clearOrder,'6000')
 const split=await call(session.inventory,'inventory.split',{sourceUnitId:clear.unit,retainedQty:'10',lossQty:'0',children:[{unitNo:'1F88999999',quantity:'5990',locationId:cn11.location,locationCode:cn11.locationCode}],reason:'Frozen split without loss'})
 const envelope={operationId:randomUUID(),commandType:'rework.axis-retire.execute',targetId:'new',expectedRevision:0,payload:{unitNos:[clear.unitNo],reason:'Frozen clear labels; physical material retained'}}
 const retired=await rework.execute(envelope,actor);assert.equal(retired.status,'COMMITTED',JSON.stringify(retired))
 const custody=list(data(retired.data).retired)[0]!,custodyUnit=str(custody.custodyUnitId)
 const replay=await rework.execute(envelope,actor)
 for(const key of ['status','data','operationId','occurredAt'] as const)assert.deepEqual(replay[key],retired[key])
 const retireCounts=(await pool.query('SELECT (SELECT count(*)::int FROM axis_retire_record WHERE unit_id=$1) AS retire_count,(SELECT count(*)::int FROM inventory_unit WHERE unit_no=$2) AS custody_count',[clear.unit,`UNTAGGED-${custody.retireRecordId}`])).rows[0]!
 assert.deepEqual(retireCounts,{retire_count:1,custody_count:1})
 const quantities=(await pool.query('SELECT u.id,u.unit_no,b.quantity,b.quality_status FROM inventory_unit u JOIN stock_balance b ON b.unit_id=u.id WHERE u.id=ANY($1::uuid[]) ORDER BY b.quantity',[[clear.unit,custodyUnit,...split.childUnitIds as string[]]])).rows
 assert.equal(quantities.reduce((sum,r)=>sum+Number(r.quantity),0),6000);assert.ok(quantities.some(r=>r.id===custodyUnit&&r.quantity==='10.0000'&&r.quality_status==='suspect'))
 assert.equal((await pool.query('SELECT count(*)::int n FROM barcode_binding WHERE bound_id=$1 AND active',[custodyUnit])).rows[0]!.n,0)
 const auth={session:{id:'s5-read',expiresAt:'2099-01-01'},user:{id:context.actorUserId,loginName:'admin',displayName:'admin',enterpriseId:context.enterpriseId,plantId:cn11.id,roleId:str(roles.id),loginPlatform:'WEB' as const},role:{id:str(roles.id),name:'sysadmin',alias:'sysadmin'},permissions:['inventory.read'],dataScope:{enterpriseWide:true,plantIds:[]}}
 const available=await buildInventoryQueryService(pool).listBalances(auth,{plantId:cn11.id,unitNoLike:`UNTAGGED-${custody.retireRecordId}`})
 assert.equal(available.items[0]!.availableQuantity,'0.0000')
 await reject(execution,'execution.feed.submit',{orderId:clearOrder.id,orderOperationId:clearOrder.op,lines:[{unitId:custodyUnit,quantity:'1',confirmed:true,deviationReason:'forbidden isolated material',salesOrderNo:'BR-SO-CLEAR',salesLineNo:'10'}]},'A7-2')
 await reject(rework,'rework.axis-retire.execute',{unitNos:[clear.unitNo]},'RS-36','new',actor)
 const scrap=(await pool.query("SELECT count(*)::int n FROM stock_entry WHERE purpose ILIKE '%scrap%' AND unit_id=ANY($1::uuid[])",[[clear.unit,custodyUnit,...split.childUnitIds as string[]]])).rows
 assert.equal(scrap[0]!.n,0);await log({id:'NEG17/V-CLEAR',retired,replay,retireCounts,quantities,available:available.items,scrap})
 // Correct PRD29 vector: a real bound tray child, actual pending inbound, valid destination location.
 const palletOrder=await branch('PALLET-CHILD','2000'),palletUnit=await output(palletOrder,'2000')
 const tray='1P88770001'
 await call(rework,'rework.pallet.scan-target',{carrierCode:tray},'new',actor)
 await call(rework,'rework.pallet.scan-item',{taskType:'split_pallet',unitNo:palletUnit.unitNo},'new',actor)
 await call(rework,'rework.pallet.confirm',{taskType:'split_pallet'},'new',actor)
 const warehouses: Array<{id:string;location:string;code:string}>=[]
 for(const code of ['7101','7102']){
  const wh=await call(session.md,'masterdata.warehouse.create',{plantId:cn11.id,deptId:cn11.whDept,code,name:`S5 WH ${code}`,warehouseType:'WAREHOUSE',materialTypes:[1,3]})
  const loc=await call(session.md,'masterdata.location.create',{warehouseId:wh.warehouseId,code:`${code}0001`,name:`S5 LOC ${code}`,locationKind:'NORMAL'})
  warehouses.push({id:str(wh.warehouseId),location:str(loc.locationId),code:`${code}0001`})
 }
 const from=warehouses[0]!,to=warehouses[1]!
 await call(session.inventory,'inventory.move-stock',{unitId:palletUnit.unit,quantity:'2000',toLocationId:from.location,toLocationCode:from.code})
 const transit=await call(session.md,'masterdata.location.create',{warehouseId:from.id,code:'71010002',name:'S5 transit',locationKind:'NORMAL'})
 const outbound=await call(reverse,'reverse.transfer-outbound.create',{plantId:cn11.id,transferKind:'warehouse',fromWarehouseId:from.id,toWarehouseId:to.id,lines:[{materialId:materials['CBL01G-F2'],plannedQty:'2000'}]})
 await call(reverse,'reverse.transfer-outbound.scan',{plantId:cn11.id,orderId:outbound.orderId,unitNo:palletUnit.unitNo})
 const sent=await call(reverse,'reverse.transfer-outbound.complete',{orderId:outbound.orderId,transitLocationId:transit.locationId})
 const inboundBefore=(await pool.query('SELECT line_status,quantity FROM transfer_inbound_line WHERE order_id=$1',[sent.inboundOrderId])).rows
 await reject(reverse,'reverse.transfer-inbound.scan-putaway',{orderId:sent.inboundOrderId,unitNo:palletUnit.unitNo,locationCode:to.code},'WR-15')
 const inboundAfter=(await pool.query('SELECT line_status,quantity FROM transfer_inbound_line WHERE order_id=$1',[sent.inboundOrderId])).rows
 assert.deepEqual(inboundAfter,inboundBefore)
 const trayScan=await call(reverse,'reverse.transfer-inbound.scan-putaway',{orderId:sent.inboundOrderId,palletCode:tray,locationCode:to.code})
 await call(reverse,'reverse.transfer-inbound.complete',{orderId:sent.inboundOrderId})
 await log({id:'NEG11',unit:palletUnit.unit,actualTray:tray,inboundBefore,inboundAfter,acceptedTrayScan:trayScan})
 // Frozen group SIM consumers bind to real objects in this exact database. Independent six-case evidence is reused.
 const backup=await eq(cn12,'EQ-S5-BACKUP')
 let clock=new Date('2026-10-23T08:00:00+08:00')
 const runtime=buildFrozenGroupSimRuntime(pool,{enterpriseId:context.enterpriseId,cn12PlantId:cn12.id,kr22PlantId:kr22.id,cn12BackupEquipmentId:backup,n2OrderId:orders['CBL01G-MO-N2']!.id,deliveryPlantId:kr21.id},()=>clock,{...DEFAULT_EXECUTION_CONFIG,lastOperationAutoReviewDeptIds:Object.values(plants).map(p=>p.prod)})
 await writeFile(`${run.evidence}/s5-frozen-configuration.json`,JSON.stringify(runtime.configuration,null,2))
 const env=(type:string,payload:R,targetId='new')=>({operationId:randomUUID(),commandType:type,targetId,expectedRevision:0,payload})
 const tool=await runtime.service.scheduleWithTool('CBL01G-TOOL-CN12',env('scheduling.slot.save',{orderOperationId:orders['CBL01G-MO-G-CN']!.op,equipmentId:backup,productionDate:'2026-10-23',plannedQty:'1000',confirm:true}),context);assert.ok(tool.errorMessage?.includes('SIM_TOOL_EXPIRED'));await log({id:'NEG07',tool,equipment:(await pool.query('SELECT equipment_status FROM equipment WHERE id=$1',[backup])).rows})
 const currency=await runtime.service.createAllocationProposal({amountRefs:['CBL01G-FQ-CNY','CBL01G-FQ-KRW'],omitCurrency:true},env('group.allocation-revision.create',{plantId:cn12.id,title:'SIM currencies',reason:'Frozen unlabelled sum refused'}),context);assert.ok(currency.errorMessage?.includes('SIM_CURRENCY_REQUIRED'));await log({id:'NEG13',currency})
 const basis=await runtime.service.receiveConvertedDeliveryPlan({referenceId:'CBL01G-T1',sourceQty:'12240.0000',sourceBasis:'core_m',targetQty:'12240.0000',targetBasis:'cable_m',unit:'m'},env('shipping.pl.inbound',{plantId:kr21.id,plNo:'S5-INVALID-BASIS',salesOrderNo:'CBL01G-SO-G',lines:[{lineKind:'plain_item',materialCode:'F2',requiredCount:1,segmentLength:'12240.0000'}]}),context);assert.ok(basis.errorMessage?.includes('SIM_BASIS_CONVERSION'));await log({id:'NEG14',basis})
 clock=new Date('2026-10-28T06:00:00+09:00')
 const offline=env('execution.report.submit',{orderId:orders['CBL01G-MO-N2']!.id,orderOperationId:orders['CBL01G-MO-N2']!.op,source:'order',outputs:[{carrierCode:'1F88888888',quantity:'500',uomId:randomUUID(),uomCode:'M',measurementBasis:'cable_m',targetLocationId:kr22.location,targetLocationCode:kr22.locationCode,ownerId:kr22.owner,ownerName:'SIM'}]})
 const lease=await runtime.service.submitOfflineReport('CBL01G-PERMIT-N2',offline,context);assert.ok(lease.errorMessage?.includes('SIM_PERMIT_EXPIRED'));assert.equal((await pool.query('SELECT count(*)::int n FROM command_receipt WHERE operation_id=$1',[offline.operationId])).rows[0]!.n,0);await log({id:'NEG15',offline,lease})
 const recall=await call(runtime.group,'group.product-recall.create',{plantId:kr21.id,recallNo:'CBL01G-RECALL-GK1',recallScope:'finished_product',batchNo:'CBL01G-GK-1',materialCode:'F2',title:'GK1 awaiting customer',reason:'Frozen customer confirmation unknown'})
 const returned=await call(runtime.group,'group.product-recall.return-request',{},str(recall.id));assert.equal(returned.returnStatus,'AWAITING_CUSTOMER_CONFIRMATION');assert.equal(returned.returnedQty,'0.0000');await log({id:'NEG18',returned,sourceUnitId:session.objectUnits['CBL01G-GK-1']})
 assert.deepEqual(await snapshot(),before)
 await writeFile(`${run.evidence}/remaining-s5.json`,JSON.stringify({before,after:await snapshot(),mainLedgerUnchanged:true,evidence},null,2))
 return {evidence,mainLedgerUnchanged:true}
}
