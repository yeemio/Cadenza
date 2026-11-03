import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { migrateDown, migrateUp, migrations, PgCommandBus } from '@cadenza/persistence'
import {
  computeActorAuthorization,
  type CommandContext,
  type CommandTools,
} from '@cadenza/application'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope } from '@cadenza/contracts'
import { createProcessCommandHandlers } from '../../packages/application/src/process-handlers'
import type { ProcessCommandTools } from '../../packages/application/src/process-repositories'
import { createPgProcessRepositories } from '../../packages/persistence/src/process-repositories'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
} from '@cadenza/persistence'
import type { SqlClient } from '../../packages/persistence/src/sql-client'
import { prepareProcessTestDatabase, seedProcessFixtures, nodeId } from '../api/process-test-env'

/**
 * process 域集成实测（真容器独立库 cadenza_proc，每轮 DROP+CREATE）：
 * - 0005 迁移往返（up 幂等 / 单步 down 只回退 0005 / 再 up 恢复）；
 * - 表级约束：订单状态 CHECK、订单工序 (order, seq, settings_version) 唯一、
 *   同对象 published 唯一（partial unique）；
 * - A2-2 冻结触发器：published 内容禁改、published→retired 放行、retired 终态禁改禁删；
 * - S04 变更版本预留结构默认值（settings_version=1 / execution_status=pending）；
 * - process.order.receive 命令总线幂等（同 operationId 回放、异载荷拒绝）。
 */

let pool: pg.Pool
let dbAvailable = true
let adminCtx: CommandContext
let enterpriseId: string
let szPlantId: string

beforeAll(async () => {
  try {
    pool = await prepareProcessTestDatabase()
  } catch {
    dbAvailable = false
    console.warn('SKIP process integration: 数据库不可达。请先 docker compose up -d 再重跑。')
    return
  }
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  enterpriseId = admin.rows[0]!.enterprise_id
  szPlantId = await nodeId(pool, 'PLNT-SZ')
})

afterAll(async () => {
  if (pool) await pool.end()
})

function buildBus(): PgCommandBus {
  const toolsFactory = (client: SqlClient, context: CommandContext, now: () => Date): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: ProcessCommandTools = {
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
      process: createPgProcessRepositories(client),
    }
    return tools
  }
  return new PgCommandBus(pool, createProcessCommandHandlers(), toolsFactory, () => new Date())
}

