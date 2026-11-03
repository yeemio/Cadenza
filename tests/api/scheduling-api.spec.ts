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
import type {
  CapacityCalendarDto,
  DeviceBoardViewDto,
  OrderSchedulingViewDto,
  PdaPlanViewDto,
  ShiftInfoDto,
  ShiftParameterDto,
} from '../../packages/contracts/src/scheduling'
import { createSchedulingCommandHandlers } from '../../packages/application/src/scheduling-handlers'
import { SchedulingQueryService } from '../../packages/application/src/scheduling-queries'
import type { SchedulingCommandTools } from '../../packages/application/src/scheduling-repositories'
import { createPgSchedulingRepositories } from '../../packages/persistence/src/scheduling-repositories'
import type { SqlClient } from '../../packages/persistence/src/sql-client'
import { DbModule } from '../../apps/api/src/db/db.module'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { SchedulingModule } from '../../apps/api/src/scheduling/scheduling.module'
import { validateEnv } from '../../apps/api/src/env'
import {
  SCHEDULING_TEST_DB_NAME,
  schedulingDatabaseUrl,
  prepareSchedulingTestDatabase,
  seedSchedulingFixtures,
  type SchedulingFixtureIds,
} from './scheduling-test-env'

/**
 * 排程 API 集成（真容器独立库 cadenza_sch + supertest 挂载 SchedulingModule，无桩）。
 * 七类证据：①槽位唯一（同键替换至多一条有效）与改 0 删槽；②硬校验 422 vs 超产能弱提醒
 * （confirm=false 拒 / confirm=true 可提交带 warning）；③双视图一致（订单视图与设备视图
 * 同槽同值）；④班次跨日（白班 08:00，07:59 归前一日）；⑤维修设备不可新建正数排产；
 * ⑥幂等重放；⑦跨厂 403 与列表服务端过滤。另含批量保存、NEW-1 厂级隔离、NEW-2 已结束
 * 订单拒排、A3-5 日期列、A3-6 详情前置、PDA 只读投影、守卫链与 DTO 冻结断言。
 * 前置：beforeAll 自行建库 + 迁移（0001–0006 注册表 + 0007 本块程序式应用）+ 种子 + 授权。
 * 查询服务注入固定时钟（2026-11-02T10:00:00Z）：看板「今日」与日期列全静态可断言。
 */

const FIXED_NOW = new Date('2026-11-02T10:00:00Z')
/** 今日（固定时钟口径）。 */
const TODAY = '2026-11-02'
const D1 = '2026-11-03' // 今日+1（产能配置日/主排产日）
const D2 = '2026-11-05'
const D_FAR = '2026-12-20' // 30 天窗外的历史/远期排产日（看板日期列保留展示）

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let fx: SchedulingFixtureIds

