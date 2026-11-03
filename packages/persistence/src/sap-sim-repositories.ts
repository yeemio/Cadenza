import type {
  NewSapSimInbox,
  NewSapSimOutbox,
  SapSimInboxFilter,
  SapSimInboxRecord,
  SapSimInboxRepository,
  SapSimOutboxFilter,
  SapSimOutboxRecord,
  SapSimOutboxRepository,
  SapSimOutboxStatusUpdate,
  SapSimRepositories,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

const OUTBOX_COLUMNS = `event_id AS "eventId", aggregate_type AS "aggregateType", aggregate_id AS "aggregateId",
  task_kind AS "taskKind", status, payload, external_ref AS "externalRef",
  request_digest AS "requestDigest", attempt_count AS "attemptCount",
  next_retry_at AS "nextRetryAt", last_error AS "lastError",
  created_at AS "createdAt", updated_at AS "updatedAt"`

const INBOX_COLUMNS = `id, source_system AS "sourceSystem", organization_code AS "organizationCode",
  external_key AS "externalKey", entity_type AS "entityType",
  external_revision AS "externalRevision", payload, status,
  quarantine_reason AS "quarantineReason", processed_at AS "processedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`

export class PgSapSimOutboxRepository implements SapSimOutboxRepository {
  constructor(private readonly client: SqlClient) {}

  async listPaged(filter: SapSimOutboxFilter): Promise<{ total: number; items: SapSimOutboxRecord[] }> {
    const where: string[] = []
    const params: unknown[] = []
    let i = 1
    if (filter.status) {
      where.push(`status = $${i++}`)
      params.push(filter.status)
    }
    if (filter.taskKind) {
      where.push(`task_kind = $${i++}`)
      params.push(filter.taskKind)
    }
    if (filter.aggregateType) {
      where.push(`aggregate_type = $${i++}`)
      params.push(filter.aggregateType)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const countR = await this.client.query(`SELECT count(*)::text AS count FROM outbox ${wh}`, params)
    const total = Number((countR.rows[0] as { count?: string } | undefined)?.count ?? 0)
    const listParams = [...params, filter.limit, filter.offset]
    const r = await this.client.query(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox ${wh}
       ORDER BY created_at DESC, event_id DESC
       LIMIT $${i++} OFFSET $${i++}`,
      listParams,
    )
    return { total, items: r.rows as SapSimOutboxRecord[] }
  }

  async findByEventId(eventId: string): Promise<SapSimOutboxRecord | null> {
    const r = await this.client.query(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE event_id = $1`,
      [eventId],
    )
    return (r.rows[0] as SapSimOutboxRecord | undefined) ?? null
  }

  async findByExternalRef(externalRef: string): Promise<SapSimOutboxRecord | null> {
    const r = await this.client.query(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE external_ref = $1 ORDER BY created_at ASC LIMIT 1`,
      [externalRef],
    )
    return (r.rows[0] as SapSimOutboxRecord | undefined) ?? null
  }

  async findByRequestDigest(digest: string): Promise<SapSimOutboxRecord | null> {
    const r = await this.client.query(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE request_digest = $1 ORDER BY created_at ASC LIMIT 1`,
      [digest],
    )
    return (r.rows[0] as SapSimOutboxRecord | undefined) ?? null
  }

  async insert(row: NewSapSimOutbox): Promise<SapSimOutboxRecord> {
    const r = await this.client.query(
      `INSERT INTO outbox (
         aggregate_type, aggregate_id, task_kind, status, payload, external_ref, request_digest
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       RETURNING ${OUTBOX_COLUMNS}`,
      [
        row.aggregateType,
        row.aggregateId,
        row.taskKind,
        row.status,
        JSON.stringify(row.payload),
        row.externalRef ?? null,
        row.requestDigest,
      ],
    )
    return r.rows[0] as SapSimOutboxRecord
  }

  async updateDelivery(
    eventId: string,
    patch: SapSimOutboxStatusUpdate,
  ): Promise<SapSimOutboxRecord | null> {
    const sets: string[] = ['status = $2', 'updated_at = now()']
    const params: unknown[] = [eventId, patch.status]
    let i = 3
    if (patch.clearLastError) {
      sets.push('last_error = NULL')
    } else if (patch.lastError !== undefined) {
      sets.push(`last_error = $${i++}`)
      params.push(patch.lastError)
    }
    if (patch.nextRetryAt !== undefined) {
      sets.push(`next_retry_at = $${i++}`)
      params.push(patch.nextRetryAt)
    }
    if (patch.bumpAttempt !== false) {
      sets.push('attempt_count = attempt_count + 1')
    }
    if (patch.payloadMerge !== undefined) {
      sets.push(`payload = COALESCE(payload, '{}'::jsonb) || $${i++}::jsonb`)
      params.push(JSON.stringify(patch.payloadMerge))
    }
    const r = await this.client.query(
      `UPDATE outbox SET ${sets.join(', ')} WHERE event_id = $1 RETURNING ${OUTBOX_COLUMNS}`,
      params,
    )
    return (r.rows[0] as SapSimOutboxRecord | undefined) ?? null
  }
}

export class PgSapSimInboxRepository implements SapSimInboxRepository {
  constructor(private readonly client: SqlClient) {}

  async listPaged(filter: SapSimInboxFilter): Promise<{ total: number; items: SapSimInboxRecord[] }> {
    const where: string[] = []
    const params: unknown[] = []
    let i = 1
    if (filter.status) {
      where.push(`status = $${i++}`)
      params.push(filter.status)
    }
    if (filter.sourceSystem) {
      where.push(`source_system = $${i++}`)
      params.push(filter.sourceSystem)
    }
    if (filter.organizationCode) {
      where.push(`organization_code = $${i++}`)
      params.push(filter.organizationCode)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const countR = await this.client.query(`SELECT count(*)::text AS count FROM inbox ${wh}`, params)
    const total = Number((countR.rows[0] as { count?: string } | undefined)?.count ?? 0)
    const listParams = [...params, filter.limit, filter.offset]
    const r = await this.client.query(
      `SELECT ${INBOX_COLUMNS} FROM inbox ${wh}
       ORDER BY created_at DESC, id DESC
       LIMIT $${i++} OFFSET $${i++}`,
      listParams,
    )
    return { total, items: r.rows as SapSimInboxRecord[] }
  }

  async findByKey(key: {
    sourceSystem: string
    organizationCode: string
    externalKey: string
    entityType: string
  }): Promise<SapSimInboxRecord | null> {
    const r = await this.client.query(
      `SELECT ${INBOX_COLUMNS} FROM inbox
       WHERE source_system = $1 AND organization_code = $2 AND external_key = $3 AND entity_type = $4`,
      [key.sourceSystem, key.organizationCode, key.externalKey, key.entityType],
    )
    return (r.rows[0] as SapSimInboxRecord | undefined) ?? null
  }

  async insert(row: NewSapSimInbox): Promise<SapSimInboxRecord> {
    const r = await this.client.query(
      `INSERT INTO inbox (
         source_system, organization_code, external_key, entity_type, external_revision,
         payload, status, quarantine_reason
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       RETURNING ${INBOX_COLUMNS}`,
      [
        row.sourceSystem,
        row.organizationCode,
        row.externalKey,
        row.entityType,
        row.externalRevision ?? null,
        JSON.stringify(row.payload),
        row.status,
        row.quarantineReason ?? null,
      ],
    )
    return r.rows[0] as SapSimInboxRecord
  }
}

export function createPgSapSimRepositories(client: SqlClient): SapSimRepositories {
  return {
    outbox: new PgSapSimOutboxRepository(client),
    inbox: new PgSapSimInboxRepository(client),
  }
}
