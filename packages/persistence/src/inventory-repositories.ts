// 跨包类型导入（type-only，编译期擦除）：指向 application 已构建的 dist（构建顺序由 workspace
// 拓扑保证：persistence 依赖 application，pnpm -r 先构建后者）。
// 不得相对引用 application/src/**：各包 tsconfig.build.json 置空 paths 且限 rootDir=src，
// 源码导入会触发 TS6059。L0 整合步把本文件导出并入 @cadenza/persistence index、
// 端口导出并入 @cadenza/application index 后，双方改包名导入。
import type {
  BarcodeBindingRecord,
  BarcodeLabelRecord,
  BarcodeRepository,
  CarrierBindingRecord,
  CarrierRecord,
  CarrierRepository,
  CommandReceiptRefRepository,
  GenealogyEdgeRecord,
  GenealogyRepository,
  InventoryUnitRecord,
  InventoryBusinessHoldRecord,
  InventoryUnitRepository,
  InventoryUnitStatusPatch,
  MaterialLotRecord,
  MaterialLotRepository,
  MaterialSegmentRecord,
  MaterialSegmentRepository,
  NewBarcodeBinding,
  NewBarcodeLabel,
  NewGenealogyEdge,
  NewInventoryUnit,
  NewMaterialLot,
  NewMaterialSegment,
  NewReservation,
  NewStockBalance,
  NewStockEntry,
  NewStockTransaction,
  ReservationRecord,
  ReservationRepository,
  StockBalancePatch,
  StockBalanceRecord,
  StockBalanceRepository,
  StockEntryRecord,
  StockTransactionRecord,
  StockTransactionRepository,
} from '@cadenza/application'
import type { SqlClient } from './sql-client'

/**
 * inventory 域仓储的 PostgreSQL 实现（implements application 端口；依赖方向 persistence → application）。
 *
 * - 全部参数化查询；数量列 numeric(18,4) 以字符串往返（IT-07 定点保真）；
 * - 时间戳出参统一 ISO-8601 字符串（IT-37：业务时间 business_time 与系统时间 created_at 分列）；
 * - 行锁方法（lockForUpdate / lockByKey）在命令事务内执行 SELECT ... FOR UPDATE（IT-25/27/15）；
 * - 跨包类型导入为 type-only（L0 整合步把本文件导出并入 @cadenza/persistence index 后，
 *   消费方改包名导入；见交付记录）。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

/** 带行类型的查询辅助（SqlClient.query 非泛型，同 S2 repositories 的行断言模式集中化）。 */
async function typedQuery<T>(
  client: SqlClient,
  text: string,
  values?: readonly unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const r = await client.query(text, values)
  return { rows: r.rows as T[], rowCount: r.rowCount }
}

// ---------------- 物料批次（append-only：仅插入与读取，IT-S6） ----------------

interface LotRow {
  id: string
  lot_no: string
  kind: 'purchase' | 'production'
  material_id: string
  material_code: string
  supplier_lot_no: string | null
  supplier_id: string | null
  external_doc_no: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  note: string | null
  created_at: Date | string
  created_by: string | null
}

