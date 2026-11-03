import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext } from '@cadenza/application'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildQualityCommandBus } from '../../apps/api/src/quality/quality.composition'
import { buildWarehousingCommandBus } from '../../apps/api/src/warehousing/warehousing.composition'
import {
  InMemoryExecutionEventPort,
  QW_TEST_DB_NAME,
  finishedInspectionReleasedEvent,
  prepareQwTestDatabase,
  seedQwFixtures,
  workReportEvent,
  type QwFixtures,
} from '../api/quality-warehousing-test-env'

/**
 * 质量闭环与仓储主链集成（真容器独立库 cadenza_qw + 真实命令总线与真实组合根，
 * ExecutionEventPort 以内存实现注入——L0 整合接线的测试替身，无业务桩）。
 * WorkItem 冻结八类证据之①-⑦（⑧跨厂 403 属 API 层，见 quality-warehousing-api.spec.ts）：
 * ①待检入库后可用量=0，放行后可用（闸门经真实余额查询）
 * ②让步放行保留不合格原结论（版本化断言+库级 S14 触发器）
 * ③两入库入口（任务台账+组单）共用同一记账（余额/流水一致）
 * ④移库校验四拒一成（+移库记录 append-only）
 * ⑤调拨三段状态机+在途两仓不重复统计+完成对账
 * ⑥调拨锁定作业预留过期后旧提交被拒重校验
 * ⑦幂等重放（确认入库/调拨出库同 operationId 原结果回放，不重复入账）
 */

let pool: pg.Pool
let qualityBus: ReturnType<typeof buildQualityCommandBus>
let warehousingBus: ReturnType<typeof buildWarehousingCommandBus>
let inventoryBus: ReturnType<typeof buildInventoryCommandBus>
let adminCtx: CommandContext
let fx: QwFixtures
let dbAvailable = true
const run = `qw${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

const OWNER = '22222222-2222-4222-8222-222222222201'
const OWNER_NAME = '华东电缆集团（自有）'

beforeAll(async () => {
  try {
    pool = await prepareQwTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP quality-warehousing-flow: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${QW_TEST_DB_NAME}）。`)
    return
  }
  fx = await seedQwFixtures(pool) // 幂等 upsert：与 prepare 内夹具同 code 同 id
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  const events = new InMemoryExecutionEventPort([
    workReportEvent({ eventId: `${run}-E1`, plantId: fx.szPlantId, sourceRef: `${run}-WRK-1`, unitNo: 'WRK-U1', materialId: fx.finishedMaterialId, quantity: '100.0000' }),
    workReportEvent({ eventId: `${run}-E2`, plantId: fx.szPlantId, sourceRef: `${run}-WRK-2`, unitNo: 'WRK-U2', materialId: fx.finishedMaterialId, quantity: '80.0000' }),
    workReportEvent({ eventId: `${run}-E3`, plantId: fx.szPlantId, sourceRef: `${run}-WRK-3`, unitNo: 'WRK-U3', materialId: fx.finishedMaterialId, quantity: '30.0000' }),
    workReportEvent({ eventId: `${run}-E4`, plantId: fx.szPlantId, sourceRef: `${run}-WRK-4`, unitNo: 'WRK-U4', materialId: fx.finishedMaterialId, quantity: '50.0000' }),
    workReportEvent({ eventId: `${run}-E5`, plantId: fx.szPlantId, sourceRef: `${run}-WRK-5`, unitNo: 'WRK-U5', materialId: fx.finishedMaterialId, quantity: '100.0000' }),
    workReportEvent({ eventId: `${run}-E6`, plantId: fx.szPlantId, sourceRef: `${run}-WRK-6`, unitNo: 'WRK-U6', materialId: fx.finishedMaterialId, quantity: '40.0000' }),
    workReportEvent({ eventId: `${run}-E7`, plantId: fx.szPlantId, sourceRef: `${run}-WRK-7`, unitNo: 'WRK-U7', materialId: fx.finishedMaterialId, quantity: '40.0000' }),
    workReportEvent({ eventId: `${run}-E8`, plantId: fx.szPlantId, sourceRef: `${run}-WRK-8`, unitNo: 'WRK-U8', materialId: fx.finishedMaterialId, quantity: '60.0000' }),
    workReportEvent({ eventId: `${run}-E9`, plantId: fx.szPlantId, sourceRef: `${run}-WRK-9`, unitNo: 'WRK-U9', materialId: fx.finishedMaterialId, quantity: '25.0000' }),
    finishedInspectionReleasedEvent({ eventId: `${run}-F1`, plantId: fx.szPlantId, sourceRef: `${run}-QI-1`, unitNo: 'WRK-F1', materialId: fx.finishedMaterialId, quantity: '70.0000' }),
  ])
  qualityBus = buildQualityCommandBus(pool, events)
  warehousingBus = buildWarehousingCommandBus(pool, events)
  inventoryBus = buildInventoryCommandBus(pool)
})

