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
import { OtModule } from '../../apps/api/src/ot/ot.module'
import { buildEventId } from '../../packages/domain/src/ot/index'
import { OT_TEST_DB_NAME, otDatabaseUrl, otFixtures, prepareOtTestDatabase } from './ot-test-env'

/**
 * ot API 集成（真容器独立库 cadenza_p3a + supertest 挂载模块，无桩；
 * 测试组合 = ConfigModule/DbModule/AuthModule（全局守卫）/OtModule——不改共享
 * app.module.ts，L0 整合步统一注册）。证据（模拟环境，OT-31）：
 * - 跨厂 403 与列表服务端过滤（OA-24/25 + A-S1）；
 * - 许可缺失 403 / 未鉴权 401；
 * - OT-25：样本明细无 deviceSerial → 422；汇总投影带更新时间与延迟标注；
 * - OT-22：坏点经 HTTP 可查带原因；
 * - OT-06：未注册网关入池 → 422；
 * - OT-28：监控总览无样本设备缺项（noData）；
 * - 命令幂等：同 operationId 重放原结果回放。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
let equipmentId = ''
const run = `apot${Date.now().toString(36)}`
const GATEWAY = `GW-${run}`

beforeAll(async () => {
  try {
    pool = await prepareOtTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP ot api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${OT_TEST_DB_NAME}）。`)
    return
  }
  const fx = otFixtures()
  szPlantId = fx.szPlantId
  equipmentId = fx.equipmentId

  // 种子数据经命令通道（HTTP 同源证据）：注册网关 → 绑定 → 点位 → 入池（含一个坏点）
  process.env['DATABASE_URL'] = otDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, AuthModule, OtModule],
  }).compile()
  app = moduleRef.createNestApplication()
  await app.init()

  const admin = await login('admin', 'CadAdmin001')
  await post(admin, '/ot/gateway/register', {
    plantId: szPlantId,
    gatewayCode: GATEWAY,
    deviceSerials: ['DEV-API-1', 'DEV-API-2'],
    heartbeatTimeoutSeconds: 60,
  })
  await post(admin, '/ot/device/bind', { plantId: szPlantId, deviceSerial: 'DEV-API-1', equipmentId })
  await post(admin, '/ot/quality-map/upsert', {
    plantId: szPlantId,
    deviceSerial: 'DEV-API-1',
    entries: [
      { code: '0', level: 'good' },
      { code: '192', level: 'bad' },
    ],
  })
  await post(admin, '/ot/point/upsert', {
    plantId: szPlantId,
    deviceSerial: 'DEV-API-1',
    points: [
      { pointCode: 'LEN-01', semantic: 'meter_length', uomCode: 'M', sampleRateSeconds: 1, rangeMin: 0, rangeMax: 100, participatesInBusiness: true },
    ],
  })
  await post(admin, '/ot/samples/ingest', {
    gatewayCode: GATEWAY,
    samples: [
      { deviceSerial: 'DEV-API-1', pointCode: 'LEN-01', eventId: buildEventId('DEV-API-1', 1), eventTime: new Date().toISOString(), rawValue: 10, rawUnit: 'M', deviceQualityCode: '0' },
      { deviceSerial: 'DEV-API-1', pointCode: 'LEN-01', eventId: buildEventId('DEV-API-1', 2), eventTime: new Date().toISOString(), rawValue: 999, rawUnit: 'M', deviceQualityCode: '192' },
    ],
  })
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

async function post(token: string, path: string, body: Record<string, unknown>): Promise<request.Response> {
  const res = await request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body)
  expect([200, 201]).toContain(res.status)
  return res
}

describe('ot API：跨厂 403 与服务端过滤（OA-24/25 + A-S1）', () => {
  it('hfadmin 显式查苏州厂 → 403 ERR_FORBIDDEN_SCOPE；不带参数 → 服务端过滤仅本厂（0 行）；企业范围可见', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    for (const path of [
      `/ot/gateways?plantId=${szPlantId}`,
      `/ot/devices?plantId=${szPlantId}`,
      `/ot/aggregates?plantId=${szPlantId}`,
      `/ot/monitor?plantId=${szPlantId}`,
    ]) {
      const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${hfToken}`)
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    }
    const hfList = await request(app.getHttpServer()).get('/ot/gateways').set('Authorization', `Bearer ${hfToken}`)
    expect(hfList.status).toBe(200)
    expect(hfList.body.total).toBe(0)
    const adminToken = await login('admin', 'CadAdmin001')
    const adminList = await request(app.getHttpServer()).get('/ot/gateways').set('Authorization', `Bearer ${adminToken}`)
    expect(adminList.status).toBe(200)
    expect(adminList.body.total).toBeGreaterThanOrEqual(1)
    expect(adminList.body.items.every((g: { plantId: string }) => g.plantId === szPlantId)).toBe(true)
  })

  it('命令二道防线：hfadmin 向苏州厂设备绑定 → 403（A-S1）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    const res = await request(app.getHttpServer())
      .post('/ot/device/bind')
      .set('Authorization', `Bearer ${hfToken}`)
      .send({ plantId: szPlantId, deviceSerial: 'DEV-API-2', equipmentId })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
  })

  it('许可缺失 403（szws01 无 ot.read）；未鉴权 401', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('szws01', 'SzWorkshop01')
    const res = await request(app.getHttpServer()).get('/ot/gateways').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    const anon = await request(app.getHttpServer()).get('/ot/gateways')
    expect(anon.status).toBe(401)
  })
})

describe('ot API：端点级行为', () => {
  it('OT-25：样本明细无 deviceSerial → 422（页面不扫高频原始点位）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const res = await request(app.getHttpServer()).get('/ot/samples').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(422)
    expect(res.body.message).toContain('OT-25')
    const ok = await request(app.getHttpServer())
      .get('/ot/samples?deviceSerial=DEV-API-1')
      .set('Authorization', `Bearer ${token}`)
    expect(ok.status).toBe(200)
    expect(ok.body.total).toBe(2)
  })

  it('OT-22：坏点经 HTTP 可查带原因（isBad 过滤）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const res = await request(app.getHttpServer())
      .get('/ot/samples?deviceSerial=DEV-API-1&isBad=true')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.items[0].badReasons[0].code).toBe('quality_bad')
    expect(res.body.items[0].qualityLabel).toBe('坏')
  })

  it('OT-25：汇总投影带更新时间与延迟标注；OT-24 分层可见', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const res = await request(app.getHttpServer())
      .get(`/ot/aggregates?plantId=${szPlantId}&granularity=minute`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBeGreaterThanOrEqual(1)
    const row = res.body.items[0]
    expect(row.updatedAt).toBeTruthy()
    expect(typeof row.dataLagSeconds).toBe('number') // 延迟标注（数据截至事件时间距今）
    expect(row.sampleCount).toBeGreaterThanOrEqual(1)
    expect(row.badCount).toBeGreaterThanOrEqual(1)
  })

  it('OT-06：未注册网关入池 → 422 拒绝；OT-28：监控总览无样本设备缺项', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const res = await request(app.getHttpServer())
      .post('/ot/samples/ingest')
      .set('Authorization', `Bearer ${token}`)
      .send({ gatewayCode: 'GW-NOT-REGISTERED', samples: [{ deviceSerial: 'X', pointCode: 'P', eventId: 'X@1', eventTime: new Date().toISOString(), rawValue: 1, rawUnit: 'M', deviceQualityCode: '0' }] })
    expect(res.status).toBe(422)
    expect(res.body.message).toContain('OT-06')
    // OT-28：DEV-API-2 已登记未上报 → 监控缺项（noData=true、延迟 null）
    const monitor = await request(app.getHttpServer())
      .get(`/ot/monitor?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(monitor.status).toBe(200)
    const noData = monitor.body.deviceLatency.find((d: { deviceSerial: string }) => d.deviceSerial === 'DEV-API-2')
    expect(noData).toMatchObject({ noData: true, lastSampleAt: null, latencySeconds: null })
    const hasData = monitor.body.deviceLatency.find((d: { deviceSerial: string }) => d.deviceSerial === 'DEV-API-1')
    expect(hasData.noData).toBe(false)
  })

  it('命令幂等：同 operationId 重放原结果（HTTP 层回放全等）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const body = { plantId: szPlantId, deviceSerial: 'DEV-API-2', equipmentId }
    const first = await request(app.getHttpServer())
      .post('/ot/device/bind')
      .set('Authorization', `Bearer ${token}`)
      .set('x-operation-id', `${run}-idem`)
      .send(body)
    expect(first.status).toBe(200)
    const replay = await request(app.getHttpServer())
      .post('/ot/device/bind')
      .set('Authorization', `Bearer ${token}`)
      .set('x-operation-id', `${run}-idem`)
      .send(body)
    expect(replay.status).toBe(200)
    expect(replay.body.data).toEqual(first.body.data)
  })
})
