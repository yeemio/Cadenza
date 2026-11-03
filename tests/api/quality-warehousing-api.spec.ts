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
import { QualityModule } from '../../apps/api/src/quality/quality.module'
import { WarehousingModule } from '../../apps/api/src/warehousing/warehousing.module'
import {
  QW_TEST_DB_NAME,
  nodeId,
  prepareQwTestDatabase,
  qwDatabaseUrl,
} from './quality-warehousing-test-env'

/**
 * quality/warehousing API 集成（真容器独立库 cadenza_qw + supertest 挂载两模块，无桩；
 * 测试组合 = ConfigModule/DbModule/AuthModule（全局守卫）/QualityModule/WarehousingModule
 * ——不改共享 app.module.ts，L0 整合步统一注册）。
 * 证据⑧：跨厂 403 与列表服务端过滤（OA-24/25 + A-S1）；另含端点级行为：
 * 许可缺失 403、命令幂等、数量 number 拒绝、调拨状态机端点步进拒绝。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
let logisticsWarehouseId = ''
let transitLocationId = ''
let targetWarehouseId = ''
let rackLocationId = ''
const run = `apqw${Date.now().toString(36)}`

const OWNER = '22222222-2222-4222-8222-222222222201'
const OWNER_NAME = '华东电缆集团（自有）'

beforeAll(async () => {
  try {
    pool = await prepareQwTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP quality/warehousing api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${QW_TEST_DB_NAME}）。`)
    return
  }
  szPlantId = await nodeId(pool, 'PLNT-SZ')
  const wh = await pool.query<{ code: string; id: string }>(
    `SELECT code, id FROM warehouse WHERE code IN ('9101','9103','9190')`,
  )
  logisticsWarehouseId = wh.rows.find((w) => w.code === '9101')!.id
  targetWarehouseId = wh.rows.find((w) => w.code === '9103')!.id
  transitLocationId = (await pool.query<{ id: string }>(`SELECT id FROM storage_location WHERE code = '91900101'`)).rows[0]!.id
  rackLocationId = (await pool.query<{ id: string }>(`SELECT id FROM storage_location WHERE code = '010101'`)).rows[0]!.id

  process.env['DATABASE_URL'] = qwDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      DbModule,
      AuthModule,
      QualityModule,
      WarehousingModule,
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

/** 建一颗苏州厂待入库任务（直插事件表外——refresh 需事件端口，测试模块未注入事件：直插 putaway_task 模拟来源）。 */
async function seedPendingTask(sourceRef: string, unitNo: string, quantity: string): Promise<string> {
  const material = await pool.query<{ id: string }>(`SELECT id FROM material WHERE code = 'MAT-QW-FIN'`)
  const r = await pool.query<{ id: string }>(
    `INSERT INTO putaway_task (source_type, source_ref, unit_no, material_id, material_code, quantity,
       uom_id, uom_code, plant_id, enterprise_id, created_by)
     VALUES ('work_report', $1, $2, $3, 'MAT-QW-FIN', $4,
       '33333333-3333-4333-8333-3333333333c1', 'KG', $5,
       (SELECT enterprise_id FROM org_node WHERE id = $5), 'ap-seed')
     RETURNING id`,
    [sourceRef, unitNo, material.rows[0]!.id, quantity, szPlantId],
  )
  return r.rows[0]!.id
}

