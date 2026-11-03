import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext, VerifiedAuthContext } from '@cadenza/application'
import { buildCostCommandBus, buildCostQueryService } from '../../apps/api/src/cost/cost.composition'
import {
  CST_SHIFT_CUTOFF,
  CST_SHIFT_DATE,
  COST_TEST_DB_NAME,
  CST_UOM_KG_ID,
  prepareCostTestDatabase,
  seedCostFixtures,
  type CostFixtures,
} from '../api/cost-test-env'

/**
 * T24 能源与制造成本归集 集成（真容器独立库 cadenza_p3d + 真实命令总线与真实组合根，无业务桩）。
 * 冻结合同证据分组（architecture/contracts/frozen/p3/cost-energy.md）：
 * ① 表计与抄表（CE-S3/CE-09）：形状枚举/覆盖成对/一点一计/OT 点位成对/人工抄表幂等时点
 * ② 分摊与价格版本（CE-S2/CE-11/12/14）：公式枚举与参数匹配/版本唯一/价格来源枚举/正单价/同料品一行
 * ③ 首次归集 order1（CE-01/02/03/05/07/09/12/17/18/19 + CA-12/13 默认口径）：
 *    只读业务事实/估算实测两列/唯一来源映射与回算/理论实耗分列/能源实测+估算并存/幂等重放/重复首跑拒
 * ④ order2 首跑（CE-03/CE-09）：无 BOM 估算缺项/覆盖不足估算份额
 * ⑤ 显式重算（CE-11）：新 run+新旧对照/历史 run 零改写/理由必填/无既有归集拒/被引用版本 immutable（CE-S2）
 * ⑥ 工时核对（CA-12·PROPOSED）：报工主源 vs OT 参考源/超阈值提示/不改写报工/确认留痕/提示行守卫
 * ⑦ ERP 对账（CE-15/16/S5）：模拟适配器入站/同键幂等跳过/处置流转三态/终态拒/库级拒删拒改事实列
 * ⑧ OEE 与能源单耗查询（CE-09/CE-10）：标准速度未数值化缺项/分母齐备计算/停机缺项
 * ⑨ 库级 append-only 守卫（CE-02）：读数/归集产出/明细拒改拒删
 * ⑩ 读数回退（CE-03）：换表未建模，不以回退差冒充用量
 *
 * 注意：CA-12（工时主从）/CA-13（折旧口径）断言依赖冻结合同默认口径——PM/Owner
 * 裁定改口径后本组断言随返工小轮调整（依赖默认口径的断言已注明）。
 */

let pool: pg.Pool
let costBus: ReturnType<typeof buildCostCommandBus>
let queries: ReturnType<typeof buildCostQueryService>
let adminCtx: CommandContext
let adminAuth: VerifiedAuthContext
let fx: CostFixtures
let dbAvailable = true
const run = `cst${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

beforeAll(async () => {
  try {
    pool = await prepareCostTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP cost-flow: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${COST_TEST_DB_NAME}）。`)
    return
  }
  fx = await seedCostFixtures(pool)
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
    permissions: ['cost.read', 'cost.post'],
    dataScope: { enterpriseWide: true, plantIds: [] },
  }
  costBus = buildCostCommandBus(pool)
  queries = buildCostQueryService(pool)
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
  return costBus.execute(envelope(operationId, commandType, payload), adminCtx)
}

