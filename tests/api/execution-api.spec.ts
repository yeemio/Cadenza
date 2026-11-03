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
  PgBarcodeRepository,
  PgCarrierRepository,
  PgCommandReceiptRefRepository,
  PgGenealogyRepository,
  PgInventoryUnitRepository,
  PgMaterialLotRepository,
  PgMaterialSegmentRepository,
  PgReservationRepository,
  PgStockBalanceRepository,
  PgStockTransactionRepository,
  createPgProcessRepositories,
  type CommandToolsFactory,
  type SqlClient,
} from '@cadenza/persistence'
import {
  computeActorAuthorization,
  type CommandContext,
  type CommandTools,
  type OutboxIntent,
} from '@cadenza/application'
import { CommandResultStatus } from '@cadenza/contracts'
import { createExecutionCommandHandlers } from '../../packages/application/src/execution-handlers'
import { ExecutionQueryService } from '../../packages/application/src/execution-queries'
import type { ExecutionCommandTools, ScheduleReadPort, ScheduledOperationView } from '../../packages/application/src/execution-repositories'
import { createPgExecutionRepositories } from '../../packages/persistence/src/execution-repositories'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { validateEnv } from '../../apps/api/src/env'
import { DbModule } from '../../apps/api/src/db/db.module'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { ExecutionModule } from '../../apps/api/src/execution/execution.module'
import {
  prepareExecutionTestDatabase,
  seedExecutionFixtures,
  seedOrder,
  nodeId,
  executionDatabaseUrl,
  LOC_LINE_SEMI,
  LOC_LINE_SEMI_CODE,
  LOC_LINE_FIN,
  LOC_LINE_FIN_CODE,
  OWNER_ID,
  OWNER_NAME,
  UOM_M_ID,
  type ExecutionFixtureIds,
} from './execution-test-env'