afterAll(async () => {
  if (pool) await pool.end() // 独立库每轮 DROP+CREATE 重建，无须细清痕迹
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

let opSeq = 0
function nextOp(tag: string): string {
  opSeq += 1
  return `${run}-${tag}-${opSeq}`
}

function envelope(operationId: string, commandType: string, payload: Record<string, unknown>): CommandEnvelope {
  return { operationId, commandType, targetId: 'new', expectedRevision: 0, payload }
}

type AnyBus =
  | ReturnType<typeof buildQualityCommandBus>
  | ReturnType<typeof buildWarehousingCommandBus>
  | ReturnType<typeof buildInventoryCommandBus>

async function exec(bus: AnyBus, operationId: string, commandType: string, payload: Record<string, unknown>): Promise<CommandResult> {
  return bus.execute(envelope(operationId, commandType, payload), adminCtx)
}

/** 报工事件 → 检验任务 + 待入库任务 + 确认入库（RACK 010101）。任务/检验单按来源幂等键从库定位（端口重跑幂等）。 */
async function putAwayWorkReport(
  eventNo: string,
  unitNo: string,
  opts: { toLocationId?: string } = {},
): Promise<{ orderId: string; taskId: string; unitId: string }> {
  const sourceRef = `${run}-WRK-${eventNo.replace('E', '')}`
  const gen = await exec(qualityBus, nextOp(`gen${eventNo}`), 'quality.inspection.generate', { plantId: fx.szPlantId })
  expect(gen.status).toBe(CommandResultStatus.COMMITTED)
  const refresh = await exec(warehousingBus, nextOp(`rfr${eventNo}`), 'warehousing.putaway.refresh', { plantId: fx.szPlantId })
  expect(refresh.status).toBe(CommandResultStatus.COMMITTED)
  const task = await pool.query<{ id: string }>(`SELECT id FROM putaway_task WHERE source_ref = $1`, [sourceRef])
  expect(task.rows).toHaveLength(1) // A-T13-1：来源幂等（端口重跑不重复生成）
  const confirm = await exec(warehousingBus, nextOp(`cfm${eventNo}`), 'warehousing.putaway.confirm', {
    plantId: fx.szPlantId,
    taskIds: [task.rows[0]!.id],
    toWarehouseId: fx.logisticsWarehouseId,
    toWarehouseKind: 'LOGISTICS',
    toLocationId: opts.toLocationId ?? fx.rackLocationId1,
    toLocationCode: opts.toLocationId === fx.rackLocationId2 ? '010102' : '010101',
    ownerId: OWNER,
    ownerName: OWNER_NAME,
  })
  expect(confirm.status).toBe(CommandResultStatus.COMMITTED)
  const confirmed = (confirm.data as { tasks: Array<{ unitId: string; unitNo: string; sourceRef: string }> }).tasks[0]!
  expect(confirmed.unitNo).toBe(unitNo)
  const order = await pool.query<{ id: string }>(
    `SELECT id FROM quality_inspection_order WHERE source_ref = $1 AND inspection_stage = 'finished'`,
    [sourceRef],
  )
  expect(order.rows).toHaveLength(1)
  return { orderId: order.rows[0]!.id, taskId: task.rows[0]!.id, unitId: confirmed.unitId }
}

describe('① 待检入库后可用量=0，放行后可用（A-T12-2/IT-14 闸门经真实余额查询）', () => {
  let unitId = ''
  let orderId = ''

  it('报工事件 → 检验任务 + 待入库 → 确认入库（work_report 来源 → 待检不可用）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const placed = await putAwayWorkReport('E1', 'WRK-U1')
    unitId = placed.unitId
    orderId = placed.orderId
    const balance = await pool.query<{ quality_status: string; quantity: string }>(
      `SELECT quality_status, quantity::text AS quantity FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
      [unitId],
    )
    expect(balance.rows[0]!.quality_status).toBe('pending_inspection')
    expect(balance.rows[0]!.quantity).toBe('100.0000')
  })

  it('待检余额发料 → BUSINESS_REJECTION ERR_INSUFFICIENT_STOCK（信息含 IT-14）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const rejected = await exec(inventoryBus, nextOp('iss1r'), 'inventory.issue-material', { unitId, quantity: '5.0000', reason: '待检发料应拒' })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorCode).toBe(ERROR_CODES.INSUFFICIENT_STOCK)
    expect(rejected.errorMessage).toContain('IT-14')
  })

  it('实测提交（合格 v2）→ 判定放行 → 发料成功（合格余额可用）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const submit = await exec(qualityBus, nextOp('sub1'), 'quality.test-result.submit', {
      inspectionOrderId: orderId,
      conclusion: 'qualified',
      items: [{ itemNo: 'T1', itemName: '外径', measuredValue: '3.2000', judgement: 'pass' }],
    })
    expect(submit.status).toBe(CommandResultStatus.COMMITTED)
    expect((submit.data as { version: number; historyPreserved: number }).version).toBe(2)
    const release = await exec(qualityBus, nextOp('rel1'), 'quality.disposition.release', { inspectionOrderId: orderId, reason: '成品检验合格放行' })
    expect(release.status).toBe(CommandResultStatus.COMMITTED)
    expect((release.data as { dispositionKind: string }).dispositionKind).toBe('release')
    const issued = await exec(inventoryBus, nextOp('iss1'), 'inventory.issue-material', { unitId, quantity: '5.0000', reason: '放行后发料' })
    expect(issued.status).toBe(CommandResultStatus.COMMITTED)
    expect((issued.data as { afterQty: string }).afterQty).toBe('95.0000')
    const balance = await pool.query<{ quality_status: string }>(
      `SELECT quality_status FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
      [unitId],
    )
    expect(balance.rows[0]!.quality_status).toBe('qualified')
  })
})

describe('② 让步放行保留不合格原结论（A-T12-1 版本化断言）', () => {
  let unitId = ''
  let orderId = ''

  it('不合格结论 → 让步放行 → 库存可用，生效结论仍为不合格（原事实保留）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const placed = await putAwayWorkReport('E2', 'WRK-U2')
    unitId = placed.unitId
    orderId = placed.orderId
    // 不合格结论 v2
    const submit = await exec(qualityBus, nextOp('sub2'), 'quality.test-result.submit', {
      inspectionOrderId: orderId,
      conclusion: 'unqualified',
      items: [{ itemNo: 'T1', measuredValue: '3.9000', judgement: 'fail' }],
    })
    expect(submit.status).toBe(CommandResultStatus.COMMITTED)
    // 让步放行（basedOnVersion=2）
    const concession = await exec(qualityBus, nextOp('cnc2'), 'quality.disposition.concession', {
      inspectionOrderId: orderId,
      basedOnVersion: 2,
      reason: '客户让步接收，降级使用',
    })
    expect(concession.status).toBe(CommandResultStatus.COMMITTED)
    expect((concession.data as { originalConclusionPreserved: string }).originalConclusionPreserved).toBe('unqualified')
    // 库存可用（qualified）：发料成功
    const issued = await exec(inventoryBus, nextOp('iss2'), 'inventory.issue-material', { unitId, quantity: '10.0000', reason: '让步放行后发料' })
    expect(issued.status).toBe(CommandResultStatus.COMMITTED)
    // 版本化断言：生效结论行仍为 unqualified（原不合格事实保留，S14）
    const effective = await pool.query<{ version: number; conclusion: string; result_kind: string }>(
      `SELECT version, conclusion, result_kind FROM quality_test_result WHERE inspection_order_id = $1 AND is_effective`,
      [orderId],
    )
    expect(effective.rows[0]!.version).toBe(2)
    expect(effective.rows[0]!.conclusion).toBe('unqualified')
    // 处置记录显式引用原结论版本
    const disposition = await pool.query<{ disposition_kind: string; based_on_version: number }>(
      `SELECT disposition_kind, based_on_version FROM quality_disposition WHERE inspection_order_id = $1`,
      [orderId],
    )
    expect(disposition.rows[0]!.disposition_kind).toBe('concession')
    expect(disposition.rows[0]!.based_on_version).toBe(2)
    // 重复处置拒绝
    const again = await exec(qualityBus, nextOp('rel2'), 'quality.disposition.release', { inspectionOrderId: orderId })
    expect(again.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
  })

  it('库级 S14：UPDATE 生效结论事实列被触发器拒绝（A-T12-S14）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM quality_test_result WHERE inspection_order_id = $1 AND is_effective`,
      [orderId],
    )
    await expect(pool.query(`UPDATE quality_test_result SET conclusion = 'qualified' WHERE id = $1`, [row.rows[0]!.id])).rejects.toThrow(/A-T12-S14/)
    await expect(pool.query(`DELETE FROM quality_test_result WHERE id = $1`, [row.rows[0]!.id])).rejects.toThrow(/A-T12-S14/)
  })
})

