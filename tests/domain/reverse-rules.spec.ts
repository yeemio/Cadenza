import { describe, expect, it } from 'vitest'
// domain reverse 面未并入包名入口（共享文件 domain/src/index.ts 不改动）：
// 测试直接以相对路径消费 TS 源码（vitest 转译；typecheck:tests 以相对导入纳入编译）。
import {
  MOVE_SCAN_IS_READONLY,
  assertMoveScanAcceptable,
  assertMoveSubmitAcceptable,
  assertMoveTargetWarehouse,
  mergeMoveLines,
  assertMergedLinesPositive,
  totalMovedQty,
} from '../../packages/domain/src/reverse/move-rules'
import { ReverseRuleViolation } from '../../packages/domain/src/reverse/errors'
import {
  assertTransferOutStep,
  assertTransferOutWarehouseRules,
  assertTransferOutScanAcceptable,
  assertWholeCodeOutbound,
  assertTasklessSingleInProgress,
  assertTasklessFromWarehouseConsistent,
  assertOutboundOrderEditable,
  assertBatchDeletableAllOrNothing,
  assertOutboundCompletable,
} from '../../packages/domain/src/reverse/transfer-out-rules'
import {
  isSamePlantImmediateTransfer,
  assertCrossPlantNeedsIndependentReceipt,
  assertPutawayLocationInput,
  isPutawayLocationCodeShape,
  assertPutawayScanAcceptable,
  assertInboundScanRemovable,
  inboundStatusAfterRemoval,
  assertInboundCompletable,
} from '../../packages/domain/src/reverse/transfer-in-rules'
import {
  receiveGroupKeyOf,
  assertGroupNotDuplicatedInPayload,
  mergeReceiveQuantity,
  assertReScanConfirmed,
  assertReceiptModifiable,
  assertReturnExecutable,
  assertVoidExecutable,
  assertNamedReversalExecutable,
  assertNotDownstreamConsumed,
  assertReturnSyncRetryable,
} from '../../packages/domain/src/reverse/receipt-correction-rules'
import {
  assertNotStocktakeLocked,
  STOCKTAKE_INTERCEPTED_ACTIONS,
  assertAdjustmentExecutable,
  assertAdjustmentAgainstRealtimeBalance,
  buildAdjustmentBalances,
} from '../../packages/domain/src/reverse/stocktake-rules'
import {
  assertOwnershipTransferExecutable,
  assertOwnershipPreservedOnLocationChange,
  assertCarrierLoanEventExecutable,
  isCarrierAvailableForPlant,
  CARRIER_LOAN_APPEND_ONLY,
  assertNotCustomerReturnPayload,
} from '../../packages/domain/src/reverse/ownership-carrier-rules'

/**
 * T17 reverse 域纯规则单测——冻结合同 frozen/p2/warehouse-reverse.md WR-01～WR-28。
 * 覆盖：移库扫码/提交七拒、移库范围、明细合并、调拨出库仓库类型规则/状态机/整码调出/
 * 无任务单约束/编辑删除前置/完成前置、跨厂签收二分、上架校验、删码回退、完成条件、
 * 一码多批分组、修改/退货/作废/冲销条件、下游拦截、回传重试、盘点锁定与差异调整、
 * 所有权三分不变式、载具借还状态轴、客户退货边界（GAP-F12）。
 */

function expectViolation(fn: () => void, rule: string): void {
  expect(fn).toThrow(ReverseRuleViolation)
  try {
    fn()
  } catch (error) {
    expect((error as ReverseRuleViolation).rule).toBe(rule)
    expect((error as ReverseRuleViolation).message.length).toBeGreaterThan(0)
  }
}

const cleanScan = {
  unitNo: 'U-0001',
  warehouseMismatch: false,
  selectedWarehouseLocked: false,
  unitLockedByOtherTask: false,
  palletMemberLocked: false,
  notInStock: false,
  isPalletChildWithoutWhole: false,
  duplicateInStaging: false,
  sameLocation: false,
}

