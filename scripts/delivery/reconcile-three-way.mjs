#!/usr/bin/env node
/**
 * 恢复后对账三分工具（T26，DO-18，§3.1 第 6 步；2026-10-29 R2 重写）。
 *
 * 恢复完成后按恢复截止点三分各自核对并留输出，才可恢复对外业务：
 * ①业务账——库存余额 vs 流水分录重放（逐余额键链条连续 + 终值=当前余额）+ 单据在库计数；
 * ②接口账——Outbox 未决任务清单（PENDING/SYNC_FAILED/EXTERNAL_UNKNOWN/FAILED）、
 *   外部已确认集合（DISPATCHED）、Inbox（含 QUARANTINED 隔离）分组与任务不丢失校验；
 * ③投影——与底层业务事实的数值核对（R2：不再以行数冒充核对）：
 *   - 投影表按当前发行迁移集为必需能力：`shift_snapshot`/`stock_stat_projection`/
 *     `metric_definition_revision`（迁移 0016，P2-F 报表域；发行锚 0001–0021）。
 *     缺表＝ABSENT（具名留痕），缺覆盖或数值差异＝FAIL；两者都阻断汇总通过，
 *     不得作为恢复对外业务的通过依据（PM-FINAL-RECEPTION R2 裁定）。
 *   - stock_stat_projection：按 RP-01 两类汇总键（采购收货码/生产码）独立重算事实聚合，
 *     与投影逐键数值比对（数量按 4 位定点）；缺键/多键/数值差异均 FAIL。
 *   - shift_snapshot：逐快照行按 metric_definition_revision 登记口径（分子/分母事实集键、
 *     单位、uom_mode、生效区间）从业务事实独立重算分子/分母/值/状态/参与行数，
 *     按指标族（wip/delivery/yield/loss）抽样核对（默认每族全查，>N 确定性抽样）；
 *     引用定义缺失、referenced 未置位、projection_failed、缺分母与事实不符均为 FAIL。
 *   - 覆盖：对每工厂按事实班次日历 × 生效指标定义枚举应有快照键，缺一即 FAIL（缺覆盖）。
 *
 * 事实集聚合口径与 packages/persistence/src/reporting-repositories.ts 的
 * PgSnapshotFactCalculator（引擎实现）逐条对齐——对账独立重算，不经引擎代码路径，
 * 口径引用 metric_definition_revision 定义行（声明性事实集键）。
 *
 * 用法：reconcile-three-way.mjs --database-url URL --out <目录> [--sample-limit N]
 * 退出码：0＝三分全 PASS；1＝存在 FAIL/ABSENT（阻断恢复对外业务）。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { withPool } from './lib/db.mjs'
import { nowIso } from './lib/util.mjs'

/** 当前发行（RELEASE-ANCHOR.json 0001–0021）的投影域必需表与其引入迁移。 */
const REPORTING_MIGRATION = '0016'
const REQUIRED_PROJECTION_TABLES = ['shift_snapshot', 'stock_stat_projection', 'metric_definition_revision']
/** 演练/生产对账同口径：恢复对外业务要求的迁移顶版本（与发行锚一致）。 */
const REQUIRED_TOP_MIGRATION = '0021'

const BUSINESS_DOC_TABLES = [
  'purchase_order', 'process_order', 'shipment_order', 'packing_order',
  'quality_inspection', 'maintenance_order',
]

/** 指标族（RP-20 首期四族）。 */
const METRIC_FAMILIES = ['wip', 'delivery', 'yield', 'loss']

// ---------------- 数值（4 位定点，与 domain reporting decimal-math 同口径） ----------------

/** 十进制字符串 → ×10^4 定点 bigint（非法输入抛错，不静默）。 */
function toScaled4(value, label) {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) {
    throw new Error(`数值非法（${label}）：${String(value)}`)
  }
  const negative = value.startsWith('-')
  const [intPart, fracPart = ''] = (negative ? value.slice(1) : value).split('.')
  const frac = (fracPart + '0000').slice(0, 4)
  const scaled = BigInt(`${intPart}${frac}`)
  return negative ? -scaled : scaled
}

function fromScaled4(scaled) {
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const intPart = abs / 10000n
  const fracPart = (abs % 10000n).toString().padStart(4, '0')
  return `${negative ? '-' : ''}${intPart}.${fracPart}`
}

/** 截取除法（RP-03：正数向下截取，不四舍五入）——与 truncDiv4 同口径。 */
function truncDiv4(a, b) {
  if (b === 0n) throw new Error('除数为零')
  const negative = a < 0n !== b < 0n
  const absA = a < 0n ? -a : a
  const absB = b < 0n ? -b : b
  const quotient = (absA * 10000n) / absB
  return negative ? -quotient : quotient
}

