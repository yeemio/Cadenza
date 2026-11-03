import { createHash } from 'node:crypto'
import { SapSimRuleViolation } from './errors'
import { findSapSimTopicMapping } from './sim-profile'

/**
 * R1 模拟 SAP 引擎契约（domain 层）：
 * - 输入=业务事件（按 SAP-REFERENCE-PROFILE 映射）；禁止 expected_outcome（输入是条件，输出由事实推导）。
 * - 故障注入类型/场景配置；注入点与次数在场景配置，不改产品通过结论。
 */

/** 禁止的调用方申报结局字段（出现即 422，SAP-SIMENG-1）。 */
export const SAP_SIM_FORBIDDEN_OUTCOME_INPUT_FIELDS = [
  'expected_outcome',
  'expectedOutcome',
  'expected_result',
  'expectedResult',
  'declared_outcome',
  'declaredOutcome',
  'outcome',
  'attempt_outcome',
  'attemptOutcome',
] as const

export const SAP_SIM_FAULT_TYPES = [
  'MESSAGE_LOST',
  'RESPONSE_LOST',
  'DELAY',
  'DUPLICATE',
  'REORDER',
  'QUERY_UNAVAILABLE',
  'BUSINESS_REJECT',
  'NETWORK_DOWN',
] as const
export type SapSimFaultType = (typeof SAP_SIM_FAULT_TYPES)[number]

/** 引擎推导结局（模拟侧台账用；≠ 调用方申报）。 */
export const SAP_SIM_ENGINE_OUTCOMES = [
  'APPLIED_ONCE',
  'APPLIED',
  'CONFIRMED',
  'ISSUE_CONFIRMED',
  'RECEIPT_CONFIRMED',
  'LINES_CONFIRMED',
  'DUPLICATE_SAME_HASH_NOOP',
  'DUPLICATE_RETURN_ORIGINAL',
  'WAIT_PARENT_VERSION',
  'STALE_NOOP',
  'REJECT_ALREADY_PRODUCED',
  'REJECT_ORGANIZATION_MISMATCH',
  'REJECTED_MISSING_REWORK_ORDER',
  'REJECTED_INSUFFICIENT_STOCK',
  'REJECTED_NO_IN_TRANSIT',
  'REJECTED_QTY_EXCEEDED',
  'REJECTED_UNKNOWN_ORDER',
  'RECEIVED_NOT_APPLIED',
  'REJECT_NOTICE',
  'CANCELLED',
  'HELD_FOR_REORDER',
  'MESSAGE_LOST',
  'NETWORK_DOWN',
  'RESPONSE_LOST',
  'TIMEOUT_UNKNOWN',
] as const
export type SapSimEngineOutcome = (typeof SAP_SIM_ENGINE_OUTCOMES)[number]

export interface SapSimBusinessEvent {
  eventKey: string
  topic: string
  organizationCode: string
  plantCode: string
  businessKey: string | null
  sourceVersion: number | null
  parentVersion: number | null
  occurredAt: string | null
  sequence: number | null
  payload: Record<string, unknown>
}

function asNonEmpty(v: unknown, field: string, rule: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new SapSimRuleViolation(rule, `缺少必填字段 ${field}`)
  }
  return v.trim()
}

function asOptionalInt(v: unknown): number | null {
  if (v === undefined || v === null) return null
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}

/**
 * 业务事件输入契约（POST /integrations/sap-sim/execute）。
 * 关键护栏：请求中出现 expected_outcome 族字段即 422（SAP-SIMENG-1）。
 */
