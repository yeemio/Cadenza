import { SapSimRuleViolation } from './errors'

/** SAP_SIM 边界常量：永不声称真实接通。 */
export const SAP_SIM_SOURCE_SYSTEM = 'SAP_SIM' as const
export const SAP_SIM_ACTUAL_CONNECTION = false as const

export const SAP_SIM_OUTBOX_STATUSES = [
  'PENDING',
  'DISPATCHED',
  'FAILED',
  'NOOP_NEEDED',
  'SYNC_FAILED',
  'EXTERNAL_UNKNOWN',
] as const
export type SapSimOutboxStatus = (typeof SAP_SIM_OUTBOX_STATUSES)[number]

export const SAP_SIM_INBOX_STATUSES = ['PENDING', 'PROCESSED', 'QUARANTINED', 'FAILED'] as const
export type SapSimInboxStatus = (typeof SAP_SIM_INBOX_STATUSES)[number]

function asNonEmpty(v: unknown, field: string, rule: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new SapSimRuleViolation(rule, `缺少必填字段 ${field}`)
  }
  return v.trim()
}

/** POST /integrations/sap-sim/messages 最小合法信封。 */
export function assertSapSimMessageEnvelope(payload: Record<string, unknown>): {
  sourceSystem: typeof SAP_SIM_SOURCE_SYSTEM
  organizationCode: string
  externalKey: string
  entityType: string
  aggregateType: string
  aggregateId: string
  taskKind: string
  plantCode?: string
  externalRevision?: string
  body: Record<string, unknown>
} {
  const sourceRaw = asNonEmpty(payload['source_system'] ?? payload['sourceSystem'], 'source_system', 'SAP-A3')
  if (sourceRaw !== SAP_SIM_SOURCE_SYSTEM) {
    throw new SapSimRuleViolation('SAP-A3', `source_system 必须为 ${SAP_SIM_SOURCE_SYSTEM}（禁真实 SAP）`)
  }
  const organizationCode = asNonEmpty(
    payload['organization_code'] ?? payload['organizationCode'],
    'organization_code',
    'SAP-A3',
  )
  const externalKey = asNonEmpty(payload['external_key'] ?? payload['externalKey'], 'external_key', 'SAP-A3')
  const entityType = asNonEmpty(payload['entity_type'] ?? payload['entityType'], 'entity_type', 'SAP-A3')
  const aggregateType =
    typeof payload['aggregate_type'] === 'string' && payload['aggregate_type'].trim() !== ''
      ? payload['aggregate_type'].trim()
      : typeof payload['aggregateType'] === 'string' && payload['aggregateType'].trim() !== ''
        ? payload['aggregateType'].trim()
        : entityType
  const aggregateId =
    typeof payload['aggregate_id'] === 'string' && payload['aggregate_id'].trim() !== ''
      ? payload['aggregate_id'].trim()
      : typeof payload['aggregateId'] === 'string' && payload['aggregateId'].trim() !== ''
        ? payload['aggregateId'].trim()
        : externalKey
  const taskKind =
    typeof payload['task_kind'] === 'string' && payload['task_kind'].trim() !== ''
      ? payload['task_kind'].trim()
      : typeof payload['taskKind'] === 'string' && payload['taskKind'].trim() !== ''
        ? payload['taskKind'].trim()
        : `sap_sim.${entityType}`
  const plantCodeRaw = payload['plant_code'] ?? payload['plantCode']
  const plantCode =
    typeof plantCodeRaw === 'string' && plantCodeRaw.trim() !== '' ? plantCodeRaw.trim() : undefined
  const revRaw = payload['external_revision'] ?? payload['externalRevision']
  const externalRevision =
    typeof revRaw === 'string' && revRaw.trim() !== '' ? revRaw.trim() : undefined
  const body =
    payload['payload'] !== undefined && typeof payload['payload'] === 'object' && payload['payload'] !== null
      ? (payload['payload'] as Record<string, unknown>)
      : payload
  return {
    sourceSystem: SAP_SIM_SOURCE_SYSTEM,
    organizationCode,
    externalKey,
    entityType,
    aggregateType,
    aggregateId,
    taskKind,
    plantCode,
    externalRevision,
    body,
  }
}

