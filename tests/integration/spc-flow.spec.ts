import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext, VerifiedAuthContext } from '@cadenza/application'
import { buildSpcCommandBus, buildSpcQueryService } from '../../apps/api/src/spc/spc.composition'
import { SPC_TEST_DB_NAME, prepareSpcTestDatabase, seedSpcFixtures, type SpcFixtures } from '../api/spc-test-env'

/**
 * T23 工艺变更/SPC/校准/工具寿命 集成（真容器独立库 cadenza_p3c + 真实命令总线与真实组合根，无业务桩）。
 * 冻结合同证据分组：
 * ① 工艺变更影响控制（PE-02~07）：三单分类/未处置拒发布/逐单处置/发布重算留痕/历史实绩不静默重算/PE-07 守卫/幂等
 * ② SPC 规则集与控制限（PE-08~10）：受控项目冻结/规则集发布 immutable/控制限版本化/历史点位不改标
 * ③ 样本准入与判异（PE-11/12/13/14）：五类拒绝/失控任务生成/处置闭环/复控证据/不写质量域
 * ④ 校准（PE-15~17）：append-only/时点快照/检测排产联动
 * ⑤ 失准圈定与处置（PE-18/19）：只读圈定清单/库存与已发运分桶/客诉提示/逐项处置
 * ⑥ 工具寿命（PE-20/21/S5）：版本化配置/累计只增/具名调整/到期禁用
 */

