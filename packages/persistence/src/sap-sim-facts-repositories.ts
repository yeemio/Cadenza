import { formatSimSapDocumentNo } from '@cadenza/domain'
import type {
  NewSapSimDocumentFact,
  NewSapSimEventOutcome,
  NewSapSimFaultScenario,
  NewSapSimOrderFact,
  SapSimDocumentFactRecord,
  SapSimEventOutcomeRecord,
  SapSimFactsRepositories,
  SapSimFaultScenarioRecord,
  SapSimInTransitFactRecord,
  SapSimOrderFactRecord,
  SapSimOutboxReceiptPort,
  SapSimOutboxRepository,
  SapSimStockFactRecord,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'
import type { PoolClient } from 'pg'

/**
 * sim_sap_* 事实仓储（R1 模拟 SAP 侧独立事实源）。
 * 与 MOM 业务表物理分离；仅模拟器经引擎写入；MOM 侧不直读。
 */

const ORDER_COLUMNS = `id, organization_code AS "organizationCode", plant_code AS "plantCode",
  order_no AS "orderNo", order_kind AS "orderKind", source_event_key AS "sourceEventKey",
  order_version AS "orderVersion", parent_version AS "parentVersion", qty, unit,
  material_id AS "materialId", produced_qty AS "producedQty", status, payload,
  created_at AS "createdAt", updated_at AS "updatedAt"`

const DOC_COLUMNS = `id, doc_type AS "docType", doc_no AS "docNo",
  organization_code AS "organizationCode", plant_code AS "plantCode",
  source_event_key AS "sourceEventKey", business_key AS "businessKey", line_no AS "lineNo",
  status, reversal_of AS "reversalOf", material_id AS "materialId", qty, unit,
  payload, receipt, created_at AS "createdAt", updated_at AS "updatedAt"`

const STOCK_COLUMNS = `id, organization_code AS "organizationCode", plant_code AS "plantCode",
  material_id AS "materialId", unit, qty, updated_at AS "updatedAt"`

const TRANSIT_COLUMNS = `id, transfer_key AS "transferKey", organization_code AS "organizationCode",
  from_plant AS "fromPlant", to_plant AS "toPlant", material_id AS "materialId", unit, qty, status,
  issue_doc_id AS "issueDocId", receipt_doc_id AS "receiptDocId",
  created_at AS "createdAt", updated_at AS "updatedAt"`

const OUTCOME_COLUMNS = `id, source_event_key AS "sourceEventKey", arrival_seq AS "arrivalSeq",
  topic, payload_sha256 AS "payloadSha256", outcome, message_state AS "messageState",
  doc_no AS "docNo", applied, detail, created_at AS "createdAt"`

const FAULT_COLUMNS = `id, scenario_no AS "scenarioNo", fault_type AS "faultType",
  match_event_key AS "matchEventKey", match_topic AS "matchTopic",
  remaining_count AS "remainingCount", total_count AS "totalCount", delay_ms AS "delayMs",
  reorder_keys AS "reorderKeys", pending, active, payload,
  created_at AS "createdAt", updated_at AS "updatedAt"`

/** 非终局结局：故障观察 + 等父版本门控（同键可重驱动再评估；其余为终局，同键回原结果）。 */
const NON_TERMINAL_OUTCOMES = `('MESSAGE_LOST','NETWORK_DOWN','HELD_FOR_REORDER','WAIT_PARENT_VERSION')`

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** pg numeric 列以字符串返回；统一映射为 number。 */
function mapOrderRow(row: Record<string, unknown>): SapSimOrderFactRecord {
  return {
    ...(row as unknown as SapSimOrderFactRecord),
    qty: num(row['qty']),
    producedQty: num(row['producedQty']) ?? 0,
    parentVersion: num(row['parentVersion']),
    orderVersion: num(row['orderVersion']) ?? 0,
  }
}

function mapDocRow(row: Record<string, unknown>): SapSimDocumentFactRecord {
  return {
    ...(row as unknown as SapSimDocumentFactRecord),
    qty: num(row['qty']),
    lineNo: num(row['lineNo']) ?? 0,
  }
}

function mapStockRow(row: Record<string, unknown>): SapSimStockFactRecord {
  return { ...(row as unknown as SapSimStockFactRecord), qty: num(row['qty']) ?? 0 }
}

function mapTransitRow(row: Record<string, unknown>): SapSimInTransitFactRecord {
  return { ...(row as unknown as SapSimInTransitFactRecord), qty: num(row['qty']) ?? 0 }
}

function mapRows<T>(rows: Record<string, unknown>[], map: (r: Record<string, unknown>) => T): T[] {
  return rows.map(map)
}

export class PgSapSimOrderFactRepository {
  constructor(private readonly client: SqlClient) {}

  async findByIdentity(
    organizationCode: string,
    plantCode: string,
    orderNo: string,
  ): Promise<SapSimOrderFactRecord | null> {
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM sim_sap_order
       WHERE organization_code = $1 AND plant_code = $2 AND order_no = $3
       ORDER BY order_version DESC LIMIT 1`,
      [organizationCode, plantCode, orderNo],
    )
    return (r.rows[0] ? mapOrderRow(r.rows[0]) : null)
  }

  async findVersion(
    organizationCode: string,
    plantCode: string,
    orderNo: string,
    orderVersion: number,
  ): Promise<SapSimOrderFactRecord | null> {
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM sim_sap_order
       WHERE organization_code = $1 AND plant_code = $2 AND order_no = $3 AND order_version = $4`,
      [organizationCode, plantCode, orderNo, orderVersion],
    )
    return (r.rows[0] ? mapOrderRow(r.rows[0]) : null)
  }

  async findBySameOrderNoDifferentOrg(
    plantCode: string,
    orderNo: string,
  ): Promise<SapSimOrderFactRecord | null> {
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM sim_sap_order
       WHERE plant_code = $1 AND order_no = $2
       ORDER BY created_at ASC LIMIT 1`,
      [plantCode, orderNo],
    )
    return (r.rows[0] ? mapOrderRow(r.rows[0]) : null)
  }

  async findByEventKey(eventKey: string): Promise<SapSimOrderFactRecord | null> {
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM sim_sap_order WHERE source_event_key = $1`,
      [eventKey],
    )
    return (r.rows[0] ? mapOrderRow(r.rows[0]) : null)
  }

  async findReworkOrder(
    organizationCode: string,
    plantCode: string,
    refId: string,
  ): Promise<SapSimOrderFactRecord | null> {
    if (refId !== '') {
      const r = await this.client.query(
        `SELECT ${ORDER_COLUMNS} FROM sim_sap_order
         WHERE organization_code = $1 AND plant_code = $2 AND order_no = $3 AND order_kind = 'REWORK'`,
        [organizationCode, plantCode, refId],
      )
      return (r.rows[0] ? mapOrderRow(r.rows[0]) : null)
    }
    const r = await this.client.query(
      `SELECT ${ORDER_COLUMNS} FROM sim_sap_order
       WHERE organization_code = $1 AND plant_code = $2 AND order_kind = 'REWORK'
       ORDER BY created_at DESC LIMIT 1`,
      [organizationCode, plantCode],
    )
    return (r.rows[0] ? mapOrderRow(r.rows[0]) : null)
  }

  async insert(row: NewSapSimOrderFact): Promise<SapSimOrderFactRecord> {
    const r = await this.client.query(
      `INSERT INTO sim_sap_order (
         organization_code, plant_code, order_no, order_kind, source_event_key,
         order_version, parent_version, qty, unit, material_id, payload, status, produced_qty
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
       RETURNING ${ORDER_COLUMNS}`,
      [
        row.organizationCode,
        row.plantCode,
        row.orderNo,
        row.orderKind,
        row.sourceEventKey,
        row.orderVersion,
        row.parentVersion ?? null,
        row.qty ?? null,
        row.unit ?? null,
        row.materialId ?? null,
        JSON.stringify(row.payload ?? {}),
        row.status ?? 'RELEASED',
        row.producedQty ?? 0,
      ],
    )
    return mapOrderRow(r.rows[0])
  }

  async addProduced(id: string, qty: number): Promise<SapSimOrderFactRecord | null> {
    const r = await this.client.query(
      `UPDATE sim_sap_order SET produced_qty = produced_qty + $2, updated_at = now()
       WHERE id = $1 AND $2 > 0 AND status <> 'CANCELLED'
         AND (qty IS NULL OR produced_qty + $2 <= qty) RETURNING ${ORDER_COLUMNS}`,
      [id, qty],
    )
    return (r.rows[0] ? mapOrderRow(r.rows[0]) : null)
  }

  async markStatus(id: string, status: SapSimOrderFactRecord['status']): Promise<SapSimOrderFactRecord | null> {
    const r = await this.client.query(
      `UPDATE sim_sap_order SET status = $2, updated_at = now()
       WHERE id = $1 RETURNING ${ORDER_COLUMNS}`,
      [id, status],
    )
    return (r.rows[0] ? mapOrderRow(r.rows[0]) : null)
  }

  async list(organizationCode?: string): Promise<SapSimOrderFactRecord[]> {
    const r = organizationCode
      ? await this.client.query(`SELECT ${ORDER_COLUMNS} FROM sim_sap_order WHERE organization_code = $1 ORDER BY created_at DESC LIMIT 200`, [organizationCode])
      : await this.client.query(`SELECT ${ORDER_COLUMNS} FROM sim_sap_order ORDER BY created_at DESC LIMIT 200`)
    return mapRows(r.rows, mapOrderRow)
  }
}

export class PgSapSimDocumentFactRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<SapSimDocumentFactRecord | null> {
    const r = await this.client.query(`SELECT ${DOC_COLUMNS} FROM sim_sap_document WHERE id = $1`, [id])
    return r.rows[0] ? mapDocRow(r.rows[0]) : null
  }

  async findByEventKey(eventKey: string): Promise<SapSimDocumentFactRecord[]> {
    const r = await this.client.query(
      `SELECT ${DOC_COLUMNS} FROM sim_sap_document WHERE source_event_key = $1 ORDER BY line_no ASC`,
      [eventKey],
    )
    return mapRows(r.rows, mapDocRow)
  }

  async findByDocNo(docNo: string): Promise<SapSimDocumentFactRecord | null> {
    const r = await this.client.query(
      `SELECT ${DOC_COLUMNS} FROM sim_sap_document WHERE doc_no = $1`,
      [docNo],
    )
    return (r.rows[0] ? mapDocRow(r.rows[0]) : null)
  }

  async listByBusinessKey(businessKey: string): Promise<SapSimDocumentFactRecord[]> {
    if (businessKey === '') return []
    const r = await this.client.query(
      `SELECT ${DOC_COLUMNS} FROM sim_sap_document WHERE business_key = $1 ORDER BY created_at ASC`,
      [businessKey],
    )
    return mapRows(r.rows, mapDocRow)
  }

  async listForOrder(organizationCode: string, plantCode: string, orderNo: string): Promise<SapSimDocumentFactRecord[]> {
    const r = await this.client.query(
      `SELECT ${DOC_COLUMNS} FROM sim_sap_document
       WHERE organization_code = $1 AND plant_code = $2
         AND (payload->>'manufacturing_order' = $3 OR payload->>'order_no' = $3
           OR split_part(coalesce(payload->>'order_business_key', business_key), '|', 5) = $3)
       ORDER BY created_at ASC`,
      [organizationCode, plantCode, orderNo],
    )
    return mapRows(r.rows, mapDocRow)
  }

  async listMasterBundles(organizationCode: string, plantCode: string): Promise<SapSimDocumentFactRecord[]> {
    const r = await this.client.query(
      `SELECT ${DOC_COLUMNS} FROM sim_sap_document
       WHERE doc_type = 'MASTER_BUNDLE' AND organization_code = $1 AND plant_code = $2
       ORDER BY created_at DESC`,
      [organizationCode, plantCode],
    )
    return mapRows(r.rows, mapDocRow)
  }

  async list(filter: { plantCode?: string; docType?: string; limit?: number } = {}): Promise<SapSimDocumentFactRecord[]> {
    const where: string[] = []
    const params: unknown[] = []
    let i = 1
    if (filter.plantCode) {
      where.push(`plant_code = $${i++}`)
      params.push(filter.plantCode)
    }
    if (filter.docType) {
      where.push(`doc_type = $${i++}`)
      params.push(filter.docType)
    }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : ''
    params.push(filter.limit ?? 100)
    const r = await this.client.query(
      `SELECT ${DOC_COLUMNS} FROM sim_sap_document ${wh} ORDER BY created_at DESC LIMIT $${i}`,
      params,
    )
    return mapRows(r.rows, mapDocRow)
  }

  /** 号码段：同类型前缀取最大序号+1（模拟器生成，非调用方申报）。 */
  async nextDocNo(docType: string): Promise<string> {
    const sample = formatSimSapDocumentNo(docType, 1)
    const prefix = sample.slice(0, 5)
    const r = await this.client.query(
      `SELECT doc_no FROM sim_sap_document
       WHERE doc_no LIKE $1 ORDER BY doc_no DESC LIMIT 1`,
      [`${prefix}%`],
    )
    const last = (r.rows[0] as { doc_no?: string } | undefined)?.doc_no
    const lastSeq = last ? Number(last.slice(5)) : 0
    return formatSimSapDocumentNo(docType, lastSeq + 1)
  }

  async insert(row: NewSapSimDocumentFact): Promise<SapSimDocumentFactRecord> {
    const r = await this.client.query(
      `INSERT INTO sim_sap_document (
         doc_type, doc_no, organization_code, plant_code, source_event_key, business_key,
         line_no, material_id, qty, unit, payload, receipt
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)
       RETURNING ${DOC_COLUMNS}`,
      [
        row.docType,
        row.docNo,
        row.organizationCode,
        row.plantCode,
        row.sourceEventKey,
        row.businessKey ?? null,
        row.lineNo ?? 0,
        row.materialId ?? null,
        row.qty ?? null,
        row.unit ?? null,
        JSON.stringify(row.payload ?? {}),
        JSON.stringify(row.receipt ?? {}),
      ],
    )
    return mapDocRow(r.rows[0])
  }
}