beforeAll(async () => {
  try {
    pool = await prepareSchedulingTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(
      `SKIP scheduling api: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${SCHEDULING_TEST_DB_NAME}）。`,
    )
    return
  }
  fx = await seedSchedulingFixtures(pool)

  // 组合根（生产由 L0 整合步落 scheduling.composition，此处同型装配）：
  // 命令总线 = scheduling 处理器 + 事务工具集（CommandTools 超集注入 scheduling 仓储束）
  const toolsFactory = (client: SqlClient, context: CommandContext, now: () => Date): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: SchedulingCommandTools = {
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
      scheduling: createPgSchedulingRepositories(client),
    }
    return tools
  }
  const commandBus = new PgCommandBus(pool, createSchedulingCommandHandlers(), toolsFactory, () => new Date())
  // 查询服务注入固定时钟（看板「今日」/班次计算确定性）
  const queries = new SchedulingQueryService({
    scheduling: createPgSchedulingRepositories(pool),
    now: () => FIXED_NOW,
  })

  // supertest 应用：DbModule（PG_POOL→独立库）+ AuthModule（全局守卫）+ SchedulingModule
  process.env['DATABASE_URL'] = schedulingDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      DbModule,
      AuthModule,
      SchedulingModule.register({ commandBus, queries }),
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

/** 保存单槽位（载荷快捷封装）。 */
function saveSlot(body: Record<string, unknown>, token?: string) {
  return request(app.getHttpServer())
    .post('/scheduling/slots')
    .set('Authorization', `Bearer ${token ?? '__PENDING__'}`)
    .send(body)
}

describe('守卫链与班次参数（[A4-1]）', () => {
  it('无令牌 401；无许可账号 403（守卫链）', async () => {
    if (skipIfNoDb()) return
    await request(app.getHttpServer()).get(`/scheduling/device-view?plantId=${fx.szPlantId}`).expect(401)
    // szqc01（种子质检员，无 scheduling 许可）→ 403
    const plain = await login('szqc01', 'SzQuality01')
    await request(app.getHttpServer())
      .get(`/scheduling/device-view?plantId=${fx.szPlantId}`)
      .set('Authorization', `Bearer ${plain}`)
      .expect(403)
  })

  it('白班起点配置：合法 HH:MM 通过；非法格式 422；工厂级唯一可覆盖', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const bad = await request(app.getHttpServer())
      .post('/scheduling/shift')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: fx.szPlantId, dayShiftStart: '0800', operationId: 'sch-shift-bad' })
      .expect(422)
    expect(bad.body.message).toContain('[A4-1]')
    const ok = await request(app.getHttpServer())
      .post('/scheduling/shift')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: fx.szPlantId, dayShiftStart: '08:00', operationId: 'sch-shift-1' })
      .expect(201)
    expect(ok.body.data.dayShiftStart).toBe('08:00')
    const updated = await request(app.getHttpServer())
      .post('/scheduling/shift')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: fx.szPlantId, dayShiftStart: '07:30', operationId: 'sch-shift-2' })
      .expect(201)
    expect(updated.body.data.dayShiftStart).toBe('07:30')
    // 恢复 08:00（后续班次跨日证据用）
    await request(app.getHttpServer())
      .post('/scheduling/shift')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: fx.szPlantId, dayShiftStart: '08:00', operationId: 'sch-shift-3' })
      .expect(201)
    const rows = await pool.query(`SELECT count(*)::int AS n FROM shift_parameter WHERE plant_id = $1`, [
      fx.szPlantId,
    ])
    expect(rows.rows[0]!.n).toBe(1) // 工厂级唯一（upsert 覆盖不新增行）
    const dto: ShiftParameterDto = ok.body.data
    expect(dto.plantId).toBe(fx.szPlantId)
  })
})

