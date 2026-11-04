import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  createPool,
  migrateUp,
  migrations,
  PgCommandBus,
  PgAuditWriter,
  PgAuthSessionRepository,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
  type SqlClient,
} from '@cadenza/persistence'
import {
  computeActorAuthorization,
  createOrgCommandHandlers,
  createScryptPasswordHasher,
  type CommandContext,
  type CommandTools,
} from '@cadenza/application'
import { seedOrgAuth } from '@cadenza/persistence'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope } from '@cadenza/contracts'

/**
 * 命令幂等实测（真容器）：同 operationId 同载荷返原结果、不重复入账；
 * 异载荷拒 ERR_IDEMPOTENT_PAYLOAD_MISMATCH。
 */

let pool: pg.Pool
let dbAvailable = true
let adminCtx: CommandContext
let szPlantId: string
let enterpriseId: string
const suffix = process.env['VITEST_POOL_ID'] ?? '0'

beforeAll(async () => {
  pool = createPool(undefined, { max: 2 })
  try {
    await pool.query('SELECT 1')
  } catch (error) {
    if (process.env['CADENZA_REQUIRE_PG'] === '1') throw error
    dbAvailable = false
    console.warn('SKIP command-idempotency: 数据库不可达。请先 docker compose up -d 再重跑。')
    return
  }
  await migrateUp(pool, migrations)
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  if ((admin.rowCount ?? 0) === 0) {
    throw new Error('缺少种子用户 admin：请先运行 pnpm db:seed（或 seed-idempotent 测试）')
  }
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  enterpriseId = admin.rows[0]!.enterprise_id
  const sz = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'PLNT-SZ'`)
  szPlantId = sz.rows[0]!.id
})

afterAll(async () => {
  if (pool) await pool.end()
})

function buildBus(): PgCommandBus {
  const handlers = createOrgCommandHandlers({
    hasher: createScryptPasswordHasher(),
    initPassword: null,
  })
  const toolsFactory = (client: SqlClient, context: CommandContext): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    return {
      org,
      users,
      roles: new PgRoleRepository(client),
      grants,
      sessions: new PgAuthSessionRepository(client),
      audit: new PgAuditWriter(client),
      now: () => new Date(),
      actorPermissions: async () =>
        (await computeActorAuthorization({ users, grants, org }, context.actorUserId)).permissions,
      actorDataScope: async () =>
        (await computeActorAuthorization({ users, grants, org }, context.actorUserId)).dataScope,
    }
  }
  return new PgCommandBus(pool, handlers, toolsFactory, () => new Date())
}

describe('CommandBus 幂等（真实容器）', () => {
  it('同 operationId 同载荷：返原结果且不重复入账；异载荷：拒绝', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const bus = buildBus()
    const code = `TIDEMO${suffix}${Date.now() % 100000}`
    const operationId = `itest-${code}-op1`
    const basePayload = {
      code,
      name: `幂等演示部门-${code}`,
      kind: 'department',
      parentId: szPlantId,
      deptCategory: 1,
    }
    const envelope: CommandEnvelope = {
      operationId,
      commandType: 'org.node.create',
      targetId: 'new',
      expectedRevision: 0,
      payload: basePayload,
    }

    // 第一次：提交成功
    const first = await bus.execute(envelope, adminCtx)
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const nodeId = (first.data as { nodeId: string }).nodeId
    expect(nodeId).toBeTruthy()

    // 第二次（同键同载荷）：返回原结果（含原 occurredAt），不重复入账
    const replay = await bus.execute(envelope, adminCtx)
    expect(replay).toEqual(first)

    // 第三次（同键异载荷）：ERR_IDEMPOTENT_PAYLOAD_MISMATCH
    const mismatch = await bus.execute(
      { ...envelope, payload: { ...basePayload, deptCategory: 3 } },
      adminCtx,
    )
    expect(mismatch.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(mismatch.errorCode).toBe(ERROR_CODES.IDEMPOTENT_PAYLOAD_MISMATCH)

    // 入账唯一性：节点 1 行、回执 1 行、审计有痕（OA-28）
    const nodes = await pool.query(`SELECT count(*)::int AS n FROM org_node WHERE code = $1`, [code])
    expect(nodes.rows[0]!.n).toBe(1)
    const receipts = await pool.query(
      `SELECT count(*)::int AS n FROM command_receipt WHERE enterprise_id = $1 AND command_type = 'org.node.create' AND operation_id = $2`,
      [enterpriseId, operationId],
    )
    expect(receipts.rows[0]!.n).toBe(1)
    const audits = await pool.query(
      `SELECT count(*)::int AS n FROM audit_entry WHERE action = 'org.node.create' AND subject_id = $1`,
      [nodeId],
    )
    expect(audits.rows[0]!.n).toBeGreaterThanOrEqual(1)

    // 清理（测试痕迹，不参与业务）
    await pool.query(`DELETE FROM audit_entry WHERE subject_id = $1`, [nodeId])
    await pool.query(`DELETE FROM org_node WHERE id = $1`, [nodeId])
    await pool.query(
      `DELETE FROM command_receipt WHERE enterprise_id = $1 AND operation_id = $2`,
      [enterpriseId, operationId],
    )
  })

  it('业务拒绝也持久化回执：重放返回同一拒绝结果', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const bus = buildBus()
    const operationId = `itest-reject-${Date.now() % 100000}`
    const envelope: CommandEnvelope = {
      operationId,
      commandType: 'org.node.create',
      targetId: 'new',
      expectedRevision: 0,
      payload: {
        code: `BADNAME${suffix}`,
        name: '幂等拒绝演示-机构类型超界',
        kind: 'department',
        parentId: szPlantId,
        deptCategory: 9, // OA-03 拒绝
      },
    }
    const first = await bus.execute(envelope, adminCtx)
    expect(first.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(first.errorMessage).toContain('OA-03')

    const replay = await bus.execute(envelope, adminCtx)
    expect(replay).toEqual(first)

    await pool.query(`DELETE FROM command_receipt WHERE operation_id = $1`, [operationId])
  })
})
