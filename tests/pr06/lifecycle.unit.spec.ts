import { describe, expect, it } from 'vitest'
import { assertInboundCompletable, ReverseRuleViolation } from '@cadenza/domain'

describe('PR06 all physical receipts are required', () => {
  const check = (lines: { materialCode: string; pendingQty: string; inboundQty: string }[], toWarehouseLocked = false) =>
    assertInboundCompletable({ orderNo: 'IN-06', lines, toWarehouseLocked })
  for (const [pendingQty, inboundQty] of [['10','10'], ['1','99'], ['20','0'], ['-1','21'], ['0','0'], ['0','-1']]) {
    it(`rejects pending=${pendingQty}, received=${inboundQty}`, () => {
      expect(() => check([{ materialCode: 'A', pendingQty: pendingQty!, inboundQty: inboundQty! }])).toThrow(ReverseRuleViolation)
    })
  }
  it('accepts all units of one material', () => expect(() => check([{ materialCode: 'A', pendingQty: '0', inboundQty: '20' }])).not.toThrow())
  it('accepts fully received multiple materials', () => expect(() => check([
    { materialCode: 'A', pendingQty: '0', inboundQty: '20' }, { materialCode: 'B', pendingQty: '0', inboundQty: '3.0001' },
  ])).not.toThrow())
  it('cannot offset missing material B by excess material A', () => expect(() => check([
    { materialCode: 'A', pendingQty: '0', inboundQty: '200' }, { materialCode: 'B', pendingQty: '1', inboundQty: '0' },
  ])).toThrow(ReverseRuleViolation))
  it('rejects empty receipts', () => expect(() => check([])).toThrow(ReverseRuleViolation))
  it('rejects locked warehouse even with all units received', () => expect(() => check([
    { materialCode: 'A', pendingQty: '0', inboundQty: '20' },
  ], true)).toThrow(ReverseRuleViolation))
})
