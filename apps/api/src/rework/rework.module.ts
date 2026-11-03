import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
// L0-整合标记：dist 相对导入桥接（rework 面未并入包名入口），同 reverse.composition 注释。
import { ReworkQueryService } from '@cadenza/application'
import { ReworkController } from './rework.controller'
import { buildReworkCommandBus, buildReworkQueryService } from './rework.composition'
import { REWORK_COMMAND_BUS, REWORK_QUERY_SERVICE } from './rework.tokens'

/**
 * rework 模块：命令总线（事务）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, ReworkModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 rework.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [ReworkController],
  providers: [
    {
      provide: REWORK_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildReworkCommandBus(pool),
    },
    {
      provide: REWORK_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): ReworkQueryService => buildReworkQueryService(pool),
    },
  ],
})
export class ReworkModule {}