describe('WR-01/02 移库扫码与提交', () => {
  it('WR-01：扫码查询只读结构常量', () => {
    expect(MOVE_SCAN_IS_READONLY).toBe(true)
  })

  it('WR-02：扫码七类拒绝逐一命中（仓库不同/仓锁/码锁/托下锁/不在库/托下单码/本次重复/原=新库位）', () => {
    expect(() => assertMoveScanAcceptable(cleanScan)).not.toThrow()
    expectViolation(() => assertMoveScanAcceptable({ ...cleanScan, warehouseMismatch: true }), 'WR-02')
    expectViolation(() => assertMoveScanAcceptable({ ...cleanScan, selectedWarehouseLocked: true }), 'WR-02')
    expectViolation(() => assertMoveScanAcceptable({ ...cleanScan, unitLockedByOtherTask: true }), 'WR-02')
    expectViolation(() => assertMoveScanAcceptable({ ...cleanScan, palletMemberLocked: true }), 'WR-02')
    expectViolation(() => assertMoveScanAcceptable({ ...cleanScan, notInStock: true }), 'WR-02')
    expectViolation(() => assertMoveScanAcceptable({ ...cleanScan, isPalletChildWithoutWhole: true }), 'WR-02')
    expectViolation(() => assertMoveScanAcceptable({ ...cleanScan, duplicateInStaging: true }), 'WR-02')
    expectViolation(() => assertMoveScanAcceptable({ ...cleanScan, sameLocation: true }), 'WR-02')
  })

  it('WR-02：提交另校验（暂存空/暂存异常/库位空/仓库空/库位不在仓库）', () => {
    const clean = {
      stagingEmpty: false,
      stagingAnomaly: null as string | null,
      locationCodeEmpty: false,
      warehouseEmpty: false,
      locationNotInWarehouse: false,
    }
    expect(() => assertMoveSubmitAcceptable(clean)).not.toThrow()
    expectViolation(() => assertMoveSubmitAcceptable({ ...clean, stagingEmpty: true }), 'WR-02')
    expectViolation(() => assertMoveSubmitAcceptable({ ...clean, stagingAnomaly: '码 U-X 不存在' }), 'WR-02')
    expectViolation(() => assertMoveSubmitAcceptable({ ...clean, locationCodeEmpty: true }), 'WR-02')
    expectViolation(() => assertMoveSubmitAcceptable({ ...clean, warehouseEmpty: true }), 'WR-02')
    expectViolation(() => assertMoveSubmitAcceptable({ ...clean, locationNotInWarehouse: true }), 'WR-02')
  })
})

describe('WR-03/04 移库范围与台账合并', () => {
  it('WR-03：非本部门/未启用/线边仓拒绝；已扫码仓库与所选不一致拒绝', () => {
    const base = {
      warehouseId: 'WH-1',
      warehouseKind: 'WAREHOUSE',
      warehouseStatus: 'active',
      inActorDept: true,
      scannedWarehouseId: 'WH-1',
    }
    expect(() => assertMoveTargetWarehouse(base)).not.toThrow()
    expectViolation(() => assertMoveTargetWarehouse({ ...base, inActorDept: false }), 'WR-03')
    expectViolation(() => assertMoveTargetWarehouse({ ...base, warehouseStatus: 'locked' }), 'WR-03')
    expectViolation(() => assertMoveTargetWarehouse({ ...base, warehouseKind: 'LINE_SIDE' }), 'WR-03')
    expectViolation(() => assertMoveTargetWarehouse({ ...base, scannedWarehouseId: 'WH-2' }), 'WR-03')
  })

  it('WR-04：同码同料合并数量相加、料品编码去重拼接、合计', () => {
    const { merged, materialCodesJoined } = mergeMoveLines([
      { unitNo: 'U-1', materialCode: 'M-A', quantity: '10.0000' },
      { unitNo: 'U-1', materialCode: 'M-A', quantity: '5.0000' },
      { unitNo: 'U-2', materialCode: 'M-B', quantity: '2.0000' },
      { unitNo: 'U-3', materialCode: 'M-A', quantity: '1.0000' },
    ])
    expect(merged).toHaveLength(3)
    expect(merged[0]).toMatchObject({ unitNo: 'U-1', quantity: '15.0000' })
    expect(materialCodesJoined).toBe('M-A、M-B')
    expect(totalMovedQty(merged)).toBe('18.0000')
    expect(() => assertMergedLinesPositive(merged)).not.toThrow()
    expectViolation(
      () => assertMergedLinesPositive([{ unitNo: 'U-1', materialCode: 'M-A', quantity: '0.0000' }]),
      'WR-04',
    )
  })
})

