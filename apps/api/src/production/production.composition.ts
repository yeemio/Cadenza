import type pg from 'pg'
import {
  computeActorAuthorization,
  createProductionCommandHandlers,
  ProductionQueryService,
  type CommandBus,
  type ProductionCommandTools,
} from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  createPgProductionRepositories,
  type CommandToolsFactory,
} from '@cadenza/persistence'

export function buildProductionCommandBus(pool: pg.Pool): CommandBus {
  const toolsFactory: CommandToolsFactory = (client, context, now) => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const production = createPgProductionRepositories(client)
    const tools: ProductionCommandTools = {
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
      feedRacePlans: production.feedRacePlans,
    }
    return tools
  }
  return new PgCommandBus(pool, createProductionCommandHandlers(), toolsFactory, () => new Date())
}

export function buildProductionQueryService(pool: pg.Pool): ProductionQueryService {
  const production = createPgProductionRepositories(pool)
  return new ProductionQueryService({
    feedRacePlans: production.feedRacePlans,
  })
}