describe('③ 两入库入口（任务台账+组单）共用同一记账（A-T13-1；余额/流水一致）', () => {
  it('台账逐任务确认 与 组单按单元确认：同一 receive 记账（ref_type=putaway_task），Σ余额=Σ任务量', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // E3/E4（work_report）+ F1（成品质检放行）任务已由①的 refresh 幂等生成（端口重跑）——再跑 refresh 断言幂等跳过
    const refresh = await exec(warehousingBus, nextOp('rfr3'), 'warehousing.putaway.refresh', { plantId: fx.szPlantId })
    expect(refresh.status).toBe(CommandResultStatus.COMMITTED)
    expect((refresh.data as { skipped: number }).skipped).toBe(10) // 全部事件已建任务，重跑零新增
    const created = [
      ...(await pool.query<{ id: string; source_ref: string; source_type: string }>(
        `SELECT id, source_ref, source_type FROM putaway_task WHERE source_ref = ANY($1::text[])`,
        [[`${run}-WRK-3`, `${run}-WRK-4`, `${run}-QI-1`]],
      )).rows,
    ]
    expect(created.length).toBe(3)
    const t3 = created.find((t) => t.source_ref === `${run}-WRK-3`)!
    // 台账入口：按 taskId 确认
    const byTask = await exec(warehousingBus, nextOp('cfm3a'), 'warehousing.putaway.confirm', {
      plantId: fx.szPlantId,
      taskIds: [t3.id],
      toWarehouseId: fx.logisticsWarehouseId,
      toWarehouseKind: 'LOGISTICS',
      toLocationId: fx.rackLocationId1,
      toLocationCode: '010101',
      ownerId: OWNER,
      ownerName: OWNER_NAME,
    })
    expect(byTask.status).toBe(CommandResultStatus.COMMITTED)
    // 组单入口：按单元号组单确认（E4）
    const byGroup = await exec(warehousingBus, nextOp('cfm3b'), 'warehousing.putaway.confirm', {
      plantId: fx.szPlantId,
      unitNos: ['WRK-U4'],
      toWarehouseId: fx.logisticsWarehouseId,
      toWarehouseKind: 'LOGISTICS',
      toLocationId: fx.rackLocationId1,
      toLocationCode: '010101',
      ownerId: OWNER,
      ownerName: OWNER_NAME,
    })
    expect(byGroup.status).toBe(CommandResultStatus.COMMITTED)
    // 成品质检放行来源（F1）：确认后直接合格可用（证据①对偶路径）
    const f1 = created.find((t) => t.source_ref === `${run}-QI-1`)!
    const byReleased = await exec(warehousingBus, nextOp('cfm3c'), 'warehousing.putaway.confirm', {
      plantId: fx.szPlantId,
      taskIds: [f1.id],
      toWarehouseId: fx.logisticsWarehouseId,
      toWarehouseKind: 'LOGISTICS',
      toLocationId: fx.rackLocationId1,
      toLocationCode: '010101',
      ownerId: OWNER,
      ownerName: OWNER_NAME,
    })
    expect(byReleased.status).toBe(CommandResultStatus.COMMITTED)
    // 同一记账断言：三单元流水均为 receive + ref_type=putaway_task + line_no=1（组单内单任务）
    const tasks = [...(byTask.data as { tasks: Array<{ unitId: string }> }).tasks, ...(byGroup.data as { tasks: Array<{ unitId: string }> }).tasks, ...(byReleased.data as { tasks: Array<{ unitId: string; unitNo: string }> }).tasks]
    for (const t of tasks) {
      const tx = await pool.query<{ movement_kind: string; ref_type: string; line_no: number; after_qty: string }>(
        `SELECT movement_kind, ref_type, line_no, after_qty::text AS after_qty FROM stock_transaction WHERE unit_id = $1`,
        [t.unitId],
      )
      expect(tx.rows).toHaveLength(1)
      expect(tx.rows[0]!.movement_kind).toBe('receive')
      expect(tx.rows[0]!.ref_type).toBe('putaway_task')
      expect(tx.rows[0]!.line_no).toBe(1)
    }
    // 余额合计 = 30 + 50 + 70；来源质量投影：报工→待检，成品质检放行→合格
    const balances = await pool.query<{ unit_id: string; quantity: string; quality_status: string }>(
      `SELECT unit_id, quantity::text AS quantity, quality_status FROM stock_balance WHERE unit_id = ANY($1::uuid[]) AND status = 'active'`,
      [tasks.map((t) => t.unitId)],
    )
    const total = balances.rows.reduce((s, b) => s + Number(b.quantity), 0)
    expect(total).toBeCloseTo(150, 4)
    const bySource = new Map(balances.rows.map((b) => [b.unit_id, b.quality_status]))
    expect(bySource.get((byTask.data as { tasks: Array<{ unitId: string }> }).tasks[0]!.unitId)).toBe('pending_inspection')
    expect(bySource.get((byReleased.data as { tasks: Array<{ unitId: string }> }).tasks[0]!.unitId)).toBe('qualified')
  })
})

