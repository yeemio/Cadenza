import { describe, expect, it } from 'vitest'
// domain shipping 面未并入包名入口（共享文件 domain/src/index.ts 不改动）：
// 测试直接以相对路径消费 TS 源码（vitest 转译；typecheck:tests 以相对导入纳入编译）。
import {
  ShippingRuleViolation,
  advanceLineProgress,
  applyScanRemoval,
  assertActualAxisRetryable,
  assertBindPalletReady,
  assertConfirmShippable,
  assertPackedPalletReadonly,
  assertPackingStartable,
  assertPlLinesShape,
  assertPlStep,
  assertScanLoadable,
  assertShipmentLineSpec,
  assertStatusSyncRetryable,
  assertSupplementaryAxisLoadable,
  deriveOrderStatus,
  readLineSnapshotSegment,
  resolveActualAxisSyncDecision,
  type ShipmentLineSpec,
} from '../../packages/domain/src/shipping/index'

/**
 * T14 shipping 域纯规则单测——规则底稿 04 §A-T14-1~5/7/8 与 interfaces.md IF-06/07/00.6。
 * 覆盖：PL 状态机、三类行规格、扫码五拒一成、行/单状态流转、删码退回、补码、
 * 打包任务前置与托码只读、确认出库应扫不足指名、实发轴差异判定、回传重试快照校验。
 */

const baseAxisLine: ShipmentLineSpec = {
  lineNo: 1,
  lineKind: 'axis_item',
  materialCode: 'MAT-FIN-CABLE',
  salesOrderLineNo: '10',
  requiredCount: 1,
  customerAxisNo: 'CAX-0001',
  standardSegmentLength: '1200.0000',
}

function expectViolation(fn: () => void, rule: string): void {
  expect(fn).toThrow(ShippingRuleViolation)
  try {
    fn()
  } catch (error) {
    expect((error as ShippingRuleViolation).rule).toBe(rule)
    expect((error as ShippingRuleViolation).message.length).toBeGreaterThan(0)
  }
}

describe('A-T14-1 PL 状态机', () => {
  it('待装箱→待出库→已出库 合法步进', () => {
    expect(() => assertPlStep('pending_packing', 'ready_to_ship')).not.toThrow()
    expect(() => assertPlStep('ready_to_ship', 'shipped')).not.toThrow()
  })

  it('跳步与回退拒绝（待装箱→已出库、已出库→待出库）', () => {
    expectViolation(() => assertPlStep('pending_packing', 'shipped'), 'A-T14-1')
    expectViolation(() => assertPlStep('shipped', 'ready_to_ship'), 'A-T14-1')
  })
})

describe('A-T14-3 备货三类行规格', () => {
  it('有轴单品：缺客户轴号拒', () => {
    expectViolation(() => assertShipmentLineSpec({ ...baseAxisLine, customerAxisNo: null }), 'A-T14-3')
  })

  it('有轴单品：缺标准段长拒（无段长）', () => {
    expectViolation(() => assertShipmentLineSpec({ ...baseAxisLine, standardSegmentLength: null }), 'A-T14-3')
  })

  it('有轴单品：标准段长必须为正十进制定点', () => {
    expectViolation(() => assertShipmentLineSpec({ ...baseAxisLine, standardSegmentLength: '0' }), 'A-T14-3')
    expectViolation(() => assertShipmentLineSpec({ ...baseAxisLine, standardSegmentLength: '12.00001' }), 'A-T14-3')
  })

  it('无轴单品：段长快照可缺（入站标黄）、携带客户轴号或段长非法拒', () => {
    const plain: ShipmentLineSpec = {
      lineNo: 2,
      lineKind: 'plain_item',
      materialCode: 'MAT-FIN-PART',
      salesOrderLineNo: '20',
      requiredCount: 5,
      segmentLength: '50.0000',
    }
    expect(() => assertShipmentLineSpec(plain)).not.toThrow()
    expect(() => assertShipmentLineSpec({ ...plain, segmentLength: null })).not.toThrow() // 缺组成数据入站标记，扫码时"无段长拒收"
    expectViolation(() => assertShipmentLineSpec({ ...plain, customerAxisNo: 'CAX-X' }), 'A-T14-3')
    expectViolation(() => assertShipmentLineSpec({ ...plain, segmentLength: '0' }), 'A-T14-3')
  })

  it('托盘行：携带客户轴号或总轴数缺失拒', () => {
    const pallet: ShipmentLineSpec = {
      lineNo: 3,
      lineKind: 'pallet',
      materialCode: 'MAT-FIN-DRUM',
      salesOrderLineNo: '30',
      requiredCount: 8,
    }
    expect(() => assertShipmentLineSpec(pallet)).not.toThrow()
    expectViolation(() => assertShipmentLineSpec({ ...pallet, customerAxisNo: 'CAX-P' }), 'A-T14-3')
    expectViolation(() => assertShipmentLineSpec({ ...pallet, requiredCount: 0 }), 'A-T14-3')
  })

  it('PL 行集：空集与行号重复拒（IF-05）', () => {
    expectViolation(() => assertPlLinesShape([]), 'A-T14-1')
    expectViolation(() => assertPlLinesShape([baseAxisLine, { ...baseAxisLine }]), 'A-T14-1')
  })

  it('快照段长读取：有轴=标准段长、无轴=段长、托盘=无单值段长', () => {
    expect(
      readLineSnapshotSegment({ lineKind: 'axis_item', standardSegmentLength: '1200.0000', segmentLength: null }),
    ).toBe('1200.0000')
    expect(readLineSnapshotSegment({ lineKind: 'plain_item', standardSegmentLength: null, segmentLength: '50.0000' })).toBe(
      '50.0000',
    )
    expect(readLineSnapshotSegment({ lineKind: 'pallet', standardSegmentLength: null, segmentLength: null })).toBeNull()
  })
})

