import { describe, expect, it } from 'vitest'
import {
  SchedulingRuleViolation,
  assertCapacityValueValid,
  assertDayShiftStartValid,
  assertEquipmentAllowsSlot,
  assertOperationPlannedQtyWithinOffline,
  assertPlannedQtyValid,
  assertProductionDateValid,
  assertShiftConfigured,
  buildShiftDualTrack,
  computeBoardDates,
  computeShiftDate,
  DEVICE_BOARD_DAY_WINDOW,
  evaluateCapacityWarning,
  isCapacityOverrunConfirmed,
  isOrderExcludedFromBoard,
  isValidDayShiftStart,
  orderDetailEntryBlocker,
  pdaDefaultDateWindow,
  planSlotSave,
  projectOperationScheduling,
  projectOrderSchedulingStatus,
  sameSlotIdentity,
  shiftDate,
  sumOperationPlannedQty,
  sumPlannedQty,
  type SlotIdentityKey,
} from '../../packages/domain/src/scheduling/index'

/**
 * scheduling 域纯规则单测（T09）——覆盖底稿 A3/A4 全部规则条目
 * （对照表见 delivery/L1/server-scheduling/DELIVERY.md §6）。
 */

const identity = (over: Partial<SlotIdentityKey> = {}): SlotIdentityKey => ({
  orderId: 'order-1',
  orderOperationId: 'op-1',
  operationDefinitionId: 'od-1',
  equipmentId: 'eq-1',
  productionDate: '2026-11-02',
  ...over,
})

describe('[A3-1] 生产日期与计划数量口径', () => {
  it('生产日期：合法 YYYY-MM-DD 通过；非法格式/非真实日历日拒绝', () => {
    expect(() => assertProductionDateValid('2026-11-02')).not.toThrow()
    expect(() => assertProductionDateValid('2026-02-30')).toThrow(SchedulingRuleViolation)
    expect(() => assertProductionDateValid('2026-13-01')).toThrow(SchedulingRuleViolation)
    expect(() => assertProductionDateValid('2026/11/02')).toThrow(SchedulingRuleViolation)
    expect(() => assertProductionDateValid('2026-11-2')).toThrow(SchedulingRuleViolation)
  })

  it('计划产量：≥0、≤4 位小数、≤10 位整数；负数/5 位小数/11 位整数拒绝', () => {
    expect(() => assertPlannedQtyValid('0')).not.toThrow()
    expect(() => assertPlannedQtyValid('3060')).not.toThrow()
    expect(() => assertPlannedQtyValid('1.0001')).not.toThrow()
    expect(() => assertPlannedQtyValid('-1')).toThrow(SchedulingRuleViolation)
    expect(() => assertPlannedQtyValid('1.00001')).toThrow(SchedulingRuleViolation)
    expect(() => assertPlannedQtyValid('12345678901')).toThrow(SchedulingRuleViolation)
  })

  it('设备日产能：≥0（含 0=零产能）；负数拒绝', () => {
    expect(() => assertCapacityValueValid('0')).not.toThrow()
    expect(() => assertCapacityValueValid('5000.5')).not.toThrow()
    expect(() => assertCapacityValueValid('-0.1')).toThrow(SchedulingRuleViolation)
  })

  it('日期算术：前一日/后一日跨月正确（无时区偏移）', () => {
    expect(shiftDate('2026-11-02', -1)).toBe('2026-11-01')
    expect(shiftDate('2026-11-01', -1)).toBe('2026-10-31')
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29') // 闰年
  })
})

