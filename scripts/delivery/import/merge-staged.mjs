#!/usr/bin/env node
/**
 * 期初导入合并通道（R1：暂存 → 业务事实，PM 最终接收单 final-reception-20261029 §3-R1）。
 *
 * 把 delivery_stg_*（第 2/3/4 层）暂存行经**产品命令面**（application 层命令总线组合根，
 * apps/api/dist 各域 composition.js）落成业务事实——不走 SQL 直插业务表，不绕过领域不变式。
 * 模式照主数据既有通道（import-validate.mjs --merge-master-data）：分层门禁 + 确认命令 +
 * 行级 trace 报告；本工具补齐第 2/3/4 层：
 *
 * - --merge-inventory  第 2 层 delivery_stg_inventory：
 *     · kind=initial：inventory.receive-goods（新批次/新库存单元/余额/receive 流水，
 *       businessTime=冻结点设置时刻；期初落账发生在冻结窗口内，DO-11/DO-30）；
 *     · kind=incremental（增量抽取，DO-12）：正变动 → inventory.receive-goods
 *       （businessTime=发生日期，来源单据号进 reason 追溯）；负变动 → inventory.issue-material
 *       （按 工厂+批次+库位+货主+质量状态 解析唯一在库单元扣减；无唯一单元 → 具名待确认，
 *       不静默选单元）。
 * - --merge-open-orders 第 3 层 delivery_stg_open_order：
 *     · purchase_open → purchase.order-sync（IF-08 五元组幂等，行状态 1=已核准未结）；
 *     · process_wip   → process.order.receive（initialStatus=released 模拟上游已放行，
 *       生产部门=工厂下唯一 dept_category=1 部门，多义/缺失 → 具名待确认）；
 *     · sales_open    → 当前 FINAL 无销售订单命令面 → 具名待确认（不 SQL 直插、不冒充）。
 * - --merge-history   第 4 层 delivery_stg_historical_doc：期初库存已含冻结点余额（DO-12），
 *     重放历史收发将双计当前库存，且当前命令面无"只读留档"入口——全部行进具名核对清单
 *     交业务确认处置（DO-09/K21：历史空值不冒充现值，empty_markers 随行透传），不投递记账命令。
 *
 * 门禁与幂等：
 * - 分层门禁（DO-10 延伸到合并）：合并第 N 层须 delivery_layer_check[N]='verified'
 *   （已导入且业务核对通过）；--merge-inventory 另须存在 active 冻结点（DO-11/DO-30：
 *   冻结点→期初核对→落账/增量补齐→开账）。
 * - operationId 幂等：每暂存行派生确定性 operationId（dimp/<通道>/<自然键哈串>[/尝试号]）；
 *   已落账行置 merged_at 后跳过（重跑不再投递）；命令总线同键同载荷返回原结果
 *   （enterprise+commandType+operationId，SYSTEM_ARCHITECTURE §4.1）；业务拒绝后的重试以
 *   尝试号 +1 派生新 operationId（原拒绝未产生业务事实，重试不多记）。
 * - 行级 trace：stg 行 → operationId/命令回执 → 业务事实 id（unitId/orderId/…）或
 *   具名拒绝/待确认，逐行落 delivery_merge_row 与 workspace 报告，可从导入行追到业务事实。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { stringifyCsv } from '../lib/csv.mjs'
import { withPool } from '../lib/db.mjs'
import { nowIso, sha256Text } from '../lib/util.mjs'

const require = createRequire(import.meta.url)

/** 产品命令面组合根（apps/api 构建产物；只读复用，不改产品代码）。 */
function loadCommandBuses(pool) {
  const dist = (rel) => require(`../../../apps/api/dist/${rel}`)
  return {
    inventory: dist('inventory/inventory.composition.js').buildInventoryCommandBus(pool),
    purchase: dist('purchase/purchase.composition.js').buildPurchaseCommandBus(pool),
    process: dist('process/process.composition.js').buildProcessCommandBus(pool),
  }
}

const CHANNELS = {
  'merge-inventory': { channel: 'inventory', layer: 2, table: 'delivery_stg_inventory', needFreeze: true },
  'merge-open-orders': { channel: 'open_orders', layer: 3, table: 'delivery_stg_open_order', needFreeze: false },
  'merge-history': { channel: 'history', layer: 4, table: 'delivery_stg_historical_doc', needFreeze: false },
}