describe('A-T14-3 扫码装入五拒一成', () => {
  const loadableFacts = {
    unitNo: 'AX-0001',
    unitStatus: 'in_stock',
    qualityStatus: 'qualified',
    suspectHoldActive: false,
    lockedByOtherTask: false,
    alreadyLoadedInOrder: false,
    matchedLine: {
      lineId: 'line-1',
      lineKind: 'axis_item' as const,
      segmentLength: '1200.0000',
      requiredCount: 1,
      scannedCount: 0,
    },
  }

  it('一成：事实齐备可装入', () => {
    expect(() => assertScanLoadable(loadableFacts)).not.toThrow()
  })

  it('拒①未审核（待检质量状态）', () => {
    expectViolation(() => assertScanLoadable({ ...loadableFacts, qualityStatus: 'pending_inspection' }), 'A-T14-3')
  })

  it('拒②质量存疑恒拒', () => {
    expectViolation(() => assertScanLoadable({ ...loadableFacts, qualityStatus: 'suspect' }), 'A-T14-3')
    expectViolation(() => assertScanLoadable({ ...loadableFacts, suspectHoldActive: true }), 'A-T14-3')
  })

  it('拒③被其它业务锁定', () => {
    expectViolation(() => assertScanLoadable({ ...loadableFacts, lockedByOtherTask: true }), 'A-T14-3')
  })

  it('拒④未关联销售订单行', () => {
    expectViolation(() => assertScanLoadable({ ...loadableFacts, matchedLine: null }), 'A-T14-3')
  })

  it('拒⑤无段长（快照缺失）', () => {
    expectViolation(
      () =>
        assertScanLoadable({
          ...loadableFacts,
          matchedLine: { ...loadableFacts.matchedLine, segmentLength: null },
        }),
      'A-T14-3',
    )
  })

  it('拒：不在库/同码重复装入/行已扫满多扫', () => {
    expectViolation(() => assertScanLoadable({ ...loadableFacts, unitStatus: 'in_transit' }), 'A-T14-3')
    expectViolation(() => assertScanLoadable({ ...loadableFacts, alreadyLoadedInOrder: true }), 'A-T14-3')
    expectViolation(
      () =>
        assertScanLoadable({
          ...loadableFacts,
          matchedLine: { ...loadableFacts.matchedLine, scannedCount: 1, requiredCount: 1 },
        }),
      'A-T14-3',
    )
  })
})

describe('A-T14-3 行/单状态流转与删码退回', () => {
  it('行扫满→已装箱；未满→待装箱', () => {
    expect(advanceLineProgress({ scannedCount: 0, requiredCount: 1 })).toEqual({
      scannedCount: 1,
      lineStatus: 'packed',
    })
    expect(advanceLineProgress({ scannedCount: 0, requiredCount: 4 }).lineStatus).toBe('pending_packing')
  })

  it('全部行已装箱→待出库；任一未满→待装箱', () => {
    expect(deriveOrderStatus(['packed', 'packed'])).toBe('ready_to_ship')
    expect(deriveOrderStatus(['packed', 'pending_packing'])).toBe('pending_packing')
  })

  it('删码不满足退回待装箱（行与单同步回退）', () => {
    const removal = applyScanRemoval({ orderStatus: 'ready_to_ship', lineStatus: 'packed', scannedCount: 2, requiredCount: 2 })
    expect(removal).toEqual({ scannedCount: 1, lineStatus: 'pending_packing', orderStatus: 'pending_packing' })
  })

  it('已出库不可删码；无未删记录不可删', () => {
    expectViolation(
      () => applyScanRemoval({ orderStatus: 'shipped', lineStatus: 'packed', scannedCount: 2, requiredCount: 2 }),
      'A-T14-3',
    )
    expectViolation(
      () => applyScanRemoval({ orderStatus: 'pending_packing', lineStatus: 'pending_packing', scannedCount: 0, requiredCount: 2 }),
      'A-T14-3',
    )
  })
})

