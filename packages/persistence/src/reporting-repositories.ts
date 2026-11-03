// [L0-整合标记] 跨包类型导入（type-only，编译期擦除）：application/persistence/contracts 的
// 包名入口（src/index.ts，共享文件不改动）均未导出 reporting 面，暂走 dist 相对（构建顺序由
// workspace 拓扑保证）；L0 整合步把端口并入各包 index 后改包名导入（同 reverse-repositories 先例）。
import type {
  AxisQueryFilter,
  AxisQueryRepository,
  ExportAuditWriter,
  FactSetResult,
  MetricDefinitionRepository,
  NewMetricDefinition,
  ReportOutputRow,
  ReportSummaryFilter,
  ReportSummaryRepository,
  ShiftSnapshotFilter,
  ShiftSnapshotRepository,
  ShiftSnapshotUpsert,
  SnapshotFactCalculator,
  StockStatFilter,
  StockStatProjectionRepository,
  StockStatSourceRepository,
  StockStatSourceRow,
  TraceRepository,
} from '@cadenza/application'
import type {
  AxisQueryRowDto,
  MetricDefinitionDto,
  ShiftSnapshotDto,
  StockStatRowDto,
  TraceResultDto,
} from '@cadenza/contracts'
import type { SqlClient } from './sql-client'

/**
 * reporting 域仓储的 PostgreSQL 实现（implements application 端口；0016 投影表 +
 * 既有域业务表的只读聚合查询）。本域只读业务事实：除 0016 三投影表与 audit_entry
 * 导出审计行外，对既有业务表零写入（RP-07/RP-18：重建不重新执行报工或扣库存）。
 *
 * 列名均按实际迁移核对（0001/0003/0004/0005/0008/0009）：order_operation 无
 * production_dept_name（经 org_node 取名）、report_output 无 sales_line_no（无权威列，
 * 返回 null 不冒充）、stock_balance 自带 location_code/owner_name。
 */

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

function dateStr(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    // pg date 列由驱动按本地时区零点解析为 Date：取本地日期分量（toISOString 会因
    // UTC 偏移回退/前进一天——东八区实测回退，班次日/生效区间均受影响）
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(value).slice(0, 10)
}

function fixed4(value: unknown): string {
  if (value === null || value === undefined) return '0.0000'
  return Number(value).toFixed(4)
}

function fixed4OrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return Number(value).toFixed(4)
}

/**
 * RP-03 英尺数：q ÷ 0.3048 **定点截取** 4 位（不四舍五入；与 domain feet-rules 同口径：
 * q 为 ≤4 位小数十进制字符串，q_int ÷ 3048 即精确截取，无浮点误差）。数量列非负（表 CHECK）。
 */
function truncFeet4(quantity: string): string {
  const [intPartRaw, fracPart = ''] = quantity.split('.')
  const intPart = intPartRaw === '' ? '0' : intPartRaw
  const frac = (fracPart + '0000').slice(0, 4)
  const scaled = BigInt(`${intPart}${frac}`)
  const feetScaled = (scaled * 10_000n) / 3048n // 正数 BigInt 除法即向下截取
  return `${feetScaled / 10_000n}.${(feetScaled % 10_000n).toString().padStart(4, '0')}`
}

// ---------------- 库存统计投影（RP-01~RP-07 / RP-S1） ----------------

const PROJECTION_COLUMNS = `id, stat_kind, unit_no, lot_no, supplier_lot_no, material_id, material_code,
  material_name, material_type, color, spec, voltage, standard, order_no, operation_seq, operation_name,
  quantity, uom_id, uom_code, measurement_basis, stock_status, axis_status, report_warehouse_kind,
  finished_entry_status, customer_axis_nos, warehouse_code, warehouse_name, location_code, owner_name,
  inbound_date, outbound_date, plant_id, enterprise_id, created_at, created_by, updated_at, updated_by`

interface ProjectionRow {
  id: string
  stat_kind: 'purchase_receive' | 'production'
  unit_no: string
  lot_no: string | null
  supplier_lot_no: string | null
  material_id: string | null
  material_code: string
  material_name: string | null
  material_type: 1 | 2 | 3 | null
  color: string | null
  spec: string | null
  voltage: string | null
  standard: string | null
  order_no: string | null
  operation_seq: number | null
  operation_name: string | null
  quantity: string
  uom_id: string | null
  uom_code: string
  measurement_basis: string
  stock_status: string | null
  axis_status: string
  report_warehouse_kind: 'WAREHOUSE' | 'LINE_SIDE' | null
  finished_entry_status: 'entered_warehouse' | 'not_entered' | null
  customer_axis_nos: string[] | null
  warehouse_code: string | null
  warehouse_name: string | null
  location_code: string | null
  owner_name: string | null
  inbound_date: Date | string | null
  outbound_date: Date | string | null
  plant_id: string
  enterprise_id: string
  created_at: Date | string
}

function mapProjectionRow(r: ProjectionRow): StockStatRowDto {
  // RP-03：仅展示列——基本单位为米才换算（trunc4(数量÷0.3048)），非米 null（显示 `-`）
  const feet = r.uom_code.trim().toUpperCase() === 'M' ? truncFeet4(fixed4(r.quantity)) : null
  return {
    statId: r.id,
    statKind: r.stat_kind,
    statKindLabel: r.stat_kind === 'purchase_receive' ? '采购收货码' : '生产码',
    unitNo: r.unit_no,
    lotNo: r.lot_no,
    supplierLotNo: r.supplier_lot_no,
    materialCode: r.material_code,
    materialName: r.material_name,
    materialType: r.material_type,
    color: r.color,
    spec: r.spec,
    voltage: r.voltage,
    standard: r.standard,
    orderNo: r.order_no,
    operationSeq: r.operation_seq,
    operationName: r.operation_name,
    quantity: fixed4(r.quantity),
    uomCode: r.uom_code,
    measurementBasis: r.measurement_basis,
    feetQuantity: feet,
    stockStatus: r.stock_status,
    stockStatusLabel: r.stock_status === null ? null : (LEGACY_STOCK_STATUS_LABELS[r.stock_status] ?? r.stock_status),
    axisStatus: r.axis_status,
    axisStatusLabel: AXIS_STATUS_LABELS[r.axis_status] ?? r.axis_status,
    reportWarehouseKind: r.report_warehouse_kind,
    finishedEntryStatus: r.finished_entry_status,
    finishedEntryStatusLabel:
      r.finished_entry_status === null ? null : (FINISHED_ENTRY_LABELS[r.finished_entry_status] ?? r.finished_entry_status),
    customerAxisNos: r.customer_axis_nos ?? [],
    warehouseCode: r.warehouse_code,
    warehouseName: r.warehouse_name,
    locationCode: r.location_code,
    ownerName: r.owner_name,
    inboundDate: isoOrNull(r.inbound_date),
    outboundDate: isoOrNull(r.outbound_date),
    plantId: r.plant_id,
    createdAt: iso(r.created_at),
  }
}

// 标签字典（与 domain reporting 面同口径；此处为映射层内联常量，L0 整合后可改引 domain 导出）
const LEGACY_STOCK_STATUS_LABELS: Readonly<Record<string, string>> = {
  normal: '正常',
  scrap: '报废',
  frozen: '冻结',
  pending_inspection: '待检',
  external: '外发',
  unqualified: '不合格',
}
const AXIS_STATUS_LABELS: Readonly<Record<string, string>> = {
  in_stock: '在库',
  in_production: '在制',
  in_transit: '在途',
  shipped: '已发运',
  exhausted: '已耗尽',
}
const FINISHED_ENTRY_LABELS: Readonly<Record<string, string>> = {
  entered_warehouse: '成品已入库',
  not_entered: '成品未入库',
}

export class PgStockStatProjectionRepository implements StockStatProjectionRepository {
  constructor(private readonly client: SqlClient) {}

