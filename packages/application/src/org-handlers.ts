import { randomUUID } from 'node:crypto'
import { ERROR_CODES } from '@cadenza/contracts'
import {
  assertCanAdministerAdminRole,
  assertCompliantPassword,
  assertLoginNameValid,
  assertNotSelfDelete,
  assertOrgNodeDeletable,
  assertOrgNodeFields,
  assertReasonPresentForHighImpact,
  assertRoleDeletable,
  assertBuiltinRoleMutable,
  assertUserRequiredFields,
  assertValidParent,
  assertWorkshopDeptWhenRequired,
  computeNodeDepth,
  computeNodePath,
  computeDataScope,
  findRoleUniquenessConflict,
  isPlantInScope,
  LOGIN_PLATFORMS,
  OrgRuleViolation,
  resolveInitPassword,
  SCOPE_OBJECT_KIND,
  SCOPE_TYPES,
  unionPermissions,
  type OrgNodeKind,
} from '@cadenza/domain'
import type { CommandContext, CommandHandler, CommandTools, HandlerOutcome } from './command-bus'
import type { OrgNodeRecord, UserAccountRecord } from './repositories'
import type { PasswordHasher } from './password'

/**
 * org 域命令处理器（全部在命令总线事务内运行）：
 * 机构/用户/角色/授权的写路径，逐条落实 OA 规则（编号见各处注释）。
 * 一切写路径服务端核权（OA-26）：许可由 HTTP 守卫首检，此处再做数据范围二道防线。
 */

export interface OrgHandlerDeps {
  hasher: PasswordHasher
  /** OA-15 系统参数 account.initPassword（未配置时兜底 '123456'） */
  initPassword?: string | null
}

type Payload = Record<string, unknown>

function bad(message: string, errorCode: string = ERROR_CODES.BUSINESS_RULE): HandlerOutcome {
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: message }
}

function violationOutcome(error: OrgRuleViolation): HandlerOutcome {
  // OA-24 越范围为 FORBIDDEN_SCOPE 语义（HTTP 层映射 403）
  const errorCode = error.rule === 'OA-24' ? ERROR_CODES.FORBIDDEN_SCOPE : ERROR_CODES.BUSINESS_RULE
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<HandlerOutcome>): Promise<HandlerOutcome> {
  try {
    return await body()
  } catch (error) {
    if (error instanceof OrgRuleViolation) return violationOutcome(error)
    throw error
  }
}

function str(payload: Payload, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' ? v : undefined
}

function num(payload: Payload, key: string): number | undefined {
  const v = payload[key]
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined
}

function strArray(payload: Payload, key: string): string[] | undefined {
  const v = payload[key]
  return Array.isArray(v) && v.every((x): x is string => typeof x === 'string') ? v : undefined
}

/** 企业活动节点索引（dev 规模，全量载入用于树/范围计算）。 */
async function nodeMapOf(
  tools: CommandTools,
  ctx: CommandContext,
): Promise<Map<string, OrgNodeRecord>> {
  const nodes = await tools.org.listActiveByEnterprise(ctx.enterpriseId)
  return new Map(nodes.map((n) => [n.id, n]))
}

/** 节点所属工厂（自身或祖先 plant；企业/法人层为 null）。 */
function plantOf(node: OrgNodeRecord, map: ReadonlyMap<string, OrgNodeRecord>): OrgNodeRecord | null {
  let current: OrgNodeRecord | undefined = node
  let hops = 0
  while (current && hops < 64) {
    if (current.kind === 'plant') return current
    current = current.parentId ? map.get(current.parentId) : undefined
    hops += 1
  }
  return null
}

/** OA-26 写路径二道防线：目标对象所属厂须在 actor 数据范围内（企业层对象要求企业范围）。 */
async function assertWriteScope(tools: CommandTools, plant: OrgNodeRecord | null): Promise<void> {
  const scope = await tools.actorDataScope()
  if (plant === null) {
    if (!scope.enterpriseWide) {
      throw new OrgRuleViolation('OA-24', '企业/法人层对象仅企业范围授权可操作')
    }
    return
  }
  if (!isPlantInScope(scope, plant.id)) {
    throw new OrgRuleViolation('OA-24', `目标工厂不在授权数据范围内（plant=${plant.code}）`)
  }
}

