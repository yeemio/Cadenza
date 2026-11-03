import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
// L0-整合标记：dist 相对导入桥接（disposition 面未并入包名入口），同 disposition.composition 注释。
import { DispositionQueryService } from '@cadenza/application'
import { DispositionController } from './disposition.controller'
import { buildDispositionCommandBus, buildDispositionQueryService } from './disposition.composition'
import { DISPOSITION_COMMAND_BUS, DISPOSITION_QUERY_SERVICE } from './disposition.tokens'

/**
 * disposition 模块：命令总线（事务）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, DispositionModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 disposition.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [DispositionController],
  providers: [
    {
      provide: DISPOSITION_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildDispositionCommandBus(pool),
    },
    {
      provide: DISPOSITION_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): DispositionQueryService => buildDispositionQueryService(pool),
    },
  ],
})
export class DispositionModule {}
