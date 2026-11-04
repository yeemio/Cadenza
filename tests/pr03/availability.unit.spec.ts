import { describe, expect, it } from 'vitest'
import { computeAvailability, evaluateAvailability, type QualityStatus } from '@cadenza/domain'

const now = '2026-11-03T10:00:00.000Z'
const active = { status: 'active', quantity: '10.0000', validUntil: '2026-11-03T11:00:00.000Z' }

describe('PR03 pure availability rules (not PostgreSQL evidence)', () => {
  for (const qualityStatus of ['qualified', 'unqualified', 'pending_inspection', 'suspect'] as QualityStatus[]) {
    for (const [qualityHeld, businessHeld] of [[false, false], [true, false], [false, true], [true, true]]) {
      it(`${qualityStatus}, quality hold=${qualityHeld}, business hold=${businessHeld}`, () => {
        const result = evaluateAvailability({ grossQty: '20.0000', qualityStatus, qualityHeld, businessHeld, activeReservations: [active], now })
        const allowed = qualityStatus === 'qualified' && !qualityHeld && !businessHeld
        expect(result.available).toBe(allowed ? '10.0000' : '0.0000')
        expect(result.eligible).toBe(allowed)
        expect(result.reserved).toBe('10.0000')
        expect(result.reasons.includes('QUALITY_HOLD')).toBe(qualityHeld)
        expect(result.reasons.includes('BUSINESS_HOLD')).toBe(businessHeld)
        expect(result.reasons.includes('QUALITY_NOT_RELEASED')).toBe(qualityStatus !== 'qualified')
      })
    }
  }
  it('expired/released/consumed reservations do not allocate current stock', () => {
    expect(computeAvailability({ grossQty: '20.0000', qualityStatus: 'qualified', now, activeReservations: [
      { ...active, validUntil: '2026-11-03T09:00:00Z' }, { ...active, status: 'released' }, { ...active, status: 'consumed' },
    ] })).toEqual({ gross: '20.0000', reserved: '0.0000', available: '20.0000' })
  })
  it('overallocated historical stock is clamped to zero', () => {
    expect(evaluateAvailability({ grossQty: '5.0000', qualityStatus: 'qualified', now, activeReservations: [active] }).available).toBe('0.0000')
  })
  it('allocation keeps four-place decimal precision', () => {
    expect(evaluateAvailability({ grossQty: '1.0001', qualityStatus: 'qualified', now, activeReservations: [{ ...active, quantity: '0.0002' }] }).available).toBe('0.9999')
  })
  it('removing quality custody cannot remove independent business custody', () => {
    const result = evaluateAvailability({ grossQty: '20.0000', qualityStatus: 'qualified', qualityHeld: false, businessHeld: true, now, activeReservations: [] })
    expect(result.available).toBe('0.0000'); expect(result.reasons).toEqual(['BUSINESS_HOLD'])
  })
  it('a valid own allocation cannot restore quality eligibility', () => {
    const result = evaluateAvailability({ grossQty: '20.0000', qualityStatus: 'suspect', now, activeReservations: [] })
    expect(result.eligible).toBe(false); expect(result.available).toBe('0.0000')
  })
  it('no-stock and reservation causes remain distinguishable', () => {
    expect(evaluateAvailability({ grossQty: '0.0000', qualityStatus: 'qualified', now, activeReservations: [] }).reasons).toEqual(['NO_STOCK'])
    expect(evaluateAvailability({ grossQty: '10.0000', qualityStatus: 'qualified', now, activeReservations: [active] }).reasons).toEqual(['RESERVED'])
  })
})