  /** RP-07/S1：全量重建（同事务 DELETE 范围 + 批量 INSERT；重算覆盖同键不产生重复行）。 */
  async replaceAll(
    rows: readonly StockStatSourceRow[],
    options: { plantId?: string; actor: string },
  ): Promise<number> {
    if (options.plantId !== undefined) {
      await this.client.query('DELETE FROM stock_stat_projection WHERE plant_id = $1', [options.plantId])
    } else {
      await this.client.query('DELETE FROM stock_stat_projection')
    }
    for (const row of rows) {
      await this.client.query(
        `INSERT INTO stock_stat_projection (stat_kind, unit_no, lot_no, supplier_lot_no, material_id,
           material_code, material_name, material_type, color, spec, voltage, standard, order_no,
           operation_seq, operation_name, quantity, uom_id, uom_code, measurement_basis, stock_status,
           axis_status, report_warehouse_kind, finished_entry_status, customer_axis_nos, warehouse_code,
           warehouse_name, location_code, owner_name, inbound_date, outbound_date, plant_id, enterprise_id,
           created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
           $25,$26,$27,$28,$29,$30,$31,$32,$33,$33)`,
        [
          row.statKind,
          row.unitNo,
          row.lotNo,
          row.supplierLotNo,
          row.materialId,
          row.materialCode,
          row.materialName,
          row.materialType,
          row.color,
          row.spec,
          row.voltage,
          row.standard,
          row.orderNo,
          row.operationSeq,
          row.operationName,
          row.quantity,
          row.uomId,
          row.uomCode,
          row.measurementBasis,
          row.stockStatus,
          row.axisStatus,
          row.reportWarehouseKind,
          deriveFinishedEntry(row.stockStatus, row.reportWarehouseKind),
          row.customerAxisNos,
          row.warehouseCode,
          row.warehouseName,
          row.locationCode,
          row.ownerName,
          row.inboundDate === null ? null : new Date(row.inboundDate),
          row.outboundDate === null ? null : new Date(row.outboundDate),
          row.plantId,
          row.enterpriseId,
          options.actor,
        ],
      )
    }
    return rows.length
  }

  async listPaged(filter: StockStatFilter): Promise<{ items: StockStatRowDto[]; total: number }> {
    const where = this.buildWhere(filter)
    const count = await this.client.query(
      `SELECT count(*)::text AS total FROM stock_stat_projection ${where.sql}`,
      where.args,
    )
    const rows = await this.client.query(
      `SELECT ${PROJECTION_COLUMNS} FROM stock_stat_projection ${where.sql}
       ORDER BY created_at DESC, id LIMIT $${where.args.length + 1} OFFSET $${where.args.length + 2}`,
      [...where.args, filter.pageSize, (filter.page - 1) * filter.pageSize],
    )
    return { items: rows.rows.map(mapProjectionRow), total: Number(count.rows[0]?.total ?? 0) }
  }

  async listByIds(ids: readonly string[]): Promise<StockStatRowDto[]> {
    if (ids.length === 0) return []
    const rows = await this.client.query(
      `SELECT ${PROJECTION_COLUMNS} FROM stock_stat_projection WHERE id = ANY($1::uuid[])`,
      [[...ids]],
    )
    return rows.rows.map(mapProjectionRow)
  }

