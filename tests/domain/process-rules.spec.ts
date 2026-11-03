import { describe, expect, it } from 'vitest'
import {
  ProcessRuleViolation,
  assertCoreMultiple,
  assertErpCloseDoesNotCloseExecution,
  assertNoExistingPublishedVersion,
  assertOfflineQty,
  assertOperationDefinitionLockedFieldsEditable,
  assertOperationDefinitionRetirable,
  assertOperationNameNoEdgeSpaces,
  assertOperationStructureChangeAllowed,
  assertOrderQty,
  assertOrderResumable,
  assertOrderStartable,
  assertOrderSuspendable,
  assertOrderTransition,
  assertOrderVoidable,
  assertRevisionContentMutable,
  assertRevisionPublishable,
  assertRevisionRetirable,
  assertStrandFactor,
  computeOperationRequirements,
  findOperationDefinitionConflict,
  isErpClosed,
  isExecutionClosed,
  mulProcessQty,
  nextRevisionVersion,
  planOperationSettingsChange,
  PROCESS_PERMISSIONS,
} from '../../packages/domain/src/process/index'

/**
 * process 域纯规则单测 —— 规则来源为底稿 03-production-chain-rules-T05T09T10T11.md
 * A1/A2 节（逐条标注 [底稿 A1-x]/[底稿 A2-x]/[合同新造]）。
 */

function violationOf(fn: () => unknown): ProcessRuleViolation | null {
  try {
    fn()
    return null
  } catch (error) {
    if (error instanceof ProcessRuleViolation) return error
    throw error
  }
}

