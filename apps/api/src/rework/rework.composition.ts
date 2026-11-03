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
// L0-整合标记（未执行前的 dist 相对导入桥接，同 reverse/shipping 整合前先例）：
// application/persistence 的包名入口（src/index.ts，共享文件不改动）未导出 rework 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 整合后在各包 index 追加导出
// rework-repositories/rework-handlers/rework-queries（persistence 追加 rework-repositories
// 与 migration0011），并把导入改包名导入。
import { createReworkCommandHandlers } from '@cadenza/application'
import { ReworkQueryService } from '@cadenza/application'
import type { ReworkCommandTools } from '@cadenza/application'
import { createPgReworkRepositories } from '@cadenza/persistence'

/**
 * rework 域命令总线装配（组合根，同 reverse.composition 模式）：
 * - 处理器来自 application（rework-handlers：倒轴执行/冲销、分托六命令、轴号修正提交/
 *   回撤、轴码退役——RS-01～RS-37）；
 * - 事务工具集 = org 基础 + inventory 仓储束（倒轴/修正/退役复用同一记账序 IT-25 +
 *   reservation 作业预留 IT-23）+ rework 仓储束 + Outbox 收集器。
 */
export function buildReworkCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createReworkCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: ReworkCommandTools = {
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
          // 同事务写 outbox（SA §4.2 / DM §6）：异步部分（统计投影、标签作废提示）经
          // 事件不阻塞主事务（RS-37）。
          void insertOutbox(client, intent).catch(() => undefined)
        },
      },
      rework: createPgReworkRepositories(client),
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
export function buildReworkQueryService(pool: pg.Pool): ReworkQueryService {
  const repo = createPgReworkRepositories(pool)
  return new ReworkQueryService({
    reelSplits: repo.reelSplits,
    palletTasks: repo.palletTasks,
    axisNo: repo.axisNo,
    retires: repo.retires,
    facts: repo.facts,
  })
}