export class PgSapSimStockFactRepository {
  constructor(private readonly client: SqlClient) {}

  async find(
    organizationCode: string,
    plantCode: string,
    materialId: string,
    unit: string,
  ): Promise<SapSimStockFactRecord | null> {
    const r = await this.client.query(
      `SELECT ${STOCK_COLUMNS} FROM sim_sap_stock
       WHERE organization_code = $1 AND plant_code = $2 AND material_id = $3 AND unit = $4`,
      [organizationCode, plantCode, materialId, unit],
    )
    return (r.rows[0] ? mapStockRow(r.rows[0]) : null)
  }

  async findForUpdate(organizationCode: string, plantCode: string, materialId: string, unit: string): Promise<SapSimStockFactRecord | null> {
    const r = await this.client.query(
      `SELECT ${STOCK_COLUMNS} FROM sim_sap_stock
       WHERE organization_code = $1 AND plant_code = $2 AND material_id = $3 AND unit = $4 FOR UPDATE`,
      [organizationCode, plantCode, materialId, unit],
    )
    return r.rows[0] ? mapStockRow(r.rows[0]) : null
  }

  async adjust(
    organizationCode: string,
    plantCode: string,
    materialId: string,
    unit: string,
    delta: number,
  ): Promise<SapSimStockFactRecord> {
    const r = await this.client.query(
      `INSERT INTO sim_sap_stock (organization_code, plant_code, material_id, unit, qty)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organization_code, plant_code, material_id, unit)
       DO UPDATE SET qty = sim_sap_stock.qty + $5, updated_at = now()
       RETURNING ${STOCK_COLUMNS}`,
      [organizationCode, plantCode, materialId, unit, delta],
    )
    return mapStockRow(r.rows[0])
  }

