import { describe, expect, it } from 'vitest'
import {
  ExecutionRuleViolation,
  REPORT_SOURCES,
  assertReportContext,
  assertDraftIsolationAllowed,
  assertNoCrossSourceOpenDraft,
  assertDraftOperationLocked,
  earliestDraft,
  computeOperationReadiness,
  assertOperationReady,
  resolveLastNonQcOperation,
  decideReviewOutcome,
  assertReviewTransitionAllowed,
  shouldPushLastOperationOutput,
  computeFiveQuantities,
  assertNoMixedQuantityPresentation,
  effectiveOverrunRatio,
  mulQtyDecimal,
  assertReportOverrunLimit,
  plannedOverrunLimit,
  isProductAxisCode,
  assertProductAxisCode,
  assertFeedCodeAdmission,
  assertCrossOrderFeedAuthorized,
  assertSalesLineFeedWithinRemainder,
  assertFeedOperationSelectable,
  assertReportEditable,
  assertReportDeletable,
  assertReviewCancellable,
  reviewCancelTransition,
  assertCorrectionReference,
  assertNoEmptyBarcodeForSubmit,
  EXECUTION_PERMISSIONS,
} from '../../packages/domain/src/execution/index'

/**
 * execution 域纯规则单测 —— 规则来源为底稿 03-production-chain-rules-T05T09T10T11.md
 * A5/A6/A7 节（逐条标注 [底稿 A5-x]/[底稿 A6-x]/[底稿 A7-x]/[合同新造]）。
 */

function violationOf(fn: () => unknown): ExecutionRuleViolation | null {
  try {
    fn()
    return null
  } catch (error) {
    if (error instanceof ExecutionRuleViolation) return error
    throw error
  }
}

const OP = (seq: number, isQc: boolean, dept = 'DEPT-1') => ({ seq, isQc, productionDeptId: dept })

describe('[底稿 A6-1] ReportContext 三入口显式绑定', () => {
  it('来源三值 + workbench 绑工序 + scan 绑设备/班次；非法来源拒绝', () => {
    expect(REPORT_SOURCES).toEqual(['order', 'workbench', 'scan'])
    expect(() =>
      assertReportContext({ source: 'order', orderId: 'o1', operatorUserId: 'u1' }),
    ).not.toThrow()
    const badSource = violationOf(() =>
      assertReportContext({ source: 'pda', orderId: 'o1', operatorUserId: 'u1' }),
    )
    expect(badSource?.rule).toBe('A6-1')
    expect(violationOf(() => assertReportContext({ source: 'workbench', orderId: 'o1', operatorUserId: 'u1' }))?.rule).toBe('A6-1')
    expect(
      violationOf(() => assertReportContext({ source: 'scan', orderId: 'o1', operatorUserId: 'u1' }))?.rule,
    ).toBe('A6-1')
    expect(() =>
      assertReportContext({
        source: 'scan',
        orderId: 'o1',
        operatorUserId: 'u1',
        equipmentId: 'eq1',
        shiftDate: '2026-10-27',
      }),
    ).not.toThrow()
    expect(violationOf(() => assertReportContext({ source: 'order', orderId: '', operatorUserId: 'u1' }))?.rule).toBe('A6-1')
  })
})

