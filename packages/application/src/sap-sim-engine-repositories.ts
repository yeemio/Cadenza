/**
 * R1 模拟 SAP 侧事实仓储端口（sim_sap_* 表；与 MOM 业务表物理分离）。
 * 模拟器经此读写自身事实；MOM 侧仅经 outbox/inbox 交换（不直读 sim 表写业务结论）。
 */

export interface SapSimOrderFactRecord {
  id: string
  organizationCode: string
  plantCode: string
  orderNo: string
  orderKind: 'PRODUCTION' | 'REWORK'
  sourceEventKey: string
  orderVersion: number
  parentVersion: number | null
  qty: number | null
  unit: string | null
  materialId: string | null
  producedQty: number
  status: 'RELEASED' | 'REVISED' | 'PRODUCED' | 'CANCELLED'
  payload: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface NewSapSimOrderFact {
  organizationCode: string
  plantCode: string
  orderNo: string
  orderKind: 'PRODUCTION' | 'REWORK'
  sourceEventKey: string
  orderVersion: number
  parentVersion?: number | null
  qty?: number | null
  unit?: string | null
  materialId?: string | null
  /** Cumulative final output inherited by a new order version. */
  producedQty?: number
  payload?: Record<string, unknown>
  status?: 'RELEASED' | 'REVISED'
}

export interface SapSimDocumentFactRecord {
  id: string
  docType: string
  docNo: string
  organizationCode: string
  plantCode: string
  sourceEventKey: string
  businessKey: string | null
  lineNo: number
  status: 'COMMITTED' | 'REVERSED'
  reversalOf: string | null
  materialId: string | null
  qty: number | null
  unit: string | null
  payload: Record<string, unknown>
  receipt: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface NewSapSimDocumentFact {
  docType: string
  docNo: string
  organizationCode: string
  plantCode: string
  sourceEventKey: string
  businessKey?: string | null
  lineNo?: number
  materialId?: string | null
  qty?: number | null
  unit?: string | null
  payload?: Record<string, unknown>
  receipt?: Record<string, unknown>
}

export interface SapSimStockFactRecord {
  id: string
  organizationCode: string
  plantCode: string
  materialId: string
  unit: string
  qty: number
  updatedAt: Date
}

export interface SapSimInTransitFactRecord {
  id: string
  transferKey: string
  organizationCode: string
  fromPlant: string
  toPlant: string
  materialId: string
  unit: string
  qty: number
  status: 'IN_TRANSIT' | 'RECEIVED'
  issueDocId: string | null
  receiptDocId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface SapSimEventOutcomeRecord {
  id: string
  sourceEventKey: string
  arrivalSeq: number
  topic: string
  payloadSha256: string
  outcome: string
  messageState: string | null
  docNo: string | null
  applied: boolean
  detail: Record<string, unknown>
  createdAt: Date
}

export interface NewSapSimEventOutcome {
  sourceEventKey: string
  arrivalSeq: number
  topic: string
  payloadSha256: string
  outcome: string
  messageState?: string | null
  docNo?: string | null
  applied?: boolean
  detail?: Record<string, unknown>
}

export interface SapSimFaultScenarioRecord {
  id: string
  scenarioNo: string
  faultType:
    | 'MESSAGE_LOST'
    | 'RESPONSE_LOST'
    | 'DELAY'
    | 'DUPLICATE'
    | 'REORDER'
    | 'QUERY_UNAVAILABLE'
    | 'BUSINESS_REJECT'
    | 'NETWORK_DOWN'
  matchEventKey: string | null
  matchTopic: string | null
  remainingCount: number
  totalCount: number
  delayMs: number | null
  reorderKeys: string[] | null
  pending: Array<Record<string, unknown>>
  active: boolean
  payload: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface NewSapSimFaultScenario {
  scenarioNo: string
  faultType: SapSimFaultScenarioRecord['faultType']
  matchEventKey?: string | null
  matchTopic?: string | null
  remainingCount: number
  totalCount?: number
  delayMs?: number | null
  reorderKeys?: string[] | null
  pending?: Array<Record<string, unknown>>
  payload?: Record<string, unknown>
}

export interface SapSimOrderFactRepository {
  findByIdentity(organizationCode: string, plantCode: string, orderNo: string): Promise<SapSimOrderFactRecord | null>
  findVersion(
    organizationCode: string,
    plantCode: string,
    orderNo: string,
    orderVersion: number,
  ): Promise<SapSimOrderFactRecord | null>
  findBySameOrderNoDifferentOrg(plantCode: string, orderNo: string): Promise<SapSimOrderFactRecord | null>
  findByEventKey(eventKey: string): Promise<SapSimOrderFactRecord | null>
  findReworkOrder(organizationCode: string, plantCode: string, refId: string): Promise<SapSimOrderFactRecord | null>
  insert(row: NewSapSimOrderFact): Promise<SapSimOrderFactRecord>
  addProduced(id: string, qty: number): Promise<SapSimOrderFactRecord | null>
  markStatus(id: string, status: SapSimOrderFactRecord['status']): Promise<SapSimOrderFactRecord | null>
  list(organizationCode?: string): Promise<SapSimOrderFactRecord[]>
}

export interface SapSimDocumentFactRepository {
  findById(id: string): Promise<SapSimDocumentFactRecord | null>
  findByEventKey(eventKey: string): Promise<SapSimDocumentFactRecord[]>
  findByDocNo(docNo: string): Promise<SapSimDocumentFactRecord | null>
  listByBusinessKey(businessKey: string): Promise<SapSimDocumentFactRecord[]>
  listForOrder(organizationCode: string, plantCode: string, orderNo: string): Promise<SapSimDocumentFactRecord[]>
  listMasterBundles(organizationCode: string, plantCode: string): Promise<SapSimDocumentFactRecord[]>
  list(filter?: { plantCode?: string; docType?: string; limit?: number }): Promise<SapSimDocumentFactRecord[]>
  nextDocNo(docType: string): Promise<string>
  insert(row: NewSapSimDocumentFact): Promise<SapSimDocumentFactRecord>
}

export interface SapSimStockFactRepository {
  find(
    organizationCode: string,
    plantCode: string,
    materialId: string,
    unit: string,
  ): Promise<SapSimStockFactRecord | null>
  /** Lock the actual source balance inside an event transaction. */
  findForUpdate(organizationCode: string, plantCode: string, materialId: string, unit: string): Promise<SapSimStockFactRecord | null>
  /** 增减库存（不存在则建行）；返回调整后行。 */
  adjust(
    organizationCode: string,
    plantCode: string,
    materialId: string,
    unit: string,
    delta: number,
  ): Promise<SapSimStockFactRecord>
  list(organizationCode?: string): Promise<SapSimStockFactRecord[]>
}

export interface SapSimInTransitFactRepository {
  find(transferKey: string, materialId: string, unit: string): Promise<SapSimInTransitFactRecord | null>
  insert(row: {
    transferKey: string
    organizationCode: string
    fromPlant: string
    toPlant: string
    materialId: string
    unit: string
    qty: number
    issueDocId?: string | null
  }): Promise<SapSimInTransitFactRecord>
  adjustQty(id: string, delta: number): Promise<SapSimInTransitFactRecord | null>
  markReceived(id: string, receiptDocId: string): Promise<SapSimInTransitFactRecord | null>
}

export interface SapSimEventOutcomeRepository {
  nextArrivalSeq(eventKey: string): Promise<number>
  listByEventKey(eventKey: string): Promise<SapSimEventOutcomeRecord[]>
  /** 首条业务终局（非故障观察）结局。 */
  findTerminal(eventKey: string): Promise<SapSimEventOutcomeRecord | null>
  insert(row: NewSapSimEventOutcome): Promise<SapSimEventOutcomeRecord>
}

export interface SapSimFaultScenarioRepository {
  list(): Promise<SapSimFaultScenarioRecord[]>
  findByScenarioNo(scenarioNo: string): Promise<SapSimFaultScenarioRecord | null>
  insert(row: NewSapSimFaultScenario): Promise<SapSimFaultScenarioRecord>
  /** 命中消耗一次（remaining-1，写回）；remaining<=0 视为已耗尽不再命中。 */
  consume(id: string): Promise<SapSimFaultScenarioRecord | null>
  /** 更新乱序缓冲（重启可恢复）。 */
  setPending(id: string, pending: Array<Record<string, unknown>>): Promise<SapSimFaultScenarioRecord | null>
  setActive(id: string, active: boolean): Promise<SapSimFaultScenarioRecord | null>
}

export interface SapSimFactsRepositories {
  orders: SapSimOrderFactRepository
  documents: SapSimDocumentFactRepository
  stock: SapSimStockFactRepository
  inTransit: SapSimInTransitFactRepository
  outcomes: SapSimEventOutcomeRepository
  faults: SapSimFaultScenarioRepository
  /** Same-event serialization and atomic facts/documents/outcome; a supplied client is already transaction-bound. */
  runInEventTransaction<T>(eventKey: string, work: (facts: SapSimFactsRepositories) => Promise<T>): Promise<T>
}

/** A1000/B1000 查询端口（SapSimService.queryConfirm 经此由 sim_sap 事实回答）。 */
export interface SapSimFactQueryPort {
  queryByEventKey(eventKey: string): Promise<{
    /** false=查询通道不可用（B1000） */
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
  }>
}

/** 模拟器按回执更新 MOM outbox 状态的最小端口（仅平台 outbox 表）。 */
export interface SapSimOutboxReceiptPort {
  findByEventId(eventId: string): Promise<{
    eventId: string
    status: string
    externalRef: string | null
    payload: Record<string, unknown>
  } | null>
  /** 按外部事件键（external_ref=冻结 event_key）查找 outbox 行。 */
  findByExternalRef(externalRef: string): Promise<{
    eventId: string
    status: string
    externalRef: string | null
    payload: Record<string, unknown>
  } | null>
  applyReceipt(
    eventId: string,
    patch: { status: string; lastError?: string | null; payloadMerge: Record<string, unknown> },
  ): Promise<{ eventId: string; status: string } | null>
}
