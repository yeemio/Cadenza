import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext } from '@cadenza/application'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildShippingCommandBus } from '../../apps/api/src/shipping/shipping.composition'
import {
  SHP_TEST_DB_NAME,
  prepareShpTestDatabase,
  seedShpFixtures,
  type ShpFixtures,
} from '../api/shipping-test-env'

/**
 * 装箱发运集成（真容器独立库 cadenza_shp + 真实命令总线与真实组合根，无业务桩）。
 * WorkItem 冻结八类证据之①-⑦（⑧跨厂 403 属 API 层，见 shipping-api.spec.ts）：
 * ① PL 入站幂等（重复同单号不重复建）+ DC 组成入站幂等/缺组成标记/缺组织隔离
 * ② 扫码装入五拒一成+行扫满状态流转（+删码退回待装箱+打包任务先托码库位/扫满绑定/已打包托码只读）
 * ③ 确认出库：应扫不足拒（指名料品/段长）→补齐后成功→库存已发运（余额/流水断言）+出库人/完成时间落库
 * ④ 实发轴无差异→NOOP_NEEDED、有差异→PENDING 任务行、发货状态任务独立行（两任务互不影响状态）
 * ⑤ 回传重试幂等（不重做已成功侧）
 * ⑥ 补码计入已扫件数
 * ⑦ 同 operationId 重放（原结果回放，不重复入账/不重复扫码/不重复记账）
 */

let pool: pg.Pool
let shippingBus: ReturnType<typeof buildShippingCommandBus>
let inventoryBus: ReturnType<typeof buildInventoryCommandBus>
let adminCtx: CommandContext
let fx: ShpFixtures
let dbAvailable = true
const run = `shp${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

const OWNER = '22222222-2222-4222-8222-222222222201'
const OWNER_NAME = '华东电缆集团（自有）'

beforeAll(async () => {
  try {
    pool = await prepareShpTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP shipping-flow: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${SHP_TEST_DB_NAME}）。`)
    return
  }
  fx = await seedShpFixtures(pool)
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  shippingBus = buildShippingCommandBus(pool)
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
function nextOp(tag: string): string {
  opSeq += 1
  return `${run}-${tag}-${opSeq}`
}

function envelope(operationId: string, commandType: string, payload: Record<string, unknown>): CommandEnvelope {
  return { operationId, commandType, targetId: 'new', expectedRevision: 0, payload }
}

type AnyBus = ReturnType<typeof buildShippingCommandBus> | ReturnType<typeof buildInventoryCommandBus>

async function exec(
  bus: AnyBus,
  operationId: string,
  commandType: string,
  payload: Record<string, unknown>,
): Promise<CommandResult> {
  return bus.execute(envelope(operationId, commandType, payload), adminCtx)
}

async function sp(operationId: string, commandType: string, payload: Record<string, unknown>): Promise<CommandResult> {
  return exec(shippingBus, operationId, commandType, payload)
}

/** 收货一个库存单元（inventory.receive-goods；质量状态参数化——合格/待检/存疑）。 */
async function receiveUnit(unitNo: string, qualityStatus: 'qualified' | 'pending_inspection' | 'suspect'): Promise<string> {
  const r = await exec(inventoryBus, nextOp(`rcv${unitNo}`), 'inventory.receive-goods', {
    plantId: fx.szPlantId,
    quantity: '100.0000',
    uomId: fx.uomId,
    uomCode: 'KG',
    locationId: fx.stockLocationId,
    locationCode: '91110101',
    ownerId: OWNER,
    ownerName: OWNER_NAME,
    lotNo: `LOT-${run}-${unitNo}`,
    materialId: fx.finishedMaterialId,
    materialCode: 'MAT-SHP-FIN',
    unitNo,
    qualityStatus,
  })
  expect(r.status).toBe(CommandResultStatus.COMMITTED)
  return (r.data as { unitId: string }).unitId
}

async function orderLineIds(plNo: string): Promise<Map<number, string>> {
  const r = await pool.query<{ id: string; line_no: number }>(
    `SELECT l.id, l.line_no FROM shipment_line l JOIN shipment_order o ON o.id = l.shipment_order_id WHERE o.pl_no = $1 ORDER BY l.line_no`,
    [plNo],
  )
  return new Map(r.rows.map((row) => [row.line_no, row.id]))
}

