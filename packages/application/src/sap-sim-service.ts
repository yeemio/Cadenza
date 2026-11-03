import { createHash } from 'node:crypto'
import {
  SAP_SIM_ACTUAL_CONNECTION,
  SAP_SIM_NEGATIVE_ATTEMPT_OUTCOMES,
  SAP_SIM_SOURCE_SYSTEM,
  SapSimRuleViolation,
  assertInboxEnqueuePayload,
  assertOutboxEnqueuePayload,
  assertSapSimAttemptOutcome,
  assertSapSimMessageEnvelope,
  assertSapSimMessageSubset,
  type SapSimP5AttemptOutcome,
} from '@cadenza/domain'
import type {
  SapSimInboxRecord,
  SapSimOutboxRecord,
  SapSimRepositories,
} from './sap-sim-repositories'
import type { SapSimFactQueryPort } from './sap-sim-engine-repositories'

/** 可发现路由清单（A1/A2 + P3/P4 加深 + R1 模拟引擎）；≠ shipping/purchase/conversion *sync*retry。 */
export const SAP_SIM_DISCOVERABLE_ROUTES = [
  { method: 'GET', path: '/integrations/sap-sim', purpose: 'adapter health / boundary' },
  { method: 'POST', path: '/integrations/sap-sim/messages', purpose: 'deliver abstract envelope → outbox' },
  {
    method: 'POST',
    path: '/integrations/sap-sim/messages/subset',
    purpose: 'E08 engineering subset drill (countable envelopes; ≠ 56/65 full)',
  },
  { method: 'GET', path: '/integrations/sap-sim/messages/:id', purpose: 'fetch by outbox event_id' },
  {
    method: 'POST',
    path: '/integrations/sap-sim/execute',
    purpose:
      'R1 simulator execute business event → sim_sap facts → fact-derived receipt; expected_outcome input rejected 422',
  },
  {
    method: 'POST',
    path: '/integrations/sap-sim/dispatch/:outboxEventId',
    purpose: 'R1 drive simulator from outbox row (MOM command → outbox → sim facts → receipt → outbox update)',
  },
  {
    method: 'POST',
    path: '/integrations/sap-sim/query',
    purpose: 'R1 query sim_sap facts by original event key (A1000 backing; B1000 QUERY_UNAVAILABLE)',
  },
  {
    method: 'GET',
    path: '/integrations/sap-sim/facts/documents',
    purpose: 'R1 read sim_sap_document facts (simulator side only)',
  },
  { method: 'GET', path: '/integrations/sap-sim/facts/stock', purpose: 'R1 read sim_sap_stock facts' },
  { method: 'GET', path: '/integrations/sap-sim/facts/orders', purpose: 'R1 read sim_sap_order facts' },
  {
    method: 'POST',
    path: '/integrations/sap-sim/faults',
    purpose: 'R1 activate fault injection scenario (catalog by scenario_no or custom config)',
  },
  { method: 'GET', path: '/integrations/sap-sim/faults', purpose: 'R1 list fault scenarios (counts persisted)' },
  {
    method: 'DELETE',
    path: '/integrations/sap-sim/faults/:scenarioNo',
    purpose: 'R1 deactivate fault scenario',
  },
  {
    method: 'POST',
    path: '/integrations/sap-sim/stock',
    purpose: 'R1 simulator-side opening stock provisioning (sim_sap_stock only; SIM_ASSUMPTION)',
  },
  {
    method: 'POST',
    path: '/integrations/outbox/:eventId/fail',
    purpose: 'mark outbox FAILED (offline/fail sim); keep original keys',
  },
  {
    method: 'POST',
    path: '/integrations/outbox/:eventId/replay',
    purpose: 'replay/补传 after fail; preserve event_id+request_digest+external_ref',
  },
  {
    method: 'POST',
    path: '/integrations/outbox/:eventId/timeout-unknown',
    purpose: 'A1000/B1000: mark TIMEOUT_UNKNOWN (EXTERNAL_UNKNOWN); keep original keys',
  },
  {
    method: 'POST',
    path: '/integrations/outbox/:eventId/query-confirm',
    purpose: 'A1000: query by original key → FOUND_COMMITTED / CONFIRMED_BY_QUERY',
  },
  {
    method: 'POST',
    path: '/integrations/outbox/:eventId/query-unavailable',
    purpose: 'B1000: QUERY_UNAVAILABLE → OUTCOME_UNKNOWN hold; forbid zero/rekey',
  },
  {
    method: 'POST',
    path: '/integrations/outbox/:eventId/cancel',
    purpose: 'E08 cancel by original key → CANCELLED/NOOP_NEEDED; keep keys',
  },
  {
    method: 'POST',
    path: '/integrations/outbox/:eventId/attempt',
    purpose:
      'P5/P6 E08 attempt deepen: QBLOCK/REJECT/STALE/WAIT_PARENT/logistics/rework + APPLIED_AFTER_PARENT/APPLIED_ONCE/LINES_CONFIRMED; ≠ A1000/B1000; ≠ 56/65 full',
  },
  { method: 'GET', path: '/integrations/outbox', purpose: 'list outbox (empty total=0 ok)' },
  { method: 'POST', path: '/integrations/outbox', purpose: 'enqueue outbox; idempotent by request_digest' },
  { method: 'GET', path: '/integrations/inbox', purpose: 'list inbox (empty total=0 ok)' },
  { method: 'POST', path: '/integrations/inbox', purpose: 'ingest inbox; same key idempotent; missing map → QUARANTINED' },
] as const