describe('WR-06/13 调拨出库仓库类型规则与状态机', () => {
  const base = {
    transferKind: 'warehouse',
    fromWarehouseId: 'WH-1',
    toWarehouseId: 'WH-2',
    fromWarehouseKind: 'WAREHOUSE',
    toWarehouseKind: 'WAREHOUSE',
    lineMaterialTypes: [] as (number | null)[],
    fromWarehouseLocked: false,
    toWarehouseLocked: false,
  }

  it('WR-06：调入=调出/线边仓限制/生产调拨限制/锁定拒绝', () => {
    expect(() => assertTransferOutWarehouseRules(base)).not.toThrow()
    expectViolation(() => assertTransferOutWarehouseRules({ ...base, toWarehouseId: 'WH-1' }), 'WR-06')
    expectViolation(
      () =>
        assertTransferOutWarehouseRules({ ...base, fromWarehouseKind: 'LINE_SIDE', toWarehouseKind: 'WAREHOUSE' }),
      'WR-06',
    )
    expectViolation(
      () => assertTransferOutWarehouseRules({ ...base, transferKind: 'production', toWarehouseKind: 'WAREHOUSE' }),
      'WR-06',
    )
    expectViolation(
      () =>
        assertTransferOutWarehouseRules({
          ...base,
          transferKind: 'production',
          toWarehouseKind: 'LINE_SIDE',
          lineMaterialTypes: [1, 2, 3],
        }),
      'WR-06',
    )
    expectViolation(() => assertTransferOutWarehouseRules({ ...base, fromWarehouseLocked: true }), 'WR-06')
    expectViolation(() => assertTransferOutWarehouseRules({ ...base, toWarehouseLocked: true }), 'WR-06')
  })

  it('WR-13：状态机 待出库→出库中→已出库；删码删空回待出库；终态封闭', () => {
    expect(() => assertTransferOutStep('pending_out', 'outbounding')).not.toThrow()
    expect(() => assertTransferOutStep('outbounding', 'outbounded')).not.toThrow()
    expect(() => assertTransferOutStep('outbounding', 'pending_out')).not.toThrow()
    expect(() => assertTransferOutStep('pending_out', 'cancelled')).not.toThrow()
    expectViolation(() => assertTransferOutStep('pending_out', 'outbounded'), 'WR-13')
    expectViolation(() => assertTransferOutStep('outbounded', 'pending_out'), 'WR-13')
    expectViolation(() => assertTransferOutStep('cancelled', 'outbounding'), 'WR-13')
  })
})

