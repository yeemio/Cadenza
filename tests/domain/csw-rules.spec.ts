import { describe, expect, it } from 'vitest'
// domain csw 面未并入包名入口（共享文件 domain/src/index.ts 不改动）：
// 测试直接以相对路径消费 TS 源码（vitest 转译；typecheck:tests 以相对导入纳入编译）。
import {
  CswRuleViolation,
  assertCalibrationAllowsNewSlot,
  assertMatrixPublishable,
  assertNoActiveFreezeOverlap,
  assertFreezeShape,
  assertUnfreezeReasonProvided,
  assertOutsourcingTransition,
  assertOwnershipRetainedOnSend,
  assertReturnEntersPendingInspection,
  assertCloseRequiresInspectionPassed,
  assertNoSettlementFields,
  assertSendLinesShape,
  assertSoftOverrideComplete,
  assertNoHardConstraintHit,
  assertPriorityWeightsValid,
  assertHorizonDaysValid,
  buildConflictItem,
  buildSettlementFact,
  buildTaskExplanation,
  calibrationEffectAt,
  classifyExistingSlot,
  DEFAULT_FREEZE_DAYS,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_PRIORITY_WEIGHTS,
  downtimeOccupancyFraction,
  dueDateUrgency,
  effectiveCapacityForDate,
  evaluateCandidate,
  evaluateMaterialSufficiency,
  evaluateReadiness,
  flagSlotsForCalibration,
  horizonDates,
  isEquipmentDateFrozen,
  isOutsourcingOccupationActive,
  isOutsourcingTerminal,
  isSlotFrozen,
  lookupChangeoverMinutes,
  nextMatrixVersionNo,
  remainingQtyOf,
  selectBestCandidate,
  weightsDifferFromDefault,
  type RescheduleTask,
} from '../../packages/domain/src/csw/index'

/**
 * T22 csw 域纯规则单测——冻结合同 constrained-scheduling.md
 * §2 约束分级（CS-04~10）、§3 有限能力（CS-11~18）、§4 外协（CS-19~25）。
 */

const task = (over: Partial<RescheduleTask> = {}): RescheduleTask => ({
  orderOperationId: 'op-1',
  orderId: 'o-1',
  orderNo: 'ORD-1',
  seq: 1,
  operationDefinitionId: 'od-1',
  operationName: '绞线',
  dimensionValue: 'JX',
  workCenterId: 'wc-1',
  offlineQty: '300.0000',
  plannedQty: '0.0000',
  executionStatus: 'pending',
  dueDate: '2026-11-05',
  outsourced: false,
  uom: 'M',
  ...over,
})

const candidate = (over: Record<string, unknown> = {}) => ({
  equipmentId: 'eq-1',
  equipmentName: '设备一',
  equipmentStatus: 1,
  calibrationEffect: 'usable' as const,
  downtimeFraction: 0,
  frozen: false,
  capacity: '1000.0000' as string | null,
  dayPlannedQty: '0.0000',
  previousDimensionValue: null as string | null,
  productionDate: '2026-10-28',
  ...over,
})


/** 违例断言助手：规则码在 error.rule（应用层才拼 [CS-x] 前缀文案）。 */
function expectRule(fn: () => unknown, rule: string): void {
  try {
    fn()
    throw new Error(`expected CswRuleViolation [${rule}]`)
  } catch (e) {
    if (e instanceof CswRuleViolation) {
      if (e.rule !== rule) throw new Error(`expected rule ${rule} but got ${e.rule}: ${e.message}`)
      return
    }
    throw e
  }
}

