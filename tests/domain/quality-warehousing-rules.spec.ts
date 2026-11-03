import { describe, expect, it } from 'vitest'
// domain quality/warehousing 面未并入包名入口（共享文件 domain/src/index.ts 不改动）：
// 测试直接以相对路径消费 TS 源码（vitest 转译；typecheck:tests 以相对导入纳入编译）。
import {
  QualityRuleViolation,
  assertConcessionBasedOnEffectiveVersion,
  assertInspectionOrderGeneratable,
  assertOutboundQualityGate,
  assertQualityNotBlockedForUse,
  assertReleaseExecutable,
  assertSpecReference,
  assertSuspectRegistratable,
  assertSuspectRestorable,
  assertTestResultSubmittable,
  isQualityUsable,
  nextTestResultVersion,
  projectQualityAxisToBalance,
} from '../../packages/domain/src/quality/index'
import {
  WarehousingRuleViolation,
  assertMoveExecutable,
  assertPutawayTargetWarehouse,
  assertRackPutawayLocation,
  assertTransferLockEffective,
  assertTransferLockIssuable,
  assertTransferStep,
  assertTransferWarehouses,
  assertTransitNotDoubleCounted,
  assertWholePalletPutaway,
} from '../../packages/domain/src/warehousing/index'

function expectQualityViolation(rule: string, fn: () => void): void {
  try {
    fn()
    expect.unreachable(`应抛出 QualityRuleViolation [${rule}]`)
  } catch (error) {
    expect(error).toBeInstanceOf(QualityRuleViolation)
    expect((error as QualityRuleViolation).rule).toBe(rule)
  }
}

function expectWarehousingViolation(rule: string, fn: () => void): void {
  try {
    fn()
    expect.unreachable(`应抛出 WarehousingRuleViolation [${rule}]`)
  } catch (error) {
    expect(error).toBeInstanceOf(WarehousingRuleViolation)
    expect((error as WarehousingRuleViolation).rule).toBe(rule)
  }
}

const MEASUREMENTS = [{ itemNo: 'T1', measuredValue: '3.20', judgement: 'pass' as const }]

describe('T12 质量轴与投影 [A-T12-1/2]', () => {
  it('六值轴：免检/合格可用；待检/不合格/待复检/存疑不可用', () => {
    expect(isQualityUsable('exempt')).toBe(true)
    expect(isQualityUsable('qualified')).toBe(true)
    expect(isQualityUsable('pending_inspection')).toBe(false)
    expect(isQualityUsable('unqualified')).toBe(false)
    expect(isQualityUsable('re_inspection')).toBe(false)
    expect(isQualityUsable('suspect')).toBe(false)
  })

  it('库存四值投影：待复检→待检、免检→合格，其余一一对应', () => {
    expect(projectQualityAxisToBalance('re_inspection')).toBe('pending_inspection')
    expect(projectQualityAxisToBalance('exempt')).toBe('qualified')
    expect(projectQualityAxisToBalance('suspect')).toBe('suspect')
    expect(projectQualityAxisToBalance('unqualified')).toBe('unqualified')
  })

  it('不可用状态不得进入可用量与发运 [A-T12-2]', () => {
    expectQualityViolation('A-T12-2', () => assertQualityNotBlockedForUse('pending_inspection', 'U1'))
    expectQualityViolation('A-T12-2', () => assertQualityNotBlockedForUse('suspect', 'U1'))
    expect(() => assertQualityNotBlockedForUse('qualified', 'U1')).not.toThrow()
  })
})

describe('T12 参数化出库闸门 [A-T12-4/A-T12-3]', () => {
  it('严格模式（默认）：待检/待复检/不合格拒绝出库，合格/免检放行', () => {
    expectQualityViolation('A-T12-4', () => assertOutboundQualityGate({ qualityStatus: 'pending_inspection', unitNo: 'U1' }))
    expectQualityViolation('A-T12-4', () => assertOutboundQualityGate({ qualityStatus: 're_inspection', unitNo: 'U1' }))
    expectQualityViolation('A-T12-4', () => assertOutboundQualityGate({ qualityStatus: 'unqualified', unitNo: 'U1' }))
    expect(() => assertOutboundQualityGate({ qualityStatus: 'qualified' })).not.toThrow()
    expect(() => assertOutboundQualityGate({ qualityStatus: 'exempt' })).not.toThrow()
  })

  it('参数放行模式：质检未完成可出库，但存疑恒拒 [A-T12-3]', () => {
    const policy = { allowUnfinishedOutbound: true }
    expect(() => assertOutboundQualityGate({ qualityStatus: 'pending_inspection', policy, unitNo: 'U1' })).not.toThrow()
    expect(() => assertOutboundQualityGate({ qualityStatus: 'unqualified', policy, unitNo: 'U1' })).not.toThrow()
    expectQualityViolation('A-T12-3', () => assertOutboundQualityGate({ qualityStatus: 'suspect', policy, unitNo: 'U1' }))
  })
})