export function assertSapSimBusinessEvent(payload: Record<string, unknown>): SapSimBusinessEvent {
  // 顶层或业务 payload 内出现申报结局字段均拒（请求中出现即 422）
  const bodyProbe =
    payload['payload'] !== undefined && typeof payload['payload'] === 'object' && payload['payload'] !== null
      ? (payload['payload'] as Record<string, unknown>)
      : null
  for (const field of SAP_SIM_FORBIDDEN_OUTCOME_INPUT_FIELDS) {
    if (payload[field] !== undefined || bodyProbe?.[field] !== undefined) {
      throw new SapSimRuleViolation(
        'SAP-SIMENG-1',
        `禁止传 ${field}：模拟器输出由自身业务规则与事实推导，不接受调用方申报结局`,
      )
    }
  }
  const eventKey = asNonEmpty(
    payload['event_key'] ?? payload['eventKey'],
    'event_key',
    'SAP-SIMENG-2',
  )
  const topic = asNonEmpty(payload['topic'] ?? payload['entity_type'] ?? payload['entityType'], 'topic', 'SAP-SIMENG-3')
  const mapping = findSapSimTopicMapping(topic)
  if (!mapping) {
    throw new SapSimRuleViolation(
      'SAP-SIMENG-4',
      `topic=${topic} 不在模拟支持子集（见 SAP-REFERENCE-PROFILE 模拟支持子集）`,
    )
  }
  const organizationCode = asNonEmpty(
    payload['organization_code'] ?? payload['organizationCode'],
    'organization_code',
    'SAP-SIMENG-5',
  )
  const plantCode = asNonEmpty(payload['plant_code'] ?? payload['plantCode'], 'plant_code', 'SAP-SIMENG-5')
  const bkRaw = payload['business_key'] ?? payload['businessKey']
  const businessKey = typeof bkRaw === 'string' && bkRaw.trim() !== '' ? bkRaw.trim() : null
  const bodyRaw = payload['payload']
  const body =
    bodyRaw !== undefined && typeof bodyRaw === 'object' && bodyRaw !== null && !Array.isArray(bodyRaw)
      ? (bodyRaw as Record<string, unknown>)
      : {}
  const occurredRaw = payload['occurred_at'] ?? payload['occurredAt']
  return {
    eventKey,
    topic,
    organizationCode,
    plantCode,
    businessKey,
    sourceVersion: asOptionalInt(payload['source_version'] ?? payload['sourceVersion']),
    parentVersion: asOptionalInt(payload['parent_version'] ?? payload['parentVersion']),
    occurredAt: typeof occurredRaw === 'string' && occurredRaw.trim() !== '' ? occurredRaw.trim() : null,
    sequence: asOptionalInt(payload['sequence']),
    payload: body,
  }
}

export function sha256OfPayload(payload: Record<string, unknown>): string {
  const stable = JSON.stringify(payload, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const object = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]))
  })
  return createHash('sha256').update(stable).digest('hex')
}

/** Reference rows contain source identities and movements, never closing balances or expected results. */
export const SAP_SIM_REFERENCE_COLUMNS = {
  entities: ['id', 'sap_company_code'],
  plants: ['id', 'sap_plant', 'entity_id'],
  materials: ['id', 'sap_material', 'unit', 'quantity_basis', 'type'],
  material_mappings: ['id', 'plant_id', 'sap_material', 'sap_unit', 'material_id', 'mom_unit', 'factor', 'version'],
  stock_objects: ['id', 'material_id', 'issuer_plant_id', 'original_order_id', 'supplier_lot', 'unit', 'basis', 'segment_m'],
  orders: ['id', 'plant_id', 'entity_id', 'material_id', 'unit', 'basis', 'global_key', 'bom_route_id', 'version'],
  feeds: ['id', 'run_id', 'order_id', 'source_object_id', 'material_id', 'plant_id', 'qty', 'unit', 'basis'],
  raw_issues: ['id', 'run_id', 'order_id', 'object_id', 'material_id', 'qty_kg'],
  transfers: ['id', 'origin_plant_id', 'destination_plant_id', 'source_entity_id', 'destination_entity_id', 'title_rule'],
  transfer_lines: ['id', 'transfer_id', 'object_id', 'qty', 'unit'],
  inventory_events: ['id', 'object_id', 'at', 'plant_context_id', 'action', 'delta', 'unit', 'document_id'],
} as const

export type SapSimReferenceTable = keyof typeof SAP_SIM_REFERENCE_COLUMNS
export type SapSimReferenceRow = Record<string, string>
export interface SapSimReferenceData {
  version: string
  sources: Record<SapSimReferenceTable, { path: string; sha256: string }>
  tables: Record<SapSimReferenceTable, SapSimReferenceRow[]>
}

