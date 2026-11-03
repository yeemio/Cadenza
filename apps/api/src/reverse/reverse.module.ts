import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
// L0-整合标记：dist 相对导入桥接（reverse 面未并入包名入口），同 reverse.composition 注释。
import { ReverseQueryService } from '@cadenza/application'
import { ReverseController } from './reverse.controller'
import { buildReverseCommandBus, buildReverseQueryService } from './reverse.composition'
import { REVERSE_COMMAND_BUS, REVERSE_QUERY_SERVICE } from './reverse.tokens'

/**
 * reverse 模块：命令总线（事务）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, ReverseModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 reverse.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [ReverseController],
  providers: [
    {
      provide: REVERSE_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildReverseCommandBus(pool),
    },
    {
      provide: REVERSE_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): ReverseQueryService => buildReverseQueryService(pool),
    },
  ],
})
export class ReverseModule {}
