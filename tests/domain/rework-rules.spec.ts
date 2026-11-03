import { describe, expect, it } from 'vitest'
// domain rework 面未并入包名入口（共享文件 domain/src/index.ts 不改动）：
// 测试直接以相对路径消费 TS 源码（vitest 转译；typecheck:tests 以相对导入纳入编译）。
import {
  AXIS_REASSIGN_PERMISSION,
  PALLET_RESERVATION_DEFAULT_HOURS,
  ReworkRuleViolation,
  assertAxisRetireCandidateExecutable,
  assertAxisRetireSelectionNonEmpty,
  assertCorrectionReassignAllowed,
  assertCorrectionScannable,
  assertCorrectionSubmitAcceptable,
  assertCorrectionUomFollowsMaterial,
  assertCorrectionWithdrawable,
  assertCorrectionWithdrawNotBlocked,
  assertOccupiedUnitClearable,
  assertOldPalletLocationImmutable,
  assertPalletConfirmable,
  assertPalletLineRemovable,
  assertPalletReservationUsable,
  assertPalletScanScope,
  assertPalletSplitScanAcceptable,
  assertPalletUnbindScanAcceptable,
  assertReelSplitConservation,
  assertReelSplitCustomerSegmentFullPour,
  assertReelSplitPourLines,
  assertReelSplitReversible,
  assertReelSplitSourceScannable,
  assertUnitNotRetired,
  buildCorrectionOptions,
  isCarrierCodeFormat,
  isPalletAbandonOnLeave,
  judgePalletNewOrOld,
  mergePalletExportRows,
  normalizeReelSplitLoss,
  planPalletConfirmChanges,
  validateReelSplitSubmission,
  type AxisNoStateFacts,
  type CorrectionOption,
  type CorrectionScanFacts,
  type CorrectionSubmitFacts,
  type PalletOperatorFacts,
  type PalletScanFacts,
  type ReelSplitSourceFacts,
} from '../../packages/domain/src/rework/index'

/**
 * T15 rework 域纯规则矩阵（冻结合同 rework-split.md RS-01～RS-37 断言层；
 * 表级 RS-S1～S6 与命令编排层证据见 tests/integration/rework-flow.spec.ts 与
 * tests/api/rework-api.spec.ts）。
 */

function expectViolation(fn: () => void, rule: string): void {
  expect(fn).toThrow(ReworkRuleViolation)
  try {
    fn()
  } catch (error) {
    expect((error as ReworkRuleViolation).rule).toBe(rule)
  }
}

function sourceFacts(overrides: Partial<ReelSplitSourceFacts> = {}): ReelSplitSourceFacts {
  return {
    unitNo: 'AE0001',
    exists: true,
    isPalletCode: false,
    locked: false,
    qualityPending: false,
    reportUnreviewed: false,
    anomalyOpen: false,
    inLogisticsWarehouse: false,
    multiMaterial: false,
    balanceQty: '1000.0000',
    materialId: 'mat-1',
    materialCode: 'MAT-A',
    customerAxisNo: null,
    segmentLength: null,
    ...overrides,
  }
}