describe('[A3-1] 槽位唯一键与替换/删槽语义', () => {
  it('五元组相同判定 sameSlotIdentity；任一键不同则不同槽位', () => {
    expect(sameSlotIdentity(identity(), identity())).toBe(true)
    expect(sameSlotIdentity(identity(), identity({ equipmentId: 'eq-2' }))).toBe(false)
    expect(sameSlotIdentity(identity(), identity({ productionDate: '2026-11-03' }))).toBe(false)
    expect(sameSlotIdentity(identity(), identity({ orderOperationId: 'op-2' }))).toBe(false)
  })

  it('planSlotSave：正数 → upsert（同键替换旧值）；已有槽改 0 → delete；无槽改 0 → noop', () => {
    const upsert = planSlotSave({ identity: identity(), plannedQty: '100', existingSlot: null })
    expect(upsert.kind).toBe('upsert')
    const replace = planSlotSave({
      identity: identity(),
      plannedQty: '250',
      existingSlot: { plannedQty: '100' },
    })
    expect(replace).toMatchObject({ kind: 'upsert', plannedQty: '250' })
    const remove = planSlotSave({
      identity: identity(),
      plannedQty: '0',
      existingSlot: { plannedQty: '250' },
    })
    expect(remove.kind).toBe('delete')
    const noop = planSlotSave({ identity: identity(), plannedQty: '0', existingSlot: null })
    expect(noop.kind).toBe('noop')
  })
})

describe('[A3-2] 硬校验：工序计划合计（本槽按替换旧值计）≤ 下线数量', () => {
  it('合计 = 其它槽合计 + 本槽新值（旧值不计入）', () => {
    expect(sumOperationPlannedQty({ otherSlotsPlannedQty: '1000', currentSlotNewQty: '500' })).toBe('1500')
    expect(sumPlannedQty(['100', '200', '50.5'])).toBe('350.5')
    expect(sumPlannedQty([])).toBe('0')
  })

  it('合计超下线数量 → 拒（强校验）；等值/低于 → 通过', () => {
    expect(() =>
      assertOperationPlannedQtyWithinOffline({ offlineQty: '3060', plannedTotal: '3060' }),
    ).not.toThrow()
    expect(() =>
      assertOperationPlannedQtyWithinOffline({ offlineQty: '3060', plannedTotal: '3060.0001' }),
    ).toThrowError(/超过下线数量/)
    try {
      assertOperationPlannedQtyWithinOffline({ offlineQty: '100', plannedTotal: '150' })
      expect.unreachable()
    } catch (error) {
      expect((error as SchedulingRuleViolation).rule).toBe('A3-2')
    }
  })

  it('替换旧值语义：其它槽 1000 + 本槽改 2000（旧 1000）→ 合计 3000 判定不含旧值', () => {
    // 下线 2500：若误把旧值计入会得 4000 拒绝；正确口径 3000 仍超 → 拒
    expect(() =>
      assertOperationPlannedQtyWithinOffline({
        offlineQty: '2500',
        plannedTotal: sumOperationPlannedQty({ otherSlotsPlannedQty: '1000', currentSlotNewQty: '2000' }),
      }),
    ).toThrow(SchedulingRuleViolation)
    // 下线 3000：正确口径 3000 = 边界通过
    expect(() =>
      assertOperationPlannedQtyWithinOffline({
        offlineQty: '3000',
        plannedTotal: sumOperationPlannedQty({ otherSlotsPlannedQty: '1000', currentSlotNewQty: '2000' }),
      }),
    ).not.toThrow()
  })
})

describe('[A3-2w] 弱提醒：超设备日产能二次确认可过', () => {
  it('产能未配置（null）不比较 → 无提醒', () => {
    expect(
      evaluateCapacityWarning({
        equipmentName: '绞线机-01',
        productionDate: '2026-11-02',
        capacity: null,
        equipmentDayPlannedTotal: '999999',
      }),
    ).toBeNull()
  })

  it('累计超产能（含配置为 0）→ 返回提醒（PRD 确认文案口径）；未超/等值 → 无提醒', () => {
    expect(
      evaluateCapacityWarning({
        equipmentName: '绞线机-01',
        productionDate: '2026-11-02',
        capacity: '0',
        equipmentDayPlannedTotal: '100',
      }),
    ).toMatchObject({ equipmentName: '绞线机-01', capacity: '0', plannedTotal: '100' })
    const warning = evaluateCapacityWarning({
      equipmentName: '绞线机-01',
      productionDate: '2026-11-02',
      capacity: '5000',
      equipmentDayPlannedTotal: '5000.0001',
    })
    expect(warning).not.toBeNull()
    expect(warning!.message).toContain('绞线机-01')
    expect(warning!.message).toContain('超过设备产能')
    expect(
      evaluateCapacityWarning({
        equipmentName: '绞线机-01',
        productionDate: '2026-11-02',
        capacity: '5000',
        equipmentDayPlannedTotal: '5000',
      }),
    ).toBeNull()
  })

  it('确认标志：confirm=true 放行；未确认/false 拒（弱提醒语义）', () => {
    expect(isCapacityOverrunConfirmed(true)).toBe(true)
    expect(isCapacityOverrunConfirmed(false)).toBe(false)
    expect(isCapacityOverrunConfirmed(undefined)).toBe(false)
  })
})