describe('[底稿 A6-2] 草稿隔离键与跨来源互斥', () => {
  const drafts = [
    { sessionId: 's1', source: 'order' as const, orderOperationId: null, operatorUserId: 'u1', orderId: 'o1' },
  ]
  it('同操作工+同订单+同来源至多一张未提交；工作台细分到工序', () => {
    expect(
      violationOf(() =>
        assertDraftIsolationAllowed({
          operatorUserId: 'u1',
          orderId: 'o1',
          source: 'order',
          openDrafts: drafts,
        }),
      )?.rule,
    ).toBe('A6-2')
    // 其它操作工/其它订单不冲突
    expect(() =>
      assertDraftIsolationAllowed({ operatorUserId: 'u2', orderId: 'o1', source: 'order', openDrafts: drafts }),
    ).not.toThrow()
    // 工作台来源按工序细分：op1 冲突、op2 放行
    const workbenchDrafts = [
      { sessionId: 's2', source: 'workbench' as const, orderOperationId: 'op1', operatorUserId: 'u1', orderId: 'o1' },
    ]
    expect(
      violationOf(() =>
        assertDraftIsolationAllowed({
          operatorUserId: 'u1',
          orderId: 'o1',
          source: 'workbench',
          orderOperationId: 'op1',
          openDrafts: workbenchDrafts,
        }),
      )?.rule,
    ).toBe('A6-2')
    expect(() =>
      assertDraftIsolationAllowed({
        operatorUserId: 'u1',
        orderId: 'o1',
        source: 'workbench',
        orderOperationId: 'op2',
        openDrafts: workbenchDrafts,
      }),
    ).not.toThrow()
  })
  it('跨来源互斥：存在其它来源未提交单时拒绝进入；续作锁工序；最早草稿直达', () => {
    expect(
      violationOf(() =>
        assertNoCrossSourceOpenDraft({ operatorUserId: 'u1', orderId: 'o1', source: 'workbench', openDrafts: drafts }),
      )?.rule,
    ).toBe('A6-2')
    expect(
      violationOf(() =>
        assertDraftOperationLocked({
          currentOperationId: 'op1',
          requestedOperationId: 'op2',
          hasOutputs: true,
        }),
      )?.rule,
    ).toBe('A6-2')
    expect(() =>
      assertDraftOperationLocked({ currentOperationId: 'op1', requestedOperationId: 'op1', hasOutputs: true }),
    ).not.toThrow()
    expect(
      earliestDraft([
        { sessionId: 'b', createdAt: '2026-10-27T02:00:00Z' },
        { sessionId: 'a', createdAt: '2026-10-27T01:00:00Z' },
      ]),
    ).toBe('a')
    expect(earliestDraft([])).toBeNull()
  })
})

describe('[底稿 A6-3/K13 合同新造] 工序就绪统一判定（三入口共用）', () => {
  const operations = [OP(1, false), OP(2, true), OP(3, false)]
  it('首道非质检就绪；质检/未设部门不可选；非本部门不可选', () => {
    expect(computeOperationReadiness({ operations, reports: [], targetSeq: 1 })).toEqual({
      ready: true,
      reason: expect.stringContaining('首道'),
    })
    expect(computeOperationReadiness({ operations, reports: [], targetSeq: 2 }).ready).toBe(false)
    expect(computeOperationReadiness({ operations: [OP(1, false, null as unknown as string)], reports: [], targetSeq: 1 }).ready).toBe(false)
    expect(
      computeOperationReadiness({ operations, reports: [], targetSeq: 3, actorDeptIds: ['DEPT-9'] }).ready,
    ).toBe(false)
  })
  it('非首道：最近的非质检前道须有已提交且有产出的报工单（跳过质检工序）', () => {
    const verdictEmpty = computeOperationReadiness({ operations, reports: [], targetSeq: 3 })
    expect(verdictEmpty.ready).toBe(false)
    expect(verdictEmpty.reason).toContain('seq=1')
    const verdictReady = computeOperationReadiness({
      operations,
      reports: [{ seq: 1, submitted: true, hasOutput: true }],
      targetSeq: 3,
    })
    expect(verdictReady.ready).toBe(true)
    expect(
      violationOf(() =>
        assertOperationReady({ operations, reports: [{ seq: 1, submitted: true, hasOutput: false }], targetSeq: 3 }),
      )?.rule,
    ).toBe('A6-3')
  })
})

describe('[底稿 A6-4/合同新造 GAP C2] 审核轴判定', () => {
  const operations = [OP(1, false), OP(2, true), OP(3, false)]
  it('末道为质检时往前取最近非质检；非末道自动通过；末道按车间配置', () => {
    expect(resolveLastNonQcOperation(operations)?.seq).toBe(3)
    expect(resolveLastNonQcOperation([OP(1, true), OP(2, true)])).toBeNull()
    expect(decideReviewOutcome({ operations, reportedSeq: 1, autoReviewDeptIds: [] })).toBe('auto_approved')
    expect(decideReviewOutcome({ operations, reportedSeq: 3, autoReviewDeptIds: [] })).toBe('pending_review')
    expect(decideReviewOutcome({ operations, reportedSeq: 3, autoReviewDeptIds: ['DEPT-1'] })).toBe('auto_approved')
    // 全质检不自动审核
    expect(decideReviewOutcome({ operations: [OP(1, true)], reportedSeq: 1, autoReviewDeptIds: ['DEPT-1'] })).toBe(
      'pending_review',
    )
  })
  it('审核迁移前置：草稿不能审核；已审核不可重复；末道非样品外传', () => {
    expect(violationOf(() => assertReviewTransitionAllowed({ status: 'draft', reviewStatus: 'pending_review' }))?.rule).toBe('A6-5')
    expect(
      violationOf(() => assertReviewTransitionAllowed({ status: 'submitted', reviewStatus: 'manual_approved' }))?.rule,
    ).toBe('A6-5')
    expect(() => assertReviewTransitionAllowed({ status: 'submitted', reviewStatus: 'pending_review' })).not.toThrow()
    expect(shouldPushLastOperationOutput({ isLastNonQc: false, orderType: null })).toBe(false)
    expect(shouldPushLastOperationOutput({ isLastNonQc: true, orderType: null })).toBe(true)
    expect(shouldPushLastOperationOutput({ isLastNonQc: true, orderType: 'SAMPLE' })).toBe(false)
  })
})

