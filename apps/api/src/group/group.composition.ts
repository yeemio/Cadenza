import type pg from 'pg'
import {
  computeActorAuthorization,
  createGroupCommandHandlers,
  GroupQueryService,
  type CommandBus,
  type GroupCommandTools,
} from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  createPgGroupRepositories,
  type CommandToolsFactory,
} from '@cadenza/persistence'

export function buildGroupCommandBus(pool: pg.Pool, clock: () => Date = () => new Date()): CommandBus {
  const toolsFactory: CommandToolsFactory = (client, context, now) => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const group = createPgGroupRepositories(client)
    const tools: GroupCommandTools = {
      org,
      users,
      roles: new PgRoleRepository(client),
      grants,
      sessions: new PgAuthSessionRepository(client),
      audit: new PgAuditWriter(client),
      now,
      actorPermissions: async () =>
        (await computeActorAuthorization({ users, grants, org }, context.actorUserId)).permissions,
      actorDataScope: async () =>
        (await computeActorAuthorization({ users, grants, org }, context.actorUserId)).dataScope,
      allocationRevisions: group.allocationRevisions,
      shortageKitting: group.shortageKitting,
      productRecalls: group.productRecalls,
      vendorRisks: group.vendorRisks,
      reworkWrites: group.reworkWrites,
      scrapWrites: group.scrapWrites,
    }
    return tools
  }
  return new PgCommandBus(pool, createGroupCommandHandlers(), toolsFactory, clock)
}

export function buildGroupQueryService(pool: pg.Pool): GroupQueryService {
  const group = createPgGroupRepositories(pool)
  return new GroupQueryService({
    allocationRevisions: group.allocationRevisions,
    shortageKitting: group.shortageKitting,
    productRecalls: group.productRecalls,
    vendorRisks: group.vendorRisks,
    reworkWrites: group.reworkWrites,
    scrapWrites: group.scrapWrites,
  })
}
