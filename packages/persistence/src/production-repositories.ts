import type {
  FeedRacePlanFilter,
  FeedRacePlanRecord,
  FeedRacePlanRepository,
  NewFeedRacePlan,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

const COLUMNS = `id, plan_no AS "planNo", plan_kind AS "planKind", title, reason, status, payload,
  enterprise_id AS "enterpriseId", plant_id AS "plantId",
  created_at AS "createdAt", created_by AS "createdBy",
  updated_at AS "updatedAt", updated_by AS "updatedBy"`

export class PgFeedRacePlanRepository implements FeedRacePlanRepository {
  constructor(private readonly client: SqlClient) {}

  async listPaged(
    filter: FeedRacePlanFilter,
  ): Promise<{ total: number; items: FeedRacePlanRecord[] }> {
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
    if (filter.planKind) {
      where.push(`plan_kind = $${i++}`)
      params.push(filter.planKind)
    }
    if (filter.status) {
      where.push(`status = $${i++}`)
      params.push(filter.status)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const countR = await this.client.query(
      `SELECT count(*)::text AS count FROM production_feed_race_plan ${wh}`,
      params,
    )
    const total = Number((countR.rows[0] as { count?: string } | undefined)?.count ?? 0)
    const listParams = [...params, filter.limit, filter.offset]
    const r = await this.client.query(
      `SELECT ${COLUMNS} FROM production_feed_race_plan ${wh}
       ORDER BY created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      listParams,
    )
    return { total, items: r.rows as FeedRacePlanRecord[] }
  }

  async insert(row: NewFeedRacePlan): Promise<FeedRacePlanRecord> {
    const r = await this.client.query(
      `INSERT INTO production_feed_race_plan (
         id, plan_no, plan_kind, title, reason, status, payload,
         enterprise_id, plant_id, command_receipt_id, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$11)
       RETURNING ${COLUMNS}`,
      [
        row.id,
        row.planNo,
        row.planKind,
        row.title,
        row.reason,
        row.status,
        JSON.stringify(row.payload ?? {}),
        row.enterpriseId,
        row.plantId,
        row.commandReceiptId ?? null,
        row.createdBy,
      ],
    )
    return r.rows[0] as FeedRacePlanRecord
  }
}

export function createPgProductionRepositories(client: SqlClient): {
  feedRacePlans: FeedRacePlanRepository
} {
  return {
    feedRacePlans: new PgFeedRacePlanRepository(client),
  }
}