describe('④ 移库校验四拒一成（A-T13-4）+ 移库记录 append-only', () => {
  let unitId = ''

  beforeAll(async () => {
    if (!dbAvailable) return
    const placed = await putAwayWorkReport('E5', 'WRK-U5')
    unitId = placed.unitId
  })

  it('拒：异仓库位（跨仓走调拨）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const rejected = await exec(warehousingBus, nextOp('mv5x'), 'warehousing.move.execute', {
      plantId: fx.szPlantId,
      unitId,
      toLocationId: fx.lineSideLocationId,
      toLocationCode: '91020101',
      reason: '异仓应拒',
    })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorMessage).toContain('A-T13-4')
    expect(rejected.errorMessage).toContain('同一仓库')
  })

  it('拒：原库位=新库位', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const rejected = await exec(warehousingBus, nextOp('mv5y'), 'warehousing.move.execute', {
      plantId: fx.szPlantId,
      unitId,
      toLocationId: fx.rackLocationId1,
      toLocationCode: '010101',
    })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorMessage).toContain('A-T13-4')
  })

  it('拒：码被其它业务锁定（活动作业预留）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const acquire = await exec(inventoryBus, nextOp('rsv5'), 'inventory.reservation.acquire', {
      unitId,
      quantity: '10.0000',
      holderType: 'manual',
      holderRef: 'other-task',
      validUntil: new Date(Date.now() + 3600_000).toISOString(),
    })
    expect(acquire.status).toBe(CommandResultStatus.COMMITTED)
    const rejected = await exec(warehousingBus, nextOp('mv5z'), 'warehousing.move.execute', {
      plantId: fx.szPlantId,
      unitId,
      toLocationId: fx.rackLocationId2,
      toLocationCode: '010102',
    })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorMessage).toContain('A-T13-4')
    const release = await exec(inventoryBus, nextOp('rsv5r'), 'inventory.reservation.release', {
      reservationId: (acquire.data as { reservationId: string }).reservationId,
      releaseReason: '测试释放',
    })
    expect(release.status).toBe(CommandResultStatus.COMMITTED)
  })

  it('成：同仓+未锁+在库+异库位 → 移库成功并生成移库记录（原/现库位逐码）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const moved = await exec(warehousingBus, nextOp('mv5'), 'warehousing.move.execute', {
      plantId: fx.szPlantId,
      unitId,
      toLocationId: fx.rackLocationId2,
      toLocationCode: '010102',
      reason: '货架整理',
    })
    expect(moved.status).toBe(CommandResultStatus.COMMITTED)
    expect((moved.data as { toAfter: string }).toAfter).toBe('100.0000')
    const balance = await pool.query<{ location_id: string; quantity: string }>(
      `SELECT location_id, quantity::text AS quantity FROM stock_balance WHERE unit_id = $1 AND status = 'active'`,
      [unitId],
    )
    expect(balance.rows).toHaveLength(1)
    expect(balance.rows[0]!.location_id).toBe(fx.rackLocationId2)
    const moveRow = await pool.query<{ from_location_code: string; to_location_code: string; quantity: string }>(
      `SELECT from_location_code, to_location_code, quantity::text AS quantity FROM warehouse_move WHERE inventory_unit_id = $1`,
      [unitId],
    )
    expect(moveRow.rows).toHaveLength(1)
    expect(moveRow.rows[0]!.from_location_code).toBe('010101')
    expect(moveRow.rows[0]!.to_location_code).toBe('010102')
    expect(moveRow.rows[0]!.quantity).toBe('100.0000')
    // 移库流水两行（move：原库位减、现库位增，含扣前/扣后）
    const tx = await pool.query<{ movement_kind: string }>(
      `SELECT movement_kind FROM stock_transaction WHERE unit_id = $1 AND movement_kind = 'move'`,
      [unitId],
    )
    expect(tx.rows).toHaveLength(2)
  })

  it('拒：码不在库（在途）；移库记录 append-only（DELETE 触发器拒）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const placed = await putAwayWorkReport('E6', 'WRK-U6')
    const out = await exec(inventoryBus, nextOp('to6'), 'inventory.transfer.out', {
      unitId: placed.unitId,
      quantity: '40.0000',
      transitLocationId: fx.transitLocationId,
      transitLocationCode: '91900101',
    })
    expect(out.status).toBe(CommandResultStatus.COMMITTED)
    const rejected = await exec(warehousingBus, nextOp('mv6'), 'warehousing.move.execute', {
      plantId: fx.szPlantId,
      unitId: placed.unitId,
      toLocationId: fx.rackLocationId2,
      toLocationCode: '010102',
    })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorMessage).toContain('A-T13-4')
    // append-only：移库事实禁改禁删（纠正走反向移库）
    const moveRow = await pool.query<{ id: string }>(`SELECT id FROM warehouse_move LIMIT 1`)
    await expect(pool.query(`DELETE FROM warehouse_move WHERE id = $1`, [moveRow.rows[0]!.id])).rejects.toThrow(/A-T13-4/)
  })
})

