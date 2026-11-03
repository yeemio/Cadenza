import { describe, expect, it } from 'vitest'
// [L0-整合标记] domain disposition 面未并入包名入口：dist 相对桥接（L0 整合后改包名导入）。
import {
  checkSuspectScan,
  assertSuspectMarkAllowed,
  joinMaterialKey,
  assertSuspectRecovery,
  assertUnitNotSuspectForConsumption,
  isAvailableQualityStatus,
  checkDefectScan,
  assertDefectQty,
  assertDefectSubmittable,
  assertDefectReviewable,
  assertDeductionDestination,
  allocateDeduction,
  unitDefectState,
  summarizeBatchInspectionStatus,
  assertWebWriteBatchState,
  assertWebWriteTargetPending,
  assertWebWriteConclusion,
  assertPdaSubmitAllowed,
  assertPdaConclusion,
  assertJudgementCondition,
  assertJudgementWritable,
  assertReInspectionInitiable,
  assertNotDownstreamConsumed,
  assertDispositionDecision,
  assertReworkTaskLink,
  assertScrapQty,
  assertConcession,
  checkDecimalScale,
  checkRemark,
  checkAttachments,
  DispositionRuleViolation,
} from '../../packages/domain/dist/disposition/index.js'

/**
 * disposition 域纯规则测试（QD-01～QD-23 可判定分支；无 DB）。
 * 冻结合同 frozen/p2/quality-disposition.md 逐条对照。
 */

function expectViolation(rule: string, fn: () => void): DispositionRuleViolation {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(DispositionRuleViolation)
    expect((error as DispositionRuleViolation).rule).toBe(rule)
    return error as DispositionRuleViolation
  }
  throw new Error(`预期抛出 [${rule}] 违例，但未抛出`)
}

describe('QD-01 存疑扫码前置（PDA 只查询；确认重校验）', () => {
  it('五拒绝分支：无料品/托码/未入库/无库位/已存疑', () => {
    expect(checkSuspectScan({ hasLinkedMaterial: false, isPalletCode: false, isReceived: true, hasLocation: true, alreadySuspect: false })).toBe('no_material')
    expect(checkSuspectScan({ hasLinkedMaterial: true, isPalletCode: true, isReceived: true, hasLocation: true, alreadySuspect: false })).toBe('pallet_code')
    expect(checkSuspectScan({ hasLinkedMaterial: true, isPalletCode: false, isReceived: false, hasLocation: true, alreadySuspect: false })).toBe('not_received')
    expect(checkSuspectScan({ hasLinkedMaterial: true, isPalletCode: false, isReceived: true, hasLocation: false, alreadySuspect: false })).toBe('no_location')
    expect(checkSuspectScan({ hasLinkedMaterial: true, isPalletCode: false, isReceived: true, hasLocation: true, alreadySuspect: true })).toBe('already_suspect')
    expect(checkSuspectScan({ hasLinkedMaterial: true, isPalletCode: false, isReceived: true, hasLocation: true, alreadySuspect: false })).toBe('ok')
  })

  it('确认时按扫码规则重校验：任一命中拒绝并带 [QD-01]', () => {
    expectViolation('QD-01', () => assertSuspectMarkAllowed('pallet_code', 'U-1'))
    expect(() => assertSuspectMarkAllowed('ok', 'U-1')).not.toThrow()
  })
})

describe('QD-02 存疑记录字段（料品去重拼接）', () => {
  it('编号/名称/规格/颜色去重拼接', () => {
    expect(
      joinMaterialKey([
        { code: 'M1', name: '铜杆', spec: '3mm', color: null },
        { code: 'M1', name: '铜杆', spec: '3mm', color: null },
        { code: 'M2', name: '缆', spec: null, color: '红' },
      ]),
    ).toBe('M1/铜杆/3mm;M2/缆/红')
  })
})