describe('CS-04/05/06 约束强度分级', () => {
  it('软约束违反记录缺操作者/理由/影响范围即拒（CS-04/06）', () => {
    expect(() => assertSoftOverrideComplete({ operator: '', reason: 'r', affectedScope: 's', softCode: 'capacity_overrun' })).toThrow(CswRuleViolation)
    expect(() => assertSoftOverrideComplete({ operator: 'a', reason: '', affectedScope: 's', softCode: 'capacity_overrun' })).toThrow(/理由/)
    expect(() => assertSoftOverrideComplete({ operator: 'a', reason: 'r', affectedScope: '', softCode: 'capacity_overrun' })).toThrow(/影响范围/)
    expect(() => assertSoftOverrideComplete({ operator: 'a', reason: 'r', affectedScope: '3 条目', softCode: 'capacity_overrun' })).not.toThrow()
  })
  it('硬约束命中即拒（CS-04 总闸：任何排程输出不得绕过）', () => {
    expectRule(() => assertNoHardConstraintHit(['equipment_repair']), 'CS-04')
    expect(() => assertNoHardConstraintHit([])).not.toThrow()
  })
})

describe('CS-07/CS-08 就绪规则与齐套口径', () => {
  it('四条件任一不满足即不就绪，阻断逐条带规则码（CS-07）', () => {
    const v = evaluateReadiness({
      priorOperationsDone: false,
      pendingPriorOperations: ['工序1 绞线'],
      materialReady: false,
      materialShortfall: '50.0000',
      equipmentAvailable: false,
      equipmentBlocker: '维修中',
      qualityCleared: false,
      qualityBlocker: '待检未放行',
    })
    expect(v.ready).toBe(false)
    expect(v.blockers.map((b) => b.rule)).toEqual(['CS-07', 'CS-08', 'CS-07', 'CS-07'])
  })
  it('默认口径＝可用量（质量∧预留）覆盖需求；缺口可量化（CS-08）', () => {
    expect(evaluateMaterialSufficiency({ demandQty: '100', availableQty: '120' })).toEqual({
      sufficient: true,
      shortfall: null,
      basis: 'default',
    })
    const r = evaluateMaterialSufficiency({ demandQty: '100', availableQty: '60', reservedQty: '50', includeReserved: true })
    expect(r.sufficient).toBe(true)
    expect(r.basis).toBe('include_reserved')
    expect(evaluateMaterialSufficiency({ demandQty: '100', availableQty: '60' }).shortfall).toBe('40')
  })
})

describe('CS-05③/CS-10 校准约束', () => {
  it('校准过期/失准禁新建正数槽位；已排可改/可删；未知/限用放行', () => {
    expectRule(
      () => assertCalibrationAllowsNewSlot({ effect: 'invalid', equipmentName: 'C', existingSlotPlannedQty: null, newPlannedQty: '100' }),
      'CS-10',
    )
    expect(() =>
      assertCalibrationAllowsNewSlot({ effect: 'expired', equipmentName: 'C', existingSlotPlannedQty: null, newPlannedQty: '100' }),
    ).toThrow(/过期/)
    expect(() =>
      assertCalibrationAllowsNewSlot({ effect: 'invalid', equipmentName: 'C', existingSlotPlannedQty: '50', newPlannedQty: '100' }),
    ).not.toThrow()
    expect(() =>
      assertCalibrationAllowsNewSlot({ effect: 'invalid', equipmentName: 'C', existingSlotPlannedQty: null, newPlannedQty: '0' }),
    ).not.toThrow()
    expect(() =>
      assertCalibrationAllowsNewSlot({ effect: 'unknown', equipmentName: 'C', existingSlotPlannedQty: null, newPlannedQty: '100' }),
    ).not.toThrow()
    expect(calibrationEffectAt({ equipmentId: 'e', calibrationResult: 'limited', validUntil: null }, '2026-10-28')).toBe('usable')
    expect(calibrationEffectAt({ equipmentId: 'e', calibrationResult: 'qualified', validUntil: '2026-10-27' }, '2026-10-28')).toBe('expired')
  })
  it('已排槽位标记清单（CS-10：不删除仅提示）', () => {
    const flagged = flagSlotsForCalibration(
      [
        { id: 's1', equipmentId: 'e1', productionDate: '2026-10-29' },
        { id: 's2', equipmentId: 'e1', productionDate: '2026-10-26' },
        { id: 's3', equipmentId: 'e2', productionDate: '2026-10-29' },
      ],
      { equipmentId: 'e1', calibrationResult: 'invalid', validUntil: null },
      '2026-10-28',
    )
    expect(flagged).toEqual([{ slotId: 's1', effect: 'invalid' }])
  })
})

