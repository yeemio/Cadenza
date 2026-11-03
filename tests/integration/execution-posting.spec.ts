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
  type VerifiedAuthContext,
} from '@cadenza/application'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import { createExecutionCommandHandlers } from '../../packages/application/src/execution-handlers'
import { ExecutionQueryService } from '../../packages/application/src/execution-queries'
import type { ExecutionCommandTools, ScheduleReadPort, ScheduledOperationView } from '../../packages/application/src/execution-repositories'
import { createPgExecutionRepositories } from '../../packages/persistence/src/execution-repositories'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import {
  prepareExecutionTestDatabase,
  seedExecutionFixtures,
  seedOrder,
  LOC_LINE_SEMI,
  LOC_LINE_SEMI_CODE,
  LOC_LINE_FIN,
  LOC_LINE_FIN_CODE,
  LOC_NON_LINE,
  LOC_NON_LINE_CODE,
  OWNER_ID,
  OWNER_NAME,
  UOM_M_ID,
  type ExecutionFixtureIds,
} from '../api/execution-test-env'

/**
 * execution 域集成实测（真容器独立库 cadenza_exe，每轮 DROP+CREATE；真实命令总线 + 真实
 * inventory 记账服务组合根，无桩；排程查询经端口注入内存实现——排程并行块未落地）。
 *
 * 八类灵魂证据（WorkItem 冻结）：
 * ① 三入口同规则（同订单同工序从 order/workbench/scan 三入口提交→同一服务端校验与记账，
 *   一例分叉即失败）；② 草稿隔离与跨来源互斥；③ 提交→自动审核→库存余额/订单完成数量/
 * Outbox 三账一致；④ 重复提交幂等；⑤ 超产拒绝；⑥ 投料余量竞争（100m 并发 70/50 恰一成功，
 * 复用库存内核行为经真实命令链）；⑦ 取消审核守卫（产出已入库/被消耗拦截、未入库可撤且
 * 库存逆回）；⑧ 五量分立展示口径。
 */

let pool: pg.Pool
let invBus: ReturnType<typeof buildInventoryCommandBus>
let dbAvailable = true
let adminCtx: CommandContext
let adminAuth: VerifiedAuthContext
let fx: ExecutionFixtureIds
const run = `exe${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

/** 排程内存实现（ScheduleReadPort 窄端口：按设备+日期查排产工序；L0 整合换真实查询）。 */
const scheduleStore = new Map<string, ScheduledOperationView[]>()
const schedulePort: ScheduleReadPort = {
  async listScheduledOperations({ equipmentId }): Promise<ScheduledOperationView[]> {
    return scheduleStore.get(equipmentId) ?? []
  },
}

/** 配置：JZ 部门在「末道自动审核车间」清单（GAP C2：注入配置承载，不编造现场值）。 */
function configOf(autoReview: boolean) {
  return {
    defaultOverrunRatio: null,
    lastOperationAutoReviewDeptIds: autoReview ? [fx.szJzDeptId] : [],
    qcDeptIds: [fx.szQcDeptId],
    consumableMaterialTypes: null,
    defaultOwnerId: OWNER_ID,
    defaultOwnerName: OWNER_NAME,
  }
}

function buildExecutionBus(autoReview: boolean): PgCommandBus {
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
      config: configOf(autoReview),
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

function envelope(
  commandType: string,
  payload: Record<string, unknown>,
  targetId = 'new',
  operationId?: string,
): CommandEnvelope {
  return {
    operationId: operationId ?? `${run}-${commandType}-${Math.random().toString(36).slice(2, 8)}`,
    commandType,
    targetId,
    expectedRevision: 0,
    payload,
  }
}

async function submitReport(
  bus: PgCommandBus,
  payload: Record<string, unknown>,
  operationId?: string,
): Promise<CommandResult> {
  return bus.execute(envelope('execution.report.submit', payload, 'new', operationId), adminCtx)
}

beforeAll(async () => {
  try {
    pool = await prepareExecutionTestDatabase()
  } catch {
    dbAvailable = false
    console.warn('SKIP execution integration: 数据库不可达。请先 docker compose up -d 再重跑。')
    return
  }
  fx = await seedExecutionFixtures(pool)
  invBus = buildInventoryCommandBus(pool)
  const admin = await pool.query<{ id: string; enterprise_id: string; login_name: string }>(
    `SELECT id, enterprise_id, login_name FROM user_account WHERE login_name = 'admin'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  adminAuth = {
    session: { id: 'test', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    user: {
      id: admin.rows[0]!.id,
      loginName: 'admin',
      displayName: '集团管理员',
      enterpriseId: admin.rows[0]!.enterprise_id,
      plantId: '',
      roleId: '',
      loginPlatform: 'WEB',
    },
    role: { id: '', name: '系统管理员', alias: 'sysadmin' },
    permissions: ['execution.read', 'execution.report', 'execution.review', 'execution.feed', 'execution.labor'],
    dataScope: { enterpriseWide: true, plantIds: [] },
  }
})

afterAll(async () => {
  if (pool) await pool.end()
})

