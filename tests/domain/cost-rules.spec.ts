import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALLOCATION_FORMULA,
  DEFAULT_LABOR_CHECK_THRESHOLD,
  EQUIPMENT_COST_CALIBER,
  LABOR_PRIMARY_SOURCE,
  add4,
  allocateByShares,
  amountOf,
  assertAcquisitionInput,
  assertAllocationVersionShape,
  assertMeterReadingShape,
  assertMeterShape,
  assertPriceVersionShape,
  assertReconImportRow,
  assertReconResolvable,
  buildLaborCheck,
  buildOldNewComparison,
  buildReconKey,
  cmp4,
  computeEnergyCoverage,
  computeMaterialVariance,
  computeMeteredUsage,
  computeOee,
  computeReconDiff,
  div4,
  energyIntensityPerHour,
  estimateMaterialFromBom,
  isAutoBackflushAllowed,
  isValidCostDecimal,
  mul4,
  parseScaled,
  resolvePriceForMaterial,
  shiftDayWindow,
  sub4,
  CostRuleViolation,
} from '../../packages/domain/src/cost/index'
import { computeShiftDate } from '../../packages/domain/src/inventory/time'

/**
 * cost 域纯规则单测（CE-01～CE-20 可判定行为 + CA-12/13 PROPOSED 默认口径锚定）。
 * 注意：CA-12（工时主从）/CA-13（折旧口径）断言依赖冻结合同默认口径——PM/Owner
 * 裁定改口径后本组断言随返工小轮调整（依赖默认口径的断言已注明）。
 */

function expectViolation(fn: () => unknown, rule: string): void {
  try {
    fn()
    expect.unreachable(`应抛出 [${rule}] 违例`)
  } catch (error) {
    expect(error).toBeInstanceOf(CostRuleViolation)
    expect((error as CostRuleViolation).rule).toBe(rule)
    expect((error as CostRuleViolation).message).toContain(`[${rule}]`)
  }
}

// ---------------- 定点小数 ----------------

describe('CE-03 定点口径', () => {
  it('add4/sub4/mul4/div4 全程定点无浮点误差', () => {
    expect(add4('0.1000', '0.2000')).toBe('0.3000')
    expect(sub4('1.0000', '0.3333')).toBe('0.6667')
    expect(mul4('3.0000', '1.5000')).toBe('4.5000')
    expect(div4('10.0000', '4.0000')).toBe('2.5000')
    expect(cmp4('0.1000', '0.1001')).toBe(-1)
  })

  it('amountOf 数量×单价 half-up 到 4 位', () => {
    expect(amountOf('100.0000', '12.345678')).toBe('1234.5678')
    expect(amountOf('0.0001', '0.000001')).toBe('0.0000')
  })

  it('parseScaled 拒绝 number/科学计数法/超 6 位小数', () => {
    expect(isValidCostDecimal('1.2345')).toBe(true)
    expect(isValidCostDecimal('1e5')).toBe(false)
    expect(isValidCostDecimal(1.5)).toBe(false)
    expectViolation(() => parseScaled(1.5, 'CE-03'), 'CE-03')
  })
})

// ---------------- CE-S3/CE-09 表计与读数 ----------------

describe('CE-S3 表计配置形状', () => {
  const base = {
    meterCode: 'EM-01',
    energyType: 'electric',
    coverageKind: 'equipment',
    equipmentId: 'eq-1',
    workCenterId: null,
    sampleSource: 'manual',
    otPointId: null,
    uomCode: 'KWH',
  }

  it('合法形状通过', () => {
    expect(() => assertMeterShape(base)).not.toThrow()
    expect(() => assertMeterShape({ ...base, coverageKind: 'workshop', workCenterId: 'wc-1', equipmentId: null })).not.toThrow()
    expect(() => assertMeterShape({ ...base, sampleSource: 'ot', otPointId: 'pt-1' })).not.toThrow()
  })

  it('能源类型/覆盖范围/采样来源枚举与形状校验 [CE-S3]', () => {
    expectViolation(() => assertMeterShape({ ...base, energyType: 'steam' }), 'CE-S3')
    expectViolation(() => assertMeterShape({ ...base, coverageKind: 'line' }), 'CE-S3')
    expectViolation(() => assertMeterShape({ ...base, equipmentId: null }), 'CE-S3')
    expectViolation(() => assertMeterShape({ ...base, coverageKind: 'workshop', workCenterId: null }), 'CE-S3')
    expectViolation(() => assertMeterShape({ ...base, sampleSource: 'ot', otPointId: null }), 'CE-09')
    expectViolation(() => assertMeterShape({ ...base, sampleSource: 'manual', otPointId: 'pt-1' }), 'CE-09')
    expectViolation(() => assertMeterShape({ ...base, uomCode: '' }), 'CE-S3')
  })
})