describe('① PL 入站幂等 + DC 组成入站（IF-04/IF-05/IF-00.2/IF-00.8）', () => {
  const soNo = `SO-${run}-1`
  const plNo = `PL-${run}-1001`

  it('DC 组成入站：幂等（同 dcId+销售订单号+行号）与缺组成标记', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const comp = { segmentLength: '1200.0000', segmentQty: 1, axisFixture: 'DRUM-600', redCode: false, packingPlan: 'P-01', virtualAxisNo: null, packingAt: '2026-10-27T08:00:00Z' }
    const first = await sp(nextOp('dc1'), 'shipping.dc-composition.inbound', {
      plantId: fx.szPlantId, dcId: `DC-${run}`, salesOrderNo: soNo, lineNo: 10, composition: comp,
    })
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    expect((first.data as { skipped: boolean }).skipped).toBe(false)
    expect((first.data as { syncStatus: string }).syncStatus).toBe('received')
    // IF-00.2 幂等：重复同键报文 → skipped（不重复应用）
    const repeat = await sp(nextOp('dc2'), 'shipping.dc-composition.inbound', {
      plantId: fx.szPlantId, dcId: `DC-${run}`, salesOrderNo: soNo, lineNo: 10, composition: comp,
    })
    expect(repeat.status).toBe(CommandResultStatus.COMMITTED)
    expect((repeat.data as { skipped: boolean }).skipped).toBe(true)
    const rows = await pool.query(`SELECT count(*)::int AS c FROM dc_segment_composition WHERE dc_id = $1 AND sales_order_no = $2 AND line_no = 10`, [`DC-${run}`, soNo])
    expect(rows.rows[0]!.c).toBe(1)
    // A-T14-2：缺组成数据 → missing 标记
    const missing = await sp(nextOp('dc3'), 'shipping.dc-composition.inbound', {
      plantId: fx.szPlantId, dcId: `DC-${run}`, salesOrderNo: soNo, lineNo: 30,
    })
    expect((missing.data as { syncStatus: string }).syncStatus).toBe('missing')
    // 行 20 组成（PL-1001 无轴行的组成数据——compositionMissing=false 断言用）
    const comp20 = await sp(nextOp('dc4'), 'shipping.dc-composition.inbound', {
      plantId: fx.szPlantId, dcId: `DC-${run}`, salesOrderNo: soNo, lineNo: 20,
      composition: { segmentLength: '50.0000', segmentQty: 2, packingPlan: 'P-02' },
    })
    expect((comp20.data as { syncStatus: string }).syncStatus).toBe('received')
  })

  it('DC 缺组织映射 → 隔离队列（IF-00.8 非普通失败）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const quarantined = await sp(nextOp('dcq'), 'shipping.dc-composition.inbound', {
      orgCode: 'ORG-X', dcId: `DC-${run}-Q`, salesOrderNo: soNo, lineNo: 99, composition: { segmentLength: '1.0000' },
    })
    expect(quarantined.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(quarantined.errorMessage).toContain('IF-00.8')
    const inbox = await pool.query(`SELECT count(*)::int AS c FROM inbox WHERE external_key = $1 AND status = 'QUARANTINED'`, [`DC-${run}-Q+${soNo}+99`])
    expect(inbox.rows[0]!.c).toBe(1)
  })

  it('PL 入站：三类行落库+缺组成标记；重复同单号幂等返回不重复建', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const first = await sp(nextOp('pl1'), 'shipping.pl.inbound', {
      plantId: fx.szPlantId,
      plNo,
      salesOrderNo: soNo,
      customerName: '国贸演示客户',
      lines: [
        { lineNo: 1, lineKind: 'axis_item', materialId: fx.finishedMaterialId, materialCode: 'MAT-SHP-FIN', salesOrderLineNo: '10', customerAxisNo: 'CAX-01', standardSegmentLength: '1200.0000' },
        { lineNo: 2, lineKind: 'plain_item', materialId: fx.partMaterialId, materialCode: 'MAT-SHP-PART', salesOrderLineNo: '20', segmentLength: '50.0000', requiredCount: 2 },
      ],
    })
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    expect((first.data as { compositionMissing: boolean }).compositionMissing).toBe(false)
    expect((first.data as { status: string }).status).toBe('pending_packing')
    // IF-00.2/IF-05：发货单号幂等（不同 operationId 重复下发）
    const repeat = await sp(nextOp('pl2'), 'shipping.pl.inbound', {
      plantId: fx.szPlantId,
      plNo,
      salesOrderNo: soNo,
      lines: [{ lineNo: 1, lineKind: 'axis_item', materialCode: 'MAT-SHP-FIN', salesOrderLineNo: '10', customerAxisNo: 'CAX-01', standardSegmentLength: '1200.0000' }],
    })
    expect(repeat.status).toBe(CommandResultStatus.COMMITTED)
    expect((repeat.data as { skipped: boolean }).skipped).toBe(true)
    expect((repeat.data as { created: number }).created).toBe(0)
    const orders = await pool.query(`SELECT count(*)::int AS c FROM shipment_order WHERE pl_no = $1`, [plNo])
    expect(orders.rows[0]!.c).toBe(1)
    const lines = await pool.query(`SELECT count(*)::int AS c FROM shipment_line l JOIN shipment_order o ON o.id = l.shipment_order_id WHERE o.pl_no = $1`, [plNo])
    expect(lines.rows[0]!.c).toBe(2)
  })

  it('PL 缺 DC 组成数据 → compositionMissing 标记（生产订单行标黄数据源）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const marked = await sp(nextOp('pl3'), 'shipping.pl.inbound', {
      plantId: fx.szPlantId,
      plNo: `PL-${run}-NS`,
      salesOrderNo: `SO-${run}-NS`,
      lines: [{ lineNo: 1, lineKind: 'plain_item', materialCode: 'MAT-SHP-PART', salesOrderLineNo: '30', requiredCount: 1 }],
    })
    expect(marked.status).toBe(CommandResultStatus.COMMITTED)
    expect((marked.data as { compositionMissing: boolean }).compositionMissing).toBe(true)
  })
})