async function tableExists(name: string): Promise<boolean> {
  const r = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${name}`])
  return (r.rows[0] as { exists: boolean }).exists
}

describe('0005 迁移往返（独立库，0005 已注册进 registry）', () => {
  it('up 幂等；逐步 down 回退至 0005（七表消失）；再 up 恢复', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const all = [...migrations] // 注册表含 0001–0006+（L0 整合步注册）
    const applied = await migrateUp(pool, all)
    expect(applied).toEqual([]) // beforeAll 已应用，重复执行不报错

    // 逐级单步 down 直到 0005 被回退（注册表增长时自动适应）
    const removed: string[] = []
    while (!removed.includes('0005')) {
      const step = await migrateDown(pool, all)
      if (step.length === 0) break
      removed.push(...step)
    }
    expect(removed[removed.length - 1]).toBe('0005')
    for (const v of removed) expect(v >= '0005').toBe(true)
    for (const table of [
      'product_family',
      'manufacturing_bom_revision',
      'route_revision',
      'operation_definition',
      'parameter_spec_revision',
      'production_order',
      'order_operation',
    ]) {
      expect(await tableExists(table), table).toBe(false)
    }
    // 平台表/组织表/主数据表/库存表不受回退影响
    for (const table of ['org_node', 'material', 'work_center', 'stock_balance']) {
      expect(await tableExists(table), table).toBe(true)
    }

    const restored = await migrateUp(pool, all)
    expect(restored).toEqual([...removed].sort())
    for (const table of ['product_family', 'route_revision', 'production_order', 'order_operation']) {
      expect(await tableExists(table), table).toBe(true)
    }
  })
})

describe('表级约束（0005）', () => {
  it('生产订单主状态 CHECK：非法状态被拒', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const material = (await seedProcessFixtures(pool)).materialId
    const deptId = await nodeId(pool, 'DEPT-SZ-JZ')
    await expect(
      pool.query(
        `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, production_dept_id,
           production_qty, uom, order_status, created_by)
         VALUES ($1, $2, 'MO-CK-1', $3, $4, 100, 'M', 'flying', 'itest')`,
        [enterpriseId, szPlantId, material, deptId],
      ),
    ).rejects.toThrow(/order_status/)
  })

  it('订单工序 (order_id, seq, settings_version) 唯一；S04 预留结构默认值', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const fx = await seedProcessFixtures(pool)
    const deptId = await nodeId(pool, 'DEPT-SZ-JZ')
    const opDef = await pool.query<{ id: string; code: string; name: string }>(
      `INSERT INTO operation_definition (enterprise_id, plant_id, dept_id, work_center_id,
         company_org_code, code, name, created_by)
       VALUES ($1, $2, $3, $4, 'ORG-ITEST', 'OP-ITEST-1', '集成测试工序', 'itest')
       RETURNING id, code, name`,
      [enterpriseId, szPlantId, deptId, fx.szWorkCenterId],
    )
    const order = await pool.query<{ id: string }>(
      `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, production_dept_id,
         production_qty, uom, created_by)
       VALUES ($1, $2, 'MO-CK-2', $3, $4, 100, 'M', 'itest') RETURNING id`,
      [enterpriseId, szPlantId, fx.materialId, deptId],
    )
    const orderId = order.rows[0]!.id
    const insertOp = () =>
      pool.query(
        `INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, operation_definition_id,
           operation_code, operation_name, core_multiple, offline_qty, work_center_id, work_center_code,
           work_center_name, uom, production_dept_id, created_by)
         VALUES ($1, $2, $3, 1, $4, $5, $6, 1, 100, $7, 'WC-ITEST', '集成测试工作中心', 'M', $8, 'itest')`,
        [
          enterpriseId,
          szPlantId,
          orderId,
          opDef.rows[0]!.id,
          opDef.rows[0]!.code,
          opDef.rows[0]!.name,
          fx.szWorkCenterId,
          deptId,
        ],
      )
    const first = await insertOp()
    expect(first.rowCount).toBe(1)
    // 默认值：settings_version=1、execution_status=pending（S04 变更版本预留，报工域未建）
    const row = await pool.query<{ settings_version: number; execution_status: string }>(
      `SELECT settings_version, execution_status FROM order_operation WHERE order_id = $1`,
      [orderId],
    )
    expect(row.rows[0]!.settings_version).toBe(1)
    expect(row.rows[0]!.execution_status).toBe('pending')
    // 同 (order, seq, settings_version) 二插被拒
    await expect(insertOp()).rejects.toThrow(/order_operation_order_seq_version_unique/)
  })

  it('同对象至多一条 published 路线（partial unique，A2-2 库层双保险）', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const family = await pool.query<{ id: string }>(
      `INSERT INTO product_family (enterprise_id, plant_id, code, name, created_by)
       VALUES ($1, $2, 'FAM-ITEST-1', '集成测试族', 'itest') RETURNING id`,
      [enterpriseId, szPlantId],
    )
    const familyId = family.rows[0]!.id
    const insertRoute = (version: number, status: string) =>
      pool.query(
        `INSERT INTO route_revision (enterprise_id, plant_id, product_family_id, version, status, steps, created_by)
         VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, 'itest')`,
        [enterpriseId, szPlantId, familyId, version, status],
      )
    await insertRoute(1, 'published')
    await expect(insertRoute(2, 'published')).rejects.toThrow(/route_published_uidx/)
    // draft 不受限
    await insertRoute(2, 'draft')
  })
})

describe('A2-2 冻结触发器（published 内容禁改 / retired 终态禁改禁删）', () => {
  it('published 行内容列 UPDATE 被拒；published→retired 放行；retired 行 UPDATE/DELETE 被拒', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const family = await pool.query<{ id: string }>(
      `INSERT INTO product_family (enterprise_id, plant_id, code, name, created_by)
       VALUES ($1, $2, 'FAM-ITEST-2', '触发器测试族', 'itest') RETURNING id`,
      [enterpriseId, szPlantId],
    )
    const familyId = family.rows[0]!.id
    const route = await pool.query<{ id: string }>(
      `INSERT INTO route_revision (enterprise_id, plant_id, product_family_id, version, status, steps, created_by)
       VALUES ($1, $2, $3, 1, 'published', '[{"seq":1}]'::jsonb, 'itest') RETURNING id`,
      [enterpriseId, szPlantId, familyId],
    )
    const routeId = route.rows[0]!.id

    // published 内容禁改（steps/remark/版本键）
    await expect(
      pool.query(`UPDATE route_revision SET steps = '[{"seq":2}]'::jsonb WHERE id = $1`, [routeId]),
    ).rejects.toThrow(/A2-2/)
    await expect(
      pool.query(`UPDATE route_revision SET remark = 'x' WHERE id = $1`, [routeId]),
    ).rejects.toThrow(/A2-2/)
    // published 行不可迁回 draft/reviewed
    await expect(
      pool.query(`UPDATE route_revision SET status = 'draft' WHERE id = $1`, [routeId]),
    ).rejects.toThrow(/A2-2/)
    // published → retired 放行（失效命令的库层路径）
    await pool.query(`UPDATE route_revision SET status = 'retired' WHERE id = $1`, [routeId])
    // retired 终态：禁改禁删
    await expect(
      pool.query(`UPDATE route_revision SET remark = 'y' WHERE id = $1`, [routeId]),
    ).rejects.toThrow(/A2-2/)
    await expect(pool.query(`DELETE FROM route_revision WHERE id = $1`, [routeId])).rejects.toThrow(/A2-2/)
  })
})

describe('process 命令总线幂等（真容器）', () => {
  it('process.order.receive 同 operationId 同载荷返原结果且不重复入账；异载荷拒绝', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const bus = buildBus()
    const fx = await seedProcessFixtures(pool)
    const deptId = await nodeId(pool, 'DEPT-SZ-JZ')
    const operationId = `proc-itest-${Date.now() % 100000}`
    const payload = {
      orderNo: `MO-ITEST-${Date.now() % 100000}`,
      materialId: fx.materialId,
      productionDeptId: deptId,
      productionQty: '100',
      uom: 'M',
      initialStatus: 'approved',
    }
    const envelope: CommandEnvelope = {
      operationId,
      commandType: 'process.order.receive',
      targetId: 'new',
      expectedRevision: 0,
      payload,
    }
    const first = await bus.execute(envelope, adminCtx)
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const orderId = (first.data as { orderId: string }).orderId
    expect(orderId).toBeTruthy()

    const replay = await bus.execute(envelope, adminCtx)
    expect(replay).toEqual(first)

    const mismatch = await bus.execute(
      { ...envelope, payload: { ...payload, productionQty: '200' } },
      adminCtx,
    )
    expect(mismatch.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(mismatch.errorCode).toBe(ERROR_CODES.IDEMPOTENT_PAYLOAD_MISMATCH)

    const orders = await pool.query(`SELECT count(*)::int AS n FROM production_order WHERE id = $1`, [
      orderId,
    ])
    expect(orders.rows[0]!.n).toBe(1)
    const receipts = await pool.query(
      `SELECT count(*)::int AS n FROM command_receipt
       WHERE enterprise_id = $1 AND command_type = 'process.order.receive' AND operation_id = $2`,
      [enterpriseId, operationId],
    )
    expect(receipts.rows[0]!.n).toBe(1)
    const audits = await pool.query(
      `SELECT count(*)::int AS n FROM audit_entry WHERE action = 'process.order.receive' AND subject_id = $1`,
      [orderId],
    )
    expect(audits.rows[0]!.n).toBeGreaterThanOrEqual(1)
  })
})
