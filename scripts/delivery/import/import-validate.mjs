#!/usr/bin/env node
/**
 * 期初导入校验与拒绝清单工具（T25，冻结合同 frozen/p3/delivery-ops.md §2）。纯 JS。
 *
 * 覆盖规则：
 * - DO-07 导入交互基线四要素：模板下载（--emit-template）、列级校验（必填/格式）、
 *   名称匹配已有主数据（料品/单位/仓库/库位/工厂/组织，支持多值）、已存在默认不覆盖；
 * - DO-08 拒绝清单：行号+拒绝原因+原文快照；坏行不静默丢弃、不静默修补；
 *   修正后重导幂等（已成功自然键不重复导入）；
 * - DO-09 历史空字段分类：可空列带 EMPTY_FROM_SOURCE 标记，历史审核类空值进具名核对清单，
 *   绝不默认为有利语义（K21）；
 * - DO-10 分层迁移：主数据(1)→期初库存(2)→未结订单/在制(3)→历史单据(4)，每层独立核对，
 *   上层未核对通过拒绝对下层 apply；
 * - DO-11 库存冻结点：期初库存 apply 须冻结点 active；核对通过+批准人方可解除；
 * - DO-12 期初/增量分立：initial-* 与 incr-* 模板与校验规则互不共用；
 * - DO-S2 导入运行表：delivery_import_run / delivery_import_row（行级结果+重导幂等键），
 *   拒绝清单另落哈希链账本（不可删改）。
 *
 * 落库边界：第 1 层提供合并（--merge-master-data，INSERT 已存在守卫）；第 2/3/4 层
 * 落暂存表（delivery_stg_*），合并进业务表走产品命令面（见交付记录 §L0 清单）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseCsv, stringifyCsv } from '../lib/csv.mjs'
import { withPool } from '../lib/db.mjs'
import { appendRecord, ledgerHead, verifyLedger } from '../lib/ledger.mjs'
import { decimalStringError, isoDateError, nowIso, sha256Text } from '../lib/util.mjs'

// ============ 模板定义（列规则单一事实源；--emit-template 由此生成） ============

const QUALITY_STATUSES = ['qualified', 'pending_inspection', 'unqualified', 'suspect']

const TEMPLATES = [
  {
    name: 'initial-01-master-data',
    layer: 1,
    kind: 'initial',
    naturalKey: ['料品编码'],
    columns: [
      { name: '料品编码', required: true, emptyPolicy: 'reject' },
      { name: '料品名称', required: true, emptyPolicy: 'reject' },
      { name: '料品类型', required: true, emptyPolicy: 'reject', check: { kind: 'enum', values: ['1', '2', '3'] } },
      { name: '基本单位', required: true, emptyPolicy: 'reject' },
      { name: '规格型号', required: false, emptyPolicy: 'ok' },
      { name: '电压', required: false, emptyPolicy: 'ok' },
      { name: '标准', required: false, emptyPolicy: 'ok' },
      { name: '客户', required: false, emptyPolicy: 'ok' },
      { name: '适用组织', required: true, emptyPolicy: 'reject', check: { kind: 'orgMultiName' } },
      { name: '备注', required: false, emptyPolicy: 'ok' },
    ],
    exampleRow: ['MAT-DEMO-0001', '演示电缆料-铜导体', '1', '千克', '1×500mm', '450/750V', 'GB/T 5023', '演示客户A', '华东电缆集团', '期初导入示例行，正式导入前删除'],
  },
  {
    name: 'initial-02-inventory',
    layer: 2,
    kind: 'initial',
    naturalKey: ['料品编码', '批次号', '仓库编码', '库位编码', '质量状态'],
    columns: [
      { name: '料品编码', required: true, emptyPolicy: 'reject' },
      { name: '批次号', required: true, emptyPolicy: 'reject' },
      { name: '所属工厂', required: true, emptyPolicy: 'reject' },
      { name: '仓库编码', required: true, emptyPolicy: 'reject', check: { kind: 'code', pattern: /^[0-9]{4}$/, desc: '4 位数字仓库码' } },
      { name: '库位编码', required: true, emptyPolicy: 'reject', check: { kind: 'code', pattern: /^[0-9]{6}$|^[0-9]{8}$/, desc: '6/8 位数字库位码' } },
      { name: '数量', required: true, emptyPolicy: 'reject', check: { kind: 'decimal', positiveOnly: true } },
      { name: '单位', required: true, emptyPolicy: 'reject' },
      { name: '质量状态', required: true, emptyPolicy: 'reject', check: { kind: 'enum', values: QUALITY_STATUSES } },
      { name: '供应商批号', required: false, emptyPolicy: 'ok' },
      { name: '货主', required: false, emptyPolicy: 'ok' },
      { name: '备注', required: false, emptyPolicy: 'ok' },
    ],
    exampleRow: ['MAT-DEMO-0001', 'LOT-INIT-0001', '苏州线缆厂', '0101', '01010001', '500.0000', '千克', 'qualified', 'SUP-LOT-A', '', '期初库存示例行'],
  },
  {
    name: 'initial-03-open-orders',
    layer: 3,
    kind: 'initial',
    naturalKey: ['单据类型', '单据编号'],
    columns: [
      { name: '单据类型', required: true, emptyPolicy: 'reject', check: { kind: 'enum', values: ['purchase_open', 'process_wip', 'sales_open'] } },
      { name: '单据编号', required: true, emptyPolicy: 'reject' },
      { name: '所属工厂', required: true, emptyPolicy: 'reject' },
      { name: '料品编码', required: true, emptyPolicy: 'reject' },
      { name: '数量', required: true, emptyPolicy: 'reject', check: { kind: 'decimal', positiveOnly: true } },
      { name: '单位', required: true, emptyPolicy: 'reject' },
      { name: '交期', required: true, emptyPolicy: 'reject', check: { kind: 'date' } },
      { name: '状态说明', required: false, emptyPolicy: 'must_confirm' },
      { name: '备注', required: false, emptyPolicy: 'ok' },
    ],
    exampleRow: ['purchase_open', 'PO-OLD-0001', '苏州线缆厂', 'MAT-DEMO-0001', '200.0000', '千克', '2026-11-30', '', '未结订单示例行'],
  },
  {
    name: 'initial-04-historical-docs',
    layer: 4,
    kind: 'initial',
    naturalKey: ['单据类型', '单据编号'],
    columns: [
      { name: '单据类型', required: true, emptyPolicy: 'reject', check: { kind: 'enum', values: ['receipt', 'issue', 'move', 'production', 'shipment'] } },
      { name: '单据编号', required: true, emptyPolicy: 'reject' },
      { name: '所属工厂', required: true, emptyPolicy: 'reject' },
      { name: '业务日期', required: true, emptyPolicy: 'reject', check: { kind: 'date' } },
      { name: '料品编码', required: true, emptyPolicy: 'reject' },
      { name: '数量', required: true, emptyPolicy: 'reject', check: { kind: 'decimal', positiveOnly: true } },
      { name: '单位', required: true, emptyPolicy: 'reject' },
      { name: '审核状态', required: false, emptyPolicy: 'must_confirm', check: { kind: 'enum', values: ['approved', 'unapproved', 'void'] } },
      { name: '审核人', required: false, emptyPolicy: 'ok' },
      { name: '备注', required: false, emptyPolicy: 'ok' },
    ],
    exampleRow: ['receipt', 'HD-OLD-0001', '苏州线缆厂', '2026-06-30', 'MAT-DEMO-0001', '100.0000', '千克', 'approved', '旧系统管理员', '历史单据示例行'],
  },
  {
    name: 'incr-02-inventory-delta',
    layer: 2,
    kind: 'incremental',
    naturalKey: ['料品编码', '批次号', '仓库编码', '库位编码', '质量状态', '发生日期'],
    columns: [
      { name: '料品编码', required: true, emptyPolicy: 'reject' },
      { name: '批次号', required: true, emptyPolicy: 'reject' },
      { name: '所属工厂', required: true, emptyPolicy: 'reject' },
      { name: '仓库编码', required: true, emptyPolicy: 'reject', check: { kind: 'code', pattern: /^[0-9]{4}$/, desc: '4 位数字仓库码' } },
      { name: '库位编码', required: true, emptyPolicy: 'reject', check: { kind: 'code', pattern: /^[0-9]{6}$|^[0-9]{8}$/, desc: '6/8 位数字库位码' } },
      { name: '变动数量', required: true, emptyPolicy: 'reject', check: { kind: 'decimal', allowNegative: true } },
      { name: '单位', required: true, emptyPolicy: 'reject' },
      { name: '质量状态', required: true, emptyPolicy: 'reject', check: { kind: 'enum', values: QUALITY_STATUSES } },
      { name: '发生日期', required: true, emptyPolicy: 'reject', check: { kind: 'date' } },
      { name: '来源单据号', required: true, emptyPolicy: 'reject' },
      { name: '备注', required: false, emptyPolicy: 'ok' },
    ],
    exampleRow: ['MAT-DEMO-0001', 'LOT-INIT-0001', '苏州线缆厂', '0101', '01010001', '-50.0000', '千克', 'qualified', '2026-11-01', 'MO-NEW-0001', '增量抽取示例行'],
  },
  {
    name: 'incr-04-docs-delta',
    layer: 4,
    kind: 'incremental',
    naturalKey: ['单据类型', '单据编号'],
    columns: [
      { name: '单据类型', required: true, emptyPolicy: 'reject', check: { kind: 'enum', values: ['receipt', 'issue', 'move', 'production', 'shipment'] } },
      { name: '单据编号', required: true, emptyPolicy: 'reject' },
      { name: '所属工厂', required: true, emptyPolicy: 'reject' },
      { name: '业务日期', required: true, emptyPolicy: 'reject', check: { kind: 'date' } },
      { name: '抽取起点', required: true, emptyPolicy: 'reject', check: { kind: 'date' } },
      { name: '料品编码', required: true, emptyPolicy: 'reject' },
      { name: '数量', required: true, emptyPolicy: 'reject', check: { kind: 'decimal', positiveOnly: true } },
      { name: '单位', required: true, emptyPolicy: 'reject' },
      { name: '审核状态', required: false, emptyPolicy: 'must_confirm', check: { kind: 'enum', values: ['approved', 'unapproved', 'void'] } },
      { name: '备注', required: false, emptyPolicy: 'ok' },
    ],
    exampleRow: ['issue', 'HD-NEW-0002', '苏州线缆厂', '2026-11-02', '2026-11-01', 'MAT-DEMO-0001', '20.0000', '千克', 'approved', '增量单据示例行'],
  },
]

const LAYER_NAMES = { 1: '主数据补齐', 2: '期初库存', 3: '未结订单/在制', 4: '历史单据' }

// ============ 参数解析 ============

const VALUE_FLAGS = new Set([
  'emit-template', 'template', 'out', 'confirm-layer', 'confirmer',
  'note', 'operator', 'approver', 'database-url', 'workspace', 'file',
])
/** 可带值也可裸用的模式旗标：后随非 -- 开头 token 则视为其值（--apply <file> 兼容） */
const OPTIONAL_VALUE_FLAGS = new Set(['check', 'apply'])

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]?.replace(/^--/, '')
    if (!key) continue
    const next = argv[i + 1]
    if (VALUE_FLAGS.has(key)) {
      if (next === undefined || next.startsWith('--')) {
        console.error(`参数错误：--${key} 须带值`)
        process.exit(2)
      }
      args[key] = next
      i += 1
    } else if (OPTIONAL_VALUE_FLAGS.has(key)) {
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next
        i += 1
      } else {
        args[key] = ''
      }
    } else {
      args[key] = ''
    }
  }
  const mode = (args['emit-template'] !== undefined ? 'emit-template'
    : args['check'] !== undefined ? 'check'
    : args['apply'] !== undefined ? 'apply'
    : args['confirm-layer'] !== undefined ? 'confirm-layer'
    : args['set-freeze'] !== undefined ? 'set-freeze'
    : args['release-freeze'] !== undefined ? 'release-freeze'
    : args['merge-master-data'] !== undefined ? 'merge-master-data'
    : 'status')
  const confirmLayerRaw = args['confirm-layer']
  const confirmLayer = confirmLayerRaw !== undefined ? Number(confirmLayerRaw) : undefined
  if (confirmLayer !== undefined && (!Number.isInteger(confirmLayer) || confirmLayer < 1 || confirmLayer > 4)) {
    console.error('参数错误：--confirm-layer 须为 1–4')
    process.exit(2)
  }
  return {
    databaseUrl: args['database-url'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza',
    workspace: args['workspace'] ?? 'delivery-import-workspace',
    mode,
    template: args['template'] ?? args['emit-template'],
    file: args['file'] || (args['check'] !== '' && args['check']) || (args['apply'] !== '' && args['apply']) || undefined,
    out: args['out'],
    confirmLayer,
    confirmer: args['confirmer'],
    note: args['note'],
    operator: args['operator'],
    approver: args['approver'],
  }
}

