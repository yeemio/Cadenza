import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus } from '@cadenza/contracts'
import { validateEnv } from '../../apps/api/src/env'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { DbModule } from '../../apps/api/src/db/db.module'
import { MasterDataApiModule } from '../../apps/api/src/masterdata/masterdata.composition'
import { IntegrationsApiModule } from '../../apps/api/src/integrations/integrations.composition'
import {
  IF01_TEST_DB_NAME,
  if01DatabaseUrl,
  nodeId,
  prepareIf01TestDatabase,
} from './integration-material-test-env'

/**
 * IF-01 料品入站 API：独立库 cadenza_if01；upsert + 修订幂等 + 缺映射隔离 + 列表可见。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let enterpriseId = ''
const run = `if01${Date.now().toString(36)}`

beforeAll(async () => {
  try {
    pool = await prepareIf01TestDatabase()
  } catch (e) {
    dbAvailable = false
    console.warn(`SKIP if01 api: 数据库不可达（${IF01_TEST_DB_NAME}）`, e)
    return
  }
  enterpriseId = await nodeId(pool, 'ENT-HD')
  process.env['DATABASE_URL'] = if01DatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      DbModule,
      AuthModule,
      MasterDataApiModule,
      IntegrationsApiModule,
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

describe('IF-01 material-master sync', () => {
  it('upserts with revision, lists material, rejects stale, quarantines missing org', async () => {
    if (skipIfNoDb()) return
    const token = await login()
    const code = `MAT-${run}`

    const sync = await request(app.getHttpServer())
      .post('/integrations/material-master/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `${run}-sync-1`,
        companyOrgCode: 'ENT-HD',
        orgScopeId: enterpriseId,
        code,
        name: 'IF01测试料品',
        materialType: 3,
        baseUom: 'KG',
        qcFlag: 0,
        externalRevision: 1,
        sourceSystem: 'U9_SIM',
      })
    expect([200, 201]).toContain(sync.status)
    expect(sync.body.status).toBe(CommandResultStatus.COMMITTED)
    const materialId = sync.body.data.materialId as string
    expect(materialId).toBeTruthy()
    expect(sync.body.data.applied).toBe(true)

    const list = await request(app.getHttpServer())
      .get('/masterdata/materials?page=1&pageSize=50')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    const hit = (list.body.items as Array<{ id: string; code: string; externalRevision: number | null }>).find(
      (m) => m.id === materialId,
    )
    expect(hit?.code).toBe(code)
    expect(hit?.externalRevision).toBe(1)

    const idem = await request(app.getHttpServer())
      .post('/integrations/material-master/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `${run}-sync-1b`,
        companyOrgCode: 'ENT-HD',
        code,
        name: 'IF01测试料品',
        materialType: 3,
        baseUom: 'KG',
        externalRevision: 1,
        sourceSystem: 'U9_SIM',
      })
    expect([200, 201]).toContain(idem.status)
    expect(idem.body.data.applied).toBe(false)
    expect(idem.body.data.stale).toBe(false)

    const stale = await request(app.getHttpServer())
      .post('/integrations/material-master/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `${run}-sync-stale`,
        companyOrgCode: 'ENT-HD',
        code,
        name: '旧名',
        materialType: 3,
        baseUom: 'KG',
        externalRevision: 1,
        sourceSystem: 'U9_SIM',
      })
    // same revision → idempotent; use lower for stale — bump first then stale
    const bump = await request(app.getHttpServer())
      .post('/integrations/material-master/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `${run}-sync-2`,
        companyOrgCode: 'ENT-HD',
        code,
        name: 'IF01测试料品-v2',
        materialType: 3,
        baseUom: 'KG',
        externalRevision: 2,
        sourceSystem: 'U9_SIM',
      })
    expect(bump.body.data.applied).toBe(true)

    const stale2 = await request(app.getHttpServer())
      .post('/integrations/material-master/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `${run}-sync-stale2`,
        companyOrgCode: 'ENT-HD',
        code,
        name: '旧名',
        materialType: 3,
        baseUom: 'KG',
        externalRevision: 1,
        sourceSystem: 'U9_SIM',
      })
    expect([200, 201]).toContain(stale2.status)
    expect(stale2.body.data.stale).toBe(true)
    expect(stale2.body.data.applied).toBe(false)

    const missing = await request(app.getHttpServer())
      .post('/integrations/material-master/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `${run}-sync-q`,
        companyOrgCode: 'ORG-DOES-NOT-EXIST',
        code: `MAT-Q-${run}`,
        name: '隔离料品',
        materialType: 1,
        baseUom: 'KG',
        externalRevision: 1,
        sourceSystem: 'SAP_SIM',
      })
    expect(missing.status).toBe(422)
    expect(String(missing.body.message)).toMatch(/IF-00\.8|隔离/)

    const inbox = await pool.query(
      `SELECT status FROM inbox WHERE entity_type = 'material_master' AND external_key = $1`,
      [`MAT-Q-${run}`],
    )
    expect(inbox.rows[0]?.status).toBe('QUARANTINED')

    // silence unused
    expect(stale.status).toBeGreaterThan(0)
  })
})