describe('② 扫码装入五拒一成 + 行扫满流转（A-T14-3/4/5）', () => {
  const plNo = `PL-${run}-1001`
  const plNoDel = `PL-${run}-6001`
  let lineIds = new Map<number, string>()
  let delLineIds = new Map<number, string>()
  let nsLineId = ''
  let pl1002LineId = ''

  it('准备：无段长行 PL 与 打包 PL', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    lineIds = await orderLineIds(plNo)
    expect(lineIds.size).toBe(2)
    // 无段长行（PL-NS 行 30：无 DC 组成且载荷无段长 → 快照缺失）
    const ns = await orderLineIds(`PL-${run}-NS`)
    nsLineId = ns.get(1)!
    // 打包任务 PL-1002（托盘行 总轴数 2）/ PL-1003（托码只读证据）
    await sp(nextOp('pl1002'), 'shipping.pl.inbound', {
      plantId: fx.szPlantId, plNo: `PL-${run}-1002`, salesOrderNo: `SO-${run}-2`,
      lines: [{ lineNo: 1, lineKind: 'pallet', materialCode: 'MAT-SHP-FIN', salesOrderLineNo: '10', requiredCount: 2 }],
    })
    pl1002LineId = (await orderLineIds(`PL-${run}-1002`)).get(1)!
    await sp(nextOp('pl1003'), 'shipping.pl.inbound', {
      plantId: fx.szPlantId, plNo: `PL-${run}-1003`, salesOrderNo: `SO-${run}-3`,
      lines: [{ lineNo: 1, lineKind: 'pallet', materialCode: 'MAT-SHP-FIN', salesOrderLineNo: '10', requiredCount: 1 }],
    })
    // 删码 PL-6001（无轴行 件数 2）
    await sp(nextOp('pl6001'), 'shipping.pl.inbound', {
      plantId: fx.szPlantId, plNo: plNoDel, salesOrderNo: `SO-${run}-6`,
      lines: [{ lineNo: 1, lineKind: 'plain_item', materialCode: 'MAT-SHP-PART', salesOrderLineNo: '10', segmentLength: '30.0000', requiredCount: 2 }],
    })
    delLineIds = await orderLineIds(plNoDel)
  })

  it('拒①未审核（待检质量状态不可装入）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`U-${run}-PEND`, 'pending_inspection')
    const rejected = await sp(nextOp('scnr1'), 'shipping.scan.load', {
      plantId: fx.szPlantId, shipmentOrderId: (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [plNo])).rows[0]!.id,
      lineId: lineIds.get(1)!, unitNo: `U-${run}-PEND`,
    })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorMessage).toContain('A-T14-3')
    expect(rejected.errorMessage).toContain('未审核')
  })

  it('拒②质量存疑恒拒', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`U-${run}-SUS`, 'suspect')
    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [plNo])).rows[0]!.id
    const rejected = await sp(nextOp('scnr2'), 'shipping.scan.load', {
      plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: lineIds.get(1)!, unitNo: `U-${run}-SUS`,
    })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorMessage).toContain('存疑')
  })

  it('拒③被其它业务锁定（活动作业预留）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const unitId = await receiveUnit(`U-${run}-LOCK`, 'qualified')
    const acquired = await exec(inventoryBus, nextOp('rsv1'), 'inventory.reservation.acquire', {
      unitId, quantity: '100.0000', holderType: 'task', holderRef: 'other-business-lock',
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    })
    expect(acquired.status).toBe(CommandResultStatus.COMMITTED)
    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [plNo])).rows[0]!.id
    const rejected = await sp(nextOp('scnr3'), 'shipping.scan.load', {
      plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: lineIds.get(1)!, unitNo: `U-${run}-LOCK`,
    })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorMessage).toContain('锁定')
  })

  it('拒④未关联销售订单行（扫其它发货单的行）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`U-${run}-FOREIGN`, 'qualified')
    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [plNo])).rows[0]!.id
    const rejected = await sp(nextOp('scnr4'), 'shipping.scan.load', {
      plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: nsLineId, unitNo: `U-${run}-FOREIGN`, // 行属 PL-NS
    })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorCode).toBe(ERROR_CODES.NOT_FOUND)
    expect(rejected.errorMessage).toContain('不属于该发货单')
  })

  it('拒⑤无段长（行快照缺失段长）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`U-${run}-NOSEG`, 'qualified')
    const nsOrderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [`PL-${run}-NS`])).rows[0]!.id
    const rejected = await sp(nextOp('scnr5'), 'shipping.scan.load', {
      plantId: fx.szPlantId, shipmentOrderId: nsOrderId, lineId: nsLineId, unitNo: `U-${run}-NOSEG`,
    })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorMessage).toContain('无段长')
  })

  it('一成+行扫满状态流转：有轴行 1/1→已装箱（单仍待装箱）→无轴行 2/2→已装箱→单 待出库', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [plNo])).rows[0]!.id
    await receiveUnit(`CAX-01`, 'qualified') // 实发轴号=快照客户轴号（无差异场景留待④）
    const scan1 = await sp(nextOp('scn1'), 'shipping.scan.load', {
      plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: lineIds.get(1)!, unitNo: 'CAX-01', actualSegmentLength: '1198.5000',
    })
    expect(scan1.status).toBe(CommandResultStatus.COMMITTED)
    expect((scan1.data as { lineStatus: string; orderStatus: string }).lineStatus).toBe('packed')
    expect((scan1.data as { orderStatus: string }).orderStatus).toBe('pending_packing') // 无轴行未满
    const axisLine = await pool.query<{ actual_segment_length: string | null; scanned_count: number; line_status: string }>(
      `SELECT actual_segment_length::text AS actual_segment_length, scanned_count, line_status FROM shipment_line WHERE id = $1`,
      [lineIds.get(1)!],
    )
    expect(axisLine.rows[0]!.actual_segment_length).toBe('1198.5000') // 实际段长留痕（有轴行：标准/实际段长）
    expect(axisLine.rows[0]!.line_status).toBe('packed')

    await receiveUnit(`U-${run}-PA`, 'qualified')
    const scan2 = await sp(nextOp('scn2'), 'shipping.scan.load', {
      plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: lineIds.get(2)!, unitNo: `U-${run}-PA`,
    })
    expect((scan2.data as { lineStatus: string }).lineStatus).toBe('pending_packing') // 1/2
    await receiveUnit(`U-${run}-PB`, 'qualified')
    const scan3 = await sp(nextOp('scn3'), 'shipping.scan.load', {
      plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: lineIds.get(2)!, unitNo: `U-${run}-PB`,
    })
    expect((scan3.data as { lineStatus: string; orderStatus: string }).lineStatus).toBe('packed')
    expect((scan3.data as { orderStatus: string }).orderStatus).toBe('ready_to_ship') // 全部行扫满→待出库
  })

  it('删码不满足退回待装箱：扫满→删一→行/单退回→重扫→再满', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [plNoDel])).rows[0]!.id
    await receiveUnit(`U-${run}-D1`, 'qualified')
    await receiveUnit(`U-${run}-D2`, 'qualified')
    await sp(nextOp('dela'), 'shipping.scan.load', { plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: delLineIds.get(1)!, unitNo: `U-${run}-D1` })
    const scanB = await sp(nextOp('delb'), 'shipping.scan.load', { plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: delLineIds.get(1)!, unitNo: `U-${run}-D2` })
    expect((scanB.data as { orderStatus: string }).orderStatus).toBe('ready_to_ship')
    const removed = await sp(nextOp('delc'), 'shipping.scan.delete', {
      plantId: fx.szPlantId, shipmentOrderId: orderId, scanId: (scanB.data as { scanId: string }).scanId, reason: '装错删码',
    })
    expect(removed.status).toBe(CommandResultStatus.COMMITTED)
    expect(removed.data).toMatchObject({ scannedCount: 1, lineStatus: 'pending_packing', orderStatus: 'pending_packing' }) // A-T14-3：删码不满足退回待装箱
    const delRow = await pool.query<{ deleted: boolean; deleted_by: string | null }>(
      `SELECT deleted, deleted_by FROM packing_scan WHERE id = $1`, [(scanB.data as { scanId: string }).scanId],
    )
    expect(delRow.rows[0]!.deleted).toBe(true) // 删码=标记留痕（append-only，不物理删）
    expect(delRow.rows[0]!.deleted_by).toBe('admin')
    // 重扫（删码后同码可重扫；此处用新码）→ 再满
    await receiveUnit(`U-${run}-D3`, 'qualified')
    const rescan = await sp(nextOp('deld'), 'shipping.scan.load', { plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: delLineIds.get(1)!, unitNo: `U-${run}-D3` })
    expect((rescan.data as { orderStatus: string }).orderStatus).toBe('ready_to_ship')
  })

  it('打包任务（A-T14-4）：先扫托码+选调入库位→逐行扫满→绑定托码；未满绑定拒；已打包托码库位只读', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [`PL-${run}-1002`])).rows[0]!.id
    const packing = await sp(nextOp('pk1'), 'shipping.packing.create', {
      plantId: fx.szPlantId, shipmentOrderId: orderId, palletCode: `PLT-${run}-A`, toLocationId: fx.rackLocationId, toLocationCode: '010101',
    })
    expect(packing.status).toBe(CommandResultStatus.COMMITTED)
    expect((packing.data as { status: string; linkedLines: string[] }).status).toBe('pending')
    expect((packing.data as { linkedLines: string[] }).linkedLines).toHaveLength(1)

    await receiveUnit(`U-${run}-C1`, 'qualified')
    const scan1 = await sp(nextOp('pk2'), 'shipping.scan.load', { plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: pl1002LineId, unitNo: `U-${run}-C1` })
    expect((scan1.data as { scannedCount: number }).scannedCount).toBe(1) // 1/2
    // 未满绑定拒
    const earlyBind = await sp(nextOp('pk3'), 'shipping.packing.bind', {
      plantId: fx.szPlantId, packingOrderId: (packing.data as { packingId: string }).packingId,
    })
    expect(earlyBind.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(earlyBind.errorMessage).toContain('A-T14-4')
    // 扫满 → 绑定成功（托盘行打包状态→已打包）
    await receiveUnit(`U-${run}-C2`, 'qualified')
    await sp(nextOp('pk4'), 'shipping.scan.load', { plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: pl1002LineId, unitNo: `U-${run}-C2` })
    const bind = await sp(nextOp('pk5'), 'shipping.packing.bind', {
      plantId: fx.szPlantId, packingOrderId: (packing.data as { packingId: string }).packingId,
    })
    expect(bind.status).toBe(CommandResultStatus.COMMITTED)
    expect(bind.data).toMatchObject({ status: 'bound', boundLines: 1 })
    const lineRow = await pool.query<{ packing_status: string | null }>(`SELECT packing_status FROM shipment_line WHERE id = $1`, [pl1002LineId])
    expect(lineRow.rows[0]!.packing_status).toBe('bound')
    // 已打包托码库位只读：同托码新打包任务（另一单）拒
    const order3Id = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [`PL-${run}-1003`])).rows[0]!.id
    const readonly = await sp(nextOp('pk6'), 'shipping.packing.create', {
      plantId: fx.szPlantId, shipmentOrderId: order3Id, palletCode: `PLT-${run}-A`, toLocationId: fx.rackLocationId2, toLocationCode: '010102',
    })
    expect(readonly.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(readonly.errorMessage).toContain('A-T14-4')
    expect(readonly.errorMessage).toContain('只读')
  })
})