describe('CE-09 读数与用量', () => {
  it('人工读数形状：读数+时间必填 [CE-09]', () => {
    expect(() => assertMeterReadingShape({ readingType: 'manual', reading: '100.5000', readAt: '2026-10-28T08:00:00Z', readBy: 'op01' })).not.toThrow()
    expectViolation(() => assertMeterReadingShape({ readingType: 'manual', reading: null, readAt: 'x', readBy: 'op' }), 'CE-09')
    expectViolation(() => assertMeterReadingShape({ readingType: 'ot', otSampleId: null }), 'CE-05')
  })

  it('累计读数差=实测用量；单读数用量为 0；乱序按时间排序', () => {
    const usage = computeMeteredUsage([
      { readAt: '2026-10-28T10:00:00Z', reading: '1200.0000' },
      { readAt: '2026-10-28T08:00:00Z', reading: '1000.0000' },
    ])
    expect(usage.usage).toBe('200.0000')
    expect(usage.fromAt).toBe('2026-10-28T08:00:00Z')
    expect(computeMeteredUsage([{ readAt: 'x', reading: '5.0000' }]).usage).toBe('0.0000')
    expect(computeMeteredUsage([]).usage).toBe('0.0000')
  })

  it('读数回退拒绝（换表未建模，不以回退差冒充用量）[CE-03]', () => {
    expectViolation(
      () => computeMeteredUsage([
        { readAt: '2026-10-28T08:00:00Z', reading: '1000.0000' },
        { readAt: '2026-10-28T10:00:00Z', reading: '900.0000' },
      ]),
      'CE-03',
    )
  })

  it('覆盖率=实测/(实测+估算)；总用量零 → null [CE-09]', () => {
    const c1 = computeEnergyCoverage('80.0000', '20.0000')
    expect(c1.coverageRatio).toBe('0.8000')
    expect(computeEnergyCoverage('0.0000', '0.0000').coverageRatio).toBeNull()
    expect(energyIntensityPerHour('80.0000', '0.0000')).toBeNull()
    expect(energyIntensityPerHour('80.0000', '10.0000')).toBe('8.0000')
  })
})

// ---------------- CE-S2/CE-11/CE-12 分摊版本 ----------------

