import { describe, expect, it } from 'vitest'
// domain purchase 面未并入包名入口（共享文件 domain/src/index.ts 不改动）：
// 测试直接以相对路径消费 TS 源码（vitest 转译；typecheck:tests 以相对导入纳入编译）。
import {
  PurchaseRuleViolation,
  assertBarcodeKindMatchesMaterialType,
  assertDetailQuantityPositive,
  assertDetailTripleUnique,
  assertJudgeExecutable,
  assertOrderLineReceivable,
  assertReinspectionStartable,
  assertReturnExecutable,
  assertReturnReasonPresent,
  assertRevocationAllowed,
  assertSameProductionDatePerSupplierLot,
  assertWebInspectionExecutable,
  assertWithinOverReceiptLimit,
  computeDetailQuantityFromPackage,
  computePriceSnapshot,
  computeTotalReceiptQty,
  deviationPpm,
  guessPurchaseBarcodeKind,
  initialDetailQualityStatus,
  mapDetailStatusToBalanceQuality,
  nextInspectionVersion,
  recalcOrderLineStatus,
  resolveEmptyBarcodeDisposition,
  revokedDetailStatus,
  shouldWebInspectionWriteCode,
  summarizeBatchInspection,
} from '../../packages/domain/src/purchase/index'

/** 断言规则违例（携带 [A-x] 编号）。 */
function expectViolation(rule: string, fn: () => void): void {
  try {
    fn()
    expect.unreachable(`应抛出 PurchaseRuleViolation [${rule}]`)
  } catch (error) {
    expect(error).toBeInstanceOf(PurchaseRuleViolation)
    expect((error as PurchaseRuleViolation).rule).toBe(rule)
  }
}

describe('A-1 订单行状态规则（0–5、冻结、重算）', () => {
  it('重算：已收 0→待收货(1)；0<已收<计划→部分(2)；已收=计划→完全(3)；已收>计划→超额(4)', () => {
    expect(recalcOrderLineStatus({ status: 1, plannedQty: '80.0000', receivedQty: '0.0000' })).toBe(1)
    expect(recalcOrderLineStatus({ status: 1, plannedQty: '80.0000', receivedQty: '50.0000' })).toBe(2)
    expect(recalcOrderLineStatus({ status: 2, plannedQty: '80.0000', receivedQty: '80.0000' })).toBe(3)
    expect(recalcOrderLineStatus({ status: 3, plannedQty: '80.0000', receivedQty: '90.0000' })).toBe(4)
  })

  it('冻结：已开立(0)/已完成(5)行不因重算变更；冻结行不可收货', () => {
    expect(recalcOrderLineStatus({ status: 0, plannedQty: '80.0000', receivedQty: '50.0000' })).toBe(0)
    expect(recalcOrderLineStatus({ status: 5, plannedQty: '80.0000', receivedQty: '0.0000' })).toBe(5)
    expectViolation('A-1', () => assertOrderLineReceivable(5))
    expectViolation('A-1', () => assertOrderLineReceivable(0))
    expect(() => assertOrderLineReceivable(2)).not.toThrow()
  })
})