/** POST /integrations/outbox 入队契约。 */
export function assertOutboxEnqueuePayload(payload: Record<string, unknown>): {
  aggregateType: string
  aggregateId: string
  taskKind: string
  sourceSystem: string
  externalKey: string
  organizationCode: string
  entityType: string
  status: SapSimOutboxStatus
  body: Record<string, unknown>
} {
  const aggregateType = asNonEmpty(
    payload['aggregate_type'] ?? payload['aggregateType'],
    'aggregate_type',
    'SAP-B5',
  )
  const aggregateId = asNonEmpty(
    payload['aggregate_id'] ?? payload['aggregateId'],
    'aggregate_id',
    'SAP-B5',
  )
  const taskKind = asNonEmpty(payload['task_kind'] ?? payload['taskKind'], 'task_kind', 'SAP-B5')
  const sourceSystem = asNonEmpty(
    payload['source_system'] ?? payload['sourceSystem'],
    'source_system',
    'SAP-B5',
  )
  const externalKey = asNonEmpty(payload['external_key'] ?? payload['externalKey'], 'external_key', 'SAP-B5')
  const organizationCode = asNonEmpty(
    payload['organization_code'] ?? payload['organizationCode'],
    'organization_code',
    'SAP-B5',
  )
  const entityType = asNonEmpty(payload['entity_type'] ?? payload['entityType'], 'entity_type', 'SAP-B5')
  const statusRaw = payload['status']
  let status: SapSimOutboxStatus = 'PENDING'
  if (typeof statusRaw === 'string' && statusRaw.trim() !== '') {
    const s = statusRaw.trim()
    if (!(SAP_SIM_OUTBOX_STATUSES as readonly string[]).includes(s)) {
      throw new SapSimRuleViolation('SAP-B4', `status 须为 ${SAP_SIM_OUTBOX_STATUSES.join('/')}`)
    }
    status = s as SapSimOutboxStatus
  }
  const body =
    payload['payload'] !== undefined && typeof payload['payload'] === 'object' && payload['payload'] !== null
      ? (payload['payload'] as Record<string, unknown>)
      : {}
  return {
    aggregateType,
    aggregateId,
    taskKind,
    sourceSystem,
    externalKey,
    organizationCode,
    entityType,
    status,
    body,
  }
}

/** POST /integrations/inbox 入站契约。 */
export function assertInboxEnqueuePayload(payload: Record<string, unknown>): {
  sourceSystem: string
  organizationCode: string
  externalKey: string
  entityType: string
  externalRevision?: string
  forceQuarantine: boolean
  quarantineReason?: string
  body: Record<string, unknown>
} {
  const sourceSystem = asNonEmpty(
    payload['source_system'] ?? payload['sourceSystem'],
    'source_system',
    'SAP-B5',
  )
  const organizationCode = asNonEmpty(
    payload['organization_code'] ?? payload['organizationCode'],
    'organization_code',
    'SAP-B5',
  )
  const externalKey = asNonEmpty(payload['external_key'] ?? payload['externalKey'], 'external_key', 'SAP-B5')
  const entityType = asNonEmpty(payload['entity_type'] ?? payload['entityType'], 'entity_type', 'SAP-B5')
  const revRaw = payload['external_revision'] ?? payload['externalRevision']
  const externalRevision =
    typeof revRaw === 'string' && revRaw.trim() !== '' ? revRaw.trim() : undefined
  const forceQuarantine = payload['forceQuarantine'] === true || payload['quarantine'] === true
  const qr = payload['quarantine_reason'] ?? payload['quarantineReason']
  const quarantineReason = typeof qr === 'string' && qr.trim() !== '' ? qr.trim() : undefined
  const body =
    payload['payload'] !== undefined && typeof payload['payload'] === 'object' && payload['payload'] !== null
      ? (payload['payload'] as Record<string, unknown>)
      : {}
  return {
    sourceSystem,
    organizationCode,
    externalKey,
    entityType,
    externalRevision,
    forceQuarantine,
    quarantineReason,
    body,
  }
}

/** E08 尝试结果枚举（SIM 剧本；≠ 真实 SAP 回执）。含 P4 + P5 加深；≠ 56/65 全量。 */
export const SAP_SIM_ATTEMPT_OUTCOMES = [
  'TIMEOUT_UNKNOWN',
  'FOUND_COMMITTED',
  'CONFIRMED_BY_QUERY',
  'QUERY_UNAVAILABLE',
  'OUTCOME_UNKNOWN',
  'NOOP',
  'CANCELLED',
  'REORDER_ACCEPTED',
  // P5：质量收到未应用（≠ disposition 全盘）
  'RECEIVED_NOT_APPLIED',
  // P5：拒绝 / 陈旧 / 等父版本（≠ 重开 A1000/B1000）
  'REJECT_ALREADY_PRODUCED',
  'REJECT_ORGANIZATION_MISMATCH',
  'REJECTED_MISSING_REWORK_ORDER',
  'STALE_NOOP',
  'WAIT_PARENT_VERSION',
  // P5：物流族可观察 outcome（非仅 PENDING）
  'ISSUE_CONFIRMED',
  'RECEIPT_CONFIRMED',
  'SHIPMENT_CONFIRMED',
  'CONSUMPTION_RECORDED',
  // P5：返工/报废/数量对账报文 ack（≠ 21 对象 RECON CLOSED）
  'REWORK_CLASSIFIED',
  'SCRAP_ACKNOWLEDGED',
  'QTYRECON_ACKNOWLEDGED',
  // P6：版本门控附带（≠ 重开 P5 REJECT-STALE 号）+ happy-path 切片（≠ 全量 APPLIED）
  'APPLIED_AFTER_PARENT',
  'APPLIED_ONCE',
  'LINES_CONFIRMED',
] as const
export type SapSimAttemptOutcome = (typeof SAP_SIM_ATTEMPT_OUTCOMES)[number]