let pool: pg.Pool
let spcBus: ReturnType<typeof buildSpcCommandBus>
let queries: ReturnType<typeof buildSpcQueryService>
let adminCtx: CommandContext
let adminAuth: VerifiedAuthContext
let fx: SpcFixtures
let dbAvailable = true
const run = `spc${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

beforeAll(async () => {
  try {
    pool = await prepareSpcTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP spc-flow: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${SPC_TEST_DB_NAME}）。`)
    return
  }
  fx = await seedSpcFixtures(pool)
  const admin = await pool.query<{ id: string; enterprise_id: string; plant_id: string }>(
    `SELECT id, enterprise_id, plant_id FROM user_account WHERE login_name = 'admin'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  adminAuth = {
    session: { id: 'test-session', expiresAt: '2099-01-01T00:00:00Z' },
    user: {
      id: admin.rows[0]!.id,
      loginName: 'admin',
      displayName: '集团管理员',
      enterpriseId: admin.rows[0]!.enterprise_id,
      plantId: admin.rows[0]!.plant_id,
      roleId: 'role-sysadmin',
      loginPlatform: 'WEB',
    },
    role: { id: 'role-sysadmin', name: '系统管理员', alias: 'sysadmin' },
    permissions: ['spc.read', 'spc.post'],
    dataScope: { enterpriseWide: true, plantIds: [] },
  }
  spcBus = buildSpcCommandBus(pool)
  queries = buildSpcQueryService(pool)
})

afterAll(async () => {
  if (pool) await pool.end()
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

let opSeq = 0
function nextOp(tag: string): string {
  opSeq += 1
  return `${run}-${tag}-${opSeq}`
}

function envelope(operationId: string, commandType: string, payload: Record<string, unknown>): CommandEnvelope {
  return { operationId, commandType, targetId: 'new', expectedRevision: 0, payload }
}

async function exec(
  operationId: string,
  commandType: string,
  payload: Record<string, unknown>,
): Promise<CommandResult> {
  return spcBus.execute(envelope(operationId, commandType, payload), adminCtx)
}

describe('① 工艺变更影响控制（PE-02~07）', () => {
  const changeNo = `PC-${run}-1`
  let changeId = ''
  let publishOpId = ''
  let publishData: Record<string, unknown> | null = null
  let impacts: Array<{ id: string; category: string; orderNo: string; operationSeq: number; scheduled: boolean }>
  let inProcessImpactId = ''

  it('起草：版本对+审批人+生效时间；显式 changeNo 重复幂等返回', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const created = await exec(nextOp('cc'), 'spc.change.create', {
      plantId: fx.szPlantId,
      changeNo,
      oldSpecRevisionId: fx.oldSpecRevisionId,
      newSpecRevisionId: fx.newSpecRevisionId,
      approver: '工艺-张工',
      effectiveAt: '2026-10-30T08:00:00Z',
    })
    expect(created.status).toBe(CommandResultStatus.COMMITTED)
    changeId = (created.data as { changeId: string }).changeId
    expect((created.data as { skipped: boolean }).skipped).toBe(false)
    // 同 changeNo 重复（新 operationId）→ 幂等返回 skipped
    const again = await exec(nextOp('cc2'), 'spc.change.create', {
      plantId: fx.szPlantId,
      changeNo,
      oldSpecRevisionId: fx.oldSpecRevisionId,
      newSpecRevisionId: fx.newSpecRevisionId,
      approver: '工艺-张工',
      effectiveAt: '2026-10-30T08:00:00Z',
    })
    expect(again.status).toBe(CommandResultStatus.COMMITTED)
    expect((again.data as { skipped: boolean }).skipped).toBe(true)
    expect((again.data as { changeId: string }).changeId).toBe(changeId)
  })

  it('影响扫描（PE-03/PE-06）：三单四工序分类（未执行+已排产/在制/未执行/已完成）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const scanned = await exec(nextOp('cs'), 'spc.change.scan', { plantId: fx.szPlantId, changeId })
    expect(scanned.status).toBe(CommandResultStatus.COMMITTED)
    const data = scanned.data as { scanned: number; summary: { unexecuted: number; inProcess: number; completed: number } }
    // MO-A 工序1（未执行+已排产）、MO-B 工序1（在制：已提交报工）、MO-B 工序2（未执行）、MO-C 工序1（已完成）
    expect(data.scanned).toBe(4)
    expect(data.summary).toEqual({ unexecuted: 2, inProcess: 1, completed: 1 })
    const rows = await pool.query<{ id: string; category: string; order_no: string; operation_seq: number; scheduled: boolean }>(
      `SELECT i.id, i.category, i.order_no, i.operation_seq, i.scheduled
       FROM spc_change_impact i WHERE i.change_id = $1 ORDER BY i.order_no, i.operation_seq`,
      [changeId],
    )
    impacts = rows.rows.map((r) => ({
      id: r.id,
      category: r.category,
      orderNo: r.order_no,
      operationSeq: r.operation_seq,
      scheduled: r.scheduled,
    }))
    const byKey = new Map(impacts.map((i) => [`${i.orderNo}-${i.operationSeq}`, i]))
    // PE-03：无已提交报工＝未执行；已排产未开工属可调整未执行（scheduled 标记）
    expect(byKey.get(`${fx.orderA.orderNo}-1`)!.category).toBe('unexecuted')
    expect(byKey.get(`${fx.orderA.orderNo}-1`)!.scheduled).toBe(true)
    // MO-B 工序1 存在已提交报工（草稿不计）→ 在制；工序2 无报工 → 未执行
    expect(byKey.get(`${fx.orderB.orderNo}-1`)!.category).toBe('in_process')
    expect(byKey.get(`${fx.orderB.orderNo}-2`)!.category).toBe('unexecuted')
    // MO-C 已结束 → 已完成（不可变更，仅提示范围）
    expect(byKey.get(`${fx.orderC.orderNo}-1`)!.category).toBe('completed')
    inProcessImpactId = byKey.get(`${fx.orderB.orderNo}-1`)!.id
  })

  it('未处置在制任务不得发布（PE-S1/PE-04）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const rejected = await exec(nextOp('cp0'), 'spc.change.publish', { plantId: fx.szPlantId, changeId })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorCode).toBe(ERROR_CODES.BUSINESS_RULE)
    expect(rejected.errorMessage).toContain('[PE-04]')
    expect(rejected.errorMessage).toContain('未处置')
  })

  it('逐单处置：在制三选项；未执行任务不得选择处置（PE-04）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const unexecutedImpact = impacts.find((i) => i.category === 'unexecuted')!
    const bad = await exec(nextOp('cd0'), 'spc.change.disposition', {
      plantId: fx.szPlantId,
      changeId,
      impactId: unexecutedImpact.id,
      disposition: 'continue_old',
    })
    expect(bad.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(bad.errorMessage).toContain('[PE-04]')

    const good = await exec(nextOp('cd1'), 'spc.change.disposition', {
      plantId: fx.szPlantId,
      changeId,
      impactId: inProcessImpactId,
      disposition: 'switch_new',
    })
    expect(good.status).toBe(CommandResultStatus.COMMITTED)
    const data = good.data as { followsVersion: string }
    // PE-04② 转新版：后续产出按新版
    expect(data.followsVersion).toBe('new')
  })

  it('发布：未执行与转新版在制自动重算计划量留调整记录；已完成不重算不静默改写（PE-02/PE-03）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const moaOpBefore = await pool.query<{ settings_version: number; offline_qty: string }>(
      `SELECT settings_version, offline_qty::text AS offline_qty FROM order_operation WHERE id = $1`,
      [fx.orderA.operationId],
    )
    publishOpId = nextOp('cp')
    const published = await exec(publishOpId, 'spc.change.publish', { plantId: fx.szPlantId, changeId })
    expect(published.status).toBe(CommandResultStatus.COMMITTED)
    publishData = published.data as Record<string, unknown>
    const data = published.data as {
      status: string
      impactCount: number
      adjustments: Array<{ orderNo: string; operationSeq: number; oldPlannedQty: string; newPlannedQty: string }>
    }
    expect(data.status).toBe('published')
    expect(data.impactCount).toBe(4)
    // 调整指令：MO-A 工序1（100→200，因子 7×1→7×2）、MO-B 工序1（转新版 80→160）、MO-B 工序2（60→120）；MO-C 无
    expect(data.adjustments).toHaveLength(3)
    const adjBy = new Map(data.adjustments.map((a) => [`${a.orderNo}-${a.operationSeq}`, a]))
    expect(adjBy.get(`${fx.orderA.orderNo}-1`)).toMatchObject({ oldPlannedQty: '100.0000', newPlannedQty: '200.0000' })
    expect(adjBy.get(`${fx.orderB.orderNo}-1`)).toMatchObject({ oldPlannedQty: '80.0000', newPlannedQty: '160.0000' })
    expect(adjBy.get(`${fx.orderB.orderNo}-2`)).toMatchObject({ oldPlannedQty: '60.0000', newPlannedQty: '120.0000' })
    expect(adjBy.has(`${fx.orderC.orderNo}-1`)).toBe(false)

    // PE-02：订单工序快照不被静默重算（调整指令只落在 spc 域，历史实绩保留旧参数）
    const moaOpAfter = await pool.query<{ settings_version: number; offline_qty: string }>(
      `SELECT settings_version, offline_qty::text AS offline_qty FROM order_operation WHERE id = $1`,
      [fx.orderA.operationId],
    )
    expect(moaOpAfter.rows[0]!.settings_version).toBe(moaOpBefore.rows[0]!.settings_version)
    expect(moaOpAfter.rows[0]!.offline_qty).toBe(moaOpBefore.rows[0]!.offline_qty)
    // 调整行 append-only 落库
    const adjRows = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM spc_change_adjustment WHERE change_id = $1`,
      [changeId],
    )
    expect(Number(adjRows.rows[0]!.count)).toBe(3)
    // PE-05：审批人/生效时间/版本对可回查（执行版本对应）
    const detail = await queries.changeDetail(adminAuth, changeId)
    expect(detail!.change.approver).toBe('工艺-张工')
    expect(detail!.change.publishedAt).not.toBeNull()
    const completedImpact = detail!.impacts.find((i) => i.category === 'completed')!
    expect(completedImpact.followsVersion).toBe('old') // 历史实绩保留旧参数
  })

  it('PE-07：已有报工的工序改名/调序/删行/新增被守卫拒绝', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 变更单2 携带 rename 工序变动（目标 MO-B 工序1 = 已有已提交报工）
    const created = await exec(nextOp('cc3'), 'spc.change.create', {
      plantId: fx.szPlantId,
      changeNo: `PC-${run}-2`,
      oldSpecRevisionId: fx.oldSpecRevisionId,
      newSpecRevisionId: fx.newSpecRevisionId,
      approver: '工艺-张工',
      effectiveAt: '2026-11-01T08:00:00Z',
      operationMutations: [{ kind: 'rename', targetSeq: 1 }],
    })
    const change2Id = (created.data as { changeId: string }).changeId
    await exec(nextOp('cs3'), 'spc.change.scan', { plantId: fx.szPlantId, changeId: change2Id })
    // 逐单处置后发布 → PE-07 守卫拒绝（MO-B 工序1 有已提交报工）
    const rows = await pool.query<{ id: string; category: string }>(
      `SELECT id, category FROM spc_change_impact WHERE change_id = $1 AND category = 'in_process'`,
      [change2Id],
    )
    await exec(nextOp('cd3'), 'spc.change.disposition', {
      plantId: fx.szPlantId,
      changeId: change2Id,
      impactId: rows.rows[0]!.id,
      disposition: 'continue_old',
    })
    const rejected = await exec(nextOp('cp3'), 'spc.change.publish', { plantId: fx.szPlantId, changeId: change2Id })
    expect(rejected.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(rejected.errorMessage).toContain('[PE-07]')
    expect(rejected.errorMessage).toContain('改工序名称')
  })

  it('同 operationId 重放：原结果回放（幂等）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 重放原发布命令的 operationId（同载荷）→ 回执原样回放，不重复生成调整指令
    const replay = await exec(publishOpId, 'spc.change.publish', { plantId: fx.szPlantId, changeId })
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect(replay.data).toEqual(publishData)
    // 不重复生成调整指令
    const adjRows = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM spc_change_adjustment WHERE change_id = $1`,
      [changeId],
    )
    expect(Number(adjRows.rows[0]!.count)).toBe(3)
  })
})

describe('② SPC 规则集/受控项目/控制限（PE-08~10）', () => {
  let ruleSetId = ''
  let controlItemId = ''

  it('规则集创建+发布；重复版本拒绝（PE-09/PE-S2）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const created = await exec(nextOp('rs'), 'spc.rule-set.create', {
      plantId: fx.szPlantId,
      name: `现场规则集-${run}`,
      version: 1,
      chartType: 'i_mr',
      criteria: ['point_beyond_limits', 'run_same_side_6', 'trend_6'],
    })
    expect(created.status).toBe(CommandResultStatus.COMMITTED)
    ruleSetId = (created.data as { ruleSetId: string }).ruleSetId
    // 同名同版本重复 → PE-S2 拒绝
    const dup = await exec(nextOp('rs2'), 'spc.rule-set.create', {
      plantId: fx.szPlantId,
      name: `现场规则集-${run}`,
      version: 1,
      chartType: 'i_mr',
      criteria: ['point_beyond_limits'],
    })
    expect(dup.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(dup.errorMessage).toContain('[PE-S2]')
    // 发布；重复发布拒绝
    const published = await exec(nextOp('rsp'), 'spc.rule-set.publish', { plantId: fx.szPlantId, ruleSetId })
    expect(published.status).toBe(CommandResultStatus.COMMITTED)
    expect((published.data as { status: string }).status).toBe('published')
    const again = await exec(nextOp('rsp2'), 'spc.rule-set.publish', { plantId: fx.szPlantId, ruleSetId })
    expect(again.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(again.errorMessage).toContain('[PE-S2]')
    // 库级：已发布内容不可改（直接 UPDATE 拒）
    await expect(
      pool.query(`UPDATE spc_rule_set SET criteria = '["trend_6"]'::jsonb WHERE id = $1`, [ruleSetId]),
    ).rejects.toThrow(/PE-S2/)
  })

  it('受控项目随检验规范版本冻结：同规范同项唯一（PE-08）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const created = await exec(nextOp('ci'), 'spc.control-item.create', {
      plantId: fx.szPlantId,
      specCode: 'INS-CABLE',
      specVersion: 3,
      itemNo: 'OD-01',
      itemName: '外径',
      pointRef: 'OT-POINT-JZ-01',
      ruleSetId,
    })
    expect(created.status).toBe(CommandResultStatus.COMMITTED)
    controlItemId = (created.data as { controlItemId: string }).controlItemId
    const dup = await exec(nextOp('ci2'), 'spc.control-item.create', {
      plantId: fx.szPlantId,
      specCode: 'INS-CABLE',
      specVersion: 3,
      itemNo: 'OD-01',
    })
    expect(dup.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(dup.errorMessage).toContain('[PE-08]')
  })

  it('控制限：样本不足 building；首 n 组建立 active（PE-10）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const empty = await exec(nextOp('cl0'), 'spc.control-limit.recalc', {
      plantId: fx.szPlantId,
      controlItemId,
      baselineGroupCount: 3,
    })
    expect(empty.status).toBe(CommandResultStatus.COMMITTED)
    expect((empty.data as { status: string }).status).toBe('building')
    expect((empty.data as { version: number }).version).toBe(1)
  })
})

describe('③ 样本准入/判异/失控闭环（PE-11~14）；校准联动（PE-16/17）', () => {
  let gaugeGoodId = ''
  let gaugeBadId = ''
  let controlItemId = ''
  let limitVersion2Cl = ''
  let oocTaskId = ''

  beforeAll(async () => {
    if (!dbAvailable) return
    const item = await pool.query<{ id: string }>(
      `SELECT id FROM spc_control_item WHERE spec_code = 'INS-CABLE' AND spec_version = 3 AND item_no = 'OD-01'`,
    )
    controlItemId = item.rows[0]!.id
  })

  it('器具登记+校准记录：合格器具与失准器具（PE-15）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const good = await exec(nextOp('g1'), 'spc.gauge.register', {
      plantId: fx.szPlantId,
      gaugeNo: `G-${run}-OK`,
      name: '激光千分尺-OK',
      gaugeKind: '千分尺',
    })
    gaugeGoodId = (good.data as { gaugeId: string }).gaugeId
    await exec(nextOp('cal1'), 'spc.calibration.record', {
      plantId: fx.szPlantId,
      gaugeId: gaugeGoodId,
      calibratedAt: '2026-10-01T00:00:00Z',
      result: 'qualified',
      certificateNo: `CERT-${run}-1`,
      validUntil: '2027-10-01T00:00:00Z',
      basis: 'JJG 21-2026',
    })
    const bad = await exec(nextOp('g2'), 'spc.gauge.register', {
      plantId: fx.szPlantId,
      gaugeNo: `G-${run}-BAD`,
      name: '激光千分尺-BAD',
      gaugeKind: '千分尺',
    })
    gaugeBadId = (bad.data as { gaugeId: string }).gaugeId
    // 失准校准（PE-18 圈定入口：有效期内 2026-10-01 ~ 2026-12-01）
    const failed = await exec(nextOp('cal2'), 'spc.calibration.record', {
      plantId: fx.szPlantId,
      gaugeId: gaugeBadId,
      calibratedAt: '2026-10-10T00:00:00Z',
      result: 'failed',
      certificateNo: `CERT-${run}-2`,
      validUntil: '2026-12-01T00:00:00Z',
      basis: 'JJG 21-2026',
    })
    expect(failed.status).toBe(CommandResultStatus.COMMITTED)
    // PE-15 append-only：直接 UPDATE 校准记录 → 库级守卫拒
    const calRow = await pool.query<{ id: string }>(
      `SELECT id FROM spc_calibration_record WHERE gauge_id = $1 LIMIT 1`,
      [gaugeBadId],
    )
    await expect(
      pool.query(`UPDATE spc_calibration_record SET result = 'qualified' WHERE id = $1`, [calRow.rows[0]!.id]),
    ).rejects.toThrow(/append-only/)
  })

  it('PE-11 五类拒绝：坏点/时钟偏差/校准可疑/质量码/缺实测引用', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const base = {
      plantId: fx.szPlantId,
      controlItemId,
      source: 'collection',
      gaugeId: gaugeGoodId,
      sampledAt: '2026-10-26T08:00:00Z',
    }
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, measuredValue: '2.0000', qualityCode: 'good', badPoint: true }, 'bad_point'],
      [{ ...base, measuredValue: '2.0000', qualityCode: 'good', clockDeviation: true }, 'clock_deviation'],
      [{ ...base, measuredValue: '2.0000', qualityCode: 'good', gaugeId: gaugeBadId }, 'calibration_suspect'],
      [{ ...base, measuredValue: '2.0000', qualityCode: 'suspect' }, 'quality_code_not_good'],
      [
        {
          plantId: fx.szPlantId,
          controlItemId,
          source: 'manual_inspection',
          measuredValue: '2.0000',
          sampledAt: '2026-10-26T08:00:00Z',
        },
        'test_result_missing',
      ],
    ]
    for (const [payload, reason] of cases) {
      const r = await exec(nextOp(`rej-${reason}`), 'spc.sample.record', payload)
      expect(r.status, `拒绝原因 ${reason}`).toBe(CommandResultStatus.COMMITTED)
      const data = r.data as { admission: string; rejectReason: string }
      expect(data.admission).toBe('rejected')
      expect(data.rejectReason).toBe(reason)
    }
    // 被拒样本不入 SPC 判定（无判定行）
    const judgementCount = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM spc_point_judgement WHERE control_item_id = $1`,
      [controlItemId],
    )
    expect(Number(judgementCount.rows[0]!.count)).toBe(0)
  })

  it('基线样本（人工来源，绑定器具+校准快照）+ 控制限建立 + 在控判定（PE-11/14/16）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const values = ['2.0000', '2.1000', '2.2000']
    for (const [i, v] of values.entries()) {
      const r = await exec(nextOp(`base${i}`), 'spc.sample.record', {
        plantId: fx.szPlantId,
        controlItemId,
        source: 'manual_inspection',
        testResultId: fx.testResultStock.resultId,
        measuredValue: v,
        sampledAt: `2026-10-26T09:0${i}:00Z`,
        gaugeId: gaugeGoodId,
        productionOrderId: fx.orderB.id,
        orderOperationId: fx.orderB.reportedOperationId,
        operationSeq: 1,
        equipmentCode: 'EQ-SPC-01',
        shiftDate: '2026-10-26',
      })
      expect(r.status).toBe(CommandResultStatus.COMMITTED)
      const data = r.data as { admission: string; calibrationStatus: string }
      expect(data.admission).toBe('admitted')
      // PE-16：实测绑定器具+当时校准状态快照
      expect(data.calibrationStatus).toBe('valid')
    }
    // 基线 3 组建立控制限（v2 active）
    const recalc = await exec(nextOp('cl2'), 'spc.control-limit.recalc', {
      plantId: fx.szPlantId,
      controlItemId,
      baselineGroupCount: 3,
    })
    expect(recalc.status).toBe(CommandResultStatus.COMMITTED)
    const data = recalc.data as { version: number; status: string; cl: string; ucl: string; lcl: string }
    expect(data.version).toBe(2)
    expect(data.status).toBe('active')
    // CL=(2.0+2.1+2.2)/3=2.1；σ=sqrt(0.01)=0.1；UCL=2.4
    expect(data.cl).toBe('2.100000')
    expect(data.ucl).toBe('2.400000')
    expect(data.lcl).toBe('1.800000')
    limitVersion2Cl = data.cl

    // 在控样本 → 判定 in_control（绑定判定时点版本 v2）
    const inControl = await exec(nextOp('sic'), 'spc.sample.record', {
      plantId: fx.szPlantId,
      controlItemId,
      source: 'manual_inspection',
      testResultId: fx.testResultStock.resultId,
      measuredValue: '2.1500',
      sampledAt: '2026-10-26T10:00:00Z',
      gaugeId: gaugeGoodId,
    })
    expect(inControl.status).toBe(CommandResultStatus.COMMITTED)
    const jd = (inControl.data as { judgement: { verdict: string; limitVersion: number } | null }).judgement
    expect(jd!.verdict).toBe('in_control')
    expect(jd!.limitVersion).toBe(2)
  })

  it('失控：越限样本 → 判异命中 → 生成处置任务 + 质量存疑提示；不写质量域（PE-12/13）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const holdBefore = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM quality_hold WHERE inventory_unit_id = $1`,
      [fx.testResultStock.unitId],
    )
    const balanceBefore = await pool.query<{ quality_status: string }>(
      `SELECT quality_status FROM stock_balance WHERE unit_id = $1`,
      [fx.testResultStock.unitId],
    )
    const outOfControl = await exec(nextOp('ooc'), 'spc.sample.record', {
      plantId: fx.szPlantId,
      controlItemId,
      source: 'manual_inspection',
      testResultId: fx.testResultStock.resultId,
      measuredValue: '3.5000', // > UCL 2.4
      sampledAt: '2026-10-26T11:00:00Z',
      gaugeId: gaugeGoodId,
      productionOrderId: fx.orderB.id,
      orderOperationId: fx.orderB.reportedOperationId,
      operationSeq: 1,
      equipmentCode: 'EQ-SPC-01',
      shiftDate: '2026-10-26',
    })
    expect(outOfControl.status).toBe(CommandResultStatus.COMMITTED)
    const data = outOfControl.data as {
      judgement: { verdict: string; violatedCodes: string[] } | null
      oocTask: { oocTaskId: string; taskNo: string; qualityDoubtHint: boolean; notifyRoles: string[] } | null
    }
    expect(data.judgement!.verdict).toBe('out_of_control')
    expect(data.judgement!.violatedCodes).toEqual(['point_beyond_limits'])
    expect(data.oocTask).not.toBeNull()
    expect(data.oocTask!.qualityDoubtHint).toBe(true)
    expect(data.oocTask!.notifyRoles).toEqual(['quality', 'process', 'shift_leader'])
    oocTaskId = data.oocTask!.oocTaskId

    // PE-13：SPC 失控≠自动不合格——质量域零写入（隔离/放行/库存质量投影均不变）
    const holdAfter = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM quality_hold WHERE inventory_unit_id = $1`,
      [fx.testResultStock.unitId],
    )
    expect(Number(holdAfter.rows[0]!.count)).toBe(Number(holdBefore.rows[0]!.count))
    const balanceAfter = await pool.query<{ quality_status: string }>(
      `SELECT quality_status FROM stock_balance WHERE unit_id = $1`,
      [fx.testResultStock.unitId],
    )
    expect(balanceAfter.rows[0]?.quality_status ?? null).toBe(balanceBefore.rows[0]?.quality_status ?? null)
    // outbox：失控检出事件（PE-12 通知）
    const outboxRow = await pool.query<{ task_kind: string }>(
      `SELECT task_kind FROM outbox WHERE aggregate_id = $1`,
      [oocTaskId],
    )
    expect(outboxRow.rows[0]!.task_kind).toBe('spc.out-of-control-detected')
  })

  it('失控处置闭环：处置必留记录 → 复控须处置后在控样本支撑（PE-12）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const disposed = await exec(nextOp('od'), 'spc.ooc.dispose', {
      plantId: fx.szPlantId,
      oocTaskId,
      causeCategory: '设备异常',
      correctiveAction: '更换模具并重新对中',
      isolationSuggestion: '建议隔离 2026-10-26 11:00 前后产出',
    })
    expect(disposed.status).toBe(CommandResultStatus.COMMITTED)
    expect((disposed.data as { status: string }).status).toBe('disposed')
    // 已处置任务重复处置 → 拒（失控未处置不得静默关闭；处置留痕不可覆盖）
    const repeat = await exec(nextOp('od2'), 'spc.ooc.dispose', {
      plantId: fx.szPlantId,
      oocTaskId,
      causeCategory: '设备异常',
      correctiveAction: '更换模具并重新对中',
    })
    expect(repeat.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(repeat.errorMessage).toContain('[PE-12]')
    // 处置后无在控样本 → 复控确认拒
    const early = await exec(nextOp('orc0'), 'spc.ooc.confirm-recontrol', {
      plantId: fx.szPlantId,
      oocTaskId,
    })
    expect(early.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(early.errorMessage).toContain('[PE-12]')
    // 处置链可查（PE-12）：任务详情含样本+判定
    const chain = await queries.oocTaskDetail(adminAuth, oocTaskId)
    expect(chain!.task.status).toBe('disposed')
    expect(chain!.sample).not.toBeNull()
    expect(chain!.judgement!.violatedCodes).toContain('point_beyond_limits')
    // 处置后在控样本 → 复控确认
    await exec(nextOp('sic2'), 'spc.sample.record', {
      plantId: fx.szPlantId,
      controlItemId,
      source: 'manual_inspection',
      testResultId: fx.testResultStock.resultId,
      measuredValue: '2.1200',
      sampledAt: '2026-10-26T12:00:00Z',
      gaugeId: gaugeGoodId,
    })
    const confirmed = await exec(nextOp('orc'), 'spc.ooc.confirm-recontrol', {
      plantId: fx.szPlantId,
      oocTaskId,
    })
    expect(confirmed.status).toBe(CommandResultStatus.COMMITTED)
    expect((confirmed.data as { status: string }).status).toBe('re_control_confirmed')
  })

  it('PE-10 控制限重算触发版本化：规则集变更 → 新版本；历史点位不随重算改标', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const judgementsBefore = await pool.query<{ sample_id: string; control_limit_version: number }>(
      `SELECT sample_id, control_limit_version FROM spc_point_judgement WHERE control_item_id = $1 ORDER BY point_no`,
      [controlItemId],
    )
    expect(judgementsBefore.rows.length).toBe(3) // 在控1 + 失控1 + 在控1
    // 规则集变更触发重算 → v3
    const recalc = await exec(nextOp('cl3'), 'spc.control-limit.recalc', {
      plantId: fx.szPlantId,
      controlItemId,
      baselineGroupCount: 3,
      triggerKind: 'rule_set_change',
      triggerRef: 'rule-set-changed',
    })
    expect(recalc.status).toBe(CommandResultStatus.COMMITTED)
    const data = recalc.data as { version: number; triggerKind: string; cl: string }
    expect(data.version).toBe(3)
    expect(data.triggerKind).toBe('rule_set_change')
    // 判定行 append-only：历史点位仍绑定 v2，不随重算改标
    const judgementsAfter = await pool.query<{ sample_id: string; control_limit_version: number }>(
      `SELECT sample_id, control_limit_version FROM spc_point_judgement WHERE control_item_id = $1 ORDER BY point_no`,
      [controlItemId],
    )
    expect(judgementsAfter.rows).toEqual(judgementsBefore.rows)
    expect(judgementsAfter.rows.every((r) => r.control_limit_version === 2)).toBe(true)
    // 库级：控制限版本行不可改（append-only）
    const limitRow = await pool.query<{ id: string }>(
      `SELECT id FROM spc_control_limit_version WHERE control_item_id = $1 AND version = 2`,
      [controlItemId],
    )
    await expect(
      pool.query(`UPDATE spc_control_limit_version SET cl = 9.999999 WHERE id = $1`, [limitRow.rows[0]!.id]),
    ).rejects.toThrow(/append-only/)
    // 新样本按 v3 判定
    const next = await exec(nextOp('sic3'), 'spc.sample.record', {
      plantId: fx.szPlantId,
      controlItemId,
      source: 'manual_inspection',
      testResultId: fx.testResultStock.resultId,
      measuredValue: '2.1300',
      sampledAt: '2026-10-26T13:00:00Z',
      gaugeId: gaugeGoodId,
    })
    const jd = (next.data as { judgement: { limitVersion: number } | null }).judgement
    expect(jd!.limitVersion).toBe(3)
    expect(limitVersion2Cl).toBe('2.100000')
  })

  it('PE-17 检测类任务可排产判定（排产侧等价服务）：失准器具 false', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const ok = await queries.gaugeDetail(adminAuth, gaugeGoodId)
    expect(ok!.calibrationStatus).toBe('valid')
    expect(ok!.schedulableForInspection).toBe(true)
    const badGauge = await queries.gaugeDetail(adminAuth, gaugeBadId)
    expect(badGauge!.calibrationStatus).toBe('invalid')
    expect(badGauge!.schedulableForInspection).toBe(false)
  })
})

describe('④ 失准圈定与逐项处置（PE-18/PE-19）', () => {
  it('圈定：全部实测→检验结论→放行→批次/在制/库存/已发运（只读重建）+ 客诉提示', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const gauge = await pool.query<{ id: string }>(
      `SELECT id FROM spc_gauge WHERE gauge_no = $1`,
      [`G-${run}-BAD`],
    )
    const gaugeBadId = gauge.rows[0]!.id
    // 失准器具出具的三笔实测（在库单元→在制订单 / 已发运单元 / 采集样本）
    const item = await pool.query<{ id: string }>(
      `SELECT id FROM spc_control_item WHERE spec_code = 'INS-CABLE' AND spec_version = 3 AND item_no = 'OD-01'`,
    )
    await exec(nextOp('ms0'), 'spc.sample.record', {
      plantId: fx.szPlantId,
      controlItemId: item.rows[0]!.id,
      source: 'manual_inspection',
      testResultId: fx.testResultStock.resultId, // → INS-STK → MO-B（在制）→ U-SPC-1（在库）
      measuredValue: '2.0700',
      sampledAt: '2026-10-27T07:00:00Z',
      gaugeId: gaugeBadId,
    })
    await exec(nextOp('ms1'), 'spc.sample.record', {
      plantId: fx.szPlantId,
      controlItemId: item.rows[0]!.id,
      source: 'manual_inspection',
      testResultId: fx.testResultShipped.resultId, // → INS-SHP → MO-C（已结束）→ U-SPC-2（已发运）
      measuredValue: '2.0800',
      sampledAt: '2026-10-27T08:00:00Z',
      gaugeId: gaugeBadId,
      // 校准状态可疑 → 被拒，但仍是"该时段该器具出具的全部实测"（圈定口径含被拒）
    })
    await exec(nextOp('ms2'), 'spc.sample.record', {
      plantId: fx.szPlantId,
      controlItemId: item.rows[0]!.id,
      source: 'collection',
      qualityCode: 'good',
      measuredValue: '2.0900',
      sampledAt: '2026-10-27T09:00:00Z',
      gaugeId: gaugeBadId,
    })
    // PE-18 圈定（只读重建）
    const circle = await queries.miscalibrationCircle(
      adminAuth,
      gaugeBadId,
      '2026-10-27T00:00:00Z',
      '2026-10-27T23:59:59Z',
    )
    expect(circle).not.toBeNull()
    // 全部实测（含被拒样本，标注 admission）
    expect(circle!.circle.measurements.length).toBe(3)
    expect(circle!.circle.measurements.every((m) => m.source === 'manual_inspection' || m.source === 'collection')).toBe(true)
    // 关联检验结论（tr-stock → INS-STK / tr-shipped → INS-SHP）
    const conclusionNos = circle!.circle.inspectionConclusions.map((c) => c.inspectionOrderNo)
    expect(conclusionNos).toContain(fx.testResultStock.inspectionOrderNo)
    expect(conclusionNos).toContain(fx.testResultShipped.inspectionOrderNo)
    // 在制/库存/已发运分桶：INS-STK → MO-B 在制 + U-SPC-1 在库；INS-SHP → MO-C 已结束 + U-SPC-2 已发运
    expect(circle!.circle.wipOrders).toEqual([fx.orderB.orderNo])
    expect(circle!.circle.stockUnits.map((u) => u.unitNo)).toContain(fx.testResultStock.unitNo)
    expect(circle!.circle.shippedUnits.map((u) => u.unitNo)).toContain(fx.testResultShipped.unitNo)
    expect(circle!.circle.customerComplaintHints.some((h) => h.unitNo === fx.testResultShipped.unitNo)).toBe(true)
    // 未处置项 pending > 0
    expect(circle!.dispositionProgress.pending).toBeGreaterThan(0)

    // PE-19：逐项处置（隔离 + 已发运项返工报废 → 客诉提示标记）
    const measurementRef = circle!.circle.measurements[0]!.sampleId
    const isolation = await exec(nextOp('ma1'), 'spc.miscalibration.action', {
      plantId: fx.szPlantId,
      gaugeId: gaugeBadId,
      windowFrom: '2026-10-27T00:00:00Z',
      windowTo: '2026-10-27T23:59:59Z',
      itemKind: 'measurement',
      itemRef: measurementRef,
      itemLabel: `样本 ${measurementRef}`,
      actionKind: 'isolation',
    })
    expect(isolation.status).toBe(CommandResultStatus.COMMITTED)
    expect((isolation.data as { customerComplaintHint: boolean }).customerComplaintHint).toBe(false)
    const scrap = await exec(nextOp('ma2'), 'spc.miscalibration.action', {
      plantId: fx.szPlantId,
      gaugeId: gaugeBadId,
      windowFrom: '2026-10-27T00:00:00Z',
      windowTo: '2026-10-27T23:59:59Z',
      itemKind: 'shipped_unit',
      itemRef: fx.testResultShipped.unitNo,
      itemLabel: `已发运单元 ${fx.testResultShipped.unitNo}`,
      actionKind: 'rework_scrap',
    })
    expect(scrap.status).toBe(CommandResultStatus.COMMITTED)
    // PE-19：已发运项处置进入客诉/召回提示范围
    expect((scrap.data as { customerComplaintHint: boolean }).customerComplaintHint).toBe(true)
    // 圈定清单处置进度推进（处置完成前圈定清单不得删除——append-only 天然满足）
    const after = await queries.miscalibrationCircle(
      adminAuth,
      gaugeBadId,
      '2026-10-27T00:00:00Z',
      '2026-10-27T23:59:59Z',
    )
    expect(after!.dispositionProgress.acted).toBe(2)
    expect(after!.dispositionProgress.pending).toBe(circle!.dispositionProgress.pending - 2)
    // PE-18 校准记录不可删（圈定数据源不可破坏）
    await expect(
      pool.query(`DELETE FROM spc_calibration_record WHERE gauge_id = $1`, [gaugeBadId]),
    ).rejects.toThrow(/append-only/)
  })
})

describe('⑤ 工具寿命（PE-20/PE-21/PE-S5）', () => {
  let toolId = ''

  it('登记（版本化配置）+ 累计消耗 + 具名调整（OT-26 显式映射）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const created = await exec(nextOp('t1'), 'spc.tool.register', {
      plantId: fx.szPlantId,
      toolNo: `T-${run}-01`,
      name: 'SPC 演示模具',
      toolKind: 'mold',
      lifeUom: 'count',
      ratedLife: '100.0000',
      warningThreshold: '80.0000',
      expirePolicy: 'block',
    })
    expect(created.status).toBe(CommandResultStatus.COMMITTED)
    toolId = (created.data as { toolId: string }).toolId
    expect((created.data as { configVersion: number }).configVersion).toBe(1)

    // 消耗 ×2（报工产出/采集样本，显式来源引用）
    await exec(nextOp('t2'), 'spc.tool.consume', {
      plantId: fx.szPlantId,
      toolId,
      source: 'work_report_output',
      quantity: '50.0000',
      refType: 'production_report',
      refId: 'report-SPC-B-1',
    })
    const consumed = await exec(nextOp('t3'), 'spc.tool.consume', {
      plantId: fx.szPlantId,
      toolId,
      source: 'collected_sample',
      quantity: '30.0000',
      refType: 'spc_sample',
      refId: 'sample-x',
    })
    expect(consumed.status).toBe(CommandResultStatus.COMMITTED)
    expect((consumed.data as { accumulatedLife: string }).accumulatedLife).toBe('80.0000')

    // 具名调整（理由必填；审计行独立；累计列不动）
    const adjusted = await exec(nextOp('t4'), 'spc.tool.adjust', {
      plantId: fx.szPlantId,
      toolId,
      delta: '-10.0000',
      reason: '登记口径修正：重复计入冲回',
    })
    expect(adjusted.status).toBe(CommandResultStatus.COMMITTED)
    expect((adjusted.data as { accumulatedLife: string }).accumulatedLife).toBe('80.0000')
    expect((adjusted.data as { adjustmentSum: string }).adjustmentSum).toBe('-10.0000')
    // 零调整量（有理由）→ [PE-21] 具名调整量不得为零
    const bad = await exec(nextOp('t5'), 'spc.tool.adjust', {
      plantId: fx.szPlantId,
      toolId,
      delta: '0.0000',
      reason: '零调整无审计意义',
    })
    expect(bad.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(bad.errorMessage).toContain('[PE-21]')
  })

  it('PE-S5/PE-21 库级：累计列只增（静默重置/回退拒）；有效期状态与禁用排产（CS-05 扩展项）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 静默重置 → 触发器拒（PE-21：修正须走具名调整）
    await expect(
      pool.query(`UPDATE spc_tool_ledger SET accumulated_life = 10.0000 WHERE id = $1`, [toolId]),
    ).rejects.toThrow(/PE-21/)
    // 有效寿命 = 累计 80 + 调整 -10 = 70 → normal（预警阈值 80）
    const mid = await queries.toolDetail(adminAuth, toolId)
    expect(mid!.effectiveLife).toBe('70.0000')
    expect(mid!.status).toBe('normal')
    expect(mid!.schedulableForScheduling).toBe(true)
    // 消耗 40 → 累计 120 ≥ 额定 100 → 到期；到期处置=禁用 → 阻止排产（T22 工装约束数据来源）
    await exec(nextOp('t6'), 'spc.tool.consume', {
      plantId: fx.szPlantId,
      toolId,
      source: 'work_report_output',
      quantity: '40.0000',
      refType: 'production_report',
      refId: 'report-SPC-B-2',
    })
    const expired = await queries.toolDetail(adminAuth, toolId)
    expect(expired!.status).toBe('expired')
    expect(expired!.schedulableForScheduling).toBe(false)
    expect(expired!.configHistory.map((c) => c.version)).toEqual([1])
  })

  it('PE-20 配置修订版本化：v2 随版本递增；历史版本 append-only 留痕', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const revised = await exec(nextOp('t7'), 'spc.tool.config-revise', {
      plantId: fx.szPlantId,
      toolId,
      lifeUom: 'count',
      ratedLife: '150.0000',
      warningThreshold: '100.0000',
      expirePolicy: 'degrade',
    })
    expect(revised.status).toBe(CommandResultStatus.COMMITTED)
    expect((revised.data as { configVersion: number }).configVersion).toBe(2)
    const detail = await queries.toolDetail(adminAuth, toolId)
    expect(detail!.tool.ratedLife).toBe('150.0000')
    expect(detail!.configHistory.map((c) => c.version)).toEqual([1, 2])
    // 历史配置行 append-only：直接 UPDATE 拒
    await expect(
      pool.query(`UPDATE spc_tool_config SET rated_life = 999.0000 WHERE tool_id = $1 AND version = 1`, [toolId]),
    ).rejects.toThrow(/append-only/)
    // 到期处置改为降级用后：expired 仍不可排产改为可排产（降级标记由排产域消费）
    expect(detail!.schedulableForScheduling).toBe(true)
  })
})
