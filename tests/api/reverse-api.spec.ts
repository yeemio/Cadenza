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
import { ReverseModule } from '../../apps/api/src/reverse/reverse.module'
import { nodeId } from './reverse-test-env'
import {
  REV_TEST_DB_NAME,
  prepareRevTestDatabase,
  revDatabaseUrl,
} from './reverse-test-env'

/**
 * reverse API 集成（真容器独立库 cadenza_reverse + supertest 挂载模块，无桩；
 * 测试组合 = ConfigModule/DbModule/AuthModule（全局守卫）/ReverseModule
 * ——不改共享 app.module.ts，L0 整合步统一注册）。
 * 端点级证据（业务主链在 tests/integration/reverse-flow.spec.ts，命令总线层）：
 * ⑧ 鉴权与数据范围（OA-24/25 + A-S1）：未鉴权 401、许可缺失 403、
 *    跨厂显式 plantId 403 ERR_FORBIDDEN_SCOPE、不带参数服务端过滤、命令二道防线；
 * ⑨ 端点行为：参数缺失 422、业务规则中文错误带 [WR-x]（WR-27 借出须对象）、
 *    数量 number 拒（IT-07 十进制字符串）、详情 404、命令幂等（同 x-operation-id 回放原结果）。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
const run = `aprev${Date.now().toString(36)}`
const notFoundId = '11111111-1111-4111-8111-1111111111ee'

beforeAll(async () => {
  try {
    pool = await prepareRevTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP reverse api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${REV_TEST_DB_NAME}）。`)
    return
  }
  szPlantId = await nodeId(pool, 'PLNT-SZ')

  process.env['DATABASE_URL'] = revDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, AuthModule, ReverseModule],
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
  it('未鉴权 401；许可缺失 403（foreman 无 reverse.read）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const anon = await request(app.getHttpServer()).get('/reverse/move-records')
    expect(anon.status).toBe(401)
    const token = await login('szws01', 'SzWorkshop01')
    const res = await request(app.getHttpServer()).get('/reverse/move-records').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
  })

  it('跨厂显式 plantId → 403 ERR_FORBIDDEN_SCOPE；不带参数 → 服务端过滤仅本厂（0 行）；企业范围可见', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hfToken = await login('hfadmin01', 'HfPlant0001') // plantadmin：reverse.read 仅合肥厂范围
    const adminToken = await login('admin', 'CadAdmin001') // sysadmin：华东企业范围

    for (const path of [
      `/reverse/move-records?plantId=${szPlantId}`,
      `/reverse/stocktakes?plantId=${szPlantId}`,
      `/reverse/receipt-corrections?plantId=${szPlantId}`,
      `/reverse/carriers/available?plantId=${szPlantId}`,
    ]) {
      const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${hfToken}`)
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    }

    // 不带参数：服务端过滤到本厂（合肥此刻无逆向数据 → 0 行，不暴露苏州行）
    for (const path of ['/reverse/move-records', '/reverse/carrier-loans']) {
      const hfList = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${hfToken}`)
      expect(hfList.status).toBe(200)
      expect(hfList.body.total).toBe(0)
    }

    // 企业范围：可用载具含种子夹具 CARR-REV-01（此刻在役；端点返回裸数组）
    const adminList = await request(app.getHttpServer())
      .get(`/reverse/carriers/available?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(adminList.status).toBe(200)
    expect(Array.isArray(adminList.body)).toBe(true)
    expect(adminList.body.some((c: { carrierCode: string }) => c.carrierCode === 'CARR-REV-01')).toBe(true)
  })

  it('命令二道防线：hfadmin 向苏州厂发逆向命令 → 403（A-S1）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    const crossPlant = await request(app.getHttpServer())
      .post('/reverse/carrier/loan')
      .set('Authorization', `Bearer ${hfToken}`)
      .send({ operationId: `${run}-cross`, plantId: szPlantId, carrierCode: 'CARR-REV-01', eventKind: 'damage' })
    expect(crossPlant.status).toBe(403)
    expect(crossPlant.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    // 数据未变：载具仍在役、无借还事件
    const carrier = await pool.query<{ status: string }>(`SELECT status FROM carrier WHERE carrier_code = 'CARR-REV-01'`)
    expect(carrier.rows[0]!.status).toBe('in_service')
    const loans = await pool.query(`SELECT count(*)::int AS c FROM carrier_loan`)
    expect(loans.rows[0]!.c).toBe(0)
  })
})

describe('⑨ 端点行为（参数校验/错误码/幂等）', () => {
  it('参数缺失 → 422（move/scan-info、move/target-warehouses、receipt/code-received-summary）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    for (const path of ['/reverse/move/scan-info', `/reverse/move/scan-info?plantId=${szPlantId}`, '/reverse/move/target-warehouses', '/reverse/receipt/code-received-summary']) {
      const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(422)
      expect(res.body.code).toBe(ERROR_CODES.BUSINESS_RULE)
    }
  })

  it('业务规则中文错误带规则码：借出无对象 → 422 [WR-27]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const res = await request(app.getHttpServer())
      .post('/reverse/carrier/loan')
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: `${run}-no-party`, plantId: szPlantId, carrierCode: 'CARR-REV-01', eventKind: 'lend' })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(ERROR_CODES.BUSINESS_RULE)
    expect(res.body.message).toContain('[WR-27]')
    expect(/[\u4e00-\u9fff]/.test(res.body.message as string)).toBe(true) // 全中文错误
  })

  it('数量 number 拒（IT-07 十进制字符串）：调拨出库创建 plannedQty 为 number → 422', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const szRaw = (
      await pool.query<{ id: string }>(`SELECT id FROM warehouse WHERE plant_id = $1 AND code = '9211'`, [szPlantId])
    ).rows[0]!.id
    const szSecond = (
      await pool.query<{ id: string }>(`SELECT id FROM warehouse WHERE plant_id = $1 AND code = '9212'`, [szPlantId])
    ).rows[0]!.id
    const rawMaterial = (
      await pool.query<{ id: string }>(`SELECT id FROM material WHERE code = 'MAT-REV-RAW'`)
    ).rows[0]!.id
    const res = await request(app.getHttpServer())
      .post('/reverse/transfer-outbound')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `${run}-bad-dec`,
        plantId: szPlantId,
        transferKind: 'warehouse',
        fromWarehouseId: szRaw,
        toWarehouseId: szSecond,
        lines: [{ materialId: rawMaterial, plannedQty: 50 }],
      })
    expect(res.status).toBe(422)
  })

  it('详情不存在 → 404', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    for (const path of [`/reverse/move-records/${notFoundId}`, `/reverse/transfer-outbound/${notFoundId}`]) {
      const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(404)
      expect(res.body.code).toBe(ERROR_CODES.NOT_FOUND)
    }
  })

  it('命令幂等：carrier/loan 同 x-operation-id 重放原结果（借还台账恰一行）；回收后恢复可用', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const body = {
      plantId: szPlantId,
      carrierCode: 'CARR-REV-01',
      eventKind: 'lend' as const,
      counterparty: '客户甲',
      reason: 'API 幂等演示',
    }
    const opId = `${run}-idem`
    const first = await request(app.getHttpServer())
      .post('/reverse/carrier/loan')
      .set('Authorization', `Bearer ${token}`)
      .set('x-operation-id', opId)
      .send(body)
    expect(first.status).toBe(200)
    expect(first.body.data.availableForPlant).toBe(false)

    const replay = await request(app.getHttpServer())
      .post('/reverse/carrier/loan')
      .set('Authorization', `Bearer ${token}`)
      .set('x-operation-id', opId)
      .send(body)
    expect(replay.status).toBe(200)
    expect(replay.body.data).toEqual(first.body.data)

    const loans = await pool.query<{ event_kind: string }>(
      `SELECT event_kind FROM carrier_loan WHERE counterparty = '客户甲'`,
    )
    expect(loans.rows).toHaveLength(1) // 重放不重复记账
    expect(loans.rows[0]!.event_kind).toBe('lend')

    // 回收恢复可用，借还列表可见两条事件（中文标签口径）
    const back = await request(app.getHttpServer())
      .post('/reverse/carrier/loan')
      .set('Authorization', `Bearer ${token}`)
      .set('x-operation-id', `${run}-takeback`)
      .send({ plantId: szPlantId, carrierCode: 'CARR-REV-01', eventKind: 'take_back' })
    expect(back.status).toBe(200)
    expect(back.body.data.availableForPlant).toBe(true)

    const list = await request(app.getHttpServer())
      .get(`/reverse/carrier-loans?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.total).toBe(2)
    expect(list.body.items.every((l: { plantId: string }) => l.plantId === szPlantId)).toBe(true)
    const kinds = list.body.items.map((l: { eventKindLabel: string }) => l.eventKindLabel).sort()
    expect(kinds).toEqual(['借出', '回收'])
  })
})
