import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  PgCommandBus,
  PgAuditWriter,
  PgAuthSessionRepository,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
} from '@cadenza/persistence'
import {
  computeActorAuthorization,
  createScryptPasswordHasher,
  login as loginUseCase,
  type CommandContext,
  type CommandTools,
} from '@cadenza/application'
import type { MaterialDto } from '../../packages/contracts/src/masterdata'
import { createMasterDataCommandHandlers } from '../../packages/application/src/masterdata-handlers'
import { MasterDataQueryService } from '../../packages/application/src/masterdata-queries'
import type { MasterDataCommandTools } from '../../packages/application/src/masterdata-repositories'
import { createPgMasterDataRepositories } from '../../packages/persistence/src/masterdata-repositories'
import type { SqlClient } from '../../packages/persistence/src/sql-client'
import { DbModule } from '../../apps/api/src/db/db.module'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { MasterDataModule } from '../../apps/api/src/masterdata/masterdata.module'
import { validateEnv } from '../../apps/api/src/env'
import {
  MASTERDATA_TEST_DB_NAME,
  masterdataDatabaseUrl,
  prepareMasterdataTestDatabase,
  seedMasterdataFixtures,
  nodeId,
} from './masterdata-test-env'

/**
 * 工厂主数据 API 集成（真容器独立库 cadenza_md + supertest 挂载 MasterDataModule，无桩）。
 * 证据四类：跨厂 403 与列表过滤、引用保护拒绝（retire 被拒）、换算行引用后不可改、
 * 重复 operationId 幂等；另含 MD-09/10/13/14/17/18/23/24/25/26/28/30/31/33 端点级断言。
 * 前置：beforeAll 自行建库 + 迁移（0001/0002 注册表 + 0003 本块）+ 种子 + 主数据授权。
 * 守卫链：AuthModule 提供全局 AuthGuard + ScopeGuard（与生产 AppModule 同一注册方式）。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
let hfPlantId = ''
let materialId = ''

beforeAll(async () => {
  try {
    pool = await prepareMasterdataTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(
      `SKIP masterdata api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${MASTERDATA_TEST_DB_NAME}）。`,
    )
    return
  }
  const fixtures = await seedMasterdataFixtures(pool)
  materialId = fixtures.materialId
  szPlantId = await nodeId(pool, 'PLNT-SZ')
  hfPlantId = await nodeId(pool, 'PLNT-HF')

  // 组合根（生产由 L0 整合步落 masterdata.composition，此处同型装配）：
  // 命令总线 = masterdata 处理器 + 事务工具集（CommandTools 超集注入 masterdata 仓储束）
  const toolsFactory = (client: SqlClient, context: CommandContext, now: () => Date): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: MasterDataCommandTools = {
      org,
      users,
      roles: new PgRoleRepository(client),
      grants,
      sessions: new PgAuthSessionRepository(client),
      audit: new PgAuditWriter(client),
      now,
      actorPermissions: async () =>
        (await computeActorAuthorization({ users, grants, org }, context.actorUserId)).permissions,
      actorDataScope: async () =>
        (await computeActorAuthorization({ users, grants, org }, context.actorUserId)).dataScope,
      masterdata: createPgMasterDataRepositories(client),
    }
    return tools
  }
  const commandBus = new PgCommandBus(pool, createMasterDataCommandHandlers(), toolsFactory, () => new Date())
  const queries = new MasterDataQueryService({ masterdata: createPgMasterDataRepositories(pool) })

  // supertest 应用：DbModule（PG_POOL→独立库）+ AuthModule（全局守卫）+ MasterDataModule
  process.env['DATABASE_URL'] = masterdataDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      DbModule,
      AuthModule,
      MasterDataModule.register({ commandBus, queries }),
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

/** 直连登录用例签发令牌（会话与守卫校验共用同一独立库）。 */
async function login(loginName: string, password: string): Promise<string> {
  const result = await loginUseCase(
    {
      users: new PgUserAccountRepository(pool),
      org: new PgOrgNodeRepository(pool),
      sessions: new PgAuthSessionRepository(pool),
      audit: new PgAuditWriter(pool),
      hasher: createScryptPasswordHasher(),
      now: () => new Date(),
      sessionTtlMinutes: 720,
      maxLoginFailures: 5,
      lockMinutes: 15,
    },
    { loginName, password, platform: 'WEB' },
  )
  return result.token
}