describe('CE-S2/CE-12 分摊版本与分摊计算', () => {
  it('默认公式为 machine_hours（CE-12 合同默认·PROPOSED 依赖 GAP-E21）', () => {
    expect(DEFAULT_ALLOCATION_FORMULA).toBe('machine_hours')
  })

  it('版本形状：枚举/参数匹配 [CE-S2]', () => {
    expect(() => assertAllocationVersionShape({ versionNo: 1, formula: 'machine_hours', params: {} })).not.toThrow()
    expectViolation(() => assertAllocationVersionShape({ versionNo: 0, formula: 'machine_hours' }), 'CE-S2')
    expectViolation(() => assertAllocationVersionShape({ versionNo: 1, formula: 'magic' }), 'CE-S2')
    expectViolation(() => assertAllocationVersionShape({ versionNo: 1, formula: 'machine_hours', params: { x: 1 } }), 'CE-S2')
    expectViolation(() => assertAllocationVersionShape({ versionNo: 1, formula: 'power_weight', params: {} }), 'CE-S2')
    expect(() => assertAllocationVersionShape({ versionNo: 1, formula: 'power_weight', params: { weights: { eq1: '2.5' } } })).not.toThrow()
    expectViolation(() => assertAllocationVersionShape({ versionNo: 1, formula: 'power_weight', params: { weights: { eq1: '0' } } }), 'CE-S2')
  })

  it('按占比分摊：和恒等于总量（舍入余量归最大份额）[CE-12]', () => {
    const lines = allocateByShares('100.0000', [
      { key: 'op1', share: '1.0000' },
      { key: 'op2', share: '1.0000' },
      { key: 'op3', share: '1.0000' },
    ])
    const sum = lines.reduce((acc, l) => add4(acc, l.amount), '0.0000')
    expect(sum).toBe('100.0000')
    expect(lines.map((l) => l.key)).toEqual(['op1', 'op2', 'op3'])
    expect(allocateByShares('10.0000', [])).toEqual([])
    expectViolation(() => allocateByShares('10.0000', [{ key: 'a', share: '0.0000' }]), 'CE-S2')
    expectViolation(() => allocateByShares('10.0000', [{ key: 'a', share: '-1.0000' }]), 'CE-S2')
  })

  it('CE-11：显式重算新旧对照逐项列差值', () => {
    const comparison = buildOldNewComparison(
      { runId: 'r1', estimateAmount: '100.0000', actualAmount: '80.0000', lineCount: 5, energyUsage: '50.0000', machineHours: '10.0000' },
      { runId: 'r2', estimateAmount: '100.0000', actualAmount: '90.5000', lineCount: 6, energyUsage: '55.0000', machineHours: '10.0000' },
    )
    const actual = comparison.dimensions.find((d) => d.dimension === 'actualAmount')!
    expect(actual.diff).toBe('-10.5000')
    expect(comparison.dimensions.find((d) => d.dimension === 'lineCount')!.diff).toBeNull()
  })
})

// ---------------- CE-14 价格版本 ----------------

describe('CE-14 价格版本', () => {
  const items = [
    { materialCode: 'MAT-A', unitPrice: '12.500000', uomCode: 'KG' },
    { materialCode: 'MAT-B', unitPrice: '0.800000', uomCode: 'M' },
  ]

  it('版本形状：来源枚举/正单价/不重复 [CE-14]', () => {
    expect(() => assertPriceVersionShape({ versionNo: 1, priceSource: 'standard_cost', items })).not.toThrow()
    expectViolation(() => assertPriceVersionShape({ versionNo: 1, priceSource: 'market', items }), 'CE-14')
    expectViolation(() => assertPriceVersionShape({ versionNo: 1, priceSource: 'standard_cost', items: [] }), 'CE-14')
    expectViolation(
      () => assertPriceVersionShape({ versionNo: 1, priceSource: 'standard_cost', items: [...items, { materialCode: 'MAT-A', unitPrice: '1.0', uomCode: 'KG' }] }),
      'CE-14',
    )
    expectViolation(
      () => assertPriceVersionShape({ versionNo: 1, priceSource: 'erp_actual', items: [{ materialCode: 'MAT-C', unitPrice: '0', uomCode: 'KG' }] }),
      'CE-14',
    )
  })

  it('缺价返回 null（不填默认价格），命中返回单价 [CE-14]', () => {
    expect(resolvePriceForMaterial(items, 'MAT-A')).toEqual({ unitPrice: '12.500000', uomCode: 'KG' })
    expect(resolvePriceForMaterial(items, 'MAT-X')).toBeNull()
  })
})

// ---------------- CE-07/CE-08/CE-17/CE-18 归集规则 ----------------

describe('CE-07 理论与实测分列/损耗去向', () => {
  it('损耗=理论−实耗−在制变化；去向缺口显著标注', () => {
    const r = computeMaterialVariance({ theoreticalQty: '100.0000', actualQty: '95.0000', wipChangeQty: '2.0000', scrapQty: '2.0000' })
    expect(r.varianceQty).toBe('3.0000')
    expect(r.unexplainedQty).toBe('1.0000')
    expect(r.destinationBreakdownMissing).toBe(true)
    const r2 = computeMaterialVariance({ theoreticalQty: '100.0000', actualQty: '95.0000', wipChangeQty: '0.0000', scrapQty: '5.0000' })
    expect(r2.unexplainedQty).toBe('0.0000')
    expect(r2.destinationBreakdownMissing).toBe(false)
    const r3 = computeMaterialVariance({ theoreticalQty: '100.0000', actualQty: '110.0000', wipChangeQty: '0.0000', scrapQty: '0.0000' })
    expect(r3.varianceQty).toBe('-10.0000') // 超耗如实列示（负值不截断）
  })
})