// ============ 账簿/分层/冻结点 DDL（交付期表，前缀 delivery_，DO-S2/S3） ============

const BOOKKEEPING_DDL = [
  `CREATE TABLE IF NOT EXISTS delivery_import_run (
    run_id text PRIMARY KEY,
    template text NOT NULL,
    layer smallint NOT NULL,
    kind text NOT NULL,
    file_name text NOT NULL,
    file_sha256 text NOT NULL,
    total_rows integer NOT NULL,
    success_rows integer NOT NULL DEFAULT 0,
    skipped_exists_rows integer NOT NULL DEFAULT 0,
    skipped_imported_rows integer NOT NULL DEFAULT 0,
    review_rows integer NOT NULL DEFAULT 0,
    rejected_rows integer NOT NULL DEFAULT 0,
    rejection_ledger_count integer,
    rejection_ledger_head text,
    started_at timestamptz NOT NULL,
    finished_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS delivery_import_row (
    run_id text NOT NULL REFERENCES delivery_import_run(run_id),
    line_no integer NOT NULL,
    natural_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('success','skipped_exists','skipped_imported','rejected','review')),
    reason_code text,
    reason text,
    raw_snapshot text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, line_no)
  )`,
  `CREATE TABLE IF NOT EXISTS delivery_layer_check (
    layer smallint PRIMARY KEY,
    state text NOT NULL CHECK (state IN ('pending','imported','verified')),
    verified_by text,
    verified_at timestamptz,
    note text
  )`,
  `CREATE TABLE IF NOT EXISTS delivery_freeze_point (
    id serial PRIMARY KEY,
    state text NOT NULL CHECK (state IN ('active','released')),
    set_by text NOT NULL,
    set_at timestamptz NOT NULL DEFAULT now(),
    released_by text,
    released_at timestamptz,
    note text
  )`,
  `CREATE TABLE IF NOT EXISTS delivery_stg_material (
    natural_key text PRIMARY KEY,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_type smallint NOT NULL,
    base_uom text NOT NULL,
    uom_id uuid NOT NULL,
    spec text, voltage text, standard text, customer text,
    org_names text NOT NULL,
    enterprise_id uuid NOT NULL,
    note text,
    import_run_id text NOT NULL,
    line_no integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS delivery_stg_inventory (
    natural_key text PRIMARY KEY,
    material_id uuid NOT NULL,
    material_code text NOT NULL,
    lot_no text NOT NULL,
    plant_id uuid NOT NULL,
    warehouse_code text NOT NULL,
    location_id uuid NOT NULL,
    location_code text NOT NULL,
    quantity numeric(18,4) NOT NULL,
    uom_code text NOT NULL,
    uom_id uuid NOT NULL,
    quality_status text NOT NULL,
    supplier_lot_no text,
    owner_id uuid NOT NULL,
    owner_name text NOT NULL,
    empty_markers jsonb NOT NULL DEFAULT '{}',
    note text,
    kind text NOT NULL,
    occurred_on date,
    source_doc_no text,
    import_run_id text NOT NULL,
    line_no integer NOT NULL,
    merged_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS delivery_stg_open_order (
    natural_key text PRIMARY KEY,
    doc_type text NOT NULL,
    doc_no text NOT NULL,
    plant_id uuid NOT NULL,
    material_id uuid NOT NULL,
    material_code text NOT NULL,
    quantity numeric(18,4) NOT NULL,
    uom_code text NOT NULL,
    due_date date NOT NULL,
    status_note text,
    note text,
    import_run_id text NOT NULL,
    line_no integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS delivery_stg_historical_doc (
    natural_key text PRIMARY KEY,
    doc_type text NOT NULL,
    doc_no text NOT NULL,
    plant_id uuid NOT NULL,
    business_date date NOT NULL,
    extract_since date,
    material_id uuid NOT NULL,
    material_code text NOT NULL,
    quantity numeric(18,4) NOT NULL,
    uom_code text NOT NULL,
    audit_status text,
    audit_by text,
    empty_markers jsonb NOT NULL DEFAULT '{}',
    note text,
    kind text NOT NULL,
    import_run_id text NOT NULL,
    line_no integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
]

async function ensureBookkeeping(pool) {
  for (const ddl of BOOKKEEPING_DDL) await pool.query(ddl)
  for (const layer of [1, 2, 3, 4]) {
    await pool.query(
      `INSERT INTO delivery_layer_check (layer, state) VALUES ($1, 'pending')
       ON CONFLICT (layer) DO NOTHING`,
      [layer],
    )
  }
}

// ============ 名称匹配（DO-07：按名称/编码匹配已有主数据，缓存逐运行） ============

function newLookupCache() {
  return { material: new Map(), uom: new Map(), org: new Map(), plant: new Map(), warehouse: new Map(), location: new Map() }
}

async function lookupMaterial(pool, cache, key) {
  if (!cache.material.has(key)) {
    const r = await pool.query(
      `SELECT id, org_scope_id FROM material WHERE status='active' AND (code=$1 OR name=$1)`, [key])
    cache.material.set(key, r.rows)
  }
  return cache.material.get(key)
}

async function lookupUom(pool, cache, key) {
  if (!cache.uom.has(key)) {
    const r = await pool.query(`SELECT id FROM uom WHERE status='active' AND (code=$1 OR name=$1)`, [key])
    cache.uom.set(key, r.rows)
  }
  return cache.uom.get(key)
}

async function lookupOrg(pool, cache, name) {
  if (!cache.org.has(name)) {
    const r = await pool.query(
      `SELECT id, kind, enterprise_id FROM org_node WHERE status='active' AND name=$1`, [name])
    cache.org.set(name, r.rows)
  }
  return cache.org.get(name)
}

async function lookupPlant(pool, cache, key) {
  if (!cache.plant.has(key)) {
    const r = await pool.query(
      `SELECT n.id, n.enterprise_id, n.parent_id, n.name FROM org_node n
       WHERE n.status='active' AND n.kind='plant' AND (n.code=$1 OR n.plant_code=$1 OR n.name=$1)`, [key])
    cache.plant.set(key, r.rows)
  }
  return cache.plant.get(key)
}

async function lookupWarehouse(pool, cache, code, plantId) {
  const key = `${plantId}|${code}`
  if (!cache.warehouse.has(key)) {
    const r = await pool.query(
      `SELECT id, plant_id, enterprise_id FROM warehouse WHERE status='active' AND code=$1 AND plant_id=$2`,
      [code, plantId])
    cache.warehouse.set(key, r.rows)
  }
  return cache.warehouse.get(key)
}

async function lookupLocation(pool, cache, code, warehouseId) {
  const key = `${warehouseId}|${code}`
  if (!cache.location.has(key)) {
    const r = await pool.query(
      `SELECT id, warehouse_id FROM storage_location WHERE status='active' AND code=$1 AND warehouse_id=$2`,
      [code, warehouseId])
    cache.location.set(key, r.rows)
  }
  return cache.location.get(key)
}

// ============ 行级校验 ============

function naturalKeyOf(def, values) {
  return def.naturalKey.map((col) => values[col] ?? '').join('|')
}

async function validateRow(pool, cache, def, lineNo, values, raw, seenInFile, existsKeys) {
  const outcome = {
    lineNo,
    naturalKey: naturalKeyOf(def, values),
    status: 'rejected',
    raw,
    values,
    resolved: {},
    emptyMarkers: {},
  }
  const reject = (code, reason) => ({ ...outcome, reasonCode: code, reason })

  // DO-07 必填/列级校验 + DO-09 空值分类
  for (const col of def.columns) {
    const value = (values[col.name] ?? '').trim()
    if (value === '') {
      if (col.required || col.emptyPolicy === 'reject') {
        return reject('DO-07-必填', `第 ${String(lineNo)} 行：列「${col.name}」为必填（列级校验）`)
      }
      if (col.emptyPolicy === 'must_confirm') {
        return {
          ...outcome,
          status: 'review',
          reasonCode: 'DO-09-待确认',
          reason: `第 ${String(lineNo)} 行：历史列「${col.name}」为空，进入具名核对清单交业务确认（K21：空值不得默认为有利语义）`,
        }
      }
      outcome.emptyMarkers[col.name] = 'EMPTY_FROM_SOURCE'
      continue
    }
    if (col.check) {
      if (col.check.kind === 'enum' && !col.check.values.includes(value)) {
        return reject('DO-07-格式', `第 ${String(lineNo)} 行：列「${col.name}」值 ${value} 不在字典 ${col.check.values.join('/')}`)
      }
      if (col.check.kind === 'decimal') {
        const err = decimalStringError(value, col.check)
        if (err) return reject('DO-07-格式', `第 ${String(lineNo)} 行：列「${col.name}」${err}`)
      }
      if (col.check.kind === 'date') {
        const err = isoDateError(value)
        if (err) return reject('DO-07-格式', `第 ${String(lineNo)} 行：列「${col.name}」${err}`)
      }
      if (col.check.kind === 'code' && !col.check.pattern.test(value)) {
        return reject('DO-07-格式', `第 ${String(lineNo)} 行：列「${col.name}」${col.check.desc}`)
      }
    }
  }

  // DO-08 同文件自然键重复
  if (seenInFile.has(outcome.naturalKey)) {
    return reject('DO-08-重复', `第 ${String(lineNo)} 行：自然键 ${outcome.naturalKey} 在同一文件内重复`)
  }
  seenInFile.add(outcome.naturalKey)

  const resolved = {}

  if (def.layer === 1) {
    const uom = await lookupUom(pool, cache, values['基本单位'].trim())
    if (uom.length === 0) return reject('DO-07-名称', `第 ${String(lineNo)} 行：单位「${values['基本单位']}」未匹配到已有单位主数据`)
    if (uom.length > 1) return reject('DO-07-名称', `第 ${String(lineNo)} 行：单位「${values['基本单位']}」匹配到多条，须改用唯一编码`)
    resolved.uomId = uom[0].id
    const orgNames = values['适用组织'].split(/[，,、;；]/).map((s) => s.trim()).filter((s) => s !== '')
    let enterpriseId = null
    for (const name of orgNames) {
      const orgs = await lookupOrg(pool, cache, name)
      if (orgs.length === 0) {
        return reject('DO-07-名称', `第 ${String(lineNo)} 行：适用组织「${name}」未匹配到组织主数据（按名称匹配，支持多值）`)
      }
      if (orgs.length > 1) {
        return reject('DO-07-名称', `第 ${String(lineNo)} 行：适用组织「${name}」名称匹配到多条组织，须现场唯一化命名`)
      }
      const org = orgs[0]
      if (enterpriseId === null) enterpriseId = org.enterprise_id
      if (org.enterprise_id !== enterpriseId) {
        return reject('DO-07-名称', `第 ${String(lineNo)} 行：适用组织跨企业（${name}），料品主档不支持跨企业适用`)
      }
    }
    resolved.enterpriseId = enterpriseId
    if (existsKeys.has(values['料品编码'].trim())) {
      return { ...outcome, status: 'skipped_exists', reasonCode: 'DO-07-不覆盖', reason: `料品 ${values['料品编码']} 已存在，默认不覆盖（DO-07）` }
    }
  } else {
    const material = await lookupMaterial(pool, cache, values['料品编码'].trim())
    if (material.length === 0) {
      return reject('DO-07-名称', `第 ${String(lineNo)} 行：料品「${values['料品编码']}」未匹配到已有料品（先完成第 1 层主数据导入并合并）`)
    }
    if (material.length > 1) return reject('DO-07-名称', `第 ${String(lineNo)} 行：料品「${values['料品编码']}」匹配多条，须用唯一编码`)
    resolved.materialId = material[0].id
    const plant = await lookupPlant(pool, cache, values['所属工厂'].trim())
    if (plant.length === 0) return reject('DO-07-名称', `第 ${String(lineNo)} 行：工厂「${values['所属工厂']}」未匹配到工厂主数据`)
    if (plant.length > 1) return reject('DO-07-名称', `第 ${String(lineNo)} 行：工厂「${values['所属工厂']}」匹配多条，须用唯一编码`)
    resolved.plantId = plant[0].id
    resolved.enterpriseId = plant[0].enterprise_id
    if (def.layer === 2) {
      const uom = await lookupUom(pool, cache, values['单位'].trim())
      if (uom.length !== 1) return reject('DO-07-名称', `第 ${String(lineNo)} 行：单位「${values['单位']}」未唯一匹配单位主数据`)
      resolved.uomId = uom[0].id
      const wh = await lookupWarehouse(pool, cache, values['仓库编码'].trim(), plant[0].id)
      if (wh.length === 0) return reject('DO-07-名称', `第 ${String(lineNo)} 行：仓库「${values['仓库编码']}」在该工厂下不存在`)
      const loc = await lookupLocation(pool, cache, values['库位编码'].trim(), wh[0].id)
      if (loc.length === 0) return reject('DO-07-名称', `第 ${String(lineNo)} 行：库位「${values['库位编码']}」不属于仓库「${values['仓库编码']}」`)
      resolved.locationId = loc[0].id
      const ownerKey = (values['货主'] ?? '').trim()
      let owner
      if (ownerKey === '') {
        const ownerRow = await pool.query(`SELECT id, name FROM org_node WHERE id=$1`, [plant[0].parent_id])
        owner = { id: ownerRow.rows[0]?.id ?? plant[0].parent_id, name: ownerRow.rows[0]?.name ?? '未具名货主' }
      } else {
        const orgs = await lookupOrg(pool, cache, ownerKey)
        if (orgs.length !== 1) return reject('DO-07-名称', `第 ${String(lineNo)} 行：货主「${ownerKey}」未唯一匹配组织`)
        owner = { id: orgs[0].id, name: ownerKey }
      }
      resolved.ownerId = owner.id
      resolved.ownerName = owner.name
    }
  }

  return { ...outcome, status: 'success', resolved }
}

// ============ 暂存写入 ============

async function insertStagingRow(pool, def, o, runId) {
  const v = o.values
  const r = o.resolved
  if (def.layer === 1) {
    await pool.query(
      `INSERT INTO delivery_stg_material (natural_key, material_code, material_name, material_type, base_uom,
         uom_id, spec, voltage, standard, customer, org_names, enterprise_id, note, import_run_id, line_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [o.naturalKey, v['料品编码'], v['料品名称'], Number(v['料品类型']), v['基本单位'], r.uomId,
        v['规格型号'] || null, v['电压'] || null, v['标准'] || null, v['客户'] || null,
        v['适用组织'], r.enterpriseId, v['备注'] || null, runId, o.lineNo])
    return
  }
  if (def.layer === 2) {
    const occurredOn = def.kind === 'incremental' ? v['发生日期'] : null
    const qtyCol = def.kind === 'incremental' ? '变动数量' : '数量'
    const sourceDoc = def.kind === 'incremental' ? v['来源单据号'] : null
    await pool.query(
      `INSERT INTO delivery_stg_inventory (natural_key, material_id, material_code, lot_no, plant_id,
         warehouse_code, location_id, location_code, quantity, uom_code, uom_id, quality_status,
         supplier_lot_no, owner_id, owner_name, empty_markers, note, kind, occurred_on, source_doc_no,
         import_run_id, line_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [o.naturalKey, r.materialId, v['料品编码'], v['批次号'], r.plantId, v['仓库编码'],
        r.locationId, v['库位编码'], v[qtyCol], v['单位'], r.uomId, v['质量状态'],
        v['供应商批号'] || null, r.ownerId, r.ownerName, JSON.stringify(o.emptyMarkers),
        v['备注'] || null, def.kind, occurredOn, sourceDoc, runId, o.lineNo])
    return
  }
  if (def.layer === 3) {
    await pool.query(
      `INSERT INTO delivery_stg_open_order (natural_key, doc_type, doc_no, plant_id, material_id,
         material_code, quantity, uom_code, due_date, status_note, note, import_run_id, line_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [o.naturalKey, v['单据类型'], v['单据编号'], r.plantId, r.materialId, v['料品编码'],
        v['数量'], v['单位'], v['交期'], v['状态说明'] || null, v['备注'] || null, runId, o.lineNo])
    return
  }
  await pool.query(
    `INSERT INTO delivery_stg_historical_doc (natural_key, doc_type, doc_no, plant_id, business_date,
       extract_since, material_id, material_code, quantity, uom_code, audit_status, audit_by,
       empty_markers, note, kind, import_run_id, line_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [o.naturalKey, v['单据类型'], v['单据编号'], r.plantId, v['业务日期'],
      v['抽取起点'] || null, r.materialId, v['料品编码'], v['数量'], v['单位'],
      v['审核状态'] || null, v['审核人'] || null, JSON.stringify(o.emptyMarkers), v['备注'] || null,
      def.kind, runId, o.lineNo])
}

async function mergeMasterData(pool) {
  const result = await pool.query(`
    WITH ins AS (
      INSERT INTO material (org_scope_id, code, name, material_type, base_uom, spec, voltage,
        standard, customer, remark, source_system, status, created_by)
      SELECT s.enterprise_id, s.material_code, s.material_name, s.material_type, s.base_uom,
             s.spec, s.voltage, s.standard, s.customer, s.note, 'DELIVERY_IMPORT', 'active', '期初导入'
      FROM delivery_stg_material s
      WHERE NOT EXISTS (
        SELECT 1 FROM material m WHERE m.status='active' AND m.org_scope_id=s.enterprise_id AND m.code=s.material_code
      )
      RETURNING 1
    )
    SELECT (SELECT count(*)::text FROM ins) AS inserted,
           (SELECT count(*)::text FROM delivery_stg_material s WHERE EXISTS (
              SELECT 1 FROM material m WHERE m.status='active' AND m.org_scope_id=s.enterprise_id AND m.code=s.material_code)) AS skipped
  `)
  const row = result.rows[0] ?? { inserted: '0', skipped: '0' }
  return { inserted: Number(row.inserted), skipped: Number(row.skipped) }
}

// ============ 状态打印 ============

async function printStatus(pool) {
  const layers = await pool.query(
    `SELECT layer, state, verified_by, verified_at FROM delivery_layer_check ORDER BY layer`)
  const freeze = await pool.query(
    `SELECT id, state, set_by, set_at, released_by, released_at FROM delivery_freeze_point ORDER BY id DESC LIMIT 3`)
  const runs = await pool.query(
    `SELECT run_id, template, layer, kind, total_rows, success_rows, rejected_rows, review_rows, started_at
     FROM delivery_import_run ORDER BY started_at DESC LIMIT 10`)
  console.log('== 分层状态（DO-10）==')
  for (const row of layers.rows) {
    console.log(`  第 ${String(row.layer)} 层 ${LAYER_NAMES[row.layer] ?? ''}: ${row.state}${row.verified_by ? `（核对人 ${row.verified_by} @ ${String(row.verified_at)}）` : ''}`)
  }
  console.log('== 冻结点（DO-11）==')
  if (freeze.rows.length === 0) console.log('  无记录')
  for (const row of freeze.rows) {
    console.log(`  #${String(row.id)} ${row.state} 设置人=${row.set_by} @ ${String(row.set_at)}${row.released_by ? ` 解除人=${row.released_by}` : ''}`)
  }
  console.log('== 最近导入运行（DO-S2）==')
  for (const row of runs.rows) {
    console.log(`  ${row.run_id} ${row.template}[${row.kind}] 总${String(row.total_rows)} 成功${String(row.success_rows)} 拒${String(row.rejected_rows)} 确认${String(row.review_rows)} @ ${String(row.started_at)}`)
  }
}

