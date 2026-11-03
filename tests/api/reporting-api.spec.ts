import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { validateEnv } from '../../apps/api/src/env'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { DbModule } from '../../apps/api/src/db/db.module'
import { ReportingModule } from '../../apps/api/src/reporting/reporting.module'
import {
  RPT_SHIFT_DATE,
  RPT_TEST_DB_NAME,
  prepareRptTestDatabase,
  rptDatabaseUrl,
  seedRptFixtures,
  type RptFixtures,
} from './reporting-test-env'

/**
 * reporting API 集成（P2-F / T20：独立库 cadenza_reporting + supertest 自组装挂载
 * ConfigModule/DbModule/AuthModule（全局守卫）/ReportingModule——不改共享 app.module.ts，
 * L0 整合步统一注册）。
 *
 * 端点级证据：未鉴权 401 / 无许可 403（OA-23）、数据范围（OA-24/25：列表服务端过滤 +
 * 显式 plantId 越权 403 + 命令二道防线 [A-S1]）、RP-01/03/04 列表与筛选、RP-05 勾选汇总、
 * RP-06/RP-S4 导出同规则+审计行、RP-08/09 轴查询字典与采购来源 `-`、RP-12/13/16 报工
 * 口径、RP-18/21 快照读回（含缺失分母）、RP-22 追溯、命令幂等（同 operationId 回放）。
 */

let app: INestApplication
let pool: pg.Pool
let fx: RptFixtures
let adminToken = ''
let dbAvailable = true

beforeAll(async () => {
  try {
    pool = await prepareRptTestDatabase()
    fx = await seedRptFixtures(pool)
  } catch (error) {
    dbAvailable = false
    console.warn(
      `SKIP reporting api: 测试库准备失败（${error instanceof Error ? error.message : String(error)}）。独立库 ${RPT_TEST_DB_NAME}。`,
    )
    return
  }
  process.env['DATABASE_URL'] = rptDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, AuthModule, ReportingModule],
  }).compile()
  app = moduleRef.createNestApplication()
  await app.init()
  adminToken = await login('admin', 'CadAdmin001')
  // 数据就位：投影重建 + 指标注册 + 班次快照（SZ 4 ok；HF 3 缺失分母——命令走真实 HTTP 链）
  await postCommand('/reporting/stock-stat/rebuild', {}, `ap-rpt-rebuild-${Date.now()}`)
  await postCommand('/reporting/metric-definition/register', { metricKeys: ['*'] }, `ap-rpt-defs-${Date.now()}`)
  await postCommand(
    '/reporting/shift-snapshot/rebuild',
    { plantId: fx.szPlantId, shiftDate: RPT_SHIFT_DATE },
    `ap-rpt-snap-sz-${Date.now()}`,
  )
  await postCommand(
    '/reporting/shift-snapshot/rebuild',
    { plantId: fx.hfPlantId, shiftDate: RPT_SHIFT_DATE },
    `ap-rpt-snap-hf-${Date.now()}`,
  )
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
  const res = await request(app.getHttpServer()).post('/auth/login').send({ loginName, password, platform: 'WEB' })
  expect(res.status).toBe(200)
  return res.body.token as string
}

async function postCommand(path: string, body: Record<string, unknown>, operationId: string, token = adminToken) {
  const res = await request(app.getHttpServer())
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .set('x-operation-id', operationId)
    .send(body)
  expect(res.status).toBe(200)
  return res.body as { operationId: string; status: string; errorCode?: string; errorMessage?: string; data?: unknown }
}