describe('CS-09 停机占用', () => {
  it('停机窗口对生产日的占用比例与有效产能折减', () => {
    expect(downtimeOccupancyFraction({ equipmentId: 'e', from: '2026-10-28', to: '2026-10-28', kind: 'repair' }, '2026-10-28')).toBe(1)
    expect(downtimeOccupancyFraction({ equipmentId: 'e', from: '2026-10-28', to: '2026-10-28', kind: 'repair' }, '2026-10-29')).toBe(0)
    expect(effectiveCapacityForDate({ capacity: '1000', downtimeFraction: 1 })).toBe('0')
    expect(effectiveCapacityForDate({ capacity: '1000', downtimeFraction: 0 })).toBe('1000')
    expect(effectiveCapacityForDate({ capacity: null, downtimeFraction: 1 })).toBe(null)
  })
  it('部分时段停机按比例折减（半日＝一半产能）', () => {
    const half = downtimeOccupancyFraction(
      { equipmentId: 'e', from: '2026-10-28T00:00:00Z', to: '2026-10-28T12:00:00Z', kind: 'planned_maintenance' },
      '2026-10-28',
    )
    expect(half).toBeCloseTo(0.5, 5)
  })
})

describe('CS-11/CS-S2 冻结窗口', () => {
  const active = [
    { id: 'f1', scope: 'equipment_date_range' as const, equipmentId: 'e1', productionDateFrom: '2026-10-29', productionDateTo: '2026-10-30', slotId: null, status: 'active' as const },
  ]
  it('冻结区间重叠即拒（CS-S2）；邻接不重叠', () => {
    expectRule(
      () => assertNoActiveFreezeOverlap({ scope: 'equipment_date_range', equipmentId: 'e1', productionDateFrom: '2026-10-30', productionDateTo: '2026-11-01', slotId: null }, active),
      'CS-S2',
    )
    expect(() =>
      assertNoActiveFreezeOverlap({ scope: 'equipment_date_range', equipmentId: 'e1', productionDateFrom: '2026-10-31', productionDateTo: '2026-11-01', slotId: null }, active),
    ).not.toThrow()
  })
  it('单槽位冻结形状与同槽位活动唯一；设备区间命中或槽位命中即冻结（CS-11）', () => {
    expect(() => assertFreezeShape({ scope: 'slot', equipmentId: 'e1', productionDateFrom: '2026-10-29', productionDateTo: '2026-10-29', slotId: null })).toThrow(/slotId/)
    expect(() => assertFreezeShape({ scope: 'slot', equipmentId: 'e1', productionDateFrom: '2026-10-29', productionDateTo: '2026-10-30', slotId: 's1' })).toThrow(/单生产日/)
    expect(() =>
      assertNoActiveFreezeOverlap({ scope: 'slot', equipmentId: 'e1', productionDateFrom: '2026-10-29', productionDateTo: '2026-10-29', slotId: 's1' }, [
        { id: 'f2', scope: 'slot', equipmentId: 'e1', productionDateFrom: '2026-10-29', productionDateTo: '2026-10-29', slotId: 's1', status: 'active' },
      ]),
    ).toThrow(/同槽位至多一条活动冻结/)
    expect(isSlotFrozen({ id: 's9', equipmentId: 'e1', productionDate: '2026-10-29' }, active)).toBe(true)
    expect(isSlotFrozen({ id: 's9', equipmentId: 'e2', productionDate: '2026-10-29' }, active)).toBe(false)
    expect(isEquipmentDateFrozen('e1', '2026-10-30', active)).toBe(true)
    expect(DEFAULT_FREEZE_DAYS).toBe(1)
  })
  it('解冻须理由（asserts 收窄）', () => {
    expectRule(() => assertUnfreezeReasonProvided(null), 'CS-11')
    expectRule(() => assertUnfreezeReasonProvided('  '), 'CS-11')
    const reason: string | null = '产线调整'
    assertUnfreezeReasonProvided(reason)
    expect(reason).toBe('产线调整')
  })
})

