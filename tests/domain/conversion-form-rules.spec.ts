import { describe, expect, it } from 'vitest'
// domain conversionform 面未并入包名入口（共享文件 domain/src/index.ts 不改动）：
// 测试直接以相对路径消费 TS 源码（vitest 转译；typecheck:tests 以相对导入纳入编译）。
import {
  ConversionRuleViolation,
  CONVERSION_CARRIER_SECOND_CHARS,
  ORDER_CONVERSION_STATUSES,
  ORDER_QTY_MAX,
  ORDER_QTY_MIN,
  ORDER_SYNC_STATUSES,
  STOCK_INTERNAL_STATUSES,
  STOCK_UNFINISHED_INTERNAL_STATUSES,
  assertCodeRewriteShape,
  assertCompletionScansValid,
  assertConversionCarrierCode,
  assertOrderCompletable,
  assertOrderConversionLines,
  assertOrderMutableForEdit,
  assertOrderScanAdmissible,
  assertOrderSyncRetryable,
  assertScanChoiceNotUsed,
  assertScanChoicePresent,
  assertStockLocalApplyable,
  assertStockPushable,
  assertStockPushResultAcceptable,
  assertStockReconvertable,
  assertStockResyncable,
  assertStockSubmitShape,
  compareDecimal,
  isConversionCarrierCode,
  isStockUnfinished,
  projectStockDisplayStatus,
  type CodeRewriteSpec,
  type OrderConversionLineSpec,
  type OrderScanFacts,
  type StockInternalStatus,
  type StockSubmitInput,
} from '../../packages/domain/src/conversionform/index'

/**
 * T16 conversionform 域纯规则矩阵（冻结合同 form-conversion.md FC-05/06/07/08/09/12/
 * 13/14/15/16/17/18/20 的域断言层；数据库层 FC-S1～S5 与命令编排层证据见
 * tests/integration/conversion-flow.spec.ts 与 tests/api/conversion-api.spec.ts）。
 */

/** 违例断言：抛 ConversionRuleViolation 且 rule 编号命中（命令层再以 [FC-x] 前缀组包）。 */
function expectViolation(fn: () => void, rule: string): void {
  expect(fn).toThrow(ConversionRuleViolation)
  try {
    fn()
  } catch (error) {
    expect((error as ConversionRuleViolation).rule).toBe(rule)
    expect((error as ConversionRuleViolation).message.length).toBeGreaterThan(0)
  }
}

// ---------------- FC-05 建单规则 ----------------

const baseLine = (): OrderConversionLineSpec => ({
  sourceOrderId: 'po-src-1',
  sourceSalesOrderNo: 'SO-2026-001',
  sourceLineNo: '10',
  sourceProjectNo: 'PRJ-A',
  targetOrderId: 'po-tgt-1',
  targetSalesOrderNo: 'SO-2026-002',
  targetProjectNo: 'PRJ-B',
  sourceMaterialId: 'mat-1',
  targetMaterialId: 'mat-1',
  materialCode: 'MAT-CV-FIN',
  quantity: '100.0000',
  uom: 'KG',
})

