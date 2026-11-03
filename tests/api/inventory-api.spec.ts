import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  CommandResultStatus,
  ERROR_CODES,
} from '@cadenza/contracts'
import { createScryptPasswordHasher } from '@cadenza/application'
import {
  createPool,
  migrateUp,
  migrations,
  seedOrgAuth,
  PgScopeGrantRepository,
} from '@cadenza/persistence'
import { migration0004 } from '../../packages/persistence/src/migrations/0004-inventory-trace'
import { validateEnv } from '../../apps/api/src/env'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { DbModule } from '../../apps/api/src/db/db.module'
import { InventoryModule } from '../../apps/api/src/inventory/inventory.module'

/**
 * inventory API 集成（真容器 + 真实模块组合：ConfigModule/DbModule/AuthModule（全局守卫）/
 * InventoryModule——不改共享 app.module.ts，由本测试组装，L0 整合步统一注册）。
 * 证据⑥：跨厂 403 与列表服务端过滤；端点级幂等/余量拒绝/条码解析/单元详情。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
let hfPlantId = ''
let enterpriseId = ''
const run = `apinv${Date.now().toString(36)}`

const LOC_SZ = '11111111-1111-4111-8111-1111111111a1'
const LOC_SZ_CODE = 'SZ01-01-01'
const LOC_HF = '11111111-1111-4111-8111-1111111111b2'
const LOC_HF_CODE = 'HF01-01-01'
const OWNER = '22222222-2222-4222-8222-222222222201'
const UOM_M = '33333333-3333-4333-8333-3333333333c1'
const MATERIAL = '44444444-4444-4444-8444-4444444444d1'

beforeAll(async () => {
  pool = createPool(undefined, { max: 4 })
  try {
    await pool.query('SELECT 1')
  } catch {
    dbAvailable = false
    console.warn('SKIP inventory api: 数据库不可达。请先 docker compose up -d 再重跑。')
    return
  }
  await migrateUp(pool, migrations)
  await migrateUp(pool, [migration0004])
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })

  // 授权：sysadmin 并入 inventory.*；plantadmin（合肥厂）并入 inventory.read（OA-22 合并语义）
  const ent = await pool.query<{ enterprise_id: string; id: string }>(
    `SELECT enterprise_id, id FROM org_node WHERE code = 'ENT-HD'`,
  )
  enterpriseId = ent.rows[0]!.enterprise_id ?? ent.rows[0]!.id
  const roles = await pool.query<{ alias: string; id: string }>(
    `SELECT alias, id FROM role WHERE enterprise_id = $1 AND alias IN ('sysadmin','plantadmin','foreman')`,
    [enterpriseId],
  )
  const plants = await pool.query<{ code: string; id: string }>(
    `SELECT code, id FROM org_node WHERE code IN ('PLNT-SZ','PLNT-HF')`,
  )
  szPlantId = plants.rows.find((r) => r.code === 'PLNT-SZ')!.id
  hfPlantId = plants.rows.find((r) => r.code === 'PLNT-HF')!.id
  const grants = new PgScopeGrantRepository(pool)
  const sysadmin = roles.rows.find((r) => r.alias === 'sysadmin')!
  const plantadmin = roles.rows.find((r) => r.alias === 'plantadmin')!
  await grants.upsertMerge({
    enterpriseId,
    principalType: 'role',
    principalId: sysadmin.id,
    scopeType: 'enterprise',
    scopeObjectId: ent.rows[0]!.id,
    permissions: ['inventory.read', 'inventory.post', 'inventory.reserve'],
  })
  await grants.upsertMerge({
    enterpriseId,
    principalType: 'role',
    principalId: plantadmin.id,
    scopeType: 'plant',
    scopeObjectId: hfPlantId,
    permissions: ['inventory.read'],
  })

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      DbModule,
      AuthModule,
      InventoryModule,
    ],
  }).compile()
  app = moduleRef.createNestApplication()
  await app.init()
})

afterAll(async () => {
  if (app) await app.close()
  if (pool) {
    await pool
      .query(
        `TRUNCATE stock_entry, stock_transaction, stock_balance, reservation, genealogy_edge,
           customer_segment, carrier_binding, carrier, barcode_binding, barcode_label, barcode_format,
           material_segment, inventory_unit, material_lot CASCADE`,
      )
      .catch(() => undefined)
    await pool.query(`DELETE FROM outbox WHERE aggregate_type IN ('inventory_unit','reservation')`).catch(() => undefined)
    await pool.query(`DELETE FROM audit_entry WHERE action LIKE 'inventory.%'`).catch(() => undefined)
    await pool.query(`DELETE FROM command_receipt WHERE operation_id LIKE $1`, [`${run}%`]).catch(() => undefined)
    // 0004 已由 Wave3 注册进 registry：不再「卸下 0004」——DROP 0004 表 CASCADE 会连带
    // DROP 0008/0009 的 FK 依赖表（report_output 等）而 schema_migrations 行仍在，
    // migrateUp 无法恢复（Wave5 注册 0007–0009 后该清理口径已不可用）。
    await pool.end()
  }
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

async function receiveViaApi(
  token: string,
  unitNo: string,
  quantity: string,
  plantId: string,
  locationId: string,
  locationCode: string,
  operationId: string,
  barcodeValue?: string,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .post('/inventory/receive')
    .set('Authorization', `Bearer ${token}`)
    .send({
      operationId,
      plantId,
      lotNo: `LOT-${run}`,
      unitNo,
      materialId: MATERIAL,
      materialCode: 'MAT-API-01',
      uomId: UOM_M,
      uomCode: 'm',
      quantity,
      measurementBasis: 'nominal',
      locationId,
      locationCode,
      ownerId: OWNER,
      ownerName: '华东电缆集团（自有）',
      qualityStatus: 'qualified',
      barcodeValue,
    })
}

describe('⑥ 跨厂 403 与列表服务端过滤（OA-24/25 + IT-S1）', () => {
  it('合肥厂管理员显式查苏州厂 → 403 ERR_FORBIDDEN_SCOPE；不带参数 → 仅见本厂余额', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const admin = await login('admin', 'CadAdmin001')
    const hf = await login('hfadmin01', 'HfPlant0001')
    // 两厂各收货一单元
    const szUnit = `HT-${run}-SZ`
    const hfUnit = `HT-${run}-HF`
    const r1 = await receiveViaApi(admin, szUnit, '50.0000', szPlantId, LOC_SZ, LOC_SZ_CODE, `${run}-a1`)
    expect(r1.status).toBe(201)
    const r2 = await receiveViaApi(admin, hfUnit, '20.0000', hfPlantId, LOC_HF, LOC_HF_CODE, `${run}-a2`)
    expect(r2.status).toBe(201)

    // 显式越范围参数 → 403
    const forbidden = await request(app.getHttpServer())
      .get('/inventory/balances')
      .query({ plantId: szPlantId })
      .set('Authorization', `Bearer ${hf}`)
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)

    // 隐式列表 → 服务端过滤只剩合肥厂余额
    const own = await request(app.getHttpServer())
      .get('/inventory/balances')
      .set('Authorization', `Bearer ${hf}`)
    expect(own.status).toBe(200)
    expect(own.body.total).toBe(1)
    expect(own.body.items[0].unitNo).toBe(hfUnit)

    // 企业范围 admin → 两厂均可见
    const all = await request(app.getHttpServer())
      .get('/inventory/balances')
      .set('Authorization', `Bearer ${admin}`)
    expect(all.status).toBe(200)
    expect(all.body.total).toBe(2)
  })

  it('无 inventory.read 许可的账号 → 403 缺少操作许可（foreman）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('szws01', 'SzWorkshop01') // foreman：仅 org.read + 车间范围
    const res = await request(app.getHttpServer())
      .get('/inventory/balances')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    expect(res.body.message).toContain('inventory.read')
  })
})

describe('端点行为（命令幂等/余量拒绝/条码解析/单元详情/单元详情范围不可见）', () => {
  it('POST /inventory/receive：同 operationId 重放返回同一 unitNo；数量为 number → 422', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const operationId = `${run}-idem`
    const first = await receiveViaApi(token, `HT-${run}-EP`, '30.0000', szPlantId, LOC_SZ, LOC_SZ_CODE, operationId)
    expect(first.status).toBe(201)
    expect(first.body.status).toBe(CommandResultStatus.COMMITTED)
    const replay = await receiveViaApi(token, `HT-${run}-EP`, '30.0000', szPlantId, LOC_SZ, LOC_SZ_CODE, operationId)
    expect(replay.status).toBe(201)
    expect(replay.body.data.unitNo).toBe(first.body.data.unitNo)

    const badQty = await request(app.getHttpServer())
      .post('/inventory/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `${run}-badqty`,
        plantId: szPlantId,
        lotNo: `LOT-${run}`,
        unitNo: `HT-${run}-BAD`,
        materialId: MATERIAL,
        materialCode: 'MAT-API-01',
        uomId: UOM_M,
        uomCode: 'm',
        quantity: 30, // number → IT-07 拒绝（禁 IEEE-754）
        locationId: LOC_SZ,
        locationCode: LOC_SZ_CODE,
        ownerId: OWNER,
        ownerName: 'x',
      })
    expect(badQty.status).toBe(422)
    expect(badQty.body.message).toContain('IT-07')
  })

  it('POST /inventory/issue：余量不足 → 409 ERR_INSUFFICIENT_STOCK（可解释拒绝）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const received = await receiveViaApi(token, `HT-${run}-ISS`, '25.0000', szPlantId, LOC_SZ, LOC_SZ_CODE, `${run}-iss-r`)
    const unitId = received.body.data.unitId
    const res = await request(app.getHttpServer())
      .post('/inventory/issue')
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: `${run}-iss-x`, unitId, quantity: '40.0000' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(ERROR_CODES.INSUFFICIENT_STOCK)
    expect(res.body.message).toContain('IT-14')
  })

  it('GET /inventory/barcode/:value/resolve：解析返回候选（IT-04/05）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const token = await login('admin', 'CadAdmin001')
    const barcode = `R${run.replace(/[^0-9A-Za-z]/g, '').slice(0, 9).padEnd(9, '7')}`.slice(0, 10)
    await receiveViaApi(token, `HT-${run}-BC`, '15.0000', szPlantId, LOC_SZ, LOC_SZ_CODE, `${run}-bc`, barcode)
    const res = await request(app.getHttpServer())
      .get(`/inventory/barcode/${barcode}/resolve`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.kind.kind).toBe('raw_material')
    expect(res.body.hasActiveBinding).toBe(true)
    expect(res.body.candidates).toHaveLength(1)
    expect(res.body.candidates[0].objectType).toBe('inventory_unit')
    expect(res.body.candidates[0].label).toBe(`HT-${run}-BC`)
  })

  it('GET /inventory/units：单元详情（余额/流水/谱系）；范围外单元不可见', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const admin = await login('admin', 'CadAdmin001')
    const unitNo = `HT-${run}-DT`
    await receiveViaApi(admin, unitNo, '12.0000', szPlantId, LOC_SZ, LOC_SZ_CODE, `${run}-dt`)
    const res = await request(app.getHttpServer())
      .get('/inventory/units')
      .query({ unitNo })
      .set('Authorization', `Bearer ${admin}`)
    expect(res.status).toBe(200)
    expect(res.body.unitNo).toBe(unitNo)
    expect(res.body.balances).toHaveLength(1)
    expect(res.body.balances[0].quantity).toBe('12.0000')
    expect(res.body.genealogy).toHaveLength(1) // receipt_origin 起点（IT-34）
    expect(res.body.recentTransactions[0].movementKind).toBe('receive')
    expect(res.body.recentTransactions[0].beforeQty).toBe('0.0000')
    expect(res.body.recentTransactions[0].afterQty).toBe('12.0000')

    // 合肥厂管理员查苏州厂单元 → 数据范围外不可见（服务端过滤，404 语义）
    const hf = await login('hfadmin01', 'HfPlant0001')
    const invisible = await request(app.getHttpServer())
      .get('/inventory/units')
      .query({ unitNo })
      .set('Authorization', `Bearer ${hf}`)
    expect(invisible.status).toBe(404)
  })
})
