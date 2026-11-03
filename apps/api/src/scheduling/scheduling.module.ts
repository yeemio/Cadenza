import { DynamicModule, Module } from '@nestjs/common'
import type { CommandBus } from '@cadenza/application'
import { SchedulingController } from './scheduling.controller'
import { SCHEDULING_COMMAND_BUS, SCHEDULING_QUERIES } from './scheduling.tokens'
import type { SchedulingQueriesPort } from './scheduling.queries-port'

/**
 * 生产排程模块（动态模块）：由组合根提供命令总线与查询服务实例。
 *
 * 为什么以 register(options) 注入而非本模块自建总线：
 * 本阶段（L1-P1-SERVER T09）S2 既有共享文件（application/persistence/contracts 的 index.ts、
 * app.module.ts）按派发约束不可修改，scheduling 的应用层/持久化层实现尚不能经
 * '@cadenza/*' 裸包名导入进 api 构建产物（rootDir/src 约束）。因此装配点外置：
 * - 测试装配：tests/api/scheduling-api.spec.ts（supertest 证据，vitest 直接消费 TS 源）；
 * - 生产装配：L0 整合步把 scheduling 导出加入各包 index 并在 app.module.ts 注册后，
 *   以 scheduling.composition.ts（process.composition 同型）落位。
 * 全局 AuthGuard + ScopeGuard 由 AuthModule 提供，随宿主应用自动覆盖本控制器。
 *
 * 注意：本模块不注册进 app.module.ts（派发约束；另一并行 writer 共享该文件）。
 */
export interface SchedulingModuleOptions {
  commandBus: CommandBus
  queries: SchedulingQueriesPort
}

@Module({})
export class SchedulingModule {
  static register(options: SchedulingModuleOptions): DynamicModule {
    return {
      module: SchedulingModule,
      controllers: [SchedulingController],
      providers: [
        { provide: SCHEDULING_COMMAND_BUS, useValue: options.commandBus },
        { provide: SCHEDULING_QUERIES, useValue: options.queries },
      ],
    }
  }
}
