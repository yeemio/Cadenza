import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { migrateDown, migrateUp, migrations, PgCommandBus } from '@cadenza/persistence'
import {
  computeActorAuthorization,
  type CommandContext,
  type CommandTools,
} from '@cadenza/application'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope } from '@cadenza/contracts'
import { createSchedulingCommandHandlers } from '../../packages/application/src/scheduling-handlers'
import type { SchedulingCommandTools } from '../../packages/application/src/scheduling-repositories'
import { createPgSchedulingRepositories } from '../../packages/persistence/src/scheduling-repositories'
import {
  PgAuditWriter,
  PgAuthSessionRepository,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
} from '@cadenza/persistence'
import type { SqlClient } from '../../packages/persistence/src/sql-client'
import {
  prepareSchedulingTestDatabase,
  seedSchedulingFixtures,
  type SchedulingFixtureIds,
} from '../api/scheduling-test-env'

/**
 * scheduling 域集成实测（真容器独立库 cadenza_sch，每轮 DROP+CREATE）：
 * - 0007 迁移往返（up 幂等 / 逐步 down 回退到 0007 / 三表消失 / 再 up 恢复）；
 * - 表级约束：槽位五元组 UNIQUE（[底稿 A3-1] 库层双保险——同键第二条 INSERT 拒）、
 *   planned_qty CHECK > 0（改 0 = 删槽不落行）、capacity ≥ 0 与 (设备, 日期) 唯一、
 *   班次参数工厂级唯一、plant_id 隔离列与审计四列在位；
 * - scheduling.slot.save 命令总线幂等（同 operationId 回放、异载荷拒绝）。
 */

let pool: pg.Pool
let dbAvailable = true
let adminCtx: CommandContext
let fx: SchedulingFixtureIds

beforeAll(async () => {
  try {
    pool = await prepareSchedulingTestDatabase()
  } catch {
    dbAvailable = false
    console.warn('SKIP scheduling integration: 数据库不可达。请先 docker compose up -d 再重跑。')
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
})

afterAll(async () => {
  if (pool) await pool.end()
})

function buildBus(): PgCommandBus {
  const toolsFactory = (client: SqlClient, context: CommandContext, now: () => Date): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: SchedulingCommandTools = {
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
      scheduling: createPgSchedulingRepositories(client),
    }
    return tools
  }
  return new PgCommandBus(pool, createSchedulingCommandHandlers(), toolsFactory, () => new Date())
}

