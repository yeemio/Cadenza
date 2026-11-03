import { describe, expect, it } from 'vitest'
import {
  InventoryRuleViolation,
  addQty,
  assertNoShippedChildrenForSplitReversal,
  assertNotCancellable,
  assertAvailableForIssue,
  assertCustomerSegmentReallocation,
  assertEdgeEndpoints,
  assertNoActiveBindingConflict,
  assertOneBindingPerOrderAxis,
  assertQuantityTuple,
  assertReservationAcquirable,
  assertReservationUsableForCommit,
  assertSameUomForAggregation,
  assertSingleCandidate,
  assertSplitConservation,
  assertUnitNotLockedByOtherTask,
  assertWithinOverrunLimit,
  buildPostingLine,
  cmpQty,
  computeAvailability,
  computeShiftDate,
  ensureStableLockOrder,
  exactConversionFactor,
  feetDisplayFromMeters,
  guessBarcodeKind,
  isReservationEffective,
  isValidQuantityString,
  resolveBarcodeCandidates,
  subQty,
  zeroBalanceDisposition,
} from '@cadenza/domain'

/** IT 规则纯函数单测（冻结合同 inventory-trace-core.md 逐条；无数据库依赖）。 */
function expectViolation(rule: string, fn: () => void): void {
  try {
    fn()
    expect.unreachable(`预期违反 ${rule} 但未抛出`)
  } catch (error) {
    expect(error).toBeInstanceOf(InventoryRuleViolation)
    expect((error as InventoryRuleViolation).rule).toBe(rule)
  }
}

describe('IT-07/08/11/12 数量口径', () => {
  it('IT-07：十进制定点校验与定点算术（4 位小数、无浮点误差）', () => {
    expect(isValidQuantityString('100')).toBe(true)
    expect(isValidQuantityString('100.5')).toBe(true)
    expect(isValidQuantityString('100.5000')).toBe(true)
    expect(isValidQuantityString('-3.2')).toBe(true)
    expect(isValidQuantityString('1e5')).toBe(false)
    expect(isValidQuantityString('100.50000')).toBe(false)
    expect(isValidQuantityString(100)).toBe(false)
    expect(addQty('0.1', '0.2')).toBe('0.3000')
    expect(subQty('100.0000', '0.0001')).toBe('99.9999')
    expect(cmpQty('1.0', '1.0000')).toBe(0)
  })

  it('IT-08：数量四元组缺 uom/measurement_basis 拒绝', () => {
    expectViolation('IT-08', () => assertQuantityTuple({ quantity: '1.0', uomId: '', measurementBasis: 'nominal' }))
    expectViolation('IT-08', () =>
      assertQuantityTuple({ quantity: '1.0', uomId: 'u1', measurementBasis: '' }),
    )
    expect(() =>
      assertQuantityTuple({ quantity: '5.0000', uomId: 'u1', measurementBasis: 'nominal' }),
    ).not.toThrow()
  })

  it('IT-09：同量纲精确换算表命中；米↔千克无全局因子（须物料维度）', () => {
    expect(exactConversionFactor('m', 'km')).toBe('0.0010')
    expect(exactConversionFactor('kg', 't')).toBe('0.0010')
    expect(exactConversionFactor('m', 'kg')).toBeNull()
  })

  it('IT-10：英尺展示列 = 米 ÷ 0.3048 截断 4 位（仅展示不入账）', () => {
    expect(feetDisplayFromMeters('100.0000')).toBe('328.0839') // 100/0.3048=328.08398…→截断
    expect(feetDisplayFromMeters('0.3047')).toBe('0.9996') // 0.3047/0.3048=0.99967…→截断
    expect(cmpQty(feetDisplayFromMeters('0.3048'), '1.0000')).toBe(0)
  })

  it('IT-11：不同单位不得直接汇总', () => {
    expect(() =>
      assertSameUomForAggregation([{ uomId: 'u-m' }, { uomId: 'u-m' }]),
    ).not.toThrow()
    expectViolation('IT-11', () => assertSameUomForAggregation([{ uomId: 'u-m' }, { uomId: 'u-kg' }]))
  })

  it('IT-12：超产上限服务端按同单位校验', () => {
    expect(() =>
      assertWithinOverrunLimit({ orderedQty: '100', receivedTotalQty: '105', limitPercent: '5', uomId: 'u1' }),
    ).not.toThrow()
    expectViolation('IT-12', () =>
      assertWithinOverrunLimit({ orderedQty: '100', receivedTotalQty: '105.0001', limitPercent: '5', uomId: 'u1' }),
    )
  })
})