describe('QD-03 存疑恢复=处置记录（不覆盖原存疑记录）', () => {
  it('缺关联/缺操作者/缺时间拒绝；高影响场景强制处置依据', () => {
    expectViolation('QD-03', () =>
      assertSuspectRecovery({ suspectRecordId: null, operator: 'a', occurredAt: new Date(), basis: null, highImpact: false }),
    )
    expectViolation('QD-03', () =>
      assertSuspectRecovery({ suspectRecordId: 'r1', operator: '', occurredAt: new Date(), basis: null, highImpact: false }),
    )
    expectViolation('QD-03', () =>
      assertSuspectRecovery({ suspectRecordId: 'r1', operator: 'a', occurredAt: null, basis: null, highImpact: false }),
    )
    // 高影响（备货/待发运）无依据拒绝
    expectViolation('QD-03', () =>
      assertSuspectRecovery({ suspectRecordId: 'r1', operator: 'a', occurredAt: new Date(), basis: '  ', highImpact: true }),
    )
    expect(
      assertSuspectRecovery({ suspectRecordId: 'r1', operator: 'a', occurredAt: new Date(), basis: '复检合格', highImpact: true }).suspectRecordId,
    ).toBe('r1')
  })
})

describe('QD-04 可用性贯穿（存疑不可消费/移动；可用量只由合格余额形成）', () => {
  it('存疑拒绝并给出可解释提示；合格才可用', () => {
    expectViolation('QD-04', () => assertUnitNotSuspectForConsumption('suspect', 'U-9'))
    expect(() => assertUnitNotSuspectForConsumption('qualified', 'U-9')).not.toThrow()
    expect(isAvailableQualityStatus('qualified')).toBe(true)
    expect(isAvailableQualityStatus('suspect')).toBe(false)
    expect(isAvailableQualityStatus('pending_inspection')).toBe(false)
  })
})

describe('QD-05 成品异常 PDA 前置', () => {
  it('托码拒；已入库非线边仓拒；仓库不存在拒；未入库允许', () => {
    expect(checkDefectScan({ isPalletCode: true, isReceived: true, inLineSideWarehouse: true, warehouseExists: true })).toBe('pallet_code')
    expect(checkDefectScan({ isPalletCode: false, isReceived: true, inLineSideWarehouse: false, warehouseExists: true })).toBe('not_line_side')
    expect(checkDefectScan({ isPalletCode: false, isReceived: true, inLineSideWarehouse: false, warehouseExists: false })).toBe('warehouse_missing')
    expect(checkDefectScan({ isPalletCode: false, isReceived: false, inLineSideWarehouse: false, warehouseExists: false })).toBe('ok')
    expect(checkDefectScan({ isPalletCode: false, isReceived: true, inLineSideWarehouse: true, warehouseExists: true })).toBe('ok')
  })
})

describe('QD-06 成品异常提交校验', () => {
  it('轴号空/未选料品/料品不在扫码结果/已有未处理/未传类型/数量非法 各拒', () => {
    const base = {
      unitNo: 'U-1',
      materialId: 'M1',
      materialInScanResult: true,
      hasOpenDefect: false,
      defectType: 'scrap' as const,
      defectQty: '5.0000',
      materialTotalQty: '10.0000',
    }
    expectViolation('QD-06', () => assertDefectSubmittable({ ...base, unitNo: null }))
    expectViolation('QD-06', () => assertDefectSubmittable({ ...base, materialId: null }))
    expectViolation('QD-06', () => assertDefectSubmittable({ ...base, materialInScanResult: false }))
    expectViolation('QD-06', () => assertDefectSubmittable({ ...base, hasOpenDefect: true }))
    expectViolation('QD-06', () => assertDefectSubmittable({ ...base, defectType: null }))
    expectViolation('QD-06', () => assertDefectSubmittable({ ...base, defectQty: null }))
    expectViolation('QD-06', () => assertDefectSubmittable({ ...base, defectQty: '0.0000' }))
    expectViolation('QD-06', () => assertDefectSubmittable({ ...base, defectQty: '11.0000' }))
    expectViolation('QD-06', () => assertDefectSubmittable({ ...base, defectQty: '1.12345' })) // >4 位小数
    expect(() => assertDefectSubmittable(base)).not.toThrow()
  })

  it('QD-06 数量最多 4 位小数（正数）', () => {
    expect(() => assertDefectQty('2.5000', '10.0000')).not.toThrow()
    expect(() => assertDefectQty('2.00005', '10.0000')).toThrow(DispositionRuleViolation)
  })
})

