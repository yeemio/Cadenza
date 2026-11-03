import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext } from '@cadenza/application'
import { createPool } from '@cadenza/persistence'
import { buildMaintenanceCommandBus } from '../../apps/api/src/maintenance/maintenance.composition'
import {
  MNT_TEST_DB_NAME,
  mntDatabaseUrl,
  prepareMntTestDatabase,
  seedMntFixtures,
  type MntFixtures,
} from '../api/maintenance-test-env'

/**
 * 维护域集成（真容器独立库 cadenza_maintenance + 真实命令总线与真实组合根，无业务桩）。
 * 冻结合同 frozen/p2/maintenance.md 库级约束与总线行为证据：
 * - MT-S1：maintenance_order 关闭字段 CHECK（绕过应用直改库被拒）；
 * - MT-S2：downtime_event exclusion 约束（重叠区间库级拒绝）；
 * - MT-S3：spare_part_usage 无流水消耗行拒绝（stock_transaction_id NOT NULL）；
 * - MT-S5：equipment_start_record (equipment, 业务日) 唯一（绕过 upsert 直插重复被拒）；
 * - MT-07/13/14：总线直驱状态机全链（建单→分派→处理→待复机→复机）；
 * - MT-02：状态流水 append-only（MD-S3 触发器禁改删——直改被拒）；
 * - 幂等：同 (commandType, operationId) 回放返回原结果不重复执行。
 */

let pool: pg.Pool
let busPool: pg.Pool
let bus: ReturnType<typeof buildMaintenanceCommandBus>
let adminCtx: CommandContext
let fx: MntFixtures
let dbAvailable = true
const run = `mni${Date.now().toString(36)}`

beforeAll(async () => {
  try {
    pool = await prepareMntTestDatabase()
    fx = await seedMntFixtures(pool)
  } catch (error) {
    dbAvailable = false
    console.warn(
      `SKIP maintenance integration: 测试库准备失败（${error instanceof Error ? error.message : String(error)}）。独立库 ${MNT_TEST_DB_NAME}。`,
    )
    return
  }
  busPool = createPool(mntDatabaseUrl(), { max: 2 })
  bus = buildMaintenanceCommandBus(busPool)
  adminCtx = {
    actorUserId: fx.adminUserId,
    actorLoginName: 'admin',
    enterpriseId: fx.enterpriseId,
    reason: null,
  }
})

afterAll(async () => {
  if (busPool) await busPool.end()
  if (pool) await pool.end()
})

async function execute(
  commandType: string,
  payload: Record<string, unknown>,
  operationId: string,
  ctx: CommandContext = adminCtx,
): Promise<CommandResult> {
  const envelope: CommandEnvelope<Record<string, unknown>> = {
    operationId,
    commandType,
    targetId: (payload['orderId'] as string | undefined) ?? (payload['equipmentCode'] as string | undefined) ?? 'maintenance',
    expectedRevision: 0,
    payload,
  }
  return bus.execute(envelope, ctx)
}

describe('MT-S1/S2/S3/S5 库级约束（绕过应用直改库被拒）', () => {
  let orderId = ''

  beforeAll(async () => {
    if (!dbAvailable) return
    const reply = await execute(
      'maintenance.order.create',
      { equipmentCode: fx.eq1Code, reason: '库级约束取证单' },
      `${run}-dbx-create`,
    )
    orderId = ((reply.data as { orderId: string }) ?? { orderId: '' }).orderId
  })

  it('MT-S1：未记结果/责任人直改 closed 被库 CHECK 拒绝', async () => {
    if (!dbAvailable) return
    await expect(
      pool.query(`UPDATE maintenance_order SET status = 'closed' WHERE id = $1`, [orderId]),
    ).rejects.toThrow(/maintenance_order_close_fields|违反/i)
  })

  it('MT-S1：未填取消原因直改 cancelled 被库 CHECK 拒绝', async () => {
    if (!dbAvailable) return
    await expect(
      pool.query(`UPDATE maintenance_order SET status = 'cancelled' WHERE id = $1`, [orderId]),
    ).rejects.toThrow(/maintenance_order_cancel_reason|违反/i)
  })

  it('MT-S2：同设备重叠停机区间被 exclusion 约束拒绝（库级兜底）', async () => {
    if (!dbAvailable) return
    await expect(
      pool.query(
        `INSERT INTO downtime_event (enterprise_id, plant_id, equipment_id, order_id, start_at, reason, created_by)
         VALUES ($1, $2, $3, NULL, now(), '重叠停机（库级取证）', 'mni')`,
        [fx.enterpriseId, fx.szPlantId, fx.eq1Id],
      ),
    ).rejects.toThrow(/downtime_event_no_overlap|exclusion|重叠/i)
  })

  it('MT-S3：无流水消耗行（stock_transaction_id NULL）被 NOT NULL 拒绝', async () => {
    if (!dbAvailable) return
    await expect(
      pool.query(
        `INSERT INTO spare_part_usage (enterprise_id, plant_id, order_id, unit_id, stock_transaction_id,
           quantity, before_quantity, after_quantity, uom_id, uom_code)
         VALUES ($1, $2, $3, $4, NULL, 1, 1, 0, $5, 'KG')`,
        [fx.enterpriseId, fx.szPlantId, orderId, fx.spareUnitId, '33333333-3333-4333-8333-3333333333d1'],
      ),
    ).rejects.toThrow(/stock_transaction_id|空值|null value/i)
  })

  it('MT-S5：同 (设备, 业务日) 重复开工记录被唯一约束拒绝', async () => {
    if (!dbAvailable) return
    const row = {
      enterprise: fx.enterpriseId,
      plant: fx.szPlantId,
      equipment: fx.eq2Id,
      date: '2026-10-28',
    }
    await pool.query(
      `INSERT INTO equipment_start_record (enterprise_id, plant_id, equipment_id, business_date, started_at, source, actor, created_by)
       VALUES ($1, $2, $3, $4::date, now(), 'PDA', 'mni', 'mni')`,
      [row.enterprise, row.plant, row.equipment, row.date],
    )
    await expect(
      pool.query(
        `INSERT INTO equipment_start_record (enterprise_id, plant_id, equipment_id, business_date, started_at, source, actor, created_by)
         VALUES ($1, $2, $3, $4::date, now(), 'PDA', 'mni', 'mni')`,
        [row.enterprise, row.plant, row.equipment, row.date],
      ),
    ).rejects.toThrow(/equipment_start_record_day_unique|duplicate key|重复/i)
  })

  it('MT-02/MD-S3：状态流水 append-only（直改被触发器拒绝）', async () => {
    if (!dbAvailable) return
    const log = await pool.query(`SELECT id FROM equipment_status_log WHERE equipment_id = $1 LIMIT 1`, [fx.eq1Id])
    expect(log.rows.length).toBeGreaterThan(0)
    await expect(
      pool.query(`UPDATE equipment_status_log SET new_status = 1 WHERE id = $1`, [log.rows[0]!.id]),
    ).rejects.toThrow(/append-only|禁止修改/i)
  })
})

