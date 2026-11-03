import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext } from '@cadenza/application'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildConversionCommandBus } from '../../apps/api/src/conversion/conversion.composition'
import {
  CV_OWNER_ID,
  CV_OWNER_NAME,
  CV_TEST_DB_NAME,
  CV_UOM_ID,
  type CvFixtures,
  prepareCvTestDatabase,
  seedCvFixtures,
  seedProductionOrder,
  seedUnitOwner,
} from '../api/conversion-test-env'

/**
 * T16 两种形态转换集成（真容器独立库 cadenza_conversion + 真实命令总线/组合根，无业务桩）。
 *
 * 贯穿验收样例 A09（合同 §5）三类故障注入：
 * - 订单转换外发失败：本地先执行事实保留、待同步差异记录、本地不回滚不重复转换（FC-10/FC-04）；
 * - 库存转换"U9 已成功、MES 改码前进程退出"：恢复只应用同一转换的本地事务、
 *   外部不新增第二张单（重新同步不推 U9；FC-03/FC-15）；
 * - 本地失败（MES 改码/库存统计失败）：待恢复、展示同步失败，重试至完成。
 * 另：FC-09 按完成时点快照重推（不推当前值）；FC-04/FC-S1/S2/S3/S4/S5 库级约束与
 * append-only 触发器；FC-02 状态分列存储；命令幂等（同 operationId 重放原结果）。
 */

let pool: pg.Pool
let conversionBus: ReturnType<typeof buildConversionCommandBus>
let inventoryBus: ReturnType<typeof buildInventoryCommandBus>
let adminCtx: CommandContext
let fx: CvFixtures
let dbAvailable = true
const run = `cvf${Date.now().toString(36)}`.slice(0, 8)
/** 10 位载具码：类型位 E（第 2 位）＋ 4 位运行标识 ＋ 4 位序号（FC-07 长度/类型位）。 */
const tag = (n: number): string => `1E${run.slice(0, 4)}${String(n).padStart(4, '0')}`

