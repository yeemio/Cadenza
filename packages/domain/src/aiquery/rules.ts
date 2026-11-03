import type { DecimalString } from '@cadenza/contracts'
// 域内上级目录规则误伤豁免（同 execution/quantities.ts 先例）：aiquery 与 inventory 同属
// domain 包内授权子目录，仅复用定点算术原语。
// eslint-disable-next-line no-restricted-imports -- 包内跨子目录相对导入（见上）
import { addQty, cmpQty, formatScaled, isZeroQty, subQty, toScaled } from '../inventory/quantity'
import { AiQueryRuleViolation } from './errors'

/**
 * aiquery 域纯规则（capability-contract.md §2～§5、§8；零 I/O、零仓储依赖）。
 *
 * 职责：能力输入参数解析与校验（[AQ-xx-x] 全中文规则码）、AQ-C2 缺口口径规则
 * （GAP-P4 口径未定/单位不一致不折算）、AQ-AMB-02 时间默认（Asia/Shanghai）、
 * §8 未就绪问法族固定清单、七状态值域。
 */

// ---------------------------------------------------------------------------
// 结果状态值域（AQ-REG-07；与 contracts/src/aiquery.ts wire 值一致）
// ---------------------------------------------------------------------------

export const AI_QUERY_STATUS_VALUES = [
  'ok_with_data',
  'ok_no_records',
  'no_permission',
  'not_supported',
  'source_not_ready',
  'timeout',
  'failed',
] as const

export type AiQueryStatus = (typeof AI_QUERY_STATUS_VALUES)[number]

/** 七状态中文标签（与 contracts/src/aiquery.ts wire 标签同值；服务端唯一运行时来源）。 */
export const AI_QUERY_STATUS_LABELS: Readonly<Record<AiQueryStatus, string>> = {
  ok_with_data: '查询成功（有数据）',
  ok_no_records: '查询成功（无匹配记录）',
  no_permission: '无权限执行该问数',
  not_supported: '该问数能力未注册或已停用',
  source_not_ready: '数据源未就绪',
  timeout: '查询超时',
  failed: '查询失败',
}

// ---------------------------------------------------------------------------
// §8 未就绪问法族（固定清单；source_not_ready，不得把空集合算成零值经营事实）
// ---------------------------------------------------------------------------

export interface AiUnreadyTopic {
  /** 未就绪问法族固定标识（execute 收到同值 capabilityId → source_not_ready） */
  capabilityId: string
  topic: string
  message: string
}

export const AI_QUERY_UNREADY_TOPICS: readonly AiUnreadyTopic[] = [
  {
    capabilityId: 'aq.purchase-overdue-impact',
    topic: '采购/外协交货逾期及其对工作令的影响',
    message:
      '数据源未就绪：planned_receipt_date 存在，但「逾期影响哪些工作令」无关联读面（sales_order_no 对齐不构成工作令级影响结论）。',
  },
  {
    capabilityId: 'aq.labor-and-business-stats',
    topic: '工时与经营统计（车间有效工时/汇总工时）',
    message:
      '数据源未就绪：labor_record 为原始行，无版本化统计口径与数据源绑定（engine-reporting 不存在于本仓）。',
  },
  {
    capabilityId: 'aq.report-metrics',
    topic: '报表口径类问法（良率/损耗/在制/交期指标）',
    message: '数据源未就绪：无版本化指标读面。',
  },
  {
    capabilityId: 'aq.bom-consumption',
    topic: 'BOM 消耗推导类问法（需求总量折算）',
    message: '数据源未就绪：BOM 消耗基数语义未冻结（GAP-P4）。',
  },
]

/** execute 的 capabilityId 是否命中未就绪问法族（AQ-REG-01：→ source_not_ready）。 */
export function findUnreadyTopic(capabilityId: string): AiUnreadyTopic | null {
  return AI_QUERY_UNREADY_TOPICS.find((t) => t.capabilityId === capabilityId) ?? null
}

// ---------------------------------------------------------------------------
// AQ-C1/AQ-C2 订单引用解析（AQ-AMB-01）
// ---------------------------------------------------------------------------

