import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
// L0-整合标记：dist 相对导入桥接（spc 面未并入包名入口），同 spc.composition 注释。
import { SpcQueryService } from '@cadenza/application'
import { SpcController } from './spc.controller'
import { buildSpcCommandBus, buildSpcQueryService } from './spc.composition'
import { SPC_COMMAND_BUS, SPC_QUERY_SERVICE } from './spc.tokens'

/**
 * spc 模块：命令总线（事务）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, SpcModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 spc.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [SpcController],
  providers: [
    {
      provide: SPC_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildSpcCommandBus(pool),
    },
    {
      provide: SPC_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): SpcQueryService => buildSpcQueryService(pool),
    },
  ],
})
export class SpcModule {}