describe('④ 班次跨日（白班 08:00，07:59 归前一日；双轨时间）', () => {
  it('07:59 扫码归前一日；08:00 归当日；双轨并存（actualTime 原样保留）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const early = await request(app.getHttpServer())
      .get(`/scheduling/shift-date?plantId=${fx.szPlantId}&at=2026-11-02T07:59:00Z`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    const earlyDto: ShiftInfoDto = early.body
    expect(earlyDto.dayShiftStart).toBe('08:00')
    expect(earlyDto.shiftDate).toBe('2026-11-01')
    expect(earlyDto.actualTime).toBe('2026-11-02T07:59:00Z')

    const atStart = await request(app.getHttpServer())
      .get(`/scheduling/shift-date?plantId=${fx.szPlantId}&at=2026-11-02T08:00:00Z`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect((atStart.body as ShiftInfoDto).shiftDate).toBe('2026-11-02')

    const late = await request(app.getHttpServer())
      .get(`/scheduling/shift-date?plantId=${fx.szPlantId}&at=2026-11-02T23:30:00Z`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect((late.body as ShiftInfoDto).shiftDate).toBe('2026-11-02')

    // 未配置工厂（合肥）：白班起点空、班次日期不可计算（未配置不能扫码口径）
    const unconfigured = await request(app.getHttpServer())
      .get(`/scheduling/shift-date?plantId=${fx.hfPlantId}&at=2026-11-02T07:59:00Z`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    const unconfiguredDto: ShiftInfoDto = unconfigured.body
    expect(unconfiguredDto.dayShiftStart).toBeNull()
    expect(unconfiguredDto.shiftDate).toBeNull()
    expect(unconfiguredDto.actualTime).toBe('2026-11-02T07:59:00Z')
  })
})

describe('① 槽位唯一（同键替换至多一条有效）与改 0 删槽（[A3-1]）', () => {
  it('新建正数槽位 → 同键保存新值=替换（视图仍 1 条）→ 改 0 = 删槽 → 再改 0 = noop', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const created = await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '1000',
        operationId: 'sch-slot-create-1',
      },
      token,
    ).expect(201)
    expect(created.body.data.action).toBe('upserted')
    expect(created.body.data.slotId).toBeTruthy()

    // 同键不同值保存 → 替换（[A3-1] 本槽按替换旧值计；唯一键保证至多一条有效行）
    const replaced = await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '1500',
        operationId: 'sch-slot-replace-1',
      },
      token,
    ).expect(201)
    expect(replaced.body.data.action).toBe('upserted')

    const view = await request(app.getHttpServer())
      .get(`/scheduling/order-view/${fx.orderAId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    const viewDto: OrderSchedulingViewDto = view.body
    const op1 = viewDto.operations.find((op) => op.orderOperationId === fx.orderAOp1Id)!
    expect(op1.slots.length).toBe(1) // 同键替换不产生第二行（唯一键语义）
    expect(op1.slots[0]!.plannedQty).toBe('1500')
    expect(op1.scheduledQty).toBe('1500')

    // 库层行数（同键至多一条）
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM schedule_slot WHERE order_operation_id = $1`,
      [fx.orderAOp1Id],
    )
    expect(rows.rows[0]!.n).toBe(1)

    // 改 0 保存 = 删槽（[A3-1]）
    const removed = await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '0',
        operationId: 'sch-slot-delete-1',
      },
      token,
    ).expect(201)
    expect(removed.body.data.action).toBe('deleted')
    const afterDelete = await request(app.getHttpServer())
      .get(`/scheduling/order-view/${fx.orderAId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    const op1After = (afterDelete.body as OrderSchedulingViewDto).operations.find(
      (op) => op.orderOperationId === fx.orderAOp1Id,
    )!
    expect(op1After.slots.length).toBe(0)
    expect(op1After.scheduledQty).toBe('0')

    // 无槽改 0 = noop（幂等语义）
    const noop = await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '0',
        operationId: 'sch-slot-noop-1',
      },
      token,
    ).expect(201)
    expect(noop.body.data.action).toBe('noop')
  })
})

describe('② 硬校验 vs 弱提醒（[A3-2]/[A3-2w]）', () => {
  it('硬校验：工序计划合计超下线数量 422（confirm=true 也不豁免）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '2000',
        operationId: 'sch-hard-1',
      },
      token,
    ).expect(201)
    // 再排 1500 → 合计 3500 > 3060 → 422 [A3-2]（硬拒）
    const rejected = await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D2,
        plannedQty: '1500',
        operationId: 'sch-hard-2',
      },
      token,
    ).expect(422)
    expect(rejected.body.message).toContain('[A3-2]')
    expect(rejected.body.message).toContain('3060')
    // confirm=true 不豁免硬校验
    await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D2,
        plannedQty: '1500',
        confirm: true,
        operationId: 'sch-hard-3',
      },
      token,
    ).expect(422)
    // 回退 2000 槽位（后续用例复用干净态）
    await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '0',
        operationId: 'sch-hard-4',
      },
      token,
    ).expect(201)
  })

  it('弱提醒：超设备日产能 confirm=false 拒（[A3-2w] 文案）；confirm=true 可提交带 warning；产能空不比较', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    // 产能配置：EQ-A D1 = 2200（[A3-2w] 含 0 也比较；未配置不比较；B 工序下线 500 故排 400）
    const capacity = await request(app.getHttpServer())
      .post('/scheduling/capacity')
      .set('Authorization', `Bearer ${token}`)
      .send({
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        capacity: '2200',
        uom: 'M',
        operationId: 'sch-cap-1',
      })
      .expect(201)
    const capacityDto: CapacityCalendarDto = capacity.body.data
    expect(capacityDto.capacity).toBe('2200')

    // 订单A工序1 排 2000（当日累计 2000 ≤ 2200，无提醒）
    await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '2000',
        operationId: 'sch-weak-1',
      },
      token,
    ).expect(201)

    // 订单B工序1 再排 400 → 当日累计 2400 > 2200：confirm 缺省 → 422 [A3-2w]（弱提醒可确认）
    const warned = await saveSlot(
      {
        orderOperationId: fx.orderBOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '400',
        operationId: 'sch-weak-2',
      },
      token,
    ).expect(422)
    expect(warned.body.message).toContain('[A3-2w]')
    expect(warned.body.message).toContain('confirm=true')
    // confirm=false 显式 → 同样拒
    await saveSlot(
      {
        orderOperationId: fx.orderBOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '400',
        confirm: false,
        operationId: 'sch-weak-3',
      },
      token,
    ).expect(422)

    // confirm=true → 提交成功且 data.warnings 携带提醒（二次确认后可过）
    const confirmed = await saveSlot(
      {
        orderOperationId: fx.orderBOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '400',
        confirm: true,
        operationId: 'sch-weak-4',
      },
      token,
    ).expect(201)
    expect(confirmed.body.data.warnings).toBeTruthy()
    expect((confirmed.body.data.warnings as string[]).join('')).toContain('超过设备产能')

    // 产能未配置（空）不比较：D2 未配置 → 直接过（B 工序已排 400，再排 100 恰好至下线 500 不触硬校验）
    await saveSlot(
      {
        orderOperationId: fx.orderBOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D2,
        plannedQty: '100',
        operationId: 'sch-weak-5',
      },
      token,
    ).expect(201)

    // 清除产能配置 → 回到未配置态（clear 命令）
    await request(app.getHttpServer())
      .delete('/scheduling/capacity')
      .set('Authorization', `Bearer ${token}`)
      .send({ equipmentId: fx.szEquipmentAId, productionDate: D1, operationId: 'sch-cap-clear-1' })
      .expect(200)
    const cleared = await pool.query(
      `SELECT count(*)::int AS n FROM capacity_calendar WHERE equipment_id = $1 AND production_date = $2`,
      [fx.szEquipmentAId, D1],
    )
    expect(cleared.rows[0]!.n).toBe(0)
  })
})

describe('⑤ 维修设备不可新建正数排产（[A3-3]）', () => {
  it('维修设备新建正数 422；已有槽可改正数；改 0 删槽不要求设备正常', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    const rejected = await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentBRepairId,
        productionDate: D1,
        plannedQty: '1000',
        operationId: 'sch-repair-1',
      },
      token,
    ).expect(422)
    expect(rejected.body.message).toContain('[A3-3]')
    expect(rejected.body.message).toContain('维修')

    // 直插既有槽（维修前遗留）→ 已有槽位可改正数（替换过）
    await pool.query(
      `INSERT INTO schedule_slot (enterprise_id, plant_id, order_id, order_operation_id,
         operation_definition_id, equipment_id, production_date, planned_qty, uom, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 100, 'M', 'seed-sch')`,
      [
        fx.enterpriseId,
        fx.szPlantId,
        fx.orderAId,
        fx.orderAOp1Id,
        fx.operationDefinitionId,
        fx.szEquipmentBRepairId,
        D1,
      ],
    )
    const modified = await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentBRepairId,
        productionDate: D1,
        plannedQty: '500',
        operationId: 'sch-repair-2',
      },
      token,
    ).expect(201)
    expect(modified.body.data.action).toBe('upserted')
    // 改 0 删槽不要求设备正常
    const removed = await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentBRepairId,
        productionDate: D1,
        plannedQty: '0',
        operationId: 'sch-repair-3',
      },
      token,
    ).expect(201)
    expect(removed.body.data.action).toBe('deleted')
  })
})

describe('③ 双视图一致（订单视图与设备视图读同一 slot 表）', () => {
  it('同一槽位在订单视图与设备视图数值一致；替换后两视图同步变化', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    // 干净态：清 EQ-A 全部既有槽位（②/⑤ 用例遗留），保证单槽断言干净
    await pool.query(`DELETE FROM schedule_slot WHERE equipment_id = $1`, [fx.szEquipmentAId])
    await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '1500',
        remark: '双视图一致性证据',
        operationId: 'sch-dual-1',
      },
      token,
    ).expect(201)

    const orderView: OrderSchedulingViewDto = (
      await request(app.getHttpServer())
        .get(`/scheduling/order-view/${fx.orderAId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body
    const op1 = orderView.operations.find((op) => op.orderOperationId === fx.orderAOp1Id)!
    expect(op1.slots.length).toBe(1)
    const slot = op1.slots[0]!
    expect(slot.equipmentId).toBe(fx.szEquipmentAId)
    expect(slot.plannedQty).toBe('1500')

    const board: DeviceBoardViewDto = (
      await request(app.getHttpServer())
        .get(`/scheduling/device-view?plantId=${fx.szPlantId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body
    expect(board.today).toBe(TODAY)
    const row = board.equipments.find((e) => e.equipmentId === fx.szEquipmentAId)!
    const cell = row.cells.find((c) => c.productionDate === D1)!
    // 同槽两投影数值一致（同一 slot 表）
    expect(cell.plannedTotal).toBe(slot.plannedQty)
    expect(cell.orderCount).toBe(1)
    expect(cell.details[0]!.orderNo).toBe('SCH-SZ-A-001')
    expect(cell.details[0]!.plannedQty).toBe(slot.plannedQty)

    // [A3-5] 日期列：今日起连续 30 天 ∪ 已有排产日（窗外远期排产日保留）
    expect(board.dates[0]).toBe(TODAY)
    expect(board.dates).toContain('2026-12-01') // 第 30 天
    expect(board.dates).not.toContain('2026-12-02')
    expect(board.workCenters.map((w) => w.id)).toContain(fx.szWorkCenterId)
    // 维修设备照常展示（状态标签区分，不隐藏行）
    expect(board.equipments.find((e) => e.equipmentId === fx.szEquipmentBRepairId)).toBeTruthy()
  })

  it('窗外远期排产日保留在日期列；已结束订单排产不展示（[A3-5]/[NEW-2 口径]）', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    // 远期槽位（今日+48 天，30 天窗外）
    await saveSlot(
      {
        orderOperationId: fx.orderAOp2Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D_FAR,
        plannedQty: '300',
        operationId: 'sch-far-1',
      },
      token,
    ).expect(201)
    const board: DeviceBoardViewDto = (
      await request(app.getHttpServer())
        .get(`/scheduling/device-view?plantId=${fx.szPlantId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body
    expect(board.dates).toContain(D_FAR)

    // 订单B 改已结束 → 其槽位从设备看板消失（[A3-5] 已结束不展示）
    await pool.query(`UPDATE production_order SET order_status = 'closed' WHERE id = $1`, [fx.orderBId])
    const boardAfter: DeviceBoardViewDto = (
      await request(app.getHttpServer())
        .get(`/scheduling/device-view?plantId=${fx.szPlantId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body
    const rowA = boardAfter.equipments.find((e) => e.equipmentId === fx.szEquipmentAId)!
    const d2Cell = rowA.cells.find((c) => c.productionDate === D2)
    expect(d2Cell).toBeUndefined() // 订单B D2 槽位因订单已结束不再展示

    // 已结束订单写排产 → 422 [NEW-2]
    const rejected = await saveSlot(
      {
        orderOperationId: fx.orderBOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '100',
        operationId: 'sch-closed-1',
      },
      token,
    ).expect(422)
    expect(rejected.body.message).toContain('[NEW-2]')
    // 恢复订单B 状态（后续用例复用）
    await pool.query(`UPDATE production_order SET order_status = 'approved' WHERE id = $1`, [fx.orderBId])
  })
})

describe('批量矩阵保存与厂级隔离（[A3 / ES §2.1]、[NEW-1]）', () => {
  it('批量保存：多订单行一次提交；批内重复键拒；硬校验逐工序拒绝整批', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    await pool.query(`DELETE FROM schedule_slot WHERE order_operation_id IN ($1, $2)`, [
      fx.orderAOp1Id,
      fx.orderBOp1Id,
    ])
    const ok = await request(app.getHttpServer())
      .post('/scheduling/slots/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entries: [
          {
            orderOperationId: fx.orderAOp1Id,
            equipmentId: fx.szEquipmentAId,
            productionDate: D1,
            plannedQty: '1000',
          },
          {
            orderOperationId: fx.orderBOp1Id,
            equipmentId: fx.szEquipmentAId,
            productionDate: D1,
            plannedQty: '300',
          },
        ],
        operationId: 'sch-batch-1',
      })
      .expect(201)
    expect(ok.body.data.applied.upserted).toBe(2)

    // 批内重复键（同键两行）→ 422 [A3-1]
    const dup = await request(app.getHttpServer())
      .post('/scheduling/slots/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entries: [
          {
            orderOperationId: fx.orderAOp1Id,
            equipmentId: fx.szEquipmentAId,
            productionDate: D2,
            plannedQty: '100',
          },
          {
            orderOperationId: fx.orderAOp1Id,
            equipmentId: fx.szEquipmentAId,
            productionDate: D2,
            plannedQty: '200',
          },
        ],
        operationId: 'sch-batch-2',
      })
      .expect(422)
    expect(dup.body.message).toContain('[A3-1]')

    // 硬校验逐工序：订单A工序1（已排 1000）批内再排 2500 → 合计 3500 > 3060 → 整批拒
    // （订单B工序1 行合法 400，但硬校验任一工序超限即拒绝整批）
    const hard = await request(app.getHttpServer())
      .post('/scheduling/slots/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entries: [
          {
            orderOperationId: fx.orderAOp1Id,
            equipmentId: fx.szEquipmentAId,
            productionDate: D2,
            plannedQty: '2500',
          },
          {
            orderOperationId: fx.orderBOp1Id,
            equipmentId: fx.szEquipmentAId,
            productionDate: D2,
            plannedQty: '400',
          },
        ],
        operationId: 'sch-batch-3',
      })
      .expect(422)
    expect(hard.body.message).toContain('[A3-2]')
    // 整批拒绝：D2 两行均未落库
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM schedule_slot WHERE production_date = $2 AND order_operation_id = ANY($1)`,
      [[fx.orderAOp1Id, fx.orderBOp1Id], D2],
    )
    expect(rows.rows[0]!.n).toBe(0)
  })

  it('批量弱提醒整批确认一次；[NEW-1] 跨厂设备排产 422', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    // 产能 D1 EQ-A = 2000：本批键替换旧值后合计 1800+400=2200 > 2000（其它槽=0，本批键旧值不计入）
    await request(app.getHttpServer())
      .post('/scheduling/capacity')
      .set('Authorization', `Bearer ${token}`)
      .send({
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        capacity: '2000',
        uom: 'M',
        operationId: 'sch-cap-2',
      })
      .expect(201)
    const warned = await request(app.getHttpServer())
      .post('/scheduling/slots/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entries: [
          {
            orderOperationId: fx.orderAOp1Id,
            equipmentId: fx.szEquipmentAId,
            productionDate: D1,
            plannedQty: '1800',
          },
          {
            orderOperationId: fx.orderBOp1Id,
            equipmentId: fx.szEquipmentAId,
            productionDate: D1,
            plannedQty: '400',
          },
        ],
        operationId: 'sch-batch-4',
      })
      .expect(422)
    expect(warned.body.message).toContain('[A3-2w]')
    expect(warned.body.message).toContain('整批确认一次')
    const confirmed = await request(app.getHttpServer())
      .post('/scheduling/slots/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entries: [
          {
            orderOperationId: fx.orderAOp1Id,
            equipmentId: fx.szEquipmentAId,
            productionDate: D1,
            plannedQty: '1800',
          },
          {
            orderOperationId: fx.orderBOp1Id,
            equipmentId: fx.szEquipmentAId,
            productionDate: D1,
            plannedQty: '400',
          },
        ],
        confirm: true,
        operationId: 'sch-batch-5',
      })
      .expect(201)
    expect((confirmed.body.data.warnings as string[]).length).toBe(1)

    // [NEW-1] 苏州订单排合肥设备 → 422（厂级隔离）
    const crossPlant = await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.hfEquipmentId,
        productionDate: D1,
        plannedQty: '100',
        operationId: 'sch-cross-1',
      },
      token,
    ).expect(422)
    expect(crossPlant.body.message).toContain('[NEW-1]')
  })
})

