import { describe, expect, it } from 'vitest'
// domain maintenance 面未并入包名入口（L0 整合步统一导出）：测试相对导入源码（同 reporting 先例）
import {
  CAPACITY_EVENT_AGGREGATE_TYPE,
  CAPACITY_EVENT_TASK_KIND,
  EQUIPMENT_STATUS,
  MAINTENANCE_ORDER_STATUSES,
  MAINTENANCE_ORDER_TRANSITIONS,
  RESTART_ORDER_RESULT,
  SparePartInsufficientError,
  addDays,
  assertAnomalyReportSubmittable,
  assertCancellable,
  assertCheckItemTemplate,
  assertCloseFields,
  assertDowntimeCloseNoNegativeDuration,
  assertDowntimeReason,
  assertDispatchFields,
  assertEquipmentStatusSource,
  assertEquipmentStatusValue,
  assertFailedRoundAnomalyNote,
  assertInspectionResult,
  assertNoDowntimeOverlap,
  assertOrderNotConcluded,
  assertOrderTransition,
  assertPlanCycle,
  assertPlanEffectiveRange,
  assertRestartExecutable,
  assertSpareUsageQuantity,
  assertStartWorkExecutable,
  buildCapacityChangeEvent,
  buildRepairReportSuggestion,
  buildStatusLogEntry,
  canCancelOrder,
  compareDecimalQuantity,
  computeNextDueDate,
  computeStartWorkBusinessDate,
  deductAvailableQuantity,
  equipmentStatusProjectionFor,
  isPlanOverdue,
  MaintenanceRuleViolation,
  normalizeScannedEquipmentCode,
  parseSpareQuantity,
  pickEffectivePlanVersion,
  resolveScannedEquipmentCode,
} from '../../packages/domain/src/maintenance/index'

/** 断言规则违例（编号＋中文信息）。 */
function expectViolation(fn: () => unknown, rule: string, messageLike?: string): void {
  try {
    fn()
    expect.unreachable(`应抛 ${rule} 违例`)
  } catch (error) {
    expect(error).toBeInstanceOf(MaintenanceRuleViolation)
    const violation = error as MaintenanceRuleViolation
    expect(violation.rule).toBe(rule)
    if (messageLike !== undefined) expect(violation.message).toContain(messageLike)
  }
}

describe('MT-01 设备状态字典仅 2 值（1=正常、2=维修）', () => {
  it('合法值通过', () => {
    expect(assertEquipmentStatusValue(1)).toBe(EQUIPMENT_STATUS.NORMAL)
    expect(assertEquipmentStatusValue(2)).toBe(EQUIPMENT_STATUS.REPAIR)
  })
  it('超出 2 值拒绝（含字符串/空值）', () => {
    expectViolation(() => assertEquipmentStatusValue(3), 'MT-01', '仅 2 值')
    expectViolation(() => assertEquipmentStatusValue('1'), 'MT-01')
    expectViolation(() => assertEquipmentStatusValue(0), 'MT-01')
  })
})

describe('MT-02 状态变更流水判定（新值=旧值不产生流水）', () => {
  it('相同状态返回 null（不产生流水）', () => {
    expect(
      buildStatusLogEntry({
        equipmentId: 'eq-1',
        oldStatus: 1,
        newStatus: 1,
        source: 'PDA',
        actor: 'op01',
        occurredAt: '2026-10-28T08:00:00Z',
      }),
    ).toBeNull()
  })
  it('状态变化返回流水条目（前值/后值/操作人/时间/来源）', () => {
    const entry = buildStatusLogEntry({
      equipmentId: 'eq-1',
      oldStatus: 1,
      newStatus: 2,
      source: 'PDA',
      actor: 'op01',
      occurredAt: '2026-10-28T08:00:00Z',
    })
    expect(entry).toMatchObject({ equipmentId: 'eq-1', oldStatus: 1, newStatus: 2, source: 'PDA', actor: 'op01' })
  })
  it('来源字典仅 WEB/PDA', () => {
    expect(assertEquipmentStatusSource('WEB')).toBe('WEB')
    expect(assertEquipmentStatusSource('PDA')).toBe('PDA')
    expectViolation(() => assertEquipmentStatusSource('APP'), 'MT-02', 'WEB/PDA')
  })
})