describe('鉴权与数据范围（OA-23/24/25）', () => {
  it('未鉴权 401', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer()).get('/reporting/stock-stats')
    expect(res.status).toBe(401)
  })

  it('无 reporting.read 许可 403（szws01 仅执行域许可）', async () => {
    if (skipIfNoDb()) return
    const token = await login('szws01', 'SzWorkshop01')
    const res = await request(app.getHttpServer()).get('/reporting/stock-stats').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('OA-24/25：plant 范围列表服务端过滤（合肥厂管理员看 0 行）；显式越权 plantId 403', async () => {
    if (skipIfNoDb()) return
    const hf = await login('hfadmin01', 'HfPlant0001')
    const list = await request(app.getHttpServer())
      .get('/reporting/stock-stats')
      .set('Authorization', `Bearer ${hf}`)
    expect(list.status).toBe(200)
    expect(list.body.total).toBe(0)
    const explicit = await request(app.getHttpServer())
      .get('/reporting/stock-stats')
      .query({ plantId: fx.szPlantId })
      .set('Authorization', `Bearer ${hf}`)
    expect(explicit.status).toBe(403)
  })

  it('A-S1 二道防线：plant 范围外工厂的重建命令 BUSINESS_REJECTION（带规则码）', async () => {
    if (skipIfNoDb()) return
    const hf = await login('hfadmin01', 'HfPlant0001')
    const res = await postCommand('/reporting/stock-stat/rebuild', { plantId: fx.szPlantId }, `ap-rpt-as1-${Date.now()}`, hf)
    expect(res.status).toBe('BUSINESS_REJECTION')
    expect(res.errorMessage).toContain('[A-S1]')
    expect(res.errorMessage).toContain('目标工厂不在授权数据范围内')
  })
})