describe('[A3-3] 设备状态约束（维修且无槽不可新建正数）', () => {
  it('维修设备：无现有槽 + 正数 → 拒；已有槽改正数 → 过；改 0 删槽 → 过；正常设备 → 过', () => {
    const facts = (over: { status?: number; existing?: string | null; qty?: string }) => ({
      equipmentStatus: over.status ?? 2,
      equipmentName: '绞线机-01',
      existingSlotPlannedQty: over.existing ?? null,
      newPlannedQty: over.qty ?? '100',
    })
    expect(() => assertEquipmentAllowsSlot(facts({}))).toThrowError(/维修状态且本槽位尚无排产/)
    expect(() => assertEquipmentAllowsSlot(facts({ existing: '100' }))).not.toThrow()
    expect(() => assertEquipmentAllowsSlot(facts({ qty: '0', existing: '100' }))).not.toThrow()
    expect(() => assertEquipmentAllowsSlot(facts({ status: 1 }))).not.toThrow()
  })
})

describe('[A3-4] 回写链投影：工序已排/是否排完/订单排产状态', () => {
  it('单工序投影：合计 ≥ 下线数量 → 排完；下线 0 的工序 0 计划即排完', () => {
    expect(projectOperationScheduling({ offlineQty: '3060', plannedQty: '3060' })).toEqual({
      scheduledQty: '3060',
      fullyScheduled: true,
    })
    expect(projectOperationScheduling({ offlineQty: '3060', plannedQty: '3059.9999' }).fullyScheduled).toBe(false)
    expect(projectOperationScheduling({ offlineQty: '0', plannedQty: '0' }).fullyScheduled).toBe(true)
  })

  it('订单排产状态三态：无计划=未排产；全排完=已排产；其余=部分排产', () => {
    expect(projectOrderSchedulingStatus([])).toBe('unplanned')
    expect(
      projectOrderSchedulingStatus([
        { offlineQty: '100', plannedQty: '0' },
        { offlineQty: '200', plannedQty: '0' },
      ]),
    ).toBe('unplanned')
    expect(
      projectOrderSchedulingStatus([
        { offlineQty: '100', plannedQty: '100' },
        { offlineQty: '200', plannedQty: '200' },
      ]),
    ).toBe('fully_scheduled')
    expect(
      projectOrderSchedulingStatus([
        { offlineQty: '100', plannedQty: '100' },
        { offlineQty: '200', plannedQty: '50' },
      ]),
    ).toBe('partially_scheduled')
    // 全部工序已排完但无任何有效计划（全 0 下线病态数据）→ 未排产（有效计划口径）
    expect(
      projectOrderSchedulingStatus([
        { offlineQty: '0', plannedQty: '0' },
        { offlineQty: '0', plannedQty: '0' },
      ]),
    ).toBe('unplanned')
  })
})

