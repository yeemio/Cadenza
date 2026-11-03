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
import { PurchaseModule } from '../../apps/api/src/purchase/purchase.module'
import {
  PURCHASE_TEST_DB_NAME,
  nodeId,
  preparePurchaseTestDatabase,
  purchaseDatabaseUrl,
} from './purchase-test-env'

/**
 * purchase API 集成（真容器独立库 cadenza_pur + supertest 挂载 PurchaseModule，无桩；
 * 测试组合 = ConfigModule/DbModule/AuthModule（全局守卫）/PurchaseModule——不改共享
 * app.module.ts，L0 整合步统一注册）。
 * 证据⑦：跨厂 403 与列表服务端过滤（OA-24/25 + A-S1）；另含端点级行为：
 * 订单同步/确认收货/质检结论/退货/复核端点、命令幂等、数量 number 拒绝。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
let hfPlantId = ''
let exemptMaterialId = ''
let qcMaterialId = ''
const run = `appur${Date.now().toString(36)}`

const OWNER = '22222222-2222-4222-8222-222222222201'
const OWNER_NAME = '华东电缆集团（自有）'
const UOM = '33333333-3333-4333-8333-3333333333c1'
const WH = '55555555-5555-4555-8555-555555555501'
const LOC = '11111111-1111-4111-8111-1111111111a1'
const LOC_CODE = 'SZ01-01-01'

beforeAll(async () => {
  try {
    pool = await preparePurchaseTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP purchase api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${PURCHASE_TEST_DB_NAME}）。`)
    return
  }
  szPlantId = await nodeId(pool, 'PLNT-SZ')
  hfPlantId = await nodeId(pool, 'PLNT-HF')
  const materials = await pool.query<{ code: string; id: string }>(
    `SELECT code, id FROM material WHERE code IN ('MAT-PUR-EXEMPT','MAT-PUR-QC')`,
  )
  exemptMaterialId = materials.rows.find((r) => r.code === 'MAT-PUR-EXEMPT')!.id
  qcMaterialId = materials.rows.find((r) => r.code === 'MAT-PUR-QC')!.id

  process.env['DATABASE_URL'] = purchaseDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      DbModule,
      AuthModule,
      PurchaseModule,
    ],
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

async function syncOrderViaApi(
  token: string,
  orderNo: string,
  materialId: string,
  materialCode: string,
  plantId = szPlantId,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .post('/purchase/orders/sync')
    .set('Authorization', `Bearer ${token}`)
    .send({
      operationId: `${run}-sync-${orderNo}`,
      orgCode: 'ORG-ERP-HD',
      orderNo,
      plantId,
      lines: [
        {
          lineNo: 1,
          materialId,
          materialCode,
          materialType: 1,
          uomCode: 'KG',
          plannedQty: '80.0000',
          overReceiptLimit: '100.0000',
          status: 1,
        },
      ],
    })
}

async function receiveViaApi(
  token: string,
  operationId: string,
  lineId: string,
  barcodeValue: string,
  quantity: string,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .post('/purchase/receive')
    .set('Authorization', `Bearer ${token}`)
    .send({
      operationId,
      plantId: szPlantId,
      orderLineId: lineId,
      arrivalTime: '2026-10-27T08:00:00.000Z',
      confirmTime: '2026-10-27T09:00:00.000Z',
      warehouseId: WH,
      warehouseCode: 'SZ-RAW-01',
      locationId: LOC,
      locationCode: LOC_CODE,
      ownerId: OWNER,
      ownerName: OWNER_NAME,
      uomId: UOM,
      uomCode: 'KG',
      unitPrice: '100.0000',
      details: [{ barcodeValue, quantity, supplierLotNo: `SL-${run}`, grade: 'TG-1' }],
    })
}

describe('⑦ 跨厂 403 与列表服务端过滤（OA-24/25 + A-S1）', () => {
  it('合肥厂管理员显式查苏州厂订单行/批次 → 403 ERR_FORBIDDEN_SCOPE；不带参数 → 服务端过滤仅本厂', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const admin = await login('admin', 'CadAdmin001')
    const hf = await login('hfadmin01', 'HfPlant0001')

    // 两厂各同步一张订单（苏州 admin + 合肥 admin 代录）并各收一批（合肥经本厂行）
    const szOrder = await syncOrderViaApi(admin, `PO-${run}-SZ`, qcMaterialId, 'MAT-PUR-QC')
    expect(szOrder.status).toBe(201)
    const szLineId = (szOrder.body.data.lines as Array<{ lineId: string }>)[0]!.lineId
    const hfOrder = await syncOrderViaApi(admin, `PO-${run}-HF`, exemptMaterialId, 'MAT-PUR-EXEMPT', hfPlantId)
    expect(hfOrder.status).toBe(201)
    const hfLineId = (hfOrder.body.data.lines as Array<{ lineId: string }>)[0]!.lineId

    const szBarcode = `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '1')}`
    const hfBarcode = `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '2')}`
    const r1 = await receiveViaApi(admin, `${run}-rcv-sz`, szLineId, szBarcode, '30.0000')
    expect(r1.status).toBe(201)
    expect(r1.body.status).toBe(CommandResultStatus.COMMITTED)
    // 合肥厂收货：载荷 plantId 换合肥厂
    const r2 = await request(app.getHttpServer())
      .post('/purchase/receive')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        operationId: `${run}-rcv-hf`,
        plantId: hfPlantId,
        orderLineId: hfLineId,
        arrivalTime: '2026-10-27T08:00:00.000Z',
        confirmTime: '2026-10-27T09:00:00.000Z',
        warehouseId: WH,
        locationId: LOC,
        locationCode: LOC_CODE,
        ownerId: OWNER,
        ownerName: OWNER_NAME,
        uomId: UOM,
        uomCode: 'KG',
        details: [{ barcodeValue: hfBarcode, quantity: '20.0000' }],
      })
    expect(r2.status).toBe(201)

    // 显式越范围参数 → 403
    const forbiddenLines = await request(app.getHttpServer())
      .get('/purchase/order-lines')
      .query({ plantId: szPlantId })
      .set('Authorization', `Bearer ${hf}`)
    expect(forbiddenLines.status).toBe(403)
    expect(forbiddenLines.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    const forbiddenBatches = await request(app.getHttpServer())
      .get('/purchase/batches')
      .query({ plantId: szPlantId })
      .set('Authorization', `Bearer ${hf}`)
    expect(forbiddenBatches.status).toBe(403)

    // 隐式列表 → 服务端过滤只剩合肥厂
    const own = await request(app.getHttpServer())
      .get('/purchase/order-lines')
      .set('Authorization', `Bearer ${hf}`)
    expect(own.status).toBe(200)
    expect(own.body.total).toBe(1)
    expect(own.body.items[0].orderNo).toBe(`PO-${run}-HF`)
    expect(own.body.items[0].plantId).toBe(hfPlantId)
    const ownBatches = await request(app.getHttpServer())
      .get('/purchase/batches')
      .set('Authorization', `Bearer ${hf}`)
    expect(ownBatches.status).toBe(200)
    expect(ownBatches.body.items).toHaveLength(1)
    expect(ownBatches.body.items[0].orderNo).toBe(`PO-${run}-HF`)

    // 企业范围 admin → 两厂均可见
    const all = await request(app.getHttpServer())
      .get('/purchase/order-lines')
      .set('Authorization', `Bearer ${admin}`)
    expect(all.status).toBe(200)
    expect(all.body.total).toBe(2)

    // 合肥厂 actor 向苏州厂收货 → 命令二道防线 403（A-S1）
    const crossPlant = await request(app.getHttpServer())
      .post('/purchase/receive')
      .set('Authorization', `Bearer ${hf}`)
      .send({
        operationId: `${run}-cross-plant`,
        plantId: szPlantId,
        orderLineId: szLineId,
        arrivalTime: '2026-10-27T08:00:00.000Z',
        warehouseId: WH,
        locationId: LOC,
        locationCode: LOC_CODE,
        ownerId: OWNER,
        ownerName: OWNER_NAME,
        uomId: UOM,
        uomCode: 'KG',
        details: [{ barcodeValue: `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '3')}`, quantity: '5.0000' }],
      })
    expect(crossPlant.status).toBe(403)
    expect(crossPlant.body.message).toContain('A-S1')

    // 无 purchase.read 许可的账号 → 403 缺少操作许可（foreman）
    const foreman = await login('szws01', 'SzWorkshop01')
    const noPermission = await request(app.getHttpServer())
      .get('/purchase/order-lines')
      .set('Authorization', `Bearer ${foreman}`)
    expect(noPermission.status).toBe(403)
    expect(noPermission.body.message).toContain('purchase.read')
  })
})

describe('端点行为（同步/收货/质检/退货/复核 + 幂等 + 数量 number 拒绝）', () => {
  it('订单同步：同 operationId 幂等回放；五元组重复（新 operationId 同订单行）幂等返回 applied:false', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const admin = await login('admin', 'CadAdmin001')
    const orderNo = `PO-${run}-IDEM`
    const first = await syncOrderViaApi(admin, orderNo, qcMaterialId, 'MAT-PUR-QC')
    expect(first.status).toBe(201)
    // 同 operationId 重放 → 原结果
    const replay = await syncOrderViaApi(admin, orderNo, qcMaterialId, 'MAT-PUR-QC')
    expect(replay.status).toBe(201)
    expect(replay.body.data.orderId).toBe(first.body.data.orderId)
    // 新 operationId 同五元组 → 幂等不重复应用（IF-00.2）
    const again = await request(app.getHttpServer())
      .post('/purchase/orders/sync')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        operationId: `${run}-sync-again`,
        orgCode: 'ORG-ERP-HD',
        orderNo,
        plantId: szPlantId,
        lines: [{ lineNo: 1, materialId: qcMaterialId, materialCode: 'MAT-PUR-QC', plannedQty: '80.0000', status: 1 }],
      })
    expect(again.status).toBe(201)
    expect((again.body.data.lines as Array<{ applied: boolean }>)[0]!.applied).toBe(false)
    const lines = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM purchase_order_line WHERE order_no = $1`,
      [orderNo],
    )
    expect(lines.rows[0]!.n).toBe(1)
  })

  it('确认收货端点：201 + 批次/明细/单元落库；同 operationId 重放同 batchNo；数量 number → 422', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const admin = await login('admin', 'CadAdmin001')
    const order = await syncOrderViaApi(admin, `PO-${run}-RCV`, qcMaterialId, 'MAT-PUR-QC')
    const lineId = (order.body.data.lines as Array<{ lineId: string }>)[0]!.lineId
    const barcode = `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '4')}`
    const operationId = `${run}-receive`
    const first = await receiveViaApi(admin, operationId, lineId, barcode, '25.0000')
    expect(first.status).toBe(201)
    const batchNo = first.body.data.batchNo as string
    expect(first.body.data.inspectionStatus).toBe('pending')

    const replay = await receiveViaApi(admin, operationId, lineId, barcode, '25.0000')
    expect(replay.status).toBe(201)
    expect(replay.body.data.batchNo).toBe(batchNo)
    const batches = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM purchase_receipt_batch WHERE batch_no = $1`,
      [batchNo],
    )
    expect(batches.rows[0]!.n).toBe(1)

    // 数量为 number → 422（IT-07 禁 IEEE-754）
    const badQty = await receiveViaApi(admin, `${run}-badqty`, lineId, `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '5')}`, '30.0000')
    const bad = await request(app.getHttpServer())
      .post('/purchase/receive')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        operationId: `${run}-badqty2`,
        plantId: szPlantId,
        orderLineId: lineId,
        arrivalTime: '2026-10-27T08:00:00.000Z',
        warehouseId: WH,
        locationId: LOC,
        locationCode: LOC_CODE,
        ownerId: OWNER,
        ownerName: OWNER_NAME,
        uomId: UOM,
        uomCode: 'KG',
        details: [{ barcodeValue: `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '6')}`, quantity: 30 }],
      })
    expect(bad.status).toBe(422)
    void badQty
  })

  it('批次详情端点：明细+质检历史+价格复核投影；范围外 404', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const admin = await login('admin', 'CadAdmin001')
    const hf = await login('hfadmin01', 'HfPlant0001')
    const order = await syncOrderViaApi(admin, `PO-${run}-DT`, qcMaterialId, 'MAT-PUR-QC')
    const lineId = (order.body.data.lines as Array<{ lineId: string }>)[0]!.lineId
    const barcode = `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '7')}`
    const received = await receiveViaApi(admin, `${run}-dt`, lineId, barcode, '10.0000')
    const batchId = received.body.data.batchId as string

    const detail = await request(app.getHttpServer())
      .get(`/purchase/batches/${batchId}`)
      .set('Authorization', `Bearer ${admin}`)
    expect(detail.status).toBe(200)
    expect(detail.body.details).toHaveLength(1)
    expect(detail.body.details[0].qualityStatus).toBe('pending_inspection')
    expect(detail.body.inspectionHistory).toHaveLength(1) // 首检 v1
    expect(detail.body.inspectionHistory[0].version).toBe(1)
    expect(detail.body.unitPrice).toBe('100.0000') // 价格复核投影（A-10）

    // 合肥厂管理员查苏州批次 → 数据范围外 404
    const invisible = await request(app.getHttpServer())
      .get(`/purchase/batches/${batchId}`)
      .set('Authorization', `Bearer ${hf}`)
    expect(invisible.status).toBe(404)
  })

  it('质检结论端点：单码合格 → 批次全部合格 + 合格同步任务；复核端点：已复核不可再复核', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const admin = await login('admin', 'CadAdmin001')
    const order = await syncOrderViaApi(admin, `PO-${run}-QC`, qcMaterialId, 'MAT-PUR-QC')
    const lineId = (order.body.data.lines as Array<{ lineId: string }>)[0]!.lineId
    const barcode = `R${run.replace(/[^0-9]/g, '').slice(0, 9).padEnd(9, '8')}`
    const received = await receiveViaApi(admin, `${run}-qc-r`, lineId, barcode, '10.0000')
    const batchId = received.body.data.batchId as string

    const conclude = await request(app.getHttpServer())
      .post('/purchase/inspections')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        operationId: `${run}-qc-pass`,
        batchId,
        mode: 'code',
        barcodeValue: barcode,
        conclusion: 'qualified',
      })
    expect(conclude.status).toBe(201)
    expect(conclude.body.data.inspectionStatus).toBe('all_qualified')

    // 全合格 → 合格同步任务 1 行（IF-09）
    const outboxRow = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox
       WHERE aggregate_type = 'purchase_receipt_batch' AND aggregate_id = $1 AND task_kind = 'qualified_sync'`,
      [batchId],
    )
    expect(outboxRow.rows[0]!.n).toBe(1)

    // 复核 → 已复核；再复核 422
    const review = await request(app.getHttpServer())
      .post('/purchase/price-review')
      .set('Authorization', `Bearer ${admin}`)
      .send({ operationId: `${run}-review`, batchId })
    expect(review.status).toBe(200)
    expect(review.body.data.reviewStatus).toBe('reviewed')
    const reviewAgain = await request(app.getHttpServer())
      .post('/purchase/price-review')
      .set('Authorization', `Bearer ${admin}`)
      .send({ operationId: `${run}-review-2`, batchId })
    expect(reviewAgain.status).toBe(422)
    expect(reviewAgain.body.message).toContain('A-10')

    // 全合格批次不可退货（A-9：仅全部不合格）→ 422
    const ret = await request(app.getHttpServer())
      .post('/purchase/returns')
      .set('Authorization', `Bearer ${admin}`)
      .send({ operationId: `${run}-ret-x`, batchId, reason: '不应允许退货' })
    expect(ret.status).toBe(422)
    expect(ret.body.message).toContain('A-9')
  })
})
