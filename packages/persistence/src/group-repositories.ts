import type {
  GroupAllocationRevisionFilter,
  GroupAllocationRevisionRecord,
  GroupAllocationRevisionRepository,
  GroupShortageKittingFilter,
  GroupKittingFacts,
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

  async readFacts(enterpriseId: string, plantId: string, orderNo: string): Promise<GroupKittingFacts> {
    // All JSON subqueries share a PostgreSQL statement snapshot; this is a check,
    // not a reservation or a promise that stock remains available afterwards.
    const result = await this.client.query(`WITH selected_order AS (
      SELECT o.*, (SELECT count(*)::int FROM order_operation op WHERE op.order_id=o.id AND op.settings_version=o.current_settings_version
        AND op.enterprise_id=o.enterprise_id AND op.plant_id=o.plant_id) AS operation_count,
        (SELECT coalesce(jsonb_agg(DISTINCT op.bom_revision_id) FILTER (WHERE op.bom_revision_id IS NOT NULL),'[]'::jsonb)
         FROM order_operation op WHERE op.order_id=o.id AND op.settings_version=o.current_settings_version
           AND op.enterprise_id=o.enterprise_id AND op.plant_id=o.plant_id) AS operation_bom_ids
      FROM production_order o WHERE o.enterprise_id=$1 AND o.plant_id=$2 AND o.order_no=$3
    ), selected_bom AS (
      SELECT b.* FROM manufacturing_bom_revision b JOIN selected_order o ON b.id=o.bom_revision_id
      WHERE b.enterprise_id=o.enterprise_id AND b.plant_id=o.plant_id
    ), needed_material AS (
      SELECT material_id::text AS id FROM selected_order
      UNION SELECT line->>'materialId' FROM selected_bom b CROSS JOIN LATERAL jsonb_array_elements(b.lines) line
    ), material_facts AS (
      SELECT m.* FROM material m WHERE m.org_scope_id=$1 AND m.id::text IN (SELECT id FROM needed_material)
    )
    SELECT
      (SELECT jsonb_build_object('id',o.id,'enterpriseId',o.enterprise_id,'plantId',o.plant_id,'orderNo',o.order_no,'materialId',o.material_id,
        'quantity',o.production_qty::text,'uom',o.uom,'settingsVersion',o.current_settings_version,'bomRevisionId',o.bom_revision_id,'status',o.order_status,
        'operationCount',o.operation_count,'operationBomIds',o.operation_bom_ids) FROM selected_order o) AS "order",
      (SELECT jsonb_build_object('id',b.id,'enterpriseId',b.enterprise_id,'plantId',b.plant_id,'materialId',b.material_id,'version',b.version,'status',b.status,
        'publishedAt',b.published_at,'lines',b.lines) FROM selected_bom b) AS bom,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'code',m.code,'baseUom',m.base_uom,'status',m.status,
        'conversions',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'version',c.version,'unitName',c.unit_name,'factor',c.factor::text)),'[]'::jsonb)
          FROM conversion_revision c WHERE c.material_id=m.id AND c.status='active'))),'[]'::jsonb) FROM material_facts m) AS materials,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('unitId',u.id,'materialId',u.material_id,'uom',u.uom_code,'quantity',coalesce(b.quantity,0)::text,
        'qualityStatus',coalesce(b.quality_status,'pending_inspection'),'unitStatus',u.status,
        'measurementKnown',coalesce(b.measurement_known,false),
        'conversionRevisionId',b.conversion_revision_id,
        'conversionFactor',(SELECT c.factor::text FROM conversion_revision c WHERE c.id::text=b.conversion_revision_id AND c.material_id=u.material_id AND c.unit_name=u.uom_code AND c.referenced),
        'qualityHeld',EXISTS(SELECT 1 FROM quality_hold h WHERE h.inventory_unit_id=u.id AND h.status='active'),
        'businessHeld',EXISTS(SELECT 1 FROM inventory_business_hold h WHERE h.unit_id=u.id),
        'reservations',(SELECT coalesce(jsonb_agg(jsonb_build_object('status',r.status,'quantity',r.quantity::text,'validUntil',r.valid_until)),'[]'::jsonb)
          FROM reservation r WHERE r.unit_id=u.id AND r.status='active'))),'[]'::jsonb)
       FROM inventory_unit u
       JOIN LATERAL (SELECT sum(sb.quantity) AS quantity,
          CASE WHEN bool_and(sb.quality_status='qualified') THEN 'qualified' ELSE 'pending_inspection' END AS quality_status,
          min(sb.conversion_revision_id::text) AS conversion_revision_id,
          bool_and(sb.uom_id=u.uom_id AND sb.uom_code=u.uom_code AND sb.enterprise_id=u.enterprise_id AND sb.plant_id=u.plant_id)
            AND count(DISTINCT coalesce(sb.conversion_revision_id::text,'NONE'))=1 AND count(DISTINCT sb.measurement_basis)=1 AS measurement_known
          FROM stock_balance sb WHERE sb.unit_id=u.id AND sb.status='active') b ON true
       WHERE u.enterprise_id=$1 AND u.plant_id=$2 AND u.material_id IN (SELECT id FROM material_facts)) AS stocks`, [enterpriseId, plantId, orderNo])
    return result.rows[0] as unknown as GroupKittingFacts
  }

  async listPaged(
    filter: GroupShortageKittingFilter,
  ): Promise<{ total: number; items: GroupShortageKittingRecord[] }> {
    const where: string[] = ['enterprise_id = $1::uuid']
    const params: unknown[] = [filter.enterpriseId]
    let i = 2
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