describe('T12 放行/让步规则 [A-T12-1：让步保留原不合格事实]', () => {
  it('让步仅针对生效不合格结论，且必须引用当前生效版本', () => {
    expectQualityViolation('A-T12-1', () =>
      assertConcessionBasedOnEffectiveVersion({ effectiveConclusion: 'qualified', effectiveVersion: 2, basedOnVersion: 2 }),
    )
    expectQualityViolation('A-T12-1', () =>
      assertConcessionBasedOnEffectiveVersion({ effectiveConclusion: 'unqualified', effectiveVersion: 3, basedOnVersion: 2 }),
    )
    expect(() =>
      assertConcessionBasedOnEffectiveVersion({ effectiveConclusion: 'unqualified', effectiveVersion: 3, basedOnVersion: 3 }),
    ).not.toThrow()
  })

  it('常规放行：待检不可放行、不合格须走让步、已处置不可重复', () => {
    expectQualityViolation('A-T12-1', () => assertReleaseExecutable({ effectiveConclusion: 'pending', alreadyReleased: false }))
    expectQualityViolation('A-T12-1', () => assertReleaseExecutable({ effectiveConclusion: 'unqualified', alreadyReleased: false }))
    expectQualityViolation('A-T12-1', () => assertReleaseExecutable({ effectiveConclusion: 'qualified', alreadyReleased: true }))
    expect(() => assertReleaseExecutable({ effectiveConclusion: 'qualified', alreadyReleased: false })).not.toThrow()
  })
})

describe('T12 检验规范版本化与实测提交 [A-T12-5]', () => {
  it('检验规范引用版本化：缺编码/版本<1 拒绝', () => {
    expectQualityViolation('A-T12-5', () => assertSpecReference({ specCode: '', specVersion: 1 }))
    expectQualityViolation('A-T12-5', () => assertSpecReference({ specCode: 'SPEC-A', specVersion: 0 }))
    expectQualityViolation('A-T12-5', () => assertSpecReference({ specCode: 'SPEC-A', specVersion: null }))
    expect(() => assertSpecReference({ specCode: 'SPEC-A', specVersion: 2 })).not.toThrow()
  })

  it('检验任务生成载荷：来源/阶段/数量校验', () => {
    expectQualityViolation('A-T12-5', () =>
      assertInspectionOrderGeneratable({ sourceType: 'manual', sourceRef: 'E1', inspectionStage: 'finished', quantity: '1.0000', isPositive: true }),
    )
    expectQualityViolation('A-T12-5', () =>
      assertInspectionOrderGeneratable({ sourceType: 'work_report', sourceRef: '', inspectionStage: 'finished', quantity: '1.0000', isPositive: true }),
    )
    expectQualityViolation('A-T12-5', () =>
      assertInspectionOrderGeneratable({ sourceType: 'work_report', sourceRef: 'E1', inspectionStage: 'audit', quantity: '1.0000', isPositive: true }),
    )
    expectQualityViolation('A-T12-5', () =>
      assertInspectionOrderGeneratable({ sourceType: 'work_report', sourceRef: 'E1', inspectionStage: 'finished', quantity: '0.0000', isPositive: false }),
    )
    expect(() =>
      assertInspectionOrderGeneratable({ sourceType: 'work_report', sourceRef: 'E1', inspectionStage: 'process', quantity: '1.0000', isPositive: true }),
    ).not.toThrow()
  })

  it('实测提交：作废单拒、空实测拒、pending 结论拒；版本号递增（S14）', () => {
    expectQualityViolation('A-T12-5', () =>
      assertTestResultSubmittable({ orderStatus: 'cancelled', items: MEASUREMENTS, conclusion: 'qualified' }),
    )
    expectQualityViolation('A-T12-5', () =>
      assertTestResultSubmittable({ orderStatus: 'pending', items: [], conclusion: 'qualified' }),
    )
    expectQualityViolation('A-T12-5', () =>
      assertTestResultSubmittable({ orderStatus: 'pending', items: MEASUREMENTS, conclusion: 'pending' }),
    )
    expect(() => assertTestResultSubmittable({ orderStatus: 'pending', items: MEASUREMENTS, conclusion: 'qualified' })).not.toThrow()
    expect(nextTestResultVersion([])).toBe(1)
    expect(nextTestResultVersion([1, 2])).toBe(3)
  })
})