describe('总线直驱状态机全链与幂等（MT-07/08/10/11/13/15）', () => {
  it('建单→分派→处理→待复机→备件复机（一次事务四写对齐）', async () => {
    if (!dbAvailable) return
    const created = await execute(
      'maintenance.order.create',
      { equipmentCode: fx.eq2Code, reason: '总线直驱主链', description: '总线链描述' },
      `${run}-bus-create`,
    )
    expect(created.status).toBe(CommandResultStatus.COMMITTED)
    const orderId = (created.data as { orderId: string }).orderId
    for (const [commandType, payload] of [
      ['maintenance.order.dispatch', { orderId, assignee: '孙八' }],
      ['maintenance.order.start', { orderId }],
      ['maintenance.order.finish-repair', { orderId }],
    ] as const) {
      const step = await execute(commandType, { ...payload }, `${run}-bus-${commandType.split('.').pop()}`)
      expect(step.status).toBe(CommandResultStatus.COMMITTED)
    }
    const restart = await execute(
      'maintenance.order.restart',
      { orderId, responsible: '周九', spareParts: [{ unitId: fx.spareUnitId, quantity: '19.0000' }] },
      `${run}-bus-restart`,
    )
    expect(restart.status).toBe(CommandResultStatus.COMMITTED)
    const data = restart.data as { status: string; result: string; downtime: { endAt: string } | null; capacityEventId: string }
    expect(data.status).toBe('closed')
    expect(data.result).toBe('复机正常')
    expect(data.downtime?.endAt).toBeTruthy()
    expect(data.capacityEventId).toBeTruthy()
    // 四写对齐：工单 closed＋停机闭口＋设备正常＋outbox restored
    const eq = await pool.query(`SELECT equipment_status FROM equipment WHERE id = $1`, [fx.eq2Id])
    expect(eq.rows[0]!.equipment_status).toBe(1)
    const outbox = await pool.query(
      `SELECT payload->>'changeKind' AS kind FROM outbox WHERE aggregate_id = $1 ORDER BY created_at`,
      [orderId],
    )
    expect(outbox.rows.map((r) => r.kind)).toEqual(['down', 'restored'])
  })

  it('非法迁移在总线层拒绝（越级：已报修→处理中，MT-07）', async () => {
    if (!dbAvailable) return
    const created = await execute(
      'maintenance.order.create',
      { equipmentCode: fx.eq3Code, reason: '越级取证单' },
      `${run}-skip-create`,
    )
    const orderId = (created.data as { orderId: string }).orderId
    const skip = await execute('maintenance.order.start', { orderId }, `${run}-skip-start`)
    expect(skip.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(skip.errorCode).toBe(ERROR_CODES.BUSINESS_RULE)
    expect(skip.errorMessage).toContain('[MT-07]')
    await execute('maintenance.order.cancel', { orderId, cancelReason: '取证清理' }, `${run}-skip-cancel`)
  })

  it('同 operationId 回放返回原结果不重复执行（幂等）', async () => {
    if (!dbAvailable) return
    // eq2 已随总线主链复机归正常（eq1 因库级取证单在维修中，MT-05 不可开工）
    const created = await execute(
      'maintenance.equipment.start-work',
      { equipmentCode: fx.eq2Code, startedAt: '2026-10-28T08:00:00+08:00' },
      `${run}-idem`,
    )
    expect(created.status).toBe(CommandResultStatus.COMMITTED)
    const replay = await execute(
      'maintenance.equipment.start-work',
      { equipmentCode: fx.eq2Code, startedAt: '2026-10-28T08:00:00+08:00' },
      `${run}-idem`,
    )
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect(replay.operationId).toBe(created.operationId)
    const records = await pool.query(
      `SELECT count(*)::int AS c FROM equipment_start_record WHERE equipment_id = $1 AND business_date = '2026-10-28'`,
      [fx.eq2Id],
    )
    expect(records.rows[0]!.c).toBe(1)
  })
})

describe('MT-11 修复：并发两扣一单元恰一成功（IT-30-① 余量竞争，内核路径）', () => {
  it('并发两单各扣 20（单元合格 30）：恰一 COMMITTED、账上无负库存、流水/分录各恰一行', async () => {
    if (!dbAvailable) return
    // 两台正常态设备各推进一单到待复机（MT-09：同设备不可双开停机，故分设备）
    const orderIds: string[] = []
    for (const [code, tag] of [
      [fx.eq2Code, 'cc1'],
      [fx.eq4Code, 'cc2'],
    ] as const) {
      const created = await execute(
        'maintenance.order.create',
        { equipmentCode: code, reason: `MT-11 并发取证 ${tag}` },
        `${run}-${tag}-create`,
      )
      expect(created.status).toBe(CommandResultStatus.COMMITTED)
      const orderId = (created.data as { orderId: string }).orderId
      orderIds.push(orderId)
      for (const commandType of ['dispatch', 'start', 'finish-repair'] as const) {
        const payload = commandType === 'dispatch' ? { orderId, assignee: '并发取证' } : { orderId }
        const step = await execute(`maintenance.order.${commandType}`, payload, `${run}-${tag}-${commandType}`)
        expect(step.status).toBe(CommandResultStatus.COMMITTED)
      }
    }
    // 并发复机：两单同时各扣 20（单元可用 30 < 40——IT-30-① 最多一个按原量成功）
    const replies = await Promise.all(
      orderIds.map((orderId, index) =>
        execute(
          'maintenance.order.restart',
          { orderId, responsible: '并发取证', spareParts: [{ unitId: fx.spareConcurrentUnitId, quantity: '20.0000' }] },
          `${run}-cc-restart-${index + 1}`,
        ),
      ),
    )
    const zipped = orderIds.map((orderId, index) => ({ orderId, reply: replies[index]! }))
    const committedOnes = zipped.filter((z) => z.reply.status === CommandResultStatus.COMMITTED)
    const rejectedOnes = zipped.filter((z) => z.reply.status === CommandResultStatus.BUSINESS_REJECTION)
    expect(committedOnes).toHaveLength(1)
    expect(rejectedOnes).toHaveLength(1)
    expect(rejectedOnes[0]!.reply.errorCode).toBe(ERROR_CODES.INSUFFICIENT_STOCK)
    // 账上不得出现负库存：余额恰 10、issue 流水/分录各恰一行（扣前 30/扣后 10）
    const balance = await pool.query(
      `SELECT quantity::text AS q, status FROM stock_balance WHERE unit_id = $1`,
      [fx.spareConcurrentUnitId],
    )
    expect(balance.rows[0]).toMatchObject({ q: '10.0000', status: 'active' })
    const tx = await pool.query(
      `SELECT before_qty::text AS before_qty, after_qty::text AS after_qty FROM stock_transaction
       WHERE unit_id = $1 AND movement_kind = 'issue'`,
      [fx.spareConcurrentUnitId],
    )
    expect(tx.rows).toHaveLength(1)
    expect(tx.rows[0]).toMatchObject({ before_qty: '30.0000', after_qty: '10.0000' })
    const entry = await pool.query(
      `SELECT quantity_delta::text AS delta, before_qty::text AS before_qty, after_qty::text AS after_qty
       FROM stock_entry WHERE unit_id = $1`,
      [fx.spareConcurrentUnitId],
    )
    expect(entry.rows).toHaveLength(1)
    expect(entry.rows[0]).toMatchObject({ delta: '-20.0000', before_qty: '30.0000', after_qty: '10.0000' })
    // 失败单整单回滚：留在待复机、不写消耗行
    const rejectedOrderId = rejectedOnes[0]!.orderId
    const order = await pool.query(`SELECT status FROM maintenance_order WHERE id = $1`, [rejectedOrderId])
    expect(order.rows[0]!.status).toBe('pending_restart')
    const usage = await pool.query(`SELECT count(*)::int AS c FROM spare_part_usage WHERE unit_id = $1`, [fx.spareConcurrentUnitId])
    expect(usage.rows[0]!.c).toBe(1)
  })
})