describe('IT-13/14/15 可用量与并发消费', () => {
  const now = '2026-10-27T10:00:00.000Z'

  it('IT-14：待检/不合格/存疑余额可用量为 0（不得发运）', () => {
    for (const qualityStatus of ['pending_inspection', 'unqualified', 'suspect'] as const) {
      const a = computeAvailability({
        grossQty: '100',
        qualityStatus,
        activeReservations: [],
        now,
      })
      expect(a.available).toBe('0.0000')
    }
    const ok = computeAvailability({ grossQty: '100', qualityStatus: 'qualified', activeReservations: [], now })
    expect(ok.available).toBe('100.0000')
  })

  it('IT-14：可用量 = 合格毛量 − 有效预留；过期预留不占量', () => {
    const a = computeAvailability({
      grossQty: '100',
      qualityStatus: 'qualified',
      activeReservations: [
        { status: 'active', quantity: '20', validUntil: '2026-10-27T12:00:00.000Z' },
        { status: 'active', quantity: '30', validUntil: '2026-10-27T09:00:00.000Z' }, // 已过期
        { status: 'released', quantity: '10', validUntil: '2026-10-27T12:00:00.000Z' }, // 已释放
      ],
      now,
    })
    expect(a.reserved).toBe('20.0000')
    expect(a.available).toBe('80.0000')
  })

  it('IT-14/IT-30：发料申请超可用量 → 可解释拒绝', () => {
    expectViolation('IT-14', () =>
      assertAvailableForIssue({
        grossQty: '100',
        qualityStatus: 'qualified',
        activeReservations: [{ status: 'active', quantity: '50', validUntil: '2026-10-27T12:00:00.000Z' }],
        requestedQty: '60',
        now,
        unitNo: 'U1',
      }),
    )
  })

  it('IT-15：同一码被其它任务占用 → 拒绝（行锁/唯一约束语义断言位）', () => {
    expect(() =>
      assertUnitNotLockedByOtherTask({ unitNo: 'U1', activeHolderRefs: ['job-1'], currentHolderRef: 'job-1' }),
    ).not.toThrow()
    expectViolation('IT-15', () =>
      assertUnitNotLockedByOtherTask({ unitNo: 'U1', activeHolderRefs: ['job-1'], currentHolderRef: 'job-2' }),
    )
  })
})

describe('IT-04/05/06 条码解析链', () => {
  it('IT-05：已知散点判定（载具第 2 位 E/F/M/P、R 类原料、8 位货架、E/F 成品）；未知不冒充', () => {
    expect(guessBarcodeKind('1E23456789').kind).toBe('carrier')
    expect(guessBarcodeKind('1F23456789').kind).toBe('carrier')
    expect(guessBarcodeKind('R123456789').kind).toBe('raw_material')
    expect(guessBarcodeKind('12345678').kind).toBe('shelf')
    expect(guessBarcodeKind('E12345678901').kind).toBe('finished_goods')
    expect(guessBarcodeKind('X1').confidence).toBe('unknown')
  })

  it('IT-04：载具装载展开多候选显式拒绝；单候选直取；空码空集', () => {
    const emptyLoad = resolveBarcodeCandidates({
      activeBinding: { boundType: 'carrier' as const, boundId: 'c1' },
      loadedUnits: [],
    })
    expect(emptyLoad).toEqual([])
    const withLoad = resolveBarcodeCandidates({
      activeBinding: { boundType: 'carrier' as const, boundId: 'c1' },
      loadedUnits: [
        { unitId: 'u1', unitNo: 'HT-001' },
        { unitId: 'u2', unitNo: 'HT-002' },
      ],
    })
    expect(withLoad).toHaveLength(2)
    expectViolation('IT-04', () => assertSingleCandidate('inventory.split', withLoad))
    expect(() =>
      assertSingleCandidate('inventory.split', [
        { objectType: 'inventory_unit', objectId: 'u1', label: 'HT-001', via: 'direct_binding' },
      ]),
    ).not.toThrow()
  })

  it('IT-06：同码值已有活动绑定 → 拒绝新绑定', () => {
    expect(() =>
      assertNoActiveBindingConflict('R123456789', null),
    ).not.toThrow()
    expectViolation('IT-06', () =>
      assertNoActiveBindingConflict('R123456789', { boundType: 'inventory_unit', boundId: 'u1' }),
    )
  })
})