describe('MT-03 异常上报提交守卫（未扫到设备/未选状态不可提交）', () => {
  it('无设备主键拒绝', () => {
    expectViolation(
      () => assertAnomalyReportSubmittable({ equipmentId: null, targetStatus: 2 }),
      'MT-03',
      '未扫到有效设备',
    )
  })
  it('未选状态拒绝', () => {
    expectViolation(
      () => assertAnomalyReportSubmittable({ equipmentId: 'eq-1', targetStatus: undefined }),
      'MT-03',
      '未选择目标状态',
    )
  })
  it('齐备通过', () => {
    expect(() => assertAnomalyReportSubmittable({ equipmentId: 'eq-1', targetStatus: 2 })).not.toThrow()
  })
})

describe('MT-04 设备码识别宽容（EQU-/equ- 前缀剥离；生成侧仅大写归 MD-15/CA-8）', () => {
  it('大写/小写前缀均剥离', () => {
    expect(normalizeScannedEquipmentCode('EQU-JC-01')).toBe('JC-01')
    expect(normalizeScannedEquipmentCode('equ-JC-01')).toBe('JC-01')
  })
  it('无前缀原样返回', () => {
    expect(normalizeScannedEquipmentCode('JC-01')).toBe('JC-01')
  })
  it('空扫码/仅前缀拒绝', () => {
    expectViolation(() => resolveScannedEquipmentCode(''), 'MT-03')
    expectViolation(() => resolveScannedEquipmentCode('   '), 'MT-03')
    expectViolation(() => resolveScannedEquipmentCode('EQU-'), 'MT-03', '剥离前缀后为空')
  })
})

describe('MT-05 设备开工可执行（设备存在且状态=正常）', () => {
  it('设备不存在拒绝', () => {
    expectViolation(() => assertStartWorkExecutable(null), 'MT-05', '设备不存在')
  })
  it('状态非正常拒绝（维修中不可开工）', () => {
    expectViolation(
      () => assertStartWorkExecutable({ id: 'eq-1', equipmentStatus: 2, status: 'active' }),
      'MT-05',
      '非正常',
    )
  })
  it('退役设备拒绝', () => {
    expectViolation(
      () => assertStartWorkExecutable({ id: 'eq-1', equipmentStatus: 1, status: 'retired' }),
      'MT-05',
      '退役',
    )
  })
  it('正常设备通过', () => {
    expect(() => assertStartWorkExecutable({ id: 'eq-1', equipmentStatus: 1, status: 'active' })).not.toThrow()
  })
})

describe('MT-06 开工业务日（IT-37 班次规则，不按自然日硬编码）', () => {
  it('按工厂时区（UTC+8）折算业务日：UTC 前一日深夜归本地当日', () => {
    // 2026-10-27T20:00:00Z = 北京时间 2026-10-28 04:00 → 业务日 2026-10-28（非 UTC 自然日 10-27）
    expect(computeStartWorkBusinessDate('2026-10-27T20:00:00Z')).toBe('2026-10-28')
  })
  it('本地同日时刻业务日一致', () => {
    expect(computeStartWorkBusinessDate('2026-10-28T01:30:00+08:00')).toBe('2026-10-28')
  })
})

