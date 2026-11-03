import type pg from 'pg'
import type { CommandBus, CommandTools, OutboxIntent } from '@cadenza/application'
import {
  computeActorAuthorization,
  createExecutionCommandHandlers,
  ExecutionQueryService,
  DEFAULT_EXECUTION_CONFIG,
  type ExecutionCommandTools,
  type ExecutionConfig,
  type ExecutionQueryDeps,
  type ScheduleReadPort,
} from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  PgBarcodeRepository,
  PgCarrierRepository,
  PgCommandReceiptRefRepository,
  PgGenealogyRepository,
  PgInventoryUnitRepository,
  PgMaterialLotRepository,
  PgMaterialSegmentRepository,
  PgReservationRepository,
  PgStockBalanceRepository,
  PgStockTransactionRepository,
  createPgExecutionRepositories,
  createPgProcessRepositories,
  type CommandToolsFactory,
  type SqlClient,
} from '@cadenza/persistence'
import { Module } from '@nestjs/common'
import { DbModule, PG_POOL } from '../db/db.module'
import { ExecutionController } from './execution.controller'
import { EXECUTION_COMMAND_BUS, EXECUTION_QUERIES } from './execution.tokens'
// ScheduleReadPort 真实适配（L0 整合步 Wave5）：排产查询经 scheduling 仓储读 schedule_slot。
import { PgScheduleSlotReadPort } from '../scheduling/scheduling.composition'

/**
 * execution 域组合根装配（同 inventory.composition 模式）：
 * 命令总线 = org 基础工具集 + execution 仓储 + inventory 仓储（记账服务消费）+
 * process 订单仓储（经端口）+ Outbox 收集器（同事务写 outbox）+ 排程读取端口 + 配置注入。
 *
 * ScheduleReadPort（L0 整合步 Wave5）：ExecutionApiModule 已接真实适配
 * PgScheduleSlotReadPort（经 scheduling 仓储读 schedule_slot，见 scheduling.composition）；
 * NoopScheduleReadPort 保留给程序式调用的缺省（返回空清单——扫码报工须显式携带工序）。
 */

export class NoopScheduleReadPort implements ScheduleReadPort {
  async listScheduledOperations(): Promise<Array<{ orderId: string; orderOperationId: string; operationSeq: number; operationDefinitionId: string }>> {
    return []
  }
}

export interface ExecutionCompositionOptions {
  schedule: ScheduleReadPort
  config: ExecutionConfig
}

export function buildExecutionCommandBus(
  pool: pg.Pool,
  options: ExecutionCompositionOptions,
): CommandBus {
  const handlers = createExecutionCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client: SqlClient, context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: ExecutionCommandTools = {
      org,
      users,
      roles: new PgRoleRepository(client),
      grants,
      sessions: new PgAuthSessionRepository(client),
      audit: new PgAuditWriter(client),
      now,
      actorPermissions: async () =>
        (await computeActorAuthorization({ users, grants, org }, context.actorUserId)).permissions,
      actorDataScope: async () =>
        (await computeActorAuthorization({ users, grants, org }, context.actorUserId)).dataScope,
      execution: createPgExecutionRepositories(client),
      inv: {
        receipts: new PgCommandReceiptRefRepository(client),
        lots: new PgMaterialLotRepository(client),
        units: new PgInventoryUnitRepository(client),
        segments: new PgMaterialSegmentRepository(client),
        balances: new PgStockBalanceRepository(client),
        transactions: new PgStockTransactionRepository(client),
        reservations: new PgReservationRepository(client),
        barcodes: new PgBarcodeRepository(client),
        carriers: new PgCarrierRepository(client),
        genealogy: new PgGenealogyRepository(client),
      },
      process: createPgProcessRepositories(client),
      outbox: {
        collect(intent: OutboxIntent): void {
          // 同事务写 outbox（SA §4.2 / DM §6）：pg 客户端连接内 FIFO 入队，
          // 本 INSERT 先于命令总线的 COMMIT 执行；失败即中止事务。
          void insertOutbox(client, intent).catch(() => undefined)
        },
      },
      schedule: options.schedule,
      config: options.config,
    }
    return tools
  }

  return new PgCommandBus(pool, handlers, toolsFactory, () => new Date())
}

async function insertOutbox(client: SqlClient, intent: OutboxIntent): Promise<void> {
  await client.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload)
     VALUES ($1, $2, $3, 'PENDING', $4::jsonb)`,
    [intent.aggregateType, intent.aggregateId, intent.taskKind, JSON.stringify(intent.payload)],
  )
}

/** 查询服务装配（池连接，只读）。 */
export function buildExecutionQueryService(
  pool: pg.Pool,
  options: { schedule?: ScheduleReadPort; qcDeptIds?: string[] },
): ExecutionQueryService {
  const deps: ExecutionQueryDeps = {
    execution: createPgExecutionRepositories(pool),
    process: createPgProcessRepositories(pool),
    schedule: options.schedule,
    qcDeptIds: options.qcDeptIds,
  }
  return new ExecutionQueryService(deps)
}

/**
 * execution 域自组装模块（L0 整合步 Wave5）：ScheduleReadPort 接真实排产查询
 * （PgScheduleSlotReadPort），配置取 DEFAULT_EXECUTION_CONFIG（GAP C1/C2 保守缺省：
 * 不允许超产、末道一律待审核、无已知质检部门——生产配置源落地前不编造现场值；
 * 线边判定不走配置：D-1 修复后按仓库类型主数据事实判定，见 ExecutionMasterDataLookups）。
 */
@Module({
  imports: [DbModule],
  controllers: [ExecutionController],
  providers: [
    {
      provide: EXECUTION_COMMAND_BUS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): CommandBus =>
        buildExecutionCommandBus(pool, {
          schedule: new PgScheduleSlotReadPort(pool),
          config: DEFAULT_EXECUTION_CONFIG,
        }),
    },
    {
      provide: EXECUTION_QUERIES,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) =>
        buildExecutionQueryService(pool, { schedule: new PgScheduleSlotReadPort(pool) }),
    },
  ],
})
export class ExecutionApiModule {}
