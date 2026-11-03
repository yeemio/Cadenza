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
// L0 整合步动作（未执行前的 dist 相对导入桥接，同 shipping 先例）：
// application/persistence 的包名入口（index.ts，共享文件不改动）未导出 reporting 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 整合后在各包 index 追加导出
// reporting-repositories/reporting-handlers/reporting-queries，并把导入改包名导入。
import { createReportingCommandHandlers } from '@cadenza/application'
import { ReportingQueryService } from '@cadenza/application'
import type { ReportingCommandTools } from '@cadenza/application'
import { createPgReportingRepositories } from '@cadenza/persistence'

/**
 * reporting 域命令总线装配（组合根，同 shipping.composition 模式）：
 * 处理器来自 application（reporting-handlers：投影重建/快照重算/指标定义注册）；
 * 事务工具集 = org 基础 + reporting 仓储束（命令只写 0016 投影表与 audit_entry，零业务表写入）。
 */
export function buildReportingCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createReportingCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, context, now) => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const rep = createPgReportingRepositories(client)
    const tools: ReportingCommandTools = {
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
      reporting: {
        projections: rep.projections,
        sources: rep.sources,
        definitions: rep.definitions,
        snapshots: rep.snapshots,
        facts: rep.facts,
      },
    }
    return tools
  }

  return new PgCommandBus(pool, handlers, toolsFactory, () => new Date())
}

/** 查询服务装配（池连接，只读；导出审计写 0001 audit_entry）。 */
export function buildReportingQueryService(pool: pg.Pool): ReportingQueryService {
  const rep = createPgReportingRepositories(pool)
  return new ReportingQueryService({
    projections: rep.projections,
    axis: rep.axis,
    reports: rep.reports,
    definitions: rep.definitions,
    snapshots: rep.snapshots,
    trace: rep.trace,
    exports: rep.exports,
    org: new PgOrgNodeRepository(pool),
  })
}
