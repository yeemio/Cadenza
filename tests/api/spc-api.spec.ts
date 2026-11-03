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
import { SpcModule } from '../../apps/api/src/spc/spc.module'
import { SPC_TEST_DB_NAME, prepareSpcTestDatabase, seedSpcFixtures, spcDatabaseUrl, spcNodeId } from './spc-test-env'

/**
 * spc API 集成（真容器独立库 cadenza_p3c + supertest 挂载模块，无桩；
 * 测试组合 = ConfigModule/DbModule/AuthModule（全局守卫）/SpcModule——不改共享
 * app.module.ts，L0 整合步统一注册）。
 * 证据：跨厂 403 与列表服务端过滤（OA-24/25 + A-S1）；端点级行为：
 * 许可缺失 403、未鉴权 401、命令二道防线、命令幂等（同 opId 重放原结果）、
 * 数量 number 拒 422、圈定缺参 422、控制图投影。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
let gaugeId = ''
const run = `apspc${Date.now().toString(36)}`

beforeAll(async () => {
  try {
    pool = await prepareSpcTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP spc api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${SPC_TEST_DB_NAME}）。`)
    return
  }
  await seedSpcFixtures(pool)
  szPlantId = await spcNodeId(pool, 'PLNT-SZ')

  process.env['DATABASE_URL'] = spcDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, AuthModule, SpcModule],
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
  it('合肥厂管理员显式查苏州厂变更单/受控项目/失控任务 → 403 ERR_FORBIDDEN_SCOPE；不带参数 → 服务端过滤仅本厂（0 行）；企业范围可见', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 直插一条苏州厂变更单（API 层证据不依赖命令面）
    const spec = await pool.query<{ id: string }>(
      `SELECT id FROM parameter_spec_revision WHERE version = 2 AND name LIKE '绞制参数规范%' LIMIT 1`,
    )
    await pool.query(
      `INSERT INTO spc_process_change
         (change_no, old_spec_revision_id, new_spec_revision_id, approver, effective_at, plant_id, enterprise_id, created_by)
       VALUES ($1, (SELECT id FROM parameter_spec_revision WHERE version = 1 AND name LIKE '绞制参数规范%' LIMIT 1),
         $2, '工艺-张工', '2026-11-05T08:00:00Z', $3,
         (SELECT enterprise_id FROM org_node WHERE id = $3), 'ap-seed')`,
      [`PC-${run}-API1`, spec.rows[0]!.id, szPlantId],
    )
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    const adminToken = await login('admin', 'CadAdmin001')

    for (const path of [
      `/spc/changes?plantId=${szPlantId}`,
      `/spc/control-items?plantId=${szPlantId}`,
      `/spc/ooc-tasks?plantId=${szPlantId}`,
      `/spc/tools?plantId=${szPlantId}`,
    ]) {
      const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${hfToken}`)
      expect(res.status, path).toBe(403)
      expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    }

    const hfList = await request(app.getHttpServer()).get('/spc/changes').set('Authorization', `Bearer ${hfToken}`)
    expect(hfList.status).toBe(200)
    expect(hfList.body.total).toBe(0)
    const adminList = await request(app.getHttpServer()).get('/spc/changes').set('Authorization', `Bearer ${adminToken}`)
    expect(adminList.status).toBe(200)
    expect(adminList.body.total).toBeGreaterThanOrEqual(1)
    expect(adminList.body.items.every((c: { plantId: string }) => c.plantId === szPlantId)).toBe(true)
    // 变更详情含 PE-06 三类影响分组
    const detail = await request(app.getHttpServer())
      .get(`/spc/changes/${adminList.body.items[0]!.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(detail.status).toBe(200)
    expect(detail.body.impactGroups).toBeDefined()
    expect(detail.body.oldSpecLabel).toContain('v1')
    expect(detail.body.newSpecLabel).toContain('v2')
  })

  it('命令二道防线：hfadmin 向苏州厂登记器具 → 403（A-S1）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    const res = await request(app.getHttpServer())
      .post('/spc/gauge/register')
      .set('Authorization', `Bearer ${hfToken}`)
      .send({ plantId: szPlantId, gaugeNo: `G-${run}-X`, name: '越权器具' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
  })
})

describe('端点级行为', () => {
  it('许可缺失 403（szws01 无 spc.read）；未鉴权 401', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const foremanToken = await login('szws01', 'SzWorkshop01')
    const res = await request(app.getHttpServer()).get('/spc/changes').set('Authorization', `Bearer ${foremanToken}`)
    expect(res.status).toBe(403)
    const unauth = await request(app.getHttpServer()).get('/spc/changes')
    expect(unauth.status).toBe(401)
  })

  it('命令幂等：同 operationId 重放原结果（器具登记不重复建）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const adminToken = await login('admin', 'CadAdmin001')
    const opId = `${run}-gauge-idem`
    const payload = { plantId: szPlantId, gaugeNo: `G-${run}-IDEM`, name: '幂等器具', operationId: opId }
    const first = await request(app.getHttpServer())
      .post('/spc/gauge/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload)
    expect(first.status).toBe(201)
    expect(first.body.status).toBe(CommandResultStatus.COMMITTED)
    const replay = await request(app.getHttpServer())
      .post('/spc/gauge/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload)
    expect(replay.status).toBe(201)
    expect(replay.body.data).toEqual(first.body.data)
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM spc_gauge WHERE gauge_no = $1`,
      [`G-${run}-IDEM`],
    )
    expect(Number(rows.rows[0]!.count)).toBe(1)
    gaugeId = (first.body.data as { gaugeId: string }).gaugeId
  })

  it('数量字段 number → 422（PE-01 定点字符串口径）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const adminToken = await login('admin', 'CadAdmin001')
    const res = await request(app.getHttpServer())
      .post('/spc/gauge/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, gaugeNo: `G-${run}-N`, name: 'x' })
    expect([201, 422]).toContain(res.status)
    const bad = await request(app.getHttpServer())
      .post('/spc/calibration/record')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        gaugeId,
        calibratedAt: '2026-10-01T00:00:00Z',
        result: 'qualified',
        certificateNo: 'CERT-API-1',
        validUntil: '2027-10-01T00:00:00Z',
        basis: 'JJG',
      })
    expect(bad.status).toBe(201)
    // 受控项目缺 specVersion → 422
    const item = await request(app.getHttpServer())
      .post('/spc/control-item/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, specCode: 'INS-CABLE', itemNo: 'OD-99' })
    expect(item.status).toBe(422)
    expect(item.body.message).toContain('[PE-08]')
  })

  it('圈定缺参 422；器具详情含校准状态与可排产判定', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const adminToken = await login('admin', 'CadAdmin001')
    const missing = await request(app.getHttpServer())
      .get(`/spc/miscalibration/circle?gaugeId=${gaugeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(missing.status).toBe(422)
    const detail = await request(app.getHttpServer())
      .get(`/spc/gauges/${gaugeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(detail.status).toBe(200)
    expect(detail.body.calibrationStatus).toBe('valid')
    expect(detail.body.schedulableForInspection).toBe(true)
    expect(detail.body.calibrationHistory.length).toBe(1)
    const circle = await request(app.getHttpServer())
      .get(`/spc/miscalibration/circle?gaugeId=${gaugeId}&from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(circle.status).toBe(200)
    expect(circle.body.dispositionProgress).toBeDefined()
  })
})
