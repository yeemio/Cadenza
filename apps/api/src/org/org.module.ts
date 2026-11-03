import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import type { CommandBus, OrgQueryService } from '@cadenza/application'
import { OrgQueryService as OrgQueryServiceImpl } from '@cadenza/application'
import {
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
} from '@cadenza/persistence'
import { DbModule, PG_POOL } from '../db/db.module'
import { OrgController } from './org.controller'
import { buildOrgCommandBus } from './org.composition'
import { ORG_COMMAND_BUS, ORG_QUERY_SERVICE } from './org.tokens'

/** org 管理模块：命令总线（事务）+ 查询服务（池，只读）。 */
@Module({
  imports: [DbModule],
  controllers: [OrgController],
  providers: [
    {
      provide: ORG_COMMAND_BUS,
      inject: [PG_POOL, ConfigService],
      useFactory: (pool: pg.Pool, config: ConfigService): CommandBus => buildOrgCommandBus(pool, config),
    },
    {
      provide: ORG_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): OrgQueryService =>
        new OrgQueryServiceImpl({
          org: new PgOrgNodeRepository(pool),
          users: new PgUserAccountRepository(pool),
          roles: new PgRoleRepository(pool),
          grants: new PgScopeGrantRepository(pool),
        }),
    },
  ],
})
export class OrgModule {}