describe('WR-07/08/09/10/11 调拨出库扫码/编辑删除/完成', () => {
  const cleanScan = {
    unitNo: 'U-1',
    notInStock: false,
    qualityUnfinished: false,
    lockedByOtherTask: false,
    remainingQtyZero: false,
    materialNotInOrderDetail: false,
    warehouseMismatch: false,
    warehouseLockedOrDisabled: false,
    orderWarehouseLocked: false,
  }

  it('WR-09：扫码八类拒绝逐一命中', () => {
    expect(() => assertTransferOutScanAcceptable(cleanScan)).not.toThrow()
    expectViolation(() => assertTransferOutScanAcceptable({ ...cleanScan, notInStock: true }), 'WR-09')
    expectViolation(() => assertTransferOutScanAcceptable({ ...cleanScan, qualityUnfinished: true }), 'WR-09')
    expectViolation(() => assertTransferOutScanAcceptable({ ...cleanScan, lockedByOtherTask: true }), 'WR-09')
    expectViolation(() => assertTransferOutScanAcceptable({ ...cleanScan, remainingQtyZero: true }), 'WR-09')
    expectViolation(() => assertTransferOutScanAcceptable({ ...cleanScan, materialNotInOrderDetail: true }), 'WR-09')
    expectViolation(() => assertTransferOutScanAcceptable({ ...cleanScan, warehouseMismatch: true }), 'WR-09')
    expectViolation(() => assertTransferOutScanAcceptable({ ...cleanScan, warehouseLockedOrDisabled: true }), 'WR-09')
    expectViolation(() => assertTransferOutScanAcceptable({ ...cleanScan, orderWarehouseLocked: true }), 'WR-09')
  })

  it('WR-10：整码调出——缺省=剩余数量；部分数量在 CA-7 裁定前拒绝', () => {
    expect(assertWholeCodeOutbound({ unitNo: 'U-1', remainingQty: '8.0000', requestedOutQty: undefined })).toBe(
      '8.0000',
    )
    expect(assertWholeCodeOutbound({ unitNo: 'U-1', remainingQty: '8.0000', requestedOutQty: '8.0000' })).toBe(
      '8.0000',
    )
    expectViolation(
      () => assertWholeCodeOutbound({ unitNo: 'U-1', remainingQty: '8.0000', requestedOutQty: '3.0000' }),
      'WR-10',
    )
  })

  it('WR-07②：无任务单每人一条进行中；后续扫码须同调出仓库（不校验料品）', () => {
    expect(() =>
      assertTasklessSingleInProgress({ operator: 'op01', existingInProgress: null }),
    ).not.toThrow()
    expectViolation(
      () =>
        assertTasklessSingleInProgress({
          operator: 'op01',
          existingInProgress: { orderNo: 'TO-1', status: 'outbounding' },
        }),
      'WR-07',
    )
    expect(() =>
      assertTasklessFromWarehouseConsistent({ unitNo: 'U-1', unitWarehouseId: 'WH-1', orderFromWarehouseId: 'WH-1' }),
    ).not.toThrow()
    expectViolation(
      () =>
        assertTasklessFromWarehouseConsistent({ unitNo: 'U-1', unitWarehouseId: 'WH-2', orderFromWarehouseId: 'WH-1' }),
      'WR-07',
    )
  })

  it('WR-08：无任务单/非待出库/已扫过码不可编辑删除；批量删除整批不删', () => {
    const editable = { orderNo: 'TO-1', sourceKind: 'web_task', status: 'pending_out', scannedCount: 0 }
    expect(() => assertOutboundOrderEditable(editable)).not.toThrow()
    expect(() => assertOutboundOrderEditable({ ...editable, action: 'delete' })).not.toThrow()
    expectViolation(
      () => assertOutboundOrderEditable({ ...editable, sourceKind: 'pda_taskless' }),
      'WR-08',
    )
    expectViolation(() => assertOutboundOrderEditable({ ...editable, status: 'outbounding' }), 'WR-08')
    expectViolation(() => assertOutboundOrderEditable({ ...editable, scannedCount: 2 }), 'WR-08')
    expect(() =>
      assertBatchDeletableAllOrNothing([editable, { ...editable, orderNo: 'TO-2' }]),
    ).not.toThrow()
    expectViolation(
      () =>
        assertBatchDeletableAllOrNothing([
          editable,
          { orderNo: 'TO-2', sourceKind: 'web_task', status: 'outbounding', scannedCount: 0 },
        ]),
      'WR-08',
    )
  })

  it('WR-11：完成前置——至少扫过一码；有货架层数未选拒绝', () => {
    const base = { orderNo: 'TO-1', loadedScanCount: 1, toWarehouseHasRack: true, toLocationId: 'L-1' }
    expect(() => assertOutboundCompletable(base)).not.toThrow()
    expectViolation(() => assertOutboundCompletable({ ...base, loadedScanCount: 0 }), 'WR-11')
    expectViolation(() => assertOutboundCompletable({ ...base, toLocationId: undefined }), 'WR-11')
    expect(() =>
      assertOutboundCompletable({ ...base, toWarehouseHasRack: false, toLocationId: undefined }),
    ).not.toThrow()
  })
})

