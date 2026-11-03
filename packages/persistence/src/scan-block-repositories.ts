import type {
  NewScanBlockEvent,
  ScanBlockEventFilter,
  ScanBlockEventRecord,
  ScanBlockEventRepository,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

const COLUMNS = `id, event_no AS "eventNo", policy_code AS "policyCode", scan_code AS "scanCode",
  block_reason AS "blockReason", severity, status, payload,
  enterprise_id AS "enterpriseId", plant_id AS "plantId",
  created_at AS "createdAt", created_by AS "createdBy",
  updated_at AS "updatedAt", updated_by AS "updatedBy"`

export class PgScanBlockEventRepository implements ScanBlockEventRepository {
  constructor(private readonly client: SqlClient) {}

  async listPaged(
    filter: ScanBlockEventFilter,
  ): Promise<{ total: number; items: ScanBlockEventRecord[] }> {
    const where: string[] = []
    const params: unknown[] = []
    let i = 1
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return { total: 0, items: [] }
      where.push(`plant_id = ANY($${i++}::uuid[])`)
      params.push(filter.plantIds)
    }
    if (filter.plantId) {
      where.push(`plant_id = $${i++}::uuid`)
      params.push(filter.plantId)
    }
    if (filter.policyCode) {
      where.push(`policy_code = $${i++}`)
      params.push(filter.policyCode)
    }
    if (filter.status) {
      where.push(`status = $${i++}`)
      params.push(filter.status)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const countR = await this.client.query(
      `SELECT count(*)::text AS count FROM scan_block_event ${wh}`,
      params,
    )
    const total = Number((countR.rows[0] as { count?: string } | undefined)?.count ?? 0)
    const listParams = [...params, filter.limit, filter.offset]
    const r = await this.client.query(
      `SELECT ${COLUMNS} FROM scan_block_event ${wh}
       ORDER BY created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      listParams,
    )
    return { total, items: r.rows as ScanBlockEventRecord[] }
  }

  async insert(row: NewScanBlockEvent): Promise<ScanBlockEventRecord> {
    const r = await this.client.query(
      `INSERT INTO scan_block_event (
         id, event_no, policy_code, scan_code, block_reason, severity, status, payload,
         enterprise_id, plant_id, command_receipt_id, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$12)
       RETURNING ${COLUMNS}`,
      [
        row.id,
        row.eventNo,
        row.policyCode,
        row.scanCode,
        row.blockReason,
        row.severity,
        row.status,
        JSON.stringify(row.payload ?? {}),
        row.enterpriseId,
        row.plantId,
        row.commandReceiptId ?? null,
        row.createdBy,
      ],
    )
    return r.rows[0] as ScanBlockEventRecord
  }
}

export function createPgScanBlockRepositories(client: SqlClient): {
  scanBlockEvents: ScanBlockEventRepository
} {
  return {
    scanBlockEvents: new PgScanBlockEventRepository(client),
  }
}
