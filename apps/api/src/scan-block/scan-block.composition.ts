import type pg from 'pg'
import {
  computeActorAuthorization,
  createScanBlockCommandHandlers,
  ScanBlockQueryService,
  type CommandBus,
  type ScanBlockCommandTools,
} from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  createPgScanBlockRepositories,
  type CommandToolsFactory,
} from '@cadenza/persistence'

export function buildScanBlockCommandBus(pool: pg.Pool): CommandBus {
  const toolsFactory: CommandToolsFactory = (client, context, now) => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const scanBlock = createPgScanBlockRepositories(client)
    const tools: ScanBlockCommandTools = {
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
      scanBlockEvents: scanBlock.scanBlockEvents,
    }
    return tools
  }
  return new PgCommandBus(pool, createScanBlockCommandHandlers(), toolsFactory, () => new Date())
}

export function buildScanBlockQueryService(pool: pg.Pool): ScanBlockQueryService {
  const scanBlock = createPgScanBlockRepositories(pool)
  return new ScanBlockQueryService({
    scanBlockEvents: scanBlock.scanBlockEvents,
  })
}