describe('T12 存疑登记/恢复 [A-T12-3 + B-9 最小处置记录]', () => {
  it('登记：托码拒、不在库拒、无库位拒、重复存疑拒；在库在库位未存疑通过', () => {
    expectQualityViolation('A-T12-3', () =>
      assertSuspectRegistratable({ barcodeKind: 'pallet', unitStatus: 'in_stock', hasLocation: true, hasActiveSuspect: false }),
    )
    expectQualityViolation('A-T12-3', () =>
      assertSuspectRegistratable({ barcodeKind: 'unit', unitStatus: 'in_transit', hasLocation: true, hasActiveSuspect: false }),
    )
    expectQualityViolation('A-T12-3', () =>
      assertSuspectRegistratable({ barcodeKind: 'unit', unitStatus: 'in_stock', hasLocation: false, hasActiveSuspect: false }),
    )
    expectQualityViolation('A-T12-3', () =>
      assertSuspectRegistratable({ barcodeKind: 'unit', unitStatus: 'in_stock', hasLocation: true, hasActiveSuspect: true }),
    )
    expect(() =>
      assertSuspectRegistratable({ barcodeKind: 'unit', unitStatus: 'in_stock', hasLocation: true, hasActiveSuspect: false }),
    ).not.toThrow()
  })

  it('恢复：无活动存疑拒、缺处置依据拒（最小处置记录）', () => {
    expectQualityViolation('A-T12-3', () =>
      assertSuspectRestorable({ holdStatus: 'released', releasedBy: 'qc01', dispositionNote: '复检合格' }),
    )
    expectQualityViolation('A-T12-3', () =>
      assertSuspectRestorable({ holdStatus: 'active', releasedBy: 'qc01', dispositionNote: '' }),
    )
    expectQualityViolation('A-T12-3', () =>
      assertSuspectRestorable({ holdStatus: 'active', releasedBy: '', dispositionNote: '复检合格' }),
    )
    expect(() => assertSuspectRestorable({ holdStatus: 'active', releasedBy: 'qc01', dispositionNote: '复检合格，恢复可用' })).not.toThrow()
  })
})

describe('T13 上架规则 [A-T13-2]', () => {
  it('上架目标=成品类实体物流仓：普通仓/线边仓拒绝，物流仓/成品仓放行；非成品料拒绝', () => {
    expectWarehousingViolation('A-T13-2', () =>
      assertPutawayTargetWarehouse({ warehouseKind: 'WAREHOUSE', materialType: 3 }),
    )
    expectWarehousingViolation('A-T13-2', () =>
      assertPutawayTargetWarehouse({ warehouseKind: 'LINE_SIDE', materialType: 3 }),
    )
    expectWarehousingViolation('A-T13-2', () =>
      assertPutawayTargetWarehouse({ warehouseKind: 'LOGISTICS', materialType: 1 }),
    )
    expect(() => assertPutawayTargetWarehouse({ warehouseKind: 'LOGISTICS', materialType: 3 })).not.toThrow()
    expect(() => assertPutawayTargetWarehouse({ warehouseKind: 'FINISHED', materialType: null })).not.toThrow()
  })

  it('上架库位=货架码+层拼位（6 位数字）', () => {
    expectWarehousingViolation('A-T13-2', () => assertRackPutawayLocation('0101'))
    expectWarehousingViolation('A-T13-2', () => assertRackPutawayLocation('01010A'))
    expect(() => assertRackPutawayLocation('020303')).not.toThrow()
  })

  it('托码确认=整托：载荷任务须与同托未入库任务全集一致', () => {
    expectWarehousingViolation('A-T13-2', () =>
      assertWholePalletPutaway({ palletCode: 'P01', payloadTaskIds: ['t1'], palletPendingTaskIds: ['t1', 't2'] }),
    )
    expectWarehousingViolation('A-T13-2', () =>
      assertWholePalletPutaway({ palletCode: 'P01', payloadTaskIds: ['t1', 't2'], palletPendingTaskIds: ['t1'] }),
    )
    expect(() =>
      assertWholePalletPutaway({ palletCode: 'P01', payloadTaskIds: ['t1', 't2'], palletPendingTaskIds: ['t1', 't2'] }),
    ).not.toThrow()
  })
})

describe('T13 移库校验 [A-T13-4：四拒一成]', () => {
  const base = {
    unitNo: 'U1',
    unitStatus: 'in_stock',
    warehouseLocked: false,
    toWarehouseKind: 'WAREHOUSE',
    sameWarehouse: true,
    lockedByOtherTask: false,
    sameLocation: false,
    isPalletChildWithoutWhole: false,
  }
  it('四拒：异仓 / 仓库锁定 / 码被锁 / 不在库 / 同库位 / 托下单码', () => {
    expectWarehousingViolation('A-T13-4', () => assertMoveExecutable({ ...base, sameWarehouse: false }))
    expectWarehousingViolation('A-T13-4', () => assertMoveExecutable({ ...base, warehouseLocked: true }))
    expectWarehousingViolation('A-T13-4', () => assertMoveExecutable({ ...base, lockedByOtherTask: true }))
    expectWarehousingViolation('A-T13-4', () => assertMoveExecutable({ ...base, unitStatus: 'in_transit' }))
    expectWarehousingViolation('A-T13-4', () => assertMoveExecutable({ ...base, sameLocation: true }))
    expectWarehousingViolation('A-T13-4', () => assertMoveExecutable({ ...base, isPalletChildWithoutWhole: true }))
  })

  it('一成：同仓+未锁+在库+异库位 → 通过', () => {
    expect(() => assertMoveExecutable(base)).not.toThrow()
  })
})

