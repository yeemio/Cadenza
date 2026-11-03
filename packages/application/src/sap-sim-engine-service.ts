import {
  SAP_SIM_ACTUAL_CONNECTION,
  SAP_SIM_FAULT_SCENARIO_CATALOG,
  SAP_SIM_SOURCE_SYSTEM,
  SapSimRuleViolation,
  assertSapSimBusinessEvent,
  assertSapSimFaultScenarioConfig,
  assertSapSimOpeningStockPayload,
  assertSapSimReferenceData,
  faultScenarioMatches,
  findSapSimTopicMapping,
  sha256OfPayload,
  sha256OfSapSimReferenceData,
  type SapSimBusinessEvent,
  type SapSimFaultScenarioConfig,
  type SapSimReferenceData,
  type SapSimReferenceRow,
} from '@cadenza/domain'
import type {
  SapSimFactQueryPort,
  SapSimFactsRepositories,
  SapSimOutboxReceiptPort,
  SapSimOrderFactRecord,
  SapSimEventOutcomeRecord,
} from './sap-sim-engine-repositories'

/**
 * R1 模拟 SAP 引擎：输入=业务事件（按 SAP-REFERENCE-PROFILE 映射），
 * 输出由模拟器自身业务规则 + sim_sap 持久化事实推导（单据号/结局/查询答案），
 * 不收 expected_outcome（出现即 422）。actual_connection=false。
 * 只写 sim_sap_* 事实表 + 平台 outbox/inbox；不触碰 MOM 业务表。
 */

export interface SapSimExecuteReceipt {
  actual_connection: false
  source_system: typeof SAP_SIM_SOURCE_SYSTEM
  event_key: string
  topic: string
  sap_operation: string
  mapping_tag: string
  outcome: string
  message_state: string | null
  applied: boolean
  doc_no: string | null
  doc_nos: string[]
  doc_type: string | null
  delivered: boolean
  response_lost: boolean
  held: boolean
  delayed_ms: number | null
  duplicate_injected: boolean
  sim_facts_persisted: boolean
  outbox_updated: boolean
  detail: Record<string, unknown>
}

const ORDER_TOPICS = new Set(['PRODUCTION_RELEASE', 'PRODUCTION_REVISION'])
const INGRESS_FAULT_OUTCOMES = new Set(['MESSAGE_LOST', 'NETWORK_DOWN', 'HELD_FOR_REORDER'])
const MAX_DELAY_MS = 5000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseProductionBusinessKey(
  businessKey: string | null,
): { organizationCode: string; plantCode: string; orderNo: string; line: string } | null {
  if (!businessKey) return null
  const parts = businessKey.split('|')
  if (parts.length >= 6 && parts[0] === 'SAPSIM' && parts[3] === 'PRODUCTION') {
    return { organizationCode: parts[1], plantCode: parts[2], orderNo: parts[4], line: parts[5] }
  }
  return null
}

function toQty(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

interface MaterialLineInput {
  materialId: string
  qty: number
  unit: string
  skuMaterialId?: string
  basis?: string
  sourceReferences?: string[]
}

interface ReferenceContext {
  data: SapSimReferenceData
  eventKey: string
  digest: string
}

/** 行物料抽取：兼容冻结输入的多种行字段命名（material/material_id/source_object_id/object_id）。 */
function extractLines(payload: Record<string, unknown>): MaterialLineInput[] {
  const raw =
    (Array.isArray(payload['lines']) ? payload['lines'] : undefined) ??
    (Array.isArray(payload['consumption_lines']) ? payload['consumption_lines'] : undefined) ??
    (Array.isArray(payload['output_lines']) ? payload['output_lines'] : undefined)
  if (!raw) return []
  const out: MaterialLineInput[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) throw new SapSimRuleViolation('SAP-SIMENG-12', '物料行必须为对象')
    const row = item as Record<string, unknown>
    const materialId = String(
      row['source_object_id'] ?? row['object_id'] ?? row['material_id'] ?? row['materialId'] ?? row['material'] ?? '',
    ).trim()
    const qty = toQty(row['qty'])
    const unit = String(row['unit'] ?? '').trim()
    if (materialId === '' || qty === null || qty <= 0 || unit === '') {
      throw new SapSimRuleViolation('SAP-SIMENG-12', '物料行需有效身份、正数量和单位')
    }
    out.push({ materialId, qty, unit, ...(typeof row['basis'] === 'string' ? { basis: row['basis'] } : {}) })
  }
  return out
}

interface HandlerResult {
  outcome: string
  messageState: string | null
  applied: boolean
  docs: Array<{
    docType: string
    docNo: string
    lineNo: number
    materialId?: string | null
    qty?: number | null
    unit?: string | null
  }>
  detail: Record<string, unknown>
}

type FaultScenarioRow = Awaited<ReturnType<SapSimEngineService['listFaults']>>[number]

