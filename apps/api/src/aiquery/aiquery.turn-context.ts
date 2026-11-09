import type { AiQueryEnvelopeDto } from '@cadenza/contracts'

export type AiEnvelopeLike = AiQueryEnvelopeDto
export interface AiClarifyOptionLike {
  id: string
  label: string
  detail?: Record<string, unknown> | null
  confirm?: { capabilityId: string; params: Record<string, unknown> } | null
}
export interface AiTurnOwner {
  sessionId: string
  userId: string
  enterpriseId: string
  /** OA login session, in addition to the AI conversation session. */
  authSessionId?: string
}
type Option = { capabilityId: string; params: Record<string, unknown>; label: string }
interface TurnRecord { owner: AiTurnOwner; active: boolean; cancelled: boolean; envelopes: Map<number, AiEnvelopeLike>; options: Map<string, Option> }
const MAX_ENTRIES = 2000

export class AiTurnOwnershipError extends Error {
  constructor() { super('问数轮归属不匹配或已失效'); this.name = 'AiTurnOwnershipError' }
}

/** Process-local cache, never a source of permissions. Eviction removes the
 * entire record. Persistent tool ownership is checked against ai_query_audit.
 * Restarted unknown clarifications cannot be rebuilt from client options.
 */
export class AiTurnContext {
  private readonly turns = new Map<string, TurnRecord>()

  private sameOwner(actual: AiTurnOwner, expected: AiTurnOwner): boolean {
    return actual.sessionId === expected.sessionId && actual.userId === expected.userId && actual.enterpriseId === expected.enterpriseId &&
      (expected.authSessionId === undefined || actual.authSessionId === undefined || actual.authSessionId === expected.authSessionId)
  }
  private owned(requestId: string, owner: AiTurnOwner): TurnRecord {
    const turn = this.turns.get(requestId)
    if (turn === undefined || !this.sameOwner(turn.owner, owner)) throw new AiTurnOwnershipError()
    return turn
  }
  registerTurn(requestId: string, owner: AiTurnOwner): void {
    const prior = this.turns.get(requestId)
    if (prior !== undefined) {
      if (!this.sameOwner(prior.owner, owner)) throw new AiTurnOwnershipError()
      // Internal execute may precede first UI acceptance. Bind its login once.
      if (prior.owner.authSessionId === undefined && owner.authSessionId !== undefined) prior.owner.authSessionId = owner.authSessionId
      return
    }
    if (this.turns.size >= MAX_ENTRIES) {
      const expired = [...this.turns].find(([, turn]) => !turn.active)
      if (expired === undefined) throw new Error('问数轮上下文容量已满，请稍后重试')
      this.turns.delete(expired[0])
    }
    this.turns.set(requestId, { owner: { ...owner }, active: false, cancelled: false, envelopes: new Map(), options: new Map() })
  }
  begin(requestId: string, owner: AiTurnOwner, clarification: boolean): void {
    if (clarification) this.owned(requestId, owner)
    this.registerTurn(requestId, owner)
    const turn = this.owned(requestId, owner)
    if (turn.active || turn.cancelled) throw new AiTurnOwnershipError()
    if (!clarification) turn.options.clear()
    turn.active = true
  }
  finish(requestId: string, owner: AiTurnOwner): void { this.owned(requestId, owner).active = false }
  turnOf(requestId: string): AiTurnOwner | null { const turn = this.turns.get(requestId); return turn === undefined ? null : { ...turn.owner } }
  isCancelled(requestId: string, owner: AiTurnOwner): boolean { return this.owned(requestId, owner).cancelled }
  cancel(requestId: string, owner: AiTurnOwner): void {
    const turn = this.owned(requestId, owner); turn.cancelled = true; turn.options.clear(); turn.envelopes.clear()
  }
  registerEnvelope(requestId: string, toolCallSeq: number, envelope: AiEnvelopeLike): void {
    const echo = envelope.contextEcho
    if (envelope.auditRef.requestId !== requestId || envelope.auditRef.toolCallSeq !== toolCallSeq ||
        echo.requestId !== requestId || echo.toolCallSeq !== toolCallSeq || !Number.isSafeInteger(toolCallSeq) || toolCallSeq < 1) throw new AiTurnOwnershipError()
    const owner = { sessionId: echo.sessionId, userId: echo.userId, enterpriseId: echo.enterpriseId }
    this.registerTurn(requestId, owner)
    const turn = this.owned(requestId, owner)
    if (turn.cancelled) return
    if (turn.envelopes.size >= MAX_ENTRIES && !turn.envelopes.has(toolCallSeq)) turn.envelopes.delete(turn.envelopes.keys().next().value!)
    turn.envelopes.set(toolCallSeq, structuredClone(envelope))
  }
  envelopeOf(requestId: string, toolCallSeq: number, owner: AiTurnOwner): AiEnvelopeLike | null {
    const turn = this.owned(requestId, owner)
    const value = turn.cancelled ? undefined : turn.envelopes.get(toolCallSeq)
    return value === undefined ? null : structuredClone(value)
  }
  registerClarifyOptions(requestId: string, options: AiClarifyOptionLike[], owner: AiTurnOwner): void {
    const turn = this.owned(requestId, owner)
    if (turn.cancelled) return
    const entries = options.filter(o => o.confirm != null).slice(0, MAX_ENTRIES)
    turn.options = new Map(entries.map(o => [o.id, structuredClone({ ...o.confirm!, label: o.label })]))
  }
  consumeClarifyOption(requestId: string, optionId: string, owner: AiTurnOwner): Option | null {
    const turn = this.owned(requestId, owner)
    if (turn.cancelled) return null
    const option = turn.options.get(optionId) ?? null
    if (option !== null) turn.options.clear()
    return option === null ? null : structuredClone(option)
  }
}