describe('T13 调拨规则 [A-T13-6/10/11]', () => {
  it('状态机：仅按序步进（草稿→…→完成），跳步/回退拒绝', () => {
    expectWarehousingViolation('A-T13-10', () => assertTransferStep('draft', 'completed'))
    expectWarehousingViolation('A-T13-10', () => assertTransferStep('ready', 'receiving'))
    expectWarehousingViolation('A-T13-10', () => assertTransferStep('completed', 'draft'))
    expect(() => assertTransferStep('draft', 'ready')).not.toThrow()
    expect(() => assertTransferStep('shipping', 'shipped_in_transit')).not.toThrow()
    expect(() => assertTransferStep('shipped_in_transit', 'receiving')).not.toThrow()
    expect(() => assertTransferStep('receiving', 'completed')).not.toThrow()
  })

  it('仓库规则：调入≠调出；线边出→线边入；生产调拨限线边仓+原料/半成品', () => {
    const base = {
      transferKind: 'warehouse',
      fromWarehouseId: 'W1',
      toWarehouseId: 'W2',
      fromWarehouseKind: 'WAREHOUSE',
      toWarehouseKind: 'WAREHOUSE',
      lineMaterialTypes: [1] as (number | null)[],
    }
    expectWarehousingViolation('A-T13-6', () => assertTransferWarehouses({ ...base, toWarehouseId: 'W1' }))
    expectWarehousingViolation('A-T13-6', () =>
      assertTransferWarehouses({ ...base, fromWarehouseKind: 'LINE_SIDE', toWarehouseKind: 'WAREHOUSE' }),
    )
    expectWarehousingViolation('A-T13-6', () =>
      assertTransferWarehouses({ ...base, transferKind: 'production', toWarehouseKind: 'WAREHOUSE' }),
    )
    expectWarehousingViolation('A-T13-6', () =>
      assertTransferWarehouses({ ...base, transferKind: 'production', toWarehouseKind: 'LINE_SIDE', lineMaterialTypes: [3] }),
    )
    expect(() =>
      assertTransferWarehouses({ ...base, transferKind: 'production', toWarehouseKind: 'LINE_SIDE', lineMaterialTypes: [1, 2] }),
    ).not.toThrow()
  })

  it('锁定=作业预留：签发须晚于当前；过期/已释放后旧提交被拒（重新校验）', () => {
    const now = '2026-10-27T10:00:00.000Z'
    expectWarehousingViolation('A-T13-11', () => assertTransferLockIssuable({ validUntil: null, now }))
    expectWarehousingViolation('A-T13-11', () => assertTransferLockIssuable({ validUntil: '2026-10-27T09:00:00.000Z', now }))
    expect(() => assertTransferLockIssuable({ validUntil: '2026-10-27T11:00:00.000Z', now })).not.toThrow()
    expectWarehousingViolation('A-T13-11', () =>
      assertTransferLockEffective({ reservationId: 'R1', status: 'active', validUntil: '2026-10-27T09:59:00.000Z', now }),
    )
    expectWarehousingViolation('A-T13-11', () =>
      assertTransferLockEffective({ reservationId: 'R1', status: 'released', validUntil: '2026-10-27T11:00:00.000Z', now }),
    )
    expect(() =>
      assertTransferLockEffective({ reservationId: 'R1', status: 'active', validUntil: '2026-10-27T11:00:00.000Z', now }),
    ).not.toThrow()
  })

  it('在途对账：在途量只挂专用库位，两仓不重复统计', () => {
    const ok = {
      transitQty: '100.0000',
      expectedTransitQty: '100.0000',
      fromWarehouseNormalQty: '0.0000',
      expectedFromRemainQty: '0.0000',
      toWarehouseNormalQty: '0.0000',
    }
    expect(() => assertTransitNotDoubleCounted(ok)).not.toThrow()
    expectWarehousingViolation('A-T13-10', () => assertTransitNotDoubleCounted({ ...ok, transitQty: '80.0000' }))
    expectWarehousingViolation('A-T13-10', () =>
      assertTransitNotDoubleCounted({ ...ok, fromWarehouseNormalQty: '20.0000' }),
    )
    expectWarehousingViolation('A-T13-10', () => assertTransitNotDoubleCounted({ ...ok, toWarehouseNormalQty: '100.0000' }))
  })
})