export class SapSimEngineService implements SapSimFactQueryPort {
  constructor(
    private readonly facts: SapSimFactsRepositories,
    private readonly outbox: SapSimOutboxReceiptPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------- 查询（A1000/B1000 事实回答） ----------------

  async queryByEventKey(eventKey: string): Promise<{
    available: boolean
    faultType?: 'QUERY_UNAVAILABLE'
    found: boolean
    docNo?: string | null
    docType?: string | null
    qty?: number | string | null
    unit?: string | null
    outcome?: string | null
    committedAt?: string | null
    arrivals?: number
  }> {
    const key = eventKey.trim()
    if (!key) throw new SapSimRuleViolation('SAP-SIMENG-13', '缺少 event_key')
    const scenarios = await this.facts.faults.list()
    const outcomesForKey = await this.facts.outcomes.listByEventKey(key)
    const knownTopic = outcomesForKey[0]?.topic ?? null
    const unavailable = scenarios.find(
      (s) =>
        s.active &&
        s.faultType === 'QUERY_UNAVAILABLE' &&
        s.remainingCount > 0 &&
        faultScenarioMatches(
          { faultType: s.faultType, matchEventKey: s.matchEventKey, matchTopic: s.matchTopic, active: s.active },
          { eventKey: key, topic: knownTopic ?? '' },
        ),
    )
    if (unavailable) {
      await this.facts.faults.consume(unavailable.id)
      return { available: false, faultType: 'QUERY_UNAVAILABLE', found: false }
    }
    const docs = await this.facts.documents.findByEventKey(key)
    const committed = docs.find((d) => d.status === 'COMMITTED') ?? null
    const terminal = await this.facts.outcomes.findTerminal(key)
    const order = await this.facts.orders.findByEventKey(key)
    return {
      available: true,
      found: Boolean(committed || terminal || order),
      docNo: committed?.docNo ?? terminal?.docNo ?? null,
      docType: committed?.docType ?? (order ? 'ORDER' : null),
      qty: committed?.qty ?? order?.qty ?? null,
      unit: committed?.unit ?? order?.unit ?? null,
      outcome: terminal?.outcome ?? null,
      committedAt:
        (committed?.createdAt ?? order?.createdAt ?? terminal?.createdAt ?? null)?.toISOString() ?? null,
      arrivals: outcomesForKey.length,
    }
  }

  // ---------------- 执行（模拟器处理输入 → 事实 → 回执） ----------------

  async execute(payload: Record<string, unknown>): Promise<SapSimExecuteReceipt> {
    const event = assertSapSimBusinessEvent(payload)
    const mapping = findSapSimTopicMapping(event.topic)
    if (!mapping) {
      throw new SapSimRuleViolation('SAP-SIMENG-4', `topic=${event.topic} 不在模拟支持子集`)
    }
    const sha = sha256OfPayload(event.payload)
    const scenarios = await this.facts.faults.list()

    // --- ingress 故障：断网（可原键补传） ---
    const netDown = this.pickFireable(scenarios, 'NETWORK_DOWN', event)
    if (netDown) {
      await this.facts.faults.consume(netDown.id)
      await this.recordOutcome(event, sha, 'NETWORK_DOWN', { delivered: false, retryable_same_key: true })
      await this.linkOutbox(event.eventKey, 'NETWORK_DOWN', null, { sim_outcome: 'NETWORK_DOWN' })
      return this.receipt(event, mapping, {
        outcome: 'NETWORK_DOWN',
        delivered: false,
        detail: { fault: 'NETWORK_DOWN', retryable_same_key: true },
      })
    }

    // --- ingress 故障：消息丢失（静默丢弃，不落业务事实） ---
    const msgLost = this.pickFireable(scenarios, 'MESSAGE_LOST', event)
    if (msgLost) {
      await this.facts.faults.consume(msgLost.id)
      await this.recordOutcome(event, sha, 'MESSAGE_LOST', { delivered: false })
      await this.linkOutbox(event.eventKey, 'MESSAGE_LOST', null, { sim_outcome: 'MESSAGE_LOST' })
      return this.receipt(event, mapping, {
        outcome: 'MESSAGE_LOST',
        delivered: false,
        detail: { fault: 'MESSAGE_LOST' },
      })
    }

    // --- 乱序：非放行序到达先缓冲（完整到达持久化，重启可恢复） ---
    const reorder = this.pickFireable(scenarios, 'REORDER', event)
    if (reorder?.reorderKeys && reorder.reorderKeys.length >= 2) {
      const releaseOrder = reorder.reorderKeys
      const nextExpected = await this.nextExpectedKey(releaseOrder, reorder.pending)
      const heldAlready = reorder.pending.some((p) => p['event_key'] === event.eventKey)
      if (event.eventKey !== nextExpected && !heldAlready) {
        const pending: Array<Record<string, unknown>> = [
          ...reorder.pending,
          {
            event_key: event.eventKey,
            topic: event.topic,
            organization_code: event.organizationCode,
            plant_code: event.plantCode,
            business_key: event.businessKey,
            source_version: event.sourceVersion,
            parent_version: event.parentVersion,
            sequence: event.sequence,
            payload: event.payload,
            payload_sha256: sha,
            held_at: this.now().toISOString(),
          },
        ]
        await this.facts.faults.setPending(reorder.id, pending)
        await this.recordOutcome(event, sha, 'HELD_FOR_REORDER', {
          held_for_order: releaseOrder,
          next_expected: nextExpected,
        })
        await this.linkOutbox(event.eventKey, 'HELD_FOR_REORDER', null, { sim_outcome: 'HELD_FOR_REORDER' })
        return this.receipt(event, mapping, {
          outcome: 'HELD_FOR_REORDER',
          held: true,
          detail: { fault: 'REORDER', release_order: releaseOrder, next_expected: nextExpected },
        })
      }
    }

    const result = await this.processArrival(event, mapping.handler, sha, scenarios)

    // 本次到达是放行键 → 按配置顺序尝试放行缓冲中的乱序到达
    if (reorder?.reorderKeys && reorder.reorderKeys.length >= 2 && reorder.pending.length > 0) {
      await this.drainHeld(reorder.id, reorder.reorderKeys, reorder.pending)
    }

    return result
  }

  /** outbox 行驱动（贯通链路：MOM 命令→outbox→模拟器处理→事实→回执→MOM 状态更新）。 */
  async dispatch(outboxEventId: string): Promise<SapSimExecuteReceipt> {
    const id = typeof outboxEventId === 'string' ? outboxEventId.trim() : ''
    if (!id) throw new SapSimRuleViolation('SAP-SIMENG-9', '缺少必填字段 eventId')
    const row = await this.outbox.findByEventId(id)
    if (!row) throw new SapSimRuleViolation('SAP-SIMENG-9', `outbox 行不存在 eventId=${id}`)
    const pl = row.payload ?? {}
    const envelopeRaw = pl['envelope'] ?? pl['body']
    const envelope =
      envelopeRaw !== undefined && typeof envelopeRaw === 'object' && envelopeRaw !== null
        ? (envelopeRaw as Record<string, unknown>)
        : {}
    const eventKey = row.externalRef ?? row.eventId
    const bodyPayload =
      envelope['payload'] !== undefined && typeof envelope['payload'] === 'object' && envelope['payload'] !== null
        ? (envelope['payload'] as Record<string, unknown>)
        : envelope
    const pickStr = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
    const event: Record<string, unknown> = {
      event_key: eventKey,
      topic: pickStr(pl['entity_type']) ?? pickStr(envelope['topic']) ?? pickStr(envelope['entity_type']) ?? '',
      organization_code: pickStr(pl['organization_code']) ?? pickStr(envelope['organization_code']) ?? '',
      plant_code: pickStr(pl['plant_code']) ?? pickStr(envelope['plant_code']) ?? '',
      business_key:
        pickStr(bodyPayload['business_key']) ?? pickStr(envelope['business_key']) ?? null,
      source_version: bodyPayload['source_version'] ?? envelope['source_version'] ?? null,
      parent_version: bodyPayload['parent_version'] ?? envelope['parent_version'] ?? null,
      sequence: bodyPayload['sequence'] ?? envelope['sequence'] ?? null,
      payload: bodyPayload,
    }
    return this.execute(event)
  }

  // ---------------- 故障场景管理 ----------------

  async listFaults() {
    return this.facts.faults.list()
  }

  async activateFault(
    payload: Record<string, unknown>,
  ): Promise<{ scenario: Record<string, unknown>; from_catalog: boolean }> {
    const scenarioNoRaw = payload['scenario_no'] ?? payload['scenarioNo']
    const onlyScenarioNo =
      typeof scenarioNoRaw === 'string' &&
      scenarioNoRaw.trim() !== '' &&
      Object.keys(payload).every((k) => ['scenario_no', 'scenarioNo'].includes(k))
    if (onlyScenarioNo) {
      const catalogScenario = SAP_SIM_FAULT_SCENARIO_CATALOG.find(
        (s) => s.scenario_no === scenarioNoRaw.trim(),
      )
      if (!catalogScenario) {
        throw new SapSimRuleViolation('SAP-SIMENG-6', `场景配置文件中不存在 scenario_no=${String(scenarioNoRaw)}`)
      }
      const existing = await this.facts.faults.findByScenarioNo(catalogScenario.scenario_no)
      if (existing) {
        throw new SapSimRuleViolation(
          'SAP-SIMENG-6',
          `scenario_no=${catalogScenario.scenario_no} 已激活（先停用再重建）`,
        )
      }
      return { scenario: await this.upsertScenario(catalogScenario), from_catalog: true }
    }
    const config = assertSapSimFaultScenarioConfig(payload)
    const existing = await this.facts.faults.findByScenarioNo(config.scenario_no)
    if (existing) {
      throw new SapSimRuleViolation('SAP-SIMENG-6', `scenario_no=${config.scenario_no} 已存在（先停用再重建）`)
    }
    return { scenario: await this.upsertScenario(config), from_catalog: false }
  }

  async deactivateFault(scenarioNo: string): Promise<{ scenario_no: string; active: false }> {
    const existing = await this.facts.faults.findByScenarioNo(scenarioNo)
    if (!existing) throw new SapSimRuleViolation('SAP-SIMENG-6', `场景不存在 scenario_no=${scenarioNo}`)
    await this.facts.faults.setActive(existing.id, false)
    return { scenario_no: scenarioNo, active: false }
  }

  // ---------------- 模拟侧主数据补给（仅 sim_sap_stock） ----------------

  async provisionOpeningStock(payload: Record<string, unknown>) {
    const input = assertSapSimOpeningStockPayload(payload)
    const row = await this.facts.stock.adjust(
      input.organizationCode,
      input.plantCode,
      input.materialId,
      input.unit,
      input.qty,
    )
    return { actual_connection: SAP_SIM_ACTUAL_CONNECTION, sim_only: true, stock: row }
  }

  async listDocuments(filter: { plantCode?: string; docType?: string } = {}) {
    return this.facts.documents.list(filter)
  }

  async listStock(organizationCode?: string) {
    return this.facts.stock.list(organizationCode)
  }

  async listOrders(organizationCode?: string) {
    return this.facts.orders.list(organizationCode)
  }

  async listOutcomes(eventKey: string) {
    return this.facts.outcomes.listByEventKey(eventKey)
  }

  // ---------------- 内部：到达处理 ----------------

  private async processArrival(
    event: SapSimBusinessEvent,
    handler: string,
    sha: string,
    scenarios: FaultScenarioRow[],
  ): Promise<SapSimExecuteReceipt> {
    const mapping = findSapSimTopicMapping(event.topic)
    if (!mapping) throw new SapSimRuleViolation('SAP-SIMENG-4', `topic=${event.topic} 不在模拟支持子集`)

    const heldScenario = scenarios.find((s) => s.pending.some((p) => p['event_key'] === event.eventKey))
    const custodyArrival = event.topic === 'SCRAP_CONFIRM' && event.payload['custody_object_id'] !== undefined && !heldScenario
      ? await this.prepareCustodyArrival(event, handler, sha) : null
    // Custody transfers commit their balances, document and idempotency fact together before any egress receipt.
    const terminal = custodyArrival ? custodyArrival.terminal : await this.facts.outcomes.findTerminal(event.eventKey)
    if (terminal) {
      if (terminal.payloadSha256 !== sha) {
        throw new SapSimRuleViolation(
          'SAP-SIMENG-8',
          `同事件键 ${event.eventKey} 的 payload 哈希与首次处理不同；不得改写原处理结果`,
        )
      }
      const dupOutcome = ORDER_TOPICS.has(event.topic)
        ? 'DUPLICATE_SAME_HASH_NOOP'
        : 'DUPLICATE_RETURN_ORIGINAL'
      if (!custodyArrival) await this.recordOutcome(
        event,
        sha,
        dupOutcome,
        {
          duplicate_of_arrival: terminal.arrivalSeq,
          returned_original: true,
          no_new_facts: true,
        },
        terminal.docNo,
      )
      const updated = await this.linkOutbox(event.eventKey, terminal.outcome, terminal.docNo, {
        sim_outcome: dupOutcome,
        sim_doc_no: terminal.docNo,
        duplicate_of_arrival: terminal.arrivalSeq,
      })
      return this.receipt(event, mapping, {
        outcome: dupOutcome,
        applied: terminal.applied,
        docNo: terminal.docNo,
        detail: { duplicate_of_arrival: terminal.arrivalSeq, no_new_facts: true },
        outboxUpdated: updated,
      })
    }

    // 缓冲中的乱序到达在放行前再次到达：仍按持有处理
    if (heldScenario) {
      return this.receipt(event, mapping, {
        outcome: 'HELD_FOR_REORDER',
        held: true,
        detail: { fault: 'REORDER', still_held: true },
      })
    }

    const result = custodyArrival?.result ?? await this.runHandler(event, handler)
    // 终局入账（单据号/结局写入台账——查询与幂等的事实依据）
    if (!custodyArrival) await this.recordTerminalOutcome(event, sha, result)

    // 重复注入：提交后由引擎合成一次重投（结果由事实推导，不产生新单据）
    const dupFault = this.pickFireable(scenarios, 'DUPLICATE', event)
    let duplicateInjected = false
    if (dupFault) {
      await this.facts.faults.consume(dupFault.id)
      const dupOutcome = ORDER_TOPICS.has(event.topic)
        ? 'DUPLICATE_SAME_HASH_NOOP'
        : 'DUPLICATE_RETURN_ORIGINAL'
      await this.recordOutcome(
        event,
        sha,
        dupOutcome,
        {
          synthesized_redelivery: true,
          returned_original_doc: result.docs[0]?.docNo ?? null,
          no_new_facts: true,
        },
        result.docs[0]?.docNo ?? null,
      )
      duplicateInjected = true
    }

    // egress 故障：响应丢失（事实已提交，回执不返回 → 调用方只能按原键查询）
    const responseLost = this.pickFireable(scenarios, 'RESPONSE_LOST', event)
    if (responseLost) {
      await this.facts.faults.consume(responseLost.id)
      await this.linkOutbox(event.eventKey, 'TIMEOUT_UNKNOWN', result.docs[0]?.docNo ?? null, {
        sim_outcome: result.outcome,
        sim_doc_no: result.docs[0]?.docNo ?? null,
        sim_facts_committed: true,
        response_lost: true,
      })
      return this.receipt(event, mapping, {
        outcome: 'TIMEOUT_UNKNOWN',
        responseLost: true,
        detail: { fault: 'RESPONSE_LOST', facts_committed: true, receipt_withheld: true },
      })
    }

    // egress 故障：响应延迟
    const delayFault = this.pickFireable(scenarios, 'DELAY', event)
    let delayedMs: number | null = null
    if (delayFault) {
      await this.facts.faults.consume(delayFault.id)
      delayedMs = Math.min(delayFault.delayMs ?? 0, MAX_DELAY_MS)
      if (delayedMs > 0) await sleep(delayedMs)
    }

    const updated = await this.linkOutbox(
      event.eventKey,
      result.outcome,
      result.docs[0]?.docNo ?? null,
      {
        sim_outcome: result.outcome,
        sim_doc_no: result.docs[0]?.docNo ?? null,
        sim_doc_count: result.docs.length,
      },
    )

    return this.receipt(event, mapping, {
      outcome: result.outcome,
      messageState: result.messageState,
      applied: result.applied,
      docNo: result.docs[0]?.docNo ?? null,
      docNos: result.docs.map((d) => d.docNo),
      docType: result.docs[0]?.docType ?? null,
      delayedMs,
      duplicateInjected,
      detail: { ...result.detail, docs: result.docs },
      outboxUpdated: updated,
    })
  }

  private async prepareCustodyArrival(
    event: SapSimBusinessEvent,
    handler: string,
    sha: string,
  ): Promise<{ terminal: SapSimEventOutcomeRecord | null; result: HandlerResult | null }> {
    return this.facts.runInEventTransaction(event.eventKey, async (facts) => {
      const engine = new SapSimEngineService(facts, this.outbox, this.now)
      const terminal = await facts.outcomes.findTerminal(event.eventKey)
      if (terminal) {
        if (terminal.payloadSha256 !== sha) throw new SapSimRuleViolation('SAP-SIMENG-8', '同事件键的 payload 不得改写')
        await engine.recordOutcome(event, sha, 'DUPLICATE_RETURN_ORIGINAL', {
          duplicate_of_arrival: terminal.arrivalSeq, returned_original: true, no_new_facts: true,
        }, terminal.docNo)
        return { terminal, result: null }
      }
      const result = await engine.runHandler(event, handler)
      await engine.recordTerminalOutcome(event, sha, result)
      return { terminal: null, result }
    })
  }

  private async runHandler(event: SapSimBusinessEvent, handler: string): Promise<HandlerResult> {
    switch (handler) {
      case 'PRODUCTION_RELEASE':
        return this.handleProductionRelease(event)
      case 'PRODUCTION_REVISION':
        return this.handleProductionRevision(event)
      case 'MASTER_VERSION_BUNDLE':
        return this.handleMasterBundle(event)
      case 'CANCEL_REQUEST':
        return this.handleCancelRequest(event)
      case 'EXECUTION_BUNDLE':
        return this.handleExecutionBundle(event)
      case 'QUALITY_STOCK_BLOCK':
        return this.handleQualityStockBlock(event)
      case 'REWORK_RECLASSIFICATION':
        return this.handleReworkReclassification(event)
      case 'MATERIAL_DOCUMENT':
        return this.handleMaterialDocument(event)
      default:
        throw new SapSimRuleViolation('SAP-SIMENG-4', `未实现处理器 ${handler}`)
    }
  }

  // ---- 订单族 ----

  private resolveOrderIdentity(event: SapSimBusinessEvent): {
    orderNo: string
    organizationCode: string
    plantCode: string
  } {
    const parsed = parseProductionBusinessKey(event.businessKey)
    const orderNo =
      parsed?.orderNo ??
      (typeof event.payload['order_id'] === 'string' && event.payload['order_id'].trim() !== ''
        ? event.payload['order_id'].trim()
        : typeof event.payload['short_order_no'] === 'string' && event.payload['short_order_no'].trim() !== ''
          ? event.payload['short_order_no'].trim()
          : '')
    if (!orderNo) {
      throw new SapSimRuleViolation(
        'SAP-SIMENG-10',
        `topic=${event.topic} 需要订单身份（business_key 或 payload.order_id）`,
      )
    }
    return { orderNo, organizationCode: event.organizationCode, plantCode: event.plantCode }
  }

  private async rejectNotice(
    event: SapSimBusinessEvent,
    outcome: string,
    reason: string,
    derived: Record<string, unknown> = {},
  ): Promise<HandlerResult> {
    const docNo = await this.facts.documents.nextDocNo('REJECT_NOTICE')
    await this.facts.documents.insert({
      docType: 'REJECT_NOTICE',
      docNo,
      organizationCode: event.organizationCode,
      plantCode: event.plantCode,
      sourceEventKey: event.eventKey,
      businessKey: event.businessKey,
      payload: { reason, outcome, topic: event.topic, envelope: event.payload, ...derived },
      receipt: { outcome, applied: false, ...derived },
    })
    return { outcome, messageState: 'REJECTED', applied: false, docs: [], detail: { reason, reject_doc_no: docNo, ...derived } }
  }

  private async handleProductionRelease(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const identity = await this.releaseOrderIdentity(event)
    if (identity.mismatch) return this.rejectNotice(event, 'REJECT_ORGANIZATION_MISMATCH', identity.mismatch)
    const collision = await this.facts.orders.findBySameOrderNoDifferentOrg(
      identity.plantCode,
      identity.orderNo,
    )
    if (collision && collision.organizationCode !== identity.organizationCode) {
      return this.rejectNotice(
        event,
        'REJECT_ORGANIZATION_MISMATCH',
        `相同短单号 ${identity.orderNo} 已存在于 ${collision.organizationCode}/${collision.plantCode}；不得跨法人/工厂匹配`,
      )
    }
    const version = event.sourceVersion ?? 1
    const existing = await this.facts.orders.findVersion(
      identity.organizationCode,
      identity.plantCode,
      identity.orderNo,
      version,
    )
    if (existing) {
      return {
        outcome: 'DUPLICATE_SAME_HASH_NOOP',
        messageState: 'ATTEMPT_OBSERVED',
        applied: false,
        docs: [],
        detail: { existing_order_id: existing.id, order_version: version },
      }
    }
    const qty = toQty(event.payload['qty'])
    const unit = typeof event.payload['unit'] === 'string' ? event.payload['unit'] : null
    const materialId = typeof event.payload['material_id'] === 'string' ? event.payload['material_id'] : null
    const orderKind = event.payload['order_kind'] === 'REWORK' ? 'REWORK' : 'PRODUCTION'
    const latest = await this.facts.orders.findByIdentity(identity.organizationCode, identity.plantCode, identity.orderNo)
    if (latest && version <= latest.orderVersion) {
      return { outcome: 'STALE_NOOP', messageState: 'STALE', applied: false, docs: [], detail: { local_latest: latest.orderVersion, history_preserved: true } }
    }
    const intermediate = await this.intermediateTotals(event, identity.orderNo)
    const executed = Math.max(latest?.producedQty ?? 0, ...intermediate.values())
    if (qty !== null && (qty < 0 || qty < executed)) {
      return this.rejectNotice(event, 'REJECTED_QTY_EXCEEDED', `下达量 ${qty} 小于已执行数量 ${executed}`)
    }
    const inserted = await this.facts.orders.insert({
      organizationCode: identity.organizationCode,
      plantCode: identity.plantCode,
      orderNo: identity.orderNo,
      orderKind,
      sourceEventKey: event.eventKey,
      orderVersion: version,
      parentVersion: event.parentVersion ?? (version > 1 ? version - 1 : null),
      qty,
      unit,
      materialId,
      producedQty: latest?.producedQty ?? 0,
      payload: { ...event.payload, business_key: event.businessKey },
      status: version > 1 ? 'REVISED' : 'RELEASED',
    })
    return {
      outcome: 'APPLIED_ONCE',
      messageState: 'APPLIED_ONCE',
      applied: true,
      docs: [],
      detail: {
        sim_order_id: inserted.id,
        order_no: identity.orderNo,
        order_kind: orderKind,
        order_version: version,
        qty,
        unit,
        material_id: materialId,
      },
    }
  }

  private async releaseOrderIdentity(event: SapSimBusinessEvent): Promise<{
    orderNo: string; organizationCode: string; plantCode: string; mismatch?: string
  }> {
    const base = this.resolveOrderIdentity(event)
    const parsed = parseProductionBusinessKey(event.businessKey)
    const reject = (reason: string) => ({ ...base, mismatch: reason })
    let ref = await this.referenceContext(event)
    if (!ref) {
      // An organization short code may locate only a uniquely proven master for the trusted plant.
      const masters = await this.facts.documents.list({ plantCode: event.plantCode, docType: 'MASTER_BUNDLE', limit: 200 })
      const candidates: ReferenceContext[] = []
      for (const master of masters) {
        if (master.status !== 'COMMITTED' || !master.payload['reference_data']) continue
        const data = assertSapSimReferenceData(master.payload['reference_data'], master.organizationCode, master.plantCode)
        const owners = new Set(data.tables.entities.filter((row) => row['id'] === event.organizationCode ||
          row['sap_company_code'] === event.organizationCode).map((row) => row['id']))
        const plantOwner = data.tables.plants.find((row) => row['sap_plant'] === event.plantCode)?.['entity_id']
        if (owners.size === 1 && plantOwner === master.organizationCode && owners.has(master.organizationCode)) {
          candidates.push({ data, eventKey: master.sourceEventKey, digest: sha256OfSapSimReferenceData(data) })
        }
      }
      const owners = new Set(candidates.map((candidate) => candidate.data.tables.plants.find((row) => row['sap_plant'] === event.plantCode)?.['entity_id']))
      if (owners.size > 1) return reject('组织短码在工厂引用中存在歧义')
      ref = candidates[0] ?? null
    }
    const organization = (value: string): string | null => {
      if (!ref) return value === event.organizationCode ? value : null
      const matches = new Set(ref.data.tables.entities.filter((row) => row['id'] === value || row['sap_company_code'] === value).map((row) => row['id']))
      return matches.size === 1 ? [...matches][0]! : null
    }
    const plant = (value: string): string | null => {
      if (!ref) return value
      const matches = new Set(ref.data.tables.plants.filter((row) => row['id'] === value || row['sap_plant'] === value).map((row) => row['sap_plant']))
      return matches.size === 1 ? [...matches][0]! : null
    }
    const organizationCode = organization(event.organizationCode)
    const plantCode = plant(event.plantCode)
    if (!organizationCode || !plantCode || (ref && !ref.data.tables.plants.some((row) => row['sap_plant'] === plantCode && row['entity_id'] === organizationCode))) {
      return reject('消息组织/工厂没有唯一可核实的归属')
    }
    if (parsed && (organization(parsed.organizationCode) !== organizationCode || plant(parsed.plantCode) !== plantCode)) {
      return reject('business_key 的组织/工厂与可信消息范围不符')
    }
    if (event.payload['company'] !== undefined && (typeof event.payload['company'] !== 'string' || organization(event.payload['company'].trim()) !== organizationCode)) {
      return reject('显式 company 与可信组织不符或缺可证别名映射')
    }
    if (event.payload['plant'] !== undefined && (typeof event.payload['plant'] !== 'string' || plant(event.payload['plant'].trim()) !== plantCode)) {
      return reject('显式 plant 与可信工厂不符')
    }
    if (event.payload['short_order_no'] !== undefined && event.payload['short_order_no'] !== base.orderNo) {
      return reject('显式短单号与 business_key 不符')
    }
    return { orderNo: base.orderNo, organizationCode, plantCode }
  }

  private async handleProductionRevision(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const identity = this.resolveOrderIdentity(event)
    const version = event.sourceVersion ?? 1
    const latest = await this.facts.orders.findByIdentity(
      identity.organizationCode,
      identity.plantCode,
      identity.orderNo,
    )
    if (!latest) {
      return this.rejectNotice(event, 'REJECTED_UNKNOWN_ORDER', `本地无订单 ${identity.orderNo}，修订无父版本`)
    }
    const sameVersion = await this.facts.orders.findVersion(
      identity.organizationCode,
      identity.plantCode,
      identity.orderNo,
      version,
    )
    if (sameVersion) {
      if (sameVersion.sourceEventKey === event.eventKey) {
        return {
          outcome: 'DUPLICATE_SAME_HASH_NOOP',
          messageState: 'ATTEMPT_OBSERVED',
          applied: false,
          docs: [],
          detail: { existing_order_id: sameVersion.id },
        }
      }
      // 不同事件键重投旧版本（本地已有更高版本）→ 迟到：保留历史不回滚
      return {
        outcome: 'STALE_NOOP',
        messageState: 'STALE',
        applied: false,
        docs: [],
        detail: {
          late_version: version,
          local_latest: latest.orderVersion,
          existing_event_key: sameVersion.sourceEventKey,
          history_preserved: true,
        },
      }
    }
    if (version <= latest.orderVersion) {
      return {
        outcome: 'STALE_NOOP',
        messageState: 'STALE',
        applied: false,
        docs: [],
        detail: { late_version: version, local_latest: latest.orderVersion, history_preserved: true },
      }
    }
    const requiredParent = event.parentVersion ?? version - 1
    const parent = await this.facts.orders.findVersion(
      identity.organizationCode,
      identity.plantCode,
      identity.orderNo,
      requiredParent,
    )
    if (!parent) {
      return {
        outcome: 'WAIT_PARENT_VERSION',
        messageState: 'WAITING_PARENT_VERSION',
        applied: false,
        docs: [],
        detail: { required_parent_version: requiredParent, local_latest: latest.orderVersion },
      }
    }
    const revisedQty = toQty(event.payload['new_qty']) ?? latest.qty
    const intermediate = await this.intermediateTotals(event, identity.orderNo)
    const executed = Math.max(latest.producedQty, ...intermediate.values())
    if (revisedQty !== null && (revisedQty < 0 || revisedQty < executed)) {
      return this.rejectNotice(event, 'REJECTED_QTY_EXCEEDED', `修订量 ${revisedQty} 小于已执行数量 ${executed}`)
    }
    const inserted = await this.facts.orders.insert({
      organizationCode: identity.organizationCode,
      plantCode: identity.plantCode,
      orderNo: identity.orderNo,
      orderKind: latest.orderKind,
      sourceEventKey: event.eventKey,
      orderVersion: version,
      parentVersion: requiredParent,
      qty: revisedQty,
      unit: latest.unit,
      materialId: latest.materialId,
      producedQty: latest.producedQty,
      payload: { ...latest.payload, ...event.payload, business_key: event.businessKey },
      status: 'REVISED',
    })
    return {
      outcome: 'APPLIED',
      messageState: 'APPLIED_AFTER_PARENT',
      applied: true,
      docs: [],
      detail: {
        sim_order_id: inserted.id,
        order_version: version,
        parent_version: requiredParent,
        produced_total: latest.producedQty,
        preserve_produced_m: event.payload['preserve_produced_m'] ?? null,
      },
    }
  }

  private async handleMasterBundle(event: SapSimBusinessEvent): Promise<HandlerResult> {
    let referenceDigest: string | null = null
    if (event.payload['reference_data'] !== undefined) {
      const data = assertSapSimReferenceData(event.payload['reference_data'], event.organizationCode, event.plantCode)
      referenceDigest = sha256OfSapSimReferenceData(data)
      const previous = await this.facts.documents.listMasterBundles(event.organizationCode, event.plantCode)
      for (const doc of previous) {
        const raw = doc.payload['reference_data'] as SapSimReferenceData | undefined
        if (raw?.version === data.version && sha256OfSapSimReferenceData(raw) !== referenceDigest) {
          throw new SapSimRuleViolation('SAP-SIMENG-17', `reference_data 版本 ${data.version} 已存在，不得覆盖引用事实`)
        }
      }
    }
    const docNo = await this.facts.documents.nextDocNo('MASTER_BUNDLE')
    await this.facts.documents.insert({
      docType: 'MASTER_BUNDLE',
      docNo,
      organizationCode: event.organizationCode,
      plantCode: event.plantCode,
      sourceEventKey: event.eventKey,
      businessKey: event.businessKey,
      payload: { ...event.payload, reference_data_sha256: referenceDigest, note: 'SIM 主数据输入事实；≠ 连接证据' },
      receipt: { outcome: 'APPLIED', applied: true },
    })
    return {
      outcome: 'APPLIED',
      messageState: 'APPLIED',
      applied: true,
      docs: [{ docType: 'MASTER_BUNDLE', docNo, lineNo: 0 }],
      detail: { master_versions: event.payload },
    }
  }

  private async handleCancelRequest(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const identity = this.resolveOrderIdentity(event)
    const latest = await this.facts.orders.findByIdentity(
      identity.organizationCode,
      identity.plantCode,
      identity.orderNo,
    )
    if (!latest) {
      return this.rejectNotice(event, 'REJECTED_UNKNOWN_ORDER', `本地无订单 ${identity.orderNo}`)
    }
    const intermediate = await this.intermediateTotals(event, identity.orderNo)
    if (latest.producedQty > 0 || [...intermediate.values()].some((qty) => qty > 0)) {
      return this.rejectNotice(
        event,
        'REJECT_ALREADY_PRODUCED',
        `订单 ${identity.orderNo} 已有产出事实（produced=${latest.producedQty}）；不得把取消当删除生产事实`,
      )
    }
    await this.facts.orders.markStatus(latest.id, 'CANCELLED')
    return {
      outcome: 'CANCELLED',
      messageState: 'CANCELLED',
      applied: false,
      docs: [],
      detail: { order_no: identity.orderNo, cancelled_version: latest.orderVersion },
    }
  }

  // ---- 物料凭证族 ----

  private async handleMaterialDocument(event: SapSimBusinessEvent): Promise<HandlerResult> {
    switch (event.topic) {
      case 'MATERIAL_CONSUMPTION':
        return this.handleGoodsIssue(event)
      case 'PRODUCTION_OUTPUT':
      case 'INTERMEDIATE_OUTPUT':
        return this.handleProductionOutput(event)
      case 'STOCK_TRANSFER_ISSUE':
        return this.handleTransferIssue(event)
      case 'STOCK_TRANSFER_RECEIPT':
        return this.handleTransferReceipt(event)
      case 'SHIPMENT_CONFIRM':
        return this.handleShipmentConfirm(event)
      case 'SCRAP_CONFIRM':
        return this.handleScrapConfirm(event)
      case 'QUANTITY_RECONCILIATION':
        return this.handleQtyReconciliation(event)
      default:
        throw new SapSimRuleViolation('SAP-SIMENG-4', `topic=${event.topic} 未映射物料凭证语义`)
    }
  }

  private async requireOrder(event: SapSimBusinessEvent) {
    const identity = this.resolveOrderIdentity(event)
    const order = await this.facts.orders.findByIdentity(
      identity.organizationCode,
      identity.plantCode,
      identity.orderNo,
    )
    if (!order) {
      throw new SapSimRuleViolation(
        'SAP-SIMENG-11',
        `模拟侧无订单事实 ${identity.organizationCode}/${identity.plantCode}/${identity.orderNo}（先投 PRODUCTION_RELEASE）`,
      )
    }
    return { identity, order }
  }

  private async referenceContext(event: SapSimBusinessEvent, required = false): Promise<ReferenceContext | null> {
    const bundles = await this.facts.documents.listMasterBundles(event.organizationCode, event.plantCode)
    const bundle = bundles.find((row) => row.status === 'COMMITTED' && row.payload['reference_data'])
    if (!bundle) {
      if (required) throw new SapSimRuleViolation('SAP-SIMENG-17', '缺少当前组织/工厂的 reference_data 主数据前置')
      return null
    }
    const data = assertSapSimReferenceData(bundle.payload['reference_data'], event.organizationCode, event.plantCode)
    return { data, eventKey: bundle.sourceEventKey, digest: sha256OfSapSimReferenceData(data) }
  }

  private referenceTrace(ref: ReferenceContext | null): Record<string, unknown> {
    return ref ? {
      reference_data_version: ref.data.version,
      reference_data_sha256: ref.digest,
      reference_master_event_key: ref.eventKey,
      reference_sources: ref.data.sources,
    } : {}
  }

  private referencedOrder(event: SapSimBusinessEvent, order: SapSimOrderFactRecord, ref: ReferenceContext): SapSimReferenceRow {
    const row = ref.data.tables.orders.find((r) => r['global_key'] === event.businessKey ||
      r['id'] === order.payload['order_id'])
    if (!row || row['material_id'] !== order.materialId || row['unit'] !== order.unit) {
      throw new SapSimRuleViolation('SAP-SIMENG-17', '订单引用与模拟侧订单身份/SKU/unit 不一致')
    }
    return row
  }

  private objectLine(ref: ReferenceContext, objectId: string, qty: number, unit: string, sourceReferences: string[] = []): MaterialLineInput {
    const object = ref.data.tables.stock_objects.find((r) => r['id'] === objectId)
    if (!object || object['unit'] !== unit) throw new SapSimRuleViolation('SAP-SIMENG-17', `对象 ${objectId} 或其单位引用无效`)
    return {
      materialId: objectId, qty, unit, skuMaterialId: object['material_id'], basis: object['basis'],
      sourceReferences: [...sourceReferences, `stock_objects:${objectId}`],
    }
  }

  private resolveStockLines(
    event: SapSimBusinessEvent,
    lines: MaterialLineInput[],
    ref: ReferenceContext | null,
    orderRef?: SapSimReferenceRow,
  ): MaterialLineInput[] {
    if (!ref) return lines
    return lines.flatMap((line) => {
      const direct = ref.data.tables.stock_objects.find((r) => r['id'] === line.materialId)
      if (direct) {
        const resolved = this.objectLine(ref, line.materialId, line.qty, line.unit)
        if (line.basis && line.basis !== resolved.basis) throw new SapSimRuleViolation('SAP-SIMENG-17', '对象 basis 不符')
        return [resolved]
      }
      const mapping = ref.data.tables.material_mappings.find((r) => r['sap_material'] === line.materialId || r['material_id'] === line.materialId)
      if (!mapping || ![mapping['sap_unit'], mapping['mom_unit']].includes(line.unit)) throw new SapSimRuleViolation('SAP-SIMENG-17', `无当前工厂物料映射 ${line.materialId}/${line.unit}`)
      const unit = mapping['mom_unit']
      const exactObject = ref.data.tables.stock_objects.find((r) => r['id'] === mapping['material_id'])
      if (exactObject) return [this.objectLine(ref, exactObject['id'], line.qty, unit, [`material_mappings:${mapping['id']}`])]
      const issues = ref.data.tables.raw_issues.filter((r) => r['order_id'] === orderRef?.['id'] && r['material_id'] === mapping['material_id'])
      if (!issues.length || Math.abs(issues.reduce((sum, r) => sum + Number(r['qty_kg']), 0) - line.qty) > 1e-8) {
        throw new SapSimRuleViolation('SAP-SIMENG-17', `SKU ${line.materialId} 不能唯一关联当前订单的原料对象与数量`)
      }
      return issues.map((row) => this.objectLine(ref, row['object_id'], Number(row['qty_kg']), unit,
        [`material_mappings:${mapping['id']}`, `raw_issues:${row['id']}`]))
    })
  }

  private resolveSummaryConsumption(event: SapSimBusinessEvent, orderRef: SapSimReferenceRow, ref: ReferenceContext): MaterialLineInput[] {
    const core = toQty(event.payload['core_m'])
    const jacket = toQty(event.payload['jacket_kg'])
    const feeds = ref.data.tables.feeds.filter((r) => r['order_id'] === orderRef['id'] && r['basis'] === 'core_m')
    const issues = ref.data.tables.raw_issues.filter((r) => r['order_id'] === orderRef['id'] &&
      ref.data.tables.materials.some((m) => m['id'] === r['material_id'] && m['sap_material'] === 'JACKET'))
    if (core === null || core <= 0 || jacket === null || jacket <= 0 || !feeds.length || !issues.length ||
        Math.abs(feeds.reduce((sum, r) => sum + Number(r['qty']), 0) - core) > 1e-8 ||
        Math.abs(issues.reduce((sum, r) => sum + Number(r['qty_kg']), 0) - jacket) > 1e-8) {
      throw new SapSimRuleViolation('SAP-SIMENG-17', '汇总投料与原订单 feeds/raw_issues 的数量或计量口径不符')
    }
    return [
      ...feeds.map((r) => this.objectLine(ref, r['source_object_id'], Number(r['qty']), r['unit'], [`feeds:${r['id']}`])),
      ...issues.map((r) => this.objectLine(ref, r['object_id'], Number(r['qty_kg']), 'kg', [`raw_issues:${r['id']}`])),
    ]
  }

  private async intermediateTotals(event: SapSimBusinessEvent, orderNo: string): Promise<Map<string, number>> {
    const docs = await this.facts.documents.listForOrder(event.organizationCode, event.plantCode, orderNo)
    const totals = new Map<string, number>()
    for (const doc of docs) {
      if (doc.status !== 'COMMITTED' || doc.docType !== 'PRODUCTION_CONFIRMATION' || doc.payload['intermediate'] !== true) continue
      const envelope = doc.payload['envelope'] as Record<string, unknown> | undefined
      const stage = String(doc.payload['intermediate_stage'] ?? `${doc.materialId}|${doc.unit}|${String(envelope?.['step'] ?? '')}`)
      totals.set(stage, (totals.get(stage) ?? 0) + (doc.qty ?? 0))
    }
    return totals
  }

  private async handleGoodsIssue(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const { identity, order } = await this.requireOrder(event)
    const summary = event.payload['core_m'] !== undefined || event.payload['jacket_kg'] !== undefined
    const ref = await this.referenceContext(event, summary)
    const orderRef = ref ? this.referencedOrder(event, order, ref) : undefined
    if (summary && extractLines(event.payload).length) throw new SapSimRuleViolation('SAP-SIMENG-17', '汇总与明细投料不能同时重复计量')
    const lines = summary && ref && orderRef
      ? this.resolveSummaryConsumption(event, orderRef, ref)
      : this.resolveStockLines(event, extractLines(event.payload), ref, orderRef)
    if (lines.length === 0) {
      throw new SapSimRuleViolation('SAP-SIMENG-12', 'MATERIAL_CONSUMPTION 需 lines[]（material/qty/unit）')
    }
    for (const line of lines) {
      // SIM 子集不含原料可用性检查（SAP-REFERENCE-PROFILE SIM_ASSUMPTION）；账面按行扣减
      await this.facts.stock.adjust(
        event.organizationCode,
        event.plantCode,
        line.materialId,
        line.unit,
        -line.qty,
      )
    }
    const docNo = await this.facts.documents.nextDocNo('MATERIAL_DOCUMENT')
    await this.facts.documents.insert({
      docType: 'MATERIAL_DOCUMENT',
      docNo,
      organizationCode: event.organizationCode,
      plantCode: event.plantCode,
      sourceEventKey: event.eventKey,
      businessKey: event.businessKey,
      payload: {
        goods_movement_code: '03',
        manufacturing_order: identity.orderNo,
        order_business_key: event.businessKey,
        lines,
        ...this.referenceTrace(ref),
        envelope: event.payload,
      },
      receipt: { outcome: 'CONFIRMED', applied: true },
    })
    return {
      outcome: 'CONFIRMED',
      messageState: 'ATTEMPT_OBSERVED',
      applied: true,
      docs: [{ docType: 'MATERIAL_DOCUMENT', docNo, lineNo: 0 }],
      detail: { order_no: identity.orderNo, order_version: order.orderVersion, lines, ...this.referenceTrace(ref) },
    }
  }

  private async handleProductionOutput(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const { identity, order } = await this.requireOrder(event)
    const qty = toQty(event.payload['qty'])
    const unit = typeof event.payload['unit'] === 'string' ? event.payload['unit'] : order.unit
    if (qty === null || qty <= 0 || !unit || (order.unit && unit !== order.unit)) {
      throw new SapSimRuleViolation('SAP-SIMENG-12', 'PRODUCTION_OUTPUT 需 qty/unit')
    }
    const materialId =
      (typeof event.payload['material_id'] === 'string' && event.payload['material_id'].trim() !== ''
        ? event.payload['material_id']
        : null) ?? order.materialId
    if (!materialId) {
      throw new SapSimRuleViolation('SAP-SIMENG-12', 'PRODUCTION_OUTPUT 需 material_id（或订单带 material_id）')
    }
    const intermediate = event.topic === 'INTERMEDIATE_OUTPUT'
    const stage = `${materialId}|${unit}|${String(event.payload['step'] ?? '')}`
    const stageTotals = intermediate ? await this.intermediateTotals(event, identity.orderNo) : null
    const current = intermediate ? (stageTotals?.get(stage) ?? 0) : order.producedQty
    if (order.status === 'CANCELLED') return this.rejectNotice(event, 'REJECT_NOTICE', '已取消订单不能新增产出')
    if (order.qty !== null && current + qty > order.qty) {
      return this.rejectNotice(event, 'REJECTED_QTY_EXCEEDED', `${intermediate ? '工序' : '最终'}累计产出 ${current + qty} 超过订单数量 ${order.qty}`)
    }
    if (!intermediate && materialId !== order.materialId) throw new SapSimRuleViolation('SAP-SIMENG-12', '最终产出 SKU 与订单不符')
    const produced = intermediate ? null : await this.facts.orders.addProduced(order.id, qty)
    if (!intermediate && !produced) return this.rejectNotice(event, 'REJECTED_QTY_EXCEEDED', '最终累计产出超过订单限制')
    await this.facts.stock.adjust(event.organizationCode, event.plantCode, materialId, unit, qty)
    const docNo = await this.facts.documents.nextDocNo('PRODUCTION_CONFIRMATION')
    await this.facts.documents.insert({
      docType: 'PRODUCTION_CONFIRMATION',
      docNo,
      organizationCode: event.organizationCode,
      plantCode: event.plantCode,
      sourceEventKey: event.eventKey,
      businessKey: event.businessKey,
      materialId,
      qty,
      unit,
      payload: {
        goods_movement_code: '02',
        manufacturing_order: identity.orderNo,
        order_business_key: event.businessKey,
        order_id: event.payload['order_id'] ?? null,
        axis_ids: event.payload['axis_ids'] ?? null,
        intermediate,
        intermediate_stage: intermediate ? stage : null,
        envelope: event.payload,
      },
      receipt: { outcome: 'CONFIRMED', applied: true, qty, unit },
    })
    return {
      outcome: 'CONFIRMED',
      messageState: 'ATTEMPT_OBSERVED',
      applied: true,
      docs: [{ docType: 'PRODUCTION_CONFIRMATION', docNo, lineNo: 0, materialId, qty, unit }],
      detail: {
        order_no: identity.orderNo,
        produced_total: produced?.producedQty ?? order.producedQty,
        intermediate_total: intermediate ? current + qty : null,
        released_qty: order.qty,
        material_id: materialId,
        intermediate,
      },
    }
  }

  private transferKeyOf(event: SapSimBusinessEvent): string {
    if (typeof event.payload['transfer_id'] === 'string' && event.payload['transfer_id'].trim() !== '') {
      return event.payload['transfer_id'].trim()
    }
    if (typeof event.payload['transfer_key'] === 'string' && event.payload['transfer_key'].trim() !== '') {
      return event.payload['transfer_key'].trim()
    }
    if (event.businessKey && event.businessKey.includes('|')) {
      return event.businessKey.split('|').at(-1) ?? event.eventKey
    }
    return event.eventKey
  }

  private async resolveTransfer(event: SapSimBusinessEvent) {
    const transferKey = this.transferKeyOf(event)
    const ids = event.payload['line_ids']
    const ref = await this.referenceContext(event, ids !== undefined)
    const explicit = extractLines(event.payload)
    let lines = explicit
    let fromPlant: string | undefined
    let toPlant = typeof event.payload['to_plant'] === 'string' ? event.payload['to_plant'].trim()
      : typeof event.payload['toPlant'] === 'string' ? event.payload['toPlant'].trim() : undefined
    let sourceOrg: string | undefined
    let receiverOrg: string | undefined
    let ownershipRule: string | undefined
    if (ids !== undefined) {
      if (!ref || !Array.isArray(ids) || !ids.length || explicit.length ||
          ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
        throw new SapSimRuleViolation('SAP-SIMENG-17', 'line_ids 需唯一有效引用，且不得与数量明细重复计量')
      }
      const transfer = ref.data.tables.transfers.find((r) => r['id'] === transferKey)
      const from = ref.data.tables.plants.find((r) => r['id'] === transfer?.['origin_plant_id'])
      const to = ref.data.tables.plants.find((r) => r['id'] === transfer?.['destination_plant_id'])
      if (!transfer || !from || !to) throw new SapSimRuleViolation('SAP-SIMENG-17', '转运头或组织工厂引用不存在')
      fromPlant = from['sap_plant']
      if (toPlant && toPlant !== to['sap_plant']) throw new SapSimRuleViolation('SAP-SIMENG-17', 'to_plant 与转运引用不符')
      toPlant = to['sap_plant']
      sourceOrg = transfer['source_entity_id']
      receiverOrg = transfer['destination_entity_id']
      ownershipRule = transfer['title_rule']
      const issuing = event.topic === 'STOCK_TRANSFER_ISSUE'
      if (event.plantCode !== (issuing ? fromPlant : toPlant) ||
          event.organizationCode !== (issuing ? sourceOrg : receiverOrg) ||
          (event.payload['ownership_rule'] !== undefined && event.payload['ownership_rule'] !== ownershipRule)) {
        throw new SapSimRuleViolation('SAP-SIMENG-17', '转运行消息的组织、厂位或所有权规则与引用不符')
      }
      lines = ids.map((id) => {
        const row = ref.data.tables.transfer_lines.find((r) => r['id'] === id && r['transfer_id'] === transferKey)
        if (!row) throw new SapSimRuleViolation('SAP-SIMENG-17', `转运行引用不存在或不属于 ${transferKey}: ${String(id)}`)
        return this.objectLine(ref, row['object_id'], Number(row['qty']), row['unit'],
          [`transfers:${transferKey}`, `transfer_lines:${row['id']}`])
      })
    } else {
      lines = this.resolveStockLines(event, explicit, ref)
    }
    if (!lines.length) throw new SapSimRuleViolation('SAP-SIMENG-12', '转运行需数量明细或可解析的 line_ids')
    // Check the total per object before changing any stock, including repeated inline rows.
    const grouped = new Map<string, MaterialLineInput>()
    for (const line of lines) {
      const key = `${line.materialId}|${line.unit}`
      const previous = grouped.get(key)
      grouped.set(key, previous ? { ...previous, qty: previous.qty + line.qty,
        sourceReferences: [...(previous.sourceReferences ?? []), ...(line.sourceReferences ?? [])] } : { ...line })
    }
    return { transferKey, lines: [...grouped.values()], fromPlant, toPlant, sourceOrg, receiverOrg, ownershipRule, ref }
  }

  private async handleTransferIssue(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const transfer = await this.resolveTransfer(event)
    const { transferKey, lines, toPlant, ref } = transfer
    if (!toPlant) throw new SapSimRuleViolation('SAP-SIMENG-12', 'STOCK_TRANSFER_ISSUE 需 to_plant 或转运引用')
    const receiverOrg = transfer.receiverOrg ?? event.organizationCode
    for (const line of lines) {
      const sender = await this.facts.stock.find(event.organizationCode, event.plantCode, line.materialId, line.unit)
      const transit = await this.facts.inTransit.find(transferKey, line.materialId, line.unit)
      if (transit && (transit.organizationCode !== event.organizationCode || transit.fromPlant !== event.plantCode || transit.toPlant !== toPlant)) {
        throw new SapSimRuleViolation('SAP-SIMENG-17', '在途复合身份与转运引用不符')
      }
      if (!sender || sender.qty < line.qty) {
        return this.rejectNotice(event, 'REJECTED_INSUFFICIENT_STOCK',
          `发方 ${event.plantCode}/${line.materialId} 库存不足（有 ${sender?.qty ?? 0}，需 ${line.qty}）`)
      }
    }
    const docNo = await this.facts.documents.nextDocNo('MATERIAL_DOCUMENT')
    const doc = await this.facts.documents.insert({
      docType: 'MATERIAL_DOCUMENT', docNo, organizationCode: event.organizationCode,
      plantCode: event.plantCode, sourceEventKey: event.eventKey, businessKey: event.businessKey,
      payload: {
        goods_movement_code: '04', transfer_direction: 'ISSUE', transfer_key: transferKey,
        source_organization_code: event.organizationCode, receiver_organization_code: receiverOrg,
        from_plant: event.plantCode, to_plant: toPlant, ownership_rule: transfer.ownershipRule ?? 'SAME_ORGANIZATION',
        issuing_or_receiving_plant: toPlant, lines, ...this.referenceTrace(ref), envelope: event.payload,
      },
      receipt: { outcome: 'ISSUE_CONFIRMED', applied: true },
    })
    for (const line of lines) {
      await this.facts.stock.adjust(event.organizationCode, event.plantCode, line.materialId, line.unit, -line.qty)
      const transit = await this.facts.inTransit.find(transferKey, line.materialId, line.unit)
      if (transit) await this.facts.inTransit.adjustQty(transit.id, line.qty)
      else await this.facts.inTransit.insert({ transferKey, organizationCode: event.organizationCode,
        fromPlant: event.plantCode, toPlant, materialId: line.materialId, unit: line.unit, qty: line.qty, issueDocId: doc.id })
    }
    return {
      outcome: 'ISSUE_CONFIRMED', messageState: 'ATTEMPT_OBSERVED', applied: true,
      docs: [{ docType: 'MATERIAL_DOCUMENT', docNo, lineNo: 0 }],
      detail: { transfer_key: transferKey, to_plant: toPlant, owner_in_transit: event.organizationCode,
        receiver_organization_code: receiverOrg, lines, ...this.referenceTrace(ref) },
    }
  }

  private async handleTransferReceipt(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const transfer = await this.resolveTransfer(event)
    const { transferKey, lines, ref } = transfer
    for (const line of lines) {
      const transit = await this.facts.inTransit.find(transferKey, line.materialId, line.unit)
      if (!transit || transit.qty < line.qty || transit.status !== 'IN_TRANSIT') {
        return this.rejectNotice(event, 'REJECTED_NO_IN_TRANSIT',
          `在途不足：${transferKey}/${line.materialId} 有 ${transit?.qty ?? 0}，需 ${line.qty}`)
      }
      const issue = transit.issueDocId ? await this.facts.documents.findById(transit.issueDocId) : null
      const receiverOrg = issue?.payload['receiver_organization_code'] ?? transit.organizationCode
      if (transit.toPlant !== event.plantCode || (transfer.toPlant && transfer.toPlant !== transit.toPlant) ||
          (transfer.fromPlant && transfer.fromPlant !== transit.fromPlant) ||
          (transfer.sourceOrg && transfer.sourceOrg !== transit.organizationCode) || receiverOrg !== event.organizationCode) {
        throw new SapSimRuleViolation('SAP-SIMENG-17', '收货组织/工厂与原发出在途身份不符')
      }
    }
    const docNo = await this.facts.documents.nextDocNo('MATERIAL_DOCUMENT')
    const doc = await this.facts.documents.insert({
      docType: 'MATERIAL_DOCUMENT', docNo, organizationCode: event.organizationCode,
      plantCode: event.plantCode, sourceEventKey: event.eventKey, businessKey: event.businessKey,
      payload: { goods_movement_code: '04', transfer_direction: 'RECEIPT', transfer_key: transferKey,
        receiver_organization_code: event.organizationCode, to_plant: event.plantCode,
        ownership_rule: transfer.ownershipRule ?? 'SAME_ORGANIZATION', lines, ...this.referenceTrace(ref), envelope: event.payload },
      receipt: { outcome: 'RECEIPT_CONFIRMED', applied: true },
    })
    for (const line of lines) {
      const transit = await this.facts.inTransit.find(transferKey, line.materialId, line.unit)
      if (!transit) continue
      await this.facts.inTransit.adjustQty(transit.id, -line.qty)
      await this.facts.stock.adjust(event.organizationCode, event.plantCode, line.materialId, line.unit, line.qty)
      if (transit.qty === line.qty) await this.facts.inTransit.markReceived(transit.id, doc.id)
    }
    return {
      outcome: 'RECEIPT_CONFIRMED', messageState: 'ATTEMPT_OBSERVED', applied: true,
      docs: [{ docType: 'MATERIAL_DOCUMENT', docNo, lineNo: 0 }],
      detail: { transfer_key: transferKey, lines, owner_after_receipt: event.organizationCode,
        ...this.referenceTrace(ref), quality_separate: '收货与质量结论分开' },
    }
  }

  private async handleShipmentConfirm(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const { identity, order } = await this.requireOrder(event)
    const qty = toQty(event.payload['qty'])
    const unit = typeof event.payload['unit'] === 'string' ? event.payload['unit'] : order.unit
    const materialId = order.materialId
    if (qty === null || !unit || !materialId) {
      throw new SapSimRuleViolation('SAP-SIMENG-12', 'SHIPMENT_CONFIRM 需 qty/unit（且订单带 material_id）')
    }
    const stock = await this.facts.stock.find(event.organizationCode, event.plantCode, materialId, unit)
    if (!stock || stock.qty < qty) {
      return this.rejectNotice(
        event,
        'REJECTED_INSUFFICIENT_STOCK',
        `发运库存不足 ${event.plantCode}/${materialId}（有 ${stock?.qty ?? 0}，需 ${qty}）`,
      )
    }
    await this.facts.stock.adjust(event.organizationCode, event.plantCode, materialId, unit, -qty)
    const docNo = await this.facts.documents.nextDocNo('DELIVERY_CONFIRM')
    await this.facts.documents.insert({
      docType: 'DELIVERY_CONFIRM',
      docNo,
      organizationCode: event.organizationCode,
      plantCode: event.plantCode,
      sourceEventKey: event.eventKey,
      businessKey: event.businessKey,
      materialId,
      qty,
      unit,
      payload: {
        goods_movement_code: '03',
        manufacturing_order: identity.orderNo,
        order_business_key: event.businessKey,
        sales_order_id: event.payload['sales_order_id'] ?? null,
        envelope: event.payload,
      },
      receipt: { outcome: 'CONFIRMED', applied: true },
    })
    return {
      outcome: 'CONFIRMED',
      messageState: 'ATTEMPT_OBSERVED',
      applied: true,
      docs: [{ docType: 'DELIVERY_CONFIRM', docNo, lineNo: 0, materialId, qty, unit }],
      detail: { order_no: identity.orderNo, qty, unit, pl_id: event.payload['pl_id'] ?? null },
    }
  }

  private async handleScrapConfirm(event: SapSimBusinessEvent): Promise<HandlerResult> {
    if (event.payload['custody_object_id'] !== undefined) return this.handleScrapCustody(event)
    const qty = toQty(event.payload['qty'])
    const unit = typeof event.payload['unit'] === 'string' ? event.payload['unit'] : null
    const materialId =
      (typeof event.payload['material_id'] === 'string' && event.payload['material_id'].trim() !== ''
        ? event.payload['material_id'].trim()
        : undefined)
    if (qty === null || !unit || !materialId) {
      throw new SapSimRuleViolation(
        'SAP-SIMENG-12',
        'SCRAP_CONFIRM 需 qty/unit 与 material_id 或 custody_object_id',
      )
    }
    const stock = await this.facts.stock.find(event.organizationCode, event.plantCode, materialId, unit)
    if (!stock || stock.qty < qty) {
      return this.rejectNotice(
        event,
        'REJECTED_INSUFFICIENT_STOCK',
        `报废扣减库存不足 ${event.plantCode}/${materialId}（有 ${stock?.qty ?? 0}，需 ${qty}）`,
      )
    }
    await this.facts.stock.adjust(event.organizationCode, event.plantCode, materialId, unit, -qty)
    const docNo = await this.facts.documents.nextDocNo('SCRAP_CONFIRM')
    await this.facts.documents.insert({
      docType: 'SCRAP_CONFIRM',
      docNo,
      organizationCode: event.organizationCode,
      plantCode: event.plantCode,
      sourceEventKey: event.eventKey,
      businessKey: event.businessKey,
      materialId,
      qty,
      unit,
      payload: { goods_movement_code: '03', envelope: event.payload, note: '数量报废确认 ≠ 实物已处置' },
      receipt: { outcome: 'CONFIRMED', applied: true, qty, unit },
    })
    return {
      outcome: 'CONFIRMED',
      messageState: 'ATTEMPT_OBSERVED',
      applied: true,
      docs: [{ docType: 'SCRAP_CONFIRM', docNo, lineNo: 0, materialId, qty, unit }],
      detail: { material_id: materialId, qty, unit },
    }
  }

  private async handleScrapCustody(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const qty = toQty(event.payload['qty'])
    const unit = typeof event.payload['unit'] === 'string' ? event.payload['unit'] : ''
    const custodyId = typeof event.payload['custody_object_id'] === 'string' ? event.payload['custody_object_id'].trim() : ''
    const sourceId = event.businessKey
    if (qty === null || qty <= 0 || !unit || !custodyId) throw new SapSimRuleViolation('SAP-SIMENG-12', '报废保管需正数量、单位和保管对象')
    const ref = await this.referenceContext(event, true)
    if (!ref) throw new SapSimRuleViolation('SAP-SIMENG-17', '报废保管缺引用主数据')
    const source = ref.data.tables.stock_objects.find((row) => row['id'] === sourceId)
    const custody = ref.data.tables.stock_objects.find((row) => row['id'] === custodyId)
    const plant = ref.data.tables.plants.find((row) => row['sap_plant'] === event.plantCode && row['entity_id'] === event.organizationCode)
    const reject = (outcome: string, reason: string): HandlerResult => ({
      outcome, messageState: 'REJECTED', applied: false, docs: [],
      detail: { reason, source_object_id: sourceId, custody_object_id: custodyId, no_business_writes: true },
    })
    if (!source || !custody || !plant || sourceId === custodyId ||
        custody['issuer_plant_id'] !== plant['id'] ||
        source['material_id'] !== custody['material_id'] || source['unit'] !== unit || custody['unit'] !== unit ||
        source['basis'] !== custody['basis'] || !source['basis'] ||
        (event.payload['material_id'] !== undefined && event.payload['material_id'] !== source['material_id']) ||
        (event.payload['basis'] !== undefined && event.payload['basis'] !== source['basis'])) {
      return reject('REJECT_NOTICE', '来源/保管对象、SKU、unit、basis 或保管工厂引用不符')
    }
    const stock = await this.facts.stock.findForUpdate(event.organizationCode, event.plantCode, source['id'], unit)
    if (!stock || stock.qty < qty) return reject('REJECTED_INSUFFICIENT_STOCK', '当前组织/工厂没有足够的真实来源库存')
    await this.facts.stock.adjust(event.organizationCode, event.plantCode, source['id'], unit, -qty)
    await this.facts.stock.adjust(event.organizationCode, event.plantCode, custodyId, unit, qty)
    const docNo = await this.facts.documents.nextDocNo('SCRAP_CONFIRM')
    const trace = {
      source_object_id: source['id'], custody_object_id: custodyId, sku_material_id: source['material_id'], basis: source['basis'],
      physical_retained: true, physical_disposed: false, accounting_scrap_confirmed: true,
      quantity_effects: [{ object_id: source['id'], delta: -qty }, { object_id: custodyId, delta: qty }],
      ...this.referenceTrace(ref),
    }
    await this.facts.documents.insert({
      docType: 'SCRAP_CONFIRM', docNo, organizationCode: event.organizationCode, plantCode: event.plantCode,
      sourceEventKey: event.eventKey, businessKey: event.businessKey, materialId: source['id'], qty, unit,
      payload: { goods_movement_code: '03', ...trace, envelope: event.payload, note: '账面报废确认；实物转入有来源的保管对象，未销毁' },
      receipt: { outcome: 'CONFIRMED', applied: true, qty, unit, ...trace },
    })
    return {
      outcome: 'CONFIRMED', messageState: 'ATTEMPT_OBSERVED', applied: true,
      docs: [{ docType: 'SCRAP_CONFIRM', docNo, lineNo: 0, materialId: source['id'], qty, unit }],
      detail: { ...trace, qty, unit },
    }
  }

  private async handleQtyReconciliation(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const docNo = await this.facts.documents.nextDocNo('QTY_RECONCILIATION')
    await this.facts.documents.insert({
      docType: 'QTY_RECONCILIATION',
      docNo,
      organizationCode: event.organizationCode,
      plantCode: event.plantCode,
      sourceEventKey: event.eventKey,
      businessKey: event.businessKey,
      payload: { envelope: event.payload, note: '≠ 21 对象 RECON 产品闭环（R4）' },
      receipt: { outcome: 'CONFIRMED', applied: true },
    })
    return {
      outcome: 'CONFIRMED',
      messageState: 'ATTEMPT_OBSERVED',
      applied: true,
      docs: [{ docType: 'QTY_RECONCILIATION', docNo, lineNo: 0 }],
      detail: { order_close: event.payload },
    }
  }

  // ---- 打包行 / 质量 / 返工 ----

  private async handleExecutionBundle(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const { identity, order } = await this.requireOrder(event)
    const ref = await this.referenceContext(event)
    const orderRef = ref ? this.referencedOrder(event, order, ref) : undefined
    const consumption = this.resolveStockLines(event, extractLines({ consumption_lines: event.payload['consumption_lines'] }), ref, orderRef)
    const outputs = this.resolveStockLines(event, extractLines({ output_lines: event.payload['output_lines'] }), ref, orderRef)
    if (!consumption.length && !outputs.length) throw new SapSimRuleViolation('SAP-SIMENG-12', 'EXECUTION_BUNDLE 需 consumption_lines/output_lines')
    if (outputs.some((line) => line.unit !== order.unit ||
        (ref && (line.skuMaterialId !== order.materialId || line.basis !== orderRef?.['basis'])))) {
      throw new SapSimRuleViolation('SAP-SIMENG-12', '打包最终产出的 SKU/unit/basis 与订单不符')
    }
    const outputQty = outputs.reduce((sum, line) => sum + line.qty, 0)
    if (order.status === 'CANCELLED') return this.rejectNotice(event, 'REJECT_NOTICE', '已取消订单不能新增执行事实')
    if (order.qty !== null && order.producedQty + outputQty > order.qty) {
      return this.rejectNotice(event, 'REJECTED_QTY_EXCEEDED', `最终累计产出 ${order.producedQty + outputQty} 超过订单数量 ${order.qty}`)
    }
    const produced = outputQty > 0 ? await this.facts.orders.addProduced(order.id, outputQty) : order
    if (!produced) return this.rejectNotice(event, 'REJECTED_QTY_EXCEEDED', '最终累计产出超过订单限制')
    const docs: HandlerResult['docs'] = []
    let lineNo = 0
    for (const line of consumption) {
      await this.facts.stock.adjust(
        event.organizationCode,
        event.plantCode,
        line.materialId,
        line.unit,
        -line.qty,
      )
      lineNo += 1
      const docNo = await this.facts.documents.nextDocNo('BUNDLE_LINE_ACK')
      await this.facts.documents.insert({
        docType: 'BUNDLE_LINE_ACK',
        docNo,
        organizationCode: event.organizationCode,
        plantCode: event.plantCode,
        sourceEventKey: event.eventKey,
        businessKey: event.businessKey,
        lineNo,
        materialId: line.materialId,
        qty: -line.qty,
        unit: line.unit,
        payload: {
          kind: 'CONSUMPTION',
          source_object_id: line.materialId,
          qty: line.qty,
          unit: line.unit,
          run_id: event.payload['run_id'] ?? null,
          order_business_key: event.businessKey,
          order_no: identity.orderNo,
          line,
          ...this.referenceTrace(ref),
          envelope: event.payload,
        },
        receipt: { outcome: 'LINES_CONFIRMED', applied: true },
      })
      docs.push({
        docType: 'BUNDLE_LINE_ACK',
        docNo,
        lineNo,
        materialId: line.materialId,
        qty: -line.qty,
        unit: line.unit,
      })
    }
    for (const line of outputs) {
      await this.facts.stock.adjust(event.organizationCode, event.plantCode, line.materialId, line.unit, line.qty)
      lineNo += 1
      const docNo = await this.facts.documents.nextDocNo('BUNDLE_LINE_ACK')
      await this.facts.documents.insert({
        docType: 'BUNDLE_LINE_ACK',
        docNo,
        organizationCode: event.organizationCode,
        plantCode: event.plantCode,
        sourceEventKey: event.eventKey,
        businessKey: event.businessKey,
        lineNo,
        materialId: line.materialId,
        qty: line.qty,
        unit: line.unit,
        payload: {
          kind: 'OUTPUT',
          object_id: line.materialId,
          qty: line.qty,
          unit: line.unit,
          run_id: event.payload['run_id'] ?? null,
          order_business_key: event.businessKey,
          order_no: identity.orderNo,
          line,
          ...this.referenceTrace(ref),
          envelope: event.payload,
        },
        receipt: { outcome: 'LINES_CONFIRMED', applied: true },
      })
      docs.push({
        docType: 'BUNDLE_LINE_ACK',
        docNo,
        lineNo,
        materialId: line.materialId,
        qty: line.qty,
        unit: line.unit,
      })
    }
    if (docs.length === 0) {
      throw new SapSimRuleViolation('SAP-SIMENG-12', 'EXECUTION_BUNDLE 需 consumption_lines/output_lines')
    }
    return {
      outcome: 'LINES_CONFIRMED',
      messageState: 'LINES_CONFIRMED',
      applied: true,
      docs,
      detail: { order_no: identity.orderNo, run_id: event.payload['run_id'] ?? null, line_count: docs.length,
        produced_total: produced.producedQty, released_qty: order.qty, ...this.referenceTrace(ref) },
    }
  }

  private async handleQualityStockBlock(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const docNo = await this.facts.documents.nextDocNo('QUALITY_NOTICE')
    await this.facts.documents.insert({
      docType: 'QUALITY_NOTICE',
      docNo,
      organizationCode: event.organizationCode,
      plantCode: event.plantCode,
      sourceEventKey: event.eventKey,
      businessKey: event.businessKey,
      qty: toQty(event.payload['qty']),
      unit: typeof event.payload['unit'] === 'string' ? event.payload['unit'] : null,
      payload: { envelope: event.payload, note: '传输收到 ≠ 质量状态已过账；不动物料账' },
      receipt: { outcome: 'RECEIVED_NOT_APPLIED', applied: false },
    })
    return {
      outcome: 'RECEIVED_NOT_APPLIED',
      messageState: 'AWAITING_UPSTREAM_APPLICATION',
      applied: false,
      docs: [{ docType: 'QUALITY_NOTICE', docNo, lineNo: 0 }],
      detail: { desired_quality: event.payload['desired_quality'] ?? null, stock_unchanged: true },
    }
  }

  private async handleReworkReclassification(event: SapSimBusinessEvent): Promise<HandlerResult> {
    const reworkRef =
      typeof event.payload['rework_order_id'] === 'string' && event.payload['rework_order_id'].trim() !== ''
        ? event.payload['rework_order_id'].trim()
        : null
    const reworkOrder = await this.facts.orders.findReworkOrder(
      event.organizationCode,
      event.plantCode,
      reworkRef ?? '',
    )
    if (!reworkOrder) {
      const derived = event.payload['rework_order_id'] === null ? await this.rejectedReworkSource(event) : {}
      return this.rejectNotice(
        event,
        'REJECTED_MISSING_REWORK_ORDER',
        reworkRef
          ? `模拟侧无返工指令 ${reworkRef}；先由 SAP 计划员补返工指令，不重新扣 MOM 原轴`
          : '模拟侧无返工指令；先由 SAP 计划员补返工指令，不重新扣 MOM 原轴',
        derived,
      )
    }
    const deduct = toQty(event.payload['deduct_finished_m'])
    const addWip = toQty(event.payload['add_rework_wip_m'])
    const unit = 'm'
    const materialId = reworkOrder.materialId ?? 'REWORK-WIP'
    if (deduct !== null) {
      await this.facts.stock.adjust(event.organizationCode, event.plantCode, materialId, unit, -deduct)
      if (addWip !== null) {
        await this.facts.stock.adjust(
          event.organizationCode,
          event.plantCode,
          `${materialId}-WIP`,
          unit,
          addWip,
        )
      }
    }
    const docNo = await this.facts.documents.nextDocNo('MATERIAL_DOCUMENT')
    await this.facts.documents.insert({
      docType: 'MATERIAL_DOCUMENT',
      docNo,
      organizationCode: event.organizationCode,
      plantCode: event.plantCode,
      sourceEventKey: event.eventKey,
      businessKey: event.businessKey,
      payload: { goods_movement_code: '04', rework_order_no: reworkOrder.orderNo, envelope: event.payload },
      receipt: { outcome: 'CONFIRMED', applied: true },
    })
    return {
      outcome: 'CONFIRMED',
      messageState: 'ATTEMPT_OBSERVED',
      applied: true,
      docs: [{ docType: 'MATERIAL_DOCUMENT', docNo, lineNo: 0 }],
      detail: { rework_order_no: reworkOrder.orderNo, deduct_finished_m: deduct, add_rework_wip_m: addWip },
    }
  }

  private async rejectedReworkSource(event: SapSimBusinessEvent): Promise<Record<string, unknown>> {
    const deduct = toQty(event.payload['deduct_finished_m'])
    const add = toQty(event.payload['add_rework_wip_m'])
    if (deduct === null || add === null || deduct <= 0 || deduct !== add || !event.businessKey) return {}
    const ref = await this.referenceContext(event)
    if (!ref) return {}
    const t = ref.data.tables
    const plant = t.plants.find((row) => row['sap_plant'] === event.plantCode && row['entity_id'] === event.organizationCode)
    const source = t.stock_objects.find((row) => row['id'] === event.businessKey)
    const order = t.orders.find((row) => row['id'] === source?.['original_order_id'])
    if (!plant || !source || !order || source['issuer_plant_id'] !== plant['id'] ||
        source['unit'] !== 'm' || source['basis'] !== order['basis'] || source['material_id'] !== order['material_id']) return {}
    const sourceEvents = t.inventory_events.filter((row) => row['object_id'] === source['id'] &&
      row['plant_context_id'] === plant['id'] && row['action'] === 'APPROVED_ABNORMAL_DEDUCTION' &&
      row['unit'] === 'm' && Number(row['delta']) === -deduct)
    if (sourceEvents.length !== 1) return {}
    const sourceEvent = sourceEvents[0]!
    const documentEvents = t.inventory_events.filter((row) => row['document_id'] === sourceEvent['document_id'])
    if (documentEvents.length !== 2) return {}
    const targetEvents = documentEvents.filter((row) => row['action'] === 'SIM_PHYSICAL_DISPOSITION' &&
      row['object_id'] !== source['id'] && row['plant_context_id'] === plant['id'] && row['unit'] === 'm' &&
      row['at'] === sourceEvent['at'] && Number(row['delta']) === add)
    if (targetEvents.length !== 1) return {}
    const targetEvent = targetEvents[0]!
    const target = t.stock_objects.find((row) => row['id'] === targetEvent['object_id'])
    if (!target || target['issuer_plant_id'] !== plant['id'] || target['material_id'] !== source['material_id'] ||
        target['unit'] !== source['unit'] || target['basis'] !== source['basis'] ||
        !source['original_order_id'] || target['original_order_id'] !== source['original_order_id']) return {}
    return {
      source_object_id: source['id'], target_object_id: target['id'], material_id: source['material_id'],
      unit: source['unit'], basis: source['basis'], original_order_id: source['original_order_id'],
      source_document_id: sourceEvent['document_id'], source_inventory_events: [sourceEvent, targetEvent],
      derived_association_only: true, stock_unchanged: true, target_posting_created: false,
      ...this.referenceTrace(ref),
    }
  }

  // ---------------- 内部：通用 ----------------

  private pickFireable(
    scenarios: FaultScenarioRow[],
    faultType: string,
    event: { eventKey: string; topic: string },
  ): FaultScenarioRow | null {
    return (
      scenarios.find(
        (s) =>
          s.active &&
          s.faultType === faultType &&
          s.remainingCount > 0 &&
          faultScenarioMatches(
            { faultType: s.faultType, matchEventKey: s.matchEventKey, matchTopic: s.matchTopic, active: s.active },
            event,
          ),
      ) ?? null
    )
  }

  /** 放行序中下一个应处理的键：跳过已到达待放行的（保持其在缓冲位）与已处理过的。 */
  private async nextExpectedKey(
    releaseOrder: string[],
    pending: Array<Record<string, unknown>>,
  ): Promise<string> {
    for (const key of releaseOrder) {
      if (pending.some((p) => p['event_key'] === key)) continue // 已在缓冲：等它前面的先处理
      const terminal = await this.facts.outcomes.findTerminal(key)
      if (terminal) continue // 已处理过
      return key
    }
    // 全部就绪/已处理：返回最后一个未处理的缓冲键（允许放行）
    const lastPending = [...releaseOrder].reverse().find((k) => pending.some((p) => p['event_key'] === k))
    return lastPending ?? releaseOrder[releaseOrder.length - 1]
  }

  /** 按配置顺序放行缓冲中的到达（仅当前序键均已处理时）。 */
  private async drainHeld(
    scenarioId: string,
    releaseOrder: string[],
    pending: Array<Record<string, unknown>>,
  ): Promise<void> {
    let rest = pending.filter((p) => releaseOrder.includes(String(p['event_key'])))
    await this.facts.faults.setPending(scenarioId, rest)
    for (const key of releaseOrder) {
      const held = rest.find((p) => p['event_key'] === key)
      if (!held) {
        const done = await this.facts.outcomes.findTerminal(key)
        if (!done) break // 该键未到达：其后键不放行
        continue
      }
      // 前序键必须都已处理
      const priorPending = releaseOrder.slice(0, releaseOrder.indexOf(key)).some((k) => {
        if (rest.some((p) => p['event_key'] === k)) return true
        return false
      })
      if (priorPending) break
      rest = rest.filter((p) => p !== held)
      await this.facts.faults.setPending(scenarioId, rest)
      const event = this.heldToEvent(held)
      if (!event) continue
      await this.processArrival(event, findSapSimTopicMapping(event.topic)?.handler ?? '', String(held['payload_sha256'] ?? ''), [])
    }
  }

  private heldToEvent(held: Record<string, unknown>): SapSimBusinessEvent | null {
    const topic = typeof held['topic'] === 'string' ? held['topic'] : ''
    const organizationCode = typeof held['organization_code'] === 'string' ? held['organization_code'] : ''
    const plantCode = typeof held['plant_code'] === 'string' ? held['plant_code'] : ''
    const eventKey = typeof held['event_key'] === 'string' ? held['event_key'] : ''
    if (!topic || !organizationCode || !plantCode || !eventKey) return null
    return {
      eventKey,
      topic,
      organizationCode,
      plantCode,
      businessKey: typeof held['business_key'] === 'string' ? held['business_key'] : null,
      sourceVersion: typeof held['source_version'] === 'number' ? held['source_version'] : null,
      parentVersion: typeof held['parent_version'] === 'number' ? held['parent_version'] : null,
      occurredAt: null,
      sequence: typeof held['sequence'] === 'number' ? held['sequence'] : null,
      payload:
        held['payload'] !== undefined && typeof held['payload'] === 'object' && held['payload'] !== null
          ? (held['payload'] as Record<string, unknown>)
          : {},
    }
  }

  private async recordOutcome(
    event: SapSimBusinessEvent,
    sha: string,
    outcome: string,
    detail: Record<string, unknown>,
    docNo?: string | null,
  ): Promise<void> {
    const seq = await this.facts.outcomes.nextArrivalSeq(event.eventKey)
    await this.facts.outcomes.insert({
      sourceEventKey: event.eventKey,
      arrivalSeq: seq,
      topic: event.topic,
      payloadSha256: sha,
      outcome,
      docNo: docNo ?? null,
      applied: false,
      detail,
    })
  }

  /** 终局结局入账（含单据号）；故障观察走 recordOutcome。 */
  private async recordTerminalOutcome(
    event: SapSimBusinessEvent,
    sha: string,
    result: HandlerResult,
  ): Promise<void> {
    const seq = await this.facts.outcomes.nextArrivalSeq(event.eventKey)
    await this.facts.outcomes.insert({
      sourceEventKey: event.eventKey,
      arrivalSeq: seq,
      topic: event.topic,
      payloadSha256: sha,
      outcome: result.outcome,
      messageState: result.messageState,
      docNo: result.docs[0]?.docNo ?? null,
      applied: result.applied,
      detail: result.detail,
    })
  }

  private outboxPatchFor(outcome: string): { status: string; lastError: string | null } {
    if (outcome === 'NETWORK_DOWN') {
      return { status: 'FAILED', lastError: 'NETWORK_DOWN (simulated; 同键补传允许)' }
    }
    if (outcome === 'MESSAGE_LOST') return { status: 'PENDING', lastError: 'MESSAGE_LOST (simulated)' }
    if (outcome === 'TIMEOUT_UNKNOWN') {
      return {
        status: 'EXTERNAL_UNKNOWN',
        lastError: 'TIMEOUT_UNKNOWN (响应丢失；事实已提交，按原键查询)',
      }
    }
    if (outcome === 'HELD_FOR_REORDER') return { status: 'PENDING', lastError: 'HELD_FOR_REORDER (乱序缓冲中)' }
    if (outcome === 'RECEIVED_NOT_APPLIED' || outcome === 'WAIT_PARENT_VERSION') {
      return { status: 'PENDING', lastError: `${outcome} (等待上游/父版本)` }
    }
    if (
      outcome.startsWith('REJECT') ||
      outcome.startsWith('REJECTED') ||
      outcome === 'CANCELLED' ||
      outcome === 'STALE_NOOP'
    ) {
      return { status: 'NOOP_NEEDED', lastError: `${outcome} (模拟侧业务拒绝/无操作)` }
    }
    return { status: 'DISPATCHED', lastError: null }
  }

  private async linkOutbox(
    eventKey: string,
    outcome: string,
    docNo: string | null,
    extra: Record<string, unknown>,
  ): Promise<boolean> {
    const row = (await this.outbox.findByExternalRef(eventKey)) ?? (await this.outbox.findByEventId(eventKey))
    if (!row) return false
    const patch = this.outboxPatchFor(outcome)
    const applied = await this.outbox.applyReceipt(row.eventId, {
      status: patch.status,
      lastError: patch.lastError,
      payloadMerge: {
        ...extra,
        sim_receipt_at: this.now().toISOString(),
        sim_actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      },
    })
    return Boolean(applied)
  }

  private async upsertScenario(config: SapSimFaultScenarioConfig): Promise<Record<string, unknown>> {
    const inserted = await this.facts.faults.insert({
      scenarioNo: config.scenario_no,
      faultType: config.fault_type,
      matchEventKey: config.match_event_key ?? null,
      matchTopic: config.match_topic ?? null,
      remainingCount: config.count,
      totalCount: config.count,
      delayMs: config.delay_ms ?? null,
      reorderKeys: config.reorder_keys ?? null,
      pending: [],
      payload: { description: config.description },
    })
    return { ...inserted, description: config.description }
  }

  private receipt(
    event: SapSimBusinessEvent,
    mapping: { sap_operation: string; mapping_tag: string } | null,
    opts: {
      outcome: string
      messageState?: string | null
      applied?: boolean
      docNo?: string | null
      docNos?: string[]
      docType?: string | null
      delivered?: boolean
      responseLost?: boolean
      held?: boolean
      delayedMs?: number | null
      duplicateInjected?: boolean
      outboxUpdated?: boolean
      detail?: Record<string, unknown>
    },
  ): SapSimExecuteReceipt {
    const factPersisted = !INGRESS_FAULT_OUTCOMES.has(opts.outcome)
    return {
      actual_connection: SAP_SIM_ACTUAL_CONNECTION,
      source_system: SAP_SIM_SOURCE_SYSTEM,
      event_key: event.eventKey,
      topic: event.topic,
      sap_operation: mapping?.sap_operation ?? '',
      mapping_tag: mapping?.mapping_tag ?? '',
      outcome: opts.outcome,
      message_state: opts.messageState ?? null,
      applied: opts.applied ?? false,
      doc_no: opts.docNo ?? null,
      doc_nos: opts.docNos ?? [],
      doc_type: opts.docType ?? null,
      delivered: opts.delivered ?? true,
      response_lost: opts.responseLost ?? false,
      held: opts.held ?? false,
      delayed_ms: opts.delayedMs ?? null,
      duplicate_injected: opts.duplicateInjected ?? false,
      sim_facts_persisted: factPersisted,
      outbox_updated: opts.outboxUpdated ?? false,
      detail: opts.detail ?? {},
    }
  }
}