export const ORDER_REF_KINDS: readonly string[] = ['orderId', 'orderNo', 'orderNoLike', 'salesOrderNo']

export interface OrderRef {
  kind: 'orderId' | 'orderNo' | 'orderNoLike' | 'salesOrderNo'
  value: string
}

/**
 * orderRef 解析：orderRef 为空/形状非法 → 语义非法（AQ-C1 段①：failed 带提示）。
 * 唯一性语义：精确 orderId/orderNo 企业内唯一（production_order_no_unique）；
 * orderNoLike/salesOrderNo 可能多命中 → 候选清单（AQ-AMB-01，由查询层判定）。
 */
export function parseOrderRef(params: Record<string, unknown>): OrderRef {
  const raw = params['orderRef']
  if (typeof raw !== 'object' || raw === null) {
    throw new AiQueryRuleViolation(
      'AQ-C1-1',
      'orderRef 缺失或非法：必须提供 { kind: orderId|orderNo|orderNoLike|salesOrderNo, value }（订单引用为空属语义非法）',
    )
  }
  const record = raw as Record<string, unknown>
  const kind = record['kind']
  const value = record['value']
  if (typeof kind !== 'string' || !ORDER_REF_KINDS.includes(kind)) {
    throw new AiQueryRuleViolation(
      'AQ-C1-1',
      `orderRef.kind 非法：${String(kind)}（须为 ${ORDER_REF_KINDS.join('/')} 之一）`,
    )
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AiQueryRuleViolation('AQ-C1-1', `orderRef.value 缺失或为空（kind=${kind}）`)
  }
  if (kind === 'orderNoLike' && value.trim().length < 2) {
    throw new AiQueryRuleViolation(
      'AQ-C1-1',
      'orderNoLike.value 至少 2 个字符（过短模糊匹配无业务意义，请提供更长单号片段或精确单号）',
    )
  }
  return { kind: kind as OrderRef['kind'], value: value.trim() }
}

/** AQ-C2 includePurchaseLines（缺省 true）。 */
export function parseIncludePurchaseLines(params: Record<string, unknown>): boolean {
  const raw = params['includePurchaseLines']
  return typeof raw === 'boolean' ? raw : true
}

// ---------------------------------------------------------------------------
// AQ-C3 质量查询参数解析（AQ-AMB-02 时间范围；92 天跨度；pageSize ≤ 100）
// ---------------------------------------------------------------------------

export type QualityObjectScope = 'inspection_order' | 'purchase_batch' | 'all'

export interface QualityTimeRange {
  from: string
  to: string
  defaultApplied: boolean
}

/** Asia/Shanghai 固定 UTC+8（无夏令时）；本仓无工厂级时区配置（GAP-P11）。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

/** AQ-AMB-02：无显式起止 → 默认最近 7 个自然日（Asia/Shanghai）。 */
export const DEFAULT_QUALITY_TIME_WINDOW_DAYS = 7

/** 含当日起往前共 7 个自然日。 */
export function defaultQualityTimeRange(now: Date): QualityTimeRange {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  const y = shanghaiNow.getUTCFullYear()
  const m = shanghaiNow.getUTCMonth()
  const d = shanghaiNow.getUTCDate()
  // 上海自然日 0 点 = UTC (y,m,d) 0 点 − 8h；从（今日−6）起共 7 个自然日，含今日
  const fromMs = Date.UTC(y, m, d - 6) - SHANGHAI_OFFSET_MS
  return {
    from: new Date(fromMs).toISOString(),
    to: now.toISOString(),
    defaultApplied: true,
  }
}

/** AQ-C3 最大时间跨度（自然日）：92 天（§4 段①最大查询范围）。 */
export const QUALITY_MAX_TIME_SPAN_DAYS = 92

/** AQ-REG-09：pageSize 服务端上限 100（先例 toPageRequest）。 */
export const AI_QUERY_MAX_PAGE_SIZE = 100