describe('MT-07 维修工单状态机（合法迁移集封闭）', () => {
  it('合法迁移通过（已报修→分派→处理中→待复机→关闭）', () => {
    expect(() => assertOrderTransition('reported', 'dispatched')).not.toThrow()
    expect(() => assertOrderTransition('dispatched', 'in_progress')).not.toThrow()
    expect(() => assertOrderTransition('in_progress', 'pending_restart')).not.toThrow()
    expect(() => assertOrderTransition('pending_restart', 'closed')).not.toThrow()
  })
  it('越级迁移拒绝（已报修→处理中）', () => {
    expectViolation(() => assertOrderTransition('reported', 'in_progress'), 'MT-07', '非法迁移')
  })
  it('逆向迁移拒绝（处理中→已分派；待复机→处理中）', () => {
    expectViolation(() => assertOrderTransition('in_progress', 'dispatched'), 'MT-07')
    expectViolation(() => assertOrderTransition('pending_restart', 'in_progress'), 'MT-07')
  })
  it('终态（已关闭/已取消）不可迁出', () => {
    expect(MAINTENANCE_ORDER_TRANSITIONS.closed).toHaveLength(0)
    expect(MAINTENANCE_ORDER_TRANSITIONS.cancelled).toHaveLength(0)
    expectViolation(() => assertOrderTransition('closed', 'reported'), 'MT-07')
  })
  it('待复机不可取消（迁移集外）', () => {
    expect(MAINTENANCE_ORDER_TRANSITIONS.pending_restart).not.toContain('cancelled')
  })
  it('六值状态字典封闭', () => {
    expect(MAINTENANCE_ORDER_STATUSES).toEqual([
      'reported',
      'dispatched',
      'in_progress',
      'pending_restart',
      'closed',
      'cancelled',
    ])
  })
  it('关闭必须记录结果与责任人（任一为空不可关闭）', () => {
    expectViolation(() => assertCloseFields('', '张三'), 'MT-07', '结果为空')
    expectViolation(() => assertCloseFields('复机正常', ' '), 'MT-07', '责任人为空')
    expect(() => assertCloseFields('复机正常', '张三')).not.toThrow()
  })
})

describe('MT-08 设备状态是投影（工单事件驱动）', () => {
  it('受理报修建单置维修（2），复机关闭置正常（1）', () => {
    expect(equipmentStatusProjectionFor('order_created')).toBe(2)
    expect(equipmentStatusProjectionFor('order_restarted')).toBe(1)
  })
})

describe('MT-10 复机执行（仅待复机可执行；结果=复机正常）', () => {
  it('非待复机状态拒绝', () => {
    expectViolation(() => assertRestartExecutable('in_progress'), 'MT-10', '仅"待复机"')
    expectViolation(() => assertRestartExecutable('closed'), 'MT-10')
  })
  it('待复机通过；结果口径固定', () => {
    expect(() => assertRestartExecutable('pending_restart')).not.toThrow()
    expect(RESTART_ORDER_RESULT).toBe('复机正常')
  })
})

describe('MT-13 报修入口与分派（被派人必填）', () => {
  it('被派人为空不可分派', () => {
    expectViolation(() => assertDispatchFields(''), 'MT-13', '被派人为空')
    expect(() => assertDispatchFields('李四')).not.toThrow()
  })
})

describe('MT-14 取消语义与结果不可再改', () => {
  it('可取消状态=已报修/已分派/处理中', () => {
    expect(canCancelOrder('reported')).toBe(true)
    expect(canCancelOrder('dispatched')).toBe(true)
    expect(canCancelOrder('in_progress')).toBe(true)
    expect(canCancelOrder('pending_restart')).toBe(false)
    expect(canCancelOrder('closed')).toBe(false)
  })
  it('待复机/已关闭不可取消', () => {
    expectViolation(() => assertCancellable('pending_restart', '计划变更'), 'MT-14', '不可取消')
    expectViolation(() => assertCancellable('closed', '计划变更'), 'MT-14')
  })
  it('取消原因必填', () => {
    expectViolation(() => assertCancellable('reported', ''), 'MT-14', '取消原因')
    expectViolation(() => assertCancellable('reported', undefined), 'MT-14')
  })
  it('关闭后结果不可再改', () => {
    expectViolation(() => assertOrderNotConcluded('closed'), 'MT-14', '不可再改')
    expectViolation(() => assertOrderNotConcluded('cancelled'), 'MT-14')
    expect(() => assertOrderNotConcluded('pending_restart')).not.toThrow()
  })
})

