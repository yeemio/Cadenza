import {format4,parseScaled} from './decimals'

export interface OeeInterval {fromAt:string;toAt:string|null}
export interface OeeOutputRow {
  id:string;reportId:string;equipmentId:string|null;equipmentCode:string|null
  sessionEquipmentId:string|null;sessionEquipmentCode:string|null;sessionConsistent:boolean
  quantity:string;qualifiedQty:string;uomId:string;uomCode:string;businessTime:string
}
export interface OeeEquipmentBasis {
  basisId:string;outputUomId:string;outputUomCode:string;standardSpeedPerHour:string
  /** Explicit planned-production intervals; a query window alone never proves planned time. */
  plannedIntervals:OeeInterval[]
}
export function validOeeWindow(from:string,to:string):boolean {
  const iso=/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/
  const valid=(value:string)=>iso.test(value)&&Number.isFinite(Date.parse(value))&&new Date(`${value.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10)===value.slice(0,10)&&Number(value.slice(11,13))<24
  return valid(from)&&valid(to)&&Date.parse(to)>Date.parse(from)
}
/** Half-open clipped interval union, including open downtime and excluding boundary-only contact. */
export function oeeIntervalMinutes(intervals:readonly OeeInterval[],from:string,to:string):string|null {
  if(!validOeeWindow(from,to))return null
  const start=Date.parse(from),end=Date.parse(to)
  const ranges:Array<[number,number]>=[]
  for(const interval of intervals){const a=Date.parse(interval.fromAt),b=interval.toAt===null?end:Date.parse(interval.toAt);if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)return null;const left=Math.max(start,a),right=Math.min(end,b);if(right>left)ranges.push([left,right])}
  ranges.sort((a,b)=>a[0]-b[0]);let until=start,total=0n
  for(const [a,b] of ranges){total+=BigInt(Math.max(0,b-Math.max(a,until)));until=Math.max(until,b)}
  return format4((total*10000n+30000n)/60000n)
}
export function oeeDowntimeInPlan(downtime:readonly OeeInterval[],planned:readonly OeeInterval[],from:string,to:string):string|null {
  if(!validOeeWindow(from,to))return null
  const intersect:OeeInterval[]=[]
  for(const d of downtime)for(const p of planned){const a=Math.max(Date.parse(from),Date.parse(d.fromAt),Date.parse(p.fromAt));const b=Math.min(Date.parse(to),d.toAt===null?Date.parse(to):Date.parse(d.toAt),p.toAt===null?Date.parse(to):Date.parse(p.toAt));if(!Number.isFinite(a)||!Number.isFinite(b))return null;if(b>a)intersect.push({fromAt:new Date(a).toISOString(),toAt:new Date(b).toISOString()})}
  return oeeIntervalMinutes(intersect,from,to)
}
/** Explicit typed rate+unit and planned time are absent from equipment.std_rate_text. No inferred units. */
export function configuredOeeBasis(raw:string|undefined,equipmentId:string):OeeEquipmentBasis|null {
  try{
    const map:unknown=JSON.parse(raw??'{}');if(!map||typeof map!=='object'||Array.isArray(map))return null
    const value=(map as Record<string,unknown>)[equipmentId] as OeeEquipmentBasis|undefined
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if(!value||typeof value.basisId!=='string'||!value.basisId.trim()||!uuid.test(value.outputUomId)||typeof value.outputUomCode!=='string'||!value.outputUomCode.trim()||!/^\d+(?:\.\d{1,4})?$/.test(value.standardSpeedPerHour)||parseScaled(value.standardSpeedPerHour,'CE-10')<=0n||!Array.isArray(value.plannedIntervals)||!value.plannedIntervals.length)return null
    if(value.plannedIntervals.some(p=>!p||p.toAt===null||!validOeeWindow(p.fromAt,p.toAt)))return null
    return {...value,outputUomId:value.outputUomId.toLowerCase()}
  }catch{return null}
}
/** Report/session UUIDs must identify the same actual device. A display code alone is not a durable identity. */
export function equipmentOeeOutput(rows:readonly OeeOutputRow[],equipment:{id:string;code:string},basis:OeeEquipmentBasis|null){
  let total=0n,qualified=0n;const rowIds:string[]=[],missing=new Set<string>()
  for(const row of rows){
    const ids=[row.equipmentId,row.sessionEquipmentId].filter((x):x is string=>!!x),codes=[row.equipmentCode,row.sessionEquipmentCode].filter((x):x is string=>!!x)
    const mentions=ids.includes(equipment.id)||codes.includes(equipment.code),unattributed=ids.length===0&&codes.length===0
    if(!mentions&&!unattributed)continue
    if(!row.sessionConsistent||!ids.includes(equipment.id)||ids.some(id=>id!==equipment.id)||codes.some(code=>code!==equipment.code)){missing.add('equipment_attribution_missing_or_conflicting');continue}
    if(!basis){missing.add('measurement_basis_missing');continue}
    const at=Date.parse(row.businessTime)
    if(!Number.isFinite(at)){missing.add('output_time_missing');continue}
    if(!basis.plannedIntervals.some(p=>at>=Date.parse(p.fromAt)&&at<Date.parse(p.toAt!)))continue
    if(row.uomId.toLowerCase()!==basis.outputUomId||row.uomCode!==basis.outputUomCode){missing.add('output_unit_mismatch');continue}
    try{const q=parseScaled(row.quantity,'CE-10'),good=parseScaled(row.qualifiedQty,'CE-10');if(q<0n||good<0n||good>q){missing.add('output_inconsistent');continue}total+=q;qualified+=good;rowIds.push(row.id)}catch{missing.add('output_inconsistent')}
  }
  if(rowIds.length===0)missing.add('output_missing')
  return {totalQty:missing.size?null:format4(total),qualifiedQty:missing.size?null:format4(qualified),rowIds,missing:[...missing]}
}
