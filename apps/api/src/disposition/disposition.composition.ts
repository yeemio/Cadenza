import type pg from 'pg'
import type { CommandBus, CommandTools, OutboxIntent } from '@cadenza/application'
import { computeActorAuthorization } from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgBarcodeRepository,
  PgCarrierRepository,
  PgCommandBus,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
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
// L0-整合标记（未执行前的 dist 相对导入桥接，同 reverse/spc 整合前先例）：
// application/persistence 的包名入口（src/index.ts，共享文件不改动）未导出 disposition 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 整合后在各包 index 追加导出
// disposition-repositories/disposition-handlers/disposition-queries（persistence 追加
// disposition-repositories 与 migration0014），并把导入改包名导入。
import { createDispositionCommandHandlers } from '@cadenza/application'
import { DispositionQueryService } from '@cadenza/application'
import type { DispositionCommandTools } from '@cadenza/application'
import { createPgDispositionRepositories } from '@cadenza/persistence'

/**
 * disposition 域命令总线装配（组合根，同 reverse.composition 模式）：
 * - 处理器来自 application（disposition-handlers：存疑标记/恢复、成品异常提交/审核、
 *   采购质检 Web 写入/PDA 版本化/判定/复检、处置返工/报废/让步/放行——QD-01～QD-23）；
 * - 事务工具集 = org 基础 + inventory 仓储束（存疑/放行/报废复用库存质量投影与扣减记账序）
 *   + disposition 仓储束（0014 新表 + 0006 既有质检版本链表）+ Outbox 收集器。
 */
export function buildDispositionCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createDispositionCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: DispositionCommandTools = {
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
          void insertOutbox(client, intent).catch(() => undefined)
        },
      },
      qd: createPgDispositionRepositories(client),
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
export function buildDispositionQueryService(pool: pg.Pool): DispositionQueryService {
  const qd = createPgDispositionRepositories(pool)
  return new DispositionQueryService({
    qd,
    inv: {
      units: new PgInventoryUnitRepository(pool),
      balances: new PgStockBalanceRepository(pool),
      reservations: new PgReservationRepository(pool),
    },
  })
}
