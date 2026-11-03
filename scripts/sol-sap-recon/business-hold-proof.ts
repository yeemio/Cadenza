import {randomUUID} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {expect} from 'vitest'
import type {CommandBus,VerifiedAuthContext} from '@cadenza/application'
import {buildInventoryQueryService} from '../../apps/api/src/inventory/inventory.composition'
import {buildShippingCommandBus} from '../../apps/api/src/shipping/shipping.composition'
import type {runMain} from './main-run'

export async function verifyBusinessHold(s:Awaited<ReturnType<typeof runMain>>,externalReadback=false){
 const pool=s.run.pool,p=s.plants['CBL01G-KR22']!,evidence:unknown[]=[]
 const ids=['CBL01G-N2-1','CBL01G-N2-2','CBL01G-N2-3','CBL01G-N2-4'].map(id=>s.objectUnits[id]!)
 const facts=async()=>({units:(await pool.query('SELECT u.id,u.status,u.plant_id,b.quantity,b.quality_status FROM inventory_unit u JOIN stock_balance b ON b.unit_id=u.id WHERE u.id=ANY($1::uuid[]) ORDER BY u.id,b.id',[ids])).rows,holds:(await pool.query('SELECT * FROM inventory_business_hold WHERE unit_id=ANY($1::uuid[]) ORDER BY unit_id',[ids])).rows,transactions:(await pool.query('SELECT id FROM stock_transaction WHERE unit_id=ANY($1::uuid[]) ORDER BY id',[ids])).rows,holdAudit:(await pool.query("SELECT id,action,subject_id FROM audit_entry WHERE action='inventory.business-hold.establish' AND subject_id=ANY($1::text[]) ORDER BY id",[ids])).rows})
 const cmd=async(bus:CommandBus,type:string,payload:Record<string,unknown>,accept=true,actor=s.context,targetId='new')=>{
  const envelope={operationId:randomUUID(),commandType:type,targetId,expectedRevision:0,payload},result=await bus.execute(envelope,actor)
  evidence.push({envelope,actor:actor.actorLoginName,result});expect(result.status,JSON.stringify(result)).toBe(accept?'COMMITTED':'BUSINESS_REJECTION')
  return {...result,data:(result.data??{}) as Record<string,unknown>}
 }
 try{
  const before=await facts();
  const externalStates=(await pool.query("SELECT external_ref,status,payload FROM outbox WHERE external_ref=ANY($1::text[]) ORDER BY external_ref",[['CBL01G-EVKEY-MSG-N2-GR-A','CBL01G-EVKEY-MSG-N2-GR-B']])).rows
  if(externalReadback){expect(externalStates).toHaveLength(2);expect(externalStates[0]!.status).toBe('DISPATCHED');expect(externalStates[0]!.payload.attempt_outcome).toBe('FOUND_COMMITTED');expect(externalStates[1]!.status).toBe('EXTERNAL_UNKNOWN')}
  expect(before.holds).toHaveLength(4);expect(before.units).toHaveLength(4)
  for(const row of before.units){expect(row.quantity).toBe('500.0000');expect(row.quality_status).toBe('qualified');expect(row.status).toBe('in_stock')}
  expect((await pool.query('SELECT count(*)::int n FROM reservation WHERE unit_id=ANY($1::uuid[])',[ids])).rows[0]!.n).toBe(0)
  const user=(await pool.query('SELECT role_id FROM user_account WHERE id=$1',[s.context.actorUserId])).rows[0]!
  const auth:VerifiedAuthContext={session:{id:'hold-read',expiresAt:'2099-01-01'},user:{id:s.context.actorUserId,loginName:'admin',displayName:'admin',enterpriseId:s.context.enterpriseId,plantId:p.id,roleId:user.role_id,loginPlatform:'WEB'},role:{id:user.role_id,name:'sysadmin',alias:'sysadmin'},permissions:['inventory.read'],dataScope:{enterpriseWide:true,plantIds:[]}}
  const query=buildInventoryQueryService(pool),available=[]
  for(const id of ids){const no=(await pool.query('SELECT unit_no FROM inventory_unit WHERE id=$1',[id])).rows[0]!.unit_no;const result=await query.listBalances(auth,{plantId:p.id,unitNoLike:no});expect(result.items).toHaveLength(1);expect(result.items[0]).toMatchObject({quantity:'500.0000',qualityStatus:'qualified',businessHeld:true,availableQuantity:'0.0000'});available.push(result.items[0])}
  const logs=(await readFile(`${s.run.evidence}/same-run.jsonl`,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  const original=logs.find(row=>row.kind==='MOM_COMMAND'&&row.envelope.operationId===s.operations['n2-business-hold'])!
  const replay=await s.inventory.execute(original.envelope,s.context);expect(replay.status).toBe('COMMITTED');expect(replay.data).toEqual(original.result.data)
  const payload=original.envelope.payload as Record<string,unknown>
  await cmd(s.inventory,'inventory.business-hold.establish',payload)
  const qc=(await pool.query("SELECT id FROM user_account WHERE login_name='szqc01'")).rows[0]!
  const denied=await cmd(s.inventory,'inventory.business-hold.establish',{...payload,businessRef:'FORBIDDEN'},false,{...s.context,actorUserId:qc.id,actorLoginName:'szqc01'});expect(denied.errorCode).toBe('ERR_FORBIDDEN_SCOPE')
  const hf=(await pool.query("SELECT id,plant_id FROM user_account WHERE login_name='hfadmin01'")).rows[0]!
  await cmd(s.org,'org.grant.grant',{principalType:'user',principalId:hf.id,scopeType:'plant',scopeObjectId:hf.plant_id,permissions:['inventory.post']})
  const cross=await cmd(s.inventory,'inventory.business-hold.establish',{...payload,businessRef:'WRONG-PLANT'},false,{...s.context,actorUserId:hf.id,actorLoginName:'hfadmin01'});expect(cross.errorCode).toBe('ERR_FORBIDDEN_SCOPE')
  for(const id of ids){
   const issued=await cmd(s.inventory,'inventory.issue-material',{unitId:id,quantity:'1'},false);expect(issued.errorMessage).toContain('IT-BUSINESS-HOLD')
   const split=await cmd(s.inventory,'inventory.split',{sourceUnitId:id,retainedQty:'400',lossQty:'0',children:[{unitNo:`HOLD-ESCAPE-${id}`,quantity:'100',locationId:p.location,locationCode:p.locationCode}]},false);expect(split.errorMessage).toContain('IT-BUSINESS-HOLD')
  }
  const target=await cmd(s.process,'process.order.receive',{orderNo:'HOLD-CONSUME-TARGET',materialId:s.materials['CBL01G-F3'],productionDeptId:p.prod,productionQty:'500',uom:'M',initialStatus:'released',processConfirmed:true,salesOrderNo:'HOLD-SO',lineNo:'10',operations:[{seq:1,operationDefinitionId:p.operation,workCenterId:p.wc,offlineQty:'500'}]})
  const targetId=String(target.data.orderId);await cmd(s.process,'process.order.start',{},true,s.context,targetId)
  const op=(await pool.query('SELECT id FROM order_operation WHERE order_id=$1',[targetId])).rows[0]!.id
  const consumed=await cmd(s.execution,'execution.feed.submit',{orderId:targetId,orderOperationId:op,lines:[{unitId:ids[0],quantity:'1',confirmed:true,deviationReason:'Authorized external source cannot override business custody',salesOrderNo:'HOLD-SO',salesLineNo:'10'}]},false);expect(consumed.errorMessage).toContain('IT-BUSINESS-HOLD')
  const ship=buildShippingCommandBus(pool)
  const pl=await cmd(ship,'shipping.pl.inbound',{plantId:p.id,plNo:'HOLD-PL',salesOrderNo:'CBL01G-SO-N2',lines:[{lineKind:'plain_item',materialCode:'F3',requiredCount:4,segmentLength:'500'}]})
  for(const id of ids){const no=(await pool.query('SELECT unit_no FROM inventory_unit WHERE id=$1',[id])).rows[0]!.unit_no;await cmd(ship,'shipping.scan.load',{plantId:p.id,shipmentOrderId:pl.data.orderId,lineId:(pl.data.lines as Array<{lineId:string}>)[0]!.lineId,unitNo:no,actualSegmentLength:'500'})}
  const shipBefore=(await pool.query('SELECT * FROM shipment_order WHERE id=$1',[pl.data.orderId])).rows
  const refused=await cmd(ship,'shipping.ship.confirm',{plantId:p.id,shipmentOrderId:pl.data.orderId},false);expect(refused.errorMessage).toContain('IT-BUSINESS-HOLD')
  expect((await pool.query('SELECT * FROM shipment_order WHERE id=$1',[pl.data.orderId])).rows).toEqual(shipBefore)
  expect(await facts()).toEqual(before)
  expect((await pool.query("SELECT count(*)::int n FROM inventory_unit WHERE unit_no LIKE 'HOLD-ESCAPE-%'")).rows[0]!.n).toBe(0)
  evidence.push({before,after:await facts(),available,replay,externalStates,shipmentBefore:shipBefore,shipmentAfter:(await pool.query('SELECT * FROM shipment_order WHERE id=$1',[pl.data.orderId])).rows})
 }finally{await writeFile(`${s.run.evidence}/business-hold-proof.json`,JSON.stringify(evidence,null,2))}
}