function skip(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

/** 收货（真实 inventory 命令链）：投料测试的在制/采购单元。 */
let recvSeq = 0
async function receiveUnit(
  unitNo: string,
  quantity: string,
  locationId: string = LOC_LINE_SEMI,
  locationCode: string = LOC_LINE_SEMI_CODE,
): Promise<string> {
  recvSeq += 1
  const result = await invBus.execute(
    {
      operationId: `${run}-recv-${unitNo}`,
      commandType: 'inventory.receive-goods',
      targetId: 'new',
      expectedRevision: 0,
      payload: {
        plantId: fx.szPlantId,
        lotNo: `LOT-${run}-${unitNo}`,
        unitNo,
        materialId: fx.materialId,
        materialCode: 'MAT-EXE-CU',
        uomId: UOM_M_ID,
        uomCode: 'm',
        quantity,
        measurementBasis: 'nominal',
        locationId,
        locationCode,
        ownerId: OWNER_ID,
        ownerName: OWNER_NAME,
        qualityStatus: 'qualified',
        barcodeValue: `1E${String(recvSeq).padStart(9, '0')}`,
      },
    },
    adminCtx,
  )
  expect(result.status).toBe(CommandResultStatus.COMMITTED)
  return String((result.data as { unitId: string }).unitId)
}

describe('证据① 三入口同规则（同订单同工序，一例分叉即失败）', () => {
  it('order/workbench/scan 三入口提交同一订单同一工序→同一校验与记账形态', async (ctx) => {
    if (skip()) return ctx.skip()
    const bus = buildExecutionBus(true)
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-TRI`,
      plannedQty: '100',
      overrunRatio: '1.1000',
      ops: [
        { seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' },
        { seq: 2, operationDefinitionId: fx.operationDefIds.seq2, deptId: fx.szJzDeptId, offlineQty: '100' },
      ],
    })
    // 扫码入口：设备当天排产工序默认绑定（ScheduleReadPort 内存实现）
    scheduleStore.set('EQ-TRI', [
      {
        orderId: order.orderId,
        orderOperationId: order.operationIds[0]!,
        operationSeq: 1,
        operationDefinitionId: fx.operationDefIds.seq1,
      },
    ])
    const entries: Array<{ source: string; extra: Record<string, unknown> }> = [
      { source: 'order', extra: {} },
      { source: 'workbench', extra: {} },
      { source: 'scan', extra: { equipmentId: 'EQ-TRI', equipmentCode: 'EQ-TRI' } },
    ]
    const results: CommandResult[] = []
    for (const entry of entries) {
      const r = await submitReport(bus, {
        orderId: order.orderId,
        source: entry.source,
        orderOperationId: entry.source === 'scan' ? undefined : order.operationIds[0],
        ...entry.extra,
        outputs: [outputLine('20')],
      })
      results.push(r)
    }
    for (const r of results) {
      expect(r.status).toBe(CommandResultStatus.COMMITTED)
      expect((r.data as { reviewOutcome: string }).reviewOutcome).toBe('auto_approved')
    }
    // 记账形态一致：3 张报工单（来源三值）+ 3 条产出全部转线边库 + 3 条 20 余额
    const reports = await pool.query(
      `SELECT source, review_status FROM production_report WHERE order_id = $1 ORDER BY source`,
      [order.orderId],
    )
    expect(reports.rows.map((r) => r.source).sort()).toEqual(['order', 'scan', 'workbench'])
    expect(reports.rows.every((r) => r.review_status === 'auto_approved')).toBe(true)
    const balances = await pool.query(
      `SELECT b.quantity::text AS q FROM stock_balance b
       JOIN report_output o ON o.stock_unit_id = b.unit_id
       WHERE o.report_id IN (SELECT id FROM production_report WHERE order_id = $1)`,
      [order.orderId],
    )
    expect(balances.rows.map((r) => r.q)).toEqual(['20.0000', '20.0000', '20.0000'])
    // 非末道不回写订单完成数量（A6-5：仅末道非质检审核产出回写）
    const orderRow = await pool.query(`SELECT completed_qty::text AS q FROM production_order WHERE id = $1`, [
      order.orderId,
    ])
    expect(orderRow.rows[0]!.q).toBe('0.0000')
  })

  it('超产硬限从三入口拒绝同一分叉（同规则、同一错误码与文案）', async (ctx) => {
    if (skip()) return ctx.skip()
    const bus = buildExecutionBus(true)
    const rejections: CommandResult[] = []
    for (const source of ['order', 'workbench', 'scan'] as const) {
      const order = await seedOrder(pool, fx, {
        orderNo: `MO-${run}-FORK-${source}`,
        plannedQty: '100',
        overrunRatio: null, // GAP C1 保守默认 1.0000：不允许超产
        ops: [
          { seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' },
          { seq: 2, operationDefinitionId: fx.operationDefIds.seq2, deptId: fx.szJzDeptId, offlineQty: '100' },
        ],
      })
      scheduleStore.set(`EQ-FORK-${source}`, [
        {
          orderId: order.orderId,
          orderOperationId: order.operationIds[0]!,
          operationSeq: 1,
          operationDefinitionId: fx.operationDefIds.seq1,
        },
      ])
      // 前道就绪（op1 提交 100）
      const first = await submitReport(bus, {
        orderId: order.orderId,
        source,
        orderOperationId: order.operationIds[0],
        ...(source === 'scan' ? { equipmentId: `EQ-FORK-${source}`, equipmentCode: `EQ-FORK-${source}` } : {}),
        outputs: [outputLine('100', LOC_LINE_SEMI, LOC_LINE_SEMI_CODE)],
      })
      expect(first.status).toBe(CommandResultStatus.COMMITTED)
      const rejected = await submitReport(bus, {
        orderId: order.orderId,
        source,
        orderOperationId: order.operationIds[1],
        ...(source === 'scan' ? { equipmentId: `EQ-FORK-${source}`, equipmentCode: `EQ-FORK-${source}` } : {}),
        outputs: [outputLine('100.5000', LOC_LINE_FIN, LOC_LINE_FIN_CODE)],
      })
      expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
      rejections.push(rejected)
    }
    // 同一服务端规则零分叉：三入口超产拒绝的错误码与文案逐字一致
    const messages = rejections.map((r) => r.errorMessage)
    expect(rejections.every((r) => r.errorCode === ERROR_CODES.BUSINESS_RULE)).toBe(true)
    expect(new Set(messages).size).toBe(1)
    expect(messages[0]).toContain('A5-1')
  })
})

describe('证据② 草稿隔离键与跨来源互斥（[底稿 A6-2]）', () => {
  it('同操作工+同订单+同来源至多一张未提交；工作台细分到工序；跨来源拒绝', async (ctx) => {
    if (skip()) return ctx.skip()
    const bus = buildExecutionBus(true)
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-ISO`,
      plannedQty: '100',
      ops: [
        { seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' },
        { seq: 2, operationDefinitionId: fx.operationDefIds.seq2, deptId: fx.szJzDeptId, offlineQty: '100' },
      ],
    })
    const save = (payload: Record<string, unknown>) =>
      bus.execute(envelope('execution.session.save', payload), adminCtx)
    const first = await save({
      orderId: order.orderId,
      source: 'order',
      orderOperationId: order.operationIds[0],
      outputs: [outputLine('15')],
    })
    expect(first.status).toBe(CommandResultStatus.DRAFT_SAVED)
    const sessionId = String((first.data as { sessionId: string }).sessionId)
    // 同键续作：复用同一会话（不新建）
    const resume = await save({
      orderId: order.orderId,
      source: 'order',
      orderOperationId: order.operationIds[0],
      outputs: [outputLine('16')],
      remark: '续作',
    })
    expect(resume.status).toBe(CommandResultStatus.DRAFT_SAVED)
    expect(String((resume.data as { sessionId: string }).sessionId)).toBe(sessionId)
    const sessionCount = await pool.query(
      `SELECT count(*)::int AS n FROM execution_session WHERE order_id = $1 AND status = 'open'`,
      [order.orderId],
    )
    expect(sessionCount.rows[0]!.n).toBe(1)
    // 跨来源互斥：存在 order 来源未提交单，workbench 进入拒绝
    const cross = await save({
      orderId: order.orderId,
      source: 'workbench',
      orderOperationId: order.operationIds[0],
    })
    expect(cross.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(cross.errorMessage).toContain('A6-2')
    // 提交后开放；工作台按工序细分：op1/op2 两张草稿并存
    const submitted = await submitReport(bus, {
      sessionId,
      outputs: [outputLine('16')],
    })
    expect(submitted.status).toBe(CommandResultStatus.COMMITTED)
    const wb1 = await save({ orderId: order.orderId, source: 'workbench', orderOperationId: order.operationIds[0] })
    const wb2 = await save({ orderId: order.orderId, source: 'workbench', orderOperationId: order.operationIds[1] })
    expect(wb1.status).toBe(CommandResultStatus.DRAFT_SAVED)
    expect(wb2.status).toBe(CommandResultStatus.DRAFT_SAVED)
    expect(String((wb1.data as { sessionId: string }).sessionId)).not.toBe(
      String((wb2.data as { sessionId: string }).sessionId),
    )
    // 工作台同工序续作复用
    const wb1Again = await save({ orderId: order.orderId, source: 'workbench', orderOperationId: order.operationIds[0] })
    expect(String((wb1Again.data as { sessionId: string }).sessionId)).toBe(
      String((wb1.data as { sessionId: string }).sessionId),
    )
  })
})

describe('证据③ 提交→自动审核→三账一致（库存余额/订单完成数量/Outbox）', () => {
  it('末道自动审核：产出转线边库 + 完成数量回写 + 末道产出推送任务同事务落账', async (ctx) => {
    if (skip()) return ctx.skip()
    const bus = buildExecutionBus(true)
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-ACC`,
      plannedQty: '100',
      overrunRatio: '1.1000',
      ops: [
        { seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' },
        { seq: 2, operationDefinitionId: fx.operationDefIds.seq2, deptId: fx.szJzDeptId, offlineQty: '100' },
      ],
    })
    const op1 = await submitReport(bus, {
      orderId: order.orderId,
      source: 'order',
      orderOperationId: order.operationIds[0],
      outputs: [outputLine('30')],
    })
    expect(op1.status).toBe(CommandResultStatus.COMMITTED)
    const op2 = await submitReport(bus, {
      orderId: order.orderId,
      source: 'order',
      orderOperationId: order.operationIds[1],
      outputs: [outputLine('80', LOC_LINE_FIN, LOC_LINE_FIN_CODE)],
    })
    expect(op2.status).toBe(CommandResultStatus.COMMITTED)
    expect((op2.data as { reviewOutcome: string }).reviewOutcome).toBe('auto_approved')
    // 账一：库存余额（半成品线边库 30 + 成品线边库 80）
    const balances = await pool.query(
      `SELECT l.code, b.quantity::text AS q FROM stock_balance b
       JOIN report_output o ON o.stock_unit_id = b.unit_id
       JOIN production_report r ON r.id = o.report_id
       LEFT JOIN (VALUES ($1::uuid, $2), ($3::uuid, $4)) AS l(id, code) ON l.id = b.location_id
       WHERE r.order_id = $5 ORDER BY l.code`,
      [LOC_LINE_SEMI, LOC_LINE_SEMI_CODE, LOC_LINE_FIN, LOC_LINE_FIN_CODE, order.orderId],
    )
    expect(balances.rows.map((r) => `${r.code}:${r.q}`)).toEqual([`${LOC_LINE_SEMI_CODE}:30.0000`, `${LOC_LINE_FIN_CODE}:80.0000`])
    // 账二：订单完成数量（末道 80 回写；非末道 30 不回写）
    const orderRow = await pool.query(`SELECT completed_qty::text AS q FROM production_order WHERE id = $1`, [
      order.orderId,
    ])
    expect(orderRow.rows[0]!.q).toBe('80.0000')
    // 账三：Outbox 末道产出推送任务（D3：ERP 产出回传 + 上架任务）
    const outbox = await pool.query(
      `SELECT payload->>'operationSeq' AS seq, jsonb_array_length(payload->'stockedUnits') AS units
       FROM outbox
       WHERE aggregate_type = 'production_report' AND task_kind = 'execution.last-operation-output-push'
         AND payload->>'orderId' = $1`,
      [order.orderId],
    )
    expect(outbox.rows.length).toBe(1)
    expect(outbox.rows[0]!.seq).toBe('2')
    expect(outbox.rows[0]!.units).toBe(1)
  })
})

describe('证据④ 重复提交幂等（同 operationId 断响应重放）', () => {
  it('同 operationId 两次提交→同一结果且不重复入账', async (ctx) => {
    if (skip()) return ctx.skip()
    const bus = buildExecutionBus(true)
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-IDEM`,
      plannedQty: '100',
      ops: [{ seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' }],
    })
    const operationId = `${run}-idem`
    const payload = {
      orderId: order.orderId,
      source: 'order',
      orderOperationId: order.operationIds[0],
      outputs: [outputLine('25')],
    }
    const first = await submitReport(bus, payload, operationId)
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const replay = await submitReport(bus, payload, operationId)
    expect(replay).toEqual(first)
    const reports = await pool.query(
      `SELECT count(*)::int AS n FROM production_report WHERE order_id = $1 AND status <> 'deleted'`,
      [order.orderId],
    )
    expect(reports.rows[0]!.n).toBe(1)
    const outputs = await pool.query(
      `SELECT count(*)::int AS n FROM report_output o JOIN production_report r ON r.id = o.report_id
       WHERE r.order_id = $1`,
      [order.orderId],
    )
    const units = await pool.query(
      `SELECT count(*)::int AS n FROM inventory_unit u
       JOIN report_output o ON o.stock_unit_id = u.id
       JOIN production_report r ON r.id = o.report_id
       WHERE r.order_id = $1`,
      [order.orderId],
    )
    expect(outputs.rows[0]!.n).toBe(1)
    expect(units.rows[0]!.n).toBe(1)
    const receipts = await pool.query(
      `SELECT count(*)::int AS n FROM command_receipt WHERE operation_id = $1`,
      [operationId],
    )
    expect(receipts.rows[0]!.n).toBe(1)
  })
})

describe('证据⑤ 超产拒绝（[底稿 A5-1/A5-2]，服务端同单位）', () => {
  it('恰好达到限额放行；超限拒绝；单位不一致拒绝', async (ctx) => {
    if (skip()) return ctx.skip()
    const bus = buildExecutionBus(true)
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-OVR`,
      plannedQty: '100',
      overrunRatio: '1.1000',
      ops: [
        { seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' },
        { seq: 2, operationDefinitionId: fx.operationDefIds.seq2, deptId: fx.szJzDeptId, offlineQty: '100' },
      ],
    })
    await submitReport(bus, {
      orderId: order.orderId,
      source: 'order',
      orderOperationId: order.operationIds[0],
      outputs: [outputLine('100')],
    })
    const atLimit = await submitReport(bus, {
      orderId: order.orderId,
      source: 'order',
      orderOperationId: order.operationIds[1],
      outputs: [outputLine('110', LOC_LINE_FIN, LOC_LINE_FIN_CODE)],
    })
    expect(atLimit.status).toBe(CommandResultStatus.COMMITTED)
    const over = await submitReport(bus, {
      orderId: order.orderId,
      source: 'workbench',
      orderOperationId: order.operationIds[1],
      outputs: [outputLine('0.5000', LOC_LINE_FIN, LOC_LINE_FIN_CODE)],
    })
    expect(over.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(over.errorMessage).toContain('A5-1')
    // A5-2：产出单位与订单单位不一致直接拒绝
    const wrongUom = await submitReport(bus, {
      orderId: order.orderId,
      source: 'order',
      orderOperationId: order.operationIds[0],
      outputs: [
        {
          ...outputLine('1'),
          uomId: '33333333-3333-4333-8333-3333333333c2',
          uomCode: 'KG',
        },
      ],
    })
    expect(wrongUom.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(wrongUom.errorMessage).toContain('A5-2')
  })
})

describe('证据⑥ 投料余量竞争（100m 并发 70/50 恰一成功，复用库存内核行为）', () => {
  it('并发投料 70/50→恰一 COMMITTED、余量不足方 INSUFFICIENT_STOCK；重放不重复扣', async (ctx) => {
    if (skip()) return ctx.skip()
    const bus = buildExecutionBus(true)
    const feedUnitId = await receiveUnit(`U-${run}-FED`, '100')
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-FEED`,
      plannedQty: '100',
      ops: [
        { seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' },
        { seq: 2, operationDefinitionId: fx.operationDefIds.seq2, deptId: fx.szJzDeptId, offlineQty: '100' },
      ],
    })
    const feedPayload = (quantity: string) => ({
      orderId: order.orderId,
      orderOperationId: order.operationIds[0],
      lines: [
        {
          unitId: feedUnitId,
          quantity,
          salesOrderNo: 'SO-9001',
          salesLineNo: '10',
          confirmed: true,
          deviationReason: '测试授权：跨订单半成品投料偏离记录',
        },
      ],
    })
    const [r70, r50] = await Promise.all([
      bus.execute(envelope('execution.feed.submit', feedPayload('70'), 'new', `${run}-feed-70`), adminCtx),
      bus.execute(envelope('execution.feed.submit', feedPayload('50'), 'new', `${run}-feed-50`), adminCtx),
    ])
    const statuses = [r70.status, r50.status].sort()
    expect(statuses).toEqual(['BUSINESS_REJECTION', 'COMMITTED'])
    const rejected = r70.status === 'BUSINESS_REJECTION' ? r70 : r50
    expect(rejected.errorCode).toBe(ERROR_CODES.INSUFFICIENT_STOCK)
    expect(rejected.errorMessage).toContain('IT-14')
    // 账面 = 100 − 成交额（无负库存）；投料行含扣前/扣后（K05 实时余量）
    const balance = await pool.query(`SELECT quantity::text AS q, status FROM stock_balance WHERE unit_id = $1`, [
      feedUnitId,
    ])
    expect(['30.0000', '50.0000']).toContain(balance.rows[0]!.q)
    const consumption = await pool.query(
      `SELECT before_qty::text AS b, after_qty::text AS a, feed_type FROM material_consumption WHERE inventory_unit_id = $1`,
      [feedUnitId],
    )
    expect(consumption.rows.length).toBe(1)
    expect(consumption.rows[0]!.feed_type).toBe('standalone')
    expect(consumption.rows[0]!.b).toBe('100.0000')
    // 被拒命令按原 operationId 重放返回原拒绝；issue 流水恒为 1 行（重试不重复扣）
    const rejectedEnvelope = envelope('execution.feed.submit', feedPayload(rejected === r70 ? '70' : '50'), 'new', rejected.operationId)
    const replay = await bus.execute(rejectedEnvelope, adminCtx)
    expect(replay).toEqual(rejected)
    const issueLines = await pool.query(
      `SELECT count(*)::int AS n FROM stock_transaction WHERE unit_id = $1 AND movement_kind = 'issue'`,
      [feedUnitId],
    )
    expect(issueLines.rows[0]!.n).toBe(1)
    // SAP 投料日志 Outbox（A7-5/K04：消息含真实被消费单元）
    const outbox = await pool.query(
      `SELECT payload::text AS p FROM outbox WHERE task_kind = 'execution.sap-feeding-log' AND payload->>'orderId' = $1`,
      [order.orderId],
    )
    expect(outbox.rows.length).toBe(1)
    expect(outbox.rows[0]!.p).toContain(feedUnitId)
  })
})

