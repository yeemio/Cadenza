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
import { CswModule } from '../../apps/api/src/csw/csw.module'
import {
  CSW_TEST_DB_NAME,
  cswDatabaseUrl,
  prepareCswTestDatabase,
  seedCswFixtures,
} from './csw-test-env'

/**
 * csw API 集成（真容器独立库 cadenza_p3b + supertest 挂载模块，无桩；
 * 测试组合 = ConfigModule/DbModule/AuthModule（全局守卫）/CswModule
 * ——不改共享 app.module.ts，L0 整合步统一注册）。
 * 证据：跨厂 403 与列表服务端过滤（OA-24/25）；许可缺失 403/未鉴权 401；
 * 解冻具名权限 csw.unfreeze 守卫层；命令二道防线；端点级行为（422/404/幂等重放）。
 */

const TODAY = '2026-10-28'

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
let eqAId = ''
let order4OpId = ''
let transitLocationId = ''
let transitLocationCode = ''
let adminToken = ''
let hfToken = ''
const run = `apcsw${Date.now().toString(36)}`

beforeAll(async () => {
  try {
    pool = await prepareCswTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP csw api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${CSW_TEST_DB_NAME}）。`)
    return
  }
  const fx = await seedCswFixtures(pool, TODAY)
  szPlantId = fx.szPlantId
  eqAId = fx.eqAId
  order4OpId = fx.order4OpId
  transitLocationId = fx.transitLocationId
  transitLocationCode = fx.transitLocationCode

  process.env['DATABASE_URL'] = cswDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, AuthModule, CswModule],
  }).compile()
  app = moduleRef.createNestApplication()
  await app.init()

  adminToken = await login('admin', 'CadAdmin001')
  hfToken = await login('hfadmin01', 'HfPlant0001')
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

describe('csw API（守卫/范围/端点行为）', () => {
  it('未鉴权 401；无 csw.read 许可 403（szqc01 仅 org.read）', async () => {
    if (skipIfNoDb()) return
    const noAuth = await request(app.getHttpServer()).get('/csw/versions')
    expect(noAuth.status).toBe(401)
    const szqc = await login('szqc01', 'SzQuality01')
    const noPerm = await request(app.getHttpServer()).get('/csw/versions').set('Authorization', `Bearer ${szqc}`)
    expect(noPerm.status).toBe(403)
  })

  it('跨厂 403：hfadmin01（合肥厂范围）显式 plantId=<SZ> 查询被拒（OA-24/A-S1）', async () => {
    if (skipIfNoDb()) return
    for (const path of ['freeze-records', 'versions', 'outsourcing-tasks', 'outsourcing-erp-export']) {
      const res = await request(app.getHttpServer())
        .get(`/csw/${path}`)
        .query({ plantId: szPlantId })
        .set('Authorization', `Bearer ${hfToken}`)
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    }
  })

  it('列表服务端过滤：hfadmin01 不带参数只见本厂（空），admin 企业范围可见', async () => {
    if (skipIfNoDb()) return
    const hfList = await request(app.getHttpServer())
      .get('/csw/versions')
      .set('Authorization', `Bearer ${hfToken}`)
    expect(hfList.status).toBe(200)
    expect(hfList.body.total).toBe(0) // 合肥厂无 csw 版本
    const adminList = await request(app.getHttpServer())
      .get('/csw/versions')
      .query({ plantId: szPlantId })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(adminList.status).toBe(200)
    expect(adminList.body.total).toBe(0) // 尚未提议
    // 详情不存在 → 404
    const missing = await request(app.getHttpServer())
      .get('/csw/versions/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(missing.status).toBe(404)
  })

  it('命令链路：propose→commit（confirm+reason）HTTP 全链路 + 跨厂命令 403 二道防线', async () => {
    if (skipIfNoDb()) return
    const proposeRes = await request(app.getHttpServer())
      .post('/csw/reschedule/propose')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plantId: szPlantId, today: TODAY })
    expect(proposeRes.status).toBe(200)
    expect(proposeRes.body.data.versionId).toBeTruthy()
    const versionId = proposeRes.body.data.versionId as string
    // 软约束未确认 → 422（[CS-06]）
    const noConfirm = await request(app.getHttpServer())
      .post('/csw/reschedule/commit')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ versionId })
    expect(noConfirm.status).toBe(422)
    // 跨厂命令：hfadmin 提交（plantId 无关但版本属苏州厂）→ 403
    const crossPlant = await request(app.getHttpServer())
      .post('/csw/reschedule/commit')
      .set('Authorization', `Bearer ${hfToken}`)
      .send({ versionId, confirm: true, reason: '越权提交' })
    expect(crossPlant.status).toBe(403)
    const commitRes = await request(app.getHttpServer())
      .post('/csw/reschedule/commit')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ versionId, confirm: true, reason: 'HTTP 全链路提交' })
    expect(commitRes.status).toBe(200)
    expect(commitRes.body.data.status).toBe('committed')
    // 已提交版本重复提交 → 422（[CS-27]）
    const reCommit = await request(app.getHttpServer())
      .post('/csw/reschedule/commit')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ versionId, confirm: true, reason: '重复提交' })
    expect(reCommit.status).toBe(422)
    expect(reCommit.body.message).toContain('CS-27')
    // 版本详情与比较端点
    const detail = await request(app.getHttpServer())
      .get(`/csw/versions/${versionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(detail.status).toBe(200)
    expect(detail.body.items.length).toBeGreaterThan(0)
    const compare = await request(app.getHttpServer())
      .get(`/csw/versions/${versionId}/compare`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(compare.status).toBe(200)
  })

  it('冻结全链路：创建/重叠 422/解冻须具名权限（守卫层 403）/admin 解冻留痕', async () => {
    if (skipIfNoDb()) return
    const createRes = await request(app.getHttpServer())
      .post('/csw/freeze/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        equipmentId: eqAId,
        scope: 'equipment_date_range',
        productionDateFrom: '2026-11-05',
        productionDateTo: '2026-11-06',
        reason: 'HTTP 冻结证据',
      })
    expect(createRes.status).toBe(200)
    const freezeId = createRes.body.data.freezeId as string
    // 重叠 → 422（[CS-S2]）
    const overlap = await request(app.getHttpServer())
      .post('/csw/freeze/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plantId: szPlantId,
        equipmentId: eqAId,
        scope: 'equipment_date_range',
        productionDateFrom: '2026-11-06',
        productionDateTo: '2026-11-07',
      })
    expect(overlap.status).toBe(422)
    expect(overlap.body.message).toContain('CS-S2')
    // hfadmin 无 csw.unfreeze → 守卫层 403
    const forbidden = await request(app.getHttpServer())
      .post('/csw/freeze/release')
      .set('Authorization', `Bearer ${hfToken}`)
      .send({ freezeId, reason: '越权解冻' })
    expect(forbidden.status).toBe(403)
    // admin 解冻（具名权限）成功留痕
    const release = await request(app.getHttpServer())
      .post('/csw/freeze/release')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ freezeId, reason: 'HTTP 解冻证据' })
    expect(release.status).toBe(200)
    expect(release.body.data.status).toBe('ended')
    // 解冻审计行（CS-26）
    const audit = await request(app.getHttpServer())
      .get('/csw/override-audit')
      .query({ plantId: szPlantId, overrideType: 'unfreeze' })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(audit.status).toBe(200)
    expect(audit.body.items.length).toBeGreaterThanOrEqual(1)
  })

  it('外协端点：数量 number 拒 422；create 成功；ERP 导出含事实；载荷携带含金额字段拒', async () => {
    if (skipIfNoDb()) return
    const badQty = await request(app.getHttpServer())
      .post('/csw/outsourcing/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        orderOperationId: order4OpId,
        supplierName: 'HTTP 外协厂',
        qty: 100,
        transitLocationId,
        transitLocationCode,
      })
    expect(badQty.status).toBe(422) // 数量须十进制串（CS-S4 口径）
    const settled = await request(app.getHttpServer())
      .post('/csw/outsourcing/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        orderOperationId: order4OpId,
        supplierName: 'HTTP 外协厂',
        qty: '10.0000',
        transitLocationId,
        transitLocationCode,
        amount: '1',
      })
    expect(settled.status).toBe(422)
    expect(settled.body.message).toContain('CS-24')
    const ok = await request(app.getHttpServer())
      .post('/csw/outsourcing/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        orderOperationId: order4OpId,
        supplierName: 'HTTP 外协厂',
        qty: '10.0000',
        transitLocationId,
        transitLocationCode,
      })
    expect(ok.status).toBe(200)
    expect(ok.body.data.status).toBe('draft')
    const taskId = ok.body.data.taskId as string
    const detail = await request(app.getHttpServer())
      .get(`/csw/outsourcing-tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(detail.status).toBe(200)
    expect(detail.body.task.statusLabel).toBe('草稿')
    const exportRes = await request(app.getHttpServer())
      .get('/csw/outsourcing-erp-export')
      .query({ plantId: szPlantId })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(exportRes.status).toBe(200)
    expect(exportRes.body.facts.length).toBeGreaterThanOrEqual(1)
  })

  it('幂等：同 x-operation-id 冻结创建重放原结果（freezeId 不变）', async () => {
    if (skipIfNoDb()) return
    const opId = `${run}-idem`
    const body = {
      plantId: szPlantId,
      equipmentId: eqAId,
      scope: 'equipment_date_range',
      productionDateFrom: '2026-11-08',
      productionDateTo: '2026-11-08',
    }
    const first = await request(app.getHttpServer())
      .post('/csw/freeze/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-operation-id', opId)
      .send(body)
    expect(first.status).toBe(200)
    const replay = await request(app.getHttpServer())
      .post('/csw/freeze/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-operation-id', opId)
      .send(body)
    expect(replay.status).toBe(200)
    expect(replay.body.data).toEqual(first.body.data)
    const list = await request(app.getHttpServer())
      .get('/csw/freeze-records')
      .query({ plantId: szPlantId, equipmentId: eqAId })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(list.status).toBe(200)
    expect(list.body.items.filter((i: { productionDateFrom: string }) => i.productionDateFrom === '2026-11-08').length).toBe(1)
  })

  it('就绪评估端点：缺参 422；不存在 404；正常返回四条件判定', async () => {
    if (skipIfNoDb()) return
    const missing = await request(app.getHttpServer())
      .get('/csw/readiness')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(missing.status).toBe(422)
    const notFound = await request(app.getHttpServer())
      .get('/csw/readiness')
      .query({ orderOperationId: '00000000-0000-4000-8000-000000000000' })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(notFound.status).toBe(404)
    const ordNo = await pool.query<{ id: string }>(
      `SELECT oo.id FROM order_operation oo JOIN production_order po ON po.id = oo.order_id WHERE po.order_no = 'CSW-SZ-002'`,
    )
    const ready = await request(app.getHttpServer())
      .get('/csw/readiness')
      .query({ orderOperationId: ordNo.rows[0]!.id })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(ready.status).toBe(200)
    expect(ready.body.ready).toBe(false) // 无合格库存（CS-08 阻断）
    expect(ready.body.blockers.some((b: { rule: string }) => b.rule === 'CS-08')).toBe(true)
    // 跨厂查询就绪 → 404（不存在或不在授权数据范围内——同 shipping 详情口径）
    const crossPlant = await request(app.getHttpServer())
      .get('/csw/readiness')
      .query({ orderOperationId: ordNo.rows[0]!.id })
      .set('Authorization', `Bearer ${hfToken}`)
    expect(crossPlant.status).toBe(404)
  })
})

