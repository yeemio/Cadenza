import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { VerifiedAuthContext } from '@cadenza/application'
import { createPgReportingRepositories } from '../../packages/persistence/src/reporting-repositories'
import { buildReportingCommandBus, buildReportingQueryService } from '../../apps/api/src/reporting/reporting.composition'
import { RPT_SHIFT_DATE, RPT_TEST_DB_NAME, prepareRptTestDatabase, seedRptFixtures, type RptFixtures } from '../api/reporting-test-env'

/**
 * reporting 域集成证据（P2-F / T20 只读投影；独立库 cadenza_reporting，0016 程序式应用）：
 * - RP-S1~S3：三投影表存在 + 指标定义 referenced 守卫（库级 trigger）；
 * - RP-01/03/04/05/07：投影重建口径（采购收货码同键多余额聚合 / 生产码订单工序分键）、
 *   英尺截取展示列、成品入库状态推导与筛选、勾选汇总服务端聚合、重建幂等且零业务写入；
 * - RP-18~21：班次日并集（行自带优先）、快照幂等键覆盖、指标值与原单据逐笔对账（RP-22）、
 *   缺失分母保留标记（不以 0 冒充）；
 * - RP-19/S3：同 key 同版本拒绝注册、referenced 单向闩锁；
 * - RP-22/IT-35：谱系正反向追溯。
 */

let pool: pg.Pool
let fx: RptFixtures
let dbAvailable = true

beforeAll(async () => {
  try {
    pool = await prepareRptTestDatabase()
    fx = await seedRptFixtures(pool)
  } catch (error) {
    dbAvailable = false
    console.warn(
      `SKIP reporting integration: 测试库准备失败（${error instanceof Error ? error.message : String(error)}）。独立库 ${RPT_TEST_DB_NAME}。`,
    )
  }
})

