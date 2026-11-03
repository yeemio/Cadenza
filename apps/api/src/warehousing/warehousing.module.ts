import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus, WarehousingQueryService } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { WarehousingController } from './warehousing.controller'
import { buildWarehousingCommandBus, buildWarehousingQueryService } from './warehousing.composition'
import { PgExecutionEventPort } from '../quality/quality.composition'
import { WAREHOUSING_COMMAND_BUS, WAREHOUSING_QUERY_SERVICE } from './warehousing.tokens'

/**
 * warehousing 模块：命令总线（事务）+ 查询服务（池，只读）。
 * L0 整合步（Wave5）已注册进 app.module.ts；命令总线注入 PgExecutionEventPort
 * （与 quality 同一事件源——入库任务刷新消费报工确认事件，见 quality.composition）。
 */
@Module({
  imports: [DbModule],
  controllers: [WarehousingController],
  providers: [
    {
      provide: WAREHOUSING_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus =>
        buildWarehousingCommandBus(pool, new PgExecutionEventPort(pool)),
    },
    {
      provide: WAREHOUSING_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): WarehousingQueryService => buildWarehousingQueryService(pool),
    },
  ],
})
export class WarehousingModule {}