describe('FC-05 建单明细断言', () => {
  it('空明细 → 至少保留 1 条明细', () => {
    expectViolation(() => assertOrderConversionLines([]), 'FC-05')
  })

  it('缺转换后订单/项目号 → 拒', () => {
    const line = baseLine()
    line.targetOrderId = ' '
    expectViolation(() => assertOrderConversionLines([line]), 'FC-05')
    const line2 = baseLine()
    line2.targetProjectNo = ''
    expectViolation(() => assertOrderConversionLines([line2]), 'FC-05')
  })

  it('转换后订单与转换前为同一订单 → 拒', () => {
    const line = baseLine()
    line.targetOrderId = line.sourceOrderId
    expectViolation(() => assertOrderConversionLines([line]), 'FC-05')
  })

  it('转换后订单与转换前不同料品 → 拒', () => {
    const line = baseLine()
    line.targetMaterialId = 'mat-other'
    expectViolation(() => assertOrderConversionLines([line]), 'FC-05')
  })

  it('同一销售单号＋行号重复加入 → 拒', () => {
    const a = baseLine()
    const b = baseLine()
    b.targetOrderId = 'po-tgt-2'
    expectViolation(() => assertOrderConversionLines([a, b]), 'FC-05')
  })

  it('数量：必填、精度 4 位、范围 0.0001～999999999.9999', () => {
    for (const bad of ['0.0000', '0.00001', '1000000000.0000', 'abc', '']) {
      const line = baseLine()
      line.quantity = bad
      expect(() => assertOrderConversionLines([line]), `quantity=${bad}`).toThrow(ConversionRuleViolation)
    }
    for (const ok of ['0.0001', '999999999.9999', '1', '1.5']) {
      const line = baseLine()
      line.quantity = ok
      expect(() => assertOrderConversionLines([line]), `quantity=${ok}`).not.toThrow()
    }
    expect(compareDecimal(ORDER_QTY_MIN, '0.0001')).toBe(0)
    expect(compareDecimal(ORDER_QTY_MAX, '999999999.9999')).toBe(0)
  })

  it('合法多行（不同销售单号＋行号、同料品、不同订单）→ 通过', () => {
    const a = baseLine()
    const b = baseLine()
    b.sourceLineNo = '20'
    b.targetOrderId = 'po-tgt-2'
    expect(() => assertOrderConversionLines([a, b])).not.toThrow()
  })
})

// ---------------- FC-07 PDA 扫码 ----------------

describe('FC-07 载具码类型位 E/F/M/P（不含 R）', () => {
  it('10 位且第 2 位 ∈ E/F/M/P 可扫；R/其它/长度≠10 拒', () => {
    expect(isConversionCarrierCode('1E12345678')).toBe(true)
    expect(isConversionCarrierCode('1F12345678')).toBe(true)
    expect(isConversionCarrierCode('1M12345678')).toBe(true)
    expect(isConversionCarrierCode('1P12345678')).toBe(true)
    expect(isConversionCarrierCode('1R12345678')).toBe(false)
    expect(isConversionCarrierCode('1G12345678')).toBe(false)
    expect(isConversionCarrierCode('1E1234567')).toBe(false)
    expect(isConversionCarrierCode('1E123456789')).toBe(false)
    expect([...CONVERSION_CARRIER_SECOND_CHARS]).not.toContain('R')
    expectViolation(() => assertConversionCarrierCode('1R12345678'), 'FC-07')
    expect(() => assertConversionCarrierCode('1E12345678')).not.toThrow()
  })
})

describe('FC-07 扫码选择项（段长或客户轴号至少一）', () => {
  it('两项全空 → 拒；任一项有效 → 通过', () => {
    expectViolation(
      () => assertScanChoicePresent({ unitNo: '1E12345678', segmentLength: null, customerAxisNo: null }),
      'FC-07',
    )
    expectViolation(
      () => assertScanChoicePresent({ unitNo: '1E12345678', segmentLength: '0.0000', customerAxisNo: ' ' }),
      'FC-07',
    )
    expect(() => assertScanChoicePresent({ unitNo: '1E12345678', segmentLength: '12.5000', customerAxisNo: null })).not.toThrow()
    expect(() => assertScanChoicePresent({ unitNo: '1E12345678', segmentLength: null, customerAxisNo: 'CAX-01' })).not.toThrow()
  })

  it('已用段长/客户轴号不可再选', () => {
    expectViolation(
      () =>
        assertScanChoiceNotUsed({
          unitNo: '1E12345678',
          segmentLength: '12.5000',
          customerAxisNo: null,
          usedSegmentLengths: new Set(['12.5000']),
          usedCustomerAxisNos: new Set(),
        }),
      'FC-07',
    )
    expectViolation(
      () =>
        assertScanChoiceNotUsed({
          unitNo: '1E12345678',
          segmentLength: null,
          customerAxisNo: 'CAX-01',
          usedSegmentLengths: new Set(),
          usedCustomerAxisNos: new Set(['CAX-01']),
        }),
      'FC-07',
    )
    expect(() =>
      assertScanChoiceNotUsed({
        unitNo: '1E12345678',
        segmentLength: '13.0000',
        customerAxisNo: 'CAX-02',
        usedSegmentLengths: new Set(['12.5000']),
        usedCustomerAxisNos: new Set(['CAX-01']),
      }),
    ).not.toThrow()
  })
})