async function expectReject(
  operationId: string,
  commandType: string,
  payload: Record<string, unknown>,
  rule: string,
): Promise<void> {
  const result = await exec(operationId, commandType, payload)
  expect(result.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
  expect(result.errorCode).toBe(ERROR_CODES.BUSINESS_RULE)
  expect(result.errorMessage).toContain(`[${rule}]`)
}

/** 库级守卫断言：SQL 应抛出含规则码的异常。 */
async function expectSqlGuard(sql: string, values: readonly unknown[], rule: string): Promise<void> {
  await expect(pool.query(sql, values as unknown[])).rejects.toThrow(`[${rule}]`)
}

/** 跨组共享状态（describe 顺序执行，组间传递）。 */
const state: {
  allocV1Id: string
  allocV2Id: string
  priceV1Id: string
  run1Id: string
  run1OpId: string
  run2Id: string
} = { allocV1Id: '', allocV2Id: '', priceV1Id: '', run1Id: '', run1OpId: '', run2Id: '' }

describe('① 表计与抄表（CE-S3/CE-09）', () => {
  let manualMeterId = ''

  it('表计登记：设备级 OT 来源（绑定点位）与设备级人工来源（不绑点位）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const ot = await exec(nextOp('m1'), 'cost.meter.register', {
      plantId: fx.szPlantId,
      meterCode: 'M-CST-01',
      meterName: '成本演示-eq1 电表',
      energyType: 'electric',
      coverageKind: 'equipment',
      equipmentId: fx.eq1Id,
      sampleSource: 'ot',
      otPointId: fx.otMeterPointId,
      uomCode: 'KWH',
    })
    expect(ot.status).toBe(CommandResultStatus.COMMITTED)
    const manual = await exec(nextOp('m2'), 'cost.meter.register', {
      plantId: fx.szPlantId,
      meterCode: 'M-CST-02',
      meterName: '成本演示-eq1 人工水表',
      energyType: 'water',
      coverageKind: 'equipment',
      equipmentId: fx.eq1Id,
      sampleSource: 'manual',
      uomCode: 'T',
    })
    expect(manual.status).toBe(CommandResultStatus.COMMITTED)
    manualMeterId = (manual.data as { meterId: string }).meterId
  })

  it('形状与枚举拒绝：能源类型/覆盖目标成对/OT 点位成对 [CE-S3/CE-09]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await expectReject(nextOp('m3'), 'cost.meter.register', {
      plantId: fx.szPlantId, meterCode: `M-${run}-X1`, energyType: 'steam',
      coverageKind: 'equipment', equipmentId: fx.eq1Id, sampleSource: 'manual', uomCode: 'KWH',
    }, 'CE-S3')
    await expectReject(nextOp('m4'), 'cost.meter.register', {
      plantId: fx.szPlantId, meterCode: `M-${run}-X2`, energyType: 'electric',
      coverageKind: 'equipment', equipmentId: null, sampleSource: 'manual', uomCode: 'KWH',
    }, 'CE-S3')
    await expectReject(nextOp('m5'), 'cost.meter.register', {
      plantId: fx.szPlantId, meterCode: `M-${run}-X3`, energyType: 'electric',
      coverageKind: 'equipment', equipmentId: fx.eq1Id, sampleSource: 'ot', uomCode: 'KWH',
    }, 'CE-09')
    await expectReject(nextOp('m6'), 'cost.meter.register', {
      plantId: fx.szPlantId, meterCode: `M-${run}-X4`, energyType: 'electric',
      coverageKind: 'equipment', equipmentId: fx.eq1Id, sampleSource: 'manual', otPointId: fx.otMeterPointId, uomCode: 'KWH',
    }, 'CE-09')
    // 覆盖目标须唯一：设备级不得同时绑工作中心
    await expectReject(nextOp('m7'), 'cost.meter.register', {
      plantId: fx.szPlantId, meterCode: `M-${run}-X5`, energyType: 'electric',
      coverageKind: 'equipment', equipmentId: fx.eq1Id, workCenterId: fx.jzDeptId, sampleSource: 'manual', uomCode: 'KWH',
    }, 'CE-S3')
  })

  it('重复编码与一点一计拒绝 [CE-S3]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await expectReject(nextOp('m8'), 'cost.meter.register', {
      plantId: fx.szPlantId, meterCode: 'M-CST-01', energyType: 'electric',
      coverageKind: 'equipment', equipmentId: fx.eq1Id, sampleSource: 'manual', uomCode: 'KWH',
    }, 'CE-S3')
    await expectReject(nextOp('m9'), 'cost.meter.register', {
      plantId: fx.szPlantId, meterCode: `M-${run}-X6`, energyType: 'electric',
      coverageKind: 'equipment', equipmentId: fx.eq2Id, sampleSource: 'ot', otPointId: fx.otMeterPointId, uomCode: 'KWH',
    }, 'CE-S3')
  })

  it('人工抄表：读数+时间必填、同抄表时点幂等拒绝、负数拒绝 [CE-09]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const rec = await exec(nextOp('r1'), 'cost.meter.reading.record', {
      plantId: fx.szPlantId,
      meterId: manualMeterId,
      reading: '2050.0000',
      readAt: `${CST_SHIFT_DATE}T07:00:00Z`,
    })
    expect(rec.status).toBe(CommandResultStatus.COMMITTED)
    await expectReject(nextOp('r2'), 'cost.meter.reading.record', {
      plantId: fx.szPlantId,
      meterId: manualMeterId,
      reading: '2060.0000',
      readAt: `${CST_SHIFT_DATE}T07:00:00Z`,
    }, 'CE-09')
    await expectReject(nextOp('r3'), 'cost.meter.reading.record', {
      plantId: fx.szPlantId,
      meterId: manualMeterId,
      reading: '-1.0000',
      readAt: `${CST_SHIFT_DATE}T07:30:00Z`,
    }, 'CE-09')
    await expectReject(nextOp('r4'), 'cost.meter.reading.record', {
      plantId: fx.szPlantId,
      meterId: manualMeterId,
      readAt: `${CST_SHIFT_DATE}T07:30:00Z`,
    }, 'CE-S1') // 必填字段缺失走载荷形状 CE-S1（值域校验走 CE-09，见负数拒绝）
  })

  it('跨厂登记拒绝（A-S1：合肥厂范围向苏州厂登记）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const hf = await pool.query<{ id: string; enterprise_id: string }>(
      `SELECT id, enterprise_id FROM user_account WHERE login_name = 'hfadmin01'`,
    )
    const hfCtx: CommandContext = {
      actorUserId: hf.rows[0]!.id,
      actorLoginName: 'hfadmin01',
      enterpriseId: hf.rows[0]!.enterprise_id,
      reason: null,
    }
    const result = await costBus.execute(
      envelope(nextOp('m10'), 'cost.meter.register', {
        plantId: fx.szPlantId, meterCode: `M-${run}-HF`, energyType: 'electric',
        coverageKind: 'equipment', equipmentId: fx.eq1Id, sampleSource: 'manual', uomCode: 'KWH',
      }),
      hfCtx,
    )
    expect(result.status).toBe(CommandResultStatus.BUSINESS_REJECTION)
    expect(result.errorCode).toBe(ERROR_CODES.FORBIDDEN_SCOPE)
    expect(result.errorMessage).toContain('[A-S1]')
  })
})