  async list(organizationCode?: string): Promise<SapSimStockFactRecord[]> {
    const r = organizationCode
      ? await this.client.query(`SELECT ${STOCK_COLUMNS} FROM sim_sap_stock WHERE organization_code = $1 ORDER BY updated_at DESC LIMIT 200`, [organizationCode])
      : await this.client.query(`SELECT ${STOCK_COLUMNS} FROM sim_sap_stock ORDER BY updated_at DESC LIMIT 200`)
    return mapRows(r.rows, mapStockRow)
  }
}

export class PgSapSimInTransitFactRepository {
  constructor(private readonly client: SqlClient) {}

  async find(transferKey: string, materialId: string, unit: string): Promise<SapSimInTransitFactRecord | null> {
    const r = await this.client.query(
      `SELECT ${TRANSIT_COLUMNS} FROM sim_sap_in_transit
       WHERE transfer_key = $1 AND material_id = $2 AND unit = $3`,
      [transferKey, materialId, unit],
    )
    return (r.rows[0] ? mapTransitRow(r.rows[0]) : null)
  }

  async insert(row: {
    transferKey: string
    organizationCode: string
    fromPlant: string
    toPlant: string
    materialId: string
    unit: string
    qty: number
    issueDocId?: string | null
  }): Promise<SapSimInTransitFactRecord> {
    const r = await this.client.query(
      `INSERT INTO sim_sap_in_transit (
         transfer_key, organization_code, from_plant, to_plant, material_id, unit, qty, issue_doc_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${TRANSIT_COLUMNS}`,
      [
        row.transferKey,
        row.organizationCode,
        row.fromPlant,
        row.toPlant,
        row.materialId,
        row.unit,
        row.qty,
        row.issueDocId ?? null,
      ],
    )
    return mapTransitRow(r.rows[0])
  }

