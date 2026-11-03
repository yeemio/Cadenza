import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { OtController } from './ot.controller'
import { buildOtCommandBus, buildOtQueryService } from './ot.composition'
import { OT_COMMAND_BUS, OT_QUERY_SERVICE } from './ot.tokens'
import type { OtQueryService } from '@cadenza/application'

/**
 * ot 模块：命令总线（事务）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, OtModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 ot.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [OtController],
  providers: [
    {
      provide: OT_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildOtCommandBus(pool),
    },
    {
      provide: OT_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): OtQueryService => buildOtQueryService(pool),
    },
  ],
})
export class OtModule {}