describe('FC-07/FC-20 扫码准入（归属/在库/余额/锁定/跨协议占用）', () => {
  const admissible = (): OrderScanFacts => ({
    unitNo: '1E12345678',
    unitStatus: 'in_stock',
    balanceExists: true,
    unitOwnerOrderId: 'po-src-1',
    sourceOrderId: 'po-src-1',
    lockedByOther: false,
    occupiedByStockConversion: false,
    alreadyScannedInOrder: false,
  })

  it('全部满足 → 通过', () => {
    expect(() => assertOrderScanAdmissible(admissible())).not.toThrow()
  })

  it('同码本单未删重复扫 → FC-07', () => {
    const facts = admissible()
    facts.alreadyScannedInOrder = true
    expectViolation(() => assertOrderScanAdmissible(facts), 'FC-07')
  })

  it('不在库 → FC-07', () => {
    const facts = admissible()
    facts.unitStatus = 'shipped'
    expectViolation(() => assertOrderScanAdmissible(facts), 'FC-07')
  })

  it('无活动余额 → FC-07', () => {
    const facts = admissible()
    facts.balanceExists = false
    expectViolation(() => assertOrderScanAdmissible(facts), 'FC-07')
  })

  it('码不属于转换前订单库存 → FC-07（失败不入库）', () => {
    const facts = admissible()
    facts.unitOwnerOrderId = 'po-other'
    expectViolation(() => assertOrderScanAdmissible(facts), 'FC-07')
    const none = admissible()
    none.unitOwnerOrderId = null
    expectViolation(() => assertOrderScanAdmissible(none), 'FC-07')
  })

  it('被其它业务锁定 → FC-07', () => {
    const facts = admissible()
    facts.lockedByOther = true
    expectViolation(() => assertOrderScanAdmissible(facts), 'FC-07')
  })

  it('存在未转换成功库存转换单占用 → FC-20（后提交方冲突拒绝）', () => {
    const facts = admissible()
    facts.occupiedByStockConversion = true
    expectViolation(() => assertOrderScanAdmissible(facts), 'FC-20')
  })
})

// ---------------- FC-06 编辑/删除门 ----------------

describe('FC-06 编辑/删除门（仅待转换且尚无扫码）', () => {
  it('已完成 → 编辑/删除均拒', () => {
    expectViolation(
      () => assertOrderMutableForEdit({ status: 'completed', activeScanCount: 0, action: 'edit' }),
      'FC-06',
    )
    expectViolation(
      () => assertOrderMutableForEdit({ status: 'completed', activeScanCount: 0, action: 'delete' }),
      'FC-06',
    )
  })

  it('待转换但已有扫码 → 编辑/删除均拒', () => {
    expectViolation(
      () => assertOrderMutableForEdit({ status: 'pending', activeScanCount: 1, action: 'edit' }),
      'FC-06',
    )
    expectViolation(
      () => assertOrderMutableForEdit({ status: 'pending', activeScanCount: 1, action: 'delete' }),
      'FC-06',
    )
  })

  it('待转换且无扫码 → 编辑/删除均通过', () => {
    expect(() => assertOrderMutableForEdit({ status: 'pending', activeScanCount: 0, action: 'edit' })).not.toThrow()
    expect(() => assertOrderMutableForEdit({ status: 'pending', activeScanCount: 0, action: 'delete' })).not.toThrow()
  })
})

// ---------------- FC-08 完成转换 ----------------