describe('② 分摊与价格版本（CE-S2/CE-11/12/14）', () => {
  it('分摊版本 v1（默认 machine_hours）与 v2/v3/v4 创建 [CE-S2/CE-12]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const v1 = await exec(nextOp('a1'), 'cost.allocation-version.create', {
      plantId: fx.szPlantId, versionNo: 1, formula: 'machine_hours',
    })
    expect(v1.status).toBe(CommandResultStatus.COMMITTED)
    state.allocV1Id = (v1.data as { versionId: string }).versionId
    const v2 = await exec(nextOp('a2'), 'cost.allocation-version.create', {
      plantId: fx.szPlantId, versionNo: 2, formula: 'output_qty',
    })
    expect(v2.status).toBe(CommandResultStatus.COMMITTED)
    const v3 = await exec(nextOp('a3'), 'cost.allocation-version.create', {
      plantId: fx.szPlantId, versionNo: 3, formula: 'machine_hours',
    })
    expect(v3.status).toBe(CommandResultStatus.COMMITTED)
    const pw = await exec(nextOp('a4'), 'cost.allocation-version.create', {
      plantId: fx.szPlantId, versionNo: 4, formula: 'power_weight', params: { weights: { [fx.eq1Code]: '2.0', [fx.eq2Code]: '1.0' } },
    })
    expect(pw.status).toBe(CommandResultStatus.COMMITTED)
  })

  it('分摊版本拒绝：版本号重复/公式枚举/参数不匹配 [CE-S2]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await expectReject(nextOp('a5'), 'cost.allocation-version.create', {
      plantId: fx.szPlantId, versionNo: 1, formula: 'machine_hours',
    }, 'CE-S2')
    await expectReject(nextOp('a6'), 'cost.allocation-version.create', {
      plantId: fx.szPlantId, versionNo: 5, formula: 'magic',
    }, 'CE-S2')
    await expectReject(nextOp('a7'), 'cost.allocation-version.create', {
      plantId: fx.szPlantId, versionNo: 6, formula: 'power_weight',
    }, 'CE-S2')
    await expectReject(nextOp('a8'), 'cost.allocation-version.create', {
      plantId: fx.szPlantId, versionNo: 7, formula: 'machine_hours', params: { x: 1 },
    }, 'CE-S2')
  })

  it('价格版本 v1（铜杆/成品/备件全覆盖）创建与拒绝分支 [CE-14]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const p1 = await exec(nextOp('p1'), 'cost.price-version.create', {
      plantId: fx.szPlantId, versionNo: 1, priceSource: 'standard_cost',
      items: [
        { materialCode: 'MAT-CST-COPPER', materialId: fx.copperMaterialId, unitPrice: '12.500000', uomCode: 'KG' },
        { materialCode: 'MAT-CST-FIN', materialId: fx.finMaterialId, unitPrice: '20.000000', uomCode: 'M' },
        { materialCode: 'MAT-CST-SPARE', materialId: fx.spareMaterialId, unitPrice: '0.800000', uomCode: 'PCS' },
      ],
    })
    expect(p1.status).toBe(CommandResultStatus.COMMITTED)
    state.priceV1Id = (p1.data as { versionId: string }).versionId
    expect((p1.data as { items: number }).items).toBe(3)
    // 版本号重复（价格主权归上游，变更须新版本）
    await expectReject(nextOp('p2'), 'cost.price-version.create', {
      plantId: fx.szPlantId, versionNo: 1, priceSource: 'standard_cost',
      items: [{ materialCode: 'MAT-CST-COPPER', unitPrice: '12.500000', uomCode: 'KG' }],
    }, 'CE-14')
    // 来源枚举
    await expectReject(nextOp('p3'), 'cost.price-version.create', {
      plantId: fx.szPlantId, versionNo: 2, priceSource: 'market',
      items: [{ materialCode: 'MAT-CST-COPPER', unitPrice: '12.500000', uomCode: 'KG' }],
    }, 'CE-14')
    // 同料品一行 + 正单价
    await expectReject(nextOp('p4'), 'cost.price-version.create', {
      plantId: fx.szPlantId, versionNo: 3, priceSource: 'erp_actual',
      items: [
        { materialCode: 'MAT-CST-COPPER', unitPrice: '12.500000', uomCode: 'KG' },
        { materialCode: 'MAT-CST-COPPER', unitPrice: '13.000000', uomCode: 'KG' },
      ],
    }, 'CE-14')
    await expectReject(nextOp('p5'), 'cost.price-version.create', {
      plantId: fx.szPlantId, versionNo: 4, priceSource: 'erp_actual',
      items: [{ materialCode: 'MAT-CST-COPPER', unitPrice: '0.000000', uomCode: 'KG' }],
    }, 'CE-14')
    expect(state.allocV1Id).not.toBe('')
    expect(state.priceV1Id).not.toBe('')
  })
})

