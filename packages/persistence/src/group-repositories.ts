import type {
  GroupAllocationRevisionFilter,
  GroupAllocationRevisionRecord,
  GroupAllocationRevisionRepository,
  GroupShortageKittingFilter,
  GroupShortageKittingRecord,
  GroupShortageKittingRepository,
  GroupProductRecallFilter,
  GroupProductRecallRecord,
  GroupProductRecallRepository,
  GroupVendorRiskFilter,
  GroupVendorRiskRecord,
  GroupVendorRiskRepository,
  GroupReworkWriteFilter,
  GroupReworkWriteRecord,
  GroupReworkWriteRepository,
  GroupScrapWriteFilter,
  GroupScrapWriteRecord,
  GroupScrapWriteRepository,
  NewGroupAllocationRevision,
  NewGroupShortageKittingResult,
  NewGroupProductRecall,
  NewGroupVendorRisk,
  NewGroupReworkWrite,
  NewGroupScrapWrite,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

const ALLOC_COLUMNS = `id, revision_no AS "revisionNo", title, reason, status, payload,
  enterprise_id AS "enterpriseId", plant_id AS "plantId",
  created_at AS "createdAt", created_by AS "createdBy",
  updated_at AS "updatedAt", updated_by AS "updatedBy"`

const KIT_COLUMNS = `id, order_no AS "orderNo", order_id AS "orderId", check_status AS "checkStatus",
  shortage_lines AS "shortageLines", checked_at AS "checkedAt",
  enterprise_id AS "enterpriseId", plant_id AS "plantId",
  created_at AS "createdAt", created_by AS "createdBy"`

export class PgGroupAllocationRevisionRepository implements GroupAllocationRevisionRepository {
  constructor(private readonly client: SqlClient) {}

  async listPaged(
    filter: GroupAllocationRevisionFilter,
  ): Promise<{ total: number; items: GroupAllocationRevisionRecord[] }> {
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
    if (filter.status) {
      where.push(`status = $${i++}`)
      params.push(filter.status)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const countR = await this.client.query(
      `SELECT count(*)::text AS count FROM group_allocation_revision ${wh}`,
      params,
    )
    const total = Number((countR.rows[0] as { count?: string } | undefined)?.count ?? 0)
    const listParams = [...params, filter.limit, filter.offset]
    const r = await this.client.query(
      `SELECT ${ALLOC_COLUMNS} FROM group_allocation_revision ${wh}
       ORDER BY created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      listParams,
    )
    return { total, items: r.rows as GroupAllocationRevisionRecord[] }
  }

  async findById(id: string): Promise<GroupAllocationRevisionRecord | null> {
    const r = await this.client.query(
      `SELECT ${ALLOC_COLUMNS} FROM group_allocation_revision WHERE id = $1`,
      [id],
    )
    return (r.rows[0] as GroupAllocationRevisionRecord | undefined) ?? null
  }

  async insert(row: NewGroupAllocationRevision): Promise<GroupAllocationRevisionRecord> {
    const r = await this.client.query(
      `INSERT INTO group_allocation_revision (
         id, revision_no, title, reason, status, payload,
         enterprise_id, plant_id, command_receipt_id, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$10)
       RETURNING ${ALLOC_COLUMNS}`,
      [
        row.id,
        row.revisionNo,
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
    return r.rows[0] as GroupAllocationRevisionRecord
  }
}

export class PgGroupShortageKittingRepository implements GroupShortageKittingRepository {
  constructor(private readonly client: SqlClient) {}

  async listPaged(
    filter: GroupShortageKittingFilter,
  ): Promise<{ total: number; items: GroupShortageKittingRecord[] }> {
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
    if (filter.orderNoLike) {
      where.push(`order_no ILIKE $${i++}`)
      params.push(`%${filter.orderNoLike}%`)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const countR = await this.client.query(
      `SELECT count(*)::text AS count FROM group_shortage_kitting_result ${wh}`,
      params,
    )
    const total = Number((countR.rows[0] as { count?: string } | undefined)?.count ?? 0)
    const listParams = [...params, filter.limit, filter.offset]
    const r = await this.client.query(
      `SELECT ${KIT_COLUMNS} FROM group_shortage_kitting_result ${wh}
       ORDER BY checked_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      listParams,
    )
    return { total, items: r.rows as GroupShortageKittingRecord[] }
  }

  async insert(row: NewGroupShortageKittingResult): Promise<GroupShortageKittingRecord> {
    const r = await this.client.query(
      `INSERT INTO group_shortage_kitting_result (
         id, order_no, order_id, check_status, shortage_lines,
         enterprise_id, plant_id, command_receipt_id, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$9)
       RETURNING ${KIT_COLUMNS}`,
      [
        row.id,
        row.orderNo,
        row.orderId ?? null,
        row.checkStatus,
        JSON.stringify(row.shortageLines ?? []),
        row.enterpriseId,
        row.plantId,
        row.commandReceiptId ?? null,
        row.createdBy,
      ],
    )
    return r.rows[0] as GroupShortageKittingRecord
  }
}


const RECALL_COLUMNS = `id, recall_no AS "recallNo", recall_scope AS "recallScope",
  batch_no AS "batchNo", material_code AS "materialCode", title, reason, status, payload,
  enterprise_id AS "enterpriseId", plant_id AS "plantId",
  created_at AS "createdAt", created_by AS "createdBy",
  updated_at AS "updatedAt", updated_by AS "updatedBy"`

const VENDOR_COLUMNS = `id, risk_no AS "riskNo", vendor_code AS "vendorCode",
  vendor_name AS "vendorName", risk_level AS "riskLevel", title, reason, status, payload,
  enterprise_id AS "enterpriseId", plant_id AS "plantId",
  created_at AS "createdAt", created_by AS "createdBy",
  updated_at AS "updatedAt", updated_by AS "updatedBy"`

export class PgGroupProductRecallRepository implements GroupProductRecallRepository {
  constructor(private readonly client: SqlClient) {}

  async listPaged(
    filter: GroupProductRecallFilter,
  ): Promise<{ total: number; items: GroupProductRecallRecord[] }> {
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
    if (filter.status) {
      where.push(`status = $${i++}`)
      params.push(filter.status)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const countR = await this.client.query(
      `SELECT count(*)::text AS count FROM group_product_recall ${wh}`,
      params,
    )
    const total = Number((countR.rows[0] as { count?: string } | undefined)?.count ?? 0)
    const listParams = [...params, filter.limit, filter.offset]
    const r = await this.client.query(
      `SELECT ${RECALL_COLUMNS} FROM group_product_recall ${wh}
       ORDER BY created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      listParams,
    )
    return { total, items: r.rows as GroupProductRecallRecord[] }
  }

  async findById(id: string): Promise<GroupProductRecallRecord | null> {
    const r = await this.client.query(
      `SELECT ${RECALL_COLUMNS} FROM group_product_recall WHERE id = $1`,
      [id],
    )
    return (r.rows[0] as GroupProductRecallRecord | undefined) ?? null
  }

  async findByIdForUpdate(id: string): Promise<GroupProductRecallRecord | null> {
    const result = await this.client.query(`SELECT ${RECALL_COLUMNS} FROM group_product_recall WHERE id = $1 FOR UPDATE`, [id])
    return (result.rows[0] as GroupProductRecallRecord | undefined) ?? null
  }

  async updateState(id: string, status: string, payload: Record<string, unknown>, actor: string): Promise<GroupProductRecallRecord> {
    const result = await this.client.query(
      `UPDATE group_product_recall SET status = $2, payload = $3::jsonb, updated_by = $4, updated_at = now()
       WHERE id = $1 RETURNING ${RECALL_COLUMNS}`, [id, status, JSON.stringify(payload), actor],
    )
    return result.rows[0] as GroupProductRecallRecord
  }

  async insert(row: NewGroupProductRecall): Promise<GroupProductRecallRecord> {
    const r = await this.client.query(
      `INSERT INTO group_product_recall (
         id, recall_no, recall_scope, batch_no, material_code, title, reason, status, payload,
         enterprise_id, plant_id, command_receipt_id, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$13)
       RETURNING ${RECALL_COLUMNS}`,
      [
        row.id,
        row.recallNo,
        row.recallScope,
        row.batchNo ?? null,
        row.materialCode ?? null,
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
    return r.rows[0] as GroupProductRecallRecord
  }
}

export class PgGroupVendorRiskRepository implements GroupVendorRiskRepository {
  constructor(private readonly client: SqlClient) {}

  async listPaged(
    filter: GroupVendorRiskFilter,
  ): Promise<{ total: number; items: GroupVendorRiskRecord[] }> {
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
    if (filter.vendorCodeLike) {
      where.push(`vendor_code ILIKE $${i++}`)
      params.push(`%${filter.vendorCodeLike}%`)
    }
    if (filter.riskLevel) {
      where.push(`risk_level = $${i++}`)
      params.push(filter.riskLevel)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const countR = await this.client.query(
      `SELECT count(*)::text AS count FROM group_vendor_risk ${wh}`,
      params,
    )
    const total = Number((countR.rows[0] as { count?: string } | undefined)?.count ?? 0)
    const listParams = [...params, filter.limit, filter.offset]
    const r = await this.client.query(
      `SELECT ${VENDOR_COLUMNS} FROM group_vendor_risk ${wh}
       ORDER BY created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      listParams,
    )
    return { total, items: r.rows as GroupVendorRiskRecord[] }
  }

  async insert(row: NewGroupVendorRisk): Promise<GroupVendorRiskRecord> {
    const r = await this.client.query(
      `INSERT INTO group_vendor_risk (
         id, risk_no, vendor_code, vendor_name, risk_level, title, reason, status, payload,
         enterprise_id, plant_id, command_receipt_id, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$13)
       RETURNING ${VENDOR_COLUMNS}`,
      [
        row.id,
        row.riskNo,
        row.vendorCode,
        row.vendorName ?? null,
        row.riskLevel,
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
    return r.rows[0] as GroupVendorRiskRecord
  }
}


const REWORK_COLUMNS = `id, rework_no AS "reworkNo", title, reason,
  unit_no AS "unitNo", batch_no AS "batchNo", material_code AS "materialCode",
  status, payload, enterprise_id AS "enterpriseId", plant_id AS "plantId",
  created_at AS "createdAt", created_by AS "createdBy",
  updated_at AS "updatedAt", updated_by AS "updatedBy"`

const SCRAP_COLUMNS = `id, scrap_no AS "scrapNo", title, reason,
  unit_no AS "unitNo", batch_no AS "batchNo", material_code AS "materialCode",
  scrap_qty AS "scrapQty", status, payload,
  enterprise_id AS "enterpriseId", plant_id AS "plantId",
  created_at AS "createdAt", created_by AS "createdBy",
  updated_at AS "updatedAt", updated_by AS "updatedBy"`

export class PgGroupReworkWriteRepository implements GroupReworkWriteRepository {
  constructor(private readonly client: SqlClient) {}

  async listPaged(filter: GroupReworkWriteFilter): Promise<{ total: number; items: GroupReworkWriteRecord[] }> {
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
    if (filter.status) {
      where.push(`status = $${i++}`)
      params.push(filter.status)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const countR = await this.client.query(`SELECT count(*)::text AS count FROM group_rework_write ${wh}`, params)
    const total = Number((countR.rows[0] as { count?: string } | undefined)?.count ?? 0)
    const listParams = [...params, filter.limit, filter.offset]
    const r = await this.client.query(
      `SELECT ${REWORK_COLUMNS} FROM group_rework_write ${wh}
       ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`,
      listParams,
    )
    return { total, items: r.rows as GroupReworkWriteRecord[] }
  }

  async insert(row: NewGroupReworkWrite): Promise<GroupReworkWriteRecord> {
    const r = await this.client.query(
      `INSERT INTO group_rework_write (
         id, rework_no, title, reason, unit_no, batch_no, material_code, status, payload,
         enterprise_id, plant_id, command_receipt_id, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$13)
       RETURNING ${REWORK_COLUMNS}`,
      [
        row.id, row.reworkNo, row.title, row.reason,
        row.unitNo ?? null, row.batchNo ?? null, row.materialCode ?? null,
        row.status, JSON.stringify(row.payload ?? {}),
        row.enterpriseId, row.plantId, row.commandReceiptId ?? null, row.createdBy,
      ],
    )
    return r.rows[0] as GroupReworkWriteRecord
  }
}

export class PgGroupScrapWriteRepository implements GroupScrapWriteRepository {
  constructor(private readonly client: SqlClient) {}

  async listPaged(filter: GroupScrapWriteFilter): Promise<{ total: number; items: GroupScrapWriteRecord[] }> {
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
    if (filter.status) {
      where.push(`status = $${i++}`)
      params.push(filter.status)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const countR = await this.client.query(`SELECT count(*)::text AS count FROM group_scrap_write ${wh}`, params)
    const total = Number((countR.rows[0] as { count?: string } | undefined)?.count ?? 0)
    const listParams = [...params, filter.limit, filter.offset]
    const r = await this.client.query(
      `SELECT ${SCRAP_COLUMNS} FROM group_scrap_write ${wh}
       ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`,
      listParams,
    )
    return { total, items: r.rows as GroupScrapWriteRecord[] }
  }

  async insert(row: NewGroupScrapWrite): Promise<GroupScrapWriteRecord> {
    const r = await this.client.query(
      `INSERT INTO group_scrap_write (
         id, scrap_no, title, reason, unit_no, batch_no, material_code, scrap_qty, status, payload,
         enterprise_id, plant_id, command_receipt_id, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$14)
       RETURNING ${SCRAP_COLUMNS}`,
      [
        row.id, row.scrapNo, row.title, row.reason,
        row.unitNo ?? null, row.batchNo ?? null, row.materialCode ?? null, row.scrapQty ?? null,
        row.status, JSON.stringify(row.payload ?? {}),
        row.enterpriseId, row.plantId, row.commandReceiptId ?? null, row.createdBy,
      ],
    )
    return r.rows[0] as GroupScrapWriteRecord
  }
}

export function createPgGroupRepositories(client: SqlClient): {
  allocationRevisions: GroupAllocationRevisionRepository
  shortageKitting: GroupShortageKittingRepository
  productRecalls: GroupProductRecallRepository
  vendorRisks: GroupVendorRiskRepository
  reworkWrites: GroupReworkWriteRepository
  scrapWrites: GroupScrapWriteRepository
} {
  return {
    allocationRevisions: new PgGroupAllocationRevisionRepository(client),
    shortageKitting: new PgGroupShortageKittingRepository(client),
    productRecalls: new PgGroupProductRecallRepository(client),
    vendorRisks: new PgGroupVendorRiskRepository(client),
    reworkWrites: new PgGroupReworkWriteRepository(client),
    scrapWrites: new PgGroupScrapWriteRepository(client),
  }
}
