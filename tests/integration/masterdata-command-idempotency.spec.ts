import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { migrateDown, migrateUp, migrations, PgCommandBus } from '@cadenza/persistence'
import {
  computeActorAuthorization,
  type CommandContext,
  type CommandTools,
} from '@cadenza/application'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope } from '@cadenza/contracts'
import { createMasterDataCommandHandlers } from '../../packages/application/src/masterdata-handlers'
import type { MasterDataCommandTools } from '../../packages/application/src/masterdata-repositories'
import { createPgMasterDataRepositories } from '../../packages/persistence/src/masterdata-repositories'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
} from '@cadenza/persistence'
import type { SqlClient } from '../../packages/persistence/src/sql-client'
import { nodeId, prepareMasterdataTestDatabase } from '../api/masterdata-test-env'

/**
 * 主数据集成实测（真容器独立库 cadenza_md）：
 * - 0003 迁移往返（up 幂等 / 单步 down 只回退 0003 / 再 up 恢复）；
 * - MD-S1 唯一约束（(org_scope, code) partial unique）；
 * - MD-S2 referenced 触发器（禁改禁删）与 MD-S3 状态流水 append-only 触发器；
 * - masterdata 命令总线幂等（同 operationId 同载荷回放、异载荷拒绝、回执唯一）。
 */

let pool: pg.Pool
let dbAvailable = true
let adminCtx: CommandContext
let enterpriseId: string
let szPlantId: string

beforeAll(async () => {
  try {
    pool = await prepareMasterdataTestDatabase()
  } catch {
    dbAvailable = false
    console.warn('SKIP masterdata integration: 数据库不可达。请先 docker compose up -d 再重跑。')
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
    const tools: MasterDataCommandTools = {
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
      masterdata: createPgMasterDataRepositories(client),
    }
    return tools
  }
  return new PgCommandBus(pool, createMasterDataCommandHandlers(), toolsFactory, () => new Date())
}

describe('0003–0006 迁移往返（独立库）', () => {
  it('up 幂等；逐步 down 依次回退至 0003；再 up 恢复全部表', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const all = [...migrations] // 注册表含 0001–0009（L0 整合步 Wave3–Wave5 注册）
    const applied = await migrateUp(pool, all)
    expect(applied).toEqual([]) // beforeAll 已应用，重复执行不报错

    // 单步 down 逐级回退到 0003（注册表增长时自动适应：直到 0003 被回退）
    const removed: string[] = []
    while (!removed.includes('0003')) {
      const step = await migrateDown(pool, all)
      if (step.length === 0) break
      removed.push(...step)
    }
    expect(removed[removed.length - 1]).toBe('0003')
    for (const v of removed) expect(v >= '0003').toBe(true)
    expect((await pool.query(`SELECT to_regclass('public.stock_balance') IS NOT NULL AS exists`)).rows[0]!.exists).toBe(false)
    expect((await pool.query(`SELECT to_regclass('public.production_order') IS NOT NULL AS exists`)).rows[0]!.exists).toBe(false)
    expect((await pool.query(`SELECT to_regclass('public.purchase_order') IS NOT NULL AS exists`)).rows[0]!.exists).toBe(false)
    for (const table of ['material', 'uom', 'conversion_revision', 'equipment', 'equipment_status_log',
      'warehouse', 'rack', 'storage_location', 'work_center']) {
      const r = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${table}`])
      expect(r.rows[0]!.exists, table).toBe(false)
    }
    // 平台表与组织表不受回退影响
    expect((await pool.query(`SELECT to_regclass('public.org_node') IS NOT NULL AS exists`)).rows[0]!.exists).toBe(true)

    const restored = await migrateUp(pool, all)
    expect(restored).toEqual([...removed].sort())
    for (const table of ['material', 'conversion_revision', 'equipment', 'equipment_status_log',
      'warehouse', 'rack', 'storage_location', 'work_center', 'uom', 'stock_balance',
      'production_order', 'purchase_order']) {
      const r = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${table}`])
      expect(r.rows[0]!.exists, table).toBe(true)
    }
  })
})