describe('⑤ 调拨三段状态机 + 在途两仓不重复统计 + 完成对账（A-T13-6/7/8/9/10）', () => {
  let orderId = ''
  let line1Id = ''
  let line2Id = ''
  let unit7 = ''
  let unit8 = ''

  beforeAll(async () => {
    if (!dbAvailable) return
    const placed7 = await putAwayWorkReport('E7', 'WRK-U7')
    const placed8 = await putAwayWorkReport('E8', 'WRK-U8')
    unit7 = placed7.unitId
    unit8 = placed8.unitId
    // 质量放行（A-T12-4 闸门：待检禁出库）
    for (const orderIdQ of [placed7.orderId, placed8.orderId]) {
      const submit = await exec(qualityBus, nextOp('sub5'), 'quality.test-result.submit', {
        inspectionOrderId: orderIdQ,
        conclusion: 'qualified',
        items: [{ itemNo: 'T1', measuredValue: '3.2000', judgement: 'pass' }],
      })
      expect(submit.status).toBe(CommandResultStatus.COMMITTED)
      const release = await exec(qualityBus, nextOp('rel5'), 'quality.disposition.release', { inspectionOrderId: orderIdQ })
      expect(release.status).toBe(CommandResultStatus.COMMITTED)
    }
  })

  it('create（草稿）→ submit（待执行+锁定预留）→ 逐行 ship（出库中→全出）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const create = await exec(warehousingBus, nextOp('to5c'), 'warehousing.transfer.create', {
      plantId: fx.szPlantId,
      transferKind: 'warehouse',
      fromWarehouseId: fx.logisticsWarehouseId,
      toWarehouseId: fx.targetWarehouseId,
      transitLocationId: fx.transitLocationId,
      transitLocationCode: '91900101',
      lines: [
        { unitId: unit7, unitNo: 'WRK-U7', quantity: '40.0000', materialId: fx.finishedMaterialId, materialType: 3 },
        { unitId: unit8, unitNo: 'WRK-U8', quantity: '60.0000', materialId: fx.finishedMaterialId, materialType: 3 },
      ],
    })
    expect(create.status).toBe(CommandResultStatus.COMMITTED)
    orderId = (create.data as { orderId: string }).orderId
    expect((create.data as { status: string }).status).toBe('draft')
    // 调入=调出被拒（A-T13-6 库级+域级双保险）
    const sameWh = await exec(warehousingBus, nextOp('to5x'), 'warehousing.transfer.create', {
      plantId: fx.szPlantId,
      transferKind: 'warehouse',
      fromWarehouseId: fx.logisticsWarehouseId,
      toWarehouseId: fx.logisticsWarehouseId,
      transitLocationId: fx.transitLocationId,
      transitLocationCode: '91900101',
      lines: [{ unitId: unit7, unitNo: 'WRK-U7', quantity: '40.0000', materialType: 3 }],
    })
    expect(sameWh.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(sameWh.errorMessage).toContain('A-T13-6')

    const submit = await exec(warehousingBus, nextOp('to5s'), 'warehousing.transfer.submit', {
      transferOrderId: orderId,
      lockValidUntil: new Date(Date.now() + 3600_000).toISOString(),
    })
    expect(submit.status).toBe(CommandResultStatus.COMMITTED)
    expect((submit.data as { status: string }).status).toBe('ready')
    const lines = (await pool.query<{ id: string; line_no: number; reservation_id: string | null }>(
      `SELECT id, line_no, reservation_id FROM transfer_order_line WHERE transfer_order_id = $1 ORDER BY line_no`,
      [orderId],
    )).rows
    expect(lines).toHaveLength(2)
    expect(lines[0]!.reservation_id).not.toBeNull()
    expect(lines[1]!.reservation_id).not.toBeNull()
    line1Id = lines[0]!.id
    line2Id = lines[1]!.id

    // 出库段：逐行（每行一个原子命令：来源减+在途增 两行流水一个事务）
    const ship1 = await exec(warehousingBus, nextOp('to5h1'), 'warehousing.transfer.ship', { transferOrderId: orderId, lineId: line1Id })
    expect(ship1.status).toBe(CommandResultStatus.COMMITTED)
    expect((ship1.data as { status: string }).status).toBe('shipping')
    const ship2 = await exec(warehousingBus, nextOp('to5h2'), 'warehousing.transfer.ship', { transferOrderId: orderId, lineId: line2Id })
    expect(ship2.status).toBe(CommandResultStatus.COMMITTED)
    // 两行流水/单元（transfer_out：来源减+在途增，IT-25 两段原子）
    const tx = await pool.query<{ movement_kind: string }>(
      `SELECT movement_kind FROM stock_transaction WHERE unit_id = ANY($1::uuid[]) AND movement_kind = 'transfer_out'`,
      [[unit7, unit8]],
    )
    expect(tx.rows).toHaveLength(4)
  })

  it('transit（在途段）：已出库在途 + 对账（在途量只挂专用库位，两仓不重复统计）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const transit = await exec(warehousingBus, nextOp('to5t'), 'warehousing.transfer.transit', { transferOrderId: orderId })
    expect(transit.status).toBe(CommandResultStatus.COMMITTED)
    expect((transit.data as { status: string }).status).toBe('shipped_in_transit')
    const rec = (transit.data as { reconciliation: Record<string, string> }).reconciliation
    expect(rec['transitQty']).toBe('100.0000')
    expect(Number(rec['fromWarehouseRemainQty'])).toBe(0)
    expect(Number(rec['toWarehouseQty'])).toBe(0)
    // 在途两仓不重复统计（SQL 直查：两仓普通库位上该二单元活动余额=0；在途库位=100）
    const doubleCount = await pool.query<{ qty: string }>(
      `SELECT COALESCE(SUM(b.quantity), 0)::text AS qty FROM stock_balance b
       JOIN storage_location l ON l.id = b.location_id
       WHERE b.unit_id = ANY($1::uuid[]) AND b.status = 'active' AND l.warehouse_id IN ($2::uuid, $3::uuid)`,
      [[unit7, unit8], fx.logisticsWarehouseId, fx.targetWarehouseId],
    )
    expect(Number(doubleCount.rows[0]!.qty)).toBe(0)
    const onTransit = await pool.query<{ qty: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::text AS qty FROM stock_balance WHERE unit_id = ANY($1::uuid[]) AND location_id = $2 AND status = 'active'`,
      [[unit7, unit8], fx.transitLocationId],
    )
    expect(onTransit.rows[0]!.qty).toBe('100.0000')
  })

  it('receive（接收段）：收货中 → 完成（完成对账：在途清零、目标仓全额）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const recv1 = await exec(warehousingBus, nextOp('to5r1'), 'warehousing.transfer.receive', {
      transferOrderId: orderId,
      lineId: line1Id,
      toLocationId: fx.targetLocationId,
      toLocationCode: '91030101',
    })
    expect(recv1.status).toBe(CommandResultStatus.COMMITTED)
    expect((recv1.data as { status: string }).status).toBe('receiving')
    const recv2 = await exec(warehousingBus, nextOp('to5r2'), 'warehousing.transfer.receive', {
      transferOrderId: orderId,
      lineId: line2Id,
      toLocationId: fx.targetLocationId,
      toLocationCode: '91030101',
    })
    expect(recv2.status).toBe(CommandResultStatus.COMMITTED)
    expect((recv2.data as { status: string }).status).toBe('completed')
    // 完成对账：目标仓库位 40+60=100、在途库位 0、单元回在库
    const target = await pool.query<{ qty: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::text AS qty FROM stock_balance WHERE unit_id = ANY($1::uuid[]) AND location_id = $2 AND status = 'active'`,
      [[unit7, unit8], fx.targetLocationId],
    )
    expect(target.rows[0]!.qty).toBe('100.0000')
    const transit = await pool.query<{ qty: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::text AS qty FROM stock_balance WHERE unit_id = ANY($1::uuid[]) AND location_id = $2 AND status = 'active'`,
      [[unit7, unit8], fx.transitLocationId],
    )
    expect(Number(transit.rows[0]!.qty)).toBe(0)
    const units = await pool.query<{ status: string }>(
      `SELECT status FROM inventory_unit WHERE id = ANY($1::uuid[])`,
      [[unit7, unit8]],
    )
    expect(units.rows.every((u) => u.status === 'in_stock')).toBe(true)
    // 状态机轨迹与两段事实行
    const order = await pool.query<{ status: string; completed_at: Date | null }>(
      `SELECT status, completed_at FROM transfer_order WHERE id = $1`,
      [orderId],
    )
    expect(order.rows[0]!.status).toBe('completed')
    expect(order.rows[0]!.completed_at).not.toBeNull()
    const lines = await pool.query<{ out_qty: string; in_qty: string; out_done: boolean; in_done: boolean }>(
      `SELECT out_qty::text AS out_qty, in_qty::text AS in_qty, out_done, in_done FROM transfer_order_line WHERE transfer_order_id = $1`,
      [orderId],
    )
    expect(lines.rows[0]!.out_qty).toBe('40.0000')
    expect(lines.rows[0]!.in_qty).toBe('40.0000')
    expect(lines.rows[1]!.out_qty).toBe('60.0000')
    expect(lines.rows[1]!.in_qty).toBe('60.0000')
    expect(lines.rows.every((l) => l.out_done && l.in_done)).toBe(true)
    // 接收段流水两行/单元（transfer_in）
    const txIn = await pool.query<{ movement_kind: string }>(
      `SELECT movement_kind FROM stock_transaction WHERE unit_id = ANY($1::uuid[]) AND movement_kind = 'transfer_in'`,
      [[unit7, unit8]],
    )
    expect(txIn.rows).toHaveLength(4)
  })

  it('状态机乱步拒绝：completed 不可再出库', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const rejected = await exec(warehousingBus, nextOp('to5z'), 'warehousing.transfer.ship', { transferOrderId: orderId, lineId: line1Id })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorMessage).toContain('A-T13-10')
  })
})

describe('⑥ 调拨锁定作业预留过期后旧提交被拒重校验（A-T13-11/IT-23）', () => {
  it('短有效期锁定 → 过期后 ship 被拒 → 重新锁定后 ship 成功', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const placed = await putAwayWorkReport('E9', 'WRK-U9')
    const submitQ = await exec(qualityBus, nextOp('sub6'), 'quality.test-result.submit', {
      inspectionOrderId: placed.orderId,
      conclusion: 'qualified',
      items: [{ itemNo: 'T1', measuredValue: '3.2000', judgement: 'pass' }],
    })
    expect(submitQ.status).toBe(CommandResultStatus.COMMITTED)
    const releaseQ = await exec(qualityBus, nextOp('rel6'), 'quality.disposition.release', { inspectionOrderId: placed.orderId })
    expect(releaseQ.status).toBe(CommandResultStatus.COMMITTED)

    const create = await exec(warehousingBus, nextOp('to6c'), 'warehousing.transfer.create', {
      plantId: fx.szPlantId,
      transferKind: 'warehouse',
      fromWarehouseId: fx.logisticsWarehouseId,
      toWarehouseId: fx.targetWarehouseId,
      transitLocationId: fx.transitLocationId,
      transitLocationCode: '91900101',
      lines: [{ unitId: placed.unitId, unitNo: 'WRK-U9', quantity: '25.0000', materialId: fx.finishedMaterialId, materialType: 3 }],
    })
    expect(create.status).toBe(CommandResultStatus.COMMITTED)
    const orderId = (create.data as { orderId: string }).orderId
    const lineId = (await pool.query<{ id: string }>(`SELECT id FROM transfer_order_line WHERE transfer_order_id = $1`, [orderId])).rows[0]!.id
    // 签发 400ms 短有效期锁定（作业预留）
    const submit = await exec(warehousingBus, nextOp('to6s'), 'warehousing.transfer.submit', {
      transferOrderId: orderId,
      lockValidUntil: new Date(Date.now() + 400).toISOString(),
    })
    expect(submit.status).toBe(CommandResultStatus.COMMITTED)
    await new Promise((r) => setTimeout(r, 500)) // 锁定过期
    const staleShip = await exec(warehousingBus, nextOp('to6h0'), 'warehousing.transfer.ship', { transferOrderId: orderId, lineId })
    expect(staleShip.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(staleShip.errorMessage).toContain('A-T13-11')
    expect(staleShip.errorMessage).toContain('重新校验')
    // 重新锁定（刷新有效期）后提交成功——过期后须重新校验/重新锁定，不得凭旧锁定入账
    const resubmit = await exec(warehousingBus, nextOp('to6s2'), 'warehousing.transfer.submit', {
      transferOrderId: orderId,
      lockValidUntil: new Date(Date.now() + 3600_000).toISOString(),
    })
    expect(resubmit.status).toBe(CommandResultStatus.COMMITTED)
    const ship = await exec(warehousingBus, nextOp('to6h'), 'warehousing.transfer.ship', { transferOrderId: orderId, lineId })
    expect(ship.status).toBe(CommandResultStatus.COMMITTED)
    expect((ship.data as { outQty: string }).outQty).toBe('25.0000')
  })
})

describe('⑦ 幂等重放（IT-21：同 operationId 原结果回放，不重复入账）', () => {
  it('确认入库同 opId+同载荷重放 → 原结果回放；任务/单元/流水零重复', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 证据① 的确认入库命令 opId（putAwayWorkReport('E1') 的 cfm 步：gen=1、rfr=2、cfm=3）
    const replayOpId = `${run}-cfmE1-3`
    const replay = await exec(warehousingBus, replayOpId, 'warehousing.putaway.confirm', {
      plantId: fx.szPlantId,
      taskIds: [await findTaskId(`${run}-WRK-1`)],
      toWarehouseId: fx.logisticsWarehouseId,
      toWarehouseKind: 'LOGISTICS',
      toLocationId: fx.rackLocationId1,
      toLocationCode: '010101',
      ownerId: OWNER,
      ownerName: OWNER_NAME,
    })
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect((replay.data as { confirmed: number }).confirmed).toBe(1) // 原结果回放
    // 重放不重复入账：WRK-U1 仅 1 个单元；流水仅 ① 的 receive+issue 各 1 行，零新增
    const unitCount = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM inventory_unit WHERE unit_no = 'WRK-U1'`,
    )
    expect(unitCount.rows[0]!.total).toBe('1')
    const txCount = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM stock_transaction t JOIN inventory_unit u ON u.id = t.unit_id WHERE u.unit_no = 'WRK-U1'`,
    )
    expect(txCount.rows[0]!.total).toBe('2')
    // 任务仍单行 done
    const taskCount = await pool.query<{ total: string; status: string }>(
      `SELECT count(*)::text AS total, max(status) AS status FROM putaway_task WHERE source_ref = $1`,
      [`${run}-WRK-1`],
    )
    expect(taskCount.rows[0]!.total).toBe('1')
    expect(taskCount.rows[0]!.status).toBe('done')
  })

  it('调拨出库同 opId+同载荷重放 → 原结果；流水行数不变', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const unit7No = await pool.query<{ id: string }>(`SELECT id FROM inventory_unit WHERE unit_no = 'WRK-U7'`)
    const line = await pool.query<{ order_id: string; id: string }>(
      `SELECT t.transfer_order_id AS order_id, t.id FROM transfer_order_line t WHERE t.inventory_unit_id = $1`,
      [unit7No.rows[0]!.id],
    )
    const opId = await pool.query<{ operation_id: string }>(
      `SELECT operation_id FROM command_receipt
       WHERE command_type = 'warehousing.transfer.ship' AND result->'data'->>'lineId' = $1
       LIMIT 1`,
      [line.rows[0]!.id],
    )
    expect(opId.rows).toHaveLength(1)
    const before = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM stock_transaction WHERE unit_id = $1`,
      [unit7No.rows[0]!.id],
    )
    const replay = await exec(warehousingBus, opId.rows[0]!.operation_id, 'warehousing.transfer.ship', {
      transferOrderId: line.rows[0]!.order_id,
      lineId: line.rows[0]!.id,
    })
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect((replay.data as { outQty: string }).outQty).toBe('40.0000') // 原结果回放
    const after = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM stock_transaction WHERE unit_id = $1`,
      [unit7No.rows[0]!.id],
    )
    expect(after.rows[0]!.total).toBe(before.rows[0]!.total)
  })
})

async function findTaskId(sourceRef: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM putaway_task WHERE source_ref = $1`, [sourceRef])
  return r.rows[0]!.id
}

