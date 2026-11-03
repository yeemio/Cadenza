import { Module } from '@nestjs/common'
import type pg from 'pg'
import {
  computeActorAuthorization,
  createProcessCommandHandlers,
  ProcessQueryService,
  type CommandBus,
  type ProcessCommandTools,
} from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  createPgProcessRepositories,
  type CommandToolsFactory,
} from '@cadenza/persistence'
import { DbModule, PG_POOL } from '../db/db.module'
import { ProcessController } from './process.controller'
import { PROCESS_COMMAND_BUS, PROCESS_QUERIES } from './process.tokens'

/**
 * process 域组合根装配（L0 整合步落位，照 tests/api/process-api.spec.ts 与 org.composition 模式）：
 * 命令总线 = org 基础工具集 + process 仓储束超集；查询服务以池连接只读。
 * ProcessModule.register 的自组装变体，供 app.module 直接导入。
 */
export function buildProcessCommandBus(pool: pg.Pool): CommandBus {
  const toolsFactory: CommandToolsFactory = (client, context, now) => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: ProcessCommandTools = {
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
      process: createPgProcessRepositories(client),
    }
    return tools
  }
  return new PgCommandBus(pool, createProcessCommandHandlers(), toolsFactory, () => new Date())
}

export function buildProcessQueries(pool: pg.Pool): ProcessQueryService {
  return new ProcessQueryService({ process: createPgProcessRepositories(pool) })
}

@Module({
  imports: [DbModule],
  controllers: [ProcessController],
  providers: [
    {
      provide: PROCESS_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildProcessCommandBus(pool),
    },
    {
      provide: PROCESS_QUERIES,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => buildProcessQueries(pool),
    },
  ],
})
export class ProcessApiModule {}