describe('CE-17 估算列', () => {
  it('BOM×计划数量×价格：缺价行 amount null+priceMissing [CE-14]', () => {
    const lines = estimateMaterialFromBom({
      bomLines: [
        { materialCode: 'MAT-A', qtyPerUnit: '2.0000', uomCode: 'KG' },
        { materialCode: 'MAT-X', qtyPerUnit: '1.0000', uomCode: 'KG' },
      ],
      plannedQty: '10.0000',
      priceItems: [{ materialCode: 'MAT-A', unitPrice: '12.500000', uomCode: 'KG' }],
    })!
    expect(lines[0]).toMatchObject({ theoreticalQty: '20.0000', amount: '250.0000', priceMissing: false })
    expect(lines[1]).toMatchObject({ theoreticalQty: '10.0000', amount: null, priceMissing: true })
  })
})

describe('CE-08 倒冲 fail-closed（首期）', () => {
  it('工艺未提供允许标志 → 恒不倒冲（缺采集=缺项，不以估算冒充）', () => {
    expect(isAutoBackflushAllowed(null)).toBe(false)
    expect(isAutoBackflushAllowed(undefined)).toBe(false)
    expect(isAutoBackflushAllowed(false)).toBe(false)
    expect(isAutoBackflushAllowed(true)).toBe(true)
  })
})

describe('CE-10 OEE 分母齐备', () => {
  it('标准速度未数值化（GAP-S1）→ 缺项展示而非假百分比', () => {
    const r = computeOee({
      plannedMinutes: '480.0000',
      downtimeMinutes: '60.0000',
      standardSpeedPerHour: null,
      actualOutputQty: '1000.0000',
      qualifiedQty: '990.0000',
    })
    expect(r.oee).toBeNull()
    expect(r.availability).toBeNull()
    expect(r.missing).toContain('standard_speed_not_numeric')
  })

  it('停机事实缺失/产出缺失 → 缺项', () => {
    const r = computeOee({ plannedMinutes: '480.0000', downtimeMinutes: null, standardSpeedPerHour: '200.0000', actualOutputQty: null, qualifiedQty: null })
    expect(r.missing).toEqual(expect.arrayContaining(['downtime_missing', 'output_missing', 'qualified_missing']))
    expect(r.oee).toBeNull()
  })

  it('分母齐备 → 三率与 OEE 计算', () => {
    // 计划 480 分、停机 60 分 → 运行 420 分=7h；产出 1400/h 速度；标准 200/h → 性能 0.7
    const r = computeOee({ plannedMinutes: '480.0000', downtimeMinutes: '60.0000', standardSpeedPerHour: '200.0000', actualOutputQty: '1400.0000', qualifiedQty: '1330.0000' })
    expect(r.availability).toBe('0.8750')
    expect(r.performance).toBe('1.0000')
    expect(r.qualityRate).toBe('0.9500')
    expect(r.oee).toBe('0.8313')
    expect(r.missing).toEqual([])
  })

  it('停机超过计划 → 拒绝 [CE-10]', () => {
    expectViolation(
      () => computeOee({ plannedMinutes: '60.0000', downtimeMinutes: '120.0000', standardSpeedPerHour: '200.0000', actualOutputQty: '10.0000', qualifiedQty: '10.0000' }),
      'CE-10',
    )
  })
})

describe('归集输入形状 [CE-S1]', () => {
  it('必填项与格式校验', () => {
    const ok = { orderId: 'o1', shiftDate: '2026-10-28', cutoffAt: '2026-10-28T20:00:00Z', allocationVersionId: 'v1', priceVersionId: 'p1' }
    expect(() => assertAcquisitionInput(ok)).not.toThrow()
    expectViolation(() => assertAcquisitionInput({ ...ok, shiftDate: '2026/10/28' }), 'CE-S1')
    expectViolation(() => assertAcquisitionInput({ ...ok, cutoffAt: 'not-a-time' }), 'CE-S1')
    expectViolation(() => assertAcquisitionInput({ ...ok, allocationVersionId: '' }), 'CE-S1')
  })
})