describe('证据⑦ 取消审核守卫（K18 对象关系）与库存逆回', () => {
  it('产出已入库（移出线边库）→ 拦截；被消耗 → 拦截；未动 → 可撤且库存逆回+完成数量回退', async (ctx) => {
    if (skip()) return ctx.skip()
    const bus = buildExecutionBus(true)
    const cancel = (reportId: string) =>
      bus.execute(envelope('execution.report.review.cancel', { reason: '撤审测试' }, reportId), adminCtx)

    // (b) 产出已入库（移出目标线边库）→ 拦截
    const orderPutAway = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-CA1`,
      plannedQty: '100',
      ops: [{ seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' }],
    })
    const putAwayReport = await submitReport(bus, {
      orderId: orderPutAway.orderId,
      source: 'order',
      orderOperationId: orderPutAway.operationIds[0],
      outputs: [outputLine('40')],
    })
    const putAwayUnit = String((putAwayReport.data as { stockedUnits: string[] }).stockedUnits[0])
    await invBus.execute(
      {
        operationId: `${run}-move-${putAwayUnit}`,
        commandType: 'inventory.move-stock',
        targetId: 'new',
        expectedRevision: 0,
        payload: {
          unitId: putAwayUnit,
          quantity: '40',
          toLocationId: LOC_NON_LINE,
          toLocationCode: LOC_NON_LINE_CODE,
        },
      },
      adminCtx,
    )
    const blockedPutAway = await cancel(String((putAwayReport.data as { reportId: string }).reportId))
    expect(blockedPutAway.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(blockedPutAway.errorMessage).toContain('已入库')

    // (c) 产出已被消耗 → 拦截
    const orderConsumed = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-CA2`,
      plannedQty: '100',
      ops: [{ seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' }],
    })
    const consumedReport = await submitReport(bus, {
      orderId: orderConsumed.orderId,
      source: 'order',
      orderOperationId: orderConsumed.operationIds[0],
      outputs: [outputLine('40')],
    })
    const consumedUnit = String((consumedReport.data as { stockedUnits: string[] }).stockedUnits[0])
    const feedOrder = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-CA2F`,
      plannedQty: '100',
      ops: [{ seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' }],
    })
    const feedResult = await bus.execute(
      envelope('execution.feed.submit', {
        orderId: feedOrder.orderId,
        orderOperationId: feedOrder.operationIds[0],
        lines: [
          {
            unitId: consumedUnit,
            quantity: '30',
            salesOrderNo: 'SO-9002',
            salesLineNo: '10',
            confirmed: true,
            deviationReason: '测试：跨订单半成品投料',
          },
        ],
      }),
      adminCtx,
    )
    expect(feedResult.status).toBe(CommandResultStatus.COMMITTED)
    const blockedConsumed = await cancel(String((consumedReport.data as { reportId: string }).reportId))
    expect(blockedConsumed.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(blockedConsumed.errorMessage).toContain('被消耗')

    // (a) 未入库未消耗 → 可撤：库存逆回（reverse 流水+零余额关闭+单元耗尽）+ 完成数量回退 + 回待审
    const orderReversible = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-CA3`,
      plannedQty: '100',
      overrunRatio: '1.1000',
      ops: [
        { seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' },
        { seq: 2, operationDefinitionId: fx.operationDefIds.seq2, deptId: fx.szJzDeptId, offlineQty: '100' },
      ],
    })
    await submitReport(bus, {
      orderId: orderReversible.orderId,
      source: 'order',
      orderOperationId: orderReversible.operationIds[0],
      outputs: [outputLine('100')],
    })
    const lastReport = await submitReport(bus, {
      orderId: orderReversible.orderId,
      source: 'order',
      orderOperationId: orderReversible.operationIds[1],
      outputs: [outputLine('50', LOC_LINE_FIN, LOC_LINE_FIN_CODE)],
    })
    const reversibleUnit = String((lastReport.data as { stockedUnits: string[] }).stockedUnits[0])
    const before = await pool.query(`SELECT completed_qty::text AS q FROM production_order WHERE id = $1`, [
      orderReversible.orderId,
    ])
    expect(before.rows[0]!.q).toBe('50.0000')
    const cancelled = await cancel(String((lastReport.data as { reportId: string }).reportId))
    expect(cancelled.status).toBe(CommandResultStatus.COMMITTED)
    const balanceRow = await pool.query(`SELECT quantity::text AS q, status FROM stock_balance WHERE unit_id = $1`, [
      reversibleUnit,
    ])
    expect(balanceRow.rows[0]!.q).toBe('0.0000')
    expect(balanceRow.rows[0]!.status).toBe('closed')
    const unitRow = await pool.query(`SELECT status, balance_open FROM inventory_unit WHERE id = $1`, [reversibleUnit])
    expect(unitRow.rows[0]!.status).toBe('exhausted')
    expect(unitRow.rows[0]!.balance_open).toBe(false)
    const reverseLine = await pool.query(
      `SELECT before_qty::text AS b, after_qty::text AS a FROM stock_transaction
       WHERE unit_id = $1 AND movement_kind = 'reverse'`,
      [reversibleUnit],
    )
    expect(reverseLine.rows[0]!.b).toBe('50.0000')
    expect(reverseLine.rows[0]!.a).toBe('0.0000')
    const afterOrder = await pool.query(`SELECT completed_qty::text AS q FROM production_order WHERE id = $1`, [
      orderReversible.orderId,
    ])
    expect(afterOrder.rows[0]!.q).toBe('0.0000')
    const reportRow = await pool.query(
      `SELECT review_status, review_cancelled_at FROM production_report WHERE id = $1`,
      [(lastReport.data as { reportId: string }).reportId],
    )
    expect(reportRow.rows[0]!.review_status).toBe('pending_review')
    expect(reportRow.rows[0]!.review_cancelled_at).not.toBeNull()
    // 对外冲销事件（D3）
    const outbox = await pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE task_kind = 'execution.review-cancelled'
         AND payload->>'reportId' = $1`,
      [(lastReport.data as { reportId: string }).reportId],
    )
    expect(outbox.rows[0]!.n).toBe(1)
  })
})

describe('证据⑧ 五量分立展示口径（[底稿 A5-3/S02]）+ 审核与守卫补证', () => {
  it('草稿/提交/审核/合格/入库分别计数；人工审核统一动作；删除守卫', async (ctx) => {
    if (skip()) return ctx.skip()
    const busPending = buildExecutionBus(false)
    const queries = new ExecutionQueryService({
      execution: createPgExecutionRepositories(pool),
      process: createPgProcessRepositories(pool),
      qcDeptIds: [fx.szQcDeptId],
    })
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-QTY`,
      plannedQty: '1000',
      overrunRatio: '1.1000',
      ops: [
        { seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '1000' },
        { seq: 2, operationDefinitionId: fx.operationDefIds.seq2, deptId: fx.szJzDeptId, offlineQty: '1000' },
      ],
    })
    // 草稿 10（未提交；szqc01 操作工的工作台末道草稿——跨操作工不触发互斥，五量分立可见）
    const szqc = await pool.query<{ id: string }>(`SELECT id FROM user_account WHERE login_name = 'szqc01'`)
    const draft = await busPending.execute(
      envelope('execution.session.save', {
        orderId: order.orderId,
        source: 'workbench',
        orderOperationId: order.operationIds[1],
        operatorUserId: szqc.rows[0]!.id,
        outputs: [outputLine('10', LOC_LINE_FIN, LOC_LINE_FIN_CODE)],
      }),
      adminCtx,
    )
    expect(draft.status).toBe(CommandResultStatus.DRAFT_SAVED)
    // 非末道提交 20 → 自动审核（非末道一律 auto_approved；无论车间配置）
    await submitReport(busPending, {
      orderId: order.orderId,
      source: 'order',
      orderOperationId: order.operationIds[0],
      outputs: [outputLine('20')],
    })
    // 末道提交 30 → 末道不在自动审核车间配置 → 待审（扫码入口：设备排产默认工序）
    scheduleStore.set('EQ-QTY', [
      {
        orderId: order.orderId,
        orderOperationId: order.operationIds[1]!,
        operationSeq: 2,
        operationDefinitionId: fx.operationDefIds.seq2,
      },
    ])
    const pending = await submitReport(busPending, {
      orderId: order.orderId,
      source: 'scan',
      equipmentId: 'EQ-QTY',
      equipmentCode: 'EQ-QTY',
      outputs: [outputLine('30', LOC_LINE_FIN, LOC_LINE_FIN_CODE)],
    })
    expect((pending.data as { reviewOutcome: string }).reviewOutcome).toBe('pending_review')
    // 五量分立
    const quantities = await queries.orderQuantities(adminAuth, order.orderId)
    const view = quantities as {
      total: Record<'draftQty' | 'submittedQty' | 'approvedQty' | 'qualifiedQty' | 'stockedQty', string>
    }
    expect(view.total).toEqual({
      draftQty: '10.0000',
      submittedQty: '30.0000',
      approvedQty: '20.0000',
      qualifiedQty: '20.0000',
      stockedQty: '20.0000',
    })
    // 人工审核统一动作（A6-5：与自动审核同一 Posting 路径）
    const reportId = String((pending.data as { reportId: string }).reportId)
    const manual = await busPending.execute(envelope('execution.report.review', {}, reportId), adminCtx)
    expect(manual.status).toBe(CommandResultStatus.COMMITTED)
    expect((manual.data as { reviewStatus: string }).reviewStatus).toBe('manual_approved')
    const completed = await pool.query(`SELECT completed_qty::text AS q FROM production_order WHERE id = $1`, [
      order.orderId,
    ])
    expect(completed.rows[0]!.q).toBe('30.0000')
    // 删除守卫：待审可删（先建一张待审末道单）；已审核单拒绝（K17 走冲销）
    const pending2 = await submitReport(busPending, {
      orderId: order.orderId,
      source: 'workbench',
      orderOperationId: order.operationIds[1],
      outputs: [outputLine('5', LOC_LINE_FIN, LOC_LINE_FIN_CODE)],
    })
    const deletableId = String((pending2.data as { reportId: string }).reportId)
    const deleted = await busPending.execute(envelope('execution.report.delete', { reason: '删除测试' }, deletableId), adminCtx)
    expect(deleted.status).toBe(CommandResultStatus.COMMITTED)
    const deletedRow = await pool.query(`SELECT status FROM production_report WHERE id = $1`, [deletableId])
    expect(deletedRow.rows[0]!.status).toBe('deleted')
    const blockedDelete = await busPending.execute(envelope('execution.report.delete', {}, reportId), adminCtx)
    expect(blockedDelete.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(blockedDelete.errorMessage).toContain('K17')
    // 工时记录（A6-5）
    const labor = await busPending.execute(
      envelope('execution.labor.record', {
        orderId: order.orderId,
        orderOperationId: order.operationIds[0],
        hours: '7.50',
        note: '白班',
      }),
      adminCtx,
    )
    expect(labor.status).toBe(CommandResultStatus.COMMITTED)
    const laborRows = await pool.query(`SELECT hours::text AS h FROM labor_record WHERE order_id = $1`, [
      order.orderId,
    ])
    expect(laborRows.rows[0]!.h).toBe('7.50')
  })
})

