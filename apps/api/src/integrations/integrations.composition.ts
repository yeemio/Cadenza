import { Module } from '@nestjs/common'
import type pg from 'pg'
import {
  computeActorAuthorization,
  createIntegrationMaterialCommandHandlers,
  SapSimEngineService,
  SapSimService,
  type CommandBus,
  type IntegrationMaterialCommandTools,
} from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgMaterialInboundRepository,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  PgSapSimOutboxReceiptAdapter,
  createPgMasterDataRepositories,
  createPgSapSimFactsRepositories,
  createPgSapSimRepositories,
  type CommandToolsFactory,
} from '@cadenza/persistence'
import { DbModule, PG_POOL } from '../db/db.module'
import { IntegrationsController } from './integrations.controller'
import { INTEGRATION_MATERIAL_COMMAND_BUS, SAP_SIM_ENGINE_SERVICE, SAP_SIM_SERVICE } from './integrations.tokens'

/**
 * IF-01 料品入站组合根 + SAP_SIM / outbox·inbox HTTP 服务 + R1 模拟 SAP 引擎。
 */
export function buildIntegrationMaterialCommandBus(pool: pg.Pool): CommandBus {
  const toolsFactory: CommandToolsFactory = (client, context, now) => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: IntegrationMaterialCommandTools = {
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
      masterdata: createPgMasterDataRepositories(client),
      materialInbound: new PgMaterialInboundRepository(client),
    }
    return tools
  }
  return new PgCommandBus(pool, createIntegrationMaterialCommandHandlers(), toolsFactory, () => new Date())
}

export function buildSapSimServices(pool: pg.Pool): {
  sapSim: SapSimService
  engine: SapSimEngineService
} {
  const repos = createPgSapSimRepositories(pool)
  const engine = new SapSimEngineService(
    createPgSapSimFactsRepositories(pool),
    new PgSapSimOutboxReceiptAdapter(repos.outbox),
  )
  const sapSim = new SapSimService(repos, engine)
  return { sapSim, engine }
}

@Module({
  imports: [DbModule],
  controllers: [IntegrationsController],
  providers: [
    {
      provide: INTEGRATION_MATERIAL_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildIntegrationMaterialCommandBus(pool),
    },
    {
      provide: SAP_SIM_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => buildSapSimServices(pool).sapSim,
    },
    {
      provide: SAP_SIM_ENGINE_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => buildSapSimServices(pool).engine,
    },
  ],
})
export class IntegrationsApiModule {}
