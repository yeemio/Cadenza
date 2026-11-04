import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { FeedScanPage } from '../../apps/pda/src/pages/FeedScanPage'
import { PutawayScanPage } from '../../apps/pda/src/pages/PutawayScanPage'
import { FeedingPage } from '../../apps/web/src/pages/FeedingPage'
import { BusinessClock } from '../../packages/ui/src/i18n/time'
import type { CommandIntent } from '../../packages/ui/src/api/client'
const f = vi.hoisted(() => ({ saved: null as CommandIntent | null, api: {
  readCommandIntent: vi.fn(), executeCommandIntent: vi.fn(), clearSettledCommandIntent: vi.fn(), listProductionOrders: vi.fn(), productionOrderDetail: vi.fn(), listPutawayTasks: vi.fn(), listWarehouses: vi.fn(), listLocations: vi.fn(),
} }))
vi.mock('../../apps/pda/src/api', () => ({ api: f.api }))
vi.mock('../../apps/web/src/api', () => ({ api: f.api }))
vi.mock('../../apps/pda/src/permissions', () => ({ EXECUTION_FEED: 'execution.feed', WAREHOUSING_POST: 'warehousing.post', usePermissions: () => ({ has: () => true }) }))
vi.mock('../../apps/web/src/permissions', () => ({ EXECUTION_FEED: 'execution.feed', PROCESS_READ: 'process.read', usePermissions: () => ({ has: () => true }) }))
beforeEach(() => {
  vi.clearAllMocks();f.saved=null
  f.api.readCommandIntent.mockImplementation(async()=>f.saved)
  f.api.clearSettledCommandIntent.mockImplementation(async()=>{f.saved=null})
  f.api.listProductionOrders.mockResolvedValue({items:[{id:'order-a',orderNo:'REAL-A'},{id:'order-b',orderNo:'REAL-B'}],total:2})
  f.api.productionOrderDetail.mockImplementation(async(id:string)=>({operations:[{id:id+'-1',seq:1,operationName:'FIRST'},{id:id+'-2',seq:2,operationName:'SECOND'}]}))
  f.api.executeCommandIntent.mockImplementation(async(_slot:string,kind:'feed'|'putaway',payload:Record<string,unknown>)=>{
    f.saved={version:1,kind,payload,operationId:'original-key',state:'unknown'};throw new Error('response lost')
  })
  f.api.listPutawayTasks.mockResolvedValue({items:[{id:'task-real',plantId:'plant-b',unitNo:'UNIT-B',palletCode:null,materialCode:'MAT-B',quantity:'20.0000',uomCode:'M',sourceRef:'report-b',targetWarehouseId:null}],total:1})
  f.api.listWarehouses.mockResolvedValue({items:[{id:'warehouse-b',plantId:'plant-b',name:'Actual warehouse B',warehouseType:'WAREHOUSE',status:'active'}],total:1})
  f.api.listLocations.mockResolvedValue({items:[{id:'location-b',plantId:'plant-b',warehouseId:'warehouse-b',code:'010101',locationKind:'RACK',status:'active'}],total:1})
})
afterEach(()=>cleanup())
function scan(code:string) { const input=screen.getByLabelText('扫码输入');fireEvent.change(input,{target:{value:code}});fireEvent.keyDown(input,{key:'Enter'}) }
describe('PR08 actual page components; API fixtures only, not PG evidence',()=>{
  it.each([['PDA',FeedScanPage],['Web',FeedingPage]] as const)('%s requires explicit second operation and clears old task when changing order',async(_name,Page)=>{
    render(<Page/>);await waitFor(()=>expect(screen.getByRole('option',{name:'REAL-A'})).toBeInTheDocument())
    const selects=screen.getAllByRole('combobox');fireEvent.change(selects[0]!,{target:{value:'order-a'}})
    await waitFor(()=>expect(screen.getByRole('option',{name:'2. SECOND'})).toBeInTheDocument())
    expect(selects[1]).toHaveValue('')
    fireEvent.change(selects[1]!,{target:{value:'order-a-2'}});scan('AE00000001')
    fireEvent.change(selects[0]!,{target:{value:'order-b'}})
    await waitFor(()=>expect(selects[1]).toHaveValue(''))
    expect(screen.queryByText('AE00000001')).not.toBeInTheDocument()
    expect(f.api.executeCommandIntent).not.toHaveBeenCalled()
  })
  it.each([['PDA',FeedScanPage],['Web',FeedingPage]] as const)('%s restores unresolved exact payload on navigation',async(_name,Page)=>{
    const payload={orderId:'order-b',orderOperationId:'order-b-2',feeds:[{barcodeValue:'AE00000001',quantity:'4.0000'}]}
    f.saved={version:1,kind:'feed',payload,operationId:'same-key',state:'unknown'}
    render(<Page/>);const retry=await screen.findByRole('button',{name:'以原操作键确认结果'})
    expect(screen.getAllByRole('combobox')[0]).toBeDisabled()
    fireEvent.click(retry);await waitFor(()=>expect(f.api.executeCommandIntent).toHaveBeenCalledWith(expect.any(String),'feed',payload))
  })
  it('putaway resolves actual task factory and actual warehouse location without client ownership',async()=>{
    render(<PutawayScanPage/>);await waitFor(()=>expect(screen.getByLabelText('扫码输入')).not.toBeDisabled());scan('UNIT-B')
    await waitFor(()=>expect(screen.getByRole('option',{name:'Actual warehouse B 010101'})).toBeInTheDocument())
    expect(f.api.listWarehouses).toHaveBeenCalledWith(expect.objectContaining({plantId:'plant-b'}))
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'location-b'}})
    fireEvent.click(screen.getByRole('button',{name:'确认入库'}))
    await waitFor(()=>expect(f.api.executeCommandIntent).toHaveBeenCalledWith('pda.putaway','putaway',{plantId:'plant-b',taskIds:['task-real'],toWarehouseId:'warehouse-b',toLocationId:'location-b',toLocationCode:'010101'}))
    expect(await screen.findByRole('button',{name:'以原操作键确认结果'})).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeDisabled()
  })
  it('putaway can retry unresolved task even if refresh no longer lists the committed task',async()=>{
    const payload={plantId:'plant-b',taskIds:['task-real'],toWarehouseId:'warehouse-b',toLocationId:'location-b',toLocationCode:'010101'}
    f.saved={version:1,kind:'putaway',payload,operationId:'same-key',state:'unknown'};f.api.listPutawayTasks.mockResolvedValue({items:[],total:0})
    render(<PutawayScanPage/>);fireEvent.click(await screen.findByRole('button',{name:'以原操作键确认结果'}))
    await waitFor(()=>expect(f.api.executeCommandIntent).toHaveBeenCalledWith('pda.putaway','putaway',payload))
  })
  it('clock displays server business day and configured offset regardless of country-like name',async()=>{
    const load=vi.fn(async()=>({plantId:'factory-real',dayShiftStart:'00:00',actualTime:'2026-11-03T15:30:00Z',shiftDate:'2026-11-04',calendar:{dayShiftStartHour:0,dayShiftStartMinute:0,utcOffsetHours:9,verification:'CONFIGURED_SITE_UNVERIFIED' as const}}))
    render(<BusinessClock plantId="factory-real" plantName="China misleading label" loadCalendar={load}/> )
    await waitFor(()=>expect(screen.getByTestId('business-clock')).toHaveAttribute('data-business-day','2026-11-04'))
    expect(screen.getByTestId('business-clock')).toHaveTextContent('UTC+9 00:30')
    expect(screen.getByTestId('business-clock')).toHaveTextContent('现场班表待核实')
  })
  it('missing calendar remains unverified, not a name-based default',async()=>{
    render(<BusinessClock plantId="factory-real" plantName="한국 KR" loadCalendar={async()=>{throw new Error('403')}}/> )
    await waitFor(()=>expect(screen.getByTestId('business-clock')).toHaveTextContent('业务日待核实'))
    expect(screen.getByTestId('business-clock')).not.toHaveAttribute('data-business-day')
  })
})
