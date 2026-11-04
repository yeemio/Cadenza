import { frozenCsvDirectory } from '../../tests/sol-sap-engine/frozen-reference-data'
import { randomUUID, createHash } from 'node:crypto'
import { appendFile, writeFile } from 'node:fs/promises'
import { ConfigService } from '@nestjs/config'
import { DEFAULT_EXECUTION_CONFIG, type CommandBus, type CommandContext } from '@cadenza/application'
import { buildOrgCommandBus } from '../../apps/api/src/org/org.composition'
import { buildMasterDataCommandBus } from '../../apps/api/src/masterdata/masterdata.composition'
import { buildProcessCommandBus } from '../../apps/api/src/process/process.composition'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildPurchaseCommandBus } from '../../apps/api/src/purchase/purchase.composition'
import { buildExecutionCommandBus, NoopScheduleReadPort } from '../../apps/api/src/execution/execution.composition'
import { buildIntegrationMaterialCommandBus } from '../../apps/api/src/integrations/integrations.composition'
import { buildShippingCommandBus } from '../../apps/api/src/shipping/shipping.composition'
import { buildQualityCommandBus } from '../../apps/api/src/quality/quality.composition'
import { readFrozenCsv, loadFrozenReferenceData } from '../../tests/sol-sap-engine/frozen-reference-data'
import { newSameRun } from './same-run'

const csv=frozenCsvDirectory()
type Row=Record<string,string>
const rows=(name:string)=>readFrozenCsv(csv,name) as Row[]
const record=(v:unknown)=>v as Record<string,unknown>
const array=(v:unknown)=>v as Record<string,unknown>[]
const s=(v:unknown)=>String(v)
const uom={kg:randomUUID(),m:randomUUID()}

/** Actual command-bus business replay. All quantity inputs come from source receipts/issues/axes/feeds/transfers.
 * Reconciliation.csv is read only after all mutations, for identity selection and final comparison.
 */