let adminToken = ''

async function admin(): Promise<string> {
  if (adminToken === '') adminToken = await login('admin', 'CadAdmin001')
  return adminToken
}

describe('料品只读（MD-01/02/03）', () => {
  it('GET /masterdata/materials 返回同步料品且形状满足 MaterialDto 合同', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const res = await request(app.getHttpServer())
      .get('/masterdata/materials')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.total).toBeGreaterThanOrEqual(1)
    const item = res.body.items[0] as Record<string, unknown>
    // 运行时字段断言（MD-02 口径：主表字段随同步只读展示）
    expect(item['code']).toBe('MAT-TEST-CU')
    expect(item['baseUom']).toBe('KG')
    expect(item['qcFlag']).toBe(1)
    expect(item['sourceSystem']).toBe('U9')
    // 编译期合同冻结断言：响应项可赋给 contracts/masterdata.ts 的 MaterialDto
    const dto: MaterialDto = item as unknown as MaterialDto
    expect(dto.status).toBe('active')
  })

  it('POST /masterdata/materials 无新增入口（404，MD-01）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    await request(app.getHttpServer())
      .post('/masterdata/materials')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'X', name: 'X' })
      .expect(404)
  })
})

describe('换算行（MD-04/05/06）', () => {
  it('新增换算行校验 MD-04（负数/整数超 9 位/小数超 4 位均 422）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const base = { materialId, unitName: '卷' }
    for (const factor of ['-1', '1234567890', '1.12345', 'abc']) {
      const res = await request(app.getHttpServer())
        .post('/masterdata/conversions')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...base, factor, operationId: `md04-${factor}-${Date.now()}` })
        .expect(422)
      expect(res.body.message).toContain('MD-04')
    }
  })

  it('合法换算行创建（version=1）；被引用后不可改不可删（MD-05）；新版本可生成', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const created = await request(app.getHttpServer())
      .post('/masterdata/conversions')
      .set('Authorization', `Bearer ${token}`)
      .send({ materialId, unitName: '测试卷', factor: '25.5', operationId: `md05-create-${Date.now()}` })
      .expect(201)
    const conversionId = created.body.data.conversionId as string
    expect(created.body.data.version).toBe(1)

    // 模拟采购收货引用置位（MD-05 引用方协议：referenced=false→true 放行）
    await pool.query(`UPDATE conversion_revision SET referenced = true WHERE id = $1`, [conversionId])

    const patched = await request(app.getHttpServer())
      .patch(`/masterdata/conversions/${conversionId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ factor: '30' })
      .expect(422)
    expect(patched.body.message).toContain('MD-05')

    const deleted = await request(app.getHttpServer())
      .delete(`/masterdata/conversions/${conversionId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(422)
    expect(deleted.body.message).toContain('MD-05')

    // 换算变更生成新版本（MD-05 第二句）：新行 version=2，旧行原值保留
    const newVersion = await request(app.getHttpServer())
      .post(`/masterdata/conversions/${conversionId}/new-version`)
      .set('Authorization', `Bearer ${token}`)
      .send({ factor: '26' })
      .expect(201)
    expect(newVersion.body.data.version).toBe(2)

    const list = await request(app.getHttpServer())
      .get(`/masterdata/materials/${materialId}/conversions`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(list.body.items).toHaveLength(2)
    const oldLine = list.body.items.find((i: { version: number }) => i.version === 1)
    expect(oldLine.referenced).toBe(true)
    expect(oldLine.factor).toBe('25.5')
  })
})