describe('⑧ D-2 回归：报工来源组单入库=既有单元移位（S03 两入口同一记账，不新建单元不双计）', () => {
  const prduUnitNo = `PRDU-${run}-D2R8`
  const sourceRef = `${run}-WRK-10`
  const confirmOpId = `${run}-cfmD2-1`

  async function confirmWith(bus: ReturnType<typeof buildWarehousingCommandBus>, operationId: string) {
    return exec(bus, operationId, 'warehousing.putaway.confirm', {
      plantId: fx.szPlantId,
      taskIds: [await findTaskId(sourceRef)],
      toWarehouseId: fx.logisticsWarehouseId,
      toWarehouseKind: 'LOGISTICS',
      toLocationId: fx.rackLocationId1,
      toLocationCode: '010101',
      ownerId: OWNER,
      ownerName: OWNER_NAME,
    })
  }

  it('报工产出（线边在库单元）→ 组单确认 → 既有单元移位到目标库位（身份/批次/质量态保留，move 流水 ref=任务）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 报工产出落线边：经真实 receiveGoods（与 execution postApproval 同一记账服务）产出 qualified 单元
    const recv = await exec(inventoryBus, nextOp('rcv8'), 'inventory.receive-goods', {
      plantId: fx.szPlantId,
      lotNo: `LOT-${run}-PRD8`,
      unitNo: prduUnitNo,
      materialId: fx.finishedMaterialId,
      materialCode: 'MAT-QW-FIN',
      uomId: fx.uomId,
      uomCode: 'KG',
      quantity: '120.0000',
      measurementBasis: 'nominal',
      locationId: fx.lineSideLocationId,
      locationCode: '91020101',
      ownerId: OWNER,
      ownerName: OWNER_NAME,
      qualityStatus: 'qualified',
    })
    expect(recv.status).toBe(CommandResultStatus.COMMITTED)
    const unitId = String((recv.data as { unitId: string }).unitId)
    const lotId = String((recv.data as { lotId: string }).lotId)

    // 报工确认事件 unitNo=既有线边单元号（PgExecutionEventPort 同口径映射）→ 任务 → 组单确认
    const events = new InMemoryExecutionEventPort([
      workReportEvent({ eventId: `${run}-E10`, plantId: fx.szPlantId, sourceRef, unitNo: prduUnitNo, materialId: fx.finishedMaterialId, quantity: '120.0000' }),
    ])
    const bus = buildWarehousingCommandBus(pool, events)
    const refresh = await exec(bus, nextOp('rfr8'), 'warehousing.putaway.refresh', { plantId: fx.szPlantId })
    expect(refresh.status).toBe(CommandResultStatus.COMMITTED)
    expect((refresh.data as { created: unknown[] }).created).toHaveLength(1)

    const confirm = await confirmWith(bus, confirmOpId)
    expect(confirm.status).toBe(CommandResultStatus.COMMITTED)
    const confirmed = (confirm.data as { tasks: Array<{ unitId: string; unitNo: string }> }).tasks[0]!
    expect(confirmed.unitId).toBe(unitId) // 既有单元（不新建）
    expect(confirmed.unitNo).toBe(prduUnitNo)

    // 单元身份唯一：同号仅 1 行；批次/谱系保留（无新批次）
    const unitCount = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM inventory_unit WHERE unit_no = $1`,
      [prduUnitNo],
    )
    expect(unitCount.rows[0]!.total).toBe('1')
    const unitRow = await pool.query<{ lot_id: string; status: string }>(
      `SELECT lot_id::text, status FROM inventory_unit WHERE id = $1`,
      [unitId],
    )
    expect(unitRow.rows[0]!.lot_id).toBe(lotId)
    expect(unitRow.rows[0]!.status).toBe('in_stock')

    // 余额：目标库位 120 qualified（质量态随移位保留）；线边余额关闭归零（不双计库存）
    const balances = await pool.query<{ location_id: string; quantity: string; quality_status: string; status: string }>(
      `SELECT location_id::text, quantity::text, quality_status, status FROM stock_balance WHERE unit_id = $1`,
      [unitId],
    )
    const active = balances.rows.filter((b) => b.status === 'active')
    expect(active).toHaveLength(1)
    expect(active[0]!.location_id).toBe(fx.rackLocationId1)
    expect(active[0]!.quantity).toBe('120.0000')
    expect(active[0]!.quality_status).toBe('qualified')
    const lineSide = balances.rows.find((b) => b.location_id === fx.lineSideLocationId)
    expect(lineSide?.status).toBe('closed')
    expect(lineSide?.quantity).toBe('0.0000')

    // 流水：move 两行（原/现库位）且 ref_type=putaway_task/ref_id=任务；无 receive 新单元流水
    const taskId = await findTaskId(sourceRef)
    const tx = await pool.query<{ movement_kind: string; ref_type: string; ref_id: string }>(
      `SELECT movement_kind, ref_type, ref_id::text AS ref_id FROM stock_transaction WHERE unit_id = $1 ORDER BY id`,
      [unitId],
    )
    const moves = tx.rows.filter((t) => t.movement_kind === 'move')
    expect(moves).toHaveLength(2)
    expect(moves.every((t) => t.ref_type === 'putaway_task' && t.ref_id === taskId)).toBe(true)
    expect(tx.rows.some((t) => t.movement_kind === 'receive' && t.ref_type === 'putaway_task')).toBe(false)

    // 任务台账回填：done + inventory_unit_id=既有单元
    const task = await pool.query<{ status: string; inventory_unit_id: string }>(
      `SELECT status, inventory_unit_id::text FROM putaway_task WHERE id = $1`,
      [taskId],
    )
    expect(task.rows[0]!.status).toBe('done')
    expect(task.rows[0]!.inventory_unit_id).toBe(unitId)
  })

  it('重复确认幂等：同 operationId 原结果回放不重复移位；新 operationId 再确认被拒（仅 pending 可确认）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const bus = buildWarehousingCommandBus(
      pool,
      new InMemoryExecutionEventPort([
        workReportEvent({ eventId: `${run}-E10`, plantId: fx.szPlantId, sourceRef, unitNo: prduUnitNo, materialId: fx.finishedMaterialId, quantity: '120.0000' }),
      ]),
    )
    const before = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM stock_transaction t JOIN inventory_unit u ON u.id = t.unit_id WHERE u.unit_no = $1 AND t.movement_kind = 'move'`,
      [prduUnitNo],
    )
    // 同 operationId 重放：原结果回放（confirmed=1），流水零新增
    const replay = await confirmWith(bus, confirmOpId)
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect((replay.data as { confirmed: number }).confirmed).toBe(1)
    const afterReplay = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM stock_transaction t JOIN inventory_unit u ON u.id = t.unit_id WHERE u.unit_no = $1 AND t.movement_kind = 'move'`,
      [prduUnitNo],
    )
    expect(afterReplay.rows[0]!.total).toBe(before.rows[0]!.total)
    // 新 operationId 再确认：任务已 done → A-T13-1 拒绝
    const again = await confirmWith(bus, nextOp('cfmD2r'))
    expect(again.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(again.errorMessage).toContain('A-T13-1')
    expect(again.errorMessage).toContain('仅待入库')
  })
})