describe('A2-1 工序需求推导（[底稿 A2]）', () => {
  it('样例可复算：末道下线数量 = 订单产量 × 芯倍数 × 绞合 = 1000m × 3 × 1.02 = 3060m', () => {
    const results = computeOperationRequirements({
      orderQty: '1000',
      operations: [
        { seq: 1, coreMultiple: 3, strandFactor: '1.02', currentOfflineQty: '1000' },
      ],
    })
    expect(results).toEqual([{ seq: 1, offlineQty: '3060.0000', kept: false }])
  })

  it('非末道自末道向上递推：末道 1000×2×1.5=3000；前道 3000×3×1=9000', () => {
    const results = computeOperationRequirements({
      orderQty: '1000',
      operations: [
        { seq: 1, coreMultiple: 3, strandFactor: '1', currentOfflineQty: '1000' },
        { seq: 2, coreMultiple: 2, strandFactor: '1.5', currentOfflineQty: '1000' },
      ],
    })
    expect(results[0]).toEqual({ seq: 1, offlineQty: '9000.0000', kept: false })
    expect(results[1]).toEqual({ seq: 2, offlineQty: '3000.0000', kept: false })
  })

  it('绞合未填该行跳过重算（保留现有下线数量），其上游以保留值为下游量递推', () => {
    const results = computeOperationRequirements({
      orderQty: '1000',
      operations: [
        { seq: 1, coreMultiple: 2, strandFactor: '1', currentOfflineQty: '1000' }, // 前道
        { seq: 2, coreMultiple: 1, strandFactor: null, currentOfflineQty: '777' }, // 末道绞合未填
      ],
    })
    // 末道保留 777；前道 = 777 × 2 × 1 = 1554
    expect(results[1]).toEqual({ seq: 2, offlineQty: '777.0000', kept: true })
    expect(results[0]).toEqual({ seq: 1, offlineQty: '1554.0000', kept: false })
  })

  it('冻结行（已执行实绩，A2-4）保留原值不参与重算，上游以冻结值递推', () => {
    const results = computeOperationRequirements({
      orderQty: '1000',
      operations: [
        { seq: 1, coreMultiple: 2, strandFactor: '1', currentOfflineQty: '1000' },
        { seq: 2, coreMultiple: 2, strandFactor: '1.02', currentOfflineQty: '500', frozen: true },
      ],
    })
    expect(results[1]).toEqual({ seq: 2, offlineQty: '500.0000', kept: true })
    expect(results[0]).toEqual({ seq: 1, offlineQty: '1000.0000', kept: false })
  })

  it('系数校验：芯倍数须正整数；绞合须为空或正的 ≤4 位小数；下线数量非负；订单产量 > 0', () => {
    expect(violationOf(() => assertCoreMultiple(0, '工序 1'))?.rule).toBe('A2-1')
    expect(violationOf(() => assertCoreMultiple(1.5, '工序 1'))?.rule).toBe('A2-1')
    expect(violationOf(() => assertStrandFactor('0', '工序 1'))?.rule).toBe('A2-1')
    expect(violationOf(() => assertStrandFactor('-1.02', '工序 1'))?.rule).toBe('A2-1')
    expect(violationOf(() => assertStrandFactor('1.02005', '工序 1'))?.rule).toBe('A2-1')
    expect(() => assertStrandFactor(null, '工序 1')).not.toThrow()
    expect(violationOf(() => assertOfflineQty('-1', '工序 1'))?.rule).toBe('A2-1')
    expect(violationOf(() => assertOrderQty('0', '订单'))?.rule).toBe('A2-1')
  })

  it('乘法半入到 4 位小数（1.1111×1.1111=1.23454321 → 1.2345 舍去；1.0001×1.5=1.50015 → 1.5002 半入）；损耗无参数位（A2 结构口径）', () => {
    expect(mulProcessQty('1.1111', '1.1111', '测试')).toBe('1.2345')
    expect(mulProcessQty('1.0001', '1.5', '测试')).toBe('1.5002')
    // 公式输入形状只有 产量/芯倍数/绞合（无损耗位），见 computeOperationRequirements 签名
    expect(computeOperationRequirements({
      orderQty: '100',
      operations: [{ seq: 1, coreMultiple: 1, strandFactor: '1.0001', currentOfflineQty: '100' }],
    })).toEqual([{ seq: 1, offlineQty: '100.0100', kept: false }])
  })

  it('工序顺序须 ≥1 且严格递增；空工序返回空', () => {
    expect(computeOperationRequirements({ orderQty: '10', operations: [] })).toEqual([])
    const v = violationOf(() =>
      computeOperationRequirements({
        orderQty: '10',
        operations: [
          { seq: 2, coreMultiple: 1, strandFactor: null, currentOfflineQty: '10' },
          { seq: 2, coreMultiple: 1, strandFactor: null, currentOfflineQty: '10' },
        ],
      }),
    )
    expect(v?.rule).toBe('A2-1')
  })
})

describe('A2-2 版本冻结（[底稿 A2]）', () => {
  it('published 后内容不可改（PATCH 拒绝）；retired 为终态', () => {
    expect(violationOf(() => assertRevisionContentMutable('published'))?.rule).toBe('A2-2')
    expect(violationOf(() => assertRevisionContentMutable('retired'))?.rule).toBe('A2-2')
    expect(() => assertRevisionContentMutable('draft')).not.toThrow()
    expect(() => assertRevisionContentMutable('reviewed')).not.toThrow()
  })

  it('发布前置：draft/reviewed 可发布；published 重复发布拒绝；retired 拒绝', () => {
    expect(() => assertRevisionPublishable('draft')).not.toThrow()
    expect(() => assertRevisionPublishable('reviewed')).not.toThrow()
    expect(violationOf(() => assertRevisionPublishable('published'))?.rule).toBe('A2-2')
    expect(violationOf(() => assertRevisionPublishable('retired'))?.rule).toBe('A2-2')
  })

  it('失效前置：retired 不可重复失效；同对象至多一条 published', () => {
    expect(() => assertRevisionRetirable('published')).not.toThrow()
    expect(violationOf(() => assertRevisionRetirable('retired'))?.rule).toBe('A2-2')
    expect(violationOf(() => assertNoExistingPublishedVersion({ publishedExists: true }))?.rule).toBe('A2-2')
    expect(() => assertNoExistingPublishedVersion({ publishedExists: false })).not.toThrow()
  })

  it('下一版本号 = 最大版本 + 1', () => {
    expect(nextRevisionVersion([])).toBe(1)
    expect(nextRevisionVersion([1, 3, 2])).toBe(4)
  })
})