  /** RP-04 后半：成品入库状态筛选 → 同时限定库存状态=正常并按报工仓库类型匹配。 */
  private buildWhere(filter: StockStatFilter): { sql: string; args: unknown[] } {
    const clauses: string[] = []
    const args: unknown[] = []
    if (filter.plantIds !== null) {
      clauses.push(`plant_id = ANY($${args.length + 1}::uuid[])`)
      args.push(filter.plantIds)
    }
    if (filter.plantId !== undefined && filter.plantId !== '') {
      clauses.push(`plant_id = $${args.length + 1}::uuid`)
      args.push(filter.plantId)
    }
    if (filter.unitNoLike !== undefined) {
      clauses.push(`unit_no ILIKE $${args.length + 1}`)
      args.push(`%${filter.unitNoLike}%`)
    }
    if (filter.customerAxisLike !== undefined) {
      clauses.push(`EXISTS (SELECT 1 FROM unnest(customer_axis_nos) AS c WHERE c ILIKE $${args.length + 1})`)
      args.push(`%${filter.customerAxisLike}%`)
    }
    if (filter.stockStatus !== undefined && filter.stockStatus !== '') {
      clauses.push(`stock_status = $${args.length + 1}`)
      args.push(filter.stockStatus)
    }
    if (filter.finishedEntryStatus !== undefined) {
      // RP-04：筛选时同时限定库存状态=正常，并按报工仓库类型匹配（已入库→仓库、未入库→线边仓）
      clauses.push(`stock_status = 'normal' AND finished_entry_status = $${args.length + 1}`)
      args.push(filter.finishedEntryStatus)
    }
    return { sql: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`, args }
  }
}

/** RP-04 推导（SQL 侧等价：投影行落库时固化；查询筛选同语义在 buildWhere）。 */
function deriveFinishedEntry(
  stockStatus: string | null,
  warehouseKind: 'WAREHOUSE' | 'LINE_SIDE' | null,
): 'entered_warehouse' | 'not_entered' | null {
  if (stockStatus !== 'normal') return null
  if (warehouseKind === 'WAREHOUSE') return 'entered_warehouse'
  if (warehouseKind === 'LINE_SIDE') return 'not_entered'
  return null
}

// ---------------- 投影重建数据源（既有域业务事实只读聚合；[L0-整合标记] 跨包读取由本文件承载） ----------------

/**
 * RP-01 两类汇总口径聚合（只读业务事实）：
 * - 采购收货码（material_lot.kind='purchase'）：华通轴号+入库批次号+厂家批次+牌号/线径 ——
 *   同键多余额行（多库位/多所有者）按汇总键聚合为一条（sum(quantity)）；
 * - 其余码：华通轴号+订单+（有则）订单工序 —— 经 report_output.stock_unit_id →
 *   production_report（剔除 deleted）→ production_order/order_operation 取全部 DISTINCT 键
 *   （一个单元多张订单/工序报工按各自键分多行，非只取最新）；INNER JOIN 使键不完整的
 *   无报工生产单元不出投影（RP-01 生产码键含订单）。
 * 状态：legacy 6 值取 stock_balance.legacy_status（可空并存标注 RP-02）；
 * 报工仓库类型取产出报工目标库位所属仓 warehouse_type（RP-04 推导输入）。
 * customer_axis_nos 用标量子查询取（避免 JOIN 行倍增导致 sum 重复计数）；
 * 入库/出库日期为展示列：取 receive / issue|transfer_out 流水最大业务时间。
 */
const STOCK_STAT_REPORT_CTX_SQL = `
  WITH report_ctx AS (
    SELECT DISTINCT ro.stock_unit_id, po.order_no, pr.operation_seq, oo.operation_name,
           w.warehouse_type AS report_warehouse_kind,
           w.code AS warehouse_code, w.name AS warehouse_name
    FROM report_output ro
    JOIN production_report pr ON pr.id = ro.report_id AND pr.status <> 'deleted'
    JOIN production_order po ON po.id = pr.order_id
    LEFT JOIN order_operation oo ON oo.id = pr.order_operation_id
    LEFT JOIN storage_location sl ON sl.id = ro.target_location_id
    LEFT JOIN warehouse w ON w.id = sl.warehouse_id
    WHERE ro.stock_unit_id IS NOT NULL
  )
`

const CUSTOMER_AXIS_NOS_SELECT = `
  (SELECT array_agg(DISTINCT cs2.customer_ref) FROM customer_segment cs2
    WHERE cs2.unit_id = ub.id AND cs2.status IN ('allocated','reallocated')
      AND cs2.customer_ref IS NOT NULL) AS customer_axis_nos`

const INBOUND_DATE_SELECT = `
  (SELECT max(st.business_time) FROM stock_transaction st
    WHERE st.unit_id = ub.id AND st.movement_kind = 'receive') AS inbound_date`

const OUTBOUND_DATE_SELECT = `
  (SELECT max(st.business_time) FROM stock_transaction st
    WHERE st.unit_id = ub.id AND st.movement_kind IN ('issue','transfer_out')) AS outbound_date`

export class PgStockStatSourceRepository implements StockStatSourceRepository {
  constructor(private readonly client: SqlClient) {}

  async collectStockStatSource(plantId?: string): Promise<StockStatSourceRow[]> {
    // 采购收货码（按汇总键聚合；plantId 过滤条件随两分支各自 WHERE 插值）
    const purchase = await this.client.query(
      `${STOCK_STAT_REPORT_CTX_SQL}
       SELECT 'purchase_receive'::text AS stat_kind, ub.unit_no, ml.lot_no, ml.supplier_lot_no,
         ub.material_id, ub.material_code, m.name AS material_name, m.material_type, m.color, m.spec,
         m.voltage, m.standard, NULL::text AS order_no, NULL::integer AS operation_seq,
         NULL::text AS operation_name, sum(bb.quantity) AS quantity, ub.uom_id, ub.uom_code,
         max(bb.measurement_basis) AS measurement_basis, max(bb.legacy_status) AS stock_status,
         ub.status AS axis_status, NULL::text AS report_warehouse_kind,
         ${CUSTOMER_AXIS_NOS_SELECT},
         NULL::text AS warehouse_code, NULL::text AS warehouse_name, NULL::text AS location_code,
         max(bb.owner_name) AS owner_name, ${INBOUND_DATE_SELECT}, ${OUTBOUND_DATE_SELECT},
         ub.plant_id, ub.enterprise_id
       FROM inventory_unit ub
       JOIN material_lot ml ON ml.id = ub.lot_id AND ml.kind = 'purchase'
       LEFT JOIN material m ON m.id = ub.material_id
       JOIN stock_balance bb ON bb.unit_id = ub.id AND bb.status = 'active'
       ${plantId === undefined ? '' : 'WHERE ub.plant_id = $1'}
       GROUP BY ub.id, ub.unit_no, ml.lot_no, ml.supplier_lot_no, ub.material_id, ub.material_code,
         ub.status, ub.plant_id, ub.enterprise_id, ub.uom_id, ub.uom_code,
         m.name, m.material_type, m.color, m.spec, m.voltage, m.standard`,
      plantId === undefined ? [] : [plantId],
    )
    // 其余码（生产来源：经产出报工挂订单+工序分键；多余额行按键聚合）
    const production = await this.client.query(
      `${STOCK_STAT_REPORT_CTX_SQL}
       SELECT 'production'::text AS stat_kind, ub.unit_no, ml.lot_no, ml.supplier_lot_no,
         ub.material_id, ub.material_code, m.name AS material_name, m.material_type, m.color, m.spec,
         m.voltage, m.standard, rc.order_no, rc.operation_seq, rc.operation_name,
         sum(bb.quantity) AS quantity, ub.uom_id, ub.uom_code,
         max(bb.measurement_basis) AS measurement_basis, max(bb.legacy_status) AS stock_status,
         ub.status AS axis_status, rc.report_warehouse_kind,
         ${CUSTOMER_AXIS_NOS_SELECT},
         rc.warehouse_code, rc.warehouse_name, max(bb.location_code) AS location_code,
         max(bb.owner_name) AS owner_name, ${INBOUND_DATE_SELECT}, ${OUTBOUND_DATE_SELECT},
         ub.plant_id, ub.enterprise_id
       FROM inventory_unit ub
       JOIN material_lot ml ON ml.id = ub.lot_id AND ml.kind <> 'purchase'
       LEFT JOIN material m ON m.id = ub.material_id
       JOIN report_ctx rc ON rc.stock_unit_id = ub.id
       JOIN stock_balance bb ON bb.unit_id = ub.id AND bb.status = 'active'
       ${plantId === undefined ? '' : 'WHERE ub.plant_id = $1'}
       GROUP BY ub.id, ub.unit_no, ml.lot_no, ml.supplier_lot_no, ub.material_id, ub.material_code,
         ub.status, ub.plant_id, ub.enterprise_id, ub.uom_id, ub.uom_code,
         m.name, m.material_type, m.color, m.spec, m.voltage, m.standard,
         rc.order_no, rc.operation_seq, rc.operation_name, rc.report_warehouse_kind,
         rc.warehouse_code, rc.warehouse_name`,
      plantId === undefined ? [] : [plantId],
    )
    const toRow = (r: Record<string, unknown>): StockStatSourceRow => ({
      statKind: r['stat_kind'] as 'purchase_receive' | 'production',
      unitNo: String(r['unit_no']),
      lotNo: (r['lot_no'] as string | null) ?? null,
      supplierLotNo: (r['supplier_lot_no'] as string | null) ?? null,
      materialId: (r['material_id'] as string | null) ?? null,
      materialCode: String(r['material_code']),
      materialName: (r['material_name'] as string | null) ?? null,
      materialType: (r['material_type'] as 1 | 2 | 3 | null) ?? null,
      color: (r['color'] as string | null) ?? null,
      spec: (r['spec'] as string | null) ?? null,
      voltage: (r['voltage'] as string | null) ?? null,
      standard: (r['standard'] as string | null) ?? null,
      orderNo: (r['order_no'] as string | null) ?? null,
      operationSeq: (r['operation_seq'] as number | null) ?? null,
      operationName: (r['operation_name'] as string | null) ?? null,
      quantity: fixed4(r['quantity']),
      uomId: (r['uom_id'] as string | null) ?? null,
      uomCode: String(r['uom_code'] ?? ''),
      measurementBasis: String(r['measurement_basis'] ?? 'nominal'),
      stockStatus: (r['stock_status'] as string | null) ?? null,
      axisStatus: String(r['axis_status']),
      reportWarehouseKind: (r['report_warehouse_kind'] as 'WAREHOUSE' | 'LINE_SIDE' | null) ?? null,
      customerAxisNos: ((r['customer_axis_nos'] as string[] | null) ?? []).filter((c) => c !== null),
      warehouseCode: (r['warehouse_code'] as string | null) ?? null,
      warehouseName: (r['warehouse_name'] as string | null) ?? null,
      locationCode: (r['location_code'] as string | null) ?? null,
      ownerName: (r['owner_name'] as string | null) ?? null,
      inboundDate: isoOrNull(r['inbound_date'] as Date | string | null),
      outboundDate: isoOrNull(r['outbound_date'] as Date | string | null),
      plantId: String(r['plant_id']),
      enterpriseId: String(r['enterprise_id']),
    })
    return [...purchase.rows, ...production.rows].map(toRow)
  }
}

// ---------------- 轴查询（RP-08~RP-11 实时跨域投影） ----------------

/**
 * 只读跨表实时投影（RP-11：各状态列取自各自权威表当前值）。
 * - 报工口径（RP-09/domain mapAxisReportStatus 同语义）：非 deleted 报工存在且全部
 *   submitted → 已报工；否则未报工；采购来源固定 `-`（不适用）；
 * - 工序生产部门名经 org_node（order_operation 只有 production_dept_id）；
 * - sales_line_no：无权威列（report_output 无此列），返回 null 不冒充（GAP 待圈定）；
 * - 入库人员/时间：receive 流水最新行的 created_by/business_time（IT-37 分列口径）。
 * 子查询输出全部过滤列（外层 WHERE 只引用本层别名，不再引用内层别名）。
 */
const AXIS_QUERY_SQL = `
  SELECT u.id AS unit_id, u.unit_no, u.status AS axis_status, u.plant_id, u.created_at,
         m.code AS material_code, m.name AS material_name,
         m.material_type, m.spec, m.color, m.qc_flag,
         ml.lot_no, ml.kind AS lot_kind,
         b.quantity, b.uom_code, b.quality_status, b.legacy_status, b.location_code,
         w.name AS warehouse_name,
         cb.carrier_code,
         cs.customer_ref AS customer_axis_no,
         EXISTS (SELECT 1 FROM reservation r WHERE r.unit_id = u.id AND r.status = 'active') AS locked,
         EXISTS (SELECT 1 FROM quality_hold h WHERE h.inventory_unit_id = u.id AND h.status = 'active'
                 AND h.hold_kind = 'unqualified') AS unqualified_hold,
         seg.length_end - seg.length_start AS segment_length,
         latest_ro.order_no, latest_ro.sales_order_no, latest_ro.operator_login,
         latest_ro.business_time AS reported_at, latest_ro.operation_name AS workshop_name,
         rep_stat.n > 0 AS has_report,
         rep_stat.n > 0 AND rep_stat.unsubmitted = 0 AS all_submitted,
         inbound.business_time AS inbound_at, inbound.created_by AS inbound_user
  FROM inventory_unit u
  LEFT JOIN material m ON m.id = u.material_id
  LEFT JOIN material_lot ml ON ml.id = u.lot_id
  LEFT JOIN LATERAL (
    SELECT b2.quantity, b2.uom_code, b2.quality_status, b2.legacy_status, b2.location_id, b2.location_code
    FROM stock_balance b2 WHERE b2.unit_id = u.id AND b2.status = 'active'
    ORDER BY b2.quantity DESC LIMIT 1
  ) b ON true
  LEFT JOIN storage_location loc ON loc.id = b.location_id
  LEFT JOIN warehouse w ON w.id = loc.warehouse_id
  LEFT JOIN LATERAL (
    SELECT c.carrier_code FROM carrier_binding cb2
    JOIN carrier c ON c.id = cb2.carrier_id
    WHERE cb2.unit_id = u.id AND cb2.effective_to IS NULL
    ORDER BY cb2.effective_from DESC LIMIT 1
  ) cb ON true
  LEFT JOIN LATERAL (
    SELECT cs2.customer_ref FROM customer_segment cs2
    WHERE cs2.unit_id = u.id AND cs2.status IN ('allocated','reallocated')
    ORDER BY cs2.created_at DESC LIMIT 1
  ) cs ON true
  LEFT JOIN LATERAL (
    SELECT ms.length_start, ms.length_end FROM material_segment ms
    WHERE ms.unit_id = u.id ORDER BY ms.seq_no DESC LIMIT 1
  ) seg ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE epr.status <> 'submitted')::int AS unsubmitted
    FROM report_output ro
    JOIN production_report epr ON epr.id = ro.report_id AND epr.status <> 'deleted'
    WHERE ro.stock_unit_id = u.id
  ) rep_stat ON true
  LEFT JOIN LATERAL (
    SELECT po.order_no, po.sales_order_no, epr.operator_login, epr.business_time,
           oo2.operation_name, dn.name AS production_dept_name
    FROM report_output ro3
    JOIN production_report epr ON epr.id = ro3.report_id AND epr.status <> 'deleted'
    JOIN production_order po ON po.id = epr.order_id
    LEFT JOIN order_operation oo2 ON oo2.id = epr.order_operation_id
    LEFT JOIN org_node dn ON dn.id = oo2.production_dept_id
    WHERE ro3.stock_unit_id = u.id
    ORDER BY epr.business_time DESC LIMIT 1
  ) latest_ro ON true
  LEFT JOIN LATERAL (
    SELECT st.business_time, st.created_by FROM stock_transaction st
    WHERE st.unit_id = u.id AND st.movement_kind = 'receive'
    ORDER BY st.business_time DESC LIMIT 1
  ) inbound ON true
`

interface AxisRow {
  unit_id: string
  unit_no: string
  axis_status: 'in_stock' | 'in_production' | 'in_transit' | 'shipped' | 'exhausted'
  plant_id: string
  created_at: Date | string
  material_code: string | null
  material_name: string | null
  material_type: 1 | 2 | 3 | null
  spec: string | null
  color: string | null
  qc_flag: number | null
  lot_no: string | null
  lot_kind: 'purchase' | 'production' | null
  quantity: string | null
  uom_code: string | null
  quality_status: 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect' | null
  legacy_status: string | null
  location_code: string | null
  warehouse_name: string | null
  carrier_code: string | null
  customer_axis_no: string | null
  locked: boolean
  unqualified_hold: boolean
  segment_length: string | null
  order_no: string | null
  sales_order_no: string | null
  operator_login: string | null
  reported_at: Date | string | null
  workshop_name: string | null
  has_report: boolean
  all_submitted: boolean
  inbound_at: Date | string | null
  inbound_user: string | null
}

function mapAxisRow(r: AxisRow): AxisQueryRowDto {
  // RP-08 字典映射（domain axis-rules 同口径；映射层内联，L0 整合后可改引 domain 导出）
  const inbound: AxisQueryRowDto['inboundStatus'] =
    r.axis_status === 'in_stock'
      ? 'in_stock'
      : r.axis_status === 'shipped' || r.axis_status === 'exhausted'
        ? 'shipped'
        : 'not_in'
  const qcStatus: AxisQueryRowDto['qcStatus'] =
    r.qc_flag === 0
      ? 'exempt'
      : r.quality_status === 'qualified'
        ? 'qualified'
        : r.quality_status === 'unqualified'
          ? 'unqualified'
          : 'pending'
  // RP-09：采购来源固定 `-`；生产来源=全部非删除报工已提交 → 已报工（mapAxisReportStatus 同语义）
  const reportStatus: AxisQueryRowDto['reportStatus'] =
    r.lot_kind === 'purchase'
      ? 'not_applicable'
      : r.has_report && r.all_submitted
        ? 'reported'
        : 'not_reported'
  const inboundLabels: Record<string, string> = {
    not_in: '未入库',
    in_stock: '在库中',
    shipped: '已出库',
    returned: '已退货',
    receipt_unconfirmed: '入库未确认',
    issue_unconfirmed: '出库未确认',
  }
  const qcLabels: Record<string, string> = { pending: '待质检', qualified: '合格', exempt: '免检', unqualified: '不合格' }
  const reportLabels: Record<string, string> = { not_reported: '未报工', reported: '已报工', not_applicable: '-' }
  const saleStatus = r.customer_axis_no !== null && r.customer_axis_no !== undefined ? 'sold' : 'unsold'
  const saleLabels: Record<string, string> = { unsold: '未销售', sold: '已销售' }
  const suspect = r.quality_status === 'suspect' ? 'suspect' : 'normal'
  const suspectLabels: Record<string, string> = { normal: '正常', suspect: '存疑' }
  const lockStatus = r.locked ? 'locked' : 'unlocked'
  const lockLabels: Record<string, string> = { unlocked: '未锁定', locked: '锁定' }
  const abnormal = r.unqualified_hold ? 'pending_handle' : 'none'
  const abnormalLabels: Record<string, string> = { none: '无异常', pending_handle: '异常未处理' }
  return {
    unitId: r.unit_id,
    unitNo: r.unit_no,
    inboundStatus: inbound,
    inboundStatusLabel: inboundLabels[inbound] ?? inbound,
    materialCode: r.material_code ?? '',
    materialName: r.material_name,
    materialType: r.material_type,
    spec: r.spec,
    color: r.color,
    lotNo: r.lot_no,
    quantity: fixed4OrNull(r.quantity),
    uomCode: r.uom_code,
    warehouseName: r.warehouse_name,
    locationCode: r.location_code,
    carrierCode: r.carrier_code,
    qcRequired: r.qc_flag !== 0,
    suspectStatus: suspect,
    suspectStatusLabel: suspectLabels[suspect] ?? suspect,
    finishedAbnormalStatus: abnormal,
    finishedAbnormalStatusLabel: abnormalLabels[abnormal] ?? abnormal,
    qcStatus,
    qcStatusLabel: qcLabels[qcStatus] ?? qcStatus,
    lockStatus,
    lockStatusLabel: lockLabels[lockStatus] ?? lockStatus,
    saleStatus,
    saleStatusLabel: saleLabels[saleStatus] ?? saleStatus,
    inboundDate: isoOrNull(r.inbound_at),
    inboundUser: r.inbound_user ?? null,
    salesOrderNo: r.sales_order_no,
    salesLineNo: null, // 无权威列（report_output 无 sales_line_no），不冒充
    orderNo: r.order_no,
    reportedBy: r.operator_login ?? null,
    customerAxisNo: r.customer_axis_no ?? null,
    segmentLength: fixed4OrNull(r.segment_length),
    virtualAxisNo: null, // P1 无权威列，通道待 Owner 圈定——不冒充
    reportStatus,
    reportStatusLabel: reportLabels[reportStatus] ?? reportStatus,
    reportedAt: isoOrNull(r.reported_at),
    workshopName: r.workshop_name,
    plantId: r.plant_id,
    createdAt: iso(r.created_at),
  }
}

export class PgAxisQueryRepository implements AxisQueryRepository {
  constructor(private readonly client: SqlClient) {}

  async listPaged(filter: AxisQueryFilter): Promise<{ items: AxisQueryRowDto[]; total: number }> {
    const clauses: string[] = []
    const args: unknown[] = []
    const add = (sql: string, arg: unknown): void => {
      clauses.push(sql.replace('?', `$${args.length + 1}`))
      args.push(arg)
    }
    const addRaw = (sql: string): void => {
      clauses.push(sql)
    }
    if (filter.plantIds !== null) add('axis.plant_id = ANY(?::uuid[])', filter.plantIds)
    if (filter.plantId !== undefined && filter.plantId !== '') add('axis.plant_id = ?::uuid', filter.plantId)
    if (filter.unitNoLike !== undefined) add('axis.unit_no ILIKE ?', `%${filter.unitNoLike}%`)
    if (filter.warehouseName !== undefined && filter.warehouseName !== '') add('axis.warehouse_name = ?', filter.warehouseName)
    if (filter.carrierLike !== undefined) add('axis.carrier_code ILIKE ?', `%${filter.carrierLike}%`)
    if (filter.inboundStatus !== undefined && filter.inboundStatus !== '') {
      // RP-08 入库状态字典 → 五状态轴等价过滤（映射同 mapAxisRow；returned/两未确认值暂无
      // 权威通道不可命中——不冒充，恒空集）
      const axisStatuses =
        filter.inboundStatus === 'in_stock'
          ? ['in_stock']
          : filter.inboundStatus === 'shipped'
            ? ['shipped', 'exhausted']
            : filter.inboundStatus === 'not_in'
              ? ['in_production', 'in_transit']
              : ['__none__']
      add('axis.axis_status = ANY(?)', axisStatuses)
    }
    if (filter.qcStatus !== undefined && filter.qcStatus !== '') {
      if (filter.qcStatus === 'exempt') addRaw('axis.qc_flag = 0')
      else if (filter.qcStatus === 'qualified') add('axis.quality_status = ?', 'qualified')
      else if (filter.qcStatus === 'unqualified') add('axis.quality_status = ?', 'unqualified')
      else addRaw("(axis.quality_status IS NULL OR axis.quality_status IN ('pending_inspection','suspect'))")
    }
    if (filter.saleStatus === 'sold') addRaw('axis.customer_axis_no IS NOT NULL')
    else if (filter.saleStatus === 'unsold') addRaw('axis.customer_axis_no IS NULL')
    if (filter.salesOrderNoLike !== undefined) add('axis.sales_order_no ILIKE ?', `%${filter.salesOrderNoLike}%`)
    if (filter.orderNoLike !== undefined) add('axis.order_no ILIKE ?', `%${filter.orderNoLike}%`)
    if (filter.reporterLike !== undefined) add('axis.operator_login ILIKE ?', `%${filter.reporterLike}%`)
    if (filter.customerAxisLike !== undefined) add('axis.customer_axis_no ILIKE ?', `%${filter.customerAxisLike}%`)
    if (filter.reportStatus !== undefined && filter.reportStatus !== '') {
      // RP-09：按报工状态筛选时不包含采购来源轴（NULL lot_kind 非采购来源，保留）
      addRaw("COALESCE(axis.lot_kind, '') <> 'purchase'")
      if (filter.reportStatus === 'reported') addRaw('axis.has_report AND axis.all_submitted')
      else if (filter.reportStatus === 'not_reported') addRaw('NOT (axis.has_report AND axis.all_submitted)')
      else addRaw('TRUE = FALSE')
    }
    if (filter.reportedFrom !== undefined) add('axis.reported_at >= ?::timestamptz', filter.reportedFrom)
    if (filter.reportedTo !== undefined) add('axis.reported_at <= ?::timestamptz', filter.reportedTo)
    if (filter.workshopName !== undefined && filter.workshopName !== '') add('axis.workshop_name = ?', filter.workshopName)
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const count = await this.client.query(
      `SELECT count(*)::text AS total FROM (${AXIS_QUERY_SQL}) axis ${where}`,
      args,
    )
    const rows = await this.client.query(
      `SELECT * FROM (${AXIS_QUERY_SQL}) axis ${where}
       ORDER BY axis.created_at DESC, axis.unit_id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, filter.pageSize, (filter.page - 1) * filter.pageSize],
    )
    return { items: rows.rows.map(mapAxisRow), total: Number(count.rows[0]?.total ?? 0) }
  }
}

