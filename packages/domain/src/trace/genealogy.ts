// 包内上级目录相对导入（domain/src/trace → domain/src/inventory）：未逃逸出 domain 包，
// 边界规则对包内子目录场景过宽（S2 曾因同规则扁平化 application）；此处单行豁免并留痕。
// eslint-disable-next-line no-restricted-imports
import { InventoryRuleViolation } from '../inventory/errors'

/**
 * 谱系与追溯纯规则 —— 对应冻结合同 inventory-trace-core.md §7：IT-34/35/36、IT-31/33 边界。
 */

/**
 * IT-34：谱系边类型（首期四类）：
 * - receipt_origin：采购批次明细 → 库存单元（正向起点）；
 * - consumption：投料消费边（lot/unit/segment → 在制单元/段；分盘的子单元同样以消费边记录数量来源）；
 * - production_output：报工产出单元；
 * - customer_binding：客户轴号绑定（同订单一轴号一绑）。
 */
export const GENEALOGY_EDGE_KINDS = ['receipt_origin', 'consumption', 'production_output', 'customer_binding'] as const
export type GenealogyEdgeKind = (typeof GENEALOGY_EDGE_KINDS)[number]

export type GenealogyNodeType = 'material_lot' | 'inventory_unit' | 'material_segment' | 'customer_segment'

/** IT-34：边类型与端点类型的合法配对（from → to）。 */
export const EDGE_ENDPOINT_RULES: Readonly<Record<GenealogyEdgeKind, { from: readonly GenealogyNodeType[]; to: readonly GenealogyNodeType[] }>> = {
  receipt_origin: {
    from: ['material_lot'],
    to: ['inventory_unit'],
  },
  consumption: {
    from: ['material_lot', 'inventory_unit', 'material_segment'],
    to: ['inventory_unit', 'material_segment'],
  },
  production_output: {
    from: ['material_lot', 'inventory_unit'],
    to: ['inventory_unit'],
  },
  customer_binding: {
    from: ['inventory_unit', 'material_segment'],
    to: ['customer_segment'],
  },
}

/** IT-34：写入谱系边前的端点配对校验（表级 CHECK 之外的应用层前置）。 */
export function assertEdgeEndpoints(edgeKind: string, fromType: string, toType: string): void {
  const rule = EDGE_ENDPOINT_RULES[edgeKind as GenealogyEdgeKind]
  if (rule === undefined) {
    throw new InventoryRuleViolation('IT-34', `未知谱系边类型：${edgeKind}（首期仅 ${GENEALOGY_EDGE_KINDS.join('/')}）`)
  }
  if (!rule.from.includes(fromType as GenealogyNodeType) || !rule.to.includes(toType as GenealogyNodeType)) {
    throw new InventoryRuleViolation(
      'IT-34',
      `谱系边端点配对非法：${fromType} --${edgeKind}--> ${toType}`,
    )
  }
}

/** IT-34：客户轴号绑定"同订单一轴号一绑"唯一性断言。 */
export function assertOneBindingPerOrderAxis(input: {
  orderNo: string
  existingBindings: readonly { orderNo: string; unitId: string }[]
  unitId: string
}): void {
  const conflict = input.existingBindings.find((b) => b.orderNo === input.orderNo && b.unitId !== input.unitId)
  if (conflict) {
    throw new InventoryRuleViolation(
      'IT-34',
      `订单 ${input.orderNo} 的客户轴号已绑定单元 ${conflict.unitId}；同订单一轴号一绑`,
    )
  }
}

/**
 * IT-35：追溯语义双方向 + 精度分级。
 * - 正向："这批原料去了哪些在制、轴段、客户交付"（from=原料沿边向 to）；
 * - 反向："这根交付轴由什么料、哪些工序、设备、人员和质量结果产生"（to=交付沿边向 from）。
 * 追溯精度按证据分级（批次/库存单元/轴段区间）；无连续计长证据不承诺任意一米定位。
 */
export const TRACE_DIRECTIONS = ['forward', 'backward'] as const
export type TraceDirection = (typeof TRACE_DIRECTIONS)[number]

/** IT-35：追溯精度标签（无区间证据 → quantity，只承诺数量追溯）。 */
export function tracePrecisionLabel(input: {
  hasSegmentRange: boolean
}): 'segment' | 'unit' | 'lot' {
  if (input.hasSegmentRange) return 'segment'
  return 'unit'
}

/**
 * IT-36：轴号修正目标口径——不自动解绑他人已占用客户轴号；
 * 冲突先展示占用与影响，核权后执行**显式**重新分配；截取单位随物料，不固定米。
 */
export interface CustomerSegmentOccupancy {
  orderNo: string
  occupiedByHolderRef: string | null
}

export function assertCustomerSegmentReallocation(input: {
  target: CustomerSegmentOccupancy
  /** 冲突时的核权确认（命令载荷显式携带，展示占用与影响后由有权者确认） */
  reallocationConfirmed: boolean
  actorCanReallocate: boolean
}): void {
  if (input.target.occupiedByHolderRef !== null) {
    if (!input.actorCanReallocate) {
      throw new InventoryRuleViolation(
        'IT-36',
        `轴号修正冲突：订单 ${input.target.orderNo} 的客户轴号已被 ${input.target.occupiedByHolderRef} 占用；当前用户无重新分配权限`,
      )
    }
    if (!input.reallocationConfirmed) {
      throw new InventoryRuleViolation(
        'IT-36',
        `轴号修正冲突：订单 ${input.target.orderNo} 的客户轴号已被 ${input.target.occupiedByHolderRef} 占用；` +
          '须先展示占用与影响，核权确认后显式重新分配（不自动解绑）',
      )
    }
  }
}

/**
 * IT-33：生效事实不得以数量改 0 隐式删除；显式删除仅限普通草稿（保留操作记录）。
 * 库层由 append-only 触发器兜底；本断言用于命令入口（拒绝"改 0 代替冲销"的载荷形态）。
 */
export function assertNoImplicitDeleteByZeroQty(input: {
  subject: string
  isEffectiveFact: boolean
  newQtyIsZero: boolean
  commandIsReversal: boolean
}): void {
  if (input.isEffectiveFact && input.newQtyIsZero && !input.commandIsReversal) {
    throw new InventoryRuleViolation(
      'IT-33',
      `${input.subject} 为已生效事实，不得以数量改 0 隐式删除；纠正走逆序冲销（IT-32）`,
    )
  }
}

/** IT-24：Redis/本地缓存不作库存最终依据（本域查询只读库；缓存属体验层，不落规则函数）。 */
export const CACHE_IS_NOT_AUTHORITY = true as const