describe('③ 首次归集 order1（CE-01/02/03/05/07/09/12/17/18/19 + CA-12/13·PROPOSED）', () => {
  let runData: Record<string, unknown> | null = null

  it('归集首跑：只读业务事实（库存写命令零新增，CE-02）+ 估算/实测两列（CE-17）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const stockBefore = await pool.query<{ c: string }>(`SELECT count(*) AS c FROM stock_transaction`)
    const unitBefore = await pool.query<{ c: string }>(`SELECT count(*) AS c FROM inventory_unit`)
    const opId = nextOp('run1')
    state.run1OpId = opId
    const result = await exec(opId, 'cost.acquisition.run', {
      plantId: fx.szPlantId,
      orderId: fx.orderId,
      shiftDate: CST_SHIFT_DATE,
      dataCutoffAt: CST_SHIFT_CUTOFF,
      allocationVersionId: state.allocV1Id,
      priceVersionId: state.priceV1Id,
    })
    expect(result.status).toBe(CommandResultStatus.COMMITTED)
    runData = result.data as Record<string, unknown>
    state.run1Id = runData['runId'] as string
    // CE-02：归集管道无任何库存写命令（表数不变）
    const stockAfter = await pool.query<{ c: string }>(`SELECT count(*) AS c FROM stock_transaction`)
    const unitAfter = await pool.query<{ c: string }>(`SELECT count(*) AS c FROM inventory_unit`)
    expect(Number(stockAfter.rows[0]!.c)).toBe(Number(stockBefore.rows[0]!.c))
    expect(Number(unitAfter.rows[0]!.c)).toBe(Number(unitBefore.rows[0]!.c))
    // outbox：归集完成通知任务落库（同事务）
    const outbox = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM outbox WHERE aggregate_id = $1 AND task_kind = 'cost.acquisition.completed'`,
      [state.run1Id],
    )
    expect(Number(outbox.rows[0]!.c)).toBe(1)
  })

  it('汇总列：估算 1875 / 实测 1726.6 / 机时 2h / 能源实测 150 + 估算 75 + 覆盖率 0.6667（CE-09/CE-12 machine_hours 默认）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    expect(runData).not.toBeNull()
    // CE-17：BOM 1.5×100×12.5=1875（估算列）；实测=材料 130×12.5 + 损耗 5×20 + 备件 2×0.8=1726.6
    expect(runData!['estimateAmount']).toBe('1875.0000')
    expect(runData!['actualAmount']).toBe('1726.6000')
    expect(runData!['estimatePossible']).toBe(true)
    expect(runData!['machineHours']).toBe('2.0000')
    const energy = runData!['energy'] as Record<string, unknown>
    expect(energy['meteredUsage']).toBe('150.0000')
    expect(energy['estimatedUsage']).toBe('75.0000')
    expect(energy['coverageRatio']).toBe('0.6667')
    // CA-12（PROPOSED 默认口径）：工时主源=labor_record
    expect(runData!['laborSource']).toBe('labor_record')
    // CA-13（PROPOSED 默认口径）：设备成本=机时+备件，不含折旧
    expect(runData!['equipmentCostCaliber']).toBe('runtime_hours_plus_spare_parts_excluding_depreciation')
    // CE-19：班次快照锚（消费 0016 shift_snapshot）
    const anchor = runData!['shiftSnapshotAnchor'] as Record<string, unknown>
    expect(anchor['snapshotCount']).toBe(1)
    // CE-18：在制变化（产出未转库存部分）
    expect(runData!['wipChangeQty']).toBe('100.0000')
  })

  it('明细行：六类来源映射 + 源事实回算路径（CE-05/CE-15）+ 理论实耗分列（CE-07）+ 缺价与工资金额出界（CE-01/CE-03）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const detail = (await queries.acquisitionDetail(adminAuth, state.run1Id)) as {
      lines: Array<Record<string, unknown>>
    }
    expect(detail).not.toBeNull()
    const lines = detail.lines
    expect(lines.length).toBe(8)

    const material = lines.find((l) => l['sourceKind'] === 'material')!
    expect(material['sourceTable']).toBe('material_consumption')
    expect(material['sourceFactId']).toBe(fx.consumptionFactId)
    expect(material['valueFlag']).toBe('measured')
    expect(material['quantity']).toBe('130.0000')
    expect(material['theoreticalQuantity']).toBe('150.0000')
    expect(material['varianceQuantity']).toBe('20.0000')
    expect(material['destinationBreakdownMissing']).toBe(true)
    expect(material['unitPrice']).toBe('12.500000')
    expect(material['amount']).toBe('1625.0000')

    const labor = lines.find((l) => l['sourceKind'] === 'labor')!
    expect(labor['sourceTable']).toBe('labor_record')
    expect(labor['sourceFactId']).toBe(fx.laborFactId)
    expect(labor['quantity']).toBe('8.0000')
    expect(labor['uomCode']).toBe('H')
    // CE-01：工资金额出界——工时行金额恒 null
    expect(labor['amount']).toBeNull()

    const scrap = lines.find((l) => l['sourceKind'] === 'scrap')!
    expect(scrap['sourceTable']).toBe('report_output')
    expect(scrap['sourceFactId']).toBe(fx.outputFactId)
    expect(scrap['quantity']).toBe('5.0000')
    expect(scrap['amount']).toBe('100.0000')
    expect((scrap['facts'] as Record<string, unknown>)['destination']).toBe('scrap')

    const equipmentLines = lines.filter((l) => l['sourceKind'] === 'equipment_runtime')
    expect(equipmentLines.length).toBe(2)
    for (const eqLine of equipmentLines) {
      expect(eqLine['sourceTable']).toBe('ot_sample')
      expect(eqLine['valueFlag']).toBe('measured')
      expect(eqLine['quantity']).toBe('1.0000')
      expect(eqLine['uomCode']).toBe('H')
      expect(eqLine['amount']).toBeNull() // CA-13：机时费率未配置（折旧出界），仅归集机时数量
    }
    expect(new Set(equipmentLines.map((l) => l['orderOperationId']))).toEqual(new Set([fx.op1Id, fx.op2Id]))

    const spare = lines.find((l) => l['sourceKind'] === 'spare_part')!
    expect(spare['sourceTable']).toBe('spare_part_usage')
    expect(spare['sourceFactId']).toBe(fx.spareFactId)
    expect(spare['quantity']).toBe('2.0000')
    expect(spare['amount']).toBe('1.6000')

    const energyMeasured = lines.find((l) => l['sourceKind'] === 'energy' && l['valueFlag'] === 'measured')!
    expect(energyMeasured['sourceTable']).toBe('cost_meter_reading')
    expect(energyMeasured['quantity']).toBe('150.0000')
    expect(energyMeasured['uomCode']).toBe('KWH')
    const energyEstimated = lines.find((l) => l['sourceKind'] === 'energy' && l['valueFlag'] === 'estimated')!
    // CE-09：覆盖不足部分按估算外推并显著标注（未覆盖机时 1h×单耗 75 = 75×机时份额 2/3）
    expect(energyEstimated['quantity']).toBe('50.0000')
    const ef = energyEstimated['facts'] as Record<string, unknown>
    expect(ef['basis']).toBe('intensity_extrapolation')
    expect(ef['uncoveredMachineHours']).toBe('1.0000')
  })

  it('订单成本汇总：估算/实测两列并存 + 在制按工序已投入（CE-17/CE-18）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const summary = (await queries.orderCostSummary(adminAuth, fx.orderId)) as Record<string, unknown>
    const estimate = summary['estimate'] as Record<string, unknown>
    expect(estimate['possible']).toBe(true)
    expect(estimate['amount']).toBe('1875.0000')
    const actual = summary['actual'] as Record<string, unknown>
    expect(actual['amount']).toBe('1726.6000')
    expect(actual['laborSource']).toBe('labor_record')
    const wip = summary['wipByOperation'] as Array<Record<string, unknown>>
    const op1Wip = wip.find((w) => w['orderOperationId'] === fx.op1Id)!
    expect(op1Wip['materialQty']).toBe('130.0000')
    expect(op1Wip['materialAmount']).toBe('1625.0000')
    expect(op1Wip['laborHours']).toBe('8.0000')
    expect(wip.find((w) => w['orderOperationId'] === fx.op2Id)).toBeUndefined() // op2 无材料/工时行
  })

  it('幂等重放：同 operationId 返回原结果；重复首跑（新 opId）拒 [CE-11]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const replay = await exec(state.run1OpId, 'cost.acquisition.run', {
      plantId: fx.szPlantId,
      orderId: fx.orderId,
      shiftDate: CST_SHIFT_DATE,
      dataCutoffAt: CST_SHIFT_CUTOFF,
      allocationVersionId: state.allocV1Id,
      priceVersionId: state.priceV1Id,
    })
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect((replay.data as Record<string, unknown>)['runId']).toBe(state.run1Id)
    const count = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM cost_acquisition_run WHERE id = $1`, [state.run1Id],
    )
    expect(Number(count.rows[0]!.c)).toBe(1)
    await expectReject(nextOp('run1dup'), 'cost.acquisition.run', {
      plantId: fx.szPlantId,
      orderId: fx.orderId,
      shiftDate: CST_SHIFT_DATE,
      dataCutoffAt: CST_SHIFT_CUTOFF,
      allocationVersionId: state.allocV1Id,
      priceVersionId: state.priceV1Id,
    }, 'CE-11')
  })
})