// ---------------- 报工汇总（RP-12~RP-17） ----------------

const REPORT_OUTPUT_SQL = `
  SELECT pr.id AS report_id, pr.status, pr.review_status, pr.business_time, pr.shift_date,
         po.order_no, ro.line_no, ro.quantity, ro.qualified_qty, ro.uom_code,
         ro.stock_unit_id, u.unit_no, po.plant_id, po.enterprise_id, oo.production_dept_id
  FROM report_output ro
  JOIN production_report pr ON pr.id = ro.report_id
  JOIN production_order po ON po.id = pr.order_id
  LEFT JOIN order_operation oo ON oo.id = pr.order_operation_id
  LEFT JOIN inventory_unit u ON u.id = ro.stock_unit_id
`

interface ReportRow {
  report_id: string
  status: 'draft' | 'submitted' | 'deleted'
  review_status: 'pending_review' | 'auto_approved' | 'manual_approved'
  shift_date: Date | string
  order_no: string
  quantity: string
  qualified_qty: string | null
  uom_code: string
  stock_unit_id: string | null
  unit_no: string | null
}

function mapReportRow(r: ReportRow): ReportOutputRow {
  return {
    reportId: r.report_id,
    status: r.status,
    reviewStatus: r.review_status,
    stockUnitBound: r.stock_unit_id !== null,
    uomCode: r.uom_code,
    quantity: fixed4(r.quantity),
    qualifiedQty: fixed4OrNull(r.qualified_qty),
    unitNo: r.unit_no ?? null,
    historicalImport: false, // P1 无历史导入通道（结构性恒 false；通道引入后实数——RP-13 排除位）
    orderNo: r.order_no,
    shiftDate: dateStr(r.shift_date) ?? '',
  }
}

