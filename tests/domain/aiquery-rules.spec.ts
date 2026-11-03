import { describe, expect, it } from 'vitest'
import {
  AI_QUERY_CAPABILITY_SEEDS,
  AIQ_MATERIAL_SHORTAGE,
  AIQ_ORDER_PROGRESS,
  AIQ_QUALITY,
} from '../../packages/domain/src/aiquery/capabilities'
import { AIQUERY_PERMISSIONS, AIQUERY_DOMAIN_READ_PERMISSIONS } from '../../packages/domain/src/aiquery/permissions'
import {
  AI_QUERY_STATUS_LABELS,
  AI_QUERY_STATUS_VALUES,
  AI_QUERY_UNREADY_TOPICS,
  DEFAULT_QUALITY_TIME_WINDOW_DAYS,
  QUALITY_MAX_TIME_SPAN_DAYS,
  AI_QUERY_MAX_PAGE_SIZE,
  computeShortageLine,
  defaultQualityTimeRange,
  findUnreadyTopic,
  isOperationIncomplete,
  isUomMismatch,
  materialDesc,
  mulQty,
  parseIncludePurchaseLines,
  parseOrderRef,
  parsePage,
  parseQualityParams,
} from '../../packages/domain/src/aiquery/rules'
import { AiQueryRuleViolation } from '../../packages/domain/src/aiquery/errors'

/**
 * aiquery 域纯规则单测（capability-contract.md 机制总则与三能力口径的纯函数位）：
 * 七状态值域/未就绪问法族/许可键、orderRef 与质量参数解析（[AQ-xx-x] 规则码）、
 * AQ-C2 缺口口径（GAP-P4 口径未定/单位不一致不折算）、AQ-C1 未完成任务判定、
 * AQ-AMB-02 默认时间窗（Asia/Shanghai）、seed 定义形状（白名单物理排除价格列）。
 */

describe('aiquery 机制值域', () => {
  it('AQ-REG-07：结果状态恰为七值', () => {
    expect([...AI_QUERY_STATUS_VALUES]).toEqual([
      'ok_with_data',
      'ok_no_records',
      'no_permission',
      'not_supported',
      'source_not_ready',
      'timeout',
      'failed',
    ])
    expect(Object.keys(AI_QUERY_STATUS_LABELS)).toHaveLength(7)
  })

  it('§8：未就绪问法族固定四项，execute 命中同值 capabilityId → source_not_ready', () => {
    expect(AI_QUERY_UNREADY_TOPICS).toHaveLength(4)
    expect(AI_QUERY_UNREADY_TOPICS.map((t) => t.topic)).toEqual([
      '采购/外协交货逾期及其对工作令的影响',
      '工时与经营统计（车间有效工时/汇总工时）',
      '报表口径类问法（良率/损耗/在制/交期指标）',
      'BOM 消耗推导类问法（需求总量折算）',
    ])
    expect(findUnreadyTopic('aq.purchase-overdue-impact')?.capabilityId).toBe('aq.purchase-overdue-impact')
    expect(findUnreadyTopic('aq.order-progress')).toBeNull()
    expect(findUnreadyTopic('aq.labor-and-business-stats')?.message).toContain('数据源未就绪')
  })

  it('AQ-AUTH-02：模块许可键 aiquery.use + 管理许可键 aiquery.admin', () => {
    expect(AIQUERY_PERMISSIONS.USE).toBe('aiquery.use')
    expect(AIQUERY_PERMISSIONS.ADMIN).toBe('aiquery.admin')
    expect(AIQUERY_DOMAIN_READ_PERMISSIONS).toEqual([
      'process.read',
      'execution.read',
      'scheduling.read',
      'inventory.read',
      'purchase.read',
      'quality.read',
    ])
  })
})