/** 经 POST …/outbox/:eventId/attempt 可施加的加深 outcome（P5+P6；不含 A1000/B1000/cancel）。 */
export const SAP_SIM_P5_ATTEMPT_OUTCOMES = [
  'RECEIVED_NOT_APPLIED',
  'REJECT_ALREADY_PRODUCED',
  'REJECT_ORGANIZATION_MISMATCH',
  'REJECTED_MISSING_REWORK_ORDER',
  'STALE_NOOP',
  'WAIT_PARENT_VERSION',
  'ISSUE_CONFIRMED',
  'RECEIPT_CONFIRMED',
  'SHIPMENT_CONFIRMED',
  'CONSUMPTION_RECORDED',
  'REWORK_CLASSIFIED',
  'SCRAP_ACKNOWLEDGED',
  'QTYRECON_ACKNOWLEDGED',
  // P6
  'APPLIED_AFTER_PARENT',
  'APPLIED_ONCE',
  'LINES_CONFIRMED',
] as const
export type SapSimP5AttemptOutcome = (typeof SAP_SIM_P5_ATTEMPT_OUTCOMES)[number]

/** P6 happy-path / 版本门控附带 outcome 子集（≠ 全量 APPLIED；≠ 重开 REJECT-STALE 号）。 */
export const SAP_SIM_P6_ATTEMPT_OUTCOMES = [
  'APPLIED_AFTER_PARENT',
  'APPLIED_ONCE',
  'LINES_CONFIRMED',
] as const
export type SapSimP6AttemptOutcome = (typeof SAP_SIM_P6_ATTEMPT_OUTCOMES)[number]

/** 负面 / 门控 outcome：不得当成功 APPLIED。 */
export const SAP_SIM_NEGATIVE_ATTEMPT_OUTCOMES = [
  'RECEIVED_NOT_APPLIED',
  'REJECT_ALREADY_PRODUCED',
  'REJECT_ORGANIZATION_MISMATCH',
  'REJECTED_MISSING_REWORK_ORDER',
  'STALE_NOOP',
  'WAIT_PARENT_VERSION',
] as const

/** E08 报文工程切片建议 topic（P4 底座；≠ 56/65 全量）。 */
export const SAP_SIM_E08_SUBSET_TOPICS = [
  'EXECUTION_BUNDLE',
  'PRODUCTION_RELEASE',
  'PRODUCTION_OUTPUT',
  'GOODS_MOVEMENT',
  'QUALITY_STATUS',
] as const

/** P5 质量阻断 topic（MSG-QBLOCK 语义对照；自造抽象信封）。 */
export const SAP_SIM_E08_QUALITY_BLOCK_TOPICS = ['QUALITY_STOCK_BLOCK'] as const

/** P5 物流族 topic（工程切片）。 */
export const SAP_SIM_E08_LOGISTICS_TOPICS = [
  'STOCK_TRANSFER_ISSUE',
  'STOCK_TRANSFER_RECEIPT',
  'SHIPMENT_CONFIRM',
  'MATERIAL_CONSUMPTION',
] as const

/** P5 返工/报废/数量对账 topic（≠ 21 对象 CLOSED）。 */
export const SAP_SIM_E08_REWORK_SCRAP_QTYRECON_TOPICS = [
  'REWORK_RECLASSIFICATION',
  'SCRAP_CONFIRM',
  'QUANTITY_RECONCILIATION',
] as const

/** P6 主数据/版本门控 topic（± INTERMEDIATE 已并入；≠ 56/65 全量；≠ 重开 REJECT-STALE 号）。 */
export const SAP_SIM_E08_MASTER_REV_TOPICS = [
  'MASTER_VERSION_BUNDLE',
  'PRODUCTION_REVISION',
  'INTERMEDIATE_OUTPUT',
] as const