const LAYER_NAMES = { 1: '主数据补齐', 2: '期初库存', 3: '未结订单/在制', 4: '历史单据' }

const MERGE_DDL = [
  `CREATE TABLE IF NOT EXISTS delivery_merge_run (
    merge_run_id text PRIMARY KEY,
    channel text NOT NULL CHECK (channel IN ('inventory','open_orders','history')),
    layer smallint NOT NULL,
    actor text NOT NULL,
    total_rows integer NOT NULL DEFAULT 0,
    posted_rows integer NOT NULL DEFAULT 0,
    pending_rows integer NOT NULL DEFAULT 0,
    rejected_rows integer NOT NULL DEFAULT 0,
    staged_total integer,
    staged_merged integer,
    report_path text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS delivery_merge_row (
    merge_run_id text NOT NULL REFERENCES delivery_merge_run(merge_run_id),
    staging_table text NOT NULL,
    natural_key text NOT NULL,
    import_run_id text NOT NULL,
    line_no integer NOT NULL,
    attempt integer NOT NULL DEFAULT 1,
    operation_id text,
    command_type text,
    status text NOT NULL CHECK (status IN ('posted','pending','rejected')),
    result_status text,
    business_ref jsonb,
    reason_code text,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (merge_run_id, staging_table, natural_key)
  )`,
  `ALTER TABLE delivery_stg_inventory ADD COLUMN IF NOT EXISTS merged_operation_id text`,
  `ALTER TABLE delivery_stg_open_order ADD COLUMN IF NOT EXISTS merged_at timestamptz`,
  `ALTER TABLE delivery_stg_open_order ADD COLUMN IF NOT EXISTS merged_operation_id text`,
  `ALTER TABLE delivery_stg_historical_doc ADD COLUMN IF NOT EXISTS merged_at timestamptz`,
  `ALTER TABLE delivery_stg_historical_doc ADD COLUMN IF NOT EXISTS merged_operation_id text`,
]

async function ensureMergeTables(pool) {
  for (const ddl of MERGE_DDL) await pool.query(ddl)
}

// ============ 参数解析（口径同 import-validate.mjs） ============

const VALUE_FLAGS = new Set(['actor', 'database-url', 'workspace', 'note'])

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
    } else {
      args[key] = ''
    }
  }
  const channelKey = ['merge-inventory', 'merge-open-orders', 'merge-history'].find((k) => args[k] !== undefined)
  if (channelKey === undefined) {
    console.error('用法：merge-staged.mjs --merge-inventory|--merge-open-orders|--merge-history --database-url URL --actor <登录名> [--workspace 目录] [--note 说明]')
    process.exit(2)
  }
  return {
    mode: channelKey,
    databaseUrl: args['database-url'],
    workspace: args.workspace ?? 'delivery-import-workspace',
    actor: args.actor,
    note: args.note ?? null,
  }
}

// ============ 通用上下文 ============

async function resolveActor(pool, loginName) {
  const r = await pool.query(
    `SELECT id, enterprise_id FROM user_account
     WHERE login_name = $1 AND account_status = 'enabled'`, [loginName])
  if (r.rows.length === 0) {
    throw new Error(`合并执行人 ${loginName} 不存在或未启用（--actor 须为启用中的登录名）`)
  }
  return { actorUserId: r.rows[0].id, actorLoginName: loginName, enterpriseId: r.rows[0].enterprise_id, reason: null }
}

async function assertLayerVerified(pool, layer) {
  const r = await pool.query(`SELECT state FROM delivery_layer_check WHERE layer = $1`, [layer])
  if (r.rows[0]?.state !== 'verified') {
    console.error(
      `[DO-10 分层门禁] 第 ${String(layer)} 层（${LAYER_NAMES[layer] ?? ''}）状态=${r.rows[0]?.state ?? '无记录'}，` +
      `未核对通过，拒绝合并（先 --apply 导入并 --confirm-layer ${String(layer)} --confirmer <姓名>）`)
    process.exit(1)
  }
}