describe('③ 确认出库：应扫不足拒→补齐后成功→库存已发运（A-T14-7）', () => {
  const plNo = `PL-${run}-3001`
  let orderId = ''
  let lineIds = new Map<number, string>()

  it('准备与应扫不足拒绝（指名料品/段长）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await sp(nextOp('pl3001'), 'shipping.pl.inbound', {
      plantId: fx.szPlantId, plNo, salesOrderNo: `SO-${run}-3001`,
      lines: [
        { lineNo: 1, lineKind: 'axis_item', materialCode: 'MAT-SHP-FIN', salesOrderLineNo: '10', customerAxisNo: 'CAX-31', standardSegmentLength: '1200.0000' },
        { lineNo: 2, lineKind: 'plain_item', materialCode: 'MAT-SHP-PART', salesOrderLineNo: '20', segmentLength: '50.0000', requiredCount: 2 },
      ],
    })
    orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [plNo])).rows[0]!.id
    lineIds = await orderLineIds(plNo)
    await receiveUnit(`U-${run}-P1`, 'qualified')
    const partialScan = await sp(nextOp('c1'), 'shipping.scan.load', {
      plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: lineIds.get(2)!, unitNo: `U-${run}-P1`,
    })
    expect((partialScan.data as { orderStatus: string }).orderStatus).toBe('pending_packing')
    // A-T14-7：仅待出库可确认——当前待装箱直接拒
    const wrongState = await sp(nextOp('c2'), 'shipping.ship.confirm', { plantId: fx.szPlantId, shipmentOrderId: orderId })
    expect(wrongState.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(wrongState.errorMessage).toContain('A-T14-7')
    expect(wrongState.errorMessage).toContain('待出库')
  })

  it('补齐后成功：已出库+出库人+完成时间落库+库存记已发运（余额/流水断言）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await receiveUnit(`CAX-31`, 'qualified')
    await receiveUnit(`U-${run}-P2`, 'qualified')
    await sp(nextOp('c3'), 'shipping.scan.load', { plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: lineIds.get(1)!, unitNo: 'CAX-31' })
    await sp(nextOp('c4'), 'shipping.scan.load', { plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: lineIds.get(2)!, unitNo: `U-${run}-P2` })
    const beforeBalances = await pool.query<{ unit_id: string; quantity: string }>(
      `SELECT unit_id, quantity::text AS quantity FROM stock_balance WHERE unit_id IN (SELECT id FROM inventory_unit WHERE unit_no LIKE $1) AND status = 'active'`,
      [`%${run}%`],
    )
    expect(beforeBalances.rows.length).toBeGreaterThan(0)

    const confirm = await sp(nextOp('c5'), 'shipping.ship.confirm', { plantId: fx.szPlantId, shipmentOrderId: orderId, reason: '发运出库' })
    expect(confirm.status).toBe(CommandResultStatus.COMMITTED)
    expect((confirm.data as { status: string; outboundBy: string }).status).toBe('shipped')
    expect((confirm.data as { outboundBy: string }).outboundBy).toBe('admin')
    expect(typeof (confirm.data as { outboundAt: string }).outboundAt).toBe('string')

    const orderRow = await pool.query<{ status: string; outbound_by: string | null; outbound_at: string | null }>(
      `SELECT status, outbound_by, outbound_at FROM shipment_order WHERE id = $1`, [orderId],
    )
    expect(orderRow.rows[0]!.status).toBe('shipped')
    expect(orderRow.rows[0]!.outbound_by).toBe('admin')
    expect(orderRow.rows[0]!.outbound_at).not.toBeNull() // 出库完成时间落库（IF-00.6 快照时点）
    // 库存已发运：单元状态 shipped + 余额关闭归零 + issue 流水含扣前/扣后（ref=shipment_order）
    for (const unitNo of ['CAX-31', `U-${run}-P1`, `U-${run}-P2`]) {
      const unit = await pool.query<{ status: string; balance_open: boolean }>(
        `SELECT status, balance_open FROM inventory_unit WHERE unit_no = $1`, [unitNo],
      )
      expect(unit.rows[0]!.status).toBe('shipped')
      const balance = await pool.query<{ quantity: string; status: string }>(
        `SELECT quantity::text AS quantity, status FROM stock_balance WHERE unit_id = (SELECT id FROM inventory_unit WHERE unit_no = $1)`,
        [unitNo],
      )
      expect(balance.rows[0]!.quantity).toBe('0.0000')
      expect(balance.rows[0]!.status).toBe('closed')
      const txn = await pool.query<{ movement_kind: string; before_qty: string; after_qty: string; ref_type: string }>(
        `SELECT movement_kind, before_qty::text AS before_qty, after_qty::text AS after_qty, ref_type
         FROM stock_transaction WHERE unit_id = (SELECT id FROM inventory_unit WHERE unit_no = $1) AND ref_type = 'shipment_order'`,
        [unitNo],
      )
      expect(txn.rows).toHaveLength(1)
      expect(txn.rows[0]!.movement_kind).toBe('issue')
      expect(txn.rows[0]!.before_qty).toBe('100.0000')
      expect(txn.rows[0]!.after_qty).toBe('0.0000')
    }
  })
})

