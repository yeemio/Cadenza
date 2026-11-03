import {describe,it,expect} from 'vitest'
import {SapReconDerivationQueryService,type SapReconDerivationRepository,type SapReconDeriveDocumentRow,type SapReconObjectMeasurement,type VerifiedAuthContext} from '@cadenza/application'

// In-memory read-consumer contracts only; actual persisted provenance is verified by the final PG join.
const key='CBL01G-REWORK-200',source='CBL01G-GC-2',sha='a'.repeat(64)
const sources={inventory_events:{path:'fixture/inventory_events.csv',sha256:'b'.repeat(64)}}
const mapping:SapReconObjectMeasurement={objectId:key,materialId:'CBL01G-F2',unit:'m',basis:'cable_m',referenceVersion:'v1',referenceDataSha256:sha,masterEventKey:'MASTER-KEY',sources}
const metadata={source_object_id:source,target_object_id:key,material_id:'CBL01G-F2',unit:'m',basis:'cable_m',original_order_id:'ORDER',source_document_id:'ABNORMAL',reference_data_sha256:sha,reference_master_event_key:'MASTER-KEY',reference_data_version:'v1',reference_sources:sources,derived_association_only:true,stock_unchanged:true,target_posting_created:false,source_inventory_events:[{id:'SRC',object_id:source,document_id:'ABNORMAL',unit:'m',delta:'-200'},{id:'DST',object_id:key,document_id:'ABNORMAL',unit:'m',delta:'200'}]}
const doc=():SapReconDeriveDocumentRow=>({docNo:'REJECT-1',docType:'REJECT_NOTICE',eventKey:'ORIGINAL-KEY',businessKey:source,organizationCode:'ORG',plantCode:'PLANT',status:'COMMITTED',materialId:null,qty:null,unit:null,createdAt:'2026-10-31T00:00:00Z',payload:{...structuredClone(metadata),topic:'REWORK_RECLASSIFICATION'},receipt:{...structuredClone(metadata),outcome:'REJECTED_MISSING_REWORK_ORDER',applied:false}})
const auth={permissions:['group.read']} as VerifiedAuthContext
async function derive(document:SapReconDeriveDocumentRow,options:{object?:string;stock?:number;unknown?:boolean}={}){
 const object=options.object??key
 const repo:SapReconDerivationRepository={
  resolveScope:async()=>({enterpriseId:'ENT',plantId:'P',ownerId:'OWNER',organizationCode:'ORG',plantCode:'PLANT',objectFullKey:object,momUnitNo:'ACTUAL-UNIT',momLotNo:null,unit:'m',basis:'cable_m'}),
  simObjectMeasurement:async()=>({...mapping,objectId:object}),simDocumentsByObjectRef:async()=>[document],
  simStockByMaterial:async()=>options.stock===undefined?[]:[{organizationCode:'ORG',plantCode:'PLANT',materialId:object,unit:'m',qty:options.stock,updatedAt:'2026-10-31'}],simInTransitByMaterial:async()=>[],simOutcomesByEventKeys:async()=>[],
  momObjectUnits:async()=>[],momMaterialByCode:async()=>null,
  momStockSummary:async()=>({rowCount:0,totalQty:0,measures:[],byQuality:[]}),momStockTxnSummary:async()=>({rowCount:0,inQty:0,outQty:0,byKind:[]}),momInventoryUnitSummary:async()=>({rowCount:0,openCount:0}),momConsumptionSummary:async()=>({rowCount:0,qty:0}),momPurchaseReceipts:async()=>[],momProductionOrders:async()=>[],momAuditSummary:async()=>[],
  momOutboxByObjectRef:async()=>options.unknown?[{eventId:'EVENT',externalRef:'ORIGINAL-KEY',taskKind:'sap_sim.REWORK',status:'EXTERNAL_UNKNOWN',attemptCount:1,envelopeBusinessKey:source,updatedAt:'2026-10-31'}]:[],
 }
 return new SapReconDerivationQueryService({repo}).derive(auth,{objectId:object,objectFullKey:object,ownerEntityCode:'ORG',plantCode:'PLANT',unit:'m',basis:'cable_m'})
}
describe('strict persisted rejection target consumer',()=>{
 it('derives zero only as a verified no-posting fact, never from declared quantities',async()=>{
  const document=doc();document.payload['add_rework_wip_m']=999999
  const result=await derive(document)
  expect(result.sim.documents[0]!.refKind).toBe('REJECT');expect(result.sim.derived.rejectedDocCount).toBe(1)
  expect(result.diff.simQty).toBe(0);expect(result.sim.derived.observedRule).toBe('SIM_REJECTED_NO_FACT')
 })
 it('rejects incomplete, wrong-target/source/receipt/flags/reference/measurement metadata',async()=>{
  const mutations:Array<[string,(d:SapReconDeriveDocumentRow)=>void]>=[
   ['target only',d=>{d.payload={target_object_id:key};d.receipt={outcome:'REJECTED_MISSING_REWORK_ORDER',applied:false}}],
   ['missing derived flag',d=>{delete d.payload['derived_association_only']}],
   ['wrong target',d=>{d.payload['target_object_id']='SIBLING';(d.receipt as Record<string,unknown>)['target_object_id']='SIBLING'}],
   ['wrong source',d=>{d.payload['source_object_id']='SIBLING';(d.receipt as Record<string,unknown>)['source_object_id']='SIBLING'}],
   ['receipt mismatch',d=>{(d.receipt as Record<string,unknown>)['target_object_id']='SIBLING'}],
   ['applied',d=>{(d.receipt as Record<string,unknown>)['applied']=true}],
   ['posting created',d=>{d.payload['target_posting_created']=true}],
   ['wrong hash',d=>{d.payload['reference_data_sha256']='c'.repeat(64);(d.receipt as Record<string,unknown>)['reference_data_sha256']='c'.repeat(64)}],
   ['wrong master',d=>{d.payload['reference_master_event_key']='OTHER';(d.receipt as Record<string,unknown>)['reference_master_event_key']='OTHER'}],
   ['wrong SKU',d=>{d.payload['material_id']='OTHER';(d.receipt as Record<string,unknown>)['material_id']='OTHER'}],
   ['wrong basis',d=>{d.payload['basis']='core_m';(d.receipt as Record<string,unknown>)['basis']='core_m'}],
   ['wrong unit',d=>{d.payload['unit']='kg';(d.receipt as Record<string,unknown>)['unit']='kg'}],
   ['missing events',d=>{delete d.payload['source_inventory_events']}],
   ['wrong source CSV',d=>{d.payload['reference_sources']={}}],
   ['not committed',d=>{d.status='REVERSED'}],
  ]
  for(const [name,mutate] of mutations){const document=doc();mutate(document);const result=await derive(document);expect(result.diff.simQty,name).toBeNull();expect(result.sim.derived.rejectedDocCount,name).toBe(0)}
 })
 it('keeps source stock/same-SKU sibling isolated and external UNKNOWN dominant',async()=>{
  expect((await derive(doc(),{object:source,stock:2000})).diff.simQty).toBe(2000)
  const sibling=await derive(doc(),{object:'CBL01G-GC-SIBLING'});expect(sibling.diff.simQty).toBeNull();expect(sibling.sim.derived.rejectedDocCount).toBe(0)
  const unknown=await derive(doc(),{unknown:true});expect(unknown.diff.simQty).toBeNull();expect(unknown.diff.unknownSlice).toBe(true)
  expect((await derive(doc(),{stock:7})).diff.simQty).toBe(7)
 })
})