describe('AQ-C1/AQ-C2 orderRef 解析（AQ-AMB-01/AQ-C1-1）', () => {
  it('四种 kind 均可解析并 trim', () => {
    expect(parseOrderRef({ orderRef: { kind: 'orderId', value: ' 0192f0d0-0000-7000-8000-000000000001 ' } })).toEqual({
      kind: 'orderId',
      value: '0192f0d0-0000-7000-8000-000000000001',
    })
    expect(parseOrderRef({ orderRef: { kind: 'orderNo', value: 'ORDER-1' } }).kind).toBe('orderNo')
    expect(parseOrderRef({ orderRef: { kind: 'orderNoLike', value: 'ORDER-' } }).kind).toBe('orderNoLike')
    expect(parseOrderRef({ orderRef: { kind: 'salesOrderNo', value: 'SO-1' } }).kind).toBe('salesOrderNo')
  })

  it('缺失/非法 → [AQ-C1-1] 语义非法（failed 承载位）', () => {
    expect(() => parseOrderRef({})).toThrowError(AiQueryRuleViolation)
    expect(() => parseOrderRef({})).toThrowError(/\[AQ-C1-1\]/)
    expect(() => parseOrderRef({ orderRef: null as unknown as object })).toThrowError(/\[AQ-C1-1\]/)
    expect(() => parseOrderRef({ orderRef: { kind: 'bogus', value: 'X' } })).toThrowError(/\[AQ-C1-1\]/)
    expect(() => parseOrderRef({ orderRef: { kind: 'orderNo', value: '  ' } })).toThrowError(/\[AQ-C1-1\]/)
    // 模糊片段过短拒绝（防无意义全表模糊）
    expect(() => parseOrderRef({ orderRef: { kind: 'orderNoLike', value: 'O' } })).toThrowError(/\[AQ-C1-1\]/)
  })

  it('AQ-C2 includePurchaseLines 缺省 true', () => {
    expect(parseIncludePurchaseLines({})).toBe(true)
    expect(parseIncludePurchaseLines({ includePurchaseLines: false })).toBe(false)
  })
})

