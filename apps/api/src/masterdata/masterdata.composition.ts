import { Module } from '@nestjs/common'
import type pg from 'pg'
import {
  computeActorAuthorization,
  createMasterDataCommandHandlers,
  MasterDataQueryService,
  type CommandBus,
  type MasterDataCommandTools,
} from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  createPgMasterDataRepositories,
  type CommandToolsFactory,
} from '@cadenza/persistence'
import { DbModule, PG_POOL } from '../db/db.module'
import { MasterDataController } from './masterdata.controller'
import { MASTERDATA_COMMAND_BUS, MASTERDATA_QUERIES } from './masterdata.tokens'

/**
 * masterdata 域组合根装配（L0 整合步落位，照测试组合 tests/api/masterdata-api.spec.ts 与
 * org.composition 模式）：命令总线 = org 基础工具集 + masterdata 仓储束超集；
 * 查询服务以池连接只读。MasterDataModule.register 的自组装变体，供 app.module 直接导入。
 */
export function buildMasterDataCommandBus(pool: pg.Pool): CommandBus {
  const toolsFactory: CommandToolsFactory = (client, context, now) => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: MasterDataCommandTools = {
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
    }
    return tools
  }
  return new PgCommandBus(pool, createMasterDataCommandHandlers(), toolsFactory, () => new Date())
}

export function buildMasterDataQueries(pool: pg.Pool): MasterDataQueryService {
  return new MasterDataQueryService({ masterdata: createPgMasterDataRepositories(pool) })
}

@Module({
  imports: [DbModule],
  controllers: [MasterDataController],
  providers: [
    {
      provide: MASTERDATA_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildMasterDataCommandBus(pool),
    },
    {
      provide: MASTERDATA_QUERIES,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => buildMasterDataQueries(pool),
    },
  ],
})
export class MasterDataApiModule {}