/** RP-21 快照值解析（与 domain resolveSnapshotValue 同口径）。 */
function resolveSnapshotValue(numeratorScaled, denominatorScaled, uomMode) {
  if (denominatorScaled === null) return { status: 'ok', value: numeratorScaled }
  if (denominatorScaled === 0n) return { status: 'denominator_missing', value: null }
  const ratio = truncDiv4(numeratorScaled, denominatorScaled)
  return { status: 'ok', value: uomMode === 'percent' ? ratio * 100n : ratio }
}

/** RP-19 生效定义选择（与 pickEffectiveDefinition 同口径：active + 区间内 + 最高版本/每 key）。 */
function pickEffectiveDefinition(definitions, shiftDate) {
  const day = Date.parse(`${shiftDate}T00:00:00Z`)
  let best = null
  for (const def of definitions) {
    if (def.status !== 'active') continue
    const from = Date.parse(`${def.effective_from}T00:00:00Z`)
    const to = def.effective_to === null ? Number.POSITIVE_INFINITY : Date.parse(`${def.effective_to}T23:59:59Z`)
    if (day < from || day > to) continue
    if (best === null || def.version > best.version) best = def
  }
  return best
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]?.replace(/^--/, '')
    if (!key) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      i += 1
    } else {
      args[key] = ''
    }
  }
  return args
}

async function tableExists(pool, name) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name])
  return r.rows.length > 0
}

// ---------------- ① 业务账（余额事实链重放 + 单据计数） ----------------

async function businessAccount(pool) {
  const problems = []
  const summary = []

  // ①-1 逐余额键：分录链条连续 + 终值=当前余额（重放核对）
  const balances = await pool.query(`
    SELECT sb.id AS balance_id, sb.quantity::text AS qty,
      (SELECT count(*)::int FROM stock_entry se WHERE se.balance_id = sb.id) AS entry_count
    FROM stock_balance sb`)
  let checkedBalances = 0
  for (const balance of balances.rows) {
    checkedBalances += 1
    const entries = await pool.query(`
      SELECT before_qty::text AS before_qty, after_qty::text AS after_qty, quantity_delta::text AS delta
      FROM stock_entry WHERE balance_id = $1 ORDER BY created_at, entry_no`, [balance.balance_id])
    let expected = null
    for (const e of entries.rows) {
      if (expected !== null && e.before_qty !== expected) {
        problems.push(`余额 ${balance.balance_id}：分录链条断裂（before ${e.before_qty} ≠ 期望 ${expected}）`)
        break
      }
      expected = e.after_qty
    }
    if (expected !== null && expected !== balance.qty) {
      problems.push(`余额 ${balance.balance_id}：重放终值 ${expected} ≠ 当前余额 ${balance.qty}`)
    }
    if (balance.entry_count === 0) {
      problems.push(`余额 ${balance.balance_id}：无任何流水分录（余额无事实来源）`)
    }
  }
  summary.push(`库存余额键 ${String(checkedBalances)} 个逐一重放核验`)

  // ①-2 单据在库计数
  const docCounts = []
  for (const table of BUSINESS_DOC_TABLES) {
    if (await tableExists(pool, table)) {
      const r = await pool.query(`SELECT count(*)::int AS n FROM ${table}`)
      docCounts.push(`${table}=${String(r.rows[0].n)}`)
    }
  }
  summary.push(`单据在库计数：${docCounts.length > 0 ? docCounts.join(', ') : '当前库无已登记单据表行'}`)

  return {
    pass: problems.length === 0,
    summary,
    problems,
  }
}

// ---------------- ② 接口账（outbox/inbox 分组 + 未决清单 + 隔离队列） ----------------

async function interfaceAccount(pool) {
  const outboxGroups = await pool.query(`
    SELECT status, count(*)::int AS n FROM outbox GROUP BY status ORDER BY status`)
  const total = outboxGroups.rows.reduce((acc, r) => acc + r.n, 0)
  const groupLines = outboxGroups.rows.map((r) => `${r.status}=${String(r.n)}`)

  const undecided = await pool.query(`
    SELECT event_id, task_kind, status, attempt_count, next_retry_at
    FROM outbox WHERE status IN ('PENDING','SYNC_FAILED','EXTERNAL_UNKNOWN','FAILED')
    ORDER BY created_at`)
  const confirmed = await pool.query(`
    SELECT count(*)::int AS n FROM outbox WHERE status IN ('DISPATCHED','NOOP_NEEDED')`)

  const inboxGroups = await pool.query(`
    SELECT status, count(*)::int AS n FROM inbox GROUP BY status ORDER BY status`)
  const inboxLines = inboxGroups.rows.map((r) => `${r.status}=${String(r.n)}`)
  const quarantined = await pool.query(`
    SELECT source_system, external_key, quarantine_reason FROM inbox WHERE status='QUARANTINED'`)

  const problems = []
  if (total === 0 && (await tableExists(pool, 'command_receipt'))) {
    const receipts = await pool.query(`SELECT count(*)::int AS n FROM command_receipt`)
    if (receipts.rows[0].n > 0) {
      problems.push(`有命令回执 ${String(receipts.rows[0].n)} 条但 outbox 为空——若回执含需回传业务则任务丢失嫌疑，人工核查`)
    }
  }

  return {
    pass: problems.length === 0,
    summary: [
      `Outbox 分组：${groupLines.length > 0 ? groupLines.join(', ') : '（空）'}（合计 ${String(total)}）`,
      `未决任务（须处置）：${String(undecided.rows.length)} 条`,
      `外部已确认集合（DISPATCHED/NOOP_NEEDED）：${String(confirmed.rows[0].n)} 条`,
      `Inbox 分组：${inboxLines.length > 0 ? inboxLines.join(', ') : '（空）'}；隔离 ${String(quarantined.rows.length)} 条`,
    ],
    problems,
    undecided: undecided.rows,
    quarantined: quarantined.rows,
  }
}