describe('AQ-C3 质量参数解析（AQ-AMB-02/AQ-C3-1）', () => {
  const now = new Date('2026-10-20T04:30:00Z')

  it('无显式起止 → 默认最近 7 个自然日（Asia/Shanghai），defaultApplied=true', () => {
    // 直接断言纯函数：上海 2026-10-20 12:30 → 窗口起点 = 上海 2026-10-14 00:00 = UTC 2026-10-13T16:00:00Z
    expect(defaultQualityTimeRange(now)).toEqual({
      from: '2026-10-13T16:00:00.000Z',
      to: '2026-10-20T04:30:00.000Z',
      defaultApplied: true,
    })
    const params = parseQualityParams({}, now)
    expect(params.timeRange.defaultApplied).toBe(true)
    expect(DEFAULT_QUALITY_TIME_WINDOW_DAYS).toBe(7)
    // 上海 2026-10-20 12:30 → 窗口起点 = 上海 2026-10-14 00:00 = UTC 2026-10-13T16:00:00Z
    expect(params.timeRange.from).toBe('2026-10-13T16:00:00.000Z')
    expect(params.timeRange.to).toBe('2026-10-20T04:30:00.000Z')
    expect(params.objectScope).toBe('all')
    expect(params.page).toEqual({ page: 1, pageSize: 20 })
  })

  it('显式合法起止 → 从之，defaultApplied=false；非法值被忽略过滤', () => {
    const params = parseQualityParams(
      {
        timeRange: { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
        objectScope: 'purchase_batch',
        conclusions: ['unqualified', 'bogus'],
        inspectionStages: ['process', 'bogus'],
        orderNoLike: ' QIO ',
      },
      now,
    )
    expect(params.timeRange).toEqual({ from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', defaultApplied: false })
    expect(params.objectScope).toBe('purchase_batch')
    expect(params.conclusions).toEqual(['unqualified'])
    expect(params.inspectionStages).toEqual(['process'])
    expect(params.orderNoLike).toBe('QIO')
  })

  it('非法时间 → [AQ-C3-1]（非 ISO/起>止/跨度>92 天）', () => {
    expect(() => parseQualityParams({ timeRange: { from: 'not-a-date', to: '2026-02-01T00:00:00Z' } }, now)).toThrowError(
      /\[AQ-C3-1\]/,
    )
    expect(() => parseQualityParams({ timeRange: { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' } }, now)).toThrowError(
      /\[AQ-C3-1\]/,
    )
    expect(() =>
      parseQualityParams({ timeRange: { from: '2026-01-01T00:00:00Z', to: '2026-12-01T00:00:00Z' } }, now),
    ).toThrowError(/超过最大查询范围 92 天/)
    expect(QUALITY_MAX_TIME_SPAN_DAYS).toBe(92)
  })

  it('AQ-REG-09：pageSize 服务端上限 100，缺省 20；非法回落', () => {
    expect(AI_QUERY_MAX_PAGE_SIZE).toBe(100)
    expect(parsePage({ page: 2, pageSize: 500 })).toEqual({ page: 2, pageSize: 100 })
    expect(parsePage({})).toEqual({ page: 1, pageSize: 20 })
    expect(parsePage({ page: 0, pageSize: 0 })).toEqual({ page: 1, pageSize: 20 })
  })
})

describe('AQ-C2 缺口口径规则（GAP-P4/AQ-AMB-03）', () => {
  const sameUom = { bom: 'T', stock: 'T', purchase: 'T' }

  it('requirementBase 未配置 → 缺口数值列固定「口径未定」标注，不给数', () => {
    const r = computeShortageLine({ bomQuantity: '0.5000', productionQty: '100.0000', requirementBase: null, availableQty: '0.2000', inTransitQty: '6.0000', uomSources: sameUom })
    expect(r.requiredQty).toBeNull()
    expect(r.shortageQty).toBeNull()
    expect(r.shortageNote).toContain('口径未定')
    expect(r.uomMismatch).toBe(false)
  })

  it('三源 uom 不一致 → 不折算、不汇总结论，标注「单位不一致未折算」', () => {
    const r = computeShortageLine({ bomQuantity: '5.0000', productionQty: null, requirementBase: 'total', availableQty: '50.0000', inTransitQty: '10.0000', uomSources: { bom: 'M', stock: 'M', purchase: 'KG' } })
    expect(r.requiredQty).toBeNull()
    expect(r.shortageQty).toBeNull()
    expect(r.shortageNote).toContain('单位不一致未折算')
    expect(r.uomMismatch).toBe(true)
    expect(isUomMismatch({ bom: 'M', stock: null, purchase: null })).toBe(false)
    expect(isUomMismatch({ bom: 'M', stock: 'M', purchase: null })).toBe(false)
  })

  it('requirementBase=total：required=BOM 行数量；缺口=required−可用−在途（下限 0）', () => {
    const r = computeShortageLine({ bomQuantity: '20.0000', productionQty: null, requirementBase: 'total', availableQty: '5.0000', inTransitQty: '10.0000', uomSources: sameUom })
    expect(r.requiredQty).toBe('20.0000')
    expect(r.shortageQty).toBe('5.0000')
    expect(r.shortageNote).toBeNull()
    const covered = computeShortageLine({ bomQuantity: '20.0000', productionQty: null, requirementBase: 'total', availableQty: '15.0000', inTransitQty: '10.0000', uomSources: sameUom })
    expect(covered.shortageQty).toBe('0.0000')
  })

  it('requirementBase=per_unit：required=BOM 行数量 × 生产数量', () => {
    const r = computeShortageLine({ bomQuantity: '0.5000', productionQty: '100.0000', requirementBase: 'per_unit', availableQty: '0.2000', inTransitQty: '6.0000', uomSources: sameUom })
    expect(r.requiredQty).toBe('50.0000')
    expect(r.shortageQty).toBe('43.8000')
    expect(mulQty('0.5000', '100.0000')).toBe('50.0000')
    expect(mulQty('1.2345', '2.0000')).toBe('2.4690')
  })
})

describe('AQ-C1 未完成任务判定（GAP-P9：不看 execution_status）', () => {
  it('排程未排完 或 审核通过量为零 → 未完成', () => {
    expect(isOperationIncomplete({ fullyScheduled: false, approvedQty: '80.0000' })).toBe(true)
    expect(isOperationIncomplete({ fullyScheduled: true, approvedQty: '0.0000' })).toBe(true)
    expect(isOperationIncomplete({ fullyScheduled: true, approvedQty: '80.0000' })).toBe(false)
  })
})

describe('料品描述拼接口径', () => {
  it('名称/规格/颜色 " / " 拼接，都空 "-"', () => {
    expect(materialDesc({ name: '成品缆', spec: '3×95', color: '红' })).toBe('成品缆 / 3×95 / 红')
    expect(materialDesc({})).toBe('-')
  })
})

describe('首版三能力 seed 定义（AQ-REG-02/03 + 白名单）', () => {
  it('三能力 id/version/权限两层', () => {
    expect(AI_QUERY_CAPABILITY_SEEDS.map((s) => s.capabilityId)).toEqual([
      'aq.order-progress',
      'aq.material-shortage',
      'aq.quality',
    ])
    for (const seed of AI_QUERY_CAPABILITY_SEEDS) {
      expect(seed.version).toBe(1)
      expect(seed.status).toBe('enabled')
      expect(seed.definition.requiredPermissions[0]).toBe(AIQUERY_PERMISSIONS.USE)
      expect(seed.definition.inputSchema).toBeTypeOf('object')
      expect(seed.definition.allowedObjects.length).toBeGreaterThan(0)
    }
    expect(AIQ_ORDER_PROGRESS.definition.requiredPermissions).toEqual([
      'aiquery.use',
      'process.read',
      'execution.read',
      'scheduling.read',
    ])
    expect(AIQ_MATERIAL_SHORTAGE.definition.requiredPermissions).toEqual([
      'aiquery.use',
      'process.read',
      'inventory.read',
      'purchase.read',
    ])
    expect(AIQ_QUALITY.definition.requiredPermissions).toEqual(['aiquery.use', 'quality.read', 'purchase.read'])
  })

  it('AQ-C2：requirementBase 未配置（口径未定）+ 价格类字段物理排除出白名单（GAP-P5）', () => {
    expect(AIQ_MATERIAL_SHORTAGE.definition.caliberParams['requirementBase']).toBeNull()
    const allFields = AIQ_MATERIAL_SHORTAGE.definition.allowedObjects.flatMap((o) => o.fields)
    for (const banned of ['unit_price', 'avg_price', 'price_history', 'deviation_ppm', 'price_flag']) {
      expect(allFields).not.toContain(banned)
    }
  })

  it('AQ-C3：复核价格列与外发同步状态列物理排除出白名单（GAP-P5）', () => {
    const allFields = AIQ_QUALITY.definition.allowedObjects.flatMap((o) => o.fields)
    for (const banned of [
      'unit_price',
      'avg_price',
      'price_history',
      'deviation_ppm',
      'price_flag',
      'review_status',
      'reviewed_by',
      'reviewed_at',
      'qualified_sync_status',
      'return_sync_status',
    ]) {
      expect(allFields).not.toContain(banned)
    }
  })

  it('AQ-C1：操作工个人维度报工明细不进白名单（GAP-P5 敏感域）', () => {
    const allFields = AIQ_ORDER_PROGRESS.definition.allowedObjects.flatMap((o) => o.fields)
    for (const banned of ['operator_user_id', 'operator_login', 'hours']) {
      expect(allFields).not.toContain(banned)
    }
  })
})