describe('A-2/A-3 收货校验规则', () => {
  it('码型匹配：原料行只收 R 码、成品行只收 E/F 码（PRD 扫码文案口径；料品字典 1原材料/2半成品/3成品）', () => {
    expect(guessPurchaseBarcodeKind('R123456789')).toBe('raw_material')
    expect(guessPurchaseBarcodeKind('E123456789')).toBe('finished_goods')
    expect(guessPurchaseBarcodeKind('F123456789')).toBe('finished_goods')
    // type=1 原材料 → 只收 R 码
    expect(() => assertBarcodeKindMatchesMaterialType({ barcodeValue: 'R123456789', materialType: 1 })).not.toThrow()
    expectViolation('A-2', () =>
      assertBarcodeKindMatchesMaterialType({ barcodeValue: 'E123456789', materialType: 1 }),
    )
    // type=2 半成品 → 按原料口径收 R 码（R2 修复：原实现误当成品行）
    expectViolation('A-2', () =>
      assertBarcodeKindMatchesMaterialType({ barcodeValue: 'E123456789', materialType: 2 }),
    )
    expect(() => assertBarcodeKindMatchesMaterialType({ barcodeValue: 'R123456789', materialType: 2 })).not.toThrow()
    // type=3 成品 → 只收 E/F 码
    expect(() => assertBarcodeKindMatchesMaterialType({ barcodeValue: 'F123456789', materialType: 3 })).not.toThrow()
    expectViolation('A-2', () =>
      assertBarcodeKindMatchesMaterialType({ barcodeValue: 'R123456789', materialType: 3 }),
    )
    expectViolation('A-2', () =>
      assertBarcodeKindMatchesMaterialType({ barcodeValue: 'X123456789', materialType: 1 }),
    )
  })

  it('空码校验：无绑定→可收；采购来源绑定→同码多批合法（S13）；非采购来源→拒绝', () => {
    expect(resolveEmptyBarcodeDisposition({ barcodeValue: 'R000000001', activeBinding: null })).toEqual({
      firstPurchaseReceipt: true,
    })
    expect(
      resolveEmptyBarcodeDisposition({
        barcodeValue: 'R000000002',
        activeBinding: { boundType: 'inventory_unit', boundId: 'u1' },
        boundUnitLotKind: 'purchase',
      }),
    ).toEqual({ firstPurchaseReceipt: false })
    expectViolation('A-2', () =>
      resolveEmptyBarcodeDisposition({
        barcodeValue: 'R000000003',
        activeBinding: { boundType: 'inventory_unit', boundId: 'u2' },
        boundUnitLotKind: 'production',
      }),
    )
    expectViolation('A-2', () =>
      resolveEmptyBarcodeDisposition({
        barcodeValue: 'R000000004',
        activeBinding: { boundType: 'carrier', boundId: 'c1' },
      }),
    )
  })

  it('三元组唯一：同一收货单内「二维码+厂家批号+牌号/线径」不可重复', () => {
    const details = [
      { barcodeValue: 'R100000001', supplierLotNo: 'L1', grade: 'G1', quantity: '10.0000' },
      { barcodeValue: 'R100000001', supplierLotNo: 'L1', grade: 'G2', quantity: '5.0000' },
    ]
    expect(() => assertDetailTripleUnique(details)).not.toThrow()
    expectViolation('A-3', () =>
      assertDetailTripleUnique([
        ...details,
        { barcodeValue: 'R100000001', supplierLotNo: 'L1', grade: 'G2', quantity: '5.0000' },
      ]),
    )
  })

  it('同厂家批号生产日期一致 + 数量>0 + 超上限整单拒绝', () => {
    expectViolation('A-3', () =>
      assertSameProductionDatePerSupplierLot([
        { barcodeValue: 'R100000002', supplierLotNo: 'L9', productionDate: '2026-01-01', quantity: '1.0000' },
        { barcodeValue: 'R100000003', supplierLotNo: 'L9', productionDate: '2026-01-02', quantity: '1.0000' },
      ]),
    )
    expectViolation('A-3', () =>
      assertDetailQuantityPositive([{ barcodeValue: 'R100000004', quantity: '0.0000' }]),
    )
    expectViolation('A-3', () => assertWithinOverReceiptLimit({ receivedQty: '40.0000', incomingQty: '30.0000', overReceiptLimit: '60.0000' }))
    expect(() => assertWithinOverReceiptLimit({ receivedQty: '40.0000', incomingQty: '20.0000', overReceiptLimit: '60.0000' })).not.toThrow()
  })

  it('A-5 包装换算：收货数量=包装单位总量×码数；总量=各行之和', () => {
    expect(computeDetailQuantityFromPackage({ packageUnitQty: '50.0000', codeCount: 3 })).toBe('150.0000')
    expectViolation('A-5', () => computeDetailQuantityFromPackage({ packageUnitQty: '50.0000', codeCount: 0 }))
    expect(
      computeTotalReceiptQty([
        { barcodeValue: 'R100000005', quantity: '30.0000' },
        { barcodeValue: 'R100000006', quantity: '20.0000' },
      ]),
    ).toBe('50.0000')
  })
})