describe('RS-01～12 倒轴（分盘）', () => {
  it('RS-01 守恒式：1,000 = 600 + 390 + 10 损耗三去向合计一致（A05 样例）', () => {
    const retained = assertReelSplitConservation({
      originalQty: '1000.0000',
      pourQtyList: ['600.0000', '390.0000'],
      lossQty: '10.0000',
    })
    expect(retained).toBe('0.0000')
  })

  it('RS-01 倒入合计＋损耗超过原量即拒绝（留存量不得为负）', () => {
    expectViolation(
      () => assertReelSplitConservation({ originalQty: '100.0000', pourQtyList: ['60.0000'], lossQty: '41.0000' }),
      'RS-02',
    )
  })

  it('RS-02 倒入数量仅数字与一位小数点、小数最多 4 位', () => {
    expectViolation(
      () => assertReelSplitPourLines([{ unitNo: 'AE0002', quantity: '12.34567' }], 'AE0001'),
      'RS-02',
    )
    expectViolation(
      () => assertReelSplitPourLines([{ unitNo: 'AE0002', quantity: '0.0000' }], 'AE0001'),
      'RS-02',
    )
    expect(assertReelSplitPourLines([{ unitNo: 'AE0002', quantity: '12.3400' }], 'AE0001')).toEqual(['12.3400'])
  })

  it('RS-02 倒入码互不重复且不得等于倒出码', () => {
    expectViolation(
      () => assertReelSplitPourLines([{ unitNo: 'AE0002', quantity: '1.0000' }, { unitNo: 'AE0002', quantity: '2.0000' }], 'AE0001'),
      'RS-02',
    )
    expectViolation(
      () => assertReelSplitPourLines([{ unitNo: 'AE0001', quantity: '1.0000' }], 'AE0001'),
      'RS-02',
    )
  })

  it('RS-02 未扫倒出轴或零倒入行不可执行', () => {
    expectViolation(
      () =>
        validateReelSplitSubmission({
          sourceScanned: false,
          source: sourceFacts(),
          pourLines: [{ unitNo: 'AE0002', quantity: '1.0000' }],
          lossQty: '0',
          lossReason: null,
        }),
      'RS-02',
    )
    expectViolation(
      () =>
        validateReelSplitSubmission({
          sourceScanned: true,
          source: sourceFacts(),
          pourLines: [],
          lossQty: '0',
          lossReason: null,
        }),
      'RS-02',
    )
  })

  it('RS-03 扫码前置拒绝链逐项命中（托码/不存在/锁定/质检/报工/异常/物流部仓/一码多物/非载具码）', () => {
    expectViolation(() => assertReelSplitSourceScannable(sourceFacts({ isPalletCode: true })), 'RS-03')
    expectViolation(() => assertReelSplitSourceScannable(sourceFacts({ exists: false })), 'RS-03')
    expectViolation(() => assertReelSplitSourceScannable(sourceFacts({ locked: true })), 'RS-03')
    expectViolation(() => assertReelSplitSourceScannable(sourceFacts({ qualityPending: true })), 'RS-03')
    expectViolation(() => assertReelSplitSourceScannable(sourceFacts({ reportUnreviewed: true })), 'RS-03')
    expectViolation(() => assertReelSplitSourceScannable(sourceFacts({ anomalyOpen: true })), 'RS-03')
    expectViolation(() => assertReelSplitSourceScannable(sourceFacts({ inLogisticsWarehouse: true })), 'RS-03')
    expectViolation(() => assertReelSplitSourceScannable(sourceFacts({ multiMaterial: true })), 'RS-03')
    expectViolation(() => assertReelSplitSourceScannable(sourceFacts({ unitNo: 'AX0009' })), 'RS-03')
  })

  it('RS-03 码格式：第 2 位 E/F/M/P 为载具码', () => {
    expect(isCarrierCodeFormat('AE0001')).toBe(true)
    expect(isCarrierCodeFormat('AF0099')).toBe(true)
    expect(isCarrierCodeFormat('AM0100')).toBe(true)
    expect(isCarrierCodeFormat('AP0101')).toBe(true)
    expect(isCarrierCodeFormat('AX0001')).toBe(false)
    expect(isCarrierCodeFormat('A')).toBe(false)
  })

  it('RS-04 同料品一码多条库存记录按同码合计作倒出量基数（facts 折叠口径：balanceQty）', () => {
    const facts = sourceFacts({ balanceQty: '100.0000', multiMaterial: false })
    expect(assertReelSplitSourceScannable(facts)).toBeUndefined()
    expect(facts.balanceQty).toBe('100.0000')
  })

  it('RS-05 带客户轴号/段长：必须全量倒出且倒入轴只能一条（两条独立拒绝）', () => {
    const facts = sourceFacts({ customerAxisNo: 'KZH-01', segmentLength: '600' })
    expectViolation(
      () =>
        assertReelSplitCustomerSegmentFullPour({
          source: facts,
          pourQtyList: ['600.0000', '390.0000'],
          lossQty: '10.0000',
          retainedQty: '0.0000',
        }),
      'RS-05',
    )
    expectViolation(
      () =>
        assertReelSplitCustomerSegmentFullPour({
          source: facts,
          pourQtyList: ['600.0000'],
          lossQty: '0.0000',
          retainedQty: '400.0000',
        }),
      'RS-05',
    )
    expect(
      assertReelSplitCustomerSegmentFullPour({
        source: facts,
        pourQtyList: ['990.0000'],
        lossQty: '10.0000',
        retainedQty: '0.0000',
      }),
    ).toBeUndefined()
  })

  it('RS-11 损耗登记：默认 0、4 位小数、≥0；>0 时原因必填', () => {
    expect(normalizeReelSplitLoss(undefined, null)).toBe('0.0000')
    expect(normalizeReelSplitLoss('10.0000', '端头损耗')).toBe('10.0000')
    expectViolation(() => normalizeReelSplitLoss('-1.0000', 'x'), 'RS-11')
    expectViolation(() => normalizeReelSplitLoss('1.23456', 'x'), 'RS-11')
    expectViolation(() => normalizeReelSplitLoss('5.0000', ''), 'RS-11')
  })

  it('RS-01/02/05/11 提交时统一校验（RS-06 会话模型）成功路径', () => {
    const result = validateReelSplitSubmission({
      sourceScanned: true,
      source: sourceFacts(),
      pourLines: [
        { unitNo: 'AE0002', quantity: '600.0000' },
        { unitNo: 'AE0003', quantity: '390.0000' },
      ],
      lossQty: '10.0000',
      lossReason: '端头损耗',
    })
    expect(result.pourTotal).toBe('990.0000')
    expect(result.retainedQty).toBe('0.0000')
    expect(result.lossQty).toBe('10.0000')
  })

  it('RS-12 冲销前置下游引用：任一子段已入库/消耗/转换/发运/质量生效即拒绝（A11）', () => {
    expectViolation(() => assertReelSplitReversible({ anyChildStocked: true, anyChildConsumed: false, anyChildConverted: false, anyChildShipped: false, anyChildQualityEffective: false }), 'RS-12')
    expectViolation(() => assertReelSplitReversible({ anyChildStocked: false, anyChildConsumed: true, anyChildConverted: false, anyChildShipped: false, anyChildQualityEffective: false }), 'RS-12')
    expectViolation(() => assertReelSplitReversible({ anyChildStocked: false, anyChildConsumed: false, anyChildConverted: true, anyChildShipped: false, anyChildQualityEffective: false }), 'RS-12')
    expectViolation(() => assertReelSplitReversible({ anyChildStocked: false, anyChildConsumed: false, anyChildConverted: false, anyChildShipped: true, anyChildQualityEffective: false }), 'RS-12')
    expectViolation(() => assertReelSplitReversible({ anyChildStocked: false, anyChildConsumed: false, anyChildConverted: false, anyChildShipped: false, anyChildQualityEffective: true }), 'RS-12')
    expect(
      assertReelSplitReversible({ anyChildStocked: false, anyChildConsumed: false, anyChildConverted: false, anyChildShipped: false, anyChildQualityEffective: false }),
    ).toBeUndefined()
  })
})