/** Validate the plant-scoped enrichment carried by a separate MASTER_VERSION_BUNDLE event. */
export function assertSapSimReferenceData(
  raw: unknown,
  organizationCode: string,
  plantCode: string,
): SapSimReferenceData {
  const fail = (reason: string): never => { throw new SapSimRuleViolation('SAP-SIMENG-17', reason) }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('reference_data 必须为对象')
  const data = raw as SapSimReferenceData
  if (Object.keys(data).some((k) => !['version', 'sources', 'tables'].includes(k)) ||
      typeof data.version !== 'string' || !data.version.trim() || !data.sources || !data.tables) {
    return fail('reference_data 仅接受 version/sources/tables')
  }
  const names = Object.keys(SAP_SIM_REFERENCE_COLUMNS) as SapSimReferenceTable[]
  if (Object.keys(data.sources).some((k) => !names.includes(k as SapSimReferenceTable)) ||
      Object.keys(data.tables).some((k) => !names.includes(k as SapSimReferenceTable))) return fail('未知引用表')
  for (const name of names) {
    const source = data.sources[name]
    if (!source || typeof source.path !== 'string' || !source.path.endsWith(`/${name}.csv`) ||
        typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) return fail(`${name} 缺可追溯来源摘要`)
    const rows = data.tables[name]
    if (!Array.isArray(rows)) return fail(`${name} 必须为行数组`)
    const ids = new Set<string>()
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          Object.keys(row).some((k) => !(SAP_SIM_REFERENCE_COLUMNS[name] as readonly string[]).includes(k)) ||
          Object.values(row).some((v) => typeof v !== 'string') || !row['id'] || ids.has(row['id'])) {
        return fail(`${name} 行身份重复、无效或包含非引用字段`)
      }
      ids.add(row['id'])
    }
  }
  const t = data.tables
  const find = (name: SapSimReferenceTable, id: string) => t[name].find((r) => r['id'] === id)
  const entityAliases = new Map<string, string>()
  for (const row of t.entities) {
    if (!row['sap_company_code']) return fail('法人缺可证的公司代码')
    for (const alias of [row['id'], row['sap_company_code']]) {
      if (entityAliases.has(alias) && entityAliases.get(alias) !== row['id']) return fail('法人别名映射歧义')
      entityAliases.set(alias, row['id'])
    }
  }
  if (t.plants.some((row) => !find('entities', row['entity_id']))) return fail('工厂法人引用无效')
  const localPlant = t.plants.find((r) => r['sap_plant'] === plantCode && r['entity_id'] === organizationCode)
  if (!localPlant) return fail('引用 scope 与消息组织/工厂不符')
  const positive = (value: string) => value !== '' && Number.isFinite(Number(value)) && Number(value) > 0
  for (const row of t.materials) {
    if (!row['unit'] || !row['quantity_basis']) return fail('物料缺 unit/basis')
  }
  for (const row of t.stock_objects) {
    const material = find('materials', row['material_id'])
    if (!material || !find('plants', row['issuer_plant_id']) || row['unit'] !== material['unit'] ||
        row['basis'] !== material['quantity_basis']) return fail(`对象 ${row['id']} 的 SKU/unit/basis 引用无效`)
  }
  for (const row of t.material_mappings) {
    const material = find('materials', row['material_id'])
    if (row['plant_id'] !== localPlant['id'] || !material || row['sap_material'] !== material['sap_material'] || row['mom_unit'] !== material['unit'] ||
        row['sap_unit']?.toLowerCase() !== row['mom_unit']?.toLowerCase() || Number(row['factor']) !== 1) return fail('物料映射跨 scope 或缺已支持的单位映射')
  }
  for (const row of t.orders) {
    const material = find('materials', row['material_id'])
    const identity = row['global_key']?.split('|')
    if (row['plant_id'] !== localPlant['id'] || row['entity_id'] !== organizationCode || !material ||
        identity?.[1] !== organizationCode || identity?.[2] !== plantCode || identity?.[3] !== 'PRODUCTION' ||
        row['unit'] !== material['unit'] || row['basis'] !== material['quantity_basis']) return fail('订单引用跨 scope 或计量不符')
  }
  for (const row of t.feeds) {
    const object = find('stock_objects', row['source_object_id'])
    if (!find('orders', row['order_id']) || row['plant_id'] !== localPlant['id'] || !object ||
        row['material_id'] !== object['material_id'] || row['unit'] !== object['unit'] ||
        row['basis'] !== object['basis'] || !positive(row['qty'])) return fail('投料引用或数量无效')
  }
  for (const row of t.raw_issues) {
    const object = find('stock_objects', row['object_id'])
    if (!find('orders', row['order_id']) || !object || row['material_id'] !== object['material_id'] ||
        object['unit'] !== 'kg' || !positive(row['qty_kg'])) return fail('原料领用引用或数量无效')
  }
  for (const row of t.transfers) {
    const from = find('plants', row['origin_plant_id'])
    const to = find('plants', row['destination_plant_id'])
    const sameOwner = row['source_entity_id'] === row['destination_entity_id']
    if (!from || !to || from['entity_id'] !== row['source_entity_id'] || to['entity_id'] !== row['destination_entity_id'] ||
        ![row['origin_plant_id'], row['destination_plant_id']].includes(localPlant['id']) ||
        row['title_rule'] !== (sameOwner ? '法人内所有权不变' : '目的厂接收时所有权转移_SIM合同约定')) return fail('转运组织/工厂或所有权规则无效')
  }
  for (const row of t.transfer_lines) {
    const object = find('stock_objects', row['object_id'])
    if (!find('transfers', row['transfer_id']) || !object || row['unit'] !== object['unit'] || !positive(row['qty'])) {
      return fail('转运行对象/单位或数量引用无效')
    }
  }
  for (const row of t.inventory_events) {
    const object = find('stock_objects', row['object_id'])
    const delta = row['delta'] === '' ? NaN : Number(row['delta'])
    if (!object || row['plant_context_id'] !== localPlant['id'] || row['unit'] !== object['unit'] ||
        !row['document_id'] || !row['at'] || !Number.isFinite(Date.parse(row['at'])) || !Number.isFinite(delta) ||
        !((row['action'] === 'APPROVED_ABNORMAL_DEDUCTION' && delta < 0) ||
          (row['action'] === 'SIM_PHYSICAL_DISPOSITION' && delta > 0))) return fail('返工来源事件的身份/动作/增减量无效')
  }
  return data
}

