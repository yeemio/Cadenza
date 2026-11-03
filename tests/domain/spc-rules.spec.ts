import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPC_CRITERIA,
  SpcRuleViolation,
  assertCalibrationRecordShape,
  assertChangeOrderShape,
  assertChangePublishable,
  assertControlItemShape,
  assertDispositionChoice,
  assertGaugeSchedulableForInspection,
  assertMiscalibrationActionShape,
  assertNamedAdjustment,
  assertOocDisposable,
  assertOperationMutationShape,
  assertOperationMutationsAllowed,
  assertRecontrolConfirmable,
  assertRuleSetShape,
  assertToolConfigShape,
  assertToolConsumption,
  calibrationStatusAt,
  classifyOrderImpact,
  compositeFactor,
  computeControlLimits,
  computeToolLifeStatus,
  effectiveToolLife,
  evaluateSampleAdmission,
  evaluateSpcCriteria,
  followsVersionAfterChange,
  isGaugeSchedulableForInspection,
  isToolSchedulable,
  judgeSamplePoint,
  markShippedItemComplaintHint,
  buildMiscalibrationCircle,
  mulDivSpcQty,
  recomputePlannedQty,
  toSpcScaled,
} from '../../packages/domain/src/spc/index'

/**
 * spc 域纯规则单测（冻结合同 PE-01～PE-21 全规则族覆盖，无 DB）。
 * 逐条对照：PE-03/04/06 分类与处置、PE-07 行为边界、PE-08/09/10 规则集与控制限、
 * PE-11 准入、PE-12 判异与闭环、PE-15/16/17 校准、PE-18/19 圈定、PE-20/21 工具寿命。
 */

function expectViolation(fn: () => unknown, rule: string): void {
  expect(fn).toThrow(SpcRuleViolation)
  try {
    fn()
  } catch (error) {
    expect((error as SpcRuleViolation).rule).toBe(rule)
  }
}

describe('PE-01/PE-S1 定点算术与变更单形状', () => {
  it('toSpcScaled 拒绝非定点字符串', () => {
    expectViolation(() => toSpcScaled('1.23456', '数量'), 'PE-01')
    expectViolation(() => toSpcScaled(1.5 as unknown as string, '数量'), 'PE-01')
    expect(toSpcScaled('12.5', '数量')).toBe(125000n)
  })

  it('mulDivSpcQty 比例换算半入到 4 位', () => {
    expect(mulDivSpcQty('100.0000', '14.0000', '7.0000', '计划量')).toBe('200.0000')
    expect(mulDivSpcQty('100.0000', '7.0000', '14.0000', '计划量')).toBe('50.0000')
    expect(mulDivSpcQty('10.0000', '1.0000', '3.0000', '计划量')).toBe('3.3333')
  })

  it('PE-S1 变更单形状：版本对/审批人/生效时间非空、同对象、旧低于新', () => {
    const base = {
      oldSpecRevisionId: 'spec-v1',
      newSpecRevisionId: 'spec-v2',
      sameSpecObject: true,
      approver: '工艺-张工',
      effectiveAt: '2026-10-28T08:00:00Z',
    }
    expect(() => assertChangeOrderShape(base)).not.toThrow()
    expectViolation(
      () => assertChangeOrderShape({ ...base, approver: '' }),
      'PE-S1',
    )
    expectViolation(
      () => assertChangeOrderShape({ ...base, effectiveAt: 'not-a-date' }),
      'PE-S1',
    )
    expectViolation(
      () =>
        assertChangeOrderShape({ ...base, oldSpecRevisionId: 'a', newSpecRevisionId: 'a' }),
      'PE-S1',
    )
    expectViolation(() => assertChangeOrderShape({ ...base, sameSpecObject: false }), 'PE-S1')
  })
})