export function createOrgCommandHandlers(deps: OrgHandlerDeps): CommandHandler[] {
  // ---------------- 机构 ----------------

  const nodeCreate: CommandHandler = {
    commandType: 'org.node.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const code = str(p, 'code')
        const name = str(p, 'name')
        const kind = str(p, 'kind') as OrgNodeKind | undefined
        if (!code || !name || !kind) return bad('payload 需要 code/name/kind')
        // OA-03/OA-04 字段口径
        assertOrgNodeFields({
          kind,
          plantCode: str(p, 'plantCode') ?? null,
          companyOrgCode: str(p, 'companyOrgCode') ?? null,
          deptCategory: num(p, 'deptCategory') ?? null,
        })
        const parentId = str(p, 'parentId') ?? null
        const parent = parentId ? await tools.org.findById(parentId) : null
        if (parentId && parent === null) return bad('上级机构不存在', ERROR_CODES.NOT_FOUND)
        // OA-02/OA-08 上级与层级配对
        assertValidParent(null, parent ? { id: parent.id, kind: parent.kind, path: parent.path } : null, kind)

        // OA-01 编码/名称全局唯一（active 口径）
        if ((await tools.org.findByCode(code)) !== null) {
          throw new OrgRuleViolation('OA-01', `机构编码已存在：${code}`)
        }
        if ((await tools.org.findActiveByName(name)) !== null) {
          throw new OrgRuleViolation('OA-01', `机构名称已存在：${name}`)
        }

        const id = randomUUID()
        const enterpriseId = kind === 'enterprise' ? id : parent!.enterpriseId
        const path = computeNodePath(parent ? parent.path : null, id)
        const depth = computeNodeDepth(parent ? parent.depth : null)

        // OA-26 写路径范围二道防线
        const map = await nodeMapOf(tools, ctx)
        const targetPlant = kind === 'plant' ? null : plantOf(parent!, map)
        if (kind !== 'enterprise') await assertWriteScope(tools, kind === 'plant' ? parent! : targetPlant)

        const created = await tools.org.insert({
          id,
          kind,
          code,
          name,
          parentId: parent ? parent.id : null,
          parentKind: parent ? parent.kind : null,
          path,
          depth,
          plantCode: str(p, 'plantCode') ?? null,
          companyOrgCode: str(p, 'companyOrgCode') ?? null,
          deptCategory: str(p, 'deptCategory') != null || num(p, 'deptCategory') != null ? num(p, 'deptCategory')! : null,
          enterpriseId,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.node.create',
          subjectType: 'org_node',
          subjectId: created.id,
          after: { code, name, kind, path },
          reason: ctx.reason ?? null,
        })
        // WI-L1-ORG-GRANT-CROSS-ENT：新建企业后自动给创建者角色授予新企业 enterprise 范围，
        // 避免仅靠隔离库手工 scope_grant；产品能力入口（非 SQL 种子）。
        let crossEnterpriseAutoGrantId: string | null = null
        if (kind === 'enterprise') {
          const actorUser = await tools.users.findById(ctx.actorUserId)
          if (actorUser !== null) {
            const auto = await tools.grants.upsertMerge({
              enterpriseId: created.id,
              principalType: 'role',
              principalId: actorUser.roleId,
              scopeType: 'enterprise',
              scopeObjectId: created.id,
              permissions: ['org.read', 'org.admin', 'org.role.admin'],
              actor: ctx.actorLoginName,
            })
            crossEnterpriseAutoGrantId = auto.id
            await tools.audit.record({
              actor: ctx.actorLoginName,
              action: 'org.grant.grant',
              subjectType: 'scope_grant',
              subjectId: auto.id,
              after: {
                principalType: 'role',
                principalId: actorUser.roleId,
                scopeType: 'enterprise',
                scopeObjectId: created.id,
                permissions: auto.permissions,
                crossEnterprise: true,
                autoOnEnterpriseCreate: true,
              },
              reason: ctx.reason ?? 'auto-grant on enterprise create',
            })
          }
        }
        return {
          status: 'COMMITTED',
          data: {
            nodeId: created.id,
            code: created.code,
            path: created.path,
            crossEnterpriseAutoGrantId,
          },
        }
      }),
  }

  const nodeUpdate: CommandHandler = {
    commandType: 'org.node.update',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const node = await tools.org.findById(envelope.targetId)
        if (node === null || node.status !== 'active') return bad('机构不存在', ERROR_CODES.NOT_FOUND)

        const nextName = str(p, 'name') ?? node.name
        const nextParentId = str(p, 'parentId') ?? node.parentId
        const nextPlantCode = 'plantCode' in p ? (str(p, 'plantCode') ?? null) : node.plantCode
        const nextCompanyOrgCode =
          'companyOrgCode' in p ? (str(p, 'companyOrgCode') ?? null) : node.companyOrgCode
        const nextDeptCategory =
          'deptCategory' in p ? (num(p, 'deptCategory') ?? null) : node.deptCategory

        // OA-03/OA-04
        assertOrgNodeFields({
          kind: node.kind,
          plantCode: nextPlantCode,
          companyOrgCode: nextCompanyOrgCode,
          deptCategory: nextDeptCategory,
        })

        // OA-01 名称唯一（排除自身）
        if (nextName !== node.name) {
          const dup = await tools.org.findActiveByName(nextName)
          if (dup !== null && dup.id !== node.id) {
            throw new OrgRuleViolation('OA-01', `机构名称已存在：${nextName}`)
          }
        }

        const parentChanged = nextParentId !== node.parentId
        let parent: OrgNodeRecord | null = null
        if (nextParentId !== null) {
          parent = await tools.org.findById(nextParentId)
          if (parent === null || parent.status !== 'active') return bad('上级机构不存在', ERROR_CODES.NOT_FOUND)
          // OA-02：不可选自身、不可选下级（无环）
          assertValidParent({ id: node.id, path: node.path }, { id: parent.id, kind: parent.kind, path: parent.path }, node.kind)
        } else if (node.kind !== 'enterprise') {
          return bad('非企业根节点必须挂上级')
        }

        const map = await nodeMapOf(tools, ctx)
        if (parentChanged || 'name' in p || 'plantCode' in p || 'companyOrgCode' in p || 'deptCategory' in p) {
          await assertWriteScope(tools, plantOf(node, map))
          if (parentChanged && parent !== null) await assertWriteScope(tools, plantOf(parent, map))
        }

        const updated = await tools.org.update(
          node.id,
          {
            name: nextName,
            parentId: parentChanged ? (nextParentId ?? undefined) : undefined,
            plantCode: nextPlantCode,
            companyOrgCode: nextCompanyOrgCode,
            deptCategory: nextDeptCategory,
          },
          ctx.actorLoginName,
        )
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.node.update',
          subjectType: 'org_node',
          subjectId: node.id,
          before: { name: node.name, parentId: node.parentId, plantCode: node.plantCode, deptCategory: node.deptCategory },
          after: { name: nextName, parentId: nextParentId, plantCode: nextPlantCode, deptCategory: nextDeptCategory },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { nodeId: updated!.id, path: updated!.path } }
      }),
  }

  const nodeRetire: CommandHandler = {
    commandType: 'org.node.retire',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        // OA-29：跨组织配置变更（机构退役）高影响，强制理由
        assertReasonPresentForHighImpact('org.node.retire', ctx.reason)
        const node = await tools.org.findById(envelope.targetId)
        if (node === null || node.status !== 'active') return bad('机构不存在', ERROR_CODES.NOT_FOUND)

        // OA-05/OA-07 删除前置（仓库/设备表属 master-data 域未建，按 0 预留）
        assertOrgNodeDeletable({
          usersInSubtree: await tools.org.countActiveUsersUnderPath(node.path),
          workCenterRefs: await tools.org.countActiveWorkCentersUnderPath(node.path),
          warehouseRefs: 0,
          equipmentRefs: 0,
        })
        const map = await nodeMapOf(tools, ctx)
        await assertWriteScope(tools, plantOf(node, map))

        // OA-06：对全部下级做逻辑删除（状态列）
        const affected = await tools.org.retireSubtree(node.id, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.node.retire',
          subjectType: 'org_node',
          subjectId: node.id,
          before: { code: node.code, name: node.name, status: node.status },
          after: { status: 'retired', affectedNodes: affected },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { nodeId: node.id, affectedNodes: affected } }
      }),
  }

  // ---------------- 用户 ----------------

  const userCreate: CommandHandler = {
    commandType: 'org.user.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const loginName = str(p, 'loginName')
        const password = str(p, 'password')
        const displayName = str(p, 'displayName')
        const deptId = str(p, 'deptId')
        const roleId = str(p, 'roleId')
        const loginPlatform = str(p, 'loginPlatform')
        const accountStatus = str(p, 'accountStatus') ?? 'enabled'
        if (!loginName || !password || !displayName || !deptId || !roleId || !loginPlatform) {
          return bad('payload 需要 loginName/password/displayName/deptId/roleId/loginPlatform')
        }
        // OA-10 / OA-14
        assertLoginNameValid(loginName)
        assertCompliantPassword(password)
        // OA-12 必填字段
        assertUserRequiredFields({ deptId, roleId, loginPlatform, accountStatus })
        if (!LOGIN_PLATFORMS.includes(loginPlatform as (typeof LOGIN_PLATFORMS)[number])) {
          return bad(`loginPlatform 须为 ${LOGIN_PLATFORMS.join('/')}`)
        }

        const map = await nodeMapOf(tools, ctx)
        const dept = map.get(deptId)
        if (!dept || dept.kind !== 'department' || dept.status !== 'active') {
          return bad('所属部门不存在或不是部门节点', ERROR_CODES.NOT_FOUND)
        }
        // OA-13：质检部（deptCategory=2）时车间部门服务端强制必填
        assertWorkshopDeptWhenRequired(dept.deptCategory, str(p, 'workshopDeptId') ?? null)
        const workshopDeptId = str(p, 'workshopDeptId') ?? null
        if (workshopDeptId !== null) {
          const ws = map.get(workshopDeptId)
          if (!ws || ws.kind !== 'department' || ws.status !== 'active') {
            return bad('车间部门不存在或不是部门节点', ERROR_CODES.NOT_FOUND)
          }
        }
        const role = await tools.roles.findById(roleId)
        if (!role || role.enterpriseId !== ctx.enterpriseId || role.status !== 'active') {
          return bad('所属角色不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }

        // OA-33：plant_id 由部门归属在服务端计算（不信客户端自报）
        const plant = plantOf(dept, map)
        if (plant === null) return bad('所属部门未挂在任何工厂之下，无法确定隔离归属')

        // OA-10 登录账号全局唯一
        if ((await tools.users.findByLoginName(loginName)) !== null) {
          throw new OrgRuleViolation('OA-10', `登录账号已存在：${loginName}`)
        }
        await assertWriteScope(tools, plant)

        const created = await tools.users.insert({
          enterpriseId: ctx.enterpriseId,
          loginName,
          passwordHash: await deps.hasher.hash(password),
          displayName,
          deptId,
          workshopDeptId,
          roleId,
          loginPlatform: loginPlatform as (typeof LOGIN_PLATFORMS)[number],
          accountStatus: accountStatus === 'disabled' ? 'disabled' : 'enabled',
          phone: str(p, 'phone') ?? null,
          plantId: plant.id,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.user.create',
          subjectType: 'user_account',
          subjectId: created.id,
          after: { loginName, displayName, deptId, roleId, plantId: plant.id, accountStatus },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { userId: created.id, loginName: created.loginName } }
      }),
  }

  const userUpdate: CommandHandler = {
    commandType: 'org.user.update',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const user = await tools.users.findById(envelope.targetId)
        if (user === null || user.status !== 'active') return bad('用户不存在', ERROR_CODES.NOT_FOUND)

        const before: Record<string, unknown> = {
          displayName: user.displayName,
          deptId: user.deptId,
          workshopDeptId: user.workshopDeptId,
          roleId: user.roleId,
          loginPlatform: user.loginPlatform,
          accountStatus: user.accountStatus,
          phone: user.phone,
        }
        const patch: Record<string, unknown> = {}
        if (str(p, 'displayName')) patch['displayName'] = str(p, 'displayName')
        if (str(p, 'roleId')) patch['roleId'] = str(p, 'roleId')
        if (str(p, 'loginPlatform')) {
          const lp = str(p, 'loginPlatform')!
          if (!LOGIN_PLATFORMS.includes(lp as (typeof LOGIN_PLATFORMS)[number])) {
            return bad(`loginPlatform 须为 ${LOGIN_PLATFORMS.join('/')}`)
          }
          patch['loginPlatform'] = lp
        }
        if (str(p, 'accountStatus')) {
          const st = str(p, 'accountStatus')!
          if (st !== 'enabled' && st !== 'disabled') return bad('accountStatus 须为 enabled/disabled')
          patch['accountStatus'] = st
        }
        if ('phone' in p) patch['phone'] = str(p, 'phone') ?? null

        const map = await nodeMapOf(tools, ctx)
        let nextDeptId = user.deptId
        if (str(p, 'deptId')) {
          nextDeptId = str(p, 'deptId')!
          const dept = map.get(nextDeptId)
          if (!dept || dept.kind !== 'department' || dept.status !== 'active') {
            return bad('所属部门不存在或不是部门节点', ERROR_CODES.NOT_FOUND)
          }
          const workshopDeptId = 'workshopDeptId' in p ? (str(p, 'workshopDeptId') ?? null) : user.workshopDeptId
          // OA-13
          assertWorkshopDeptWhenRequired(dept.deptCategory, workshopDeptId)
          patch['deptId'] = nextDeptId
          if ('workshopDeptId' in p) patch['workshopDeptId'] = str(p, 'workshopDeptId') ?? null
          const plant = plantOf(dept, map)
          if (plant === null) return bad('所属部门未挂在任何工厂之下')
          // OA-33：部门变更时服务端重算隔离归属
          patch['plantId'] = plant.id
        } else if ('workshopDeptId' in p) {
          assertWorkshopDeptWhenRequired(
            map.get(user.deptId)?.deptCategory ?? null,
            str(p, 'workshopDeptId') ?? null,
          )
          patch['workshopDeptId'] = str(p, 'workshopDeptId') ?? null
        }
        if (typeof patch['roleId'] === 'string') {
          const role = await tools.roles.findById(patch['roleId'])
          if (!role || role.enterpriseId !== ctx.enterpriseId || role.status !== 'active') {
            return bad('所属角色不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
          }
        }

        // OA-26：旧厂与新厂都须在范围内
        await assertWriteScope(tools, map.get(user.plantId) ?? null)
        if (typeof patch['plantId'] === 'string') {
          await assertWriteScope(tools, map.get(patch['plantId']) ?? null)
        }

        // OA-12：更新后必填字段仍完整
        assertUserRequiredFields({
          deptId: nextDeptId,
          roleId: (patch['roleId'] as string) ?? user.roleId,
          loginPlatform: (patch['loginPlatform'] as string) ?? user.loginPlatform,
          accountStatus: (patch['accountStatus'] as string) ?? user.accountStatus,
        })

        await tools.users.update(user.id, patch, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.user.update',
          subjectType: 'user_account',
          subjectId: user.id,
          before,
          after: { ...before, ...patch },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { userId: user.id } }
      }),
  }

  const userRetire: CommandHandler = {
    commandType: 'org.user.retire',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const user = await tools.users.findById(envelope.targetId)
        if (user === null || user.status !== 'active') return bad('用户不存在', ERROR_CODES.NOT_FOUND)
        // OA-11：不可删除当前登录账号自身
        assertNotSelfDelete(ctx.actorUserId, user.id)
        const map = await nodeMapOf(tools, ctx)
        await assertWriteScope(tools, map.get(user.plantId) ?? null)
        await tools.users.update(user.id, { status: 'retired' }, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.user.retire',
          subjectType: 'user_account',
          subjectId: user.id,
          before: { loginName: user.loginName, status: 'active' },
          after: { status: 'retired' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { userId: user.id } }
      }),
  }

  const userResetPassword: CommandHandler = {
    commandType: 'org.user.resetPassword',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const user = await tools.users.findById(envelope.targetId)
        if (user === null || user.status !== 'active') return bad('用户不存在', ERROR_CODES.NOT_FOUND)
        const map = await nodeMapOf(tools, ctx)
        await assertWriteScope(tools, map.get(user.plantId) ?? null)

        // OA-15：显式给密走 OA-14 校验；未给密取系统参数 account.initPassword（兜底 '123456'；
        // 初始口令不满足 OA-14 是原文口径，OA-14 仅约束用户显式提供/修改密码的路径）
        const explicit = str(p, 'password')
        let plain: string
        if (explicit !== undefined) {
          assertCompliantPassword(explicit)
          plain = explicit
        } else {
          plain = resolveInitPassword(deps.initPassword)
        }
        await tools.users.update(user.id, { passwordHash: await deps.hasher.hash(plain) }, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.user.resetPassword',
          subjectType: 'user_account',
          subjectId: user.id,
          after: { mode: explicit !== undefined ? 'explicit-compliant' : 'account.initPassword' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { userId: user.id } }
      }),
  }

  const userUnlock: CommandHandler = {
    commandType: 'org.user.unlock',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const user = await tools.users.findById(envelope.targetId)
        if (user === null || user.status !== 'active') return bad('用户不存在', ERROR_CODES.NOT_FOUND)
        const map = await nodeMapOf(tools, ctx)
        await assertWriteScope(tools, map.get(user.plantId) ?? null)
        // OA-16：解封仅清除登录失败锁定缓存，不改账号启用/禁用状态
        await tools.users.update(user.id, { failedLoginCount: 0, lockedUntil: null }, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.user.unlock',
          subjectType: 'user_account',
          subjectId: user.id,
          before: { failedLoginCount: user.failedLoginCount, lockedUntil: user.lockedUntil },
          after: { failedLoginCount: 0, lockedUntil: null },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { userId: user.id } }
      }),
  }

  // ---------------- 角色 ----------------

  const roleCreate: CommandHandler = {
    commandType: 'org.role.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const name = str(p, 'name')
        const alias = str(p, 'alias')
        const sort = num(p, 'sort')
        if (!name || !alias || sort === undefined) return bad('payload 需要 name/alias/sort')
        const existing = await tools.roles.listByEnterprise(ctx.enterpriseId)
        // OA-17：名称/别名/排序任一重复即拒（enterprise 为租户树根）
        const conflict = findRoleUniquenessConflict({ name, alias, sort }, existing)
        if (conflict !== null) {
          throw new OrgRuleViolation(
            'OA-17',
            `角色名称/别名/排序与既有角色冲突（${conflict.name} / ${conflict.alias} / sort=${conflict.sort}）`,
          )
        }
        const parentRoleId = str(p, 'parentRoleId') ?? null
        if (parentRoleId !== null) {
          const parentRole = await tools.roles.findById(parentRoleId)
          if (parentRole === null || parentRole.enterpriseId !== ctx.enterpriseId) {
            return bad('上级角色不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
          }
        }
        // 普通角色经命令层创建一律 is_system=1（内置角色仅种子/装配期产生，OA-18）
        const created = await tools.roles.insert({
          enterpriseId: ctx.enterpriseId,
          name,
          alias,
          sort,
          isSystem: 1,
          parentRoleId,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.role.create',
          subjectType: 'role',
          subjectId: created.id,
          after: { name, alias, sort },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { roleId: created.id } }
      }),
  }

  const roleUpdate: CommandHandler = {
    commandType: 'org.role.update',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const role = await tools.roles.findById(envelope.targetId)
        if (role === null || role.enterpriseId !== ctx.enterpriseId || role.status !== 'active') {
          return bad('角色不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        const patch = {
          name: str(p, 'name') ?? role.name,
          alias: str(p, 'alias') ?? role.alias,
          sort: num(p, 'sort') ?? role.sort,
          parentRoleId: 'parentRoleId' in p ? (str(p, 'parentRoleId') ?? null) : role.parentRoleId,
        }
        // OA-18：内置角色不可修改别名（也不可删除，见 retire）
        assertBuiltinRoleMutable(role, { alias: str(p, 'alias') })
        // OA-17：三者任一与其他角色冲突即拒（排除自身）
        const existing = await tools.roles.listByEnterprise(ctx.enterpriseId)
        const conflict = findRoleUniquenessConflict(
          { name: patch.name, alias: patch.alias, sort: patch.sort, id: role.id },
          existing,
        )
        if (conflict !== null) {
          throw new OrgRuleViolation(
            'OA-17',
            `角色名称/别名/排序与既有角色冲突（${conflict.name} / ${conflict.alias} / sort=${conflict.sort}）`,
          )
        }
        await tools.roles.update(role.id, patch, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.role.update',
          subjectType: 'role',
          subjectId: role.id,
          before: { name: role.name, alias: role.alias, sort: role.sort },
          after: patch,
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { roleId: role.id } }
      }),
  }

  const roleRetire: CommandHandler = {
    commandType: 'org.role.retire',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const role = await tools.roles.findById(envelope.targetId)
        if (role === null || role.enterpriseId !== ctx.enterpriseId || role.status !== 'active') {
          return bad('角色不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        // OA-18/OA-19 删除前置
        assertRoleDeletable(role, {
          assignedActiveUsers: await tools.roles.countActiveUsers(role.id),
          childRoles: await tools.roles.countActiveChildRoles(role.id),
        })
        await tools.roles.retire(role.id, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.role.retire',
          subjectType: 'role',
          subjectId: role.id,
          before: { name: role.name, alias: role.alias },
          after: { status: 'retired' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { roleId: role.id } }
      }),
  }

  // ---------------- 授权 ----------------

  const grantGrant: CommandHandler = {
    commandType: 'org.grant.grant',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        // OA-29：授权变更（跨组织配置变更）高影响，强制理由
        assertReasonPresentForHighImpact('org.grant.grant', ctx.reason)
        const p = envelope.payload as Payload
        const principalType = str(p, 'principalType')
        const principalId = str(p, 'principalId')
        const scopeType = str(p, 'scopeType')
        const scopeObjectId = str(p, 'scopeObjectId')
        const permissions = strArray(p, 'permissions')
        if (
          (principalType !== 'role' && principalType !== 'user') ||
          !principalId ||
          !scopeType ||
          !scopeObjectId ||
          !permissions ||
          permissions.length === 0
        ) {
          return bad('payload 需要 principalType/principalId/scopeType/scopeObjectId/permissions(非空)')
        }
        if (!SCOPE_TYPES.includes(scopeType as (typeof SCOPE_TYPES)[number])) {
          return bad(`scopeType 须为 ${SCOPE_TYPES.join('/')}`)
        }
        // OA-20：配置含管理员权限的授权须持 ROLE_ADMIN
        if (permissions.includes('org.role.admin')) {
          assertCanAdministerAdminRole(await tools.actorPermissions())
        }
        const map = await nodeMapOf(tools, ctx)
        let scopeObject = map.get(scopeObjectId)
        // WI-L1-ORG-GRANT-CROSS-ENT：范围对象可在其它企业（新建企业后授权可见）
        if (!scopeObject) {
          const cross = await tools.org.findById(scopeObjectId)
          if (cross && cross.status === 'active') scopeObject = cross
        }
        if (!scopeObject || scopeObject.status !== 'active') {
          return bad('范围对象不存在', ERROR_CODES.NOT_FOUND)
        }
        if (scopeObject.kind !== SCOPE_OBJECT_KIND[scopeType as (typeof SCOPE_TYPES)[number]]) {
          return bad(`scopeType=${scopeType} 的范围对象须为 ${SCOPE_OBJECT_KIND[scopeType as (typeof SCOPE_TYPES)[number]]} 节点`)
        }
        const crossEnterprise = scopeObject.enterpriseId !== ctx.enterpriseId
        if (crossEnterprise) {
          // 跨企业仅允许 enterprise 级授权；须持 org.admin（HTTP 已检）+ 企业范围
          if (scopeType !== 'enterprise') {
            return bad('跨企业授权仅支持 scopeType=enterprise')
          }
          const scope = await tools.actorDataScope()
          if (!scope.enterpriseWide) {
            return bad('跨企业授权要求操作者具备企业范围', ERROR_CODES.FORBIDDEN_SCOPE)
          }
        }
        if (principalType === 'role') {
          const role = await tools.roles.findById(principalId)
          if (!role) return bad('主体角色不存在', ERROR_CODES.NOT_FOUND)
          // 跨企业：允许对本企业角色授予目标企业范围；同企业仍校验归属
          if (!crossEnterprise && role.enterpriseId !== ctx.enterpriseId) {
            return bad('主体角色不存在', ERROR_CODES.NOT_FOUND)
          }
        } else {
          const user = await tools.users.findById(principalId)
          if (!user) return bad('主体用户不存在', ERROR_CODES.NOT_FOUND)
          if (!crossEnterprise && user.enterpriseId !== ctx.enterpriseId) {
            return bad('主体用户不存在', ERROR_CODES.NOT_FOUND)
          }
        }
        // OA-26：同企业授权目标所在厂须在 actor 范围内；跨企业已在上方校验
        if (!crossEnterprise) {
          await assertWriteScope(tools, scopeType === 'enterprise' ? null : plantOf(scopeObject, map))
        }

        // OA-22：同键至多一行，合并权限；enterpriseId 取范围对象所属企业（跨企业落目标企业）
        const row = await tools.grants.upsertMerge({
          enterpriseId: scopeObject.enterpriseId,
          principalType,
          principalId,
          scopeType: scopeType as (typeof SCOPE_TYPES)[number],
          scopeObjectId,
          permissions,
          actor: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.grant.grant',
          subjectType: 'scope_grant',
          subjectId: row.id,
          after: { principalType, principalId, scopeType, scopeObjectId, permissions },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { grantId: row.id, permissions: row.permissions } }
      }),
  }

  const grantRevoke: CommandHandler = {
    commandType: 'org.grant.revoke',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        // OA-29：高影响，强制理由
        assertReasonPresentForHighImpact('org.grant.revoke', ctx.reason)
        const p = envelope.payload as Payload
        const principalType = str(p, 'principalType')
        const principalId = str(p, 'principalId')
        const scopeType = str(p, 'scopeType')
        const scopeObjectId = str(p, 'scopeObjectId')
        const permissions = strArray(p, 'permissions')
        if (
          (principalType !== 'role' && principalType !== 'user') ||
          !principalId ||
          !scopeType ||
          !scopeObjectId ||
          !permissions ||
          permissions.length === 0
        ) {
          return bad('payload 需要 principalType/principalId/scopeType/scopeObjectId/permissions(非空)')
        }
        const row = await tools.grants.findByKey({
          principalType: principalType as 'role' | 'user',
          principalId,
          scopeType: scopeType as (typeof SCOPE_TYPES)[number],
          scopeObjectId,
        })
        if (row === null) return bad('授权行不存在', ERROR_CODES.NOT_FOUND)
        // OA-20：回收管理员权限同样须持 ROLE_ADMIN
        if (row.permissions.includes('org.role.admin')) {
          assertCanAdministerAdminRole(await tools.actorPermissions())
        }
        const map = await nodeMapOf(tools, ctx)
        const scopeObject = map.get(scopeObjectId)
        if (scopeType === 'enterprise' || scopeObject === undefined) {
          await assertWriteScope(tools, null)
        } else {
          await assertWriteScope(tools, plantOf(scopeObject, map))
        }
        const updated = await tools.grants.removePermissions(
          { principalType: principalType as 'role' | 'user', principalId, scopeType: scopeType as (typeof SCOPE_TYPES)[number], scopeObjectId },
          permissions,
          ctx.actorLoginName,
        )
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'org.grant.revoke',
          subjectType: 'scope_grant',
          subjectId: row.id,
          before: { permissions: row.permissions },
          after: { permissions: updated?.permissions ?? [], status: updated?.status ?? 'retired' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { grantId: row.id, permissions: updated?.permissions ?? [] } }
      }),
  }

  return [
    nodeCreate,
    nodeUpdate,
    nodeRetire,
    userCreate,
    userUpdate,
    userRetire,
    userResetPassword,
    userUnlock,
    roleCreate,
    roleUpdate,
    roleRetire,
    grantGrant,
    grantRevoke,
  ]
}

