import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext } from '@cadenza/application'
import { buildCswCommandBus, buildCswQueryService } from '../../apps/api/src/csw/csw.composition'
import {
  CSW_TEST_DB_NAME,
  CSW_OWNER_ID,
  CSW_OWNER_NAME,
  cswNodeId,
  prepareCswTestDatabase,
  seedCswFixtures,
  type CswFixtures,
} from '../api/csw-test-env'

/**
 * 受约束排程集成（真容器独立库 cadenza_p3b + 真实命令总线与组合根，无业务桩）。
 * 冻结合同 §2/§3 证据（§4 外协见 csw-outsourcing-flow.spec.ts）：
 * ① CS-16/S3 换型矩阵发布与 append-only 守卫
 * ② CS-17/18 交期优先默认序 + 可解释建议（逐任务命中约束/被拒原因）+ 权重随版本留存
 * ③ CS-05②③ 维修/校准硬拒（被拒清单呈现）；CS-10 校准标记已排槽位不删除
 * ④ CS-06① 软约束（超产能）确认提交 + 覆盖审计；CS-04 硬约束提交侧复检
 * ⑤ CS-11/S2 冻结：区间不重叠、重排只读、解冻具名权限+理由留痕
 * ⑥ CS-14 已开工不被自动移动（须人工决策）；CS-15 无解呈现（不静默丢弃）
 * ⑦ CS-13/27 版本链回放比较与历史不被改写
 * ⑧ CS-09 停机占用与维修关闭受影响排程提示（不自动重排）
 * ⑨ CS-25 外协占用（提交侧拦截）
 * ⑩ 幂等：同 operationId 重放原结果
 */

// 引擎确定性锚点（L0 整合轮 2026-10-29 修复）：原硬编码 '2026-10-28' 为跨日时弹——
// csw.calibration.state.set 内部以真实时钟 todayOf（UTC 日历日，同 toISOString().slice(0,10)）
// 圈定 CS-10 标记窗 [today,∞)，硬编码锚跨日即把锚日槽位排除出窗（flaggedSlotIds 空、③ 例红）。
// 改为模块装载时取 UTC 当日，与 todayOf 同口径；夹具全部相对 TODAY 构造（due=T+n、产能=T+i），
// 相对语义零漂移。
const TODAY = new Date().toISOString().slice(0, 10)

/** 相对锚点偏移（UTC 日历日，同 csw-handlers todayOf 口径）：替代原字面日期家族（T+1/T+2/T+5）。 */
const shift = (n: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

let pool: pg.Pool
let cswBus: ReturnType<typeof buildCswCommandBus>
let queries: ReturnType<typeof buildCswQueryService>
let adminCtx: CommandContext
let hfCtx: CommandContext
let fx: CswFixtures
let dbAvailable = true
const run = `csw${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

let opSeq = 0
function nextOp(tag: string): string {
  opSeq += 1
  return `${run}-${tag}-${opSeq}`
}
const envelope = (operationId: string, commandType: string, payload: Record<string, unknown>): CommandEnvelope => ({
  operationId,
  commandType,
  targetId: 'new',
  expectedRevision: 0,
  payload,
})
async function exec(operationId: string, commandType: string, payload: Record<string, unknown>): Promise<CommandResult> {
  return cswBus.execute(envelope(operationId, commandType, payload), adminCtx)
}

interface CswAuthContexts {
  admin: {
    session: { id: string; expiresAt: string }
    user: { id: string; loginName: string; displayName: string; enterpriseId: string; plantId: string; roleId: string; loginPlatform: never }
    role: { id: string; name: string; alias: string }
    permissions: string[]
    dataScope: { enterpriseWide: boolean; plantIds: string[] }
  }
  hf: {
    session: { id: string; expiresAt: string }
    user: { id: string; loginName: string; displayName: string; enterpriseId: string; plantId: string; roleId: string; loginPlatform: never }
    role: { id: string; name: string; alias: string }
    permissions: string[]
    dataScope: { enterpriseWide: boolean; plantIds: string[] }
  }
}
let authCtxCache: CswAuthContexts | null = null
async function buildAuth(): Promise<CswAuthContexts> {
  if (authCtxCache !== null) return authCtxCache
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  const hf = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'hfadmin01'`,
  )
  authCtxCache = {
    admin: {
      session: { id: 's-admin', expiresAt: '2999-01-01T00:00:00Z' },
      user: {
        id: admin.rows[0]!.id,
        loginName: 'admin',
        displayName: 'admin',
        enterpriseId: admin.rows[0]!.enterprise_id,
        plantId: fx.szPlantId,
        roleId: 'r',
        loginPlatform: 'WEB' as never,
      },
      role: { id: 'r', name: 'sysadmin', alias: 'sysadmin' },
      permissions: ['csw.read', 'csw.post', 'csw.unfreeze'],
      dataScope: { enterpriseWide: true, plantIds: [] },
    },
    hf: {
      session: { id: 's-hf', expiresAt: '2999-01-01T00:00:00Z' },
      user: {
        id: hf.rows[0]!.id,
        loginName: 'hfadmin01',
        displayName: 'hf',
        enterpriseId: hf.rows[0]!.enterprise_id,
        plantId: fx.szPlantId,
        roleId: 'r',
        loginPlatform: 'WEB' as never,
      },
      role: { id: 'r', name: 'plantadmin', alias: 'plantadmin' },
      permissions: ['csw.read'],
      dataScope: { enterpriseWide: false, plantIds: [await cswNodeId(pool, 'PLNT-HF')] },
    },
  }
  return authCtxCache
}