describe('设备与工作中心（MD-09～18）', () => {
  let workCenterId = ''
  let workCenterCode = ''
  let equipmentId = ''

  it('MD-17：创建工作中心；重复编码 422', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const deptId = await nodeId(pool, 'DEPT-SZ-JZ')
    workCenterCode = `WC-MD-${Date.now() % 100000}`
    const created = await request(app.getHttpServer())
      .post('/masterdata/work-centers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md17-wc-${Date.now()}`,
        code: workCenterCode,
        name: `主数据测试工作中心-${Date.now() % 100000}`,
        deptId,
      })
      .expect(201)
    workCenterId = created.body.data.workCenterId as string

    const dupCode = await request(app.getHttpServer())
      .post('/masterdata/work-centers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md17-dup-${Date.now()}`,
        code: workCenterCode,
        name: '另一个名称',
        deptId,
      })
      .expect(422)
    expect(dupCode.body.message).toContain('MD-17')
  })

  it('MD-10：设备部门与工作中心部门不一致拒绝；一致创建成功且设备码为 EQU- 前缀（MD-15）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const jzDept = await nodeId(pool, 'DEPT-SZ-JZ')
    const qcDept = await nodeId(pool, 'DEPT-SZ-QC')
    const code = `MDQ${Date.now() % 100000}`
    const mismatch = await request(app.getHttpServer())
      .post('/masterdata/equipment')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md10-${Date.now()}`,
        code,
        name: `主数据设备-${code}`,
        deptId: qcDept,
        workCenterId,
        equipmentStatus: 1,
      })
      .expect(422)
    expect(mismatch.body.message).toContain('MD-10')

    const created = await request(app.getHttpServer())
      .post('/masterdata/equipment')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md15-${Date.now()}`,
        code,
        name: `主数据设备-${code}`,
        deptId: jzDept,
        workCenterId,
        equipmentStatus: 1,
        capacity: '1234567890.1234',
      })
      .expect(201)
    equipmentId = created.body.data.equipmentId as string
    expect(created.body.data.equipmentQrCode).toBe(`EQU-${code}`)
  })

  it('MD-09：设备名称重复拒绝；MD-13：状态字典外值拒绝', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const jzDept = await nodeId(pool, 'DEPT-SZ-JZ')
    const dupName = await request(app.getHttpServer())
      .post('/masterdata/equipment')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md09-${Date.now()}`,
        code: `MDN${Date.now() % 100000}`,
        name: await equipmentNameOf(pool, equipmentId),
        deptId: jzDept,
        workCenterId,
        equipmentStatus: 1,
      })
      .expect(422)
    expect(dupName.body.message).toContain('MD-09')

    const badStatus = await request(app.getHttpServer())
      .post(`/masterdata/equipment/${equipmentId}/change-status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ equipmentStatus: 3 })
      .expect(422)
    expect(badStatus.body.message).toContain('MD-13')
  })

  it('MD-14：同值切换不产生流水；变化切换记流水（前值/后值/来源/操作人）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const same = await request(app.getHttpServer())
      .post(`/masterdata/equipment/${equipmentId}/change-status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ equipmentStatus: 1, source: 'WEB' })
      .expect(200)
    expect(same.body.data.journaled).toBe(false)
    const none = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM equipment_status_log WHERE equipment_id = $1`,
      [equipmentId],
    )
    expect(none.rows[0]!.n).toBe(0)

    const changed = await request(app.getHttpServer())
      .post(`/masterdata/equipment/${equipmentId}/change-status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ equipmentStatus: 2, source: 'PDA' })
      .expect(200)
    expect(changed.body.data.journaled).toBe(true)
    const log = await pool.query<{ old_status: number; new_status: number; source: string; actor: string }>(
      `SELECT old_status, new_status, source, actor FROM equipment_status_log WHERE equipment_id = $1`,
      [equipmentId],
    )
    expect(log.rows[0]!.old_status).toBe(1)
    expect(log.rows[0]!.new_status).toBe(2)
    expect(log.rows[0]!.source).toBe('PDA')
    expect(log.rows[0]!.actor).toBe('admin')
  })

  it('MD-18：被设备引用的工作中心 retire 被拒；设备退役后可删（MD-11 无排产/报工引用）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const blocked = await request(app.getHttpServer())
      .delete(`/masterdata/work-centers/${workCenterId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(422)
    expect(blocked.body.message).toContain('MD-18')

    await request(app.getHttpServer())
      .delete(`/masterdata/equipment/${equipmentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200)
    await request(app.getHttpServer())
      .delete(`/masterdata/work-centers/${workCenterId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200)
  })
})

