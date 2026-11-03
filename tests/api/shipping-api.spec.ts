import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { ERROR_CODES } from '@cadenza/contracts'
import { validateEnv } from '../../apps/api/src/env'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { DbModule } from '../../apps/api/src/db/db.module'
import { ShippingModule } from '../../apps/api/src/shipping/shipping.module'
import {
  SHP_TEST_DB_NAME,
  nodeId,
  prepareShpTestDatabase,
  shpDatabaseUrl,
} from './shipping-test-env'

/**
 * shipping API 集成（真容器独立库 cadenza_shp + supertest 挂载模块，无桩；
 * 测试组合 = ConfigModule/DbModule/AuthModule（全局守卫）/ShippingModule
 * ——不改共享 app.module.ts，L0 整合步统一注册）。
 * 证据⑧：跨厂 403 与列表服务端过滤（OA-24/25 + A-S1）；另含端点级行为：
 * 许可缺失 403、命令二道防线、命令幂等（同 opId 重放原结果）、数量 number 拒、
 * 未鉴权 401、附件部分失败保留已成功。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
const run = `apshp${Date.now().toString(36)}`

beforeAll(async () => {
  try {
    pool = await prepareShpTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP shipping api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${SHP_TEST_DB_NAME}）。`)
    return
  }
  szPlantId = await nodeId(pool, 'PLNT-SZ')

  process.env['DATABASE_URL'] = shpDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, AuthModule, ShippingModule],
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

/** 直插一颗苏州厂 PL（模拟外部已下发——api 层证据不依赖入站命令）。 */
async function seedShipmentOrder(plNo: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO shipment_order (pl_no, sales_order_no, customer_name, status, plant_id, enterprise_id, created_by)
     VALUES ($1, $2, 'API 演示客户', 'pending_packing', $3,
       (SELECT enterprise_id FROM org_node WHERE id = $3), 'ap-seed')
     RETURNING id`,
    [plNo, `SO-${plNo}`, szPlantId],
  )
  await pool.query(
    `INSERT INTO shipment_line (shipment_order_id, line_no, line_kind, material_id, material_code,
       sales_order_line_no, customer_axis_no, standard_segment_length, required_count)
     VALUES ($1, 1, 'axis_item', (SELECT id FROM material WHERE code = 'MAT-SHP-FIN'), 'MAT-SHP-FIN',
       '10', $2, 1200.0000, 1)`,
    [r.rows[0]!.id, `CAX-${run}-1`],
  )
  return r.rows[0]!.id
}

describe('⑧ 跨厂 403 与列表服务端过滤（OA-24/25 + A-S1）', () => {
  it('合肥厂管理员显式查苏州厂 PL/打包看板/出库状态 → 403 ERR_FORBIDDEN_SCOPE；不带参数 → 服务端过滤仅本厂（0 行）；企业范围可见', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await seedShipmentOrder(`PL-${run}-API1`)
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    const adminToken = await login('admin', 'CadAdmin001')

    for (const path of [`/shipping/shipment-orders?plantId=${szPlantId}`, `/shipping/packing-board?plantId=${szPlantId}`, `/shipping/outbound-status?plantId=${szPlantId}`]) {
      const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${hfToken}`)
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    }

    const hfList = await request(app.getHttpServer()).get('/shipping/shipment-orders').set('Authorization', `Bearer ${hfToken}`)
    expect(hfList.status).toBe(200)
    expect(hfList.body.total).toBe(0)
    const adminList = await request(app.getHttpServer()).get('/shipping/shipment-orders').set('Authorization', `Bearer ${adminToken}`)
    expect(adminList.status).toBe(200)
    expect(adminList.body.total).toBeGreaterThanOrEqual(1)
    expect(adminList.body.items.every((o: { plantId: string }) => o.plantId === szPlantId)).toBe(true)
    // 详情视图含三类行与回传双状态列投影
    const detail = await request(app.getHttpServer())
      .get(`/shipping/shipment-orders/${adminList.body.items[0]!.orderId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(detail.status).toBe(200)
    expect(detail.body.lines.length).toBeGreaterThanOrEqual(1)
    expect(detail.body.actualAxisSyncStatusLabel).toBe('待同步')
  })

  it('命令二道防线：hfadmin 向苏州厂 PL 扫码装入 → 403（A-S1）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const orderId = await seedShipmentOrder(`PL-${run}-API2`)
    const lineId = (await pool.query<{ id: string }>(`SELECT id FROM shipment_line WHERE shipment_order_id = $1`, [orderId])).rows[0]!.id
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    const crossPlant = await request(app.getHttpServer())
      .post('/shipping/scan/load')
      .set('Authorization', `Bearer ${hfToken}`)
      .send({ operationId: `${run}-cross`, plantId: szPlantId, shipmentOrderId: orderId, lineId, unitNo: `U-${run}-X` })
    expect(crossPlant.status).toBe(403)
    expect(crossPlant.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
  })

  it('许可缺失 403：foreman（无 shipping.read）→ 查询 403；未鉴权 401', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('szws01', 'SzWorkshop01')
    const res = await request(app.getHttpServer()).get('/shipping/shipment-orders').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    const anon = await request(app.getHttpServer()).get('/shipping/shipment-orders')
    expect(anon.status).toBe(401)
  })

  it('端点行为：数量 number → 422；不存在单 404；同 operationId 重放原结果', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    // 段长 number → 422（IT-07 随行：十进制字符串）
    const badDec = await request(app.getHttpServer())
      .post('/shipping/pl/inbound')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `${run}-bad-dec`,
        plantId: szPlantId,
        plNo: `PL-${run}-BAD`,
        salesOrderNo: `SO-${run}-BAD`,
        lines: [{ lineNo: 1, lineKind: 'axis_item', materialCode: 'MAT-SHP-FIN', salesOrderLineNo: '10', customerAxisNo: 'CAX-BAD', standardSegmentLength: 1200 }],
      })
    expect(badDec.status).toBe(422)
    // 不存在单 → 404
    const notFound = await request(app.getHttpServer())
      .post('/shipping/ship/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: `${run}-nf`, plantId: szPlantId, shipmentOrderId: '11111111-1111-4111-8111-1111111111ff' })
    expect(notFound.status).toBe(404)
    // 命令幂等：pl/inbound 同 opId 重放原结果（HTTP 200 + skipped=false 原样回放）
    const body = {
      plantId: szPlantId,
      plNo: `PL-${run}-IDEM`,
      salesOrderNo: `SO-${run}-IDEM`,
      lines: [{ lineNo: 1, lineKind: 'axis_item', materialCode: 'MAT-SHP-FIN', salesOrderLineNo: '10', customerAxisNo: 'CAX-IDEM', standardSegmentLength: '1200.0000' }],
    }
    const first = await request(app.getHttpServer())
      .post('/shipping/pl/inbound')
      .set('Authorization', `Bearer ${token}`)
      .set('x-operation-id', `${run}-idem`)
      .send(body)
    expect(first.status).toBe(200)
    expect(first.body.data.skipped).toBe(false)
    const replay = await request(app.getHttpServer())
      .post('/shipping/pl/inbound')
      .set('Authorization', `Bearer ${token}`)
      .set('x-operation-id', `${run}-idem`)
      .send(body)
    expect(replay.status).toBe(200)
    expect(replay.body.data).toEqual(first.body.data)
  })

  it('附件元数据：部分失败保留已成功（A-T14-10）；append-only', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const orderId = await seedShipmentOrder(`PL-${run}-API3`)
    const token = await login('admin', 'CadAdmin001')
    const res = await request(app.getHttpServer())
      .post('/shipping/photos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `${run}-photo`,
        plantId: szPlantId,
        shipmentOrderId: orderId,
        photos: [
          { fileName: 'box-1.jpg', storageKey: `s3://${run}/box-1.jpg`, contentType: 'image/jpeg', sizeBytes: 1024 },
          { fileName: '', storageKey: 'missing-name' }, // 缺 fileName → 失败张
        ],
      })
    expect(res.status).toBe(201)
    expect(res.body.data.attached).toHaveLength(1)
    expect(res.body.data.failed).toHaveLength(1)
    const rows = await pool.query(`SELECT count(*)::int AS c FROM shipment_photo WHERE shipment_order_id = $1`, [orderId])
    expect(rows.rows[0]!.c).toBe(1) // 已成功保留
  })
})