export interface QualityQueryParams {
  objectScope: QualityObjectScope
  timeRange: QualityTimeRange
  /** 生效结论过滤（qualified/unqualified；空=不过滤） */
  conclusions: Array<'qualified' | 'unqualified'>
  /** 检验单阶段过滤（process/finished；空=不过滤） */
  inspectionStages: Array<'process' | 'finished'>
  orderNoLike: string | null
  page: { page: number; pageSize: number }
}

/**
 * AQ-C3 参数解析：timeRange 缺省→默认最近 7 自然日并回显（AQ-AMB-02）；
 * 显式但非法（非 ISO-8601/起>止/跨度>92 天）→ failed（AQ-C3-1）。
 */
export function parseQualityParams(params: Record<string, unknown>, now: Date): QualityQueryParams {
  const rawScope = params['objectScope']
  const objectScope: QualityObjectScope =
    rawScope === 'inspection_order' || rawScope === 'purchase_batch' ? rawScope : 'all'

  let timeRange = defaultQualityTimeRange(now)
  const rawRange = params['timeRange']
  if (rawRange !== undefined) {
    if (typeof rawRange !== 'object' || rawRange === null) {
      throw new AiQueryRuleViolation('AQ-C3-1', 'timeRange 非法：须为 { from, to }（ISO-8601 起止时刻）')
    }
    const record = rawRange as Record<string, unknown>
    const fromMs = typeof record['from'] === 'string' ? Date.parse(record['from']) : Number.NaN
    const toMs = typeof record['to'] === 'string' ? Date.parse(record['to']) : Number.NaN
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      throw new AiQueryRuleViolation(
        'AQ-C3-1',
        'timeRange.from/to 必须是 ISO-8601 时刻（自然语言时间请先换算为显式起止）',
      )
    }
    if (fromMs > toMs) {
      throw new AiQueryRuleViolation('AQ-C3-1', 'timeRange.from 不得晚于 timeRange.to')
    }
    const spanDays = (toMs - fromMs) / (24 * 60 * 60 * 1000)
    if (spanDays > QUALITY_MAX_TIME_SPAN_DAYS) {
      throw new AiQueryRuleViolation(
        'AQ-C3-1',
        `时间跨度 ${spanDays.toFixed(1)} 天超过最大查询范围 ${String(QUALITY_MAX_TIME_SPAN_DAYS)} 天，请收窄时间范围`,
      )
    }
    timeRange = { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), defaultApplied: false }
  }

  const conclusions = Array.isArray(params['conclusions'])
    ? (params['conclusions'] as unknown[]).filter(
        (c): c is 'qualified' | 'unqualified' => c === 'qualified' || c === 'unqualified',
      )
    : []
  const inspectionStages = Array.isArray(params['inspectionStages'])
    ? (params['inspectionStages'] as unknown[]).filter(
        (s): s is 'process' | 'finished' => s === 'process' || s === 'finished',
      )
    : []
  const orderNoLikeRaw = params['orderNoLike']
  const orderNoLike = typeof orderNoLikeRaw === 'string' && orderNoLikeRaw.trim().length > 0 ? orderNoLikeRaw.trim() : null

  return { objectScope, timeRange, conclusions, inspectionStages, orderNoLike, page: parsePage(params['page']) }
}

/** 分页解析与钳制（AQ-REG-09：pageSize 服务端上限 100；缺省 page=1/pageSize=20）。 */
export function parsePage(raw: unknown): { page: number; pageSize: number } {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const pageRaw = record['page']
  const pageSizeRaw = record['pageSize']
  const page = typeof pageRaw === 'number' && Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1
  const pageSize =
    typeof pageSizeRaw === 'number' && Number.isInteger(pageSizeRaw) && pageSizeRaw >= 1
      ? Math.min(pageSizeRaw, AI_QUERY_MAX_PAGE_SIZE)
      : 20
  return { page, pageSize }
}

// ---------------------------------------------------------------------------
// AQ-C2 缺口口径规则（GAP-P4：口径未定/单位不一致不折算；AQ-AMB-03）
// ---------------------------------------------------------------------------

