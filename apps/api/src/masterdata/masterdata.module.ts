import { DynamicModule, Module } from '@nestjs/common'
import type { CommandBus } from '@cadenza/application'
import { MasterDataController } from './masterdata.controller'
import { MASTERDATA_COMMAND_BUS, MASTERDATA_QUERIES } from './masterdata.tokens'
import type { MasterDataQueriesPort } from './masterdata.queries-port'

/**
 * 工厂主数据模块（动态模块）：由组合根提供命令总线与查询服务实例。
 *
 * 为什么以 register(options) 注入而非本模块自建总线：
 * 本阶段（L1-P1-SERVER T04）S2 既有共享文件（application/persistence/contracts 的 index.ts、
 * app.module.ts）按派发约束不可修改，masterdata 的应用层/持久化层实现尚不能经
 * '@cadenza/*' 裸包名导入进 api 构建产物（rootDir/src 约束）。因此装配点外置：
 * - 测试装配：tests/api/masterdata-api.spec.ts（supertest 证据，vitest 直接消费 TS 源）；
 * - 生产装配：L0 整合步把 masterdata 导出加入各包 index 并在 app.module.ts 注册后，
 *   以 masterdata.composition.ts（org.composition 同型）落位。
 * 全局 AuthGuard + ScopeGuard 由 AuthModule 提供，随宿主应用自动覆盖本控制器。
 */
export interface MasterDataModuleOptions {
  commandBus: CommandBus
  queries: MasterDataQueriesPort
}

@Module({})
export class MasterDataModule {
  static register(options: MasterDataModuleOptions): DynamicModule {
    return {
      module: MasterDataModule,
      controllers: [MasterDataController],
      providers: [
        { provide: MASTERDATA_COMMAND_BUS, useValue: options.commandBus },
        { provide: MASTERDATA_QUERIES, useValue: options.queries },
      ],
    }
  }
}
