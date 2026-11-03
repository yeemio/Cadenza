import type {
  SapReconDerivationRepository, SapReconDeriveDocumentRow, SapReconDeriveMaterialRow,
  SapReconDeriveOutcomeRow, SapReconDeriveOutboxRow, SapReconDeriveStockRow,
  SapReconDeriveTransitRow, SapReconFactScope, SapReconObjectMeasurement, SapReconDeriveInput, VerifiedAuthContext,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

const DOC_COLUMNS = `doc_no AS "docNo", doc_type AS "docType",
 source_event_key AS "eventKey", business_key AS "businessKey",
 organization_code AS "organizationCode", plant_code AS "plantCode", status,
 material_id AS "materialId", qty, unit, receipt, payload, created_at AS "createdAt"`
const exactRef = (column: string, parameter: string) =>
  `jsonb_path_exists(${column}, '$.** ? (@ == $ref)', jsonb_build_object('ref', to_jsonb(${parameter}::text)))`
const n = (v: unknown): number => Number(v ?? 0)

/** All object queries share the actual MOM enterprise/plant and exact unit/lot selector.
 * Owner and measurement filtering stay on the balance/transaction that owns those facts. */
const OBJECT_UNITS = `SELECT iu.id FROM inventory_unit iu
 JOIN material_lot ml ON ml.id = iu.lot_id
 WHERE iu.material_id = $1 AND iu.enterprise_id = $2 AND iu.plant_id = $3
 AND (($4::text IS NOT NULL AND iu.unit_no = $4)
   OR ($4::text IS NULL AND $5::text IS NOT NULL AND ml.lot_no = $5)
   OR ($4::text IS NULL AND $5::text IS NULL AND (iu.unit_no = $6 OR ml.lot_no = $6)))`
const objectParams = (materialId: string, s: SapReconFactScope) =>
  [materialId, s.enterpriseId, s.plantId, s.momUnitNo, s.momLotNo, s.objectFullKey]

export class PgSapReconDerivationRepository implements SapReconDerivationRepository {
  constructor(private readonly client: SqlClient) {}

  async resolveScope(auth: VerifiedAuthContext, input: SapReconDeriveInput): Promise<SapReconFactScope | null> {
    const r = await this.client.query(`SELECT p.id AS "plantId", o.id AS "ownerId",
       coalesce(o.company_org_code, o.code) AS "organizationCode", p.plant_code AS "plantCode"
      FROM org_node p JOIN org_node o ON p.path LIKE o.path || '%'
      WHERE p.kind = 'plant' AND o.kind = 'legal_entity'
        AND p.status = 'active' AND o.status = 'active'
        AND p.enterprise_id = $1 AND o.enterprise_id = $1
        AND ($2::boolean OR p.id = ANY($3::uuid[]))
        AND ($4::text IS NULL OR p.id::text = $4)
        AND (p.code = $5 OR p.plant_code = $5)
        AND (o.code = $6 OR o.company_org_code = $6)`,
    [auth.user.enterpriseId, auth.dataScope.enterpriseWide, auth.dataScope.plantIds,
      input.plantId ?? null, input.plantCode, input.ownerEntityCode])
    if (r.rows.length !== 1) return null
    const row = r.rows[0] as { plantId: string; ownerId: string; organizationCode: string; plantCode: string }
    return { ...row, enterpriseId: auth.user.enterpriseId, objectFullKey: input.objectFullKey!,
      momUnitNo: input.momUnitNo?.trim() || null, momLotNo: input.momLotNo?.trim() || null,
      unit: input.unit!.trim(), basis: input.basis!.trim() }
  }

  async simObjectMeasurement(objectKey: string, s: SapReconFactScope): Promise<SapReconObjectMeasurement | null> {
    const r = await this.client.query(`WITH master AS (
      SELECT payload, source_event_key FROM sim_sap_document WHERE doc_type = 'MASTER_BUNDLE'
        AND status = 'COMMITTED' AND organization_code = $2 AND plant_code = $3
        AND payload ? 'reference_data' ORDER BY created_at DESC, doc_no DESC LIMIT 1)
      SELECT obj->>'id' AS "objectId", obj->>'material_id' AS "materialId", obj->>'unit' AS unit,
        obj->>'basis' AS basis, payload->'reference_data'->>'version' AS "referenceVersion",
        payload->>'reference_data_sha256' AS "referenceDataSha256", source_event_key AS "masterEventKey",
        payload->'reference_data'->'sources' AS sources
      FROM master CROSS JOIN LATERAL jsonb_array_elements(payload->'reference_data'->'tables'->'stock_objects') obj
      WHERE obj->>'id' = $1`, [objectKey, s.organizationCode, s.plantCode])
    if (r.rows.length !== 1) return null
    const row = r.rows[0] as SapReconObjectMeasurement
    if (!row.unit || !row.basis || !row.materialId || !row.referenceDataSha256 || !row.referenceVersion) return null
    return row
  }

  async simDocumentsByObjectRef(objectKey: string, s: SapReconFactScope): Promise<SapReconDeriveDocumentRow[]> {
    const r = await this.client.query(`SELECT ${DOC_COLUMNS} FROM sim_sap_document
      WHERE organization_code = $2 AND plant_code = $3 AND doc_type <> 'MASTER_BUNDLE'
      AND (${exactRef('payload', '$1')} OR business_key = $1)
      ORDER BY created_at, doc_no`, [objectKey, s.organizationCode, s.plantCode])
    return (r.rows as SapReconDeriveDocumentRow[]).map(row => ({ ...row, qty: row.qty === null ? null : n(row.qty) }))
  }

  async simStockByMaterial(materialKey: string, s: SapReconFactScope): Promise<SapReconDeriveStockRow[]> {
    const r = await this.client.query(`SELECT organization_code AS "organizationCode", plant_code AS "plantCode",
      material_id AS "materialId", unit, qty, updated_at AS "updatedAt" FROM sim_sap_stock
      WHERE material_id = $1 AND organization_code = $2 AND plant_code = $3 AND lower(unit) = lower($4)`,
    [materialKey, s.organizationCode, s.plantCode, s.unit])
    return (r.rows as SapReconDeriveStockRow[]).map(row => ({ ...row, qty: n(row.qty) }))
  }

  async simInTransitByMaterial(materialKey: string, s: SapReconFactScope): Promise<SapReconDeriveTransitRow[]> {
    const r = await this.client.query(`SELECT transfer_key AS "transferKey", organization_code AS "organizationCode",
      from_plant AS "fromPlant", to_plant AS "toPlant", material_id AS "materialId", unit, qty, status,
      updated_at AS "updatedAt" FROM sim_sap_in_transit WHERE material_id = $1 AND organization_code = $2
      AND from_plant = $3 AND lower(unit) = lower($4)`,
    [materialKey, s.organizationCode, s.plantCode, s.unit])
    return (r.rows as SapReconDeriveTransitRow[]).map(row => ({ ...row, qty: n(row.qty) }))
  }

  async simOutcomesByEventKeys(keys: string[], s: SapReconFactScope): Promise<SapReconDeriveOutcomeRow[]> {
    const r = await this.client.query(`SELECT source_event_key AS "eventKey", outcome,
      message_state AS "messageState", doc_no AS "docNo", applied, created_at AS "createdAt"
      FROM sim_sap_event_outcome e WHERE source_event_key = ANY($1::text[])
      AND EXISTS (SELECT 1 FROM sim_sap_document d WHERE d.source_event_key = e.source_event_key AND d.doc_no = e.doc_no
        AND d.organization_code = $2 AND d.plant_code = $3) ORDER BY arrival_seq`,
    [keys, s.organizationCode, s.plantCode])
    return r.rows as SapReconDeriveOutcomeRow[]
  }

  async momObjectUnits(materialId: string, s: SapReconFactScope) {
    const r = await this.client.query(`SELECT iu.id, iu.unit_no AS "unitNo", ml.lot_no AS "lotNo",
      iu.material_code AS "materialCode", sb.owner_id AS "ownerId", sb.uom_code AS unit, sb.measurement_basis AS basis
      FROM inventory_unit iu JOIN material_lot ml ON ml.id = iu.lot_id JOIN stock_balance sb ON sb.unit_id = iu.id
      WHERE iu.id IN (${OBJECT_UNITS}) AND sb.owner_id = $7 AND sb.plant_id = $3 AND sb.enterprise_id = $2
      ORDER BY iu.unit_no, sb.uom_code, sb.measurement_basis`, [...objectParams(materialId, s), s.ownerId])
    return r.rows as Array<{ id: string; unitNo: string; lotNo: string; materialCode: string; ownerId: string; unit: string; basis: string }>
  }

  async momMaterialByCode(code: string, s: SapReconFactScope): Promise<SapReconDeriveMaterialRow | null> {
    const r = await this.client.query(`SELECT id, code, name, material_type AS "materialType", base_uom AS "baseUom",
      external_revision AS "externalRevision", status FROM material WHERE code = $1 AND org_scope_id = $2 AND deleted_at IS NULL`, [code, s.enterpriseId])
    const row = r.rows[0] as SapReconDeriveMaterialRow | undefined
    return row ? { ...row, materialType: row.materialType === null ? null : n(row.materialType),
      externalRevision: row.externalRevision === null ? null : n(row.externalRevision) } : null
  }

  async momStockSummary(materialId: string, s: SapReconFactScope) {
    const r = await this.client.query(`SELECT sb.quality_status AS qs, sb.uom_code AS unit,
      sb.measurement_basis AS basis, sum(sb.quantity)::text AS q, count(*)::text AS c
      FROM stock_balance sb WHERE sb.unit_id IN (${OBJECT_UNITS})
      AND sb.enterprise_id = $2 AND sb.plant_id = $3 AND sb.owner_id = $7
      GROUP BY sb.quality_status, sb.uom_code, sb.measurement_basis ORDER BY 1,2,3`,
    [...objectParams(materialId, s), s.ownerId])
    const rows = r.rows as Array<{ qs: string; unit: string; basis: string; q: string; c: string }>
    const matching = rows.filter(x => x.unit.toLowerCase() === s.unit.toLowerCase() && x.basis === s.basis)
    return { rowCount: matching.reduce((sum, x) => sum + n(x.c), 0),
      totalQty: matching.reduce((sum, x) => sum + n(x.q), 0),
      measures: rows.map(x => ({ unit: x.unit, basis: x.basis, qty: n(x.q), rowCount: n(x.c) })),
      byQuality: matching.map(x => ({ qualityStatus: x.qs, qty: n(x.q), rowCount: n(x.c) })) }
  }

  async momStockTxnSummary(materialId: string, s: SapReconFactScope) {
    const r = await this.client.query(`SELECT movement_kind AS k, sum(quantity)::text AS q, count(*)::text AS c
      FROM stock_transaction WHERE unit_id IN (${OBJECT_UNITS}) AND enterprise_id = $2 AND plant_id = $3
      AND (from_owner_id = $7 OR to_owner_id = $7 OR EXISTS (SELECT 1 FROM stock_balance b WHERE b.id = stock_transaction.balance_id AND b.owner_id = $7)) AND lower(uom_code) = lower($8) AND measurement_basis = $9
      GROUP BY movement_kind ORDER BY movement_kind`, [...objectParams(materialId, s), s.ownerId, s.unit, s.basis])
    const byKind = (r.rows as Array<{ k: string; q: string; c: string }>).map(x => ({ movementKind: x.k, qty: n(x.q), rowCount: n(x.c) }))
    return { rowCount: byKind.reduce((sum, x) => sum + x.rowCount, 0),
      inQty: byKind.filter(x => x.qty > 0).reduce((sum, x) => sum + x.qty, 0),
      outQty: byKind.filter(x => x.qty < 0).reduce((sum, x) => sum - x.qty, 0), byKind }
  }

  async momInventoryUnitSummary(materialId: string, s: SapReconFactScope) {
    const r = await this.client.query(`SELECT count(*)::text AS c, count(*) FILTER (WHERE iu.balance_open)::text AS o
      FROM inventory_unit iu WHERE iu.id IN (${OBJECT_UNITS}) AND EXISTS (SELECT 1 FROM stock_balance sb
        WHERE sb.unit_id = iu.id AND sb.owner_id = $7 AND sb.plant_id = $3 AND sb.enterprise_id = $2
        AND lower(sb.uom_code) = lower($8) AND sb.measurement_basis = $9)`,
    [...objectParams(materialId, s), s.ownerId, s.unit, s.basis])
    return { rowCount: n(r.rows[0]?.c), openCount: n(r.rows[0]?.o) }
  }

  async momConsumptionSummary(materialId: string, s: SapReconFactScope) {
    const r = await this.client.query(`SELECT count(*)::text AS c, coalesce(sum(quantity),0)::text AS q
      FROM material_consumption mc WHERE inventory_unit_id IN (${OBJECT_UNITS}) AND enterprise_id = $2 AND plant_id = $3
      AND lower(uom_code) = lower($8) AND EXISTS (SELECT 1 FROM stock_transaction st
        WHERE st.unit_id = mc.inventory_unit_id AND (st.from_owner_id = $7 OR EXISTS (SELECT 1 FROM stock_balance b WHERE b.id = st.balance_id AND b.owner_id = $7)) AND st.plant_id = $3
        AND st.enterprise_id = $2 AND st.measurement_basis = $9)`,
    [...objectParams(materialId, s), s.ownerId, s.unit, s.basis])
    return { rowCount: n(r.rows[0]?.c), qty: n(r.rows[0]?.q) }
  }

  async momPurchaseReceipts(materialCode: string, s: SapReconFactScope) {
    const r = await this.client.query(`SELECT pr.order_no AS "orderNo", pr.line_no AS "lineNo", pr.received_qty AS "receivedQty",
      pr.uom_code AS uom, pr.inspection_status AS "inspectionStatus", pr.storage_status AS "storageStatus", pr.returned_at AS "returnedAt"
      FROM purchase_receipt_batch pr WHERE pr.material_code = $1 AND pr.enterprise_id = $2 AND pr.plant_id = $3
      AND lower(pr.uom_code) = lower($8) AND pr.measurement_basis = $9
      AND EXISTS (SELECT 1 FROM material_lot ml JOIN inventory_unit iu ON iu.lot_id = ml.id
        JOIN stock_balance sb ON sb.unit_id = iu.id WHERE ml.lot_no = pr.batch_no
        AND iu.enterprise_id = $2 AND iu.plant_id = $3 AND sb.owner_id = $7
        AND (($4::text IS NOT NULL AND iu.unit_no = $4) OR ($4::text IS NULL AND ml.lot_no = coalesce($5,$6))))
      ORDER BY order_no, line_no`,
    [materialCode, s.enterpriseId, s.plantId, s.momUnitNo, s.momLotNo, s.objectFullKey, s.ownerId, s.unit, s.basis])
    return r.rows.map(row => ({ orderNo: String(row.orderNo), lineNo: n(row.lineNo), receivedQty: n(row.receivedQty),
      uom: row.uom as string | null, inspectionStatus: row.inspectionStatus as string | null,
      storageStatus: row.storageStatus as string | null, returnedAt: row.returnedAt as string | null }))
  }

  async momProductionOrders(materialId: string, s: SapReconFactScope) {
    // Order-wide totals cannot be attributed to one object/axis. Only orders linked by its actual stock transaction are evidence.
    const r = await this.client.query(`SELECT po.order_no AS "orderNo", po.production_qty AS "productionQty",
      po.completed_qty AS "completedQty", po.order_status AS "orderStatus", po.current_settings_version AS "settingsVersion"
      FROM production_order po WHERE po.material_id = $1 AND po.enterprise_id = $2 AND po.plant_id = $3
      AND EXISTS (SELECT 1 FROM report_output ro JOIN production_report pr ON pr.id = ro.report_id
        JOIN stock_balance sb ON sb.unit_id = ro.stock_unit_id
        WHERE ro.stock_unit_id IN (${OBJECT_UNITS}) AND pr.order_id = po.id
        AND sb.owner_id = $7 AND lower(sb.uom_code) = lower($8) AND sb.measurement_basis = $9)
      ORDER BY po.order_no`, [...objectParams(materialId, s), s.ownerId, s.unit, s.basis])
    return r.rows.map(row => ({ orderNo: String(row.orderNo), productionQty: n(row.productionQty), completedQty: n(row.completedQty),
      orderStatus: String(row.orderStatus), settingsVersion: n(row.settingsVersion) }))
  }

  async momOutboxByObjectRef(objectKey: string, s: SapReconFactScope): Promise<SapReconDeriveOutboxRow[]> {
    const r = await this.client.query(`SELECT event_id AS "eventId", external_ref AS "externalRef", task_kind AS "taskKind",
      status, attempt_count AS "attemptCount", payload->'envelope'->>'business_key' AS "envelopeBusinessKey", updated_at AS "updatedAt"
      FROM outbox WHERE payload->>'organization_code' = $2 AND payload->>'plant_code' = $3
      AND ${exactRef('payload', '$1')} ORDER BY updated_at, event_id`, [objectKey, s.organizationCode, s.plantCode])
    return (r.rows as SapReconDeriveOutboxRow[]).map(row => ({ ...row, attemptCount: n(row.attemptCount) }))
  }

  async momAuditSummary(_objectKey: string, s: SapReconFactScope) {
    // Audit has no scope columns. Resolve the subject to an actual unit in the permitted plant rather than scanning arbitrary JSON.
    const r = await this.client.query(`SELECT a.subject_type AS st, a.action, count(*)::text AS c
      FROM audit_entry a JOIN inventory_unit iu ON a.subject_id = iu.id::text
      JOIN material_lot ml ON ml.id = iu.lot_id WHERE iu.enterprise_id = $1 AND iu.plant_id = $2
      AND (($3::text IS NOT NULL AND iu.unit_no = $3) OR ($3::text IS NULL AND ml.lot_no = coalesce($4,$5))
        OR ($3::text IS NULL AND $4::text IS NULL AND iu.unit_no = $5))
      AND EXISTS (SELECT 1 FROM stock_balance sb WHERE sb.unit_id = iu.id AND sb.owner_id = $6)
      GROUP BY a.subject_type,a.action ORDER BY 1,2`,
    [s.enterpriseId, s.plantId, s.momUnitNo, s.momLotNo, s.objectFullKey, s.ownerId])
    return r.rows.map(row => ({ subjectType: String(row.st), action: String(row.action), count: n(row.c) }))
  }
}