/** actor 授权计算（事务客户端绑定版，供 CommandTools 实现使用；OA-23/25）。 */
export async function computeActorAuthorization(
  tools: Pick<CommandTools, 'users' | 'grants' | 'org'>,
  actorUserId: string,
): Promise<{ permissions: string[]; dataScope: { enterpriseWide: boolean; plantIds: string[] } }> {
  const user: UserAccountRecord | null = await tools.users.findById(actorUserId)
  if (user === null) return { permissions: [], dataScope: { enterpriseWide: false, plantIds: [] } }
  const [grantRows, nodes] = await Promise.all([
    tools.grants.listActiveByPrincipals([
      { principalType: 'role', principalId: user.roleId },
      { principalType: 'user', principalId: user.id },
    ]),
    tools.org.listActiveByEnterprise(user.enterpriseId),
  ])
  const grantLikes = grantRows.map((g) => ({
    principalType: g.principalType,
    principalId: g.principalId,
    permissions: g.permissions,
    scopeType: g.scopeType,
    scopeObjectId: g.scopeObjectId,
  }))
  const dataScope = computeDataScope(
    grantLikes,
    nodes.map((n) => ({ id: n.id, parentId: n.parentId, kind: n.kind, path: n.path, status: n.status })),
  )
  return { permissions: unionPermissions(grantLikes), dataScope }
}