export class PgReportSummaryRepository implements ReportSummaryRepository {
  constructor(private readonly client: SqlClient) {}

  async listOutputRows(filter: ReportSummaryFilter): Promise<ReportOutputRow[]> {
    if (filter.reportIds !== null && filter.reportIds !== undefined && filter.reportIds.length === 0) {
      return [] // 未勾选：直接空（RP-12 未选显示 0 的服务端等价）
    }
    const clauses: string[] = [`pr.status <> 'deleted'`]
    const args: unknown[] = []
    if (filter.plantIds !== null) {
      clauses.push(`po.plant_id = ANY($${args.length + 1}::uuid[])`)
      args.push(filter.plantIds)
    }
    if (filter.plantId !== undefined && filter.plantId !== '') {
      clauses.push(`po.plant_id = $${args.length + 1}::uuid`)
      args.push(filter.plantId)
    }
    if (filter.orderNoLike !== undefined) {
      clauses.push(`po.order_no ILIKE $${args.length + 1}`)
      args.push(`%${filter.orderNoLike}%`)
    }
    if (filter.dateFrom !== undefined) {
      clauses.push(`pr.business_time >= $${args.length + 1}::timestamptz`)
      args.push(filter.dateFrom)
    }
    if (filter.dateTo !== undefined) {
      clauses.push(`pr.business_time < ($${args.length + 1}::date + interval '1 day')`)
      args.push(filter.dateTo)
    }
    if (filter.reportIds !== null && filter.reportIds !== undefined) {
      clauses.push(`pr.id = ANY($${args.length + 1}::uuid[])`)
      args.push([...filter.reportIds])
    }
    const rows = await this.client.query(
      `${REPORT_OUTPUT_SQL} WHERE ${clauses.join(' AND ')}`,
      args,
    )
    return rows.rows.map(mapReportRow)
  }