// ---------------- CA-12/CA-13 PROPOSED 默认口径锚定 ----------------

describe('CA-12 工时主从（PROPOSED 默认：报工为主源，OT 仅参考）', () => {
  it('默认口径常量锚定（裁定改口径后本断言随返工调整）', () => {
    expect(LABOR_PRIMARY_SOURCE).toBe('labor_record')
    expect(DEFAULT_LABOR_CHECK_THRESHOLD).toBe('0.1000')
  })

  it('偏差超阈值 → open 提示；阈值内 → skipped', () => {
    const over = buildLaborCheck({ laborHours: '8.00', otRuntimeHours: '9.20', thresholdRatio: '0.1000' })
    expect(over.status).toBe('open')
    expect(over.deviationRatio).toBe('0.1500')
    const within = buildLaborCheck({ laborHours: '8.00', otRuntimeHours: '8.50' })
    expect(within.status).toBe('skipped')
    expect(within.deviationRatio).toBe('0.0625')
  })

  it('缺任一侧 → skipped+缺侧标注（不冒充，不改写报工）', () => {
    expect(buildLaborCheck({ laborHours: '8.00', otRuntimeHours: null })).toMatchObject({ status: 'skipped', missingSide: 'ot' })
    expect(buildLaborCheck({ laborHours: null, otRuntimeHours: '8.00' })).toMatchObject({ status: 'skipped', missingSide: 'labor' })
  })
})

describe('CA-13 折旧口径（PROPOSED 默认：机时+备件，不含折旧）', () => {
  it('默认口径常量锚定（裁定改口径后本断言随返工调整）', () => {
    expect(EQUIPMENT_COST_CALIBER).toBe('runtime_hours_plus_spare_parts_excluding_depreciation')
  })
})

// ---------------- CE-15/CE-16/CE-S5 对账 ----------------

describe('CE-16/CE-S5 对账规则', () => {
  it('入站行形状：维度枚举/双侧非负数量/材料维度带料品 [CE-15]', () => {
    const ok = { kind: 'material', localQuantity: '100.0000', erpQuantity: '98.0000', uomCode: 'KG', materialCode: 'MAT-A' }
    expect(() => assertReconImportRow(ok)).not.toThrow()
    expectViolation(() => assertReconImportRow({ ...ok, kind: 'money' }), 'CE-16')
    expectViolation(() => assertReconImportRow({ ...ok, erpQuantity: '-1.0000' }), 'CE-16')
    expectViolation(() => assertReconImportRow({ kind: 'material', localQuantity: '1', erpQuantity: '1', uomCode: 'KG', materialCode: null }), 'CE-15')
  })

  it('差异=本系统−ERP（有符号）；业务键稳定 [CE-S5]', () => {
    expect(computeReconDiff('100.0000', '98.0000')).toBe('2.0000')
    expect(computeReconDiff('98.0000', '100.0000')).toBe('-2.0000')
    expect(buildReconKey({ runId: 'r1', kind: 'material', materialCode: 'MAT-A' })).toBe('r1|material|MAT-A')
    expect(buildReconKey({ runId: 'r1', kind: 'energy' })).toBe('r1|energy|*')
  })

  it('处置流转：须理由；adjusted 终态；不可回 open [CE-S5]', () => {
    expect(() => assertReconResolvable({ currentStatus: 'open', targetStatus: 'confirmed', reason: '核对确认' })).not.toThrow()
    expectViolation(() => assertReconResolvable({ currentStatus: 'open', targetStatus: 'confirmed', reason: null }), 'CE-S5')
    expectViolation(() => assertReconResolvable({ currentStatus: 'adjusted', targetStatus: 'open', reason: 'x' }), 'CE-S5')
    expectViolation(() => assertReconResolvable({ currentStatus: 'confirmed', targetStatus: 'confirmed', reason: 'x' }), 'CE-S5')
    expectViolation(() => assertReconResolvable({ currentStatus: 'open', targetStatus: 'weird', reason: 'x' }), 'CE-S5')
  })
})