describe('[A3-5] 设备看板日期列与已结束订单排除', () => {
  it('日期列 = 今日起连续 30 天 ∪ 已有排产日（升序去重；窗口外历史日保留）', () => {
    const dates = computeBoardDates({
      today: '2026-11-02',
      existingDates: ['2026-11-02', '2026-11-05', '2026-10-01', '非法日期'],
    })
    expect(dates[0]).toBe('2026-10-01') // 窗口外已有排产日保留
    expect(dates).toContain('2026-11-02')
    expect(dates).toContain('2026-12-01') // 今日起第 30 天
    expect(dates).not.toContain('2026-12-02') // 第 31 天不在窗口
    expect(new Set(dates).size).toBe(dates.length) // 去重
    expect(dates.length).toBe(DEVICE_BOARD_DAY_WINDOW + 1) // 30 天窗 + 1 个窗外历史日
  })

  it('已结束/已作废订单排产不展示口径判定', () => {
    expect(isOrderExcludedFromBoard('closed')).toBe(true)
    expect(isOrderExcludedFromBoard('voided')).toBe(true)
    expect(isOrderExcludedFromBoard('in_progress')).toBe(false)
    expect(isOrderExcludedFromBoard('approved')).toBe(false)
  })
})

describe('[A3-6] 订单排程详情前置（工序已配置且各工序均已配置工作中心）', () => {
  it('未配置/无工序行/缺工作中心 → 阻塞原因；齐全 → null', () => {
    expect(orderDetailEntryBlocker({ processConfigStatus: 'unconfigured', operations: [] })).toContain('A3-6')
    expect(
      orderDetailEntryBlocker({ processConfigStatus: 'configured', operations: [] }),
    ).toContain('工序行')
    expect(
      orderDetailEntryBlocker({
        processConfigStatus: 'configured',
        operations: [{ workCenterId: 'wc-1' }, { workCenterId: null }],
      }),
    ).toContain('工作中心')
    expect(
      orderDetailEntryBlocker({
        processConfigStatus: 'configured',
        operations: [{ workCenterId: 'wc-1' }],
      }),
    ).toBeNull()
  })
})

describe('[A4] 班次跨日（白班起点，双轨时间）', () => {
  it('白班起点校验：HH:MM 24 小时制；非法格式拒绝', () => {
    expect(isValidDayShiftStart('08:00')).toBe(true)
    expect(isValidDayShiftStart('00:00')).toBe(true)
    expect(isValidDayShiftStart('23:59')).toBe(true)
    expect(isValidDayShiftStart('24:00')).toBe(false)
    expect(isValidDayShiftStart('8:00')).toBe(false)
    expect(isValidDayShiftStart('08:60')).toBe(false)
    expect(() => assertDayShiftStartValid('08:00')).not.toThrow()
    expect(() => assertDayShiftStartValid('0800')).toThrow(SchedulingRuleViolation)
  })

  it('班次日期：白班 08:00 时 07:59 归前一日、08:00 归当日（等值起点归当日）', () => {
    expect(computeShiftDate('2026-11-02T07:59:00Z', '08:00')).toBe('2026-11-01')
    expect(computeShiftDate('2026-11-02T08:00:00Z', '08:00')).toBe('2026-11-02')
    expect(computeShiftDate('2026-11-02T23:30:00Z', '08:00')).toBe('2026-11-02')
    // 月初跨月
    expect(computeShiftDate('2026-11-01T00:05:00Z', '08:00')).toBe('2026-10-31')
  })

  it('双轨时间：实际时间与业务班次日期并存互不覆盖', () => {
    const dual = buildShiftDualTrack('2026-11-02T07:59:00Z', '08:00')
    expect(dual).toEqual({
      actualTime: '2026-11-02T07:59:00Z',
      shiftDate: '2026-11-01',
      dayShiftStart: '08:00',
    })
  })

  it('未配置白班起点：不能扫码口径（断言拒绝）；非法 ISO 时间拒绝', () => {
    expect(() => assertShiftConfigured(null)).toThrowError(/未配置白班开始时间/)
    expect(() => assertShiftConfigured('08:00')).not.toThrow()
    expect(() => computeShiftDate('2026-11-02', '08:00')).toThrow(SchedulingRuleViolation)
  })

  it('PDA 排产计划默认日期窗：当天及往前 7 天（共 8 天升序）', () => {
    expect(pdaDefaultDateWindow('2026-11-02')).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ])
  })
})