/**
 * execution API 集成（真容器独立库 cadenza_exe + supertest 挂载 ExecutionModule，无桩；
 * 不改共享 app.module.ts——L0 整合步统一注册）。
 *
 * 证据面：三入口 HTTP 端点（orders/:id/reports、workbench/reports、scan/reports + 扫设备码
 * 上下文）、草稿列表/续作、审核端点、投料端点、五量查询端点；
 * 守卫（[底稿 A6/D4]）：操作工仅自己（szqc01 无 execution.review → 查询限定本人、审核 403）、
 * 班组长车间范围（szws01 苏州厂 foreman → 厂范围 + 可审核；合肥 HF 不可见）、
 * 许可缺失 403（hfadmin01 无 execution.read）。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let fx: ExecutionFixtureIds
let adminCtx: CommandContext
const run = `apexe${Date.now().toString(36)}`

const scheduleStore = new Map<string, ScheduledOperationView[]>()
const schedulePort: ScheduleReadPort = {
  async listScheduledOperations({ equipmentId }) {
    return scheduleStore.get(equipmentId) ?? []
  },
}

function buildBus(): PgCommandBus {
  const config = {
    defaultOverrunRatio: null,
    // 「末道自动审核车间」配置为空清单（GAP C2 保守默认）：末道一律待审 → 班组长人工审核路径
    // （末道自动路径的证据见 integration ③，busAuto 配置注入同一端口）。
    lastOperationAutoReviewDeptIds: [],
    qcDeptIds: [fx.szQcDeptId],
    consumableMaterialTypes: null,
    defaultOwnerId: OWNER_ID,
    defaultOwnerName: OWNER_NAME,
  }
  const toolsFactory: CommandToolsFactory = (client: SqlClient, context: CommandContext, now: () => Date): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: ExecutionCommandTools = {
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
      execution: createPgExecutionRepositories(client),
      inv: {
        receipts: new PgCommandReceiptRefRepository(client),
        lots: new PgMaterialLotRepository(client),
        units: new PgInventoryUnitRepository(client),
        segments: new PgMaterialSegmentRepository(client),
        balances: new PgStockBalanceRepository(client),
        transactions: new PgStockTransactionRepository(client),
        reservations: new PgReservationRepository(client),
        barcodes: new PgBarcodeRepository(client),
        carriers: new PgCarrierRepository(client),
        genealogy: new PgGenealogyRepository(client),
      },
      process: createPgProcessRepositories(client),
      outbox: {
        collect(intent: OutboxIntent): void {
          void client
            .query(
              `INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload)
               VALUES ($1, $2, $3, 'PENDING', $4::jsonb)`,
              [intent.aggregateType, intent.aggregateId, intent.taskKind, JSON.stringify(intent.payload)],
            )
            .catch(() => undefined)
        },
      },
      schedule: schedulePort,
      config,
    }
    return tools
  }
  return new PgCommandBus(pool, createExecutionCommandHandlers(), toolsFactory, () => new Date())
}

function outputLine(
  quantity: string,
  targetLocationId: string = LOC_LINE_SEMI,
  targetLocationCode: string = LOC_LINE_SEMI_CODE,
): Record<string, unknown> {
  return {
    quantity,
    uomId: UOM_M_ID,
    uomCode: 'M',
    targetLocationId,
    targetLocationCode,
    ownerId: OWNER_ID,
    ownerName: OWNER_NAME,
  }
}

beforeAll(async () => {
  try {
    pool = await prepareExecutionTestDatabase()
  } catch {
    dbAvailable = false
    console.warn('SKIP execution api: 数据库不可达。请先 docker compose up -d 再重跑。')
    return
  }
  fx = await seedExecutionFixtures(pool)
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  process.env['DATABASE_URL'] = executionDatabaseUrl()
  const commandBus = buildBus()
  const queries = new ExecutionQueryService({
    execution: createPgExecutionRepositories(pool),
    process: createPgProcessRepositories(pool),
    schedule: schedulePort,
    qcDeptIds: [fx.szQcDeptId],
  })
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      DbModule,
      AuthModule,
      ExecutionModule.register({ commandBus, queries }),
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

async function login(loginName: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ loginName, password, platform: 'WEB' })
  expect(res.status).toBe(200)
  return res.body.token as string
}

describe('execution API：三入口端点 + 扫码上下文 + 五量查询', () => {
  it('扫设备码上下文：排产端口（内存实现）返回设备当天排产工序', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-SCAN`,
      plannedQty: '100',
      ops: [
        { seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' },
        { seq: 2, operationDefinitionId: fx.operationDefIds.seq2, deptId: fx.szJzDeptId, offlineQty: '100' },
      ],
    })
    scheduleStore.set('EQ-HTTP', [
      {
        orderId: order.orderId,
        orderOperationId: order.operationIds[0]!,
        operationSeq: 1,
        operationDefinitionId: fx.operationDefIds.seq1,
      },
    ])
    const admin = await login('admin', 'CadAdmin001')
    const res = await request(app.getHttpServer())
      .get('/execution/scan/context')
      .query({ plantId: fx.szPlantId, equipmentId: 'EQ-HTTP' })
      .set('Authorization', `Bearer ${admin}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      {
        orderId: order.orderId,
        orderOperationId: order.operationIds[0],
        operationSeq: 1,
        operationDefinitionId: fx.operationDefIds.seq1,
      },
    ])

    // 三入口 HTTP 提交（同一操作工连续提交：提交后开放会话，互斥不触发）
    const orderRes = await request(app.getHttpServer())
      .post(`/execution/orders/${order.orderId}/reports`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ orderOperationId: order.operationIds[0], outputs: [outputLine('10')] })
    expect(orderRes.status).toBe(201)
    expect(orderRes.body.data.reviewOutcome).toBe('auto_approved')

    const wbRes = await request(app.getHttpServer())
      .post('/execution/workbench/reports')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        orderId: order.orderId,
        orderOperationId: order.operationIds[0],
        outputs: [outputLine('20')],
      })
    expect(wbRes.status).toBe(201)
    expect(wbRes.body.data.reviewOutcome).toBe('auto_approved')

    const scanRes = await request(app.getHttpServer())
      .post('/execution/scan/reports')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        orderId: order.orderId,
        equipmentId: 'EQ-HTTP',
        equipmentCode: 'EQ-HTTP',
        outputs: [outputLine('30')],
      })
    expect(scanRes.status).toBe(201)
    expect(scanRes.body.data.reviewOutcome).toBe('auto_approved')

    // 五量查询端点：非末道自动审核 → approved 60 / stocked 60（三入口同记账）
    const quantities = await request(app.getHttpServer())
      .get(`/execution/orders/${order.orderId}/quantities`)
      .set('Authorization', `Bearer ${admin}`)
    expect(quantities.status).toBe(200)
    expect(quantities.body.total).toMatchObject({
      approvedQty: '60.0000',
      stockedQty: '60.0000',
      draftQty: '0.0000',
    })
  })

  it('投料端点：单独投料提交（余量不足服务端拒绝，A7-4 按销售行汇总≤剩余）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const invBus = buildInventoryCommandBus(pool)
    const receive = await invBus.execute(
      {
        operationId: `${run}-recv-api`,
        commandType: 'inventory.receive-goods',
        targetId: 'new',
        expectedRevision: 0,
        payload: {
          plantId: fx.szPlantId,
          lotNo: `LOT-${run}-API`,
          unitNo: `U-${run}-API`,
          materialId: fx.materialId,
          materialCode: 'MAT-EXE-CU',
          uomId: UOM_M_ID,
          uomCode: 'm',
          quantity: '25',
          measurementBasis: 'nominal',
          locationId: LOC_LINE_SEMI,
          locationCode: LOC_LINE_SEMI_CODE,
          ownerId: OWNER_ID,
          ownerName: OWNER_NAME,
          qualityStatus: 'qualified',
        },
      },
      adminCtx,
    )
    expect(receive.status).toBe(CommandResultStatus.COMMITTED)
    const unitId = String((receive.data as { unitId: string }).unitId)
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-FEED`,
      plannedQty: '100',
      ops: [{ seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' }],
    })
    const admin = await login('admin', 'CadAdmin001')
    const ok = await request(app.getHttpServer())
      .post('/execution/feeds')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        operationId: `${run}-feed-ok`,
        orderId: order.orderId,
        orderOperationId: order.operationIds[0],
        lines: [
          {
            unitId,
            quantity: '20',
            salesOrderNo: 'SO-8001',
            salesLineNo: '10',
            confirmed: true,
            deviationReason: 'API 测试：授权偏离记录',
          },
        ],
      })
    expect(ok.status).toBe(201)
    const insufficient = await request(app.getHttpServer())
      .post('/execution/feeds')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        operationId: `${run}-feed-over`,
        orderId: order.orderId,
        orderOperationId: order.operationIds[0],
        lines: [
          {
            unitId,
            quantity: '10',
            salesOrderNo: 'SO-8001',
            salesLineNo: '10',
            confirmed: true,
            deviationReason: 'API 测试：余量不足',
          },
        ],
      })
    expect(insufficient.status).toBe(422)
    expect(insufficient.body.message).toContain('A7-4')
  })
})

describe('execution API 守卫：操作工仅自己 / 班组长车间范围 / 许可缺失', () => {
  it('hfadmin01 无 execution.read → 403；szqc01 无 execution.review → 审核 403；草稿仅自己可见', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-GRD`,
      plannedQty: '100',
      ops: [
        { seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' },
        { seq: 2, operationDefinitionId: fx.operationDefIds.seq2, deptId: fx.szJzDeptId, offlineQty: '100' },
      ],
    })
    const admin = await login('admin', 'CadAdmin001')
    const operator = await login('szqc01', 'SzQuality01')
    const foreman = await login('szws01', 'SzWorkshop01')
    const hfadmin = await login('hfadmin01', 'HfPlant0001')

    // 许可缺失：hfadmin01（合肥厂管理员，无 execution.read）→ 403
    const noPermission = await request(app.getHttpServer())
      .get('/execution/reports/drafts')
      .set('Authorization', `Bearer ${hfadmin}`)
    expect(noPermission.status).toBe(403)

    // 操作工（szqc01，无 execution.review）建末道草稿；审核端点 → 403
    const draft = await request(app.getHttpServer())
      .post(`/execution/orders/${order.orderId}/reports`)
      .set('Authorization', `Bearer ${operator}`)
      .send({ orderOperationId: order.operationIds[1], action: 'draft', outputs: [outputLine('5', LOC_LINE_FIN, LOC_LINE_FIN_CODE)] })
    expect(draft.status).toBe(201)
    const operatorDraftReportId = draft.body.data.reportId as string
    // 管理员建自己的草稿（同订单同来源——不同操作工不触发隔离键）
    const adminDraft = await request(app.getHttpServer())
      .post(`/execution/orders/${order.orderId}/reports`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ orderOperationId: order.operationIds[1], action: 'draft', outputs: [outputLine('6', LOC_LINE_FIN, LOC_LINE_FIN_CODE)] })
    expect(adminDraft.status).toBe(201)
    // 前道就绪：班组长提交 op1（非末道自动审核；szws01 与草稿持有者不同操作工，互斥不触发）
    const ready = await request(app.getHttpServer())
      .post(`/execution/orders/${order.orderId}/reports`)
      .set('Authorization', `Bearer ${foreman}`)
      .send({ orderOperationId: order.operationIds[0], outputs: [outputLine('10')] })
    expect(ready.status).toBe(201)
    expect(ready.body.data.reviewOutcome).toBe('auto_approved')

    // 操作工仅自己：szqc01 草稿列表只见本人 1 条；admin（审核者）见 2 条
    const operatorList = await request(app.getHttpServer())
      .get('/execution/reports/drafts')
      .query({ orderId: order.orderId })
      .set('Authorization', `Bearer ${operator}`)
    expect(operatorList.status).toBe(200)
    expect(operatorList.body.total).toBe(1)
    expect(operatorList.body.items[0].operatorLogin).toBe('szqc01')
    const adminList = await request(app.getHttpServer())
      .get('/execution/reports/drafts')
      .query({ orderId: order.orderId })
      .set('Authorization', `Bearer ${admin}`)
    expect(adminList.body.total).toBe(2)

    // 操作工不能看他人报工单详情（范围不可见 → 404）；审核端点无许可 → 403
    const foreignReport = await request(app.getHttpServer())
      .get(`/execution/reports/${adminDraft.body.data.reportId}`)
      .set('Authorization', `Bearer ${operator}`)
    expect(foreignReport.status).toBe(404)
    const forbiddenReview = await request(app.getHttpServer())
      .post(`/execution/reports/${operatorDraftReportId}/review`)
      .set('Authorization', `Bearer ${operator}`)
    expect(forbiddenReview.status).toBe(403)

    // 班组长（szws01，苏州厂 foreman，有 execution.review）：审核待审单成功
    const submit = await request(app.getHttpServer())
      .post(`/execution/reports/${operatorDraftReportId}/submit`)
      .set('Authorization', `Bearer ${operator}`)
      .send({})
    expect(submit.status).toBe(200)
    const review = await request(app.getHttpServer())
      .post(`/execution/reports/${operatorDraftReportId}/review`)
      .set('Authorization', `Bearer ${foreman}`)
      .send({ reason: '班组审核' })
    expect(review.status).toBe(200)
    expect(review.body.data.reviewStatus).toBe('manual_approved')

    // 班组长车间范围：合肥厂草稿对 szws01 不可见（HF 订单直落数据）
    const hfPlantId = await nodeId(pool, 'PLNT-HF')
    const hfDeptId = await nodeId(pool, 'DEPT-HF-JZ')
    const hfOrder = await pool.query<{ id: string; op: string }>(
      `WITH o AS (
         INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, production_dept_id,
           production_qty, uom, order_status, process_config_status, process_confirmed_at, actual_start_at, created_by)
         VALUES ($1, $2, $3, $4, $5, 10, 'M', 'in_progress', 'configured', now(), now(), 'seed-exe')
         RETURNING id
       ), op AS (
         INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, operation_definition_id,
           operation_code, operation_name, core_multiple, offline_qty, work_center_id, work_center_code,
           work_center_name, uom, production_dept_id, created_by)
         SELECT $1, $2, o.id, 1, $6, 'OP-EXE-01', '执行域拉丝', 1, 10, $7, 'WC-EXE-01', '执行域测试工作中心', 'M', $5, 'seed-exe'
         FROM o RETURNING id
       )
       SELECT o.id, op.id AS op FROM o, op`,
      [fx.enterpriseId, hfPlantId, `MO-${run}-HF`, fx.materialId, hfDeptId, fx.operationDefIds.seq1, fx.workCenterId],
    )
    const hfOperator = await pool.query<{ id: string }>(`SELECT id FROM user_account WHERE login_name = 'szqc01'`)
    await pool.query(
      `INSERT INTO execution_session (enterprise_id, plant_id, order_id, source, order_operation_id,
         operation_seq, operator_user_id, operator_login, shift_date, business_time, created_by)
       VALUES ($1, $2, $3, 'order', $4, 1, $5, 'szqc01', CURRENT_DATE, now(), 'seed-exe')`,
      [fx.enterpriseId, hfPlantId, hfOrder.rows[0]!.id, hfOrder.rows[0]!.op, hfOperator.rows[0]!.id],
    )
    const foremanList = await request(app.getHttpServer())
      .get('/execution/reports/drafts')
      .set('Authorization', `Bearer ${foreman}`)
    expect(foremanList.status).toBe(200)
    const orderIds = foremanList.body.items.map((i: { orderId: string }) => i.orderId)
    expect(orderIds).not.toContain(hfOrder.rows[0]!.id)
    const adminAll = await request(app.getHttpServer())
      .get('/execution/reports/drafts')
      .set('Authorization', `Bearer ${admin}`)
    expect(adminAll.body.items.map((i: { orderId: string }) => i.orderId)).toContain(hfOrder.rows[0]!.id)
  })
})