describe('WR-14～17 调拨入库与跨厂签收', () => {
  it('WR-14：厂内即时转仓二分；跨厂禁止以固定库位冒充签收', () => {
    expect(isSamePlantImmediateTransfer('P-1', 'P-1')).toBe(true)
    expect(isSamePlantImmediateTransfer('P-1', 'P-2')).toBe(false)
    expectViolation(
      () => assertCrossPlantNeedsIndependentReceipt({ fromPlantId: 'P-1', toPlantId: 'P-2', orderNo: 'TO-X' }),
      'WR-14',
    )
    expect(() =>
      assertCrossPlantNeedsIndependentReceipt({ fromPlantId: 'P-1', toPlantId: 'P-1', orderNo: 'TO-X' }),
    ).not.toThrow()
  })

  it('WR-15：仓库类型须选库位、线边仓不选；库位编码形态', () => {
    expect(() =>
      assertPutawayLocationInput({ orderNo: 'TI-1', toWarehouseKind: 'WAREHOUSE', locationCode: '010101' }),
    ).not.toThrow()
    expectViolation(
      () => assertPutawayLocationInput({ orderNo: 'TI-1', toWarehouseKind: 'WAREHOUSE', locationCode: undefined }),
      'WR-15',
    )
    expect(() =>
      assertPutawayLocationInput({ orderNo: 'TI-1', toWarehouseKind: 'LINE_SIDE', locationCode: undefined }),
    ).not.toThrow()
    expect(isPutawayLocationCodeShape('010101')).toBe(true)
    expect(isPutawayLocationCodeShape('9101')).toBe(true)
    expect(isPutawayLocationCodeShape('01')).toBe(false)
  })

  it('WR-15：扫码上架五拒（不在本单/本单已入库/托下单码未扫托/已在库/调入仓锁定）', () => {
    const clean = {
      unitNo: 'U-1',
      notInOrder: false,
      alreadyInboundInOrder: false,
      palletChildWithoutPalletScan: false,
      alreadyInStock: false,
      toWarehouseLocked: false,
    }
    expect(() => assertPutawayScanAcceptable(clean)).not.toThrow()
    expectViolation(() => assertPutawayScanAcceptable({ ...clean, notInOrder: true }), 'WR-15')
    expectViolation(() => assertPutawayScanAcceptable({ ...clean, alreadyInboundInOrder: true }), 'WR-15')
    expectViolation(() => assertPutawayScanAcceptable({ ...clean, palletChildWithoutPalletScan: true }), 'WR-15')
    expectViolation(() => assertPutawayScanAcceptable({ ...clean, alreadyInStock: true }), 'WR-15')
    expectViolation(() => assertPutawayScanAcceptable({ ...clean, toWarehouseLocked: true }), 'WR-15')
  })

  it('WR-16：删码仅限已入库行；删空回待入库', () => {
    expect(() => assertInboundScanRemovable({ unitNo: 'U-1', lineStatus: 'inbound' })).not.toThrow()
    expectViolation(() => assertInboundScanRemovable({ unitNo: 'U-1', lineStatus: 'pending' }), 'WR-16')
    expect(inboundStatusAfterRemoval(0)).toBe('pending_in')
    expect(inboundStatusAfterRemoval(2)).toBe('inbounding')
  })

  it('WR-17：完成条件——仓锁拒/至少一码已入库/每料品已入库≥待入库', () => {
    const lines = [{ materialCode: 'M-A', pendingQty: '10.0000', inboundQty: '10.0000' }]
    expect(() => assertInboundCompletable({ orderNo: 'TI-1', lines, toWarehouseLocked: false })).not.toThrow()
    expectViolation(
      () => assertInboundCompletable({ orderNo: 'TI-1', lines, toWarehouseLocked: true }),
      'WR-17',
    )
    expectViolation(
      () =>
        assertInboundCompletable({
          orderNo: 'TI-1',
          lines: [{ materialCode: 'M-A', pendingQty: '10.0000', inboundQty: '0.0000' }],
          toWarehouseLocked: false,
        }),
      'WR-17',
    )
    expectViolation(
      () =>
        assertInboundCompletable({
          orderNo: 'TI-1',
          lines: [{ materialCode: 'M-A', pendingQty: '10.0000', inboundQty: '6.0000' }],
          toWarehouseLocked: false,
        }),
      'WR-17',
    )
  })
})