describe('PE-03/PE-04/PE-06 影响分类、处置与生效', () => {
  it('classifyOrderImpact：作废不在范围；closed→completed；有已提交报工→in_process；其余未执行', () => {
    expect(classifyOrderImpact({ orderStatus: 'voided', hasSubmittedReport: false })).toBeNull()
    expect(classifyOrderImpact({ orderStatus: 'closed', hasSubmittedReport: true })).toBe('completed')
    expect(classifyOrderImpact({ orderStatus: 'in_progress', hasSubmittedReport: true })).toBe('in_process')
    expect(classifyOrderImpact({ orderStatus: 'released', hasSubmittedReport: false })).toBe('unexecuted')
  })

  it('PE-04：在制必须三选项之一；未执行/已完成不得携带处置', () => {
    expectViolation(
      () => assertDispositionChoice({ category: 'in_process', disposition: null }),
      'PE-04',
    )
    expect(() =>
      assertDispositionChoice({ category: 'in_process', disposition: 'switch_new' }),
    ).not.toThrow()
    expectViolation(
      () => assertDispositionChoice({ category: 'unexecuted', disposition: 'continue_old' }),
      'PE-04',
    )
    expectViolation(
      () => assertDispositionChoice({ category: 'completed', disposition: 'isolation_review' }),
      'PE-04',
    )
  })

  it('PE-05 执行版本对应：未执行→new、completed→old、在制按处置', () => {
    expect(followsVersionAfterChange({ category: 'unexecuted', disposition: null })).toBe('new')
    expect(followsVersionAfterChange({ category: 'completed', disposition: null })).toBe('old')
    expect(followsVersionAfterChange({ category: 'in_process', disposition: 'continue_old' })).toBe('old')
    expect(followsVersionAfterChange({ category: 'in_process', disposition: 'switch_new' })).toBe('new')
    // 隔离评审保守按旧版（暂停并挂质量评审，处置未定前不转新版）
    expect(followsVersionAfterChange({ category: 'in_process', disposition: 'isolation_review' })).toBe('old')
  })

  it('PE-S1/PE-04 生效前置：非 draft 拒；存在未处置在制任务拒', () => {
    expectViolation(
      () =>
        assertChangePublishable({
          status: 'published',
          impacts: [{ category: 'in_process', disposition: 'continue_old' }],
        }),
      'PE-S1',
    )
    expectViolation(
      () =>
        assertChangePublishable({
          status: 'draft',
          impacts: [
            { category: 'in_process', disposition: null },
            { category: 'unexecuted', disposition: null },
          ],
        }),
      'PE-04',
    )
    expect(() =>
      assertChangePublishable({
        status: 'draft',
        impacts: [{ category: 'in_process', disposition: 'switch_new' }],
      }),
    ).not.toThrow()
  })

  it('PE-03 计划量重算：因子比换算（芯倍数×绞合）', () => {
    const oldFactor = compositeFactor({ coreMultiple: 7, strandFactor: '1.0000' })
    const newFactor = compositeFactor({ coreMultiple: 7, strandFactor: '2.0000' })
    expect(oldFactor).toBe('7.0000')
    expect(newFactor).toBe('14.0000')
    expect(recomputePlannedQty({ plannedQty: '100.0000', oldFactor, newFactor })).toBe('200.0000')
    expectViolation(() => compositeFactor({ coreMultiple: 0, strandFactor: null }), 'PE-03')
  })
})

describe('PE-07 已有报工的工序行为边界（原文约束保留）', () => {
  it('变动形状：非 add 必须带 targetSeq', () => {
    expect(() => assertOperationMutationShape({ kind: 'add' }, 0)).not.toThrow()
    expectViolation(() => assertOperationMutationShape({ kind: 'rename' }, 0), 'PE-07')
    expectViolation(() => assertOperationMutationShape({ kind: 'bad' as 'add' }, 0), 'PE-07')
  })

  it('已有报工：不可新增工序/改名/调序/删行；无报工不触发', () => {
    const reported = [2]
    expectViolation(
      () => assertOperationMutationsAllowed({ mutations: [{ kind: 'add' }], reportedSeqs: reported }),
      'PE-07',
    )
    expectViolation(
      () =>
        assertOperationMutationsAllowed({ mutations: [{ kind: 'rename', targetSeq: 2 }], reportedSeqs: reported }),
      'PE-07',
    )
    expectViolation(
      () =>
        assertOperationMutationsAllowed({ mutations: [{ kind: 'reorder', targetSeq: 2 }], reportedSeqs: reported }),
      'PE-07',
    )
    expectViolation(
      () =>
        assertOperationMutationsAllowed({ mutations: [{ kind: 'remove', targetSeq: 2 }], reportedSeqs: reported }),
      'PE-07',
    )
    // 无报工工序的变动不受限；无任何报工的订单不触发原文约束
    expect(() =>
      assertOperationMutationsAllowed({ mutations: [{ kind: 'rename', targetSeq: 1 }], reportedSeqs: reported }),
    ).not.toThrow()
    expect(() =>
      assertOperationMutationsAllowed({ mutations: [{ kind: 'add' }, { kind: 'rename', targetSeq: 1 }], reportedSeqs: [] }),
    ).not.toThrow()
  })
})