// ---------------- 分托/解绑 ----------------

const workshopOp: PalletOperatorFacts = { loginName: 'ws01', deptCategory: 1 }
const logisticsOp: PalletOperatorFacts = { loginName: 'wl01', deptCategory: 3 }

function scanFacts(overrides: Partial<PalletScanFacts> = {}): PalletScanFacts {
  return {
    unitNo: 'AE0001',
    exists: true,
    isPalletCode: false,
    multiMaterial: false,
    inStock: true,
    inWarehouse: false,
    boundCarrierId: 'carr-1',
    boundCarrierCode: 'PLT-01',
    warehouseId: 'wh-1',
    lockedByOther: false,
    scannedInTask: false,
    sameWarehouseAsScanned: true,
    sameWarehouseAsTargetCarrier: true,
    warehouseLocked: false,
    ...overrides,
  }
}

describe('RS-13～24 分托（托盘调整）与解绑', () => {
  it('RS-13 ①可扫范围：非车间必须在库；车间不得在仓库（服务端执行）', () => {
    expectViolation(() => assertPalletScanScope(logisticsOp, scanFacts({ inStock: false })), 'RS-13')
    expectViolation(() => assertPalletScanScope(workshopOp, scanFacts({ inWarehouse: true })), 'RS-13')
    expect(assertPalletScanScope(logisticsOp, scanFacts())).toBeUndefined()
    expect(assertPalletScanScope(workshopOp, scanFacts({ inStock: true, inWarehouse: false }))).toBeUndefined()
  })

  it('RS-16 分托扫料品码拒绝清单逐项命中', () => {
    expectViolation(() => assertPalletSplitScanAcceptable(logisticsOp, scanFacts({ exists: false })), 'RS-16')
    expectViolation(() => assertPalletSplitScanAcceptable(logisticsOp, scanFacts({ isPalletCode: true })), 'RS-16')
    expectViolation(() => assertPalletSplitScanAcceptable(logisticsOp, scanFacts({ multiMaterial: true })), 'RS-16')
    expectViolation(() => assertPalletSplitScanAcceptable(logisticsOp, scanFacts({ scannedInTask: true })), 'RS-16')
    expectViolation(() => assertPalletSplitScanAcceptable(logisticsOp, scanFacts({ sameWarehouseAsScanned: false })), 'RS-16')
    expectViolation(() => assertPalletSplitScanAcceptable(logisticsOp, scanFacts({ sameWarehouseAsTargetCarrier: false })), 'RS-16')
    expectViolation(() => assertPalletSplitScanAcceptable(logisticsOp, scanFacts({ lockedByOther: true })), 'RS-16')
    expectViolation(() => assertPalletSplitScanAcceptable(logisticsOp, scanFacts({ warehouseLocked: true })), 'RS-16')
  })

  it('RS-22 解绑前置拒绝清单：未绑定托盘拒绝；不需要托码与库位（无目标仓库校验）', () => {
    expectViolation(() => assertPalletUnbindScanAcceptable(logisticsOp, scanFacts({ boundCarrierId: null })), 'RS-22')
    expectViolation(() => assertPalletUnbindScanAcceptable(logisticsOp, scanFacts({ isPalletCode: true })), 'RS-22')
    expectViolation(() => assertPalletUnbindScanAcceptable(logisticsOp, scanFacts({ scannedInTask: true })), 'RS-22')
    // 解绑不校验与分入托码同仓库（无分入托码）：sameWarehouseAsTargetCarrier=false 不应拒绝
    expect(
      assertPalletUnbindScanAcceptable(logisticsOp, scanFacts({ sameWarehouseAsTargetCarrier: false })),
    ).toBeUndefined()
  })

  it('RS-15 新托/老托判定与老托库位不可改', () => {
    expect(judgePalletNewOrOld(false)).toBe('new')
    expect(judgePalletNewOrOld(true)).toBe('old')
    expectViolation(() => assertOldPalletLocationImmutable('old', 'loc-2', 'loc-1'), 'RS-15')
    expect(assertOldPalletLocationImmutable('old', 'loc-1', 'loc-1')).toBeUndefined()
    expect(assertOldPalletLocationImmutable('new', 'loc-2', null)).toBeUndefined()
  })

  it('RS-13②/RS-19 确认可执行条件按序校验（车间免选库位；非车间须库位+仓库未锁定；分托须已扫分入托码）', () => {
    const task = {
      taskType: 'split_pallet' as const,
      status: 'in_progress' as const,
      operator: 'ws01',
      targetCarrierId: 'carr-9',
      targetCarrierCode: 'PLT-09',
      warehouseId: null,
      rackId: null,
      locationId: null,
      locationCode: null,
    }
    expect(assertPalletConfirmable({ operator: workshopOp, task, scannedCount: 2, warehouseLocked: false })).toBeUndefined()
    expectViolation(
      () => assertPalletConfirmable({ operator: logisticsOp, task, scannedCount: 2, warehouseLocked: false }),
      'RS-19',
    )
    expectViolation(
      () =>
        assertPalletConfirmable({
          operator: logisticsOp,
          task: { ...task, locationId: 'loc-1', warehouseId: 'wh-1' },
          scannedCount: 2,
          warehouseLocked: true,
        }),
      'RS-19',
    )
    expectViolation(
      () => assertPalletConfirmable({ operator: workshopOp, task: { ...task, targetCarrierId: null }, scannedCount: 2, warehouseLocked: false }),
      'RS-19',
    )
    expectViolation(
      () => assertPalletConfirmable({ operator: workshopOp, task, scannedCount: 0, warehouseLocked: false }),
      'RS-19',
    )
  })

  it('RS-19/RS-22 解绑免库位前置（O-1）：非车间无库位/仓库亦可确认，车间/非车间校验相同', () => {
    const unbindTask = {
      taskType: 'unbind_pallet' as const,
      status: 'in_progress' as const,
      operator: 'wl01',
      targetCarrierId: null,
      targetCarrierCode: null,
      warehouseId: null,
      rackId: null,
      locationId: null,
      locationCode: null,
    }
    // 非车间解绑：无库位、无仓库、目标仓库锁定口径不适用 → 可确认（RS-22 不需要托码与库位）
    expect(assertPalletConfirmable({ operator: logisticsOp, task: unbindTask, scannedCount: 2, warehouseLocked: false })).toBeUndefined()
    expect(assertPalletConfirmable({ operator: logisticsOp, task: unbindTask, scannedCount: 2, warehouseLocked: true })).toBeUndefined()
    // 车间解绑同口径；仍须已扫码开始且至少一个料品码（RS-19 前两项对两类任务通用）
    expect(assertPalletConfirmable({ operator: workshopOp, task: unbindTask, scannedCount: 1, warehouseLocked: false })).toBeUndefined()
    expectViolation(
      () => assertPalletConfirmable({ operator: logisticsOp, task: unbindTask, scannedCount: 0, warehouseLocked: false }),
      'RS-19',
    )
  })

  it('RS-17 已确认完成的单不允许再删码', () => {
    expectViolation(() => assertPalletLineRemovable('completed'), 'RS-17')
    expect(assertPalletLineRemovable('in_progress')).toBeUndefined()
  })

  it('RS-18 长作业预留：过期后提交重新校验拒绝并提示重扫（A11）；默认 8 小时（CA-5 建议待裁）', () => {
    expect(PALLET_RESERVATION_DEFAULT_HOURS).toBe(8)
    const now = '2026-10-28T12:00:00.000Z'
    expectViolation(() => assertPalletReservationUsable('2026-10-28T11:59:59.999Z', now), 'RS-18')
    expect(assertPalletReservationUsable('2026-10-28T20:00:00.000Z', now)).toBeUndefined()
  })

  it('RS-13③ 确认后改动：非车间改托码＋仓库＋货架＋库位；车间只改托码', () => {
    const task = {
      taskType: 'split_pallet' as const,
      status: 'in_progress' as const,
      operator: 'wl01',
      targetCarrierId: 'carr-9',
      targetCarrierCode: 'PLT-09',
      warehouseId: 'wh-1',
      rackId: 'rk-1',
      locationId: 'loc-2',
      locationCode: '010101',
    }
    expect(planPalletConfirmChanges({ operator: logisticsOp, task })).toEqual({
      moveLocation: true,
      targetLocationId: 'loc-2',
      targetWarehouseId: 'wh-1',
    })
    expect(planPalletConfirmChanges({ operator: workshopOp, task })).toEqual({
      moveLocation: false,
      targetLocationId: null,
      targetWarehouseId: null,
    })
  })

  it('RS-21/RS-23 放弃语义：分托已扫托码但零料品码=放弃；解绑返回不放弃', () => {
    expect(isPalletAbandonOnLeave('split_pallet', true, 0)).toBe(true)
    expect(isPalletAbandonOnLeave('split_pallet', true, 2)).toBe(false)
    expect(isPalletAbandonOnLeave('split_pallet', false, 0)).toBe(false)
    expect(isPalletAbandonOnLeave('unbind_pallet', true, 0)).toBe(false)
    expect(isPalletAbandonOnLeave('unbind_pallet', false, 0)).toBe(false)
  })

  it('RS-24 导出合并：同托码同产品轴号同料品合并一行、数量相加', () => {
    const merged = mergePalletExportRows([
      { carrierCode: 'PLT-01', productAxisNo: 'KZH-01', materialCode: 'MAT-A', quantity: '100.0000' },
      { carrierCode: 'PLT-01', productAxisNo: 'KZH-01', materialCode: 'MAT-A', quantity: '50.0000' },
      { carrierCode: 'PLT-01', productAxisNo: 'KZH-02', materialCode: 'MAT-A', quantity: '30.0000' },
      { carrierCode: 'PLT-02', productAxisNo: null, materialCode: 'MAT-B', quantity: '10.0000' },
    ])
    expect(merged).toHaveLength(3)
    const first = merged.find((r) => r.productAxisNo === 'KZH-01')!
    expect(first.quantity).toBe('150.0000')
  })
})