async function activeFreeze(pool) {
  const r = await pool.query(
    `SELECT id, set_by, set_at FROM delivery_freeze_point WHERE state = 'active' ORDER BY id DESC LIMIT 1`)
  return r.rows[0] ?? null
}

function operationIdOf(channel, naturalKey, attempt) {
  const tail = attempt > 1 ? `/${attempt}` : ''
  return `dimp/${channel}/${sha256Text(naturalKey).slice(0, 20)}${tail}`
}

/** 业务拒绝后的下一次尝试号（原拒绝未产生业务事实，重试换 operationId 不多记）。 */
async function nextAttempt(pool, stagingTable, naturalKey) {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM delivery_merge_row
     WHERE staging_table = $1 AND natural_key = $2 AND status = 'rejected'`,
    [stagingTable, naturalKey])
  return r.rows[0].n + 1
}

/** 命令派发：返回总线结果（同键同载荷回放原结果，不重复入账）。 */
async function dispatch(bus, ctx, commandType, operationId, payload) {
  return bus.execute({ operationId, commandType, targetId: '', expectedRevision: 0, payload }, ctx)
}

/** 单位编码解析（stg 存 CSV 值，可能为名称如「千克」；按编码或名称匹配已有单位主数据）。 */
function uomCodeResolver(pool) {
  const cache = new Map()
  return async (key) => {
    if (!cache.has(key)) {
      const r = await pool.query(
        `SELECT code FROM uom WHERE status = 'active' AND (code = $1 OR name = $1) LIMIT 1`, [key])
      cache.set(key, r.rows[0]?.code ?? key)
    }
    return cache.get(key)
  }
}

/** date 列规范化 ISO 日期串（pg date → 本地时区 Date，String() 会得到 PG 拒收的本地格式）。 */
function isoDateOf(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

// ============ 通道 1：期初/增量库存（第 2 层） ============

/**
 * 负变动增量解析扣减目标单元：工厂+批次+库位+货主+质量状态 命中唯一在库单元才可扣；
 * 无命中/多命中 → 具名待确认（不静默选单元，IT-04 显式选择精神）。
 */
async function resolveDeltaTargetUnit(pool, row) {
  const r = await pool.query(
    `SELECT iu.id, iu.unit_no
     FROM inventory_unit iu
     JOIN material_lot ml ON ml.id = iu.lot_id
     JOIN stock_balance sb ON sb.unit_id = iu.id AND sb.status = 'active'
     WHERE iu.plant_id = $1 AND ml.lot_no = $2 AND sb.location_id = $3
       AND sb.owner_id = $4 AND sb.quality_status = $5 AND iu.status = 'in_stock'`,
    [row.plant_id, row.lot_no, row.location_id, row.owner_id, row.quality_status])
  if (r.rows.length === 0) {
    return {
      pending: true,
      reasonCode: 'R1-INV-无单元',
      reason: `增量扣减无在库单元可扣（批次 ${row.lot_no}+库位 ${row.location_code}+质量 ${row.quality_status} 无命中），留具名清单交业务确认`,
    }
  }
  if (r.rows.length > 1) {
    return {
      pending: true,
      reasonCode: 'R1-INV-多单元',
      reason: `增量扣减命中 ${String(r.rows.length)} 个在库单元（批次 ${row.lot_no}+库位 ${row.location_code}），须人工指定目标单元，不静默选择`,
    }
  }
  return { pending: false, unitId: r.rows[0].id, unitNo: r.rows[0].unit_no }
}

async function mergeInventory(pool, buses, ctx, cfg, run) {
  const freeze = await activeFreeze(pool)
  if (freeze === null) {
    console.error('[DO-11/DO-30 冻结点] 无 active 冻结点，拒绝合并期初/增量库存（冻结点→期初核对→落账/增量补齐→开账；落账须在冻结窗口内执行）')
    process.exit(1)
  }
  const freezeAt = new Date(freeze.set_at).toISOString()
  const uomCodeOf = uomCodeResolver(pool)
  const rows = (await pool.query(
    `SELECT * FROM ${cfg.table} WHERE merged_at IS NULL ORDER BY import_run_id, line_no`)).rows
  for (const row of rows) {
    const attempt = await nextAttempt(pool, cfg.table, row.natural_key)
    const operationId = operationIdOf('inv', row.natural_key, attempt)
    const refLine = `${row.import_run_id}#L${String(row.line_no)}`
    const isNegativeDelta = row.kind === 'incremental' && String(row.quantity).trim().startsWith('-')
    if (isNegativeDelta) {
      const target = await resolveDeltaTargetUnit(pool, row)
      if (target.pending) {
        run.outcomes.push({ row, attempt, operationId, commandType: null, status: 'pending', reasonCode: target.reasonCode, reason: target.reason })
        continue
      }
      const result = await dispatch(buses.inventory, ctx, 'inventory.issue-material', operationId, {
        unitId: target.unitId,
        quantity: String(row.quantity).replace('-', ''),
        locationId: row.location_id,
        ownerId: row.owner_id,
        reason: `期初导入增量抽取扣减（来源单据 ${row.source_doc_no ?? ''}；stg ${refLine}）`,
        refType: 'delivery_import_delta',
        businessTime: `${isoDateOf(row.occurred_on)}T00:00:00.000Z`,
      })
      if (result.status === 'COMMITTED') {
        run.outcomes.push({
          row, attempt, operationId, commandType: 'inventory.issue-material', status: 'posted', result,
          ref: { unitId: target.unitId, unitNo: target.unitNo, transactionId: result.data?.transactionId, beforeQty: result.data?.beforeQty, afterQty: result.data?.afterQty },
        })
        await pool.query(`UPDATE ${cfg.table} SET merged_at = now(), merged_operation_id = $2 WHERE natural_key = $1`, [row.natural_key, operationId])
      } else {
        run.outcomes.push({ row, attempt, operationId, commandType: 'inventory.issue-material', status: 'rejected', result })
      }
      continue
    }
    const isDelta = row.kind === 'incremental'
    const result = await dispatch(buses.inventory, ctx, 'inventory.receive-goods', operationId, {
      plantId: row.plant_id,
      materialId: row.material_id,
      materialCode: row.material_code,
      lotNo: row.lot_no,
      quantity: String(row.quantity).replace('-', ''),
      uomId: row.uom_id,
      uomCode: await uomCodeOf(row.uom_code),
      locationId: row.location_id,
      locationCode: row.location_code,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      qualityStatus: row.quality_status,
      supplierLotNo: row.supplier_lot_no ?? undefined,
      unitNo: `IMPU-${sha256Text(`${row.plant_id}|${row.natural_key}`).slice(0, 12)}`,
      reason: isDelta
        ? `期初导入增量抽取收货（来源单据 ${row.source_doc_no ?? ''}；stg ${refLine}）`
        : `期初库存导入（冻结点 #${String(freeze.id)} 设置人 ${freeze.set_by}；stg ${refLine}）`,
      refType: isDelta ? 'delivery_import_delta' : 'delivery_import',
      businessTime: isDelta ? `${isoDateOf(row.occurred_on)}T00:00:00.000Z` : freezeAt,
    })
    if (result.status === 'COMMITTED') {
      run.outcomes.push({
        row, attempt, operationId, commandType: 'inventory.receive-goods', status: 'posted', result,
        ref: { unitId: result.data?.unitId, unitNo: result.data?.unitNo, lotId: result.data?.lotId, balanceId: result.data?.balanceId, transactionId: result.data?.transactionId, afterQty: result.data?.afterQty },
      })
      await pool.query(`UPDATE ${cfg.table} SET merged_at = now(), merged_operation_id = $2 WHERE natural_key = $1`, [row.natural_key, operationId])
    } else {
      run.outcomes.push({ row, attempt, operationId, commandType: 'inventory.receive-goods', status: 'rejected', result })
    }
  }
}