describe('表级约束与触发器（MD-S1/S2/S3）', () => {
  it('MD-S1：料品 (org_scope, code) 唯一（active 口径）——同键二插被拒，retire 后可复用编码', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    await pool.query(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES ($1, 'MAT-UNIQ-1', '唯一约束料品一', 1, 'KG', 0, 'U9', 'itest')`,
      [enterpriseId],
    )
    await expect(
      pool.query(
        `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
         VALUES ($1, 'MAT-UNIQ-1', '唯一约束料品二', 1, 'KG', 0, 'U9', 'itest')`,
        [enterpriseId],
      ),
    ).rejects.toThrow(/material_scope_code_active_uidx/)

    // retire（逻辑删除）后同编码可复用（MD-36 partial unique where active）
    await pool.query(
      `UPDATE material SET status = 'retired', deleted_at = now() WHERE org_scope_id = $1 AND code = 'MAT-UNIQ-1'`,
      [enterpriseId],
    )
    const reuse = await pool.query(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES ($1, 'MAT-UNIQ-1', '唯一约束料品复用', 1, 'KG', 0, 'U9', 'itest') RETURNING id`,
      [enterpriseId],
    )
    expect(reuse.rowCount).toBe(1)
    // 清理复用行，避免影响其它断言
    await pool.query(`DELETE FROM material WHERE name = '唯一约束料品复用'`)
    await pool.query(`DELETE FROM material WHERE name = '唯一约束料品一'`)
  })

  it('MD-S2：referenced 换算行库层触发器禁改禁删（false→true 置位放行、闩锁不可回退）', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    // 编码按运行取唯一值：referenced 行不可删（闩锁），历史行在测试库留存
    const runSuffix = `${Date.now() % 100000}`
    const material = await pool.query<{ id: string }>(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES ($1, $2, '触发器料品', 1, 'KG', 0, 'U9', 'itest') RETURNING id`,
      [enterpriseId, `MAT-TRIG-${runSuffix}`],
    )
    const materialId = material.rows[0]!.id
    const line = await pool.query<{ id: string }>(
      `INSERT INTO conversion_revision (material_id, version, unit_name, factor, created_by)
       VALUES ($1, 1, '桶', 50, 'itest') RETURNING id`,
      [materialId],
    )
    const lineId = line.rows[0]!.id

    // 未引用：可改
    await pool.query(`UPDATE conversion_revision SET factor = 55 WHERE id = $1`, [lineId])
    // 置位放行（采购收货引用方协议）
    await pool.query(`UPDATE conversion_revision SET referenced = true WHERE id = $1`, [lineId])

    await expect(
      pool.query(`UPDATE conversion_revision SET factor = 60 WHERE id = $1`, [lineId]),
    ).rejects.toThrow(/MD-05/)
    await expect(
      pool.query(`UPDATE conversion_revision SET referenced = false WHERE id = $1`, [lineId]),
    ).rejects.toThrow(/MD-05/)
    await expect(pool.query(`DELETE FROM conversion_revision WHERE id = $1`, [lineId])).rejects.toThrow(
      /MD-05/,
    )
  })

  it('MD-S3：设备状态流水表 append-only（UPDATE/DELETE 均被触发器拒绝）', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    // 编码按运行取唯一值：流水行 append-only 不可删，设备行受 FK 保护留存于测试库
    const runSuffix = `${Date.now() % 100000}`
    const wc = await pool.query<{ id: string }>(
      `INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, created_by)
       SELECT $1, $2, id, $3, '集成测试工作中心', 'itest' FROM org_node WHERE code = 'DEPT-SZ-JZ'
       RETURNING id`,
      [enterpriseId, szPlantId, `WC-ITEST-${runSuffix}`],
    )
    const eq = await pool.query<{ id: string }>(
      `INSERT INTO equipment (enterprise_id, plant_id, dept_id, work_center_id, code, name, equipment_status, created_by)
       SELECT $1, $2, dept_id, $3, $4, '集成测试设备', 1, 'itest' FROM work_center WHERE id = $3
       RETURNING id`,
      [enterpriseId, szPlantId, wc.rows[0]!.id, `EQ-ITEST-${runSuffix}`],
    )
    const log = await pool.query<{ id: string }>(
      `INSERT INTO equipment_status_log (equipment_id, old_status, new_status, source, actor)
       VALUES ($1, 1, 2, 'WEB', 'itest') RETURNING id`,
      [eq.rows[0]!.id],
    )
    const logId = log.rows[0]!.id
    await expect(
      pool.query(`UPDATE equipment_status_log SET new_status = 1 WHERE id = $1`, [logId]),
    ).rejects.toThrow(/MD-S3/)
    await expect(pool.query(`DELETE FROM equipment_status_log WHERE id = $1`, [logId])).rejects.toThrow(
      /MD-S3/,
    )
  })
})

describe('masterdata 命令总线幂等（真容器）', () => {
  it('同 operationId 同载荷：返原结果且不重复入账；异载荷：拒绝', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const bus = buildBus()
    const wlDept = await nodeId(pool, 'DEPT-SZ-WL')
    const suffix = `${Date.now() % 100000}`
    const operationId = `md-itest-${suffix}`
    const payload = {
      code: `08${suffix.slice(-2)}`,
      name: `幂等仓库-${suffix}`,
      deptId: wlDept,
      warehouseType: 'WAREHOUSE',
      materialTypes: [1, 3],
    }
    const envelope: CommandEnvelope = {
      operationId,
      commandType: 'masterdata.warehouse.create',
      targetId: 'new',
      expectedRevision: 0,
      payload,
    }
    const first = await bus.execute(envelope, adminCtx)
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const warehouseId = (first.data as { warehouseId: string }).warehouseId
    expect(warehouseId).toBeTruthy()

    const replay = await bus.execute(envelope, adminCtx)
    expect(replay).toEqual(first)

    const mismatch = await bus.execute(
      { ...envelope, payload: { ...payload, materialTypes: [1] } },
      adminCtx,
    )
    expect(mismatch.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(mismatch.errorCode).toBe(ERROR_CODES.IDEMPOTENT_PAYLOAD_MISMATCH)

    const warehouses = await pool.query(`SELECT count(*)::int AS n FROM warehouse WHERE name = $1`, [
      payload.name,
    ])
    expect(warehouses.rows[0]!.n).toBe(1)
    const receipts = await pool.query(
      `SELECT count(*)::int AS n FROM command_receipt
       WHERE enterprise_id = $1 AND command_type = 'masterdata.warehouse.create' AND operation_id = $2`,
      [enterpriseId, operationId],
    )
    expect(receipts.rows[0]!.n).toBe(1)
    const audits = await pool.query(
      `SELECT count(*)::int AS n FROM audit_entry WHERE action = 'masterdata.warehouse.create' AND subject_id = $1`,
      [warehouseId],
    )
    expect(audits.rows[0]!.n).toBeGreaterThanOrEqual(1)

    // 清理（测试痕迹）
    await pool.query(`DELETE FROM audit_entry WHERE subject_id = $1`, [warehouseId])
    await pool.query(`DELETE FROM command_receipt WHERE operation_id = $1`, [operationId])
    await pool.query(`DELETE FROM warehouse WHERE id = $1`, [warehouseId])
  })

  it('业务拒绝也持久化回执：重放返回同一拒绝结果', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const bus = buildBus()
    const wlDept = await nodeId(pool, 'DEPT-SZ-WL')
    const operationId = `md-itest-reject-${Date.now() % 100000}`
    const envelope: CommandEnvelope = {
      operationId,
      commandType: 'masterdata.warehouse.create',
      targetId: 'new',
      expectedRevision: 0,
      payload: {
        code: '0999',
        name: `拒绝演示仓-${Date.now() % 100000}`,
        deptId: wlDept,
        warehouseType: 'LINE_SIDE', // 物流部建线边仓 → MD-24 拒绝
        materialTypes: [1],
      },
    }
    const first = await bus.execute(envelope, adminCtx)
    expect(first.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(first.errorMessage).toContain('MD-24')

    const replay = await bus.execute(envelope, adminCtx)
    expect(replay).toEqual(first)
    await pool.query(`DELETE FROM command_receipt WHERE operation_id = $1`, [operationId])
  })
})