describe('CS-16/CS-S3 换型矩阵', () => {
  const matrix = {
    id: 'm1',
    plantId: 'p1',
    versionNo: 2,
    dimensionKind: 'operation' as const,
    defaultMinutes: 10,
    entries: [
      { fromValue: 'JX', toValue: 'SJ', minutes: 30 },
      { fromValue: 'SJ', toValue: 'JX', minutes: 25 },
    ],
  }
  it('发布形状：条目非空、分钟 0..1440、键不重复', () => {
    expectRule(() => assertMatrixPublishable({ dimensionKind: 'operation', defaultMinutes: 10, entries: [] }), 'CS-16')
    expectRule(
      () => assertMatrixPublishable({ dimensionKind: 'operation', defaultMinutes: 10, entries: [{ fromValue: 'A', toValue: 'B', minutes: 1500 }] }),
      'CS-16',
    )
    expect(() =>
      assertMatrixPublishable({ dimensionKind: 'operation', defaultMinutes: 10, entries: [
        { fromValue: 'A', toValue: 'B', minutes: 5 },
        { fromValue: 'A', toValue: 'B', minutes: 6 },
      ] }),
    ).toThrow(/维度键唯一/)
    expect(() => assertMatrixPublishable({ dimensionKind: 'operation', defaultMinutes: 10, entries: [{ fromValue: 'A', toValue: 'B', minutes: 5 }] })).not.toThrow()
    expect(nextMatrixVersionNo(2)).toBe(3)
  })
  it('查表：命中条目取条目值，未命中取缺省，无前序不计（CS-16）', () => {
    expect(lookupChangeoverMinutes(matrix, 'JX', 'SJ')).toBe(30)
    expect(lookupChangeoverMinutes(matrix, 'JX', 'XX')).toBe(10)
    expect(lookupChangeoverMinutes(matrix, null, 'SJ')).toBe(0)
    expect(lookupChangeoverMinutes(null, 'JX', 'SJ')).toBe(0)
  })
})