describe('QD-07/08/09 成品异常审核', () => {
  it('仅未审核可审核；去向必填（枚举＋说明＋调整原因）', () => {
    expectViolation('QD-07', () => assertDefectReviewable(null, 'FGD-1'))
    expectViolation('QD-07', () => assertDefectReviewable('approved', 'FGD-1'))
    expect(() => assertDefectReviewable('unreviewed', 'FGD-1')).not.toThrow()
    expectViolation('QD-08', () => assertDeductionDestination(null, 'note', 'reason'))
    expectViolation('QD-08', () => assertDeductionDestination('scrap', '  ', 'reason'))
    expectViolation('QD-08', () => assertDeductionDestination('scrap', 'note', null))
    expect(assertDeductionDestination('scrap', 'note', 'reason').destinationKind).toBe('scrap')
  })

  it('QD-09 足减多码依次扣；不足整体拒（不部分扣）；负余额拒', () => {
    const lines = [
      { balanceId: 'b1', availableQty: '3.0000' },
      { balanceId: 'b2', availableQty: '5.0000' },
    ]
    expect(allocateDeduction(lines, '4.0000')).toEqual([
      { balanceId: 'b1', deductQty: '3.0000' },
      { balanceId: 'b2', deductQty: '1.0000' },
    ])
    expect(allocateDeduction(lines, '8.0000')).toEqual([
      { balanceId: 'b1', deductQty: '3.0000' },
      { balanceId: 'b2', deductQty: '5.0000' },
    ])
    expectViolation('QD-09', () => allocateDeduction(lines, '8.0001'))
    expectViolation('QD-09', () => allocateDeduction(lines, '0.0000'))
  })
})

describe('QD-10 字典与投影', () => {
  it('码异常状态 2 值投影', () => {
    expect(unitDefectState(true)).toBe('defect_open')
    expect(unitDefectState(false)).toBe('normal')
  })
})

describe('QD-15 批次质检状态汇总（6 值投影，可重算）', () => {
  it('全部待检=pending；待检+结论=in_progress；全合格/全不合格/部分合格；全免检=exempt', () => {
    expect(summarizeBatchInspectionStatus([])).toBe('pending')
    expect(summarizeBatchInspectionStatus(['pending', 'pending'])).toBe('pending')
    expect(summarizeBatchInspectionStatus(['pending', 'qualified'])).toBe('in_progress')
    expect(summarizeBatchInspectionStatus(['qualified', 'qualified'])).toBe('all_qualified')
    expect(summarizeBatchInspectionStatus(['unqualified', 'unqualified'])).toBe('all_unqualified')
    expect(summarizeBatchInspectionStatus(['qualified', 'unqualified'])).toBe('partially_qualified')
    expect(summarizeBatchInspectionStatus(['exempt', 'exempt'])).toBe('exempt')
    expect(summarizeBatchInspectionStatus(['exempt', 'qualified'])).toBe('all_qualified') // 免检视作合格类
    expect(summarizeBatchInspectionStatus(['exempt', 'unqualified'])).toBe('partially_qualified')
  })
})

describe('QD-11 Web 写入范围', () => {
  it('退货批次硬拦截 [QD-17]；批次状态门槛；已有结论不改；结论仅合格/不合格', () => {
    expectViolation('QD-17', () => assertWebWriteBatchState('returned', 'pending'))
    expectViolation('QD-11', () => assertWebWriteBatchState('stored', 'all_qualified'))
    expect(() => assertWebWriteBatchState('stored', 'pending')).not.toThrow()
    expect(() => assertWebWriteBatchState('stored', 'in_progress')).not.toThrow()
    expectViolation('QD-11', () => assertWebWriteTargetPending('qualified', 'U-1'))
    expectViolation('QD-11', () => assertWebWriteTargetPending('exempt', 'U-1'))
    expect(() => assertWebWriteTargetPending('pending', 'U-1')).not.toThrow()
    expect(() => assertWebWriteTargetPending(null, 'U-1')).not.toThrow()
    expectViolation('QD-11', () => assertWebWriteConclusion('exempt'))
    expect(assertWebWriteConclusion('qualified')).toBe('qualified')
  })
})