/** Separate digest: existing event payload/request digests retain their original algorithm and bytes. */
export function sha256OfSapSimReferenceData(data: SapSimReferenceData): string {
  return sha256OfPayload({ ...data })
}

/** 故障场景配置项（场景配置文件 sap-sim-fault-scenarios.ts 的元素）。 */
export interface SapSimFaultScenarioConfig {
  scenario_no: string
  fault_type: SapSimFaultType
  /** 精确匹配事件键（与 match_topic 至少一个） */
  match_event_key?: string | null
  match_topic?: string | null
  /** 注入次数（每次命中消耗 1；<=0 表示不限） */
  count: number
  delay_ms?: number | null
  /** REORDER：按此顺序放行（event_key 列表） */
  reorder_keys?: string[] | null
  description: string
}

export function assertSapSimFaultScenarioConfig(payload: Record<string, unknown>): SapSimFaultScenarioConfig {
  const scenarioNo = asNonEmpty(
    payload['scenario_no'] ?? payload['scenarioNo'],
    'scenario_no',
    'SAP-SIMENG-6',
  )
  const faultTypeRaw = asNonEmpty(payload['fault_type'] ?? payload['faultType'], 'fault_type', 'SAP-SIMENG-6')
  if (!(SAP_SIM_FAULT_TYPES as readonly string[]).includes(faultTypeRaw)) {
    throw new SapSimRuleViolation(
      'SAP-SIMENG-6',
      `fault_type 须为 ${SAP_SIM_FAULT_TYPES.join('/')}`,
    )
  }
  const faultType = faultTypeRaw as SapSimFaultType
  const mek = payload['match_event_key'] ?? payload['matchEventKey']
  const mt = payload['match_topic'] ?? payload['matchTopic']
  const matchEventKey = typeof mek === 'string' && mek.trim() !== '' ? mek.trim() : null
  const matchTopic = typeof mt === 'string' && mt.trim() !== '' ? mt.trim() : null
  if (!matchEventKey && !matchTopic) {
    throw new SapSimRuleViolation('SAP-SIMENG-6', 'match_event_key / match_topic 至少一个')
  }
  const countRaw = payload['count'] ?? payload['remaining_count'] ?? payload['remainingCount']
  const count = typeof countRaw === 'number' ? Math.trunc(countRaw) : Number(countRaw)
  if (!Number.isFinite(count) || count < 0) {
    throw new SapSimRuleViolation('SAP-SIMENG-6', 'count 须为非负整数')
  }
  const dmRaw = payload['delay_ms'] ?? payload['delayMs']
  const delayMs =
    typeof dmRaw === 'number' ? Math.trunc(dmRaw) : dmRaw === undefined ? null : Number(dmRaw)
  if (delayMs !== null && (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 5000)) {
    throw new SapSimRuleViolation('SAP-SIMENG-6', 'delay_ms 须为 0..5000ms（本地模拟上限）')
  }
  const rkRaw = payload['reorder_keys'] ?? payload['reorderKeys']
  const reorderKeys = Array.isArray(rkRaw)
    ? rkRaw.filter((k): k is string => typeof k === 'string' && k.trim() !== '').map((k) => k.trim())
    : null
  if (faultType === 'REORDER' && (!reorderKeys || reorderKeys.length < 2)) {
    throw new SapSimRuleViolation('SAP-SIMENG-6', 'REORDER 需 reorder_keys（≥2 个 event_key 的放行顺序）')
  }
  const descRaw = payload['description'] ?? payload['desc']
  return {
    scenario_no: scenarioNo,
    fault_type: faultType,
    match_event_key: matchEventKey,
    match_topic: matchTopic,
    count,
    delay_ms: delayMs,
    reorder_keys: reorderKeys,
    description: typeof descRaw === 'string' ? descRaw : '',
  }
}