describe('IT-19/20/25/27/29/30 流水与并发', () => {
  it('IT-19/IT-30-①：流水行含扣前/扣后；负余额拒绝；零变动拒绝', () => {
    const line = buildPostingLine({
      lineNo: 1,
      movementKind: 'issue',
      beforeQty: '100.0000',
      deltaQty: '-70.0000',
      uomId: 'u-m',
    })
    expect(line.beforeQty).toBe('100.0000')
    expect(line.afterQty).toBe('30.0000')
    expect(line.closesBalance).toBe(false)
    expectViolation('IT-30', () =>
      buildPostingLine({ lineNo: 1, movementKind: 'issue', beforeQty: '50', deltaQty: '-70', uomId: 'u-m' }),
    )
    expectViolation('IT-19', () =>
      buildPostingLine({ lineNo: 1, movementKind: 'issue', beforeQty: '50', deltaQty: '0', uomId: 'u-m' }),
    )
  })

  it('IT-29：零余额关闭活动余额、不删除档案', () => {
    expect(zeroBalanceDisposition('0.0000')).toEqual({ closeBalance: true, deleteArchive: false })
    expect(zeroBalanceDisposition('30.0000').closeBalance).toBe(false)
  })

  it('IT-25/27：稳定次序锁（排序去重防死锁）', () => {
    expect(ensureStableLockOrder(['c', 'a', 'b', 'a'])).toEqual(['a', 'b', 'c'])
  })
})

describe('IT-28/29/30/31 守恒与不可逆', () => {
  it('IT-28：分盘守恒式 原量=子段+留存+损耗；不满足拒绝', () => {
    expect(() =>
      assertSplitConservation({
        originalQty: '1000',
        childQtyList: ['600', '390'],
        retainedQty: '0',
        lossQty: '10',
        uomId: 'u-m',
      }),
    ).not.toThrow()
    expectViolation('IT-28', () =>
      assertSplitConservation({
        originalQty: '1000',
        childQtyList: ['600', '390'],
        retainedQty: '0',
        lossQty: '0',
        uomId: 'u-m',
      }),
    )
  })

  it('IT-30-②：子轴已发运 → 回撤原倒轴受阻', () => {
    expect(() =>
      assertNoShippedChildrenForSplitReversal({ childStatuses: [{ unitNo: 'C1', status: 'in_stock' }] }),
    ).not.toThrow()
    expectViolation('IT-30', () =>
      assertNoShippedChildrenForSplitReversal({
        childStatuses: [
          { unitNo: 'C1', status: 'shipped' },
          { unitNo: 'C2', status: 'in_stock' },
        ],
      }),
    )
  })

  it('IT-31：已入库/被消耗/已发运/生效质量结果 → 不可直接取消原审核', () => {
    const noFacts = { received: false, consumed: false, converted: false, shipped: false, qualifiedResult: false }
    expect(() => assertNotCancellable({ subject: 'U1', facts: noFacts })).not.toThrow()
    expectViolation('IT-31', () =>
      assertNotCancellable({ subject: 'U1', facts: { ...noFacts, consumed: true } }),
    )
  })
})