describe('WR-18～23 采购批次纠正', () => {
  it('WR-18：分组键（码+厂家批号+牌号/线径）；单次载荷重复拒绝；同组合并相加', () => {
    const a = { barcodeValue: 'BC-1', supplierLotNo: ' L-1 ', grade: ' G1 ' }
    expect(receiveGroupKeyOf(a)).toBe('BC-1::L-1::G1')
    expect(() =>
      assertGroupNotDuplicatedInPayload([
        { barcodeValue: 'BC-1', supplierLotNo: 'L-1', grade: 'G1', quantity: '1.0000' },
        { barcodeValue: 'BC-1', supplierLotNo: 'L-2', grade: 'G1', quantity: '1.0000' },
      ]),
    ).not.toThrow()
    expectViolation(
      () =>
        assertGroupNotDuplicatedInPayload([
          { barcodeValue: 'BC-1', supplierLotNo: 'L-1', grade: 'G1', quantity: '1.0000' },
          { barcodeValue: 'BC-1', supplierLotNo: 'L-1', grade: 'G1', quantity: '2.0000' },
        ]),
      'WR-18',
    )
    expect(mergeReceiveQuantity('1.0000', '2.5000')).toBe('3.5000')
  })

  it('WR-18：已收货的码再扫未确认拒绝', () => {
    expectViolation(
      () =>
        assertReScanConfirmed({
          barcodeValue: 'BC-1',
          systemRecordedQty: '5.0000',
          localSavedQty: '2.0000',
          confirmReScan: false,
        }),
      'WR-18',
    )
    expect(() =>
      assertReScanConfirmed({
        barcodeValue: 'BC-1',
        systemRecordedQty: '5.0000',
        localSavedQty: '2.0000',
        confirmReScan: true,
      }),
    ).not.toThrow()
  })

  it('WR-19：修改仅限待质检/全部不合格且未同步', () => {
    const ok = { batchNo: 'B-1', inspectionStatus: 'pending', qualifiedSyncStatus: 'none' }
    expect(() => assertReceiptModifiable(ok)).not.toThrow()
    expect(() => assertReceiptModifiable({ ...ok, inspectionStatus: 'all_unqualified' })).not.toThrow()
    expectViolation(() => assertReceiptModifiable({ ...ok, inspectionStatus: 'all_qualified' }), 'WR-19')
    expectViolation(() => assertReceiptModifiable({ ...ok, qualifiedSyncStatus: 'synced' }), 'WR-19')
  })

  it('WR-20：退货条件（全部不合格且未退货）、备注必填≤200、附件≤3', () => {
    const ok = {
      batchNo: 'B-1',
      inspectionStatus: 'all_unqualified',
      storageStatus: 'normal',
      remark: '外观不合格退回',
      attachments: [] as unknown[],
    }
    expect(() => assertReturnExecutable(ok)).not.toThrow()
    expectViolation(() => assertReturnExecutable({ ...ok, inspectionStatus: 'partially_qualified' }), 'WR-20')
    expectViolation(() => assertReturnExecutable({ ...ok, storageStatus: 'returned' }), 'WR-20')
    expectViolation(() => assertReturnExecutable({ ...ok, remark: '' }), 'WR-20')
    expectViolation(() => assertReturnExecutable({ ...ok, remark: '长'.repeat(201) }), 'WR-20')
    expectViolation(() => assertReturnExecutable({ ...ok, attachments: [1, 2, 3, 4] }), 'WR-20')
  })

  it('WR-21：作废条件（免检不可/仅待质检或全部不合格/未同步/未退货）；具名冲销强制理由', () => {
    const ok = {
      batchNo: 'B-1',
      inspectionStatus: 'pending',
      qualifiedSyncStatus: 'none',
      storageStatus: 'normal',
    }
    expect(() => assertVoidExecutable(ok)).not.toThrow()
    expectViolation(() => assertVoidExecutable({ ...ok, inspectionStatus: 'exempt' }), 'WR-21')
    expectViolation(() => assertVoidExecutable({ ...ok, inspectionStatus: 'all_qualified' }), 'WR-21')
    expectViolation(() => assertVoidExecutable({ ...ok, qualifiedSyncStatus: 'synced' }), 'WR-21')
    expectViolation(() => assertVoidExecutable({ ...ok, storageStatus: 'returned' }), 'WR-21')
    expect(() =>
      assertNamedReversalExecutable({ batchNo: 'B-1', reason: '多收纠正', reverseQty: '3.0000', bookedQty: '5.0000' }),
    ).not.toThrow()
    expectViolation(
      () => assertNamedReversalExecutable({ batchNo: 'B-1', reason: ' ', reverseQty: '3.0000', bookedQty: '5.0000' }),
      'WR-21',
    )
    expectViolation(
      () => assertNamedReversalExecutable({ batchNo: 'B-1', reason: '多收纠正', reverseQty: '0.0000', bookedQty: '5.0000' }),
      'WR-21',
    )
  })

  it('WR-22：下游已使用拦截（对象关系而非整单标记）', () => {
    const clean = {
      batchNo: 'B-1',
      shippedUnitNos: [],
      issuedUnitNos: [],
      inTransitUnitNos: [],
      convertedUnitNos: [],
      effectiveQualifiedDetailNos: [],
    }
    expect(() => assertNotDownstreamConsumed(clean)).not.toThrow()
    expectViolation(() => assertNotDownstreamConsumed({ ...clean, shippedUnitNos: ['U-9'] }), 'WR-22')
    expectViolation(() => assertNotDownstreamConsumed({ ...clean, issuedUnitNos: ['U-9'] }), 'WR-22')
    expectViolation(() => assertNotDownstreamConsumed({ ...clean, inTransitUnitNos: ['U-9'] }), 'WR-22')
    expectViolation(() => assertNotDownstreamConsumed({ ...clean, convertedUnitNos: ['U-9'] }), 'WR-22')
    expectViolation(() => assertNotDownstreamConsumed({ ...clean, effectiveQualifiedDetailNos: ['D-1'] }), 'WR-22')
  })

  it('WR-23：回传重试仅限已退货批次；已同步侧跳过不重做', () => {
    expect(assertReturnSyncRetryable({ batchNo: 'B-1', storageStatus: 'returned', returnSyncStatus: 'failed' })).toEqual({ skipped: false })
    expect(assertReturnSyncRetryable({ batchNo: 'B-1', storageStatus: 'returned', returnSyncStatus: 'synced' })).toEqual({ skipped: true })
    expectViolation(
      () => assertReturnSyncRetryable({ batchNo: 'B-1', storageStatus: 'normal', returnSyncStatus: 'none' }),
      'WR-23',
    )
  })
})