describe('仓库/库位/货架（MD-22～33）', () => {
  let warehouseId = ''
  const whCode = '0701'

  it('MD-23/24：物流部建仓库成功；物流部建线边仓/车间建仓库/类型外料品均拒绝', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const wlDept = await nodeId(pool, 'DEPT-SZ-WL')
    const jzDept = await nodeId(pool, 'DEPT-SZ-JZ')
    const created = await request(app.getHttpServer())
      .post('/masterdata/warehouses')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md22-${Date.now()}`,
        code: whCode,
        name: `主数据测试仓-${Date.now() % 100000}`,
        deptId: wlDept,
        warehouseType: 'WAREHOUSE',
        materialTypes: [1, 3],
      })
      .expect(201)
    warehouseId = created.body.data.warehouseId as string

    const wrongType = await request(app.getHttpServer())
      .post('/masterdata/warehouses')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md24a-${Date.now()}`,
        code: '0702',
        name: `物流线边仓拒绝-${Date.now() % 100000}`,
        deptId: wlDept,
        warehouseType: 'LINE_SIDE',
        materialTypes: [1],
      })
      .expect(422)
    expect(wrongType.body.message).toContain('MD-24')

    const workshopWarehouse = await request(app.getHttpServer())
      .post('/masterdata/warehouses')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md24b-${Date.now()}`,
        code: '0703',
        name: `车间仓库拒绝-${Date.now() % 100000}`,
        deptId: jzDept,
        warehouseType: 'WAREHOUSE',
        materialTypes: [1],
      })
      .expect(422)
    expect(workshopWarehouse.body.message).toContain('MD-24')

    const badMaterialType = await request(app.getHttpServer())
      .post('/masterdata/warehouses')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md23-${Date.now()}`,
        code: '0704',
        name: `类型外料品拒绝-${Date.now() % 100000}`,
        deptId: wlDept,
        warehouseType: 'WAREHOUSE',
        materialTypes: [2],
      })
      .expect(422)
    expect(badMaterialType.body.message).toContain('MD-23')
  })

  it('MD-28：普通库位 8 位且前缀匹配；重复拒绝；MD-25：有库位时仓库编码不可改', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    await request(app.getHttpServer())
      .post('/masterdata/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: `md28a-${Date.now()}`, warehouseId, code: `${whCode}0001` })
      .expect(201)
    await request(app.getHttpServer())
      .post('/masterdata/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: `md28b-${Date.now()}`, warehouseId, code: `${whCode}0002` })
      .expect(201)

    const badPrefix = await request(app.getHttpServer())
      .post('/masterdata/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: `md28c-${Date.now()}`, warehouseId, code: '02020001' })
      .expect(422)
    expect(badPrefix.body.message).toContain('MD-28')

    const dup = await request(app.getHttpServer())
      .post('/masterdata/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: `md28d-${Date.now()}`, warehouseId, code: `${whCode}0001` })
      .expect(422)
    expect(dup.body.message).toContain('MD-28')

    const codeChange = await request(app.getHttpServer())
      .patch(`/masterdata/warehouses/${warehouseId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '0808' })
      .expect(422)
    expect(codeChange.body.message).toContain('MD-25')
  })

  it('MD-26：被二维码占用的仓库不可改类型/料品类型、不可删', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const wlDept = await nodeId(pool, 'DEPT-SZ-WL')
    const created = await request(app.getHttpServer())
      .post('/masterdata/warehouses')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md26-${Date.now()}`,
        code: '0705',
        name: `二维码占用仓-${Date.now() % 100000}`,
        deptId: wlDept,
        warehouseType: 'WAREHOUSE',
        materialTypes: [1],
      })
      .expect(201)
    const qrWarehouseId = created.body.data.warehouseId as string
    await pool.query(`UPDATE warehouse SET qr_bound = true WHERE id = $1`, [qrWarehouseId])

    const typeChange = await request(app.getHttpServer())
      .patch(`/masterdata/warehouses/${qrWarehouseId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ warehouseType: 'LINE_SIDE' })
      .expect(422)
    expect(typeChange.body.message).toContain('MD-26')

    const mtChange = await request(app.getHttpServer())
      .patch(`/masterdata/warehouses/${qrWarehouseId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ materialTypes: [3] })
      .expect(422)
    expect(mtChange.body.message).toContain('MD-26')

    const retire = await request(app.getHttpServer())
      .delete(`/masterdata/warehouses/${qrWarehouseId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(422)
    expect(retire.body.message).toContain('MD-26')
  })

  it('MD-27：无引用仓库 retire 成功且普通库位级联失效（不物理删行，MD-36）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const res = await request(app.getHttpServer())
      .delete(`/masterdata/warehouses/${warehouseId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200)
    expect(res.body.data.affectedNormalLocations).toBe(2)
    const rows = await pool.query<{ status: string; deleted_at: string | null }>(
      `SELECT status, deleted_at FROM storage_location WHERE warehouse_id = $1`,
      [warehouseId],
    )
    expect(rows.rows.length).toBe(2) // 行仍在（MD-36 不物理删）
    for (const row of rows.rows) {
      expect(row.status).toBe('retired')
      expect(row.deleted_at).not.toBeNull()
    }
  })

  it('MD-30/31：货架创建自动生成区域与库位（区域数×层数）；层数不可改；重码拒绝；MD-33 占用拒删', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const wlDept = await nodeId(pool, 'DEPT-SZ-WL')
    const wh = await request(app.getHttpServer())
      .post('/masterdata/warehouses')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md31-wh-${Date.now()}`,
        code: '0706',
        name: `货架测试仓-${Date.now() % 100000}`,
        deptId: wlDept,
        warehouseType: 'WAREHOUSE',
        materialTypes: [1],
      })
      .expect(201)
    const rackWhId = wh.body.data.warehouseId as string

    const rack = await request(app.getHttpServer())
      .post('/masterdata/racks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md31-rack-${Date.now()}`,
        warehouseId: rackWhId,
        code: '07',
        zones: 2,
        layers: 3,
      })
      .expect(201)
    expect(rack.body.data.generatedLocations).toBe(6)
    const rackId = rack.body.data.rackId as string

    const locations = await request(app.getHttpServer())
      .get(`/masterdata/locations?warehouseId=${rackWhId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(locations.body.total).toBe(6)
    const codes: string[] = locations.body.items.map((i: { code: string }) => i.code)
    expect(codes).toContain('070101') // 货架07 区域01 层01（2+2+2 位，MD-31）
    expect(codes).toContain('070203')
    expect(locations.body.items[0].locationKind).toBe('RACK')
    expect(locations.body.items[0].zoneCode).toMatch(/^070[12]$/) // 区域码 = 货架号+区域号（MD-31）

    const layersChange = await request(app.getHttpServer())
      .patch(`/masterdata/racks/${rackId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ layers: 5 })
      .expect(422)
    expect(layersChange.body.message).toContain('MD-31')

    const dupRack = await request(app.getHttpServer())
      .post('/masterdata/racks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `md30-dup-${Date.now()}`,
        warehouseId: rackWhId,
        code: '07',
        zones: 1,
        layers: 1,
      })
      .expect(422)
    expect(dupRack.body.message).toContain('MD-30')

    // MD-33：货架下库位被二维码占用 → 货架 retire 被拒
    await pool.query(
      `UPDATE storage_location SET qr_bound = true WHERE rack_id = $1 AND code = '070101'`,
      [rackId],
    )
    const rackRetire = await request(app.getHttpServer())
      .delete(`/masterdata/racks/${rackId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(422)
    expect(rackRetire.body.message).toContain('MD-33')
  })
})

describe('数据范围与幂等（OA-24/25 + 命令总线）', () => {
  it('合肥厂管理员显式查苏州厂 → 403 ERR_FORBIDDEN_SCOPE；不带参数列表收敛本厂（过滤证据）', async () => {
    if (skipIfNoDb()) return
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    const forbidden = await request(app.getHttpServer())
      .get(`/masterdata/warehouses?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${hfToken}`)
      .expect(403)
    expect(forbidden.body.code).toBe('ERR_FORBIDDEN_SCOPE')

    const equipmentForbidden = await request(app.getHttpServer())
      .get(`/masterdata/equipment?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${hfToken}`)
      .expect(403)
    expect(equipmentForbidden.body.code).toBe('ERR_FORBIDDEN_SCOPE')

    // 列表过滤证据：HF 厂管理员可见的仓库/设备全部落合肥厂（苏州行不可见）
    const warehouses = await request(app.getHttpServer())
      .get('/masterdata/warehouses')
      .set('Authorization', `Bearer ${hfToken}`)
      .expect(200)
    for (const item of warehouses.body.items) {
      expect(item.plantId).toBe(hfPlantId)
    }
    const equipment = await request(app.getHttpServer())
      .get('/masterdata/equipment')
      .set('Authorization', `Bearer ${hfToken}`)
      .expect(200)
    for (const item of equipment.body.items) {
      expect(item.plantId).toBe(hfPlantId)
    }
  })

  it('写命令跨厂范围二道防线：HF 管理员在苏州厂部门下建仓 → 403（OA-24）', async () => {
    if (skipIfNoDb()) return
    const hfToken = await login('hfadmin01', 'HfPlant0001')
    const szWlDept = await nodeId(pool, 'DEPT-SZ-WL')
    const res = await request(app.getHttpServer())
      .post('/masterdata/warehouses')
      .set('Authorization', `Bearer ${hfToken}`)
      .send({
        operationId: `scope-write-${Date.now()}`,
        code: '0710',
        name: `越界建仓-${Date.now() % 100000}`,
        deptId: szWlDept,
        warehouseType: 'WAREHOUSE',
        materialTypes: [1],
      })
      .expect(403)
    expect(res.body.code).toBe('ERR_FORBIDDEN_SCOPE')
  })

  it('无主数据许可账号被拒（403）；未认证被拒（401）', async () => {
    if (skipIfNoDb()) return
    const qcToken = await login('szqc01', 'SzQuality01')
    const res = await request(app.getHttpServer())
      .get('/masterdata/materials')
      .set('Authorization', `Bearer ${qcToken}`)
      .expect(403)
    expect(res.body.code).toBe('ERR_FORBIDDEN_SCOPE')

    const anon = await request(app.getHttpServer()).get('/masterdata/materials').expect(401)
    expect(anon.body.code).toBe('ERR_AUTH_REQUIRED')
  })

  it('重复 operationId 幂等：同载荷回放同结果；异载荷 ERR_IDEMPOTENT_PAYLOAD_MISMATCH', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const jzDept = await nodeId(pool, 'DEPT-SZ-JZ')
    const operationId = `md-idem-${Date.now()}`
    const payload = {
      operationId,
      code: `WC-IDEM-${Date.now() % 100000}`,
      name: `幂等工作中心-${Date.now() % 100000}`,
      deptId: jzDept,
    }
    const first = await request(app.getHttpServer())
      .post('/masterdata/work-centers')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(201)
    const replay = await request(app.getHttpServer())
      .post('/masterdata/work-centers')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(201)
    expect(replay.body.data.workCenterId).toBe(first.body.data.workCenterId)

    const mismatch = await request(app.getHttpServer())
      .post('/masterdata/work-centers')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...payload, name: '不同载荷' })
      .expect(422)
    expect(mismatch.body.code).toBe('ERR_IDEMPOTENT_PAYLOAD_MISMATCH')

    // 不重复入账：同名工作中心仅一行
    const rows = await pool.query(`SELECT count(*)::int AS n FROM work_center WHERE name = $1`, [
      payload.name,
    ])
    expect(rows.rows[0]!.n).toBe(1)
  })
})

async function equipmentNameOf(pool: pg.Pool, id: string): Promise<string> {
  const r = await pool.query<{ name: string }>(`SELECT name FROM equipment WHERE id = $1`, [id])
  return r.rows[0]!.name
}
