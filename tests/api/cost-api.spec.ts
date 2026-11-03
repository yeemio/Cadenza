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
import { CostModule } from '../../apps/api/src/cost/cost.module'
import { COST_TEST_DB_NAME, costDatabaseUrl, prepareCostTestDatabase, seedCostFixtures } from './cost-test-env'

/**
 * cost API 集成（真容器独立库 cadenza_p3d + supertest 挂载模块，无桩；
 * 测试组合 = ConfigModule/DbModule/AuthModule（全局守卫）/CostModule——不改共享
 * app.module.ts，L0 整合步统一注册）。
 * 证据：跨厂 403 与列表服务端过滤（OA-24/25 + A-S1）；端点级行为：
 * 许可缺失 403、未鉴权 401、命令二道防线（hfadmin 无 cost.post）、命令幂等
 * （同 operationId 重放原结果且表内 1 行）、枚举/形状 422、OEE 缺参 422、
 * 订单成本汇总 404。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
let hfPlantId = ''
let eq1Id = ''
const run = `apcst${Date.now().toString(36)}`

beforeAll(async () => {
  try {
    pool = await prepareCostTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP cost api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${COST_TEST_DB_NAME}）。`)
    return
  }
  const fx = await seedCostFixtures(pool)
  szPlantId = fx.szPlantId
  hfPlantId = fx.hfPlantId
  eq1Id = fx.eq1Id

  process.env['DATABASE_URL'] = costDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, AuthModule, CostModule],
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

describe('跨厂 403 与列表服务端过滤（OA-24/25 + A-S1）', () => {
  it('合肥厂管理员显式查苏州厂表计 → 403 ERR_FORBIDDEN_SCOPE；不带参数 → 服务端过滤 0 行；企业范围可见', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const adminToken = await login('admin', 'CadAdmin001')
    // 苏州厂登记一枚表计（API 命令面入账，列表证据不依赖直插）
    const created = await request(app.getHttpServer())
      .post('/cost/meters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, meterCode: `M-${run}-01`, energyType: 'electric', coverageKind: 'equipment', equipmentId: eq1Id, sampleSource: 'manual', uomCode: 'KWH' })
    expect(created.status).toBe(201)

    const hfToken = await login('hfadmin01', 'HfPlant0001')
    const forbidden = await request(app.getHttpServer()).get(`/cost/meters?plantId=${szPlantId}`).set('Authorization', `Bearer ${hfToken}`)
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)

    const hfList = await request(app.getHttpServer()).get('/cost/meters').set('Authorization', `Bearer ${hfToken}`)
    expect(hfList.status).toBe(200)
    expect(hfList.body.total).toBe(0)

    const adminList = await request(app.getHttpServer()).get(`/cost/meters?plantId=${szPlantId}`).set('Authorization', `Bearer ${adminToken}`)
    expect(adminList.status).toBe(200)
    expect(adminList.body.total).toBeGreaterThanOrEqual(1)
    expect(adminList.body.items.every((m: { plantId: string }) => m.plantId === szPlantId)).toBe(true)
    expect(adminList.body.items[0].meterCode).toBe(`M-${run}-01`)
    expect(adminList.body.items[0].sampleSource).toBe('manual')
  })

  it('版本/归集/对账/工时核对列表同样服务端过滤（不带参数 → hfadmin 0 行）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    for (const path of ['/cost/allocation-versions', '/cost/price-versions', '/cost/runs', '/cost/recon-items', '/cost/labor-checks', '/cost/readings']) {
      const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${hfToken}`)
      expect(res.status, path).toBe(200)
      expect(res.body.total, path).toBe(0)
    }
    // 显式跨厂参数 → 403
    const forbidden = await request(app.getHttpServer()).get(`/cost/runs?plantId=${szPlantId}`).set('Authorization', `Bearer ${hfToken}`)
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
  })
})

describe('鉴权与命令二道防线', () => {
  it('未鉴权 401；许可缺失 403（foreman 无 cost.read/post）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const anon = await request(app.getHttpServer()).get('/cost/meters')
    expect(anon.status).toBe(401)
    const wsToken = await login('szws01', 'SzWorkshop01')
    const read403 = await request(app.getHttpServer()).get('/cost/meters').set('Authorization', `Bearer ${wsToken}`)
    expect(read403.status).toBe(403)
    const post403 = await request(app.getHttpServer())
      .post('/cost/meters')
      .set('Authorization', `Bearer ${wsToken}`)
      .send({ plantId: szPlantId, meterCode: `M-${run}-X`, energyType: 'electric', coverageKind: 'equipment', equipmentId: eq1Id, sampleSource: 'manual', uomCode: 'KWH' })
    expect(post403.status).toBe(403)
  })

  it('hfadmin（有 cost.read 无 cost.post）命令二道防线 → 403', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    const res = await request(app.getHttpServer())
      .post('/cost/meters')
      .set('Authorization', `Bearer ${hfToken}`)
      .send({ plantId: hfPlantId, meterCode: `M-${run}-HF`, energyType: 'electric', coverageKind: 'workshop', workCenterId: hfPlantId, sampleSource: 'manual', uomCode: 'KWH' })
    expect(res.status).toBe(403)
  })
})

describe('命令幂等与 422 形状', () => {
  it('同 operationId 重放返回原结果且表内 1 行', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const adminToken = await login('admin', 'CadAdmin001')
    const payload = { plantId: szPlantId, meterCode: `M-${run}-IDEM`, energyType: 'water', coverageKind: 'equipment', equipmentId: eq1Id, sampleSource: 'manual', uomCode: 'T', operationId: `${run}-idem-1` }
    const first = await request(app.getHttpServer()).post('/cost/meters').set('Authorization', `Bearer ${adminToken}`).send(payload)
    expect(first.status).toBe(201)
    const replay = await request(app.getHttpServer()).post('/cost/meters').set('Authorization', `Bearer ${adminToken}`).send(payload)
    expect(replay.status).toBe(201)
    expect(replay.body.data.meterId).toBe(first.body.data.meterId)
    const count = await pool.query<{ c: string }>(`SELECT count(*) AS c FROM cost_meter WHERE meter_code = $1`, [payload.meterCode])
    expect(Number(count.rows[0]!.c)).toBe(1)
  })

  it('枚举/形状 422：能源类型、OT 点位成对、归集缺班次、核对阈值非法', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const adminToken = await login('admin', 'CadAdmin001')
    const badEnergy = await request(app.getHttpServer())
      .post('/cost/meters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, meterCode: `M-${run}-BE`, energyType: 'steam', coverageKind: 'equipment', equipmentId: eq1Id, sampleSource: 'manual', uomCode: 'KWH' })
    expect(badEnergy.status).toBe(422)
    expect(badEnergy.body.message).toContain('[CE-S3]')

    const badSource = await request(app.getHttpServer())
      .post('/cost/meters')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, meterCode: `M-${run}-BS`, energyType: 'electric', coverageKind: 'equipment', equipmentId: eq1Id, sampleSource: 'ot', uomCode: 'KWH' })
    expect(badSource.status).toBe(422)
    expect(badSource.body.message).toContain('[CE-09]')

    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM production_order WHERE order_no LIKE 'PO-CST-%' LIMIT 1`)).rows[0]!.id
    const badRun = await request(app.getHttpServer())
      .post('/cost/acquisition/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, orderId, dataCutoffAt: '2026-10-26T16:00:00Z', allocationVersionId: '00000000-0000-4000-8000-000000000001', priceVersionId: '00000000-0000-4000-8000-000000000002' })
    expect(badRun.status).toBe(422)
    expect(badRun.body.message).toContain('[CE-S1]')

    const badThreshold = await request(app.getHttpServer())
      .post('/cost/labor-check/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, orderId, shiftDate: '2026-10-26', thresholdRatio: 'abc' })
    expect(badThreshold.status).toBe(422)
    expect(badThreshold.body.message).toContain('[CA-12]')
  })

  it('OEE 缺参 422；订单成本汇总不存在 → 404', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const adminToken = await login('admin', 'CadAdmin001')
    const missingParams = await request(app.getHttpServer()).get('/cost/oee').set('Authorization', `Bearer ${adminToken}`)
    expect(missingParams.status).toBe(422)
    const notFound = await request(app.getHttpServer())
      .get('/cost/orders/00000000-0000-4000-8000-0000000000ff/summary')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(notFound.status).toBe(404)
    expect(notFound.body.code).toBe(ERROR_CODES.NOT_FOUND)
  })
})
