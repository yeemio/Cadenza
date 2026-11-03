/** SAP_SIM / outbox·inbox HTTP 仓储端口（落 0001 平台表；≠ 域内 shipping/purchase/conversion sync）。 */

export interface SapSimOutboxRecord {
  eventId: string
  aggregateType: string
  aggregateId: string
  taskKind: string
  status: string
  payload: Record<string, unknown>
  externalRef: string | null
  requestDigest: string | null
  attemptCount: number
  nextRetryAt: Date | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

export interface SapSimInboxRecord {
  id: string
  sourceSystem: string
  organizationCode: string
  externalKey: string
  entityType: string
  externalRevision: string | null
  payload: Record<string, unknown> | null
  status: string
  quarantineReason: string | null
  processedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface NewSapSimOutbox {
  aggregateType: string
  aggregateId: string
  taskKind: string
  status: string
  payload: Record<string, unknown>
  externalRef?: string | null
  requestDigest: string
}

export interface NewSapSimInbox {
  sourceSystem: string
  organizationCode: string
  externalKey: string
  entityType: string
  externalRevision?: string | null
  payload: Record<string, unknown>
  status: string
  quarantineReason?: string | null
}

export interface SapSimOutboxFilter {
  status?: string
  taskKind?: string
  aggregateType?: string
  limit: number
  offset: number
}

export interface SapSimInboxFilter {
  status?: string
  sourceSystem?: string
  organizationCode?: string
  limit: number
  offset: number
}

export interface SapSimOutboxStatusUpdate {
  status: string
  lastError?: string | null
  /** 成功补传时可清空 last_error */
  clearLastError?: boolean
  nextRetryAt?: Date | null
  /** 每次 fail/replay 默认 +1 */
  bumpAttempt?: boolean
  /** 合并写入 payload jsonb（保留原键；用于 attempt_outcome 等 SIM 剧本字段） */
  payloadMerge?: Record<string, unknown>
}

export interface SapSimOutboxRepository {
  listPaged(filter: SapSimOutboxFilter): Promise<{ total: number; items: SapSimOutboxRecord[] }>
  findByEventId(eventId: string): Promise<SapSimOutboxRecord | null>
  findByExternalRef(externalRef: string): Promise<SapSimOutboxRecord | null>
  findByRequestDigest(digest: string): Promise<SapSimOutboxRecord | null>
  insert(row: NewSapSimOutbox): Promise<SapSimOutboxRecord>
  /** 就地更新投递状态（保留 event_id / request_digest / external_ref 原键）。 */
  updateDelivery(eventId: string, patch: SapSimOutboxStatusUpdate): Promise<SapSimOutboxRecord | null>
}

export interface SapSimInboxRepository {
  listPaged(filter: SapSimInboxFilter): Promise<{ total: number; items: SapSimInboxRecord[] }>
  findByKey(key: {
    sourceSystem: string
    organizationCode: string
    externalKey: string
    entityType: string
  }): Promise<SapSimInboxRecord | null>
  insert(row: NewSapSimInbox): Promise<SapSimInboxRecord>
}

export interface SapSimRepositories {
  outbox: SapSimOutboxRepository
  inbox: SapSimInboxRepository
}