describe('WR-24/25 盘点与差异调整', () => {
  it('WR-24①：盘点锁定拦截动作清单与可解释拒绝', () => {
    expect(STOCKTAKE_INTERCEPTED_ACTIONS).toContain('移库')
    expect(STOCKTAKE_INTERCEPTED_ACTIONS).toContain('调拨出库扫码')
    expect(() =>
      assertNotStocktakeLocked({ warehouseId: 'WH-1', warehouseCode: 'W01', activeStocktakeOrderNo: null, action: '移库' }),
    ).not.toThrow()
    expectViolation(
      () =>
        assertNotStocktakeLocked({
          warehouseId: 'WH-1',
          warehouseCode: 'W01',
          activeStocktakeOrderNo: 'ST-1',
          action: '移库',
        }),
      'WR-24',
    )
  })

  it('WR-24②③：差异调整单原因必填＋去向＋非零差异行', () => {
    const lines = [{ unitId: 'U-1', unitNo: 'U-1', locationId: 'L-1', ownerId: 'O-1', adjustQty: '-2.0000' }]
    expect(() => assertAdjustmentExecutable({ reason: '盘亏', destination: '报损', lines })).not.toThrow()
    expectViolation(() => assertAdjustmentExecutable({ reason: '', destination: '报损', lines }), 'WR-24')
    expectViolation(() => assertAdjustmentExecutable({ reason: '盘亏', destination: ' ', lines }), 'WR-24')
    expectViolation(() => assertAdjustmentExecutable({ reason: '盘亏', destination: '报损', lines: [] }), 'WR-24')
    expectViolation(
      () =>
        assertAdjustmentExecutable({
          reason: '盘亏',
          destination: '报损',
          lines: [{ ...lines[0]!, adjustQty: '0.0000' }],
        }),
      'WR-24',
    )
  })

  it('WR-25：调整基准=实时余额、盘亏不得越实时余额（无负库存）；流水含扣前/扣后', () => {
    expect(() =>
      assertAdjustmentAgainstRealtimeBalance({ unitNo: 'U-1', realtimeQty: '5.0000', adjustQty: '-5.0000' }),
    ).not.toThrow()
    expectViolation(
      () => assertAdjustmentAgainstRealtimeBalance({ unitNo: 'U-1', realtimeQty: '5.0000', adjustQty: '-6.0000' }),
      'WR-25',
    )
    expect(
      buildAdjustmentBalances({ realtimeQty: '5.0000', adjustQty: '-2.0000' }),
    ).toEqual({ beforeQty: '5.0000', afterQty: '3.0000' })
  })
})