// ---------------- ③ 投影账（R2：真实数值核对） ----------------

/** 事实集独立聚合（口径对齐 PgSnapshotFactCalculator；对账重算，不经引擎）。 */
async function calculateFactSet(pool, kind, args) {
  const { plantId, shiftDate, uomCode } = args
  switch (kind) {
    case 'production.wip-balance': {
      const r = await pool.query(
        `SELECT COALESCE(sum(b.quantity),0)::text AS total, count(*)::int AS rows
         FROM stock_balance b
         JOIN inventory_unit u ON u.id = b.unit_id AND u.status = 'in_production'
         WHERE b.plant_id = $1 AND b.status = 'active' AND b.uom_code = $2`,
        [plantId, uomCode])
      return { value: toScaled4(r.rows[0].total, 'wip-balance'), rows: r.rows[0].rows }
    }
    case 'execution.report-output-qty':
      return reportQty(pool, args, 'quantity')
    case 'execution.report-qualified-qty':
      return reportQty(pool, args, 'qualified_qty')
    case 'execution.material-consumption-qty':
      return consumptionQty(pool, args)
    case 'execution.consumption-minus-output-qty': {
      const consumption = await consumptionQty(pool, args)
      const output = await pool.query(
        `SELECT COALESCE(sum(ro.quantity),0)::text AS total, count(*)::int AS rows
         FROM report_output ro
         JOIN production_report pr ON pr.id = ro.report_id
         WHERE pr.plant_id = $1 AND pr.status = 'submitted'
           AND pr.review_status IN ('auto_approved','manual_approved')
           AND pr.shift_date = $2::date`,
        [plantId, shiftDate])
      return {
        value: consumption.value - toScaled4(output.rows[0].total, 'output-total'),
        rows: consumption.rows + output.rows[0].rows,
      }
    }
    case 'process.order-ontime-finish':
      return orderFinish(pool, args, true)
    case 'process.order-finish':
      return orderFinish(pool, args, false)
    default:
      throw new Error(`未知事实集键（对账器不识别，须与 FACT_SET_KEYS 对齐）：${kind}`)
  }
}

async function reportQty(pool, { plantId, shiftDate, uomCode }, column) {
  // K08/RP-14 单位口径：'%' 为比率显示单位→按全部单位聚合（分子分母同过滤，比值不变）
  const uomFilter = uomCode === '%' ? '' : 'AND ro.uom_code = $3'
  const params = uomCode === '%' ? [plantId, shiftDate] : [plantId, shiftDate, uomCode]
  const r = await pool.query(
    `SELECT COALESCE(sum(ro.${column}),0)::text AS total, count(*)::int AS rows
     FROM report_output ro
     JOIN production_report pr ON pr.id = ro.report_id
     WHERE pr.plant_id = $1 AND pr.status = 'submitted'
       AND pr.review_status IN ('auto_approved','manual_approved')
       AND pr.shift_date = $2::date ${uomFilter}`,
    params)
  return { value: toScaled4(r.rows[0].total, `reportQty(${column})`), rows: r.rows[0].rows }
}

async function consumptionQty(pool, { plantId, shiftDate }) {
  const r = await pool.query(
    `SELECT COALESCE(sum(mc.quantity),0)::text AS total, count(*)::int AS rows
     FROM material_consumption mc
     WHERE mc.plant_id = $1
       AND COALESCE(mc.shift_date, (mc.business_time AT TIME ZONE 'Asia/Shanghai')::date) = $2::date`,
    [plantId, shiftDate])
  return { value: toScaled4(r.rows[0].total, 'consumption'), rows: r.rows[0].rows }
}

