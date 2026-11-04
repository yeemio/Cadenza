import { afterEach, describe, expect, it } from 'vitest'
import { computeShiftDate } from '../../packages/domain/src/inventory/time'
import { factoryCalendar, shiftDateForPlant } from '../../packages/application/src/inventory-posting'
import { computeBusinessShiftDate, plantTimezoneOffsetHours } from '../../packages/ui/src/i18n/time'
const old = process.env['CADENZA_PLANT_UTC_OFFSETS']
afterEach(() => { if (old === undefined) delete process.env['CADENZA_PLANT_UTC_OFFSETS']; else process.env['CADENZA_PLANT_UTC_OFFSETS'] = old })
describe('PR08 shared server calendar (configured fixtures; site unverified)', () => {
  it.each([
    ['cn-id', 8, '00:00', '2026-11-03T15:30:00Z', '2026-11-03'],
    ['kr-id', 9, '00:00', '2026-11-03T15:30:00Z', '2026-11-04'],
    ['cn-id', 8, '07:30', '2026-11-03T23:29:59Z', '2026-11-03'],
    ['cn-id', 8, '07:30', '2026-11-03T23:30:00Z', '2026-11-04'],
    ['kr-id', 9, '07:30', '2026-11-03T22:29:59Z', '2026-11-03'],
    ['kr-id', 9, '07:30', '2026-11-03T22:30:00Z', '2026-11-04'],
  ] as const)('%s %s %s at %s => %s across UI and ledger formula', async (id, offset, start, instant, date) => {
    process.env['CADENZA_PLANT_UTC_OFFSETS'] = JSON.stringify({ [id]: offset })
    const config = factoryCalendar(id, start)
    expect(config.verification).toBe('CONFIGURED_SITE_UNVERIFIED')
    expect(computeShiftDate(instant, config)).toBe(date)
    expect(computeBusinessShiftDate(new Date(instant), config)).toBe(date)
    const tools = { org: { findPlantDayShiftStart: async (plant: string) => { expect(plant).toBe(id); return start } } } as Parameters<typeof shiftDateForPlant>[0]
    expect(await shiftDateForPlant(tools, id, instant)).toBe(date)
  })
  it('missing configuration is explicitly unverified; names never choose timezone', () => {
    delete process.env['CADENZA_PLANT_UTC_OFFSETS']
    expect(factoryCalendar('any-id', null).verification).toBe('UNVERIFIED_DEFAULT')
    expect(plantTimezoneOffsetHours('한국 KR 韩国', 'KR')).toBeNull()
  })
  it.each(['broken', '[]', '{"x":99}'])('rejects invalid configuration %s', raw => {
    process.env['CADENZA_PLANT_UTC_OFFSETS'] = raw; expect(() => factoryCalendar('x', '00:00')).toThrow()
  })
  it('does not silently discard invalid persisted minute configuration', () => { expect(() => factoryCalendar('x', '07:60')).toThrow() })
})
