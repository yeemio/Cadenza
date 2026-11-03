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
import { DispositionModule } from '../../apps/api/src/disposition/disposition.module'
import { QD_TEST_DB_NAME, prepareQdTestDatabase, qdDatabaseUrl, seedQdFixtures } from './disposition-test-env'

/**
 * disposition API 集成（真容器独立库 cadenza_disposition + supertest 挂载模块，无桩；
 * 测试组合 = ConfigModule/DbModule/AuthModule（全局守卫）/DispositionModule
 * ——不改共享 app.module.ts，L0 整合步统一注册）。
 * 端点级证据（业务主链在 tests/integration/disposition-flow.spec.ts，命令总线层）：
 * ⑤ 鉴权与数据范围（OA-24/25 + IT-S1）：未鉴权 401、许可缺失 403、跨厂 plantId 403；
 * ⑥ 端点行为：存疑扫码预检（QD-01 只查询）、参数缺失 400、业务规则中文错误带 [QD-x]、
 *    批次视图 404、命令幂等（同 x-operation-id 回放原结果）、码异常状态投影（QD-10）。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
let finishedMaterialId = ''
const run = `apqd${Date.now().toString(36)}`

beforeAll(async () => {
  try {
    pool = await prepareQdTestDatabase()
    await seedQdFixtures(pool)
  } catch {
    dbAvailable = false
    console.warn(`SKIP disposition api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${QD_TEST_DB_NAME}）。`)
    return
  }
  const plant = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'PLNT-SZ'`)
  szPlantId = plant.rows[0]!.id
  const mat = await pool.query<{ id: string }>(`SELECT id FROM material WHERE code = 'MAT-QD-FIN'`)
  finishedMaterialId = mat.rows[0]!.id

  process.env['DATABASE_URL'] = qdDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, AuthModule, DispositionModule],
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

describe('⑤ 鉴权与数据范围（OA-24/25 + IT-S1）', () => {
  it('未鉴权 401；许可缺失 403（foreman 无 disposition.read）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const anon = await request(app.getHttpServer()).get('/disposition/defects')
    expect(anon.status).toBe(401)
    const token = await login('szws01', 'SzWorkshop01')
    const res = await request(app.getHttpServer()).get('/disposition/defects').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
  })

  it('跨厂显式 plantId → 403 ERR_FORBIDDEN_SCOPE；sysadmin 企业范围可查询', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hfToken = await login('hfadmin01', 'HfPlant0001') // plantadmin：disposition.read 仅合肥厂范围
    const adminToken = await login('admin', 'CadAdmin001') // sysadmin：华东企业范围
    const hf = await request(app.getHttpServer())
      .get(`/disposition/suspect/scan-check?plantId=${szPlantId}&unitNo=U-QD-A`)
      .set('Authorization', `Bearer ${hfToken}`)
    expect(hf.status).toBe(403)
    expect(hf.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    const admin = await request(app.getHttpServer())
      .get(`/disposition/suspect/scan-check?plantId=${szPlantId}&unitNo=U-QD-A`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(admin.status).toBe(200)
    expect(admin.body.ok).toBe(true)
  })
})

describe('⑥ 端点行为（[QD-x] 中文错误/404/参数校验/幂等/投影）', () => {
  it('存疑扫码预检：参数缺失 400；不存在码=未入库拒绝标签（QD-01 只查询）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const missing = await request(app.getHttpServer())
      .get(`/disposition/suspect/scan-check?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(missing.status).toBe(400)
    const unknown = await request(app.getHttpServer())
      .get(`/disposition/suspect/scan-check?plantId=${szPlantId}&unitNo=NO-SUCH-CODE`)
      .set('Authorization', `Bearer ${token}`)
    expect(unknown.status).toBe(200)
    expect(unknown.body.ok).toBe(false)
    expect(unknown.body.reason).toBe('no_material')
    expect(unknown.body.reasonLabel).toBe('该轴不存在关联料品')
  })

  it('命令业务拒绝：中文错误带 [QD-x]（judge 备注缺失 422 [QD-13]）；批次视图 404', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const judge = await request(app.getHttpServer())
      .post('/disposition/qc/judge')
      .set('Authorization', `Bearer ${token}`)
      .send({ batchNo: 'BATCH-QD-0001', judgement: 'qualified', remark: '' })
    expect(judge.status).toBe(422)
    expect(judge.body.code).toBe(ERROR_CODES.BUSINESS_RULE)
    expect(judge.body.message).toContain('[QD-13]')
    const view = await request(app.getHttpServer())
      .get('/disposition/qc/batches/NO-SUCH-BATCH')
      .set('Authorization', `Bearer ${token}`)
    expect(view.status).toBe(404)
  })

  it('成品异常：提交成功 200；码异常状态投影=异常未处理；审核后归无异常（QD-10）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const opId = `${run}-api-defect-1`
    const submit = await request(app.getHttpServer())
      .post('/disposition/defects/submit')
      .set('Authorization', `Bearer ${token}`)
      .set('x-operation-id', opId)
      .send({ plantId: szPlantId, unitNo: 'U-QD-C', materialId: finishedMaterialId, defectType: 'rework', defectQty: '3.0000' })
    expect(submit.status).toBe(200)
    expect(submit.body.data.reviewStatus).toBe('unreviewed')
    const state = await request(app.getHttpServer())
      .get(`/disposition/defects/unit-state?plantId=${szPlantId}&unitNo=U-QD-C&materialId=${finishedMaterialId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(state.status).toBe(200)
    expect(state.body.unitDefectState).toBe('defect_open')
    // 幂等：同 operationId 重放返回原结果
    const replay = await request(app.getHttpServer())
      .post('/disposition/defects/submit')
      .set('Authorization', `Bearer ${token}`)
      .set('x-operation-id', opId)
      .send({ plantId: szPlantId, unitNo: 'U-QD-C', materialId: finishedMaterialId, defectType: 'rework', defectQty: '3.0000' })
    expect(replay.status).toBe(200)
    expect(replay.body.data.defectNo).toBe(submit.body.data.defectNo)
    // 审核不通过 → 异常状态清（不扣数量）
    const review = await request(app.getHttpServer())
      .post('/disposition/defects/review')
      .set('Authorization', `Bearer ${token}`)
      .send({ defectNo: submit.body.data.defectNo, result: 'rejected' })
    expect(review.status).toBe(200)
    const state2 = await request(app.getHttpServer())
      .get(`/disposition/defects/unit-state?plantId=${szPlantId}&unitNo=U-QD-C&materialId=${finishedMaterialId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(state2.body.unitDefectState).toBe('normal')
  })

  it('处置命令端点：报废缺依据 422 带 [QD-20]（高影响强制理由）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const r = await request(app.getHttpServer())
      .post('/disposition/dispositions/scrap')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: szPlantId, unitNo: 'U-QD-D', scrapQty: '1.0000', destinationNote: 'x' })
    expect(r.status).toBe(422)
    expect(r.body.message).toContain('[QD-20]')
    expect(r.body.message).toContain('报废')
  })
})