describe('CS-17/CS-18 权重与求解窗口', () => {
  it('默认权重 0.5/0.3/0.2；偏离须可识别（GAP-E11 建议默认）', () => {
    expect(DEFAULT_PRIORITY_WEIGHTS).toEqual({ dueDate: '0.5000', changeover: '0.3000', loadBalance: '0.2000' })
    expect(weightsDifferFromDefault({ dueDate: '0.5000', changeover: '0.3000', loadBalance: '0.2000' })).toBe(false)
    expect(weightsDifferFromDefault({ dueDate: '0.6000', changeover: '0.2000', loadBalance: '0.2000' })).toBe(true)
  })
  it('权重合计须为 1（CS-17）', () => {
    expectRule(() => assertPriorityWeightsValid({ dueDate: '0.5', changeover: '0.2', loadBalance: '0.2' }), 'CS-17')
    expect(() => assertPriorityWeightsValid({ dueDate: '0.5', changeover: '0.3', loadBalance: '0.2' })).not.toThrow()
  })
  it('窗口默认 7 日、1..90 校验、日期序列含今日（CS-18）', () => {
    expect(DEFAULT_HORIZON_DAYS).toBe(7)
    expectRule(() => assertHorizonDaysValid(0), 'CS-18')
    expect(horizonDates('2026-10-28', 3)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30'])
    expect(dueDateUrgency('2026-10-25', '2026-10-28')).toBe(-3)
    expect(dueDateUrgency(null, '2026-10-28')).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('CS-12/CS-14/CS-15 候选评估与无解呈现', () => {
  const weights = { changeover: 0.3, loadBalance: 0.2 }
  it('维修/校准失效/冻结/全日停机/外协占用 → 硬拒（CS-05/09/11/25）', () => {
    const t = task()
    expect(evaluateCandidate(t, candidate({ equipmentStatus: 2 }), '100', weights, () => 0).blocked).toBe('equipment_repair')
    expect(evaluateCandidate(t, candidate({ calibrationEffect: 'invalid' }), '100', weights, () => 0).blocked).toBe('calibration_invalid')
    expect(evaluateCandidate(t, candidate({ frozen: true }), '100', weights, () => 0).blocked).toBe('freeze_window')
    expect(evaluateCandidate(t, candidate({ downtimeFraction: 1 }), '100', weights, () => 0).blocked).toBe('downtime')
    expect(evaluateCandidate(task({ outsourced: true }), candidate(), '100', weights, () => 0).blocked).toBe('outsourcing_occupied')
  })
  it('超产能与交期冲突为软违反（CS-06①②）；择优确定性', () => {
    const t = task()
    const over = evaluateCandidate(t, candidate({ capacity: '100', dayPlannedQty: '50' }), '100', weights, () => 0)
    expect(over.blocked).toBeNull()
    expect(over.softViolations.map((s) => s.code)).toContain('capacity_overrun')
    const dueConflict = evaluateCandidate(t, candidate({ capacity: null, productionDate: '2026-11-06' }), '100', weights, () => 0)
    expect(dueConflict.dueDateConflict).toBe(true)
    expect(dueConflict.softViolations.map((s) => s.code)).toContain('due_date_conflict')
    const best = selectBestCandidate([
      evaluateCandidate(t, candidate({ equipmentId: 'eq-b' }), '100', weights, () => 30),
      evaluateCandidate(t, candidate({ equipmentId: 'eq-a' }), '100', weights, () => 0),
      evaluateCandidate(t, candidate({ equipmentId: 'eq-c', equipmentStatus: 2 }), '100', weights, () => 0),
    ])
    expect(best?.equipmentId).toBe('eq-a')
    expect(selectBestCandidate([evaluateCandidate(t, candidate({ equipmentStatus: 2 }), '100', weights, () => 0)])).toBeNull()
  })
  it('解释含命中约束与被拒清单（CS-12）', () => {
    const chosen = evaluateCandidate(task(), candidate(), '100', weights, () => 0)
    const e = buildTaskExplanation({
      orderNo: 'ORD-1',
      operationName: '绞线',
      chosen,
      candidates: [chosen, evaluateCandidate(task(), candidate({ equipmentId: 'eq-b', equipmentStatus: 2 }), '100', weights, () => 0)],
    })
    expect(e.why).toContain('ORD-1')
    expect(e.rejectedAlternatives.some((r) => r.reason.includes('维修'))).toBe(true)
  })
  it('无解呈现：冲突集+建议（放开工期/换设备/外协），不静默丢弃（CS-15）', () => {
    const conflict = buildConflictItem({
      task: task(),
      horizonLastDate: '2026-11-03',
      candidates: [evaluateCandidate(task(), candidate({ equipmentStatus: 2 }), '80', weights, () => 0)],
      hasAnyEquipmentCandidate: true,
    })
    expect(conflict.conflictSet.length).toBe(1)
    expect(conflict.suggestions.map((s) => s.option)).toEqual(expect.arrayContaining(['delay_start', 'change_equipment', 'outsourcing']))
    const started = buildConflictItem({ task: task({ executionStatus: 'executed' }), horizonLastDate: '2026-11-03', candidates: [], hasAnyEquipmentCandidate: false })
    expect(started.suggestions.some((s) => s.option === 'manual_decision')).toBe(true)
  })
  it('已开工/冻结槽位 keep；余量＝下线−已排（CS-14）', () => {
    expect(classifyExistingSlot({ id: 's', frozen: false, started: true })).toBe('keep')
    expect(classifyExistingSlot({ id: 's', frozen: true, started: false })).toBe('keep')
    expect(classifyExistingSlot({ id: 's', frozen: false, started: false })).toBe('movable')
    expect(remainingQtyOf({ offlineQty: '300', plannedQty: '120' })).toBe('180')
    expect(remainingQtyOf({ offlineQty: '300', plannedQty: '300' })).toBe('0')
  })
})

describe('CS-19/CS-22/CS-25 外协状态机', () => {
  it('具名命令状态迁移矩阵与非法迁移拒绝（CS-19）', () => {
    expect(assertOutsourcingTransition('submit', 'draft')).toBe('pending_send')
    expect(assertOutsourcingTransition('send', 'pending_send')).toBe('sent')
    expect(assertOutsourcingTransition('receive', 'sent')).toBe('return_received')
    expect(assertOutsourcingTransition('inspect', 'return_received')).toBe('inspecting')
    expect(assertOutsourcingTransition('close', 'inspecting')).toBe('closed')
    expect(assertOutsourcingTransition('recall', 'sent')).toBe('recalled')
    expect(assertOutsourcingTransition('dispose', 'return_received')).toBe('return_disposed')
    expectRule(() => assertOutsourcingTransition('send', 'draft'), 'CS-19')
    expectRule(() => assertOutsourcingTransition('close', 'sent'), 'CS-19')
    expect(isOutsourcingTerminal('closed')).toBe(true)
    expect(isOutsourcingTerminal('sent')).toBe(false)
    expect(isOutsourcingOccupationActive('sent')).toBe(true)
    expect(isOutsourcingOccupationActive('draft')).toBe(false)
    expect(isOutsourcingOccupationActive('closed')).toBe(false)
  })
  it('所有权保留：外协发送不得变更所有者（CS-20）', () => {
    expectRule(() => assertOwnershipRetainedOnSend({ fromOwnerId: 'o1', toOwnerId: 'o2', unitNo: 'U1' }), 'CS-20')
    expect(() => assertOwnershipRetainedOnSend({ fromOwnerId: 'o1', toOwnerId: 'o1', unitNo: 'U1' })).not.toThrow()
  })
  it('发送/回厂行形状：非空、数量>0、单元不重复（CS-21）', () => {
    expectRule(() => assertSendLinesShape([]), 'CS-21')
    expectRule(() => assertSendLinesShape([{ unitId: 'u1', quantity: '0' }]), 'CS-S4')
    expect(() =>
      assertSendLinesShape([
        { unitId: 'u1', quantity: '10' },
        { unitId: 'u1', quantity: '5' },
      ]),
    ).toThrow(/重复单元/)
  })
  it('回厂默认全部必检；关闭须检验通过（CS-22/CS-25）', () => {
    expectRule(() => assertReturnEntersPendingInspection('qualified'), 'CS-22')
    expect(() => assertReturnEntersPendingInspection('pending_inspection')).not.toThrow()
    expect(() => assertCloseRequiresInspectionPassed('passed')).not.toThrow()
    expectRule(() => assertCloseRequiresInspectionPassed(null), 'CS-25')
    expectRule(() => assertCloseRequiresInspectionPassed('rejected'), 'CS-25')
  })
  it('商务结算归 ERP：载荷携带金额/发票字段即拒（CS-24）', () => {
    expectRule(() => assertNoSettlementFields({ qty: '10', amount: '100' }), 'CS-24')
    expectRule(() => assertNoSettlementFields({ invoiceNo: 'F-1' }), 'CS-24')
    expect(() => assertNoSettlementFields({ qty: '10' })).not.toThrow()
    expect(buildSettlementFact({ taskNo: 'OWT-1', supplierCode: 'S1', supplierName: '供应商', orderNo: 'ORD', operationName: '绞线', sentQty: '10', returnedQty: '8', uom: 'M', sentAt: null, receivedAt: null, closedAt: null }).returnedQty).toBe('8')
  })
})