describe('WR-26/27/28 所有权三分、载具借还与客户退货边界', () => {
  it('WR-26：所有权变更——空变更拒绝/不得同时变库位/数量须正；位置变更不得移所有权', () => {
    const ok = {
      unitNo: 'U-1',
      fromOwnerId: 'O-1',
      toOwnerId: 'O-2',
      fromLocationId: 'L-1',
      toLocationId: 'L-1',
      quantity: '5.0000',
    }
    expect(() => assertOwnershipTransferExecutable(ok)).not.toThrow()
    expectViolation(() => assertOwnershipTransferExecutable({ ...ok, toOwnerId: 'O-1' }), 'WR-26')
    expectViolation(() => assertOwnershipTransferExecutable({ ...ok, toLocationId: 'L-2' }), 'WR-26')
    expectViolation(() => assertOwnershipTransferExecutable({ ...ok, quantity: '0.0000' }), 'WR-26')
    expect(() =>
      assertOwnershipPreservedOnLocationChange({ unitNo: 'U-1', fromOwnerId: 'O-1', toOwnerId: 'O-1' }),
    ).not.toThrow()
    expectViolation(
      () => assertOwnershipPreservedOnLocationChange({ unitNo: 'U-1', fromOwnerId: 'O-1', toOwnerId: 'O-2' }),
      'WR-26',
    )
  })

  it('WR-27：借还状态轴（借出须对象；回收仅限借出中）；借出/损坏/报废不计入可用；append-only', () => {
    expect(() =>
      assertCarrierLoanEventExecutable({ carrierCode: 'C-1', eventKind: 'lend', currentStatus: 'in_service', counterparty: '客户甲' }),
    ).not.toThrow()
    expectViolation(
      () =>
        assertCarrierLoanEventExecutable({ carrierCode: 'C-1', eventKind: 'lend', currentStatus: 'in_service', counterparty: ' ' }),
      'WR-27',
    )
    expectViolation(
      () => assertCarrierLoanEventExecutable({ carrierCode: 'C-1', eventKind: 'lend', currentStatus: 'lent_out', counterparty: '客户甲' }),
      'WR-27',
    )
    expect(() =>
      assertCarrierLoanEventExecutable({ carrierCode: 'C-1', eventKind: 'take_back', currentStatus: 'lent_out', counterparty: undefined }),
    ).not.toThrow()
    expectViolation(
      () => assertCarrierLoanEventExecutable({ carrierCode: 'C-1', eventKind: 'take_back', currentStatus: 'in_service', counterparty: undefined }),
      'WR-27',
    )
    expect(() =>
      assertCarrierLoanEventExecutable({ carrierCode: 'C-1', eventKind: 'scrap', currentStatus: 'damaged', counterparty: undefined }),
    ).not.toThrow()
    expect(isCarrierAvailableForPlant('in_service')).toBe(true)
    expect(isCarrierAvailableForPlant('returned')).toBe(true)
    expect(isCarrierAvailableForPlant('lent_out')).toBe(false)
    expect(isCarrierAvailableForPlant('damaged')).toBe(false)
    expect(isCarrierAvailableForPlant('scrapped')).toBe(false)
    expect(CARRIER_LOAN_APPEND_ONLY).toBe(true)
  })

  it('WR-28：客户退货载荷键显式拒绝（GAP-F12 裁定前不建客户退货命令）', () => {
    expect(() => assertNotCustomerReturnPayload({ reason: '正常退货' })).not.toThrow()
    expectViolation(() => assertNotCustomerReturnPayload({ customerReturn: true }), 'WR-28')
    expectViolation(() => assertNotCustomerReturnPayload({ salesReturnOrderNo: 'SR-1' }), 'WR-28')
  })
})