describe('证据⑨ 投料线边判定（D-1 回归：仓库类型主数据事实，非配置库位清单）', () => {
  it('LINE_SIDE 仓在库合格单元投料成功（实时扣减 + 扣前/扣后流水）', async (ctx) => {
    if (skip()) return ctx.skip()
    const bus = buildExecutionBus(true)
    const unitId = await receiveUnit(`U-${run}-LSOK`, '60') // 默认收至 LOC_LINE_SEMI（LINE_SIDE 仓）
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-LSOK`,
      plannedQty: '100',
      ops: [{ seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' }],
    })
    const feed = await bus.execute(
      envelope('execution.feed.submit', {
        orderId: order.orderId,
        orderOperationId: order.operationIds[0],
        lines: [
          {
            unitId,
            quantity: '10',
            salesOrderNo: 'SO-9003',
            salesLineNo: '10',
            confirmed: true,
            deviationReason: 'D-1 回归：跨订单半成品投料偏离记录',
          },
        ],
      }),
      adminCtx,
    )
    expect(feed.status).toBe(CommandResultStatus.COMMITTED)
    const consumption = await pool.query(
      `SELECT before_qty::text AS b, after_qty::text AS a, feed_type FROM material_consumption WHERE inventory_unit_id = $1`,
      [unitId],
    )
    expect(consumption.rows).toHaveLength(1)
    expect(consumption.rows[0]!.b).toBe('60.0000')
    expect(consumption.rows[0]!.a).toBe('50.0000')
    const balance = await pool.query(`SELECT quantity::text AS q FROM stock_balance WHERE unit_id = $1 AND status='active'`, [
      unitId,
    ])
    expect(balance.rows[0]!.q).toBe('50.0000')
  })

  it('WAREHOUSE 仓在库合格单元投料拒绝（[A7-2] 线边链步，非线边库位不放行）', async (ctx) => {
    if (skip()) return ctx.skip()
    const bus = buildExecutionBus(true)
    const unitId = await receiveUnit(`U-${run}-WHREJ`, '60', LOC_NON_LINE, LOC_NON_LINE_CODE) // WAREHOUSE 仓库位
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-WHREJ`,
      plannedQty: '100',
      ops: [{ seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' }],
    })
    const rejected = await bus.execute(
      envelope('execution.feed.submit', {
        orderId: order.orderId,
        orderOperationId: order.operationIds[0],
        lines: [
          {
            unitId,
            quantity: '10',
            salesOrderNo: 'SO-9004',
            salesLineNo: '10',
            confirmed: true,
            deviationReason: 'D-1 回归：非线边库位单元应被拒',
          },
        ],
      }),
      adminCtx,
    )
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorMessage).toContain('A7-2')
    expect(rejected.errorMessage).toContain('线边库')
    // 拒绝零写入：无投料行、无 issue 流水、余额不动
    const consumption = await pool.query(
      `SELECT count(*)::int AS n FROM material_consumption WHERE inventory_unit_id = $1`,
      [unitId],
    )
    expect(consumption.rows[0]!.n).toBe(0)
    const balance = await pool.query(`SELECT quantity::text AS q FROM stock_balance WHERE unit_id = $1 AND status='active'`, [
      unitId,
    ])
    expect(balance.rows[0]!.q).toBe('60.0000')
  })
})