function digestOf(parts: Record<string, string>): string {
  const stable = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k]}`)
    .join('|')
  return createHash('sha256').update(stable).digest('hex')
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function preservedKeys(row: SapSimOutboxRecord) {
  return {
    eventId: row.eventId,
    requestDigest: row.requestDigest,
    externalRef: row.externalRef,
  }
}

function assertKeysUnchanged(
  before: { eventId: string; requestDigest: string | null; externalRef: string | null },
  after: SapSimOutboxRecord,
  rule: string,
): void {
  if (
    after.eventId !== before.eventId ||
    after.requestDigest !== before.requestDigest ||
    after.externalRef !== before.externalRef
  ) {
    throw new SapSimRuleViolation(rule, '不得改变原事件键（event_id/request_digest/external_ref）')
  }
}

export class SapSimService {
  constructor(
    private readonly repos: SapSimRepositories,
    /** A1000/B1000 查询事实端口：queryConfirm 由 sim_sap 已提交事实回答（R1）。 */
    private readonly facts: SapSimFactQueryPort,
  ) {}

  /** A1/A2/A4：适配可发现 + 边界声明。 */
  adapterStatus(): Record<string, unknown> {
    return {
      adapter: 'SAP_SIM',
      source_system: SAP_SIM_SOURCE_SYSTEM,
      target: 'SAP_SIM',
      actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      real_sap: false,
      note: '模拟适配；不连真实 SAP；不持真实 URL/凭据；域内 shipping/purchase/conversion sync-retry 不得冒充本面；E08 子集≠56/65全量',
      routes: SAP_SIM_DISCOVERABLE_ROUTES,
    }
  }

  async listOutbox(query: {
    page?: number
    pageSize?: number
    status?: string
    taskKind?: string
    aggregateType?: string
  }): Promise<{ items: SapSimOutboxRecord[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, query.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20))
    const { total, items } = await this.repos.outbox.listPaged({
      status: query.status,
      taskKind: query.taskKind,
      aggregateType: query.aggregateType,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return { items, total, page, pageSize }
  }

  async listInbox(query: {
    page?: number
    pageSize?: number
    status?: string
    sourceSystem?: string
    organizationCode?: string
  }): Promise<{ items: SapSimInboxRecord[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, query.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20))
    const { total, items } = await this.repos.inbox.listPaged({
      status: query.status,
      sourceSystem: query.sourceSystem,
      organizationCode: query.organizationCode,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    return { items, total, page, pageSize }
  }

  async getMessage(id: string): Promise<SapSimOutboxRecord | null> {
    return this.repos.outbox.findByEventId(id)
  }

  /**
   * POST /integrations/sap-sim/messages
   * 投递抽象信封 → 写入 outbox（task_kind 独立 sap_sim.*）；幂等键=四元组 digest。
   * 同哈希再投 → created=false / noop=true（E08-dup）。
   */
  async deliverMessage(payload: Record<string, unknown>): Promise<{
    created: boolean
    noop: boolean
    actual_connection: false
    source_system: typeof SAP_SIM_SOURCE_SYSTEM
    outbox: SapSimOutboxRecord
  }> {
    const env = assertSapSimMessageEnvelope(payload)
    const requestDigest = digestOf({
      source_system: env.sourceSystem,
      organization_code: env.organizationCode,
      external_key: env.externalKey,
      entity_type: env.entityType,
      task_kind: env.taskKind,
    })
    const existing = await this.repos.outbox.findByRequestDigest(requestDigest)
    if (existing) {
      return {
        created: false,
        noop: true,
        actual_connection: SAP_SIM_ACTUAL_CONNECTION,
        source_system: SAP_SIM_SOURCE_SYSTEM,
        outbox: existing,
      }
    }
    const sequenceRaw = payload['sequence'] ?? asRecord(env.body)['sequence']
    const sequence =
      typeof sequenceRaw === 'number' && Number.isFinite(sequenceRaw)
        ? sequenceRaw
        : typeof sequenceRaw === 'string' && sequenceRaw.trim() !== '' && Number.isFinite(Number(sequenceRaw))
          ? Number(sequenceRaw)
          : null
    const outbox = await this.repos.outbox.insert({
      aggregateType: env.aggregateType,
      aggregateId: env.aggregateId,
      taskKind: env.taskKind,
      status: 'PENDING',
      requestDigest,
      externalRef: env.externalKey,
      payload: {
        source_system: env.sourceSystem,
        organization_code: env.organizationCode,
        external_key: env.externalKey,
        entity_type: env.entityType,
        plant_code: env.plantCode ?? null,
        external_revision: env.externalRevision ?? null,
        actual_connection: SAP_SIM_ACTUAL_CONNECTION,
        sequence,
        envelope: env.body,
      },
    })
    return {
      created: true,
      noop: false,
      actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      source_system: SAP_SIM_SOURCE_SYSTEM,
      outbox,
    }
  }

  /**
   * POST /integrations/sap-sim/messages/subset
   * E08 工程切片：一次投递可计数抽象信封子集；证据含条数+原键；≠ 56/65 全量。
   * allow_reorder=true 时按调用方给定顺序投递（可乱序），每条保留自身 external_key。
   */
  async deliverMessageSubset(payload: Record<string, unknown>): Promise<{
    actual_connection: false
    source_system: typeof SAP_SIM_SOURCE_SYSTEM
    subset_id: string
    count: number
    created_count: number
    noop_count: number
    scope: string
    original_keys: Array<{
      eventId: string
      externalRef: string | null
      requestDigest: string | null
      entity_type: string
      sequence: number | null
      arrival_index: number
      created: boolean
      noop: boolean
    }>
    items: Array<Awaited<ReturnType<SapSimService['deliverMessage']>>>
  }> {
    const { envelopes, subsetId, allowReorder } = assertSapSimMessageSubset(payload)
    let ordered = envelopes.map((e, i) => ({ env: e, arrival: i + 1 }))
    if (allowReorder) {
      // 调用方可传入乱序 envelopes；保持到达序投递（不按 sequence 重排写入）
      ordered = envelopes.map((e, i) => ({ env: e, arrival: i + 1 }))
    }
    const items: Array<Awaited<ReturnType<SapSimService['deliverMessage']>>> = []
    const original_keys: Array<{
      eventId: string
      externalRef: string | null
      requestDigest: string | null
      entity_type: string
      sequence: number | null
      arrival_index: number
      created: boolean
      noop: boolean
    }> = []
    for (const { env, arrival } of ordered) {
      const stamped = {
        ...env,
        payload: {
          ...asRecord(env['payload']),
          subset_id: subsetId,
          arrival_index: arrival,
          allow_reorder: allowReorder,
          reorder_accepted: allowReorder,
        },
      }
      const result = await this.deliverMessage(stamped)
      items.push(result)
      const seqRaw = result.outbox.payload?.['sequence']
      const sequence =
        typeof seqRaw === 'number'
          ? seqRaw
          : typeof seqRaw === 'string' && Number.isFinite(Number(seqRaw))
            ? Number(seqRaw)
            : null
      original_keys.push({
        eventId: result.outbox.eventId,
        externalRef: result.outbox.externalRef,
        requestDigest: result.outbox.requestDigest,
        entity_type: String(result.outbox.payload?.['entity_type'] ?? result.outbox.aggregateType),
        sequence,
        arrival_index: arrival,
        created: result.created,
        noop: result.noop,
      })
    }
    return {
      actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      source_system: SAP_SIM_SOURCE_SYSTEM,
      subset_id: subsetId,
      count: items.length,
      created_count: items.filter((i) => i.created).length,
      noop_count: items.filter((i) => i.noop).length,
      scope: 'E08 engineering subset; ≠ 56/65 full CLOSED; ≠ REAL-SAP; actual_connection=false',
      original_keys,
      items,
    }
  }

  /** POST /integrations/outbox */
  async enqueueOutbox(payload: Record<string, unknown>): Promise<{
    created: boolean
    actual_connection: false
    outbox: SapSimOutboxRecord
  }> {
    const env = assertOutboxEnqueuePayload(payload)
    const requestDigest = digestOf({
      source_system: env.sourceSystem,
      organization_code: env.organizationCode,
      external_key: env.externalKey,
      entity_type: env.entityType,
      task_kind: env.taskKind,
      aggregate_type: env.aggregateType,
      aggregate_id: env.aggregateId,
    })
    const existing = await this.repos.outbox.findByRequestDigest(requestDigest)
    if (existing) {
      return { created: false, actual_connection: SAP_SIM_ACTUAL_CONNECTION, outbox: existing }
    }
    const outbox = await this.repos.outbox.insert({
      aggregateType: env.aggregateType,
      aggregateId: env.aggregateId,
      taskKind: env.taskKind,
      status: env.status,
      requestDigest,
      externalRef: env.externalKey,
      payload: {
        source_system: env.sourceSystem,
        organization_code: env.organizationCode,
        external_key: env.externalKey,
        entity_type: env.entityType,
        actual_connection: SAP_SIM_ACTUAL_CONNECTION,
        body: env.body,
      },
    })
    return { created: true, actual_connection: SAP_SIM_ACTUAL_CONNECTION, outbox }
  }

  /**
   * POST /integrations/inbox
   * 同键幂等；缺映射（organization_code 以 UNMAPPED-/UNKNOWN 前缀或 forceQuarantine）→ QUARANTINED。
   */
  async enqueueInbox(payload: Record<string, unknown>): Promise<{
    created: boolean
    inbox: SapSimInboxRecord
  }> {
    const env = assertInboxEnqueuePayload(payload)
    const existing = await this.repos.inbox.findByKey({
      sourceSystem: env.sourceSystem,
      organizationCode: env.organizationCode,
      externalKey: env.externalKey,
      entityType: env.entityType,
    })
    if (existing) return { created: false, inbox: existing }

    const missingMap =
      env.forceQuarantine ||
      env.organizationCode.startsWith('UNMAPPED') ||
      env.organizationCode.startsWith('UNKNOWN') ||
      env.organizationCode === ''

    const status = missingMap ? 'QUARANTINED' : 'PENDING'
    const quarantineReason = missingMap
      ? env.quarantineReason ?? 'IF-00.8 missing organization/unit/work_center mapping'
      : null

    const inbox = await this.repos.inbox.insert({
      sourceSystem: env.sourceSystem,
      organizationCode: env.organizationCode,
      externalKey: env.externalKey,
      entityType: env.entityType,
      externalRevision: env.externalRevision ?? null,
      payload: {
        ...env.body,
        actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      },
      status,
      quarantineReason,
    })
    return { created: true, inbox }
  }

  /**
   * POST /integrations/outbox/:eventId/fail
   * 模拟断网/投递失败：status→FAILED，保留 event_id / request_digest / external_ref 原键。
   */
  async markOutboxFailed(
    eventId: string,
    opts?: { lastError?: string },
  ): Promise<{
    actual_connection: false
    preserved_keys: { eventId: string; requestDigest: string | null; externalRef: string | null }
    outbox: SapSimOutboxRecord
  }> {
    const id = typeof eventId === 'string' ? eventId.trim() : ''
    if (!id) throw new SapSimRuleViolation('SAP-OFFLINE-1', '缺少必填字段 eventId')
    const existing = await this.repos.outbox.findByEventId(id)
    if (!existing) throw new SapSimRuleViolation('SAP-OFFLINE-2', `outbox 行不存在 eventId=${id}`)
    const updated = await this.repos.outbox.updateDelivery(id, {
      status: 'FAILED',
      lastError: opts?.lastError ?? 'SAP_SIM offline / delivery failed (simulated)',
      nextRetryAt: new Date(),
      bumpAttempt: true,
    })
    if (!updated) throw new SapSimRuleViolation('SAP-OFFLINE-2', `outbox 行不存在 eventId=${id}`)
    return {
      actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      preserved_keys: preservedKeys(updated),
      outbox: updated,
    }
  }

  /**
   * POST /integrations/outbox/:eventId/replay
   * 失败后补传/重放：status→DISPATCHED；**不得**另造 event_id / request_digest / external_ref。
   */
  async replayOutbox(eventId: string): Promise<{
    actual_connection: false
    replayed: true
    original_keys_preserved: true
    preserved_keys: {
      eventId: string
      requestDigest: string | null
      externalRef: string | null
      requestDigestUnchanged: boolean
      externalRefUnchanged: boolean
      eventIdUnchanged: boolean
    }
    before_status: string
    outbox: SapSimOutboxRecord
  }> {
    const id = typeof eventId === 'string' ? eventId.trim() : ''
    if (!id) throw new SapSimRuleViolation('SAP-OFFLINE-1', '缺少必填字段 eventId')
    const existing = await this.repos.outbox.findByEventId(id)
    if (!existing) throw new SapSimRuleViolation('SAP-OFFLINE-2', `outbox 行不存在 eventId=${id}`)
    const replayable = ['FAILED', 'SYNC_FAILED', 'EXTERNAL_UNKNOWN', 'PENDING']
    if (!replayable.includes(existing.status)) {
      throw new SapSimRuleViolation(
        'SAP-OFFLINE-3',
        `仅 FAILED/SYNC_FAILED/EXTERNAL_UNKNOWN/PENDING 可补传（当前=${existing.status}）`,
      )
    }
    // B1000 冻结中禁止用 replay 冒充证实 / 当 0
    const pl = asRecord(existing.payload)
    if (pl['hold'] === true || pl['attempt_outcome'] === 'QUERY_UNAVAILABLE') {
      throw new SapSimRuleViolation(
        'SAP-B1000-3',
        'B1000 UNKNOWN hold 中禁止 replay 冒充成功（禁当 0 / 换键）',
      )
    }
    const before = preservedKeys(existing)
    const updated = await this.repos.outbox.updateDelivery(id, {
      status: 'DISPATCHED',
      clearLastError: true,
      nextRetryAt: null,
      bumpAttempt: true,
    })
    if (!updated) throw new SapSimRuleViolation('SAP-OFFLINE-2', `outbox 行不存在 eventId=${id}`)
    assertKeysUnchanged(before, updated, 'SAP-OFFLINE-4')
    return {
      actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      replayed: true,
      original_keys_preserved: true,
      preserved_keys: {
        ...preservedKeys(updated),
        requestDigestUnchanged: updated.requestDigest === before.requestDigest,
        externalRefUnchanged: updated.externalRef === before.externalRef,
        eventIdUnchanged: updated.eventId === before.eventId,
      },
      before_status: existing.status,
      outbox: updated,
    }
  }

  /**
   * POST /integrations/outbox/:eventId/timeout-unknown
   * A1000/B1000 前置：TIMEOUT_UNKNOWN → status EXTERNAL_UNKNOWN；保留原键。
   */
  async markTimeoutUnknown(eventId: string): Promise<{
    actual_connection: false
    attempt_outcome: 'TIMEOUT_UNKNOWN'
    original_keys_preserved: true
    preserved_keys: ReturnType<typeof preservedKeys>
    outbox: SapSimOutboxRecord
  }> {
    const id = typeof eventId === 'string' ? eventId.trim() : ''
    if (!id) throw new SapSimRuleViolation('SAP-A1000-1', '缺少必填字段 eventId')
    const existing = await this.repos.outbox.findByEventId(id)
    if (!existing) throw new SapSimRuleViolation('SAP-A1000-2', `outbox 行不存在 eventId=${id}`)
    const before = preservedKeys(existing)
    const updated = await this.repos.outbox.updateDelivery(id, {
      status: 'EXTERNAL_UNKNOWN',
      lastError: 'TIMEOUT_UNKNOWN (SAP_SIM simulated)',
      bumpAttempt: true,
      payloadMerge: {
        attempt_outcome: 'TIMEOUT_UNKNOWN',
        timeout_unknown: true,
        actual_connection: SAP_SIM_ACTUAL_CONNECTION,
        original_event_id: existing.eventId,
      },
    })
    if (!updated) throw new SapSimRuleViolation('SAP-A1000-2', `outbox 行不存在 eventId=${id}`)
    assertKeysUnchanged(before, updated, 'SAP-A1000-4')
    return {
      actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      attempt_outcome: 'TIMEOUT_UNKNOWN',
      original_keys_preserved: true,
      preserved_keys: preservedKeys(updated),
      outbox: updated,
    }
  }

  /**
   * POST /integrations/outbox/:eventId/query-confirm
   * A1000：按**原事件键**查询 → 由 sim_sap 已提交事实回答：
   * - 有已提交事实 → FOUND_COMMITTED / CONFIRMED_BY_QUERY（带模拟单据号证据）；
   * - 无事实 → NOT_FOUND（保持 EXTERNAL_UNKNOWN，不换键、不当 0）；
   * - 查询不可用（B1000 故障注入）→ QUERY_UNAVAILABLE → OUTCOME_UNKNOWN hold（不暗中重试）。
   */
  async queryConfirm(
    eventId: string,
    body?: Record<string, unknown>,
  ): Promise<{
    actual_connection: false
    attempt_outcome: 'FOUND_COMMITTED' | 'NOT_FOUND' | 'QUERY_UNAVAILABLE'
    confirmation: 'CONFIRMED_BY_QUERY' | null
    query_answered_by: 'sim_sap_facts'
    queried_by_original_key: true
    original_keys_preserved: true
    preserved_keys: ReturnType<typeof preservedKeys>
    before_status: string
    outbox: SapSimOutboxRecord
    sim_fact?: {
      found: boolean
      doc_no?: string | null
      doc_type?: string | null
      qty?: number | string | null
      unit?: string | null
      committed_at?: string | null
    }
  }> {
    const id = typeof eventId === 'string' ? eventId.trim() : ''
    if (!id) throw new SapSimRuleViolation('SAP-A1000-1', '缺少必填字段 eventId')
    const payload = body ?? {}
    const altKey =
      payload['event_id'] ?? payload['eventId'] ?? payload['external_key'] ?? payload['externalKey']
    if (typeof altKey === 'string' && altKey.trim() !== '' && altKey.trim() !== id) {
      throw new SapSimRuleViolation('SAP-A1000-5', '查询证实必须使用原事件键；禁止换键冒充 FOUND_COMMITTED')
    }
    if (payload['treat_as_zero'] === true || payload['as_zero'] === true) {
      throw new SapSimRuleViolation('SAP-A1000-6', 'TIMEOUT 不得当 0 处理')
    }
    const existing = await this.repos.outbox.findByEventId(id)
    if (!existing) throw new SapSimRuleViolation('SAP-A1000-2', `outbox 行不存在 eventId=${id}`)
    const pl = asRecord(existing.payload)
    if (pl['hold'] === true || pl['attempt_outcome'] === 'QUERY_UNAVAILABLE') {
      throw new SapSimRuleViolation(
        'SAP-A1000-7',
        'B1000 UNKNOWN hold 不可走 A1000 query-confirm（剧本互斥）',
      )
    }
    const eligible =
      existing.status === 'EXTERNAL_UNKNOWN' ||
      pl['attempt_outcome'] === 'TIMEOUT_UNKNOWN' ||
      pl['timeout_unknown'] === true
    if (!eligible) {
      throw new SapSimRuleViolation(
        'SAP-A1000-3',
        `仅 TIMEOUT_UNKNOWN/EXTERNAL_UNKNOWN 可查询证实（当前 status=${existing.status} outcome=${String(pl['attempt_outcome'] ?? '')}）`,
      )
    }
    const before = preservedKeys(existing)

    // 查询由模拟 SAP 侧事实回答（R1）：模拟侧键 = external_ref（冻结事件键）
    const simKey = existing.externalRef ?? existing.eventId
    const answer = await this.facts.queryByEventKey(simKey)

    // B1000：查询通道不可用 → OUTCOME_UNKNOWN hold（原键不变，不暗中重试）
    if (!answer.available) {
      const updated = await this.repos.outbox.updateDelivery(id, {
        status: 'EXTERNAL_UNKNOWN',
        lastError: 'QUERY_UNAVAILABLE → OUTCOME_UNKNOWN (sim_sap 查询不可用 hold)',
        bumpAttempt: true,
        payloadMerge: {
          attempt_outcome: 'QUERY_UNAVAILABLE',
          outcome: 'OUTCOME_UNKNOWN',
          external_unknown: true,
          hold: true,
          zeroed: false,
          rekeyed: false,
          original_event_id: existing.eventId,
          query_answered_by: 'sim_sap_facts',
          actual_connection: SAP_SIM_ACTUAL_CONNECTION,
        },
      })
      if (!updated) throw new SapSimRuleViolation('SAP-A1000-2', `outbox 行不存在 eventId=${id}`)
      assertKeysUnchanged(before, updated, 'SAP-A1000-4')
      return {
        actual_connection: SAP_SIM_ACTUAL_CONNECTION,
        attempt_outcome: 'QUERY_UNAVAILABLE',
        confirmation: null,
        query_answered_by: 'sim_sap_facts',
        queried_by_original_key: true,
        original_keys_preserved: true,
        preserved_keys: preservedKeys(updated),
        before_status: existing.status,
        outbox: updated,
        sim_fact: { found: false },
      }
    }

    // A1000：无已提交事实 → NOT_FOUND（保持 UNKNOWN，不换键、不当 0）
    if (!answer.found) {
      const updated = await this.repos.outbox.updateDelivery(id, {
        status: 'EXTERNAL_UNKNOWN',
        lastError: 'QUERY_NOT_FOUND (sim_sap 无已提交事实；保持 UNKNOWN)',
        bumpAttempt: true,
        payloadMerge: {
          attempt_outcome: 'NOT_FOUND',
          query_answered_by: 'sim_sap_facts',
          query_found: false,
          zeroed: false,
          rekeyed: false,
          original_event_id: existing.eventId,
          actual_connection: SAP_SIM_ACTUAL_CONNECTION,
        },
      })
      if (!updated) throw new SapSimRuleViolation('SAP-A1000-2', `outbox 行不存在 eventId=${id}`)
      assertKeysUnchanged(before, updated, 'SAP-A1000-4')
      return {
        actual_connection: SAP_SIM_ACTUAL_CONNECTION,
        attempt_outcome: 'NOT_FOUND',
        confirmation: null,
        query_answered_by: 'sim_sap_facts',
        queried_by_original_key: true,
        original_keys_preserved: true,
        preserved_keys: preservedKeys(updated),
        before_status: existing.status,
        outbox: updated,
        sim_fact: { found: false },
      }
    }

    const updated = await this.repos.outbox.updateDelivery(id, {
      status: 'DISPATCHED',
      clearLastError: true,
      nextRetryAt: null,
      bumpAttempt: true,
      payloadMerge: {
        attempt_outcome: 'FOUND_COMMITTED',
        confirmation: 'CONFIRMED_BY_QUERY',
        queried_by_original_key: true,
        original_event_id: existing.eventId,
        timeout_unknown: false,
        query_answered_by: 'sim_sap_facts',
        query_found: true,
        sim_doc_no: answer.docNo ?? null,
        sim_doc_type: answer.docType ?? null,
        actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      },
    })
    if (!updated) throw new SapSimRuleViolation('SAP-A1000-2', `outbox 行不存在 eventId=${id}`)
    assertKeysUnchanged(before, updated, 'SAP-A1000-4')
    return {
      actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      attempt_outcome: 'FOUND_COMMITTED',
      confirmation: 'CONFIRMED_BY_QUERY',
      query_answered_by: 'sim_sap_facts',
      queried_by_original_key: true,
      original_keys_preserved: true,
      preserved_keys: preservedKeys(updated),
      before_status: existing.status,
      outbox: updated,
      sim_fact: {
        found: true,
        doc_no: answer.docNo ?? null,
        doc_type: answer.docType ?? null,
        qty: answer.qty ?? null,
        unit: answer.unit ?? null,
        committed_at: answer.committedAt ?? null,
      },
    }
  }

  /**
   * POST /integrations/outbox/:eventId/query-unavailable
   * B1000：QUERY_UNAVAILABLE → OUTCOME_UNKNOWN / EXTERNAL_UNKNOWN 冻结；禁当 0 / 换键。
   */
  async markQueryUnavailable(
    eventId: string,
    body?: Record<string, unknown>,
  ): Promise<{
    actual_connection: false
    attempt_outcome: 'QUERY_UNAVAILABLE'
    outcome: 'OUTCOME_UNKNOWN'
    status: 'EXTERNAL_UNKNOWN'
    hold: true
    zeroed: false
    rekeyed: false
    original_keys_preserved: true
    preserved_keys: ReturnType<typeof preservedKeys>
    capability_boundary: string
    outbox: SapSimOutboxRecord
  }> {
    const id = typeof eventId === 'string' ? eventId.trim() : ''
    if (!id) throw new SapSimRuleViolation('SAP-B1000-1', '缺少必填字段 eventId')
    const payload = body ?? {}
    if (payload['treat_as_zero'] === true || payload['as_zero'] === true || payload['qty'] === 0) {
      throw new SapSimRuleViolation('SAP-B1000-5', 'QUERY_UNAVAILABLE 禁止当 0 成功')
    }
    const altKey =
      payload['new_event_id'] ??
      payload['newEventId'] ??
      payload['external_key'] ??
      payload['externalKey']
    if (typeof altKey === 'string' && altKey.trim() !== '') {
      const existingProbe = await this.repos.outbox.findByEventId(id)
      const currentRef = existingProbe?.externalRef
      if (altKey.trim() !== id && altKey.trim() !== currentRef) {
        throw new SapSimRuleViolation('SAP-B1000-6', '禁止换键重提；必须保留原事件键')
      }
    }
    const existing = await this.repos.outbox.findByEventId(id)
    if (!existing) throw new SapSimRuleViolation('SAP-B1000-2', `outbox 行不存在 eventId=${id}`)
    const pl = asRecord(existing.payload)
    const eligible =
      existing.status === 'EXTERNAL_UNKNOWN' ||
      pl['attempt_outcome'] === 'TIMEOUT_UNKNOWN' ||
      pl['timeout_unknown'] === true ||
      existing.status === 'PENDING' ||
      existing.status === 'FAILED'
    if (!eligible) {
      throw new SapSimRuleViolation(
        'SAP-B1000-3',
        `当前状态不可进入 UNKNOWN hold（status=${existing.status}）`,
      )
    }
    if (pl['attempt_outcome'] === 'FOUND_COMMITTED' || pl['confirmation'] === 'CONFIRMED_BY_QUERY') {
      throw new SapSimRuleViolation('SAP-B1000-7', 'A1000 已证实路径不可再标 B1000 UNKNOWN（剧本互斥）')
    }
    const before = preservedKeys(existing)
    const updated = await this.repos.outbox.updateDelivery(id, {
      status: 'EXTERNAL_UNKNOWN',
      lastError: 'QUERY_UNAVAILABLE → OUTCOME_UNKNOWN (SAP_SIM hold)',
      bumpAttempt: true,
      payloadMerge: {
        attempt_outcome: 'QUERY_UNAVAILABLE',
        outcome: 'OUTCOME_UNKNOWN',
        external_unknown: true,
        hold: true,
        zeroed: false,
        rekeyed: false,
        original_event_id: existing.eventId,
        actual_connection: SAP_SIM_ACTUAL_CONNECTION,
        capability_boundary:
          'E08-B1000 SIM-only: QUERY_UNAVAILABLE keeps EXTERNAL_UNKNOWN; ≠ REAL-SAP; ≠ treat as zero; ≠ rekey',
      },
    })
    if (!updated) throw new SapSimRuleViolation('SAP-B1000-2', `outbox 行不存在 eventId=${id}`)
    assertKeysUnchanged(before, updated, 'SAP-B1000-4')
    return {
      actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      attempt_outcome: 'QUERY_UNAVAILABLE',
      outcome: 'OUTCOME_UNKNOWN',
      status: 'EXTERNAL_UNKNOWN',
      hold: true,
      zeroed: false,
      rekeyed: false,
      original_keys_preserved: true,
      preserved_keys: preservedKeys(updated),
      capability_boundary:
        'E08-B1000 SIM-only UNKNOWN hold; business must not treat as 0 or rekey; ≠ A1000; ≠ 56/65 full',
      outbox: updated,
    }
  }

  /**
   * POST /integrations/outbox/:eventId/cancel
   * E08 撤销：按原键标记 CANCELLED（status=NOOP_NEEDED）；保留原键；≠ 换键重提。
   */
  async cancelOutbox(
    eventId: string,
    body?: Record<string, unknown>,
  ): Promise<{
    actual_connection: false
    attempt_outcome: 'CANCELLED'
    cancelled: true
    original_keys_preserved: true
    preserved_keys: ReturnType<typeof preservedKeys>
    outbox: SapSimOutboxRecord
  }> {
    const id = typeof eventId === 'string' ? eventId.trim() : ''
    if (!id) throw new SapSimRuleViolation('SAP-E08-C1', '缺少必填字段 eventId')
    const payload = body ?? {}
    const altKey = payload['new_event_id'] ?? payload['newEventId']
    if (typeof altKey === 'string' && altKey.trim() !== '' && altKey.trim() !== id) {
      throw new SapSimRuleViolation('SAP-E08-C3', '撤销必须使用原事件键；禁止换键')
    }
    const existing = await this.repos.outbox.findByEventId(id)
    if (!existing) throw new SapSimRuleViolation('SAP-E08-C2', `outbox 行不存在 eventId=${id}`)
    const pl = asRecord(existing.payload)
    if (pl['hold'] === true && pl['attempt_outcome'] === 'QUERY_UNAVAILABLE') {
      throw new SapSimRuleViolation('SAP-E08-C4', 'B1000 UNKNOWN hold 中禁止 cancel 冒充清零')
    }
    const before = preservedKeys(existing)
    const updated = await this.repos.outbox.updateDelivery(id, {
      status: 'NOOP_NEEDED',
      lastError: 'CANCELLED by original key (SAP_SIM subset)',
      bumpAttempt: true,
      payloadMerge: {
        attempt_outcome: 'CANCELLED',
        cancelled: true,
        original_event_id: existing.eventId,
        actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      },
    })
    if (!updated) throw new SapSimRuleViolation('SAP-E08-C2', `outbox 行不存在 eventId=${id}`)
    assertKeysUnchanged(before, updated, 'SAP-E08-C5')
    return {
      actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      attempt_outcome: 'CANCELLED',
      cancelled: true,
      original_keys_preserved: true,
      preserved_keys: preservedKeys(updated),
      outbox: updated,
    }
  }
  /**
   * POST /integrations/outbox/:eventId/attempt
   * P5/P6 E08 加深：质量未应用 / REJECT_* / STALE / WAIT_PARENT / 物流·返工 ack /
   * P6 APPLIED_AFTER_PARENT（版本门控附带；≠ 重开 REJECT-STALE 号）/
   * APPLIED_ONCE / LINES_CONFIRMED（happy-path 切片；≠ 全量 APPLIED）。
   * 原键保留；负面不得当 APPLIED；≠ 重开 A1000/B1000；≠ 56/65 全量；≠ disposition/RECON-21。
   */
  async applyAttemptOutcome(
    eventId: string,
    body?: Record<string, unknown>,
  ): Promise<{
    actual_connection: false
    attempt_outcome: SapSimP5AttemptOutcome
    message_state: string | null
    applied: false | true
    quality_applied: false
    disposition_released: false
    original_keys_preserved: true
    preserved_keys: ReturnType<typeof preservedKeys>
    capability_boundary: string
    outbox: SapSimOutboxRecord
  }> {
    const id = typeof eventId === 'string' ? eventId.trim() : ''
    if (!id) throw new SapSimRuleViolation('SAP-E08-P5-1', '缺少必填字段 eventId')
    const payload = body ?? {}
    const { outcome, claimApplied, rekeyAttempt } = assertSapSimAttemptOutcome(payload)

    if (rekeyAttempt !== null && rekeyAttempt !== id) {
      throw new SapSimRuleViolation('SAP-E08-P5-3', 'attempt 必须使用原事件键；禁止换键冒充成功')
    }
    if (claimApplied && (SAP_SIM_NEGATIVE_ATTEMPT_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new SapSimRuleViolation(
        'SAP-E08-P5-4',
        `负面/门控 outcome=${outcome} 禁止 treat_as_applied / claim_applied（不得当成功 APPLIED）`,
      )
    }

    const existing = await this.repos.outbox.findByEventId(id)
    if (!existing) throw new SapSimRuleViolation('SAP-E08-P5-5', `outbox 行不存在 eventId=${id}`)

    const pl = asRecord(existing.payload)
    // 不重开 A1000/B1000 剧本：已证实 / UNKNOWN hold 禁止用本入口改写
    if (pl['attempt_outcome'] === 'FOUND_COMMITTED' || pl['confirmation'] === 'CONFIRMED_BY_QUERY') {
      throw new SapSimRuleViolation('SAP-E08-P5-6', 'A1000 已证实路径不可经 P5 attempt 改写（≠ 重开 A1000）')
    }
    if (pl['hold'] === true || pl['attempt_outcome'] === 'QUERY_UNAVAILABLE') {
      throw new SapSimRuleViolation('SAP-E08-P5-7', 'B1000 UNKNOWN hold 不可经 P5 attempt 改写（≠ 重开 B1000）')
    }

    const before = preservedKeys(existing)
    const isNegative = (SAP_SIM_NEGATIVE_ATTEMPT_OUTCOMES as readonly string[]).includes(outcome)

    let status: string
    let messageState: string | null = null
    let applied: false | true = false
    let lastError: string | null | undefined

    switch (outcome) {
      case 'RECEIVED_NOT_APPLIED':
        status = 'PENDING'
        messageState = 'AWAITING_UPSTREAM_APPLICATION'
        applied = false
        lastError = 'RECEIVED_NOT_APPLIED: message received; upstream quality not applied (SAP_SIM)'
        break
      case 'REJECT_ALREADY_PRODUCED':
      case 'REJECT_ORGANIZATION_MISMATCH':
      case 'REJECTED_MISSING_REWORK_ORDER':
        status = 'NOOP_NEEDED'
        messageState = 'REJECTED'
        applied = false
        lastError = `${outcome} (SAP_SIM negative attempt; not APPLIED)`
        break
      case 'STALE_NOOP':
        status = 'NOOP_NEEDED'
        messageState = 'STALE'
        applied = false
        lastError = 'STALE_NOOP (SAP_SIM; not APPLIED)'
        break
      case 'WAIT_PARENT_VERSION':
        status = 'PENDING'
        messageState = 'WAITING_PARENT_VERSION'
        applied = false
        lastError = 'WAIT_PARENT_VERSION (SAP_SIM gate; not APPLIED)'
        break
      case 'ISSUE_CONFIRMED':
      case 'RECEIPT_CONFIRMED':
      case 'SHIPMENT_CONFIRMED':
      case 'CONSUMPTION_RECORDED':
      case 'REWORK_CLASSIFIED':
      case 'SCRAP_ACKNOWLEDGED':
      case 'QTYRECON_ACKNOWLEDGED':
        status = 'DISPATCHED'
        messageState = 'ATTEMPT_OBSERVED'
        applied = true // 报文层 attempt 可观察确认；≠ 业务全盘 / ≠ RECON-21
        lastError = undefined
        break
      case 'APPLIED_AFTER_PARENT':
        // P6 版本门控附带：父版本就绪后应用；≠ 重开 P5 REJECT-STALE 号关账
        status = 'DISPATCHED'
        messageState = 'APPLIED_AFTER_PARENT'
        applied = true // 报文层可观察；≠ 全量 APPLIED 关账
        lastError = undefined
        break
      case 'APPLIED_ONCE':
        status = 'DISPATCHED'
        messageState = 'APPLIED_ONCE'
        applied = true // happy-path 切片；≠ 全量 APPLIED
        lastError = undefined
        break
      case 'LINES_CONFIRMED':
        status = 'DISPATCHED'
        messageState = 'LINES_CONFIRMED'
        applied = true // happy-path 切片；≠ 物流已覆盖 CONFIRM 冒充全量
        lastError = undefined
        break
      default: {
        const _exhaustive: never = outcome
        throw new SapSimRuleViolation('SAP-E08-P5-2', `未处理 outcome=${String(_exhaustive)}`)
      }
    }

    const capabilityBoundary =
      outcome === 'RECEIVED_NOT_APPLIED'
        ? 'P5 QUALITY_STOCK_BLOCK→RECEIVED_NOT_APPLIED; ≠ disposition full; ≠ quality hold applied; ≠ 56/65; actual_connection=false'
        : isNegative
          ? `P5 negative attempt ${outcome}; must not treat as APPLIED; ≠ A1000/B1000 reopen; ≠ 56/65; actual_connection=false`
          : outcome === 'APPLIED_AFTER_PARENT'
            ? 'P6 version-gate attach APPLIED_AFTER_PARENT; ≠ reopen P5 REJECT-STALE WI; ≠ 56/65 full; ≠ REAL-SAP; actual_connection=false'
            : outcome === 'APPLIED_ONCE' || outcome === 'LINES_CONFIRMED'
              ? `P6 happy-path attempt slice ${outcome}; ≠ full APPLIED closed; ≠ A1000/B1000/QBLOCK/REJECT-STALE reopen; ≠ 56/65; actual_connection=false`
              : outcome.startsWith('REWORK') ||
                  outcome.startsWith('SCRAP') ||
                  outcome.startsWith('QTYRECON')
                ? `P5 rework/scrap/qtyrecon ack ${outcome}; ≠ 21-object RECON product CLOSED; ≠ 56/65; actual_connection=false`
                : `P5/P6 logistics/attempt observed ${outcome}; engineering slice ≠ 56/65 full; ≠ REAL-SAP; actual_connection=false`

    const updated = await this.repos.outbox.updateDelivery(id, {
      status,
      lastError: lastError ?? null,
      clearLastError: lastError === undefined,
      bumpAttempt: true,
      payloadMerge: {
        attempt_outcome: outcome,
        message_state: messageState,
        applied,
        quality_applied: false,
        disposition_released: false,
        upstream_applied: false,
        original_event_id: existing.eventId,
        actual_connection: SAP_SIM_ACTUAL_CONNECTION,
        capability_boundary: capabilityBoundary,
        p5_slice: true,
        p6_slice: ['APPLIED_AFTER_PARENT', 'APPLIED_ONCE', 'LINES_CONFIRMED'].includes(outcome),
        note: 'SAP_SIM P5/P6 attempt deepen; ≠ 56/65 full CLOSED; ≠ REAL-SAP; ≠ full APPLIED',
      },
    })
    if (!updated) throw new SapSimRuleViolation('SAP-E08-P5-5', `outbox 行不存在 eventId=${id}`)
    assertKeysUnchanged(before, updated, 'SAP-E08-P5-8')

    return {
      actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      attempt_outcome: outcome,
      message_state: messageState,
      applied,
      quality_applied: false,
      disposition_released: false,
      original_keys_preserved: true,
      preserved_keys: preservedKeys(updated),
      capability_boundary: capabilityBoundary,
      outbox: updated,
    }
  }

}

export function isSapSimRuleViolation(error: unknown): error is SapSimRuleViolation {
  return error instanceof SapSimRuleViolation
}
