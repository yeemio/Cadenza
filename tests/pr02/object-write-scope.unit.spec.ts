import { describe, expect, it } from 'vitest'
import { assertObjectWriteScope } from '../../packages/application/src/object-scope-repositories'
import type { CommandContext, CommandTools } from '../../packages/application/src/command-bus'
import type { OrgNodeRecord, ScopeGrantRecord, UserAccountRecord } from '../../packages/application/src/repositories'

// Repository doubles: these prove the authorization decision only, not PG
// rollback, endpoint wiring, or business behavior. Those have a separate suite.
const context: CommandContext = { actorUserId: 'actor', actorLoginName: 'operator', enterpriseId: 'enterprise-a' }
const reject = (message: string) => new Error(`FORBIDDEN_SCOPE: ${message}`)
function fixture() {
  const nodes = new Map<string, OrgNodeRecord>([
    ['enterprise-a', { id: 'enterprise-a', kind: 'enterprise', enterpriseId: 'enterprise-a', status: 'active', parentId: null } as OrgNodeRecord],
    ['plant-a', { id: 'plant-a', kind: 'plant', enterpriseId: 'enterprise-a', status: 'active', parentId: 'enterprise-a' } as OrgNodeRecord],
    ['plant-b', { id: 'plant-b', kind: 'plant', enterpriseId: 'enterprise-a', status: 'active', parentId: 'enterprise-a' } as OrgNodeRecord],
    ['plant-c', { id: 'plant-c', kind: 'plant', enterpriseId: 'enterprise-c', status: 'active', parentId: 'enterprise-c' } as OrgNodeRecord],
    ['workshop', { id: 'workshop', kind: 'work_center', enterpriseId: 'enterprise-a', status: 'active', parentId: 'plant-a' } as OrgNodeRecord],
  ])
  const actor = { id: 'actor', enterpriseId: 'enterprise-a', roleId: 'role', status: 'active', accountStatus: 'enabled' } as UserAccountRecord
  const grants: ScopeGrantRecord[] = []
  const tools = {
    org: { findById: async (id: string) => nodes.get(id) ?? null },
    users: { findById: async (id: string) => id === actor.id ? actor : null },
    grants: { listActiveByPrincipals: async () => grants },
  } as unknown as CommandTools
  function grant(scopeObjectId: string, permissions = ['inventory.post'], scopeType: ScopeGrantRecord['scopeType'] = 'plant') {
    const row = { enterpriseId: 'enterprise-a', principalType: 'user', principalId: 'actor', status: 'active',
      scopeObjectId, scopeType, permissions } as ScopeGrantRecord
    grants.push(row)
    return row
  }
  const check = (plantId = 'plant-a', enterpriseId = 'enterprise-a', claimedPlantId?: string) =>
    assertObjectWriteScope(tools, context, { plantId, enterpriseId }, 'inventory.post', reject, claimedPlantId)
  return { nodes, actor, grants, tools, grant, check }
}

describe('PR02 repository-backed permission and actual object scope (unit evidence only)', () => {
  it('allows the explicit local write grant', async () => {
    const f = fixture(); f.grant('plant-a'); await expect(f.check()).resolves.toBeUndefined()
  })
  it('rejects another factory in the same enterprise', async () => {
    const f = fixture(); f.grant('plant-a'); await expect(f.check('plant-b')).rejects.toThrow('FORBIDDEN_SCOPE')
  })
  it('does not turn group read into a write grant', async () => {
    const f = fixture(); f.grant('enterprise-a', ['group.read', 'inventory.read'], 'enterprise')
    await expect(f.check()).rejects.toThrow('FORBIDDEN_SCOPE')
  })
  it('does not combine enterprise read scope with a local write permission', async () => {
    const f = fixture(); f.grant('enterprise-a', ['inventory.read'], 'enterprise'); f.grant('plant-a')
    await expect(f.check('plant-a')).resolves.toBeUndefined()
    await expect(f.check('plant-b')).rejects.toThrow('FORBIDDEN_SCOPE')
  })
  it('keeps an existing explicit enterprise write grant inside its enterprise', async () => {
    const f = fixture(); f.grant('enterprise-a', ['inventory.post'], 'enterprise')
    await expect(f.check('plant-b')).resolves.toBeUndefined()
    await expect(f.check('plant-c', 'enterprise-c')).rejects.toThrow('FORBIDDEN_SCOPE')
  })
  it('does not trust a forged factory field on the object', async () => {
    const f = fixture(); f.grant('plant-c')
    await expect(f.check('plant-c', 'enterprise-a')).rejects.toThrow('FORBIDDEN_SCOPE')
  })
  it('rejects a payload factory that disagrees with the actual object', async () => {
    const f = fixture(); f.grant('plant-a'); f.grant('plant-b')
    await expect(f.check('plant-b', 'enterprise-a', 'plant-a')).rejects.toThrow('FORBIDDEN_SCOPE')
  })
  it('rejects disabled actors even if grants remain', async () => {
    const f = fixture(); f.grant('plant-a'); f.actor.accountStatus = 'disabled'
    await expect(f.check()).rejects.toThrow('FORBIDDEN_SCOPE')
  })
  it('rejects an actor from a different enterprise', async () => {
    const f = fixture(); f.grant('plant-a'); f.actor.enterpriseId = 'enterprise-c'
    await expect(f.check()).rejects.toThrow('FORBIDDEN_SCOPE')
  })
  it('rejects a retired factory', async () => {
    const f = fixture(); f.grant('plant-a'); f.nodes.get('plant-a')!.status = 'retired'
    await expect(f.check()).rejects.toThrow('FORBIDDEN_SCOPE')
  })
  it.each(['foreign-enterprise', 'foreign-principal', 'retired'] as const)('ignores a %s grant', async (kind) => {
    const f = fixture(); const grant = f.grant('plant-a')
    if (kind === 'foreign-enterprise') grant.enterpriseId = 'enterprise-c'
    if (kind === 'foreign-principal') grant.principalId = 'someone-else'
    if (kind === 'retired') grant.status = 'retired'
    await expect(f.check()).rejects.toThrow('FORBIDDEN_SCOPE')
  })
  it('preserves the documented workshop-to-factory permission scope', async () => {
    const f = fixture(); f.grant('workshop', ['inventory.post'], 'workshop')
    await expect(f.check('plant-a')).resolves.toBeUndefined()
    await expect(f.check('plant-b')).rejects.toThrow('FORBIDDEN_SCOPE')
  })
  it('fails closed on cyclic workshop ancestry', async () => {
    const f = fixture(); f.grant('workshop', ['inventory.post'], 'workshop'); f.nodes.get('workshop')!.parentId = 'workshop'
    await expect(f.check()).rejects.toThrow('FORBIDDEN_SCOPE')
  })
  it('does not retain write access after grant revocation', async () => {
    const f = fixture(); f.grant('plant-a'); await f.check(); f.grants.splice(0)
    await expect(f.check()).rejects.toThrow('FORBIDDEN_SCOPE')
  })
})