describe('MT-09 停机事件（区间不重叠、无负时长、原因必填）', () => {
  it('原因必填（分类字典 GAP-F22 待裁）', () => {
    expectViolation(() => assertDowntimeReason(''), 'MT-09', '停机原因')
    expectViolation(() => assertDowntimeReason(undefined), 'MT-09')
  })
  it('同设备区间重叠拒绝（含在停机中的开区间）', () => {
    expectViolation(
      () =>
        assertNoDowntimeOverlap(
          { startAt: '2026-10-28T10:00:00Z', endAt: null },
          [{ startAt: '2026-10-28T08:00:00Z', endAt: null }],
        ),
      'MT-09',
      '不重叠',
    )
    expectViolation(
      () =>
        assertNoDowntimeOverlap(
          { startAt: '2026-10-28T09:00:00Z', endAt: '2026-10-28T11:00:00Z' },
          [{ startAt: '2026-10-28T08:00:00Z', endAt: '2026-10-28T10:00:00Z' }],
        ),
      'MT-09',
    )
  })
  it('紧邻区间不算重叠（前 end == 后 start）', () => {
    expect(() =>
      assertNoDowntimeOverlap(
        { startAt: '2026-10-28T10:00:00Z', endAt: null },
        [{ startAt: '2026-10-28T08:00:00Z', endAt: '2026-10-28T10:00:00Z' }],
      ),
    ).not.toThrow()
  })
  it('完全分离区间通过', () => {
    expect(() =>
      assertNoDowntimeOverlap(
        { startAt: '2026-10-29T08:00:00Z', endAt: '2026-10-29T12:00:00Z' },
        [{ startAt: '2026-10-28T08:00:00Z', endAt: '2026-10-28T10:00:00Z' }],
      ),
    ).not.toThrow()
  })
  it('负时长拒绝（开与闭两个方向）', () => {
    expectViolation(
      () => assertNoDowntimeOverlap({ startAt: '2026-10-28T12:00:00Z', endAt: '2026-10-28T08:00:00Z' }, []),
      'MT-09',
      '负时长',
    )
    expectViolation(
      () => assertDowntimeCloseNoNegativeDuration('2026-10-28T12:00:00Z', '2026-10-28T08:00:00Z'),
      'MT-09',
      '负时长',
    )
  })
})

describe('MT-11 备件消耗（>0 且 ≤ 实时可用量；十进制字符串口径）', () => {
  it('数量口径解析（禁负/禁超 4 位小数/禁非字符串）', () => {
    expect(parseSpareQuantity('30.5')).toBe('30.5')
    expectViolation(() => parseSpareQuantity('-1'), 'MT-11')
    expectViolation(() => parseSpareQuantity('1.23456'), 'MT-11')
    expectViolation(() => parseSpareQuantity(5), 'MT-11')
  })
  it('数量必须大于 0', () => {
    expectViolation(() => assertSpareUsageQuantity('0.0000', '100.0000'), 'MT-11', '大于 0')
  })
  it('超出实时可用量拒绝（专用违例→ERR_INSUFFICIENT_STOCK）', () => {
    expect(() => assertSpareUsageQuantity('100.0001', '100.0000')).toThrow(SparePartInsufficientError)
    expect(() => assertSpareUsageQuantity('100.0000', '100.0000')).not.toThrow()
  })
  it('扣后余额计算与十进制比较', () => {
    expect(deductAvailableQuantity('100.0000', '30.5000')).toBe('69.5000')
    expect(compareDecimalQuantity('30.5', '30.5000')).toBe(0)
    expect(compareDecimalQuantity('30.5', '30.5001')).toBe(-1)
  })
})