describe('QD-12 PDA 版本化提交', () => {
  it('退货拒；免检码拒；首检已有复检须操作复检记录；附件≤3', () => {
    const base = { storageStatus: 'stored' as const, isExempt: false, hasReInspection: false, targetKind: 'initial' as const, unitNo: 'U-1' }
    expect(() => assertPdaSubmitAllowed(base)).not.toThrow()
    expectViolation('QD-17', () => assertPdaSubmitAllowed({ ...base, storageStatus: 'returned' }))
    expectViolation('QD-12', () => assertPdaSubmitAllowed({ ...base, isExempt: true }))
    expectViolation('QD-12', () => assertPdaSubmitAllowed({ ...base, hasReInspection: true, targetKind: 'initial' }))
    expect(() => assertPdaSubmitAllowed({ ...base, hasReInspection: true, targetKind: 're_inspection' })).not.toThrow()
    expectViolation('QD-12', () => assertPdaConclusion('pending', []))
    expectViolation('QD-12', () => assertPdaConclusion('qualified', [{}, {}, {}, {}]))
    expect(assertPdaConclusion('unqualified', [{}, {}, {}])).toBe('unqualified')
  })
})

describe('QD-13 判定条件与记录约束', () => {
  it('判合格=部分合格/全部不合格；判不合格=免检/全部合格/部分不合格；备注必填≤200 非纯空白；附件≤3；退货拒', () => {
    expectViolation('QD-13', () => assertJudgementCondition('qualified', 'pending'))
    expect(() => assertJudgementCondition('qualified', 'partially_qualified')).not.toThrow()
    expect(() => assertJudgementCondition('qualified', 'all_unqualified')).not.toThrow()
    expectViolation('QD-13', () => assertJudgementCondition('unqualified', 'pending'))
    expect(() => assertJudgementCondition('unqualified', 'exempt')).not.toThrow()
    expect(() => assertJudgementCondition('unqualified', 'all_qualified')).not.toThrow()
    expect(() => assertJudgementCondition('unqualified', 'partially_qualified')).not.toThrow()
    expectViolation('QD-17', () => assertJudgementWritable({ storageStatus: 'returned', remark: '备注', attachments: [] }))
    expectViolation('QD-13', () => assertJudgementWritable({ storageStatus: 'stored', remark: '  ', attachments: [] }))
    expectViolation('QD-13', () => assertJudgementWritable({ storageStatus: 'stored', remark: null, attachments: [] }))
    expectViolation('QD-13', () => assertJudgementWritable({ storageStatus: 'stored', remark: '备注', attachments: [{}, {}, {}, {}] }))
    expect(() => assertJudgementWritable({ storageStatus: 'stored', remark: '判定说明', attachments: [] })).not.toThrow()
  })
})

describe('QD-14 复检发起', () => {
  it('同码同批次至多一次；当前生效结论须不合格；退货拒', () => {
    const base = { storageStatus: 'stored' as const, alreadyHasReInspection: false, effectiveConclusion: 'unqualified' as const, unitNo: 'U-1' }
    expect(() => assertReInspectionInitiable(base)).not.toThrow()
    expectViolation('QD-14', () => assertReInspectionInitiable({ ...base, alreadyHasReInspection: true }))
    expectViolation('QD-14', () => assertReInspectionInitiable({ ...base, effectiveConclusion: 'qualified' }))
    expectViolation('QD-17', () => assertReInspectionInitiable({ ...base, storageStatus: 'returned' }))
  })
})

describe('QD-16 已下游使用拦截', () => {
  it('批次已投料/发运/转换下游使用 → 拦截并转隔离/追溯处置', () => {
    expect(() => assertNotDownstreamConsumed({ batchNo: 'B1', downstreamConsumed: false })).not.toThrow()
    const err = expectViolation('QD-16', () => assertNotDownstreamConsumed({ batchNo: 'B1', downstreamConsumed: true }))
    expect(err.message).toContain('隔离/追溯处置')
  })
})

