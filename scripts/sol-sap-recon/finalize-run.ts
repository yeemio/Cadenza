import { isDeepStrictEqual } from 'node:util'
import assert from 'node:assert/strict'
import { writeFile,appendFile } from 'node:fs/promises'
import { sha256OfPayload } from '@cadenza/domain'
import type { VerifiedAuthContext } from '@cadenza/application'
import { readFrozenCsv } from '../../tests/sol-sap-engine/frozen-reference-data'
import type { runMain } from './main-run'
const csv='/Users/yeemio/AI/gitrep/Cadenza/delivery/company-simulation/group-sap-cn-kr-20261029/CBL01G_SAP_CN_KR_20261029/data/csv'
export async function finalizeRun(session:Awaited<ReturnType<typeof runMain>>) {
 const {run,plants,operations,objectUnits,context}=session,pool=run.pool
 const read=(name:string)=>readFrozenCsv(csv,name) as Record<string,string>[]
 const messages=read('messages'),originalAttempts=read('message_attempts').map((row,ordinal)=>({row,ordinal})).sort((a,b)=>Date.parse(a.row.at!)-Date.parse(b.row.at!)||a.ordinal-b.ordinal)
 const attempts=[...originalAttempts]
 // Owner-approved causal-order SIM: move only the T0 issue after its three actual source bundles.
 const t0Objects=read('transfer_lines').filter(line=>line.transfer_id==='CBL01G-T0').map(line=>line.object_id)
 const t0ReportIds=read('report_axes').filter(axis=>t0Objects.includes(axis.object_id)).map(axis=>axis.report_id)
 const t0Runs=read('reports').filter(report=>t0ReportIds.includes(report.id)).map(report=>report.run_id)
 const dependencies=messages.filter(message=>message.topic==='EXECUTION_BUNDLE'&&t0Runs.includes((JSON.parse(message.payload!) as Record<string,unknown>)['run_id'] as string)).map(message=>message.id)
 assert.equal(new Set(dependencies).size,3)
 const t0Index=attempts.findIndex(attempt=>attempt.row.message_id==='CBL01G-MSG-T0-OUT')
 assert.ok(t0Index>=0)
 const [t0]=attempts.splice(t0Index,1)
 const dependencyIndexes=dependencies.map(id=>attempts.findIndex(attempt=>attempt.row.message_id===id))
 assert.ok(dependencyIndexes.every(index=>index>=0))
 attempts.splice(Math.max(...dependencyIndexes)+1,0,t0!)
 assert.deepEqual(attempts.filter(attempt=>attempt!==t0),originalAttempts.filter(attempt=>attempt!==t0))
 assert.ok(attempts.findIndex(attempt=>attempt.row.message_id==='CBL01G-MSG-T0-IN')>attempts.indexOf(t0!))
 await writeFile(`${run.evidence}/owner-approved-execution-order.json`,JSON.stringify({classification:'OWNER_APPROVED_CAUSAL_ORDER_SIM',reason:'T0 original issue timestamp precedes its three source bundle arrivals; only execution sequence adjusted, original at/key/payload/ordinal unchanged',dependencies,sourceObjects:t0Objects,before:originalAttempts.map((attempt,index)=>({executionOrdinal:index+1,originalCsvOrdinal:attempt.ordinal,attempt:attempt.row})),after:attempts.map((attempt,index)=>({executionOrdinal:index+1,originalCsvOrdinal:attempt.ordinal,attempt:attempt.row,adjustmentReason:attempt===t0?'OWNER_APPROVED_T0_AFTER_REAL_SOURCE_BUNDLES':null}))},null,2))
 const sourceReports=read('reports'),transfers=read('transfer_lines'),feeds=read('feeds'),issues=read('raw_issues')
 const observed:unknown[]=[]
 const faultPreconditions=[
  await run.engine.activateFault({scenario_no:'R1-FL-E08-N2-GR-A'}),
  await run.engine.activateFault({scenario_no:'R1-FL-E08-N2-GR-B'}),
  await run.engine.activateFault({scenario_no:'SOL-RECON-N2-B-RESPONSE-LOST',fault_type:'RESPONSE_LOST',match_event_key:'CBL01G-EVKEY-MSG-N2-GR-B',count:1,description:'Explicit frozen B TIMEOUT_UNKNOWN precondition; original request commits remotely but response is withheld before original-key unavailable query'}),
 ]
 await writeFile(`${run.evidence}/explicit-sim-fault-preconditions.json`,JSON.stringify({classification:'SIM_ASSUMPTION_OUTSIDE_56_65',faultPreconditions,originalEventKeysPreserved:true},null,2))
 const sourceOperation=(row:Record<string,string>,payload:Record<string,unknown>)=>{
  const topic=row.topic!,id=row.id!,order=String(payload['order_id']??'')
  if(topic==='EXECUTION_BUNDLE')return operations[sourceReports.find(r=>r.run_id===payload['run_id'])?.id ?? '']
  if(topic==='STOCK_TRANSFER_ISSUE'||topic==='STOCK_TRANSFER_RECEIPT'){
   const t=String(payload['transfer_id']),line=transfers.find(r=>r.transfer_id===t)!
   return operations[`${t}-${topic==='STOCK_TRANSFER_ISSUE'?'out':'in'}-${line.object_id}`]
  }
  if(topic==='INTERMEDIATE_OUTPUT')return operations['CBL01G-RPT-N1-EX']
  if(topic==='PRODUCTION_OUTPUT')return operations[id.endsWith('N1-GR')?'CBL01G-RPT-N1-FIN':'CBL01G-RPT-N2-FIN']
  if(topic==='MATERIAL_CONSUMPTION'){
   const consumptionOrder=order || (id==='CBL01G-MSG-N2-GI'?'CBL01G-MO-N2':'')
   return operations[feeds.find(f=>f.order_id===consumptionOrder)?.id ?? '']
  }
  if(topic==='SHIPMENT_CONFIRM')return operations['ship-N1']
  if(topic==='SCRAP_CONFIRM')return operations['CBL01G-FGSCRAP-100']
  if(topic==='REWORK_RECLASSIFICATION')return operations['CBL01G-REWORK-200']
  if(topic==='QUALITY_STOCK_BLOCK')return operations['hold-CBL01G-GK-2']
  if(order && operations[`order-${order}`])return operations[`order-${order}`]
  if(topic==='QUANTITY_RECONCILIATION')return operations['ship-N1']
  return operations[`CBL01G-${row.plant_id!.replace('CBL01G-','')}`]
 }
 for(const {row:attempt} of attempts){
  const row=messages.find(m=>m.id===attempt.message_id)!
  const plant=read('plants').find(p=>p.id===row.plant_id)!
  const payload=JSON.parse(row.payload!) as Record<string,unknown>
  const calculated=sha256OfPayload(payload)
  if(calculated!==row.payload_sha256)throw new Error(`Frozen declared payload digest mismatch ${row.id}`)
  const event={event_key:row.event_key,topic:row.topic,organization_code:plant.entity_id,plant_code:plant.sap_plant,business_key:row.business_key,source_version:row.source_version?Number(row.source_version):null,parent_version:row.parent_version?Number(row.parent_version):null,occurred_at:row.occurred_at,payload}
  const source=sourceOperation(row,payload)
  if(!source)throw new Error(`No same-run originating operation anchor for ${row.id}`)
  const relatedSourceKeys=[...new Set([
   ...(row.topic==='STOCK_TRANSFER_ISSUE'||row.topic==='STOCK_TRANSFER_RECEIPT'?transfers.filter(t=>t.transfer_id===payload['transfer_id']).map(t=>`${t.transfer_id}-${row.topic==='STOCK_TRANSFER_ISSUE'?'out':'in'}-${t.object_id}`):[]),
   ...(row.topic==='MATERIAL_CONSUMPTION'?[...feeds,...issues].filter(f=>f.order_id===(payload['order_id']||(row.id==='CBL01G-MSG-N2-GI'?'CBL01G-MO-N2':''))).map(f=>f.id!):[]),
  ])]
  const relatedOperations=relatedSourceKeys.map(key=>({originalInputKey:key,operationId:operations[key]}))
  assert.ok(relatedOperations.every(r=>r.operationId),'Missing same-run related source operation')
  const before=await pool.query('SELECT event_id,request_digest,external_ref,payload FROM outbox WHERE external_ref=$1',[row.event_key])
  const result=attempt.id!.endsWith('QUERY')?await run.querySim(event,source):await run.executeSim(event,source)
  const after=await pool.query('SELECT event_id,request_digest,external_ref,payload,status FROM outbox WHERE external_ref=$1',[row.event_key])
  if(after.rows.length!==1)throw new Error('Missing unique original message')
  const prior=before.rows[0] as Record<string,unknown>|undefined,current=after.rows[0] as Record<string,unknown>
  const wrapper=current['payload'] as Record<string,unknown>,oldWrapper=(prior?.['payload']??{}) as Record<string,unknown>
  assert.equal(current['external_ref'],row.event_key)
  assert.ok(current['event_id'] && current['request_digest'])
  if(prior)for(const key of ['event_id','external_ref','request_digest'])assert.equal(current[key],prior[key],`Original outbox ${key} drift`)
  assert.deepEqual(wrapper['envelope'],event,'Original frozen envelope drift')
  assert.equal(sha256OfPayload((wrapper['envelope'] as Record<string,unknown>)['payload'] as Record<string,unknown>),row.payload_sha256)
  const routing={source_system:'SAP_SIM',organization_code:plant.entity_id,plant_code:plant.sap_plant,external_key:row.event_key,entity_type:row.topic,external_revision:null,sequence:null,actual_connection:false}
  for(const [key,value] of Object.entries(routing)){
   assert.deepEqual(wrapper[key],value,`Original wrapper routing ${key} drift`)
   if(prior)assert.deepEqual(wrapper[key],oldWrapper[key],`Original wrapper ${key} changed`)
  }
  if(prior)assert.deepEqual(oldWrapper['envelope'],event)
  // Only these fields are added/updated by the inspected linkOutbox/queryConfirm receipt paths.
  const metadata=new Set(['sim_outcome','sim_doc_no','sim_doc_count','sim_receipt_at','sim_actual_connection','duplicate_of_arrival','sim_facts_committed','response_lost','attempt_outcome','confirmation','queried_by_original_key','original_event_id','timeout_unknown','query_answered_by','query_found','sim_doc_type','zeroed','rekeyed','outcome','external_unknown','hold'])
  const baseline={...routing,envelope:event}
  const from=prior?oldWrapper:baseline
  const metadataChanges=[]
  for(const key of new Set([...Object.keys(from),...Object.keys(wrapper)])){
   if(isDeepStrictEqual(from[key as keyof typeof from],wrapper[key]))continue
   assert.ok(metadata.has(key),`Unapproved wrapper mutation ${key}`)
   metadataChanges.push({key,beforePresent:key in from,before:from[key as keyof typeof from]??null,afterPresent:key in wrapper,after:wrapper[key]??null})
  }
  const observation={executionOrdinal:attempts.findIndex(item=>item.row===attempt)+1,originalCsvOrdinal:attempts.find(item=>item.row===attempt)!.ordinal,originalAttemptAt:attempt.at,adjustmentReason:attempt.message_id==='CBL01G-MSG-T0-OUT'?'OWNER_APPROVED_T0_AFTER_REAL_SOURCE_BUNDLES':null,attemptId:attempt.id,messageId:row.id,originalEventKey:row.event_key,originalDeclaredDigest:row.payload_sha256,calculatedDigest:calculated,sourceOperationId:source,relatedOperations,result,outbox:current,preservedIdentity:{eventId:current['event_id'],externalRef:current['external_ref'],requestDigest:current['request_digest'],envelope:event},metadataChanges}
  observed.push(observation)
  await appendFile(`${run.evidence}/original-attempts.jsonl`,JSON.stringify(observation)+'\n')
 }
 await writeFile(`${run.evidence}/original-65-attempts.json`,JSON.stringify(observed,null,2))
 const semantics=[]
 for(const item of observed){
  const row=item as {attemptId:string;originalEventKey:string;result:Record<string,unknown>}
  const expected=attempts.find(attempt=>attempt.row.id===row.attemptId)!.row.result!
  const actual=String(row.result['outcome']??row.result['attempt_outcome'])
  const detail=(row.result['detail']??{}) as Record<string,unknown>
  let equivalent=false,explanation:string|null=null
  if(expected==='STALE_NOOP'&&actual==='DUPLICATE_SAME_HASH_NOOP'&&detail['no_new_facts']===true){
   equivalent=true;explanation='原旧版本/原键重放返回原结果且无新事实；当前最新版本仍须为3'
  }
  if(expected==='DUPLICATE_ORIGINAL_ACK'&&actual==='DUPLICATE_RETURN_ORIGINAL'&&detail['no_new_facts']===true){
   const queried=observed.find(value=>(value as {attemptId:string}).attemptId==='CBL01G-ATT-N2-GR-A-QUERY') as {result:{sim_fact:{doc_no:string}}}
   equivalent=row.result['doc_no']===queried.result.sim_fact.doc_no;explanation='原键重复返回与此前真实查询相同单据，未新增产出'
  }
  semantics.push({attemptId:row.attemptId,originalEventKey:row.originalEventKey,expectedLabel:expected,actualLabel:actual,verdict:actual===expected?'EXACT':equivalent?'SEMANTIC_EQUIVALENT':'MISMATCH',explanation})
 }
 const latestVersions=(await pool.query('SELECT organization_code,plant_code,order_no,max(order_version) AS latest_version FROM sim_sap_order WHERE plant_code IN ($1,$2) AND order_no=ANY($3::text[]) GROUP BY organization_code,plant_code,order_no',['CN12','KR21',['00001006','00001001']])).rows
 assert.equal(latestVersions.length,2);assert.ok(latestVersions.every(row=>row.latest_version===3))
 await writeFile(`${run.evidence}/original-65-business-semantics.json`,JSON.stringify({semantics,latestVersions,mismatches:semantics.filter(row=>row.verdict==='MISMATCH')},null,2))
 const t0Lines=transfers.filter(line=>line.transfer_id==='CBL01G-T0')
 const transit=(await pool.query('SELECT * FROM sim_sap_in_transit WHERE transfer_key=$1 ORDER BY material_id',['CBL01G-T0'])).rows
 assert.equal(transit.length,3)
 for(const row of transit){assert.equal(Number(row.qty),0);assert.equal(row.status,'RECEIVED');assert.equal(row.organization_code,'CBL01G-C100');assert.equal(row.from_plant,'CN11');assert.equal(row.to_plant,'CN12')}
 const t0Docs=(await pool.query('SELECT source_event_key,material_id,qty,unit,payload,receipt FROM sim_sap_document WHERE source_event_key=ANY($1::text[]) ORDER BY source_event_key,line_no',[['CBL01G-EVKEY-MSG-T0-OUT','CBL01G-EVKEY-MSG-T0-IN']])).rows
 assert.equal(t0Docs.length,2)
 for(const document of t0Docs){
  assert.equal(document.receipt.applied,true)
  const lines=document.payload.lines as Array<{materialId:string;qty:number;unit:string;basis:string}>
  assert.equal(lines.length,3)
  for(const line of lines){const original=t0Lines.find(row=>row.object_id===line.materialId)!;assert.ok(original);assert.equal(Number(line.qty),Number(original.qty));assert.equal(line.unit,'m');assert.equal(line.basis,'core_m')}
 }
 const physicalTransfers=[]
 for(const line of t0Lines){
  const unitId=objectUnits[line.object_id!]!
  const unit=(await pool.query('SELECT id,unit_no,plant_id FROM inventory_unit WHERE id=$1',[unitId])).rows[0]!
  const balances=(await pool.query('SELECT plant_id,location_id,location_code,owner_id,quantity,measurement_basis FROM stock_balance WHERE unit_id=$1 ORDER BY location_id',[unitId])).rows
  const tx=(await pool.query("SELECT movement_kind,plant_id,quantity,from_owner_id,to_owner_id,from_location_id,to_location_id FROM stock_transaction WHERE unit_id=$1 AND movement_kind IN ('transfer_out','transfer_in') ORDER BY movement_kind,quantity",[unitId])).rows
  assert.equal(unit.plant_id,plants['CBL01G-CN12']!.id);assert.equal(tx.length,4)
  for(const kind of ['transfer_out','transfer_in'])assert.equal(tx.filter(row=>row.movement_kind===kind).reduce((total,row)=>total+Number(row.quantity),0),0)
  assert.ok(balances.every(row=>row.owner_id===plants['CBL01G-CN11']!.owner&&row.measurement_basis==='core_m'))
  assert.ok(tx.filter(row=>Number(row.quantity)<0).every(row=>row.plant_id===plants['CBL01G-CN11']!.id))
  assert.ok(tx.filter(row=>row.movement_kind==='transfer_in'&&Number(row.quantity)>0).every(row=>row.plant_id===plants['CBL01G-CN12']!.id))
  physicalTransfers.push({sourceObject:line.object_id,originalTransferQuantity:line.qty,unit,balances,transactions:tx})
 }
 await writeFile(`${run.evidence}/t0-conservation-proof.json`,JSON.stringify({classification:'OWNER_APPROVED_CAUSAL_ORDER_SIM',transit,documents:t0Docs,physicalTransfers},null,2))

 const actor=(await pool.query('SELECT id,role_id,plant_id FROM user_account WHERE id=$1',[context.actorUserId])).rows[0]!
 const auth:VerifiedAuthContext={session:{id:'same-run-business-readback',expiresAt:'2099-01-01'},user:{id:context.actorUserId,loginName:'admin',displayName:'admin',enterpriseId:context.enterpriseId,plantId:actor.plant_id,roleId:actor.role_id,loginPlatform:'WEB'},role:{id:actor.role_id,name:'sysadmin',alias:'sysadmin'},permissions:['group.read'],dataScope:{enterpriseWide:true,plantIds:[]}}
 const recon=[]
 // Oracle values are consulted only now, after all business mutations and original attempts, solely for comparison.
 for(const row of read('sap_reconciliation')){
  const object=row.object_id!,rawPlant=read('stock_objects').find(r=>r.id===object)!.issuer_plant_id!
  const currentPlant=row.current_plant_id || rawPlant
  const plant=read('plants').find(p=>p.id===currentPlant)!
  const material=read('materials').find(m=>m.id===row.material_id)!
  const result=await run.derive(auth,{objectId:object.replace('CBL01G-',''),objectFullKey:object,momMaterialCode:material.mom_material_code,ownerEntityCode:row.owner_entity_id,plantCode:plant.sap_plant,plantId:plants[currentPlant]!.id,unit:row.unit,basis:row.basis})
  recon.push({objectId:object,sourceUnitId:objectUnits[object],derived:result,comparisonOnly:{expectedMomQty:row.mom_physical_qty,expectedSimQty:row.sap_observed_qty,expectedClassification:row.status},businessVerdict:result.diff.unknownSlice?'UNKNOWN_PRESERVED':result.diff.momQty===null||result.diff.simQty===null?'INCOMPLETE_FACTS':result.diff.momQty===Number(row.mom_physical_qty)&&result.diff.simQty===Number(row.sap_observed_qty)?'EXPECTED_QUANTITIES_DERIVED':'QUANTITY_DIFFERENCE_PRESERVED'})
 }
 await writeFile(`${run.evidence}/reconciliation-21.json`,JSON.stringify(recon,null,2))
 const bKey=messages.find(m=>m.id==='CBL01G-MSG-N2-GR-B')!.event_key!
 const bAttempts=observed.filter(item=>(item as {messageId:string}).messageId==='CBL01G-MSG-N2-GR-B')
 const bOutbox=(await pool.query('SELECT event_id,external_ref,request_digest,status,payload FROM outbox WHERE external_ref=$1',[bKey])).rows
 const bRemote=(await pool.query('SELECT doc_no,source_event_key,material_id,qty,receipt FROM sim_sap_document WHERE source_event_key=$1',[bKey])).rows
 const diagnosticSkuStock=(await pool.query('SELECT organization_code,plant_code,material_id,unit,qty FROM sim_sap_stock WHERE material_id=$1 AND organization_code=$2 AND plant_code=$3',['CBL01G-F3','CBL01G-K200','KR22'])).rows
 assert.equal(bAttempts.length,2);assert.equal(bOutbox.length,1);assert.equal(bOutbox[0]!.status,'EXTERNAL_UNKNOWN')
 assert.equal(bOutbox[0]!.payload.attempt_outcome,'QUERY_UNAVAILABLE');assert.equal(bRemote.length,1);assert.ok(diagnosticSkuStock.some(row=>Number(row.qty)>0))
 const unknown=recon.filter(r=>['CBL01G-N2-3','CBL01G-N2-4'].includes(r.objectId))
 assert.equal(unknown.length,2)
 for(const r of unknown){assert.equal(r.derived.diff.unknownSlice,true);assert.equal(r.derived.diff.simQty,null);assert.equal(r.derived.diff.delta,null);assert.equal(r.derived.sim.derived.observedQty,null);assert.ok(r.derived.diff.unknownEventKeys.includes(bKey))}
 for(const r of recon.filter(r=>['CBL01G-N2-1','CBL01G-N2-2'].includes(r.objectId))){assert.equal(r.derived.diff.unknownSlice,false);assert.equal(r.derived.diff.simQty,500)}
 await writeFile(`${run.evidence}/b1000-unknown-proof.json`,JSON.stringify({originalKey:bKey,bAttempts,bOutbox,bRemote,diagnosticSkuStock,internalFactsAreNotExternalConfirmation:true,unknown:unknown.map(r=>({object:r.objectId,diff:r.derived.diff})),noReplacementOrRepeatProduction:true},null,2))
 const mainSnapshot=await pool.query('SELECT u.id,u.unit_no,u.plant_id,u.status,b.owner_id,b.quantity,b.measurement_basis,b.quality_status,b.status AS balance_status FROM inventory_unit u JOIN stock_balance b ON b.unit_id=u.id WHERE u.id=ANY($1::uuid[]) ORDER BY u.id,b.id',[Object.values(objectUnits)])
 const purchase=await pool.query('SELECT b.batch_no,b.received_qty,b.measurement_basis,b.inspection_status,u.unit_no,s.quantity,s.quality_status FROM purchase_receipt_batch b JOIN material_lot l ON l.lot_no=b.batch_no JOIN inventory_unit u ON u.lot_id=l.id JOIN stock_balance s ON s.unit_id=u.id ORDER BY b.batch_no')
 await writeFile(`${run.evidence}/main-final-facts.json`,JSON.stringify({mainSnapshot:mainSnapshot.rows,purchase:purchase.rows,sourceContext:{head:'4490846e70b23fca0323dd40a82c01daad331671',label:'R3 cumulative source; exact executed source hashes are bound by the final frozen CANDIDATE manifest'},actual_connection:false},null,2))
 await appendFile(`${run.evidence}/business.jsonl`,JSON.stringify({kind:'FULL_ORIGINAL_EXECUTION_COUNTS',messages:messages.length,attempts:observed.length,objects:recon.length,verdicts:recon.map(r=>({objectId:r.objectId,verdict:r.businessVerdict,mom:r.derived.diff.momQty,sim:r.derived.diff.simQty}))})+'\n')
 return {recon,observed,auth,mainSnapshot:mainSnapshot.rows,semantics}
}