describe('库存统计端点（RP-01~RP-06）', () => {
  it('RP-01/02：列表口径（采购收货码聚合一条 500 / 生产码双订单分键 / legacy 状态中文标注）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get('/reporting/stock-stats')
      .query({ pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(5)
    const items = res.body.items as Array<Record<string, unknown>>
    const p01 = items.find((i) => i['unitNo'] === 'RPT-P01')!
    expect(p01['statKindLabel']).toBe('采购收货码')
    expect(p01['quantity']).toBe('500.0000')
    expect(p01['stockStatusLabel']).toBe('正常')
    const frozen = items.find((i) => i['unitNo'] === 'RPT-P02')!
    expect(frozen['stockStatusLabel']).toBe('冻结')
    expect(items.filter((i) => i['unitNo'] === 'RPT-F01')).toHaveLength(2)
    const f02 = items.find((i) => i['unitNo'] === 'RPT-F02')!
    expect(f02['customerAxisNos']).toEqual(['CUST-AX-001'])
  })

  it('RP-03：英尺展示列（304.8M→1000.0000 截取；KG→null 由端点原样输出）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get('/reporting/stock-stats')
      .query({ pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    const items = res.body.items as Array<Record<string, unknown>>
    expect(items.find((i) => i['unitNo'] === 'RPT-F02')!['feetQuantity']).toBe('1000.0000')
    expect(items.find((i) => i['unitNo'] === 'RPT-P01')!['feetQuantity']).toBeNull()
  })

  it('RP-04：成品入库状态筛选联动（已入库=正常+仓库）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get('/reporting/stock-stats')
      .query({ finishedEntryStatus: 'entered_warehouse', pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect((res.body.items[0] as Record<string, unknown>)['unitNo']).toBe('RPT-F02')
  })

  it('RP-04：非法筛选值 422 带规则码', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get('/reporting/stock-stats')
      .query({ finishedEntryStatus: 'bogus' })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(422)
    expect(res.body.message).toContain('[RP-04]')
  })

  it('RP-05：勾选汇总 POST（服务端全量聚合；未勾选总量 0）', async () => {
    if (skipIfNoDb()) return
    const list = await request(app.getHttpServer())
      .get('/reporting/stock-stats')
      .query({ pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    const items = list.body.items as Array<{ statId: string; unitNo: string }>
    const ids = [items.find((i) => i.unitNo === 'RPT-F02')!.statId, items.find((i) => i.unitNo === 'RPT-P01')!.statId]
    const res = await request(app.getHttpServer())
      .post('/reporting/stock-stats/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids })
    expect(res.status).toBe(200)
    expect(res.body.totalRows).toBe(2)
    expect(res.body.groups).toEqual([
      { uomCode: 'KG', uomLabel: 'KG', totalQuantity: '500.0000' },
      { uomCode: 'M', uomLabel: 'M', totalQuantity: '304.8000' },
    ])
    const empty = await request(app.getHttpServer())
      .post('/reporting/stock-stats/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: [] })
    expect(empty.body).toEqual({ groups: [], totalRows: 0 })
  })

  it('RP-06/RP-S4：导出与列表同规则（同 total），导出记 audit_entry 审计行', async () => {
    if (skipIfNoDb()) return
    const before = await pool.query(`SELECT count(*)::int AS n FROM audit_entry WHERE action = 'reporting.stock-stat.export'`)
    const res = await request(app.getHttpServer())
      .get('/reporting/stock-stats')
      .query({ export: '1', pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(5) // 与列表同一套筛选与数据范围
    const after = await pool.query(`SELECT count(*)::int AS n FROM audit_entry WHERE action = 'reporting.stock-stat.export'`)
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1)
    const row = await pool.query(`SELECT actor, subject_type, after FROM audit_entry WHERE action = 'reporting.stock-stat.export' ORDER BY created_at DESC LIMIT 1`)
    expect(row.rows[0]!.actor).toBe('admin')
    expect(row.rows[0]!.subject_type).toBe('reporting_export')
  })
})

describe('轴查询端点（RP-08~RP-11）', () => {
  it('RP-08：列集与状态字典（入库/质检/销售/锁定/存疑/成品异常，中文标注）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get('/reporting/axis-query')
      .query({ pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(6)
    const items = res.body.items as Array<Record<string, unknown>>
    const f02 = items.find((i) => i['unitNo'] === 'RPT-F02')!
    expect(f02['inboundStatusLabel']).toBe('在库中')
    expect(f02['qcStatusLabel']).toBe('合格')
    expect(f02['saleStatusLabel']).toBe('已销售')
    expect(f02['lockStatusLabel']).toBe('未锁定')
    expect(f02['finishedAbnormalStatusLabel']).toBe('异常未处理')
    expect(f02['reportStatusLabel']).toBe('已报工')
    expect(f02['customerAxisNo']).toBe('CUST-AX-001')
    expect(f02['segmentLength']).toBe('304.8000')
    const f01 = items.find((i) => i['unitNo'] === 'RPT-F01')!
    expect(f01['lockStatusLabel']).toBe('锁定')
    expect(f01['reportedBy']).toBe('admin')
  })

  it('RP-09：采购来源报工状态固定 `-`；按报工状态筛选不含采购来源轴', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get('/reporting/axis-query')
      .query({ pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    const p01 = (res.body.items as Array<Record<string, unknown>>).find((i) => i['unitNo'] === 'RPT-P01')!
    expect(p01['reportStatus']).toBe('not_applicable')
    expect(p01['reportStatusLabel']).toBe('-')

    const reported = await request(app.getHttpServer())
      .get('/reporting/axis-query')
      .query({ reportStatus: 'reported', pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(reported.body.total).toBe(2) // F01/F02；采购 P01/P02 排除
    const notReported = await request(app.getHttpServer())
      .get('/reporting/axis-query')
      .query({ reportStatus: 'not_reported', pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(notReported.body.total).toBe(2) // F03/F04
  })

  it('RP-09：报工状态筛选值 `-`（not_applicable）不可作为筛选值 → 422 带规则码', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get('/reporting/axis-query')
      .query({ reportStatus: 'not_applicable' })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(422)
    expect(res.body.message).toContain('[RP-09]')
  })

  it('RP-08：质检免检与销售筛选', async () => {
    if (skipIfNoDb()) return
    const exempt = await request(app.getHttpServer())
      .get('/reporting/axis-query')
      .query({ qcStatus: 'exempt', pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(exempt.body.total).toBe(1)
    expect((exempt.body.items[0] as Record<string, unknown>)['unitNo']).toBe('RPT-F04')
    const sold = await request(app.getHttpServer())
      .get('/reporting/axis-query')
      .query({ saleStatus: 'sold', pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(sold.body.total).toBe(1)
  })
})

describe('报工汇总端点（RP-12/13/16/17）', () => {
  it('RP-16：口径分层五量逐口径展示不混计（草稿/提交/审核/合格/入库）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get('/reporting/report-summary/by-caliber')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    const rows = res.body as Array<{ caliber: string; caliberLabel: string; groups: Array<{ uomCode: string; totalQuantity: string }>; axisCount: number }>
    expect(rows.map((r) => r.caliber)).toEqual(['draft', 'submitted', 'approved', 'qualified', 'stocked'])
    const by = new Map(rows.map((r) => [r.caliber, r]))
    expect(by.get('draft')!.groups).toEqual([{ uomCode: 'M', totalQuantity: '20.0000' }])
    expect(by.get('draft')!.axisCount).toBe(0) // 草稿行无库存单元
    expect(by.get('submitted')!.groups).toEqual([{ uomCode: 'M', totalQuantity: '604.8000' }])
    expect(by.get('submitted')!.axisCount).toBe(3)
    expect(by.get('approved')!.groups).toEqual([{ uomCode: 'M', totalQuantity: '554.8000' }]) // 待审 R5 不入审核口径
    expect(by.get('qualified')!.groups).toEqual([{ uomCode: 'M', totalQuantity: '550.0000' }]) // 合格口径取合格数量列
    expect(by.get('stocked')!.groups).toEqual([{ uomCode: 'M', totalQuantity: '554.8000' }])
  })

  it('RP-12/17：Web 汇总行按勾选报工单服务端聚合（含英尺汇总列；未选显示 0）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .post('/reporting/report-summary/selection')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: [fx.reportR1Id, fx.reportR4Id, fx.reportR5Id] })
    expect(res.status).toBe(200)
    expect(res.body.groups).toEqual([{ uomCode: 'M', totalQuantity: '300.0000' }])
    expect(res.body.axisCount).toBe(2) // R1 与 R4 各 1 不重复轴（同轴 F01），R5 无轴
    expect(res.body.feetGroups).toEqual([{ uomCode: 'M', feetQuantity: '984.2519' }]) // 300÷0.3048 截取
    const empty = await request(app.getHttpServer())
      .post('/reporting/report-summary/selection')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: [] })
    expect(empty.body.groups).toEqual([])
    expect(empty.body.axisCount).toBe(0)
  })

  it('RP-13：PDA 累计三口径分开；操作工只算自己参与的（服务端以会话身份强制）', async () => {
    if (skipIfNoDb()) return
    const qcToken = await login('szqc01', 'SzQuality01')
    const mine = await request(app.getHttpServer())
      .get('/reporting/pda/cumulative')
      .query({ operatorOnly: 'true' })
      .set('Authorization', `Bearer ${qcToken}`)
    expect(mine.status).toBe(200)
    const mineRows = new Map(
      (mine.body as Array<{ caliber: string; groups: Array<{ uomCode: string; totalQuantity: string }> }>).map((r) => [
        r.caliber,
        r.groups,
      ]),
    )
    expect(mineRows.get('draft')).toEqual([]) // szqc01 无草稿
    expect(mineRows.get('submitted')).toEqual([{ uomCode: 'M', totalQuantity: '50.0000' }]) // 仅 R5
    expect(mineRows.get('approved')).toEqual([]) // R5 待审

    const all = await request(app.getHttpServer())
      .get('/reporting/pda/cumulative')
      .set('Authorization', `Bearer ${adminToken}`)
    const allRows = new Map(
      (all.body as Array<{ caliber: string; groups: Array<{ uomCode: string; totalQuantity: string }> }>).map((r) => [
        r.caliber,
        r.groups,
      ]),
    )
    expect(allRows.get('submitted')).toEqual([{ uomCode: 'M', totalQuantity: '604.8000' }])
  })

  it('RP-13：部门范围含下级（path 前缀）——质检部门只见其工序报工', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get('/reporting/pda/cumulative')
      .query({ deptId: fx.qcDeptId })
      .set('Authorization', `Bearer ${adminToken}`)
    const rows = new Map(
      (res.body as Array<{ caliber: string; groups: Array<{ uomCode: string; totalQuantity: string }> }>).map((r) => [
        r.caliber,
        r.groups,
      ]),
    )
    expect(rows.get('submitted')).toEqual([{ uomCode: 'M', totalQuantity: '304.8000' }]) // 仅 R2（订单 C 检验工序）
  })
})

describe('指标与班次快照端点（RP-18~RP-21）', () => {
  it('RP-19：指标定义读回（四族齐备，中文族标注）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get('/reporting/metrics/definitions')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    const defs = res.body as Array<{ metricKey: string; familyLabel: string; version: number; uomMode: string }>
    expect(defs.map((d) => d.metricKey).sort()).toEqual([
      'delivery.ontime-rate',
      'loss.consumption-gap-rate',
      'wip.quantity',
      'yield.qualified-rate',
    ])
    expect(defs.every((d) => d.version === 1)).toBe(true)
  })

  it('RP-18/21：快照读回四族数值与缺失分母标记（value 空、原因带 [RP-21]，不以 0 冒充）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .get('/reporting/shift-snapshots')
      .query({ plantId: fx.szPlantId, shiftDate: RPT_SHIFT_DATE, pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(4)
    const byKey = new Map(
      (res.body.items as Array<{ metricKey: string; value: string | null; status: string; sourceRows: number }>).map(
        (s) => [s.metricKey, s],
      ),
    )
    expect(byKey.get('wip.quantity')!.value).toBe('80.0000')
    expect(byKey.get('yield.qualified-rate')!.value).toBe('100.0000')
    expect(byKey.get('loss.consumption-gap-rate')!.value).toBe('50.0000')
    expect(byKey.get('delivery.ontime-rate')!.value).toBe('50.0000')
    expect(byKey.get('yield.qualified-rate')!.sourceRows).toBe(2)

    const missing = await request(app.getHttpServer())
      .get('/reporting/shift-snapshots')
      .query({ plantId: fx.hfPlantId, shiftDate: RPT_SHIFT_DATE, statuses: 'denominator_missing', pageSize: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(missing.body.total).toBe(3)
    for (const item of missing.body.items as Array<{ value: string | null; status: string; missingReason: string }>) {
      expect(item.status).toBe('denominator_missing')
      expect(item.value).toBeNull()
      expect(item.missingReason).toContain('[RP-21]')
    }
  })
})

describe('追溯端点（RP-22 / IT-35）', () => {
  it('正反向双向可查（原料→交付轴 / 交付轴→原料）', async () => {
    if (skipIfNoDb()) return
    const backward = await request(app.getHttpServer())
      .get(`/reporting/trace/${fx.finUnit2No}`)
      .query({ direction: 'backward' })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(backward.status).toBe(200)
    const nodes = (backward.body.nodes as Array<{ unitNo: string | null; nodeType: string }>).map((n) => n.unitNo)
    expect(nodes).toContain(fx.purchaseUnitNo) // 交付轴 → 原料

    const forward = await request(app.getHttpServer())
      .get(`/reporting/trace/${fx.purchaseUnitNo}`)
      .query({ direction: 'forward' })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(forward.status).toBe(200)
    const forwardNodes = (forward.body.nodes as Array<{ unitNo: string | null }>).map((n) => n.unitNo)
    expect(forwardNodes).toContain(fx.finUnit2No) // 原料 → 交付轴
    expect((forward.body.edges as Array<{ edgeKind: string }>).map((e) => e.edgeKind)).toContain('customer_binding')
  })
})

describe('维护命令端点（幂等 + 规则码；只写投影表）', () => {
  it('RP-07：stock-stat 重建 COMMITTED；同 operationId 重放返回原结果', async () => {
    if (skipIfNoDb()) return
    const opId = `ap-rpt-rebuild-idem-${Date.now()}`
    const first = await postCommand('/reporting/stock-stat/rebuild', {}, opId)
    expect(first.status).toBe('COMMITTED')
    expect((first.data as { rowsProjected: number }).rowsProjected).toBe(5)
    const replay = await postCommand('/reporting/stock-stat/rebuild', {}, opId)
    expect(replay.status).toBe('COMMITTED')
    expect(replay.data).toEqual(first.data)
    const count = await pool.query(`SELECT count(*)::int AS n FROM stock_stat_projection`)
    expect(count.rows[0]!.n).toBe(5)
  })

  it('RP-19：同 key 同版本注册拒绝（HTTP 链路）', async () => {
    if (skipIfNoDb()) return
    const res = await postCommand(
      '/reporting/metric-definition/register',
      {
        metricKey: 'wip.quantity',
        family: 'wip',
        version: 1,
        caliberVersion: 'v2',
        numeratorFactSet: { kind: 'production.wip-balance' },
        uomCode: 'KG',
        effectiveFrom: '2026-01-01',
      },
      `ap-rpt-def-dup-${Date.now()}`,
    )
    expect(res.status).toBe('BUSINESS_REJECTION')
    expect(res.errorMessage).toContain('[RP-19]')
  })

  it('RP-20：非法指标族拒绝（带规则码）', async () => {
    if (skipIfNoDb()) return
    const res = await postCommand(
      '/reporting/metric-definition/register',
      {
        metricKey: 'x.new',
        family: 'bogus',
        version: 1,
        caliberVersion: 'v1',
        numeratorFactSet: { kind: 'production.wip-balance' },
        uomCode: 'KG',
        effectiveFrom: '2026-01-01',
      },
      `ap-rpt-def-family-${Date.now()}`,
    )
    expect(res.status).toBe('BUSINESS_REJECTION')
    expect(res.errorMessage).toContain('[RP-20]')
  })
})
