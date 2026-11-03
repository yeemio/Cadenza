import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { InventoryController } from './inventory.controller'
import { buildInventoryCommandBus, buildInventoryQueryService } from './inventory.composition'
import { INVENTORY_COMMAND_BUS, INVENTORY_QUERY_SERVICE } from './inventory.tokens'
import type { InventoryQueryService } from '@cadenza/application'

/**
 * inventory 模块：命令总线（事务）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, InventoryModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 inventory.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [InventoryController],
  providers: [
    {
      provide: INVENTORY_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildInventoryCommandBus(pool),
    },
    {
      provide: INVENTORY_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): InventoryQueryService => buildInventoryQueryService(pool),
    },
  ],
})
export class InventoryModule {}
