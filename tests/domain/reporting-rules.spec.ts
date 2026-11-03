import { describe, expect, it } from 'vitest'
// domain reporting 面未并入包名入口（L0 整合步统一导出）：测试相对导入源码（同先例）
import {
  AXIS_INBOUND_STATUS_LABELS,
  feetDisplay,
  deriveFinishedEntryStatus,
  matchesFinishedEntryFilter,
  summarizeSelection,
  assertGroupKeyShape,
  ReportingRuleViolation,
  mapAxisInboundStatus,
  mapAxisQcStatus,
  mapAxisSaleStatus,
  mapAxisReportStatus,
  includedInReportStatusFilter,
  mapAxisSuspectStatus,
  mapAxisLockStatus,
  mapAxisFinishedAbnormalStatus,
  matchesCaliber,
  pickCaliberQuantity,
  summarizeReportTotals,
  distinctAxisCount,
  type ReportCaliberRow,
  METRIC_FAMILIES,
  parseFactSetSpec,
  pickEffectiveDefinition,
  resolveSnapshotValue,
  shiftDateOf,
  DEFAULT_METRIC_DEFINITIONS,
} from '../../packages/domain/src/reporting/index'

/**
 * reporting 域纯规则单测（P2-F / T20；逐条对照冻结合同 frozen/p2/reporting.md）。
 * 覆盖：RP-01/03/04/05/08/09/12/16/18/19/21 与字典/汇总/指标框架。
 */

describe('RP-03 英尺数（公共换算规则，截取 4 位不四舍五入）', () => {
  it('米：数量 ÷ 0.3048 截取 4 位（304.8 米 = 1000.0000 英尺）', () => {
    expect(feetDisplay('304.8000', 'M')).toBe('1000.0000')
  })
  it('米：除不尽时截取不进位（100.0000 ÷ 0.3048 = 328.0839…→ 328.0839）', () => {
    // 100/0.3048 = 328.08398950131…→ 截取 328.0839（四舍五入会得 328.0840）
    expect(feetDisplay('100.0000', 'M')).toBe('328.0839')
  })
  it('米：小写 m 与带空格同样判定为米', () => {
    expect(feetDisplay('1.0000', 'm')).toBe('3.2808')
  })
  it('非米（KG）→ null（显示 -，仅展示列不入账）', () => {
    expect(feetDisplay('10.0000', 'KG')).toBeNull()
    expect(feetDisplay('10.0000', null)).toBeNull()
  })
  it('非法数量抛 [RP-03]（不静默吞错）', () => {
    expect(() => feetDisplay('1.23456', 'M')).toThrow(ReportingRuleViolation)
    expect(() => feetDisplay('abc', 'M')).toThrow(ReportingRuleViolation)
  })
})

describe('RP-04 成品入库状态推导与筛选', () => {
  it('正常+仓库 → 成品已入库；正常+线边仓 → 成品未入库；其余为空', () => {
    expect(deriveFinishedEntryStatus('normal', 'WAREHOUSE')).toBe('entered_warehouse')
    expect(deriveFinishedEntryStatus('normal', 'LINE_SIDE')).toBe('not_entered')
    expect(deriveFinishedEntryStatus('frozen', 'WAREHOUSE')).toBeNull()
    expect(deriveFinishedEntryStatus(null, 'WAREHOUSE')).toBeNull()
    expect(deriveFinishedEntryStatus('normal', null)).toBeNull()
  })
  it('筛选语义：已入库筛选只命中 正常+仓库；未入库只命中 正常+线边仓', () => {
    expect(matchesFinishedEntryFilter('entered_warehouse', 'normal', 'WAREHOUSE')).toBe(true)
    expect(matchesFinishedEntryFilter('entered_warehouse', 'normal', 'LINE_SIDE')).toBe(false)
    expect(matchesFinishedEntryFilter('entered_warehouse', 'unqualified', 'WAREHOUSE')).toBe(false)
    expect(matchesFinishedEntryFilter('not_entered', 'normal', 'LINE_SIDE')).toBe(true)
    expect(matchesFinishedEntryFilter('not_entered', 'frozen', 'LINE_SIDE')).toBe(false)
  })
})

