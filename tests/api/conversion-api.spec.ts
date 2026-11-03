import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, ERROR_CODES } from '@cadenza/contracts'
import { validateEnv } from '../../apps/api/src/env'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { DbModule } from '../../apps/api/src/db/db.module'
import { ConversionModule } from '../../apps/api/src/conversion/conversion.module'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import {
  CV_OWNER_ID,
  CV_OWNER_NAME,
  CV_TEST_DB_NAME,
  CV_UOM_ID,
  type CvFixtures,
  cvDatabaseUrl,
  prepareCvTestDatabase,
  seedCvFixtures,
  seedCustomerSegment,
  seedPalletBinding,
  seedSegments,
  seedProductionOrder,
  seedUnitOwner,
} from './conversion-test-env'

/**
 * conversionform API 集成（真容器独立库 cadenza_conversion + supertest 自组装挂载
 * ConfigModule/DbModule/AuthModule/ConversionModule——不挂共享 app.module.ts，
 * L0 整合步统一注册）。
 *
 * 端点级证据（合同 form-conversion.md）：
 * - FC-17 候选源（无托单轴行/有托按托汇总、线边仓排除）；
 * - FC-05/06/01 协议A建单/编辑删除门/采购单入口禁用；
 * - FC-07/08/09/12 扫码五拒一成、完成本地先执行、状态两列分立、重试门；
 * - FC-13/14/15/16/18/20/21 协议B链路步进、六态投影、改码形状、占用与锁定冲突、列表聚合；
 * - OA-24/25/A-S1 跨厂 403 与服务端过滤；许可缺失 403；未鉴权 401；命令幂等。
 * A09 三类故障注入与恢复路径证据见 tests/integration/conversion-flow.spec.ts。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let fx: CvFixtures
let szPlantId = ''
const run = `apcv${Date.now().toString(36)}`.slice(0, 8)
/** 10 位载具码：类型位 E（第 2 位）＋ 4 位运行标识 ＋ 4 位序号（FC-07 长度/类型位）。 */
const tag = (n: number): string => `1E${run.slice(0, 4)}${String(n).padStart(4, '0')}`