describe('A1-1 订单状态轴与开工前置（[底稿 A1] + DM §5 合同新造）', () => {
  it('开工前置全部满足才可开工', () => {
    expect(() =>
      assertOrderStartable({
        orderStatus: 'released',
        processConfigStatus: 'configured',
        operationCount: 2,
        processConfirmedAt: '2026-10-27T08:00:00Z',
        suspended: false,
        actualStartAt: '2026-10-27T09:00:00Z',
      }),
    ).not.toThrow()
  })

  it('任一前置缺失即拒绝（状态/挂起/未配置/无工序行/未确认/无时间/非法时间）', () => {
    const base = {
      orderStatus: 'released' as const,
      processConfigStatus: 'configured' as const,
      operationCount: 2,
      processConfirmedAt: '2026-10-27T08:00:00Z',
      suspended: false,
      actualStartAt: '2026-10-27T09:00:00Z',
    }
    expect(violationOf(() => assertOrderStartable({ ...base, orderStatus: 'approved' }))?.rule).toBe('A1-1')
    expect(violationOf(() => assertOrderStartable({ ...base, orderStatus: 'in_progress' }))?.rule).toBe('A1-1')
    expect(violationOf(() => assertOrderStartable({ ...base, orderStatus: 'voided' }))?.rule).toBe('A1-1')
    expect(violationOf(() => assertOrderStartable({ ...base, suspended: true }))?.rule).toBe('A1-1')
    expect(violationOf(() => assertOrderStartable({ ...base, processConfigStatus: 'unconfigured' }))?.rule).toBe('A1-1')
    expect(violationOf(() => assertOrderStartable({ ...base, operationCount: 0 }))?.rule).toBe('A1-1')
    expect(violationOf(() => assertOrderStartable({ ...base, processConfirmedAt: null }))?.rule).toBe('A1-1')
    expect(violationOf(() => assertOrderStartable({ ...base, actualStartAt: null }))?.rule).toBe('A1-1')
    expect(violationOf(() => assertOrderStartable({ ...base, actualStartAt: 'not-a-date' }))?.rule).toBe('A1-1')
  })

  it('状态轴只允许顺次迁移；作废独立；closed/voided 终态', () => {
    expect(() => assertOrderTransition('approved', 'released')).not.toThrow()
    expect(() => assertOrderTransition('released', 'in_progress')).not.toThrow()
    expect(() => assertOrderTransition('in_progress', 'pending_completion')).not.toThrow()
    expect(() => assertOrderTransition('pending_completion', 'closed')).not.toThrow()
    expect(() => assertOrderTransition('approved', 'voided')).not.toThrow()
    expect(() => assertOrderTransition('in_progress', 'voided')).not.toThrow()
    expect(violationOf(() => assertOrderTransition('approved', 'in_progress'))?.rule).toBe('NEW-1')
    expect(violationOf(() => assertOrderTransition('closed', 'released'))?.rule).toBe('NEW-1')
    expect(violationOf(() => assertOrderTransition('voided', 'released'))?.rule).toBe('NEW-1')
    expect(violationOf(() => assertOrderTransition('released', 'released'))?.rule).toBe('NEW-1')
  })

  it('挂起/解除挂起/作废前置（挂起与作废独立处理）', () => {
    expect(() => assertOrderSuspendable({ orderStatus: 'released', suspended: false })).not.toThrow()
    expect(violationOf(() => assertOrderSuspendable({ orderStatus: 'released', suspended: true }))?.rule).toBe('NEW-1')
    expect(violationOf(() => assertOrderSuspendable({ orderStatus: 'voided', suspended: false }))?.rule).toBe('NEW-1')
    expect(violationOf(() => assertOrderSuspendable({ orderStatus: 'closed', suspended: false }))?.rule).toBe('NEW-1')
    expect(() => assertOrderResumable({ suspended: true })).not.toThrow()
    expect(violationOf(() => assertOrderResumable({ suspended: false }))?.rule).toBe('NEW-1')
    expect(() => assertOrderVoidable({ orderStatus: 'in_progress' })).not.toThrow()
    expect(violationOf(() => assertOrderVoidable({ orderStatus: 'voided' }))?.rule).toBe('NEW-1')
    expect(violationOf(() => assertOrderVoidable({ orderStatus: 'closed' }))?.rule).toBe('NEW-1')
  })

  it('ERP 商业关闭与 MOM 执行完成分离（DM §5 合同新造）：两口径独立判定互不推导', () => {
    expect(isExecutionClosed({ businessClosedAt: null })).toBe(false)
    expect(isExecutionClosed({ businessClosedAt: '2026-10-27T10:00:00Z' })).toBe(true)
    expect(isErpClosed({ erpClosedAt: null })).toBe(false)
    // ERP 已商业关闭而执行未完成：合法形态（分离口径），不视为冲突
    expect(() =>
      assertErpCloseDoesNotCloseExecution({
        erpClosedAt: '2026-10-27T10:00:00Z',
        businessClosedAt: null,
      }),
    ).not.toThrow()
  })
})