// ---------------- O-3 班次日窗口（CE-S4/CE-19 · IT-37 工厂日历口径） ----------------

describe('shiftDayWindow 班次日窗口（O-3：归集/核对窗口按工厂班次日历对齐，非 UTC 零点）', () => {
  it('默认日历（UTC+8 / 白班 00:00）：班次日 D 的窗口 = [(D-1)T16:00Z, DT16:00Z)', () => {
    const w = shiftDayWindow('2026-10-28')
    expect(w.from).toBe('2026-10-27T16:00:00.000Z')
    expect(w.to).toBe('2026-10-28T16:00:00.000Z')
    // 与 computeShiftDate（labor_record.shift_date 同源）往返一致：窗口内任一时刻的班次日恒为 D
    for (const probe of [
      '2026-10-27T16:00:00.000Z', // 北京 10-28 00:00（边界归当日）
      '2026-10-27T23:30:00Z', // 北京 10-28 07:30（跨零点带内）
      '2026-10-28T15:59:59.999Z', // 北京 10-28 23:59:59.999
    ]) {
      expect(computeShiftDate(probe)).toBe('2026-10-28')
      expect(Date.parse(probe) >= Date.parse(w.from) && Date.parse(probe) < Date.parse(w.to)).toBe(true)
    }
  })

  it('跨北京零点错位回归（R3 实测带）：UTC 16:00–24:00 时段归北京次日，旧 UTC 零点锚会错位一日', () => {
    // 例一：10-28T17:00Z = 北京 10-29 01:00 → 班次日 10-29（窗口 [10-28T16:00Z, 10-29T16:00Z)）
    const lateNight = '2026-10-28T17:00:00Z'
    expect(computeShiftDate(lateNight)).toBe('2026-10-29')
    const wNext = shiftDayWindow('2026-10-29')
    expect(wNext.from).toBe('2026-10-28T16:00:00.000Z')
    expect(Date.parse(lateNight) >= Date.parse(wNext.from) && Date.parse(lateNight) < Date.parse(wNext.to)).toBe(true)
    // 旧锚（`shiftDate T00:00Z`）口径下 10-28 窗口不含该时刻——不得再把此类时刻错归 10-28
    const wDay = shiftDayWindow('2026-10-28')
    expect(Date.parse(lateNight) < Date.parse(wDay.from) || Date.parse(lateNight) >= Date.parse(wDay.to)).toBe(true)

    // 例二：10-28T16:00:00.000Z 恰为边界 → 北京 10-29 00:00 归 10-29，不跨窗
    const boundary = '2026-10-28T16:00:00.000Z'
    expect(computeShiftDate(boundary)).toBe('2026-10-29')
    expect(Date.parse(boundary)).toBe(Date.parse(wNext.from))
  })

  it('自定义日历（白班 08:00）：窗口随白班起点平移；非法日期拒绝 [CE-S1]', () => {
    const w = shiftDayWindow('2026-10-28', { dayShiftStartHour: 8, utcOffsetHours: 8 })
    expect(w.from).toBe('2026-10-28T00:00:00.000Z') // 北京 10-28 08:00
    expect(w.to).toBe('2026-10-29T00:00:00.000Z') // 北京 10-29 08:00
    // 北京 07:59（= 前日 23:59Z）归前一班次日；北京 08:00（= 当日 00:00Z）归当日
    expect(computeShiftDate('2026-10-27T23:59:00Z', { dayShiftStartHour: 8, utcOffsetHours: 8 })).toBe('2026-10-27')
    expect(computeShiftDate('2026-10-28T00:00:00Z', { dayShiftStartHour: 8, utcOffsetHours: 8 })).toBe('2026-10-28')
    expectViolation(() => shiftDayWindow('2026/10/28'), 'CE-S1')
    expectViolation(() => shiftDayWindow('2026-10-32'), 'CE-S1')
  })
})