// ============ 主流程 ============

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode !== 'emit-template' && !process.argv.includes('--database-url')) {
    console.error('[DO-安全] 该模式必须显式提供 --database-url（防止误连 dev 主库 cadenza）')
    process.exit(2)
  }

  if (args.mode === 'emit-template') {
    const def = TEMPLATES.find((t) => t.name === args.template)
    if (!def) {
      console.error(`未知模板 ${String(args.template)}；可用：${TEMPLATES.map((t) => t.name).join(', ')}`)
      process.exit(2)
    }
    const csv = stringifyCsv(def.columns.map((c) => c.name), [def.exampleRow])
    const out = args.out ?? path.join('templates', `${def.name}.csv`)
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, csv, 'utf8')
    console.log(`[DO-07 模板下载] 已生成 ${out}（${def.kind === 'initial' ? '期初' : '增量'}·第 ${String(def.layer)} 层·${LAYER_NAMES[def.layer] ?? ''}）`)
    console.log(`  示例行须在正式导入前删除；历史审核类空列会进核对清单（DO-09），不默认有利语义。`)
    return
  }

  const workspace = args.workspace
  await mkdir(path.join(workspace, 'runs'), { recursive: true })
  await mkdir(path.join(workspace, 'ledgers'), { recursive: true })
  const rejectionLedger = path.join(workspace, 'ledgers', 'rejections.ledger.jsonl')

  await withPool(args.databaseUrl, async (pool) => {
    await ensureBookkeeping(pool)

    if (args.mode === 'status') {
      await printStatus(pool)
      return
    }

    if (args.mode === 'set-freeze') {
      const active = await pool.query(`SELECT id FROM delivery_freeze_point WHERE state='active'`)
      if (active.rows.length > 0) {
        console.error('[DO-11] 已存在 active 冻结点，拒绝重复设置')
        process.exit(1)
      }
      if (!args.operator) {
        console.error('[DO-11] --set-freeze 须 --operator 操作人')
        process.exit(2)
      }
      await pool.query(
        `INSERT INTO delivery_freeze_point (state, set_by, note) VALUES ('active', $1, $2)`,
        [args.operator, args.note ?? null])
      console.log(`[DO-11 冻结点已设置] 操作人=${args.operator} 时间=${nowIso()}；冻结点期间目标库新业务写入暂停（或入隔离暂存），期初库存导入方可进行`)
      return
    }

    if (args.mode === 'release-freeze') {
      if (!args.approver) {
        console.error('[DO-11/S3] --release-freeze 须 --approver 恢复写入批准人')
        process.exit(2)
      }
      const layer2 = await pool.query(`SELECT state FROM delivery_layer_check WHERE layer=2`)
      if (layer2.rows[0]?.state !== 'verified') {
        console.error('[DO-11] 第 2 层（期初库存）未核对通过，拒绝解除冻结点（导入核对通过后方可恢复业务写入）')
        process.exit(1)
      }
      const r = await pool.query(
        `UPDATE delivery_freeze_point SET state='released', released_by=$1, released_at=now()
         WHERE id = (SELECT max(id) FROM delivery_freeze_point WHERE state='active') RETURNING id`,
        [args.approver])
      if (r.rows.length === 0) {
        console.error('[DO-11] 无 active 冻结点')
        process.exit(1)
      }
      console.log(`[DO-11 冻结点已解除] 批准人=${args.approver}（DO-S3 恢复写入批准人已登记）`)
      return
    }

    if (args.mode === 'confirm-layer') {
      const layer = args.confirmLayer
      const confirmer = args.confirmer
      if (layer === undefined) {
        console.error('[DO-10] --confirm-layer 须层号 1–4')
        process.exit(2)
      }
      if (!confirmer) {
        console.error('[DO-10] --confirm-layer 须 --confirmer 核对人')
        process.exit(2)
      }
      const runs = await pool.query(
        `SELECT count(*)::int AS n FROM delivery_import_run WHERE layer=$1 AND success_rows > 0`, [layer])
      if (runs.rows[0].n === 0) {
        console.error(`[DO-10] 第 ${String(layer)} 层尚无成功导入运行，拒绝核对确认`)
        process.exit(1)
      }
      await pool.query(
        `UPDATE delivery_layer_check SET state='verified', verified_by=$1, verified_at=now(), note=$2 WHERE layer=$3`,
        [confirmer, args.note ?? null, layer])
      console.log(`[DO-10 分层核对通过] 第 ${String(layer)} 层（${LAYER_NAMES[layer] ?? ''}）核对人=${confirmer}；下一层导入已解锁`)
      return
    }

    if (args.mode === 'merge-master-data') {
      const merged = await mergeMasterData(pool)
      console.log(`[主数据合并] 新增料品 ${String(merged.inserted)} 行，跳过已存在 ${String(merged.skipped)} 行`)
      return
    }

    // check / apply
    const def = TEMPLATES.find((t) => t.name === args.template)
    if (!def) {
      console.error(`--template 须为：${TEMPLATES.map((t) => t.name).join(', ')}`)
      process.exit(2)
    }
    if (!args.file) {
      console.error(`${args.mode} 须 --file <csv 路径>`)
      process.exit(2)
    }
    const csvText = await readFile(args.file, 'utf8')
    const fileSha = sha256Text(csvText)
    const parsed = parseCsv(csvText)

    if (args.mode === 'apply' && def.layer > 1) {
      const prev = await pool.query(`SELECT state FROM delivery_layer_check WHERE layer=$1`, [def.layer - 1])
      if (prev.rows[0]?.state !== 'verified') {
        console.error(
          `[DO-10 分层迁移] 第 ${String(def.layer - 1)} 层（${LAYER_NAMES[def.layer - 1] ?? ''}）尚未核对通过，拒绝 apply 第 ${String(def.layer)} 层；逐层导入，全部通过方可进入下层，不一次全量混导`)
        process.exit(1)
      }
    }
    if (args.mode === 'apply' && def.layer === 2 && def.kind === 'initial') {
      const freeze = await pool.query(`SELECT id FROM delivery_freeze_point WHERE state='active'`)
      if (freeze.rows.length === 0) {
        console.error('[DO-11 库存冻结点] 期初库存导入须先 --set-freeze 设置冻结点（冻结点期间目标库新业务写入暂停）')
        process.exit(1)
      }
    }

    const expected = def.columns.map((c) => c.name)
    const missing = expected.filter((c) => !parsed.headers.includes(c))
    if (missing.length > 0) {
      console.error(`[DO-07 列缺失] 模板 ${def.name} 缺列：${missing.join(', ')}`)
      process.exit(1)
    }

    // DO-08 幂等预取：历史成功自然键 + 业务已存在键
    const importedKeysRow = await pool.query(
      `SELECT DISTINCT natural_key FROM delivery_import_row WHERE status='success'`)
    const importedKeys = new Set(importedKeysRow.rows.map((r) => r.natural_key))
    const existsKeys = new Set()
    if (def.layer === 1) {
      const mats = await pool.query(`SELECT code FROM material WHERE status='active'`)
      for (const row of mats.rows) existsKeys.add(row.code)
    }

    const cache = newLookupCache()
    const outcomes = []
    const seenInFile = new Set()
    for (let i = 0; i < parsed.rows.length; i += 1) {
      const lineNo = i + 2
      const values = {}
      parsed.headers.forEach((h, idx) => {
        values[h] = parsed.rows[i][idx] ?? ''
      })
      const outcome = await validateRow(pool, cache, def, lineNo, values, parsed.rawLines[i] ?? '', seenInFile, existsKeys)
      if (outcome.status === 'success' && importedKeys.has(outcome.naturalKey)) {
        outcomes.push({ ...outcome, status: 'skipped_imported', reasonCode: 'DO-08-幂等', reason: '历史运行已成功导入该自然键，不重复导入' })
      } else {
        outcomes.push(outcome)
      }
    }

    const runId = `run-${nowIso().replace(/[:.]/g, '-')}-${def.name}`
    const counts = {
      total: outcomes.length,
      success: outcomes.filter((o) => o.status === 'success').length,
      skipped_exists: outcomes.filter((o) => o.status === 'skipped_exists').length,
      skipped_imported: outcomes.filter((o) => o.status === 'skipped_imported').length,
      review: outcomes.filter((o) => o.status === 'review').length,
      rejected: outcomes.filter((o) => o.status === 'rejected').length,
    }

    const runDir = path.join(workspace, 'runs', runId)
    await mkdir(runDir, { recursive: true })

    if (args.mode === 'apply') {
      await pool.query(`BEGIN`)
      try {
        await pool.query(
          `INSERT INTO delivery_import_run (run_id, template, layer, kind, file_name, file_sha256,
             total_rows, started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
          [runId, def.name, def.layer, def.kind, path.basename(args.file), fileSha, counts.total])
        for (const o of outcomes) {
          await pool.query(
            `INSERT INTO delivery_import_row (run_id, line_no, natural_key, status, reason_code, reason, raw_snapshot)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [runId, o.lineNo, o.naturalKey, o.status, o.reasonCode ?? null, o.reason ?? null, o.raw])
        }
        for (const o of outcomes.filter((x) => x.status === 'success')) {
          await insertStagingRow(pool, def, o, runId)
        }
        await pool.query(
          `UPDATE delivery_import_run SET success_rows=$2, skipped_exists_rows=$3, skipped_imported_rows=$4,
             review_rows=$5, rejected_rows=$6, finished_at=now() WHERE run_id=$1`,
          [runId, counts.success, counts.skipped_exists, counts.skipped_imported, counts.review, counts.rejected])
        await pool.query(
          `UPDATE delivery_layer_check SET state='imported' WHERE layer=$1 AND state='pending'`, [def.layer])
        await pool.query(`COMMIT`)
      } catch (error) {
        await pool.query(`ROLLBACK`)
        throw error
      }
      // DO-S2 拒绝清单落哈希链账本（不可删改；运行表登记账本头锚——尾部截断亦能检出）
      const verify = await verifyLedger(rejectionLedger)
      if (!verify.ok) {
        console.error(`[DO-S2] 拒绝清单账本校验失败（${verify.reason}，断点 seq=${String(verify.brokenAtSeq)}），拒绝继续写入`)
        process.exit(1)
      }
      const anchor = await pool.query(
        `SELECT rejection_ledger_count, rejection_ledger_head FROM delivery_import_run
         WHERE rejection_ledger_count IS NOT NULL ORDER BY started_at DESC LIMIT 1`)
      const headBefore = await ledgerHead(rejectionLedger)
      const anchorRow = anchor.rows[0]
      if (anchorRow && headBefore.count < anchorRow.rejection_ledger_count) {
        console.error(`[DO-S2] 拒绝清单账本条数 ${String(headBefore.count)} 少于已登记锚 ${String(anchorRow.rejection_ledger_count)}——账本被尾部截断/删除，拒绝继续`)
        process.exit(1)
      }
      for (const o of outcomes.filter((x) => x.status === 'rejected' || x.status === 'review')) {
        await appendRecord(rejectionLedger, {
          run_id: runId,
          template: def.name,
          line_no: o.lineNo,
          outcome: o.status,
          reason_code: o.reasonCode ?? '',
          reason: o.reason ?? '',
          raw_snapshot: o.raw,
        })
      }
      const headAfter = await ledgerHead(rejectionLedger)
      await pool.query(
        `UPDATE delivery_import_run SET rejection_ledger_count=$2, rejection_ledger_head=$3 WHERE run_id=$1`,
        [runId, headAfter.count, headAfter.headHash])
    }

    const rejected = outcomes.filter((o) => o.status === 'rejected')
    const review = outcomes.filter((o) => o.status === 'review')
    const rejectionCsv = stringifyCsv(
      ['行号', '结果', '规则码', '拒绝原因', '原文快照'],
      [...rejected, ...review].map((o) => [
        String(o.lineNo),
        o.status === 'rejected' ? '拒绝' : '待业务确认',
        o.reasonCode ?? '',
        o.reason ?? '',
        o.raw,
      ]))
    await writeFile(path.join(runDir, 'rejection-list.csv'), rejectionCsv, 'utf8')
    const report = [
      `# 导入运行报告 ${runId}`,
      '',
      `- 模板：${def.name}（${def.kind === 'initial' ? '期初' : '增量'}·第 ${String(def.layer)} 层·${LAYER_NAMES[def.layer] ?? ''}）`,
      `- 文件：${args.file}（sha256=${fileSha.slice(0, 16)}…）`,
      `- 时间：${nowIso()}`,
      `- 模式：${args.mode === 'apply' ? '导入（已写运行表与暂存）' : '预检（不写库）'}`,
      '',
      '| 总行数 | 成功 | 已存在不覆盖 | 历史已导跳过 | 待业务确认 | 拒绝 |',
      '| --- | --- | --- | --- | --- | --- |',
      `| ${String(counts.total)} | ${String(counts.success)} | ${String(counts.skipped_exists)} | ${String(counts.skipped_imported)} | ${String(counts.review)} | ${String(counts.rejected)} |`,
      '',
      rejected.length > 0 ? '## 拒绝清单（见 rejection-list.csv；坏行未导入、未静默修补，修正后重导，已成功行不会重复导入）' : '## 无拒绝行',
      review.length > 0 ? '## 具名核对清单（DO-09：历史空值交业务确认，不默认有利语义）' : '## 无待确认行',
    ]
    await writeFile(path.join(runDir, 'validation-report.md'), report.join('\n'), 'utf8')

    console.log(`[${args.mode === 'apply' ? '导入' : '预检'}完成] run_id=${runId}`)
    console.log(
      `  总 ${String(counts.total)} / 成功 ${String(counts.success)} / 已存在不覆盖 ${String(counts.skipped_exists)} / 历史已导跳过 ${String(counts.skipped_imported)} / 待确认 ${String(counts.review)} / 拒绝 ${String(counts.rejected)}`)
    console.log(`  报告：${path.join(runDir, 'validation-report.md')}；拒绝清单：${path.join(runDir, 'rejection-list.csv')}`)
    if (args.mode === 'apply') {
      console.log(`  下一步：业务按报告核对 → --confirm-layer ${String(def.layer)} --confirmer <姓名> 解锁下一层（DO-10）`)
    }
    if (counts.rejected > 0 || counts.review > 0) process.exitCode = 1
  })
}

main().catch((error) => {
  console.error('期初导入工具失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