describe('④ 两条回传独立（A-T14-8/IF-06/IF-07）', () => {
  it('实发轴无差异→NOOP_NEEDED（不是失败）；发货状态任务独立 PENDING', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const plNo = `PL-${run}-4001`
    await sp(nextOp('pl41'), 'shipping.pl.inbound', {
      plantId: fx.szPlantId, plNo, salesOrderNo: `SO-${run}-4001`,
      lines: [{ lineNo: 1, lineKind: 'axis_item', materialCode: 'MAT-SHP-FIN', salesOrderLineNo: '10', customerAxisNo: 'CAX-41', standardSegmentLength: '1200.0000' }],
    })
    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [plNo]).then((r) => r.rows[0]!.id))
    await receiveUnit('CAX-41', 'qualified') // 实发轴号==客户轴号 → 无差异
    await sp(nextOp('s41'), 'shipping.scan.load', { plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: (await orderLineIds(plNo)).get(1)!, unitNo: 'CAX-41' })
    const confirm = await sp(nextOp('c41'), 'shipping.ship.confirm', { plantId: fx.szPlantId, shipmentOrderId: orderId })
    expect((confirm.data as { actualAxisSyncStatus: string }).actualAxisSyncStatus).toBe('noop_needed')
    expect((confirm.data as { shippingStatusSyncStatus: string }).shippingStatusSyncStatus).toBe('pending')
    const axisTask = await pool.query<{ status: string; task_kind: string }>(
      `SELECT status, task_kind FROM outbox WHERE aggregate_type = 'shipment_order' AND aggregate_id = $1 AND task_kind = 'shipping.actual-axis-sync'`,
      [orderId],
    )
    expect(axisTask.rows).toHaveLength(1)
    expect(axisTask.rows[0]!.status).toBe('NOOP_NEEDED') // IF-00.4：无需同步不是失败态
    const statusTask = await pool.query<{ status: string }>(
      `SELECT status FROM outbox WHERE aggregate_type = 'shipment_order' AND aggregate_id = $1 AND task_kind = 'shipping.status-sync'`,
      [orderId],
    )
    expect(statusTask.rows).toHaveLength(1)
    expect(statusTask.rows[0]!.status).toBe('PENDING') // 两行独立
  })

  it('有差异→PENDING 任务行；两任务互不影响状态（status 先成功、actual 轴后失败再成功）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const plNo = `PL-${run}-4002`
    await sp(nextOp('pl42'), 'shipping.pl.inbound', {
      plantId: fx.szPlantId, plNo, salesOrderNo: `SO-${run}-4002`,
      lines: [{ lineNo: 1, lineKind: 'axis_item', materialCode: 'MAT-SHP-FIN', salesOrderLineNo: '10', customerAxisNo: 'CAX-42', standardSegmentLength: '1200.0000' }],
    })
    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [plNo]).then((r) => r.rows[0]!.id))
    await receiveUnit(`ACT-${run}-99`, 'qualified') // 实发轴号≠客户轴号 → 差异
    await sp(nextOp('s42'), 'shipping.scan.load', { plantId: fx.szPlantId, shipmentOrderId: orderId, lineId: (await orderLineIds(plNo)).get(1)!, unitNo: `ACT-${run}-99` })
    const confirm = await sp(nextOp('c42'), 'shipping.ship.confirm', { plantId: fx.szPlantId, shipmentOrderId: orderId })
    expect((confirm.data as { actualAxisSyncStatus: string }).actualAxisSyncStatus).toBe('pending')
    const axisTask = await pool.query<{ status: string }>(
      `SELECT status FROM outbox WHERE aggregate_type = 'shipment_order' AND aggregate_id = $1 AND task_kind = 'shipping.actual-axis-sync'`,
      [orderId],
    )
    expect(axisTask.rows[0]!.status).toBe('PENDING') // 有差异→PENDING 任务行

    // 发货状态重试成功：status 列 synced；actual 轴列与其任务行不受影响
    const statusRetry = await sp(nextOp('sy42a'), 'shipping.sync.status.retry', { plantId: fx.szPlantId, shipmentOrderId: orderId })
    expect(statusRetry.data).toMatchObject({ task: 'status-sync', status: 'synced', dispatched: true })
    const outRow = await pool.query<{ outbound_at: Date }>(`SELECT outbound_at FROM shipment_order WHERE id = $1`, [orderId])
    expect((statusRetry.data as { snapshot: { completedAt: string } }).snapshot.completedAt).toBe(
      outRow.rows[0]!.outbound_at.toISOString(),
    ) // IF-00.6：按出库完成时点快照重推
    const afterStatusRetry = await pool.query<{ actual_axis_sync_status: string; shipping_status_sync_status: string }>(
      `SELECT actual_axis_sync_status, shipping_status_sync_status FROM shipment_order WHERE id = $1`, [orderId],
    )
    expect(afterStatusRetry.rows[0]!.actual_axis_sync_status).toBe('pending') // 互不改变对方状态
    expect(afterStatusRetry.rows[0]!.shipping_status_sync_status).toBe('synced')

    // 实发轴重试失败→sync_failed；status 列保持 synced
    const axisFail = await sp(nextOp('sy42b'), 'shipping.sync.actual-axis.retry', { plantId: fx.szPlantId, shipmentOrderId: orderId, outcome: 'failure' })
    expect(axisFail.data).toMatchObject({ task: 'actual-axis-sync', status: 'sync_failed' })
    const mid = await pool.query<{ actual_axis_sync_status: string; shipping_status_sync_status: string }>(
      `SELECT actual_axis_sync_status, shipping_status_sync_status FROM shipment_order WHERE id = $1`, [orderId],
    )
    expect(mid.rows[0]!.actual_axis_sync_status).toBe('sync_failed')
    expect(mid.rows[0]!.shipping_status_sync_status).toBe('synced')
    // 实发轴重试成功→synced
    const axisOk = await sp(nextOp('sy42c'), 'shipping.sync.actual-axis.retry', { plantId: fx.szPlantId, shipmentOrderId: orderId })
    expect(axisOk.data).toMatchObject({ task: 'actual-axis-sync', status: 'synced' })
    const outboxRows = await pool.query<{ task_kind: string; status: string }>(
      `SELECT task_kind, status FROM outbox
       WHERE aggregate_type = 'shipment_order' AND aggregate_id = $1
         AND task_kind IN ('shipping.actual-axis-sync', 'shipping.status-sync')
       ORDER BY task_kind`,
      [orderId],
    )
    expect(outboxRows.rows.map((r) => `${r.task_kind}:${r.status}`)).toEqual([
      'shipping.actual-axis-sync:DISPATCHED',
      'shipping.status-sync:DISPATCHED',
    ])
  })
})