async function orderFinish(pool, { plantId }, ontimeOnly) {
  const ontimeClause = ontimeOnly ? 'AND po.actual_finish_at <= po.planned_finish_at' : ''
  const r = await pool.query(
    `SELECT count(*)::int AS total FROM production_order po
     WHERE po.plant_id = $1 AND po.actual_finish_at IS NOT NULL ${ontimeClause}`,
    [plantId])
  return { value: BigInt(r.rows[0].total) * 10000n, rows: r.rows[0].total }
}

/** 班次日历（口径对齐 listShiftDates：报工 shift_date ∪ 投料/流水折算日）。 */
async function listShiftDates(pool, plantId) {
  const r = await pool.query(
    `SELECT DISTINCT d::text AS d FROM (
       SELECT pr.shift_date AS d FROM production_report pr WHERE pr.plant_id = $1 AND pr.status <> 'deleted'
       UNION
       SELECT COALESCE(mc.shift_date, (mc.business_time AT TIME ZONE 'Asia/Shanghai')::date) AS d
       FROM material_consumption mc WHERE mc.plant_id = $1
       UNION
       SELECT COALESCE(st.shift_date, (st.business_time AT TIME ZONE 'Asia/Shanghai')::date) AS d
       FROM stock_transaction st WHERE st.plant_id = $1
     ) shifts WHERE d IS NOT NULL ORDER BY d`,
    [plantId])
  return r.rows.map((row) => row.d)
}

/** RP-01 两类汇总键独立重算（采购收货码/生产码；与投影唯一索引同键归一）。 */
async function collectExpectedStockStatKeys(pool) {
  const r = await pool.query(`
    WITH report_ctx AS (
      SELECT DISTINCT ro.stock_unit_id, po.order_no, pr.operation_seq
      FROM report_output ro
      JOIN production_report pr ON pr.id = ro.report_id AND pr.status <> 'deleted'
      JOIN production_order po ON po.id = pr.order_id
      WHERE ro.stock_unit_id IS NOT NULL
    )
    SELECT plant_id::text AS plant_id, stat_kind, unit_no,
      COALESCE(lot_no, '') AS lot_no, COALESCE(supplier_lot_no, '') AS supplier_lot_no,
      COALESCE(material_code, '') AS material_code, COALESCE(order_no, '') AS order_no,
      COALESCE(operation_seq, 0) AS operation_seq, sum(quantity)::text AS quantity
    FROM (
      SELECT ub.plant_id, 'purchase_receive'::text AS stat_kind, ub.unit_no, ml.lot_no,
        ml.supplier_lot_no, ub.material_code, NULL::text AS order_no, NULL::integer AS operation_seq,
        sum(bb.quantity) AS quantity
      FROM inventory_unit ub
      JOIN material_lot ml ON ml.id = ub.lot_id AND ml.kind = 'purchase'
      JOIN stock_balance bb ON bb.unit_id = ub.id AND bb.status = 'active'
      GROUP BY ub.plant_id, ub.unit_no, ml.lot_no, ml.supplier_lot_no, ub.material_code
      UNION ALL
      SELECT ub.plant_id, 'production'::text AS stat_kind, ub.unit_no, ml.lot_no,
        ml.supplier_lot_no, ub.material_code, rc.order_no, rc.operation_seq,
        sum(bb.quantity) AS quantity
      FROM inventory_unit ub
      JOIN material_lot ml ON ml.id = ub.lot_id AND ml.kind <> 'purchase'
      JOIN report_ctx rc ON rc.stock_unit_id = ub.id
      JOIN stock_balance bb ON bb.unit_id = ub.id AND bb.status = 'active'
      GROUP BY ub.plant_id, ub.unit_no, ml.lot_no, ml.supplier_lot_no, ub.material_code, rc.order_no, rc.operation_seq
    ) keys
    GROUP BY plant_id, stat_kind, unit_no, lot_no, supplier_lot_no, material_code, order_no, operation_seq`)
  const map = new Map()
  for (const row of r.rows) {
    map.set(stockStatKey(row), { ...row })
  }
  return map
}

function stockStatKey(row) {
  return [row.plant_id, row.stat_kind, row.unit_no, row.lot_no, row.supplier_lot_no,
    row.material_code, row.order_no, String(row.operation_seq)].join('|')
}

async function collectActualStockStatKeys(pool) {
  const r = await pool.query(`
    SELECT plant_id::text AS plant_id, stat_kind, unit_no,
      COALESCE(lot_no, '') AS lot_no, COALESCE(supplier_lot_no, '') AS supplier_lot_no,
      COALESCE(material_code, '') AS material_code, COALESCE(order_no, '') AS order_no,
      COALESCE(operation_seq, 0) AS operation_seq, sum(quantity)::text AS quantity
    FROM stock_stat_projection
    GROUP BY plant_id, stat_kind, unit_no, lot_no, supplier_lot_no, material_code, order_no, operation_seq`)
  const map = new Map()
  for (const row of r.rows) {
    map.set(stockStatKey(row), { ...row })
  }
  return map
}