describe('④ order2 首跑：无 BOM 估算缺项 + 覆盖不足估算份额（CE-03/CE-09）', () => {
  it('无已发布 BOM → 估算缺项标注，不以假值冒充 [CE-03]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const result = await exec(nextOp('run2'), 'cost.acquisition.run', {
      plantId: fx.szPlantId,
      orderId: fx.order2Id,
      shiftDate: CST_SHIFT_DATE,
      dataCutoffAt: CST_SHIFT_CUTOFF,
      allocationVersionId: state.allocV1Id,
      priceVersionId: state.priceV1Id,
    })
    expect(result.status).toBe(CommandResultStatus.COMMITTED)
    const data = result.data as Record<string, unknown>
    state.run2Id = data['runId'] as string
    expect(data['estimatePossible']).toBe(false)
    expect(data['estimateAmount']).toBeNull()
    expect(String(data['estimateMissingReason'])).toContain('BOM')
    // order2：eq2 1h 机时；损耗 70×20=1400 为唯一计价行
    expect(data['actualAmount']).toBe('1400.0000')
    expect(data['machineHours']).toBe('1.0000')
    const detail = (await queries.acquisitionDetail(adminAuth, state.run2Id)) as { lines: Array<Record<string, unknown>> }
    const energyEstimated = detail.lines.find((l) => l['sourceKind'] === 'energy' && l['valueFlag'] === 'estimated')!
    // 75 × 机时份额 1/3 = 25（CE-12 machine_hours 默认口径）
    expect(energyEstimated['quantity']).toBe('25.0000')
    expect(detail.lines.find((l) => l['sourceKind'] === 'energy' && l['valueFlag'] === 'measured')).toBeUndefined()
  })

  it('能源单耗查询：覆盖率与单耗可查（CE-09）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const result = await queries.energyIntensity(adminAuth, { plantId: fx.szPlantId, shiftDate: CST_SHIFT_DATE, page: 1, pageSize: 10 })
    const run1Item = result.items.find((i) => i['runId'] === state.run1Id) as Record<string, unknown>
    expect(run1Item).toBeDefined()
    expect(run1Item['meteredUsage']).toBe('150.0000')
    expect(run1Item['estimatedUsage']).toBe('50.0000')
    expect(run1Item['coverageRatio']).toBe('0.7500')
    expect(run1Item['outputQty']).toBe('100.0000')
    expect(run1Item['intensityPerOutput']).toBe('2.0000')
  })
})

describe('⑤ 显式重算与版本 immutable（CE-11/CE-S2）', () => {
  let recalcRunId = ''

  it('重算前置拒绝：无既有归集 / 缺理由 [CE-11]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await expectReject(nextOp('rc0'), 'cost.acquisition.recalc', {
      plantId: fx.szPlantId, orderId: fx.orderId, shiftDate: '2026-10-27',
      dataCutoffAt: '2026-10-27T16:00:00Z', allocationVersionId: state.allocV1Id, priceVersionId: state.priceV1Id,
      reason: '补算',
    }, 'CE-11')
    await expectReject(nextOp('rc0b'), 'cost.acquisition.recalc', {
      plantId: fx.szPlantId, orderId: fx.orderId, shiftDate: CST_SHIFT_DATE,
      dataCutoffAt: CST_SHIFT_CUTOFF, allocationVersionId: state.allocV1Id, priceVersionId: state.priceV1Id,
    }, 'CE-11')
  })

  it('补录事实后显式重算：新 run+新旧对照；历史 run 零改写 [CE-11]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 补录一笔铜杆消耗 10（15:00，cutoff 前）——重算吸收新增事实
    await pool.query(
      `INSERT INTO material_consumption (enterprise_id, plant_id, order_id, order_operation_id, operation_seq,
         report_id, feed_type, inventory_unit_id, unit_no, quantity, before_qty, after_qty, uom_id, uom_code,
         operator_user_id, operator_login, business_time, shift_date, command_receipt_id, created_by)
       VALUES ($1,$2,$3,$4,1,(SELECT report_id FROM material_consumption WHERE id = $5),'report',$6,$7,10.0000,70.0000,60.0000,$8,'KG',$9,'admin','2026-10-26T15:00:00Z',$10,$11,'seed-cst')`,
      [
        fx.enterpriseId, fx.szPlantId, fx.orderId, fx.op1Id, fx.consumptionFactId,
        fx.copperUnitId, fx.copperUnitNo, CST_UOM_KG_ID, fx.adminUserId, CST_SHIFT_DATE, fx.factReceiptId,
      ],
    )
    const v2 = await pool.query<{ id: string }>(
      `SELECT id FROM cost_allocation_version WHERE version_no = 2 AND plant_id = $1`, [fx.szPlantId],
    )
    state.allocV2Id = v2.rows[0]!.id
    const recalc = await exec(nextOp('rc1'), 'cost.acquisition.recalc', {
      plantId: fx.szPlantId,
      orderId: fx.orderId,
      shiftDate: CST_SHIFT_DATE,
      dataCutoffAt: CST_SHIFT_CUTOFF,
      allocationVersionId: state.allocV2Id,
      priceVersionId: state.priceV1Id,
      reason: '新增投料事实+换用产量占比分摊版本，显式重算',
    })
    expect(recalc.status).toBe(CommandResultStatus.COMMITTED)
    const data = recalc.data as Record<string, unknown>
    recalcRunId = data['runId'] as string
    expect(recalcRunId).not.toBe(state.run1Id)
    expect(data['actualAmount']).toBe('1851.6000')
    // CE-11：新旧对照（old=run1 汇总，diff=old−new）
    const comparison = data['oldNewComparison'] as { dimensions: Array<{ dimension: string; old: string; new: string; diff: string | null }> }
    const actualDim = comparison.dimensions.find((d) => d.dimension === 'actualAmount')!
    expect(actualDim.old).toBe('1726.6000')
    expect(actualDim.new).toBe('1851.6000')
    expect(actualDim.diff).toBe('-125.0000')
    expect(comparison.dimensions.find((d) => d.dimension === 'machineHours')!.diff).toBe('0.0000')
    // 历史 run 不随新版本静默重算（CE-11：run1 行 immutable，汇总仍为重算前值）
    const run1Detail = (await queries.acquisitionDetail(adminAuth, state.run1Id)) as { run: Record<string, unknown> }
    expect(run1Detail.run['actualAmount']).toBe('1726.6000')
    expect(run1Detail.run['allocationVersionId']).toBe(state.allocV1Id)
    // 重算产出的 run 挂 recalc_of
    expect(run1Detail.run['recalcOf']).toBeNull()
    const recalcDetail = (await queries.acquisitionDetail(adminAuth, recalcRunId)) as {
      run: Record<string, unknown>
      lines: Array<Record<string, unknown>>
    }
    expect(recalcDetail.run['recalcOf']).toBe(state.run1Id)
    // 产量占比份额：估算能源行 75×(100/1500)=5
    const estLine = recalcDetail.lines.find((l) => l['sourceKind'] === 'energy' && l['valueFlag'] === 'estimated')
    expect((estLine as Record<string, unknown> | undefined)).toBeDefined()
    expect(String((estLine as Record<string, unknown>)['quantity'])).toBe('5.0000')
  })

  it('被归集引用后版本 immutable：分摊/价格版本拒改拒删（CE-S2 库级）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await expectSqlGuard(
      `UPDATE cost_allocation_version SET overhead_caliber = 'x' WHERE id = $1`,
      [state.allocV1Id], 'CE-S2',
    )
    await expectSqlGuard(`DELETE FROM cost_allocation_version WHERE id = $1`, [state.allocV1Id], 'CE-S2')
    await expectSqlGuard(
      `UPDATE cost_price_version SET remark = 'x' WHERE id = $1`, [state.priceV1Id], 'CE-S2',
    )
    await expectSqlGuard(
      `UPDATE cost_price_item SET unit_price = 1 WHERE price_version_id = $1`, [state.priceV1Id], 'CE-S2',
    )
    // 未被引用版本允许修订（retire）——对照证据
    const v3 = await pool.query<{ id: string }>(
      `SELECT id FROM cost_allocation_version WHERE version_no = 3 AND plant_id = $1`, [fx.szPlantId],
    )
    const updated = await pool.query(`UPDATE cost_allocation_version SET status = 'retired' WHERE id = $1`, [v3.rows[0]!.id])
    expect(updated.rowCount).toBe(1)
  })
})

