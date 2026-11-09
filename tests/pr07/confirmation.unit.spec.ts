import { describe, expect, it } from 'vitest'
import { createDefaultHandler, createNoopChannel, outboxRequestDigest, stableStringify, type ExternalChannel, type OutboxTaskRow } from '../../apps/worker/src/handlers'
import { processBatch } from '../../apps/worker/src/outbox-claim'
import { conversionPushReceiptDigest, explicitOutcome } from '../../packages/application/src/conversion-handlers'
const row: OutboxTaskRow = { eventId: 'event', aggregateType: 'conversion_order', aggregateId: 'order', taskKind: 'form_conversion_push',
  payload: { nested: { z: 2, a: 1 }, list: [1,2] }, attemptCount: 0, plantId: 'plant-A' }
const scope = { plantIds: ['plant-A'] }
describe('PR07 explicit acknowledgement semantics (local channel doubles)', () => {
  it('canonical digest is valid sorted JSON and agrees across worker/application', () => {
    expect(JSON.parse(stableStringify({ z: { b: 2, a: 1 }, a: 0 }))).toEqual({ a: 0, z: { a: 1, b: 2 } })
    expect(outboxRequestDigest(row)).toBe(conversionPushReceiptDigest(row.aggregateType, row.aggregateId, row.payload))
    expect(outboxRequestDigest({ ...row, payload: { changed: true } })).not.toBe(outboxRequestDigest(row))
  })
  it('noop is NOOP_NEEDED and explicitly SITE_PENDING', async () => {
    expect(await createDefaultHandler(createNoopChannel(), scope)(row)).toMatchObject({ kind: 'NOOP_NEEDED', reason: expect.stringContaining('SITE_PENDING') })
  })
  it('a matching explicit acknowledgement may dispatch', async () => {
    const channel: ExternalChannel = { name: 'local-confirmation-fixture', deliver: async r => ({ outcome: 'confirmed', externalRef: 'fixture:confirmed', requestDigest: outboxRequestDigest(r) }) }
    expect(await createDefaultHandler(channel, scope)(row)).toMatchObject({ kind: 'DISPATCHED', externalRef: 'fixture:confirmed' })
  })
  for (const delivered of [{}, { outcome: 'unknown' }, { outcome: 'confirmed' }, { outcome: 'confirmed', externalRef: 'noop:fake', requestDigest: outboxRequestDigest(row) },
    { outcome: 'confirmed', externalRef: 'fixture', requestDigest: 'wrong' }]) {
    it(`does not confirm ${JSON.stringify(delivered)}`, async () => {
      const channel = { name: 'fixture', deliver: async () => delivered } as ExternalChannel
      expect((await createDefaultHandler(channel, scope)(row)).kind).toBe('EXTERNAL_UNKNOWN')
    })
  }
  it('delivery exception is unknown rather than a blind retry', async () => {
    const channel: ExternalChannel = { name: 'timeout-fixture', deliver: async () => { throw new Error('response lost') } }
    expect((await createDefaultHandler(channel, scope)(row)).kind).toBe('EXTERNAL_UNKNOWN')
  })
  it('foreign scope never calls the channel', async () => {
    let called = false
    const handler = createDefaultHandler({ name: 'fixture', deliver: async () => { called = true; return {} } }, { plantIds: ['plant-B'] })
    expect((await handler(row)).kind).toBe('SCOPE_SKIPPED'); expect(called).toBe(false)
  })
  it('empty worker scope fails before touching a pool', async () => {
    await expect(processBatch({ connect: () => { throw new Error('must not connect') } } as never,
      { limit: 1, registry: {} as never, scope: { plantIds: [] } })).rejects.toThrow('explicit nonempty')
  })
  for (const outcome of [undefined,null,'','SUCCESS',true,'other']) it(`rejects invalid conversion outcome ${String(outcome)}`, () => {
    expect(() => explicitOutcome({ outcome }, true)).toThrow('outcome')
  })
  it('external UNKNOWN is preserved, local UNKNOWN cannot mean success', () => {
    expect(explicitOutcome({ outcome: 'unknown' }, true)).toBe('unknown')
    expect(() => explicitOutcome({ outcome: 'unknown' }, false)).toThrow('outcome')
  })
  for (const outcome of ['success','failure'] as const) it(`accepts explicit ${outcome}`, () => {
    expect(explicitOutcome({ outcome }, false)).toBe(outcome); expect(explicitOutcome({ outcome }, true)).toBe(outcome)
  })
})