  async listPdaRows(filter: {
    plantIds: string[] | null
    plantId?: string
    deptPathPrefix?: string | null
    operatorUserId?: string | null
  }): Promise<ReportOutputRow[]> {
    const clauses: string[] = [`pr.status <> 'deleted'`]
    const args: unknown[] = []
    if (filter.plantIds !== null) {
      clauses.push(`po.plant_id = ANY($${args.length + 1}::uuid[])`)
      args.push(filter.plantIds)
    }
    if (filter.plantId !== undefined && filter.plantId !== '') {
      clauses.push(`po.plant_id = $${args.length + 1}::uuid`)
      args.push(filter.plantId)
    }
    // RP-13：部门范围含下级（org_node.path 前缀）
    if (filter.deptPathPrefix !== null && filter.deptPathPrefix !== undefined) {
      clauses.push(`oo.production_dept_id IN (
        SELECT onode.id FROM org_node onode WHERE onode.path LIKE $${args.length + 1})`)
      args.push(`${filter.deptPathPrefix}%`)
    }
    // RP-13：仅操作工角色时只算自己参与的（服务端以会话身份强制）
    if (filter.operatorUserId !== null && filter.operatorUserId !== undefined) {
      clauses.push(`pr.operator_user_id = $${args.length + 1}::uuid`)
      args.push(filter.operatorUserId)
    }
    const rows = await this.client.query(`${REPORT_OUTPUT_SQL} WHERE ${clauses.join(' AND ')}`, args)
    return rows.rows.map(mapReportRow)
  }
}

// ---------------- 指标定义（RP-19/RP-S3） ----------------

const DEFINITION_COLUMNS = `id, metric_key, family, version, caliber_version, numerator_fact_set,
  denominator_fact_set, uom_code, uom_mode, effective_from, effective_to, status, referenced,
  description, created_at`

interface DefinitionRow {
  id: string
  metric_key: string
  family: 'wip' | 'delivery' | 'yield' | 'loss'
  version: number
  caliber_version: string
  numerator_fact_set: Record<string, unknown>
  denominator_fact_set: Record<string, unknown> | null
  uom_code: string
  uom_mode: 'plain' | 'percent'
  effective_from: Date | string
  effective_to: Date | string | null
  status: 'draft' | 'active' | 'retired'
  referenced: boolean
  description: string | null
  created_at: Date | string
}

const FAMILY_LABELS: Record<string, string> = { wip: '在制', delivery: '交期', yield: '良率', loss: '损耗' }

function mapDefinitionRow(r: DefinitionRow): MetricDefinitionDto {
  return {
    id: r.id,
    metricKey: r.metric_key,
    family: r.family,
    familyLabel: FAMILY_LABELS[r.family] ?? r.family,
    version: r.version,
    caliberVersion: r.caliber_version,
    numeratorFactSet: { kind: String(r.numerator_fact_set['kind'] ?? '') },
    denominatorFactSet: r.denominator_fact_set === null ? null : { kind: String(r.denominator_fact_set['kind'] ?? '') },
    uomCode: r.uom_code,
    uomMode: r.uom_mode,
    effectiveFrom: dateStr(r.effective_from) ?? '',
    effectiveTo: dateStr(r.effective_to),
    status: r.status,
    referenced: r.referenced,
    description: r.description,
    createdAt: iso(r.created_at),
  }
}

export class PgMetricDefinitionRepository implements MetricDefinitionRepository {
  constructor(private readonly client: SqlClient) {}

  async insert(def: NewMetricDefinition): Promise<MetricDefinitionDto> {
    const r = await this.client.query(
      `INSERT INTO metric_definition_revision (metric_key, family, version, caliber_version,
         numerator_fact_set, denominator_fact_set, uom_code, uom_mode, effective_from, effective_to,
         status, description, plant_id, enterprise_id, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (metric_key, version) DO NOTHING
       RETURNING ${DEFINITION_COLUMNS}`,
      [
        def.metricKey,
        def.family,
        def.version,
        def.caliberVersion,
        JSON.stringify(def.numeratorFactSet),
        def.denominatorFactSet === null ? null : JSON.stringify(def.denominatorFactSet),
        def.uomCode,
        def.uomMode,
        def.effectiveFrom,
        def.effectiveTo,
        def.status,
        def.description,
        def.plantId,
        def.enterpriseId,
        def.createdBy,
      ],
    )
    if (r.rows.length === 0) {
      const existing = await this.findByKeyAndVersion(def.metricKey, def.version)
      if (existing === null) throw new Error('metric_definition_revision 插入冲突且无既有行')
      return existing
    }
    return mapDefinitionRow(r.rows[0]!)
  }

  async findByKeyAndVersion(metricKey: string, version: number): Promise<MetricDefinitionDto | null> {
    const r = await this.client.query(
      `SELECT ${DEFINITION_COLUMNS} FROM metric_definition_revision WHERE metric_key = $1 AND version = $2`,
      [metricKey, version],
    )
    return r.rows[0] === undefined ? null : mapDefinitionRow(r.rows[0])
  }

  async listAll(): Promise<MetricDefinitionDto[]> {
    const r = await this.client.query(
      `SELECT ${DEFINITION_COLUMNS} FROM metric_definition_revision ORDER BY metric_key, version`,
    )
    return r.rows.map(mapDefinitionRow)
  }

  async markReferenced(id: string): Promise<void> {
    // RP-S3：单向闩锁置位；幂等（已置位时不再 UPDATE，不触发守卫）
    await this.client.query(
      `UPDATE metric_definition_revision SET referenced = true, updated_at = now() WHERE id = $1 AND referenced = false`,
      [id],
    )
  }
}

// ---------------- 班次快照（RP-18/RP-S2） ----------------

const SNAPSHOT_COLUMNS = `id, plant_id, shift_date, metric_key, metric_version, caliber_version,
  numerator_value, denominator_value, value, uom_code, status, missing_reason, source_rows,
  computed_at, computed_by`

interface SnapshotRow {
  id: string
  plant_id: string
  shift_date: Date | string
  metric_key: string
  metric_version: number
  caliber_version: string
  numerator_value: string | null
  denominator_value: string | null
  value: string | null
  uom_code: string
  status: 'ok' | 'denominator_missing' | 'projection_failed'
  missing_reason: string | null
  source_rows: number
  computed_at: Date | string
  computed_by: string
}

function mapSnapshotRow(r: SnapshotRow): ShiftSnapshotDto {
  return {
    id: r.id,
    plantId: r.plant_id,
    shiftDate: dateStr(r.shift_date) ?? '',
    metricKey: r.metric_key,
    metricVersion: r.metric_version,
    caliberVersion: r.caliber_version,
    numeratorValue: fixed4OrNull(r.numerator_value),
    denominatorValue: fixed4OrNull(r.denominator_value),
    value: fixed4OrNull(r.value),
    uomCode: r.uom_code,
    status: r.status,
    missingReason: r.missing_reason,
    sourceRows: r.source_rows,
    computedAt: iso(r.computed_at),
    computedBy: r.computed_by,
  }
}

export class PgShiftSnapshotRepository implements ShiftSnapshotRepository {
  constructor(private readonly client: SqlClient) {}

