import {describe,expect,it} from 'vitest'
import {computeOee,equipmentOeeOutput,oeeIntervalMinutes,oeeDowntimeInPlan,configuredOeeBasis,validOeeWindow,type OeeEquipmentBasis,type OeeOutputRow} from '@cadenza/domain'
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',U='33333333-3333-4333-8333-333333333333'
const from='2026-11-03T08:00:00Z',to='2026-11-03T16:00:00Z'
const basis:OeeEquipmentBasis={basisId:'fixture-plan-and-standard',outputUomId:U,outputUomCode:'M',standardSpeedPerHour:'200',plannedIntervals:[{fromAt:from,toAt:to}]}
const row=(patch:Partial<OeeOutputRow>={}):OeeOutputRow=>({id:'out',reportId:'report',equipmentId:A,equipmentCode:'A',sessionEquipmentId:A,sessionEquipmentCode:'A',sessionConsistent:true,quantity:'1400',qualifiedQty:'1330',uomId:U,uomCode:'M',businessTime:'2026-11-03T12:00:00Z',...patch})
const calculate=(patch:Partial<Parameters<typeof computeOee>[0]>={})=>computeOee({plannedMinutes:'480',downtimeMinutes:'60',standardSpeedPerHour:'200',actualOutputQty:'1400',qualifiedQty:'1330',...patch})
describe('PR11 exact OEE arithmetic and fact selection',()=>{
  it('computes independently reproducible 480/60/200/1400/1330 values',()=>expect(calculate()).toEqual({availability:'0.8750',performance:'1.0000',qualityRate:'0.9500',oee:'0.8313',missing:[]}))
  it('rounds final OEE once rather than multiplying rounded displayed rates',()=>expect(calculate({actualOutputQty:'1500',qualifiedQty:'1425'}).oee).toBe('0.8906'))
  it.each(['plannedMinutes','downtimeMinutes','standardSpeedPerHour','actualOutputQty','qualifiedQty'] as const)('missing %s produces no percentage',key=>expect(calculate({[key]:null}).oee).toBeNull())
  it('zero running time is missing denominator, never zero performance',()=>expect(calculate({downtimeMinutes:'480'})).toMatchObject({oee:null,performance:null,missing:expect.arrayContaining(['runtime_missing'])}))
  it('zero output is missing quality denominator, never synthetic zero quality',()=>expect(calculate({actualOutputQty:'0',qualifiedQty:'0'})).toMatchObject({qualityRate:null,missing:expect.arrayContaining(['output_denominator_missing'])}))
  it('qualified output above total is inconsistent',()=>expect(calculate({qualifiedQty:'1401'}).missing).toContain('output_inconsistent'))
  it('negative downtime is invalid',()=>expect(calculate({downtimeMinutes:'-1'}).oee).toBeNull())
  it('downtime greater than plan is explicit missing/invalid, not a negative ratio',()=>expect(calculate({downtimeMinutes:'481'}).missing).toContain('downtime_exceeds_plan'))
  it('nonnumeric rate produces explicit missing status rather than throwing',()=>expect(calculate({standardSpeedPerHour:'unknown'}).oee).toBeNull())
  it('unrelated device B output cannot change device A',()=>{const a=equipmentOeeOutput([row()],{id:A,code:'A'},basis);expect(equipmentOeeOutput([row(),row({id:'b',equipmentId:B,equipmentCode:'B',sessionEquipmentId:B,sessionEquipmentCode:'B',quantity:'9999999'})],{id:A,code:'A'},basis)).toEqual(a)})
  it('same code with no durable equipment UUID is missing attribution',()=>expect(equipmentOeeOutput([row({equipmentId:null,sessionEquipmentId:null})],{id:A,code:'A'},basis).missing).toContain('equipment_attribution_missing_or_conflicting'))
  it('conflicting report/session equipment cannot be assigned silently',()=>expect(equipmentOeeOutput([row({sessionEquipmentId:B})],{id:A,code:'A'},basis).totalQty).toBeNull())
  it('unassigned output is disclosed, not allocated across devices',()=>expect(equipmentOeeOutput([row({equipmentId:null,equipmentCode:null,sessionEquipmentId:null,sessionEquipmentCode:null})],{id:A,code:'A'},basis).missing).toContain('equipment_attribution_missing_or_conflicting'))
  it('wrong session enterprise/factory association remains missing',()=>expect(equipmentOeeOutput([row({sessionConsistent:false})],{id:A,code:'A'},basis).totalQty).toBeNull())
  it.each([{uomCode:'KG'},{uomId:B}])('different output unit %j is not summed',patch=>expect(equipmentOeeOutput([row(),row(patch)],{id:A,code:'A'},basis).missing).toContain('output_unit_mismatch'))
  it('outputs outside planned intervals do not enter the planned-time numerator',()=>expect(equipmentOeeOutput([row({businessTime:to})],{id:A,code:'A'},basis).missing).toContain('output_missing'))
  it.each([
    [{fromAt:'2026-11-03T07:00:00Z',toAt:'2026-11-03T09:00:00Z'},'60.0000'],
    [{fromAt:'2026-11-03T15:00:00Z',toAt:'2026-11-03T18:00:00Z'},'60.0000'],
    [{fromAt:'2026-11-02T10:00:00Z',toAt:'2026-11-04T10:00:00Z'},'480.0000'],
    [{fromAt:'2026-11-03T15:00:00Z',toAt:null},'60.0000'],
    [{fromAt:'2026-11-03T07:00:00Z',toAt:from},'0.0000'],
    [{fromAt:to,toAt:null},'0.0000'],
  ] as const)('clips interval %j to exactly %s minutes',(interval,expected)=>expect(oeeIntervalMinutes([interval],from,to)).toBe(expected))
  it('unions overlapping intervals',()=>expect(oeeIntervalMinutes([{fromAt:from,toAt:'2026-11-03T10:00:00Z'},{fromAt:'2026-11-03T09:00:00Z',toAt:'2026-11-03T11:00:00Z'}],from,to)).toBe('180.0000'))
  it('clips downtime to planned production intervals as well as query window',()=>expect(oeeDowntimeInPlan([{fromAt:from,toAt:to}],[{fromAt:'2026-11-03T09:00:00Z',toAt:'2026-11-03T10:00:00Z'}],from,to)).toBe('60.0000'))
  it.each([[to,from],[from,from],['bad',to],['2026-11-03',to]])('invalid or timezone-free window %j is not a denominator',(a,b)=>expect(validOeeWindow(a!,b!)).toBe(false))
  it('missing explicit device plan/rate/unit basis is not inferred from display text',()=>expect(configuredOeeBasis(undefined,A)).toBeNull())
  it('accepts a complete explicit device basis',()=>expect(configuredOeeBasis(JSON.stringify({[A]:basis}),A)).toEqual(basis))
  it('rejects a nonexistent calendar date instead of normalizing it into another window',()=>expect(validOeeWindow('2026-02-30T08:00:00Z','2026-03-03T08:00:00Z')).toBe(false))
  it('does not silently truncate an over-precision standard speed',()=>expect(configuredOeeBasis(JSON.stringify({[A]:{...basis,standardSpeedPerHour:'1.123456'}}),A)).toBeNull())
  it.each([{outputUomId:'M'},{standardSpeedPerHour:'200 m/min'},{plannedIntervals:[]},{basisId:''}])('invalid basis %j remains unknown',patch=>expect(configuredOeeBasis(JSON.stringify({[A]:{...basis,...patch}}),A)).toBeNull())
})
