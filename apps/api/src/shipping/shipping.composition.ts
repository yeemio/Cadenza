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
// L0 整合步动作（未执行前的 dist 相对导入桥接，同 purchase/quality/warehousing 块先例）：
// application/persistence 的包名入口（index.ts，共享文件不改动）未导出 shipping 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 整合后在各包 index 追加导出
// shipping-repositories/shipping-handlers/shipping-queries，并把导入改包名导入。
import { createShippingCommandHandlers } from '@cadenza/application'
import type { ShippingCommandTools, ShippingOutboxCollector } from '@cadenza/application'
import { ShippingQueryService } from '@cadenza/application'
import { createPgShippingRepositories } from '@cadenza/persistence'

/**
 * shipping 域命令总线装配（组合根，同 warehousing.composition 模式）：
 * - 处理器来自 application（shipping-handlers：PL/DC 入站、打包、扫码、确认出库、回传重试、附件）；
 * - 事务工具集 = org 基础 + inventory 仓储束（确认出库复用同一记账序）+ shipping 仓储束 +
 *   状态感知 Outbox 收集器（IF-00.4 noop_needed 初态）。
 */
export function buildShippingCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createShippingCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const pendingOutbox: Array<{ intent: OutboxIntent; status: 'PENDING' | 'NOOP_NEEDED' }> = []
    const outbox: ShippingOutboxCollector = {
      collect(intent: OutboxIntent, opts?: { status?: 'PENDING' | 'NOOP_NEEDED' }): void {
        pendingOutbox.push({ intent: structuredClone(intent), status: opts?.status ?? 'PENDING' })
      },
    }
    const tools: ShippingCommandTools = {
      org,
      users,
      roles: new PgRoleRepository(client),
      grants,
      sessions: new PgAuthSessionRepository(client),
      audit: new PgAuditWriter(client),
      now,
      flushEffects: async () => {
        for (const { intent, status } of pendingOutbox) await insertOutbox(client, intent, status)
        pendingOutbox.length = 0
      },
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
      outbox,
      sp: createPgShippingRepositories(client),
    }
    return tools
  }

  return new PgCommandBus(pool, handlers, toolsFactory, () => new Date())
}

async function insertOutbox(
  client: SqlClient,
  intent: OutboxIntent,
  status: 'PENDING' | 'NOOP_NEEDED',
): Promise<void> {
  await client.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [intent.aggregateType, intent.aggregateId, intent.taskKind, status, JSON.stringify(intent.payload)],
  )
}

/** 查询服务装配（池连接，只读）。 */
export function buildShippingQueryService(pool: pg.Pool): ShippingQueryService {
  const sp = createPgShippingRepositories(pool)
  return new ShippingQueryService({
    orders: sp.orders,
    lines: sp.lines,
    packings: sp.packings,
    scans: sp.scans,
    photos: sp.photos,
    compositions: sp.compositions,
  })
}