// ============ 通道 2：未结订单/在制（第 3 层） ============

/** 工厂下唯一生产部门（dept_category=1）解析；多义/缺失 → 具名待确认。 */
async function resolveProductionDept(pool, plantId) {
  const r = await pool.query(
    `SELECT id, name FROM org_node
     WHERE parent_id = $1 AND kind = 'department' AND status = 'active' AND dept_category = 1`,
    [plantId])
  if (r.rows.length === 0) {
    return { pending: true, reasonCode: 'R1-ORD-无生产部门', reason: `工厂下无 dept_category=1 生产部门，process.order.receive 无法确定 productionDeptId，留具名清单交业务确认` }
  }
  if (r.rows.length > 1) {
    return { pending: true, reasonCode: 'R1-ORD-多生产部门', reason: `工厂下有 ${String(r.rows.length)} 个生产部门，须人工指定 productionDeptId，不静默选择` }
  }
  return { pending: false, deptId: r.rows[0].id, deptName: r.rows[0].name }
}

async function mergeOpenOrders(pool, buses, ctx, cfg, run) {
  const uomCodeOf = uomCodeResolver(pool)
  const plantCodeCache = new Map()
  const plantCodeOf = async (plantId) => {
    if (!plantCodeCache.has(plantId)) {
      const r = await pool.query(`SELECT code FROM org_node WHERE id = $1`, [plantId])
      plantCodeCache.set(plantId, r.rows[0]?.code ?? plantId)
    }
    return plantCodeCache.get(plantId)
  }
  const rows = (await pool.query(
    `SELECT * FROM ${cfg.table} WHERE merged_at IS NULL ORDER BY import_run_id, line_no`)).rows
  for (const row of rows) {
    const attempt = await nextAttempt(pool, cfg.table, row.natural_key)
    const operationId = operationIdOf('ord', row.natural_key, attempt)
    const refLine = `${row.import_run_id}#L${String(row.line_no)}`
    if (row.doc_type === 'purchase_open') {
      const result = await dispatch(buses.purchase, ctx, 'purchase.order-sync', operationId, {
        orgCode: await plantCodeOf(row.plant_id),
        orderNo: row.doc_no,
        plantId: row.plant_id,
        sourceSystem: 'DELIVERY-INIT',
        externalRevision: 1,
        lines: [{
          lineNo: 1,
          materialId: row.material_id,
          materialCode: row.material_code,
          uomCode: await uomCodeOf(row.uom_code),
          plannedQty: String(row.quantity),
          overReceiptLimit: String(row.quantity),
          plannedReceiptDate: isoDateOf(row.due_date),
          status: 1,
        }],
      })
      if (result.status === 'COMMITTED') {
        run.outcomes.push({
          row, attempt, operationId, commandType: 'purchase.order-sync', status: 'posted', result,
          ref: { orderId: result.data?.orderId, orderNo: row.doc_no, lineIds: (result.data?.lines ?? []).map((l) => l.lineId) },
        })
        await pool.query(`UPDATE ${cfg.table} SET merged_at = now(), merged_operation_id = $2 WHERE natural_key = $1`, [row.natural_key, operationId])
      } else {
        run.outcomes.push({ row, attempt, operationId, commandType: 'purchase.order-sync', status: 'rejected', result })
      }
      continue
    }
    if (row.doc_type === 'process_wip') {
      const dept = await resolveProductionDept(pool, row.plant_id)
      if (dept.pending) {
        run.outcomes.push({ row, attempt, operationId, commandType: null, status: 'pending', reasonCode: dept.reasonCode, reason: `${dept.reason}（单据 ${row.doc_no}）` })
        continue
      }
      const result = await dispatch(buses.process, ctx, 'process.order.receive', operationId, {
        orderNo: row.doc_no,
        materialId: row.material_id,
        productionDeptId: dept.deptId,
        productionQty: String(row.quantity),
        uom: await uomCodeOf(row.uom_code),
        initialStatus: 'released',
        plannedFinishAt: isoDateOf(row.due_date),
        orderType: 'wip_initial',
        remark: row.status_note ?? row.note ?? `期初在制导入（stg ${refLine}）`,
      })
      if (result.status === 'COMMITTED') {
        run.outcomes.push({
          row, attempt, operationId, commandType: 'process.order.receive', status: 'posted', result,
          ref: { orderId: result.data?.orderId, orderNo: row.doc_no, orderStatus: result.data?.orderStatus, productionDept: dept.deptName },
        })
        await pool.query(`UPDATE ${cfg.table} SET merged_at = now(), merged_operation_id = $2 WHERE natural_key = $1`, [row.natural_key, operationId])
      } else {
        run.outcomes.push({ row, attempt, operationId, commandType: 'process.order.receive', status: 'rejected', result })
      }
      continue
    }
    // sales_open：当前 FINAL 无销售订单命令面（无实体表/无创建命令）——具名待确认，不 SQL 直插、不冒充落账
    run.outcomes.push({
      row, attempt, operationId, commandType: null, status: 'pending',
      reasonCode: 'R1-ORD-无命令面',
      reason: `单据类型 sales_open（${row.doc_no}）：当前 FINAL 产品命令面无销售订单创建/同步命令，无适用业务落账面；行留具名清单交业务确认（不得以暂存成功冒充业务导入成功）`,
    })
  }
}