describe('PE-08/09/10 受控项目/规则集/控制限', () => {
  it('PE-08 受控项目形状：规范版本与项号必填', () => {
    expect(() =>
      assertControlItemShape({ specCode: 'INS-CABLE', specVersion: 2, itemNo: 'OD-01' }),
    ).not.toThrow()
    expectViolation(() => assertControlItemShape({ specCode: '', specVersion: 2, itemNo: 'OD-01' }), 'PE-08')
    expectViolation(() => assertControlItemShape({ specCode: 'INS', specVersion: 0, itemNo: 'OD-01' }), 'PE-08')
    expectViolation(() => assertControlItemShape({ specCode: 'INS', specVersion: 1, itemNo: '' }), 'PE-08')
  })

  it('PE-09 规则集形状与默认子集', () => {
    expect(() =>
      assertRuleSetShape({ name: '现场规则集A', version: 1, chartType: 'i_mr', criteria: ['point_beyond_limits', 'trend_6'] }),
    ).not.toThrow()
    expectViolation(
      () => assertRuleSetShape({ name: 'x', version: 1, chartType: 'bad', criteria: ['point_beyond_limits'] }),
      'PE-09',
    )
    expectViolation(
      () => assertRuleSetShape({ name: 'x', version: 1, chartType: 'i_mr', criteria: [] }),
      'PE-09',
    )
    expectViolation(
      () => assertRuleSetShape({ name: 'x', version: 1, chartType: 'i_mr', criteria: ['nope'] }),
      'PE-09',
    )
    expectViolation(
      () =>
        assertRuleSetShape({ name: 'x', version: 1, chartType: 'i_mr', criteria: ['trend_6', 'trend_6'] }),
      'PE-09',
    )
    // PE-09 默认子集：单点越限＋连续 6 点同侧
    expect([...DEFAULT_SPC_CRITERIA]).toEqual(['point_beyond_limits', 'run_same_side_6'])
  })

  it('PE-10 控制限：首 n 组建立；不足返回 null；±3σ 口径', () => {
    expect(computeControlLimits({ method: 'mean_pm_3sigma', baselineCount: 5, values: ['2.0000', '2.1000', '2.2000'] })).toBeNull()
    const limits = computeControlLimits({
      method: 'mean_pm_3sigma',
      baselineCount: 4,
      values: ['2.0000', '2.0000', '4.0000', '4.0000'],
    })
    expect(limits).not.toBeNull()
    expect(limits!.cl).toBe('3.000000')
    // 样本标准差=sqrt(1.333333..)=1.154701，UCL=3+3σ=6.464102
    expect(limits!.ucl).toBe('6.464102')
    expect(limits!.lcl).toBe('-0.464102')
    expectViolation(
      () => computeControlLimits({ method: 'mean_pm_3sigma', baselineCount: 1, values: [] }),
      'PE-10',
    )
  })
})

