import { DynamicModule, Module } from '@nestjs/common'
import type { CommandBus } from '@cadenza/application'
import { ExecutionController } from './execution.controller'
import { EXECUTION_COMMAND_BUS, EXECUTION_QUERIES } from './execution.tokens'
import type { ExecutionQueriesPort } from './execution.queries-port'

/**
 * 报工/投料执行域模块（动态模块）：由组合根提供命令总线与查询服务实例。
 *
 * 装配点外置（同 ProcessModule 模式）：
 * - 测试装配：tests/api/execution-api.spec.ts（supertest 证据，vitest 直接消费 TS 源）；
 * - 生产装配：L0 整合步把 execution 面加入各包 index 并在 app.module.ts 注册后，
 *   以 execution.composition.ts 落位。
 * 全局 AuthGuard + ScopeGuard 由 AuthModule 提供，随宿主应用自动覆盖本控制器。
 *
 * 注意：本模块不注册进 app.module.ts（派发约束：共享文件；与 0007/0009 并行 writer 不冲突）。
 */
export interface ExecutionModuleOptions {
  commandBus: CommandBus
  queries: ExecutionQueriesPort
}

@Module({})
export class ExecutionModule {
  static register(options: ExecutionModuleOptions): DynamicModule {
    return {
      module: ExecutionModule,
      controllers: [ExecutionController],
      providers: [
        { provide: EXECUTION_COMMAND_BUS, useValue: options.commandBus },
        { provide: EXECUTION_QUERIES, useValue: options.queries },
      ],
    }
  }
}
