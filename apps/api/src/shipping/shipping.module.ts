import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { ShippingController } from './shipping.controller'
import { buildShippingCommandBus, buildShippingQueryService } from './shipping.composition'
import { SHIPPING_COMMAND_BUS, SHIPPING_QUERY_SERVICE } from './shipping.tokens'
import type { ShippingQueryService } from '@cadenza/application'

/**
 * shipping 模块：命令总线（事务）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, ShippingModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 shipping.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [ShippingController],
  providers: [
    {
      provide: SHIPPING_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildShippingCommandBus(pool),
    },
    {
      provide: SHIPPING_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): ShippingQueryService => buildShippingQueryService(pool),
    },
  ],
})
export class ShippingModule {}