describe('⑥ 工时核对（CA-12·PROPOSED 默认口径：报工主源，OT 仅参考）', () => {
  let checkId = ''

  it('偏差超阈值 → 生成 open 提示；报工工时零改写（主从）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const laborBefore = await pool.query<{ hours: string }>(
      `SELECT hours FROM labor_record WHERE id = $1`, [fx.laborFactId],
    )
    const result = await exec(nextOp('lc1'), 'cost.labor-check.run', {
      plantId: fx.szPlantId, orderId: fx.orderId, shiftDate: CST_SHIFT_DATE,
    })
    expect(result.status).toBe(CommandResultStatus.COMMITTED)
    const data = result.data as { created: Array<Record<string, unknown>>; note: string }
    expect(data.created.length).toBe(1)
    const created = data.created[0]!
    // op1：报工 8h vs OT 运行 2h → 偏差 0.75 > 默认阈值 0.10 → open
    expect(created['operationKey']).toBe(fx.op1Id)
    expect(created['deviationRatio']).toBe('0.7500')
    expect(created['missingSide']).toBeNull()
    checkId = created['checkId'] as string
    const row = await pool.query<{ labor_hours: string; ot_runtime_hours: string; status: string; threshold_ratio: string }>(
      `SELECT labor_hours, ot_runtime_hours, status, threshold_ratio FROM cost_labor_check WHERE id = $1`, [checkId],
    )
    expect(Number(row.rows[0]!.labor_hours)).toBe(8)
    expect(Number(row.rows[0]!.ot_runtime_hours)).toBe(2)
    expect(row.rows[0]!.status).toBe('open')
    expect(row.rows[0]!.threshold_ratio).toBe('0.1000')
    // CA-12 核心口径：提示不改写报工工时
    const laborAfter = await pool.query<{ hours: string }>(
      `SELECT hours FROM labor_record WHERE id = $1`, [fx.laborFactId],
    )
    expect(laborAfter.rows[0]!.hours).toBe(laborBefore.rows[0]!.hours)
  })

  it('重跑核对幂等跳过；确认后不可重复确认；提示行库级守卫', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const rerun = await exec(nextOp('lc2'), 'cost.labor-check.run', {
      plantId: fx.szPlantId, orderId: fx.orderId, shiftDate: CST_SHIFT_DATE,
    })
    const rerunData = rerun.data as { created: unknown[]; skipped: Array<Record<string, unknown>> }
    expect(rerunData.created.length).toBe(0)
    expect(rerunData.skipped.length).toBe(1)
    const ack = await exec(nextOp('lc3'), 'cost.labor-check.acknowledge', {
      plantId: fx.szPlantId, checkId, reason: '班前准备 6h 未报工，已核对确认',
    })
    expect(ack.status).toBe(CommandResultStatus.COMMITTED)
    await expectReject(nextOp('lc4'), 'cost.labor-check.acknowledge', {
      plantId: fx.szPlantId, checkId, reason: '再次确认',
    }, 'CA-12')
    await expectSqlGuard(
      `UPDATE cost_labor_check SET labor_hours = 9 WHERE id = $1`, [checkId], 'CA-12',
    )
    await expectSqlGuard(`DELETE FROM cost_labor_check WHERE id = $1`, [checkId], 'CA-12')
  })

  it('跨北京零点回归（O-3）：UTC 16:00 后的工时/OT 样本按北京班次日归次日核对，不再错位过滤', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    // 事实造数（SQL 直落，同 ⑤ 补录口径）：10-26T18:00Z（北京 10-27 02:00）工时 4h，
    // shift_date 由 IT-37 口径归 2026-10-27；eq1 速度样本 10-26T18:00 起运行 1h（60×60s）
    await pool.query(
      `INSERT INTO labor_record (enterprise_id, plant_id, order_id, order_operation_id, report_id,
         operator_user_id, operator_login, hours, business_time, shift_date, note, created_by)
       VALUES ($1,$2,$3,$4,NULL,$5,'admin',4.00,'2026-10-26T18:00:00Z','2026-10-27','O-3 跨零点回归造数','o3-regression')`,
      [fx.enterpriseId, fx.szPlantId, fx.orderId, fx.op1Id, fx.adminUserId],
    )
    const otRows: unknown[][] = []
    for (let sec = 0; sec < 3600; sec += 60) {
      const t = new Date(Date.parse('2026-10-26T18:00:00Z') + sec * 1000).toISOString()
      otRows.push([
        fx.otSpeedDeviceSerial, 'P-SPD-01', `o3-spd-${sec}`, 100000 + sec, t, t,
        'GW-CST', 120.0, 'M/S', 'good', fx.enterpriseId, fx.szPlantId, t, 'o3-regression',
      ])
    }
    for (let i = 0; i < otRows.length; i += 40) {
      const batch = otRows.slice(i, i + 40)
      const values = batch.map((_, j) => `($${j * 14 + 1},$${j * 14 + 2},$${j * 14 + 3},$${j * 14 + 4},$${j * 14 + 5},$${j * 14 + 6},$${j * 14 + 7},$${j * 14 + 8},$${j * 14 + 9},$${j * 14 + 10},$${j * 14 + 11},$${j * 14 + 12},$${j * 14 + 13},$${j * 14 + 14})`).join(',')
      await pool.query(
        `INSERT INTO ot_sample (device_serial, point_code, event_id, gateway_seq, event_time, received_at,
           gateway_code, raw_value, raw_unit, quality_level, enterprise_id, plant_id, business_time, created_by)
         VALUES ${values}`,
        batch.flat(),
      )
    }
    // 按北京班次日 2026-10-27 核对：工时 4h 与 OT 1h 都应入窗（旧 UTC 零点锚下 OT 窗
    // [10-27T00:00Z,10-27T23:59Z] 漏掉 10-26T18:xx 样本 → missingSide='ot'）
    const result = await exec(nextOp('o3lc'), 'cost.labor-check.run', {
      plantId: fx.szPlantId, orderId: fx.orderId, shiftDate: '2026-10-27',
    })
    expect(result.status).toBe(CommandResultStatus.COMMITTED)
    const data = result.data as { created: Array<Record<string, unknown>> }
    const created = data.created.find((c) => c['operationKey'] === fx.op1Id)!
    expect(created).toBeDefined()
    expect(created['missingSide']).toBeNull()
    const row = await pool.query<{ labor_hours: string; ot_runtime_hours: string; status: string }>(
      `SELECT labor_hours::text, ot_runtime_hours::text, status FROM cost_labor_check WHERE id = $1`,
      [created['checkId']],
    )
    expect(Number(row.rows[0]!.labor_hours)).toBe(4)
    expect(Number(row.rows[0]!.ot_runtime_hours)).toBe(1)
    // 偏差 |1−4|/4 = 0.75 超阈值 → open（两侧均在窗内才可计算，缺侧则 missingSide 非 null）
    expect(row.rows[0]!.status).toBe('open')
  })
})

