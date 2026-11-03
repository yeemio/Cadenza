import type pg from 'pg'
import type { CommandBus } from '@cadenza/application'
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
} from '@cadenza/persistence'
// L0 整合步动作（未执行前的 dist 相对导入桥接，同 maintenance 先例）：
// application/persistence 的包名入口（index.ts，共享文件不改动）未导出 cost 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 整合后在各包 index 追加导出
// cost-repositories/cost-handlers/cost-queries，并把导入改包名导入。
import { createCostCommandHandlers } from '@cadenza/application'
import { CostQueryService } from '@cadenza/application'
import type { CostCommandTools } from '@cadenza/application'
import { createPgCostRepositories } from '@cadenza/persistence'

/**
 * cost 域命令总线装配（组合根，同 maintenance.composition 模式）：
 * 处理器来自 application（cost-handlers：表计/抄表/版本/归集/重算/对账/工时核对）；
 * 事务工具集 = org 基础 + cost 仓储束（0020 表 + CE-05 事实读取端口）+ outbox 收集器。
 */
export function buildCostCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createCostCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, context, now) => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const cost = createPgCostRepositories(client)
    const tools: CostCommandTools = {
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
      cost,
      outbox: {
        collect(intent): void {
          // 同事务写 outbox（SA §4.2 / DM §6）；归集完成通知任务随命令原子落库
          void client
            .query(
              `INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload)
               VALUES ($1, $2, $3, 'PENDING', $4::jsonb)`,
              [intent.aggregateType, intent.aggregateId, intent.taskKind, JSON.stringify(intent.payload)],
            )
            .catch(() => undefined)
        },
      },
    }
    return tools
  }

  return new PgCommandBus(pool, handlers, toolsFactory, () => new Date())
}

/** 查询服务装配（池连接，只读）。 */
export function buildCostQueryService(pool: pg.Pool): CostQueryService {
  const cost = createPgCostRepositories(pool)
  return new CostQueryService({
    meters: cost.meters,
    readings: cost.readings,
    allocationVersions: cost.allocationVersions,
    priceVersions: cost.priceVersions,
    runs: cost.runs,
    lines: cost.lines,
    reconItems: cost.reconItems,
    laborChecks: cost.laborChecks,
    facts: cost.facts,
  })
}