// ---------------- 轴号修正 ----------------

function correctionFacts(overrides: Partial<CorrectionScanFacts> = {}): CorrectionScanFacts {
  return {
    qrPassed: true,
    unitNo: 'AE0001',
    exists: true,
    isPalletCode: false,
    multiMaterial: false,
    inLogisticsWarehouse: false,
    sold: false,
    qualityPending: false,
    reportUnreviewed: false,
    anomalyOpen: false,
    locked: false,
    hasOrder: true,
    transitAxisPending: false,
    ...overrides,
  }
}

describe('RS-25～33 轴号修正（段/号修正）', () => {
  it('RS-25 扫码前置拒绝链逐项命中（未传二维码/托码/不存在/一码多物/物流部/已销售/质检/报工/异常/锁定/无订单/中转轴未审核）', () => {
    expectViolation(() => assertCorrectionScannable(correctionFacts({ qrPassed: false })), 'RS-25')
    expectViolation(() => assertCorrectionScannable(correctionFacts({ isPalletCode: true })), 'RS-25')
    expectViolation(() => assertCorrectionScannable(correctionFacts({ exists: false })), 'RS-25')
    expectViolation(() => assertCorrectionScannable(correctionFacts({ multiMaterial: true })), 'RS-25')
    expectViolation(() => assertCorrectionScannable(correctionFacts({ inLogisticsWarehouse: true })), 'RS-25')
    expectViolation(() => assertCorrectionScannable(correctionFacts({ sold: true })), 'RS-25')
    expectViolation(() => assertCorrectionScannable(correctionFacts({ qualityPending: true })), 'RS-25')
    expectViolation(() => assertCorrectionScannable(correctionFacts({ reportUnreviewed: true })), 'RS-25')
    expectViolation(() => assertCorrectionScannable(correctionFacts({ anomalyOpen: true })), 'RS-25')
    expectViolation(() => assertCorrectionScannable(correctionFacts({ locked: true })), 'RS-25')
    expectViolation(() => assertCorrectionScannable(correctionFacts({ hasOrder: false })), 'RS-25')
    expectViolation(() => assertCorrectionScannable(correctionFacts({ transitAxisPending: true })), 'RS-25')
  })

  const orderStates: AxisNoStateFacts[] = [
    { unitId: 'u1', unitNo: 'AE0001', salesOrderNo: 'SO-1', orderLineNo: '10', customerAxisNo: 'KZH-01', segmentLength: '600', virtualAxisNo: '1' },
    { unitId: 'u2', unitNo: 'AE0002', salesOrderNo: 'SO-1', orderLineNo: '10', customerAxisNo: 'KZH-02', segmentLength: '600', virtualAxisNo: '2' },
    { unitId: 'u3', unitNo: 'AE0003', salesOrderNo: 'SO-1', orderLineNo: '10', customerAxisNo: 'KZH-03', segmentLength: '390', virtualAxisNo: '3' },
  ]

  it('RS-26 可选列表：订单范围；原码有段长只留同段长；已使用=同订单占用相同段长+虚拟轴号', () => {
    const options = buildCorrectionOptions(orderStates, 'u1')
    // 原码段长 600 → 只保留 600 段长项；KZH-01 为自身（未使用），KZH-02 为同段长其它码（已使用）
    expect(options).toHaveLength(2)
    const self = options.find((o) => o.customerAxisNo === 'KZH-01')!
    expect(self.used).toBe(false)
    const other = options.find((o) => o.customerAxisNo === 'KZH-02')!
    expect(other.used).toBe(true)
    expect(other.occupiedByUnitNo).toBe('AE0002')
    expect(options.some((o) => o.customerAxisNo === 'KZH-03')).toBe(false)
  })

  it('RS-26 无客户轴号仅有段长的原码列表为空', () => {
    const options = buildCorrectionOptions(
      [...orderStates, { unitId: 'u9', unitNo: 'AE0009', salesOrderNo: 'SO-1', orderLineNo: '10', customerAxisNo: null, segmentLength: '600', virtualAxisNo: null }],
      'u9',
    )
    expect(options).toEqual([])
  })

  function submitFacts(overrides: Partial<CorrectionSubmitFacts> = {}): CorrectionSubmitFacts {
    const options: CorrectionOption[] = buildCorrectionOptions(orderStates, 'u1')
    return {
      currentQty: '1000.0000',
      maxSingleReportQty: '600.0000',
      options,
      currentCustomerAxisNo: 'KZH-01',
      currentSegmentLength: '600',
      occupiedUnitInWarehouse: false,
      occupiedUnitSold: false,
      occupiedUnitLocked: false,
      ...overrides,
    }
  }

  it('RS-27 提交校验链逐项命中（截断数量/无可选列表传轴号/有轴号未传修正值/不在可选列表/超最大单次报工数量/超当前数量）', () => {
    expectViolation(() => assertCorrectionSubmitAcceptable({ cutQty: undefined, newCustomerAxisNo: null, newSegmentLength: null, newVirtualAxisNo: null }, submitFacts()), 'RS-27')
    expectViolation(() => assertCorrectionSubmitAcceptable({ cutQty: '-1.0000', newCustomerAxisNo: null, newSegmentLength: null, newVirtualAxisNo: null }, submitFacts()), 'RS-27')
    expectViolation(
      () =>
        assertCorrectionSubmitAcceptable(
          { cutQty: '10.0000', newCustomerAxisNo: 'KZH-09', newSegmentLength: '600', newVirtualAxisNo: '9' },
          submitFacts(),
        ),
      'RS-27',
    )
    expectViolation(
      () => assertCorrectionSubmitAcceptable({ cutQty: '10.0000', newCustomerAxisNo: null, newSegmentLength: '600', newVirtualAxisNo: null }, submitFacts()),
      'RS-27',
    )
    expectViolation(
      () => assertCorrectionSubmitAcceptable({ cutQty: '10.0000', newCustomerAxisNo: 'KZH-01', newSegmentLength: null, newVirtualAxisNo: null }, submitFacts()),
      'RS-27',
    )
    expectViolation(
      () => assertCorrectionSubmitAcceptable({ cutQty: '700.0000', newCustomerAxisNo: 'KZH-02', newSegmentLength: '600', newVirtualAxisNo: '2' }, submitFacts()),
      'RS-27',
    )
    expect(
      assertCorrectionSubmitAcceptable({ cutQty: '100.0000', newCustomerAxisNo: 'KZH-02', newSegmentLength: '600', newVirtualAxisNo: '2' }, submitFacts()),
    ).toBe('100.0000')
  })

  it('RS-27 无可选列表且零截取=无变化拒绝', () => {
    expectViolation(
      () =>
        assertCorrectionSubmitAcceptable(
          { cutQty: '0.0000', newCustomerAxisNo: null, newSegmentLength: null, newVirtualAxisNo: null },
          submitFacts({ options: [], currentCustomerAxisNo: null, currentSegmentLength: null }),
        ),
      'RS-27',
    )
  })

  it('RS-30 占用核权：选中已使用轴号需权限+强制理由（GAP-F4 最小机制 rework.axis-correction.reassign）', () => {
    expect(AXIS_REASSIGN_PERMISSION).toBe('rework.axis-correction.reassign')
    const options = buildCorrectionOptions(orderStates, 'u1')
    const target = { newCustomerAxisNo: 'KZH-02', newSegmentLength: '600', newVirtualAxisNo: '2' }
    expectViolation(() => assertCorrectionReassignAllowed({ options, ...target, hasPermission: false, reason: '生产调整' }), 'RS-30')
    expectViolation(() => assertCorrectionReassignAllowed({ options, ...target, hasPermission: true, reason: '' }), 'RS-30')
    expect(assertCorrectionReassignAllowed({ options, ...target, hasPermission: true, reason: '客户轴段重新分配（生产调整）' })).toBeUndefined()
  })

  it('RS-27 解绑占用码：已入非线边仓/已销售/已锁定时拒绝', () => {
    expectViolation(() => assertOccupiedUnitClearable(submitFacts({ occupiedUnitInWarehouse: true })), 'RS-27')
    expectViolation(() => assertOccupiedUnitClearable(submitFacts({ occupiedUnitSold: true })), 'RS-27')
    expectViolation(() => assertOccupiedUnitClearable(submitFacts({ occupiedUnitLocked: true })), 'RS-27')
  })

  it('RS-31 截取数量单位随物料主计量单位，不固定米', () => {
    expect(assertCorrectionUomFollowsMaterial('M', 'M')).toBeUndefined()
    expectViolation(() => assertCorrectionUomFollowsMaterial('M', 'KG'), 'RS-31')
  })

  it('RS-32 回撤可执行：已完成+有权限；已撤销不可重复回撤', () => {
    expect(assertCorrectionWithdrawable('completed', true)).toBeUndefined()
    expectViolation(() => assertCorrectionWithdrawable('withdrawn', true), 'RS-32')
    expectViolation(() => assertCorrectionWithdrawable('completed', false), 'RS-32')
  })

  it('RS-33 回撤下游拦截：截取后已倒轴拆分/发运/转换/质量生效即受阻（[合同新造]）', () => {
    expectViolation(() => assertCorrectionWithdrawNotBlocked({ splitAfterCorrection: true, shipped: false, converted: false, qualityEffective: false }), 'RS-33')
    expectViolation(() => assertCorrectionWithdrawNotBlocked({ splitAfterCorrection: false, shipped: true, converted: false, qualityEffective: false }), 'RS-33')
    expectViolation(() => assertCorrectionWithdrawNotBlocked({ splitAfterCorrection: false, shipped: false, converted: true, qualityEffective: false }), 'RS-33')
    expectViolation(() => assertCorrectionWithdrawNotBlocked({ splitAfterCorrection: false, shipped: false, converted: false, qualityEffective: true }), 'RS-33')
    expect(assertCorrectionWithdrawNotBlocked({ splitAfterCorrection: false, shipped: false, converted: false, qualityEffective: false })).toBeUndefined()
  })
})