afterAll(async () => {
  if (pool) await pool.end()
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

const adminContext = (): { actorUserId: string; actorLoginName: string; enterpriseId: string } => ({
  actorUserId: fx.adminUserId,
  actorLoginName: 'admin',
  enterpriseId: fx.enterpriseId,
})

function envelope(operationId: string, commandType: string, payload: Record<string, unknown>) {
  return { operationId, commandType, targetId: 'reporting', expectedRevision: 0 as const, payload }
}

describe('RP-S1~S3 投影表与库级守卫（迁移 0016 程序式应用）', () => {
  it('三投影表存在且 0016 已记录（不进共享 registry，程序式应用）', async () => {
    if (skipIfNoDb()) return
    const v = await pool.query(`SELECT version FROM schema_migrations WHERE version = '0016'`)
    expect(v.rowCount).toBe(1)
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('stock_stat_projection','shift_snapshot','metric_definition_revision')`,
    )
    expect(new Set(tables.rows.map((r) => r.table_name as string))).toEqual(
      new Set(['stock_stat_projection', 'shift_snapshot', 'metric_definition_revision']),
    )
  })

  it('RP-S3：referenced 行核心列修改/删除被库级守卫拒绝（单向闩锁）', async () => {
    if (skipIfNoDb()) return
    const bus = buildReportingCommandBus(pool)
    const registered = await bus.execute(
      envelope('rpt-it-def-register-guard', 'reporting.metric-definition.register', { metricKeys: ['*'] }),
      adminContext(),
    )
    expect(registered.status).toBe('COMMITTED')
    const defs = createPgReportingRepositories(pool)
    const wip = (await defs.definitions.listAll()).find((d) => d.metricKey === 'wip.quantity')
    expect(wip).toBeDefined()
    await defs.definitions.markReferenced(wip!.id)
    await expect(
      pool.query(`UPDATE metric_definition_revision SET uom_code = 'PCS' WHERE id = $1`, [wip!.id]),
    ).rejects.toThrow(/RP-S3/)
    await expect(pool.query(`DELETE FROM metric_definition_revision WHERE id = $1`, [wip!.id])).rejects.toThrow(/RP-S3/)
  })
})

describe('RP-01/03/04 库存统计投影口径', () => {
  it('RP-01：采购收货码同键多余额行聚合为一条（300+200=500）；生产码按订单+工序分键', async () => {
    if (skipIfNoDb()) return
    const bus = buildReportingCommandBus(pool)
    const r = await bus.execute(
      envelope('rpt-it-rebuild-1', 'reporting.stock-stat.rebuild', {}),
      adminContext(),
    )
    expect(r.status).toBe('COMMITTED')
    expect((r.data as { rowsProjected: number }).rowsProjected).toBe(5)

    const rep = createPgReportingRepositories(pool)
    const page = await rep.projections.listPaged({ plantIds: null, page: 1, pageSize: 50 })
    expect(page.total).toBe(5)

    const purchaseP01 = page.items.filter((i) => i.unitNo === 'RPT-P01')
    expect(purchaseP01).toHaveLength(1) // 同键两余额行 → 一条统计结果（列表不做二次聚合已由聚合承载）
    expect(purchaseP01[0]!.statKind).toBe('purchase_receive')
    expect(purchaseP01[0]!.statKindLabel).toBe('采购收货码')
    expect(purchaseP01[0]!.lotNo).toBe('LOT-RPT-P1')
    expect(purchaseP01[0]!.supplierLotNo).toBe('SUP-A')
    expect(purchaseP01[0]!.quantity).toBe('500.0000')
    expect(purchaseP01[0]!.uomCode).toBe('KG')
    expect(purchaseP01[0]!.inboundDate?.startsWith('2026-10-10')).toBe(true) // receive 流水最大业务时间（展示列）
    expect(purchaseP01[0]!.outboundDate?.startsWith('2026-10-15')).toBe(true) // issue 流水最大业务时间

    const frozen = page.items.find((i) => i.unitNo === 'RPT-P02')
    expect(frozen!.stockStatus).toBe('frozen')
    expect(frozen!.stockStatusLabel).toBe('冻结') // legacy 字典并存标注（RP-02/GAP-A7）
    expect(frozen!.finishedEntryStatus).toBeNull() // RP-04：库存状态非正常 → 入库状态空

    // 生产码同轴双订单分键（RP-01：轴号+订单+工序）
    const f01 = page.items.filter((i) => i.unitNo === 'RPT-F01')
    expect(f01).toHaveLength(2)
    expect(new Set(f01.map((i) => i.orderNo))).toEqual(new Set(['PO-RPT-2401', 'PO-RPT-2402']))
    for (const row of f01) expect(row.operationSeq).toBe(10)

    // 无报工生产轴不入生产码投影（键含订单；RP-01）
    expect(page.items.some((i) => i.unitNo === 'RPT-F03')).toBe(false)
    expect(page.items.some((i) => i.unitNo === 'RPT-F04')).toBe(false)
  })

  it('RP-03：英尺=数量÷0.3048 定点截取 4 位（304.8→1000.0000；100→328.0839）；非米 null', async () => {
    if (skipIfNoDb()) return
    const rep = createPgReportingRepositories(pool)
    const page = await rep.projections.listPaged({ plantIds: null, page: 1, pageSize: 50 })
    expect(page.items.find((i) => i.unitNo === 'RPT-F02')!.feetQuantity).toBe('1000.0000')
    for (const row of page.items.filter((i) => i.unitNo === 'RPT-F01')) expect(row.feetQuantity).toBe('328.0839')
    expect(page.items.find((i) => i.unitNo === 'RPT-P01')!.feetQuantity).toBeNull()
  })

  it('RP-04：成品入库状态推导（正常+仓库=已入库 / 正常+线边仓=未入库）与筛选联动', async () => {
    if (skipIfNoDb()) return
    const rep = createPgReportingRepositories(pool)
    const f02 = (await rep.projections.listPaged({ plantIds: null, page: 1, pageSize: 50 })).items.find((i) => i.unitNo === 'RPT-F02')
    expect(f02!.reportWarehouseKind).toBe('WAREHOUSE')
    expect(f02!.finishedEntryStatus).toBe('entered_warehouse')
    expect(f02!.finishedEntryStatusLabel).toBe('成品已入库')

    const f01 = (await rep.projections.listPaged({ plantIds: null, page: 1, pageSize: 50 })).items.filter((i) => i.unitNo === 'RPT-F01')
    for (const row of f01) {
      expect(row.reportWarehouseKind).toBe('LINE_SIDE')
      expect(row.finishedEntryStatus).toBe('not_entered')
    }

    // 筛选：已入库 → 仅 F02；未入库 → 仅 F01 两行；冻结轴两者皆不命中（同时限定库存状态=正常）
    const entered = await rep.projections.listPaged({
      plantIds: null, page: 1, pageSize: 50, finishedEntryStatus: 'entered_warehouse',
    })
    expect(entered.total).toBe(1)
    expect(entered.items[0]!.unitNo).toBe('RPT-F02')
    const notEntered = await rep.projections.listPaged({
      plantIds: null, page: 1, pageSize: 50, finishedEntryStatus: 'not_entered',
    })
    expect(notEntered.total).toBe(2)
    expect(new Set(notEntered.items.map((i) => i.unitNo))).toEqual(new Set(['RPT-F01']))
  })

  it('RP-05：勾选汇总服务端全量聚合（按单位分组累加；未勾选总量 0）', async () => {
    if (skipIfNoDb()) return
    const service = buildReportingQueryService(pool)
    const auth: VerifiedAuthContext = {
      session: { id: 'rpt-it', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      user: {
        id: fx.adminUserId,
        loginName: 'admin',
        displayName: '集团管理员',
        enterpriseId: fx.enterpriseId,
        plantId: '',
        roleId: '',
        loginPlatform: 'WEB',
      },
      role: { id: '', name: '系统管理员', alias: 'sysadmin' },
      permissions: ['reporting.read'],
      dataScope: { enterpriseWide: true, plantIds: [] },
    }
    const page = await createPgReportingRepositories(pool).projections.listPaged({ plantIds: null, page: 1, pageSize: 50 })
    const p01 = page.items.find((i) => i.unitNo === 'RPT-P01')!
    const f02 = page.items.find((i) => i.unitNo === 'RPT-F02')!

    const summary = await service.selectionSummary(auth, [f02.statId, p01.statId])
    expect(summary.totalRows).toBe(2)
    expect(summary.groups).toEqual([
      { uomCode: 'KG', uomLabel: 'KG', totalQuantity: '500.0000' },
      { uomCode: 'M', uomLabel: 'M', totalQuantity: '304.8000' },
    ])

    const empty = await service.selectionSummary(auth, [])
    expect(empty).toEqual({ groups: [], totalRows: 0 })
  })
})

describe('RP-07 投影重建幂等且零业务写入', () => {
  it('同载荷命令重放返回原结果；重建前后业务表行数与 updated_at 不变（不重新执行报工/扣库存）', async () => {
    if (skipIfNoDb()) return
    const bus = buildReportingCommandBus(pool)
    const before = await businessFingerprint()
    const first = await bus.execute(envelope('rpt-it-rebuild-idem', 'reporting.stock-stat.rebuild', {}), adminContext())
    expect(first.status).toBe('COMMITTED')
    const replay = await bus.execute(envelope('rpt-it-rebuild-idem', 'reporting.stock-stat.rebuild', {}), adminContext())
    expect(replay.status).toBe('COMMITTED')
    expect(replay.data).toEqual(first.data) // 同 operationId 原样回放（幂等合同）

    const again = await bus.execute(envelope('rpt-it-rebuild-idem-2', 'reporting.stock-stat.rebuild', {}), adminContext())
    expect((again.data as { rowsProjected: number }).rowsProjected).toBe(5)
    const after = await businessFingerprint()
    expect(after).toEqual(before) // 业务表零写入（RP-07：重建不重新执行报工或扣库存）

    const count = await pool.query(`SELECT count(*)::int AS n FROM stock_stat_projection`)
    expect(count.rows[0]!.n).toBe(5) // 全量重建不产生重复行
  })
})

describe('RP-18~22 班次快照、指标对账与追溯', () => {
  it('RP-18：班次日并集=报工/投料自带 shift_date ∪ 流水业务时间折算（行自带优先）', async () => {
    if (skipIfNoDb()) return
    const rep = createPgReportingRepositories(pool)
    const dates = await rep.facts.listShiftDates(fx.szPlantId)
    expect(dates).toEqual(['2026-10-10', '2026-10-15', '2026-10-19', '2026-10-20', '2026-10-21'])
  })

  it('RP-19/20/22：四族快照数值与原单据逐笔对账一致（wip/yield/loss/delivery）', async () => {
    if (skipIfNoDb()) return
    const bus = buildReportingCommandBus(pool)
    const r = await bus.execute(
      envelope('rpt-it-snap-sz', 'reporting.shift-snapshot.rebuild', { plantId: fx.szPlantId, shiftDate: RPT_SHIFT_DATE }),
      adminContext(),
    )
    expect(r.status).toBe('COMMITTED')
    const data = r.data as { snapshots: number; ok: number; denominatorMissing: number; failed: number }
    expect(data).toEqual({ snapshots: 4, ok: 4, denominatorMissing: 0, failed: 0, shiftDates: 1 })

    const rep = createPgReportingRepositories(pool)
    const page = await rep.snapshots.listPaged({ plantIds: null, plantId: fx.szPlantId, page: 1, pageSize: 50 })
    expect(page.total).toBe(4)
    const byKey = new Map(page.items.map((s) => [s.metricKey, s]))

    // 对账锚点（RP-22）：与原单据直查逐笔一致
    const wipDirect = await pool.query(
      `SELECT COALESCE(sum(b.quantity),0)::text AS v FROM stock_balance b
       JOIN inventory_unit u ON u.id = b.unit_id AND u.status = 'in_production'
       WHERE b.status = 'active' AND b.uom_code = 'KG' AND b.plant_id = $1`,
      [fx.szPlantId],
    )
    expect(byKey.get('wip.quantity')!.value).toBe('80.0000')
    expect(byKey.get('wip.quantity')!.numeratorValue).toBe(wipDirect.rows[0]!.v)

    const outputDirect = await pool.query(
      `SELECT sum(ro.quantity)::text AS qty, sum(ro.qualified_qty)::text AS qual
       FROM report_output ro JOIN production_report pr ON pr.id = ro.report_id
       WHERE pr.plant_id = $1 AND pr.status = 'submitted'
         AND pr.review_status IN ('auto_approved','manual_approved') AND pr.shift_date = $2 AND ro.uom_code = 'M'`,
      [fx.szPlantId, RPT_SHIFT_DATE],
    )
    expect(byKey.get('yield.qualified-rate')!.numeratorValue).toBe(outputDirect.rows[0]!.qual)
    expect(byKey.get('yield.qualified-rate')!.denominatorValue).toBe(outputDirect.rows[0]!.qty)
    expect(byKey.get('yield.qualified-rate')!.value).toBe('100.0000') // 250/250
    expect(byKey.get('yield.qualified-rate')!.sourceRows).toBe(2) // R1+R4 两行（对账行数锚点）

    const consumptionDirect = await pool.query(
      `SELECT COALESCE(sum(quantity),0)::text AS v FROM material_consumption
       WHERE plant_id = $1 AND COALESCE(shift_date, (business_time AT TIME ZONE 'Asia/Shanghai')::date) = $2`,
      [fx.szPlantId, RPT_SHIFT_DATE],
    )
    expect(consumptionDirect.rows[0]!.v).toBe('500.0000')
    expect(byKey.get('loss.consumption-gap-rate')!.value).toBe('50.0000') // (500-250)/500

    const finishDirect = await pool.query(
      `SELECT count(*) FILTER (WHERE actual_finish_at <= planned_finish_at)::int AS ontime, count(*)::int AS fin
       FROM production_order WHERE plant_id = $1 AND actual_finish_at IS NOT NULL`,
      [fx.szPlantId],
    )
    expect(finishDirect.rows[0]).toEqual({ ontime: 1, fin: 2 })
    expect(byKey.get('delivery.ontime-rate')!.value).toBe('50.0000')

    // RP-19：快照引用后定义 referenced 置位（S3 单向闩锁的入口）
    const defs = await rep.definitions.listAll()
    expect(defs.filter((d) => d.referenced).length).toBe(4)
  })

  it('RP-S2：重算覆盖同幂等键，不产生重复行', async () => {
    if (skipIfNoDb()) return
    const bus = buildReportingCommandBus(pool)
    const again = await bus.execute(
      envelope('rpt-it-snap-sz-2', 'reporting.shift-snapshot.rebuild', { plantId: fx.szPlantId, shiftDate: RPT_SHIFT_DATE }),
      adminContext(),
    )
    expect(again.status).toBe('COMMITTED')
    const count = await pool.query(
      `SELECT count(*)::int AS n FROM shift_snapshot WHERE plant_id = $1 AND shift_date = $2`,
      [fx.szPlantId, RPT_SHIFT_DATE],
    )
    expect(count.rows[0]!.n).toBe(4)
  })

  it('RP-21：分母缺失（空厂）保留缺失标记与原因，value 为空不以 0 冒充', async () => {
    if (skipIfNoDb()) return
    const bus = buildReportingCommandBus(pool)
    const r = await bus.execute(
      envelope('rpt-it-snap-hf', 'reporting.shift-snapshot.rebuild', { plantId: fx.hfPlantId, shiftDate: RPT_SHIFT_DATE }),
      adminContext(),
    )
    expect(r.status).toBe('COMMITTED')
    const data = r.data as { ok: number; denominatorMissing: number }
    expect(data).toEqual({ snapshots: 4, ok: 1, denominatorMissing: 3, failed: 0, shiftDates: 1 })

    const rep = createPgReportingRepositories(pool)
    const page = await rep.snapshots.listPaged({ plantIds: null, plantId: fx.hfPlantId, page: 1, pageSize: 50 })
    expect(page.total).toBe(4)
    const wip = page.items.find((s) => s.metricKey === 'wip.quantity')!
    expect(wip.status).toBe('ok')
    expect(wip.value).toBe('0.0000') // 单边量：事实集无行=真实 0（≠分母缺失）
    for (const key of ['yield.qualified-rate', 'loss.consumption-gap-rate', 'delivery.ontime-rate']) {
      const row = page.items.find((s) => s.metricKey === key)!
      expect(row.status).toBe('denominator_missing')
      expect(row.value).toBeNull()
      expect(row.missingReason).toContain('[RP-21]')
      expect(row.missingReason).toContain(key)
    }
  })

  it('RP-19：同 key 同版本重复注册拒绝；未知事实集键拒绝（均带规则码）', async () => {
    if (skipIfNoDb()) return
    const bus = buildReportingCommandBus(pool)
    const dup = await bus.execute(
      envelope('rpt-it-def-dup', 'reporting.metric-definition.register', {
        metricKey: 'wip.quantity', family: 'wip', version: 1, caliberVersion: 'v1',
        numeratorFactSet: { kind: 'production.wip-balance' }, uomCode: 'KG', effectiveFrom: '2026-01-01',
      }),
      adminContext(),
    )
    expect(dup.status).toBe('BUSINESS_REJECTION')
    expect(dup.errorMessage).toContain('[RP-19]')

    const badFact = await bus.execute(
      envelope('rpt-it-def-badfact', 'reporting.metric-definition.register', {
        metricKey: 'wip.quantity.new', family: 'wip', version: 1, caliberVersion: 'v1',
        numeratorFactSet: { kind: 'no.such-fact' }, uomCode: 'KG', effectiveFrom: '2026-01-01',
      }),
      adminContext(),
    )
    expect(badFact.status).toBe('BUSINESS_REJECTION')
    expect(badFact.errorMessage).toContain('[RP-19]')
  })

  it('RP-22/IT-35：正反向追溯（原料→交付轴 / 交付轴→原料），含工序/设备/检验引用', async () => {
    if (skipIfNoDb()) return
    const rep = createPgReportingRepositories(pool)

    const forward = await rep.trace.trace({
      unitId: fx.purchaseUnitId, direction: 'forward', plantIds: null, enterpriseId: fx.enterpriseId,
    })
    expect(forward).not.toBeNull()
    const forwardUnits = forward!.nodes.filter((n) => n.nodeType === 'inventory_unit')
    expect(forwardUnits.map((n) => n.unitNo)).toContain(fx.finUnit2No) // 原料 → 交付轴
    const forwardKinds = new Set(forward!.edges.map((e) => e.edgeKind))
    expect(forwardKinds).toContain('consumption')
    expect(forwardKinds).toContain('customer_binding')
    const f02Node = forward!.nodes.find((n) => n.unitNo === fx.finUnit2No)!
    expect(f02Node.operationName).toBe('报表测试绞制') // 工序引用
    expect(f02Node.equipmentCode).toBe('EQ-RPT-02') // 设备引用
    expect(f02Node.operatorLogin).toBe('admin') // 人员引用
    expect(f02Node.holdCount).toBe(1) // 检验引用（active unqualified hold）

    const backward = await rep.trace.trace({
      unitNo: fx.finUnit2No, direction: 'backward', plantIds: null, enterpriseId: fx.enterpriseId,
    })
    expect(backward).not.toBeNull()
    const backwardUnits = backward!.nodes.filter((n) => n.nodeType === 'inventory_unit')
    expect(backwardUnits.map((n) => n.unitNo)).toContain(fx.purchaseUnitNo) // 交付轴 → 原料
    expect(backward!.nodes.some((n) => n.nodeType === 'material_lot')).toBe(true) // 批次源头
    const consumption = backward!.edges.find((e) => e.edgeKind === 'consumption')!
    expect(consumption.quantity).toBe('304.8000')
    expect(consumption.fromNodeId).toBe(fx.purchaseUnitId)
    expect(consumption.toNodeId).toBe(fx.finUnit2Id)
  })

  it('OA-24 二道防线：plant 范围外工厂为根的追溯返回空（服务端数据范围）', async () => {
    if (skipIfNoDb()) return
    const rep = createPgReportingRepositories(pool)
    const scoped = await rep.trace.trace({
      unitId: fx.finUnit2Id, direction: 'backward', plantIds: [fx.hfPlantId], enterpriseId: fx.enterpriseId,
    })
    expect(scoped).toBeNull()
  })
})

describe('O-8 命令统一审计（三命令各一行 audit_entry，PM 增量单 §3）', () => {
  it('stock-stat.rebuild：审计行含 actor/范围/结果计数，与命令回执一致', async () => {
    if (skipIfNoDb()) return
    const bus = buildReportingCommandBus(pool)
    const r = await bus.execute(
      envelope('rpt-it-audit-stock-stat', 'reporting.stock-stat.rebuild', {
        plantId: fx.szPlantId,
        reason: 'rpt-it-audit-stock-stat',
      }),
      adminContext(),
    )
    expect(r.status).toBe('COMMITTED')
    const rows = await pool.query(
      `SELECT actor, subject_type, subject_id, after FROM audit_entry
       WHERE action = 'reporting.stock-stat.rebuild' AND reason = 'rpt-it-audit-stock-stat'`,
    )
    expect(rows.rowCount).toBe(1) // 一行/命令（OA-28）；同 operationId 重放不重复记账
    const row = rows.rows[0]!
    expect(row.actor).toBe('admin')
    expect(row.subject_type).toBe('stock_stat_projection')
    expect(row.subject_id).toBe(fx.szPlantId)
    expect(row.after.scope).toBe(fx.szPlantId) // 权限范围（二道防线 assertPlantScope 通过的目标厂）
    expect(row.after.rowsProjected).toBe((r.data as { rowsProjected: number }).rowsProjected)
  })

  it('shift-snapshot.rebuild：审计行含范围（工厂/班次日/指标键）与结果计数', async () => {
    if (skipIfNoDb()) return
    const bus = buildReportingCommandBus(pool)
    const r = await bus.execute(
      envelope('rpt-it-audit-shift-snap', 'reporting.shift-snapshot.rebuild', {
        plantId: fx.szPlantId,
        shiftDate: RPT_SHIFT_DATE,
        reason: 'rpt-it-audit-shift-snap',
      }),
      adminContext(),
    )
    expect(r.status).toBe('COMMITTED')
    const rows = await pool.query(
      `SELECT actor, subject_id, after FROM audit_entry
       WHERE action = 'reporting.shift-snapshot.rebuild' AND reason = 'rpt-it-audit-shift-snap'`,
    )
    expect(rows.rowCount).toBe(1)
    const row = rows.rows[0]!
    expect(row.actor).toBe('admin')
    expect(row.subject_id).toBe(fx.szPlantId)
    expect(row.after.scope).toEqual({ plantId: fx.szPlantId, shiftDate: RPT_SHIFT_DATE, metricKeys: 'all' })
    const data = r.data as { snapshots: number; ok: number; denominatorMissing: number; failed: number; shiftDates: number }
    expect(row.after.snapshots).toBe(data.snapshots)
    expect(row.after.ok).toBe(data.ok)
    expect(row.after.denominatorMissing).toBe(data.denominatorMissing)
    expect(row.after.failed).toBe(data.failed)
    expect(row.after.shiftDates).toBe(data.shiftDates)
  })

  it('metric-definition.register：审计行 before=前一 active 版本指针（首版 null）、after=新版本号', async () => {
    if (skipIfNoDb()) return
    const bus = buildReportingCommandBus(pool)
    const probe = 'wip.quantity.audit-probe'
    const base = {
      metricKey: probe, family: 'wip', caliberVersion: 'v1',
      numeratorFactSet: { kind: 'production.wip-balance' }, uomCode: 'KG', effectiveFrom: '2026-01-01',
      reason: 'rpt-it-audit-def-register',
    }
    const v1 = await bus.execute(envelope('rpt-it-audit-def-v1', 'reporting.metric-definition.register', { ...base, version: 1 }), adminContext())
    expect(v1.status).toBe('COMMITTED')
    const v2 = await bus.execute(envelope('rpt-it-audit-def-v2', 'reporting.metric-definition.register', { ...base, version: 2, caliberVersion: 'v2' }), adminContext())
    expect(v2.status).toBe('COMMITTED')

    const rows = await pool.query(
      `SELECT subject_id, before, after FROM audit_entry
       WHERE action = 'reporting.metric-definition.register' AND reason = 'rpt-it-audit-def-register'
       ORDER BY (after->>'version')::int`,
    )
    expect(rows.rowCount).toBe(2) // 两次实际执行各一行（不同 operationId）
    const first = rows.rows[0]!
    const second = rows.rows[1]!
    expect(first.subject_id).toBe((v1.data as { definitionId: string }).definitionId)
    expect(first.before).toBeNull() // 首版：无前一 active
    expect(first.after.metricKey).toBe(probe)
    expect(first.after.version).toBe(1)
    expect(second.before).toEqual({ // 前一 active 版本指针 → v1 行
      definitionId: (v1.data as { definitionId: string }).definitionId,
      version: 1,
    })
    expect(second.after.version).toBe(2)
    expect(second.after.caliberVersion).toBe('v2')
  })
})

/** 业务表指纹（RP-07 零写入证据：行数 + 最后更新时刻）。 */
async function businessFingerprint(): Promise<string> {
  const r = await pool.query(
    `SELECT (SELECT count(*) FROM stock_balance) AS sb,
            (SELECT count(*) FROM stock_transaction) AS st,
            (SELECT count(*) FROM production_report) AS pr,
            (SELECT count(*) FROM report_output) AS ro,
            (SELECT count(*) FROM material_consumption) AS mc,
            (SELECT coalesce(max(updated_at)::text, '') FROM production_report) AS pr_updated`,
  )
  return JSON.stringify(r.rows[0])
}
