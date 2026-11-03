import type pg from 'pg'
import type { CommandBus, CommandTools } from '@cadenza/application'
import { computeActorAuthorization } from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  createPgSchedulingRepositories,
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
} from '@cadenza/persistence'
import type { OutboxIntent } from '@cadenza/application'
import type { SqlClient } from '@cadenza/persistence'
// L0 整合步动作（未执行前的 dist 相对导入桥接，同 shipping/spc 块先例）：
// application/persistence 的包名入口（index.ts，共享文件不改动）未导出 csw 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 整合后在各包 index 追加导出
// csw-repositories/csw-handlers/csw-queries/csw-posting，并把导入改包名导入。
import { createCswCommandHandlers } from '@cadenza/application'
import { CswQueryService } from '@cadenza/application'
import type { CswCommandTools } from '@cadenza/application'
import { createPgCswRepositories } from '@cadenza/persistence'

/**
 * csw 域命令总线装配（组合根，同 shipping.composition 模式）：
 * - 处理器来自 application（csw-handlers：冻结/换型/校准/停机/重排建议与提交/外协全生命周期）；
 * - 事务工具集 = org 基础 + inventory 仓储束（外协两段库存交接复用同一记账序，IT-18）
 *   + scheduling 仓储束（T09 排程底座只读写）+ csw 仓储束 + Outbox 收集器（CS-24 模拟出站）。
 */
export function buildCswCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createCswCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client: SqlClient, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const outbox = {
      collect(intent: OutboxIntent): void {
        // 同事务写 outbox（SA §4.2 / DM §6）：本 INSERT 先于命令总线的 COMMIT 执行；
        // CS-24 加工数量事实（模拟适配器先行，真实路由 BLOCKED_EXTERNAL）。
        void client
          .query(
            `INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload)
             VALUES ($1, $2, $3, 'PENDING', $4::jsonb)`,
            [intent.aggregateType, intent.aggregateId, intent.taskKind, JSON.stringify(intent.payload)],
          )
          .catch(() => undefined)
      },
    }
    const tools: CswCommandTools = {
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
      scheduling: createPgSchedulingRepositories(client),
      csw: createPgCswRepositories(client),
      outbox,
    }
    return tools
  }

  return new PgCommandBus(pool, handlers, toolsFactory, () => new Date())
}

/** 查询服务装配（池连接，只读）。 */
export function buildCswQueryService(pool: pg.Pool): CswQueryService {
  const csw = createPgCswRepositories(pool)
  return new CswQueryService({ csw, scheduling: createPgSchedulingRepositories(pool) })
}