// ============ 通道 3：历史单据（第 4 层） ============

async function mergeHistory(pool, cfg, run) {
  const rows = (await pool.query(
    `SELECT * FROM ${cfg.table} WHERE merged_at IS NULL ORDER BY import_run_id, line_no`)).rows
  for (const row of rows) {
    // 不投递记账命令：期初库存（第 2 层）已含冻结点余额（DO-12 期初=冻结点前全量），
    // 在其上重放历史收发将双计当前库存；当前命令面无"历史留档不落账"入口。
    // 全部行进具名核对清单交业务确认处置（DO-09/K21；空值标记随行透传，不冒充现值）。
    const markers = row.empty_markers ?? {}
    const markerNote = Object.keys(markers).length > 0
      ? `；来源空值标记 ${JSON.stringify(markers)}（EMPTY_FROM_SOURCE，不冒充现值）`
      : ''
    const reason = row.audit_status === 'void'
      ? `历史单据 ${row.doc_no}（${row.doc_type}）审核状态=void（作废）：不落账，留具名清单交业务确认${markerNote}`
      : `历史单据 ${row.doc_no}（${row.doc_type}，业务日期 ${isoDateOf(row.business_date)}）：期初库存已含冻结点余额，经库存命令面重放历史收发将双计当前库存；当前无"只读留档"命令面，行留具名清单交业务确认处置${markerNote}`
    run.outcomes.push({
      row,
      attempt: 1,
      operationId: null,
      commandType: null,
      status: 'pending',
      reasonCode: row.audit_status === 'void' ? 'R1-HIST-作废' : 'R1-HIST-无落账面',
      reason,
    })
  }
}

