import type { CommandContext, CommandTools } from './command-bus'
import type { OrgNodeRecord, ScopeGrantRecord } from './repositories'

/** Repository-backed identity. Payload plantId is only a consistency assertion. */
export interface ObjectScope {
  enterpriseId: string
  plantId: string
}

type ScopeTools = Pick<CommandTools, 'org' | 'users' | 'grants'>
type Reject = (message: string) => Error

/**
 * Resolve the actual factory even for an enterprise-wide reader. Never combine
 * the permission from one grant with the data scope from a different grant.
 * Administrator role names and enterprise-wide read grants confer no write.
 */
export async function assertObjectWriteScope(
  tools: ScopeTools,
  ctx: CommandContext,
  target: ObjectScope,
  permission: string,
  reject: Reject,
  claimedPlantId?: string,
): Promise<void> {
  if (target.enterpriseId !== ctx.enterpriseId ||
      (claimedPlantId !== undefined && claimedPlantId !== target.plantId)) {
    throw reject('业务对象的真实企业/工厂与请求范围不一致')
  }
  const plant = await tools.org.findById(target.plantId)
  if (plant === null || plant.kind !== 'plant' || plant.status !== 'active' ||
      plant.enterpriseId !== ctx.enterpriseId) {
    throw reject('业务对象不属于本企业的真实活动工厂')
  }
  const actor = await tools.users.findById(ctx.actorUserId)
  if (actor === null || actor.enterpriseId !== ctx.enterpriseId ||
      actor.status !== 'active' || actor.accountStatus !== 'enabled') {
    throw reject('操作者不存在、已停用或不属于当前企业')
  }
  const grants = await tools.grants.listActiveByPrincipals([
    { principalType: 'role', principalId: actor.roleId },
    { principalType: 'user', principalId: actor.id },
  ])
  for (const grant of grants) {
    if (grant.status !== 'active' || grant.enterpriseId !== ctx.enterpriseId ||
        !grant.permissions.includes(permission) ||
        !(grant.principalType === 'user' && grant.principalId === actor.id ||
          grant.principalType === 'role' && grant.principalId === actor.roleId)) continue
    if (await grantCoversPlant(tools, grant, plant, ctx.enterpriseId)) return
  }
  throw reject(`缺少目标工厂的 ${permission} 写许可`)
}

async function grantCoversPlant(
  tools: ScopeTools,
  grant: ScopeGrantRecord,
  plant: OrgNodeRecord,
  enterpriseId: string,
): Promise<boolean> {
  let node = await tools.org.findById(grant.scopeObjectId)
  if (node === null || node.status !== 'active' || node.enterpriseId !== enterpriseId) return false
  if (grant.scopeType === 'enterprise') return node.kind === 'enterprise' && node.id === enterpriseId
  if (grant.scopeType === 'plant') return node.kind === 'plant' && node.id === plant.id
  if (grant.scopeType !== 'workshop' || node.kind !== 'work_center') return false
  // Preserve the existing OA-25 workshop-to-factory scope, using persisted
  // parent links; a malformed/cyclic/foreign hierarchy never grants access.
  const seen = new Set<string>()
  for (let hops = 0; node !== null && hops < 64; hops += 1) {
    if (seen.has(node.id) || node.status !== 'active' || node.enterpriseId !== enterpriseId) return false
    seen.add(node.id)
    if (node.kind === 'plant') return node.id === plant.id
    node = node.parentId === null ? null : await tools.org.findById(node.parentId)
  }
  return false
}