describe('PE-11/PE-12 样本准入与判异', () => {
  it('PE-11 准入：五类拒绝与两类通过', () => {
    // 坏点（OT-20）
    expect(evaluateSampleAdmission({ source: 'collection', testResultRef: null, qualityCode: 'good', gaugeId: 'g1', calibrationStatus: 'valid', badPoint: true, clockDeviation: false })).toEqual({ admitted: false, rejectReason: 'bad_point' })
    // 时钟偏差（OT-21）
    expect(evaluateSampleAdmission({ source: 'collection', testResultRef: null, qualityCode: 'good', gaugeId: 'g1', calibrationStatus: 'valid', badPoint: false, clockDeviation: true })).toEqual({ admitted: false, rejectReason: 'clock_deviation' })
    // 校准状态可疑（OT-12）
    expect(evaluateSampleAdmission({ source: 'collection', testResultRef: null, qualityCode: 'good', gaugeId: 'g1', calibrationStatus: 'expired', badPoint: false, clockDeviation: false })).toEqual({ admitted: false, rejectReason: 'calibration_suspect' })
    expect(evaluateSampleAdmission({ source: 'collection', testResultRef: null, qualityCode: 'good', gaugeId: 'g1', calibrationStatus: 'invalid', badPoint: false, clockDeviation: false })).toEqual({ admitted: false, rejectReason: 'calibration_suspect' })
    // 质量码非 good
    expect(evaluateSampleAdmission({ source: 'collection', testResultRef: null, qualityCode: 'bad', gaugeId: 'g1', calibrationStatus: 'valid', badPoint: false, clockDeviation: false })).toEqual({ admitted: false, rejectReason: 'quality_code_not_good' })
    // 人工来源缺实测引用
    expect(evaluateSampleAdmission({ source: 'manual_inspection', testResultRef: null, qualityCode: null, gaugeId: 'g1', calibrationStatus: 'valid', badPoint: false, clockDeviation: false })).toEqual({ admitted: false, rejectReason: 'test_result_missing' })
    // 通过：人工（引用实测+器具有效）；采集（good+有效）
    expect(evaluateSampleAdmission({ source: 'manual_inspection', testResultRef: 'tr-1', qualityCode: null, gaugeId: 'g1', calibrationStatus: 'valid', badPoint: false, clockDeviation: false })).toEqual({ admitted: true, rejectReason: null })
    expect(evaluateSampleAdmission({ source: 'collection', testResultRef: null, qualityCode: 'good', gaugeId: 'g1', calibrationStatus: 'valid', badPoint: false, clockDeviation: false })).toEqual({ admitted: true, rejectReason: null })
  })

  it('PE-09/12 判异求值：单点越限/连续6点同侧/连续6点趋势', () => {
    const cl = '5.000000'
    const ucl = '8.000000'
    const lcl = '2.000000'
    const pt = (v: string) => ({ value: v, cl, ucl, lcl })
    // 单点越限
    const beyond = evaluateSpcCriteria({
      criteria: ['point_beyond_limits'],
      points: [pt('5.0000'), pt('8.1000')],
    })
    expect(beyond).toEqual([{ code: 'point_beyond_limits', fromIndex: 1, toIndex: 1 }])
    // 连续 6 点同侧（CL 上方）
    const run = evaluateSpcCriteria({
      criteria: ['run_same_side_6'],
      points: [pt('5.1000'), pt('5.2000'), pt('5.3000'), pt('5.4000'), pt('5.5000'), pt('5.6000')],
    })
    expect(run).toEqual([{ code: 'run_same_side_6', fromIndex: 0, toIndex: 5 }])
    // 压线中断连run
    const interrupted = evaluateSpcCriteria({
      criteria: ['run_same_side_6'],
      points: [pt('5.1000'), pt('5.2000'), pt('5.0000'), pt('5.4000'), pt('5.5000'), pt('5.6000'), pt('5.7000')],
    })
    expect(interrupted).toEqual([]) // 中断后最长 4 连侧
    // 连续 6 点严格递减趋势
    const trend = evaluateSpcCriteria({
      criteria: ['trend_6'],
      points: [pt('6.0000'), pt('5.8000'), pt('5.6000'), pt('5.4000'), pt('5.2000'), pt('5.0000')],
    })
    expect(trend).toEqual([{ code: 'trend_6', fromIndex: 0, toIndex: 5 }])
  })

  it('PE-12 单点判定：新点命中即失控', () => {
    const cl = '5.000000'
    const ucl = '8.000000'
    const lcl = '2.000000'
    const pt = (v: string) => ({ value: v, cl, ucl, lcl })
    const inControl = judgeSamplePoint({
      criteria: [...DEFAULT_SPC_CRITERIA],
      history: [pt('5.1000'), pt('4.9000')],
      newPoint: pt('5.0500'),
    })
    expect(inControl.verdict).toBe('in_control')
    const outOfControl = judgeSamplePoint({
      criteria: [...DEFAULT_SPC_CRITERIA],
      history: [pt('5.1000'), pt('4.9000')],
      newPoint: pt('9.0000'),
    })
    expect(outOfControl.verdict).toBe('out_of_control')
    expect(outOfControl.violatedCodes).toEqual(['point_beyond_limits'])
  })

  it('PE-12 失控处置闭环：处置必留记录；复控须证据', () => {
    expectViolation(() => assertOocDisposable({ status: 'open', causeCategory: '', correctiveAction: 'x' }), 'PE-12')
    expectViolation(() => assertOocDisposable({ status: 'open', causeCategory: '设备', correctiveAction: '' }), 'PE-12')
    expectViolation(() => assertOocDisposable({ status: 'disposed', causeCategory: '设备', correctiveAction: '换模' }), 'PE-12')
    expectViolation(() => assertRecontrolConfirmable({ status: 'disposed', subsequentInControlCount: 0 }), 'PE-12')
    expectViolation(() => assertRecontrolConfirmable({ status: 'open', subsequentInControlCount: 1 }), 'PE-12')
    expect(() => assertRecontrolConfirmable({ status: 'disposed', subsequentInControlCount: 1 })).not.toThrow()
  })
})

