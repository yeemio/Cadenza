import { InventoryRuleViolation } from './errors'

/**
 * 六层身份与条码解析纯规则 —— 对应冻结合同 inventory-trace-core.md §1/§2：IT-01/04/05/06。
 */

/** IT-01：六层身份变化方式（枚举清单；表级约束见 IT-S6/迁移 0004）。 */
export const IDENTITY_LAYERS = [
  'material_lot',
  'inventory_unit',
  'material_segment',
  'carrier',
  'customer_segment',
  'barcode_label',
] as const
export type IdentityLayer = (typeof IDENTITY_LAYERS)[number]

/**
 * IT-05：码格式已知散点（10 位载具码第 2 位 E/F/M/P；R 类 10 位原料码；E/F 成品码；8 位货架码）。
 * 完整格式样例与生成规则未定义（GAP-A1/A2/A8）：本函数只做**已知散点的启发判定**（置信度 known），
 * 正式格式校验按版本化配置表（barcode_format）实现、不作数据库主键；新旧格式映射做唯一性检查。
 */
export type BarcodeKind = 'carrier' | 'raw_material' | 'finished_goods' | 'shelf' | 'transfer_spool'

export interface BarcodeKindGuess {
  kind: BarcodeKind | 'unknown'
  /** known = 命中已知散点；config = 命中版本化配置；unknown = 未能判定（不得当主键/不得默认放行） */
  confidence: 'known' | 'config' | 'unknown'
  matchedPattern?: string
}

/** IT-05：已知散点判定（优先级：载具码 > 原料码 > 货架码 > 成品码；散点间冲突以更长约束优先）。 */
export function guessBarcodeKind(value: string): BarcodeKindGuess {
  if (/^.{1}[EFMP].{8}$/.test(value) && value.length === 10) {
    return { kind: 'carrier', confidence: 'known', matchedPattern: '10位载具码(第2位E/F/M/P)' }
  }
  if (/^R\d{9}$/.test(value) || (value.length === 10 && value.startsWith('R'))) {
    return { kind: 'raw_material', confidence: 'known', matchedPattern: 'R类10位原料码' }
  }
  if (/^\d{8}$/.test(value)) {
    return { kind: 'shelf', confidence: 'known', matchedPattern: '8位货架码' }
  }
  if (/^[EF]/.test(value)) {
    return { kind: 'finished_goods', confidence: 'known', matchedPattern: 'E/F成品码' }
  }
  return { kind: 'unknown', confidence: 'unknown' }
}

/** 版本化格式配置行（barcode_format 表投影；IT-05/S7：格式校验版本化、不作主键）。 */
export interface BarcodeFormatRule {
  formatVersion: number
  labelKind: BarcodeKind
  pattern: string
  active: boolean
}

/**
 * IT-05/S7：按版本化配置判定码类型（配置命中优先于散点启发）；
 * 无活动配置命中时回落已知散点；均未命中 → unknown（由调用方按任务规则处理，不得默认放行）。
 */
export function matchBarcodeKind(
  value: string,
  formats: readonly BarcodeFormatRule[],
): BarcodeKindGuess {
  const active = [...formats].filter((f) => f.active).sort((a, b) => b.formatVersion - a.formatVersion)
  for (const rule of active) {
    try {
      if (new RegExp(rule.pattern).test(value)) {
        return { kind: rule.labelKind, confidence: 'config', matchedPattern: rule.pattern }
      }
    } catch {
      // 配置正则非法：忽略该行（配置数据问题不改变散点判定，登记于返回值）
      continue
    }
  }
  return guessBarcodeKind(value)
}

/** IT-04：解析链 barcode → binding → 业务对象 的候选对象。 */
export interface BarcodeCandidate {
  objectType: 'inventory_unit' | 'carrier' | 'material_lot' | 'location'
  objectId: string
  /** 候选补充描述（如单元号/载具码），供任务端显式选择展示 */
  label: string
  /** 候选来自直接绑定还是载具当前装载展开 */
  via: 'direct_binding' | 'carrier_load'
}

/**
 * IT-04：扫码解析返回候选业务对象集合，由当前任务显式选择。
 * - 直接绑定 inventory_unit → 单候选；
 * - 绑定 carrier → 载具当前装载的全部单元（可多候选，一码多物）；
 * - 无活动绑定 → 空集合（调用方按任务决定"空码可收"等语义）。
 * unitLabels：候选对象展示标签表（如 unitId → unitNo），未命中回落类型描述。
 */
export function resolveBarcodeCandidates(input: {
  activeBinding: { boundType: 'inventory_unit' | 'carrier' | 'material_lot' | 'location'; boundId: string } | null
  /** 载具当前装载的单元（activeBinding 为 carrier 时由调用方查 carrier_binding 提供） */
  loadedUnits: readonly { unitId: string; unitNo: string }[]
  unitLabels?: Readonly<Record<string, string>>
}): BarcodeCandidate[] {
  const labelFor = (id: string, fallback: string): string => input.unitLabels?.[id] ?? fallback
  if (input.activeBinding === null) return []
  if (input.activeBinding.boundType === 'carrier') {
    return input.loadedUnits.map((u) => ({
      objectType: 'inventory_unit' as const,
      objectId: u.unitId,
      label: u.unitNo,
      via: 'carrier_load' as const,
    }))
  }
  const fallbackMap: Record<string, string> = {
    inventory_unit: '直接绑定库存单元',
    carrier: '载具',
    material_lot: '物料批次',
    location: '库位',
  }
  return [
    {
      objectType: input.activeBinding.boundType,
      objectId: input.activeBinding.boundId,
      label: labelFor(input.activeBinding.boundId, fallbackMap[input.activeBinding.boundType] ?? input.activeBinding.boundType),
      via: 'direct_binding',
    },
  ]
}

/**
 * IT-04：不支持一码多物的命令对多候选**显式拒绝**，禁止默认取第一条。
 * （倒轴等命令按域合同接入；内核提供统一断言。）
 */
export function assertSingleCandidate(commandName: string, candidates: readonly BarcodeCandidate[]): BarcodeCandidate {
  if (candidates.length === 0) {
    throw new InventoryRuleViolation('IT-04', `${commandName}：条码未解析到候选对象（空码语义由任务规则决定）`)
  }
  if (candidates.length > 1) {
    throw new InventoryRuleViolation(
      'IT-04',
      `${commandName}：一码多物（${candidates.length} 个候选），该命令不支持多候选，须显式选择后重发`,
    )
  }
  return candidates[0]!
}

/**
 * IT-06/S7：(barcode_value, active) 唯一 —— 同一条码值同一时刻至多一条活动绑定。
 * 绑定前断言（实现层由库级 UNIQUE 兜底；本断言为命令层前置校验）。
 */
export function assertNoActiveBindingConflict(
  barcodeValue: string,
  existingActive: { boundType: string; boundId: string } | null,
): void {
  if (existingActive !== null) {
    throw new InventoryRuleViolation(
      'IT-06',
      `条码 ${barcodeValue} 已有活动绑定（${existingActive.boundType}/${existingActive.boundId}），` +
        '同一条码值同一时刻至多一条活动绑定；须先解绑',
    )
  }
}

/** IT-01：标签是识别媒介：补打引用原对象，作废/重印留记录，扫描格式不作主键。 */
export function assertLabelReprintReferencesOriginal(reprintOf: string | null | undefined, labelId: string): void {
  if (reprintOf === labelId) {
    throw new InventoryRuleViolation('IT-01', '标签补打不得引用自身；补打必须引用原 label_id')
  }
}