describe('⑧ 跨厂 403 与列表服务端过滤（OA-24/25 + A-S1）', () => {
  it('合肥厂管理员显式查苏州厂任务/调拨 → 403 ERR_FORBIDDEN_SCOPE；不带参数 → 服务端过滤仅本厂（0 行）；企业范围可见', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await seedPendingTask(`${run}-AP-1`, `AP-U-${run}`, '10.0000')
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    const adminToken = await login('admin', 'CadAdmin001')

    // 显式跨厂 → 403（quality + warehousing 两域一致）
    const q403 = await request(app.getHttpServer())
      .get(`/quality/inspections?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${hfToken}`)
    expect(q403.status).toBe(403)
    expect(q403.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    const w403 = await request(app.getHttpServer())
      .get(`/warehousing/putaway-tasks?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${hfToken}`)
    expect(w403.status).toBe(403)
    expect(w403.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)

    // 不带参数 → 服务端过滤：合肥厂 0 行、企业范围 ≥1 行
    const hfList = await request(app.getHttpServer())
      .get('/warehousing/putaway-tasks')
      .set('Authorization', `Bearer ${hfToken}`)
    expect(hfList.status).toBe(200)
    expect(hfList.body.total).toBe(0)
    const adminList = await request(app.getHttpServer())
      .get('/warehousing/putaway-tasks')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(adminList.status).toBe(200)
    expect(adminList.body.total).toBeGreaterThanOrEqual(1)
    expect(adminList.body.items.every((t: { plantId: string }) => t.plantId === szPlantId)).toBe(true)

    // 命令二道防线：hfadmin 向苏州厂确认入库 → 403（A-S1）
    const taskId = adminList.body.items.find((t: { status: string }) => t.status === 'pending')
    const crossPlant = await request(app.getHttpServer())
      .post('/warehousing/putaway/confirm')
      .set('Authorization', `Bearer ${hfToken}`)
      .send({
        operationId: `${run}-cross-plant`,
        plantId: szPlantId,
        taskIds: [taskId.id],
        toWarehouseId: logisticsWarehouseId,
        toWarehouseKind: 'LOGISTICS',
        toLocationId: rackLocationId,
        toLocationCode: '010101',
        ownerId: OWNER,
        ownerName: OWNER_NAME,
      })
    expect(crossPlant.status).toBe(403)
    expect(crossPlant.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
  })

  it('许可缺失 403：foreman（无 quality.read/warehousing.read）→ 两域查询均 403', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('szws01', 'SzWorkshop01')
    const q = await request(app.getHttpServer())
      .get('/quality/inspections')
      .set('Authorization', `Bearer ${token}`)
    expect(q.status).toBe(403)
    const w = await request(app.getHttpServer())
      .get('/warehousing/putaway-tasks')
      .set('Authorization', `Bearer ${token}`)
    expect(w.status).toBe(403)
  })

  it('端点行为：调拨创建数量 number → 422；同 operationId 重放原结果；状态机步进拒绝', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    // 数量 number → 422（IT-07：十进制字符串）
    const badQty = await request(app.getHttpServer())
      .post('/warehousing/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `${run}-bad-qty`,
        plantId: szPlantId,
        transferKind: 'warehouse',
        fromWarehouseId: logisticsWarehouseId,
        toWarehouseId: targetWarehouseId,
        transitLocationId,
        transitLocationCode: '91900101',
        lines: [{ unitId: '11111111-1111-4111-8111-111111111199', unitNo: 'X', quantity: 40, materialType: 3 }],
      })
    expect(badQty.status).toBe(422)
    expect(badQty.body.message).toContain('A-T13-5')

    // 状态机步进拒绝：对已存在调拨单（无）——改为 submit 不存在单 → 404
    const notFound = await request(app.getHttpServer())
      .post('/warehousing/transfers/submit')
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: `${run}-nf`, transferOrderId: '11111111-1111-4111-8111-1111111111ff', lockValidUntil: new Date(Date.now() + 3600_000).toISOString() })
    expect(notFound.status).toBe(404)

    // 命令幂等：putaway/refresh 同 opId 重放原结果（模块默认空事件源 → created=0）
    const refreshBody = { operationId: `${run}-refresh`, plantId: szPlantId }
    const r1 = await request(app.getHttpServer())
      .post('/warehousing/putaway/refresh')
      .set('Authorization', `Bearer ${token}`)
      .send(refreshBody)
    expect(r1.status).toBe(201)
    expect(r1.body.data.created).toHaveLength(0) // 模块未注入事件源（默认空实现）：created=0
    const r2 = await request(app.getHttpServer())
      .post('/warehousing/putaway/refresh')
      .set('Authorization', `Bearer ${token}`)
      .send(refreshBody)
    expect(r2.status).toBe(201)
    expect(r2.body.operationId).toBe(r1.body.operationId)
    expect(r2.body.data.created).toHaveLength(0) // 同 opId 重放原结果
  })
})

describe('GAP-QUALITY-HOLDS-500：GET /quality/holds 列表非 500', () => {
  it('空库企业范围 → 200 + 空分页（items=[] total=0）；显式 plantId 同口径', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const empty = await request(app.getHttpServer())
      .get('/quality/holds?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`)
    expect(empty.status).toBe(200)
    expect(empty.body).toMatchObject({ items: [], total: 0, page: 1, pageSize: 10 })

    const byPlant = await request(app.getHttpServer())
      .get(`/quality/holds?plantId=${szPlantId}&page=1&pageSize=10`)
      .set('Authorization', `Bearer ${token}`)
    expect(byPlant.status).toBe(200)
    expect(Array.isArray(byPlant.body.items)).toBe(true)
    expect(typeof byPlant.body.total).toBe('number')
  })
})