describe('⑥ 幂等重放（D2 命令收据）', () => {
  it('同 operationId 同载荷重放回放原结果（1 槽 1 审计）；同 operationId 异载荷 422', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    // D2 无产能配置（弱提醒不触发）；D1 产能遗留与本例无关
    const payload = {
      orderOperationId: fx.orderAOp2Id,
      equipmentId: fx.szEquipmentAId,
      productionDate: D2,
      plannedQty: '700',
      operationId: 'sch-idem-1',
    }
    const auditCount = async (): Promise<number> => {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM audit_entry WHERE action = 'scheduling.slot.save' AND subject_id = $1`,
        [fx.orderAOp2Id],
      )
      return r.rows[0]!.n
    }
    const auditsBefore = await auditCount()
    const first = await saveSlot(payload, token).expect(201)
    const replay = await saveSlot(payload, token).expect(201)
    expect(replay.body.operationId).toBe('sch-idem-1')
    expect(replay.body.data.slotId).toBe(first.body.data.slotId)

    const slots = await pool.query(
      `SELECT count(*)::int AS n FROM schedule_slot WHERE order_operation_id = $1 AND production_date = $2`,
      [fx.orderAOp2Id, D2],
    )
    expect(slots.rows[0]!.n).toBe(1)
    expect(await auditCount()).toBe(auditsBefore + 1) // 重放不新增审计行

    const mismatch = await saveSlot(
      { ...payload, plannedQty: '999', operationId: 'sch-idem-1' },
      token,
    ).expect(422)
    expect(mismatch.body.code).toBe('ERR_IDEMPOTENT_PAYLOAD_MISMATCH')
  })
})

describe('⑦ 跨厂 403 与列表服务端过滤', () => {
  it('合肥厂管理员：显式越厂查询 403；不带参数仅见本厂；跨厂写命令 403（二道防线）', async () => {
    if (skipIfNoDb()) return
    const token = await hfAdmin()
    // 显式越厂参数 → 403（ScopeGuard 首检）
    await request(app.getHttpServer())
      .get(`/scheduling/device-view?plantId=${fx.szPlantId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403)
    await request(app.getHttpServer())
      .get(`/scheduling/shift-date?plantId=${fx.szPlantId}&at=2026-11-02T07:59:00Z`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403)

    // 不带参数 → 合肥看板（只合肥工作中心/设备；苏州订单槽不可见）
    const board: DeviceBoardViewDto = (
      await request(app.getHttpServer())
        .get('/scheduling/device-view')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body
    expect(board.plantId).toBe(fx.hfPlantId)
    expect(board.equipments.map((e) => e.equipmentId)).toContain(fx.hfEquipmentId)
    expect(board.equipments.map((e) => e.equipmentId)).not.toContain(fx.szEquipmentAId)

    // 苏州订单视图：数据范围外按不存在处理（404，服务端过滤）
    await request(app.getHttpServer())
      .get(`/scheduling/order-view/${fx.orderAId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404)

    // 跨厂写命令（合肥管理员排苏州订单）→ 403（命令事务内范围复核）
    const rejected = await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D2,
        plannedQty: '100',
        operationId: 'sch-cross-write-1',
      },
      token,
    ).expect(403)
    expect(rejected.body.code).toBe('ERR_FORBIDDEN_SCOPE')
  })
})

describe('PDA 排产计划只读（[A3-7 / PP §3.2]）与 A3-6 详情前置', () => {
  it('PDA 按工作中心 + 日期分组只读；订单号模糊/设备/日期过滤', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    // 合肥订单排产（hf 设备 D1）供 PDA 查询
    await saveSlot(
      {
        orderOperationId: fx.orderCOp1Id,
        equipmentId: fx.hfEquipmentId,
        productionDate: D1,
        plannedQty: '800',
        operationId: 'sch-pda-1',
      },
      token,
    ).expect(201)

    const plan: PdaPlanViewDto = (
      await request(app.getHttpServer())
        .get(`/scheduling/pda/plan?workCenterId=${fx.hfWorkCenterId}&date=${D1}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body
    expect(plan.workCenterName).toContain('排产测试')
    expect(plan.groups.length).toBe(1)
    expect(plan.groups[0]!.productionDate).toBe(D1)
    expect(plan.groups[0]!.items[0]!.orderNo).toBe('SCH-HF-C-003')
    expect(plan.groups[0]!.items[0]!.materialDesc).toContain('排产测试铜缆')
    expect(plan.groups[0]!.items[0]!.plannedQty).toBe('800')

    // 生产单号模糊过滤
    const filtered = (
      await request(app.getHttpServer())
        .get(`/scheduling/pda/plan?workCenterId=${fx.hfWorkCenterId}&date=${D1}&orderNoLike=不存在的单号`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body as PdaPlanViewDto
    expect(filtered.groups.length).toBe(0)

    // 未选日期默认窗口（当天及往前 7 天）：D1 在窗口外 → 空（窗口口径证据）
    const defaultWindow = (
      await request(app.getHttpServer())
        .get(`/scheduling/pda/plan?workCenterId=${fx.hfWorkCenterId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body as PdaPlanViewDto
    expect(defaultWindow.groups.length).toBe(0)

    // workCenterId 必填
    await request(app.getHttpServer())
      .get('/scheduling/pda/plan')
      .set('Authorization', `Bearer ${token}`)
      .expect(400)
  })

  it('A3-6：工序未配置订单 enterable=false；已配置订单 enterable=true；回写链排产状态投影', async () => {
    if (skipIfNoDb()) return
    const token = await admin()
    // 清除 EQ-A 产能遗留（批量用例配置 2000 会误触发本组弱提醒）
    await pool.query(`DELETE FROM capacity_calendar WHERE equipment_id = $1`, [fx.szEquipmentAId])
    // 直插未配置订单（无工序行）
    const unconfigured = await pool.query<{ id: string }>(
      `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id,
         material_snapshot, production_dept_id, production_qty, uom, order_status,
         process_config_status, created_by)
       VALUES ($1, $2, 'SCH-SZ-UNC-009', (SELECT id FROM material WHERE code = 'MAT-SCH-CU'),
         '{}'::jsonb, $3, '100', 'M', 'approved', 'unconfigured', 'seed-sch')
       RETURNING id`,
      [fx.enterpriseId, fx.szPlantId, fx.szDeptId],
    )
    const uncfgView: OrderSchedulingViewDto = (
      await request(app.getHttpServer())
        .get(`/scheduling/order-view/${unconfigured.rows[0]!.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body
    expect(uncfgView.enterable).toBe(false)
    expect(uncfgView.entryBlocker).toContain('[A3-6]')
    expect(uncfgView.schedulingStatus).toBe('unplanned')

    // 订单A（工序1 已排 1800 < 3060；工序2 已排 2000+300 < 3000）→ 部分排产（回写链投影）
    const viewA: OrderSchedulingViewDto = (
      await request(app.getHttpServer())
        .get(`/scheduling/order-view/${fx.orderAId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body
    expect(viewA.enterable).toBe(true)
    expect(viewA.entryBlocker).toBeNull()
    const op1 = viewA.operations.find((op) => op.orderOperationId === fx.orderAOp1Id)!
    const op2 = viewA.operations.find((op) => op.orderOperationId === fx.orderAOp2Id)!
    expect(op1.scheduledQty).toBe('1800')
    expect(op1.fullyScheduled).toBe(false)
    expect(op2.scheduledQty).toBe('1000') // D_FAR 300 + D2 700（⑥ 幂等用例遗留）
    expect(op2.fullyScheduled).toBe(false)
    expect(viewA.schedulingStatus).toBe('partially_scheduled')

    // 工序1 补排至下线数量 → 工序排完 + 订单仍部分（工序2 未排完）
    await saveSlot(
      {
        orderOperationId: fx.orderAOp1Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '3060',
        operationId: 'sch-full-1',
      },
      token,
    ).expect(201)
    const viewA2: OrderSchedulingViewDto = (
      await request(app.getHttpServer())
        .get(`/scheduling/order-view/${fx.orderAId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body
    const op1Full = viewA2.operations.find((op) => op.orderOperationId === fx.orderAOp1Id)!
    expect(op1Full.fullyScheduled).toBe(true)
    expect(op1Full.scheduledQty).toBe('3060')
    expect(viewA2.schedulingStatus).toBe('partially_scheduled')

    // 工序2 补排 2000（既有 1000）→ 合计 3000 恰好排完 → 已排产（[A3-4] 回写链终点）
    await saveSlot(
      {
        orderOperationId: fx.orderAOp2Id,
        equipmentId: fx.szEquipmentAId,
        productionDate: D1,
        plannedQty: '2000',
        operationId: 'sch-full-2',
      },
      token,
    ).expect(201)
    const viewA3: OrderSchedulingViewDto = (
      await request(app.getHttpServer())
        .get(`/scheduling/order-view/${fx.orderAId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body
    expect(viewA3.schedulingStatus).toBe('fully_scheduled')
  })
})
