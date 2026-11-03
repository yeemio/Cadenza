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
import {
  GROUP_TEST_DB_NAME,
  groupDatabaseUrl,
  nodeId,
  prepareGroupTestDatabase,
} from './group-test-env'

/**
 * G 场景 API：集团分配修订 + 缺料/齐套（独立库 cadenza_group_g）。
 * Done-when：空库列表 200 空分页；修订命令缺字段 422；与 cost/投料无关。
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
    console.warn(`SKIP group api: 数据库不可达（${GROUP_TEST_DB_NAME}）`, e)
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

describe('group allocation-revisions API', () => {
  it('lists empty 200 and rejects create without required fields with 422', async () => {
    if (skipIfNoDb()) return
    const token = await login()

    const list = await request(app.getHttpServer())
      .get('/group/allocation-revisions?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([])
    expect(list.body.total).toBe(0)

    const bad = await request(app.getHttpServer())
      .post('/group/allocation-revisions')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '缺厂缺理由' })
    expect(bad.status).toBe(422)
    expect(bad.body.code).toBe(ERROR_CODES.BUSINESS_RULE)

    const ok = await request(app.getHttpServer())
      .post('/group/allocation-revisions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plantId: szPlantId,
        title: 'G分配修订样例',
        reason: '产能重分配',
      })
    expect([200, 201]).toContain(ok.status)
    expect(ok.body.data?.id).toBeTruthy()

    const list2 = await request(app.getHttpServer())
      .get('/group/allocation-revisions?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`)
    expect(list2.status).toBe(200)
    expect(list2.body.total).toBeGreaterThanOrEqual(1)
  })
})

describe('group shortage-kitting API', () => {
  it('lists empty 200 and check without orderNo returns 422', async () => {
    if (skipIfNoDb()) return
    const token = await login()

    const list = await request(app.getHttpServer())
      .get('/group/shortage-kitting?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([])
    expect(list.body.total).toBe(0)

    const bad = await request(app.getHttpServer())
      .post('/group/shortage-kitting/check')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: szPlantId })
    expect(bad.status).toBe(422)

    const ok = await request(app.getHttpServer())
      .post('/group/shortage-kitting/check')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: szPlantId, orderNo: 'PO-MISSING-001' })
    expect([200, 201]).toContain(ok.status)
    expect(ok.body.data?.checkStatus).toBe('empty')
  })
})
