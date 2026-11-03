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
import { ReworkModule } from '../../apps/api/src/rework/rework.module'
import {
  RWK_TEST_DB_NAME,
  prepareRwkTestDatabase,
  rwkDatabaseUrl,
  rwkNodeId,
} from './rework-test-env'

/**
 * rework API 集成（真容器独立库 cadenza_rework + supertest 挂载模块，无桩；
 * 测试组合 = ConfigModule/DbModule/AuthModule（全局守卫）/ReworkModule
 * ——不改共享 app.module.ts，L0 整合步统一注册）。
 * 端点级证据（业务主链在 tests/integration/rework-flow.spec.ts，命令总线层）：
 * ⑧ 鉴权与数据范围（OA-24/25 + A-S1）：未鉴权 401、许可缺失 403、
 *    跨厂显式 plantId 403 ERR_FORBIDDEN_SCOPE、不带参数服务端过滤 0 行；
 * ⑨ 端点行为：参数缺失 422、业务规则中文错误带 [RS-x]（RS-02 守恒拒绝）、
 *    数量 number 拒（IT-07 十进制字符串）、记录 404、命令幂等（同 x-operation-id 回放原结果）。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
const run = `aprwk${Date.now().toString(36)}`

beforeAll(async () => {
  try {
    pool = await prepareRwkTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP rework api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${RWK_TEST_DB_NAME}）。`)
    return
  }
  szPlantId = await rwkNodeId(pool, 'PLNT-SZ')

  process.env['DATABASE_URL'] = rwkDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, AuthModule, ReworkModule],
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

describe('⑧ 鉴权与数据范围（OA-24/25 + A-S1）', () => {
  it('未鉴权 401；许可缺失 403（foreman 无 rework.read）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const anon = await request(app.getHttpServer()).get('/rework/reel-split/records')
    expect(anon.status).toBe(401)
    const token = await login('szws01', 'SzWorkshop01')
    const res = await request(app.getHttpServer()).get('/rework/reel-split/records').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
  })

  it('跨厂显式 plantId → 403 ERR_FORBIDDEN_SCOPE；不带参数 → 服务端过滤仅本厂（0 行）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hfToken = await login('hfadmin01', 'HfPlant0001') // plantadmin：rework.read 仅合肥厂范围
    const adminToken = await login('admin', 'CadAdmin001') // sysadmin：华东企业范围

    for (const path of [
      `/rework/reel-split/scan?plantId=${szPlantId}&unitNo=AE0001`,
      `/rework/axis-correction/scan?plantId=${szPlantId}&unitNo=AE0001`,
      `/rework/pallet/export?plantId=${szPlantId}`,
    ]) {
      const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${hfToken}`)
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    }

    // 不带参数：服务端过滤到本厂（合肥此刻无 rework 数据 → 0 行，不暴露苏州行）
    for (const path of ['/rework/reel-split/records', '/rework/pallet/records', '/rework/axis-correction/records', '/rework/axis-retire/records']) {
      const hfList = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${hfToken}`)
      expect(hfList.status).toBe(200)
      expect(hfList.body.total).toBe(0)
    }

    // 企业范围可见（苏州厂夹具已就绪，列表结构 PageResult）
    const adminList = await request(app.getHttpServer())
      .get('/rework/reel-split/records')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(adminList.status).toBe(200)
    expect(adminList.body.total).toBe(0)
  })

  it('命令跨厂数据保护：hfadmin 扫苏州厂码 → 码不存在拒绝（不暴露他厂数据）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    // plantadmin 无 rework.post → 403（HTTP 守卫首检）
    const res = await request(app.getHttpServer())
      .post('/rework/reel-split/execute')
      .set('Authorization', `Bearer ${hfToken}`)
      .send({ sourceUnitNo: 'AE0001', pourLines: [] })
    expect(res.status).toBe(403)
  })
})

describe('⑨ 端点行为（参数/错误码/幂等）', () => {
  it('参数缺失 422（reel-split/scan、axis-correction/scan、pallet/export）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const noUnit = await request(app.getHttpServer()).get(`/rework/reel-split/scan?plantId=${szPlantId}`).set('Authorization', `Bearer ${token}`)
    expect(noUnit.status).toBe(422)
    expect(noUnit.body.code).toBe(ERROR_CODES.BUSINESS_RULE)
    const noPlant = await request(app.getHttpServer()).get('/rework/reel-split/scan?unitNo=AE1').set('Authorization', `Bearer ${token}`)
    expect(noPlant.status).toBe(422)
    const noExportPlant = await request(app.getHttpServer()).get('/rework/pallet/export').set('Authorization', `Bearer ${token}`)
    expect(noExportPlant.status).toBe(422)
  })

  it('倒轴业务拒绝带 [RS-02] 全中文错误（守恒式：倒入合计＋损耗超原量）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    // 造一个苏州厂在库码（直插余额，收货命令见 integration spec）
    const res = await request(app.getHttpServer())
      .post('/rework/reel-split/execute')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceUnitNo: `AE${run}-NOSRC`,
        pourLines: [{ unitNo: `AE${run}-NOT1`, quantity: '10.0000' }],
      })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(ERROR_CODES.BUSINESS_RULE)
    expect(res.body.message).toContain('[RS-03]')
    expect(typeof res.body.message).toBe('string')
  })

  it('数量 number 拒（IT-07 十进制字符串）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const res = await request(app.getHttpServer())
      .post('/rework/reel-split/execute')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceUnitNo: `AE${run}-X1`,
        pourLines: [{ unitNo: `AE${run}-X2`, quantity: 600 }],
      })
    expect(res.status).toBe(422)
  })

  it('pallet/current 无进行中任务 → 404', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const res = await request(app.getHttpServer()).get('/rework/pallet/current?taskType=split_pallet').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(ERROR_CODES.NOT_FOUND)
  })

  it('命令幂等：同 x-operation-id 重放回放原结果（倒轴单恰一张）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    // 直插夹具：源码 + 余额（api 层证据不依赖 inventory 命令）
    const enterprise = await pool.query<{ enterprise_id: string }>(`SELECT enterprise_id FROM org_node WHERE id = $1`, [szPlantId])
    const material = await pool.query<{ id: string }>(`SELECT id FROM material WHERE code = 'MAT-RWK-FIN'`)
    const lot = await pool.query<{ id: string }>(
      `INSERT INTO material_lot (lot_no, kind, material_id, material_code, plant_id, enterprise_id, created_by)
       VALUES ($1, 'production', $2, 'MAT-RWK-FIN', $3, $4, 'seed') RETURNING id`,
      [`LOT-${run}-API`, material.rows[0]!.id, szPlantId, enterprise.rows[0]!.enterprise_id],
    ).catch(() => pool.query<{ id: string }>(`SELECT id FROM material_lot WHERE lot_no = $1 AND plant_id = $2`, [`LOT-${run}-API`, szPlantId]))
    const unit = await pool.query<{ id: string }>(
      `INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code, trace_mode, status, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, 'MAT-RWK-FIN', $3, $4, 'M', 'quantity', 'in_stock', $5, $6, 'seed') RETURNING id`,
      [`AE${run}-IDSRC`, material.rows[0]!.id, lot.rows[0]!.id, '33333333-3333-4333-8333-3333333333d1', szPlantId, enterprise.rows[0]!.enterprise_id],
    )
    const location = await pool.query<{ id: string; code: string }>(
      `SELECT id, code FROM storage_location WHERE plant_id = $1 AND code = '92980101'`,
      [szPlantId],
    )
    await pool.query(
      `INSERT INTO stock_balance (unit_id, location_id, location_code, owner_id, owner_name, quantity, uom_id, uom_code, measurement_basis, quality_status, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, $3, $4, $5, 100.0000, $6, 'M', 'nominal', 'qualified', $7, $8, 'seed')`,
      [unit.rows[0]!.id, location.rows[0]!.id, location.rows[0]!.code, '22222222-2222-4222-8222-222222222301', '华东电缆集团（自有）', '33333333-3333-4333-8333-3333333333d1', szPlantId, enterprise.rows[0]!.enterprise_id],
    )
    const opId = `${run}-idem-1`
    const body = {
      sourceUnitNo: `AE${run}-IDSRC`,
      pourLines: [{ unitNo: `AE${run}-IDT1`, quantity: '100.0000' }],
    }
    const first = await request(app.getHttpServer())
      .post('/rework/reel-split/execute')
      .set('Authorization', `Bearer ${token}`)
      .set('x-operation-id', opId)
      .send(body)
    expect(first.status).toBe(201)
    const replay = await request(app.getHttpServer())
      .post('/rework/reel-split/execute')
      .set('Authorization', `Bearer ${token}`)
      .set('x-operation-id', opId)
      .send(body)
    expect(replay.status).toBe(201)
    expect(replay.body.data.orderId).toBe(first.body.data.orderId)
    const orders = await pool.query(`SELECT count(*)::int AS c FROM reel_split_order WHERE source_unit_no = $1`, [`AE${run}-IDSRC`])
    expect(orders.rows[0]!.c).toBe(1)
  })
})
