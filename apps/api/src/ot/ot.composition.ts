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
  type CommandToolsFactory,
  type SqlClient,
} from '@cadenza/persistence'
// [L0-整合标记]（未执行前的 dist 相对导入桥接，同 shipping 先例）：
// application/persistence 的包名入口（index.ts，共享文件不改动）未导出 ot 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 整合后在各包 index
// 追加导出 ot-repositories/ot-handlers/ot-queries 并改包名导入（文件内注释已标）。
import { createOtCommandHandlers } from '@cadenza/application'
import { OtQueryService } from '@cadenza/application'
import {
  PgOtEquipmentLookup,
  createPgOtRepositories,
  extendOtCommandTools,
} from '@cadenza/persistence'

/**
 * ot 域命令总线装配（组合根，同 shipping.composition 模式）：
 * - 处理器来自 application（ot-handlers：网关/心跳/巡检、设备绑定、点位、质量码、
 *   换算、样本入池、会话关联、汇总重建、业务映射）；
 * - 事务工具集 = org 基础 + ot 仓储束 + Outbox 写入器（OT-26）+ 隔离队列（OT-07）
 *   + 跨域只读投影（工序会话/设备主档——extendOtCommandTools 装配）。
 */
export function buildOtCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createOtCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    return extendOtCommandTools(
      {
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
      },
      client as SqlClient,
    )
  }

  return new PgCommandBus(pool, handlers, toolsFactory, () => new Date())
}

/** 查询服务装配（池连接，只读）。 */
export function buildOtQueryService(pool: pg.Pool): OtQueryService {
  const ot = createPgOtRepositories(pool)
  return new OtQueryService({
    gateways: ot.gateways,
    gatewayEvents: ot.gatewayEvents,
    devices: ot.devices,
    points: ot.points,
    qualityMaps: ot.qualityMaps,
    samples: ot.samples,
    aggregates: ot.aggregates,
    stats: ot.stats,
    mappings: ot.mappings,
    facts: ot.facts,
    equipment: new PgOtEquipmentLookup(pool),
  })
}