export async function runMain() {
 const run=await newSameRun('r3-main')
 const pool=run.pool
 const log=(v:unknown)=>appendFile(`${run.evidence}/business.jsonl`,JSON.stringify(v)+'\n')
 const org=buildOrgCommandBus(pool,new ConfigService()), md=buildMasterDataCommandBus(pool), process=buildProcessCommandBus(pool)
 const inventory=buildInventoryCommandBus(pool), purchase=buildPurchaseCommandBus(pool), materialBus=buildIntegrationMaterialCommandBus(pool), quality=buildQualityCommandBus(pool)
 const admin=(await pool.query("SELECT * FROM user_account WHERE login_name='admin'")).rows[0]!
 const context:CommandContext={actorUserId:admin.id,actorLoginName:'admin',enterpriseId:admin.enterprise_id,reason:'SOL-SAP-RECON-1031 original business inputs'}
 const operations:Record<string,string>={}, objectUnits:Record<string,string>={}, objectNames:Record<string,string>={}
 const plants:Record<string,{id:string;owner:string;prod:string;qc:string;whDept:string;warehouse:string;location:string;locationCode:string;wc:string;operation:string}>={}
 const owners:Record<string,string>={}, materials:Record<string,string>={}
 const orders:Record<string,{id:string;op:string;ops:string[];source:Row}>={}
 const reports=rows('reports'), axes=rows('report_axes'), stock=rows('stock_objects'), rawIssues=rows('raw_issues'), feeds=rows('feeds')
 const stockById=Object.fromEntries(stock.map(r=>[r.id!,r]))
 const plantInput=rows('plants')
 async function call(bus:CommandBus,type:string,payload:Record<string,unknown>,key:string,target='new') {
  const result=await run.command(bus,context,type,target,payload);operations[key]=result.operationId
  return record(result.result.data)
 }
 async function bind(object:string,unit:string,key:string) {
  const b=await run.bindObject(object,unit,operations[key]!);objectUnits[object]=unit;objectNames[object]=b.unitNo
 }
 try {
  for(const entity of rows('entities')) {
   const d=await call(org,'org.node.create',{kind:'legal_entity',parentId:context.enterpriseId,code:entity.id,name:`SIM ${entity.id}`},entity.id!)
   owners[entity.id!]=s(d.nodeId)
  }
  for(const [index,p] of plantInput.entries()) {
   const d=await call(org,'org.node.create',{kind:'plant',parentId:owners[p.entity_id!],code:p.id,name:`SIM ${p.id}`,plantCode:p.sap_plant},p.id!)
   const id=s(d.nodeId)
   const deps:Record<string,string>={}
   for(const [suffix,cat] of [['PROD',1],['QC',2],['WH',3]] as const) {
    const dept=await call(org,'org.node.create',{kind:'department',parentId:id,code:`${p.id}-${suffix}`,name:`SIM ${p.id} ${suffix}`,deptCategory:cat},`${p.id}-${suffix}`);deps[suffix]=s(dept.nodeId)
   }
   const whCode=s(8801+index)
   const wh=await call(md,'masterdata.warehouse.create',{plantId:id,deptId:deps.PROD,code:whCode,name:`WH ${p.sap_plant}`,warehouseType:'LINE_SIDE',materialTypes:[1,2,3]},`wh-${p.id}`)
   const locCode=`${whCode}0001`
   const loc=await call(md,'masterdata.location.create',{warehouseId:wh.warehouseId,code:locCode,name:`LOC ${p.sap_plant}`,locationKind:'NORMAL'},`loc-${p.id}`)
   const wc=await call(md,'masterdata.workcenter.create',{plantId:id,deptId:deps.PROD,code:`WC-${p.sap_plant}`,name:`WC ${p.sap_plant}`},`wc-${p.id}`)
   const op=await call(process,'process.operation.create',{deptId:deps.PROD,workCenterId:wc.workCenterId,companyOrgCode:p.entity_id,code:`OP-${p.sap_plant}`,name:'SIM operation'},`op-${p.id}`)
   plants[p.id!]={id,owner:owners[p.entity_id!]!,prod:deps.PROD!,qc:deps.QC!,whDept:deps.WH!,warehouse:s(wh.warehouseId),location:s(loc.locationId),locationCode:locCode,wc:s(wc.workCenterId),operation:s(op.operationId)}
   await run.registerReferenceData(loadFrozenReferenceData(csv,p.entity_id!,p.sap_plant!) as unknown as Record<string,unknown>,p.entity_id!,p.sap_plant!)
  }
  for(const m of rows('materials')) {
   const d=await call(materialBus,'integration.material-master.sync',{companyOrgCode:plantInput[0]!.entity_id,code:m.mom_material_code,name:`SIM ${m.mom_material_code}`,materialType:m.type==='raw'?1:m.type==='semi'?2:3,baseUom:m.unit!.toUpperCase(),qcFlag:1,externalRevision:Number(m.version),sourceSystem:'SAP_SIM'},`mat-${m.id}`)
   materials[m.id!]=s(d.materialId)
  }
  const autoDepts=Object.values(plants).map(p=>p.prod)
  const execution=buildExecutionCommandBus(pool,{schedule:new NoopScheduleReadPort(),config:{...DEFAULT_EXECUTION_CONFIG,lastOperationAutoReviewDeptIds:autoDepts}})
  for(const o of rows('orders')) {
   const p=plants[o.plant_id!]!
   const fam=await call(process,'process.family.create',{plantId:p.id,code:`FAM-${o.id}`,name:`SIM ${o.id}`},`fam-${o.id}`)
   const route=await call(process,'process.route.create',{productFamilyId:fam.familyId,steps:(o.id==='CBL01G-MO-N1'?[1,2]:[1]).map(seq=>({seq,operationDefinitionId:p.operation,workCenterId:p.wc,coreMultiple:1,strandFactor:'1'}))},`route-${o.id}`)
   await call(process,'process.route.publish',{},`routepub-${o.id}`,s(route.revisionId))
   const components=rawIssues.filter(r=>r.order_id===o.id).map(r=>({materialId:materials[r.material_id!],materialCode:r.material_id!.replace('CBL01G-',''),quantity:r.qty_kg,uom:'KG'}))
   for(const f of feeds.filter(f=>f.order_id===o.id)) components.push({materialId:materials[f.material_id!],materialCode:f.material_id!.replace('CBL01G-',''),quantity:f.qty,uom:f.unit!.toUpperCase()})
   const bom=await call(process,'process.bom.create',{productFamilyId:fam.familyId,materialId:materials[o.material_id!],lines:components.length?components:[{materialId:materials[o.material_id!],materialCode:o.material_id!.replace('CBL01G-',''),quantity:'1',uom:o.unit}]},`bom-${o.id}`)
   await call(process,'process.bom.publish',{},`bompub-${o.id}`,s(bom.revisionId))
   const d=await call(process,'process.order.receive',{orderNo:o.id,materialId:materials[o.material_id!],productionDeptId:p.prod,productionQty:o.quantity,uom:o.unit!.toUpperCase(),productFamilyId:fam.familyId,initialStatus:'released',processConfirmed:true,salesOrderNo:o.sales_order_id,lineNo:o.line},`order-${o.id}`)
   await call(process,'process.order.start',{},`start-${o.id}`,s(d.orderId))
   const ops=(await pool.query('SELECT id FROM order_operation WHERE order_id=$1 ORDER BY seq',[d.orderId])).rows
   orders[o.id!]={id:s(d.orderId),op:s(ops[ops.length-1]!.id),ops:ops.map(op=>s(op.id)),source:o}
   await log({kind:'CADENZA_EXTENSION_LOCAL_ORDER_IDENTITY',originalOrder:o.id,originalSapShortNo:o.sap_order_number,localOrderNo:o.id,localOrderId:d.orderId,sourceOperationId:operations[`order-${o.id}`]})
  }
  for(const [index,batch] of rows('purchase_batches').entries()) {
   const original=rows('purchase_orders').find(p=>p.id===batch.purchase_order_id)!
   const object=stockById[batch.object_id!]!,p=plants[batch.plant_id!]!
   const po=await call(purchase,'purchase.order-sync',{orgCode:original.entity_id,orderNo:original.id,plantId:p.id,lines:[{lineNo:1,materialId:materials[original.material_id!],materialCode:original.material_id!.replace('CBL01G-',''),materialType:1,uomCode:'KG',plannedQty:original.qty,overReceiptLimit:original.upper_limit,status:1}]},`po-${original.id}`)
   const barcode=`R${s(100000001+index)}`
   const d=await call(purchase,'purchase.receive-confirm',{plantId:p.id,orderLineId:array(po.lines)[0]!.lineId,arrivalTime:batch.receipt_at,confirmTime:batch.receipt_at,warehouseId:p.warehouse,locationId:p.location,locationCode:p.locationCode,ownerId:p.owner,ownerName:original.entity_id,uomId:uom.kg,uomCode:'KG',measurementBasis:'kg',unitPrice:original.unit_price,details:[{barcodeValue:barcode,quantity:batch.original_receipt_qty,supplierLotNo:batch.supplier_lot,grade:'SIM'}]},`receipt-${batch.object_id}`)
   await bind(batch.object_id!,s(array(d.details)[0]!.unitId),`receipt-${batch.object_id}`)
   if(!batch.object_id!.endsWith('JKBAD')) await call(purchase,'purchase.inspection.conclude',{batchId:d.batchId,mode:'code',barcodeValue:barcode,conclusion:'qualified'},`iqc-${batch.object_id}`)
   const opening=await run.engine.provisionOpeningStock({organization_code:original.entity_id,plant_code:plantInput.find(x=>x.id===batch.plant_id)!.sap_plant,material_id:object.id,unit:'kg',qty:batch.original_receipt_qty})
   await log({kind:'RAW_RECEIPT_PRECONDITION_OUTSIDE_56',sourceBatch:batch.id,sourceOperationId:operations[`receipt-${batch.object_id}`],opening})
  }
  async function issueFor(report:Row) {
   for(const issue of rawIssues.filter(r=>r.run_id===report.run_id)) {
    await call(inventory,'inventory.issue-material',{unitId:objectUnits[issue.object_id!],quantity:issue.qty_kg,businessTime:issue.at,reason:`SIM weighed issue ${issue.id}`},issue.id!)
   }
  }
  async function produce(reportId:string, orderOverride?:string) {
   const report=reports.find(r=>r.id===reportId)!,o=orders[orderOverride ?? report.order_id!]!,p=plants[report.plant_id!]!
   await issueFor(report)
   const outputs=axes.filter(a=>a.report_id===report.id)
   const d=await call(execution,'execution.report.submit',{orderId:o.id,orderOperationId:o.op,source:'order',businessTime:report.submitted_at,outputs:outputs.map(a=>{const obj=stockById[a.object_id!]!;return {carrierCode:obj.wire_code,quantity:a.qty,uomId:uom.m,uomCode:'M',measurementBasis:obj.basis,targetLocationId:p.location,targetLocationCode:p.locationCode,ownerId:p.owner,ownerName:o.source.entity_id}})},report.id!)
   const ids=d.stockedUnits as string[]
   if(!ids||ids.length!==outputs.length) throw new Error(`Report did not approve expected object lines: ${report.id}`)
   for(const [i,a] of outputs.entries()) await bind(a.object_id!,ids[i]!,report.id!)
  }
  async function transfer(transferId:string) {
   const header=rows('transfers').find(r=>r.id===transferId)!,to=plants[header.destination_plant_id!]!
   for(const line of rows('transfer_lines').filter(r=>r.transfer_id===transferId)) {
    const unit=objectUnits[line.object_id!]!
    const transitId=randomUUID()
    await call(inventory,'inventory.transfer.out',{unitId:unit,quantity:line.qty,transitLocationId:transitId,transitLocationCode:`TRANSIT-${transferId}`,businessTime:header.ship_at},`${transferId}-out-${line.object_id}`)
    if(header.receive_at) await call(inventory,'inventory.transfer.in',{unitId:unit,quantity:line.qty,transitLocationId:transitId,toPlantId:to.id,toOwnerId:to.owner,toLocationId:to.location,toLocationCode:to.locationCode,businessTime:header.receive_at},`${transferId}-in-${line.object_id}`)
   }
  }
  async function feed(orderId:string) {
   const o=orders[orderId]!
   for(const f of feeds.filter(r=>r.order_id===orderId)) await call(execution,'execution.feed.submit',{orderId:o.id,orderOperationId:o.op,lines:[{unitId:objectUnits[f.source_object_id!],quantity:f.qty,confirmed:f.non_order_semi_confirmation?.toLowerCase()==='true',deviationReason:`SIM source ${f.id}`,salesOrderNo:o.source.sales_order_id,salesLineNo:o.source.line}],businessTime:f.at},f.id!)
  }
  // D7 explicit SIM stage order: original parent/source rows stay immutable.
  const n1=orders['CBL01G-MO-N1']!,np=plants[n1.source.plant_id!]!
  const stageId='CBL01G-MO-N1-EX-STAGE'
  const sfMaterial=materials['CBL01G-SF-N1']!
  const fam=await call(process,'process.family.create',{plantId:np.id,code:'FAM-N1-SF-STAGE',name:'N1 SF stage'},'n1-stage-family')
  const route=await call(process,'process.route.create',{productFamilyId:fam.familyId,steps:[{seq:1,operationDefinitionId:np.operation,workCenterId:np.wc,coreMultiple:1,strandFactor:'1'}]},'n1-stage-route')
  await call(process,'process.route.publish',{},'n1-stage-route-publish',s(route.revisionId))
  const bom=await call(process,'process.bom.create',{productFamilyId:fam.familyId,materialId:sfMaterial,lines:rawIssues.filter(r=>r.run_id==='CBL01G-MR-N1-EX').map(r=>({materialId:materials[r.material_id!],materialCode:r.material_id!.replace('CBL01G-',''),quantity:r.qty_kg,uom:'KG'}))},'n1-stage-bom')
  await call(process,'process.bom.publish',{},'n1-stage-bom-publish',s(bom.revisionId))
  const stageQty=reports.find(r=>r.id==='CBL01G-RPT-N1-EX')!.output_qty
  const stage=await call(process,'process.order.receive',{orderNo:stageId,materialId:sfMaterial,productionDeptId:np.prod,productionQty:stageQty,uom:'M',productFamilyId:fam.familyId,initialStatus:'released',processConfirmed:true,salesOrderNo:n1.source.sales_order_id,lineNo:n1.source.line,stageParentOrderId:n1.id,stageParentOperationId:n1.ops[0]},'n1-stage-order')
  await call(process,'process.order.start',{},'n1-stage-start',s(stage.orderId))
  const stageOp=(await pool.query('SELECT id FROM order_operation WHERE order_id=$1',[stage.orderId])).rows[0]!
  orders[stageId]={id:s(stage.orderId),op:s(stageOp.id),ops:[s(stageOp.id)],source:{...n1.source,id:stageId,material_id:'CBL01G-SF-N1'}}
  await produce('CBL01G-RPT-N1-EX',stageId)
  const split=await call(inventory,'inventory.split',{sourceUnitId:objectUnits['CBL01G-SF-N1'],retainedQty:'0',lossQty:'0',children:['CBL01G-M-N1-1','CBL01G-M-N1-2'].map(id=>({unitNo:id,quantity:feeds.find(f=>f.source_object_id===id)!.qty,locationId:np.location,locationCode:np.locationCode})),reason:'Frozen N1 rewind source conservation'},'n1-rewind')
  for(const [index,id] of ['CBL01G-M-N1-1','CBL01G-M-N1-2'].entries()) await bind(id,s((split.childUnitIds as string[])[index]),'n1-rewind')
  await log({kind:'CADENZA_EXTENSION_N1_STAGE_ORDER',originalParentOrder:'CBL01G-MO-N1',originalStep:'10',stageOrder:stage.orderId,stageReportOperation:operations['CBL01G-RPT-N1-EX'],units:split.childUnitIds,originalInputsSha256:createHash('sha256').update(JSON.stringify({report:reports.find(r=>r.id==='CBL01G-RPT-N1-EX'),feeds:feeds.filter(f=>f.order_id==='CBL01G-MO-N1')})).digest('hex')})
  await feed('CBL01G-MO-N1');await produce('CBL01G-RPT-N1-FIN')
  // Main products follow frozen production and custody dependencies.
  for(const n of [1,2,3]) {
   for(const color of ['BL','BN','BK']) await produce(`CBL01G-RPT-C15-${color}-${n}`)
   await transfer(`CBL01G-T${n===1?0:n===2?1:2}`)
   if(n===1){await feed('CBL01G-MO-G-CN');await produce('CBL01G-RPT-G-CN-FIN')}
   if(n===2){await feed('CBL01G-MO-G-KR');await produce('CBL01G-RPT-G-KR-FIN')}
  }
  for(const color of ['BL','BN','BK','GY']) await produce(`CBL01G-RPT-C40-${color}`)
  await transfer('CBL01G-T4');await feed('CBL01G-MO-N2');await produce('CBL01G-RPT-N2-FIN');await transfer('CBL01G-T3')
  // Original abnormal custody decisions move physical material, never opening extra stock.
  for(const [sourceId,destinationId,qty] of [['CBL01G-GC-2','CBL01G-REWORK-200','200'],['CBL01G-GK-2','CBL01G-FGSCRAP-100','100']]) {
   const unit=objectUnits[sourceId!]!,balance=(await pool.query('SELECT * FROM stock_balance WHERE unit_id=$1 AND quantity>0',[unit])).rows[0]!
   const d=await call(inventory,'inventory.split',{sourceUnitId:unit,retainedQty:s(Number(balance.quantity)-Number(qty)),lossQty:'0',children:[{unitNo:destinationId,quantity:qty,locationId:balance.location_id,locationCode:balance.location_code}],reason:`SIM physical custody ${sourceId} -> ${destinationId}`},destinationId!)
   await bind(destinationId!,s((d.childUnitIds as string[])[0]),destinationId!)
  }
  for(const objectId of ['CBL01G-RAW-PVCS','CBL01G-GC-1','CBL01G-GC-2','CBL01G-GK-2','CBL01G-REWORK-200','CBL01G-FGSCRAP-100']) {
   const unit=(await pool.query('SELECT plant_id FROM inventory_unit WHERE id=$1',[objectUnits[objectId]])).rows[0]!
   await call(quality,'quality.suspect.register',{plantId:unit.plant_id,unitId:objectUnits[objectId],reason:'Frozen SIM hold/custody decision'},`hold-${objectId}`)
  }
  const shipping=buildShippingCommandBus(pool)
  for(const [key,sourceOrder,objectIds] of [
    ['N1','CBL01G-MO-N1',['CBL01G-N1-1','CBL01G-N1-2','CBL01G-N1-3']],
    ['GK1','CBL01G-MO-G-KR',['CBL01G-GK-1']],
  ] as Array<[string,string,string[]]>) {
   const o=orders[sourceOrder]!,p=plants[o.source.plant_id!]!
   const pl=await call(shipping,'shipping.pl.inbound',{plantId:p.id,plNo:`CBL01G-PL-${key}`,salesOrderNo:o.source.sales_order_id,lines:objectIds.map((id,i)=>({lineNo:i+1,lineKind:'axis_item',materialCode:o.source.material_id!.replace('CBL01G-',''),salesOrderLineNo:o.source.line,customerAxisNo:stockById[id]!.customer_axis,standardSegmentLength:axes.find(a=>a.object_id===id)!.qty}))},`pl-${key}`)
   for(const [i,id] of objectIds.entries()) await call(shipping,'shipping.scan.load',{plantId:p.id,shipmentOrderId:pl.orderId,lineId:array(pl.lines)[i]!.lineId,unitNo:objectNames[id],actualSegmentLength:axes.find(a=>a.object_id===id)!.qty},`ship-scan-${id}`)
   await call(shipping,'shipping.ship.confirm',{plantId:p.id,shipmentOrderId:pl.orderId,reason:'Frozen actual shipment'},`ship-${key}`)
  }
  // Four qualified axes stay in business custody until the complete 2000m receipt is resolved.
  // This is independent of quality and does not invent a reservation expiry.
  const n2Hold=await call(inventory,'inventory.business-hold.establish',{unitIds:['CBL01G-N2-1','CBL01G-N2-2','CBL01G-N2-3','CBL01G-N2-4'].map(id=>objectUnits[id]),businessRef:'CBL01G-LOCAL-TIN-N2',reason:'完整2000m发运需全部SAP数量回执，当前仍有原键未查证'},'n2-business-hold')
  await log({kind:'N2_INDEPENDENT_BUSINESS_HOLD',sourceInventoryEvents:['CBL01G-EV-LOCAL-DONE-N2-1','CBL01G-EV-LOCAL-DONE-N2-2','CBL01G-EV-LOCAL-DONE-N2-3','CBL01G-EV-LOCAL-DONE-N2-4'],sourceOperationId:operations['n2-business-hold'],n2Hold})
  await writeFile(`${run.evidence}/runtime-context.json`,JSON.stringify({database:run.database,plants,owners,materials,orders,operations,objectUnits,objectNames},null,2))
  await log({kind:'MAIN_MOM_PREPARED_BEFORE_56_65',objects:Object.keys(objectUnits).length})
  return {run,context,plants,owners,materials,orders,operations,objectUnits,objectNames,produce,transfer,feed,call,bind,execution,inventory,purchase,quality,process,org,md}
 } catch(error) {await log({kind:'FAILURE',error:String(error)});await run.close();throw error}
}
