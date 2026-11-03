import type pg from 'pg'
import type { CommandBus, OutboxIntent } from '@cadenza/application'
import { computeActorAuthorization } from '@cadenza/application'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgCommandBus,
  PgCommandReceiptRefRepository,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  PgBarcodeRepository,
  PgCarrierRepository,
  PgGenealogyRepository,
  PgInventoryUnitRepository,
  PgMaterialLotRepository,
  PgMaterialSegmentRepository,
  PgReservationRepository,
  PgStockBalanceRepository,
  PgStockTransactionRepository,
  createPgMasterDataRepositories,
  type CommandToolsFactory,
  type SqlClient,
} from '@cadenza/persistence'
// L0 整合步动作（未执行前的 dist 相对导入桥接，同 reporting 先例）：
// application/persistence 的包名入口（index.ts，共享文件不改动）未导出 maintenance 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 整合后在各包 index 追加导出
// maintenance-repositories/maintenance-handlers/maintenance-queries，并把导入改包名导入。
import { createMaintenanceCommandHandlers } from '@cadenza/application'
import { MaintenanceQueryService } from '@cadenza/application'
import type { MaintenanceCommandTools } from '@cadenza/application'
import { createMaintenanceCommandRepositories } from '@cadenza/persistence'

/**
 * maintenance 域命令总线装配（组合根，同 reporting.composition 模式）：
 * 处理器来自 application（maintenance-handlers：异常上报/工单闭环/复机备件/计划轮次/开工）；
 * 事务工具集 = org 基础 ＋ inventory 仓储束（MT-11 修复 2026-10：备件扣减走
 * inventory-posting 内核 writeLine/closeUnitIfZero，同 rework 先例）＋ T04 设备档案端口 ＋
 * maintenance 仓储束（0015 六表＋0003 equipment/status log＋0001 outbox/回执）＋
 * Outbox 收集器（备件库存变动事件同事务）。
 */
export function buildMaintenanceCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createMaintenanceCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, context, now) => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const rep = createMaintenanceCommandRepositories(client)
    const tools: MaintenanceCommandTools = {
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
          // 同事务写 outbox（SA §4.2 / DM §6）：备件库存变动事件（maintenance.spare-issued）
          // 不阻塞主事务。
          void insertOutbox(client, intent).catch(() => undefined)
        },
      },
      equipment: createPgMasterDataRepositories(client).equipment,
      maintenance: {
        orders: rep.orders,
        downtime: rep.downtime,
        usages: rep.usages,
        plans: rep.plans,
        rounds: rep.rounds,
        starts: rep.starts,
        outbox: rep.outbox,
        receipts: new PgCommandReceiptRefRepository(client),
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
export function buildMaintenanceQueryService(pool: pg.Pool): MaintenanceQueryService {
  const rep = createMaintenanceCommandRepositories(pool)
  return new MaintenanceQueryService({
    orders: rep.orders,
    downtime: rep.downtime,
    usages: rep.usages,
    plans: rep.plans,
    rounds: rep.rounds,
    starts: rep.starts,
    outbox: rep.outbox,
    equipment: createPgMasterDataRepositories(pool).equipment,
  })
}