async function tableExists(name: string): Promise<boolean> {
  const r = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${name}`])
  return (r.rows[0] as { exists: boolean }).exists
}

async function expectRejected(query: string, values: unknown[]): Promise<string> {
  try {
    await pool.query(query, values)
    return '__NOT_REJECTED__'
  } catch (error) {
    return (error as { message: string }).message
  }
}

describe('0007 迁移往返（独立库；Wave5 注册后注册表含 0001–0009）', () => {
  it('up 幂等；逐步 down 0009→0008→0007（三表消失）；再 up 恢复', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const all = [...migrations] // 注册表已含 0007/0008/0009（L0 整合步 Wave5 注册）
    const applied = await migrateUp(pool, all)
    expect(applied).toEqual([]) // beforeAll 已应用，重复执行不报错

    // 单步 down 逐级回退到 0007（注册表增长时此序列相应延长，masterdata 先例）
    const removed: string[] = []
    while (!removed.includes('0007')) {
      const step = await migrateDown(pool, all)
      if (step.length === 0) break
      removed.push(...step)
    }
    expect(removed[removed.length - 1]).toBe('0007')
    for (const v of removed) expect(v >= '0007').toBe(true)
    for (const table of ['schedule_slot', 'capacity_calendar', 'shift_parameter']) {
      expect(await tableExists(table), table).toBe(false)
    }
    // 既有域表不受回退影响（org/主数据/工艺订单/采购）
    for (const table of ['org_node', 'equipment', 'production_order', 'order_operation']) {
      expect(await tableExists(table), table).toBe(true)
    }

    const restored = await migrateUp(pool, all)
    expect(restored).toEqual([...removed].sort())
    for (const table of ['schedule_slot', 'capacity_calendar', 'shift_parameter']) {
      expect(await tableExists(table), table).toBe(true)
    }
  })
})

describe('表级约束（0007 库层规则）', () => {
  it('槽位五元组 UNIQUE：同键第二条 INSERT 拒（[A3-1] 重复键拒的库层证据）', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    fx = await seedSchedulingFixtures(pool)
    const insertSlot = `
      INSERT INTO schedule_slot (enterprise_id, plant_id, order_id, order_operation_id,
        operation_definition_id, equipment_id, production_date, planned_qty, uom, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'M', 'it-sch')`
    const values = [
      fx.enterpriseId,
      fx.szPlantId,
      fx.orderAId,
      fx.orderAOp1Id,
      fx.operationDefinitionId,
      fx.szEquipmentAId,
      '2026-11-03',
      '100',
    ]
    await pool.query(insertSlot, values)
    const rejected = await expectRejected(insertSlot, values)
    expect(rejected).toContain('schedule_slot_identity_unique')

    // 唯一键任一维度不同即可再插（不同日期）
    await pool.query(insertSlot, [
      fx.enterpriseId,
      fx.szPlantId,
      fx.orderAId,
      fx.orderAOp1Id,
      fx.operationDefinitionId,
      fx.szEquipmentAId,
      '2026-11-04',
      '50',
    ])
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM schedule_slot WHERE order_operation_id = $1`,
      [fx.orderAOp1Id],
    )
    expect(rows.rows[0]!.n).toBe(2)
  })

  it('planned_qty CHECK > 0（0/负数拒：改 0 = 删槽不落行）；capacity ≥ 0；结构列在位', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const zeroRejected = await expectRejected(
      `INSERT INTO schedule_slot (enterprise_id, plant_id, order_id, order_operation_id,
         operation_definition_id, equipment_id, production_date, planned_qty, uom, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-11-06', 0, 'M', 'it-sch')`,
      [
        fx.enterpriseId,
        fx.szPlantId,
        fx.orderAId,
        fx.orderAOp1Id,
        fx.operationDefinitionId,
        fx.szEquipmentAId,
      ],
    )
    expect(zeroRejected).toContain('planned_qty')
    const negativeRejected = await expectRejected(
      `INSERT INTO schedule_slot (enterprise_id, plant_id, order_id, order_operation_id,
         operation_definition_id, equipment_id, production_date, planned_qty, uom, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-11-06', -5, 'M', 'it-sch')`,
      [
        fx.enterpriseId,
        fx.szPlantId,
        fx.orderAId,
        fx.orderAOp1Id,
        fx.operationDefinitionId,
        fx.szEquipmentAId,
      ],
    )
    expect(negativeRejected).toContain('planned_qty')

    // capacity ≥ 0：0 可插（已配置零产能）；负数拒；(设备,日期) 唯一
    await pool.query(
      `INSERT INTO capacity_calendar (enterprise_id, plant_id, equipment_id, production_date, capacity, uom, created_by)
       VALUES ($1, $2, $3, '2026-11-03', 0, 'M', 'it-sch')`,
      [fx.enterpriseId, fx.szPlantId, fx.szEquipmentAId],
    )
    const negativeCapacity = await expectRejected(
      `INSERT INTO capacity_calendar (enterprise_id, plant_id, equipment_id, production_date, capacity, created_by)
       VALUES ($1, $2, $3, '2026-11-07', -1, 'it-sch')`,
      [fx.enterpriseId, fx.szPlantId, fx.szEquipmentAId],
    )
    expect(negativeCapacity).toContain('capacity')
    const dupCapacity = await expectRejected(
      `INSERT INTO capacity_calendar (enterprise_id, plant_id, equipment_id, production_date, capacity, created_by)
       VALUES ($1, $2, $3, '2026-11-03', 500, 'it-sch')`,
      [fx.enterpriseId, fx.szPlantId, fx.szEquipmentAId],
    )
    expect(dupCapacity).toContain('capacity_calendar_equipment_date_unique')

    // 班次参数工厂级唯一 + 审计四列在位
    await pool.query(
      `INSERT INTO shift_parameter (enterprise_id, plant_id, day_shift_start, created_by)
       VALUES ($1, $2, '08:00', 'it-sch')`,
      [fx.enterpriseId, fx.szPlantId],
    )
    const dupShift = await expectRejected(
      `INSERT INTO shift_parameter (enterprise_id, plant_id, day_shift_start, created_by)
       VALUES ($1, $2, '09:00', 'it-sch')`,
      [fx.enterpriseId, fx.szPlantId],
    )
    expect(dupShift).toContain('shift_parameter_plant_unique')
    for (const table of ['schedule_slot', 'capacity_calendar', 'shift_parameter']) {
      const cols = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table],
      )
      const names = cols.rows.map((r) => r.column_name as string)
      for (const col of ['enterprise_id', 'plant_id', 'created_at', 'created_by', 'updated_at', 'updated_by']) {
        expect(names, `${table}.${col}`).toContain(col)
      }
    }
  })
})

describe('scheduling.slot.save 命令总线幂等', () => {
  it('同 operationId 同载荷回放原结果；异载荷 ERR_IDEMPOTENT_PAYLOAD_MISMATCH', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const bus = buildBus()
    const envelope = (plannedQty: string, operationId: string): CommandEnvelope => ({
      operationId,
      commandType: 'scheduling.slot.save',
      targetId: 'new',
      expectedRevision: 0,
      payload: {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: '2026-11-08',
        plannedQty,
      },
    })
    const first = await bus.execute(envelope('500', 'it-sch-idem-1'), adminCtx)
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const replay = await bus.execute(envelope('500', 'it-sch-idem-1'), adminCtx)
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect(replay.data).toEqual(first.data)

    const mismatch = await bus.execute(envelope('999', 'it-sch-idem-1'), adminCtx)
    expect(mismatch.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(mismatch.errorCode).toBe(ERROR_CODES.IDEMPOTENT_PAYLOAD_MISMATCH)

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM schedule_slot WHERE order_operation_id = $1 AND production_date = '2026-11-08'`,
      [fx.orderAOp1Id],
    )
    expect(rows.rows[0]!.n).toBe(1)
  })
})