describe('⑤ 回传重试幂等（不重做已成功侧）', () => {
  it('已成功侧重试→skipped 不再派发（attempt_count 不变）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [`PL-${run}-4002`])).rows[0]!.id
    const before = await pool.query<{ task_kind: string; attempt_count: number }>(
      `SELECT task_kind, attempt_count FROM outbox WHERE aggregate_type = 'shipment_order' AND aggregate_id = $1`,
      [orderId],
    )
    const axisRetry = await sp(nextOp('idem1'), 'shipping.sync.actual-axis.retry', { plantId: fx.szPlantId, shipmentOrderId: orderId })
    expect(axisRetry.data).toMatchObject({ task: 'actual-axis-sync', skipped: true, dispatched: false })
    const statusRetry = await sp(nextOp('idem2'), 'shipping.sync.status.retry', { plantId: fx.szPlantId, shipmentOrderId: orderId })
    expect(statusRetry.data).toMatchObject({ task: 'status-sync', skipped: true, dispatched: false })
    const after = await pool.query<{ task_kind: string; attempt_count: number }>(
      `SELECT task_kind, attempt_count FROM outbox WHERE aggregate_type = 'shipment_order' AND aggregate_id = $1`,
      [orderId],
    )
    expect(after.rows).toEqual(before.rows) // 不重做已成功侧：任务行状态与次数零变化
  })

  it('NOOP_NEEDED 终态重试同样跳过', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [`PL-${run}-4001`])).rows[0]!.id
    const retry = await sp(nextOp('idem3'), 'shipping.sync.actual-axis.retry', { plantId: fx.szPlantId, shipmentOrderId: orderId })
    expect(retry.data).toMatchObject({ task: 'actual-axis-sync', skipped: true, status: 'noop_needed' })
  })
})