describe('QD-20 处置决定（首期四类＋存疑恢复）', () => {
  it('类型枚举；决定人/时间/关联指针必填；放行与报废 reason 强制', () => {
    const base = {
      dispositionKind: 'rework',
      decidedBy: 'qc01',
      decidedAt: new Date(),
      basis: '依据',
      targetType: 'inventory_unit',
      targetId: 'u1',
    }
    expectViolation('QD-20', () => assertDispositionDecision({ ...base, dispositionKind: 'destroy' }))
    expectViolation('QD-20', () => assertDispositionDecision({ ...base, decidedBy: '' }))
    expectViolation('QD-20', () => assertDispositionDecision({ ...base, decidedAt: null }))
    expectViolation('QD-20', () => assertDispositionDecision({ ...base, targetId: null }))
    expectViolation('QD-20', () => assertDispositionDecision({ ...base, dispositionKind: 'release', basis: null }))
    expectViolation('QD-20', () => assertDispositionDecision({ ...base, dispositionKind: 'scrap', basis: ' ' }))
    expect(assertDispositionDecision({ ...base, dispositionKind: 'scrap', basis: 'x' })).toBe('scrap')
    expect(assertDispositionDecision(base)).toBe('rework')
  })
})

describe('QD-21 返工任务关联', () => {
  it('必须关联原码与原工序/订单', () => {
    expectViolation('QD-21', () => assertReworkTaskLink({ originUnitNo: null, originProcessOrderNo: 'PO-1', originOperation: null }))
    expectViolation('QD-21', () => assertReworkTaskLink({ originUnitNo: 'U-1', originProcessOrderNo: null, originOperation: null }))
    expect(assertReworkTaskLink({ originUnitNo: 'U-1', originProcessOrderNo: 'PO-1', originOperation: 'OP-2' }).originOperation).toBe('OP-2')
  })
})

describe('QD-22 报废数量校验', () => {
  it('正数、≤可用量；超量拒', () => {
    expect(() => assertScrapQty({ scrapQty: '5.0000', availableQty: '10.0000', unitNo: 'U-1' })).not.toThrow()
    expectViolation('QD-22', () => assertScrapQty({ scrapQty: '10.0001', availableQty: '10.0000', unitNo: 'U-1' }))
    expectViolation('QD-22', () => assertScrapQty({ scrapQty: '0', availableQty: '10.0000', unitNo: 'U-1' }))
    expectViolation('QD-22', () => assertScrapQty({ scrapQty: null, availableQty: '10.0000', unitNo: 'U-1' }))
  })
})

describe('QD-23 让步审批', () => {
  it('审批人必填；范围（批次/数量）必填；范围外数量拒', () => {
    expectViolation('QD-23', () => assertConcession({ approver: null, scope: { batchNo: 'B1', qty: '5.0000', expiresAt: null } }))
    expectViolation('QD-23', () => assertConcession({ approver: 'boss', scope: null }))
    expectViolation('QD-23', () => assertConcession({ approver: 'boss', scope: { batchNo: null, qty: '5.0000', expiresAt: null } }))
    expectViolation('QD-23', () => assertConcession({ approver: 'boss', scope: { batchNo: 'B1', qty: null, expiresAt: null } }))
    expectViolation('QD-23', () =>
      assertConcession({ approver: 'boss', scope: { batchNo: 'B1', qty: '5.0000', expiresAt: null }, requestedQty: '6.0000' }),
    )
    const ok = assertConcession({ approver: 'boss', scope: { batchNo: 'B1', qty: '5.0000', expiresAt: new Date('2027-01-01T00:00:00Z') }, requestedQty: '5.0000' })
    expect(ok.scope.qty).toBe('5.0000')
  })
})

describe('数量/备注/附件小工具（IT-07 口径）', () => {
  it('≤4 位小数十进制；备注非纯空白≤200；附件≤3', () => {
    expect(() => checkDecimalScale('12.3456', 'QD-09', '数量')).not.toThrow()
    expect(() => checkDecimalScale('12.34567', 'QD-09', '数量')).toThrow(DispositionRuleViolation)
    expect(() => checkDecimalScale('abc', 'QD-09', '数量')).toThrow(DispositionRuleViolation)
    expect(() => checkRemark('ok', 'QD-13', '备注')).not.toThrow()
    expect(() => checkRemark(' ', 'QD-13', '备注')).toThrow(DispositionRuleViolation)
    expect(() => checkRemark('x'.repeat(201), 'QD-13', '备注')).toThrow(DispositionRuleViolation)
    expect(() => checkAttachments([1, 2, 3], 'QD-12')).not.toThrow()
    expect(() => checkAttachments([1, 2, 3, 4], 'QD-12')).toThrow(DispositionRuleViolation)
  })
})
