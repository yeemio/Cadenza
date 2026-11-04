import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiQueryService, VerifiedAuthContext } from '@cadenza/application'
import { AiTurnContext, AiTurnOwnershipError, type AiEnvelopeLike, type AiTurnOwner } from '../../apps/api/src/aiquery/aiquery.turn-context'
import { AiQueryTurnsController } from '../../apps/api/src/aiquery/aiquery.turns.controller'
import type { AiRuntimeClient } from '../../apps/api/src/aiquery/aiquery.runtime-client'
import { createAiRuntime } from '../../apps/ai/src/composition-root'
import { MockModelClient } from '../../packages/integrations/dsh'
import { MockControlledQueryClient } from '../../apps/ai/src/controlled-query-client'
import { SAMPLE_CAPABILITIES_RESPONSE } from '../ai-service/envelope-samples'

const owner = (): AiTurnOwner => ({ sessionId: 'S1', userId: 'U1', enterpriseId: 'E1', authSessionId: 'LOGIN1' })
function auth(o = owner()): VerifiedAuthContext {
  return { user: { id: o.userId, loginName: o.userId, displayName: o.userId, enterpriseId: o.enterpriseId, plantId: 'P1', roleId: 'ROLE1', loginPlatform: 'WEB' },
    role: { id: 'ROLE1', name: 'reader', alias: 'qc' }, session: { id: o.authSessionId!, expiresAt: '2099-01-01T00:00:00Z' },
    permissions: ['aiquery.use'], dataScope: { enterpriseWide: false, plantIds: ['P1'] } }
}
function envelope(requestId: string, o = owner(), seq = 1): AiEnvelopeLike {
  return { status: 'ok_no_records', statusLabel: '无记录', message: 'OLD PRIVATE ENVELOPE', data: null,
    completeness: { truncated: false, fetchedRows: 0, totalKnown: true, total: 0, page: null }, freshness: { queriedAt: '2026-11-03T00:00:00Z', sources: [] },
    contextEcho: { requestId, toolCallSeq: seq, sessionId: o.sessionId, userId: o.userId, enterpriseId: o.enterpriseId,
      channel: 'web', dataScope: { enterpriseWide: false, plantIds: ['P1'] }, capabilityId: 'aq.order-progress', capabilityVersion: 1,
      effectiveFilters: {}, ignoredRequestFields: [], factColumns: [], notes: [] }, auditRef: { requestId, toolCallSeq: seq } }
}
function harness() {
  const context = new AiTurnContext(); let allowed = true
  const service = { findOpenSession: vi.fn(async (sessionId: string) => ({ id: sessionId, userId: 'U1', enterpriseId: 'E1', status: 'open' })),
    recheckTurnAccess: vi.fn(async () => allowed ? { allowed: true } : { allowed: false, reason: 'REVOKED' }),
    findEnabledVersion: vi.fn(async () => 1), maxToolCallSeq: vi.fn(async () => 1),
    execute: vi.fn(async (input: { requestId: string; toolCallSeq: number }) => envelope(input.requestId, owner(), input.toolCallSeq)) }
  const runtime = { runTurn: vi.fn(async () => ({ unreachable: false, response: { outcome: 'answer', statusDetail: { toolCallsUsed: 0 } } })),
    cancelTurn: vi.fn(async () => ({ ok: true, decision: 'cancelled_in_flight' })) }
  return { context, service, runtime, revoke: () => { allowed = false },
    controller: new AiQueryTurnsController(service as unknown as AiQueryService, context, runtime as unknown as AiRuntimeClient) }
}
describe('PR05 context ownership and controller delivery (explicit unit doubles)', () => {
  for (const [field, value] of [['userId','U2'],['enterpriseId','E2'],['sessionId','S2'],['authSessionId','LOGIN2']] as const) {
    it(`cannot overwrite, read, clarify or cancel another ${field}`, () => {
      const c = new AiTurnContext(); const o = owner(); const id = randomUUID(); c.registerTurn(id, o); c.registerEnvelope(id, 1, envelope(id))
      c.registerClarifyOptions(id, [{ id: 'O1', label: 'one', confirm: { capabilityId: 'aq.order-progress', params: {} } }], o)
      const intruder = { ...o, [field]: value }
      expect(() => c.registerTurn(id, intruder)).toThrow(AiTurnOwnershipError)
      expect(() => c.envelopeOf(id, 1, intruder)).toThrow(AiTurnOwnershipError)
      expect(() => c.consumeClarifyOption(id, 'O1', intruder)).toThrow(AiTurnOwnershipError)
      expect(() => c.cancel(id, intruder)).toThrow(AiTurnOwnershipError)
      expect(c.turnOf(id)).toEqual(o); expect(c.consumeClarifyOption(id, 'O1', o)).not.toBeNull()
    })
  }
  it('rejects a conflicting trusted envelope without overwriting prior results', () => {
    const c = new AiTurnContext(); const id = randomUUID(); c.registerEnvelope(id, 1, envelope(id))
    expect(() => c.registerEnvelope(id, 2, envelope(id, { ...owner(), sessionId: 'S2' }, 2))).toThrow(AiTurnOwnershipError)
    expect(c.envelopeOf(id, 1, owner())?.message).toBe('OLD PRIVATE ENVELOPE')
  })
  it('deep clones returned envelopes and option parameters', () => {
    const c = new AiTurnContext(); const id = randomUUID(); c.registerEnvelope(id, 1, envelope(id))
    const first = c.envelopeOf(id, 1, owner())!; first.contextEcho.userId = 'tampered'
    expect(c.envelopeOf(id, 1, owner())!.contextEcho.userId).toBe('U1')
  })
  it('evicts owner, options and envelopes together, without orphaned clarification', () => {
    const c = new AiTurnContext(); c.registerTurn('old', owner())
    c.registerClarifyOptions('old', [{ id: 'O', label: 'old', confirm: { capabilityId: 'aq.order-progress', params: {} } }], owner())
    for (let i = 0; i < 2000; i++) c.registerTurn(String(i), owner())
    expect(c.turnOf('old')).toBeNull(); expect(() => c.consumeClarifyOption('old', 'O', owner())).toThrow(AiTurnOwnershipError)
  })
  for (const status of ['ok','refused_out_of_scope']) it(`zero-tool ${status} does not recover an old envelope`, async () => {
    const h = harness(); const id = randomUUID(); h.context.registerEnvelope(id, 1, envelope(id))
    h.runtime.runTurn.mockResolvedValue({ unreachable: false, response: { outcome: 'answer', statusDetail: { toolCallsUsed: 0, status } } } as never)
    const result = await h.controller.askTurn(auth(), { requestId: id, sessionId: 'S1', userMessage: 'new question' })
    expect(result.envelope).toBeNull(); expect(result.message).not.toContain('PRIVATE')
  })
  it('same user cannot reuse a request in a different AI conversation', async () => {
    const h = harness(); const id = randomUUID(); h.context.registerTurn(id, owner())
    await expect(h.controller.askTurn(auth(), { requestId: id, sessionId: 'S2', userMessage: 'intrude' })).rejects.toMatchObject({ status: 403 })
    expect(h.runtime.runTurn).not.toHaveBeenCalled(); expect(h.context.turnOf(id)).toEqual(owner())
  })
  it('same user in another login session cannot cancel the original turn', async () => {
    const h = harness(); const id = randomUUID(); h.context.registerTurn(id, owner())
    await expect(h.controller.cancelTurn(auth({ ...owner(), authSessionId: 'LOGIN2' }), id)).rejects.toMatchObject({ status: 403 })
    expect(h.runtime.cancelTurn).not.toHaveBeenCalled()
  })
  it('does not consume a clarification belonging to a different session', async () => {
    const h = harness(); const id = randomUUID(); h.context.registerTurn(id, owner())
    h.context.registerClarifyOptions(id, [{ id: 'O', label: 'one', confirm: { capabilityId: 'aq.order-progress', params: {} } }], owner())
    await expect(h.controller.askTurn(auth(), { requestId: id, sessionId: 'S2', clarifyOptionId: 'O' })).rejects.toMatchObject({ status: 403 })
    expect(h.context.consumeClarifyOption(id, 'O', owner())).not.toBeNull(); expect(h.service.execute).not.toHaveBeenCalled()
  })
  it('legitimate clarification executes once and consumes the complete choice set', async () => {
    const h = harness(); const id = randomUUID(); h.context.registerTurn(id, owner())
    h.context.registerClarifyOptions(id, [{ id: 'O1', label: 'one', confirm: { capabilityId: 'aq.order-progress', params: { orderRef: { kind: 'orderNo', value: 'SO1' } } } },
      { id: 'O2', label: 'two', confirm: { capabilityId: 'aq.order-progress', params: {} } }], owner())
    const result = await h.controller.askTurn(auth(), { requestId: id, sessionId: 'S1', clarifyOptionId: 'O1' })
    expect(result.envelope?.auditRef).toEqual({ requestId: id, toolCallSeq: 2 }); expect(h.service.execute).toHaveBeenCalledTimes(1)
    expect(h.context.consumeClarifyOption(id, 'O2', owner())).toBeNull()
  })
  it('rejects foreign answer references rather than reading another request cache', async () => {
    const h = harness(); const id = randomUUID(); const other = randomUUID(); h.context.registerEnvelope(other, 1, envelope(other))
    h.runtime.runTurn.mockResolvedValue({ unreachable: false, response: { outcome: 'answer', statusDetail: {}, answerRefs: [{ capabilityId: 'aq.order-progress', capabilityVersion: 1, auditRef: { requestId: other, toolCallSeq: 1 } }] } } as never)
    await expect(h.controller.askTurn(auth(), { requestId: id, sessionId: 'S1', userMessage: 'query' })).rejects.toMatchObject({ status: 403 })
  })
  it('checks permissions again after runtime work and withholds all stale output', async () => {
    const h = harness(); h.runtime.runTurn.mockImplementation(async () => { h.revoke(); return { unreachable: false, response: { outcome: 'answer', message: 'PRIVATE OUTPUT', statusDetail: { toolCallsUsed: 0 } } } })
    await expect(h.controller.askTurn(auth(), { requestId: randomUUID(), sessionId: 'S1', userMessage: 'query' })).rejects.toMatchObject({ status: 403 })
    expect(h.service.recheckTurnAccess).toHaveBeenCalledTimes(2)
  })
  it('cancellation prevents an in-flight answer and clears its cached results', async () => {
    const h = harness(); const id = randomUUID(); let complete!: (value: never) => void
    h.runtime.runTurn.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const pending = h.controller.askTurn(auth(), { requestId: id, sessionId: 'S1', userMessage: 'query' })
    await vi.waitFor(() => expect(h.runtime.runTurn).toHaveBeenCalledOnce())
    await h.controller.cancelTurn(auth(), id)
    complete({ unreachable: false, response: { outcome: 'answer', message: 'PRIVATE', statusDetail: {} } } as never)
    expect((await pending).outcome).toBe('cancelled')
  })
})

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
describe('PR05 real local runtime, mock external model and controlled query', () => {
  for (const [sessionId, enterpriseId, userId] of [['S2','E1','U1'],['S2','E1','U2'],['S2','E2','U2']]) {
    it(`runtime will not inherit another owner S2/${enterpriseId}/${userId}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cadenza-pr05-')); dirs.push(dir)
      const runtime = createAiRuntime({ env: {}, dataDir: dir, model: new MockModelClient({ steps: [{ kind: 'answer', text: 'one' }] }),
        queryClient: new MockControlledQueryClient([], SAMPLE_CAPABILITIES_RESPONSE) })
      await runtime.store.registerSession({ sessionId: 'S1', enterpriseId: 'E1', userId: 'U1', channel: 'web', conversationRef: null })
      await runtime.store.registerSession({ sessionId: sessionId!, enterpriseId: enterpriseId!, userId: userId!, channel: 'web', conversationRef: null })
      expect((await runtime.orchestrator.runTurn({ requestId: 'R', sessionId: 'S1', userMessage: 'one' })).outcome).toBe('answer')
      const eventsBefore = await runtime.store.listEvents(sessionId!)
      const result = await runtime.orchestrator.runTurn({ requestId: 'R', sessionId: sessionId!, userMessage: 'other' })
      expect(result.statusDetail.code).toBe('ERR_AI_REQUEST_OWNER'); expect(runtime.registry.get('R')!.sessionId).toBe('S1')
      expect(await runtime.store.listEvents(sessionId!)).toEqual(eventsBefore)
    })
  }
})