describe('⑥ 补码计入已扫件数（A-T14-5）', () => {
  it('无轴行 1 装入+1 补码→已扫 2/应扫 2→已装箱；确认出库仅对实码记账', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const plNo = `PL-${run}-5001`
    await sp(nextOp('pl51'), 'shipping.pl.inbound', {
      plantId: fx.szPlantId, plNo, salesOrderNo: `SO-${run}-5001`,
      lines: [{ lineNo: 1, lineKind: 'plain_item', materialCode: 'MAT-SHP-PART', salesOrderLineNo: '10', segmentLength: '30.0000', requiredCount: 2 }],
    })
    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [plNo])).rows[0]!.id
    const lineId = (await orderLineIds(plNo)).get(1)!
    await receiveUnit(`U-${run}-SUP1`, 'qualified')
    await sp(nextOp('sup1'), 'shipping.scan.load', { plantId: fx.szPlantId, shipmentOrderId: orderId, lineId, unitNo: `U-${run}-SUP1` })
    const supplement = await sp(nextOp('sup2'), 'shipping.scan.supplement', {
      plantId: fx.szPlantId, shipmentOrderId: orderId, lineId, unitNo: `SUP-${run}-AX9`, // 缺产品轴号→扫码补轴号（无数量输入）
    })
    expect(supplement.status).toBe(CommandResultStatus.COMMITTED)
    expect(supplement.data).toMatchObject({ scanKind: 'supplement', scannedCount: 2, requiredCount: 2, lineStatus: 'packed', orderStatus: 'ready_to_ship' })
    const scanRow = await pool.query<{ scan_kind: string; inventory_unit_id: string | null }>(
      `SELECT scan_kind, inventory_unit_id FROM packing_scan WHERE id = $1`, [(supplement.data as { scanId: string }).scanId],
    )
    expect(scanRow.rows[0]!.scan_kind).toBe('supplement')
    expect(scanRow.rows[0]!.inventory_unit_id).toBeNull() // 补码=轴号登记
    // 补码超应扫上限拒（C-7 fail-closed）
    const over = await sp(nextOp('sup3'), 'shipping.scan.supplement', {
      plantId: fx.szPlantId, shipmentOrderId: orderId, lineId, unitNo: `SUP-${run}-AX10`,
    })
    expect(over.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(over.errorMessage).toContain('A-T14-5')
    // 确认出库：仅实码（load 扫码）记账
    const confirm = await sp(nextOp('sup4'), 'shipping.ship.confirm', { plantId: fx.szPlantId, shipmentOrderId: orderId })
    expect((confirm.data as { postedUnits: number }).postedUnits).toBe(1)
  })
})