describe('FC-08 完成转换门与完成前扫码复核', () => {
  it('非待转换 → 拒；明细已扫轴数为 0 → 拒；全部 > 0 → 通过', () => {
    expectViolation(
      () => assertOrderCompletable({ status: 'completed', lines: [{ lineId: 'l1', scannedAxes: 1 }] }),
      'FC-08',
    )
    expectViolation(
      () => assertOrderCompletable({ status: 'pending', lines: [{ lineId: 'l1', scannedAxes: 1 }, { lineId: 'l2', scannedAxes: 0 }] }),
      'FC-08',
    )
    expect(() => assertOrderCompletable({ status: 'pending', lines: [{ lineId: 'l1', scannedAxes: 2 }] })).not.toThrow()
  })

  it('完成前扫码复核：实扫数量非法/选择项缺失 → 失败、状态不变', () => {
    expectViolation(
      () => assertCompletionScansValid([{ unitNo: '1E12345678', quantity: '0.0000', segmentLength: '1.0000', customerAxisNo: null }]),
      'FC-08',
    )
    expectViolation(
      () => assertCompletionScansValid([{ unitNo: '1E12345678', quantity: '1.0000', segmentLength: null, customerAxisNo: null }]),
      'FC-08',
    )
    expect(() =>
      assertCompletionScansValid([{ unitNo: '1E12345678', quantity: '1.0000', segmentLength: null, customerAxisNo: 'CAX-01' }]),
    ).not.toThrow()
  })
})

// ---------------- FC-09/FC-12 重试与状态字典 ----------------

describe('FC-09 重试门（仅已完成且同步失败）', () => {
  it('待转换 → 拒；已完成未同步 → 拒；已完成已同步 → 拒；已完成同步失败 → 通过', () => {
    expectViolation(() => assertOrderSyncRetryable({ status: 'pending', syncStatus: 'sync_failed' }), 'FC-09')
    expectViolation(() => assertOrderSyncRetryable({ status: 'completed', syncStatus: 'pending' }), 'FC-09')
    expectViolation(() => assertOrderSyncRetryable({ status: 'completed', syncStatus: 'synced' }), 'FC-09')
    expect(() => assertOrderSyncRetryable({ status: 'completed', syncStatus: 'sync_failed' })).not.toThrow()
  })
})

describe('FC-12 状态字典分列（转换 2 值 / 同步 3 值）', () => {
  it('两字典独立、不合并为单一状态', () => {
    expect([...ORDER_CONVERSION_STATUSES]).toEqual(['pending', 'completed'])
    expect([...ORDER_SYNC_STATUSES]).toEqual(['pending', 'sync_failed', 'synced'])
    expect(ORDER_CONVERSION_STATUSES).not.toEqual(ORDER_SYNC_STATUSES)
  })
})

// ---------------- FC-13/FC-14/FC-15 链路步进门与六态投影 ----------------

describe('FC-14 内部六态 → 对外三态投影（DM §7.2）', () => {
  it('六态字典完备且含待执行/外部处理中/本地处理中/完成/待恢复/人工处理', () => {
    expect([...STOCK_INTERNAL_STATUSES]).toHaveLength(6)
    for (const s of ['pending_execute', 'external_processing', 'local_processing', 'completed', 'pending_recovery', 'manual_processing']) {
      expect([...STOCK_INTERNAL_STATUSES]).toContain(s)
    }
  })

  it('未完成集 = 六态减 completed', () => {
    expect(STOCK_UNFINISHED_INTERNAL_STATUSES).toHaveLength(5)
    expect(isStockUnfinished('completed')).toBe(false)
    expect(isStockUnfinished('pending_recovery')).toBe(true)
  })

  it('投影：完成→转换成功；U9 已成功未完成→同步失败；其余→转换失败', () => {
    expect(projectStockDisplayStatus('completed', true)).toBe('convert_success')
    expect(projectStockDisplayStatus('completed', false)).toBe('convert_success')
    expect(projectStockDisplayStatus('local_processing', true)).toBe('sync_failed')
    expect(projectStockDisplayStatus('pending_recovery', true)).toBe('sync_failed')
    expect(projectStockDisplayStatus('pending_execute', false)).toBe('convert_failed')
    expect(projectStockDisplayStatus('external_processing', false)).toBe('convert_failed')
    expect(projectStockDisplayStatus('pending_recovery', false)).toBe('convert_failed')
    expect(projectStockDisplayStatus('manual_processing', false)).toBe('convert_failed')
  })
})

describe('FC-13② 派发门：仅待执行可派发（已派发不盲重发）', () => {
  it('pending_execute 通过；其余内部态拒', () => {
    expect(() => assertStockPushable({ internalStatus: 'pending_execute' })).not.toThrow()
    const others: StockInternalStatus[] = ['external_processing', 'local_processing', 'completed', 'pending_recovery', 'manual_processing']
    for (const s of others) {
      expect(() => assertStockPushable({ internalStatus: s }), s).toThrow(ConversionRuleViolation)
    }
  })
})