  async adjustQty(id: string, delta: number): Promise<SapSimInTransitFactRecord | null> {
    const r = await this.client.query(
      `UPDATE sim_sap_in_transit SET qty = qty + $2, updated_at = now()
       WHERE id = $1 RETURNING ${TRANSIT_COLUMNS}`,
      [id, delta],
    )
    return (r.rows[0] ? mapTransitRow(r.rows[0]) : null)
  }

  async markReceived(id: string, receiptDocId: string): Promise<SapSimInTransitFactRecord | null> {
    const r = await this.client.query(
      `UPDATE sim_sap_in_transit SET status = 'RECEIVED', receipt_doc_id = $2, updated_at = now()
       WHERE id = $1 RETURNING ${TRANSIT_COLUMNS}`,
      [id, receiptDocId],
    )
    return (r.rows[0] ? mapTransitRow(r.rows[0]) : null)
  }
}

export class PgSapSimEventOutcomeRepository {
  constructor(private readonly client: SqlClient) {}

  async nextArrivalSeq(eventKey: string): Promise<number> {
    const r = await this.client.query(
      `SELECT coalesce(max(arrival_seq), 0)::int AS max_seq FROM sim_sap_event_outcome WHERE source_event_key = $1`,
      [eventKey],
    )
    return Number((r.rows[0] as { max_seq?: number }).max_seq ?? 0) + 1
  }

  async listByEventKey(eventKey: string): Promise<SapSimEventOutcomeRecord[]> {
    const r = await this.client.query(
      `SELECT ${OUTCOME_COLUMNS} FROM sim_sap_event_outcome
       WHERE source_event_key = $1 ORDER BY arrival_seq ASC`,
      [eventKey],
    )
    return r.rows as SapSimEventOutcomeRecord[]
  }

