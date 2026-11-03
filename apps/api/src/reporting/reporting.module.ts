import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { ReportingController } from './reporting.controller'
import { buildReportingCommandBus, buildReportingQueryService } from './reporting.composition'
import { REPORTING_COMMAND_BUS, REPORTING_QUERY_SERVICE } from './reporting.tokens'
// dist 相对导入桥接（L0 整合步改包名导入，同 composition 注释）
import type { ReportingQueryService } from '@cadenza/application'

/**
 * reporting 模块：命令总线（事务，投影维护）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, ReportingModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 reporting.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [ReportingController],
  providers: [
    {
      provide: REPORTING_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildReportingCommandBus(pool),
    },
    {
      provide: REPORTING_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): ReportingQueryService => buildReportingQueryService(pool),
    },
  ],
})
export class ReportingModule {}
