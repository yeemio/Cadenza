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
// L0 整合步动作（未执行前的 dist 相对导入桥接，同 inventory 块先例）：
// application/persistence 的包名入口（index.ts，共享文件不改动）未导出 purchase 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 在 application index 追加导出
// purchase-repositories/purchase-handlers/purchase-queries、persistence index 追加导出
// purchase-repositories 后，把以下导入改为包名导入。
import { createPurchaseCommandHandlers } from '@cadenza/application'
import type { PurchaseCommandTools } from '@cadenza/application'
import { PurchaseQueryService } from '@cadenza/application'
import { createPgPurchaseRepositories } from '@cadenza/persistence'
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

/**
 * purchase 域命令总线装配（组合根，同 inventory.composition 模式）：
 * - 处理器来自 application（purchase-handlers：订单同步/确认收货/质检结论/撤销/复检/退货/复核）；
 * - 事务工具集 = org 基础 + inventory 仓储（receiveGoods 同事务消费）+ purchase 仓储 +
 *   Outbox 收集器（与业务变更同事务写 0001 outbox：合格/退货回传任务，IF-09/10）。
 */
export function buildPurchaseCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createPurchaseCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: PurchaseCommandTools = {
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
      pur: createPgPurchaseRepositories(client),
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
export function buildPurchaseQueryService(pool: pg.Pool): PurchaseQueryService {
  const pur = createPgPurchaseRepositories(pool)
  return new PurchaseQueryService({
    lines: pur.lines,
    batches: pur.batches,
    details: pur.details,
    inspections: pur.inspections,
  })
}