  /** RP-S2：幂等键 (工厂, 班次日, 指标, 版本) ON CONFLICT 覆盖——重算不产生重复行。 */
  async upsertBatch(rows: readonly ShiftSnapshotUpsert[]): Promise<ShiftSnapshotDto[]> {
    const stored: ShiftSnapshotDto[] = []
    for (const row of rows) {
      const r = await this.client.query(
        `INSERT INTO shift_snapshot (plant_id, shift_date, metric_key, metric_version, caliber_version,
           numerator_value, denominator_value, value, uom_code, status, missing_reason, source_rows,
           computed_at, computed_by, command_receipt_id, enterprise_id, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13,$14,$15,$13,now(),$13)
         ON CONFLICT (plant_id, shift_date, metric_key, metric_version) DO UPDATE SET
           numerator_value = EXCLUDED.numerator_value,
           denominator_value = EXCLUDED.denominator_value,
           value = EXCLUDED.value,
           uom_code = EXCLUDED.uom_code,
           status = EXCLUDED.status,
           missing_reason = EXCLUDED.missing_reason,
           source_rows = EXCLUDED.source_rows,
           computed_at = now(),
           computed_by = EXCLUDED.computed_by,
           command_receipt_id = EXCLUDED.command_receipt_id,
           updated_at = now(),
           updated_by = EXCLUDED.computed_by
         RETURNING ${SNAPSHOT_COLUMNS}`,
        [
          row.plantId,
          row.shiftDate,
          row.metricKey,
          row.metricVersion,
          row.caliberVersion,
          row.numeratorValue,
          row.denominatorValue,
          row.value,
          row.uomCode,
          row.status,
          row.missingReason,
          row.sourceRows,
          row.computedBy,
          row.commandReceiptId,
          row.enterpriseId,
        ],
      )
      if (r.rows[0] !== undefined) stored.push(mapSnapshotRow(r.rows[0]))
    }
    return stored
  }