  async findTerminal(eventKey: string): Promise<SapSimEventOutcomeRecord | null> {
    const r = await this.client.query(
      `SELECT ${OUTCOME_COLUMNS} FROM sim_sap_event_outcome
       WHERE source_event_key = $1 AND outcome NOT IN ${NON_TERMINAL_OUTCOMES}
       ORDER BY arrival_seq ASC LIMIT 1`,
      [eventKey],
    )
    return (r.rows[0] as SapSimEventOutcomeRecord | undefined) ?? null
  }

  async insert(row: NewSapSimEventOutcome): Promise<SapSimEventOutcomeRecord> {
    const r = await this.client.query(
      `INSERT INTO sim_sap_event_outcome (
         source_event_key, arrival_seq, topic, payload_sha256, outcome,
         message_state, doc_no, applied, detail
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       RETURNING ${OUTCOME_COLUMNS}`,
      [
        row.sourceEventKey,
        row.arrivalSeq,
        row.topic,
        row.payloadSha256,
        row.outcome,
        row.messageState ?? null,
        row.docNo ?? null,
        row.applied ?? false,
        JSON.stringify(row.detail ?? {}),
      ],
    )
    return r.rows[0] as SapSimEventOutcomeRecord
  }
}

export class PgSapSimFaultScenarioRepository {
  constructor(private readonly client: SqlClient) {}

  private mapRow(row: Record<string, unknown>): SapSimFaultScenarioRecord {
    const reorderKeysRaw = row['reorderKeys']
    const pendingRaw = row['pending']
    return {
      ...(row as unknown as SapSimFaultScenarioRecord),
      delayMs: num(row['delayMs']),
      reorderKeys: Array.isArray(reorderKeysRaw) ? (reorderKeysRaw as string[]) : null,
      pending: Array.isArray(pendingRaw) ? (pendingRaw as Array<Record<string, unknown>>) : [],
    }
  }

  async list(): Promise<SapSimFaultScenarioRecord[]> {
    const r = await this.client.query(
      `SELECT ${FAULT_COLUMNS} FROM sim_sap_fault_scenario ORDER BY created_at ASC`,
    )
    return r.rows.map((row) => this.mapRow(row))
  }

  async findByScenarioNo(scenarioNo: string): Promise<SapSimFaultScenarioRecord | null> {
    const r = await this.client.query(
      `SELECT ${FAULT_COLUMNS} FROM sim_sap_fault_scenario WHERE scenario_no = $1`,
      [scenarioNo],
    )
    return r.rows[0] ? this.mapRow(r.rows[0]) : null
  }

  async insert(row: NewSapSimFaultScenario): Promise<SapSimFaultScenarioRecord> {
    const r = await this.client.query(
      `INSERT INTO sim_sap_fault_scenario (
         scenario_no, fault_type, match_event_key, match_topic,
         remaining_count, total_count, delay_ms, reorder_keys, pending, payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)
       RETURNING ${FAULT_COLUMNS}`,
      [
        row.scenarioNo,
        row.faultType,
        row.matchEventKey ?? null,
        row.matchTopic ?? null,
        row.remainingCount,
        row.totalCount ?? row.remainingCount,
        row.delayMs ?? null,
        row.reorderKeys ? JSON.stringify(row.reorderKeys) : null,
        JSON.stringify(row.pending ?? []),
        JSON.stringify(row.payload ?? {}),
      ],
    )
    return this.mapRow(r.rows[0])
  }

  async consume(id: string): Promise<SapSimFaultScenarioRecord | null> {
    const r = await this.client.query(
      `UPDATE sim_sap_fault_scenario
       SET remaining_count = greatest(remaining_count - 1, 0), updated_at = now()
       WHERE id = $1 AND remaining_count > 0
       RETURNING ${FAULT_COLUMNS}`,
      [id],
    )
    return r.rows[0] ? this.mapRow(r.rows[0]) : null
  }