beforeAll(async () => {
  try {
    pool = await prepareCswTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP csw-rescheduling: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${CSW_TEST_DB_NAME}）。`)
    return
  }
  fx = await seedCswFixtures(pool, TODAY)
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  const hf = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'hfadmin01'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  hfCtx = {
    actorUserId: hf.rows[0]!.id,
    actorLoginName: 'hfadmin01',
    enterpriseId: hf.rows[0]!.enterprise_id,
    reason: null,
  }
  cswBus = buildCswCommandBus(pool)
  queries = buildCswQueryService(pool)
})

afterAll(async () => {
  if (pool) await pool.end()
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

async function committed(operationId: string, commandType: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await exec(operationId, commandType, payload)
  expect(r.status).toBe(CommandResultStatus.COMMITTED)
  return (r.data ?? {}) as Record<string, unknown>
}

async function rejected(operationId: string, commandType: string, payload: Record<string, unknown>): Promise<CommandResult> {
  const r = await exec(operationId, commandType, payload)
  expect(r.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
  return r
}

describe('csw 受约束排程（冻结/换型/重排/停机/校准）', () => {
  it('① CS-16/S3 换型矩阵发布版本化 + append-only 守卫（被引用版本 immutable）', async () => {
    if (skipIfNoDb()) return
    const v1 = await committed(nextOp('mtx1'), 'csw.changeover.publish', {
      plantId: fx.szPlantId,
      dimensionKind: 'operation',
      defaultMinutes: 10,
      entries: [
        { fromValue: 'OP-CSW-JX', toValue: 'OP-CSW-SJ', minutes: 30 },
        { fromValue: 'OP-CSW-SJ', toValue: 'OP-CSW-JX', minutes: 25 },
      ],
    })
    expect(v1['versionNo']).toBe(1)
    const v2 = await committed(nextOp('mtx2'), 'csw.changeover.publish', {
      plantId: fx.szPlantId,
      dimensionKind: 'operation',
      defaultMinutes: 12,
      entries: [
        { fromValue: 'OP-CSW-JX', toValue: 'OP-CSW-SJ', minutes: 30 },
        { fromValue: 'OP-CSW-SJ', toValue: 'OP-CSW-JX', minutes: 25 },
        { fromValue: 'OP-CSW-JX', toValue: 'OP-CSW-JX', minutes: 5 },
      ],
    })
    expect(v2['versionNo']).toBe(2) // 严格递增；活动版本＝最大 versionNo
    // 重复条目拒绝（CS-S3）
    const dup = await rejected(nextOp('mtx3'), 'csw.changeover.publish', {
      plantId: fx.szPlantId,
      dimensionKind: 'operation',
      defaultMinutes: 10,
      entries: [
        { fromValue: 'A', toValue: 'B', minutes: 1 },
        { fromValue: 'A', toValue: 'B', minutes: 2 },
      ],
    })
    expect(dup.errorMessage).toContain('CS-S3')
    // append-only 守卫（直接 SQL 改版本行被库级拒绝）
    await expect(
      pool.query(`UPDATE csw_changeover_matrix SET default_minutes = 999 WHERE version_no = 1`),
    ).rejects.toThrow(/append-only/)
    const matrices = await queries.listChangeoverMatrices((await buildAuth()).admin, { plantId: fx.szPlantId })
    expect(matrices.length).toBe(2)
    expect(matrices[0]!.versionNo).toBe(2)
  })

  it('② CS-17/12/18 交期优先默认序 + 逐任务可解释建议 + 权重随版本留存', async () => {
    if (skipIfNoDb()) return
    const propose = await committed(nextOp('prop1'), 'csw.reschedule.propose', {
      plantId: fx.szPlantId,
      today: TODAY,
    })
    const items = propose['items'] as Array<Record<string, unknown>>
    const summary = propose['summary'] as Record<string, number>
    expect(summary['newSlots']).toBeGreaterThanOrEqual(3)
    // 交期优先：ORD-2（due T+1）先于 ORD-1（due T+3）落位
    const ord2 = items.find((i) => i['orderNo'] === 'CSW-SZ-002' && i['action'] === 'new')!
    const ord1 = items.find((i) => i['orderNo'] === 'CSW-SZ-001' && i['action'] === 'new')!
    expect(ord2['equipmentId']).toBe(fx.eqAId)
    expect(ord2['productionDate']).toBe(TODAY)
    // ORD-1（束绞）：换型计入 → 次日（无前序换型）成本低于同日（JX→SJ 30 分钟）
    expect(ord1['equipmentId']).toBe(fx.eqAId)
    expect(ord1['productionDate']).toBe(shift(1)) // 次日（无前序换型）
    // CS-12 可解释：逐任务 why/命中约束/被拒清单（维修设备 B 被拒原因呈现）
    const explanation = ord2['explanation'] as Record<string, unknown>
    expect(String(explanation['why'])).toContain('交期优先')
    const rejectedAlts = explanation['rejectedAlternatives'] as Array<Record<string, unknown>>
    expect(rejectedAlts.some((r) => String(r['reason']).includes('维修'))).toBe(true)
    expect(rejectedAlts.some((r) => r['equipmentId'] === fx.eqBRepairId)).toBe(true)
    // CS-27 权重与窗口随版本留存
    const versions = await queries.listVersions((await buildAuth()).admin, { plantId: fx.szPlantId })
    const version = versions.items.find((v) => String(propose['versionId']) === v.id)!
    expect(version.weights).toEqual({ dueDate: '0.5000', changeover: '0.3000', loadBalance: '0.2000' })
    expect(version.horizonDays).toBe(7)
    expect(version.horizonFrom).toBe(TODAY)
    expect(version.matrixVersionId).not.toBeNull() // 矩阵版本引用随排程版本留存（测试①发布）
  })

  it('③ CS-05②/CS-10 校准失效硬拒被拒清单 + 已排槽位标记不删除；CS-06① 软约束确认提交', async () => {
    if (skipIfNoDb()) return
    // 在 C 上直插一条既有槽位（等价上游 T09 保存），然后置校准失准 → 标记但不删除（CS-10）
    const slot = await pool.query<{ id: string }>(
      `INSERT INTO schedule_slot (enterprise_id, plant_id, order_id, order_operation_id, operation_definition_id,
         equipment_id, production_date, planned_qty, uom, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,'M','seed-csw') RETURNING id`,
      [fx.enterpriseId, fx.szPlantId, fx.order2Id, fx.order2OpId, fx.opDefJxId, fx.eqCCalibId, TODAY, '20.0000'],
    )
    const slotId = slot.rows[0]!.id
    const cal = await committed(nextOp('cal1'), 'csw.calibration.state.set', {
      plantId: fx.szPlantId,
      equipmentId: fx.eqCCalibId,
      calibrationResult: 'invalid',
      validUntil: null,
    })
    expect(cal['flaggedSlotIds']).toEqual([slotId]) // CS-10 标记提示
    const stillThere = await pool.query(`SELECT id FROM schedule_slot WHERE id = $1`, [slotId])
    expect(stillThere.rowCount).toBe(1) // 已排槽位不自动删除
    // 建议侧：C 的候选被拒（calibration_invalid 呈现于被拒清单）
    const propose = await committed(nextOp('prop2'), 'csw.reschedule.propose', {
      plantId: fx.szPlantId,
      today: TODAY,
    })
    const items = propose['items'] as Array<Record<string, unknown>>
    const anyNew = items.find((i) => i['action'] === 'new')
    expect(anyNew).toBeDefined()
    expect(anyNew!['equipmentId']).not.toBe(fx.eqCCalibId) // 校准失效设备不获新排产
    // ORD-5（设备 D 产能 100、需求 150）→ 超产能软约束
    const ord5 = items.find((i) => i['orderNo'] === 'CSW-SZ-005' && i['action'] === 'new')!
    const soft = ord5['softViolations'] as Array<Record<string, unknown>>
    expect(soft.some((s) => s['code'] === 'capacity_overrun')).toBe(true)
  })

  it('④ CS-06/CS-04 软约束须确认+理由后提交（覆盖审计留痕）；硬约束提交侧复检', async () => {
    if (skipIfNoDb()) return
    const propose = await committed(nextOp('prop3'), 'csw.reschedule.propose', {
      plantId: fx.szPlantId,
      today: TODAY,
    })
    const versionId = propose['versionId'] as string
    // 软约束未确认 → 拒
    const r1 = await rejected(nextOp('cmt1'), 'csw.reschedule.commit', { versionId })
    expect(r1.errorMessage).toContain('CS-06')
    // 确认但无理由 → 拒（CS-04）
    const r2 = await rejected(nextOp('cmt2'), 'csw.reschedule.commit', { versionId, confirm: true })
    expect(r2.errorMessage).toContain('CS-04')
    // 确认 + 理由 → 提交成功
    const commit = await committed(nextOp('cmt3'), 'csw.reschedule.commit', {
      versionId,
      confirm: true,
      reason: '插单赶工，超产能已与车间确认加班',
    })
    expect(commit['status']).toBe('committed')
    expect(commit['applied']).toMatchObject({ new: expect.any(Number), moved: expect.any(Number), removed: expect.any(Number) })
    // 槽位真实落库（T09 表）
    const slots = await pool.query(
      `SELECT order_id, equipment_id, production_date, planned_qty FROM schedule_slot ORDER BY production_date, equipment_id`,
    )
    expect(slots.rows.length).toBeGreaterThanOrEqual(3)
    // 覆盖审计：soft_constraint_confirm 行（操作者/理由/影响清单）
    const audit = await queries.listOverrideAudit((await buildAuth()).admin, { plantId: fx.szPlantId })
    const softRow = audit.items.find((a) => a.overrideType === 'soft_constraint_confirm')!
    expect(softRow.operator).toBe('admin')
    expect(softRow.reason).toContain('加班')
    expect(softRow.affectedTasks.length).toBeGreaterThan(0)
  })

  it('⑤ CS-11/S2 冻结窗口：重叠拒、重排只读（提交侧拦截）、解冻具名权限+理由留痕', async () => {
    if (skipIfNoDb()) return
    // 新订单 ORD-7（绞线，offline 90，due T+1）保证本轮有待排任务
    const ord7 = await pool.query<{ id: string }>(
      `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, material_snapshot,
         production_dept_id, production_qty, uom, order_status, process_config_status, process_confirmed_at,
         planned_finish_at, created_by)
       VALUES ($1,$2,'CSW-SZ-007',$3,$4::jsonb,$5,'500','M','released','configured',now(),$6,'seed-csw') RETURNING id`,
      [fx.enterpriseId, fx.szPlantId, fx.materialId, JSON.stringify({ code: 'MAT-CSW-CU', name: '排程外协测试铜缆', spec: 'YJV-3x70' }), fx.szDeptId, `${shift(1)}T00:00:00Z`],
    )
    await pool.query(
      `INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, settings_version, execution_status,
         operation_definition_id, operation_code, operation_name, core_multiple, offline_qty, work_center_id,
         work_center_code, work_center_name, uom, production_dept_id, created_by)
       VALUES ($1,$2,$3,1,1,'pending',$4,'OP-CSW-JX','绞线',1,'90',$5,'WC-CSW','排程外协测试工作中心','M',$6,'seed-csw') RETURNING id`,
      [fx.enterpriseId, fx.szPlantId, ord7.rows[0]!.id, fx.opDefJxId, fx.wc1Id, fx.szDeptId],
    )
    const propose = await committed(nextOp('prop4'), 'csw.reschedule.propose', { plantId: fx.szPlantId, today: TODAY })
    const ord7Item = (propose['items'] as Array<Record<string, unknown>>).find((i) => i['orderNo'] === 'CSW-SZ-007' && i['action'] === 'new')!
    expect(ord7Item).toBeDefined()
    const targetDate = ord7Item['productionDate'] as string
    const targetEq = ord7Item['equipmentId'] as string
    // 冻结（设备×生产日期；建议目标位落窗）+ 区间重叠拒（CS-S2）
    const f1 = await committed(nextOp('frz1'), 'csw.freeze.create', {
      plantId: fx.szPlantId,
      equipmentId: targetEq,
      scope: 'equipment_date_range',
      productionDateFrom: targetDate,
      productionDateTo: targetDate,
      reason: '产线已有客户锁定排产',
    })
    const overlap = await rejected(nextOp('frz2'), 'csw.freeze.create', {
      plantId: fx.szPlantId,
      equipmentId: targetEq,
      scope: 'equipment_date_range',
      productionDateFrom: targetDate,
      productionDateTo: shift(5),
    })
    expect(overlap.errorMessage).toContain('CS-S2')
    // 提交侧拦截：建议目标在冻结窗口 → 硬拒（CS-11）
    const commitFrozen = await rejected(nextOp('cmt-frz'), 'csw.reschedule.commit', {
      versionId: propose['versionId'],
      confirm: true,
      reason: '冻结期提交尝试',
    })
    expect(commitFrozen.errorMessage).toContain('CS-11')
    // 解冻无理由拒
    const noReason = await rejected(nextOp('frz3'), 'csw.freeze.release', { freezeId: f1['freezeId'] })
    expect(noReason.errorMessage).toContain('CS-11')
    // 无 csw.unfreeze 许可的账号（hfadmin01）解冻 → 二道防线拒
    const r = await cswBus.execute(
      envelope(nextOp('frz4'), 'csw.freeze.release', { freezeId: f1['freezeId'], reason: '越权尝试' }),
      hfCtx,
    )
    expect(r.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(r.errorMessage).toContain('CS-11')
    // 后续建议：冻结 (设备,日期) 不获自动排产
    const propose2 = await committed(nextOp('prop4b'), 'csw.reschedule.propose', { plantId: fx.szPlantId, today: TODAY })
    for (const item of propose2['items'] as Array<Record<string, unknown>>) {
      if ((item['action'] === 'new' || item['action'] === 'move') && item['equipmentId'] === targetEq) {
        expect(item['productionDate']).not.toBe(targetDate) // 冻结 (设备,日期) 不获自动排产
      }
    }
    // 解冻（具名权限+理由）→ ended + 覆盖审计 unfreeze 行 + 提交可过
    const release = await committed(nextOp('frz5'), 'csw.freeze.release', {
      freezeId: f1['freezeId'],
      reason: '客户锁定解除，恢复重排',
    })
    expect(release['status']).toBe('ended')
    await committed(nextOp('cmt-frz2'), 'csw.reschedule.commit', {
      versionId: propose['versionId'],
      confirm: true,
      reason: '解冻后提交',
    })
    const audit = await queries.listOverrideAudit((await buildAuth()).admin, { plantId: fx.szPlantId, overrideType: 'unfreeze' })
    expect(audit.items.length).toBe(1)
    expect(audit.items[0]!.reason).toContain('恢复重排')
    const freezes = await queries.listFreezeRecords((await buildAuth()).admin, { plantId: fx.szPlantId })
    const row = freezes.items.find((x) => x.id === f1['freezeId'])!
    expect(row.status).toBe('ended')
    expect(row.unfrozenBy).toBe('admin')
    expect(row.unfrozenAt).not.toBeNull()
    expect(row.unfreezeReason).toContain('恢复重排')
  })

  it('⑥ CS-14 已开工不被自动移动须人工决策；CS-15 无解呈现不静默丢弃', async () => {
    if (skipIfNoDb()) return
    const propose = await committed(nextOp('prop5'), 'csw.reschedule.propose', {
      plantId: fx.szPlantId,
      today: TODAY,
    })
    const items = propose['items'] as Array<Record<string, unknown>>
    // ORD-3 已开工工序：conflict + needManual（余量不被自动排产）
    const ord3 = items.find((i) => i['orderNo'] === 'CSW-SZ-003' && i['action'] === 'conflict')!
    expect(ord3['needManual']).toBe(true)
    // ORD-6 全设备维修：conflict + 建议（放开工期/换设备/外协）
    const ord6 = items.find((i) => i['orderNo'] === 'CSW-SZ-006' && i['action'] === 'conflict')!
    const suggestions = ord6['suggestions'] as Array<Record<string, unknown>>
    expect(suggestions.map((s) => s['option'])).toEqual(expect.arrayContaining(['delay_start', 'change_equipment', 'outsourcing']))
    const explanation = ord6['explanation'] as Record<string, unknown>
    expect(explanation['conflictSet']).toBeDefined()
    // 冲突条目不可被提交覆盖（CS-15：走处置通道）
    const conflictNo = ord3['itemNo'] as number
    const commitTry = await rejected(nextOp('cmt4'), 'csw.reschedule.commit', {
      versionId: propose['versionId'],
      confirm: true,
      reason: '尝试覆盖冲突条目',
      overrides: [{ itemNo: conflictNo, equipmentId: fx.eqAId, productionDate: TODAY, plannedQty: '100' }],
    })
    expect(commitTry.errorMessage).toContain('CS-15')
    // 未提交版本可废弃（proposed→superseded 由版本链承担，提交另一版本时验证）
  })

  it('⑦ CS-13/27 版本链提交/superseded/回放比较；历史版本条目不被改写', async () => {
    if (skipIfNoDb()) return
    const p1 = await committed(nextOp('prop6'), 'csw.reschedule.propose', { plantId: fx.szPlantId, today: TODAY })
    const c1 = await committed(nextOp('cmt5'), 'csw.reschedule.commit', {
      versionId: p1['versionId'],
      confirm: true,
      reason: '第二轮排产提交（版本链证据）',
    })
    expect(c1['versionNo']).toBe(p1['versionNo'])
    // 再提议 → parent 指向已提交版本；提交后旧版本 superseded（CS-27）
    const p2 = await committed(nextOp('prop7'), 'csw.reschedule.propose', { plantId: fx.szPlantId, today: TODAY })
    const detail2 = await queries.versionDetail((await buildAuth()).admin, p2['versionId'] as string)
    expect(detail2!.version.parentVersionId).toBe(p1['versionId'])
    await committed(nextOp('cmt6'), 'csw.reschedule.commit', {
      versionId: p2['versionId'],
      confirm: true,
      reason: '第二轮提交',
    })
    const detail1 = await queries.versionDetail((await buildAuth()).admin, p1['versionId'] as string)
    expect(detail1!.version.status).toBe('superseded')
    // 回放并排比较（CS-13）：子版本与父版本条目并排
    const compare = await queries.versionCompare((await buildAuth()).admin, p2['versionId'] as string)
    expect(compare!.parent!.id).toBe(p1['versionId'])
    expect(compare!.changedItems.length).toBeGreaterThan(0)
    // 历史版本条目 append-only（库级触发器）；版本头事实列不可改（状态列推进由上方正常提交流实证）；覆盖审计 append-only
    const firstItem = await pool.query<{ id: string }>(`SELECT id FROM csw_schedule_version_item WHERE version_id = $1 LIMIT 1`, [p1['versionId']])
    await expect(
      pool.query(`UPDATE csw_schedule_version_item SET planned_qty = 1 WHERE id = $1`, [firstItem.rows[0]!.id]),
    ).rejects.toThrow(/append-only/)
    await expect(
      pool.query(`UPDATE csw_schedule_version SET horizon_days = 30 WHERE id = $1`, [p1['versionId']]),
    ).rejects.toThrow(/CS-27/)
    await expect(
      pool.query(`UPDATE csw_schedule_version SET weights_json = '{"dueDate":"1"}' WHERE id = $1`, [p1['versionId']]),
    ).rejects.toThrow(/CS-27/)
    const auditRow = await pool.query<{ id: string }>(`SELECT id FROM csw_override_audit LIMIT 1`)
    await expect(
      pool.query(`UPDATE csw_override_audit SET reason = '篡改' WHERE id = $1`, [auditRow.rows[0]!.id]),
    ).rejects.toThrow(/append-only/)
    // 人工覆盖建议：覆盖 + 理由 → manual_over_suggestion 审计行（CS-13）
    const p3 = await committed(nextOp('prop8'), 'csw.reschedule.propose', { plantId: fx.szPlantId, today: TODAY })
    const items3 = (p3['items'] as Array<Record<string, unknown>>).filter((i) => i['action'] === 'new' || i['action'] === 'move')
    const target = items3[0]!
    await committed(nextOp('cmt7'), 'csw.reschedule.commit', {
      versionId: p3['versionId'],
      confirm: true,
      reason: '人工调整设备落位',
      overrides: [{ itemNo: target['itemNo'] as number, equipmentId: target['equipmentId'] as string, productionDate: shift(5), plannedQty: target['plannedQty'] as string }],
    })
    const audit = await queries.listOverrideAudit((await buildAuth()).admin, { plantId: fx.szPlantId, overrideType: 'manual_over_suggestion' })
    expect(audit.items.length).toBe(1)
    expect(audit.items[0]!.affectedTasks).toEqual([`item#${target['itemNo']}`])
  })

  it('⑧ CS-09 停机占用设备能力 + 维修关闭受影响排程计划评估提示（不自动重排）', async () => {
    if (skipIfNoDb()) return
    const d1 = await committed(nextOp('dt1'), 'csw.downtime.register', {
      plantId: fx.szPlantId,
      equipmentId: fx.eqAId,
      kind: 'repair',
      fromAt: shift(5),
      toAt: shift(5),
      note: '主轴维修',
    })
    // 新订单 ORD-8（绞线，offline 60）
    const ord8 = await pool.query<{ id: string }>(
      `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, material_snapshot,
         production_dept_id, production_qty, uom, order_status, process_config_status, process_confirmed_at,
         planned_finish_at, created_by)
       VALUES ($1,$2,'CSW-SZ-008',$3,$4::jsonb,$5,'300','M','released','configured',now(),$6,'seed-csw') RETURNING id`,
      [fx.enterpriseId, fx.szPlantId, fx.materialId, JSON.stringify({ code: 'MAT-CSW-CU', name: '排程外协测试铜缆', spec: 'YJV-3x70' }), fx.szDeptId, `${shift(2)}T00:00:00Z`],
    )
    await pool.query(
      `INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, settings_version, execution_status,
         operation_definition_id, operation_code, operation_name, core_multiple, offline_qty, work_center_id,
         work_center_code, work_center_name, uom, production_dept_id, created_by)
       VALUES ($1,$2,$3,1,1,'pending',$4,'OP-CSW-JX','绞线',1,'60',$5,'WC-CSW','排程外协测试工作中心','M',$6,'seed-csw')`,
      [fx.enterpriseId, fx.szPlantId, ord8.rows[0]!.id, fx.opDefJxId, fx.wc1Id, fx.szDeptId],
    )
    const propose = await committed(nextOp('prop9'), 'csw.reschedule.propose', { plantId: fx.szPlantId, today: TODAY })
    const items = propose['items'] as Array<Record<string, unknown>>
    for (const item of items) {
      if ((item['action'] === 'new' || item['action'] === 'move') && item['equipmentId'] === fx.eqAId) {
        expect(item['productionDate']).not.toBe(shift(5)) // 全日停机不获自动排产
      }
    }
    // 人工覆盖落到停机日（人工决策通道），提交后关闭停机 → 受影响槽位清单（提示，不自动重排）
    const ord8Item = items.find((i) => i['orderNo'] === 'CSW-SZ-008' && i['action'] === 'new')!
    await committed(nextOp('cmt8'), 'csw.reschedule.commit', {
      versionId: propose['versionId'],
      confirm: true,
      reason: '停机计划顺延一天，人工落位停机日',
      overrides: [{ itemNo: ord8Item['itemNo'] as number, equipmentId: fx.eqAId, productionDate: shift(5), plannedQty: ord8Item['plannedQty'] as string }],
    })
    const before = await pool.query(`SELECT id FROM schedule_slot WHERE equipment_id = $1 AND production_date = $2`, [fx.eqAId, shift(5)])
    expect(before.rowCount).toBeGreaterThanOrEqual(1)
    const closed = await committed(nextOp('dt2'), 'csw.downtime.close', { downtimeId: d1['downtimeId'] })
    const impacted = closed['impactedSlotIds'] as string[]
    expect(impacted.length).toBe(before.rowCount) // 圈定口径＝停机窗口内该设备全部槽位
    expect(impacted).toEqual(before.rows.map((r) => (r as { id: string }).id))
    const after = await pool.query(`SELECT id FROM schedule_slot WHERE equipment_id = $1 AND production_date = $2`, [fx.eqAId, shift(5)])
    expect(after.rowCount).toBe(before.rowCount) // 不自动重排（槽位原样）
  })

  it('⑨ CS-25 外协占用：已提交建议在工序转入外协占用后提交被硬拒', async () => {
    if (skipIfNoDb()) return
    // 新订单 ORD-9（绞线，offline 70）——未排产余量
    const ord9 = await pool.query<{ id: string }>(
      `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, material_snapshot,
         production_dept_id, production_qty, uom, order_status, process_config_status, process_confirmed_at,
         planned_finish_at, created_by)
       VALUES ($1,$2,'CSW-SZ-009',$3,$4::jsonb,$5,'400','M','released','configured',now(),$6,'seed-csw') RETURNING id`,
      [fx.enterpriseId, fx.szPlantId, fx.materialId, JSON.stringify({ code: 'MAT-CSW-CU', name: '排程外协测试铜缆', spec: 'YJV-3x70' }), fx.szDeptId, `${shift(5)}T00:00:00Z`],
    )
    const ord9Op = await pool.query<{ id: string }>(
      `INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, settings_version, execution_status,
         operation_definition_id, operation_code, operation_name, core_multiple, offline_qty, work_center_id,
         work_center_code, work_center_name, uom, production_dept_id, created_by)
       VALUES ($1,$2,$3,1,1,'pending',$4,'OP-CSW-JX','绞线',1,'70',$5,'WC-CSW','排程外协测试工作中心','M',$6,'seed-csw') RETURNING id`,
      [fx.enterpriseId, fx.szPlantId, ord9.rows[0]!.id, fx.opDefJxId, fx.wc1Id, fx.szDeptId],
    )
    const ord9OpId = ord9Op.rows[0]!.id
    const propose = await committed(nextOp('prop10'), 'csw.reschedule.propose', { plantId: fx.szPlantId, today: TODAY })
    const ord4Item = (propose['items'] as Array<Record<string, unknown>>).find((i) => i['orderNo'] === 'CSW-SZ-009' && i['action'] === 'new')
    expect(ord4Item).toBeDefined() // 建议时未占用
    // 创建并提交外协任务（进入占用态 pending_send）
    const t = await committed(nextOp('owt1'), 'csw.outsourcing.create', {
      orderOperationId: ord9OpId,
      supplierName: '外协加工一厂',
      qty: '70.0000',
      transitLocationId: fx.transitLocationId,
      transitLocationCode: fx.transitLocationCode,
      returnLocationId: fx.returnLocationId,
      returnLocationCode: fx.returnLocationCode,
    })
    await committed(nextOp('owt2'), 'csw.outsourcing.submit', { taskId: t['taskId'] })
    // 提交侧复检：外协占用 → 硬拒（CS-25）
    const commitTry = await rejected(nextOp('cmt9'), 'csw.reschedule.commit', {
      versionId: propose['versionId'],
      confirm: true,
      reason: '占用后提交',
    })
    expect(commitTry.errorMessage).toContain('CS-25')
    // 后续建议：该工序呈现外协占用冲突（不排本厂设备）
    const propose2 = await committed(nextOp('prop11'), 'csw.reschedule.propose', { plantId: fx.szPlantId, today: TODAY })
    const ord4Conflict = (propose2['items'] as Array<Record<string, unknown>>).find((i) => i['orderNo'] === 'CSW-SZ-009' && i['action'] === 'conflict')
    expect(ord4Conflict).toBeDefined()
    expect(String((ord4Conflict!['explanation'] as Record<string, unknown>)['why'])).toContain('CS-25')
  })

  it('⑩ CS-07/CS-08 就绪评估（等价服务）：无库存不就绪 → 收货合格后四条件全满足', async () => {
    if (skipIfNoDb()) return
    const auth = await buildAuth()
    const before = await queries.evaluateReadiness(auth.admin, { orderOperationId: fx.order2OpId })
    expect(before!.ready).toBe(false)
    expect(before!.blockers.map((b) => b.rule)).toContain('CS-08') // 无合格可用量
    // 收货合格料（等价 SQL 收货：先建批次——inventory_unit.lot_id 非空，再建单元/合格余额）
    const lot = await pool.query<{ id: string }>(
      `INSERT INTO material_lot (lot_no, kind, material_id, material_code, plant_id, enterprise_id, created_by)
       VALUES ('LOT-CSW-RDY', 'production', $1, 'MAT-CSW-CU', $2, $3, 'seed-csw') RETURNING id`,
      [fx.materialId, fx.szPlantId, fx.enterpriseId],
    )
    await pool.query(
      `INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code, trace_mode, status, plant_id, enterprise_id, created_by)
       VALUES ('CSW-RDY-U1', $1, 'MAT-CSW-CU', $2, '33333333-3333-4333-8333-3333333333c1', 'M', 'quantity', 'in_stock', $3, $4, 'seed-csw')`,
      [fx.materialId, lot.rows[0]!.id, fx.szPlantId, fx.enterpriseId],
    )
    const unit = await pool.query<{ id: string }>(`SELECT id FROM inventory_unit WHERE unit_no = 'CSW-RDY-U1'`)
    await pool.query(
      `INSERT INTO stock_balance (unit_id, location_id, location_code, owner_id, owner_name, quantity, uom_id, uom_code, measurement_basis, quality_status, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, $3, $4, $5, '1000.0000', '33333333-3333-4333-8333-3333333333c1', 'M', 'nominal', 'qualified', $6, $7, 'seed-csw')`,
      [unit.rows[0]!.id, fx.stockLocationId, fx.stockLocationCode, CSW_OWNER_ID, CSW_OWNER_NAME, fx.szPlantId, fx.enterpriseId],
    )
    const after = await queries.evaluateReadiness(auth.admin, { orderOperationId: fx.order2OpId })
    expect(after!.ready).toBe(true)
    expect(after!.materialBasis).toBe('default')
    expect(after!.materialAvailableQty).toBe('1000.0000')
  })

  it('⑪ 幂等：同 operationId 重放原结果（版本不重复建）', async () => {
    if (skipIfNoDb()) return
    const opId = nextOp('idem1')
    const first = await exec(opId, 'csw.reschedule.propose', { plantId: fx.szPlantId, today: TODAY })
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const replay = await exec(opId, 'csw.reschedule.propose', { plantId: fx.szPlantId, today: TODAY })
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect(replay.data).toEqual(first.data)
    const count = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM csw_schedule_version WHERE proposed_by = 'admin'`)
    const firstCount = Number(count.rows[0]!.n)
    await exec(opId, 'csw.reschedule.propose', { plantId: fx.szPlantId, today: TODAY })
    const again = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM csw_schedule_version WHERE proposed_by = 'admin'`)
    expect(Number(again.rows[0]!.n)).toBe(firstCount) // 重放不重复建版本
  })

  it('⑫ 范围二道防线：跨厂 propose 拒（OA-24）', async () => {
    if (skipIfNoDb()) return
    const r = await cswBus.execute(
      envelope(nextOp('scope1'), 'csw.reschedule.propose', { plantId: fx.szPlantId, today: TODAY }),
      hfCtx,
    )
    expect(r.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(r.errorCode).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
  })
})
