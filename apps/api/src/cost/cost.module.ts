import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { CostController } from './cost.controller'
import { buildCostCommandBus, buildCostQueryService } from './cost.composition'
import { COST_COMMAND_BUS, COST_QUERY_SERVICE } from './cost.tokens'
import type { CostQueryService } from '@cadenza/application'

/**
 * cost 模块：命令总线（事务）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, CostModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 cost.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [CostController],
  providers: [
    {
      provide: COST_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildCostCommandBus(pool),
    },
    {
      provide: COST_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CostQueryService => buildCostQueryService(pool),
    },
  ],
})
export class CostModule {}
