import {describe,expect,it} from 'vitest'
import {cswCalibrationEffectAt,cswDowntimeFraction,createCswCommandHandlers,type CswCalibrationStateRecord,type CommandContext,type CommandTools} from '@cadenza/application'
import {assertCalibrationAllowsNewSlot} from '@cadenza/domain'
import {cswGaugeBindings} from '../../packages/persistence/src/csw-repositories'
const date='2026-11-03',at=(h:number)=>`${date}T${String(h).padStart(2,'0')}:00:00.000Z`
const state=(patch:Partial<CswCalibrationStateRecord>={}):CswCalibrationStateRecord=>({id:'r',enterpriseId:'e',plantId:'p',equipmentId:'eq',calibrationResult:'qualified',validUntil:'2026-11-04',certificateNo:'C',affectedSlotIds:[],createdBy:'u',updatedBy:'u',createdAt:'2026-11-02T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z',source:'spc_calibration_record',sourceCalibratedAt:'2026-11-02T12:00:00Z',sourceValidUntil:'2026-11-04T00:00:00Z',...patch})
describe('PR10 pure business-fact interpretation (no DB claim)',()=>{
  it('whole-day qualified fact permits scheduling',()=>expect(cswCalibrationEffectAt(state(),date)).toBe('usable'))
  it('limited retains the frozen positive gate',()=>expect(cswCalibrationEffectAt(state({calibrationResult:'limited'}),date)).toBe('usable'))
  it('failed calibration remains invalid even before certificate expiry',()=>expect(cswCalibrationEffectAt(state({calibrationResult:'invalid'}),date)).toBe('invalid'))
  it('midday expiry cannot be rounded up to a full available day',()=>expect(cswCalibrationEffectAt(state({sourceValidUntil:at(12)}),date)).toBe('expired'))
  it('exact next-day midnight covers the prior half-open UTC date',()=>expect(cswCalibrationEffectAt(state(),date)).toBe('usable'))
  it('new calibration during a date does not prove the earlier part qualified',()=>expect(cswCalibrationEffectAt(state({sourceCalibratedAt:at(12)}),date)).toBe('unknown'))
  it('missing mapping is explicitly UNKNOWN',()=>expect(cswCalibrationEffectAt(state({calibrationResult:'unknown',source:'UNKNOWN'}),date)).toBe('unknown'))
  it('missing calibration remains UNKNOWN',()=>expect(cswCalibrationEffectAt(null,date)).toBe('unknown'))
  it('invalid timestamp cannot manufacture usable qualification',()=>expect(cswCalibrationEffectAt(state({sourceValidUntil:'?'}),date)).toBe('unknown'))
  it.each(['invalid','expired'] as const)('negative %s gate rejects a new positive slot',effect=>expect(()=>assertCalibrationAllowsNewSlot({effect,equipmentName:'E',existingSlotPlannedQty:null,newPlannedQty:'1'})).toThrow())
  it.each(['invalid','expired'] as const)('negative %s gate retains existing slot changes and zero deletion',effect=>{expect(()=>assertCalibrationAllowsNewSlot({effect,equipmentName:'E',existingSlotPlannedQty:'2',newPlannedQty:'1'})).not.toThrow();expect(()=>assertCalibrationAllowsNewSlot({effect,equipmentName:'E',existingSlotPlannedQty:null,newPlannedQty:'0'})).not.toThrow()})
  it('empty events give zero use',()=>expect(cswDowntimeFraction([],date)).toBe(0))
  it('open event occupies the remaining part of the day',()=>expect(cswDowntimeFraction([{fromAt:at(6),toAt:null}],date)).toBe(.75))
  it('prior open event occupies the full day',()=>expect(cswDowntimeFraction([{fromAt:'2026-11-02T06:00:00Z',toAt:null}],date)).toBe(1))
  it('closed event still occupies its actual historical interval',()=>expect(cswDowntimeFraction([{fromAt:at(6),toAt:at(12)}],date)).toBe(.25))
  it('disjoint outages add, rather than taking only their maximum',()=>expect(cswDowntimeFraction([{fromAt:at(0),toAt:at(6)},{fromAt:at(12),toAt:at(18)}],date)).toBe(.5))
  it('overlapping facts are unioned without double counting',()=>expect(cswDowntimeFraction([{fromAt:at(0),toAt:at(12)},{fromAt:at(6),toAt:at(18)}],date)).toBe(.75))
  it('closing exactly at midnight consumes no next-day capacity',()=>expect(cswDowntimeFraction([{fromAt:'2026-11-02T12:00:00Z',toAt:at(0)}],date)).toBe(0))
  it('future outage consumes no earlier-day capacity',()=>expect(cswDowntimeFraction([{fromAt:'2026-11-04T00:00:00Z',toAt:null}],date)).toBe(0))
  it('reversed and invalid intervals do not invent downtime',()=>expect(cswDowntimeFraction([{fromAt:at(6),toAt:at(0)},{fromAt:'?',toAt:null}],date)).toBe(0))
  const eq='11111111-1111-4111-8111-111111111111',gauge='22222222-2222-4222-8222-222222222222'
  it('accepts an explicit UUID mapping',()=>expect(cswGaugeBindings(JSON.stringify({[eq]:gauge}))).toEqual({bindings:{[eq]:gauge},issue:null}))
  it.each([undefined,'{}','[]','{','{"EQ-NAME":"GAUGE-NAME"}'])('does not infer mapping from missing/invalid config %s',raw=>expect(cswGaugeBindings(raw).bindings).toEqual({}))
  it.each(['csw.calibration.state.set','csw.downtime.register','csw.downtime.close'])('%s cannot create independent shadow facts',async commandType=>{const handler=createCswCommandHandlers().find(h=>h.commandType===commandType)!;const result=await handler.handle({commandType,operationId:'x',targetId:'x',expectedRevision:0,payload:{}},{} as CommandContext,{} as CommandTools);expect(result.status).toBe('BUSINESS_REJECTION');expect(result.errorMessage).toMatch(/业务入口/)} )
})
