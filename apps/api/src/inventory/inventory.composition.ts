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
// L0 整合步已完成（2026-10-28）：application/persistence 的 index.ts 已导出 inventory 面，
// 以下改为包名导入（构建顺序由 workspace 拓扑保证）。
import { createInventoryCommandHandlers } from '@cadenza/application'
import type { InventoryCommandTools } from '@cadenza/application'
import { InventoryQueryService, type InventoryQueryDeps } from '@cadenza/application'
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
 * inventory 域命令总线装配（组合根，同 org.composition 模式）：
 * - 处理器来自 application（inventory-handlers：收货/发料/移位/调拨两段/分盘/预留）；
 * - 事务工具集 = org 基础（仓储/审计/许可与数据范围服务端计算）+ inventory 仓储 +
 *   Outbox 收集器（与业务变更同事务写 0001 outbox 表：pg 连接内 FIFO 入队，
 *   COMMIT 前落库；INSERT 失败将中止事务，命令整体回滚——原子性与 PgUnitOfWork 一致）。
 */
export function buildInventoryCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createInventoryCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const inv: InventoryCommandTools['inv'] = {
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
    }
    const tools: InventoryCommandTools = {
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
      inv,
      outbox: {
        collect(intent: OutboxIntent): void {
          // 同事务写 outbox（SA §4.2 / DM §6）：pg 客户端连接内查询 FIFO 入队，
          // 本 INSERT 先于命令总线的 COMMIT 执行；失败即中止事务（catch 仅防未观察拒绝，
          // 错误经 aborted-transaction 传导至 COMMIT 抛出）。
          void insertOutbox(client, intent).catch(() => undefined)
        },
      },
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
export function buildInventoryQueryService(pool: pg.Pool): InventoryQueryService {
  const deps: InventoryQueryDeps = {
    lots: new PgMaterialLotRepository(pool),
    units: new PgInventoryUnitRepository(pool),
    segments: new PgMaterialSegmentRepository(pool),
    balances: new PgStockBalanceRepository(pool),
    transactions: new PgStockTransactionRepository(pool),
    reservations: new PgReservationRepository(pool),
    barcodes: new PgBarcodeRepository(pool),
    carriers: new PgCarrierRepository(pool),
    genealogy: new PgGenealogyRepository(pool),
  }
  return new InventoryQueryService(deps)
}
