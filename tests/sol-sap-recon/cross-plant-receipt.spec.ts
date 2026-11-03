import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ConfigService } from '@nestjs/config'
import type { CommandBus, CommandContext } from '@cadenza/application'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildMasterDataCommandBus } from '../../apps/api/src/masterdata/masterdata.composition'
import { buildOrgCommandBus } from '../../apps/api/src/org/org.composition'
import { prepareExclusiveEnvironment } from '../../scripts/sol-sap-recon/environment'
let env: Awaited<ReturnType<typeof prepareExclusiveEnvironment>>
let bus: CommandBus, master: CommandBus
let admin: CommandContext, sourceOnly: CommandContext, destOnly: CommandContext
let sz: string, hf: string, gz: string, owner: string, nfOwner: string, cross: string, crossOwner: string
const locations: Record<string,{id:string;code:string}> = {}
const evidence: unknown[]=[]
async function cmd(commandType:string,payload:Record<string,unknown>,actor=admin,target=bus) {
 const envelope={operationId:randomUUID(),commandType,targetId:'new',expectedRevision:0,payload}
 const result=await target.execute(envelope,actor);evidence.push({envelope,actor:actor.actorLoginName,result});return { ...result, data: (result.data ?? {}) as Record<string,unknown> }
}
async function receive(qty='100') {
 const r=await cmd('inventory.receive-goods',{plantId:sz,lotNo:randomUUID(),unitNo:randomUUID(),materialId:randomUUID(),materialCode:'D5-SKU',uomId:randomUUID(),uomCode:'M',measurementBasis:'core_m',quantity:qty,locationId:locations[sz]!.id,locationCode:locations[sz]!.code,ownerId:owner,ownerName:'D5 source',qualityStatus:'qualified'})
 expect(r.status,JSON.stringify(r)).toBe('COMMITTED');return String(r.data?.['unitId'])
}
async function outbound(unitId:string,quantity='100') {
 const r=await cmd('inventory.transfer.out',{unitId,quantity,transitLocationId:randomUUID(),transitLocationCode:'D5-TRANSIT'})
 expect(r.status,JSON.stringify(r)).toBe('COMMITTED')
 const b=(await env.pool.query('SELECT id,location_id FROM stock_balance WHERE id=$1',[r.data?.['transitBalanceId']])).rows[0]!
 return b.location_id as string
}
const payload=(unitId:string,transitLocationId:string,plantId=hf,ownerId=owner,quantity='100')=>({unitId,quantity,transitLocationId,toPlantId:plantId,toOwnerId:ownerId,toLocationId:locations[plantId]!.id,toLocationCode:'UNTRUSTED-IGNORED'})
beforeAll(async()=>{
 env=await prepareExclusiveEnvironment('d5-cross-plant');bus=buildInventoryCommandBus(env.pool);master=buildMasterDataCommandBus(env.pool)
 const rows=(await env.pool.query('SELECT id,code FROM org_node')).rows
 const id=(code:string)=>String(rows.find(x=>x.code===code)!.id)
 sz=id('PLNT-SZ');hf=id('PLNT-HF');gz=id('PLNT-GZ');owner=id('LE-HDMIKE');nfOwner=id('LE-NFMIKE')
 const users=(await env.pool.query("SELECT id,login_name,enterprise_id FROM user_account WHERE login_name IN ('admin','szws01','hfadmin01')")).rows
 const context=(name:string)=>{const u=users.find(x=>x.login_name===name)!;return {actorUserId:u.id,actorLoginName:name,enterpriseId:u.enterprise_id,reason:'D5 test'} as CommandContext}
 admin=context('admin');sourceOnly=context('szws01');destOnly=context('hfadmin01')
 const org=buildOrgCommandBus(env.pool,new ConfigService())
 const legal=await cmd('org.node.create',{kind:'legal_entity',parentId:id('ENT-HD'),code:'D5-LEGAL',name:'D5 legal'},admin,org);expect(legal.status).toBe('COMMITTED');crossOwner=String(legal.data?.['nodeId'])
 const plant=await cmd('org.node.create',{kind:'plant',parentId:crossOwner,code:'D5-PLANT',name:'D5 plant',plantCode:'D5'},admin,org);expect(plant.status).toBe('COMMITTED');cross=String(plant.data?.['nodeId'])
 const dept=await cmd('org.node.create',{kind:'department',parentId:cross,code:'D5-DEPT',name:'D5 production',deptCategory:1},admin,org);expect(dept.status).toBe('COMMITTED')
 // Destination location facts are actual product masterdata; GZ is already represented by seed but admin cannot create there.
 for(const [plantId,deptId,code] of [[sz,id('DEPT-SZ-JZ'),'7201'],[hf,id('DEPT-HF-JZ'),'7202'],[cross,String(dept.data?.['nodeId']),'7203']]) {
  const wh=await cmd('masterdata.warehouse.create',{plantId,deptId,code,name:`D5 warehouse ${code}`,warehouseType:'LINE_SIDE',materialTypes:[1,2,3]},admin,master);expect(wh.status,JSON.stringify(wh)).toBe('COMMITTED')
  const loc=await cmd('masterdata.location.create',{warehouseId:wh.data?.['warehouseId'],code:`${code}0001`,name:`D5 location ${code}`,locationKind:'NORMAL'},admin,master);expect(loc.status,JSON.stringify(loc)).toBe('COMMITTED')
  locations[plantId!]={id:String(loc.data?.['locationId']),code:`${code}0001`}
 }
 locations[gz]={id:locations[hf]!.id,code:'FOREIGN'}
},30000)
afterAll(async()=>{if(env){await writeFile(`${env.evidence}/commands.json`,JSON.stringify(evidence,null,2));await env.pool.end()}})
it('same legal and cross legal same-enterprise receipt moves current unit and destination ledger only',async()=>{
 for(const [plantId,ownerId] of [[hf,owner],[cross,crossOwner]]) {
  const unit=await receive();const transit=await outbound(unit);const r=await cmd('inventory.transfer.in',payload(unit,transit,plantId,ownerId));expect(r.status,JSON.stringify(r)).toBe('COMMITTED')
  const rows=(await env.pool.query('SELECT u.plant_id,b.plant_id AS balance_plant,b.owner_id,b.quantity,b.location_code FROM inventory_unit u JOIN stock_balance b ON b.unit_id=u.id WHERE u.id=$1 AND b.quantity>0',[unit])).rows
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({plant_id:plantId,balance_plant:plantId,owner_id:ownerId,quantity:'100.0000',location_code:locations[plantId!]!.code})
  const txn=(await env.pool.query("SELECT plant_id,quantity FROM stock_transaction WHERE unit_id=$1 AND movement_kind='transfer_in' ORDER BY quantity",[unit])).rows
  expect(txn).toEqual([{plant_id:sz,quantity:'-100.0000'},{plant_id:plantId,quantity:'100.0000'}]);evidence.push({unit,rows,txn})
 }
})
it('requires both plant scopes and rejects cross enterprise/owner-location mismatch',async()=>{
 const unit=await receive();const transit=await outbound(unit)
 for(const actor of [sourceOnly,destOnly]) {const r=await cmd('inventory.transfer.in',payload(unit,transit),actor);expect(r.status).toBe('BUSINESS_REJECTION');expect(r.errorCode).toBe('ERR_FORBIDDEN_SCOPE')}
 for(const [plantId,ownerId] of [[gz,nfOwner],[hf,nfOwner]]){const r=await cmd('inventory.transfer.in',payload(unit,transit,plantId,ownerId));expect(r.status).toBe('BUSINESS_REJECTION')}
})
it('rejects ordinary balances, excess and partial receipts, or a remaining source balance',async()=>{
 const fake=await receive();const r=await cmd('inventory.transfer.in',payload(fake,locations[sz]!.id));expect(r.status).toBe('BUSINESS_REJECTION')
 const full=await receive();const transit=await outbound(full)
 for(const qty of ['101','50']){const result=await cmd('inventory.transfer.in',payload(full,transit,hf,owner,qty));expect(result.status).toBe('BUSINESS_REJECTION')}
 const partial=await receive();const t=await outbound(partial,'50');const result=await cmd('inventory.transfer.in',payload(partial,t,hf,owner,'50'));expect(result.status).toBe('BUSINESS_REJECTION')
 expect((await env.pool.query('SELECT quantity FROM stock_balance WHERE unit_id=$1 AND quantity>0',[partial])).rows.map(x=>x.quantity).sort()).toEqual(['50.0000','50.0000'])
})