describe('A1-2/A2-4 工序设置变更锁与变更版本（[底稿 A1-2 / S04 裁定]）', () => {
  it('已有报工：新增/删除/调序/改名被锁（A1-2）；无报工放行', () => {
    for (const change of ['add', 'remove', 'reorder', 'rename'] as const) {
      const v = violationOf(() => assertOperationStructureChangeAllowed({ hasWorkReports: true, change }))
      expect(v?.rule).toBe('A1-2')
      expect(v?.message).toContain('已有报工')
    }
    expect(() =>
      assertOperationStructureChangeAllowed({ hasWorkReports: false, change: 'add' }),
    ).not.toThrow()
  })

  it('变更版本计划：改系数 → 新版本只调未执行任务，已执行行保留原版本与原值（A2-4）', () => {
    const plan = planOperationSettingsChange({
      orderQty: '1000',
      currentSettingsVersion: 1,
      operations: [
        { seq: 1, operationDefinitionId: 'op-1', operationName: '拉丝', coreMultiple: 2, strandFactor: '1', offlineQty: '2000', executed: false },
        { seq: 2, operationDefinitionId: 'op-2', operationName: '绞线', coreMultiple: 2, strandFactor: '1.5', offlineQty: '3000', executed: true },
      ],
      updates: [{ seq: 1, coreMultiple: 3 }],
    })
    expect(plan.nextSettingsVersion).toBe(2)
    // 末道已执行：保留 v1 与原值 3000（实绩绑定原版本）
    expect(plan.rows[1]).toMatchObject({ seq: 2, settingsVersion: 1, offlineQty: '3000.0000', executed: true })
    // 前道未执行：进 v2，按新芯倍数重算 = 3000 × 3 × 1 = 9000
    expect(plan.rows[0]).toMatchObject({ seq: 1, settingsVersion: 2, coreMultiple: 3, offlineQty: '9000.0000', executed: false, recomputed: true })
  })

  it('变更载荷命中不存在的工序行或改已执行行系数 → 拒绝（A2-4）', () => {
    const base = {
      orderQty: '1000' as const,
      currentSettingsVersion: 1,
      operations: [
        { seq: 1, operationDefinitionId: 'op-1', operationName: '拉丝', coreMultiple: 1, strandFactor: null, offlineQty: '1000', executed: false },
        { seq: 2, operationDefinitionId: 'op-2', operationName: '绞线', coreMultiple: 1, strandFactor: null, offlineQty: '1000', executed: true },
      ],
    }
    expect(violationOf(() =>
      planOperationSettingsChange({ ...base, updates: [{ seq: 3, coreMultiple: 2 }] }),
    )?.rule).toBe('A2-4')
    expect(violationOf(() =>
      planOperationSettingsChange({ ...base, updates: [{ seq: 2, coreMultiple: 2 }] }),
    )?.rule).toBe('A2-4')
  })
})