describe('A-4/A-6 免检判定与批次质检状态汇总（6 态）', () => {
  it('免检判定依据 material.qc_flag；库存质量映射（免检直接可用、待复检不可用）', () => {
    expect(initialDetailQualityStatus(0)).toBe('exempt')
    expect(initialDetailQualityStatus(1)).toBe('pending_inspection')
    expect(mapDetailStatusToBalanceQuality('exempt')).toBe('qualified')
    expect(mapDetailStatusToBalanceQuality('qualified')).toBe('qualified')
    expect(mapDetailStatusToBalanceQuality('pending_inspection')).toBe('pending_inspection')
    expect(mapDetailStatusToBalanceQuality('re_inspection')).toBe('pending_inspection')
    expect(mapDetailStatusToBalanceQuality('unqualified')).toBe('unqualified')
  })

  it('批次质检状态汇总：免检/待检/全合/全不合/部分合/质检中', () => {
    expect(summarizeBatchInspection(['exempt', 'exempt'])).toBe('exempt')
    expect(summarizeBatchInspection(['pending_inspection', 'pending_inspection'])).toBe('pending')
    expect(summarizeBatchInspection(['qualified', 'qualified'])).toBe('all_qualified')
    expect(summarizeBatchInspection(['unqualified', 'unqualified'])).toBe('all_unqualified')
    expect(summarizeBatchInspection(['qualified', 'unqualified'])).toBe('partially_qualified')
    expect(summarizeBatchInspection(['qualified', 'pending_inspection'])).toBe('in_progress')
    expect(summarizeBatchInspection(['qualified', 're_inspection'])).toBe('in_progress')
  })
})

describe('A-7 结论写入与判定前置（Web 只补待检 / 整批判定）', () => {
  it('Web 质检只补仍待检码；判定按批次状态前置', () => {
    expect(shouldWebInspectionWriteCode('pending_inspection')).toBe(true)
    expect(shouldWebInspectionWriteCode('re_inspection')).toBe(true)
    expect(shouldWebInspectionWriteCode('qualified')).toBe(false)
    expect(() => assertWebInspectionExecutable({ batchStatus: 'pending', storageStatus: 'stored' })).not.toThrow()
    expectViolation('A-7', () => assertWebInspectionExecutable({ batchStatus: 'all_qualified', storageStatus: 'stored' }))
    expect(() => assertJudgeExecutable({ conclusion: 'qualified', batchStatus: 'partially_qualified', storageStatus: 'stored' })).not.toThrow()
    expectViolation('A-7', () => assertJudgeExecutable({ conclusion: 'qualified', batchStatus: 'exempt', storageStatus: 'stored' }))
    expect(() => assertJudgeExecutable({ conclusion: 'unqualified', batchStatus: 'exempt', storageStatus: 'stored' })).not.toThrow()
    expectViolation('A-7', () => assertJudgeExecutable({ conclusion: 'unqualified', batchStatus: 'all_unqualified', storageStatus: 'stored' }))
  })
})