beforeAll(async () => {
  try {
    pool = await prepareCvTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP conversion-flow: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${CV_TEST_DB_NAME}）。`)
    return
  }
  fx = await seedCvFixtures(pool)
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  conversionBus = buildConversionCommandBus(pool)
  inventoryBus = buildInventoryCommandBus(pool)
})

afterAll(async () => {
  if (pool) await pool.end()
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

let opSeq = 0
function nextOp(tagOp: string): string {
  opSeq += 1
  return `${run}-${tagOp}-${opSeq}`
}

function envelope(operationId: string, commandType: string, payload: Record<string, unknown>): CommandEnvelope {
  return { operationId, commandType, targetId: 'new', expectedRevision: 0, payload }
}

async function cv(operationId: string, commandType: string, payload: Record<string, unknown>): Promise<CommandResult> {
  return conversionBus.execute(envelope(operationId, commandType, payload), adminCtx)
}

/** 经真实命令链接收一颗库存单元并挂到指定生产订单（码归属事实）。 */
async function receiveOwnedUnit(unitNo: string, orderId: string, operationId_: string): Promise<string> {
  const r = await inventoryBus.execute(
    envelope(nextOp(`rcv${unitNo}`), 'inventory.receive-goods', {
      plantId: fx.szPlantId,
      quantity: '100.0000',
      uomId: CV_UOM_ID,
      uomCode: 'KG',
      locationId: fx.warehouseLocationId,
      locationCode: fx.warehouseLocationCode,
      ownerId: CV_OWNER_ID,
      ownerName: CV_OWNER_NAME,
      lotNo: `LOT-${run}-${unitNo}`,
      materialId: fx.materialId,
      materialCode: 'MAT-CV-FIN',
      unitNo,
      qualityStatus: 'qualified',
    }),
    adminCtx,
  )
  expect(r.status).toBe(CommandResultStatus.COMMITTED)
  const unitId = (r.data as { unitId: string }).unitId
  await seedUnitOwner(pool, fx, { orderId, operationId: operationId_, unitId, quantity: '100.0000' })
  return unitId
}

describe('A09-1 订单转换：外发失败保留本地事实、重试不重复本地转换（FC-08/09/10/04）', () => {
  let srcOrder = { orderId: '', operationId: '' }
  let tgtOrder = { orderId: '', operationId: '' }
  let conversionId = ''
  let lineId = ''

  beforeAll(async () => {
    if (!dbAvailable) return
    srcOrder = await seedProductionOrder(pool, fx, { orderNo: `PO-${run}-S1`, salesOrderNo: `SO-${run}-F1`, lineNo: '10' })
    tgtOrder = await seedProductionOrder(pool, fx, { orderNo: `PO-${run}-T1`, salesOrderNo: `SO-${run}-F2`, lineNo: '20' })
    await receiveOwnedUnit(tag(1), srcOrder.orderId, srcOrder.operationId)
    const created = await cv(nextOp('oc'), 'conversion.order.create', {
      plantId: fx.szPlantId,
      lines: [{ sourceOrderId: srcOrder.orderId, targetOrderId: tgtOrder.orderId, targetProjectNo: `PRJ-${run}-1`, quantity: '100.0000' }],
    })
    expect(created.status).toBe(CommandResultStatus.COMMITTED)
    conversionId = (created.data as { conversionId: string }).conversionId
    lineId = ((created.data as { lines: Array<{ lineId: string }> }).lines)[0]!.lineId
  })

  it('本地先完成：扫码→完成=归属改转换后订单+预留释放+快照固化（FC-08/FC-S5）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const scan = await cv(nextOp('sc'), 'conversion.order.scan', {
      plantId: fx.szPlantId,
      conversionOrderId: conversionId,
      lineId,
      unitNo: tag(1),
      segmentLength: '12.5000',
    })
    expect(scan.status).toBe(CommandResultStatus.COMMITTED)
    expect((scan.data as { scannedAxes: number }).scannedAxes).toBe(1)

    const complete = await cv(nextOp('cp'), 'conversion.order.complete', {
      plantId: fx.szPlantId,
      conversionOrderId: conversionId,
    })
    expect(complete.status).toBe(CommandResultStatus.COMMITTED)
    expect((complete.data as { status: string }).status).toBe('completed')
    const snap = await pool.query<{ status: string; sync_status: string; completion_snapshot: Record<string, unknown> }>(
      `SELECT status, sync_status, completion_snapshot FROM conversion_order WHERE id = $1`,
      [conversionId],
    )
    expect(snap.rows[0]!.status).toBe('completed')
    expect(snap.rows[0]!.sync_status).toBe('pending')
    expect(snap.rows[0]!.completion_snapshot?.['lines']).toHaveLength(1) // FC-S5 完成时点快照
  })

  it('A09 外部失败：保留本地已执行事实与待同步差异，本地不回滚（FC-10）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const retryFail = await cv(nextOp('rf'), 'conversion.order.sync-retry', {
      plantId: fx.szPlantId,
      conversionOrderId: conversionId,
      outcome: 'failure',
    })
    expect(retryFail.status).toBe(CommandResultStatus.COMMITTED)
    expect((retryFail.data as { syncStatus: string }).syncStatus).toBe('sync_failed')
    const order = await pool.query(`SELECT status, sync_status FROM conversion_order WHERE id = $1`, [conversionId])
    expect(order.rows[0]!.status).toBe('completed') // 本地不回滚
    expect(order.rows[0]!.sync_status).toBe('sync_failed') // 待同步差异记录
    const assignments = await pool.query(`SELECT count(*)::int AS c FROM conversion_code_assignment WHERE conversion_order_id = $1`, [conversionId])
    expect(assignments.rows[0]!.c).toBe(1) // 不重复本地转换（FC-04）
  })

  it('A09 重试成功：按完成时点快照重推（不推当前值）、成功后已同步、再试拒（FC-09）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const retryOk = await cv(nextOp('rs'), 'conversion.order.sync-retry', {
      plantId: fx.szPlantId,
      conversionOrderId: conversionId,
      outcome: 'success',
    })
    expect(retryOk.status).toBe(CommandResultStatus.COMMITTED)
    const data = retryOk.data as { syncStatus: string; snapshot: Record<string, unknown> }
    expect(data.syncStatus).toBe('synced')
    expect(data.snapshot?.['lines']).toHaveLength(1) // 重试按快照重推（FC-09/FC-S5）
    expect(data.snapshot?.['conversionNo']).toBeDefined()
    const pushTasks = await pool.query(
      `SELECT count(*)::int AS c FROM outbox WHERE aggregate_type = 'conversion_order' AND aggregate_id = $1 AND task_kind = 'form_conversion_push'`,
      [conversionId],
    )
    expect(pushTasks.rows[0]!.c).toBe(1) // 重试不新建外发任务行（不造成 U9 侧两张单，FC-04）

    const again = await cv(nextOp('ra'), 'conversion.order.sync-retry', {
      plantId: fx.szPlantId,
      conversionOrderId: conversionId,
      outcome: 'success',
    })
    expect(again.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(again.errorCode).toBe(ERROR_CODES.BUSINESS_RULE)
    expect(again.errorMessage).toContain('[FC-09]') // 已同步不可重试
  })
})

describe('A09-2 库存转换：U9 已成功、MES 改码前进程退出 → 恢复只应用本地、外部不新增第二张单（FC-03/13/15/16）', () => {
  let stockId = ''

  beforeAll(async () => {
    if (!dbAvailable) return
    const srcOrder = await seedProductionOrder(pool, fx, { orderNo: `PO-${run}-S2`, salesOrderNo: `SO-${run}-F3`, lineNo: '10' })
    await receiveOwnedUnit(tag(2), srcOrder.orderId, srcOrder.operationId)
  })

  it('链路：保存→派发（幂等键=聚合身份）→U9 成功→（进程退出模拟：未做本地应用）→重新同步只做本地', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const created = await cv(nextOp('sc2'), 'conversion.stock.create', {
      plantId: fx.szPlantId,
      materialId: fx.materialId,
      targetProjectNo: `PRJ-${run}-2`,
      targetSalesOrderNo: `SO-${run}-FB`,
      targetLineNo: '10',
      targetBatchNo: `B-${run}-FB`,
      lines: [{ unitNo: tag(2), segmentLength: '20.0000', sourceVirtualAxisNo: `V-${run}-2`, sourceProjectNo: `PRJ-${run}-OLD` }],
    })
    expect(created.status).toBe(CommandResultStatus.COMMITTED)
    stockId = (created.data as { conversionId: string }).conversionId

    const push = await cv(nextOp('pu2'), 'conversion.stock.push', { plantId: fx.szPlantId, conversionStockOrderId: stockId })
    expect(push.status).toBe(CommandResultStatus.COMMITTED)
    expect((push.data as { idempotencyKey: string }).idempotencyKey).toBe(stockId)

    const ok = await cv(nextOp('pr2'), 'conversion.stock.push-result', {
      plantId: fx.szPlantId,
      conversionStockOrderId: stockId,
      outcome: 'success',
      externalDocNo: `U9-${run}-A`,
    })
    expect(ok.status).toBe(CommandResultStatus.COMMITTED)
    expect((ok.data as { internalStatus: string }).internalStatus).toBe('local_processing')

    // “MES 改码前进程退出”：恢复入口 = 重新同步（只做 MES 改码与库存统计，不再推 U9）
    const resync = await cv(nextOp('ry2'), 'conversion.stock.resync', { plantId: fx.szPlantId, conversionStockOrderId: stockId })
    expect(resync.status).toBe(CommandResultStatus.COMMITTED)
    const data = resync.data as { repushedU9: boolean; internalStatus: string; displayStatus: string; localApplyStatus: string }
    expect(data.repushedU9).toBe(false)
    expect(data.internalStatus).toBe('completed')
    expect(data.displayStatus).toBe('convert_success')
    expect(data.localApplyStatus).toBe('applied')

    // 外部不新增第二张单：push 任务行只有 1 行（FC-03/FC-04）
    const pushTasks = await pool.query(
      `SELECT count(*)::int AS c FROM outbox WHERE aggregate_type = 'conversion_stock_order' AND aggregate_id = $1 AND task_kind = 'form_conversion_push'`,
      [stockId],
    )
    expect(pushTasks.rows[0]!.c).toBe(1)
    // 库存统计事件独立任务行（FC-S4 分立）
    const statTasks = await pool.query(
      `SELECT count(*)::int AS c FROM outbox WHERE aggregate_type = 'conversion_stock_order' AND aggregate_id = $1 AND task_kind = 'form_conversion.inventory-stats'`,
      [stockId],
    )
    expect(statTasks.rows[0]!.c).toBe(1)
  })

  it('A09 字段差异证据：码上项目号不变（改码表无项目号列）、单据有项目号、虚拟轴号被清空（FC-16）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const doc = await pool.query<{ target_project_no: string }>(`SELECT target_project_no FROM conversion_stock_order WHERE id = $1`, [stockId])
    expect(doc.rows[0]!.target_project_no).toBe(`PRJ-${run}-2`) // 单据有项目号
    const rewrite = await pool.query(`SELECT * FROM conversion_code_rewrite WHERE conversion_stock_order_id = $1`, [stockId])
    expect(rewrite.rows).toHaveLength(1)
    const row = rewrite.rows[0] as Record<string, unknown>
    expect(row['virtual_axis_cleared']).toBe(true) // 虚拟轴号被清空
    expect(row['new_sales_order_no']).toBe(`SO-${run}-FB`)
    expect(Object.keys(row).some((k) => k.includes('project'))).toBe(false) // 码上项目号不变：改码表无项目号列
    const line = await pool.query<{ source_project_no: string | null; released: boolean }>(
      `SELECT source_project_no, released FROM conversion_stock_line WHERE conversion_stock_order_id = $1`,
      [stockId],
    )
    expect(line.rows[0]!.source_project_no).toBe(`PRJ-${run}-OLD`) // 原项目号只记单据来源，不回写码
    expect(line.rows[0]!.released).toBe(true) // FC-S3 完成释放占用
  })

  it('A09 重复恢复不重复改码：完成后再 resync 拒、改码行仍 1 条（FC-04/FC-15）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const again = await cv(nextOp('ry2b'), 'conversion.stock.resync', { plantId: fx.szPlantId, conversionStockOrderId: stockId })
    expect(again.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(again.errorMessage).toContain('[FC-15]')
    const rewrites = await pool.query(`SELECT count(*)::int AS c FROM conversion_code_rewrite WHERE conversion_stock_order_id = $1`, [stockId])
    expect(rewrites.rows[0]!.c).toBe(1)
  })
})

describe('A09-3 库存转换本地失败恢复：失败→待恢复（同步失败）→重试失败→重试成功（FC-13③/FC-15）', () => {
  it('本地失败保留 U9 已成功标记；反复恢复仅最终一次落改码行', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const srcOrder = await seedProductionOrder(pool, fx, { orderNo: `PO-${run}-S3`, salesOrderNo: `SO-${run}-F4`, lineNo: '10' })
    await receiveOwnedUnit(tag(3), srcOrder.orderId, srcOrder.operationId)
    const created = await cv(nextOp('sc3'), 'conversion.stock.create', {
      plantId: fx.szPlantId,
      materialId: fx.materialId,
      targetSalesOrderNo: `SO-${run}-FC`,
      targetLineNo: '10',
      targetBatchNo: `B-${run}-FC`,
      lines: [{ unitNo: tag(3), segmentLength: '30.0000' }],
    })
    const sid = (created.data as { conversionId: string }).conversionId
    await cv(nextOp('pu3'), 'conversion.stock.push', { plantId: fx.szPlantId, conversionStockOrderId: sid })
    await cv(nextOp('pr3'), 'conversion.stock.push-result', { plantId: fx.szPlantId, conversionStockOrderId: sid, outcome: 'success' })

    const fail1 = await cv(nextOp('la3'), 'conversion.stock.local-apply', {
      plantId: fx.szPlantId,
      conversionStockOrderId: sid,
      outcome: 'failure',
    })
    expect(fail1.status).toBe(CommandResultStatus.COMMITTED)
    const afterFail = await pool.query(`SELECT internal_status, display_status, local_apply_status, u9_success FROM conversion_stock_order WHERE id = $1`, [sid])
    expect(afterFail.rows[0]!.internal_status).toBe('pending_recovery')
    expect(afterFail.rows[0]!.display_status).toBe('sync_failed')
    expect(afterFail.rows[0]!.local_apply_status).toBe('failed')
    expect(afterFail.rows[0]!.u9_success).toBe(true) // 不回滚外部已成功标记（FC-03/FC-15）

    const fail2 = await cv(nextOp('ry3'), 'conversion.stock.resync', {
      plantId: fx.szPlantId,
      conversionStockOrderId: sid,
      outcome: 'failure',
    })
    expect(fail2.status).toBe(CommandResultStatus.COMMITTED)
    expect((fail2.data as { internalStatus: string }).internalStatus).toBe('pending_recovery')
    let rewrites = await pool.query(`SELECT count(*)::int AS c FROM conversion_code_rewrite WHERE conversion_stock_order_id = $1`, [sid])
    expect(rewrites.rows[0]!.c).toBe(0) // 失败不落改码行

    const ok = await cv(nextOp('ry3b'), 'conversion.stock.resync', { plantId: fx.szPlantId, conversionStockOrderId: sid })
    expect(ok.status).toBe(CommandResultStatus.COMMITTED)
    expect((ok.data as { internalStatus: string }).internalStatus).toBe('completed')
    rewrites = await pool.query(`SELECT count(*)::int AS c FROM conversion_code_rewrite WHERE conversion_stock_order_id = $1`, [sid])
    expect(rewrites.rows[0]!.c).toBe(1) // 仅最终成功一次
  })
})

describe('FC-20 并发复核 + 命令幂等（CommandBus operationId 重放）', () => {
  it('同 operationId 扫码重放原结果，不重复扫码/不重复预留', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const srcOrder = await seedProductionOrder(pool, fx, { orderNo: `PO-${run}-S4`, salesOrderNo: `SO-${run}-F5`, lineNo: '10' })
    const tgtOrder = await seedProductionOrder(pool, fx, { orderNo: `PO-${run}-T4`, salesOrderNo: `SO-${run}-F6`, lineNo: '20' })
    await receiveOwnedUnit(tag(4), srcOrder.orderId, srcOrder.operationId)
    const created = await cv(nextOp('oc4'), 'conversion.order.create', {
      plantId: fx.szPlantId,
      lines: [{ sourceOrderId: srcOrder.orderId, targetOrderId: tgtOrder.orderId, targetProjectNo: `PRJ-${run}-4`, quantity: '100.0000' }],
    })
    const cid = (created.data as { conversionId: string }).conversionId
    const lid = ((created.data as { lines: Array<{ lineId: string }> }).lines)[0]!.lineId
    const opId = nextOp('sc4')
    const first = await cv(opId, 'conversion.order.scan', {
      plantId: fx.szPlantId,
      conversionOrderId: cid,
      lineId: lid,
      unitNo: tag(4),
      segmentLength: '40.0000',
    })
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const replay = await cv(opId, 'conversion.order.scan', {
      plantId: fx.szPlantId,
      conversionOrderId: cid,
      lineId: lid,
      unitNo: tag(4),
      segmentLength: '40.0000',
    })
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect(replay.data).toEqual(first.data) // 原结果回放
    const scans = await pool.query(`SELECT count(*)::int AS c FROM conversion_order_scan WHERE conversion_order_id = $1`, [cid])
    expect(scans.rows[0]!.c).toBe(1) // 不重复扫码
    const reservations = await pool.query(`SELECT count(*)::int AS c FROM reservation r JOIN inventory_unit u ON u.id = r.unit_id WHERE u.unit_no = $1 AND r.status = 'active'`, [tag(4)])
    expect(reservations.rows[0]!.c).toBe(1) // 不重复预留
  })
})

describe('FC-S1～S5 库级约束与 append-only 触发器（0012）', () => {
  let orderForConstraint = ''
  let lineForConstraint = ''
  let scanForConstraint = ''

  beforeAll(async () => {
    if (!dbAvailable) return
    const srcOrder = await seedProductionOrder(pool, fx, { orderNo: `PO-${run}-S5`, salesOrderNo: `SO-${run}-F7`, lineNo: '10' })
    const tgtOrder = await seedProductionOrder(pool, fx, { orderNo: `PO-${run}-T5`, salesOrderNo: `SO-${run}-F8`, lineNo: '20' })
    await receiveOwnedUnit(tag(5), srcOrder.orderId, srcOrder.operationId)
    const created = await cv(nextOp('oc5'), 'conversion.order.create', {
      plantId: fx.szPlantId,
      lines: [{ sourceOrderId: srcOrder.orderId, targetOrderId: tgtOrder.orderId, targetProjectNo: `PRJ-${run}-5`, quantity: '100.0000' }],
    })
    orderForConstraint = (created.data as { conversionId: string }).conversionId
    lineForConstraint = ((created.data as { lines: Array<{ lineId: string }> }).lines)[0]!.lineId
    const scan = await cv(nextOp('sc5'), 'conversion.order.scan', {
      plantId: fx.szPlantId,
      conversionOrderId: orderForConstraint,
      lineId: lineForConstraint,
      unitNo: tag(5),
      segmentLength: '50.0000',
    })
    scanForConstraint = (scan.data as { scanId: string }).scanId
  })

  async function expectSqlError(sql: string, params: unknown[], matcher: (e: { code: string; message: string }) => void): Promise<void> {
    try {
      await pool.query(sql, params)
      expect.unreachable('应当抛出库级错误')
    } catch (error) {
      const e = error as { code: string; message: string }
      matcher(e)
    }
  }

  it('FC-S1：明细 (转换单, 转换前销售单号, 行号) 唯一', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const line = await pool.query<{ source_order_id: string; source_sales_order_no: string; source_line_no: string; target_order_id: string; target_sales_order_no: string; target_project_no: string; material_id: string; material_code: string }>(
      `SELECT source_order_id, source_sales_order_no, source_line_no, target_order_id, target_sales_order_no, target_project_no, material_id, material_code
       FROM conversion_order_line WHERE id = $1`,
      [lineForConstraint],
    )
    const l = line.rows[0]!
    await expectSqlError(
      `INSERT INTO conversion_order_line (conversion_order_id, line_no, source_order_id, source_sales_order_no, source_line_no,
         target_order_id, target_sales_order_no, target_project_no, material_id, material_code, planned_qty, uom)
       VALUES ($1, 99, $2, $3, $4, $5, $6, $7, $8, $9, 1.0000, 'KG')`,
      [orderForConstraint, l.source_order_id, l.source_sales_order_no, l.source_line_no, l.target_order_id, l.target_sales_order_no, l.target_project_no, l.material_id, l.material_code],
      (e) => expect(e.code).toBe('23505'),
    )
  })

  it('FC-S2：扫码事实列不可改（触发器 [FC-07]）；扫码行不可 DELETE', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await expectSqlError(
      `UPDATE conversion_order_scan SET quantity = 1.0000 WHERE id = $1`,
      [scanForConstraint],
      (e) => {
        expect(e.code).toBe('P0001')
        expect(e.message).toContain('[FC-07]')
      },
    )
    await expectSqlError(`DELETE FROM conversion_order_scan WHERE id = $1`, [scanForConstraint], (e) => {
      expect(e.code).toBe('P0001')
      expect(e.message).toContain('[FC-04]')
    })
  })

  it('FC-S3：库存明细 (二维码, 物料) 未完成唯一（partial, WHERE NOT released）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const stock = await cv(nextOp('sc6'), 'conversion.stock.create', {
      plantId: fx.szPlantId,
      materialId: fx.materialId,
      targetSalesOrderNo: `SO-${run}-FD`,
      targetLineNo: '10',
      targetBatchNo: `B-${run}-FD`,
      lines: [{ unitNo: tag(5), segmentLength: '60.0000' }],
    })
    expect(stock.status).toBe(CommandResultStatus.BUSINESS_REJECTION) // 扫码锁定中的码被协议B拒（FC-20 前置复核）
    // 直接 SQL 复核 partial unique：手工插一行未完成占用后，同 (码, 料) 再插 → 23505
    const srcOrder = await seedProductionOrder(pool, fx, { orderNo: `PO-${run}-S6`, salesOrderNo: `SO-${run}-F9`, lineNo: '10' })
    await receiveOwnedUnit(tag(6), srcOrder.orderId, srcOrder.operationId)
    const unit6 = await pool.query<{ id: string }>(`SELECT id FROM inventory_unit WHERE unit_no = $1`, [tag(6)])
    const head = await pool.query<{ id: string }>(
      `INSERT INTO conversion_stock_order (conversion_no, material_id, material_code, target_sales_order_no, target_line_no, target_batch_no, plant_id, enterprise_id)
       VALUES ($1, $2, 'MAT-CV-FIN', 'SO-S3X', '10', 'B-S3X', $3, $4) RETURNING id`,
      [`CVS${run}SQL1`, fx.materialId, fx.szPlantId, fx.enterpriseId],
    )
    const insLine = `INSERT INTO conversion_stock_line (conversion_stock_order_id, unit_no, inventory_unit_id, quantity, uom,
       segment_length, material_id, material_code, plant_id, enterprise_id)
     VALUES ($1, $2, $3, 1.0000, 'KG', 1.0000, $4, 'MAT-CV-FIN', $5, $6)`
    await pool.query(insLine, [head.rows[0]!.id, tag(6), unit6.rows[0]!.id, fx.materialId, fx.szPlantId, fx.enterpriseId])
    await expectSqlError(insLine, [head.rows[0]!.id, tag(6), unit6.rows[0]!.id, fx.materialId, fx.szPlantId, fx.enterpriseId], (e) =>
      expect(e.code).toBe('23505'),
    )
    // released=true 后同码可再占（未完成唯一失效）
    await pool.query(`UPDATE conversion_stock_line SET released = true WHERE conversion_stock_order_id = $1`, [head.rows[0]!.id])
    await pool.query(insLine, [head.rows[0]!.id, tag(6), unit6.rows[0]!.id, fx.materialId, fx.szPlantId, fx.enterpriseId])
  })

  it('FC-04：归属变更/改码记录 append-only（UPDATE/DELETE 触发器拒绝）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 归属变更：先完成一单产生事实行
    const complete = await cv(nextOp('cp5'), 'conversion.order.complete', { plantId: fx.szPlantId, conversionOrderId: orderForConstraint })
    expect(complete.status).toBe(CommandResultStatus.COMMITTED)
    const assignment = await pool.query<{ id: string }>(
      `SELECT id FROM conversion_code_assignment WHERE conversion_order_id = $1 LIMIT 1`,
      [orderForConstraint],
    )
    await expectSqlError(`UPDATE conversion_code_assignment SET to_order_id = gen_random_uuid() WHERE id = $1`, [assignment.rows[0]!.id], (e) => {
      expect(e.code).toBe('P0001')
      expect(e.message).toContain('[FC-04]')
    })
    await expectSqlError(`DELETE FROM conversion_code_assignment WHERE id = $1`, [assignment.rows[0]!.id], (e) => {
      expect(e.code).toBe('P0001')
      expect(e.message).toContain('[FC-04]')
    })
  })

  it('FC-S4/FC-02/FC-16：状态分列与幂等标记列；改码表无项目号列（结构保证）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const stockCols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'conversion_stock_order' ORDER BY column_name`,
    )
    const names = stockCols.rows.map((r) => r.column_name)
    for (const col of ['internal_status', 'display_status', 'external_push_status', 'local_apply_status', 'u9_success', 'submit_snapshot']) {
      expect(names).toContain(col) // FC-02/FC-14 四列分立 + FC-S4 幂等标记 + FC-S5 快照
    }
    const orderCols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'conversion_order'`,
    )
    const orderNames = orderCols.rows.map((r) => r.column_name)
    expect(orderNames).toContain('status')
    expect(orderNames).toContain('sync_status') // FC-12/FC-S1 转换状态与同步状态分列
    const rewriteCols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'conversion_code_rewrite'`,
    )
    expect(rewriteCols.rows.map((r) => r.column_name).some((c) => c.includes('project'))).toBe(false) // FC-16 码上项目号不变
  })
})