/** 确定性抽样：全查 ≤limit；超限取最近 ceil(limit/2) + 均匀步进其余。 */
function sampleRows(rows, limit) {
  if (rows.length <= limit) return { rows, sampled: false, total: rows.length }
  const recent = Math.ceil(limit / 2)
  const sorted = [...rows].sort((a, b) => String(a.computed_at).localeCompare(String(b.computed_at)))
  const picked = sorted.slice(sorted.length - recent)
  const rest = sorted.slice(0, sorted.length - recent)
  const step = Math.max(1, Math.floor(rest.length / (limit - recent)))
  for (let i = 0; i < rest.length && picked.length < limit; i += step) picked.push(rest[i])
  const byId = new Set(picked.map((r) => r.id))
  return { rows: rows.filter((r) => byId.has(r.id)), sampled: true, total: rows.length }
}

async function projectionAccount(pool, opts) {
  const problems = []
  const summary = []
  const families = []
  const maxDetail = 20

  // ---- 能力判定：迁移集与必需表 ----
  const applied = (await pool.query(`SELECT version FROM schema_migrations ORDER BY version`))
    .rows.map((r) => r.version)
  const missingTables = []
  for (const t of REQUIRED_PROJECTION_TABLES) {
    if (!(await tableExists(pool, t))) missingTables.push(t)
  }
  if (missingTables.length > 0) {
    const reason = applied.includes(REPORTING_MIGRATION)
      ? `库已应用 ${REPORTING_MIGRATION}（reporting）但投影表缺失：${missingTables.join(', ')}——投影域残缺（ABSENT）`
      : `库迁移集 ${applied.length > 0 ? applied.join(',') : '（空）'} 未含 ${REPORTING_MIGRATION}（reporting），发行锚要求至 ${REQUIRED_TOP_MIGRATION}——投影能力未部署（ABSENT）`
    return {
      status: 'ABSENT',
      pass: false,
      summary: [
        reason,
        'ABSENT＝投影能力缺席（具名留痕）：按 R2/A11 口径不得作为恢复对外业务的通过依据；先恢复到发行版本并完成投影重建（reporting.stock-stat.rebuild / reporting.shift-snapshot.rebuild）后复对账。',
      ],
      problems: [reason],
      families: [],
    }
  }
  if (!applied.includes(REQUIRED_TOP_MIGRATION)) {
    problems.push(`库迁移顶版本 ${applied[applied.length - 1] ?? '（空）'} 未达发行锚要求 ${REQUIRED_TOP_MIGRATION}——版本不一致，恢复未到位`)
  }
  summary.push(`投影必需表在库：${REQUIRED_PROJECTION_TABLES.join(', ')}（迁移 ${applied.join(',')}）`)

  // ---- 指标定义（口径引用源） ----
  const defs = (await pool.query(
    `SELECT id::text, metric_key, family, version, caliber_version,
       numerator_fact_set, denominator_fact_set, uom_code, uom_mode,
       effective_from::text AS effective_from, effective_to::text AS effective_to,
       status, referenced
     FROM metric_definition_revision ORDER BY metric_key, version`)).rows
  for (const d of defs) {
    d.numerator_kind = (d.numerator_fact_set ?? {}).kind
    d.denominator_kind = (d.denominator_fact_set ?? null)?.kind ?? null
  }
  const defByKeyVersion = new Map(defs.map((d) => [`${d.metric_key}@v${String(d.version)}`, d]))
  const activeDefs = defs.filter((d) => d.status === 'active')
  summary.push(`指标定义：共 ${String(defs.length)} 行（active ${String(activeDefs.length)}）；口径引用 metric_definition_revision（分子/分母事实集键 + uom_mode + 生效区间）`)
  if (activeDefs.length === 0) {
    problems.push('缺覆盖：无任何 active 指标定义（投影域未引导——先 reporting.metric-definition.register 注册口径再重建快照）')
  }

  // ---- 快照逐行数值核对（按指标族抽样） ----
  const snapshots = (await pool.query(
    `SELECT id::text, plant_id::text AS plant_id, shift_date::text AS shift_date, metric_key,
       metric_version, caliber_version, numerator_value::text AS numerator_value,
       denominator_value::text AS denominator_value, value::text AS value,
       uom_code, status AS snap_status, missing_reason, source_rows, computed_at
     FROM shift_snapshot ORDER BY plant_id, shift_date, metric_key`)).rows
  summary.push(`班次快照在库 ${String(snapshots.length)} 行`)

  const snapDefMissing = []
  const referencedUnset = new Set()
  for (const s of snapshots) {
    const def = defByKeyVersion.get(`${s.metric_key}@v${String(s.metric_version)}`)
    if (def === undefined) snapDefMissing.push(`${s.plant_id}/${s.shift_date}/${s.metric_key}@v${String(s.metric_version)}`)
    else if (!def.referenced) referencedUnset.add(`${def.metric_key}@v${String(def.version)}`)
  }
  if (snapDefMissing.length > 0) {
    problems.push(`快照引用的指标定义缺失（悬空引用，RP-S3 违例）${String(snapDefMissing.length)} 处：${snapDefMissing.slice(0, maxDetail).join('；')}${snapDefMissing.length > maxDetail ? '…' : ''}`)
  }
  if (referencedUnset.size > 0) {
    problems.push(`快照已引用但定义 referenced=false（RP-S3 引用闩锁未置位，投影来源不可信）：${[...referencedUnset].join('；')}`)
  }

  const byFamily = new Map(METRIC_FAMILIES.map((f) => [f, []]))
  for (const s of snapshots) {
    const def = defByKeyVersion.get(`${s.metric_key}@v${String(s.metric_version)}`)
    const family = def?.family ?? 'unknown'
    if (!byFamily.has(family)) byFamily.set(family, [])
    byFamily.get(family).push(s)
  }

  for (const family of [...byFamily.keys()].sort()) {
    const rows = byFamily.get(family)
    if (rows.length === 0) continue
    const { rows: sampled, sampled: didSample, total } = sampleRows(rows, opts.sampleLimit)
    const familyProblems = []
    for (const s of sampled) {
      const def = defByKeyVersion.get(`${s.metric_key}@v${String(s.metric_version)}`)
      if (def === undefined) continue // 已按悬空引用记问题
      const args = { plantId: s.plant_id, shiftDate: s.shift_date, uomCode: def.uom_code }
      try {
        const numerator = await calculateFactSet(pool, def.numerator_kind, args)
        const denominator = def.denominator_kind === null
          ? null
          : await calculateFactSet(pool, def.denominator_kind, args)
        const resolution = resolveSnapshotValue(numerator.value, denominator === null ? null : denominator.value, def.uom_mode)
        const expected = {
          status: resolution.status,
          value: resolution.value,
          numerator: numerator.value,
          denominator: denominator === null ? null : denominator.value,
          sourceRows: numerator.rows,
        }
        const actual = {
          status: s.snap_status,
          value: s.value === null ? null : toScaled4(s.value, 'snap.value'),
          numerator: s.numerator_value === null ? null : toScaled4(s.numerator_value, 'snap.numerator'),
          denominator: s.denominator_value === null ? null : toScaled4(s.denominator_value, 'snap.denominator'),
          sourceRows: s.source_rows,
        }
        const diffs = []
        if (expected.numerator !== null && actual.numerator !== expected.numerator) {
          diffs.push(`分子 ${actual.numerator === null ? 'null' : fromScaled4(actual.numerator)} ≠ 事实 ${fromScaled4(expected.numerator)}`)
        }
        if ((expected.denominator ?? null) !== null && actual.denominator !== expected.denominator) {
          diffs.push(`分母 ${actual.denominator === null ? 'null' : fromScaled4(actual.denominator)} ≠ 事实 ${fromScaled4(expected.denominator)}`)
        }
        // 分母确为 0/无行且快照诚实标记 denominator_missing（RP-21）：与事实一致，记通过
        if (expected.status !== actual.status) {
          diffs.push(`状态 ${actual.status} ≠ 应为 ${expected.status}`)
        } else if (expected.status === 'ok' && actual.value !== expected.value) {
          diffs.push(`值 ${actual.value === null ? 'null' : fromScaled4(actual.value)} ≠ 应为 ${fromScaled4(expected.value)}`)
        } else if (expected.status === 'denominator_missing' && actual.value !== null) {
          diffs.push('缺分母标记但 value 非空（RP-21 违例）')
        }
        if (actual.sourceRows !== expected.sourceRows) {
          diffs.push(`参与行数 ${String(actual.sourceRows)} ≠ 事实 ${String(expected.sourceRows)}（RP-22 对账锚点）`)
        }
        if (actual.status === 'projection_failed') {
          diffs.push(`投影失败行（${s.missing_reason ?? '无原因'}）——重建未成功，不可作为通过依据`)
        }
        if (diffs.length > 0) {
          familyProblems.push(
            `${s.plant_id}/${s.shift_date}/${s.metric_key}@v${String(s.metric_version)}（caliber ${s.caliber_version}，` +
            `口径：分子=${def.numerator_kind} 分母=${def.denominator_kind ?? '无'} uom=${def.uom_code}/${def.uom_mode}）：${diffs.join('；')}`)
        }
      } catch (error) {
        familyProblems.push(`${s.plant_id}/${s.shift_date}/${s.metric_key}@v${String(s.metric_version)}：事实重算失败——${error instanceof Error ? error.message : String(error)}`)
      }
    }
    problems.push(...familyProblems)
    families.push({
      family,
      total,
      checked: sampled.length,
      sampled: didSample,
      ok: sampled.length - familyProblems.length,
      mismatch: familyProblems.length,
    })
    summary.push(
      `指标族 ${family}：在库 ${String(total)} 行，核对 ${String(sampled.length)} 行` +
      `${didSample ? `（确定性抽样，上限 ${String(opts.sampleLimit)}）` : '（全量）'}——一致 ${String(sampled.length - familyProblems.length)}，差异 ${String(familyProblems.length)}`)
  }

  // ---- 快照覆盖核对（应有键 vs 实有键） ----
  const plants = (await pool.query(`SELECT id::text AS id FROM org_node WHERE kind='plant' AND status='active'`)).rows
  const expectedSnapKeys = new Set()
  for (const plant of plants) {
    const dates = await listShiftDates(pool, plant.id)
    for (const date of dates) {
      for (const def of activeDefs) {
        const effective = pickEffectiveDefinition(
          activeDefs.filter((d) => d.metric_key === def.metric_key), date)
        if (effective !== null && effective.version === def.version) {
          expectedSnapKeys.add(`${plant.id}|${date}|${def.metric_key}@v${String(def.version)}`)
        }
      }
    }
  }
  const actualSnapKeys = new Set(snapshots.map((s) => `${s.plant_id}|${s.shift_date}|${s.metric_key}@v${String(s.metric_version)}`))
  const missingCoverage = [...expectedSnapKeys].filter((k) => !actualSnapKeys.has(k))
  if (missingCoverage.length > 0) {
    problems.push(`缺覆盖：应有班次快照缺失 ${String(missingCoverage.length)} 键（工厂|班次日|指标@版本；口径=事实班次日历 × 生效定义）：${missingCoverage.slice(0, maxDetail).join('；')}${missingCoverage.length > maxDetail ? '…' : ''}`)
  }
  summary.push(`覆盖核对：应有快照键 ${String(expectedSnapKeys.size)}（${String(plants.length)} 工厂 × 事实班次日 × 生效定义），实有 ${String(actualSnapKeys.size)}，缺失 ${String(missingCoverage.length)}`)

  // 库存统计投影逐键数值核对（RP-01 两类汇总键）
  const expectedKeys = await collectExpectedStockStatKeys(pool)
  const actualKeys = await collectActualStockStatKeys(pool)
  const stockMissing = []
  const stockExtra = []
  const stockDiff = []
  for (const [key, expected] of expectedKeys) {
    const actual = actualKeys.get(key)
    if (actual === undefined) {
      stockMissing.push(key)
    } else if (toScaled4(expected.quantity, 'expected-qty') !== toScaled4(actual.quantity, 'actual-qty')) {
      stockDiff.push(`${key}：投影 ${actual.quantity} ≠ 事实 ${expected.quantity}`)
    }
  }
  for (const key of actualKeys.keys()) {
    if (!expectedKeys.has(key)) stockExtra.push(key)
  }
  if (stockMissing.length > 0) {
    problems.push(`库存统计投影缺键 ${String(stockMissing.length)}（事实有而投影无，RP-01 汇总键）：${stockMissing.slice(0, maxDetail).join('；')}${stockMissing.length > maxDetail ? '…' : ''}`)
  }
  if (stockExtra.length > 0) {
    problems.push(`库存统计投影多键 ${String(stockExtra.length)}（投影有而事实无——陈旧投影行）：${stockExtra.slice(0, maxDetail).join('；')}${stockExtra.length > maxDetail ? '…' : ''}`)
  }
  if (stockDiff.length > 0) {
    problems.push(`库存统计投影数值差异 ${String(stockDiff.length)} 键：${stockDiff.slice(0, maxDetail).join('；')}${stockDiff.length > maxDetail ? '…' : ''}`)
  }
  summary.push(`库存统计投影：事实应有键 ${String(expectedKeys.size)}，投影实有键 ${String(actualKeys.size)}，数值一致键 ${String(expectedKeys.size - stockMissing.length - stockDiff.length)}；缺 ${String(stockMissing.length)} / 多 ${String(stockExtra.length)} / 差异 ${String(stockDiff.length)}`)

  return {
    status: problems.length === 0 ? 'PASS' : 'FAIL',
    pass: problems.length === 0,
    summary,
    problems,
    families,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args['out']) {
    console.error('用法：--database-url URL --out <目录> [--sample-limit N]')
    process.exit(2)
  }
  const databaseUrl = args['database-url'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const outDir = args['out']
  const sampleLimit = Number(args['sample-limit'] ?? '40')
  await mkdir(outDir, { recursive: true })
  const stamp = nowIso().replace(/[:.]/g, '-')

  const result = await withPool(databaseUrl, async (pool) => {
    const business = await businessAccount(pool)
    const iface = await interfaceAccount(pool)
    const projection = await projectionAccount(pool, { sampleLimit })
    return { business, iface, projection }
  })

  // 三份具名输出（各自核对通过并留输出，DO-18）
  const files = []
  const writeOut = async (name, lines) => {
    const file = path.join(outDir, `${name}-${stamp}.md`)
    await writeFile(file, lines.join('\n'), 'utf8')
    files.push(file)
  }
  await writeOut('01-业务账', [
    `# ① 业务账对账（DO-18）`,
    '',
    `- 时间：${nowIso()}；数据库：${databaseUrl.replace(/:[^:@/]*@/, ':***@')}`,
    `- 结论：${result.business.pass ? 'PASS' : 'FAIL'}`,
    '',
    ...result.business.summary.map((s) => `- ${s}`),
    '',
    result.business.problems.length > 0 ? '## 不一致项' : '## 无不一致项',
    ...result.business.problems.map((p) => `- ${p}`),
  ])
  await writeOut('02-接口账', [
    `# ② 接口账对账（DO-18 / IF-00.9）`,
    '',
    `- 时间：${nowIso()}`,
    `- 结论：${result.iface.pass ? 'PASS' : 'FAIL'}`,
    '',
    ...result.iface.summary.map((s) => `- ${s}`),
    '',
    '## 恢复后未决任务清单（重派/确认/解释后归档）',
    ...(result.iface.undecided.length > 0
      ? result.iface.undecided.map((u) => `- ${u.event_id} ${u.task_kind} ${u.status} attempt=${String(u.attempt_count)}`)
      : ['- 无']),
    '',
    '## 隔离队列',
    ...(result.iface.quarantined.length > 0
      ? result.iface.quarantined.map((q) => `- ${q.source_system}/${q.external_key}：${q.quarantine_reason ?? ''}`)
      : ['- 无']),
  ])
  const projectionVerdict = result.projection.status === 'ABSENT'
    ? 'ABSENT（投影能力缺席，具名留痕——不冒充通过，阻断恢复对外业务）'
    : result.projection.status
  await writeOut('03-投影', [
    `# ③ 投影对账（DO-18 / A11 / R2 2026-10-29）`,
    '',
    `- 时间：${nowIso()}`,
    `- 结论：${projectionVerdict}`,
    `- 口径引用：metric_definition_revision（分子/分母事实集键、uom_mode、生效区间）；事实集聚合独立重算（不经报表引擎）`,
    '',
    ...result.projection.summary.map((s) => `- ${s}`),
    ...(result.projection.families.length > 0
      ? ['', '## 按指标族核对（范围/版本/分母逐行登记）',
        ...result.projection.families.map((f) =>
          `- 族 ${f.family}：在库 ${String(f.total)}，核对 ${String(f.checked)}${f.sampled ? '（抽样）' : '（全量）'}，一致 ${String(f.ok)}，差异 ${String(f.mismatch)}`)]
      : []),
    '',
    result.projection.problems.length > 0 ? '## 差异/缺覆盖项（阻断）' : '## 无差异、无缺覆盖',
    ...result.projection.problems.map((p) => `- ${p}`),
  ])

  const allPass = result.business.pass && result.iface.pass && result.projection.pass
  const summary = [
    `# 恢复后三分对账总表（DO-18 / R2）`,
    '',
    `- 时间：${nowIso()}`,
    `- ① 业务账：${result.business.pass ? 'PASS' : 'FAIL'}`,
    `- ② 接口账：${result.iface.pass ? 'PASS' : 'FAIL'}`,
    `- ③ 投影：${projectionVerdict}`,
    `- 三分各自输出：${files.map((f) => path.basename(f)).join('、')}`,
    '',
    allPass
      ? '①②③核对通过（③为真实数值核对：投影与业务事实按登记口径一致）；按 DO-18 三分各自核对通过并留输出后方可恢复对外业务（发货/回传）。'
      : '存在 FAIL/ABSENT 项：按差异处置（DO-19 差异保留并获准补录 / 投影经 reporting 域 rebuild 命令重建）后复对账，未通过不得恢复对外业务。',
  ]
  const summaryFile = path.join(outDir, `three-way-summary-${stamp}.md`)
  await writeFile(summaryFile, summary.join('\n'), 'utf8')
  // 机器可读结果（演练/门禁消费）
  const resultFile = path.join(outDir, `three-way-result-${stamp}.json`)
  await writeFile(resultFile, `${JSON.stringify({
    generated_at: nowIso(),
    business: { pass: result.business.pass },
    interface: { pass: result.iface.pass },
    projection: { status: result.projection.status, pass: result.projection.pass, problem_count: result.projection.problems.length },
    all_pass: allPass,
    outputs: files.map((f) => path.basename(f)),
  }, null, 2)}\n`, 'utf8')

  for (const line of summary) console.log(line)
  if (!allPass) process.exitCode = 1
}

main().catch((error) => {
  console.error('三分对账失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
