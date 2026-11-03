import type pg from 'pg'
import {
  computeActorAuthorization,
  createSapReconCommandHandlers,
  SapReconDerivationQueryService,
  SapReconQueryService,
  type CommandBus,
  type SapReconCommandTools,
} from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgSapReconDerivationRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  createPgSapReconRepositories,
  type CommandToolsFactory,
} from '@cadenza/persistence'

export function buildSapReconCommandBus(pool: pg.Pool): CommandBus {
  const toolsFactory: CommandToolsFactory = (client, context, now) => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const repos = createPgSapReconRepositories(client)
    const tools: SapReconCommandTools = {
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
      sapReconciliation: repos.sapReconciliation,
    }
    return tools
  }
  return new PgCommandBus(pool, createSapReconCommandHandlers(), toolsFactory, () => new Date())
}

export function buildSapReconQueryService(pool: pg.Pool): SapReconQueryService {
  const repos = createPgSapReconRepositories(pool)
  return new SapReconQueryService({ sapReconciliation: repos.sapReconciliation })
}

/** R4：两端独立推导只读查询（MOM 业务表 + sim_sap_* 事实表；不取请求/载荷数量）。 */
export function buildSapReconDerivationService(pool: pg.Pool): SapReconDerivationQueryService {
  return new SapReconDerivationQueryService({ repo: new PgSapReconDerivationRepository(pool) })
}