describe('IT-23 作业预留', () => {
  const now = '2026-10-27T10:00:00.000Z'

  it('IT-23：四要素齐全方可签发；有效期必须晚于当前时间', () => {
    expect(() =>
      assertReservationAcquirable({
        unitId: 'u1',
        holderType: 'job',
        holderRef: 'WO-1',
        quantity: '30',
        validUntil: '2026-10-27T12:00:00.000Z',
        now,
      }),
    ).not.toThrow()
    expectViolation('IT-23', () =>
      assertReservationAcquirable({
        unitId: 'u1',
        holderType: 'job',
        holderRef: 'WO-1',
        quantity: '30',
        validUntil: null,
        now,
      }),
    )
    expectViolation('IT-23', () =>
      assertReservationAcquirable({
        unitId: 'u1',
        holderType: 'job',
        holderRef: '',
        quantity: '30',
        validUntil: '2026-10-27T12:00:00.000Z',
        now,
      }),
    )
    expectViolation('IT-23', () =>
      assertReservationAcquirable({
        unitId: 'u1',
        holderType: 'job',
        holderRef: 'WO-1',
        quantity: '30',
        validUntil: '2026-10-27T09:00:00.000Z',
        now,
      }),
    )
  })

  it('IT-23：过期后旧终端提交必须重校验（不得凭过期预留入账）', () => {
    const expired = { id: 'r1', status: 'active' as const, validUntil: '2026-10-27T09:00:00.000Z' }
    expect(isReservationEffective(expired, now)).toBe(false)
    expectViolation('IT-23', () => assertReservationUsableForCommit(expired, now))
    const ok = { id: 'r2', status: 'active' as const, validUntil: '2026-10-27T12:00:00.000Z' }
    expect(() => assertReservationUsableForCommit(ok, now)).not.toThrow()
  })
})

describe('IT-34/36 谱系与轴号修正', () => {
  it('IT-34：边类型端点配对非法拒绝；同订单一轴号一绑', () => {
    expect(() =>
      assertEdgeEndpoints('receipt_origin', 'material_lot', 'inventory_unit'),
    ).not.toThrow()
    expectViolation('IT-34', () => assertEdgeEndpoints('receipt_origin', 'inventory_unit', 'inventory_unit'))
    expect(() =>
      assertOneBindingPerOrderAxis({ orderNo: 'SO-1', existingBindings: [{ orderNo: 'SO-1', unitId: 'u1' }], unitId: 'u1' }),
    ).not.toThrow()
    expectViolation('IT-34', () =>
      assertOneBindingPerOrderAxis({ orderNo: 'SO-1', existingBindings: [{ orderNo: 'SO-1', unitId: 'u1' }], unitId: 'u2' }),
    )
  })

  it('IT-36：不自动解绑他人占用客户轴号；核权确认后显式重分配', () => {
    const occupied = { orderNo: 'SO-1', occupiedByHolderRef: 'WO-9' }
    expectViolation('IT-36', () =>
      assertCustomerSegmentReallocation({ target: occupied, reallocationConfirmed: false, actorCanReallocate: false }),
    )
    expectViolation('IT-36', () =>
      assertCustomerSegmentReallocation({ target: occupied, reallocationConfirmed: false, actorCanReallocate: true }),
    )
    expect(() =>
      assertCustomerSegmentReallocation({ target: occupied, reallocationConfirmed: true, actorCanReallocate: true }),
    ).not.toThrow()
  })
})

describe('IT-37 时间双轨', () => {
  it('IT-37：班次日期按工厂日历＋时区＋白班起点折算（白班起点前归前一班次日）', () => {
    // 本地（UTC+8）2026-10-28 02:30；白班起点 0 点 → 班次日 10-28
    expect(computeShiftDate('2026-10-27T18:30:00.000Z')).toBe('2026-10-28')
    // 同一时刻、白班起点 4 点 → 02:30 < 04:00 归前一班次日 10-27
    expect(computeShiftDate('2026-10-27T18:30:00.000Z', { dayShiftStartHour: 4, utcOffsetHours: 8 })).toBe('2026-10-27')
    // 本地 2026-10-27 09:00 → 班次日 10-27
    expect(computeShiftDate('2026-10-27T01:00:00.000Z')).toBe('2026-10-27')
  })
})
