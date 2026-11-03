import { Module } from '@nestjs/common'
import type pg from 'pg'
import {
  computeActorAuthorization,
  createSchedulingCommandHandlers,
  SchedulingQueryService,
  type CommandBus,
  type ScheduleReadPort,
  type ScheduledOperationView,
  type SchedulingCommandTools,
} from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  createPgSchedulingRepositories,
  type CommandToolsFactory,
} from '@cadenza/persistence'
import { DbModule, PG_POOL } from '../db/db.module'
import { SchedulingController } from './scheduling.controller'
import { SCHEDULING_COMMAND_BUS, SCHEDULING_QUERIES } from './scheduling.tokens'

/**
 * scheduling 域组合根装配（L0 整合步 Wave5 落位，照 process.composition 模式：
 * 命令总线 = org 基础工具集 + scheduling 仓储束；查询服务以池连接只读）。
 * SchedulingModule.register 的自组装变体，供 app.module 直接导入。
 */
export function buildSchedulingCommandBus(pool: pg.Pool): CommandBus {
  const toolsFactory: CommandToolsFactory = (client, context, now) => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: SchedulingCommandTools = {
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
      scheduling: createPgSchedulingRepositories(client),
    }
    return tools
  }
  return new PgCommandBus(pool, createSchedulingCommandHandlers(), toolsFactory, () => new Date())
}

export function buildSchedulingQueries(pool: pg.Pool): SchedulingQueryService {
  return new SchedulingQueryService({ scheduling: createPgSchedulingRepositories(pool) })
}

/**
 * ScheduleReadPort 真实适配（L0 整合步 Wave5 接线）：按设备+班次日期查排产有效槽位，
 * 经 scheduling 仓储的富行投影取四字段（订单/订单工序/序号/标准工序）。
 * 有效口径沿用 [底稿 A3-5]：排除已结束（closed）/已作废（voided）订单的槽位。
 */
export class PgScheduleSlotReadPort implements ScheduleReadPort {
  constructor(private readonly pool: pg.Pool) {}

  async listScheduledOperations(query: {
    plantId: string
    equipmentId: string
    date: string
  }): Promise<ScheduledOperationView[]> {
    const scheduling = createPgSchedulingRepositories(this.pool)
    const rows = await scheduling.slots.listViewRows({
      plantIds: [query.plantId],
      equipmentId: query.equipmentId,
      dates: [query.date],
    })
    return rows.map((row) => ({
      orderId: row.orderId,
      orderOperationId: row.orderOperationId,
      operationSeq: row.seq,
      operationDefinitionId: row.operationDefinitionId,
    }))
  }
}

@Module({
  imports: [DbModule],
  controllers: [SchedulingController],
  providers: [
    {
      provide: SCHEDULING_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildSchedulingCommandBus(pool),
    },
    {
      provide: SCHEDULING_QUERIES,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => buildSchedulingQueries(pool),
    },
  ],
})
export class SchedulingApiModule {}
