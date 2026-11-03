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
// [L0-整合标记] 未执行前的 dist 相对导入桥接（同 shipping/quality/warehousing 块先例）：
// application/persistence 的包名入口（index.ts，共享文件不改动）未导出 conversionform 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 整合后在各包 index 追加导出
// conversion-repositories/conversion-handlers/conversion-queries，并把导入改包名导入。
import { createConversionCommandHandlers } from '@cadenza/application'
import type { ConversionCommandTools } from '@cadenza/application'
import { ConversionQueryService } from '@cadenza/application'
import { createPgConversionRepositories } from '@cadenza/persistence'

/**
 * conversionform 域命令总线装配（组合根，同 shipping.composition 模式）：
 * - 处理器来自 application（conversion-handlers：订单式建单/编辑/删除/扫码/删码/完成/重试；
 *   库存式提交/派发/结果回填/本地应用/重新转换/重新同步）；
 * - 事务工具集 = org 基础 + inventory 仓储束（扫码锁定/源库存预留复用 IT-23 预留机制）+
 *   conversion 仓储束（含跨域只读端口）+ Outbox 收集器（FC-S4 form_conversion_push /
 *   form_conversion.inventory-stats 任务）。
 */
export function buildConversionCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createConversionCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: ConversionCommandTools = {
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
          // 失败即中止事务（catch 仅防未观察拒绝，错误经 aborted-transaction 传导至 COMMIT 抛出）。
          void insertOutbox(client, intent).catch(() => undefined)
        },
      },
      conversion: createPgConversionRepositories(client),
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
export function buildConversionQueryService(pool: pg.Pool): ConversionQueryService {
  const cv = createPgConversionRepositories(pool)
  return new ConversionQueryService({
    orders: cv.orders,
    orderLines: cv.orderLines,
    orderScans: cv.orderScans,
    assignments: cv.assignments,
    stockOrders: cv.stockOrders,
    stockLines: cv.stockLines,
    rewrites: cv.rewrites,
    stockLookups: cv.stock,
  })
}
