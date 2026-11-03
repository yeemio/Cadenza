import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus, QualityQueryService } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { QualityController } from './quality.controller'
import { buildQualityCommandBus, buildQualityQueryService, PgExecutionEventPort } from './quality.composition'
import { QUALITY_COMMAND_BUS, QUALITY_QUERY_SERVICE } from './quality.tokens'

/**
 * quality 模块：命令总线（事务）+ 查询服务（池，只读）。
 * L0 整合步（Wave5）已注册进 app.module.ts；命令总线注入 PgExecutionEventPort
 * （报工确认事件源=production_report×report_output 审核通过行，见 quality.composition）。
 */
@Module({
  imports: [DbModule],
  controllers: [QualityController],
  providers: [
    {
      provide: QUALITY_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus =>
        buildQualityCommandBus(pool, new PgExecutionEventPort(pool)),
    },
    {
      provide: QUALITY_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): QualityQueryService => buildQualityQueryService(pool),
    },
  ],
})
export class QualityModule {}