describe('RP-05 勾选汇总（服务端全量聚合纯函数）', () => {
  it('按基本单位分组累加 4 位小数；总件数=勾选行数', () => {
    const summary = summarizeSelection([
      { quantity: '10.1234', uomCode: 'M' },
      { quantity: '20.8766', uomCode: 'M' },
      { quantity: '1.5000', uomCode: 'KG' },
    ])
    expect(summary.totalRows).toBe(3)
    expect(summary.groups).toEqual([
      { uomCode: 'KG', uomLabel: 'KG', totalQuantity: '1.5000' },
      { uomCode: 'M', uomLabel: 'M', totalQuantity: '31.0000' },
    ])
  })
  it('无单位行记"未知单位"，与有单位行分列', () => {
    const summary = summarizeSelection([
      { quantity: '5.0000', uomCode: null },
      { quantity: '5.0000', uomCode: '' },
    ])
    expect(summary.groups).toEqual([{ uomCode: null, uomLabel: '未知单位', totalQuantity: '10.0000' }])
  })
  it('未勾选（空集）→ 总量为 0、件数 0', () => {
    expect(summarizeSelection([])).toEqual({ groups: [], totalRows: 0 })
  })
})

describe('RP-01 汇总键形状断言', () => {
  it('采购收货码键缺任一字段抛 [RP-01]', () => {
    const attempt = (): void =>
      assertGroupKeyShape({
        kind: 'purchase_receive',
        unitNo: 'Z-1',
        lotNo: '',
        supplierLotNo: null,
        materialCode: 'MAT',
      })
    try {
      attempt()
      expect.unreachable('应抛 ReportingRuleViolation')
    } catch (error) {
      expect(error).toBeInstanceOf(ReportingRuleViolation)
      expect((error as ReportingRuleViolation).rule).toBe('RP-01')
    }
    expect(() =>
      assertGroupKeyShape({
        kind: 'purchase_receive',
        unitNo: 'Z-1',
        lotNo: 'L1',
        supplierLotNo: 'S1',
        materialCode: '',
      }),
    ).toThrow(ReportingRuleViolation)
  })
  it('生产码键缺订单抛 [RP-01]；工序可空（有则）', () => {
    expect(() => assertGroupKeyShape({ kind: 'production', unitNo: 'Z-1', orderNo: '', operationSeq: null })).toThrow(
      ReportingRuleViolation,
    )
    expect(() => assertGroupKeyShape({ kind: 'production', unitNo: 'Z-1', orderNo: 'MO-1', operationSeq: null })).not.toThrow()
  })
})

describe('RP-08 轴查询字典映射', () => {
  it('入库状态 6 值字典齐全；五状态轴映射', () => {
    expect(Object.keys(AXIS_INBOUND_STATUS_LABELS)).toHaveLength(6)
    expect(mapAxisInboundStatus('in_stock')).toBe('in_stock')
    expect(mapAxisInboundStatus('shipped')).toBe('shipped')
    expect(mapAxisInboundStatus('exhausted')).toBe('shipped')
    expect(mapAxisInboundStatus('in_production')).toBe('not_in')
    expect(mapAxisInboundStatus('in_transit')).toBe('not_in')
    expect(mapAxisInboundStatus(null)).toBe('not_in')
  })
  it('质检状态：免检优先（qc_flag=0），suspect 显示待质检（存疑另列独立展示不混写）', () => {
    expect(mapAxisQcStatus(0, 'unqualified')).toBe('exempt')
    expect(mapAxisQcStatus(1, 'qualified')).toBe('qualified')
    expect(mapAxisQcStatus(1, 'unqualified')).toBe('unqualified')
    expect(mapAxisQcStatus(1, 'suspect')).toBe('pending')
    expect(mapAxisQcStatus(1, 'pending_inspection')).toBe('pending')
    expect(mapAxisQcStatus(null, null)).toBe('pending')
  })
  it('销售/存疑/锁定/成品异常映射', () => {
    expect(mapAxisSaleStatus(true)).toBe('sold')
    expect(mapAxisSaleStatus(false)).toBe('unsold')
    expect(mapAxisSuspectStatus('suspect')).toBe('suspect')
    expect(mapAxisSuspectStatus('qualified')).toBe('normal')
    expect(mapAxisLockStatus(true)).toBe('locked')
    expect(mapAxisFinishedAbnormalStatus(true)).toBe('pending_handle')
    expect(mapAxisFinishedAbnormalStatus(false)).toBe('none')
  })
})