describe('⑦ ERP 对账（CE-15/16/S5：模拟适配器，真实 ERP BLOCKED_EXTERNAL）', () => {
  let materialItemId = ''
  let energyItemId = ''

  it('对账入站：三维度行落库（具名清单，差异不静默吸收）+ 同键重推幂等跳过 [CE-16]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const result = await exec(nextOp('re1'), 'cost.recon.erp-import', {
      plantId: fx.szPlantId,
      runId: state.run1Id,
      rows: [
        { kind: 'material', localQuantity: '130.0000', erpQuantity: '128.0000', uomCode: 'KG', materialCode: 'MAT-CST-COPPER', erpDocumentRef: 'ERP-PO-88' },
        { kind: 'labor', localQuantity: '8.0000', erpQuantity: '8.0000', uomCode: 'H' },
        { kind: 'energy', localQuantity: '150.0000', erpQuantity: '160.0000', uomCode: 'KWH' },
      ],
    })
    expect(result.status).toBe(CommandResultStatus.COMMITTED)
    const data = result.data as { inserted: Array<Record<string, unknown>>; skipped: unknown[]; adapter: string }
    expect(data.inserted.length).toBe(3)
    expect(data.adapter).toBe('simulated')
    materialItemId = data.inserted.find((i) => String(i['reconKey']).includes('material'))!['itemId'] as string
    energyItemId = data.inserted.find((i) => String(i['reconKey']).includes('energy'))!['itemId'] as string
    const rows = await pool.query<{ kind: string; diff_quantity: string; disposition_status: string; erp_document_ref: string | null }>(
      `SELECT kind, diff_quantity, disposition_status, erp_document_ref FROM cost_recon_item WHERE run_id = $1 ORDER BY kind`,
      [state.run1Id],
    )
    expect(rows.rows.length).toBe(3)
    expect(rows.rows.find((r) => r.kind === 'material')!.diff_quantity).toBe('2.0000')
    expect(rows.rows.find((r) => r.kind === 'material')!.erp_document_ref).toBe('ERP-PO-88')
    expect(rows.rows.find((r) => r.kind === 'energy')!.diff_quantity).toBe('-10.0000')
    // 重推同键 → 幂等跳过
    const again = await exec(nextOp('re2'), 'cost.recon.erp-import', {
      plantId: fx.szPlantId,
      runId: state.run1Id,
      rows: [
        { kind: 'material', localQuantity: '130.0000', erpQuantity: '127.0000', uomCode: 'KG', materialCode: 'MAT-CST-COPPER' },
      ],
    })
    const againData = again.data as { inserted: unknown[]; skipped: Array<Record<string, unknown>> }
    expect(againData.inserted.length).toBe(0)
    expect(againData.skipped.length).toBe(1)
    // 材料维度缺料品 → 回算路径锚点拒绝 [CE-15]
    await expectReject(nextOp('re3'), 'cost.recon.erp-import', {
      plantId: fx.szPlantId, runId: state.run1Id,
      rows: [{ kind: 'material', localQuantity: '1.0000', erpQuantity: '1.0000', uomCode: 'KG' }],
    }, 'CE-15')
  })

  it('处置流转：须理由；confirmed→adjusted 可；adjusted 终态拒 [CE-S5]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await expectReject(nextOp('re4'), 'cost.recon.resolve', {
      plantId: fx.szPlantId, itemId: materialItemId, targetStatus: 'confirmed',
    }, 'CE-S5')
    const confirm = await exec(nextOp('re5'), 'cost.recon.resolve', {
      plantId: fx.szPlantId, itemId: materialItemId, targetStatus: 'confirmed', reason: 'ERP 少记 2KG 投料，业务确认差异成立',
    })
    expect(confirm.status).toBe(CommandResultStatus.COMMITTED)
    const adjust = await exec(nextOp('re6'), 'cost.recon.resolve', {
      plantId: fx.szPlantId, itemId: materialItemId, targetStatus: 'adjusted', reason: '已按 ERP 侧补录单据吸收差异',
    })
    expect(adjust.status).toBe(CommandResultStatus.COMMITTED)
    await expectReject(nextOp('re7'), 'cost.recon.resolve', {
      plantId: fx.szPlantId, itemId: materialItemId, targetStatus: 'confirmed', reason: '回退',
    }, 'CE-S5')
    // open 直达 adjusted（一次性处置）允许
    const direct = await exec(nextOp('re8'), 'cost.recon.resolve', {
      plantId: fx.szPlantId, itemId: energyItemId, targetStatus: 'adjusted', reason: '表计示数误差，按实测修正',
    })
    expect(direct.status).toBe(CommandResultStatus.COMMITTED)
  })

  it('差异清单库级守卫：DELETE 恒拒；事实列不可改（未处置不得清零）[CE-S5]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const open = await pool.query<{ id: string }>(
      `SELECT id FROM cost_recon_item WHERE run_id = $1 AND kind = 'labor'`, [state.run1Id],
    )
    await expectSqlGuard(`DELETE FROM cost_recon_item WHERE id = $1`, [open.rows[0]!.id], 'CE-S5')
    await expectSqlGuard(
      `UPDATE cost_recon_item SET local_quantity = 999 WHERE id = $1`, [open.rows[0]!.id], 'CE-S5',
    )
    await expectSqlGuard(
      `UPDATE cost_recon_item SET disposition_status = 'open' WHERE id = $1 AND disposition_status = 'adjusted'`,
      [materialItemId], 'CE-S5',
    )
  })
})

