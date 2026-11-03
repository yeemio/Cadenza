import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
// [L0-整合标记] ConversionQueryService 位于 application conversion 面（未并入共享 index.ts，
// dist 相对导入桥接同 reporting.module 先例）；L0 整合后改包名导入。
import type { ConversionQueryService } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { ConversionController } from './conversion.controller'
import { buildConversionCommandBus, buildConversionQueryService } from './conversion.composition'
import { CONVERSION_COMMAND_BUS, CONVERSION_QUERY_SERVICE } from './conversion.tokens'

/**
 * conversionform 模块：命令总线（事务）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, ConversionModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 conversion.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [ConversionController],
  providers: [
    {
      provide: CONVERSION_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildConversionCommandBus(pool),
    },
    {
      provide: CONVERSION_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): ConversionQueryService => buildConversionQueryService(pool),
    },
  ],
})
export class ConversionModule {}