describe('R2 回归：同一命令回执下多行过账行号唯一（多行投料 + 多产出行末道审核）', () => {
  // R2 缺陷回归：execution 域多行投料/多产出行审核在同一命令回执下过账行号均缺省 1，
  // 撞 stock_transaction_line_unique（command_receipt_id, line_no）唯一约束 → 500。
  // 修复：issueMaterial 支持载荷 lineNo；投料循环与审核产出循环逐行传入行号。

  it('两行投料一次提交：两条 consumption + 两条 issue 流水（行号 1/2），余额各扣减', async (ctx) => {
    if (skip()) return ctx.skip()
    const bus = buildExecutionBus(true)
    const u1 = await receiveUnit(`U-${run}-MLF1`, '30')
    const u2 = await receiveUnit(`U-${run}-MLF2`, '40')
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-MLF`,
      plannedQty: '100',
      ops: [{ seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '100' }],
    })
    const r = await bus.execute(
      envelope(
        'execution.feed.submit',
        {
          orderId: order.orderId,
          orderOperationId: order.operationIds[0],
          lines: [
            { unitId: u1, quantity: '30', salesOrderNo: 'SO-MLF', salesLineNo: '10', confirmed: true, deviationReason: 'R2 回归多行投料 1' },
            { unitId: u2, quantity: '40', salesOrderNo: 'SO-MLF', salesLineNo: '20', confirmed: true, deviationReason: 'R2 回归多行投料 2' },
          ],
        },
        'new',
        `${run}-feed-mlf`,
      ),
      adminCtx,
    )
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const consumptions = await pool.query(
      `SELECT count(*)::int AS n FROM material_consumption WHERE inventory_unit_id = ANY($1::uuid[])`,
      [[u1, u2]],
    )
    expect(consumptions.rows[0]!.n).toBe(2)
    // 同一命令回执下 issue 流水行号 1/2（修复前第二条撞唯一约束 → 500）
    const lines = await pool.query<{ line_no: number }>(
      `SELECT line_no FROM stock_transaction
       WHERE unit_id = ANY($1::uuid[]) AND movement_kind = 'issue'
       ORDER BY line_no`,
      [[u1, u2]],
    )
    expect(lines.rows.map((l) => l.line_no)).toEqual([1, 2])
  })

  it('末道三产出行报工人工审核：三单元全部转线边库，completedQty 一次性回写', async (ctx) => {
    if (skip()) return ctx.skip()
    const bus = buildExecutionBus(false)
    const order = await seedOrder(pool, fx, {
      orderNo: `MO-${run}-MLO`,
      plannedQty: '90',
      ops: [
        { seq: 1, operationDefinitionId: fx.operationDefIds.seq1, deptId: fx.szJzDeptId, offlineQty: '90' },
        { seq: 2, operationDefinitionId: fx.operationDefIds.seq2, deptId: fx.szJzDeptId, offlineQty: '90' },
      ],
    })
    // 前道就绪（A6-3）：seq=1 先报产出 90（非末道自动审核）
    await submitReport(bus, {
      orderId: order.orderId,
      source: 'order',
      orderOperationId: order.operationIds[0],
      outputs: [outputLine('90')],
    })
    scheduleStore.set('EQ-MLO', [
      {
        orderId: order.orderId,
        orderOperationId: order.operationIds[1]!,
        operationSeq: 2,
        operationDefinitionId: fx.operationDefIds.seq2,
      },
    ])
    const pending = await submitReport(bus, {
      orderId: order.orderId,
      source: 'scan',
      equipmentId: 'EQ-MLO',
      equipmentCode: 'EQ-MLO',
      outputs: [
        outputLine('30', LOC_LINE_FIN, LOC_LINE_FIN_CODE),
        outputLine('30', LOC_LINE_FIN, LOC_LINE_FIN_CODE),
        outputLine('30', LOC_LINE_FIN, LOC_LINE_FIN_CODE),
      ],
    })
    expect((pending.data as { reviewOutcome: string }).reviewOutcome).toBe('pending_review')
    const reportId = String((pending.data as { reportId: string }).reportId)
    const manual = await bus.execute(envelope('execution.report.review', {}, reportId), adminCtx)
    expect(manual.status).toBe(CommandResultStatus.COMMITTED)
    expect((manual.data as { reviewStatus: string }).reviewStatus).toBe('manual_approved')
    expect((manual.data as { stockedUnits: string[] }).stockedUnits).toHaveLength(3)
    const completed = await pool.query(`SELECT completed_qty::text AS q FROM production_order WHERE id = $1`, [
      order.orderId,
    ])
    expect(completed.rows[0]!.q).toBe('90.0000')
  })
})
