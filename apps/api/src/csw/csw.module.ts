import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { CswController } from './csw.controller'
import { buildCswCommandBus, buildCswQueryService } from './csw.composition'
import { CSW_COMMAND_BUS, CSW_QUERY_SERVICE } from './csw.tokens'
import type { CswQueryService } from '@cadenza/application'

/**
 * csw 模块：命令总线（事务）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, CswModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 csw.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [CswController],
  providers: [
    {
      provide: CSW_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildCswCommandBus(pool),
    },
    {
      provide: CSW_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CswQueryService => buildCswQueryService(pool),
    },
  ],
})
export class CswModule {}
