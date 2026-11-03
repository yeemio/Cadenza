import { Module } from '@nestjs/common'
import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
import { DbModule, PG_POOL } from '../db/db.module'
import { MaintenanceController } from './maintenance.controller'
import { buildMaintenanceCommandBus, buildMaintenanceQueryService } from './maintenance.composition'
import { MAINTENANCE_COMMAND_BUS, MAINTENANCE_QUERY_SERVICE } from './maintenance.tokens'
// dist 相对导入桥接（L0 整合步改包名导入，同 composition 注释）
import type { MaintenanceQueryService } from '@cadenza/application'

/**
 * maintenance 模块：命令总线（事务，工单闭环/复机备件/计划轮次/开工）+ 查询服务（池，只读）。
 * **未注册进 app.module.ts**（WorkItem 硬性共享规则）：运行时证据由测试以
 * Test.createTestingModule({ imports: [ConfigModule, DbModule, AuthModule, MaintenanceModule] })
 * 挂载；L0 整合步统一注册并改相对导入为包名导入（见 maintenance.composition 注释）。
 */
@Module({
  imports: [DbModule],
  controllers: [MaintenanceController],
  providers: [
    {
      provide: MAINTENANCE_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus => buildMaintenanceCommandBus(pool),
    },
    {
      provide: MAINTENANCE_QUERY_SERVICE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): MaintenanceQueryService => buildMaintenanceQueryService(pool),
    },
  ],
})
export class MaintenanceModule {}