beforeAll(async () => {
  try {
    pool = await prepareCvTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP conversion api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${CV_TEST_DB_NAME}）。`)
    return
  }
  fx = await seedCvFixtures(pool) // 幂等（ON CONFLICT DO UPDATE），取回夹具 id
  szPlantId = fx.szPlantId

  process.env['DATABASE_URL'] = cvDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, AuthModule, ConversionModule],
  }).compile()
  app = moduleRef.createNestApplication()
  await app.init()
})

afterAll(async () => {
  if (app) await app.close()
  if (pool) await pool.end()
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

async function login(loginName: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ loginName, password, platform: 'WEB' })
  expect(res.status).toBe(200)
  return res.body.token as string
}

let inventoryBus: ReturnType<typeof buildInventoryCommandBus>

/** 经真实命令链接收一颗库存单元（inventory.receive-goods；返回 unitId）。 */
async function receiveUnit(unitNo: string, locationId: string, locationCode: string, materialCode: string, materialId: string): Promise<string> {
  const admin = await pool.query<{ id: string; enterprise_id: string }>(`SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`)
  const r = await inventoryBus.execute(
    {
      operationId: `${run}-rcv-${unitNo}`,
      commandType: 'inventory.receive-goods',
      targetId: 'new',
      expectedRevision: 0,
      payload: {
        plantId: szPlantId,
        quantity: '100.0000',
        uomId: CV_UOM_ID,
        uomCode: 'KG',
        locationId,
        locationCode,
        ownerId: CV_OWNER_ID,
        ownerName: CV_OWNER_NAME,
        lotNo: `LOT-${run}-${unitNo}`,
        materialId,
        materialCode,
        unitNo,
        qualityStatus: 'qualified',
      },
    },
    { actorUserId: admin.rows[0]!.id, actorLoginName: 'admin', enterpriseId: admin.rows[0]!.enterprise_id, reason: null },
  )
  expect(r.status).toBe(CommandResultStatus.COMMITTED)
  return (r.data as { unitId: string }).unitId
}

describe('conversion API：夹具与协议A/B 端到端证据', () => {
  let adminToken = ''
  // 生产订单锚点（协议A）
  let srcOrder = { orderId: '', operationId: '' }
  let tgtOrder = { orderId: '', operationId: '' }
  let altOrder = { orderId: '', operationId: '' }
  let purchaseOrderId = ''
  // 单元（unitNo → unitId）
  const units = new Map<string, string>()

  beforeAll(async () => {
    if (!dbAvailable) return
    inventoryBus = buildInventoryCommandBus(pool)
    adminToken = await login('admin', 'CadAdmin001')
    srcOrder = await seedProductionOrder(pool, fx, { orderNo: `PO-${run}-SRC`, salesOrderNo: `SO-${run}-S`, lineNo: '10' })
    tgtOrder = await seedProductionOrder(pool, fx, { orderNo: `PO-${run}-TGT`, salesOrderNo: `SO-${run}-T`, lineNo: '20' })
    altOrder = await seedProductionOrder(pool, fx, { orderNo: `PO-${run}-ALT`, salesOrderNo: `SO-${run}-A`, lineNo: '30' })
    purchaseOrderId = (
      await pool.query<{ id: string }>(
        `INSERT INTO purchase_order (order_no, org_code, plant_id, enterprise_id, created_by)
         VALUES ($1, 'ORG-CV', $2, $3, 'seed-cv') RETURNING id`,
        [`PO-${run}-PUR`, szPlantId, fx.enterpriseId],
      )
    ).rows[0]!.id
    // u1/u2/u3/u5/u6：仓库位（协议B 可选源）；u1/u3 归属源订单、u2 归属目标订单、u4 线边位
    for (const n of [1, 2, 3, 5, 6]) {
      const unitNo = tag(n)
      const unitId = await receiveUnit(unitNo, fx.warehouseLocationId, fx.warehouseLocationCode, 'MAT-CV-FIN', fx.materialId)
      units.set(unitNo, unitId)
    }
    const u4 = tag(4)
    units.set(u4, await receiveUnit(u4, fx.lineSideLocationId, fx.lineSideLocationCode, 'MAT-CV-FIN', fx.materialId))
    const uR = `1R${run.slice(0, 4)}0090`
    units.set(uR, await receiveUnit(uR, fx.warehouseLocationId, fx.warehouseLocationCode, 'MAT-CV-FIN', fx.materialId))
    // 码归属：u1/u3/u5/u6 → 源订单；u2 → 目标订单（归属不符证据）
    for (const n of [1, 3, 5, 6]) {
      await seedUnitOwner(pool, fx, { orderId: srcOrder.orderId, operationId: srcOrder.operationId, unitId: units.get(tag(n))!, quantity: '100.0000' })
    }
    await seedUnitOwner(pool, fx, { orderId: tgtOrder.orderId, operationId: tgtOrder.operationId, unitId: units.get(tag(2))!, quantity: '100.0000' })
  })

  it('FC-17：候选源——仓库型仓在库单轴一行；绑定托盘后按托汇总一行（产品轴号 null）；线边仓排除', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const before = await request(app.getHttpServer())
      .get(`/conversion/stock/candidates?plantId=${szPlantId}&materialId=${fx.materialId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(before.status).toBe(200)
    const axisBefore = before.body as Array<{ groupKind: string; productAxisNo: string | null }>
    const axisRows = axisBefore.filter((r) => r.groupKind === 'axis')
    expect(axisRows.some((r) => r.productAxisNo === tag(1))).toBe(true)
    expect(axisRows.some((r) => r.productAxisNo === tag(2))).toBe(true)
    expect(axisRows.some((r) => r.productAxisNo === tag(4))).toBe(false) // 线边仓排除（FC-17）

    await seedSegments(pool, fx, { unitId: units.get(tag(1))!, count: 2 })
    await seedPalletBinding(pool, fx, { palletCode: `PLT-${run}-01`, unitId: units.get(tag(1))! })
    const after = await request(app.getHttpServer())
      .get(`/conversion/stock/candidates?plantId=${szPlantId}&materialId=${fx.materialId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    const palletRow = (after.body as Array<{ groupKind: string; palletCode: string | null; axisCount: number; productAxisNo: string | null; quantity: string }>)
      .find((r) => r.groupKind === 'pallet' && r.palletCode === `PLT-${run}-01`)
    expect(palletRow).toBeDefined()
    expect(palletRow!.axisCount).toBe(2) // 有托=按托汇总一行，轴数=分段轴数
    expect(palletRow!.productAxisNo).toBe(null) // 产品轴号显示 `-`
    expect(palletRow!.quantity).toBe('100.0000')
    const afterRows = after.body as Array<{ productAxisNo: string | null }>
    expect(afterRows.some((r) => r.productAxisNo === tag(1))).toBe(false) // 有托后不再单轴一行
  })

  it('FC-05/FC-01：建单——同料品不同订单、数量定点；重复销售行/同一订单/数量 number/采购单锚点 → 422/404', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const ok = await request(app.getHttpServer())
      .post('/conversion/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        lines: [{ sourceOrderId: srcOrder.orderId, targetOrderId: tgtOrder.orderId, targetProjectNo: `PRJ-${run}-T`, quantity: '100.0000' }],
      })
    expect(ok.status).toBe(201)
    expect(ok.body.data.conversionNo).toMatch(/^CV/)
    expect(ok.body.data.status).toBe('pending')
    expect(ok.body.data.syncStatus).toBe('pending')
    expect(ok.body.data.lines).toHaveLength(1)

    const sameOrder = await request(app.getHttpServer())
      .post('/conversion/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        lines: [{ sourceOrderId: srcOrder.orderId, targetOrderId: srcOrder.orderId, targetProjectNo: 'PRJ-X', quantity: '1.0000' }],
      })
    expect(sameOrder.status).toBe(422)
    expect(sameOrder.body.message).toContain('[FC-05]')

    const dupSalesLine = await request(app.getHttpServer())
      .post('/conversion/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        lines: [
          { sourceOrderId: srcOrder.orderId, targetOrderId: tgtOrder.orderId, targetProjectNo: 'PRJ-X', quantity: '1.0000' },
          { sourceOrderId: srcOrder.orderId, targetOrderId: altOrder.orderId, targetProjectNo: 'PRJ-Y', quantity: '2.0000' },
        ],
      })
    expect(dupSalesLine.status).toBe(422)
    expect(dupSalesLine.body.message).toContain('同一销售单号＋行号')

    const qtyNumber = await request(app.getHttpServer())
      .post('/conversion/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        lines: [{ sourceOrderId: srcOrder.orderId, targetOrderId: tgtOrder.orderId, targetProjectNo: 'PRJ-X', quantity: 100 }],
      })
    expect(qtyNumber.status).toBe(422)

    // FC-01：采购单入口禁用——采购单 id 不是生产订单锚点 → 404（生产订单为唯一锚点）
    const purchaseAnchor = await request(app.getHttpServer())
      .post('/conversion/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        lines: [{ sourceOrderId: purchaseOrderId, targetOrderId: tgtOrder.orderId, targetProjectNo: 'PRJ-X', quantity: '1.0000' }],
      })
    expect(purchaseAnchor.status).toBe(404)
    expect(purchaseAnchor.body.message).toContain('采购单入口禁用')
  })

  it('FC-07/FC-08/FC-12：扫码五拒一成→完成本地先执行→状态两列分立；重试门 FC-09', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const created = await request(app.getHttpServer())
      .post('/conversion/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        lines: [{ sourceOrderId: srcOrder.orderId, targetOrderId: tgtOrder.orderId, targetProjectNo: `PRJ-${run}-T2`, quantity: '200.0000' }],
      })
    const conversionId = created.body.data.conversionId as string
    const lineId = created.body.data.lines[0].lineId as string

    // 五拒：R 型码 / 重复码 / 归属不符 / 段长已用 / 无选择项
    const rCode = await request(app.getHttpServer())
      .post('/conversion/order/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: conversionId, lineId, unitNo: `1R${run}09`, segmentLength: '11.0000' })
    expect(rCode.status).toBe(422)
    expect(rCode.body.message).toContain('E/F/M/P')

    const scan1 = await request(app.getHttpServer())
      .post('/conversion/order/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: conversionId, lineId, unitNo: tag(1), segmentLength: '12.5000' })
    expect(scan1.status).toBe(200)
    expect(scan1.body.data.scannedAxes).toBe(1)

    const dup = await request(app.getHttpServer())
      .post('/conversion/order/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: conversionId, lineId, unitNo: tag(1), segmentLength: '13.0000' })
    expect(dup.status).toBe(422)
    expect(dup.body.message).toContain('[FC-07]')

    const wrongOwner = await request(app.getHttpServer())
      .post('/conversion/order/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: conversionId, lineId, unitNo: tag(2), segmentLength: '14.0000' })
    expect(wrongOwner.status).toBe(422)
    expect(wrongOwner.body.message).toContain('不属于转换前订单')

    const segUsed = await request(app.getHttpServer())
      .post('/conversion/order/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: conversionId, lineId, unitNo: tag(3), segmentLength: '12.5000' })
    expect(segUsed.status).toBe(422)
    expect(segUsed.body.message).toContain('段长')

    const noChoice = await request(app.getHttpServer())
      .post('/conversion/order/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: conversionId, lineId, unitNo: tag(3) })
    expect(noChoice.status).toBe(422)

    // 一成：u3 选客户轴号
    const scan3 = await request(app.getHttpServer())
      .post('/conversion/order/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: conversionId, lineId, unitNo: tag(3), customerAxisNo: `CAX-${run}-1` })
    expect(scan3.status).toBe(200)
    expect(scan3.body.data.scannedAxes).toBe(2)

    // FC-06：有扫码 → 编辑/删除拒
    const editRejected = await request(app.getHttpServer())
      .post('/conversion/order/update')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: conversionId, lines: [{ sourceOrderId: srcOrder.orderId, targetOrderId: tgtOrder.orderId, targetProjectNo: `PRJ-${run}-T2`, quantity: '300.0000' }] })
    expect(editRejected.status).toBe(422)
    expect(editRejected.body.message).toContain('[FC-06]')
    const delRejected = await request(app.getHttpServer())
      .post('/conversion/order/delete')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: conversionId })
    expect(delRejected.status).toBe(422)
    expect(delRejected.body.message).toContain('[FC-06]')

    // FC-08：完成=本地先执行（归属改转换后订单 + 预留释放）
    const complete = await request(app.getHttpServer())
      .post('/conversion/order/complete')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: conversionId })
    expect(complete.status).toBe(200)
    expect(complete.body.data.status).toBe('completed')
    expect(complete.body.data.syncStatus).toBe('pending') // FC-12：与转换状态两列独立
    const assignments = complete.body.data.assignments as Array<{ unitNo: string; fromOrderId: string; toOrderId: string }>
    expect(assignments).toHaveLength(2)
    for (const a of assignments) {
      expect(a.fromOrderId).toBe(srcOrder.orderId)
      expect(a.toOrderId).toBe(tgtOrder.orderId)
    }
    const lockedAfter = await pool.query(`SELECT count(*)::int AS c FROM reservation WHERE unit_id = ANY($1) AND status = 'active'`, [
      [units.get(tag(1)), units.get(tag(3))],
    ])
    expect(lockedAfter.rows[0]!.c).toBe(0)
    const outboxRows = await pool.query<{ task_kind: string }>(
      `SELECT task_kind FROM outbox WHERE aggregate_type = 'conversion_order' AND aggregate_id = $1`,
      [conversionId],
    )
    expect(outboxRows.rows.map((r) => r.task_kind).sort()).toEqual(['form_conversion.inventory-stats', 'form_conversion_push']) // FC-S4

    // 列表两列独立投影（FC-12）
    const list = await request(app.getHttpServer())
      .get(`/conversion/orders?plantId=${szPlantId}&statuses=completed`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(list.status).toBe(200)
    const row = (list.body.items as Array<{ conversionId: string; status: string; syncStatus: string; statusLabel: string; syncStatusLabel: string }>)
      .find((o) => o.conversionId === conversionId)
    expect(row).toBeDefined()
    expect(row!.status).toBe('completed')
    expect(row!.syncStatus).toBe('pending')
    expect(row!.statusLabel).toBe('已完成')
    expect(row!.syncStatusLabel).toBe('未同步')

    // FC-09：仅已完成且同步失败可重试（当前未同步 → 拒）
    const retryRejected = await request(app.getHttpServer())
      .post('/conversion/order/sync-retry')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: conversionId })
    expect(retryRejected.status).toBe(422)
    expect(retryRejected.body.message).toContain('[FC-09]')

    // FC-06/FC-07：删码解锁并重算 + 无扫码单可删
    const order2 = await request(app.getHttpServer())
      .post('/conversion/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        lines: [{ sourceOrderId: srcOrder.orderId, targetOrderId: tgtOrder.orderId, targetProjectNo: `PRJ-${run}-T3`, quantity: '100.0000' }],
      })
    const cid2 = order2.body.data.conversionId as string
    const lid2 = order2.body.data.lines[0].lineId as string
    const scanU5 = await request(app.getHttpServer())
      .post('/conversion/order/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: cid2, lineId: lid2, unitNo: tag(5), segmentLength: '15.0000' })
    expect(scanU5.status).toBe(200)
    const scanId = scanU5.body.data.scanId as string

    // FC-20：u5 被协议A扫码锁定 → 协议B选入被拒（后提交方冲突拒绝）
    const stockLocked = await request(app.getHttpServer())
      .post('/conversion/stock/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        materialId: fx.materialId,
        targetSalesOrderNo: `SO-${run}-X`,
        targetLineNo: '99',
        targetBatchNo: `B-${run}-X`,
        lines: [{ unitNo: tag(5), segmentLength: '15.0000' }],
      })
    expect(stockLocked.status).toBe(422)
    expect(stockLocked.body.message).toContain('[FC-20]')

    const scanDel = await request(app.getHttpServer())
      .post('/conversion/order/scan-delete')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: cid2, scanId })
    expect(scanDel.status).toBe(200)
    expect(scanDel.body.data.scannedAxes).toBe(0) // 删码解锁并重算
    // FC-06：扫码事实 append-only——有扫码留痕（含已删码）的单不可删除；无扫码单可删
    const delAfterScanHistory = await request(app.getHttpServer())
      .post('/conversion/order/delete')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: cid2 })
    expect(delAfterScanHistory.status).toBe(422)
    expect(delAfterScanHistory.body.message).toContain('[FC-06]')
    const clean = await request(app.getHttpServer())
      .post('/conversion/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        lines: [{ sourceOrderId: srcOrder.orderId, targetOrderId: tgtOrder.orderId, targetProjectNo: `PRJ-${run}-T5`, quantity: '100.0000' }],
      })
    const delClean = await request(app.getHttpServer())
      .post('/conversion/order/delete')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: clean.body.data.conversionId })
    expect(delClean.status).toBe(200) // 无扫码单删除（主单及明细）
    const linesGone = await pool.query(`SELECT count(*)::int AS c FROM conversion_order_line WHERE conversion_order_id = $1`, [
      clean.body.data.conversionId,
    ])
    expect(linesGone.rows[0]!.c).toBe(0) // 删除主单及明细
  })

  it('FC-13/14/15/16/18/20/21：协议B 链路（外部失败/未知→人工核对→成功→本地失败→重同步）与占用/锁定', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // FC-17：线边仓单元拒收
    const lineSide = await request(app.getHttpServer())
      .post('/conversion/stock/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        materialId: fx.materialId,
        targetSalesOrderNo: `SO-${run}-L`,
        targetLineNo: '10',
        targetBatchNo: `B-${run}-L`,
        lines: [{ unitNo: tag(4), segmentLength: '10.0000' }],
      })
    expect(lineSide.status).toBe(422)
    expect(lineSide.body.message).toContain('线边仓')

    // FC-18：批次号缺失拒
    const noBatch = await request(app.getHttpServer())
      .post('/conversion/stock/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        materialId: fx.materialId,
        targetSalesOrderNo: `SO-${run}-NB`,
        targetLineNo: '10',
        lines: [{ unitNo: tag(6), segmentLength: '10.0000' }],
      })
    expect(noBatch.status).toBe(422)
    expect(noBatch.body.message).toContain('[FC-18]')

    // FC-01 两协议分立：库存转换单号 CVS 前缀；FC-14 首次落单内部态=待执行、展示=转换失败
    const created = await request(app.getHttpServer())
      .post('/conversion/stock/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        materialId: fx.materialId,
        targetProjectNo: `PRJ-${run}-B`,
        targetSalesOrderNo: `SO-${run}-B`,
        targetLineNo: '10',
        targetBatchNo: `B-${run}-B`,
        lines: [{ unitNo: tag(6), segmentLength: '16.0000', sourceVirtualAxisNo: `V-${run}-6` }],
      })
    expect(created.status).toBe(201)
    expect(created.body.data.conversionNo).toMatch(/^CVS/)
    expect(created.body.data.internalStatus).toBe('pending_execute')
    expect(created.body.data.displayStatus).toBe('convert_failed') // 展示名≠内部态（FC-14）
    const stockId = created.body.data.conversionId as string

    // u6 被未完成库存转换单占用 → 协议A扫入被拒（FC-20 跨协议复核）＋ 第二张库存单被拒（FC-18）
    // 模拟预留已释放（锁定到期）仍占用的态，验证"未转换成功单据不可再添加"的复核分支
    await pool.query(`UPDATE reservation SET status = 'released', released_at = now() WHERE unit_id = $1`, [units.get(tag(6))])
    const scanOccupied = await request(app.getHttpServer())
      .post('/conversion/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        lines: [{ sourceOrderId: srcOrder.orderId, targetOrderId: tgtOrder.orderId, targetProjectNo: `PRJ-${run}-T4`, quantity: '100.0000' }],
      })
    const cidOcc = scanOccupied.body.data.conversionId as string
    const lidOcc = scanOccupied.body.data.lines[0].lineId as string
    const scanRejected = await request(app.getHttpServer())
      .post('/conversion/order/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: cidOcc, lineId: lidOcc, unitNo: tag(6), segmentLength: '17.0000' })
    expect(scanRejected.status).toBe(422)
    expect(scanRejected.body.message).toContain('[FC-20]')
    await request(app.getHttpServer())
      .post('/conversion/order/delete')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionOrderId: cidOcc })

    const occupied = await request(app.getHttpServer())
      .post('/conversion/stock/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        materialId: fx.materialId,
        targetSalesOrderNo: `SO-${run}-B2`,
        targetLineNo: '10',
        targetBatchNo: `B-${run}-B2`,
        lines: [{ unitNo: tag(6), segmentLength: '16.0000' }],
      })
    expect(occupied.status).toBe(422)
    expect(occupied.body.message).toContain('未转换成功')

    // ② 派发（仅待执行；重发拒——防 U9 两张单）
    const push = await request(app.getHttpServer())
      .post('/conversion/stock/push')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionStockOrderId: stockId })
    expect(push.status).toBe(200)
    expect(push.body.data.internalStatus).toBe('external_processing')
    expect(push.body.data.idempotencyKey).toBe(stockId) // 幂等键=聚合身份，不换键（FC-03）
    const repush = await request(app.getHttpServer())
      .post('/conversion/stock/push')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionStockOrderId: stockId })
    expect(repush.status).toBe(422)
    expect(repush.body.message).toContain('[FC-13]')

    // ② 外部失败：保持转换失败（展示）并记录原因
    const failed = await request(app.getHttpServer())
      .post('/conversion/stock/push-result')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionStockOrderId: stockId, outcome: 'failure', failureReason: 'U9 返回失败（api 用例）' })
    expect(failed.status).toBe(200)
    expect(failed.body.data.internalStatus).toBe('pending_recovery')
    expect(failed.body.data.displayStatus).toBe('convert_failed')

    // FC-15：U9 未成功不可本地应用/重新同步
    const applyRejected = await request(app.getHttpServer())
      .post('/conversion/stock/local-apply')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionStockOrderId: stockId })
    expect(applyRejected.status).toBe(422)
    expect(applyRejected.body.message).toContain('[FC-15]')

    // FC-15：重新转换（转换失败单）——原单 id 更新、状态重置待执行
    const reconvert = await request(app.getHttpServer())
      .post('/conversion/stock/reconvert')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        conversionStockOrderId: stockId,
        targetBatchNo: `B-${run}-B-V2`,
        lines: [{ unitNo: tag(6), segmentLength: '18.5000', sourceVirtualAxisNo: `V-${run}-6` }],
      })
    expect(reconvert.status).toBe(200)
    expect(reconvert.body.data.conversionId).toBe(stockId) // 原单 id 更新
    expect(reconvert.body.data.internalStatus).toBe('pending_execute')

    // 重走链路：派发 → 超时未知（FC-03 中间态）→ 人工核对成功 → 本地失败 → 重新同步成功
    expect(
      (
        await request(app.getHttpServer())
          .post('/conversion/stock/push')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ plantId: szPlantId, conversionStockOrderId: stockId })
      ).status,
    ).toBe(200)
    const unknown = await request(app.getHttpServer())
      .post('/conversion/stock/push-result')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionStockOrderId: stockId, outcome: 'unknown' })
    expect(unknown.status).toBe(200)
    expect(unknown.body.data.internalStatus).toBe('manual_processing')
    expect(unknown.body.data.displayStatus).toBe('convert_failed')
    const unknownRow = await pool.query<{ external_push_status: string }>(
      `SELECT external_push_status FROM conversion_stock_order WHERE id = $1`,
      [stockId],
    )
    expect(unknownRow.rows[0]!.external_push_status).toBe('unknown')
    // 人工核对前不可盲重发/本地应用（FC-03/FC-15）
    expect(
      (
        await request(app.getHttpServer())
          .post('/conversion/stock/reconvert')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ plantId: szPlantId, conversionStockOrderId: stockId })
      ).status,
    ).toBe(422)

    const success = await request(app.getHttpServer())
      .post('/conversion/stock/push-result')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionStockOrderId: stockId, outcome: 'success', externalDocNo: `U9-${run}-1` })
    expect(success.status).toBe(200)
    expect(success.body.data.internalStatus).toBe('local_processing')
    expect(success.body.data.u9Success).toBe(true)

    // ③ 本地失败（A09 本地失败注入）：不回滚 U9 已成功标记，待恢复+展示同步失败
    const localFail = await request(app.getHttpServer())
      .post('/conversion/stock/local-apply')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionStockOrderId: stockId, outcome: 'failure' })
    expect(localFail.status).toBe(200)
    expect(localFail.body.data.internalStatus).toBe('pending_recovery')
    expect(localFail.body.data.displayStatus).toBe('sync_failed')
    expect(localFail.body.data.localApplyStatus).toBe('failed')

    // ④ 重新同步（只做本地、不再推 U9）→ 完成；改码事实 FC-16
    const resync = await request(app.getHttpServer())
      .post('/conversion/stock/resync')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, conversionStockOrderId: stockId })
    expect(resync.status).toBe(200)
    expect(resync.body.data.repushedU9).toBe(false)
    expect(resync.body.data.internalStatus).toBe('completed')
    expect(resync.body.data.displayStatus).toBe('convert_success')
    const pushCount = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM outbox WHERE aggregate_type = 'conversion_stock_order' AND aggregate_id = $1 AND task_kind = 'form_conversion_push'`,
      [stockId],
    )
    expect(Number(pushCount.rows[0]!.c)).toBe(2) // 两次派发（失败重转后重走），无第三张外发（FC-03/FC-15）

    const detail = await request(app.getHttpServer())
      .get(`/conversion/stock-orders/${stockId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(detail.status).toBe(200)
    expect(detail.body.targetProjectNo).toBe(`PRJ-${run}-B`) // 项目号只记单据（FC-16）
    const rewrites = detail.body.rewrites as Array<Record<string, unknown>>
    expect(rewrites).toHaveLength(1)
    expect(rewrites[0]!['oldVirtualAxisNo']).toBe(`V-${run}-6`)
    expect(rewrites[0]!['virtualAxisCleared']).toBe(true) // 清空虚拟轴号
    expect(rewrites[0]!['newSalesOrderNo']).toBe(`SO-${run}-B`)
    expect(Object.keys(rewrites[0]!).some((k) => k.toLowerCase().includes('project'))).toBe(false) // 改码无项目号字段——码上项目号不变

    // FC-21：列表转换数量=明细数量之和、转换轴数=明细行数
    const stockList = await request(app.getHttpServer())
      .get(`/conversion/stock-orders?plantId=${szPlantId}&displayStatuses=convert_success`)
      .set('Authorization', `Bearer ${adminToken}`)
    const stockRow = (stockList.body.items as Array<{ conversionId: string; totalQty: string; axisCount: number }>)
      .find((o) => o.conversionId === stockId)
    expect(stockRow).toBeDefined()
    expect(stockRow!.totalQty).toBe('100.0000')
    expect(stockRow!.axisCount).toBe(1)

    // 完成后占用释放：u6 可再次进入新单（FC-S3 未完成唯一失效）
    const again = await request(app.getHttpServer())
      .post('/conversion/stock/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        materialId: fx.materialId,
        targetSalesOrderNo: `SO-${run}-B3`,
        targetLineNo: '10',
        targetBatchNo: `B-${run}-B3`,
        lines: [{ unitNo: tag(6), segmentLength: '19.0000' }],
      })
    expect(again.status).toBe(201)
  })

  it('FC-19：客户轴段来源事实随候选源带出（按原销售单补订单信息）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await seedCustomerSegment(pool, fx, { unitId: units.get(tag(2))!, orderNo: `SO-${run}-CUST`, customerRef: `CAX-${run}-C` })
    const res = await request(app.getHttpServer())
      .get(`/conversion/stock/candidates?plantId=${szPlantId}&materialId=${fx.materialId}&unitNoLike=${tag(2)}`)
      .set('Authorization', `Bearer ${adminToken}`)
    const rows = res.body as Array<{ productAxisNo: string | null; salesOrderNo: string | null; customerAxisNo: string | null }>
    const row = rows.find((r) => r.productAxisNo === tag(2))
    expect(row).toBeDefined()
    expect(row!.salesOrderNo).toBe(`SO-${run}-CUST`)
    expect(row!.customerAxisNo).toBe(`CAX-${run}-C`)
  })

  it('OA-24/25/A-S1：跨厂 403 + 服务端过滤；命令二道防线；许可缺失 403；未鉴权 401', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    for (const path of [`/conversion/orders?plantId=${szPlantId}`, `/conversion/stock-orders?plantId=${szPlantId}`, `/conversion/stock/candidates?plantId=${szPlantId}&materialId=${fx.materialId}`]) {
      const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${hfToken}`)
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    }
    const hfList = await request(app.getHttpServer()).get('/conversion/orders').set('Authorization', `Bearer ${hfToken}`)
    expect(hfList.status).toBe(200)
    expect(hfList.body.total).toBe(0) // 不带参数 → 服务端过滤仅本厂（0 行）
    const adminToken2 = await login('admin', 'CadAdmin001')
    const adminList = await request(app.getHttpServer()).get('/conversion/orders').set('Authorization', `Bearer ${adminToken2}`)
    expect(adminList.status).toBe(200)
    expect(adminList.body.total).toBeGreaterThanOrEqual(1)

    const crossPlant = await request(app.getHttpServer())
      .post('/conversion/stock/push')
      .set('Authorization', `Bearer ${hfToken}`)
      .send({ plantId: szPlantId, conversionStockOrderId: '11111111-1111-4111-8111-111111111101' })
    expect(crossPlant.status).toBe(403)

    const noPerm = await login('szws01', 'SzWorkshop01')
    const forbidden = await request(app.getHttpServer()).get('/conversion/orders').set('Authorization', `Bearer ${noPerm}`)
    expect(forbidden.status).toBe(403)
    const anon = await request(app.getHttpServer()).get('/conversion/orders')
    expect(anon.status).toBe(401)
  })

  it('命令幂等：同 x-operation-id 建单重放原结果（不重复建单）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const body = {
      plantId: szPlantId,
      lines: [{ sourceOrderId: srcOrder.orderId, targetOrderId: tgtOrder.orderId, targetProjectNo: `PRJ-${run}-IDEM`, quantity: '50.0000' }],
    }
    const first = await request(app.getHttpServer())
      .post('/conversion/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-operation-id', `${run}-idem`)
      .send(body)
    expect(first.status).toBe(201)
    const replay = await request(app.getHttpServer())
      .post('/conversion/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-operation-id', `${run}-idem`)
      .send(body)
    expect(replay.status).toBe(201)
    expect(replay.body.data).toEqual(first.body.data)
    const rows = await pool.query(`SELECT count(*)::int AS c FROM conversion_order WHERE conversion_no = $1`, [
      first.body.data.conversionNo,
    ])
    expect(rows.rows[0]!.c).toBe(1)
  })
})
