import { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import {
  createOrgCommandHandlers,
  createScryptPasswordHasher,
  computeActorAuthorization,
  type CommandBus,
  type CommandHandler,
  type CommandTools,
} from '@cadenza/application'
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

/**
 * org 域命令总线装配（组合根）：
 * - 处理器来自 application（org-handlers）；
 * - 事务工具集 = 各 Pg 仓储绑定命令总线事务客户端 + 审计写入；
 * - actor 许可/数据范围在事务内按落库授权行计算（OA-23/25/26）。
 */
export function buildOrgCommandBus(pool: pg.Pool, config: ConfigService): CommandBus {
  const handlers: CommandHandler[] = createOrgCommandHandlers({
    hasher: createScryptPasswordHasher(),
    initPassword: config.get<string | undefined>('ACCOUNT_INIT_PASSWORD') ?? null,
  })

  const toolsFactory: CommandToolsFactory = (client, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const roles = new PgRoleRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const sessions = new PgAuthSessionRepository(client)
    const audit = new PgAuditWriter(client)
    return {
      org,
      users,
      roles,
      grants,
      sessions,
      audit,
      now,
      actorPermissions: async () => (await computeActorAuthorization({ users, grants, org }, _context.actorUserId)).permissions,
      actorDataScope: async () => (await computeActorAuthorization({ users, grants, org }, _context.actorUserId)).dataScope,
    }
  }

  return new PgCommandBus(pool, handlers, toolsFactory, () => new Date())
}