export interface ShortageLineInput {
  bomQuantity: DecimalString
  /** 订单生产数量（requirementBase='per_unit' 时参与折算） */
  productionQty: DecimalString | null
  requirementBase: 'per_unit' | 'total' | null
  availableQty: DecimalString
  inTransitQty: DecimalString
  uomSources: { bom: string; stock: string | null; purchase: string | null }
}

export interface ShortageLineResult {
  requiredQty: DecimalString | null
  shortageQty: DecimalString | null
  shortageNote: string | null
  uomMismatch: boolean
}

/** 三源 uom 一致性判定（BOM uom vs stock uom vs purchase uom；null=该源无行）。 */
export function isUomMismatch(sources: ShortageLineInput['uomSources']): boolean {
  const present = [sources.bom, sources.stock, sources.purchase].filter((u): u is string => u !== null)
  if (present.length <= 1) return false
  return new Set(present).size > 1
}

/** 定点乘法（scale 4 × scale 4 → scale 4，四舍五入到 4 位小数）。 */
export function mulQty(a: DecimalString, b: DecimalString): DecimalString {
  const product = toScaled(a) * toScaled(b) // scale 8
  const half = 5n * 10n ** 3n // scale 8 → scale 4 的半位
  const rounded = (product + half) / 10n ** 4n
  return formatScaled(rounded)
}

/**
 * AQ-C2 缺口数值规则（§3）：
 * - 三源 uom 不一致 → 不折算、不汇总结论，逐行标注「单位不一致未折算」；
 * - requirementBase 未配置 → 缺口数值列固定「口径未定」标注（GAP-P4，不得按猜测口径给数）；
 * - 已配置 → requiredQty = per_unit ? BOM 行数量 × production_qty : BOM 行数量；
 *   shortageQty = max(0, requiredQty − availableQty − inTransitQty)。
 */
export function computeShortageLine(input: ShortageLineInput): ShortageLineResult {
  const uomMismatch = isUomMismatch(input.uomSources)
  if (uomMismatch) {
    return {
      requiredQty: null,
      shortageQty: null,
      shortageNote: '单位不一致未折算（BOM/库存/采购三源单位不同，首版无跨源自动换算，不做汇总结论）',
      uomMismatch: true,
    }
  }
  if (input.requirementBase === null) {
    return {
      requiredQty: null,
      shortageQty: null,
      shortageNote: '口径未定（requirementBase 未配置：BOM 行基数语义未冻结，缺口数值列首版不给数，GAP-P4）',
      uomMismatch: false,
    }
  }
  const requiredQty =
    input.requirementBase === 'per_unit'
      ? mulQty(input.bomQuantity, input.productionQty ?? '0.0000')
      : input.bomQuantity
  const covered = addQty(input.availableQty, input.inTransitQty)
  const shortageQty = cmpQty(requiredQty, covered) > 0 ? subQty(requiredQty, covered) : '0.0000'
  return { requiredQty, shortageQty, shortageNote: null, uomMismatch: false }
}

/** AQ-C1 未完成任务判定（§2：排程未排完 或 审核通过量为零；不看 execution_status，GAP-P9）。 */
export function isOperationIncomplete(input: {
  fullyScheduled: boolean
  approvedQty: DecimalString
}): boolean {
  return !input.fullyScheduled || isZeroQty(input.approvedQty)
}

// ---------------------------------------------------------------------------
// 料品描述拼接口径（先例 scheduling-queries materialDesc：名称/规格/颜色 " / " 拼接，都空 "-"）
// ---------------------------------------------------------------------------

export function materialDesc(snapshot: Record<string, unknown>): string {
  const name = typeof snapshot['name'] === 'string' && snapshot['name'] !== '' ? snapshot['name'] : null
  const spec = typeof snapshot['spec'] === 'string' && snapshot['spec'] !== '' ? snapshot['spec'] : null
  const color = typeof snapshot['color'] === 'string' && snapshot['color'] !== '' ? snapshot['color'] : null
  const parts = [name, spec, color].filter((p): p is string => p !== null)
  return parts.length > 0 ? parts.join(' / ') : '-'
}
