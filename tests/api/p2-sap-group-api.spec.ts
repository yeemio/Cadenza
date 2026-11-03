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
import { IntegrationsApiModule } from '../../apps/api/src/integrations/integrations.composition'
import { SapModule } from '../../apps/api/src/sap/sap.module'
import { OrgModule } from '../../apps/api/src/org/org.module'
import {
  GROUP_TEST_DB_NAME,
  groupDatabaseUrl,
  nodeId,
  prepareGroupTestDatabase,
} from './group-test-env'

/**
 * P2：SAP_SIM / outbox·inbox / sap recon / rework·scrap / org cross-ent 入口契约。
 * Done-when：空库列表 200；缺字段 422；actual_connection=false；≠ /cost/recon-items。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let plantId = ''

beforeAll(async () => {
  try {
    pool = await prepareGroupTestDatabase()
  } catch (e) {
    dbAvailable = false
    console.warn(`SKIP p2 sap/group api: 数据库不可达（${GROUP_TEST_DB_NAME}）`, e)
    return
  }
  plantId = await nodeId(pool, 'PLNT-SZ')
  process.env['DATABASE_URL'] = groupDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      DbModule,
      AuthModule,
      GroupModule,
      IntegrationsApiModule,
      SapModule,
      OrgModule,
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

describe('SAP_SIM adapter + outbox/inbox', () => {
  it('GET sap-sim 200 actual_connection=false; empty POST 422; outbox/inbox list 200', async () => {
    if (skipIfNoDb()) return
    const token = await login()
    const st = await request(app.getHttpServer())
      .get('/integrations/sap-sim')
      .set('Authorization', `Bearer ${token}`)
    expect(st.status).toBe(200)
    expect(st.body.actual_connection).toBe(false)
    expect(st.body.source_system).toBe('SAP_SIM')

    const bad = await request(app.getHttpServer())
      .post('/integrations/sap-sim/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(bad.status).toBe(422)
    expect(bad.body.code).toBe(ERROR_CODES.BUSINESS_RULE)

    const ob = await request(app.getHttpServer())
      .get('/integrations/outbox')
      .set('Authorization', `Bearer ${token}`)
    expect(ob.status).toBe(200)
    expect(Array.isArray(ob.body.items)).toBe(true)

    const ib = await request(app.getHttpServer())
      .get('/integrations/inbox')
      .set('Authorization', `Bearer ${token}`)
    expect(ib.status).toBe(200)
    expect(Array.isArray(ib.body.items)).toBe(true)

    const obBad = await request(app.getHttpServer())
      .post('/integrations/outbox')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(obBad.status).toBe(422)
  })
})

describe('GET/POST /sap/reconciliation', () => {
  it('empty list 200; missing fields 422; create committed', async () => {
    if (skipIfNoDb()) return
    const token = await login()
    const list = await request(app.getHttpServer())
      .get('/sap/reconciliation')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([])
    expect(list.body.actual_connection).toBe(false)
    expect(list.body.byClassification).toEqual({})

    const bad = await request(app.getHttpServer())
      .post('/sap/reconciliation')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(bad.status).toBe(422)

    const ok = await request(app.getHttpServer())
      .post('/sap/reconciliation')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plantId,
        objectCode: 'OBJ-VITEST',
        title: 'vitest recon',
        reason: 'entry only',
      })
    expect(ok.status).toBe(201)
    expect(ok.body.status).toBe('COMMITTED')
    expect(ok.body.data.actual_connection).toBe(false)

    const match = await request(app.getHttpServer())
      .post('/sap/reconciliation')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plantId,
        objectCode: 'OBJ-MATCH-VT',
        title: 'vitest match',
        reason: 'full recon',
        matchStatus: 'MATCH',
      })
    expect(match.status).toBe(201)
    expect(match.body.data.classification).toBe('MATCH')

    const diff = await request(app.getHttpServer())
      .post('/sap/reconciliation')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plantId,
        objectCode: 'OBJ-CLDIFF-VT',
        title: 'vitest class diff',
        reason: 'full recon',
        classification: 'CLASSIFICATION_DIFFERENCE',
      })
    expect(diff.status).toBe(201)
    expect(diff.body.data.matchStatus).toBe('CLASSIFICATION_DIFFERENCE')

    const listed = await request(app.getHttpServer())
      .get('/sap/reconciliation')
      .set('Authorization', `Bearer ${token}`)
    expect(listed.status).toBe(200)
    expect(listed.body.byClassification.MATCH).toBeGreaterThanOrEqual(1)
    expect(listed.body.byClassification.CLASSIFICATION_DIFFERENCE).toBeGreaterThanOrEqual(1)
    expect(listed.body.actual_connection).toBe(false)
  })
})

describe('SAP_SIM offline fail→replay preserves keys', () => {
  it('enqueue → fail → replay keeps eventId/digest/externalRef', async () => {
    if (skipIfNoDb()) return
    const token = await login()
    const key = `VT-OFFLINE-${Date.now()}`
    const enq = await request(app.getHttpServer())
      .post('/integrations/outbox')
      .set('Authorization', `Bearer ${token}`)
      .send({
        aggregate_type: 'sap_sim_msg',
        aggregate_id: key,
        task_kind: 'sap_sim.offline_vitest',
        source_system: 'SAP_SIM',
        organization_code: 'ORG-VT',
        external_key: key,
        entity_type: 'goods_issue',
        status: 'PENDING',
      })
    expect(enq.status).toBe(201)
    const eventId = enq.body.outbox.eventId as string
    const digest = enq.body.outbox.requestDigest as string
    const ext = enq.body.outbox.externalRef as string

    const failed = await request(app.getHttpServer())
      .post(`/integrations/outbox/${eventId}/fail`)
      .set('Authorization', `Bearer ${token}`)
      .send({ lastError: 'vitest offline' })
    expect(failed.status).toBe(201)
    expect(failed.body.outbox.status).toBe('FAILED')
    expect(failed.body.outbox.eventId).toBe(eventId)
    expect(failed.body.outbox.requestDigest).toBe(digest)
    expect(failed.body.outbox.externalRef).toBe(ext)
    expect(failed.body.actual_connection).toBe(false)

    const replay = await request(app.getHttpServer())
      .post(`/integrations/outbox/${eventId}/replay`)
      .set('Authorization', `Bearer ${token}`)
    expect(replay.status).toBe(201)
    expect(replay.body.outbox.status).toBe('DISPATCHED')
    expect(replay.body.original_keys_preserved).toBe(true)
    expect(replay.body.preserved_keys.eventId).toBe(eventId)
    expect(replay.body.preserved_keys.requestDigest).toBe(digest)
    expect(replay.body.preserved_keys.externalRef).toBe(ext)
    expect(replay.body.actual_connection).toBe(false)
  })
})

describe('GET/POST /group/rework|/scrap', () => {
  it('empty list 200; missing fields 422; create committed', async () => {
    if (skipIfNoDb()) return
    const token = await login()
    for (const path of ['/group/rework', '/group/scrap']) {
      const list = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`)
      expect(list.status).toBe(200)
      expect(list.body.items).toEqual([])
      const bad = await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send({})
      expect(bad.status).toBe(422)
    }
    const rw = await request(app.getHttpServer())
      .post('/group/rework')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId, title: 'rw', reason: 'entry', materialCode: 'M-RW' })
    expect(rw.status).toBe(201)
    expect(rw.body.data.notDispositionInventoryLinked).toBe(true)
    const sc = await request(app.getHttpServer())
      .post('/group/scrap')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId, title: 'sc', reason: 'entry', materialCode: 'M-SC', scrapQty: '1' })
    expect(sc.status).toBe(201)
  })
})

describe('org grant cross-enterprise', () => {
  it('empty grant 422; create enterprise auto-grants', async () => {
    if (skipIfNoDb()) return
    const token = await login()
    const bad = await request(app.getHttpServer())
      .post('/org/grants')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Reason', 'probe')
      .send({})
    expect(bad.status).toBe(422)

    const code = `ENT-VT-${Date.now().toString(36)}`
    const created = await request(app.getHttpServer())
      .post('/org/nodes')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Reason', 'cross-ent auto')
      .send({ code, name: `Vitest Cross ${code}`, kind: 'enterprise' })
    expect(created.status).toBe(201)
    expect(created.body.data.crossEnterpriseAutoGrantId).toBeTruthy()
  })
})
