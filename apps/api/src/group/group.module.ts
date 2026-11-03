import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus, GroupQueryService } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { GroupController } from './group.controller'
import { buildGroupCommandBus, buildGroupQueryService } from './group.composition'
import { GROUP_COMMAND_BUS, GROUP_QUERY_SERVICE } from './group.tokens'

@Module({
  imports: [DbModule],
  controllers: [GroupController],
  providers: [
    {
      provide: GROUP_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildGroupCommandBus(pool),
    },
    {
      provide: GROUP_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): GroupQueryService => buildGroupQueryService(pool),
    },
  ],
})
export class GroupModule {}