  async listPaged(filter: ShiftSnapshotFilter): Promise<{ items: ShiftSnapshotDto[]; total: number }> {
    const clauses: string[] = []
    const args: unknown[] = []
    if (filter.plantIds !== null) {
      clauses.push(`plant_id = ANY($${args.length + 1}::uuid[])`)
      args.push(filter.plantIds)
    }
    if (filter.plantId !== undefined && filter.plantId !== '') {
      clauses.push(`plant_id = $${args.length + 1}::uuid`)
      args.push(filter.plantId)
    }
    if (filter.shiftDateFrom !== undefined) {
      clauses.push(`shift_date >= $${args.length + 1}::date`)
      args.push(filter.shiftDateFrom)
    }
    if (filter.shiftDateTo !== undefined) {
      clauses.push(`shift_date <= $${args.length + 1}::date`)
      args.push(filter.shiftDateTo)
    }
    if (filter.metricKeys !== undefined && filter.metricKeys.length > 0) {
      clauses.push(`metric_key = ANY($${args.length + 1})`)
      args.push(filter.metricKeys)
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      clauses.push(`status = ANY($${args.length + 1})`)
      args.push(filter.statuses)
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const count = await this.client.query(
      `SELECT count(*)::text AS total FROM shift_snapshot ${where}`,
      args,
    )
    const rows = await this.client.query(
      `SELECT ${SNAPSHOT_COLUMNS} FROM shift_snapshot ${where}
       ORDER BY shift_date DESC, metric_key LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, filter.pageSize, (filter.page - 1) * filter.pageSize],
    )
    return { items: rows.rows.map(mapSnapshotRow), total: Number(count.rows[0]?.total ?? 0) }
  }
}

// ---------------- 事实集聚合（指标引擎 SQL 侧） ----------------

/**
 * 事实集聚合（RP-19 声明性事实集键 → SQL 聚合；班次日期口径：行自带 shift_date 优先，
 * 空值按 business_time Asia/Shanghai 折算——IT-37/GAP-A3 默认参数）。
 */
export class PgSnapshotFactCalculator implements SnapshotFactCalculator {
  constructor(private readonly client: SqlClient) {}

  async listShiftDates(plantId: string): Promise<string[]> {
    const r = await this.client.query(
      `SELECT DISTINCT d FROM (
         SELECT pr.shift_date AS d FROM production_report pr WHERE pr.plant_id = $1 AND pr.status <> 'deleted'
         UNION
         SELECT COALESCE(mc.shift_date, (mc.business_time AT TIME ZONE 'Asia/Shanghai')::date) AS d
         FROM material_consumption mc WHERE mc.plant_id = $1
         UNION
         SELECT COALESCE(st.shift_date, (st.business_time AT TIME ZONE 'Asia/Shanghai')::date) AS d
         FROM stock_transaction st WHERE st.plant_id = $1
       ) shifts WHERE d IS NOT NULL ORDER BY d`,
      [plantId],
    )
    return r.rows.map((row) => dateStr(row.d) ?? '')
  }

  async calculate(
    kind: string,
    args: { plantId: string; shiftDate: string; uomCode: string },
  ): Promise<FactSetResult> {
    switch (kind) {
      case 'production.wip-balance':
        return this.wipBalance(args)
      case 'execution.report-output-qty':
        return this.reportQty(args, 'quantity')
      case 'execution.report-qualified-qty':
        return this.reportQty(args, 'qualified_qty')
      case 'execution.material-consumption-qty':
        return this.consumptionQty(args)
      case 'execution.consumption-minus-output-qty':
        return this.consumptionMinusOutput(args)
      case 'process.order-ontime-finish':
        return this.orderFinish(args, true)
      case 'process.order-finish':
        return this.orderFinish(args, false)
      default:
        throw new Error(`未知事实集键：${kind}`)
    }
  }

  /** 在制余额：in_production 单元活动余额（按声明单位；非声明单位的行不冒充入值）。 */
  private async wipBalance(args: { plantId: string; uomCode: string }): Promise<FactSetResult> {
    const r = await this.client.query(
      `SELECT COALESCE(sum(b.quantity), 0)::text AS total, count(*)::text AS rows
       FROM stock_balance b
       JOIN inventory_unit u ON u.id = b.unit_id AND u.status = 'in_production'
       WHERE b.plant_id = $1 AND b.status = 'active' AND b.uom_code = $2`,
      [args.plantId, args.uomCode],
    )
    return { value: fixed4(r.rows[0]?.total), rows: Number(r.rows[0]?.rows ?? 0) }
  }

  private async reportQty(
    args: { plantId: string; shiftDate: string; uomCode: string },
    column: 'quantity' | 'qualified_qty',
  ): Promise<FactSetResult> {
    // 单位口径（K08/RP-14）：非 '%' 单位严格按声明单位过滤（非声明单位的行不冒充入值）；
    // '%' 为比率显示单位（percent 指标默认定义），事实行按事实集全部单位聚合——
    // 比率指标分子分母同口径（同过滤）相除，单位混算不改变比值；GAP-F25 裁定后改定义行分列。
    const uomFilter = args.uomCode === '%' ? '' : 'AND ro.uom_code = $3'
    const params = args.uomCode === '%' ? [args.plantId, args.shiftDate] : [args.plantId, args.shiftDate, args.uomCode]
    const r = await this.client.query(
      `SELECT COALESCE(sum(ro.${column}), 0)::text AS total, count(*)::text AS rows
       FROM report_output ro
       JOIN production_report pr ON pr.id = ro.report_id
       WHERE pr.plant_id = $1 AND pr.status = 'submitted'
         AND pr.review_status IN ('auto_approved','manual_approved')
         AND pr.shift_date = $2::date ${uomFilter}`,
      params,
    )
    return { value: fixed4(r.rows[0]?.total), rows: Number(r.rows[0]?.rows ?? 0) }
  }

  private async consumptionQty(args: { plantId: string; shiftDate: string }): Promise<FactSetResult> {
    const r = await this.client.query(
      `SELECT COALESCE(sum(mc.quantity), 0)::text AS total, count(*)::text AS rows
       FROM material_consumption mc
       WHERE mc.plant_id = $1
         AND COALESCE(mc.shift_date, (mc.business_time AT TIME ZONE 'Asia/Shanghai')::date) = $2::date`,
      [args.plantId, args.shiftDate],
    )
    return { value: fixed4(r.rows[0]?.total), rows: Number(r.rows[0]?.rows ?? 0) }
  }

  private async consumptionMinusOutput(args: { plantId: string; shiftDate: string }): Promise<FactSetResult> {
    const consumption = await this.consumptionQty(args)
    // 产出按全单位合计（损耗量=投料−产出，量纲以投料单位为准的首期框架口径，GAP-F25 待裁）
    const output = await this.client.query(
      `SELECT COALESCE(sum(ro.quantity), 0)::text AS total, count(*)::text AS rows
       FROM report_output ro
       JOIN production_report pr ON pr.id = ro.report_id
       WHERE pr.plant_id = $1 AND pr.status = 'submitted'
         AND pr.review_status IN ('auto_approved','manual_approved')
         AND pr.shift_date = $2::date`,
      [args.plantId, args.shiftDate],
    )
    const gap = Number(consumption.value) - Number(output.rows[0]?.total ?? 0)
    return { value: gap.toFixed(4), rows: Number(consumption.rows) + Number(output.rows[0]?.rows ?? 0) }
  }

  private async orderFinish(args: { plantId: string }, ontimeOnly: boolean): Promise<FactSetResult> {
    const ontimeClause = ontimeOnly ? 'AND po.actual_finish_at <= po.planned_finish_at' : ''
    const r = await this.client.query(
      `SELECT count(*)::text AS total, count(*)::text AS rows
       FROM production_order po
       WHERE po.plant_id = $1 AND po.actual_finish_at IS NOT NULL ${ontimeClause}`,
      [args.plantId],
    )
    return { value: Number(r.rows[0]?.total ?? 0).toFixed(4), rows: Number(r.rows[0]?.rows ?? 0) }
  }
}

// ---------------- 追溯（RP-22 / IT-35） ----------------

export class PgTraceRepository implements TraceRepository {
  constructor(private readonly client: SqlClient) {}

  async trace(args: {
    unitId?: string
    unitNo?: string
    direction: 'forward' | 'backward'
    plantIds: string[] | null
    enterpriseId: string
    maxDepth?: number
  }): Promise<TraceResultDto | null> {
    const maxDepth = args.maxDepth ?? 16
    let rootId = args.unitId
    if (rootId === undefined || rootId === '') {
      if (args.unitNo === undefined || args.unitNo === '') return null
      const found = await this.client.query(
        `SELECT id FROM inventory_unit WHERE unit_no = $1 AND enterprise_id = $2 LIMIT 1`,
        [args.unitNo, args.enterpriseId],
      )
      rootId = found.rows[0]?.id
      if (rootId === undefined) return null
    }
    // 根单元数据范围过滤（OA-24/25：plant 范围用户只能以本厂单元为根）
    const root = await this.client.query(
      `SELECT id, unit_no, plant_id FROM inventory_unit WHERE id = $1 AND enterprise_id = $2`,
      [rootId, args.enterpriseId],
    )
    const rootRow = root.rows[0]
    if (rootRow === undefined) return null
    if (args.plantIds !== null && !args.plantIds.includes(rootRow.plant_id)) return null

    // IT-35 正反向：forward = 该单元作为原料流向下游（from 本节点 → to 下游）；
    // backward = 该单元由哪些上游构成（to 本节点 → from 上游）。
    // genealogy_edge.from_id/to_id 为 uuid：递归 CTE 以 text 承载 node_id，联接时 ::text 归一。
    const step = args.direction === 'forward' ? 'e.from_id::text = p.node_id' : 'e.to_id::text = p.node_id'
    const nextId = args.direction === 'forward' ? 'e.to_id::text' : 'e.from_id::text'
    const nextType = args.direction === 'forward' ? 'e.to_type::text' : 'e.from_type::text'
    const rows = await this.client.query(
      `WITH RECURSIVE walk AS (
         SELECT $1::text AS node_id, 'inventory_unit'::text AS node_type, 0 AS depth
         UNION
         SELECT ${nextId}, ${nextType}, p.depth + 1
         FROM walk p JOIN genealogy_edge e ON ${step}
         WHERE p.depth < $2
       )
       SELECT w.node_id, w.node_type, w.depth,
         u.unit_no, u.material_code, u.status,
         oo.operation_name, pr.equipment_code, pr.operator_login,
         (SELECT count(*)::text FROM quality_hold h WHERE h.inventory_unit_id = u.id) AS hold_count
       FROM walk w
       LEFT JOIN inventory_unit u ON w.node_type = 'inventory_unit' AND u.id = w.node_id::uuid
       LEFT JOIN report_output ro ON w.node_type = 'inventory_unit' AND ro.stock_unit_id = w.node_id::uuid
       LEFT JOIN production_report pr ON pr.id = ro.report_id
       LEFT JOIN order_operation oo ON oo.id = pr.order_operation_id
       ORDER BY w.depth, w.node_id`,
      [rootId, maxDepth],
    )
    const edges = await this.client.query(
      `SELECT e.from_id, e.to_id, e.edge_kind, e.quantity::text AS quantity, e.uom_code, e.business_time
       FROM genealogy_edge e
       WHERE e.from_id::text = ANY($1::text[]) AND e.to_id::text = ANY($1::text[])`,
      [rows.rows.map((r) => r.node_id)],
    )
    const nodeIds = new Set(rows.rows.map((r) => r.node_id))
    return {
      direction: args.direction,
      root: { nodeId: rootId, nodeType: 'inventory_unit', unitNo: rootRow.unit_no },
      nodes: rows.rows.map((r) => ({
        nodeId: r.node_id,
        nodeType: r.node_type,
        unitNo: r.unit_no,
        materialCode: r.material_code,
        status: r.status,
        depth: r.depth,
        operationName: r.operation_name,
        equipmentCode: r.equipment_code,
        operatorLogin: r.operator_login,
        holdCount: Number(r.hold_count ?? 0),
      })),
      edges: edges.rows
        .filter((e) => nodeIds.has(e.from_id) && nodeIds.has(e.to_id))
        .map((e) => ({
          fromNodeId: e.from_id,
          toNodeId: e.to_id,
          edgeKind: e.edge_kind as 'receipt_origin' | 'consumption' | 'production_output' | 'customer_binding',
          quantity: fixed4(e.quantity),
          uomCode: e.uom_code,
          businessTime: iso(e.business_time),
        })),
    }
  }
}

// ---------------- 导出审计（RP-S4） ----------------

export class PgExportAuditWriter implements ExportAuditWriter {
  constructor(private readonly client: SqlClient) {}

  async recordExport(entry: {
    actor: string
    reportKind: string
    filterDigest: string
    rowCount: number
    plantId?: string | null
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO audit_entry (actor, action, subject_type, subject_id, after, reason)
       VALUES ($1, $2, 'reporting_export', $3, $4::jsonb, $5)`,
      [
        entry.actor,
        `reporting.${entry.reportKind}.export`,
        entry.reportKind,
        JSON.stringify({ rowCount: entry.rowCount, filterDigest: entry.filterDigest }),
        'RP-S4 导出与查询共用范围校验，导出记审计行',
      ],
    )
  }
}

// ---------------- 仓储束 ----------------

export interface PgReportingRepositories {
  projections: PgStockStatProjectionRepository
  sources: PgStockStatSourceRepository
  axis: PgAxisQueryRepository
  reports: PgReportSummaryRepository
  definitions: PgMetricDefinitionRepository
  snapshots: PgShiftSnapshotRepository
  facts: PgSnapshotFactCalculator
  trace: PgTraceRepository
  exports: PgExportAuditWriter
}

export function createPgReportingRepositories(client: SqlClient): PgReportingRepositories {
  return {
    projections: new PgStockStatProjectionRepository(client),
    sources: new PgStockStatSourceRepository(client),
    axis: new PgAxisQueryRepository(client),
    reports: new PgReportSummaryRepository(client),
    definitions: new PgMetricDefinitionRepository(client),
    snapshots: new PgShiftSnapshotRepository(client),
    facts: new PgSnapshotFactCalculator(client),
    trace: new PgTraceRepository(client),
    exports: new PgExportAuditWriter(client),
  }
}