// ---------------- 轴码退役 ----------------

describe('RS-34～37 轴码退役（轴码清空）', () => {
  it('RS-34 可执行前置逐项命中（非产品轴码/质检未完成/报工未审核/中转轴未审核/已入成品仓在库）', () => {
    const ok = {
      unitNo: 'AE0001',
      isProductAxisCode: true,
      qualityCompleted: true,
      reportReviewed: true,
      transitAxisPending: false,
      inFinishedGoodsStock: false,
    }
    expect(assertAxisRetireCandidateExecutable(ok)).toBeUndefined()
    expectViolation(() => assertAxisRetireCandidateExecutable({ ...ok, isProductAxisCode: false }), 'RS-34')
    expectViolation(() => assertAxisRetireCandidateExecutable({ ...ok, qualityCompleted: false }), 'RS-34')
    expectViolation(() => assertAxisRetireCandidateExecutable({ ...ok, reportReviewed: false }), 'RS-34')
    expectViolation(() => assertAxisRetireCandidateExecutable({ ...ok, transitAxisPending: true }), 'RS-34')
    expectViolation(() => assertAxisRetireCandidateExecutable({ ...ok, inFinishedGoodsStock: true }), 'RS-34')
  })

  it('RS-34 至少勾选一条', () => {
    expectViolation(() => assertAxisRetireSelectionNonEmpty(0), 'RS-34')
    expect(assertAxisRetireSelectionNonEmpty(1)).toBeUndefined()
  })

  it('RS-36 退役码在库存命令入口显式拒绝（可解释提示"已退役"）', () => {
    expectViolation(() => assertUnitNotRetired(true, 'AE0001'), 'RS-36')
    expect(assertUnitNotRetired(false, 'AE0001')).toBeUndefined()
  })
})