describe('⑦ 同 operationId 重放（原结果回放，不重复入账）', () => {
  it('PL 入站/扫码/确认出库 同 opId 重放 → 原结果、零重复', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const opPl = nextOp('rpl')
    const plNo = `PL-${run}-7001`
    const firstPl = await sp(opPl, 'shipping.pl.inbound', {
      plantId: fx.szPlantId, plNo, salesOrderNo: `SO-${run}-7001`,
      lines: [{ lineNo: 1, lineKind: 'axis_item', materialCode: 'MAT-SHP-FIN', salesOrderLineNo: '10', customerAxisNo: 'CAX-71', standardSegmentLength: '1200.0000' }],
    })
    expect(firstPl.status).toBe(CommandResultStatus.COMMITTED)
    const replayPl = await sp(opPl, 'shipping.pl.inbound', {
      plantId: fx.szPlantId, plNo, salesOrderNo: `SO-${run}-7001`,
      lines: [{ lineNo: 1, lineKind: 'axis_item', materialCode: 'MAT-SHP-FIN', salesOrderLineNo: '10', customerAxisNo: 'CAX-71', standardSegmentLength: '1200.0000' }],
    })
    expect(replayPl.status).toBe(CommandResultStatus.COMMITTED)
    expect(replayPl.data).toEqual(firstPl.data) // 原结果回放
    expect((await pool.query(`SELECT count(*)::int AS c FROM shipment_order WHERE pl_no = $1`, [plNo])).rows[0]!.c).toBe(1)

    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_order WHERE pl_no = $1`, [plNo])).rows[0]!.id
    const lineId = (await orderLineIds(plNo)).get(1)!
    await receiveUnit('CAX-71', 'qualified')
    const opScan = nextOp('rsc')
    const firstScan = await sp(opScan, 'shipping.scan.load', { plantId: fx.szPlantId, shipmentOrderId: orderId, lineId, unitNo: 'CAX-71' })
    const replayScan = await sp(opScan, 'shipping.scan.load', { plantId: fx.szPlantId, shipmentOrderId: orderId, lineId, unitNo: 'CAX-71' })
    expect(replayScan.data).toEqual(firstScan.data)
    expect((await pool.query(`SELECT count(*)::int AS c FROM packing_scan WHERE shipment_order_id = $1 AND NOT deleted`, [orderId])).rows[0]!.c).toBe(1)

    const opConfirm = nextOp('rcf')
    const firstConfirm = await sp(opConfirm, 'shipping.ship.confirm', { plantId: fx.szPlantId, shipmentOrderId: orderId })
    expect(firstConfirm.status).toBe(CommandResultStatus.COMMITTED)
    const txnBefore = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM stock_transaction WHERE ref_type = 'shipment_order' AND ref_id = $1`, [orderId],
    )
    const replayConfirm = await sp(opConfirm, 'shipping.ship.confirm', { plantId: fx.szPlantId, shipmentOrderId: orderId })
    expect(replayConfirm.data).toEqual(firstConfirm.data) // 原结果回放
    const txnAfter = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM stock_transaction WHERE ref_type = 'shipment_order' AND ref_id = $1`, [orderId],
    )
    expect(txnAfter.rows[0]!.c).toBe(txnBefore.rows[0]!.c) // 零重复记账
  })
})