describe('RP-09 采购来源轴不走报工', () => {
  it('采购来源报工状态固定 not_applicable（-）', () => {
    expect(mapAxisReportStatus('purchase', false, false)).toBe('not_applicable')
    expect(mapAxisReportStatus('purchase', true, true)).toBe('not_applicable')
  })
  it('生产来源：全部已提交→已报工；有草稿或无报工→未报工', () => {
    expect(mapAxisReportStatus('production', true, true)).toBe('reported')
    expect(mapAxisReportStatus('production', true, false)).toBe('not_reported')
    expect(mapAxisReportStatus('production', false, false)).toBe('not_reported')
  })
  it('按报工状态筛选时不包含采购来源轴', () => {
    expect(includedInReportStatusFilter('purchase')).toBe(false)
    expect(includedInReportStatusFilter('production')).toBe(true)
    expect(includedInReportStatusFilter(null)).toBe(true)
  })
})

describe('RP-12 Web 汇总行', () => {
  it('按生产单位分别求和 4 位；总轴数=各单不重复轴号之和', () => {
    const totals = summarizeReportTotals([
      [
        { quantity: '100.0000', qualifiedQty: '100.0000', uomCode: 'M', unitNo: 'Z-1' },
        { quantity: '50.0000', qualifiedQty: '40.0000', uomCode: 'M', unitNo: 'Z-1' }, // 同单同轴去重
        { quantity: '3.0000', qualifiedQty: '3.0000', uomCode: 'KG', unitNo: null }, // 无轴不计
      ],
      [
        { quantity: '25.5000', qualifiedQty: '25.5000', uomCode: 'M', unitNo: 'Z-2' },
      ],
    ])
    expect(totals.groups).toEqual([{ uomCode: 'KG', totalQuantity: '3.0000' }, { uomCode: 'M', totalQuantity: '175.5000' }])
    expect(totals.totalAxisCount).toBe(2)
    expect(distinctAxisCount([{ quantity: '1.0000', qualifiedQty: null, uomCode: 'M', unitNo: 'Z-1' }])).toBe(1)
  })
  it('未选（空）→ 显示 0（空组）', () => {
    expect(summarizeReportTotals([])).toEqual({ groups: [], totalAxisCount: 0 })
  })
})

describe('RP-16 口径分层（不混成一个完成量）', () => {
  const draft = { status: 'draft', reviewStatus: 'pending_review', stockUnitBound: false } satisfies ReportCaliberRow
  const submitted = { status: 'submitted', reviewStatus: 'pending_review', stockUnitBound: false } satisfies ReportCaliberRow
  const approved = { status: 'submitted', reviewStatus: 'manual_approved', stockUnitBound: false } satisfies ReportCaliberRow
  const stocked = { status: 'submitted', reviewStatus: 'auto_approved', stockUnitBound: true } satisfies ReportCaliberRow
  const deleted = { status: 'deleted', reviewStatus: 'manual_approved', stockUnitBound: true } satisfies ReportCaliberRow
  it('五口径互不混计；deleted 单不入任何口径', () => {
    expect(matchesCaliber(draft, 'draft')).toBe(true)
    expect(matchesCaliber(draft, 'submitted')).toBe(false)
    expect(matchesCaliber(submitted, 'submitted')).toBe(true)
    expect(matchesCaliber(submitted, 'approved')).toBe(false)
    expect(matchesCaliber(approved, 'approved')).toBe(true)
    expect(matchesCaliber(approved, 'stocked')).toBe(false)
    expect(matchesCaliber(stocked, 'stocked')).toBe(true)
    for (const caliber of ['draft', 'submitted', 'approved', 'qualified', 'stocked'] as const) {
      expect(matchesCaliber(deleted, caliber)).toBe(false)
    }
  })
  it('合格口径取合格数量列，其余取产出数量列', () => {
    expect(pickCaliberQuantity('qualified')).toBe('qualified_qty')
    expect(pickCaliberQuantity('draft')).toBe('quantity')
    expect(pickCaliberQuantity('stocked')).toBe('quantity')
  })
})