function mapLot(r: LotRow): MaterialLotRecord {
  return {
    id: r.id,
    lotNo: r.lot_no,
    kind: r.kind,
    materialId: r.material_id,
    materialCode: r.material_code,
    supplierLotNo: r.supplier_lot_no,
    supplierId: r.supplier_id,
    externalDocNo: r.external_doc_no,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    note: r.note,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgMaterialLotRepository implements MaterialLotRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<MaterialLotRecord | null> {
    const r = await typedQuery<LotRow>(this.client, `SELECT * FROM material_lot WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapLot(r.rows[0])
  }

  async findByNo(plantId: string, lotNo: string): Promise<MaterialLotRecord | null> {
    const r = await typedQuery<LotRow>(this.client, 
      `SELECT * FROM material_lot WHERE plant_id = $1 AND lot_no = $2`,
      [plantId, lotNo],
    )
    return r.rows[0] === undefined ? null : mapLot(r.rows[0])
  }

  async insert(lot: NewMaterialLot): Promise<MaterialLotRecord> {
    const r = await typedQuery<LotRow>(this.client, 
      `INSERT INTO material_lot
         (lot_no, kind, material_id, material_code, supplier_lot_no, supplier_id, external_doc_no,
          plant_id, enterprise_id, business_time, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        lot.lotNo,
        lot.kind,
        lot.materialId,
        lot.materialCode,
        lot.supplierLotNo ?? null,
        lot.supplierId ?? null,
        lot.externalDocNo ?? null,
        lot.plantId,
        lot.enterpriseId,
        lot.businessTime,
        lot.note ?? null,
        lot.createdBy ?? null,
      ],
    )
    return mapLot(r.rows[0]!)
  }
}

// ---------------- 库存单元 ----------------

interface UnitRow {
  id: string
  unit_no: string
  material_id: string
  material_code: string
  lot_id: string
  uom_id: string
  uom_code: string
  trace_mode: 'segment' | 'quantity'
  status: InventoryUnitRecord['status']
  balance_open: boolean
  balance_closed_at: Date | string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
  created_by: string | null
}

function mapUnit(r: UnitRow): InventoryUnitRecord {
  return {
    id: r.id,
    unitNo: r.unit_no,
    materialId: r.material_id,
    materialCode: r.material_code,
    lotId: r.lot_id,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    traceMode: r.trace_mode,
    status: r.status,
    balanceOpen: r.balance_open,
    balanceClosedAt: isoOrNull(r.balance_closed_at),
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
  }
}

export class PgInventoryUnitRepository implements InventoryUnitRepository {
  constructor(private readonly client: SqlClient) {}

  async hasActiveQualityHold(unitId: string): Promise<boolean> {
    const r = await this.client.query(
      `SELECT EXISTS (SELECT 1 FROM quality_hold WHERE inventory_unit_id=$1 AND status='active') AS held`, [unitId],
    )
    return r.rows[0]?.held === true
  }

  async businessHolds(unitId: string): Promise<InventoryBusinessHoldRecord[]> {
    const r=await this.client.query(`SELECT id,unit_id AS "unitId",enterprise_id AS "enterpriseId",plant_id AS "plantId",reason,
      business_ref AS "businessRef",command_receipt_id AS "commandReceiptId",actor_user_id AS "actorUserId",actor_login_name AS "actorLoginName",created_at AS "createdAt"
      FROM inventory_business_hold WHERE unit_id=$1 ORDER BY created_at,id`,[unitId])
    return r.rows.map(row=>({...row,createdAt:iso(row.createdAt)})) as InventoryBusinessHoldRecord[]
  }

  async insertBusinessHold(input: Omit<InventoryBusinessHoldRecord,'id'|'createdAt'> & {createdAt:string}): Promise<InventoryBusinessHoldRecord> {
    await this.client.query(`INSERT INTO inventory_business_hold(unit_id,enterprise_id,plant_id,reason,business_ref,command_receipt_id,actor_user_id,actor_login_name,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(enterprise_id,unit_id,business_ref) DO NOTHING`,
      [input.unitId,input.enterpriseId,input.plantId,input.reason,input.businessRef,input.commandReceiptId,input.actorUserId,input.actorLoginName,input.createdAt])
    return (await this.businessHolds(input.unitId)).find(row=>row.businessRef===input.businessRef)!
  }


  async findById(id: string): Promise<InventoryUnitRecord | null> {
    const r = await typedQuery<UnitRow>(this.client, `SELECT * FROM inventory_unit WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapUnit(r.rows[0])
  }

  async findByUnitNo(plantId: string, unitNo: string): Promise<InventoryUnitRecord | null> {
    const r = await typedQuery<UnitRow>(this.client, 
      `SELECT * FROM inventory_unit WHERE plant_id = $1 AND unit_no = $2`,
      [plantId, unitNo],
    )
    return r.rows[0] === undefined ? null : mapUnit(r.rows[0])
  }

  async findByUnitNoEnterprise(enterpriseId: string, unitNo: string): Promise<InventoryUnitRecord | null> {
    const r = await typedQuery<UnitRow>(this.client, 
      `SELECT * FROM inventory_unit WHERE enterprise_id = $1 AND unit_no = $2`,
      [enterpriseId, unitNo],
    )
    return r.rows[0] === undefined ? null : mapUnit(r.rows[0])
  }

  /** IT-25/27/15：稳定次序（id 升序）行锁——调用方已排序去重，此处保持次序执行行锁。 */
  async lockForUpdate(unitIds: readonly string[]): Promise<InventoryUnitRecord[]> {
    if (unitIds.length === 0) return []
    const r = await typedQuery<UnitRow>(this.client, 
      `SELECT * FROM inventory_unit WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [unitIds],
    )
    return r.rows.map(mapUnit)
  }

  async insert(unit: NewInventoryUnit): Promise<InventoryUnitRecord> {
    const r = await typedQuery<UnitRow>(this.client, 
      `INSERT INTO inventory_unit
         (unit_no, material_id, material_code, lot_id, uom_id, uom_code, trace_mode, status,
          plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        unit.unitNo,
        unit.materialId,
        unit.materialCode,
        unit.lotId,
        unit.uomId,
        unit.uomCode,
        unit.traceMode ?? 'quantity',
        unit.status ?? 'in_stock',
        unit.plantId,
        unit.enterpriseId,
        unit.businessTime,
        unit.createdBy ?? null,
      ],
    )
    return mapUnit(r.rows[0]!)
  }

  async findTransferDestination(plantId: string, ownerId: string, locationId: string) {
    const r = await this.client.query(`SELECT p.id AS "plantId", p.enterprise_id AS "enterpriseId",
      o.id AS "ownerId", o.name AS "ownerName", l.code AS "locationCode"
      FROM org_node p JOIN org_node o ON p.path LIKE o.path || '%'
      JOIN storage_location l ON l.plant_id = p.id AND l.enterprise_id = p.enterprise_id
      WHERE p.id=$1 AND p.kind='plant' AND p.status='active'
      AND o.id=$2 AND o.kind='legal_entity' AND o.status='active' AND o.enterprise_id=p.enterprise_id
      AND l.id=$3 AND l.status='active'`, [plantId, ownerId, locationId])
    return r.rows.length === 1 ? r.rows[0] as { plantId: string; enterpriseId: string; ownerId: string; ownerName: string; locationCode: string } : null
  }

  async isTransferOutBalance(unitId: string, balanceId: string, plantId: string): Promise<boolean> {
    const r = await this.client.query(`SELECT 1 FROM stock_transaction st JOIN stock_balance b ON b.id=st.balance_id
      WHERE st.unit_id=$1 AND b.id=$2 AND st.plant_id=$3 AND st.movement_kind='transfer_out'
      AND st.after_qty>st.before_qty AND st.to_location_id=b.location_id AND st.to_owner_id=b.owner_id LIMIT 1`, [unitId,balanceId,plantId])
    return r.rows.length === 1
  }

  async receiveAtPlant(id: string, plantId: string, actor: string): Promise<void> {
    await this.client.query(`UPDATE inventory_unit SET plant_id=$2,status='in_stock',updated_at=now(),updated_by=$3 WHERE id=$1`, [id,plantId,actor])
  }

  async updateStatus(id: string, patch: InventoryUnitStatusPatch, actor: string | null): Promise<InventoryUnitRecord | null> {
    const r = await typedQuery<UnitRow>(this.client, 
      `UPDATE inventory_unit SET
         status = COALESCE($2, status),
         balance_open = COALESCE($3, balance_open),
         balance_closed_at = COALESCE($4, balance_closed_at),
         updated_at = now(), updated_by = $5
       WHERE id = $1 RETURNING *`,
      [id, patch.status ?? null, patch.balanceOpen ?? null, patch.balanceClosedAt ?? null, actor],
    )
    return r.rows[0] === undefined ? null : mapUnit(r.rows[0])
  }
}

// ---------------- 轴段 ----------------

interface SegmentRow {
  id: string
  unit_id: string
  seq_no: number
  kind: 'continuous' | 'independent'
  length_start: string | null
  length_end: string | null
  quantity: string
  uom_id: string
  uom_code: string
  measurement_basis: string
  conversion_revision_id: string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
}

function mapSegment(r: SegmentRow): MaterialSegmentRecord {
  return {
    id: r.id,
    unitId: r.unit_id,
    seqNo: r.seq_no,
    kind: r.kind,
    lengthStart: r.length_start,
    lengthEnd: r.length_end,
    quantity: r.quantity,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    measurementBasis: r.measurement_basis,
    conversionRevisionId: r.conversion_revision_id,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
  }
}

export class PgMaterialSegmentRepository implements MaterialSegmentRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(segment: NewMaterialSegment): Promise<MaterialSegmentRecord> {
    const r = await typedQuery<SegmentRow>(this.client, 
      `INSERT INTO material_segment
         (unit_id, seq_no, kind, length_start, length_end, quantity, uom_id, uom_code,
          measurement_basis, conversion_revision_id, plant_id, enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        segment.unitId,
        segment.seqNo,
        segment.kind ?? 'independent',
        segment.lengthStart ?? null,
        segment.lengthEnd ?? null,
        segment.quantity,
        segment.uomId,
        segment.uomCode,
        segment.measurementBasis,
        segment.conversionRevisionId ?? null,
        segment.plantId,
        segment.enterpriseId,
        segment.businessTime,
        segment.createdBy ?? null,
      ],
    )
    return mapSegment(r.rows[0]!)
  }

  async listByUnit(unitId: string): Promise<MaterialSegmentRecord[]> {
    const r = await typedQuery<SegmentRow>(this.client, 
      `SELECT * FROM material_segment WHERE unit_id = $1 ORDER BY seq_no`,
      [unitId],
    )
    return r.rows.map(mapSegment)
  }
}

// ---------------- 库存余额 ----------------

interface BalanceRow {
  id: string
  unit_id: string
  location_id: string
  location_code: string
  owner_id: string
  owner_name: string
  quantity: string
  uom_id: string
  uom_code: string
  measurement_basis: string
  conversion_revision_id: string | null
  quality_status: StockBalanceRecord['qualityStatus']
  legacy_status: string | null
  status: 'active' | 'closed'
  closed_at: Date | string | null
  plant_id: string
  enterprise_id: string
  business_time: Date | string
  created_at: Date | string
}

function mapBalance(r: BalanceRow): StockBalanceRecord {
  return {
    id: r.id,
    unitId: r.unit_id,
    locationId: r.location_id,
    locationCode: r.location_code,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    quantity: r.quantity,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    measurementBasis: r.measurement_basis,
    conversionRevisionId: r.conversion_revision_id,
    qualityStatus: r.quality_status,
    legacyStatus: r.legacy_status,
    status: r.status,
    closedAt: isoOrNull(r.closed_at),
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    businessTime: iso(r.business_time),
    createdAt: iso(r.created_at),
  }
}

export class PgStockBalanceRepository implements StockBalanceRepository {
  constructor(private readonly client: SqlClient) {}

  async findByKey(unitId: string, locationId: string, ownerId: string): Promise<StockBalanceRecord | null> {
    const r = await typedQuery<BalanceRow>(this.client, 
      `SELECT * FROM stock_balance WHERE unit_id = $1 AND location_id = $2 AND owner_id = $3`,
      [unitId, locationId, ownerId],
    )
    return r.rows[0] === undefined ? null : mapBalance(r.rows[0])
  }

  /** IT-20：主事务内行锁余额（交易决策用的余额实时更新）。 */
  async lockByKey(unitId: string, locationId: string, ownerId: string): Promise<StockBalanceRecord | null> {
    const r = await typedQuery<BalanceRow>(this.client, 
      `SELECT * FROM stock_balance WHERE unit_id = $1 AND location_id = $2 AND owner_id = $3 FOR UPDATE`,
      [unitId, locationId, ownerId],
    )
    return r.rows[0] === undefined ? null : mapBalance(r.rows[0])
  }

  async listActiveByUnit(unitId: string): Promise<StockBalanceRecord[]> {
    const r = await typedQuery<BalanceRow>(this.client, 
      `SELECT * FROM stock_balance WHERE unit_id = $1 AND status = 'active' ORDER BY id`,
      [unitId],
    )
    return r.rows.map(mapBalance)
  }

  async findLatestByUnit(unitId: string): Promise<StockBalanceRecord | null> {
    const r = await typedQuery<BalanceRow>(this.client, 
      `SELECT * FROM stock_balance WHERE unit_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [unitId],
    )
    return r.rows[0] === undefined ? null : mapBalance(r.rows[0])
  }

  async insert(balance: NewStockBalance): Promise<StockBalanceRecord> {
    const r = await typedQuery<BalanceRow>(this.client, 
      `INSERT INTO stock_balance
         (unit_id, location_id, location_code, owner_id, owner_name, quantity, uom_id, uom_code,
          measurement_basis, conversion_revision_id, quality_status, legacy_status, plant_id,
          enterprise_id, business_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        balance.unitId,
        balance.locationId,
        balance.locationCode,
        balance.ownerId,
        balance.ownerName,
        balance.quantity,
        balance.uomId,
        balance.uomCode,
        balance.measurementBasis,
        balance.conversionRevisionId ?? null,
        balance.qualityStatus ?? 'pending_inspection',
        balance.legacyStatus ?? null,
        balance.plantId,
        balance.enterpriseId,
        balance.businessTime,
        balance.createdBy ?? null,
      ],
    )
    return mapBalance(r.rows[0]!)
  }

  async adjust(balanceId: string, patch: StockBalancePatch, actor: string | null): Promise<StockBalanceRecord | null> {
    const r = await typedQuery<BalanceRow>(this.client, 
      `UPDATE stock_balance SET
         quantity = COALESCE($2, quantity),
         quality_status = COALESCE($3, quality_status),
         status = COALESCE($4, status),
         closed_at = CASE WHEN $4::text = 'closed' THEN COALESCE($5::timestamptz, closed_at, now())
                          WHEN $4::text = 'active' THEN NULL ELSE closed_at END,
         updated_at = now(), updated_by = $6
       WHERE id = $1 RETURNING *`,
      [balanceId, patch.quantity ?? null, patch.qualityStatus ?? null, patch.status ?? null, patch.closedAt ?? null, actor],
    )
    return r.rows[0] === undefined ? null : mapBalance(r.rows[0])
  }

  async listPaged(filter: {
    enterpriseId: string
    plantIds: string[] | null
    plantId?: string
    unitNoLike?: string
    materialCode?: string
    includeClosed: boolean
    page: number
    pageSize: number
  }): Promise<{ items: StockBalanceRecord[]; total: number }> {
    const conditions: string[] = ['sb.enterprise_id = $1']
    const params: unknown[] = [filter.enterpriseId]
    if (filter.plantIds !== null) {
      params.push(filter.plantIds)
      conditions.push(`sb.plant_id = ANY($${params.length}::uuid[])`)
    }
    if (filter.plantId !== undefined) {
      params.push(filter.plantId)
      conditions.push(`sb.plant_id = $${params.length}::uuid`)
    }
    if (!filter.includeClosed) {
      conditions.push(`sb.status = 'active'`)
    }
    if (filter.unitNoLike !== undefined) {
      params.push(`%${filter.unitNoLike}%`)
      conditions.push(`iu.unit_no LIKE $${params.length}`)
    }
    if (filter.materialCode !== undefined) {
      params.push(filter.materialCode)
      conditions.push(`iu.material_code = $${params.length}`)
    }
    const where = conditions.join(' AND ')
    const offset = (filter.page - 1) * filter.pageSize
    const count = await typedQuery<{ n: number }>(this.client, 
      `SELECT count(*)::int AS n FROM stock_balance sb
         JOIN inventory_unit iu ON iu.id = sb.unit_id
       WHERE ${where}`,
      params,
    )
    params.push(filter.pageSize, offset)
    const r = await typedQuery<BalanceRow>(this.client, 
      `SELECT sb.* FROM stock_balance sb
         JOIN inventory_unit iu ON iu.id = sb.unit_id
       WHERE ${where}
       ORDER BY sb.updated_at DESC, sb.id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return { items: r.rows.map(mapBalance), total: count.rows[0]?.n ?? 0 }
  }
}

// ---------------- 流水与分录（append-only，IT-19/32） ----------------

interface TransactionRow {
  id: string
  command_receipt_id: string
  line_no: number
  movement_kind: StockTransactionRecord['movementKind']
  unit_id: string
  lot_id: string | null
  balance_id: string | null
  from_location_id: string | null
  from_location_code: string | null
  to_location_id: string | null
  to_location_code: string | null
  from_owner_id: string | null
  from_owner_name: string | null
  to_owner_id: string | null
  to_owner_name: string | null
  quantity: string
  uom_id: string
  uom_code: string
  measurement_basis: string
  conversion_revision_id: string | null
  before_qty: string
  after_qty: string
  ref_type: string | null
  ref_id: string | null
  reason: string | null
  business_time: Date | string
  shift_date: string | null
  plant_id: string
  enterprise_id: string
  created_at: Date | string
}

function mapTransaction(r: TransactionRow): StockTransactionRecord {
  return {
    id: r.id,
    commandReceiptId: r.command_receipt_id,
    lineNo: r.line_no,
    movementKind: r.movement_kind,
    unitId: r.unit_id,
    lotId: r.lot_id,
    balanceId: r.balance_id,
    fromLocationId: r.from_location_id,
    fromLocationCode: r.from_location_code,
    toLocationId: r.to_location_id,
    toLocationCode: r.to_location_code,
    fromOwnerId: r.from_owner_id,
    fromOwnerName: r.from_owner_name,
    toOwnerId: r.to_owner_id,
    toOwnerName: r.to_owner_name,
    quantity: r.quantity,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    measurementBasis: r.measurement_basis,
    conversionRevisionId: r.conversion_revision_id,
    beforeQty: r.before_qty,
    afterQty: r.after_qty,
    refType: r.ref_type,
    refId: r.ref_id,
    reason: r.reason,
    businessTime: iso(r.business_time),
    shiftDate: r.shift_date,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
  }
}

export class PgStockTransactionRepository implements StockTransactionRepository {
  constructor(private readonly client: SqlClient) {}

  async insertLine(line: NewStockTransaction): Promise<StockTransactionRecord> {
    const r = await typedQuery<TransactionRow>(this.client, 
      `INSERT INTO stock_transaction
         (command_receipt_id, line_no, movement_kind, unit_id, lot_id, balance_id,
          from_location_id, from_location_code, to_location_id, to_location_code,
          from_owner_id, from_owner_name, to_owner_id, to_owner_name,
          quantity, uom_id, uom_code, measurement_basis, conversion_revision_id,
          before_qty, after_qty, ref_type, ref_id, reason, business_time, shift_date,
          plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
       RETURNING *`,
      [
        line.commandReceiptId,
        line.lineNo,
        line.movementKind,
        line.unitId,
        line.lotId ?? null,
        line.balanceId ?? null,
        line.fromLocationId ?? null,
        line.fromLocationCode ?? null,
        line.toLocationId ?? null,
        line.toLocationCode ?? null,
        line.fromOwnerId ?? null,
        line.fromOwnerName ?? null,
        line.toOwnerId ?? null,
        line.toOwnerName ?? null,
        line.quantity,
        line.uomId,
        line.uomCode,
        line.measurementBasis,
        line.conversionRevisionId ?? null,
        line.beforeQty,
        line.afterQty,
        line.refType ?? null,
        line.refId ?? null,
        line.reason ?? null,
        line.businessTime,
        line.shiftDate ?? null,
        line.plantId,
        line.enterpriseId,
        line.createdBy ?? null,
      ],
    )
    return mapTransaction(r.rows[0]!)
  }

  async insertEntry(entry: NewStockEntry): Promise<StockEntryRecord> {
    const r = await typedQuery<{
      id: string
      transaction_id: string
      entry_no: number
      balance_id: string
      unit_id: string
      location_id: string
      location_code: string
      owner_id: string
      owner_name: string
      lot_id: string | null
      segment_id: string | null
      quantity_delta: string
      before_qty: string
      after_qty: string
      purpose: string | null
      created_at: Date | string
    }>(this.client, 
      `INSERT INTO stock_entry
         (transaction_id, entry_no, balance_id, unit_id, location_id, location_code, owner_id,
          owner_name, lot_id, segment_id, quantity_delta, before_qty, after_qty, purpose,
          plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        entry.transactionId,
        entry.entryNo,
        entry.balanceId,
        entry.unitId,
        entry.locationId,
        entry.locationCode,
        entry.ownerId,
        entry.ownerName,
        entry.lotId ?? null,
        entry.segmentId ?? null,
        entry.quantityDelta,
        entry.beforeQty,
        entry.afterQty,
        entry.purpose ?? null,
        entry.plantId,
        entry.enterpriseId,
        entry.createdBy ?? null,
      ],
    )
    const e = r.rows[0]!
    return {
      id: e.id,
      transactionId: e.transaction_id,
      entryNo: e.entry_no,
      balanceId: e.balance_id,
      unitId: e.unit_id,
      locationId: e.location_id,
      locationCode: e.location_code,
      ownerId: e.owner_id,
      ownerName: e.owner_name,
      lotId: e.lot_id,
      segmentId: e.segment_id,
      quantityDelta: e.quantity_delta,
      beforeQty: e.before_qty,
      afterQty: e.after_qty,
      purpose: e.purpose,
      createdAt: iso(e.created_at),
    }
  }

  async listByUnit(unitId: string, limit: number): Promise<StockTransactionRecord[]> {
    const r = await typedQuery<TransactionRow>(this.client, 
      `SELECT * FROM stock_transaction WHERE unit_id = $1 ORDER BY created_at DESC, line_no DESC LIMIT $2`,
      [unitId, limit],
    )
    return r.rows.map(mapTransaction)
  }

  async countLinesByReceipt(commandReceiptId: string): Promise<number> {
    const r = await typedQuery<{ n: number }>(this.client, 
      `SELECT count(*)::int AS n FROM stock_transaction WHERE command_receipt_id = $1`,
      [commandReceiptId],
    )
    return r.rows[0]?.n ?? 0
  }

  async sumQuantityByUnit(
    unitId: string,
    filter: { movementKind: StockTransactionRecord['movementKind']; refType?: string },
  ): Promise<string> {
    const r = await typedQuery<{ total: string }>(this.client, 
      `SELECT COALESCE(sum(quantity), 0)::text AS total FROM stock_transaction
       WHERE unit_id = $1 AND movement_kind = $2 AND ($3::text IS NULL OR ref_type = $3)`,
      [unitId, filter.movementKind, filter.refType ?? null],
    )
    return r.rows[0]?.total ?? '0'
  }
}

// ---------------- 预留 ----------------

interface ReservationRow {
  id: string
  unit_id: string
  location_id: string | null
  holder_type: ReservationRecord['holderType']
  holder_ref: string
  quantity: string
  uom_id: string
  uom_code: string
  measurement_basis: string
  conversion_revision_id: string | null
  status: ReservationRecord['status']
  valid_until: Date | string
  acquired_at: Date | string
  command_receipt_id: string | null
  released_at: Date | string | null
  released_by: string | null
  release_reason: string | null
  plant_id: string
  enterprise_id: string
  created_by: string | null
}

function mapReservation(r: ReservationRow): ReservationRecord {
  return {
    id: r.id,
    unitId: r.unit_id,
    locationId: r.location_id,
    holderType: r.holder_type,
    holderRef: r.holder_ref,
    quantity: r.quantity,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    measurementBasis: r.measurement_basis,
    conversionRevisionId: r.conversion_revision_id,
    status: r.status,
    validUntil: iso(r.valid_until),
    acquiredAt: iso(r.acquired_at),
    commandReceiptId: r.command_receipt_id,
    releasedAt: isoOrNull(r.released_at),
    releasedBy: r.released_by,
    releaseReason: r.release_reason,
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdBy: r.created_by,
  }
}

export class PgReservationRepository implements ReservationRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(reservation: NewReservation): Promise<ReservationRecord> {
    const r = await typedQuery<ReservationRow>(this.client, 
      `INSERT INTO reservation
         (unit_id, location_id, holder_type, holder_ref, quantity, uom_id, uom_code,
          measurement_basis, conversion_revision_id, valid_until, command_receipt_id,
          plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        reservation.unitId,
        reservation.locationId ?? null,
        reservation.holderType,
        reservation.holderRef,
        reservation.quantity,
        reservation.uomId,
        reservation.uomCode,
        reservation.measurementBasis,
        reservation.conversionRevisionId ?? null,
        reservation.validUntil,
        reservation.commandReceiptId ?? null,
        reservation.plantId,
        reservation.enterpriseId,
        reservation.createdBy ?? null,
      ],
    )
    return mapReservation(r.rows[0]!)
  }

  async findById(id: string): Promise<ReservationRecord | null> {
    const r = await typedQuery<ReservationRow>(this.client, `SELECT * FROM reservation WHERE id = $1`, [id])
    return r.rows[0] === undefined ? null : mapReservation(r.rows[0])
  }

  async listActiveByUnit(unitId: string): Promise<ReservationRecord[]> {
    const r = await typedQuery<ReservationRow>(this.client, 
      `SELECT * FROM reservation WHERE unit_id = $1 AND status = 'active' ORDER BY id`,
      [unitId],
    )
    return r.rows.map(mapReservation)
  }

  async release(id: string, releasedBy: string, releaseReason: string | null, now: string): Promise<ReservationRecord | null> {
    const r = await typedQuery<ReservationRow>(this.client, 
      `UPDATE reservation SET status = 'released', released_at = $2, released_by = $3,
         release_reason = $4, updated_at = now(), updated_by = $3
       WHERE id = $1 AND status = 'active' RETURNING *`,
      [id, now, releasedBy, releaseReason],
    )
    return r.rows[0] === undefined ? null : mapReservation(r.rows[0])
  }

  async consume(id: string, consumedQty: string, now: string, actor: string | null): Promise<ReservationRecord | null> {
    // 消耗量 < 预留量：缩减数量保留活动预留；否则整笔转 consumed（释放记录同列留痕）
    const r = await typedQuery<ReservationRow>(this.client, 
      `UPDATE reservation SET
         quantity = CASE WHEN quantity > $2::numeric THEN quantity - $2::numeric ELSE quantity END,
         status = CASE WHEN quantity > $2::numeric THEN status ELSE 'consumed' END,
         released_at = CASE WHEN quantity > $2::numeric THEN released_at ELSE $3::timestamptz END,
         released_by = CASE WHEN quantity > $2::numeric THEN released_by ELSE $4 END,
         release_reason = CASE WHEN quantity > $2::numeric THEN release_reason ELSE '发料核销' END,
         updated_at = now(), updated_by = $4
       WHERE id = $1 AND status = 'active' RETURNING *`,
      [id, consumedQty, now, actor],
    )
    return r.rows[0] === undefined ? null : mapReservation(r.rows[0])
  }
}

// ---------------- 条码 ----------------

export class PgBarcodeRepository implements BarcodeRepository {
  constructor(private readonly client: SqlClient) {}

  async insertLabel(label: NewBarcodeLabel): Promise<BarcodeLabelRecord> {
    const r = await typedQuery<{
      id: string
      barcode_value: string
      label_kind: string
      format_version: number | null
      status: 'active' | 'voided'
      reprint_of: string | null
      reprint_reason: string | null
      voided_at: Date | string | null
      voided_reason: string | null
      printed_at: Date | string | null
      printed_by: string | null
      print_channel: string | null
      plant_id: string
      enterprise_id: string
      created_at: Date | string
    }>(this.client, 
      `INSERT INTO barcode_label
         (barcode_value, label_kind, format_version, reprint_of, reprint_reason, printed_at,
          printed_by, print_channel, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,$10) RETURNING *`,
      [
        label.barcodeValue,
        label.labelKind,
        label.formatVersion ?? null,
        label.reprintOf ?? null,
        label.reprintReason ?? null,
        label.printedBy ?? null,
        label.printChannel ?? null,
        label.plantId,
        label.enterpriseId,
        label.createdBy ?? null,
      ],
    )
    const row = r.rows[0]!
    return {
      id: row.id,
      barcodeValue: row.barcode_value,
      labelKind: row.label_kind,
      formatVersion: row.format_version,
      status: row.status,
      reprintOf: row.reprint_of,
      reprintReason: row.reprint_reason,
      voidedAt: isoOrNull(row.voided_at),
      voidedReason: row.voided_reason,
      printedAt: isoOrNull(row.printed_at),
      printedBy: row.printed_by,
      printChannel: row.print_channel,
      plantId: row.plant_id,
      enterpriseId: row.enterprise_id,
      createdAt: iso(row.created_at),
    }
  }

  async listLabelsByValue(barcodeValue: string): Promise<BarcodeLabelRecord[]> {
    const r = await this.client.query(
      `SELECT * FROM barcode_label WHERE barcode_value = $1 ORDER BY created_at`,
      [barcodeValue],
    )
    return r.rows.map((row: Record<string, unknown>) => this.mapLabel(row))
  }

  private mapLabel(row: Record<string, unknown>): BarcodeLabelRecord {
    return {
      id: row['id'] as string,
      barcodeValue: row['barcode_value'] as string,
      labelKind: row['label_kind'] as string,
      formatVersion: (row['format_version'] as number | null) ?? null,
      status: row['status'] as 'active' | 'voided',
      reprintOf: (row['reprint_of'] as string | null) ?? null,
      reprintReason: (row['reprint_reason'] as string | null) ?? null,
      voidedAt: isoOrNull(row['voided_at'] as Date | string | null),
      voidedReason: (row['voided_reason'] as string | null) ?? null,
      printedAt: isoOrNull(row['printed_at'] as Date | string | null),
      printedBy: (row['printed_by'] as string | null) ?? null,
      printChannel: (row['print_channel'] as string | null) ?? null,
      plantId: row['plant_id'] as string,
      enterpriseId: row['enterprise_id'] as string,
      createdAt: iso(row['created_at'] as Date | string),
    }
  }

  async findActiveBindingByValue(barcodeValue: string): Promise<BarcodeBindingRecord | null> {
    const r = await this.client.query(
      `SELECT * FROM barcode_binding WHERE barcode_value = $1 AND active = true`,
      [barcodeValue],
    )
    return r.rows[0] === undefined ? null : this.mapBinding(r.rows[0] as Record<string, unknown>)
  }

  async insertBinding(binding: NewBarcodeBinding): Promise<BarcodeBindingRecord> {
    const r = await this.client.query(
      `INSERT INTO barcode_binding
         (barcode_value, bound_type, bound_id, active, bound_by, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,true,$4,$5,$6,$7) RETURNING *`,
      [
        binding.barcodeValue,
        binding.boundType,
        binding.boundId,
        binding.boundBy ?? null,
        binding.plantId,
        binding.enterpriseId,
        binding.createdBy ?? null,
      ],
    )
    return this.mapBinding(r.rows[0] as Record<string, unknown>)
  }

  async unbind(bindingId: string, unboundBy: string, reason: string | null, now: string): Promise<BarcodeBindingRecord | null> {
    const r = await this.client.query(
      `UPDATE barcode_binding SET active = false, unbound_at = $2, unbound_by = $3,
         unbind_reason = $4, updated_at = now(), updated_by = $3
       WHERE id = $1 AND active = true RETURNING *`,
      [bindingId, now, unboundBy, reason],
    )
    return r.rows[0] === undefined ? null : this.mapBinding(r.rows[0] as Record<string, unknown>)
  }

  async listFormatRules(): Promise<Array<{ formatVersion: number; labelKind: string; pattern: string; active: boolean }>> {
    const r = await typedQuery<{ format_version: number; label_kind: string; pattern: string; active: boolean }>(this.client, 
      `SELECT format_version, label_kind, pattern, active FROM barcode_format`,
    )
    return r.rows.map((row) => ({
      formatVersion: row.format_version,
      labelKind: row.label_kind,
      pattern: row.pattern,
      active: row.active,
    }))
  }

  private mapBinding(row: Record<string, unknown>): BarcodeBindingRecord {
    return {
      id: row['id'] as string,
      barcodeValue: row['barcode_value'] as string,
      boundType: row['bound_type'] as BarcodeBindingRecord['boundType'],
      boundId: row['bound_id'] as string,
      active: row['active'] as boolean,
      boundAt: iso(row['bound_at'] as Date | string),
      boundBy: (row['bound_by'] as string | null) ?? null,
      unboundAt: isoOrNull(row['unbound_at'] as Date | string | null),
      unboundBy: (row['unbound_by'] as string | null) ?? null,
      unbindReason: (row['unbind_reason'] as string | null) ?? null,
      plantId: row['plant_id'] as string,
      enterpriseId: row['enterprise_id'] as string,
    }
  }
}

// ---------------- 载具 ----------------

export class PgCarrierRepository implements CarrierRepository {
  constructor(private readonly client: SqlClient) {}

  async insertCarrier(input: {
    carrierCode: string
    carrierKind: CarrierRecord['carrierKind']
    plantId: string
    enterpriseId: string
    createdBy?: string | null
  }): Promise<CarrierRecord> {
    const r = await typedQuery<{
      id: string
      carrier_code: string
      carrier_kind: CarrierRecord['carrierKind']
      status: CarrierRecord['status']
      capacity: string | null
      plant_id: string
      enterprise_id: string
      created_at: Date | string
    }>(this.client, 
      `INSERT INTO carrier (carrier_code, carrier_kind, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [input.carrierCode, input.carrierKind, input.plantId, input.enterpriseId, input.createdBy ?? null],
    )
    const row = r.rows[0]!
    return {
      id: row.id,
      carrierCode: row.carrier_code,
      carrierKind: row.carrier_kind,
      status: row.status,
      capacity: row.capacity,
      plantId: row.plant_id,
      enterpriseId: row.enterprise_id,
      createdAt: iso(row.created_at),
    }
  }

  async findById(id: string): Promise<CarrierRecord | null> {
    const r = await this.client.query(
      `SELECT * FROM carrier WHERE id = $1`,
      [id],
    )
    if (r.rows[0] === undefined) return null
    const row = r.rows[0] as Record<string, unknown>
    return {
      id: row['id'] as string,
      carrierCode: row['carrier_code'] as string,
      carrierKind: row['carrier_kind'] as CarrierRecord['carrierKind'],
      status: row['status'] as CarrierRecord['status'],
      capacity: (row['capacity'] as string | null) ?? null,
      plantId: row['plant_id'] as string,
      enterpriseId: row['enterprise_id'] as string,
      createdAt: iso(row['created_at'] as Date | string),
    }
  }

  async findActiveLoadBindingByUnit(unitId: string): Promise<CarrierBindingRecord | null> {
    const r = await this.client.query(
      `SELECT * FROM carrier_binding WHERE unit_id = $1 AND effective_to IS NULL`,
      [unitId],
    )
    return r.rows[0] === undefined ? null : this.mapBinding(r.rows[0] as Record<string, unknown>)
  }

  async loadCarrier(input: {
    carrierId: string
    unitId: string
    loadedBy: string | null
    plantId: string
    enterpriseId: string
  }): Promise<CarrierBindingRecord> {
    // IT-S6：生效时间区间 exclusion 不重叠（重叠装载由库级 EXCLUDE 拒绝）
    const r = await this.client.query(
      `INSERT INTO carrier_binding
         (carrier_id, unit_id, effective_from, loaded_by, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,now(),$3,$4,$5,$3) RETURNING *`,
      [input.carrierId, input.unitId, input.loadedBy, input.plantId, input.enterpriseId],
    )
    return this.mapBinding(r.rows[0] as Record<string, unknown>)
  }

  async unloadCurrentLoad(unitId: string, unloadedBy: string, reason: string | null, now: string): Promise<CarrierBindingRecord | null> {
    // IT-01：清空仅解除当前装载（关闭当前时间区间，历史区间保留）
    const r = await this.client.query(
      `UPDATE carrier_binding SET effective_to = $2, unloaded_by = $3, unload_reason = $4,
         updated_at = now(), updated_by = $3
       WHERE unit_id = $1 AND effective_to IS NULL RETURNING *`,
      [unitId, now, unloadedBy, reason],
    )
    return r.rows[0] === undefined ? null : this.mapBinding(r.rows[0] as Record<string, unknown>)
  }

  async listLoadedUnits(carrierId: string): Promise<Array<{ unitId: string; unitNo: string }>> {
    const r = await typedQuery<{ unit_id: string; unit_no: string }>(this.client, 
      `SELECT iu.id AS unit_id, iu.unit_no FROM carrier_binding cb
         JOIN inventory_unit iu ON iu.id = cb.unit_id
       WHERE cb.carrier_id = $1 AND cb.effective_to IS NULL`,
      [carrierId],
    )
    return r.rows.map((row) => ({ unitId: row.unit_id, unitNo: row.unit_no }))
  }

  private mapBinding(row: Record<string, unknown>): CarrierBindingRecord {
    return {
      id: row['id'] as string,
      carrierId: row['carrier_id'] as string,
      unitId: row['unit_id'] as string,
      effectiveFrom: iso(row['effective_from'] as Date | string),
      effectiveTo: isoOrNull(row['effective_to'] as Date | string | null),
      loadedBy: (row['loaded_by'] as string | null) ?? null,
      unloadedBy: (row['unloaded_by'] as string | null) ?? null,
      unloadReason: (row['unload_reason'] as string | null) ?? null,
      plantId: row['plant_id'] as string,
      enterpriseId: row['enterprise_id'] as string,
    }
  }
}

// ---------------- 谱系 ----------------

interface EdgeRow {
  id: string
  from_type: GenealogyEdgeRecord['fromType']
  from_id: string
  to_type: GenealogyEdgeRecord['toType']
  to_id: string
  edge_kind: GenealogyEdgeRecord['edgeKind']
  quantity: string
  uom_id: string
  uom_code: string
  measurement_basis: string
  conversion_revision_id: string | null
  command_receipt_id: string | null
  business_time: Date | string
  plant_id: string
  enterprise_id: string
  created_at: Date | string
}

function mapEdge(r: EdgeRow): GenealogyEdgeRecord {
  return {
    id: r.id,
    fromType: r.from_type,
    fromId: r.from_id,
    toType: r.to_type,
    toId: r.to_id,
    edgeKind: r.edge_kind,
    quantity: r.quantity,
    uomId: r.uom_id,
    uomCode: r.uom_code,
    measurementBasis: r.measurement_basis,
    conversionRevisionId: r.conversion_revision_id,
    commandReceiptId: r.command_receipt_id,
    businessTime: iso(r.business_time),
    plantId: r.plant_id,
    enterpriseId: r.enterprise_id,
    createdAt: iso(r.created_at),
  }
}

export class PgGenealogyRepository implements GenealogyRepository {
  constructor(private readonly client: SqlClient) {}

  async insertEdge(edge: NewGenealogyEdge): Promise<GenealogyEdgeRecord> {
    const r = await typedQuery<EdgeRow>(this.client, 
      `INSERT INTO genealogy_edge
         (from_type, from_id, to_type, to_id, edge_kind, quantity, uom_id, uom_code,
          measurement_basis, conversion_revision_id, command_receipt_id, business_time,
          plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        edge.fromType,
        edge.fromId,
        edge.toType,
        edge.toId,
        edge.edgeKind,
        edge.quantity,
        edge.uomId,
        edge.uomCode,
        edge.measurementBasis,
        edge.conversionRevisionId ?? null,
        edge.commandReceiptId ?? null,
        edge.businessTime,
        edge.plantId,
        edge.enterpriseId,
        edge.createdBy ?? null,
      ],
    )
    return mapEdge(r.rows[0]!)
  }

  async listForward(fromType: string, fromId: string): Promise<GenealogyEdgeRecord[]> {
    const r = await typedQuery<EdgeRow>(this.client, 
      `SELECT * FROM genealogy_edge WHERE from_type = $1 AND from_id = $2 ORDER BY created_at`,
      [fromType, fromId],
    )
    return r.rows.map(mapEdge)
  }

  async listBackward(toType: string, toId: string): Promise<GenealogyEdgeRecord[]> {
    const r = await typedQuery<EdgeRow>(this.client, 
      `SELECT * FROM genealogy_edge WHERE to_type = $1 AND to_id = $2 ORDER BY created_at`,
      [toType, toId],
    )
    return r.rows.map(mapEdge)
  }
}

// ---------------- 命令回执引用 ----------------

export class PgCommandReceiptRefRepository implements CommandReceiptRefRepository {
  constructor(private readonly client: SqlClient) {}

  async findIdByKey(enterpriseId: string, commandType: string, operationId: string): Promise<string | null> {
    const r = await typedQuery<{ id: string }>(this.client, 
      `SELECT id FROM command_receipt
       WHERE enterprise_id = $1 AND command_type = $2 AND operation_id = $3`,
      [enterpriseId, commandType, operationId],
    )
    return r.rows[0]?.id ?? null
  }
}