describe('FC-03 外部结果回填门（外部处理中/人工处理）', () => {
  it('external_processing 与 manual_processing 通过；其余拒', () => {
    expect(() => assertStockPushResultAcceptable({ internalStatus: 'external_processing' })).not.toThrow()
    expect(() => assertStockPushResultAcceptable({ internalStatus: 'manual_processing' })).not.toThrow()
    const others: StockInternalStatus[] = ['pending_execute', 'local_processing', 'completed', 'pending_recovery']
    for (const s of others) {
      expect(() => assertStockPushResultAcceptable({ internalStatus: s }), s).toThrow(ConversionRuleViolation)
    }
  })
})

describe('FC-15 本地应用/重新转换/重新同步门', () => {
  it('本地应用：U9 未成功拒；本地处理中/待恢复+U9 成功通过；完成拒', () => {
    expectViolation(
      () => assertStockLocalApplyable({ internalStatus: 'local_processing', u9Success: false }),
      'FC-15',
    )
    expect(() => assertStockLocalApplyable({ internalStatus: 'local_processing', u9Success: true })).not.toThrow()
    expect(() => assertStockLocalApplyable({ internalStatus: 'pending_recovery', u9Success: true })).not.toThrow()
    expectViolation(
      () => assertStockLocalApplyable({ internalStatus: 'completed', u9Success: true }),
      'FC-15',
    )
  })

  it('重新转换：U9 已成功拒（外部成功步骤不重做）；仅待执行/待恢复+U9 未成功通过；处理中/未知拒（不换键盲发）', () => {
    expectViolation(
      () => assertStockReconvertable({ internalStatus: 'pending_recovery', u9Success: true }),
      'FC-15',
    )
    expect(() => assertStockReconvertable({ internalStatus: 'pending_recovery', u9Success: false })).not.toThrow()
    expect(() => assertStockReconvertable({ internalStatus: 'pending_execute', u9Success: false })).not.toThrow()
    expectViolation(
      () => assertStockReconvertable({ internalStatus: 'external_processing', u9Success: false }),
      'FC-15',
    )
    expectViolation(
      () => assertStockReconvertable({ internalStatus: 'manual_processing', u9Success: false }),
      'FC-15',
    )
  })

  it('重新同步：U9 未成功拒（走重新转换）；完成拒；本地已应用拒；本地处理中/待恢复+未应用通过', () => {
    expectViolation(
      () => assertStockResyncable({ internalStatus: 'local_processing', u9Success: false, localApplyStatus: 'not_applied' }),
      'FC-15',
    )
    expectViolation(
      () => assertStockResyncable({ internalStatus: 'completed', u9Success: true, localApplyStatus: 'applied' }),
      'FC-15',
    )
    expectViolation(
      () => assertStockResyncable({ internalStatus: 'local_processing', u9Success: true, localApplyStatus: 'applied' }),
      'FC-15',
    )
    expect(() =>
      assertStockResyncable({ internalStatus: 'local_processing', u9Success: true, localApplyStatus: 'not_applied' }),
    ).not.toThrow()
    expect(() =>
      assertStockResyncable({ internalStatus: 'pending_recovery', u9Success: true, localApplyStatus: 'failed' }),
    ).not.toThrow()
  })
})

// ---------------- FC-16 MES 改码形状 ----------------