describe('MT-12 点检/保养计划（版本化/双存/超期提示/不合格异常记录）', () => {
  it('周期最小机制 everyDays>=1', () => {
    expect(assertPlanCycle({ everyDays: 7 })).toEqual({ everyDays: 7 })
    expectViolation(() => assertPlanCycle({ everyDays: 0 }), 'MT-12', 'everyDays')
    expectViolation(() => assertPlanCycle('daily'), 'MT-12')
  })
  it('检查项模板非空字符串数组', () => {
    expect(assertCheckItemTemplate(['轴承温度', '油位'])).toEqual(['轴承温度', '油位'])
    expectViolation(() => assertCheckItemTemplate([]), 'MT-12', '至少一项')
    expectViolation(() => assertCheckItemTemplate(['', '油位']), 'MT-12')
  })
  it('生效区间守卫', () => {
    expect(() => assertPlanEffectiveRange('2026-10-01', null)).not.toThrow()
    expect(() => assertPlanEffectiveRange('2026-10-01', '2026-10-31')).not.toThrow()
    expectViolation(() => assertPlanEffectiveRange('2026-10-01', '2026-10-01'), 'MT-12', '生效区间')
  })
  it('版本择优：生效区间内取最高 active 版本', () => {
    const versions = [
      { planKey: 'PLAN-A', version: 1, effectiveFrom: '2026-10-01', effectiveTo: null, status: 'active' },
      { planKey: 'PLAN-A', version: 2, effectiveFrom: '2026-10-10', effectiveTo: null, status: 'active' },
      { planKey: 'PLAN-A', version: 3, effectiveFrom: '2026-11-01', effectiveTo: null, status: 'active' },
    ]
    expect(pickEffectivePlanVersion(versions, '2026-10-20')?.version).toBe(2)
    expect(pickEffectivePlanVersion(versions, '2026-10-05')?.version).toBe(1)
    expect(pickEffectivePlanVersion(versions, '2026-09-30')).toBeNull()
  })
  it('超期判定与下次应执行日（锚点＋everyDays）', () => {
    expect(addDays('2026-10-01', 7)).toBe('2026-10-08')
    expect(computeNextDueDate('2026-10-01', { everyDays: 7 })).toBe('2026-10-08')
    expect(isPlanOverdue('2026-10-08', '2026-10-09')).toBe(true)
    expect(isPlanOverdue('2026-10-08', '2026-10-08')).toBe(false)
  })
  it('执行结果 pass/fail；不合格必填异常说明', () => {
    expect(assertInspectionResult('pass')).toBe('pass')
    expectViolation(() => assertInspectionResult('ok'), 'MT-12', 'pass/fail')
    expectViolation(() => assertFailedRoundAnomalyNote('fail', ''), 'MT-12', '异常说明')
    expect(() => assertFailedRoundAnomalyNote('fail', '轴承异响')).not.toThrow()
    expect(() => assertFailedRoundAnomalyNote('pass', null)).not.toThrow()
  })
  it('不合格建议关联报修（不自动建单，GAP-F19）', () => {
    expect(buildRepairReportSuggestion({ result: 'pass', equipmentId: 'eq-1', anomalyNote: null })).toBeNull()
    const suggestion = buildRepairReportSuggestion({ result: 'fail', equipmentId: 'eq-1', anomalyNote: '轴承异响' })
    expect(suggestion).toMatchObject({ suggested: true, equipmentId: 'eq-1', anomalyNote: '轴承异响' })
    expect(suggestion?.reason).toContain('不自动建单')
  })
})

describe('MT-10/15 能力变化事件（含停机起止与原因；工单聚合可追溯）', () => {
  it('事件形状：task_kind/聚合/载荷链路', () => {
    const event = buildCapacityChangeEvent({
      changeKind: 'restored',
      orderId: 'mo-1',
      orderNo: 'MO-20261028-01',
      equipmentId: 'eq-1',
      equipmentCode: 'JC-01',
      plantId: 'plnt-1',
      downtimeStartAt: '2026-10-28T08:00:00Z',
      downtimeEndAt: '2026-10-28T12:00:00Z',
      downtimeReason: '轴承更换',
      occurredAt: '2026-10-28T12:00:00Z',
    })
    expect(event.aggregateType).toBe(CAPACITY_EVENT_AGGREGATE_TYPE)
    expect(event.taskKind).toBe(CAPACITY_EVENT_TASK_KIND)
    expect(event.aggregateId).toBe('mo-1')
    expect(event.payload).toMatchObject({
      changeKind: 'restored',
      downtimeStartAt: '2026-10-28T08:00:00Z',
      downtimeEndAt: '2026-10-28T12:00:00Z',
      downtimeReason: '轴承更换',
      equipmentCode: 'JC-01',
    })
  })
})