describe('[底稿 A5-3/S02] 五量分立', () => {
  it('草稿/提交/审核/合格/入库分别计数，互不覆盖；混口径冒充拒绝', () => {
    const result = computeFiveQuantities([
      {
        status: 'draft',
        reviewStatus: 'pending_review',
        uomId: 'u',
        outputs: [{ quantity: '10.0000', qualifiedQty: '10.0000', stockUnitId: null }],
      },
      {
        status: 'submitted',
        reviewStatus: 'pending_review',
        uomId: 'u',
        outputs: [{ quantity: '30.0000', qualifiedQty: '30.0000', stockUnitId: null }],
      },
      {
        status: 'submitted',
        reviewStatus: 'auto_approved',
        uomId: 'u',
        outputs: [{ quantity: '20.0000', qualifiedQty: '18.0000', stockUnitId: 'unit-1' }],
      },
    ])
    expect(result).toEqual({
      draft: '10.0000',
      submitted: '30.0000',
      approved: '20.0000',
      qualified: '18.0000',
      stocked: '20.0000',
    })
    expect(
      violationOf(() => assertNoMixedQuantityPresentation({ presentedAs: 'approved', actualKind: 'draft' }))?.rule,
    ).toBe('A5-3')
  })
})

describe('[底稿 A5-1/A5-2 + GAP C1] 超产硬限（服务端同单位）', () => {
  it('末道累计（含未提交）≤ 计划×超额系数；定点乘法；系数取值序与保守默认', () => {
    expect(mulQtyDecimal('100.0000', '1.1000')).toBe('110.0000')
    expect(effectiveOverrunRatio('1.2000', null)).toBe('1.2000')
    expect(effectiveOverrunRatio(null, '1.0500')).toBe('1.0500')
    expect(effectiveOverrunRatio(null, null)).toBe('1.0000')
    expect(plannedOverrunLimit({ plannedQty: '100.0000', overrunRatio: '1.1000' })).toBe('110.0000')
    // 110 恰好放行
    expect(() =>
      assertReportOverrunLimit({
        plannedQty: '100.0000',
        overrunRatio: '1.1000',
        existingReportedTotal: '100.0000',
        incomingQty: '10.0000',
        uom: 'M',
      }),
    ).not.toThrow()
    const over = violationOf(() =>
      assertReportOverrunLimit({
        plannedQty: '100.0000',
        overrunRatio: '1.1000',
        existingReportedTotal: '100.0000',
        incomingQty: '10.5000',
        uom: 'M',
      }),
    )
    expect(over?.rule).toBe('A5-1')
    expect(over?.message).toContain('超额系数 1.1000')
    // 未提交草稿计入累计（existingReportedTotal 由调用方含草稿传入，规则不区分）
    expect(
      violationOf(() =>
        assertReportOverrunLimit({
          plannedQty: '100.0000',
          overrunRatio: null,
          existingReportedTotal: '50.0000',
          incomingQty: '51.0000',
          uom: 'M',
        }),
      )?.rule,
    ).toBe('A5-1')
    // 同单位断言：单位不一致直接拒绝（A5-2）
    expect(
      violationOf(() =>
        assertReportOverrunLimit({
          plannedQty: '100.0000',
          overrunRatio: null,
          existingReportedTotal: '10.0000',
          incomingQty: '1.0000',
          uom: 'M',
          existingUom: 'KG',
        }),
      )?.rule,
    ).toBe('A5-2')
  })
})