describe('FC-16 改码形状（不改项目号、清空虚拟轴号）', () => {
  const shape = (): CodeRewriteSpec => ({
    unitNo: '1E12345678',
    oldSalesOrderNo: 'SO-OLD',
    oldLineNo: '10',
    oldBatchNo: 'LOT-OLD',
    oldVirtualAxisNo: 'V-001',
    newSalesOrderNo: 'SO-NEW',
    newLineNo: '20',
    newBatchNo: 'B-NEW',
    newSegmentLength: '12.5000',
    newCustomerAxisNo: 'CAX-01',
    clearVirtualAxis: true,
  })

  it('载荷含转换后项目号 → 拒（项目号只记单据、不回写码）', () => {
    const spec = shape()
    spec.targetProjectNo = 'PRJ-B'
    expectViolation(() => assertCodeRewriteShape(spec), 'FC-16')
  })

  it('改码后销售单号/行号/批次号缺一 → 拒', () => {
    const spec = shape()
    spec.newBatchNo = ''
    expectViolation(() => assertCodeRewriteShape(spec), 'FC-16')
  })

  it('段长非正十进制定点 → 拒', () => {
    const spec = shape()
    spec.newSegmentLength = '0.0000'
    expectViolation(() => assertCodeRewriteShape(spec), 'FC-16')
  })

  it('原有虚拟轴号未置清空 → 拒；置位后通过', () => {
    const spec = shape()
    spec.clearVirtualAxis = false
    expectViolation(() => assertCodeRewriteShape(spec), 'FC-16')
    const ok = shape()
    ok.oldVirtualAxisNo = null
    ok.clearVirtualAxis = false
    expect(() => assertCodeRewriteShape(ok)).not.toThrow()
  })
})

// ---------------- FC-17/FC-18/FC-20 提交前校验 ----------------

describe('FC-17/18/20 库存转换提交形状', () => {
  const input = (): StockSubmitInput => ({
    materialCode: 'MAT-CV-FIN',
    materialType: 3,
    materialStockQty: '200.0000',
    targetProjectNo: 'PRJ-B',
    targetSalesOrderNo: 'SO-NEW',
    targetLineNo: '20',
    targetBatchNo: 'B-NEW',
    lines: [
      {
        unitNo: '1E12345678',
        segmentLength: '12.5000',
        customerAxisNo: null,
        quantity: '100.0000',
        materialId: 'mat-1',
        lockedByOther: false,
        occupiedUnfinished: false,
      },
    ],
  })

  it('全部满足 → 通过', () => {
    expect(() => assertStockSubmitShape(input())).not.toThrow()
  })

  it('FC-17：料品非成品 → 拒；成品当前库存 ≤ 0 → 拒', () => {
    const a = input()
    a.materialType = 1
    expectViolation(() => assertStockSubmitShape(a), 'FC-17')
    const b = input()
    b.materialStockQty = '0.0000'
    expectViolation(() => assertStockSubmitShape(b), 'FC-17')
  })

  it('FC-18：右侧空清单 → 拒；销售单号/行号/批次号必填 → 拒；超 50 字符 → 拒', () => {
    const empty = input()
    empty.lines = []
    expectViolation(() => assertStockSubmitShape(empty), 'FC-18')
    const noSo = input()
    noSo.targetSalesOrderNo = ''
    expectViolation(() => assertStockSubmitShape(noSo), 'FC-18')
    const noBatch = input()
    noBatch.targetBatchNo = ' '
    expectViolation(() => assertStockSubmitShape(noBatch), 'FC-18')
    const long = input()
    long.targetProjectNo = 'P'.repeat(51)
    expectViolation(() => assertStockSubmitShape(long), 'FC-18')
  })

  it('FC-18：同一二维码重复加入本单 → 拒；段长必填且 ≥ 0.0001 → 拒', () => {
    const dup = input()
    dup.lines = [input().lines[0]!, { ...input().lines[0]!, segmentLength: '13.0000' }]
    expectViolation(() => assertStockSubmitShape(dup), 'FC-18')
    const seg = input()
    seg.lines[0]!.segmentLength = '0.0000'
    expectViolation(() => assertStockSubmitShape(seg), 'FC-18')
  })

  it('FC-18/FC-20：锁定中的码不可转换（FC-20）；未转换成功单据占用不可再添加（FC-18）', () => {
    const locked = input()
    locked.lines[0]!.lockedByOther = true
    expectViolation(() => assertStockSubmitShape(locked), 'FC-20')
    const occupied = input()
    occupied.lines[0]!.occupiedUnfinished = true
    expectViolation(() => assertStockSubmitShape(occupied), 'FC-18')
  })

  it('FC-18：客户轴号非必填（可空）', () => {
    const ok = input()
    ok.lines[0]!.customerAxisNo = null
    expect(() => assertStockSubmitShape(ok)).not.toThrow()
  })
})
