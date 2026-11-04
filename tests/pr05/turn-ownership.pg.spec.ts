import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createScryptPasswordHasher, type AiSessionRecord } from '@cadenza/application'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { AI_QUERY_CAPABILITY_SEEDS } from '@cadenza/domain'
import { createPgAiQueryRepositories, seedAiQueryCapabilities } from '../../packages/persistence/src/aiquery-repositories'
import { buildAiQueryService } from '../../apps/api/src/aiquery/aiquery.composition'

const url = process.env['CADENZA_PR05_TEST_DB_URL']
if (!url || !/^cadenza_pr05_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) {
  throw new Error('NOT_RUN: CADENZA_PR05_TEST_DB_URL must name a NEW empty cadenza_pr05_* PostgreSQL database')
}
const pool = createPool(url, { max: 8 }); const service = buildAiQueryService(pool)
const repos = createPgAiQueryRepositories(pool)
const permissions = ['aiquery.use','process.read','execution.read','scheduling.read','inventory.read','purchase.read','quality.read']
interface User { id: string; enterprise_id: string; plant_id: string; grant_id: string }
let one: User; let two: User; let otherEnterprise: User
const params = () => ({ orderRef: { kind: 'orderNo', value: 'PR05-no-private-order' } })
async function session(user = one) { return service.openSession({ userId: user.id, enterpriseId: user.enterprise_id, channel: 'web' }) }
const owner = (s: AiSessionRecord) => ({ sessionId: s.id, userId: s.userId, enterpriseId: s.enterpriseId })
const query = (s: AiSessionRecord, requestId = randomUUID(), toolCallSeq = 1) => ({ requestId, toolCallSeq, sessionId: s.id, capabilityId: 'aq.order-progress', capabilityVersion: 1, params: params() })
async function audit(requestId: string) { return (await pool.query('SELECT * FROM ai_query_audit WHERE request_id=$1 ORDER BY tool_call_seq', [requestId])).rows }
async function deniedUnchanged(input: ReturnType<typeof query>) {
  const before = await audit(input.requestId)
  await expect(service.execute(input)).rejects.toMatchObject({ name: 'AiTurnOwnershipError' })
  expect(await audit(input.requestId)).toEqual(before)
  console.log('PR05_QUERY', JSON.stringify({ requestId: input.requestId, attemptedSession: input.sessionId, priorOwner: before.map(r => ({ sessionId: r.session_id, enterpriseId: r.enterprise_id, userId: r.user_id, seq: r.tool_call_seq })), auditUnchanged: true }))
}
beforeAll(async () => {
  if ((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rowCount !== 0) throw new Error('Refusing nonempty PR05 database')
  await migrateUp(pool, migrations); await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  const users = (await pool.query<User & { login_name: string }>("SELECT id,enterprise_id,plant_id,login_name FROM user_account WHERE login_name IN ('szqc01','szws01','gzadmin01')")).rows
  for (const user of users) {
    user.grant_id = (await pool.query<{ id: string }>(`INSERT INTO scope_grant(enterprise_id,principal_type,principal_id,permissions,scope_type,scope_object_id,status,created_by)
      VALUES ($1,'user',$2,$3,'plant',$4,'active','pr05-fixture') RETURNING id`, [user.enterprise_id, user.id, permissions, user.plant_id])).rows[0]!.id
    await seedAiQueryCapabilities(pool, user.enterprise_id, AI_QUERY_CAPABILITY_SEEDS, 'pr05-fixture')
  }
  one = users.find(u => u.login_name === 'szqc01')!; two = users.find(u => u.login_name === 'szws01')!; otherEnterprise = users.find(u => u.login_name === 'gzadmin01')!
})
afterAll(async () => { await pool.end() })

describe('PR05 persistent owner, replay and access revocation on real PostgreSQL', () => {
  for (const collision of ['same-user-session','other-user','other-enterprise'] as const) {
    it(`rejects ${collision} request reuse at the same and a new tool sequence`, async () => {
      const first = await session(); const input = query(first); const result = await service.execute(input)
      expect(result.status).toBe('ok_no_records')
      const intruder = await session(collision === 'same-user-session' ? one : collision === 'other-user' ? two : otherEnterprise)
      await deniedUnchanged(query(intruder, input.requestId, 1)); await deniedUnchanged(query(intruder, input.requestId, 2))
      expect((await service.recheckTurnAccess(owner(intruder), input.requestId)).allowed).toBe(false)
      expect((await service.recheckTurnAccess(owner(first), input.requestId)).allowed).toBe(true)
    })
  }
  it('same owner and same query replay without a duplicate audit', async () => {
    const s = await session(); const input = query(s); const first = await service.execute(input); const before = await audit(input.requestId)
    const replay = await service.execute({ ...input, params: { orderRef: { value: 'PR05-no-private-order', kind: 'orderNo' } } })
    expect(replay.status).toBe(first.status); expect(replay.auditRef).toEqual(first.auditRef); expect(await audit(input.requestId)).toEqual(before)
    expect(replay.contextEcho.notes.some(note => note.includes('幂等重放'))).toBe(true)
  })
  for (const changed of ['params','capability','version'] as const) it(`cannot reuse an audit sequence with different ${changed}`, async () => {
    const s = await session(); const input = query(s); await service.execute(input)
    const changedInput = changed === 'params' ? { ...input, params: { orderRef: { kind: 'orderNo', value: 'OTHER-ORDER' } } }
      : changed === 'capability' ? { ...input, capabilityId: 'aq.quality' } : { ...input, capabilityVersion: 2 }
    await deniedUnchanged(changedInput)
  })
  it('same-owner clarification continues at the next audited sequence', async () => {
    const s = await session(); const input = query(s); await service.execute(input)
    const next = await service.execute({ ...input, toolCallSeq: await service.maxToolCallSeq(input.requestId) + 1,
      params: { orderRef: { kind: 'orderNo', value: 'PR05-confirmed-order' } } })
    expect(next.auditRef.toolCallSeq).toBe(2); expect((await audit(input.requestId)).map(r => r.tool_call_seq)).toEqual([1, 2])
  })
  it('permission revocation suppresses cached delivery and makes exact replay no_permission', async () => {
    const s = await session(); const input = query(s); await service.execute(input); const before = await audit(input.requestId)
    await pool.query('UPDATE scope_grant SET permissions=$2 WHERE id=$1', [one.grant_id, ['aiquery.use']])
    try {
      expect((await service.recheckTurnAccess(owner(s), input.requestId)).allowed).toBe(false)
      const result = await service.execute(input); expect(result.status).toBe('no_permission'); expect(result.data).toBeNull()
      expect(await audit(input.requestId)).toEqual(before)
    } finally { await pool.query('UPDATE scope_grant SET permissions=$2 WHERE id=$1', [one.grant_id, permissions]) }
  })
  it('zero-tool turn still requires current module permission', async () => {
    const s = await session(); const requestId = randomUUID()
    await pool.query('UPDATE scope_grant SET permissions=$2 WHERE id=$1', [one.grant_id, ['process.read']])
    try { expect((await service.recheckTurnAccess(owner(s), requestId)).allowed).toBe(false); expect(await audit(requestId)).toHaveLength(0) }
    finally { await pool.query('UPDATE scope_grant SET permissions=$2 WHERE id=$1', [one.grant_id, permissions]) }
  })
  it('closed AI session suppresses cached result delivery', async () => {
    const s = await session(); const input = query(s); await service.execute(input)
    await pool.query("UPDATE ai_session SET status='closed',closed_at=clock_timestamp() WHERE id=$1", [s.id])
    expect((await service.recheckTurnAccess(owner(s), input.requestId)).allowed).toBe(false)
  })
  it('a persisted session with a mismatched user enterprise cannot authorize execution', async () => {
    // Explicit malformed association fixture; no credentials or user role changes.
    const s = await service.openSession({ userId: one.id, enterpriseId: otherEnterprise.enterprise_id, channel: 'web' })
    const result = await service.execute(query(s)); expect(result.status).toBe('no_permission'); expect(result.data).toBeNull()
  })
  it('concurrent first audits at different sequences establish exactly one owner', async () => {
    const a = await session(); const b = await session(two); const requestId = randomUUID()
    const make = (s: AiSessionRecord, toolCallSeq: number) => ({ requestId, toolCallSeq, sessionId: s.id, userId: s.userId, enterpriseId: s.enterpriseId,
      channel: s.channel, capabilityId: 'aq.order-progress', capabilityVersion: 1, params: { queryFingerprint: 'fixture-identity' }, resultStatus: 'ok_no_records' as const })
    const results = await Promise.allSettled([repos.audit.insert(make(a, 1)), repos.audit.insert(make(b, 2))])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    const rows = await audit(requestId); expect(rows).toHaveLength(1)
    console.log('PR05_CONCURRENCY', JSON.stringify({ requestId, owner: rows[0]!.session_id, fulfilled: 1, rejected: 1, auditCount: 1 }))
  })
  it('concurrent exact first-audit retries keep a single original record', async () => {
    const s = await session(); const input = query(s)
    const results = await Promise.all([service.execute(input), buildAiQueryService(pool).execute(input)])
    expect(results.every(r => r.status === 'ok_no_records')).toBe(true); expect(await audit(input.requestId)).toHaveLength(1)
  })
})