describe('[底稿 A7-2/A7-4] 投料码准入链与销售行余量', () => {
  const facts = {
    barcodeValue: '1E12345678',
    barcodeArchived: true,
    salesOrderNo: 'SO-1',
    salesLineNo: '10',
    qualityAdmitted: true,
    inStock: true,
    balanceExists: true,
    atLineSideLocation: true,
    consumableMaterial: true,
    notCurrentOperationOutput: true,
    acceptableOrigin: true,
    availableQty: '50.0000',
  }
  it('产品轴码：10 位第 2 位 E/F/M；托码/原料码拒绝', () => {
    expect(isProductAxisCode('1E12345678')).toBe(true)
    expect(isProductAxisCode('1F12345678')).toBe(true)
    expect(isProductAxisCode('1M12345678')).toBe(true)
    expect(isProductAxisCode('1D12345678')).toBe(false)
    expect(isProductAxisCode('1E1234567')).toBe(false)
    expect(violationOf(() => assertProductAxisCode('1D12345678'))?.rule).toBe('A7-2')
  })
  it('链序逐条：档案→销售行→质量→在库→线边库→可耗→非本工序产出→前道产出→余量>0', () => {
    expect(() => assertFeedCodeAdmission(facts)).not.toThrow()
    expect(
      violationOf(() => assertFeedCodeAdmission({ ...facts, barcodeArchived: false }))?.message,
    ).toContain('二维码档案')
    expect(
      violationOf(() => assertFeedCodeAdmission({ ...facts, salesOrderNo: null }))?.message,
    ).toContain('销售单号')
    expect(
      violationOf(() => assertFeedCodeAdmission({ ...facts, qualityAdmitted: false }))?.message,
    ).toContain('质检')
    expect(
      violationOf(() => assertFeedCodeAdmission({ ...facts, inStock: false }))?.message,
    ).toContain('不在库')
    expect(
      violationOf(() => assertFeedCodeAdmission({ ...facts, atLineSideLocation: false }))?.message,
    ).toContain('线边库')
    expect(
      violationOf(() => assertFeedCodeAdmission({ ...facts, consumableMaterial: false }))?.message,
    ).toContain('成品/原料')
    expect(
      violationOf(() => assertFeedCodeAdmission({ ...facts, notCurrentOperationOutput: false }))?.message,
    ).toContain('本工序产出')
    expect(
      violationOf(() => assertFeedCodeAdmission({ ...facts, acceptableOrigin: false }))?.message,
    ).toContain('之前任一道产出')
    expect(
      violationOf(() => assertFeedCodeAdmission({ ...facts, availableQty: '0.0000' }))?.message,
    ).toContain('可投数量为 0')
  })
  it('跨订单偏离记录（S11）：显式确认+原因；销售行汇总≤剩余、行余 0 整码拒绝', () => {
    expect(
      violationOf(() => assertCrossOrderFeedAuthorized({ isCrossOrder: true, confirmed: false, reason: 'r' }))?.rule,
    ).toBe('A7-3')
    expect(
      violationOf(() => assertCrossOrderFeedAuthorized({ isCrossOrder: true, confirmed: true, reason: '  ' }))?.rule,
    ).toBe('A7-3')
    expect(assertCrossOrderFeedAuthorized({ isCrossOrder: true, confirmed: true, reason: '授权投料' })).toEqual({
      deviationReason: '授权投料',
    })
    expect(
      violationOf(() =>
        assertSalesLineFeedWithinRemainder({
          lines: [
            { salesOrderNo: 'SO-1', salesLineNo: '10', quantity: '30.0000' },
            { salesOrderNo: 'SO-1', salesLineNo: '10', quantity: '25.0000' },
          ],
          remainders: { 'SO-1|10': '50.0000' },
          barcodeValue: '1E12345678',
        }),
      )?.rule,
    ).toBe('A7-4')
    expect(
      violationOf(() =>
        assertSalesLineFeedWithinRemainder({
          lines: [{ salesOrderNo: 'SO-1', salesLineNo: '10', quantity: '1.0000' }],
          remainders: { 'SO-1|10': '0.0000' },
          barcodeValue: '1E12345678',
        }),
      )?.message,
    ).toContain('整码拒绝')
  })
})

describe('[底稿 A7-1] 投料工序准入', () => {
  it('质检工序不可选；未设部门不可选；已有投料行不能换工序', () => {
    expect(
      violationOf(() =>
        assertFeedOperationSelectable({
          isQc: true,
          productionDeptId: 'D1',
          existingFeedOperationId: null,
          requestedOperationId: 'op1',
        }),
      )?.rule,
    ).toBe('A7-1')
    expect(
      violationOf(() =>
        assertFeedOperationSelectable({
          isQc: false,
          productionDeptId: null,
          existingFeedOperationId: null,
          requestedOperationId: 'op1',
        }),
      )?.rule,
    ).toBe('A7-1')
    expect(
      violationOf(() =>
        assertFeedOperationSelectable({
          isQc: false,
          productionDeptId: 'D1',
          existingFeedOperationId: 'op1',
          requestedOperationId: 'op2',
        }),
      )?.rule,
    ).toBe('A7-1')
    expect(() =>
      assertFeedOperationSelectable({
        isQc: false,
        productionDeptId: 'D1',
        existingFeedOperationId: 'op1',
        requestedOperationId: 'op1',
      }),
    ).not.toThrow()
  })
})

