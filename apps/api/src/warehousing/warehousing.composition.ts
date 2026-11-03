import type pg from 'pg'
import type { CommandBus, CommandTools, OutboxIntent } from '@cadenza/application'
import { computeActorAuthorization } from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  type CommandToolsFactory,
  type SqlClient,
} from '@cadenza/persistence'
import {
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
} from '@cadenza/persistence'
// L0 整合步（Wave5）：application index 已导出 warehousing/quality 面；改包名导入。
import {
  createWarehousingCommandHandlers,
  WarehousingQueryService,
  type ExecutionEventPort,
  type WarehousingCommandTools,
} from '@cadenza/application'
import { createPgWarehousingRepositories } from '@cadenza/persistence'

/**
 * warehousing 域命令总线装配（组合根，同 purchase.composition 模式）：
 * - 处理器来自 application（warehousing-handlers：任务刷新/确认入库/移库/调拨状态机五命令）；
 * - 事务工具集 = org 基础 + inventory 仓储与记账服务（同 UoW 消费）+ warehousing 仓储 +
 *   ExecutionEventPort（入库任务刷新从端口重跑——L0 整合接线，测试内存实现；
 *   缺省空实现）+ Outbox 收集器（同事务写 0001 outbox）。
 */
export function buildWarehousingCommandBus(
  pool: pg.Pool,
  events: ExecutionEventPort = { fetchEvents: async () => [] },
): CommandBus {
  const handlers = createWarehousingCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: WarehousingCommandTools = {
      org,
      users,
      roles: new PgRoleRepository(client),
      grants,
      sessions: new PgAuthSessionRepository(client),
      audit: new PgAuditWriter(client),
      now,
      actorPermissions: async () =>
        (await computeActorAuthorization({ users, grants, org }, _context.actorUserId)).permissions,
      actorDataScope: async () =>
        (await computeActorAuthorization({ users, grants, org }, _context.actorUserId)).dataScope,
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
      outbox: {
        collect(intent: OutboxIntent): void {
          // 同事务写 outbox（SA §4.2 / DM §6）：pg 客户端连接内查询 FIFO 入队，
          // 本 INSERT 先于命令总线的 COMMIT 执行；失败即中止事务。
          void insertOutbox(client, intent).catch(() => undefined)
        },
      },
      wh: createPgWarehousingRepositories(client),
      events,
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
export function buildWarehousingQueryService(pool: pg.Pool): WarehousingQueryService {
  const wh = createPgWarehousingRepositories(pool)
  return new WarehousingQueryService({
    putawayTasks: wh.putawayTasks,
    moves: wh.moves,
    transferOrders: wh.transferOrders,
    transferLines: wh.transferLines,
  })
}