describe('A-T14-5 补码', () => {
  it('无轴行可补码且计入已扫件数', () => {
    expect(() =>
      assertSupplementaryAxisLoadable({ lineKind: 'plain_item', scannedCount: 0, requiredCount: 3, unitNo: 'AX-NEW' }),
    ).not.toThrow()
  })

  it('有轴/托盘行补码拒；无轴行扫满后补码拒（C-7 fail-closed）', () => {
    expectViolation(
      () => assertSupplementaryAxisLoadable({ lineKind: 'axis_item', scannedCount: 0, requiredCount: 1, unitNo: 'AX-1' }),
      'A-T14-5',
    )
    expectViolation(
      () => assertSupplementaryAxisLoadable({ lineKind: 'pallet', scannedCount: 0, requiredCount: 8, unitNo: 'AX-2' }),
      'A-T14-5',
    )
    expectViolation(
      () => assertSupplementaryAxisLoadable({ lineKind: 'plain_item', scannedCount: 3, requiredCount: 3, unitNo: 'AX-3' }),
      'A-T14-5',
    )
  })
})

describe('A-T14-4 打包任务', () => {
  it('创建前置：先扫托码+选调入库位（缺一拒）', () => {
    const base = { orderStatus: 'pending_packing' as const, toLocationId: 'loc-1', toLocationCode: '010101', palletLineCount: 2 }
    expect(() => assertPackingStartable({ ...base, palletCode: 'PLT-01' })).not.toThrow()
    expectViolation(() => assertPackingStartable({ ...base, palletCode: null }), 'A-T14-4')
    expectViolation(() => assertPackingStartable({ ...base, palletCode: 'PLT-01', toLocationId: null }), 'A-T14-4')
    expectViolation(
      () => assertPackingStartable({ ...base, palletCode: 'PLT-01', orderStatus: 'shipped' }),
      'A-T14-4',
    )
  })

  it('绑定托码前置：每行已扫完+托码+库位（未满指名拒）', () => {
    const lines = [
      { lineId: 'l1', lineKind: 'pallet', requiredCount: 2, scannedCount: 2, lineStatus: 'packed' },
      { lineId: 'l2', lineKind: 'pallet', requiredCount: 2, scannedCount: 1, lineStatus: 'pending_packing' },
    ]
    expectViolation(
      () =>
        assertBindPalletReady({ status: 'pending', palletCode: 'PLT-01', toLocationId: 'loc-1', lines, scannedOutsidePallet: 0 }),
      'A-T14-4',
    )
    expect(
      (() => {
        assertBindPalletReady({
          status: 'pending',
          palletCode: 'PLT-01',
          toLocationId: 'loc-1',
          lines: [lines[0]!],
          scannedOutsidePallet: 0,
        })
        return true
      })(),
    ).toBe(true)
    expectViolation(
      () =>
        assertBindPalletReady({
          status: 'bound',
          palletCode: 'PLT-01',
          toLocationId: 'loc-1',
          lines: [lines[0]!],
          scannedOutsidePallet: 0,
        }),
      'A-T14-4',
    )
  })

  it('已打包托码库位只读（重复打包/换库位拒）', () => {
    expectViolation(
      () =>
        assertPackedPalletReadonly({
          palletCode: 'PLT-01',
          boundPackingExists: true,
          existingPackingLocationId: 'loc-1',
          requestedLocationId: 'loc-2',
        }),
      'A-T14-4',
    )
    expectViolation(
      () =>
        assertPackedPalletReadonly({
          palletCode: 'PLT-01',
          boundPackingExists: true,
          existingPackingLocationId: 'loc-1',
          requestedLocationId: null,
        }),
      'A-T14-4',
    )
    expect(() =>
      assertPackedPalletReadonly({
        palletCode: 'PLT-01',
        boundPackingExists: false,
        existingPackingLocationId: null,
        requestedLocationId: 'loc-1',
      }),
    ).not.toThrow()
  })
})

