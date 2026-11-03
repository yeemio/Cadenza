import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { PurchaseController } from './purchase.controller'
import { buildPurchaseCommandBus, buildPurchaseQueryService } from './purchase.composition'
import { PURCHASE_COMMAND_BUS, PURCHASE_QUERY_SERVICE } from './purchase.tokens'
import type { PurchaseQueryService } from '@cadenza/application'

/**
 * purchase 模块：命令总线（事务）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, PurchaseModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 purchase.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [PurchaseController],
  providers: [
    {
      provide: PURCHASE_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildPurchaseCommandBus(pool),
    },
    {
      provide: PURCHASE_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): PurchaseQueryService => buildPurchaseQueryService(pool),
    },
  ],
})
export class PurchaseModule {}