describe('PE-15/16/17 校准', () => {
  const baseCal = {
    gaugeId: 'g1',
    calibratedAt: '2026-10-01T00:00:00Z',
    result: 'qualified' as const,
    certificateNo: 'CERT-001',
    validUntil: '2026-11-01T00:00:00Z',
    basis: 'JJG 2026',
  }

  it('PE-15 记录形状', () => {
    expect(() => assertCalibrationRecordShape(baseCal)).not.toThrow()
    expectViolation(() => assertCalibrationRecordShape({ ...baseCal, certificateNo: '' }), 'PE-15')
    expectViolation(() => assertCalibrationRecordShape({ ...baseCal, result: 'broken' }), 'PE-15')
  })

  it('PE-16 时点校准状态：valid/limited/invalid/expired/unknown', () => {
    const at = '2026-10-15T00:00:00Z'
    expect(calibrationStatusAt([baseCal], at)).toBe('valid')
    expect(calibrationStatusAt([{ ...baseCal, result: 'failed' }], at)).toBe('invalid')
    expect(calibrationStatusAt([{ ...baseCal, result: 'limited' }], at)).toBe('limited')
    // 合格但已过有效期 → expired
    expect(calibrationStatusAt([baseCal], '2026-11-02T00:00:00Z')).toBe('expired')
    // 校准日期晚于采样时点 → 取不到更早记录 → unknown
    expect(calibrationStatusAt([baseCal], '2026-09-30T00:00:00Z')).toBe('unknown')
    expect(calibrationStatusAt([], at)).toBe('unknown')
    // 多条取校准日期最新且早于时点的一条
    expect(
      calibrationStatusAt(
        [
          { ...baseCal, calibratedAt: '2026-10-01T00:00:00Z' },
          { ...baseCal, calibratedAt: '2026-10-10T00:00:00Z', result: 'failed' },
        ],
        at,
      ),
    ).toBe('invalid')
  })

  it('PE-17 检测类任务可排产判定（CS-05 硬约束③ 等价服务）', () => {
    expect(isGaugeSchedulableForInspection('valid')).toBe(true)
    expect(isGaugeSchedulableForInspection('limited')).toBe(true)
    expect(isGaugeSchedulableForInspection('invalid')).toBe(false)
    expect(isGaugeSchedulableForInspection('expired')).toBe(false)
    expect(isGaugeSchedulableForInspection('unknown')).toBe(false)
    expectViolation(() => assertGaugeSchedulableForInspection('expired', 'G-001'), 'PE-17')
  })
})