describe('RP-18 班次日期（行自带优先，IT-37 折算兜底）', () => {
  it('行自带 shift_date 优先', () => {
    expect(shiftDateOf('2026-10-20T17:30:00+08:00', '2026-10-20')).toBe('2026-10-20')
  })
  it('空列按工厂日历折算（默认零点白班起点/UTC+8：本地 00:30 前不跨日）', () => {
    expect(shiftDateOf('2026-10-20T16:30:00Z', null)).toBe('2026-10-21') // UTC+8 = 10-21 00:30
    expect(shiftDateOf('2026-10-20T18:30:00Z', null)).toBe('2026-10-21') // UTC+8 = 10-21 02:30
  })
})

describe('RP-19 指标定义版本化', () => {
  const defs = [
    { metricKey: 'yield.qualified-rate', version: 1, status: 'active', effectiveFrom: '2026-01-01', effectiveTo: null },
    { metricKey: 'yield.qualified-rate', version: 2, status: 'active', effectiveFrom: '2026-06-01', effectiveTo: null },
    { metricKey: 'loss.rate', version: 1, status: 'retired', effectiveFrom: '2026-01-01', effectiveTo: null },
  ] as const
  it('生效区间内取最高 active 版本', () => {
    expect(pickEffectiveDefinition(defs, '2026-05-15')?.version).toBe(1)
    expect(pickEffectiveDefinition(defs, '2026-06-01')?.version).toBe(2)
  })
  it('区间外/退休版本不入选；全部不满足 → null', () => {
    expect(pickEffectiveDefinition(defs.slice(0, 1), '2025-12-31')).toBeNull()
    expect(pickEffectiveDefinition([defs[2]!], '2026-10-01')).toBeNull()
  })
  it('事实集键校验：未知键抛 [RP-19]', () => {
    expect(parseFactSetSpec({ kind: 'execution.report-output-qty' })).toEqual({ kind: 'execution.report-output-qty' })
    for (const bad of [{ kind: 'unknown.set' }, 'x', null]) {
      try {
        parseFactSetSpec(bad)
        expect.unreachable('应抛 ReportingRuleViolation')
      } catch (error) {
        expect(error).toBeInstanceOf(ReportingRuleViolation)
        expect((error as ReportingRuleViolation).rule).toBe('RP-19')
      }
    }
  })
})

describe('RP-20/RP-21 指标解析（缺失分母保留）', () => {
  it('首期四族框架齐备（wip/delivery/yield/loss 各至少一条默认定义）', () => {
    expect(METRIC_FAMILIES).toEqual(['wip', 'delivery', 'yield', 'loss'])
    for (const family of METRIC_FAMILIES) {
      expect(DEFAULT_METRIC_DEFINITIONS.some((d) => d.family === family)).toBe(true)
    }
  })
  it('单边量指标（无分母事实集）直接输出分子', () => {
    expect(resolveSnapshotValue({ numeratorValue: '12.5000', denominatorValue: null }, 'plain', 'wip.quantity')).toEqual({
      status: 'ok',
      value: '12.5000',
      missingReason: null,
    })
  })
  it('分母为 0/无行 → denominator_missing 保留原因，不以 0 冒充（接口 200 ≠ 数值正确）', () => {
    const r = resolveSnapshotValue({ numeratorValue: '10.0000', denominatorValue: '0.0000' }, 'percent', 'yield.qualified-rate')
    expect(r.status).toBe('denominator_missing')
    expect(r.value).toBeNull()
    expect(r.missingReason).toContain('RP-21')
  })
  it('比率截取 4 位；百分比 ×100', () => {
    const plain = resolveSnapshotValue({ numeratorValue: '1.0000', denominatorValue: '3.0000' }, 'plain', 'k')
    expect(plain.value).toBe('0.3333')
    const percent = resolveSnapshotValue({ numeratorValue: '1.0000', denominatorValue: '3.0000' }, 'percent', 'k')
    expect(percent.value).toBe('33.3300')
  })
})
