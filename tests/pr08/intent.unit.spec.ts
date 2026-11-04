import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../packages/ui/src/api/client'
const body = { orderId: 'real-order-2', orderOperationId: 'operation-2', feeds: [{ barcodeValue: 'AE00000001', quantity: '4.0000' }] }
let cells: Map<string, string>, posts: Array<{ id: string; body: unknown }>, user: string, enterprise: string, token: string
let outcome: 'ok' | 'lost' | 'invalid' | '400' | '403' | '500'
function client() { return createApiClient({ getToken: () => token, intentStorage: { getItem: k => cells.get(k) ?? null, setItem: (k, v) => { cells.set(k, v) }, removeItem: k => { cells.delete(k) } } }) }
beforeEach(() => {
  cells = new Map(); posts = []; user = 'u1'; enterprise = 'e1'; token = 'first-token'; outcome = 'ok'
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
    if (url.pathname === '/auth/me') return new Response(JSON.stringify({ user: { userId: user, enterpriseId: enterprise } }))
    const id = (init.headers as Record<string, string>)['x-operation-id']!
    posts.push({ id, body: JSON.parse(init.body as string) })
    if (outcome === 'lost') throw new Error('response lost (transport double only)')
    if (outcome === 'invalid') return new Response('partial json')
    if (outcome !== 'ok') return new Response(JSON.stringify({ code: 'ERR_FIXTURE', message: 'fixture refusal' }), { status: Number(outcome) })
    return new Response(JSON.stringify({ operationId: id, status: 'COMMITTED', data: { count: 1 } }))
  }))
})
afterEach(() => { vi.unstubAllGlobals() })
describe('PR08 durable command intents (transport doubles, not database proof)', () => {
  it.each(['feed', 'putaway'] as const)('%s lost response / reload retries exact key and body', async kind => {
    outcome = 'lost'; await expect(client().executeCommandIntent('pda.task', kind, body)).rejects.toThrow()
    const saved = await client().readCommandIntent('pda.task'); expect(saved?.state).toBe('unknown')
    outcome = 'ok'; await client().executeCommandIntent('pda.task', kind, saved!.payload)
    expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0])
  })
  it('concurrent taps share one successful POST', async () => {
    await Promise.all([client().executeCommandIntent('web.feed', 'feed', body), client().executeCommandIntent('web.feed', 'feed', body)])
    expect(posts).toHaveLength(1)
  })
  it('payload cannot be replaced after an unknown result', async () => {
    outcome = 'lost'; await expect(client().executeCommandIntent('web.feed', 'feed', body)).rejects.toThrow()
    await expect(client().executeCommandIntent('web.feed', 'feed', { ...body, orderId: 'another' })).rejects.toMatchObject({ code: 'ERR_INTENT_PENDING' })
    expect(posts).toHaveLength(1)
  })
  it('navigation cannot erase an unresolved intent', async () => {
    outcome = 'lost'; const c = client(); await expect(c.executeCommandIntent('web.feed', 'feed', body)).rejects.toThrow()
    await expect(c.clearSettledCommandIntent('web.feed', (await c.readCommandIntent('web.feed'))!.operationId)).rejects.toMatchObject({ code: 'ERR_INTENT_PENDING' })
  })
  it.each(['invalid', '500'] as const)('%s remains UNKNOWN', async result => {
    outcome = result; await expect(client().executeCommandIntent('pda.feed', 'feed', body)).rejects.toThrow()
    expect((await client().readCommandIntent('pda.feed'))?.state).toBe('unknown')
  })
  it('a later 403 does not disprove a previous possible commit', async () => {
    outcome = 'lost'; await expect(client().executeCommandIntent('pda.feed', 'feed', body)).rejects.toThrow()
    outcome = '403'; await expect(client().executeCommandIntent('pda.feed', 'feed', body)).rejects.toThrow()
    expect((await client().readCommandIntent('pda.feed'))?.state).toBe('unknown'); expect(posts[1]!.id).toBe(posts[0]!.id)
  })
  it('first explicit rejection requires an explicit new-intent acknowledgement', async () => {
    outcome = '400'; const c = client(); await expect(c.executeCommandIntent('pda.feed', 'feed', body)).rejects.toThrow()
    const saved = (await c.readCommandIntent('pda.feed'))!; expect(saved.state).toBe('rejected')
    outcome = 'ok'; await expect(c.executeCommandIntent('pda.feed', 'feed', body)).rejects.toMatchObject({ code: 'ERR_INTENT_REJECTED' })
    await c.clearSettledCommandIntent('pda.feed', saved.operationId); await c.executeCommandIntent('pda.feed', 'feed', body)
    expect(posts[1]!.id).not.toBe(posts[0]!.id)
  })
  it('confirmed intent replays receipt until explicit new work', async () => {
    const c = client(); const first = await c.executeCommandIntent('pda.feed', 'feed', body)
    expect(await client().executeCommandIntent('pda.feed', 'feed', body)).toEqual(first); expect(posts).toHaveLength(1)
    await c.clearSettledCommandIntent('pda.feed', first.operationId)
    await c.executeCommandIntent('pda.feed', 'feed', { ...body, orderId: 'other-real-order' })
    expect(posts[1]!.id).not.toBe(first.operationId)
  })
  it('same user after token renewal recovers unresolved intent', async () => {
    outcome = 'lost'; await expect(client().executeCommandIntent('pda.feed', 'feed', body)).rejects.toThrow()
    token = 'renewed-token'; expect((await client().readCommandIntent('pda.feed'))?.state).toBe('unknown')
    expect([...cells.keys(), ...cells.values()].join('')).not.toContain('token')
  })
  it('different user and enterprise cannot inherit the previous operation', async () => {
    await client().executeCommandIntent('pda.feed', 'feed', body)
    user = 'u2'; expect(await client().readCommandIntent('pda.feed')).toBeNull()
    user = 'u1'; enterprise = 'e2'; expect(await client().readCommandIntent('pda.feed')).toBeNull()
  })
  it('storage failure blocks the POST', async () => {
    const c = createApiClient({ intentStorage: { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} } })
    await expect(c.executeCommandIntent('pda.feed', 'feed', body)).rejects.toThrow('quota'); expect(posts).toHaveLength(0)
  })
  it('corrupt prior record blocks replacement', async () => {
    await client().executeCommandIntent('pda.feed', 'feed', body)
    cells.set([...cells.keys()][0]!, '{broken')
    await expect(client().executeCommandIntent('pda.feed', 'feed', body)).rejects.toMatchObject({ code: 'ERR_INTENT_STORAGE' }); expect(posts).toHaveLength(1)
  })
  it('clones input synchronously before authentication or transmission', async () => {
    const mutable = structuredClone(body); const result = client().executeCommandIntent('pda.feed', 'feed', mutable)
    mutable.feeds[0]!.quantity = '999.0000'; await result; expect(posts[0]!.body).toEqual(body)
  })
})
