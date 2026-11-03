import type {
  NewSapReconciliationItem,
  SapReconciliationFilter,
  SapReconciliationItemRecord,
  SapReconciliationRepository,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

const COLUMNS = `id, recon_no AS "reconNo", object_code AS "objectCode", object_name AS "objectName",
  mom_qty AS "momQty", sap_qty AS "sapQty", diff_qty AS "diffQty", currency_code AS "currencyCode",
  match_status AS "matchStatus", match_status AS "classification", title, reason, payload,
  enterprise_id AS "enterpriseId", plant_id AS "plantId",
  sap_stock_state AS "sapStockState", mom_hold AS "momHold", unknown_slice_qty AS "unknownSliceQty",
  created_at AS "createdAt", created_by AS "createdBy",
  updated_at AS "updatedAt", updated_by AS "updatedBy"`

export class PgSapReconciliationRepository implements SapReconciliationRepository {
  constructor(private readonly client: SqlClient) {}

  async listPaged(
    filter: SapReconciliationFilter,
  ): Promise<{ total: number; items: SapReconciliationItemRecord[] }> {
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
    if (filter.matchStatus) {
      where.push(`match_status = $${i++}`)
      params.push(filter.matchStatus)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const countR = await this.client.query(
      `SELECT count(*)::text AS count FROM sap_reconciliation_item ${wh}`,
      params,
    )
    const total = Number((countR.rows[0] as { count?: string } | undefined)?.count ?? 0)
    const listParams = [...params, filter.limit, filter.offset]
    const r = await this.client.query(
      `SELECT ${COLUMNS} FROM sap_reconciliation_item ${wh}
       ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`,
      listParams,
    )
    return { total, items: r.rows as SapReconciliationItemRecord[] }
  }

  async countByClassification(filter: {
    plantIds: string[] | null
    plantId?: string
  }): Promise<Record<string, number>> {
    const where: string[] = []
    const params: unknown[] = []
    let i = 1
    if (filter.plantIds !== null) {
      if (filter.plantIds.length === 0) return {}
      where.push(`plant_id = ANY($${i++}::uuid[])`)
      params.push(filter.plantIds)
    }
    if (filter.plantId) {
      where.push(`plant_id = $${i++}::uuid`)
      params.push(filter.plantId)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const r = await this.client.query(
      `SELECT match_status AS status, count(*)::text AS count
       FROM sap_reconciliation_item ${wh}
       GROUP BY match_status`,
      params,
    )
    const out: Record<string, number> = {}
    for (const row of r.rows as Array<{ status: string; count: string }>) {
      out[row.status] = Number(row.count)
    }
    return out
  }

  async insert(row: NewSapReconciliationItem): Promise<SapReconciliationItemRecord> {
    const r = await this.client.query(
      `INSERT INTO sap_reconciliation_item (
         id, recon_no, object_code, object_name, mom_qty, sap_qty, diff_qty, currency_code,
         match_status, title, reason, payload, enterprise_id, plant_id, command_receipt_id,
         sap_stock_state, mom_hold, unknown_slice_qty,
         created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$19)
       RETURNING ${COLUMNS}`,
      [
        row.id, row.reconNo, row.objectCode, row.objectName ?? null,
        row.momQty ?? null, row.sapQty ?? null, row.diffQty ?? null, row.currencyCode ?? null,
        row.matchStatus, row.title, row.reason, JSON.stringify(row.payload ?? {}),
        row.enterpriseId, row.plantId, row.commandReceiptId ?? null,
        row.sapStockState ?? null, row.momHold ?? null, row.unknownSliceQty ?? null,
        row.createdBy,
      ],
    )
    return r.rows[0] as SapReconciliationItemRecord
  }
}

export function createPgSapReconRepositories(client: SqlClient): {
  sapReconciliation: SapReconciliationRepository
} {
  return { sapReconciliation: new PgSapReconciliationRepository(client) }
}