/** 故障场景是否命中给定事件。 */
export function faultScenarioMatches(
  scenario: { faultType: string; matchEventKey: string | null; matchTopic: string | null; active: boolean },
  event: { eventKey: string; topic: string },
): boolean {
  if (!scenario.active) return false
  if (scenario.matchEventKey && scenario.matchEventKey !== event.eventKey) return false
  if (scenario.matchTopic && scenario.matchTopic !== event.topic) return false
  return true
}

/** 开账库存输入契约（模拟侧主数据补给；仅写 sim_sap_stock）。 */
export function assertSapSimOpeningStockPayload(payload: Record<string, unknown>): {
  organizationCode: string
  plantCode: string
  materialId: string
  unit: string
  qty: number
} {
  const organizationCode = asNonEmpty(
    payload['organization_code'] ?? payload['organizationCode'],
    'organization_code',
    'SAP-SIMENG-7',
  )
  const plantCode = asNonEmpty(payload['plant_code'] ?? payload['plantCode'], 'plant_code', 'SAP-SIMENG-7')
  const materialId = asNonEmpty(payload['material_id'] ?? payload['materialId'], 'material_id', 'SAP-SIMENG-7')
  const unit = asNonEmpty(payload['unit'], 'unit', 'SAP-SIMENG-7')
  const qtyRaw = payload['qty']
  const qty = typeof qtyRaw === 'number' ? qtyRaw : Number(qtyRaw)
  if (!Number.isFinite(qty) || qty < 0) {
    throw new SapSimRuleViolation('SAP-SIMENG-7', 'qty 须为非负数')
  }
  return { organizationCode, plantCode, materialId, unit, qty }
}