describe('[底稿 A6-6/K15/K17/K18] 编辑/删除/取消审核守卫', () => {
  it('编辑：不改审核状态；有产出时工序不可改；人工审核通过后不可编辑', () => {
    expect(
      violationOf(() =>
        assertReportEditable({
          status: 'submitted',
          reviewStatus: 'pending_review',
          hasOutputs: true,
          currentOperationId: 'op1',
          requestedOperationId: 'op1',
          attemptsReviewStateChange: true,
        }),
      )?.rule,
    ).toBe('A6-6')
    expect(
      violationOf(() =>
        assertReportEditable({
          status: 'submitted',
          reviewStatus: 'pending_review',
          hasOutputs: true,
          currentOperationId: 'op1',
          requestedOperationId: 'op2',
          attemptsReviewStateChange: false,
        }),
      )?.message,
    ).toContain('有产出时工序不可改')
    expect(
      violationOf(() =>
        assertReportEditable({
          status: 'submitted',
          reviewStatus: 'manual_approved',
          hasOutputs: true,
          currentOperationId: 'op1',
          requestedOperationId: 'op1',
          attemptsReviewStateChange: false,
        }),
      )?.message,
    ).toContain('人工审核通过后不可编辑')
  })
  it('删除：仅草稿/待审且未入库；已审核单走冲销（K17）', () => {
    expect(() =>
      assertReportDeletable({
        status: 'submitted',
        reviewStatus: 'pending_review',
        outputsStocked: false,
        outputsModified: false,
      }),
    ).not.toThrow()
    expect(
      violationOf(() =>
        assertReportDeletable({
          status: 'submitted',
          reviewStatus: 'auto_approved',
          outputsStocked: false,
          outputsModified: false,
        }),
      )?.message,
    ).toContain('K17')
    expect(
      violationOf(() =>
        assertReportDeletable({
          status: 'submitted',
          reviewStatus: 'pending_review',
          outputsStocked: true,
          outputsModified: false,
        }),
      )?.message,
    ).toContain('未入库')
  })
  it('取消审核：产出已入库/被消耗/质检完成任一命中即拦截（K18 对象关系）', () => {
    const base = { status: 'submitted' as const, reviewStatus: 'auto_approved' as const }
    expect(() =>
      assertReviewCancellable({ ...base, anyOutputPutAway: false, anyOutputConsumed: false, qcCompleted: false }),
    ).not.toThrow()
    expect(
      violationOf(() =>
        assertReviewCancellable({ ...base, anyOutputPutAway: true, anyOutputConsumed: false, qcCompleted: false }),
      )?.message,
    ).toContain('已入库')
    expect(
      violationOf(() =>
        assertReviewCancellable({ ...base, anyOutputPutAway: false, anyOutputConsumed: true, qcCompleted: false }),
      )?.message,
    ).toContain('被消耗')
    expect(
      violationOf(() =>
        assertReviewCancellable({ ...base, anyOutputPutAway: false, anyOutputConsumed: false, qcCompleted: true }),
      )?.message,
    ).toContain('质检已完成')
    expect(reviewCancelTransition({ reviewStatus: 'manual_approved' })).toBe('pending_review')
  })
  it('更正引用：同订单同工序原单；空码不能提交（K07）', () => {
    expect(
      violationOf(() =>
        assertCorrectionReference({
          correctionOf: 'r1',
          original: { id: 'r1', orderId: 'o1', orderOperationId: 'op1' },
          newOrderId: 'o2',
          newOrderOperationId: 'op1',
        }),
      )?.rule,
    ).toBe('A6-6')
    expect(() =>
      assertCorrectionReference({
        correctionOf: 'r1',
        original: { id: 'r1', orderId: 'o1', orderOperationId: 'op1' },
        newOrderId: 'o1',
        newOrderOperationId: 'op1',
      }),
    ).not.toThrow()
    expect(violationOf(() => assertNoEmptyBarcodeForSubmit({ barcodeValues: ['  '] }))?.message).toContain('空码')
    expect(EXECUTION_PERMISSIONS.review).toBe('execution.review')
  })
})
