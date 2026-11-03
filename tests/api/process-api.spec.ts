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
import type { ProductionOrderDto, OrderOperationDto, RouteRevisionDto, OperationDefinitionDto } from '../../packages/contracts/src/process'
import { createProcessCommandHandlers } from '../../packages/application/src/process-handlers'
import { ProcessQueryService } from '../../packages/application/src/process-queries'
import type { ProcessCommandTools } from '../../packages/application/src/process-repositories'
import { createPgProcessRepositories } from '../../packages/persistence/src/process-repositories'
import type { SqlClient } from '../../packages/persistence/src/sql-client'
import { DbModule } from '../../apps/api/src/db/db.module'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { ProcessModule } from '../../apps/api/src/process/process.module'
import { validateEnv } from '../../apps/api/src/env'
import {
  PROCESS_TEST_DB_NAME,
  processDatabaseUrl,
  prepareProcessTestDatabase,
  seedProcessFixtures,
  nodeId,
  type ProcessFixtureIds,
} from './process-test-env'

/**
 * 工艺/生产订单 API 集成（真容器独立库 cadenza_proc + supertest 挂载 ProcessModule，无桩）。
 * 六类证据：①工序需求推导样例复算；②发布版本冻结；③订单快照冻结；④开工前置拒绝；
 * ⑤幂等重放；⑥跨厂 403 与列表过滤。另含 A1-3 引用保护、作废/挂起流、守卫链与 DTO 冻结断言。
 * 前置：beforeAll 自行建库 + 迁移（0001–0004 注册表 + 0005 本块程序式应用）+ 种子 + process 授权。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
let hfPlantId = ''
let fx: ProcessFixtureIds

beforeAll(async () => {
  try {
    pool = await prepareProcessTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(
      `SKIP process api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${PROCESS_TEST_DB_NAME}）。`,
    )
    return
  }
  fx = await seedProcessFixtures(pool)
  szPlantId = await nodeId(pool, 'PLNT-SZ')
  hfPlantId = await nodeId(pool, 'PLNT-HF')

  // 组合根（生产由 L0 整合步落 process.composition，此处同型装配）：
  // 命令总线 = process 处理器 + 事务工具集（CommandTools 超集注入 process 仓储束）
  const toolsFactory = (client: SqlClient, context: CommandContext, now: () => Date): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: ProcessCommandTools = {
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
      process: createPgProcessRepositories(client),
    }
    return tools
  }
  const commandBus = new PgCommandBus(pool, createProcessCommandHandlers(), toolsFactory, () => new Date())
  const queries = new ProcessQueryService({ process: createPgProcessRepositories(pool) })

  // supertest 应用：DbModule（PG_POOL→独立库）+ AuthModule（全局守卫）+ ProcessModule
  process.env['DATABASE_URL'] = processDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      DbModule,
      AuthModule,
      ProcessModule.register({ commandBus, queries }),
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

async function hfAdmin(): Promise<string> {
  return login('hfadmin01', 'HfPlant0001')
}

// 测试间共享状态（顺序执行）
let familyId = ''
let operationId = ''
let routeV1Id = ''
let routeV2Id = ''
let order3060Id = ''
let uncfgOrderId = ''
let uncfmOrderId = ''
let apprOrderId = ''
let suspOrderId = ''

describe('工艺主数据准备（产品族/工序/路线/发布）', () => {
  it('创建产品族、工序主数据与路线 v1 并发布（A1-3 唯一性 + A2-2 发布）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const family = await request(app.getHttpServer())
      .post('/process/families')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: szPlantId, code: 'FAM-YJV-001', name: 'YJV 电缆工艺族', operationId: 'fx-family-1' })
      .expect(201)
    familyId = family.body.data.familyId as string
    expect(familyId).toBeTruthy()

    const op = await request(app.getHttpServer())
      .post('/process/operations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        deptId: fx.szDeptId,
        workCenterId: fx.szWorkCenterId,
        companyOrgCode: 'ORG-SZ-JZ',
        code: 'OP-JX-01',
        name: '绞线',
        operationId: 'fx-op-1',
      })
      .expect(201)
    operationId = op.body.data.operationId as string
    expect(operationId).toBeTruthy()

    const route = await request(app.getHttpServer())
      .post('/process/routes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        productFamilyId: familyId,
        steps: [
          {
            seq: 1,
            operationDefinitionId: operationId,
            workCenterId: fx.szWorkCenterId,
            coreMultiple: 3,
            strandFactor: '1.02',
          },
        ],
        operationId: 'fx-route-1',
      })
      .expect(201)
    routeV1Id = route.body.data.revisionId as string
    expect(route.body.data.version).toBe(1)

    // 编译期合同冻结断言：路线 DTO
    const routeDto: RouteRevisionDto = (await request(app.getHttpServer())
      .get(`/process/routes?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)).body.items[0] as unknown as RouteRevisionDto
    expect(routeDto.status).toBe('draft')

    await request(app.getHttpServer())
      .post(`/process/routes/${routeV1Id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'fx-route-pub-1' })
      .expect(200)
  })

  it('A1-3：工序唯一性拒绝（部门内名称重复 / 组织编码内编码重复 → 422）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const dupName = await request(app.getHttpServer())
      .post('/process/operations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        deptId: fx.szDeptId,
        workCenterId: fx.szWorkCenterId,
        companyOrgCode: 'ORG-SZ-JZ',
        code: 'OP-OTHER',
        name: '绞线',
        operationId: 'fx-op-dup-name',
      })
      .expect(422)
    expect(dupName.body.message).toContain('A1-3')
    expect(dupName.body.message).toContain('工序名称')

    const dupCode = await request(app.getHttpServer())
      .post('/process/operations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        deptId: fx.szDeptId,
        workCenterId: fx.szWorkCenterId,
        companyOrgCode: 'ORG-SZ-JZ',
        code: 'OP-JX-01',
        name: '其它工序',
        operationId: 'fx-op-dup-code',
      })
      .expect(422)
    expect(dupCode.body.message).toContain('A1-3')
    expect(dupCode.body.message).toContain('工序编码')
  })

  it('A1-3：部门与工作中心一致性校验（同厂异部门 → 422）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const res = await request(app.getHttpServer())
      .post('/process/operations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        deptId: fx.szQcDeptId, // 苏州质检部门 + 苏州绞制部门的工作中心（同厂异部门）
        workCenterId: fx.szWorkCenterId,
        companyOrgCode: 'ORG-SZ-JZ',
        code: 'OP-X',
        name: '跨部门工序',
        operationId: 'fx-op-x',
      })
      .expect(422)
    expect(res.body.message).toContain('A1-3')
    expect(res.body.message).toContain('一致')
  })
})

describe('① 工序需求推导样例复算（1000m × 3 × 1.02 = 3060m）', () => {
  it('订单接收按已发布路线展开，末道下线数量可复算为 3060', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const received = await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({
        orderNo: 'MO-PROC-3060',
        materialId: fx.materialId,
        productionDeptId: fx.szDeptId,
        productionQty: '1000',
        uom: 'M',
        productFamilyId: familyId,
        initialStatus: 'released',
        processConfirmed: true,
        operationId: 'ord-3060-receive',
      })
      .expect(201)
    order3060Id = received.body.data.orderId as string
    expect(received.body.data.processConfigStatus).toBe('configured')
    expect(received.body.data.operationCount).toBe(1)
    expect(received.body.data.routeRevisionId).toBe(routeV1Id)

    const detail = await request(app.getHttpServer())
      .get(`/process/orders/${order3060Id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(detail.body.order.orderNo).toBe('MO-PROC-3060')
    expect(detail.body.order.productionQty).toBe('1000')
    expect(detail.body.order.routeRevisionId).toBe(routeV1Id)

    expect(detail.body.operations).toHaveLength(1)
    const op = detail.body.operations[0] as Record<string, unknown>
    // [底稿 A2-1] 样例复算：末道下线数量 = 1000 × 3 × 1.02 = 3060
    expect(op['offlineQty']).toBe('3060')
    expect(op['coreMultiple']).toBe(3)
    expect(op['strandFactor']).toBe('1.02')
    expect(op['workCenterId']).toBe(fx.szWorkCenterId)
    expect(op['uom']).toBe('M')
    // 编译期合同冻结断言：订单工序 DTO
    const dto: OrderOperationDto = op as unknown as OrderOperationDto
    expect(dto.settingsVersion).toBe(1)
    expect(dto.executionStatus).toBe('pending') // S04 预留：报工域未建
    const orderDto: ProductionOrderDto = detail.body.order as unknown as ProductionOrderDto
    expect(orderDto.orderStatus).toBe('released')
    expect(orderDto.suspended).toBe(false)
  })

  it('多工序链复算（显式入站工序）：末道 1000×2×1.5=3000，前道 3000×3×1=9000', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const received = await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({
        orderNo: 'MO-PROC-CHAIN',
        materialId: fx.materialId,
        productionDeptId: fx.szDeptId,
        productionQty: '1000',
        uom: 'M',
        initialStatus: 'approved',
        operations: [
          { seq: 1, operationDefinitionId: operationId, coreMultiple: 3, strandFactor: '1' },
          { seq: 2, operationDefinitionId: operationId, coreMultiple: 2, strandFactor: '1.5' },
        ],
        operationId: 'ord-chain-receive',
      })
      .expect(201)
    const orderId = received.body.data.orderId as string
    const detail = await request(app.getHttpServer())
      .get(`/process/orders/${orderId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    const ops = detail.body.operations as Array<Record<string, unknown>>
    expect(ops).toHaveLength(2)
    // 自末道向上递推：seq2（末道）=1000×2×1.5=3000；seq1=3000×3×1=9000
    expect(ops.find((o) => o['seq'] === 2)?.['offlineQty']).toBe('3000')
    expect(ops.find((o) => o['seq'] === 1)?.['offlineQty']).toBe('9000')
    // 显式工序无路线版本引用 → routeRevisionId 为空（可空路径证据）
    expect(ops[0]?.['routeRevisionId']).toBeNull()
  })
})

describe('② 发布版本冻结（published 后 PATCH 拒绝）', () => {
  it('PATCH 已发布路线（内容列或备注）→ 422 [A2-2]；重复发布 → 422 [A2-2]', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const patch = await request(app.getHttpServer())
      .patch(`/process/routes/${routeV1Id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        steps: [
          { seq: 1, operationDefinitionId: operationId, workCenterId: fx.szWorkCenterId, coreMultiple: 9 },
        ],
        operationId: 'fx-route-patch-published',
      })
      .expect(422)
    expect(patch.body.message).toContain('A2-2')
    expect(patch.body.message).toContain('不可修改')

    const patchRemarkOnly = await request(app.getHttpServer())
      .patch(`/process/routes/${routeV1Id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ remark: '改备注也不行', operationId: 'fx-route-patch-remark' })
      .expect(422)
    expect(patchRemarkOnly.body.message).toContain('A2-2')

    const republish = await request(app.getHttpServer())
      .post(`/process/routes/${routeV1Id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'fx-route-republish' })
      .expect(422)
    expect(republish.body.message).toContain('A2-2')
  })

  it('同对象第二条版本发布前须先失效旧版本（A2-2 至多一条 published）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const v2 = await request(app.getHttpServer())
      .post('/process/routes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        productFamilyId: familyId,
        steps: [
          { seq: 1, operationDefinitionId: operationId, workCenterId: fx.szWorkCenterId, coreMultiple: 5, strandFactor: '1.5' },
        ],
        operationId: 'fx-route-2',
      })
      .expect(201)
    const v2Id = v2.body.data.revisionId as string
    expect(v2.body.data.version).toBe(2)
    // 旧版本仍 published → 发布 v2 被拒
    const blocked = await request(app.getHttpServer())
      .post(`/process/routes/${v2Id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'fx-route-2-pub-blocked' })
      .expect(422)
    expect(blocked.body.message).toContain('A2-2')
    expect(blocked.body.message).toContain('先失效')
  })
})

describe('③ 订单快照冻结（模板后改不影响已接订单）', () => {
  it('改工序名称 + 路线升版发布后，已接订单工序行保持接收时快照', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    // 模板侧变更一：工序改名（A1-3 编辑锁不覆盖名称）
    await request(app.getHttpServer())
      .patch(`/process/operations/${operationId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '绞线-改', operationId: 'fx-op-rename' })
      .expect(200)
    // 模板侧变更二：路线 v1 失效 → v2（芯 5/绞 1.5）发布
    await request(app.getHttpServer())
      .delete(`/process/routes/${routeV1Id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'fx-route-1-retire' })
      .expect(200)
    const v2 = await request(app.getHttpServer())
      .post('/process/routes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        productFamilyId: familyId,
        steps: [
          { seq: 1, operationDefinitionId: operationId, workCenterId: fx.szWorkCenterId, coreMultiple: 5, strandFactor: '1.5' },
        ],
        operationId: 'fx-route-2b',
      })
      .expect(201)
    routeV2Id = v2.body.data.revisionId as string
    await request(app.getHttpServer())
      .post(`/process/routes/${routeV2Id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'fx-route-2b-pub' })
      .expect(200)

    // 已接订单 MO-PROC-3060 的工序行不受影响（[底稿 A2-3] 快照冻结）
    const detail = await request(app.getHttpServer())
      .get(`/process/orders/${order3060Id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    const op = detail.body.operations[0] as Record<string, unknown>
    expect(op['operationName']).toBe('绞线') // 改名不影响快照
    expect(op['coreMultiple']).toBe(3)
    expect(op['strandFactor']).toBe('1.02')
    expect(op['offlineQty']).toBe('3060')
    expect(op['routeRevisionId']).toBe(routeV1Id) // 版本引用冻结（v1 已 retired 仍可解析）
    expect(detail.body.order.routeRevisionId).toBe(routeV1Id)
  })
})

describe('④ 开工前置拒绝（无工艺/未确认/未放行/挂起）与成功开工', () => {
  it('工序未配置 → 422 [A1-1]', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const received = await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({
        orderNo: 'MO-PROC-UNCFG',
        materialId: fx.materialId,
        productionDeptId: fx.szDeptId,
        productionQty: '500',
        uom: 'M',
        initialStatus: 'released',
        processConfirmed: true,
        operationId: 'ord-uncfg-receive',
      })
      .expect(201)
    uncfgOrderId = received.body.data.orderId as string
    expect(received.body.data.processConfigStatus).toBe('unconfigured')
    const start = await request(app.getHttpServer())
      .post(`/process/orders/${uncfgOrderId}/start`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'ord-uncfg-start' })
      .expect(422)
    expect(start.body.message).toContain('A1-1')
    expect(start.body.message).toContain('工序未配置')
  })

  it('工艺路线未确认 → 422 [A1-1]', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const received = await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({
        orderNo: 'MO-PROC-UNCFM',
        materialId: fx.materialId,
        productionDeptId: fx.szDeptId,
        productionQty: '500',
        uom: 'M',
        productFamilyId: familyId,
        initialStatus: 'released',
        processConfirmed: false,
        operationId: 'ord-uncfm-receive',
      })
      .expect(201)
    uncfmOrderId = received.body.data.orderId as string
    const start = await request(app.getHttpServer())
      .post(`/process/orders/${uncfmOrderId}/start`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'ord-uncfm-start' })
      .expect(422)
    expect(start.body.message).toContain('A1-1')
    expect(start.body.message).toContain('工艺路线未确认')
  })

  it('状态非允许开工（已核准未放行）→ 422 [A1-1]；放行后前置补齐', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const received = await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({
        orderNo: 'MO-PROC-APPR',
        materialId: fx.materialId,
        productionDeptId: fx.szDeptId,
        productionQty: '500',
        uom: 'M',
        productFamilyId: familyId,
        initialStatus: 'approved',
        processConfirmed: true,
        operationId: 'ord-appr-receive',
      })
      .expect(201)
    apprOrderId = received.body.data.orderId as string
    const start = await request(app.getHttpServer())
      .post(`/process/orders/${apprOrderId}/start`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'ord-appr-start' })
      .expect(422)
    expect(start.body.message).toContain('A1-1')
    expect(start.body.message).toContain('允许开工')
    // 放行（模拟上游放行）后可开工
    await request(app.getHttpServer())
      .post(`/process/orders/${apprOrderId}/release`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'ord-appr-release' })
      .expect(200)
    await request(app.getHttpServer())
      .post(`/process/orders/${apprOrderId}/start`)
      .set('Authorization', `Bearer ${token}`)
      .send({ actualStartAt: '2026-10-27T08:30:00Z', operationId: 'ord-appr-start-2' })
      .expect(200)
  })

  it('挂起态开工 → 422 [A1-1]；解除挂起后开工成功（记实际开工时间，变进行中）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const received = await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({
        orderNo: 'MO-PROC-SUSP',
        materialId: fx.materialId,
        productionDeptId: fx.szDeptId,
        productionQty: '500',
        uom: 'M',
        productFamilyId: familyId,
        initialStatus: 'released',
        processConfirmed: true,
        operationId: 'ord-susp-receive',
      })
      .expect(201)
    suspOrderId = received.body.data.orderId as string
    // 挂起（独立开关）
    await request(app.getHttpServer())
      .post(`/process/orders/${suspOrderId}/suspend`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: '等待物料', operationId: 'ord-susp-suspend' })
      .expect(200)
    const startBlocked = await request(app.getHttpServer())
      .post(`/process/orders/${suspOrderId}/start`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'ord-susp-start-blocked' })
      .expect(422)
    expect(startBlocked.body.message).toContain('A1-1')
    expect(startBlocked.body.message).toContain('挂起')
    // 解除挂起 → 开工成功
    await request(app.getHttpServer())
      .post(`/process/orders/${suspOrderId}/resume`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'ord-susp-resume' })
      .expect(200)
    const started = await request(app.getHttpServer())
      .post(`/process/orders/${suspOrderId}/start`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'ord-susp-start' })
      .expect(200)
    expect(started.body.data.orderStatus).toBe('in_progress')
    expect(started.body.data.actualStartAt).toBeTruthy()
    const detail = await request(app.getHttpServer())
      .get(`/process/orders/${suspOrderId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(detail.body.order.orderStatus).toBe('in_progress')
    expect(detail.body.order.actualStartAt).toBeTruthy()
    expect(detail.body.order.suspended).toBe(false)
  })
})

describe('⑤ 幂等重放（同一 operationId）', () => {
  it('同 operationId 同载荷 → 同一订单原结果回放（库中 1 行）；异载荷 → 422 幂等键冲突', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const payload = {
      orderNo: 'MO-PROC-IDEM',
      materialId: fx.materialId,
      productionDeptId: fx.szDeptId,
      productionQty: '300',
      uom: 'M',
      initialStatus: 'approved',
      operationId: 'ord-idem-op-1',
    }
    const first = await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(201)
    const orderId = first.body.data.orderId as string
    const replay = await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(201)
    expect(replay.body.data.orderId).toBe(orderId)
    const rows = await pool.query(`SELECT count(*)::int AS n FROM production_order WHERE order_no = 'MO-PROC-IDEM'`)
    expect(rows.rows[0]!.n).toBe(1)
    // 审计行落库
    const audits = await pool.query(
      `SELECT count(*)::int AS n FROM audit_entry WHERE action = 'process.order.receive' AND subject_id = $1`,
      [orderId],
    )
    expect(audits.rows[0]!.n).toBe(1) // 重放不重复入账（首执一次审计）

    const mismatch = await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...payload, orderNo: 'MO-PROC-IDEM-2' })
      .expect(422)
    expect(mismatch.body.code).toBe('ERR_IDEMPOTENT_PAYLOAD_MISMATCH')
  })

  it('同单号不同 operationId 入站 → 422 查重拒绝（同企业生产单号唯一）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const res = await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({
        orderNo: 'MO-PROC-3060',
        materialId: fx.materialId,
        productionDeptId: fx.szDeptId,
        productionQty: '100',
        uom: 'M',
        operationId: 'ord-dup-orderno',
      })
      .expect(422)
    expect(res.body.message).toContain('已存在')
  })
})

describe('⑥ 跨厂 403 与列表过滤', () => {
  it('合肥厂管理员：显式越厂查询 403；不带参数仅见本厂订单；跨厂写命令 403（二道防线）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    // admin（企业范围）在合肥厂接一张订单（供跨厂列表过滤证据）
    await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({
        orderNo: 'MO-PROC-HF-1',
        materialId: fx.materialId,
        productionDeptId: fx.hfDeptId,
        productionQty: '200',
        uom: 'M',
        initialStatus: 'approved',
        operationId: 'ord-hf-receive',
      })
      .expect(201)

    const hf = await hfAdmin()
    // 显式越厂参数 → 403（ScopeGuard 首检）
    const forbiddenOrders = await request(app.getHttpServer())
      .get(`/process/orders?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${hf}`)
      .expect(403)
    expect(forbiddenOrders.body.code).toBe('ERR_FORBIDDEN_SCOPE')
    const forbiddenFamilies = await request(app.getHttpServer())
      .get(`/process/families?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${hf}`)
      .expect(403)
    expect(forbiddenFamilies.body.code).toBe('ERR_FORBIDDEN_SCOPE')

    // 不带参数：服务端按数据范围过滤 → 仅合肥订单可见（苏州订单不可见）
    const list = await request(app.getHttpServer())
      .get('/process/orders')
      .set('Authorization', `Bearer ${hf}`)
      .expect(200)
    expect(list.body.total).toBe(1)
    expect((list.body.items as Array<Record<string, unknown>>).every((o) => o['plantId'] === hfPlantId)).toBe(true)
    expect(
      (list.body.items as Array<Record<string, unknown>>).some((o) => o['orderNo'] === 'MO-PROC-3060'),
    ).toBe(false)

    // 跨厂写命令（合肥管理员在苏州部门接单）→ 403（命令事务内范围复核）
    const crossPlant = await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${hf}`)
      .send({
        orderNo: 'MO-PROC-HF-CROSS',
        materialId: fx.materialId,
        productionDeptId: fx.szDeptId,
        productionQty: '100',
        uom: 'M',
        operationId: 'ord-hf-cross',
      })
      .expect(403)
    expect(crossPlant.body.code).toBe('ERR_FORBIDDEN_SCOPE')
  })
})

describe('引用保护与作废流（A1-3 / A1-1）', () => {
  it('被订单工序引用的工序不可删除（③序：订单工序真实计数 → 422）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const res = await request(app.getHttpServer())
      .delete(`/process/operations/${operationId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'fx-op-retire-blocked' })
      .expect(422)
    expect(res.body.message).toContain('A1-3')
    expect(res.body.message).toContain('被使用')
  })

  it('产品族被未失效工艺版本/未作废订单引用时不可失效（→ 422）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const res = await request(app.getHttpServer())
      .delete(`/process/families/${familyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'fx-family-retire-blocked' })
      .expect(422)
    expect(res.body.message).toContain('A1-3')
  })

  it('作废必须填写原因；作废后默认列表不可见、显式 statuses=voided 可查（作废独立）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const noReason = await request(app.getHttpServer())
      .post(`/process/orders/${uncfgOrderId}/void`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'ord-uncfg-void-noreason' })
      .expect(422)
    expect(noReason.body.message).toContain('原因')

    await request(app.getHttpServer())
      .post(`/process/orders/${uncfgOrderId}/void`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: '上游撤销', operationId: 'ord-uncfg-void' })
      .expect(200)

    const defaultList = await request(app.getHttpServer())
      .get('/process/orders')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(
      (defaultList.body.items as Array<Record<string, unknown>>).some((o) => o['orderNo'] === 'MO-PROC-UNCFG'),
    ).toBe(false) // 默认筛选不含已作废（PRD §1.2）

    const voidedList = await request(app.getHttpServer())
      .get('/process/orders?statuses=voided')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(
      (voidedList.body.items as Array<Record<string, unknown>>).some(
        (o) => o['orderNo'] === 'MO-PROC-UNCFG' && o['orderStatus'] === 'voided',
      ),
    ).toBe(true)

    // 已作废订单不可开工/不可重复作废（终态）
    const startVoided = await request(app.getHttpServer())
      .post(`/process/orders/${uncfgOrderId}/start`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'ord-uncfg-start-after-void' })
      .expect(422)
    expect(startVoided.body.message).toContain('A1-1')
    await request(app.getHttpServer())
      .post(`/process/orders/${uncfgOrderId}/void`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: '再作废', operationId: 'ord-uncfg-void-again' })
      .expect(422)
  })
})

describe('BOM/参数规范版本链与守卫链', () => {
  it('BOM 创建→发布→订单引用（A2：订单只引用已发布版本）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const draft = await request(app.getHttpServer())
      .post('/process/boms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        productFamilyId: familyId,
        materialId: fx.materialId,
        lines: [
          { materialId: fx.materialId, materialCode: 'MAT-PROC-CU', quantity: '1200', uom: 'M' },
        ],
        operationId: 'fx-bom-1',
      })
      .expect(201)
    const bomId = draft.body.data.revisionId as string
    expect(draft.body.data.version).toBe(1)

    await request(app.getHttpServer())
      .post(`/process/boms/${bomId}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'fx-bom-1-pub' })
      .expect(200)

    // 自动取 published BOM（plant+material）
    const received = await request(app.getHttpServer())
      .post('/process/orders/receive')
      .set('Authorization', `Bearer ${token}`)
      .send({
        orderNo: 'MO-PROC-BOM',
        materialId: fx.materialId,
        productionDeptId: fx.szDeptId,
        productionQty: '100',
        uom: 'M',
        initialStatus: 'approved',
        operationId: 'ord-bom-receive',
      })
      .expect(201)
    expect(received.body.data.bomRevisionId).toBe(bomId)

    // BOM 行数量非法（负数）→ 422 A2-1
    const badBom = await request(app.getHttpServer())
      .post('/process/boms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        productFamilyId: familyId,
        materialId: fx.materialId,
        lines: [{ materialId: fx.materialId, materialCode: 'MAT-PROC-CU', quantity: '-5', uom: 'M' }],
        operationId: 'fx-bom-bad',
      })
      .expect(422)
    expect(badBom.body.message).toContain('A2-1')
  })

  it('参数规范 创建→发布；draft→reviewed 中间态置位', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const draft = await request(app.getHttpServer())
      .post('/process/parameters')
      .set('Authorization', `Bearer ${token}`)
      .send({
        productFamilyId: familyId,
        name: '挤出工艺参数',
        parameters: [{ key: 'temp', value: '80' }],
        operationId: 'fx-param-1',
      })
      .expect(201)
    const paramId = draft.body.data.revisionId as string
    // draft → reviewed（中间态置位）
    await request(app.getHttpServer())
      .patch(`/process/parameters/${paramId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'reviewed', operationId: 'fx-param-review' })
      .expect(200)
    // reviewed → published
    await request(app.getHttpServer())
      .post(`/process/parameters/${paramId}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: 'fx-param-pub' })
      .expect(200)
  })

  it('守卫链：无令牌 401；无 process 许可账号 403（ERR_FORBIDDEN_SCOPE）', async () => {
    if (skipIfNoDb()) return
    await request(app.getHttpServer()).get('/process/orders').expect(401)
    const qcToken = await login('szqc01', 'SzQuality01')
    const forbidden = await request(app.getHttpServer())
      .get('/process/orders')
      .set('Authorization', `Bearer ${qcToken}`)
      .expect(403)
    expect(forbidden.body.code).toBe('ERR_FORBIDDEN_SCOPE')
  })

  it('工序主数据列表（A1-3 视图）与 DTO 形状断言', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const list = await request(app.getHttpServer())
      .get(`/process/operations?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(list.body.total).toBeGreaterThanOrEqual(1)
    const dto: OperationDefinitionDto = list.body.items[0] as unknown as OperationDefinitionDto
    expect(dto.companyOrgCode).toBeTruthy()
    expect(dto.deptId).toBe(fx.szDeptId)
    expect(dto.status).toBe('active')
  })

  it('订单列表过滤：orderNoLike / statuses / suspended（服务端过滤）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const byNo = await request(app.getHttpServer())
      .get('/process/orders?orderNoLike=3060')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(byNo.body.total).toBe(1)
    expect((byNo.body.items[0] as Record<string, unknown>)['orderNo']).toBe('MO-PROC-3060')

    const byStatus = await request(app.getHttpServer())
      .get('/process/orders?statuses=approved,released')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(
      (byStatus.body.items as Array<Record<string, unknown>>).every((o) =>
        ['approved', 'released'].includes(o['orderStatus'] as string),
      ),
    ).toBe(true)
  })
})
