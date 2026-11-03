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
  type CommandToolsFactory,
  type SqlClient,
} from '@cadenza/persistence'
// L0-整合标记（未执行前的 dist 相对导入桥接，同 shipping/spc 整合前先例）：
// application/persistence 的包名入口（src/index.ts，共享文件不改动）未导出 reverse 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 整合后在各包 index 追加导出
// reverse-repositories/reverse-handlers/reverse-queries（persistence 追加 reverse-repositories
// 与 migration0013），并把导入改包名导入。
import { createReverseCommandHandlers } from '@cadenza/application'
import { ReverseQueryService } from '@cadenza/application'
import type { ReverseCommandTools } from '@cadenza/application'
import { createPgReverseRepositories } from '@cadenza/persistence'

/**
 * reverse 域命令总线装配（组合根，同 purchase/shipping.composition 模式）：
 * - 处理器来自 application（reverse-handlers：移库、调拨出入库、采购批次纠正、
 *   盘点与差异调整、所有权变更、载具借还——WR-01～WR-28）；
 * - 事务工具集 = org 基础 + inventory 仓储束（移库/调拨/调整复用同一记账序 IT-25）+
 *   reverse 仓储束 + Outbox 收集器（与业务变更同事务写 outbox）。
 */
export function buildReverseCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createReverseCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: ReverseCommandTools = {
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
          // 同事务写 outbox（SA §4.2 / DM §6）：本 INSERT 先于命令总线的 COMMIT 执行；
          // 退货回传重试（IF-10）由 reverse.receipt.return-sync.retry 消费。
          void insertOutbox(client, intent).catch(() => undefined)
        },
      },
      rv: createPgReverseRepositories(client),
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
export function buildReverseQueryService(pool: pg.Pool): ReverseQueryService {
  const rv = createPgReverseRepositories(pool)
  return new ReverseQueryService({
    rv: {
      moveRecords: rv.moveRecords,
      outOrders: rv.outOrders,
      outPlanLines: rv.outPlanLines,
      outScans: rv.outScans,
      inOrders: rv.inOrders,
      inLines: rv.inLines,
      stocktakes: rv.stocktakes,
      countLines: rv.countLines,
      adjustments: rv.adjustments,
      carrierLoans: rv.carrierLoans,
      corrections: rv.corrections,
      carrierFacts: rv.carrierFacts,
      pur: rv.pur,
      warehouses: rv.warehouses,
      locations: rv.locations,
    },
    inv: {
      units: new PgInventoryUnitRepository(pool),
      balances: new PgStockBalanceRepository(pool),
      reservations: new PgReservationRepository(pool),
    },
    users: new PgUserAccountRepository(pool),
  })
}