// ============ 主流程 ============

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.databaseUrl) {
    console.error('[DO-安全] 该模式必须显式提供 --database-url（防止误连 dev 主库 cadenza）')
    process.exit(2)
  }
  if (!args.actor) {
    console.error('参数错误：须 --actor <启用中的登录名>（合并落账执行人，进命令上下文与审计）')
    process.exit(2)
  }
  const cfg = CHANNELS[args.mode]

  await withPool(args.databaseUrl, async (pool) => {
    await ensureMergeTables(pool)
    await assertLayerVerified(pool, cfg.layer)

    const ctx = await resolveActor(pool, args.actor)
    const buses = loadCommandBuses(pool)
    const run = { outcomes: [] }
    if (cfg.channel === 'inventory') await mergeInventory(pool, buses, ctx, cfg, run)
    else if (cfg.channel === 'open_orders') await mergeOpenOrders(pool, buses, ctx, cfg, run)
    else await mergeHistory(pool, cfg, run)

    const counts = {
      total: run.outcomes.length,
      posted: run.outcomes.filter((o) => o.status === 'posted').length,
      pending: run.outcomes.filter((o) => o.status === 'pending').length,
      rejected: run.outcomes.filter((o) => o.status === 'rejected').length,
    }
    const staged = await pool.query(
      `SELECT count(*)::int AS total, count(merged_at)::int AS merged FROM ${cfg.table}`)
    const mergeRunId = `merge-${nowIso().replace(/[:.]/g, '-')}-${cfg.channel}`
    const runDir = path.join(args.workspace, 'merges', mergeRunId)
    await mkdir(runDir, { recursive: true })
    const reportPath = path.join(runDir, 'merge-report.md')

    await pool.query(`BEGIN`)
    try {
      await pool.query(
        `INSERT INTO delivery_merge_run (merge_run_id, channel, layer, actor, total_rows, posted_rows,
           pending_rows, rejected_rows, staged_total, staged_merged, report_path)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [mergeRunId, cfg.channel, cfg.layer, args.actor, counts.total, counts.posted,
          counts.pending, counts.rejected, staged.rows[0].total, staged.rows[0].merged, reportPath])
      for (const o of run.outcomes) {
        await pool.query(
          `INSERT INTO delivery_merge_row (merge_run_id, staging_table, natural_key, import_run_id, line_no,
             attempt, operation_id, command_type, status, result_status, business_ref, reason_code, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [mergeRunId, cfg.table, o.row.natural_key, o.row.import_run_id, o.row.line_no, o.attempt,
            o.operationId, o.commandType, o.status, o.result?.status ?? null,
            o.ref ? JSON.stringify(o.ref) : null, o.reasonCode ?? null, o.reason ?? o.result?.errorMessage ?? null])
      }
      await pool.query(`UPDATE delivery_merge_run SET finished_at = now() WHERE merge_run_id = $1`, [mergeRunId])
      await pool.query(`COMMIT`)
    } catch (error) {
      await pool.query(`ROLLBACK`)
      throw error
    }

    const traceCsv = stringifyCsv(
      ['自然键', 'stg 行（run#行号）', '尝试', 'operationId', '命令', '结果', '业务事实引用', '规则码', '说明'],
      run.outcomes.map((o) => [
        o.row.natural_key,
        `${o.row.import_run_id}#L${String(o.row.line_no)}`,
        String(o.attempt),
        o.operationId ?? '',
        o.commandType ?? '',
        o.status === 'posted' ? `posted（${String(o.result.status)}）` : o.status,
        o.ref ? JSON.stringify(o.ref) : '',
        o.reasonCode ?? '',
        o.reason ?? o.result?.errorMessage ?? '',
      ]))
    await writeFile(path.join(runDir, 'trace.csv'), traceCsv, 'utf8')

    const lines = [
      `# 合并运行报告 ${mergeRunId}（${cfg.channel}）`,
      '',
      `- 层：第 ${String(cfg.layer)} 层（${LAYER_NAMES[cfg.layer] ?? ''}）；暂存表 ${cfg.table}`,
      `- 执行人：${args.actor}；时间：${nowIso()}`,
      args.note ? `- 说明：${args.note}` : '',
      '',
      '| 本次待合并 | 落账 posted | 待业务确认 | 业务拒绝 | 暂存累计 | 已落账累计 |',
      '| --- | --- | --- | --- | --- | --- |',
      `| ${String(counts.total)} | ${String(counts.posted)} | ${String(counts.pending)} | ${String(counts.rejected)} | ${String(staged.rows[0].total)} | ${String(staged.rows[0].merged)} |`,
      '',
      '## 行级 trace（stg 行 → 命令回执/operationId → 业务事实或具名待确认/拒绝）',
      '',
      '见 trace.csv；业务事实引用为命令返回的表行 id（库存单元/流水/采购订单/生产订单）。',
      '',
      '## 语义边界（如实呈现，不以暂存成功冒充业务导入成功）',
      '- sales_open 与历史单据行进入具名待确认清单（当前无适用命令面/重放将双计），处置待业务确认。',
      '- 增量扣减与生产部门解析遵循唯一命中才执行，多义/缺失留具名清单，不静默选择。',
      '- 重跑幂等：已落账行置 merged_at 跳过（本次待合并=0）；命令总线按 (enterprise, commandType, operationId) 同键同载荷回放原结果，不重复入账。',
    ].filter((l) => l !== '')
    await writeFile(reportPath, lines.join('\n'), 'utf8')

    console.log(`[合并完成] ${args.mode} merge_run_id=${mergeRunId}`)
    console.log(
      `  本次待合并 ${String(counts.total)} / 落账 ${String(counts.posted)} / 待确认 ${String(counts.pending)} / 拒绝 ${String(counts.rejected)}；暂存累计 ${String(staged.rows[0].total)} / 已落账累计 ${String(staged.rows[0].merged)}`)
    console.log(`  报告：${reportPath}；行级 trace：${path.join(runDir, 'trace.csv')}`)
    if (counts.rejected > 0) process.exitCode = 1
  })
}

main().catch((error) => {
  console.error('合并通道失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
