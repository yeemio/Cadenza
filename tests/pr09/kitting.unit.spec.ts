import { describe,expect,it } from 'vitest'
import { calculateGroupKitting } from '../../packages/application/src/group-handlers'
import type { GroupKittingFacts,GroupKittingBasis } from '../../packages/application/src/group-repositories'
const at='2026-11-03T12:00:00Z',basis:GroupKittingBasis={outputQuantity:'100.0000',outputUom:'M'}
function facts():GroupKittingFacts {return {
  order:{id:'o',enterpriseId:'e',plantId:'p',orderNo:'REAL-ORDER',materialId:'output',quantity:'100.0000',uom:'M',settingsVersion:2,bomRevisionId:'b',status:'in_progress',operationCount:2,operationBomIds:['b']},
  bom:{id:'b',enterpriseId:'e',plantId:'p',materialId:'output',version:3,status:'published',publishedAt:at,lines:[{materialId:'c',materialCode:'C',quantity:'10.0000',uom:'M'}]},
  materials:[{id:'output',code:'OUT',baseUom:'M',status:'active',conversions:[]},{id:'c',code:'C',baseUom:'M',status:'active',conversions:[]}],
  stocks:[{unitId:'u',materialId:'c',uom:'M',quantity:'8.0000',qualityStatus:'qualified',unitStatus:'in_stock',qualityHeld:false,businessHeld:false,measurementKnown:true,reservations:[]}],
}}
const calc=(f:GroupKittingFacts,b:GroupKittingBasis|null=basis)=>calculateGroupKitting(f,b,at)
describe('PR09 full-order BOM requirement vs current factory available stock (pure fixtures)',()=>{
  it('computes shortage from bound versions and fixed-point quantities',()=>{const r=calc(facts());expect(r.outcome).toBe('SHORTAGE');expect(r.lines[0]).toMatchObject({required:'10.0000',available:'8.0000',shortage:'2.0000'});expect(r).toMatchObject({settingsVersion:2,bomVersion:3,requirementBasis:'FULL_ORDER_BOM'})})
  it('exactly enough stock is KIT_COMPLETE, not an empty calculation',()=>{const f=facts();f.stocks[0]!.quantity='10';const r=calc(f);expect(r.outcome).toBe('KIT_COMPLETE');expect(r.lines).toHaveLength(1);expect(r.lines[0]!.shortage).toBe('0.0000')})
  it('duplicate BOM component lines aggregate demand before comparing availability',()=>{const f=facts();f.bom!.lines.push({materialId:'c',materialCode:'C',quantity:'3',uom:'M'});expect(calc(f).lines[0]).toMatchObject({required:'13.0000',available:'8.0000',shortage:'5.0000'})})
  it.each(['businessHeld','qualityHeld'] as const)('%s cannot count as available',key=>{const f=facts();f.stocks[0]![key]=true;expect(calc(f).lines[0]).toMatchObject({available:'0.0000',shortage:'10.0000',excludedUnitIds:['u']})})
  it.each(['pending_inspection','unqualified','suspect'] as const)('%s is unavailable',quality=>{const f=facts();f.stocks[0]!.qualityStatus=quality;expect(calc(f).lines[0]!.available).toBe('0.0000')})
  it('active reservation is subtracted once per unit, expiry uses snapshot instant',()=>{const f=facts();f.stocks[0]!.reservations=[{status:'active',quantity:'3',validUntil:'2026-11-03T13:00:00Z'},{status:'active',quantity:'4',validUntil:'2026-11-03T11:00:00Z'}];expect(calc(f).lines[0]!.available).toBe('5.0000')})
  it('no stock is SHORTAGE with positive demand',()=>{const f=facts();f.stocks=[];expect(calc(f)).toMatchObject({outcome:'SHORTAGE',checkStatus:'shortage'});expect(calc(f).lines[0]!.shortage).toBe('10.0000')})
  it('missing order is distinct from zero shortage',()=>{const f=facts();f.order=null;expect(calc(f)).toMatchObject({outcome:'ORDER_NOT_FOUND',checkStatus:'error'})})
  it.each(['missingBom','missingBasis','emptyBom','versionConflict','wrongMaterial','unpublished'] as const)('%s is MISSING_DATA',kind=>{
    const f=facts();let b:GroupKittingBasis|null=basis
    if(kind==='missingBom')f.bom=null
    if(kind==='missingBasis')b=null
    if(kind==='emptyBom')f.bom!.lines=[]
    if(kind==='versionConflict')f.order!.operationBomIds=['other']
    if(kind==='wrongMaterial')f.bom!.materialId='other'
    if(kind==='unpublished')f.bom!.publishedAt=null
    expect(calc(f,b)).toMatchObject({outcome:'MISSING_DATA',checkStatus:'error'})
  })
  it('frozen retired BOM referenced by existing order remains usable',()=>{const f=facts();f.bom!.status='retired';expect(calc(f).outcome).toBe('SHORTAGE')})
  it('converts stock quantity from a unique actual material conversion',()=>{const f=facts();f.stocks[0]!.uom='KM';f.stocks[0]!.quantity='0.0100';f.materials[1]!.conversions=[{id:'cv',version:4,unitName:'KM',factor:'1000'}];expect(calc(f).lines[0]).toMatchObject({available:'10.0000',shortage:'0.0000'})})
  it.each(['missing','ambiguous','zero','mixedBalance'] as const)('%s measurement is UNCONVERTIBLE',kind=>{const f=facts();f.stocks[0]!.uom='KM';if(kind==='ambiguous')f.materials[1]!.conversions=[{id:'a',version:1,unitName:'KM',factor:'1000'},{id:'b',version:2,unitName:'KM',factor:'1000'}];if(kind==='zero')f.materials[1]!.conversions=[{id:'a',version:1,unitName:'KM',factor:'0'}];if(kind==='mixedBalance')f.stocks[0]!.measurementKnown=false;expect(calc(f).outcome).toBe('UNCONVERTIBLE')})
  it('uses a bound frozen stock conversion instead of an unrelated current revision',()=>{const f=facts();f.stocks[0]!.uom='ROLL';f.stocks[0]!.quantity='1';f.stocks[0]!.conversionRevisionId='old';f.stocks[0]!.conversionFactor='6';f.materials[1]!.conversions=[{id:'new',version:2,unitName:'ROLL',factor:'1000'}];expect(calc(f).lines[0]!.available).toBe('6.0000')})
  it('missing frozen non-base conversion does not fall back to a new active revision',()=>{const f=facts();f.stocks[0]!.uom='ROLL';f.stocks[0]!.conversionRevisionId='missing';expect(calc(f).reason).toBe('FROZEN_STOCK_CONVERSION_UNAVAILABLE')})
  it('already converted base-unit balance is not multiplied a second time',()=>{const f=facts();f.stocks[0]!.conversionRevisionId='original-purchase-conversion';f.stocks[0]!.conversionFactor='1000';expect(calc(f).lines[0]!.available).toBe('8.0000')})
  it('rounds fractional demand up; never rounds a tiny shortage down to complete',()=>{const f=facts();f.order!.quantity='1';f.bom!.lines=[{materialId:'c',materialCode:'C',quantity:'1',uom:'M'}];f.stocks=[];expect(calc(f,{outputQuantity:'3',outputUom:'M'}).lines[0]!.required).toBe('0.3334')})
  it('uses BigInt arithmetic beyond floating point integer precision',()=>{const f=facts();f.order!.quantity='9007199254740993';f.bom!.lines=[{materialId:'c',materialCode:'C',quantity:'0.0001',uom:'M'}];f.stocks=[];expect(calc(f,{outputQuantity:'1',outputUom:'M'}).lines[0]!.required).toBe('900719925474.0993')})
})