describe('A1-3 工序主数据（[底稿 A1-3] 工序管理 PRD）', () => {
  it('唯一性：部门内名称唯一、公司组织编码内编码唯一（排除自身）', () => {
    const existing = [
      { id: 'a', deptId: 'd1', name: '拉丝', companyOrgCode: 'ORG1', code: 'OP-01' },
    ]
    expect(
      findOperationDefinitionConflict(
        { deptId: 'd1', name: '拉丝', companyOrgCode: 'ORG1', code: 'OP-02' },
        existing,
      ),
    ).toEqual({ field: 'name', value: '拉丝' })
    expect(
      findOperationDefinitionConflict(
        { deptId: 'd2', name: '拉丝', companyOrgCode: 'ORG1', code: 'OP-01' },
        existing,
      ),
    ).toEqual({ field: 'code', value: 'OP-01' })
    expect(
      findOperationDefinitionConflict(
        { id: 'a', deptId: 'd1', name: '拉丝', companyOrgCode: 'ORG1', code: 'OP-01' },
        existing,
      ),
    ).toBeNull()
  })

  it('删除拦截顺序：①模板 → ②订单排产 → ③订单工序（先命中先拦截，文案区分）', () => {
    expect(violationOf(() =>
      assertOperationDefinitionRetirable({ templateRefs: 1, schedulingRefs: 0, orderOperationRefs: 0 }),
    )?.message).toContain('模版')
    expect(violationOf(() =>
      assertOperationDefinitionRetirable({ templateRefs: 0, schedulingRefs: 1, orderOperationRefs: 0 }),
    )?.message).toContain('排产')
    expect(violationOf(() =>
      assertOperationDefinitionRetirable({ templateRefs: 0, schedulingRefs: 0, orderOperationRefs: 1 }),
    )?.message).toContain('被使用')
    expect(() =>
      assertOperationDefinitionRetirable({ templateRefs: 0, schedulingRefs: 0, orderOperationRefs: 0 }),
    ).not.toThrow()
  })

  it('编辑锁：被订单排产引用时工作中心/所属部门不可改（未引用放行）；名称首尾不允许空格', () => {
    const v = violationOf(() =>
      assertOperationDefinitionLockedFieldsEditable(
        { schedulingReferenced: true },
        { workCenterId: 'wc-2' },
      ),
    )
    expect(v?.rule).toBe('A1-3')
    expect(() =>
      assertOperationDefinitionLockedFieldsEditable({ schedulingReferenced: true }, {}),
    ).not.toThrow()
    expect(() =>
      assertOperationDefinitionLockedFieldsEditable(
        { schedulingReferenced: false },
        { workCenterId: 'wc-2', deptId: 'd2' },
      ),
    ).not.toThrow()
    expect(violationOf(() => assertOperationNameNoEdgeSpaces(' 拉丝'))?.rule).toBe('A1-3')
    expect(() => assertOperationNameNoEdgeSpaces('拉丝')).not.toThrow()
  })

  it('许可目录（岗位许可字符串，L0 整合后由 domain 导出统一）', () => {
    expect(PROCESS_PERMISSIONS.PROCESS_READ).toBe('process.read')
    expect(PROCESS_PERMISSIONS.PROCESS_ADMIN).toBe('process.admin')
  })
})