describe('A-T14-7 确认出库', () => {
  const lines = [
    { lineId: 'l1', lineNo: 1, materialCode: 'MAT-FIN-CABLE', segmentLabel: '1200.0000', requiredCount: 1, scannedCount: 1 },
    { lineId: 'l2', lineNo: 2, materialCode: 'MAT-FIN-PART', segmentLabel: '50.0000', requiredCount: 5, scannedCount: 3 },
  ]

  it('仅待出库可确认；其它状态拒', () => {
    expectViolation(() => assertConfirmShippable({ orderStatus: 'pending_packing', lines }), 'A-T14-7')
    expectViolation(() => assertConfirmShippable({ orderStatus: 'shipped', lines }), 'A-T14-7')
  })

  it('应扫不足拒并指名料品/段长（已扫 x/应扫 y）', () => {
    try {
      assertConfirmShippable({ orderStatus: 'ready_to_ship', lines })
      expect.unreachable('应拒绝')
    } catch (error) {
      expect(error).toBeInstanceOf(ShippingRuleViolation)
      const violation = error as ShippingRuleViolation
      expect(violation.rule).toBe('A-T14-7')
      expect(violation.message).toContain('MAT-FIN-PART')
      expect(violation.message).toContain('50.0000')
      expect(violation.message).toContain('已扫 3')
      expect(violation.message).toContain('应扫 5')
    }
    expect(() =>
      assertConfirmShippable({ orderStatus: 'ready_to_ship', lines: [lines[0]!] }),
    ).not.toThrow()
  })
})

describe('A-T14-8/IF-06 实发轴差异判定与回传重试', () => {
  it('客户轴号与实发轴号无差异→noop_needed（不是失败）', () => {
    const decision = resolveActualAxisSyncDecision({ plannedCustomerAxes: ['CAX-1', 'CAX-2'], actualAxes: ['CAX-2', 'CAX-1'] })
    expect(decision.status).toBe('noop_needed')
    expect(decision.hasDiff).toBe(false)
  })

  it('有差异→pending（双向差异均列出）', () => {
    const decision = resolveActualAxisSyncDecision({ plannedCustomerAxes: ['CAX-1', 'CAX-2'], actualAxes: ['CAX-2', 'ACT-99'] })
    expect(decision.status).toBe('pending')
    expect(decision.missingOnActual).toEqual(['CAX-1'])
    expect(decision.extraOnActual).toEqual(['ACT-99'])
  })

  it('实发轴重试：仅已出库；synced/noop 终态不重做', () => {
    expectViolation(() => assertActualAxisRetryable({ orderStatus: 'ready_to_ship', currentStatus: 'pending' }), 'IF-06')
    expect(assertActualAxisRetryable({ orderStatus: 'shipped', currentStatus: 'pending' }).skipped).toBe(false)
    expect(assertActualAxisRetryable({ orderStatus: 'shipped', currentStatus: 'synced' }).skipped).toBe(true)
    expect(assertActualAxisRetryable({ orderStatus: 'shipped', currentStatus: 'noop_needed' }).skipped).toBe(true)
  })

  it('发货状态重试：快照缺失/不一致拒（IF-00.6 不改推当前值）；已成功侧不重做', () => {
    expectViolation(
      () =>
        assertStatusSyncRetryable({
          orderStatus: 'shipped',
          currentStatus: 'pending',
          snapshotCompletedAt: null,
          orderCompletedAt: '2026-10-27T10:00:00.000Z',
        }),
      'IF-00.6',
    )
    expectViolation(
      () =>
        assertStatusSyncRetryable({
          orderStatus: 'shipped',
          currentStatus: 'pending',
          snapshotCompletedAt: '2026-10-27T09:00:00.000Z',
          orderCompletedAt: '2026-10-27T10:00:00.000Z',
        }),
      'IF-00.6',
    )
    expect(
      assertStatusSyncRetryable({
        orderStatus: 'shipped',
        currentStatus: 'pending',
        snapshotCompletedAt: '2026-10-27T10:00:00.000Z',
        orderCompletedAt: '2026-10-27T10:00:00.000Z',
      }).skipped,
    ).toBe(false)
    expect(
      assertStatusSyncRetryable({
        orderStatus: 'shipped',
        currentStatus: 'synced',
        snapshotCompletedAt: '2026-10-27T10:00:00.000Z',
        orderCompletedAt: '2026-10-27T10:00:00.000Z',
      }).skipped,
    ).toBe(true)
  })
})