describe('⑧ OEE 查询（CE-10：分母齐备后才计算）', () => {
  it('标准速度未数值化（GAP-S1 文本）→ 缺项展示而非假百分比', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const result = (await queries.oee(adminAuth, {
      plantId: fx.szPlantId, equipmentCode: fx.eq1Code,
      windowStart: `${CST_SHIFT_DATE}T08:00:00Z`, windowEnd: CST_SHIFT_CUTOFF,
    })) as Record<string, unknown>
    expect(result['stdRateText']).toBe('约200米/分')
    expect(result['standardSpeedPerHour']).toBeNull()
    expect(result['oee']).toBeNull()
    expect(result['availability']).toBeNull()
    expect((result['missing'] as string[])).toContain('standard_speed_not_numeric')
  })

  it('eq2 分母齐备 → 三率与 OEE（480 分计划/60 分停机/200 每小时标准）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const result = (await queries.oee(adminAuth, {
      plantId: fx.szPlantId, equipmentCode: fx.eq2Code,
      windowStart: `${CST_SHIFT_DATE}T08:00:00Z`, windowEnd: CST_SHIFT_CUTOFF,
    })) as Record<string, unknown>
    expect(result['plannedMinutes']).toBe('480.0000')
    expect(result['downtimeMinutes']).toBe('60.0000')
    expect(result['availability']).toBe('0.8750')
    expect(result['performance']).toBe('1.0714')
    expect(result['qualityRate']).toBe('0.9500')
    expect(result['oee']).toBe('0.8906')
    expect(result['missing']).toEqual([])
  })

  it('窗口无停机事实 → 缺项（不以 0 冒充分母）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const result = (await queries.oee(adminAuth, {
      plantId: fx.szPlantId, equipmentCode: fx.eq2Code,
      windowStart: '2026-10-27T08:00:00Z', windowEnd: '2026-10-27T16:00:00Z',
    })) as Record<string, unknown>
    expect(result['downtimeMinutes']).toBeNull()
    expect(result['oee']).toBeNull()
    expect((result['missing'] as string[])).toContain('downtime_missing')
  })
})

describe('⑨ 库级 append-only 守卫（CE-02：归集事实不可改删）', () => {
  it('读数/归集产出/归集明细拒改拒删', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const reading = await pool.query<{ id: string }>(
      `SELECT r.id FROM cost_meter_reading r JOIN cost_meter m ON m.id = r.meter_id WHERE m.meter_code = 'M-CST-02' LIMIT 1`,
    )
    await expectSqlGuard(`UPDATE cost_meter_reading SET reading = 999 WHERE id = $1`, [reading.rows[0]!.id], 'CE-02')
    await expectSqlGuard(`DELETE FROM cost_meter_reading WHERE id = $1`, [reading.rows[0]!.id], 'CE-02')
    await expectSqlGuard(
      `UPDATE cost_acquisition_run SET actual_amount = 0 WHERE id = $1`, [state.run1Id], 'CE-02',
    )
    const line = await pool.query<{ id: string }>(
      `SELECT id FROM cost_acquisition_line WHERE run_id = $1 AND source_kind = 'material' LIMIT 1`, [state.run1Id],
    )
    await expectSqlGuard(`UPDATE cost_acquisition_line SET quantity = 0 WHERE id = $1`, [line.rows[0]!.id], 'CE-02')
    await expectSqlGuard(`DELETE FROM cost_acquisition_line WHERE id = $1`, [line.rows[0]!.id], 'CE-02')
    // 归集明细 source_table 值域 CHECK（CE-S1：来源映射枚举）
    await expect(pool.query(
      `INSERT INTO cost_acquisition_line (run_id, line_no, source_kind, source_table, source_fact_id, value_flag,
         order_id, quantity, uom_code, facts)
       VALUES ($1, 99, 'material', 'magic_table', $2, 'measured', $3, 1, 'KG', '{}')`,
      [state.run1Id, fx.consumptionFactId, fx.orderId],
    )).rejects.toThrow()
  })
})

describe('⑩ 读数回退拒绝（CE-03：换表/回卷未建模，不以回退差冒充用量）', () => {
  it('回退读数入窗后归集拒绝 [CE-03]', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const roll = await exec(nextOp('mr1'), 'cost.meter.register', {
      plantId: fx.szPlantId, meterCode: 'M-CST-ROLL', energyType: 'gas',
      coverageKind: 'equipment', equipmentId: fx.eq1Id, sampleSource: 'manual', uomCode: 'M3',
    })
    expect(roll.status).toBe(CommandResultStatus.COMMITTED)
    const rollMeterId = (roll.data as { meterId: string }).meterId
    const first = await exec(nextOp('mr2'), 'cost.meter.reading.record', {
      plantId: fx.szPlantId, meterId: rollMeterId, reading: '500.0000', readAt: `${CST_SHIFT_DATE}T15:50:00Z`,
    })
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const second = await exec(nextOp('mr3'), 'cost.meter.reading.record', {
      plantId: fx.szPlantId, meterId: rollMeterId, reading: '480.0000', readAt: `${CST_SHIFT_DATE}T15:55:00Z`,
    })
    expect(second.status).toBe(CommandResultStatus.COMMITTED)
    // 再归集（重算）→ 表计回退违反 CE-03，整单拒绝
    await expectReject(nextOp('rc2'), 'cost.acquisition.recalc', {
      plantId: fx.szPlantId, orderId: fx.orderId, shiftDate: CST_SHIFT_DATE,
      dataCutoffAt: CST_SHIFT_CUTOFF, allocationVersionId: state.allocV1Id, priceVersionId: state.priceV1Id,
      reason: '预期拒绝：回退读数',
    }, 'CE-03')
  })
})