describe('A-6/A-8 复检与撤销（S14 版本化）', () => {
  it('复检至多一次：仅不合格可发起；撤销仅合格/不合格结论且非首检初始行', () => {
    expect(() =>
      assertReinspectionStartable({ detailStatus: 'unqualified', hasReinspection: false, storageStatus: 'stored' }),
    ).not.toThrow()
    expectViolation('A-6', () =>
      assertReinspectionStartable({ detailStatus: 'unqualified', hasReinspection: true, storageStatus: 'stored' }),
    )
    expectViolation('A-6', () =>
      assertReinspectionStartable({ detailStatus: 'qualified', hasReinspection: false, storageStatus: 'stored' }),
    )
    expect(() =>
      assertRevocationAllowed({ effectiveConclusion: 'qualified', effectiveVersion: 2, storageStatus: 'stored' }),
    ).not.toThrow()
    expectViolation('A-8', () =>
      assertRevocationAllowed({ effectiveConclusion: 'pending', effectiveVersion: 2, storageStatus: 'stored' }),
    )
    expectViolation('A-8', () =>
      assertRevocationAllowed({ effectiveConclusion: 'qualified', effectiveVersion: 1, storageStatus: 'stored' }),
    )
    expect(revokedDetailStatus({ chain: 'first', initialConclusion: 'pending' })).toBe('pending_inspection')
    expect(revokedDetailStatus({ chain: 'first', initialConclusion: 'exempt' })).toBe('exempt')
    expect(revokedDetailStatus({ chain: 're', initialConclusion: 'pending' })).toBe('re_inspection')
  })

  it('S14 版本号递增', () => {
    expect(nextInspectionVersion([])).toBe(1)
    expect(nextInspectionVersion([1])).toBe(2)
    expect(nextInspectionVersion([1, 3])).toBe(4)
  })
})

describe('A-9 退货前置', () => {
  it('仅全部不合格且未退货可退；备注必填', () => {
    expect(() => assertReturnExecutable({ batchInspectionStatus: 'all_unqualified', storageStatus: 'stored' })).not.toThrow()
    expectViolation('A-9', () =>
      assertReturnExecutable({ batchInspectionStatus: 'all_unqualified', storageStatus: 'returned' }),
    )
    expectViolation('A-9', () =>
      assertReturnExecutable({ batchInspectionStatus: 'partially_qualified', storageStatus: 'stored' }),
    )
    expectViolation('A-9', () => assertReturnReasonPresent(''))
    expectViolation('A-9', () => assertReturnReasonPresent('   '))
    expect(() => assertReturnReasonPresent('来料全部不合格，整批退回')).not.toThrow()
  })
})

describe('A-10 价格复核快照（近 5 次、均价、浮动、±10% 标记）', () => {
  it('无历史：均价/浮动/标记为空；有历史：均价与浮动按定点计算', () => {
    const none = computePriceSnapshot({ currentPrice: '100.0000', history: [] })
    expect(none.avgPrice).toBeNull()
    expect(none.deviationPpm).toBeNull()
    expect(none.flag).toBeNull()

    const history = [{ batchNo: 'PRB1', price: '90.0000', confirmTime: '2026-10-01T00:00:00Z' }]
    const up = computePriceSnapshot({ currentPrice: '100.0000', history })
    expect(up.avgPrice).toBe('90.0000')
    expect(up.deviationPpm).toBe(111_111) // (100−90)/90 ≈ +11.11%
    expect(up.flag).toBe('up')

    const down = computePriceSnapshot({ currentPrice: '80.0000', history })
    expect(down.flag).toBe('down') // −11.11% ≤ −10%
  })

  it('边界 ±10%（含边界）与窗口截取（近 5 次）', () => {
    expect(deviationPpm('99.0000', '90.0000')).toBe(100_000) // 恰 +10% → up（含边界）
    expect(computePriceSnapshot({ currentPrice: '99.0000', history: [{ batchNo: 'PRB1', price: '90.0000', confirmTime: 't' }] }).flag).toBe('up')
    expect(computePriceSnapshot({ currentPrice: '81.0000', history: [{ batchNo: 'PRB1', price: '90.0000', confirmTime: 't' }] }).flag).toBe('down')
    expect(computePriceSnapshot({ currentPrice: '95.0000', history: [{ batchNo: 'PRB1', price: '90.0000', confirmTime: 't' }] }).flag).toBeNull()

    const many = Array.from({ length: 8 }, (_, i) => ({
      batchNo: `PRB${i + 1}`,
      price: `${90 + i}.0000`,
      confirmTime: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }))
    const snapshot = computePriceSnapshot({ currentPrice: '100.0000', history: many })
    expect(snapshot.history).toHaveLength(5) // 近 5 次窗口
  })
})