describe('PE-18/PE-19 失准圈定', () => {
  it('圈定算法：时段过滤 + 结论/放行 + 库存/已发运分桶 + 客诉提示', () => {
    const measurements = [
      {
        sampleId: 's1',
        source: 'manual_inspection',
        sampledAt: '2026-10-15T08:00:00Z',
        measuredValue: '2.0500',
        admission: 'admitted',
        testResultId: 'tr1',
        productionOrderNo: 'MO-100',
        operationSeq: 2,
        inventoryUnitId: null,
        unitNo: 'U-001',
        lotNo: 'LOT-A',
      },
      {
        sampleId: 's2',
        source: 'collection',
        sampledAt: '2026-10-16T08:00:00Z', // 窗口外
        measuredValue: '2.0600',
        admission: 'admitted',
        testResultId: null,
        productionOrderNo: 'MO-100',
        operationSeq: 2,
        inventoryUnitId: null,
        unitNo: null,
        lotNo: null,
      },
      {
        sampleId: 's3',
        source: 'manual_inspection',
        sampledAt: '2026-10-15T09:00:00Z',
        measuredValue: '2.0700',
        admission: 'rejected',
        testResultId: 'tr2',
        productionOrderNo: 'MO-200',
        operationSeq: 1,
        inventoryUnitId: null,
        unitNo: 'U-002',
        lotNo: 'LOT-B',
      },
    ]
    const testResults = [
      {
        testResultId: 'tr1',
        conclusion: 'qualified',
        inspectedAt: '2026-10-15T08:10:00Z',
        inspector: 'qc01',
        inspectionOrderNo: 'INS-1',
        inspectionOrderStatus: 'concluded',
        productionOrderNo: 'MO-100',
        productionOrderStatus: 'in_progress',
        inventoryUnitId: 'u1',
        unitNo: 'U-001',
        lotNo: 'LOT-A',
        lotId: 'lot1',
        materialCode: 'MAT-X',
        releasedBy: 'qc01',
        releasedAt: '2026-10-15T09:00:00Z',
        releaseKind: 'release',
      },
      {
        testResultId: 'tr2',
        conclusion: 'unqualified',
        inspectedAt: '2026-10-15T09:10:00Z',
        inspector: 'qc01',
        inspectionOrderNo: 'INS-2',
        inspectionOrderStatus: 'concluded',
        productionOrderNo: 'MO-200',
        productionOrderStatus: 'closed',
        inventoryUnitId: 'u2',
        unitNo: 'U-002',
        lotNo: 'LOT-B',
        lotId: 'lot2',
        materialCode: 'MAT-X',
        releasedBy: null,
        releasedAt: null,
        releaseKind: null,
      },
    ]
    const units = [
      { inventoryUnitId: 'u1', unitNo: 'U-001', status: 'in_stock', lotNo: 'LOT-A', materialCode: 'MAT-X', productionOrderNo: 'MO-100', productionOrderStatus: 'in_progress' },
      { inventoryUnitId: 'u2', unitNo: 'U-002', status: 'shipped', lotNo: 'LOT-B', materialCode: 'MAT-X', productionOrderNo: 'MO-200', productionOrderStatus: 'closed' },
    ]
    const circle = buildMiscalibrationCircle({
      windowFrom: '2026-10-15T00:00:00Z',
      windowTo: '2026-10-15T23:59:59Z',
      measurements,
      testResults,
      units,
    })
    // 时段过滤：s2 在窗口外被排除；s1/s3 留存（含被拒样本——全部实测口径）
    expect(circle.measurements.map((m) => m.sampleId)).toEqual(['s1', 's3'])
    expect(circle.inspectionConclusions.map((t) => t.testResultId)).toEqual(['tr1', 'tr2'])
    expect(circle.releases).toEqual([{ testResultId: 'tr1', releasedBy: 'qc01', releasedAt: '2026-10-15T09:00:00Z', releaseKind: 'release' }])
    // 在制：MO-100 未结束；MO-200 已结束不在制
    expect(circle.wipOrders).toEqual(['MO-100'])
    // 分桶：u1 在库、u2 已发运（→ 客诉/召回提示范围）
    expect(circle.stockUnits.map((u) => u.unitNo)).toEqual(['U-001'])
    expect(circle.shippedUnits.map((u) => u.unitNo)).toEqual(['U-002'])
    expect(circle.customerComplaintHints).toEqual([{ unitNo: 'U-002', productionOrderNo: 'MO-200' }])
  })

  it('PE-19 失准处置形状与已发运提示标记', () => {
    expect(() =>
      assertMiscalibrationActionShape({ actionKind: 'retest', itemKind: 'measurement', itemRef: 's1' }),
    ).not.toThrow()
    expectViolation(
      () => assertMiscalibrationActionShape({ actionKind: 'burn', itemKind: 'measurement', itemRef: 's1' }),
      'PE-19',
    )
    expect(markShippedItemComplaintHint('shipped_unit')).toBe(true)
    expect(markShippedItemComplaintHint('stock_unit')).toBe(false)
  })
})