/** POST /integrations/outbox/:eventId/attempt 契约（P5）。 */
export function assertSapSimAttemptOutcome(payload: Record<string, unknown>): {
  outcome: SapSimP5AttemptOutcome
  claimApplied: boolean
  rekeyAttempt: string | null
} {
  const raw = payload['outcome'] ?? payload['attempt_outcome'] ?? payload['attemptOutcome']
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SapSimRuleViolation('SAP-E08-P5-1', '缺少必填字段 outcome（P5/P6 attempt）')
  }
  const outcome = raw.trim()
  if (!(SAP_SIM_P5_ATTEMPT_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new SapSimRuleViolation(
      'SAP-E08-P5-2',
      `outcome 须为 P5/P6 加深枚举之一（不含 A1000/B1000/cancel）：${SAP_SIM_P5_ATTEMPT_OUTCOMES.join('/')}`,
    )
  }
  const claimApplied =
    payload['treat_as_applied'] === true ||
    payload['treatAsApplied'] === true ||
    payload['claim_applied'] === true ||
    payload['claimApplied'] === true ||
    payload['as_applied'] === true ||
    payload['applied'] === true
  const rekeyRaw =
    payload['new_event_id'] ?? payload['newEventId'] ?? payload['rekey'] ?? payload['rekey_to']
  const rekeyAttempt =
    typeof rekeyRaw === 'string' && rekeyRaw.trim() !== '' ? rekeyRaw.trim() : null
  return { outcome: outcome as SapSimP5AttemptOutcome, claimApplied, rekeyAttempt }
}

/** POST /integrations/sap-sim/messages/subset 最小契约。 */
export function assertSapSimMessageSubset(payload: Record<string, unknown>): {
  envelopes: Record<string, unknown>[]
  subsetId: string
  allowReorder: boolean
} {
  const subsetIdRaw = payload['subset_id'] ?? payload['subsetId']
  const subsetId =
    typeof subsetIdRaw === 'string' && subsetIdRaw.trim() !== ''
      ? subsetIdRaw.trim()
      : `e08-subset-${Date.now()}`
  const allowReorder = payload['allow_reorder'] === true || payload['allowReorder'] === true
  const raw = payload['envelopes'] ?? payload['messages']
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new SapSimRuleViolation('SAP-E08-1', 'envelopes 不可为空数组（工程切片须可计数）')
    }
    const envelopes: Record<string, unknown>[] = []
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) {
        throw new SapSimRuleViolation('SAP-E08-1', 'envelopes[] 项必须为对象')
      }
      envelopes.push(item as Record<string, unknown>)
    }
    if (envelopes.length > 32) {
      throw new SapSimRuleViolation('SAP-E08-1', '子集 envelopes 最多 32 条（工程切片）')
    }
    return { envelopes, subsetId, allowReorder }
  }
  // 未传 envelopes → 用建议 topic 生成可计数抽象信封（仍须调用方补 organization_code 等由服务填默认）
  const topicsRaw = payload['topics']
  const topics: string[] =
    Array.isArray(topicsRaw) && topicsRaw.length > 0
      ? topicsRaw.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
      : [...SAP_SIM_E08_SUBSET_TOPICS]
  if (topics.length === 0) {
    throw new SapSimRuleViolation('SAP-E08-1', '缺少 envelopes 或 topics')
  }
  if (topics.length > 32) {
    throw new SapSimRuleViolation('SAP-E08-1', '子集 topics 最多 32 条')
  }
  const org =
    typeof (payload['organization_code'] ?? payload['organizationCode']) === 'string'
      ? String(payload['organization_code'] ?? payload['organizationCode']).trim()
      : 'LE-C100'
  const plant =
    typeof (payload['plant_code'] ?? payload['plantCode']) === 'string'
      ? String(payload['plant_code'] ?? payload['plantCode']).trim()
      : 'PLNT-CN11'
  const envelopes = topics.map((topic, idx) => ({
    source_system: SAP_SIM_SOURCE_SYSTEM,
    organization_code: org,
    plant_code: plant,
    external_key: `${subsetId}:${topic}:${idx + 1}`,
    entity_type: topic,
    task_kind: `sap_sim.${topic.toLowerCase()}`,
    aggregate_type: topic,
    aggregate_id: `${subsetId}:${topic}`,
    sequence: idx + 1,
    payload: {
      subset_id: subsetId,
      topic,
      sequence: idx + 1,
      actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      note: 'E08 engineering subset envelope; ≠ 56/65 full CLOSED',
    },
  }))
  return { envelopes, subsetId, allowReorder }
}
