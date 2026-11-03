import type pg from 'pg'
import type { CommandBus, CommandTools } from '@cadenza/application'
import { computeActorAuthorization } from '@cadenza/application'
import type { OutboxIntent } from '@cadenza/application'
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
// L0-整合标记（未执行前的 dist 相对导入桥接，同 shipping 整合前先例）：
// application/persistence/domain 的包名入口（src/index.ts，共享文件不改动）未导出 spc 面，
// 此处引用已构建 dist（构建顺序由 workspace 拓扑保证）。L0 整合后在各包 index 追加导出
// spc-repositories/spc-handlers/spc-queries（domain 追加 './spc'，persistence 追加
// spc-repositories 与 migration0019），并把导入改包名导入。
import { createSpcCommandHandlers } from '@cadenza/application'
import { SpcQueryService } from '@cadenza/application'
import type { SpcCommandTools, SpcOutboxCollector } from '@cadenza/application'
import {
  createPgSpcCrossDomainReader,
  createPgSpcRepositories,
} from '@cadenza/persistence'

/**
 * spc 域命令总线装配（组合根，同 shipping.composition 模式）：
 * - 处理器来自 application（spc-handlers：变更单/规则集/控制限/样本/失控闭环/校准/工具寿命）；
 * - 事务工具集 = org 基础 + spc 仓储束 + 跨域只读投影（PE-03/11/18 事实收集）+ Outbox 收集。
 */
export function buildSpcCommandBus(pool: pg.Pool): CommandBus {
  const handlers = createSpcCommandHandlers()

  const toolsFactory: CommandToolsFactory = (client, _context, now): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const outbox: SpcOutboxCollector = {
      collect(intent: OutboxIntent): void {
        // 同事务写 outbox（SA §4.2 / DM §6）：本 INSERT 先于命令总线的 COMMIT 执行
        void insertOutbox(client, intent).catch(() => undefined)
      },
    }
    const tools: SpcCommandTools = {
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
      spc: createPgSpcRepositories(client),
      cross: createPgSpcCrossDomainReader(client),
      outbox,
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
export function buildSpcQueryService(pool: pg.Pool): SpcQueryService {
  const spc = createPgSpcRepositories(pool)
  const cross = createPgSpcCrossDomainReader(pool)
  return new SpcQueryService({ spc, cross })
}