describe('PE-20/PE-21 工具寿命', () => {
  it('PE-20 配置形状与消耗来源', () => {
    const cfg = { lifeUom: 'count', ratedLife: '1000.0000', warningThreshold: '800.0000', expirePolicy: 'block' }
    expect(() => assertToolConfigShape({ ...cfg, version: 1 })).not.toThrow()
    expectViolation(() => assertToolConfigShape({ ...cfg, lifeUom: 'kg', version: 1 }), 'PE-20')
    expectViolation(() => assertToolConfigShape({ ...cfg, ratedLife: '0.0000', version: 1 }), 'PE-20')
    expectViolation(
      () => assertToolConfigShape({ ...cfg, warningThreshold: '1200.0000', version: 1 }),
      'PE-20',
    )
    expectViolation(() => assertToolConfigShape({ ...cfg, expirePolicy: 'keep', version: 1 }), 'PE-20')
    expect(() =>
      assertToolConsumption({ quantity: '10.0000', source: 'work_report_output', refType: 'production_report', refId: 'r1' }),
    ).not.toThrow()
    expectViolation(
      () => assertToolConsumption({ quantity: '10.0000', source: 'guess', refType: 'x', refId: 'r1' }),
      'PE-20',
    )
    expectViolation(
      () => assertToolConsumption({ quantity: '0.0000', source: 'collected_sample', refType: 'x', refId: 'r1' }),
      'PE-20',
    )
  })

  it('PE-21 具名调整与只增口径；有效寿命=累计+调整合计', () => {
    expectViolation(() => assertNamedAdjustment({ delta: '5.0000', reason: '' }), 'PE-21')
    expectViolation(() => assertNamedAdjustment({ delta: '0.0000', reason: '返工回冲' }), 'PE-21')
    expect(() => assertNamedAdjustment({ delta: '-5.0000', reason: '登记口径修正' })).not.toThrow()
    expect(effectiveToolLife({ accumulated: '900.0000', adjustmentSum: '-50.0000' })).toBe('850.0000')
  })

  it('PE-20/21 状态阈值与排产侧等价服务（T22 工装约束）', () => {
    const input = { ratedLife: '1000.0000', warningThreshold: '800.0000' }
    expect(computeToolLifeStatus({ ...input, effectiveLife: '700.0000' })).toBe('normal')
    expect(computeToolLifeStatus({ ...input, effectiveLife: '850.0000' })).toBe('warning')
    expect(computeToolLifeStatus({ ...input, effectiveLife: '1000.0000' })).toBe('expired')
    // 到期+禁用 → 阻止排产；到期+降级用 → 允许（降级标记由排产域消费）
    expect(isToolSchedulable({ status: 'expired', expirePolicy: 'block' })).toBe(false)
    expect(isToolSchedulable({ status: 'expired', expirePolicy: 'degrade' })).toBe(true)
    expect(isToolSchedulable({ status: 'warning', expirePolicy: 'block' })).toBe(true)
  })
})