  async setPending(id: string, pending: Array<Record<string, unknown>>): Promise<SapSimFaultScenarioRecord | null> {
    const r = await this.client.query(
      `UPDATE sim_sap_fault_scenario SET pending = $2::jsonb, updated_at = now()
       WHERE id = $1 RETURNING ${FAULT_COLUMNS}`,
      [id, JSON.stringify(pending)],
    )
    return r.rows[0] ? this.mapRow(r.rows[0]) : null
  }

  async setActive(id: string, active: boolean): Promise<SapSimFaultScenarioRecord | null> {
    const r = await this.client.query(
      `UPDATE sim_sap_fault_scenario SET active = $2, updated_at = now()
       WHERE id = $1 RETURNING ${FAULT_COLUMNS}`,
      [id, active],
    )
    return r.rows[0] ? this.mapRow(r.rows[0]) : null
  }
}

export function createPgSapSimFactsRepositories(client: SqlClient): SapSimFactsRepositories {
  return {
    orders: new PgSapSimOrderFactRepository(client),
    documents: new PgSapSimDocumentFactRepository(client),
    stock: new PgSapSimStockFactRepository(client),
    inTransit: new PgSapSimInTransitFactRepository(client),
    outcomes: new PgSapSimEventOutcomeRepository(client),
    faults: new PgSapSimFaultScenarioRepository(client),
    async runInEventTransaction<T>(eventKey: string, work: (facts: SapSimFactsRepositories) => Promise<T>): Promise<T> {
      const resource = client as SqlClient & { connect?: () => Promise<PoolClient>; release?: () => void }
      const owned = typeof resource.connect === 'function' && typeof resource.release !== 'function'
      const transactionClient = owned ? await resource.connect!() : client
      const begin = owned ? 'BEGIN' : 'SAVEPOINT sap_sim_custody_event'
      const commit = owned ? 'COMMIT' : 'RELEASE SAVEPOINT sap_sim_custody_event'
      const rollback = owned ? 'ROLLBACK' : 'ROLLBACK TO SAVEPOINT sap_sim_custody_event'
      try {
        await transactionClient.query(begin)
        await transactionClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sap-sim-custody:${eventKey}`])
        const result = await work(createPgSapSimFactsRepositories(transactionClient))
        await transactionClient.query(commit)
        return result
      } catch (error) {
        await transactionClient.query(rollback)
        throw error
      } finally {
        if (owned) (transactionClient as PoolClient).release()
      }
    },
  }
}

/** outbox 仓储 → 引擎回执端口适配（仅平台 outbox 表）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class PgSapSimOutboxReceiptAdapter implements SapSimOutboxReceiptPort {
  constructor(private readonly outbox: SapSimOutboxRepository) {}

  async findByEventId(eventId: string) {
    if (!UUID_RE.test(eventId)) return null // outbox.event_id 为 uuid 列；事件键不是 uuid 时跳过
    const row = await this.outbox.findByEventId(eventId)
    return row
      ? { eventId: row.eventId, status: row.status, externalRef: row.externalRef, payload: row.payload }
      : null
  }

  async findByExternalRef(externalRef: string) {
    const row = await this.outbox.findByExternalRef(externalRef)
    return row
      ? { eventId: row.eventId, status: row.status, externalRef: row.externalRef, payload: row.payload }
      : null
  }

  async applyReceipt(
    eventId: string,
    patch: { status: string; lastError?: string | null; payloadMerge: Record<string, unknown> },
  ) {
    const row = await this.outbox.updateDelivery(eventId, {
      status: patch.status,
      lastError: patch.lastError ?? null,
      clearLastError: !patch.lastError,
      bumpAttempt: true,
      payloadMerge: patch.payloadMerge,
    })
    return row ? { eventId: row.eventId, status: row.status } : null
  }
}
