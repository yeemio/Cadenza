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
import { GroupModule } from '../../apps/api/src/group/group.module'
import { ProductionModule } from '../../apps/api/src/production/production.module'
import { ScanBlockModule } from '../../apps/api/src/scan-block/scan-block.module'
import {
  GROUP_TEST_DB_NAME,
  groupDatabaseUrl,
  nodeId,
  prepareGroupTestDatabase,
} from './group-test-env'

/**
 * P1 回抛四单 API：召回 / 投料竞争 / SCAN-BLOCK / 供应商风险。
 * Done-when：空库列表 200；缺字段 422；与冒充路径划界（本文件测专用面）。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''

beforeAll(async () => {
  try {
    pool = await prepareGroupTestDatabase()
  } catch (e) {
    dbAvailable = false
    console.warn(`SKIP p1 throwback api: 数据库不可达（${GROUP_TEST_DB_NAME}）`, e)
    return
  }
  szPlantId = await nodeId(pool, 'PLNT-SZ')
  process.env['DATABASE_URL'] = groupDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      DbModule,
      AuthModule,
      GroupModule,
      ProductionModule,
      ScanBlockModule,
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

async function login(): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ loginName: 'admin', password: 'CadAdmin001', platform: 'WEB' })
  expect(res.status).toBe(200)
  return res.body.token as string
}

describe('group product recalls API', () => {
  it('lists empty 200 and rejects create without required fields with 422', async () => {
    if (skipIfNoDb()) return
    const token = await login()

    const list = await request(app.getHttpServer())
      .get('/group/recalls?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([])
    expect(list.body.total).toBe(0)

    const bad = await request(app.getHttpServer())
      .post('/group/recalls')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '缺厂缺范围' })
    expect(bad.status).toBe(422)
    expect(bad.body.code).toBe(ERROR_CODES.BUSINESS_RULE)

    const ok = await request(app.getHttpServer())
      .post('/group/recalls')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plantId: szPlantId,
        title: '批次召回样例',
        reason: '质量异常',
        recallScope: 'batch',
        batchNo: 'BATCH-P1-001',
      })
    expect([200, 201]).toContain(ok.status)
    expect(ok.body.data?.id).toBeTruthy()
  })
})

describe('production feed-race-plans API', () => {
  it('lists empty 200 and rejects create without planKind with 422', async () => {
    if (skipIfNoDb()) return
    const token = await login()

    const list = await request(app.getHttpServer())
      .get('/production/feed-race-plans?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([])
    expect(list.body.total).toBe(0)

    const bad = await request(app.getHttpServer())
      .post('/production/feed-race-plans')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: szPlantId, title: '缺 kind', reason: 'x' })
    expect(bad.status).toBe(422)

    const ok = await request(app.getHttpServer())
      .post('/production/feed-race-plans')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plantId: szPlantId,
        title: '投料竞争样例',
        reason: '多线争料',
        planKind: 'race',
      })
    expect([200, 201]).toContain(ok.status)
    expect(ok.body.data?.planKind).toBe('race')
  })
})

describe('scan-block events API', () => {
  it('lists empty 200 and rejects create without scanCode with 422', async () => {
    if (skipIfNoDb()) return
    const token = await login()

    const list = await request(app.getHttpServer())
      .get('/scan-block/events?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([])
    expect(list.body.total).toBe(0)

    const bad = await request(app.getHttpServer())
      .post('/scan-block/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: szPlantId, policyCode: 'SB-01', blockReason: '缺码' })
    expect(bad.status).toBe(422)

    const ok = await request(app.getHttpServer())
      .post('/scan-block/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plantId: szPlantId,
        policyCode: 'SB-01',
        scanCode: 'AXIS-BLOCK-001',
        blockReason: '冻结轴拦截',
      })
    expect([200, 201]).toContain(ok.status)
    expect(ok.body.data?.policyCode).toBe('SB-01')
  })
})

describe('group vendor-risks API', () => {
  it('lists empty 200 and rejects create without vendorCode with 422', async () => {
    if (skipIfNoDb()) return
    const token = await login()

    const list = await request(app.getHttpServer())
      .get('/group/vendor-risks?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([])
    expect(list.body.total).toBe(0)

    const bad = await request(app.getHttpServer())
      .post('/group/vendor-risks')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: szPlantId, title: '缺供应商', reason: 'x', riskLevel: 'high' })
    expect(bad.status).toBe(422)

    const ok = await request(app.getHttpServer())
      .post('/group/vendor-risks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plantId: szPlantId,
        vendorCode: 'V-P1-001',
        riskLevel: 'high',
        title: '交期风险',
        reason: '连续延期',
      })
    expect([200, 201]).toContain(ok.status)
    expect(ok.body.data?.vendorCode).toBe('V-P1-001')
  })
})
